// Sentry must initialize BEFORE React mounts so unhandled errors during
// the very first render still get captured. Top-of-file by design.
import { initSentry } from './lib/sentry.js'
initSentry()

// ── Stale-deploy auto-recover ─────────────────────────────────────────
// When Vite emits a new build it hashes every chunk filename, and the
// old index.html that the user's tab loaded points at chunks that no
// longer exist on the CDN. Lazy-loaded routes fail with:
//   "Failed to fetch dynamically imported module: …Content-Dy_UHl4j.js"
// (or "Importing a module script failed", "ChunkLoadError", etc.)
// when the user navigates AFTER a deploy. The fix the user sees is
// hard-reload — but they shouldn't need to know that.
//
// We listen for the unhandled rejection from the lazy import and, if
// it matches the stale-chunk shape, do one silent reload. The
// sessionStorage flag prevents an infinite reload loop in the rare
// case the new build itself is broken (network error, 503).
;(function autoRecoverFromStaleDeploy() {
  if (typeof window === 'undefined') return
  const STALE_PATTERNS = [
    /Failed to fetch dynamically imported module/i,
    /Importing a module script failed/i,
    /ChunkLoadError/i,
    /Loading chunk \d+ failed/i,
    /Loading CSS chunk/i,
  ]
  const isStaleChunkError = (msg) => STALE_PATTERNS.some((re) => re.test(String(msg || '')))
  const KEY = 'scalesolo:stale-deploy-reload-at'
  const RELOAD_COOLDOWN_MS = 30_000

  const handle = (msg) => {
    if (!isStaleChunkError(msg)) return false
    let lastAt = 0
    try { lastAt = parseInt(sessionStorage.getItem(KEY) || '0', 10) || 0 } catch {}
    if (Date.now() - lastAt < RELOAD_COOLDOWN_MS) return false  // already tried recently — give up
    try { sessionStorage.setItem(KEY, String(Date.now())) } catch {}
    // Force the browser to bypass its cache for index.html so the new
    // build's chunk references actually land. location.reload() with
    // no args is enough — Vercel's index.html has no-cache headers.
    setTimeout(() => { try { window.location.reload() } catch {} }, 50)
    return true
  }

  window.addEventListener('unhandledrejection', (e) => {
    handle(e?.reason?.message || e?.reason)
  })
  window.addEventListener('error', (e) => {
    handle(e?.message)
  })
})()

import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { ThemeProvider } from './context/ThemeContext.jsx'
import { AuthProvider } from './context/AuthContext.jsx'
import { ProfileProvider } from './context/ProfileContext.jsx'
import { CreditsProvider } from './context/CreditsContext.jsx'
import { AgentProvider } from './context/AgentContext.jsx'
import { SpacesRunProvider } from './context/SpacesRunContext.jsx'
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <ProfileProvider>
            <CreditsProvider>
              <AgentProvider>
                <SpacesRunProvider>
                  <App />
                </SpacesRunProvider>
              </AgentProvider>
            </CreditsProvider>
          </ProfileProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
)
