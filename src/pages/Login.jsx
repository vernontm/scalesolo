import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Zap, Sparkles } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { supabase } from '../lib/supabase.js'
import ThemeToggle from '../components/ThemeToggle.jsx'

const TIER_LABELS = {
  solo_starter: 'Solo Starter',
  solo_pro: 'Solo Pro',
  solo_studio: 'Solo Studio',
  founding: 'Founding Member',
}

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
  const [params] = useSearchParams()

  // Pull intent from query string OR localStorage (Pricing page stashes it before routing here).
  const initialTier = params.get('tier') || (typeof window !== 'undefined' ? localStorage.getItem('scalesolo.signup.tier') : null)
  const initialCycle = params.get('cycle') || (typeof window !== 'undefined' ? localStorage.getItem('scalesolo.signup.cycle') : null) || 'monthly'

  // ?mode=signup explicitly opens the signup form (used by every CTA on
  // the landing page that says "Get started" / "Try free"). A pending
  // tier always wins (came from /pricing or a checkout retry).
  const initialMode = initialTier ? 'signup' : (params.get('mode') === 'signup' ? 'signup' : 'signin')
  const [mode, setMode] = useState(initialMode)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [tier] = useState(initialTier)
  const [cycle] = useState(initialCycle)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [info, setInfo] = useState(null)

  // If there's a pending tier and the user is already signed in (e.g. came back from confirm email),
  // bounce them straight to checkout.
  useEffect(() => {
    if (!tier) return
    let cancelled = false
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (cancelled || !session) return
      await startCheckout()
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier])

  async function startCheckout() {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not signed in.')
      const r = await fetch('/api/stripe-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ tier, billing_cycle: cycle }),
      })
      const body = await r.json()
      if (!r.ok || !body.url) throw new Error(body.error || 'Checkout could not start.')
      try {
        localStorage.removeItem('scalesolo.signup.tier')
        localStorage.removeItem('scalesolo.signup.cycle')
      } catch {}
      window.location.href = body.url
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  async function onSubmit(e) {
    e.preventDefault()
    setError(null); setInfo(null); setBusy(true)
    try {
      if (mode === 'signin') {
        const { error: err } = await signIn(email, password)
        if (err) throw err
        // sign-in success — if there's a pending tier, the useEffect above will fire after session lands
      } else {
        const { error: err } = await signUp(email, password)
        if (err) throw err
        // If Supabase email confirmation is OFF, signUp returns a session immediately.
        const { data: { session } } = await supabase.auth.getSession()
        if (session && tier) {
          await startCheckout()
          return
        }
        if (session && !tier) return // App will route to dashboard
        setInfo('Check your email to confirm your account, then come back to finish checkout.')
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

        {/* Mode toggle — clearer than a tiny "Sign up / Sign in" link.
            Highlights the active tab so the user always knows whether
            they're creating an account or signing in. */}
        <div role="tablist" aria-label="Auth mode" style={{
          display: 'inline-flex', gap: 4,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 10, padding: 4, marginBottom: 14, alignSelf: 'flex-start',
        }}>
          {['signup', 'signin'].map((m) => {
            const active = mode === m
            return (
              <button
                key={m}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => { setMode(m); setError(null); setInfo(null) }}
                style={{
                  padding: '7px 14px', borderRadius: 7,
                  background: active ? 'linear-gradient(135deg, var(--red), var(--red-dark))' : 'transparent',
                  color: active ? '#fff' : 'var(--text-soft)',
                  border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-display)', fontSize: 12.5, fontWeight: 700,
                  boxShadow: active ? '0 4px 12px rgba(239,68,68,0.25)' : 'none',
                  transition: 'all 0.15s ease',
                }}
              >
                {m === 'signup' ? 'Create account' : 'Sign in'}
              </button>
            )
          })}
        </div>

        {/* Headline — louder than the previous one-liner so the user is
            never unsure which mode they're in. The signup variant also
            calls out the free trial so it doesn't feel like a paywall
            until the form is filled in. */}
        <div style={{
          fontFamily: 'var(--font-display)', fontWeight: 800,
          fontSize: 22, color: 'var(--text)', lineHeight: 1.25,
          marginBottom: 6,
        }}>
          {mode === 'signin' ? 'Welcome back.' : tier ? 'Start your 3-day free trial.' : 'Create your account.'}
        </div>

        <div style={subtitle}>
          {mode === 'signin'
            ? 'Sign in to your workspace.'
            : tier
              ? <>You're starting <strong style={{ color: 'var(--text)' }}>{TIER_LABELS[tier] || tier}</strong>. No charge for 3 days, cancel anytime.</>
              : 'Free to start. Upgrade when you need more.'}
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
            {busy ? <span className="spinner" /> : <Sparkles size={15} />}
            {mode === 'signin' ? 'Sign in' : (tier ? 'Continue to checkout' : 'Create account')}
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
