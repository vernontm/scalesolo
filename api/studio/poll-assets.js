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

// Mirror a remote asset URL into our studio-media Supabase bucket. The
// expensive case: HeyGen avatar MP4s. HeyGen's CDN URLs expire in
// 7-30 days, so we MUST own the bytes — otherwise an "update styling
// only" template swap a month from now is a re-bake against a dead
// URL and silently produces a broken video.
//
// Previously this returned `remoteUrl` on any failure, which silently
// poisoned the DB with an expiring URL. New behavior: retry once on
// transient failures, and on persistent failure THROW. Callers handle
// the throw by setting the segment to status='error' so the user sees
// it instead of silently shipping a fragile URL.
class MirrorError extends Error {
  constructor(msg, cause) {
    super(msg)
    this.name = 'MirrorError'
    if (cause) this.cause = cause
  }
}

async function mirrorOnce(remoteUrl, profileId, kind) {
  const r = await fetch(remoteUrl)
  if (!r.ok) throw new MirrorError(`download ${r.status} for ${remoteUrl.slice(0, 80)}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.byteLength === 0) throw new MirrorError(`empty body downloading ${kind}`)
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
  if (!up.ok) {
    let detail = ''
    try { detail = (await up.text())?.slice(0, 200) } catch {}
    throw new MirrorError(`upload ${up.status}: ${detail}`)
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${STUDIO_BUCKET}/${path}`
}

async function mirrorToStorage(remoteUrl, profileId, kind) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new MirrorError('Supabase storage not configured (missing SUPABASE_URL or SUPABASE_SERVICE_KEY)')
  }
  try {
    return await mirrorOnce(remoteUrl, profileId, kind)
  } catch (firstErr) {
    // One retry after a short backoff covers the vast majority of
    // transient blips (rate limit, brief network hiccup, S3 503).
    await new Promise((r) => setTimeout(r, 1500))
    try {
      return await mirrorOnce(remoteUrl, profileId, kind)
    } catch (secondErr) {
      console.error('[studio mirror] failed twice:', secondErr.message, 'first:', firstErr.message)
      throw secondErr
    }
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
    let mirrored
    try {
      mirrored = await mirrorToStorage(url, profileId, 'image')
    } catch (e) {
      // Persistent mirror failure → DO NOT write the expiring Kie URL
      // to image_url. Mark the segment errored so the user sees it.
      await supaFetch(`studio_segments?id=eq.${segment.id}`, {
        method: 'PATCH',
        body: { status: 'error', error: `Could not save B-roll image to storage: ${e.message}`.slice(0, 500) },
        prefer: 'return=minimal',
      })
      return true
    }
    // Branch: still image vs Grok video b-roll. When the segment is
    // flagged is_video_broll, the still we just got from Kie becomes
    // the FIRST FRAME of a Grok Imagine Image-to-Video render. We
    // dispatch the Grok task here and let pollGrokTask finish it.
    // The segment stays 'generating_image' until both still + video
    // are in. Otherwise it's a normal b-roll image → ready as usual.
    if (segment.is_video_broll && !segment.broll_video_url) {
      let grokTaskId = null
      let grokError = null
      try {
        grokTaskId = await dispatchVideoBrollFromImage({
          segment_with_image: { ...segment, image_url: mirrored },
          apiKey: kieKey,
          aspectRatio: await loadVideoAspectRatio(segment.studio_video_id),
          voiceDurationSecs: segment.voice_duration_secs,
        })
      } catch (e) {
        grokError = e.message
      }
      await supaFetch(`studio_segments?id=eq.${segment.id}`, {
        method: 'PATCH',
        body: grokTaskId
          ? { image_url: mirrored, grok_task_id: grokTaskId, status: 'generating_image', error: null }
          : { image_url: mirrored, status: 'error', error: `Grok video dispatch failed: ${(grokError || 'unknown').slice(0, 500)}` },
        prefer: 'return=minimal',
      })
      return true
    }
    // Plain image-only b-roll path.
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

// Inline Grok Imagine dispatch — mirrors dispatchVideoBroll in
// generate-assets.js. Lives here so pollKieTask can hand off to Grok
// the moment the still image lands without making a second
// orchestrator pass. Kept in this file (vs. importing from
// generate-assets) because that module isn't structured as a clean
// helper export and the dispatch is small enough to duplicate.
async function dispatchVideoBrollFromImage({ segment_with_image, apiKey, aspectRatio, voiceDurationSecs }) {
  if (!segment_with_image?.image_url) throw new Error('No image_url to send to Grok')
  const prompt = (segment_with_image.broll_video_prompt && segment_with_image.broll_video_prompt.trim())
    || (segment_with_image.script_text && segment_with_image.script_text.trim())
    || (segment_with_image.image_prompt && segment_with_image.image_prompt.trim())
    || 'Subtle camera movement, natural motion, cinematic'
  const desiredSecs = Math.max(6, Math.min(30, Math.ceil(Number(voiceDurationSecs) || 6)))
  const ar = ['16:9', '9:16', '1:1', '2:3', '3:2'].includes(aspectRatio) ? aspectRatio : '16:9'
  const submit = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-imagine/image-to-video',
      input: {
        image_urls: [segment_with_image.image_url],
        prompt: prompt.slice(0, 5000),
        mode: 'normal',
        duration: String(desiredSecs),
        resolution: '720p',
        aspect_ratio: ar,
      },
    }),
  })
  const text = await submit.text()
  let data = {}
  try { data = JSON.parse(text) } catch { /* ignore */ }
  if (!submit.ok || (data?.code && data.code !== 200)) {
    throw new Error(`Kie Grok createTask ${submit.status}: ${(data?.msg || text).slice(0, 240)}`)
  }
  const taskId = data?.data?.taskId || data?.taskId
  if (!taskId) throw new Error(`Kie Grok response missing taskId: ${text.slice(0, 240)}`)
  return taskId
}

