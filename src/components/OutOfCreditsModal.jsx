// OutOfCreditsModal — global listener for credit-shortage events.
// Mounted once in App.jsx; any fetch / node run that hits a 402 with
// code 'insufficient_credits' dispatches a 'scalesolo:out-of-credits'
// window event with { required, have, message } detail. The modal
// pops with two actions: top up / upgrade.
//
// Using a window event (instead of context) keeps the dispatch site
// dependency-free — a node run() helper or a raw fetch error handler
// can pop the modal without threading a setter through the call
// chain.

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Zap, X } from 'lucide-react'

export default function OutOfCreditsModal() {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState(null)
  const navigate = useNavigate()

  useEffect(() => {
    const onEvent = (e) => {
      setDetail(e.detail || null)
      setOpen(true)
    }
    window.addEventListener('scalesolo:out-of-credits', onEvent)
    return () => window.removeEventListener('scalesolo:out-of-credits', onEvent)
  }, [])

  if (!open) return null

  const required = detail?.required
  const have = detail?.have
  const message = detail?.message || 'You ran out of video credits.'

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)',
        display: 'grid', placeItems: 'center', padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 460,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 16, padding: 24,
          boxShadow: '0 24px 48px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: 'rgba(245,158,11,0.16)',
            border: '1px solid rgba(245,158,11,0.45)',
            color: '#f59e0b',
            display: 'grid', placeItems: 'center', flexShrink: 0,
          }}>
            <Zap size={22} />
          </div>
          <div style={{ flex: 1 }}>
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, margin: 0 }}>
              Out of video credits
            </h3>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              Add more credits or move up a plan to keep generating.
            </div>
          </div>
          <button
            aria-label="Close"
            onClick={() => setOpen(false)}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--muted)', padding: 4,
            }}
          ><X size={18} /></button>
        </div>

        <div style={{
          padding: 14, borderRadius: 10,
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          fontSize: 13, lineHeight: 1.5, marginBottom: 18,
        }}>
          {message}
          {Number.isFinite(required) && Number.isFinite(have) && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
              This step needed <strong style={{ color: 'var(--text)' }}>{required} credits</strong> · you had <strong style={{ color: 'var(--text)' }}>{have}</strong>.
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            className="btn-secondary"
            onClick={() => setOpen(false)}
            style={{ padding: '8px 16px', fontSize: 13 }}
          >Maybe later</button>
          <button
            className="btn-primary"
            onClick={() => { setOpen(false); navigate('/billing') }}
            style={{ padding: '8px 16px', fontSize: 13 }}
          >Top up / upgrade →</button>
        </div>
      </div>
    </div>
  )
}
