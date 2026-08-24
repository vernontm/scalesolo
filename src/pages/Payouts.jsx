// Editor payouts. Role-aware: owners/admins see the payout dashboard for every
// editor (rate, owed, mark-paid); an editor sees their own rate, this-month
// progress, rollover, earnings, and sets their Solana wallet. Phase A records
// payments manually; the USDT-on-Solana send lands in Phase B.
import { useEffect, useState, useCallback } from 'react'
import { DollarSign, Wallet, Check, Loader2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { toast, confirmDialog } from '../components/Toast.jsx'

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16 }
const stat = { fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 24, color: 'var(--text)' }
const statLabel = { fontSize: 12, color: 'var(--muted)', marginTop: 2 }

// ── admin dashboard ───────────────────────────────────────────────────────
function AdminPayouts({ token }) {
  const [editors, setEditors] = useState([])
  const [loading, setLoading] = useState(true)
  const [drafts, setDrafts] = useState({}) // email -> { amount, quota }
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)

  const load = useCallback(() => {
    fetch('/api/payouts?action=admin', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json()).then((b) => { if (b.error) throw new Error(b.error); setEditors(b.editors || []) })
      .catch((e) => setErr(e.message)).finally(() => setLoading(false))
  }, [token])
  useEffect(() => { setLoading(true); load() }, [load])

  const saveComp = async (em) => {
    const d = drafts[em]; if (!d) return
    setBusy(`comp:${em}`); setErr(null)
    try {
      const r = await fetch('/api/payouts?action=set-comp', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: em, monthly_amount: Number(d.amount), monthly_quota: Number(d.quota) }),
      })
      const b = await r.json(); if (!r.ok) throw new Error(b.error || 'Failed')
      toast({ message: 'Rate saved', kind: 'success' }); setDrafts((p) => { const n = { ...p }; delete n[em]; return n }); load()
    } catch (e) { toast({ message: e.message, kind: 'error' }) } finally { setBusy(null) }
  }

  const pay = async (ed) => {
    const ok = await confirmDialog({ title: `Mark ${ed.name || ed.email} paid?`, message: `Records a ${money(ed.outstanding)} payout for ${ed.unpaid_count} approved video${ed.unpaid_count === 1 ? '' : 's'}. (This does NOT send crypto yet — that's the next phase.)`, confirmText: 'Mark paid' })
    if (!ok) return
    setBusy(`pay:${ed.email}`); setErr(null)
    try {
      const r = await fetch('/api/payouts?action=pay', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: ed.email }),
      })
      const b = await r.json(); if (!r.ok) throw new Error(b.error || 'Failed')
      toast({ message: `Marked ${money(b.amount)} paid (${b.video_count} videos)`, kind: 'success' }); load()
    } catch (e) { toast({ message: e.message, kind: 'error' }) } finally { setBusy(null) }
  }

  if (loading) return <div className="card-flat" style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>

  return (
    <div>
      <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, margin: '0 0 2px' }}>Payouts</h1>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>Set each editor's monthly deal, see what's owed as videos get approved, and mark payments. Automated USDT-on-Solana sending is the next phase.</div>
      {err && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{err}</div>}
      {editors.length === 0 ? <div style={{ ...card, color: 'var(--muted)', textAlign: 'center' }}>No editors yet. Invite one from the board's Settings.</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {editors.map((ed) => {
            const d = drafts[ed.email] || { amount: ed.monthly_amount, quota: ed.monthly_quota }
            return (
              <div key={ed.email} style={card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{ed.name || ed.email}</div>
                    {ed.name && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{ed.email}</div>}
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Wallet size={12} /> {ed.solana_address ? `${ed.solana_address.slice(0, 6)}…${ed.solana_address.slice(-4)}` : <span style={{ color: 'var(--red)' }}>no wallet set</span>}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={stat}>{money(ed.outstanding)}</div>
                    <div style={statLabel}>owed · {ed.unpaid_count} unpaid</div>
                  </div>
                  <button className="btn-primary" onClick={() => pay(ed)} disabled={busy === `pay:${ed.email}` || ed.unpaid_count === 0}>
                    {busy === `pay:${ed.email}` ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Mark paid
                  </button>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                  <div>
                    <label className="label">Monthly $</label>
                    <input className="input" type="number" value={d.amount} onChange={(e) => setDrafts((p) => ({ ...p, [ed.email]: { ...d, amount: e.target.value } }))} style={{ width: 110 }} />
                  </div>
                  <div>
                    <label className="label">Videos / mo</label>
                    <input className="input" type="number" value={d.quota} onChange={(e) => setDrafts((p) => ({ ...p, [ed.email]: { ...d, quota: e.target.value } }))} style={{ width: 100 }} />
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', paddingBottom: 10 }}>
                    = {money(ed.rate)} / video · {ed.this_month} approved this month
                  </div>
                  {drafts[ed.email] && <button className="btn-secondary" onClick={() => saveComp(ed.email)} disabled={busy === `comp:${ed.email}`} style={{ marginBottom: 2 }}>{busy === `comp:${ed.email}` ? <span className="spinner" /> : 'Save rate'}</button>}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── editor view ───────────────────────────────────────────────────────────
function EditorPayouts({ token }) {
  const [summary, setSummary] = useState(null)
  const [payouts, setPayouts] = useState([])
  const [loading, setLoading] = useState(true)
  const [addr, setAddr] = useState('')
  const [savingAddr, setSavingAddr] = useState(false)

  const load = useCallback(() => {
    fetch('/api/payouts', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json()).then((b) => { setSummary(b.summary); setPayouts(b.payouts || []); if (b.summary?.solana_address) setAddr(b.summary.solana_address) })
      .catch(() => {}).finally(() => setLoading(false))
  }, [token])
  useEffect(() => { setLoading(true); load() }, [load])

  const saveAddr = async () => {
    setSavingAddr(true)
    try {
      const r = await fetch('/api/payouts', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ solana_address: addr.trim() }) })
      if (!r.ok) throw new Error('Failed')
      toast({ message: 'Wallet saved', kind: 'success' })
    } catch (e) { toast({ message: e.message, kind: 'error' }) } finally { setSavingAddr(false) }
  }

  if (loading) return <div className="card-flat" style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
  const s = summary || {}
  const target = (s.monthly_quota || 0) + (s.owed_videos || 0)

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, margin: '0 0 2px' }}>Your payouts</h1>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>You earn {money(s.rate)} per approved video ({money(s.monthly_amount)} / month ÷ {s.monthly_quota || 0} videos).</div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 16 }}>
        <div style={card}><div style={stat}>{s.this_month || 0}<span style={{ fontSize: 15, color: 'var(--muted)' }}> / {s.monthly_quota || 0}</span></div><div style={statLabel}>Approved this month</div></div>
        <div style={card}><div style={stat}>{money(s.outstanding)}</div><div style={statLabel}>Owed to you</div></div>
        <div style={card}><div style={stat}>{money(s.earned)}</div><div style={statLabel}>Earned all-time</div></div>
        <div style={card}><div style={{ ...stat, color: s.owed_videos > 0 ? 'var(--red)' : 'var(--text)' }}>{s.owed_videos || 0}</div><div style={statLabel}>Videos behind ({target} due)</div></div>
      </div>

      <div style={{ ...card, marginBottom: 16 }}>
        <label className="label"><Wallet size={12} style={{ verticalAlign: '-1px' }} /> Your Solana (USDT) wallet address</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Paste your Solana wallet address" style={{ flex: 1 }} />
          <button className="btn-primary" onClick={saveAddr} disabled={savingAddr || !addr.trim()}>{savingAddr ? <span className="spinner" /> : 'Save'}</button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>You'll be paid in USDT on Solana. Make sure this is a Solana address.</div>
      </div>

      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, margin: '0 0 8px' }}>Payment history</div>
      {payouts.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No payments yet.</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {payouts.map((p, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }}>
              <strong>{money(p.amount_usdt)}</strong>
              <span style={{ color: 'var(--muted)' }}>{p.video_count} videos</span>
              <span style={{ flex: 1 }} />
              {p.tx_signature && <a href={`https://solscan.io/tx/${p.tx_signature}`} target="_blank" rel="noreferrer" style={{ color: 'var(--red)', fontSize: 11.5 }}>tx</a>}
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{new Date(p.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Payouts() {
  const { session } = useAuth()
  const { profiles } = useProfile()
  const token = session?.access_token
  const isManager = (profiles || []).some((p) => ['owner', 'admin'].includes(p._role))
  if (!token) return null
  return isManager ? <AdminPayouts token={token} /> : <EditorPayouts token={token} />
}
