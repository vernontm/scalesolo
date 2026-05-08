// POST /api/social/upload-post
// Body: {
//   profile_id, upload_post_user, platforms: ['tiktok', ...],
//   video_url? | photo_urls?,
//   description?, title?,
//   scheduled_iso?, timezone?,
// }
// Returns: { request_id, raw }
//
// Thin proxy to https://api.upload-post.com/api with the service-side
// API key. The Upload-Post account (= the per-user token they configure
// inside the Upload-Post dashboard) is identified by `upload_post_user`,
// which lets one ScaleSolo account post to many social handles.
//
// We download the video / photos here and forward as multipart/form-data
// because Upload-Post wants the bytes, not a URL.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { resolveUploadpostUser, uploadpostEnsureUserProfile } from '../_lib/uploadpost.js'
import { findNextOpenSlot } from '../_lib/scheduling.js'
import { NotifyKind } from '../_lib/notify.js'

export const config = { maxDuration: 60 }

async function fetchToBlob(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Fetch ${url} → ${r.status}`)
  const ab = await r.arrayBuffer()
  return new Blob([ab])
}

function ext(url, fallback) {
  try { return (new URL(url).pathname.split('.').pop() || fallback).toLowerCase() }
  catch { return fallback }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  // GET /api/social/upload-post?action=status&request_id=...
  if (req.method === 'GET') {
    const apiKey = process.env.UPLOADPOST_API_KEY
    if (!apiKey) return res.status(500).json({ error: 'UPLOADPOST_API_KEY not configured' })
    const requestId = req.query.request_id
    if (!requestId) return res.status(400).json({ error: 'request_id required' })
    const r = await fetch(`https://api.upload-post.com/api/uploadposts/status?request_id=${encodeURIComponent(requestId)}`, {
      headers: { Authorization: `Apikey ${apiKey}` },
    })
    const body = await r.json().catch(() => ({}))
    return res.status(r.ok ? 200 : 502).json(body)
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const {
      profile_id, upload_post_user, platforms,
      video_url, photo_urls,
      description, title,
      scheduling_mode,        // 'now' | 'fixed' | 'auto'
      scheduled_iso, timezone,
    } = req.body || {}

    if (!profile_id || !Array.isArray(platforms) || !platforms.length) {
      return res.status(400).json({ error: 'profile_id, platforms required' })
    }
    const isVideo = !!video_url
    const photos = Array.isArray(photo_urls) ? photo_urls.filter(Boolean) : []
    if (!isVideo && !photos.length) {
      return res.status(400).json({ error: 'video_url or photo_urls required' })
    }
    await assertProfileAccess(auth.user.id, profile_id)

    const apiKey = process.env.UPLOADPOST_API_KEY
    if (!apiKey) return res.status(500).json({ error: 'UPLOADPOST_API_KEY not configured' })

    // Derive a stable per-profile sub-account username, auto-creating the
    // Upload-Post profile if it doesn't exist yet. Caller can still pass an
    // explicit upload_post_user to override (useful for shared accounts).
    const effectiveUser = upload_post_user || await resolveUploadpostUser(profile_id)
    if (!upload_post_user) {
      try { await uploadpostEnsureUserProfile(effectiveUser) } catch (e) {
        console.warn('upload-post ensure profile failed:', e.message)
      }
    }

    // Pre-flight credit check (cheap fee — Upload-Post itself is paid for
    // outside the app on their side, this is just a transaction marker).
    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
    const customerId = cust?.[0]?.id
    const fee = 100
    if (customerId) {
      const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`)
      if ((Number(pools?.[0]?.balance ?? 0)) < fee) {
        return res.status(402).json({ error: 'Insufficient AI tokens.', code: 'insufficient_credits' })
      }
    }

    // Build the multipart payload Upload-Post expects.
    const fd = new FormData()
    fd.append('user', effectiveUser)
    for (const p of platforms) fd.append('platform[]', p)
    if (description) fd.append('description', String(description).slice(0, 2200))
    if (title) {
      // Generic title for any platform that uses it (Upload-Post passes
      // it through to YouTube where it's REQUIRED). 100-char ceiling to
      // keep it short across platforms.
      fd.append('title', String(title).slice(0, 100))
      if (platforms.includes('tiktok')) fd.append('tiktok_title', String(title).slice(0, 90))
      if (platforms.includes('youtube')) fd.append('youtube_title', String(title).slice(0, 100))
    }
    // Resolve "auto" mode: pull the brand profile's posting schedule + the
    // already-scheduled posts on it, find the next open slot. Done at submit
    // time (not at queue time) so the slot reflects what's actually free
    // when the run finishes.
    let resolvedScheduledIso = scheduled_iso || null
    let resolvedTimezone = timezone || null
    if (scheduling_mode === 'auto' && !resolvedScheduledIso) {
      const rows = await supaFetch(`profiles?id=eq.${profile_id}&select=timezone,posting_schedule`)
      const profile = rows?.[0]
      if (profile) {
        const taken = await supaFetch(
          `content_scripts?profile_id=eq.${profile_id}&status=eq.scheduled&select=scheduled_datetime`
        ).catch(() => [])
        const takenIso = (taken || []).map((r) => r.scheduled_datetime).filter(Boolean)
        const slot = findNextOpenSlot(profile, takenIso)
        if (slot) {
          resolvedScheduledIso = slot
          resolvedTimezone = resolvedTimezone || profile.timezone
        }
      }
    }

    if (resolvedScheduledIso) {
      fd.append('scheduled_date', resolvedScheduledIso)
      if (resolvedTimezone) fd.append('timezone', resolvedTimezone)
    }

    if (isVideo) {
      const blob = await fetchToBlob(video_url)
      fd.append('video', blob, `video.${ext(video_url, 'mp4')}`)
    } else {
      for (let i = 0; i < photos.length; i++) {
        const blob = await fetchToBlob(photos[i])
        fd.append('photos[]', blob, `photo-${i}.${ext(photos[i], 'jpg')}`)
      }
    }

    const endpoint = `https://api.upload-post.com/api/${isVideo ? 'upload' : 'upload_photos'}`
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Apikey ${apiKey}` },
      body: fd,
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) {
      return res.status(502).json({ error: body?.error || body?.message || `Upload-Post error (${r.status})`, raw: body })
    }

    if (customerId) {
      try {
        await supaFetch('rpc/consume_credits', {
          method: 'POST',
          body: {
            p_customer_id: customerId, p_pool_type: 'ai_tokens', p_amount: fee,
            p_action: 'consume:upload-post', p_profile_id: profile_id,
            p_metadata: { platforms, scheduled_iso: resolvedScheduledIso || null, kind: isVideo ? 'video' : 'photos', count: isVideo ? 1 : photos.length },
          },
        })
      } catch {}
    }

    // Persist as a content_scripts row so the post appears on the
    // Schedule page's Calendar view alongside library-scheduled
    // content. status='posted' for instant publishes, 'scheduled' for
    // future ISOs.
    //
    // Dedup window: if a row with the same media_url + profile_id was
    // created in the last 5 minutes, UPDATE that row in place instead
    // of inserting a new one. Prevents two near-simultaneous workflow
    // runs (auto-tick races, double-clicks, retries) from producing
    // duplicate rows in the queue. 5 min is wider than any realistic
    // workflow but tighter than a posting cadence, so legitimate
    // re-renders of the same content separated by hours still create
    // their own rows.
    let savedItem = null
    try {
      const isFuture = !!resolvedScheduledIso && new Date(resolvedScheduledIso).getTime() > Date.now() + 30_000
      const status = isFuture ? 'scheduled' : 'posted'
      const mediaUrls = isVideo ? [video_url] : photos
      const mediaType = isVideo ? 'video' : 'image'
      const postType = isVideo ? 'video' : 'post'
      const titleStr = (title || '').trim() || (description || '').slice(0, 60).trim() || 'Scheduled post'
      const primaryMediaUrl = mediaUrls?.[0]
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString()

      let existing = null
      if (primaryMediaUrl) {
        const matches = await supaFetch(
          `content_scripts?profile_id=eq.${profile_id}` +
          `&media_urls=cs.{${encodeURIComponent('"' + primaryMediaUrl + '"')}}` +
          `&created_at=gte.${encodeURIComponent(fiveMinAgo)}` +
          `&order=created_at.desc&limit=1&select=id,status`
        ).catch(() => [])
        existing = Array.isArray(matches) ? matches[0] : null
      }

      const payload = {
        profile_id,
        title: titleStr,
        full_script: description || null,
        media_urls: mediaUrls,
        media_type: mediaType,
        post_type: postType,
        platforms,
        status,
        scheduled_datetime: resolvedScheduledIso || null,
        generated_by: 'schedule_post',
      }
      if (existing?.id) {
        // Same media inserted moments ago — patch the existing row
        // (e.g. update status from scheduled→posted, or refresh
        // scheduled_datetime). No new queue slot.
        const updated = await supaFetch(`content_scripts?id=eq.${existing.id}`, { method: 'PATCH', body: payload })
        savedItem = Array.isArray(updated) ? updated[0] : updated
      } else {
        const inserted = await supaFetch('content_scripts', { method: 'POST', body: payload })
        savedItem = Array.isArray(inserted) ? inserted[0] : inserted
      }
    } catch (e) {
      console.warn('schedule_post → content_scripts persist failed:', e.message)
    }

    // Best-effort notification — bell pings instantly via Realtime.
    NotifyKind.postPublished({
      user_id: auth.user.id,
      profile_id,
      platforms,
    }).catch(() => {})

    return res.status(200).json({
      request_id: body?.request_id || body?.id || null,
      submitted: true,
      scheduled_iso: resolvedScheduledIso || null,
      content_id: savedItem?.id || null,
      raw: body,
    })
  } catch (err) {
    console.error('upload-post error:', err?.stack || err)
    // Surface the failure as a notification too — without this the user
    // sees a red node and no inbox trail.
    try {
      const auth = await requireUser(req, res)
      if (auth?.user?.id) {
        NotifyKind.postFailed({
          user_id: auth.user.id,
          profile_id: req.body?.profile_id,
          error: String(err?.message || err).slice(0, 280),
        }).catch(() => {})
      }
    } catch {}
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
