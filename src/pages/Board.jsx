// Video Production Board — a native Kanban that replaces the Notion approval
// flow. Cards move raw -> editing -> in_review -> needs_revisions -> approved
// -> scheduled. Videos upload straight to our landing-media Supabase bucket;
// each card keeps a version history + a feedback thread. Approving marks the
// card Approved; a separate "Send to Schedule" spawns a content_scripts draft
// that flows into the existing Schedule page. (Drag machinery cloned from
// src/pages/Pipeline.jsx.)
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
  Loader2, Download, CircleDot,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { supabase } from '../lib/supabase.js'
import { toast, confirmDialog } from '../components/Toast.jsx'

// ── stages ───────────────────────────────────────────────────────────────
const STAGES = [
  { key: 'raw',             label: 'Raw',             color: '#94a3b8' },
  { key: 'editing',         label: 'Editing',         color: '#60a5fa' },
  { key: 'in_review',       label: 'In Review',       color: '#a78bfa' },
  { key: 'needs_revisions', label: 'Needs Revisions', color: '#f59e0b' },
  { key: 'approved',        label: 'Approved',        color: '#2ecc71' },
  { key: 'scheduled',       label: 'Scheduled',       color: '#ef4444' },
]
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label]))

// ── styles (cloned from Pipeline) ─────────────────────────────────────────
const board = { display: 'flex', gap: 14, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 24, minHeight: 'calc(100vh - 220px)' }
const column = { flex: '0 0 260px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 200px)' }
const columnHead = { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--border)' }
const stagePill = (color) => ({ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 })
const stageName = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, flex: 1, color: 'var(--text)' }
const stageMeta = { fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-display)', fontWeight: 600 }
const colBody = { flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 80 }
const dropHint = { borderRadius: 10, border: '1px dashed var(--border)', padding: 16, textAlign: 'center', color: 'var(--muted)', fontSize: 12.5 }
const cardStyle = (isDragging) => ({ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '11px 12px', cursor: 'grab', opacity: isDragging ? 0.4 : 1, transition: 'border-color 0.12s ease, box-shadow 0.12s ease' })
const cardTitle = { fontSize: 13.5, fontWeight: 600, color: 'var(--text)', marginBottom: 6, lineHeight: 1.3 }
const cardRow = { display: 'flex', alignItems: 'center', gap: 12, fontSize: 11.5, color: 'var(--muted)' }
const addBtn = { marginTop: 4, width: '100%', padding: '9px 12px', border: '1px dashed var(--border)', borderRadius: 10, background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 12.5, fontFamily: 'var(--font-display)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }

const rand6 = () => Math.random().toString(36).slice(2, 8)

// Direct browser upload to landing-media, path <profile_id>/board/<card_id>/...
// First path segment = profile UUID satisfies the storage RLS insert policy.
async function uploadBoardVideo(file, profileId, cardId) {
  const ext = (file.name.split('.').pop() || 'mp4').toLowerCase()
  const path = `${profileId}/board/${cardId}/${Date.now()}-${rand6()}.${ext}`
  const { error } = await supabase.storage.from('landing-media').upload(path, file, {
    contentType: file.type || 'video/mp4', upsert: false,
  })
  if (error) throw new Error(error.message)
  const { data } = supabase.storage.from('landing-media').getPublicUrl(path)
  return data.publicUrl
}

// ── card body (also used by DragOverlay) ──────────────────────────────────
function CardBody({ card }) {
  const versions = card.versions || []
  const comments = card.comments?.[0]?.count ?? 0
  return (
    <>
      <div style={cardTitle}>{card.title || 'Untitled'}</div>
      <div style={cardRow}>
        <span><Film size={11} style={{ verticalAlign: '-1px' }} /> {versions.length ? `v${versions.length}` : 'no video'}</span>
        {comments > 0 && <span><MessageSquare size={11} style={{ verticalAlign: '-1px' }} /> {comments}</span>}
        {card.content_script_id && <span style={{ color: 'var(--red)' }}>· scheduled draft</span>}
      </div>
    </>
  )
}

// ── sortable card ─────────────────────────────────────────────────────────
function SortableCard({ card, onClick }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id, data: { type: 'card', card },
  })
  const style = isDragging ? { opacity: 0, pointerEvents: 'none' } : { transform: CSS.Transform.toString(transform), transition }
  return (
    <div ref={setNodeRef} style={{ ...cardStyle(false), ...style }} {...attributes} {...listeners}
      onClick={() => { if (!isDragging && onClick) onClick(card) }}>
      <CardBody card={card} />
    </div>
  )
}

// ── droppable column ──────────────────────────────────────────────────────
function StageColumn({ stage, cards, onAdd, onCardClick }) {
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
            : cards.map((c) => <SortableCard key={c.id} card={c} onClick={onCardClick} />)}
        </SortableContext>
        <button style={addBtn} onClick={() => onAdd(stage.key)}><Plus size={13} /> Add card</button>
      </div>
    </div>
  )
}

