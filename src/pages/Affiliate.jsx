import { useEffect, useState } from 'react'
import { Sparkles, Copy, Check, Loader2, DollarSign, Users, AlertCircle } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { toast } from '../components/Toast.jsx'

// Affiliate dashboard. Three states:
//   1. Loading
//   2. Not enrolled — show tier table + apply form
//   3. Enrolled — show share link, stats, recent commissions
//
// Tier promotion + payout are both manual actions handled by an admin
// (avoids gaming + lets us do quality control before money moves).

function fmtUsd(cents) {
  return `$${((Number(cents) || 0) / 100).toFixed(2)}`
}

export default function Affiliate() {
  const { session } = useAuth()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)

  const refresh = async () => {
    if (!session?.access_token) return
    setLoading(true); setError(null)
    try {
      const r = await fetch('/api/affiliate', { headers: { Authorization: `Bearer ${session.access_token}` } })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      setData(body)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { refresh() /* eslint-disable-next-line */ }, [session?.access_token])

  if (loading) return <div style={{ padding: 60, textAlign: 'center' }}><Loader2 size={20} className="spin" /></div>
  if (error) return <div style={{ padding: 30 }}><div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: 14, borderRadius: 10 }}>{error}</div></div>
  if (!data) return null

  if (!data.enrolled) return <ApplyView tiers={data.tiers} onDone={refresh} />

  const { affiliate, link, stats, tiers, recent_commissions } = data
  const tierDef = tiers[affiliate.tier]

  return (
    <div style={page}>
      <header style={hero}>
        <div style={heroIcon}><Sparkles size={20} /></div>
        <div style={{ flex: 1 }}>
          <div style={heroTitle}>Affiliate program</div>
          <div style={heroSub}>
            Earn {Math.round((tierDef?.rate || 0) * 100)}% of every paid invoice from your referrals.
            {affiliate.status === 'pending' && ' Your application is awaiting admin approval.'}
            {affiliate.status === 'suspended' && ' Your account is suspended — contact support.'}
          </div>
        </div>
        <span style={{
          fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          padding: '4px 10px', borderRadius: 999,
          background: affiliate.status === 'approved' ? 'rgba(46,204,113,0.16)' : 'rgba(245,158,11,0.16)',
          color: affiliate.status === 'approved' ? '#2ecc71' : '#fbbf24',
        }}>{affiliate.status}</span>
      </header>

      {/* Share link card */}
      <div className="card-flat" style={{ marginBottom: 18, padding: 18 }}>
        <div style={sectionLabel}>Your share link</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            readOnly
            value={link}
            onFocus={(e) => e.target.select()}
            style={{
              flex: '1 1 280px', padding: '10px 12px', fontSize: 13,
              fontFamily: 'monospace', color: 'var(--text)',
              background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8,
            }}
          />
          <button
            onClick={async () => {
              try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); toast?.success?.('Copied') } catch {}
            }}
            style={{
              padding: '10px 14px', borderRadius: 8, border: 'none',
              background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
              color: '#fff', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13,
              display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
            }}
          >
            {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
          Code: <code style={{ background: 'var(--surface-2)', padding: '2px 6px', borderRadius: 4 }}>{affiliate.code}</code>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 18 }}>
        <Stat label="Referrals"          icon={Users} value={stats.referrals} />
        <Stat label="Paying"             icon={Users} value={stats.paying_referrals} />
        <Stat label="Lifetime earned"    icon={DollarSign} value={fmtUsd(stats.lifetime_commission_cents)} accent />
        <Stat label="Pending payout"     icon={DollarSign} value={fmtUsd(stats.pending_commission_cents)} />
        <Stat label="Paid out"           icon={DollarSign} value={fmtUsd(stats.paid_commission_cents)} />
      </div>

      {/* Tier ladder */}
      <div className="card-flat" style={{ marginBottom: 18, padding: 18 }}>
        <div style={sectionLabel}>Tier ladder</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {Object.entries(tiers).map(([key, t]) => {
            const active = key === affiliate.tier
            return (
              <div key={key} style={{
                padding: 14, borderRadius: 10,
                background: active ? 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(185,28,28,0.10))' : 'var(--surface-2)',
                border: active ? '1px solid rgba(239,68,68,0.40)' : '1px solid var(--border)',
              }}>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 14, color: active ? 'var(--red)' : 'var(--text)' }}>
                  {t.label}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                  {t.upgrade_at ? `Promoted by admin after ${t.upgrade_at} paying referrals.` : 'Top tier — invitation only.'}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Payout settings */}
      <PayoutForm affiliate={affiliate} onUpdated={refresh} />

      {/* Recent commissions */}
      <div className="card-flat" style={{ padding: 18 }}>
        <div style={sectionLabel}>Recent commissions</div>
        {!recent_commissions?.length ? (
          <div style={{ padding: 18, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
            No commissions yet. Share your link to start earning.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr>
                <th style={th}>Date</th>
                <th style={th}>Gross</th>
                <th style={th}>Rate</th>
                <th style={th}>Commission</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {recent_commissions.map((c, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={td}>{new Date(c.invoice_paid_at).toLocaleDateString()}</td>
                  <td style={td}>{fmtUsd(c.gross_amount_cents)}</td>
                  <td style={td}>{(Number(c.commission_rate) * 100).toFixed(0)}%</td>
                  <td style={{ ...td, fontWeight: 700, color: 'var(--red)' }}>{fmtUsd(c.commission_cents)}</td>
                  <td style={td}>
                    <span style={{
                      fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
                      background: c.status === 'paid' ? 'rgba(46,204,113,0.16)' : 'rgba(245,158,11,0.16)',
                      color: c.status === 'paid' ? '#2ecc71' : '#fbbf24',
                    }}>{c.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function ApplyView({ tiers, onDone }) {
  const { session } = useAuth()
  const [displayName, setDisplayName] = useState('')
  const [paypalEmail, setPaypalEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/affiliate?action=apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ display_name: displayName, paypal_email: paypalEmail }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Failed')
      onDone()
    } catch (err) {
      setError(err.message); setBusy(false)
    }
  }

  return (
    <div style={page}>
      <header style={hero}>
        <div style={heroIcon}><Sparkles size={20} /></div>
        <div>
          <div style={heroTitle}>Become an affiliate</div>
          <div style={heroSub}>Earn 20–50% recurring on every customer you refer. Paid monthly via PayPal.</div>
        </div>
      </header>

      {/* Tier ladder preview */}
      <div className="card-flat" style={{ marginBottom: 18, padding: 18 }}>
        <div style={sectionLabel}>Tier ladder</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {Object.entries(tiers).map(([key, t]) => (
            <div key={key} style={{ padding: 14, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 14 }}>{t.label}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                {t.upgrade_at ? `${t.upgrade_at}+ paying referrals` : 'Invitation only'}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Apply form */}
      <form onSubmit={submit} className="card-flat" style={{ padding: 18 }}>
        <div style={sectionLabel}>Apply now</div>
        {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
        <label style={lbl}>Display name (optional)</label>
        <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name or brand" style={{ width: '100%', marginBottom: 12 }} />
        <label style={lbl}>PayPal email for payouts</label>
        <input className="input" value={paypalEmail} onChange={(e) => setPaypalEmail(e.target.value)} placeholder="you@paypal.com" style={{ width: '100%', marginBottom: 16 }} />
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} Apply for affiliate program
        </button>
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
          Applications are reviewed manually. You'll get an email when approved.
        </div>
      </form>
    </div>
  )
}

function PayoutForm({ affiliate, onUpdated }) {
  const { session } = useAuth()
  const [paypalEmail, setPaypalEmail] = useState(affiliate.paypal_email || '')
  const [busy, setBusy] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await fetch('/api/affiliate?action=update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ paypal_email: paypalEmail }),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error(b.error || 'Save failed')
      }
      setSavedAt(Date.now())
      onUpdated()
    } catch (err) {
      toast?.error?.(err.message) || alert(err.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={save} className="card-flat" style={{ padding: 18, marginBottom: 18 }}>
      <div style={sectionLabel}>Payout settings</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 240px' }}>
          <label style={lbl}>PayPal email</label>
          <input className="input" value={paypalEmail} onChange={(e) => setPaypalEmail(e.target.value)} placeholder="you@paypal.com" style={{ width: '100%' }} />
        </div>
        <button type="submit" className="btn-secondary" disabled={busy}>
          {busy ? <Loader2 size={13} className="spin" /> : 'Save'}
        </button>
      </div>
      {savedAt && <div style={{ fontSize: 12, color: '#2ecc71', marginTop: 6 }}>Saved.</div>}
    </form>
  )
}

function Stat({ label, value, icon: Icon, accent }) {
  return (
    <div style={{
      padding: 14, borderRadius: 12,
      background: accent ? 'linear-gradient(135deg, rgba(239,68,68,0.14), rgba(249,115,22,0.08))' : 'var(--surface)',
      border: accent ? '1px solid rgba(239,68,68,0.32)' : '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        {Icon && <Icon size={11} style={{ color: 'var(--muted)' }} />}
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>
          {label}
        </div>
      </div>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, color: accent ? 'var(--red)' : 'var(--text)' }}>
        {value || (typeof value === 'number' ? '0' : '—')}
      </div>
    </div>
  )
}

const page = { padding: '32px 28px', maxWidth: 1100, margin: '0 auto' }
const hero = { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }
const heroIcon = {
  width: 38, height: 38, borderRadius: 10,
  background: 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(249,115,22,0.10))',
  border: '1px solid rgba(239,68,68,0.30)',
  color: 'var(--red)', display: 'grid', placeItems: 'center',
}
const heroTitle = { fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, color: 'var(--text)' }
const heroSub = { fontSize: 13, color: 'var(--text-soft)', marginTop: 2 }
const sectionLabel = { fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }
const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-soft)', marginBottom: 4 }
const th = { padding: '8px 10px', textAlign: 'left', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', borderBottom: '1px solid var(--border)' }
const td = { padding: '8px 10px', textAlign: 'left', color: 'var(--text)', whiteSpace: 'nowrap' }
