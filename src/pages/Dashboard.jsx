import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Sparkles, Zap, ClipboardCheck, ArrowRight, Boxes, Calendar, BookOpen, CheckCircle2, Circle, Eye, Heart, MessageCircle, Share2, FileText, FilePlus2, TrendingUp, TrendingDown, Minus, Users } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { useCredits } from '../context/CreditsContext.jsx'
import CreditsPanel from '../components/CreditsPanel.jsx'
import OnboardingSurvey from '../components/OnboardingSurvey.jsx'
import VoiceSummaryCard from '../components/VoiceSummaryCard.jsx'

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

// Compact metric tile for the pipeline row. Number + label + colored icon.
function StatTile({ icon: Icon, label, value, color }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '14px 16px',
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: 9,
        display: 'grid', placeItems: 'center',
        background: `${color}22`, color,
      }}>
        <Icon size={15} strokeWidth={2.2} />
      </div>
      <div>
        <div style={{
          fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22,
          fontVariantNumeric: 'tabular-nums', color: 'var(--text)', lineHeight: 1.05,
        }}>{Number.isFinite(value) ? value : '—'}</div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{label}</div>
      </div>
    </div>
  )
}

// Platform display names + brand colors. Falls back to capitalize+grey
// for any platform Upload-Post adds that we haven't styled yet.
const PLATFORM_META = {
  tiktok:    { label: 'TikTok',    color: '#000000' },
  instagram: { label: 'Instagram', color: '#e1306c' },
  youtube:   { label: 'YouTube',   color: '#ff0000' },
  facebook:  { label: 'Facebook',  color: '#1877f2' },
  threads:   { label: 'Threads',   color: '#000000' },
  linkedin:  { label: 'LinkedIn',  color: '#0a66c2' },
  x:         { label: 'X',         color: '#000000' },
  twitter:   { label: 'X',         color: '#000000' },
  pinterest: { label: 'Pinterest', color: '#e60023' },
}
const platformMeta = (id) => PLATFORM_META[id] || {
  label: id ? id[0].toUpperCase() + id.slice(1) : 'Unknown',
  color: '#64748b',
}

// Render a delta as "+12% · +3" or "−8% · −1". Renders "new" when
// previous value was zero and current > 0 (the pct math would divide
// by zero so the API returns null there).
function DeltaBadge({ delta, suffix = '' }) {
  if (!delta) return <span style={{ color: 'var(--muted)' }}>—</span>
  const { abs, pct } = delta
  const isNew = pct == null && abs > 0
  const isFlat = abs === 0
  const isUp   = abs > 0
  const Icon = isFlat ? Minus : isUp ? TrendingUp : TrendingDown
  const color = isFlat ? 'var(--muted)' : isUp ? '#2ecc71' : '#ef4444'
  const label = isNew
    ? 'new'
    : (pct == null ? `${abs >= 0 ? '+' : ''}${abs}${suffix}` : `${pct >= 0 ? '+' : ''}${pct.toFixed(pct % 1 === 0 ? 0 : 1)}%`)
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      fontSize: 11.5, fontWeight: 700, color,
      fontFamily: 'var(--font-display)',
    }}>
      <Icon size={11} strokeWidth={2.6} />
      {label}
    </span>
  )
}

