// GET /api/admin/scribe-test?url=<media_url>
// Admin-only. Runs ElevenLabs Scribe against an arbitrary media URL
// and returns the full result + which path it took (cloud_storage_url
// vs multipart). Used to diagnose "Captions: 0/N updated · no
// detectable speech" reports from real users.
//
// Returns { ok, text, text_chars, text_preview, path, language_code,
//           duration_secs, raw_error?, fetch_ok? }
import { setCors, requireAdmin } from '../_lib/supabase.js'
import { transcribeFromUrl } from '../_lib/scribe.js'

export const config = { maxDuration: 120 }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAdmin(req, res)
  if (!auth) return

  const url = req.query?.url
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'url query param required (must be http(s))' })
  }

  // Verify the URL is reachable before handing it to Scribe — surfaces
  // 404s / CORS-style fetch failures cleanly.
  let head = null
  try {
    const h = await fetch(url, { method: 'HEAD' })
    head = { status: h.status, content_type: h.headers.get('content-type'), content_length: h.headers.get('content-length') }
  } catch (e) {
    head = { error: e.message }
  }

  let result = null
  let scribeError = null
  try {
    result = await transcribeFromUrl(url)
  } catch (e) {
    scribeError = { status: e.status || null, message: e.message, data: e.data || null }
  }

  return res.status(200).json({
    head,
    ok: !!result,
    text_chars: result?.text?.length || 0,
    text_preview: (result?.text || '').slice(0, 400),
    language_code: result?.language_code || null,
    duration_secs: result?.duration_secs || null,
    scribe_error: scribeError,
    raw_keys: result?.raw ? Object.keys(result.raw) : null,
  })
}
