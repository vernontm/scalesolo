// GET /api/studio/poll-assets?studio_video_id=...
//
// Picks up async jobs that generate-assets dispatched to Kie.ai (B-roll
// images) and HeyGen (avatar lip-sync videos), checks their state, and
// fills in image_url / avatar_video_url + flips segment status to
// 'ready' (or 'error' on failure).
//
// The frontend polls this every ~6 seconds while the parent video is
// in status='rendering'. Realtime publishes the segment UPDATE events,
// so even though this endpoint is what flips statuses, the table UI
// updates without a separate refetch.
//
// When ALL approved non-pure-motion segments are 'ready' (or 'error'),
// the parent video flips to 'rendering' done. The final bake (task #10)
// will pick up from there and flip to 'rendered' when the MP4 lands.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { gateStudio } from './_lib/gate.js'
import { getVideoStatusV3 } from '../_lib/heygen.js'

// Re-host a remote URL into Supabase storage so it stays around after
// the provider's CDN expires the original. Kept lightweight — fetch + upload
// the bytes; the existing per-feature mirrors are heavier than we need here.
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const STUDIO_BUCKET = 'studio-media'

async function mirrorToStorage(remoteUrl, profileId, kind) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return remoteUrl
  try {
    const r = await fetch(remoteUrl)
    if (!r.ok) return remoteUrl
    const buf = Buffer.from(await r.arrayBuffer())
    const ext = kind === 'image' ? 'jpg' : kind === 'video' ? 'mp4' : 'bin'
    const ct = kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'application/octet-stream'
    const path = `${profileId || 'shared'}/studio/${kind}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const up = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${STUDIO_BUCKET}/${encodeURI(path)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': ct,
          'x-upsert': 'true',
        },
        body: buf,
      }
    )
    if (!up.ok) return remoteUrl
    return `${SUPABASE_URL}/storage/v1/object/public/${STUDIO_BUCKET}/${path}`
  } catch {
    return remoteUrl
  }
}

function pickKieImageUrl(data) {
  let out = []
  const rj = data?.resultJson
  if (typeof rj === 'string') {
    try {
      const parsed = JSON.parse(rj)
      if (Array.isArray(parsed?.resultUrls)) out = parsed.resultUrls
      else if (Array.isArray(parsed)) out = parsed
    } catch { /* ignore */ }
  } else if (rj && Array.isArray(rj.resultUrls)) {
    out = rj.resultUrls
  }
  if (!out.length) {
    out = data?.resultUrls || data?.result?.urls || data?.images?.map?.((i) => i.url || i) || []
  }
  const first = (Array.isArray(out) ? out : []).filter(Boolean)[0]
  return typeof first === 'string' ? first : first?.url || null
}

async function pollKieTask(segment, kieKey, profileId) {
  if (!segment.kie_task_id) return false
  const r = await fetch(
    `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(segment.kie_task_id)}`,
    { headers: { Authorization: `Bearer ${kieKey}` } }
  )
  const text = await r.text()
  let body = {}
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  const data = body?.data || body
  const state = String(data?.state || data?.status || '').toLowerCase()
  const url = pickKieImageUrl(data)
  if (state === 'fail' || state === 'failed' || state === 'error') {
    await supaFetch(`studio_segments?id=eq.${segment.id}`, {
      method: 'PATCH',
      body: { status: 'error', error: (data?.failMsg || data?.errorMessage || 'Image generation failed').slice(0, 500) },
      prefer: 'return=minimal',
    })
    return true
  }
  if (url && (state === 'success' || state === 'completed' || state === 'done' || state === 'finished' || true)) {
    const mirrored = await mirrorToStorage(url, profileId, 'image')
    // image_url + ready iff voice_url is also already there (the orchestrator
    // sequences voice before image, so this should always be true; double-check
    // anyway so a partial state doesn't claim ready prematurely).
    const isReady = !!segment.voice_url
    await supaFetch(`studio_segments?id=eq.${segment.id}`, {
      method: 'PATCH',
      body: { image_url: mirrored, status: isReady ? 'ready' : 'generating_audio', error: null },
      prefer: 'return=minimal',
    })
    return true
  }
  return false
}

async function pollHeygenVideo(segment, profileId) {
  if (!segment.heygen_video_id) return false
  let resp
  try {
    resp = await getVideoStatusV3(segment.heygen_video_id)
  } catch (e) {
    await supaFetch(`studio_segments?id=eq.${segment.id}`, {
      method: 'PATCH',
      body: { status: 'error', error: `HeyGen poll failed: ${e.message}`.slice(0, 500) },
      prefer: 'return=minimal',
    })
    return true
  }
  const data = resp?.data || resp || {}
  const status = String(data?.status || '').toLowerCase()
  const videoUrl = data?.video_url || data?.video_url_caption || data?.gif_url
  if (status === 'failed' || status === 'error') {
    await supaFetch(`studio_segments?id=eq.${segment.id}`, {
      method: 'PATCH',
      body: { status: 'error', error: (data?.error?.message || 'HeyGen render failed').slice(0, 500) },
      prefer: 'return=minimal',
    })
    return true
  }
  if (status === 'completed' || (videoUrl && status !== 'processing' && status !== 'pending')) {
    const mirrored = videoUrl ? await mirrorToStorage(videoUrl, profileId, 'video') : null
    if (!mirrored) return false
    const isReady = !!segment.voice_url
    await supaFetch(`studio_segments?id=eq.${segment.id}`, {
      method: 'PATCH',
      body: { avatar_video_url: mirrored, status: isReady ? 'ready' : 'generating_audio', error: null },
      prefer: 'return=minimal',
    })
    return true
  }
  return false
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    gateStudio(auth.user.id)

    const videoId = req.query.studio_video_id
    if (!videoId) return res.status(400).json({ error: 'studio_video_id required' })
    const vRows = await supaFetch(`studio_videos?id=eq.${videoId}&select=id,profile_id,status&limit=1`)
    const video = vRows?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    // Pull just the rows that need polling. Anything in 'ready', 'error', or
    // 'pending' (no task submitted) is skipped — we only poll rows mid-flight.
    const targets = await supaFetch(
      `studio_segments?studio_video_id=eq.${videoId}&status=in.(generating_image,generating_avatar)&select=*&limit=200`
    )

    if (targets?.length) {
      const kieKey = process.env.KIE_API_KEY
      await Promise.all(targets.map(async (seg) => {
        try {
          if (seg.status === 'generating_image' && seg.kie_task_id) {
            await pollKieTask(seg, kieKey, video.profile_id)
          } else if (seg.status === 'generating_avatar' && seg.heygen_video_id) {
            await pollHeygenVideo(seg, video.profile_id)
          }
        } catch {
          // Individual failures stay localised; the next poll retries.
        }
      }))
    }

    // Re-check segment state to decide whether the parent video can advance.
    // We consider asset gen "done" when no segment is still in a generating_*
    // state. The parent stays in 'rendering' because task #10 (HyperFrames
    // final bake) still has to run; it will flip to 'rendered' when done.
    const allSegs = await supaFetch(
      `studio_segments?studio_video_id=eq.${videoId}&select=status,approved&limit=500`
    )
    const stillGenerating = (allSegs || []).some((s) => s.approved && (s.status === 'generating_image' || s.status === 'generating_avatar' || s.status === 'generating_audio'))

    // Return the full refreshed video + segments so the client doesn't need
    // a second round-trip.
    const fresh = await supaFetch(
      `studio_videos?id=eq.${videoId}&select=*,studio_segments(*)&studio_segments.order=segment_index.asc&limit=1`
    )
    return res.status(200).json({
      video: fresh?.[0] || null,
      still_generating: stillGenerating,
      polled: targets?.length || 0,
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
