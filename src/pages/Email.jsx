// Email: campaigns sent through Amazon SES, plus the brand's sender setup.
//
//   Campaigns tab   list, composer (AI draft + HTML + preview), test send,
//                   send now / schedule, live counters
//   Sender tab      from name + address, reply-to, postal address, and the
//                   brand's own sending domains with the DNS records to add
//
// Delivery is server-side (api/email/*). This page never talks to SES.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Mail, Plus, Send, Clock, Pencil, Trash2, Sparkles, Loader2, CheckCircle2, AlertCircle, RefreshCw, Globe, Copy, X, Eye, Code2, ShieldCheck, Ban, Play, Users,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { toast, confirmDialog } from '../components/Toast.jsx'
// Same validator the API gates on, so the composer cannot disagree with the
// server about whether an email is sendable.
import { validateTemplate, MERGE_VARS } from '../../api/_lib/email-validate.js'

const label = { fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, fontFamily: 'var(--font-display)' }
const muted = { fontSize: 12.5, color: 'var(--muted)' }
const row = { display: 'flex', alignItems: 'center', gap: 10 }

const STATUS = {
  draft:     { t: 'Draft',     cls: 'pill-muted' },
  scheduled: { t: 'Scheduled', cls: 'pill-warning' },
  sending:   { t: 'Sending',   cls: 'pill-warning' },
  sent:      { t: 'Sent',      cls: 'pill-success' },
  partial:   { t: 'Partial',   cls: 'pill-warning' },
  failed:    { t: 'Failed',    cls: 'pill-danger' },
}

function useApi() {
  const { session } = useAuth()
  const token = session?.access_token
  return useCallback(async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (r.status === 204) return {}
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
    return data
  }, [token])
}

const fmtWhen = (iso) => iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''
const pct = (n, d) => d ? `${Math.round((n / d) * 100)}%` : '0%'

// ── Campaign card ──────────────────────────────────────────────────────────
function CampaignCard({ c, onEdit, onSend, onCancel, onDelete }) {
  const s = STATUS[c.status] || STATUS.draft
  const total = c.total_recipients || 0
  const live = c.status === 'sending'
  return (
    <div className="card-flat" style={{ padding: 18, display: 'grid', gap: 12 }}>
      <div style={{ ...row, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ ...row, gap: 8, marginBottom: 4 }}>
            <span className={`pill ${s.cls}`}>{live ? <Loader2 size={11} className="spin" /> : null} {s.t}</span>
            {c.scheduled_at && c.status === 'scheduled' && <span style={muted}><Clock size={12} style={{ verticalAlign: '-2px' }} /> {fmtWhen(c.scheduled_at)}</span>}
            {c.sent_at && ['sent', 'partial'].includes(c.status) && <span style={muted}>Sent {fmtWhen(c.sent_at)}</span>}
          </div>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.subject || 'Untitled'}</div>
          {c.preview_text && <div style={{ ...muted, marginTop: 2 }}>{c.preview_text}</div>}
          <div style={{ ...muted, marginTop: 6 }}>
            Audience: {Array.isArray(c.tag_filter) && c.tag_filter.length ? c.tag_filter.map((t) => <span key={t} className="pill pill-muted" style={{ marginRight: 4 }}>{t}</span>) : 'everyone'}
          </div>
        </div>
        <div style={{ ...row, gap: 6 }}>
          {['draft', 'failed', 'scheduled'].includes(c.status) && <button className="btn-ghost" onClick={() => onEdit(c)}><Pencil size={14} /> Edit</button>}
          {['draft', 'failed'].includes(c.status) && <button className="btn-primary" onClick={() => onSend(c)}><Send size={14} /> Send</button>}
          {['scheduled', 'sending'].includes(c.status) && <button className="btn-secondary" onClick={() => onCancel(c)}><Ban size={14} /> {c.status === 'sending' ? 'Stop' : 'Unschedule'}</button>}
          {c.status !== 'sending' && <button className="btn-ghost" aria-label="Delete campaign" onClick={() => onDelete(c)} style={{ color: 'var(--muted)' }}><Trash2 size={14} /></button>}
        </div>
      </div>

      {(total > 0 || c.sent_count > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 8 }}>
          {[
            ['Recipients', total],
            ['Sent', c.sent_count || 0, pct(c.sent_count || 0, total)],
            ['Delivered', c.delivered_count || 0, pct(c.delivered_count || 0, c.sent_count || 0)],
            ['Opened', c.opened_count || 0, pct(c.opened_count || 0, c.delivered_count || c.sent_count || 0)],
            ['Clicked', c.clicked_count || 0, pct(c.clicked_count || 0, c.delivered_count || c.sent_count || 0)],
            ['Bounced', c.bounced_count || 0],
            ['Unsubscribed', c.unsubscribed_count || 0],
            ['Failed', c.failed_count || 0],
          ].map(([k, v, p]) => (
            <div key={k} style={{ background: 'var(--surface-2)', borderRadius: 10, padding: '8px 10px' }}>
              <div style={{ ...label, marginBottom: 2 }}>{k}</div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>{v}{p ? <span style={{ ...muted, marginLeft: 6 }}>{p}</span> : null}</div>
            </div>
          ))}
        </div>
      )}
      {c.last_error && <div style={{ ...row, color: 'var(--red)', fontSize: 12.5 }}><AlertCircle size={13} /> {c.last_error}</div>}
    </div>
  )
}

