// Spaces — node-based content workflow canvas. List view + builder.
// Built on @xyflow/react. Custom node renderer wraps each registered type
// in a ScaleSolo card, with input/output handles auto-derived from the
// registry.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ReactFlow, Controls, Background, Handle, Position, addEdge,
  applyNodeChanges, applyEdgeChanges, MarkerType, useReactFlow,
  BaseEdge, EdgeLabelRenderer, getSmoothStepPath,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { useAutosave } from '../lib/useAutosave.js'
import { useUndoRedo } from '../lib/useUndoRedo.js'
import {
  Plus, Play, Save, Trash2, ArrowLeft, Sparkles, Zap, Boxes, AlertCircle,
  GripHorizontal, Minimize2, Maximize2, Wand2, MessageSquare, Send,
  ZoomIn, ZoomOut, Maximize, Scissors, Download, X, History, Clock,
  CheckCircle2, XCircle, Square, Settings as SettingsIcon, Copy, Building2,
  BookOpen, ChevronLeft, ChevronRight, Lock, Globe, Bookmark, FileVideo,
  ShieldCheck, Undo2, Redo2,
} from 'lucide-react'
import { useRef } from 'react'
// (useEffect already imported above for other effects in this file)
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { useCredits, fmtCount } from '../context/CreditsContext.jsx'
import { useSpacesRun } from '../context/SpacesRunContext.jsx'
import { useNavigate } from 'react-router-dom'
import { toast, confirmDialog, chooseDialog } from '../components/Toast.jsx'
import {
  NODE_REGISTRY, NODE_CATEGORIES, downloadUrl, readImageItems,
  AUTORUN_OPTIONS, autoRunIntervalMs, NODE_COST_HINT,
  findUpstreamVideoUrl, findUpstreamScript, findUpstreamLogoUrl,
  findUpstreamAvatarPicker,
} from '../lib/space-nodes.jsx'

// Defensive deep-clone for run snapshots — JSON.parse(JSON.stringify(x))
// throws on circular refs (rare here, but a node injecting a DOM element
// into props could stall the runner). Falls back to a shallow snapshot.
function safeClone(value) {
  try { return JSON.parse(JSON.stringify(value)) }
  catch {
    if (value && typeof value === 'object') {
      return Array.isArray(value) ? value.slice() : { ...value }
    }
    return value
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom node renderer (one component for every registered type)

// Custom edge with scissors disconnect button. The button shows on hover
// of the edge area (we render an invisible thicker hit zone for stable hover).
function ScissorEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style }) {
  const [hover, setHover] = useState(false)
  const [edgePath, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={{ stroke: 'var(--red)', strokeWidth: 1.5, ...style }} />
      {/* Wider invisible hit area for stable hover */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{ cursor: 'pointer' }}
      />
      {hover && (
        <EdgeLabelRenderer>
          <div
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            onClick={(e) => {
              e.stopPropagation()
              if (typeof window !== 'undefined' && window.__spaceDisconnectEdge) {
                window.__spaceDisconnectEdge(id)
              }
            }}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
              cursor: 'pointer',
              background: 'var(--red)',
              color: '#fff',
              borderRadius: 999,
              width: 24, height: 24,
              display: 'grid', placeItems: 'center',
              boxShadow: '0 4px 10px rgba(0,0,0,0.4)',
              border: '2px solid var(--surface)',
            }}
            title="Disconnect"
          >
            <Scissors size={12} />
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

// Renamable node title — click to edit, blur or Enter to commit.
function NodeTitle({ id, fallback, value }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const commit = () => {
    setEditing(false)
    const v = (draft || '').trim() || fallback
    if (typeof window !== 'undefined' && window.__spacePatchNode) {
      window.__spacePatchNode(id, { __name: v })
    }
  }
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value); setEditing(false) } }}
        onClick={(e) => e.stopPropagation()}
        style={{
          fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12.5,
          background: 'var(--surface)', color: 'var(--text)',
          border: '1px solid var(--red)', borderRadius: 4, padding: '2px 6px',
          outline: 'none', minWidth: 100, flex: 1,
        }}
      />
    )
  }
  return (
    <div
      onDoubleClick={(e) => { e.stopPropagation(); setDraft(value); setEditing(true) }}
      title="Double-click to rename"
      style={{
        fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12.5,
        cursor: 'text', userSelect: 'none', padding: '2px 4px',
      }}
    >{value}</div>
  )
}

function SpaceNode({ id, data, selected }) {
  const def = NODE_REGISTRY[data.type]
  if (!def) return <div style={{ padding: 10, color: 'red' }}>Unknown node: {data.type}</div>
  const Body = def.Body
  const status = data.status || 'idle'
  const Icon = def.icon

  const head = {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 12px',
    background: 'var(--surface-2)',
    borderBottom: '1px solid var(--border)',
    borderTopLeftRadius: 11, borderTopRightRadius: 11,
  }
  const card = {
    width: 280,
    background: 'var(--surface)',
    border: selected
      ? `1px solid ${def.color || 'var(--red)'}`
      : (status === 'failed' ? '1px solid rgba(239,68,68,0.6)' : '1px solid var(--border)'),
    borderRadius: 12,
    boxShadow: selected ? '0 12px 30px rgba(0,0,0,0.45)' : '0 4px 14px rgba(0,0,0,0.18)',
    fontFamily: 'var(--font-body)',
    color: 'var(--text)',
  }
  const statusPill = {
    fontSize: 10, fontFamily: 'var(--font-display)', fontWeight: 700,
    letterSpacing: '0.06em', textTransform: 'uppercase',
    padding: '3px 7px', borderRadius: 999,
    background: status === 'done' ? 'rgba(46,204,113,0.16)'
      : status === 'running' ? 'rgba(245,158,11,0.16)'
      : status === 'failed' ? 'rgba(239,68,68,0.16)' : 'var(--surface-3)',
    color: status === 'done' ? '#2ecc71'
      : status === 'running' ? '#f59e0b'
      : status === 'failed' ? 'var(--red)' : 'var(--muted)',
  }

  // Use NODE_RENDER_CALLBACK from window to update the node (set during canvas render)
  const onPatch = (patch) => {
    if (typeof window !== 'undefined' && window.__spacePatchNode) {
      window.__spacePatchNode(id, patch)
    }
  }

  // Stack input handles on the left, output handles on the right — vertically.
  const inHandleSpacing = 100 / Math.max(def.inputs.length + 1, 2)
  const outHandleSpacing = 100 / Math.max(def.outputs.length + 1, 2)

  return (
    <div style={card}>
      {/* Inputs — drop-only (can't start a drag from here, no backward edges). */}
      {def.inputs.map((inp, i) => (
        <Handle
          key={`in-${inp.id}`}
          type="target"
          position={Position.Left}
          id={inp.id}
          title={inp.label}
          className="space-handle"
          isConnectableStart={false}
          style={{
            top: `${(i + 1) * inHandleSpacing}%`,
            background: def.color || 'var(--red)',
            width: 10, height: 10,
            border: '2px solid var(--surface)',
          }}
        >
          <span className="space-handle-tag" style={{
            position: 'absolute', left: 14, top: -6,
            fontSize: 8.5, color: 'var(--muted)',
            fontFamily: 'var(--font-display)', fontWeight: 700,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            pointerEvents: 'none',
          }}>in</span>
        </Handle>
      ))}

      {/* Outputs — drag-only source. Cannot be dropped onto. */}
      {def.outputs.map((out, i) => (
        <Handle
          key={`out-${out.id}`}
          type="source"
          position={Position.Right}
          id={out.id}
          title={out.label}
          className="space-handle"
          isConnectableEnd={false}
          style={{
            top: `${(i + 1) * outHandleSpacing}%`,
            background: def.color || 'var(--red)',
            width: 10, height: 10,
            border: '2px solid var(--surface)',
          }}
        >
          <span className="space-handle-tag" style={{
            position: 'absolute', right: 14, top: -6,
            fontSize: 8.5, color: 'var(--muted)',
            fontFamily: 'var(--font-display)', fontWeight: 700,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            pointerEvents: 'none',
          }}>out</span>
        </Handle>
      ))}

      <div style={head}>
        <div style={{ width: 24, height: 24, borderRadius: 6, background: def.color || 'var(--red)', color: '#fff', display: 'grid', placeItems: 'center' }}>
          <Icon size={13} />
        </div>
        <NodeTitle id={id} fallback={def.label} value={data.name || def.label} />
        {/* Collection is purely a passive aggregator — no Run button. It
            picks up new items automatically when upstream nodes finish. */}
        {def.Editor && (
          <button
            type="button"
            className="nodrag"
            title="Open settings drawer"
            onClick={(e) => { e.stopPropagation(); window.__spaceOpenEditor?.(id) }}
            style={{
              background: 'transparent', border: 'none',
              color: 'var(--muted)', cursor: 'pointer',
              padding: 4, borderRadius: 4, display: 'grid', placeItems: 'center',
              marginLeft: 'auto',
            }}
          ><SettingsIcon size={12} /></button>
        )}
        {/* Hide the Run button on pure data emitters — input nodes with
            no upstream work to re-execute. Clicking Run on these is a
            no-op that just re-emits cached data, which confused users
            who expected something to happen. The runner already
            auto-executes free emitters when downstream nodes need them.
            auto_run is the exception: its Run button toggles the
            scheduler state. collection is passive too. */}
        {data.type !== 'collection' && data.type !== 'text_input'
          && !((!def.inputs || def.inputs.length === 0) && data.type !== 'auto_run') && (
          <button
            type="button"
            className="nodrag space-node-runbtn"
            title={status === 'running' ? 'Stop run' : 'Run this node'}
            onClick={async (e) => {
              e.stopPropagation()
              if (status === 'running') { window.__spaceAbortRun?.(); return }
              const choice = await window.__spaceChooseRunScope?.(id)
              if (!choice) return
              window.__spaceRunFromNode?.(id, choice)
            }}
            style={{
              marginLeft: 'auto',
              background: status === 'running'
                ? 'rgba(239,68,68,0.18)'
                : 'linear-gradient(135deg, rgba(46,204,113,0.18), rgba(46,204,113,0.10))',
              border: `1px solid ${status === 'running' ? 'rgba(239,68,68,0.45)' : 'rgba(46,204,113,0.45)'}`,
              color: status === 'running' ? 'var(--red)' : '#2ecc71',
              cursor: 'pointer',
              padding: '5px 10px', borderRadius: 6,
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11,
              letterSpacing: '0.04em', textTransform: 'uppercase',
              transition: 'transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease',
              boxShadow: status === 'running' ? '0 0 0 0 rgba(239,68,68,0)' : '0 1px 2px rgba(0,0,0,0.10)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)'
              e.currentTarget.style.filter = 'brightness(1.1)'
              e.currentTarget.style.boxShadow = status === 'running'
                ? '0 4px 12px rgba(239,68,68,0.30)'
                : '0 4px 12px rgba(46,204,113,0.32)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)'
              e.currentTarget.style.filter = 'brightness(1)'
              e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.10)'
            }}
          >
            {status === 'running' ? <Square size={11} /> : <Play size={12} />}
            {status === 'running' ? 'Stop' : 'Run'}
          </button>
        )}
        <span style={{ ...statusPill, marginLeft: data.type === 'collection' ? 'auto' : 0 }}>{status}</span>
      </div>
      <div style={{ padding: 12 }}>
        <Body data={{ ...data, __id: id }} onPatch={onPatch} />
      </div>
    </div>
  )
}

// (autosave fingerprint helper now lives in src/lib/useAutosave.js)

const NODE_TYPES = { space: SpaceNode }
const EDGE_TYPES = { scissor: ScissorEdge }

// With the simplified handle scheme there's just one "in" handle (and an
// optional "ref" handle on image_gen / avatar_render). Validation is just:
// no self-loops, source must be 'out', target must be 'in' or 'ref'.
function isValidSpaceConnection(conn) {
  if (!conn?.source || !conn?.target) return false
  if (conn.source === conn.target) return false
  if (conn.sourceHandle && conn.sourceHandle !== 'out') return false
  if (conn.targetHandle && conn.targetHandle !== 'in') return false
  return true
}

// Old saved spaces used per-field handle ids (topic, brand, script, ref, etc.).
// Normalize all edges to the simplified 'out' → 'in' scheme.
function normalizeEdgeHandles(e) {
  return { ...e, sourceHandle: 'out', targetHandle: 'in' }
}

// ─────────────────────────────────────────────────────────────────────────────
// List view

// ── Right-side settings drawer for nodes that opt-in via def.Editor ───────
function NodeEditorDrawer({ title, color, icon: Icon, onClose, children }) {
  // Esc closes.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: 'min(420px, 100vw)',
        zIndex: 90,
        background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        boxShadow: '-12px 0 36px rgba(0,0,0,0.45)',
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '14px 16px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface-2)',
      }}>
        <div style={{
          width: 26, height: 26, borderRadius: 6,
          background: color || 'var(--red)',
          color: '#fff', display: 'grid', placeItems: 'center',
        }}>{Icon && <Icon size={14} />}</div>
        <div style={{ flex: 1, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14 }}>{title}</div>
        <button
          onClick={onClose}
          style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4 }}
          title="Close (Esc)"
        ><X size={16} /></button>
      </div>
      <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
        {children}
      </div>
    </div>
  )
}

// ── Run history modal — recent runs of one space ───────────────────────────
// ── Duplicate space modal — pick a target brand profile (same one for an
//    in-place copy, or any other profile the user has access to). The
//    server scrubs avatar / look / watermark refs when crossing profiles
//    so the clone doesn't carry stale ids that wouldn't resolve.
function DuplicateSpaceModal({ space, profiles, currentProfileId, token, onClose, onDone }) {
  const [name, setName] = useState(`${space?.name || 'Space'} (copy)`)
  const [targetId, setTargetId] = useState(currentProfileId)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const submit = async () => {
    if (!targetId) return
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/spaces?action=duplicate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source_id: space.id, target_profile_id: targetId, name: name.trim() || undefined }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error || `Duplicate failed (${r.status})`)
      const targetProfile = (profiles || []).find((p) => p.id === targetId)
      toast({
        kind: 'success',
        message: body.cross_profile
          ? `Copied to ${targetProfile?.business_name || 'other profile'}. Avatar / watermark refs were scrubbed — re-pick them in the clone.`
          : 'Workflow duplicated.',
      })
      onDone?.(body.space)
      onClose()
    } catch (e) { setErr(e.message) }
    finally { setBusy(false) }
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-sm" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <Copy size={18} style={{ color: 'var(--red)' }} />
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, flex: 1 }}>Duplicate space</h3>
          <button aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6, borderRadius: 6 }}><X size={18} /></button>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label className="label">New name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label className="label">Copy to brand profile</label>
          <select className="select" value={targetId || ''} onChange={(e) => setTargetId(e.target.value)}>
            {(profiles || []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.business_name || p.id.slice(0, 8)}
                {p.id === currentProfileId ? ' (this one)' : ''}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, lineHeight: 1.4 }}>
            <Building2 size={11} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            Cloning across profiles strips avatar / watermark refs (they don't carry over). Auto-run is reset to inactive in every clone.
          </div>
        </div>
        {err && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy || !targetId}>
            {busy ? <span className="spinner" /> : <Copy size={13} />} Duplicate
          </button>
        </div>
      </div>
    </div>
  )
}

