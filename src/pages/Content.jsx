import { useEffect, useMemo, useState } from 'react'
import {
  Sparkles, Library, Calendar, FileEdit, ClipboardCheck, X, Wand2,
  Check, Trash2, Edit3, Send, Eye, AlertCircle,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { useCredits } from '../context/CreditsContext.jsx'

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
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={20} /></button>
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
  const [scheduledAt, setScheduledAt] = useState(item.scheduled_datetime ? new Date(item.scheduled_datetime).toISOString().slice(0, 16) : '')
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
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={20} /></button>
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
    <div style={itemCard} onClick={() => onOpen(item)}
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
            ) : dayItems.map((item) => (
              <div key={item.id} onClick={() => onOpen(item)} style={{
                marginBottom: 6, padding: '6px 8px', borderRadius: 6,
                background: 'var(--surface-2)', cursor: 'pointer',
                fontSize: 12, color: 'var(--text-soft)',
              }}>
                <div style={{ fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.title || 'Untitled'}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                  {new Date(item.scheduled_datetime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                </div>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────
const TABS = [
  { value: 'library',    label: 'Library',    icon: Library,        filter: 'library',    empty: 'Generate your first piece of content to fill the library.' },
  { value: 'calendar',   label: 'Calendar',   icon: Calendar,       filter: 'scheduled',  empty: 'Nothing scheduled in the next two weeks.' },
  { value: 'drafts',     label: 'Drafts',     icon: FileEdit,       filter: 'drafts',     empty: 'No drafts. Generated content shows up here first.' },
  { value: 'approvals',  label: 'Approvals',  icon: ClipboardCheck, filter: 'approvals',  empty: 'No items waiting on you. Set AI CEO behavior to "Aggressive" to skip the queue entirely.' },
]

export default function Content() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
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

      {loading ? (
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
