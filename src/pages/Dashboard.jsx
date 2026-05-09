import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles, Zap, ClipboardCheck, ArrowRight, Boxes, Calendar, BookOpen, CheckCircle2, Circle } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import CreditsPanel from '../components/CreditsPanel.jsx'
import OnboardingSurvey from '../components/OnboardingSurvey.jsx'

// ScaleSolo's wedge: automated content workflows in your brand voice.
// The dashboard's job is to reflect that — one big "shipped while you
// weren't looking" number front and center, plus a brand-completeness
// gauge so the user knows what's stopping their workflows from feeling
// truly on-brand. CRM-y / generic SaaS metrics are gone.

const heroStyle = {
  background: 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(185,28,28,0.10))',
  border: '1px solid rgba(239,68,68,0.25)',
  borderRadius: 18,
  padding: '28px 32px',
  display: 'flex',
  alignItems: 'center',
  gap: 18,
}
const heroIcon = {
  width: 54, height: 54, borderRadius: 14,
  display: 'grid', placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', boxShadow: '0 8px 24px rgba(239,68,68,0.4)', flexShrink: 0,
}
const heroTitle = {
  fontFamily: 'var(--font-display)',
  fontSize: 22,
  fontWeight: 700,
  letterSpacing: '-0.01em',
}
const heroSub = { color: 'var(--text-soft)', fontSize: 14, marginTop: 4 }
const sectionLabel = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  fontFamily: 'var(--font-display)',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
  marginTop: 28,
  marginBottom: 14,
}

// Big-number tile. The whole point of the dashboard is THIS card —
// "X posts shipped this month while I wasn't looking" is the entire
// product value in a single glance.
const shippedCardStyle = {
  background: 'linear-gradient(135deg, rgba(46,204,113,0.10), rgba(46,204,113,0.02))',
  border: '1px solid rgba(46,204,113,0.30)',
  borderRadius: 18, padding: '28px 32px',
  display: 'flex', alignItems: 'center', gap: 24,
}
const bigNumber = {
  fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 64,
  lineHeight: 1, color: '#2ecc71', letterSpacing: '-0.04em',
  fontVariantNumeric: 'tabular-nums',
}

// Brand completeness gauge — drives users toward making their brand
// profile actually fill in the bibles + voice + handles. Without those
// the workflows still run but the output is generic.
function BrandCompletenessCard({ profile, onEdit }) {
  const checks = [
    { key: 'business_name',   label: 'Business name',     ok: !!profile?.business_name },
    { key: 'brand_bible',     label: 'Brand bible written', ok: (profile?.brand_bible || '').length > 200 },
    { key: 'preferred_tone',  label: 'Voice & tone set',  ok: !!profile?.preferred_tone },
    { key: 'target_audience', label: 'Target audience',   ok: !!profile?.target_audience },
    { key: 'core_hashtags',   label: 'Core hashtags',     ok: !!profile?.core_hashtags },
    { key: 'social_handles',  label: 'A social handle',   ok: !!(profile?.instagram_handle || profile?.tiktok_handle || profile?.threads_handle || profile?.youtube_handle) },
    { key: 'logo',            label: 'Logo uploaded',     ok: !!profile?.logo_url },
  ]
  const done = checks.filter((c) => c.ok).length
  const total = checks.length
  const pct = Math.round((done / total) * 100)

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14 }}>Brand profile completeness</div>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16, fontVariantNumeric: 'tabular-nums', color: pct === 100 ? '#2ecc71' : pct >= 60 ? 'var(--text)' : 'var(--amber)' }}>
          {pct}%
        </div>
      </div>
      <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden', marginBottom: 14 }}>
        <div style={{
          width: `${pct}%`, height: '100%',
          background: pct === 100 ? '#2ecc71' : 'linear-gradient(90deg, var(--red), var(--red-dark))',
          transition: 'width 0.4s var(--ease)',
        }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 6 }}>
        {checks.map((c) => (
          <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: c.ok ? 'var(--text-soft)' : 'var(--muted)' }}>
            {c.ok ? <CheckCircle2 size={13} style={{ color: '#2ecc71' }} /> : <Circle size={13} style={{ opacity: 0.5 }} />}
            <span style={{ textDecoration: c.ok ? 'line-through' : 'none', textDecorationColor: 'rgba(46,204,113,0.5)' }}>
              {c.label}
            </span>
          </div>
        ))}
      </div>
      {pct < 100 && (
        <button onClick={onEdit} style={{
          marginTop: 14, width: '100%', padding: '8px 12px', borderRadius: 8,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          color: 'var(--text)', fontSize: 12.5, cursor: 'pointer',
          fontFamily: 'var(--font-display)', fontWeight: 600,
        }}>Open brand profile →</button>
      )}
    </div>
  )
}

