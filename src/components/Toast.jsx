// Lightweight toast + confirm replacement for native alert/confirm.
//
// Usage:
//   import { toast, confirmDialog } from '../components/Toast.jsx'
//   toast('Saved') | toast({ message: 'Failed', kind: 'error' })
//   const ok = await confirmDialog({ title: 'Delete?', confirmText: 'Delete' })
//
// One <ToastHost /> mount in App.jsx renders both stacks. No external deps.

import { useEffect, useState } from 'react'

let _toastDispatch = null
let _confirmDispatch = null

export function toast(input) {
  if (!_toastDispatch) {
    // Fallback during boot — use native alert so the user still sees it.
    // eslint-disable-next-line no-alert
    return alert(typeof input === 'string' ? input : input?.message || 'Notification')
  }
  const opts = typeof input === 'string' ? { message: input } : input
  _toastDispatch({ ...opts, id: Math.random().toString(36).slice(2) })
}

export function confirmDialog(opts) {
  return new Promise((resolve) => {
    if (!_confirmDispatch) {
      // Fallback to native confirm if host hasn't mounted yet.
      // eslint-disable-next-line no-alert
      resolve(window.confirm(opts?.title || 'Are you sure?'))
      return
    }
    _confirmDispatch({ ...opts, resolve })
  })
}

export default function ToastHost() {
  const [toasts, setToasts] = useState([])
  const [confirmState, setConfirmState] = useState(null)

  useEffect(() => {
    _toastDispatch = (t) => {
      setToasts((arr) => [...arr, t])
      const ttl = t.ttl ?? 4500
      if (ttl) setTimeout(() => {
        setToasts((arr) => arr.filter((x) => x.id !== t.id))
      }, ttl)
    }
    _confirmDispatch = (c) => setConfirmState(c)
    return () => { _toastDispatch = null; _confirmDispatch = null }
  }, [])

  const dismiss = (id) => setToasts((arr) => arr.filter((t) => t.id !== id))
  const closeConfirm = (ok) => {
    if (!confirmState) return
    confirmState.resolve(ok)
    setConfirmState(null)
  }

  // Esc closes the confirm dialog.
  useEffect(() => {
    if (!confirmState) return
    const onKey = (e) => { if (e.key === 'Escape') closeConfirm(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmState])

  return (
    <>
      <div
        aria-live="polite" aria-atomic="true"
        style={{
          position: 'fixed', right: 16, bottom: 16, zIndex: 200,
          display: 'flex', flexDirection: 'column', gap: 8,
          maxWidth: 'calc(100vw - 32px)',
        }}
      >
        {toasts.map((t) => {
          const tone = t.kind || 'info'
          const colors = {
            info:    { bg: 'var(--surface)', bd: 'var(--border)', fg: 'var(--text)' },
            success: { bg: 'rgba(46,204,113,0.12)', bd: 'rgba(46,204,113,0.45)', fg: '#2ecc71' },
            warn:    { bg: 'rgba(245,158,11,0.12)', bd: 'rgba(245,158,11,0.45)', fg: '#f59e0b' },
            error:   { bg: 'rgba(239,68,68,0.12)', bd: 'rgba(239,68,68,0.45)', fg: 'var(--red)' },
          }[tone]
          return (
            <div
              key={t.id}
              role="status"
              style={{
                background: colors.bg, border: `1px solid ${colors.bd}`,
                color: colors.fg, padding: '10px 14px', borderRadius: 10,
                boxShadow: '0 12px 24px rgba(0,0,0,0.35)',
                fontSize: 13, lineHeight: 1.45, minWidth: 240, maxWidth: 360,
                display: 'flex', alignItems: 'flex-start', gap: 10,
              }}
            >
              <div style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{t.message}</div>
              <button
                aria-label="Dismiss notification"
                onClick={() => dismiss(t.id)}
                style={{
                  background: 'transparent', border: 'none',
                  color: 'inherit', cursor: 'pointer', opacity: 0.7,
                  padding: 0, fontSize: 16, lineHeight: 1,
                }}
              >×</button>
            </div>
          )
        })}
      </div>
      {confirmState && (
        <div
          role="dialog" aria-modal="true" aria-labelledby="confirm-title"
          onClick={() => closeConfirm(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 220,
            background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
            display: 'grid', placeItems: 'center', padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: 400, width: '100%',
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 12, padding: 22,
              boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
            }}
          >
            <h2 id="confirm-title" style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 17, margin: '0 0 6px' }}>
              {confirmState.title || 'Are you sure?'}
            </h2>
            {confirmState.message && (
              <p style={{ fontSize: 13, color: 'var(--text-soft)', lineHeight: 1.5, margin: '0 0 16px', whiteSpace: 'pre-wrap' }}>
                {confirmState.message}
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={() => closeConfirm(false)}>
                {confirmState.cancelText || 'Cancel'}
              </button>
              <button
                className={confirmState.destructive ? 'btn-danger' : 'btn-primary'}
                style={confirmState.destructive ? { background: 'var(--red)', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 8, fontWeight: 700, cursor: 'pointer' } : undefined}
                onClick={() => closeConfirm(true)}
                autoFocus
              >
                {confirmState.confirmText || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
