import { useEffect, useState } from 'react'
import {
  Activity, RefreshCw, Loader2, AlertCircle, CheckCircle2,
  Webhook, Video, Calendar, RotateCw, Sparkles, Play,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { toast } from '../components/Toast.jsx'

// /admin/ops — single dashboard that maps the RUNBOOK queries to
// click-to-trigger UI. Designed to be the "open this every morning,
// check it's all green" page.
//
// Each card has:
//   - A one-line summary + count
//   - A status (green / amber / red) based on fresh-vs-stale + count
//   - An optional button to trigger the relevant cron right now
//
// Auto-refreshes every 60s.

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

export default function AdminOps() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [running, setRunning] = useState(null)  // cron path currently being kicked

  const refresh = async () => {
    setLoading(true); setError(null)
    try {
      const r = await authedFetch('/api/admin/ops')
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      setData(body)
    } catch (e) {
      setError(e.message); setData(null)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { refresh() /* eslint-disable-next-line */ }, [])
  // Auto-refresh once a minute. Hidden tabs pause naturally because
  // setInterval is throttled by the browser.
  useEffect(() => {
    const iv = setInterval(() => refresh(), 60_000)
    return () => clearInterval(iv)
    /* eslint-disable-next-line */
  }, [])

  // Manually fire a cron from the UI. Same path Vercel hits, just
  // with a stronger admin-JWT auth (the /admin/affiliates-close cron
  // accepts both bearer flavors). For sweep-stale-renders we don't
  // expose a JWT path, so the SPA doesn't trigger that one — admin
  // would have to curl with CRON_SECRET. Surface the path anyway so
  // the user knows where to look.
  const kickAdminCron = async (path, label) => {
    if (!window.confirm(`Run ${label} now?`)) return
    setRunning(path)
    try {
      const r = await authedFetch(path, { method: 'POST' })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error || 'Failed')
      toast?.success?.(`${label} → ${JSON.stringify(body)}`)
      refresh()
    } catch (e) {
      toast?.error?.(e.message) || alert(e.message)
    } finally { setRunning(null) }
  }

  return (
    <div style={{ padding: '32px 28px', maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
        <div style={iconWrap}><Activity size={18} /></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22 }}>System ops</div>
          <div style={{ fontSize: 13, color: 'var(--text-soft)', marginTop: 2 }}>
            Every-morning dashboard. Map: <code>RUNBOOK.md</code> queries → live counts.
            Auto-refreshes every 60s.
          </div>
        </div>
        <button
          onClick={refresh} disabled={loading}
          style={refreshBtn(loading)}
        >
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
        </button>
      </div>

      {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>{error}</div>}

      {data && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>

          {/* Stripe webhook freshness */}
          <Card
            icon={Webhook}
            title="Stripe webhook"
            severity={
              data.stripe.failed_unprocessed_count > 0 ? 'red'
              : (data.stripe.hours_since_last_event != null && data.stripe.hours_since_last_event > 12) ? 'amber'
              : 'green'
            }
            primary={
              data.stripe.last_event_at
                ? `Last event ${data.stripe.hours_since_last_event}h ago`
                : 'No events recorded'
            }
            secondary={
              data.stripe.failed_unprocessed_count > 0
                ? `${data.stripe.failed_unprocessed_count} failed unprocessed events`
                : 'No failed events'
            }
          >
            {data.stripe.failed_unprocessed_sample?.length > 0 && (
              <ul style={listMono}>
                {data.stripe.failed_unprocessed_sample.map((e) => (
                  <li key={e.stripe_event_id}>
                    <code>{e.event_type}</code> · {e.error?.slice(0, 60)}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Stuck avatar renders */}
          <Card
            icon={Video}
            title="Stuck avatar renders"
            severity={data.stuck_renders.count > 5 ? 'red' : data.stuck_renders.count > 0 ? 'amber' : 'green'}
            primary={`${data.stuck_renders.count} stuck >2h`}
            secondary="Should be 0 — sweeper runs every 15m"
            actions={[
              {
                label: 'View cron',
                href: 'https://vercel.com', // placeholder; user knows
                ext: true,
              },
            ]}
          >
            {data.stuck_renders.sample?.length > 0 && (
              <ul style={listMono}>
                {data.stuck_renders.sample.map((r) => (
                  <li key={r.id}>
                    <code>{r.id.slice(0, 8)}</code> · {r.status} · {timeAgo(r.created_at)}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Stuck scheduled posts (legacy bug) */}
          <Card
            icon={Calendar}
            title="Stuck scheduled posts"
            severity={data.stuck_scheduled_posts.count > 0 ? 'amber' : 'green'}
            primary={`${data.stuck_scheduled_posts.count} past-due, no request_id`}
            secondary="Pre-launch bug rows. Manual flip required."
          >
            {data.stuck_scheduled_posts.sample?.length > 0 && (
              <ul style={listMono}>
                {data.stuck_scheduled_posts.sample.map((p) => (
                  <li key={p.id}>
                    <code>{p.id.slice(0, 8)}</code> · {p.title?.slice(0, 40)}…
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Affiliate close cron health */}
          <Card
            icon={Sparkles}
            title="Affiliate commissions"
            severity={data.affiliates.stuck_pending_past_window > 0 ? 'amber' : 'green'}
            primary={`${data.affiliates.stuck_pending_past_window} pending past 31d`}
            secondary="Daily 7am cron approves these. >0 means cron failed."
            actions={[
              {
                label: running === '/api/admin/affiliates-close' ? 'Running…' : 'Run close now',
                onClick: () => kickAdminCron('/api/admin/affiliates-close', 'Affiliates close'),
                disabled: running !== null,
                primary: data.affiliates.stuck_pending_past_window > 0,
              },
            ]}
          />

          {/* Refunds in last 24h */}
          <Card
            icon={RotateCw}
            title="Refunds (24h)"
            severity={data.refunds_24h.total > 50 ? 'red' : data.refunds_24h.total > 10 ? 'amber' : 'green'}
            primary={`${data.refunds_24h.total} refunds issued`}
            secondary={
              Object.keys(data.refunds_24h.by_action).length === 0
                ? 'No upstream failures.'
                : 'Spike = upstream provider issue.'
            }
          >
            {Object.keys(data.refunds_24h.by_action).length > 0 && (
              <ul style={listMono}>
                {Object.entries(data.refunds_24h.by_action).map(([a, v]) => {
                  const consumeKey = a.replace(/^refund:/, 'consume:')
                  const consumes = data.refunds_24h.consume_counts_for_ratio[consumeKey] || 0
                  const ratio = consumes ? `${Math.round(v.count / consumes * 100)}% fail` : '—'
                  return (
                    <li key={a}>
                      <code>{a}</code> · {v.count}× · {ratio}
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </div>
      )}

      <div style={{ marginTop: 18, fontSize: 12.5, color: 'var(--muted)' }}>
        Generated {data?.generated_at ? new Date(data.generated_at).toLocaleTimeString() : '—'}.
        See <code>RUNBOOK.md</code> for diagnostic SQL + recovery commands.
      </div>
    </div>
  )
}

function Card({ icon: Icon, title, severity, primary, secondary, actions = [], children }) {
  const colorFor = (sev) => sev === 'red' ? 'var(--red)' : sev === 'amber' ? '#f59e0b' : '#2ecc71'
  const StatusIcon = severity === 'green' ? CheckCircle2 : AlertCircle
  return (
    <div className="card-flat" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {Icon && <Icon size={14} style={{ color: 'var(--muted)' }} />}
        <div style={{ flex: 1, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13.5 }}>{title}</div>
        <StatusIcon size={14} style={{ color: colorFor(severity) }} />
      </div>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18, color: colorFor(severity) }}>
        {primary}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-soft)' }}>{secondary}</div>
      {children && <div style={{ marginTop: 4 }}>{children}</div>}
      {actions.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
          {actions.map((a, i) => a.onClick ? (
            <button
              key={i} type="button"
              onClick={a.onClick}
              disabled={a.disabled}
              style={{
                padding: '6px 12px', borderRadius: 8,
                background: a.primary ? 'linear-gradient(135deg, var(--red), var(--red-dark))' : 'var(--surface-2)',
                border: a.primary ? 'none' : '1px solid var(--border)',
                color: a.primary ? '#fff' : 'var(--text-soft)',
                fontSize: 12, fontWeight: 600, cursor: a.disabled ? 'wait' : 'pointer',
                fontFamily: 'inherit',
                display: 'inline-flex', alignItems: 'center', gap: 5,
              }}
            >{a.label.startsWith('Running') ? <Loader2 size={11} className="spin" /> : <Play size={11} />} {a.label}</button>
          ) : (
            <a
              key={i} href={a.href} target={a.ext ? '_blank' : undefined} rel={a.ext ? 'noreferrer' : undefined}
              style={{ fontSize: 12, color: 'var(--muted)' }}
            >{a.label} →</a>
          ))}
        </div>
      )}
    </div>
  )
}

function timeAgo(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

const iconWrap = {
  width: 38, height: 38, borderRadius: 10,
  background: 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(249,115,22,0.10))',
  border: '1px solid rgba(239,68,68,0.30)',
  color: 'var(--red)', display: 'grid', placeItems: 'center',
}
const refreshBtn = (loading) => ({
  padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--surface-2)', color: 'var(--text-soft)',
  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5,
  cursor: loading ? 'wait' : 'pointer', fontFamily: 'inherit',
})
const listMono = {
  margin: '6px 0 0', padding: '8px 10px',
  background: 'var(--surface-2)', borderRadius: 6,
  fontSize: 11.5, fontFamily: 'monospace', color: 'var(--text-soft)',
  listStyle: 'none', maxHeight: 140, overflowY: 'auto',
}
