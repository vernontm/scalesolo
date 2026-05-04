// POST /api/spaces/build
// Body: { profile_id, instruction, current_nodes?, current_edges? }
// Returns: { nodes, edges, suggestions? }
//
// Claude reads a description (e.g. "create scripts then turn them into avatar
// videos and save to library") and emits a complete reactflow-compatible node
// graph. We auto-layout positions if Claude doesn't supply good ones.
//
// Mirrors the client-side NODE_REGISTRY in src/lib/space-nodes.jsx — keep
// these in sync.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { message } from '../_lib/anthropic.js'

const NODE_CATALOG = {
  text_input: {
    label: 'Text',
    description: 'Holds raw text the user types in (a topic, hook, brief).',
    inputs: [],
    outputs: ['text'],
    initialProps: { text: '' },
  },
  image_upload: {
    label: 'Reference images',
    description: 'User-uploaded reference images (urls). Connect to image_gen "references" input to influence generation.',
    inputs: [],
    outputs: ['images'],
    initialProps: { urls: [] },
  },
  script_gen: {
    label: 'Script generator',
    description: 'Claude writes a script. Pick a format like tiktok-script, ig-post, thread, youtube-short, email-subject, blog-post. Topic supports @-mentions.',
    inputs: ['topic'],
    outputs: ['script', 'title'],
    initialProps: { format: 'tiktok-script', topic: '' },
  },
  caption_gen: {
    label: 'Caption + hashtags',
    description: 'Generates a platform caption AND hashtags from a script in one step. props: platform (instagram/tiktok/youtube/x/linkedin), hashtag_count (number).',
    inputs: ['script'],
    outputs: ['caption', 'hashtags'],
    initialProps: { platform: 'instagram', hashtag_count: 10 },
  },
  image_gen: {
    label: 'Image generator',
    description: 'KIE image generation. props: prompt (string, supports @-mentions), model (nano-banana/flux-pro/flux-kontext/gpt-image), aspect (1:1/16:9/9:16/4:3/3:4), count (1-8), quality (1K/2K/4K). Connect "references" from an image_upload or image_gen for image-to-image.',
    inputs: ['references', 'prompt'],
    outputs: ['images'],
    initialProps: { prompt: '', model: 'nano-banana', aspect: '1:1', count: 1, quality: '2K' },
  },
  avatar_picker: {
    label: 'Avatar',
    description: 'Selects a HeyGen avatar + optional look + voice. Required props: avatar_id, voice_id. Optional: look_id, model_version (v3/v4/v5).',
    inputs: [],
    outputs: ['avatar'],
    initialProps: { avatar_id: '', look_id: '', voice_id: '', model_version: '' },
  },
  avatar_render: {
    label: 'Avatar render',
    description: 'HeyGen renders the avatar speaking the script. Connect script + avatar.',
    inputs: ['script', 'avatar'],
    outputs: ['video'],
    initialProps: {},
  },
  collection: {
    label: 'Collection',
    description: 'Catches outputs from any connected node and gathers them into a list (scripts, images, videos, captions). Use to organize/keep multiple results.',
    inputs: ['items', 'more'],
    outputs: ['items'],
    initialProps: {},
  },
  save_library: {
    label: 'Save to library',
    description: 'Persist outputs as a content_scripts row. Connect any of: script, caption, hashtags, video, image.',
    inputs: ['script', 'caption', 'hashtags', 'video', 'image'],
    outputs: [],
    initialProps: { title: '', status: 'draft' },
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
      "sourceHandle": "<output handle name>",
      "target": "<node id>",
      "targetHandle": "<input handle name>"
    }
  ],
  "suggestions": "<one-sentence note to the user about anything they need to fill in (e.g. avatar selection, voice id) — optional>"
}

Available node types:
${nodeRegistryAsText()}

Rules:
- ONLY use the node types listed above.
- Always set every node's "type" to "space" — the actual logical type goes inside data.type.
- Every node needs a unique id (short like "n1", "n2", or "n_abc"). Edges reference those ids in source/target.
- sourceHandle MUST match an output name of the source node's data.type. targetHandle MUST match an input name of the target node's data.type.
- If the user mentions a specific topic / hook / format, set the corresponding props on text_input or script_gen.
- For avatar workflows, ALWAYS include an avatar_picker node connected to avatar_render's "avatar" input. Leave avatar_id, voice_id, etc. blank ("") unless the user provides them — they pick those in the UI.
- Always end with a save_library node when the workflow produces script/caption/hashtags/video.
- Position nodes left-to-right, top-to-bottom — set rough x/y coordinates (e.g. inputs at x=80, generators at x=460, terminals at x=840). The client will refine the layout.
- Output ONLY the JSON object — no commentary, no code fences.
- Never use em dashes anywhere. Use commas, periods, or restructured sentences.`

// Auto-layout: if Claude's positions are weird (overlapping, all at 0,0,
// or just sequential), recompute them via topological depth.
function autoLayout(nodes, edges) {
  if (!Array.isArray(nodes) || nodes.length === 0) return nodes
  // Build inDegree + outgoing
  const inDegree = new Map(nodes.map((n) => [n.id, 0]))
  const outgoing = new Map(nodes.map((n) => [n.id, []]))
  for (const e of edges) {
    if (!inDegree.has(e.target)) inDegree.set(e.target, 0)
    if (!outgoing.has(e.source)) outgoing.set(e.source, [])
    inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1)
    outgoing.get(e.source).push(e.target)
  }
  // Kahn's algorithm with depth tracking
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
  // Group by depth
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

    // Pre-flight credit check
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

    // Validate + sanitize nodes
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
        sourceHandle: e.sourceHandle || null,
        targetHandle: e.targetHandle || null,
        type: 'smoothstep',
        animated: true,
        markerEnd: { type: 'arrowclosed' },
        style: { stroke: '#ef4444', strokeWidth: 1.5 },
      }))

    // Auto-layout overrides Claude's positions for consistency.
    autoLayout(nodes, edges)

    // Meter credits (best-effort)
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
