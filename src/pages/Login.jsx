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
  // Stripe-first signup: ?stripe_session=cs_xxx in the URL means
  // they just finished anonymous Stripe Checkout and need to create
  // their Supabase account. We pre-fill + LOCK the email (it has to
  // match the Stripe customer) and link the customer after signup.
  const stripeSessionId = params.get('stripe_session')
  // ?reason=session_expired is set by SessionExpiredBanner's "Sign in
  // again" button when the auth-guard couldn't refresh the JWT. Surface
  // a friendly subhead so the user knows WHY they're back on the login
  // page instead of just dumping them here with no context.
  const reasonSessionExpired = params.get('reason') === 'session_expired'

  // Mode resolution order:
  //   1. ?stripe_session present → signup (returning from Stripe, must
  //      finish account creation)
  //   2. ?mode=signin → signin (explicit. Landing's "Sign in" button
  //      passes this; we honor it even if a stale tier sits in
  //      localStorage from an earlier browse session.)
  //   3. ?mode=signup → signup (explicit)
  //   4. tier stashed from /pricing → signup (resume checkout flow)
  //   5. default → signin
  const explicitMode = params.get('mode')
  const initialMode = stripeSessionId ? 'signup'
    : explicitMode === 'signin' ? 'signin'
    : explicitMode === 'signup' ? 'signup'
    : initialTier ? 'signup'
    : 'signin'
  const [mode, setMode] = useState(initialMode)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [tier] = useState(initialTier)
  const [cycle] = useState(initialCycle)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [info, setInfo] = useState(null)
  // Resend-confirmation state. We surface the link any time we've
  // shown the "check your email" info banner, plus a 30-second
  // cooldown so users don't spam Supabase's auth SMTP rate limit
  // (2/hr/address on default; higher on a custom SMTP provider).
  const [resending, setResending] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(0)
  useEffect(() => {
    if (resendCooldown <= 0) return
    const t = setTimeout(() => setResendCooldown((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [resendCooldown])
  async function handleResend() {
    if (!email || resending || resendCooldown > 0) return
    setResending(true); setError(null)
    try {
      const { error: err } = await supabase.auth.resend({ type: 'signup', email })
      if (err) throw err
      setInfo('Confirmation email resent. Check your inbox (and spam folder).')
      // Matches Supabase's "Minimum interval per user" setting (60s).
      // If you raise that in the dashboard, raise this too.
      setResendCooldown(60)
    } catch (e) {
      setError(e.message || 'Could not resend confirmation email.')
    } finally {
      setResending(false)
    }
  }
  // Stripe-session prefill: read email + tier off the session and
  // lock the email field so the account ties to the right Stripe
  // customer. emailLocked turns the input read-only.
  const [emailLocked, setEmailLocked] = useState(false)
  useEffect(() => {
    if (!stripeSessionId) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(`/api/stripe-resolve-session?id=${encodeURIComponent(stripeSessionId)}`)
        const body = await r.json()
        if (cancelled || !r.ok) return
        if (body.email) { setEmail(body.email); setEmailLocked(true) }
        // If they're somehow already signed in with this email,
        // immediately link the customer + bounce to dashboard.
        const { data: { session } } = await supabase.auth.getSession()
        if (session?.user?.email && session.user.email.toLowerCase() === (body.email || '').toLowerCase()) {
          await fetch('/api/stripe-link-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
            body: JSON.stringify({ session_id: stripeSessionId }),
          })
          window.location.href = '/dashboard?welcome=1'
        }
      } catch { /* fall through to normal signup */ }
    })()
    return () => { cancelled = true }
  }, [stripeSessionId])

  // If there's a pending tier and the user is already signed in (e.g. came back from confirm email),
  // bounce them straight to checkout. SKIP this when stripeSessionId
  // is set — that flow finished checkout already and just needs the
  // signup completion.
  useEffect(() => {
    if (!tier || stripeSessionId) return
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
        // Stash the stripe_session_id so AuthCallback can pick it up
        // after the user clicks the confirmation link. We send it
        // TWO ways for resilience:
        //   1. localStorage — works for same-browser flows
        //   2. emailRedirectTo query string — survives cross-browser
        //      (incognito → default browser is the common case)
        // AuthCallback prefers the URL param when both are present.
        if (stripeSessionId) {
          try { localStorage.setItem('scalesolo.signup.stripe_session', stripeSessionId) } catch {}
        }
        const { data: signUpData, error: err } = await signUp(email, password, null, {
          redirectQuery: stripeSessionId ? { stripe_session: stripeSessionId } : null,
        })
        // Supabase silently no-ops signUp when the email already exists
        // (returns success-shaped data with no error). The tell is an
        // empty `identities` array on the returned user. We detect that
        // and trigger a resend so the user isn't stuck in a black hole.
        if (!err && signUpData?.user && Array.isArray(signUpData.user.identities) && signUpData.user.identities.length === 0) {
          try {
            await supabase.auth.resend({ type: 'signup', email })
            setInfo('That email already has an account pending confirmation. We sent a fresh confirmation link, check your inbox (and spam).')
            setResendCooldown(60)
            return
          } catch (resendErr) {
            setInfo('That email is already registered. Try signing in, or use the resend link below.')
            return
          }
        }
        if (err) {
          // "User already registered" is the common case when somebody
          // came back from Stripe Checkout, submitted once, and is now
          // trying again. Auto-resend the confirmation so they get a
          // fresh email instead of a dead-end error.
          const msg = (err.message || '').toLowerCase()
          if (msg.includes('already registered') || msg.includes('already exists') || msg.includes('user already')) {
            try {
              await supabase.auth.resend({ type: 'signup', email })
              setInfo('That email is already pending confirmation. We sent a fresh confirmation link, check your inbox (and spam).')
              setResendCooldown(60)
              return
            } catch (resendErr) {
              throw new Error('That email is already registered. Try signing in instead.')
            }
          }
          throw err
        }
        // If Supabase email confirmation is OFF, signUp returns a session immediately.
        const { data: { session } } = await supabase.auth.getSession()
        // Stripe-first flow: link the freshly-created account to the
        // Stripe customer that was created during anonymous checkout.
        if (session && stripeSessionId) {
          try {
            await fetch('/api/stripe-link-session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
              body: JSON.stringify({ session_id: stripeSessionId }),
            })
          } catch { /* don't block signup over link failure — webhook still works */ }
          try { localStorage.removeItem('scalesolo.signup.stripe_session') } catch {}
          window.location.href = '/dashboard?welcome=1'
          return
        }
        if (session && tier) {
          await startCheckout()
          return
        }
        if (session && !tier) return // App will route to dashboard
        setInfo(stripeSessionId
          ? 'Check your email to confirm your account, then come back to finish setup.'
          : 'Check your email to confirm your account, then come back to finish checkout.')
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

        {reasonSessionExpired && mode === 'signin' && (
          <div style={{
            padding: '10px 12px', marginBottom: 14, borderRadius: 10,
            background: 'rgba(245,158,11,0.10)',
            border: '1px solid rgba(245,158,11,0.35)',
            fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.5,
            display: 'flex', alignItems: 'flex-start', gap: 8,
          }}>
            <span aria-hidden style={{ color: '#f59e0b', fontSize: 14, lineHeight: 1, marginTop: 1 }}>⚠</span>
            <span>
              <strong style={{ color: '#f59e0b', fontFamily: 'var(--font-display)' }}>Your session expired.</strong>{' '}
              Sign back in to continue where you left off. Any in-progress workflows on the server keep running while you're signed out.
            </span>
          </div>
        )}

        {stripeSessionId && (
          <div style={{
            padding: '10px 12px', marginBottom: 14, borderRadius: 10,
            background: 'rgba(46,204,113,0.10)',
            border: '1px solid rgba(46,204,113,0.35)',
            fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.5,
          }}>
            <strong style={{ color: '#2ecc71', fontFamily: 'var(--font-display)' }}>
              Payment received.
            </strong>{' '}
            Pick a password to finish your account. Your trial starts immediately and your saved card kicks in after day 3 unless you cancel.
          </div>
        )}
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
              onChange={(e) => emailLocked ? null : setEmail(e.target.value)}
              readOnly={emailLocked}
              title={emailLocked ? 'Email is locked to the one used at checkout' : ''}
              style={emailLocked ? { opacity: 0.7, cursor: 'not-allowed' } : null}
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
            {mode === 'signin'
              ? 'Sign in'
              : stripeSessionId
                ? 'Finish account'
                : tier
                  ? 'Continue to checkout'
                  : 'Create account'}
          </button>
        </form>

        {/* Resend confirmation email. Shown whenever:
              - we've already shown the "check your email" banner (post-submit), OR
              - the page loaded from a Stripe success URL with the email
                pre-filled (we want a one-click recovery path if the
                first confirmation email never arrived). */}
        {mode === 'signup' && (info || (stripeSessionId && emailLocked)) && email && (
          <div style={{ ...switchLine, marginTop: 12 }}>
            Didn't get the email?
            <button
              type="button"
              style={{ ...switchBtn, opacity: (resending || resendCooldown > 0) ? 0.5 : 1, cursor: (resending || resendCooldown > 0) ? 'not-allowed' : 'pointer' }}
              disabled={resending || resendCooldown > 0}
              onClick={handleResend}
            >
              {resending ? 'Sending…' : resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend confirmation'}
            </button>
          </div>
        )}

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
