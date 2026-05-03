import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Zap, Check, Sparkles, Crown, BadgeCheck } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { supabase } from '../lib/supabase.js'
import ThemeToggle from '../components/ThemeToggle.jsx'

const TIERS = [
  {
    key: 'solo_starter',
    name: 'Solo Starter',
    monthly: 49,
    annual: 39,
    profile_limit: 1,
    blurb: 'For solopreneurs getting their first system in place.',
    features: [
      '1 brand profile',
      '100K AI tokens / month',
      '10 avatar video units / month',
      'Email composer + sequences',
      'Content engine + scheduler',
      'Basic analytics',
    ],
    accent: '#94a3b8',
  },
  {
    key: 'solo_pro',
    name: 'Solo Pro',
    monthly: 79,
    annual: 65,
    profile_limit: 2,
    blurb: 'The everything plan most users land on.',
    features: [
      '2 brand profiles',
      '500K AI tokens / month',
      '30 avatar video units / month',
      'Sales pipeline + forms + landing pages',
      'AI CEO with persistent memory',
      'Native email sending (Postmark)',
      'Priority support',
    ],
    popular: true,
  },
  {
    key: 'solo_studio',
    name: 'Solo Studio',
    monthly: 149,
    annual: 124,
    profile_limit: 5,
    blurb: 'Multi-brand creators and agencies of one.',
    features: [
      '5 brand profiles',
      '2M AI tokens / month',
      '100 avatar video units / month',
      'Everything in Pro',
      'Cross-profile dashboard',
      'Founder direct line (Slack)',
    ],
    accent: '#a78bfa',
  },
]

const FOUNDING = {
  key: 'founding',
  name: 'Founding Member',
  monthly: 39,
  cap: 100,
  blurb: 'Lifetime price lock. 100 spots. Never goes up.',
  features: [
    'Lifetime $39/mo (lock guaranteed)',
    'Everything in Solo Pro',
    'Founding-member badge in app',
    'Direct input on the roadmap',
  ],
}

const page = {
  minHeight: '100vh',
  padding: '40px 24px 80px',
  position: 'relative',
}
const cornerStyle = { position: 'fixed', top: 18, right: 18, zIndex: 5 }
const brandRow = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  justifyContent: 'center',
  marginBottom: 18,
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
const heroTitle = {
  fontFamily: 'var(--font-display)',
  fontSize: 38,
  fontWeight: 800,
  textAlign: 'center',
  letterSpacing: '-0.02em',
  marginTop: 16,
  marginBottom: 8,
}
const heroSub = {
  textAlign: 'center',
  color: 'var(--muted)',
  fontSize: 15,
  maxWidth: 560,
  margin: '0 auto 26px',
  lineHeight: 1.6,
}
const cycleToggleWrap = {
  display: 'flex',
  justifyContent: 'center',
  marginBottom: 32,
}
const cycleToggle = {
  display: 'inline-flex',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 4,
  gap: 4,
}
function cycleBtn(active) {
  return {
    padding: '8px 18px',
    borderRadius: 7,
    background: active ? 'linear-gradient(135deg, var(--red), var(--red-dark))' : 'transparent',
    color: active ? '#fff' : 'var(--text-soft)',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'var(--font-display)',
    fontSize: 13,
    fontWeight: 600,
    boxShadow: active ? '0 4px 12px rgba(239,68,68,0.25)' : 'none',
    transition: 'all 0.15s ease',
  }
}
const annualSavingPill = {
  marginLeft: 8,
  fontSize: 11,
  background: 'rgba(46, 204, 113, 0.16)',
  color: '#2ecc71',
  padding: '2px 8px',
  borderRadius: 999,
  fontFamily: 'var(--font-display)',
  fontWeight: 600,
}
const grid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: 18,
  maxWidth: 1180,
  margin: '0 auto',
}
function cardStyle(popular) {
  return {
    background: 'var(--surface)',
    border: popular ? '1px solid rgba(239,68,68,0.45)' : '1px solid var(--border)',
    borderRadius: 18,
    padding: '28px 26px',
    position: 'relative',
    boxShadow: popular ? '0 18px 48px rgba(239,68,68,0.18)' : 'var(--shadow-card)',
    transition: 'transform 0.22s var(--ease)',
  }
}
const popularBadge = {
  position: 'absolute',
  top: -12,
  left: '50%',
  transform: 'translateX(-50%)',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff',
  fontFamily: 'var(--font-display)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  padding: '5px 12px',
  borderRadius: 999,
  boxShadow: '0 6px 16px rgba(239,68,68,0.35)',
}
const tierName = {
  fontFamily: 'var(--font-display)',
  fontSize: 18,
  fontWeight: 700,
  marginBottom: 4,
}
const tierBlurb = { fontSize: 13, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.5 }
const priceRow = { display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }
const priceBig = {
  fontFamily: 'var(--font-display)',
  fontSize: 38,
  fontWeight: 800,
  letterSpacing: '-0.02em',
}
const priceSlash = { color: 'var(--muted)', fontSize: 13, fontWeight: 500 }
const featureList = {
  marginTop: 18,
  marginBottom: 22,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}
