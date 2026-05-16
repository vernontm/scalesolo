import { useEffect, useState } from 'react'
import { CreditCard, ExternalLink, Sparkles, Crown, Receipt, ArrowUpRight, ArrowDownRight, Check } from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { useCredits, fmtCount, POOL_META } from '../context/CreditsContext.jsx'
import CreditsPanel from '../components/CreditsPanel.jsx'
import { confirmDialog, toast } from '../components/Toast.jsx'

// Tiers shown in the "Change plan" grid. We deliberately skip
// 'founding' here — its lifetime lock means we don't expose a swap
// button (the change-plan endpoint refuses to touch a founding row,
// and the user can still cancel from the Stripe portal).
const PLAN_ORDER = ['solo_starter', 'solo_pro', 'solo_studio']
function tierIndex(t) { return PLAN_ORDER.indexOf(t) }

function ChangePlanCard({ tierKey, tierDef, currentTier, currentCycle, cycle, busy, onPick }) {
  const isCurrent = tierKey === currentTier && cycle === currentCycle
  const direction = (() => {
    if (isCurrent) return 'current'
    if (currentTier && PLAN_ORDER.includes(currentTier)) {
      const a = tierIndex(tierKey), b = tierIndex(currentTier)
      if (a > b) return 'upgrade'
      if (a < b) return 'downgrade'
      // Same tier, different cycle — treat annual as an "upgrade" (cheaper effective rate).
      return cycle === 'annual' ? 'upgrade' : 'downgrade'
    }
    return 'upgrade'
  })()
  const price = cycle === 'annual'
    ? (tierDef.annual_usd ? Math.round(tierDef.annual_usd / 12) : null)
    : tierDef.monthly_usd
  const totalLine = cycle === 'annual' && tierDef.annual_usd
    ? `$${tierDef.annual_usd}/year — billed annually`
    : 'Billed monthly'

  const cardStyle = {
    position: 'relative',
    background: isCurrent ? 'linear-gradient(135deg, rgba(46,204,113,0.10), rgba(46,204,113,0.02))' : 'var(--surface)',
    border: `1px solid ${isCurrent ? 'rgba(46,204,113,0.40)' : 'var(--border)'}`,
    borderRadius: 14,
    padding: 18,
    display: 'flex', flexDirection: 'column', gap: 10,
  }

  return (
    <div style={cardStyle}>
      {isCurrent && (
        <span style={{ position: 'absolute', top: 10, right: 12, fontSize: 10, fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#2ecc71' }}>
          Current
        </span>
      )}
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16 }}>{tierDef.name}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 28, letterSpacing: '-0.02em' }}>
          ${price ?? '—'}
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>/ mo</span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{totalLine}</div>
      <ul style={{ margin: '4px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {tierDef.profile_limit && (
          <li style={featureRow}><Check size={11} strokeWidth={3} style={checkIcon} /> {tierDef.profile_limit} brand profile{tierDef.profile_limit > 1 ? 's' : ''}</li>
        )}
        {tierDef.credits?.ai_tokens != null && (
          <li style={featureRow}><Check size={11} strokeWidth={3} style={checkIcon} /> {fmtCount(tierDef.credits.ai_tokens)} AI tokens / mo</li>
        )}
        {tierDef.credits?.video_units != null && (
          <li style={featureRow}><Check size={11} strokeWidth={3} style={checkIcon} /> {fmtCount(tierDef.credits.video_units)} avatar video units / mo</li>
        )}
      </ul>
      <button
        onClick={() => !isCurrent && onPick(tierKey, cycle, direction)}
        disabled={isCurrent || busy}
        style={{
          marginTop: 'auto',
          padding: '9px 12px', borderRadius: 8,
          cursor: isCurrent ? 'default' : 'pointer',
          fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12.5,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          background: isCurrent
            ? 'rgba(46,204,113,0.18)'
            : direction === 'upgrade'
              ? 'linear-gradient(135deg, var(--red), var(--red-dark))'
              : 'var(--surface-2)',
          color: isCurrent ? '#2ecc71' : direction === 'upgrade' ? '#fff' : 'var(--text)',
          border: direction === 'downgrade' && !isCurrent ? '1px solid var(--border)' : 'none',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {isCurrent ? <>Current plan</> :
         direction === 'upgrade' ? <><ArrowUpRight size={13} /> Upgrade</> :
         <><ArrowDownRight size={13} /> Downgrade</>}
      </button>
    </div>
  )
}

