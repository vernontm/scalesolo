import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  closestCorners, useDroppable,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, verticalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Plus, GripVertical, X, DollarSign, Calendar, Users, Trash2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'

// ── styles ─────────────────────────────────────────────────────────────────
const board = {
  display: 'flex',
  gap: 14,
  alignItems: 'flex-start',
  overflowX: 'auto',
  paddingBottom: 24,
  minHeight: 'calc(100vh - 220px)',
}
const column = {
  flex: '0 0 280px',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  display: 'flex',
  flexDirection: 'column',
  maxHeight: 'calc(100vh - 220px)',
}
const columnHead = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '12px 14px',
  borderBottom: '1px solid var(--border)',
}
const stagePill = (color) => ({
  width: 8, height: 8, borderRadius: '50%', background: color,
  flexShrink: 0,
})
const stageName = {
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13,
  flex: 1, color: 'var(--text)',
}
const stageMeta = {
  fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-display)', fontWeight: 600,
}
const colBody = {
  flex: 1, overflowY: 'auto', padding: 10,
  display: 'flex', flexDirection: 'column', gap: 8,
  minHeight: 80,
}
const dropHint = {
  borderRadius: 10,
  border: '1px dashed var(--border)',
  padding: 16,
  textAlign: 'center',
  color: 'var(--muted)',
  fontSize: 12.5,
}
const card = (isDragging) => ({
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '11px 12px',
  cursor: 'grab',
  opacity: isDragging ? 0.4 : 1,
  transition: 'border-color 0.12s ease, box-shadow 0.12s ease',
})
const cardTitle = {
  fontSize: 13.5, fontWeight: 600, color: 'var(--text)',
  marginBottom: 6, lineHeight: 1.3,
}
const cardRow = {
  display: 'flex', alignItems: 'center', gap: 10,
  fontSize: 11.5, color: 'var(--muted)',
}
const addBtn = {
  marginTop: 4,
  width: '100%',
  padding: '9px 12px',
  border: '1px dashed var(--border)',
  borderRadius: 10,
  background: 'transparent',
  color: 'var(--muted)',
  cursor: 'pointer',
  fontSize: 12.5,
  fontFamily: 'var(--font-display)',
  fontWeight: 600,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
}

const STAGE_COLORS = ['#94a3b8', '#60a5fa', '#a78bfa', '#f59e0b', '#2ecc71', '#ef4444']