// Quick links shaped to the focused product — Spaces, Schedule, Avatars.
function QuickAction({ icon: Icon, label, hint, to, color }) {
  const navigate = useNavigate()
  return (
    <button
      onClick={() => navigate(to)}
      style={{
        textAlign: 'left', cursor: 'pointer',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, padding: 16,
        display: 'flex', alignItems: 'center', gap: 12,
        transition: 'border-color 0.15s, transform 0.15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = color || 'var(--red)' }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)' }}
    >
      <div style={{ width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center', background: `${color || 'var(--red)'}22`, color: color || 'var(--red)' }}>
        <Icon size={16} strokeWidth={2.2} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{hint}</div>
      </div>
      <ArrowRight size={14} style={{ color: 'var(--muted)' }} />
    </button>
  )
}

export default function Dashboard() {
  const { user, session } = useAuth()
  const { selectedProfile, selectedProfileId, profiles } = useProfile()
  const navigate = useNavigate()
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [shippedThisMonth, setShippedThisMonth] = useState(null)
  // Onboarding survey: 'unknown' until we've checked, then 'show' or
  // 'hide'. Blocks the dashboard with a full-screen popup until the
  // 6 questions are answered. Skipped if the user already finished.
  const [onboardingState, setOnboardingState] = useState('unknown')

  useEffect(() => {
    if (!session) return
    let cancelled = false
    fetch('/api/me/onboarding', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => {
        if (cancelled) return
        setOnboardingState(b?.completed ? 'hide' : 'show')
      })
      .catch(() => { if (!cancelled) setOnboardingState('hide') })
    return () => { cancelled = true }
  }, [session])

  // "Shipped" = content_scripts rows with status='posted' (auto or
  // manual) inside the current calendar month. Single GET, no expensive
  // joins — relies on the existing /api/content listing.
  useEffect(() => {
    if (!session || !selectedProfileId) { setPendingApprovals(0); setShippedThisMonth(null); return }
    fetch(`/api/content?profile_id=${selectedProfileId}&filter=approvals`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => setPendingApprovals((b.items || []).length))
      .catch(() => {})

    fetch(`/api/content?profile_id=${selectedProfileId}&filter=posted`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => {
        const items = b.items || []
        const start = new Date()
        start.setDate(1); start.setHours(0, 0, 0, 0)
        const count = items.filter((it) => {
          const t = new Date(it.updated_at || it.scheduled_datetime || it.created_at).getTime()
          return t >= start.getTime()
        }).length
        setShippedThisMonth(count)
      })
      .catch(() => setShippedThisMonth(0))
  }, [session, selectedProfileId])

  const greeting = (() => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 18) return 'Good afternoon'
    return 'Good evening'
  })()
  const name = (user?.user_metadata?.business_name || user?.email?.split('@')[0] || 'there')

  // First-time visitor: profile-less. Push them to onboarding.
  const noProfile = profiles.length === 0

  return (
    <div className="fade-up">
      {onboardingState === 'show' && session?.access_token && (
        <OnboardingSurvey
          token={session.access_token}
          onComplete={() => setOnboardingState('hide')}
        />
      )}
      <section style={heroStyle}>
        <div style={heroIcon}><Sparkles size={26} strokeWidth={2.2} /></div>
        <div style={{ flex: 1 }}>
          <div style={heroTitle}>{greeting}, {name}.</div>
          <div style={heroSub}>
            {noProfile
              ? 'Welcome to ScaleSolo. Set up your first brand profile and your workflows can start writing in your voice.'
              : selectedProfile
                ? <>You're on <strong>{selectedProfile.business_name}</strong>. Your spaces are running in the background — here's what shipped.</>
                : 'Pick a brand profile to begin.'}
          </div>
        </div>
        <button className="btn-primary" onClick={() => navigate(noProfile ? '/profiles' : '/spaces')}>
          <Zap size={16} strokeWidth={2.5} />
          {noProfile ? 'Set up brand' : 'Open spaces'}
        </button>
      </section>

      {pendingApprovals > 0 && (
        <div
          onClick={() => navigate('/schedule')}
          style={{
            marginTop: 18, padding: '14px 18px',
            background: 'linear-gradient(135deg, rgba(245,158,11,0.16), rgba(245,158,11,0.05))',
            border: '1px solid rgba(245,158,11,0.35)',
            borderRadius: 14,
            display: 'flex', alignItems: 'center', gap: 12,
            cursor: 'pointer',
          }}
        >
          <div style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'rgba(245,158,11,0.18)', color: '#f59e0b' }}>
            <ClipboardCheck size={18} strokeWidth={2.2} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>
              {pendingApprovals} item{pendingApprovals === 1 ? '' : 's'} waiting for your approval
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-soft)', marginTop: 2 }}>
              Your workflows drafted content overnight. Review and approve to ship.
            </div>
          </div>
          <ArrowRight size={18} style={{ color: 'var(--text-soft)' }} />
        </div>
      )}

      {/* The headline number — what your workflows did this month. */}
      <div style={{ ...shippedCardStyle, marginTop: 18 }}>
        <div style={bigNumber}>{shippedThisMonth ?? '—'}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>
            posts shipped this month
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-soft)', marginTop: 4, lineHeight: 1.45 }}>
            {shippedThisMonth === 0
              ? 'Wire an Auto-run trigger into a Space and let your brand voice work while you sleep.'
              : 'Your workflows are running. Open Spaces to tweak cadence or add new ones.'}
          </div>
        </div>
        <button
          onClick={() => navigate('/spaces')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '10px 14px', borderRadius: 10,
            background: 'var(--surface)', border: '1px solid var(--border)',
            color: 'var(--text)', fontSize: 13, fontFamily: 'var(--font-display)', fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Open Spaces <ArrowRight size={13} />
        </button>
      </div>

      {/* Brand completeness — drives the "make my voice work" loop. */}
      {selectedProfile && (
        <>
          <div style={sectionLabel}><span>Make your workflows sound like you</span></div>
          <BrandCompletenessCard
            profile={selectedProfile}
            onEdit={() => navigate(`/profiles?id=${selectedProfileId}`)}
          />
        </>
      )}

      <div style={sectionLabel}><span>Quick actions</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        <QuickAction icon={Boxes}     label="New workflow"  hint="Start from a template or blank" to="/spaces"    color="#ef4444" />
        <QuickAction icon={Calendar}  label="Schedule"      hint="See what's queued + posted"     to="/schedule"  color="#3b82f6" />
        <QuickAction icon={BookOpen}  label="Avatars"       hint="Train your talking-head models" to="/avatars"   color="#a855f7" />
      </div>

      <div style={sectionLabel}>
        <span>Credits</span>
        <a href="/billing" style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 600 }}>View all →</a>
      </div>
      <CreditsPanel />
    </div>
  )
}
