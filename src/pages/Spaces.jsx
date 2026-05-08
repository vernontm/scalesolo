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

import {
  Plus, Play, Save, Trash2, ArrowLeft, Sparkles, Zap, Boxes, AlertCircle,
  GripHorizontal, Minimize2, Maximize2, Wand2, MessageSquare, Send,
  ZoomIn, ZoomOut, Maximize, Scissors, Download, X, History, Clock,
  CheckCircle2, XCircle, Square, Settings as SettingsIcon, Copy, Building2,
} from 'lucide-react'
import { useRef } from 'react'
// (useEffect already imported above for other effects in this file)
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { useCredits } from '../context/CreditsContext.jsx'
import { toast, confirmDialog } from '../components/Toast.jsx'
import {
  NODE_REGISTRY, NODE_CATEGORIES, runSpace, downloadUrl, readImageItems,
  AUTORUN_OPTIONS, NODE_COST_HINT,
  findUpstreamVideoUrl, findUpstreamScript, findUpstreamLogoUrl,
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
        {data.type !== 'collection' && (
          <button
            type="button"
            className="nodrag"
            title={status === 'running' ? 'Stop run' : 'Run this node (and any unrun upstream)'}
            onClick={(e) => {
              e.stopPropagation()
              if (status === 'running') window.__spaceAbortRun?.()
              else window.__spaceRunFromNode?.(id)
            }}
            style={{
              marginLeft: 'auto',
              background: status === 'running' ? 'rgba(239,68,68,0.16)' : 'transparent',
              border: 'none',
              color: status === 'running' ? 'var(--red)' : 'var(--muted)',
              cursor: 'pointer',
              padding: 4, borderRadius: 4, display: 'grid', placeItems: 'center',
            }}
          >{status === 'running' ? <Square size={11} /> : <Play size={12} />}</button>
        )}
        <span style={{ ...statusPill, marginLeft: data.type === 'collection' ? 'auto' : 0 }}>{status}</span>
      </div>
      <div style={{ padding: 12 }}>
        <Body data={{ ...data, __id: id }} onPatch={onPatch} />
      </div>
    </div>
  )
}

