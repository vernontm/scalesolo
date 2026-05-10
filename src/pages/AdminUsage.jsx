import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Activity, RefreshCw, ArrowUp, ArrowDown, DollarSign, Loader2, X, Video, Wrench, ExternalLink } from 'lucide-react'
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

function SortableTable({ rows, columns, defaultSort, onRowClick }) {
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
            <tr
              key={i}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              style={{
                borderBottom: '1px solid var(--border)',
                cursor: onRowClick ? 'pointer' : 'default',
                transition: 'background 0.12s',
              }}
              onMouseEnter={onRowClick ? (e) => { e.currentTarget.style.background = 'var(--surface-2)' } : undefined}
              onMouseLeave={onRowClick ? (e) => { e.currentTarget.style.background = 'transparent' } : undefined}
            >
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
  const [detailUser, setDetailUser] = useState(null) // row from by_user, opens the modal

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

      {/* By user — click a row to drill into per-video render + post-processing cost. */}
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Top users
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            Click a row to see per-video render + stitching cost.
          </div>
        </div>
        <SortableTable
          rows={data?.by_user || []}
          defaultSort={{ key: 'total_usd', dir: 'desc' }}
          onRowClick={(r) => setDetailUser(r)}
          columns={[
            { key: 'email',         label: 'Email',        render: (r) => r.email || <span style={{ color: 'var(--muted)' }}>{(r.customer_id || '').slice(0, 8)}…</span> },
            { key: 'ai_tokens',     label: 'AI tokens',    align: 'right', render: (r) => fmtNum(r.ai_tokens) },
            { key: 'video_units',   label: 'Video units',  align: 'right', render: (r) => fmtNum(r.video_units) },
            { key: 'voice_minutes', label: 'Voice min',    align: 'right', render: (r) => fmtNum(r.voice_minutes) },
            { key: 'total_usd',     label: 'Est. cost',    align: 'right', render: (r) => fmtUsd(r.total_usd) },
          ]}
        />
      </div>

      {detailUser && (
        <UserVideoDetail
          user={detailUser}
          windowId={windowId}
          onClose={() => setDetailUser(null)}
        />
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Per-user video pipeline modal. Lists every avatar render + its cost,
// the post-processing events that ran around them, and the total.
// ────────────────────────────────────────────────────────────────────────────
function UserVideoDetail({ user, windowId, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    authedFetch(`/api/admin/usage/user-detail?customer_id=${user.customer_id}&window=${windowId}`)
      .then(async (r) => {
        const body = await r.json()
        if (cancelled) return
        if (!r.ok) throw new Error(body?.error || `Failed (${r.status})`)
        setData(body)
      })
      .catch((e) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [user.customer_id, windowId])

  // Esc closes.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const totals = data?.totals || {}

  return createPortal((
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card modal-card-xl"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(960px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 32px)', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10,
            background: 'linear-gradient(135deg, rgba(168,85,247,0.18), rgba(59,130,246,0.10))',
            border: '1px solid rgba(168,85,247,0.30)',
            color: '#a855f7', display: 'grid', placeItems: 'center',
          }}>
            <Video size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.email || `${(user.customer_id || '').slice(0, 8)}…`}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              Avatar video pipeline cost · window: {windowId}
            </div>
          </div>
          <button aria-label="Close" onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 8, borderRadius: 8 }}>
            <X size={18} />
          </button>
        </div>

        {error && (
          <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>{error}</div>
        )}

        {loading ? (
          <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)' }}>
            <Loader2 size={20} className="spin" />
          </div>
        ) : (
          <>
            {/* Headline numbers */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 18 }}>
              <Stat label="Videos rendered"  value={fmtNum(totals.videos_count)} />
              <Stat label="Render cost"      value={fmtUsd(totals.render_cost_usd)} />
              <Stat label="Post-processing"  value={fmtUsd(totals.post_processing_cost_usd)} />
              <Stat label="TOTAL"            value={fmtUsd(totals.total_usd)} accent />
            </div>

            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
              {/* Per-video table */}
              <div style={{ marginBottom: 18 }}>
                <div style={sectionHeader}>
                  <Video size={12} /> Avatar renders
                  <span style={countPill}>{(data?.videos || []).length}</span>
                </div>
                {(data?.videos || []).length === 0 ? (
                  <EmptyHint>No avatar renders in this window.</EmptyHint>
                ) : (
                  <SortableTable
                    rows={data.videos}
                    defaultSort={{ key: 'created_at', dir: 'desc' }}
                    columns={[
                      { key: 'created_at',     label: 'Date', render: (r) => fmtDate(r.created_at) },
                      { key: 'avatar_name',    label: 'Avatar', render: (r) => r.avatar_name || <span style={{ color: 'var(--muted)' }}>—</span> },
                      { key: 'model_version',  label: 'Model', render: (r) => r.model_version || <span style={{ color: 'var(--muted)' }}>—</span> },
                      { key: 'duration_secs',  label: 'Duration', align: 'right', render: (r) => r.duration_secs ? `${r.duration_secs}s` : '—' },
                      { key: 'status',         label: 'Status', render: (r) => <StatusPill status={r.status} /> },
                      { key: 'video_url',      label: 'Video', render: (r) => r.video_url
                          ? <a href={r.video_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--red)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12 }} onClick={(e) => e.stopPropagation()}>open <ExternalLink size={11} /></a>
                          : <span style={{ color: 'var(--muted)' }}>—</span>
                      },
                      { key: 'render_cost_usd', label: 'Cost', align: 'right', render: (r) => <strong>{fmtUsd(r.render_cost_usd)}</strong> },
                    ]}
                  />
                )}
              </div>

              {/* Post-processing table */}
              <div>
                <div style={sectionHeader}>
                  <Wrench size={12} /> Post-processing (combine, polish, captions, auto-title)
                  <span style={countPill}>{(data?.post_processing || []).length}</span>
                </div>
                {(data?.post_processing || []).length === 0 ? (
                  <EmptyHint>No stitching, polish, or caption events in this window.</EmptyHint>
                ) : (
                  <SortableTable
                    rows={data.post_processing}
                    defaultSort={{ key: 'created_at', dir: 'desc' }}
                    columns={[
                      { key: 'created_at',  label: 'Date',   render: (r) => fmtDate(r.created_at) },
                      { key: 'action',      label: 'Action', render: (r) => <code style={{ fontSize: 11.5, color: 'var(--text-soft)' }}>{r.action.replace(/^consume:/, '')}</code> },
                      { key: 'inputs',      label: 'Inputs', render: (r) => <PostProcessingInputs row={r} /> },
                      { key: 'units',       label: 'Tokens', align: 'right', render: (r) => fmtNum(r.units) },
                      { key: 'est_usd',     label: 'Cost',   align: 'right', render: (r) => fmtUsd(r.est_usd) },
                    ]}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  ), document.body)
}

