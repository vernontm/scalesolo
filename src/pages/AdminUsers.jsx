import { useEffect, useState } from 'react'
import { Users, RefreshCw, Loader2, Search, KeyRound, Gift, ShieldCheck, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { toast } from '../components/Toast.jsx'

// Admin user list. Shows email, sign-up date, last sign-in, current tier
// and credit balances. Per-row actions: send password-reset email, grant
// comp credits. Stripe coupon + cancel-subscription are intentionally
// NOT here — those go through Stripe's dashboard so we never modify a
// real subscription via this UI by mistake.

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

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
function fmtNum(n) {
  return new Intl.NumberFormat().format(Math.round(Number(n) || 0))
}

export default function AdminUsers() {
  const [users, setUsers] = useState([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [compFor, setCompFor] = useState(null)

  const refresh = async (search = q) => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (search) params.set('q', search)
      params.set('limit', '100')
      const r = await authedFetch(`/api/admin/users?${params.toString()}`)
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      setUsers(body.users || [])
    } catch (e) {
      setError(e.message); setUsers([])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { refresh('') /* eslint-disable-next-line */ }, [])

  const onSearch = (e) => { e.preventDefault(); refresh(q) }

  const sendReset = async (u) => {
    if (!window.confirm(`Send a password reset email to ${u.email}?`)) return
    try {
      const r = await authedFetch('/api/admin/users?action=reset_password', {
        method: 'POST', body: JSON.stringify({ user_id: u.id }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || 'Failed')
      toast?.success?.(`Reset email sent to ${b.email || u.email}`) || toast?.(`Reset email sent`)
    } catch (e) {
      toast?.error?.(e.message) || alert(e.message)
    }
  }

  return (
    <div style={{ padding: '32px 28px', maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(249,115,22,0.10))',
          border: '1px solid rgba(239,68,68,0.30)',
          color: 'var(--red)', display: 'grid', placeItems: 'center',
        }}>
          <Users size={18} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22 }}>User management</div>
          <div style={{ fontSize: 13, color: 'var(--text-soft)', marginTop: 2 }}>
            Look up accounts, send password resets, comp credit. Stripe subscription + coupon flows live in the Stripe dashboard.
          </div>
        </div>
        <button
          onClick={() => refresh(q)}
          disabled={loading}
          style={{
            padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)',
            background: 'var(--surface-2)', color: 'var(--text-soft)',
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5,
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
        </button>
      </div>

      <form onSubmit={onSearch} style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by email…"
            style={{
              width: '100%', padding: '8px 10px 8px 30px',
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 8, fontSize: 13, color: 'var(--text)', outline: 'none',
            }}
          />
        </div>
        <button
          type="submit"
          style={{
            padding: '8px 14px', borderRadius: 8, border: 'none',
            background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
            color: '#fff', fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 12.5,
            cursor: 'pointer',
          }}
        >Search</button>
      </form>

      {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>{error}</div>}

      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              {['Email', 'Joined', 'Last sign-in', 'Tier', 'Status', 'Profiles', 'AI tokens', 'Video units', 'Actions'].map((h, i) => (
                <th key={i} style={{
                  textAlign: i >= 6 && i <= 7 ? 'right' : 'left', padding: '10px 12px',
                  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  color: 'var(--muted)', borderBottom: '1px solid var(--border)',
                  whiteSpace: 'nowrap',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && !loading ? (
              <tr><td colSpan={9} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>No users found.</td></tr>
            ) : users.map((u) => (
              <tr key={u.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                  {u.is_admin && <ShieldCheck size={11} style={{ color: 'var(--red)', marginRight: 6, verticalAlign: '-1px' }} />}
                  {u.email || <span style={{ color: 'var(--muted)' }}>—</span>}
                </td>
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: 'var(--text-soft)' }}>{fmtDate(u.created_at)}</td>
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: 'var(--text-soft)' }}>{fmtDate(u.last_sign_in_at)}</td>
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{u.tier || <span style={{ color: 'var(--muted)' }}>free</span>}</td>
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                  {u.status ? (
                    <span style={{
                      fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
                      background: u.status === 'active' ? 'rgba(46,204,113,0.16)' : 'rgba(245,158,11,0.16)',
                      color: u.status === 'active' ? '#2ecc71' : '#fbbf24',
                    }}>{u.status}</span>
                  ) : <span style={{ color: 'var(--muted)' }}>—</span>}
                </td>
                <td style={{ padding: '10px 12px' }}>{u.brand_profiles}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right' }}>{fmtNum(u.balances?.ai_tokens)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right' }}>{fmtNum(u.balances?.video_units)}</td>
                <td style={{ padding: '10px 12px' }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => sendReset(u)}
                      title="Send password reset email"
                      style={{
                        padding: '5px 9px', borderRadius: 6, border: '1px solid var(--border)',
                        background: 'var(--surface-2)', color: 'var(--text-soft)',
                        cursor: 'pointer', fontSize: 11.5,
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                      }}
                    ><KeyRound size={11} /> Reset</button>
                    <button
                      onClick={() => setCompFor(u)}
                      title="Comp credits"
                      style={{
                        padding: '5px 9px', borderRadius: 6, border: '1px solid var(--border)',
                        background: 'var(--surface-2)', color: 'var(--text-soft)',
                        cursor: 'pointer', fontSize: 11.5,
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                      }}
                    ><Gift size={11} /> Comp</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {compFor && <CompCreditsModal user={compFor} onClose={() => setCompFor(null)} onDone={() => { setCompFor(null); refresh(q) }} />}
    </div>
  )
}

function CompCreditsModal({ user, onClose, onDone }) {
  const [aiTokens, setAiTokens] = useState('')
  const [videoUnits, setVideoUnits] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const r = await authedFetch('/api/admin/users?action=comp_credits', {
        method: 'POST',
        body: JSON.stringify({
          user_id: user.id,
          ai_tokens: Number(aiTokens) || 0,
          video_units: Number(videoUnits) || 0,
        }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || 'Failed')
      toast?.success?.(`Granted credits to ${user.email}`)
      onDone()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <Gift size={16} style={{ color: 'var(--red)' }} />
          <h3 style={{ flex: 1, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16 }}>Comp credits</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={16} /></button>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 12 }}>
          Grant credits to <strong>{user.email}</strong>. Logged in credit_transactions with action <code>admin_comp</code>.
        </div>
        {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
        <form onSubmit={submit}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-soft)' }}>AI tokens</label>
          <input
            className="input"
            value={aiTokens}
            onChange={(e) => setAiTokens(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="100000"
            style={{ width: '100%', marginTop: 4, marginBottom: 12 }}
          />
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-soft)' }}>Video units</label>
          <input
            className="input"
            value={videoUnits}
            onChange={(e) => setVideoUnits(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="10"
            style={{ width: '100%', marginTop: 4, marginBottom: 16 }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? <Loader2 size={13} className="spin" /> : <Gift size={13} />} Grant credits
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
