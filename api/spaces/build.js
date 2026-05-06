// POST /api/spaces/build
// Body: { profile_id, instruction, current_nodes?, current_edges? }
// Returns: { nodes, edges, suggestions? }
//
// Claude reads a description and emits a node graph. Every node now has at
// most ONE input handle (id 'in'), with image_gen and avatar_render also
// exposing a 'ref' handle for reference media. Every node has ONE output
// handle (id 'out'). Edges connect 'out' → 'in' (or 'out' → 'ref').

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { message } from '../_lib/anthropic.js'

const NODE_CATALOG = {
  text_input: {
    label: 'Text',
    description: 'Holds raw text the user types in (a topic, hook, brief).',
    inputs: [],
    outputs: ['out'],
    initialProps: { text: '' },
  },
  image_upload: {
    label: 'Reference images',
    description: 'User-uploaded reference images. Wire its "out" into image_gen "ref" for image-to-image generation.',
    inputs: [],
    outputs: ['out'],
    initialProps: { urls: [] },
  },
  auto_run: {
    label: 'Auto-run',
    description: 'Recurring trigger node. Re-runs everything connected downstream on a fixed cadence while the canvas is open. props: cadence ("1m" | "5m" | "15m" | "30m" | "1h" | "6h" | "24h"), max_runs (number, defaults to 10), active (boolean, defaults to false). Place this at the start of any chain you want to fire automatically. Distinct from social media scheduling — that\'s the save_library platforms field.',
    inputs: [],
    outputs: ['out'],
    initialProps: { cadence: '15m', max_runs: 10, runs_used: 0, active: false, last_run_at: null },
  },
  brand_profile: {
    label: 'Brand profile',
    description: 'Pulls in a saved brand profile (voice, audience, brand bible, hashtags). Wire its "out" into any generator\'s "in" to keep generations on-brand. Props: profile_id (leave blank for the user to pick), sync_all (boolean — when true, the client auto-wires this brand to every script_gen/caption_gen/image_gen now and as new ones are added; do NOT add manual brand edges yourself when sync_all is true).',
    inputs: [],
    outputs: ['out'],
    initialProps: { profile_id: '', sync_all: false },
  },
  avatar_picker: {
    label: 'Avatar',
    description: 'Selects a HeyGen avatar + optional look + voice. Wire its "out" into avatar_render "in".',
    inputs: [],
    outputs: ['out'],
    initialProps: { avatar_id: '', look_id: '', voice_id: '', model_version: '' },
  },
  script_gen: {
    label: 'Script generator',
    description: 'Claude writes a script. props: format (tiktok-script | ig-post | thread | youtube-short | email-subject | blog-post), topic (string, supports @-mentions). The single "in" handle accepts upstream text (topic) and/or a brand profile.',
    inputs: ['in'],
    outputs: ['out'],
    initialProps: { format: 'tiktok-script', topic: '' },
  },
  caption_gen: {
    label: 'Caption + hashtags',
    description: 'Generates a platform caption AND hashtags from a script in one step. props: platform (instagram/tiktok/youtube/x/linkedin), hashtag_count (number). The "in" handle accepts the upstream script and an optional brand profile.',
    inputs: ['in'],
    outputs: ['out'],
    initialProps: { platform: 'instagram', hashtag_count: 10 },
  },
  image_gen: {
    label: 'Image generator',
    description: 'KIE image generation. props: prompt (string, supports @-mentions), model (nano-banana-2 | nano-banana-pro | gpt-2), aspect (1:1/16:9/9:16/4:3/3:4), count (1-8), quality (1K/2K/4K). The single "in" handle accepts brand context, prompts, AND reference images (image_upload or another image_gen out) — they\'re sorted by data shape.',
    inputs: ['in'],
    outputs: ['out'],
    initialProps: { prompt: '', model: 'nano-banana-2', aspect: '1:1', count: 1, quality: '2K' },
  },
  avatar_render: {
    label: 'Avatar render',
    description: 'HeyGen renders the avatar speaking the script. Wire BOTH the script_gen and the avatar_picker "out" into this node\'s "in" handle (multiple connections to a single handle are allowed and sorted by shape).',
    inputs: ['in'],
    outputs: ['out'],
    initialProps: {},
  },
  collection: {
    label: 'Collection',
    description: 'Catches outputs from any connected node and gathers them into a growing list. Accumulates across runs (deduped by URL/text). Use as a final aggregator for scripts, images, or videos.',
    inputs: ['in'],
    outputs: ['out'],
    initialProps: {},
  },
  save_library: {
    label: 'Save to library',
    description: 'Bundles the incoming script + caption + hashtags + media into a single library entry, tagged with the platforms it should be scheduled for. props: title (optional, auto-derives from script), status (draft|caption_ready|scheduled), platforms (array of strings — any of: instagram, tiktok, youtube, x, threads, linkedin, facebook). The single "in" handle accepts script, caption + hashtags, image(s), or video; the node figures out the post type. For an image+caption Instagram post, set platforms=["instagram"]; for a TikTok video, ["tiktok"]; for a thread/X text post, ["threads","x"]. If unsure, leave platforms empty and the user picks in the UI.',
    inputs: ['in'],
    outputs: [],
    initialProps: { title: '', status: 'draft', platforms: [] },
  },
}

