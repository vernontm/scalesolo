// POST /api/walkthroughs/create
// Body: { profile_id, topic, avatar_ref, voice_id?, aspect_ratio? }
// Returns: { id, script, status }
//
// Streamlined AI Walkthrough builder, step 1: Claude writes a short,
// segmented talking-head script in the brand's voice (a hook, 2 to 4
// teaching points, and a CTA), and we persist a walkthrough_videos row in
// status 'scripted'. Generation + render happen later via
// /api/walkthroughs/generate. Scripting is a cheap text call, not
// credit-gated (the paid steps are the avatar + render).

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { message as anthropicMessage } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'

async function writeScript({ topic, brandMd }) {
  const out = await anthropicMessage({
    model: 'claude-sonnet-5',
    max_tokens: 2000,
    system: [
      'You script short-form TALKING-HEAD walkthrough videos (30 to 60 seconds) for a brand creator to read to camera.',
      'Return ONLY valid JSON, no preamble, matching exactly:',
      '{ "title": string, "hook": string, "cta": string, "segments": [ { "kind": "intro"|"point"|"cta", "heading": string, "narration": string } ] }',
      '',
      'Structure: 1 "intro" segment (the hook), 2 to 4 "point" segments (each teaches ONE idea), 1 "cta" segment.',
      'narration: the EXACT words the creator says for that segment, first person, natural spoken rhythm. Intro ~12 to 22 words, each point ~15 to 30 words, cta ~10 to 18 words. Total under ~150 words so it fits 60 seconds.',
      'heading: a 2 to 5 word on-screen title for that segment (what the animated scene shows).',
      'hook: the single opening line (same as the intro narration). cta: the closing spoken line.',
      'Sound like the brand talking to its audience, not an ad read. Concrete and useful. NO em dashes anywhere: use periods, commas, or "to" for ranges.',
      brandMd ? `\nBrand context:\n${brandMd}` : '',
    ].filter(Boolean).join('\n'),
    messages: [{ role: 'user', content: `Topic: ${topic}` }],
  })
  let text = (out?.content || []).map((c) => c?.text || '').join('').trim()
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const start = text.indexOf('{'); const end = text.lastIndexOf('}') + 1
  if (start < 0 || end <= start) throw new Error('Scriptwriter returned no JSON')
  let plan
  try { plan = JSON.parse(text.slice(start, end)) }
  catch {
    try { plan = JSON.parse(text.slice(start, end).replace(/,(\s*[}\]])/g, '$1')) }
    catch { throw new Error('Could not parse the script. Try again.') }
  }
  const segments = (Array.isArray(plan?.segments) ? plan.segments : [])
    .filter((s) => s && s.narration)
    .map((s, i) => ({
      id: `seg-${i + 1}`,
      kind: ['intro', 'point', 'cta'].includes(s.kind) ? s.kind : 'point',
      heading: String(s.heading || '').slice(0, 80),
      narration: String(s.narration || '').slice(0, 600),
    }))
  if (!segments.length) throw new Error('Scriptwriter returned no segments')
  const full_text = segments.map((s) => s.narration).join(' ')
  return {
    title: String(plan.title || topic).slice(0, 120),
    hook: String(plan.hook || segments[0]?.narration || '').slice(0, 300),
    cta: String(plan.cta || '').slice(0, 300),
    full_text,
    segments,
  }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    const { profile_id, topic, avatar_ref, voice_id, aspect_ratio = '9:16' } = req.body || {}
    if (!profile_id || !topic) return res.status(400).json({ error: 'profile_id + topic required' })
    await assertProfileAccess(auth.user.id, profile_id)

    let brandMd = ''
    try { brandMd = renderBrandContextMarkdown(await loadBrandContext(profile_id), { exclude: ['exemplars'] }) } catch { /* brandless */ }

    const script = await writeScript({ topic: String(topic).trim(), brandMd })

    const inserted = await supaFetch('walkthrough_videos', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        profile_id,
        user_id: auth.user.id,
        topic: String(topic).trim(),
        title: script.title,
        avatar_ref: avatar_ref && typeof avatar_ref === 'object' ? avatar_ref : {},
        voice_id: voice_id || null,
        aspect_ratio: ['16:9', '9:16', '1:1'].includes(aspect_ratio) ? aspect_ratio : '9:16',
        script,
        status: 'scripted',
      },
    })
    const row = Array.isArray(inserted) ? inserted[0] : inserted
    return res.status(200).json({ id: row?.id || null, title: script.title, script, status: 'scripted' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
