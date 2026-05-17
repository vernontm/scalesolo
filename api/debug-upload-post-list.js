// GET /api/debug-upload-post-list?token=...
//
// TEMPORARY. Hits exactly one URL — the documented
// GET /api/uploadposts/schedule — using our master Apikey and dumps
// the absolute raw response (status, headers, body) so we can see
// exactly what Upload-Post is sending back. No filtering, no wrapping.

import { setCors } from './_lib/supabase.js'

const BASE = 'https://api.upload-post.com'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const expected = process.env.DEBUG_TOKEN || ''
  const supplied = (req.query.token || '').toString()
  if (!expected || !supplied || expected !== supplied) {
    return res.status(404).json({ error: 'Not found' })
  }

  const key = process.env.UPLOADPOST_API_KEY
  if (!key) return res.status(500).json({ error: 'UPLOADPOST_API_KEY env var missing' })

  try {
    // Optional: ?request_id=... probes the per-request status endpoint
    // (the one our sync-scheduled-posts cron calls to flip rows from
    // scheduled → posted/failed). Useful for diagnosing rows stuck in
    // scheduled even after their scheduled_datetime has passed.
    const requestId = (req.query.request_id || '').toString().trim()
    if (requestId) {
      const r = await fetch(
        `${BASE}/api/uploadposts/status?request_id=${encodeURIComponent(requestId)}`,
        { headers: { Authorization: `Apikey ${key}`, Accept: 'application/json' } }
      )
      const text = await r.text()
      const headersOut = {}
      r.headers.forEach((v, k) => { headersOut[k] = v })
      let parsed = null
      try { parsed = JSON.parse(text) } catch {}
      return res.status(200).json({
        url: `${BASE}/api/uploadposts/status?request_id=${requestId}`,
        http_status: r.status,
        response_headers: headersOut,
        response_body_raw: text,
        response_body_parsed: parsed,
      })
    }

    const r = await fetch(`${BASE}/api/uploadposts/schedule`, {
      method: 'GET',
      headers: { Authorization: `Apikey ${key}`, Accept: 'application/json' },
    })
    const text = await r.text()
    const headersOut = {}
    r.headers.forEach((v, k) => { headersOut[k] = v })
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return res.status(200).json({
      url: `${BASE}/api/uploadposts/schedule`,
      auth_scheme: 'Apikey',
      api_key_last4: key.slice(-4),
      http_status: r.status,
      response_headers: headersOut,
      response_body_raw: text,
      response_body_parsed_is_array: Array.isArray(parsed),
      response_body_parsed_type: parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed,
      response_body_parsed_length: Array.isArray(parsed) ? parsed.length : null,
      response_body_first_item: Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : null,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
