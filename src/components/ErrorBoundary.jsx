// Top-level error boundary — catches any render-time exception below it
// and shows a recovery card instead of a white screen. Logs to the console
// so devs can still see the stack in Vercel logs / browser tools.
//
// React class component because hooks can't catch errors. Resetting via
// `key` change at the route level is the typical recover-without-reload
// pattern; we expose `reset` so the user can click "try again" without a
// hard refresh.

import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[ScaleSolo] caught render error:', error, info?.componentStack)
  }
  reset = () => this.setState({ error: null })

  render() {
    if (!this.state.error) return this.props.children
    const msg = String(this.state.error?.message || this.state.error || 'Unknown error')
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
            Something went wrong
          </h1>
          <p style={{ fontSize: 13.5, color: 'var(--muted, #aaa)', lineHeight: 1.5, margin: '0 0 14px' }}>
            ScaleSolo hit an unexpected error. Your work is autosaved — refreshing usually fixes it.
          </p>
          <pre style={{
            fontSize: 11, lineHeight: 1.45, color: 'var(--text-soft, #ddd)',
            background: 'var(--surface-2, #111)', border: '1px solid var(--border, #2a2a2e)',
            borderRadius: 8, padding: 10, margin: '0 0 16px', whiteSpace: 'pre-wrap',
            maxHeight: 160, overflowY: 'auto',
          }}>{msg}</pre>
          <div style={{ display: 'flex', gap: 8 }}>
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
          </div>
        </div>
      </div>
    )
  }
}