const featureRow = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-soft)' }
const checkIcon = { color: '#2ecc71', flexShrink: 0 }

const cycleToggleWrap = {
  display: 'inline-flex', padding: 3, borderRadius: 999,
  background: 'var(--surface-2)', border: '1px solid var(--border)', gap: 2,
}
const cycleBtn = (active) => ({
  padding: '5px 12px', borderRadius: 999, fontSize: 11.5,
  background: active ? 'var(--surface)' : 'transparent',
  color: active ? 'var(--text)' : 'var(--muted)',
  border: 'none', cursor: 'pointer',
  fontFamily: 'var(--font-display)', fontWeight: 700,
})

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
  color: '#fff', boxShadow: '0 6px 18px rgba(239,68,68,0.32)', flexShrink: 0,
}
const planName = { fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700 }
const planMeta = { color: 'var(--text-soft)', fontSize: 13, marginTop: 4 }
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

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

const txTable = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
}
const th = { textAlign: 'left', color: 'var(--muted)', fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '10px 12px', borderBottom: '1px solid var(--border)' }
const td = { padding: '12px', borderBottom: '1px solid var(--border)', color: 'var(--text-soft)' }

function ActionLabel({ action }) {
  if (action === 'subscription_initial') return <span className="pill pill-success">Subscription</span>
  if (action === 'monthly_grant')        return <span className="pill pill-success">Monthly grant</span>
  if (action === 'topup')                return <span className="pill pill-success">Top-up</span>
  if (action?.startsWith('consume:'))    return <span className="pill pill-warning">{action.replace('consume:', '')}</span>
  return <span className="pill pill-muted">{action}</span>
}

