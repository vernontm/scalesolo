import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Lock, Sparkles, Zap, Calendar, Wand2, ArrowRight, Loader2, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'

// Wrap a page in <TrialGate /> to block its functionality for users on
// the 3-day trial. The page renders behind a frosted backdrop, the user
// sees a modal explaining what's gated and gets a one-click path to
// either upgrade tier or end their trial and start billing immediately.
//
// Usage:
//   <TrialGate page="schedule">
//     <YourPageContent />
//   </TrialGate>
//
// PAGE_COPY below holds per-page headlines + bullets. Add new pages
// there as we gate more surfaces (workflows, avatars, etc.).

const PAGE_COPY = {
  schedule: {
    icon: Calendar,
    title: 'Schedule & publish unlocks with a paid plan',
    intro: 'Your trial includes one watermarked 30-second avatar video so you can see ScaleSolo end to end. Auto-scheduling and direct publishing to TikTok, Instagram, YouTube, X, and LinkedIn turn on the moment you start a subscription.',
    bullets: [
      { icon: Calendar, text: 'Schedule posts across 9+ platforms on a cadence you set' },
      { icon: Wand2,    text: 'Approve drafts in one tap, or auto-post without review' },
      { icon: Sparkles, text: 'Run multiple brands side-by-side, each on its own schedule' },
    ],
  },
}

export default function TrialGate({ page = 'schedule', children }) {
  const { session } = useAuth()
  const navigate = useNavigate()
  const [status, setStatus] = useState('loading') // loading | trialing | active | none
  const [endingTrial, setEndingTrial] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!session) { setStatus('none'); return }
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/billing', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const body = await r.json()
        if (cancelled) return
        if (!r.ok) throw new Error(body.error || 'Could not load subscription.')
        const subStatus = body?.subscription?.status
        setStatus(subStatus === 'trialing' ? 'trialing' : (subStatus || 'none'))
      } catch (e) {
        if (!cancelled) setStatus('none') // fail-open: don't trap a user behind a gate due to a flaky GET
      }
    })()
    return () => { cancelled = true }
  }, [session])

  // While we don't know yet, render the page normally — flashing the
  // overlay on for half a second on every navigation is worse UX than
  // a brief unrestricted moment.
  if (status !== 'trialing') return children

  const copy = PAGE_COPY[page] || PAGE_COPY.schedule
  const PageIcon = copy.icon

  // End trial early → Stripe billing portal. The portal lets the user
  // confirm card + immediately start their subscription, which converts
  // trial → active on their next subscription event. Webhook + link-session
  // already handle the conversion grant.
  const endTrialNow = async () => {
    setError(null)
    setEndingTrial(true)
    try {
      const r = await fetch('/api/stripe-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      })
      const body = await r.json()
      if (!r.ok || !body.url) throw new Error(body.error || 'Could not open billing portal.')
      window.location.href = body.url
    } catch (e) {
      setError(e.message)
      setEndingTrial(false)
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      {/* Frosted underlay — the page DOM is still mounted (so navigating
          back doesn't strip its state), just visually disabled. */}
      <div
        aria-hidden
        style={{
          filter: 'blur(6px)',
          pointerEvents: 'none',
          userSelect: 'none',
          opacity: 0.55,
        }}
      >
        {children}
      </div>

      {/* Modal — positioned over the blurred content. position: fixed
          keeps it centered on viewport even when the underlying page
          is tall. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="trial-gate-title"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 95,
          background: 'rgba(0,0,0,0.42)',
          backdropFilter: 'blur(2px)',
          WebkitBackdropFilter: 'blur(2px)',
          display: 'grid',
          placeItems: 'center',
          padding: '5vh 24px',
          overflowY: 'auto',
        }}
      >
        <div
          style={{
            maxWidth: 520,
            width: '100%',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 18,
            padding: 28,
            boxShadow: 'var(--shadow-pop)',
            color: 'var(--text)',
            position: 'relative',
          }}
        >
          {/* X close → route the user back to the dashboard. Trial
              users have nothing to do on this page yet, so kicking
              them home (vs. leaving them staring at a blurred
              schedule page they can't use) is the better default. */}
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            aria-label="Close and return to dashboard"
            title="Back to dashboard"
            style={{
              position: 'absolute', top: 14, right: 14,
              background: 'transparent', border: 'none',
              color: 'var(--muted)', cursor: 'pointer',
              padding: 6, borderRadius: 6,
              display: 'grid', placeItems: 'center',
            }}
          ><X size={16} /></button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <div style={{
              width: 38, height: 38, borderRadius: 10,
              display: 'grid', placeItems: 'center',
              background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
              color: '#fff',
            }}>
              <Lock size={18} strokeWidth={2.3} />
            </div>
            <div style={{
              fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 12.5,
              letterSpacing: '0.10em', textTransform: 'uppercase',
              color: 'var(--text-soft)',
            }}>
              Trial preview
            </div>
          </div>

          <h2 id="trial-gate-title" style={{
            fontFamily: 'var(--font-display)', fontWeight: 800,
            fontSize: 22, lineHeight: 1.25, margin: '0 0 10px',
            color: 'var(--text)',
          }}>
            <PageIcon size={20} style={{ marginRight: 8, verticalAlign: '-3px', color: 'var(--red)' }} />
            {copy.title}
          </h2>

          <p style={{
            fontSize: 14, lineHeight: 1.55, color: 'var(--text-soft)',
            margin: '0 0 18px',
          }}>
            {copy.intro}
          </p>

          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 22px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {copy.bullets.map((b, i) => {
              const BIcon = b.icon
              return (
                <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13.5, color: 'var(--text-soft)' }}>
                  <BIcon size={15} style={{ color: 'var(--red)', flexShrink: 0, marginTop: 2 }} />
                  <span>{b.text}</span>
                </li>
              )
            })}
          </ul>

          {error && (
            <div style={{
              background: 'var(--red-soft)', color: 'var(--red)',
              padding: '10px 12px', borderRadius: 10, fontSize: 13, marginBottom: 14,
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              type="button"
              onClick={endTrialNow}
              disabled={endingTrial}
              className="btn-primary"
              style={{ width: '100%', justifyContent: 'center', padding: '12px 18px' }}
            >
              {endingTrial ? <Loader2 size={14} className="spin" /> : <Zap size={14} />}
              {endingTrial ? 'Opening billing…' : 'Start my subscription now'}
              {!endingTrial && <ArrowRight size={14} />}
            </button>
            <button
              type="button"
              onClick={() => navigate('/billing')}
              className="btn-secondary"
              style={{ width: '100%', justifyContent: 'center', padding: '12px 18px' }}
            >
              Compare plans
            </button>
          </div>

          <div style={{
            marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)',
            fontSize: 12, color: 'var(--muted)', textAlign: 'center', lineHeight: 1.5,
          }}>
            Your trial ends in a few days. Keep using the rest of ScaleSolo, then come back here when you're ready to schedule.
          </div>
        </div>
      </div>
    </div>
  )
}
