// Shared USDT payout modal: dry-run preview -> explicit confirm -> send.
// Used by the Payouts page (pay a whole editor / test-send) and the board
// (pay a single card). Backed by /api/payouts?action=pay|test-send, which is
// dry-run by default and only sends on `confirm: true`.
//
// Props:
//   token          Supabase access token
//   kind           'pay' | 'test'
//   params         request body: { email } or { card_id } for pay, { to, amount } for test
//   requireConfirm add an "Are you sure?" step before sending
//   onClose        close the modal
//   onDone         called after a successful send / void (refresh caller)
import { useEffect, useState } from 'react'
import { Check, Loader2, Send, X, ExternalLink, AlertTriangle } from 'lucide-react'
import { toast, confirmDialog } from './Toast.jsx'

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')
const authHeaders = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` })
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16 }

const Row = ({ label, children }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span style={{ color: 'var(--muted)' }}>{label}</span><span>{children}</span></div>
)

export default function PayoutSendModal({ token, kind, params, requireConfirm, onClose, onDone }) {
  const endpoint = kind === 'pay' ? '/api/payouts?action=pay' : '/api/payouts?action=test-send'
  const [dry, setDry] = useState(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null) // { tx_signature, explorer } | { held, payout_id }

  useEffect(() => {
    let alive = true
    setLoading(true); setError(null)
    fetch(endpoint, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(params) })
      .then((r) => r.json().then((b) => ({ ok: r.ok, b })))
      .then(({ ok, b }) => { if (!alive) return; if (!ok && !b.preflight) throw new Error(b.error || 'Failed'); setDry(b) })
      .catch((e) => { if (alive) setError(e.message) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [endpoint, token])

  const pf = dry?.preflight || {}
  const amount = dry?.amount ?? params.amount ?? 0
  const wallet = dry?.wallet || params.to || ''
  const canSend = !!dry && pf.ok !== false && !result

  const doSend = async () => {
    if (requireConfirm) {
      const ok = await confirmDialog({ title: 'Release payment?', message: `Send ${money(amount)} USDT to ${short(wallet)} on Solana now. This is irreversible.`, confirmText: 'Yes, release' })
      if (!ok) return
    }
    setSending(true); setError(null)
    try {
      const r = await fetch(endpoint, { method: 'POST', headers: authHeaders(token), body: JSON.stringify({ ...params, confirm: true }) })
      const b = await r.json()
      if (!r.ok) { if (b.held) setResult({ held: true, payout_id: b.payout_id }); throw new Error(b.error || 'Failed') }
      setResult({ tx_signature: b.tx_signature, explorer: b.explorer, amount: b.amount })
      toast({ message: `Sent ${money(b.amount)} USDT`, kind: 'success' })
      onDone && onDone()
    } catch (e) { setError(e.message) } finally { setSending(false) }
  }

  const voidPayout = async () => {
    if (!result?.payout_id) return
    const ok = await confirmDialog({ title: 'Void this payout?', message: 'Only do this after checking Solscan and confirming NOTHING was sent. It releases the held videos so they can be paid again.', confirmText: 'Nothing sent, void it' })
    if (!ok) return
    try {
      const r = await fetch('/api/payouts?action=void-payout', { method: 'POST', headers: authHeaders(token), body: JSON.stringify({ payout_id: result.payout_id }) })
      const b = await r.json(); if (!r.ok) throw new Error(b.error || 'Failed')
      toast({ message: 'Payout voided, videos released', kind: 'success' }); onDone && onDone(); onClose()
    } catch (e) { toast({ message: e.message, kind: 'error' }) }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: 420, maxWidth: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <Send size={16} /><div style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>{kind === 'test' ? 'Test send' : 'Release payment'}</div>
          <button aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6 }}><X size={16} /></button>
        </div>

        {loading && <div style={{ padding: 24, textAlign: 'center' }}><span className="spinner" /></div>}

        {!loading && dry && !result && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
              <Row label="Amount"><strong>{money(amount)}</strong> USDT</Row>
              {kind === 'pay' && <Row label="Videos">{dry.video_count} unpaid</Row>}
              <Row label="To">{short(wallet)}</Row>
              <Row label="Wallet USDT">{money(pf.usdt_balance)}</Row>
              <Row label="Wallet SOL">{(Number(pf.sol_balance) || 0).toFixed(4)}</Row>
              {pf.recipient_has_usdt_account === false && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Recipient has no USDT account yet, the wallet pays ~0.002 SOL to create it.</div>}
            </div>
            {Array.isArray(pf.issues) && pf.issues.length > 0 && (
              <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 10px', borderRadius: 8, fontSize: 12, marginTop: 10 }}>
                {pf.issues.map((it, i) => <div key={i}>• {it}</div>)}
              </div>
            )}
            {error && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 10 }}>{error}</div>}
            <button className="btn-primary" onClick={doSend} disabled={!canSend || sending} style={{ width: '100%', marginTop: 14, justifyContent: 'center' }}>
              {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />} {requireConfirm ? 'Release…' : `Release ${money(amount)}`}
            </button>
            {!requireConfirm && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, textAlign: 'center' }}>Confirmation prompt is off, this sends immediately.</div>}
          </>
        )}

        {result?.tx_signature && (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <div style={{ width: 40, height: 40, borderRadius: 20, background: 'var(--green-soft, #dcfce7)', display: 'grid', placeItems: 'center', margin: '0 auto 10px' }}><Check size={20} style={{ color: 'var(--green, #16a34a)' }} /></div>
            <div style={{ fontWeight: 700 }}>Sent {money(result.amount)} USDT</div>
            <a href={result.explorer} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--red)', fontSize: 12.5, marginTop: 6 }}>View on Solscan <ExternalLink size={12} /></a>
            <button className="btn-secondary" onClick={onClose} style={{ width: '100%', marginTop: 14, justifyContent: 'center' }}>Done</button>
          </div>
        )}

        {result?.held && (
          <div style={{ marginTop: 4 }}>
            <div style={{ display: 'flex', gap: 8, background: 'var(--amber-soft, #fef3c7)', color: 'var(--amber, #b45309)', padding: '10px 12px', borderRadius: 8, fontSize: 12.5 }}>
              <AlertTriangle size={16} style={{ flexShrink: 0 }} />
              <div>The send failed after broadcasting, so the transaction MIGHT have landed. Check Solscan for the wallet before doing anything. The videos are held so you can't accidentally double-pay.</div>
            </div>
            {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>}
            <button className="btn-secondary" onClick={voidPayout} style={{ width: '100%', marginTop: 12, justifyContent: 'center' }}>Nothing sent, release the videos</button>
            <button className="btn-primary" onClick={onClose} style={{ width: '100%', marginTop: 8, justifyContent: 'center' }}>Keep held, close</button>
          </div>
        )}
      </div>
    </div>
  )
}
