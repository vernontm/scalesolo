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

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Type, Wand2, Captions, UserCircle2, Save, Image as ImageIcon,
  ListChecks, FileVideo, Upload, Loader2, Maximize2, ArrowUpRight,
  Download, Trash2, Building2, Repeat, Play, Pause, Combine as CombineIcon,
  Mic, Sparkles, Send,
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
    const norm = tok.replace(/^@"?|"?$/g, '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
    const hit = profiles.find((p) => (p.business_name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '') === norm)
    if (hit) return hit
  }
  return null
}

// Replace @brand-name tokens with the brand's actual business_name so
// downstream models read natural prose ("infographic of Vernon Tech & Media
// explaining…") instead of bare strips like "infographic of  explaining".
// Tokens that don't resolve to a brand are left untouched for image-ref
// resolution upstream.
function expandBrandMentions(text, profiles) {
  if (!text) return text
  const byNorm = new Map(
    (profiles || [])
      .filter((p) => p.business_name)
      .map((p) => [(p.business_name || '').toLowerCase().replace(/[^a-z0-9_-]/g, ''), p.business_name])
  )
  return String(text).replace(/@(?:"([^"]+)"|([A-Za-z0-9_-]+))/g, (full, q, b) => {
    const norm = (q || b || '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
    return byNorm.has(norm) ? byNorm.get(norm) : full
  })
}
// Backwards alias — old script_gen call still uses this name.
const stripBrandMentions = expandBrandMentions

function pickAudio(v) {
  for (const x of asArr(v)) {
    if (x && typeof x === 'object' && x.audio?.url) return x.audio
    if (x && typeof x === 'object' && x.url && /\.(mp3|wav|m4a|ogg)(?:\?|$)/i.test(x.url)) return x
  }
  return null
}

// Returns the first video URL found in an array of upstream input values.
// Handles every shape the canvas produces:
//   { video: { video_url } }                avatar_render single / video_polish / combine_videos success
//   { video_url }                           loose
//   { videos: [{ video_url }, …] }          avatar_render randomize OR combine_videos playlist fallback
//   { items: [{ kind:'video', url }, …] }   collection
function pickFirstVideoUrl(arr) {
  for (const v of asArr(arr)) {
    if (!v || typeof v !== 'object') continue
    if (v.video?.video_url) return v.video.video_url
    if (v.video_url) return v.video_url
    if (Array.isArray(v.videos)) {
      for (const c of v.videos) if (c?.video_url) return c.video_url
    }
    if (Array.isArray(v.items)) {
      for (const it of v.items) if (it?.kind === 'video' && it.url) return it.url
    }
  }
  return null
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
    const key = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '')
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
// Read a File as a data URL.
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.readAsDataURL(file)
  })
}

// Rasterize an SVG to a PNG data URL. KIE's image models reject SVG.
async function svgToPngDataUrl(file) {
  const src = await fileToDataUrl(file)
  const img = await new Promise((res, rej) => {
    const i = new Image()
    i.onload = () => res(i)
    i.onerror = () => rej(new Error('Could not parse SVG'))
    i.src = src
  })
  const w = Math.max(256, img.naturalWidth || 1024)
  const h = Math.max(256, img.naturalHeight || w)
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  c.getContext('2d').drawImage(img, 0, 0, w, h)
  return c.toDataURL('image/png')
}

async function uploadImageToBucket(file, profileId) {
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || '')
  const dataUrl = isSvg ? await svgToPngDataUrl(file) : await fileToDataUrl(file)
  const fileName = isSvg ? (file.name || 'image').replace(/\.svg$/i, '') + '.png' : (file.name || `image-${Date.now()}.png`)
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
      fileName,
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
  const format = data.props?.format || 'tiktok-script'
  // Length picker only makes sense for spoken-script formats. Other
  // formats (caption, thread, blog) are governed by per-format hints.
  const showLengthPicker = format === 'tiktok-script' || format === 'youtube-short'
  const lenSecs = Number(data.props?.target_length_secs ?? 45)
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
        <select style={pillSelect} value={format} onChange={(e) => onPatch({ format: e.target.value })}>
          <option value="tiktok-script">TikTok</option>
          <option value="ig-post">Instagram</option>
          <option value="thread">Thread</option>
          <option value="youtube-short">YT Short</option>
          <option value="email-subject">Email subj</option>
          <option value="blog-post">Blog post</option>
        </select>
        {showLengthPicker && (
          <select
            style={pillSelect}
            value={lenSecs}
            onChange={(e) => onPatch({ target_length_secs: Number(e.target.value) })}
            title="Target script length in seconds (Claude pads/trims to roughly hit it)"
          >
            <option value={15}>~15 sec</option>
            <option value={30}>~30 sec</option>
            <option value={45}>~45 sec</option>
            <option value={60}>~60 sec</option>
            <option value={90}>~90 sec</option>
            <option value={120}>~2 min</option>
          </select>
        )}
      </div>
      <NodePreview status={data.status} output={data.output} error={data.error} />
    </>
  )
}

// ─── 3. CAPTION + HASHTAGS (merged) ─────────────────────────────────────────
function CaptionGenBody({ data }) {
  // Show a per-platform summary once it's run. Each platform's variant is
  // ready to flow into schedule_post — the connector picks the right one
  // based on its selected platforms.
  const out = data.output
  const variants = out?.per_platform || {}
  return (
    <>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 6, lineHeight: 1.4 }}>
        Connect a script. Generates a <strong>title, caption, and 5 hashtags</strong> tuned for every platform — TikTok, Instagram, YouTube, X, LinkedIn — in one call. Schedule_post automatically picks the variant for whichever platforms it's set to publish to.
      </div>
      {Object.keys(variants).length > 0 && (
        <div style={{ ...previewBox, marginTop: 6, fontSize: 10.5 }}>
          {Object.entries(variants).slice(0, 5).map(([p, v]) => (
            <div key={p} style={{ marginBottom: 4 }}>
              <strong style={{ textTransform: 'capitalize' }}>{p}:</strong>{' '}
              <span style={{ color: 'var(--muted)' }}>{v?.caption?.slice(0, 60) || '—'}…</span>
            </div>
          ))}
        </div>
      )}
      <NodePreview status={data.status} output={Object.keys(variants).length ? null : out} error={data.error} />
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
  // Strip every non-token char (anything besides letters, digits, _, -) so
  // brands like "VernonTech & Media" produce a clean "@VernonTechMedia"
  // tag the parser can match end-to-end.
  const tagFor = (name) => `@${(name || '').replace(/[^A-Za-z0-9_-]/g, '')}`
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
    return (it.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').startsWith(suggest.prefix)
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
            <button key={`b-${b.id}`} type="button" className="nodrag" onClick={(e) => { e.stopPropagation(); insertTag(b.name) }} title={`Insert ${tagFor(b.name)} — references this brand profile`} style={chipStyle('brand')}>
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
        <div className="nodrag" style={{
          position: 'absolute', left: 0, right: 0, top: '100%',
          marginTop: 2, zIndex: 50,
          background: 'var(--surface)', border: '1px solid var(--border-strong)',
          borderRadius: 8, boxShadow: 'var(--shadow-pop)',
          maxHeight: 220, overflow: 'auto',
        }}>
          {filtered.map((it) => (
            <button
              key={it.key}
              type="button"
              className="nodrag"
              // mousedown.preventDefault keeps the textarea focused so the
              // selection range stays valid when insertTag reads it. The
              // actual insert fires on click for reliability.
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
              onClick={(e) => { e.stopPropagation(); insertTag(it.name) }}
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
  const brandSet = new Set((brands || []).map((b) => (b.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '')))
  const imageSet = new Set((namedImages || []).map((im) => (im.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '')))

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
    const norm = tok.replace(/^@"?|"?$/g, '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
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
                    border: `1px solid ${s.kind === 'brand' ? 'rgba(236,72,153,0.45)' : 'rgba(168,85,247,0.45)'}`,
                    borderRadius: 999,
                    padding: '0 7px',
                    fontWeight: 700,
                    fontFamily: 'var(--font-display)',
                    margin: '0 1px',
                    whiteSpace: 'nowrap',
                  }}
                >{s.text}</span>
          )}
      </div>
      <textarea
        ref={textareaRef}
        className="nodrag"
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
            <MediaItem key={im.url || `i-${i}`} url={im.url} type="image" from={data.name || 'image'} aspectRatio="1/1" rounded={4} onDelete={() => removeAt(i)} />
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
  combine_videos: 1500,
  video_polish:  1500,
  captions:      2000,    // ZapCap caption render
  schedule_post: 100,
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
          className="nodrag"
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
          className="nodrag"
          min={1}
          max={1000}
          step={1}
          style={tinyInput}
          value={maxRuns}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10)
            onPatch({ max_runs: Number.isFinite(n) ? Math.max(1, Math.min(1000, n)) : 1 })
          }}
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

// Direct image → landing-media upload used by the polish editor's
// "upload watermark" button. Different from uploadImageToBucket above
// (which goes through /api/images/upload-reference for prompt-ref images).
async function uploadLogoToBucket(file, profileId, kind = 'logos') {
  const ext = (file.name.split('.').pop() || 'png').toLowerCase()
  const safeExt = ['png', 'jpg', 'jpeg', 'webp', 'svg'].includes(ext) ? ext : 'png'
  const path = `${profileId || 'shared'}/${kind}/${Date.now()}.${safeExt}`
  const { error } = await supabase.storage.from('landing-media').upload(path, file, {
    contentType: file.type || 'image/png', upsert: false,
  })
  if (error) throw new Error(`Upload failed: ${error.message}`)
  const { data } = supabase.storage.from('landing-media').getPublicUrl(path)
  return data.publicUrl
}

// ─── AUDIO UPLOAD ───────────────────────────────────────────────────────────
async function uploadAudioToBucket(file, profileId) {
  const ext = (file.name.split('.').pop() || 'mp3').toLowerCase()
  const path = `${profileId || 'shared'}/audio/${Date.now()}.${ext}`
  const { error } = await supabase.storage.from('landing-media').upload(path, file, {
    contentType: file.type || 'audio/mpeg', upsert: false,
  })
  if (error) throw new Error(`Upload failed: ${error.message}`)
  const { data } = supabase.storage.from('landing-media').getPublicUrl(path)
  return data.publicUrl
}

function AudioUploadBody({ data, onPatch }) {
  const inpRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const profileId = data?._ctxProfileId
  const url = data.props?.url
  const name = data.props?.name || ''

  async function onPick(e) {
    const file = e.target.files?.[0]
    if (!file || !profileId) return
    setBusy(true); setErr(null)
    try {
      const u = await uploadAudioToBucket(file, profileId)
      onPatch({ url: u, name: file.name })
    } catch (e) { setErr(e.message) }
    finally { setBusy(false); if (inpRef.current) inpRef.current.value = '' }
  }
  function clear() { onPatch({ url: '', name: '' }) }

  return (
    <>
      {url ? (
        <>
          <audio src={url} controls style={{ width: '100%', marginBottom: 8 }} />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); clear() }}
            style={{ ...tinyInput, cursor: 'pointer', background: 'transparent', color: 'var(--muted)', textAlign: 'center', fontSize: 11 }}
          >Remove</button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => inpRef.current?.click()}
          disabled={busy}
          style={{
            ...tinyInput, cursor: 'pointer', display: 'flex',
            alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px',
            background: 'var(--surface-2)', borderStyle: 'dashed',
          }}>
          {busy ? <Loader2 size={13} className="spin" /> : <Mic size={13} />}
          {busy ? 'Uploading…' : 'Upload audio (MP3 / WAV / M4A)'}
        </button>
      )}
      <input ref={inpRef} type="file" accept="audio/*" onChange={onPick} style={{ display: 'none' }} />
      {err && <div style={{ marginTop: 6, color: 'var(--red)', fontSize: 11 }}>{err}</div>}
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
          <div style={{ color: 'var(--muted)', fontSize: 10.5, marginTop: 1 }}>Auto-connect this brand to every node with a Brand input.</div>
        </span>
      </label>

      {/* What pieces of the brand to actually inject downstream. Each space
          can dial these independently — three brand_profile nodes for the
          same brand can each pass a different slice. */}
      <div style={{ marginTop: 10, fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--font-display)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Pass to downstream nodes
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 4 }}>
        {[
          ['voice_audience', 'Voice + audience'],
          ['theme',          'Colors + fonts'],
          ['logo',           'Logo (image)'],
          ['bible',          'Brand bible text'],
          ['hashtags',       'Core hashtags'],
        ].map(([key, label]) => {
          const inject = data.props?.inject || { voice_audience: true, theme: true, logo: true, bible: true, hashtags: true }
          const on = inject[key] !== false
          return (
            <label key={key} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 8px', borderRadius: 6,
              background: on ? 'rgba(236,72,153,0.10)' : 'var(--surface-2)',
              border: `1px solid ${on ? 'rgba(236,72,153,0.4)' : 'var(--border)'}`,
              cursor: 'pointer', fontSize: 10.5,
            }}>
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => onPatch({ inject: { ...inject, [key]: e.target.checked } })}
                style={{ accentColor: '#ec4899' }}
              />
              <span style={{ color: on ? 'var(--text)' : 'var(--text-soft)' }}>{label}</span>
            </label>
          )
        })}
      </div>

      {data.status === 'failed' && (
        <NodePreview status="failed" error={data.error} />
      )}
    </>
  )
}