// ── new-card modal ────────────────────────────────────────────────────────
function NewCardModal({ stage, profileId, token, onClose, onCreated }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const create = async () => {
    if (!title.trim()) return
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/board', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile_id: profileId, title: title.trim(), stage }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Failed')
      onCreated(body.card)
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
            <label className="label">Title</label>
            <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') create() }}
              placeholder="e.g. Chicken shawarma B-roll" />
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Column: <strong style={{ color: 'var(--text)' }}>{STAGE_LABEL[stage]}</strong>. You'll upload the video inside the card.</div>
          {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 12px', borderRadius: 10, fontSize: 13 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={create} disabled={busy || !title.trim()}>
              {busy ? <span className="spinner" /> : <Plus size={14} />} Create card
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── card detail drawer ────────────────────────────────────────────────────
function CardDrawer({ card, profileId, token, role, onClose, onChanged }) {
  const isManager = ['owner', 'admin'].includes(role)
  const [versions, setVersions] = useState(card.versions || [])
  const [comments, setComments] = useState([])
  const [commentText, setCommentText] = useState('')
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [finalId, setFinalId] = useState(card.final_version_id || null)
  const [err, setErr] = useState(null)
  const fileRef = useRef(null)

  useEffect(() => {
    fetch(`/api/board/comments?card_id=${card.id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json()).then((b) => setComments(b.comments || [])).catch(() => {})
    fetch(`/api/board/versions?card_id=${card.id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json()).then((b) => { if (b.versions) setVersions(b.versions) }).catch(() => {})
  }, [card.id, token])

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
    setUploading(true); setErr(null)
    try {
      const url = await uploadBoardVideo(file, profileId, card.id)
      const kind = versions.length === 0 ? 'raw' : 'edit'
      const r = await fetch('/api/board/versions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ card_id: card.id, video_url: url, kind }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || 'Upload failed')
      const list = await fetch(`/api/board/versions?card_id=${card.id}`, { headers: { Authorization: `Bearer ${token}` } }).then((x) => x.json())
      setVersions(list.versions || [])
      toast({ message: `Version v${b.version?.version_no} uploaded`, kind: 'success' })
      onChanged()
    } catch (e) { setErr(e.message); toast({ message: e.message, kind: 'error' }) }
    finally { setUploading(false) }
  }

  const setFinal = async (vid) => {
    setBusy(true); setErr(null)
    try { await patchCard({ final_version_id: vid }); setFinalId(vid); onChanged() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  const approve = async () => {
    if (!versions.length) { toast({ message: 'Upload a video before approving.', kind: 'warn' }); return }
    setBusy(true); setErr(null)
    try {
      const chosen = finalId || versions[0].id // versions come newest-first
      await patchCard({ stage: 'approved', final_version_id: chosen })
      setFinalId(chosen)
      toast({ message: 'Approved', kind: 'success' })
      onChanged(); onClose()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  const sendToSchedule = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`/api/board?id=${card.id}&action=send-to-schedule`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || 'Failed')
      toast({ message: b.already ? 'Already on the Schedule page.' : 'Draft created on the Schedule page. Add captions + a time there.', kind: 'success' })
      onChanged(); onClose()
    } catch (e) { setErr(e.message); toast({ message: e.message, kind: 'error' }) }
    finally { setBusy(false) }
  }

  const postComment = async () => {
    const body = commentText.trim()
    if (!body) return
    setCommentText('')
    try {
      const r = await fetch('/api/board/comments', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ card_id: card.id, body }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || 'Failed')
      setComments((prev) => [...prev, b.comment])
      onChanged()
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

  const sectionTitle = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: 'var(--text)', margin: '18px 0 8px' }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620, width: '100%', maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <input
              className="input"
              defaultValue={card.title}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== card.title) patchCard({ title: v }).then(onChanged).catch(() => {}) }}
              style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, border: 'none', padding: 0, background: 'transparent' }}
            />
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{STAGE_LABEL[card.stage]}</div>
          </div>
          <button aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6 }}><X size={18} /></button>
        </div>

        {err && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginTop: 8 }}>{err}</div>}

        {/* Versions */}
        <div style={sectionTitle}>Versions</div>
        <input ref={fileRef} type="file" accept="video/*" onChange={onPickFile} style={{ display: 'none' }} />
        <button className="btn-secondary" onClick={() => fileRef.current?.click()} disabled={uploading} style={{ width: '100%', justifyContent: 'center' }}>
          {uploading ? <><Loader2 size={14} className="spin" /> Uploading…</> : <><Upload size={14} /> {versions.length ? 'Upload new version' : 'Upload the video'}</>}
        </button>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
          {versions.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No video yet. Upload the raw cut or the editor's version.</div>}
          {versions.map((v) => (
            <div key={v.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10, background: 'var(--surface-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <strong style={{ fontSize: 12.5 }}>v{v.version_no}</strong>
                <span style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'capitalize' }}>{v.kind}</span>
                <span style={{ flex: 1 }} />
                <button
                  onClick={() => setFinal(v.id)} disabled={busy}
                  title={finalId === v.id ? 'Final pick' : 'Mark as final'}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 11.5, color: finalId === v.id ? 'var(--red)' : 'var(--muted)', fontWeight: 600 }}>
                  {finalId === v.id ? <Check size={13} /> : <CircleDot size={13} />} {finalId === v.id ? 'Final' : 'Set final'}
                </button>
                <a href={v.video_url} download style={{ color: 'var(--muted)', display: 'inline-flex' }} title="Download"><Download size={14} /></a>
              </div>
              <video src={v.video_url} controls preload="metadata" style={{ width: '100%', maxHeight: 240, borderRadius: 8, background: '#000' }} />
              {v.note && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{v.note}</div>}
            </div>
          ))}
        </div>

        {/* Feedback */}
        <div style={sectionTitle}>Feedback</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {comments.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No feedback yet.</div>}
          {comments.map((c) => (
            <div key={c.id} style={{ fontSize: 13, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
              <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4 }}>{new Date(c.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input" value={commentText} onChange={(e) => setCommentText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') postComment() }} placeholder="Leave feedback for the editor…" style={{ flex: 1 }} />
            <button className="btn-secondary" onClick={postComment} disabled={!commentText.trim()}>Post</button>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 20, alignItems: 'center' }}>
          {isManager && card.stage !== 'approved' && card.stage !== 'scheduled' && (
            <button className="btn-primary" onClick={approve} disabled={busy || !versions.length}><Check size={14} /> Approve</button>
          )}
          {isManager && card.stage !== 'needs_revisions' && card.stage !== 'scheduled' && (
            <button className="btn-secondary" onClick={() => patchCard({ stage: 'needs_revisions' }).then(() => { toast({ message: 'Sent back for revisions', kind: 'info' }); onChanged(); onClose() }).catch((e) => setErr(e.message))} disabled={busy}>Request revisions</button>
          )}
          {isManager && card.stage === 'approved' && !card.content_script_id && (
            <button className="btn-primary" onClick={sendToSchedule} disabled={busy}><CalendarPlus size={14} /> Send to Schedule</button>
          )}
          {card.content_script_id && <span style={{ fontSize: 12.5, color: 'var(--red)', fontWeight: 600 }}>On the Schedule page →</span>}
          <span style={{ flex: 1 }} />
          {isManager && (
            <button onClick={removeCard} title="Delete card" style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6 }}><Trash2 size={16} /></button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── main page ─────────────────────────────────────────────────────────────
export default function Board() {
  const { session } = useAuth()
  const { selectedProfileId, selectedProfile } = useProfile()
  const token = session?.access_token
  const role = selectedProfile?._role || 'viewer'
  const [cards, setCards] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeDragId, setActiveDragId] = useState(null)
  const [newCardStage, setNewCardStage] = useState(null)
  const [openCardId, setOpenCardId] = useState(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const load = useCallback(() => {
    if (!token || !selectedProfileId) return
    fetch(`/api/board?profile_id=${selectedProfileId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((b) => { if (b.error) throw new Error(b.error); setCards(b.cards || []) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [token, selectedProfileId])

  useEffect(() => { setLoading(true); load() }, [load])

  const byStage = useMemo(() => {
    const map = new Map(STAGES.map((s) => [s.key, []]))
    for (const c of cards) { if (!map.has(c.stage)) map.set(c.stage, []); map.get(c.stage).push(c) }
    for (const arr of map.values()) arr.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    return map
  }, [cards])

  const findCard = useCallback((id) => cards.find((c) => c.id === id), [cards])
  const findStage = useCallback((id) => findCard(id)?.stage || null, [findCard])

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
        setCards((prev) => { const others = prev.filter((c) => c.stage !== overStage); return [...others, ...reordered.map((c, i) => ({ ...c, stage: overStage, position: i }))] })
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

  if (!selectedProfileId) {
    return <div className="card-flat fade-up" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Pick a brand profile to open its production board.</div>
  }
  if (loading) return <div className="card-flat" style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>

  const draggedCard = activeDragId ? findCard(activeDragId) : null
  const openCard = openCardId ? findCard(openCardId) : null

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, margin: 0 }}>Production board</h1>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>Upload raw footage, review editor versions, approve, then send to Schedule.</div>
      </div>
      {error && <div style={{ marginBottom: 12, padding: '10px 14px', background: 'var(--red-soft)', color: 'var(--red)', borderRadius: 10, fontSize: 13 }}>{error}</div>}
      {/* Do NOT add fade-up here — its transform breaks DragOverlay's fixed positioning. */}
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
        <div style={board}>
          {STAGES.map((s) => (
            <StageColumn key={s.key} stage={s} cards={byStage.get(s.key) || []} onAdd={setNewCardStage} onCardClick={(c) => setOpenCardId(c.id)} />
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
        <NewCardModal stage={newCardStage} profileId={selectedProfileId} token={token}
          onClose={() => setNewCardStage(null)}
          onCreated={(c) => { setCards((prev) => [...prev, { ...c, comments: [{ count: 0 }] }]); setNewCardStage(null); setOpenCardId(c.id) }} />
      )}
      {openCard && (
        <CardDrawer card={openCard} profileId={selectedProfileId} token={token} role={role}
          onClose={() => setOpenCardId(null)} onChanged={load} />
      )}
    </div>
  )
}
