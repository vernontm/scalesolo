// Space node registry — defines every node type the canvas can render and
// run. Each node:
//   - has a `category` for the palette sidebar
//   - declares `inputs` (handles on the left) + `outputs` (handles on the right)
//   - has a `Body` that renders the body of the node card
//   - has a `run({ ctx, inputs, inputsByName })` async function
//
// Prompts may reference upstream outputs via @-mentions:
//   @scriptgen1, @"My image" — substituted with the upstream output before
//   being sent to APIs. Resolution uses the source node's editable name.

import { useRef, useState } from 'react'
import {
  Type, Wand2, Captions, UserCircle2, Save, Image as ImageIcon,
  ListChecks, FileVideo, Upload, Loader2,
} from 'lucide-react'
import { supabase } from './supabase.js'

// ── shared style helpers ────────────────────────────────────────────────────
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
const pillRow = {
  display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8,
}
const pillSelect = {
  ...tinyInput, width: 'auto', padding: '6px 8px', fontSize: 11,
  borderRadius: 999,
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
  if (status === 'running') return <div style={{ ...previewBox, color: 'var(--amber)' }}><Loader2 size={11} className="spin" style={{ marginRight: 6, verticalAlign: '-1px' }} /> Running…</div>
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

function readInput(inputs, props, key) {
  const v = inputs?.[key]
  return (v == null || v === '') ? (props?.[key] ?? '') : v
}

// ── @-mention substitution ──────────────────────────────────────────────────
// Replaces @name and @"two word name" with the matching upstream output.
// inputsByName: { "<lowercased,nospace name>": { handleId: value, ... } }
// For an image upstream we use the first url; for a script we use script;
// otherwise the first scalar value.
function flatten(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((v) => v?.url || v).filter(Boolean).join(', ')
  if (value.url) return value.url
  if (value.video_url) return value.video_url
  if (value.script) return value.script
  if (value.text) return value.text
  if (value.caption) return value.caption
  const k = Object.keys(value)[0]
  return k ? flatten(value[k]) : ''
}
function expandMentions(text, inputsByName) {
  if (!text || typeof text !== 'string') return text || ''
  return text.replace(/@(?:"([^"]+)"|([A-Za-z0-9_-]+))/g, (full, quoted, bare) => {
    const raw = quoted || bare || ''
    const key = raw.toLowerCase().replace(/\s+/g, '')
    const hit = inputsByName?.[key]
    if (!hit) return full
    return flatten(hit) || full
  })
}

