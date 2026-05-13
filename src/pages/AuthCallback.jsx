import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// /auth/callback — handles redirect from Supabase email confirmation
// (and any other OAuth flow). The supabase client is configured with
// detectSessionInUrl: true so the token in the URL fragment / query is
// exchanged automatically. We just wait for the auth state to land,
// then route the user forward (Stripe checkout if a tier was stashed,
// otherwise dashboard / landing).
export default function AuthCallback() {
  const navigate = useNavigate()
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function finish() {
      try {
        // Surface any error that Supabase put in the URL.
        const url = new URL(window.location.href)
        const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''))
        const errFromHash = hashParams.get('error_description') || hashParams.get('error')
        const errFromQuery = url.searchParams.get('error_description') || url.searchParams.get('error')
        if (errFromHash || errFromQuery) {
          throw new Error(decodeURIComponent(errFromHash || errFromQuery || 'Authentication failed.'))
        }

        // Wait briefly for the supabase client to consume the URL token.
        // It runs synchronously on import, but we still poll once just in case.
        let session = null
        for (let i = 0; i < 6 && !session; i++) {
          const { data } = await supabase.auth.getSession()
          session = data.session
          if (session) break
          await new Promise((r) => setTimeout(r, 200))
        }
        if (cancelled) return

        if (!session) {
          // No session landed — kick to login with a friendly message.
          navigate('/login', { replace: true, state: { info: 'Please sign in to continue.' } })
          return
        }

        // Stripe-first signup path: a stripe_session was stashed during
        // /login submit. Link it to the freshly-confirmed account now so
        // the dashboard has the subscription + credits as soon as it
        // loads. We do this BEFORE the tier check below so a brand-new
        // subscriber never falls through to a re-checkout.
        const stripeSessionStashed = (() => {
          try { return localStorage.getItem('scalesolo.signup.stripe_session') } catch { return null }
        })()
        if (stripeSessionStashed) {
          try {
            await fetch('/api/stripe-link-session', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${session.access_token}`,
              },
              body: JSON.stringify({ session_id: stripeSessionStashed }),
            })
          } catch { /* link-session is best-effort; webhook is the backup */ }
          try {
            localStorage.removeItem('scalesolo.signup.stripe_session')
            // The tier/cycle stashed by PricingPlans is no longer needed
            // — checkout already happened. Clear them so the next
            // /login load doesn't try to re-trigger checkout.
            localStorage.removeItem('scalesolo.signup.tier')
            localStorage.removeItem('scalesolo.signup.cycle')
          } catch {}
          navigate('/dashboard?welcome=1', { replace: true })
          return
        }

        // If a tier was stashed pre-auth, App routing + Login.jsx already
        // know how to resume checkout. Otherwise just go home.
        const tier = (() => {
          try { return localStorage.getItem('scalesolo.signup.tier') } catch { return null }
        })()
        if (tier) {
          navigate('/login', { replace: true })
          return
        }
        navigate('/dashboard', { replace: true })
      } catch (e) {
        if (!cancelled) setError(e.message || 'Authentication failed.')
      }
    }

    finish()
    return () => { cancelled = true }
  }, [navigate])

  if (error) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#111112', color: '#f0f0f0', padding: 24 }}>
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-display, system-ui)', fontWeight: 800, fontSize: 22, marginBottom: 8 }}>
            Confirmation failed
          </div>
          <div style={{ fontSize: 14, color: '#cccccd', marginBottom: 18 }}>{error}</div>
          <a href="/login" style={{ display: 'inline-block', padding: '10px 18px', background: 'linear-gradient(135deg, #ef4444, #b91c1c)', borderRadius: 10, color: '#fff', textDecoration: 'none', fontWeight: 700 }}>
            Back to sign in
          </a>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#111112', color: '#cccccd' }}>
      <div style={{ fontSize: 14 }}>Confirming…</div>
    </div>
  )
}
