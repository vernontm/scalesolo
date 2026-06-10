// Visual analysis frame extractor — paired with worker/jobs/extract-frames.
//
// Used by the caption + auto-title flows as a fallback for videos where
// the audio transcript is empty or too short to anchor a Claude prompt
// (silent B-roll, music-only edits, sound-effect-only clips). Instead of
// returning a "no_speech_detected" placeholder, the caller hands Claude
// N keyframes and a vision-mode prompt so the model can describe what
// is actually happening on screen.
//
// Claude has no native video input — the API accepts images only, so
// the standard "Claude analyzes a video" pattern is sample → image →
// vision message. We sample 6 frames by default; the model performs
// well joint-analyzing that many frames as a sequence.
//
// Worker returns base64 JPEGs inline (no Supabase round-trip) so the
// caller drops them straight into a Claude messages content array:
//
//   const frames = await extractFramesFromUrl(videoUrl)
//   const content = [
//     ...frames.map((f) => ({
//       type: 'image',
//       source: { type: 'base64', media_type: f.media_type, data: f.base64 },
//     })),
//     { type: 'text', text: 'Describe what happens across these frames.' },
//   ]

export async function extractFramesFromUrl(videoUrl, opts = {}) {
  if (!videoUrl) return null
  const WORKER_URL = process.env.WORKER_URL
  const WORKER_SECRET = process.env.WORKER_SHARED_SECRET
  if (!WORKER_URL) {
    console.warn('[frames] WORKER_URL not configured; cannot extract frames')
    return null
  }

  const {
    count = 6,
    maxDim = 1568,
    quality = 70,
    timeoutMs = 90_000,
  } = opts

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(`${WORKER_URL.replace(/\/$/, '')}/jobs/extract-frames`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(WORKER_SECRET ? { 'x-worker-secret': WORKER_SECRET } : {}),
      },
      body: JSON.stringify({
        video_url: videoUrl,
        count, max_dim: maxDim, quality,
      }),
    })
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      console.warn(`[frames] worker ${r.status}: ${errText.slice(0, 200)}`)
      return null
    }
    const body = await r.json().catch(() => null)
    const frames = Array.isArray(body?.frames) ? body.frames : []
    if (frames.length === 0) return null
    return {
      frames,
      duration_secs: body?.duration_secs ?? null,
      sampled: frames.length,
    }
  } catch (e) {
    console.warn('[frames] extractFramesFromUrl failed:', e?.message || e)
    return null
  } finally {
    clearTimeout(t)
  }
}

// Convenience: shape extracted frames into Anthropic vision content
// blocks. Caller typically appends a final `{type:"text", text}` instructions
// block after these.
export function framesToVisionBlocks(frames) {
  if (!Array.isArray(frames)) return []
  return frames.map((f) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: f.media_type || 'image/jpeg',
      data: f.base64,
    },
  }))
}
