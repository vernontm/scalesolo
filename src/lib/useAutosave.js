// useAutosave — debounced autosave for Spaces canvases.
//
// Owns:
//   - autoStatus state ('idle' | 'saving' | 'saved' | 'error')
//   - debounce + payload-equality bail (so settled state doesn't fire empty saves)
//   - in-flight AbortController + generation counter so out-of-order
//     PATCH responses can never overwrite newer client state
//   - skip-first-render flag (don't autosave on mount)
//
// Caller owns spaceIdRef (mutated on first POST to make subsequent
// saves a PATCH), and handles busy / error UI by passing setters.
//
// Returns { autoStatus, save } — save() is callable directly for the
// "Save" button.

import { useEffect, useRef, useState } from 'react'

// Cheap fingerprint of a node's props for autosave dedupe. Skips
// transient `_ctx*` injections (these change every render and would
// trigger a save loop) and serializes only what the user can actually
// edit. We just need "did anything user-meaningful change."
const PROPS_SKIP_KEYS = new Set([
  '_ctxAvatars', '_ctxPublicAvatars', '_ctxProfiles', '_ctxNamedImages',
  '_ctxCostPerRun', '_ctxProfileId', '_ctxSyncedPlatforms', '_ctxDetectedKind',
  '_ctxUpstreamVideoUrl', '_ctxUpstreamScript', '_ctxUpstreamLogoUrl',
  '_ctxConnectedPlatforms', '_ctxBrandSchedule', '_ctxBrandCTA',
  '_ctxIncomingDescriptionLength', '_ctxIsTrialing',
])
function propsHashShort(p) {
  if (!p || typeof p !== 'object') return ''
  const parts = []
  for (const k of Object.keys(p).sort()) {
    if (PROPS_SKIP_KEYS.has(k)) continue
    const v = p[k]
    if (v == null) continue
    if (typeof v === 'string') parts.push(`${k}:${v.length}:${v.slice(0, 40)}`)
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}:${v}`)
    else if (Array.isArray(v)) parts.push(`${k}:[${v.length}]`)
    else parts.push(`${k}:{${Object.keys(v).length}}`)
  }
  return parts.join('|')
}

function outputSig(o) {
  if (!o || typeof o !== 'object') return ''
  const url = o.video?.video_url || o.video_url || ''
  const items = Array.isArray(o.items) ? o.items.length : 0
  const vids  = Array.isArray(o.videos) ? o.videos.length : 0
  const imgs  = Array.isArray(o.images) ? o.images.length : 0
  const cap   = o.caption ? o.caption.length : 0
  const txt   = o.full_script ? o.full_script.length : 0
  return `${url.slice(-40)}|${items}|${vids}|${imgs}|${cap}|${txt}`
}

// Strip transient `_ctx*` keys + __id that are injected only at render time.
function cleanNodesForSave(arr) {
  return (arr || []).map((n) => {
    if (!n?.data) return n
    const cleaned = { ...n.data }
    for (const k of Object.keys(cleaned)) if (k.startsWith('_ctx')) delete cleaned[k]
    delete cleaned.__id
    return { ...n, data: cleaned }
  })
}

export function useAutosave({
  spaceIdRef,            // ref<string|null>; mutated on first POST so subsequent saves PATCH
  name, nodes, edges,    // canvas state
  session,               // Supabase session for Authorization
  profileId,             // active brand profile
  onSave,                // called on a successful manual (non-silent) save with the new space row
  setBusy,               // optional setter for the global "saving" UI
  setError,              // optional setter for an error string
  debounceMs = 1200,
}) {
  const [autoStatus, setAutoStatus] = useState('idle')
  const skipNextAutosave = useRef(true)
  const lastPayloadRef = useRef(null)
  const saveGenRef = useRef(0)
  const saveAbortRef = useRef(null)

  const save = async ({ silent = false } = {}) => {
    if (saveAbortRef.current) {
      try { saveAbortRef.current.abort() } catch {}
    }
    const myGen = ++saveGenRef.current
    const ac = new AbortController()
    saveAbortRef.current = ac

    if (!silent) { setBusy?.(true); setError?.(null) }
    setAutoStatus('saving')
    try {
      const id = spaceIdRef.current
      const cleanNodes = cleanNodesForSave(nodes)
      const r = await fetch('/api/spaces', {
        method: id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ id, profile_id: profileId, name, nodes: cleanNodes, edges }),
        signal: ac.signal,
      })
      if (myGen !== saveGenRef.current) return
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Save failed')
      if (body.space?.id) spaceIdRef.current = body.space.id
      setAutoStatus('saved')
      setTimeout(() => setAutoStatus((s) => s === 'saved' ? 'idle' : s), 1500)
      if (!silent) onSave?.(body.space)
    } catch (e) {
      if (e?.name === 'AbortError') return
      if (myGen !== saveGenRef.current) return
      setAutoStatus('error')
      if (!silent) setError?.(e.message)
      else console.warn('autosave failed:', e.message)
    } finally {
      if (!silent && myGen === saveGenRef.current) setBusy?.(false)
      if (saveAbortRef.current === ac) saveAbortRef.current = null
    }
  }

  useEffect(() => {
    if (skipNextAutosave.current) { skipNextAutosave.current = false; return }
    if (!session || !profileId) return
    if (!spaceIdRef.current && nodes.length === 0 && edges.length === 0) return

    const fp = [
      name,
      nodes.length,
      edges.length,
      ...nodes.map((n) => {
        const status = n.data?.status || 'idle'
        const persistedStatus = (status === 'done' || status === 'failed') ? status : 'idle'
        return `${n.id}|${n.data?.type}|${Math.round(n.position?.x || 0)},${Math.round(n.position?.y || 0)}|${n.data?.name || ''}|${propsHashShort(n.data?.props)}|${persistedStatus}|${outputSig(n.data?.output)}`
      }),
      ...edges.map((e) => `${e.source}-${e.target}-${e.targetHandle || 'in'}`),
    ].join('::')

    if (fp === lastPayloadRef.current) return
    const t = setTimeout(() => {
      lastPayloadRef.current = fp
      save({ silent: true })
    }, debounceMs)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, nodes, edges, session, profileId])

  return { autoStatus, save }
}