function RunHistoryModal({ spaceId, token, onClose }) {
  const [runs, setRuns] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    if (!spaceId) { setRuns([]); return }
    fetch(`/api/spaces/runs?space_id=${spaceId}&limit=30`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((b) => setRuns(Array.isArray(b.runs) ? b.runs : []))
      .catch((e) => setError(e.message))
  }, [spaceId, token])
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 80,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
        display: 'grid', placeItems: 'center', padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 720, maxHeight: '82vh',
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 14, boxShadow: 'var(--shadow-pop)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <History size={16} style={{ color: 'var(--red)' }} />
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700, flex: 1 }}>Run history</h3>
          <button aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6, borderRadius: 6 }}><X size={16} /></button>
        </div>
        <div style={{ padding: 14, overflowY: 'auto', flex: 1 }}>
          {!spaceId && <div style={{ color: 'var(--muted)', fontSize: 12.5, textAlign: 'center', padding: 30 }}>Save the space first to see history.</div>}
          {spaceId && runs == null && <div style={{ textAlign: 'center', padding: 30 }}><span className="spinner" /></div>}
          {error && <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 10 }}>{error}</div>}
          {runs && runs.length === 0 && (
            <div style={{ color: 'var(--muted)', fontSize: 12.5, textAlign: 'center', padding: 30 }}>No runs yet — hit Run to start one.</div>
          )}
          {runs && runs.map((r) => {
            const Icon = r.status === 'success' ? CheckCircle2 : r.status === 'failed' ? XCircle : Clock
            const color = r.status === 'success' ? '#2ecc71' : r.status === 'failed' ? 'var(--red)' : r.status === 'partial' ? 'var(--amber)' : 'var(--muted)'
            const errs = Array.isArray(r.errors) ? r.errors : []
            return (
              <div key={r.id} style={{
                padding: '10px 12px', marginBottom: 8,
                background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Icon size={14} style={{ color }} />
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color }}>
                    {r.status}
                  </div>
                  <div style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>{new Date(r.started_at).toLocaleString()}</div>
                  {r.duration_ms != null && (
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{(r.duration_ms / 1000).toFixed(1)}s</div>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-soft)' }}>
                  {r.node_count} node{r.node_count === 1 ? '' : 's'} · trigger: {r.triggered_by || 'manual'}
                </div>
                {errs.length > 0 && (
                  <div style={{ marginTop: 6, padding: '6px 8px', background: 'rgba(239,68,68,0.08)', borderRadius: 6, fontSize: 11, color: 'var(--red)', whiteSpace: 'pre-wrap' }}>
                    {errs.map((e, i) => <div key={i}>{e.nodeId ? `${e.nodeId}: ` : ''}{e.msg}</div>)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── New space modal ────────────────────────────────────────────────────────
// Lets the user start from a blank canvas or clone any template they can
// see (curated public templates + private templates they saved themselves).
function NewSpaceModal({ profileId, token, onClose, onPicked }) {
  const [templates, setTemplates] = useState(null)  // null = loading
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [userTier, setUserTier] = useState(null)
  const [upsellTpl, setUpsellTpl] = useState(null)
  const [categoryFilter, setCategoryFilter] = useState('all')
  const navigate = useNavigate()

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [tplR, billR] = await Promise.all([
          fetch('/api/spaces?action=templates',  { headers: { Authorization: `Bearer ${token}` } }),
          fetch('/api/billing',                  { headers: { Authorization: `Bearer ${token}` } }),
        ])
        const tplBody = await tplR.json()
        const billBody = await billR.json().catch(() => ({}))
        if (!alive) return
        if (!tplR.ok) throw new Error(tplBody.error || `Failed (${tplR.status})`)
        setTemplates(tplBody.templates || [])
        // Active subscription tier drives plan-gate enforcement on the
        // user-facing template picker. /api/billing returns the most-
        // recent subscription for the current user. Anything that isn't
        // active/trialing/past_due → null (free / no plan).
        const sub = billBody?.subscription
        const tier = sub && ['active', 'trialing', 'past_due'].includes(sub.status) ? sub.tier : null
        setUserTier(tier || null)
      } catch (e) { if (alive) { setError(e.message); setTemplates([]) } }
    })()
    return () => { alive = false }
  }, [token])

  // Returns true when the user's current tier allows cloning this
  // template. Empty/null gate = free for everyone.
  const isGated = (tpl) => {
    const gate = Array.isArray(tpl.template_plan_gate) ? tpl.template_plan_gate.filter(Boolean) : []
    if (gate.length === 0) return false
    return !userTier || !gate.includes(userTier)
  }

  const useTemplate = async (tpl) => {
    if (!profileId) { setError('Pick a brand profile first.'); return }
    if (isGated(tpl)) { setUpsellTpl(tpl); return }
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/spaces?action=use_template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ template_id: tpl.id, target_profile_id: profileId }),
      })
      const body = await r.json()
      if (r.status === 402 && body?.code === 'plan_gate') {
        setUpsellTpl({ ...tpl, _required: body.required_tiers || [] })
        setBusy(false)
        return
      }
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      onPicked({ kind: 'template', space: body.space, guide: body.template_guide || tpl.template_guide || null })
    } catch (e) { setError(e.message); setBusy(false) }
  }

  const startBlank = () => onPicked({ kind: 'blank' })

  // Sort by admin-set sort_order (ascending), then most-recently-updated.
  const tplSort = (a, b) => {
    const sa = Number.isFinite(a.template_sort_order) ? a.template_sort_order : 100
    const sb = Number.isFinite(b.template_sort_order) ? b.template_sort_order : 100
    if (sa !== sb) return sa - sb
    return new Date(b.updated_at || 0) - new Date(a.updated_at || 0)
  }
  const filterByCategory = (list) => categoryFilter === 'all'
    ? list
    : list.filter((t) => (t.template_category || '') === categoryFilter)
  const publicTemplates  = filterByCategory((templates || []).filter((t) => t.template_visibility === 'public')).sort(tplSort)
  const privateTemplates = filterByCategory((templates || []).filter((t) => t.template_visibility === 'private')).sort(tplSort)
  // Distinct categories (across all visible templates) for the filter row.
  const allCategories = Array.from(new Set(
    (templates || []).filter((t) => t.template_category).map((t) => t.template_category)
  )).sort()

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal-card modal-card-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <Plus size={18} style={{ color: 'var(--red)' }} />
          <h3 style={{ flex: 1, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 17 }}>New space</h3>
          <button aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6, borderRadius: 6 }}><X size={18} /></button>
        </div>
        {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{error}</div>}

        <div
          role="button" tabIndex={0}
          onClick={startBlank}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startBlank() } }}
          style={{
            cursor: busy ? 'wait' : 'pointer',
            border: '1px dashed var(--border)', borderRadius: 12,
            padding: 14, display: 'flex', alignItems: 'center', gap: 12,
            marginBottom: 16, background: 'var(--surface)',
          }}
        >
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--surface-2)', display: 'grid', placeItems: 'center' }}>
            <Boxes size={16} style={{ color: 'var(--muted)' }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14 }}>Blank space</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Start from an empty canvas.</div>
          </div>
          <ChevronRight size={14} style={{ color: 'var(--muted)' }} />
        </div>

        <div style={{ fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
          Start from a template
        </div>
        {allCategories.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {[{ k: 'all', l: `All (${(templates || []).length})` }, ...allCategories.map((c) => ({ k: c, l: c }))].map((opt) => (
              <button
                key={opt.k}
                type="button"
                onClick={() => setCategoryFilter(opt.k)}
                style={{
                  fontSize: 11.5, padding: '5px 10px', borderRadius: 999,
                  fontWeight: 600,
                  background: categoryFilter === opt.k ? 'rgba(239,68,68,0.18)' : 'var(--surface-2)',
                  border: `1px solid ${categoryFilter === opt.k ? 'rgba(239,68,68,0.5)' : 'var(--border)'}`,
                  color: categoryFilter === opt.k ? 'var(--text)' : 'var(--text-soft)',
                  cursor: 'pointer',
                }}
              >
                {opt.l}
              </button>
            ))}
          </div>
        )}
        {templates === null ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}><span className="spinner" /></div>
        ) : (templates.length === 0 ? (
          <div style={{ padding: 18, color: 'var(--muted)', fontSize: 13, textAlign: 'center', border: '1px solid var(--border)', borderRadius: 10 }}>
            No templates yet. Save any space as a template from inside the builder.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {[
              { key: 'public',  label: 'Default templates', icon: Globe, list: publicTemplates },
              { key: 'private', label: 'Your templates',    icon: Lock,  list: privateTemplates },
            ].filter((g) => g.list.length).map((group) => (
              <div key={group.key}>
                <div style={{ fontSize: 10.5, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <group.icon size={11} /> {group.label} <span style={{ opacity: 0.7 }}>({group.list.length})</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
                  {group.list.map((tpl) => {
                    const gated = isGated(tpl)
                    const gateTiers = Array.isArray(tpl.template_plan_gate) ? tpl.template_plan_gate.filter(Boolean) : []
                    return (
                    <div
                      key={tpl.id}
                      role="button" tabIndex={0}
                      onClick={() => !busy && useTemplate(tpl)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); !busy && useTemplate(tpl) } }}
                      className="card"
                      style={{
                        cursor: busy ? 'wait' : 'pointer',
                        display: 'flex', alignItems: 'center', gap: 12, padding: 14,
                        opacity: gated ? 0.78 : 1,
                      }}
                    >
                      <div style={{ width: 36, height: 36, borderRadius: 10, background: tpl.template_visibility === 'public' ? 'rgba(239,68,68,0.10)' : 'var(--surface-2)', display: 'grid', placeItems: 'center' }}>
                        {gated
                          ? <Lock size={15} style={{ color: 'var(--amber)' }} />
                          : tpl.template_visibility === 'public'
                            ? <Globe size={15} style={{ color: 'var(--red)' }} />
                            : <Lock size={15} style={{ color: 'var(--muted)' }} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          {tpl.name}
                          {tpl.template_category && (
                            <span style={{
                              fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em',
                              padding: '2px 7px', borderRadius: 999,
                              background: 'rgba(245,158,11,0.16)', color: '#fbbf24',
                              border: '1px solid rgba(245,158,11,0.28)',
                              textTransform: 'uppercase',
                            }}>{tpl.template_category}</span>
                          )}
                          {gated && (
                            <span style={{
                              fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em',
                              padding: '2px 7px', borderRadius: 999,
                              background: 'rgba(245,158,11,0.18)', color: 'var(--amber)',
                              border: '1px solid rgba(245,158,11,0.4)',
                              textTransform: 'uppercase',
                            }}>
                              {gateTiers.length === 1 ? gateTiers[0].replace('solo_', '').replace('_', ' ') : 'paid'}
                            </span>
                          )}
                        </div>
                        {(tpl.template_summary || tpl.description) && (
                          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, lineHeight: 1.4 }}>
                            {tpl.template_summary || tpl.description}
                          </div>
                        )}
                      </div>
                      {Array.isArray(tpl.template_guide) && tpl.template_guide.length > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <BookOpen size={11} /> {tpl.template_guide.length} steps
                        </span>
                      )}
                      <ChevronRight size={14} style={{ color: 'var(--muted)' }} />
                    </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {upsellTpl && (
        <div
          className="modal-overlay"
          onClick={() => setUpsellTpl(null)}
          style={{ zIndex: 110 }}
        >
          <div className="modal-card modal-card-md" onClick={(e) => e.stopPropagation()} style={{ padding: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <Lock size={16} style={{ color: 'var(--amber)' }} />
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15 }}>Template requires an upgrade</div>
              <button onClick={() => setUpsellTpl(null)} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}>
                <X size={16} />
              </button>
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-soft)', lineHeight: 1.55, marginBottom: 14 }}>
              <strong style={{ color: 'var(--text)' }}>{upsellTpl.name}</strong> is available on:{' '}
              {(Array.isArray(upsellTpl.template_plan_gate) ? upsellTpl.template_plan_gate : [])
                .map((t) => t.replace('solo_', 'Solo ').replace(/^./, (c) => c.toUpperCase()))
                .join(', ')}.
              Upgrade your plan to clone this template into your workspace, or pick a free template instead.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn-ghost" onClick={() => setUpsellTpl(null)}>Maybe later</button>
              <button
                className="btn-primary"
                onClick={() => { setUpsellTpl(null); onClose?.(); navigate('/billing') }}
              >
                See plans
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Template guide side panel ──────────────────────────────────────────────
// Renders the ordered guide steps next to the canvas. Clicking a step
// highlights / pans to its node on the canvas. Mounted INSIDE <ReactFlow>
// so it can call useReactFlow() for setCenter.
function TemplateGuidePanel({ guide, nodes, onClose }) {
  const [collapsed, setCollapsed] = useState(false)
  const { setCenter } = useReactFlow()
  const steps = Array.isArray(guide) ? guide : []
  if (!steps.length) return null

  const jump = (nodeId) => {
    const node = (nodes || []).find((n) => n.id === nodeId)
    if (!node) return
    const w = node.measured?.width || node.width || 280
    const h = node.measured?.height || node.height || 200
    setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: 1, duration: 600 })
  }

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        title="Show workflow guide"
        style={{
          position: 'absolute', top: 14, right: 14, zIndex: 30,
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '8px 12px', borderRadius: 10,
          background: 'var(--surface)', border: '1px solid var(--border)',
          color: 'var(--text)', fontSize: 12.5, fontFamily: 'var(--font-display)', fontWeight: 600,
          cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
        }}
      >
        <BookOpen size={13} /> Guide ({steps.length})
      </button>
    )
  }

  return (
    <aside
      style={{
        position: 'absolute', top: 14, right: 14, bottom: 14, width: 340, zIndex: 30,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, boxShadow: '0 12px 40px rgba(0,0,0,0.12)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <BookOpen size={14} style={{ color: 'var(--red)' }} />
        <div style={{ flex: 1, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13 }}>Workflow guide</div>
        <button onClick={() => setCollapsed(true)} title="Collapse" style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4, borderRadius: 6 }}>
          <ChevronRight size={14} />
        </button>
        {onClose && (
          <button onClick={onClose} title="Hide guide" style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4, borderRadius: 6 }}>
            <X size={14} />
          </button>
        )}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 14px 14px' }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.5 }}>
          Each step matches a node on the canvas. Click a step to jump to its node.
        </div>
        {steps.map((s, i) => (
          <div
            key={s.node_id || i}
            role="button" tabIndex={0}
            onClick={() => jump(s.node_id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(s.node_id) } }}
            style={{
              padding: '10px 12px', borderRadius: 10, marginBottom: 8,
              border: '1px solid var(--border)', background: 'var(--surface-2)',
              cursor: 'pointer',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{
                display: 'inline-grid', placeItems: 'center',
                width: 22, height: 22, borderRadius: 999,
                background: 'var(--red)', color: '#fff',
                fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700,
              }}>{s.step ?? i + 1}</span>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13 }}>{s.title || s.node_type || 'Step'}</div>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.5 }}>{s.body}</div>
          </div>
        ))}
      </div>
    </aside>
  )
}

