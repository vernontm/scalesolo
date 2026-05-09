import { useEffect, useState } from 'react'
import { useTheme } from '../context/ThemeContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { Sun, Moon, Monitor, Bell, Download, Trash2 } from 'lucide-react'

const sectionTitle = {
  fontFamily: 'var(--font-display)',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
  marginBottom: 12,
}
const row = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '14px 0',
  borderBottom: '1px solid var(--border)',
}
const rowLabel = { fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14 }
const rowHint  = { fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }

const segGroup = {
  display: 'inline-flex',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 4,
  gap: 4,
}
function segBtn(active) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 12px',
    borderRadius: 7,
    background: active ? 'linear-gradient(135deg, var(--red), var(--red-dark))' : 'transparent',
    color: active ? '#fff' : 'var(--text-soft)',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'var(--font-display)',
    fontSize: 12.5,
    fontWeight: 600,
    boxShadow: active ? '0 4px 12px rgba(239,68,68,0.25)' : 'none',
    transition: 'all 0.15s ease',
  }
}

// Switch component — visual two-state toggle with the brand red.
function Toggle({ on, onChange, disabled }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      aria-pressed={on}
      style={{
        width: 38, height: 22, borderRadius: 999, border: 'none',
        background: on ? 'linear-gradient(135deg, var(--red), var(--red-dark))' : 'var(--surface-2)',
        position: 'relative', cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 0.15s ease', opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        position: 'absolute', top: 3, left: on ? 19 : 3,
        width: 16, height: 16, borderRadius: '50%',
        background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
        transition: 'left 0.15s ease',
      }} />
    </button>
  )
}

const NOTIFICATION_PREFS = [
  { key: 'run_done',       label: 'Run finished',       hint: 'When a Spaces run / avatar render completes.' },
  { key: 'post_scheduled', label: 'Post scheduled',     hint: 'When a post is queued to publish later.' },
  { key: 'post_published', label: 'Post published',     hint: 'When a scheduled post goes live on social.' },
  { key: 'post_failed',    label: 'Post failed',        hint: 'When a scheduled post errors out.' },
  { key: 'credits_low',    label: 'Credits running low', hint: 'When AI tokens or video units drop below 10%.' },
]

