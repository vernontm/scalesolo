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
  ListChecks, FileVideo, Upload, Loader2, Maximize2, ArrowUpRight,
  Download, Trash2, Building2, Repeat, Play, Pause, Combine as CombineIcon,
} from 'lucide-react'
import { supabase } from './supabase.js'

// ── shared download helper ──────────────────────────────────────────────────
export async function downloadUrl(url, filename) {
  try {
    const r = await fetch(url)
    if (!r.ok) throw new Error('fetch failed')
    const blob = await r.blob()
    const obj = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = obj
    a.download = filename || url.split('/').pop()?.split('?')[0] || 'download'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(obj), 1500)
  } catch {
    window.open(url, '_blank')
  }
}

// ── MediaItem: hoverable image/video tile with action overlay ───────────────
// Actions: preview (fullscreen), add to canvas as own node, download, remove.
export function MediaItem({ url, type = 'image', from = '', onDelete, aspectRatio, rounded = 6, fit = 'cover' }) {
  const [hover, setHover] = useState(false)
  if (!url) return null
  const Btn = ({ Icon, title, onClick }) => (
    <button
      type="button"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick?.() }}
      style={{
        background: 'transparent', border: 'none', color: '#fff',
        cursor: 'pointer', padding: 4, borderRadius: 4,
        display: 'grid', placeItems: 'center',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    ><Icon size={13} /></button>
  )
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', width: '100%', aspectRatio, borderRadius: rounded, overflow: 'hidden', background: 'var(--surface-2)' }}
    >
      {type === 'video' ? (
        <video src={url} controls style={{ width: '100%', height: '100%', objectFit: fit, background: '#000' }} />
      ) : (
        <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: fit, display: 'block' }} />
      )}
      {hover && (
        <div
          style={{
            position: 'absolute', left: '50%', bottom: 8, transform: 'translateX(-50%)',
            display: 'flex', gap: 2, padding: '3px 5px',
            background: 'rgba(0,0,0,0.78)', borderRadius: 999,
            backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
            zIndex: 5,
          }}
        >
          <Btn Icon={Maximize2} title="Preview" onClick={() => window.__spaceOpenPreview?.({ url, type })} />
          <Btn Icon={ArrowUpRight} title="Add to board as new node" onClick={() => window.__spaceAddNodeFromItem?.({ url, type, from })} />
          <Btn Icon={Download} title="Download" onClick={() => downloadUrl(url)} />
          {onDelete && <Btn Icon={Trash2} title="Remove" onClick={onDelete} />}
        </div>
      )}
    </div>
  )
}

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

// ── Shape-aware pickers from a single "in" handle ───────────────────────────
// All non-aggregator nodes now expose ONE "in" handle (and image/video gens
// add a second "ref" handle). Each node's run() picks what it needs from
// the bag of upstream values by inspecting the shape.
function asArr(v) { if (v == null) return []; return Array.isArray(v) ? v : [v] }
function pickBrand(v) {
  for (const x of asArr(v)) {
    if (x && typeof x === 'object' && x.brand && typeof x.brand === 'object') return x.brand
    if (x && typeof x === 'object' && x.profile_id && (x.name != null || x.voice != null)) return x
  }
  return null
}
function pickAvatarConfig(v) {
  for (const x of asArr(v)) {
    if (x && typeof x === 'object' && x.avatar && x.avatar.avatar_id) return x.avatar
    if (x && typeof x === 'object' && x.avatar_id) return x
  }
  return null
}
function pickScript(v) {
  for (const x of asArr(v)) {
    if (typeof x === 'string') return x
    if (x && typeof x === 'object') {
      if (x.script) return x.script
      if (x.full_script) return x.full_script
      if (x.text) return x.text
      if (x.caption) return x.caption
    }
  }
  return ''
}
// Find an @-mention in text that matches one of the user's brand profiles
// by lowercase-no-space business_name. Returns the matching profile or null.
function resolveBrandMention(text, profiles) {
  if (!text || !Array.isArray(profiles) || !profiles.length) return null
  const tokens = Array.from(new Set(String(text).match(/@(?:"([^"]+)"|([A-Za-z0-9_-]+))/g) || []))
  for (const tok of tokens) {
    const norm = tok.replace(/^@"?|"?$/g, '').toLowerCase().replace(/\s+/g, '')
    const hit = profiles.find((p) => (p.business_name || '').toLowerCase().replace(/\s+/g, '') === norm)
    if (hit) return hit
  }
  return null
}

// Strip @brand-only tokens from a prompt so the underlying model doesn't see
// stray "@vernontech" text. (Other @-tokens — image refs etc. — are left
// alone for the caller to handle.)
function stripBrandMentions(text, profiles) {
  if (!text) return text
  const names = new Set((profiles || []).map((p) => (p.business_name || '').toLowerCase().replace(/\s+/g, '')).filter(Boolean))
  return String(text).replace(/@(?:"([^"]+)"|([A-Za-z0-9_-]+))/g, (full, q, b) => {
    const norm = (q || b || '').toLowerCase().replace(/\s+/g, '')
    return names.has(norm) ? '' : full
  }).replace(/\s+/g, ' ').trim()
}

