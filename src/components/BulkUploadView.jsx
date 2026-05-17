// Bulk media upload + manage table — replaces the old Library tab on the
// Schedule page. Mirrors VTM's ContentScheduler page (drag/drop area on
// top, status-tabbed table below) but skinnier:
//
//   - Drag & drop a folder of MP4 / JPG / PNG files
//   - Each file gets uploaded to landing-media (direct supabase client),
//     a content_scripts row is created with media_urls + media_type
//   - Table shows every script in the profile with inline-editable
//     title / script / caption / hashtags / first_comment / scheduled
//   - Status tabs filter rows: Queued (draft|caption_ready|scheduled),
//     Error (failed), Delivered (posted)
//   - Toolbar actions:
//       Generate Captions    → POST /api/content/bulk-actions?action=generate-captions
//       Auto Schedule        → POST /api/content/bulk-actions?action=auto-schedule
//       Publish Selected     → POST /api/content/bulk-actions?action=publish-selected
//       Export CSV           → client-side csv build
//
// Editable cells call PATCH /api/content?id=… on blur.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Upload, Loader2, Sparkles, CalendarClock, Send, Download, Trash2,
  Check, X, AlertCircle, Image as ImageIcon, Video as VideoIcon, ChevronDown, Zap,
  RefreshCw, Type, Wand2, Settings as SettingsIcon, Film,
} from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { toast, confirmDialog } from './Toast.jsx'
import { PlatformBadge, PLATFORMS as PB_PLATFORMS } from './PlatformBadge.jsx'
import { VideoPolishEditor } from '../lib/space-nodes.jsx'

// ── styles ──────────────────────────────────────────────────────────────────
const cellInput = {
  width: '100%', background: 'transparent', border: '1px solid transparent',
  color: 'var(--text)', fontSize: 12, padding: '6px 8px', borderRadius: 6,
  outline: 'none', resize: 'none',
  fontFamily: 'inherit', maxHeight: 120, overflowY: 'auto',
  lineHeight: 1.4,
}
const cellInputFocus = {
  border: '1px solid rgba(239,68,68,0.5)',
  background: 'var(--surface-2)',
}
const headerCell = {
  fontFamily: 'var(--font-display)', fontSize: 10.5, fontWeight: 700,
  letterSpacing: '0.06em', textTransform: 'uppercase',
  color: 'var(--muted)', padding: '10px 8px', textAlign: 'left',
  borderBottom: '1px solid var(--border)', background: 'var(--surface)',
  position: 'sticky', top: 0, zIndex: 1,
}

// Per-row platform picker. Each row gets its own set of platforms so a
// single Publish Selected click can fan out different rows to different
// targets. The full set is intentionally small — only platforms Upload-
// Post supports — and matches the schedule_post node's PLATFORMS list.
// Local alias so existing references (kinds, label, etc) keep working.
const ROW_PLATFORMS = PB_PLATFORMS

// Safely turn an error of any shape into a human string. Server error
// payloads sometimes come back as nested objects (`{ error: { code, msg } }`)
// and template-literal interpolation on a plain object renders as the
// notorious "[object Object]". This helper takes whatever the response
// gave us and produces something readable, falling back to JSON when
// it can't find a string.
function fmtErr(e) {
  if (e == null) return ''
  if (typeof e === 'string') return e
  if (typeof e === 'number' || typeof e === 'boolean') return String(e)
  if (typeof e === 'object') {
    if (typeof e.message === 'string') return e.message
    if (typeof e.error === 'string') return e.error
    if (typeof e.detail === 'string') return e.detail
    if (typeof e.code === 'string')   return e.code
    try { return JSON.stringify(e).slice(0, 280) } catch { return '(unreadable error)' }
  }
  return String(e)
}

// TYPE column icon — interactive handle for previewing the source media
// straight from the table. The MEDIA column already shows a thumbnail
// (the cover when one is set), and clicking it defaults the overlay to
// the cover tab. This second handle is dedicated to the SOURCE video,
// because covered videos can otherwise hide the playable file under
// the "Source video" tab inside the overlay. Hover → mini popover
// preview that auto-plays muted. Click → opens the full overlay
// already focused on the video tab.
function TypeCell({ row, kindBorder, isVideo, isText, onPreview, onSelectView }) {
  const [hover, setHover] = useState(false)
  const wrapRef = useRef(null)
  // Prefer the cover-embedded video for previews — that's the asset
  // that actually publishes on non-IG platforms, so it's what the user
  // wants to see when they click play. Falls back to the raw upload
  // when no embed exists yet.
  const sourceVideo = isVideo
    ? (row.media_url_with_cover || (Array.isArray(row.media_urls) ? row.media_urls[0] : null))
    : null
  const sourceImage = !isVideo && !isText && Array.isArray(row.media_urls) ? row.media_urls[0] : null
  const previewable = !!sourceVideo || !!sourceImage
  const Icon = isVideo ? VideoIcon : isText ? Type : ImageIcon

  // Anchor rect for the floating mini-preview. Recomputed on hover so
  // the popover sits next to the cell regardless of table scroll.
  const [rect, setRect] = useState(null)
  useEffect(() => {
    if (!hover || !wrapRef.current) { setRect(null); return }
    setRect(wrapRef.current.getBoundingClientRect())
  }, [hover])

  const openVideoPreview = (e) => {
    e.stopPropagation()
    if (!previewable) return
    // Tell the overlay to land on the video tab specifically, so users
    // get straight to the playable source instead of the cover.
    if (sourceVideo) onSelectView?.('video')
    onPreview?.(sourceVideo ? 'video' : 'image')
  }

  return (
    <span
      ref={wrapRef}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{ display: 'inline-flex', position: 'relative' }}
    >
      <button
        type="button"
        onClick={openVideoPreview}
        disabled={!previewable}
        title={
          isText ? 'Text post'
          : !previewable ? 'No source media yet'
          : sourceVideo ? 'Click to play the source video (hover to peek)'
          : 'Click to view image'
        }
        aria-label={sourceVideo ? 'Preview source video' : 'Preview media'}
        style={{
          color: kindBorder,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          padding: 4, borderRadius: 6,
          background: previewable ? 'rgba(14,165,233,0.10)' : 'transparent',
          border: previewable ? '1px solid rgba(14,165,233,0.32)' : '1px solid transparent',
          cursor: previewable ? 'pointer' : 'default',
        }}
      >
        <Icon size={16} />
      </button>
      {/* Floating mini preview — portaled so it can escape the table's
          overflow/clip context. Position is computed from the cell's
          bounding rect on hover. Auto-plays muted so the user sees
          motion immediately without sound bleed. */}
      {hover && previewable && rect && createPortal(
        <div
          style={{
            position: 'fixed',
            top: Math.max(8, rect.top - 8),
            left: Math.min(window.innerWidth - 220, rect.right + 10),
            zIndex: 99,
            width: 200,
            background: '#000', borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.18)',
            boxShadow: '0 12px 28px rgba(0,0,0,0.45)',
            overflow: 'hidden',
            pointerEvents: 'none',  // hover stays attached to the trigger, not the preview
          }}
        >
          {sourceVideo ? (
            <video
              src={sourceVideo}
              autoPlay muted loop playsInline preload="metadata"
              style={{ width: '100%', aspectRatio: '9 / 16', objectFit: 'cover', display: 'block' }}
            />
          ) : (
            <img
              src={sourceImage}
              alt={row.title || 'preview'}
              style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', display: 'block' }}
            />
          )}
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            fontSize: 9.5, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase',
            padding: '5px 8px',
            background: 'linear-gradient(0deg, rgba(0,0,0,0.85), rgba(0,0,0,0))',
            color: '#fff', textAlign: 'center',
          }}>Source · click to play</div>
        </div>,
        document.body,
      )}
    </span>
  )
}