// Cheap fingerprint of a node's props for autosave deduping. Skips heavy
// fields (data URIs, full output blobs) and serializes only what the user
// can actually edit. We just need "did anything user-meaningful change".
function propsHashShort(p) {
  if (!p || typeof p !== 'object') return ''
  const skip = new Set(['_ctxAvatars', '_ctxPublicAvatars', '_ctxProfiles', '_ctxNamedImages', '_ctxCostPerRun', '_ctxProfileId', '_ctxSyncedPlatforms', '_ctxDetectedKind', '_ctxUpstreamVideoUrl', '_ctxUpstreamScript', '_ctxUpstreamLogoUrl', '_ctxConnectedPlatforms', '_ctxBrandSchedule', '_ctxIncomingDescriptionLength'])
  const parts = []
  for (const k of Object.keys(p).sort()) {
    if (skip.has(k)) continue
    const v = p[k]
    if (v == null) continue
    if (typeof v === 'string') parts.push(`${k}:${v.length}:${v.slice(0, 40)}`)
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}:${v}`)
    else if (Array.isArray(v)) parts.push(`${k}:[${v.length}]`)
    else parts.push(`${k}:o`)
  }
  return parts.join(',')
}

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

function SpacesList({ spaces, onCreate, onOpen, onDelete, onHistory, onDuplicate, error }) {
  return (
    <div className="fade-up">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, flex: 1 }}>Spaces</h2>
        <button className="btn-primary" onClick={onCreate}><Plus size={14} /> New space</button>
      </div>
      {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>{error}</div>}
      {spaces.length === 0 ? (
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <Boxes size={16} style={{ color: 'var(--red)' }} />
              </div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{s.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Updated {new Date(s.updated_at).toLocaleDateString()}</div>
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
  const { session } = useAuth()
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
  const [running, setRunning] = useState(false)
  // Live mirror so async ticks (auto-run intervals) can read current value
  // without going through stale closure state.
  const runningRef = useRef(false)
  useEffect(() => { runningRef.current = running }, [running])
  const [skippedTicks, setSkippedTicks] = useState(0)
  // Abort flag for in-flight runs. Read by long-poll generators between
  // ticks. Reset on every new run.
  const abortRunRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
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
  // Connected social platforms for the active brand (refreshed when the
  // user picks a different brand). Drives which buttons in schedule_post
  // are enabled.
  const [connectedSocialPlatforms, setConnectedSocialPlatforms] = useState([])

  // Ref mirrors of nodes/edges so global helpers don't read stale closures.
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  useEffect(() => { nodesRef.current = nodes }, [nodes])
  useEffect(() => { edgesRef.current = edges }, [edges])
  const [aiSuggestion, setAiSuggestion] = useState(null)

  // Load avatars (custom + HeyGen public library) so the AvatarPicker node
  // can list them.
  useEffect(() => {
    if (!session || !selectedProfileId) return
    fetch(`/api/avatars?profile_id=${selectedProfileId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => setAvatars(b.avatars || []))
      // eslint-disable-next-line no-console
      .catch((e) => console.warn('[Spaces] avatars load failed', e?.message || e))
    fetch(`/api/avatars/heygen-library?profile_id=${selectedProfileId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => setPublicAvatars(Array.isArray(b.groups) ? b.groups : []))
      // eslint-disable-next-line no-console
      .catch((e) => console.warn('[Spaces] heygen library load failed', e?.message || e))
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

  // Wire the global helpers used by node bodies (cheap escape hatch that
  // beats threading state through every ReactFlow component).
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.__spacePatchNode = (id, patch) => {
      setNodes((arr) => arr.map((n) => {
        if (n.id !== id) return n
        if (Object.prototype.hasOwnProperty.call(patch, '__name')) {
          const { __name, ...rest } = patch
          return { ...n, data: { ...n.data, name: __name, props: { ...(n.data?.props || {}), ...rest } } }
        }
        return { ...n, data: { ...n.data, props: { ...(n.data?.props || {}), ...patch } } }
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

  const onNodesChange = useCallback((changes) => setNodes((nds) => applyNodeChanges(changes, nds)), [])
  const onEdgesChange = useCallback((changes) => setEdges((eds) => applyEdgeChanges(changes, eds)), [])
  const onConnect = useCallback((c) => setEdges((eds) => addEdge({ ...c, type: 'scissor', markerEnd: { type: MarkerType.ArrowClosed }, animated: true, style: { stroke: 'var(--red)', strokeWidth: 1.5 } }, eds)), [])

  // Types that expose a "brand" input — used to auto-wire sync-to-all brand profiles.
  const BRAND_INPUT_TYPES = ['script_gen', 'caption_gen', 'image_gen']

  const addNode = (type, position) => {
    const def = NODE_REGISTRY[type]
    if (!def) return
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
    setNodes((arr) => arr.map((n) => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))
  }, [])

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

  // Live id ref so autosave continues to PATCH the same row after the
  // initial POST (the original `space` prop never changes).
  const spaceIdRef = useRef(space.id || null)
  const [autoStatus, setAutoStatus] = useState('idle')   // 'idle' | 'saving' | 'saved' | 'error'
  const skipNextAutosave = useRef(true)
  const lastPayloadRef = useRef(null)

  // Strip transient `_ctx*` keys that we inject only at render time. They
  // can balloon the saved JSON and have no business in the persisted row.
  const cleanNodesForSave = (arr) => (arr || []).map((n) => {
    if (!n?.data) return n
    const cleaned = { ...n.data }
    for (const k of Object.keys(cleaned)) if (k.startsWith('_ctx')) delete cleaned[k]
    delete cleaned.__id
    return { ...n, data: cleaned }
  })

  const save = async ({ silent = false } = {}) => {
    if (!silent) { setBusy(true); setError(null) }
    setAutoStatus('saving')
    try {
      const id = spaceIdRef.current
      const cleanNodes = cleanNodesForSave(nodes)
      const r = await fetch('/api/spaces', {
        method: id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ id, profile_id: selectedProfileId, name, nodes: cleanNodes, edges }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Save failed')
      if (body.space?.id) spaceIdRef.current = body.space.id
      setAutoStatus('saved')
      setTimeout(() => setAutoStatus((s) => s === 'saved' ? 'idle' : s), 1500)
      if (!silent) onSave(body.space)
    } catch (e) {
      setAutoStatus('error')
      if (!silent) setError(e.message)
      else console.warn('autosave failed:', e.message)
    } finally { if (!silent) setBusy(false) }
  }

  // Autosave: debounce 1.2s after any change to name/nodes/edges, then PATCH.
  // Skips the very first render and dedupes by payload-equality so settled
  // state doesn't fire empty saves.
  useEffect(() => {
    if (skipNextAutosave.current) { skipNextAutosave.current = false; return }
    if (!session || !selectedProfileId) return
    // For brand-new empty spaces with no content yet, don't autosave.
    if (!spaceIdRef.current && nodes.length === 0 && edges.length === 0) return
    // Cheap structural fingerprint — id + type + serialized props (compact)
    // + position rounded to ints + edges shape. ~100× faster than
    // JSON.stringify of the full nodes array on big canvases with media.
    //
    // Includes data.status + a tiny output signature so completed runs
    // also trigger autosave — otherwise the rendered video URLs would
    // disappear on page refresh because the fingerprint stayed the same
    // through the entire idle → running → done transition.
    const outputSig = (o) => {
      if (!o || typeof o !== 'object') return ''
      const url = o.video?.video_url || o.video_url || ''
      const items = Array.isArray(o.items) ? o.items.length : 0
      const vids  = Array.isArray(o.videos) ? o.videos.length : 0
      const imgs  = Array.isArray(o.images) ? o.images.length : 0
      const cap   = o.caption ? o.caption.length : 0
      const txt   = o.full_script ? o.full_script.length : 0
      return `${url.slice(-40)}|${items}|${vids}|${imgs}|${cap}|${txt}`
    }
    const fp = [
      name,
      nodes.length,
      edges.length,
      ...nodes.map((n) => {
        const status = n.data?.status || 'idle'
        // Only let 'done' / 'failed' bump the fingerprint — 'running' is
        // transient and saving partial state is more confusing than useful.
        const persistedStatus = (status === 'done' || status === 'failed') ? status : 'idle'
        return `${n.id}|${n.data?.type}|${Math.round(n.position?.x || 0)},${Math.round(n.position?.y || 0)}|${n.data?.name || ''}|${propsHashShort(n.data?.props)}|${persistedStatus}|${outputSig(n.data?.output)}`
      }),
      ...edges.map((e) => `${e.source}-${e.target}-${e.targetHandle || 'in'}`),
    ].join('::')
    if (fp === lastPayloadRef.current) return
    const t = setTimeout(() => {
      lastPayloadRef.current = fp
      save({ silent: true })
    }, 1200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, nodes, edges, session, selectedProfileId])

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
    setRunning(true); setError(null); abortRunRef.current = false
    setNodes((arr) => arr.map((n) => ({ ...n, data: { ...n.data, status: 'idle', output: null, error: null } })))

    const ctx = { token: session.access_token, profileId: selectedProfileId, avatars, profiles, shouldAbort: () => abortRunRef.current }
    const snapshot = safeClone({ nodes, edges })
    const startedAt = Date.now()
    const runId = await recordRunStart({ triggered_by: 'manual', node_count: snapshot.nodes.length })
    try {
      const result = await runSpace({
        ctx,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        onNodeChange: patchNode,
      })
      if (!result.ok) {
        const msg = Object.entries(result.errors).map(([id, e]) => `${id}: ${e}`).join(' · ')
        setError(msg || 'One or more nodes failed')
      }
      // Auto-spawn collections for terminal video_polish nodes so the
      // freshly-rendered clip has a place to land on the canvas.
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
    } finally {
      setRunning(false)
    }
  }

  // Run a node + all its ancestors AND all its descendants. The ancestor walk
  // ensures we have fresh upstream values; the descendant walk auto-pushes
  // the new output forward so anything connected downstream (collection,
  // caption gen, save library, etc.) updates without a separate click.
  const runFromNode = useCallback(async (targetId) => {
    // Read the live ref instead of the closure-captured `running` state —
    // the immediate auto-run tick can fire before React has propagated
    // the state to this useCallback's closure, causing a phantom bounce.
    if (runningRef.current) return
    const want = new Set([targetId])
    // BFS up — collect ancestors
    const upQueue = [targetId]
    while (upQueue.length) {
      const id = upQueue.shift()
      for (const e of edges) {
        if (e.target === id && !want.has(e.source)) {
          want.add(e.source); upQueue.push(e.source)
        }
      }
    }
    // BFS down — collect descendants so output cascades forward
    const downQueue = [targetId]
    while (downQueue.length) {
      const id = downQueue.shift()
      for (const e of edges) {
        if (e.source === id && !want.has(e.target)) {
          want.add(e.target); downQueue.push(e.target)
        }
      }
    }
    const subsetNodes = nodes.filter((n) => want.has(n.id))
    const subsetEdges = edges.filter((e) => want.has(e.source) && want.has(e.target))
    if (!subsetNodes.length) return

    setRunning(true); setError(null); abortRunRef.current = false
    // Build the descendant set (everything downstream of the target) so we
    // can force-reset them when triggered by auto_run. For an auto_run
    // tick we want a FRESH chain on every fire — same cached-done short
    // circuit that's perfect for "re-run combine_videos without re-paying
    // for avatar render" would otherwise just re-emit the same script
    // every hour.
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

    // Smart reset rules:
    //  • The target is always reset so it actually re-runs.
    //  • For auto_run triggers, every descendant is also force-reset so
    //    each tick produces fresh content (new script, new render, etc).
    //  • For per-node manual runs, descendants stay cached when they're
    //    already 'done' — saves credits when you re-run a single node
    //    upstream and just want the cascade to re-thread.
    setNodes((arr) => arr.map((n) => {
      if (!want.has(n.id)) return n
      const forceReset = n.id === targetId || (isAutoTrigger && descendants.has(n.id))
      const isCached = !forceReset && n.data?.status === 'done' && n.data?.output
      if (isCached) return n
      return { ...n, data: { ...n.data, status: 'idle', output: null, error: null } }
    }))
    const ctx = { token: session.access_token, profileId: selectedProfileId, avatars, profiles, shouldAbort: () => abortRunRef.current, runFromTargetId: targetId }
    const snapshot = safeClone({ nodes: subsetNodes, edges: subsetEdges })
    const startedAt = Date.now()
    const triggerType = nodes.find((n) => n.id === targetId)?.data?.type === 'auto_run' ? 'auto_run' : 'per_node'
    const runId = await recordRunStart({ triggered_by: triggerType, node_count: snapshot.nodes.length })
    try {
      const result = await runSpace({ ctx, nodes: snapshot.nodes, edges: snapshot.edges, onNodeChange: patchNode })
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
    } finally {
      setRunning(false)
    }
  }, [running, nodes, edges, session, selectedProfileId, avatars, patchNode, refreshCredits, ensureCollectionForVideoPolish])

  // Expose runFromNode + abort through globals so SpaceNode header buttons
  // can call them without prop drilling.
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.__spaceRunFromNode = runFromNode
    window.__spaceAbortRun = () => { abortRunRef.current = true }
    return () => { window.__spaceRunFromNode = null; window.__spaceAbortRun = null }
  }, [runFromNode])

  // ── Auto-run drivers ──────────────────────────────────────────────────────
  // For every active auto_run node, schedule a setInterval that fires
  // runFromNode(node.id), increments the run counter, and disables itself
  // once max_runs is reached. Closing the tab pauses naturally because the
  // interval is bound to this React tree.
  const runFromNodeRef = useRef(runFromNode)
  useEffect(() => { runFromNodeRef.current = runFromNode }, [runFromNode])

  useEffect(() => {
    const activeTriggers = nodes.filter((n) => n.data?.type === 'auto_run' && n.data?.props?.active)
    if (!activeTriggers.length) return
    const timers = []
    const firstTickTimers = []
    for (const trig of activeTriggers) {
      const opt = AUTORUN_OPTIONS.find((o) => o.id === trig.data.props.cadence) || AUTORUN_OPTIONS[2]
      const id = trig.id
      const tick = async () => {
        const live = nodesRef.current.find((n) => n.id === id)
        if (!live || !live.data?.props?.active) return
        // If a previous run is still in flight (the cadence is shorter
        // than how long a single run takes), DROP this tick instead of
        // counting it. Otherwise the counter advances while runFromNode
        // gets rejected by its own `if (running) return` guard, which
        // looks like the run "happened" without anything actually firing.
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
        // Increment + record before run so concurrent ticks (which we now
        // guard against above) can't double-fire even if scheduling drifts.
        patchNode(id, { props: { ...live.data.props, runs_used: used + 1, last_run_at: new Date().toISOString() } })
        toast({ kind: 'info', message: `Auto-run firing (${used + 1} / ${cap}) — running the workflow…` })
        try {
          await runFromNodeRef.current(id)
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('auto-run tick failed:', e.message)
          toast({ kind: 'error', message: `Auto-run failed: ${e.message}` })
        }
      }
      // Immediate tick on activation, but pushed to a microtask so React
      // has finished applying the state change that flipped `active=true`
      // before we read nodesRef. Otherwise the very first tick can race
      // and read stale `active=false`.
      firstTickTimers.push(setTimeout(tick, 50))
      timers.push(setInterval(tick, opt.ms))
    }
    return () => {
      firstTickTimers.forEach((t) => clearTimeout(t))
      timers.forEach((t) => clearInterval(t))
    }
    // We deliberately don't depend on `nodes` (would re-create the timer on
    // every node update). Watch only the active-trigger fingerprint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.map((n) => n.data?.type === 'auto_run' ? `${n.id}|${n.data.props?.active ? 1 : 0}|${n.data.props?.cadence}|${n.data.props?.max_runs}` : '').join(',')])


  // Esc closes the preview modal.
  useEffect(() => {
    if (!previewItem) return
    const onKey = (e) => { if (e.key === 'Escape') setPreviewItem(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewItem])

  // Inject ctx slices into nodes that need them at render time (avatars for
  // AvatarPicker, profiles for BrandProfile).
  const renderNodes = useMemo(
    () => nodes.map((n) => {
      const t = n.data?.type
      if (t === 'avatar_picker') return { ...n, data: { ...n.data, _ctxAvatars: avatars, _ctxPublicAvatars: publicAvatars } }
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
          _ctxIncomingDescriptionLength: descLen,
        } }
      }
      if (t === 'save_library') {
        // Walk back to see what kind of media is wired in (image / video /
        // text), and look up the active brand profile's synced_platforms.
        let kind = 'text'
        const seenS = new Set([n.id])
        const queueS = [n.id]
        while (queueS.length) {
          const id = queueS.shift()
          for (const e of edges) {
            if (e.target === id && !seenS.has(e.source)) {
              seenS.add(e.source); queueS.push(e.source)
              const src = nodes.find((s) => s.id === e.source)
              const out = src?.data?.output
              if (out?.video_url) kind = 'video'
              else if (Array.isArray(out?.images) && out.images.length && kind !== 'video') kind = 'image'
              else if (src?.data?.type === 'avatar_render' && kind !== 'video') kind = 'video'
              else if (src?.data?.type === 'image_gen' && kind !== 'video') kind = 'image'
            }
          }
        }
        const activeProfile = (profiles || []).find((p) => p.id === selectedProfileId)
        const synced = Array.isArray(activeProfile?.synced_platforms) ? activeProfile.synced_platforms : []
        return { ...n, data: { ...n.data, _ctxSyncedPlatforms: synced, _ctxDetectedKind: kind } }
      }
      if (t === 'auto_run') {
        // BFS down to compute estimated cost-per-run from the chain
        let cost = 0
        const seen = new Set([n.id])
        const queue = [n.id]
        while (queue.length) {
          const id = queue.shift()
          for (const e of edges) {
            if (e.source === id && !seen.has(e.target)) {
              seen.add(e.target); queue.push(e.target)
              const child = nodes.find((s) => s.id === e.target)
              if (!child) continue
              const ct = child.data?.type
              const base = NODE_COST_HINT[ct] || 0
              const mult = ct === 'image_gen' ? Math.max(1, Number(child.data?.props?.count || 1)) : 1
              cost += base * mult
            }
          }
        }
        return { ...n, data: { ...n.data, _ctxCostPerRun: cost } }
      }
      // Generators that take prompts get _ctxProfiles for @brand autocomplete.
      // image_gen also gets named upload images via BFS-back through edges.
      if (t === 'script_gen' || t === 'caption_gen' || t === 'image_gen') {
        const slim = (profiles || []).map((p) => ({ id: p.id, name: p.business_name }))
        if (t !== 'image_gen') {
          return { ...n, data: { ...n.data, _ctxProfiles: slim } }
        }
        const named = []
        const visited = new Set([n.id])
        const queue = [n.id]
        while (queue.length) {
          const id = queue.shift()
          for (const e of edges) {
            if (e.target === id && !visited.has(e.source)) {
              visited.add(e.source)
              const src = nodes.find((s) => s.id === e.source)
              if (src?.data?.type === 'image_upload') {
                for (const it of readImageItems(src.data?.props)) named.push(it)
              }
              queue.push(e.source)
            }
          }
        }
        return { ...n, data: { ...n.data, _ctxNamedImages: named, _ctxProfiles: slim } }
      }
      return n
    }),
    [nodes, edges, avatars, profiles, publicAvatars, selectedProfileId, connectedSocialPlatforms]
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

        {/* AI workflow build chat input — always available */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '0 4px 0 10px' }}>
          {nodes.length === 0 ? <Wand2 size={14} style={{ color: 'var(--red)' }} /> : <MessageSquare size={14} style={{ color: 'var(--red)' }} />}
          <input
            type="text"
            placeholder={nodes.length === 0
              ? "Describe a workflow (e.g. 'create scripts then turn them into avatar videos')"
              : "Tell the AI what to add or change…"}
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') aiBuild() }}
            disabled={aiBuilding}
            style={{
              flex: 1, height: 36,
              background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--text)', fontSize: 13, fontFamily: 'inherit',
            }}
          />
          <button
            onClick={aiBuild}
            disabled={aiBuilding || !aiPrompt.trim()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              height: 30, padding: '0 12px', borderRadius: 7,
              background: aiPrompt.trim() ? 'linear-gradient(135deg, var(--red), var(--red-dark))' : 'var(--surface-2)',
              color: aiPrompt.trim() ? '#fff' : 'var(--muted)',
              border: 'none', cursor: aiPrompt.trim() ? 'pointer' : 'not-allowed',
              fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 12,
            }}
          >
            {aiBuilding ? <span className="spinner" /> : <Send size={12} />}
            {nodes.length === 0 ? 'Build' : 'Update'}
          </button>
        </div>

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
        <button className="btn-ghost" onClick={() => setHistoryOpen(true)} title="Run history" style={{ padding: '6px 10px' }}>
          <History size={13} /> History
        </button>
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
        </ReactFlow>

        <FloatingPalette onAdd={(type) => addNode(type)} />

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
                data={node.data}
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
  const { session } = useAuth()
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

  const onCreate = () => setEditing({ id: null, name: 'Untitled space', nodes: [], edges: [] })

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
      <SpacesList spaces={spaces} onCreate={onCreate} onOpen={onOpen} onDelete={onDelete} onHistory={onHistory} onDuplicate={onDuplicate} error={error} />
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
    </>
  )
}
