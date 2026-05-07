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
      scheduled_iso, timezone,
    } = req.body || {}

    if (!profile_id || !upload_post_user || !Array.isArray(platforms) || !platforms.length) {
      return res.status(400).json({ error: 'profile_id, upload_post_user, platforms required' })
    }
    const isVideo = !!video_url
    const photos = Array.isArray(photo_urls) ? photo_urls.filter(Boolean) : []
    if (!isVideo && !photos.length) {
      return res.status(400).json({ error: 'video_url or photo_urls required' })
    }
    await assertProfileAccess(auth.user.id, profile_id)

    const apiKey = process.env.UPLOADPOST_API_KEY
    if (!apiKey) return res.status(500).json({ error: 'UPLOADPOST_API_KEY not configured' })

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
    fd.append('user', upload_post_user)
    for (const p of platforms) fd.append('platform[]', p)
    if (description) fd.append('description', String(description).slice(0, 2200))
    if (platforms.includes('tiktok') && title) {
      fd.append('tiktok_title', String(title).slice(0, 90))
    }
    if (scheduled_iso) {
      fd.append('scheduled_date', scheduled_iso)
      if (timezone) fd.append('timezone', timezone)
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
            p_metadata: { platforms, scheduled_iso: scheduled_iso || null, kind: isVideo ? 'video' : 'photos', count: isVideo ? 1 : photos.length },
          },
        })
      } catch {}
    }

    return res.status(200).json({
      request_id: body?.request_id || body?.id || null,
      submitted: true,
      raw: body,
    })
  } catch (err) {
    console.error('upload-post error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