const VALID_TYPES = new Set(Object.keys(NODE_CATALOG))

function nodeRegistryAsText() {
  return Object.entries(NODE_CATALOG).map(([key, def]) => {
    const ins = def.inputs.length ? def.inputs.join(', ') : '(none)'
    const outs = def.outputs.length ? def.outputs.join(', ') : '(none)'
    return `- ${key}: ${def.label}. inputs: [${ins}]. outputs: [${outs}]. ${def.description}`
  }).join('\n')
}

const SYSTEM = `You are a workflow designer for ScaleSolo's node-based content canvas. Given a brief, return a JSON object:

{
  "nodes": [
    {
      "id": "<short-unique-id>",
      "type": "space",
      "position": { "x": <int>, "y": <int> },
      "data": {
        "type": "<one of the registered node types>",
        "props": { ...initialProps with any user-described overrides... },
        "status": "idle",
        "output": null,
        "error": null
      }
    }
  ],
  "edges": [
    {
      "id": "<short-unique-id>",
      "source": "<node id>",
      "sourceHandle": "out",
      "target": "<node id>",
      "targetHandle": "in"
    }
  ],
  "suggestions": "<one-sentence note to the user about anything they need to fill in (e.g. avatar selection, voice id) — optional>"
}

Available node types:
${nodeRegistryAsText()}

Rules:
- ONLY use the node types listed above.
- Every node's "type" MUST be exactly "space" — the actual logical type goes inside data.type.
- Every node needs a unique id (short like "n1", "n2", or "n_abc"). Edges reference those ids in source/target.
- sourceHandle MUST always be "out". targetHandle MUST always be "in".
- Multiple edges may target the SAME "in" handle on a node; the runtime aggregates them by content shape. So wire BOTH a script and an avatar into avatar_render's single "in" handle.
- For brand_profile: if the user wants the entire workflow on one brand, set sync_all=true and DO NOT add manual brand edges — the client wires them automatically. Otherwise add explicit "out" → "in" edges to the generators that should receive the brand.
- For avatar workflows ALWAYS include an avatar_picker connected to avatar_render's "in". Leave avatar_id, voice_id, etc. blank ("") unless the user provides them.
- Always end pipelines that produce shareable assets with either a save_library or a collection.
- Position nodes left-to-right by depth (inputs at x≈80, generators at x≈460, terminals at x≈840). The client will refine the layout.
- Output ONLY the JSON object — no commentary, no code fences.
- Never use em dashes anywhere. Use commas, periods, or restructured sentences.`

