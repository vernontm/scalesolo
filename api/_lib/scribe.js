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

// Submit the URL to Scribe. Falls back to the multipart-upload path if
// the cloud_storage_url method 4xx's (some buckets reject Scribe's
// fetcher). We don't currently fetch + reupload — that's the next
// fallback if real users hit it.
//
// Returns { text, language_code, duration_secs }.
// no_verbatim: true keeps the transcript clean (drops "uh", "um"…),
// matching the user's spec.
export async function transcribeFromUrl(mediaUrl, opts = {}) {
  if (!mediaUrl) throw new Error('mediaUrl required')
  const form = new FormData()
  form.set('cloud_storage_url', mediaUrl)
  form.set('model_id', opts.model_id || 'scribe_v1')
  if (opts.language_code) form.set('language_code', opts.language_code)
  // Default true — we want clean transcripts for downstream Claude analysis.
  form.set('no_verbatim', String(opts.no_verbatim ?? true))
  if (opts.diarize) form.set('diarize', 'true')

  const r = await fetch(SCRIBE_URL, {
    method: 'POST',
    headers: { 'xi-api-key': elKey(), Accept: 'application/json' },
    body: form,
  })
  const text = await r.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  if (!r.ok) {
    const err = new Error(`ElevenLabs Scribe ${r.status}: ${body?.detail?.message || body?.error || text.slice(0, 300)}`)
    err.status = r.status
    err.data = body
    throw err
  }
  return {
    text:           body.text || body.transcript || '',
    language_code:  body.language_code || body.detected_language || null,
    duration_secs:  body.audio_duration_seconds || body.duration_secs || null,
    raw:            body,
  }
}
