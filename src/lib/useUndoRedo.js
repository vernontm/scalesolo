// useUndoRedo — bounded undo/redo for Spaces canvas state.
//
// Owns:
//   - past[] / future[] snapshot stacks (capped at HISTORY_CAP)
//   - keyboard shortcut wiring (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z),
//     skipped when focus is inside an input/textarea/contentEditable
//     so native text undo still works while typing
//
// Caller owns the actual nodes/edges state + setters. The hook
// snapshots before each user-initiated mutation via pushHistory(),
// then undo()/redo() flip the stacks and apply the snapshot.

import { useCallback, useEffect, useRef, useState } from 'react'

const HISTORY_CAP = 60

export function useUndoRedo({ nodesRef, edgesRef, setNodes, setEdges }) {
  const historyRef = useRef({ past: [], future: [] })
  // Tick state so the toolbar buttons re-evaluate disabled/enabled
  // when the stacks change. Value is unused; just a re-render trigger.
  const [, forceTick] = useState(0)
  const tick = () => forceTick((t) => t + 1)

  const pushHistory = useCallback(() => {
    const snap = {
      nodes: nodesRef.current.map((n) => ({ ...n, data: { ...(n.data || {}) } })),
      edges: edgesRef.current.map((e) => ({ ...e })),
    }
    historyRef.current.past.push(snap)
    if (historyRef.current.past.length > HISTORY_CAP) historyRef.current.past.shift()
    historyRef.current.future = []
    tick()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const undo = useCallback(() => {
    const past = historyRef.current.past
    if (!past.length) return
    const snap = past.pop()
    historyRef.current.future.push({
      nodes: nodesRef.current.map((n) => ({ ...n, data: { ...(n.data || {}) } })),
      edges: edgesRef.current.map((e) => ({ ...e })),
    })
    setNodes(snap.nodes)
    setEdges(snap.edges)
    tick()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const redo = useCallback(() => {
    const future = historyRef.current.future
    if (!future.length) return
    const snap = future.pop()
    historyRef.current.past.push({
      nodes: nodesRef.current.map((n) => ({ ...n, data: { ...(n.data || {}) } })),
      edges: edgesRef.current.map((e) => ({ ...e })),
    })
    setNodes(snap.nodes)
    setEdges(snap.edges)
    tick()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z = redo. Skip when focus is in
  // an editable element so native text undo keeps working.
  useEffect(() => {
    const isEditable = (el) => {
      if (!el) return false
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      if (el.isContentEditable) return true
      return false
    }
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey
      if (!meta || (e.key !== 'z' && e.key !== 'Z')) return
      if (isEditable(document.activeElement)) return
      e.preventDefault()
      if (e.shiftKey) redo(); else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  return {
    pushHistory,
    undo,
    redo,
    canUndo: historyRef.current.past.length > 0,
    canRedo: historyRef.current.future.length > 0,
    pastCount: historyRef.current.past.length,
    futureCount: historyRef.current.future.length,
  }
}
