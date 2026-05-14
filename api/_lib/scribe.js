// ElevenLabs Scribe — speech-to-text. Used by the URL Reference flow
// to transcribe a TikTok / Reel / YouTube the user pastes so Claude
// can analyze patterns and (in remix mode) rewrite in the user's voice.
//
// Two helpers exposed:
//
//   resolveTikTokUrl(url) — turns a tiktok.com/@x/video/123... share
//     URL into a directly-fetchable MP4 URL via tikwm.com (a free
//     resolver). Returns { mp4_url, creator_handle, thumbnail_url,
//     duration_secs, title }. Best-effort — falls back to returning
//     the original URL when tikwm is down or the URL isn't TikTok.
//
//   transcribeFromUrl(mediaUrl, opts?) — POSTs to ElevenLabs Scribe
//     and returns { text, language_code, duration_secs }. Scribe
//     accepts a `cloud_storage_url` so we don't have to download +
//     upload the audio ourselves; the API handles that.

const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text'

function elKey() {
  const k = process.env.ELEVENLABS_API_KEY
  if (!k) throw new Error('ELEVENLABS_API_KEY not configured')
  return k
}

// Walk URL through tikwm's free no-auth API. The endpoint returns
// { code, msg, data: { play, hdplay, cover, duration, author: { unique_id, … }, title } }.
// Only used for TikTok / Douyin URLs; everything else passes through.
export async function resolveTikTokUrl(url) {
  const u = String(url || '')
  if (!/tiktok\.com|douyin\.com|vm\.tiktok\.com|vt\.tiktok\.com/i.test(u)) {
    return { mp4_url: u }
  }
  try {
    const r = await fetch('https://www.tikwm.com/api/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `url=${encodeURIComponent(u)}&hd=1`,
    })
    if (!r.ok) return { mp4_url: u }
    const body = await r.json().catch(() => ({}))
    const d = body?.data
    if (!d?.play) return { mp4_url: u }
    return {
      mp4_url:        d.hdplay || d.play,
      creator_handle: d.author?.unique_id || null,
      thumbnail_url:  d.cover || d.origin_cover || null,
      duration_secs:  d.duration ? Math.round(Number(d.duration)) : null,
      title:          d.title || null,
    }
  } catch (e) {
    console.warn('resolveTikTokUrl failed:', e?.message)
    return { mp4_url: u }
  }
}

// Pre-step: extract audio from a video URL via the Fly.io ffmpeg worker.
// Outputs a mono 16kHz mp3 (~30KB/sec) so Scribe receives a tiny, clean
// audio file regardless of the source video's container, codec, or size.
// Permanently fixes the "201MB .mov fails to transcribe" failure mode.
//
// Only fires when:
//   • opts.profile_id is provided (worker writes to landing-media/<profile_id>/transcripts/)
//   • WORKER_URL is configured
//   • the URL looks like video (or its content-type does)
// Falls back to the original URL silently when any condition isn't met.
export async function extractAudioForTranscription(videoUrl, profileId) {
  if (!videoUrl || !profileId) return null
  const WORKER_URL = process.env.WORKER_URL
  const WORKER_SECRET = process.env.WORKER_SHARED_SECRET
  if (!WORKER_URL) return null
  try {
    const r = await fetch(`${WORKER_URL.replace(/\/$/, '')}/jobs/extract-audio`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WORKER_SECRET ? { 'x-worker-secret': WORKER_SECRET } : {}),
      },
      body: JSON.stringify({ profile_id: profileId, video_url: videoUrl }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok || !body?.audio_url) {
      console.warn(`[scribe] audio extract failed (${r.status}): ${body?.error || 'unknown'} — falling back to original URL`)
      return null
    }
    return body.audio_url
  } catch (e) {
    console.warn('[scribe] audio extract threw:', e?.message)
    return null
  }
}

