// POST /api/admin/templates-steps?id=...
// Reads the template's nodes + edges and asks Claude Haiku to write a
// step-by-step setup guide for users who clone this template — what
// they need to fill in, in what order, on which node. Returns
// { steps: [{step, title, body, node_id, node_type}, …] } — caller
// reviews and saves via the standard PATCH so we don't auto-write.

import { setCors, requireAdmin, supaFetch } from '../_lib/supabase.js'
import { message as anthropicMessage } from '../_lib/anthropic.js'

// Compact, role-relevant snapshot of the workflow so Claude has the
// type + name + a hint at user-fillable props for each node, without
// the heavy fields (full scripts, nested data URLs, etc.).
function summarize(nodes, edges) {
  const safeNodes = (nodes || []).map((n) => {
    const id = n.id
    const type = n?.data?.type || n?.type || 'unknown'
    const name = n?.data?.name || ''
    const props = n?.data?.props || {}
    // Surface a few user-facing prop shapes per node so the model can
    // figure out what's blank vs. pre-filled.
    const slim = {}
    for (const k of [
      'avatar_id', 'look_id', 'voice_id', 'mode', 'cycle_looks',
      'prompt', 'model', 'aspect', 'count', 'quality',
      'platforms', 'when',
      'cadence', 'max_runs',
      'urls',
    ]) {
      const v = props[k]
      if (v === undefined || v === null || v === '') continue
      // Trim long strings so we don't ship the whole script in here.
      if (typeof v === 'string') slim[k] = v.length > 80 ? `${v.slice(0, 77)}…` : v
      else if (Array.isArray(v)) slim[k] = v.length
      else slim[k] = v
    }
    return { id, type, name, props: slim }
  })
  const safeEdges = (edges || []).map((e) => ({ from: e.source, to: e.target }))
  return { nodes: safeNodes, edges: safeEdges }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAdmin(req, res)
  if (!auth) return

  try {
    const id = req.query.id || req.body?.id
    if (!id) return res.status(400).json({ error: 'id required' })
    const rows = await supaFetch(`spaces?id=eq.${id}&is_template=eq.true&select=name,template_summary,nodes,edges,template_category`)
    const tpl = rows?.[0]
    if (!tpl) return res.status(404).json({ error: 'Template not found' })

    const slim = summarize(tpl.nodes, tpl.edges)
    const validIds = new Set(slim.nodes.map((n) => n.id))

    const out = await anthropicMessage({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: [
        'You write setup-step guides for ScaleSolo workflow templates. The user just cloned the template into their workspace and needs to know what to fill in to make it run.',
        '',
        'Output rules:',
        '• Return STRICT JSON, no preamble, no markdown fences. Shape: { "steps": [ { "title": "", "body": "", "node_id": "" }, ... ] }',
        '• 3 to 7 steps total. Skip nodes the user does not need to touch (collection, save_library, etc. are usually pre-wired).',
        '• Order steps by setup priority: brand profile / avatar pick first, then content (script_gen, image_gen prompts), then publishing settings (schedule_post platforms / cadence). Auto-run / runtime knobs last.',
        '• title: ≤ 60 chars, imperative form starting with a verb ("Pick your avatar", "Write your topic", "Choose platforms"). No "Step 1:" prefix.',
        '• body: 1-2 sentences (≤ 220 chars) telling the user EXACTLY what to do or fill in. Speak directly ("you", "your"). Plain text. No markdown, no em dashes (use commas, colons, sentence breaks).',
        '• node_id: copy verbatim from the workflow JSON below if the step refers to a specific node. Leave empty string if the step is generic.',
        '• Skip steps for plumbing the user has nothing to fill in. If every prop is already populated on a node, do not include a step for it.',
        '• Stay on the ScaleSolo brand voice: confident, practical, no fluff.',
        '',
        'Output: ONLY the JSON object. Nothing else.',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: `Template name: ${tpl.name || 'Untitled'}
${tpl.template_category ? `Category: ${tpl.template_category}` : ''}
${tpl.template_summary ? `Summary: ${tpl.template_summary}` : ''}

Workflow:
${JSON.stringify(slim, null, 2)}`,
        },
      ],
    })
    const raw = (out?.content || []).map((c) => c?.text || '').join('').trim()
    let parsed = null
    try {
      const cleaned = String(raw).replace(/```json\s*|```\s*/gi, '').trim()
      const m = cleaned.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(m ? m[0] : cleaned)
    } catch {
      return res.status(502).json({ error: 'Claude returned malformed JSON', raw: raw.slice(0, 500) })
    }
    const incoming = Array.isArray(parsed?.steps) ? parsed.steps : []
    if (!incoming.length) return res.status(502).json({ error: 'Claude returned no steps', raw: raw.slice(0, 500) })

    const steps = incoming
      .filter((s) => s && (s.title || s.body))
      .map((s, i) => {
        const node_id = s.node_id && validIds.has(s.node_id) ? s.node_id : null
        const node_type = node_id ? (slim.nodes.find((n) => n.id === node_id)?.type || null) : null
        return {
          step: i + 1,
          title: String(s.title || '').slice(0, 120),
          body: String(s.body || '').slice(0, 600),
          node_id,
          node_type,
        }
      })

    return res.status(200).json({ steps })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