// ── Direct upload helper for image_upload + image_gen reference uploads ─────
async function uploadImageToBucket(file, profileId, bucket = 'landing-media') {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
  const path = `${profileId}/spaces/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    contentType: file.type || 'image/jpeg', upsert: false,
  })
  if (error) throw new Error(`Upload failed: ${error.message}`)
  const { data } = supabase.storage.from(bucket).getPublicUrl(path)
  return data.publicUrl
}

// ─── 1. TEXT INPUT ──────────────────────────────────────────────────────────
function TextInputBody({ data, onPatch }) {
  return (
    <>
      <textarea
        style={{ ...tinyInput, minHeight: 90, fontFamily: 'inherit' }}
        placeholder='Try "Happy dog with sunglasses and floating ring"'
        value={data.props?.text || ''}
        onChange={(e) => onPatch({ text: e.target.value })}
      />
      <NodePreview status={data.status} output={data.output} error={data.error} />
    </>
  )
}

// ─── 2. SCRIPT GENERATOR ────────────────────────────────────────────────────
function ScriptGenBody({ data, onPatch }) {
  return (
    <>
      <textarea
        style={{ ...tinyInput, minHeight: 70, fontFamily: 'inherit' }}
        placeholder="Topic, hook, or @text1 to reference an upstream node…"
        value={data.props?.topic || ''}
        onChange={(e) => onPatch({ topic: e.target.value })}
      />
      <div style={pillRow}>
        <select style={pillSelect} value={data.props?.format || 'tiktok-script'} onChange={(e) => onPatch({ format: e.target.value })}>
          <option value="tiktok-script">TikTok</option>
          <option value="ig-post">Instagram</option>
          <option value="thread">Thread</option>
          <option value="youtube-short">YT Short</option>
          <option value="email-subject">Email subj</option>
          <option value="blog-post">Blog post</option>
        </select>
      </div>
      <NodePreview status={data.status} output={data.output} error={data.error} />
    </>
  )
}

// ─── 3. CAPTION + HASHTAGS (merged) ─────────────────────────────────────────
function CaptionGenBody({ data, onPatch }) {
  return (
    <>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 6 }}>
        Connect a script. Outputs caption + hashtags together.
      </div>
      <div style={pillRow}>
        <select style={pillSelect} value={data.props?.platform || 'instagram'} onChange={(e) => onPatch({ platform: e.target.value })}>
          <option value="instagram">Instagram</option>
          <option value="tiktok">TikTok</option>
          <option value="youtube">YouTube</option>
          <option value="x">X / Threads</option>
          <option value="linkedin">LinkedIn</option>
        </select>
        <select style={pillSelect} value={data.props?.hashtag_count || 10} onChange={(e) => onPatch({ hashtag_count: Number(e.target.value) })}>
          {[5, 8, 10, 15, 20, 25, 30].map((n) => <option key={n} value={n}>{n} tags</option>)}
        </select>
      </div>
      <NodePreview status={data.status} output={data.output} error={data.error} />
    </>
  )
}

// ─── 4. IMAGE GENERATOR (KIE) ───────────────────────────────────────────────
function ImageGenBody({ data, onPatch }) {
  const out = data.output
  const imgs = Array.isArray(out?.images) ? out.images : (out?.image_url ? [{ url: out.image_url }] : [])
  const status = data.status || 'idle'

  return (
    <>
      <div style={{
        position: 'relative',
        aspectRatio: data.props?.aspect === '9:16' ? '9/16'
          : data.props?.aspect === '16:9' ? '16/9'
          : data.props?.aspect === '4:3' ? '4/3'
          : data.props?.aspect === '3:4' ? '3/4' : '1/1',
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        marginBottom: 8,
        overflow: 'hidden',
        display: 'grid',
        placeItems: 'center',
      }}>
        {status === 'running' ? (
          <Loader2 size={22} className="spin" style={{ color: 'var(--amber)' }} />
        ) : imgs[0]?.url ? (
          <img src={imgs[0].url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <ImageIcon size={26} style={{ color: 'var(--muted)' }} />
        )}
        {imgs.length > 1 && (
          <div style={{
            position: 'absolute', top: 6, left: 6,
            background: 'rgba(0,0,0,0.55)', color: '#fff',
            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
          }}>{imgs.length}</div>
        )}
      </div>

      <textarea
        style={{ ...tinyInput, minHeight: 60, fontFamily: 'inherit' }}
        placeholder='Describe the image, or use @ref1 to include a reference image…'
        value={data.props?.prompt || ''}
        onChange={(e) => onPatch({ prompt: e.target.value })}
      />

      <div style={pillRow}>
        <select style={pillSelect} value={data.props?.model || 'nano-banana'} onChange={(e) => onPatch({ model: e.target.value })}>
          <option value="nano-banana">Nano Banana</option>
          <option value="flux-pro">Flux Pro</option>
          <option value="flux-kontext">Flux Kontext</option>
          <option value="gpt-image">GPT Image</option>
        </select>
        <select style={pillSelect} value={data.props?.aspect || '1:1'} onChange={(e) => onPatch({ aspect: e.target.value })}>
          <option value="1:1">1:1</option>
          <option value="16:9">16:9</option>
          <option value="9:16">9:16</option>
          <option value="4:3">4:3</option>
          <option value="3:4">3:4</option>
        </select>
        <select style={pillSelect} value={data.props?.count || 1} onChange={(e) => onPatch({ count: Number(e.target.value) })}>
          {[1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>×{n}</option>)}
        </select>
        <select style={pillSelect} value={data.props?.quality || '2K'} onChange={(e) => onPatch({ quality: e.target.value })}>
          <option value="1K">1K</option>
          <option value="2K">2K</option>
          <option value="4K">4K</option>
        </select>
      </div>

      {imgs.length > 1 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginTop: 8 }}>
          {imgs.slice(0, 8).map((im, i) => (
            <a key={i} href={im.url} target="_blank" rel="noreferrer" style={{ aspectRatio: '1', overflow: 'hidden', borderRadius: 4 }}>
              <img src={im.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </a>
          ))}
        </div>
      )}

      <NodePreview status={status} output={imgs.length ? null : out} error={data.error} />
    </>
  )
}

// ─── 5. IMAGE UPLOAD (reference images) ─────────────────────────────────────
function ImageUploadBody({ data, onPatch, ctx }) {
  const inpRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const urls = Array.isArray(data.props?.urls) ? data.props.urls : []

  async function onPick(e) {
    const files = Array.from(e.target.files || [])
    if (!files.length || !ctx?.profileId) return
    setBusy(true); setErr(null)
    try {
      const next = [...urls]
      for (const f of files) {
        const u = await uploadImageToBucket(f, ctx.profileId)
        next.push(u)
      }
      onPatch({ urls: next })
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
      if (inpRef.current) inpRef.current.value = ''
    }
  }
  function remove(u) {
    onPatch({ urls: urls.filter((x) => x !== u) })
  }

  return (
    <>
      {urls.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 8 }}>
          {urls.map((u) => (
            <div key={u} style={{ position: 'relative', aspectRatio: '1', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
              <img src={u} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              <button
                onClick={() => remove(u)}
                style={{
                  position: 'absolute', top: 2, right: 2,
                  background: 'rgba(0,0,0,0.6)', color: '#fff',
                  border: 'none', borderRadius: 999, width: 18, height: 18,
                  cursor: 'pointer', fontSize: 10, display: 'grid', placeItems: 'center',
                }}
                aria-label="Remove">×</button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => inpRef.current?.click()}
        disabled={busy}
        style={{
          ...tinyInput, cursor: 'pointer', display: 'flex',
          alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px',
          background: 'var(--surface-2)', borderStyle: 'dashed',
        }}>
        {busy ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}
        {busy ? 'Uploading…' : urls.length ? 'Add more images' : 'Upload reference images'}
      </button>
      <input ref={inpRef} type="file" multiple accept="image/*" onChange={onPick} style={{ display: 'none' }} />
      {err && <div style={{ marginTop: 6, color: 'var(--red)', fontSize: 11 }}>{err}</div>}
    </>
  )
}

// ─── 6. AVATAR PICKER ───────────────────────────────────────────────────────
function AvatarPickerBody({ data, onPatch, ctx }) {
  const avatars = ctx?.avatars || []
  const looks = avatars.find((a) => a.id === data.props?.avatar_id)?.looks || []
  return (
    <>
      <NodeField label="Avatar">
        <select style={tinyInput} value={data.props?.avatar_id || ''} onChange={(e) => onPatch({ avatar_id: e.target.value, look_id: '' })}>
          <option value="">Pick an avatar…</option>
          {avatars.map((a) => (
            <option key={a.id} value={a.id}>{a.name} ({(a.model_version || 'v4').toUpperCase()})</option>
          ))}
        </select>
      </NodeField>
      {looks.length > 1 && (
        <NodeField label="Look">
          <select style={tinyInput} value={data.props?.look_id || ''} onChange={(e) => onPatch({ look_id: e.target.value })}>
            <option value="">Default</option>
            {looks.map((l) => <option key={l.id} value={l.id}>Look {l.angle_order ?? ''}</option>)}
          </select>
        </NodeField>
      )}
      <NodeField label="Voice ID (ElevenLabs)">
        <input style={tinyInput} placeholder="21m00Tcm4TlvDq8ikWAM" value={data.props?.voice_id || ''} onChange={(e) => onPatch({ voice_id: e.target.value })} />
      </NodeField>
      <NodeField label="Model">
        <select style={tinyInput} value={data.props?.model_version || ''} onChange={(e) => onPatch({ model_version: e.target.value })}>
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

// ─── 7. AVATAR RENDER ───────────────────────────────────────────────────────
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

// ─── 8. COLLECTION (catches scripts/images/videos into a list) ──────────────
function CollectionBody({ data }) {
  const items = Array.isArray(data.output?.items) ? data.output.items : []
  if (!items.length && data.status !== 'running') {
    return <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Connect any output here. Run to gather all upstream results into one list.</div>
  }
  if (data.status === 'running') return <NodePreview status="running" />
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
      {items.slice(0, 12).map((it, i) => (
        <div key={i} style={{
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 6, padding: 6, fontSize: 10.5, lineHeight: 1.4,
          color: 'var(--text-soft)', overflow: 'hidden',
        }}>
          {it.kind === 'image' && it.url ? <img src={it.url} alt="" style={{ width: '100%', borderRadius: 4, marginBottom: 4 }} /> : null}
          {it.kind === 'video' && it.url ? <video src={it.url} controls style={{ width: '100%', borderRadius: 4, marginBottom: 4 }} /> : null}
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{it.kind} · {it.from}</div>
          {it.text && <div style={{ maxHeight: 40, overflow: 'hidden' }}>{String(it.text).slice(0, 90)}…</div>}
        </div>
      ))}
    </div>
  )
}

// ─── 9. SAVE TO LIBRARY ─────────────────────────────────────────────────────
function SaveBody({ data, onPatch }) {
  return (
    <>
      <NodeField label="Title (optional)">
        <input style={tinyInput} placeholder="Auto-derived" value={data.props?.title || ''} onChange={(e) => onPatch({ title: e.target.value })} />
      </NodeField>
      <NodeField label="Status">
        <select style={tinyInput} value={data.props?.status || 'draft'} onChange={(e) => onPatch({ status: e.target.value })}>
          <option value="draft">Draft</option>
          <option value="caption_ready">Caption ready</option>
          <option value="scheduled">Scheduled</option>
        </select>
      </NodeField>
      <NodePreview status={data.status} output={data.output} error={data.error} />
    </>
  )
}

// ── REGISTRY ────────────────────────────────────────────────────────────────
export const NODE_REGISTRY = {
  text_input: {
    label: 'Text', description: 'Topic, hook, or any raw text.',
    icon: Type, category: 'inputs', color: '#94a3b8',
    inputs: [], outputs: [{ id: 'text', label: 'Text' }],
    initialProps: { text: '' },
    Body: TextInputBody,
    run: async ({ data }) => ({ text: data.props?.text || '' }),
  },

  image_upload: {
    label: 'Reference images', description: 'Upload images to use as references in image gen.',
    icon: Upload, category: 'inputs', color: '#0ea5e9',
    inputs: [], outputs: [{ id: 'images', label: 'Images' }],
    initialProps: { urls: [] },
    Body: ImageUploadBody,
    run: async ({ data }) => {
      const urls = Array.isArray(data.props?.urls) ? data.props.urls : []
      return { images: urls.map((url) => ({ url })) }
    },
  },

  script_gen: {
    label: 'Script generator', description: 'Claude writes a script from a topic. Supports @-mentions.',
    icon: Wand2, category: 'generators', color: '#ef4444',
    inputs: [{ id: 'topic', label: 'Topic / hook' }],
    outputs: [{ id: 'script', label: 'Script' }, { id: 'title', label: 'Title' }],
    initialProps: { format: 'tiktok-script', topic: '' },
    Body: ScriptGenBody,
    run: async ({ data, inputs, inputsByName, ctx }) => {
      let topic = readInput(inputs, data.props, 'topic') || readInput(inputs, data.props, 'text')
      if (!topic) throw new Error('No topic / text provided')
      topic = expandMentions(topic, inputsByName)
      const r = await fetch('/api/content/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({ profile_id: ctx.profileId, format: data.props?.format || 'tiktok-script', topic, count: 1 }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      const item = body.items?.[0]
      if (!item) throw new Error('No item returned')
      return { script: item.full_script || '', title: item.title || '', _content_id: item.id }
    },
  },

  caption_gen: {
    label: 'Caption + hashtags', description: 'Generates a platform caption AND hashtag block from a script.',
    icon: Captions, category: 'generators', color: '#f59e0b',
    inputs: [{ id: 'script', label: 'Script' }],
    outputs: [{ id: 'caption', label: 'Caption' }, { id: 'hashtags', label: 'Hashtags' }],
    initialProps: { platform: 'instagram', hashtag_count: 10 },
    Body: CaptionGenBody,
    run: async ({ data, inputs, ctx }) => {
      const script = readInput(inputs, {}, 'script') || readInput(inputs, {}, 'text')
      if (!script) throw new Error('No script provided')
      const platform = data.props?.platform || 'instagram'
      const count = data.props?.hashtag_count || 10
      const r = await fetch('/api/content/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: ctx.profileId,
          format: 'ig-post',
          topic: `For platform ${platform}, write the post caption AND a separate block of exactly ${count} hashtags for this script. Return JSON-ish lines: first the caption, then a blank line, then the hashtags space-separated each starting with #. Script: """${String(script).slice(0, 1500)}"""`,
          count: 1,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      const item = body.items?.[0] || {}
      // Parse the response: split by blank line if needed.
      let caption = item.caption || ''
      let hashtags = item.hashtags || ''
      if (!caption || !hashtags) {
        const text = item.full_script || item.caption || ''
        const parts = String(text).split(/\n\s*\n/)
        if (parts.length >= 2) {
          caption = caption || parts[0].trim()
          hashtags = hashtags || parts.slice(1).join(' ').match(/#[\w]+/g)?.join(' ') || ''
        } else {
          caption = caption || text
          hashtags = hashtags || (text.match(/#[\w]+/g) || []).join(' ')
        }
      }
      return { caption, hashtags }
    },
  },

  image_gen: {
    label: 'Image generator', description: 'KIE image gen (Nano Banana, Flux). Aspect, count, quality. Supports @-mentions for reference images.',
    icon: ImageIcon, category: 'generators', color: '#a855f7',
    inputs: [{ id: 'references', label: 'References' }, { id: 'prompt', label: 'Prompt' }],
    outputs: [{ id: 'images', label: 'Images' }],
    initialProps: { prompt: '', model: 'nano-banana', aspect: '1:1', count: 1, quality: '2K' },
    Body: ImageGenBody,
    run: async ({ data, inputs, inputsByName, ctx }) => {
      let prompt = readInput(inputs, data.props, 'prompt')
      if (!prompt) throw new Error('Prompt required')
      prompt = expandMentions(prompt, inputsByName)

      // Gather reference URLs from connected references input or @-mentions
      const refs = []
      const incomingRefs = inputs?.references
      if (incomingRefs) {
        if (Array.isArray(incomingRefs)) refs.push(...incomingRefs.map((x) => x.url || x).filter(Boolean))
        else if (incomingRefs.url) refs.push(incomingRefs.url)
        else if (Array.isArray(incomingRefs.images)) refs.push(...incomingRefs.images.map((x) => x.url).filter(Boolean))
      }

      const r = await fetch('/api/images/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: ctx.profileId,
          prompt,
          model: data.props?.model || 'nano-banana',
          count: data.props?.count || 1,
          aspect: data.props?.aspect || '1:1',
          quality: data.props?.quality || '2K',
          reference_urls: refs.length ? refs : undefined,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      return { images: body.images || [] }
    },
  },

  avatar_picker: {
    label: 'Avatar', description: 'Pick avatar, look, voice for the render step.',
    icon: UserCircle2, category: 'inputs', color: '#60a5fa',
    inputs: [], outputs: [{ id: 'avatar', label: 'Avatar' }],
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
    label: 'Avatar render', description: 'HeyGen renders the avatar speaking the script.',
    icon: FileVideo, category: 'generators', color: '#ef4444',
    inputs: [{ id: 'script', label: 'Script' }, { id: 'avatar', label: 'Avatar' }],
    outputs: [{ id: 'video', label: 'Video' }],
    initialProps: {},
    Body: AvatarRenderBody,
    run: async ({ inputs, ctx }) => {
      const script = readInput(inputs, {}, 'script') || readInput(inputs, {}, 'text')
      if (!script) throw new Error('No script provided')
      const avatar = inputs?.avatar
      if (!avatar?.avatar_id) throw new Error('Connect an Avatar picker')
      if (!avatar?.voice_id)  throw new Error('Voice ID missing on avatar config')
      const r = await fetch('/api/avatars/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          avatar_id: avatar.avatar_id, script, voice_id: avatar.voice_id,
          look_id: avatar.look_id || undefined, model_version: avatar.model_version || undefined,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      const renderId = body.render?.id
      if (!renderId) throw new Error('Render row not returned')
      const start = Date.now()
      while (Date.now() - start < 4 * 60_000) {
        await new Promise((r) => setTimeout(r, 8000))
        const sr = await fetch(`/api/avatars/render-status?id=${renderId}`, { headers: { Authorization: `Bearer ${ctx.token}` } })
        const sb = await sr.json()
        if (sb.render?.status === 'done' && sb.render?.final_video_url) {
          return { video: { video_url: sb.render.final_video_url, render_id: renderId } }
        }
        if (sb.render?.status === 'failed') throw new Error(sb.render?.error || 'Render failed')
      }
      throw new Error('Timed out waiting for HeyGen render')
    },
  },

  collection: {
    label: 'Collection', description: 'Catches outputs from any connected node and gathers them into a list (scripts, images, videos).',
    icon: ListChecks, category: 'outputs', color: '#10b981',
    inputs: [{ id: 'items', label: 'Items' }, { id: 'more', label: '+ more' }],
    outputs: [{ id: 'items', label: 'Items' }],
    initialProps: {},
    Body: CollectionBody,
    run: async ({ inputs }) => {
      const items = []
      const collect = (val, from = '') => {
        if (val == null) return
        if (Array.isArray(val)) { val.forEach((v) => collect(v, from)); return }
        if (typeof val === 'string') { items.push({ kind: 'text', text: val, from }); return }
        if (val.video_url) { items.push({ kind: 'video', url: val.video_url, from }); return }
        if (val.url) { items.push({ kind: 'image', url: val.url, from }); return }
        if (val.script) { items.push({ kind: 'script', text: val.script, from }); return }
        if (val.text) { items.push({ kind: 'text', text: val.text, from }); return }
        if (val.caption) { items.push({ kind: 'caption', text: val.caption, from }); return }
        if (val.images) { collect(val.images, from); return }
      }
      for (const [key, val] of Object.entries(inputs || {})) collect(val, key)
      return { items }
    },
  },

  save_library: {
    label: 'Save to library', description: 'Persist as a content_scripts entry.',
    icon: Save, category: 'outputs', color: '#2ecc71',
    inputs: [
      { id: 'script', label: 'Script' }, { id: 'caption', label: 'Caption' },
      { id: 'hashtags', label: 'Hashtags' }, { id: 'video', label: 'Video' },
      { id: 'image', label: 'Image' },
    ],
    outputs: [],
    initialProps: { title: '', status: 'draft' },
    Body: SaveBody,
    run: async ({ data, inputs, ctx }) => {
      const script = readInput(inputs, {}, 'script') || readInput(inputs, {}, 'text') || ''
      const caption = readInput(inputs, {}, 'caption') || ''
      const hashtags = readInput(inputs, {}, 'hashtags') || ''
      const video = inputs?.video
      const image = inputs?.image
      const title = data.props?.title?.trim() || (script.slice(0, 60)) || 'Untitled'
      const mediaUrls = video?.video_url ? [video.video_url]
        : image?.url ? [image.url]
        : Array.isArray(image?.images) ? image.images.map((x) => x.url).filter(Boolean)
        : null
      const mediaType = video?.video_url ? 'video' : (mediaUrls && mediaUrls.length ? 'image' : 'text')
      const r = await fetch('/api/content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: ctx.profileId, title, full_script: script, caption, hashtags,
          media_urls: mediaUrls, media_type: mediaType,
          status: data.props?.status || 'draft', generated_by: 'space',
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
// Topo sort + thread outputs through edges. Builds inputsByName so node
// `run()`s can resolve @-mentions to upstream outputs by user-given name.
export async function runSpace({ ctx, nodes, edges, onNodeChange }) {
  const incoming = new Map()
  for (const e of edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, [])
    incoming.get(e.target).push(e)
  }

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
  if (order.length !== nodes.length) {
    return { ok: false, errors: { _cycle: 'Workflow has a cycle. Remove the loop and try again.' } }
  }

  // Build a name lookup: nodeId → normalized name (label + index, or user name)
  const typeCounts = {}
  const nameById = new Map()
  for (const n of nodes) {
    const t = n.data?.type
    typeCounts[t] = (typeCounts[t] || 0) + 1
    const fallback = `${(NODE_REGISTRY[t]?.label || t).replace(/\W+/g, '')}${typeCounts[t]}`.toLowerCase()
    const name = (n.data?.name || '').toString().toLowerCase().replace(/\s+/g, '') || fallback
    nameById.set(n.id, name)
  }

  const outputsById = new Map()
  const errors = {}

  for (const id of order) {
    const node = nodes.find((n) => n.id === id)
    if (!node) continue
    const def = NODE_REGISTRY[node.data?.type || node.type]
    if (!def) {
      onNodeChange?.(id, { status: 'failed', error: `Unknown type: ${node.data?.type || node.type}` })
      errors[id] = 'unknown type'; continue
    }

    const inboundEdges = incoming.get(id) || []
    const inputObj = {}
    const inputsByName = {}
    for (const e of inboundEdges) {
      const sourceOut = outputsById.get(e.source)
      if (!sourceOut) continue
      const value = sourceOut[e.sourceHandle] ?? sourceOut[Object.keys(sourceOut)[0]]
      const handle = e.targetHandle || Object.keys(inputObj).length
      // Multi-edge to same handle → coerce to array
      if (inputObj[handle] != null) {
        inputObj[handle] = Array.isArray(inputObj[handle]) ? [...inputObj[handle], value] : [inputObj[handle], value]
      } else {
        inputObj[handle] = value
      }
      const sname = nameById.get(e.source)
      if (sname) inputsByName[sname] = sourceOut
    }

    onNodeChange?.(id, { status: 'running', error: null })
    try {
      const result = await def.run({ data: node.data, inputs: inputObj, inputsByName, ctx })
      outputsById.set(id, result || {})
      onNodeChange?.(id, { status: 'done', output: result })
    } catch (err) {
      onNodeChange?.(id, { status: 'failed', error: err.message })
      errors[id] = err.message
    }
  }

  return { ok: Object.keys(errors).length === 0, errors }
}

export function makeReactFlowNodeTypes() {
  const types = {}
  for (const [key, def] of Object.entries(NODE_REGISTRY)) types[key] = def.Component || null
  return types
}