async function loadVideoAspectRatio(videoId) {
  if (!videoId) return '16:9'
  const rows = await supaFetch(`studio_videos?id=eq.${videoId}&select=aspect_ratio&limit=1`).catch(() => [])
  return rows?.[0]?.aspect_ratio || '16:9'
}

// Poll Kie's Grok Imagine task. Same recordInfo endpoint as image
// tasks — Kie's unified jobs API returns the resultUrls regardless
// of model. Writes broll_video_url when the mp4 lands and flips
// status='ready' if voice_url is also in place.
async function pollGrokTask(segment, kieKey, profileId) {
  if (!segment.grok_task_id) return false
  const r = await fetch(
    `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(segment.grok_task_id)}`,
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
      body: { status: 'error', error: (data?.failMsg || data?.errorMessage || 'Grok video generation failed').slice(0, 500) },
      prefer: 'return=minimal',
    })
    return true
  }
  if (url) {
    let mirrored
    try {
      mirrored = await mirrorToStorage(url, profileId, 'video')
    } catch (e) {
      await supaFetch(`studio_segments?id=eq.${segment.id}`, {
        method: 'PATCH',
        body: { status: 'error', error: `Could not save Grok video to storage: ${e.message}`.slice(0, 500) },
        prefer: 'return=minimal',
      })
      return true
    }
    const isReady = !!segment.voice_url
    await supaFetch(`studio_segments?id=eq.${segment.id}`, {
      method: 'PATCH',
      body: { broll_video_url: mirrored, status: isReady ? 'ready' : 'generating_audio', error: null },
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
    if (!videoUrl) return false
    let mirrored
    try {
      mirrored = await mirrorToStorage(videoUrl, profileId, 'video')
    } catch (e) {
      // HeyGen URLs expire — never write them straight to the row. If
      // mirroring fails persistently we surface an error so the user
      // can retry rather than silently shipping a fragile URL into a
      // template-swap or final-bake months from now.
      await supaFetch(`studio_segments?id=eq.${segment.id}`, {
        method: 'PATCH',
        body: { status: 'error', error: `Could not save avatar video to storage: ${e.message}`.slice(0, 500) },
        prefer: 'return=minimal',
      })
      return true
    }
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
          // Grok video poll wins over image poll when both are in
          // flight on the same segment — image already landed (since
          // grok_task_id only gets set after image_url is filled by
          // pollKieTask) and we're now waiting on the video render.
          if (seg.status === 'generating_image' && seg.grok_task_id && !seg.broll_video_url) {
            await pollGrokTask(seg, kieKey, video.profile_id)
          } else if (seg.status === 'generating_image' && seg.kie_task_id && !seg.image_url) {
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
