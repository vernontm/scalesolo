// /api/insights — review queue for brand_bible_insights.
//
//   GET    ?profile_id=…&status=pending|approved|rejected (default pending)
//          List insights for a profile.
//
//   PATCH  body: { id, action: 'approve' | 'reject' }
//          On approve, merge the insight into the appropriate voice
//          training table:
//            hook_pattern        → brand_hooks (rating=1)
//            structural_beat     → brand_voice_summaries.liked_patterns append
//            vocabulary          → brand_voice_summaries.liked_patterns append
//            pacing              → brand_voice_summaries.liked_patterns append
//            cta_pattern         → brand_voice_summaries.liked_patterns append
//            adaptable_element   → brand_scripts (rating=1) using the example
//            conflict            → brand_voice_summaries.disliked_patterns append
//            audience_signal     → brand_voice_summaries.summary append
//          Status flips to 'applied' (or 'rejected') with applied_to
//          recording where the insight landed.
//
//   DELETE ?id=…
//          Drop a single insight row (does NOT undo a merge already
//          applied — that's a follow-up).

import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'

const TYPES_TO_HOOKS  = new Set(['hook_pattern'])
const TYPES_TO_SCRIPT = new Set(['adaptable_element'])
const TYPES_TO_DISLIKED = new Set(['conflict'])
const TYPES_TO_LIKED_PATTERNS = new Set([
  'structural_beat', 'vocabulary', 'pacing', 'cta_pattern', 'audience_signal',
])

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const profileId = req.query.profile_id
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)
      const status = req.query.status || 'pending'
      const rows = await supaFetch(
        `brand_bible_insights?profile_id=eq.${encodeURIComponent(profileId)}` +
        `&status=eq.${encodeURIComponent(status)}` +
        '&order=created_at.desc&limit=200&select=*'
      )
      return res.status(200).json({ insights: rows || [] })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`brand_bible_insights?id=eq.${encodeURIComponent(id)}&select=profile_id`)
      const pid = rows?.[0]?.profile_id
      if (!pid) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, pid)
      await supaFetch(`brand_bible_insights?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' })

    const { id, action } = req.body || {}
    if (!id || !action) return res.status(400).json({ error: 'id + action required' })
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be approve|reject' })

    const rows = await supaFetch(`brand_bible_insights?id=eq.${encodeURIComponent(id)}&select=*`)
    const insight = rows?.[0]
    if (!insight) return res.status(404).json({ error: 'Not found' })
    await assertProfileAccess(auth.user.id, insight.profile_id)

    if (action === 'reject') {
      const updated = await supaFetch(`brand_bible_insights?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { status: 'rejected', reviewed_at: new Date().toISOString() },
      })
      return res.status(200).json({ insight: Array.isArray(updated) ? updated[0] : updated })
    }

    // Approve → merge into the right voice-training table.
    const applied = {}
    const t = insight.insight_type
    const title = insight.title || ''
    const desc = insight.payload?.description || ''
    const example = insight.payload?.example || ''
    const fit = insight.payload?.fit || 'medium'

    if (TYPES_TO_HOOKS.has(t)) {
      const hookText = example || title
      if (hookText) {
        const created = await supaFetch('brand_hooks', {
          method: 'POST',
          body: {
            profile_id: insight.profile_id,
            hook: hookText.slice(0, 600),
            rating: 1,
            source: 'reference_video',
          },
        }).catch((e) => { console.warn('brand_hooks insert failed:', e?.message); return null })
        if (created?.[0]?.id) applied.brand_hook_id = created[0].id
      }
    } else if (TYPES_TO_SCRIPT.has(t)) {
      const scriptText = example || `${title}\n\n${desc}`.trim()
      if (scriptText) {
        const created = await supaFetch('brand_scripts', {
          method: 'POST',
          body: {
            profile_id: insight.profile_id,
            text: scriptText.slice(0, 4000),
            hook: title || null,
            notes: `From reference video. Fit: ${fit}.`,
            rating: 1,
            source: 'reference_video',
          },
        }).catch((e) => { console.warn('brand_scripts insert failed:', e?.message); return null })
        if (created?.[0]?.id) applied.brand_script_id = created[0].id
      }
    } else if (TYPES_TO_LIKED_PATTERNS.has(t) || TYPES_TO_DISLIKED.has(t)) {
      // Append to the active brand_voice_summaries row, or create a
      // skeleton one if no summary exists yet.
      const summaryRows = await supaFetch(
        `brand_voice_summaries?profile_id=eq.${encodeURIComponent(insight.profile_id)}&is_active=eq.true&order=created_at.desc&limit=1&select=*`
      ).catch(() => [])
      const cur = summaryRows?.[0]
      const bullet = `- [${t}] ${title}${desc ? `: ${desc}` : ''}${example ? ` (e.g. "${example.slice(0, 140)}")` : ''}`
      if (cur) {
        const targetField = TYPES_TO_DISLIKED.has(t) ? 'disliked_patterns' : 'liked_patterns'
        const merged = (cur[targetField] || '') + (cur[targetField] ? '\n' : '') + bullet
        await supaFetch(`brand_voice_summaries?id=eq.${cur.id}`, {
          method: 'PATCH',
          body: { [targetField]: merged.slice(0, 2000) },
          prefer: 'return=minimal',
        })
        applied.summary_id = cur.id
        applied.target_field = targetField
      } else {
        // No summary exists yet — seed one. The daily distill cron
        // will overwrite it next run with a real distillation; this
        // is just so the user's approval doesn't go to nowhere.
        const targetField = TYPES_TO_DISLIKED.has(t) ? 'disliked_patterns' : 'liked_patterns'
        const created = await supaFetch('brand_voice_summaries', {
          method: 'POST',
          body: {
            profile_id: insight.profile_id,
            summary: 'Seeded from approved reference-video insights.',
            [targetField]: bullet.slice(0, 2000),
            sample_size: 0,
            is_active: true,
          },
        }).catch((e) => { console.warn('brand_voice_summaries insert failed:', e?.message); return null })
        if (created?.[0]?.id) applied.summary_id = created[0].id
      }
    }

    const updated = await supaFetch(`brand_bible_insights?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: {
        status: 'applied',
        reviewed_at: new Date().toISOString(),
        applied_to: applied,
      },
    })
    return res.status(200).json({
      insight: Array.isArray(updated) ? updated[0] : updated,
      applied,
    })
  } catch (err) {
    console.error('insights error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
