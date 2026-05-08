import { useEffect, useMemo, useState } from 'react'
import {
  Sparkles, Library, Calendar, FileEdit, ClipboardCheck, X, Wand2,
  Check, Trash2, Edit3, Send, Eye, AlertCircle, Link2, Plus, ExternalLink,
} from 'lucide-react'
import BulkUploadView from '../components/BulkUploadView.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { useCredits } from '../context/CreditsContext.jsx'

// Format a UTC ISO timestamp as a "YYYY-MM-DDTHH:mm" string in the browser's
// local timezone — the format <input type="datetime-local"> expects. Pre-filling
// with toISOString() puts UTC into a local-time input and silently shifts the
// time on save.
function isoToLocalDatetimeInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ── styles ─────────────────────────────────────────────────────────────────
const tabBar = {
  display: 'flex',
  gap: 4,
  padding: 4,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  marginBottom: 18,
  width: 'fit-content',
}
const tabBtn = (active) => ({
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 14px', borderRadius: 8,
  background: active ? 'linear-gradient(135deg, var(--red), var(--red-dark))' : 'transparent',
  color: active ? '#fff' : 'var(--text-soft)',
  border: 'none', cursor: 'pointer',
  fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 600,
  boxShadow: active ? '0 4px 10px rgba(239,68,68,0.25)' : 'none',
  transition: 'all 0.15s ease',
})
const itemCard = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 16,
  marginBottom: 10,
}
const titleStyle = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 14.5,
  color: 'var(--text)',
  marginBottom: 4,
}
const meta = { fontSize: 12, color: 'var(--muted)', marginBottom: 8 }
const preview = {
  fontSize: 13, color: 'var(--text-soft)', lineHeight: 1.5,
  display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
  overflow: 'hidden', textOverflow: 'ellipsis',
  marginBottom: 10,
}
const rowActions = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }

const STATUS_PILL = {
  draft:         { bg: 'rgba(255,255,255,0.06)', fg: 'var(--muted)', label: 'Draft' },
  caption_ready: { bg: 'rgba(245,158,11,0.16)',  fg: '#f59e0b',     label: 'Caption ready' },
  scheduled:     { bg: 'rgba(96,165,250,0.16)',  fg: '#60a5fa',     label: 'Scheduled' },
  posted:        { bg: 'rgba(46,204,113,0.16)',  fg: '#2ecc71',     label: 'Posted' },
  failed:        { bg: 'rgba(239,68,68,0.16)',   fg: 'var(--red)',  label: 'Failed' },
}

const FORMATS = [
  { value: 'tiktok-script',    label: 'TikTok script',     icon: '🎬' },
  { value: 'ig-post',          label: 'Instagram post',    icon: '📸' },
  { value: 'thread',           label: 'X / Threads',       icon: '💬' },
  { value: 'youtube-short',    label: 'YouTube Short',     icon: '▶️' },
  { value: 'carousel-outline', label: 'Carousel outline',  icon: '🖼️' },
  { value: 'email-subject',    label: 'Email subjects',    icon: '✉️' },
  { value: 'blog-post',        label: 'Blog post',         icon: '📝' },
]

