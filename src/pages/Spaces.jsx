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
  ShieldCheck, Undo2, Redo2, CalendarClock,
} from 'lucide-react'
import { useRef } from 'react'
// (useEffect already imported above for other effects in this file)
import { supabase } from '../lib/supabase.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { useCredits, fmtCount } from '../context/CreditsContext.jsx'
import { useSpacesRun } from '../context/SpacesRunContext.jsx'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast, confirmDialog, chooseDialog } from '../components/Toast.jsx'
import {
  NODE_REGISTRY, NODE_CATEGORIES, downloadUrl, readImageItems,
  AUTORUN_OPTIONS, autoRunIntervalMs, NODE_COST_HINT, nodeCostLabel,
  findUpstreamVideoUrl, findUpstreamScript, findUpstreamLogoUrl,
  findUpstreamAvatarPicker, findUpstreamTextPost,
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

// Two-tone "ding" played when a server workflow finishes. We synthesize
// it with Web Audio instead of shipping an mp3 to keep the bundle lean
// and dodge format / autoplay quirks. Different intervals for success
// vs warn so a glance-away user can tell the outcome without looking.
//   success: rising fifth (G4 → D5), smooth + happy
//   warn:    falling minor third (F4 → D4), short + alerting
// Returns silently if AudioContext isn't available (older browsers /
// SSR) or the tab has never received a user gesture.
function playRunFinishChime(kind = 'success') {
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    const now = ctx.currentTime
    const tones = kind === 'success'
      ? [{ f: 587.33, t: 0.00 }, { f: 880.00, t: 0.14 }]   // D5 → A5
      : [{ f: 349.23, t: 0.00 }, { f: 261.63, t: 0.18 }]   // F4 → C4
    for (const { f, t } of tones) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = f
      // Quick attack, tail off ~0.35s so the chime doesn't drag.
      gain.gain.setValueAtTime(0, now + t)
      gain.gain.linearRampToValueAtTime(0.12, now + t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.35)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + t)
      osc.stop(now + t + 0.4)
    }
    // Free the context once the chime is done so we don't leak.
    setTimeout(() => { try { ctx.close() } catch {} }, 800)
  } catch { /* swallow — chime is best-effort */ }
}

// Pretty-print platforms like "TikTok, Instagram, YouTube" given an
// array of canonical lowercase ids.
function prettyPlatforms(arr) {
  const labels = {
    tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube',
    facebook: 'Facebook', linkedin: 'LinkedIn', threads: 'Threads',
    x: 'X', pinterest: 'Pinterest', bluesky: 'Bluesky',
  }
  return (Array.isArray(arr) ? arr : [])
    .map((id) => labels[id] || id)
    .join(', ')
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
  // Running nodes get a pulsing amber halo so progress is obvious at a
  // glance — applies whether the run is client-side or driven by the
  // Fly worker via Realtime (both paths set data.status='running').
  const isRunning = status === 'running'
  const card = {
    width: 280,
    background: 'var(--surface)',
    border: selected
      ? `1px solid ${def.color || 'var(--red)'}`
      : isRunning ? '1px solid rgba(245,158,11,0.65)'
      : (status === 'failed' ? '1px solid rgba(239,68,68,0.6)' : '1px solid var(--border)'),
    borderRadius: 12,
    boxShadow: selected ? '0 12px 30px rgba(0,0,0,0.45)' : '0 4px 14px rgba(0,0,0,0.18)',
    fontFamily: 'var(--font-body)',
    color: 'var(--text)',
    animation: isRunning ? 'spaceNodeRunPulse 1.6s ease-in-out infinite' : undefined,
    position: 'relative',
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

  // Carousel slot badge — populated by Spaces.renderNodes when this
  // node feeds a save_library's image carousel. Tells the user "this
  // generator's output is slide 3 / 7 in the final post" at a glance.
  // Range form ("3-5 / 7") shows when one node contributes multiple
  // slots (e.g. image_gen with count=3).
  const carouselSlot = data._ctxCarouselSlot

  return (
    <div style={card}>
      {carouselSlot && (
        <div
          title={
            carouselSlot.count > 1
              ? `Slides ${carouselSlot.start}–${carouselSlot.end} of ${carouselSlot.total} in the carousel`
              : `Slide ${carouselSlot.start} of ${carouselSlot.total} in the carousel`
          }
          style={{
            position: 'absolute',
            top: -10, left: -10,
            zIndex: 5,
            minWidth: 26, height: 26,
            padding: '0 8px',
            borderRadius: 999,
            background: '#2ecc71',
            color: '#0a0a0a',
            border: '2px solid var(--surface)',
            display: 'grid', placeItems: 'center',
            fontFamily: 'var(--font-display)',
            fontSize: 11, fontWeight: 800,
            letterSpacing: '0.02em',
            boxShadow: '0 2px 6px rgba(0,0,0,0.35)',
            pointerEvents: 'none',
          }}>
          {carouselSlot.count > 1
            ? `${carouselSlot.start}–${carouselSlot.end}`
            : carouselSlot.start}
        </div>
      )}
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
        <span style={{ ...statusPill, marginLeft: data.type === 'collection' ? 'auto' : 0, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {isRunning && <span aria-hidden style={{
            width: 6, height: 6, borderRadius: '50%',
            background: '#f59e0b',
            animation: 'pulse 1.2s ease-in-out infinite',
            display: 'inline-block',
          }} />}
          {status}
        </span>
      </div>
      {(() => {
        // Cost hint — small per-node estimate so the user knows what
        // Run will draw against their credits before they click it.
        // Hidden for free nodes (text input, brand picker, collection,
        // etc.) so the canvas isn't littered with "0 tokens" badges.
        const cost = nodeCostLabel(data.type)
        if (!cost) return null
        const isVideo = cost.pool === 'video'
        return (
          <div
            title="Approximate cost. The real charge depends on output length and runs against your video credits for avatar render, AI tokens for everything else."
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px',
              fontSize: 10.5, color: 'var(--muted)',
              background: isVideo ? 'rgba(245,158,11,0.08)' : 'rgba(168,85,247,0.08)',
              borderBottom: '1px solid var(--border)',
              fontFamily: 'var(--font-display)',
            }}
          >
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: isVideo ? '#f59e0b' : '#a855f7',
              flexShrink: 0,
            }} />
            <span>
              Costs <strong style={{ color: 'var(--text)' }}>{cost.amount}</strong> {cost.unit}
            </span>
          </div>
        )
      })()}
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
  // Active server schedules for this space (one row per auto_run
  // trigger node). Stop button issues a DELETE which the cron honors
  // immediately — next tick won't fire.
  const [schedules, setSchedules] = useState(null)
  const [stoppingId, setStoppingId] = useState(null)
  const reloadSchedules = async () => {
    if (!spaceId) { setSchedules([]); return }
    try {
      const r = await fetch(`/api/spaces/save-schedule?space_id=${spaceId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const b = await r.json().catch(() => ({}))
      setSchedules(Array.isArray(b.schedules) ? b.schedules.filter((s) => s.active) : [])
    } catch { setSchedules([]) }
  }
  useEffect(() => {
    if (!spaceId) { setRuns([]); return }
    fetch(`/api/spaces/runs?space_id=${spaceId}&limit=30`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((b) => setRuns(Array.isArray(b.runs) ? b.runs : []))
      .catch((e) => setError(e.message))
    reloadSchedules()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, token])

  const stopSchedule = async (sch) => {
    if (!spaceId || !sch?.trigger_node_id) return
    setStoppingId(sch.id)
    try {
      const r = await fetch(
        `/api/spaces/save-schedule?space_id=${encodeURIComponent(spaceId)}&trigger_node_id=${encodeURIComponent(sch.trigger_node_id)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      )
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error(b.error || `Stop failed (${r.status})`)
      }
      toast({ kind: 'success', message: 'Schedule stopped.' })
      await reloadSchedules()
    } catch (e) {
      toast({ kind: 'error', message: e.message || 'Could not stop schedule.' })
    } finally {
      setStoppingId(null)
    }
  }
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
          {/* Active server schedules — pinned above the run list so the
              user can stop a recurring auto-run without hunting for the
              trigger node on the canvas. Hidden when none are active. */}
          {Array.isArray(schedules) && schedules.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{
                fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11,
                textTransform: 'uppercase', letterSpacing: '0.08em',
                color: 'var(--muted)', marginBottom: 6,
              }}>
                Scheduled workflows
              </div>
              {schedules.map((s) => {
                const nextFire = s.next_fire_at ? new Date(s.next_fire_at) : null
                const intervalMin = Math.round((s.interval_ms || 0) / 60_000)
                const intervalLabel = intervalMin >= 60
                  ? `every ${(intervalMin / 60).toFixed(intervalMin % 60 ? 1 : 0)}h`
                  : `every ${intervalMin}m`
                return (
                  <div key={s.id} style={{
                    padding: '10px 12px', marginBottom: 8,
                    background: 'rgba(46,204,113,0.08)',
                    border: '1px solid rgba(46,204,113,0.35)',
                    borderRadius: 8,
                    display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                    <span style={{
                      width: 6, height: 6, borderRadius: 999, background: '#2ecc71',
                      flexShrink: 0, animation: 'pulse 2s ease-in-out infinite',
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12, color: '#2ecc71' }}>
                        Active · {intervalLabel} · Runs {s.runs_used}/{s.max_runs}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 2 }}>
                        {nextFire ? `Next fire: ${nextFire.toLocaleString()}` : 'Next fire pending'}
                      </div>
                      {s.last_error && (
                        <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 2 }}>
                          Last error: {s.last_error}
                        </div>
                      )}
                    </div>
                    <button
                      className="btn-secondary"
                      style={{ padding: '6px 12px', fontSize: 12 }}
                      disabled={stoppingId === s.id}
                      onClick={() => stopSchedule(s)}
                    >
                      {stoppingId === s.id ? <span className="spinner" /> : 'Stop'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
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
  const { isAdmin } = useAuth()
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
                        position: 'relative',
                      }}
                    >
                      {/* Admin-only direct-edit shortcut. Opens the
                          template row itself instead of cloning, so
                          changes propagate to every user's gallery on
                          their next fetch. Non-admins never see this. */}
                      {isAdmin && tpl.template_visibility === 'public' && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); navigate(`/spaces?id=${tpl.id}`) }}
                          title="Admin: open this public template for direct editing"
                          style={{
                            position: 'absolute', top: 6, right: 6,
                            padding: '3px 8px', borderRadius: 999,
                            background: 'rgba(46,204,113,0.16)',
                            border: '1px solid rgba(46,204,113,0.45)',
                            color: '#2ecc71', cursor: 'pointer',
                            fontFamily: 'var(--font-display)', fontSize: 10,
                            fontWeight: 700, letterSpacing: '0.04em',
                            textTransform: 'uppercase',
                          }}
                        >Edit template</button>
                      )}
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

