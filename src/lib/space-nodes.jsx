// Space node registry — defines every node type the canvas can render and
// run. Each node:
//   - has a `category` for the palette sidebar
//   - declares `inputs` (handles on the left) + `outputs` (handles on the right)
//   - has a `Component` that renders the body of the node card
//   - has a `run({ ctx, inputs })` async function that calls the right API
//     endpoint and returns an output object whose keys match `outputs`.
//
// The Spaces canvas builds a topological run order based on the edges, then
// invokes each node's `run` in sequence, threading outputs through.

import { useState } from 'react'
import {
  Type, Wand2, Captions, Hash, UserCircle2, Save, Image as ImageIcon,
  ListChecks, FileVideo, Mic,
} from 'lucide-react'

// ── shared style helpers for node bodies ────────────────────────────────────
const fieldRow = { marginBottom: 8 }
const labelStyle = {
  fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)',
  marginBottom: 4, display: 'block',
}
const tinyInput = {
  width: '100%', padding: '7px 9px',
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  borderRadius: 6, color: 'var(--text)', fontSize: 12,
  outline: 'none',
}
const previewBox = {
  marginTop: 8, padding: 8,
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  borderRadius: 6, fontSize: 11.5,
  color: 'var(--text-soft)',
  maxHeight: 110, overflow: 'auto', lineHeight: 1.4,
  whiteSpace: 'pre-wrap',
}

function NodeField({ label, children }) {
  return (
    <div style={fieldRow}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  )
}

function NodePreview({ status, output, error }) {
  if (status === 'running') return <div style={{ ...previewBox, color: 'var(--red)' }}><span className="spinner" style={{ width: 10, height: 10, display: 'inline-block', verticalAlign: '-1px', marginRight: 6 }} /> Running…</div>
  if (status === 'failed')  return <div style={{ ...previewBox, color: 'var(--red)' }}>{String(error || 'Failed')}</div>
  if (status === 'done' && output) {
    const text = typeof output === 'string'
      ? output
      : output.video_url ? `→ ${output.video_url}`
      : Object.entries(output).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')
    return <div style={previewBox}>{text.slice(0, 600)}{text.length > 600 ? '…' : ''}</div>
  }
  return null
}

