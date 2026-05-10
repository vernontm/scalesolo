// Cron: distill brand voice from the prior 24h of brand_scripts /
// brand_hooks ratings into a compact summary, written to
// brand_voice_summaries (Phase 2 of brand voice training).
//
// Why this exists: brand_scripts and brand_hooks already few-shot the
// generation prompt with explicit liked/disliked rows, but the model
// has to re-derive the underlying patterns every call. A distilled
// natural-language summary lets the model apply the *abstraction*
// (e.g. "owner prefers second-person openers and rejects rhetorical
// questions") instead of re-pattern-matching every time. It also
// compounds: the summary written today incorporates everything the
// owner has approved/rejected up to today.
//
// Schedule: 0 6 * * * (daily 6am UTC) via vercel.json crons.
// Auth: CRON_SECRET bearer.

import { setCors, supaFetch } from '../_lib/supabase.js'
import { message } from '../_lib/anthropic.js'

const WINDOW_HOURS = 24
const MAX_PROFILES_PER_RUN = 200
const MAX_SAMPLE = 30  // most-recent rated rows per profile fed to the model

const SYSTEM = `You are a brand voice analyst. Given a brand's recently
approved (rating=1) and rejected (rating=-1) scripts and hooks, write a
compact playbook that captures the underlying patterns the brand owner
keeps approving vs rejecting. The playbook will be injected into a
content-generation system prompt to guide future writing.

Be specific and observational, not generic. Call out:
- Voice attributes (sentence length, energy, perspective, formality)
- Opener archetypes the owner approves and rejects
- Recurring themes / topics that landed vs flopped
- Words, phrases, or rhetorical moves to avoid

Avoid platitudes ("write engagingly"). Quote specific phrases when useful.
Output strict JSON with this shape:
{
  "summary": "<3-6 sentence playbook, second person to the writer>",
  "liked_patterns": "<bullet list as a single string with \\n separators, max 6 bullets>",
  "disliked_patterns": "<bullet list as a single string with \\n separators, max 6 bullets>"
}
If signal is too weak (fewer than 3 rated items total), return:
{ "summary": "", "liked_patterns": "", "disliked_patterns": "" }`

function jsonExtract(text) {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(body.slice(start, end + 1)) } catch { return null }
}

async function distillForProfile(profileId) {
  // Pull the freshest rated assets — both directions, capped. We pull
  // ALL rated rows (not just last 24h) because the summary is meant to
  // be cumulative; the cron only fires for profiles that had *new*
  // activity in the window, but the distillation considers full history.
  const [liked, disliked, likedHooks, dislikedHooks] = await Promise.all([
    supaFetch(
      `brand_scripts?profile_id=eq.${profileId}&rating=eq.1&order=created_at.desc&limit=${MAX_SAMPLE}&select=text,hook,format,notes`
    ).catch(() => []),
    supaFetch(
      `brand_scripts?profile_id=eq.${profileId}&rating=eq.-1&order=created_at.desc&limit=${MAX_SAMPLE}&select=text,notes`
    ).catch(() => []),
    supaFetch(
      `brand_hooks?profile_id=eq.${profileId}&rating=eq.1&order=created_at.desc&limit=${MAX_SAMPLE}&select=hook`
    ).catch(() => []),
    supaFetch(
      `brand_hooks?profile_id=eq.${profileId}&rating=eq.-1&order=created_at.desc&limit=${MAX_SAMPLE}&select=hook`
    ).catch(() => []),
  ])

  const sample = (liked?.length || 0) + (disliked?.length || 0) + (likedHooks?.length || 0) + (dislikedHooks?.length || 0)
  if (sample < 3) return { skipped: 'too-few-samples', sample }

  const truncate = (s, n) => String(s || '').slice(0, n).replace(/\s+/g, ' ').trim()
  const blocks = []
  if (liked?.length) blocks.push(`APPROVED SCRIPTS:\n${liked.map((r, i) => `${i + 1}. ${truncate(r.text, 500)}${r.notes ? `\n   note: ${truncate(r.notes, 200)}` : ''}`).join('\n\n')}`)
  if (disliked?.length) blocks.push(`REJECTED SCRIPTS:\n${disliked.map((r, i) => `${i + 1}. ${truncate(r.text, 400)}${r.notes ? `\n   note: ${truncate(r.notes, 200)}` : ''}`).join('\n\n')}`)
  if (likedHooks?.length) blocks.push(`APPROVED HOOKS:\n${likedHooks.map((r, i) => `${i + 1}. ${truncate(r.hook, 200)}`).join('\n')}`)
  if (dislikedHooks?.length) blocks.push(`REJECTED HOOKS:\n${dislikedHooks.map((r, i) => `${i + 1}. ${truncate(r.hook, 200)}`).join('\n')}`)
  const userMsg = blocks.join('\n\n---\n\n')

  const resp = await message({
    system: SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
    max_tokens: 800,
  })
  const raw = resp?.content?.[0]?.text || ''
  const parsed = jsonExtract(raw) || { summary: '', liked_patterns: '', disliked_patterns: '' }
  if (!parsed.summary) return { skipped: 'empty-summary', sample }

  // Mark previous active rows inactive, then insert the new one. Two
  // round-trips, both no-ops on an empty history. supaFetch hits the
  // service role.
  await supaFetch(`brand_voice_summaries?profile_id=eq.${profileId}&is_active=eq.true`, {
    method: 'PATCH',
    body: { is_active: false },
    prefer: 'return=minimal',
  }).catch(() => {})
  await supaFetch('brand_voice_summaries', {
    method: 'POST',
    body: {
      profile_id: profileId,
      summary: parsed.summary,
      liked_patterns: parsed.liked_patterns || null,
      disliked_patterns: parsed.disliked_patterns || null,
      sample_size: sample,
      is_active: true,
    },
    prefer: 'return=minimal',
  }).catch(() => {})
  return { sample, written: true }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || !bearer || bearer !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const sinceIso = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString()

    // Find profiles with new feedback in the window. Two queries,
    // unioned in JS, then deduped.
    const [scriptHits, hookHits] = await Promise.all([
      supaFetch(
        `brand_scripts?or=(updated_at.gte.${encodeURIComponent(sinceIso)},created_at.gte.${encodeURIComponent(sinceIso)})&select=profile_id&limit=1000`
      ).catch(() => []),
      supaFetch(
        `brand_hooks?created_at=gte.${encodeURIComponent(sinceIso)}&select=profile_id&limit=1000`
      ).catch(() => []),
    ])
    const profileIds = Array.from(new Set([
      ...(scriptHits || []).map((r) => r.profile_id),
      ...(hookHits || []).map((r) => r.profile_id),
    ].filter(Boolean))).slice(0, MAX_PROFILES_PER_RUN)

    const results = { profiles: profileIds.length, written: 0, skipped: 0, errors: 0 }
    for (const pid of profileIds) {
      try {
        const out = await distillForProfile(pid)
        if (out.written) results.written += 1
        else results.skipped += 1
      } catch (e) {
        console.warn('[distill-brand-voice] profile', pid, 'failed:', e?.message)
        results.errors += 1
      }
    }
    return res.status(200).json({ ok: true, ...results })
  } catch (err) {
    console.error('[distill-brand-voice] fatal:', err)
    return res.status(500).json({ error: err.message })
  }
}
