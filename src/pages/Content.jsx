import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Sparkles, Library, Calendar, FileEdit, ClipboardCheck, X, Wand2,
  Check, Trash2, Edit3, Send, Eye, AlertCircle, Link2, Plus, ExternalLink,
  Image as ImageIcon, RotateCcw, Loader2, Copy,
} from 'lucide-react'
import BulkUploadView from '../components/BulkUploadView.jsx'
import GenerateMonthModal from '../components/GenerateMonthModal.jsx'
import MediaLightbox from '../components/MediaLightbox.jsx'
import { toast } from '../components/Toast.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { useCredits } from '../context/CreditsContext.jsx'
import TrialGate from '../components/TrialGate.jsx'

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

// Trim a hashtags string to at most `max` tags. Handles "#a #b", "a, b",
// or mixed input; always returns space-separated "#tag" tokens.
function limitHashtags(raw, max = 5) {
  if (!raw) return ''
  const hashed = String(raw).match(/#[\p{L}\p{N}_]+/gu)
  const tokens = (hashed && hashed.length)
    ? hashed
    : String(raw).split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith('#') ? t : '#' + t))
  return tokens.slice(0, max).join(' ')
}

// ── Detail modal ──────────────────────────────────────────────────────────
function ItemDetail({ item, onClose, onUpdate }) {
  const { session } = useAuth()
  const [scheduledAt, setScheduledAt] = useState(isoToLocalDatetimeInput(item.scheduled_datetime))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Inline success banner — shown briefly after approve so the user
  // gets a clear "Scheduled to TikTok, Instagram for Wed May 21 at
  // 9:00 AM" confirmation before the modal stays open or closes.
  const [success, setSuccess] = useState(null)
  // Editable caption + hashtags (edit before delivery). Drafts start from
  // the row; Save PATCHes them — which also re-pushes to the scheduled
  // Upload-Post job so the edited copy is what actually publishes.
  const [captionDraft, setCaptionDraft] = useState(item.caption || '')
  const [hashtagsDraft, setHashtagsDraft] = useState(item.hashtags || '')
  const [savingCaption, setSavingCaption] = useState(false)
  const captionDirty = captionDraft !== (item.caption || '') || hashtagsDraft !== (item.hashtags || '')
  const saveCaption = async () => {
    setSavingCaption(true); setError(null); setSuccess(null)
    try {
      const r = await fetch(`/api/content?id=${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ caption: captionDraft, hashtags: limitHashtags(hashtagsDraft, 5) }),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b?.error || 'Could not save the caption')
      setSuccess(b.upload_post_resynced
        ? 'Saved and pushed to the scheduled post — the edited caption is what will publish.'
        : 'Caption saved.')
      onUpdate()
    } catch (e) { setError(e.message) } finally { setSavingCaption(false) }
  }
  // Copy-to-clipboard feedback for the caption field (mobile-friendly).
  const [copied, setCopied] = useState(false)
  const copyCaption = async () => {
    const text = captionDraft || ''
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Fallback for older / non-secure contexts: temp textarea + execCommand.
      try {
        const ta = document.createElement('textarea')
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
        document.body.appendChild(ta); ta.focus(); ta.select()
        document.execCommand('copy'); document.body.removeChild(ta)
      } catch { /* give up silently */ }
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const action = async (verb, body = {}) => {
    setBusy(true); setError(null); setSuccess(null)
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
      // Build a human-readable success line for approve so the user
      // sees exactly what happened. /api/content returns a `scheduled`
      // payload on approve: { scheduled_datetime, platforms, uploadpost_request_id }.
      if (verb === 'approve') {
        const respBody = await r.json().catch(() => ({}))
        const sched = respBody?.scheduled
        if (sched?.scheduled_datetime) {
          const when = new Date(sched.scheduled_datetime).toLocaleString(undefined, {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
          })
          const plats = Array.isArray(sched.platforms) && sched.platforms.length
            ? sched.platforms.join(', ')
            : 'your selected platforms'
          setSuccess(`Scheduled to ${plats} for ${when}.`)
        } else {
          setSuccess('Approved.')
        }
      } else if (verb === 'reject') {
        setSuccess('Rejected. The draft is back in your queue.')
      }
      onUpdate()
      if (verb === 'delete') onClose()
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const pill = STATUS_PILL[item.status] || STATUS_PILL.draft
  // When the post has media (video / image / carousel), lay the drawer out
  // in two columns — media on the left, caption + schedule on the right — so
  // a tall 9:16 clip sits beside the text instead of shoving it off-screen.
  // Text-only posts have nothing to preview, so they stay single-column.
  const hasMedia = item.media_type !== 'text' && (
    (Array.isArray(item.media_urls) && item.media_urls.filter(Boolean).length > 0) || !!item.cover_image_url
  )

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

        <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* Left column — media preview (only when there's something to show). */}
          {hasMedia && (
            <div style={{ flex: '0 0 240px', width: 240, maxWidth: '100%', position: 'sticky', top: 0 }}>
              <MediaPreviewBlock item={item} />
            </div>
          )}

          {/* Right column — caption, body, schedule. Fills the rest; for
              text-only posts (no left column) it spans the full width. */}
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            {/* Caption is the only thing that actually gets posted, so it's
                the focus here: a tap-to-select field with a big Copy button
                that's easy to hit on mobile. */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ flex: 1, fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Caption</div>
                <button
                  onClick={copyCaption}
                  disabled={!captionDraft}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '7px 12px', fontSize: 12.5, fontWeight: 700,
                    borderRadius: 8, cursor: captionDraft ? 'pointer' : 'not-allowed',
                    border: '1px solid var(--border)',
                    background: copied ? 'rgba(46,204,113,0.15)' : 'var(--surface-3, var(--surface-2))',
                    color: copied ? '#2ecc71' : 'var(--text)',
                    opacity: captionDraft ? 1 : 0.5,
                  }}>
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  onClick={saveCaption}
                  disabled={!captionDirty || savingCaption}
                  className="btn-primary"
                  style={{ padding: '7px 14px', fontSize: 12.5, opacity: (!captionDirty || savingCaption) ? 0.5 : 1 }}>
                  {savingCaption ? <span className="spinner" /> : <Check size={14} />} Save
                </button>
              </div>
              <textarea
                value={captionDraft}
                onChange={(e) => setCaptionDraft(e.target.value)}
                placeholder="Write the caption…"
                rows={Math.min(12, Math.max(4, String(captionDraft || '').split('\n').length + 1))}
                style={{
                  width: '100%', resize: 'vertical', boxSizing: 'border-box',
                  fontSize: 13.5, lineHeight: 1.6, color: 'var(--text)',
                  padding: 12, borderRadius: 10,
                  border: `1px solid ${captionDirty ? 'var(--red)' : 'var(--border)'}`,
                  background: 'var(--surface-2)', fontFamily: 'inherit',
                }}
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>Hashtags <span style={{ textTransform: 'none', fontWeight: 500 }}>(max 5)</span></div>
              <input
                className="input"
                value={hashtagsDraft}
                onChange={(e) => setHashtagsDraft(e.target.value)}
                placeholder="#tag1 #tag2 …"
                style={{ width: '100%', boxSizing: 'border-box', color: 'var(--red)', border: `1px solid ${hashtagsDraft !== (item.hashtags || '') ? 'var(--red)' : 'var(--border)'}` }}
              />
            </div>

            {(item.platforms || []).includes('tiktok') && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
                  TikTok posting
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[
                    { v: null, label: 'Brand default' },
                    { v: true, label: 'Direct to feed' },
                    { v: false, label: 'Draft (inbox)' },
                  ].map((o) => (
                    <button key={String(o.v)} type="button" onClick={() => setTtOverride(o.v)} style={{
                      padding: '6px 12px', borderRadius: 999, cursor: 'pointer', fontSize: 12, fontWeight: 600,
                      border: `1px solid ${ttOverride === o.v ? 'var(--red)' : 'var(--border)'}`,
                      background: ttOverride === o.v ? 'rgba(239,68,68,0.12)' : 'var(--surface-2)',
                      color: ttOverride === o.v ? 'var(--red)' : 'var(--text)',
                    }}>{o.label}</button>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
                  Overrides the brand setting for this post only. Hit Save, then it applies when the post is scheduled or rescheduled.
                </div>
              </div>
            )}

            <div style={{ marginTop: 4, padding: 14, background: 'var(--surface-2)', borderRadius: 10, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>Schedule</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="input"
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button className="btn-primary" onClick={() => action('schedule', { scheduled_datetime: new Date(scheduledAt).toISOString() })} disabled={busy || !scheduledAt}>
                  <Send size={13} /> Schedule
                </button>
              </div>
            </div>
          </div>
        </div>

        <CoverImageSection item={item} onUpdate={onUpdate} />

        {error && <div style={{ marginTop: 14, background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13 }}>{error}</div>}
        {success && (
          <div style={{
            marginTop: 14,
            background: 'rgba(46,204,113,0.12)',
            color: '#2ecc71',
            padding: '10px 14px',
            borderRadius: 10,
            fontSize: 13,
            border: '1px solid rgba(46,204,113,0.35)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <Check size={14} /> {success}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <button className="btn-ghost" onClick={() => action('delete')} disabled={busy}>
            <Trash2 size={13} /> Delete
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Media preview block ───────────────────────────────────────────────────
// Shows what the post is going to ship with. For videos: a playable
// preview sized to the video's OWN aspect ratio so the user can scrub
// the actual upload (not just the still-frame they see on the calendar).
// For images / carousels: a strip of thumbs. If a custom IG cover is
// set, it renders side-by-side with the source so the user can compare
// what IG will show vs what the source video frames look like. Skipped
// entirely for text-only posts (nothing to preview).

// Video that adapts its frame to the file's real dimensions. Starts at
// 9:16 (the most common upload) to avoid a layout jump, then snaps to
// the true ratio once metadata loads. objectFit 'contain' guarantees no
// frame is ever cropped even before the ratio is known — a 3:4 or 1:1
// upload previews exactly as shot instead of being center-cropped into
// a 9:16 window.
function AdaptiveVideo({ src }) {
  const [ratio, setRatio] = useState('9 / 16')
  return (
    <video
      src={src}
      controls
      playsInline
      preload="metadata"
      onLoadedMetadata={(e) => {
        const { videoWidth: w, videoHeight: h } = e.currentTarget
        if (w > 0 && h > 0) setRatio(`${w} / ${h}`)
      }}
      style={{
        width: '100%', aspectRatio: ratio,
        borderRadius: 8, background: '#000',
        border: '1px solid var(--border)',
        objectFit: 'contain',
      }}
    />
  )
}
function MediaPreviewBlock({ item }) {
  const isVideo = item.media_type === 'video'
  const isText  = item.media_type === 'text'
  const urls = Array.isArray(item.media_urls) ? item.media_urls.filter(Boolean) : []
  const cover = item.cover_image_url || null
  // Click a slide → open the fullscreen scroller (all slides).
  const [lightbox, setLightbox] = useState(null) // start index, or null
  if (isText) return null
  if (!urls.length && !cover) return null

  return (
    <div style={{ marginBottom: 14 }}>
      {lightbox !== null && (
        <MediaLightbox images={urls} startIndex={lightbox} title={item.title} onClose={() => setLightbox(null)} />
      )}
      <div style={{ fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Eye size={11} /> Media preview{urls.length > 1 ? ` · ${urls.length} slides` : ''}
      </div>

      <div style={{
        display: 'flex', gap: 10, flexWrap: 'wrap',
        padding: 12, borderRadius: 10,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
      }}>
        {/* Prefer the cover-embedded version of the video for the
            preview — that's the actual asset published on non-IG
            platforms (cover intro + source content) and the one the
            user wants to confirm before approving the post. Falls
            back to the raw upload when no embed has been built yet. */}
        {isVideo && (urls[0] || item.media_url_with_cover) && (() => {
          const playable = item.media_url_with_cover || urls[0]
          const isEmbedded = !!item.media_url_with_cover
          return (
            // Fills the media column (ItemDetail lays this out beside the
            // caption / schedule as a left column).
            <div style={{ flex: '1 1 100%', minWidth: 0 }}>
              <div style={{ fontSize: 10, color: isEmbedded ? '#0ea5e9' : 'var(--muted)', marginBottom: 4, fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                {isEmbedded ? 'Video (with cover intro)' : 'Video'}
              </div>
              <AdaptiveVideo src={playable} />
            </div>
          )
        })()}

        {cover && (
          <div style={{ flex: '0 0 140px', width: 140 }}>
            <div style={{ fontSize: 10, color: '#0ea5e9', marginBottom: 4, fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Instagram cover
            </div>
            <img
              src={cover}
              alt="Instagram cover"
              style={{
                width: '100%', aspectRatio: '9 / 16',
                borderRadius: 8, objectFit: 'cover',
                background: '#000', border: '1px solid var(--border)',
              }}
            />
          </div>
        )}

        {!isVideo && !cover && urls.length > 0 && (
          // Image / carousel — show a strip of thumbs.
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: 6, width: '100%' }}>
            {urls.slice(0, 12).map((u, i) => (
              <img
                key={u + '@' + i}
                src={u}
                alt={`slide ${i + 1}`}
                onClick={() => setLightbox(i)}
                title="Click to enlarge"
                style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 6, background: '#000', border: '1px solid var(--border)', cursor: 'zoom-in' }}
              />
            ))}
          </div>
        )}

        {!isVideo && cover && urls.length > 0 && (
          // Image post WITH a custom cover — also show the source images
          // so the user can compare cover vs slides at a glance.
          <div style={{ flex: '1 1 220px', minWidth: 220 }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 4, fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              {urls.length > 1 ? `Slides (${urls.length})` : 'Source image'}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(60px, 1fr))', gap: 4 }}>
              {urls.slice(0, 8).map((u, i) => (
                <img
                  key={u + '@' + i}
                  src={u}
                  alt={`slide ${i + 1}`}
                  onClick={() => setLightbox(i)}
                  title="Click to enlarge"
                  style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 4, background: '#000', border: '1px solid var(--border)', cursor: 'zoom-in' }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Cover image section ───────────────────────────────────────────────────
// Lets the user generate an Instagram cover for this post by feeding
// the brand's saved cover template through gpt-image-2-image-to-image
// with a "swap the title for X" prompt. Preview before commit, regenerate
// with the same prompt, or add per-render edits ("make the headline 20%
// bigger", "swap the orange for red", etc.) and regenerate. Each
// generation burns ~4,000 ai tokens via withCreditReservation.
function CoverImageSection({ item, onUpdate }) {
  const { session } = useAuth()
  // Current persisted cover on the row — what's saved + sent to Upload-Post.
  const savedCover = item.cover_image_url || null
  // Preview state — what's been generated this session but not yet
  // committed. Distinguished from savedCover so the user can iterate
  // freely; only "Use this cover" persists.
  const [previewUrl, setPreviewUrl] = useState(null)
  const [taskId, setTaskId] = useState(null)
  const [status, setStatus] = useState('idle')  // idle | submitting | polling | done | failed
  const [error, setError] = useState(null)
  const [editInstructions, setEditInstructions] = useState('')
  const [committing, setCommitting] = useState(false)
  // Holds the polling timer so we can cancel cleanly on unmount /
  // re-generate.
  const pollRef = useRef(null)

  // Stop polling when this drawer closes or the user fires a fresh
  // generation (replaces the previous taskId).
  useEffect(() => {
    return () => { if (pollRef.current) clearTimeout(pollRef.current) }
  }, [])

  const start = async () => {
    setError(null)
    setStatus('submitting')
    setPreviewUrl(null)
    try {
      const r = await fetch('/api/content/generate-cover?action=start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          script_id: item.id,
          edit_instructions: editInstructions.trim() || undefined,
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.error || 'Cover generation failed')
      setTaskId(body.taskId)
      setStatus('polling')
      pollOnce(body.taskId)
    } catch (e) {
      setStatus('failed')
      setError(e.message)
    }
  }

  const pollOnce = (tid) => {
    if (!tid) return
    if (pollRef.current) clearTimeout(pollRef.current)
    pollRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/images/status?taskId=${encodeURIComponent(tid)}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body?.error || `Status check failed (${r.status})`)
        if (body.state === 'success' && Array.isArray(body.images) && body.images.length) {
          const url = body.images[0]?.url || body.images[0]
          setPreviewUrl(url)
          setStatus('done')
          return
        }
        if (body.state === 'failed') {
          setError(body.error || 'Generation failed')
          setStatus('failed')
          return
        }
        // Still pending — keep polling.
        pollOnce(tid)
      } catch (e) {
        setError(e.message)
        setStatus('failed')
      }
    }, 4000)
  }

  const commit = async (url) => {
    setCommitting(true)
    setError(null)
    try {
      const r = await fetch('/api/content/generate-cover?action=commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ script_id: item.id, image_url: url }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.error || 'Save failed')
      setPreviewUrl(null)
      setTaskId(null)
      setStatus('idle')
      onUpdate?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setCommitting(false)
    }
  }

  const clearSaved = async () => {
    setCommitting(true)
    setError(null)
    try {
      const r = await fetch(`/api/content?id=${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ cover_image_url: null }),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error(b?.error || 'Clear failed')
      }
      onUpdate?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setCommitting(false)
    }
  }

  const busy = status === 'submitting' || status === 'polling'
  const showLabel = previewUrl ? 'Preview' : (savedCover ? 'Current cover' : 'No cover yet')

  return (
    <div style={{ marginTop: 18, padding: 14, background: 'var(--surface-2)', borderRadius: 10, border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
        <ImageIcon size={11} /> Instagram cover
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 14, alignItems: 'flex-start' }}>
        {/* Preview tile — 9:16 to match the actual cover output */}
        <div style={{
          width: 120, aspectRatio: '9 / 16',
          background: '#000', borderRadius: 8,
          border: '1px solid var(--border)',
          display: 'grid', placeItems: 'center', overflow: 'hidden',
          position: 'relative',
        }}>
          {(previewUrl || savedCover) ? (
            <img src={previewUrl || savedCover} alt="cover" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : busy ? (
            <Loader2 size={20} className="spin" style={{ color: 'var(--amber)' }} />
          ) : (
            <ImageIcon size={26} style={{ color: 'var(--muted)' }} />
          )}
          <div style={{
            position: 'absolute', top: 6, left: 6,
            fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 999,
            background: 'rgba(0,0,0,0.6)', color: '#fff',
            letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>{showLabel}</div>
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            className="input"
            value={editInstructions}
            onChange={(e) => setEditInstructions(e.target.value)}
            placeholder={`Optional edits for this render (e.g. "make the headline bigger" or "swap the orange for green"). Empty = just swap the title to this post's title.`}
            rows={2}
            style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: 12 }}
          />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              className="btn-primary"
              onClick={start}
              disabled={busy || committing}
              style={{ fontSize: 12, padding: '6px 12px' }}
            >
              {busy ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />}
              {previewUrl || savedCover ? 'Regenerate' : 'Generate cover'}
            </button>
            {previewUrl && (
              <button
                className="btn-primary"
                onClick={() => commit(previewUrl)}
                disabled={committing}
                style={{ fontSize: 12, padding: '6px 12px', background: 'linear-gradient(135deg, #2ecc71, #16a34a)' }}
              >
                {committing ? <Loader2 size={12} className="spin" /> : <Check size={12} />} Use this cover
              </button>
            )}
            {previewUrl && (
              <button
                className="btn-ghost"
                onClick={() => { setPreviewUrl(null); setStatus('idle') }}
                disabled={committing}
                style={{ fontSize: 12, padding: '6px 12px' }}
              ><RotateCcw size={12} /> Discard</button>
            )}
            {savedCover && !previewUrl && (
              <button
                className="btn-ghost"
                onClick={clearSaved}
                disabled={committing}
                style={{ fontSize: 12, padding: '6px 12px', color: 'var(--muted)' }}
              ><Trash2 size={12} /> Remove cover</button>
            )}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.4 }}>
            Uses your brand's saved cover template. ~4,000 ai tokens per generation. Cover only applies to Instagram on submit.
          </div>
          {status === 'polling' && (
            <div style={{ fontSize: 11, color: 'var(--amber)' }}>Generating cover… typically 20–60 seconds.</div>
          )}
          {error && (
            <div style={{ fontSize: 11.5, color: 'var(--red)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <AlertCircle size={11} /> {error}
            </div>
          )}
        </div>
      </div>

      {/* Cover-as-intro embed — only visible for video posts that have
          a saved cover. ffmpeg work on the Fly worker prepends the
          cover as a 1s still segment at the start of the video so
          TikTok / YouTube Shorts / FB Reels / Threads pick it up as
          the start-frame thumbnail. IG keeps using its native cover. */}
      {item.media_type === 'video' && savedCover && (
        <EmbedCoverIntroBlock item={item} onUpdate={onUpdate} />
      )}
    </div>
  )
}