function pickImageUrls(v) {
  const out = []
  for (const x of asArr(v)) {
    if (!x) continue
    if (Array.isArray(x.images)) for (const im of x.images) { if (im?.url) out.push(im.url) }
    else if (x.url) out.push(x.url)
    else if (typeof x === 'string' && /^https?:/.test(x)) out.push(x)
  }
  return out
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
// Upload a browser File to KIE's free file-upload service via our proxy
// endpoint. KIE serves it from a CORS-friendly URL and image generators
// (their own ones, naturally) accept it directly as image_input.
// Heads up: KIE expires uploaded files after ~3 days. That's fine for
// reference images in active workflows; if a user wants a permanent
// asset they should upload it through their brand profile instead.
async function uploadImageToBucket(file, profileId) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.readAsDataURL(file)
  })
  const session = (await supabase.auth.getSession()).data.session
  const r = await fetch('/api/images/upload-reference', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session?.access_token || ''}`,
    },
    body: JSON.stringify({
      profile_id: profileId,
      base64: dataUrl,
      fileName: file.name || `image-${Date.now()}.png`,
    }),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok || !body?.url) throw new Error(body?.error || `Upload failed (${r.status})`)
  return body.url
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
      <MentionPrompt
        value={data.props?.topic || ''}
        onChange={(v) => onPatch({ topic: v })}
        placeholder="Topic or hook. Type @ to tag a brand profile."
        minHeight={70}
        brands={data?._ctxProfiles || []}
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

// Prompt subcomponent: shows available @-tag chips above the textarea,
// supports click-to-insert, and a typing autocomplete dropdown when the
// user types "@". Listed images come from upstream image_upload nodes
// (injected via renderNodes as data._ctxNamedImages).
// Generic prompt textarea that supports @-mention chips + autocomplete for
// brand profiles AND named upload images. Used by image_gen, script_gen,
// caption_gen.
//   props.value         current prompt text
//   props.onChange(v)   write new prompt text
//   props.placeholder   textarea placeholder
//   props.minHeight     css number (default 60)
//   props.brands        [{ id, name }] from data._ctxProfiles
//   props.namedImages   [{ url, name }] from data._ctxNamedImages
function MentionPrompt({ value, onChange, placeholder, minHeight = 60, brands = [], namedImages = [] }) {
  const ref = useRef(null)
  const [suggest, setSuggest] = useState({ open: false, prefix: '', start: -1 })
  const tagFor = (name) => `@${(name || '').replace(/\s+/g, '')}`
  const prompt = value || ''

  function insertTag(name) {
    const tag = tagFor(name)
    const ta = ref.current
    if (!ta) { onChange(`${prompt} ${tag}`.trim()); return }
    const start = suggest.start >= 0 ? suggest.start : ta.selectionStart
    const end = ta.selectionEnd
    const before = prompt.slice(0, start)
    const after = prompt.slice(end)
    const next = `${before}${tag}${after.startsWith(' ') ? '' : ' '}${after}`
    onChange(next)
    setSuggest({ open: false, prefix: '', start: -1 })
    requestAnimationFrame(() => {
      const pos = (before + tag + (after.startsWith(' ') ? '' : ' ')).length
      try { ta.focus(); ta.setSelectionRange(pos, pos) } catch {}
    })
  }

  function onTextareaChange(e) {
    const v = e.target.value
    onChange(v)
    const caret = e.target.selectionStart || 0
    const upto = v.slice(0, caret)
    const m = upto.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/)
    if (m) {
      const start = caret - m[1].length - 1
      setSuggest({ open: true, prefix: m[1].toLowerCase(), start })
    } else {
      setSuggest({ open: false, prefix: '', start: -1 })
    }
  }

  // Build suggestion list: brands first (more impactful context), then images.
  const all = [
    ...brands.map((b) => ({ kind: 'brand', name: b.name, key: `b-${b.id}` })),
    ...namedImages.map((im) => ({ kind: 'image', name: im.name, url: im.url, key: `i-${im.url}` })),
  ]
  const filtered = all.filter((it) => {
    if (!suggest.prefix) return true
    return (it.name || '').toLowerCase().replace(/\s+/g, '').startsWith(suggest.prefix)
  })
  const tokens = Array.from(new Set(prompt.match(/@(?:"[^"]+"|[A-Za-z0-9_-]+)/g) || []))

  const chipStyle = (kind, on) => ({
    fontSize: 10, padding: '2px 7px', borderRadius: 999,
    background: kind === 'brand'
      ? 'rgba(236,72,153,0.14)'  // pink-ish for brands
      : 'rgba(168,85,247,0.12)', // purple for images
    color: kind === 'brand' ? '#f472b6' : '#c4b5fd',
    border: `1px solid ${kind === 'brand' ? 'rgba(236,72,153,0.4)' : 'rgba(168,85,247,0.4)'}`,
    fontFamily: 'var(--font-display)', fontWeight: 700, cursor: 'pointer',
  })

  return (
    <div style={{ position: 'relative' }}>
      {(brands.length > 0 || namedImages.length > 0) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
          <span style={{ fontSize: 9.5, color: 'var(--muted)', fontFamily: 'var(--font-display)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', alignSelf: 'center' }}>tag:</span>
          {brands.map((b) => (
            <button key={`b-${b.id}`} type="button" onClick={(e) => { e.stopPropagation(); insertTag(b.name) }} title={`Insert ${tagFor(b.name)} — references this brand profile`} style={chipStyle('brand')}>
              {tagFor(b.name)}
            </button>
          ))}
          {namedImages.map((im) => (
            <button key={`i-${im.url}`} type="button" onClick={(e) => { e.stopPropagation(); insertTag(im.name) }} title={`Insert ${tagFor(im.name)}`} style={chipStyle('image')}>
              {tagFor(im.name)}
            </button>
          ))}
        </div>
      )}
      <PromptHighlightField
        textareaRef={ref}
        value={prompt}
        placeholder={placeholder}
        minHeight={minHeight}
        onChange={onTextareaChange}
        onBlur={() => setTimeout(() => setSuggest((s) => ({ ...s, open: false })), 150)}
        brands={brands}
        namedImages={namedImages}
      />
      {suggest.open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', left: 0, right: 0, top: '100%',
          marginTop: 2, zIndex: 10,
          background: 'var(--surface)', border: '1px solid var(--border-strong)',
          borderRadius: 8, boxShadow: 'var(--shadow-pop)',
          maxHeight: 220, overflow: 'auto',
        }}>
          {filtered.map((it) => (
            <button
              key={it.key}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); insertTag(it.name) }}
              style={{
                width: '100%', textAlign: 'left',
                display: 'flex', alignItems: 'center', gap: 8, padding: 6,
                background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)',
                color: 'var(--text)', cursor: 'pointer', fontSize: 11,
              }}
            >
              {it.kind === 'image' && it.url ? (
                <img src={it.url} alt="" style={{ width: 28, height: 28, objectFit: 'cover', borderRadius: 4 }} />
              ) : (
                <div style={{ width: 28, height: 28, borderRadius: 4, background: 'rgba(236,72,153,0.18)', color: '#f472b6', display: 'grid', placeItems: 'center', fontSize: 9, fontWeight: 700, fontFamily: 'var(--font-display)' }}>
                  {(it.name || '?').slice(0, 2).toUpperCase()}
                </div>
              )}
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: it.kind === 'brand' ? '#f472b6' : '#c4b5fd', flex: 1 }}>{tagFor(it.name)}</span>
              <span style={{ fontSize: 9.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{it.kind}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// PromptHighlightField — textarea with a backdrop layer that paints @-mention
// tokens inline in the matching brand/image color while you type. The textarea
// itself stays plain text (transparent fill, visible caret) and the backdrop
// sits behind it pixel-aligned. Both share font/padding/border so wrapping
// and spacing match exactly.
function PromptHighlightField({ textareaRef, value, placeholder, minHeight, onChange, onBlur, brands, namedImages }) {
  const backdropRef = useRef(null)
  const brandSet = new Set((brands || []).map((b) => (b.name || '').toLowerCase().replace(/\s+/g, '')))
  const imageSet = new Set((namedImages || []).map((im) => (im.name || '').toLowerCase().replace(/\s+/g, '')))

  // Walk the prompt, splitting at @-tokens. Recognized tokens get a colored
  // span; unknown tokens stay default-colored.
  const segments = []
  const re = /@(?:"[^"]+"|[A-Za-z0-9_-]+)/g
  let cursor = 0
  let m
  let key = 0
  while ((m = re.exec(value || '')) !== null) {
    if (m.index > cursor) segments.push({ k: key++, kind: 'text', text: value.slice(cursor, m.index) })
    const tok = m[0]
    const norm = tok.replace(/^@"?|"?$/g, '').toLowerCase().replace(/\s+/g, '')
    const tokKind = brandSet.has(norm) ? 'brand' : (imageSet.has(norm) ? 'image' : 'unknown')
    segments.push({ k: key++, kind: tokKind, text: tok })
    cursor = m.index + tok.length
  }
  if (cursor < (value || '').length) segments.push({ k: key++, kind: 'text', text: value.slice(cursor) })

  const sharedTextStyle = {
    minHeight,
    width: '100%',
    boxSizing: 'border-box',
    padding: '7px 9px',
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontFamily: 'inherit',
    fontSize: 12,
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
    overflow: 'auto',
  }
  const colorFor = (kind) => kind === 'brand' ? '#f472b6' : kind === 'image' ? '#c4b5fd' : 'inherit'
  const bgFor = (kind) => kind === 'brand' ? 'rgba(236,72,153,0.18)' : kind === 'image' ? 'rgba(168,85,247,0.18)' : 'transparent'

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={backdropRef}
        aria-hidden
        style={{
          ...sharedTextStyle,
          position: 'absolute', inset: 0,
          background: 'var(--surface-2)',
          color: 'var(--text)',
          pointerEvents: 'none',
          overflow: 'hidden',
        }}
      >
        {segments.length === 0 && !value
          ? <span style={{ color: 'var(--muted)' }}>{placeholder}</span>
          : segments.map((s) => s.kind === 'text'
              ? <span key={s.k}>{s.text}</span>
              : <span
                  key={s.k}
                  style={{
                    color: colorFor(s.kind),
                    background: bgFor(s.kind),
                    borderRadius: 4,
                    padding: '0 2px',
                    fontWeight: 700,
                  }}
                >{s.text}</span>
          )}
      </div>
      <textarea
        ref={textareaRef}
        style={{
          ...sharedTextStyle,
          position: 'relative',
          background: 'transparent',
          color: 'transparent',
          WebkitTextFillColor: 'transparent',
          caretColor: 'var(--text)',
          resize: 'none',
          outline: 'none',
        }}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        onScroll={(e) => { if (backdropRef.current) backdropRef.current.scrollTop = e.target.scrollTop }}
      />
    </div>
  )
}

function ImageGenBody({ data, onPatch }) {
  const out = data.output
  const imgs = Array.isArray(out?.images) ? out.images : (out?.image_url ? [{ url: out.image_url }] : [])
  const status = data.status || 'idle'
  const aspect =
    data.props?.aspect === '9:16' ? '9/16'
    : data.props?.aspect === '16:9' ? '16/9'
    : data.props?.aspect === '4:3' ? '4/3'
    : data.props?.aspect === '3:4' ? '3/4' : '1/1'

  const removeAt = (i) => {
    const next = imgs.filter((_, j) => j !== i)
    if (typeof window !== 'undefined' && window.__spacePatchOutput) {
      window.__spacePatchOutput(data.__id, { ...out, images: next })
    }
  }

  return (
    <>
      <div style={{
        position: 'relative',
        aspectRatio: aspect,
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
          <MediaItem
            url={imgs[0].url}
            type="image"
            from={data.name || 'image'}
            onDelete={() => removeAt(0)}
            rounded={0}
          />
        ) : (
          <ImageIcon size={26} style={{ color: 'var(--muted)' }} />
        )}
        {imgs.length > 1 && (
          <div style={{
            position: 'absolute', top: 6, left: 6,
            background: 'rgba(0,0,0,0.55)', color: '#fff',
            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
            pointerEvents: 'none', zIndex: 4,
          }}>{imgs.length}</div>
        )}
      </div>

      <MentionPrompt
        value={data.props?.prompt || ''}
        onChange={(v) => onPatch({ prompt: v })}
        placeholder='Describe the image. Type @ to tag a brand profile or reference image.'
        minHeight={60}
        brands={data?._ctxProfiles || []}
        namedImages={data?._ctxNamedImages || []}
      />

      <div style={pillRow}>
        <select style={pillSelect} value={data.props?.model || 'nano-banana-2'} onChange={(e) => onPatch({ model: e.target.value })}>
          <option value="nano-banana-2">Nano Banana 2</option>
          <option value="nano-banana-pro">Nano Banana Pro</option>
          <option value="gpt-2">GPT 2.0</option>
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
            <MediaItem key={i} url={im.url} type="image" from={data.name || 'image'} aspectRatio="1/1" rounded={4} onDelete={() => removeAt(i)} />
          ))}
        </div>
      )}

      {imgs.length > 0 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); imgs.forEach((im, i) => downloadUrl(im.url, `${(data.name || 'image').replace(/\W+/g, '-')}-${i + 1}.png`)) }}
          style={{
            marginTop: 8, width: '100%', padding: '6px 8px', fontSize: 11,
            background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
            color: 'var(--text)', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}
        ><Download size={11} /> Download {imgs.length > 1 ? `all ${imgs.length}` : ''}</button>
      )}

      <NodePreview status={status} output={imgs.length ? null : out} error={data.error} />
    </>
  )
}

// ─── 5. IMAGE UPLOAD (reference images) ─────────────────────────────────────
// Normalize image_upload props.urls — supports legacy strings and new
// {url, name} objects. Always returns {url, name}[] with sensible default
// names so the @-mention resolver can match against them.
export function readImageItems(props) {
  const arr = Array.isArray(props?.urls) ? props.urls : []
  return arr.map((x, i) => {
    if (typeof x === 'string') return { url: x, name: `image ${i + 1}` }
    if (x && typeof x === 'object' && x.url) return { url: x.url, name: x.name || `image ${i + 1}` }
    return null
  }).filter(Boolean)
}

function ImageUploadBody({ data, onPatch }) {
  const inpRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [editingIdx, setEditingIdx] = useState(-1)
  const [draftName, setDraftName] = useState('')
  const items = readImageItems(data.props)
  const profileId = data?._ctxProfileId

  async function onPick(e) {
    const files = Array.from(e.target.files || [])
    if (!files.length || !profileId) return
    setBusy(true); setErr(null)
    try {
      const next = [...items]
      for (const f of files) {
        const u = await uploadImageToBucket(f, profileId)
        next.push({ url: u, name: `image ${next.length + 1}` })
      }
      onPatch({ urls: next })
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
      if (inpRef.current) inpRef.current.value = ''
    }
  }
  function remove(idx) {
    onPatch({ urls: items.filter((_, j) => j !== idx) })
  }
  function commitName(idx) {
    const trimmed = (draftName || '').trim() || `image ${idx + 1}`
    onPatch({ urls: items.map((it, j) => j === idx ? { ...it, name: trimmed } : it) })
    setEditingIdx(-1); setDraftName('')
  }

  return (
    <>
      {items.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 8 }}>
          {items.map((it, idx) => (
            <div key={`${it.url}-${idx}`} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ position: 'relative', aspectRatio: '1', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
                <img src={it.url} alt={it.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <button
                  onClick={(e) => { e.stopPropagation(); remove(idx) }}
                  style={{
                    position: 'absolute', top: 2, right: 2,
                    background: 'rgba(0,0,0,0.6)', color: '#fff',
                    border: 'none', borderRadius: 999, width: 18, height: 18,
                    cursor: 'pointer', fontSize: 10, display: 'grid', placeItems: 'center',
                  }}
                  aria-label="Remove">×</button>
              </div>
              {editingIdx === idx ? (
                <input
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={() => commitName(idx)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitName(idx); if (e.key === 'Escape') { setEditingIdx(-1); setDraftName('') } }}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    fontSize: 10, padding: '2px 4px',
                    background: 'var(--surface)', color: 'var(--text)',
                    border: '1px solid var(--red)', borderRadius: 4, outline: 'none',
                    fontFamily: 'inherit',
                  }}
                />
              ) : (
                <div
                  onDoubleClick={(e) => { e.stopPropagation(); setEditingIdx(idx); setDraftName(it.name) }}
                  title={`@${it.name.replace(/\s+/g, '')} — double-click to rename`}
                  style={{
                    fontSize: 10, padding: '2px 4px', borderRadius: 4,
                    color: 'var(--muted)', textAlign: 'center',
                    cursor: 'text', userSelect: 'none',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >@{it.name.replace(/\s+/g, '')}</div>
              )}
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
        {busy ? 'Uploading…' : items.length ? 'Add more images' : 'Upload reference images'}
      </button>
      <input ref={inpRef} type="file" multiple accept="image/*" onChange={onPick} style={{ display: 'none' }} />
      {err && <div style={{ marginTop: 6, color: 'var(--red)', fontSize: 11 }}>{err}</div>}
    </>
  )
}

// ─── AUTO-RUN (recurring trigger) ───────────────────────────────────────────
// Distinct from social "schedule" — Auto-run fires the workflow on a recurring
// interval while the canvas is open in a tab. Each tick calls runFromNode
// on this node, which cascades through every connected descendant.
//
// Cost-aware: shows an estimate per run derived from the chain (script gen,
// image gen, avatar render). Hard cap on max_runs prevents runaway spend.

export const AUTORUN_OPTIONS = [
  { id: '1m',  label: 'Every 1 minute (testing)',  ms: 60_000,        warn: true },
  { id: '5m',  label: 'Every 5 minutes',           ms: 300_000 },
  { id: '15m', label: 'Every 15 minutes',          ms: 900_000 },
  { id: '30m', label: 'Every 30 minutes',          ms: 1_800_000 },
  { id: '1h',  label: 'Every hour',                ms: 3_600_000 },
  { id: '6h',  label: 'Every 6 hours',             ms: 21_600_000 },
  { id: '24h', label: 'Once a day',                ms: 86_400_000 },
]

// Rough per-run cost in ai_tokens for budget hint. Avatar render uses
// video_units, tracked separately, but we count an avg cost in tokens for
// the warning UI.
export const NODE_COST_HINT = {
  text_input:    0,
  image_upload:  0,
  brand_profile: 200,
  auto_run:      0,
  script_gen:    3000,
  caption_gen:   2500,
  image_gen:     4000,    // per image
  avatar_picker: 0,
  avatar_render: 8000,    // ~30s clip equivalent
  collection:    0,
  save_library:  0,
}

function AutoRunBody({ data, onPatch }) {
  const cadence = data.props?.cadence || '15m'
  const maxRuns = Number(data.props?.max_runs ?? 10)
  const runsUsed = Number(data.props?.runs_used ?? 0)
  const active = !!data.props?.active
  const lastRun = data.props?.last_run_at
  const remaining = Math.max(0, maxRuns - runsUsed)

  const opt = AUTORUN_OPTIONS.find((o) => o.id === cadence) || AUTORUN_OPTIONS[2]
  const estPerRun = Number(data?._ctxCostPerRun ?? 0)

  const toggle = () => {
    if (!active) {
      // Starting fresh — reset run counter so user can re-run after hitting cap.
      onPatch({ active: true, runs_used: 0, last_run_at: null })
    } else {
      onPatch({ active: false })
    }
  }
  const reset = () => onPatch({ runs_used: 0, last_run_at: null, active: false })

  return (
    <>
      <NodeField label="Cadence">
        <select
          style={tinyInput}
          value={cadence}
          onChange={(e) => onPatch({ cadence: e.target.value })}
          disabled={active}
        >
          {AUTORUN_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </NodeField>
      <NodeField label="Stop after N runs">
        <input
          type="number"
          min={1}
          max={1000}
          style={tinyInput}
          value={maxRuns}
          onChange={(e) => onPatch({ max_runs: Math.max(1, Number(e.target.value) || 1) })}
          disabled={active}
        />
      </NodeField>

      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); toggle() }}
        style={{
          width: '100%', marginTop: 8, padding: '8px 10px',
          fontSize: 12, fontFamily: 'var(--font-display)', fontWeight: 700,
          letterSpacing: '0.04em',
          border: 'none', borderRadius: 8, cursor: 'pointer',
          background: active ? 'rgba(46,204,113,0.16)' : 'var(--red)',
          color: active ? '#2ecc71' : '#fff',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}
      >
        {active ? <><Pause size={12} /> Active — running every {opt.label.replace('Every ', '').replace(' (testing)', '')}</> : <><Play size={12} /> Start auto-run</>}
      </button>

      <div style={{ marginTop: 8, fontSize: 10.5, lineHeight: 1.5, color: 'var(--muted)' }}>
        <div>Runs used: <strong style={{ color: 'var(--text)' }}>{runsUsed} / {maxRuns}</strong> ({remaining} left)</div>
        {estPerRun > 0 && (
          <div>Est. cost / run: <strong style={{ color: 'var(--text)' }}>~{estPerRun.toLocaleString()}</strong> AI tokens. Total budget for this batch: ~{(estPerRun * remaining).toLocaleString()}.</div>
        )}
        {lastRun && <div>Last run: {new Date(lastRun).toLocaleTimeString()}</div>}
        {opt.warn && active && (
          <div style={{ color: 'var(--amber)', marginTop: 4 }}>Testing cadence — this burns credits fast. Stop when you're done verifying.</div>
        )}
        {!active && runsUsed > 0 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); reset() }}
            style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 10.5, padding: 0, marginTop: 4, textDecoration: 'underline' }}
          >Reset counter</button>
        )}
      </div>
      <div style={{ marginTop: 8, fontSize: 10, color: 'var(--muted)', lineHeight: 1.4 }}>
        Cadence runs only while this canvas is open. Closing the tab pauses auto-run.
      </div>
    </>
  )
}

// ─── BRAND PROFILE ──────────────────────────────────────────────────────────
function BrandProfileBody({ data, onPatch }) {
  const profiles = data?._ctxProfiles || []
  const out = data.output?.brand
  const syncAll = !!data.props?.sync_all

  const toggleSyncAll = (next) => {
    onPatch({ sync_all: next })
    if (typeof window !== 'undefined' && window.__spaceSyncBrandAll) {
      window.__spaceSyncBrandAll(data.__id, next)
    }
  }

  return (
    <>
      <NodeField label="Profile">
        <select
          style={tinyInput}
          value={data.props?.profile_id || ''}
          onChange={(e) => onPatch({ profile_id: e.target.value })}
        >
          <option value="">Pick a brand profile…</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.business_name}</option>
          ))}
        </select>
      </NodeField>
      <label style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginTop: 4, padding: '8px 10px',
        background: syncAll ? 'rgba(236,72,153,0.12)' : 'var(--surface-2)',
        border: `1px solid ${syncAll ? '#ec4899' : 'var(--border)'}`,
        borderRadius: 6, cursor: 'pointer', fontSize: 11.5,
      }}>
        <input
          type="checkbox"
          checked={syncAll}
          onChange={(e) => toggleSyncAll(e.target.checked)}
          style={{ accentColor: '#ec4899' }}
        />
        <span style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11 }}>Sync to all</div>
          <div style={{ color: 'var(--muted)', fontSize: 10.5, marginTop: 1 }}>Auto-connect this brand to every node with a Brand input, now and going forward.</div>
        </span>
      </label>
      {/* Errors only — no descriptive preview, the dropdown + sync toggle
          are the whole UI. */}
      {data.status === 'failed' && (
        <NodePreview status="failed" error={data.error} />
      )}
    </>
  )
}

// ─── 6. AVATAR PICKER ───────────────────────────────────────────────────────
function AvatarPickerBody({ data, onPatch }) {
  const avatars = data?._ctxAvatars || []
  const publicAvatars = data?._ctxPublicAvatars || []
  const currentId = data.props?.avatar_id || ''
  const isPublic = currentId.startsWith('pub:')
  const selected = isPublic
    ? publicAvatars.find((g) => `pub:${g.id || g.group_id}` === currentId)
    : avatars.find((a) => a.id === currentId)
  const looks = !isPublic ? (selected?.looks || []) : []
  const trainingStatus = !isPublic ? selected?.training_status : null
  const trainingMsg = trainingStatus && !['ready', 'completed', 'success'].includes(trainingStatus)
    ? (trainingStatus === 'training'
        ? 'HeyGen is still processing this avatar. Renders will fail until training completes.'
        : `Training status: ${trainingStatus}. Renders will fail; re-create the avatar.`)
    : null
  return (
    <>
      <NodeField label="Avatar">
        <select style={tinyInput} value={currentId} onChange={(e) => onPatch({ avatar_id: e.target.value, look_id: '' })}>
          <option value="">Pick an avatar…</option>
          {avatars.length > 0 && <optgroup label="My avatars">
            {avatars.map((a) => {
              const tag = a.training_status && !['ready', 'completed', 'success'].includes(a.training_status)
                ? ` — ${a.training_status}` : ''
              return <option key={a.id} value={a.id}>{a.name} ({(a.model_version || 'v4').toUpperCase()}){tag}</option>
            })}
          </optgroup>}
          {publicAvatars.length > 0 && <optgroup label="HeyGen library">
            {publicAvatars.map((g) => {
              const id = g.id || g.group_id
              const name = g.group_name || g.name || 'Stock avatar'
              return <option key={`pub-${id}`} value={`pub:${id}`}>{name}</option>
            })}
          </optgroup>}
        </select>
      </NodeField>
      {trainingMsg && (
        <div style={{ marginTop: 4, padding: '6px 8px', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.5)', borderRadius: 6, fontSize: 11, color: 'var(--amber)' }}>
          {trainingMsg}
        </div>
      )}
      <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.4 }}>
        {isPublic
          ? 'Uses HeyGen\'s default voice for this avatar.'
          : (selected?.elevenlabs_voice_id
              ? 'Uses the voice set on this avatar in the Avatars page.'
              : 'No voice set yet. Open the Avatars page to assign a default voice.')}
      </div>
      {looks.length > 1 && (
        <NodeField label="Look">
          <select style={tinyInput} value={data.props?.look_id || ''} onChange={(e) => onPatch({ look_id: e.target.value })}>
            <option value="">Default</option>
            {looks.map((l) => <option key={l.id} value={l.id}>Look {l.angle_order ?? ''}</option>)}
          </select>
        </NodeField>
      )}
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
        <>
          <MediaItem url={out.video_url} type="video" from={data.name || 'video'} aspectRatio="9/16" />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); downloadUrl(out.video_url, `${(data.name || 'video').replace(/\W+/g, '-')}.mp4`) }}
            style={{
              marginTop: 8, width: '100%', padding: '6px 8px', fontSize: 11,
              background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
              color: 'var(--text)', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
          ><Download size={11} /> Download video</button>
        </>
      )}
      <NodePreview status={data.status} output={out?.video_url ? null : out} error={data.error} />
    </>
  )
}

// ─── 8. COLLECTION (catches scripts/images/videos into a list) ──────────────
function CollectionBody({ data }) {
  const items = Array.isArray(data.output?.items) ? data.output.items : []
  const isRunning = data.status === 'running'
  // Empty + idle → friendly placeholder. Empty + running → small "gathering…"
  // pill so the canvas isn't blank. With items → always show the grid, even
  // mid-run, with a tiny refreshing indicator on top.
  if (!items.length && !isRunning) {
    return <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Connect any output here. New items appear automatically when an upstream node finishes.</div>
  }
  if (!items.length && isRunning) {
    return <div style={{ fontSize: 11.5, color: 'var(--amber)' }}><Loader2 size={11} className="spin" style={{ verticalAlign: '-1px', marginRight: 6 }} /> Gathering…</div>
  }

  const removeItem = (idx) => {
    const next = items.filter((_, j) => j !== idx)
    if (typeof window !== 'undefined' && window.__spacePatchOutput) {
      window.__spacePatchOutput(data.__id, { ...data.output, items: next })
    }
  }

  const downloadable = items.filter((it) => it.url && (it.kind === 'image' || it.kind === 'video'))

  return (
    <>
      {isRunning && (
        <div style={{
          marginBottom: 6, fontSize: 10.5, color: 'var(--amber)',
          fontFamily: 'var(--font-display)', fontWeight: 700,
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>
          <Loader2 size={10} className="spin" style={{ verticalAlign: '-1px', marginRight: 5 }} />
          Refreshing — current items still shown
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
        {items.slice(0, 24).map((it, i) => (
          <div key={i} style={{
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            borderRadius: 6, padding: 6, fontSize: 10.5, lineHeight: 1.4,
            color: 'var(--text-soft)', overflow: 'hidden',
          }}>
            {(it.kind === 'image' || it.kind === 'video') && it.url ? (
              <div style={{ marginBottom: 4 }}>
                <MediaItem
                  url={it.url}
                  type={it.kind}
                  from={it.from || 'collection'}
                  aspectRatio="1/1"
                  rounded={4}
                  onDelete={() => removeItem(i)}
                />
              </div>
            ) : null}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ flex: 1, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {it.kind === 'library' ? 'library' : it.kind} · {it.from}
              </div>
              {it.kind === 'library' && it.status && (
                <span style={{
                  fontSize: 9, padding: '1px 6px', borderRadius: 999,
                  fontFamily: 'var(--font-display)', fontWeight: 700,
                  background: it.status === 'published' ? 'rgba(46,204,113,0.18)'
                    : it.status === 'scheduled' ? 'rgba(168,85,247,0.18)'
                    : it.status === 'deleted' ? 'rgba(239,68,68,0.18)'
                    : 'var(--surface-3)',
                  color: it.status === 'published' ? '#2ecc71'
                    : it.status === 'scheduled' ? '#a855f7'
                    : it.status === 'deleted' ? 'var(--red)'
                    : 'var(--muted)',
                }}>{it.status}</span>
              )}
              {!it.url && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); removeItem(i) }}
                  title="Remove"
                  style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 2 }}
                ><Trash2 size={10} /></button>
              )}
            </div>
            {it.text && <div style={{ maxHeight: 40, overflow: 'hidden' }}>{String(it.text).slice(0, 90)}…</div>}
            {it.kind === 'library' && it.platforms?.length > 0 && (
              <div style={{ marginTop: 2, fontSize: 9.5, color: 'var(--muted)' }}>{it.platforms.join(' · ')}</div>
            )}
          </div>
        ))}
      </div>

      {downloadable.length > 0 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); downloadable.forEach((it, i) => downloadUrl(it.url, `${(data.name || 'collection').replace(/\W+/g, '-')}-${i + 1}.${it.kind === 'video' ? 'mp4' : 'png'}`)) }}
          style={{
            marginTop: 8, width: '100%', padding: '6px 8px', fontSize: 11,
            background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
            color: 'var(--text)', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}
        ><Download size={11} /> Download all media ({downloadable.length})</button>
      )}
    </>
  )
}

// ─── COMBINE (bundle text + media into a unified post package) ─────────────
// Two modes:
//   'post' (default): aggregates incoming script + caption + hashtags +
//     image(s) + video into one post object that save_library writes as a
//     single library row tagged with whatever platforms the user picks.
//   'avatar_video': uses an incoming photo + script (or uploaded audio)
//     to produce an avatar talking-photo video via HeyGen. (Stub for now —
//     requires a pre-trained photo avatar; pointer message in the body.)
//
// Either way, downstream nodes get one output that save_library can
// decompose into title / script / caption / hashtags / media_urls.
function CombineBody({ data, onPatch }) {
  const mode = data.props?.mode || 'post'
  const out = data.output
  const summary = []
  if (out?.full_script) summary.push(`Script: ${String(out.full_script).slice(0, 60).replace(/\s+/g, ' ')}…`)
  if (out?.caption)     summary.push(`Caption: ${String(out.caption).slice(0, 60).replace(/\s+/g, ' ')}…`)
  if (out?.hashtags)    summary.push(`Tags: ${out.hashtags}`)
  if (out?.video_url)   summary.push('Video attached')
  if (Array.isArray(out?.images) && out.images.length) summary.push(`${out.images.length} image${out.images.length === 1 ? '' : 's'}`)
  return (
    <>
      <NodeField label="Mode">
        <select style={tinyInput} value={mode} onChange={(e) => onPatch({ mode: e.target.value })}>
          <option value="post">Post bundle (text + media)</option>
          <option value="avatar_video">Avatar video (photo + script/audio)</option>
        </select>
      </NodeField>
      <NodeField label="Title (optional)">
        <input style={tinyInput} placeholder="Auto-derived from script" value={data.props?.title || ''} onChange={(e) => onPatch({ title: e.target.value })} />
      </NodeField>
      {mode === 'avatar_video' && (
        <div style={{ marginTop: 4, padding: '8px 10px', background: 'rgba(14,165,233,0.12)', border: '1px solid rgba(14,165,233,0.4)', borderRadius: 6, fontSize: 11, color: '#0ea5e9', lineHeight: 1.45 }}>
          Wire a photo (image_upload, image_gen, or brand logo) + script + optional Avatar voice. HeyGen creates a talking photo from the image and renders the script. Voice falls back to the brand's default if not provided.
        </div>
      )}
      {summary.length > 0 && (
        <div style={{ ...previewBox, marginTop: 8 }}>
          {summary.map((s, i) => <div key={i}>{s}</div>)}
        </div>
      )}
      <NodePreview status={data.status} output={summary.length ? null : out} error={data.error} />
    </>
  )
}

// ─── 9. SAVE TO LIBRARY ─────────────────────────────────────────────────────
const PLATFORMS = [
  { id: 'instagram', label: 'Instagram', kinds: ['image', 'video'] },
  { id: 'tiktok',    label: 'TikTok',    kinds: ['video'] },
  { id: 'youtube',   label: 'YouTube',   kinds: ['video'] },
  { id: 'x',         label: 'X',         kinds: ['text', 'image', 'video'] },
  { id: 'threads',   label: 'Threads',   kinds: ['text', 'image', 'video'] },
  { id: 'linkedin',  label: 'LinkedIn',  kinds: ['text', 'image', 'video'] },
  { id: 'facebook',  label: 'Facebook',  kinds: ['text', 'image', 'video'] },
]

function SaveBody({ data, onPatch }) {
  const platforms = Array.isArray(data.props?.platforms) ? data.props.platforms : []
  const synced = Array.isArray(data?._ctxSyncedPlatforms) ? data._ctxSyncedPlatforms : []
  const detectedKind = data?._ctxDetectedKind || 'text'  // image | video | text — derived upstream
  const togglePlatform = (id) => {
    const next = platforms.includes(id) ? platforms.filter((p) => p !== id) : [...platforms, id]
    onPatch({ platforms: next })
  }

  // Validate compatibility between detected media kind and selected platforms.
  const incompatible = platforms.filter((id) => {
    const def = PLATFORMS.find((p) => p.id === id)
    return def && !def.kinds.includes(detectedKind)
  })

  const visiblePlatforms = synced.length
    ? PLATFORMS.filter((p) => synced.includes(p.id))
    : PLATFORMS

  return (
    <>
      <NodeField label="Title (optional)">
        <input style={tinyInput} placeholder="Auto-derived" value={data.props?.title || ''} onChange={(e) => onPatch({ title: e.target.value })} />
      </NodeField>
      <NodeField label="Status">
        <select style={tinyInput} value={data.props?.status || 'draft'} onChange={(e) => onPatch({ status: e.target.value })}>
          <option value="draft">Draft (needs approval before scheduling)</option>
          <option value="caption_ready">Ready to schedule (auto-fills next slot)</option>
        </select>
      </NodeField>
      <NodeField label="Schedule for">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {visiblePlatforms.map((p) => {
            const on = platforms.includes(p.id)
            const compatible = p.kinds.includes(detectedKind)
            return (
              <button
                key={p.id}
                type="button"
                onClick={(e) => { e.stopPropagation(); togglePlatform(p.id) }}
                disabled={!compatible}
                title={compatible ? '' : `${p.label} doesn't support ${detectedKind} content`}
                style={{
                  fontSize: 10.5, padding: '4px 9px', borderRadius: 999,
                  border: `1px solid ${on ? '#2ecc71' : 'var(--border)'}`,
                  background: on ? 'rgba(46,204,113,0.16)' : 'var(--surface-2)',
                  color: on ? '#2ecc71' : 'var(--text-soft)',
                  opacity: compatible ? 1 : 0.4,
                  cursor: compatible ? 'pointer' : 'not-allowed',
                  fontFamily: 'var(--font-display)', fontWeight: 700,
                }}
              >{p.label}</button>
            )
          })}
        </div>
        {synced.length === 0 && (
          <div style={{ marginTop: 6, fontSize: 10, color: 'var(--amber)', lineHeight: 1.4 }}>
            No social accounts synced yet. Connect platforms in Settings to publish; for now the choice is just a tag.
          </div>
        )}
        {incompatible.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 10, color: 'var(--red)', lineHeight: 1.4 }}>
            {incompatible.map((id) => PLATFORMS.find((p) => p.id === id)?.label).join(', ')} won’t accept {detectedKind} content. Run will reject.
          </div>
        )}
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
    inputs: [], outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { text: '' },
    Body: TextInputBody,
    run: async ({ data }) => ({ text: data.props?.text || '' }),
  },

  image_upload: {
    label: 'Reference images', description: 'Upload images to use as references in image gen. Each image gets an editable name (default "image 1", "image 2"). Reference specific ones in a generator prompt with @-mentions, e.g. "she is at @office holding @logo".',
    icon: Upload, category: 'inputs', color: '#0ea5e9',
    inputs: [], outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { urls: [] },
    Body: ImageUploadBody,
    run: async ({ data }) => {
      const items = readImageItems(data.props)
      return { images: items.map(({ url, name }) => ({ url, name })) }
    },
  },

  auto_run: {
    label: 'Auto-run', description: 'Recurring trigger that re-runs everything connected downstream on a fixed cadence. Cost-aware with a hard cap on total runs. Pauses when the canvas is closed.',
    icon: Repeat, category: 'inputs', color: '#f97316',
    inputs: [], outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { cadence: '15m', max_runs: 10, runs_used: 0, active: false, last_run_at: null },
    Body: AutoRunBody,
    run: async ({ data }) => ({ tick: new Date().toISOString(), run_index: Number(data.props?.runs_used || 0) + 1 }),
  },

  brand_profile: {
    label: 'Brand profile', description: 'Pulls in a brand profile (voice, audience, brand bible, hashtags) to use as context for downstream generators.',
    icon: Building2, category: 'inputs', color: '#ec4899',
    inputs: [], outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { profile_id: '' },
    Body: BrandProfileBody,
    run: async ({ data, ctx }) => {
      const id = data.props?.profile_id
      if (!id) throw new Error('Pick a brand profile')
      const r = await fetch('/api/profiles', {
        headers: { Authorization: `Bearer ${ctx.token}` },
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      const p = (body.profiles || []).find((x) => x.id === id)
      if (!p) throw new Error('Profile not accessible')
      return {
        brand: {
          profile_id: p.id,
          name: p.business_name || '',
          voice: p.preferred_tone || '',
          audience: p.target_audience || '',
          brandBible: p.brand_bible || '',
          hashtags: p.core_hashtags || '',
          industry: p.industry || '',
          logo_url: p.logo_url || '',
          primary_color: p.brand_primary_color || '',
          secondary_color: p.brand_secondary_color || '',
        },
      }
    },
  },

  script_gen: {
    label: 'Script generator', description: 'Claude writes a script from a topic. Supports @-mentions and an optional brand profile input.',
    icon: Wand2, category: 'generators', color: '#ef4444',
    inputs: [{ id: 'in', label: 'In (topic / brand)' }],
    outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { format: 'tiktok-script', topic: '' },
    Body: ScriptGenBody,
    run: async ({ data, inputs, inputsByName, ctx }) => {
      const incoming = inputs?.in
      const brand = pickBrand(incoming)
      let topic = (data.props?.topic || '').trim() || pickScript(incoming)
      if (!topic) throw new Error('No topic / text provided')
      topic = expandMentions(topic, inputsByName)
      // @brand-mention takes priority — wires the script gen to that brand
      // profile's bible/voice without needing a brand_profile node.
      const mentioned = resolveBrandMention(topic, ctx.profiles)
      const profileId = mentioned?.id || brand?.profile_id || ctx.profileId
      topic = stripBrandMentions(topic, ctx.profiles)
      const r = await fetch('/api/content/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({ profile_id: profileId, format: data.props?.format || 'tiktok-script', topic, count: 1 }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      const item = body.items?.[0]
      if (!item) throw new Error('No item returned')
      return { script: item.full_script || '', title: item.title || '', _content_id: item.id }
    },
  },

  caption_gen: {
    label: 'Caption + hashtags', description: 'Generates a platform caption AND hashtag block from a script. Optional brand profile input.',
    icon: Captions, category: 'generators', color: '#f59e0b',
    inputs: [{ id: 'in', label: 'In (script / brand)' }],
    outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { platform: 'instagram', hashtag_count: 10 },
    Body: CaptionGenBody,
    run: async ({ data, inputs, ctx }) => {
      const incoming = inputs?.in
      const script = pickScript(incoming)
      if (!script) throw new Error('No script provided')
      const platform = data.props?.platform || 'instagram'
      const count = data.props?.hashtag_count || 10
      const brand = pickBrand(incoming)
      const profileId = brand?.profile_id || ctx.profileId
      const r = await fetch('/api/content/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: profileId,
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
    label: 'Image generator', description: 'KIE image gen (Nano Banana, Flux). Aspect, count, quality. The single In handle accepts brand context, text prompts, AND reference images — they\'re sorted by shape.',
    icon: ImageIcon, category: 'generators', color: '#a855f7',
    inputs: [{ id: 'in',  label: 'In (prompt / brand / refs)' }],
    outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { prompt: '', model: 'nano-banana-2', aspect: '1:1', count: 1, quality: '2K' },
    Body: ImageGenBody,
    run: async ({ data, inputs, inputsByName, ctx }) => {
      const incoming = inputs?.in
      // Prompt: prefer the node's own prompt prop; if blank, fall back to any
      // text-shaped value from upstream.
      let prompt = (data.props?.prompt || '').trim() || pickScript(incoming)
      if (!prompt) throw new Error('Prompt required')
      prompt = expandMentions(prompt, inputsByName)

      // Brand context: prefer the connected brand_profile node's output, or
      // fall back to any @brand mention in the prompt resolved against the
      // user's profiles list.
      let brand = pickBrand(incoming)
      const mentioned = !brand && resolveBrandMention(prompt, ctx.profiles)
      if (mentioned) {
        // Hydrate a brand context object from the matched profile.
        brand = {
          profile_id: mentioned.id,
          name:        mentioned.business_name || '',
          voice:       mentioned.preferred_tone || '',
          audience:    mentioned.target_audience || '',
          industry:    mentioned.industry || '',
          logo_url:    mentioned.logo_url || '',
          primary_color:   mentioned.brand_primary_color || '',
          secondary_color: mentioned.brand_secondary_color || '',
        }
      }
      // Strip @brand tokens from the prompt before sending to KIE.
      prompt = stripBrandMentions(prompt, ctx.profiles)
      if (brand) {
        const bits = []
        if (brand.name) bits.push(`Brand: ${brand.name}`)
        if (brand.industry) bits.push(`Industry: ${brand.industry}`)
        if (brand.voice) bits.push(`Voice/style: ${String(brand.voice).slice(0, 200)}`)
        if (brand.audience) bits.push(`Audience: ${String(brand.audience).slice(0, 160)}`)
        if (brand.primary_color) bits.push(`Primary color ${brand.primary_color}`)
        if (bits.length) prompt = `${bits.join('. ')}.\n\n${prompt}`
      }

      // Build a name → url map of every named upstream image. Then either
      // honor the @-mentions in the prompt (only those images are sent as
      // refs) or fall back to all upstream images if no @-mentions match.
      const namedImages = []
      for (const v of asArr(incoming)) {
        if (v && Array.isArray(v.images)) {
          for (const im of v.images) {
            if (im?.url) namedImages.push({ url: im.url, name: (im.name || '').trim() })
          }
        }
      }
      const tokens = [...new Set(
        Array.from((data.props?.prompt || '').matchAll(/@(?:"([^"]+)"|([A-Za-z0-9_-]+))/g))
          .map((m) => (m[1] || m[2] || '').toLowerCase().replace(/\s+/g, ''))
      )].filter(Boolean)
      let refs = []
      if (tokens.length) {
        for (const tok of tokens) {
          const hit = namedImages.find((im) => (im.name || '').toLowerCase().replace(/\s+/g, '') === tok)
          if (hit) refs.push(hit.url)
        }
      }
      // No matches by name → fall back to every reference image we received.
      if (!refs.length) refs = pickImageUrls(incoming)

      // If the prompt mentions "logo" / "brand mark" and a connected brand
      // profile has a logo_url, auto-attach it as a reference image so the
      // model can place / style it correctly.
      const mentionsLogo = /\b(logo|brand\s*mark)\b/i.test(prompt)
      if (mentionsLogo && brand?.logo_url && !refs.includes(brand.logo_url)) {
        refs.push(brand.logo_url)
      }

      // Strip @-mentions from the prompt before sending to KIE — image
      // models don't parse them and the raw "@image1" text confuses
      // Gemini-based providers. We've already pulled the matching URLs
      // into `refs`, so replace each token with a neutral phrase.
      prompt = prompt.replace(/@(?:"([^"]+)"|([A-Za-z0-9_-]+))/g, (_, q, b) => {
        const name = (q || b || '').trim()
        return name ? `the reference image "${name}"` : 'the reference image'
      })

      const profileForCall = brand?.profile_id || ctx.profileId
      const submitR = await fetch('/api/images/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: profileForCall,
          prompt,
          model: data.props?.model || 'nano-banana',
          count: data.props?.count || 1,
          aspect: data.props?.aspect || '1:1',
          quality: data.props?.quality || '2K',
          reference_urls: refs.length ? refs : undefined,
        }),
      })
      const submit = await submitR.json()
      if (!submitR.ok) throw new Error(submit.error || `Failed (${submitR.status})`)
      const taskId = submit.taskId
      if (!taskId) throw new Error('No taskId returned')

      // Client-side poll up to 5 minutes — keeps each Vercel call short.
      const start = Date.now()
      while (Date.now() - start < 300_000) {
        await new Promise((r) => setTimeout(r, 3000))
        const sR = await fetch(`/api/images/status?taskId=${encodeURIComponent(taskId)}&profile_id=${encodeURIComponent(profileForCall)}`, {
          headers: { Authorization: `Bearer ${ctx.token}` },
        })
        const s = await sR.json()
        if (!sR.ok) throw new Error(s.error || `Status check failed (${sR.status})`)
        if (s.state === 'success') return { images: s.images || [] }
        if (s.state === 'failed') throw new Error(s.error || 'Generation failed')
      }
      throw new Error('Image generation timed out')
    },
  },

  avatar_picker: {
    label: 'Avatar', description: 'Pick the avatar to use. Voice comes from the avatar itself: HeyGen library avatars use their default voice; custom avatars use the voice set on the Avatars page.',
    icon: UserCircle2, category: 'inputs', color: '#60a5fa',
    inputs: [], outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { avatar_id: '', look_id: '', model_version: '' },
    Body: AvatarPickerBody,
    run: async ({ data }) => {
      const { avatar_id, look_id, model_version } = data.props || {}
      if (!avatar_id) throw new Error('Pick an avatar')
      return {
        avatar: {
          avatar_id,
          look_id: look_id || null,
          // voice_id is intentionally omitted: the render endpoint resolves
          // it from the avatar row (custom) or the HeyGen group (public).
          model_version: model_version || null,
        },
      }
    },
  },

  avatar_render: {
    label: 'Avatar render', description: 'HeyGen renders the avatar speaking the script. Wire BOTH the script and the avatar config into the single In handle.',
    icon: FileVideo, category: 'generators', color: '#ef4444',
    inputs: [{ id: 'in',  label: 'In (script + avatar)' }],
    outputs: [{ id: 'out', label: 'Out' }],
    initialProps: {},
    Body: AvatarRenderBody,
    run: async ({ inputs, ctx }) => {
      const incoming = inputs?.in
      const script = pickScript(incoming)
      if (!script) throw new Error('No script provided')
      const avatar = pickAvatarConfig(incoming)
      if (!avatar?.avatar_id) throw new Error('Connect an Avatar picker')
      // voice_id is no longer required from the picker — the render
      // endpoint resolves it from the avatar row (custom) or HeyGen group
      // (public) defaults.
      const r = await fetch('/api/avatars/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          avatar_id: avatar.avatar_id, script,
          voice_id: avatar.voice_id || undefined,
          look_id: avatar.look_id || undefined, model_version: avatar.model_version || undefined,
          profile_id: ctx.profileId,
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
    label: 'Collection', description: 'Catches outputs from any connected node and gathers them into a growing list (scripts, images, videos). Accumulates across runs — every time an upstream node re-runs, new items are appended (deduped by URL/text).',
    icon: ListChecks, category: 'outputs', color: '#10b981',
    inputs: [{ id: 'in', label: 'In (anything)' }],
    outputs: [{ id: 'out', label: 'Out' }],
    initialProps: {},
    Body: CollectionBody,
    run: async ({ data, inputs }) => {
      const incoming = []
      const collect = (val, from = '') => {
        if (val == null) return
        if (Array.isArray(val)) { val.forEach((v) => collect(v, from)); return }
        if (typeof val === 'string') { incoming.push({ kind: 'text', text: val, from }); return }
        // Save-to-library outputs carry { content_id, platforms, media_type } —
        // surface them as a single library item so the canvas reflects the
        // saved row's status when we later sync publish/delete events.
        if (val.content_id) {
          incoming.push({
            kind: 'library',
            content_id: val.content_id,
            from,
            status: 'draft',
            media_type: val.media_type || null,
            platforms: val.platforms || null,
          })
          return
        }
        if (val.video_url) { incoming.push({ kind: 'video', url: val.video_url, from }); return }
        if (val.url) { incoming.push({ kind: 'image', url: val.url, from }); return }
        if (val.script) { incoming.push({ kind: 'script', text: val.script, from }); return }
        if (val.text) { incoming.push({ kind: 'text', text: val.text, from }); return }
        if (val.caption) { incoming.push({ kind: 'caption', text: val.caption, from }); return }
        if (val.images) { collect(val.images, from); return }
      }
      for (const [key, val] of Object.entries(inputs || {})) collect(val, key)

      // Merge with whatever was already in the collection (preserved across runs)
      // so each upstream re-run appends to the list rather than replacing it.
      const prev = Array.isArray(data?.output?.items) ? data.output.items : []
      const out = []
      const seen = new Set()
      for (const list of [prev, incoming]) {
        for (const it of list) {
          const key = `${it.kind}:${(it.content_id || it.url || it.text || '').toString().slice(0, 200)}`
          if (seen.has(key)) continue
          seen.add(key); out.push(it)
        }
      }
      return { items: out }
    },
  },

  combine: {
    label: 'Combine', description: 'Bundles incoming text (script / caption / hashtags) and media (image / video) into a single post package the save_library node can persist as one library row. Avatar-video mode reserved for a near-future update.',
    icon: CombineIcon, category: 'generators', color: '#0ea5e9',
    inputs: [{ id: 'in', label: 'In (text + media)' }],
    outputs: [{ id: 'out', label: 'Out (post)' }],
    initialProps: { mode: 'post', title: '' },
    Body: CombineBody,
    run: async ({ data, inputs, ctx }) => {
      const arr = asArr(inputs?.in)
      const mode = data.props?.mode || 'post'

      // Sift incoming values by shape — text bits, media URLs, brand, etc.
      let script = ''
      let caption = ''
      let hashtags = ''
      let videoUrl = null
      const images = []
      let avatarConfig = null
      let brandObj = null
      for (const v of arr) {
        if (!v) continue
        if (typeof v === 'string') { if (!script) script = v; continue }
        if (typeof v !== 'object') continue
        if (v.brand) brandObj = brandObj || v.brand
        if (v.script || v.full_script) script = script || v.script || v.full_script
        if (v.caption) caption = caption || v.caption
        if (v.hashtags) hashtags = hashtags || v.hashtags
        if (v.video?.video_url) videoUrl = videoUrl || v.video.video_url
        if (v.video_url) videoUrl = videoUrl || v.video_url
        if (Array.isArray(v.images)) for (const im of v.images) { if (im?.url) images.push({ url: im.url, name: im.name }) }
        else if (v.url) images.push({ url: v.url })
        if (v.avatar?.avatar_id) avatarConfig = v.avatar
      }

      // ── Avatar-video mode: photo + script → HeyGen V3 talking-photo ────
      if (mode === 'avatar_video') {
        if (!script) throw new Error('Avatar-video mode needs a script (wire script_gen, text_input, or a string into "in").')
        const photoUrl = images[0]?.url
        if (!photoUrl) throw new Error('Avatar-video mode needs a photo (image_upload, image_gen output, or brand logo). Wire one in.')
        const profileId = brandObj?.profile_id || ctx.profileId
        const voiceId = avatarConfig?.voice_id || brandObj?.voice_id || undefined
        const submitR = await fetch('/api/avatars/photo-render', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
          body: JSON.stringify({
            profile_id: profileId,
            photo_url: photoUrl,
            script,
            voice_id: voiceId,
            model_version: avatarConfig?.model_version || 'v4',
          }),
        })
        const submit = await submitR.json()
        if (!submitR.ok) throw new Error(submit.error || `Photo render submit failed (${submitR.status})`)
        const videoId = submit.video_id
        if (!videoId) throw new Error('No video id returned')

        // Poll up to 8 minutes — HeyGen renders typically take 1-4.
        const start = Date.now()
        while (Date.now() - start < 480_000) {
          await new Promise((r) => setTimeout(r, 6000))
          const sR = await fetch(`/api/avatars/photo-render-status?video_id=${encodeURIComponent(videoId)}`, {
            headers: { Authorization: `Bearer ${ctx.token}` },
          })
          const s = await sR.json()
          if (!sR.ok) throw new Error(s.error || `Status check failed (${sR.status})`)
          if (s.state === 'success') {
            return {
              full_script: script,
              caption,
              hashtags,
              video_url: s.video_url,
              media_type: 'video',
              title: (data.props?.title || '').trim() || script.slice(0, 60) || 'Avatar video',
              combined: true,
            }
          }
          if (s.state === 'failed') throw new Error(s.error || 'Render failed')
        }
        throw new Error('Avatar video render timed out')
      }

      const title = (data.props?.title || '').trim()
        || (script.slice(0, 60))
        || 'Untitled post'

      const media_type = videoUrl ? 'video' : (images.length ? 'image' : 'text')
      // Shape mirrors what save_library already understands so the wiring
      // stays one-step: Combine.out → save_library.in.
      return {
        title,
        full_script: script,
        caption,
        hashtags,
        video_url: videoUrl || undefined,
        images: images.length ? images : undefined,
        media_type,
        combined: true,
      }
    },
  },

  save_library: {
    label: 'Save to library', description: 'Bundles the incoming script + caption + hashtags + media into one library entry, tagged with the platforms you chose. Accepts script, caption + hashtags, image(s), or video — whatever upstream nodes are wired.',
    icon: Save, category: 'outputs', color: '#2ecc71',
    inputs: [{ id: 'in', label: 'In (script / caption / image / video)' }],
    outputs: [],
    initialProps: { title: '', status: 'draft', platforms: [] },
    Body: SaveBody,
    run: async ({ data, inputs, ctx }) => {
      const arr = asArr(inputs?.in)
      let script = '', caption = '', hashtags = '', videoUrl = null, incomingTitle = ''
      const imageUrls = []
      for (const v of arr) {
        if (!v) continue
        if (typeof v === 'string') { if (!script) script = v; continue }
        if (typeof v !== 'object') continue
        // Combine node passes a pre-bundled package — use its title if our
        // own props.title is empty.
        if (v.combined && v.title) incomingTitle = incomingTitle || v.title
        if (v.script || v.full_script) script = script || v.script || v.full_script
        if (v.caption) caption = caption || v.caption
        if (v.hashtags) hashtags = hashtags || v.hashtags
        if (v.video?.video_url) videoUrl = videoUrl || v.video.video_url
        if (v.video_url) videoUrl = videoUrl || v.video_url
        if (Array.isArray(v.images)) for (const im of v.images) { if (im?.url) imageUrls.push(im.url) }
        else if (v.url) imageUrls.push(v.url)
      }
      const title = data.props?.title?.trim() || incomingTitle || (script.slice(0, 60)) || 'Untitled'
      const mediaUrls = videoUrl ? [videoUrl] : (imageUrls.length ? imageUrls : null)
      const mediaType = videoUrl ? 'video' : (imageUrls.length ? 'image' : 'text')
      const platforms = Array.isArray(data.props?.platforms) && data.props.platforms.length
        ? data.props.platforms
        : null
      // Validate compatibility — refuse to save if any selected platform
      // can't accept the produced media kind. Surfaces in the node's red
      // error state, doesn't burn cycles trying to schedule garbage.
      if (platforms?.length) {
        const bad = platforms.filter((id) => {
          const def = PLATFORMS.find((p) => p.id === id)
          return def && !def.kinds.includes(mediaType)
        })
        if (bad.length) {
          const names = bad.map((id) => PLATFORMS.find((p) => p.id === id)?.label || id).join(', ')
          throw new Error(`${names} can't accept ${mediaType} content. Remove it or change what's wired in.`)
        }
      }
      const postType = mediaType === 'video' ? 'video' : (mediaType === 'image' ? 'post' : 'post')
      const r = await fetch('/api/content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: ctx.profileId, title, full_script: script, caption, hashtags,
          media_urls: mediaUrls, media_type: mediaType,
          post_type: postType,
          platforms,
          status: data.props?.status || 'draft', generated_by: 'space',
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      return { content_id: body.item?.id, platforms, media_type: mediaType }
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
      // sourceHandle 'out' = pass the whole result. Legacy/specific handles
      // still look up the matching key (with first-key fallback).
      const value = e.sourceHandle === 'out'
        ? sourceOut
        : (sourceOut[e.sourceHandle] ?? sourceOut[Object.keys(sourceOut)[0]])
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
