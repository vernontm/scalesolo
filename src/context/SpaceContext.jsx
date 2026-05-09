// SpaceContext — typed alternative to the `window.__space*` global escape
// hatches used to communicate between the SpaceBuilder shell and the
// individual node components rendered inside ReactFlow.
//
// Status: scaffolded but not yet wired. The existing window-global
// pattern in Spaces.jsx is closure-over-ref'd (so it's not actually
// stale-closure-prone), which makes the migration low-priority. When
// somebody touches that surface next, swap each `window.__space*`
// definition for an entry in the api object passed to SpaceProvider,
// and each `window.__space*?.()` consumer for `useSpace()?.method()`.
// Consumers null-check the result so a node rendered outside a
// builder (e.g. a static preview) doesn't crash.

import { createContext, useContext } from 'react'

// API surface:
//   patchNode(id, patch)              — partial update of node.data
//   patchOutput(id, output)           — replace node.data.output
//   disconnectEdge(edgeId)            — remove an edge by id
//   openPreview({ url, type })        — fullscreen media preview
//   openEditor(nodeId)                — right-rail node editor
//   addNodeFromItem({ url, type, from }) — drop a media item onto the canvas
//   syncBrandAll(brandId, enabled)    — toggle "sync to all generators"
//   runFromNode(nodeId, scope)        — kick a partial run
//   abortRun()                        — request the current run to halt
//   chooseRunScope(nodeId)            — async UI prompt → 'self_only' | 'downstream' | etc
const SpaceContext = createContext(null)

export function SpaceProvider({ value, children }) {
  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>
}

// Hook returns the API or null when used outside a builder. Consumers
// always null-check so static previews / mock renders don't blow up.
export function useSpace() {
  return useContext(SpaceContext)
}