// ── Composer ───────────────────────────────────────────────────────────────
function Composer({ profileId, campaign, tags, onClose, onSaved }) {
  const api = useApi()
  const [subject, setSubject] = useState(campaign?.subject || '')
  const [preview, setPreview] = useState(campaign?.preview_text || '')
  const [html, setHtml] = useState(campaign?.html_body || '')
  const [audience, setAudience] = useState(Array.isArray(campaign?.tag_filter) ? campaign.tag_filter : [])
  const [id, setId] = useState(campaign?.id || null)
  const [tab, setTab] = useState(campaign?.html_body ? 'preview' : 'write')
  const [previewHtml, setPreviewHtml] = useState('')
  const [senderIssue, setSenderIssue] = useState(null)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState('')
  const [testTo, setTestTo] = useState('')
  const [schedAt, setSchedAt] = useState(campaign?.scheduled_at ? new Date(campaign.scheduled_at).toISOString().slice(0, 16) : '')
  const [showVars, setShowVars] = useState(false)
  // Recomputed as you type, from the same module the API gates on, so the
  // button state and the server's answer can never disagree.
  const check = useMemo(() => validateTemplate({ subject, html, previewText: preview }), [subject, html, preview])
  const previewTimer = useRef(null)

  const audienceCount = useMemo(() => {
    if (!audience.length) return tags.contacts
    const map = new Map(tags.tags.map((t) => [t.tag, t.count]))
    return audience.reduce((n, t) => n + (map.get(t) || 0), 0)
  }, [audience, tags])

  // Live preview through the server renderer so the footer + merge tags
  // match what actually goes out.
  useEffect(() => {
    if (tab !== 'preview') return
    clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(async () => {
      try {
        const r = await api('/api/email/campaigns?action=preview', { method: 'POST', body: { profile_id: profileId, subject, preview_text: preview, html_body: html } })
        setPreviewHtml(r.html || '')
        setSenderIssue(r.sender_ok ? null : r.sender_reason)
      } catch (e) { setPreviewHtml(`<p style="font-family:sans-serif;color:#b91c1c;padding:20px">${e.message}</p>`) }
    }, 250)
    return () => clearTimeout(previewTimer.current)
  }, [tab, subject, preview, html, profileId, api])

  const save = async () => {
    if (!subject.trim()) throw new Error('Add a subject line.')
    const body = { subject, preview_text: preview, html_body: html, tag_filter: audience }
    let saved
    if (id) saved = await api(`/api/email/campaigns?id=${id}`, { method: 'PATCH', body })
    else saved = await api('/api/email/campaigns', { method: 'POST', body: { profile_id: profileId, ...body } })
    setId(saved.campaign.id)
    return saved.campaign
  }

  const run = async (what, fn) => {
    setBusy(what)
    try { await fn() } catch (e) { toast({ message: e.message, kind: 'error' }) } finally { setBusy('') }
  }

  const generate = () => run('ai', async () => {
    if (!prompt.trim()) throw new Error('Tell the composer what this email is about.')
    const r = await api('/api/email/generate', { method: 'POST', body: { profile_id: profileId, prompt, current: html || subject ? { subject, html_body: html } : null } })
    setSubject(r.subject || subject); setPreview(r.preview_text || preview); setHtml(r.html_body || html)
    setPrompt(''); setTab('preview')
    toast({ kind: 'success', message: 'Draft ready. Read it through before sending.' })
  })

  const saveDraft = () => run('save', async () => { await save(); toast({ kind: 'success', message: 'Draft saved.' }); onSaved?.() })

  const sendTest = () => run('test', async () => {
    if (!testTo.trim()) throw new Error('Enter an address for the test.')
    const c = await save()
    await api('/api/email/campaigns?action=test', { method: 'POST', body: { id: c.id, to: testTo.trim() } })
    toast({ kind: 'success', message: `Test sent to ${testTo.trim()}.` })
  })

  const sendNow = () => run('send', async () => {
    const c = await save()
    const ok = await confirmDialog({
      title: 'Send this campaign now?',
      message: `"${c.subject}" goes to ${audienceCount} contact${audienceCount === 1 ? '' : 's'} right away. There is no undo once it starts.`,
      confirmText: 'Send now',
    })
    if (!ok) return
    const r = await api('/api/email/campaigns?action=send', { method: 'POST', body: { id: c.id } })
    toast({ kind: 'success', message: r.stats?.done ? `Sent to ${r.stats.sent} contacts.` : 'Sending started. It keeps going in the background.' })
    onSaved?.(); onClose()
  })

  const schedule = () => run('schedule', async () => {
    if (!schedAt) throw new Error('Pick a date and time.')
    const c = await save()
    await api('/api/email/campaigns?action=schedule', { method: 'POST', body: { id: c.id, scheduled_at: new Date(schedAt).toISOString() } })
    toast({ kind: 'success', message: `Scheduled for ${fmtWhen(new Date(schedAt).toISOString())}.` })
    onSaved?.(); onClose()
  })

  const toggleTag = (t) => setAudience((a) => a.includes(t) ? a.filter((x) => x !== t) : [...a, t])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-xl" onClick={(e) => e.stopPropagation()} style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
        <div style={{ ...row, justifyContent: 'space-between' }}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, margin: 0 }}>{id ? 'Edit campaign' : 'New campaign'}</h3>
          <button aria-label="Close" onClick={onClose} className="btn-ghost" style={{ padding: 6 }}><X size={18} /></button>
        </div>

        <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12, padding: 12, display: 'grid', gap: 8 }}>
          <div style={label}><Sparkles size={12} style={{ verticalAlign: '-2px' }} /> Write with AI</div>
          <div style={{ ...row, alignItems: 'stretch' }}>
            <textarea className="textarea" rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ flex: 1 }}
              placeholder={html ? 'Change something: "make the subject punchier", "add a line about Friday lamb chops"' : 'What is this email about? "Father\'s Day family platter special, 20% off Sunday only"'} />
            <button className="btn-primary" onClick={generate} disabled={busy !== ''} style={{ alignSelf: 'stretch' }}>
              {busy === 'ai' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} {html ? 'Revise' : 'Draft'}
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <div><div style={label}>Subject</div><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="This Sunday: the family platter is back" /></div>
          <div><div style={label}>Preview text</div><input className="input" value={preview} onChange={(e) => setPreview(e.target.value)} placeholder="Shown next to the subject in the inbox" /></div>
        </div>

        <div>
          <div style={label}>Audience <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>({audienceCount} contact{audienceCount === 1 ? '' : 's'})</span></div>
          <div style={{ ...row, flexWrap: 'wrap', gap: 6 }}>
            <button type="button" className={audience.length ? 'btn-ghost' : 'btn-secondary'} onClick={() => setAudience([])} style={{ padding: '5px 10px', fontSize: 12.5 }}>Everyone ({tags.contacts})</button>
            {tags.tags.map((t) => (
              <button type="button" key={t.tag} className={audience.includes(t.tag) ? 'btn-secondary' : 'btn-ghost'} onClick={() => toggleTag(t.tag)} style={{ padding: '5px 10px', fontSize: 12.5 }}>
                {t.tag} <span style={muted}>({t.count})</span>
              </button>
            ))}
            {!tags.tags.length && <span style={muted}>Tag contacts to target a segment. No tags yet, so this goes to everyone.</span>}
          </div>
        </div>

        <div>
          <div style={{ ...row, justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={label}>Body</div>
            <div style={{ ...row, gap: 4 }}>
              <button type="button" className={tab === 'write' ? 'btn-secondary' : 'btn-ghost'} onClick={() => setTab('write')} style={{ padding: '4px 10px', fontSize: 12 }}><Code2 size={13} /> HTML</button>
              <button type="button" className={tab === 'preview' ? 'btn-secondary' : 'btn-ghost'} onClick={() => setTab('preview')} style={{ padding: '4px 10px', fontSize: 12 }}><Eye size={13} /> Preview</button>
            </div>
          </div>
          {tab === 'write' ? (
            <textarea className="textarea" rows={14} value={html} onChange={(e) => setHtml(e.target.value)} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5 }}
              placeholder={'Paste HTML, or just write plain paragraphs. Use {{first_name}} to personalize.\n\nThe unsubscribe footer is added automatically.'} />
          ) : (
            <iframe title="Email preview" sandbox="" srcDoc={previewHtml} style={{ width: '100%', height: 440, border: '1px solid var(--border)', borderRadius: 10, background: '#f5f7fa' }} />
          )}
          {senderIssue && <div style={{ ...row, color: 'var(--red)', fontSize: 12.5, marginTop: 6 }}><AlertCircle size={13} /> {senderIssue}</div>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'end' }}>
          <div>
            <div style={label}>Send a test first</div>
            <div style={row}>
              <input className="input" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@yourbusiness.com" />
              <button className="btn-secondary" onClick={sendTest} disabled={busy !== ''}>{busy === 'test' ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Test</button>
            </div>
          </div>
          <div>
            <div style={label}>Or schedule</div>
            <div style={row}>
              <input className="input" type="datetime-local" value={schedAt} onChange={(e) => setSchedAt(e.target.value)} />
              <button className="btn-secondary" onClick={schedule} disabled={busy !== '' || !check.ok}
                title={check.ok ? '' : 'Fix the problems listed below first'}>{busy === 'schedule' ? <Loader2 size={14} className="spin" /> : <Clock size={14} />} Schedule</button>
            </div>
          </div>
        </div>

        {(check.errors.length > 0 || check.warnings.length > 0) && (
          <div style={{
            padding: '12px 14px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.55,
            background: check.errors.length ? 'rgba(239,68,68,0.10)' : 'rgba(245,158,11,0.10)',
            border: `1px solid ${check.errors.length ? 'var(--red)' : 'var(--amber)'}`,
          }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 700, marginBottom: 6, color: check.errors.length ? 'var(--red)' : 'var(--amber)' }}>
              <AlertCircle size={15} />
              {check.errors.length
                ? `${check.errors.length} problem${check.errors.length === 1 ? '' : 's'} to fix before this can send`
                : 'Worth a look before sending'}
            </div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {check.errors.map((e) => <li key={e} style={{ marginBottom: 3 }}>{e}</li>)}
              {check.warnings.map((w) => <li key={w} style={{ marginBottom: 3, color: 'var(--muted)' }}>{w}</li>)}
            </ul>
          </div>
        )}

        <div>
          <button className="btn-ghost" onClick={() => setShowVars((v) => !v)} style={{ fontSize: 12, padding: '4px 8px' }}>
            {showVars ? 'Hide' : 'Show'} the tags you can use
          </button>
          {showVars && (
            <div className="card-flat" style={{ marginTop: 8, padding: 12, fontSize: 12.5, display: 'grid', gap: 6 }}>
              {MERGE_VARS.map((v) => (
                <div key={v.tag} style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <code style={{ background: 'var(--surface-2)', padding: '2px 6px', borderRadius: 5, color: 'var(--red)', whiteSpace: 'nowrap' }}>{`{{${v.tag}}}`}</code>
                  <span style={{ color: 'var(--muted)' }}>{v.what}</span>
                </div>
              ))}
              <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                Double braces only. Single braces like {'{first_name}'} are never filled in.
              </div>
            </div>
          )}
        </div>

        <div style={{ ...row, justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <div style={{ ...row, gap: 8 }}>
            <button className="btn-secondary" onClick={saveDraft} disabled={busy !== ''}>{busy === 'save' ? <Loader2 size={14} className="spin" /> : null} Save draft</button>
            <button className="btn-primary" onClick={sendNow}
              disabled={busy !== '' || !!senderIssue || !check.ok}
              title={check.ok ? '' : 'Fix the problems listed above first'}>
              {busy === 'send' ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Send now
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}


// ── Subscribers tab ────────────────────────────────────────────────────────
// The list behind every campaign. Status is shown plainly because the
// difference matters: unsubscribed is the person's choice and reversible by
// them, while bounced and complained are permanent and deliberately cannot be
// flipped back to active.
const STATUS_STYLE = {
  active:      { label: 'Active',       color: '#22c55e' },
  unsubscribed:{ label: 'Unsubscribed', color: '#94a3b8' },
  bounced:     { label: 'Bounced',      color: '#ef4444' },
  complained:  { label: 'Spam report',  color: '#ef4444' },
}

function SubscribersTab({ profileId, canEdit }) {
  const { session } = useAuth()
  const token = session?.access_token
  const [rows, setRows] = useState([])
  const [counts, setCounts] = useState({})
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [offset, setOffset] = useState(0)
  const [adding, setAdding] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const LIMIT = 50

  const load = useCallback(async () => {
    if (!profileId || !token) return
    setLoading(true); setErr(null)
    try {
      const qs = new URLSearchParams({ profile_id: profileId, limit: String(LIMIT), offset: String(offset) })
      if (q.trim()) qs.set('q', q.trim())
      if (status) qs.set('status', status)
      const r = await fetch(`/api/email/contacts?${qs}`, { headers: { Authorization: `Bearer ${token}` } })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || 'Could not load subscribers')
      setRows(b.contacts || []); setCounts(b.counts || {}); setTotal(b.total || 0)
    } catch (e) { setErr(e.message) } finally { setLoading(false) }
  }, [profileId, token, q, status, offset])

  // Debounced so typing in the search box does not fire a request per key.
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [load])

  const act = async (fn) => {
    setBusy(true); setErr(null)
    try { await fn(); await load() } catch (e) { setErr(e.message); toast({ message: e.message, kind: 'error' }) } finally { setBusy(false) }
  }

  const addOne = () => act(async () => {
    const r = await fetch('/api/email/contacts', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ profile_id: profileId, email: newEmail, name: newName }),
    })
    const b = await r.json()
    if (!r.ok) throw new Error(b.error || 'Could not add')
    setNewEmail(''); setNewName(''); setAdding(false)
    toast({ message: 'Subscriber added.', kind: 'success' })
  })

  const setStatusFor = (c, next) => act(async () => {
    const r = await fetch(`/api/email/contacts?id=${c.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: next }),
    })
    const b = await r.json()
    if (!r.ok) throw new Error(b.error || 'Could not update')
    toast({ message: next === 'unsubscribed' ? 'Unsubscribed.' : 'Updated.', kind: 'success' })
  })

  const remove = (c) => act(async () => {
    const ok = await confirmDialog({
      title: 'Remove subscriber?',
      message: `${c.email} will be deleted from this list. If they bounced or reported spam they stay suppressed, so a later import cannot bring them back.`,
      confirmText: 'Remove', destructive: true,
    })
    if (!ok) return
    const r = await fetch(`/api/email/contacts?id=${c.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not remove')
    toast({ message: 'Removed.', kind: 'success' })
  })

  const pill = (key) => {
    const s = STATUS_STYLE[key] || STATUS_STYLE.active
    return { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, color: s.color, background: `${s.color}1f`, whiteSpace: 'nowrap' }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="input" value={q} onChange={(e) => { setOffset(0); setQ(e.target.value) }}
          placeholder="Search name or email" style={{ flex: 1, minWidth: 180, height: 38, fontSize: 13 }} />
        <select className="input" value={status} onChange={(e) => { setOffset(0); setStatus(e.target.value) }}
          style={{ height: 38, fontSize: 13, maxWidth: 180 }}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_STYLE).map(([k, s]) => (
            <option key={k} value={k}>{s.label}{counts[k] ? ` (${counts[k]})` : ''}</option>
          ))}
        </select>
        {canEdit && <button className="btn-primary" onClick={() => setAdding((v) => !v)} style={{ height: 38 }}><Plus size={14} /> Add</button>}
      </div>

      {adding && canEdit && (
        <div className="card-flat" style={{ padding: 14, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="email@example.com"
            style={{ flex: 2, minWidth: 200, height: 38, fontSize: 13 }} />
          <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name (optional)"
            style={{ flex: 1, minWidth: 140, height: 38, fontSize: 13 }} />
          <button className="btn-primary" onClick={addOne} disabled={busy || !newEmail.trim()} style={{ height: 38 }}>Add</button>
          <button className="btn-ghost" onClick={() => setAdding(false)} style={{ height: 38 }}>Cancel</button>
        </div>
      )}

      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
        {total} subscriber{total === 1 ? '' : 's'}
        {counts.active ? ` · ${counts.active} active` : ''}
        {counts.unsubscribed ? ` · ${counts.unsubscribed} unsubscribed` : ''}
        {(counts.bounced || counts.complained) ? ` · ${(counts.bounced || 0) + (counts.complained || 0)} suppressed` : ''}
      </div>

      {err && <div style={{ padding: '10px 14px', background: 'var(--red-soft)', color: 'var(--red)', borderRadius: 10, fontSize: 13 }}>{err}</div>}

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
      ) : rows.length === 0 ? (
        <div className="card-flat" style={{ padding: 44, textAlign: 'center', color: 'var(--muted)' }}>
          <Users size={30} style={{ marginBottom: 10 }} />
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--text)', fontSize: 15, marginBottom: 4 }}>
            {q || status ? 'Nothing matches that' : 'No subscribers yet'}
          </div>
          <div style={{ fontSize: 13 }}>
            {q || status ? 'Try a different search or status.' : 'Add one above, or collect them from a landing page.'}
          </div>
        </div>
      ) : (
        <div className="card-flat" style={{ padding: 0, overflow: 'hidden' }}>
          {rows.map((c, i) => (
            <div key={c.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', flexWrap: 'wrap',
              borderTop: i === 0 ? 'none' : '1px solid var(--border)',
            }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{c.name || c.email}</div>
                {c.name && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{c.email}</div>}
              </div>
              {Array.isArray(c.tags) && c.tags.slice(0, 3).map((t) => (
                <span key={t} style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--surface-2)', borderRadius: 999, padding: '2px 8px' }}>{t}</span>
              ))}
              <span style={pill(c.status)}>{(STATUS_STYLE[c.status] || STATUS_STYLE.active).label}</span>
              {canEdit && (
                <>
                  {c.status === 'active' && (
                    <button className="btn-ghost" onClick={() => setStatusFor(c, 'unsubscribed')} disabled={busy}
                      style={{ fontSize: 12, padding: '4px 10px' }}>Unsubscribe</button>
                  )}
                  {c.status === 'unsubscribed' && (
                    <button className="btn-ghost" onClick={() => setStatusFor(c, 'active')} disabled={busy}
                      style={{ fontSize: 12, padding: '4px 10px' }}>Resubscribe</button>
                  )}
                  <button onClick={() => remove(c)} disabled={busy} title="Remove"
                    style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 5 }}>
                    <Trash2 size={15} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {(offset > 0 || rows.length === LIMIT) && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button className="btn-secondary" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>Previous</button>
          <button className="btn-secondary" disabled={rows.length < LIMIT || loading} onClick={() => setOffset(offset + LIMIT)}>Next</button>
        </div>
      )}
    </div>
  )
}

// ── Sender tab ─────────────────────────────────────────────────────────────
function CopyBtn({ text }) {
  const [ok, setOk] = useState(false)
  return (
    <button type="button" className="btn-ghost" style={{ padding: 4 }} aria-label="Copy" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200) } catch { toast({ message: 'Copy failed', kind: 'error' }) }
    }}>{ok ? <CheckCircle2 size={13} /> : <Copy size={13} />}</button>
  )
}

