// Spaces — node-based content workflow canvas. List view + builder.
// Built on @xyflow/react. Custom node renderer wraps each registered type
// in a ScaleSolo card, with input/output handles auto-derived from the
// registry.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ReactFlow, Controls, Background, Handle, Position, addEdge,
  applyNodeChanges, applyEdgeChanges, MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import {
  Plus, Play, Save, Trash2, ArrowLeft, Sparkles, Zap, Boxes, AlertCircle,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { useCredits } from '../context/CreditsContext.jsx'
import { NODE_REGISTRY, NODE_CATEGORIES, runSpace } from '../lib/space-nodes.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// Custom node renderer (one component for every registered type)

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
    marginLeft: 'auto',
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
      {/* Inputs */}
      {def.inputs.map((inp, i) => (
        <Handle
          key={`in-${inp.id}`}
          type="target"
          position={Position.Left}
          id={inp.id}
          style={{
            top: `${(i + 1) * inHandleSpacing}%`,
            background: def.color || 'var(--red)',
            width: 10, height: 10,
            border: '2px solid var(--surface)',
          }}
        >
          <span style={{
            position: 'absolute', left: 14, top: -7,
            fontSize: 9.5, color: 'var(--muted)',
            fontFamily: 'var(--font-display)', fontWeight: 600,
            whiteSpace: 'nowrap', pointerEvents: 'none',
            background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 4,
            border: '1px solid var(--border)',
          }}>{inp.label}</span>
        </Handle>
      ))}

      {/* Outputs */}
      {def.outputs.map((out, i) => (
        <Handle
          key={`out-${out.id}`}
          type="source"
          position={Position.Right}
          id={out.id}
          style={{
            top: `${(i + 1) * outHandleSpacing}%`,
            background: def.color || 'var(--red)',
            width: 10, height: 10,
            border: '2px solid var(--surface)',
          }}
        >
          <span style={{
            position: 'absolute', right: 14, top: -7,
            fontSize: 9.5, color: 'var(--muted)',
            fontFamily: 'var(--font-display)', fontWeight: 600,
            whiteSpace: 'nowrap', pointerEvents: 'none',
            background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 4,
            border: '1px solid var(--border)',
          }}>{out.label}</span>
        </Handle>
      ))}

      <div style={head}>
        <div style={{ width: 24, height: 24, borderRadius: 6, background: def.color || 'var(--red)', color: '#fff', display: 'grid', placeItems: 'center' }}>
          <Icon size={13} />
        </div>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12.5 }}>
          {def.label}
        </div>
        <span style={statusPill}>{status}</span>
      </div>
      <div style={{ padding: 12 }}>
        <Body data={data} onPatch={onPatch} />
      </div>
    </div>
  )
}

const NODE_TYPES = { space: SpaceNode }

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
// Palette (left rail)

