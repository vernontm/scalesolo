import { useTheme } from '../context/ThemeContext.jsx'
import { Sun, Moon, Monitor } from 'lucide-react'

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