// ── Cover-as-intro embed block ────────────────────────────────────────────
// Shows the toggle (embed_cover_intro on/off) + Embed button + status.
// Lives inside the CoverImageSection card so users see it as a related
// next step after generating a cover.
function EmbedCoverIntroBlock({ item, onUpdate }) {
  const { session } = useAuth()
  const [enabled, setEnabled] = useState(item.embed_cover_intro !== false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const hasEmbedded = !!item.media_url_with_cover

  const toggle = async (next) => {
    setEnabled(next)
    setError(null)
    // Persist the toggle independently — the cover-embedded URL is
    // generated on demand, but the toggle dictates whether to USE it
    // at submission time. PATCH is cheap.
    try {
      await fetch(`/api/content?id=${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ embed_cover_intro: next }),
      })
      onUpdate?.()
    } catch {}
  }

  const runEmbed = async () => {
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/videos/prepend-cover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ script_id: item.id }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.error || 'Embed failed')
      onUpdate?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{
      marginTop: 12, padding: 10, borderRadius: 8,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => toggle(e.target.checked)}
            style={{ accentColor: '#0ea5e9' }}
          />
          <span style={{ color: 'var(--text)' }}>Embed cover as half-second intro for TikTok / YouTube / FB / Threads</span>
        </label>
        <div style={{ flex: 1 }} />
        {hasEmbedded ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 999,
            background: 'rgba(46,204,113,0.16)', color: '#2ecc71',
            letterSpacing: '0.04em', textTransform: 'uppercase',
          }}><Check size={10} /> Embedded</span>
        ) : null}
        <button
          className="btn-primary"
          onClick={runEmbed}
          disabled={busy}
          style={{ fontSize: 11.5, padding: '5px 10px' }}
          title="Build a new version of the video with the cover as a half-second intro card"
        >
          {busy ? <Loader2 size={11} className="spin" /> : <RotateCcw size={11} />}
          {hasEmbedded ? 'Re-embed' : 'Embed now'}
        </button>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.4 }}>
        Builds a new version of the video with the cover as a half-second intro card (~10–30 seconds, no AI tokens). The original video stays untouched; the new one is used automatically for non-Instagram platforms at scheduling time.
      </div>
      {busy && (
        <div style={{ fontSize: 11, color: 'var(--amber)', marginTop: 4 }}>
          Building intro card… typically 10–30 seconds.
        </div>
      )}
      {error && (
        <div style={{ fontSize: 11.5, color: 'var(--red)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
          <AlertCircle size={11} /> {error}
        </div>
      )}
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

// ── Calendar view ─────────────────────────────────────────────────────────
// Redesigned from a compact day list into a richer card-grid:
//   • Heatmap header up top — visual density per day, click a day to
//     jump-scroll to it.
//   • One post-card per scheduled item, color-bordered by post kind.
//   • Empty days render an understated placeholder so you can still
//     see your open inventory at a glance.
//   • Drag a card onto another day to reschedule — the new ISO is
//     resolved against the destination day at the same time of day,
//     PATCH'd via the existing /api/content endpoint (which auto-
//     resyncs the Upload-Post job behind the scenes).
function CalendarView({ items, onOpen, token, onChange, profileId }) {
  // Monthly-generation modal. Lives here (not on the parent) so a
  // toolbar button on the calendar header can open it; the modal
  // handles its own multi-step flow + chunked /generate-month calls.
  const [showGenerate, setShowGenerate] = useState(false)
  // viewMonth = first day of the month the calendar is currently
  // showing. Start at today's month; prev / next buttons step it ±1.
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(1)
    return d
  })

  // Build the full month grid — Sunday-aligned, 5 or 6 rows of 7 days.
  // Days from prior / next month are included so the grid lines up
  // (greyed in the render layer).
  const days = useMemo(() => {
    const firstOfMonth = new Date(viewMonth)
    firstOfMonth.setDate(1)
    firstOfMonth.setHours(0, 0, 0, 0)
    const gridStart = new Date(firstOfMonth)
    gridStart.setDate(1 - firstOfMonth.getDay())   // back up to Sunday
    const lastOfMonth = new Date(firstOfMonth)
    lastOfMonth.setMonth(firstOfMonth.getMonth() + 1)
    lastOfMonth.setDate(0)                          // end of current month
    const gridEnd = new Date(lastOfMonth)
    gridEnd.setDate(lastOfMonth.getDate() + (6 - lastOfMonth.getDay()))  // forward to Saturday
    const out = []
    const cursor = new Date(gridStart)
    while (cursor <= gridEnd) {
      out.push(new Date(cursor))
      cursor.setDate(cursor.getDate() + 1)
    }
    return out
  }, [viewMonth])

  const stepMonth = (delta) => {
    const d = new Date(viewMonth)
    d.setMonth(d.getMonth() + delta)
    setViewMonth(d)
  }
  const goToday = () => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(1)
    setViewMonth(d)
  }

  // Optimistic overrides keyed by content id — a dropped post appears /
  // moves instantly without a full re-fetch. Declared before byDay because
  // the memo reads it.
  const [localItems, setLocalItems] = useState([])

  // Bucket items by local YYYY-MM-DD so calendar slots map correctly
  // against the user's timezone (toISOString().slice(0,10) is UTC, which
  // shifts items into the wrong day for users east of UTC).
  const byDay = useMemo(() => {
    const m = new Map()
    const keyOf = (date) => {
      const d = new Date(date)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    // Merge optimistic overrides over the server items (same id → local
    // wins) so a just-dropped post shows at its new time without a refetch.
    const byId = new Map()
    for (const it of items) byId.set(it.id, it)
    for (const it of localItems) byId.set(it.id, it)
    for (const it of byId.values()) {
      if (!it.scheduled_datetime) continue
      const k = keyOf(it.scheduled_datetime)
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(it)
    }
    // Sort each day's items by time so the column reads top→bottom.
    for (const arr of m.values()) {
      arr.sort((a, b) => new Date(a.scheduled_datetime) - new Date(b.scheduled_datetime))
    }
    return m
  }, [items, localItems])

  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const todayKey = dayKey(new Date())

  // Drag state — we hold the dragging item id while it's in flight so
  // hover styling on drop targets shows up. dragKind distinguishes a
  // calendar reschedule (already-scheduled post moving days) from a
  // backlog item being dropped onto an open slot.
  const [dragId, setDragId] = useState(null)
  const [dragKind, setDragKind] = useState(null) // 'calendar' | 'backlog' | null
  const dragItemRef = useRef(null)
  // The specific slot the cursor is over, so only THAT slot glows (lets
  // you aim any slot directly instead of filling top-down).
  const [hoverSlot, setHoverSlot] = useState(null)

  // Backlog: unscheduled ready-to-post rows for this brand. Refreshed
  // whenever the calendar items change (so a just-scheduled post leaves
  // the backlog and appears on the grid).
  const [backlog, setBacklog] = useState([])
  // Which backlog card the cursor is over → reveals its delete button.
  const [hoverBacklogId, setHoverBacklogId] = useState(null)
  // Delete an unscheduled post straight from the queue.
  const deleteFromBacklog = async (it) => {
    // Optimistic: pull it immediately, restore on failure.
    setBacklog((arr) => arr.filter((x) => x.id !== it.id))
    try {
      const r = await fetch(`/api/content?id=${it.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || 'Could not delete')
      toast({ kind: 'success', message: `Deleted “${it.title || 'post'}” from the queue.` })
    } catch (err) {
      setBacklog((arr) => [it, ...arr.filter((x) => x.id !== it.id)])
      toast({ kind: 'error', message: err.message })
    }
  }
  useEffect(() => {
    if (!profileId || !token) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(`/api/content?profile_id=${profileId}&filter=unscheduled`, { headers: { Authorization: `Bearer ${token}` } })
        const b = await r.json()
        if (cancelled || !r.ok) return
        // Only postable rows: has media, or a text-only post.
        setBacklog((b.items || []).filter((it) => (Array.isArray(it.media_urls) && it.media_urls.length) || it.media_type === 'text'))
      } catch { /* keep */ }
    })()
    return () => { cancelled = true }
  }, [profileId, token, items])

  // Brand posting schedule (days + times + tz) → drives the open slots.
  const [sched, setSched] = useState(null)
  useEffect(() => {
    if (!profileId || !token) return
    let cancelled = false
    fetch('/api/profiles', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { profiles: [] }))
      .then((b) => {
        if (cancelled) return
        const p = (b.profiles || []).find((x) => x.id === profileId)
        if (p) setSched({
          days: Array.isArray(p.posting_schedule?.days) ? p.posting_schedule.days : [1, 2, 3, 4, 5],
          times: (Array.isArray(p.posting_schedule?.times) && p.posting_schedule.times.length) ? p.posting_schedule.times : ['09:00'],
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [profileId, token])

  // Open posting slots for a given calendar day: configured times for
  // that weekday, minus any already taken that day, minus past times.
  const openSlotsFor = (d) => {
    if (!sched || !sched.days.includes(d.getDay())) return []
    const dayItems = byDay.get(dayKey(d)) || []
    const taken = new Set(dayItems.map((it) => {
      const t = new Date(it.scheduled_datetime)
      return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
    }))
    const now = Date.now()
    return sched.times
      .filter((t) => !taken.has(t))
      .map((t) => {
        const [hh, mm] = String(t).split(':').map(Number)
        const dt = new Date(d); dt.setHours(hh, mm, 0, 0)
        return { time: t, iso: dt.toISOString(), ms: dt.getTime(), label: dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) }
      })
      .filter((s) => s.ms > now + 60000)
      .sort((a, b) => a.ms - b.ms)
  }

  const onDragStart = (e, item, kind = 'calendar') => {
    setDragId(item.id)
    setDragKind(kind)
    dragItemRef.current = item
    try {
      e.dataTransfer.setData('text/plain', item.id)
      e.dataTransfer.effectAllowed = 'move'
    } catch {}
  }
  const onDragEnd = () => {
    setDragId(null)
    setDragKind(null)
    setHoverSlot(null)
    dragItemRef.current = null
  }

  // Move an already-on-calendar post to a new datetime. Optimistic: the card
  // jumps immediately; on failure it rolls back AND surfaces the real error
  // (previously a failed Upload-Post reschedule returned 502 and the move was
  // silently dropped, so it looked like drag just didn't work).
  const rescheduleTo = async (item, iso, label) => {
    // optimistic move
    setLocalItems((arr) => [...arr.filter((x) => x.id !== item.id), { ...item, scheduled_datetime: iso }])
    try {
      const r = await fetch(`/api/content?id=${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ scheduled_datetime: iso }),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b?.error || `Couldn't move the post (${r.status}).`)
      // Reconcile with the server row (new request_id after a resync, etc.).
      if (b.item) setLocalItems((arr) => [...arr.filter((x) => x.id !== item.id), b.item])
      toast({ kind: 'success', message: `Moved “${item.title || 'post'}”${label ? ` to ${label}` : ''}.` })
    } catch (err) {
      // Roll back the override → falls back to the server row's old time.
      setLocalItems((arr) => arr.filter((x) => x.id !== item.id))
      toast({ kind: 'error', message: err.message })
    }
  }

  // Drop a backlog post onto an open slot → schedule it LIVE: set the
  // time, then approve (which submits to Upload-Post for that slot).
  const onDropSlot = async (e, slot) => {
    e.preventDefault(); e.stopPropagation()
    const item = dragItemRef.current
    if (!item) return
    // Moving an already-scheduled post onto a specific open slot → just
    // reschedule it to that exact time. (Without this, the slot row's
    // stopPropagation ate calendar-item drops and nothing moved.)
    if (dragKind === 'calendar') { onDragEnd(); await rescheduleTo(item, slot.iso, slot.label); return }
    if (dragKind !== 'backlog') return
    onDragEnd()
    // Optimistic FIRST: move the card onto the grid and out of the backlog
    // the instant you drop it. The live Upload-Post submission below can take
    // 10-15s; making the user wait on it froze the card that whole time.
    // We reconcile with the server row on success and roll back on failure.
    const provisional = { ...item, scheduled_datetime: slot.iso, status: 'scheduled', _pending: true }
    setLocalItems((arr) => [...arr.filter((x) => x.id !== item.id), provisional])
    setBacklog((arr) => arr.filter((x) => x.id !== item.id))
    try {
      // The post needs platforms or approve won't submit it to Upload-Post
      // (it would schedule locally then ghost). If the row has none (e.g. an
      // MCP upload that skipped platforms), fall back to the brand's
      // connected platforms.
      let platforms = Array.isArray(item.platforms) ? item.platforms.filter(Boolean) : []
      if (!platforms.length) {
        try {
          const cr = await fetch(`/api/account/uploadpost-connected?profile_id=${profileId}`, { headers: { Authorization: `Bearer ${token}` } })
          const cb = await cr.json().catch(() => ({}))
          // Prefer the brand's default platforms; fall back to all connected.
          platforms = (Array.isArray(cb.default_platforms) && cb.default_platforms.length)
            ? cb.default_platforms
            : (Array.isArray(cb.connected_platforms) ? cb.connected_platforms : [])
        } catch { /* leave empty */ }
      }
      if (!platforms.length) throw new Error('This brand has no connected platforms — connect one before scheduling.')
      // Two-step: set the time, then approve (which submits to Upload-Post).
      // If approve fails AFTER the time is set, we must clear the time again —
      // otherwise the row has a scheduled_datetime but status 'caption_ready',
      // which shows in NEITHER the backlog (wants no time) nor the calendar
      // (wants status scheduled), i.e. it vanishes. Track that so the catch
      // can undo the persisted PATCH, not just the on-screen card.
      let timeWasSet = false
      const p = await fetch(`/api/content?id=${item.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ scheduled_datetime: slot.iso, platforms }),
      })
      if (!p.ok) throw new Error((await p.json().catch(() => ({})))?.error || 'Could not set the time')
      timeWasSet = true
      const a = await fetch(`/api/content?action=approve&id=${item.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      })
      const ab = await a.json().catch(() => ({}))
      if (!a.ok) { const e = new Error(ab?.error || 'Scheduling failed'); e.timeWasSet = timeWasSet; throw e }
      // Reconcile: replace the provisional card with the server's row so
      // status / handles are accurate.
      const placed = (ab && ab.item) ? ab.item : { ...item, scheduled_datetime: slot.iso, status: 'scheduled', platforms }
      setLocalItems((arr) => [...arr.filter((x) => x.id !== item.id), placed])
      toast({ kind: 'success', message: `Scheduled “${item.title || 'post'}” for ${slot.label}.` })
    } catch (err) {
      // Undo the persisted time so the post doesn't get stranded invisibly
      // between the backlog and the calendar. Best-effort; the card is
      // restored to the backlog regardless.
      if (err?.timeWasSet) {
        fetch(`/api/content?id=${item.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ scheduled_datetime: null }),
        }).catch(() => {})
      }
      // Roll back: pull it off the grid and restore it to the backlog.
      setLocalItems((arr) => arr.filter((x) => x.id !== item.id))
      setBacklog((arr) => (arr.some((x) => x.id === item.id) ? arr : [item, ...arr]))
      toast({ kind: 'error', message: err.message })
    }
  }

  const onDropDay = async (e, dayDate) => {
    e.preventDefault()
    const item = dragItemRef.current
    // Backlog items only schedule via a specific slot, not a bare day drop.
    if (!item || dragKind === 'backlog') return
    // Keep the same time of day, just move the calendar date.
    const orig = new Date(item.scheduled_datetime)
    const next = new Date(dayDate)
    next.setHours(orig.getHours(), orig.getMinutes(), 0, 0)
    onDragEnd()
    if (next.getTime() === orig.getTime()) return
    const label = next.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    await rescheduleTo(item, next.toISOString(), label)
  }

  return (
    <div>
      {/* Month / year header + pagination. Prev / next step viewMonth
          ±1 calendar month; Today resets to the current month. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        marginBottom: 14, padding: '10px 14px',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10,
      }}>
        <div style={{
          fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700,
          color: 'var(--text)', flex: 1, letterSpacing: '0.02em',
        }}>
          {viewMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </div>
        <button
          className="btn-primary"
          onClick={() => setShowGenerate(true)}
          style={{
            padding: '6px 14px', fontSize: 12, fontWeight: 700,
            display: 'inline-flex', alignItems: 'center', gap: 6,
            marginRight: 6,
          }}
          title="Plan a full month of posts in one shot — review each in the swipe queue before publish"
        >
          <Sparkles size={13} /> Generate content for the month
        </button>
        <a
          href="/schedule/queue"
          className="btn-ghost"
          style={{
            padding: '6px 12px', fontSize: 12, fontWeight: 600,
            display: 'inline-flex', alignItems: 'center', gap: 5,
            marginRight: 6, textDecoration: 'none',
          }}
          title="Review pending drafts in the swipe queue"
        >
          <ClipboardCheck size={13} /> Review queue
        </a>
        <button
          className="btn-ghost"
          onClick={goToday}
          style={{ padding: '5px 12px', fontSize: 12 }}
          title="Jump to the current month"
        >Today</button>
        <button
          className="btn-ghost"
          onClick={() => stepMonth(-1)}
          aria-label="Previous month"
          style={{ padding: '5px 10px', fontSize: 12 }}
          title="Previous month"
        >‹</button>
        <button
          className="btn-ghost"
          onClick={() => stepMonth(1)}
          aria-label="Next month"
          style={{ padding: '5px 10px', fontSize: 12 }}
          title="Next month"
        >›</button>
      </div>

      {showGenerate && (
        <GenerateMonthModal
          profileId={profileId}
          token={token}
          onClose={() => setShowGenerate(false)}
          onComplete={({ inserted }) => {
            // Leave the modal open so the user sees the completed
            // progress bar; closing on their click. Refresh the
            // calendar so the new pending posts appear.
            onChange?.()
          }}
        />
      )}

      {/* Backlog (left) + calendar (right). The backlog holds posts that
          are ready but have no time yet; drag one onto an open slot on a
          day to schedule it. */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{
          width: 250, flexShrink: 0, background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 10, padding: 10,
          position: 'sticky', top: 12, maxHeight: 'calc(100vh - 200px)', overflowY: 'auto',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>
            Waiting to schedule{backlog.length ? ` · ${backlog.length}` : ''}
          </div>
          {backlog.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', padding: '18px 8px', textAlign: 'center', border: '1px dashed var(--border)', borderRadius: 8 }}>
              Nothing waiting. Everything ready is scheduled.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {backlog.map((it) => {
                const thumb = it.cover_image_url || (Array.isArray(it.media_urls) && it.media_urls[0])
                const isVid = it.media_type === 'video' && !it.cover_image_url
                return (
                  <div key={it.id} draggable onDragStart={(e) => onDragStart(e, it, 'backlog')} onDragEnd={onDragEnd}
                    onClick={() => onOpen && onOpen(it)}
                    onMouseEnter={() => setHoverBacklogId(it.id)}
                    onMouseLeave={() => setHoverBacklogId((cur) => (cur === it.id ? null : cur))}
                    title="Click to edit · drag onto an open slot to schedule"
                    style={{
                      position: 'relative',
                      display: 'flex', gap: 8, alignItems: 'flex-start', padding: 7,
                      background: 'var(--surface-2)', border: '1px solid var(--border)',
                      borderLeft: `3px solid ${it.media_type === 'video' ? '#0ea5e9' : it.media_type === 'text' ? '#f59e0b' : '#a855f7'}`,
                      borderRadius: 7, cursor: 'pointer', opacity: it.id === dragId ? 0.5 : 1,
                    }}>
                    {thumb ? (
                      isVid
                        ? <video src={thumb} muted playsInline preload="metadata" style={{ width: 34, height: 34, borderRadius: 4, objectFit: 'cover', background: '#000', flexShrink: 0 }} />
                        : <img src={thumb} alt="" style={{ width: 34, height: 34, borderRadius: 4, objectFit: 'cover', background: 'var(--surface)', flexShrink: 0 }} />
                    ) : (
                      <div style={{ width: 34, height: 34, borderRadius: 4, background: 'var(--surface)', border: '1px solid var(--border)', display: 'grid', placeItems: 'center', color: 'var(--muted)', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{it.media_type === 'text' ? '“”' : '?'}</div>
                    )}
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', paddingRight: 16 }}>
                      {it.title || 'Untitled'}
                    </div>
                    {hoverBacklogId === it.id && (
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteFromBacklog(it) }}
                        title="Delete from queue"
                        style={{
                          position: 'absolute', top: 4, right: 4, width: 20, height: 20,
                          display: 'grid', placeItems: 'center', padding: 0,
                          background: 'var(--surface)', border: '1px solid var(--border)',
                          borderRadius: 5, color: '#ef4444', cursor: 'pointer',
                        }}>
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
      {/* Weekday labels — show once at the top, aligned with the grid below */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
        gap: 10, marginBottom: 6,
      }}>
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((lbl) => (
          <div key={lbl} style={{
            fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10.5,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--muted)', textAlign: 'center',
          }}>{lbl}</div>
        ))}
      </div>

      {/* Day columns — always 7 across (matches the weekday header).
          Days from the prior / next month are dimmed so the user
          knows what month they're looking at. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
        gap: 10,
      }}>
        {days.map((d) => {
          const k = dayKey(d)
          const dayItems = byDay.get(k) || []
          const isToday = k === todayKey
          const isCurrentMonth = d.getMonth() === viewMonth.getMonth()
          const isDropTarget = !!dragId
          return (
            <div
              key={k}
              onDragOver={(e) => { if (isDropTarget) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }}
              onDrop={(e) => onDropDay(e, d)}
              style={{
                background: 'var(--surface)',
                border: `1px solid ${isToday ? 'rgba(239,68,68,0.45)' : 'var(--border)'}`,
                borderRadius: 10, padding: 8, minHeight: 120,
                position: 'relative',
                // Dim days outside the current month so the user knows
                // what month they're looking at without removing context
                // (the row still grids cleanly).
                opacity: isCurrentMonth ? 1 : 0.42,
              }}
            >
              <div style={{
                display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 8,
                paddingBottom: 6, borderBottom: '1px solid var(--border)',
              }}>
                {/* Weekday lives in the top header row, so cells just
                    need the day number + a small count chip. */}
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18, color: isToday ? 'var(--red)' : 'var(--text)', lineHeight: 1 }}>
                  {d.getDate()}
                </div>
                <div style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 'auto' }}>
                  {dayItems.length || ''}
                </div>
              </div>

              {dayItems.length === 0 ? (
                <div style={{
                  fontSize: 11, color: 'var(--muted)',
                  textAlign: 'center', padding: '20px 6px',
                  border: '1px dashed var(--border)', borderRadius: 6,
                  background: 'rgba(255,255,255,0.02)',
                }}>
                  {isDropTarget ? 'Drop here' : '—'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {dayItems.map((item) => {
                    const isDragging = item.id === dragId
                    // Prefer the generated Instagram cover when one is set —
                    // that's what'll actually appear in the feed, so showing
                    // the source video here was misleading on covered posts.
                    // Fall back to the source media when no cover exists.
                    const hasCover = !!item.cover_image_url
                    const thumb = hasCover ? item.cover_image_url
                      : (Array.isArray(item.media_urls) && item.media_urls[0])
                    const isVideo = item.media_type === 'video'
                    const isText = item.media_type === 'text'
                    const isPosted = item.status === 'posted'
                    // Cover thumbs are always static images regardless of
                    // the source media_type. Only render <video> if we're
                    // showing the source video itself.
                    const thumbIsVideo = isVideo && !hasCover
                    // Pending-approval rows live on the calendar with a
                    // reserved slot but are NOT submitted to Upload-Post.
                    // The user has to click → Approve in the detail
                    // drawer to actually fire them. Visual treatment:
                    // amber dashed border + "PENDING" pill.
                    const isPendingApproval = item.status === 'draft' && item.approval_status === 'pending'
                    // Posted (delivered) rows get a green left-border so they
                    // pop visually as "shipped" alongside still-queued items
                    // that show the post-kind color (video/text/image).
                    const kindBorder = isPosted
                      ? '#2ecc71'
                      : isPendingApproval
                      ? '#f59e0b'
                      : isVideo ? '#0ea5e9'
                      : isText ? '#f59e0b'
                      : '#a855f7'
                    return (
                      <div
                        key={item.id}
                        draggable={!isPosted}
                        onDragStart={(e) => onDragStart(e, item)}
                        onDragEnd={onDragEnd}
                        onClick={() => onOpen(item)}
                        title={isPosted ? 'Posted — already delivered' : undefined}
                        style={{
                          background: isPosted
                            ? 'linear-gradient(135deg, rgba(46,204,113,0.10), rgba(46,204,113,0.04))'
                            : isPendingApproval
                            ? 'linear-gradient(135deg, rgba(245,158,11,0.10), rgba(245,158,11,0.04))'
                            : 'var(--surface-2)',
                          border: isPosted
                            ? '1px solid rgba(46,204,113,0.35)'
                            : isPendingApproval
                            ? '1px dashed rgba(245,158,11,0.55)'
                            : '1px solid var(--border)',
                          borderLeft: `3px solid ${kindBorder}`,
                          borderRadius: 6, padding: 6,
                          cursor: isPosted ? 'pointer' : 'grab',
                          opacity: isDragging ? 0.5 : isPosted ? 0.85 : 1,
                          fontSize: 11.5, color: 'var(--text-soft)',
                          display: 'flex', gap: 6, alignItems: 'flex-start',
                          position: 'relative',
                        }}
                      >
                        {thumb ? (
                          <div style={{ position: 'relative', width: 36, height: 36, flexShrink: 0 }}>
                            {thumbIsVideo
                              ? <video src={thumb} muted playsInline preload="metadata" style={{ width: 36, height: 36, borderRadius: 4, objectFit: 'cover', background: '#000', display: 'block' }} />
                              : <img src={thumb} alt="" style={{ width: 36, height: 36, borderRadius: 4, objectFit: 'cover', background: 'var(--surface)', display: 'block' }} />}
                            {/* Small "COVER" pill when we're showing the
                                generated thumbnail rather than the raw
                                video frame. Helps the user tell at a
                                glance which posts have a cover staged. */}
                            {hasCover && (
                              <div style={{
                                position: 'absolute', bottom: -2, right: -3,
                                fontSize: 7.5, fontWeight: 800, letterSpacing: '0.04em',
                                padding: '1px 4px', borderRadius: 3,
                                background: 'rgba(14,165,233,0.92)',
                                color: '#fff',
                                lineHeight: 1.1,
                              }}>IG</div>
                            )}
                          </div>
                        ) : (
                          <div style={{
                            width: 36, height: 36, borderRadius: 4,
                            background: isText ? 'rgba(245,158,11,0.10)' : 'var(--surface)',
                            border: isText ? '1px solid rgba(245,158,11,0.4)' : '1px solid var(--border)',
                            display: 'grid', placeItems: 'center',
                            color: isText ? '#f59e0b' : 'var(--muted)',
                            fontFamily: 'var(--font-display)', fontWeight: 700,
                            fontSize: isText ? 16 : 11,
                            flexShrink: 0,
                          }}>{isText ? '“”' : '?'}</div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 11.5, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                            {item.title || 'Untitled'}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span>{new Date(item.scheduled_datetime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                            {isPosted && (
                              <span title="Posted" style={{
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                color: '#2ecc71', fontWeight: 800, fontSize: 12, lineHeight: 1,
                              }}>✓</span>
                            )}
                            {isPendingApproval && (
                              <span style={{
                                display: 'inline-flex', alignItems: 'center', gap: 3,
                                padding: '1px 5px', borderRadius: 999,
                                background: 'rgba(245,158,11,0.18)',
                                color: '#f59e0b',
                                fontWeight: 700, fontSize: 9,
                                letterSpacing: '0.04em', textTransform: 'uppercase',
                              }}>Pending</span>
                            )}
                          </div>
                          {/* Platform icons hidden for a compact card — the
                              targets live on the post's detail drawer. */}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Open posting slots for this day — drop a backlog post here
                  to schedule it at that time. Highlighted while a backlog
                  card is being dragged. */}
              {(() => {
                const slots = openSlotsFor(d)
                if (!slots.length) return null
                // Active for BOTH backlog drags (schedule new) and calendar
                // drags (move an existing post to this exact time).
                const active = dragKind === 'backlog' || dragKind === 'calendar'
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
                    {slots.map((slot) => {
                      const skey = `${k}|${slot.time}`
                      const isHover = active && hoverSlot === skey
                      return (
                        <div key={slot.time}
                          onDragOver={(e) => { if (active) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; if (hoverSlot !== skey) setHoverSlot(skey) } }}
                          onDragLeave={() => { if (hoverSlot === skey) setHoverSlot(null) }}
                          onDrop={(e) => onDropSlot(e, slot)}
                          style={{
                            fontSize: 10, textAlign: 'center', padding: '3px 4px', borderRadius: 5,
                            fontWeight: isHover ? 800 : 400,
                            border: `1px ${isHover ? 'solid' : 'dashed'} ${isHover ? 'var(--red)' : active ? 'rgba(239,68,68,0.5)' : 'var(--border)'}`,
                            color: isHover ? '#fff' : active ? 'var(--red)' : 'var(--muted)',
                            background: isHover ? 'var(--red)' : active ? 'rgba(239,68,68,0.06)' : 'transparent',
                            boxShadow: isHover ? '0 0 0 2px rgba(239,68,68,0.35), 0 0 12px rgba(239,68,68,0.55)' : 'none',
                            transform: isHover ? 'scale(1.04)' : 'none',
                            transition: 'all 0.1s',
                          }}>
                          ＋ {slot.label}
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
            </div>
          )
        })}
      </div>
        </div>
      </div>
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
  { value: 'calendar',   label: 'Calendar',   icon: Calendar,       filter: 'calendar',   empty: 'Nothing scheduled in the next two weeks.' },
  { value: 'drafts',     label: 'Drafts',     icon: FileEdit,       filter: 'drafts',     empty: 'No drafts. Generated content shows up here first.' },
  { value: 'approvals',  label: 'Approvals',  icon: ClipboardCheck, filter: 'approvals',  empty: 'No items waiting on you. Set AI CEO behavior to "Aggressive" to skip the queue entirely.' },
]

export default function Content() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  // Calendar is the default surface for the Schedule page (backlog +
  // drag-to-slot scheduling). Library / Drafts / Approvals still selectable.
  const [tab, setTab] = useState('calendar')
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

  // Silent Upload-Post orphan cleanup on profile open. Fire-and-forget:
  // scans Upload-Post for scheduled jobs the local DB has no row for and
  // cancels them. No toast unless something gets cleaned (avoids noise
  // on the 95% of opens where nothing's wrong). Runs once per profile
  // mount; debounced through a ref so swapping tabs doesn't re-fire.
  const orphanCleanupRanForProfileRef = useRef(null)
  useEffect(() => {
    if (!session?.access_token || !selectedProfileId) return
    if (orphanCleanupRanForProfileRef.current === selectedProfileId) return
    orphanCleanupRanForProfileRef.current = selectedProfileId
    ;(async () => {
      try {
        const r = await fetch('/api/social/uploadpost-cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ profile_id: selectedProfileId, mode: 'cancel_orphans' }),
        })
        const b = await r.json().catch(() => ({}))
        if (r.ok && b?.counts?.canceled > 0) {
          // Only surface when we actually did something — most opens are
          // silent. Light info toast, not warn — this is a healthy
          // background reconcile, not an error.
          // eslint-disable-next-line no-console
          console.info(`[uploadpost-cleanup] silently canceled ${b.counts.canceled} orphan${b.counts.canceled === 1 ? '' : 's'} on open`)
        }
      } catch (e) {
        // Background task — failures stay in the console, not in the user's face.
        // eslint-disable-next-line no-console
        console.warn('[uploadpost-cleanup] background run failed:', e?.message)
      }
    })()
  }, [session, selectedProfileId])

  if (!selectedProfileId) {
    return <div className="card-flat fade-up" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      Pick a brand profile to manage content.
    </div>
  }

  return (
    <TrialGate page="schedule">
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
        {/* Generate content button removed at user's request — the
            primary path to making content is now Spaces (workflows)
            or Bulk Upload below. The GenerateModal still mounts
            elsewhere if anything triggers it programmatically. */}
      </div>

      {tab === 'library' ? (
        // Library tab is now the bulk upload + manage table view (mirrors
        // VTM's ContentScheduler). It owns its own data fetch + status
        // tabs internally so we don't need the outer loading guard.
        <BulkUploadView profileId={selectedProfileId} token={session?.access_token} onChange={refreshPending} />
      ) : loading ? (
        <div className="card-flat" style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
      ) : tab === 'calendar' ? (
        <CalendarView items={items} onOpen={setOpened} token={session?.access_token} onChange={refresh} profileId={selectedProfileId} />
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
    </TrialGate>
  )
}
