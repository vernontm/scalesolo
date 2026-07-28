// Campaign CRUD — the per-client marketing campaign record that drives
// the wizard. The heavy lifting (plan generation) lives in
// api/campaigns/generate-plan.js; this file just manages the campaign
// row and its config (length, posts/day, specials, standouts, content
// mix, holidays). Holiday auto-calc runs here on create/preview so the
// wizard can show the observances in the window before generating.
//
// Routes:
//   GET    ?profile_id=<uuid>            → { campaigns: [...] } (with counts)
//   GET    ?id=<uuid>                    → { campaign, counts }
//   GET    ?action=holidays&start=&days=&region=  → { holidays: [...] }
//   POST   { profile_id, ...config }     → { campaign }
//   PATCH  ?id=<uuid> { ...fields }      → { campaign }
//   DELETE ?id=<uuid>                    → 204   (posts keep, campaign_id nulled)

import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'
import { holidaysInWindow } from './_lib/holidays.js'

const CONTENT_MIX_KEYS = ['carousel', 'image', 'video', 'promo', 'mood', 'text']

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, n))
}

// Whitelist + coerce the mutable config fields shared by POST + PATCH.
function sanitizeConfig(body, { forCreate } = {}) {
  const out = {}
  if (body.name !== undefined) out.name = String(body.name || '').slice(0, 160) || 'Untitled campaign'
  if (body.duration_days !== undefined || forCreate) out.duration_days = clampInt(body.duration_days, 1, 90, 7)
  if (body.posts_per_day !== undefined || forCreate) out.posts_per_day = clampInt(body.posts_per_day, 1, 10, 1)
  if (body.start_date !== undefined) out.start_date = body.start_date ? String(body.start_date).slice(0, 10) : null
  if (body.timezone !== undefined) out.timezone = String(body.timezone || 'America/Chicago').slice(0, 64)
  if (body.region !== undefined) out.region = String(body.region || 'US').slice(0, 8)
  if (body.goal !== undefined) out.goal = body.goal ? String(body.goal).slice(0, 4000) : null
  if (Array.isArray(body.specials)) out.specials = body.specials.slice(0, 30)
  if (Array.isArray(body.standouts)) {
    out.standouts = body.standouts.map((s) => String(s).slice(0, 200)).filter(Boolean).slice(0, 30)
  }
  if (body.content_mix && typeof body.content_mix === 'object') {
    const mix = {}
    for (const k of CONTENT_MIX_KEYS) mix[k] = clampInt(body.content_mix[k], 0, 10, 0)
    out.content_mix = mix
  }
  if (Array.isArray(body.holidays)) out.holidays = body.holidays.slice(0, 60)
  if (body.status !== undefined && ['draft', 'planning', 'ready', 'scheduled', 'complete'].includes(body.status)) {
    out.status = body.status
  }
  return out
}

// Post counts by status for a campaign, so the list/detail can show a
// funnel without the client re-querying content_scripts.
async function countsFor(campaignId) {
  const rows = await supaFetch(
    `content_scripts?campaign_id=eq.${campaignId}&select=status,approval_status`,
  ).catch(() => [])
  const c = { total: 0, pending: 0, approved: 0, scheduled: 0, posted: 0, failed: 0 }
  for (const r of rows || []) {
    c.total += 1
    if (r.approval_status === 'pending') c.pending += 1
    if (r.approval_status === 'approved') c.approved += 1
    if (r.status === 'scheduled') c.scheduled += 1
    if (r.status === 'posted') c.posted += 1
    if (r.status === 'failed') c.failed += 1
  }
  return c
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    // ── Holiday preview (no campaign needed) ────────────────────────
    if (req.method === 'GET' && req.query.action === 'holidays') {
      const start = String(req.query.start || new Date().toISOString().slice(0, 10))
      const days = clampInt(req.query.days, 1, 90, 30)
      const region = String(req.query.region || 'US').slice(0, 8)
      return res.status(200).json({ holidays: holidaysInWindow(start, days, region) })
    }

    // ── GET one ─────────────────────────────────────────────────────
    if (req.method === 'GET' && req.query.id) {
      const id = String(req.query.id)
      const rows = await supaFetch(`campaigns?id=eq.${id}&limit=1`)
      const campaign = rows?.[0]
      if (!campaign) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, campaign.profile_id)
      return res.status(200).json({ campaign, counts: await countsFor(id) })
    }

    // ── GET list for a profile ──────────────────────────────────────
    if (req.method === 'GET') {
      const profileId = String(req.query.profile_id || '').trim()
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)
      const campaigns = await supaFetch(
        `campaigns?profile_id=eq.${profileId}&order=created_at.desc&limit=100`,
      )
      // Attach counts per campaign (bounded list, fine to fan out).
      const withCounts = await Promise.all(
        (campaigns || []).map(async (c) => ({ ...c, counts: await countsFor(c.id) })),
      )
      return res.status(200).json({ campaigns: withCounts })
    }

    // ── CREATE ──────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = req.body || {}
      const profileId = body.profile_id
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)

      const config = sanitizeConfig(body, { forCreate: true })
      // Auto-compute holidays for the window unless the client already
      // curated a list (wizard step lets the user toggle them off).
      if (!config.holidays) {
        const start = config.start_date || new Date().toISOString().slice(0, 10)
        config.holidays = holidaysInWindow(start, config.duration_days, config.region || 'US')
      }
      const inserted = await supaFetch('campaigns', {
        method: 'POST',
        body: { profile_id: profileId, status: 'draft', ...config },
      })
      const campaign = Array.isArray(inserted) ? inserted[0] : inserted
      return res.status(201).json({ campaign })
    }

    // ── UPDATE ──────────────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const id = String(req.query.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`campaigns?id=eq.${id}&select=profile_id&limit=1`)
      const row = rows?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, row.profile_id)

      const patch = { ...sanitizeConfig(req.body || {}), updated_at: new Date().toISOString() }
      const updated = await supaFetch(`campaigns?id=eq.${id}`, { method: 'PATCH', body: patch })
      return res.status(200).json({ campaign: Array.isArray(updated) ? updated[0] : updated })
    }

    // ── DELETE ──────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = String(req.query.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`campaigns?id=eq.${id}&select=profile_id&limit=1`)
      const row = rows?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, row.profile_id)
      // content_scripts.campaign_id is ON DELETE SET NULL, so generated
      // posts survive the campaign deletion (they just lose the tag).
      await supaFetch(`campaigns?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || String(e) })
  }
}
