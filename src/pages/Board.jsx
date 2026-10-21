// Video Production Board — a native Kanban that replaces the Notion approval
// flow. ONE unified board across every brand the user can access; each card is
// tagged with its client and you pick the client per card. Cards move
// Needs Editing -> Ready for Review -> Needs Revisions -> Approved -> Scheduled.
// Videos upload straight to our landing-media bucket (with a real progress bar);
// each card has a single chronological ACTIVITY thread that interleaves uploaded
// versions and comments, with per-item reply (feedback on a specific file or
// comment). Approving marks the card Approved; a separate owner/admin "Send to
// Schedule" spawns a content_scripts draft into the existing Schedule page.
// (Drag machinery cloned from src/pages/Pipeline.jsx.)
import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  closestCorners, useDroppable,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, verticalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Plus, X, Upload, Film, MessageSquare, Check, CalendarPlus, Trash2, Loader2, Download, Building2, Send, CornerUpLeft, Settings, DollarSign, ExternalLink, AlertCircle, Archive, Filter } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { toast, confirmDialog } from '../components/Toast.jsx'
import PayoutSendModal from '../components/PayoutSendModal.jsx'
import useIsMobile from '../hooks/useIsMobile.js'
import { supabase } from '../lib/supabase.js'
import { saveMedia } from '../lib/download.js'

// Per-browser "confirm before releasing payment" preference (shared with the
// Payouts page). Default on.
const payoutConfirmOn = () => { try { return localStorage.getItem('scalesolo.payoutConfirm') !== 'off' } catch { return true } }
const solscanTx = (sig) => `https://solscan.io/tx/${sig}`

// ── stages ───────────────────────────────────────────────────────────────
const STAGES = [
  { key: 'editing',         label: 'Needs Editing',    color: '#60a5fa' },
  { key: 'in_review',       label: 'Ready for Review', color: '#a78bfa' },
  { key: 'needs_revisions', label: 'Needs Revisions',  color: '#f59e0b' },
  { key: 'approved',        label: 'Approved',         color: '#2ecc71' },
  { key: 'scheduled',       label: 'Scheduled',        color: '#ef4444' },
]
const STAGE_KEYS = new Set(STAGES.map((s) => s.key))
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label]))
const STAGE_META = Object.fromEntries(STAGES.map((s) => [s.key, s]))
// Small colored pill for a card's current stage (matches the column color).
const catPill = (color) => ({ display: 'inline-flex', alignItems: 'center', fontSize: 10, fontWeight: 800, letterSpacing: 0.2, textTransform: 'uppercase', color, background: `${color}22`, borderRadius: 999, padding: '1px 8px' })
// Legacy 'raw' cards fold into the first column.
const foldStage = (s) => (STAGE_KEYS.has(s) ? s : 'editing')
// A card is payable once it's Approved or Scheduled (both mean the edit is
// done). Keyed off the stage, not approved_at, so cards that were sent
// straight to Schedule without a separate Approve click are still payable.
const isPayableStage = (card) => ['approved', 'scheduled'].includes(foldStage(card.stage))

