import { Sparkles, TrendingUp, Mail, Users, Zap } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'

const grid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: 18,
  marginTop: 24,
}
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
  width: 54,
  height: 54,
  borderRadius: 14,
  display: 'grid',
  placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff',
  boxShadow: '0 8px 24px rgba(239,68,68,0.4)',
  flexShrink: 0,
}
const heroTitle = {
  fontFamily: 'var(--font-display)',
  fontSize: 22,
  fontWeight: 700,
  letterSpacing: '-0.01em',
}
const heroSub = { color: 'var(--text-soft)', fontSize: 14, marginTop: 4 }
const metricLabel = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  color: 'var(--muted)',
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  fontFamily: 'var(--font-display)',
}
const metricValue = {
  fontFamily: 'var(--font-display)',
  fontSize: 28,
  fontWeight: 700,
  color: 'var(--text)',
  marginTop: 8,
}
const metricHint = { fontSize: 12, color: 'var(--muted)', marginTop: 6 }

function Metric({ icon: Icon, label, value, hint }) {
  return (
    <div className="card">
      <div style={metricLabel}><Icon size={14} strokeWidth={2.4} />{label}</div>
      <div style={metricValue}>{value}</div>
      <div style={metricHint}>{hint}</div>
    </div>
  )
}

export default function Dashboard() {
  const { user } = useAuth()
  const { selectedProfile, profiles } = useProfile()
  const greeting = (() => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 18) return 'Good afternoon'
    return 'Good evening'
  })()
  const name = (user?.user_metadata?.business_name || user?.email?.split('@')[0] || 'there')

  return (
    <div className="fade-up">
      <section style={heroStyle}>
        <div style={heroIcon}><Sparkles size={26} strokeWidth={2.2} /></div>
        <div style={{ flex: 1 }}>
          <div style={heroTitle}>{greeting}, {name}.</div>
          <div style={heroSub}>
            {selectedProfile
              ? <>You're on <strong>{selectedProfile.business_name}</strong>. Pick something to ship today.</>
              : profiles.length === 0
                ? 'Welcome to ScaleSolo. Let\'s set up your first brand profile.'
                : 'Pick a brand profile to begin.'}
          </div>
        </div>
        <button className="btn-primary">
          <Zap size={16} strokeWidth={2.5} />
          Generate content
        </button>
      </section>

      <div style={grid}>
        <Metric icon={Sparkles}   label="AI tokens"     value="—"  hint="Plug in tier credits in Milestone 2" />
        <Metric icon={TrendingUp} label="Posts this wk" value="—"  hint="Wires up after content engine port" />
        <Metric icon={Mail}       label="Emails sent"   value="—"  hint="Postmark integration in Milestone 4" />
        <Metric icon={Users}      label="Contacts"      value="—"  hint="CRM expansion in Milestone 5" />
      </div>

      <div style={{ marginTop: 28, color: 'var(--muted)', fontSize: 12.5 }}>
        v0.1.0 · Milestone 0 skeleton · See <code>SCALESOLO_PHASE_1_PLAN.md</code> for what ships next.
      </div>
    </div>
  )
}