const featureRow = { display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: 13.5, color: 'var(--text-soft)' }
const checkIcon = { color: 'var(--red)', flexShrink: 0, marginTop: 2 }
const ctaBtnPrimary = { width: '100%', justifyContent: 'center' }
const ctaBtnSecondary = { width: '100%', justifyContent: 'center' }
const foundingBanner = {
  maxWidth: 1180,
  margin: '0 auto 32px',
  background: 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(185,28,28,0.10))',
  border: '1px solid rgba(239,68,68,0.40)',
  borderRadius: 18,
  padding: '28px 32px',
  display: 'flex',
  alignItems: 'center',
  gap: 24,
  flexWrap: 'wrap',
  boxShadow: '0 18px 48px rgba(239,68,68,0.16)',
  position: 'relative',
}
const foundingTopBadge = {
  position: 'absolute',
  top: -12,
  left: 32,
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff',
  fontFamily: 'var(--font-display)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  padding: '5px 12px',
  borderRadius: 999,
  boxShadow: '0 6px 16px rgba(239,68,68,0.35)',
}
const foundingMeta = { display: 'flex', alignItems: 'center', gap: 12 }
const foundingIcon = {
  width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', boxShadow: '0 6px 16px rgba(239,68,68,0.3)',
}
const foundingTitle = { fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700 }
const foundingSub = { color: 'var(--text-soft)', fontSize: 13, marginTop: 2 }
const remainingPill = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(239,68,68,0.35)',
  padding: '6px 12px', borderRadius: 999, fontSize: 12, fontFamily: 'var(--font-display)', fontWeight: 600,
}
const trialNote = {
  textAlign: 'center', marginTop: 26, color: 'var(--muted)', fontSize: 13,
}