const fmtMoney = (v) => {
  const n = Number(v) || 0
  if (n >= 1000) return `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return `$${n}`
}

// ── presentational card body (also used by DragOverlay) ───────────────────
function DealCardBody({ deal }) {
  return (
    <>
      <div style={cardTitle}>{deal.title}</div>
      <div style={cardRow}>
        {deal.value > 0 && <span><DollarSign size={11} style={{ verticalAlign: '-1px' }} /> {fmtMoney(deal.value)}</span>}
        {deal.contact?.name && <span><Users size={11} style={{ verticalAlign: '-1px' }} /> {deal.contact.name}</span>}
        {deal.expected_close_at && <span><Calendar size={11} style={{ verticalAlign: '-1px' }} /> {new Date(deal.expected_close_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}
      </div>
    </>
  )
}

// ── sortable card ──────────────────────────────────────────────────────────
function DealCard({ deal, onClick }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: deal.id,
    data: { type: 'deal', deal },
  })
  // While dragging, hide the source card — DragOverlay renders the moving copy
  // at the exact cursor offset, so showing both creates the visual desync.
  const style = isDragging
    ? { opacity: 0, pointerEvents: 'none' }
    : { transform: CSS.Transform.toString(transform), transition }
  return (
    <div
      ref={setNodeRef}
      style={{ ...card(false), ...style }}
      {...attributes}
      {...listeners}
      onClick={(e) => { if (!isDragging && onClick) onClick(deal) }}
    >
      <DealCardBody deal={deal} />
    </div>
  )
}

// ── droppable column ───────────────────────────────────────────────────────
function StageColumn({ stage, color, deals, onAdd, onCardClick }) {
  const { setNodeRef, isOver } = useDroppable({ id: `stage:${stage}`, data: { type: 'stage', stage } })
  const total = deals.reduce((sum, d) => sum + (Number(d.value) || 0), 0)

  return (
    <div style={column}>
      <div style={columnHead}>
        <div style={stagePill(color)} />
        <div style={stageName}>{stage}</div>
        <div style={stageMeta}>{deals.length} · {fmtMoney(total)}</div>
      </div>
      <div
        ref={setNodeRef}
        style={{
          ...colBody,
          background: isOver ? 'rgba(239,68,68,0.05)' : 'transparent',
          transition: 'background 0.12s ease',
        }}
      >
        <SortableContext items={deals.map((d) => d.id)} strategy={verticalListSortingStrategy}>
          {deals.length === 0 ? (
            <div style={dropHint}>Drop a deal here</div>
          ) : (
            deals.map((d) => <DealCard key={d.id} deal={d} onClick={onCardClick} />)
          )}
        </SortableContext>
        <button style={addBtn} onClick={() => onAdd(stage)}>
          <Plus size={13} /> Add deal
        </button>
      </div>
    </div>
  )
}

// ── new-deal modal ─────────────────────────────────────────────────────────
function NewDealModal({ pipelineId, defaultStage, profileId, onClose, onCreated }) {
  const { session } = useAuth()
  const [title, setTitle] = useState('')
  const [value, setValue] = useState('')
  const [closeDate, setCloseDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const create = async () => {
    if (!title.trim()) return
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/deals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          pipeline_id: pipelineId,
          title: title.trim(),
          stage: defaultStage,
          value: parseFloat(value) || 0,
          expected_close_at: closeDate || null,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Failed')
      onCreated(body.deal)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
      display: 'grid', placeItems: 'center', zIndex: 100, padding: 24,
    }} onClick={onClose}>
      <div style={{
        width: '100%', maxWidth: 460, background: 'var(--surface)',
        border: '1px solid var(--border)', borderRadius: 16, padding: 24,
      }} onClick={(e) => e.stopPropagation()} className="fade-up">
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 18 }}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, flex: 1 }}>New deal</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={18} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label className="label">Title</label>
            <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Acme — coaching package" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label className="label">Value (USD)</label>
              <input className="input" type="number" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0" />
            </div>
            <div>
              <label className="label">Expected close</label>
              <input className="input" type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Stage: <strong style={{ color: 'var(--text)' }}>{defaultStage}</strong></div>
          {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 12px', borderRadius: 10, fontSize: 13 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={create} disabled={busy || !title.trim()}>
              {busy ? <span className="spinner" /> : <Plus size={14} />}
              Create deal
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── main page ──────────────────────────────────────────────────────────────
export default function Pipeline() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  const [pipelines, setPipelines] = useState([])
  const [activePipelineId, setActivePipelineId] = useState(null)
  const [deals, setDeals] = useState([])
  const [activeDragId, setActiveDragId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [newDealStage, setNewDealStage] = useState(null)
  const [error, setError] = useState(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  useEffect(() => {
    if (!session || !selectedProfileId) return
    setLoading(true)
    fetch(`/api/pipelines?profile_id=${selectedProfileId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((body) => {
        if (body.pipelines?.length) {
          setPipelines(body.pipelines)
          setActivePipelineId(body.pipelines[0].id)
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [session, selectedProfileId])

  useEffect(() => {
    if (!activePipelineId || !session) return
    fetch(`/api/deals?pipeline_id=${activePipelineId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((body) => setDeals(body.deals || []))
      .catch((e) => setError(e.message))
  }, [activePipelineId, session])

  const activePipeline = pipelines.find((p) => p.id === activePipelineId)
  const stages = activePipeline?.stages || []

  // Group deals by stage, preserving position order
  const byStage = useMemo(() => {
    const map = new Map(stages.map((s) => [s, []]))
    for (const d of deals) {
      if (!map.has(d.stage)) map.set(d.stage, [])
      map.get(d.stage).push(d)
    }
    for (const arr of map.values()) arr.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    return map
  }, [deals, stages])

  // Find a deal by id
  const findDeal = useCallback((id) => deals.find((d) => d.id === id), [deals])
  const findDealStage = useCallback((id) => {
    const d = findDeal(id)
    return d ? d.stage : null
  }, [findDeal])

  // ── drag handlers ───────────────────────────────────────────────────────
  const onDragStart = (e) => setActiveDragId(e.active.id)

  const onDragOver = (e) => {
    const { active, over } = e
    if (!over) return
    const activeId = active.id
    const overId = over.id

    const activeStage = findDealStage(activeId)
    const overStage = over.data?.current?.type === 'stage'
      ? over.data.current.stage
      : findDealStage(overId)

    if (!overStage || activeStage === overStage) return

    setDeals((prev) => prev.map((d) => d.id === activeId ? { ...d, stage: overStage } : d))
  }

  const onDragEnd = async (e) => {
    setActiveDragId(null)
    const { active, over } = e
    if (!over || !session) return

    const dealId = active.id
    const deal = findDeal(dealId)
    if (!deal) return

    // Determine the destination stage
    const overStage = over.data?.current?.type === 'stage'
      ? over.data.current.stage
      : findDealStage(over.id)
    if (!overStage) return

    // Reorder within stage if dropping on another card
    if (over.data?.current?.type === 'deal' && over.id !== dealId) {
      const list = (byStage.get(overStage) || []).slice()
      const oldIdx = list.findIndex((d) => d.id === dealId)
      const newIdx = list.findIndex((d) => d.id === over.id)
      if (oldIdx >= 0 && newIdx >= 0) {
        const reordered = arrayMove(list, oldIdx, newIdx)
        setDeals((prev) => {
          const others = prev.filter((d) => d.stage !== overStage)
          return [...others, ...reordered.map((d, i) => ({ ...d, stage: overStage, position: i }))]
        })
      }
    } else {
      // Append to end of stage
      const list = (byStage.get(overStage) || []).filter((d) => d.id !== dealId)
      const position = list.length
      setDeals((prev) => prev.map((d) => d.id === dealId ? { ...d, stage: overStage, position } : d))
    }

    // Persist
    try {
      const finalDeal = (byStage.get(overStage) || []).find((d) => d.id === dealId)
      const finalPosition = finalDeal?.position ?? 0
      const r = await fetch(`/api/deals?id=${dealId}&action=move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ stage: overStage, position: finalPosition }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.error || 'Move failed')
      }
    } catch (e) {
      setError(e.message)
      // (Optional) refetch on error to recover from optimistic-state drift
    }
  }

  const handleAdd = (stage) => setNewDealStage(stage)
  const handleCreated = (deal) => {
    setDeals((prev) => [...prev, deal])
    setNewDealStage(null)
  }

  if (!selectedProfileId) {
    return <div className="card-flat fade-up" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      Pick a brand profile to manage its pipeline.
    </div>
  }
  if (loading) return <div className="card-flat" style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>

  const draggedDeal = activeDragId ? findDeal(activeDragId) : null

  return (
    <div className="fade-up">
      {error && (
        <div style={{ marginBottom: 12, padding: '10px 14px', background: 'var(--red-soft)', color: 'var(--red)', borderRadius: 10, fontSize: 13 }}>{error}</div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
      >
        <div style={board}>
          {stages.map((s, i) => (
            <StageColumn
              key={s}
              stage={s}
              color={STAGE_COLORS[i % STAGE_COLORS.length]}
              deals={byStage.get(s) || []}
              onAdd={handleAdd}
              onCardClick={() => {}}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {draggedDeal && (
            <div style={{
              ...card(false),
              cursor: 'grabbing',
              boxShadow: '0 16px 40px rgba(0,0,0,0.45)',
              transform: 'rotate(1.5deg)',
            }}>
              <DealCardBody deal={draggedDeal} />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {newDealStage && (
        <NewDealModal
          pipelineId={activePipelineId}
          defaultStage={newDealStage}
          profileId={selectedProfileId}
          onClose={() => setNewDealStage(null)}
          onCreated={handleCreated}
        />
      )}
    </div>
  )
}
