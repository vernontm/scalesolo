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

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Type, Wand2, Captions, UserCircle2, Save, Image as ImageIcon,
  ListChecks, FileVideo, Upload, Loader2, Maximize2, ArrowUpRight,
  Download, Trash2, Building2, Repeat, Play, Pause, Combine as CombineIcon,
  Mic, Sparkles, Send, Copy, X, Lock, Link2, AlertCircle, ExternalLink,
  Library as LibraryIcon,
} from 'lucide-react'
import { supabase } from './supabase.js'
import MusicMixPreview from '../components/MusicMixPreview.jsx'

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
      {/* Persistent expand affordance, always visible in the corner so the
          preview action is discoverable on touch devices and small tiles
          (Collection thumbnails) where the bottom hover overlay is easy to
          miss. Other actions (add-to-canvas, download, delete) still live
          in the bottom hover overlay. */}
      <button
        type="button"
        title="Preview"
        aria-label="Preview"
        className="nodrag"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); window.__spaceOpenPreview?.({ url, type }) }}
        style={{
          position: 'absolute', top: 6, right: 6, zIndex: 6,
          width: 22, height: 22, borderRadius: 5,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.6)', color: '#fff',
          border: '1px solid rgba(255,255,255,0.18)', padding: 0, cursor: 'pointer',
          backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
          transition: 'background .12s var(--ease), border-color .12s var(--ease)',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,0.55)'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.8)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.6)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)' }}
      >
        <Maximize2 size={11} />
      </button>
      {type === 'video' ? (
        // GIF-style preview: auto-loop, muted, no controls. Click the
        // Preview button in the hover overlay to open the fullscreen
        // player with sound. disablePictureInPicture + the inline play
        // suppress every native control browsers might surface.
        // display:block kills the user-agent inline-block baseline
        // whitespace that browsers leave to the right of <video>
        // elements (read as "small white space" by users since the
        // wrapper's surface-2 grey reads white against the darker page).
        <video
          src={url}
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
          disablePictureInPicture
          controlsList="nodownload nofullscreen noremoteplayback"
          style={{ display: 'block', width: '100%', height: '100%', objectFit: fit, background: '#000', verticalAlign: 'top', pointerEvents: 'none' }}
        />
      ) : (
        <img src={url} alt="" style={{ display: 'block', width: '100%', height: '100%', objectFit: fit, verticalAlign: 'top' }} />
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
          <Btn Icon={Download} title="Download" onClick={() => {
            // Force the right extension so the OS recognizes the file —
            // Supabase Storage signed URLs strip the extension off the
            // download name, so without this the file lands as "download"
            // and macOS guesses "GIF" since the preview is auto-looping.
            const ext = type === 'video' ? 'mp4' : (type === 'audio' ? 'mp3' : 'png')
            const base = (from || 'download').toString().replace(/\W+/g, '-').toLowerCase().slice(0, 60) || 'download'
            downloadUrl(url, `${base}.${ext}`)
          }} />
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

// Keys that are useful to the runtime but noise to the user. NodePreview
// hides these everywhere; node-specific bodies that need to show one of
// them must do it themselves.
const INTERNAL_OUTPUT_KEYS = new Set([
  // Linkage / record ids
  '_content_id', 'content_id', 'render_id', 'job_id', 'task_id',
  'request_id', 'submitted', 'submit', 'queued',
  // Raw provider ids / tokens
  'video_id', 'heygen_video_id', 'avatar_id', 'look_id', 'image_id', 'image_url',
  'uploadpost_request_id', 'voice_id', 'profile_id',
  // Run-engine / cycle internals
  'cycle_state', 'pool_key', 'tick', 'run_index', 'index', 'order',
  'sentence', 'is_clip_set', 'partial_failures', 'cursor', 'queue',
])

function isLikelyId(value) {
  if (typeof value !== 'string') return false
  // Treat anything that looks like a UUID, opaque token, or long URL as an id
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true
  if (/^https?:\/\//.test(value) && value.length > 80) return true
  return false
}

// Pretty short-form summary of an arbitrary output object. Used as the
// fallback when a node body doesn't render its own custom preview. Keeps
// the canvas clean: no UUIDs, no signed URLs, no debug fields.
function summarizeOutput(output) {
  if (!output || typeof output !== 'object') return null
  const lines = []
  for (const [k, v] of Object.entries(output)) {
    if (INTERNAL_OUTPUT_KEYS.has(k)) continue
    if (k.startsWith('_')) continue
    if (v == null || v === '') continue
    if (typeof v === 'string') {
      if (isLikelyId(v)) continue
      lines.push(`${prettyLabel(k)}: ${v.length > 80 ? v.slice(0, 80) + '…' : v}`)
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      lines.push(`${prettyLabel(k)}: ${v}`)
    } else if (Array.isArray(v)) {
      // "5 clips" style — never the full payload
      lines.push(`${prettyLabel(k)}: ${v.length} ${v.length === 1 ? 'item' : 'items'}`)
    } else if (typeof v === 'object') {
      // Drill one level for shapes like { script_gen: { title, words } }
      const inner = Object.entries(v)
        .filter(([ik]) => !INTERNAL_OUTPUT_KEYS.has(ik) && !ik.startsWith('_'))
        .filter(([, iv]) => iv != null && iv !== '' && (typeof iv === 'string' || typeof iv === 'number' || typeof iv === 'boolean'))
        .filter(([, iv]) => typeof iv !== 'string' || !isLikelyId(iv))
        .slice(0, 3)
        .map(([ik, iv]) => `${prettyLabel(ik)}: ${typeof iv === 'string' && iv.length > 60 ? iv.slice(0, 60) + '…' : iv}`)
        .join(', ')
      if (inner) lines.push(`${prettyLabel(k)} — ${inner}`)
    }
  }
  return lines.slice(0, 4).join('\n')
}

function prettyLabel(key) {
  // image_url → Image url, full_script → Full script
  return String(key).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

function NodePreview({ status, output, error }) {
  if (status === 'running') return <div style={{ ...previewBox, color: 'var(--amber)' }}><Loader2 size={11} className="spin" style={{ marginRight: 6, verticalAlign: '-1px' }} /> Running…</div>
  if (status === 'failed')  return <div style={{ ...previewBox, color: 'var(--red)' }}>{String(error || 'Failed')}</div>
  if (status === 'done' && output) {
    if (typeof output === 'string') {
      const t = output.slice(0, 600)
      return <div style={previewBox}>{t}{output.length > 600 ? '…' : ''}</div>
    }
    const summary = summarizeOutput(output)
    // Many nodes (script_gen, avatar_render, etc.) render their own rich
    // body when output is meaningful. If summarizeOutput returns nothing,
    // there's nothing user-facing to show — keep the card clean.
    if (!summary) {
      return <div style={{ ...previewBox, color: 'var(--text-soft)' }}>Done</div>
    }
    return <div style={previewBox}>{summary}</div>
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

// Pre-chunked audio output from voice_gen (randomize mode). Each chunk
// is { audio_url, sentence, image_url, order } — image_url is paired
// upstream so downstream avatar_render doesn't have to re-fetch
// look-images.
function pickAudioChunks(v) {
  for (const x of asArr(v)) {
    if (x && typeof x === 'object' && Array.isArray(x.audio_chunks) && x.audio_chunks.length > 0) {
      return x.audio_chunks
    }
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
      // Two shapes: avatar_render emits { video_url } per clip;
      // image_upload emits { url } per video. Accept either.
      for (const c of v.videos) {
        if (c?.video_url) return c.video_url
        if (c?.url && /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(c.url)) return c.url
      }
    }
    // Fallback for image_upload shapes that lost their kind (cached
    // output from before the kind-preservation fix in readImageItems).
    // Sniff every entry in images[] for a video extension.
    if (Array.isArray(v.images)) {
      for (const c of v.images) {
        const u = c?.url || (typeof c === 'string' ? c : null)
        if (u && /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(u)) return u
      }
    }
    if (Array.isArray(v.items)) {
      for (const it of v.items) if (it?.kind === 'video' && it.url) return it.url
    }
  }
  return null
}

// Single-script caption generator. The default path when caption_gen
// has one script-bearing input. Returns the canonical
// { title, caption, hashtags, first_comment } shape with user edits
// overlaid. Extracted as a helper so the video-only fallback can reuse
// it for the single-video case (transcribe → use transcript as script).
async function runSingleCaptionFromScript({ ctx, profileId, script, edits }) {
  const prompt = `From the script below, write ONE canonical TITLE, CAPTION, FIRST_COMMENT, and exactly 5 HASHTAGS that will be used across every platform we publish to (TikTok, Instagram, YouTube, Facebook, X, LinkedIn, Threads, Pinterest, Bluesky). Aim for a tight, punchy caption that reads well on the longest-form platforms (Instagram / Facebook / LinkedIn) but doesn't feel bloated on the shorter ones — keep it under 1500 characters total. The platform layer truncates further for X / Threads / Bluesky automatically.

Title rules:
- ≤ 80 characters, click-worthy, no number prefix.
- Used as the YouTube title and the post title on platforms that surface a separate title field.

Caption rules:
- ≤ 1500 characters. Lead with a strong hook in the first sentence.
- Should land naturally on every platform — no platform-specific phrasing.
- Plain text, paragraph breaks ok.

Hashtags:
- EXACTLY 5 hashtags, space-separated, each starting with #.
- Lead with the brand's core hashtags from the brand bible, then add topic-specific ones.
- Always present — never empty. Same set for every platform.

First comment rules:
- ≤ 220 characters. A short engagement driver that lands as the first reply on the post.
- A punchy question, "save if this hit" call-to-action, or value-add follow-up thought.
- NEVER duplicates the caption.
- NEVER includes hashtags (those belong in the hashtags field).

Voice: stay on the brand bible's tone (already in your system context). NEVER use em dashes; use commas, periods, or colons.

Return ONLY valid JSON, no preamble, no markdown fences. Exact shape:
{
  "title": "",
  "caption": "",
  "first_comment": "",
  "hashtags": "#a #b #c #d #e"
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
      format: 'ig-post',
      topic: prompt,
      count: 1,
      dry_run: true,
    }),
  })
  const body = await r.json()
  if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
  const item = body.items?.[0] || {}
  const raw = item.full_script || item.caption || ''

  let parsed = {}
  try {
    const cleaned = String(raw).replace(/```json\s*|```\s*/gi, '').trim()
    const m = cleaned.match(/\{[\s\S]*\}/)
    parsed = JSON.parse(m ? m[0] : cleaned)
  } catch { parsed = {} }

  // Tolerate the legacy per-platform shape from older saved spaces.
  const legacyKeys = ['tiktok', 'instagram', 'youtube', 'x', 'linkedin', 'facebook', 'threads']
  const isLegacy = legacyKeys.some((k) => parsed[k] && typeof parsed[k] === 'object' && parsed[k].caption)
  let canonical
  if (isLegacy) {
    const order = ['instagram', 'tiktok', 'facebook', 'youtube', 'linkedin', 'threads', 'x']
    const k = order.find((kk) => parsed[kk]?.caption) || Object.keys(parsed)[0]
    const v = parsed[k] || {}
    canonical = { title: v.title || '', caption: v.caption || '', hashtags: v.hashtags || '', first_comment: v.first_comment || '' }
  } else {
    canonical = {
      title: parsed.title || '',
      caption: parsed.caption || '',
      hashtags: parsed.hashtags || '',
      first_comment: parsed.first_comment || '',
    }
  }
  // Salvage from raw text on JSON parse failure.
  if (!canonical.caption && raw) {
    canonical.caption = String(raw).replace(/#[\w]+/g, '').trim().slice(0, 1500)
    if (!canonical.hashtags) {
      canonical.hashtags = (String(raw).match(/#[\w]+/g) || []).slice(0, 5).join(' ')
    }
  }

  // User edits in the body win over the AI output.
  return {
    title:         (edits?.edited_title         ?? canonical.title)         || '',
    caption:       (edits?.edited_caption       ?? canonical.caption)       || '',
    hashtags:      (edits?.edited_hashtags      ?? canonical.hashtags)      || '',
    first_comment: (edits?.edited_first_comment ?? canonical.first_comment) || '',
  }
}

// Multi-clip caption generator. Given N script chunks (typically
// voice_gen audio_chunks' sentence text), asks Claude for N caption
// sets in a single call. Returns the canonical single-caption shape
// (first chunk's caption) PLUS a captions[] array indexed by chunk
// order so schedule_post can match clip[i] → captions[i].
//
// One call instead of N is cheaper, faster, AND keeps voice
// consistent across the batch.
async function runMultiCaption({ ctx, profileId, chunkSentences, edits }) {
  const intro = `From the ${chunkSentences.length} short script segments below, write ${chunkSentences.length} INDEPENDENT caption sets — one per segment. Each segment becomes its own social post (different clip, different audience scroll), so each set must stand on its own.

Per-set rules (apply to EVERY set):
- title: ≤ 80 chars, click-worthy, no number prefix.
- caption: ≤ 1500 chars. Strong hook in the first sentence. Reads naturally on every platform (TikTok / IG / YouTube / Facebook / X / LinkedIn / Threads).
- hashtags: EXACTLY 5, space-separated, each starting with #. Lead with the brand's core hashtags.
- first_comment: ≤ 220 chars. Engagement driver, not a duplicate of the caption, no hashtags.

Across-the-batch rules:
- Each set must be DIFFERENT — different hook, different angle, different vocabulary. Don't write 6 captions about the same insight phrased 6 ways.
- Match each segment's actual content. The hook of caption #3 should reflect what segment #3 says, not segment #1.
- Voice stays consistent (same brand bible) but the substance varies per segment.

Voice: NEVER use em dashes. Use commas, periods, or colons.

Return ONLY valid JSON, no preamble, no markdown fences. Exact shape:
{
  "sets": [
    { "idx": 0, "title": "", "caption": "", "hashtags": "#a #b #c #d #e", "first_comment": "" }
  ]
}

Segments:
${chunkSentences.map((c) => `--- segment ${c.idx} ---\n${c.text.slice(0, 800)}`).join('\n\n')}`

  const r = await fetch('/api/content/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
    body: JSON.stringify({
      profile_id: profileId,
      format: 'ig-post',
      topic: intro,
      count: 1,
      dry_run: true,
    }),
  })
  const body = await r.json()
  if (!r.ok) throw new Error(body.error || `Caption fan-out failed (${r.status})`)
  const item = body.items?.[0] || {}
  const raw = item.full_script || item.caption || ''
  let parsed = {}
  try {
    const cleaned = String(raw).replace(/```json\s*|```\s*/gi, '').trim()
    const m = cleaned.match(/\{[\s\S]*\}/)
    parsed = JSON.parse(m ? m[0] : cleaned)
  } catch { parsed = {} }

  const sets = Array.isArray(parsed.sets) ? parsed.sets : []
  if (!sets.length) {
    throw new Error('Caption fan-out returned no sets. The model may have malformed JSON; try Re-run.')
  }

  // Re-pair to chunk order (Claude usually keeps order but doesn't
  // guarantee it). Falls back to array index when idx is missing.
  const byIdx = new Map()
  sets.forEach((s, i) => {
    const idx = Number.isFinite(s?.idx) ? s.idx : i
    byIdx.set(idx, s)
  })
  // Per-clip user edits stored from previous runs (set by the body's
  // pagination editor). Apply them on top of the AI output so re-runs
  // preserve manual tweaks. Key lookup tolerates both numeric and
  // string indices because JSON serialisation can flip them.
  const editedCaptions = edits?.edited_captions || {}
  const captions = chunkSentences.map((c, i) => {
    // Pair AI output to our segment with three fall-backs:
    //   1. explicit idx match — Claude obeyed and stamped {idx: c.idx}
    //   2. array-position match — Claude returned sets[] in the same
    //      order we sent segments (the common case when chunkSentences
    //      has gappy idx like [0,3] after some clips failed transcribe).
    //   3. empty placeholder.
    // Without (2) we silently produced blank captions any time
    // chunkSentences.idx didn't line up with 0..N-1.
    const s = byIdx.get(c.idx) || sets[i] || {}
    const ue = editedCaptions[i] || editedCaptions[String(i)] || {}
    return {
      order: c.order,
      idx: c.idx,
      title:         String(ue.title         ?? s.title         ?? '').slice(0, 200),
      caption:       String(ue.caption       ?? s.caption       ?? '').slice(0, 2000),
      hashtags:      String(ue.hashtags      ?? s.hashtags      ?? ''),
      first_comment: String(ue.first_comment ?? s.first_comment ?? '').slice(0, 400),
      source_text:   c.text.slice(0, 240),
    }
  })

  // Canonical single-caption fields = first set, with user edits
  // overlaid (the body still shows one editable set; downstream uses
  // captions[] for per-clip).
  const first = captions[0]
  const userTitle    = edits?.edited_title
  const userCaption  = edits?.edited_caption
  const userHashtags = edits?.edited_hashtags
  const userFirstComment = edits?.edited_first_comment
  return {
    captions,                                    // ← per-clip array
    title:         (userTitle        ?? first.title)         || '',
    caption:       (userCaption      ?? first.caption)       || '',
    hashtags:      (userHashtags     ?? first.hashtags)      || '',
    first_comment: (userFirstComment ?? first.first_comment) || '',
    is_clip_set:   true,
    chunk_count:   captions.length,
  }
}

// Collects EVERY video URL from the upstream bag, deduped, in encounter
// order. Used by Finish video to fan out across a Collection or a
// multi-clip avatar_render output. Same shape coverage as
// pickFirstVideoUrl — just exhaustive instead of first-match.
function pickAllVideoUrls(arr) {
  const seen = new Set()
  const out = []
  const push = (u) => { if (u && !seen.has(u)) { seen.add(u); out.push(u) } }
  for (const v of asArr(arr)) {
    if (!v || typeof v !== 'object') continue
    if (v.video?.video_url) push(v.video.video_url)
    if (v.video_url) push(v.video_url)
    if (Array.isArray(v.videos)) {
      for (const c of v.videos) {
        if (c?.video_url) push(c.video_url)
        else if (c?.url && /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(c.url)) push(c.url)
      }
    }
    if (Array.isArray(v.images)) {
      for (const c of v.images) {
        const u = c?.url || (typeof c === 'string' ? c : null)
        if (u && /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(u)) push(u)
      }
    }
    if (Array.isArray(v.items)) {
      for (const it of v.items) if (it?.kind === 'video' && it.url) push(it.url)
    }
  }
  return out
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

// Downscale a raster image to a JPEG data URL with max edge `maxEdge`,
// keeping aspect ratio. Skips files already small enough (< ~1.2MB) so
// we don't lose quality on tiny inputs. The 4.5MB Vercel body limit +
// base64 inflation (~33%) means we want the encoded payload under ~3MB,
// which works out to roughly a 1280px edge at JPEG q=0.85 for typical
// phone photos.
async function downscaleToDataUrl(file, { maxEdge = 1280, quality = 0.85 } = {}) {
  // Tiny files pass through unchanged so we don't recompress already-small assets.
  if (file.size && file.size < 1.2 * 1024 * 1024) return fileToDataUrl(file)

  const dataUrl = await fileToDataUrl(file)
  const img = await new Promise((res, rej) => {
    const i = new Image()
    i.onload = () => res(i)
    i.onerror = () => rej(new Error('Could not decode image for resizing'))
    i.src = dataUrl
  })
  const w = img.naturalWidth || 0
  const h = img.naturalHeight || 0
  if (!w || !h) return dataUrl
  if (Math.max(w, h) <= maxEdge) return dataUrl

  const scale = maxEdge / Math.max(w, h)
  const nw = Math.round(w * scale)
  const nh = Math.round(h * scale)
  const c = document.createElement('canvas')
  c.width = nw; c.height = nh
  const ctx = c.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  // White background for transparent PNGs since we're encoding to JPEG.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, nw, nh)
  ctx.drawImage(img, 0, 0, nw, nh)
  return c.toDataURL('image/jpeg', quality)
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
  const dataUrl = isSvg ? await svgToPngDataUrl(file) : await downscaleToDataUrl(file)
  // After downscaling we always emit JPEG, so normalize the filename to .jpg
  // (KIE keys the upload by extension for content-type sniffing).
  const baseName = (file.name || `image-${Date.now()}`).replace(/\.[^.]+$/, '')
  const fileName = isSvg ? baseName + '.png' : baseName + '.jpg'
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

// Direct-to-storage video upload for the Upload Media node. The
// reference-image route is JSON+base64 (works fine for small images
// but blows up on multi-MB videos hitting Vercel's body cap). Going
// straight to Supabase storage is faster and dodges that wall.
async function uploadVideoToBucket(file, profileId) {
  return uploadVideoWithProgress(file, profileId, null)
}

// XHR-backed video upload that fires per-byte progress callbacks. The
// supabase-js client wraps fetch, which doesn't expose upload progress
// events, so we bypass it and POST directly to the Storage REST API —
// same auth, same endpoint shape, plus a working onprogress handler.
//
//   onProgress({ loaded, total, pct })  — fires repeatedly during upload.
//
// Returns the public URL on success, throws on failure. Honors AbortSignal.
async function uploadVideoWithProgress(file, profileId, onProgress, { signal } = {}) {
  const ext = (file.name?.split('.').pop() || 'mp4').toLowerCase()
  const safeExt = ['mp4', 'mov', 'webm', 'm4v'].includes(ext) ? ext : 'mp4'
  const path = `${profileId || 'shared'}/uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`
  const bucket = 'landing-media'
  const session = (await supabase.auth.getSession()).data.session
  const token = session?.access_token
  if (!token) throw new Error('Not authenticated')

  // The Supabase Storage REST API. supabase-js uses the same shape under
  // the hood; we just trade `body: file` for an XHR send so progress is
  // observable. apikey + bearer both required for authenticated uploads.
  const supabaseUrl = supabase.supabaseUrl || ''
  const supabaseKey = supabase.supabaseKey || ''
  if (!supabaseUrl) throw new Error('Supabase URL not configured')
  const url = `${supabaseUrl}/storage/v1/object/${bucket}/${encodeURIComponent(path).replace(/%2F/g, '/')}`

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url, true)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    if (supabaseKey) xhr.setRequestHeader('apikey', supabaseKey)
    xhr.setRequestHeader('Content-Type', file.type || 'video/mp4')
    // Match supabase-js default. upsert=true would let re-uploads
    // overwrite; we want a fresh random path so collisions are
    // impossible, hence false.
    xhr.setRequestHeader('x-upsert', 'false')

    xhr.upload.onprogress = (e) => {
      if (!onProgress || !e.lengthComputable) return
      onProgress({
        loaded: e.loaded,
        total: e.total,
        pct: e.total > 0 ? Math.min(100, (e.loaded / e.total) * 100) : 0,
      })
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const { data } = supabase.storage.from(bucket).getPublicUrl(path)
        resolve(data.publicUrl)
      } else {
        let msg = `Upload failed (${xhr.status})`
        try {
          const body = JSON.parse(xhr.responseText)
          if (body?.message) msg = body.message
          else if (body?.error) msg = body.error
        } catch {}
        reject(new Error(msg))
      }
    }
    xhr.onerror = () => reject(new Error('Upload network error'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))
    if (signal) {
      if (signal.aborted) { xhr.abort(); return }
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }
    xhr.send(file)
  })
}

// HEVC (H.265) detector. iPhone Pro models default to recording in
// HEVC, which:
//   - decodes 3-4x more memory-hungry than H.264 (fly worker OOMs)
//   - browsers vary wildly in playback support
//   - many third-party services (Shotstack, ZapCap) don't honor
//     rotation metadata in HEVC reliably
// We reject at upload time so users get a clear actionable error
// instead of silent failures three steps later in the pipeline.
//
// Detection: HEVC samples in MP4 / MOV use the `hvc1` (or `hev1`)
// FourCC in the stsd atom inside moov. Reading the first 256 KB of
// the file is enough to capture the moov box in 99% of consumer
// recordings (faststart MP4 puts moov up front; iPhone .mov puts it
// at end but stsd is small and the box header appears early). We
// scan the bytes for either signature — false positives only happen
// if those exact 4 bytes appear in payload data, which is vanishingly
// rare in the first 256 KB.
async function detectHevc(file) {
  try {
    const chunkSize = Math.min(file.size, 256 * 1024)
    const ab = await file.slice(0, chunkSize).arrayBuffer()
    const bytes = new Uint8Array(ab)
    const matches = (sig) => {
      const a = sig.charCodeAt(0), b = sig.charCodeAt(1), c = sig.charCodeAt(2), d = sig.charCodeAt(3)
      const end = bytes.length - 4
      for (let i = 0; i < end; i++) {
        if (bytes[i] === a && bytes[i + 1] === b && bytes[i + 2] === c && bytes[i + 3] === d) return true
      }
      return false
    }
    return matches('hvc1') || matches('hev1')
  } catch {
    return false
  }
}

// Off-DOM probe: load video metadata + first frame, return
// { width, height, duration } so the upload UI can reject non-vertical
// videos before they hit storage. The 9:16 enforcement matches what
// downstream nodes (avatar render, finish video) actually consume.
function probeVideoMeta(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const v = document.createElement('video')
    v.preload = 'metadata'
    const cleanup = () => { try { URL.revokeObjectURL(url) } catch {} }
    v.onloadedmetadata = () => {
      cleanup()
      resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration || 0 })
    }
    v.onerror = () => { cleanup(); reject(new Error('Could not read video metadata')) }
    v.src = url
  })
}

// ─── 1. TEXT INPUT ──────────────────────────────────────────────────────────
function TextInputBody({ data, onPatch }) {
  const value = data.props?.text || ''
  const charCount = value.length
  return (
    <>
      <ExpandableTextarea
        value={value}
        onChange={(v) => onPatch({ text: v })}
        placeholder='Try "Happy dog with sunglasses and floating ring"'
        minHeight={110}
        title="Text editor"
      />
      {charCount > 0 && (
        <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 4, textAlign: 'right' }}>
          {charCount.toLocaleString()} chars
        </div>
      )}
      <NodePreview status={data.status} output={data.output} error={data.error} />
    </>
  )
}

// Reusable: textarea + corner expand button + fullscreen editor modal.
// Drop in anywhere inside a node body that has a meaningful text field
// (caption, first comment, transcript, etc.) so the user can pop out
// to a real editor instead of squinting at a 70px-tall box.
//   - `nodrag nowheel` so highlighting / inner scroll work in React Flow.
//   - `resize: vertical` for inline grow.
//   - `onChange` fires on every keystroke so parent state stays in sync;
//     modal Save commits on click and closes.
function ExpandableTextarea({
  value, onChange, placeholder, minHeight = 70, maxHeight = 260,
  title = 'Text editor', onClick,
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <textarea
        className="nodrag nowheel"
        style={{
          ...tinyInput,
          minHeight, maxHeight,
          resize: 'vertical', fontFamily: 'inherit',
          paddingRight: 30,
          width: '100%',
        }}
        placeholder={placeholder}
        value={value}
        onChange={(e) => { e.stopPropagation(); onChange(e.target.value) }}
        onClick={onClick}
      />
      <button
        type="button"
        className="nodrag"
        onClick={(e) => { e.stopPropagation(); setExpanded(true) }}
        title="Expand editor"
        aria-label="Expand text editor"
        style={{
          position: 'absolute', top: 4, right: 4,
          padding: 4, borderRadius: 6,
          background: 'rgba(0,0,0,0.5)',
          border: '1px solid rgba(255,255,255,0.08)',
          color: 'var(--text-soft)', cursor: 'pointer',
          display: 'inline-flex',
        }}
      >
        <Maximize2 size={11} />
      </button>
      {expanded && (
        <ExpandedTextEditor
          title={title}
          value={value}
          onCommit={(next) => { onChange(next); setExpanded(false) }}
          onClose={() => setExpanded(false)}
        />
      )}
    </div>
  )
}

// Fullscreen text editor used by ExpandableTextarea (Text node body,
// CaptionGen caption + first-comment fields, etc.). Opens above the
// canvas (z-index well above React Flow), portals to the body so node
// transforms don't clip it, captures Esc, and commits on Save.
function ExpandedTextEditor({ value, onCommit, onClose, title = 'Text editor' }) {
  const [draft, setDraft] = useState(value || '')
  const taRef = useRef(null)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      // Cmd/Ctrl+Enter saves — common shortcut for this kind of editor.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onCommit(draft)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft, onClose, onCommit])
  useEffect(() => {
    // Auto-focus + place caret at the end so the user picks up where
    // they left off without losing their cursor position.
    const el = taRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  return (
    <div
      onClick={onClose}
      onMouseDown={(e) => e.stopPropagation()}  // don't let the canvas marquee-select beneath us
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(8px)',
        display: 'grid', placeItems: 'center', padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(880px, calc(100vw - 32px))',
          height: 'min(680px, calc(100vh - 48px))',
          display: 'flex', flexDirection: 'column',
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 14, overflow: 'hidden',
          boxShadow: '0 30px 80px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '14px 18px', borderBottom: '1px solid var(--border)',
        }}>
          <Type size={16} style={{ color: 'var(--text-soft)' }} />
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, flex: 1 }}>
            {title}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            {draft.length.toLocaleString()} chars · ⌘↵ to save
          </div>
          <button
            type="button" onClick={onClose} aria-label="Close"
            style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4, borderRadius: 6 }}
          ><X size={16} /></button>
        </div>
        <textarea className="nodrag nowheel"
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={true}
          style={{
            flex: 1, width: '100%', resize: 'none',
            background: 'var(--surface)', border: 'none', outline: 'none',
            color: 'var(--text)', fontFamily: 'inherit',
            fontSize: 14, lineHeight: 1.6,
            padding: '18px 22px',
          }}
          placeholder="Write here. Mention upstream nodes with @nodeName."
        />
        <div style={{
          display: 'flex', gap: 10, justifyContent: 'flex-end',
          padding: '12px 18px', borderTop: '1px solid var(--border)',
        }}>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => onCommit(draft)}>
            <Save size={13} /> Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Reference URL body ─────────────────────────────────────────────────────
// Paste a URL, click Run, get a transcript output. Body shows the
// resolved creator handle + a transcript preview after a successful
// run so the user knows what's downstream.
function UrlReferenceBody({ data, onPatch }) {
  const out = data.output
  const url = data.props?.source_url || ''
  return (
    <>
      <div style={{ position: 'relative' }}>
        <Link2 size={11} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
        <input
          className="nodrag"
          style={{ ...tinyInput, width: '100%', paddingLeft: 26 }}
          placeholder="https://www.tiktok.com/@user/video/123…"
          value={url}
          onChange={(e) => onPatch({ source_url: e.target.value })}
        />
      </div>
      {data.status === 'running' && <ProgressPill progress={data.progress} fallback="Transcribing…" />}
      {data.status === 'failed' && <NodePreview status="failed" error={data.error} />}
      {out?.transcript && (
        <div style={{ marginTop: 8 }}>
          {out.creator_handle && (
            <div style={{ fontSize: 11, color: 'var(--text-soft)', marginBottom: 4 }}>
              <strong>@{out.creator_handle}</strong>
              {out.duration_secs ? ` · ${out.duration_secs}s` : ''}
              {out.source_url && (
                <a href={out.source_url} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 6, color: 'var(--muted)' }}>
                  <ExternalLink size={9} />
                </a>
              )}
            </div>
          )}
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 10.5, color: 'var(--muted)' }}>
              Transcript ({out.transcript.length.toLocaleString()} chars)
            </summary>
            <div style={{
              marginTop: 4, padding: 8, borderRadius: 6,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.5,
              maxHeight: 140, overflowY: 'auto', whiteSpace: 'pre-wrap',
            }}>{out.transcript}</div>
          </details>
        </div>
      )}
    </>
  )
}

// Module-level cache for the script_formats catalog. The list rarely
// changes, so one fetch per session is fine. Each ScriptGenBody mount
// just reads from the cache (or kicks off a fetch if cold).
let _scriptFormatsCache = null
let _scriptFormatsPromise = null
function useScriptFormats() {
  const [formats, setFormats] = useState(_scriptFormatsCache)
  useEffect(() => {
    if (_scriptFormatsCache) return
    if (_scriptFormatsPromise) {
      _scriptFormatsPromise.then(setFormats).catch(() => {})
      return
    }
    _scriptFormatsPromise = (async () => {
      const sess = (await supabase.auth.getSession()).data.session
      const r = await fetch('/api/script-formats', {
        headers: { Authorization: `Bearer ${sess?.access_token || ''}` },
      })
      const body = await r.json().catch(() => ({}))
      const arr = Array.isArray(body?.formats) ? body.formats : []
      _scriptFormatsCache = arr
      return arr
    })()
    _scriptFormatsPromise.then(setFormats).catch(() => { _scriptFormatsPromise = null })
  }, [])
  return formats || []
}

// ─── 2. SCRIPT GENERATOR ────────────────────────────────────────────────────
function ScriptGenBody({ data, onPatch }) {
  const format = data.props?.format || 'tiktok-script'
  // Length picker only makes sense for spoken-script formats. Other
  // formats (caption, thread, blog) are governed by per-format hints.
  // Cap at 60s — anything longer is rarely useful for short-form
  // social content and burns more credits per render.
  const showLengthPicker = format === 'tiktok-script' || format === 'youtube-short'
  const lenSecs = Number(data.props?.target_length_secs ?? 45)
  const profiles = data?._ctxProfiles || []
  const structural = data.props?.structural_format || ''
  const structuralFormats = useScriptFormats()
  const out = data.output
  const script = out?.script || out?.full_script || ''
  const [copied, setCopied] = useState(false)

  const onAutoPrompt = () => {
    // Build a generic-enough auto-prompt that works for any brand
    // profile the user has tagged in @ mentions or selected via
    // brand_profile upstream. The generator's own system prompt
    // injects brand bible / voice / hashtags from the profile, so
    // we just need to give it a rotation framework it can run
    // through.
    const tag = profiles[0]?.business_name
      ? `@${profiles[0].business_name.replace(/[^A-Za-z0-9_-]/g, '')}`
      : '@your-brand'
    const auto = `Pick a fresh angle for a short-form script for ${tag}. Rotate between: a story-time, a lesson learned, a hot take on a common myth, before/after transformation, friend-giving-tough-love rant, things never to tolerate / settle for, a pattern to spot early, a standards reset, a behind-the-scenes peek, a "what I'd tell my younger self" reflection. Stay on the brand's voice and core topics from the brand bible. NO em dashes — use commas, periods, or colons. Don't repeat angles or core talking points from previous runs.`
    onPatch({ topic: auto })
  }

  const copyScript = () => {
    if (!script) return
    try {
      navigator.clipboard?.writeText(script)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {}
  }

  const mode = data.props?.mode === 'remix' ? 'remix' : 'original'

  return (
    <>
      {/* Mode selector — Original (topic-driven, default) vs Remix
          (rewrites an upstream Reference URL transcript in the user's
          voice). Wire a Reference URL node into the input handle when
          using Remix. */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 6, padding: 3, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 7 }}>
        {[
          { id: 'original', label: 'Original',  hint: 'Write from a topic / hook.' },
          { id: 'remix',    label: 'Remix URL', hint: 'Rewrite an upstream Reference URL in your voice.' },
        ].map((m) => (
          <button
            key={m.id}
            type="button" className="nodrag"
            onClick={(e) => { e.stopPropagation(); onPatch({ mode: m.id }) }}
            title={m.hint}
            style={{
              flex: 1, padding: '5px 8px', borderRadius: 5,
              background: mode === m.id ? 'var(--surface)' : 'transparent',
              border: mode === m.id ? '1px solid var(--border)' : '1px solid transparent',
              color: mode === m.id ? 'var(--text)' : 'var(--text-soft)',
              fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10.5,
              cursor: 'pointer', letterSpacing: '0.04em',
            }}
          >{m.label}</button>
        ))}
      </div>

      {mode === 'remix' ? (
        <div style={{
          padding: 8, borderRadius: 6,
          background: 'rgba(236,72,153,0.10)', border: '1px solid rgba(236,72,153,0.30)',
          fontSize: 10.5, color: 'var(--text-soft)', lineHeight: 1.45, marginBottom: 6,
        }}>
          <Link2 size={10} style={{ verticalAlign: '-1px', marginRight: 4, color: '#f472b6' }} />
          Wire a <strong>Reference URL</strong> into the input. The transcript gets rewritten in your brand voice. The topic field below is optional — set it to nudge the angle.
        </div>
      ) : null}

      <MentionPrompt
        value={data.props?.topic || ''}
        onChange={(v) => onPatch({ topic: v })}
        placeholder={mode === 'remix' ? 'Optional: angle hint for the rewrite (e.g. "lean into the pain point").' : 'Topic or hook. Type @ to tag a brand profile.'}
        minHeight={70}
        brands={profiles}
      />
      <div style={{ display: 'flex', gap: 4, marginTop: 4, marginBottom: 6 }}>
        <button
          type="button"
          className="nodrag"
          onClick={(e) => { e.stopPropagation(); onAutoPrompt() }}
          title="Drop a brand-aware rotation prompt into the topic field"
          style={{
            flex: 1, padding: '5px 8px', borderRadius: 6, fontSize: 10.5,
            background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.40)',
            color: 'var(--red)', cursor: 'pointer',
            fontFamily: 'var(--font-display)', fontWeight: 700,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
          }}
        >
          <Wand2 size={10} /> Auto prompt
        </button>
      </div>
      <div style={pillRow}>
        <select className="nodrag" style={pillSelect} value={format} onChange={(e) => onPatch({ format: e.target.value })}>
          <option value="tiktok-script">TikTok</option>
          <option value="ig-post">Instagram</option>
          <option value="thread">Thread</option>
          <option value="youtube-short">YT Short</option>
          <option value="email-subject">Email subj</option>
          <option value="blog-post">Blog post</option>
        </select>
        {showLengthPicker && (
          <select className="nodrag"
            style={pillSelect}
            value={lenSecs}
            onChange={(e) => onPatch({ target_length_secs: Number(e.target.value) })}
            title="Target script length in seconds (max 60 — short-form sweet spot). Voice gen has 3 min headroom if Claude slightly overshoots."
          >
            <option value={15}>~15 sec</option>
            <option value={30}>~30 sec</option>
            <option value={45}>~45 sec</option>
            <option value={60}>~60 sec</option>
          </select>
        )}
        {/* Structural format picker. "Auto" lets Claude decide based on
            topic + brand voice; the catalog options pin a specific shape. */}
        <select className="nodrag"
          style={pillSelect}
          value={structural}
          onChange={(e) => onPatch({ structural_format: e.target.value || null })}
          title="Pin a script shape (story / listicle / etc.) — leave on Auto to let the AI pick."
        >
          <option value="">Auto shape</option>
          {structuralFormats.map((f) => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
      </div>
      {script && (
        <div style={{
          marginTop: 8, padding: '10px 12px', borderRadius: 8,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-soft)',
          maxHeight: 220, overflowY: 'auto', whiteSpace: 'pre-wrap',
        }}>
          {script}
        </div>
      )}
      {script && (
        <button
          type="button"
          className="nodrag"
          onClick={(e) => { e.stopPropagation(); copyScript() }}
          style={{
            marginTop: 6, width: '100%', padding: '6px 8px', fontSize: 11,
            background: copied ? 'rgba(46,204,113,0.15)' : 'var(--surface-2)',
            border: `1px solid ${copied ? 'rgba(46,204,113,0.40)' : 'var(--border)'}`,
            borderRadius: 6,
            color: copied ? '#2ecc71' : 'var(--text)',
            cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}
        >
          <Copy size={11} /> {copied ? 'Copied!' : 'Copy script'}
        </button>
      )}
      {!script && <NodePreview status={data.status} output={null} error={data.error} />}
    </>
  )
}

// ─── TEXT POST (per-platform native posts) ──────────────────────────────────
// Body for text_post_gen. Three regions:
//   1. Platform pills (toggle which platforms are included)
//   2. Pagination tabs (one per selected platform)
//   3. Editable textarea for the currently-paginated platform, with
//      a character-count + expand control
//
// Char limits per platform are surfaced in the count display so the user
// knows how close they are to the cap as they edit.
const TEXT_POST_PLATFORMS = [
  { id: 'x',        label: 'X',        max: 280 },
  { id: 'threads',  label: 'Threads',  max: 500 },
  { id: 'facebook', label: 'Facebook', max: 2000 },
  { id: 'linkedin', label: 'LinkedIn', max: 3000 },
]

function TextPostGenBody({ data, onPatch }) {
  const props = data.props || {}
  const selected = Array.isArray(props.platforms) && props.platforms.length
    ? props.platforms
    : ['x', 'threads', 'facebook', 'linkedin']
  // Generated AI output + user-edited overrides. Edits win on display
  // and are forwarded to downstream nodes by the node's run() merger.
  const generated = (data.output?.per_platform && typeof data.output.per_platform === 'object')
    ? data.output.per_platform
    : (props.per_platform || {})
  const edited = props.edited || {}
  // Pagination — show the FIRST selected platform on first render, but
  // remember the user's last-viewed tab in state.
  const [activeTab, setActiveTab] = useState(selected[0] || 'x')
  const [expanded, setExpanded] = useState(false)
  const prompt = props.prompt || ''
  useEffect(() => {
    if (!selected.includes(activeTab)) setActiveTab(selected[0] || 'x')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.join('|')])

  const togglePlatform = (id) => {
    const next = selected.includes(id) ? selected.filter((p) => p !== id) : [...selected, id]
    if (!next.length) return // require at least one
    onPatch({ platforms: next })
  }

  const currentText = (edited[activeTab] ?? generated[activeTab] ?? '')
  const max = TEXT_POST_PLATFORMS.find((p) => p.id === activeTab)?.max || 1000
  const len = currentText.length
  const overCap = len > max

  const setText = (text) => {
    onPatch({ edited: { ...edited, [activeTab]: text } })
  }
  const resetEdit = () => {
    const nextEdited = { ...edited }
    delete nextEdited[activeTab]
    onPatch({ edited: nextEdited })
  }

  return (
    <>
      {/* Built-in prompt. The user can type their idea directly here
          instead of wiring a Text node into "in". A wired Text node
          still overrides this when present (run() checks inputs first
          and falls back to props.prompt). */}
      <div style={{ fontSize: 10, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 3 }}>
        Prompt
      </div>
      <textarea
        className="nodrag"
        value={prompt}
        placeholder="What should the post be about? (e.g. 'Quick reaction to the Anthropic pricing change') — or wire a Text node into 'in'."
        onChange={(e) => onPatch({ prompt: e.target.value })}
        onClick={(e) => e.stopPropagation()}
        rows={2}
        style={{ ...tinyInput, width: '100%', fontSize: 11.5, lineHeight: 1.4, padding: 8, marginBottom: 8, resize: 'vertical' }}
      />

      {/* Brand-profile toggle. When on (default), the active brand's
          voice + bible + hashtags get baked into the prompt sent to
          Claude — same effect as wiring a brand_profile node in. Off
          = generic posts that ignore brand context. A wired
          brand_profile node always wins over this checkbox. */}
      <label
        title="Write in the current brand's voice using its saved bible. Same as wiring a Brand profile node in."
        style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
          fontSize: 11, color: props.use_brand !== false ? 'var(--text)' : 'var(--muted)',
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        <input
          type="checkbox"
          checked={props.use_brand !== false}
          onChange={(e) => { e.stopPropagation(); onPatch({ use_brand: e.target.checked }) }}
          onClick={(e) => e.stopPropagation()}
          style={{ accentColor: '#0ea5e9' }}
        />
        Use brand profile voice
      </label>

      {/* Platform pills */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
        {TEXT_POST_PLATFORMS.map((p) => {
          const on = selected.includes(p.id)
          return (
            <button
              key={p.id} type="button"
              onClick={(e) => { e.stopPropagation(); togglePlatform(p.id) }}
              style={{
                padding: '4px 9px', borderRadius: 999, cursor: 'pointer',
                fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10,
                letterSpacing: '0.04em',
                background: on ? 'rgba(14,165,233,0.18)' : 'var(--surface-2)',
                color: on ? '#0ea5e9' : 'var(--text-soft)',
                border: `1px solid ${on ? 'rgba(14,165,233,0.45)' : 'var(--border)'}`,
              }}
            >{p.label}</button>
          )
        })}
      </div>

      {/* Pagination tabs */}
      {selected.length > 1 && (
        <div style={{ display: 'flex', gap: 2, marginBottom: 6, borderBottom: '1px solid var(--border)' }}>
          {selected.map((id) => {
            const def = TEXT_POST_PLATFORMS.find((p) => p.id === id)
            const isActive = id === activeTab
            return (
              <button
                key={id} type="button"
                onClick={(e) => { e.stopPropagation(); setActiveTab(id) }}
                style={{
                  padding: '5px 9px', cursor: 'pointer',
                  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10,
                  background: 'transparent', border: 'none',
                  color: isActive ? '#0ea5e9' : 'var(--muted)',
                  borderBottom: isActive ? '2px solid #0ea5e9' : '2px solid transparent',
                  marginBottom: -1,
                }}
              >{def?.label || id}</button>
            )
          })}
        </div>
      )}

      {/* Editable post body */}
      <textarea
        className="nodrag"
        value={currentText}
        placeholder={`Run to generate. ${TEXT_POST_PLATFORMS.find((p) => p.id === activeTab)?.label || ''} max ${max} chars.`}
        onChange={(e) => setText(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        style={{
          ...tinyInput, width: '100%',
          minHeight: expanded ? 280 : 110,
          maxHeight: expanded ? 540 : 200,
          fontFamily: 'var(--font-body)',
          fontSize: 12, lineHeight: 1.45,
          resize: 'vertical',
          padding: 8,
        }}
      />

      {/* Char count + actions */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginTop: 4,
        fontSize: 10.5,
      }}>
        <span style={{ color: overCap ? 'var(--red)' : 'var(--muted)' }}>
          {len} / {max}
        </span>
        <span style={{ flex: 1 }} />
        {edited[activeTab] != null && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); resetEdit() }}
            style={{
              padding: '2px 6px', borderRadius: 4,
              background: 'transparent', border: 'none',
              color: 'var(--muted)', cursor: 'pointer', fontSize: 10,
            }}
            title="Discard your edit and show the AI-generated version"
          >Reset</button>
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}
          style={{
            padding: '2px 6px', borderRadius: 4,
            background: 'transparent', border: 'none',
            color: 'var(--muted)', cursor: 'pointer', fontSize: 10,
          }}
        >{expanded ? 'Compact' : 'Expand'}</button>
      </div>
    </>
  )
}

// ─── 3. CAPTION + HASHTAGS (merged) ─────────────────────────────────────────
function CaptionGenBody({ data, onPatch }) {
  // Single canonical title + caption + hashtags + first_comment. The
  // platform layer (schedule_post + /api/social/upload-post) maps these
  // to per-platform Upload-Post fields with proper char-limit handling.
  //
  // Multi-clip mode: when caption_gen ran in fan-out mode (videos or
  // voice_gen audio_chunks upstream), data.output.captions[] holds one
  // set per clip. We paginate through them and edit each independently.
  // Edits land in props.edited_captions[idx] for re-run, AND mirror into
  // data.output.captions[idx] so schedule_post picks them up without a
  // caption_gen re-run.
  const out = data.output
  const hasOutput = !!out
  const captions = Array.isArray(out?.captions) ? out.captions : null
  const isMulti = !!(captions && captions.length > 1)
  const totalClips = isMulti ? captions.length : 1

  const [clipIdx, setClipIdx] = useState(0)
  const safeIdx = Math.max(0, Math.min(clipIdx, totalClips - 1))

  // Backward compat: legacy outputs stored per_platform variants. If the
  // canonical fields are empty but variants exist, fall back to the
  // first variant that has a caption.
  const variants = out?.per_platform || {}
  const fallback = variants.instagram?.caption ? variants.instagram
    : variants.tiktok?.caption ? variants.tiktok
    : Object.values(variants).find((v) => v?.caption) || {}

  // Edits storage:
  //   single-clip → props.edited_title / edited_caption / edited_hashtags / edited_first_comment
  //   multi-clip  → props.edited_captions[idx].{ title, caption, hashtags, first_comment }
  const editedCaptions = data.props?.edited_captions || {}
  let source, clipEdits
  if (isMulti) {
    source = captions[safeIdx] || {}
    clipEdits = editedCaptions[safeIdx] || {}
  } else {
    source = { ...fallback, ...out }
    clipEdits = {
      title:         data.props?.edited_title,
      caption:       data.props?.edited_caption,
      hashtags:      data.props?.edited_hashtags,
      first_comment: data.props?.edited_first_comment,
    }
  }
  const title        = clipEdits.title         ?? (source.title         || '')
  const caption      = clipEdits.caption       ?? (source.caption       || '')
  const hashtags     = clipEdits.hashtags      ?? (source.hashtags      || '')
  const firstComment = clipEdits.first_comment ?? (source.first_comment || '')

  // patchEdit handles BOTH halves of an edit:
  //   1. write to props (so re-running caption_gen preserves edits via
  //      the run function's edited_* / edited_captions read)
  //   2. mirror into data.output so downstream nodes consuming
  //      caption_gen.output see edits live, no re-run required
  const patchEdit = (field, value) => {
    if (isMulti) {
      const nextEdits = {
        ...editedCaptions,
        [safeIdx]: { ...editedCaptions[safeIdx], [field]: value },
      }
      onPatch({ edited_captions: nextEdits })
      if (out && Array.isArray(captions)) {
        const nextCaptions = captions.map((c, i) => i === safeIdx ? { ...c, [field]: value } : c)
        // Mirror clip[0] edits onto the canonical fields so legacy
        // single-clip consumers (or schedule_post fallback) still see
        // the latest values for the lead clip.
        const isLead = safeIdx === 0
        const nextOutput = {
          ...out,
          captions: nextCaptions,
          ...(isLead ? { [field]: value } : {}),
        }
        if (typeof window !== 'undefined' && window.__spacePatchOutput) {
          window.__spacePatchOutput(data.__id, nextOutput)
        }
      }
    } else {
      onPatch({ [`edited_${field}`]: value })
      if (out && typeof window !== 'undefined' && window.__spacePatchOutput) {
        window.__spacePatchOutput(data.__id, { ...out, [field]: value })
      }
    }
  }

  return (
    <>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.4 }}>
        Connect a script. Generates a <strong>title, caption, and 5 hashtags</strong> tuned for every platform.
      </div>
      {hasOutput && isMulti && (
        <div className="nodrag" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '6px 8px', marginBottom: 8,
          background: 'rgba(245, 158, 11, 0.10)',
          border: '1px solid rgba(245, 158, 11, 0.35)',
          borderRadius: 6, fontSize: 11.5,
        }}>
          <button
            type="button"
            className="nodrag"
            onClick={(e) => { e.stopPropagation(); setClipIdx((i) => Math.max(0, i - 1)) }}
            disabled={safeIdx === 0}
            style={{
              background: 'transparent', border: 'none', cursor: safeIdx === 0 ? 'not-allowed' : 'pointer',
              color: safeIdx === 0 ? 'var(--muted)' : '#f59e0b',
              padding: 4, opacity: safeIdx === 0 ? 0.4 : 1,
            }}
            title="Previous clip"
          >◀</button>
          <span style={{ fontWeight: 700, fontFamily: 'var(--font-display)', letterSpacing: '0.04em', color: '#f59e0b' }}>
            CLIP {safeIdx + 1} OF {totalClips}
          </span>
          <button
            type="button"
            className="nodrag"
            onClick={(e) => { e.stopPropagation(); setClipIdx((i) => Math.min(totalClips - 1, i + 1)) }}
            disabled={safeIdx === totalClips - 1}
            style={{
              background: 'transparent', border: 'none',
              cursor: safeIdx === totalClips - 1 ? 'not-allowed' : 'pointer',
              color: safeIdx === totalClips - 1 ? 'var(--muted)' : '#f59e0b',
              padding: 4, opacity: safeIdx === totalClips - 1 ? 0.4 : 1,
            }}
            title="Next clip"
          >▶</button>
        </div>
      )}
      {hasOutput && isMulti && captions?.[safeIdx]?.transcript_failed && (
        <div className="nodrag" style={{
          padding: '8px 10px', marginBottom: 8,
          background: 'rgba(239,68,68,0.10)',
          border: '1px solid rgba(239,68,68,0.35)',
          borderRadius: 6, fontSize: 11, color: 'var(--red)',
          lineHeight: 1.4,
        }}>
          <strong>Couldn't transcribe this clip.</strong> {captions[safeIdx].error || 'No audio detected.'}
          {' '}You can type the caption manually below, or re-record this clip with clearer audio and re-run.
        </div>
      )}
      {hasOutput && (
        <>
          <NodeField label="Title">
            <input
              className="nodrag"
              style={tinyInput}
              value={title}
              onChange={(e) => { e.stopPropagation(); patchEdit('title', e.target.value) }}
              onClick={(e) => e.stopPropagation()}
              placeholder="Title"
            />
          </NodeField>
          <NodeField label="Caption">
            <ExpandableTextarea
              value={caption}
              onChange={(v) => patchEdit('caption', v)}
              placeholder="Caption"
              minHeight={70}
              title="Caption"
              onClick={(e) => e.stopPropagation()}
            />
          </NodeField>
          <NodeField label="Hashtags">
            <input
              className="nodrag"
              style={tinyInput}
              value={hashtags}
              onChange={(e) => { e.stopPropagation(); patchEdit('hashtags', e.target.value) }}
              onClick={(e) => e.stopPropagation()}
              placeholder="#tag1 #tag2"
            />
          </NodeField>
          <NodeField label="First comment">
            <ExpandableTextarea
              value={firstComment}
              onChange={(v) => patchEdit('first_comment', v)}
              placeholder="Engagement question or value-add — lands as the first reply on the post."
              minHeight={50}
              title="First comment"
              onClick={(e) => e.stopPropagation()}
            />
          </NodeField>
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
            {isMulti
              ? `Per-clip edits override the AI output for that clip only. Edits flow into schedule_post immediately, no re-run needed.`
              : `Edits override the AI output for the next downstream step. Re-run to regenerate from the script.`}
          </div>
        </>
      )}
      {!hasOutput && <NodePreview status={data.status} output={null} error={data.error} />}
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
// Bigger modal version of the prompt editor for long prompts. Reuses
// MentionPrompt under the hood so chip autocomplete and @-resolution
// behave exactly the same. Closes on Escape, click-outside, or the
// X button. Value flows back to the parent through the same onChange.
function ExpandedPromptModal({ value, placeholder, brands, namedImages, onChange, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      onWheelCapture={(e) => e.stopPropagation()}
    >
      <div
        className="modal-card modal-card-xl"
        style={{ display: 'flex', flexDirection: 'column', maxHeight: '85vh', padding: 18 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14 }}>Prompt editor</div>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>Type @ to tag a brand profile or reference image.</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              marginLeft: 'auto',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 6,
              background: 'transparent', border: '1px solid var(--border)',
              color: 'var(--text-soft)', cursor: 'pointer', padding: 0,
            }}
          >
            <X size={14} />
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <MentionPrompt
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            minHeight={420}
            brands={brands}
            namedImages={namedImages}
            expandable={false}
          />
        </div>
      </div>
    </div>
  )
}

function MentionPrompt({ value, onChange, placeholder, minHeight = 60, brands = [], namedImages = [], expandable = true }) {
  const ref = useRef(null)
  const [suggest, setSuggest] = useState({ open: false, prefix: '', start: -1 })
  const [expanded, setExpanded] = useState(false)
  // Snapshot of the textarea selection captured on mousedown of any chip
  // button. Browsers blur the textarea on mousedown of an outside element,
  // and after blur some return selectionEnd as 0 OR as the text length —
  // either way `prompt.slice(end)` yields garbage and the click-to-insert
  // path eats characters. Reading from this ref instead of ta.selectionEnd
  // makes the insertion robust regardless of focus state.
  const lastSelRef = useRef({ start: 0, end: 0 })
  const captureSelection = () => {
    const ta = ref.current
    if (!ta) return
    lastSelRef.current = { start: ta.selectionStart || 0, end: ta.selectionEnd || 0 }
  }
  // Strip every non-token char (anything besides letters, digits, _, -) so
  // brands like "VernonTech & Media" produce a clean "@VernonTechMedia"
  // tag the parser can match end-to-end.
  // Coerce to string up-front. Some upstream callers pass numbers (e.g. the
  // 60-second cap on script_gen wires duration through), and value.match()
  // crashes the whole canvas if the prop ever lands as non-string.
  const promptStr = typeof value === 'string' ? value : (value == null ? '' : String(value))
  const tagFor = (name) => `@${(name || '').replace(/[^A-Za-z0-9_-]/g, '')}`

  function insertTag(name) {
    const tag = tagFor(name)
    const ta = ref.current
    // Source of truth for current text is the live textarea, NOT the closure
    // value — otherwise a fast typist + click can land an insert against
    // a stale prompt and silently chop characters.
    const current = ta?.value ?? value ?? ''
    if (!ta) { onChange(`${current} ${tag}`.trim()); return }
    // Resolve the active selection from whichever source actually has a
    // valid range. Some browsers reset selectionStart/End to 0 or to
    // text.length when the textarea is mid-blur, which would corrupt the
    // splice and either eat trailing text or insert at the wrong spot.
    // Priority: live DOM selection (most accurate) → captured ref
    // (fallback for blur cases) → end of text. We sanity-check that the
    // resolved range is inside the current text.
    const liveStart = ta.selectionStart
    const liveEnd   = ta.selectionEnd
    const ref0 = lastSelRef.current
    const haveLive = Number.isFinite(liveStart) && Number.isFinite(liveEnd)
    let selStart = haveLive ? liveStart : ref0.start
    let selEnd   = haveLive ? liveEnd   : ref0.end
    // If neither source seems sane (negative, beyond length), fall back
    // to a safe default at the end of the text.
    const len = current.length
    if (!Number.isFinite(selStart) || selStart < 0 || selStart > len) selStart = len
    if (!Number.isFinite(selEnd)   || selEnd   < 0 || selEnd   > len) selEnd   = selStart
    if (selEnd < selStart) selEnd = selStart

    // When the user had typed `@foo` and is picking from the popover, the
    // splice should replace from the `@` (suggest.start) up to the live
    // caret end. Otherwise we just splice in at the current selection.
    const start = suggest.start >= 0 ? suggest.start : selStart
    const end   = Math.max(selEnd, start)
    const before = current.slice(0, start)
    const after  = current.slice(end)
    const needsTrailingSpace = after.length === 0 ? false : !after.startsWith(' ')
    const next = `${before}${tag}${needsTrailingSpace ? ' ' : ''}${after}`
    onChange(next)
    setSuggest({ open: false, prefix: '', start: -1 })
    requestAnimationFrame(() => {
      const pos = (before + tag + (needsTrailingSpace ? ' ' : '')).length
      try { ta.focus(); ta.setSelectionRange(pos, pos) } catch {}
      lastSelRef.current = { start: pos, end: pos }
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
  const tokens = Array.from(new Set(promptStr.match(/@(?:"[^"]+"|[A-Za-z0-9_-]+)/g) || []))

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
      {/* Tag chip row used to render unconditionally — too much noise.
          Now only appears when the user is actively typing @. The
          suggest popover below covers them otherwise. */}
      {suggest.open && (brands.length > 0 || namedImages.length > 0) && filtered.length > 0 && (
        <div key="ss-mention-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
          <span style={{ fontSize: 9.5, color: 'var(--muted)', fontFamily: 'var(--font-display)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', alignSelf: 'center' }}>tag:</span>
          {filtered.map((it) => (
            <button
              key={it.key}
              type="button"
              className="nodrag"
              // mousedown.preventDefault keeps the textarea focused so its
              // selectionStart / selectionEnd remain valid when click fires.
              // Without this the chip click clobbers `after` and eats text.
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); captureSelection() }}
              onClick={(e) => { e.stopPropagation(); insertTag(it.name) }}
              title={`Insert ${tagFor(it.name)}`}
              style={chipStyle(it.kind)}
            >
              {tagFor(it.name)}
            </button>
          ))}
        </div>
      )}
      {/* Legacy code path retained below for the old name/image suggestion
          layout — neutralized by the always-false guard above. */}
      {false && (
        <div>
          {brands.map((b) => (
            <button key={`b-${b.id}`} type="button" className="nodrag" onClick={(e) => { e.stopPropagation(); insertTag(b.name) }} style={chipStyle('brand')}>
              {tagFor(b.name)}
            </button>
          ))}
          {namedImages.map((im) => (
            <button key={`i-${im.url}`} type="button" onClick={(e) => { e.stopPropagation(); insertTag(im.name) }} style={chipStyle('image')}>
              {tagFor(im.name)}
            </button>
          ))}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <PromptHighlightField
          key="ss-mention-input"
          textareaRef={ref}
          value={promptStr}
          placeholder={placeholder}
          minHeight={minHeight}
          onChange={onTextareaChange}
          onBlur={() => setTimeout(() => setSuggest((s) => ({ ...s, open: false })), 150)}
          onSelect={captureSelection}
          brands={brands}
          namedImages={namedImages}
        />
        {expandable && (
          <button
            type="button"
            className="nodrag"
            title="Expand prompt editor"
            aria-label="Expand prompt editor"
            onClick={(e) => { e.stopPropagation(); setExpanded(true) }}
            style={{
              position: 'absolute', top: 4, right: 6,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 22, borderRadius: 5,
              background: 'rgba(0,0,0,0.45)',
              border: '1px solid var(--border)',
              color: 'var(--text-soft)',
              cursor: 'pointer', padding: 0,
              transition: 'background .12s var(--ease), color .12s var(--ease), border-color .12s var(--ease)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(239,68,68,0.18)'
              e.currentTarget.style.borderColor = 'rgba(239,68,68,0.5)'
              e.currentTarget.style.color = 'var(--text)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(0,0,0,0.45)'
              e.currentTarget.style.borderColor = 'var(--border)'
              e.currentTarget.style.color = 'var(--text-soft)'
            }}
          >
            <Maximize2 size={11} />
          </button>
        )}
      </div>
      {expanded && (
        <ExpandedPromptModal
          value={promptStr}
          placeholder={placeholder}
          brands={brands}
          namedImages={namedImages}
          onChange={onChange}
          onClose={() => setExpanded(false)}
        />
      )}
      {suggest.open && filtered.length > 0 && (
        <div key="ss-mention-popover" className="nodrag" style={{
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
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); captureSelection() }}
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
function PromptHighlightField({ textareaRef, value, placeholder, minHeight, onChange, onBlur, onSelect, brands, namedImages }) {
  const backdropRef = useRef(null)
  // Defensive — same coercion the outer MentionPrompt does, in case this
  // component ever gets used standalone with a non-string value.
  const safeValue = typeof value === 'string' ? value : (value == null ? '' : String(value))

  // Sync the textarea's DOM value to the external prop while preserving
  // caret/selection. React's normal controlled-component path resets the
  // caret to the end whenever the committed `value` differs from what's
  // already in the DOM. By managing the sync ourselves and restoring the
  // selection range, we keep the cursor exactly where the user left it
  // even when the parent reconstructs `data` on every keystroke.
  useLayoutEffect(() => {
    const ta = textareaRef?.current
    if (!ta) return
    if (ta.value === safeValue) return
    const isFocused = document.activeElement === ta
    const start = isFocused ? ta.selectionStart : null
    const end   = isFocused ? ta.selectionEnd   : null
    ta.value = safeValue
    if (isFocused && start !== null && end !== null) {
      try { ta.setSelectionRange(start, end) } catch {}
    }
  }, [safeValue, textareaRef])
  const brandSet = new Set((brands || []).map((b) => (b.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '')))
  const imageSet = new Set((namedImages || []).map((im) => (im.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '')))

  // Walk the prompt, splitting at @-tokens. Recognized tokens get a colored
  // span; unknown tokens stay default-colored.
  const segments = []
  const re = /@(?:"[^"]+"|[A-Za-z0-9_-]+)/g
  let cursor = 0
  let m
  let key = 0
  while ((m = re.exec(safeValue)) !== null) {
    if (m.index > cursor) segments.push({ k: key++, kind: 'text', text: safeValue.slice(cursor, m.index) })
    const tok = m[0]
    const norm = tok.replace(/^@"?|"?$/g, '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
    const tokKind = brandSet.has(norm) ? 'brand' : (imageSet.has(norm) ? 'image' : 'unknown')
    segments.push({ k: key++, kind: tokKind, text: tok })
    cursor = m.index + tok.length
  }
  if (cursor < safeValue.length) segments.push({ k: key++, kind: 'text', text: safeValue.slice(cursor) })

  // Lock down EVERY typography knob so the backdrop and textarea produce
  // pixel-identical glyph layout. If any of these diverge between the two
  // layers, the caret/selection drifts away from the visible text.
  const sharedTextStyle = {
    minHeight,
    width: '100%',
    boxSizing: 'border-box',
    padding: '7px 9px',
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontFamily: 'var(--font-body, system-ui, -apple-system, sans-serif)',
    fontSize: 12,
    fontWeight: 400,
    fontStyle: 'normal',
    fontStretch: 'normal',
    fontVariantNumeric: 'normal',
    fontFeatureSettings: 'normal',
    fontKerning: 'auto',
    letterSpacing: 'normal',
    wordSpacing: 'normal',
    textIndent: 0,
    textTransform: 'none',
    lineHeight: 1.45,
    tabSize: 4,
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
    overflowWrap: 'break-word',
    // Reserve scrollbar gutter on both layers — without this the textarea
    // grows a scrollbar when content overflows, narrows its inner width,
    // and rewraps differently from the backdrop. Stable gutter pre-pads
    // both layers so wrap points stay identical.
    scrollbarGutter: 'stable',
    overflowY: 'auto',
    overflowX: 'hidden',
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
        {segments.length === 0 && !safeValue
          ? <span style={{ color: 'var(--muted)' }}>{placeholder}</span>
          : segments.map((s) => s.kind === 'text'
              ? <span key={s.k}>{s.text}</span>
              : <span
                  key={s.k}
                  style={{
                    // CRITICAL: backdrop must keep identical glyph widths to
                    // the underlying textarea so the caret never drifts.
                    // Color + background only — no padding, border, margin,
                    // or font-family change. Anything that affects layout
                    // breaks click-to-position and mid-word typing.
                    color: colorFor(s.kind),
                    background: bgFor(s.kind),
                    borderRadius: 4,
                    fontWeight: 'inherit',
                  }}
                >{s.text}</span>
          )}
      </div>
      <textarea
        ref={textareaRef}
        className="nodrag nowheel"
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
        // Uncontrolled: defaultValue seeds the initial DOM value, and
        // useLayoutEffect above keeps the textarea in sync with `safeValue`
        // while restoring the caret. This avoids React's controlled-input
        // caret-reset behavior entirely.
        defaultValue={safeValue}
        onChange={onChange}
        onBlur={onBlur}
        onSelect={onSelect}
        onKeyUp={onSelect}
        onClick={onSelect}
        onScroll={(e) => { if (backdropRef.current) backdropRef.current.scrollTop = e.target.scrollTop }}
      />
    </div>
  )
}

// Starter prompts — picked to be one-tap useful for the most common faceless
// brand workflows (UGC product shots, lifestyle, before/after, quote tile,
// etc.). The user can edit before running. @brand pulls the active brand
// profile's bible+colors+logo through the mention system.
const IMAGE_GEN_TEMPLATES = [
  { id: 'product-hero',     label: 'Product hero shot',         prompt: 'High-end product photography of @brand product on a clean studio backdrop. Soft directional lighting from the upper left, gentle shadow on the right. Centered composition, shallow depth of field, photorealistic, 35mm. No text overlays.' },
  { id: 'ugc-lifestyle',    label: 'UGC lifestyle / in-use',    prompt: 'Authentic UGC-style smartphone photo of someone using @brand product in a real home setting. Natural window light, slight motion blur, slightly desaturated. Looks unposed and trustworthy. No watermark, no text.' },
  { id: 'flat-lay',         label: 'Flat lay (overhead)',       prompt: 'Top-down flat lay of @brand product surrounded by complementary props in @brand colors. Even soft daylight, clean background, copy space in upper third for headline. Editorial, magazine-quality.' },
  { id: 'before-after',     label: 'Before / after split',      prompt: 'Side-by-side before/after image. Left side shows the problem (dull, cluttered, frustrated). Right side shows the @brand product solving it (bright, clean, satisfying). Subtle vertical divider down the center.' },
  { id: 'quote-tile',       label: 'Quote / text tile',         prompt: 'A bold typographic social tile in @brand colors. Centered short headline (3-7 words). Large display sans-serif, generous whitespace. Subtle texture or gradient background. Designed for 1:1 or 4:5 feed.' },
  { id: 'meme-relatable',   label: 'Relatable meme tile',       prompt: 'A relatable, slightly humorous social tile aimed at @brand audience. Simple two-panel layout with a punchy short caption (under 12 words) on top, illustrative photo on the bottom. Clean, modern, mobile-first.' },
  { id: 'list-carousel',    label: 'Carousel cover (list)',     prompt: 'Carousel cover for a "5 ways to ___" listicle from @brand. Big number "5" on the left, short headline on the right, secondary "swipe →" hint at bottom right. Brand colors, strong typographic hierarchy.' },
  { id: 'avatar-portrait',  label: 'Avatar / spokesperson',     prompt: 'Studio portrait of a friendly spokesperson for @brand. Eye-level, sharp focus on face, soft seamless background in @brand color. Looking directly at camera, slight smile. Shoulders up, color-graded warm.' },
  { id: 'minimal-banner',   label: 'Minimal banner / cover',    prompt: 'A minimalist cover banner for @brand. Single hero element centered, oceans of whitespace, mono-tonal palette in @brand colors. Cinematic 16:9 framing, subtle film grain.' },
  { id: 'announcement',     label: 'Announcement / launch',     prompt: 'Bold launch announcement social tile for @brand. Large headline "Now live" or "Coming soon" stacked on the left, product mock or hero photo on the right. Energetic gradient background using @brand colors. Crisp, modern, mobile-first.' },
]

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

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
        <select className="nodrag"
          value=""
          onChange={(e) => {
            const tpl = IMAGE_GEN_TEMPLATES.find((t) => t.id === e.target.value)
            if (!tpl) return
            const cur = (data.props?.prompt || '').trim()
            const next = cur ? `${cur}\n\n${tpl.prompt}` : tpl.prompt
            onPatch({ prompt: next })
            e.target.value = ''
          }}
          style={{ ...pillSelect, fontSize: 10.5 }}
          title="Insert a starter prompt"
        >
          <option value="">Starter prompts ▾</option>
          {IMAGE_GEN_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
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
        <select className="nodrag" style={pillSelect} value={data.props?.model || 'nano-banana-2'} onChange={(e) => onPatch({ model: e.target.value })}>
          <option value="nano-banana-2">Nano Banana 2</option>
          <option value="nano-banana-pro">Nano Banana Pro</option>
          <option value="gpt-2">GPT 2.0</option>
        </select>
        <select className="nodrag" style={pillSelect} value={data.props?.aspect || '1:1'} onChange={(e) => onPatch({ aspect: e.target.value })}>
          <option value="1:1">1:1</option>
          <option value="16:9">16:9</option>
          <option value="9:16">9:16</option>
          <option value="4:3">4:3</option>
          <option value="3:4">3:4</option>
        </select>
        <select className="nodrag" style={pillSelect} value={data.props?.count || 1} onChange={(e) => onPatch({ count: Number(e.target.value) })}>
          {[1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>×{n}</option>)}
        </select>
        <select className="nodrag" style={pillSelect} value={data.props?.quality || '2K'} onChange={(e) => onPatch({ quality: e.target.value })}>
          <option value="1K">1K</option>
          <option value="2K">2K</option>
          <option value="4K">4K</option>
        </select>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onPatch({ enhance_prompt: !(data.props?.enhance_prompt ?? true) }) }}
          title={(data.props?.enhance_prompt ?? true)
            ? 'AI rewrites your prompt with composition, lighting, and brand cues before sending to the image model. Click to disable.'
            : 'Send your prompt verbatim. Click to let AI enhance it.'}
          style={{
            ...pillSelect,
            cursor: 'pointer',
            background: (data.props?.enhance_prompt ?? true) ? 'rgba(168,85,247,0.18)' : 'var(--surface-2)',
            color: (data.props?.enhance_prompt ?? true) ? '#a855f7' : 'var(--text-soft)',
            borderColor: (data.props?.enhance_prompt ?? true) ? 'rgba(168,85,247,0.4)' : 'var(--border)',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}
        >
          <Sparkles size={10} /> {(data.props?.enhance_prompt ?? true) ? 'Enhance: on' : 'Enhance: off'}
        </button>
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
    if (typeof x === 'string') {
      // Detect kind from file extension when given a bare string —
      // legacy / pasted-URL path. Without this every string-shaped
      // url gets tagged as 'image' even when it's an .mp4.
      const kind = /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(x) ? 'video' : 'image'
      return { kind, url: x, name: `${kind} ${i + 1}` }
    }
    if (x && typeof x === 'object' && x.url) {
      // Preserve kind from the stored object (ImageUploadBody.onPick
      // sets it to 'video' explicitly when a video file is uploaded).
      // Without this every uploaded video was being tagged 'image'
      // downstream, which broke wiring Upload media into Finish video.
      const kind = x.kind || (/\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(x.url) ? 'video' : 'image')
      return { kind, url: x.url, name: x.name || `${kind} ${i + 1}` }
    }
    return null
  }).filter(Boolean)
}

function ImageUploadBody({ data, onPatch }) {
  const inpRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [editingIdx, setEditingIdx] = useState(-1)
  const [draftName, setDraftName] = useState('')
  // Library picker modal state — shown when the user clicks "From library".
  const [libraryOpen, setLibraryOpen] = useState(false)
  // Per-file upload progress. Map of localId → { name, kind, size, pct,
  // status, error }. Lives only during the active upload — cleared once
  // all files settle so the panel disappears.
  const [uploads, setUploads] = useState([])
  // The node's data shape used to be just images. Now it carries
  // mixed media — each item has `url`, `name` (alt tag), and `kind`
  // ('image' | 'video'). Old saved spaces have no kind field; treat
  // them as images for backwards compat.
  const items = readImageItems(data.props).map((it) => ({ kind: it.kind || 'image', ...it }))
  const profileId = data?._ctxProfileId

  async function onPick(e) {
    const files = Array.from(e.target.files || [])
    if (!files.length || !profileId) return
    setBusy(true); setErr(null)

    // Initial upload state — one entry per file with status='queued'.
    // We use a stable local id so updates target the right row even
    // when files share a name.
    const initial = files.map((f, i) => {
      const isVideo = (f.type || '').startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(f.name || '')
      return {
        localId: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        name: f.name,
        size: f.size,
        kind: isVideo ? 'video' : 'image',
        pct: 0,
        status: 'queued', // queued | uploading | done | failed
        error: null,
      }
    })
    setUploads(initial)
    const updateOne = (localId, patch) => setUploads((prev) =>
      prev.map((u) => u.localId === localId ? { ...u, ...patch } : u)
    )

    // Per-file uploader. Returns the new item record on success, throws on
    // failure (caller catches into the row's `error` field).
    const uploadOne = async (f, row, namedCount) => {
      const isVideo = row.kind === 'video'
      updateOne(row.localId, { status: 'uploading' })
      if (isVideo) {
        // HEVC reject — see detectHevc() above for why. Errors here
        // surface in the per-file progress panel with the full
        // message, so the user knows exactly how to fix it.
        if (await detectHevc(f)) {
          throw new Error(
            'HEVC (H.265) not supported. iPhone: Settings → Camera → Formats → "Most Compatible" to record in H.264. ' +
            'Existing clips: re-export from Photos / iMovie / Final Cut with H.264 codec.'
          )
        }
        // Vertical-only enforcement before we burn bandwidth uploading.
        const meta = await probeVideoMeta(f).catch(() => null)
        if (meta && meta.width && meta.height) {
          const aspect = meta.width / meta.height
          if (aspect > 0.65) {
            throw new Error(`Vertical (9:16) required — got ${meta.width}×${meta.height}`)
          }
        }
        const url = await uploadVideoWithProgress(f, profileId, (p) => {
          updateOne(row.localId, { pct: p.pct })
        })
        updateOne(row.localId, { status: 'done', pct: 100 })
        return { kind: 'video', url, name: `video ${namedCount.video}` }
      } else {
        // Images go through the JSON+base64 reference-image API. We
        // don't get byte-level progress from that path, but image
        // uploads are small (downscaled to JPEG) so a binary
        // "uploading → done" is honest enough.
        const u = await uploadImageToBucket(f, profileId)
        updateOne(row.localId, { status: 'done', pct: 100 })
        return { kind: 'image', url: u, name: `image ${namedCount.image}` }
      }
    }

    // Per-kind naming counter so "video 1, video 2" doesn't repeat when
    // we add to an existing items list. Lock this in BEFORE the parallel
    // run so concurrent uploads don't all claim the same index.
    const counters = {
      video: items.filter((x) => x.kind === 'video').length,
      image: items.filter((x) => x.kind !== 'video').length,
    }
    const assigned = files.map((f, i) => {
      const row = initial[i]
      counters[row.kind] += 1
      return { f, row, idx: { video: counters.video, image: counters.image } }
    })

    // Concurrency 3. Higher saturates the user's upstream and starves
    // foreground UI; lower wastes their bandwidth. 3 keeps the network
    // pipe busy with one big video, while images interleave fast.
    const CONCURRENCY = 3
    const results = new Array(assigned.length)
    let cursor = 0
    const workers = Array.from({ length: Math.min(CONCURRENCY, assigned.length) }, async () => {
      while (cursor < assigned.length) {
        const i = cursor++
        const { f, row, idx } = assigned[i]
        try {
          results[i] = await uploadOne(f, row, idx)
        } catch (e) {
          updateOne(row.localId, { status: 'failed', error: e?.message || String(e) })
          results[i] = null
        }
      }
    })
    await Promise.all(workers)

    // Stitch successful uploads into the items list. Failures stay
    // visible in the upload panel so the user can see what didn't make
    // it and re-pick those files.
    const additions = results.filter(Boolean)
    if (additions.length) onPatch({ urls: [...items, ...additions] })
    const anyFailed = results.some((r) => r === null)
    if (anyFailed) setErr(`${results.filter((r) => r === null).length} file(s) failed — see panel below.`)

    setBusy(false)
    if (inpRef.current) inpRef.current.value = ''
    // Auto-clear the progress panel a beat after success so the node
    // shape doesn't stay tall. Failures linger so the user notices.
    if (!anyFailed) {
      setTimeout(() => setUploads([]), 800)
    }
  }
  function remove(idx) {
    onPatch({ urls: items.filter((_, j) => j !== idx) })
  }
  function commitName(idx) {
    const trimmed = (draftName || '').trim() || `media ${idx + 1}`
    onPatch({ urls: items.map((it, j) => j === idx ? { ...it, name: trimmed } : it) })
    setEditingIdx(-1); setDraftName('')
  }

  return (
    <>
      {items.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 8 }}>
          {items.map((it, idx) => (
            <div key={`${it.url}-${idx}`} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ position: 'relative', aspectRatio: '1', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)', background: '#000' }}>
                {it.kind === 'video' ? (
                  <video src={it.url} muted playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <img src={it.url} alt={it.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                )}
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
                <input className="nodrag"
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
      {/* Per-file upload progress panel. Visible during an active
          upload + briefly after for the success flash; lingers on
          failures so the user can see what didn't make it. */}
      {uploads.length > 0 && (
        <div className="nodrag" style={{
          marginBottom: 8, padding: 8, borderRadius: 6,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', gap: 5,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            fontSize: 10.5, fontFamily: 'var(--font-display)', fontWeight: 700,
            letterSpacing: '0.04em', color: 'var(--muted)', textTransform: 'uppercase',
          }}>
            <span>Uploading {uploads.filter((u) => u.status === 'done').length} / {uploads.length}</span>
            <span style={{ color: '#0ea5e9' }}>
              {Math.round(uploads.reduce((s, u) => s + u.pct, 0) / uploads.length)}%
            </span>
          </div>
          {uploads.map((u) => (
            <div key={u.localId} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5 }}>
                <span style={{
                  flexShrink: 0, width: 14, height: 14, borderRadius: 999,
                  display: 'grid', placeItems: 'center', fontSize: 9, fontWeight: 700,
                  background: u.status === 'done' ? 'rgba(46,204,113,0.2)'
                            : u.status === 'failed' ? 'rgba(239,68,68,0.2)'
                            : 'rgba(14,165,233,0.2)',
                  color: u.status === 'done' ? '#2ecc71'
                       : u.status === 'failed' ? '#ef4444'
                       : '#0ea5e9',
                }}>
                  {u.status === 'done' ? '✓' : u.status === 'failed' ? '!' : (u.kind === 'video' ? 'V' : 'I')}
                </span>
                <span style={{
                  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  color: u.status === 'failed' ? 'var(--red)' : 'var(--text-soft)',
                }} title={u.name}>{u.name}</span>
                <span style={{ flexShrink: 0, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', fontSize: 10 }}>
                  {u.status === 'failed' ? 'failed'
                    : u.status === 'done' ? 'done'
                    : u.status === 'queued' ? '…'
                    : `${Math.round(u.pct)}%`}
                </span>
              </div>
              {u.status !== 'failed' && (
                <div style={{ height: 3, borderRadius: 999, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${u.status === 'done' ? 100 : u.pct}%`,
                    background: u.status === 'done' ? '#2ecc71' : '#0ea5e9',
                    transition: 'width 0.18s ease',
                  }} />
                </div>
              )}
              {u.status === 'failed' && u.error && (
                <div style={{ fontSize: 9.5, color: 'var(--red)', marginLeft: 20 }}>{u.error}</div>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          onClick={() => inpRef.current?.click()}
          disabled={busy}
          style={{
            ...tinyInput, cursor: 'pointer', display: 'flex', flex: 1,
            alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px',
            background: 'var(--surface-2)', borderStyle: 'dashed',
          }}>
          {busy ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}
          {busy ? 'Uploading…' : items.length ? 'Add more' : 'Upload media'}
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setLibraryOpen(true) }}
          disabled={busy}
          title="Add an item from this brand's library"
          style={{
            ...tinyInput, cursor: 'pointer', display: 'flex',
            alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px 14px',
            background: 'var(--surface-2)',
          }}>
          <LibraryIcon size={13} /> From library
        </button>
      </div>
      <div style={{ marginTop: 4, fontSize: 10, color: 'var(--muted)', lineHeight: 1.4 }}>
        Each item gets an alt tag. Reference one in any generator prompt with @altTag (e.g. "she's holding @logo").
      </div>
      <input ref={inpRef} type="file" multiple accept="image/*,video/mp4,video/quicktime,video/webm" onChange={onPick} style={{ display: 'none' }} />
      {err && <div style={{ marginTop: 6, color: 'var(--red)', fontSize: 11 }}>{err}</div>}
      {libraryOpen && (
        <LibraryPickerModal
          profileId={profileId}
          token={data?._ctxToken || null}
          onClose={() => setLibraryOpen(false)}
          onPick={(picks) => {
            if (!picks?.length) { setLibraryOpen(false); return }
            // Each pick is { kind, url, name }. Names get a "lib"
            // prefix so they don't collide with directly-uploaded items
            // and the user can tell at a glance which came from where.
            const counters = {
              video: items.filter((x) => x.kind === 'video').length,
              image: items.filter((x) => x.kind !== 'video').length,
            }
            const additions = picks.map((p) => {
              counters[p.kind === 'video' ? 'video' : 'image'] += 1
              const base = p.kind === 'video' ? 'video' : 'image'
              return {
                kind: p.kind === 'video' ? 'video' : 'image',
                url: p.url,
                name: p.name || `lib ${base} ${counters[p.kind === 'video' ? 'video' : 'image']}`,
              }
            })
            onPatch({ urls: [...items, ...additions] })
            setLibraryOpen(false)
          }}
        />
      )}
    </>
  )
}