// ─── 6. AVATAR PICKER ───────────────────────────────────────────────────────
function AvatarPickerBody({ data, onPatch }) {
  const avatars = data?._ctxAvatars || []
  const currentId = data.props?.avatar_id || ''
  const selected = avatars.find((a) => a.id === currentId)
  const looks = selected?.looks || []
  const lookId = data.props?.look_id || ''
  const look = looks.find((l) => l.id === lookId) || looks[0]
  const lookImages = (look?.images || []).slice().sort((a, b) => (a.order_index || 0) - (b.order_index || 0))
  // Image strategy within a look: 'single' = use the picked image_id every
  // time; 'randomize' = use all images in the look (avatar_render splits
  // the script across them). Migrate the old standalone 'cycle_looks'
  // value to mode='randomize' + cycle_looks=true so existing spaces stay
  // functional after the orthogonal toggle split.
  const rawMode = data.props?.mode || 'single'
  const mode = rawMode === 'cycle_looks' ? 'randomize' : rawMode
  const cycleLooks = !!data.props?.cycle_looks || rawMode === 'cycle_looks'
  const imageId = data.props?.image_id || (lookImages[0]?.id || '')

  // Cycle-looks runtime state, populated by run() and persisted on the
  // node's output. Surfaced here as "Look 3 of 5" so the user can see
  // where the queue is.
  const cycle = data?.output?.cycle_state
  const cycleLookCount = Array.isArray(cycle?.queue) ? cycle.queue.length : 0
  const cycleProgressLabel = cycle && cycleLookCount
    ? `Look ${Math.min(cycle.cursor + 1, cycleLookCount)} of ${cycleLookCount}`
    : null

  // Auto-write defaults to props as soon as data is hydrated. Otherwise the
  // picker shows "Look 1" and a thumbnail visually but the underlying props
  // stay { look_id: null, image_id: null }, and run-time reads those nulls
  // (instead of the visual default) — that's what was causing "Randomize
  // mode needs a look" right after dragging in the picker.
  useEffect(() => {
    if (!selected) return
    const patch = {}
    if (!data.props?.look_id && looks[0]?.id) patch.look_id = looks[0].id
    if (mode === 'single' && !data.props?.image_id && lookImages[0]?.id) {
      patch.image_id = lookImages[0].id
      patch.image_url = lookImages[0].image_url
    }
    if (Object.keys(patch).length) onPatch(patch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, look?.id, mode])

  const trainingStatus = selected?.training_status
  const trainingMsg = trainingStatus && !['ready', 'completed', 'success'].includes(trainingStatus)
    ? (trainingStatus === 'training'
        ? 'HeyGen is still processing this avatar. Renders will fail until training completes.'
        : `Training status: ${trainingStatus}. Renders will fail; re-create the avatar.`)
    : null

  return (
    <>
      <NodeField label="Avatar">
        <select
          className="nodrag"
          style={tinyInput}
          value={currentId}
          onChange={(e) => onPatch({ avatar_id: e.target.value, look_id: '', image_id: '' })}
        >
          <option value="">Pick an avatar…</option>
          {avatars.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </NodeField>

      {trainingMsg && (
        <div style={{ marginTop: 4, padding: '6px 8px', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.5)', borderRadius: 6, fontSize: 11, color: 'var(--amber)' }}>
          {trainingMsg}
        </div>
      )}

      {looks.length > 0 && (
        <NodeField label="Look">
          <select
            className="nodrag"
            style={tinyInput}
            value={look?.id || ''}
            onChange={(e) => onPatch({ look_id: e.target.value, image_id: '' })}
            disabled={cycleLooks}
            title={cycleLooks ? 'Cycle looks is on — the runtime picks a look each tick.' : ''}
          >
            {looks.map((l, i) => <option key={l.id} value={l.id}>{l.name || `Look ${i + 1}`} ({l.images?.length || 0})</option>)}
          </select>
        </NodeField>
      )}

      {looks.length > 1 && (
        <NodeField label="Cycle looks">
          <button
            type="button"
            className="nodrag"
            onClick={(e) => { e.stopPropagation(); onPatch({ cycle_looks: !cycleLooks, ...(rawMode === 'cycle_looks' ? { mode: 'randomize' } : {}) }) }}
            title="Each workflow run picks a different look from this avatar's set, then reshuffles after the last."
            style={{
              width: '100%', padding: '6px 10px', borderRadius: 6, fontSize: 11,
              border: `1px solid ${cycleLooks ? 'var(--red)' : 'var(--border)'}`,
              background: cycleLooks ? 'rgba(239,68,68,0.16)' : 'var(--surface-2)',
              color: cycleLooks ? 'var(--red)' : 'var(--text-soft)',
              cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}
          >
            <span>{cycleLooks ? `On — rotates ${looks.length} looks per run` : `Off — uses one fixed look`}</span>
            <span style={{ fontSize: 10, opacity: 0.8 }}>{cycleLooks ? '✓' : ''}</span>
          </button>
        </NodeField>
      )}

      {lookImages.length > 0 && (
        <>
          <NodeField label="Image strategy">
            <div style={{ display: 'flex', gap: 4 }}>
              {[
                ['single', 'Single image'],
                lookImages.length > 1 && ['randomize', `Randomize ${lookImages.length} imgs`],
              ].filter(Boolean).map(([k, label]) => {
                const on = mode === k
                return (
                  <button
                    key={k}
                    type="button"
                    className="nodrag"
                    onClick={(e) => { e.stopPropagation(); onPatch({ mode: k }) }}
                    style={{
                      flex: 1, padding: '6px 8px', borderRadius: 6, fontSize: 11,
                      border: `1px solid ${on ? 'var(--red)' : 'var(--border)'}`,
                      background: on ? 'rgba(239,68,68,0.16)' : 'var(--surface-2)',
                      color: on ? 'var(--red)' : 'var(--text-soft)',
                      cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700,
                    }}
                  >{label}</button>
                )
              })}
            </div>
          </NodeField>

          {!cycleLooks && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginTop: 4 }}>
              {lookImages.map((im) => {
                const isPicked = mode === 'single' ? imageId === im.id : true
                return (
                  <button
                    key={im.id}
                    type="button"
                    className="nodrag"
                    onClick={(e) => { e.stopPropagation(); if (mode === 'single') onPatch({ image_id: im.id, image_url: im.image_url }) }}
                    title={mode === 'single' ? 'Use this image' : 'Included in randomization'}
                    style={{
                      aspectRatio: '1', padding: 0, borderRadius: 4, cursor: mode === 'single' ? 'pointer' : 'default',
                      border: `2px solid ${isPicked && mode === 'single' ? 'var(--red)' : 'transparent'}`,
                      background: 'transparent', overflow: 'hidden',
                      opacity: mode === 'randomize' || isPicked ? 1 : 0.55,
                    }}
                  >
                    <img src={im.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}

      {selected && lookImages.length === 0 && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>
          This avatar has no images yet. Add some on the Avatars page.
        </div>
      )}

      {cycleLooks && cycleProgressLabel && (
        <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 6, background: 'rgba(96,165,250,0.10)', border: '1px solid rgba(96,165,250,0.35)', fontSize: 11, color: '#60a5fa', lineHeight: 1.4 }}>
          {cycleProgressLabel} — next run advances. Reshuffles after the last look.
        </div>
      )}

      <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.4 }}>
        {selected?.elevenlabs_voice_id
          ? 'Uses the voice set on this avatar in the Avatars page.'
          : 'No voice set yet. Open the Avatars page to assign a default voice.'}
      </div>
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
          <div key={`${it.kind}:${it.url || it.text || it.content_id || i}`} style={{
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

// ─── COMBINE VIDEOS — concat a clip set into one stitched video ─────────────
function CombineVideosBody({ data }) {
  const out = data.output
  const status = data.status || 'idle'
  if (status === 'running') return <NodePreview status="running" />

  // Successful stitch.
  if (out?.video?.video_url) {
    return (
      <>
        <MediaItem url={out.video.video_url} type="video" from={data.name || 'combined'} aspectRatio="9/16" />
        <button
          type="button"
          className="nodrag"
          onClick={(e) => { e.stopPropagation(); downloadUrl(out.video.video_url, 'combined.mp4') }}
          style={{
            marginTop: 8, width: '100%', padding: '6px 8px', fontSize: 11,
            background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
            color: 'var(--text)', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}
        ><Download size={11} /> Download stitched video</button>
      </>
    )
  }

  // Fallback: server combine wasn't available. Show every clip as a
  // download-able tile so the user can still salvage the run.
  if (Array.isArray(out?.videos) && out.videos.length) {
    return (
      <>
        <div style={{
          marginBottom: 8, padding: '6px 8px', fontSize: 10.5, lineHeight: 1.45,
          background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)',
          borderRadius: 6, color: 'var(--amber)',
        }}>
          {out.combine_unavailable || 'Stitching unavailable. Clips preserved below — download each.'}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
          {out.videos.map((c, i) => (
            <MediaItem
              key={c.video_url || i}
              url={c.video_url}
              type="video"
              from={`clip ${i + 1}`}
              aspectRatio="9/16"
              rounded={4}
            />
          ))}
        </div>
        <button
          type="button"
          className="nodrag"
          onClick={(e) => { e.stopPropagation(); out.videos.forEach((c, i) => downloadUrl(c.video_url, `clip-${i + 1}.mp4`)) }}
          style={{
            marginTop: 8, width: '100%', padding: '6px 8px', fontSize: 11,
            background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
            color: 'var(--text)', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}
        ><Download size={11} /> Download all {out.videos.length} clips</button>
      </>
    )
  }

  return <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Wire an Avatar render (Randomize mode) or a Collection of videos in. Run to stitch them in order.</div>
}

// ─── VIDEO POLISH (subtitles + watermark + bg music in one ffmpeg pass) ────
//
// Polish has so many knobs (title fonts/colors, caption styling, watermark
// position, music level + fade) that cramming them into the node card makes
// it unreadable. The card body is a thin summary with an "Open settings"
// button. The full editor lives in a right-side drawer rendered by Spaces —
// see VideoPolishEditor below + the NodeEditorDrawer in Spaces.jsx.
const POLISH_FONT_OPTIONS = [
  'Montserrat ExtraBold', 'Poppins ExtraBold', 'Inter ExtraBold',
  'Bebas Neue', 'Anton', 'Oswald', 'Roboto Black', 'Sans',
]

// Dropdown label → CSS { family, weight } pair. The labels include the
// weight (e.g. "Montserrat ExtraBold") for human readability, but CSS
// `font-family` wants just the family name + a numeric weight. Without
// this mapping the browser silently falls back to its default sans
// because no installed face matches "Montserrat ExtraBold".
function polishFontCss(label) {
  switch (label) {
    case 'Montserrat ExtraBold': return { family: '"Montserrat", sans-serif',     weight: 800 }
    case 'Poppins ExtraBold':    return { family: '"Poppins", sans-serif',        weight: 800 }
    case 'Inter ExtraBold':      return { family: '"Inter", sans-serif',          weight: 800 }
    case 'Bebas Neue':           return { family: '"Bebas Neue", sans-serif',     weight: 400 }
    case 'Anton':                return { family: '"Anton", sans-serif',          weight: 400 }
    case 'Oswald':               return { family: '"Oswald", sans-serif',         weight: 700 }
    case 'Roboto Black':         return { family: '"Roboto", sans-serif',         weight: 900 }
    default:                     return { family: 'system-ui, sans-serif',        weight: 800 }
  }
}

function VideoPolishBody({ data, onPatch }) {
  const out = data.output
  const props = data.props || {}
  const status = data.status || 'idle'
  // Spaces.jsx injects these via renderNodes — they let the body show a
  // live overlay preview without reaching back into ReactFlow's nodes/edges.
  const upstreamVideo = data._ctxUpstreamVideoUrl || null
  const upstreamScript = data._ctxUpstreamScript || ''
  const upstreamLogo = data._ctxUpstreamLogoUrl || null
  const previewLogo = props.watermark_image_url || upstreamLogo
  const previewVideo = out?.video_url || upstreamVideo
  return (
    <>
      {/* Inline live preview — same composited DOM the drawer uses, scaled to fit. */}
      <VideoPolishPreview
        videoUrl={previewVideo}
        script={upstreamScript}
        props={props}
        logoUrl={previewLogo}
      />
      <div style={{ marginTop: 6, marginBottom: 8, fontSize: 10, color: 'var(--muted)', textAlign: 'center', lineHeight: 1.3 }}>
        {previewVideo ? 'Live preview — overlays update as you edit' : 'Run an upstream node to see the preview frame'}
      </div>
      <button
        type="button"
        className="nodrag"
        onClick={(e) => { e.stopPropagation(); window.__spaceOpenEditor?.(data.__id) }}
        style={{
          width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 10px', background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 7, color: 'var(--text)', cursor: 'pointer', fontSize: 11.5,
          fontFamily: 'var(--font-display)', fontWeight: 700, marginBottom: 6,
        }}
      >
        <span><Sparkles size={11} style={{ verticalAlign: '-2px', marginRight: 6, color: '#0ea5e9' }} /> Open settings</span>
        <ArrowUpRight size={11} style={{ color: 'var(--muted)' }} />
      </button>
      <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.35 }}>
        Title: <strong>{
          props.title_enabled === false ? 'off'
          : (props.title_mode || 'auto') === 'auto' ? 'auto'
          : (props.title || 'manual').slice(0, 18)
        }</strong>
        {' · '}Logo: <strong>{(props.watermark_position || 'br') === 'none' ? 'off' : `${props.watermark_size_pct ?? 25}%`}</strong>
        {' · '}Music: <strong>{Math.round((Number(props.music_volume ?? 0.15)) * 100)}%</strong>
      </div>
      <NodePreview status={status} output={null} error={data.error} />
    </>
  )
}

// Walks the wired-input tree backward from the polish node to find the
// closest already-rendered video so the editor can show a real frame in
// its live preview. Returns null until at least one upstream node has run.
export function findUpstreamVideoUrl(nodeId, nodes, edges) {
  if (!nodeId || !Array.isArray(nodes) || !Array.isArray(edges)) return null
  const seen = new Set([nodeId])
  const queue = [nodeId]
  while (queue.length) {
    const cur = queue.shift()
    for (const e of edges) {
      if (e.target !== cur || seen.has(e.source)) continue
      seen.add(e.source)
      const src = nodes.find((n) => n.id === e.source)
      if (!src) continue
      const out = src.data?.output
      const url =
        out?.video?.video_url ||
        out?.video_url ||
        (Array.isArray(out?.videos) && out.videos[0]?.video_url) ||
        null
      if (url) return url
      queue.push(e.source)
    }
  }
  return null
}

export function findUpstreamScript(nodeId, nodes, edges) {
  if (!nodeId) return ''
  const seen = new Set([nodeId])
  const queue = [nodeId]
  while (queue.length) {
    const cur = queue.shift()
    for (const e of edges) {
      if (e.target !== cur || seen.has(e.source)) continue
      seen.add(e.source)
      const src = nodes.find((n) => n.id === e.source)
      if (!src) continue
      const out = src.data?.output
      if (typeof out === 'string' && out.length) return out
      if (out?.full_script) return out.full_script
      if (out?.script) return out.script
      if (src.data?.type === 'text_input' && src.data?.props?.text) return src.data.props.text
      queue.push(e.source)
    }
  }
  return ''
}

export function findUpstreamLogoUrl(nodeId, nodes, edges) {
  if (!nodeId) return null
  const seen = new Set([nodeId])
  const queue = [nodeId]
  while (queue.length) {
    const cur = queue.shift()
    for (const e of edges) {
      if (e.target !== cur || seen.has(e.source)) continue
      seen.add(e.source)
      const src = nodes.find((n) => n.id === e.source)
      if (!src) continue
      const out = src.data?.output
      if (out?.brand?.logo_url) return out.brand.logo_url
      if (Array.isArray(out?.images) && out.images[0]?.url) return out.images[0].url
      queue.push(e.source)
    }
  }
  return null
}

// Tiny labelled slider used throughout the editor sections.
function PolishSlider({ label, value, min, max, step = 1, suffix = '', onChange }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
        <span>{label}</span>
        <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{value}{suffix}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#3b82f6' }}
      />
    </div>
  )
}

function PolishColorRow({ label, value, onChange }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={labelStyle}>{label}</div>
      <input
        type="color" value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%', height: 36, padding: 0, border: '1px solid var(--border)',
          borderRadius: 6, background: 'var(--surface-2)', cursor: 'pointer',
        }}
      />
    </div>
  )
}

function PolishSection({ icon: Icon, title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 14 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 12,
          background: 'transparent', border: 'none', color: 'var(--text)',
          cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700,
          fontSize: 11.5, letterSpacing: '0.06em', textTransform: 'uppercase', padding: 0,
        }}
      >
        {Icon && <Icon size={13} style={{ color: 'var(--muted)' }} />} {title}
      </button>
      {open && children}
    </div>
  )
}

// Build the live preview overlays as plain DOM/CSS so the user sees
// title/captions/logo placement instantly without needing a render.
function VideoPolishPreview({ videoUrl, props, logoUrl }) {
  const titleEnabled = props.title_enabled !== false && !!props.title
  return (
    <div style={{
      position: 'relative', width: '100%', aspectRatio: '9/16',
      background: '#000', borderRadius: 10, overflow: 'hidden',
      border: '1px solid var(--border)',
    }}>
      {videoUrl ? (
        <video
          src={videoUrl}
          muted playsInline preload="metadata"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <div style={{
          position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
          color: 'var(--muted)', fontSize: 11, padding: 12, textAlign: 'center',
        }}>Run an upstream node once to see the preview frame.</div>
      )}
      {/* Title overlay */}
      {titleEnabled && (() => {
        const f = polishFontCss(props.title_font || 'Montserrat ExtraBold')
        return (
          <div style={{
            position: 'absolute', left: '50%', top: `${props.title_y_pos ?? 15}%`,
            transform: 'translate(-50%, -50%)',
            padding: `${(props.title_bg_padding ?? 28) * 0.25}px ${(props.title_bg_padding ?? 28) * 0.4}px`,
            background: props.title_bg_color || '#e0467a',
            color: props.title_color || '#ffffff',
            fontFamily: f.family,
            fontSize: `${(props.title_size ?? 72) * 0.18}px`,
            fontWeight: f.weight, letterSpacing: '0.01em',
            borderRadius: 4, textAlign: 'center', maxWidth: '85%',
            textTransform: props.title_uppercase ? 'uppercase' : 'none',
            lineHeight: 1.1, whiteSpace: 'normal',
          }}>{props.title}</div>
        )
      })()}
      {/* Caption indicator — actual caption look comes from ZapCap, so we
         just show a "captions on, style: <name>" badge instead of trying
         to mimic a style we don't control. */}
      {props.captions_enabled !== false && props.caption_template_id && (
        <div style={{
          position: 'absolute', left: '50%', bottom: '12%',
          transform: 'translateX(-50%)',
          padding: '4px 10px', borderRadius: 999,
          background: 'rgba(245,158,11,0.92)', color: '#1a1a1a',
          fontSize: 9, fontFamily: 'var(--font-display)', fontWeight: 800,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}>
          {props.caption_template_name ? `Captions · ${props.caption_template_name}` : 'Captions on'}
        </div>
      )}
      {/* Logo / watermark — actual image if we have one, dashed placeholder otherwise. */}
      {props.watermark_position && props.watermark_position !== 'none' && (
        logoUrl ? (
          <img
            src={logoUrl} alt=""
            style={{
              position: 'absolute',
              ...(props.watermark_position.includes('t') ? { top: '4%' } : { bottom: '4%' }),
              ...(props.watermark_position.includes('l') ? { left: '4%' } : { right: '4%' }),
              width: `${props.watermark_size_pct ?? 12}%`,
              objectFit: 'contain',
            }}
          />
        ) : (
          <div style={{
            position: 'absolute',
            ...(props.watermark_position.includes('t') ? { top: '4%' } : { bottom: '4%' }),
            ...(props.watermark_position.includes('l') ? { left: '4%' } : { right: '4%' }),
            width: `${props.watermark_size_pct ?? 12}%`,
            aspectRatio: '3/1',
            background: 'rgba(255,255,255,0.18)',
            border: '1px dashed rgba(255,255,255,0.5)',
            borderRadius: 4, display: 'grid', placeItems: 'center',
            color: 'rgba(255,255,255,0.85)', fontSize: 10, fontWeight: 700,
            letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>logo</div>
        )
      )}
    </div>
  )
}

// Fetches the live ZapCap template catalog (proxied through our server so
// the API key stays server-side), shows a 2-col grid of style cards. The
// list cache is per-page-load — refreshing the canvas re-fetches.
let _zapcapCache = null
function ZapcapTemplatePicker({ selectedId, onChange }) {
  const [templates, setTemplates] = useState(_zapcapCache || null)
  const [loading, setLoading] = useState(!_zapcapCache)
  const [err, setErr] = useState(null)

  useEffect(() => {
    if (_zapcapCache) return
    let cancelled = false
    ;(async () => {
      try {
        const sess = (await supabase.auth.getSession()).data.session
        const r = await fetch('/api/zapcap/templates', {
          headers: { Authorization: `Bearer ${sess?.access_token || ''}` },
        })
        const body = await r.json()
        if (cancelled) return
        if (!r.ok) throw new Error(body?.error || `Templates fetch failed (${r.status})`)
        const list = Array.isArray(body.templates) ? body.templates : []
        _zapcapCache = list
        setTemplates(list)
      } catch (e) {
        if (!cancelled) setErr(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return <div style={{ padding: 12, textAlign: 'center', color: 'var(--muted)', fontSize: 11 }}><Loader2 size={12} className="spin" /> Loading styles…</div>
  }
  if (err) {
    return (
      <div style={{ padding: 10, fontSize: 10.5, lineHeight: 1.45, color: 'var(--amber)', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 6 }}>
        Couldn't load ZapCap styles: {err}<br/>
        Make sure <code style={{ fontSize: 10 }}>ZAPCAP_API_KEY</code> is set in Vercel env. You can still paste a template UUID manually below.
        <input
          style={{ ...tinyInput, marginTop: 8 }}
          placeholder="ZapCap template UUID"
          value={selectedId}
          onChange={(e) => onChange({ id: e.target.value, name: 'Custom' })}
        />
      </div>
    )
  }
  if (!templates?.length) {
    return <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>No templates returned by ZapCap.</div>
  }

  // Pick the most useful preview: prefer a poster IMAGE (no playback noise),
  // then fall back to a video URL we render *paused* with `preload=metadata`
  // so only the first frame loads (no auto-looping wall of demo footage).
  const pickPreview = (t) => {
    const candidates = [t.thumbnailUrl, t.thumbnail, t.posterUrl, t.poster, t.previewImageUrl, t.previewImage, t.imageUrl, t.image]
    for (const c of candidates) if (c) return { kind: 'image', src: c }
    const vidCandidates = [t.previewUrl, t.preview, t.videoUrl]
    for (const c of vidCandidates) if (c) {
      if (/\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(c)) return { kind: 'image', src: c }
      return { kind: 'video', src: c }
    }
    return null
  }

  return (
    <>
      <div style={{ ...labelStyle, marginBottom: 8 }}>{templates.length} caption style{templates.length === 1 ? '' : 's'} available</div>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
        maxHeight: 480, overflowY: 'auto', paddingRight: 4,
      }}>
        {templates.map((t) => {
          const id = t.id || t._id || t.templateId
          const name = t.name || t.label || id?.slice(0, 8) || 'Style'
          const preview = pickPreview(t)
          const on = id === selectedId
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange({ id, name })}
              style={{
                position: 'relative',
                padding: 0, borderRadius: 8, overflow: 'hidden',
                border: on ? '2px solid #f59e0b' : '1px solid var(--border)',
                background: 'var(--surface-2)', cursor: 'pointer',
                height: 140,                  // fixed height keeps the grid tidy
                display: 'flex', flexDirection: 'column',
                textAlign: 'left',
              }}
              title={name}
            >
              <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#0b0b0b' }}>
                {preview?.kind === 'image' ? (
                  <img
                    src={preview.src} alt=""
                    loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    onError={(e) => { e.currentTarget.style.display = 'none' }}
                  />
                ) : preview?.kind === 'video' ? (
                  <video
                    src={preview.src}
                    muted playsInline preload="metadata"
                    /* No autoplay/loop — keeps the drawer quiet and lightweight. */
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }}
                  />
                ) : (
                  <div style={{
                    width: '100%', height: '100%', display: 'grid', placeItems: 'center',
                    color: 'var(--text)', fontSize: 28, fontWeight: 900,
                    fontFamily: 'var(--font-display)', letterSpacing: '0.02em',
                    background: 'linear-gradient(135deg, #1f2937, #0f172a)',
                  }}>Aa</div>
                )}
              </div>
              <div style={{
                padding: '6px 8px', fontSize: 10.5, fontWeight: 700,
                fontFamily: 'var(--font-display)',
                background: 'var(--surface-2)', borderTop: '1px solid var(--border)',
                color: on ? '#f59e0b' : 'var(--text)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{name}</div>
              {on && (
                <div style={{ position: 'absolute', top: 4, right: 4, background: '#f59e0b', color: '#1a1a1a', borderRadius: 999, padding: '2px 7px', fontSize: 9, fontWeight: 800 }}>✓</div>
              )}
            </button>
          )
        })}
      </div>
    </>
  )
}

function PolishLogoUpload({ uploadedUrl, upstreamUrl, profileId, onChange }) {
  const inpRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const effective = uploadedUrl || upstreamUrl
  const isUploaded = !!uploadedUrl

  const onPick = async (file) => {
    if (!file) return
    setBusy(true); setErr(null)
    try {
      const url = await uploadLogoToBucket(file, profileId, 'logos')
      onChange(url)
    } catch (e) { setErr(e.message) }
    finally { setBusy(false) }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
        {effective ? (
          <img src={effective} alt="" style={{
            width: 56, height: 56, objectFit: 'contain', background: 'var(--surface-2)',
            border: '1px solid var(--border)', borderRadius: 6, padding: 6,
          }} />
        ) : (
          <div style={{
            width: 56, height: 56, background: 'var(--surface-2)', border: '1px dashed var(--border)',
            borderRadius: 6, display: 'grid', placeItems: 'center', color: 'var(--muted)', fontSize: 10,
          }}>No logo</div>
        )}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            type="button"
            onClick={() => inpRef.current?.click()}
            disabled={busy}
            style={{
              padding: '6px 10px', borderRadius: 6, fontSize: 11.5,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              color: 'var(--text)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700,
              display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center',
            }}
          >{busy ? <Loader2 size={11} className="spin" /> : <Upload size={11} />} {isUploaded ? 'Replace' : 'Upload'}</button>
          {isUploaded && (
            <button
              type="button"
              onClick={() => onChange(null)}
              style={{
                padding: '4px 8px', borderRadius: 6, fontSize: 10.5,
                background: 'transparent', border: '1px solid var(--border)',
                color: 'var(--muted)', cursor: 'pointer',
              }}
            ><Trash2 size={10} style={{ verticalAlign: '-2px', marginRight: 4 }} /> Remove (use wired)</button>
          )}
        </div>
        <input
          ref={inpRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={(e) => onPick(e.target.files?.[0])}
        />
      </div>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.4 }}>
        {isUploaded
          ? 'Using your uploaded logo. Remove to fall back to whatever\'s wired in.'
          : upstreamUrl ? 'Using a logo from a wired image / brand profile. Upload above to override.'
          : 'Wire an image_upload, image_gen, or brand_profile in — or upload a logo here.'}
      </div>
      {err && <div style={{ fontSize: 10.5, color: 'var(--red)', marginBottom: 8 }}>{err}</div>}
    </>
  )
}

export function VideoPolishEditor({ nodeId, data, onPatch, allNodes, allEdges }) {
  const props = data.props || {}
  // Only the watermark uploader needs an upstream lookup — the live preview
  // moved to the node body so we don't compute upstream video / script here.
  const upstreamLogo = useMemo(
    () => findUpstreamLogoUrl(nodeId, allNodes, allEdges),
    [nodeId, allNodes, allEdges]
  )

  const setP = (patch) => onPatch(patch)

  return (
    <>
      {/* Live preview lives in the node body now — no need to render it
         in the drawer too. (User feedback: redundant.) */}

      {/* Title overlay ─────────────────────────────────────────────────── */}
      <PolishSection icon={Type} title="Title overlay">
        <NodeField label="Title source">
          <select
            style={tinyInput}
            value={props.title_mode || 'auto'}
            onChange={(e) => setP({ title_mode: e.target.value })}
          >
            <option value="auto">Auto — transcribe video, Claude writes the title</option>
            <option value="manual">Manual — type my own title below</option>
          </select>
        </NodeField>
        {(props.title_mode || 'auto') === 'auto' ? (
          <NodeField label="Topic / angle hint (optional)">
            <textarea
              style={{ ...tinyInput, minHeight: 56, fontFamily: 'inherit', resize: 'vertical' }}
              placeholder='e.g. "punchy hook focused on the red flag, max 6 words"'
              value={props.title_topic || ''}
              onChange={(e) => setP({ title_topic: e.target.value })}
            />
            <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
              ElevenLabs transcribes the audio; Claude writes a click-worthy title using your brand bible + this hint. Costs ~800 ai_tokens per render.
            </div>
          </NodeField>
        ) : (
          <div style={{ marginBottom: 10 }}>
            <input
              style={tinyInput}
              placeholder="Your title here"
              value={props.title || ''}
              onChange={(e) => setP({ title: e.target.value })}
            />
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={props.title_enabled !== false}
            onChange={(e) => setP({ title_enabled: e.target.checked })}
          />
          <span style={{ fontSize: 11.5 }}>Burn title overlay onto renders</span>
        </label>
        <NodeField label="Title font">
          <select style={tinyInput} value={props.title_font || 'Montserrat ExtraBold'} onChange={(e) => setP({ title_font: e.target.value })}>
            {POLISH_FONT_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </NodeField>
        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <PolishColorRow label="Text color" value={props.title_color || '#ffffff'} onChange={(v) => setP({ title_color: v })} />
          <PolishColorRow label="Background" value={props.title_bg_color || '#e0467a'} onChange={(v) => setP({ title_bg_color: v })} />
        </div>
        <PolishSlider label="Size" value={Number(props.title_size ?? 72)} min={24} max={140} suffix="px" onChange={(v) => setP({ title_size: v })} />
        <PolishSlider label="Background padding" value={Number(props.title_bg_padding ?? 28)} min={0} max={64} suffix="px" onChange={(v) => setP({ title_bg_padding: v })} />
        <PolishSlider label="Y position" value={Number(props.title_y_pos ?? 15)} min={5} max={50} suffix="% from top" onChange={(v) => setP({ title_y_pos: v })} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!props.title_uppercase}
            onChange={(e) => setP({ title_uppercase: e.target.checked })}
          />
          <span style={{ fontSize: 11.5 }}>UPPERCASE</span>
        </label>
      </PolishSection>

      {/* Captions (ZapCap) ─────────────────────────────────────────────── */}
      <PolishSection icon={Captions} title="Captions (ZapCap)">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={props.captions_enabled !== false}
            onChange={(e) => setP({ captions_enabled: e.target.checked })}
          />
          <span style={{ fontSize: 11.5 }}>Burn captions onto the video</span>
        </label>
        {props.captions_enabled !== false && (
          <ZapcapTemplatePicker
            selectedId={props.caption_template_id || ''}
            onChange={(t) => setP({ caption_template_id: t.id, caption_template_name: t.name })}
          />
        )}
      </PolishSection>

      {/* Logo / Watermark ──────────────────────────────────────────────── */}
      <PolishSection icon={ImageIcon} title="Logo / Watermark">
        <PolishLogoUpload
          uploadedUrl={props.watermark_image_url}
          upstreamUrl={upstreamLogo}
          profileId={data?._ctxProfileId}
          onChange={(url) => setP({ watermark_image_url: url || null })}
        />
        <div style={labelStyle}>Position</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 12 }}>
          {[
            { id: 'tl', label: 'Top Left' },
            { id: 'tr', label: 'Top Right' },
            { id: 'bl', label: 'Bottom Left' },
            { id: 'br', label: 'Bottom Right' },
          ].map((p) => {
            const on = (props.watermark_position || 'br') === p.id
            return (
              <button
                key={p.id} type="button"
                onClick={() => setP({ watermark_position: p.id })}
                style={{
                  padding: '8px 0', borderRadius: 999, fontSize: 11.5,
                  border: `1px solid ${on ? '#f59e0b' : 'var(--border)'}`,
                  background: on ? '#f59e0b' : 'var(--surface-2)',
                  color: on ? '#fff' : 'var(--text-soft)',
                  cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700,
                }}
              >{p.label}</button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => setP({ watermark_position: 'none' })}
          style={{
            width: '100%', padding: '6px 0', borderRadius: 6, fontSize: 11,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            color: 'var(--muted)', cursor: 'pointer', marginBottom: 12,
          }}
        >Hide logo</button>
        <PolishSlider label="Logo size" value={Number(props.watermark_size_pct ?? 25)} min={4} max={40} suffix="% of video width" onChange={(v) => setP({ watermark_size_pct: v })} />
      </PolishSection>

      {/* Music ─────────────────────────────────────────────────────────── */}
      <PolishSection icon={Mic} title="Music">
        <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.4 }}>
          Wire an audio_upload node into "in" to use background music. Volume ducks under the original voice.
        </div>
        <PolishSlider label="Volume" value={Math.round(Number(props.music_volume ?? 0.15) * 100)} min={0} max={50} suffix="%" onChange={(v) => setP({ music_volume: v / 100 })} />
        <PolishSlider label="Auto fade-out" value={Number(props.music_fade_secs ?? 1.5)} min={0} max={5} step={0.1} suffix="s" onChange={(v) => setP({ music_fade_secs: Number(v.toFixed(1)) })} />
      </PolishSection>
    </>
  )
}

// ─── SCHEDULE POST (Upload-Post API) ───────────────────────────────────────
// `cap` = effective caption character limit per platform. We send the
// same description to all selected platforms (Upload-Post takes one
// string), so the *minimum* of the selected caps is the safe upper
// bound. Anything past gets truncated by the platform on its end.
const SCHEDULE_PLATFORMS = [
  { id: 'tiktok',    label: 'TikTok',    kinds: ['video'],          cap: 2200 },
  { id: 'instagram', label: 'Instagram', kinds: ['image', 'video'], cap: 2200 },
  { id: 'youtube',   label: 'YouTube',   kinds: ['video'],          cap: 5000 },
  { id: 'x',         label: 'X',         kinds: ['image', 'video'], cap: 280  },
  { id: 'threads',   label: 'Threads',   kinds: ['image', 'video'], cap: 500  },
  { id: 'linkedin',  label: 'LinkedIn',  kinds: ['image', 'video'], cap: 3000 },
  { id: 'facebook',  label: 'Facebook',  kinds: ['image', 'video'], cap: 63206 },
  { id: 'pinterest', label: 'Pinterest', kinds: ['image', 'video'], cap: 500  },
]

function SchedulePostBody({ data, onPatch }) {
  const props = data.props || {}
  const platforms = Array.isArray(props.platforms) ? props.platforms : []
  const out = data.output
  const connected = Array.isArray(data._ctxConnectedPlatforms) ? data._ctxConnectedPlatforms : []
  const brandSchedule = data._ctxBrandSchedule || null
  const profileId = data._ctxProfileId
  const when = props.when || 'now'

  const togglePlatform = (id) => {
    if (!connected.includes(id)) return  // hard-gated, button is disabled too
    const next = platforms.includes(id) ? platforms.filter((p) => p !== id) : [...platforms, id]
    onPatch({ platforms: next })
  }
  const tz = props.timezone || (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC')

  // Live preview of the next available slot when in 'auto' mode. Hits the
  // server which knows about already-scheduled posts; refreshes whenever
  // the user switches into auto mode.
  const [autoSlot, setAutoSlot] = useState(null)
  const [autoSlotLoading, setAutoSlotLoading] = useState(false)
  useEffect(() => {
    if (when !== 'auto' || !profileId) { setAutoSlot(null); return }
    let cancelled = false
    setAutoSlotLoading(true)
    ;(async () => {
      try {
        const sess = (await supabase.auth.getSession()).data.session
        const r = await fetch(`/api/scheduling/next-slot?profile_id=${profileId}`, {
          headers: { Authorization: `Bearer ${sess?.access_token || ''}` },
        })
        const body = await r.json()
        if (!cancelled) setAutoSlot(body?.iso || null)
      } catch { if (!cancelled) setAutoSlot(null) }
      finally { if (!cancelled) setAutoSlotLoading(false) }
    })()
    return () => { cancelled = true }
  }, [when, profileId])

  return (
    <>
      <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.4 }}>
        Posts via the connected social accounts on this brand profile.
        {' '}
        <a href="/schedule" style={{ color: 'var(--red)', textDecoration: 'none' }}>Manage →</a>
      </div>
      <NodeField label={`Platforms (${connected.length} connected)`}>
        {connected.length === 0 && (
          <div style={{
            padding: '6px 8px', marginBottom: 6, fontSize: 10.5, lineHeight: 1.4,
            background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)',
            borderRadius: 6, color: 'var(--amber)',
          }}>
            No social accounts connected yet. Open <a href="/schedule" style={{ color: 'inherit', fontWeight: 700 }}>Schedule</a> to link your platforms.
          </div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {SCHEDULE_PLATFORMS.map((p) => {
            const on = platforms.includes(p.id)
            const enabled = connected.includes(p.id)
            return (
              <button
                key={p.id}
                type="button"
                disabled={!enabled}
                title={enabled ? '' : 'Not connected — link this platform on the Schedule page first.'}
                onClick={(e) => { e.stopPropagation(); togglePlatform(p.id) }}
                style={{
                  fontSize: 10.5, padding: '4px 9px', borderRadius: 999,
                  border: `1px solid ${on ? '#2ecc71' : 'var(--border)'}`,
                  background: on ? 'rgba(46,204,113,0.16)' : 'var(--surface-2)',
                  color: on ? '#2ecc71' : enabled ? 'var(--text-soft)' : 'var(--muted)',
                  opacity: enabled ? 1 : 0.45,
                  cursor: enabled ? 'pointer' : 'not-allowed',
                  fontFamily: 'var(--font-display)', fontWeight: 700,
                }}
              >{p.label}</button>
            )
          })}
        </div>
      </NodeField>
      <NodeField label="When">
        <select style={tinyInput} value={when} onChange={(e) => onPatch({ when: e.target.value })}>
          <option value="now">Publish now</option>
          <option value="auto">Schedule (next slot from posting schedule)</option>
          <option value="scheduled">Schedule for specific date / time…</option>
        </select>
      </NodeField>
      {when === 'auto' && (
        <div style={{
          padding: '8px 10px', marginTop: 6, marginBottom: 4, fontSize: 11, lineHeight: 1.45,
          background: 'rgba(46,204,113,0.10)', border: '1px solid rgba(46,204,113,0.35)',
          borderRadius: 6, color: 'var(--text)',
        }}>
          {autoSlotLoading
            ? <span style={{ color: 'var(--muted)' }}>Checking next open slot…</span>
            : autoSlot
              ? <>Next slot: <strong>{new Date(autoSlot).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</strong>{brandSchedule?.timezone ? <span style={{ color: 'var(--muted)' }}> · {brandSchedule.timezone}</span> : null}</>
              : <span style={{ color: 'var(--amber)' }}>No open slots in your posting schedule. <a href="/profiles" style={{ color: 'inherit', fontWeight: 700 }}>Edit schedule →</a></span>
          }
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
            The actual slot is locked in when this node finishes running, so it stays accurate even if the queue moves.
          </div>
        </div>
      )}
      {when === 'scheduled' && (
        <>
          <NodeField label="Date / time (local)">
            <input
              type="datetime-local"
              className="nodrag"
              style={tinyInput}
              value={props.scheduled_local || ''}
              onChange={(e) => onPatch({ scheduled_local: e.target.value })}
            />
          </NodeField>
          <NodeField label="Timezone">
            <input
              className="nodrag"
              style={tinyInput}
              value={props.timezone || tz}
              onChange={(e) => onPatch({ timezone: e.target.value })}
            />
          </NodeField>
        </>
      )}
      {/* Per-platform character-cap preview — flags any selected platform
         whose limit will truncate the wired-in caption. */}
      {(() => {
        const incomingDesc = data._ctxIncomingDescriptionLength
        if (incomingDesc == null || !platforms.length) return null
        const tightest = SCHEDULE_PLATFORMS.filter((p) => platforms.includes(p.id)).reduce(
          (acc, p) => p.cap < acc.cap ? p : acc, { cap: Infinity, label: '' }
        )
        if (!isFinite(tightest.cap)) return null
        const over = incomingDesc > tightest.cap
        return (
          <div style={{
            marginTop: 6, padding: '6px 8px', borderRadius: 6, fontSize: 10.5, lineHeight: 1.4,
            background: over ? 'rgba(245,158,11,0.12)' : 'var(--surface-2)',
            border: `1px solid ${over ? 'rgba(245,158,11,0.4)' : 'var(--border)'}`,
            color: over ? 'var(--amber)' : 'var(--text-soft)',
          }}>
            Caption: <strong>{incomingDesc}</strong> / {tightest.cap} chars
            {over && <> — exceeds <strong>{tightest.label}</strong> limit; will be truncated on that platform.</>}
          </div>
        )
      })()}
      <div style={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.4, marginTop: 4 }}>
        Wire a video (or images) plus an optional caption / hashtags / script.
      </div>
      {out?.request_id && (
        <div style={{ ...previewBox, marginTop: 8 }}>
          Submitted ✓
          {out.scheduled_iso && (
            <div style={{ marginTop: 2 }}>
              <span style={{ color: 'var(--muted)' }}>at </span>
              <strong>{new Date(out.scheduled_iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</strong>
            </div>
          )}
          <div style={{ color: 'var(--muted)', fontSize: 10 }}>id: {String(out.request_id).slice(0, 18)}…</div>
        </div>
      )}
      <NodePreview status={data.status} output={out?.request_id ? null : out} error={data.error} />
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

// ─── CAPTIONS NODE (ZapCap-only) ────────────────────────────────────────────
function CaptionsBody({ data, onPatch }) {
  const props = data.props || {}
  const out = data.output
  const upstreamVideo = data._ctxUpstreamVideoUrl || null
  const previewVideo = out?.video_url || upstreamVideo
  const styleName = props.caption_template_name || (props.caption_template_id ? 'Selected' : null)
  return (
    <>
      {previewVideo ? (
        <video
          src={previewVideo}
          muted playsInline preload="metadata"
          style={{
            width: '100%', aspectRatio: '9/16', objectFit: 'cover',
            background: '#000', borderRadius: 8, marginBottom: 8,
            border: '1px solid var(--border)',
          }}
        />
      ) : (
        <div style={{
          width: '100%', aspectRatio: '9/16',
          background: '#000', border: '1px dashed var(--border)', borderRadius: 8,
          display: 'grid', placeItems: 'center', color: 'var(--muted)', fontSize: 11, padding: 12, textAlign: 'center',
          marginBottom: 8,
        }}>Run an upstream video node to see a preview frame.</div>
      )}
      <button
        type="button"
        className="nodrag"
        onClick={(e) => { e.stopPropagation(); window.__spaceOpenEditor?.(data.__id) }}
        style={{
          width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 10px', background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 7, color: 'var(--text)', cursor: 'pointer', fontSize: 11.5,
          fontFamily: 'var(--font-display)', fontWeight: 700, marginBottom: 6,
        }}
      >
        <span><Captions size={11} style={{ verticalAlign: '-2px', marginRight: 6, color: '#0ea5e9' }} /> {styleName ? `Style · ${styleName}` : 'Pick caption style'}</span>
        <ArrowUpRight size={11} style={{ color: 'var(--muted)' }} />
      </button>
      <NodePreview status={data.status} output={null} error={data.error} />
    </>
  )
}

export function CaptionsEditor({ nodeId, data, onPatch, allNodes, allEdges }) {
  const props = data.props || {}
  const previewVideo = useMemo(
    () => data.output?.video_url || findUpstreamVideoUrl(nodeId, allNodes, allEdges),
    [nodeId, allNodes, allEdges, data.output?.video_url]
  )
  return (
    <>
      <div style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Play size={11} /> Source video
      </div>
      {previewVideo ? (
        <video
          src={previewVideo} controls muted playsInline preload="metadata"
          style={{
            width: '100%', aspectRatio: '9/16', objectFit: 'cover',
            background: '#000', borderRadius: 10, border: '1px solid var(--border)', marginBottom: 14,
          }}
        />
      ) : (
        <div style={{
          width: '100%', aspectRatio: '9/16',
          background: '#000', border: '1px dashed var(--border)', borderRadius: 10,
          display: 'grid', placeItems: 'center', color: 'var(--muted)', fontSize: 11, padding: 12, textAlign: 'center',
          marginBottom: 14,
        }}>Wire & run an upstream video node first.</div>
      )}
      <ZapcapTemplatePicker
        selectedId={props.caption_template_id || ''}
        onChange={(t) => onPatch({ caption_template_id: t.id, caption_template_name: t.name })}
      />
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

  audio_upload: {
    label: 'Audio', description: 'Upload an audio file (MP3 / WAV / M4A) to use as the voice track for an avatar render. Wire its "out" into Avatar render in place of (or alongside) a script.',
    icon: Mic, category: 'inputs', color: '#22d3ee',
    inputs: [], outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { url: '', name: '' },
    Body: AudioUploadBody,
    run: async ({ data }) => {
      const url = data.props?.url
      if (!url) throw new Error('Upload an audio file first')
      return { audio: { url, name: data.props?.name || '' } }
    },
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
    label: 'Brand profile', description: 'Pulls in a brand profile and exposes it to downstream generators. Per-node "inject" toggles let each space pass a different slice (voice/audience, theme, logo, bible, hashtags). When sync_all is on, this node auto-wires to every script_gen / caption_gen / image_gen on the canvas.',
    icon: Building2, category: 'inputs', color: '#ec4899',
    inputs: [], outputs: [{ id: 'out', label: 'Out' }],
    initialProps: {
      profile_id: '',
      sync_all: false,
      inject: { voice_audience: true, theme: true, logo: true, bible: true, hashtags: true },
    },
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
      // Default inject = everything on. Pass only the slices the user
      // toggled in the node body, plus profile_id + name (always sent so
      // resolveBrandMention etc. has something to work with).
      const inj = data.props?.inject || { voice_audience: true, theme: true, logo: true, bible: true, hashtags: true }
      const brand = {
        profile_id: p.id,
        name:       p.business_name || '',
        industry:   p.industry || '',
      }
      if (inj.voice_audience !== false) {
        brand.voice    = p.preferred_tone || ''
        brand.audience = p.target_audience || ''
      }
      if (inj.theme !== false) {
        brand.primary_color   = p.brand_primary_color || ''
        brand.secondary_color = p.brand_secondary_color || ''
        if (Array.isArray(p.brand_colors)) brand.brand_colors = p.brand_colors
        if (Array.isArray(p.brand_fonts))  brand.brand_fonts  = p.brand_fonts
      }
      if (inj.logo !== false)     brand.logo_url   = p.logo_url || ''
      if (inj.bible !== false)    brand.brandBible = p.brand_bible || ''
      if (inj.hashtags !== false) brand.hashtags   = p.core_hashtags || ''
      return { brand }
    },
  },

  script_gen: {
    label: 'Script generator', description: 'Claude writes a script from a topic. Supports @-mentions and an optional brand profile input.',
    icon: Wand2, category: 'generators', color: '#ef4444',
    inputs: [{ id: 'in', label: 'In (topic / brand)' }],
    outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { format: 'tiktok-script', topic: '', target_length_secs: 45 },
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
        body: JSON.stringify({
          profile_id: profileId,
          format: data.props?.format || 'tiktok-script',
          topic,
          count: 1,
          target_length_secs: data.props?.target_length_secs || undefined,
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
    label: 'Title + caption + hashtags', description: 'Generates a click-worthy title, a platform-tuned caption, and 5 hashtags for EVERY platform (TikTok, Instagram, YouTube, X, LinkedIn) in one Claude call. schedule_post automatically picks the right variant. Hashtag count is locked at 5.',
    icon: Captions, category: 'generators', color: '#f59e0b',
    inputs: [{ id: 'in', label: 'In (script / brand)' }],
    outputs: [{ id: 'out', label: 'Out' }],
    initialProps: {},
    Body: CaptionGenBody,
    run: async ({ data, inputs, ctx }) => {
      const incoming = inputs?.in
      const script = pickScript(incoming)
      if (!script) throw new Error('No script provided')
      const brand = pickBrand(incoming)
      const profileId = brand?.profile_id || ctx.profileId

      // One Claude call returns variants for all five platforms as JSON.
      // Per-platform constraints baked into the prompt so the variants
      // already respect the tightest character caps (X is the worst at 280).
      const prompt = `From the script below, write a TITLE, CAPTION, and exactly 5 HASHTAGS for each of: tiktok, instagram, youtube, x, linkedin.

Per-platform constraints (HARD limits — stay under each):
- tiktok:    caption ≤ 300 chars, fast hook in first sentence
- instagram: caption ≤ 2200 chars, can be a story; line breaks ok
- youtube:   caption ≤ 1000 chars, SEO-friendly, first 100 chars matter most
- x:         caption ≤ 270 chars (HARD — leaves room for hashtags), one punchy line
- linkedin:  caption ≤ 1500 chars, professional but on-brand voice

Title rules: each title ≤ 80 chars, click-worthy, no number prefix. tiktok title doubles as the upload-post tiktok_title (≤ 90 chars). Each platform should have its OWN title/caption tuned to that platform's vibe — don't just copy/paste.

Hashtags: EXACTLY 5 per platform, space-separated, each starting with #. Lead with the brand's core hashtags from the brand bible, then add topic-specific ones.

Voice: stay on the brand bible's tone (already in your system context). NEVER use em dashes (—); use commas, periods, or colons.

Return ONLY valid JSON, no preamble, no markdown fences. Exact shape:
{
  "tiktok":    { "title": "", "caption": "", "hashtags": "#a #b #c #d #e" },
  "instagram": { "title": "", "caption": "", "hashtags": "#a #b #c #d #e" },
  "youtube":   { "title": "", "caption": "", "hashtags": "#a #b #c #d #e" },
  "x":         { "title": "", "caption": "", "hashtags": "#a #b #c #d #e" },
  "linkedin":  { "title": "", "caption": "", "hashtags": "#a #b #c #d #e" }
}

Script:
"""
${String(script).slice(0, 2000)}
"""`

      const r = await fetch('/api/content/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: profileId,
          format: 'ig-post',  // generic; the prompt does the heavy lifting
          topic: prompt,
          count: 1,
          // We just need the AI output to feed downstream; the row itself
          // gets saved by save_library. Without dry_run we'd leave a draft
          // titled with the raw prompt template.
          dry_run: true,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      const item = body.items?.[0] || {}
      const raw = item.full_script || item.caption || ''

      // Parse the JSON — tolerate ```json fences if Claude added them.
      let perPlatform = {}
      try {
        const cleaned = String(raw).replace(/```json\s*|```\s*/gi, '').trim()
        const m = cleaned.match(/\{[\s\S]*\}/)
        perPlatform = JSON.parse(m ? m[0] : cleaned)
      } catch {
        // Fallback: salvage what we can from the raw text. Better than failing.
        perPlatform = {
          instagram: {
            title: '',
            caption: String(raw).replace(/#[\w]+/g, '').trim().slice(0, 2200),
            hashtags: (String(raw).match(/#[\w]+/g) || []).slice(0, 5).join(' '),
          },
        }
      }

      // Pick instagram (or the first available) as the default `caption` /
      // `hashtags` / `title` so existing downstream nodes that read those
      // fields directly (save_library, the legacy single-caption flow)
      // keep working without changes.
      const order = ['instagram', 'tiktok', 'youtube', 'linkedin', 'x']
      const defaultKey = order.find((k) => perPlatform[k]?.caption) || Object.keys(perPlatform)[0]
      const def = perPlatform[defaultKey] || {}

      return {
        title: def.title || '',
        caption: def.caption || '',
        hashtags: def.hashtags || '',
        per_platform: perPlatform,
      }
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
      // Replace @brand mentions with the actual business name (cleaner prose
      // for the model than stripping the token entirely).
      prompt = expandBrandMentions(prompt, ctx.profiles)
      if (brand) {
        const lines = []
        if (brand.name) lines.push(`Brand: ${brand.name}.`)
        if (brand.industry) lines.push(`Industry: ${brand.industry}.`)
        // Force the color palette explicitly. Image models tend to ignore
        // raw hex codes — repeat them with a "MUST USE" directive and a
        // color-name annotation if available.
        const colorBits = []
        if (brand.primary_color) colorBits.push(`primary ${brand.primary_color}`)
        if (brand.secondary_color) colorBits.push(`secondary ${brand.secondary_color}`)
        if (colorBits.length) lines.push(`Brand color palette MUST be used: ${colorBits.join(', ')}. Apply these as the dominant colors throughout the design — backgrounds, accents, headers.`)
        if (brand.voice) lines.push(`Voice/style: ${String(brand.voice).slice(0, 200)}.`)
        if (brand.audience) lines.push(`Audience: ${String(brand.audience).slice(0, 160)}.`)
        prompt = `BRAND IDENTITY DIRECTIVE\n${lines.join('\n')}\n\n---\n\n${prompt}`
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
          .map((m) => (m[1] || m[2] || '').toLowerCase().replace(/[^a-z0-9_-]/g, ''))
      )].filter(Boolean)
      let refs = []
      if (tokens.length) {
        for (const tok of tokens) {
          const hit = namedImages.find((im) => (im.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '') === tok)
          if (hit) refs.push(hit.url)
        }
      }
      // No matches by name → fall back to every reference image we received.
      if (!refs.length) refs = pickImageUrls(incoming)

      // Whenever a brand is in play AND it has a logo, attach the logo as a
      // reference image. Image models are far more likely to reproduce brand
      // visuals when they actually SEE the asset, vs being told about it in
      // text. Also nudge the prompt so the model knows there's a logo
      // available, even if the user didn't say "logo".
      if (brand?.logo_url && !refs.includes(brand.logo_url)) {
        refs.push(brand.logo_url)
        const mentionsLogo = /\b(logo|brand\s*mark)\b/i.test(prompt)
        if (!mentionsLogo) {
          prompt += `\n\nThe brand's logo is provided as a reference image — place it tastefully in the composition (small corner placement is fine if no specific position is requested).`
        }
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

      // Client-side poll up to 12 minutes (Nano Banana Pro can take 6-9
      // minutes on heavy queues). Each call is short enough for Vercel.
      const start = Date.now()
      let consecutiveErrors = 0
      while (Date.now() - start < 720_000) {
        if (ctx.shouldAbort?.()) throw new Error('Stopped')
        await new Promise((r) => setTimeout(r, 4000))
        try {
          const sR = await fetch(`/api/images/status?taskId=${encodeURIComponent(taskId)}&profile_id=${encodeURIComponent(profileForCall)}`, {
            headers: { Authorization: `Bearer ${ctx.token}` },
          })
          const s = await sR.json()
          if (!sR.ok) {
            consecutiveErrors++
            if (consecutiveErrors >= 3) throw new Error(s.error || `Status check failed (${sR.status})`)
            continue
          }
          consecutiveErrors = 0
          if (s.state === 'success') return { images: s.images || [] }
          if (s.state === 'failed') throw new Error(s.error || 'Generation failed')
          // Anything else (waiting / generating / queueing / pending) → loop.
        } catch (e) {
          consecutiveErrors++
          if (consecutiveErrors >= 3) throw e
        }
      }
      throw new Error('Image generation timed out after 12 minutes — KIE may still be processing; try again or check the dashboard.')
    },
  },

  avatar_picker: {
    label: 'Avatar', description: 'Pick an avatar + a look. Image strategy = Single uses one specific image; Randomize uses every image in the chosen look (Avatar render splits the script across them). Cycle looks (orthogonal toggle) rotates which LOOK is used each run — and the chosen image strategy still applies inside that look. So Cycle on + Randomize images = a different outfit per run AND multiple angles per video. The optional In handle accepts a trigger (typically Auto-run) so the picker is part of the auto-run chain and advances the cycle on every tick.',
    icon: UserCircle2, category: 'inputs', color: '#60a5fa',
    inputs: [{ id: 'in', label: 'In (trigger, optional)' }],
    outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { avatar_id: '', look_id: '', image_id: '', mode: 'single', cycle_looks: false },
    // Cheap node (no API calls) — and when cycle_looks is on it MUST execute
    // every run to advance the queue. Skip the cache short-circuit.
    noCache: true,
    Body: AvatarPickerBody,
    run: async ({ data, ctx }) => {
      const props = data.props || {}
      const { avatar_id, image_id, image_url } = props
      if (!avatar_id) throw new Error('Pick an avatar')

      // Migrate legacy mode='cycle_looks' (pre-orthogonal-toggle spaces)
      // to the new shape: mode is now strictly the image strategy, and
      // cycle_looks is its own boolean.
      const rawMode = props.mode || 'single'
      const imageMode = rawMode === 'cycle_looks' ? 'randomize' : (rawMode === 'randomize' ? 'randomize' : 'single')
      const cycleLooks = !!props.cycle_looks || rawMode === 'cycle_looks'

      // Resolve which look this run uses. Default = the prop. With cycle
      // looks on, walk the queue.
      let chosenLookId = props.look_id || null
      let cycleStatePatch = null

      if (cycleLooks) {
        const myAvatar = (ctx?.avatars || []).find((a) => a.id === avatar_id)
        const allLookIds = (myAvatar?.looks || []).map((l) => l.id).filter(Boolean)
        if (allLookIds.length === 0) throw new Error('Cycle looks needs at least one look on the avatar.')
        if (allLookIds.length === 1) {
          chosenLookId = allLookIds[0]
          cycleStatePatch = { avatar_id, queue: allLookIds, cursor: 1, pool_key: allLookIds.slice().sort().join(',') }
        } else {
          const poolKey = allLookIds.slice().sort().join(',')
          const prior = data?.output?.cycle_state
          let queue, cursor
          if (prior && prior.avatar_id === avatar_id && prior.pool_key === poolKey && Array.isArray(prior.queue) && prior.queue.length === allLookIds.length) {
            queue = prior.queue
            cursor = Math.max(0, Math.min(prior.cursor || 0, queue.length))
          } else {
            // Fresh shuffle (Fisher-Yates).
            queue = allLookIds.slice()
            for (let i = queue.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1))
              ;[queue[i], queue[j]] = [queue[j], queue[i]]
            }
            cursor = 0
          }
          chosenLookId = queue[cursor]
          let nextCursor = cursor + 1
          let nextQueue = queue
          if (nextCursor >= queue.length) {
            // Reshuffle for the next cycle, avoiding back-to-back repeats
            // across the seam.
            let attempts = 0
            do {
              const reshuffled = queue.slice()
              for (let i = reshuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1))
                ;[reshuffled[i], reshuffled[j]] = [reshuffled[j], reshuffled[i]]
              }
              nextQueue = reshuffled
              attempts++
            } while (nextQueue[0] === chosenLookId && attempts < 8 && nextQueue.length > 1)
            nextCursor = 0
          }
          cycleStatePatch = { avatar_id, queue: nextQueue, cursor: nextCursor, pool_key: poolKey, last_used_look_id: chosenLookId }
        }
      }

      // Image strategy applies AFTER the look is picked. In randomize mode
      // we hand off look_id only and avatar_render fetches the look's
      // images server-side. In single mode we keep the picked image_id —
      // unless cycle_looks just rotated us into a different look (the old
      // image_id wouldn't belong to the new look), in which case fall back
      // to "first image of this look" by clearing image_id.
      const lookChanged = cycleLooks && chosenLookId !== props.look_id
      const useImageId = imageMode === 'single' && !lookChanged ? (image_id || null) : null
      const useImageUrl = imageMode === 'single' && !lookChanged ? (image_url || null) : null

      const out = {
        avatar: {
          avatar_id,
          look_id: chosenLookId,
          image_id: useImageId,
          image_url: useImageUrl,
          mode: imageMode === 'randomize' ? 'randomize' : 'single',
        },
      }
      if (cycleStatePatch) out.cycle_state = cycleStatePatch
      return out
    },
  },

  avatar_render: {
    label: 'Avatar render', description: 'HeyGen renders an avatar talking the script (or lip-syncing to an uploaded audio file). When the picker is in Randomize mode, the script is split across every image in the look and rendered as a series of clips.',
    icon: FileVideo, category: 'generators', color: '#ef4444',
    inputs: [{ id: 'in',  label: 'In (avatar + script or audio)' }],
    outputs: [{ id: 'out', label: 'Out' }],
    initialProps: {},
    Body: AvatarRenderBody,
    run: async ({ inputs, ctx }) => {
      const incoming = inputs?.in
      const avatar = pickAvatarConfig(incoming)
      if (!avatar?.avatar_id) throw new Error('Connect an Avatar picker')
      const audio = pickAudio(incoming)
      const script = audio ? '' : pickScript(incoming)
      if (!audio && !script) throw new Error('Wire in either a script (text/script_gen) or an audio file.')

      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` }

      // Helper: submit a single photo render and poll until success/failed.
      async function renderOne({ photo_url, scriptChunk, audioUrl }) {
        const sub = await fetch('/api/avatars/photo-render', {
          method: 'POST', headers,
          body: JSON.stringify({
            profile_id: ctx.profileId,
            photo_url,
            script: scriptChunk || undefined,
            audio_url: audioUrl || undefined,
            // Internal Supabase avatar id — server uses it to look up the
            // stored ElevenLabs voice when voice_id isn't passed explicitly.
            avatar_id: avatar.avatar_id,
            voice_id: avatar.voice_id || undefined,
          }),
        })
        const subBody = await sub.json()
        if (!sub.ok) throw new Error(subBody.error || `Render submit failed (${sub.status})`)
        const videoId = subBody.video_id
        if (!videoId) throw new Error('No video id returned')
        const start = Date.now()
        while (Date.now() - start < 480_000) {
          if (ctx.shouldAbort?.()) throw new Error('Stopped')
          await new Promise((r) => setTimeout(r, 6000))
          const sR = await fetch(`/api/avatars/photo-render-status?video_id=${encodeURIComponent(videoId)}`, { headers })
          const s = await sR.json()
          if (!sR.ok) throw new Error(s.error || `Status check failed (${sR.status})`)
          if (s.state === 'success') return { video_url: s.video_url, video_id: videoId }
          if (s.state === 'failed') throw new Error(s.error || 'Render failed')
        }
        throw new Error('Render timed out')
      }

      // ── Randomize when explicitly set, OR auto-randomize when single
      //    mode was picked but no specific image_id was chosen and the
      //    look has multiple images (the most common "I forgot to flip
      //    the toggle" case — better to just do the right thing).
      const wantsRandomize = avatar.mode === 'randomize'
      const couldAutoRandomize = avatar.mode === 'single' && !avatar.image_id && !audio && avatar.look_id
      if (wantsRandomize || couldAutoRandomize) {
        if (!avatar.look_id) throw new Error('Randomize mode needs a look. Pick one in the avatar node.')
        const imgR = await fetch(`/api/avatars/look-images?look_id=${avatar.look_id}`, { headers })
        const imgB = await imgR.json()
        if (!imgR.ok) throw new Error(imgB.error || 'Could not fetch look images')
        const images = (imgB.images || []).slice().sort((a, b) => (a.order_index || 0) - (b.order_index || 0))
        if (!images.length) throw new Error('Look has no images')

        // Audio randomize doesn't make sense (one audio track) — fall back
        // to single mode on the first image. Same when only one image
        // exists OR auto-randomize was triggered with just one.
        if (audio || images.length === 1) {
          const photo = images[0].image_url
          const r = await renderOne({ photo_url: photo, scriptChunk: script, audioUrl: audio?.url })
          return { video: { video_url: r.video_url, media_type: 'video' } }
        }

        // Decide how many clips to render. We don't want to be stuck at
        // image_count when the user only has 2 images and an 80-word
        // script — that produces two long static clips and feels stale.
        // Instead, target ~7 seconds of speaking per clip (TikTok B-roll
        // pacing) so visuals change ~every 7s. Cycle through the
        // available images via images[i % images.length].
        const wordCount = String(script).split(/\s+/).filter(Boolean).length
        const estDurationSecs = Math.max(3, Math.round(wordCount / 2.5))
        const TARGET_CLIP_SECS = 7
        const clipsCount = Math.min(
          12,                                                // hard cap so credit usage stays sane
          Math.max(images.length, Math.ceil(estDurationSecs / TARGET_CLIP_SECS))
        )

        // Split the script into clipsCount chunks via Claude.
        const sp = await fetch('/api/scripts/split', {
          method: 'POST', headers,
          body: JSON.stringify({ script, count: clipsCount }),
        })
        const spBody = await sp.json()
        if (!sp.ok) throw new Error(spBody.error || 'Script split failed')
        const chunks = Array.isArray(spBody.chunks) ? spBody.chunks : [script]

        // Build the [chunk, image] assignment cycling images so a 2-image
        // look across a 6-clip render goes: img1, img2, img1, img2, img1, img2.
        const assignments = chunks.map((chunk, i) => ({
          chunk,
          image: images[i % images.length],
          order: i,
        }))

        // Submit + poll all clips in parallel — but tolerate per-clip
        // failures (Promise.allSettled). HeyGen's "missing image
        // dimensions" error sometimes hits one image while the rest
        // succeed; we want the user to keep the working clips instead
        // of losing the whole batch to a cascade fail.
        const settled = await Promise.allSettled(assignments.map(async (a) => {
          const r = await renderOne({ photo_url: a.image.image_url, scriptChunk: a.chunk || script })
          return {
            video_url: r.video_url,
            order: a.order,
            image_url: a.image.image_url,
            sentence: a.chunk || '',
          }
        }))
        const clips = []
        const failures = []
        for (let i = 0; i < settled.length; i++) {
          const s = settled[i]
          if (s.status === 'fulfilled') clips.push(s.value)
          else failures.push({ clip_index: i, error: s.reason?.message || String(s.reason) })
        }
        // All clips failed → still throw so the cascade poison kicks in.
        // Otherwise we ship what we have plus a list of which clips failed.
        if (!clips.length) {
          throw new Error(`All ${assignments.length} clips failed. First error: ${failures[0]?.error || 'unknown'}`)
        }
        return {
          videos: clips,
          media_type: 'video',
          is_clip_set: true,
          ...(failures.length ? { partial_failures: failures } : {}),
        }
      }

      // ── Single: one image, one render ─────────────────────────────────
      const photo = avatar.image_url
      if (!photo) throw new Error('Pick a specific image in the avatar node (Single mode), or switch to Randomize.')
      const r = await renderOne({ photo_url: photo, scriptChunk: script, audioUrl: audio?.url })
      return { video: { video_url: r.video_url, media_type: 'video' } }
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
        if (Array.isArray(val.videos)) {
          for (const v of val.videos) {
            if (v?.video_url) incoming.push({ kind: 'video', url: v.video_url, from, order: v.order, sentence: v.sentence })
          }
          return
        }
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

  combine_videos: {
    label: 'Combine videos', description: 'Stitches a set of video clips end-to-end. If server-side ffmpeg is unavailable, the node falls back to a playlist: every clip is preserved individually so you can download or hand-edit them.',
    icon: FileVideo, category: 'generators', color: '#0ea5e9',
    inputs: [{ id: 'in', label: 'In (videos)' }],
    outputs: [{ id: 'out', label: 'Out (video)' }],
    initialProps: {},
    Body: CombineVideosBody,
    run: async ({ inputs, ctx }) => {
      const arr = asArr(inputs?.in)
      const clips = []
      for (const v of arr) {
        if (!v) continue
        if (Array.isArray(v.videos)) for (const c of v.videos) { if (c?.video_url) clips.push(c) }
        else if (Array.isArray(v.items)) for (const it of v.items) { if (it?.kind === 'video' && it.url) clips.push({ video_url: it.url, order: it.order }) }
        else if (v.video_url) clips.push({ video_url: v.video_url, order: v.order })
      }
      clips.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9))
      if (clips.length < 2) throw new Error('Need at least 2 video clips to combine.')

      // Try the server-side ffmpeg path. If it's not deployed or fails for
      // any reason, fall back to playlist mode so the user keeps every clip
      // and a clear message instead of losing the whole run.
      try {
        const r = await fetch('/api/videos/combine', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
          body: JSON.stringify({
            profile_id: ctx.profileId,
            video_urls: clips.map((c) => c.video_url),
          }),
        })
        const body = await r.json().catch(() => ({}))
        if (r.ok && body?.video_url) {
          return { video: { video_url: body.video_url, source_clips: clips.length }, media_type: 'video' }
        }
        // Fall through to playlist on any non-success.
        return {
          videos: clips,
          media_type: 'video',
          is_clip_set: true,
          combine_unavailable: body?.error || `Server ffmpeg unavailable (${r.status}). Clips preserved as a playlist — download each and stitch in your editor, or wire a different combine target.`,
        }
      } catch (e) {
        return {
          videos: clips,
          media_type: 'video',
          is_clip_set: true,
          combine_unavailable: e.message,
        }
      }
    },
  },

  // ── POLISH VIDEO (title overlay + logo/watermark + bg music) ──────────
  video_polish: {
    label: 'Video overlays', description: 'Adds a title overlay, a logo / watermark, and ducks a background music track under the original voice. Runs on our native ffmpeg server. Captions live in their own node (ZapCap).',
    icon: Sparkles, category: 'generators', color: '#0ea5e9',
    inputs: [{ id: 'in', label: 'In (video + logo + music)' }],
    outputs: [{ id: 'out', label: 'Out (video)' }],
    initialProps: {
      // Title overlay
      title: '',
      title_enabled: true,
      title_mode: 'auto',           // 'auto' | 'manual' — auto transcribes the video and asks Claude for a title
      title_topic: '',              // optional guidance for the auto title (e.g. "punchy hook about red flags")
      title_font: 'Montserrat ExtraBold',
      title_color: '#ffffff',
      title_bg_color: '#e0467a',
      title_size: 72,
      title_bg_padding: 28,
      title_y_pos: 15,
      title_uppercase: false,
      // Logo / watermark
      watermark_position: 'br',
      watermark_size_pct: 25,
      // Music
      music_volume: 0.15,
      music_fade_secs: 1.5,
    },
    Body: VideoPolishBody,
    Editor: VideoPolishEditor,
    run: async ({ data, inputs, ctx }) => {
      const arr = asArr(inputs?.in)
      let logoUrl = null, musicUrl = null
      // Also pluck a wired-in title from upstream caption_gen so it can
      // override the manually-typed prop without the user re-typing.
      let upstreamTitle = ''
      for (const v of arr) {
        if (!v || typeof v !== 'object') continue
        if (!upstreamTitle && typeof v.title === 'string') upstreamTitle = v.title
        if (!logoUrl) {
          if (v.brand?.logo_url) logoUrl = v.brand.logo_url
          else if (Array.isArray(v.images) && v.images[0]?.url) logoUrl = v.images[0].url
          else if (v.url && /\.(png|jpe?g|webp)(\?|$)/i.test(v.url)) logoUrl = v.url
        }
        if (!musicUrl) {
          if (v.audio?.audio_url) musicUrl = v.audio.audio_url
          else if (v.audio_url) musicUrl = v.audio_url
          else if (v.url && /\.(mp3|wav|m4a|aac)(\?|$)/i.test(v.url)) musicUrl = v.url
        }
      }
      // Shared helper picks first video from any upstream shape — handles
      // single render output, randomize videos[] arrays, combine_videos
      // playlist fallback, and collection items[] grids.
      const videoUrl = pickFirstVideoUrl(arr)
      if (!videoUrl) throw new Error('Wire a video into "in" (avatar_render or combine_videos).')

      const p = data.props || {}

      // Resolve the title:
      // 1. If title_mode === 'auto' → call /api/videos/auto-title to
      //    transcribe + generate. The optional title_topic prop steers
      //    the angle. Falls back to upstream/manual on failure so a
      //    hiccup in STT/Claude doesn't kill the render.
      // 2. Otherwise prefer an upstream caption_gen title, then the
      //    manually-typed prop.
      let resolvedTitle = ''
      if (p.title_enabled !== false) {
        if ((p.title_mode || 'auto') === 'auto') {
          try {
            const ar = await fetch('/api/videos/auto-title', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
              body: JSON.stringify({
                profile_id: ctx.profileId,
                video_url: videoUrl,
                topic: (p.title_topic || '').trim() || undefined,
              }),
            })
            const ab = await ar.json().catch(() => ({}))
            if (ar.ok && ab?.title) resolvedTitle = ab.title
          } catch (e) {
            // fall through to manual / upstream below
            console.warn('auto-title failed, falling back —', e?.message || e)
          }
          if (!resolvedTitle) resolvedTitle = upstreamTitle || (p.title || '').trim()
        } else {
          resolvedTitle = upstreamTitle || (p.title || '').trim()
        }
      }
      const titleOn = (p.title_enabled !== false) && !!resolvedTitle

      const r = await fetch('/api/videos/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: ctx.profileId,
          video_url: videoUrl,
          logo_url: logoUrl || undefined,
          watermark_image_url: p.watermark_image_url || undefined,
          music_url: musicUrl || undefined,
          // Title overlay
          title: titleOn ? resolvedTitle : undefined,
          title_style: titleOn ? {
            font: p.title_font, color: p.title_color, bg_color: p.title_bg_color,
            size: p.title_size, bg_padding: p.title_bg_padding, y_pos: p.title_y_pos,
            uppercase: p.title_uppercase,
          } : undefined,
          // Captions handled by the dedicated `captions` node — never here.
          captions_enabled: false,
          // Logo / watermark
          watermark_position: p.watermark_position || 'br',
          watermark_size_pct: p.watermark_size_pct ?? 25,
          // Music
          music_volume: p.music_volume ?? 0.15,
          music_fade_secs: p.music_fade_secs ?? 1.5,
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok || !body?.video_url) {
        // Surface ffmpeg detail when present so the user can see which
        // overlay/filter blew up (font path, overlay coords, etc.).
        const msg = body?.error || `Polish failed (${r.status})`
        const detail = body?.ffmpeg_error ? `\n\nffmpeg: ${body.ffmpeg_error}` : ''
        throw new Error(msg + detail)
      }
      return {
        video: { video_url: body.video_url },
        video_url: body.video_url,
        media_type: 'video',
        // Surface the title so downstream nodes (schedule_post, save_library)
        // can show / use the auto-generated title without re-transcribing.
        title: titleOn ? resolvedTitle : undefined,
        polished: true,
      }
    },
  },

  // ── CAPTIONS (ZapCap) ────────────────────────────────────────────────
  // Slim node: takes a video, hands it to ZapCap with a chosen style,
  // returns the captioned MP4. Polish (title, watermark, music) is its
  // own node — chain captions → video_polish if you want both.
  captions: {
    label: 'Captions', description: 'Burns animated captions onto a video using ZapCap. Pick a style preset; ZapCap transcribes and renders.',
    icon: Captions, category: 'generators', color: '#0ea5e9',
    inputs: [{ id: 'in', label: 'In (video)' }],
    outputs: [{ id: 'out', label: 'Out (video)' }],
    initialProps: {
      caption_template_id: '',
      caption_template_name: '',
      language: 'en',
    },
    Body: CaptionsBody,
    Editor: CaptionsEditor,
    run: async ({ data, inputs, ctx }) => {
      const arr = asArr(inputs?.in)
      // Pick the first video URL from anything upstream — handles every
      // shape the canvas can produce:
      //   { video: { video_url } }       single avatar_render / video_polish / combine_videos success
      //   { video_url }                  loose
      //   { videos: [{video_url}, …] }   randomize avatar_render OR combine_videos playlist fallback
      //   { items: [{kind:'video',url},…] }   collection
      const videoUrl = pickFirstVideoUrl(arr)
      if (!videoUrl) throw new Error('Wire a video into "in" (avatar_render or combine_videos).')
      if (!data.props?.caption_template_id) throw new Error('Pick a caption style first (open settings).')

      const r = await fetch('/api/videos/captions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: ctx.profileId,
          video_url: videoUrl,
          template_id: data.props.caption_template_id,
          language: data.props.language || 'en',
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok || !body?.video_url) throw new Error(body?.error || `Captions failed (${r.status})`)
      return {
        video: { video_url: body.video_url },
        video_url: body.video_url,
        media_type: 'video',
        captioned: true,
      }
    },
  },

  schedule_post: {
    label: 'Schedule post', description: 'Publishes (or schedules) a video / image bundle to TikTok, Instagram, YouTube, X, LinkedIn, Threads, Facebook, or Pinterest via the upload-post.com API. Wire video/images + caption + hashtags in.',
    icon: Send, category: 'outputs', color: '#2ecc71',
    inputs: [{ id: 'in', label: 'In (video / images + caption / hashtags)' }],
    outputs: [{ id: 'out', label: 'Out (request_id)' }],
    initialProps: {
      // Upload-Post username is now auto-derived per brand profile by the
      // server; no per-node input needed.
      platforms: [],
      when: 'now',
      scheduled_local: '',
      timezone: '',
    },
    Body: SchedulePostBody,
    run: async ({ data, inputs, ctx }) => {
      const arr = asArr(inputs?.in)
      let caption = ''
      let hashtags = ''
      let script = ''
      let title = ''
      let perPlatform = null
      const photoUrls = []
      for (const v of arr) {
        if (!v) continue
        if (typeof v === 'string') { if (!script) script = v; continue }
        if (typeof v !== 'object') continue
        if (!title && v.title) title = v.title
        if (!script && (v.script || v.full_script)) script = v.script || v.full_script
        if (!caption && v.caption) caption = v.caption
        if (!hashtags && v.hashtags) hashtags = v.hashtags
        if (!perPlatform && v.per_platform && typeof v.per_platform === 'object') perPlatform = v.per_platform
        // Image collection / explicit images array.
        if (Array.isArray(v.images)) for (const im of v.images) { if (im?.url) photoUrls.push(im.url) }
        else if (v.url && /\.(png|jpe?g|webp)(\?|$)/i.test(v.url)) photoUrls.push(v.url)
        // collection node — items[] of mixed kinds. Pull image kinds.
        if (Array.isArray(v.items)) {
          for (const it of v.items) {
            if (it?.kind === 'image' && it.url) photoUrls.push(it.url)
          }
        }
      }
      // Use the shared video-shape resolver: handles single render output,
      // randomize videos[] arrays, combine_videos playlist fallback, and
      // collection items[] grids in one place.
      const videoUrl = pickFirstVideoUrl(arr)

      const platforms = Array.isArray(data.props?.platforms) ? data.props.platforms : []
      if (!platforms.length) throw new Error('Pick at least one platform.')
      if (!videoUrl && !photoUrls.length) throw new Error('Wire a video or images into "in".')

      // Per-platform kind validation up front so we don't waste an API call.
      const detectedKind = videoUrl ? 'video' : 'image'
      const bad = platforms.filter((id) => {
        const def = SCHEDULE_PLATFORMS.find((p) => p.id === id)
        return def && !def.kinds.includes(detectedKind)
      })
      if (bad.length) {
        const names = bad.map((id) => SCHEDULE_PLATFORMS.find((p) => p.id === id)?.label || id).join(', ')
        throw new Error(`${names} can't accept ${detectedKind} content.`)
      }

      // If caption_gen wired in per-platform variants, prefer the variant
      // that matches THIS publish target. When multiple platforms are
      // selected we pick the tightest one (shortest cap) so the single
      // description Upload-Post sends fits everywhere.
      if (perPlatform) {
        const ranked = platforms
          .map((p) => ({ id: p, def: SCHEDULE_PLATFORMS.find((s) => s.id === p) }))
          .sort((a, b) => (a.def?.cap || Infinity) - (b.def?.cap || Infinity))
        let picked = null
        for (const { id } of ranked) {
          const v = perPlatform[id]
          if (v?.caption) {
            caption = v.caption
            if (v.hashtags) hashtags = v.hashtags
            if (v.title) title = v.title
            picked = id
            break
          }
        }
        // If the chosen platform's variant had no hashtags but ANOTHER
        // platform's variant did, borrow them rather than ship none.
        if (!hashtags) {
          for (const id of Object.keys(perPlatform)) {
            if (id === picked) continue
            if (perPlatform[id]?.hashtags) { hashtags = perPlatform[id].hashtags; break }
          }
        }
      }

      // Last-resort: scrape #tags out of the caption itself if hashtags
      // is still empty (e.g. caption_gen failed entirely and we're in the
      // legacy single-string path with hashtags inlined).
      if (!hashtags && caption) {
        const m = String(caption).match(/#[\w]+/g)
        if (m && m.length) hashtags = m.join(' ')
      }

      const description = [caption, hashtags].filter(Boolean).join('\n\n').trim()
        || String(script || '').slice(0, 500)

      const when = data.props?.when || 'now'
      // 'now' → no scheduled_iso. 'scheduled' → user-picked datetime-local.
      // 'auto' → server resolves the next slot at submit time so it reflects
      // what's actually free when the run finishes.
      let scheduledIso = null
      let schedulingMode = 'now'
      if (when === 'scheduled' && data.props?.scheduled_local) {
        const d = new Date(data.props.scheduled_local)
        if (!Number.isNaN(d.getTime())) scheduledIso = d.toISOString()
        schedulingMode = 'fixed'
      } else if (when === 'auto') {
        schedulingMode = 'auto'
      }

      const r = await fetch('/api/social/upload-post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: ctx.profileId,
          // upload_post_user omitted — server derives it from profile_id.
          platforms,
          video_url: videoUrl || undefined,
          photo_urls: !videoUrl && photoUrls.length ? photoUrls : undefined,
          description,
          // YouTube REQUIRES a title. Always send something — upstream
          // caption_gen.title → upstream script first sentence → first
          // line of caption → final fallback "Untitled". Never undefined.
          title: (title
            || (script ? String(script).split(/[.!?\n]/)[0].trim().slice(0, 90) : '')
            || (caption ? String(caption).split(/[.!?\n]/)[0].trim().slice(0, 90) : '')
            || 'Untitled'),
          scheduling_mode: schedulingMode,
          scheduled_iso: scheduledIso,
          timezone: data.props?.timezone || undefined,
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.error || `Upload-Post failed (${r.status})`)
      return {
        request_id: body?.request_id || null,
        platforms,
        scheduled_iso: body?.scheduled_iso || scheduledIso,
        scheduling_mode: schedulingMode,
        kind: detectedKind,
        submitted: true,
      }
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
          if (ctx.shouldAbort?.()) throw new Error('Stopped')
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
    const name = (n.data?.name || '').toString().toLowerCase().replace(/[^a-z0-9_-]/g, '') || fallback
    nameById.set(n.id, name)
  }

  const outputsById = new Map()
  const errors = {}
  // Track which upstream node IDs poisoned each downstream node so we can
  // surface a clear "Upstream failed" error instead of a confusing "wire
  // a video in" message when the real cause is two hops upstream.
  const failedAncestorOf = new Map()  // nodeId → Set<failed source nodeId>

  for (const id of order) {
    if (ctx?.shouldAbort?.()) {
      // Don't clobber earlier failures — just halt the queue. Nodes that
      // were already 'running' get marked failed via the racing abortPromise
      // below; nodes still 'idle' stay idle.
      return { ok: false, errors: { ...errors, _aborted: 'Stopped by user' } }
    }
    const node = nodes.find((n) => n.id === id)
    if (!node) continue
    const def = NODE_REGISTRY[node.data?.type || node.type]
    if (!def) {
      onNodeChange?.(id, { status: 'failed', error: `Unknown type: ${node.data?.type || node.type}` })
      errors[id] = 'unknown type'; continue
    }

    // If any upstream node failed (directly or transitively), short-circuit
    // this node with a clear "blocked by upstream" message and propagate
    // the failed-ancestor set forward. This keeps the user from chasing
    // bogus "wire a video into in" errors when the real cause was three
    // hops upstream (e.g. avatar_render ran out of credits).
    const ancestors = failedAncestorOf.get(id)
    if (ancestors && ancestors.size) {
      const names = [...ancestors]
        .map((srcId) => {
          const src = nodes.find((n) => n.id === srcId)
          return src?.data?.name || NODE_REGISTRY[src?.data?.type]?.label || srcId.slice(0, 8)
        })
        .slice(0, 3)
      const msg = `Blocked by upstream failure: ${names.join(', ')}${ancestors.size > 3 ? ` +${ancestors.size - 3} more` : ''}`
      onNodeChange?.(id, { status: 'failed', error: msg })
      errors[id] = msg
      // Propagate to this node's descendants too.
      for (const e of edges.filter((e) => e.source === id)) {
        const set = failedAncestorOf.get(e.target) || new Set()
        for (const a of ancestors) set.add(a)
        failedAncestorOf.set(e.target, set)
      }
      continue
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

    // Cached short-circuit: node arrived already "done" with output. Skip
    // def.run() and seed outputsById from its existing output so downstream
    // nodes thread through correctly.
    //
    // ctx.forceReRun is a Set passed by runFromNode when the trigger is an
    // auto_run node — we want each tick to re-execute the chain even if
    // descendants still hold last-tick's outputs. Skip the cache for any
    // node in that set so def.run() actually fires.
    const skipCache = (ctx?.forceReRun && ctx.forceReRun.has?.(id)) || def.noCache
    if (!skipCache && node.data?.status === 'done' && node.data?.output) {
      outputsById.set(id, node.data.output)
      continue
    }

    onNodeChange?.(id, { status: 'running', error: null })
    try {
      // Race the node's run against a poll of ctx.shouldAbort(). Long-poll
      // generators check the flag mid-loop too, but this catches in-flight
      // single-shot fetches (script_gen, caption_gen, save_library) that
      // don't have a natural cancellation hook.
      let abortTimer
      const abortPromise = new Promise((_, rej) => {
        abortTimer = setInterval(() => {
          if (ctx?.shouldAbort?.()) { clearInterval(abortTimer); rej(new Error('Stopped')) }
        }, 500)
      })
      const result = await Promise.race([
        def.run({ data: node.data, inputs: inputObj, inputsByName, ctx }),
        abortPromise,
      ]).finally(() => { try { clearInterval(abortTimer) } catch {} })
      outputsById.set(id, result || {})
      onNodeChange?.(id, { status: 'done', output: result })
    } catch (err) {
      // Tag insufficient-credit errors so the UI can offer a top-up CTA.
      const isCreditError = /insufficient/i.test(err?.message || '') || err?.code === 'insufficient_credits'
      const finalMsg = isCreditError
        ? `${err.message} — top up in Billing to continue.`
        : err.message
      onNodeChange?.(id, { status: 'failed', error: finalMsg })
      errors[id] = finalMsg
      // Poison every descendant so they don't run with empty inputs and
      // throw misleading "Wire X into in" errors.
      for (const e of edges.filter((e) => e.source === id)) {
        const set = failedAncestorOf.get(e.target) || new Set()
        set.add(id)
        failedAncestorOf.set(e.target, set)
      }
      if (ctx?.shouldAbort?.()) {
        return { ok: false, errors: { ...errors, _aborted: 'Stopped by user' } }
      }
    }
  }

  return { ok: Object.keys(errors).length === 0, errors }
}

export function makeReactFlowNodeTypes() {
  const types = {}
  for (const [key, def] of Object.entries(NODE_REGISTRY)) types[key] = def.Component || null
  return types
}
