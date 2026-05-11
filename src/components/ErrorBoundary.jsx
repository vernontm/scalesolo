// Top-level error boundary — catches any render-time exception below it
// and shows a recovery card instead of a white screen. Logs to the console
// so devs can still see the stack in Vercel logs / browser tools.
//
// React class component because hooks can't catch errors. Resetting via
// `key` change at the route level is the typical recover-without-reload
// pattern; we expose `reset` so the user can click "try again" without a
// hard refresh.

import { Component } from 'react'

// Same shape-match the main.jsx auto-recover uses. Duplicated here
// because React Suspense / lazy-import rejections never propagate to
// window 'unhandledrejection' — they land in this boundary first, so
// the global listener never runs. Without the duplication, a deploy
// during an active session strands the user on a "Something went
// wrong" screen displaying the stale-chunk error.
const STALE_CHUNK_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /ChunkLoadError/i,
  /Loading chunk \d+ failed/i,
  /Loading CSS chunk/i,
]
const isStaleChunkError = (msg) =>
  STALE_CHUNK_PATTERNS.some((re) => re.test(String(msg || '')))

const RELOAD_KEY = 'scalesolo:stale-deploy-reload-at'
const RELOAD_COOLDOWN_MS = 30_000

// Try to silently reload the page on a stale-chunk error. Returns true
// if a reload was kicked off; false if we already tried recently (so
// the caller can fall through to the regular error UI).
function tryRecoverFromStaleChunk(error) {
  if (typeof window === 'undefined') return false
  const msg = error?.message || error
  if (!isStaleChunkError(msg)) return false
  let lastAt = 0
  try { lastAt = parseInt(sessionStorage.getItem(RELOAD_KEY) || '0', 10) || 0 } catch {}
  if (Date.now() - lastAt < RELOAD_COOLDOWN_MS) return false
  try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())) } catch {}
  setTimeout(() => { try { window.location.reload() } catch {} }, 50)
  return true
}

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    // Stale-chunk errors get a silent reload (handled in
    // componentDidCatch). Render normal error UI for everything else.
    // We can't kick off the reload from here — this method must be
    // pure — so just set state and let componentDidCatch fire the
    // reload below.
    return { error }
  }
  componentDidCatch(error, info) {
    if (tryRecoverFromStaleChunk(error)) {
      // Silent reload is on its way. Don't bother logging the
      // expected stale-chunk noise to Sentry / console.
      return
    }
    // eslint-disable-next-line no-console
    console.error('[ScaleSolo] caught render error:', error, info?.componentStack)
  }
  reset = () => this.setState({ error: null })

  render() {
    if (!this.state.error) return this.props.children
    const msg = String(this.state.error?.message || this.state.error || 'Unknown error')
    const isStale = isStaleChunkError(msg)
    return (
      <div role="alert" style={{
        minHeight: '100vh', display: 'grid', placeItems: 'center',
        padding: 24, background: 'var(--bg, #0b0b0b)', color: 'var(--text, #fff)',
      }}>
        <div style={{
          maxWidth: 480, width: '100%',
          background: 'var(--surface, #1a1a1c)',
          border: '1px solid var(--border, #2a2a2e)',
          borderRadius: 14, padding: 28,
          boxShadow: '0 18px 50px rgba(0,0,0,0.5)',
        }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>💥</div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, margin: '0 0 6px' }}>
            {isStale ? 'New version available' : 'Something went wrong'}
          </h1>
          <p style={{ fontSize: 13.5, color: 'var(--muted, #aaa)', lineHeight: 1.5, margin: '0 0 14px' }}>
            {isStale
              ? 'ScaleSolo just deployed an update. Reload to load the new build — your work is autosaved.'
              : 'ScaleSolo hit an unexpected error. Your work is autosaved — refreshing usually fixes it.'}
          </p>
          {!isStale && (
            <pre style={{
              fontSize: 11, lineHeight: 1.45, color: 'var(--text-soft, #ddd)',
              background: 'var(--surface-2, #111)', border: '1px solid var(--border, #2a2a2e)',
              borderRadius: 8, padding: 10, margin: '0 0 16px', whiteSpace: 'pre-wrap',
              maxHeight: 160, overflowY: 'auto',
            }}>{msg}</pre>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            {isStale ? (
              <button
                onClick={() => {
                  try { sessionStorage.removeItem(RELOAD_KEY) } catch {}
                  window.location.reload()
                }}
                className="btn-primary"
                style={{ flex: 1 }}
                autoFocus
              >Reload now</button>
            ) : (
              <>
                <button
                  onClick={this.reset}
                  className="btn-secondary"
                  style={{ flex: 1 }}
                >Try again</button>
                <button
                  onClick={() => { window.location.href = '/dashboard' }}
                  className="btn-primary"
                  style={{ flex: 1 }}
                >Go to dashboard</button>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }
}