// ActiveSchedulesPill — header chip showing how many workflows are
// currently set to fire on the server cron. Hover / click expands a
// popover with each schedule's name, next fire time, runs used, and
// last error (if any). Polls /api/spaces/save-schedule?all=1 on mount
// + every 30s. Hidden entirely when no schedules are active so we
// don't clutter the toolbar.
function ActiveSchedulesPill({ schedules, spaces, onOpenSpace }) {
  // Schedules now come in as a prop — SpacesList owns the fetch
  // because the card grid also needs to know which spaces are
  // scheduled. Sharing the data avoids two parallel fetches and
  // keeps the pill + the per-card badges in lockstep.
  const [open, setOpen] = useState(false)
  const popRef = useRef(null)

  // Click-outside to close.
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (popRef.current && !popRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const active = (schedules || []).filter((s) => s.active)
  if (!active.length) return null

  // Soonest fire — for the pill's secondary text. Schedules are
  // already sorted by next_fire_at asc on the server.
  const next = active[0]
  const etaText = (() => {
    if (!next?.next_fire_at) return ''
    const ms = new Date(next.next_fire_at).getTime() - Date.now()
    if (ms < 60_000) return 'firing soon'
    if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)} min`
    if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)} hr`
    return `in ${Math.round(ms / 86_400_000)} days`
  })()

  const spaceNameById = (id) => {
    const s = (spaces || []).find((sp) => sp.id === id)
    return s?.name || s?.template_name || 'Untitled space'
  }

  return (
    <div ref={popRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`${active.length} workflow${active.length === 1 ? '' : 's'} scheduled — click to view`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 10px', borderRadius: 999,
          background: 'rgba(46,204,113,0.12)',
          border: '1px solid rgba(46,204,113,0.45)',
          color: '#2ecc71', cursor: 'pointer',
          fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11,
          letterSpacing: '0.04em',
        }}
      >
        <span style={{
          width: 6, height: 6, borderRadius: 999, background: '#2ecc71',
          display: 'inline-block', animation: 'pulse 2s ease-in-out infinite',
        }} />
        <CalendarClock size={12} />
        {active.length} scheduled
        {etaText && <span style={{ color: 'var(--muted)', fontWeight: 500, marginLeft: 4 }}>· {etaText}</span>}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0,
          minWidth: 320, maxWidth: 420,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
          padding: 8, zIndex: 100,
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{
            padding: '6px 8px', fontSize: 10.5,
            fontFamily: 'var(--font-display)', fontWeight: 700,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            color: 'var(--muted)',
          }}>Active server schedules</div>
          {active.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => { setOpen(false); onOpenSpace?.(s.space_id) }}
              style={{
                textAlign: 'left',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 8, padding: 8, cursor: 'pointer',
                display: 'flex', flexDirection: 'column', gap: 2,
              }}
            >
              <div style={{
                fontSize: 12, fontFamily: 'var(--font-display)', fontWeight: 700,
                color: 'var(--text)',
              }}>{spaceNameById(s.space_id)}</div>
              <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                Next fire: {s.next_fire_at ? new Date(s.next_fire_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}
                {' · '}
                Runs {s.runs_used} / {s.max_runs}
              </div>
              {s.last_error && (
                <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 2 }}>
                  Last error: {String(s.last_error).slice(0, 100)}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SpacesList({ spaces, onCreate, onOpen, onDelete, onHistory, onDuplicate, error, token, profileId, onTemplatePicked }) {
  const [tab, setTab] = useState('mine')
  const [templates, setTemplates] = useState(null)
  const [tplError, setTplError] = useState(null)
  const [busyTplId, setBusyTplId] = useState(null)

  // Active server schedules across all of this user's spaces.
  // Used both by ActiveSchedulesPill (header dropdown) and by the
  // card grid below (per-space "Scheduled" badge). Polls every 30s
  // so the runs_used counts + next_fire_at countdowns stay current
  // while the user is on this page.
  const [schedules, setSchedules] = useState(null)
  useEffect(() => {
    if (!token) { setSchedules(null); return }
    let cancelled = false
    const fetchOnce = async () => {
      try {
        const r = await fetch('/api/spaces/save-schedule?all=1', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const body = await r.json().catch(() => ({}))
        if (!cancelled) setSchedules(Array.isArray(body.schedules) ? body.schedules : [])
      } catch {
        if (!cancelled) setSchedules([])
      }
    }
    fetchOnce()
    const t = setInterval(fetchOnce, 30_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [token])
  // space_id → first matching active schedule. Lookup is O(1) on
  // each card render. We pick the FIRST active schedule per space
  // because a single space can technically have multiple auto_run
  // nodes, but in practice ~one.
  const scheduleBySpaceId = useMemo(() => {
    const m = new Map()
    for (const s of (schedules || [])) {
      if (s.active && !m.has(s.space_id)) m.set(s.space_id, s)
    }
    return m
  }, [schedules])

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
        <ActiveSchedulesPill schedules={schedules} spaces={spaces} onOpenSpace={(id) => {
          const sp = (spaces || []).find((s) => s.id === id)
          if (sp) onOpen(sp)
        }} />
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
          {spaces.map((s) => {
            const activeSched = scheduleBySpaceId.get(s.id)
            return (
            <div
              key={s.id} className="card"
              role="button" tabIndex={0}
              aria-label={`Open space ${s.name || 'untitled'}`}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(s) } }}
              style={{
                cursor: 'pointer',
                // Scheduled spaces get a subtle green left border so
                // they pop in the grid without needing the user to
                // hunt for the badge.
                ...(activeSched ? { borderLeft: '3px solid #2ecc71' } : {}),
              }}
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
                {/* Active server schedule indicator. Pulsing-dot pill
                    so it reads as "currently live" not just "tagged". */}
                {activeSched && (
                  <span
                    title={`Scheduled · next fire ${new Date(activeSched.next_fire_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · runs ${activeSched.runs_used}/${activeSched.max_runs}`}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9.5,
                      letterSpacing: '0.06em', textTransform: 'uppercase',
                      padding: '2px 7px', borderRadius: 999,
                      background: 'rgba(46,204,113,0.16)', color: '#2ecc71',
                      border: '1px solid rgba(46,204,113,0.45)',
                    }}>
                    <span style={{
                      width: 5, height: 5, borderRadius: 999, background: '#2ecc71',
                      display: 'inline-block', animation: 'pulse 2s ease-in-out infinite',
                    }} />
                    Scheduled
                  </span>
                )}
              </div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{s.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Updated {fmtUpdated(s.updated_at)}</div>
              {/* When scheduled, show next fire time inline so the
                  user doesn't have to open the popover or the space. */}
              {activeSched?.next_fire_at && (
                <div style={{ fontSize: 11, color: '#2ecc71', marginTop: 4 }}>
                  Next fire: {new Date(activeSched.next_fire_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  {' · '}
                  Runs {activeSched.runs_used}/{activeSched.max_runs}
                </div>
              )}
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
            )
          })}
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
  // Account-wide music library shared across every brand profile.
  // Fetched once per Spaces mount + on session change. Injected into
  // video_polish nodes' _ctxMusicTracks so the dropdown can show the
  // user's tracks regardless of which brand is active.
  const [accountMusicTracks, setAccountMusicTracks] = useState([])
  useEffect(() => {
    if (!session?.access_token) { setAccountMusicTracks([]); return }
    let cancelled = false
    fetch('/api/account/music-tracks', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => {
        if (cancelled) return
        if (Array.isArray(b?.tracks)) setAccountMusicTracks(b.tracks)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [session?.access_token])

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
  // Live progress for SERVER-side runs (the kind /api/spaces/run-now
  // and the cron tick start). Tracks the currently-active space_runs
  // row for this space, fed by a Realtime subscription below. The
  // canvas patches each node's status off of node_progress as the
  // worker updates it; the bottom-right pill shows "N / total nodes".
  // null means no active server run for this space.
  const [serverRun, setServerRun] = useState(null)
  // Run IDs the user has explicitly dismissed via the X on the
  // finished-run summary panel. Persisted to localStorage so the
  // panel doesn't reappear on refresh, focus-refetch, polling tick,
  // or Realtime echo. applyRow checks this before re-rendering the
  // summary for an already-finalized run.
  const dismissedRunIdsRef = useRef(new Set())
  useEffect(() => {
    try {
      const raw = localStorage.getItem('scalesolo.spaces.dismissedRunIds')
      const arr = raw ? JSON.parse(raw) : []
      if (Array.isArray(arr)) dismissedRunIdsRef.current = new Set(arr)
    } catch {}
  }, [])
  const dismissRunId = (id) => {
    if (!id) return
    dismissedRunIdsRef.current.add(id)
    // Cap stored set at 50 most-recent IDs so the localStorage value
    // doesn't grow unboundedly for power users.
    const arr = Array.from(dismissedRunIdsRef.current).slice(-50)
    try { localStorage.setItem('scalesolo.spaces.dismissedRunIds', JSON.stringify(arr)) } catch {}
  }
  // Toast handle for the active server-run progress toast. We reuse
  // the same toast id so successive updates replace the previous one
  // instead of stacking. Cleared when the run finalizes.
  const serverRunToastIdRef = useRef(null)
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
      // Track the affected node's type so we can mirror video_polish
      // patches into profiles.polish_template (the bulk-upload Polish
      // settings modal reads the same column). One source of truth so
      // edits on either surface keep both in sync.
      let touchedVideoPolishProps = null
      setNodes((arr) => arr.map((n) => {
        if (n.id !== id) return n
        if (Object.prototype.hasOwnProperty.call(patch, '__name')) {
          const { __name, ...rest } = patch
          const nextData = { ...n.data, name: __name, props: { ...(n.data?.props || {}), ...rest } }
          if (hasRealPropChange) { nextData.status = 'idle'; nextData.output = null; nextData.error = null }
          if (n.data?.type === 'video_polish' && Object.keys(rest).length) touchedVideoPolishProps = rest
          return { ...n, data: nextData }
        }
        const nextData = { ...n.data, props: { ...(n.data?.props || {}), ...patch } }
        if (hasRealPropChange) { nextData.status = 'idle'; nextData.output = null; nextData.error = null }
        if (n.data?.type === 'video_polish') {
          // Drop transient/internal keys before persisting to the
          // brand template — _ctx* and edited_* shouldn't pollute it.
          const propsToMirror = Object.fromEntries(
            Object.entries(patch).filter(([k]) => !k.startsWith('_ctx') && !k.startsWith('edited_') && k !== '__name')
          )
          if (Object.keys(propsToMirror).length) touchedVideoPolishProps = propsToMirror
        }
        return { ...n, data: nextData }
      }))
      // Mirror to profiles.polish_template — fire-and-forget so the UI
      // stays snappy. Failure surfaces via console (not a toast, because
      // the canvas patch already succeeded locally and we don't want to
      // confuse the user about what saved).
      if (touchedVideoPolishProps && selectedProfileId && session?.access_token) {
        fetch(`/api/profiles?id=${encodeURIComponent(selectedProfileId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({
            // Server-side jsonb merge: send only the changed keys, the
            // existing template stays intact for everything else.
            polish_template: { __merge: true, ...touchedVideoPolishProps },
          }),
        }).catch((e) => console.warn('polish_template canvas-sync failed:', e?.message))
      }
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
    // Seed video_polish nodes from the brand's saved polish template
    // (shared with the bulk-upload Polish settings modal). Falls
    // through to def.initialProps for any keys not in the template.
    let seededProps = { ...(def.initialProps || {}) }
    if (type === 'video_polish') {
      const activeProfile = (profiles || []).find((p) => p.id === selectedProfileId)
      const tpl = activeProfile?.polish_template
      if (tpl && typeof tpl === 'object' && Object.keys(tpl).length) {
        seededProps = { ...seededProps, ...tpl }
      }
    }
    setNodes((arr) => [
      ...arr,
      {
        id,
        type: 'space',
        position: position || { x: 120 + arr.length * 40, y: 80 + arr.length * 60 },
        data: { type, props: seededProps, status: 'idle', output: null, error: null },
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

  // ── Copy / paste / duplicate selected nodes ─────────────────────────────
  // Cmd/Ctrl+C : snapshot every currently-selected node (plus the edges
  //              between them) into an in-memory clipboard.
  // Cmd/Ctrl+V : drop the snapshot back onto the canvas with fresh ids,
  //              an offset position so the copies don't sit on top of the
  //              originals, and the copies pre-selected (originals deselect).
  // Cmd/Ctrl+D : duplicate in place — copy + paste in one shortcut, useful
  //              when you want to fork a node without moving your hand.
  //
  // Skipped when focus is in an input / textarea / contenteditable so the
  // shortcuts don't steal Cmd+C from text fields.
  const clipboardRef = useRef({ nodes: [], edges: [] })

  const isEditableTarget = (el) => {
    if (!el) return false
    const tag = (el.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
    if (el.isContentEditable) return true
    return false
  }

  const copySelectedNodes = useCallback(() => {
    const selected = nodesRef.current.filter((n) => n.selected)
    if (!selected.length) return false
    const ids = new Set(selected.map((n) => n.id))
    // Only carry edges whose BOTH ends are in the selection — partial
    // edges would dangle once the copies land.
    const internalEdges = edgesRef.current.filter((e) => ids.has(e.source) && ids.has(e.target))
    clipboardRef.current = {
      nodes: safeClone(selected),
      edges: safeClone(internalEdges),
    }
    return true
  }, [])

  const pasteClipboard = useCallback((opts = {}) => {
    const { offset = 40 } = opts
    const buf = clipboardRef.current
    if (!buf?.nodes?.length) return false
    pushHistory()
    // Build a fresh id for each pasted node and a map old→new so we can
    // rewrite the internal edges.
    const idMap = new Map()
    const stamp = Date.now().toString(36)
    const newNodes = buf.nodes.map((n, i) => {
      const newId = `n_${stamp}_${i.toString(36)}_${Math.random().toString(36).slice(2, 5)}`
      idMap.set(n.id, newId)
      return {
        ...n,
        id: newId,
        position: { x: (n.position?.x || 0) + offset, y: (n.position?.y || 0) + offset },
        // Pre-select the copies so the user can immediately drag the group.
        selected: true,
        // Reset run state so the paste doesn't inherit stale status/output.
        data: { ...n.data, status: 'idle', output: null, error: null },
      }
    })
    const newEdges = buf.edges.map((e, i) => ({
      ...e,
      id: `e_${stamp}_${i.toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      source: idMap.get(e.source),
      target: idMap.get(e.target),
    }))
    setNodes((arr) => [
      // Deselect the originals so only the new copies are selected.
      ...arr.map((n) => (n.selected ? { ...n, selected: false } : n)),
      ...newNodes,
    ])
    if (newEdges.length) setEdges((arr) => [...arr, ...newEdges])
    return true
  }, [pushHistory])

  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.shiftKey || e.altKey) return
      if (isEditableTarget(e.target)) return
      const k = e.key.toLowerCase()
      if (k === 'c') {
        if (copySelectedNodes()) e.preventDefault()
      } else if (k === 'v') {
        if (pasteClipboard()) e.preventDefault()
      } else if (k === 'd') {
        // Duplicate in place: snapshot whatever's selected, paste with
        // an offset, in one keypress. No-op if nothing's selected.
        if (copySelectedNodes()) {
          pasteClipboard()
          e.preventDefault()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [copySelectedNodes, pasteClipboard])

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

  // Server-run live progress subscription. Subscribes to space_runs
  // INSERT + UPDATE for this space; when the worker (cron or manual
  // /api/spaces/run-now) advances the run, it writes node_progress
  // jsonb. We reflect that on the canvas by patching each node's
  // status (running / success / failed) and surface a bottom-right
  // progress panel showing N / total complete.
  //
  // Browser-orchestrated runs (per-node Run buttons) don't write to
  // node_progress, so they don't conflict with this subscription;
  // they keep using the in-memory patchNode path as before.
  useEffect(() => {
    const spaceId = spaceIdRef.current
    if (!spaceId) return
    let cancelled = false
    const applyRow = (row) => {
      if (cancelled || !row) return
      if (row.status === 'running') {
        const np = row.node_progress || {}
        const total = row.node_count || 0
        const completed = Object.values(np).filter((p) => p && (p.status === 'success' || p.status === 'failed')).length
        // How many are actively running RIGHT NOW (vs done or pending).
        // Drives the "6 running, the rest queue" hint on the panel.
        const running = Object.values(np).filter((p) => p && p.status === 'running').length
        setServerRun({ id: row.id, total, completed, running, triggered_by: row.triggered_by, started_at: row.started_at })
        // Reflect each node's progress on the canvas. We only patch
        // status (not output) because the worker holds the actual
        // result data — the canvas would need a separate fetch to
        // hydrate it. Statuses alone are enough for the highlight.
        for (const [nodeId, prog] of Object.entries(np)) {
          if (!prog?.status) continue
          // Hydrate node.data.output from the worker's serialized result
          // so per-node Run buttons (re-polish, re-caption, etc.) work
          // after a server-side run. Without this, downstream nodes
          // can't see upstream outputs and the user has to re-run the
          // whole graph just to tweak one step.
          // Translate worker status → canvas status. Worker emits
          // 'success'/'failed'/'running'; the canvas (SpaceNode pill,
          // collection seed, runFromNode prereq check) uses 'done'/
          // 'failed'/'running'. Skipping this translation here was the
          // bug behind "clicking Run on Save-to-drafts re-runs every
          // upstream image_gen" — chooseRunScope's allParentsCached
          // check looks for === 'done' and was failing on freshly-
          // finished server runs that left the canvas reading 'success'.
          const canvasStatus = prog.status === 'success' ? 'done' : prog.status
          const patch = { status: canvasStatus, error: prog.error || null }
          if (prog.output && typeof prog.output === 'object') patch.output = prog.output
          patchNode(nodeId, patch)
        }
      } else {
        // Run finalized. Final patch of each node to its terminal
        // status, then transition the bottom-right panel to a sticky
        // "Run finished" summary (the user closes it themselves).
        const np = row.node_progress || {}
        const total = row.node_count || Object.keys(np).length
        const completed = Object.values(np).filter((p) => p && p.status === 'success').length
        const failed = Object.values(np).filter((p) => p && p.status === 'failed').length
        for (const [nodeId, prog] of Object.entries(np)) {
          if (!prog?.status) continue
          // Hydrate node.data.output from the worker's serialized result
          // so per-node Run buttons (re-polish, re-caption, etc.) work
          // after a server-side run. Without this, downstream nodes
          // can't see upstream outputs and the user has to re-run the
          // whole graph just to tweak one step.
          // Translate worker status → canvas status. Worker emits
          // 'success'/'failed'/'running'; the canvas (SpaceNode pill,
          // collection seed, runFromNode prereq check) uses 'done'/
          // 'failed'/'running'. Skipping this translation here was the
          // bug behind "clicking Run on Save-to-drafts re-runs every
          // upstream image_gen" — chooseRunScope's allParentsCached
          // check looks for === 'done' and was failing on freshly-
          // finished server runs that left the canvas reading 'success'.
          const canvasStatus = prog.status === 'success' ? 'done' : prog.status
          const patch = { status: canvasStatus, error: prog.error || null }
          if (prog.output && typeof prog.output === 'object') patch.output = prog.output
          patchNode(nodeId, patch)
        }
        // Pull platforms from the schedule_post node's output (worker
        // mirrored its run() return into node_progress.output) so the
        // summary can show "Scheduled to TikTok, Instagram, YouTube".
        let postedPlatforms = []
        for (const prog of Object.values(np)) {
          const out = prog?.output
          if (Array.isArray(out?.platforms) && out.platforms.length && !postedPlatforms.length) {
            postedPlatforms = out.platforms
          }
        }
        // Resolve a human brand name for the summary header. Falls
        // back to the profile id slice when the brand list hasn't
        // been loaded yet (rare — Spaces page always loads profiles).
        const brandName = (profiles || []).find((p) => p.id === selectedProfileId)?.business_name
          || (selectedProfileId || '').slice(0, 8)
        const durationMs = row.duration_ms || (row.finished_at && row.started_at
          ? new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()
          : 0)
        // Skip rendering the summary panel if the user has already
        // dismissed THIS run id. Otherwise the panel pops back every
        // time the prime fetch / Realtime / focus-refetch / polling
        // re-applies the same completed row.
        if (dismissedRunIdsRef.current.has(row.id)) {
          // No-op for finished panel — but still let the canvas
          // catch up on per-node statuses via the loop above.
          return
        }
        // Show the summary panel. Don't clear it on errors either —
        // partial runs need just as much visibility as successes.
        setServerRun({
          finished: true,
          id: row.id,
          status: row.status, // success | partial | failed
          completed, failed, total,
          brand: brandName,
          duration_ms: durationMs,
          platforms: postedPlatforms,
          errors: Array.isArray(row.errors) ? row.errors : [],
          finished_at: row.finished_at,
        })
        // Audible ping. Different tones for success vs partial/failed
        // so a glance-away user still knows whether to come check the
        // canvas. Wrapped in try because Web Audio fails on tabs that
        // never received a user gesture (browser autoplay gate).
        try {
          const success = row.status === 'success'
          playRunFinishChime(success ? 'success' : 'warn')
        } catch { /* silent */ }
      }
    }
    // Prime: fetch the latest run (any status) so:
    //   - A remount mid-run catches up without waiting for a Realtime event.
    //   - A remount AFTER a server-side run has completed re-hydrates the
    //     node outputs from node_progress (the worker also merges these
    //     into spaces.nodes now, but this is a belt-and-suspenders backstop
    //     for already-completed runs from before that fix landed, and for
    //     the rare case where the merge-write fails).
    ;(async () => {
      try {
        const { data } = await supabase
          .from('space_runs')
          .select('id, status, node_count, node_progress, triggered_by, started_at, finished_at, duration_ms, errors')
          .eq('space_id', spaceId)
          .order('started_at', { ascending: false })
          .limit(1)
        const row = data?.[0]
        if (!row) return
        if (row.status === 'running') {
          applyRow(row)
        } else if (row.node_progress && Object.keys(row.node_progress).length) {
          // Completed run: silently hydrate node outputs AND statuses
          // from node_progress. Status is required for the self_only
          // run-from-node prereq check to recognize a parent as cached
          // — without it the user gets "X hasn't run yet" prompts on
          // every downstream Run click even though outputs are sitting
          // on the nodes. We translate worker statuses to canvas ones:
          //   success → done, failed → failed, anything else skipped.
          for (const [nodeId, prog] of Object.entries(row.node_progress)) {
            if (!prog) continue
            const patch = {}
            if (prog.status === 'success') {
              patch.status = 'done'
              patch.error = null
              if (prog.output && typeof prog.output === 'object') patch.output = prog.output
            } else if (prog.status === 'failed') {
              patch.status = 'failed'
              if (prog.error) patch.error = prog.error
            }
            if (Object.keys(patch).length) patchNode(nodeId, patch)
          }
        }
      } catch { /* ok */ }
    })()
    const channel = supabase
      .channel(`space_runs:${spaceId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'space_runs', filter: `space_id=eq.${spaceId}` },
        (payload) => applyRow(payload.new))
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'space_runs', filter: `space_id=eq.${spaceId}` },
        (payload) => applyRow(payload.new))
      .subscribe()

    // Failsafe 1: refetch on tab-focus. Realtime can silently drop the
    // websocket when the tab backgrounds (browser throttles, OS sleeps,
    // network blips). When the user returns, pull the latest row once
    // so they don't have to hit refresh.
    const refetchLatest = async () => {
      if (cancelled) return
      try {
        const { data } = await supabase
          .from('space_runs')
          .select('id, status, node_count, node_progress, triggered_by, started_at, finished_at, duration_ms, errors')
          .eq('space_id', spaceId)
          .order('started_at', { ascending: false })
          .limit(1)
        if (data?.[0]) applyRow(data[0])
      } catch { /* ok */ }
    }
    const onVisibility = () => { if (!document.hidden) refetchLatest() }
    document.addEventListener('visibilitychange', onVisibility)

    // Failsafe 2: light polling while a run is active. Auto-run fires
    // workflows on a cron — when the tab has been open for a while
    // Realtime may have died silently. Polling every 5s while there's
    // a running row makes sure progress visibly updates either way.
    // We back off to 30s when there's no active run so we don't hammer
    // the DB pointlessly.
    let pollTimer = null
    const pollTick = async () => {
      if (cancelled) return
      try {
        const { data } = await supabase
          .from('space_runs')
          .select('id, status, node_count, node_progress, triggered_by, started_at, finished_at, duration_ms, errors')
          .eq('space_id', spaceId)
          .order('started_at', { ascending: false })
          .limit(1)
        const row = data?.[0]
        if (row) applyRow(row)
        const isActive = row?.status === 'running'
        const nextDelay = isActive ? 5_000 : 30_000
        pollTimer = setTimeout(pollTick, nextDelay)
      } catch {
        // Don't let a transient error kill the loop entirely — back off
        // to 30s and try again.
        pollTimer = setTimeout(pollTick, 30_000)
      }
    }
    // First tick at 30s so we don't double up with the prime fetch above.
    pollTimer = setTimeout(pollTick, 30_000)

    return () => {
      cancelled = true
      try { channel.unsubscribe() } catch {}
      document.removeEventListener('visibilitychange', onVisibility)
      if (pollTimer) clearTimeout(pollTimer)
    }
    // patchNode is stable via useCallback. spaceIdRef.current change after
    // first save triggers a re-run via the spaceIdRef.current dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceIdRef.current])

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

  // The toolbar Run button dispatches to the Fly worker via
  // /api/spaces/run-now. The whole graph runs server-side, so the user
  // can close the tab the moment the toast appears and the workflow
  // keeps going. Per-node Run buttons (the small play arrows on each
  // node) still use the browser-orchestrated runFromNode below — those
  // are interactive "just re-run THIS step" actions that need live
  // canvas feedback.
  //
  // ── Upload-aware Run queue ─────────────────────────────────────────
  // Tracks in-flight uploads from ImageUploadBody nodes (broadcast via
  // 'scalesolo:upload-status' window events). When the user clicks Run
  // mid-upload, we don't fire immediately — instead we mark the run as
  // queued and auto-fire the moment every upload finishes. Lets users
  // hit Run as soon as they've kicked off the upload without losing any
  // pending files to a snapshot taken too early.
  const [uploadStatusByNode, setUploadStatusByNode] = useState({})  // nodeId → { total, completed, isUploading }
  const [runQueued, setRunQueued] = useState(false)

  useEffect(() => {
    const onStatus = (e) => {
      const d = e?.detail
      if (!d?.nodeId) return
      setUploadStatusByNode((prev) => {
        const next = { ...prev }
        if (!d.isUploading && d.total === 0) {
          delete next[d.nodeId]
        } else {
          next[d.nodeId] = { total: d.total, completed: d.completed, isUploading: d.isUploading }
        }
        return next
      })
    }
    window.addEventListener('scalesolo:upload-status', onStatus)
    return () => window.removeEventListener('scalesolo:upload-status', onStatus)
  }, [])

  const uploadSummary = useMemo(() => {
    let total = 0, completed = 0, active = 0
    for (const s of Object.values(uploadStatusByNode)) {
      total += s.total
      completed += s.completed
      if (s.isUploading) active += s.total - s.completed
    }
    return { total, completed, active, pending: total - completed }
  }, [uploadStatusByNode])

  // Auto-fire the queued run when uploads finish. Triggered by the
  // summary going from active>0 → active===0.
  useEffect(() => {
    if (!runQueued) return
    if (uploadSummary.active > 0) return
    // All uploads done — fire the actual run and clear the queue flag.
    setRunQueued(false)
    // Defer to next tick so the latest node.data.props.urls (just
    // patched by the upload handlers) has committed to React state
    // before snapshot.
    setTimeout(() => { runImmediate() }, 50)
  }, [runQueued, uploadSummary.active])

  // We require the space to be saved first because the worker's job
  // record links back to a real space_id. A "__transient__" id would
  // produce orphaned space_runs rows that the user can't find later.
  const runImmediate = async () => {
    if (running) return
    if (!spaceIdRef.current) {
      setError('Save the space first — server runs need a real space_id.')
      return
    }
    if (!nodes.length) return
    setError(null)
    const snapshot = safeClone({ nodes, edges })
    try {
      const r = await fetch('/api/spaces/run-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          space_id: spaceIdRef.current,
          profile_id: selectedProfileId,
          graph: { nodes: snapshot.nodes, edges: snapshot.edges },
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.error || `Run dispatch failed (${r.status})`)
      toast({
        kind: 'success',
        message: 'Run started on server. You can close the tab — the workflow keeps going.',
      })
      // Don't flip local `running` — there's no in-browser loop to spin
      // for. The space_runs row + Realtime will surface progress in the
      // Run history modal and the notifications bell.
    } catch (e) {
      setError(e.message || 'Could not start server run.')
      toast({ kind: 'error', message: e.message || 'Could not start server run.' })
    }
  }

  // Public Run wrapper. Handles three concerns before actually
  // dispatching:
  //   1. If a queued run is already pending and the user clicks again,
  //      cancel the queue (intuitive toggle).
  //   2. If uploads are still in flight, switch to "Queued" state and
  //      let the auto-fire effect dispatch when they finish.
  //   3. If the space hasn't saved yet (spaceIdRef.current is null) OR
  //      there are pending edits the 1.2s autosave debounce hasn't
  //      flushed, save first and wait — otherwise the first Run click
  //      bombed with "Save the space first" and only the SECOND click
  //      worked. Now one click "just runs."
  const run = async () => {
    if (runQueued) {
      setRunQueued(false)
      toast({ kind: 'info', message: 'Queued run cancelled.' })
      return
    }
    if (uploadSummary.active > 0) {
      setRunQueued(true)
      toast({
        kind: 'info',
        message: `Run queued — will start when ${uploadSummary.active} more upload${uploadSummary.active === 1 ? '' : 's'} finish${uploadSummary.active === 1 ? 'es' : ''}. Click Run again to cancel.`,
      })
      return
    }
    // Force-save when we don't have an id yet OR the autosave debounce
    // is still pending changes. save() is idempotent + fast (~200ms),
    // sets spaceIdRef.current on its first POST so subsequent clicks
    // (and runImmediate below) read a real id.
    const needsSave = !spaceIdRef.current || autoStatus === 'saving' || autoStatus === 'error'
    if (needsSave) {
      try { await save({ silent: true }) }
      catch (e) { /* save() already set the error toast in non-silent mode; silent mode swallows */ }
    }
    runImmediate()
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

    // ── Multi-clip auto-route ──────────────────────────────────────────
    // Browser-orchestrated polish on multi-clip workflows hits Vercel
    // /api/videos/polish for each clip — that pile-up caused
    // FUNCTION_INVOCATION_FAILED + ENOSPC on Mind Rescue's 5-clip retry.
    // The server runner has in-process polishCore and handles fan-out
    // cleanly. Detect multi-clip up front and route there transparently.
    //
    // "Multi-clip" = any Upload media node with 2+ videos OR any node
    // whose data.output already has a multi-clip array (videos[] or
    // captions[] with length > 1).
    const isMultiClipGraph = (() => {
      for (const n of nodes) {
        if (n.data?.type === 'image_upload') {
          const urls = Array.isArray(n.data?.props?.urls) ? n.data.props.urls : []
          const videoCount = urls.filter((u) => u?.kind === 'video').length
          if (videoCount > 1) return true
        }
        const out = n.data?.output
        if (Array.isArray(out?.videos) && out.videos.length > 1) return true
        if (Array.isArray(out?.captions) && out.captions.length > 1) return true
      }
      return false
    })()

    if (isMultiClipGraph && spaceIdRef.current) {
      // Make sure the latest graph state is on the server before
      // dispatching. Silent save — Run button already gave visual
      // feedback. ~200ms.
      try { await save({ silent: true }) } catch {}
      const snapshot = safeClone({ nodes, edges })
      console.info('[runFromNode] multi-clip detected → dispatching to server', { targetId, scope })
      try {
        const r = await fetch('/api/spaces/run-now', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({
            space_id: spaceIdRef.current,
            profile_id: selectedProfileId,
            graph: { nodes: snapshot.nodes, edges: snapshot.edges },
            // self_only: re-run the target AND every descendant
            // (rerun_from_node_id semantics). Cached ancestors don't
            // re-execute (no token waste on caption_gen for a polish
            // retry), but downstream nodes DO re-run so schedule_post
            // sees the freshly polished URLs and submits new Upload-Post
            // jobs. Earlier version used run_only_target_id which only
            // re-ran the target — that left schedule_post stuck on a
            // stale cached single-post output and the new clips never
            // got submitted.
            rerun_from_node_id: scope === 'self_only' ? targetId : null,
          }),
        })
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body?.error || `Run dispatch failed (${r.status})`)
        toast({
          kind: 'success',
          message: scope === 'self_only'
            ? 'Re-running this node on the server. Closing the tab is safe — the worker keeps going.'
            : 'Running on server (multi-clip workflow). Closing the tab is safe — the worker keeps going.',
        })
        return
      } catch (e) {
        // Don't fall back to the browser path silently — that's the
        // path we're TRYING to dodge. Surface the dispatch error so
        // the user can retry / pick a different scope.
        setError(e.message || 'Could not dispatch multi-clip run to server.')
        toast({ kind: 'error', message: e.message || 'Could not dispatch multi-clip run to server.' })
        return
      }
    }
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
    // Stop button: aborts BOTH paths so it doesn't matter whether the
    // active run is browser-side or worker-side.
    //   1. runCtx.stopRun() flips the client-side abortRef so any in-
    //      browser runSpace loop bails at its next node boundary.
    //   2. POST /api/spaces/cancel-run flips space_runs.status to
    //      'cancelled' so the Fly worker's shouldAbort() poll bails at
    //      ITS next node boundary. Without this second call the Stop
    //      button looked broken on server runs (worker can't see the
    //      browser flag — they're different machines).
    window.__spaceAbortRun = async () => {
      runCtx.stopRun()
      const sid = serverRun?.id
      const tok = session?.access_token
      if (!sid || !tok) return
      try {
        await fetch('/api/spaces/cancel-run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
          body: JSON.stringify({ space_run_id: sid }),
        })
      } catch (e) {
        console.warn('[stop] cancel-run failed:', e?.message)
      }
    }
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
      // Accept either canvas status ('done') or worker status ('success')
      // so a freshly-finished server run is recognized as cached without
      // waiting for the status-translation step to land.
      const allParentsCached = directParents.every((pid) => {
        const p = nodesRef.current.find((n) => n.id === pid)
        const s = p?.data?.status
        return (s === 'done' || s === 'success') && p?.data?.output
      })
      // No parents → nothing to choose; just run.
      if (!hasParents) {
        window.__spaceUserClickAt = Date.now()
        return 'self_only'
      }
      // All parents already cached → user explicitly DOESN'T want to
      // re-run upstream. Skip the dialog and just run this node only.
      // Saves a click on Save-to-drafts / Schedule-post after a long
      // multi-clip image-gen run.
      if (allParentsCached) {
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
    // Re-bind on serverRun.id / session change so the Stop closure
    // always has the freshest active run id + auth token.
  }, [runFromNode, serverRun?.id, session?.access_token])

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
    // Browser-side local timer is now a strict fallback. When the
    // server schedule (Vercel cron + Fly worker) is in play, we
    // SKIP local firing entirely so we don't double-fire the
    // workflow and don't leave zombie space_runs rows when the
    // tab closes mid-run. The server cron handles everything; the
    // local timer was historical, kept for graceful degradation if
    // WORKFLOW_INTERNAL_SECRET / WORKER_URL aren't configured.
    //
    // The server schedule is "in play" whenever a scheduled_workflows
    // row exists for this trigger. We don't need to fetch it here —
    // the auto_run body's serverSchedule state already populates
    // /api/spaces/save-schedule GET on activation. As a simpler
    // proxy: if WORKER_URL is configured client-side via an env
    // flag, assume server schedule is active. For now, just skip
    // local firing entirely when active — the server schedule
    // wins.
    const SKIP_LOCAL_FIRING_WHEN_SERVER_ACTIVE = true
    if (SKIP_LOCAL_FIRING_WHEN_SERVER_ACTIVE) return
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
      // Output image count (when present) — drives carousel slot
      // numbering on upstream generator nodes; must recompute when an
      // image_gen finishes and produces N images.
      const imgLen = Array.isArray(n.data?.output?.images) ? n.data.output.images.length : 0
      // save_library's user-saved carousel order (image_order prop) —
      // reorders in the body must propagate to the slot badges.
      const order = t === 'save_library' && Array.isArray(n.data?.props?.image_order)
        ? n.data.props.image_order.join(',').slice(0, 200)
        : ''
      return `${n.id}|${t}|${hasOutput}|${imgLen}|${urls}|${order}`
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
    // Carousel slot assignment per upstream node:
    //   id → { start, end, total, fromSaveLibId }
    // For each save_library on the canvas, walk its incoming edges in
    // connection order, count each predecessor's emitted image URLs
    // (default 1 if the pred hasn't run yet), then apply the save_library's
    // saved image_order (URL list) so the badge on each generator node
    // reflects its slot in the FINAL carousel, not just edge order.
    // Used by SpaceNode to render a "1 / 7"-style numbered badge so the
    // user can see at a glance which gen feeds which slide.
    const carouselSlotByNodeId = new Map()
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

        // ── Carousel slot map for upstream nodes ──────────────────────
        // Skip when this save_library will be a video bundle — slot
        // numbers only make sense for image carousels.
        if (kind !== 'video') {
          // Predecessors in edge-array order. ReactFlow keeps edges in
          // insertion order, which is how the run engine builds
          // inputs.in too — so this matches actual save_library run
          // ordering before any user reorder is applied.
          const predEdges = edges.filter((e) => e.target === n.id)
          // Per-predecessor URL bag (preserves intra-pred ordering).
          // Fall back to a single placeholder for unrun predecessors so
          // they still get a slot number on the canvas before the
          // first run completes.
          const predRows = predEdges.map((e) => {
            const src = nodesById.get(e.source)
            const out = src?.data?.output
            let urls = []
            if (Array.isArray(out?.images)) urls = out.images.map((im) => im?.url).filter(Boolean)
            else if (out?.url && !out?.video_url) urls = [out.url]
            if (!urls.length) urls = [`__placeholder__${e.source}`]  // unrun pred → 1 slot
            return { predId: e.source, urls }
          }).filter((row) => row.predId)

          // Flatten in natural (edge) order.
          let flat = []
          for (const row of predRows) {
            for (const u of row.urls) flat.push({ url: u, predId: row.predId })
          }

          // Apply image_order (saved by SaveBody) if present. URLs in
          // image_order come first; everything else preserves natural
          // order. Mirrors save_library.run()'s own reorder logic so
          // the badges match what gets persisted.
          const savedOrder = Array.isArray(n.data?.props?.image_order) ? n.data.props.image_order : []
          if (savedOrder.length) {
            const have = new Map(flat.map((it) => [it.url, it]))
            const seen = new Set()
            const front = []
            for (const u of savedOrder) {
              const item = have.get(u)
              if (item && !seen.has(u)) { front.push(item); seen.add(u) }
            }
            const back = flat.filter((it) => !seen.has(it.url))
            flat = [...front, ...back]
          }

          // Assign slot numbers per predecessor — start, end, count.
          // A predecessor that emits multiple images (e.g. image_gen
          // with count=3) gets a range like "2-4" so the user can
          // see all the slots it covers.
          const total = flat.length
          const perPred = new Map()
          flat.forEach((it, i) => {
            const slot = i + 1
            const row = perPred.get(it.predId) || { slots: [], start: slot, end: slot }
            row.slots.push(slot)
            row.start = Math.min(row.start, slot)
            row.end = Math.max(row.end, slot)
            perPred.set(it.predId, row)
          })
          for (const [predId, row] of perPred) {
            // Only attach if not already claimed by another save_library
            // (predecessor that feeds two carousels — rare; first wins).
            if (carouselSlotByNodeId.has(predId)) continue
            carouselSlotByNodeId.set(predId, {
              start: row.start,
              end: row.end,
              count: row.slots.length,
              total,
              fromSaveLibId: n.id,
            })
          }
        }
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
    return { imageGenById, saveLibraryById, autoRunById, carouselSlotByNodeId }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structuralKey])

  // Inject ctx slices into nodes that need them at render time (avatars for
  // AvatarPicker, profiles for BrandProfile).
  const renderNodes = useMemo(
    () => nodes.map((n) => {
      const t = n.data?.type
      // Carousel slot badge — attaches to ANY node that feeds a
      // save_library's image carousel (image_gen, image_upload, etc).
      // Attached as _ctxCarouselSlot so SpaceNode can render a badge
      // without knowing the node type.
      const slot = bfsContexts.carouselSlotByNodeId.get(n.id)
      const withSlot = slot ? { ...n.data, _ctxCarouselSlot: slot } : n.data
      if (t === 'avatar_picker') return { ...n, data: { ...withSlot, _ctxAvatars: avatars, _ctxPublicAvatars: publicAvatars } }
      if (t === 'avatar_render') return { ...n, data: { ...withSlot, _ctxIsTrialing: subscriptionStatus === 'trialing' } }
      if (t === 'brand_profile') return { ...n, data: { ...withSlot, _ctxProfiles: profiles } }
      if (t === 'image_upload')  return { ...n, data: { ...withSlot, _ctxProfileId: selectedProfileId, _ctxToken: session?.access_token || null } }
      if (t === 'captions') {
        // Inline preview frame in the captions body needs the closest
        // upstream rendered video URL without reaching into the graph
        // from inside the ReactFlow custom node.
        return { ...n, data: {
          ...withSlot,
          _ctxProfileId: selectedProfileId,
          _ctxUpstreamVideoUrl: findUpstreamVideoUrl(n.id, nodes, edges),
        } }
      }
      if (t === 'video_polish') {
        // The polish editor uses upstream video + logo for the live
        // overlay preview, plus profile id for the watermark uploader.
        // Music tracks are pulled from the ACCOUNT-wide library
        // (user_profiles.music_tracks) so every brand the user owns
        // shares the same set of tracks in the dropdown.
        return { ...n, data: {
          ...withSlot,
          _ctxProfileId: selectedProfileId,
          _ctxUpstreamVideoUrl: findUpstreamVideoUrl(n.id, nodes, edges),
          _ctxUpstreamLogoUrl: findUpstreamLogoUrl(n.id, nodes, edges),
          _ctxMusicTracks: accountMusicTracks,
        } }
      }
      if (t === 'voice_gen') {
        // Body uses this to switch between avatar-voice mode (when an
        // avatar_picker is upstream) and standalone voice-picker mode.
        return { ...n, data: {
          ...withSlot,
          _ctxProfileId: selectedProfileId,
          _ctxHasAvatarUpstream: findUpstreamAvatarPicker(n.id, nodes, edges),
        } }
      }
      if (t === 'auto_run') {
        // Body uses _ctxSpaceId to fetch its server-side schedule
        // state from /api/spaces/save-schedule and show the live
        // next_fire_at / runs_used / last_error readout. _ctxIsTrialing
        // drives the trial overlay that locks the controls during the
        // $1 trial (auto-run is the "auto-scheduling" feature we hold
        // back until the trial converts).
        return { ...n, data: {
          ...withSlot,
          _ctxSpaceId: spaceIdRef.current || space?.id || null,
          _ctxIsTrialing: subscriptionStatus === 'trialing',
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
          ...withSlot,
          _ctxProfileId: selectedProfileId,
          _ctxConnectedPlatforms: connectedSocialPlatforms,
          _ctxBrandSchedule: activeProfile ? {
            timezone: activeProfile.timezone,
            posting_schedule: activeProfile.posting_schedule,
          } : null,
          _ctxBrandCTA: activeProfile?.brand_cta || '',
          _ctxIncomingDescriptionLength: descLen,
          _ctxIsTrialing: subscriptionStatus === 'trialing',
          // Lets the picker know to hide platforms that don't accept
          // text-only posts. Detected by walking upstream for any
          // text_post_gen node.
          _ctxUpstreamIsTextPost: findUpstreamTextPost(n.id, nodes, edges),
        } }
      }
      if (t === 'save_library') {
        // BFS result precomputed in bfsContexts; just attach + add the
        // brand-profile synced_platforms (cheap, not BFS-dependent).
        const kind = bfsContexts.saveLibraryById.get(n.id)?.kind || 'text'
        const activeProfile = (profiles || []).find((p) => p.id === selectedProfileId)
        const synced = Array.isArray(activeProfile?.synced_platforms) ? activeProfile.synced_platforms : []
        return { ...n, data: { ...withSlot, _ctxSyncedPlatforms: synced, _ctxDetectedKind: kind } }
      }
      if (t === 'auto_run') {
        const costPerRun = bfsContexts.autoRunById.get(n.id)?.costPerRun || 0
        return { ...n, data: { ...withSlot, _ctxCostPerRun: costPerRun } }
      }
      // Generators that take prompts get _ctxProfiles for @brand autocomplete.
      // image_gen also gets named upload images via BFS-back through edges
      // (precomputed in bfsContexts).
      if (t === 'script_gen' || t === 'caption_gen' || t === 'image_gen') {
        const slim = (profiles || []).map((p) => ({ id: p.id, name: p.business_name }))
        if (t !== 'image_gen') {
          return { ...n, data: { ...withSlot, _ctxProfiles: slim } }
        }
        const named = [...(bfsContexts.imageGenById.get(n.id)?.namedImages || [])]
        // Expose @brand-logo as a synthetic named image when the active brand
        // profile has a logo_url. Cheap O(1) lookup; no BFS.
        const activeProfileForLogo = (profiles || []).find((p) => p.id === selectedProfileId)
        if (activeProfileForLogo?.logo_url) {
          named.push({ name: 'brand-logo', url: activeProfileForLogo.logo_url })
        }
        return { ...n, data: { ...withSlot, _ctxNamedImages: named, _ctxProfiles: slim } }
      }
      return slot ? { ...n, data: withSlot } : n
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

  // Admin direct-edit banner: when the open space row is a public
  // template, surface a loud "you're editing the global template"
  // banner so the admin doesn't accidentally treat it like a regular
  // workflow. Autosave still writes the template row in place; future
  // user clones pick up the changes on next gallery load.
  const editingPublicTemplate = isAdmin && space?.is_template && space?.template_visibility === 'public'

  return (
    <div className="space-builder-overlay" style={overlayStyle}>
      {editingPublicTemplate && (
        <div style={{
          padding: '8px 16px',
          background: 'linear-gradient(135deg, rgba(46,204,113,0.18), rgba(46,204,113,0.10))',
          borderBottom: '1px solid rgba(46,204,113,0.45)',
          color: '#2ecc71',
          fontFamily: 'var(--font-display)', fontSize: 12.5, fontWeight: 700,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <ShieldCheck size={13} />
          Editing public template · changes apply to every user's gallery on their next load
        </div>
      )}
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
        <button
          className="btn-primary"
          onClick={run}
          disabled={running || nodes.length === 0}
          title={runQueued ? 'Click again to cancel the queued run' : (uploadSummary.active > 0 ? `Will queue — ${uploadSummary.active} upload${uploadSummary.active === 1 ? '' : 's'} still in flight` : 'Run the whole workflow on the server')}
          style={runQueued ? { background: 'rgba(245,158,11,0.20)', borderColor: 'rgba(245,158,11,0.5)', color: '#f59e0b' } : undefined}
        >
          {running ? <span className="spinner" />
            : runQueued ? <span className="spinner" />
            : <Play size={13} />}
          {' '}
          {runQueued
            ? `Queued · ${uploadSummary.completed}/${uploadSummary.total}`
            : 'Run'}
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

        {/* Live server-run progress panel. Two states:
              - running: pulsing green dot + progress bar
              - finished: sticky summary (success/partial/failed),
                stays until the user closes it
            Click X to dismiss. Running runs continue regardless of
            dismissal — closing only hides the chrome. */}
        {serverRun && !serverRun.finished && (
          <div
            role="status" aria-live="polite"
            style={{
              position: 'fixed', right: 16, bottom: 88, zIndex: 90,
              background: 'var(--surface)',
              border: '1px solid rgba(46,204,113,0.45)',
              borderRadius: 12, padding: '12px 14px',
              boxShadow: '0 12px 24px rgba(0,0,0,0.35)',
              minWidth: 240, maxWidth: 320,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{
                width: 8, height: 8, borderRadius: 999, background: '#2ecc71',
                animation: 'pulse 2s ease-in-out infinite', flexShrink: 0,
              }} />
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12.5, color: '#2ecc71', flex: 1 }}>
                Running on server
              </div>
              <button
                aria-label="Hide progress panel"
                onClick={() => setServerRun(null)}
                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0, fontSize: 14, lineHeight: 1 }}
              >×</button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-soft)', marginBottom: 6 }}>
              {serverRun.completed} / {serverRun.total} steps · {serverRun.triggered_by === 'manual_server' ? 'Manual run' : 'Auto-run'}
            </div>
            <div style={{
              height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden',
            }}>
              <div style={{
                width: `${serverRun.total ? (serverRun.completed / serverRun.total) * 100 : 0}%`,
                height: '100%', background: '#2ecc71', transition: 'width 0.4s ease',
              }} />
            </div>
            {/* Concurrency hint — only shows while there's still work
                queued behind the parallel cap (running >= 6 means we're
                at the wall and at least one node is waiting). */}
            {serverRun.running >= 6 && (serverRun.total - serverRun.completed - serverRun.running) > 0 && (
              <div style={{ fontSize: 10.5, color: 'var(--text-soft)', marginTop: 6, lineHeight: 1.4 }}>
                {serverRun.running} are running. The next one starts as soon as one finishes.
              </div>
            )}
            <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>
              Safe to close the tab — the worker keeps going.
            </div>
          </div>
        )}

        {/* Finished-run summary panel. Stays mounted until the user
            X's it. Color + icon flip by outcome (success / partial /
            failed). Includes brand name, step count, duration,
            destination platforms, and a deep link to Schedule. */}
        {serverRun?.finished && (() => {
          const isSuccess = serverRun.status === 'success'
          const isPartial = serverRun.status === 'partial'
          const accent = isSuccess ? '#2ecc71' : isPartial ? '#f59e0b' : 'var(--red)'
          const badge = isSuccess ? '✓' : isPartial ? '⚠' : '✕'
          const headline = isSuccess
            ? 'Run finished'
            : isPartial ? 'Run finished with errors' : 'Run failed'
          const secs = Math.round((serverRun.duration_ms || 0) / 1000)
          const mins = Math.floor(secs / 60)
          const ss = String(secs % 60).padStart(2, '0')
          const durationLabel = mins > 0 ? `${mins}:${ss}` : `${secs}s`
          const platformsLabel = prettyPlatforms(serverRun.platforms)
          // Pretty-name the failing nodes. Downstream "Blocked by
          // upstream failure" entries are de-emphasized — the user
          // cares about the FIRST real cause, not the cascade.
          const allErrors = Array.isArray(serverRun.errors) ? serverRun.errors : []
          const realErrors = allErrors.filter((e) => !/blocked by upstream/i.test(e?.msg || ''))
          const cascadeCount = allErrors.length - realErrors.length
          const nodeLabel = (nodeId) => {
            const n = nodesRef.current?.find((x) => x.id === nodeId)
            return n?.data?.name || NODE_REGISTRY[n?.data?.type]?.label || nodeId?.slice(0, 8) || 'Unknown step'
          }
          const succeeded = Math.max(0, serverRun.total - allErrors.length)
          const stepsLine = isSuccess
            ? `${serverRun.completed ?? serverRun.total}/${serverRun.total} steps`
            : `${succeeded}/${serverRun.total} succeeded · ${realErrors.length} failed${cascadeCount ? `, ${cascadeCount} skipped` : ''}`
          return (
            <div
              role="status" aria-live="polite"
              style={{
                position: 'fixed', right: 16, bottom: 88, zIndex: 90,
                background: 'var(--surface)',
                border: `1px solid ${accent}`,
                borderRadius: 12, padding: '14px 16px',
                boxShadow: '0 14px 32px rgba(0,0,0,0.4)',
                minWidth: 280, maxWidth: 360,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
                <span style={{
                  flexShrink: 0, width: 22, height: 22, borderRadius: 999,
                  background: accent, color: '#000',
                  display: 'grid', placeItems: 'center',
                  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, lineHeight: 1,
                }}>{badge}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13.5, color: accent }}>
                    {headline}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 2 }}>
                    {serverRun.brand ? `${serverRun.brand} · ` : ''}{stepsLine} · {durationLabel}
                  </div>
                </div>
                <button
                  aria-label="Dismiss"
                  onClick={() => {
                    // Remember this run id so the panel doesn't pop
                    // back when prime-fetch / Realtime / polling
                    // re-applies the same finalized row.
                    dismissRunId(serverRun?.id)
                    setServerRun(null)
                  }}
                  style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0, fontSize: 16, lineHeight: 1 }}
                >×</button>
              </div>
              {/* Only show "Scheduled to ..." on actually-successful runs.
                  If the run failed before reaching schedule_post, the
                  platforms list is empty and showing a fake "scheduled
                  to ..." line is misleading. */}
              {platformsLabel && isSuccess && (
                <div style={{ fontSize: 11.5, color: 'var(--text-soft)', marginBottom: 8 }}>
                  Scheduled to {platformsLabel}
                </div>
              )}
              {/* Anchor each real error to the node that produced it,
                  with a click target that scrolls + focuses the node so
                  the user can fix the specific step. Downstream cascades
                  are mentioned but not enumerated. */}
              {realErrors.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  {realErrors.slice(0, 3).map((err, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        try {
                          // Open the node's editor drawer (same as
                          // clicking the settings icon on the card)
                          // so the user can read the error inline and
                          // tweak settings.
                          window.__spaceOpenEditor?.(err.nodeId)
                        } catch {}
                        // Same dismissal bookkeeping as the X button —
                        // clicking an error implicitly dismisses the
                        // summary, so persist that so it doesn't pop
                        // back on the next refetch.
                        dismissRunId(serverRun?.id)
                        setServerRun(null)
                      }}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left',
                        fontSize: 11, color: 'var(--red)', marginBottom: 6,
                        padding: '6px 8px', borderRadius: 6,
                        background: 'rgba(239,68,68,0.10)',
                        border: '1px solid rgba(239,68,68,0.3)',
                        cursor: 'pointer', fontFamily: 'inherit',
                        wordBreak: 'break-word',
                      }}
                    >
                      <strong>{nodeLabel(err.nodeId)}:</strong> {err.msg}
                    </button>
                  ))}
                  {realErrors.length > 3 && (
                    <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                      +{realErrors.length - 3} more error{realErrors.length - 3 === 1 ? '' : 's'}
                    </div>
                  )}
                  {cascadeCount > 0 && (
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>
                      {cascadeCount} downstream step{cascadeCount === 1 ? '' : 's'} skipped (blocked by upstream failure)
                    </div>
                  )}
                </div>
              )}
              {/* "Open Schedule" only makes sense when something actually
                  reached schedule_post. Hide on failed runs — they have
                  nothing scheduled. */}
              {platformsLabel && (
                <a
                  href="/schedule"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontFamily: 'var(--font-display)', fontWeight: 700,
                    fontSize: 11.5, color: accent, textDecoration: 'none',
                  }}
                >
                  Open Schedule →
                </a>
              )}
            </div>
          )
        })()}

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
              Build your workflow
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.55 }}>
              Drag nodes from the floating palette to wire up your pipeline.
              Two-finger trackpad pans the canvas. Cmd/Ctrl + scroll zooms.
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
  const [searchParams, setSearchParams] = useSearchParams()
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

  // URL-driven open. /spaces?id=<id> hydrates the builder from the
  // server on every mount, so refreshing the page (or sharing the
  // URL) drops you back into the same workflow you were editing.
  // When the user closes the builder we clear the param.
  const urlSpaceId = searchParams.get('id')
  useEffect(() => {
    if (!session) return
    if (!urlSpaceId) { setEditing(null); return }
    // Already showing this space? skip the fetch.
    if (editing?.id === urlSpaceId) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(`/api/spaces?id=${urlSpaceId}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
        const body = await r.json()
        if (cancelled) return
        if (r.ok) setEditing(body.space)
        else {
          // Unknown / no-access — drop the param so the user lands on
          // the list instead of getting stuck on a stale URL.
          setError(body.error || 'Failed to open')
          setSearchParams({}, { replace: true })
        }
      } catch (e) { if (!cancelled) setError(e.message) }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, urlSpaceId])

  const [creatingSpace, setCreatingSpace] = useState(false)
  const onCreate = () => setCreatingSpace(true)

  const onOpen = async (s) => {
    // Reflect the open space in the URL so a refresh keeps the user
    // in the same builder. The effect above handles the actual fetch.
    setSearchParams({ id: s.id }, { replace: false })
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
  if (editing) return <SpaceBuilder
    space={editing}
    onSave={(s) => {
      refresh()
      setEditing(s)
      // Keep the URL synced if a save mutated the row's id (e.g. a
      // newly-created space gets its first persisted id here).
      if (s?.id && s.id !== urlSpaceId) setSearchParams({ id: s.id }, { replace: true })
    }}
    onClose={() => {
      refresh()
      setEditing(null)
      // Drop the ?id= param so the back-to-list URL is clean and a
      // refresh from there stays on the list.
      if (urlSpaceId) setSearchParams({}, { replace: false })
    }}
  />
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
        onTemplatePicked={(space, guide) => {
          if (!space) { setEditing(null); return }
          setEditing({ ...space, template_guide: guide })
          if (space.id) setSearchParams({ id: space.id }, { replace: false })
        }}
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
