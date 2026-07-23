// PostPreviewModal — expanded post editor with pagination.
//
// Triggered from the schedule list (BulkUploadView / Content row). The
// user clicks the "expand" icon next to a row's caption and lands in
// a full-bleed modal with:
//
//   • Title, hook, hashtags inline-editable
//   • Per-platform variant tabs (threads, twitter, instagram, facebook,
//     linkedin, etc.) — each variant edits the per_platform_text jsonb
//   • Scheduled-datetime input
//   • Status pill + approval state
//   • ← / → arrows + keyboard shortcuts to cycle through the SAME list
//     the modal was opened from (filtered text-only posts, or whatever
//     the caller passed). The arrows wrap.
//   • Approve / Reject buttons that hit /api/content?action=approve|reject
//
// Caller wires the items list + initial index. The modal owns its own
// dirty-tracking + auto-save (debounced PATCH on field change), so the
// caller's row data stays the source of truth between renders.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  X, ChevronLeft, ChevronRight, Calendar, Check, AlertCircle,
  ExternalLink, Hash, Loader2, Trash2,
} from 'lucide-react'
import { PlatformBadge } from './PlatformBadge.jsx'

// Char caps per platform. Aligned with the bulk-list per-platform editor
// + the upload-post side, with a generous default for anything not in
// the map.
const PLATFORM_CAPS = {
  threads: 500, twitter: 280, x: 280, instagram: 2200,
  facebook: 5000, linkedin: 3000, tiktok: 2200, youtube: 5000,
  bluesky: 300, pinterest: 800,
}

