// Studio HyperFrames composition runtime.
//
// Every composition html loads this script. It does three things:
//
//   1. Reads variables from the URL hash:
//        composition.html#vars=<base64(JSON)>
//      Exposes them as window.__studioVars for the composition's
//      inline script to read.
//
//   2. Detects mode:
//        ?mode=render  → register the timeline on window.__timelines for
//                        the HyperFrames worker (single play, no loop).
//        default       → preview mode. Auto-plays + loops with a brief
//                        rest between cycles so the iframe in Studio
//                        stays animated for the user.
//
//   3. Provides studioPlay(timeline) which the composition calls once
//      it has built its GSAP timeline. Handles play / loop / render-mode
//      registration based on (2).
//
//   4. Injects a fallback brand stylesheet inline at the very top of the
//      document so even if /studio-compositions/_shared.css fails to
//      load (rewrite race, Network blip, cache poison), the iframe
//      still renders on the dark brand canvas with Plus Jakarta Sans.

;(function injectBrandFallback() {
  // Last-resort safety net. The composition HTML already inlines these
  // rules in <head>, and _shared.css repeats them; this JS injection is
  // pure paranoia for the case where the iframe somehow strips both.
  // No @import here — we self-host Plus Jakarta Sans via @font-face in
  // _shared.css. If shared.css fails to load, the iframe falls back to
  // system-ui which is still sans-serif (not the serif disaster we hit
  // with the old @import approach).
  const style = document.createElement('style')
  style.setAttribute('data-studio-fallback', '1')
  style.textContent = `
    html, body {
      width: 100% !important;
      height: 100% !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: hidden !important;
      background: #000 !important;
      color: #fff !important;
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif !important;
      -webkit-font-smoothing: antialiased;
    }
    * { box-sizing: border-box; }
  `
  document.head.insertBefore(style, document.head.firstChild)
})()

window.__studioVars = (function () {
  try {
    const hash = window.location.hash.replace(/^#/, '')
    const m = hash.match(/(?:^|&)vars=([^&]+)/)
    if (!m) return {}
    const decoded = decodeURIComponent(m[1])
    return JSON.parse(atob(decoded))
  } catch (e) {
    console.warn('[studio] vars parse failed:', e)
    return {}
  }
})()

window.__studioMode = (function () {
  const m = window.location.search.match(/[?&]mode=(\w+)/)
  return m ? m[1] : 'preview'
})()

// composition_id pulled from the document for runtime registration
window.__studioCompositionId = document.documentElement.getAttribute('data-composition-id') || null

window.studioPlay = function (timeline) {
  if (!timeline) return
  if (window.__studioMode === 'render') {
    window.__timelines = window.__timelines || {}
    if (window.__studioCompositionId) {
      window.__timelines[window.__studioCompositionId] = timeline
    }
    return
  }
  // Preview mode: play once, hold a beat, restart. We use a manual
  // re-trigger rather than repeat:-1 because the HyperFrames runtime
  // explicitly forbids infinite repeats in render mode and we want
  // identical timeline construction in both modes.
  const loop = () => {
    timeline.restart()
    timeline.eventCallback('onComplete', () => setTimeout(loop, 800))
  }
  loop()
}

// Tiny helper compositions use to apply variables to elements by id.
// Pass { titleId: { var: 'title', prop: 'textContent' }, … } shape.
window.studioApply = function (mapping) {
  for (const id of Object.keys(mapping)) {
    const el = document.getElementById(id)
    if (!el) continue
    const m = mapping[id]
    const value = window.__studioVars[m.var]
    if (value == null) continue
    if (m.prop === 'textContent') el.textContent = value
    else if (m.prop === 'innerHTML') el.innerHTML = value
    else if (m.prop?.startsWith('style.')) el.style[m.prop.slice(6)] = value
  }
}
