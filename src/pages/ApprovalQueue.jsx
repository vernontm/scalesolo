// Tinder-style approval queue for content_scripts rows where
// approval_status='pending'. Built for the "Generate content for the
// month" flow — after Claude drafts a few hundred posts, the user
// burns through them here one at a time with big, ergonomic buttons +
// keyboard shortcuts.
//
//   ← / X      Reject (status → rejected, optional reason)
//   → / Enter  Approve (status → approved, ready for publish)
//   ↑ / E      Edit caption inline (expands a textarea, save = approve)
//   R          Regenerate just this post (calls /api/content/regenerate)
//   S          Skip (leave as pending, advance)
//
// The queue auto-fetches the next batch of 20 pending posts and pages
// through them client-side; once empty it refetches. Per-platform copy
// variants are shown as small tabs so the reviewer sees what'll land
// on each platform, not just the generic caption.

import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Check, X as XIcon, Edit3, RefreshCw, SkipForward,
  ArrowLeft, ArrowRight, Loader2, Inbox, Sparkles, Image as ImageIcon,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { PlatformBadge } from '../components/PlatformBadge.jsx'
import { toast } from '../components/Toast.jsx'

const FETCH_BATCH = 20

export default function ApprovalQueue() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  const navigate = useNavigate()
  const token = session?.access_token

  // Queue holds the currently fetched batch; `cursor` advances client-
  // side until empty, then we refetch.
  const [queue, setQueue] = useState([])
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [totalRemaining, setTotalRemaining] = useState(null)
  const [editMode, setEditMode] = useState(false)
  const [editText, setEditText] = useState('')
  const [activePlatform, setActivePlatform] = useState(null)

  const current = queue[cursor] || null

  const fetchBatch = useCallback(async () => {
    if (!selectedProfileId || !token) return
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(
        `/api/content?profile_id=${selectedProfileId}&filter=approvals&limit=${FETCH_BATCH}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error || `Fetch failed (${r.status})`)
      const items = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : []
      setQueue(items)
      setCursor(0)
      setTotalRemaining(body?.total ?? items.length)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [selectedProfileId, token])

  useEffect(() => { fetchBatch() }, [fetchBatch])

  // When we exit edit mode reset the buffer.
  useEffect(() => {
    if (current) {
      setEditText(current.caption || '')
      const plats = Array.isArray(current.platforms) ? current.platforms : []
      setActivePlatform(plats[0] || null)
    }
  }, [current?.id])

  // Advance to next post. If we ran off the end of the local batch,
  // refetch — there may be more pending after the ones we just
  // resolved.
  const advance = useCallback(() => {
    setEditMode(false)
    if (cursor + 1 >= queue.length) {
      fetchBatch()
    } else {
      setCursor((c) => c + 1)
    }
  }, [cursor, queue.length, fetchBatch])

  // POST to the real /api/content?action=approve|reject path so the
  // server-side logic runs: approval flips status to 'scheduled',
  // submits the post to Upload-Post at the row's scheduled_datetime,
  // and stores the returned job_id. Raw PATCH would skip all that and
  // leave the row in approval='approved' but status='caption_ready'
  // (i.e. never publishing).
  const callAction = useCallback(async (id, action, body = {}) => {
    setBusy(true)
    try {
      const r = await fetch(`/api/content?id=${id}&action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error(b?.error || `${action} failed (${r.status})`)
      }
    } finally {
      setBusy(false)
    }
  }, [token])

  // Inline-edit save still goes through PATCH so we only update the
  // caption without triggering the approve side effects. Approve runs
  // right after if the user clicks "Save + approve".
  const patchCaption = useCallback(async (id, caption) => {
    const r = await fetch(`/api/content?id=${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ caption }),
    })
    if (!r.ok) {
      const b = await r.json().catch(() => ({}))
      throw new Error(b?.error || `Update failed (${r.status})`)
    }
  }, [token])

  const approve = useCallback(async () => {
    if (!current || busy) return
    try {
      if (editMode && editText !== current.caption) {
        await patchCaption(current.id, editText)
      }
      // A media post (image/carousel/video) with no media yet can't
      // actually schedule on approve — the server holds it at approved.
      // Say so plainly instead of letting the "Goes live" note imply it's
      // publishing. It schedules automatically once its media is generated.
      const needsMedia = current.media_type && current.media_type !== 'text'
        && !(Array.isArray(current.media_urls) && current.media_urls.length)
      await callAction(current.id, 'approve')
      if (needsMedia) {
        toast({ kind: 'info', message: 'Approved. Generate its media on the Campaigns page, then it schedules automatically.' })
      }
      advance()
    } catch (e) { setError(e.message) }
  }, [current, busy, editMode, editText, callAction, patchCaption, advance])

  const reject = useCallback(async () => {
    if (!current || busy) return
    try {
      await callAction(current.id, 'reject', { reason: 'Skipped from queue' })
      advance()
    } catch (e) { setError(e.message) }
  }, [current, busy, callAction, advance])

  const skip = useCallback(() => {
    if (!current || busy) return
    advance()
  }, [current, busy, advance])

  // Keyboard shortcuts — only when not actively editing.
  useEffect(() => {
    if (editMode) return
    const handler = (e) => {
      if (e.target?.tagName === 'TEXTAREA' || e.target?.tagName === 'INPUT') return
      if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); approve() }
      else if (e.key === 'ArrowLeft' || e.key === 'x' || e.key === 'X') { e.preventDefault(); reject() }
      else if (e.key === 's' || e.key === 'S') { e.preventDefault(); skip() }
      else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); setEditMode(true) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [approve, reject, skip, editMode])

  if (loading && !current) {
    return (
      <div style={pageStyle}>
        <div style={{ padding: 60, textAlign: 'center' }}><span className="spinner" /></div>
      </div>
    )
  }

  if (!current) {
    return (
      <div style={pageStyle}>
        <Header onBack={() => navigate('/schedule')} remaining={0} />
        <div style={emptyState}>
          <Inbox size={48} style={{ color: 'var(--muted)', marginBottom: 14 }} />
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Inbox zero.</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 360, textAlign: 'center' }}>
            Nothing pending review. Generate a fresh batch from the calendar, or come back when the cron drops more drafts.
          </div>
        </div>
      </div>
    )
  }

  const platforms = Array.isArray(current.platforms) ? current.platforms : []
  const perPlatform = current.per_platform_text || {}
  const shownText = activePlatform && perPlatform[activePlatform]
    ? perPlatform[activePlatform]
    : (current.caption || '')

  return (
    <div style={pageStyle}>
      <Header onBack={() => navigate('/schedule')} remaining={(totalRemaining ?? queue.length) - cursor} />

      {error && (
        <div style={{ ...errorPanel, margin: '0 24px 18px' }}>{error}</div>
      )}

      <div style={cardWrapStyle}>
        <div style={card}>
          {/* Meta row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <div style={metaPill}><Sparkles size={11} style={{ verticalAlign: -1, marginRight: 4 }} />{current.generated_by || 'manual'}</div>
            {current.scheduled_datetime && (
              <div style={metaPill}>
                {new Date(current.scheduled_datetime).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </div>
            )}
            {current.media_type && current.media_type !== 'text' && !(Array.isArray(current.media_urls) && current.media_urls.length) && (
              <div style={{ ...metaPill, color: '#f59e0b', borderColor: 'rgba(245,158,11,0.45)' }}>
                <ImageIcon size={11} style={{ verticalAlign: -1, marginRight: 4 }} />media needed
              </div>
            )}
            {platforms.length > 0 && (
              <div style={{ display: 'flex', gap: 4 }}>
                {platforms.map((p) => <PlatformBadge key={p} platform={p} />)}
              </div>
            )}
          </div>

          {/* Title + hook */}
          {current.title && (
            <div style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.06, marginBottom: 4 }}>
              {current.title}
            </div>
          )}
          {current.hook && (
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 14, lineHeight: 1.35 }}>
              {current.hook}
            </div>
          )}

          {/* Per-platform tabs */}
          {platforms.length > 1 && Object.keys(perPlatform).length > 0 && (
            <div style={{ display: 'flex', gap: 4, marginBottom: 10, borderBottom: '1px solid var(--border)' }}>
              {platforms.map((p) => (
                <button
                  key={p} type="button"
                  onClick={() => setActivePlatform(p)}
                  style={{
                    padding: '6px 12px', fontSize: 11.5, fontWeight: 700,
                    background: 'transparent', border: 'none',
                    borderBottom: `2px solid ${activePlatform === p ? 'var(--red)' : 'transparent'}`,
                    color: activePlatform === p ? 'var(--text)' : 'var(--muted)',
                    cursor: 'pointer', textTransform: 'capitalize',
                  }}
                >{p}</button>
              ))}
            </div>
          )}

          {/* Body — edit mode swaps to textarea */}
          {editMode ? (
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              autoFocus
              rows={10}
              style={{
                width: '100%', padding: 14, fontSize: 15, lineHeight: 1.5,
                background: 'var(--surface)', border: '1px solid var(--red)',
                borderRadius: 10, color: 'var(--text)', resize: 'vertical',
                fontFamily: 'inherit', boxSizing: 'border-box',
              }}
            />
          ) : (
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 15, lineHeight: 1.55, color: 'var(--text)', minHeight: 160 }}>
              {shownText || <em style={{ color: 'var(--muted)' }}>No copy generated.</em>}
            </div>
          )}

          {current.hashtags && (
            <div style={{ marginTop: 16, fontSize: 13, color: 'var(--accent, #6ea8fe)' }}>
              {current.hashtags}
            </div>
          )}
        </div>

        {/* Big action bar */}
        <div style={actionBar}>
          <ActionBtn kind="reject" onClick={reject} disabled={busy} icon={<XIcon size={18} />} label="Reject" shortcut="←" />
          <ActionBtn kind="skip" onClick={skip} disabled={busy} icon={<SkipForward size={18} />} label="Skip" shortcut="S" />
          <ActionBtn kind="edit" onClick={() => setEditMode((m) => !m)} disabled={busy} icon={<Edit3 size={18} />} label={editMode ? 'Cancel edit' : 'Edit'} shortcut="E" />
          <ActionBtn kind="approve" onClick={approve} disabled={busy} icon={busy ? <Loader2 size={18} className="spin" /> : <Check size={18} />} label={editMode ? 'Save + approve' : 'Approve'} shortcut="→" />
        </div>
      </div>
    </div>
  )
}

function Header({ onBack, remaining }) {
  return (
    <div style={headerStyle}>
      <button onClick={onBack} className="btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <ArrowLeft size={14} /> Back to schedule
      </button>
      <div style={{ flex: 1 }} />
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        {remaining > 0 ? `${remaining} left to review` : 'All caught up'}
      </div>
    </div>
  )
}

function ActionBtn({ kind, onClick, disabled, icon, label, shortcut }) {
  const palette = {
    approve: { bg: 'rgba(34,197,94,0.12)',  bd: 'rgba(34,197,94,0.5)',  fg: '#22c55e' },
    reject:  { bg: 'rgba(239,68,68,0.12)',  bd: 'rgba(239,68,68,0.5)',  fg: 'var(--red)' },
    edit:    { bg: 'rgba(99,102,241,0.12)', bd: 'rgba(99,102,241,0.5)', fg: '#818cf8' },
    skip:    { bg: 'var(--surface-2)',      bd: 'var(--border)',        fg: 'var(--text)' },
  }[kind] || { bg: 'var(--surface-2)', bd: 'var(--border)', fg: 'var(--text)' }
  return (
    <button
      onClick={onClick} disabled={disabled}
      style={{
        flex: 1, padding: '14px 16px', borderRadius: 10,
        background: palette.bg, border: `1.5px solid ${palette.bd}`,
        color: palette.fg, fontWeight: 700, fontSize: 14,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      }}
    >
      {icon}
      <span>{label}</span>
      <span style={{ fontSize: 10, opacity: 0.65, fontWeight: 500, marginLeft: 4 }}>{shortcut}</span>
    </button>
  )
}

// ── styles ───────────────────────────────────────────────────────

const pageStyle = {
  minHeight: '100vh',
  background: 'var(--bg-base, #0a0a0c)',
  display: 'flex', flexDirection: 'column',
}
const headerStyle = {
  display: 'flex', alignItems: 'center', gap: 12,
  padding: '18px 24px',
  borderBottom: '1px solid var(--border)',
}
const cardWrapStyle = {
  flex: 1,
  maxWidth: 680, width: '100%', margin: '0 auto',
  padding: '24px 24px 32px',
  display: 'flex', flexDirection: 'column', gap: 16,
}
const card = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 14, padding: 24, minHeight: 360,
}
const actionBar = {
  display: 'flex', gap: 10,
}
const metaPill = {
  padding: '3px 10px', borderRadius: 999, fontSize: 11.5,
  background: 'var(--surface-2)', color: 'var(--muted)',
  fontWeight: 600, letterSpacing: 0.02,
}
const emptyState = {
  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
  justifyContent: 'center', padding: '60px 20px',
}
const errorPanel = {
  padding: '10px 14px',
  background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.35)',
  borderRadius: 8, color: 'var(--red)', fontSize: 13,
}
