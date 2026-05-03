import { useState } from 'react'
import { Zap } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import ThemeToggle from '../components/ThemeToggle.jsx'

const page = {
  minHeight: '100vh',
  display: 'grid',
  placeItems: 'center',
  padding: 24,
  position: 'relative',
}
const cornerStyle = { position: 'fixed', top: 18, right: 18, zIndex: 2 }
const card = {
  width: '100%',
  maxWidth: 420,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 18,
  padding: 36,
  boxShadow: 'var(--shadow-pop)',
}
const brand = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginBottom: 24,
}
const brandIcon = {
  width: 38,
  height: 38,
  borderRadius: 11,
  display: 'grid',
  placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff',
  boxShadow: '0 6px 18px rgba(239,68,68,0.32)',
}
const brandTitle = {
  fontFamily: 'var(--font-display)',
  fontWeight: 800,
  fontSize: 18,
}
const subtitle = { color: 'var(--muted)', fontSize: 13, marginBottom: 24 }
const formStack = { display: 'flex', flexDirection: 'column', gap: 14 }
const errorStyle = {
  background: 'var(--red-soft)',
  color: 'var(--red)',
  padding: '10px 12px',
  borderRadius: 10,
  fontSize: 13,
}
const switchLine = {
  fontSize: 13,
  color: 'var(--muted)',
  marginTop: 16,
  textAlign: 'center',
}
const switchBtn = {
  background: 'transparent',
  border: 'none',
  color: 'var(--red)',
  fontWeight: 600,
  cursor: 'pointer',
  fontSize: 13,
  marginLeft: 4,
}

export default function Login() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState('signin') // 'signin' | 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [info, setInfo] = useState(null)

  async function onSubmit(e) {
    e.preventDefault()
    setError(null); setInfo(null); setBusy(true)
    try {
      if (mode === 'signin') {
        const { error: err } = await signIn(email, password)
        if (err) throw err
      } else {
        const { error: err } = await signUp(email, password)
        if (err) throw err
        setInfo('Check your email to confirm your account.')
      }
    } catch (err) {
      setError(err.message || 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={page}>
      <div style={cornerStyle}><ThemeToggle /></div>
      <div style={card} className="fade-up">
        <div style={brand}>
          <div style={brandIcon}><Zap size={20} strokeWidth={2.5} /></div>
          <div>
            <div style={brandTitle}>ScaleSolo</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Scale 10× faster
            </div>
          </div>
        </div>

        <div style={subtitle}>
          {mode === 'signin' ? 'Sign in to your workspace.' : 'Create your ScaleSolo account.'}
        </div>

        <form style={formStack} onSubmit={onSubmit}>
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              className="input"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              className="input"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {error && <div style={errorStyle}>{error}</div>}
          {info && <div className="pill pill-success" style={{ alignSelf: 'flex-start' }}>{info}</div>}

          <button type="submit" className="btn-primary" disabled={busy} style={{ marginTop: 6 }}>
            {busy ? <span className="spinner" /> : null}
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div style={switchLine}>
          {mode === 'signin' ? "Don't have an account?" : 'Already have one?'}
          <button
            type="button"
            style={switchBtn}
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); setInfo(null) }}
          >
            {mode === 'signin' ? 'Sign up' : 'Sign in'}
          </button>
        </div>
      </div>
    </div>
  )
}