// MoM growth card. Pulls from /api/social/growth and shows headline
// month-vs-month deltas + a tile per connected platform. Hidden when
// the user has no connected accounts so a blank-slate brand doesn't
// see an empty card screaming about zero engagement.
function SocialGrowthCard({ data, onOpen }) {
  const tm = data.this_month || {}
  const lm = data.last_month || {}
  const platforms = data.per_platform || {}
  const platformIds = Object.keys(platforms).filter((id) => platforms[id]?.connected || (platforms[id]?.this_month?.posts ?? 0) > 0)
  const fmt = (n) => n == null ? '—' : Number(n).toLocaleString()
  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(34,197,94,0.10), rgba(34,197,94,0.02))',
      border: '1px solid rgba(34,197,94,0.30)',
      borderRadius: 14, padding: 18,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 14, color: 'var(--text)' }}>
            {tm.label} vs {lm.label}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            Month over month — posts published + estimated impressions
          </div>
        </div>
        <button onClick={onOpen} style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '7px 12px', borderRadius: 8,
          background: 'var(--surface)', border: '1px solid var(--border)',
          color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-display)', fontWeight: 700,
          cursor: 'pointer',
        }}>Details <ArrowRight size={12} /></button>
      </div>

      {/* Headline row: posts + impressions deltas across the whole profile. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 14 }}>
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 10, padding: '10px 12px',
        }}>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
            Posts shipped
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, fontVariantNumeric: 'tabular-nums', color: 'var(--text)' }}>
              {fmt(tm.posts)}
            </span>
            <DeltaBadge delta={data.deltas?.posts} />
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>vs {fmt(lm.posts)} last month</div>
        </div>
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 10, padding: '10px 12px',
        }}>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
            Impressions
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, fontVariantNumeric: 'tabular-nums', color: 'var(--text)' }}>
              {fmt(tm.impressions)}
            </span>
            <DeltaBadge delta={data.deltas?.impressions} />
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>vs {fmt(lm.impressions)} last month</div>
        </div>
      </div>

      {/* Per-platform tiles. */}
      {platformIds.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, marginBottom: 8 }}>
            By platform
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
            {platformIds.map((id) => {
              const p = platforms[id] || {}
              const meta = platformMeta(id)
              return (
                <div key={id} style={{
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 10, padding: '10px 12px',
                  opacity: p.connected ? 1 : 0.55,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12.5, color: 'var(--text)',
                    }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: 999, background: meta.color,
                        display: 'inline-block',
                      }} />
                      {meta.label}
                    </span>
                    {!p.connected && (
                      <span style={{
                        fontSize: 9.5, padding: '2px 6px', borderRadius: 999,
                        background: 'var(--surface-2)', color: 'var(--muted)',
                        fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '0.04em',
                      }}>NOT LINKED</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18, fontVariantNumeric: 'tabular-nums', color: 'var(--text)' }}>
                      {fmt(p.this_month?.posts)}
                    </span>
                    <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>posts</span>
                    <DeltaBadge delta={p.delta?.posts} />
                  </div>
                  {(p.followers != null || p.impressions != null) && (
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4, display: 'flex', gap: 10 }}>
                      {p.followers != null && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          <Users size={10} /> {fmt(p.followers)} followers
                        </span>
                      )}
                      {p.impressions != null && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          <Eye size={10} /> {fmt(p.impressions)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {platformIds.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          Connect a social account on the <a href="/schedule" style={{ color: 'var(--red)', fontWeight: 700 }}>Schedule</a> page to start tracking growth.
        </div>
      )}
    </div>
  )
}

// Aggregate engagement card — sums the post-level metrics returned by
// /api/analytics so the user sees a single line ("X views, Y likes, …")
// without us having to plumb totals through the analytics endpoint.
function SocialSignalCard({ data, onOpen }) {
  const totals = (data?.recent_post_metrics || []).reduce((acc, p) => {
    acc.views    += Number(p.views || 0)
    acc.likes    += Number(p.likes || 0)
    acc.comments += Number(p.comments || 0)
    acc.shares   += Number(p.shares || 0)
    return acc
  }, { views: 0, likes: 0, comments: 0, shares: 0 })
  const tImpressions = data?.uploadpost_total_impressions?.total || data?.uploadpost_total_impressions?.impressions
  const fmt = (n) => Number(n).toLocaleString()
  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(59,130,246,0.10), rgba(59,130,246,0.02))',
      border: '1px solid rgba(59,130,246,0.30)',
      borderRadius: 14, padding: 18,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
        <SignalStat icon={Eye}            label="Views"    value={tImpressions || totals.views} />
        <SignalStat icon={Heart}          label="Likes"    value={totals.likes} />
        <SignalStat icon={MessageCircle}  label="Comments" value={totals.comments} />
        <SignalStat icon={Share2}         label="Shares"   value={totals.shares} />
        <div style={{ flex: 1 }} />
        <button onClick={onOpen} style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '8px 14px', borderRadius: 10,
          background: 'var(--surface)', border: '1px solid var(--border)',
          color: 'var(--text)', fontSize: 12.5, fontFamily: 'var(--font-display)', fontWeight: 700,
          cursor: 'pointer',
        }}>
          See full analytics <ArrowRight size={13} />
        </button>
      </div>
      {(data?.recent_post_metrics?.length || 0) === 0 && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
          Metrics warm up after Upload-Post syncs your first round of posts (typically within an hour of publish).
        </div>
      )}
    </div>
  )
  function SignalStat({ icon: Icon, label, value }) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 32, height: 32, borderRadius: 9, background: 'rgba(59,130,246,0.18)', color: '#3b82f6', display: 'grid', placeItems: 'center' }}>
          <Icon size={14} strokeWidth={2.2} />
        </div>
        <div>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18, fontVariantNumeric: 'tabular-nums', color: 'var(--text)', lineHeight: 1.05 }}>
            {fmt(value)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{label}</div>
        </div>
      </div>
    )
  }
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
  const { selectedProfile, selectedProfileId, profiles, refresh: refreshProfiles } = useProfile()
  const { pools: creditPools } = useCredits()
  const navigate = useNavigate()
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [shippedThisMonth, setShippedThisMonth] = useState(null)
  const [stats, setStats] = useState(null)
  const [social, setSocial] = useState(null)
  const [growth, setGrowth] = useState(null)
  // Onboarding survey: 'unknown' until we've checked, then 'show' or
  // 'hide'. Blocks the dashboard with a full-screen popup until the
  // 6 questions are answered. Skipped if the user already finished —
  // unless they hit /dashboard?survey=true (or ?survey=1), which forces
  // it to re-show so an admin / user who wants to update answers can
  // see the popup again. The query param strips itself after the
  // survey closes so refreshes don't keep retriggering.
  const [searchParams, setSearchParams] = useSearchParams()
  const surveyForced = searchParams.get('survey') === 'true' || searchParams.get('survey') === '1'
  const [onboardingState, setOnboardingState] = useState(surveyForced ? 'show' : 'unknown')

  // Welcome banner: shown for the brief window after a fresh signup
  // while the Stripe webhook + credit grant settle. Captured on mount
  // so a manual refresh (which strips ?welcome) doesn't flicker it
  // away mid-poll. Auto-hides once any credits show up OR after 30s.
  const [showWelcome, setShowWelcome] = useState(() => {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('welcome') === '1'
  })

  useEffect(() => {
    if (!session) return
    if (surveyForced) { setOnboardingState('show'); return }
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
  }, [session, surveyForced])

  // Hide the welcome banner the moment credits arrive (webhook landed
   // or link-session finished). Also enforce a 30s ceiling so a totally
   // failed grant doesn't leave the banner stuck.
  useEffect(() => {
    if (!showWelcome) return
    const haveCredits = (creditPools?.video_units?.balance || 0) > 0
      || (creditPools?.ai_tokens?.balance || 0) > 0
    if (haveCredits) { setShowWelcome(false); return }
    const t = setTimeout(() => setShowWelcome(false), 30_000)
    return () => clearTimeout(t)
  }, [showWelcome, creditPools])

  const closeOnboarding = () => {
    setOnboardingState('hide')
    // The survey just created the user's first brand profile via
    // /api/profiles. ProfileContext doesn't know about it yet — it
    // loaded once on mount with an empty list. Refetch so the dashboard
    // (and the brand switcher in the nav) shows the new brand without
    // needing a hard page reload.
    refreshProfiles?.()
    if (surveyForced) {
      // Strip ?survey from the URL so a refresh doesn't reopen it.
      const next = new URLSearchParams(searchParams)
      next.delete('survey')
      setSearchParams(next, { replace: true })
    }
  }

  // "Shipped" = content_scripts rows with status='posted' (auto or
  // manual) inside the current calendar month. Single GET, no expensive
  // joins — relies on the existing /api/content listing.
  useEffect(() => {
    if (!session || !selectedProfileId) {
      setPendingApprovals(0); setShippedThisMonth(null); setStats(null); setSocial(null); setGrowth(null)
      return
    }
    // Counters: created/shipped/scheduled/drafts/pending. Single round-trip.
    fetch(`/api/content/stats?profile_id=${selectedProfileId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => {
        if (b?.error) throw new Error(b.error)
        setStats(b)
        setShippedThisMonth(b.shipped_month ?? 0)
        setPendingApprovals(b.pending_approval ?? 0)
      })
      .catch(() => {
        setShippedThisMonth(0)
        setStats(null)
      })

    // Social engagement summary — best-effort. /api/analytics already
    // owns the Upload-Post fan-out + cache so we just hand it the
    // profile + 30d window and pluck the totals it returns. If
    // Upload-Post isn't wired or the call fails we render nothing.
    fetch(`/api/analytics?profile_id=${selectedProfileId}&window=30d`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => setSocial(b && !b.error ? b : null))
      .catch(() => setSocial(null))

    // MoM growth — dedicated endpoint that compares this calendar
    // month against last. Independent of /api/analytics so a slow
    // Upload-Post analytics call doesn't block the growth card.
    fetch(`/api/social/growth?profile_id=${selectedProfileId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => setGrowth(b && !b.error ? b : null))
      .catch(() => setGrowth(null))
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
          onComplete={closeOnboarding}
          onSkip={surveyForced ? closeOnboarding : null}
        />
      )}
      {showWelcome && (
        <div style={{
          marginBottom: 18, padding: '14px 18px',
          background: 'linear-gradient(135deg, rgba(46,204,113,0.16), rgba(46,204,113,0.04))',
          border: '1px solid rgba(46,204,113,0.35)',
          borderRadius: 14,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10,
            display: 'grid', placeItems: 'center',
            background: 'rgba(46,204,113,0.18)', color: '#2ecc71',
            position: 'relative',
          }}>
            <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2, borderColor: 'rgba(46,204,113,0.35)', borderTopColor: '#2ecc71' }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>
              Setting up your account…
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-soft)', marginTop: 2 }}>
              We're finalizing your subscription and granting your trial credits. This usually takes a few seconds.
            </div>
          </div>
        </div>
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

      {/* Content pipeline — created vs shipped vs queued. Gives the
          user a sense of how much work the workflows are turning out
          and how much is sitting in approval / draft state. */}
      {selectedProfile && stats && (
        <>
          <div style={sectionLabel}><span>Content pipeline this month</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
            <StatTile icon={FilePlus2} label="Created"  value={stats.created_month}    color="#a855f7" />
            <StatTile icon={ClipboardCheck} label="Awaiting approval" value={stats.pending_approval} color="#f59e0b" />
            <StatTile icon={Calendar} label="Scheduled" value={stats.scheduled}        color="#3b82f6" />
            <StatTile icon={FileText} label="Drafts"   value={stats.drafts}            color="#94a3b8" />
            <StatTile icon={Sparkles} label="Shipped"  value={stats.shipped_month}     color="#2ecc71" />
          </div>
        </>
      )}

      {/* Month-over-month growth. Renders whenever the user has either
          connected accounts OR has shipped at least one post in either
          month — that way a brand-new brand still sees the card prompt
          them to connect, instead of an awkward blank space. */}
      {selectedProfile && growth && (
        (growth.connected?.length || 0) > 0 ||
        (growth.this_month?.posts || 0) > 0 ||
        (growth.last_month?.posts || 0) > 0
      ) && (
        <>
          <div style={sectionLabel}><span>Social growth</span></div>
          <SocialGrowthCard data={growth} onOpen={() => navigate('/analytics')} />
        </>
      )}

      {/* Social engagement — pulled from Upload-Post via /api/analytics.
          Renders nothing if Upload-Post isn't wired or the cache is empty. */}
      {selectedProfile && social && (social.uploadpost_total_impressions || social.recent_post_metrics) && (
        <>
          <div style={sectionLabel}><span>Social signal (last 30 days)</span></div>
          <SocialSignalCard data={social} onOpen={() => navigate('/analytics')} />
        </>
      )}

      {/* What the AI has learned about the brand voice. */}
      {selectedProfile && session?.access_token && (
        <>
          <div style={sectionLabel}><span>Voice intelligence</span></div>
          <VoiceSummaryCard profileId={selectedProfileId} session={session} compact />
        </>
      )}

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
