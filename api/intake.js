// PUBLIC (no auth) Brand Intake endpoint.
//
// GET  /api/intake?token=<uuid>
//   Resolve the intake token to a brand and return ONLY the display fields
//   { business_name, logo_url }. 404 for an unknown / malformed token.
//   Never leaks any other profile field.
//
// POST /api/intake   body: { token, answers, summary_md }
//   Validate the token maps to a brand, validate the payload shape + size,
//   then INSERT one brand_intake_submissions row (status 'pending').
//   200 on success, 400 on bad payload, 404 on bad token.
//
// This endpoint NEVER writes to profiles and never returns anything beyond
// the two display fields. It runs on the service role (setCors + supaFetch)
// and enforces the token check in code, exactly like api/forms-public.js /
// api/forms/submit.js.

import { setCors, supaFetch, isUuid } from './_lib/supabase.js'

// Defensive caps so a hostile client can't push a huge row into the table.
const MAX_ANSWERS_BYTES = 100_000     // ~100KB of JSON answers
const MAX_SUMMARY_CHARS = 100_000     // ~100KB of markdown

// Best-effort per-instance rate limit (mirrors api/forms/submit.js). Caps
// how many submissions a single IP can push for one token per hour.
const rateMap = new Map()
function rateAllowed(key, perHour) {
  const now = Date.now()
  const arr = (rateMap.get(key) || []).filter((t) => now - t < 60 * 60 * 1000)
  arr.push(now)
  rateMap.set(key, arr)
  return arr.length <= perHour
}

// Look up the brand a token points at. Returns the row (id + display fields)
// or null. Only ever selects the columns we are willing to expose.
async function resolveToken(token) {
  if (!isUuid(token)) return null
  const rows = await supaFetch(
    `profiles?intake_token=eq.${token}&select=id,business_name,logo_url&limit=1`
  )
  return rows?.[0] || null
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  try {
    if (req.method === 'GET') {
      const token = req.query.token
      const brand = await resolveToken(token)
      if (!brand) return res.status(404).json({ error: 'This intake link is not valid.' })
      // Display fields only. Deliberately does NOT include brand.id or
      // anything else the questionnaire page has no business seeing.
      return res.status(200).json({
        brand: { business_name: brand.business_name || '', logo_url: brand.logo_url || null },
      })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      const { token, answers, summary_md } = body

      const brand = await resolveToken(token)
      if (!brand) return res.status(404).json({ error: 'This intake link is not valid.' })

      // Validate payload shape.
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
        return res.status(400).json({ error: 'answers must be an object' })
      }
      let answersJson
      try {
        answersJson = JSON.stringify(answers)
      } catch {
        return res.status(400).json({ error: 'answers is not serializable' })
      }
      if (answersJson.length > MAX_ANSWERS_BYTES) {
        return res.status(400).json({ error: 'answers payload too large' })
      }
      if (summary_md != null && typeof summary_md !== 'string') {
        return res.status(400).json({ error: 'summary_md must be a string' })
      }
      if (typeof summary_md === 'string' && summary_md.length > MAX_SUMMARY_CHARS) {
        return res.status(400).json({ error: 'summary_md too large' })
      }

      // Rate limit per token + IP.
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || ''
      if (!rateAllowed(`intake:${brand.id}:${ip}`, 20)) {
        return res.status(429).json({ error: 'Too many submissions, slow down.' })
      }

      const inserted = await supaFetch('brand_intake_submissions', {
        method: 'POST',
        body: {
          profile_id: brand.id,
          answers,
          summary_md: typeof summary_md === 'string' ? summary_md : null,
          status: 'pending',
        },
      })
      const row = Array.isArray(inserted) ? inserted[0] : inserted
      return res.status(200).json({ ok: true, submission_id: row?.id })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
