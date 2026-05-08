import { createContext, useContext, useRef, useState, useCallback } from 'react'
import { runSpace } from '../lib/space-nodes.jsx'

// SpacesRunContext — keeps a workflow run alive across route changes.
//
// Without this, navigating away from /spaces unmounts the page mid-run.
// The async runSpace() loop continues (it's just a chain of fetches), but
// every patchNode call hits a stale React component instance and the user
// sees no updates when they come back. This context owns the abort flag,
// the in-flight run, and a per-space cache of the latest node patches.
//
// On Spaces mount the page registers a "sink" — its live patchNode — for
// the space it's showing. The runner pushes every patch into the cache
// AND fans it out to the active sink. When the user navigates away, the
// sink is cleared but the cache keeps filling. When they return and the
// same space loads, getSnapshot() replays all cached patches against
// fresh node state so the UI rehydrates exactly where it left off.

const Ctx = createContext(null)

export function SpacesRunProvider({ children }) {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [currentSpaceId, setCurrentSpaceId] = useState(null)
  // Latest patch per node, scoped per space. Map<spaceId, Map<nodeId, patch>>
  const cacheRef = useRef(new Map())
  // Live consumer of patches — Spaces.jsx's patchNode. Cleared on unmount.
  const sinkRef = useRef({ spaceId: null, fn: null })
  const abortRef = useRef(false)
  // Listener fan-out for non-node updates: running flag, errors, etc.
  const listenersRef = useRef(new Set())

  const notify = () => { listenersRef.current.forEach((l) => { try { l() } catch {} }) }

  const setSink = useCallback((spaceId, fn) => {
    sinkRef.current = { spaceId: spaceId || null, fn: fn || null }
  }, [])

  const clearSink = useCallback((spaceId) => {
    if (sinkRef.current.spaceId === spaceId) sinkRef.current = { spaceId: null, fn: null }
  }, [])

  const getSnapshot = useCallback((spaceId) => {
    if (!spaceId) return null
    const m = cacheRef.current.get(spaceId)
    if (!m) return null
    return Object.fromEntries(m.entries())
  }, [])

  const clearCache = useCallback((spaceId) => {
    if (spaceId) cacheRef.current.delete(spaceId)
    else cacheRef.current.clear()
  }, [])

  const stopRun = useCallback(() => {
    abortRef.current = true
  }, [])

  // Patch interceptor handed to runSpace as onNodeChange. Caches the latest
  // patch per node, then forwards to the live sink if Spaces is mounted on
  // the originating spaceId.
  const makePatchHandler = (spaceId) => (nodeId, patch) => {
    let m = cacheRef.current.get(spaceId)
    if (!m) { m = new Map(); cacheRef.current.set(spaceId, m) }
    const prev = m.get(nodeId) || {}
    m.set(nodeId, { ...prev, ...patch })
    const sink = sinkRef.current
    if (sink.spaceId === spaceId && typeof sink.fn === 'function') {
      try { sink.fn(nodeId, patch) } catch (e) { console.warn('[SpacesRunCtx] sink threw', e) }
    }
  }

  // Execute a workflow. Returns the runSpace result. Safe to call without a
  // mounted sink — patches are still cached and will replay on remount.
  const executeRun = useCallback(async ({ spaceId, ctx, nodes, edges, onComplete }) => {
    if (running) {
      return { ok: false, errors: { _busy: 'A run is already in flight.' } }
    }
    abortRef.current = false
    // Bake shouldAbort into the runtime ctx so long polls can bail.
    const wrapped = { ...ctx, shouldAbort: () => abortRef.current || ctx?.shouldAbort?.() }
    setRunning(true); setError(null); setCurrentSpaceId(spaceId || null)
    notify()
    // Reset cache for this space — fresh run, fresh state.
    if (spaceId) cacheRef.current.set(spaceId, new Map())
    try {
      const result = await runSpace({
        ctx: wrapped,
        nodes,
        edges,
        onNodeChange: makePatchHandler(spaceId || '__transient__'),
      })
      try { onComplete?.(result) } catch {}
      if (!result.ok) {
        const msg = Object.entries(result.errors).map(([id, e]) => `${id}: ${e}`).join(' · ')
        setError(msg || 'Run had errors')
      }
      return result
    } catch (e) {
      setError(e.message || String(e))
      try { onComplete?.({ ok: false, errors: { _exception: e.message } }) } catch {}
      return { ok: false, errors: { _exception: e.message } }
    } finally {
      setRunning(false)
      notify()
    }
  }, [running])

  const value = {
    running,
    error,
    currentSpaceId,
    setSink,
    clearSink,
    getSnapshot,
    clearCache,
    stopRun,
    executeRun,
    abortRef,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSpacesRun() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useSpacesRun must be used inside <SpacesRunProvider>')
  return ctx
}