// Helper: read an input value from the merged inputs object, falling back
// to the node's own props.
function readInput(inputs, props, key) {
  const v = inputs?.[key]
  return (v == null || v === '') ? (props?.[key] ?? '') : v
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. TEXT INPUT — pure source node, holds raw text.
function TextInputBody({ data, onPatch }) {
  return (
    <>
      <NodeField label="Content">
        <textarea
          style={{ ...tinyInput, minHeight: 70, fontFamily: 'inherit' }}
          placeholder="Topic, hook, or full text…"
          value={data.props?.text || ''}
          onChange={(e) => onPatch({ text: e.target.value })}
        />
      </NodeField>
      <NodePreview status={data.status} output={data.output} error={data.error} />
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. SCRIPT GENERATOR — Claude generates a script from a topic/brief.
function ScriptGenBody({ data, onPatch }) {
  return (
    <>
      <NodeField label="Format">
        <select
          style={tinyInput}
          value={data.props?.format || 'tiktok-script'}
          onChange={(e) => onPatch({ format: e.target.value })}
        >
          <option value="tiktok-script">TikTok script</option>
          <option value="ig-post">Instagram post</option>
          <option value="thread">Threads / X</option>
          <option value="youtube-short">YouTube Short</option>
          <option value="email-subject">Email subjects</option>
          <option value="blog-post">Blog post</option>
        </select>
      </NodeField>
      <NodeField label="Topic (optional, falls back to input)">
        <input
          style={tinyInput}
          placeholder="e.g. AI replaces $300/mo SaaS stack"
          value={data.props?.topic || ''}
          onChange={(e) => onPatch({ topic: e.target.value })}
        />
      </NodeField>
      <NodePreview status={data.status} output={data.output} error={data.error} />
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. CAPTION GENERATOR — Claude generates a caption + hashtags from a script.
function CaptionGenBody({ data }) {
  return <NodePreview status={data.status} output={data.output} error={data.error} />
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. HASHTAG GENERATOR
function HashtagGenBody({ data, onPatch }) {
  return (
    <>
      <NodeField label="Count">
        <input
          type="number"
          style={tinyInput}
          min={3} max={30}
          value={data.props?.count || 10}
          onChange={(e) => onPatch({ count: Number(e.target.value) })}
        />
      </NodeField>
      <NodePreview status={data.status} output={data.output} error={data.error} />
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. AVATAR PICKER — selects an avatar + look + voice from the active profile
function AvatarPickerBody({ data, onPatch, ctx }) {
  const avatars = ctx?.avatars || []
  const looks = avatars.find((a) => a.id === data.props?.avatar_id)?.looks || []
  return (
    <>
      <NodeField label="Avatar">
        <select
          style={tinyInput}
          value={data.props?.avatar_id || ''}
          onChange={(e) => onPatch({ avatar_id: e.target.value, look_id: '' })}
        >
          <option value="">Pick an avatar…</option>
          {avatars.map((a) => (
            <option key={a.id} value={a.id}>{a.name} ({(a.model_version || 'v4').toUpperCase()})</option>
          ))}
        </select>
      </NodeField>
      {looks.length > 1 && (
        <NodeField label="Look (optional)">
          <select
            style={tinyInput}
            value={data.props?.look_id || ''}
            onChange={(e) => onPatch({ look_id: e.target.value })}
          >
            <option value="">Default</option>
            {looks.map((l) => <option key={l.id} value={l.id}>Look {l.angle_order ?? ''}</option>)}
          </select>
        </NodeField>
      )}
      <NodeField label="Voice ID (ElevenLabs)">
        <input
          style={tinyInput}
          placeholder="21m00Tcm4TlvDq8ikWAM"
          value={data.props?.voice_id || ''}
          onChange={(e) => onPatch({ voice_id: e.target.value })}
        />
      </NodeField>
      <NodeField label="Model">
        <select
          style={tinyInput}
          value={data.props?.model_version || ''}
          onChange={(e) => onPatch({ model_version: e.target.value })}
        >
          <option value="">Avatar default</option>
          <option value="v3">V3 — Standard</option>
          <option value="v4">V4 — Pro</option>
          <option value="v5">V5 — Cinematic</option>
        </select>
      </NodeField>
      <NodePreview status={data.status} output={data.output} error={data.error} />
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. AVATAR RENDER — submits to HeyGen, returns video URL when done
function AvatarRenderBody({ data }) {
  const out = data.output
  return (
    <>
      {data.status !== 'done' && data.status !== 'failed' && data.status !== 'running' &&
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Connect a script + avatar input.</div>}
      {data.status === 'done' && out?.video_url && (
        <div style={{ marginTop: 6 }}>
          <video src={out.video_url} controls style={{ width: '100%', borderRadius: 6, background: '#000', maxHeight: 200 }} />
          <a href={out.video_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--red)', display: 'block', marginTop: 4 }}>Open ↗</a>
        </div>
      )}
      <NodePreview status={data.status} output={out?.video_url ? null : out} error={data.error} />
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. SAVE TO LIBRARY — persists to content_scripts
function SaveBody({ data, onPatch }) {
  return (
    <>
      <NodeField label="Title (optional)">
        <input
          style={tinyInput}
          placeholder="Auto-derived from script"
          value={data.props?.title || ''}
          onChange={(e) => onPatch({ title: e.target.value })}
        />
      </NodeField>
      <NodeField label="Status">
        <select
          style={tinyInput}
          value={data.props?.status || 'draft'}
          onChange={(e) => onPatch({ status: e.target.value })}
        >
          <option value="draft">Draft</option>
          <option value="caption_ready">Caption ready</option>
          <option value="scheduled">Scheduled (set datetime)</option>
        </select>
      </NodeField>
      <NodePreview status={data.status} output={data.output} error={data.error} />
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY — every type the palette + canvas can render

export const NODE_REGISTRY = {
  text_input: {
    label: 'Text input',
    description: 'Topic, hook, or any raw text.',
    icon: Type,
    category: 'inputs',
    color: '#94a3b8',
    inputs: [],
    outputs: [{ id: 'text', label: 'Text' }],
    initialProps: { text: '' },
    Body: TextInputBody,
    run: async ({ data }) => ({ text: data.props?.text || '' }),
  },

  script_gen: {
    label: 'Script generator',
    description: 'Claude writes a script from a topic.',
    icon: Wand2,
    category: 'generators',
    color: '#ef4444',
    inputs: [{ id: 'topic', label: 'Topic / hook' }],
    outputs: [{ id: 'script', label: 'Script' }, { id: 'title', label: 'Title' }],
    initialProps: { format: 'tiktok-script', topic: '' },
    Body: ScriptGenBody,
    run: async ({ data, inputs, ctx }) => {
      const topic = readInput(inputs, data.props, 'topic') || readInput(inputs, data.props, 'text')
      if (!topic) throw new Error('No topic / text provided')
      const r = await fetch('/api/content/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: ctx.profileId,
          format: data.props?.format || 'tiktok-script',
          topic,
          count: 1,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      const item = body.items?.[0]
      if (!item) throw new Error('No item returned')
      return { script: item.full_script || '', title: item.title || '', _content_id: item.id }
    },
  },

  caption_gen: {
    label: 'Caption generator',
    description: 'Caption + hashtags from a script.',
    icon: Captions,
    category: 'generators',
    color: '#f59e0b',
    inputs: [{ id: 'script', label: 'Script' }],
    outputs: [{ id: 'caption', label: 'Caption' }, { id: 'hashtags', label: 'Hashtags' }],
    initialProps: {},
    Body: CaptionGenBody,
    run: async ({ inputs, ctx }) => {
      const script = readInput(inputs, {}, 'script') || readInput(inputs, {}, 'text')
      if (!script) throw new Error('No script provided')
      const r = await fetch('/api/content/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: ctx.profileId,
          format: 'ig-post',
          topic: `Write the post caption + hashtags for this script: """${script.slice(0, 1500)}"""`,
          count: 1,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      const item = body.items?.[0]
      return { caption: item?.caption || item?.full_script || '', hashtags: item?.hashtags || '' }
    },
  },

  hashtag_gen: {
    label: 'Hashtag generator',
    description: 'A clean hashtag block from any input.',
    icon: Hash,
    category: 'generators',
    color: '#a78bfa',
    inputs: [{ id: 'topic', label: 'Topic / script' }],
    outputs: [{ id: 'hashtags', label: 'Hashtags' }],
    initialProps: { count: 10 },
    Body: HashtagGenBody,
    run: async ({ data, inputs, ctx }) => {
      const topic = readInput(inputs, data.props, 'topic') || readInput(inputs, {}, 'script') || readInput(inputs, {}, 'text')
      if (!topic) throw new Error('No topic provided')
      const r = await fetch('/api/content/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: ctx.profileId,
          format: 'ig-post',
          topic: `Generate exactly ${data.props?.count || 10} hashtags (space-separated, each starting with #) for this content. Only output the hashtags, nothing else: """${topic.slice(0, 1000)}"""`,
          count: 1,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      // Pull hashtags out of any field that has them
      const text = body.items?.[0]?.hashtags || body.items?.[0]?.full_script || ''
      return { hashtags: text }
    },
  },

  avatar_picker: {
    label: 'Avatar picker',
    description: 'Pick avatar, look, voice for the render step.',
    icon: UserCircle2,
    category: 'inputs',
    color: '#60a5fa',
    inputs: [],
    outputs: [{ id: 'avatar', label: 'Avatar config' }],
    initialProps: { avatar_id: '', look_id: '', voice_id: '', model_version: '' },
    Body: AvatarPickerBody,
    run: async ({ data }) => {
      const { avatar_id, look_id, voice_id, model_version } = data.props || {}
      if (!avatar_id) throw new Error('Pick an avatar')
      if (!voice_id) throw new Error('Voice ID required')
      return { avatar: { avatar_id, look_id: look_id || null, voice_id, model_version: model_version || null } }
    },
  },

  avatar_render: {
    label: 'Avatar render',
    description: 'HeyGen renders the avatar speaking the script.',
    icon: FileVideo,
    category: 'generators',
    color: '#ef4444',
    inputs: [
      { id: 'script', label: 'Script' },
      { id: 'avatar', label: 'Avatar config' },
    ],
    outputs: [{ id: 'video', label: 'Video' }],
    initialProps: {},
    Body: AvatarRenderBody,
    run: async ({ inputs, ctx }) => {
      const script = readInput(inputs, {}, 'script') || readInput(inputs, {}, 'text')
      if (!script) throw new Error('No script provided')
      const avatar = inputs?.avatar
      if (!avatar?.avatar_id) throw new Error('Connect an Avatar picker')
      if (!avatar?.voice_id)  throw new Error('Voice ID missing on avatar config')

      // Submit the render
      const r = await fetch('/api/avatars/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          avatar_id: avatar.avatar_id,
          script,
          voice_id: avatar.voice_id,
          look_id: avatar.look_id || undefined,
          model_version: avatar.model_version || undefined,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      const renderId = body.render?.id
      if (!renderId) throw new Error('Render row not returned')

      // Poll for completion (up to 4 minutes)
      const start = Date.now()
      while (Date.now() - start < 4 * 60_000) {
        await new Promise((r) => setTimeout(r, 8000))
        const sr = await fetch(`/api/avatars/render-status?id=${renderId}`, {
          headers: { Authorization: `Bearer ${ctx.token}` },
        })
        const sb = await sr.json()
        if (sb.render?.status === 'done' && sb.render?.final_video_url) {
          return { video: { video_url: sb.render.final_video_url, render_id: renderId } }
        }
        if (sb.render?.status === 'failed') throw new Error(sb.render?.error || 'Render failed')
      }
      throw new Error('Timed out waiting for HeyGen render')
    },
  },

  save_library: {
    label: 'Save to library',
    description: 'Persist as a content_scripts entry.',
    icon: Save,
    category: 'outputs',
    color: '#2ecc71',
    inputs: [
      { id: 'script',   label: 'Script' },
      { id: 'caption',  label: 'Caption' },
      { id: 'hashtags', label: 'Hashtags' },
      { id: 'video',    label: 'Video' },
    ],
    outputs: [],
    initialProps: { title: '', status: 'draft' },
    Body: SaveBody,
    run: async ({ data, inputs, ctx }) => {
      const script = readInput(inputs, {}, 'script') || readInput(inputs, {}, 'text') || ''
      const caption = readInput(inputs, {}, 'caption') || ''
      const hashtags = readInput(inputs, {}, 'hashtags') || ''
      const video = inputs?.video
      const title = data.props?.title?.trim() || (script.slice(0, 60)) || 'Untitled'
      const r = await fetch('/api/content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: ctx.profileId,
          title,
          full_script: script,
          caption,
          hashtags,
          media_urls: video?.video_url ? [video.video_url] : null,
          media_type: video?.video_url ? 'video' : 'text',
          status: data.props?.status || 'draft',
          generated_by: 'space',
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      return { content_id: body.item?.id }
    },
  },
}

export const NODE_CATEGORIES = {
  inputs:     { label: 'Inputs',     order: 0 },
  generators: { label: 'Generators', order: 1 },
  outputs:    { label: 'Outputs',    order: 2 },
}

// ── Run engine ─────────────────────────────────────────────────────────────
// Topologically sort by edges, then execute each node in order. Threads
// outputs through edges (sourceHandle → targetHandle).
//
// `ctx`: { token, profileId, avatars }
// `nodes`: ReactFlow nodes (with .data and .id)
// `edges`: ReactFlow edges (source, target, sourceHandle, targetHandle)
// `onNodeChange(id, patch)`: callback to update a node's status/output/error
//
// Returns: { ok: bool, errors: { [nodeId]: string } }
export async function runSpace({ ctx, nodes, edges, onNodeChange }) {
  // Build lookup: incomingByTarget[target] = [{ source, sourceHandle, targetHandle }]
  const incoming = new Map()
  for (const e of edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, [])
    incoming.get(e.target).push(e)
  }

  // Topological sort (Kahn's): nodes with no inbound edges first.
  const inDegree = new Map(nodes.map((n) => [n.id, 0]))
  for (const e of edges) inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1)
  const order = []
  const queue = nodes.filter((n) => (inDegree.get(n.id) || 0) === 0).map((n) => n.id)
  while (queue.length) {
    const id = queue.shift()
    order.push(id)
    for (const e of edges.filter((e) => e.source === id)) {
      const next = (inDegree.get(e.target) || 0) - 1
      inDegree.set(e.target, next)
      if (next === 0) queue.push(e.target)
    }
  }
  // Cycle? bail
  if (order.length !== nodes.length) {
    return { ok: false, errors: { _cycle: 'Workflow has a cycle. Remove the loop and try again.' } }
  }

  const outputsById = new Map()  // nodeId → { handleId: value }
  const errors = {}

  for (const id of order) {
    const node = nodes.find((n) => n.id === id)
    if (!node) continue
    const def = NODE_REGISTRY[node.data?.type || node.type]
    if (!def) {
      onNodeChange?.(id, { status: 'failed', error: `Unknown node type: ${node.data?.type || node.type}` })
      errors[id] = 'unknown type'
      continue
    }

    // Build the inputs object: { handleId: incoming value }
    const inboundEdges = incoming.get(id) || []
    const inputObj = {}
    for (const e of inboundEdges) {
      const sourceOut = outputsById.get(e.source)
      if (!sourceOut) continue
      const value = sourceOut[e.sourceHandle] ?? sourceOut[Object.keys(sourceOut)[0]]
      inputObj[e.targetHandle || Object.keys(inputObj).length] = value
    }

    onNodeChange?.(id, { status: 'running', error: null })
    try {
      const result = await def.run({ data: node.data, inputs: inputObj, ctx })
      outputsById.set(id, result || {})
      onNodeChange?.(id, { status: 'done', output: result })
    } catch (err) {
      onNodeChange?.(id, { status: 'failed', error: err.message })
      errors[id] = err.message
      // Don't bail — let other branches continue
    }
  }

  return { ok: Object.keys(errors).length === 0, errors }
}

// Generic node renderer used by ReactFlow — looks up the type, draws handles.
export function makeReactFlowNodeTypes() {
  const types = {}
  for (const [key, def] of Object.entries(NODE_REGISTRY)) {
    types[key] = def.Component || null   // we use a single SpaceNode renderer below
  }
  return types
}
