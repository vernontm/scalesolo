// Editor payouts. Role-aware: owners/admins see the payout dashboard for every
// editor (rate, owed, release USDT); an editor sees their own rate, this-month
// progress, rollover, earnings, and sets their Solana wallet.
//
// Releasing money is a deliberate, guarded action: clicking Release opens a
// dry-run preview (recipient, amount, wallet balance check); the actual send
// fires only on explicit confirm, and an "Are you sure you want to release
// payment?" step can be toggled on/off. Nothing sends automatically.
import { useEffect, useState, useCallback } from 'react'
import { Wallet, Loader2, Send, ShieldCheck } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { toast, confirmDialog } from '../components/Toast.jsx'
import PayoutSendModal from '../components/PayoutSendModal.jsx'

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16 }
const stat = { fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 24, color: 'var(--text)' }
const statLabel = { fontSize: 12, color: 'var(--muted)', marginTop: 2 }
const authHeaders = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` })

// The USDT send/release modal lives in ../components/PayoutSendModal.jsx now,
// shared with the board's per-card Pay button.

// ── admin dashboard ─────────────────────────────────────────────────────────
function AdminPayouts({ token }) {
  const [editors, setEditors] = useState([])
  const [loading, setLoading] = useState(true)
  const [drafts, setDrafts] = useState({}) // email -> { amount, quota, wallet }
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)
  const [modal, setModal] = useState(null) // { kind, params }
  const [testOpen, setTestOpen] = useState(false)
  const [testTo, setTestTo] = useState('')
  const [testAmt, setTestAmt] = useState('1')
  const [requireConfirm, setRequireConfirm] = useState(() => { try { return localStorage.getItem('scalesolo.payoutConfirm') !== 'off' } catch { return true } })

  const toggleConfirm = () => setRequireConfirm((v) => { const nv = !v; try { localStorage.setItem('scalesolo.payoutConfirm', nv ? 'on' : 'off') } catch { /* ignore */ } return nv })

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
        method: 'POST', headers: authHeaders(token),
        body: JSON.stringify({ email: em, monthly_amount: Number(d.amount), monthly_quota: Number(d.quota), solana_address: (d.wallet || '').trim() }),
      })
      const b = await r.json(); if (!r.ok) throw new Error(b.error || 'Failed')
      toast({ message: 'Saved', kind: 'success' }); setDrafts((p) => { const n = { ...p }; delete n[em]; return n }); load()
    } catch (e) { toast({ message: e.message, kind: 'error' }) } finally { setBusy(null) }
  }

  const markPaidManually = async (ed) => {
    const ok = await confirmDialog({ title: `Record ${ed.name || ed.email} paid off-platform?`, message: `Marks ${money(ed.outstanding)} for ${ed.unpaid_count} video${ed.unpaid_count === 1 ? '' : 's'} as paid WITHOUT sending crypto. Use this only if you paid them another way.`, confirmText: 'Record as paid' })
    if (!ok) return
    setBusy(`pay:${ed.email}`)
    try {
      const r = await fetch('/api/payouts?action=pay', { method: 'POST', headers: authHeaders(token), body: JSON.stringify({ email: ed.email, manual: true }) })
      const b = await r.json(); if (!r.ok) throw new Error(b.error || 'Failed')
      toast({ message: `Recorded ${money(b.amount)} paid`, kind: 'success' }); load()
    } catch (e) { toast({ message: e.message, kind: 'error' }) } finally { setBusy(null) }
  }

  if (loading) return <div className="card-flat" style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, margin: '0 0 2px' }}>Payouts</h1>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>Set each editor's deal, see what's owed as videos get approved, and release USDT on Solana.</div>
        </div>
        <button className="btn-secondary" onClick={() => setTestOpen((v) => !v)}>Test rail</button>
      </div>

      {/* safety toggle */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, padding: '10px 14px' }}>
        <ShieldCheck size={16} style={{ color: requireConfirm ? 'var(--green, #16a34a)' : 'var(--muted)' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Confirm before releasing payment</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Adds an "Are you sure?" step to every release. Turn off to send faster when going down the list.</div>
        </div>
        <button onClick={toggleConfirm} className={requireConfirm ? 'btn-primary' : 'btn-secondary'} style={{ minWidth: 64 }}>{requireConfirm ? 'On' : 'Off'}</button>
      </div>

      {testOpen && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Test the payout rail</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <label className="label">Recipient Solana address</label>
              <input className="input" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="Solana wallet address" style={{ width: '100%' }} />
            </div>
            <div>
              <label className="label">USDT</label>
              <input className="input" type="number" value={testAmt} onChange={(e) => setTestAmt(e.target.value)} style={{ width: 90 }} />
            </div>
            <button className="btn-primary" disabled={!testTo.trim() || !(Number(testAmt) > 0)} onClick={() => setModal({ kind: 'test', params: { to: testTo.trim(), amount: Number(testAmt) } })}>Preview send</button>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>Sends from your payout wallet. Use this once to confirm funds + network before real payouts.</div>
        </div>
      )}

      {err && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{err}</div>}

      {editors.length === 0 ? <div style={{ ...card, color: 'var(--muted)', textAlign: 'center' }}>No editors yet. Invite one from the board's Settings.</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {editors.map((ed) => {
            const d = drafts[ed.email] || { amount: ed.monthly_amount, quota: ed.monthly_quota, wallet: ed.solana_address || '' }
            const noWallet = !ed.solana_address
            return (
              <div key={ed.email} style={card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{ed.name || ed.email}</div>
                    {ed.name && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{ed.email}</div>}
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Wallet size={12} /> {ed.solana_address ? short(ed.solana_address) : <span style={{ color: 'var(--red)' }}>no wallet set</span>}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={stat}>{money(ed.outstanding)}</div>
                    <div style={statLabel}>owed · {ed.unpaid_count} unpaid</div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <button className="btn-primary" title={noWallet ? 'Set a wallet first' : ''} onClick={() => setModal({ kind: 'pay', params: { email: ed.email } })} disabled={ed.unpaid_count === 0 || noWallet}>
                      <Send size={14} /> Release
                    </button>
                    <button className="btn-secondary" onClick={() => markPaidManually(ed)} disabled={busy === `pay:${ed.email}` || ed.unpaid_count === 0} style={{ fontSize: 11.5, padding: '4px 8px' }}>
                      {busy === `pay:${ed.email}` ? <Loader2 size={12} className="spin" /> : 'Mark paid manually'}
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                  <div>
                    <label className="label">Monthly $</label>
                    <input className="input" type="number" value={d.amount} onChange={(e) => setDrafts((p) => ({ ...p, [ed.email]: { ...d, amount: e.target.value } }))} style={{ width: 100 }} />
                  </div>
                  <div>
                    <label className="label">Videos / mo</label>
                    <input className="input" type="number" value={d.quota} onChange={(e) => setDrafts((p) => ({ ...p, [ed.email]: { ...d, quota: e.target.value } }))} style={{ width: 90 }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <label className="label">Wallet address</label>
                    <input className="input" value={d.wallet} onChange={(e) => setDrafts((p) => ({ ...p, [ed.email]: { ...d, wallet: e.target.value } }))} placeholder="Solana address" style={{ width: '100%' }} />
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', paddingBottom: 10, whiteSpace: 'nowrap' }}>
                    = {money(ed.rate)} / video
                  </div>
                  {drafts[ed.email] && <button className="btn-secondary" onClick={() => saveComp(ed.email)} disabled={busy === `comp:${ed.email}`} style={{ marginBottom: 2 }}>{busy === `comp:${ed.email}` ? <span className="spinner" /> : 'Save'}</button>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {modal && <PayoutSendModal token={token} kind={modal.kind} params={modal.params} requireConfirm={requireConfirm} onClose={() => setModal(null)} onDone={load} />}
    </div>
  )
}

// ── editor view ─────────────────────────────────────────────────────────────
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
      const r = await fetch('/api/payouts', { method: 'PATCH', headers: authHeaders(token), body: JSON.stringify({ solana_address: addr.trim() }) })
      const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || 'Failed')
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