export default function PostPreviewModal({ items, initialIndex, token, onClose, onSaved }) {
  const [idx, setIdx] = useState(Math.max(0, Math.min(initialIndex ?? 0, items.length - 1)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Local override map (id → patched fields). Lets the modal carry
  // in-flight edits across arrow nav without waiting on the realtime
  // round-trip to update the parent's items. Each PATCH success folds
  // the field into the override; nav reads override-or-original.
  const [overrides, setOverrides] = useState({})

  const total = items.length
  const baseRow = items[idx] || null
  const row = baseRow ? { ...baseRow, ...(overrides[baseRow.id] || {}) } : null

  const goPrev = useCallback(() => {
    if (total <= 1) return
    setIdx((i) => (i - 1 + total) % total)
  }, [total])
  const goNext = useCallback(() => {
    if (total <= 1) return
    setIdx((i) => (i + 1) % total)
  }, [total])

  // Lock body scroll.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // Keyboard nav. Skip when the user is typing inside a textarea/input.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target?.tagName === 'TEXTAREA' || e.target?.tagName === 'INPUT') return
      if (e.key === 'ArrowLeft')  { e.preventDefault(); goPrev() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNext() }
      else if (e.key === 'Escape') { e.preventDefault(); onClose?.() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goPrev, goNext, onClose])

  const patchField = useCallback(async (id, patch) => {
    setError(null)
    // Optimistic local fold so the next/prev arrow renders the new value
    // immediately. If PATCH fails we surface the error but keep the
    // override so the user can retry without losing their edit.
    setOverrides((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }))
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
      onSaved?.(id, patch)
    } catch (e) {
      setError(e.message)
    }
  }, [token, onSaved])

  const callAction = useCallback(async (id, action, body = {}) => {
    setBusy(true); setError(null)
    try {
      const r = await fetch(`/api/content?id=${id}&action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b?.error || `${action} failed (${r.status})`)
      // Fold action result into override so the new status sticks in UI.
      const update = {}
      if (action === 'approve') {
        update.approval_status = 'approved'
        update.status = b?.status || 'scheduled'
        if (b?.uploadpost_request_id) update.uploadpost_request_id = b.uploadpost_request_id
      } else if (action === 'reject') {
        update.approval_status = 'rejected'
        update.needs_approval = false
      }
      if (Object.keys(update).length) {
        setOverrides((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...update } }))
      }
      onSaved?.(id, update)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [token, onSaved])

  if (!row) return null

  // Portal to document.body: an ancestor on the schedule page creates a
  // containing block (transform/filter), which demotes position:fixed
  // to in-flow positioning — the overlay rendered BELOW the table, so
  // opening the modal showed a blank screen until the user scrolled.
  // Same fix as NewLookModal/NewVideoModal.
  return createPortal(
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      {/* Left arrow */}
      {total > 1 && (
        <button onClick={goPrev} aria-label="Previous post" style={navBtn('left')}>
          <ChevronLeft size={26} />
        </button>
      )}

      <div style={cardStyle}>
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div style={countPill}>{idx + 1} / {total}</div>
            <StatusPill row={row} />
          </div>
          <button onClick={onClose} style={closeBtn} aria-label="Close"><X size={18} /></button>
        </div>

        {error && (
          <div style={errorPanel}>
            <AlertCircle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
            {error}
          </div>
        )}

        <div style={bodyStyle}>
          <Field label="Title">
            <input
              type="text"
              value={row.title || ''}
              onChange={(e) => setOverrides((prev) => ({ ...prev, [row.id]: { ...(prev[row.id] || {}), title: e.target.value } }))}
              onBlur={(e) => patchField(row.id, { title: e.target.value })}
              placeholder="Post title"
              style={titleInput}
            />
          </Field>

          {row.hook && (
            <Field label="Hook">
              <textarea
                value={row.hook || ''}
                onChange={(e) => setOverrides((prev) => ({ ...prev, [row.id]: { ...(prev[row.id] || {}), hook: e.target.value } }))}
                onBlur={(e) => patchField(row.id, { hook: e.target.value })}
                rows={2}
                style={hookInput}
              />
            </Field>
          )}

          <PlatformCaptionEditor
            row={row}
            onSave={(next) => patchField(row.id, { per_platform_text: next })}
            onSaveCaption={(cap) => patchField(row.id, { caption: cap })}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16, marginTop: 16 }}>
            <Field label="Hashtags">
              <input
                type="text"
                value={row.hashtags || ''}
                onChange={(e) => setOverrides((prev) => ({ ...prev, [row.id]: { ...(prev[row.id] || {}), hashtags: e.target.value } }))}
                onBlur={(e) => patchField(row.id, { hashtags: e.target.value })}
                placeholder="#tags space-separated"
                style={inputStyle}
              />
            </Field>
            <Field label="Scheduled for">
              <input
                type="datetime-local"
                value={isoToLocal(row.scheduled_datetime)}
                onChange={(e) => {
                  const iso = localToIso(e.target.value)
                  setOverrides((prev) => ({ ...prev, [row.id]: { ...(prev[row.id] || {}), scheduled_datetime: iso } }))
                }}
                onBlur={(e) => {
                  const iso = localToIso(e.target.value)
                  if (iso !== row.scheduled_datetime) patchField(row.id, { scheduled_datetime: iso })
                }}
                style={inputStyle}
              />
            </Field>
          </div>

          <div style={metaRow}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
              <Hash size={12} /> {row.id?.slice(0, 8)}…
            </div>
            {Array.isArray(row.platforms) && row.platforms.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {row.platforms.map((p) => <PlatformBadge key={p} id={p} size={14} />)}
              </div>
            )}
            {row.uploadpost_request_id && (
              <div style={{ fontSize: 11.5, color: '#22c55e', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <ExternalLink size={11} /> Live on Upload-Post
              </div>
            )}
          </div>
        </div>

        <div style={footerStyle}>
          <button
            onClick={() => callAction(row.id, 'reject', { reason: 'Rejected from preview' })}
            disabled={busy || row.approval_status === 'rejected'}
            style={{ ...actionBtn, ...rejectBtn }}
          >
            <Trash2 size={14} /> Reject
          </button>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => callAction(row.id, 'approve')}
            disabled={busy || row.approval_status === 'approved'}
            style={{ ...actionBtn, ...approveBtn }}
          >
            {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
            {row.approval_status === 'approved' ? 'Approved' : 'Approve + schedule'}
          </button>
        </div>
      </div>

      {total > 1 && (
        <button onClick={goNext} aria-label="Next post" style={navBtn('right')}>
          <ChevronRight size={26} />
        </button>
      )}
    </div>,
    document.body,
  )
}

// ── Sub-components ───────────────────────────────────────────────

function StatusPill({ row }) {
  const map = {
    draft:         { bg: 'var(--surface-2)', fg: 'var(--muted)', label: 'Draft' },
    caption_ready: { bg: 'rgba(245,158,11,0.16)', fg: '#f59e0b', label: 'Caption ready' },
    scheduled:     { bg: 'rgba(34,197,94,0.16)', fg: '#22c55e', label: 'Scheduled' },
    posted:        { bg: 'rgba(99,102,241,0.16)', fg: '#818cf8', label: 'Posted' },
    failed:        { bg: 'rgba(239,68,68,0.16)', fg: 'var(--red)', label: 'Failed' },
  }
  const s = map[row.status] || map.draft
  const a = row.approval_status
  return (
    <>
      <span style={{ ...pillBase, background: s.bg, color: s.fg }}>{s.label}</span>
      {a === 'approved' && <span style={{ ...pillBase, background: 'rgba(34,197,94,0.12)', color: '#22c55e' }}>Approved</span>}
      {a === 'pending'  && <span style={{ ...pillBase, background: 'rgba(245,158,11,0.12)', color: '#f59e0b' }}>Pending</span>}
      {a === 'rejected' && <span style={{ ...pillBase, background: 'rgba(239,68,68,0.12)', color: 'var(--red)' }}>Rejected</span>}
    </>
  )
}

function PlatformCaptionEditor({ row, onSave, onSaveCaption }) {
  const platforms = useMemo(() => {
    if (Array.isArray(row.platforms) && row.platforms.length) return row.platforms
    if (row.per_platform_text && typeof row.per_platform_text === 'object') {
      return Object.keys(row.per_platform_text)
    }
    return []
  }, [row.platforms, row.per_platform_text])

  const hasPpt = !!row.per_platform_text && typeof row.per_platform_text === 'object'
  const [active, setActive] = useState(hasPpt ? (platforms[0] || 'generic') : 'generic')

  useEffect(() => {
    if (!platforms.includes(active) && active !== 'generic') {
      setActive(hasPpt ? (platforms[0] || 'generic') : 'generic')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platforms.join('|')])

  const isGeneric = active === 'generic' || !hasPpt
  const current = isGeneric ? (row.caption || '') : (row.per_platform_text?.[active] || '')
  const [draft, setDraft] = useState(current)
  useEffect(() => { setDraft(current) }, [current, active])

  const cap = PLATFORM_CAPS[active] || (isGeneric ? null : 1000)
  const over = cap && draft.length > cap

  const commit = () => {
    if (draft === current) return
    if (isGeneric) onSaveCaption(draft)
    else onSave({ ...(row.per_platform_text || {}), [active]: draft })
  }

  return (
    <Field label="Caption">
      <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
        {hasPpt && platforms.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setActive(p)}
            style={{
              padding: '6px 12px', borderRadius: 6,
              fontSize: 12, fontWeight: 700,
              background: active === p ? 'var(--surface-2)' : 'transparent',
              border: `1px solid ${active === p ? 'var(--border)' : 'transparent'}`,
              color: active === p ? 'var(--text)' : 'var(--muted)',
              cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5,
              textTransform: 'capitalize',
            }}
          >
            <PlatformBadge id={p} size={13} /> {p}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setActive('generic')}
          style={{
            padding: '6px 12px', borderRadius: 6,
            fontSize: 12, fontWeight: 700,
            background: active === 'generic' ? 'var(--surface-2)' : 'transparent',
            border: `1px solid ${active === 'generic' ? 'var(--border)' : 'transparent'}`,
            color: active === 'generic' ? 'var(--text)' : 'var(--muted)',
            cursor: 'pointer',
          }}
        >Generic</button>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        rows={10}
        placeholder={isGeneric ? 'Generic caption' : `${active} variant`}
        style={{ ...captionInput, borderColor: over ? 'var(--red)' : 'var(--border)' }}
      />
      {cap && (
        <div style={{ fontSize: 11, color: over ? 'var(--red)' : 'var(--muted)', marginTop: 4, textAlign: 'right' }}>
          {draft.length} / {cap}
        </div>
      )}
    </Field>
  )
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.06, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>{label}</div>
      {children}
    </label>
  )
}

// ── helpers ──────────────────────────────────────────────────────

function isoToLocal(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function localToIso(local) {
  if (!local) return null
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

// ── styles ───────────────────────────────────────────────────────

const overlayStyle = {
  position: 'fixed', inset: 0, zIndex: 260,
  background: 'rgba(10,10,12,0.85)', backdropFilter: 'blur(6px)',
  // flex-start + margin:auto on the card (not align-items:center):
  // centering a child taller than the viewport clips its TOP with no
  // way to scroll up — the "blank screen, scroll down to find it" bug.
  // margin:auto centers when the card fits and pins to the top edge
  // when it doesn't, keeping everything reachable via overlay scroll.
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
  padding: '20px 80px', overflowY: 'auto',
}
const cardStyle = {
  width: '100%', maxWidth: 820,
  margin: 'auto',
  background: 'var(--bg-base, #0a0a0c)',
  border: '1px solid var(--border)', borderRadius: 14,
  display: 'flex', flexDirection: 'column',
  maxHeight: 'calc(100vh - 40px)',
  boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
}
const headerStyle = {
  padding: '14px 22px',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  borderBottom: '1px solid var(--border)',
}
const countPill = {
  padding: '4px 10px', borderRadius: 999,
  background: 'var(--surface-2)', fontSize: 11.5, fontWeight: 700,
  color: 'var(--text)', letterSpacing: 0.02,
}
const pillBase = {
  padding: '3px 10px', borderRadius: 999, fontSize: 11,
  fontWeight: 700, letterSpacing: 0.04, marginLeft: 6,
}
const closeBtn = {
  background: 'transparent', border: 'none', cursor: 'pointer',
  color: 'var(--muted)', padding: 6, display: 'inline-flex', alignItems: 'center',
}
const bodyStyle = {
  padding: '18px 22px 8px',
  overflowY: 'auto', flex: 1, minHeight: 0,
}
const footerStyle = {
  padding: '14px 22px',
  borderTop: '1px solid var(--border)',
  display: 'flex', alignItems: 'center', gap: 10,
}
const errorPanel = {
  margin: '0 22px', padding: '10px 14px',
  background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.35)',
  borderRadius: 8, color: 'var(--red)', fontSize: 13,
}
const titleInput = {
  width: '100%', padding: '10px 14px', fontSize: 17, fontWeight: 700,
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 8, color: 'var(--text)', fontFamily: 'inherit',
  boxSizing: 'border-box',
}
const hookInput = {
  width: '100%', padding: '10px 14px', fontSize: 14, lineHeight: 1.5,
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 8, color: 'var(--text)', fontFamily: 'inherit',
  boxSizing: 'border-box', resize: 'vertical',
}
const inputStyle = {
  width: '100%', padding: '8px 12px', fontSize: 13,
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 8, color: 'var(--text)', fontFamily: 'inherit',
  boxSizing: 'border-box',
}
const captionInput = {
  width: '100%', padding: '12px 14px', fontSize: 14, lineHeight: 1.55,
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 8, color: 'var(--text)', fontFamily: 'inherit',
  boxSizing: 'border-box', resize: 'vertical',
}
const metaRow = {
  display: 'flex', alignItems: 'center', gap: 14, marginTop: 12, paddingTop: 12,
  borderTop: '1px solid var(--border)', flexWrap: 'wrap',
}
const actionBtn = {
  padding: '10px 18px', borderRadius: 8, border: '1.5px solid',
  fontWeight: 700, fontSize: 13.5, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 6,
}
const approveBtn = {
  background: 'rgba(34,197,94,0.14)', borderColor: 'rgba(34,197,94,0.5)', color: '#22c55e',
}
const rejectBtn = {
  background: 'rgba(239,68,68,0.10)', borderColor: 'rgba(239,68,68,0.4)', color: 'var(--red)',
}
function navBtn(side) {
  return {
    position: 'fixed',
    [side]: 12,
    top: '50%', transform: 'translateY(-50%)',
    width: 48, height: 48, borderRadius: '50%',
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
    color: '#fff', cursor: 'pointer', zIndex: 261,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  }
}
