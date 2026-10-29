// Email: campaigns sent through Amazon SES, plus the brand's sender setup.
//
//   Campaigns tab   list, composer (HTML + preview), test send,
//                   send now / schedule, live counters
//   Automations tab linear drip sequences: a trigger tag, then emails with a
//                   wait between them. Each step reuses the composer.
//   Sender tab      from name + address, reply-to, postal address, and the
//                   brand's own sending domains with the DNS records to add
//
// Delivery is server-side (api/email/*). This page never talks to SES.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Mail, Plus, Send, Clock, Pencil, Trash2, Loader2, CheckCircle2, AlertCircle, RefreshCw, Globe, Copy, X, Eye, Code2, ShieldCheck, Ban, Play, Pause, Users, ImagePlus, Zap, KeyRound,
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

// Has this campaign been test-sent since its copy last changed? The server
// gate in api/email/campaigns.js is the one that counts; this mirrors it so
// the buttons can explain themselves instead of just failing.
function testCurrent(c) {
  if (!c?.last_test_sent_at) return false
  if (!c.content_changed_at) return true
  return new Date(c.last_test_sent_at).getTime() >= new Date(c.content_changed_at).getTime()
}

// Put an image where an inbox can fetch it. Two-phase, same endpoint the MCP
// uses: mint a signed URL, then PUT the bytes straight to Supabase storage so
// a big image never has to fit inside the serverless request body.
async function uploadEmailImage({ profileId, token, file }) {
  const r = await fetch('/api/email/assets?mode=init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ profile_id: profileId, content_type: file.type, filename: file.name }),
  })
  const init = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(init.error || `Could not prepare the upload (${r.status})`)
  const put = await fetch(init.signed_url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${init.token}`, 'Content-Type': file.type, 'x-upsert': 'true' },
    body: file,
  })
  if (!put.ok) throw new Error(`Upload failed (${put.status}). Try again.`)
  return init
}

// ── Campaign card ──────────────────────────────────────────────────────────
function CampaignCard({ c, onEdit, onSend, onCancel, onDelete }) {
  const s = STATUS[c.status] || STATUS.draft
  const total = c.total_recipients || 0
  const live = c.status === 'sending'
  // Mirrors the server gate so Send is visibly blocked rather than failing on
  // click. The fix lives in the composer, so point there.
  const tested = testCurrent(c)
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
          {['draft', 'failed'].includes(c.status) && (
            tested
              ? <button className="btn-primary" onClick={() => onSend(c)}><Send size={14} /> Send</button>
              : <button className="btn-primary" onClick={() => onEdit(c)} title="Open it and send yourself a test first">
                  <Send size={14} /> Test to send
                </button>
          )}
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
// `mode` is 'campaign' or 'step'. A step has no audience of its own (the
// automation's trigger tag decides who gets it) and is never sent or
// scheduled by hand, so those controls are hidden rather than left dead.
function Composer({ profileId, campaign, tags, onClose, onSaved, mode = 'campaign' }) {
  const isStep = mode === 'step'
  const api = useApi()
  const { session } = useAuth()
  const [subject, setSubject] = useState(campaign?.subject || '')
  const [preview, setPreview] = useState(campaign?.preview_text || '')
  const [html, setHtml] = useState(campaign?.html_body || '')
  const [audience, setAudience] = useState(Array.isArray(campaign?.tag_filter) ? campaign.tag_filter : [])
  const [id, setId] = useState(campaign?.id || null)
  const [tab, setTab] = useState(campaign?.html_body ? 'preview' : 'write')
  const [previewHtml, setPreviewHtml] = useState('')
  const [senderIssue, setSenderIssue] = useState(null)
  const [busy, setBusy] = useState('')
  const [testTo, setTestTo] = useState('')
  const [schedAt, setSchedAt] = useState(campaign?.scheduled_at ? new Date(campaign.scheduled_at).toISOString().slice(0, 16) : '')
  const [showVars, setShowVars] = useState(false)
  // Test-send state, tracked locally so the gate explains itself as you edit
  // rather than only when the server refuses. Starts from the saved row; a
  // test sets it, and editing the subject / body / preview clears it, exactly
  // as api/email/campaigns.js decides it.
  const [testedAt, setTestedAt] = useState(campaign?.last_test_sent_at || null)
  const [testStale, setTestStale] = useState(campaign ? !testCurrent(campaign) : true)
  const copyRef = useRef({ subject: campaign?.subject || '', html: campaign?.html_body || '', preview: campaign?.preview_text || '' })
  useEffect(() => {
    const base = copyRef.current
    const moved = subject !== base.subject || html !== base.html || (preview || '') !== (base.preview || '')
    if (moved) setTestStale(true)
  }, [subject, html, preview])
  const [uploading, setUploading] = useState(false)
  const [dropping, setDropping] = useState(false)
  const fileRef = useRef(null)
  const bodyRef = useRef(null)
  // The footer's business address lives on the brand, not on the campaign, so
  // the composer reads it to refuse exactly what the API refuses. Stays null
  // while it loads, which keeps the gate quiet rather than flashing an error
  // the moment the composer opens.
  const [postal, setPostal] = useState(null)
  useEffect(() => {
    let alive = true
    api(`/api/email/config?profile_id=${profileId}`)
      .then((r) => { if (alive) setPostal(r.config?.postal_address || '') })
      .catch(() => {})
    return () => { alive = false }
  }, [profileId, api])
  // Recomputed as you type, from the same module the API gates on, so the
  // button state and the server's answer can never disagree.
  const check = useMemo(
    () => validateTemplate({ subject, html, previewText: preview, postalAddress: postal ?? undefined }),
    [subject, html, preview, postal],
  )
  const previewTimer = useRef(null)
  const sendable = check.ok && !testStale

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
    // Rewriting the copy of a scheduled campaign pulls it back to draft, so
    // the booked send is gone. Say so rather than letting the card quietly
    // change status.
    if (saved.unscheduled) {
      setSchedAt('')
      toast({ kind: 'info', message: saved.notice || 'That edit unscheduled the campaign. Test it, then schedule it again.' })
    }
    return saved.campaign
  }

  const run = async (what, fn) => {
    setBusy(what)
    try { await fn() } catch (e) { toast({ message: e.message, kind: 'error' }) } finally { setBusy('') }
  }

  const saveDraft = () => run('save', async () => { await save(); toast({ kind: 'success', message: 'Draft saved.' }); onSaved?.() })

  const sendTest = () => run('test', async () => {
    if (!testTo.trim()) throw new Error('Enter an address for the test.')
    const c = await save()
    const r = await api('/api/email/campaigns?action=test', { method: 'POST', body: { id: c.id, to: testTo.trim() } })
    // The saved row is now what was tested, so the gate is satisfied until
    // the copy moves again.
    copyRef.current = { subject, html, preview }
    setTestedAt(r.last_test_sent_at || new Date().toISOString())
    setTestStale(false)
    onSaved?.()
    toast({ kind: 'success', message: `Test sent to ${testTo.trim()}. Read it before you send this to the list.` })
  })

  // Images have to live at a public URL or they arrive as broken boxes, so
  // the composer uploads and writes the <img> for you. Inserted at the cursor
  // when the HTML tab is focused, appended otherwise.
  const insertImages = (files) => run('image', async () => {
    const list = [...files].filter((f) => f && f.type)
    if (!list.length) return
    setUploading(true)
    try {
      const snippets = []
      for (const f of list) {
        const up = await uploadEmailImage({ profileId, token: session?.access_token, file: f })
        snippets.push(up.img_html || `<a href="${up.public_url}">${f.name}</a>`)
      }
      const block = snippets.join('\n')
      setHtml((cur) => {
        const el = bodyRef.current
        const at = (tab === 'write' && el && typeof el.selectionStart === 'number') ? el.selectionStart : cur.length
        const before = cur.slice(0, at)
        const after = cur.slice(at)
        return `${before}${before && !before.endsWith('\n') ? '\n' : ''}${block}\n${after}`
      })
      toast({ kind: 'success', message: `${list.length === 1 ? 'Image' : `${list.length} images`} uploaded and added to the body.` })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
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
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, margin: 0 }}>{isStep ? 'Edit this email' : id ? 'Edit campaign' : 'New campaign'}</h3>
          <button aria-label="Close" onClick={onClose} className="btn-ghost" style={{ padding: 6 }}><X size={18} /></button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <div><div style={label}>Subject</div><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="This Sunday: the family platter is back" /></div>
          <div><div style={label}>Preview text</div><input className="input" value={preview} onChange={(e) => setPreview(e.target.value)} placeholder="Shown next to the subject in the inbox" /></div>
        </div>

        {!isStep && (
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
        )}

        <div>
          <div style={{ ...row, justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={label}>Body</div>
            <div style={{ ...row, gap: 4 }}>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" multiple hidden
                onChange={(e) => e.target.files?.length && insertImages(e.target.files)} />
              <button type="button" className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy !== ''}
                title="Upload an image and drop it into the body. Email clients cannot show an image that is not hosted, so this uploads it first."
                style={{ padding: '4px 10px', fontSize: 12 }}>
                {uploading ? <Loader2 size={13} className="spin" /> : <ImagePlus size={13} />} Image
              </button>
              <button type="button" className={tab === 'write' ? 'btn-secondary' : 'btn-ghost'} onClick={() => setTab('write')} style={{ padding: '4px 10px', fontSize: 12 }}><Code2 size={13} /> HTML</button>
              <button type="button" className={tab === 'preview' ? 'btn-secondary' : 'btn-ghost'} onClick={() => setTab('preview')} style={{ padding: '4px 10px', fontSize: 12 }}><Eye size={13} /> Preview</button>
            </div>
          </div>
          {tab === 'write' ? (
            <div
              onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDropping(true) } }}
              onDragLeave={() => setDropping(false)}
              onDrop={(e) => {
                if (!e.dataTransfer?.files?.length) return
                e.preventDefault(); setDropping(false); insertImages(e.dataTransfer.files)
              }}
              style={{ position: 'relative', borderRadius: 10, outline: dropping ? '2px dashed var(--red)' : 'none', outlineOffset: 2 }}
            >
              <textarea ref={bodyRef} className="textarea" rows={14} value={html} onChange={(e) => setHtml(e.target.value)} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5 }}
                placeholder={'Paste HTML, or just write plain paragraphs. Use {{first_name}} to personalize.\n\nDrop an image here to upload it and insert it.\n\nThe unsubscribe footer is added automatically.'} />
              {dropping && (
                <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(239,68,68,0.10)', borderRadius: 10, pointerEvents: 'none', fontSize: 13, fontWeight: 700, color: 'var(--red)' }}>
                  Drop to upload and insert
                </div>
              )}
            </div>
          ) : (
            <iframe title="Email preview" sandbox="" srcDoc={previewHtml} style={{ width: '100%', height: 440, border: '1px solid var(--border)', borderRadius: 10, background: '#f5f7fa' }} />
          )}
          {senderIssue && <div style={{ ...row, color: 'var(--red)', fontSize: 12.5, marginTop: 6 }}><AlertCircle size={13} /> {senderIssue}</div>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: isStep ? '1fr' : '1fr 1fr', gap: 12, alignItems: 'end' }}>
          <div>
            <div style={label}>Send a test first <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: 'var(--red)' }}>(required)</span></div>
            <div style={row}>
              <input className="input" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@yourbusiness.com" />
              <button className="btn-secondary" onClick={sendTest} disabled={busy !== ''}>{busy === 'test' ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Test</button>
            </div>
          </div>
          {!isStep && (
          <div>
            <div style={label}>Or schedule</div>
            <div style={row}>
              <input className="input" type="datetime-local" value={schedAt} onChange={(e) => setSchedAt(e.target.value)} />
              <button className="btn-secondary" onClick={schedule} disabled={busy !== '' || !sendable}
                title={testStale ? 'Send yourself a test first' : check.ok ? '' : 'Fix the problems listed below first'}>{busy === 'schedule' ? <Loader2 size={14} className="spin" /> : <Clock size={14} />} Schedule</button>
            </div>
          </div>
          )}
        </div>

        {/* The test-send gate, explained where the decision is made. The
            server refuses send and schedule without a current test; saying so
            here beats a toast after the click. */}
        <div style={{
          display: 'flex', gap: 8, alignItems: 'baseline', padding: '10px 14px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.55,
          background: testStale ? 'rgba(245,158,11,0.10)' : 'rgba(34,197,94,0.10)',
          border: `1px solid ${testStale ? 'var(--amber)' : '#22c55e'}`,
        }}>
          {testStale ? <AlertCircle size={15} style={{ color: 'var(--amber)', flexShrink: 0 }} /> : <CheckCircle2 size={15} style={{ color: '#22c55e', flexShrink: 0 }} />}
          <div>
            {testStale
              ? (testedAt
                ? <>You have edited this since the test on {fmtWhen(testedAt)}. Send another test and read it, then this can go to the list.</>
                : <>Send yourself a test and read it in a real inbox before this can go to the list. It is the only check that catches an image that does not load or a layout that collapses in Gmail.</>)
              : <>Tested {fmtWhen(testedAt)}. Ready to send or schedule.</>}
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
            {isStep ? (
              // A step goes out when the automation reaches it, so saving is
              // the only action here.
              <button className="btn-primary" onClick={saveDraft} disabled={busy !== ''}>{busy === 'save' ? <Loader2 size={14} className="spin" /> : null} Save this email</button>
            ) : (
              <>
                <button className="btn-secondary" onClick={saveDraft} disabled={busy !== ''}>{busy === 'save' ? <Loader2 size={14} className="spin" /> : null} Save draft</button>
                <button className="btn-primary" onClick={sendNow}
                  disabled={busy !== '' || !!senderIssue || !sendable}
                  title={testStale ? 'Send yourself a test first' : check.ok ? '' : 'Fix the problems listed above first'}>
                  {busy === 'send' ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Send now
                </button>
              </>
            )}
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

// ── Automations tab ────────────────────────────────────────────────────────
// A linear sequence: a trigger tag, then emails with a wait before each one.
// Branching is deliberately not here yet. The two things worth understanding
// on this screen are both safety rails rather than features:
//   - every step has to be test-sent before the automation can be switched on
//   - switching on does NOT mail the people already carrying the tag, unless
//     you ask for it on the button that says how many that is
const HUMAN_WAIT = (h) => {
  const n = Number(h) || 0
  if (n === 0) return 'straight away'
  if (n < 24) return `after ${n} hour${n === 1 ? '' : 's'}`
  const d = Math.round((n / 24) * 10) / 10
  return `after ${d} day${d === 1 ? '' : 's'}`
}

function StepRow({ step, index, canEdit, onEdit, onWait, onDelete }) {
  const c = step.campaign
  const tested = c ? testCurrent(c) : false
  return (
    <div className="card-flat" style={{ padding: '10px 12px', display: 'grid', gap: 8 }}>
      <div style={{ ...row, justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ ...row, gap: 10, minWidth: 0 }}>
          <span style={{ ...label, marginBottom: 0, color: 'var(--muted)' }}>{index + 1}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c?.subject || 'No subject yet'}
            </div>
            <div style={muted}>
              Sent {HUMAN_WAIT(step.delay_hours)}
              {c?.sent_count ? ` · ${c.sent_count} sent` : ''}
              {c?.opened_count ? ` · ${c.opened_count} opened` : ''}
              {c?.failed_count ? ` · ${c.failed_count} failed` : ''}
            </div>
          </div>
        </div>
        <div style={{ ...row, gap: 6 }}>
          <span className={tested ? 'pill-success' : 'pill-warning'} style={{ fontSize: 11 }}>
            {tested ? 'tested' : 'needs a test send'}
          </span>
          {canEdit && <button className="btn-ghost" onClick={() => onEdit(step)} title="Edit this email"><Pencil size={14} /></button>}
          {canEdit && <button className="btn-ghost" onClick={() => onDelete(step)} title="Delete this email" style={{ color: 'var(--muted)' }}><Trash2 size={14} /></button>}
        </div>
      </div>
      {canEdit && (
        <div style={{ ...row, gap: 8 }}>
          <span style={muted}>Wait</span>
          <input className="input" type="number" min="0" max="8760" defaultValue={step.delay_hours}
            onBlur={(e) => { const v = Number(e.target.value); if (v !== step.delay_hours) onWait(step, v) }}
            style={{ width: 90, height: 30, fontSize: 12.5 }} />
          <span style={muted}>hours before sending it</span>
        </div>
      )}
    </div>
  )
}

function AutomationsTab({ profileId, tags, canEdit }) {
  const api = useApi()
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState(null)
  const [step, setStep] = useState(null)       // { campaign } open in the composer
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [trigger, setTrigger] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await api(`/api/email/automations?profile_id=${profileId}`)
      setList(r.automations || [])
    } catch (e) { toast({ message: e.message, kind: 'error' }) } finally { setLoading(false) }
  }, [api, profileId])
  useEffect(() => { setLoading(true); load() }, [load])

  const run = async (key, fn, okMsg) => {
    setBusy(key)
    try { await fn(); if (okMsg) toast({ kind: 'success', message: okMsg }); await load() }
    catch (e) { toast({ message: e.message, kind: 'error' }) }
    finally { setBusy('') }
  }

  const taggedCount = (tag) => tags.tags.find((t) => t.tag === tag)?.count || 0

  const create = () => run('create', async () => {
    await api('/api/email/automations', { method: 'POST', body: { profile_id: profileId, name, trigger_tag: trigger } })
    setAdding(false); setName(''); setTrigger('')
  }, 'Automation created. Add its first email.')

  const addStep = (a) => run(`add:${a.id}`, async () => {
    const r = await api('/api/email/automations?action=add-step', { method: 'POST', body: { automation_id: a.id } })
    setStep({ campaign: r.campaign })
  })

  const activate = (a, enrollExisting) => run(`on:${a.id}`, async () => {
    const already = taggedCount(a.trigger_tag)
    const ok = await confirmDialog(enrollExisting ? {
      title: `Mail the ${already} people already on this list?`,
      message: `Everyone tagged ${a.trigger_tag} starts the sequence now, so ${already} contact${already === 1 ? '' : 's'} will begin receiving it within a minute. There is no undo once it starts.`,
      confirmText: `Switch on and mail ${already}`,
    } : {
      title: 'Switch this automation on?',
      message: `From now on, anyone newly tagged ${a.trigger_tag} starts the sequence. The ${already} contact${already === 1 ? '' : 's'} already carrying that tag will not be mailed.`,
      confirmText: 'Switch on',
    })
    if (!ok) return
    const r = await api('/api/email/automations?action=activate', { method: 'POST', body: { id: a.id, enroll_existing: !!enrollExisting } })
    toast({ kind: 'success', message: r.enrolled ? `On. ${r.enrolled} contacts enrolled.` : `On. ${r.skipped} already on the list were left alone.` })
  })

  const pause = (a) => run(`off:${a.id}`, async () => {
    await api('/api/email/automations?action=pause', { method: 'POST', body: { id: a.id } })
  }, 'Paused. Nobody loses their place.')

  const remove = (a) => run(`del:${a.id}`, async () => {
    const ok = await confirmDialog({
      title: 'Delete this automation?',
      message: `"${a.name}", its ${a.steps.length} email${a.steps.length === 1 ? '' : 's'} and their send history are removed. Contacts and tags are untouched.`,
      confirmText: 'Delete',
    })
    if (!ok) return
    await api(`/api/email/automations?id=${a.id}`, { method: 'DELETE' })
  })

  const setWait = (s, hours) => run(`wait:${s.id}`, async () => {
    await api(`/api/email/automations?action=step&id=${s.id}`, { method: 'PATCH', body: { delay_hours: hours } })
  })

  const delStep = (s) => run(`delstep:${s.id}`, async () => {
    const ok = await confirmDialog({
      title: 'Delete this email?',
      message: 'It is removed from the sequence along with its send history. Anyone currently waiting on it finishes the sequence instead.',
      confirmText: 'Delete',
    })
    if (!ok) return
    await api(`/api/email/automations?action=step&id=${s.id}`, { method: 'DELETE' })
  })

  if (loading) return <div className="card-flat" style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={16} className="spin" /> Loading automations</div>

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {step && (
        <Composer
          profileId={profileId}
          campaign={step.campaign}
          tags={tags}
          mode="step"
          onClose={() => { setStep(null); load() }}
          onSaved={() => { setStep(null); load() }}
        />
      )}

      <div style={{ ...row, justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div style={muted}>
          A sequence starts when a contact picks up a tag. Taking the tag off stops it.
        </div>
        {canEdit && <button className="btn-primary" onClick={() => setAdding((v) => !v)}><Plus size={14} /> New automation</button>}
      </div>

      {adding && canEdit && (
        <div className="card-flat" style={{ padding: 14, display: 'grid', gap: 12 }}>
          <div>
            <div style={label}>Name</div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Welcome sequence" />
          </div>
          <div>
            <div style={label}>Starts when a contact is tagged</div>
            {tags.tags.length ? (
              <div style={{ ...row, flexWrap: 'wrap', gap: 6 }}>
                {tags.tags.map((t) => (
                  <button type="button" key={t.tag} className={trigger === t.tag ? 'btn-secondary' : 'btn-ghost'}
                    onClick={() => setTrigger(t.tag)} style={{ padding: '5px 10px', fontSize: 12.5 }}>
                    {t.tag} <span style={muted}>({t.count})</span>
                  </button>
                ))}
              </div>
            ) : (
              <input className="input" value={trigger} onChange={(e) => setTrigger(e.target.value)} placeholder="welcome" />
            )}
            {!!tags.tags.length && (
              <input className="input" value={trigger} onChange={(e) => setTrigger(e.target.value)} placeholder="or type a new tag"
                style={{ marginTop: 8, maxWidth: 260 }} />
            )}
          </div>
          <div style={{ ...row, gap: 8 }}>
            <button className="btn-primary" onClick={create} disabled={busy !== '' || !name.trim() || !trigger.trim()}>
              {busy === 'create' ? <Loader2 size={14} className="spin" /> : null} Create
            </button>
            <button className="btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}

      {!list.length && !adding && (
        <div className="card-flat" style={{ padding: 36, textAlign: 'center', color: 'var(--muted)' }}>
          <Zap size={20} style={{ marginBottom: 8 }} />
          <div>No automations yet. One is enough to start: a welcome email the moment somebody joins a list.</div>
        </div>
      )}

      {list.map((a) => {
        const open = openId === a.id
        const already = taggedCount(a.trigger_tag)
        const stops = a.blockers || []
        const ready = !stops.length
        return (
          <div key={a.id} className="card-flat" style={{ padding: 14, display: 'grid', gap: 10 }}>
            <div style={{ ...row, justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ ...row, gap: 8 }}>
                  <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15 }}>{a.name}</span>
                  <span className={a.status === 'active' ? 'pill-success' : a.status === 'paused' ? 'pill-warning' : 'pill'} style={{ fontSize: 11 }}>{a.status}</span>
                </div>
                <div style={muted}>
                  Starts on <code style={{ background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 4 }}>{a.trigger_tag}</code>
                  {' · '}{a.steps.length} email{a.steps.length === 1 ? '' : 's'}
                  {' · '}{a.counts.active} in progress, {a.counts.done} finished
                  {a.counts.skipped ? `, ${a.counts.skipped} left alone` : ''}
                </div>
              </div>
              <div style={{ ...row, gap: 6 }}>
                <button className="btn-ghost" onClick={() => setOpenId(open ? null : a.id)}>{open ? 'Hide' : 'Emails'}</button>
                {canEdit && a.status === 'active' && (
                  <button className="btn-secondary" onClick={() => pause(a)} disabled={busy !== ''}><Pause size={14} /> Pause</button>
                )}
                {canEdit && a.status !== 'active' && (
                  <button className="btn-primary" onClick={() => activate(a, false)} disabled={busy !== '' || !ready}
                    title={ready ? 'New contacts only' : stops[0].reason}>
                    {busy === `on:${a.id}` ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Switch on
                  </button>
                )}
                {canEdit && <button className="btn-ghost" onClick={() => remove(a)} disabled={busy !== ''} style={{ color: 'var(--muted)' }}><Trash2 size={14} /></button>}
              </div>
            </div>

            {a.last_error && (
              <div style={{ ...row, color: 'var(--red)', fontSize: 12.5 }}><AlertCircle size={13} /> {a.last_error}</div>
            )}

            {a.status !== 'active' && !!stops.length && (
              <div style={{ display: 'grid', gap: 4, fontSize: 12.5, color: 'var(--muted)' }}>
                {stops.map((b, i) => (
                  <div key={i} style={{ ...row, gap: 6, alignItems: 'flex-start' }}>
                    <AlertCircle size={13} style={{ color: 'var(--red)', flexShrink: 0, marginTop: 2 }} />
                    <span>{b.reason}</span>
                  </div>
                ))}
              </div>
            )}

            {open && (
              <div style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                {a.steps.map((s, i) => (
                  <StepRow key={s.id} step={s} index={i} canEdit={canEdit}
                    onEdit={(x) => setStep({ campaign: x.campaign })}
                    onWait={setWait}
                    onDelete={delStep} />
                ))}
                {canEdit && (
                  <div style={{ ...row, gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn-secondary" onClick={() => addStep(a)} disabled={busy !== ''}>
                      {busy === `add:${a.id}` ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} Add an email
                    </button>
                    {a.status !== 'active' && !!a.steps.length && already > 0 && ready && (
                      <button className="btn-ghost" onClick={() => activate(a, true)} disabled={busy !== ''}
                        title="Everyone already carrying the tag starts the sequence now">
                        Switch on and also mail the {already} already on this list
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// Ingest keys. One key writes to one brand's list and nothing else, which is
// what makes it safe to paste into a zap or hand to a client's developer.
// The key is shown exactly once, because only its hash is stored.
function ApiKeysPanel({ profileId, canAdmin }) {
  const api = useApi()
  const [keys, setKeys] = useState([])
  const [pending, setPending] = useState(false)   // migration 0084 not applied
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState(null)        // the one-time reveal
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await api(`/api/email/api-keys?profile_id=${profileId}`)
      setKeys(r.keys || []); setPending(false)
    } catch (e) {
      if (/migration/i.test(e.message || '')) setPending(true)
    }
  }, [api, profileId])
  useEffect(() => { if (canAdmin) load() }, [load, canAdmin])

  if (!canAdmin) return null

  const create = async () => {
    setBusy('create')
    try {
      const r = await api('/api/email/api-keys', { method: 'POST', body: { profile_id: profileId, name } })
      setFresh(r.key); setName(''); load()
    } catch (e) { toast({ kind: 'error', message: e.message }) } finally { setBusy('') }
  }
  const revoke = async (k) => {
    const ok = await confirmDialog({
      title: `Revoke "${k.name}"?`,
      message: 'Anything still sending leads with this key stops working immediately. This cannot be undone, you would issue a new key instead.',
      confirmText: 'Revoke', destructive: true,
    })
    if (!ok) return
    setBusy(`revoke:${k.id}`)
    try { await api(`/api/email/api-keys?id=${k.id}`, { method: 'DELETE' }); load() }
    catch (e) { toast({ kind: 'error', message: e.message }) } finally { setBusy('') }
  }

  const live = keys.filter((k) => k.active)

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div>
        <div style={{ ...row, gap: 8 }}>
          <KeyRound size={15} />
          <strong style={{ fontFamily: 'var(--font-display)' }}>Add leads from anywhere</strong>
        </div>
        <div style={{ ...muted, marginTop: 4 }}>
          A key lets another system put people straight onto this brand&apos;s list: your website,
          a Zapier or Make automation, a Shopify or Calendly webhook. Each key works for this brand only.
          Send a tag with each lead and a matching automation starts their sequence within a minute.
        </div>
      </div>

      {pending ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, ...muted }}>
          Keys need migration 0084 applied to the database first. The code is deployed and waiting.
        </div>
      ) : (
        <>
          {fresh && (
            <div style={{ border: '1px solid var(--accent)', borderRadius: 12, padding: 14, display: 'grid', gap: 8 }}>
              <strong style={{ fontSize: 13 }}>Copy this key now. It cannot be shown again.</strong>
              <div style={{ ...row, gap: 8 }}>
                <code style={{
                  flex: 1, fontSize: 12, padding: '8px 10px', borderRadius: 8,
                  background: 'var(--surface-2)', overflowX: 'auto', whiteSpace: 'nowrap',
                }}>{fresh}</code>
                <button className="btn-secondary" onClick={() => {
                  navigator.clipboard?.writeText(fresh)
                  toast({ kind: 'success', message: 'Key copied.' })
                }}><Copy size={14} /> Copy</button>
                <button className="btn-ghost" onClick={() => setFresh(null)}><X size={14} /></button>
              </div>
              <div style={muted}>
                Only a hash of it is stored, so nobody can read it back later, us included.
                If it is lost or leaks, revoke it and issue another.
              </div>
            </div>
          )}

          <div style={row}>
            <input
              className="input" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="What will use it? e.g. Squarespace footer form"
              style={{ maxWidth: 340 }}
            />
            <button className="btn-secondary" onClick={create} disabled={busy !== '' || !name.trim()}>
              {busy === 'create' ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} Create key
            </button>
          </div>

          {live.map((k) => (
            <div key={k.id} style={{
              ...row, justifyContent: 'space-between', flexWrap: 'wrap',
              border: '1px solid var(--border)', borderRadius: 12, padding: '10px 14px',
            }}>
              <div style={{ display: 'grid', gap: 2 }}>
                <div style={row}>
                  <strong style={{ fontSize: 13 }}>{k.name}</strong>
                  <code style={{ ...muted, fontSize: 11.5 }}>{k.key_prefix}…</code>
                </div>
                <span style={muted}>
                  {k.last_used_at ? `Last used ${new Date(k.last_used_at).toLocaleString()}` : 'Never used yet'}
                </span>
              </div>
              <button className="btn-ghost" onClick={() => revoke(k)} disabled={busy !== ''} style={{ color: 'var(--muted)' }}>
                {busy === `revoke:${k.id}` ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
              </button>
            </div>
          ))}

          {live.length > 0 && (
            <details>
              <summary style={{ ...muted, cursor: 'pointer' }}>How to send a lead</summary>
              <pre style={{
                fontSize: 11.5, background: 'var(--surface-2)', padding: 12, borderRadius: 8,
                overflowX: 'auto', marginTop: 8,
              }}>{`curl -X POST ${window.location.origin}/api/email/subscribe \\
  -H "x-api-key: YOUR_KEY" \\
  -H "content-type: application/json" \\
  -d '{"email":"jane@example.com","name":"Jane","tags":["newsletter"]}'`}</pre>
              <div style={{ ...muted, marginTop: 6 }}>
                Keep the key on a server, not in a web page: anyone who can read the page can read the key.
                Website forms built on the Forms or Landing Pages tabs need no key and are tagged automatically.
              </div>
            </details>
          )}
        </>
      )}
    </div>
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

      {canAdmin && (
        <div className="card" style={{ padding: 18 }}>
          <ApiKeysPanel profileId={profileId} canAdmin={canAdmin} />
        </div>
      )}
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function Email() {
  const api = useApi()
  const { session } = useAuth()
  const { selectedProfileId, selectedProfile, setSelectedProfileId } = useProfile()
  const [params, setParams] = useSearchParams()
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

  // Deep link: /email?campaign=<id> opens that campaign for review. This is
  // what every email MCP tool hands back as review_url, and what the
  // calendar's campaign cards link to, so an id in a chat window becomes
  // something a human can actually read before approving.
  //
  // The campaign may belong to a brand other than the one selected, so switch
  // first and open the composer only once the page is showing that brand:
  // the composer asks the server for the preview and the audience counts per
  // profile, and opening it early would render them against the wrong one.
  const [pending, setPending] = useState(null)
  const wantedId = params.get('campaign')
  useEffect(() => {
    if (!wantedId || !session) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await api(`/api/email/campaigns?id=${encodeURIComponent(wantedId)}`)
        if (cancelled || !r.campaign) return
        setPending(r.campaign)
        if (r.campaign.profile_id !== selectedProfileId) setSelectedProfileId(r.campaign.profile_id)
      } catch (e) {
        toast({ kind: 'error', message: `Could not open that campaign: ${e.message}` })
      } finally {
        // Clear the parameter either way, so a refresh does not reopen it and
        // a failure does not retry forever.
        if (!cancelled) {
          const next = new URLSearchParams(params)
          next.delete('campaign')
          setParams(next, { replace: true })
        }
      }
    })()
    return () => { cancelled = true }
    // Deliberately keyed on the id alone: re-running on selectedProfileId
    // would refetch during the brand switch this effect just triggered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedId, session])

  useEffect(() => {
    if (!pending) return
    if (pending.profile_id !== selectedProfileId) return
    setTab('campaigns')
    setComposing(pending)
    setPending(null)
  }, [pending, selectedProfileId])

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
          <button className={tab === 'automations' ? 'btn-secondary' : 'btn-ghost'} onClick={() => setTab('automations')}><Zap size={14} /> Automations</button>
          <button className={tab === 'sender' ? 'btn-secondary' : 'btn-ghost'} onClick={() => setTab('sender')}><Globe size={14} /> Sender</button>
        </div>
        {tab === 'campaigns' && <button className="btn-primary" onClick={() => setComposing({})}><Plus size={14} /> New campaign</button>}
      </div>

      {tab === 'subscribers' ? <SubscribersTab profileId={selectedProfileId} canEdit={canAdmin} />
        : tab === 'automations' ? <AutomationsTab profileId={selectedProfileId} tags={tags} canEdit={canAdmin} />
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
