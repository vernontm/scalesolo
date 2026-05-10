// /api/brand-voice-summary — read or override the latest active
// brand voice summary for a profile. The summary is normally written
// by the daily distill-brand-voice cron, but users can edit it on the
// Profiles page if they want to take direct control.
//
//   GET  ?profile_id=…           → { summary: { ... } | null, history: [...] }
//   PUT  body { profile_id, summary, liked_patterns?, disliked_patterns? }
//        → upserts a new active row (marks previous active as inactive),
//          source='manual', sample_size=0
//   DELETE body { profile_id } → flips current active to inactive (so
//        the cron can write a fresh one tomorrow)

import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'

const MAX_SUMMARY = 4000
const MAX_PATTERNS = 2000

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const profileId = req.query.profile_id || (req.body && req.body.profile_id)
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileId)) {
      return res.status(400).json({ error: 'invalid profile_id' })
    }
    const role = await assertProfileAccess(auth.user.id, profileId)

    if (req.method === 'GET') {
      // Active summary + last 5 historical rows so the user can see how
      // the voice has evolved (or roll back if a recent run drifted).
      const rows = await supaFetch(
        `brand_voice_summaries?profile_id=eq.${profileId}&order=created_at.desc&limit=6&select=id,summary,liked_patterns,disliked_patterns,sample_size,is_active,created_at`
      ).catch(() => [])
      const active = rows?.find((r) => r.is_active) || null
      const history = (rows || []).filter((r) => !r.is_active).slice(0, 5)
      return res.status(200).json({ summary: active, history })
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      if (!['owner', 'admin', 'editor'].includes(role)) {
        return res.status(403).json({ error: 'Forbidden' })
      }
      const body = req.body || {}
      const summary = String(body.summary || '').slice(0, MAX_SUMMARY).trim()
      if (!summary) return res.status(400).json({ error: 'summary required' })
      const liked = body.liked_patterns ? String(body.liked_patterns).slice(0, MAX_PATTERNS) : null
      const disliked = body.disliked_patterns ? String(body.disliked_patterns).slice(0, MAX_PATTERNS) : null

      // Mark current active inactive, insert new active.
      await supaFetch(`brand_voice_summaries?profile_id=eq.${profileId}&is_active=eq.true`, {
        method: 'PATCH',
        body: { is_active: false },
        prefer: 'return=minimal',
      }).catch(() => {})
      const inserted = await supaFetch('brand_voice_summaries', {
        method: 'POST',
        body: {
          profile_id: profileId,
          summary,
          liked_patterns: liked,
          disliked_patterns: disliked,
          sample_size: 0,
          is_active: true,
        },
      })
      const row = Array.isArray(inserted) ? inserted[0] : inserted
      return res.status(200).json({ summary: row })
    }

    if (req.method === 'DELETE') {
      if (!['owner', 'admin', 'editor'].includes(role)) {
        return res.status(403).json({ error: 'Forbidden' })
      }
      await supaFetch(`brand_voice_summaries?profile_id=eq.${profileId}&is_active=eq.true`, {
        method: 'PATCH',
        body: { is_active: false },
        prefer: 'return=minimal',
      }).catch(() => {})
      return res.status(200).json({ ok: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