// ── styles (cloned from Pipeline) ─────────────────────────────────────────
const board = {
  display: 'flex', gap: 14, alignItems: 'flex-start', overflowX: 'auto',
  paddingBottom: 24, minHeight: 'calc(100vh - 220px)', minWidth: 0,
}
const column = { flex: '0 0 270px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 190px)' }
const columnHead = { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--border)' }
const stagePill = (color) => ({ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 })
const stageName = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, flex: 1, color: 'var(--text)' }
const stageMeta = { fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-display)', fontWeight: 600 }
const colBody = { flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 80 }
const dropHint = { borderRadius: 10, border: '1px dashed var(--border)', padding: 16, textAlign: 'center', color: 'var(--muted)', fontSize: 12.5 }
const cardStyle = (isDragging) => ({ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '11px 12px', cursor: 'grab', opacity: isDragging ? 0.4 : 1, transition: 'border-color 0.12s ease, box-shadow 0.12s ease' })
const cardTitle = { fontSize: 13.5, fontWeight: 600, color: 'var(--text)', marginBottom: 6, lineHeight: 1.3 }
const cardRow = { display: 'flex', alignItems: 'center', gap: 12, fontSize: 11.5, color: 'var(--muted)', flexWrap: 'wrap' }
const brandPill = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, color: 'var(--text)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 999, padding: '1px 8px' }
const addBtn = { marginTop: 4, width: '100%', padding: '9px 12px', border: '1px dashed var(--border)', borderRadius: 10, background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 12.5, fontFamily: 'var(--font-display)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }

const rand6 = () => Math.random().toString(36).slice(2, 8)

const timeAgo = (at) => {
  const d = new Date(at)
  const s = (Date.now() - d.getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 604800) return `${Math.floor(s / 86400)}d`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Direct browser upload to landing-media via XHR (real progress). Path
// <profile_id>/board/<card_id>/... satisfies the storage RLS insert policy.
function uploadBoardVideo(file, profileId, cardId, token, onProgress) {
  return new Promise((resolve, reject) => {
    const ext = (file.name.split('.').pop() || 'mp4').toLowerCase()
    const path = `${profileId}/board/${cardId}/${Date.now()}-${rand6()}.${ext}`
    const base = import.meta.env.VITE_SUPABASE_URL
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${base}/storage/v1/object/landing-media/${path}`)
    xhr.setRequestHeader('apikey', import.meta.env.VITE_SUPABASE_ANON_KEY)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('x-upsert', 'true')
    if (file.type) xhr.setRequestHeader('Content-Type', file.type)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total) }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(`${base}/storage/v1/object/public/landing-media/${path}`)
      } else {
        let msg = `Upload failed (${xhr.status})`
        try { const j = JSON.parse(xhr.responseText); msg = j.message || j.error || msg } catch { /* keep default */ }
        reject(new Error(msg))
      }
    }
    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.send(file)
  })
}

// ── avatar ────────────────────────────────────────────────────────────────
function Avatar({ name, url, size = 26 }) {
  const initials = (name || '?').trim().slice(0, 1).toUpperCase()
  if (url) return <img src={url} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
  return <div style={{ width: size, height: size, borderRadius: '50%', background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'grid', placeItems: 'center', fontSize: size * 0.42, fontWeight: 700, color: 'var(--muted)', flexShrink: 0 }}>{initials}</div>
}

// ── card body (also used by DragOverlay) ──────────────────────────────────
function CardBody({ card }) {
  const versions = card.versions || []
  const comments = card.comments?.[0]?.count ?? 0
  const brandName = card.brand?.business_name
  const st = STAGE_META[foldStage(card.stage)]
  return (
    <>
      <div style={cardTitle}>{card.title || 'Untitled'}</div>
      <div style={cardRow}>
        {st && <span style={catPill(st.color)}>{st.label}</span>}
        {brandName && <span style={brandPill}><Building2 size={10} /> {brandName}</span>}
        <span><Film size={11} style={{ verticalAlign: '-1px' }} /> {versions.length ? `v${versions.length}` : 'no video'}</span>
        {comments > 0 && <span><MessageSquare size={11} style={{ verticalAlign: '-1px' }} /> {comments}</span>}
        {card.content_script_id && <span style={{ color: 'var(--red)' }}>· draft</span>}
        {!card.content_script_id && foldStage(card.stage) === 'scheduled' && (
          <span style={catPill('#ef4444')} title="In Scheduled, but no post was ever created, so nothing will publish">no post</span>
        )}
        {card.post?.status === 'failed' && (
          <span style={catPill('#ef4444')} title={card.post?.last_error || 'This post failed to publish'}>FAILED TO POST</span>
        )}
        {card.post?.status === 'posted' && <span style={catPill('#22c55e')}>published</span>}
        {card.archived_at && <span style={catPill('#64748b')}>archived</span>}
        {/* Handoff signal: the assigned editor has picked this card up. */}
        {card.editing_started_at && ['editing', 'needs_revisions'].includes(foldStage(card.stage)) && (
          <span style={catPill('#60a5fa')} title={`Editing started ${new Date(card.editing_started_at).toLocaleString()}`}>
            In progress · {timeAgo(card.editing_started_at)}
          </span>
        )}
        {(card.assigned_editor_name || card.assigned_editor_email) && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title={`Assigned to ${card.assigned_editor_name || card.assigned_editor_email}`}>
            <Avatar name={card.assigned_editor_name || card.assigned_editor_email} size={16} /> {card.assigned_editor_name || card.assigned_editor_email.split('@')[0]}
          </span>
        )}
        {/* Payment status. "Paid" sticks to the card for good once a payout
            covers it, including while it is back in an edit round, so a second
            round never looks unpaid. "Unpaid" stays gated to the done stages. */}
        {card.payout_id
          ? <span style={catPill('#2ecc71')} title={card.payout?.created_at ? `Paid ${new Date(card.payout.created_at).toLocaleString()}` : 'Paid'}>
              Paid{card.payout?.amount_usdt ? ` $${Number(card.payout.amount_usdt).toFixed(2)}` : ''}
            </span>
          : isPayableStage(card) ? <span style={catPill('#f59e0b')}>Unpaid</span> : null}
        {card.payout?.tx_signature && (
          <a href={solscanTx(card.payout.tx_signature)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--red)', fontSize: 10.5 }}>tx <ExternalLink size={9} /></a>
        )}
      </div>
    </>
  )
}

// ── sortable card ─────────────────────────────────────────────────────────
function SortableCard({ card, onClick, onPay, isManager }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id, data: { type: 'card', card } })
  const style = isDragging ? { opacity: 0, pointerEvents: 'none' } : { transform: CSS.Transform.toString(transform), transition }
  const canPay = isManager && isPayableStage(card) && !card.payout_id && card.assigned_editor_email
  return (
    <div ref={setNodeRef} style={{ ...cardStyle(false), ...style }} {...attributes} {...listeners}
      onClick={() => { if (!isDragging && onClick) onClick(card) }}>
      <CardBody card={card} />
      {canPay && (
        <button className="btn-secondary" onClick={(e) => { e.stopPropagation(); onPay?.(card) }}
          style={{ marginTop: 8, fontSize: 11.5, padding: '3px 10px', width: '100%', justifyContent: 'center' }}>
          <DollarSign size={12} /> Pay editor
        </button>
      )}
    </div>
  )
}

// ── droppable column ──────────────────────────────────────────────────────
function StageColumn({ stage, cards, onAdd, onCardClick, onPay, isManager }) {
  const { setNodeRef, isOver } = useDroppable({ id: `stage:${stage.key}`, data: { type: 'stage', stage: stage.key } })
  return (
    <div style={column}>
      <div style={columnHead}>
        <div style={stagePill(stage.color)} />
        <div style={stageName}>{stage.label}</div>
        <div style={stageMeta}>{cards.length}</div>
      </div>
      <div ref={setNodeRef} style={{ ...colBody, background: isOver ? 'rgba(239,68,68,0.05)' : 'transparent', transition: 'background 0.12s ease' }}>
        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {cards.length === 0
            ? <div style={dropHint}>Drop a card here</div>
            : cards.map((c) => <SortableCard key={c.id} card={c} onClick={onCardClick} onPay={onPay} isManager={isManager} />)}
        </SortableContext>
        <button style={addBtn} onClick={() => onAdd(stage.key)}><Plus size={13} /> Add card</button>
      </div>
    </div>
  )
}

// ── brand picker ──────────────────────────────────────────────────────────
function BrandSelect({ profiles, value, onChange, disabled }) {
  return (
    <select className="input" value={value || ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 260 }}>
      <option value="" disabled>Choose client…</option>
      {profiles.map((p) => <option key={p.id} value={p.id}>{p.business_name || 'Untitled brand'}</option>)}
    </select>
  )
}

// ── new-card modal ────────────────────────────────────────────────────────
function NewCardModal({ stage, profiles, defaultBrandId, token, onClose, onCreated }) {
  const [title, setTitle] = useState('')
  const [brandId, setBrandId] = useState(defaultBrandId || profiles[0]?.id || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const create = async () => {
    if (!title.trim() || !brandId) return
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/board', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile_id: brandId, title: title.trim(), stage }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Failed')
      const brand = profiles.find((p) => p.id === brandId)
      onCreated({ ...body.card, brand: brand ? { id: brand.id, business_name: brand.business_name } : null })
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-sm" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 18 }}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, flex: 1 }}>New card</h3>
          <button aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6 }}><X size={18} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label className="label">Client</label>
            <BrandSelect profiles={profiles} value={brandId} onChange={setBrandId} />
          </div>
          <div>
            <label className="label">Title</label>
            <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') create() }} placeholder="e.g. Chicken shawarma B-roll" />
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Column: <strong style={{ color: 'var(--text)' }}>{STAGE_LABEL[stage] || 'Needs Editing'}</strong>. You'll upload the video inside the card.</div>
          {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 12px', borderRadius: 10, fontSize: 13 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={create} disabled={busy || !title.trim() || !brandId}>
              {busy ? <span className="spinner" /> : <Plus size={14} />} Create card
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── card detail drawer ────────────────────────────────────────────────────
function CardDrawer({ card, profiles, token, role, onClose, onChanged, onPay }) {
  const isManager = ['owner', 'admin'].includes(role)
  const canWork = role !== 'viewer'
  const [versions, setVersions] = useState(card.versions || [])
  const [comments, setComments] = useState([])
  const [commentText, setCommentText] = useState('')
  const [replyTo, setReplyTo] = useState(null) // { kind:'version'|'comment', id, label }
  const [uploading, setUploading] = useState(false)
  const [uploadPct, setUploadPct] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [brandEditors, setBrandEditors] = useState([])
  // Per-card pay rate. Empty string means "use the editor's usual rate", which
  // is stored as null; 0 is a real rate and must survive the round trip.
  const [rateDraft, setRateDraft] = useState(
    card.pay_rate === null || card.pay_rate === undefined ? '' : String(card.pay_rate)
  )
  const fileRef = useRef(null)
  const commentRef = useRef(null)

  useEffect(() => {
    fetch(`/api/board/comments?card_id=${card.id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json()).then((b) => setComments(b.comments || [])).catch(() => {})
    fetch(`/api/board/versions?card_id=${card.id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json()).then((b) => { if (Array.isArray(b.versions)) setVersions(b.versions) }).catch(() => {})
  }, [card.id, token])

  // Editors for this card's brand (managers only) → the assignee picker.
  useEffect(() => {
    if (!isManager) return
    fetch(`/api/board/invites?action=brand_editors&profile_id=${card.profile_id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json()).then((b) => setBrandEditors(b.editors || [])).catch(() => {})
  }, [card.profile_id, isManager, token])

  // Handoff signal: the first time the assigned editor opens a card that still
  // needs editing (or picks up a fresh revision round), stamp editing_started_at
  // so the owner sees "In progress" on the board. Best-effort: it never blocks
  // the drawer and silently no-ops until the column exists. The server pins the
  // stamp equal to updated_at, so a card only re-stamps when a revision request
  // has bumped updated_at past it (not after our own stamp).
  useEffect(() => {
    if (role !== 'contributor') return
    const st = foldStage(card.stage)
    if (st !== 'editing' && st !== 'needs_revisions') return
    const started = card.editing_started_at
    const freshRound = st === 'needs_revisions' && started && card.updated_at && card.updated_at > started
    if (started && !freshRound) return
    fetch(`/api/board?id=${card.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ editing_started_at: new Date().toISOString() }),
    }).then((r) => { if (r.ok) onChanged() }).catch(() => {})
  }, [role, card.id, card.stage, card.updated_at, card.editing_started_at, token, onChanged])

  const versionNo = useCallback((vid) => versions.find((v) => v.id === vid)?.version_no, [versions])

  // Unified chronological activity: versions + comments, newest first (top).
  const activity = useMemo(() => {
    const items = [
      ...versions.map((v) => ({ type: 'version', key: `v${v.id}`, at: v.created_at, data: v })),
      ...comments.map((c) => ({ type: 'comment', key: `c${c.id}`, at: c.created_at, data: c })),
    ]
    items.sort((a, b) => new Date(b.at) - new Date(a.at))
    return items
  }, [versions, comments])

  // Approval always uses the most recent upload (highest version_no).
  const latestVersionId = useMemo(() => {
    if (!versions.length) return null
    return versions.reduce((a, b) => ((a.version_no || 0) >= (b.version_no || 0) ? a : b)).id
  }, [versions])

  // Saved on blur rather than per keystroke: this is money, and a half-typed
  // "1" from "13.33" should never reach the payout ledger.
  const saveRate = async () => {
    const raw = rateDraft.trim()
    const next = raw === '' ? null : Number(raw)
    if (next !== null && (!Number.isFinite(next) || next < 0)) {
      setErr('Enter a rate like 13.33, or clear it to use the editor rate.')
      setRateDraft(card.pay_rate === null || card.pay_rate === undefined ? '' : String(card.pay_rate))
      return
    }
    const current = card.pay_rate === null || card.pay_rate === undefined ? null : Number(card.pay_rate)
    if (next === current) return
    setBusy(true); setErr(null)
    try {
      await patchCard({ pay_rate: next })
      onChanged()
      toast({ message: next === null ? 'Back to the editor rate for this card.' : `This card now pays $${next.toFixed(2)}.`, kind: 'success' })
    } catch (e) {
      setErr(e.message)
      setRateDraft(current === null ? '' : String(current))
    } finally { setBusy(false) }
  }

  const patchCard = async (updates) => {
    const r = await fetch(`/api/board?id=${card.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(updates),
    })
    const b = await r.json()
    if (!r.ok) throw new Error(b.error || 'Update failed')
    return b.card
  }

  const onPickFile = async (e) => {
    const file = e.target.files?.[0]
    if (file) e.target.value = ''
    if (!file) return
    setUploading(true); setUploadPct(0); setErr(null)
    try {
      const url = await uploadBoardVideo(file, card.profile_id, card.id, token, setUploadPct)
      const kind = versions.length === 0 ? 'raw' : 'edit'
      const r = await fetch('/api/board/versions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ card_id: card.id, video_url: url, kind }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || 'Upload failed')
      if (b.version) setVersions((prev) => [b.version, ...prev])
      toast({ message: `Version v${b.version?.version_no} uploaded`, kind: 'success' })
      onChanged()
    } catch (e) { setErr(e.message); toast({ message: e.message, kind: 'error' }) }
    finally { setUploading(false); setUploadPct(0) }
  }

  // Changing the client also moves the card's post on the Schedule page (same
  // scheduled time + caption). The server reports what happened to that post
  // so the toast can say so, or flag that it needs re-scheduling.
  const changeBrand = async (newId) => {
    if (!newId || newId === card.profile_id) return
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`/api/board?id=${card.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile_id: newId }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || 'Update failed')
      const pm = b.post_move
      if (!pm) toast({ message: 'Client updated', kind: 'success' })
      else if (pm.ok && pm.resubmitted) toast({ message: 'Client updated. Its scheduled post moved too, same time and caption.', kind: 'success' })
      else if (pm.ok && pm.resubmit_error) toast({ message: `Client updated and the post moved, but it needs re-scheduling: ${pm.resubmit_error}`, kind: 'error' })
      else if (pm.ok) toast({ message: 'Client updated. Its post on the Schedule page moved too.', kind: 'success' })
      else toast({ message: `Client updated, but its post could not be moved: ${pm.error}`, kind: 'error' })
      onChanged()
    }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  // Keyed by email so a not-yet-accepted invite (no user_id yet) can still be
  // assigned. assigned_editor (user_id) is filled now if the editor has claimed,
  // otherwise it stays null and gets backfilled when they first sign in.
  const assignEditor = async (email) => {
    const ed = brandEditors.find((e) => e.email === email)
    setBusy(true); setErr(null)
    try { await patchCard({ assigned_editor: ed?.user_id || null, assigned_editor_email: email || null, assigned_editor_name: ed?.name || null }); onChanged() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  // Send the card back for another edit round, on the SAME card. A paid card is
  // allowed back and is never charged again (payout_id stays set, and every
  // payment path skips cards that already have one). If its post was already on
  // the schedule the server pulls that post back, so the current cut cannot
  // publish while the new one is being edited; the toast reports what happened.
  const requestRevisions = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`/api/board?id=${card.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stage: 'needs_revisions' }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || 'Update failed')
      const h = b.post_hold
      const base = card.payout_id ? 'Sent back for another edit. Already paid, so no second payment.' : 'Sent back for revisions'
      if (!h || h.noop) toast({ message: base, kind: 'success' })
      else if (h.ok && h.cancelled) toast({ message: `${base} Its scheduled post was pulled off the schedule, so the current cut will not go out.`, kind: 'success' })
      else if (h.ok) toast({ message: `${base} Its post on the Schedule page is on hold.`, kind: 'success' })
      else if (h.code === 'already_posted') toast({ message: `${base} Heads up: its post already published, so that cut is live.`, kind: 'error' })
      else toast({ message: `${base} But its scheduled post could not be pulled back: ${h.error}`, kind: 'error' })
      onChanged(); onClose()
    } catch (e) { setErr(e.message); setBusy(false) }
  }

  const submitForReview = async () => {
    if (!latestVersionId) { toast({ message: 'Upload a video before submitting.', kind: 'warn' }); return }
    setBusy(true); setErr(null)
    try {
      // Record the version being submitted so we can block a re-submit until a
      // newer version is uploaded.
      await patchCard({ stage: 'in_review', submitted_version_id: latestVersionId })
      toast({ message: 'Submitted for review', kind: 'success' }); onChanged(); onClose()
    } catch (e) { setErr(e.message); setBusy(false) }
  }

  // Send this card to the Schedule page (spawn the content_scripts draft) and
  // kick off caption generation. Shared by Approve (one click) and the manual
  // "Send to Schedule" button. Resolves once the draft exists; caption
  // generation keeps running in the background with its own follow-up toast.
  const runSendToSchedule = async () => {
    const r = await fetch(`/api/board?id=${card.id}&action=send-to-schedule`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    const b = await r.json()
    if (!r.ok) throw new Error(b.error || 'Failed')
    if (b.already) {
      toast({ message: 'Already on the Schedule page.', kind: 'success' })
      return
    }
    toast({ message: 'Sent to Schedule. Writing title, caption, hashtags + first comment...', kind: 'success' })
    // Auto-generate title + caption + hashtags + first comment for the new
    // draft (same frame-first generator the Schedule page uses). Runs in the
    // background so the board stays responsive; a follow-up toast reports it.
    if (b.content_id) {
      fetch('/api/content/bulk-actions?action=generate-captions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile_id: card.profile_id, script_ids: [b.content_id] }),
      })
        .then((res) => res.json().then((cb) => ({ ok: res.ok, cb })))
        .then(({ ok, cb }) => {
          if (!ok) { toast({ message: `Caption did not generate: ${cb.error || 'error'}. Open the Schedule page to generate it.`, kind: 'error' }); return }
          if (cb.updated) toast({ message: 'Title, caption + hashtags ready on the Schedule page.', kind: 'success' })
          else toast({ message: 'Draft is on the Schedule page. Its caption needs a manual generate there.', kind: 'error' })
        })
        .catch(() => toast({ message: 'Caption generation did not finish. Generate it on the Schedule page.', kind: 'error' }))
    }
  }

  // One click: approve AND send to the scheduler. These used to be two separate
  // buttons (Approve, then Send to Schedule), so every card had to be approved
  // twice. The approval is reflected immediately; if the send fails afterward
  // the card stays approved and the manual Send to Schedule button is still
  // there to retry, so nothing is lost.
  const approve = async () => {
    if (!latestVersionId) { toast({ message: 'Upload a video before approving.', kind: 'warn' }); return }
    setBusy(true); setErr(null)
    try {
      await patchCard({ stage: 'approved', final_version_id: latestVersionId })
      onChanged()
      toast({ message: 'Approved, using the latest upload', kind: 'success' })
      if (!card.content_script_id) await runSendToSchedule()
      onChanged(); onClose()
    } catch (e) { setErr(e.message); toast({ message: e.message, kind: 'error' }); setBusy(false) }
  }

  const sendToSchedule = async () => {
    setBusy(true); setErr(null)
    try {
      await runSendToSchedule()
      onChanged(); onClose()
    } catch (e) { setErr(e.message); toast({ message: e.message, kind: 'error' }); setBusy(false) }
  }

  const startReply = (kind, id, label) => { setReplyTo({ kind, id, label }); commentRef.current?.focus() }

  const postComment = async () => {
    const body = commentText.trim()
    if (!body) return
    setCommentText('')
    const payload = { card_id: card.id, body }
    if (replyTo?.kind === 'version') payload.target_version_id = replyTo.id
    if (replyTo?.kind === 'comment') payload.parent_comment_id = replyTo.id
    setReplyTo(null)
    try {
      const r = await fetch('/api/board/comments', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || 'Failed')
      setComments((prev) => [...prev, b.comment]); onChanged()
    } catch (e) { setErr(e.message) }
  }

  const removeCard = async () => {
    const ok = await confirmDialog({ title: 'Delete this card?', message: 'The card, its versions and comments are removed. The uploaded video files stay in storage.', confirmText: 'Delete', destructive: true })
    if (!ok) return
    try {
      const r = await fetch(`/api/board?id=${card.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok && r.status !== 204) throw new Error('Delete failed')
      toast({ message: 'Card deleted', kind: 'success' }); onChanged(); onClose()
    } catch (e) { toast({ message: e.message, kind: 'error' }) }
  }

  const stage = foldStage(card.stage)
  // Block "Submit for review" until a version newer than the last-submitted one
  // is uploaded (nothing new = no point re-reviewing the same cut).
  const nothingNewToReview = !latestVersionId || latestVersionId === card.submitted_version_id
  const replyBtn = (onClick) => (
    <button onClick={onClick} title="Reply" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>
      <CornerUpLeft size={12} /> Reply
    </button>
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <input className="input" defaultValue={card.title}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== card.title) patchCard({ title: v }).then(onChanged).catch(() => {}) }}
              style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, border: 'none', padding: 0, background: 'transparent' }} />
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{STAGE_LABEL[stage]}</div>
          </div>
          <button aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6 }}><X size={18} /></button>
        </div>

        {/* Client + editor assignment */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>Client</span>
          <BrandSelect profiles={profiles} value={card.profile_id} onChange={changeBrand} disabled={busy || !isManager} />
        </div>
        {isManager && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Editor</span>
            <select className="input" value={card.assigned_editor_email || ''} disabled={busy} onChange={(e) => assignEditor(e.target.value)} style={{ maxWidth: 260 }}>
              <option value="">Unassigned</option>
              {brandEditors.filter((ed) => ed.email).map((ed) => (
                <option key={ed.email} value={ed.email}>{(ed.name || ed.email)}{ed.pending ? ' (invite pending)' : ''}</option>
              ))}
            </select>
          </div>
        )}
        {isManager && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Pay rate</span>
            <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <span style={{ position: 'absolute', left: 10, fontSize: 12.5, color: 'var(--muted)', pointerEvents: 'none' }}>$</span>
              <input
                className="input" type="number" min="0" step="0.01" inputMode="decimal"
                value={rateDraft}
                onChange={(e) => setRateDraft(e.target.value)}
                onBlur={saveRate}
                placeholder="editor default"
                disabled={busy || !!card.payout_id}
                title={card.payout_id ? 'Already paid, so the rate is locked to what was actually paid.' : ''}
                style={{ width: 140, fontSize: 12.5, paddingLeft: 20 }}
              />
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {card.payout_id
                ? 'Locked: already paid.'
                : rateDraft === '' ? "Blank uses the editor's usual rate." : 'This card only.'}
            </span>
          </div>
        )}

        {err && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginTop: 8 }}>{err}</div>}

        {/* Upload */}
        <div style={{ marginTop: 16 }}>
          <input ref={fileRef} type="file" accept="video/*" onChange={onPickFile} style={{ display: 'none' }} />
          <button className="btn-secondary" onClick={() => fileRef.current?.click()} disabled={uploading || !canWork} style={{ width: '100%', justifyContent: 'center' }}>
            {uploading ? <><Loader2 size={14} className="spin" /> Uploading… {Math.round(uploadPct * 100)}%</> : <><Upload size={14} /> {versions.length ? 'Upload new version' : 'Upload the video'}</>}
          </button>
          {uploading && (
            <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden', marginTop: 8 }}>
              <div style={{ height: '100%', width: `${Math.round(uploadPct * 100)}%`, background: 'var(--red)', transition: 'width 0.15s ease' }} />
            </div>
          )}
        </div>

        {/* Activity (versions + comments interleaved, oldest first) */}
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: 'var(--text)', margin: '18px 0 10px' }}>Activity</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {activity.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Nothing yet. Upload the video or leave a note below.</div>}
          {activity.map((item) => {
            const d = item.data
            const isVersion = item.type === 'version'
            const refLabel = !isVersion && (d.target_version_id ? `on v${versionNo(d.target_version_id) ?? '?'}` : (d.parent_comment_id ? 'reply' : null))
            return (
              <div key={item.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <Avatar name={d.author_name} url={d.author_avatar} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 12.5 }}>{d.author_name || (isVersion ? 'Upload' : 'Comment')}</strong>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>{timeAgo(item.at)}</span>
                    {isVersion && <span style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'capitalize' }}>· {d.kind} v{d.version_no}</span>}
                    {isVersion && d.id === latestVersionId && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 999, padding: '0 6px', textTransform: 'uppercase', letterSpacing: 0.3 }}>latest</span>}
                    {refLabel && <span style={{ fontSize: 10.5, color: 'var(--muted)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 999, padding: '0 7px' }}>{refLabel}</span>}
                  </div>
                  {isVersion ? (
                    <div style={{ marginTop: 6 }}>
                      <video src={`${d.video_url}#t=0.1`} controls preload="metadata" style={{ width: '100%', maxHeight: 240, borderRadius: 8, background: '#000' }} />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
                        <button type="button" onClick={() => saveMedia(d.video_url, `v${d.version_no || 1}.mp4`)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex' }} title="Download"><Download size={14} /></button>
                        {canWork && replyBtn(() => startReply('version', d.id, `v${d.version_no}`))}
                      </div>
                    </div>
                  ) : (
                    <div style={{ marginTop: 3 }}>
                      <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{d.body}</div>
                      {canWork && <div style={{ marginTop: 3 }}>{replyBtn(() => startReply('comment', d.id, d.author_name || 'comment'))}</div>}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Composer */}
        {canWork && (
          <div style={{ marginTop: 14 }}>
            {replyTo && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--muted)', marginBottom: 6 }}>
                <CornerUpLeft size={12} /> Replying to {replyTo.label}
                <button onClick={() => setReplyTo(null)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={12} /></button>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <input ref={commentRef} className="input" value={commentText} onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') postComment() }} placeholder={replyTo ? 'Write your reply…' : 'Add a comment…'} style={{ flex: 1 }} />
              <button className="btn-secondary" onClick={postComment} disabled={!commentText.trim()}><Send size={14} /></button>
            </div>
          </div>
        )}

        {/* Actions */}
        {card.post?.status === 'failed' && (
          <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 10, background: 'rgba(239,68,68,0.12)', border: '1px solid var(--red)', fontSize: 12.5 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 700, color: 'var(--red)', marginBottom: 6 }}>
              <AlertCircle size={15} style={{ flexShrink: 0 }} /> This post failed to publish
            </div>
            <div style={{ color: 'var(--text)' }}>{card.post.last_error || 'No error detail was recorded.'}</div>
            {card.post.last_error_at && (
              <div style={{ color: 'var(--muted)', marginTop: 4 }}>Failed {new Date(card.post.last_error_at).toLocaleString()}</div>
            )}
            <div style={{ color: 'var(--muted)', marginTop: 6 }}>
              Nothing went out, and it will not retry on its own. Fix the cause on the Schedule page, then reschedule it there.
            </div>
          </div>
        )}

        {card.post?.status === 'posted' && !card.archived_at && (
          <div style={{ marginTop: 16, padding: '10px 12px', borderRadius: 10, background: 'rgba(34,197,94,0.10)', border: '1px solid rgba(34,197,94,0.5)', fontSize: 12.5 }}>
            Published. {card.payout_id || !(card.assigned_editor || card.assigned_editor_email)
              ? 'It archives automatically on the next board refresh.'
              : 'It stays on the board until the editor is paid, so the payment is not forgotten.'}
          </div>
        )}

        {stage === 'scheduled' && !card.content_script_id && (
          <div style={{ marginTop: 16, padding: '10px 12px', borderRadius: 10, background: 'rgba(239,68,68,0.10)', border: '1px solid var(--red)', fontSize: 12.5, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1, color: 'var(--red)' }} />
            <span>
              This card is in Scheduled but never became a post, so nothing will publish from it.
              {isManager ? ' Use the button below to create the post, then set its time on the Schedule page.' : ' Ask a manager to create the post for it.'}
            </span>
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 20, alignItems: 'center' }}>
          {canWork && ['editing', 'needs_revisions'].includes(stage) && (
            <button className="btn-primary" onClick={submitForReview} disabled={busy || uploading || nothingNewToReview}
              title={nothingNewToReview ? 'Upload a new version before submitting for review' : ''}>
              <Send size={14} /> Submit for review
            </button>
          )}
          {isManager && !['approved', 'scheduled'].includes(stage) && (
            <button className="btn-primary" onClick={approve} disabled={busy || uploading || !versions.length}><Check size={14} /> Approve</button>
          )}
          {isManager && stage !== 'needs_revisions' && (
            <button className="btn-secondary" onClick={requestRevisions} disabled={busy}
              title={card.payout_id ? 'Send it back for another edit on this same card. It is already paid, so this will not create a second payment.' : 'Send it back for another edit on this same card.'}>
              {card.payout_id ? 'Request another edit' : 'Request revisions'}
            </button>
          )}
          {isManager && ['approved', 'scheduled'].includes(stage) && !card.content_script_id && (
            <button className="btn-primary" onClick={sendToSchedule} disabled={busy || !versions.length}
              title={versions.length ? '' : 'Upload the final video first'}>
              <CalendarPlus size={14} /> {stage === 'scheduled' ? 'Create the missing post' : 'Send to Schedule'}
            </button>
          )}
          {card.content_script_id && <span style={{ fontSize: 12.5, color: 'var(--red)', fontWeight: 600 }}>On the Schedule page →</span>}
          {isManager && card.archived_at && (
            <button className="btn-secondary" disabled={busy} onClick={async () => {
              setBusy(true); setErr(null)
              try { await patchCard({ archived_at: null }); onChanged(); onClose(); toast({ message: 'Back on the board.', kind: 'success' }) }
              catch (e) { setErr(e.message); toast({ message: e.message, kind: 'error' }); setBusy(false) }
            }}><CornerUpLeft size={14} /> Restore to board</button>
          )}

          <span style={{ flex: 1 }} />
          {isManager && <button onClick={removeCard} title="Delete card" style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6 }}><Trash2 size={16} /></button>}
        </div>

        {/* Payment record — the assigned editor and managers both see when it
            was paid and the crypto transaction. Managers can release it here. */}
        {isPayableStage(card) && (
          <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <DollarSign size={14} style={{ color: card.payout_id ? 'var(--green)' : 'var(--amber)', flexShrink: 0 }} />
            {card.payout_id ? (
              <div style={{ fontSize: 12.5 }}>
                <strong>Paid{card.payout?.amount_usdt ? ` $${Number(card.payout.amount_usdt).toFixed(2)} USDT` : ''}</strong>
                {card.payout?.created_at && <span style={{ color: 'var(--muted)' }}> · {new Date(card.payout.created_at).toLocaleString()}</span>}
                {card.payout?.tx_signature && <> · <a href={solscanTx(card.payout.tx_signature)} target="_blank" rel="noreferrer" style={{ color: 'var(--red)' }}>view transaction</a></>}
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1 }}>Not paid yet.</div>
            )}
            <span style={{ flex: 1 }} />
            {isManager && !card.payout_id && card.assigned_editor_email && (
              <button className="btn-primary" onClick={() => onPay?.(card)} disabled={busy} style={{ fontSize: 12 }}><DollarSign size={13} /> Pay editor</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── editors manager ───────────────────────────────────────────────────────
function EditorsModal({ token, onClose }) {
  const [data, setData] = useState({ editors: [], brands: [] })
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [pick, setPick] = useState([]) // profile_ids to grant on invite (default: all)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [editingName, setEditingName] = useState(null) // email being renamed
  const [nameDraft, setNameDraft] = useState('')

  const load = useCallback(() => {
    fetch('/api/board/invites', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((b) => {
        if (b.error) throw new Error(b.error)
        setData({ editors: b.editors || [], brands: b.brands || [] })
        setPick((prev) => (prev.length ? prev : (b.brands || []).map((x) => x.id)))
      })
      .catch((e) => setErr(e.message)).finally(() => setLoading(false))
  }, [token])
  useEffect(() => { setLoading(true); load() }, [load])

  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then(async (r) => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || 'Failed'); return b })

  const invite = async () => {
    const em = email.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { setErr('Enter a valid email.'); return }
    if (!pick.length) { setErr('Pick at least one brand to grant.'); return }
    setBusy(true); setErr(null)
    try {
      await post('/api/board/invites', { email: em, name: name.trim() || null, profile_ids: pick })
      toast({ message: `Magic link sent to ${em}`, kind: 'success' })
      setName(''); setEmail(''); load()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const toggleBrand = async (ed, brandId, on) => {
    try { await post(`/api/board/invites?action=${on ? 'grant' : 'revoke'}`, { email: ed, profile_id: brandId }); load() }
    catch (e) { toast({ message: e.message, kind: 'error' }) }
  }
  const resend = async (ed) => { try { await post('/api/board/invites?action=resend', { email: ed }); toast({ message: 'Magic link resent', kind: 'success' }) } catch (e) { toast({ message: e.message, kind: 'error' }) } }
  const saveName = async (em) => {
    setBusy(true); setErr(null)
    try { await post('/api/board/invites?action=set-name', { email: em, name: nameDraft.trim() || null }); setEditingName(null); toast({ message: 'Name saved', kind: 'success' }); load() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const remove = async (ed) => {
    if (!(await confirmDialog({ title: `Remove ${ed}?`, message: 'They lose access to all your boards. You can re-invite them later.', confirmText: 'Remove', destructive: true }))) return
    try { await fetch(`/api/board/invites?email=${encodeURIComponent(ed)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }); load() }
    catch (e) { toast({ message: e.message, kind: 'error' }) }
  }

  const chip = (on, label, onClick, title) => (
    <button onClick={onClick} title={title} style={{ fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '3px 10px', cursor: 'pointer', border: `1px solid ${on ? '#2ecc71' : 'var(--border)'}`, background: on ? '#2ecc7122' : 'transparent', color: on ? '#2ecc71' : 'var(--muted)' }}>{label}</button>
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640, width: '100%', maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, flex: 1 }}>Editors</h3>
          <button aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6 }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>Invite an editor by email. They get a magic link to log in (no password) and only see the board with the videos assigned to them, for the brands you turn on.</div>

        {err && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 10 }}>{err}</div>}

        {/* Invite */}
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Editor name" style={{ flex: 1 }} />
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') invite() }} placeholder="editor@email.com" style={{ flex: 1.4 }} />
            <button className="btn-primary" onClick={invite} disabled={busy || !email.trim() || !pick.length}>{busy ? <span className="spinner" /> : 'Invite'}</button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', margin: '10px 0 6px' }}>Access to these brands (toggle off any they shouldn't see):</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {data.brands.map((b) => chip(pick.includes(b.id), b.business_name || 'Brand', () => setPick((p) => p.includes(b.id) ? p.filter((x) => x !== b.id) : [...p, b.id])))}
          </div>
        </div>

        {/* Existing editors */}
        {loading ? <div style={{ textAlign: 'center', padding: 20 }}><span className="spinner" /></div> : (
          data.editors.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No editors yet.</div> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {data.editors.map((ed) => (
                <div key={ed.email} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                    {editingName === ed.email ? (
                      <>
                        <input className="input" autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveName(ed.email); if (e.key === 'Escape') setEditingName(null) }}
                          placeholder="Editor name" style={{ fontSize: 13, padding: '4px 8px', maxWidth: 200 }} />
                        <button className="btn-primary" onClick={() => saveName(ed.email)} disabled={busy} style={{ fontSize: 11, padding: '3px 10px' }}>Save</button>
                        <button onClick={() => setEditingName(null)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 11.5 }}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <strong style={{ fontSize: 13 }}>{ed.name || ed.email}</strong>
                        {ed.name && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{ed.email}</span>}
                        <button onClick={() => { setEditingName(ed.email); setNameDraft(ed.name || '') }} style={{ background: 'transparent', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 11.5, fontWeight: 600 }}>{ed.name ? 'Rename' : 'Add name'}</button>
                        {Object.values(ed.brands).some((s) => s === 'pending') && <span style={{ fontSize: 10.5, color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 999, padding: '0 7px' }}>pending</span>}
                      </>
                    )}
                    <span style={{ flex: 1 }} />
                    <button onClick={() => resend(ed.email)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 11.5, fontWeight: 600 }}>Resend link</button>
                    <button onClick={() => remove(ed.email)} title="Remove editor" style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><Trash2 size={14} /></button>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {data.brands.map((b) => { const on = !!ed.brands[b.id]; return <span key={b.id}>{chip(on, b.business_name || 'Brand', () => toggleBrand(ed.email, b.id, !on), on ? 'Turn off' : 'Turn on')}</span> })}
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}

// ── first-login "create a password" prompt (magic-link editors) ───────────
function SetPasswordPrompt({ onDone }) {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const save = async () => {
    if (pw.length < 8) { setErr('Use at least 8 characters.'); return }
    setBusy(true); setErr(null)
    try {
      const { error } = await supabase.auth.updateUser({ password: pw, data: { password_set: true } })
      if (error) throw error
      toast({ message: 'Password set. You can log in with it next time.', kind: 'success' })
      onDone(true)
    } catch (e) { setErr(e.message); setBusy(false) }
  }
  return (
    <div className="modal-overlay">
      <div className="modal-card modal-card-sm" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, marginBottom: 8 }}>Create a password</h3>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>Set a password so you can log in anytime, without waiting for the emailed link.</p>
        <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save() }} placeholder="At least 8 characters" autoComplete="new-password" />
        {err && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginTop: 10 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn-secondary" onClick={() => onDone(false)}>Maybe later</button>
          <button className="btn-primary" onClick={save} disabled={busy || pw.length < 8}>{busy ? <span className="spinner" /> : 'Set password'}</button>
        </div>
      </div>
    </div>
  )
}

// ── main page ─────────────────────────────────────────────────────────────
export default function Board() {
  const { session } = useAuth()
  const { selectedProfileId, selectedProfile, profiles } = useProfile()
  const token = session?.access_token
  const role = selectedProfile?._role || 'viewer'
  const [cards, setCards] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeDragId, setActiveDragId] = useState(null)
  const [newCardStage, setNewCardStage] = useState(null)
  const [openCardId, setOpenCardId] = useState(null)
  const [showEditors, setShowEditors] = useState(false)
  const [pwPrompt, setPwPrompt] = useState(false)
  const [payCard, setPayCard] = useState(null)
  // The archive is a separate fetch, not a client-side filter: finished cards
  // are the ones that pile up, so the board should never load them at all.
  const [showArchive, setShowArchive] = useState(false)
  const [unpaidOnly, setUnpaidOnly] = useState(false)
  const [fBrand, setFBrand] = useState('')
  const [fEditor, setFEditor] = useState('')
  const [fPost, setFPost] = useState('')
  const isAnyManager = (profiles || []).some((p) => ['owner', 'admin'].includes(p._role))
  // Phone: show one stage at a time (segmented picker) instead of the 5-column
  // horizontal board. Drag is desktop-only; on mobile you move cards via the
  // card sheet's stage buttons (Approve, Request revisions, Send to Schedule).
  const isMobile = useIsMobile()
  const [mobileStage, setMobileStage] = useState(STAGES[0].key)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const load = useCallback(() => {
    if (!token) return
    fetch(`/api/board${showArchive ? '?archived=1' : ''}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((b) => { if (b.error) throw new Error(b.error); setCards(b.cards || []) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [token, showArchive])

  useEffect(() => { setLoading(true); load() }, [load])

  // Offer magic-link editors a password on first login (once per session).
  useEffect(() => {
    const u = session?.user
    if (role !== 'contributor' || !u || u.user_metadata?.password_set) return
    let skip = false
    try { skip = sessionStorage.getItem('scalesolo.pwPromptSkipped') === '1' } catch { /* noop */ }
    if (!skip) setPwPrompt(true)
  }, [role, session])

  const isUnpaid = (c) => !!c.approved_at && !c.payout_id
  // What a card's post is actually doing, which is not the same as its stage:
  // a card can sit in Scheduled with no post at all, or with one that failed.
  const postState = (c) => {
    if (!c.content_script_id) return 'none'
    const s = c.post?.status
    return s === 'posted' ? 'posted' : s === 'failed' ? 'failed' : 'queued'
  }
  const POST_LABEL = { posted: 'Published', failed: 'Failed to post', queued: 'Waiting to post', none: 'No post yet' }

  // Options come from the cards actually on the board, so a filter can never
  // offer something that would return nothing.
  const filterOptions = useMemo(() => {
    const brands = new Map()
    const editors = new Map()
    const posts = new Set()
    for (const c of cards) {
      if (c.profile_id) brands.set(c.profile_id, c.brand?.business_name || 'Unnamed brand')
      const key = c.assigned_editor_email || ''
      if (key) editors.set(key, c.assigned_editor_name || key)
      posts.add(postState(c))
    }
    return {
      brands: [...brands].sort((a, b) => a[1].localeCompare(b[1])),
      editors: [...editors].sort((a, b) => a[1].localeCompare(b[1])),
      posts: ['posted', 'queued', 'failed', 'none'].filter((p) => posts.has(p)),
      hasUnassigned: cards.some((c) => !c.assigned_editor_email),
    }
  }, [cards])

  const matches = (c) => {
    if (unpaidOnly && !isUnpaid(c)) return false
    if (fBrand && c.profile_id !== fBrand) return false
    if (fEditor === '__none') { if (c.assigned_editor_email) return false }
    else if (fEditor && c.assigned_editor_email !== fEditor) return false
    if (fPost && postState(c) !== fPost) return false
    return true
  }
  const activeFilters = [unpaidOnly, fBrand, fEditor, fPost].filter(Boolean).length
  const visibleCount = cards.filter(matches).length

  const byStage = useMemo(() => {
    const map = new Map(STAGES.map((s) => [s.key, []]))
    const shown = cards.filter(matches)
    for (const c of shown) map.get(foldStage(c.stage)).push(c)
    for (const arr of map.values()) arr.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    return map
  }, [cards, unpaidOnly, fBrand, fEditor, fPost])

  const findCard = useCallback((id) => cards.find((c) => c.id === id), [cards])
  const findStage = useCallback((id) => { const c = findCard(id); return c ? foldStage(c.stage) : null }, [findCard])

  const onDragStart = (e) => setActiveDragId(e.active.id)
  const onDragOver = (e) => {
    const { active, over } = e
    if (!over) return
    const activeStage = findStage(active.id)
    const overStage = over.data?.current?.type === 'stage' ? over.data.current.stage : findStage(over.id)
    if (!overStage || activeStage === overStage) return
    setCards((prev) => prev.map((c) => c.id === active.id ? { ...c, stage: overStage } : c))
  }
  const onDragEnd = async (e) => {
    setActiveDragId(null)
    const { active, over } = e
    if (!over || !token) return
    const cardId = active.id
    const overStage = over.data?.current?.type === 'stage' ? over.data.current.stage : findStage(over.id)
    if (!overStage) return
    let position = 0
    if (over.data?.current?.type === 'card' && over.id !== cardId) {
      const list = (byStage.get(overStage) || []).slice()
      const oldIdx = list.findIndex((c) => c.id === cardId)
      const newIdx = list.findIndex((c) => c.id === over.id)
      if (oldIdx >= 0 && newIdx >= 0) {
        const reordered = arrayMove(list, oldIdx, newIdx)
        setCards((prev) => { const others = prev.filter((c) => foldStage(c.stage) !== overStage); return [...others, ...reordered.map((c, i) => ({ ...c, stage: overStage, position: i }))] })
        position = newIdx
      }
    } else {
      const list = (byStage.get(overStage) || []).filter((c) => c.id !== cardId)
      position = list.length
      setCards((prev) => prev.map((c) => c.id === cardId ? { ...c, stage: overStage, position } : c))
    }
    try {
      const r = await fetch(`/api/board?id=${cardId}&action=move`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stage: overStage, position }),
      })
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || 'Move failed') }
    } catch (e) { setError(e.message); load() }
  }

  if (loading) return <div className="card-flat" style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
  if (!profiles?.length) {
    return <div className="card-flat fade-up" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Create a brand profile first, then your production board will live here.</div>
  }

  const draggedCard = activeDragId ? findCard(activeDragId) : null
  const openCard = openCardId ? findCard(openCardId) : null

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: isMobile ? 140 : 220 }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, margin: 0 }}>Production board</h1>
          {!isMobile && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>All clients in one place. Upload raw footage, review editor versions, approve, then send to Schedule.</div>}
        </div>
        <button className="btn-secondary" onClick={() => { setLoading(true); setShowArchive((v) => !v) }}
          title={showArchive ? 'Back to the live board' : 'Opens a list of finished cards. Viewing only, it archives nothing.'}>
          <Archive size={14} /> {showArchive ? 'Back to board' : 'View archive'}
        </button>
        {!showArchive && <button className="btn-primary" onClick={() => setNewCardStage('editing')}><Plus size={14} /> New card</button>}
      </div>
      {error && <div style={{ marginBottom: 12, padding: '10px 14px', background: 'var(--red-soft)', color: 'var(--red)', borderRadius: 10, fontSize: 13 }}>{error}</div>}

      {showArchive && (
        <div style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', fontSize: 12.5, color: 'var(--muted)' }}>
          Finished work. A card lands here on its own once its post has actually published and the editor has been paid.
          Nothing is deleted, and opening a card here lets you put it back on the board.
        </div>
      )}

      {/* Filters apply to every column at once, so the board stays a board:
          you still see where the work sits, just less of it. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
          <Filter size={13} /> Filter
        </span>
        {filterOptions.brands.length > 1 && (
          <select className="input" value={fBrand} onChange={(e) => setFBrand(e.target.value)}
            style={{ maxWidth: 200, fontSize: 12.5, height: 36, borderColor: fBrand ? 'var(--red)' : undefined }}>
            <option value="">All clients</option>
            {filterOptions.brands.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        {isAnyManager && (filterOptions.editors.length > 0 || filterOptions.hasUnassigned) && (
          <select className="input" value={fEditor} onChange={(e) => setFEditor(e.target.value)}
            style={{ maxWidth: 200, fontSize: 12.5, height: 36, borderColor: fEditor ? 'var(--red)' : undefined }}>
            <option value="">All editors</option>
            {filterOptions.editors.map(([email, name]) => <option key={email} value={email}>{name}</option>)}
            {filterOptions.hasUnassigned && <option value="__none">Unassigned</option>}
          </select>
        )}
        {filterOptions.posts.length > 1 && (
          <select className="input" value={fPost} onChange={(e) => setFPost(e.target.value)}
            style={{ maxWidth: 190, fontSize: 12.5, height: 36, borderColor: fPost ? 'var(--red)' : undefined }}>
            <option value="">Any post status</option>
            {filterOptions.posts.map((p) => <option key={p} value={p}>{POST_LABEL[p]}</option>)}
          </select>
        )}
        {isAnyManager && (
          <button className="btn-secondary" onClick={() => setUnpaidOnly((v) => !v)}
            title="Only cards that are approved but not paid yet"
            style={{ height: 36, fontSize: 12.5, ...(unpaidOnly ? { borderColor: 'var(--red)', color: 'var(--red)' } : null) }}>
            <DollarSign size={13} /> Unpaid
          </button>
        )}
        {activeFilters > 0 && (
          <>
            <button className="btn-secondary" onClick={() => { setFBrand(''); setFEditor(''); setFPost(''); setUnpaidOnly(false) }}
              style={{ height: 36, fontSize: 12.5 }}><X size={13} /> Clear</button>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {visibleCount} of {cards.length} card{cards.length === 1 ? '' : 's'}
            </span>
          </>
        )}
      </div>
      {isMobile ? (
        <div>
          {/* segmented stage picker — only this strip scrolls sideways */}
          <div style={{ overflowX: 'auto', margin: '0 -4px', padding: '0 4px 2px', WebkitOverflowScrolling: 'touch' }}>
            <div style={{ display: 'inline-flex', gap: 8 }}>
              {STAGES.map((s) => {
                const active = s.key === mobileStage
                const n = (byStage.get(s.key) || []).length
                return (
                  <button key={s.key} onClick={() => setMobileStage(s.key)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap', flexShrink: 0, height: 42, padding: '0 14px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: active ? 'var(--text)' : 'var(--muted)', background: active ? `${s.color}1f` : 'var(--surface-2)', border: `1px solid ${active ? `${s.color}80` : 'var(--border)'}` }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color }} />
                    {s.label}
                    <span style={{ fontSize: 11, color: active ? s.color : 'var(--muted)', background: 'var(--surface)', borderRadius: 999, padding: '1px 7px' }}>{n}</span>
                  </button>
                )
              })}
            </div>
          </div>
          {/* selected stage's cards, full width, tap to open the detail sheet */}
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(byStage.get(mobileStage) || []).length === 0
              ? <div style={{ ...dropHint, padding: 22 }}>No cards in {STAGE_LABEL[mobileStage]} yet.</div>
              : (byStage.get(mobileStage) || []).map((c) => {
                  const canPay = isAnyManager && isPayableStage(c) && !c.payout_id && c.assigned_editor_email
                  return (
                    <div key={c.id} onClick={() => setOpenCardId(c.id)} style={{ ...cardStyle(false), cursor: 'pointer' }}>
                      <CardBody card={c} />
                      {canPay && (
                        <button className="btn-secondary" onClick={(e) => { e.stopPropagation(); setPayCard(c) }}
                          style={{ marginTop: 8, fontSize: 12.5, width: '100%', justifyContent: 'center', height: 42 }}>
                          <DollarSign size={13} /> Pay editor
                        </button>
                      )}
                    </div>
                  )
                })}
            <button style={addBtn} onClick={() => setNewCardStage(mobileStage)}><Plus size={13} /> Add card</button>
          </div>
        </div>
      ) : (
      // Do NOT add fade-up here: its transform breaks DragOverlay's fixed positioning.
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
        <div style={board} className="board-bleed">
          {STAGES.map((s) => (
            <StageColumn key={s.key} stage={s} cards={byStage.get(s.key) || []} onAdd={setNewCardStage} onCardClick={(c) => setOpenCardId(c.id)} onPay={setPayCard} isManager={isAnyManager} />
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {draggedCard && (
            <div style={{ ...cardStyle(false), cursor: 'grabbing', boxShadow: '0 16px 40px rgba(0,0,0,0.45)', transform: 'rotate(1.5deg)' }}>
              <CardBody card={draggedCard} />
            </div>
          )}
        </DragOverlay>
      </DndContext>
      )}

      {newCardStage && (
        <NewCardModal stage={newCardStage} profiles={profiles} defaultBrandId={selectedProfileId} token={token}
          onClose={() => setNewCardStage(null)}
          onCreated={(c) => { setCards((prev) => [...prev, { ...c, comments: [{ count: 0 }], versions: c.versions || [] }]); setNewCardStage(null); setOpenCardId(c.id) }} />
      )}
      {openCard && (
        <CardDrawer card={openCard} profiles={profiles} token={token} role={role}
          onClose={() => setOpenCardId(null)} onChanged={load} onPay={setPayCard} />
      )}
      {payCard && (
        <PayoutSendModal token={token} kind="pay" params={{ card_id: payCard.id }} requireConfirm={payoutConfirmOn()}
          onClose={() => setPayCard(null)} onDone={() => { setPayCard(null); load() }} />
      )}
      {showEditors && <EditorsModal token={token} onClose={() => setShowEditors(false)} />}
      {pwPrompt && <SetPasswordPrompt onDone={(set) => { setPwPrompt(false); if (!set) { try { sessionStorage.setItem('scalesolo.pwPromptSkipped', '1') } catch { /* noop */ } } }} />}
    </div>
  )
}
