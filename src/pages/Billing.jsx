import { useEffect, useState } from 'react'
import { CreditCard, ExternalLink, Sparkles, Crown } from 'lucide-react'
import { supabase } from '../lib/supabase.js'

const sectionTitle = {
  fontFamily: 'var(--font-display)',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
  marginBottom: 12,
}
const planCardStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 18,
  padding: 22,
  background: 'linear-gradient(135deg, rgba(239,68,68,0.14), rgba(185,28,28,0.08))',
  border: '1px solid rgba(239,68,68,0.35)',
  borderRadius: 16,
  marginBottom: 18,
}
const tierIcon = {
  width: 50, height: 50, borderRadius: 12, display: 'grid', placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', boxShadow: '0 6px 18px rgba(239,68,68,0.32)',
  flexShrink: 0,
}
const planName = { fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700 }
const planMeta = { color: 'var(--text-soft)', fontSize: 13, marginTop: 4 }

const statusPill = (status) => {
  const map = {
    trialing:    { bg: 'rgba(245,158,11,0.16)', fg: '#f59e0b', label: 'Trial' },
    active:      { bg: 'rgba(46,204,113,0.16)', fg: '#2ecc71', label: 'Active' },
    past_due:    { bg: 'rgba(239,68,68,0.16)',  fg: 'var(--red)', label: 'Past due' },
    canceled:    { bg: 'rgba(255,255,255,0.06)', fg: 'var(--muted)', label: 'Canceled' },
    incomplete:  { bg: 'rgba(245,158,11,0.16)', fg: '#f59e0b', label: 'Incomplete' },
    unpaid:      { bg: 'rgba(239,68,68,0.16)',  fg: 'var(--red)', label: 'Unpaid' },
  }
  return map[status] || { bg: 'rgba(255,255,255,0.06)', fg: 'var(--muted)', label: status || 'Unknown' }
}

const fmtDate = (iso) => {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function Billing() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [portalBusy, setPortalBusy] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const r = await fetch('/api/billing', {
          headers: { Authorization: `Bearer ${session?.access_token}` },
        })
        const body = await r.json()
        if (!active) return
        if (!r.ok) throw new Error(body.error || 'Failed to load billing')
        setData(body)
      } catch (e) {
        if (active) setError(e.message)
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [])

  const openPortal = async () => {
    setPortalBusy(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const r = await fetch('/api/stripe-portal', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}` },
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Could not open billing portal')
      window.location.href = body.url
    } catch (e) {
      setError(e.message)
      setPortalBusy(false)
    }
  }

  if (loading) {
    return <div className="fade-up"><div className="card-flat" style={{ padding: 40, textAlign: 'center' }}><div className="spinner" style={{ margin: '0 auto' }} /></div></div>
  }

  const sub = data?.subscription
  const catalog = data?.catalog || {}
  const tierDef = sub ? catalog[sub.tier] : null
  const pill = statusPill(sub?.status)

  return (
    <div className="fade-up">
      <div className="card-flat" style={{ marginBottom: 18 }}>
        <div style={sectionTitle}>Current plan</div>

        {sub ? (
          <div style={planCardStyle}>
            <div style={tierIcon}>
              {sub.tier === 'founding' ? <Crown size={22} strokeWidth={2.4} /> : <Sparkles size={22} strokeWidth={2.4} />}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={planName}>{tierDef?.name || sub.tier}</div>
                <span className="pill" style={{ background: pill.bg, color: pill.fg }}>{pill.label}</span>
              </div>
              <div style={planMeta}>
                {sub.billing_cycle === 'annual' ? 'Billed annually' : 'Billed monthly'}
                {sub.profile_limit ? ` · ${sub.profile_limit} brand profile${sub.profile_limit > 1 ? 's' : ''} included` : ''}
                {sub.cancel_at_period_end ? ' · Cancels at period end' : ''}
              </div>
            </div>
            <button className="btn-primary" onClick={openPortal} disabled={portalBusy}>
              {portalBusy ? <span className="spinner" /> : <ExternalLink size={15} />}
              Manage in Stripe
            </button>
          </div>
        ) : (
          <div style={{ ...planCardStyle, background: 'var(--surface-2)', borderColor: 'var(--border)' }}>
            <div style={{ ...tierIcon, background: 'var(--surface-3)', boxShadow: 'none', color: 'var(--muted)' }}>
              <CreditCard size={22} strokeWidth={2.2} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={planName}>No active subscription</div>
              <div style={planMeta}>Pick a plan to get started.</div>
            </div>
            <a href="/pricing" className="btn-primary"><Sparkles size={15} /> View plans</a>
          </div>
        )}

        {sub && (
          <div className="card-flat" style={{ background: 'var(--surface-2)', marginTop: 4 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
              <Field label="Status" value={pill.label} />
              <Field label="Trial ends" value={fmtDate(sub.trial_end)} />
              <Field label="Current period ends" value={fmtDate(sub.current_period_end)} />
              <Field label="Cancels at period end" value={sub.cancel_at_period_end ? 'Yes' : 'No'} />
            </div>
          </div>
        )}
      </div>

      <div className="card-flat">
        <div style={sectionTitle}>Payment method &amp; invoices</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14 }}>Open Stripe Customer Portal</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>Update card, download invoices, change plan, cancel.</div>
          </div>
          <button className="btn-secondary" onClick={openPortal} disabled={portalBusy}>
            {portalBusy ? <span className="spinner" /> : <ExternalLink size={15} />}
            Open portal
          </button>
        </div>
      </div>

      {error && (
        <div style={{ marginTop: 18, padding: '12px 16px', background: 'var(--red-soft)', color: 'var(--red)', borderRadius: 10, fontSize: 13 }}>
          {error}
        </div>
      )}
    </div>
  )
}

function Field({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 14, marginTop: 4, color: 'var(--text)' }}>{value}</div>
    </div>
  )
}
