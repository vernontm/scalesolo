// Shotstack Edit API client. Replaces local ffmpeg compositing for the
// polish flow so the heavy work runs on Shotstack's servers instead of
// inside a 300s Vercel function. We submit a timeline (video + optional
// title overlay + logo watermark + music), poll until the render is
// done, and return the resulting MP4 URL.
//
// Endpoint defaults to v1 (production). Override with SHOTSTACK_HOST
// (e.g. https://api.shotstack.io/edit/stage for staging).

// Accept the base path with or without a trailing slash and tolerate the
// user pasting the full `/render` URL straight from the Shotstack
// dashboard — we strip it so the submit/poll helpers can append cleanly.
const SHOTSTACK_HOST = (process.env.SHOTSTACK_HOST || 'https://api.shotstack.io/edit/v1')
  .replace(/\/+$/, '')
  .replace(/\/render$/, '')

function authHeaders() {
  const key = process.env.SHOTSTACK_API_KEY
  if (!key) throw new Error('SHOTSTACK_API_KEY not configured')
  return { 'x-api-key': key, 'Content-Type': 'application/json' }
}

// Map our internal corner codes to Shotstack's named anchors plus a
// 4% inset offset so the watermark sits inside the frame, not flush
// against the edge — matches the ffmpeg path's overlayPos() padding.
function watermarkPlacement(pos) {
  switch (pos) {
    case 'tl': return { position: 'topLeft',     offset: { x:  0.04, y: -0.04 } }
    case 'tr': return { position: 'topRight',    offset: { x: -0.04, y: -0.04 } }
    case 'bl': return { position: 'bottomLeft',  offset: { x:  0.04, y:  0.04 } }
    case 'br':
    default:   return { position: 'bottomRight', offset: { x: -0.04, y:  0.04 } }
  }
}

// Convert "y_pos % from top of frame" (UI semantics) into Shotstack's
// offset.y where +0.5 = top edge, -0.5 = bottom edge of an output that
// uses position: "center".
function titleOffsetY(yPosPct) {
  const pct = Math.max(0, Math.min(95, Number(yPosPct ?? 15)))
  return (50 - pct) / 100
}

// Build a Shotstack render payload from our polish inputs.
//
// videoLen — source video duration in seconds. We could ask Shotstack to
// auto-trim with `length: "auto"` but that's only honored on some asset
// types; pinning every clip to videoLen keeps the timeline deterministic.
export function buildTimeline({
  videoUrl, videoLen,
  titlePngUrl, titleYpos,
  logoUrl, watermarkPosition, watermarkSizePct,
  musicUrl, musicVolume, musicFadeSecs,
  aspectRatio = '9:16',
  resolution  = '1080',
}) {
  const tracks = []

  // Track ordering in Shotstack is top-down: track 0 renders on top of
  // track 1, etc. Title sits over watermark sits over the video plate.
  if (titlePngUrl) {
    tracks.push({
      clips: [{
        asset: { type: 'image', src: titlePngUrl },
        start: 0,
        length: videoLen,
        position: 'center',
        offset: { x: 0, y: titleOffsetY(titleYpos) },
        // Title PNG is rendered at 1080px wide (the video's width). Setting
        // scale: 1.0 keeps it 1:1, fit: "none" prevents Shotstack from
        // up-scaling to fill the frame.
        fit: 'none',
        scale: 1.0,
      }],
    })
  }

  if (logoUrl) {
    const { position, offset } = watermarkPlacement(watermarkPosition || 'br')
    const sizeFrac = Math.max(0.04, Math.min(0.4, Number(watermarkSizePct ?? 25) / 100))
    tracks.push({
      clips: [{
        asset: { type: 'image', src: logoUrl },
        start: 0,
        length: videoLen,
        position,
        offset,
        // `scale` on an image clip in Shotstack is the fraction of the
        // OUTPUT width the image's bounding box should occupy. So 0.25
        // → logo width = 25% of the 1080px output. Preserves aspect.
        scale: sizeFrac,
        fit: 'none',
      }],
    })
  }

  // Base plate: the source video, full duration, cover-fit so source
  // videos that don't perfectly match the output ratio crop instead of
  // letterbox. HeyGen avatars are already 9:16 so this is a no-op for
  // the common case.
  tracks.push({
    clips: [{
      asset: { type: 'video', src: videoUrl, volume: 1.0 },
      start: 0,
      length: videoLen,
      fit: 'cover',
    }],
  })

  const timeline = { background: '#000000', tracks }

  if (musicUrl) {
    const vol = Math.max(0, Math.min(1, Number(musicVolume ?? 0.15)))
    const fade = Math.max(0, Math.min(10, Number(musicFadeSecs ?? 1.0)))
    timeline.soundtrack = {
      src: musicUrl,
      effect: fade > 0 ? 'fadeOut' : 'none',
      volume: vol,
    }
  }

  return {
    timeline,
    output: {
      format: 'mp4',
      aspectRatio,
      resolution,                  // "1080" → long edge 1920 for 9:16
      fps: 30,
      quality: 'medium',           // medium = ~CRF 25, matches ffmpeg path
    },
  }
}

export async function submitRender(payload) {
  const r = await fetch(`${SHOTSTACK_HOST}/render`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok || !body?.response?.id) {
    const msg = body?.message || body?.response?.message || JSON.stringify(body).slice(0, 300)
    throw new Error(`Shotstack submit ${r.status}: ${msg}`)
  }
  return body.response.id
}

// Poll the render status until done or failed. Shotstack states:
//   queued → fetching → rendering → saving → done
//   any of the above can transition to failed
//
// Default budget: 240s. With our local title-PNG step (~0.5s) and ZapCap
// downstream optional, this fits inside Vercel's 300s gateway with room
// for upload. Polling every 3s keeps us well under their rate limits.
export async function pollRender(renderId, { timeoutMs = 240_000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = ''
  while (Date.now() < deadline) {
    const r = await fetch(`${SHOTSTACK_HOST}/render/${renderId}`, {
      headers: { 'x-api-key': process.env.SHOTSTACK_API_KEY },
    })
    const body = await r.json().catch(() => ({}))
    const resp = body?.response || {}
    lastStatus = resp.status || lastStatus
    if (resp.status === 'done') {
      if (!resp.url) throw new Error('Shotstack reported done but no url')
      return { url: resp.url, status: resp.status, duration: resp.duration, render_time: resp.renderTime }
    }
    if (resp.status === 'failed') {
      throw new Error(`Shotstack render failed: ${resp.error || resp.message || 'unknown error'}`)
    }
    await new Promise((res) => setTimeout(res, intervalMs))
  }
  throw new Error(`Shotstack render did not finish within ${Math.round(timeoutMs / 1000)}s (last status: ${lastStatus})`)
}