function NodePalette({ onAdd }) {
  const grouped = useMemo(() => {
    const g = {}
    for (const [key, def] of Object.entries(NODE_REGISTRY)) {
      if (!g[def.category]) g[def.category] = []
      g[def.category].push({ key, def })
    }
    return g
  }, [])

  const categoryOrder = Object.entries(NODE_CATEGORIES).sort((a, b) => a[1].order - b[1].order)

  return (
    <aside style={{
      width: 220, flexShrink: 0,
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14,
      padding: 12, overflowY: 'auto',
      maxHeight: 'calc(100vh - 110px)',
    }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 10 }}>
        Nodes
      </div>
      {categoryOrder.map(([catKey, cat]) => (
        <div key={catKey} style={{ marginBottom: 14 }}>
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
                  padding: '8px 10px',
                  marginBottom: 4,
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
    </aside>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder

function SpaceBuilder({ space, onSave, onClose }) {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  const { refresh: refreshCredits } = useCredits()

  const [name, setName] = useState(space.name || 'Untitled space')
  const [nodes, setNodes] = useState(Array.isArray(space.nodes) ? space.nodes : [])
  const [edges, setEdges] = useState(Array.isArray(space.edges) ? space.edges : [])
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [avatars, setAvatars] = useState([])

  // Load avatars for the profile so the AvatarPicker node can list them.
  useEffect(() => {
    if (!session || !selectedProfileId) return
    fetch(`/api/avatars?profile_id=${selectedProfileId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => setAvatars(b.avatars || []))
      .catch(() => {})
  }, [session, selectedProfileId])

  // Wire the global patch helper used by node bodies (cheap escape hatch
  // that beats threading state through every reactflow component).
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.__spacePatchNode = (id, patch) => {
      setNodes((arr) => arr.map((n) => n.id === id ? { ...n, data: { ...n.data, props: { ...(n.data?.props || {}), ...patch } } } : n))
    }
    return () => { window.__spacePatchNode = null }
  }, [])

  const onNodesChange = useCallback((changes) => setNodes((nds) => applyNodeChanges(changes, nds)), [])
  const onEdgesChange = useCallback((changes) => setEdges((eds) => applyEdgeChanges(changes, eds)), [])
  const onConnect = useCallback((c) => setEdges((eds) => addEdge({ ...c, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed }, animated: true, style: { stroke: 'var(--red)', strokeWidth: 1.5 } }, eds)), [])

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

  const run = async () => {
    if (running) return
    setRunning(true); setError(null)
    // Reset all node statuses
    setNodes((arr) => arr.map((n) => ({ ...n, data: { ...n.data, status: 'idle', output: null, error: null } })))

    const ctx = { token: session.access_token, profileId: selectedProfileId, avatars }
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

  // Inject avatars into AvatarPicker nodes on render so they can show options.
  const renderNodes = useMemo(
    () => nodes.map((n) => n.data?.type === 'avatar_picker'
      ? { ...n, data: { ...n.data, _ctxAvatars: avatars } }
      : n),
    [nodes, avatars]
  )

  return (
    <div className="fade-up" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <NodePalette onAdd={(type) => addNode(type)} />

      <section className="card-flat" style={{ flex: 1, padding: 0, overflow: 'hidden', height: 'calc(100vh - 110px)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, borderBottom: '1px solid var(--border)' }}>
          <button className="btn-ghost" onClick={onClose}><ArrowLeft size={14} /> Spaces</button>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Space name" style={{ flex: 1, fontWeight: 600 }} />
          <button className="btn-secondary" onClick={save} disabled={busy}>
            {busy ? <span className="spinner" /> : <Save size={13} />} Save
          </button>
          <button className="btn-primary" onClick={run} disabled={running || nodes.length === 0}>
            {running ? <span className="spinner" /> : <Play size={13} />} Run workflow
          </button>
        </div>

        {error && (
          <div style={{ padding: '10px 14px', background: 'var(--red-soft)', color: 'var(--red)', fontSize: 12.5, borderBottom: '1px solid rgba(239,68,68,0.25)' }}>
            <AlertCircle size={13} style={{ verticalAlign: '-2px' }} /> {error}
          </div>
        )}

        <div
          style={{ flex: 1, position: 'relative' }}
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
            fitView
            defaultEdgeOptions={{ type: 'smoothstep', animated: true, style: { stroke: 'var(--red)', strokeWidth: 1.5 } }}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="var(--border)" gap={20} size={1} />
            <Controls position="bottom-left" />
          </ReactFlow>
          {nodes.length === 0 && (
            <div style={{
              position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
              textAlign: 'center', color: 'var(--muted)', pointerEvents: 'none', maxWidth: 380,
            }}>
              <Sparkles size={32} style={{ marginBottom: 12 }} />
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--text)', fontSize: 16, marginBottom: 6 }}>
                Build a content workflow
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                Drag a node from the left, drop it on the canvas, then drag handle to handle to wire it up. Hit <strong>Run workflow</strong> to execute the chain.
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Page

export default function Spaces() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
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
