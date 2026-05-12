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
  RefreshCw, Type,
} from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { toast, confirmDialog } from './Toast.jsx'
import { PlatformBadge, PLATFORMS as PB_PLATFORMS } from './PlatformBadge.jsx'

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
function StatusPill({ status }) {
  const p = PILL[status] || PILL.draft
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 8px', borderRadius: 999,
      background: p.bg, color: p.fg,
      fontSize: 10.5, fontFamily: 'var(--font-display)', fontWeight: 700,
      letterSpacing: '0.04em',
    }}>{p.label}</span>
  )
}

// ── main component ──────────────────────────────────────────────────────────
export default function BulkUploadView({ profileId, token, onChange }) {
  const [scripts, setScripts] = useState(null) // null = loading, [] = empty
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('queued')
  // Post-kind filter chip: all | video | image | text. Quick way to
  // narrow the queue when you only want to see (say) all text posts
  // landing this week.
  const [kindFilter, setKindFilter] = useState('all')
  // Platform filter — set of platform ids the user wants to see. Empty
  // set = no filter. Multi-select so the user can ask for "tiktok or
  // instagram" without scrolling rows.
  const [platformFilter, setPlatformFilter] = useState(() => new Set())
  // Date-range filter for the scheduled_datetime field. 'all' is the
  // default (everything visible regardless of when it fires). 'today',
  // 'week', '7d' are quick presets — 'custom' arms the two from/to
  // inputs below.
  const [dateRange, setDateRange] = useState('all') // 'all' | 'today' | 'week' | '7d' | 'custom'
  const [customFrom, setCustomFrom] = useState('')  // YYYY-MM-DD
  const [customTo, setCustomTo] = useState('')      // YYYY-MM-DD
  // Sort order. Sort happens AFTER all filters so the user's filter
  // selection isn't re-shuffled by sort changes.
  const [sortBy, setSortBy] = useState('scheduled') // 'scheduled' | 'created' | 'title'
  // Group by platform: when true, rows fan out so each platform a row
  // publishes to becomes its own row. Helpful for "show me everything
  // going to TikTok this week" reads. Off by default.
  const [groupByPlatform, setGroupByPlatform] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [search, setSearch] = useState('')
  const [busyAction, setBusyAction] = useState(null) // 'captions' | 'schedule' | 'publish'
  const [uploads, setUploads] = useState([]) // {id, name, kind, progress, error?}
  const [previewItem, setPreviewItem] = useState(null) // { url, type, title } for fullscreen media preview
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
  // Tracks "we're running the auto-pipeline right now" so the toolbar
  // shows the right status banner instead of a silent spinner.
  const [autoStage, setAutoStage] = useState(null) // null | 'captions' | 'schedule'
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
      })
      .catch(() => { if (!cancelled) setDefaultPlatforms([]) })
    return () => { cancelled = true }
  }, [profileId, token])

  // Esc closes the preview overlay.
  useEffect(() => {
    if (!previewItem) return
    const onKey = (e) => { if (e.key === 'Escape') setPreviewItem(null) }
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
          toast({ kind: 'error', message: `Auto-caption failed: ${cb?.error || c.status}. Rows are saved as drafts.` })
        }
        return
      }
      setAutoStage('schedule')
      const s = await fetch(`/api/content/bulk-actions?action=auto-schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile_id: profileId, script_ids: ids }),
      })
      const sb = await s.json().catch(() => ({}))
      if (!s.ok) {
        toast({ kind: 'error', message: `Auto-schedule failed: ${sb?.error || s.status}. Rows are caption-ready; click Auto Schedule to retry.` })
        return
      }
      const captioned = cb.updated ?? ids.length
      const scheduled = sb.scheduled ?? 0
      const skipped = sb.skipped ?? 0
      toast({
        kind: 'success',
        message: `Auto-processed ${ids.length}: ${captioned} captioned, ${scheduled} scheduled${skipped ? `, ${skipped} skipped (no open slots — set a posting schedule on the profile)` : ''}.`,
      })
    } catch (e) {
      toast({ kind: 'error', message: `Auto-process failed: ${e.message}` })
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
    if (platformFilter.size > 0) {
      // OR semantics — show a row if any of its platforms intersects
      // the filter. That matches user intent ("show me posts going to
      // TikTok or Instagram") better than AND would.
      all = all.filter((r) => {
        const pls = Array.isArray(r.platforms) ? r.platforms : []
        return pls.some((p) => platformFilter.has(p))
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
    // Group by platform: explode each row into one row per platform.
    // The row's `platforms` array becomes a single-element array on each
    // fan-out copy so the rendering layer shows just that platform's
    // badge. id is suffixed so React keys stay unique.
    if (groupByPlatform) {
      const exploded = []
      for (const r of all) {
        const pls = Array.isArray(r.platforms) ? r.platforms : []
        if (pls.length <= 1) {
          exploded.push(r)
          continue
        }
        for (const p of pls) {
          exploded.push({ ...r, id: `${r.id}__${p}`, platforms: [p], _grouped_parent_id: r.id })
        }
      }
      all = exploded
    }
    // Sort last so the filter result is stable across sort changes.
    const sorted = [...all].sort((a, b) => {
      if (sortBy === 'created') {
        return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
      }
      if (sortBy === 'title') {
        return String(a.title || '').localeCompare(String(b.title || ''))
      }
      // 'scheduled' — earliest first, un-scheduled rows last.
      const ta = a.scheduled_datetime ? new Date(a.scheduled_datetime).getTime() : Infinity
      const tb = b.scheduled_datetime ? new Date(b.scheduled_datetime).getTime() : Infinity
      return ta - tb
    })
    return sorted
  }, [scripts, tab, search, kindFilter, platformFilter, dateRange, customFrom, customTo, sortBy, groupByPlatform]) // eslint-disable-line react-hooks/exhaustive-deps
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
  const deleteScript = async (id) => {
    const ok = await confirmDialog({ title: 'Delete this row?', confirmText: 'Delete', destructive: true })
    if (!ok) return
    try {
      await fetch(`/api/content?id=${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      setScripts((arr) => arr.filter((r) => r.id !== id))
      setSelected((s) => { const n = new Set(s); n.delete(id); return n })
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
        : body.scheduled != null ? `${label}: ${body.scheduled} scheduled${body.skipped ? `, ${body.skipped} skipped` : ''}`
        : body.submitted != null ? `${label}: ${body.submitted} submitted${body.failed ? `, ${body.failed} failed` : ''}`
        : body.resynced != null ? `${label}: ${body.resynced} resynced${body.failed ? `, ${body.failed} failed` : ''}${body.skipped ? `, ${body.skipped} skipped` : ''}`
        : `${label} done`
      toast({ kind: 'success', message: summary })
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
        style={{
          background: 'var(--surface)',
          border: '2px dashed var(--border)',
          borderRadius: 14, padding: 20, marginBottom: 18,
          display: 'flex', alignItems: 'center', gap: 16,
          transition: 'border-color 0.15s, background 0.15s',
        }}
        onClick={() => fileRef.current?.click()}
      >
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
            {autoProcess
              ? <>Drag &amp; drop videos or images. Captions, hashtags, titles &amp; first comments are written automatically from your brand bible, then each post is slotted into the next open time on your <strong>posting schedule</strong>.</>
              : <>Drag &amp; drop videos or images. Rows save as drafts — click <strong>Generate Captions</strong> and <strong>Auto Schedule</strong> when ready.</>
            }
          </div>
        </div>
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
        <button
          className="btn-secondary"
          onClick={(e) => { e.stopPropagation(); fileRef.current?.click() }}
          style={{ padding: '8px 12px' }}
          aria-label="Choose files to upload"
        ><Upload size={14} /> Choose files</button>
        <input
          ref={fileRef} type="file" multiple
          accept="video/*,image/*"
          aria-label="Bulk upload media files"
          style={{ display: 'none' }}
          onChange={(e) => { onFiles(e.target.files); e.target.value = '' }}
        />
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
                : <Loader2 size={14} className="spin" />}
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</div>
              {u.error
                ? <span style={{ color: 'var(--red)' }}>{u.error}</span>
                : <div style={{ width: 80, height: 6, background: 'var(--surface)', borderRadius: 999, overflow: 'hidden' }}>
                    <div style={{ width: `${u.progress}%`, height: '100%', background: '#f59e0b', transition: 'width 0.2s' }} />
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
        {/* Platform filter chips. Multi-select — click each platform
            you want to see, click again to remove. Empty set = no
            filter. */}
        <div
          title="Filter rows by platform — click to toggle, OR semantics"
          style={{
            display: 'flex', gap: 4, paddingLeft: 6,
            borderLeft: '1px solid var(--border)',
          }}
        >
          {ROW_PLATFORMS.map((p) => {
            const on = platformFilter.has(p.id)
            return (
              <button
                key={p.id}
                onClick={() => {
                  setPlatformFilter((prev) => {
                    const next = new Set(prev)
                    if (next.has(p.id)) next.delete(p.id); else next.add(p.id)
                    return next
                  })
                }}
                style={{
                  padding: 4, borderRadius: 999,
                  background: on ? 'rgba(46,204,113,0.18)' : 'transparent',
                  border: `1px solid ${on ? 'rgba(46,204,113,0.55)' : 'transparent'}`,
                  cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  opacity: on ? 1 : 0.55,
                  transition: 'opacity 0.12s, background 0.12s',
                }}
                aria-pressed={on}
                title={`${on ? 'Hide' : 'Show only'} ${p.label} posts`}
              >
                <PlatformBadge id={p.id} size={20} />
              </button>
            )
          })}
          {platformFilter.size > 0 && (
            <button
              onClick={() => setPlatformFilter(new Set())}
              style={{
                marginLeft: 2, padding: '4px 8px', borderRadius: 999,
                background: 'transparent', border: '1px solid var(--border)',
                color: 'var(--muted)', cursor: 'pointer',
                fontFamily: 'var(--font-display)', fontSize: 10.5, fontWeight: 700,
              }}
              title="Clear platform filter"
            >Clear</button>
          )}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--muted)', paddingLeft: 6, borderLeft: '1px solid var(--border)' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase', marginRight: 4 }}>Sort</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{ padding: '5px 8px', fontSize: 11.5, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
          >
            <option value="scheduled">Scheduled time</option>
            <option value="created">Recently created</option>
            <option value="title">Title A → Z</option>
          </select>
        </div>
        <label
          title="Show one row per platform per post (fan out grouped rows)"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, paddingLeft: 6,
            borderLeft: '1px solid var(--border)',
            fontFamily: 'var(--font-display)', fontSize: 11.5, fontWeight: 700,
            color: groupByPlatform ? 'var(--text)' : 'var(--muted)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={groupByPlatform}
            onChange={(e) => setGroupByPlatform(e.target.checked)}
          />
          Group by platform
        </label>
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
        {/* No horizontal scroll wrapper. Column widths below are tuned
            so the row fits on a typical 1440-px laptop minus the side
            nav. Script column dropped — captions / hashtags / first
            comment are the actually-edited fields here; the full
            script lives on the Content modal if anyone needs it. */}
        <div>
          <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ ...headerCell, width: 30 }} aria-label="Select">{' '}</th>
                <th style={{ ...headerCell, width: 64 }}>Media</th>
                <th style={{ ...headerCell, width: 36 }} aria-label="Type" title="Post type">Type</th>
                <th style={{ ...headerCell }}>Title</th>
                {/* Width tuning: Scheduled needs ~175px for the
                    datetime-local input to render "MM/DD/YYYY HH:MM AM"
                    fully (130px clipped the AM/PM). Caption + 1st
                    comment trimmed to give that space back — title
                    column is auto-width so it claims whatever's left
                    after the fixed columns. */}
                <th style={{ ...headerCell, width: '20%' }}>Caption</th>
                <th style={{ ...headerCell, width: '13%' }}>Hashtags</th>
                <th style={{ ...headerCell, width: '13%' }}>1st comment</th>
                <th style={{ ...headerCell, width: 100 }}>Platforms</th>
                <th style={{ ...headerCell, width: 175 }}>Scheduled</th>
                <th style={{ ...headerCell, width: 90 }}>Status</th>
                <th style={{ ...headerCell, width: 44 }} aria-label="Actions">{' '}</th>
              </tr>
            </thead>
            <tbody>
              {scripts === null ? (
                <tr><td colSpan={11} style={{ padding: 60, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={18} className="spin" /></td></tr>
              ) : visible.length === 0 ? (
                <tr><td colSpan={11} style={{ padding: 60, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                  {tab === 'queued' && 'No queued posts. Drop media above to start.'}
                  {tab === 'error' && 'No failed posts.'}
                  {tab === 'delivered' && 'Nothing delivered yet.'}
                </td></tr>
              ) : visible.map((r) => {
                const thumb = Array.isArray(r.media_urls) && r.media_urls[0]
                const isVideo = r.media_type === 'video'
                const isText = r.media_type === 'text'
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
                          onClick={(e) => { e.stopPropagation(); setPreviewItem({ url: thumb, type: isVideo ? 'video' : 'image', title: r.title }) }}
                          aria-label={`Preview ${r.title || 'media'}`}
                          title="Click to preview"
                          style={{
                            position: 'relative',
                            width: 48, height: 48, padding: 0, borderRadius: 6,
                            border: '1px solid var(--border)', background: '#000',
                            cursor: 'pointer', overflow: 'hidden', display: 'block',
                          }}
                        >
                          {isVideo
                            ? <video src={thumb} muted playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }} />
                            : <img src={thumb} alt={r.title || 'media'} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }} />}
                          {isVideo && (
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
                    <td style={{ padding: 6, verticalAlign: 'top', textAlign: 'center' }}>
                      <span
                        title={isVideo ? 'Video post' : isText ? 'Text post' : 'Image post'}
                        style={{ color: kindBorder, display: 'inline-flex' }}
                      >
                        {isVideo ? <VideoIcon size={16} /> : isText ? <Type size={16} /> : <ImageIcon size={16} />}
                      </span>
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
                    <td style={{ padding: 4, verticalAlign: 'top' }}>
                      <EditableCell value={r.hashtags} placeholder="#hashtags" onSave={(v) => patchScript(r.id, { hashtags: v })} />
                    </td>
                    <td style={{ padding: 4, verticalAlign: 'top' }}>
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
                      <StatusPill status={r.status} />
                    </td>
                    <td style={{ padding: 8, verticalAlign: 'top' }}>
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
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Fullscreen media preview overlay — clicking the thumbnail in the
          Media column opens this. Esc / click-outside closes. */}
      {previewItem && (
        <div
          role="dialog" aria-modal="true" aria-label="Media preview"
          onClick={() => setPreviewItem(null)}
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
            onClick={(e) => { e.stopPropagation(); setPreviewItem(null) }}
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
          {previewItem.type === 'video' ? (
            <video
              src={previewItem.url} controls autoPlay
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: '92vw', maxHeight: '88vh', borderRadius: 8, background: '#000' }}
            />
          ) : (
            <img
              src={previewItem.url} alt={previewItem.title || ''}
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: '92vw', maxHeight: '88vh', borderRadius: 8, objectFit: 'contain' }}
            />
          )}
        </div>
      )}
    </div>
  )
}
