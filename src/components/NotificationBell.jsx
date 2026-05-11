import { useState, useRef, useEffect } from 'react'
import { Bell, Check, X, ExternalLink } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useNotifications } from '../lib/useNotifications.js'

const KIND_ICON = {
  'render.done':         '🎬',
  'render.failed':       '⚠️',
  'post.scheduled':      '📅',
  'post.published':      '✅',
  'post.failed':         '⚠️',
  'credits.low':         '💳',
  'autorun.tick_failed': '⏱',
  'template.featured':   '✨',
  // Server-side workflow auto-runs (fired from the Fly worker
  // via the Vercel cron dispatch).
  'workflow.started':    '▶️',
  'workflow.done':       '🎉',
  'workflow.failed':     '⚠️',
}

const LEVEL_COLOR = {
  info:    'var(--text-soft)',
  success: '#2ecc71',
  warning: '#f59e0b',
  error:   'var(--red)',
}

function timeAgo(iso) {
  if (!iso) return ''
  const d = (Date.now() - new Date(iso).getTime()) / 1000
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  return `${Math.floor(d / 86400)}d ago`
}

export default function NotificationBell() {
  const { items, unread, markRead, markAllRead, dismiss } = useNotifications()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const navigate = useNavigate()

  // Click-outside to close. The dropdown is anchored to this wrapper so
  // simple "is the click inside?" works.
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const onItemClick = (n) => {
    if (!n.read_at) markRead(n.id)
    if (n.href) navigate(n.href)
    setOpen(false)
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={unread > 0 ? `${unread} unread` : 'Notifications'}
        aria-label="Notifications"
        style={{
          position: 'relative',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 36, height: 36, borderRadius: 10,
          background: 'var(--surface)', border: '1px solid var(--border)',
          color: 'var(--text)', cursor: 'pointer',
        }}
      >
        <Bell size={15} />
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: -3, right: -3,
            minWidth: 16, height: 16, padding: '0 4px', borderRadius: 999,
            background: 'var(--red)', color: '#fff',
            fontSize: 10, fontFamily: 'var(--font-display)', fontWeight: 700,
            display: 'inline-grid', placeItems: 'center', lineHeight: 1,
            border: '2px solid var(--bg)',
          }}>{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0,
            width: 360, maxHeight: 480, overflow: 'hidden',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: '0 16px 48px rgba(0,0,0,0.18)',
            zIndex: 60,
            display: 'flex', flexDirection: 'column',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
            <Bell size={13} style={{ color: 'var(--red)' }} />
            <div style={{ flex: 1, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13 }}>Notifications</div>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                style={{
                  fontSize: 11, padding: '4px 8px', borderRadius: 6,
                  background: 'transparent', border: 'none',
                  color: 'var(--muted)', cursor: 'pointer',
                  fontFamily: 'var(--font-display)', fontWeight: 600,
                }}
                title="Mark all as read"
              >
                <Check size={11} style={{ verticalAlign: '-1px', marginRight: 3 }} />
                Mark all read
              </button>
            )}
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {items.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                <Bell size={20} style={{ opacity: 0.4, marginBottom: 8 }} />
                <div>No notifications yet</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>You'll see render finishes, scheduled posts, and credit alerts here.</div>
              </div>
            ) : items.map((n) => (
              <div
                key={n.id}
                role={n.href ? 'button' : undefined}
                tabIndex={n.href ? 0 : undefined}
                onClick={() => n.href ? onItemClick(n) : null}
                onKeyDown={(e) => { if (n.href && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onItemClick(n) } }}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  padding: '10px 12px',
                  borderBottom: '1px solid var(--border)',
                  background: n.read_at ? 'transparent' : 'rgba(239,68,68,0.04)',
                  cursor: n.href ? 'pointer' : 'default',
                  position: 'relative',
                }}
              >
                <div style={{
                  fontSize: 16, lineHeight: 1, marginTop: 2,
                  width: 20, textAlign: 'center',
                  color: LEVEL_COLOR[n.level] || 'var(--text)',
                }}>
                  {KIND_ICON[n.kind] || '•'}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, flex: 1, color: 'var(--text)' }}>
                      {n.title}
                    </div>
                    <span style={{ fontSize: 10.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{timeAgo(n.created_at)}</span>
                  </div>
                  {n.body && (
                    <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 2, lineHeight: 1.4, wordBreak: 'break-word' }}>
                      {n.body.length > 140 ? n.body.slice(0, 140) + '…' : n.body}
                    </div>
                  )}
                  {n.href && (
                    <div style={{ fontSize: 10.5, color: 'var(--red)', marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      Open <ExternalLink size={10} />
                    </div>
                  )}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); dismiss(n.id) }}
                  title="Dismiss"
                  style={{
                    background: 'transparent', border: 'none',
                    color: 'var(--muted)', cursor: 'pointer',
                    padding: 2, borderRadius: 4,
                    opacity: 0.6,
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