// Auto-layout: if Claude's positions are weird, recompute them via topo depth.
function autoLayout(nodes, edges) {
  if (!Array.isArray(nodes) || nodes.length === 0) return nodes
  const inDegree = new Map(nodes.map((n) => [n.id, 0]))
  const outgoing = new Map(nodes.map((n) => [n.id, []]))
  for (const e of edges) {
    if (!inDegree.has(e.target)) inDegree.set(e.target, 0)
    if (!outgoing.has(e.source)) outgoing.set(e.source, [])
    inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1)
    outgoing.get(e.source).push(e.target)
  }
  const depth = new Map()
  const queue = nodes.filter((n) => (inDegree.get(n.id) || 0) === 0)
  for (const n of queue) depth.set(n.id, 0)
  while (queue.length) {
    const n = queue.shift()
    const d = depth.get(n.id) ?? 0
    for (const tid of outgoing.get(n.id) || []) {
      const next = (inDegree.get(tid) || 0) - 1
      inDegree.set(tid, next)
      depth.set(tid, Math.max(depth.get(tid) ?? 0, d + 1))
      if (next === 0) queue.push(nodes.find((x) => x.id === tid))
    }
  }
  const byDepth = new Map()
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0
    if (!byDepth.has(d)) byDepth.set(d, [])
    byDepth.get(d).push(n)
  }
  const COL_W = 360
  const ROW_H = 240
  for (const [d, group] of byDepth) {
    const totalH = (group.length - 1) * ROW_H
    group.forEach((n, i) => {
      n.position = { x: 80 + d * COL_W, y: 100 + i * ROW_H - totalH / 2 + 200 }
    })
  }
  return nodes
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, instruction, current_nodes, current_edges } = req.body || {}
    if (!profile_id || !instruction) return res.status(400).json({ error: 'profile_id + instruction required' })
    await assertProfileAccess(auth.user.id, profile_id)

    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
    const customerId = cust?.[0]?.id
    if (customerId) {
      const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`)
      if ((Number(pools?.[0]?.balance ?? 0)) < 1500) {
        return res.status(402).json({ error: 'Insufficient AI tokens. Top up to continue.', code: 'insufficient_credits' })
      }
    }

    const profRows = await supaFetch(`profiles?id=eq.${profile_id}&select=business_name,brand_bible,target_audience,preferred_tone`)
    const profile = profRows?.[0] || {}

    const userPrompt = [
      `Brand context (use sparingly, only if relevant):`,
      profile.business_name ? `Brand: ${profile.business_name}` : '',
      profile.preferred_tone ? `Voice: ${profile.preferred_tone}` : '',
      profile.target_audience ? `Audience: ${profile.target_audience}` : '',
      '',
      current_nodes && current_nodes.length
        ? `Current workflow has ${current_nodes.length} nodes. Modify/extend it based on the instruction.`
        : 'The canvas is empty — design the workflow from scratch.',
      '',
      `Instruction:`,
      instruction.trim(),
    ].filter(Boolean).join('\n')

    const resp = await message({
      system: SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 3500,
    })
    const text = resp?.content?.[0]?.text || ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)?.[0]
    if (!jsonMatch) return res.status(502).json({ error: 'AI returned non-JSON', raw: text.slice(0, 800) })
    let parsed
    try { parsed = JSON.parse(jsonMatch) } catch (e) {
      return res.status(502).json({ error: 'AI returned invalid JSON', raw: text.slice(0, 800) })
    }

    const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : [])
      .filter((n) => n && n.data && VALID_TYPES.has(n.data.type))
      .map((n) => {
        const def = NODE_CATALOG[n.data.type]
        return {
          id: n.id || `n_${Math.random().toString(36).slice(2, 8)}`,
          type: 'space',
          position: n.position && Number.isFinite(n.position.x) && Number.isFinite(n.position.y)
            ? n.position : { x: 0, y: 0 },
          data: {
            type: n.data.type,
            props: { ...(def.initialProps || {}), ...(n.data.props || {}) },
            status: 'idle',
            output: null,
            error: null,
          },
        }
      })

    if (nodes.length === 0) return res.status(502).json({ error: 'AI returned no valid nodes', raw: text.slice(0, 800) })

    const validIds = new Set(nodes.map((n) => n.id))
    const edges = (Array.isArray(parsed.edges) ? parsed.edges : [])
      .filter((e) => e && validIds.has(e.source) && validIds.has(e.target))
      .map((e) => ({
        id: e.id || `e_${Math.random().toString(36).slice(2, 8)}`,
        source: e.source,
        target: e.target,
        // Force the simplified handle scheme regardless of what the model returns.
        sourceHandle: 'out',
        targetHandle: 'in',
        type: 'smoothstep',
        animated: true,
        markerEnd: { type: 'arrowclosed' },
        style: { stroke: '#ef4444', strokeWidth: 1.5 },
      }))

    autoLayout(nodes, edges)

    if (customerId && resp.usage) {
      const total = (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0)
      if (total > 0) {
        try {
          await supaFetch('rpc/consume_credits', {
            method: 'POST',
            body: {
              p_customer_id: customerId,
              p_pool_type: 'ai_tokens',
              p_amount: total,
              p_action: 'consume:space-build',
              p_profile_id: profile_id,
              p_metadata: { instruction: instruction.slice(0, 200), node_count: nodes.length },
            },
          })
        } catch {}
      }
    }

    return res.status(200).json({
      nodes,
      edges,
      suggestions: typeof parsed.suggestions === 'string' ? parsed.suggestions : null,
      usage: resp.usage,
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