export default function Billing() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [portalBusy, setPortalBusy] = useState(false)
  const [tx, setTx] = useState([])
  const { refresh: refreshCredits } = useCredits()

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const [billingRes, txRes] = await Promise.all([
          fetch('/api/billing', { headers: { Authorization: `Bearer ${session?.access_token}` } }),
          fetch('/api/credits/transactions?limit=20', { headers: { Authorization: `Bearer ${session?.access_token}` } }),
        ])
        const billingBody = await billingRes.json()
        const txBody = await txRes.json()
        if (!active) return
        if (!billingRes.ok) throw new Error(billingBody.error || 'Failed to load billing')
        setData(billingBody)
        setTx(txBody.transactions || [])
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

  // End-trial flow. For users currently on the 3-day trial who want
  // to start the paid subscription NOW (e.g. they want full credit
  // grants, or they're about to run something past the trial limits).
  // Confirms with the user, hits /api/stripe-end-trial, refetches.
  const [endTrialBusy, setEndTrialBusy] = useState(false)
  const endTrialNow = async () => {
    const ok = window.confirm(
      'Skip the rest of your trial and start your subscription now? Your card on file will be charged for the full billing period today.'
    )
    if (!ok) return
    setEndTrialBusy(true)
    setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const r = await fetch('/api/stripe-end-trial', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}` },
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Could not end the trial')
      // If Stripe returned a hosted invoice URL (no card on file, SCA
      // needed, payment incomplete, etc), send them there to add their
      // card / confirm. Falls back to nested latest_invoice for safety.
      const invoiceUrl = body?.hosted_invoice_url || body?.latest_invoice?.hosted_invoice_url
      if (body?.needs_payment && invoiceUrl) {
        window.location.href = invoiceUrl
        return
      }
      if (invoiceUrl && !body?.needs_payment) {
        // Even on success Stripe may return a hosted_invoice_url for a
        // paid invoice — that's fine, just reload instead of redirecting.
      }
      // Soft delay so the webhook has a chance to land before we
      // refetch — Stripe's invoice.paid event usually arrives within
      // 1-2 seconds of the API call returning.
      setTimeout(() => { window.location.reload() }, 1500)
    } catch (e) {
      setError(e.message)
      setEndTrialBusy(false)
    }
  }

  // Change-plan flow. Confirms with the user, hits /api/stripe-change-plan,
  // then refetches /api/billing so the "Current plan" tile reflects the
  // swap. Stripe handles proration on its end (always_invoice mode in the
  // server endpoint), so the user pays the diff or gets a credit
  // automatically.
  const [planCycle, setPlanCycle] = useState('monthly')
  const [planBusy, setPlanBusy] = useState(false)

  const submitPlanChange = async (tier, cycle, direction) => {
    const tierName = data?.catalog?.[tier]?.name || tier
    const verb = direction === 'upgrade' ? 'Upgrade' : 'Downgrade'
    const message = direction === 'upgrade'
      ? `You'll be charged the prorated difference now and start getting the ${tierName} credit allotment immediately. Continue?`
      : `Your subscription drops to ${tierName} at the next billing cycle. You'll get a credit for unused time on your current plan. Continue?`
    const ok = await confirmDialog({
      title: `${verb} to ${tierName}?`,
      message,
      confirmText: verb,
    })
    if (!ok) return
    setPlanBusy(true); setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const r = await fetch('/api/stripe-change-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ tier, billing_cycle: cycle }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Plan change failed (${r.status})`)
      // Refetch the billing snapshot so the "Current plan" pill flips.
      const re = await fetch('/api/billing', { headers: { Authorization: `Bearer ${session?.access_token}` } })
      const reBody = await re.json()
      if (re.ok) setData(reBody)
      toast({ message: `Plan updated to ${tierName}.`, kind: 'success' })
      refreshCredits()
    } catch (e) {
      setError(e.message)
      toast({ message: e.message, kind: 'error' })
    } finally {
      setPlanBusy(false)
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
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {sub.status === 'trialing' && (
                <button
                  className="btn-primary"
                  onClick={endTrialNow}
                  disabled={endTrialBusy}
                  title="Skip the rest of the trial and start your subscription today"
                  style={{ background: 'linear-gradient(135deg, #f59e0b, #f97316)' }}
                >
                  {endTrialBusy ? <span className="spinner" /> : <Sparkles size={15} />}
                  Start subscription now
                </button>
              )}
              <button className="btn-primary" onClick={openPortal} disabled={portalBusy}>
                {portalBusy ? <span className="spinner" /> : <ExternalLink size={15} />}
                Manage in Stripe
              </button>
            </div>
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

      {/* Change plan — only show when there's an active non-founding sub.
          Founding members keep their lifetime lock and use the portal
          for any cancel/swap; new users land on /pricing first. */}
      {sub && sub.tier !== 'founding' && (
        <div className="card-flat" style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <div style={{ ...sectionTitle, marginBottom: 0, flex: 1 }}>Change plan</div>
            <div style={cycleToggleWrap}>
              <button onClick={() => setPlanCycle('monthly')} style={cycleBtn(planCycle === 'monthly')}>Monthly</button>
              <button onClick={() => setPlanCycle('annual')}  style={cycleBtn(planCycle === 'annual')}>
                Annual <span style={{ fontSize: 10, opacity: 0.85 }}>save 20%</span>
              </button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            {PLAN_ORDER.map((k) => {
              const def = catalog[k]
              if (!def) return null
              return (
                <ChangePlanCard
                  key={k}
                  tierKey={k}
                  tierDef={def}
                  currentTier={sub.tier}
                  currentCycle={sub.billing_cycle || 'monthly'}
                  cycle={planCycle}
                  busy={planBusy}
                  onPick={submitPlanChange}
                />
              )
            })}
          </div>
          <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            Upgrades charge the prorated difference today. Downgrades take effect at your next billing cycle and credit unused time. Need to cancel? Use the Stripe portal below.
          </div>
        </div>
      )}

      <div className="card-flat" style={{ marginBottom: 18 }}>
        <div style={sectionTitle}>Credit balances</div>
        <CreditsPanel />
      </div>

      <div className="card-flat" style={{ marginBottom: 18 }}>
        <div style={sectionTitle}>Recent activity</div>
        {tx.length === 0 ? (
          <div style={{ padding: '24px 12px', color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
            No transactions yet. Your first month's credits will appear here once your subscription activates.
          </div>
        ) : (
          <table style={txTable}>
            <thead>
              <tr>
                <th style={th}>Date</th>
                <th style={th}>Pool</th>
                <th style={th}>Action</th>
                <th style={{ ...th, textAlign: 'right' }}>Delta</th>
                <th style={{ ...th, textAlign: 'right' }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {tx.map((t) => (
                <tr key={t.id}>
                  <td style={td}>{new Date(t.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                  <td style={td}>{POOL_META[t.pool_type]?.short || t.pool_type}</td>
                  <td style={td}><ActionLabel action={t.action} /></td>
                  <td style={{ ...td, textAlign: 'right', color: t.delta >= 0 ? 'var(--green, #2ecc71)' : 'var(--red)' }}>
                    {t.delta >= 0 ? '+' : ''}{fmtCount(Math.abs(t.delta))}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmtCount(t.balance_after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
