import { useEffect, useState } from 'react'
import { useTheme } from '../context/ThemeContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { Sun, Moon, Monitor, Pause, Activity, Flame } from 'lucide-react'

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

      <BehaviorDialSection />


      <div className="card-flat" style={{ marginBottom: 18 }}>
        <div style={sectionTitle}>Workspace</div>
        <div style={row}>
          <div>
            <div style={rowLabel}>Brand profiles</div>
            <div style={rowHint}>Manage profiles, billing, and team in their dedicated pages.</div>
          </div>
        </div>
        <div style={{ ...row, borderBottom: 'none' }}>
          <div>
            <div style={rowLabel}>Data export & deletion</div>
            <div style={rowHint}>Self-serve in Milestone 8.</div>
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>Coming soon</div>
        </div>
      </div>
    </div>
  )
}

// ── AI CEO behavior dial ──────────────────────────────────────────────────
const dialOptions = [
  { value: 'quiet',      label: 'Quiet',      icon: Pause,    hint: 'Answers only. No follow-ups.' },
  { value: 'balanced',   label: 'Balanced',   icon: Activity, hint: 'One natural next step when helpful.' },
  { value: 'aggressive', label: 'Aggressive', icon: Flame,    hint: '1-3 next actions after every reply.' },
]

function BehaviorDialSection() {
  const { selectedProfile, selectedProfileId, refresh } = useProfile()
  const { session } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(null)

  const current = pending || selectedProfile?.agent_aggressiveness || 'balanced'

  const setDial = async (value) => {
    if (!selectedProfileId || !session) return
    setBusy(true); setError(null); setPending(value)
    try {
      const r = await fetch('/api/profiles', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ id: selectedProfileId, agent_aggressiveness: value }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Save failed')
      refresh()
    } catch (e) {
      setError(e.message)
      setPending(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card-flat" style={{ marginBottom: 18 }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 12 }}>
        AI CEO behavior
      </div>
      <div style={{ marginBottom: 14, fontSize: 13, color: 'var(--text-soft)' }}>
        How proactively the AI CEO surfaces suggestions on every reply. Set per brand profile.
      </div>
      {!selectedProfileId ? (
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>Pick a brand profile to configure.</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            {dialOptions.map((opt) => {
              const active = current === opt.value
              const Icon = opt.icon
              return (
                <button
                  key={opt.value}
                  onClick={() => setDial(opt.value)}
                  disabled={busy}
                  style={{
                    textAlign: 'left',
                    padding: '14px 16px',
                    background: active ? 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(185,28,28,0.10))' : 'var(--surface-2)',
                    border: active ? '1px solid rgba(239,68,68,0.40)' : '1px solid var(--border)',
                    borderRadius: 12,
                    cursor: busy ? 'wait' : 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <Icon size={15} strokeWidth={2.2} color={active ? 'var(--red)' : 'var(--text-soft)'} />
                    <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>
                      {opt.label}
                    </div>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>{opt.hint}</div>
                </button>
              )
            })}
          </div>
          {error && <div style={{ marginTop: 10, color: 'var(--red)', fontSize: 12.5 }}>{error}</div>}
        </>
      )}
    </div>
  )
}