// Library picker for the Upload media node. Lists every content_scripts
// row with media_urls for the active brand profile, lets the user
// multi-select, and returns the picks as { kind, url, name }.
function LibraryPickerModal({ profileId, token, onClose, onPick }) {
  const [items, setItems] = useState(null)  // null = loading
  const [error, setError] = useState(null)
  const [picked, setPicked] = useState(() => new Set())
  const [kindFilter, setKindFilter] = useState('all')  // all | image | video
  const [q, setQ] = useState('')
  useEffect(() => {
    if (!profileId || !token) { setItems([]); return }
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(`/api/content?profile_id=${profileId}&filter=library`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const body = await r.json()
        if (!r.ok) throw new Error(body?.error || `Failed (${r.status})`)
        if (!cancelled) {
          // Flatten to one row per media url. content_scripts rows can
          // hold multiple urls (image carousels); each becomes its own
          // pickable tile.
          const flat = []
          for (const it of (body.items || [])) {
            const urls = Array.isArray(it.media_urls) ? it.media_urls : []
            const kind = (it.media_type || 'image') === 'video' ? 'video' : 'image'
            urls.forEach((u, i) => {
              if (!u) return
              flat.push({
                id: `${it.id}:${i}`,
                url: u,
                kind,
                title: it.title || '(untitled)',
                created_at: it.created_at,
              })
            })
          }
          setItems(flat)
        }
      } catch (e) {
        if (!cancelled) { setError(e.message); setItems([]) }
      }
    })()
    return () => { cancelled = true }
  }, [profileId, token])
  const filtered = useMemo(() => {
    if (!items) return null
    let out = items
    if (kindFilter !== 'all') out = out.filter((it) => it.kind === kindFilter)
    const term = q.trim().toLowerCase()
    if (term) out = out.filter((it) => (it.title || '').toLowerCase().includes(term))
    return out
  }, [items, kindFilter, q])
  const toggle = (id) => setPicked((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const confirm = () => {
    if (!items) return
    const byId = new Map(items.map((it) => [it.id, it]))
    const picks = Array.from(picked).map((id) => byId.get(id)).filter(Boolean).map((it) => ({
      kind: it.kind, url: it.url, name: it.title.slice(0, 40),
    }))
    onPick(picks)
  }
  return (
    <div
      className="nodrag"
      role="dialog" aria-modal="true"
      onClick={onClose}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
        display: 'grid', placeItems: 'center', padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 760, maxHeight: '84vh',
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 14, boxShadow: 'var(--shadow-pop)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <LibraryIcon size={16} style={{ color: 'var(--red)' }} />
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700, flex: 1 }}>From library</h3>
          <button aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6, borderRadius: 6 }}>×</button>
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--border)', alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}
            style={{ ...tinyInput, padding: '6px 10px', cursor: 'pointer' }}>
            <option value="all">All assets</option>
            <option value="image">Images only</option>
            <option value="video">Videos only</option>
          </select>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by title…"
            style={{ ...tinyInput, padding: '6px 10px', flex: 1, minWidth: 140 }}
          />
        </div>
        <div style={{ padding: 14, overflowY: 'auto', flex: 1 }}>
          {filtered == null && <div style={{ textAlign: 'center', padding: 30 }}><Loader2 size={16} className="spin" /></div>}
          {error && <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 10 }}>{error}</div>}
          {filtered && filtered.length === 0 && (
            <div style={{ color: 'var(--muted)', fontSize: 12.5, textAlign: 'center', padding: 30 }}>
              No matching library assets for this brand profile.
            </div>
          )}
          {filtered && filtered.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }}>
              {filtered.map((it) => {
                const isPicked = picked.has(it.id)
                return (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => toggle(it.id)}
                    style={{
                      position: 'relative', padding: 0,
                      background: 'var(--surface-2)',
                      border: `2px solid ${isPicked ? '#2ecc71' : 'var(--border)'}`,
                      borderRadius: 8, cursor: 'pointer', overflow: 'hidden',
                      display: 'flex', flexDirection: 'column',
                      transition: 'border-color 0.15s',
                    }}
                  >
                    <div style={{ position: 'relative', aspectRatio: '9 / 16', background: '#000' }}>
                      {it.kind === 'video' ? (
                        <video src={it.url} muted playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <img src={it.url} alt={it.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      )}
                      {isPicked && (
                        <div style={{
                          position: 'absolute', top: 4, right: 4,
                          background: '#2ecc71', color: '#000',
                          fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10,
                          padding: '2px 6px', borderRadius: 999,
                        }}>✓</div>
                      )}
                    </div>
                    <div style={{
                      padding: '6px 8px', fontSize: 10.5, color: 'var(--text-soft)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      textAlign: 'left',
                    }}>{it.title}</div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            {picked.size > 0 ? `${picked.size} selected` : 'Click tiles to pick'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary" onClick={onClose} style={{ padding: '6px 12px', fontSize: 12 }}>Cancel</button>
            <button className="btn-primary" onClick={confirm} disabled={picked.size === 0} style={{ padding: '6px 12px', fontSize: 12 }}>
              Add {picked.size > 0 ? `${picked.size} ` : ''}to node
            </button>
          </div>
        </div>
      </div>
    </div>
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

// "N runs per unit" is the new primary cadence input. Replaces the
// fixed-cadence dropdown for new users — "2 per day" makes more sense
// to creators than "every 12 hours". The legacy `cadence` prop is
// still honored on existing nodes (autoRunIntervalMs prefers the new
// runs_per_unit shape but falls back).
export const AUTORUN_UNITS = [
  { id: 'hour', label: 'per hour', ms: 3_600_000 },
  { id: 'day',  label: 'per day',  ms: 86_400_000 },
  { id: 'week', label: 'per week', ms: 604_800_000 },
]

// Compute the tick interval in milliseconds from a node's props. Handles
// both the new (runs_per_unit + unit) and legacy (cadence) shapes.
// Clamped to [60s, 7 days] so a user can't run themselves out of credits
// in a tight loop or accidentally schedule a 6-month interval.
export function autoRunIntervalMs(props) {
  const MIN = 60_000
  const MAX = 7 * 86_400_000
  const runsPerUnit = Number(props?.runs_per_unit)
  const unitId = props?.unit
  if (Number.isFinite(runsPerUnit) && runsPerUnit >= 1 && unitId) {
    const unit = AUTORUN_UNITS.find((u) => u.id === unitId)
    if (unit) {
      return Math.max(MIN, Math.min(MAX, Math.round(unit.ms / runsPerUnit)))
    }
  }
  const opt = AUTORUN_OPTIONS.find((o) => o.id === props?.cadence) || AUTORUN_OPTIONS[2]
  return Math.max(MIN, Math.min(MAX, opt.ms))
}

// Human-readable interval for the toggle label and helper text.
// "2 per day" → "every 12 hr". "5 per hour" → "every 12 min".
function intervalLabel(ms) {
  if (ms >= 86_400_000) {
    const d = ms / 86_400_000
    return `${d % 1 === 0 ? d : d.toFixed(1)} day${d === 1 ? '' : 's'}`
  }
  if (ms >= 3_600_000) {
    const h = ms / 3_600_000
    return `${h % 1 === 0 ? h : h.toFixed(1)} hr`
  }
  const m = Math.max(1, Math.round(ms / 60_000))
  return `${m} min`
}

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
  text_post_gen: 2000,
  image_gen:     4000,    // per image
  avatar_picker: 0,
  avatar_render: 8000,    // ~30s clip equivalent
  // Voice gen: ~1 token/char on Turbo, scaled by model. ~1500 chars ×
  // 1×–5× depending on model. The number here is a rough hint for the
  // pre-flight cost estimate; the real charge happens server-side via
  // chargeTtsCredits.
  voice_gen:     2000,
  url_reference: 0,        // transcription is metered per-month, not credits
  collection:    0,
  combine_videos: 1500,
  combine_av:     400,
  video_polish:  1500,
  captions:      2000,    // ZapCap caption render
  schedule_post: 100,
  save_library:  0,
}

function AutoRunBody({ data, onPatch }) {
  const props = data.props || {}
  // New primary inputs. Default to 2 runs per day on fresh nodes —
  // that matches the "set and forget for a week" use case (~14 posts
  // over 7 days). Existing nodes that only have `cadence` in their
  // props keep working: autoRunIntervalMs falls back to the legacy
  // lookup, and we surface the legacy dropdown below for one-click
  // migration.
  const runsPerUnit = Number(props.runs_per_unit ?? 2)
  const unitId = props.unit || 'day'
  const cadence = props.cadence || '15m'
  const usingFrequency = props.runs_per_unit != null && props.unit != null

  const maxRuns = Number(props.max_runs ?? 10)
  const runsUsed = Number(props.runs_used ?? 0)
  const active = !!props.active

  // Server-side schedule status — fetched live from /api/spaces/save-schedule
  // for this node when it's active. Drives the "Server: next at X,
  // runs_used Y" readout + the Cancel button. Refreshes every 30s
  // while the node is on screen so the user sees runs_used tick up
  // and next_fire_at advance in near-real-time.
  const [serverSchedule, setServerSchedule] = useState(null)
  const spaceId = data._ctxSpaceId
  useEffect(() => {
    if (!active || !spaceId || spaceId === '__transient__') {
      setServerSchedule(null)
      return
    }
    let cancelled = false
    const fetchSchedule = async () => {
      try {
        const session = (await supabase.auth.getSession()).data.session
        const r = await fetch(`/api/spaces/save-schedule?space_id=${encodeURIComponent(spaceId)}`, {
          headers: { Authorization: `Bearer ${session?.access_token || ''}` },
        })
        const body = await r.json().catch(() => ({}))
        if (cancelled) return
        const mine = (body.schedules || []).find((s) => s.trigger_node_id === data.__id)
        setServerSchedule(mine || null)
      } catch {}
    }
    fetchSchedule()
    const t = setInterval(fetchSchedule, 30_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [active, spaceId, data.__id])

  // Auto-commit the default frequency on legacy nodes (saved before
  // the Frequency input existed). Without this, the body displays
  // "2 per day" + a hidden "use this" link, but the SCHEDULER
  // silently still uses the legacy cadence ("Every 15 minutes" by
  // default) because runs_per_unit / unit are null. Users were
  // surprised their "2 per day" setting ran every 15 min. By
  // promoting the defaults on first render we make the displayed
  // frequency match the actual behavior.
  //
  // Note: this useEffect MUST come after the `active` const above —
  // it reads `active` in the dep array, and JS const TDZ rules trip
  // if we declare it earlier (a real "Cannot access 'a' before
  // initialization" crash, hard to spot in minified bundles).
  useEffect(() => {
    if (usingFrequency) return
    if (active) return  // never silently rewrite props on an active trigger
    onPatch?.({ runs_per_unit: runsPerUnit, unit: unitId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usingFrequency, active])
  const lastRun = props.last_run_at
  const remaining = Math.max(0, maxRuns - runsUsed)
  // Draft strings so each input can transiently clear while typing
  // (e.g. backspace from "10" → "" → "5") without snapping back.
  const [maxRunsDraft, setMaxRunsDraft] = useState(String(maxRuns))
  useEffect(() => { setMaxRunsDraft(String(maxRuns)) }, [maxRuns])
  const [runsDraft, setRunsDraft] = useState(String(runsPerUnit))
  useEffect(() => { setRunsDraft(String(runsPerUnit)) }, [runsPerUnit])

  const intervalMs = autoRunIntervalMs(props)
  const intervalText = intervalLabel(intervalMs)
  const unitMeta = AUTORUN_UNITS.find((u) => u.id === unitId) || AUTORUN_UNITS[1]
  const estPerRun = Number(data?._ctxCostPerRun ?? 0)

  const toggle = async () => {
    if (!active) {
      // Starting fresh — reset run counter so user can re-run after hitting cap.
      onPatch({ active: true, runs_used: 0, last_run_at: null })
      // Persist to the server scheduler so the workflow fires even
      // with the canvas tab closed. The browser-side timer still
      // also runs (defense in depth — if the cron is delayed for
      // some reason the local tick covers it; on overlapping fires
      // the worker job-id dedup catches it).
      if (typeof window !== 'undefined' && window.__spaceStartServerSchedule) {
        await window.__spaceStartServerSchedule(data.__id, {
          interval_ms: intervalMs,
          max_runs: maxRuns,
        })
      }
    } else {
      onPatch({ active: false })
      if (typeof window !== 'undefined' && window.__spaceStopServerSchedule) {
        await window.__spaceStopServerSchedule(data.__id)
      }
    }
  }
  const reset = () => {
    onPatch({ runs_used: 0, last_run_at: null, active: false })
    if (typeof window !== 'undefined' && window.__spaceStopServerSchedule) {
      window.__spaceStopServerSchedule(data.__id)
    }
  }

  return (
    <>
      <NodeField label="Frequency">
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="number"
            className="nodrag"
            min={1}
            max={99}
            step={1}
            style={{ ...tinyInput, flex: '0 0 60px' }}
            value={runsDraft}
            onChange={(e) => {
              const v = e.target.value
              setRunsDraft(v)
              if (v === '') return
              const n = parseInt(v, 10)
              if (Number.isFinite(n)) {
                onPatch({ runs_per_unit: Math.max(1, Math.min(99, n)), unit: unitId })
              }
            }}
            onBlur={() => {
              const n = parseInt(runsDraft, 10)
              if (!Number.isFinite(n) || n < 1) {
                const fallback = Number.isFinite(runsPerUnit) && runsPerUnit >= 1 ? runsPerUnit : 2
                setRunsDraft(String(fallback))
                if (fallback !== runsPerUnit) onPatch({ runs_per_unit: fallback, unit: unitId })
              }
            }}
            disabled={active}
            title="How many times to run within the period below"
          />
          <select
            className="nodrag"
            style={{ ...tinyInput, flex: 1 }}
            value={unitId}
            onChange={(e) => onPatch({ runs_per_unit: runsPerUnit, unit: e.target.value })}
            disabled={active}
          >
            {AUTORUN_UNITS.map((u) => (
              <option key={u.id} value={u.id}>{u.label}</option>
            ))}
          </select>
        </div>
        <div style={{ marginTop: 4, fontSize: 10, color: 'var(--muted)' }}>
          Fires roughly every {intervalText}. {runsPerUnit} × {unitMeta.label.replace('per ', '')}
          {!usingFrequency && (
            <>
              {' · '}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onPatch({ runs_per_unit: runsPerUnit, unit: unitId }) }}
                style={{ background: 'transparent', border: 'none', color: 'var(--red)', cursor: 'pointer', padding: 0, fontSize: 10, textDecoration: 'underline' }}
                title="Use this frequency instead of the legacy cadence dropdown"
              >use this</button>
            </>
          )}
        </div>
      </NodeField>
      {!usingFrequency && (
        <NodeField label="Legacy cadence (fallback)">
          <select
            className="nodrag"
            style={tinyInput}
            value={cadence}
            onChange={(e) => onPatch({ cadence: e.target.value })}
            disabled={active}
            title="Pre-frequency cadence. Saved spaces still use this until you switch to the Frequency input above."
          >
            {AUTORUN_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </NodeField>
      )}
      <NodeField label="Stop after N runs">
        <input
          type="number"
          className="nodrag"
          min={1}
          max={1000}
          step={1}
          style={tinyInput}
          value={maxRunsDraft}
          onChange={(e) => {
            const v = e.target.value
            setMaxRunsDraft(v)
            // Empty / mid-edit: don't commit anything yet so the field
            // stays clearable. We snap to a valid number on blur.
            if (v === '') return
            const n = parseInt(v, 10)
            if (Number.isFinite(n)) {
              onPatch({ max_runs: Math.max(1, Math.min(1000, n)) })
            }
          }}
          onBlur={() => {
            const n = parseInt(maxRunsDraft, 10)
            if (!Number.isFinite(n) || n < 1) {
              // Empty or invalid on commit → snap to current value or 1.
              const fallback = Number.isFinite(maxRuns) && maxRuns >= 1 ? maxRuns : 1
              setMaxRunsDraft(String(fallback))
              if (fallback !== maxRuns) onPatch({ max_runs: fallback })
            }
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
        {active ? <><Pause size={12} /> Active — every {intervalText}</> : <><Play size={12} /> Start auto-run</>}
      </button>

      <div style={{ marginTop: 8, fontSize: 10.5, lineHeight: 1.5, color: 'var(--muted)' }}>
        <div>Runs used: <strong style={{ color: 'var(--text)' }}>{runsUsed} / {maxRuns}</strong> ({remaining} left)</div>
        {estPerRun > 0 && (
          <div>Est. cost / run: <strong style={{ color: 'var(--text)' }}>~{estPerRun.toLocaleString()}</strong> AI tokens. Total budget for this batch: ~{(estPerRun * remaining).toLocaleString()}.</div>
        )}
        {lastRun && <div>Last run: {new Date(lastRun).toLocaleTimeString()}</div>}
        {intervalMs <= 300_000 && active && (
          <div style={{ color: 'var(--amber)', marginTop: 4 }}>Tight cadence — this burns credits fast. Stop when you're done verifying.</div>
        )}
        {!active && runsUsed > 0 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); reset() }}
            style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 10.5, padding: 0, marginTop: 4, textDecoration: 'underline' }}
          >Reset counter</button>
        )}
      </div>
      {/* Server schedule status — live state from
          scheduled_workflows. Only shown when a row exists for this
          node (set by the activation flow). Includes a Cancel button
          that DELETEs the row so the cron stops firing without the
          user needing to come back to the canvas. */}
      {serverSchedule && (
        <div className="nodrag" style={{
          marginTop: 8, padding: 8, fontSize: 10.5,
          background: 'rgba(46,204,113,0.10)',
          border: '1px solid rgba(46,204,113,0.30)',
          borderRadius: 6, color: 'var(--text-soft)',
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9.5,
              color: '#2ecc71', letterSpacing: '0.06em', textTransform: 'uppercase',
            }}>Server schedule</span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={async (e) => {
                e.stopPropagation()
                if (typeof window === 'undefined' || !window.__spaceStopServerSchedule) return
                await window.__spaceStopServerSchedule(data.__id)
                onPatch?.({ active: false })
                setServerSchedule(null)
              }}
              style={{
                background: 'transparent', border: 'none',
                color: 'var(--red)', cursor: 'pointer',
                fontSize: 10, padding: 0, textDecoration: 'underline',
              }}
              title="Cancel the server schedule and stop firing this workflow"
            >Cancel schedule</button>
          </div>
          {serverSchedule.next_fire_at && (
            <div>Next fire: <strong style={{ color: 'var(--text)' }}>
              {new Date(serverSchedule.next_fire_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </strong></div>
          )}
          <div>Server runs: <strong style={{ color: 'var(--text)' }}>{serverSchedule.runs_used} / {serverSchedule.max_runs}</strong></div>
          {serverSchedule.last_run_at && (
            <div>Last server run: {new Date(serverSchedule.last_run_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
          )}
          {serverSchedule.last_error && (
            <div style={{ color: 'var(--red)', marginTop: 2 }}>
              Last error: {serverSchedule.last_error.slice(0, 120)}
            </div>
          )}
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 10, color: 'var(--muted)', lineHeight: 1.4 }}>
        Server-scheduled — fires from our cron even when this tab is closed. The local timer also runs as a backup while the canvas is open.
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

// Hard cap on audio length. Avatar render with audio uses the
// transcribe + chunk + slice flow; longer audio means longer rendering
// time and more HeyGen credits, and ElevenLabs STT scales linearly too.
// 60s is roughly a TikTok / IG Reel ceiling and keeps Vercel function
// time + cost predictable.
const AUDIO_MAX_SECONDS = 60

// Read duration from a File via an off-DOM <audio> element. Resolves
// in 1-2s for typical 60s clips. Used to reject long audio at upload
// time instead of letting it through and failing later in the render.
function readAudioDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const a = document.createElement('audio')
    a.preload = 'metadata'
    const cleanup = () => { try { URL.revokeObjectURL(url) } catch {} }
    a.onloadedmetadata = () => { cleanup(); resolve(a.duration || 0) }
    a.onerror = () => { cleanup(); reject(new Error('Could not read audio metadata')) }
    a.src = url
  })
}

function AudioUploadBody({ data, onPatch }) {
  const inpRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const profileId = data?._ctxProfileId
  const url = data.props?.url
  const name = data.props?.name || ''
  const duration = Number(data.props?.duration_secs || 0)

  async function onPick(e) {
    const file = e.target.files?.[0]
    if (!file || !profileId) return
    setBusy(true); setErr(null)
    try {
      // Reject long audio up front so the user doesn't pay for an
      // upload that the avatar render will refuse anyway.
      const seconds = await readAudioDuration(file).catch(() => 0)
      if (seconds && seconds > AUDIO_MAX_SECONDS) {
        throw new Error(`Audio is ${Math.round(seconds)}s — please trim to ${AUDIO_MAX_SECONDS}s or less.`)
      }
      const u = await uploadAudioToBucket(file, profileId)
      onPatch({ url: u, name: file.name, duration_secs: Math.round(seconds || 0) })
    } catch (e) { setErr(e.message) }
    finally { setBusy(false); if (inpRef.current) inpRef.current.value = '' }
  }
  function clear() { onPatch({ url: '', name: '', duration_secs: null }) }

  return (
    <>
      {url ? (
        <>
          <audio src={url} controls style={{ width: '100%', marginBottom: 8 }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--muted)', marginBottom: 6, gap: 8 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{name}</span>
            {duration > 0 && (
              <span style={{
                fontSize: 10, fontVariantNumeric: 'tabular-nums', flexShrink: 0,
                padding: '2px 6px', borderRadius: 999,
                background: duration > AUDIO_MAX_SECONDS - 5 ? 'rgba(245,158,11,0.18)' : 'var(--surface-2)',
                color: duration > AUDIO_MAX_SECONDS - 5 ? 'var(--amber)' : 'var(--text-soft)',
                border: '1px solid var(--border)', fontFamily: 'var(--font-display)', fontWeight: 700,
              }}>{duration}s</span>
            )}
          </div>
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
          {busy ? 'Uploading…' : `Upload voice audio (≤${AUDIO_MAX_SECONDS}s)`}
        </button>
      )}
      <div style={{ marginTop: 6, fontSize: 10, color: 'var(--muted)', lineHeight: 1.4 }}>
        Wire into Avatar render to drive lip-sync from your own voice instead of script + TTS. The render transcribes, splits at sentence boundaries, and renders one clip per look.
      </div>
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
        <select className="nodrag"
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
        <input className="nodrag"
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
              <input className="nodrag"
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
        ? 'This avatar is still training. Renders will fail until it finishes.'
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
      {/* Output preview is intentionally suppressed — every meaningful field
          (avatar, look, image, mode, cycle progress) is already visible in
          the form above. Showing the raw output JSON dumped UUIDs and
          internal mode strings the user shouldn't see. */}
      {data.status === 'failed' && <NodePreview status="failed" error={data.error} />}
      {data.status === 'running' && <NodePreview status="running" />}
    </>
  )
}

// ─── 7. AVATAR RENDER ───────────────────────────────────────────────────────
// Free-trial lock notice. Rendered above the body when _ctxIsTrialing is
// true so users see why an avatar render or schedule_post can't fire yet,
// plus a 20%-off CTA that takes them to /billing with the upsell preselected.
function TrialLockNotice({ feature, savingsPct = 20 }) {
  return (
    <div
      onClick={(e) => { e.stopPropagation() }}
      style={{
        marginBottom: 8,
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid rgba(245,158,11,0.45)',
        background: 'linear-gradient(135deg, rgba(245,158,11,0.14), rgba(239,68,68,0.10))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Lock size={12} style={{ color: '#fbbf24' }} />
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 11.5, fontWeight: 700, color: '#fbbf24' }}>
          Locked during free trial
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-soft)', lineHeight: 1.5, marginBottom: 6 }}>
        {feature} is a paid feature. Upgrade now and we'll knock <strong>{savingsPct}% off</strong> your first month.
      </div>
      <a
        href={`/billing?upsell=trial-unlock&promo=TRIAL${savingsPct}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 10px', borderRadius: 6,
          background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
          color: '#fff', textDecoration: 'none',
          fontFamily: 'var(--font-display)', fontSize: 11.5, fontWeight: 700,
        }}
      >
        <Sparkles size={11} /> Unlock with {savingsPct}% off
      </a>
    </div>
  )
}

function AvatarRenderBody({ data }) {
  const out = data.output
  const clipCount = Array.isArray(out?.videos) ? out.videos.length : 0
  const partialFails = Array.isArray(out?.partial_failures) ? out.partial_failures.length : 0
  return (
    <>
      {data._ctxIsTrialing && <TrialLockNotice feature="Avatar video render" />}

      {data.status !== 'done' && data.status !== 'failed' && data.status !== 'running' &&
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          Connect an Avatar picker + voice gen (or a script / audio file).
        </div>}

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

      {/* Multi-clip render (randomize / cycle): show the clip count and a
          tiny grid of thumbnails. Hides URLs and HeyGen ids — clicking a
          thumb opens the fullscreen preview via the shared MediaItem. */}
      {data.status === 'done' && !out?.video_url && clipCount > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, fontSize: 12, color: 'var(--text)' }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700 }}>
              {clipCount} {clipCount === 1 ? 'clip' : 'clips'} ready
            </span>
            {partialFails > 0 && (
              <span title="Some clips failed during this render." style={{ fontSize: 10.5, color: 'var(--amber)' }}>
                {partialFails} skipped
              </span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
            {out.videos.slice(0, 6).map((v, i) => (
              <MediaItem key={i} url={v.video_url} type="video" from={`clip ${i + 1}`} aspectRatio="9/16" />
            ))}
          </div>
        </>
      )}

      {data.status === 'failed' && <NodePreview status="failed" error={data.error} />}
      {data.status === 'running' && <ProgressPill progress={data.progress} fallback="Rendering…" />}
      {data.status === 'done' && !out?.video_url && clipCount === 0 && (
        <div style={{ ...previewBox, color: 'var(--text-soft)' }}>Done</div>
      )}
    </>
  )
}


// Voice gen body. Shows the synthesized audio + voice tuning so the
// user can review before downstream nodes run. No "Approve" — the
// output exists once Run completes; downstream picks it up. To regen,
// click Re-synth (overwrites the output and invalidates downstream
// caches naturally).
function VoiceGenBody({ data, onPatch }) {
  const out = data.output
  const audio = out?.audio
  const chunks = Array.isArray(out?.audio_chunks) ? out.audio_chunks : null
  const [previewIdx, setPreviewIdx] = useState(0)

  // True when an avatar_picker is anywhere upstream. Drives the
  // picker visibility: when an avatar IS wired, the avatar's voice
  // wins and we hide the standalone picker to remove ambiguity.
  // Injected by Spaces.jsx renderNodes. Defaults to false if absent.
  const hasAvatarUpstream = !!data._ctxHasAvatarUpstream
  const pickerVoiceId   = data.props?.picker_voice_id || ''
  const pickerVoiceName = data.props?.picker_voice_name || ''
  const pickerVoiceOwner = data.props?.picker_voice_owner || 'shared'

  // Load the voice library on demand — only when the picker is
  // actually visible (no avatar upstream). Cached for the duration
  // of the mount.
  const [voices, setVoices] = useState(null)
  const [voicesLoading, setVoicesLoading] = useState(false)
  const [voicesError, setVoicesError] = useState(null)
  useEffect(() => {
    if (hasAvatarUpstream) return
    if (voices !== null) return
    let cancelled = false
    setVoicesLoading(true); setVoicesError(null)
    ;(async () => {
      try {
        const session = (await supabase.auth.getSession()).data.session
        const r = await fetch('/api/voices/library', {
          headers: { Authorization: `Bearer ${session?.access_token || ''}` },
        })
        const body = await r.json()
        if (!r.ok) throw new Error(body?.error || `Voices ${r.status}`)
        if (!cancelled) setVoices(Array.isArray(body?.shared) ? body.shared : [])
      } catch (e) {
        if (!cancelled) { setVoices([]); setVoicesError(e.message) }
      } finally {
        if (!cancelled) setVoicesLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [hasAvatarUpstream, voices])

  // Read voice settings DIRECTLY from props — single source of truth.
  // Previously this was mirrored into local useState which got re-
  // initialized on canvas re-mount (zoom/virtualization/scope reset),
  // wiping the user's settings between Run clicks. Props persist
  // through every re-mount path the canvas takes.
  const VOICE_DEFAULTS = {
    stability: 0.5, similarity_boost: 0.85, style: 0.2, use_speaker_boost: true, speed: 1.0,
  }
  const draftSettings = { ...VOICE_DEFAULTS, ...(data.props?.voice_settings_override || {}) }
  const draftModel = data.props?.voice_model_id_override || 'eleven_turbo_v2_5'
  const draftLanguage = data.props?.voice_language_override || 'en'

  const fieldSet = (k, v) => {
    onPatch?.({ voice_settings_override: { ...draftSettings, [k]: v } })
  }
  const setDraftModel = (v) => onPatch?.({ voice_model_id_override: v })
  const setDraftLanguage = (v) => onPatch?.({ voice_language_override: v })

  return (
    <>
      {data.status === 'failed' && <NodePreview status="failed" error={data.error} />}
      {data.status === 'running' && <ProgressPill progress={data.progress} fallback="Synthesizing audio…" />}

      {/* Voice picker — only shown when no avatar is wired upstream.
          With an avatar wired, the avatar's voice wins so we hide
          this to remove ambiguity. */}
      {!hasAvatarUpstream && (
        <div style={{ marginBottom: 8, padding: 8, background: 'var(--surface-2)', borderRadius: 6, border: '1px solid var(--border)' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4,
            fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10.5,
            letterSpacing: '0.06em', textTransform: 'uppercase', color: '#22d3ee',
          }}>
            <Mic size={10} /> Voice
            <span style={{ flex: 1 }} />
            {pickerVoiceName && (
              <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>
                {pickerVoiceName}
              </span>
            )}
          </div>
          {voicesLoading && <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>Loading voices…</div>}
          {voicesError && <div style={{ fontSize: 10.5, color: 'var(--red)' }}>{voicesError}</div>}
          {voices && voices.length === 0 && !voicesLoading && (
            <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>No voices available. Check ELEVENLABS_API_KEY.</div>
          )}
          {voices && voices.length > 0 && (
            <select
              className="nodrag"
              style={{ ...tinyInput, fontSize: 11 }}
              value={pickerVoiceId}
              onChange={(e) => {
                const id = e.target.value
                const v = voices.find((x) => x.voice_id === id)
                onPatch?.({
                  picker_voice_id: id || null,
                  picker_voice_name: v?.name || null,
                  picker_voice_owner: 'shared',
                })
              }}
            >
              <option value="">— pick a voice —</option>
              {voices.map((v) => (
                <option key={v.voice_id} value={v.voice_id}>
                  {v.name}{v.labels?.gender ? ` · ${v.labels.gender}` : ''}{v.labels?.accent ? ` · ${v.labels.accent}` : ''}
                </option>
              ))}
            </select>
          )}
          <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
            Wire an Avatar picker upstream to use that avatar's voice instead.
          </div>
        </div>
      )}

      {/* Voice tuning panel — ALWAYS visible. The whole point of this
          node is to give the user direct control over the voice; hiding
          the knobs behind a disclosure defeats the purpose. Changes
          persist into props on every keystroke and apply on the next
          Run. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10.5,
          letterSpacing: '0.06em', textTransform: 'uppercase', color: '#22d3ee',
        }}>
          <Mic size={10} /> Voice tuning
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 9.5, color: 'var(--muted)', fontWeight: 700 }}>
            {data.status === 'done' ? 'applies on next run' : ''}
          </span>
        </div>
        <MiniSlider
          label="Stability" min={0} max={1} step={0.05}
          value={draftSettings.stability}
          onChange={(v) => fieldSet('stability', v)}
          hint="Lower = more variation between takes (more emotion). Higher = consistent + flat. 0.3–0.5 is the natural-performance band."
        />
        <MiniSlider
          label="Similarity" min={0} max={1} step={0.05}
          value={draftSettings.similarity_boost}
          onChange={(v) => fieldSet('similarity_boost', v)}
          hint="How tightly the model sticks to the source voice's timbre. High = locked-in clone. Lower lets the model interpret."
        />
        <MiniSlider
          label="Style" min={0} max={1} step={0.05}
          value={draftSettings.style}
          onChange={(v) => fieldSet('style', v)}
          hint="Style exaggeration. 0 = flat read. 1 = theatrical. Most useful on Multilingual v2 / v3."
        />
        <MiniSlider
          label="Speed" min={0.7} max={1.2} step={0.05}
          value={draftSettings.speed}
          onChange={(v) => fieldSet('speed', v)}
          format={(v) => `${Number(v).toFixed(2)}×`}
          hint="Playback speed. 0.7 = slow, 1.0 = natural, 1.2 = fast. Outside this range distorts."
        />
        <label
          title="Emphasises the speaker's voice character. Slightly higher latency. Default on."
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-soft)' }}
        >
          <input
            type="checkbox" className="nodrag"
            checked={!!draftSettings.use_speaker_boost}
            onChange={(e) => fieldSet('use_speaker_boost', e.target.checked)}
          /> Speaker boost
          <span style={{ fontSize: 9.5, color: 'var(--muted)', marginLeft: 'auto' }}>
            emphasises voice character
          </span>
        </label>

        <label style={{ fontSize: 10, color: 'var(--muted)' }}>
          Model
          <select className="nodrag" value={draftModel} onChange={(e) => setDraftModel(e.target.value)} style={{ ...tinyInput, fontSize: 11, marginTop: 2 }}>
            <option value="eleven_turbo_v2_5">Turbo v2.5 (1× tokens)</option>
            <option value="eleven_multilingual_v2">Multilingual v2 (3× tokens)</option>
            <option value="eleven_v3">v3 (5× tokens, expression tags)</option>
          </select>
          <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.35 }}>
            {draftModel === 'eleven_turbo_v2_5' && 'Fast and cheap. Good baseline for short-form social.'}
            {draftModel === 'eleven_multilingual_v2' && 'Richer emotion + better non-English. Best for storytelling.'}
            {draftModel === 'eleven_v3' && 'Most expressive. Script generator adds inline emotion tags ([sighs], [whispers]) when this is selected.'}
          </div>
        </label>

        <label style={{ fontSize: 10, color: 'var(--muted)' }}>
          Language
          <select className="nodrag" value={draftLanguage} onChange={(e) => setDraftLanguage(e.target.value)} style={{ ...tinyInput, fontSize: 11, marginTop: 2 }}>
            <option value="en">English</option><option value="es">Spanish</option>
            <option value="fr">French</option><option value="de">German</option>
            <option value="pt">Portuguese</option><option value="it">Italian</option>
            <option value="nl">Dutch</option><option value="pl">Polish</option>
            <option value="tr">Turkish</option><option value="ru">Russian</option>
            <option value="ja">Japanese</option><option value="zh">Chinese</option>
            <option value="ko">Korean</option><option value="hi">Hindi</option>
            <option value="ar">Arabic</option>
          </select>
          <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.35 }}>
            Pinned per render so the voice doesn't drift mid-script (multilingual models auto-detect by default and can flip languages on numbers / brand names).
          </div>
        </label>
      </div>

      {data.status !== 'done' && data.status !== 'failed' && data.status !== 'running' && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10, padding: 8, background: 'var(--surface-2)', borderRadius: 6, border: '1px dashed var(--border)' }}>
          Connect a script + avatar, then hit Run to synth.
        </div>
      )}

      {data.status === 'done' && (audio?.url || chunks) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          {/* Single audio: one player. */}
          {audio?.url && !chunks && (
            <audio controls className="nodrag" src={audio.url} style={{ width: '100%' }} />
          )}

          {/* Chunked audio: scrub through slices. */}
          {chunks && (
            <>
              <div style={{ fontSize: 10.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{chunks.length} chunks · click a slice to preview</span>
                <span>Slice {previewIdx + 1} of {chunks.length}</span>
              </div>
              <audio controls className="nodrag" key={chunks[previewIdx]?.audio_url} src={chunks[previewIdx]?.audio_url} style={{ width: '100%' }} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {chunks.map((c, i) => (
                  <button
                    key={i} type="button" className="nodrag"
                    onClick={(e) => { e.stopPropagation(); setPreviewIdx(i) }}
                    style={{
                      padding: '3px 8px', borderRadius: 6,
                      background: previewIdx === i ? 'rgba(34,211,238,0.20)' : 'var(--surface-2)',
                      border: `1px solid ${previewIdx === i ? '#22d3ee' : 'var(--border)'}`,
                      color: previewIdx === i ? '#22d3ee' : 'var(--text-soft)',
                      fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-display)',
                      cursor: 'pointer',
                    }}
                  >{i + 1}</button>
                ))}
              </div>
            </>
          )}

          <div style={{ fontSize: 10, color: 'var(--muted)', textAlign: 'center' }}>
            {chunks
              ? `${out?.script_chars?.toLocaleString() || '?'} chars · ${chunks.length} slices`
              : `${out?.script_chars?.toLocaleString() || '?'} chars · single take`}
          </div>
        </div>
      )}
    </>
  )
}

// Compact slider used inside the review panel (the avatar editor uses
// its own bigger slider). Format opt formats the value chip; optional
// hint renders as a one-line description below the slider so users
// understand what each knob actually does without hovering.
function MiniSlider({ label, min, max, step, value, onChange, format, hint }) {
  const v = Number(value ?? 0)
  return (
    <label style={{ display: 'block', fontSize: 10.5, color: 'var(--muted)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
        <span>{label}</span>
        <span style={{ color: 'var(--text)', fontFamily: 'var(--font-display)', fontWeight: 700 }}>
          {format ? format(v) : v.toFixed(2)}
        </span>
      </div>
      <input
        type="range" className="nodrag"
        min={min} max={max} step={step} value={v}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: '#22d3ee' }}
      />
      {hint && (
        <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.35 }}>
          {hint}
        </div>
      )}
    </label>
  )
}

function ProgressPill({ progress, fallback = 'Working…' }) {
  const total = Number(progress?.total) || 0
  const done = Number(progress?.done) || 0
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : null
  return (
    <div style={{ ...previewBox, color: 'var(--amber)' }}>
      <Loader2 size={11} className="spin" style={{ marginRight: 6, verticalAlign: '-1px' }} />
      {progress?.message || fallback}
      {pct != null && (
        <div style={{ marginTop: 6, height: 4, background: 'var(--surface)', borderRadius: 999, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--amber)', transition: 'width 250ms ease' }} />
        </div>
      )}
    </div>
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
  // Once the polish has actually rendered, the cached video already
  // contains the burned overlays — so showing the live-overlay
  // preview on top of it is wrong (double title, double watermark,
  // wrong scale). Fall back to the rendered MediaItem; switch back
  // to the live preview when the user edits or re-runs.
  //
  // Multi-clip mode: polish fan-out emits output.videos[] with one
  // entry per polished clip. Paginate through them with prev/next
  // controls so the user can review every rendered clip.
  const polishedClips = Array.isArray(out?.videos) && out.videos.length > 0 ? out.videos : null
  const isMultiClip = !!(polishedClips && polishedClips.length > 1)
  const totalClips = polishedClips ? polishedClips.length : 1
  const [clipIdx, setClipIdx] = useState(0)
  const safeIdx = Math.max(0, Math.min(clipIdx, totalClips - 1))
  const currentClipUrl = polishedClips
    ? polishedClips[safeIdx]?.video_url
    : (out?.video_url || null)
  const currentClipTitle = polishedClips
    ? (polishedClips[safeIdx]?.title || data.name || 'polished')
    : (out?.title || data.name || 'polished')
  const hasRenderedVideo = !!currentClipUrl
  return (
    <>
      {hasRenderedVideo ? (
        <>
          {isMultiClip && (
            <div className="nodrag" style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 8px', marginBottom: 6,
              background: 'rgba(14,165,233,0.10)',
              border: '1px solid rgba(14,165,233,0.35)',
              borderRadius: 6, fontSize: 11.5,
            }}>
              <button
                type="button"
                className="nodrag"
                onClick={(e) => { e.stopPropagation(); setClipIdx((i) => Math.max(0, i - 1)) }}
                disabled={safeIdx === 0}
                style={{
                  background: 'transparent', border: 'none',
                  cursor: safeIdx === 0 ? 'not-allowed' : 'pointer',
                  color: safeIdx === 0 ? 'var(--muted)' : '#0ea5e9',
                  padding: 4, opacity: safeIdx === 0 ? 0.4 : 1,
                }}
                title="Previous clip"
              >◀</button>
              <span style={{ fontWeight: 700, fontFamily: 'var(--font-display)', letterSpacing: '0.04em', color: '#0ea5e9' }}>
                CLIP {safeIdx + 1} OF {totalClips}
              </span>
              <button
                type="button"
                className="nodrag"
                onClick={(e) => { e.stopPropagation(); setClipIdx((i) => Math.min(totalClips - 1, i + 1)) }}
                disabled={safeIdx === totalClips - 1}
                style={{
                  background: 'transparent', border: 'none',
                  cursor: safeIdx === totalClips - 1 ? 'not-allowed' : 'pointer',
                  color: safeIdx === totalClips - 1 ? 'var(--muted)' : '#0ea5e9',
                  padding: 4, opacity: safeIdx === totalClips - 1 ? 0.4 : 1,
                }}
                title="Next clip"
              >▶</button>
            </div>
          )}
          <MediaItem key={currentClipUrl} url={currentClipUrl} type="video" from={currentClipTitle} aspectRatio="9/16" />
          {/* Partial-failure panel. Multi-clip fan-out drops failed
              clips from videos[] and stashes them in partial_failures.
              Without this panel the user can't tell why "5 in →
              2 out" happened — each entry surfaces clip_index +
              source_url + the actual error from the polish call. */}
          {Array.isArray(out?.partial_failures) && out.partial_failures.length > 0 && (
            <div className="nodrag" style={{
              marginTop: 8, padding: '8px 10px',
              background: 'rgba(239,68,68,0.10)',
              border: '1px solid rgba(239,68,68,0.35)',
              borderRadius: 6, fontSize: 11, color: 'var(--red)',
              lineHeight: 1.4,
            }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {out.partial_failures.length} of {(out.videos?.length || 0) + out.partial_failures.length} clips failed
              </div>
              {out.partial_failures.slice(0, 5).map((f, i) => (
                <div key={i} style={{ fontSize: 10.5, marginTop: 3, opacity: 0.9 }}>
                  <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700 }}>Clip {(f.clip_index ?? i) + 1}:</span>{' '}
                  {f.error || 'Unknown error'}
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              const fname = `${(currentClipTitle || 'polished').replace(/\W+/g, '-')}${isMultiClip ? `-clip${safeIdx + 1}` : ''}.mp4`
              downloadUrl(currentClipUrl, fname)
            }}
            style={{
              marginTop: 8, width: '100%', padding: '6px 8px', fontSize: 11,
              background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
              color: 'var(--text)', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              marginBottom: 6,
            }}
          ><Download size={11} /> Download {isMultiClip ? `clip ${safeIdx + 1}` : 'polished video'}</button>
        </>
      ) : (
        <>
          {/* Inline live preview — same composited DOM the drawer uses, scaled to fit. */}
          <VideoPolishPreview
            videoUrl={upstreamVideo}
            script={upstreamScript}
            props={props}
            logoUrl={previewLogo}
          />
          <div style={{ marginTop: 6, marginBottom: 8, fontSize: 10, color: 'var(--muted)', textAlign: 'center', lineHeight: 1.3 }}>
            {upstreamVideo ? 'Live preview — overlays update as you edit' : 'Run an upstream node to see the preview frame'}
          </div>
        </>
      )}
      {/* Per-section toggles removed — all configuration lives in the
          settings drawer (opened via the Settings icon in the header
          or the "Open all settings" button below). The inline toggles
          were duplicating drawer state and adding a lot of visual
          weight on the node body. */}
      <button
        type="button"
        className="nodrag"
        onClick={(e) => { e.stopPropagation(); window.__spaceOpenEditor?.(data.__id) }}
        style={{
          width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          padding: '7px 10px', gap: 6,
          background: 'linear-gradient(135deg, var(--red), var(--red-dark))', border: 'none',
          borderRadius: 7, color: '#fff', cursor: 'pointer', fontSize: 11.5,
          fontFamily: 'var(--font-display)', fontWeight: 700, marginBottom: 4,
          boxShadow: '0 4px 10px rgba(239,68,68,0.25)',
        }}
      >
        <Sparkles size={11} /> Open all settings
      </button>
      {status === 'running'
        ? <ProgressPill progress={data.progress} fallback="Polishing video…" />
        : <NodePreview status={status} output={null} error={data.error} />}
    </>
  )
}

// Compact on/off row for each polish section. Checkbox flips the
// section instantly; clicking the label opens the editor sidebar so
// the user can tune values without remembering to right-click /
// double-click the node.
function PolishToggle({ label, on, summary, onToggle, onOpen }) {
  return (
    <div
      className="nodrag"
      onClick={onOpen}
      role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px', borderRadius: 6,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        cursor: 'pointer', fontSize: 11,
      }}
    >
      <input className="nodrag"
        type="checkbox"
        checked={on}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => { e.stopPropagation(); onToggle(e.target.checked) }}
        style={{ accentColor: 'var(--red)' }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--text)' }}>{label}</div>
        <div style={{
          fontSize: 10, color: on ? 'var(--text-soft)' : 'var(--muted)',
          marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{summary}</div>
      </div>
      <ArrowUpRight size={10} style={{ color: 'var(--muted)' }} />
    </div>
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

// True when at least one upstream node is an avatar_picker. Used by
// voice_gen's body to switch between "avatar's voice" mode (avatar
// upstream) and "standalone voice picker" mode (no avatar).
export function findUpstreamAvatarPicker(nodeId, nodes, edges) {
  if (!nodeId || !Array.isArray(nodes) || !Array.isArray(edges)) return false
  const seen = new Set([nodeId])
  const queue = [nodeId]
  while (queue.length) {
    const cur = queue.shift()
    for (const e of edges) {
      if (e.target !== cur || seen.has(e.source)) continue
      seen.add(e.source)
      const src = nodes.find((n) => n.id === e.source)
      if (!src) continue
      if (src.data?.type === 'avatar_picker') return true
      queue.push(e.source)
    }
  }
  return false
}

// Returns true when a text_post_gen node sits anywhere upstream of
// the given nodeId. Used by Schedule post to gate its platform
// picker — text-only posts can only land on the platforms that
// natively accept text (X, Threads, Facebook, LinkedIn), even
// though the brand has TikTok / Instagram / YouTube / Pinterest
// connected for image / video posts.
export function findUpstreamTextPost(nodeId, nodes, edges) {
  if (!nodeId || !Array.isArray(nodes) || !Array.isArray(edges)) return false
  const seen = new Set([nodeId])
  const queue = [nodeId]
  while (queue.length) {
    const cur = queue.shift()
    for (const e of edges) {
      if (e.target !== cur || seen.has(e.source)) continue
      seen.add(e.source)
      const src = nodes.find((n) => n.id === e.source)
      if (!src) continue
      if (src.data?.type === 'text_post_gen') return true
      queue.push(e.source)
    }
  }
  return false
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

// Walk upstream from `nodeId` and return the first audio_upload's URL.
// Used by the music-preview block in the polish editor so the user can
// hear the mix before paying for a render.
export function findUpstreamMusicUrl(nodeId, nodes, edges) {
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
      if (src.data?.type === 'audio_upload') {
        const url = src.data?.props?.url
        if (url) return url
      }
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
      <input className="nodrag"
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
      <input className="nodrag"
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

// Pill-style enable toggle that lives at the top of each editor section.
// Visually different from the inline body toggles so the user has one
// canonical "this whole section on/off" control inside the drawer.
function SectionEnable({ label, checked, onChange }) {
  return (
    <label
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
        background: checked ? 'rgba(46,204,113,0.10)' : 'var(--surface-2)',
        border: `1px solid ${checked ? 'rgba(46,204,113,0.40)' : 'var(--border)'}`,
        marginBottom: 14,
      }}
    >
      <input className="nodrag"
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: '#2ecc71', cursor: 'pointer' }}
      />
      <span style={{
        fontSize: 12, fontFamily: 'var(--font-display)', fontWeight: 700,
        color: checked ? '#2ecc71' : 'var(--text-soft)',
      }}>{label}</span>
      <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--muted)', fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {checked ? 'On' : 'Off'}
      </span>
    </label>
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
  // Detect the actual aspect ratio of the loaded video instead of
  // assuming 9:16. Avatar renders ARE 9:16, but combine_videos can
  // produce horizontal or square depending on what fed it. Without
  // detection we'd object-cover-crop horizontal sources into a tall
  // frame, which is exactly what "looks small" feels like.
  const [aspect, setAspect] = useState('9/16')
  const [expanded, setExpanded] = useState(false)
  const onMeta = (e) => {
    const w = e?.target?.videoWidth || 0
    const h = e?.target?.videoHeight || 0
    if (w > 0 && h > 0) setAspect(`${w}/${h}`)
  }
  return (
    <>
      <div style={{
        position: 'relative', width: '100%',
        // Fall back to 9:16 if the video hasn't loaded metadata yet.
        // Once onLoadedMetadata fires the container resizes to the real
        // aspect — vertical clips stay 9:16, horizontal clips show
        // wide-and-short, square shows square.
        aspectRatio: aspect,
        background: '#000', borderRadius: 10, overflow: 'hidden',
        border: '1px solid var(--border)',
      }}>
        {videoUrl ? (
          <video
            src={videoUrl}
            muted playsInline preload="metadata"
            onLoadedMetadata={onMeta}
            // contain (not cover) so horizontal clips aren't cropped to
            // fit a portrait container. With aspect-ratio detection the
            // container matches the video so contain ≈ cover but
            // contain handles slow/missing metadata gracefully.
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : (
          <div style={{
            position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
            color: 'var(--muted)', fontSize: 11, padding: 12, textAlign: 'center', lineHeight: 1.45,
          }}>
            <div>
              <div style={{ marginBottom: 4 }}>No video to preview yet.</div>
              <div style={{ fontSize: 10 }}>Wire an Avatar video or Combine videos into <code>in</code>, then run that upstream node once.</div>
            </div>
          </div>
        )}
        {videoUrl && (
          <button
            type="button" className="nodrag"
            onClick={(e) => { e.stopPropagation(); setExpanded(true) }}
            title="Expand preview"
            style={{
              position: 'absolute', top: 6, right: 6,
              padding: 5, borderRadius: 6,
              background: 'rgba(0,0,0,0.55)',
              border: '1px solid rgba(255,255,255,0.10)',
              color: '#fff', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center',
              zIndex: 5,
            }}
          ><Maximize2 size={11} /></button>
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
      {props.watermark_position && props.watermark_position !== 'none' && (() => {
        // Position calc — corners use percent insets, the new 'bc-safe'
        // option (centered horizontally, 18% off the bottom) needs
        // transform-based centering so it stays centered as the
        // preview frame scales.
        const isBcSafe = props.watermark_position === 'bc-safe'
        const posStyle = isBcSafe
          ? { bottom: '18%', left: '50%', transform: 'translateX(-50%)' }
          : {
              ...(props.watermark_position.includes('t') ? { top: '4%' } : { bottom: '4%' }),
              ...(props.watermark_position.includes('l') ? { left: '4%' } : { right: '4%' }),
            }
        if (logoUrl) {
          return (
            <img
              src={logoUrl} alt=""
              style={{
                position: 'absolute', ...posStyle,
                width: `${props.watermark_size_pct ?? 12}%`,
                objectFit: 'contain',
              }}
            />
          )
        }
        return (
          <div style={{
            position: 'absolute', ...posStyle,
            width: `${props.watermark_size_pct ?? 12}%`,
            aspectRatio: '3/1',
            background: 'rgba(255,255,255,0.18)',
            border: '1px dashed rgba(255,255,255,0.5)',
            borderRadius: 4, display: 'grid', placeItems: 'center',
            color: 'rgba(255,255,255,0.85)', fontSize: 10, fontWeight: 700,
            letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>logo</div>
        )
      })()}
      </div>
      {/* Fullscreen preview overlay — opens when the user clicks the
          maximize button. Click outside or hit Esc closes. The video
          plays inline with controls so the user can scrub a frame. */}
      {expanded && videoUrl && (
        <div
          onClick={() => setExpanded(false)}
          role="dialog" aria-modal="true"
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(6px)',
            display: 'grid', placeItems: 'center', padding: 24, cursor: 'zoom-out',
          }}
        >
          <button
            aria-label="Close preview"
            onClick={(e) => { e.stopPropagation(); setExpanded(false) }}
            style={{
              position: 'absolute', top: 18, right: 18,
              width: 36, height: 36, borderRadius: 999,
              background: 'rgba(255,255,255,0.10)', border: 'none', color: '#fff',
              cursor: 'pointer', display: 'grid', placeItems: 'center', fontSize: 16,
            }}
          >×</button>
          <video
            src={videoUrl} controls autoPlay muted
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '92vw', maxHeight: '88vh', borderRadius: 8, background: '#000' }}
          />
        </div>
      )}
    </>
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
        <input className="nodrag"
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

  // Pick the most useful preview. Priority:
  //   1. preview_gif_url from public.zapcap_template_previews — the
  //      admin-curated caption-only GIF served from Supabase Storage.
  //   2. ZapCap's own thumbnail / poster image.
  //   3. ZapCap's preview video, rendered paused with preload=metadata
  //      so only the first frame loads (no auto-looping demo wall).
  const pickPreview = (t) => {
    if (t.preview_gif_url) {
      const isVideo = /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(t.preview_gif_url)
      return { kind: isVideo ? 'video' : 'image', src: t.preview_gif_url }
    }
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

// Inline music uploader for the polish editor's Music section. Replaces
// the old "wire an audio_upload node in" model — users can drop an MP3
// straight into the editor. The polish renderer auto-trims to video
// length and fades out, so the user never has to think about clip
// length.
//
// Constraints:
//   • MP3 only. We accept .mp3 / audio/mpeg explicitly to avoid Safari
//     rendering edge-cases with WebM and AAC-in-mp4.
//   • 8 MB cap. A standard 192kbps MP3 fits 5+ minutes in that budget;
//     since polish caps the rendered clip at video length anyway, this
//     ceiling protects us against accidental "I uploaded my podcast"
//     drops without inconveniencing legitimate music tracks.
//   • Wired-in audio_upload node still wins as a fallback so existing
//     spaces keep working — uploadedUrl > upstreamUrl in the renderer.
const POLISH_MUSIC_MAX_BYTES = 8 * 1024 * 1024

function PolishMusicUpload({ uploadedUrl, uploadedName, upstreamUrl, profileId, onChange }) {
  const inpRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const effective = uploadedUrl || upstreamUrl
  const isUploaded = !!uploadedUrl
  const sourceLabel = isUploaded ? (uploadedName || 'Uploaded MP3')
    : upstreamUrl ? 'From wired audio_upload node'
    : null

  const onPick = async (file) => {
    if (!file) return
    setErr(null)
    // MIME / extension guard. Browsers report the type inconsistently
    // for the same .mp3 file (audio/mpeg, audio/mp3, sometimes blank),
    // so check both fields.
    const looksMp3 = (file.type || '').toLowerCase().includes('mpeg')
      || (file.type || '').toLowerCase().includes('mp3')
      || /\.mp3$/i.test(file.name || '')
    if (!looksMp3) {
      setErr('MP3 only. Convert your file (Audacity / iTunes / online converter) and try again.')
      return
    }
    if (file.size > POLISH_MUSIC_MAX_BYTES) {
      setErr(`${(file.size / 1024 / 1024).toFixed(1)} MB exceeds the ${POLISH_MUSIC_MAX_BYTES / 1024 / 1024} MB limit. Trim or re-encode at a lower bitrate (192 kbps is plenty for background music).`)
      return
    }
    setBusy(true)
    try {
      const url = await uploadAudioToBucket(file, profileId)
      onChange(url, { name: file.name, size: file.size })
    } catch (e) {
      setErr(e.message)
    } finally { setBusy(false); if (inpRef.current) inpRef.current.value = '' }
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={labelStyle}>Music track</div>
      {effective ? (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 8,
          padding: 10, borderRadius: 8,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
        }}>
          <audio src={effective} controls style={{ width: '100%' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--text-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {sourceLabel}
            </div>
            <button
              type="button"
              onClick={() => inpRef.current?.click()}
              disabled={busy}
              style={{
                padding: '5px 10px', borderRadius: 6, fontSize: 11,
                background: 'var(--surface)', border: '1px solid var(--border)',
                color: 'var(--text)', cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}
            >
              {busy ? <Loader2 size={11} className="spin" /> : <Upload size={11} />}
              Replace
            </button>
            {isUploaded && (
              <button
                type="button"
                onClick={() => onChange(null, null)}
                style={{
                  padding: '5px 10px', borderRadius: 6, fontSize: 11,
                  background: 'transparent', border: '1px solid var(--border)',
                  color: 'var(--muted)', cursor: 'pointer',
                }}
              >
                <Trash2 size={10} />
              </button>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inpRef.current?.click()}
          disabled={busy || !profileId}
          style={{
            width: '100%', padding: 16, borderRadius: 8,
            background: 'var(--surface-2)', border: '1px dashed var(--border)',
            color: 'var(--text)', cursor: profileId ? 'pointer' : 'not-allowed',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
            fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12,
          }}
        >
          {busy ? <Loader2 size={16} className="spin" /> : <Mic size={16} style={{ color: 'var(--red)' }} />}
          {busy ? 'Uploading…' : 'Upload an MP3'}
          <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 500 }}>
            MP3 · max {POLISH_MUSIC_MAX_BYTES / 1024 / 1024} MB · auto-trims to video length
          </span>
        </button>
      )}
      <input
        ref={inpRef} type="file" accept="audio/mpeg,audio/mp3,.mp3"
        onChange={(e) => onPick(e.target.files?.[0])}
        style={{ display: 'none' }}
      />
      {err && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--red)', lineHeight: 1.4 }}>{err}</div>}
    </div>
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
  // Music preview pulls the upstream rendered video + the wired-in audio
  // file so the user can A/B the mix with a slider before paying for a
  // polish render.
  const upstreamVideo = useMemo(
    () => data.output?.video_url || findUpstreamVideoUrl(nodeId, allNodes, allEdges),
    [nodeId, allNodes, allEdges, data.output?.video_url]
  )
  const upstreamMusic = useMemo(
    () => findUpstreamMusicUrl(nodeId, allNodes, allEdges),
    [nodeId, allNodes, allEdges]
  )

  const setP = (patch) => onPatch(patch)

  return (
    <>
      {/* Live preview lives in the node body now — no need to render it
         in the drawer too. (User feedback: redundant.) */}

      {/* Title overlay ─────────────────────────────────────────────────── */}
      <PolishSection icon={Type} title="Title overlay">
        <SectionEnable
          label="Burn a title overlay onto the video"
          checked={props.title_enabled !== false}
          onChange={(v) => setP({ title_enabled: v })}
        />
        {props.title_enabled !== false && (
          <>
            {/* Quick presets — one click, they can fine-tune below. */}
            <div style={labelStyle}>Style preset</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginBottom: 14 }}>
              {[
                { id: 'tiktok',    name: 'TikTok',    font: 'Montserrat ExtraBold', color: '#ffffff', bg_color: '#e0467a', size: 72,  padding: 28, uppercase: false },
                { id: 'instagram', name: 'Instagram', font: 'Poppins ExtraBold',    color: '#ffffff', bg_color: '#000000', size: 64,  padding: 22, uppercase: true  },
                { id: 'youtube',   name: 'YouTube',   font: 'Inter ExtraBold',      color: '#ffffff', bg_color: '#ef4444', size: 80,  padding: 32, uppercase: true  },
                { id: 'minimal',   name: 'Minimal',   font: 'Bebas Neue',           color: '#1f1f1f', bg_color: '#fde68a', size: 56,  padding: 18, uppercase: false },
              ].map((preset) => {
                const isActive =
                  props.title_font === preset.font &&
                  props.title_color === preset.color &&
                  props.title_bg_color === preset.bg_color &&
                  Number(props.title_size) === preset.size
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setP({
                      title_font: preset.font, title_color: preset.color,
                      title_bg_color: preset.bg_color, title_size: preset.size,
                      title_bg_padding: preset.padding, title_uppercase: preset.uppercase,
                    })}
                    style={{
                      padding: '7px 6px', borderRadius: 6, fontSize: 10.5,
                      border: `1px solid ${isActive ? '#0ea5e9' : 'var(--border)'}`,
                      background: isActive ? 'rgba(14,165,233,0.16)' : 'var(--surface-2)',
                      color: isActive ? '#0ea5e9' : 'var(--text-soft)',
                      cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700,
                    }}
                  >{preset.name}</button>
                )
              })}
            </div>

            <NodeField label="Title source">
              <select className="nodrag"
                style={tinyInput}
                value={props.title_mode || 'auto'}
                onChange={(e) => setP({ title_mode: e.target.value })}
              >
                <option value="auto">Auto — transcribe + AI writes</option>
                <option value="manual">Manual — type my own</option>
              </select>
            </NodeField>
            {(props.title_mode || 'auto') === 'auto' ? (
              <NodeField label="Angle hint (optional)">
                <textarea className="nodrag nowheel"
                  style={{ ...tinyInput, minHeight: 56, fontFamily: 'inherit', resize: 'vertical' }}
                  placeholder='e.g. "punchy red-flag hook, max 6 words"'
                  value={props.title_topic || ''}
                  onChange={(e) => setP({ title_topic: e.target.value })}
                />
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
                  ElevenLabs transcribes; AI writes the title using your brand bible. ~800 ai_tokens per render.
                </div>
              </NodeField>
            ) : (
              <NodeField label="Title text">
                <input className="nodrag"
                  style={tinyInput}
                  placeholder="Your title here"
                  value={props.title || ''}
                  onChange={(e) => setP({ title: e.target.value })}
                  maxLength={120}
                />
                <div style={{ fontSize: 10, color: (props.title?.length || 0) > 80 ? 'var(--amber)' : 'var(--muted)', marginTop: 3, textAlign: 'right' }}>
                  {(props.title || '').length} / 120
                </div>
              </NodeField>
            )}

            <NodeField label="Font">
              <select className="nodrag" style={tinyInput} value={props.title_font || 'Montserrat ExtraBold'} onChange={(e) => setP({ title_font: e.target.value })}>
                {POLISH_FONT_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </NodeField>

            <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
              <PolishColorRow label="Text" value={props.title_color || '#ffffff'} onChange={(v) => setP({ title_color: v })} />
              <PolishColorRow label="Background" value={props.title_bg_color || '#e0467a'} onChange={(v) => setP({ title_bg_color: v })} />
            </div>

            <PolishSlider label="Size" value={Number(props.title_size ?? 72)} min={24} max={140} suffix="px" onChange={(v) => setP({ title_size: v })} />
            <PolishSlider label="Background padding" value={Number(props.title_bg_padding ?? 28)} min={0} max={64} suffix="px" onChange={(v) => setP({ title_bg_padding: v })} />
            <PolishSlider label="Vertical position" value={Number(props.title_y_pos ?? 15)} min={5} max={85} suffix="% from top" onChange={(v) => setP({ title_y_pos: v })} />
            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: -4, marginBottom: 10, lineHeight: 1.4 }}>
              Tip: keep the title in the top third (~10–25%) so it doesn't fight the burned captions which sit center / bottom.
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, cursor: 'pointer' }}>
              <input className="nodrag"
                type="checkbox"
                checked={!!props.title_uppercase}
                onChange={(e) => setP({ title_uppercase: e.target.checked })}
              />
              <span style={{ fontSize: 11.5 }}>UPPERCASE</span>
            </label>
          </>
        )}
      </PolishSection>

      {/* Captions (ZapCap) ─────────────────────────────────────────────── */}
      <PolishSection icon={Captions} title="Captions">
        <SectionEnable
          label="Burn captions onto the video"
          checked={props.captions_enabled !== false}
          onChange={(v) => setP({ captions_enabled: v })}
        />
        {props.captions_enabled !== false && (
          <>
            {props.caption_template_name && (
              <div style={{
                marginBottom: 10, padding: '8px 10px', borderRadius: 6,
                background: 'rgba(46,204,113,0.08)', border: '1px solid rgba(46,204,113,0.30)',
                fontSize: 11.5, color: 'var(--text)',
              }}>
                <span style={{ color: 'var(--muted)' }}>Selected style: </span>
                <strong>{props.caption_template_name}</strong>
              </div>
            )}
            <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.45 }}>
              Pick a caption style. ZapCap renders word-by-word burned captions in this style. Style position is handled by the template (most are bottom-center) — see Title section above to keep your title and captions from overlapping.
            </div>
            <ZapcapTemplatePicker
              selectedId={props.caption_template_id || ''}
              onChange={(t) => setP({ caption_template_id: t.id, caption_template_name: t.name })}
            />
          </>
        )}
      </PolishSection>

      {/* Logo / Watermark ──────────────────────────────────────────────── */}
      <PolishSection icon={ImageIcon} title="Logo / Watermark">
        <SectionEnable
          label="Show a logo / watermark on the video"
          checked={(props.watermark_position || 'br') !== 'none'}
          onChange={(v) => setP({ watermark_position: v ? (props.watermark_position_remembered || 'br') : 'none', watermark_position_remembered: v ? undefined : (props.watermark_position || 'br') })}
        />
        {(props.watermark_position || 'br') !== 'none' && (
          <>
            <PolishLogoUpload
              uploadedUrl={props.watermark_image_url}
              upstreamUrl={upstreamLogo}
              profileId={data?._ctxProfileId}
              onChange={(url) => setP({ watermark_image_url: url || null })}
            />

            <div style={labelStyle}>Position</div>
            {/* Visual 2x2 corner picker. The active corner is highlighted
                inside a phone-shaped frame so the user can see exactly
                where the logo lands. */}
            <div style={{
              position: 'relative', width: '100%', aspectRatio: '9/16', maxHeight: 140,
              margin: '0 auto 10px', borderRadius: 10,
              background: 'linear-gradient(135deg, var(--surface-2), var(--surface-3, var(--surface-2)))',
              border: '1px solid var(--border)', overflow: 'hidden',
            }}>
              {[
                { id: 'tl',      top: 6,  left: 6  },
                { id: 'tr',      top: 6,  right: 6 },
                { id: 'bl',      bottom: 6, left: 6  },
                { id: 'br',      bottom: 6, right: 6 },
                // Centered horizontally near the bottom but lifted ~18%
                // off the bottom edge so it sits above the social-UI
                // caption / handle band that TikTok and IG Reels stamp
                // over the frame. Visual position in the preview is
                // intentionally rounded to "18% from bottom" so the
                // user can see roughly where it'll land.
                { id: 'bc-safe', bottom: '18%', left: 'calc(50% - 14px)', title: 'Bottom-center, above social UI' },
              ].map((p) => {
                const on = (props.watermark_position || 'br') === p.id
                return (
                  <button
                    key={p.id} type="button"
                    onClick={() => setP({ watermark_position: p.id })}
                    title={p.title || `Place at ${p.id.toUpperCase()}`}
                    style={{
                      position: 'absolute',
                      top: p.top, left: p.left, right: p.right, bottom: p.bottom,
                      width: 28, height: 28, borderRadius: 6,
                      border: `1px solid ${on ? '#f59e0b' : 'var(--border)'}`,
                      background: on ? '#f59e0b' : 'rgba(255,255,255,0.06)',
                      color: on ? '#fff' : 'var(--muted)', cursor: 'pointer',
                      display: 'grid', placeItems: 'center',
                      fontSize: 14, fontWeight: 700,
                    }}
                  >{on ? '●' : ''}</button>
                )
              })}
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--muted)', fontSize: 10, fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', pointerEvents: 'none' }}>
                Video frame
              </div>
            </div>

            <PolishSlider
              label="Logo size"
              value={Number(props.watermark_size_pct ?? 25)}
              min={4} max={40} suffix="% of video width"
              onChange={(v) => setP({ watermark_size_pct: v })}
            />
            <PolishSlider
              label="Opacity"
              value={Math.round((props.watermark_opacity ?? 1) * 100)}
              min={20} max={100} suffix="%"
              onChange={(v) => setP({ watermark_opacity: v / 100 })}
            />
            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: -2, lineHeight: 1.4 }}>
              Lower opacity reads as a subtle watermark instead of a hard logo stamp.
            </div>
          </>
        )}
      </PolishSection>

      {/* Music ─────────────────────────────────────────────────────────── */}
      <PolishSection icon={Mic} title="Background music">
        <SectionEnable
          label="Mix background music under the voice"
          checked={(props.music_volume ?? 0.15) > 0}
          onChange={(v) => setP({
            music_volume: v ? (props.music_volume_remembered ?? 0.15) : 0,
            music_volume_remembered: v ? undefined : (props.music_volume ?? 0.15),
          })}
        />
        {(props.music_volume ?? 0.15) > 0 && (
          <>
            {/* Music source dropdown.
                Modes:
                  - 'library': pick a specific track from the brand's
                    music library (default when tracks exist)
                  - 'random': randomly pick one track per render
                  - 'custom': fall back to the per-node mp3 uploader for
                    one-off / experimental tracks
                Library mode + a non-empty music_tracks_cache + a track
                id = run() uses that specific URL. Random mode = run()
                picks a fresh track each invocation. */}
            {(() => {
              const tracks = Array.isArray(data?._ctxMusicTracks) ? data._ctxMusicTracks : []
              const mode = props.music_mode || (tracks.length > 0 ? 'library' : 'custom')
              return (
                <>
                  <div style={labelStyle}>Track source</div>
                  <select
                    className="select nodrag"
                    value={mode === 'library' ? (props.music_track_id || 'library:any')
                      : mode === 'random' ? 'random'
                      : 'custom'}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === 'random') setP({ music_mode: 'random', music_track_id: null })
                      else if (v === 'custom') setP({ music_mode: 'custom', music_track_id: null })
                      else if (v === 'library:any' && tracks[0]) setP({ music_mode: 'library', music_track_id: tracks[0].id })
                      else setP({ music_mode: 'library', music_track_id: v })
                    }}
                    onClick={(e) => e.stopPropagation()}
                    style={{ padding: '6px 8px', fontSize: 12, marginBottom: 10, width: '100%' }}
                  >
                    {tracks.length > 0 && (
                      <optgroup label="From brand library">
                        {tracks.map((t) => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                        <option value="random">🎲 Randomize across all library tracks</option>
                      </optgroup>
                    )}
                    <option value="custom">Upload a one-off track…</option>
                  </select>
                  {tracks.length === 0 && (
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.4 }}>
                      No brand tracks yet. Add them in <strong>Profiles → Music library</strong> to use a saved track or randomize across them.
                    </div>
                  )}
                  {mode === 'random' && tracks.length > 0 && (
                    <div style={{ fontSize: 10.5, color: '#0ea5e9', marginBottom: 8, padding: '6px 8px', background: 'rgba(14,165,233,0.10)', border: '1px solid rgba(14,165,233,0.30)', borderRadius: 6 }}>
                      Each render will pick a random track from your {tracks.length}-track library.
                    </div>
                  )}
                  {mode === 'custom' && (
                    <PolishMusicUpload
                      uploadedUrl={props.music_url}
                      uploadedName={props.music_file_name}
                      upstreamUrl={upstreamMusic}
                      profileId={data?._ctxProfileId}
                      onChange={(url, meta) => setP({
                        music_url: url || null,
                        music_file_name: meta?.name || null,
                        music_size_bytes: meta?.size ?? null,
                      })}
                    />
                  )}
                </>
              )
            })()}

            <div style={labelStyle}>Quick volume</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginBottom: 12 }}>
              {[
                { id: 'sub',  label: 'Subtle',     pct: 8  },
                { id: 'low',  label: 'Low',        pct: 15 },
                { id: 'med',  label: 'Medium',     pct: 25 },
                { id: 'high', label: 'High',       pct: 40 },
              ].map((p) => {
                const cur = Math.round((Number(props.music_volume ?? 0.15)) * 100)
                const on = cur === p.pct
                return (
                  <button
                    key={p.id} type="button"
                    onClick={() => setP({ music_volume: p.pct / 100 })}
                    style={{
                      padding: '6px 4px', borderRadius: 6, fontSize: 10.5,
                      border: `1px solid ${on ? '#0ea5e9' : 'var(--border)'}`,
                      background: on ? 'rgba(14,165,233,0.16)' : 'var(--surface-2)',
                      color: on ? '#0ea5e9' : 'var(--text-soft)',
                      cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700,
                    }}
                    title={`Set music volume to ${p.pct}%`}
                  >{p.label}<br /><span style={{ fontSize: 9, opacity: 0.7 }}>{p.pct}%</span></button>
                )
              })}
            </div>

            <MusicMixPreview
              videoUrl={upstreamVideo}
              musicUrl={props.music_url || upstreamMusic}
              volume={Number(props.music_volume ?? 0.15)}
              fadeSecs={Number(props.music_fade_secs ?? 1.0)}
              onChange={(v) => setP({ music_volume: v })}
              onChangeFade={(v) => setP({ music_fade_secs: v })}
            />
            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6, lineHeight: 1.45 }}>
              The track is automatically trimmed to the video's length and faded out over the last {(props.music_fade_secs ?? 1.0).toFixed(1)}s.
            </div>
          </>
        )}
      </PolishSection>
    </>
  )
}

// ─── SCHEDULE POST (Upload-Post API) ───────────────────────────────────────
// `cap` = effective caption character limit per platform. We send the
// same description to all selected platforms (Upload-Post takes one
// string), so the *minimum* of the selected caps is the safe upper
// bound. Anything past gets truncated by the platform on its end.
// `kinds` controls which post types each platform can accept. Used
// by the schedule_post picker to gate platforms when the upstream
// chain is a text-only post (only X / Threads / Facebook / LinkedIn
// support text posts on Upload-Post). TikTok / Instagram / YouTube
// / Pinterest never accept text-only posts.
const SCHEDULE_PLATFORMS = [
  { id: 'tiktok',    label: 'TikTok',    kinds: ['video'],                  cap: 2200 },
  { id: 'instagram', label: 'Instagram', kinds: ['image', 'video'],         cap: 2200 },
  { id: 'youtube',   label: 'YouTube',   kinds: ['video'],                  cap: 5000 },
  { id: 'x',         label: 'X',         kinds: ['image', 'video', 'text'], cap: 280  },
  { id: 'threads',   label: 'Threads',   kinds: ['image', 'video', 'text'], cap: 500  },
  { id: 'linkedin',  label: 'LinkedIn',  kinds: ['image', 'video', 'text'], cap: 3000 },
  { id: 'facebook',  label: 'Facebook',  kinds: ['image', 'video', 'text'], cap: 63206 },
  { id: 'pinterest', label: 'Pinterest', kinds: ['image', 'video'],         cap: 500  },
]

function SchedulePostBody({ data, onPatch }) {
  const props = data.props || {}
  const platforms = Array.isArray(props.platforms) ? props.platforms : []
  const out = data.output
  const connected = Array.isArray(data._ctxConnectedPlatforms) ? data._ctxConnectedPlatforms : []
  const brandSchedule = data._ctxBrandSchedule || null
  const profileId = data._ctxProfileId
  const when = props.when || 'now'
  // Detect a text-only post upstream. When true, the picker hides
  // every platform that can't accept text (TikTok / Instagram /
  // YouTube / Pinterest) and trims any of those out of the saved
  // selection so a stale graph doesn't leave invalid platforms in
  // place after switching from a video chain to a text chain.
  const isTextChain = !!data._ctxUpstreamIsTextPost
  useEffect(() => {
    if (!isTextChain || !platforms.length) return
    const validIds = new Set(SCHEDULE_PLATFORMS.filter((p) => p.kinds.includes('text')).map((p) => p.id))
    const trimmed = platforms.filter((id) => validIds.has(id))
    if (trimmed.length !== platforms.length) onPatch({ platforms: trimmed })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTextChain])

  const togglePlatform = (id) => {
    if (!connected.includes(id)) return  // hard-gated, button is disabled too
    // For text-only upstream chains, hard-gate platforms that don't
    // accept text. Without this the user could toggle (eg) TikTok on
    // and hit a confusing "TikTok can't accept text content" error
    // at run time.
    if (isTextChain) {
      const def = SCHEDULE_PLATFORMS.find((p) => p.id === id)
      if (!def || !def.kinds.includes('text')) return
    }
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
      {data._ctxIsTrialing && <TrialLockNotice feature="Schedule / publish post" />}
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
        {isTextChain && (
          <div style={{
            fontSize: 10, color: 'var(--muted)', marginBottom: 6, lineHeight: 1.4,
          }}>
            Only platforms that allow text-only posts are available because a Text post step is connected upstream.
          </div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {SCHEDULE_PLATFORMS.map((p) => {
            const on = platforms.includes(p.id)
            const textCompat = !isTextChain || p.kinds.includes('text')
            const enabled = connected.includes(p.id) && textCompat
            const disabledReason = !connected.includes(p.id)
              ? 'Not connected — link this platform on the Schedule page first.'
              : !textCompat
                ? `${p.label} doesn't accept text-only posts.`
                : ''
            return (
              <button
                key={p.id}
                type="button"
                disabled={!enabled}
                title={disabledReason}
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
        <select className="nodrag" style={tinyInput} value={when} onChange={(e) => onPatch({ when: e.target.value })}>
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
      {/* Submission summary. Multi-clip fan-out emits submissions[] —
          one row per post — so the user can verify each clip landed
          in the queue at the right time. Single-clip falls back to
          the legacy flat {request_id, scheduled_iso} shape. */}
      {Array.isArray(out?.submissions) && out.submissions.length > 0 ? (
        <div style={{ ...previewBox, marginTop: 8, padding: '8px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ display: 'inline-grid', placeItems: 'center', width: 18, height: 18, borderRadius: 999, background: 'rgba(46,204,113,0.18)', color: '#2ecc71', fontSize: 11, fontWeight: 700 }}>✓</span>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12 }}>
              Submitted {out.submissions.length} {out.submissions.length === 1 ? 'post' : 'posts'}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {out.submissions.map((s, i) => (
              <div key={s.request_id || i} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 11, padding: '4px 6px',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)', borderRadius: 5,
              }}>
                <span style={{
                  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10,
                  color: '#0ea5e9', letterSpacing: '0.04em',
                  minWidth: 42,
                }}>CLIP {i + 1}</span>
                <span style={{ flex: 1, color: 'var(--text-soft)' }}>
                  {s.scheduled_iso
                    ? new Date(s.scheduled_iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                    : <span style={{ color: 'var(--muted)' }}>Publishing now</span>
                  }
                </span>
              </div>
            ))}
          </div>
          {Array.isArray(out.platforms) && out.platforms.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--muted)' }}>
              to {out.platforms.join(', ')}
            </div>
          )}
          {Array.isArray(out.partial_failures) && out.partial_failures.length > 0 && (
            <div style={{
              marginTop: 6, padding: '6px 8px', fontSize: 10.5,
              background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.35)',
              borderRadius: 5, color: 'var(--red)',
            }}>
              {out.partial_failures.length} clip{out.partial_failures.length === 1 ? '' : 's'} failed —
              first: {out.partial_failures[0].error?.slice(0, 80)}
            </div>
          )}
        </div>
      ) : out?.request_id && (
        <div style={{ ...previewBox, marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ display: 'inline-grid', placeItems: 'center', width: 18, height: 18, borderRadius: 999, background: 'rgba(46,204,113,0.18)', color: '#2ecc71', fontSize: 11, fontWeight: 700 }}>✓</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12 }}>Submitted</div>
            {out.scheduled_iso && (
              <div style={{ marginTop: 1, fontSize: 11, color: 'var(--text-soft)' }}>
                {new Date(out.scheduled_iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </div>
            )}
            {Array.isArray(out.platforms) && out.platforms.length > 0 && (
              <div style={{ marginTop: 2, fontSize: 10.5, color: 'var(--muted)' }}>
                to {out.platforms.join(', ')}
              </div>
            )}
          </div>
        </div>
      )}
      {data.status === 'failed' && <NodePreview status="failed" error={data.error} />}
      {data.status === 'running' && <NodePreview status="running" />}
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
        <select className="nodrag" style={tinyInput} value={mode} onChange={(e) => onPatch({ mode: e.target.value })}>
          <option value="post">Post bundle (text + media)</option>
          <option value="avatar_video">Avatar video (photo + script/audio)</option>
        </select>
      </NodeField>
      <NodeField label="Title (optional)">
        <input className="nodrag" style={tinyInput} placeholder="Auto-derived from script" value={data.props?.title || ''} onChange={(e) => onPatch({ title: e.target.value })} />
      </NodeField>
      {mode === 'avatar_video' && (
        <div style={{ marginTop: 4, padding: '8px 10px', background: 'rgba(14,165,233,0.12)', border: '1px solid rgba(14,165,233,0.4)', borderRadius: 6, fontSize: 11, color: '#0ea5e9', lineHeight: 1.45 }}>
          Wire a photo (image_upload, image_gen, or brand logo) + script + optional Avatar voice. Creates a talking photo from the image and renders the script. Voice falls back to the brand's default if not provided.
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
        <input className="nodrag" style={tinyInput} placeholder="Auto-derived" value={data.props?.title || ''} onChange={(e) => onPatch({ title: e.target.value })} />
      </NodeField>
      <NodeField label="Status">
        <select className="nodrag" style={tinyInput} value={data.props?.status || 'draft'} onChange={(e) => onPatch({ status: e.target.value })}>
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
//
// ⚠️  WHEN ADDING A NEW NODE TYPE HERE:
//     Also add a matching runner to NODE_RUNNERS in
//     worker/workflow-runner.js using the SAME key. The server-side
//     workflow executor (Vercel cron → Fly worker) walks the same
//     graph the browser does; without a server runner the node fails
//     on every auto_run server fire with "Server runs don't support
//     node type X yet". Treat the browser run() and server runner
//     as one contract — ship them together.
export const NODE_REGISTRY = {
  text_input: {
    // Marked free=true: zero API/credit cost. The runner is safe to
    // auto-execute uncached free nodes during 'Run this node only' so
    // a cached upstream chain can flow through aggregators (collection,
    // combine, picker) without forcing the user to manually re-run them.
    free: true,
    label: 'Text', description: 'Type any text here. Use it for an idea, a topic, a hook, or notes you want other steps to use.',
    icon: Type, category: 'inputs', color: '#94a3b8',
    inputs: [], outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { text: '' },
    Body: TextInputBody,
    run: async ({ data }) => ({ text: data.props?.text || '' }),
  },

  // Reference URL → transcript. Pastes a TikTok / Reel / YouTube URL,
  // resolves to a direct MP4, transcribes via ElevenLabs Scribe, and
  // outputs the transcript so downstream nodes (script_gen mode=remix)
  // can rewrite it in the user's voice. The first run hits the network;
  // subsequent runs return the cached transcript instantly because the
  // /api/reference-videos POST is upsert-on-(profile,url) — same URL
  // never re-transcribes.
  url_reference: {
    label: 'Reference URL',
    description: 'Paste a link to a TikTok, Reel, or YouTube video. We turn the spoken words into text. Connect the Script generator after this and pick Remix to get the same idea rewritten in your own voice.',
    icon: Link2, category: 'inputs', color: '#ec4899',
    inputs: [], outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { source_url: '' },
    Body: UrlReferenceBody,
    run: async ({ data, ctx }) => {
      const url = (data.props?.source_url || '').trim()
      if (!url) throw new Error('Paste a TikTok / Reel / YouTube URL.')
      if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http(s)://')
      const r = await fetch('/api/reference-videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: ctx.profileId,
          source_url: url,
          mode: 'remix_source',
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Reference-video failed (${r.status})`)
      const v = body.video
      if (!v?.transcript) throw new Error('Transcription returned no text. The video may be silent or the URL may not be public.')
      return {
        // text + transcript both populated so pickScript() picks it up
        // automatically when feeding script_gen as a generic input.
        text: v.transcript,
        transcript: v.transcript,
        source_url: v.source_url,
        creator_handle: v.creator_handle || null,
        thumbnail_url: v.thumbnail_url || null,
        duration_secs: v.duration_secs || null,
        reference_video_id: v.id,
      }
    },
  },

  // ── Voice Gen ─────────────────────────────────────────────────────────────
  // Synthesizes audio from a script using the connected avatar's voice
  // (or a per-node override). Supports single AND randomize modes —
  // the body inspects the avatar config and chops the audio for
  // randomize so downstream avatar_render gets pre-chunked audio.
  // The whole point of this node is review-before-render: synthesize
  // cheaply, listen, tune, re-synth as many times as needed, THEN
  // run the (expensive) avatar render against the audio you approved.
  voice_gen: {
    label: 'Voice gen',
    description: 'Turns a written script into spoken audio. Connect a script to this node and you get a voiceover. If an Avatar is connected too, the avatar\'s voice is used. Otherwise, pick any voice from the list. Listen and approve before moving on.',
    icon: Mic, category: 'generators', color: '#22d3ee',
    inputs: [{ id: 'in', label: 'In (script, optional avatar)' }],
    outputs: [{ id: 'out', label: 'Out' }],
    initialProps: {
      // Per-render overrides — when set, override the avatar's stored
      // voice settings for THIS run only. Avatar's saved voice stays
      // untouched.
      voice_settings_override: null,
      voice_model_id_override: null,
      voice_language_override: null,
      // Standalone voice mode (no avatar upstream). Set via the
      // body's voice picker. Used when picker_voice_id is non-null
      // and the upstream bag has no avatar.
      picker_voice_id: null,
      picker_voice_name: null,
      picker_voice_owner: 'shared',
      // Cache key fingerprint of the last successful synth so the
      // body can show "stale" status when upstream changes.
      last_synth_fingerprint: null,
    },
    Body: VoiceGenBody,
    run: async ({ data, inputs, ctx, reportProgress }) => {
      const incoming = inputs?.in
      const avatar = pickAvatarConfig(incoming)
      const script = pickScript(incoming)
      if (!script) throw new Error('Wire in a script (Text or Script generator).')

      // Standalone mode: no avatar wired, fall back to the body's
      // voice picker. If neither is set, surface a clear error.
      const pickerVoiceId = data.props?.picker_voice_id || null
      const pickerVoiceOwner = data.props?.picker_voice_owner || 'shared'
      if (!avatar?.avatar_id && !pickerVoiceId) {
        throw new Error('Pick a voice in the Voice gen node, or wire an Avatar picker upstream.')
      }

      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` }

      // Idempotency: same script + same avatar/voice + same overrides
      // → return cached output. New synth fires only when something
      // material changes upstream OR the user clicks Re-synth from
      // the body.
      const fingerprint = JSON.stringify({
        s: script,
        avatar: avatar?.avatar_id || null,
        voice: avatar?.avatar_id ? null : pickerVoiceId,
        mode: avatar?.mode || 'single',
        look: avatar?.look_id || null,
        vs: data.props?.voice_settings_override || null,
        vm: data.props?.voice_model_id_override || null,
        vl: data.props?.voice_language_override || null,
      })
      // Cache hit paths return the cached audio but ALWAYS augment with
      // the current avatar config — older cached outputs (from before
      // the avatar-passthrough fix) don't have the field, and downstream
      // avatar_render needs it. Spreading data.output last would let a
      // stale missing-avatar field win; spreading first means the
      // explicit avatar key always lands.
      if (
        data.output?.audio?.url &&
        data.output?._fp === fingerprint &&
        avatar?.mode !== 'randomize'
      ) {
        return { ...data.output, ...(avatar ? { avatar } : {}) }
      }
      if (
        Array.isArray(data.output?.audio_chunks) &&
        data.output.audio_chunks.length > 0 &&
        data.output?._fp === fingerprint
      ) {
        return { ...data.output, ...(avatar ? { avatar } : {}) }
      }

      reportProgress?.({ message: `Synthesizing audio (${script.length.toLocaleString()} chars)…` })

      const synthRes = await fetch('/api/avatars/synth-script', {
        method: 'POST', headers,
        body: JSON.stringify({
          profile_id: ctx.profileId,
          // Avatar wins when wired. Otherwise use the body picker.
          ...(avatar?.avatar_id
            ? { avatar_id: avatar.avatar_id }
            : { voice_id: pickerVoiceId, voice_owner: pickerVoiceOwner }),
          script,
          voice_settings: data.props?.voice_settings_override || undefined,
          voice_model_id:  data.props?.voice_model_id_override  || undefined,
          voice_language:  data.props?.voice_language_override  || undefined,
        }),
      })
      const synthText = await synthRes.text()
      let synthBody = null
      try { synthBody = synthText ? JSON.parse(synthText) : {} } catch {
        throw new Error(
          synthRes.status === 504
            ? 'Synth timed out. Try a shorter script or Turbo v2.5.'
            : `Synth response was not JSON (${synthRes.status}). ${synthText.slice(0, 140)}`
        )
      }
      if (!synthRes.ok) throw new Error(synthBody?.error || `Synth failed (${synthRes.status})`)
      if (!synthBody?.audio_url) throw new Error('Synth returned no audio URL — check ELEVENLABS_API_KEY in Vercel env.')

      // Single mode → done with one full audio output. When no avatar
      // is wired (standalone voiceover flow) we skip the
      // randomize-chunking path entirely — there are no images to
      // chunk against. The audio.url is the primary output that
      // downstream Finish video can pick up as a voiceover track.
      const wantsRandomize = !!avatar && avatar.mode === 'randomize'
      const couldAutoRandomize = !!avatar && avatar.mode === 'single' && !avatar.image_id && avatar.look_id
      if (!avatar || (!wantsRandomize && !couldAutoRandomize)) {
        return {
          _fp: fingerprint,
          audio: {
            url: synthBody.audio_url,
            name: 'voice_gen.mp3',
            duration_secs: null,  // Not measured server-side; downstream estimates from duration if needed.
          },
          // Forward the script downstream. Polish's title generator
          // uses this to skip ElevenLabs Scribe (it can title from
          // the script directly). caption_gen and schedule_post also
          // pick up upstream scripts. Without forwarding, polish ends
          // up transcribing whatever audio the polished video happens
          // to have — meaningless when we're muting source audio and
          // overlaying a voiceover.
          script,
          full_script: script,
          // Forward the avatar config when present so a Voice gen →
          // Avatar video wire is sufficient. Omit entirely in
          // standalone mode so downstream nodes don't think we're
          // setting up an avatar render.
          ...(avatar ? { avatar } : {}),
          voice_used: synthBody.voice_used || null,
          script_chars: synthBody.chars || script.length,
        }
      }

      // Randomize mode → chunk the synthesized audio against the look
      // image count so each clip gets a slice of the same continuous take.
      reportProgress?.({ message: 'Slicing audio into clips…' })
      const lookId = avatar.look_id
      if (!lookId) throw new Error('Randomize mode needs a look. Pick one in the Avatar picker.')
      const imgRes = await fetch(`/api/avatars/look-images?look_id=${encodeURIComponent(lookId)}`, { headers })
      const imgBody = await imgRes.json()
      if (!imgRes.ok) throw new Error(imgBody?.error || 'Could not fetch look images')
      const images = (imgBody.images || []).slice().sort((a, b) => (a.order_index || 0) - (b.order_index || 0))
      if (!images.length) throw new Error('Look has no images')

      // Single-image look — fall back to single output even in randomize.
      if (images.length === 1) {
        return {
          _fp: fingerprint,
          audio: {
            url: synthBody.audio_url,
            name: 'voice_gen.mp3',
            duration_secs: null,
          },
          avatar,
          voice_used: synthBody.voice_used || null,
          script_chars: synthBody.chars || script.length,
        }
      }

      const cRes = await fetch('/api/avatars/audio-chunks', {
        method: 'POST', headers,
        body: JSON.stringify({
          audio_url: synthBody.audio_url,
          look_count: images.length,
          profile_id: ctx.profileId,
        }),
      })
      const cBody = await cRes.json().catch(() => ({}))
      if (!cRes.ok) throw new Error(cBody?.error || `Audio chunking failed (${cRes.status})`)
      const chunks = Array.isArray(cBody.chunks) ? cBody.chunks : []
      if (!chunks.length) throw new Error('Audio chunking produced 0 slices.')

      // Pair chunks with images so downstream avatar_render has the
      // assignments ready (no second look-images fetch).
      const audio_chunks = chunks.map((c, i) => ({
        audio_url: c.audio_url,
        sentence: c.sentence || '',
        image_url: images[i % images.length].image_url,
        order: i,
      }))

      return {
        _fp: fingerprint,
        audio_chunks,
        full_audio_url: synthBody.audio_url,
        // Forward the avatar config so downstream Avatar video can
        // resolve voice/owner/avatar_id without a second wire.
        avatar,
        voice_used: synthBody.voice_used || null,
        script_chars: synthBody.chars || script.length,
        chunk_count: audio_chunks.length,
      }
    },
  },

  audio_upload: {
    free: true,
    label: 'Audio', description: 'Upload your own voice recording (MP3, WAV, or M4A). Connect it to an Avatar video so the avatar speaks with your audio instead of a typed script.',
    icon: Mic, category: 'inputs', color: '#22d3ee',
    inputs: [], outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { url: '', name: '' },
    Body: AudioUploadBody,
    run: async ({ data }) => {
      const url = data.props?.url
      if (!url) throw new Error('Upload an audio file first')
      return {
        audio: {
          url,
          name: data.props?.name || '',
          // Duration is captured at upload time in AudioUploadBody so
          // avatar_render can size its chunk count accurately without
          // re-probing.
          duration_secs: Number(data.props?.duration_secs || 0) || null,
        },
      }
    },
  },

  image_upload: {
    free: true,
    label: 'Upload media',
    description: 'Upload your own pictures or vertical videos. Give each one a short name and you can mention it in any prompt by typing @yourname. Connect videos to Finish video to add captions, your logo, and music. If you upload more than one video, each gets its own finished post.',
    icon: Upload, category: 'inputs', color: '#0ea5e9',
    inputs: [], outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { urls: [] },
    Body: ImageUploadBody,
    run: async ({ data }) => {
      const items = readImageItems(data.props).map((it) => ({ kind: it.kind || 'image', url: it.url, name: it.name }))
      const images = items.filter((it) => it.kind !== 'video').map(({ url, name }) => ({ url, name }))
      const videos = items.filter((it) => it.kind === 'video').map(({ url, name }) => ({ url, name }))
      // Backward compat: `images` retains its old shape so any consumer
      // that expects the array still works. `videos` is additive — Finish
      // video already accepts a video_url from upstream so it'll consume
      // these naturally via pickFirstVideoUrl.
      const out = { images }
      if (videos.length) {
        out.videos = videos
        out.video_url = videos[0].url
      }
      return out
    },
  },

  auto_run: {
    label: 'Auto-run', description: 'Runs your whole workflow on a schedule you set (for example, 2 times per day). Set a maximum number of runs so it stops automatically. Keep this page open if you want it to run in the background, or save and let the server run it.',
    icon: Repeat, category: 'inputs', color: '#f97316',
    inputs: [], outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { runs_per_unit: 2, unit: 'day', cadence: '15m', max_runs: 10, runs_used: 0, active: false, last_run_at: null },
    Body: AutoRunBody,
    run: async ({ data }) => ({ tick: new Date().toISOString(), run_index: Number(data.props?.runs_used || 0) + 1 }),
  },

  brand_profile: {
    free: true,
    label: 'Brand profile', description: 'Pulls in one of your saved brands so the rest of the workflow sounds like you. Pick which parts to share: voice, colors, logo, your brand notes, and your hashtags. Turn on "Sync to all" to connect it to every step that needs it.',
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
    label: 'Script generator', description: 'Writes a short script for you from a topic. Just type what the video should be about and it does the rest. You can also mention a brand by typing @brandname to use that brand\'s voice.',
    icon: Wand2, category: 'generators', color: '#ef4444',
    inputs: [{ id: 'in', label: 'In (topic / brand)' }],
    outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { format: 'tiktok-script', topic: '', target_length_secs: 45, mode: 'original' },
    Body: ScriptGenBody,
    run: async ({ data, inputs, inputsByName, ctx }) => {
      const incoming = inputs?.in
      const brand = pickBrand(incoming)
      const mode = data.props?.mode === 'remix' ? 'remix' : 'original'

      // Remix mode: an upstream Reference URL node provided a transcript
      // we rewrite in the user's voice. Look for it in the inputs and
      // pass alongside the rest of the call so the server can flip to
      // the remix system prompt.
      let referenceTranscript = null
      let referenceMeta = null
      if (mode === 'remix') {
        for (const x of (Array.isArray(incoming) ? incoming : [incoming])) {
          if (x && typeof x === 'object' && x.transcript) {
            referenceTranscript = x.transcript
            referenceMeta = {
              source_url: x.source_url || null,
              creator_handle: x.creator_handle || null,
              reference_video_id: x.reference_video_id || null,
            }
            break
          }
        }
        if (!referenceTranscript) {
          throw new Error('Remix mode needs a Reference URL node wired in. Drop one upstream and run it first.')
        }
      }

      let topic = (data.props?.topic || '').trim() || (mode === 'remix' ? '' : pickScript(incoming))
      if (mode !== 'remix' && !topic) throw new Error('No topic / text provided')
      if (topic) topic = expandMentions(topic, inputsByName)
      // @brand-mention takes priority — wires the script gen to that brand
      // profile's bible/voice without needing a brand_profile node.
      const mentioned = resolveBrandMention(topic || '', ctx.profiles)
      const profileId = mentioned?.id || brand?.profile_id || ctx.profileId
      if (topic) topic = stripBrandMentions(topic, ctx.profiles)

      const r = await fetch('/api/content/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: profileId,
          format: data.props?.format || 'tiktok-script',
          structural_format: data.props?.structural_format || null,
          topic: topic || (mode === 'remix' ? `Remix of ${referenceMeta?.creator_handle ? `@${referenceMeta.creator_handle}` : 'reference video'}` : ''),
          count: 1,
          target_length_secs: data.props?.target_length_secs || undefined,
          // Remix payload — server reads these when mode='remix' and
          // swaps to the rewrite system prompt that targets the user's
          // brand voice while preserving the source's hook + structure.
          mode,
          reference_transcript: referenceTranscript || undefined,
          reference_meta: referenceMeta || undefined,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      const item = body.items?.[0]
      if (!item) throw new Error('No item returned')
      return { script: item.full_script || '', title: item.title || '', _content_id: item.id }
    },
  },

  text_post_gen: {
    label: 'Text post',
    description: 'Writes text-only posts for X, Threads, Facebook, and LinkedIn. Type your idea in the Prompt box, pick which platforms you want, and it writes a version that fits each one. You can edit any of them before posting. Connect to Schedule post to publish them all at the same time.',
    icon: Type, category: 'generators', color: '#0ea5e9',
    inputs: [{ id: 'in', label: 'In (prompt / brand)' }],
    outputs: [{ id: 'out', label: 'Out (text post bundle)' }],
    initialProps: {
      prompt: '',       // in-body prompt textarea (overridden by a wired Text node when one is connected)
      platforms: ['x', 'threads', 'facebook', 'linkedin'],
      per_platform: {}, // generated per-platform text, keyed by platform id
      edited: {},       // user overrides keyed by platform id
      // When true (default), use the active brand profile's voice/
      // bible/hashtags even without a brand_profile node wired in.
      // Uncheck to write generic posts that ignore any brand context.
      use_brand: true,
    },
    Body: TextPostGenBody,
    run: async ({ data, inputs, inputsByName, ctx }) => {
      const arr = asArr(inputs?.in)
      const brand = pickBrand(arr)
      const platforms = Array.isArray(data.props?.platforms) ? data.props.platforms : ['x']
      // Prefer the upstream Text node's content (script_gen too). If
      // no wired prompt, fall back to the in-node Prompt textarea.
      let prompt = ''
      for (const v of arr) {
        if (!v) continue
        if (typeof v === 'string') { prompt = v; break }
        if (typeof v !== 'object') continue
        if (typeof v.text === 'string' && v.text.trim()) { prompt = v.text; break }
        if (typeof v.script === 'string' && v.script.trim()) { prompt = v.script; break }
        if (typeof v.full_script === 'string' && v.full_script.trim()) { prompt = v.full_script; break }
      }
      if (!prompt.trim()) prompt = (data.props?.prompt || '').trim()
      if (!prompt.trim()) throw new Error('text_post_gen needs a prompt — type one in the node or wire a Text / Script node into "in".')
      if (!platforms.length) throw new Error('Pick at least one platform.')

      // @-mention expansion (same machinery script_gen uses):
      //   - expandMentions replaces @altTag for any named upstream
      //     node (eg image_upload items) with that node's content
      //   - resolveBrandMention finds an @brandname token that matches
      //     a brand the user has access to; that brand wins over the
      //     wired brand_profile so the user can swap brands inline
      //   - expandBrandMentions then prints the brand's display name
      prompt = expandMentions(prompt, inputsByName)
      const mentioned = resolveBrandMention(prompt, ctx.profiles)
      const profileId = mentioned?.id || brand?.profile_id || ctx.profileId
      prompt = expandBrandMentions(prompt, ctx.profiles)

      // use_brand: true (default) sends profile_id so the API loads
      // the brand bible + voice into the prompt. Wiring a
      // brand_profile node also flips this on regardless of the
      // checkbox so explicit upstream brand always wins.
      const useBrand = (data.props?.use_brand !== false) || !!brand
      const r = await fetch('/api/content/text-post-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({ profile_id: profileId, prompt, platforms, use_brand: useBrand }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Text-post gen failed (${r.status})`)

      // User edits win over fresh AI output (same pattern caption_gen uses).
      const edits = data.props?.edited || {}
      const merged = {}
      for (const p of platforms) {
        merged[p] = (edits[p] && String(edits[p]).trim()) || body.per_platform?.[p] || ''
      }
      // Title / hashtags / first_comment ride alongside the variants so
      // schedule_post has the same fields it expects for image/video
      // posts. The canonical caption falls back to the first variant
      // for any downstream node that wants a single shared string.
      return {
        is_text_post: true,
        platforms,
        per_platform: merged,
        title:         data.props?.edited_title         || body.title         || '',
        hashtags:      data.props?.edited_hashtags      || body.hashtags      || '',
        first_comment: data.props?.edited_first_comment || body.first_comment || '',
        caption: merged[platforms[0]] || '',
      }
    },
  },

  caption_gen: {
    label: 'Title + caption + hashtags', description: 'Writes a catchy title, a caption, and 5 hashtags for your post. Works with a script, an audio voiceover, or your uploaded videos (we listen to the video and write the caption from what was said). If you have multiple videos, each gets its own set of captions.',
    icon: Captions, category: 'generators', color: '#f59e0b',
    inputs: [{ id: 'in', label: 'In (script / chunks / videos / brand)' }],
    outputs: [{ id: 'out', label: 'Out' }],
    initialProps: {},
    Body: CaptionGenBody,
    run: async ({ data, inputs, ctx, reportProgress }) => {
      const incoming = inputs?.in
      const brand = pickBrand(incoming)
      const profileId = brand?.profile_id || ctx.profileId

      // Forward whatever videos came in upstream so downstream nodes
      // (schedule_post, polish) can still find them via pickAllVideoUrls.
      // Without this, wiring Upload media → caption_gen → schedule_post
      // bombs with "Wire a video into in" because caption_gen would
      // otherwise strip everything but the caption text fields.
      const upstreamVideoUrls = pickAllVideoUrls(asArr(incoming))
      const attachVideos = (result) => upstreamVideoUrls.length
        ? { ...result, videos: upstreamVideoUrls.map((url, i) => ({ video_url: url, idx: i })) }
        : result

      // Detect a multi-clip source — voice_gen randomize emits
      // audio_chunks[{ sentence, image_url, order }]. Each chunk's
      // sentence is what gets spoken in that clip, which is exactly
      // what we need for per-clip captions. One Claude call generates
      // N caption sets.
      let chunkSentences = null
      for (const v of asArr(incoming)) {
        if (v && Array.isArray(v.audio_chunks) && v.audio_chunks.length > 1) {
          const arr = v.audio_chunks
            .map((c, i) => ({ idx: i, order: c.order ?? i, text: String(c.sentence || '').trim() }))
            .filter((c) => c.text)
          if (arr.length > 1) { chunkSentences = arr; break }
        }
      }
      if (chunkSentences) {
        return attachVideos(await runMultiCaption({ ctx, profileId, chunkSentences, edits: data.props }))
      }

      // Script-bearing input wins over raw videos when both are
      // present. pickScript walks the bag for any { script | text |
      // full_script | caption } shape.
      const script = pickScript(incoming)

      // Video-only fallback: if no script / chunks but we DO have
      // videos in the bag (Upload media output, Collection of videos,
      // avatar_render output), transcribe each via the auto-title
      // endpoint with transcript_only=true, then route through the
      // same multi-caption fan-out.
      //
      // Concurrency 2 (not all-N-parallel). Each auto-title call
      // downloads the video bytes + hits ElevenLabs Scribe — both
      // memory-hungry and bandwidth-hungry. Running 5+ in parallel
      // empirically OOMs the Vercel function or trips Scribe's
      // per-key rate limit, surfacing as a 500 with empty body.
      if (!script) {
        const videoUrls = pickAllVideoUrls(asArr(incoming))
        if (videoUrls.length > 0) {
          reportProgress?.({ message: `Transcribing ${videoUrls.length} video${videoUrls.length === 1 ? '' : 's'}…`, done: 0, total: videoUrls.length })
          const sess = ctx.token
          let done = 0

          // Single-attempt fetch with full error capture. Reads body
          // as text first so we can surface HTML/empty-body Vercel
          // intercepts ("FUNCTION_INVOCATION_TIMEOUT" pages) instead
          // of swallowing them into a bare 500.
          const transcribeOnce = async (url, i) => {
            const r = await fetch('/api/videos/auto-title', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sess}` },
              body: JSON.stringify({
                profile_id: profileId,
                video_url: url,
                transcript_only: true,
              }),
            })
            const txt = await r.text()
            let body = null
            try { body = txt ? JSON.parse(txt) : null } catch {}
            if (!r.ok) {
              // Body parse failed → surface raw status text. Vercel
              // timeout pages are HTML so JSON.parse drops them.
              const msg = body?.error
                || (txt && txt.length < 200 ? txt.trim() : null)
                || `HTTP ${r.status}${r.statusText ? ' ' + r.statusText : ''}`
              const err = new Error(msg)
              err.status = r.status
              throw err
            }
            return { idx: i, order: i, text: String(body?.transcript || '').trim(), source_url: url }
          }

          // Concurrency 2 + retry-once on 5xx. The retry helps the
          // Scribe-cold-start case where the FIRST hit times out but
          // a follow-up 3s later succeeds.
          const transcribeWithRetry = async (url, i) => {
            try { return await transcribeOnce(url, i) }
            catch (e) {
              if (e?.status && e.status >= 500) {
                await new Promise((res) => setTimeout(res, 2500))
                try { return await transcribeOnce(url, i) }
                catch (e2) {
                  return { idx: i, order: i, text: '', source_url: url, error: e2?.message || String(e2) }
                }
              }
              return { idx: i, order: i, text: '', source_url: url, error: e?.message || String(e) }
            } finally {
              done += 1
              reportProgress?.({ message: `Transcribed ${done} of ${videoUrls.length}`, done, total: videoUrls.length })
            }
          }

          const TRANSCRIBE_CONCURRENCY = 2
          const transcripts = new Array(videoUrls.length)
          let tCursor = 0
          const tWorkers = Array.from({ length: Math.min(TRANSCRIBE_CONCURRENCY, videoUrls.length) }, async () => {
            while (tCursor < videoUrls.length) {
              const i = tCursor++
              transcripts[i] = await transcribeWithRetry(videoUrls[i], i)
            }
          })
          await Promise.all(tWorkers)
          // Lower threshold than 30 chars — catches short clips like
          // "Hey, watch this." that previous code silently dropped.
          // Anything under 10 is probably audio-less / noise-only and
          // wouldn't give Claude enough to work with.
          const valid = transcripts.filter((c) => c.text.length >= 10)
          if (!valid.length) {
            const errs = transcripts.map((c) => c.error).filter(Boolean).slice(0, 2).join('; ')
            throw new Error(`No usable transcripts from ${videoUrls.length} videos${errs ? ` — ${errs}` : ''}.`)
          }
          // Single-video shortcut: only when there's literally one video
          // in the bag (not "1 valid out of 5") — otherwise we'd hide
          // the failed clips from the user.
          if (valid.length === 1 && videoUrls.length === 1) {
            return attachVideos(await runSingleCaptionFromScript({ ctx, profileId, script: valid[0].text, edits: data.props }))
          }
          // Run Claude on the valid set, then pad captions[] back to
          // videoUrls.length with placeholders for the failed ones.
          // Without this padding the body pagination + schedule_post
          // clip↔caption matching would silently shrink to the valid
          // count (e.g. uploaded 5 → only 2 had usable transcripts →
          // body shows "CLIP 2 OF 2", schedule_post posts 2 of 5).
          const aiResult = await runMultiCaption({ ctx, profileId, chunkSentences: valid, edits: data.props })
          const aiByIdx = new Map((aiResult.captions || []).map((c) => [c.idx, c]))
          const fullCaptions = transcripts.map((t) => {
            const ai = aiByIdx.get(t.idx)
            if (ai) return { ...ai, source_url: t.source_url }
            return {
              order: t.order,
              idx: t.idx,
              title: '',
              caption: '',
              hashtags: '',
              first_comment: '',
              source_url: t.source_url,
              transcript_failed: true,
              error: t.error || 'No usable transcript (too short or no audio)',
            }
          })
          return attachVideos({
            ...aiResult,
            captions: fullCaptions,
            chunk_count: fullCaptions.length,
            partial_failures: fullCaptions.filter((c) => c.transcript_failed).map((c) => ({
              clip_index: c.idx, source_url: c.source_url, error: c.error,
            })),
          })
        }
        throw new Error('Wire a script (Text / script_gen / voice_gen) or videos (Upload media / Collection / avatar_render) into "in".')
      }

      // Single-script path — extracted into runSingleCaptionFromScript
      // so video-only callers (above) can reuse it for the 1-video case.
      return attachVideos(await runSingleCaptionFromScript({ ctx, profileId, script, edits: data.props }))
    },
  },

  image_gen: {
    label: 'Image generator', description: 'Creates pictures from a text prompt. Choose how many you want, the shape (vertical, square, wide), and the quality. You can also connect reference images and a brand profile so the picture matches your style.',
    icon: ImageIcon, category: 'generators', color: '#a855f7',
    inputs: [{ id: 'in',  label: 'In (prompt / brand / refs)' }],
    outputs: [{ id: 'out', label: 'Out' }],
    initialProps: { prompt: '', model: 'nano-banana-2', aspect: '1:1', count: 1, quality: '2K', enhance_prompt: true },
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
      // Expose @brand-logo as a virtual reference whenever the active brand
      // has a logo — matches the autocomplete chip injected by Spaces.jsx.
      if (brand?.logo_url) {
        namedImages.push({ url: brand.logo_url, name: 'brand-logo' })
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

      // KIE's image_input field caps at 8 references. Trim defensively and
      // log a warning if we'd otherwise exceed. Earlier @-mention matches
      // win because they're in user-prompt order; the fallback "all
      // upstream images" path and the brand logo come last and are the
      // first to get dropped if we're over.
      if (refs.length > 8) {
        const dropped = refs.length - 8
        // eslint-disable-next-line no-console
        console.warn(`[image_gen] Trimmed ${dropped} reference image(s) — KIE accepts max 8.`, refs.slice(8))
        refs = refs.slice(0, 8)
      }

      // Strip @-mentions from the prompt before sending to KIE — image
      // models don't parse them and the raw "@image1" text confuses
      // Gemini-based providers. We've already pulled the matching URLs
      // into `refs`, so rewrite each token to the labeled reference and
      // capture the ordered set of labels for the directive block below.
      const refLabels = []  // labels in the order they appear in the prompt
      prompt = prompt.replace(/@(?:"([^"]+)"|([A-Za-z0-9_-]+))/g, (_, q, b) => {
        const name = (q || b || '').trim()
        if (name && !refLabels.includes(name)) refLabels.push(name)
        return name ? `reference "${name}"` : 'the reference image'
      })

      // When references are present, prepend a structured REFERENCE
      // DIRECTIVE block. Image models (Nano Banana, GPT image, etc.)
      // treat the refs array as a flat conditioning set, so without an
      // explicit directive they tend to (a) blend identities across
      // refs and (b) replicate any text/watermarks/signatures baked
      // into the source images. The directive binds each labeled ref
      // to its role and bans watermark leakage. The api enhance step
      // is told to preserve this block verbatim.
      if (refs.length) {
        // Only ban watermark/text reproduction when the user did NOT
        // explicitly ask for one. If they want a watermark or text
        // overlay in the output we should let the model produce it.
        const userWantsTextLayer = /\b(watermark|signature|logo|caption|text overlay|caption text|subtitles?|on-?screen text|name plate|sticker)\b/i.test(prompt)
        const lines = ['REFERENCE DIRECTIVE']
        if (refLabels.length) {
          lines.push('Labeled reference images (resolve any "reference \\"X\\"" mention to the matching label):')
          refLabels.forEach((label, i) => lines.push(`  ${i + 1}. "${label}"`))
        } else {
          lines.push(`Reference images provided (in order): ${refs.length}.`)
        }
        lines.push('')
        lines.push('Rules:')
        lines.push('• When the prompt says "use [attribute] from reference \\"X\\"", pull ONLY that attribute from that reference. Do not pull other attributes from it.')
        lines.push('• Person identity (face, skin tone, hair, body shape, build) is locked to whichever reference the prompt names for it. Do not blend identities across references.')
        if (userWantsTextLayer) {
          lines.push('• The user has explicitly asked for a watermark, signature, logo, or text overlay. Honor that request. You MAY add the requested text/branding, but only as instructed in the body of the prompt below — not by copying any unrelated text or branding from reference images.')
        } else {
          lines.push('• Do NOT reproduce watermarks, signatures, logos, captions, or any text overlays that appear in any reference image. The output must be clean, with no copied branding from the references.')
        }
        prompt = `${lines.join('\n')}\n\n---\n\n${prompt}`
      }

      const profileForCall = brand?.profile_id || ctx.profileId
      const requestedCount = Math.max(1, Math.min(8, Number(data.props?.count) || 1))

      // Single submit + poll. KIE's `num_images` field is unreliable across
      // model families (Nano Banana Pro routinely returns 1 image even with
      // num_images=4), so we run N parallel tasks of count=1 instead. Each
      // submission gets its own taskId and pollable status.
      const submitOne = async () => {
        const submitR = await fetch('/api/images/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
          body: JSON.stringify({
            profile_id: profileForCall,
            prompt,
            model: data.props?.model || 'nano-banana',
            count: 1,
            aspect: data.props?.aspect || '1:1',
            quality: data.props?.quality || '2K',
            reference_urls: refs.length ? refs : undefined,
            enhance_prompt: data.props?.enhance_prompt ?? true,
          }),
        })
        const submit = await submitR.json()
        if (!submitR.ok) throw new Error(submit.error || `Failed (${submitR.status})`)
        const taskId = submit.taskId
        if (!taskId) throw new Error('No taskId returned')
        return taskId
      }

      const pollOne = async (taskId) => {
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
            if (s.state === 'success') return s.images || []
            if (s.state === 'failed') throw new Error(s.error || 'Generation failed')
          } catch (e) {
            consecutiveErrors++
            if (consecutiveErrors >= 3) throw e
          }
        }
        throw new Error('Image generation timed out after 12 minutes — KIE may still be processing; try again or check the dashboard.')
      }

      // Submit all N tasks in parallel and poll each for its result. If
      // any task fails, surface its error but include images from the
      // tasks that did succeed (better than dropping the whole batch).
      const taskIds = await Promise.all(
        Array.from({ length: requestedCount }, () => submitOne())
      )
      const results = await Promise.allSettled(taskIds.map(pollOne))
      const collected = []
      const errors = []
      for (const r of results) {
        if (r.status === 'fulfilled') {
          for (const im of r.value) collected.push(im)
        } else {
          errors.push(r.reason?.message || String(r.reason))
        }
      }
      if (collected.length === 0) {
        throw new Error(errors[0] || 'Generation failed')
      }
      return { images: collected }
    },
  },

  avatar_picker: {
    free: true,
    label: 'Avatar', description: 'Pick which avatar to use and which look (outfit / angle set). Choose a single image for a clean fixed shot, or Randomize to use every image in the look so the video shows different angles. Turn on Cycle looks to rotate between different looks each time the workflow runs.',
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
    label: 'Avatar video', description: 'Makes a talking video of your avatar. Connect a voiceover or a script and you\'ll get a short video where the avatar speaks it. If your Avatar uses Randomize, you\'ll get one short clip per image — connect Stitch videos after this to combine them into one.',
    icon: FileVideo, category: 'generators', color: '#ef4444',
    inputs: [{ id: 'in',  label: 'In (avatar + audio / script)' }],
    outputs: [{ id: 'out', label: 'Out' }],
    initialProps: {},
    Body: AvatarRenderBody,
    run: async ({ data, inputs, ctx, reportProgress }) => {
      // Trial users CAN run this once — the server forces V4 + 30s
      // duration + ScaleSolo watermark. The credit wall (5 trial
      // credits = 1 × 30s render) stops a second attempt and pops
      // the upgrade modal automatically.
      const incoming = inputs?.in
      const avatar = pickAvatarConfig(incoming)
      if (!avatar?.avatar_id) throw new Error('Connect an Avatar picker')
      // voice_gen pre-chunks audio for randomize mode — when present,
      // we skip our own audio-chunks call and use the assignments
      // verbatim (each chunk already paired with a look image upstream).
      const preChunkedAudio = pickAudioChunks(incoming)
      const audio = pickAudio(incoming)
      const script = (audio || preChunkedAudio) ? '' : pickScript(incoming)
      if (!audio && !preChunkedAudio && !script) {
        throw new Error('Wire in a script (text/script_gen), an audio file, or a Voice gen output.')
      }

      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` }

      // Pre-chunked path: voice_gen already synthesized + sliced the
      // audio for a randomize avatar. Each chunk has audio_url +
      // image_url paired. Fan out N parallel HeyGen renders using
      // those assignments — no script-split, no audio-chunks call.
      if (preChunkedAudio) {
        const total = preChunkedAudio.length
        let done = 0
        reportProgress?.({ done: 0, total, message: `Rendering 0 of ${total} clips…` })
        const settled = await Promise.allSettled(preChunkedAudio.map(async (a) => {
          const r = await fetch('/api/avatars/photo-render', {
            method: 'POST', headers,
            body: JSON.stringify({
              profile_id: ctx.profileId,
              photo_url: a.image_url,
              audio_url: a.audio_url,
              avatar_id: avatar.avatar_id,
            }),
          })
          const body = await r.json()
          if (!r.ok) {
            // Enrich 402 / insufficient_credits errors with the
            // required + have numbers so the top-up modal can
            // display them.
            const err = new Error(body?.error || `Render submit failed (${r.status})`)
            if (r.status === 402 || body?.code === 'insufficient_credits') {
              err.code = 'insufficient_credits'
              err.required = body?.required
              err.have = body?.have
            }
            throw err
          }
          const videoId = body.video_id
          if (!videoId) throw new Error('No video id')
          const start = Date.now()
          while (Date.now() - start < 480_000) {
            if (ctx.shouldAbort?.()) throw new Error('Stopped')
            await new Promise((res) => setTimeout(res, 6000))
            const sR = await fetch(`/api/avatars/photo-render-status?video_id=${encodeURIComponent(videoId)}`, { headers })
            const s = await sR.json()
            if (!sR.ok) throw new Error(s.error || `Status failed (${sR.status})`)
            if (s.state === 'success') {
              done += 1
              reportProgress?.({ done, total, message: `Rendered ${done} of ${total} clips` })
              return { video_url: s.video_url, order: a.order, image_url: a.image_url, sentence: a.sentence || '', audio_chunk_url: a.audio_url }
            }
            if (s.state === 'failed') throw new Error(s.error || 'Render failed')
          }
          throw new Error('Render timed out')
        }))
        const clips = []
        const failures = []
        for (let i = 0; i < settled.length; i++) {
          if (settled[i].status === 'fulfilled') clips.push(settled[i].value)
          else failures.push({ clip_index: i, error: settled[i].reason?.message || String(settled[i].reason) })
        }
        if (!clips.length) throw new Error(`All ${preChunkedAudio.length} clips failed. First error: ${failures[0]?.error || 'unknown'}`)
        return {
          videos: clips,
          media_type: 'video',
          is_clip_set: true,
          ...(failures.length ? { partial_failures: failures } : {}),
        }
      }

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
      //    look has multiple images. Both script-driven AND audio-
      //    driven flows route here when the avatar has multiple
      //    images — audio just goes through a different chunker.
      const wantsRandomize = avatar.mode === 'randomize'
      const couldAutoRandomize = avatar.mode === 'single' && !avatar.image_id && avatar.look_id
      if (wantsRandomize || couldAutoRandomize) {
        if (!avatar.look_id) throw new Error('Randomize mode needs a look. Pick one in the avatar node.')
        const imgR = await fetch(`/api/avatars/look-images?look_id=${avatar.look_id}`, { headers })
        const imgB = await imgR.json()
        if (!imgR.ok) throw new Error(imgB.error || 'Could not fetch look images')
        const images = (imgB.images || []).slice().sort((a, b) => (a.order_index || 0) - (b.order_index || 0))
        if (!images.length) throw new Error('Look has no images')

        // Single image → can't really chop. Just render one clip.
        if (images.length === 1) {
          const photo = images[0].image_url
          const r = await renderOne({ photo_url: photo, scriptChunk: audio ? '' : script, audioUrl: audio?.url })
          return { video: { video_url: r.video_url, media_type: 'video' } }
        }

        // ── Audio-driven path ────────────────────────────────────────
        // Transcribe with ElevenLabs, balance sentences across the
        // look images, ffmpeg-slice the source audio into one MP3 per
        // bucket, then submit one HeyGen photo render per bucket with
        // its sliced audio_url + the assigned look image.
        if (audio?.url) {
          const TARGET_CLIP_SECS = 7
          const clipsCount = Math.min(
            12,
            Math.max(images.length, Math.ceil((Number(audio.duration_secs) || images.length * TARGET_CLIP_SECS) / TARGET_CLIP_SECS))
          )
          const cR = await fetch('/api/avatars/audio-chunks', {
            method: 'POST', headers,
            body: JSON.stringify({
              audio_url: audio.url,
              look_count: clipsCount,
              profile_id: ctx.profileId,
            }),
          })
          const cBody = await cR.json()
          if (!cR.ok) throw new Error(cBody.error || `Audio chunking failed (${cR.status})`)
          const chunks = Array.isArray(cBody.chunks) ? cBody.chunks : []
          if (!chunks.length) throw new Error('No audio chunks produced — try a longer or clearer take.')

          const assignments = chunks.map((c, i) => ({
            chunk: c,
            image: images[i % images.length],
            order: i,
          }))
          const total = assignments.length
          let done = 0
          reportProgress?.({ done: 0, total, message: `Rendering 0 of ${total} clips…` })
          const settled = await Promise.allSettled(assignments.map(async (a) => {
            const r = await renderOne({ photo_url: a.image.image_url, audioUrl: a.chunk.audio_url })
            done += 1
            reportProgress?.({ done, total, message: `Rendered ${done} of ${total} clips` })
            return {
              video_url: r.video_url,
              order: a.order,
              image_url: a.image.image_url,
              sentence: a.chunk.sentence || '',
              audio_chunk_url: a.chunk.audio_url,
            }
          }))
          const clips = []
          const failures = []
          for (let i = 0; i < settled.length; i++) {
            const s = settled[i]
            if (s.status === 'fulfilled') clips.push(s.value)
            else failures.push({ clip_index: i, error: s.reason?.message || String(s.reason) })
          }
          if (!clips.length) throw new Error(`All ${assignments.length} clips failed. First error: ${failures[0]?.error || 'unknown'}`)
          return {
            videos: clips,
            media_type: 'video',
            is_clip_set: true,
            ...(failures.length ? { partial_failures: failures } : {}),
          }
        }

        // ── Script-driven path (unchanged) ──────────────────────────
        const wordCount = String(script).split(/\s+/).filter(Boolean).length
        const estDurationSecs = Math.max(3, Math.round(wordCount / 2.5))
        const TARGET_CLIP_SECS = 7
        const clipsCount = Math.min(
          12,
          Math.max(images.length, Math.ceil(estDurationSecs / TARGET_CLIP_SECS))
        )
        const sp = await fetch('/api/scripts/split', {
          method: 'POST', headers,
          body: JSON.stringify({ script, count: clipsCount }),
        })
        const spBody = await sp.json()
        if (!sp.ok) throw new Error(spBody.error || 'Script split failed')
        const chunks = Array.isArray(spBody.chunks) ? spBody.chunks : [script]
        const assignments = chunks.map((chunk, i) => ({
          chunk, image: images[i % images.length], order: i,
        }))
        const total = assignments.length
        let done = 0
        reportProgress?.({ done: 0, total, message: `Rendering 0 of ${total} clips…` })
        const settled = await Promise.allSettled(assignments.map(async (a) => {
          const r = await renderOne({ photo_url: a.image.image_url, scriptChunk: a.chunk || script })
          done += 1
          reportProgress?.({ done, total, message: `Rendered ${done} of ${total} clips` })
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
        if (!clips.length) throw new Error(`All ${assignments.length} clips failed. First error: ${failures[0]?.error || 'unknown'}`)
        return {
          videos: clips, media_type: 'video', is_clip_set: true,
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
    free: true,
    label: 'Collection', description: 'A bucket that holds onto everything an earlier step makes. Every time you run, new pictures, videos, or scripts get added. Connect this when you want to keep a running list instead of replacing the result each time.',
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
    label: 'Stitch videos', description: 'Joins several short video clips together into one longer video, played one after the other. Use this after Avatar video when Randomize is on, or any time you have multiple clips and want a single finished video.',
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

  // ── COMBINE (audio + video mux) ─────────────────────────────────────
  // Pre-polish step for b-roll workflows. Takes a silent (or noisy)
  // video and a separate voiceover, produces ONE mp4 with the voice
  // muxed as primary audio. -c:v copy on the worker side keeps this
  // fast (network bound, no re-encode). After this the downstream
  // Finish video / polish step looks identical to an avatar-render
  // input — no audio chain complexity in polish itself.
  combine_av: {
    label: 'Combine',
    description: 'Puts a voiceover on top of a silent video clip. If the video is shorter than the voice, the clip loops to match the audio. Use this when you uploaded your own video and you want to add a generated voiceover before the final step.',
    icon: CombineIcon, category: 'generators', color: '#0ea5e9',
    inputs: [{ id: 'in', label: 'In (video + audio)' }],
    outputs: [{ id: 'out', label: 'Out (video)' }],
    initialProps: { loop_video: true },
    run: async ({ data, inputs, ctx }) => {
      const arr = asArr(inputs?.in)
      let videoUrl = null
      let audioUrl = null
      for (const v of arr) {
        if (!v || typeof v !== 'object') continue
        if (!videoUrl) {
          if (v.video?.video_url) videoUrl = v.video.video_url
          else if (v.video_url) videoUrl = v.video_url
          else if (Array.isArray(v.videos) && v.videos[0]?.url) videoUrl = v.videos[0].url
        }
        if (!audioUrl) {
          if (v.audio?.url) audioUrl = v.audio.url
          else if (v.audio_url) audioUrl = v.audio_url
        }
      }
      if (!videoUrl) throw new Error('Combine needs a video wired in (Upload media or another video-producing node).')
      if (!audioUrl) throw new Error('Combine needs an audio file wired in (Voice gen output).')
      const r = await fetch('/api/videos/combine-av', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
        body: JSON.stringify({
          profile_id: ctx.profileId,
          video_url: videoUrl,
          audio_url: audioUrl,
          loop_video: data.props?.loop_video !== false,
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.error || `Combine failed (${r.status})`)
      return {
        video: { video_url: body.video_url },
        video_url: body.video_url,
        media_type: 'video',
        combined: true,
      }
    },
  },

  // ── POLISH VIDEO (title overlay + logo/watermark + bg music) ──────────
  video_polish: {
    label: 'Finish video',
    description: 'Polishes the video for posting. Adds subtitles you can read on the screen, a title at the top, your logo, and background music. Turn each piece on or off as you like. Open settings to fine-tune fonts, position, and volume.',
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
      music_url: null,
      music_file_name: null,
      music_size_bytes: null,
      music_volume: 0.15,
      // Default fade is 1s — short enough to not eat the punchline,
      // long enough to feel intentional. User can override per node.
      music_fade_secs: 1.0,
    },
    Body: VideoPolishBody,
    Editor: VideoPolishEditor,
    run: async ({ data, inputs, ctx, reportProgress }) => {
      const arr = asArr(inputs?.in)
      let logoUrl = null, musicUrl = null, voiceoverUrl = null
      const p = data.props || {}
      // Loud failure when captions are enabled but no ZapCap template id is
      // set. Without this the polish API silently drops Phase B (it gates
      // on `captions_enabled && caption_template_id`), and the user just
      // sees "no captions" with no clue why.
      if (p.captions_enabled !== false && !p.caption_template_id) {
        throw new Error('Captions are on but no style picked. Open settings → Captions and choose a template.')
      }
      // Resolve music source per the dropdown mode:
      //   - 'library' + music_track_id → use that specific track URL
      //     from the brand's library
      //   - 'random' → pick a random track from the library at run time
      //     (so each render uses a different one)
      //   - 'custom' / unset → fall back to p.music_url (one-off upload)
      const libraryTracks = Array.isArray(data?._ctxMusicTracks) ? data._ctxMusicTracks : []
      if (p.music_mode === 'random' && libraryTracks.length > 0) {
        const pick = libraryTracks[Math.floor(Math.random() * libraryTracks.length)]
        if (pick?.url) musicUrl = pick.url
      } else if (p.music_mode === 'library' && p.music_track_id) {
        const pick = libraryTracks.find((t) => t.id === p.music_track_id)
        if (pick?.url) musicUrl = pick.url
        else if (libraryTracks[0]?.url) musicUrl = libraryTracks[0].url   // saved id no longer exists
      } else if (p.music_url) {
        musicUrl = p.music_url
      }
      // Also pluck a wired-in title from upstream caption_gen so it can
      // override the manually-typed prop without the user re-typing.
      // Plus the source script when an upstream Text / script_gen /
      // voice_gen is in the chain — auto-title can use that script
      // directly and skip ElevenLabs Scribe transcription. Saves 5-15s
      // per clip (the whole STT round-trip) when the script already
      // exists in the canvas. Per-clip script for chunked audio comes
      // later (paired by order in polishOne); upstreamScript here is
      // the FULL script (single-clip) or fallback.
      let upstreamTitle = ''
      let upstreamScript = ''
      let upstreamChunkScripts = null  // [{ order, sentence }, …] from voice_gen randomize
      // Forward caption_gen metadata through polish so downstream
      // schedule_post can still find caption / hashtags / first_comment /
      // captions[] after the polish step. Without this, wiring
      // caption_gen → Finish video → Schedule post bombed with "Nothing
      // to publish" because Finish video's output stripped all of it.
      let upstreamCaption = '', upstreamHashtags = '', upstreamFirstComment = ''
      let upstreamCaptions = null  // captions[] from caption_gen multi-clip mode
      for (const v of arr) {
        if (!v || typeof v !== 'object') continue
        if (!upstreamTitle && typeof v.title === 'string') upstreamTitle = v.title
        if (!upstreamCaption && typeof v.caption === 'string') upstreamCaption = v.caption
        if (!upstreamHashtags && typeof v.hashtags === 'string') upstreamHashtags = v.hashtags
        if (!upstreamFirstComment && typeof v.first_comment === 'string') upstreamFirstComment = v.first_comment
        if (!upstreamCaptions && Array.isArray(v.captions) && v.captions.length) upstreamCaptions = v.captions
        if (!upstreamScript) {
          if (typeof v.script === 'string') upstreamScript = v.script
          else if (typeof v.full_script === 'string') upstreamScript = v.full_script
          else if (typeof v.text === 'string') upstreamScript = v.text
          else if (typeof v.script_for_render === 'string') upstreamScript = v.script_for_render
        }
        if (!upstreamChunkScripts && Array.isArray(v.audio_chunks)) {
          upstreamChunkScripts = v.audio_chunks
            .map((c, i) => ({ order: c.order ?? i, sentence: String(c.sentence || '').trim() }))
            .filter((c) => c.sentence)
          if (!upstreamChunkScripts.length) upstreamChunkScripts = null
        }
        if (!logoUrl) {
          if (v.brand?.logo_url) logoUrl = v.brand.logo_url
          else if (Array.isArray(v.images) && v.images[0]?.url) logoUrl = v.images[0].url
          else if (v.url && /\.(png|jpe?g|webp)(\?|$)/i.test(v.url)) logoUrl = v.url
        }
        // voice_gen output: { audio: { url, name, duration_secs } }.
        // We detect THAT shape separately from background music
        // (audio_upload uses v.audio.audio_url or top-level v.audio_url
        // / v.url). When a voiceover is wired in, the polish step
        // muxes it as the primary audio track, mutes the source
        // video's audio, and loops the video to match if the
        // voiceover is longer than the clip. That's the script →
        // voice → polish + media flow for non-avatar voiceovers.
        if (!voiceoverUrl && v.audio?.url) voiceoverUrl = v.audio.url
        if (!musicUrl) {
          if (v.audio?.audio_url) musicUrl = v.audio.audio_url
          else if (v.audio_url) musicUrl = v.audio_url
          else if (v.url && /\.(mp3|wav|m4a|aac)(\?|$)/i.test(v.url)) musicUrl = v.url
        }
      }
      // Collect EVERY video URL from upstream — supports a Collection
      // wired in as well as multi-clip avatar_render randomize output.
      // Single-video case (one URL) preserves the existing flat output
      // shape so downstream nodes (schedule_post, captions, etc.) keep
      // working without changes. Multi-video case fans out and emits
      // a videos[] array.
      const urls = pickAllVideoUrls(arr)
      if (urls.length === 0) {
        const shapes = arr.map((v) => {
          if (!v || typeof v !== 'object') return typeof v
          if (v.audio?.url) return 'audio'
          if (Array.isArray(v.audio_chunks)) return 'audio chunks'
          if (v.brand?.profile_id) return 'brand'
          if (v.script || v.text) return 'script/text'
          if (Array.isArray(v.images)) return 'images'
          return Object.keys(v).slice(0, 3).join(',') || 'empty'
        })
        const got = shapes.length ? shapes.join(' + ') : 'nothing'
        throw new Error(
          `Wire a VIDEO into "in" — got ${got} instead. ` +
          'Video has to come from Avatar video, Combine videos, or another video-producing node.'
        )
      }

      // Per-video work: resolve title (with auto-title transcribe when
      // mode=auto) then call /api/videos/polish. Extracted so we can
      // call it once (single video) or N times in parallel.
      const polishOne = async (videoUrl, idx, total) => {
        const tag = total > 1 ? ` (clip ${idx + 1}/${total})` : ''
        let resolvedTitle = ''
        if (p.title_enabled !== false) {
          if ((p.title_mode || 'auto') === 'auto') {
            try {
              // Prefer per-clip chunk script, then full upstream script,
              // and only fall through to ElevenLabs Scribe if neither
              // exists. Saves 5-15s per clip when the script came from
              // voice_gen / Text / script_gen — no transcription round
              // trip needed.
              let chunkScript = null
              if (Array.isArray(upstreamChunkScripts)) {
                const match = upstreamChunkScripts.find((c) => c.order === idx) || upstreamChunkScripts[idx]
                if (match?.sentence) chunkScript = match.sentence
              }
              const transcriptHint = chunkScript || upstreamScript || null
              reportProgress?.({
                message: transcriptHint ? `Generating title${tag}…` : `Transcribing for auto-title${tag}…`,
                done: idx, total,
              })
              const ar = await fetch('/api/videos/auto-title', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
                body: JSON.stringify({
                  profile_id: ctx.profileId,
                  video_url: videoUrl,
                  topic: (p.title_topic || '').trim() || undefined,
                  // Bypass ElevenLabs Scribe when we already have the
                  // script — saves the slowest part of auto-title.
                  transcript: transcriptHint || undefined,
                }),
              })
              const ab = await ar.json().catch(() => ({}))
              if (ar.ok && ab?.title) resolvedTitle = ab.title
            } catch (e) {
              console.warn('auto-title failed, falling back —', e?.message || e)
            }
            if (!resolvedTitle) resolvedTitle = upstreamTitle || (p.title || '').trim()
          } else {
            resolvedTitle = upstreamTitle || (p.title || '').trim()
          }
        }
        const titleOn = (p.title_enabled !== false) && !!resolvedTitle

        reportProgress?.({ message: `Compositing${tag}…`, done: idx, total })
        const r = await fetch('/api/videos/polish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
          body: JSON.stringify({
            profile_id: ctx.profileId,
            video_url: videoUrl,
            logo_url: logoUrl || undefined,
            watermark_image_url: p.watermark_image_url || undefined,
            music_url: musicUrl || undefined,
            // Voiceover from an upstream voice_gen. When present, the
            // worker uses it as the primary audio track, mutes the
            // source video's audio (so the camera audio doesn't fight
            // the narration), and loops the video frames if the
            // voiceover is longer than the clip — exactly the "narrate
            // a B-roll" pattern.
            voiceover_url: voiceoverUrl || undefined,
            loop_video: voiceoverUrl ? true : undefined,
            mute_video_audio: voiceoverUrl ? true : undefined,
            title: titleOn ? resolvedTitle : undefined,
            title_style: titleOn ? {
              font: p.title_font, color: p.title_color, bg_color: p.title_bg_color,
              size: p.title_size, bg_padding: p.title_bg_padding, y_pos: p.title_y_pos,
              uppercase: p.title_uppercase,
            } : undefined,
            captions_enabled: p.captions_enabled !== false,
            caption_template_id: p.caption_template_id || undefined,
            caption_language:    p.caption_language    || undefined,
            watermark_position: p.watermark_position || 'br',
            watermark_size_pct: p.watermark_size_pct ?? 25,
            music_volume: p.music_volume ?? 0.15,
            music_fade_secs: p.music_fade_secs ?? 1.0,
          }),
        })
        let body = await r.json().catch(() => ({}))

        // Async path: 202 = worker accepted the job but didn't finish
        // inside Vercel's 300s window. Keep polling the status endpoint
        // until we get a final URL or a failure. No client-side
        // deadline — big 4K clips can take 3-5 min, and we'd rather
        // wait honestly than fail spuriously.
        if (r.status === 202 && body?.polling && body?.worker_job_id) {
          reportProgress?.({ message: `Polishing on worker${tag} (this may take a few minutes for big clips)…`, done: idx, total })
          const POLL_INTERVAL_MS = 7_000
          const sess = ctx.token
          const jobId = body.worker_job_id
          // Transient errors are common over multi-minute polling: tab
          // backgrounded + browser throttling, Wi-Fi drop, Fly proxy
          // restart, etc. None of those mean the job is dead — most of
          // the time the worker keeps grinding and the next tick works.
          // Tolerate up to 6 consecutive network failures (~42s of dark
          // sky) before giving up. Hard errors (4xx/5xx from the proxy
          // with a parsed body) still abort immediately.
          const MAX_TRANSIENT_FAILS = 6
          let consecFails = 0
          let pollResult = null
          while (true) {
            await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS))
            // Abort cooperatively if the user hit Stop mid-poll.
            if (ctx.shouldAbort?.()) throw new Error('Stopped')
            let sr, sb
            try {
              sr = await fetch(`/api/videos/polish-status?job_id=${encodeURIComponent(jobId)}`, {
                headers: { Authorization: `Bearer ${sess}` },
              })
              sb = await sr.json().catch(() => ({}))
            } catch (netErr) {
              // fetch() threw — DNS failure, CORS, browser-aborted
              // connection, etc. Count it as transient and retry.
              consecFails += 1
              if (consecFails >= MAX_TRANSIENT_FAILS) {
                throw new Error(`Lost connection to worker after ${consecFails} retries. The polish may have still completed — check the Library in a minute.`)
              }
              reportProgress?.({ message: `Reconnecting to worker (${consecFails}/${MAX_TRANSIENT_FAILS})…`, done: idx, total })
              continue
            }
            consecFails = 0
            if (sr.status === 404) throw new Error(`Polish job ${jobId} expired before completion.`)
            if (!sr.ok) throw new Error(sb?.error || `Polish status ${sr.status}`)
            if (sb.status === 'done') { pollResult = sb.result; break }
            if (sb.status === 'failed') throw new Error(sb.error || 'Worker reported polish failure')
            // queued / running — keep polling.
          }
          body = pollResult
        }

        if (!body?.video_url) {
          const msg = body?.error || `Polish failed (${r.status})`
          const detail = body?.ffmpeg_error ? `\n\nffmpeg: ${body.ffmpeg_error}` : ''
          throw new Error(msg + detail)
        }
        return { video_url: body.video_url, title: titleOn ? resolvedTitle : undefined, source_url: videoUrl }
      }

      // Forward caption metadata from caption_gen so it survives the
      // polish hop to schedule_post.
      const captionForward = {
        ...(upstreamCaption       ? { caption: upstreamCaption } : {}),
        ...(upstreamHashtags      ? { hashtags: upstreamHashtags } : {}),
        ...(upstreamFirstComment  ? { first_comment: upstreamFirstComment } : {}),
        ...(upstreamCaptions      ? { captions: upstreamCaptions, is_clip_set: true } : {}),
      }

      // Single-video → flat output shape (unchanged).
      if (urls.length === 1) {
        const out = await polishOne(urls[0], 0, 1)
        return {
          video: { video_url: out.video_url },
          video_url: out.video_url,
          media_type: 'video',
          title: out.title,
          polished: true,
          ...captionForward,
        }
      }

      // Multi-video → fan out. Limit concurrency to 3 so we don't blow
      // through ffmpeg compute time / Vercel concurrency. A single
      // polish takes ~30-60s; 3 in parallel keeps total wall clock
      // reasonable on a list of 10 without overwhelming the platform.
      const total = urls.length
      let done = 0
      reportProgress?.({ message: `Polishing 0 of ${total} clips…`, done: 0, total })
      // Concurrency = 3. We tried 4 briefly but it nudged Vercel's
      // 300s gateway timeout for individual polishes — concurrent
      // calls can compete for ffmpeg CPU on the same function pool.
      // 3 fits cleanly within budget; the per-call speedups (script
      // bypass + tighter ZapCap poll) more than make up the wall time.
      const CONCURRENCY = 3
      const results = new Array(total)
      const failures = []
      let cursor = 0
      const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, async () => {
        while (cursor < total) {
          const i = cursor++
          try {
            results[i] = await polishOne(urls[i], i, total)
          } catch (e) {
            failures.push({ clip_index: i, source_url: urls[i], error: e?.message || String(e) })
          } finally {
            done += 1
            reportProgress?.({ message: `Polished ${done} of ${total} clips`, done, total })
          }
        }
      })
      await Promise.all(workers)
      const polished = results.filter(Boolean).map((r, i) => ({
        video_url: r.video_url,
        title: r.title,
        source_url: r.source_url,
        order: i,
      }))
      if (!polished.length) {
        throw new Error(`All ${total} clips failed. First error: ${failures[0]?.error || 'unknown'}`)
      }
      return {
        videos: polished,
        media_type: 'video',
        is_clip_set: true,
        polished: true,
        ...captionForward,
        ...(failures.length ? { partial_failures: failures } : {}),
      }
    },
  },

  // ── CAPTIONS (ZapCap) ────────────────────────────────────────────────
  // Slim node: takes a video, hands it to ZapCap with a chosen style,
  // returns the captioned MP4. Polish (title, watermark, music) is its
  // own node — chain captions → video_polish if you want both.
  captions: {
    hidden: true,
    label: 'Captions (older version)', description: 'Older "add subtitles" step. The Finish video node does this now — use that instead. This one stays here so older saved workflows keep working.',
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
    label: 'Schedule post', description: 'Posts your finished content to social media. Pick the platforms (TikTok, Instagram, YouTube, X, LinkedIn, Threads, Facebook, Pinterest), and pick "now" to post right away or "next slot" to add it to your schedule. Connect a video or pictures plus the caption.',
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
      if (data?._ctxIsTrialing) {
        throw new Error('Scheduling / publishing is locked during free trial. Upgrade for 20% off your first month → /billing')
      }
      const arr = asArr(inputs?.in)
      let caption = ''
      let hashtags = ''
      let firstComment = ''
      let script = ''
      let title = ''
      let perPlatform = null
      // Per-clip captions array from caption_gen multi-clip mode. When
      // present AND we're in multi-video fan-out, each video gets its
      // own caption set instead of the single shared one.
      let perClipCaptions = null
      // Text-only post bundle from text_post_gen. Holds per-platform
      // native variants (x, threads, facebook, linkedin) that get
      // forwarded to upload-post so each platform publishes its own
      // wording. No media required when this is present.
      let textPostBundle = null
      const photoUrls = []
      for (const v of arr) {
        if (!v) continue
        if (typeof v === 'string') { if (!script) script = v; continue }
        if (typeof v !== 'object') continue
        if (!title && v.title) title = v.title
        if (!script && (v.script || v.full_script)) script = v.script || v.full_script
        if (!caption && v.caption) caption = v.caption
        if (!hashtags && v.hashtags) hashtags = v.hashtags
        if (!firstComment && v.first_comment) firstComment = v.first_comment
        if (!perPlatform && v.per_platform && typeof v.per_platform === 'object' && !v.is_text_post) perPlatform = v.per_platform
        if (!textPostBundle && v.is_text_post && v.per_platform && typeof v.per_platform === 'object') {
          textPostBundle = v.per_platform
        }
        if (!perClipCaptions && Array.isArray(v.captions) && v.captions.length > 0) {
          perClipCaptions = v.captions
        }
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
      // Multi-video support: gather every video URL upstream so we can
      // fan out one scheduled post per clip when polish (or any other
      // node) emits a videos[] array. Single-video case behaves
      // exactly as before.
      const allVideoUrls = pickAllVideoUrls(arr)
      const videoUrl = allVideoUrls[0] || pickFirstVideoUrl(arr) || null

      const platforms = Array.isArray(data.props?.platforms) ? data.props.platforms : []
      if (!platforms.length) throw new Error('Pick at least one platform.')
      const isTextPost = !!textPostBundle && !videoUrl && !photoUrls.length
      if (!isTextPost && !videoUrl && !photoUrls.length) {
        throw new Error('Wire a video, images, or a Text post node into "in".')
      }

      // Per-platform kind validation up front so we don't waste an API
      // call. Text posts skip this — every supported platform accepts
      // text-only posts by definition.
      if (!isTextPost) {
        const detectedKind = videoUrl ? 'video' : 'image'
        const bad = platforms.filter((id) => {
          const def = SCHEDULE_PLATFORMS.find((p) => p.id === id)
          return def && !def.kinds.includes(detectedKind)
        })
        if (bad.length) {
          const names = bad.map((id) => SCHEDULE_PLATFORMS.find((p) => p.id === id)?.label || id).join(', ')
          throw new Error(`${names} can't accept ${detectedKind} content.`)
        }
      }

      // Backward-compat fallback: older saved spaces' caption_gen output
      // had a per_platform variant block but no canonical caption/hashtags.
      // If the canonical fields are empty, pull from whichever variant has
      // a caption — instagram preferred (longest format) so we don't
      // inadvertently truncate when fanning out to the long-form platforms.
      if (perPlatform && (!caption || !hashtags)) {
        const order = ['instagram', 'facebook', 'youtube', 'linkedin', 'threads', 'tiktok', 'x']
        const k = order.find((kk) => perPlatform[kk]?.caption) || Object.keys(perPlatform)[0]
        const v = perPlatform[k] || {}
        if (!caption && v.caption) caption = v.caption
        if (!hashtags && v.hashtags) hashtags = v.hashtags
        if (!title && v.title) title = v.title
        if (!firstComment && v.first_comment) firstComment = v.first_comment
      }

      // Last-resort: scrape #tags out of the caption itself if hashtags
      // is still empty (e.g. caption_gen failed entirely and we're in the
      // legacy single-string path with hashtags inlined).
      if (!hashtags && caption) {
        const m = String(caption).match(/#[\w]+/g)
        if (m && m.length) hashtags = m.join(' ')
      }

      // 'Don't queue until we have everything' rule: refuse to fire if
      // the bundle is missing user-facing copy (caption AND hashtags
      // both empty almost always means caption_gen upstream failed or
      // wasn't wired). Bailing here avoids inserting half-baked rows
      // into the queue. Script-only fallback still allowed because
      // some workflows publish raw script (e.g. text-only posts).
      if (!caption && !hashtags && !script) {
        throw new Error('Nothing to publish — caption / hashtags / script are all empty. Wire a caption generator (or fix it) before scheduling.')
      }
      if (!caption && !hashtags) {
        // Have script but no caption — only allow when script is the
        // whole post (text-only kinds). For video / image posts a
        // missing caption usually means caption_gen choked silently.
        if (videoUrl || photoUrls.length) {
          throw new Error('Caption + hashtags are empty. Re-run caption_gen (or wait for it to finish) before scheduling — otherwise the post lands in the queue blank.')
        }
      }

      // Defensive: if the caption / script we're about to publish
      // looks like raw JSON (curly braces + "title": or "caption":
      // markers, or a ```json fence), refuse to ship it. This was
      // landing on TikTok / IG as a literal JSON dump when an upstream
      // model wrapped its output in markdown and the parser fell
      // back to the raw text. Force a re-run instead of posting
      // garbage.
      const looksLikeJson = (s) => {
        if (!s) return false
        const t = String(s).trim()
        if (t.startsWith('```')) return true
        if (t.startsWith('{') && /"\s*(title|caption|full_script|hashtags|first_comment)\s*"\s*:/.test(t)) return true
        return false
      }
      if (looksLikeJson(caption) || looksLikeJson(script) || looksLikeJson(hashtags)) {
        throw new Error(
          'Upstream generator emitted raw JSON instead of clean text. ' +
          'Re-run script_gen / caption_gen — the model wrapped its response in code fences and the parser couldn\'t recover. ' +
          'If this keeps happening, edit the caption manually on the caption_gen node before scheduling.'
        )
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

      const resolvedTitle = (title
        || (script ? String(script).split(/[.!?\n]/)[0].trim().slice(0, 90) : '')
        || (caption ? String(caption).split(/[.!?\n]/)[0].trim().slice(0, 90) : '')
        || 'Untitled')

      // Per-clip submit. Accepts an optional captionOverride so multi-
      // clip fan-out can use per-clip captions from caption_gen.
      const submitOne = async (singleVideoUrl, captionOverride = null) => {
        const useTitle    = captionOverride?.title         || resolvedTitle
        const useCaption  = captionOverride?.caption       ?? caption
        const useHashtags = captionOverride?.hashtags      ?? hashtags
        const useFirstC   = captionOverride?.first_comment ?? firstComment
        const useDescription = captionOverride
          ? [useCaption, useHashtags].filter(Boolean).join('\n\n').trim() || description
          : description
        const r = await fetch('/api/social/upload-post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
          body: JSON.stringify({
            profile_id: ctx.profileId,
            platforms,
            video_url: singleVideoUrl || undefined,
            photo_urls: !singleVideoUrl && photoUrls.length ? photoUrls : undefined,
            description: useDescription,
            title: useTitle,
            caption: useCaption || null,
            hashtags: useHashtags || null,
            script: script || null,
            first_comment: useFirstC || (data._ctxBrandCTA || '').trim() || useHashtags || null,
            // Text-only post — forward the per-platform variants so each
            // platform's queued submission carries its native wording
            // instead of one shared caption.
            is_text_post: isTextPost || undefined,
            per_platform_text: textPostBundle || undefined,
            // For multi-clip fan-out, ALWAYS use auto so each post lands
            // in the next open slot of the brand's posting schedule.
            // Sequential submits cascade: each call sees the previous
            // post's reservation and books the slot after it.
            scheduling_mode: allVideoUrls.length > 1 ? 'auto' : schedulingMode,
            scheduled_iso: allVideoUrls.length > 1 ? null : scheduledIso,
            timezone: data.props?.timezone || undefined,
          }),
        })
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body?.error || `Upload-Post failed (${r.status})`)
        return {
          request_id: body?.request_id || null,
          scheduled_iso: body?.scheduled_iso || scheduledIso,
          source_url: singleVideoUrl,
          caption_used: captionOverride ? { title: useTitle, caption: useCaption, hashtags: useHashtags } : null,
        }
      }

      // Single video / image bundle → existing flat output shape.
      if (allVideoUrls.length <= 1) {
        const out = await submitOne(videoUrl)
        return {
          request_id: out.request_id,
          platforms,
          scheduled_iso: out.scheduled_iso,
          scheduling_mode: schedulingMode,
          kind: detectedKind,
          submitted: true,
        }
      }

      // Multi-clip fan-out: schedule each clip into the next open slot
      // of the profile's posting schedule. Sequential so each submit
      // sees the prior reservation. Force scheduling_mode='auto' even
      // if the user picked 'now' or a fixed date — fan-out only makes
      // sense with auto-scheduling.
      // Per-clip captions: when caption_gen ran in fan-out mode, it
      // emitted captions[]. We match captions[i] → video[i] by order.
      // If caption_gen is single-mode (or absent), every clip uses the
      // shared caption fields.
      const submitted = []
      const failures = []
      for (let i = 0; i < allVideoUrls.length; i++) {
        // Find the matching caption set: prefer order match, fall back
        // to array index. Some pipelines might re-shuffle order (e.g.
        // partial render failures), so order match wins.
        let perClip = null
        if (perClipCaptions) {
          perClip = perClipCaptions.find((c) => c.order === i) || perClipCaptions[i] || null
        }
        try {
          const out = await submitOne(allVideoUrls[i], perClip)
          submitted.push({ ...out, order: i })
        } catch (e) {
          failures.push({ clip_index: i, source_url: allVideoUrls[i], error: e?.message || String(e) })
        }
      }
      if (!submitted.length) {
        throw new Error(`All ${allVideoUrls.length} posts failed. First error: ${failures[0]?.error || 'unknown'}`)
      }
      return {
        submissions: submitted,
        platforms,
        scheduling_mode: 'auto',
        kind: detectedKind,
        submitted: true,
        clip_count: submitted.length,
        ...(failures.length ? { partial_failures: failures } : {}),
      }
    },
  },

  combine: {
    free: true,
    hidden: true,
    label: 'Combine (older version)', description: 'Older step for bundling content before posting. Replaced by Save to drafts. This one stays so older saved workflows keep working.',
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
    free: true,
    label: 'Save to drafts', description: 'Gathers your script, captions, hashtags, and media into one package so the next step (Schedule post) has everything it needs. The draft only shows up on your Schedule page once a post is actually published or scheduled.',
    icon: Save, category: 'outputs', color: '#2ecc71',
    inputs: [{ id: 'in', label: 'In (script / caption / image / video)' }],
    outputs: [{ id: 'out', label: 'Out (bundle for schedule_post)' }],
    initialProps: { title: '', platforms: [] },
    Body: SaveBody,
    // Pure in-memory bundler. No /api/content insert. Per the
    // 'nothing in queue until schedule_post says done' rule: the
    // queue / calendar should only ever reflect rows that
    // schedule_post created on a successful Upload-Post submission.
    // save_library used to insert a status='draft' row on every run,
    // which (a) cluttered the Library tab with partial drafts and
    // (b) doubled the row count when schedule_post fired right after.
    run: async ({ data, inputs }) => {
      const arr = asArr(inputs?.in)
      let script = '', caption = '', hashtags = '', firstComment = '', videoUrl = null, incomingTitle = '', perPlatform = null
      const imageUrls = []
      for (const v of arr) {
        if (!v) continue
        if (typeof v === 'string') { if (!script) script = v; continue }
        if (typeof v !== 'object') continue
        if (v.combined && v.title) incomingTitle = incomingTitle || v.title
        if (v.title && !incomingTitle) incomingTitle = v.title
        if (v.script || v.full_script) script = script || v.script || v.full_script
        if (v.caption) caption = caption || v.caption
        if (v.hashtags) hashtags = hashtags || v.hashtags
        if (v.first_comment) firstComment = firstComment || v.first_comment
        if (!perPlatform && v.per_platform && typeof v.per_platform === 'object') perPlatform = v.per_platform
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
      // Emit a complete bundle so a downstream schedule_post can run
      // without re-walking every upstream input.
      return {
        bundle: true,
        title,
        script,
        full_script: script,
        caption,
        hashtags,
        first_comment: firstComment,
        per_platform: perPlatform,
        video_url: videoUrl,
        images: imageUrls.length ? imageUrls.map((url) => ({ url })) : undefined,
        media_urls: mediaUrls,
        media_type: mediaType,
        platforms,
      }
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

    // ── Cache / re-run policy ──────────────────────────────────────────
    //
    // ctx.runOnlyTargetId — set by runFromNode when scope='self_only'.
    //   In that mode every NON-target node MUST use its cached output
    //   verbatim and must not run def.run(). This overrides def.noCache
    //   too — avatar_picker's cycle queue does not advance when the
    //   user picks "Run this node only", because they didn't ask for a
    //   fresh upstream pass. Only the target re-executes.
    //
    // ctx.forceReRun — set by runFromNode for auto_run ticks: the
    //   target's descendants must re-execute even if cached so each tick
    //   produces fresh output downstream.
    //
    // def.noCache — node-level opt-out (avatar_picker uses it so the
    //   cycle_looks queue advances on every full run). Ignored when
    //   runOnlyTargetId is set, see above.
    if (ctx?.runOnlyTargetId && id !== ctx.runOnlyTargetId) {
      // Non-target in self_only mode. Three paths now:
      //   • In ctx.forceReRun → ALWAYS re-execute. This is how free
      //     descendants of the target (Collection, Combine, etc.) refresh
      //     against the target's new output without the user having to
      //     pick a different scope. Without this, Collection short-
      //     circuits to its stale cache and never picks up new images.
      //   • Has cached output → use it verbatim. Cache flows through
      //     ancestors to the target as before.
      //   • No cached output BUT def.free === true → auto-run it. Free
      //     nodes (collection, combine, picker, brand_profile, text /
      //     audio / image_upload) are pure aggregators / projectors with
      //     no API cost.
      //   • No cached output AND not free → skip silently. The target
      //     will fail its own input check; that's the honest outcome.
      const inForceReRun = ctx?.forceReRun?.has?.(id)
      if (inForceReRun) {
        // Fall through to def.run() — inputObj is already built from
        // outputsById, so the target's fresh output is available.
      } else if (node.data?.output != null) {
        outputsById.set(id, node.data.output)
        continue
      } else if (def.free) {
        // Fall through to run def.run() below.
      } else {
        continue
      }
    }
    // The target in self_only mode ALWAYS re-runs. The snapshot is taken
    // before React commits the setNodes reset, so node.data.status may
    // still read 'done' here — without this short-circuit the runner
    // would skip def.run() and the user's click would do nothing.
    const isRunOnlyTarget = ctx?.runOnlyTargetId === id
    const skipCache = isRunOnlyTarget || (ctx?.forceReRun && ctx.forceReRun.has?.(id)) || def.noCache
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
      const reportProgress = (progress) => onNodeChange?.(id, { progress })
      const result = await Promise.race([
        def.run({ id, data: node.data, inputs: inputObj, inputsByName, ctx, reportProgress }),
        abortPromise,
      ]).finally(() => { try { clearInterval(abortTimer) } catch {} })
      outputsById.set(id, result || {})
      onNodeChange?.(id, { status: 'done', output: result, progress: null })
    } catch (err) {
      // Tag insufficient-credit errors so the UI can offer a top-up CTA.
      const isCreditError = /insufficient/i.test(err?.message || '')
        || err?.code === 'insufficient_credits'
        || err?.code === 'trial_publish_blocked'
        || /not enough video credits/i.test(err?.message || '')
        || /no active subscription/i.test(err?.message || '')
        || /trial/i.test(err?.message || '')
      const finalMsg = isCreditError
        ? `${err.message} — top up in Billing to continue.`
        : err.message
      onNodeChange?.(id, { status: 'failed', error: finalMsg })
      errors[id] = finalMsg
      // Pop the global modal so the user sees the top-up CTA
      // immediately — without it the only signal is a red error chip
      // on the failed node, which most users miss. typeof window
      // check keeps this safe on the worker side (SSR / Node).
      if (isCreditError && typeof window !== 'undefined' && window.dispatchEvent) {
        try {
          window.dispatchEvent(new CustomEvent('scalesolo:out-of-credits', {
            detail: {
              message: err.message,
              required: err.required ?? err.data?.required,
              have: err.have ?? err.data?.have,
              node_id: id,
            },
          }))
        } catch { /* ignore */ }
      }
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