function StatusPill({ status }) {
  const map = {
    completed: { bg: 'rgba(46,204,113,0.16)', fg: '#2ecc71', label: 'completed' },
    processing: { bg: 'rgba(96,165,250,0.16)', fg: '#60a5fa', label: 'processing' },
    queued:    { bg: 'rgba(245,158,11,0.16)', fg: '#f59e0b', label: 'queued' },
    failed:    { bg: 'rgba(239,68,68,0.16)',  fg: 'var(--red)', label: 'failed' },
  }
  const m = map[status] || { bg: 'var(--surface-2)', fg: 'var(--muted)', label: status || '—' }
  return (
    <span style={{
      display: 'inline-flex', padding: '2px 8px', borderRadius: 999,
      background: m.bg, color: m.fg, fontSize: 10.5, fontWeight: 700,
      fontFamily: 'var(--font-display)', letterSpacing: '0.04em',
    }}>{m.label}</span>
  )
}

// Pretty-print whatever inputs we recorded on a post-processing
// metadata blob. combine-videos: clip count + popover with URLs.
// video-polish: the source video URL. captions/auto-title: a small
// hint for what got processed.
function PostProcessingInputs({ row }) {
  const m = row?.metadata || {}
  if (row.action === 'consume:combine-videos') {
    const count = Number(m.clips || (Array.isArray(m.video_urls) ? m.video_urls.length : 0)) || 0
    const urls = Array.isArray(m.video_urls) ? m.video_urls : []
    if (count === 0) return <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>—</span>
    return (
      <details style={{ display: 'inline-block' }} onClick={(e) => e.stopPropagation()}>
        <summary style={{
          cursor: 'pointer', fontSize: 11.5, color: 'var(--text-soft)',
          listStyle: 'none', userSelect: 'none',
        }}>
          {count} clip{count === 1 ? '' : 's'}{urls.length > 0 ? ' ▾' : ''}
        </summary>
        {urls.length > 0 && (
          <div style={{
            marginTop: 6, padding: 8, borderRadius: 6,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            maxWidth: 360, fontSize: 11,
          }}>
            {urls.map((u, i) => (
              <div key={i} style={{ marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <a href={u} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--red)', textDecoration: 'none' }}>
                  clip {i + 1} <ExternalLink size={10} style={{ verticalAlign: '-1px' }} />
                </a>
              </div>
            ))}
          </div>
        )}
      </details>
    )
  }
  if (row.action === 'consume:video-polish' && m.video_url) {
    return (
      <a href={m.video_url} target="_blank" rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ color: 'var(--red)', textDecoration: 'none', fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 3 }}
      >source <ExternalLink size={11} /></a>
    )
  }
  return <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>—</span>
}

function EmptyHint({ children }) {
  return (
    <div style={{
      padding: '24px 14px', textAlign: 'center',
      background: 'var(--surface)', border: '1px dashed var(--border)',
      borderRadius: 10, color: 'var(--muted)', fontSize: 12.5,
    }}>{children}</div>
  )
}

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const sectionHeader = {
  display: 'flex', alignItems: 'center', gap: 6,
  fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700,
  letterSpacing: '0.06em', textTransform: 'uppercase',
  color: 'var(--muted)', marginBottom: 8,
}
const countPill = {
  display: 'inline-flex', padding: '1px 7px', borderRadius: 999,
  background: 'var(--surface-2)', color: 'var(--text-soft)',
  fontSize: 10.5, fontWeight: 700, marginLeft: 2,
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
