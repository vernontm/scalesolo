import { useEffect, useMemo, useState } from 'react'
import { Activity, RefreshCw, ArrowUp, ArrowDown, DollarSign, Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'

// Admin-only credit usage breakdown. Three time windows (24h / 7d / 30d),
// two sortable tables (by action and by user), plus headline totals so
// admins can spot which actions are eating which pools and which users
// are driving the bulk of cost.

const WINDOWS = [
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d',  label: 'Last 7 days'   },
  { id: '30d', label: 'Last 30 days'  },
]

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

function fmtUsd(n) {
  return `$${(Number(n) || 0).toFixed(2)}`
}
function fmtNum(n) {
  return new Intl.NumberFormat().format(Math.round(Number(n) || 0))
}

function SortableTable({ rows, columns, defaultSort }) {
  const [sortKey, setSortKey] = useState(defaultSort?.key || columns[0]?.key)
  const [sortDir, setSortDir] = useState(defaultSort?.dir || 'desc')
  const sorted = useMemo(() => {
    const arr = [...(rows || [])]
    arr.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av
      const as = String(av ?? ''), bs = String(bv ?? '')
      return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as)
    })
    return arr
  }, [rows, sortKey, sortDir])
  const onHeaderClick = (k) => {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir('desc') }
  }
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                onClick={() => onHeaderClick(c.key)}
                style={{
                  textAlign: c.align || 'left', padding: '10px 12px',
                  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  color: 'var(--muted)', borderBottom: '1px solid var(--border)',
                  cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
                  background: 'var(--surface)',
                  position: 'sticky', top: 0,
                }}
              >
                {c.label}
                {sortKey === c.key && (
                  sortDir === 'asc' ? <ArrowUp size={10} style={{ marginLeft: 4 }} /> : <ArrowDown size={10} style={{ marginLeft: 4 }} />
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr><td colSpan={columns.length} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No data in this window.</td></tr>
          ) : sorted.map((r, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
              {columns.map((c) => (
                <td key={c.key} style={{ padding: '10px 12px', textAlign: c.align || 'left', color: 'var(--text)', whiteSpace: 'nowrap' }}>
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function AdminUsage() {
  const [windowId, setWindowId] = useState('7d')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const refresh = async () => {
    setLoading(true); setError(null)
    try {
      const r = await authedFetch(`/api/admin/usage?window=${windowId}`)
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      setData(body)
    } catch (e) {
      setError(e.message); setData(null)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { refresh() /* eslint-disable-next-line */ }, [windowId])

  const totals = data?.totals || {}

  return (
    <div style={{ padding: '32px 28px', maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(249,115,22,0.10))',
          border: '1px solid rgba(239,68,68,0.30)',
          color: 'var(--red)', display: 'grid', placeItems: 'center',
        }}>
          <Activity size={18} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22 }}>Usage & cost</div>
          <div style={{ fontSize: 13, color: 'var(--text-soft)', marginTop: 2 }}>
            Credit consumption across the workspace. Cost is an estimate based on top-up unit pricing.
          </div>
        </div>
        <button
          onClick={refresh}
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

      {/* Window picker */}
      <div style={{ display: 'inline-flex', gap: 6, background: 'var(--surface-2)', borderRadius: 10, padding: 4, marginBottom: 18 }}>
        {WINDOWS.map((w) => (
          <button
            key={w.id}
            onClick={() => setWindowId(w.id)}
            style={{
              padding: '6px 14px', borderRadius: 8, fontSize: 12.5,
              fontFamily: 'var(--font-display)', fontWeight: 600,
              background: windowId === w.id ? 'linear-gradient(135deg, var(--red), var(--red-dark))' : 'transparent',
              color: windowId === w.id ? '#fff' : 'var(--text-soft)',
              border: windowId === w.id ? 'none' : '1px solid transparent',
              cursor: 'pointer',
            }}
          >{w.label}</button>
        ))}
      </div>

      {error && (
        <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>{error}</div>
      )}

      {/* Headline totals */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 22 }}>
        <Stat label="Estimated cost"   value={fmtUsd(totals.est_usd)}     accent />
        <Stat label="AI tokens"        value={fmtNum(totals.ai_tokens)} />
        <Stat label="Video units"      value={fmtNum(totals.video_units)} />
        <Stat label="Voice minutes"    value={fmtNum(totals.voice_minutes)} />
        <Stat label="Events"           value={fmtNum(totals.events)} />
      </div>

      {/* By action */}
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
          By action
        </div>
        <SortableTable
          rows={data?.by_action || []}
          defaultSort={{ key: 'est_usd', dir: 'desc' }}
          columns={[
            { key: 'action',     label: 'Action' },
            { key: 'pool_type',  label: 'Pool' },
            { key: 'count',      label: 'Calls',     align: 'right', render: (r) => fmtNum(r.count) },
            { key: 'units',      label: 'Units',     align: 'right', render: (r) => fmtNum(r.units) },
            { key: 'est_usd',    label: 'Est. cost', align: 'right', render: (r) => fmtUsd(r.est_usd) },
          ]}
        />
      </div>

      {/* By user */}
      <div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
          Top users
        </div>
        <SortableTable
          rows={data?.by_user || []}
          defaultSort={{ key: 'total_usd', dir: 'desc' }}
          columns={[
            { key: 'email',         label: 'Email',        render: (r) => r.email || <span style={{ color: 'var(--muted)' }}>{(r.customer_id || '').slice(0, 8)}…</span> },
            { key: 'ai_tokens',     label: 'AI tokens',    align: 'right', render: (r) => fmtNum(r.ai_tokens) },
            { key: 'video_units',   label: 'Video units',  align: 'right', render: (r) => fmtNum(r.video_units) },
            { key: 'voice_minutes', label: 'Voice min',    align: 'right', render: (r) => fmtNum(r.voice_minutes) },
            { key: 'total_usd',     label: 'Est. cost',    align: 'right', render: (r) => fmtUsd(r.total_usd) },
          ]}
        />
      </div>
    </div>
  )
}

function Stat({ label, value, accent }) {
  return (
    <div style={{
      padding: 14, borderRadius: 12,
      background: accent ? 'linear-gradient(135deg, rgba(239,68,68,0.14), rgba(249,115,22,0.08))' : 'var(--surface)',
      border: accent ? '1px solid rgba(239,68,68,0.32)' : '1px solid var(--border)',
    }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, color: accent ? 'var(--red)' : 'var(--text)' }}>
        {value || '—'}
      </div>
    </div>
  )
}