// ── Generate modal ────────────────────────────────────────────────────────
function GenerateModal({ profileId, onClose, onCreated }) {
  const { session } = useAuth()
  const { refresh: refreshCredits } = useCredits()
  const [format, setFormat] = useState('tiktok-script')
  const [topic, setTopic] = useState('')
  const [count, setCount] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const generate = async () => {
    if (!topic.trim()) return
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/content/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ profile_id: profileId, format, topic: topic.trim(), count: Number(count) || 1 }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Generation failed')
      refreshCredits()
      onCreated(body)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-md" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(135deg, var(--red), var(--red-dark))', color: '#fff', display: 'grid', placeItems: 'center', marginRight: 10 }}>
            <Wand2 size={16} />
          </div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, flex: 1 }}>Generate content</h3>
          <button aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6, borderRadius: 6 }}><X size={20} /></button>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label className="label">Format</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6 }}>
            {FORMATS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFormat(f.value)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 12px',
                  background: format === f.value ? 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(185,28,28,0.10))' : 'var(--surface-2)',
                  border: format === f.value ? '1px solid rgba(239,68,68,0.45)' : '1px solid var(--border)',
                  borderRadius: 10,
                  cursor: 'pointer',
                  fontSize: 12.5, fontFamily: 'var(--font-display)', fontWeight: 600,
                  color: 'var(--text)',
                  textAlign: 'left',
                }}
              >
                <span style={{ fontSize: 16 }}>{f.icon}</span>{f.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label className="label">Topic / hook idea</label>
          <textarea className="textarea" value={topic} onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. How AI agents are replacing the $300/mo SaaS stack for solopreneurs"
            autoFocus
          />
        </div>

        <div style={{ marginBottom: 18 }}>
          <label className="label">How many variations?</label>
          <select className="select" value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[1,2,3,5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
            Each variation costs ~1500 AI tokens. Brand bible + voice are auto-injected.
          </div>
        </div>

        {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}><AlertCircle size={14} style={{ verticalAlign: '-2px' }} /> {error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={generate} disabled={busy || !topic.trim()}>
            {busy ? <span className="spinner" /> : <Sparkles size={14} />}
            Generate{count > 1 ? ` ${count}` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Detail modal ──────────────────────────────────────────────────────────
function ItemDetail({ item, onClose, onUpdate }) {
  const { session } = useAuth()
  const [scheduledAt, setScheduledAt] = useState(isoToLocalDatetimeInput(item.scheduled_datetime))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const action = async (verb, body = {}) => {
    setBusy(true); setError(null)
    try {
      const url = verb === 'delete'
        ? `/api/content?id=${item.id}`
        : `/api/content?action=${verb}&id=${item.id}`
      const method = verb === 'delete' ? 'DELETE' : 'POST'
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
      })
      if (!r.ok && r.status !== 204) {
        const b = await r.json().catch(() => ({}))
        throw new Error(b.error || 'Action failed')
      }
      onUpdate()
      if (verb === 'delete') onClose()
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const pill = STATUS_PILL[item.status] || STATUS_PILL.draft

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-lg" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, flex: 1, lineHeight: 1.3 }}>
            {item.title || 'Untitled'}
          </h3>
          <span className="pill" style={{ background: pill.bg, color: pill.fg, marginRight: 10 }}>{pill.label}</span>
          <button aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6, borderRadius: 6 }}><X size={20} /></button>
        </div>

        {item.approval_status === 'pending' && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, padding: '10px 12px', background: 'var(--amber-soft, rgba(245,158,11,0.12))', borderRadius: 10, alignItems: 'center', border: '1px solid rgba(245,158,11,0.25)' }}>
            <ClipboardCheck size={14} style={{ color: '#f59e0b' }} />
            <span style={{ fontSize: 12.5, color: 'var(--text-soft)', flex: 1 }}>Pending your approval</span>
            <button className="btn-primary" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => action('approve')} disabled={busy}>
              <Check size={12} /> Approve
            </button>
            <button className="btn-secondary" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => action('reject', { reason: prompt('Reason?') || '' })} disabled={busy}>
              Reject
            </button>
          </div>
        )}

        {item.hook && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>Hook</div>
            <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.5 }}>{item.hook}</div>
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>Body</div>
          <div style={{ fontSize: 13.5, color: 'var(--text-soft)', lineHeight: 1.6, whiteSpace: 'pre-wrap', padding: 14, background: 'var(--surface-2)', borderRadius: 10, border: '1px solid var(--border)' }}>
            {item.full_script || '(empty)'}
          </div>
        </div>

        {item.caption && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>Caption</div>
            <div style={{ fontSize: 13.5, color: 'var(--text-soft)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{item.caption}</div>
          </div>
        )}

        {item.hashtags && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>Hashtags</div>
            <div style={{ fontSize: 12.5, color: 'var(--red)' }}>{item.hashtags}</div>
          </div>
        )}

        <div style={{ marginTop: 18, padding: 14, background: 'var(--surface-2)', borderRadius: 10, border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>Schedule</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="input"
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="btn-primary" onClick={() => action('schedule', { scheduled_datetime: new Date(scheduledAt).toISOString() })} disabled={busy || !scheduledAt}>
              <Send size={13} /> Schedule
            </button>
          </div>
        </div>

        {error && <div style={{ marginTop: 14, background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <button className="btn-ghost" onClick={() => action('delete')} disabled={busy}>
            <Trash2 size={13} /> Delete
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Item card ─────────────────────────────────────────────────────────────
function ItemRow({ item, onOpen }) {
  const pill = STATUS_PILL[item.status] || STATUS_PILL.draft
  return (
    <div
      style={itemCard}
      role="button" tabIndex={0}
      aria-label={`Open ${item.title || 'content item'}`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(item) } }}
      onClick={() => onOpen(item)}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(239,68,68,0.25)'; e.currentTarget.style.cursor = 'pointer' }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={titleStyle}>{item.title || 'Untitled'}</div>
          <div style={meta}>
            <span className="pill" style={{ background: pill.bg, color: pill.fg, marginRight: 8 }}>{pill.label}</span>
            {item.approval_status === 'pending' && <span className="pill pill-warning" style={{ marginRight: 8 }}>Needs approval</span>}
            {item.media_type && <span style={{ marginRight: 8 }}>{item.media_type}</span>}
            {item.scheduled_datetime && <span>· {new Date(item.scheduled_datetime).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>}
          </div>
          {(item.hook || item.full_script) && (
            <div style={preview}>{item.hook || item.full_script}</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── List view (Library / Drafts / Scheduled / Approvals / Posted) ─────────
function ItemList({ items, emptyHint, onOpen }) {
  if (items.length === 0) {
    return <div className="card-flat" style={{ padding: 50, textAlign: 'center', color: 'var(--muted)' }}>
      <Library size={28} style={{ marginBottom: 10 }} />
      <div style={{ fontSize: 13.5 }}>{emptyHint}</div>
    </div>
  }
  return <div>{items.map((item) => <ItemRow key={item.id} item={item} onOpen={onOpen} />)}</div>
}

// ── Calendar view (compact week list) ─────────────────────────────────────
function CalendarView({ items, onOpen }) {
  const days = useMemo(() => {
    const out = new Map()
    const now = new Date()
    for (let i = 0; i < 14; i++) {
      const d = new Date(now); d.setDate(now.getDate() + i)
      const k = d.toISOString().slice(0, 10)
      out.set(k, [])
    }
    for (const item of items) {
      if (!item.scheduled_datetime) continue
      const k = new Date(item.scheduled_datetime).toISOString().slice(0, 10)
      if (out.has(k)) out.get(k).push(item)
    }
    return out
  }, [items])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
      {Array.from(days.entries()).map(([day, dayItems]) => {
        const date = new Date(day + 'T12:00:00')
        const isToday = day === new Date().toISOString().slice(0, 10)
        return (
          <div key={day} style={{
            background: 'var(--surface)', border: '1px solid ' + (isToday ? 'rgba(239,68,68,0.35)' : 'var(--border)'),
            borderRadius: 10, padding: 10, minHeight: 110,
          }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: isToday ? 'var(--red)' : 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
              {date.toLocaleDateString(undefined, { weekday: 'short' })} {date.getDate()}
            </div>
            {dayItems.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>—</div>
            ) : dayItems.map((item) => {
              const platforms = Array.isArray(item.platforms) ? item.platforms : []
              const thumb = Array.isArray(item.media_urls) && item.media_urls[0]
              const isVideo = item.media_type === 'video'
              return (
                <div key={item.id} onClick={() => onOpen(item)} style={{
                  marginBottom: 6, padding: 6, borderRadius: 6,
                  background: 'var(--surface-2)', cursor: 'pointer',
                  fontSize: 12, color: 'var(--text-soft)',
                  display: 'flex', gap: 8, alignItems: 'flex-start',
                }}>
                  {thumb && (
                    isVideo
                      ? <video src={thumb} muted playsInline preload="metadata" style={{ width: 32, height: 32, borderRadius: 4, objectFit: 'cover', background: '#000', flexShrink: 0 }} />
                      : <img src={thumb} alt="" style={{ width: 32, height: 32, borderRadius: 4, objectFit: 'cover', background: 'var(--surface)', flexShrink: 0 }} />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.title || 'Untitled'}
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                      {new Date(item.scheduled_datetime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                    </div>
                    {platforms.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 4 }}>
                        {platforms.slice(0, 4).map((p) => (
                          <span key={p} style={{
                            fontSize: 9, padding: '1px 6px', borderRadius: 999,
                            background: 'rgba(46,204,113,0.15)', color: '#2ecc71',
                            fontFamily: 'var(--font-display)', fontWeight: 700,
                            letterSpacing: '0.04em', textTransform: 'capitalize',
                          }}>{p}</span>
                        ))}
                        {platforms.length > 4 && (
                          <span style={{ fontSize: 9, color: 'var(--muted)' }}>+{platforms.length - 4}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// ── Social accounts panel — Upload-Post connect-account widget ────────────
//
// Each ScaleSolo brand profile maps deterministically to one Upload-Post
// sub-account (whitelabel "user profile"). On mount we fetch its current
// state; "Connect" pops a JWT-signed URL on app.upload-post.com where the
// user authorizes TikTok / IG / etc. and the connections appear here once
// they return and refresh.
const SOCIAL_PLATFORMS = [
  { id: 'tiktok',    label: 'TikTok',    color: '#000' },
  { id: 'instagram', label: 'Instagram', color: '#E1306C' },
  { id: 'youtube',   label: 'YouTube',   color: '#FF0000' },
  { id: 'x',         label: 'X',         color: '#000' },
  { id: 'threads',   label: 'Threads',   color: '#000' },
  { id: 'linkedin',  label: 'LinkedIn',  color: '#0A66C2' },
  { id: 'facebook',  label: 'Facebook',  color: '#1877F2' },
  { id: 'pinterest', label: 'Pinterest', color: '#BD081C' },
]

function SocialAccountsPanel({ profileId, token }) {
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [connecting, setConnecting] = useState(false)

  const refresh = () => {
    if (!profileId || !token) return
    setLoading(true); setErr(null)
    fetch(`/api/social/profiles?profile_id=${profileId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json().then((b) => ({ ok: r.ok, body: b })))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body?.error || 'Failed to load social accounts')
        setProfile(body)
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false))
  }
  useEffect(refresh, [profileId, token])

  const onConnect = async () => {
    setConnecting(true); setErr(null)
    try {
      const r = await fetch('/api/social/profiles?action=jwt', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId, redirect_url: window.location.href }),
      })
      const body = await r.json()
      if (!r.ok || !body.access_url) throw new Error(body?.error || `Connect failed (${r.status})`)
      // Open in a new tab so the user keeps their place in ScaleSolo. They
      // come back to this tab and hit "Refresh" to see the new connection.
      window.open(body.access_url, '_blank', 'noopener')
    } catch (e) {
      setErr(e.message)
    } finally {
      setConnecting(false)
    }
  }

  const social = profile?.profile?.social_accounts || {}
  const connectedIds = Object.entries(social)
    .filter(([, info]) => info && (info === true || info.access_token || info.connected || info.username))
    .map(([id]) => id)

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
      padding: 16, marginBottom: 18,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ width: 28, height: 28, borderRadius: 7, background: 'linear-gradient(135deg, #2ecc71, #1abc9c)', color: '#fff', display: 'grid', placeItems: 'center' }}>
          <Link2 size={14} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14 }}>Social accounts</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Connect the platforms ScaleSolo can publish to for this brand.
          </div>
        </div>
        <button className="btn-secondary" onClick={refresh} disabled={loading} style={{ padding: '6px 10px' }}>
          {loading ? <span className="spinner" /> : 'Refresh'}
        </button>
        <button className="btn-primary" onClick={onConnect} disabled={connecting}>
          {connecting ? <span className="spinner" /> : <Plus size={13} />}
          {connectedIds.length ? 'Add / manage' : 'Connect accounts'}
          <ExternalLink size={11} style={{ opacity: 0.7 }} />
        </button>
      </div>
      {err && (
        <div style={{ padding: '8px 10px', background: 'var(--red-soft)', color: 'var(--red)', fontSize: 12, borderRadius: 8, marginBottom: 10 }}>
          <AlertCircle size={12} style={{ verticalAlign: '-2px', marginRight: 6 }} /> {err}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {SOCIAL_PLATFORMS.map((p) => {
          const connected = connectedIds.includes(p.id)
          const info = social[p.id]
          // Only show a handle in the pill if it looks like an actual
          // username. Upload-Post returns whatever the platform stores;
          // for some that's a numeric ID (Instagram graph user_id,
          // TikTok open_id) or a YouTube channel ID (24 chars,
          // typically starting with UC). All of those are useless to
          // the user and look like leaked internals — filter them.
          const rawHandle = info?.username || info?.display_name || info?.handle || ''
          const looksLikeRealHandle = (() => {
            if (typeof rawHandle !== 'string') return false
            if (!rawHandle.length || rawHandle.length >= 30) return false
            if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(rawHandle)) return false
            // YouTube channel id pattern: UC + 22 alphanumeric/-_ chars.
            if (/^UC[A-Za-z0-9_-]{22}$/.test(rawHandle)) return false
            // Mostly digits → almost certainly an internal ID.
            const digits = (rawHandle.match(/\d/g) || []).length
            if (rawHandle.length >= 10 && digits / rawHandle.length > 0.6) return false
            return true
          })()
          const handle = looksLikeRealHandle ? rawHandle : null
          return (
            <div
              key={p.id}
              title={connected && handle ? `Connected as @${handle}` : connected ? 'Connected' : 'Not connected'}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 10px', borderRadius: 999,
                background: connected ? 'rgba(46,204,113,0.14)' : 'var(--surface-2)',
                border: `1px solid ${connected ? 'rgba(46,204,113,0.45)' : 'var(--border)'}`,
                color: connected ? '#2ecc71' : 'var(--muted)',
                fontSize: 11.5, fontFamily: 'var(--font-display)', fontWeight: 700,
                letterSpacing: '0.02em',
              }}
            >
              <span style={{
                width: 6, height: 6, borderRadius: 999,
                background: connected ? '#2ecc71' : 'var(--muted)',
              }} />
              {p.label}
              {connected && handle && <span style={{ color: 'var(--muted)', fontWeight: 500 }}>· @{handle}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────
const TABS = [
  { value: 'library',    label: 'All',        icon: Library,        filter: 'library',    empty: 'Generate your first piece of content to fill this view.' },
  // (the "library" tab still exists — Schedule is the page name, Library
  // is just one view inside it)
  { value: 'calendar',   label: 'Calendar',   icon: Calendar,       filter: 'scheduled',  empty: 'Nothing scheduled in the next two weeks.' },
  { value: 'drafts',     label: 'Drafts',     icon: FileEdit,       filter: 'drafts',     empty: 'No drafts. Generated content shows up here first.' },
  { value: 'approvals',  label: 'Approvals',  icon: ClipboardCheck, filter: 'approvals',  empty: 'No items waiting on you. Set AI CEO behavior to "Aggressive" to skip the queue entirely.' },
]

export default function Content() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  // Library tab is the bulk-upload + manage table — the primary surface
  // for the Schedule page. Calendar / Drafts / Approvals still selectable.
  const [tab, setTab] = useState('library')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [opened, setOpened] = useState(null)
  const [pendingCount, setPendingCount] = useState(0)

  const refresh = () => {
    if (!session || !selectedProfileId) return
    setLoading(true)
    const t = TABS.find((x) => x.value === tab)
    fetch(`/api/content?profile_id=${selectedProfileId}&filter=${t.filter}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => setItems(b.items || []))
      .finally(() => setLoading(false))
  }

  const refreshPending = () => {
    if (!session || !selectedProfileId) return
    fetch(`/api/content?profile_id=${selectedProfileId}&filter=approvals`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => setPendingCount((b.items || []).length))
  }

  useEffect(() => { refresh(); refreshPending() }, [session, selectedProfileId, tab])

  if (!selectedProfileId) {
    return <div className="card-flat fade-up" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      Pick a brand profile to manage content.
    </div>
  }

  return (
    <div className="fade-up">
      <SocialAccountsPanel profileId={selectedProfileId} token={session?.access_token} />
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14, gap: 10 }}>
        <div style={tabBar}>
          {TABS.map((t) => {
            const Icon = t.icon
            const isApprovals = t.value === 'approvals'
            return (
              <button key={t.value} style={tabBtn(tab === t.value)} onClick={() => setTab(t.value)}>
                <Icon size={13} />
                {t.label}
                {isApprovals && pendingCount > 0 && (
                  <span style={{ marginLeft: 4, background: 'rgba(255,255,255,0.25)', color: 'inherit', padding: '1px 7px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                    {pendingCount}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn-primary" onClick={() => setGenerating(true)}>
          <Sparkles size={14} /> Generate content
        </button>
      </div>

      {tab === 'library' ? (
        // Library tab is now the bulk upload + manage table view (mirrors
        // VTM's ContentScheduler). It owns its own data fetch + status
        // tabs internally so we don't need the outer loading guard.
        <BulkUploadView profileId={selectedProfileId} token={session?.access_token} onChange={refreshPending} />
      ) : loading ? (
        <div className="card-flat" style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
      ) : tab === 'calendar' ? (
        <CalendarView items={items} onOpen={setOpened} />
      ) : (
        <ItemList items={items} emptyHint={TABS.find((t) => t.value === tab).empty} onOpen={setOpened} />
      )}

      {generating && (
        <GenerateModal
          profileId={selectedProfileId}
          onClose={() => setGenerating(false)}
          onCreated={(body) => {
            setGenerating(false)
            // Show the latest item, refresh list
            refresh()
            refreshPending()
          }}
        />
      )}
      {opened && <ItemDetail item={opened} onClose={() => setOpened(null)} onUpdate={() => { refresh(); refreshPending() }} />}
    </div>
  )
}
