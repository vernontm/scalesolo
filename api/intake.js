// PUBLIC (no auth) Brand Intake endpoint.
//
// GET  /api/intake?token=<uuid>
//   Resolve the intake token to a brand and return ONLY the display fields
//   { business_name, logo_url }. 404 for an unknown / malformed token.
//   Never leaks any other profile field.
//
// POST /api/intake   body: { token, answers, hp? }
//   Validate the token maps to a brand, STRICTLY validate the nested answers
//   shape (validateIntakeAnswers), then INSERT one brand_intake_submissions
//   row (status 'pending'). The stored summary_md is compiled SERVER-SIDE
//   from the validated answers; any client-sent summary is ignored, so the
//   digest the operator reviews can never diverge from the answers that
//   Prefill applies. 200 on success, 400 on a bad payload, 404 on a bad
//   token, 429 when rate-limited or the brand's pending queue is full.
//
// Tokens live in brand_intake_tokens (service-role only, RLS enabled with
// no policies; see migration 0067), NOT on the profiles row, so no
// collaborator read path (GET /api/profiles or a direct PostgREST select)
// can ever see them.
//
// This endpoint NEVER writes to profiles and never returns anything beyond
// the two display fields. It runs on the service role (setCors + supaFetch)
// and enforces the token check in code, exactly like api/forms-public.js /
// api/forms/submit.js.

import { setCors, supaFetch, isUuid } from './_lib/supabase.js'
import { validateIntakeAnswers, compileIntakeSummary } from './_lib/brandIntake.js'

// Defensive cap so a hostile client can't push a huge row into the table.
// validateIntakeAnswers also caps every nested value, this bounds the total.
const MAX_ANSWERS_BYTES = 100_000     // ~100KB of JSON answers

// Hard cap on total pending submissions per brand. Bounds flood damage
// regardless of rate-limiter instance resets: once a brand has this many
// unreviewed rows, new submissions get a friendly 429 until the operator
// reviews them. Enforced against the DB, so it holds across serverless
// instances and cold starts.
const MAX_PENDING_PER_BRAND = 20

// Best-effort per-instance rate limit (mirrors api/forms/submit.js). Caps
// how many submissions a single IP can push for one token per hour. Each
// call also sweeps stale entries so distinct (brand, IP) keys cannot grow
// the map for the life of the instance.
const RATE_WINDOW_MS = 60 * 60 * 1000
const rateMap = new Map()
function rateAllowed(key, perHour) {
  const now = Date.now()
  for (const [k, times] of rateMap) {
    const live = times.filter((t) => now - t < RATE_WINDOW_MS)
    if (live.length) rateMap.set(k, live)
    else rateMap.delete(k)
  }
  const arr = [...(rateMap.get(key) || []), now]
  rateMap.set(key, arr)
  return arr.length <= perHour
}

// Look up the brand a token points at via the service-role-only token
// table. Returns { id, business_name, logo_url } or null. Only ever selects
// the columns we are willing to expose.
async function resolveToken(token) {
  if (!isUuid(token)) return null
  const rows = await supaFetch(
    `brand_intake_tokens?token=eq.${token}&select=profile_id,profile:profiles(business_name,logo_url)&limit=1`
  )
  const row = rows?.[0]
  if (!row?.profile_id) return null
  return {
    id: row.profile_id,
    business_name: row.profile?.business_name || '',
    logo_url: row.profile?.logo_url || null,
  }
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
        brand: { business_name: brand.business_name, logo_url: brand.logo_url },
      })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      const { token, answers } = body

      const brand = await resolveToken(token)
      if (!brand) return res.status(404).json({ error: 'This intake link is not valid.' })

      // Honeypot (mirrors api/forms/submit.js): the page renders a hidden
      // 'hp' field no human ever fills in. A non-empty value means a bot;
      // drop the submission silently with a success-shaped response.
      if (typeof body.hp === 'string' && body.hp.trim()) {
        return res.status(200).json({ ok: true, ignored: true })
      }

      // Strict shape validation: only the documented nested shape is
      // accepted, and only the known keys are stored.
      const checked = validateIntakeAnswers(answers)
      if (!checked.ok) return res.status(400).json({ error: checked.error })
      const clean = checked.value
      if (JSON.stringify(clean).length > MAX_ANSWERS_BYTES) {
        return res.status(400).json({ error: 'answers payload too large' })
      }

      // Compile the stored summary server-side from the validated answers.
      // A client-sent summary_md is deliberately ignored: the operator
      // reviews this stored digest and Prefill applies these same answers,
      // so the reviewed artifact and the applied artifact always match.
      const summaryMd = compileIntakeSummary(clean)

      // Rate limit per token + IP (best-effort, per instance).
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || ''
      if (!rateAllowed(`intake:${brand.id}:${ip}`, 20)) {
        return res.status(429).json({ error: 'Too many submissions, slow down.' })
      }

      // Per-brand pending cap, enforced against the DB.
      const pending = await supaFetch(
        `brand_intake_submissions?profile_id=eq.${brand.id}&status=eq.pending&select=id&limit=${MAX_PENDING_PER_BRAND}`
      )
      if (Array.isArray(pending) && pending.length >= MAX_PENDING_PER_BRAND) {
        return res.status(429).json({
          error: 'This brand already has the maximum number of submissions waiting for review. Please reach out to the ScaleSolo team directly.',
        })
      }

      const inserted = await supaFetch('brand_intake_submissions', {
        method: 'POST',
        body: {
          profile_id: brand.id,
          answers: clean,
          summary_md: summaryMd,
          status: 'pending',
        },
      })
      const row = Array.isArray(inserted) ? inserted[0] : inserted

      // Cap-race cleanup: the pre-insert count above is check-then-insert
      // with no DB-side atomicity, so N concurrent requests can all pass the
      // check and overshoot the cap. Re-count after the insert; if this
      // request pushed the brand over the cap, delete OUR row by id and
      // 429. Single attempt, no loop: a failure here leaves at worst a
      // bounded overshoot of the concurrent burst size, which the pre-insert
      // check then caps permanently.
      if (row?.id) {
        try {
          const recount = await supaFetch(
            `brand_intake_submissions?profile_id=eq.${brand.id}&status=eq.pending&select=id&limit=${MAX_PENDING_PER_BRAND + 1}`
          )
          if (Array.isArray(recount) && recount.length > MAX_PENDING_PER_BRAND) {
            await supaFetch(`brand_intake_submissions?id=eq.${row.id}`, {
              method: 'DELETE',
              prefer: 'return=minimal',
            })
            return res.status(429).json({
              error: 'This brand already has the maximum number of submissions waiting for review. Please reach out to the ScaleSolo team directly.',
            })
          }
        } catch { /* best-effort guard; the insert stands if the recheck fails */ }
      }

      return res.status(200).json({ ok: true, submission_id: row?.id })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
