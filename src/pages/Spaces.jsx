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
  ZoomIn, ZoomOut, Maximize, Scissors, Download, X,
} from 'lucide-react'
import { useRef } from 'react'
// (useEffect already imported above for other effects in this file)
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { useCredits } from '../context/CreditsContext.jsx'
import { NODE_REGISTRY, NODE_CATEGORIES, runSpace, downloadUrl, readImageItems } from '../lib/space-nodes.jsx'

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
        <button
          type="button"
          title="Run this node (and any unrun upstream)"
          onClick={(e) => { e.stopPropagation(); window.__spaceRunFromNode?.(id) }}
          style={{
            marginLeft: 'auto',
            background: 'transparent', border: 'none',
            color: status === 'running' ? 'var(--amber)' : 'var(--muted)',
            cursor: status === 'running' ? 'wait' : 'pointer',
            padding: 4, borderRadius: 4, display: 'grid', placeItems: 'center',
          }}
          disabled={status === 'running'}
        ><Play size={12} /></button>
        <span style={statusPill}>{status}</span>
      </div>
      <div style={{ padding: 12 }}>
        <Body data={{ ...data, __id: id }} onPatch={onPatch} />
      </div>
    </div>
  )
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

function SpacesList({ spaces, onCreate, onOpen, onDelete, error }) {
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
            <div key={s.id} className="card" style={{ cursor: 'pointer' }} onClick={() => onOpen(s)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <Boxes size={16} style={{ color: 'var(--red)' }} />
              </div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{s.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Updated {new Date(s.updated_at).toLocaleDateString()}</div>
              <button className="btn-ghost" style={{ marginTop: 12, padding: '6px 10px', fontSize: 12 }} onClick={(e) => { e.stopPropagation(); onDelete(s) }}>
                <Trash2 size={12} /> Delete
              </button>
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
  const [nodes, setNodes] = useState(Array.isArray(space.nodes) ? space.nodes : [])
  const [edges, setEdges] = useState(
    Array.isArray(space.edges)
      ? space.edges.map((e) => ({ ...normalizeEdgeHandles(e), type: 'scissor' }))
      : []
  )
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [avatars, setAvatars] = useState([])
  const [publicAvatars, setPublicAvatars] = useState([])
  // AI workflow build
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiBuilding, setAiBuilding] = useState(false)
  const [previewItem, setPreviewItem] = useState(null)  // { url, type } for fullscreen preview

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
      .catch(() => {})
    fetch(`/api/avatars/heygen-library?profile_id=${selectedProfileId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => setPublicAvatars(Array.isArray(b.groups) ? b.groups : []))
      .catch(() => {})
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

  const save = async () => {
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/spaces', {
        method: space.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ id: space.id, profile_id: selectedProfileId, name, nodes, edges }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Save failed')
      onSave(body.space)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

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

  const run = async () => {
    if (running) return
    setRunning(true); setError(null)
    // Reset all node statuses
    setNodes((arr) => arr.map((n) => ({ ...n, data: { ...n.data, status: 'idle', output: null, error: null } })))

    const ctx = { token: session.access_token, profileId: selectedProfileId, avatars, profiles }
    // Snapshot the current nodes/edges since they may move during the run
    const snapshot = JSON.parse(JSON.stringify({ nodes, edges }))
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
      refreshCredits()
    } catch (e) {
      setError(e.message)
    } finally {
      setRunning(false)
    }
  }

  // Run a node + all its ancestors AND all its descendants. The ancestor walk
  // ensures we have fresh upstream values; the descendant walk auto-pushes
  // the new output forward so anything connected downstream (collection,
  // caption gen, save library, etc.) updates without a separate click.
  const runFromNode = useCallback(async (targetId) => {
    if (running) return
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

    setRunning(true); setError(null)
    // Reset just the subset
    setNodes((arr) => arr.map((n) => want.has(n.id) ? { ...n, data: { ...n.data, status: 'idle', output: null, error: null } } : n))
    const ctx = { token: session.access_token, profileId: selectedProfileId, avatars, profiles }
    const snapshot = JSON.parse(JSON.stringify({ nodes: subsetNodes, edges: subsetEdges }))
    try {
      const result = await runSpace({ ctx, nodes: snapshot.nodes, edges: snapshot.edges, onNodeChange: patchNode })
      if (!result.ok) {
        const msg = Object.entries(result.errors).map(([id, e]) => `${id}: ${e}`).join(' · ')
        setError(msg || 'Node run failed')
      }
      refreshCredits()
    } catch (e) {
      setError(e.message)
    } finally {
      setRunning(false)
    }
  }, [running, nodes, edges, session, selectedProfileId, avatars, patchNode, refreshCredits])

  // Expose runFromNode through the global so SpaceNode header buttons can call it.
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.__spaceRunFromNode = runFromNode
    return () => { window.__spaceRunFromNode = null }
  }, [runFromNode])

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
      if (t === 'image_gen') {
        // Walk back through edges to collect every image_upload's named
        // images so the body can show clickable @ chips for autocomplete.
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
        return { ...n, data: { ...n.data, _ctxNamedImages: named } }
      }
      return n
    }),
    [nodes, avatars, profiles, publicAvatars, selectedProfileId]
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

        <button className="btn-secondary" onClick={save} disabled={busy}>
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
    if (!confirm(`Delete "${s.name}"?`)) return
    try {
      await fetch(`/api/spaces?id=${s.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${session.access_token}` } })
      refresh()
    } catch (e) { setError(e.message) }
  }

  if (!selectedProfileId) {
    return <div className="card-flat fade-up" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      Pick a brand profile to manage spaces.
    </div>
  }
  if (loading && spaces.length === 0) return <div className="card-flat" style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
  if (editing) return <SpaceBuilder space={editing} onSave={(s) => { refresh(); setEditing(s) }} onClose={() => { refresh(); setEditing(null) }} />
  return <SpacesList spaces={spaces} onCreate={onCreate} onOpen={onOpen} onDelete={onDelete} error={error} />
}