function DomainRecords({ d }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
      <thead><tr>{['Purpose', 'Type', 'Host / name', 'Value'].map((h) => <th key={h} style={{ ...label, textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{h}</th>)}</tr></thead>
      <tbody>
        {d.records.map((r) => (
          <tr key={r.host + r.type}>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)', color: 'var(--text-soft)' }}>{r.purpose}{r.optional ? <span style={muted}> (optional)</span> : ''}</td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)', fontWeight: 700 }}>{r.type}{r.priority ? <span style={muted}> pri {r.priority}</span> : ''}</td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)', fontFamily: 'ui-monospace, Menlo, monospace', wordBreak: 'break-all' }}>{r.host} <CopyBtn text={r.host} /></td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)', fontFamily: 'ui-monospace, Menlo, monospace', wordBreak: 'break-all' }}>{r.value} <CopyBtn text={r.value} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function SenderTab({ profileId, canAdmin }) {
  const api = useApi()
  const [data, setData] = useState(null)
  const [domains, setDomains] = useState([])
  const [form, setForm] = useState({ from_name: '', from_email: '', reply_to_email: '', postal_address: '' })
  const [newDomain, setNewDomain] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const [cfg, dom] = await Promise.all([api(`/api/email/config?profile_id=${profileId}`), api(`/api/email/domains?profile_id=${profileId}`)])
      setData(cfg); setDomains(dom.domains || [])
      const c = cfg.config || {}
      setForm({
        from_name: c.from_name ?? cfg.suggested.from_name ?? '',
        from_email: c.from_email ?? cfg.suggested.from_email ?? '',
        reply_to_email: c.reply_to_email ?? '',
        postal_address: c.postal_address ?? cfg.suggested.postal_address ?? '',
      })
      setError(null)
    } catch (e) { setError(e.message) }
  }, [api, profileId])
  useEffect(() => { load() }, [load])

  const run = async (what, fn) => { setBusy(what); try { await fn() } catch (e) { toast({ message: e.message, kind: 'error' }) } finally { setBusy('') } }
  const saveConfig = () => run('save', async () => { await api('/api/email/config', { method: 'PUT', body: { profile_id: profileId, ...form } }); toast({ kind: 'success', message: 'Sender saved.' }); load() })
  const addDomain = () => run('add', async () => {
    const r = await api('/api/email/domains', { method: 'POST', body: { profile_id: profileId, domain: newDomain } })
    setDomains((d) => [...d, r.domain]); setNewDomain('')
    toast({ kind: 'success', message: 'Domain added. Add the DNS records below, then press Verify.' })
  })
  const verify = (d) => run(`verify:${d.id}`, async () => {
    const r = await api('/api/email/domains?action=verify', { method: 'POST', body: { id: d.id } })
    setDomains((list) => list.map((x) => x.id === d.id ? r.domain : x))
    toast(r.domain.status === 'verified' ? { kind: 'success', message: `${d.domain} is verified.` } : { kind: 'info', message: `${d.domain} is still ${r.domain.status}. DNS can take up to an hour.` })
  })
  const remove = (d) => run(`rm:${d.id}`, async () => {
    const ok = await confirmDialog({ title: `Remove ${d.domain}?`, message: 'Campaigns sending from this domain will fail until you add it back.', confirmText: 'Remove' })
    if (!ok) return
    await api(`/api/email/domains?id=${d.id}`, { method: 'DELETE' })
    setDomains((list) => list.filter((x) => x.id !== d.id))
  })

  if (error) return <div className="card-flat" style={{ padding: 30, textAlign: 'center', color: 'var(--red)' }}>{error} <button className="btn-secondary" onClick={load} style={{ marginLeft: 10 }}><RefreshCw size={13} /> Retry</button></div>
  if (!data) return <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>

  const acct = data.account
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {acct && !acct.error && (
        <div className="card-flat" style={{ padding: 14, ...row, gap: 12, flexWrap: 'wrap' }}>
          <ShieldCheck size={18} style={{ color: acct.productionAccess ? 'var(--green, #2ecc71)' : 'var(--muted)' }} />
          <div style={{ flex: 1, fontSize: 13 }}>
            <strong>{acct.productionAccess ? 'Production sending is on.' : 'Sending is in sandbox mode.'}</strong>{' '}
            <span style={muted}>
              {acct.productionAccess
                ? `Up to ${acct.max24HourSend?.toLocaleString()} messages per day, ${acct.maxSendRate} per second.`
                : 'Until AWS approves production access, only recipient addresses verified in AWS can receive mail. Campaigns to real lists will fail.'}
            </span>
          </div>
        </div>
      )}
      {!data.configured && <div className="card-flat" style={{ padding: 14, color: 'var(--red)', fontSize: 13 }}><AlertCircle size={14} style={{ verticalAlign: '-2px' }} /> The server has no SES credentials yet. Sending is disabled until they are added.</div>}

      <div className="card-flat" style={{ padding: 18, display: 'grid', gap: 12 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15 }}>Who your emails come from</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><div style={label}>From name</div><input className="input" value={form.from_name} disabled={!canAdmin} onChange={(e) => setForm((f) => ({ ...f, from_name: e.target.value }))} /></div>
          <div><div style={label}>From address</div><input className="input" value={form.from_email} disabled={!canAdmin} onChange={(e) => setForm((f) => ({ ...f, from_email: e.target.value }))} />
            <div style={{ ...muted, marginTop: 4 }}>Anything @{data.shared_domain} works right away. Your own domain works once it is verified below.</div></div>
          <div><div style={label}>Reply-to (optional)</div><input className="input" type="email" value={form.reply_to_email} disabled={!canAdmin} placeholder="hello@yourbusiness.com" onChange={(e) => setForm((f) => ({ ...f, reply_to_email: e.target.value }))} /></div>
          <div><div style={label}>Business address (printed in the footer)</div><input className="input" value={form.postal_address} disabled={!canAdmin} placeholder="487 Bay Area Blvd, Houston, TX" onChange={(e) => setForm((f) => ({ ...f, postal_address: e.target.value }))} /></div>
        </div>
        {canAdmin && <div><button className="btn-primary" onClick={saveConfig} disabled={busy !== ''}>{busy === 'save' ? <Loader2 size={14} className="spin" /> : null} Save sender</button></div>}
      </div>

      <div className="card-flat" style={{ padding: 18, display: 'grid', gap: 14 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15 }}>Your own sending domain</div>
          <div style={{ ...muted, marginTop: 4 }}>Send from your business address instead of {data.shared_domain}. Add the domain, copy the DNS records into your registrar (GoDaddy, Namecheap, Cloudflare), then verify.</div>
        </div>
        {canAdmin && (
          <div style={row}>
            <input className="input" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="yourbusiness.com" style={{ maxWidth: 340 }} />
            <button className="btn-secondary" onClick={addDomain} disabled={busy !== '' || !newDomain.trim()}>{busy === 'add' ? <Loader2 size={14} className="spin" /> : <Globe size={14} />} Add domain</button>
          </div>
        )}
        {domains.map((d) => (
          <div key={d.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, display: 'grid', gap: 10 }}>
            <div style={{ ...row, justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <div style={row}>
                <strong style={{ fontFamily: 'var(--font-display)' }}>{d.domain}</strong>
                <span className={`pill ${d.status === 'verified' ? 'pill-success' : d.status === 'failed' ? 'pill-danger' : 'pill-warning'}`}>{d.status}</span>
                {d.status === 'verified' && d.mail_from_status !== 'SUCCESS' && <span style={muted}>bounce domain still {String(d.mail_from_status || 'pending').toLowerCase()}</span>}
              </div>
              <div style={{ ...row, gap: 6 }}>
                {d.status !== 'verified' && <button className="btn-secondary" onClick={() => verify(d)} disabled={busy !== ''}>{busy === `verify:${d.id}` ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Verify</button>}
                {canAdmin && <button className="btn-ghost" onClick={() => remove(d)} disabled={busy !== ''} style={{ color: 'var(--muted)' }}><Trash2 size={14} /></button>}
              </div>
            </div>
            {d.status !== 'verified' && <DomainRecords d={d} />}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function Email() {
  const api = useApi()
  const { session } = useAuth()
  const { selectedProfileId, selectedProfile } = useProfile()
  const [tab, setTab] = useState('campaigns')
  const [campaigns, setCampaigns] = useState([])
  const [tags, setTags] = useState({ tags: [], contacts: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [composing, setComposing] = useState(null)   // null | {} | campaign
  const canAdmin = ['admin', 'owner'].includes(selectedProfile?._role)

  const refresh = useCallback(async () => {
    if (!session || !selectedProfileId) return
    try {
      const [c, t] = await Promise.all([
        api(`/api/email/campaigns?profile_id=${selectedProfileId}`),
        api(`/api/email/campaigns?profile_id=${selectedProfileId}&action=tags`),
      ])
      setCampaigns(c.campaigns || []); setTags({ tags: t.tags || [], contacts: t.contacts || 0 }); setError(null)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [api, session, selectedProfileId])

  useEffect(() => { setLoading(true); refresh() }, [refresh])

  // Poll while something is sending so the counters move.
  const anySending = campaigns.some((c) => c.status === 'sending')
  useEffect(() => {
    if (!anySending) return
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [anySending, refresh])

  const act = async (fn, okMsg) => {
    try { await fn(); if (okMsg) toast({ kind: 'success', message: okMsg }); refresh() } catch (e) { toast({ message: e.message, kind: 'error' }) }
  }
  const onSend = (c) => act(async () => {
    const ok = await confirmDialog({ title: 'Send this campaign now?', message: `"${c.subject}" goes to every matching contact right away. There is no undo once it starts.`, confirmText: 'Send now' })
    if (!ok) return
    const r = await api('/api/email/campaigns?action=send', { method: 'POST', body: { id: c.id } })
    toast({ kind: 'success', message: r.stats?.done ? `Sent to ${r.stats.sent} contacts.` : 'Sending started. It keeps going in the background.' })
  })
  const onCancel = (c) => act(() => api('/api/email/campaigns?action=cancel', { method: 'POST', body: { id: c.id } }), c.status === 'sending' ? 'Stopping. Contacts already sent stay sent.' : 'Back to draft.')
  const onDelete = (c) => act(async () => {
    const ok = await confirmDialog({ title: 'Delete this campaign?', message: `"${c.subject}" and its send history will be removed.`, confirmText: 'Delete' })
    if (!ok) return
    await api(`/api/email/campaigns?id=${c.id}`, { method: 'DELETE' })
  })

  if (!selectedProfileId) {
    return <div className="card-flat fade-up" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Pick a brand profile to manage its email.</div>
  }

  return (
    <>
    <div className="fade-up" style={{ display: 'grid', gap: 16 }}>
      <div style={{ ...row, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ ...row, gap: 4 }}>
          <button className={tab === 'campaigns' ? 'btn-secondary' : 'btn-ghost'} onClick={() => setTab('campaigns')}><Mail size={14} /> Campaigns</button>
          <button className={tab === 'subscribers' ? 'btn-secondary' : 'btn-ghost'} onClick={() => setTab('subscribers')}><Users size={14} /> Subscribers</button>
          <button className={tab === 'sender' ? 'btn-secondary' : 'btn-ghost'} onClick={() => setTab('sender')}><Globe size={14} /> Sender</button>
        </div>
        {tab === 'campaigns' && <button className="btn-primary" onClick={() => setComposing({})}><Plus size={14} /> New campaign</button>}
      </div>

      {tab === 'subscribers' ? <SubscribersTab profileId={selectedProfileId} canEdit={canAdmin} />
        : tab === 'sender' ? <SenderTab profileId={selectedProfileId} canAdmin={canAdmin} /> : loading ? (
        <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
      ) : error ? (
        <div className="card-flat" style={{ padding: 40, textAlign: 'center' }}>
          <AlertCircle size={26} style={{ color: 'var(--red)', marginBottom: 12 }} />
          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 14 }}>{error}</div>
          <button className="btn-secondary" onClick={refresh}><RefreshCw size={13} /> Retry</button>
        </div>
      ) : campaigns.length === 0 ? (
        <div className="card-flat" style={{ padding: 50, textAlign: 'center', color: 'var(--muted)' }}>
          <Mail size={32} style={{ marginBottom: 12 }} />
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--text)', fontSize: 15, marginBottom: 4 }}>No campaigns yet</div>
          <div style={{ fontSize: 13, marginBottom: 16 }}>{tags.contacts ? `${tags.contacts} contacts are ready to hear from you.` : 'Import contacts first, then write your first email.'}</div>
          <button className="btn-primary" onClick={() => setComposing({})}><Plus size={14} /> Write the first one</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {campaigns.map((c) => <CampaignCard key={c.id} c={c} onEdit={setComposing} onSend={onSend} onCancel={onCancel} onDelete={onDelete} />)}
        </div>
      )}

    </div>
    {/* Rendered OUTSIDE the .fade-up wrapper on purpose. That class animates
        transform with `forwards`, and a transformed ancestor becomes the
        containing block for position:fixed, so a modal inside it is clipped
        to the page box instead of filling the viewport. */}
    {composing && <Composer profileId={selectedProfileId} campaign={composing.id ? composing : null} tags={tags} onClose={() => setComposing(null)} onSaved={refresh} />}
    </>
  )
}
