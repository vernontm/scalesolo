// /api/reference-videos
//
//   POST   { profile_id, source_url, mode? }
//          Resolves the URL (TikTok → MP4 via tikwm), transcribes via
//          ElevenLabs Scribe, persists a reference_videos row.
//          Plan quota gates on user's monthly transcription count.
//
//   GET    ?profile_id=…
//          List recent reference videos for the profile (newest first).
//
//   DELETE ?id=…
//          Remove a row (cascade: also drops its insights via FK).
//
// Mode:
//   'competitor'   — feeds the bible-builder analyze flow.
//   'remix_source' — feeds the content-remix script flow.
//   'reference'    — generic reference, no mode bias.

import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'
import { resolveTikTokUrl, transcribeFromUrl } from './_lib/scribe.js'

// Per-tier monthly transcription quota. Until tier_limits land in
// billing, plan tier comes from billing_subscriptions; default falls
// back to free. Studio + founding currently get a generous cap; we
// can tighten later if abuse shows up.
const MONTHLY_QUOTA = {
  free:           3,
  solo_starter:   10,
  solo_pro:       25,
  solo_studio:    100,
  founding:       1000,
  admin:          10000,
}

function periodKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

async function tierForUser(userId) {
  // Admin override first.
  try {
    const u = await supaFetch(`user_profiles?id=eq.${userId}&select=is_admin`).catch(() => [])
    if (u?.[0]?.is_admin) return 'admin'
  } catch {}
  // Active subscription → tier from price id (handled in billing.js).
  try {
    const cust = await supaFetch(`billing_customers?user_id=eq.${userId}&select=id`).catch(() => [])
    const cid = cust?.[0]?.id
    if (cid) {
      const sub = await supaFetch(
        `billing_subscriptions?customer_id=eq.${cid}&status=in.(active,trialing)&select=tier&limit=1`
      ).catch(() => [])
      if (sub?.[0]?.tier) return sub[0].tier
    }
  } catch {}
  return 'free'
}

async function checkAndIncrementQuota(userId, durationSecs) {
  const tier = await tierForUser(userId)
  const cap = MONTHLY_QUOTA[tier] ?? MONTHLY_QUOTA.free
  const period = periodKey()
  const rows = await supaFetch(
    `transcription_usage?user_id=eq.${userId}&period=eq.${period}&select=count,duration_secs`
  ).catch(() => [])
  const current = rows?.[0]?.count ?? 0
  if (current >= cap) {
    const err = new Error(`Monthly transcription limit reached (${current}/${cap}). Upgrade your plan or wait until next month.`)
    err.status = 402
    err.code = 'transcription_limit'
    throw err
  }
  // Upsert via PostgREST. resolution=merge-duplicates lets the same
  // row tick its counters across the month.
  await supaFetch('transcription_usage', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: {
      user_id: userId,
      period,
      count: current + 1,
      duration_secs: (rows?.[0]?.duration_secs ?? 0) + Math.max(0, Number(durationSecs) || 0),
      updated_at: new Date().toISOString(),
    },
  }).catch(() => {})
  return { tier, cap, used: current + 1 }
}

export const config = { maxDuration: 120 }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const profileId = req.query.profile_id
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)
      const rows = await supaFetch(
        `reference_videos?profile_id=eq.${encodeURIComponent(profileId)}&order=created_at.desc&limit=100&select=*`
      )
      return res.status(200).json({ videos: rows || [] })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`reference_videos?id=eq.${encodeURIComponent(id)}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      await supaFetch(`reference_videos?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const { profile_id, source_url, mode = 'competitor' } = req.body || {}
    if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
    if (!source_url || typeof source_url !== 'string') return res.status(400).json({ error: 'source_url required' })
    if (!/^https?:\/\//i.test(source_url)) return res.status(400).json({ error: 'source_url must be http(s)' })
    await assertProfileAccess(auth.user.id, profile_id)

    // 1. Resolve to a directly-fetchable media URL.
    const resolved = await resolveTikTokUrl(source_url)
    const mediaUrl = resolved.mp4_url
    if (!mediaUrl) return res.status(502).json({ error: 'Could not resolve URL to a media file.' })

    // 2. Insert pending row up front so the user sees progress
    //    immediately even if Scribe is slow.
    const insertRow = {
      profile_id,
      user_id: auth.user.id,
      source_url,
      resolved_media_url: mediaUrl,
      creator_handle: resolved.creator_handle || null,
      thumbnail_url: resolved.thumbnail_url || null,
      duration_secs: resolved.duration_secs || null,
      mode,
      status: 'transcribing',
      meta: { resolver: { handle: resolved.creator_handle, title: resolved.title } },
    }
    const created = await supaFetch('reference_videos', { method: 'POST', body: insertRow })
    const row = Array.isArray(created) ? created[0] : created
    const id = row?.id
    if (!id) return res.status(500).json({ error: 'Failed to create reference_videos row' })

    // 3. Quota gate (after we have the duration so the counter is
    //    accurate). 402 + clear error message lets the UI prompt for
    //    an upgrade.
    try {
      await checkAndIncrementQuota(auth.user.id, resolved.duration_secs)
    } catch (e) {
      await supaFetch(`reference_videos?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { status: 'failed', error: e.message, updated_at: new Date().toISOString() },
        prefer: 'return=minimal',
      })
      return res.status(e.status || 402).json({ error: e.message, code: e.code || 'quota' })
    }

    // 4. Transcribe via Scribe. On failure, mark the row failed and
    //    return the error — user can retry via UI.
    let transcript
    try {
      transcript = await transcribeFromUrl(mediaUrl, { no_verbatim: true, profile_id })
    } catch (e) {
      await supaFetch(`reference_videos?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { status: 'failed', error: e.message, updated_at: new Date().toISOString() },
        prefer: 'return=minimal',
      })
      return res.status(e.status || 502).json({ error: `Transcription failed: ${e.message}` })
    }

    const updated = await supaFetch(`reference_videos?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: {
        status: 'ready',
        transcript: transcript.text || '',
        transcript_lang: transcript.language_code || null,
        duration_secs: transcript.duration_secs || resolved.duration_secs || null,
        updated_at: new Date().toISOString(),
      },
    })
    return res.status(200).json({ video: Array.isArray(updated) ? updated[0] : updated })
  } catch (err) {
    console.error('reference-videos error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
