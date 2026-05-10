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
import {
  Upload, Loader2, Sparkles, CalendarClock, Send, Download, Trash2,
  Check, X, AlertCircle, Image as ImageIcon, Video as VideoIcon, ChevronDown, Zap,
} from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { toast, confirmDialog } from './Toast.jsx'

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
const ROW_PLATFORMS = [
  { id: 'tiktok',    label: 'TikTok',    kinds: ['video'] },
  { id: 'instagram', label: 'Instagram', kinds: ['image', 'video'] },
  { id: 'youtube',   label: 'YouTube',   kinds: ['video'] },
  { id: 'facebook',  label: 'Facebook',  kinds: ['image', 'video'] },
  { id: 'linkedin',  label: 'LinkedIn',  kinds: ['image', 'video'] },
  { id: 'threads',   label: 'Threads',   kinds: ['image', 'video'] },
  { id: 'x',         label: 'X',         kinds: ['image', 'video'] },
]

function PlatformsCell({ value, mediaType, onSave }) {
  const cur = Array.isArray(value) ? value : []
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  const toggle = (id) => {
    const next = cur.includes(id) ? cur.filter((p) => p !== id) : [...cur, id]
    onSave(next)
  }
  const visible = ROW_PLATFORMS.filter((p) => !mediaType || p.kinds.includes(mediaType))
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%', padding: '6px 8px', borderRadius: 6,
          border: '1px solid var(--border)', background: 'var(--surface-2)',
          color: 'var(--text-soft)', fontSize: 11.5, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4,
        }}
        title="Pick which platforms this row publishes to"
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {cur.length === 0 ? <span style={{ color: 'var(--muted)' }}>Pick platforms</span> : cur.join(', ')}
        </span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 30,
          minWidth: 180, padding: 6, borderRadius: 8,
          background: 'var(--surface)', border: '1px solid var(--border)',
          boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
        }}>
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
        </div>
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

// ── status pill ─────────────────────────────────────────────────────────────
const PILL = {
  draft:         { bg: 'rgba(255,255,255,0.06)', fg: 'var(--muted)', label: 'Draft' },
  caption_ready: { bg: 'rgba(245,158,11,0.16)',  fg: '#f59e0b',     label: 'Caption ready' },
  scheduled:     { bg: 'rgba(96,165,250,0.16)',  fg: '#60a5fa',     label: 'Scheduled' },
  posted:        { bg: 'rgba(46,204,113,0.16)',  fg: '#2ecc71',     label: 'Published' },
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
        const platforms = defaultPlatforms.filter((p) => compatibleByKind.has(p))

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
    const all = (scripts || []).filter(tabFn)
    const s = search.trim().toLowerCase()
    if (!s) return all
    return all.filter((r) => (r.title || '').toLowerCase().includes(s)
      || (r.caption || '').toLowerCase().includes(s)
      || (r.full_script || '').toLowerCase().includes(s)
      || (r.hashtags || '').toLowerCase().includes(s))
  }, [scripts, tab, search]) // eslint-disable-line react-hooks/exhaustive-deps
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
  const patchScript = async (id, patch) => {
    setScripts((arr) => arr.map((r) => r.id === id ? { ...r, ...patch } : r))
    try {
      const r = await fetch(`/api/content?id=${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error(b?.error || `Save failed (${r.status})`)
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
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 1100, borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ ...headerCell, width: 32 }} aria-label="Select">{' '}</th>
                <th style={{ ...headerCell, width: 70 }}>Media</th>
                <th style={{ ...headerCell, minWidth: 160 }}>Title</th>
                <th style={{ ...headerCell, minWidth: 200 }}>Script</th>
                <th style={{ ...headerCell, minWidth: 200 }}>Caption</th>
                <th style={{ ...headerCell, minWidth: 160 }}>Hashtags</th>
                <th style={{ ...headerCell, minWidth: 160 }}>1st Comment</th>
                <th style={{ ...headerCell, width: 160 }}>Platforms</th>
                <th style={{ ...headerCell, width: 140 }}>Scheduled</th>
                <th style={{ ...headerCell, width: 120 }}>Status</th>
                <th style={{ ...headerCell, width: 80 }}>Actions</th>
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
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
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
                            width: 56, height: 56, padding: 0, borderRadius: 6,
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
                      ) : (
                        <div style={{ width: 56, height: 56, borderRadius: 6, background: 'var(--surface-2)', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
                          <ImageIcon size={18} />
                        </div>
                      )}
                    </td>
                    <td style={{ padding: 4, verticalAlign: 'top' }}>
                      <EditableCell value={r.title} multiline placeholder="Title" onSave={(v) => patchScript(r.id, { title: v })} />
                    </td>
                    <td style={{ padding: 4, verticalAlign: 'top' }}>
                      <EditableCell value={r.full_script} placeholder="Script / transcript" onSave={(v) => patchScript(r.id, { full_script: v })} />
                    </td>
                    <td style={{ padding: 4, verticalAlign: 'top' }}>
                      <EditableCell value={r.caption} placeholder="Caption" onSave={(v) => patchScript(r.id, { caption: v })} />
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
