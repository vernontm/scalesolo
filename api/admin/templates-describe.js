// POST /api/admin/templates-describe?id=...
// Reads the template's nodes + edges + existing name and asks Claude
// Haiku to write a short, gallery-card-friendly summary describing
// what the workflow does. Returns { summary } — caller can review and
// either accept (PATCH the template) or regenerate. We deliberately
// don't auto-write to the row here; the admin should approve first.

import { setCors, requireAdmin, supaFetch } from '../_lib/supabase.js'
import { message as anthropicMessage } from '../_lib/anthropic.js'

// Strip the noisy bits (long text fields, URLs, base64 data) from each
// node so we send a compact structural description to Claude. The
// model needs to see node TYPES and how they're connected — not a
// 50KB script that lives on a script_gen node.
function summarizeNodes(nodes, edges) {
  const safeNodes = (nodes || []).map((n) => {
    const type = n?.data?.type || n?.type || 'unknown'
    const name = n?.data?.name || ''
    const props = n?.data?.props || {}
    // Whitelist a handful of fields per node so we surface intent
    // without leaking everything. The structural type carries most
    // of the meaning anyway.
    const slimProps = {}
    for (const k of ['cadence', 'platforms', 'aspect', 'model', 'count', 'when', 'mode']) {
      if (props[k] !== undefined && props[k] !== null && props[k] !== '') slimProps[k] = props[k]
    }
    return { id: n.id, type, name, props: slimProps }
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
    const rows = await supaFetch(`spaces?id=eq.${id}&is_template=eq.true&select=name,description,template_summary,nodes,edges,template_category`)
    const tpl = rows?.[0]
    if (!tpl) return res.status(404).json({ error: 'Template not found' })

    const slim = summarizeNodes(tpl.nodes, tpl.edges)
    const out = await anthropicMessage({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: [
        'You write short, punchy descriptions for ScaleSolo workflow templates. The description appears as the subtitle on a gallery card and below the title in the template picker, so it must:',
        '• Be 1 to 2 sentences. Maximum 220 characters.',
        '• Lead with the OUTCOME (what the user gets), not the implementation. "Daily AI podcast videos posted automatically" beats "Combines script_gen with avatar_render and schedule_post."',
        '• Plain text only. No markdown, no quotes, no preamble like "This template...". Start with a verb or a noun.',
        '• Stay on the ScaleSolo brand voice: confident, no fluff, no em dashes. Use commas, colons, or sentence breaks.',
        '',
        'Output: just the description, nothing else.',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: `Template name: ${tpl.name || 'Untitled'}
${tpl.template_category ? `Category: ${tpl.template_category}` : ''}
${tpl.description ? `Existing description (rewrite this for the gallery card): ${tpl.description}` : ''}

Workflow structure (node graph):
${JSON.stringify(slim, null, 2)}`,
        },
      ],
    })
    const summary = (out?.content || []).map((c) => c?.text || '').join('').trim()
    if (!summary) return res.status(502).json({ error: 'Claude returned no description' })
    return res.status(200).json({ summary: summary.slice(0, 600) })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
