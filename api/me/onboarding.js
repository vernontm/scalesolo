// /api/me/onboarding — read or save the current user's onboarding survey.
//
//   GET  → { completed: bool, data: object | null }
//   POST → body { ...surveyData }, marks completed=true and stores data.
//          The response includes the saved row so the SPA can use it
//          to personalize the dashboard right away.
//
// We deliberately allow POSTing AFTER completion (e.g. user wants to
// re-take the survey from a "Settings → Personalize" link). The flag
// stays true once set; only the data blob updates.

import { setCors, requireUser, supaFetch } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const rows = await supaFetch(
        `user_profiles?id=eq.${auth.user.id}&select=onboarding_completed,onboarding_data`
      )
      const row = rows?.[0]
      return res.status(200).json({
        completed: !!row?.onboarding_completed,
        data: row?.onboarding_data || null,
      })
    }

    if (req.method === 'POST') {
      // Whitelist what we save so a stray client field doesn't pollute
      // the jsonb. Each key matches the original ScaleSolo survey shape.
      const incoming = req.body || {}
      const ALLOWED = new Set([
        'businessType', 'businessTypeOther',
        'contentChallenge',
        'features',
        'monthlySpend',
        'currentTools', 'currentToolsOther',
        'howHeard', 'howHeardOther',
        // brand_setup step — captured for analytics. The actual brand
        // profile is created via /api/profiles in the same submit.
        'brandBusinessName', 'brandBible',
      ])
      const data = {}
      for (const [k, v] of Object.entries(incoming)) {
        if (!ALLOWED.has(k)) continue
        // String fields — cap length so a malicious client can't bloat
        // the row. Arrays are kept as-is (multi-select).
        if (typeof v === 'string') data[k] = v.slice(0, k === 'brandBible' ? 12000 : 500)
        else if (Array.isArray(v)) data[k] = v.slice(0, 30).map((x) => String(x).slice(0, 200))
        else if (v == null) data[k] = null
      }

      // Upsert into user_profiles. The row exists for every signed-in
      // user (created at signup); if not, insert one defensively.
      try {
        await supaFetch(`user_profiles?id=eq.${auth.user.id}`, {
          method: 'PATCH',
          body: { onboarding_completed: true, onboarding_data: data },
          prefer: 'return=minimal',
        })
      } catch {
        await supaFetch('user_profiles', {
          method: 'POST',
          body: [{ id: auth.user.id, onboarding_completed: true, onboarding_data: data }],
          prefer: 'return=minimal',
        })
      }
      return res.status(200).json({ completed: true, data })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('me/onboarding error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
