import { useEffect, useState } from 'react'
import { Sparkles, RefreshCw, Loader2, CheckCircle2, XCircle, Pause, ArrowUp, DollarSign, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { toast } from '../components/Toast.jsx'

// Admin-only affiliate management. Approve / suspend, promote tier,
// roll pending commissions into a paid payout. PayPal sends are
// done manually outside the app — this UI just records that a payout
// happened so future months don't double-pay.

const TIERS = ['starter', 'pro', 'elite']
const STATUSES = ['pending', 'approved', 'suspended']

async function authedFetch(path, init = {}) {
  const session = (await supabase.auth.getSession()).data.session
  return fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session?.access_token || ''}`,
      ...(init.headers || {}),
    },
  })
}

function fmtUsd(cents) {
  return `$${((Number(cents) || 0) / 100).toFixed(2)}`
}
function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function AdminAffiliates() {
  const [affs, setAffs] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [payoutFor, setPayoutFor] = useState(null)

  const refresh = async () => {
    setLoading(true); setError(null)
    try {
      const r = await authedFetch('/api/admin/affiliates')
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      setAffs(body.affiliates || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { refresh() }, [])

  const setStatus = async (a, status) => {
    try {
      const r = await authedFetch(`/api/admin/affiliates?action=set_status&id=${a.id}`, {
        method: 'POST', body: JSON.stringify({ status }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || 'Failed')
      toast?.success?.(`Status → ${status}`)
      refresh()
    } catch (e) { toast?.error?.(e.message) || alert(e.message) }
  }

  const setTier = async (a, tier) => {
    try {
      const r = await authedFetch(`/api/admin/affiliates?action=set_tier&id=${a.id}`, {
        method: 'POST', body: JSON.stringify({ tier }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || 'Failed')
      toast?.success?.(`Tier → ${tier}`)
      refresh()
    } catch (e) { toast?.error?.(e.message) || alert(e.message) }
  }

  return (
    <div style={{ padding: '32px 28px', maxWidth: 1240, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(249,115,22,0.10))',
          border: '1px solid rgba(239,68,68,0.30)', color: 'var(--red)',
          display: 'grid', placeItems: 'center',
        }}><Sparkles size={18} /></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22 }}>Affiliates</div>
          <div style={{ fontSize: 13, color: 'var(--text-soft)', marginTop: 2 }}>
            Approve applications, promote tier, and record payouts. PayPal transfers are sent manually.
          </div>
        </div>
        <button onClick={refresh} disabled={loading} style={{
          padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)',
          background: 'var(--surface-2)', color: 'var(--text-soft)',
          display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5,
          cursor: loading ? 'wait' : 'pointer',
        }}>
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
        </button>
      </div>

      {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>{error}</div>}

      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              {['Code', 'Name', 'PayPal', 'Status', 'Tier', 'Refs', 'Paying', 'Lifetime', 'Pending', 'Joined', 'Actions'].map((h, i) => (
                <th key={i} style={{
                  textAlign: 'left', padding: '10px 12px',
                  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  color: 'var(--muted)', borderBottom: '1px solid var(--border)',
                  whiteSpace: 'nowrap', background: 'var(--surface)',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {affs.length === 0 && !loading ? (
              <tr><td colSpan={11} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>No affiliates yet.</td></tr>
            ) : affs.map((a) => (
              <tr key={a.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={td}><code>{a.code}</code></td>
                <td style={td}>{a.display_name || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                <td style={td}>{a.paypal_email || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                <td style={td}>
                  <span style={{
                    fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
                    background: a.status === 'approved' ? 'rgba(46,204,113,0.16)' : a.status === 'suspended' ? 'rgba(239,68,68,0.16)' : 'rgba(245,158,11,0.16)',
                    color: a.status === 'approved' ? '#2ecc71' : a.status === 'suspended' ? 'var(--red)' : '#fbbf24',
                  }}>{a.status}</span>
                </td>
                <td style={td}>
                  <select
                    value={a.tier}
                    onChange={(e) => setTier(a, e.target.value)}
                    style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)', padding: '4px 8px', borderRadius: 6, fontSize: 12 }}
                  >
                    {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </td>
                <td style={td}>{a.stats.referrals}</td>
                <td style={td}>{a.stats.paying_referrals}</td>
                <td style={td}>{fmtUsd(a.stats.lifetime_commission_cents)}</td>
                <td style={{ ...td, fontWeight: 700, color: a.stats.pending_commission_cents > 0 ? 'var(--red)' : 'var(--text)' }}>
                  {fmtUsd(a.stats.pending_commission_cents)}
                </td>
                <td style={{ ...td, color: 'var(--text-soft)' }}>{fmtDate(a.created_at)}</td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {a.status !== 'approved' && (
                      <button onClick={() => setStatus(a, 'approved')} title="Approve" style={btnSmall}>
                        <CheckCircle2 size={11} />
                      </button>
                    )}
                    {a.status === 'approved' && (
                      <button onClick={() => setStatus(a, 'suspended')} title="Suspend" style={btnSmall}>
                        <Pause size={11} />
                      </button>
                    )}
                    {a.status === 'suspended' && (
                      <button onClick={() => setStatus(a, 'approved')} title="Reinstate" style={btnSmall}>
                        <CheckCircle2 size={11} />
                      </button>
                    )}
                    {a.stats.pending_commission_cents > 0 && (
                      <button onClick={() => setPayoutFor(a)} title="Mark paid" style={{ ...btnSmall, color: 'var(--red)', borderColor: 'rgba(239,68,68,0.4)' }}>
                        <DollarSign size={11} /> Pay
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {payoutFor && (
        <PayoutModal affiliate={payoutFor} onClose={() => setPayoutFor(null)} onDone={() => { setPayoutFor(null); refresh() }} />
      )}
    </div>
  )
}

function PayoutModal({ affiliate, onClose, onDone }) {
  const [externalRef, setExternalRef] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const submit = async (e) => {
    e.preventDefault()
    if (!window.confirm(`Mark ${(affiliate.stats.pending_commission_cents / 100).toFixed(2)} USD paid for ${affiliate.code}? This cannot be undone.`)) return
    setBusy(true); setError(null)
    try {
      const r = await authedFetch(`/api/admin/affiliates?action=mark_paid&id=${affiliate.id}`, {
        method: 'POST',
        body: JSON.stringify({ all_pending: true, external_ref: externalRef || null, notes: notes || null }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || 'Failed')
      toast?.success?.(`Recorded payout of $${(b.total_cents / 100).toFixed(2)}`)
      onDone()
    } catch (err) {
      setError(err.message); setBusy(false)
    }
  }
  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <DollarSign size={16} style={{ color: 'var(--red)' }} />
          <h3 style={{ flex: 1, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16 }}>Record payout</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={16} /></button>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 12 }}>
          Marks all pending commissions for <strong>{affiliate.code}</strong> as paid: <strong>${(affiliate.stats.pending_commission_cents / 100).toFixed(2)}</strong> to <code>{affiliate.paypal_email || '— no PayPal on file —'}</code>.
        </div>
        {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
        <form onSubmit={submit}>
          <label style={lbl}>PayPal transaction ID (optional)</label>
          <input className="input" value={externalRef} onChange={(e) => setExternalRef(e.target.value)} placeholder="e.g. 5XR12345AB678901" style={{ width: '100%', marginBottom: 12 }} />
          <label style={lbl}>Notes (optional)</label>
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything you want to remember about this payout" style={{ width: '100%', marginBottom: 16 }} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? <Loader2 size={13} className="spin" /> : <DollarSign size={13} />} Record payout
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

const td = { padding: '10px 12px', textAlign: 'left', color: 'var(--text)', whiteSpace: 'nowrap' }
const btnSmall = {
  padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--surface-2)', color: 'var(--text-soft)', cursor: 'pointer', fontSize: 11.5,
  display: 'inline-flex', alignItems: 'center', gap: 4,
}
const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-soft)', marginBottom: 4 }
