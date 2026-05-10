import { useEffect } from 'react'
import { Link, Routes, Route, useNavigate } from 'react-router-dom'
import { ShieldCheck, LayoutGrid, ArrowRight, Activity, Users, Sparkles } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import AdminTemplates from './AdminTemplates.jsx'
import AdminUsage from './AdminUsage.jsx'
import AdminUsers from './AdminUsers.jsx'
import AdminAffiliates from './AdminAffiliates.jsx'
import AdminOps from './AdminOps.jsx'

// Admin home + nested admin routes. The Sidebar only shows the link to
// admins, but we also gate at the route level so a non-admin who guesses
// the URL is bounced to /dashboard. The user_profiles RLS policy already
// blocks them from reading anyone else's is_admin flag, but the bounce
// is friendlier than letting an unauthorized user land on a broken page.
function AdminGate({ children }) {
  const { isAdmin, loading } = useAuth()
  const nav = useNavigate()
  useEffect(() => {
    if (!loading && !isAdmin) nav('/dashboard', { replace: true })
  }, [isAdmin, loading, nav])
  if (loading) return null
  if (!isAdmin) return null
  return children
}

const cards = [
  {
    to: '/admin/templates',
    title: 'Space templates',
    body: 'Create, edit, and gate global Spaces templates that users can clone as a starting point for their own canvases.',
    Icon: LayoutGrid,
  },
  {
    to: '/admin/usage',
    title: 'Usage & cost',
    body: 'Credit consumption breakdown by action and user across 24h / 7d / 30d windows. Spot the actions eating the bulk of cost.',
    Icon: Activity,
  },
  {
    to: '/admin/users',
    title: 'User management',
    body: 'Search accounts, send password resets, comp credits. Stripe subscription + coupon flows live in the Stripe dashboard.',
    Icon: Users,
  },
  {
    to: '/admin/affiliates',
    title: 'Affiliates',
    body: 'Approve applications, promote tier (Starter / Pro / Elite), and record manual PayPal payouts.',
    Icon: Sparkles,
  },
  {
    to: '/admin/ops',
    title: 'System ops',
    body: 'Every-morning dashboard. Stuck rows, failed webhooks, refund spikes, cron health. Maps to RUNBOOK.md.',
    Icon: Activity,
  },
]

function AdminHome() {
  return (
    <div style={page}>
      <div style={hero}>
        <div style={heroIcon}><ShieldCheck size={20} /></div>
        <div>
          <div style={heroTitle}>Admin</div>
          <div style={heroSub}>Tools that ship to every workspace.</div>
        </div>
      </div>
      <div style={grid}>
        {cards.map((c) => (
          <Link key={c.to} to={c.to} style={card} className="lift">
            <div style={cardIconWrap}><c.Icon size={18} /></div>
            <div style={cardTitle}>{c.title}</div>
            <div style={cardBody}>{c.body}</div>
            <div style={cardCta}>Open <ArrowRight size={13} /></div>
          </Link>
        ))}
      </div>
    </div>
  )
}

export default function Admin() {
  return (
    <AdminGate>
      <Routes>
        <Route path="/" element={<AdminHome />} />
        <Route path="/templates" element={<AdminTemplates />} />
        <Route path="/usage" element={<AdminUsage />} />
        <Route path="/users" element={<AdminUsers />} />
        <Route path="/affiliates" element={<AdminAffiliates />} />
        <Route path="/ops" element={<AdminOps />} />
      </Routes>
    </AdminGate>
  )
}

const page = { padding: '32px 28px', maxWidth: 1100, margin: '0 auto' }
const hero = { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }
const heroIcon = {
  width: 38, height: 38, borderRadius: 10,
  background: 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(249,115,22,0.10))',
  border: '1px solid rgba(239,68,68,0.30)',
  color: 'var(--red)',
  display: 'grid', placeItems: 'center',
}
const heroTitle = {
  fontFamily: 'var(--font-display)', fontWeight: 800,
  fontSize: 22, color: 'var(--text)', letterSpacing: '-0.01em',
}
const heroSub = { fontSize: 13, color: 'var(--text-soft)', marginTop: 2 }
const grid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
  gap: 14,
}
const card = {
  display: 'block',
  padding: 18,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  textDecoration: 'none',
  color: 'var(--text)',
  transition: 'transform .25s var(--ease), border-color .25s var(--ease), box-shadow .25s var(--ease)',
}
const cardIconWrap = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 36, height: 36, borderRadius: 10,
  background: 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(249,115,22,0.10))',
  border: '1px solid rgba(239,68,68,0.30)',
  color: 'var(--red)',
  marginBottom: 12,
}
const cardTitle = {
  fontFamily: 'var(--font-display)', fontWeight: 700,
  fontSize: 16, color: 'var(--text)', marginBottom: 6,
}
const cardBody = { fontSize: 13, color: 'var(--text-soft)', lineHeight: 1.5, marginBottom: 12 }
const cardCta = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontFamily: 'var(--font-display)', fontWeight: 700,
  fontSize: 12, color: 'var(--red)',
  letterSpacing: '0.04em',
}
