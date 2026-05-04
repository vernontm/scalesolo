// Activity timeline component — used in the Contact detail view
// (and as a general profile-wide feed on Dashboard later).
import { useEffect, useState } from 'react'
import {
  Mail, MailOpen, MousePointerClick, MailX, ClipboardList, KanbanSquare,
  Tag, FileUp, Phone, Pencil, Activity,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'

const EVENT_META = {
  email_sent:        { icon: Mail,         color: '#60a5fa', label: 'Email sent' },
  email_opened:      { icon: MailOpen,     color: '#2ecc71', label: 'Email opened' },
  email_clicked:     { icon: MousePointerClick, color: '#a78bfa', label: 'Email click' },
  email_bounced:     { icon: MailX,        color: '#ef4444', label: 'Email bounced' },
  form_submitted:    { icon: ClipboardList, color: '#f59e0b', label: 'Form submitted' },
  deal_created:      { icon: KanbanSquare, color: '#60a5fa', label: 'Deal created' },
  deal_moved:        { icon: KanbanSquare, color: '#a78bfa', label: 'Deal moved' },
  tag_added:         { icon: Tag,          color: '#94a3b8', label: 'Tag added' },
  imported:          { icon: FileUp,       color: '#94a3b8', label: 'Imported' },
  call_logged:       { icon: Phone,        color: '#60a5fa', label: 'Call logged' },
  note_added:        { icon: Pencil,       color: '#94a3b8', label: 'Note added' },
}

const wrap = { display: 'flex', flexDirection: 'column', gap: 0 }
const row = (isLast) => ({
  display: 'flex', gap: 12, padding: '0 0 18px 0',
  position: 'relative',
})
const dot = (color) => ({
  width: 28, height: 28, borderRadius: 8, background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  display: 'grid', placeItems: 'center', flexShrink: 0,
  color, position: 'relative', zIndex: 2,
})
const rail = {
  position: 'absolute', left: 14, top: 28, bottom: -2, width: 1,
  background: 'var(--border)',
}
const meta = {
  fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-display)',
  fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
}
const text = { fontSize: 13.5, color: 'var(--text)', marginTop: 2, lineHeight: 1.5 }
const time = { fontSize: 11, color: 'var(--muted)', marginTop: 2 }

function describe(ev) {
  switch (ev.event_type) {
    case 'deal_moved':    return `${ev.payload.title || 'Deal'}: ${ev.payload.from} → ${ev.payload.to}`
    case 'deal_created':  return `${ev.payload.title || 'New deal'} created in ${ev.payload.stage || ''}`
    case 'form_submitted': return `Submitted "${ev.payload.form_name || 'a form'}"`
    case 'email_sent':    return `Sent: ${ev.payload.subject || '(no subject)'}`
    case 'email_opened':  return `Opened: ${ev.payload.subject || ''}`
    case 'email_clicked': return `Clicked link in: ${ev.payload.subject || ''}`
    case 'tag_added':     return `Tagged: ${ev.payload.tag || ''}`
    case 'imported':      return `Imported from ${ev.payload.source || 'CSV'}`
    case 'note_added':    return ev.payload.note || 'Note added'
    case 'call_logged':   return ev.payload.summary || 'Call logged'
    default:              return ev.event_type.replace(/_/g, ' ')
  }
}

export default function ActivityTimeline({ contactId, profileId, limit = 30 }) {
  const { session } = useAuth()
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!session || (!contactId && !profileId)) return
    const qs = contactId ? `contact_id=${contactId}` : `profile_id=${profileId}`
    fetch(`/api/contact-activity?${qs}&limit=${limit}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => setEvents(b.events || []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false))
  }, [session, contactId, profileId, limit])

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}><span className="spinner" /></div>

  if (events.length === 0) {
    return (
      <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}>
        <Activity size={26} style={{ marginBottom: 10 }} />
        <div style={{ fontSize: 13 }}>Nothing here yet. Activity appears as deals move, forms are submitted, and emails fire.</div>
      </div>
    )
  }

  return (
    <div style={wrap}>
      {events.map((ev, i) => {
        const m = EVENT_META[ev.event_type] || { icon: Activity, color: 'var(--muted)', label: ev.event_type }
        const Icon = m.icon
        const isLast = i === events.length - 1
        return (
          <div key={ev.id} style={row(isLast)}>
            {!isLast && <div style={rail} />}
            <div style={dot(m.color)}><Icon size={14} strokeWidth={2.2} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={meta}>{m.label}</div>
              <div style={text}>{describe(ev)}</div>
              <div style={time}>{new Date(ev.occurred_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
