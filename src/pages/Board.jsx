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
import {
  Plus, X, Upload, Film, MessageSquare, Check, CalendarPlus, Trash2,
  Loader2, Download, Building2, Send, CornerUpLeft, Settings, DollarSign, ExternalLink,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { toast, confirmDialog } from '../components/Toast.jsx'
import PayoutSendModal from '../components/PayoutSendModal.jsx'
import { supabase } from '../lib/supabase.js'

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

// ── styles (cloned from Pipeline) ─────────────────────────────────────────
const board = { display: 'flex', gap: 14, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 24, minHeight: 'calc(100vh - 220px)' }
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
        {(card.assigned_editor_name || card.assigned_editor_email) && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title={`Assigned to ${card.assigned_editor_name || card.assigned_editor_email}`}>
            <Avatar name={card.assigned_editor_name || card.assigned_editor_email} size={16} /> {card.assigned_editor_name || card.assigned_editor_email.split('@')[0]}
          </span>
        )}
        {/* Payment status — shown once a card has been approved (approved + scheduled). */}
        {card.approved_at && (card.payout_id
          ? <span style={catPill('#2ecc71')} title={card.payout?.created_at ? `Paid ${new Date(card.payout.created_at).toLocaleString()}` : 'Paid'}>
              Paid{card.payout?.amount_usdt ? ` $${Number(card.payout.amount_usdt).toFixed(2)}` : ''}
            </span>
          : <span style={catPill('#f59e0b')}>Unpaid</span>
        )}
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
  const canPay = isManager && card.approved_at && !card.payout_id && card.assigned_editor_email
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

  const changeBrand = async (newId) => {
    if (!newId || newId === card.profile_id) return
    setBusy(true); setErr(null)
    try { await patchCard({ profile_id: newId }); toast({ message: 'Client updated', kind: 'success' }); onChanged() }
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

  const moveStage = async (stage, msg) => {
    setBusy(true); setErr(null)
    try { await patchCard({ stage }); if (msg) toast({ message: msg, kind: 'success' }); onChanged(); onClose() }
    catch (e) { setErr(e.message); setBusy(false) }
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

  const approve = async () => {
    if (!latestVersionId) { toast({ message: 'Upload a video before approving.', kind: 'warn' }); return }
    setBusy(true); setErr(null)
    try {
      await patchCard({ stage: 'approved', final_version_id: latestVersionId })
      toast({ message: 'Approved — using the latest upload', kind: 'success' }); onChanged(); onClose()
    } catch (e) { setErr(e.message); setBusy(false) }
  }

  const sendToSchedule = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`/api/board?id=${card.id}&action=send-to-schedule`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || 'Failed')
      if (b.already) {
        toast({ message: 'Already on the Schedule page.', kind: 'success' })
      } else {
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
                        <a href={d.video_url} download style={{ color: 'var(--muted)', display: 'inline-flex' }} title="Download"><Download size={14} /></a>
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
          {isManager && !['needs_revisions', 'scheduled'].includes(stage) && (
            <button className="btn-secondary" onClick={() => moveStage('needs_revisions', 'Sent back for revisions')} disabled={busy}>Request revisions</button>
          )}
          {isManager && stage === 'approved' && !card.content_script_id && (
            <button className="btn-primary" onClick={sendToSchedule} disabled={busy}><CalendarPlus size={14} /> Send to Schedule</button>
          )}
          {card.content_script_id && <span style={{ fontSize: 12.5, color: 'var(--red)', fontWeight: 600 }}>On the Schedule page →</span>}
          <span style={{ flex: 1 }} />
          {isManager && <button onClick={removeCard} title="Delete card" style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6 }}><Trash2 size={16} /></button>}
        </div>

        {/* Payment record — the assigned editor and managers both see when it
            was paid and the crypto transaction. Managers can release it here. */}
        {card.approved_at && (
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <strong style={{ fontSize: 13 }}>{ed.name || ed.email}</strong>
                    {ed.name && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{ed.email}</span>}
                    {Object.values(ed.brands).some((s) => s === 'pending') && <span style={{ fontSize: 10.5, color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 999, padding: '0 7px' }}>pending</span>}
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
  const isAnyManager = (profiles || []).some((p) => ['owner', 'admin'].includes(p._role))

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const load = useCallback(() => {
    if (!token) return
    fetch('/api/board', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((b) => { if (b.error) throw new Error(b.error); setCards(b.cards || []) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [token])

  useEffect(() => { setLoading(true); load() }, [load])

  // Offer magic-link editors a password on first login (once per session).
  useEffect(() => {
    const u = session?.user
    if (role !== 'contributor' || !u || u.user_metadata?.password_set) return
    let skip = false
    try { skip = sessionStorage.getItem('scalesolo.pwPromptSkipped') === '1' } catch { /* noop */ }
    if (!skip) setPwPrompt(true)
  }, [role, session])

  const byStage = useMemo(() => {
    const map = new Map(STAGES.map((s) => [s.key, []]))
    for (const c of cards) map.get(foldStage(c.stage)).push(c)
    for (const arr of map.values()) arr.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    return map
  }, [cards])

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
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, margin: 0 }}>Production board</h1>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>All clients in one place. Upload raw footage, review editor versions, approve, then send to Schedule.</div>
        </div>
        {isAnyManager && <button className="btn-secondary" onClick={() => setShowEditors(true)}><Settings size={14} /> Settings</button>}
        <button className="btn-primary" onClick={() => setNewCardStage('editing')}><Plus size={14} /> New card</button>
      </div>
      {error && <div style={{ marginBottom: 12, padding: '10px 14px', background: 'var(--red-soft)', color: 'var(--red)', borderRadius: 10, fontSize: 13 }}>{error}</div>}
      {/* Do NOT add fade-up here — its transform breaks DragOverlay's fixed positioning. */}
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
        <div style={board}>
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