function PlatformsCell({ value, mediaType, onSave }) {
  const cur = Array.isArray(value) ? value : []
  const [open, setOpen] = useState(false)
  // anchor rect drives the portal positioning so the dropdown can escape
  // the table cell's overflow / clipping bounds and float above the
  // surrounding frame.
  const [anchor, setAnchor] = useState(null)
  const btnRef = useRef(null)
  const popRef = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      // Click-outside check has to look at BOTH the trigger button and
      // the portaled popover, since the popover lives outside the
      // component's DOM subtree.
      const t = e.target
      if (btnRef.current?.contains(t)) return
      if (popRef.current?.contains(t)) return
      setOpen(false)
    }
    const onScroll = () => {
      // Re-measure on scroll so the popover stays glued to the button.
      // Cheaper than a ResizeObserver because the cell rarely resizes.
      if (btnRef.current) setAnchor(btnRef.current.getBoundingClientRect())
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])
  const toggleOpen = () => {
    if (!open && btnRef.current) setAnchor(btnRef.current.getBoundingClientRect())
    setOpen((o) => !o)
  }
  const toggle = (id) => {
    const next = cur.includes(id) ? cur.filter((p) => p !== id) : [...cur, id]
    onSave(next)
  }
  const visible = ROW_PLATFORMS.filter((p) => !mediaType || p.kinds.includes(mediaType))

  // Position the popover relative to the viewport. If there's not
  // enough room below the button (eg the row is near the bottom of a
  // short table), flip above. Width matches the button so the dropdown
  // visually anchors but never shrinks below 180px.
  const POPOVER_HEIGHT_EST = Math.min(visible.length * 30 + 16, 320)
  let popoverStyle = null
  if (anchor) {
    const spaceBelow = window.innerHeight - anchor.bottom
    const flipUp = spaceBelow < POPOVER_HEIGHT_EST + 12 && anchor.top > POPOVER_HEIGHT_EST + 12
    popoverStyle = {
      position: 'fixed',
      left: Math.max(8, anchor.left),
      width: Math.max(180, anchor.width),
      zIndex: 1000,
      ...(flipUp
        ? { bottom: window.innerHeight - anchor.top + 4 }
        : { top: anchor.bottom + 4 }),
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggleOpen}
        style={{
          width: '100%', padding: '6px 8px', borderRadius: 6,
          border: '1px solid var(--border)', background: 'var(--surface-2)',
          color: 'var(--text-soft)', fontSize: 11.5, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4,
        }}
        title="Pick which platforms this row publishes to"
      >
        <span style={{ overflow: 'hidden', display: 'flex', alignItems: 'center', gap: 4 }}>
          {cur.length === 0
            ? <span style={{ color: 'var(--muted)' }}>Pick platforms</span>
            : cur.map((id) => <PlatformBadge key={id} id={id} size={18} />)}
        </span>
        <ChevronDown size={11} />
      </button>
      {open && popoverStyle && createPortal(
        <div
          ref={popRef}
          style={{
            ...popoverStyle,
            padding: 6, borderRadius: 8, maxHeight: 320, overflowY: 'auto',
            background: 'var(--surface)', border: '1px solid var(--border)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.32)',
          }}
        >
          {visible.map((p) => {
            const on = cur.includes(p.id)
            return (
              <button
                key={p.id} type="button"
                onClick={() => toggle(p.id)}
                style={{
                  width: '100%', padding: '6px 8px', borderRadius: 6, border: 'none',
                  background: on ? 'rgba(239,68,68,0.16)' : 'transparent',
                  color: on ? 'var(--text)' : 'var(--text-soft)',
                  fontSize: 12, textAlign: 'left', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {on ? <Check size={11} /> : <span style={{ width: 11 }} />} {p.label}
              </button>
            )
          })}
        </div>,
        document.body
      )}
    </div>
  )
}

const STATUS_TABS = [
  { id: 'queued',    label: 'Queued Posts',  filter: (s) => ['draft', 'caption_ready', 'scheduled'].includes(s.status) },
  { id: 'error',     label: 'Error',         filter: (s) => s.status === 'failed' },
  { id: 'delivered', label: 'Delivered',     filter: (s) => s.status === 'posted' },
]

// Convert a UTC ISO timestamp to the "YYYY-MM-DDTHH:mm" string format
// that <input type="datetime-local"> expects. The browser treats that
// value as LOCAL wall-clock, so we have to subtract the local timezone
// offset before slicing — a UTC-formatted string would otherwise show
// the user the UTC clock face instead of their own.
function toLocalDatetimeInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Direct upload helper. Mirrors what audio_upload + Avatars.jsx do.
async function uploadFileToBucket(file, profileId, kind) {
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase()
  const folder = kind === 'video' ? 'videos' : 'images'
  const path = `${profileId || 'shared'}/bulk/${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const { error } = await supabase.storage.from('landing-media').upload(path, file, {
    contentType: file.type || 'application/octet-stream', upsert: false,
  })
  if (error) throw new Error(error.message)
  const { data } = supabase.storage.from('landing-media').getPublicUrl(path)
  return data.publicUrl
}

function detectKind(file) {
  if (file.type?.startsWith('video/')) return 'video'
  if (file.type?.startsWith('image/')) return 'image'
  return /\.(mp4|mov|webm|m4v)$/i.test(file.name) ? 'video' : 'image'
}

// ── inline-editable cell ────────────────────────────────────────────────────
function EditableCell({ value, multiline = true, placeholder = '', onSave }) {
  const [draft, setDraft] = useState(value ?? '')
  const [focused, setFocused] = useState(false)
  useEffect(() => { setDraft(value ?? '') }, [value])
  const commit = () => {
    if ((draft ?? '') === (value ?? '')) return
    onSave(draft)
  }
  const Tag = multiline ? 'textarea' : 'input'
  return (
    <Tag
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit() }}
      onKeyDown={(e) => {
        if (!multiline && e.key === 'Enter') { e.target.blur() }
        if (e.key === 'Escape') { setDraft(value ?? ''); e.target.blur() }
      }}
      rows={multiline ? 3 : undefined}
      style={{ ...cellInput, ...(focused ? cellInputFocus : {}) }}
    />
  )
}

// Tabbed caption editor for text-only rows that carry per-platform
// variants (text_post_gen → schedule_post output). Each platform's
// variant is editable inline; saves PATCH the per_platform_text jsonb
// in one shot. Character count vs the platform cap shown below the
// textarea so the user can see when they're over.
const PER_PLATFORM_CAPS = { x: 280, threads: 500, facebook: 5000, linkedin: 3000 }
function PerPlatformCaptionCell({ value, onSave }) {
  const platforms = Object.keys(value || {}).filter((k) => PER_PLATFORM_CAPS[k])
  const [activeTab, setActiveTab] = useState(platforms[0] || 'x')
  const [draft, setDraft] = useState((value && value[activeTab]) || '')
  // Reset draft whenever the saved row value changes (or the user
  // switches tabs). Avoids leaking edits across rows after auto-refresh.
  useEffect(() => { setDraft((value && value[activeTab]) || '') }, [value, activeTab])
  useEffect(() => {
    if (!platforms.includes(activeTab)) setActiveTab(platforms[0] || 'x')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platforms.join('|')])
  if (!platforms.length) return null
  const cap = PER_PLATFORM_CAPS[activeTab] || 1000
  const over = draft.length > cap
  const commit = () => {
    if (draft === (value?.[activeTab] || '')) return
    onSave({ ...(value || {}), [activeTab]: draft })
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 2, marginBottom: 4, flexWrap: 'wrap' }}>
        {platforms.map((p) => {
          const def = ROW_PLATFORMS.find((x) => x.id === p)
          const isActive = p === activeTab
          return (
            <button
              key={p} type="button"
              onClick={() => setActiveTab(p)}
              title={def?.label || p}
              style={{
                padding: '3px 5px', borderRadius: 4,
                background: isActive ? 'var(--surface-2)' : 'transparent',
                border: `1px solid ${isActive ? 'var(--border)' : 'transparent'}`,
                cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3,
                fontSize: 10, color: isActive ? 'var(--text)' : 'var(--muted)',
                fontFamily: 'var(--font-display)', fontWeight: 700,
              }}
            >
              <PlatformBadge id={p} size={12} />
              {def?.label || p}
            </button>
          )
        })}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Escape') { setDraft(value?.[activeTab] || ''); e.target.blur() } }}
        rows={3}
        style={{ ...cellInput, fontSize: 11.5 }}
      />
      <div style={{ fontSize: 9.5, color: over ? 'var(--red)' : 'var(--muted)', marginTop: 2, textAlign: 'right' }}>
        {draft.length} / {cap}
      </div>
    </div>
  )
}

// ── status pill ─────────────────────────────────────────────────────────────
// Status pill color contract:
//   gray   draft         — sitting on the canvas, not promoted yet
//   amber  caption_ready — Claude wrote captions, awaiting a slot
//   green  scheduled     — queued to fire (the most actionable state)
//   blue   posted        — already went out, archival
//   red    failed        — needs attention
const PILL = {
  draft:         { bg: 'rgba(255,255,255,0.06)', fg: 'var(--muted)', label: 'Draft' },
  caption_ready: { bg: 'rgba(245,158,11,0.16)',  fg: '#f59e0b',     label: 'Caption ready' },
  scheduled:     { bg: 'rgba(46,204,113,0.16)',  fg: '#2ecc71',     label: 'Scheduled' },
  posted:        { bg: 'rgba(96,165,250,0.16)',  fg: '#60a5fa',     label: 'Published' },
  failed:        { bg: 'rgba(239,68,68,0.16)',   fg: 'var(--red)',  label: 'Failed' },
}
function StatusPill({ status, error }) {
  const p = PILL[status] || PILL.draft
  // Failed rows: show the Upload-Post error on hover so users can
  // self-diagnose instead of pinging support every time.
  const tooltip = status === 'failed' && error ? error : undefined
  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 8px', borderRadius: 999,
        background: p.bg, color: p.fg,
        fontSize: 10.5, fontFamily: 'var(--font-display)', fontWeight: 700,
        letterSpacing: '0.04em',
        cursor: tooltip ? 'help' : 'default',
      }}
    >{p.label}{tooltip ? ' ⓘ' : ''}</span>
  )
}

// ── main component ──────────────────────────────────────────────────────────
// Track a viewport-width threshold reactively. Returns true while the
// window is at or below `maxWidth`. Used to swap the wide schedule
// table for a stacked card list on phones, drop non-essential columns
// on iPad, and tighten paddings throughout the upload header.
function useIsNarrow(maxWidth) {
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth <= maxWidth
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = () => setIsNarrow(window.innerWidth <= maxWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [maxWidth])
  return isNarrow
}

export default function BulkUploadView({ profileId, token, onChange }) {
  // Two breakpoints:
  //   isPhone  (<= 700px)  → card layout for posts, single-column header,
  //                          icon-only secondary actions
  //   isTablet (<= 1024px) → keep the table but drop hashtags + 1st comment,
  //                          stack autopilot toggles in 2 columns
  // Both check against the live window width so a portrait/landscape
  // flip on iPad reflows immediately.
  const isPhone = useIsNarrow(700)
  const isTablet = useIsNarrow(1024)
  const [scripts, setScripts] = useState(null) // null = loading, [] = empty
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('queued')
  // Post-kind filter chip: all | video | image | text. Quick way to
  // narrow the queue when you only want to see (say) all text posts
  // landing this week.
  const [kindFilter, setKindFilter] = useState('all')
  // Date-range filter for the scheduled_datetime field. 'all' is the
  // default (everything visible regardless of when it fires). 'today',
  // 'week', '7d' are quick presets — 'custom' arms the two from/to
  // inputs below.
  const [dateRange, setDateRange] = useState('all') // 'all' | 'today' | 'week' | '7d' | 'custom'
  // Sort order — newest scheduled first vs oldest first. Persisted to
  // localStorage so it sticks across reloads.
  const [sortOrder, setSortOrderState] = useState(() => {
    try { return localStorage.getItem('scalesolo:bulk:sortOrder') === 'newest' ? 'newest' : 'oldest' } catch { return 'oldest' }
  })
  const setSortOrder = (v) => {
    setSortOrderState(v)
    try { localStorage.setItem('scalesolo:bulk:sortOrder', v) } catch {}
  }
  const [customFrom, setCustomFrom] = useState('')  // YYYY-MM-DD
  const [customTo, setCustomTo] = useState('')      // YYYY-MM-DD
  const [selected, setSelected] = useState(new Set())
  const [search, setSearch] = useState('')
  const [busyAction, setBusyAction] = useState(null) // 'captions' | 'schedule' | 'publish'
  const [uploads, setUploads] = useState([]) // {id, name, kind, progress, error?}
  const [previewItem, setPreviewItem] = useState(null) // { url, type, title, coverUrl?, videoUrl? } for fullscreen media preview
  // When the preview row has BOTH a generated cover and a source video,
  // this tracks which one the user is currently looking at. Defaults to
  // whichever the thumbnail showed (the row's "primary" thumb).
  const [previewView, setPreviewView] = useState('primary') // 'primary' | 'cover' | 'video'
  // When ON, every uploaded file fans out into:
  //   1. POST /api/content/bulk-actions?action=generate-captions  → fills title/caption/hashtags/first_comment
  //   2. POST /api/content/bulk-actions?action=auto-schedule       → assigns the next open slot from the profile's posting schedule
  // The toggle is sticky per browser via localStorage so the preference
  // matches what the user expects on every visit.
  const [autoProcess, setAutoProcess] = useState(() => {
    try { return localStorage.getItem('scalesolo:bulk:autoProcess') !== 'off' } catch { return true }
  })
  const setAutoProcessSticky = (v) => {
    setAutoProcess(v)
    try { localStorage.setItem('scalesolo:bulk:autoProcess', v ? 'on' : 'off') } catch {}
  }

  // Polish toggle — when ON, every uploaded video is polished (title
  // overlay, watermark, captions, music) BEFORE captions/scheduling
  // kick in. Sticky per browser like Autopilot. The polish settings
  // template ITSELF lives on profiles.polish_template (per-brand, shared
  // with the Spaces video_polish node so editing on either surface
  // keeps both in sync).
  const [polishEnabled, setPolishEnabled] = useState(() => {
    try { return localStorage.getItem('scalesolo:bulk:polishEnabled') === 'on' } catch { return false }
  })
  const setPolishEnabledSticky = (v) => {
    setPolishEnabled(v)
    try { localStorage.setItem('scalesolo:bulk:polishEnabled', v ? 'on' : 'off') } catch {}
  }
  // The polish template object loaded from the brand profile. Null until
  // the profile fetch lands. Modal opens on the gear click.
  const [polishTemplate, setPolishTemplate] = useState(null)
  const [polishSettingsOpen, setPolishSettingsOpen] = useState(false)
  // Brand logo URL — used as the watermark image when polish runs.
  const [brandLogoUrl, setBrandLogoUrl] = useState(null)

  // Generate cover toggle — when ON, after captions land we generate a
  // per-post Instagram cover by feeding the brand's cover_template
  // through gpt-image-2-image-to-image with each row's fresh title.
  // Sticky per browser like Autopilot / Polish. Requires the brand to
  // have a cover_template set; otherwise the toggle stays inert with a
  // hint pointing the user at the brand profile.
  const [coverEnabled, setCoverEnabled] = useState(() => {
    try { return localStorage.getItem('scalesolo:bulk:coverEnabled') === 'on' } catch { return false }
  })
  const setCoverEnabledSticky = (v) => {
    setCoverEnabled(v)
    try { localStorage.setItem('scalesolo:bulk:coverEnabled', v ? 'on' : 'off') } catch {}
  }
  // True once profile fetch lands AND brand.cover_template.image_url is
  // a non-empty string. Drives the disabled state on the toggle.
  const [hasCoverTemplate, setHasCoverTemplate] = useState(false)
  // Mirror state into refs so the async pipeline (runAutoPipeline) reads
  // the LIVE values at gate-check time instead of whatever was captured
  // in the closure when the function started. Without this, the cover
  // gate silently skipped when the user uploaded before the profile
  // fetch landed — the long awaits inside the pipeline give the fetch
  // time to update state, but the captured `false` is what got checked
  // (confirmed via console diagnostic: profile-fetch log said
  // computed_hasCoverTemplate=true while autopilot log said
  // hasCoverTemplate=false in the same browser session).
  const hasCoverTemplateRef = useRef(false)
  const coverEnabledRef = useRef(false)
  // polishEnabledRef mirrors the same stale-closure fix we already apply
  // to coverEnabled. runAutoPipeline is created at mount time, so if the
  // user uploaded files before React state hydrated from localStorage,
  // the captured `polishEnabled=false` would beat the live toggle. That
  // produced the symptom Ray hit: Polish video shown ON in the UI, the
  // pipeline still took the embed-only branch, and the row's
  // media_url_with_cover landed under /spaces/cover-intro/ instead of
  // /spaces/polished/ — i.e. cover prepended but music never mixed.
  const polishEnabledRef = useRef(false)
  // polishTemplateRef mirrors the fetched brand polish template the
  // same way coverEnabledRef does for the cover toggle. Without it,
  // if the user drops files before /api/profiles resolves, runAutoPipeline
  // captures polishTemplate=null in its closure, buildPolishBody emits
  // an empty body, polish.js's wantsFfmpegEarly returns false, and
  // polish silently no-ops returning the source URL — which is exactly
  // the symptom Ray hit: media_url_with_cover identical to the source.
  const polishTemplateRef = useRef(null)
  useEffect(() => { hasCoverTemplateRef.current = hasCoverTemplate }, [hasCoverTemplate])
  useEffect(() => { coverEnabledRef.current = coverEnabled }, [coverEnabled])
  useEffect(() => { polishEnabledRef.current = polishEnabled }, [polishEnabled])
  useEffect(() => { polishTemplateRef.current = polishTemplate }, [polishTemplate])
  // Mount-time read from localStorage so the FIRST upload after a hard
  // refresh sees the persisted value, not the React-state default.
  useEffect(() => {
    try { coverEnabledRef.current = localStorage.getItem('scalesolo:bulk:coverEnabled') === 'on' } catch {}
    try { polishEnabledRef.current = localStorage.getItem('scalesolo:bulk:polishEnabled') === 'on' } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Tracks "we're running the auto-pipeline right now" so the toolbar
  // shows the right status banner instead of a silent spinner.
  const [autoStage, setAutoStage] = useState(null) // null | 'captions' | 'schedule'
  // Tracks the id of the row currently being normalized via the Compress
  // button. Disables the button + shows a spinner; null when idle.
  const [compressingId, setCompressingId] = useState(null)
  // Default platforms for newly-uploaded rows — sourced from the
  // profile's uploadpost_platforms (set during onboarding / Profiles
  // editor). Empty until the fetch lands; filtered per row by media
  // kind support (TikTok/YouTube reject images, etc.).
  const [defaultPlatforms, setDefaultPlatforms] = useState([])
  const dropRef = useRef(null)
  const fileRef = useRef(null)

  // Fetch the profile's preferred platforms once per profile change so
  // we can pre-fill new rows on upload without round-tripping per file.
  useEffect(() => {
    if (!profileId || !token) { setDefaultPlatforms([]); return }
    let cancelled = false
    fetch(`/api/profiles`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((b) => {
        if (cancelled) return
        const p = (b?.profiles || []).find((x) => x.id === profileId)
        const arr = Array.isArray(p?.uploadpost_platforms) ? p.uploadpost_platforms : []
        setDefaultPlatforms(arr)
        // Pull the brand's polish template alongside platforms. Empty
        // object is fine — the video_polish node falls through to its
        // initialProps defaults when fields are missing.
        setPolishTemplate(p?.polish_template && typeof p.polish_template === 'object' ? p.polish_template : {})
        setBrandLogoUrl(p?.logo_url || null)
        // Cover template presence drives the Generate cover toggle's
        // enabled state. No template = nothing for the cover-gen API
        // to use, so we keep the toggle disabled until the brand
        // uploads one on the Profile page.
        const tpl = p?.cover_template
        const hasIt = !!(tpl && typeof tpl === 'object' && typeof tpl.image_url === 'string' && tpl.image_url.trim())
        setHasCoverTemplate(hasIt)
        // Diagnostic — surface exactly what the server returned. The
        // cover step was silently skipping in production with
        // hasCoverTemplate=false even though the DB had the value;
        // this log helps confirm whether the API response carries
        // cover_template at all, what shape it is, and the computed
        // boolean. Remove once the gate stops misfiring.
        // eslint-disable-next-line no-console
        console.log('[bulk-upload profile fetch]', {
          profileId,
          found_profile: !!p,
          cover_template_present: tpl !== undefined && tpl !== null,
          cover_template_type: typeof tpl,
          cover_template_value: tpl,
          computed_hasCoverTemplate: hasIt,
          all_columns_on_profile: p ? Object.keys(p) : null,
        })
      })
      .catch(() => {
        if (!cancelled) {
          setDefaultPlatforms([]); setPolishTemplate({}); setBrandLogoUrl(null); setHasCoverTemplate(false)
        }
      })
    return () => { cancelled = true }
  }, [profileId, token])

  // Polish one uploaded video using the brand's saved polish template.
  // Mirrors the per-prop spec the video_polish node sends to
  // /api/videos/polish — but skipping all the upstream-wiring logic
  // (multi-clip, voice_gen, etc.) since bulk upload is always
  // single-video-per-file. Returns the polished URL on success, or
  // the original URL on failure (with a console warn) so the row
  // still lands on the calendar instead of being lost.
  // polishOneVideoWithCover: same as polishOneVideo but for the
  // autopilot stage that runs AFTER cover-gen. Accepts cover_image_url
  // + embed_cover_intro and returns the full response (so the caller
  // can decide which DB field to write the URL to). polishOneVideo is
  // the legacy per-upload wrapper kept around for one-off polish runs.
  const polishOneVideoWithCover = async (videoUrl, { cover_image_url, embed_cover_intro }) => {
    const body = buildPolishBody(videoUrl, { cover_image_url, embed_cover_intro })
    const r = await fetch('/api/videos/polish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    const resp = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(resp?.error || `Polish failed (${r.status})`)
    if (!resp?.video_url) throw new Error('Polish returned no video_url')
    return resp
  }

  // Single source of truth for the polish request body, used by both
  // the legacy per-upload polishOneVideo wrapper and the autopilot
  // polishOneVideoWithCover stage. Centralises the template → request
  // mapping so both paths produce identical results.
  //
  // Reads from polishTemplateRef.current (live) instead of the
  // closure-captured polishTemplate state. Critical for the autopilot
  // path: runAutoPipeline is defined per render and captures whatever
  // polishTemplate was at that render. If the user drops files before
  // /api/profiles resolves, the captured template is null/empty, the
  // body emits no music/title/watermark, polish.js short-circuits to
  // no_op, and media_url_with_cover ends up identical to the source.
  // The ref dodges that staleness.
  const buildPolishBody = (videoUrl, extras = {}) => {
    const tpl = polishTemplateRef.current || polishTemplate || {}
    const titleStyle = {
      font:        tpl.title_font || 'Montserrat ExtraBold',
      color:       tpl.title_color || '#ffffff',
      bg_color:    tpl.title_bg_color || '#e0467a',
      size:        tpl.title_size || 72,
      bg_padding:  tpl.title_bg_padding || 28,
      bg_mode:     tpl.title_bg_mode || 'block',
      y_pos:       tpl.title_y_pos || 15,
      uppercase:   !!tpl.title_uppercase,
      mode:        tpl.title_mode || 'auto',
      topic:       tpl.title_topic || '',
    }
    const captionsEnabled = !!(tpl.captions_enabled !== false && tpl.caption_template_id)
    return {
      profile_id: profileId,
      video_url: videoUrl,
      title: tpl.title_enabled !== false ? (tpl.title_mode === 'manual' ? (tpl.title || '') : '') : '',
      title_style: titleStyle,
      logo_url: brandLogoUrl || undefined,
      watermark_image_url: brandLogoUrl || undefined,
      watermark_position: tpl.watermark_position || 'br',
      watermark_size_pct: typeof tpl.watermark_size_pct === 'number' ? tpl.watermark_size_pct : 25,
      music_url: tpl.music_url || undefined,
      music_volume: typeof tpl.music_volume === 'number' ? tpl.music_volume : 0.15,
      music_fade_secs: typeof tpl.music_fade_secs === 'number' ? tpl.music_fade_secs : 1.0,
      captions_enabled: captionsEnabled,
      caption_template_id: captionsEnabled ? tpl.caption_template_id : undefined,
      // Cover-intro params — worker prepends the cover image as a
      // 0.5s static intro to the final polish output when set.
      cover_image_url: extras.cover_image_url || undefined,
      embed_cover_intro: !!extras.embed_cover_intro,
    }
  }

  const polishOneVideo = async (videoUrl, jobId) => {
    const tpl = polishTemplate || {}
    // Build title_style from the loose props the template stores —
    // same shape the canvas builds.
    const titleStyle = {
      font:        tpl.title_font || 'Montserrat ExtraBold',
      color:       tpl.title_color || '#ffffff',
      bg_color:    tpl.title_bg_color || '#e0467a',
      size:        tpl.title_size || 72,
      bg_padding:  tpl.title_bg_padding || 28,
      bg_mode:     tpl.title_bg_mode || 'block',
      y_pos:       tpl.title_y_pos || 15,
      uppercase:   !!tpl.title_uppercase,
      mode:        tpl.title_mode || 'auto',
      topic:       tpl.title_topic || '',
    }
    // Captions ON by default if the template has a template id
    // chosen. If not, we run polish WITHOUT captions instead of
    // failing loudly — the bulk-upload flow shouldn't block on a
    // missing caption template (different from the canvas where
    // missing it is a hard error).
    const captionsEnabled = !!(tpl.captions_enabled !== false && tpl.caption_template_id)
    const body = {
      profile_id: profileId,
      video_url: videoUrl,
      title: tpl.title_enabled !== false ? (tpl.title_mode === 'manual' ? (tpl.title || '') : '') : '',
      title_style: titleStyle,
      logo_url: brandLogoUrl || undefined,
      watermark_image_url: brandLogoUrl || undefined,
      watermark_position: tpl.watermark_position || 'br',
      watermark_size_pct: typeof tpl.watermark_size_pct === 'number' ? tpl.watermark_size_pct : 25,
      music_url: tpl.music_url || undefined,
      music_volume: typeof tpl.music_volume === 'number' ? tpl.music_volume : 0.15,
      music_fade_secs: typeof tpl.music_fade_secs === 'number' ? tpl.music_fade_secs : 1.0,
      captions_enabled: captionsEnabled,
      caption_template_id: captionsEnabled ? tpl.caption_template_id : undefined,
    }
    setUploads((u) => u.map((x) => x.id === jobId ? { ...x, polishing: true } : x))
    try {
      const r = await fetch('/api/videos/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      const resp = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(resp?.error || `Polish failed (${r.status})`)
      if (!resp?.video_url) throw new Error('Polish returned no video_url')
      return resp.video_url
    } catch (e) {
      console.warn(`[bulk polish] ${jobId} failed, falling back to original:`, e?.message)
      toast({ kind: 'warn', message: `Couldn't polish that video — saved the original instead. (${fmtErr(e) || 'unknown'})` })
      return videoUrl
    } finally {
      setUploads((u) => u.map((x) => x.id === jobId ? { ...x, polishing: false } : x))
    }
  }

  // Patch a slice of the polish template and persist to the brand
  // profile. Used both by the modal editor (every keystroke) and by
  // future code paths that need to update it. Optimistic local update
  // first so the modal stays responsive while the PATCH is in flight.
  const patchPolishTemplate = async (patch) => {
    const next = { ...(polishTemplate || {}), ...patch }
    setPolishTemplate(next)
    try {
      await fetch(`/api/profiles?id=${encodeURIComponent(profileId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ polish_template: next }),
      })
    } catch (e) {
      console.warn('polish_template save failed:', e?.message)
      toast({ kind: 'warn', message: 'Polish settings didn\'t save. Check your connection and retry.' })
    }
  }

  // Esc closes the preview overlay.
  useEffect(() => {
    if (!previewItem) return
    const onKey = (e) => { if (e.key === 'Escape') { setPreviewItem(null); setPreviewView('primary') } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewItem])

  // ── load ──────────────────────────────────────────────────────────────────
  const refresh = async () => {
    if (!profileId || !token) return
    try {
      const r = await fetch(`/api/content?profile_id=${profileId}&filter=library`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error || `Load failed (${r.status})`)
      setScripts(Array.isArray(body.items) ? body.items : [])
      setError(null)
    } catch (e) { setError(e.message); setScripts([]) }
  }
  useEffect(() => { refresh() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [profileId, token])

  // ── upload ────────────────────────────────────────────────────────────────
  const onFiles = async (files) => {
    if (!files || !files.length) return
    if (!profileId) { toast({ kind: 'warn', message: 'Pick a brand profile first.' }); return }
    const queue = Array.from(files).map((f) => ({
      id: `up_${Math.random().toString(36).slice(2)}`,
      name: f.name, kind: detectKind(f), file: f, progress: 0,
    }))
    setUploads((u) => [...u, ...queue])

    // Bulletproof the platform pre-fill. If the user uploads BEFORE the
    // background profile fetch in the useEffect above has landed (eg
    // immediately after profile switch or page refresh), defaultPlatforms
    // is still [] and every new row would be saved with platforms=NULL.
    // Force-fetch here so we always have the current connected platforms
    // when the row is created — the result is also pushed into state so
    // a re-upload in the same session skips the round trip.
    let resolvedPlatforms = defaultPlatforms
    if (!resolvedPlatforms.length) {
      try {
        const r = await fetch(`/api/profiles`, { headers: { Authorization: `Bearer ${token}` } })
        const b = await r.json()
        const p = (b?.profiles || []).find((x) => x.id === profileId)
        const arr = Array.isArray(p?.uploadpost_platforms) ? p.uploadpost_platforms : []
        resolvedPlatforms = arr
        setDefaultPlatforms(arr)
      } catch { /* fall through with [] — the row gets platforms=null and the user can fix it inline */ }
    }

    // Collect IDs of newly-created content_scripts rows so we can hand
    // them to the auto-process pipeline below. Failed uploads aren't in
    // here; they show as red rows in the upload list and the user can
    // retry manually.
    const createdIds = []
    for (const job of queue) {
      try {
        setUploads((u) => u.map((x) => x.id === job.id ? { ...x, progress: 30 } : x))
        const url = await uploadFileToBucket(job.file, profileId, job.kind)
        // Polish moved out of the per-upload loop. It now runs as a
        // dedicated autopilot stage AFTER cover generation, so when
        // both toggles are on the polish job can prepend the freshly
        // generated cover as a 0.5s intro in the same worker call.
        // Single ffmpeg pass instead of polish + separate prepend, and
        // — critically — never falls back to the raw video before the
        // user notices because polish has actually run.
        setUploads((u) => u.map((x) => x.id === job.id ? { ...x, progress: 70 } : x))
        // Pre-select the profile's preferred platforms, filtered to ones
        // that actually accept this media kind (TikTok/YouTube reject
        // images, for example). The PlatformsCell still lets the user
        // override per row.
        const compatibleByKind = new Set(
          ROW_PLATFORMS.filter((p) => p.kinds.includes(job.kind)).map((p) => p.id)
        )
        const platforms = resolvedPlatforms.filter((p) => compatibleByKind.has(p))

        // Create the content_scripts row.
        const r = await fetch('/api/content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            profile_id: profileId,
            title: job.name.replace(/\.[^.]+$/, '').slice(0, 80),
            media_urls: [url], media_type: job.kind,
            post_type: job.kind === 'video' ? 'video' : 'post',
            status: 'draft', generated_by: 'bulk',
            platforms: platforms.length ? platforms : null,
          }),
        })
        const body = await r.json()
        if (!r.ok) throw new Error(body?.error || `Create row failed (${r.status})`)
        if (body?.item?.id) createdIds.push(body.item.id)
        setUploads((u) => u.map((x) => x.id === job.id ? { ...x, progress: 100 } : x))
        // Drop completed entries after a brief beat.
        setTimeout(() => setUploads((u) => u.filter((x) => x.id !== job.id)), 800)
      } catch (e) {
        setUploads((u) => u.map((x) => x.id === job.id ? { ...x, error: e.message } : x))
      }
    }
    refresh()
    onChange?.()

    // Auto-pipeline: caption + auto-schedule the rows we just created.
    // Both endpoints already exist and gate on credits; we just chain
    // them and surface a single toast when the whole run finishes.
    if (autoProcess && createdIds.length > 0) {
      await runAutoPipeline(createdIds)
    }
  }

  // Two-step background pipeline triggered after a bulk upload:
  //   1. generate-captions → Claude reads each row's media + brand bible,
  //      writes title/caption/hashtags/first_comment, flips status to
  //      caption_ready.
  //   2. auto-schedule → walks the profile's posting_schedule and
  //      assigns the next open slot to each new row, status=scheduled.
  // Both run server-side, so the user gets a coffee while it works.
  const runAutoPipeline = async (ids) => {
    try {
      setAutoStage('captions')
      const c = await fetch(`/api/content/bulk-actions?action=generate-captions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile_id: profileId, script_ids: ids }),
      })
      const cb = await c.json().catch(() => ({}))
      if (!c.ok) {
        if (c.status === 402) {
          toast({ kind: 'error', message: 'Auto-caption skipped: not enough AI credits. Add credits, then click Generate Captions.' })
        } else {
          toast({ kind: 'error', message: `Auto-caption failed: ${fmtErr(cb?.error) || c.status}. Rows are saved as drafts.` })
        }
        return
      }
      // Only schedule rows that actually got captions. Anything that
      // failed transcription (silent / music-only video, Scribe error)
      // stays at status=pending so the user has to write the caption
      // before it ships. Without this, blank captions auto-posted —
      // we don't want that.
      const failedIds = new Set((cb.transcript_failures || []).map((f) => f.id))
      const schedulableIds = ids.filter((id) => !failedIds.has(id))

      // ── Cover generation step ────────────────────────────────────────
      // Runs AFTER captions land (so titles are fresh) and BEFORE
      // auto-schedule (so the Upload-Post submission carries
      // instagram_cover_url). Only fires when:
      //   • coverEnabled toggle is on
      //   • brand has a cover_template set
      //   • there's at least one schedulable row
      // Failures degrade gracefully — the row goes to schedule WITHOUT
      // a cover. We never block the autopilot pipeline on cover gen.
      let coversGenerated = 0
      let coversFailed = 0
      // IDs whose cover landed in step 4. The embed step (step 4.5) only
      // runs for these — there's nothing to embed if the cover step
      // skipped or failed for a row.
      const coveredIds = []
      // Read the LIVE state values via refs (not closure-captured) so
      // the gate uses whatever's true RIGHT NOW, not whatever was true
      // when runAutoPipeline was created (which could have been before
      // the profile fetch landed).
      const liveCoverEnabled = coverEnabledRef.current
      const liveHasCoverTemplate = hasCoverTemplateRef.current
      // Diagnostic — log both the closure-captured values and the live
      // ref values so we can keep an eye on whether the stale-closure
      // fix is doing what we expect in production.
      // eslint-disable-next-line no-console
      console.log('[autopilot]', {
        closure_coverEnabled: coverEnabled,
        closure_hasCoverTemplate: hasCoverTemplate,
        live_coverEnabled: liveCoverEnabled,
        live_hasCoverTemplate: liveHasCoverTemplate,
        schedulable_count: schedulableIds.length,
        will_run_cover_step: !!(liveCoverEnabled && liveHasCoverTemplate && schedulableIds.length),
      })
      if (!liveCoverEnabled || !liveHasCoverTemplate || !schedulableIds.length) {
        const reason = !liveCoverEnabled ? 'toggle is off'
          : !liveHasCoverTemplate ? 'brand has no cover_template set'
          : 'no schedulable rows (transcription likely failed for everything)'
        // Surface a visible info toast so the user knows WHY the cover
        // step was skipped — much better than silently leaving rows
        // without covers and making them check the DB.
        if (liveCoverEnabled || liveHasCoverTemplate) {  // skip the toast if neither was even intended
          toast({
            kind: 'warn',
            message: `Cover generation skipped: ${reason}. Captions still ran; rows will schedule without covers.`,
          })
        }
      }
      if (liveCoverEnabled && liveHasCoverTemplate && schedulableIds.length) {
        setAutoStage('covers')
        // Process serially. Each cover poll is 30-60s and consumes
        // 4000 ai_tokens; parallel would slam KIE + Anthropic in a
        // way that creates noise without much speedup on this volume.
        for (const id of schedulableIds) {
          try {
            const startResp = await fetch('/api/content/generate-cover?action=start', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ script_id: id }),
            })
            const startBody = await startResp.json().catch(() => ({}))
            if (!startResp.ok || !startBody.taskId) {
              coversFailed += 1
              console.warn(`[bulk cover] ${id} start failed:`, startBody?.error)
              continue
            }
            // Poll up to ~3 min per row — same threshold as the
            // workflow runner uses, since the underlying generation
            // is the same gpt-image-2 call.
            const taskId = startBody.taskId
            const POLL_MS = 4000
            const TIMEOUT_MS = 3 * 60_000
            const started = Date.now()
            let coverUrl = null
            let coverError = null
            while (Date.now() - started < TIMEOUT_MS) {
              await new Promise((r) => setTimeout(r, POLL_MS))
              const statusResp = await fetch(`/api/images/status?taskId=${encodeURIComponent(taskId)}`, {
                headers: { Authorization: `Bearer ${token}` },
              })
              const statusBody = await statusResp.json().catch(() => ({}))
              if (!statusResp.ok) { coverError = statusBody?.error || `status ${statusResp.status}`; break }
              if (statusBody.state === 'success' && Array.isArray(statusBody.images) && statusBody.images.length) {
                coverUrl = statusBody.images[0]?.url || statusBody.images[0]
                break
              }
              if (statusBody.state === 'failed') { coverError = statusBody.error || 'generation failed'; break }
            }
            if (!coverUrl) {
              coversFailed += 1
              console.warn(`[bulk cover] ${id} ${coverError || 'timed out'}`)
              continue
            }
            // Commit the chosen URL to the row.
            const commitResp = await fetch('/api/content/generate-cover?action=commit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ script_id: id, image_url: coverUrl }),
            })
            if (!commitResp.ok) {
              coversFailed += 1
              console.warn(`[bulk cover] ${id} commit failed`)
              continue
            }
            coversGenerated += 1
            coveredIds.push(id)
          } catch (e) {
            coversFailed += 1
            console.warn(`[bulk cover] ${id} threw:`, e?.message)
          }
        }
      }

      // ── Polish step (and cover-intro embed) ─────────────────────────
      // Runs AFTER covers land + BEFORE schedule, so when both polish
      // and cover are enabled the worker prepends the freshly
      // generated cover image as a 0.5s intro inside the same job.
      // Single worker call instead of polish-then-prepend, single
      // returned URL, no race between the two ffmpeg passes.
      //
      // When polishEnabled is OFF but cover IS enabled, we still call
      // the prepend-cover endpoint as a fallback so non-IG platforms
      // see the cover as the start-frame thumbnail. The two-step path
      // only kicks in for that minority case.
      let polishedCount = 0
      let polishFailed = 0
      let embedsBuilt = 0
      let embedsFailed = 0
      const livePolishEnabled = polishEnabledRef.current
      // eslint-disable-next-line no-console
      console.log('[autopilot:polish-gate]', {
        closure_polishEnabled: polishEnabled,
        live_polishEnabled: livePolishEnabled,
        schedulable: schedulableIds.length,
      })
      if (livePolishEnabled && schedulableIds.length) {
        setAutoStage('polish')
        // Belt-and-suspenders: if the brand profile fetch hasn't
        // resolved yet (e.g. user dropped files immediately on page
        // load), refetch the polish template synchronously so we
        // never call /api/videos/polish with an empty body. Without
        // this, polish.js's wantsFfmpegEarly returns false and the
        // endpoint no-ops, returning the source URL unchanged.
        if (!polishTemplateRef.current || Object.keys(polishTemplateRef.current).length === 0) {
          try {
            const profR = await fetch('/api/profiles', { headers: { Authorization: `Bearer ${token}` } })
            const profBody = await profR.json().catch(() => ({}))
            const p = (profBody?.profiles || []).find((x) => x.id === profileId)
            if (p?.polish_template && typeof p.polish_template === 'object') {
              polishTemplateRef.current = p.polish_template
              setPolishTemplate(p.polish_template)
              // eslint-disable-next-line no-console
              console.log('[autopilot:polish] refetched template inline', Object.keys(p.polish_template))
            }
          } catch (e) {
            console.warn('[autopilot:polish] inline template refetch failed', e?.message)
          }
        }
        // Pull each row's current media_urls + cover_image_url so we
        // can hand the polish call the right inputs and pick up the
        // cover URL we just committed in step 4.
        try {
          const rRows = await fetch(
            `/api/content?profile_id=${encodeURIComponent(profileId)}&filter=library`,
            { headers: { Authorization: `Bearer ${token}` } }
          )
          const rb = await rRows.json().catch(() => ({}))
          const lookup = new Map((rb?.items || []).map((it) => [it.id, it]))
          for (const id of schedulableIds) {
            const row = lookup.get(id)
            if (!row || row.media_type !== 'video') continue
            const sourceUrl = Array.isArray(row.media_urls) ? row.media_urls[0] : null
            if (!sourceUrl) continue
            // Build polish body from the brand-level polish template
            // PLUS row-level cover. polishOneVideo already builds the
            // template body; we just need to pass cover params and
            // capture the result URL.
            try {
              const polished = await polishOneVideoWithCover(sourceUrl, {
                cover_image_url: row.cover_image_url || null,
                embed_cover_intro: !!row.cover_image_url && row.embed_cover_intro !== false,
              })
              if (polished?.video_url) {
                // Persist the polished output. When cover-intro was
                // embedded, write to media_url_with_cover so non-IG
                // platforms get the cover-baked-in version + IG keeps
                // its native cover_image_url path. Otherwise update
                // media_urls[0] so the polish is the canonical asset.
                const wantsCover = !!row.cover_image_url && row.embed_cover_intro !== false
                const patchBody = wantsCover
                  ? { media_url_with_cover: polished.video_url }
                  : { media_urls: [polished.video_url] }
                await fetch(`/api/content?id=${id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                  body: JSON.stringify(patchBody),
                }).catch(() => {})
                polishedCount += 1
                if (wantsCover) embedsBuilt += 1
              } else {
                polishFailed += 1
              }
            } catch (e) {
              polishFailed += 1
              console.warn(`[bulk polish] ${id} failed:`, e?.message)
            }
          }
        } catch (e) {
          console.warn('[bulk polish] row fetch failed:', e?.message)
        }
      } else if (coveredIds.length) {
        // Polish toggle off but covers landed. Run the lightweight
        // prepend-cover endpoint so non-IG platforms still see the
        // cover as the start-frame thumbnail.
        setAutoStage('embed')
        for (const id of coveredIds) {
          try {
            const r = await fetch('/api/videos/prepend-cover', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ script_id: id }),
            })
            const body = await r.json().catch(() => ({}))
            if (!r.ok && r.status !== 202) {
              embedsFailed += 1
              console.warn(`[bulk embed] ${id} failed:`, body?.error)
              continue
            }
            embedsBuilt += 1
          } catch (e) {
            embedsFailed += 1
            console.warn(`[bulk embed] ${id} threw:`, e?.message)
          }
        }
      }

      let scheduled = 0
      let skipped = 0
      if (schedulableIds.length) {
        setAutoStage('schedule')
        const s = await fetch(`/api/content/bulk-actions?action=auto-schedule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ profile_id: profileId, script_ids: schedulableIds }),
        })
        const sb = await s.json().catch(() => ({}))
        if (!s.ok) {
          toast({ kind: 'error', message: `Auto-schedule failed: ${fmtErr(sb?.error) || s.status}. Rows are caption-ready; click Auto Schedule to retry.` })
          return
        }
        scheduled = sb.scheduled ?? 0
        skipped = sb.skipped ?? 0
      }

      const captioned = cb.updated ?? 0
      const heldBack = failedIds.size
      const parts = [`${captioned} captioned`]
      if (coverEnabled && hasCoverTemplate) {
        const coverLine = coversFailed
          ? `${coversGenerated} covers (${coversFailed} failed, posts still ship)`
          : `${coversGenerated} covers`
        parts.push(coverLine)
      }
      if (livePolishEnabled && polishedCount + polishFailed > 0) {
        const polishLine = polishFailed
          ? `${polishedCount} polished (${polishFailed} failed, raw video still ships)`
          : `${polishedCount} polished`
        parts.push(polishLine)
      }
      if ((embedsBuilt + embedsFailed) > 0) {
        const embedLine = embedsFailed
          ? `${embedsBuilt} cover-intros embedded (${embedsFailed} failed, posts still ship)`
          : `${embedsBuilt} cover-intros embedded`
        parts.push(embedLine)
      }
      parts.push(`${scheduled} scheduled`)
      if (skipped)   parts.push(`${skipped} skipped (no open slots)`)
      if (heldBack)  parts.push(`${heldBack} held back (no transcript, write caption manually)`)
      toast({
        kind: heldBack && !scheduled ? 'warn' : 'success',
        message: `Auto-processed ${ids.length}: ${parts.join(', ')}.`,
      })
    } catch (e) {
      toast({ kind: 'error', message: `Auto-process failed: ${fmtErr(e)}` })
    } finally {
      setAutoStage(null)
      refresh()
      onChange?.()
    }
  }

  // ── drag/drop wiring ──────────────────────────────────────────────────────
  useEffect(() => {
    const el = dropRef.current
    if (!el) return
    let depth = 0
    const onDragEnter = (e) => { e.preventDefault(); depth++; el.dataset.drag = '1' }
    const onDragLeave = () => { if (--depth <= 0) { delete el.dataset.drag; depth = 0 } }
    const onDragOver = (e) => { e.preventDefault() }
    const onDrop = (e) => { e.preventDefault(); depth = 0; delete el.dataset.drag; onFiles(e.dataTransfer?.files) }
    el.addEventListener('dragenter', onDragEnter)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragenter', onDragEnter)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('drop', onDrop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId])

  // ── filtering / selection ────────────────────────────────────────────────
  const tabFn = STATUS_TABS.find((t) => t.id === tab)?.filter || (() => true)
  const visible = useMemo(() => {
    let all = (scripts || []).filter(tabFn)
    if (kindFilter !== 'all') {
      all = all.filter((r) => {
        const k = r.media_type || (Array.isArray(r.media_urls) && r.media_urls.length ? 'image' : 'text')
        return k === kindFilter
      })
    }
    // Date-range gate. Local time, since scheduled_datetime stored as
    // UTC ISO is displayed in local time elsewhere on this page.
    if (dateRange !== 'all') {
      const now = new Date()
      let from = null, to = null
      if (dateRange === 'today') {
        from = new Date(now); from.setHours(0, 0, 0, 0)
        to = new Date(from); to.setDate(from.getDate() + 1)
      } else if (dateRange === 'week') {
        // Sun..Sat current week
        from = new Date(now); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - from.getDay())
        to = new Date(from); to.setDate(from.getDate() + 7)
      } else if (dateRange === '7d') {
        from = new Date(now); from.setHours(0, 0, 0, 0)
        to = new Date(from); to.setDate(from.getDate() + 7)
      } else if (dateRange === 'custom') {
        if (customFrom) { from = new Date(customFrom + 'T00:00:00') }
        if (customTo)   { to   = new Date(customTo   + 'T23:59:59') }
      }
      if (from || to) {
        all = all.filter((r) => {
          if (!r.scheduled_datetime) return false  // un-scheduled rows hide from date filters
          const t = new Date(r.scheduled_datetime).getTime()
          if (from && t < from.getTime()) return false
          if (to && t > to.getTime()) return false
          return true
        })
      }
    }
    const s = search.trim().toLowerCase()
    if (s) {
      all = all.filter((r) => (r.title || '').toLowerCase().includes(s)
        || (r.caption || '').toLowerCase().includes(s)
        || (r.full_script || '').toLowerCase().includes(s)
        || (r.hashtags || '').toLowerCase().includes(s))
    }
    // Sort by scheduled_datetime — direction controlled by sortOrder.
    //   oldest → earliest first, un-scheduled rows last
    //   newest → latest first, un-scheduled rows still last
    const newestFirst = sortOrder === 'newest'
    const sorted = [...all].sort((a, b) => {
      const ta = a.scheduled_datetime ? new Date(a.scheduled_datetime).getTime() : null
      const tb = b.scheduled_datetime ? new Date(b.scheduled_datetime).getTime() : null
      // Un-scheduled rows always sort to the bottom regardless of direction.
      if (ta === null && tb === null) return 0
      if (ta === null) return 1
      if (tb === null) return -1
      return newestFirst ? tb - ta : ta - tb
    })
    return sorted
  }, [scripts, tab, search, kindFilter, dateRange, customFrom, customTo, sortOrder]) // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => {
    const out = {}
    for (const t of STATUS_TABS) out[t.id] = (scripts || []).filter(t.filter).length
    return out
  }, [scripts])
  const allSelected = visible.length > 0 && visible.every((r) => selected.has(r.id))
  const toggleAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(visible.map((r) => r.id)))
  }
  const toggleOne = (id) => {
    setSelected((s) => {
      const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next
    })
  }

  // ── inline patch ──────────────────────────────────────────────────────────
  const patchScript = async (rawId, patch) => {
    // groupByPlatform fans out each row into one row per platform with
    // a synthesized id like 'parent_id__tiktok'. Strip the suffix so
    // PATCH hits the canonical row.
    const id = String(rawId).split('__')[0]
    setScripts((arr) => arr.map((r) => r.id === id ? { ...r, ...patch } : r))
    try {
      const r = await fetch(`/api/content?id=${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        throw new Error(body?.error || `Save failed (${r.status})`)
      }
      // When the API actually cancelled + re-submitted the Upload-Post
      // job (because the user edited a field that's queued there), toast
      // so they know the change reached Upload-Post — not just the local
      // DB. Quiet otherwise — most inline edits don't trigger this.
      if (body?.upload_post_resynced) {
        const changed = Array.isArray(body.upload_post_fields_changed) ? body.upload_post_fields_changed : []
        // Map raw field names → human labels for the toast.
        const labelOf = (k) => {
          if (k === 'platforms') {
            const item = body.item
            const pls = Array.isArray(item?.platforms) ? item.platforms : []
            const pretty = pls.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(', ')
            return pretty ? `platforms (${pretty})` : 'platforms'
          }
          if (k === 'scheduled_datetime') return 'time'
          if (k === 'media_urls' || k === 'media_type') return 'media'
          if (k === 'caption') return 'caption'
          if (k === 'hashtags') return 'hashtags'
          if (k === 'first_comment') return 'first comment'
          if (k === 'title') return 'title'
          if (k === 'full_script') return 'script'
          return k
        }
        const labels = changed.map(labelOf).join(', ')
        toast({
          kind: 'success',
          message: `Updated on Upload-Post${labels ? ` · ${labels}` : ''}`,
        })
      }
    } catch (e) {
      toast({ kind: 'error', message: `Save failed: ${e.message}` })
      refresh()
    }
  }
  // Compress / normalize the source video for a row. Hits the worker
  // (via /api/videos/normalize) which probes the file; if it's already
  // canonical, returns the same URL (no-op, instant). Otherwise produces
  // a 1080p / 30fps / H.264 / AAC MP4 with HDR tone-mapped and rotation
  // baked in, and we PATCH the row's media_urls to point to that file.
  // Solves the "iPhone 4K HEVC HDR rotated .mov breaks every downstream
  // step" failure mode in one click.
  const compressRow = async (row) => {
    if (!row?.media_urls?.[0]) return
    setCompressingId(row.id)
    try {
      const r = await fetch('/api/videos/normalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile_id: profileId, video_url: row.media_urls[0] }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.error || `Compress failed (${r.status})`)

      if (!body.normalized) {
        toast({ kind: 'info', message: 'Video is already optimized — no changes needed.' })
        return
      }

      // Swap the row's media URL to the canonical MP4. patchScript handles
      // optimistic local state + the API PATCH (which also resyncs
      // Upload-Post if the row is already scheduled there).
      await patchScript(row.id, { media_urls: [body.video_url] })
      const savedMB = body.source_bytes
        ? ((body.source_bytes - body.bytes) / 1024 / 1024).toFixed(1)
        : null
      const reason = body.reason ? ` (${body.reason})` : ''
      toast({
        kind: 'success',
        message: savedMB && Number(savedMB) > 0
          ? `Compressed${reason}: saved ${savedMB}MB`
          : `Compressed${reason}`,
      })
    } catch (e) {
      toast({ kind: 'error', message: `Compress failed: ${e.message}` })
    } finally {
      setCompressingId(null)
    }
  }

  // Per-row "Polish + cover-intro" repair action. Used to fix rows that
  // landed on the calendar without the new cover-gen + polish-with-
  // cover-intro pipeline (e.g. uploaded before autopilot got both
  // toggles, or where cover-gen failed silently mid-run). Steps:
  //   1. If the row has no cover_image_url yet, generate one via
  //      /api/content/generate-cover (start + commit).
  //   2. Call /api/videos/polish with embed_cover_intro=true. Worker
  //      polishes + prepends the cover as a 0.5s intro in one job.
  //   3. PATCH media_url_with_cover on the row. If the row is already
  //      scheduled on Upload-Post, the PATCH handler cancels the old
  //      job and resubmits with the new URL automatically.
  const [polishingRowId, setPolishingRowId] = useState(null)
  const polishAndEmbedRow = async (row) => {
    if (!row?.id || row.media_type !== 'video') return
    const sourceUrl = Array.isArray(row.media_urls) && row.media_urls[0]
    if (!sourceUrl) {
      toast({ kind: 'warn', message: 'Row has no source video.' })
      return
    }
    if (!hasCoverTemplate) {
      toast({ kind: 'warn', message: 'No cover template set on this brand. Add one in Brand Profile first.' })
      return
    }
    setPolishingRowId(row.id)
    const rowLabel = (row.title || '').slice(0, 40) || 'this row'
    toast({ kind: 'info', message: `Starting repair for "${rowLabel}"…`, ttl: 2500 })
    try {
      let coverUrl = row.cover_image_url
      // Step 1 — generate a cover image if none exists yet.
      if (!coverUrl) {
        toast({ kind: 'info', message: 'Step 1/3: Generating cover image…', ttl: 4000 })
        const startResp = await fetch('/api/content/generate-cover?action=start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ script_id: row.id }),
        })
        const startBody = await startResp.json().catch(() => ({}))
        if (!startResp.ok || !startBody.taskId) {
          throw new Error(startBody?.error || `Cover start failed (${startResp.status})`)
        }
        // Poll up to ~3 min — same threshold the autopilot uses.
        const POLL_MS = 4000
        const TIMEOUT_MS = 3 * 60_000
        const started = Date.now()
        while (!coverUrl && Date.now() - started < TIMEOUT_MS) {
          await new Promise((r) => setTimeout(r, POLL_MS))
          const statusResp = await fetch(
            `/api/images/status?taskId=${encodeURIComponent(startBody.taskId)}`,
            { headers: { Authorization: `Bearer ${token}` } }
          )
          const statusBody = await statusResp.json().catch(() => ({}))
          if (statusBody.state === 'success' && Array.isArray(statusBody.images) && statusBody.images.length) {
            coverUrl = statusBody.images[0]?.url || statusBody.images[0]
            break
          }
          if (statusBody.state === 'failed') throw new Error(statusBody.error || 'Cover generation failed')
        }
        if (!coverUrl) throw new Error('Cover generation timed out')
        // Commit so cover_image_url + instagram_cover_url land on the row.
        const commitResp = await fetch('/api/content/generate-cover?action=commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ script_id: row.id, image_url: coverUrl }),
        })
        if (!commitResp.ok) throw new Error('Cover commit failed')
        toast({ kind: 'info', message: 'Cover ready. Step 2/3: Polishing video + embedding cover intro…', ttl: 4000 })
      } else {
        toast({ kind: 'info', message: 'Cover already set. Step 1/2: Polishing video + embedding cover intro…', ttl: 4000 })
      }
      // Step 2 — polish with embedded cover intro.
      const polished = await polishOneVideoWithCover(sourceUrl, {
        cover_image_url: coverUrl,
        embed_cover_intro: true,
      })
      if (!polished?.video_url) throw new Error('Polish returned no video_url')
      // Detect silent cover-intro failure. polishCore returns
      // cover_intro: { failed: true, reason } when prependCoverCore
      // threw inside the worker job (or the worker is still on the
      // old polishCore that doesn't know about cover_intro). Either
      // way the user is owed a clear message rather than a sneaky
      // "repaired" toast with no cover at the start.
      const coverIntroMeta = polished.cover_intro || null
      const coverIntroSucceeded = coverIntroMeta && !coverIntroMeta.failed
      // Step 3 — PATCH the row. patchScript handles optimistic UI +
      // Upload-Post resync when the row is already scheduled.
      toast({ kind: 'info', message: 'Finishing up: saving + resyncing Upload-Post…', ttl: 3000 })
      await patchScript(row.id, { media_url_with_cover: polished.video_url, embed_cover_intro: true })
      if (coverIntroSucceeded) {
        toast({ kind: 'success', message: `"${rowLabel}" repaired. Music mixed, cover intro embedded, Upload-Post resynced.`, ttl: 6000 })
      } else {
        const reason = coverIntroMeta?.reason || 'worker may need redeploy to pick up cover-intro support'
        toast({
          kind: 'warn',
          message: `"${rowLabel}" polished and resynced, but cover-intro was NOT prepended (${reason}). The video has music + cleanup but no cover at the start.`,
          ttl: 9000,
        })
      }
    } catch (e) {
      toast({ kind: 'error', message: `Repair failed on "${rowLabel}": ${fmtErr(e) || e.message}`, ttl: 7000 })
    } finally {
      setPolishingRowId(null)
    }
  }

  const deleteScript = async (id) => {
    const ok = await confirmDialog({ title: 'Delete this row?', confirmText: 'Delete', destructive: true })
    if (!ok) return
    try {
      const r = await fetch(`/api/content?id=${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      const body = await r.json().catch(() => ({}))
      setScripts((arr) => arr.filter((r) => r.id !== id))
      setSelected((s) => { const n = new Set(s); n.delete(id); return n })
      // Surface what happened on the Upload-Post side so the user can
      // see if the cascade succeeded, was skipped, or 404'd.
      const cancel = body?.upload_post_cancel
      // eslint-disable-next-line no-console
      console.log('[delete-cascade]', { id, cancel })
      if (cancel?.attempted) {
        if (cancel.ok) {
          toast({ kind: 'success', message: `Deleted + cancelled on Upload-Post (${cancel.strategy}).` })
        } else if (cancel.status === 404 || cancel.reason === 'not_found') {
          toast({ kind: 'info', message: `Deleted. Upload-Post had no matching job (already fired or never queued).` })
        } else {
          toast({
            kind: 'warn',
            message: `Deleted locally, but Upload-Post cancel failed (${cancel.strategy}: ${cancel.reason || 'unknown'}). The orphan-cleanup cron will catch it within 30 min.`,
            ttl: 9000,
          })
        }
      }
    } catch (e) { toast({ kind: 'error', message: e.message }) }
  }

  // Bulk delete every currently-selected row. Fires DELETE in parallel,
  // surfaces a per-row success/failure summary if any fail.
  const deleteSelected = async () => {
    const ids = [...selected]
    if (!ids.length) return
    const ok = await confirmDialog({
      title: `Delete ${ids.length} ${ids.length === 1 ? 'post' : 'posts'}?`,
      message: 'This permanently removes the rows and their media references from your library. Cannot be undone.',
      confirmText: 'Delete',
      destructive: true,
    })
    if (!ok) return
    setBusyAction('delete')
    const results = await Promise.allSettled(
      ids.map((id) => fetch(`/api/content?id=${id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      }).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return id }))
    )
    const ok_ids = results.filter((r) => r.status === 'fulfilled').map((r) => r.value)
    const failed = results.length - ok_ids.length
    setScripts((arr) => arr.filter((r) => !ok_ids.includes(r.id)))
    setSelected(new Set())
    setBusyAction(null)
    if (failed) {
      toast({ kind: 'error', message: `Deleted ${ok_ids.length} of ${ids.length}; ${failed} failed.` })
      refresh()
    } else {
      toast({ kind: 'success', message: `Deleted ${ok_ids.length} ${ok_ids.length === 1 ? 'post' : 'posts'}.` })
    }
  }

  // ── bulk actions ──────────────────────────────────────────────────────────
  const callBulk = async (action, label) => {
    const ids = [...selected]
    setBusyAction(action)
    try {
      const r = await fetch(`/api/content/bulk-actions?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile_id: profileId, script_ids: ids }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error || `${label} failed (${r.status})`)
      const summary = body.updated != null ? `${label}: ${body.updated}/${body.total ?? ids.length} updated`
        : body.scheduled != null ? `${label}: ${body.scheduled} scheduled${body.submitted ? `, ${body.submitted} queued at Upload-Post` : ''}${body.submit_failed ? `, ${body.submit_failed} submit-failed` : ''}${body.skipped ? `, ${body.skipped} skipped` : ''}`
        : body.submitted != null ? `${label}: ${body.submitted} submitted${body.failed ? `, ${body.failed} failed` : ''}`
        : body.resynced != null ? `${label}: ${body.resynced} resynced${body.failed ? `, ${body.failed} failed` : ''}${body.skipped ? `, ${body.skipped} skipped` : ''}`
        : `${label} done`
      // Surface caption-generation failures so the user understands why
      // some rows didn't get captioned. Show the actual underlying
      // reason (Scribe error / empty / no_speech_detected) when we
      // have one so it's diagnosable instead of a generic blame line.
      const tFails = Array.isArray(body.transcript_failures) ? body.transcript_failures : []
      if (tFails.length && action === 'generate-captions') {
        // Group identical reasons so a batch with the same Scribe error
        // doesn't print 10 separate copies.
        const reasons = {}
        for (const f of tFails) reasons[f.reason || 'unknown'] = (reasons[f.reason || 'unknown'] || 0) + 1
        const detail = Object.entries(reasons)
          .map(([r, n]) => `${n}× ${r}`)
          .join(', ')
        const tail = ` · ${tFails.length} video${tFails.length === 1 ? '' : 's'} couldn't be transcribed (${detail})`
        toast({ kind: body.updated > 0 ? 'success' : 'warn', message: summary + tail })
        // eslint-disable-next-line no-console
        console.warn('[generate-captions] transcript failures', tFails, 'debug:', body.debug)
      } else {
        toast({ kind: 'success', message: summary })
      }
      refresh()
    } catch (e) {
      toast({ kind: 'error', message: e.message })
    } finally {
      setBusyAction(null)
    }
  }

  const exportCsv = () => {
    const cols = ['title', 'full_script', 'caption', 'hashtags', 'first_comment', 'status', 'scheduled_datetime', 'media_urls']
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`
    const rows = (scripts || []).map((r) => cols.map((c) => {
      const v = r[c]
      if (Array.isArray(v)) return escape(v.join('|'))
      return escape(v)
    }).join(','))
    const csv = [cols.join(','), ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `scalesolo-content-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Drag/drop area */}
      <div
        ref={dropRef}
        className="bulk-upload-card"
        style={{
          background: 'var(--surface)',
          border: '2px dashed var(--border)',
          borderRadius: 14, padding: isPhone ? 14 : 20, marginBottom: 18,
          display: 'flex',
          flexDirection: isPhone ? 'column' : 'row',
          alignItems: isPhone ? 'stretch' : 'center',
          gap: isPhone ? 12 : 16,
          transition: 'border-color 0.15s, background 0.15s',
        }}
        onClick={() => fileRef.current?.click()}
      >
        {/* Title row: icon + heading + description. Stays horizontal on
            every breakpoint so the icon never floats orphaned above
            the title on a phone column-stack. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: isPhone ? 'unset' : 1, minWidth: 0 }}>
        <div style={{
          width: 48, height: 48, borderRadius: 10,
          background: 'linear-gradient(135deg, #f59e0b, #f97316)',
          color: '#fff', display: 'grid', placeItems: 'center', flexShrink: 0,
        }}><VideoIcon size={22} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15 }}>
              Bulk Media Upload
            </div>
            {autoProcess && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 8px', borderRadius: 999,
                background: 'rgba(46,204,113,0.16)', color: '#2ecc71',
                fontSize: 10.5, fontFamily: 'var(--font-display)', fontWeight: 700,
                letterSpacing: '0.04em',
              }}>
                <Zap size={10} /> AUTOPILOT ON
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>
            {isPhone
              ? (autoProcess
                  ? <>Drop or pick a video. Autopilot handles the rest.</>
                  : <>Drop or pick a video. Saves as a draft.</>)
              : (autoProcess
                  ? <>Drag &amp; drop videos or images. Captions, hashtags, titles &amp; first comments are written automatically from your brand bible, then each post is slotted into the next open time on your <strong>posting schedule</strong>.</>
                  : <>Drag &amp; drop videos or images. Rows save as drafts — click <strong>Generate Captions</strong> and <strong>Auto Schedule</strong> when ready.</>)
            }
          </div>
        </div>
        </div> {/* /title row */}
        {/* Actions row: toggles + Choose files. Wraps to multiple lines
            on narrow widths so each chip stays finger-tappable. */}
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: isPhone ? 6 : 8,
          alignItems: 'center',
          justifyContent: isPhone ? 'flex-start' : 'flex-end',
        }}>
        <label
          onClick={(e) => e.stopPropagation()}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 11.5, color: 'var(--text-soft)',
            cursor: 'pointer', userSelect: 'none',
            padding: '6px 10px', borderRadius: 8,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
          }}
          title="Toggle automatic caption + scheduling on uploads"
        >
          <input
            type="checkbox"
            checked={autoProcess}
            onChange={(e) => setAutoProcessSticky(e.target.checked)}
            style={{ accentColor: '#2ecc71' }}
          />
          Autopilot
        </label>

        {/* Polish video toggle — same look as Autopilot, with a gear that
            opens the brand-level polish settings modal. The settings are
            shared with the Spaces "Finish video" node (both surfaces
            read / write profiles.polish_template). */}
        <label
          onClick={(e) => e.stopPropagation()}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 11.5, color: 'var(--text-soft)',
            cursor: 'pointer', userSelect: 'none',
            padding: '6px 10px', borderRadius: 8,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
          }}
          title="When on, each uploaded video is polished (title, logo, captions, music) before captions + scheduling"
        >
          <input
            type="checkbox"
            checked={polishEnabled}
            onChange={(e) => setPolishEnabledSticky(e.target.checked)}
            style={{ accentColor: '#0ea5e9' }}
          />
          Polish video
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setPolishSettingsOpen(true) }}
            title="Edit polish settings (shared with your Spaces canvas)"
            style={{
              marginLeft: 2, padding: 2, borderRadius: 4,
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--muted)', display: 'inline-flex', alignItems: 'center',
            }}
            aria-label="Open polish settings"
          ><SettingsIcon size={12} /></button>
        </label>

        {/* Generate cover toggle — when on, after captions land we
            generate a per-post IG cover via the brand's cover_template.
            Disabled until the brand uploads a template on the Profile page. */}
        <label
          onClick={(e) => e.stopPropagation()}
          title={hasCoverTemplate
            ? 'When on, each video gets a custom Instagram Reel cover generated from your brand template'
            : 'Upload an Instagram cover template on your brand profile first to enable this.'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 11.5, color: hasCoverTemplate ? 'var(--text-soft)' : 'var(--muted)',
            cursor: hasCoverTemplate ? 'pointer' : 'not-allowed', userSelect: 'none',
            padding: '6px 10px', borderRadius: 8,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            opacity: hasCoverTemplate ? 1 : 0.6,
          }}
        >
          <input
            type="checkbox"
            checked={coverEnabled && hasCoverTemplate}
            disabled={!hasCoverTemplate}
            onChange={(e) => setCoverEnabledSticky(e.target.checked)}
            style={{ accentColor: '#a855f7' }}
          />
          Generate cover
        </label>
        <button
          className="btn-secondary"
          onClick={(e) => { e.stopPropagation(); fileRef.current?.click() }}
          style={{ padding: '8px 12px', flex: isPhone ? '1 1 100%' : undefined }}
          aria-label="Choose files to upload"
        ><Upload size={14} /> Choose files</button>
        <input
          ref={fileRef} type="file" multiple
          accept="video/*,image/*"
          aria-label="Bulk upload media files"
          style={{ display: 'none' }}
          onChange={(e) => { onFiles(e.target.files); e.target.value = '' }}
        />
        </div> {/* /actions row */}
      </div>

      {/* Autopilot status — fires while the bulk-actions endpoints run
          server-side. Hidden when idle. */}
      {autoStage && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', borderRadius: 10, marginBottom: 14,
          background: 'rgba(46,204,113,0.08)',
          border: '1px solid rgba(46,204,113,0.30)',
          fontSize: 12.5, color: 'var(--text-soft)',
        }}>
          <Loader2 size={14} className="spin" style={{ color: '#2ecc71' }} />
          <strong style={{ color: 'var(--text)' }}>Autopilot:</strong>
          {autoStage === 'captions' && 'writing captions, hashtags & first comments…'}
          {autoStage === 'covers' && 'generating Instagram covers…'}
          {autoStage === 'polish' && 'polishing videos (music, captions, cover intro)…'}
          {autoStage === 'embed' && 'embedding covers as intro card on each video…'}
          {autoStage === 'schedule' && 'slotting posts into your schedule…'}
        </div>
      )}

      {/* Active uploads */}
      {uploads.length > 0 && (
        <div style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {uploads.map((u) => (
            <div key={u.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '6px 10px', borderRadius: 8,
              background: u.error ? 'rgba(239,68,68,0.10)' : 'var(--surface-2)',
              border: `1px solid ${u.error ? 'rgba(239,68,68,0.4)' : 'var(--border)'}`,
              fontSize: 12,
            }}>
              {u.error ? <AlertCircle size={14} style={{ color: 'var(--red)' }} />
                : u.progress >= 100 ? <Check size={14} style={{ color: '#2ecc71' }} />
                : u.polishing ? <Sparkles size={14} className="spin" style={{ color: '#0ea5e9' }} />
                : <Loader2 size={14} className="spin" />}
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {u.name}
                {u.polishing && (
                  <span style={{ marginLeft: 8, fontSize: 10.5, color: '#0ea5e9', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>polishing…</span>
                )}
              </div>
              {u.error
                ? <span style={{ color: 'var(--red)' }}>{u.error}</span>
                : <div style={{ width: 80, height: 6, background: 'var(--surface)', borderRadius: 999, overflow: 'hidden' }}>
                    <div style={{ width: `${u.progress}%`, height: '100%', background: u.polishing ? '#0ea5e9' : '#f59e0b', transition: 'width 0.2s' }} />
                  </div>
              }
            </div>
          ))}
        </div>
      )}

      {/* Status tabs + search */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10 }}>
          {STATUS_TABS.map((t) => {
            const active = tab === t.id
            return (
              <button
                key={t.id}
                onClick={() => { setTab(t.id); setSelected(new Set()) }}
                style={{
                  padding: '6px 12px', borderRadius: 7,
                  background: active ? 'var(--surface-2)' : 'transparent',
                  border: active ? '1px solid var(--border)' : '1px solid transparent',
                  color: active ? 'var(--text)' : 'var(--text-soft)',
                  cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: 12.5, fontWeight: 700,
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
              >
                {t.label}
                <span style={{
                  background: active ? '#f59e0b' : 'var(--surface-3)',
                  color: active ? '#fff' : 'var(--muted)',
                  padding: '1px 7px', borderRadius: 999, fontSize: 10.5, fontWeight: 800,
                }}>{counts[t.id] ?? 0}</span>
              </button>
            )
          })}
        </div>
        {/* Post-kind filter chips. Quick narrow to videos / images /
            text-only posts without touching the search field. */}
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { id: 'all',   label: 'All',    icon: null },
            { id: 'video', label: 'Video',  icon: VideoIcon },
            { id: 'image', label: 'Image',  icon: ImageIcon },
            { id: 'text',  label: 'Text',   icon: Type },
          ].map((k) => {
            const Icon = k.icon
            const active = kindFilter === k.id
            return (
              <button
                key={k.id}
                onClick={() => setKindFilter(k.id)}
                style={{
                  padding: '6px 10px', borderRadius: 7,
                  background: active ? 'var(--surface-2)' : 'transparent',
                  border: `1px solid ${active ? 'var(--border)' : 'transparent'}`,
                  color: active ? 'var(--text)' : 'var(--muted)',
                  fontFamily: 'var(--font-display)', fontSize: 11.5, fontWeight: 700,
                  cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}
                title={`Show only ${k.label.toLowerCase()} posts`}
              >
                {Icon ? <Icon size={11} /> : null}
                {k.label}
              </button>
            )
          })}
        </div>
        <input
          className="input"
          placeholder="Search a post"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, maxWidth: 280, padding: '8px 12px', fontSize: 13 }}
        />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{visible.length} of {(scripts || []).length}</span>
      </div>

      {/* Secondary filter row — date range, sort order, group by
          platform toggle. Lives under the primary tab + chip row so
          the visual hierarchy stays clear (tabs decide WHAT, this row
          decides WHEN / HOW). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap', fontSize: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--muted)' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase', marginRight: 4 }}>Date</span>
          {[
            { id: 'all',    label: 'All' },
            { id: 'today',  label: 'Today' },
            { id: 'week',   label: 'This week' },
            { id: '7d',     label: 'Next 7d' },
            { id: 'custom', label: 'Custom' },
          ].map((d) => {
            const active = dateRange === d.id
            return (
              <button
                key={d.id}
                onClick={() => setDateRange(d.id)}
                style={{
                  padding: '5px 9px', borderRadius: 6,
                  background: active ? 'var(--surface-2)' : 'transparent',
                  border: `1px solid ${active ? 'var(--border)' : 'transparent'}`,
                  color: active ? 'var(--text)' : 'var(--muted)',
                  fontFamily: 'var(--font-display)', fontSize: 11.5, fontWeight: 700,
                  cursor: 'pointer',
                }}
              >{d.label}</button>
            )
          })}
        </div>
        {dateRange === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} style={{ padding: '5px 8px', fontSize: 11.5, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
            <span style={{ color: 'var(--muted)' }}>to</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} style={{ padding: '5px 8px', fontSize: 11.5, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
          </div>
        )}
        {/* Sort order — same pill group style as the date filters. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--muted)' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase', marginRight: 4 }}>Sort</span>
          {[
            { id: 'newest', label: 'Newest' },
            { id: 'oldest', label: 'Oldest' },
          ].map((o) => {
            const active = sortOrder === o.id
            return (
              <button
                key={o.id}
                onClick={() => setSortOrder(o.id)}
                style={{
                  padding: '5px 9px', borderRadius: 6,
                  background: active ? 'var(--surface-2)' : 'transparent',
                  border: `1px solid ${active ? 'var(--border)' : 'transparent'}`,
                  color: active ? 'var(--text)' : 'var(--muted)',
                  fontFamily: 'var(--font-display)', fontSize: 11.5, fontWeight: 700,
                  cursor: 'pointer',
                }}
              >{o.label}</button>
            )
          })}
        </div>
      </div>

      {/* Bulk action toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-soft)', cursor: 'pointer' }}>
          <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all visible rows" />
          Select All ({visible.length})
        </label>
        <span style={{ flex: 1 }} />
        <button
          className="btn-secondary" disabled={!selected.size || busyAction !== null}
          onClick={() => callBulk('generate-captions', 'Captions')}
          style={{ padding: '8px 12px' }}
        >{busyAction === 'generate-captions' ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} Generate Captions</button>
        <button
          className="btn-secondary" disabled={!selected.size || busyAction !== null}
          onClick={() => callBulk('auto-schedule', 'Auto-schedule')}
          style={{ padding: '8px 12px' }}
        >{busyAction === 'auto-schedule' ? <Loader2 size={13} className="spin" /> : <CalendarClock size={13} />} Auto Schedule</button>
        <button
          className="btn-primary" disabled={!selected.size || busyAction !== null}
          onClick={async () => {
            const ok = await confirmDialog({ title: `Publish ${selected.size} selected?`, message: 'Submits each row to upload-post.com immediately (or schedules per its scheduled_at).', confirmText: 'Publish' })
            if (ok) callBulk('publish-selected', 'Publish')
          }}
          style={{ padding: '8px 12px' }}
        >{busyAction === 'publish-selected' ? <Loader2 size={13} className="spin" /> : <Send size={13} />} Publish Selected</button>
        {/* Resync existing scheduled rows with Upload-Post so the queued
            job matches the current platforms / caption / hashtags
            / media on the row. Use when you edited platforms or media
            on a row whose Upload-Post job was already submitted. */}
        <button
          className="btn-ghost" disabled={busyAction !== null}
          onClick={async () => {
            const ok = await confirmDialog({
              title: 'Resync scheduled posts with Upload-Post?',
              message: 'Cancels each scheduled job and re-submits with the current platforms / caption / hashtags / media. Safe to run anytime.',
              confirmText: 'Resync',
            })
            if (ok) callBulk('resync-upload-post', 'Resync')
          }}
          style={{ padding: '8px 12px' }}
          title="Cancel + re-submit every scheduled row with its current payload"
        >{busyAction === 'resync-upload-post' ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Resync Scheduled</button>
        {/* Bulk delete — only renders once at least one row is checked so
           the toolbar isn't cluttered when nothing's selected. */}
        {selected.size > 0 && (
          <button
            disabled={busyAction !== null}
            onClick={deleteSelected}
            aria-label={`Delete ${selected.size} selected ${selected.size === 1 ? 'post' : 'posts'}`}
            style={{
              padding: '8px 12px', borderRadius: 8,
              background: 'rgba(239,68,68,0.12)',
              color: 'var(--red)', border: '1px solid rgba(239,68,68,0.4)',
              cursor: busyAction !== null ? 'not-allowed' : 'pointer',
              opacity: busyAction !== null ? 0.6 : 1,
              fontSize: 12.5, fontWeight: 700, fontFamily: 'var(--font-display)',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            {busyAction === 'delete' ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
            Delete{selected.size > 1 ? ` ${selected.size}` : ''}
          </button>
        )}
        <button
          onClick={exportCsv}
          style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'linear-gradient(135deg, #92400e, #78350f)', color: '#fff',
            border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'var(--font-display)',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        ><Download size={13} /> Export CSV</button>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 12px', borderRadius: 8, marginBottom: 10, fontSize: 12.5 }}>
          <AlertCircle size={13} style={{ verticalAlign: '-2px' }} /> {error}
        </div>
      )}

      {/* Table */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
        overflow: 'hidden',
      }}>
        {/* Phone: stacked card layout instead of the wide table.
            Each card carries the same data (media thumb, title, caption
            preview, platforms, scheduled time, status, action buttons)
            but reorganized for a vertical single-column scroll. The
            full table renders on tablet + desktop. */}
        {isPhone ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8 }}>
            {scripts === null ? (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
                <Loader2 size={18} className="spin" />
              </div>
            ) : visible.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                {tab === 'queued' && 'No queued posts. Drop media above to start.'}
                {tab === 'error' && 'No failed posts.'}
                {tab === 'delivered' && 'Nothing delivered yet.'}
              </div>
            ) : visible.map((r) => {
              const isVideo = r.media_type === 'video'
              const isText = r.media_type === 'text'
              const kindBorder = isVideo ? '#0ea5e9' : isText ? '#f59e0b' : '#a855f7'
              const hasCover = !!r.cover_image_url
              const thumb = hasCover ? r.cover_image_url : (Array.isArray(r.media_urls) ? r.media_urls[0] : null)
              const isSelected = selected.has(r.id)
              return (
                <div
                  key={r.id}
                  style={{
                    background: 'var(--surface)',
                    border: `1px solid ${isSelected ? 'var(--red)' : 'var(--border)'}`,
                    borderLeft: `3px solid ${kindBorder}`,
                    borderRadius: 10, padding: 10,
                    display: 'flex', flexDirection: 'column', gap: 8,
                  }}
                >
                  {/* Row 1: thumb + title + checkbox + status */}
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(r.id)}
                      aria-label={`Select ${r.title || 'row'}`}
                      style={{ marginTop: 6, flexShrink: 0 }}
                    />
                    <div style={{
                      width: 56, height: 56, borderRadius: 8, overflow: 'hidden',
                      background: 'var(--surface-2)', flexShrink: 0,
                      display: 'grid', placeItems: 'center', color: 'var(--muted)',
                    }}>
                      {thumb && isVideo ? (
                        <video src={thumb} muted playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : thumb ? (
                        <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : isText ? <Type size={20} /> : <ImageIcon size={20} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13,
                        color: 'var(--text)', lineHeight: 1.3,
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}>
                        {r.title || 'Untitled'}
                      </div>
                      <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <StatusPill status={r.status} error={r.last_error} />
                        {r.scheduled_datetime && (
                          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                            {new Date(r.scheduled_datetime).toLocaleString(undefined, {
                              month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {/* Row 2: caption preview */}
                  {(r.caption || r.full_script) && (
                    <div style={{
                      fontSize: 11.5, color: 'var(--text-soft)', lineHeight: 1.4,
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}>
                      {r.caption || r.full_script}
                    </div>
                  )}
                  {/* Row 3: platforms */}
                  {Array.isArray(r.platforms) && r.platforms.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {r.platforms.map((p) => <PlatformBadge key={p} id={p} size={16} />)}
                    </div>
                  )}
                  {/* Row 4: action buttons centered */}
                  <div style={{
                    display: 'flex', justifyContent: 'center', gap: 8,
                    paddingTop: 6, borderTop: '1px solid var(--border)', marginTop: 2,
                  }}>
                    {isVideo && Array.isArray(r.media_urls) && r.media_urls[0] && (
                      <button
                        aria-label="Compress / optimize source video"
                        disabled={compressingId === r.id}
                        onClick={() => compressRow(r)}
                        style={{
                          background: 'transparent', border: 'none',
                          color: 'var(--muted)', cursor: 'pointer',
                          padding: 10, borderRadius: 8,
                          opacity: compressingId === r.id ? 0.5 : 1,
                        }}
                        title="Compress / optimize video"
                      >
                        {compressingId === r.id ? <Loader2 size={16} className="spin" /> : <Wand2 size={16} />}
                      </button>
                    )}
                    {isVideo && Array.isArray(r.media_urls) && r.media_urls[0] && (
                      <button
                        aria-label="Repair (polish + cover intro)"
                        disabled={polishingRowId === r.id || !hasCoverTemplate}
                        onClick={() => polishAndEmbedRow(r)}
                        style={{
                          background: 'transparent', border: 'none',
                          color: r.media_url_with_cover ? 'var(--green)' : 'var(--muted)',
                          cursor: (polishingRowId === r.id || !hasCoverTemplate) ? 'not-allowed' : 'pointer',
                          padding: 10, borderRadius: 8,
                          opacity: polishingRowId === r.id ? 0.5 : 1,
                        }}
                        title="Repair: polish video + cover intro"
                      >
                        {polishingRowId === r.id ? <Loader2 size={16} className="spin" /> : <Film size={16} />}
                      </button>
                    )}
                    <button
                      aria-label="Delete row"
                      onClick={() => deleteScript(r.id)}
                      style={{
                        background: 'transparent', border: 'none',
                        color: 'var(--muted)', cursor: 'pointer',
                        padding: 10, borderRadius: 8,
                      }}
                      title="Delete"
                    ><Trash2 size={16} /></button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
        <div>
          <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ ...headerCell, width: 30 }} aria-label="Select">{' '}</th>
                <th style={{ ...headerCell, width: 64 }}>Media</th>
                <th style={{ ...headerCell }}>Title</th>
                {/* Width tuning: Scheduled needs ~175px for the
                    datetime-local input to render "MM/DD/YYYY HH:MM AM"
                    fully (130px clipped the AM/PM). Caption + 1st
                    comment trimmed to give that space back — title
                    column is auto-width so it claims whatever's left
                    after the fixed columns. */}
                <th style={{ ...headerCell, width: '20%' }}>Caption</th>
                <th className="hide-on-tablet" style={{ ...headerCell, width: '13%' }}>Hashtags</th>
                <th className="hide-on-tablet" style={{ ...headerCell, width: '13%' }}>1st comment</th>
                <th style={{ ...headerCell, width: 100 }}>Platforms</th>
                <th style={{ ...headerCell, width: 175 }}>Scheduled</th>
                <th style={{ ...headerCell, width: 90 }}>Status</th>
                <th style={{ ...headerCell, width: 44 }} aria-label="Actions">{' '}</th>
              </tr>
            </thead>
            <tbody>
              {scripts === null ? (
                <tr><td colSpan={10} style={{ padding: 60, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={18} className="spin" /></td></tr>
              ) : visible.length === 0 ? (
                <tr><td colSpan={10} style={{ padding: 60, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                  {tab === 'queued' && 'No queued posts. Drop media above to start.'}
                  {tab === 'error' && 'No failed posts.'}
                  {tab === 'delivered' && 'Nothing delivered yet.'}
                </td></tr>
              ) : visible.map((r) => {
                // Prefer the generated Instagram cover when one is set —
                // that's what'll actually post as the Reel thumbnail, so
                // showing the source video frame here was misleading on
                // covered posts. Fall back to source media when no
                // cover exists.
                const hasCover = !!r.cover_image_url
                const thumb = hasCover ? r.cover_image_url
                  : (Array.isArray(r.media_urls) && r.media_urls[0])
                const isVideo = r.media_type === 'video'
                const isText = r.media_type === 'text'
                // Cover thumbs are always static PNGs; only render the
                // <video> element when we're showing the raw source.
                const thumbIsVideo = isVideo && !hasCover
                const hasPerPlatformText = isText && r.per_platform_text && typeof r.per_platform_text === 'object' && Object.keys(r.per_platform_text).length > 0
                // Left-border color by post kind so the table stays
                // scannable when mixing types: video=blue, image=purple,
                // text=amber.
                const kindBorder = isVideo ? '#0ea5e9' : isText ? '#f59e0b' : '#a855f7'
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border)', borderLeft: `3px solid ${kindBorder}` }}>
                    <td style={{ padding: 8, verticalAlign: 'top' }}>
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggleOne(r.id)}
                        aria-label={`Select ${r.title || 'row'}`}
                      />
                    </td>
                    <td style={{ padding: 8, verticalAlign: 'top' }}>
                      {thumb ? (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setPreviewItem({
                            // Click opens the preview overlay. If a cover
                            // is staged we surface BOTH so the user can
                            // compare. videoUrl prefers the cover-
                            // embedded version (media_url_with_cover) when
                            // present — that's the actual asset that posts
                            // to TikTok / YouTube / FB / Threads, so it's
                            // what the user wants to see, not the raw
                            // source they uploaded.
                            url: thumb,
                            type: thumbIsVideo ? 'video' : 'image',
                            title: r.title,
                            coverUrl: hasCover ? r.cover_image_url : null,
                            videoUrl: isVideo
                              ? (r.media_url_with_cover || (Array.isArray(r.media_urls) ? r.media_urls[0] : null))
                              : null,
                          }) }}
                          aria-label={`Preview ${r.title || 'media'}`}
                          title={hasCover ? 'Click to preview cover + source video' : 'Click to preview'}
                          style={{
                            position: 'relative',
                            width: 48, height: 48, padding: 0, borderRadius: 6,
                            border: '1px solid var(--border)', background: '#000',
                            cursor: 'pointer', overflow: 'hidden', display: 'block',
                          }}
                        >
                          {thumbIsVideo
                            ? <video src={thumb} muted playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }} />
                            : <img src={thumb} alt={r.title || 'media'} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }} />}
                          {/* "IG" pill bottom-right when we're showing a
                              cover — same affordance as the calendar view
                              so users know which thumbs are covers vs raw
                              video frames. */}
                          {hasCover && (
                            <span style={{
                              position: 'absolute', bottom: 2, right: 2,
                              fontSize: 8, fontWeight: 800, letterSpacing: '0.04em',
                              padding: '1px 4px', borderRadius: 3,
                              background: 'rgba(14,165,233,0.92)',
                              color: '#fff',
                              lineHeight: 1.1,
                              pointerEvents: 'none',
                            }}>IG</span>
                          )}
                          {thumbIsVideo && (
                            <span style={{
                              position: 'absolute', inset: 0,
                              display: 'grid', placeItems: 'center',
                              color: '#fff', fontSize: 18,
                              background: 'rgba(0,0,0,0.25)',
                              pointerEvents: 'none',
                            }}>▶</span>
                          )}
                        </button>
                      ) : isText ? (
                        <div style={{
                          width: 48, height: 48, borderRadius: 6,
                          background: 'rgba(245,158,11,0.10)',
                          border: '1px solid rgba(245,158,11,0.35)',
                          display: 'grid', placeItems: 'center', color: '#f59e0b',
                          fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 22, lineHeight: 1,
                        }}>“”</div>
                      ) : (
                        <div style={{ width: 48, height: 48, borderRadius: 6, background: 'var(--surface-2)', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
                          <ImageIcon size={16} />
                        </div>
                      )}
                    </td>
                    <td style={{ padding: 4, verticalAlign: 'top' }}>
                      <EditableCell value={r.title} multiline placeholder="Title" onSave={(v) => patchScript(r.id, { title: v })} />
                    </td>
                    <td style={{ padding: 4, verticalAlign: 'top' }}>
                      {hasPerPlatformText ? (
                        <PerPlatformCaptionCell
                          value={r.per_platform_text}
                          onSave={(next) => patchScript(r.id, { per_platform_text: next })}
                        />
                      ) : (
                        <EditableCell value={r.caption} placeholder="Caption" onSave={(v) => patchScript(r.id, { caption: v })} />
                      )}
                    </td>
                    <td className="hide-on-tablet" style={{ padding: 4, verticalAlign: 'top' }}>
                      <EditableCell value={r.hashtags} placeholder="#hashtags" onSave={(v) => patchScript(r.id, { hashtags: v })} />
                    </td>
                    <td className="hide-on-tablet" style={{ padding: 4, verticalAlign: 'top' }}>
                      <EditableCell value={r.first_comment} placeholder="First comment" onSave={(v) => patchScript(r.id, { first_comment: v })} />
                    </td>
                    <td style={{ padding: 4, verticalAlign: 'top' }}>
                      <PlatformsCell
                        value={r.platforms}
                        mediaType={r.media_type}
                        onSave={(next) => patchScript(r.id, { platforms: next })}
                      />
                    </td>
                    <td style={{ padding: 8, verticalAlign: 'top', fontSize: 11.5, color: 'var(--text-soft)' }}>
                      <input
                        type="datetime-local"
                        // datetime-local's value is interpreted as LOCAL
                        // wall-clock by the browser. We store
                        // scheduled_datetime as UTC ISO, so we must
                        // convert UTC → local for display, and local →
                        // UTC on change. Without this conversion the
                        // user sees the UTC clock face and an EST user
                        // who picked 11:00 PM sees 3:00 AM on reload.
                        value={r.scheduled_datetime ? toLocalDatetimeInput(r.scheduled_datetime) : ''}
                        onChange={(e) => {
                          const v = e.target.value
                          patchScript(r.id, { scheduled_datetime: v ? new Date(v).toISOString() : null })
                        }}
                        style={{ ...cellInput, fontSize: 11.5 }}
                      />
                    </td>
                    <td style={{ padding: 8, verticalAlign: 'top' }}>
                      <StatusPill status={r.status} error={r.last_error} />
                    </td>
                    <td style={{ padding: 8, verticalAlign: 'middle' }}>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'center' }}>
                        {/* Compress / normalize the source video — runs the
                            ffmpeg worker pass that fixes HEVC, HDR, 4K,
                            sideways, and 60fps quirks in one go. Only shown
                            on video rows that aren't currently compressing. */}
                        {r.media_type === 'video' && Array.isArray(r.media_urls) && r.media_urls[0] && (
                          <button
                            aria-label="Compress / optimize source video"
                            disabled={compressingId === r.id}
                            onClick={() => compressRow(r)}
                            style={{
                              background: 'transparent', border: 'none',
                              color: 'var(--muted)', cursor: 'pointer',
                              padding: 6, borderRadius: 6,
                              opacity: compressingId === r.id ? 0.5 : 1,
                            }}
                            title={compressingId === r.id ? 'Compressing…' : 'Compress / optimize video (fixes HEVC, HDR, 4K, rotation)'}
                          >
                            {compressingId === r.id ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
                          </button>
                        )}
                        {/* Per-row "Polish + embed cover" repair. Runs
                            cover-gen (if missing) + polish-with-cover
                            in one shot. Useful for fixing rows that
                            landed on the calendar without going through
                            the autopilot polish+cover pipeline. */}
                        {r.media_type === 'video' && Array.isArray(r.media_urls) && r.media_urls[0] && (
                          <button
                            aria-label="Repair (polish + cover intro)"
                            disabled={polishingRowId === r.id || !hasCoverTemplate}
                            onClick={() => polishAndEmbedRow(r)}
                            style={{
                              background: 'transparent', border: 'none',
                              color: r.media_url_with_cover ? 'var(--green)' : 'var(--muted)',
                              cursor: (polishingRowId === r.id || !hasCoverTemplate) ? 'not-allowed' : 'pointer',
                              padding: 6, borderRadius: 6,
                              opacity: polishingRowId === r.id ? 0.5 : 1,
                            }}
                            title={
                              !hasCoverTemplate
                                ? 'Repair (cover template not set on brand)'
                                : polishingRowId === r.id
                                  ? 'Repair running…'
                                  : 'Repair: polish video + cover intro'
                            }
                          >
                            {polishingRowId === r.id ? <Loader2 size={14} className="spin" /> : <Film size={14} />}
                          </button>
                        )}
                        <button
                          aria-label="Delete row"
                          onClick={() => deleteScript(r.id)}
                          style={{
                            background: 'transparent', border: 'none',
                            color: 'var(--muted)', cursor: 'pointer',
                            padding: 6, borderRadius: 6,
                          }}
                          title="Delete"
                        ><Trash2 size={14} /></button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        )}
      </div>

      {/* Fullscreen media preview overlay — clicking the thumbnail in the
          Media column opens this. Esc / click-outside closes. */}
      {previewItem && (
        <div
          role="dialog" aria-modal="true" aria-label="Media preview"
          onClick={() => { setPreviewItem(null); setPreviewView('primary') }}
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(6px)',
            display: 'grid', placeItems: 'center', padding: 24,
            cursor: 'zoom-out',
          }}
        >
          {/* Close + download buttons (top corners). */}
          <button
            aria-label="Close preview"
            onClick={(e) => { e.stopPropagation(); setPreviewItem(null); setPreviewView('primary') }}
            style={{
              position: 'absolute', top: 18, left: 18,
              width: 38, height: 38, borderRadius: 999,
              background: 'rgba(255,255,255,0.10)', border: 'none', color: '#fff',
              cursor: 'pointer', display: 'grid', placeItems: 'center', fontSize: 16,
            }}
          >×</button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              const a = document.createElement('a')
              a.href = previewItem.url
              a.download = previewItem.title || (previewItem.type === 'video' ? 'video.mp4' : 'image')
              a.click()
            }}
            style={{
              position: 'absolute', top: 18, right: 18,
              padding: '8px 14px', borderRadius: 999,
              background: 'rgba(255,255,255,0.12)', border: 'none', color: '#fff',
              cursor: 'pointer', fontSize: 12, fontWeight: 700, letterSpacing: '0.04em',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          ><Download size={13} /> Download</button>
          {previewItem.title && (
            <div style={{
              position: 'absolute', top: 24, left: '50%', transform: 'translateX(-50%)',
              color: '#fff', fontSize: 13, opacity: 0.85, fontFamily: 'var(--font-display)',
              maxWidth: '60vw', textAlign: 'center', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{previewItem.title}</div>
          )}
          {/* Pick which asset to display based on the user's tab choice.
              Default ('primary') is whatever the clicked thumbnail showed.
              When the row has BOTH a cover and a source video, we render
              a small two-tab toggle so the user can flip between them
              without leaving the overlay. */}
          {(() => {
            const hasBoth = !!previewItem.coverUrl && !!previewItem.videoUrl
            const active =
              previewView === 'cover' ? 'cover'
              : previewView === 'video' ? 'video'
              : previewItem.videoUrl ? 'video'
              : 'cover'
            const displayUrl =
              active === 'cover' ? (previewItem.coverUrl || previewItem.url)
              : active === 'video' ? (previewItem.videoUrl || previewItem.url)
              : previewItem.url
            const displayIsVideo = active === 'video'

            return (
              <>
                {hasBoth && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      position: 'absolute', top: 70, left: '50%', transform: 'translateX(-50%)',
                      display: 'flex', gap: 4, padding: 4, borderRadius: 999,
                      background: 'rgba(255,255,255,0.10)',
                    }}
                  >
                    {[
                      { id: 'cover', label: 'Instagram cover' },
                      { id: 'video', label: 'Source video' },
                    ].map((t) => {
                      const on = active === t.id
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setPreviewView(t.id)}
                          style={{
                            padding: '6px 14px', borderRadius: 999, border: 'none',
                            background: on ? 'rgba(255,255,255,0.95)' : 'transparent',
                            color: on ? '#000' : '#fff',
                            fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11,
                            letterSpacing: '0.04em', cursor: 'pointer',
                          }}
                        >{t.label}</button>
                      )
                    })}
                  </div>
                )}

                {displayIsVideo ? (
                  <video
                    src={displayUrl} controls autoPlay
                    onClick={(e) => e.stopPropagation()}
                    style={{ maxWidth: '92vw', maxHeight: '88vh', borderRadius: 8, background: '#000' }}
                  />
                ) : (
                  <img
                    src={displayUrl} alt={previewItem.title || ''}
                    onClick={(e) => e.stopPropagation()}
                    style={{ maxWidth: '92vw', maxHeight: '88vh', borderRadius: 8, objectFit: 'contain' }}
                  />
                )}
              </>
            )
          })()}
        </div>
      )}

      {/* Polish settings modal — mounts the SAME VideoPolishEditor the
          Spaces canvas uses. Reads/writes profiles.polish_template so
          edits on either surface immediately persist for both. */}
      {polishSettingsOpen && createPortal(
        <div
          className="modal-overlay"
          onClick={() => setPolishSettingsOpen(false)}
        >
          <div
            className="modal-card modal-card-lg"
            onClick={(e) => e.stopPropagation()}
            style={{ maxHeight: '90vh', overflow: 'auto' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
              <Sparkles size={18} style={{ color: '#0ea5e9', marginRight: 10 }} />
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, flex: 1 }}>
                Polish settings
              </h3>
              <button
                aria-label="Close"
                onClick={() => setPolishSettingsOpen(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6, borderRadius: 6 }}
              ><X size={20} /></button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.45 }}>
              These settings save to your brand profile and are shared with the <strong>Finish video</strong> node on your Spaces canvas. Edit in either place; both stay in sync.
            </div>
            {polishTemplate !== null && (
              <VideoPolishEditor
                nodeId="__bulk_polish__"
                data={{ props: polishTemplate, output: null, _ctxProfileId: profileId, _ctxToken: token }}
                onPatch={patchPolishTemplate}
                allNodes={[]}
                allEdges={[]}
              />
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