function NotificationsSection() {
  const { session } = useAuth()
  const [prefs, setPrefs] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!session?.access_token) return
    fetch('/api/notifications?action=prefs', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => setPrefs(b.prefs || {}))
      .catch(() => setPrefs({}))
  }, [session?.access_token])

  const updatePref = async (key, value) => {
    if (!session?.access_token) return
    const next = { ...(prefs || {}), [key]: value }
    setPrefs(next); setBusy(true); setError(null)
    try {
      const r = await fetch('/api/notifications?action=prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(next),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || 'Save failed')
    } catch (e) {
      setError(e.message)
      // Revert optimistic update on failure.
      setPrefs((p) => ({ ...p, [key]: !value }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card-flat" style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Bell size={13} style={{ color: 'var(--muted)' }} />
        <div style={sectionTitle}>Notifications</div>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 6 }}>
        Pick which in-app notifications you want to see in the bell.
      </div>
      {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 8 }}>{error}</div>}
      {prefs === null ? (
        <div style={{ padding: 12, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      ) : NOTIFICATION_PREFS.map((p, i) => (
        <div key={p.key} style={{ ...row, borderBottom: i === NOTIFICATION_PREFS.length - 1 ? 'none' : row.borderBottom }}>
          <div>
            <div style={rowLabel}>{p.label}</div>
            <div style={rowHint}>{p.hint}</div>
          </div>
          <Toggle on={prefs[p.key] !== false} onChange={(v) => updatePref(p.key, v)} disabled={busy} />
        </div>
      ))}
    </div>
  )
}

function DataExportDeleteSection() {
  const { session, signOut } = useAuth()
  const [busy, setBusy] = useState(null) // 'export' | 'delete' | null
  const [error, setError] = useState(null)

  const downloadExport = async () => {
    if (!session?.access_token) return
    setBusy('export'); setError(null)
    try {
      const r = await fetch('/api/me/export', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error(b.error || `Export failed (${r.status})`)
      }
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `scalesolo-export-${Date.now()}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  const deleteAccount = async () => {
    if (!session?.access_token) return
    const ok = window.prompt('This permanently deletes your account, brand profiles, content, and avatars. Cancel any Stripe subscription separately so you stop being charged.\n\nType DELETE to confirm:')
    if (ok !== 'DELETE') return
    setBusy('delete'); setError(null)
    try {
      const r = await fetch('/api/me/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ confirm: 'DELETE' }),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b.error || 'Delete failed')
      alert(b.note || 'Account deleted.')
      try { signOut?.() } catch {}
      window.location.href = '/'
    } catch (e) {
      setError(e.message)
      setBusy(null)
    }
  }

  return (
    <>
      {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginTop: 8, marginBottom: 8 }}>{error}</div>}
      <div style={row}>
        <div>
          <div style={rowLabel}>Export your data</div>
          <div style={rowHint}>Download every brand profile, post, avatar, and credit transaction we have on file as JSON.</div>
        </div>
        <button
          onClick={downloadExport}
          disabled={busy === 'export'}
          style={{
            padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)',
            background: 'var(--surface-2)', color: 'var(--text)',
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600,
            cursor: busy === 'export' ? 'wait' : 'pointer',
          }}
        >
          <Download size={13} /> {busy === 'export' ? 'Preparing…' : 'Download'}
        </button>
      </div>
      <div style={{ ...row, borderBottom: 'none' }}>
        <div>
          <div style={rowLabel} className="text-red">Delete account</div>
          <div style={rowHint}>Removes your account and all owned content. Cannot be undone. Cancel any Stripe subscription separately.</div>
        </div>
        <button
          onClick={deleteAccount}
          disabled={busy === 'delete'}
          style={{
            padding: '8px 14px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.45)',
            background: 'rgba(239,68,68,0.10)', color: 'var(--red)',
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600,
            cursor: busy === 'delete' ? 'wait' : 'pointer',
          }}
        >
          <Trash2 size={13} /> {busy === 'delete' ? 'Deleting…' : 'Delete account'}
        </button>
      </div>
    </>
  )
}

export default function Settings() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="fade-up">
      <div className="card-flat" style={{ marginBottom: 18 }}>
        <div style={sectionTitle}>Appearance</div>
        <div style={row}>
          <div>
            <div style={rowLabel}>Theme</div>
            <div style={rowHint}>Choose dark, light, or follow your system preference.</div>
          </div>
          <div style={segGroup}>
            <button style={segBtn(theme === 'light')} onClick={() => setTheme('light')}>
              <Sun size={14} /> Light
            </button>
            <button style={segBtn(theme === 'dark')} onClick={() => setTheme('dark')}>
              <Moon size={14} /> Dark
            </button>
            <button
              style={segBtn(false)}
              onClick={() => {
                try { localStorage.removeItem('scalesolo.theme') } catch {}
                const sysDark = !window.matchMedia('(prefers-color-scheme: light)').matches
                setTheme(sysDark ? 'dark' : 'light')
              }}
              title="Match the system preference"
            >
              <Monitor size={14} /> System
            </button>
          </div>
        </div>
      </div>

      <NotificationsSection />

      <div className="card-flat" style={{ marginBottom: 18 }}>
        <div style={sectionTitle}>Workspace</div>
        <div style={row}>
          <div>
            <div style={rowLabel}>Brand profiles</div>
            <div style={rowHint}>Manage profiles, billing, and team in their dedicated pages.</div>
          </div>
        </div>
        <DataExportDeleteSection />
      </div>
    </div>
  )
}