// Slim credits pill for the SpaceBuilder toolbar. Shows AI tokens +
// video units side-by-side. Each pool turns red at <10% of grant so
// the user has a visual that something's about to fail. Clicking goes
// to /billing.
function SpaceCreditsPill() {
  const navigate = useNavigate()
  const { pools } = useCredits()
  const tokens = pools?.ai_tokens?.balance ?? 0
  const tokensGrant = pools?.ai_tokens?.monthly_grant ?? 0
  const videos = pools?.video_units?.balance ?? 0
  const videosGrant = pools?.video_units?.monthly_grant ?? 0
  const tokensLow = tokensGrant > 0 && tokens < tokensGrant * 0.1
  const videosLow = videosGrant > 0 && videos < videosGrant * 0.1
  const anyLow = tokensLow || videosLow
  const anyEmpty = tokens === 0 || videos === 0

  return (
    <button
      onClick={() => navigate('/billing')}
      title="Click for billing details"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        height: 30, padding: '0 10px', borderRadius: 8,
        background: anyEmpty ? 'rgba(239,68,68,0.12)' : 'var(--surface)',
        border: `1px solid ${anyEmpty ? 'rgba(239,68,68,0.45)' : anyLow ? 'rgba(245,158,11,0.45)' : 'var(--border)'}`,
        color: 'var(--text)', cursor: 'pointer',
        fontFamily: 'var(--font-display)', fontSize: 11.5,
      }}
    >
      <Sparkles size={11} style={{ color: tokensLow ? 'var(--red)' : 'var(--red)' }} strokeWidth={2.4} />
      <span style={{ color: tokensLow ? 'var(--red)' : 'var(--text)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        {fmtCount(tokens)}
      </span>
      <span style={{ color: 'var(--muted)', fontWeight: 600 }}>tokens</span>
      <span style={{ width: 1, height: 14, background: 'var(--border)' }} />
      <FileVideo size={11} style={{ color: videosLow ? 'var(--red)' : '#f59e0b' }} strokeWidth={2.4} />
      <span style={{ color: videosLow ? 'var(--red)' : 'var(--text)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        {fmtCount(videos)}
      </span>
      <span style={{ color: 'var(--muted)', fontWeight: 600 }}>video</span>
    </button>
  )
}

function SpacesList({ spaces, onCreate, onOpen, onDelete, onHistory, onDuplicate, error, token, profileId, onTemplatePicked }) {
  const [tab, setTab] = useState('mine')
  const [templates, setTemplates] = useState(null)
  const [tplError, setTplError] = useState(null)
  const [busyTplId, setBusyTplId] = useState(null)

  // Lazy-load templates the first time the user clicks the tab.
  useEffect(() => {
    if (tab !== 'templates' || templates !== null || !token) return
    let alive = true
    ;(async () => {
      try {
        const r = await fetch('/api/spaces?action=templates', { headers: { Authorization: `Bearer ${token}` } })
        const body = await r.json()
        if (!alive) return
        if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
        setTemplates(body.templates || [])
      } catch (e) {
        if (alive) { setTplError(e.message); setTemplates([]) }
      }
    })()
    return () => { alive = false }
  }, [tab, templates, token])

  const useTemplate = async (tpl) => {
    if (!profileId || !token) { setTplError('Pick a brand profile first.'); return }
    setBusyTplId(tpl.id); setTplError(null)
    try {
      const r = await fetch('/api/spaces?action=use_template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ template_id: tpl.id, target_profile_id: profileId }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      onTemplatePicked?.(body.space, body.template_guide || tpl.template_guide || null)
    } catch (e) {
      setTplError(e.message)
    } finally {
      setBusyTplId(null)
    }
  }

  const fmtUpdated = (iso) => {
    if (!iso) return ''
    const d = new Date(iso)
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  }

  const tabBtn = (key, label) => (
    <button
      key={key}
      onClick={() => setTab(key)}
      style={{
        padding: '7px 14px', borderRadius: 8, fontSize: 13,
        fontFamily: 'var(--font-display)', fontWeight: 600,
        background: tab === key ? 'linear-gradient(135deg, var(--red), var(--red-dark))' : 'transparent',
        color: tab === key ? '#fff' : 'var(--text-soft)',
        border: tab === key ? 'none' : '1px solid var(--border)',
        cursor: 'pointer',
      }}
    >{label}</button>
  )

  return (
    <div className="fade-up">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14, gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, marginRight: 6 }}>Spaces</h2>
        <div style={{ display: 'inline-flex', gap: 6, background: 'var(--surface-2)', borderRadius: 10, padding: 4 }}>
          {tabBtn('mine', `Your spaces${spaces?.length ? ` (${spaces.length})` : ''}`)}
          {tabBtn('templates', `Templates${templates ? ` (${templates.length})` : ''}`)}
        </div>
        <div style={{ flex: 1 }} />
        {tab === 'mine' && <button className="btn-primary" onClick={onCreate}><Plus size={14} /> New space</button>}
      </div>
      {tab === 'mine' && error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>{error}</div>}
      {tab === 'templates' && tplError && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>{tplError}</div>}

      {tab === 'templates' ? (
        templates === null ? (
          <div className="card-flat" style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
        ) : templates.length === 0 ? (
          <div className="card-flat" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
            No templates available yet.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
            {templates.map((t) => (
              <div
                key={t.id}
                className="card"
                role="button" tabIndex={0}
                onClick={() => !busyTplId && useTemplate(t)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); !busyTplId && useTemplate(t) } }}
                style={{ cursor: busyTplId ? 'wait' : 'pointer' }}
                aria-label={`Use template ${t.name}`}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                  {t.template_visibility === 'public'
                    ? <Globe size={16} style={{ color: 'var(--red)' }} />
                    : <Lock size={16} style={{ color: 'var(--muted)' }} />}
                  {t.template_category && (
                    <span style={{
                      fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9.5,
                      letterSpacing: '0.04em', padding: '2px 7px', borderRadius: 999,
                      background: 'rgba(99,102,241,0.16)', color: '#a5b4fc',
                      textTransform: 'uppercase',
                    }}>{t.template_category}</span>
                  )}
                </div>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{t.name}</div>
                {t.template_summary && (
                  <div style={{ fontSize: 12.5, color: 'var(--text-soft)', marginBottom: 8, lineHeight: 1.5 }}>
                    {String(t.template_summary).slice(0, 160)}
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Updated {fmtUpdated(t.updated_at)}</div>
                <div style={{ marginTop: 12 }}>
                  <button
                    className="btn-secondary"
                    style={{ padding: '6px 12px', fontSize: 12 }}
                    disabled={!!busyTplId}
                    onClick={(e) => { e.stopPropagation(); useTemplate(t) }}
                  >
                    {busyTplId === t.id ? <span className="spinner" /> : <><Copy size={12} /> Use template</>}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )
      ) : spaces.length === 0 ? (
        <div className="card-flat" style={{ padding: 50, textAlign: 'center', color: 'var(--muted)' }}>
          <Boxes size={28} style={{ marginBottom: 12 }} />
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)', marginBottom: 6 }}>No spaces yet</div>
          <div style={{ fontSize: 13, marginBottom: 22, lineHeight: 1.5, maxWidth: 460, margin: '0 auto 22px' }}>
            A space is a visual workflow. Drop nodes (script gen, avatar render, captions, hashtags, save), wire them together, hit Run, and the whole pipeline executes.
          </div>
          <button className="btn-primary" onClick={onCreate}><Plus size={15} /> Create your first space</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
          {spaces.map((s) => (
            <div
              key={s.id} className="card"
              role="button" tabIndex={0}
              aria-label={`Open space ${s.name || 'untitled'}`}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(s) } }}
              style={{ cursor: 'pointer' }}
              onClick={() => onOpen(s)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                <Boxes size={16} style={{ color: 'var(--red)' }} />
                {s.is_template && (
                  <span style={{
                    fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9.5,
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    padding: '2px 7px', borderRadius: 999,
                    background: 'rgba(46,204,113,0.16)', color: '#2ecc71',
                    border: '1px solid rgba(46,204,113,0.4)',
                  }}>Template</span>
                )}
                {s.template_category && (
                  <span style={{
                    fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9.5,
                    letterSpacing: '0.04em',
                    padding: '2px 7px', borderRadius: 999,
                    background: 'rgba(99,102,241,0.16)', color: '#a5b4fc',
                  }}>{s.template_category}</span>
                )}
              </div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{s.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Updated {fmtUpdated(s.updated_at)}</div>
              {s.created_at && (
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Created {fmtUpdated(s.created_at)}</div>
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
                <button className="btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }} onClick={(e) => { e.stopPropagation(); onHistory?.(s) }}>
                  <History size={12} /> History
                </button>
                <button className="btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }} onClick={(e) => { e.stopPropagation(); onDuplicate?.(s) }}>
                  <Copy size={12} /> Duplicate
                </button>
                <button className="btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }} onClick={(e) => { e.stopPropagation(); onDelete(s) }}>
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Floating, draggable, minimizable node palette

// ─────────────────────────────────────────────────────────────────────────────
// Zoom controls (bottom-left). Custom-styled +/- + fit-view.

function ZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  return (
    <div className="space-zoom-controls">
      <button type="button" onClick={() => zoomIn({ duration: 200 })} title="Zoom in" aria-label="Zoom in">
        <ZoomIn size={16} />
      </button>
      <button type="button" onClick={() => zoomOut({ duration: 200 })} title="Zoom out" aria-label="Zoom out">
        <ZoomOut size={16} />
      </button>
      <button type="button" onClick={() => fitView({ duration: 300, padding: 0.2 })} title="Fit view" aria-label="Fit view">
        <Maximize size={14} />
      </button>
    </div>
  )
}

function FloatingPalette({ onAdd }) {
  const grouped = useMemo(() => {
    const g = {}
    for (const [key, def] of Object.entries(NODE_REGISTRY)) {
      // Legacy nodes still load on existing canvases (so old spaces
      // keep rendering), but they're hidden from the palette so users
      // can't drag them into new workflows. Polish + the all-in-one
      // 'Save to drafts' replace these.
      if (def.hidden) continue
      if (!g[def.category]) g[def.category] = []
      g[def.category].push({ key, def })
    }
    return g
  }, [])
  const categoryOrder = Object.entries(NODE_CATEGORIES).sort((a, b) => a[1].order - b[1].order)

  // The palette is fixed-positioned in viewport coords. Clamp its X bound
  // to the canvas area (right of the main sidebar) so it can't slide
  // underneath. We read the current sidebar width by checking the body
  // class App.jsx toggles per route.
  const sidebarLeftBound = () => {
    if (typeof document === 'undefined') return 0
    if (window.innerWidth < 901) return 0          // mobile: drawer
    return document.body.classList.contains('compact-sidebar') ? 60 : 240
  }
  const headerHeightBound = 60                      // toolbar height + small gap

  // Default: just inside the canvas, below the toolbar.
  const [pos, setPos] = useState(() => ({ x: sidebarLeftBound() + 16, y: headerHeightBound + 16 }))
  const [collapsed, setCollapsed] = useState(false)
  const dragRef = useRef(null)

  const clampPos = ({ x, y }, c = collapsed) => {
    const w = c ? 200 : 240
    const h = c ? 44 : 460
    const minX = sidebarLeftBound() + 8
    const maxX = window.innerWidth  - w - 8
    const minY = 8
    const maxY = window.innerHeight - h - 8
    return {
      x: Math.max(minX, Math.min(maxX, x)),
      y: Math.max(minY, Math.min(maxY, y)),
    }
  }

  // Re-clamp on viewport resize (e.g. user drags the window narrower).
  useEffect(() => {
    const onResize = () => setPos((p) => clampPos(p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [collapsed])

  const onPointerDown = (e) => {
    // Don't start a drag if the user clicked the minimize button.
    if (e.target.closest('button')) return
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY }
    const startPos = { ...pos }
    const move = (ev) => {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      setPos(clampPos({ x: startPos.x + dx, y: startPos.y + dy }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const cardStyle = {
    position: 'fixed', left: pos.x, top: pos.y,
    width: collapsed ? 200 : 240,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    boxShadow: '0 16px 36px rgba(0,0,0,0.45)',
    zIndex: 50,
    userSelect: 'none',
    overflow: 'hidden',
    transition: 'width 0.18s var(--ease)',
  }
  const headerStyle = {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 12px',
    background: 'var(--surface-2)',
    borderBottom: collapsed ? 'none' : '1px solid var(--border)',
    cursor: 'grab',
  }
  const bodyStyle = {
    padding: 10,
    maxHeight: 'min(60vh, 440px)',
    overflowY: 'auto',
  }

  return (
    <div ref={dragRef} style={cardStyle}>
      <div style={headerStyle} onPointerDown={onPointerDown}>
        <GripHorizontal size={14} style={{ color: 'var(--muted)' }} />
        <div style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text)' }}>Nodes</div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            const nextCollapsed = !collapsed
            setCollapsed(nextCollapsed)
            // Re-clamp with the new size in case the new dimensions push it offscreen.
            setPos((p) => clampPos(p, nextCollapsed))
          }}
          style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4 }}
          title={collapsed ? 'Expand' : 'Minimize'}
        >
          {collapsed ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
        </button>
      </div>
      {!collapsed && (
        <div style={bodyStyle}>
          {categoryOrder.map(([catKey, cat]) => (
            <div key={catKey} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>{cat.label}</div>
              {(grouped[catKey] || []).map(({ key, def }) => {
                const Icon = def.icon
                return (
                  <button
                    key={key}
                    onClick={() => onAdd(key)}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData('application/scalesolo-node', key); e.dataTransfer.effectAllowed = 'move' }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      width: '100%',
                      padding: '7px 10px', marginBottom: 4,
                      background: 'var(--surface-2)', border: '1px solid var(--border)',
                      borderRadius: 8, cursor: 'grab',
                      color: 'var(--text)', textAlign: 'left',
                      fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 600,
                      transition: 'border-color 0.12s ease',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = `${def.color}66` }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)' }}
                    title={def.description}
                  >
                    <div style={{ width: 22, height: 22, borderRadius: 5, background: def.color, color: '#fff', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                      <Icon size={12} />
                    </div>
                    {def.label}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder

function SpaceBuilder({ space, onSave, onClose }) {
  const { session, isAdmin } = useAuth()
  const { selectedProfileId, profiles } = useProfile()
  const { refresh: refreshCredits } = useCredits()

  const [name, setName] = useState(space.name || 'Untitled space')
  // Strip stale runtime fields when loading a saved space. A node saved
  // mid-run keeps status='running' which makes the UI think a run is
  // active forever (and Stop buttons appear without anything to stop).
  // Also drop ReactFlow's own transient props (selected/dragging) so the
  // canvas reopens in a clean state.
  const [nodes, setNodes] = useState(() => {
    const arr = Array.isArray(space.nodes) ? space.nodes : []
    return arr.map((n) => ({
      ...n,
      selected: false,
      dragging: false,
      data: {
        ...n.data,
        // Persisted status + output + error survive refresh so the user
        // can re-open a workflow and see the previous run's results
        // (videos, captions, etc.) instead of an empty canvas.
        // 'running' is the only transient we reset — it can't realistically
        // still be running across a refresh.
        status: n.data?.status === 'running' ? 'idle' : (n.data?.status || 'idle'),
        error: n.data?.status === 'running' ? null : (n.data?.error || null),
      },
    }))
  })
  const [edges, setEdges] = useState(
    Array.isArray(space.edges)
      ? space.edges.map((e) => ({ ...normalizeEdgeHandles(e), type: 'scissor' }))
      : []
  )
  // Run state lives in the SpacesRunProvider so navigating away from /spaces
  // doesn't kill an in-flight workflow. The local `running` flag and abort
  // ref now come from there; on remount we replay cached node patches via
  // getSnapshot() so the canvas catches up.
  const runCtx = useSpacesRun()
  const running = runCtx.running
  const runningRef = useRef(false)
  useEffect(() => { runningRef.current = running }, [running])
  // Local setError mirror for non-context errors (e.g. validation in run()).
  const setRunning = () => {} // no-op shim; context owns this
  // Refresh / close warning while a run is in flight. Doesn't block SPA route
  // changes — the user-visible header banner below is what catches those.
  useEffect(() => {
    if (!running) return
    const onBeforeUnload = (e) => {
      e.preventDefault()
      e.returnValue = ''
      return ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [running])
  const [skippedTicks, setSkippedTicks] = useState(0)
  // Abort flag now lives on the context — local ref points at it so all
  // existing reads of abortRunRef.current keep working.
  const abortRunRef = runCtx.abortRef
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Live id ref so autosave continues to PATCH the same row after the
  // initial POST (the original `space` prop never changes). Must live
  // on the SpaceBuilder so the run engine + history modal can also
  // read the current persisted id.
  const spaceIdRef = useRef(space.id || null)
  // Autosave: debounced 1.2s, AbortController-protected, skips first
  // render. Lives in src/lib/useAutosave.js so the autosave concerns
  // (debounce, dedupe, race control) stay out of the builder.
  const { autoStatus, save } = useAutosave({
    spaceIdRef,
    name, nodes, edges,
    session,
    profileId: selectedProfileId,
    onSave,
    setBusy,
    setError,
  })
  const [avatars, setAvatars] = useState([])
  const [publicAvatars, setPublicAvatars] = useState([])
  // AI workflow build
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiBuilding, setAiBuilding] = useState(false)
  const [previewItem, setPreviewItem] = useState(null)  // { url, type } for fullscreen preview
  const [historyOpen, setHistoryOpen] = useState(false)
  // Right-side settings drawer for nodes whose registry def declares an
  // `Editor` (currently video_polish). Holds the node id; null = closed.
  const [editingNodeId, setEditingNodeId] = useState(null)
  // Template guide carried by this space (populated when the space was
  // cloned from a template). Side panel renders these steps; user can hide.
  const [templateGuide, setTemplateGuide] = useState(() => {
    const g = space.template_guide
    return Array.isArray(g) && g.length ? g : null
  })
  const [guideHidden, setGuideHidden] = useState(false)
  const [savingAsTemplate, setSavingAsTemplate] = useState(false)
  // Connected social platforms for the active brand (refreshed when the
  // user picks a different brand). Drives which buttons in schedule_post
  // are enabled.
  const [connectedSocialPlatforms, setConnectedSocialPlatforms] = useState([])
  // Subscription state — drives the "free trial lock" overlay on
  // avatar_render and schedule_post. Trialing users get the full UI
  // but the run is blocked until they upgrade (we offer 20% off).
  const [subscriptionStatus, setSubscriptionStatus] = useState(null)  // 'trialing' | 'active' | 'past_due' | null

  // Ref mirrors of nodes/edges so global helpers don't read stale closures.
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  useEffect(() => { nodesRef.current = nodes }, [nodes])
  useEffect(() => { edgesRef.current = edges }, [edges])
  const [aiSuggestion, setAiSuggestion] = useState(null)

  // Undo / redo lives in src/lib/useUndoRedo.js. The hook owns the
  // history stacks + Cmd/Ctrl+Z keyboard wiring; pushHistory() must be
  // called BEFORE each user-initiated mutation (addNode, onConnect,
  // patch, drag-stop, removal) so the snapshot captures the prior state.
  const { pushHistory, undo, redo, canUndo, canRedo, pastCount, futureCount } =
    useUndoRedo({ nodesRef, edgesRef, setNodes, setEdges })

  // Load avatars (custom + HeyGen public library) so the AvatarPicker node
  // can list them. Also re-fetches whenever the tab regains focus / the
  // page becomes visible so a look added on the Avatars page shows up
  // here without a hard refresh — otherwise the picker dropdown holds the
  // stale list and selecting the "new" look silently misses.
  useEffect(() => {
    if (!session || !selectedProfileId) return
    let alive = true
    const loadAvatars = () => {
      fetch(`/api/avatars?profile_id=${selectedProfileId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
        .then((r) => r.json())
        .then((b) => { if (alive) setAvatars(b.avatars || []) })
        // eslint-disable-next-line no-console
        .catch((e) => console.warn('[Spaces] avatars load failed', e?.message || e))
    }
    loadAvatars()
    fetch(`/api/avatars/heygen-library?profile_id=${selectedProfileId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => { if (alive) setPublicAvatars(Array.isArray(b.groups) ? b.groups : []) })
      // eslint-disable-next-line no-console
      .catch((e) => console.warn('[Spaces] heygen library load failed', e?.message || e))

    const onVisible = () => { if (document.visibilityState === 'visible') loadAvatars() }
    const onFocus = () => loadAvatars()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [session, selectedProfileId])

  useEffect(() => {
    if (!session || !selectedProfileId) return
    // Connected social platforms — used by schedule_post to gate which
    // platform pills can be toggled.
    fetch(`/api/social/profiles?profile_id=${selectedProfileId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => {
        const social = b?.profile?.social_accounts || {}
        const connected = Object.entries(social)
          .filter(([, info]) => info && (info === true || info.access_token || info.connected || info.username))
          .map(([id]) => id)
        setConnectedSocialPlatforms(connected)
      })
      .catch(() => setConnectedSocialPlatforms([]))
  }, [session, selectedProfileId])

  // Pull current subscription status — used by the trial-lock overlay.
  useEffect(() => {
    if (!session) return
    fetch('/api/billing', { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then((r) => r.json())
      .then((b) => setSubscriptionStatus(b?.subscription?.status || null))
      .catch(() => setSubscriptionStatus(null))
  }, [session])

  // Wire the global helpers used by node bodies (cheap escape hatch that
  // beats threading state through every ReactFlow component).
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.__spacePatchNode = (id, patch) => {
      // UI prop edits invalidate the changed node's cached run only.
      // Downstream cache invalidation is handled at run time inside
      // runSpace by comparing each ancestor's new output to its prior
      // output — that way "Run this node only" really does only run
      // this node when nothing material upstream changed. Pure renames
      // (just __name) and internal context injections (_ctx*) don't
      // invalidate at all.
      // edited_* props are user UI overrides on AI-generated output (e.g.
      // edited_caption on caption_gen). They MUST NOT invalidate the
      // node's cache — clearing `output` mid-edit makes the editor itself
      // disappear (the body only renders when hasOutput is truthy), which
      // showed up to users as "the node resets when I press backspace".
      // _ctx* are render-time context injected by the parent; same rule.
      const hasRealPropChange = Object.keys(patch).some((k) =>
        k !== '__name' && !k.startsWith('_ctx') && !k.startsWith('edited_')
      )
      setNodes((arr) => arr.map((n) => {
        if (n.id !== id) return n
        if (Object.prototype.hasOwnProperty.call(patch, '__name')) {
          const { __name, ...rest } = patch
          const nextData = { ...n.data, name: __name, props: { ...(n.data?.props || {}), ...rest } }
          if (hasRealPropChange) { nextData.status = 'idle'; nextData.output = null; nextData.error = null }
          return { ...n, data: nextData }
        }
        const nextData = { ...n.data, props: { ...(n.data?.props || {}), ...patch } }
        if (hasRealPropChange) { nextData.status = 'idle'; nextData.output = null; nextData.error = null }
        return { ...n, data: nextData }
      }))
    }
    // Replace data.output (used by hover-action delete buttons on MediaItem).
    window.__spacePatchOutput = (id, output) => {
      setNodes((arr) => arr.map((n) => n.id === id ? { ...n, data: { ...n.data, output } } : n))
    }
    window.__spaceDisconnectEdge = (edgeId) => {
      setEdges((arr) => arr.filter((e) => e.id !== edgeId))
    }
    window.__spaceOpenPreview = (item) => setPreviewItem(item)
    window.__spaceOpenEditor = (id) => setEditingNodeId(id)
    // Brand-profile sync-to-all: connect (or disconnect) this brand node's
    // "brand" output to every node that has a "brand" input.
    window.__spaceSyncBrandAll = (brandId, enabled) => {
      setEdges((prev) => {
        // Tear down ANY edge that originates from this brand node — sync mode
        // owns its outgoing edges.
        const filtered = prev.filter((e) => e.source !== brandId)
        if (!enabled) return filtered
        const targets = nodesRef.current.filter((n) => {
          if (n.id === brandId) return false
          return ['script_gen', 'caption_gen', 'image_gen'].includes(n.data?.type)
        })
        const newEdges = targets.map((t) => ({
          id: `e_${brandId}_${t.id}_brand`,
          source: brandId, sourceHandle: 'out',
          target: t.id, targetHandle: 'in',
          type: 'scissor',
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: 'var(--red)', strokeWidth: 1.5 },
        }))
        const haveKeys = new Set(filtered.map((e) => `${e.source}|${e.target}|${e.targetHandle}`))
        const additions = newEdges.filter((e) => !haveKeys.has(`${e.source}|${e.target}|${e.targetHandle}`))
        return [...filtered, ...additions]
      })
    }
    window.__spaceAddNodeFromItem = ({ url, type, from }) => {
      if (!url) return
      // Image → image_upload pre-loaded with this URL. Video / other → text_input.
      const isImage = type === 'image'
      const id = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      const baseX = 80 + Math.floor(Math.random() * 400)
      const baseY = 80 + Math.floor(Math.random() * 200)
      const node = isImage
        ? { id, type: 'space', position: { x: baseX, y: baseY }, data: { type: 'image_upload', name: from || 'Image', props: { urls: [url] }, status: 'idle', output: null, error: null } }
        : { id, type: 'space', position: { x: baseX, y: baseY }, data: { type: 'text_input', name: from || 'Media', props: { text: url }, status: 'idle', output: null, error: null } }
      setNodes((arr) => [...arr, node])
    }
    return () => {
      window.__spacePatchNode = null
      window.__spacePatchOutput = null
      window.__spaceDisconnectEdge = null
      window.__spaceOpenPreview = null
      window.__spaceOpenEditor = null
      window.__spaceAddNodeFromItem = null
      window.__spaceSyncBrandAll = null
    }
  }, [])

  const onNodesChange = useCallback((changes) => {
    // Snapshot before discrete events: removals and the start of a drag.
    // Pure 'select' / 'dimensions' / continuous 'position' (mid-drag)
    // changes are skipped — otherwise undo would just replay every pixel.
    const significant = changes.some((c) => c.type === 'remove' || (c.type === 'position' && c.dragging === false))
    if (significant) pushHistory()
    setNodes((nds) => applyNodeChanges(changes, nds))
  }, [pushHistory])
  const onEdgesChange = useCallback((changes) => {
    if (changes.some((c) => c.type === 'remove')) pushHistory()
    setEdges((eds) => applyEdgeChanges(changes, eds))
  }, [pushHistory])
  const onConnect = useCallback((c) => {
    pushHistory()
    setEdges((eds) => addEdge({ ...c, type: 'scissor', markerEnd: { type: MarkerType.ArrowClosed }, animated: true, style: { stroke: 'var(--red)', strokeWidth: 1.5 } }, eds))
    // Auto-thread cached output: if the user just wired a cached
    // upstream node into a FREE aggregator (Collection / Combine /
    // save_library / brand / text / audio_upload / image_upload /
    // avatar_picker), run the target right away so its body fills in
    // without the user having to click play. We restrict this to free
    // nodes so wiring into an expensive node (avatar_render, polish,
    // schedule_post) never burns credits unprompted.
    setTimeout(() => {
      const liveNodes = nodesRef.current
      const src = liveNodes.find((n) => n.id === c.source)
      const tgt = liveNodes.find((n) => n.id === c.target)
      if (!src || !tgt) return
      const tgtDef = NODE_REGISTRY[tgt.data?.type]
      if (!tgtDef?.free) return
      const sourceCached = src.data?.status === 'done' && src.data?.output
      if (!sourceCached) return
      // self_only — only the freshly-connected target re-runs, every
      // other ancestor uses its cache verbatim.
      runFromNodeRef.current?.(c.target, 'self_only')
    }, 80)
  }, [pushHistory])

  // Types that expose a "brand" input — used to auto-wire sync-to-all brand profiles.
  const BRAND_INPUT_TYPES = ['script_gen', 'caption_gen', 'image_gen']

  const addNode = (type, position) => {
    const def = NODE_REGISTRY[type]
    if (!def) return
    pushHistory()
    const id = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    setNodes((arr) => [
      ...arr,
      {
        id,
        type: 'space',
        position: position || { x: 120 + arr.length * 40, y: 80 + arr.length * 60 },
        data: { type, props: { ...(def.initialProps || {}) }, status: 'idle', output: null, error: null },
      },
    ])

    // If this new node has a "brand" input AND a brand_profile with sync_all
    // is on the canvas, auto-connect it.
    if (BRAND_INPUT_TYPES.includes(type)) {
      const syncSources = nodesRef.current.filter((n) => n.data?.type === 'brand_profile' && n.data?.props?.sync_all)
      if (syncSources.length) {
        setEdges((prev) => {
          const additions = syncSources.map((b) => ({
            id: `e_${b.id}_${id}_brand`,
            source: b.id, sourceHandle: 'out',
            target: id, targetHandle: 'in',
            type: 'scissor',
            animated: true,
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { stroke: 'var(--red)', strokeWidth: 1.5 },
          }))
          // Avoid duplicating an edge that already exists
          const haveKeys = new Set(prev.map((e) => `${e.source}|${e.target}|${e.targetHandle}`))
          return [...prev, ...additions.filter((e) => !haveKeys.has(`${e.source}|${e.target}|${e.targetHandle}`))]
        })
      }
    }
  }

  // Drag from palette → drop on canvas
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }
  const onDrop = (e) => {
    e.preventDefault()
    const type = e.dataTransfer.getData('application/scalesolo-node')
    if (!type) return
    // ReactFlow positions are relative to the flow viewport; we approximate
    // here with the screen offset minus the wrapper. For MVP this is fine —
    // user can reposition by dragging the node afterward.
    const rect = e.currentTarget.getBoundingClientRect()
    addNode(type, { x: e.clientX - rect.left - 100, y: e.clientY - rect.top - 50 })
  }

  const patchNode = useCallback((id, patch) => {
    // Don't pollute history with internal/cosmetic patches: status / output
    // changes during a run, and the _ctx* / __name keys we manage server-
    // side. Inline edited_* fields ARE user edits — but they fire on every
    // keystroke, so we'd flood the stack. Punt: only snapshot when the
    // patch contains a real prop key (not status/output/_ctx/__name).
    const keys = Object.keys(patch || {})
    const meaningful = keys.some((k) => k !== 'status' && k !== 'output' && k !== 'error' && k !== '__name' && !k.startsWith('_ctx') && !k.startsWith('edited_'))
    if (meaningful) pushHistory()
    setNodes((arr) => arr.map((n) => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))
  }, [pushHistory])

  // After a run finishes, video_polish nodes that produced a clip but have
  // no downstream destination silently lose the result — the user has to
  // manually wire one. Auto-spawn a Collection node beside each polish
  // node that finished done + dangling, prepopulated with the new clip.
  const ensureCollectionForVideoPolish = useCallback(() => {
    const curNodes = nodesRef.current
    const curEdges = edgesRef.current
    const additionsN = []
    const additionsE = []
    for (const n of curNodes) {
      if (n.data?.type !== 'video_polish') continue
      if (n.data?.status !== 'done') continue
      const url = n.data?.output?.video?.video_url || n.data?.output?.video_url
      if (!url) continue
      // If the polish node already feeds anything downstream, leave it alone.
      if (curEdges.some((e) => e.source === n.id)) continue
      const collectionId = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}_c`
      const pos = { x: (n.position?.x || 0) + 360, y: (n.position?.y || 0) + 60 }
      additionsN.push({
        id: collectionId,
        type: 'space',
        position: pos,
        data: {
          type: 'collection', props: {},
          // Pre-seed the collection with the video that just rendered so
          // the user sees it immediately without re-running.
          status: 'done',
          output: { items: [{ kind: 'video', url, from: 'polish' }] },
          error: null,
        },
      })
      additionsE.push({
        id: `e_${n.id}_${collectionId}`,
        source: n.id, sourceHandle: 'out',
        target: collectionId, targetHandle: 'in',
        type: 'scissor', animated: true,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: 'var(--red)', strokeWidth: 1.5 },
      })
    }
    if (additionsN.length) {
      setNodes((arr) => [...arr, ...additionsN])
      setEdges((arr) => [...arr, ...additionsE])
    }
  }, [])


  const aiBuild = async () => {
    if (!aiPrompt.trim()) return
    setAiBuilding(true); setError(null); setAiSuggestion(null)
    try {
      const r = await fetch('/api/spaces/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          profile_id: selectedProfileId,
          instruction: aiPrompt,
          current_nodes: nodes.length ? nodes : null,
          current_edges: edges.length ? edges : null,
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      if (Array.isArray(body.nodes)) setNodes(body.nodes)
      if (Array.isArray(body.edges)) {
        // Normalize handles + force scissor type for AI-generated edges
        const normalized = body.edges.map((e) => ({ ...normalizeEdgeHandles(e), type: 'scissor' }))
        const newNodes = Array.isArray(body.nodes) ? body.nodes : []
        const syncSources = newNodes.filter((n) => n.data?.type === 'brand_profile' && n.data?.props?.sync_all)
        for (const b of syncSources) {
          for (const t of newNodes) {
            if (t.id === b.id) continue
            if (!['script_gen', 'caption_gen', 'image_gen'].includes(t.data?.type)) continue
            const k = `${b.id}|${t.id}|in`
            if (normalized.some((e) => `${e.source}|${e.target}|${e.targetHandle}` === k)) continue
            normalized.push({
              id: `e_${b.id}_${t.id}_brand`,
              source: b.id, sourceHandle: 'out',
              target: t.id, targetHandle: 'in',
              type: 'scissor', animated: true,
              markerEnd: { type: MarkerType.ArrowClosed },
              style: { stroke: 'var(--red)', strokeWidth: 1.5 },
            })
          }
        }
        setEdges(normalized)
      }
      setAiSuggestion(body.suggestions || null)
      setAiPrompt('')
      refreshCredits()
    } catch (e) {
      setError(e.message)
    } finally {
      setAiBuilding(false)
    }
  }

  // Record a run start/finish to space_runs. Best-effort.
  const recordRunStart = async ({ triggered_by, node_count }) => {
    if (!spaceIdRef.current) return null
    try {
      const r = await fetch('/api/spaces/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ space_id: spaceIdRef.current, triggered_by, status: 'running', node_count }),
      })
      const body = await r.json()
      return body?.run?.id || null
    } catch { return null }
  }
  const recordRunFinish = async (runId, payload) => {
    if (!runId) return
    try {
      await fetch(`/api/spaces/runs?id=${runId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ ...payload, finished_at: new Date().toISOString() }),
      })
    } catch {}
  }

  const run = async () => {
    if (running) return
    setError(null)
    setNodes((arr) => arr.map((n) => ({ ...n, data: { ...n.data, status: 'idle', output: null, error: null } })))

    const ctx = { token: session.access_token, profileId: selectedProfileId, avatars, profiles }
    const snapshot = safeClone({ nodes, edges })
    const startedAt = Date.now()
    const runId = await recordRunStart({ triggered_by: 'manual', node_count: snapshot.nodes.length })
    try {
      const result = await runCtx.executeRun({
        spaceId: spaceIdRef.current || '__transient__',
        ctx,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
      })
      if (!result.ok) {
        const msg = Object.entries(result.errors).map(([id, e]) => `${id}: ${e}`).join(' · ')
        setError(msg || 'One or more nodes failed')
      }
      ensureCollectionForVideoPolish()
      refreshCredits()
      const errCount = Object.keys(result.errors || {}).length
      await recordRunFinish(runId, {
        status: errCount === 0 ? 'success' : (errCount < snapshot.nodes.length ? 'partial' : 'failed'),
        errors: Object.entries(result.errors || {}).map(([nodeId, msg]) => ({ nodeId, msg })),
        duration_ms: Date.now() - startedAt,
      })
    } catch (e) {
      setError(e.message)
      await recordRunFinish(runId, { status: 'failed', errors: [{ msg: e.message }], duration_ms: Date.now() - startedAt })
    }
  }

  // Run a node with one of three scopes:
  //   'self_only':  target only — ancestors must already be cached, no
  //                 descendants run. "I just want this node re-executed."
  //   'up_to_here': target + every ancestor (full upstream chain) + sibling
  //                 sources of any ancestor. No descendants. "Refresh
  //                 everything that produces this node's input."
  //   'full' (default): target + ancestors + descendants + sibling sources
  //                 of descendants. Used by Auto-run ticks and the global
  //                 Run button.
  const runFromNode = useCallback(async (targetId, scope = 'full') => {
    if (runningRef.current) {
      // Don't fail silently — the user just clicked play and nothing
      // visible would happen otherwise. Toast tells them why and what
      // to do next.
      console.info('[runFromNode] rejected — already running', { targetId, scope })
      toast({ kind: 'warn', message: 'Another run is already in progress. Stop it first or wait for it to finish.' })
      return
    }
    console.info('[runFromNode] start', { targetId, scope })
    const want = new Set([targetId])

    // ALWAYS BFS up. Even in self_only mode the target needs its ancestors
    // in the subset — runSpace reads inputs from outputsById, which only
    // gets populated for nodes that are actually iterated over. Ancestors
    // sit there as cache hits (their cached output flows through to the
    // target) and never re-execute.
    const upQueue = [targetId]
    while (upQueue.length) {
      const id = upQueue.shift()
      for (const e of edges) {
        if (e.target === id && !want.has(e.source)) {
          want.add(e.source); upQueue.push(e.source)
        }
      }
    }

    // BFS down — descendants. Only for the full-chain scope.
    if (scope === 'full') {
      const downQueue = [targetId]
      while (downQueue.length) {
        const id = downQueue.shift()
        for (const e of edges) {
          if (e.source === id && !want.has(e.target)) {
            want.add(e.target); downQueue.push(e.target)
          }
        }
      }
      // Sibling sources for any descendant — they need their inputs in
      // the run subset too (e.g. auto_run → script_gen → avatar_render
      // where avatar_picker is a sibling source feeding avatar_render).
      const siblingQueue = [...want]
      while (siblingQueue.length) {
        const id = siblingQueue.shift()
        for (const e of edges) {
          if (e.target === id && !want.has(e.source)) {
            want.add(e.source); siblingQueue.push(e.source)
          }
        }
      }
    }

    // Auto-thread FREE descendants (Collection, Combine, anything marked
    // def.free) into the run subset regardless of scope, so a Run-this-
    // node-only / up-to-here click on a generator still updates the
    // collections wired downstream. Expensive descendants (avatar render,
    // image gen, etc.) stay out — the per-node dialog message promises
    // exactly this behavior. We track these IDs in `freeDescendants` so
    // we can also force them to skip their stale cache below.
    const freeDescendants = new Set()
    {
      const q = [targetId]
      const seen = new Set([targetId])
      while (q.length) {
        const id = q.shift()
        for (const e of edges) {
          if (e.source !== id || seen.has(e.target)) continue
          const child = nodes.find((n) => n.id === e.target)
          const childDef = NODE_REGISTRY[child?.data?.type]
          if (!childDef?.free) continue
          seen.add(e.target)
          freeDescendants.add(e.target)
          want.add(e.target)
          q.push(e.target)
        }
      }
    }

    // Self-only sanity check: the target's inputs must already be cached.
    // If any direct parent is missing output we can't reuse its result,
    // so fail loudly with a friendly node name (NOT the cryptic id) and
    // offer a one-click escape to "up to here" so the user doesn't have
    // to re-open the chooser.
    if (scope === 'self_only') {
      const directParents = edges.filter((e) => e.target === targetId).map((e) => e.source)
      const missing = directParents.filter((pid) => {
        const p = nodes.find((n) => n.id === pid)
        return !(p?.data?.status === 'done' && p?.data?.output)
      })
      if (missing.length) {
        const friendlyName = (pid) => {
          const n = nodes.find((nd) => nd.id === pid)
          if (n?.data?.name) return n.data.name
          const def = NODE_REGISTRY[n?.data?.type]
          return def?.label || (n?.data?.type || pid.slice(0, 6))
        }
        const names = missing.map(friendlyName).join(', ')
        const targetDef = NODE_REGISTRY[nodes.find((n) => n.id === targetId)?.data?.type]
        const targetLabel = targetDef?.label || 'this node'
        const proceed = await confirmDialog({
          title: `${names} hasn’t run yet`,
          message: `Run this node only needs ${names}’s output, but it’s not cached. Want to run up to ${targetLabel} instead? That re-runs every upstream node, then ${targetLabel}.`,
          confirmText: 'Run up to here',
          cancelText: 'Cancel',
        })
        if (!proceed) return
        // Recursive call with the broader scope. Skip the chooser; we
        // already have the user's choice from the recovery dialog.
        return runFromNode(targetId, 'up_to_here')
      }
    }
    const subsetNodes = nodes.filter((n) => want.has(n.id))
    const subsetEdges = edges.filter((e) => want.has(e.source) && want.has(e.target))
    if (!subsetNodes.length) return

    setError(null)
    // Build the descendant set (everything downstream of the target).
    const targetType = nodes.find((n) => n.id === targetId)?.data?.type
    const isAutoTrigger = targetType === 'auto_run'
    const descendants = new Set([targetId])
    {
      const q = [targetId]
      while (q.length) {
        const id = q.shift()
        for (const e of edges) {
          if (e.source === id && !descendants.has(e.target)) {
            descendants.add(e.target); q.push(e.target)
          }
        }
      }
    }

    // Reset rules per scope:
    //
    //  self_only    — ONLY the target resets. Ancestors stay exactly as
    //                 they are; if cached, runSpace short-circuits them
    //                 and only the target re-executes. (Pre-flight check
    //                 above already errored if any direct parent isn't
    //                 cached, so we never reach here with garbage.)
    //
    //  up_to_here   — Target + every ancestor reset. The user explicitly
    //                 asked to refresh the upstream chain.
    //
    //  full / auto  — Target reset. Cached ancestors stay cached (saves
    //                 credits on "re-run combine_videos but not avatar
    //                 render" retries). Auto_run triggers leave
    //                 descendants' state alone since runSpace's
    //                 forceReRun set forces them to re-execute anyway,
    //                 keeping the previous tick's output visible until
    //                 the new one lands.
    setNodes((arr) => arr.map((n) => {
      if (!want.has(n.id)) return n
      if (n.id === targetId) {
        return { ...n, data: { ...n.data, status: 'idle', output: null, error: null } }
      }
      // Free descendants auto-threaded into the subset MUST refresh so
      // they pick up the target's new output, but we PRESERVE their
      // output so accumulator nodes (Collection, etc.) can read their
      // prior items from data.output and merge new incoming items into
      // them. The runOnlyTargetId branch in runSpace short-circuits to
      // cached output unless forceReRun has this id — and we add free
      // descendants to forceReRun in this same setup, so def.run() will
      // be called with the prior items still available.
      if (freeDescendants.has(n.id)) {
        return { ...n, data: { ...n.data, status: 'idle', error: null } }
      }
      if (scope === 'self_only') {
        // Ancestor — leave it alone. Cache flows through to target.
        return n
      }
      if (scope === 'up_to_here') {
        // Smart-cache: keep ancestors with cached output, only reset
        // those that don't have one. The user's intent is "produce the
        // target's output, re-running upstream as needed" — they did
        // NOT ask to burn credits re-rendering already-done expensive
        // nodes. If they really want a fresh upstream pass, they can
        // click each cached node's ▶ first and pick "Run this node
        // only" to invalidate, or use the global Run button.
        const isCached = n.data?.status === 'done' && n.data?.output
        if (isCached) return n
        return { ...n, data: { ...n.data, status: 'idle', output: null, error: null } }
      }
      // 'full' scope. Descendants of the target MUST be reset so they
      // re-execute against the target's new output (otherwise their
      // status='done' cache short-circuits in runSpace and stale
      // outputs flow forward — this was breaking image_gen → Collection
      // updates). Ancestors keep their cache so we don't burn credits
      // re-running upstream nodes the user didn't ask to refresh.
      if (!isAutoTrigger) {
        const isDescendant = descendants.has(n.id) && n.id !== targetId
        if (isDescendant) {
          return { ...n, data: { ...n.data, status: 'idle', output: null, error: null } }
        }
        // Ancestor (or target — already handled above): keep cached.
        const isCached = n.data?.status === 'done' && n.data?.output
        if (isCached) return n
        return { ...n, data: { ...n.data, status: 'idle', output: null, error: null } }
      }
      return n
    }))
    // forceReRun is the auto-tick belt-and-suspenders: it forces
    // descendants to re-execute even when their cache says 'done'. We
    // ONLY want this for scope='full' on an auto_run target. Any other
    // scope (self_only, up_to_here, or a manual click on a non-auto
    // node) must NOT set it — otherwise descendants get force-run
    // even when the user explicitly asked us not to touch them.
    // forceReRun: nodes that MUST re-execute even when their cache says
    // 'done'. Two sources: (1) auto_run ticks force the full descendant
    // set; (2) free descendants auto-threaded into the subset (Collection
    // etc.) always force-rerun so they pick up the target's new output.
    const forceReRun = new Set()
    if (scope === 'full' && isAutoTrigger) {
      for (const id of descendants) if (id !== targetId) forceReRun.add(id)
    }
    for (const id of freeDescendants) forceReRun.add(id)
    // self_only mode: pin a runOnlyTargetId so runSpace forces every
    // non-target node to skip def.run() (even noCache ones like
    // avatar_picker) and use its cached output verbatim. Without this
    // pin, ancestors with status='idle' OR with noCache=true would
    // re-execute and the user sees the whole chain run again.
    const runOnlyTargetId = scope === 'self_only' ? targetId : null
    const ctx = { token: session.access_token, profileId: selectedProfileId, avatars, profiles, runFromTargetId: targetId, forceReRun, runOnlyTargetId }
    console.info('[runFromNode] subset', {
      scope,
      targetId,
      target_type: targetType,
      total_nodes_in_subset: subsetNodes.length,
      will_actually_execute: scope === 'self_only' ? 1 : 'depends_on_cache',
      runOnlyTargetId,
      forceReRunCount: forceReRun?.size || 0,
    })
    const snapshot = safeClone({ nodes: subsetNodes, edges: subsetEdges })
    const startedAt = Date.now()
    const triggerType = nodes.find((n) => n.id === targetId)?.data?.type === 'auto_run' ? 'auto_run' : 'per_node'
    const runId = await recordRunStart({ triggered_by: triggerType, node_count: snapshot.nodes.length })
    try {
      const result = await runCtx.executeRun({
        spaceId: spaceIdRef.current || '__transient__',
        ctx,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
      })
      if (!result.ok) {
        const msg = Object.entries(result.errors).map(([id, e]) => `${id}: ${e}`).join(' · ')
        setError(msg || 'Node run failed')
      }
      ensureCollectionForVideoPolish()
      refreshCredits()
      const errCount = Object.keys(result.errors || {}).length
      await recordRunFinish(runId, {
        status: errCount === 0 ? 'success' : (errCount < snapshot.nodes.length ? 'partial' : 'failed'),
        errors: Object.entries(result.errors || {}).map(([nodeId, msg]) => ({ nodeId, msg })),
        duration_ms: Date.now() - startedAt,
      })
    } catch (e) {
      setError(e.message)
      await recordRunFinish(runId, { status: 'failed', errors: [{ msg: e.message }], duration_ms: Date.now() - startedAt })
    }
  }, [running, nodes, edges, session, selectedProfileId, avatars, patchNode, refreshCredits, ensureCollectionForVideoPolish, runCtx])

  // Cross-route persistence: register this page's patchNode as the live
  // sink for the current space, so the SpacesRunProvider can stream
  // patches into ReactFlow while we're mounted. On unmount the sink is
  // cleared but the provider keeps caching, so when we remount and load
  // the same space we apply the cache via getSnapshot to catch up.
  useEffect(() => {
    const sid = spaceIdRef.current
    if (!sid) return
    runCtx.setSink(sid, patchNode)
    // If there's a still-running snapshot for this space, replay it onto
    // the freshly-loaded nodes so the canvas reflects in-flight state.
    const snap = runCtx.getSnapshot(sid)
    if (snap && Object.keys(snap).length) {
      setNodes((arr) => arr.map((n) => snap[n.id] ? { ...n, data: { ...n.data, ...snap[n.id] } } : n))
    }
    return () => runCtx.clearSink(sid)
  }, [runCtx, patchNode, space?.id])

  // Expose runFromNode + abort through globals so SpaceNode header buttons
  // can call them without prop drilling.
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.__spaceRunFromNode = runFromNode
    window.__spaceAbortRun = () => { runCtx.stopRun() }
    // Per-node play button uses this to ask the user which scope to run.
    // Returns one of 'self_only' | 'up_to_here' | null (cancelled).
    //
    // While the dialog is open we set window.__spaceUserDialogOpen so
    // the auto-run interval pauses — otherwise an auto tick can fire
    // mid-prompt and steamroll the user's choice (then runFromNode's
    // `if (running) return` swallows the per-node click silently).
    window.__spaceChooseRunScope = async (nodeId) => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      const label = node?.data?.name || NODE_REGISTRY[node?.data?.type]?.label || 'this node'
      const directParents = (edgesRef.current || []).filter((e) => e.target === nodeId).map((e) => e.source)
      const hasParents = directParents.length > 0
      const allParentsCached = directParents.every((pid) => {
        const p = nodesRef.current.find((n) => n.id === pid)
        return p?.data?.status === 'done' && p?.data?.output
      })
      // No parents → nothing to choose; just run.
      if (!hasParents) {
        window.__spaceUserClickAt = Date.now()
        return 'self_only'
      }
      const options = [
        {
          key: 'self_only',
          label: 'Run this node only',
          hint: allParentsCached
            ? 'Reuses cached upstream. Free aggregators (Collection, Combine, etc.) auto-thread; expensive nodes (Avatar render, Script gen, Polish) only fire if cached.'
            : 'Some upstream nodes haven\'t run yet. Pick "Run up to here" so they catch up, or run them individually first.',
          primary: true,
        },
        {
          key: 'up_to_here',
          label: 'Run up to this node',
          hint: 'Cached upstream nodes are reused, uncached ones run. No credit burn on already-done renders. Anything downstream of this node stays untouched.',
        },
      ]
      window.__spaceUserDialogOpen = true
      try {
        const choice = await chooseDialog({
          title: `Run ${label}`,
          message: 'Pick the scope. Downstream nodes won\'t run either way — use the global Run button to fire the whole space.',
          options,
        })
        if (choice) window.__spaceUserClickAt = Date.now()
        return choice
      } finally {
        window.__spaceUserDialogOpen = false
      }
    }
    // Server-side schedule hooks. Called from the auto_run node body
    // when the user clicks Start / Stop. Persists or removes the
    // schedule from scheduled_workflows so the Vercel cron can fire
    // the workflow even when the canvas tab is closed.
    window.__spaceStartServerSchedule = async (triggerNodeId, options = {}) => {
      const sid = spaceIdRef.current
      if (!sid || sid === '__transient__') {
        toast({ kind: 'warn', message: 'Save the space before starting server-side auto-run.' })
        return false
      }
      try {
        const sess = (await supabase.auth.getSession()).data.session
        // Serialize a minimal graph — strip _ctx fields and runtime
        // status / output / progress so the saved snapshot is
        // deterministic. The worker rehydrates props for each node
        // when running.
        const sanitized = {
          nodes: nodesRef.current.map((n) => ({
            id: n.id,
            type: n.type,
            position: n.position,
            data: {
              type: n.data?.type,
              name: n.data?.name,
              props: n.data?.props,
            },
          })),
          edges: edgesRef.current.map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            sourceHandle: e.sourceHandle,
            targetHandle: e.targetHandle,
          })),
          snapshot_at: new Date().toISOString(),
        }
        const r = await fetch('/api/spaces/save-schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sess?.access_token || ''}` },
          body: JSON.stringify({
            space_id: sid,
            trigger_node_id: triggerNodeId,
            profile_id: selectedProfileId,
            interval_ms: options.interval_ms,
            max_runs: options.max_runs,
            graph: sanitized,
          }),
        })
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body?.error || `save-schedule ${r.status}`)
        toast({ kind: 'success', message: `Server auto-run scheduled. Next fire: ${new Date(body.next_fire_at).toLocaleString()}` })
        return true
      } catch (e) {
        toast({ kind: 'error', message: `Couldn't save server schedule: ${e.message}` })
        return false
      }
    }
    window.__spaceStopServerSchedule = async (triggerNodeId) => {
      const sid = spaceIdRef.current
      if (!sid || sid === '__transient__') return true
      try {
        const sess = (await supabase.auth.getSession()).data.session
        const url = `/api/spaces/save-schedule?space_id=${encodeURIComponent(sid)}&trigger_node_id=${encodeURIComponent(triggerNodeId)}`
        await fetch(url, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${sess?.access_token || ''}` },
        })
        return true
      } catch (e) {
        toast({ kind: 'warn', message: `Couldn't fully stop server schedule: ${e.message}. The cron will quietly fail next tick.` })
        return false
      }
    }
    return () => {
      window.__spaceRunFromNode = null
      window.__spaceAbortRun = null
      window.__spaceChooseRunScope = null
      window.__spaceStartServerSchedule = null
      window.__spaceStopServerSchedule = null
    }
  }, [runFromNode])

  // ── Auto-run drivers ──────────────────────────────────────────────────────
  // For every active auto_run node, schedule a setInterval that fires
  // runFromNode(node.id), increments the run counter, and disables itself
  // once max_runs is reached. Closing the tab pauses naturally because the
  // interval is bound to this React tree.
  const runFromNodeRef = useRef(runFromNode)
  useEffect(() => { runFromNodeRef.current = runFromNode }, [runFromNode])

  // Remember which auto_run nodes were already active on the previous
  // render so we can distinguish two cases:
  //   (a) The user just toggled an auto_run from off → on → fire ONE
  //       run immediately, then continue on cadence.
  //   (b) The canvas mounted with auto_run already active (refresh /
  //       re-open) → only schedule the cadence interval, do NOT fire.
  // Without this ref the effect can't tell the two apart and either
  // both refresh and toggle-on fire (annoying) or neither does (also
  // annoying; the user wants to confirm activation worked).
  const prevActiveAutoRunIdsRef = useRef(new Set())

  useEffect(() => {
    const activeTriggers = nodes.filter((n) => n.data?.type === 'auto_run' && n.data?.props?.active)
    const currentIds = new Set(activeTriggers.map((n) => n.id))
    const prevIds = prevActiveAutoRunIdsRef.current
    const newlyActivated = new Set([...currentIds].filter((id) => !prevIds.has(id)))
    prevActiveAutoRunIdsRef.current = currentIds

    if (!activeTriggers.length) return
    const timers = []
    const firstTickTimers = []
    for (const trig of activeTriggers) {
      // autoRunIntervalMs handles both the new (runs_per_unit + unit)
      // and legacy (cadence) shapes so saved spaces keep firing on
      // their original cadence until the user opts into the new
      // frequency input.
      const intervalMs = autoRunIntervalMs(trig.data.props)
      const id = trig.id
      const justActivated = newlyActivated.has(id)
      const tick = async () => {
        const live = nodesRef.current.find((n) => n.id === id)
        if (!live || !live.data?.props?.active) return

        // ── Concurrency guards ─────────────────────────────────────────
        // The user opened the per-node "this node only / up to here"
        // chooser. Don't steamroll their intent with an auto tick — they
        // explicitly clicked play, that wins.
        if (window.__spaceUserDialogOpen) {
          console.info('[auto-run] tick suppressed — user chooser open')
          return
        }
        // Per-node run started in the last few seconds. Same idea: the
        // user is actively driving, auto-cadence stands down.
        if (window.__spaceUserClickAt && (Date.now() - window.__spaceUserClickAt) < 8000) {
          console.info('[auto-run] tick suppressed — recent user click')
          return
        }
        // A previous run is still in flight (cadence shorter than a
        // single run). Drop the tick rather than queue it — credit
        // burn + visual confusion outweigh the "missed" cadence.
        if (runningRef.current) {
          setSkippedTicks((n) => n + 1)
          toast({ kind: 'warn', message: 'Auto-run skipped — previous run still in progress.' })
          return
        }

        const used = Number(live.data.props.runs_used || 0)
        const cap  = Number(live.data.props.max_runs || 10)
        if (used >= cap) {
          patchNode(id, { props: { ...live.data.props, active: false } })
          toast({ kind: 'info', message: `Auto-run reached its cap (${cap} runs). Toggle off to reset, or bump max_runs.` })
          return
        }
        patchNode(id, { props: { ...live.data.props, runs_used: used + 1, last_run_at: new Date().toISOString() } })
        toast({ kind: 'info', message: `Auto-run firing (${used + 1} / ${cap}) — running the workflow…` })
        try {
          await runFromNodeRef.current(id, 'full')
        } catch (e) {
          console.warn('auto-run tick failed:', e.message)
          toast({ kind: 'error', message: `Auto-run failed: ${e.message}` })
        }
      }

      // Fire immediately ONLY on a fresh activation (off → on toggle).
      // Refresh / re-mount with active=true persisted does NOT trigger
      // anything — the effect's prevActiveAutoRunIdsRef tracks who was
      // active last render, so we only fire for nodes that just flipped
      // on this render.
      // 800ms delay so the toast renders + state settles before the run
      // starts; the user gets a clear "Auto-run firing" feedback.
      if (justActivated) {
        firstTickTimers.push(setTimeout(tick, 800))
      }
      timers.push(setInterval(tick, intervalMs))
    }
    return () => {
      firstTickTimers.forEach((t) => clearTimeout(t))
      timers.forEach((t) => clearInterval(t))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.map((n) => n.data?.type === 'auto_run'
    ? `${n.id}|${n.data.props?.active ? 1 : 0}|${n.data.props?.cadence}|${n.data.props?.runs_per_unit}|${n.data.props?.unit}|${n.data.props?.max_runs}`
    : '').join(',')])


  // Esc closes the preview modal.
  useEffect(() => {
    if (!previewItem) return
    // Pause every other video on the page when fullscreen preview opens.
    document.querySelectorAll('video').forEach((v) => { try { v.pause() } catch {} })
    const onKey = (e) => { if (e.key === 'Escape') setPreviewItem(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewItem])

  // ── BFS context precompute ────────────────────────────────────────────────
  // The per-node ctx injection in renderNodes used to walk back through
  // the edge graph for EACH save_library / auto_run / image_gen node on
  // every render. ReactFlow re-creates `nodes` on every drag tick, so
  // dragging one node triggered hundreds of BFS walks.
  //
  // Splitting the BFS work into its own memo keyed on a STRUCTURAL
  // fingerprint (just node ids/types and the edges array) means drag
  // events leave the BFS results cached. Per-node ctx then just looks
  // up by id — O(1) per node.
  const structuralKey = useMemo(() => {
    // Compact fingerprint: node-id|type|has-output|image-upload-urls
    // joined with edge sigs. Drag changes (position/selected/dragging)
    // are intentionally excluded.
    const nodeBits = nodes.map((n) => {
      const t = n.data?.type
      const hasOutput = n.data?.output ? 1 : 0
      // image_upload props (urls) feed image_gen's _ctxNamedImages, so
      // they need to be part of the structural key.
      const urls = t === 'image_upload'
        ? (Array.isArray(n.data?.props?.urls) ? n.data.props.urls.join(',').slice(0, 200) : '')
        : ''
      return `${n.id}|${t}|${hasOutput}|${urls}`
    }).join(';')
    const edgeBits = edges.map((e) => `${e.source}>${e.target}|${e.targetHandle || 'in'}`).join(';')
    return nodeBits + '||' + edgeBits
  }, [nodes, edges])

  // Per-node-type ctx maps. Computed only when the structural key
  // changes (i.e. on add/remove/connect/output-completion), NOT on
  // drag/select/dimensions.
  const bfsContexts = useMemo(() => {
    const imageGenById = new Map()         // id → { namedImages }
    const saveLibraryById = new Map()      // id → { kind }
    const autoRunById = new Map()          // id → { costPerRun }
    const nodesById = new Map(nodes.map((n) => [n.id, n]))

    for (const n of nodes) {
      const t = n.data?.type
      if (t === 'image_gen') {
        const named = []
        const visited = new Set([n.id])
        const queue = [n.id]
        while (queue.length) {
          const id = queue.shift()
          for (const e of edges) {
            if (e.target === id && !visited.has(e.source)) {
              visited.add(e.source)
              const src = nodesById.get(e.source)
              if (src?.data?.type === 'image_upload') {
                for (const it of readImageItems(src.data?.props)) named.push(it)
              }
              queue.push(e.source)
            }
          }
        }
        imageGenById.set(n.id, { namedImages: named })
      } else if (t === 'save_library') {
        let kind = 'text'
        const seen = new Set([n.id])
        const queue = [n.id]
        while (queue.length) {
          const id = queue.shift()
          for (const e of edges) {
            if (e.target === id && !seen.has(e.source)) {
              seen.add(e.source); queue.push(e.source)
              const src = nodesById.get(e.source)
              const out = src?.data?.output
              if (out?.video_url) kind = 'video'
              else if (Array.isArray(out?.images) && out.images.length && kind !== 'video') kind = 'image'
              else if (src?.data?.type === 'avatar_render' && kind !== 'video') kind = 'video'
              else if (src?.data?.type === 'image_gen' && kind !== 'video') kind = 'image'
            }
          }
        }
        saveLibraryById.set(n.id, { kind })
      } else if (t === 'auto_run') {
        let cost = 0
        const seen = new Set([n.id])
        const queue = [n.id]
        while (queue.length) {
          const id = queue.shift()
          for (const e of edges) {
            if (e.source === id && !seen.has(e.target)) {
              seen.add(e.target); queue.push(e.target)
              const child = nodesById.get(e.target)
              if (!child) continue
              const ct = child.data?.type
              const base = NODE_COST_HINT[ct] || 0
              const mult = ct === 'image_gen' ? Math.max(1, Number(child.data?.props?.count || 1)) : 1
              cost += base * mult
            }
          }
        }
        autoRunById.set(n.id, { costPerRun: cost })
      }
    }
    return { imageGenById, saveLibraryById, autoRunById }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structuralKey])

  // Inject ctx slices into nodes that need them at render time (avatars for
  // AvatarPicker, profiles for BrandProfile).
  const renderNodes = useMemo(
    () => nodes.map((n) => {
      const t = n.data?.type
      if (t === 'avatar_picker') return { ...n, data: { ...n.data, _ctxAvatars: avatars, _ctxPublicAvatars: publicAvatars } }
      if (t === 'avatar_render') return { ...n, data: { ...n.data, _ctxIsTrialing: subscriptionStatus === 'trialing' } }
      if (t === 'brand_profile') return { ...n, data: { ...n.data, _ctxProfiles: profiles } }
      if (t === 'image_upload')  return { ...n, data: { ...n.data, _ctxProfileId: selectedProfileId } }
      if (t === 'captions') {
        // Inline preview frame in the captions body needs the closest
        // upstream rendered video URL without reaching into the graph
        // from inside the ReactFlow custom node.
        return { ...n, data: {
          ...n.data,
          _ctxProfileId: selectedProfileId,
          _ctxUpstreamVideoUrl: findUpstreamVideoUrl(n.id, nodes, edges),
        } }
      }
      if (t === 'video_polish') {
        // The polish editor uses upstream video + logo for the live
        // overlay preview, plus profile id for the watermark uploader.
        return { ...n, data: {
          ...n.data,
          _ctxProfileId: selectedProfileId,
          _ctxUpstreamVideoUrl: findUpstreamVideoUrl(n.id, nodes, edges),
          _ctxUpstreamLogoUrl: findUpstreamLogoUrl(n.id, nodes, edges),
        } }
      }
      if (t === 'voice_gen') {
        // Body uses this to switch between avatar-voice mode (when an
        // avatar_picker is upstream) and standalone voice-picker mode.
        return { ...n, data: {
          ...n.data,
          _ctxProfileId: selectedProfileId,
          _ctxHasAvatarUpstream: findUpstreamAvatarPicker(n.id, nodes, edges),
        } }
      }
      if (t === 'schedule_post') {
        // Drives platform-pill enablement + the auto-slot preview +
        // the per-platform character-cap warning.
        const activeProfile = (profiles || []).find((p) => p.id === selectedProfileId)
        // Walk upstream to estimate the description length (caption +
        // hashtags) that schedule_post would build at run time. Cheap
        // approximation; updates whenever an upstream node finishes.
        let descLen = null
        const seen = new Set([n.id])
        const queue = [n.id]
        let captionStr = '', hashtagsStr = ''
        while (queue.length) {
          const cur = queue.shift()
          for (const e of edges) {
            if (e.target !== cur || seen.has(e.source)) continue
            seen.add(e.source); queue.push(e.source)
            const src = nodes.find((x) => x.id === e.source)
            const o = src?.data?.output
            if (!o) continue
            if (typeof o === 'object') {
              if (!captionStr && typeof o.caption === 'string') captionStr = o.caption
              if (!hashtagsStr && typeof o.hashtags === 'string') hashtagsStr = o.hashtags
            }
          }
        }
        if (captionStr || hashtagsStr) {
          descLen = [captionStr, hashtagsStr].filter(Boolean).join('\n\n').trim().length
        }
        return { ...n, data: {
          ...n.data,
          _ctxProfileId: selectedProfileId,
          _ctxConnectedPlatforms: connectedSocialPlatforms,
          _ctxBrandSchedule: activeProfile ? {
            timezone: activeProfile.timezone,
            posting_schedule: activeProfile.posting_schedule,
          } : null,
          _ctxBrandCTA: activeProfile?.brand_cta || '',
          _ctxIncomingDescriptionLength: descLen,
          _ctxIsTrialing: subscriptionStatus === 'trialing',
        } }
      }
      if (t === 'save_library') {
        // BFS result precomputed in bfsContexts; just attach + add the
        // brand-profile synced_platforms (cheap, not BFS-dependent).
        const kind = bfsContexts.saveLibraryById.get(n.id)?.kind || 'text'
        const activeProfile = (profiles || []).find((p) => p.id === selectedProfileId)
        const synced = Array.isArray(activeProfile?.synced_platforms) ? activeProfile.synced_platforms : []
        return { ...n, data: { ...n.data, _ctxSyncedPlatforms: synced, _ctxDetectedKind: kind } }
      }
      if (t === 'auto_run') {
        const costPerRun = bfsContexts.autoRunById.get(n.id)?.costPerRun || 0
        return { ...n, data: { ...n.data, _ctxCostPerRun: costPerRun } }
      }
      // Generators that take prompts get _ctxProfiles for @brand autocomplete.
      // image_gen also gets named upload images via BFS-back through edges
      // (precomputed in bfsContexts).
      if (t === 'script_gen' || t === 'caption_gen' || t === 'image_gen') {
        const slim = (profiles || []).map((p) => ({ id: p.id, name: p.business_name }))
        if (t !== 'image_gen') {
          return { ...n, data: { ...n.data, _ctxProfiles: slim } }
        }
        const named = [...(bfsContexts.imageGenById.get(n.id)?.namedImages || [])]
        // Expose @brand-logo as a synthetic named image when the active brand
        // profile has a logo_url. Cheap O(1) lookup; no BFS.
        const activeProfileForLogo = (profiles || []).find((p) => p.id === selectedProfileId)
        if (activeProfileForLogo?.logo_url) {
          named.push({ name: 'brand-logo', url: activeProfileForLogo.logo_url })
        }
        return { ...n, data: { ...n.data, _ctxNamedImages: named, _ctxProfiles: slim } }
      }
      return n
    }),
    [nodes, edges, avatars, profiles, publicAvatars, selectedProfileId, connectedSocialPlatforms, subscriptionStatus, bfsContexts]
  )

  // Lock body scroll while the builder is mounted (it uses position:fixed).
  useEffect(() => {
    if (typeof document === 'undefined') return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // The builder is rendered as a full-viewport overlay so it escapes the
  // <main> content padding and max-width. The desktop sidebar still shows
  // through underneath; on mobile the overlay covers the whole screen.
  const overlayStyle = {
    position: 'fixed',
    top: 0, right: 0, bottom: 0,
    left: 0,                         // mobile-first; desktop overrides via media class
    background: 'var(--bg)',
    zIndex: 40,
    display: 'flex', flexDirection: 'column',
  }
  const toolbarStyle = {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 14px',
    background: 'color-mix(in srgb, var(--bg) 85%, transparent)',
    borderBottom: '1px solid var(--border)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
  }

  return (
    <div className="space-builder-overlay" style={overlayStyle}>
      <div style={toolbarStyle}>
        <button className="btn-ghost" onClick={onClose}><ArrowLeft size={14} /> Spaces</button>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Space name" style={{ width: 220, flex: '0 0 220px', fontWeight: 600 }} />

        {/* AI workflow-build chat bar removed. State + aiBuild handler
            stay in place for now — keyboard shortcut / re-introduction
            can wire into them later without re-plumbing. */}
        <div style={{ flex: 1 }} />

        <span style={{
          fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          padding: '4px 10px', borderRadius: 999,
          background: autoStatus === 'saving' ? 'rgba(245,158,11,0.16)'
            : autoStatus === 'saved' ? 'rgba(46,204,113,0.16)'
            : autoStatus === 'error' ? 'rgba(239,68,68,0.16)' : 'transparent',
          color: autoStatus === 'saving' ? 'var(--amber)'
            : autoStatus === 'saved' ? '#2ecc71'
            : autoStatus === 'error' ? 'var(--red)' : 'var(--muted)',
          minWidth: 78, textAlign: 'center',
        }}>
          {autoStatus === 'saving' ? 'Saving…'
            : autoStatus === 'saved' ? 'Saved'
            : autoStatus === 'error' ? 'Save error' : 'Autosave on'}
        </span>
        {skippedTicks > 0 && (
          <span
            title="Previous run was still in progress when an Auto-run tick fired. Slow down the cadence or wait for the run to finish."
            style={{
              fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700,
              padding: '4px 9px', borderRadius: 999,
              background: 'rgba(245,158,11,0.16)', color: 'var(--amber)',
              cursor: 'help',
            }}
            onClick={() => setSkippedTicks(0)}
          >
            {skippedTicks} skipped
          </span>
        )}
        {/* Live credit balances — clicking jumps to /billing. The
            renders that hit "Insufficient credit. This operation
            requires 'api' credits." come out of video_units, so both
            pools are surfaced here side-by-side. Goes red below 10%
            of the monthly grant so the user sees the wall coming. */}
        <SpaceCreditsPill />
        <button
          className="btn-ghost"
          onClick={undo}
          disabled={!canUndo}
          title={`Undo${pastCount ? ` (${pastCount})` : ''} — ⌘Z`}
          style={{ padding: '6px 10px', opacity: canUndo ? 1 : 0.4 }}
        >
          <Undo2 size={13} />
        </button>
        <button
          className="btn-ghost"
          onClick={redo}
          disabled={!canRedo}
          title={`Redo${futureCount ? ` (${futureCount})` : ''} — ⌘⇧Z`}
          style={{ padding: '6px 10px', opacity: canRedo ? 1 : 0.4 }}
        >
          <Redo2 size={13} />
        </button>
        <button className="btn-ghost" onClick={() => setHistoryOpen(true)} title="Run history" style={{ padding: '6px 10px' }}>
          <History size={13} /> History
        </button>
        {/* Private "Save as template" removed — admins use "Save as public
            template" (below) to feed the global gallery, and regular users
            don't need a separate private template surface (their saved
            spaces already live in their gallery). */}
        {isAdmin && (
          <button
            className="btn-ghost"
            onClick={async () => {
              if (!spaceIdRef.current) {
                setError('Save the space first before promoting it to a public template.')
                return
              }
              const tplName = window.prompt('Public template name (shown to every user):', `${name || 'Workflow'} template`)
              if (!tplName) return
              const summary = window.prompt('Short description for the gallery card (optional):', '') || ''
              setSavingAsTemplate(true)
              try {
                const r = await fetch('/api/admin/templates', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                  body: JSON.stringify({
                    source_id: spaceIdRef.current,
                    name: tplName,
                    summary: summary || null,
                    guide: templateGuide || null,
                    plan_gate: [],     // free for everyone by default; admin can edit later
                    sort_order: 100,
                  }),
                })
                const body = await r.json()
                if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
                toast?.success?.('Promoted to public template — manage in /admin/templates') || toast?.('Promoted to public template')
              } catch (e) {
                setError(e.message)
              } finally {
                setSavingAsTemplate(false)
              }
            }}
            disabled={savingAsTemplate}
            title="Admin only — promote this workflow to a public template visible in every user's gallery."
            style={{ padding: '6px 10px', borderColor: 'rgba(46,204,113,0.4)', color: '#2ecc71' }}
          >
            <ShieldCheck size={13} /> Save as public template
          </button>
        )}
        {templateGuide && guideHidden && (
          <button
            className="btn-ghost"
            onClick={() => setGuideHidden(false)}
            title="Show workflow guide"
            style={{ padding: '6px 10px' }}
          >
            <BookOpen size={13} /> Guide
          </button>
        )}
        <button className="btn-secondary" onClick={() => save()} disabled={busy} title="Force a save now">
          {busy ? <span className="spinner" /> : <Save size={13} />} Save
        </button>
        <button className="btn-primary" onClick={run} disabled={running || nodes.length === 0}>
          {running ? <span className="spinner" /> : <Play size={13} />} Run
        </button>
      </div>

      {error && (
        <div style={{ padding: '10px 14px', background: 'var(--red-soft)', color: 'var(--red)', fontSize: 12.5, borderBottom: '1px solid rgba(239,68,68,0.25)' }}>
          <AlertCircle size={13} style={{ verticalAlign: '-2px' }} /> {error}
        </div>
      )}
      {aiSuggestion && (
        <div style={{ padding: '8px 14px', background: 'rgba(245,158,11,0.10)', color: '#f59e0b', fontSize: 12.5, borderBottom: '1px solid rgba(245,158,11,0.25)' }}>
          <Wand2 size={12} style={{ verticalAlign: '-2px', marginRight: 6 }} />
          {aiSuggestion}
          <button onClick={() => setAiSuggestion(null)} style={{ float: 'right', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 14 }}>×</button>
        </div>
      )}
      {aiBuilding && (
        <div className="modal-overlay" style={{ zIndex: 110 }}>
          <div className="modal-card modal-card-md" style={{ textAlign: 'center', padding: 36 }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, margin: '0 auto 14px', background: 'linear-gradient(135deg, var(--red), var(--red-dark))', color: '#fff', display: 'grid', placeItems: 'center', boxShadow: '0 8px 24px rgba(239,68,68,0.32)' }} className="pulse">
              <Wand2 size={22} />
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18, marginBottom: 6 }}>Designing your workflow</div>
            <div style={{ color: 'var(--muted)', fontSize: 13.5, marginBottom: 14 }}>
              Picking nodes, wiring inputs and outputs, and laying it out on the canvas.
            </div>
            <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden', border: '1px solid var(--border)' }}>
              <div style={{
                width: '70%', height: '100%',
                background: 'linear-gradient(90deg, var(--red), var(--red-dark), var(--red))',
                backgroundSize: '200% 100%',
                animation: 'shimmer 1.4s linear infinite',
                boxShadow: '0 0 12px rgba(239,68,68,0.5)',
              }} />
            </div>
          </div>
        </div>
      )}

      <div
        style={{ flex: 1, position: 'relative', minHeight: 0 }}
        onDrop={onDrop}
        onDragOver={onDragOver}
      >
        <ReactFlow
          nodes={renderNodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          isValidConnection={isValidSpaceConnection}
          connectionMode="strict"
          connectionRadius={45}
          fitView
          /* Two-finger trackpad vertical scroll → zoom in/out.
             Horizontal scroll still pans sideways. Drag pans the canvas. */
          panOnScroll
          panOnScrollMode="horizontal"
          panOnScrollSpeed={0.8}
          zoomOnScroll
          zoomOnPinch
          defaultEdgeOptions={{ type: 'scissor', animated: true, style: { stroke: 'var(--red)', strokeWidth: 1.5 } }}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--border)" gap={20} size={1} />
          <ZoomControls />
          {templateGuide && !guideHidden && (
            <TemplateGuidePanel
              guide={templateGuide}
              nodes={nodes}
              onClose={() => setGuideHidden(true)}
            />
          )}
        </ReactFlow>

        <FloatingPalette onAdd={(type) => addNode(type)} />

        {/* Bottom-right FAB: toggles the workflow-guide side panel.
            Replaces the old AI chat agent that lived in this slot — for
            Spaces, the guide is the relevant always-on action. Hidden
            when this space has no template guide. */}
        {templateGuide && (
          <button
            type="button"
            onClick={() => setGuideHidden((v) => !v)}
            title={guideHidden ? 'Show workflow guide' : 'Hide workflow guide'}
            aria-label={guideHidden ? 'Show workflow guide' : 'Hide workflow guide'}
            style={{
              position: 'fixed',
              right: 24, bottom: 24,
              width: 56, height: 56,
              borderRadius: '50%',
              background: guideHidden
                ? 'linear-gradient(135deg, var(--red), var(--red-dark))'
                : 'var(--surface)',
              color: guideHidden ? '#fff' : 'var(--red)',
              border: guideHidden ? 'none' : '1px solid rgba(239,68,68,0.45)',
              cursor: 'pointer',
              display: 'grid', placeItems: 'center',
              boxShadow: guideHidden
                ? '0 14px 36px rgba(239,68,68,0.4)'
                : '0 8px 24px rgba(0,0,0,0.35)',
              zIndex: 60,
              transition: 'transform 0.15s var(--ease), box-shadow 0.15s var(--ease)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)' }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'none' }}
          >
            <BookOpen size={22} strokeWidth={2.2} />
          </button>
        )}

        {historyOpen && (
          <RunHistoryModal
            spaceId={spaceIdRef.current}
            token={session.access_token}
            onClose={() => setHistoryOpen(false)}
          />
        )}

        {editingNodeId && (() => {
          const node = nodes.find((n) => n.id === editingNodeId)
          if (!node) return null
          const def = NODE_REGISTRY[node.data?.type]
          if (!def?.Editor) return null
          const Editor = def.Editor
          const Icon = def.icon
          return (
            <NodeEditorDrawer
              title={node.data?.name || def.label}
              color={def.color}
              icon={Icon}
              onClose={() => setEditingNodeId(null)}
            >
              <Editor
                nodeId={editingNodeId}
                // Inject the same _ctx* slices the canvas body uses so
                // editor sub-components (uploaders, brand pickers, etc.)
                // can read profile id / brand list / upstream urls.
                // Without this the music + watermark uploaders see
                // profileId=undefined and stay disabled.
                data={{
                  ...node.data,
                  _ctxProfileId: selectedProfileId,
                  _ctxProfiles: profiles,
                  _ctxAvatars: avatars,
                  _ctxPublicAvatars: publicAvatars,
                  _ctxUpstreamVideoUrl: findUpstreamVideoUrl(editingNodeId, nodes, edges),
                  _ctxUpstreamScript: findUpstreamScript(editingNodeId, nodes, edges),
                  _ctxUpstreamLogoUrl: findUpstreamLogoUrl(editingNodeId, nodes, edges),
                }}
                onPatch={(patch) => window.__spacePatchNode?.(editingNodeId, patch)}
                allNodes={nodes}
                allEdges={edges}
              />
            </NodeEditorDrawer>
          )
        })()}

        {previewItem && (
          <div
            onClick={() => setPreviewItem(null)}
            style={{
              position: 'fixed', inset: 0, zIndex: 100,
              background: 'rgba(0,0,0,0.9)',
              display: 'grid', placeItems: 'center',
              padding: 40, cursor: 'zoom-out',
            }}
          >
            <button
              onClick={(e) => { e.stopPropagation(); setPreviewItem(null) }}
              style={{
                position: 'absolute', top: 18, left: 18,
                background: 'rgba(255,255,255,0.08)', border: 'none', color: '#fff',
                width: 36, height: 36, borderRadius: 999, cursor: 'pointer',
                display: 'grid', placeItems: 'center',
              }}
              title="Close (Esc)"
              aria-label="Close preview"
            ><X size={16} /></button>
            <button
              onClick={(e) => { e.stopPropagation(); downloadUrl(previewItem.url) }}
              style={{
                position: 'absolute', top: 18, right: 18,
                background: 'rgba(255,255,255,0.08)', border: 'none', color: '#fff',
                padding: '8px 14px', borderRadius: 999, cursor: 'pointer',
                fontSize: 12, fontFamily: 'var(--font-display)', fontWeight: 700,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            ><Download size={12} /> Download</button>
            {previewItem.type === 'video' ? (
              <video src={previewItem.url} controls autoPlay style={{ maxWidth: '92vw', maxHeight: '88vh', borderRadius: 8, background: '#000' }} onClick={(e) => e.stopPropagation()} />
            ) : (
              <img src={previewItem.url} alt="" style={{ maxWidth: '92vw', maxHeight: '88vh', borderRadius: 8, objectFit: 'contain' }} onClick={(e) => e.stopPropagation()} />
            )}
          </div>
        )}

        {nodes.length === 0 && !aiBuilding && (
          <div style={{
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            textAlign: 'center', color: 'var(--muted)', pointerEvents: 'none', maxWidth: 480,
          }}>
            <Wand2 size={32} style={{ marginBottom: 12 }} />
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--text)', fontSize: 16, marginBottom: 6 }}>
              Describe a workflow and the AI builds it
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.55, marginBottom: 14 }}>
              Type something like <em>“create scripts, then render avatar videos and save to library”</em> in the bar above, hit Build, and a connected node graph appears.
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
              Or drag nodes from the floating palette manually. Two-finger trackpad pans the canvas. Cmd/Ctrl + scroll zooms.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Page

export default function Spaces() {
  const { session, isAdmin } = useAuth()
  const { selectedProfileId, profiles } = useProfile()
  const [spaces, setSpaces] = useState([])
  const [editing, setEditing] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = async () => {
    if (!session || !selectedProfileId) return
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/spaces?profile_id=${selectedProfileId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      setSpaces(body.spaces || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { refresh() }, [session, selectedProfileId])

  const [creatingSpace, setCreatingSpace] = useState(false)
  const onCreate = () => setCreatingSpace(true)

  const onOpen = async (s) => {
    try {
      const r = await fetch(`/api/spaces?id=${s.id}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      const body = await r.json()
      if (r.ok) setEditing(body.space)
      else setError(body.error || 'Failed to open')
    } catch (e) { setError(e.message) }
  }

  const onDelete = async (s) => {
    const ok = await confirmDialog({ title: `Delete "${s.name}"?`, confirmText: 'Delete', destructive: true })
    if (!ok) return
    try {
      await fetch(`/api/spaces?id=${s.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${session.access_token}` } })
      refresh()
    } catch (e) { setError(e.message) }
  }

  const [historyFor, setHistoryFor] = useState(null)
  const onHistory = (s) => setHistoryFor(s)
  const [duplicateFor, setDuplicateFor] = useState(null)
  const onDuplicate = (s) => setDuplicateFor(s)

  if (!selectedProfileId) {
    return <div className="card-flat fade-up" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      Pick a brand profile to manage spaces.
    </div>
  }
  if (loading && spaces.length === 0) return <div className="card-flat" style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
  if (editing) return <SpaceBuilder space={editing} onSave={(s) => { refresh(); setEditing(s) }} onClose={() => { refresh(); setEditing(null) }} />
  return (
    <>
      <SpacesList
        spaces={spaces}
        onCreate={onCreate}
        onOpen={onOpen}
        onDelete={onDelete}
        onHistory={onHistory}
        onDuplicate={onDuplicate}
        error={error}
        token={session?.access_token}
        profileId={selectedProfileId}
        onTemplatePicked={(space, guide) => setEditing(space ? { ...space, template_guide: guide } : space)}
      />
      {historyFor && (
        <RunHistoryModal
          spaceId={historyFor.id}
          token={session.access_token}
          onClose={() => setHistoryFor(null)}
        />
      )}
      {duplicateFor && (
        <DuplicateSpaceModal
          space={duplicateFor}
          profiles={profiles || []}
          currentProfileId={selectedProfileId}
          token={session.access_token}
          onClose={() => setDuplicateFor(null)}
          onDone={(newSpace) => {
            // If the clone landed in the *current* profile, it'll show
            // up after refresh. If it went to a different profile, the
            // user needs to switch profiles to see it — toast already
            // told them where it went.
            if (newSpace?.profile_id === selectedProfileId) refresh()
          }}
        />
      )}
      {creatingSpace && (
        <NewSpaceModal
          profileId={selectedProfileId}
          token={session.access_token}
          onClose={() => setCreatingSpace(false)}
          onPicked={(picked) => {
            setCreatingSpace(false)
            if (picked.kind === 'blank') {
              setEditing({ id: null, name: 'Untitled space', nodes: [], edges: [] })
            } else {
              // Open the freshly cloned-from-template space directly. The
              // guide ships on the row (template_guide) so the side panel
              // shows up automatically.
              setEditing(picked.space)
            }
          }}
        />
      )}
    </>
  )
}