// Lightweight heuristic for "is this a video URL?" — used to decide
// whether to run the audio-extract pre-step. We err on the side of
// extracting (cheap when small, huge win when large) but skip for
// obvious audio files where extract is wasted work.
function looksLikeVideo(url) {
  return /\.(mp4|mov|webm|m4v|mkv|avi|wmv|flv|mpg|mpeg)(\?|#|$)/i.test(String(url || ''))
}

// Submit the URL to Scribe. Three-step now:
//   0. (NEW) If this is a video URL and we have a profile_id, extract
//      the audio track to mp3 via the ffmpeg worker FIRST. Tiny files
//      transcribe faster and bypass Scribe's quirks with large/.mov
//      cloud_storage_url fetches.
//   1. cloud_storage_url — Scribe fetches the file. Fast (no proxy).
//   2. If step 1 either 4xx's OR returns an empty transcript (Scribe
//      sometimes silently fails to fetch from certain CDNs and
//      returns 200 with text=""), fall back to fetching the bytes
//      ourselves and POSTing as multipart. Slower but reliable —
//      we control the network path.
//
// Returns { text, language_code, duration_secs }.
// no_verbatim: true keeps the transcript clean (drops "uh", "um"…).
// opts.profile_id: pass to enable the audio-extract pre-step.
export async function transcribeFromUrl(mediaUrl, opts = {}) {
  if (!mediaUrl) throw new Error('mediaUrl required')

  // Step 0 — extract audio for video URLs when worker is available.
  // Replaces mediaUrl with the tiny mp3 for the rest of the function;
  // Scribe then deals with a 1-3MB audio file instead of a 200MB video.
  if (opts.profile_id && looksLikeVideo(mediaUrl)) {
    const audioUrl = await extractAudioForTranscription(mediaUrl, opts.profile_id)
    if (audioUrl) {
      console.log(`[scribe] using extracted audio for transcription (was video URL)`)
      mediaUrl = audioUrl
    }
    // If extract failed, fall through to the original URL — Scribe may
    // still handle it; the prior 200MB cap on multipart fallback was
    // the bigger blocker.
  }

  const callScribe = async (formBuilder) => {
    const form = new FormData()
    formBuilder(form)
    // Default to scribe_v2 — v1 rejects the no_verbatim parameter as of
    // ElevenLabs's 2025 API change. v2 is also the newer/better model.
    const modelId = opts.model_id || 'scribe_v2'
    form.set('model_id', modelId)
    if (opts.language_code) form.set('language_code', opts.language_code)
    // no_verbatim is v2-only. Skip it for v1 callers (only ones who
    // explicitly opt out by passing model_id: 'scribe_v1').
    if (modelId !== 'scribe_v1') {
      form.set('no_verbatim', String(opts.no_verbatim ?? true))
    }
    if (opts.diarize) form.set('diarize', 'true')
    const r = await fetch(SCRIBE_URL, {
      method: 'POST',
      headers: { 'xi-api-key': elKey(), Accept: 'application/json' },
      body: form,
    })
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = { raw: text } }
    return { r, body, rawText: text }
  }

  // STEP 1: cloud_storage_url path.
  let { r, body, rawText } = await callScribe((f) => f.set('cloud_storage_url', mediaUrl))
  if (r.ok) {
    const txt = body?.text || body?.transcript || ''
    if (txt && txt.trim()) {
      return {
        text:          txt,
        language_code: body.language_code || body.detected_language || null,
        duration_secs: body.audio_duration_seconds || body.duration_secs || null,
        raw:           body,
      }
    }
    // 200 but empty — fall through to multipart
    console.warn('[scribe] cloud_storage_url returned 200 + empty transcript, retrying multipart')
  } else {
    console.warn(`[scribe] cloud_storage_url ${r.status}: ${body?.detail?.message || body?.error || rawText.slice(0, 200)} — retrying multipart`)
  }

  // STEP 2: multipart fallback. Fetch bytes ourselves, send as `file`.
  // Cap at 200MB (Scribe's hard limit is higher but we don't want runaway
  // memory on a serverless worker).
  const dl = await fetch(mediaUrl)
  if (!dl.ok) {
    const err = new Error(`ElevenLabs Scribe (multipart): could not fetch media ${dl.status} from ${mediaUrl}`)
    err.status = dl.status
    throw err
  }
  const buf = await dl.arrayBuffer()
  if (buf.byteLength === 0) {
    throw new Error('ElevenLabs Scribe (multipart): media body was empty')
  }
  // Cap is 500MB now (was 200MB). The ffmpeg-worker audio-extract pre-step
  // means we should almost never hit the multipart fallback with a raw
  // video anymore; this cap is the safety net when WORKER_URL isn't set
  // or extract failed. Scribe itself accepts ~2GB; we stay well under to
  // avoid Vercel function memory pressure.
  if (buf.byteLength > 500 * 1024 * 1024) {
    throw new Error(`ElevenLabs Scribe (multipart): file too large (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB > 500MB). Try compressing the video before upload.`)
  }
  const guessedType =
    dl.headers.get('content-type') ||
    (/\.mp3$/i.test(mediaUrl) ? 'audio/mpeg'  :
     /\.wav$/i.test(mediaUrl) ? 'audio/wav'   :
     /\.m4a$/i.test(mediaUrl) ? 'audio/mp4'   :
     'video/mp4')
  const filename =
    (mediaUrl.split('?')[0].split('/').pop() || 'media') || 'media'
  const blob = new Blob([buf], { type: guessedType })

  const fb = await callScribe((f) => f.set('file', blob, filename))
  if (!fb.r.ok) {
    const err = new Error(`ElevenLabs Scribe (multipart) ${fb.r.status}: ${fb.body?.detail?.message || fb.body?.error || fb.rawText.slice(0, 300)}`)
    err.status = fb.r.status
    err.data = fb.body
    throw err
  }
  return {
    text:          fb.body.text || fb.body.transcript || '',
    language_code: fb.body.language_code || fb.body.detected_language || null,
    duration_secs: fb.body.audio_duration_seconds || fb.body.duration_secs || null,
    raw:           fb.body,
  }
}