export default function Pricing() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [cycle, setCycle] = useState('monthly')
  const [founding, setFounding] = useState(null)
  const [loadingTier, setLoadingTier] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetch('/api/founding-count').then((r) => r.json()).then(setFounding).catch(() => {})
  }, [])

  const handleSubscribe = async (tier) => {
    setError(null)
    if (!user) {
      // Stash intent and route to sign-up.
      try { localStorage.setItem('scalesolo.signup.tier', tier) } catch {}
      try { localStorage.setItem('scalesolo.signup.cycle', cycle) } catch {}
      navigate(`/?tier=${tier}&cycle=${cycle}`)
      return
    }
    setLoadingTier(tier)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const r = await fetch('/api/stripe-checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ tier, billing_cycle: cycle }),
      })
      const body = await r.json()
      if (!r.ok || !body.url) throw new Error(body.error || 'Checkout could not start.')
      window.location.href = body.url
    } catch (e) {
      setError(e.message)
      setLoadingTier(null)
    }
  }

  const foundingSoldOut = founding?.sold_out
  const foundingRemaining = founding?.remaining ?? 100

  return (
    <div style={page}>
      <div style={cornerStyle}><ThemeToggle /></div>

      <div className="fade-up">
        <div style={brandRow}>
          <div style={brandIcon}><Zap size={20} strokeWidth={2.5} /></div>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18 }}>ScaleSolo</div>
        </div>
        <h1 style={heroTitle}>
          Scale your brand <span className="brand-text">10× faster</span>.
        </h1>
        <p style={heroSub}>
          One AI-native operating system that replaces a stack of $300+/month tools.
          Pick a plan. 3-day free trial, cancel anytime.
        </p>

        {/* Founding member — shown above the standard tiers for urgency */}
        <div style={foundingBanner} className="fade-up">
          <div style={foundingTopBadge}>Limited — first 100 only</div>
          <div style={foundingMeta}>
            <div style={foundingIcon}><Crown size={20} strokeWidth={2.4} /></div>
            <div>
              <div style={foundingTitle}>{FOUNDING.name} — ${FOUNDING.monthly}/mo lifetime lock</div>
              <div style={foundingSub}>{FOUNDING.blurb}</div>
            </div>
          </div>
          <ul style={{ ...featureList, marginTop: 0, marginBottom: 0, marginRight: 'auto', minWidth: 280 }}>
            {FOUNDING.features.map((f) => (
              <li key={f} style={featureRow}>
                <BadgeCheck size={15} strokeWidth={2.5} style={checkIcon} /> {f}
              </li>
            ))}
          </ul>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
            <span style={remainingPill}>
              {foundingSoldOut ? 'Sold out' : `${foundingRemaining} of ${FOUNDING.cap} spots left`}
            </span>
            <button
              className="btn-primary"
              style={{ minWidth: 200 }}
              disabled={foundingSoldOut || loadingTier === 'founding'}
              onClick={() => handleSubscribe('founding')}
            >
              {loadingTier === 'founding' ? <span className="spinner" /> : <Crown size={15} />}
              {foundingSoldOut ? 'Sold out' : 'Claim founding price'}
            </button>
          </div>
        </div>

        <div style={cycleToggleWrap}>
          <div style={cycleToggle}>
            <button style={cycleBtn(cycle === 'monthly')} onClick={() => setCycle('monthly')}>Monthly</button>
            <button style={cycleBtn(cycle === 'annual')}  onClick={() => setCycle('annual')}>
              Annual <span style={annualSavingPill}>save 20%</span>
            </button>
          </div>
        </div>

        <div style={grid}>
          {TIERS.map((t) => {
            const price = cycle === 'annual' ? t.annual : t.monthly
            const slash = cycle === 'annual' ? `$${t.monthly}/mo billed monthly` : 'per month'
            return (
              <div key={t.key} style={cardStyle(t.popular)} className="fade-up">
                {t.popular && <div style={popularBadge}>Most popular</div>}
                <div style={tierName}>{t.name}</div>
                <div style={tierBlurb}>{t.blurb}</div>
                <div style={priceRow}>
                  <span style={priceBig}>${price}</span>
                  <span style={priceSlash}>/ mo</span>
                </div>
                <div style={{ ...priceSlash, fontSize: 12 }}>{cycle === 'annual' ? `vs ${slash}` : slash}</div>

                <ul style={featureList}>
                  {t.features.map((f) => (
                    <li key={f} style={featureRow}>
                      <Check size={15} strokeWidth={2.5} style={checkIcon} /> {f}
                    </li>
                  ))}
                </ul>

                <button
                  className={t.popular ? 'btn-primary' : 'btn-secondary'}
                  style={t.popular ? ctaBtnPrimary : ctaBtnSecondary}
                  disabled={loadingTier === t.key}
                  onClick={() => handleSubscribe(t.key)}
                >
                  {loadingTier === t.key ? <span className="spinner" /> : <Sparkles size={15} />}
                  {user ? 'Start free trial' : 'Get started'}
                </button>
              </div>
            )
          })}
        </div>

        {error && (
          <div style={{ maxWidth: 600, margin: '24px auto 0', padding: '12px 16px', background: 'var(--red-soft)', color: 'var(--red)', borderRadius: 10, textAlign: 'center', fontSize: 13 }}>
            {error}
          </div>
        )}

        <div style={trialNote}>
          3-day free trial on every plan. No charge until day 3. Cancel anytime in one click.
        </div>
      </div>
    </div>
  )
}

// helper named export so other modules can read tier definitions if needed
export const PRICING_TIERS = TIERS
export const FOUNDING_TIER = FOUNDING
