// VoiceSummaryCard — surfaces the latest brand_voice_summary row for
// a profile. The daily distill-brand-voice cron writes these from
// like/dislike feedback; users can override via the Edit button so
// they keep direct control if the auto-distillation drifts.
//
// Used in two places:
//   • Profiles page — full card with edit + reset + history
//   • Dashboard      — read-only "what we've learned about your voice"
//                      preview (pass `compact` to render the slim view)

import { useEffect, useState } from 'react'
import { Sparkles, Edit3, RotateCcw, Save, X, History, Loader2, AlertCircle } from 'lucide-react'

async function authedFetch(path, token, init = {}) {
  return fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token || ''}`,
      ...(init.headers || {}),
    },
  })
}

const fmtDate = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function VoiceSummaryCard({ profileId, session, compact = false }) {
  const [state, setState] = useState({ loading: true, summary: null, history: [], error: null })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ summary: '', liked_patterns: '', disliked_patterns: '' })
  const [busy, setBusy] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  const refresh = async () => {
    if (!profileId || !session?.access_token) return
    setState((s) => ({ ...s, loading: true }))
    try {
      const r = await authedFetch(`/api/brand-voice-summary?profile_id=${profileId}`, session.access_token)
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Failed')
      setState({ loading: false, summary: body.summary, history: body.history || [], error: null })
    } catch (e) {
      setState({ loading: false, summary: null, history: [], error: e.message })
    }
  }
  useEffect(() => { refresh() /* eslint-disable-next-line */ }, [profileId, session?.access_token])

  const startEdit = () => {
    setDraft({
      summary: state.summary?.summary || '',
      liked_patterns: state.summary?.liked_patterns || '',
      disliked_patterns: state.summary?.disliked_patterns || '',
    })
    setEditing(true)
  }

  const save = async () => {
    if (!draft.summary.trim()) return
    setBusy(true)
    try {
      const r = await authedFetch('/api/brand-voice-summary', session.access_token, {
        method: 'PUT',
        body: JSON.stringify({ profile_id: profileId, ...draft }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Failed')
      setEditing(false)
      await refresh()
    } catch (e) {
      setState((s) => ({ ...s, error: e.message }))
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    if (!confirm("Reset the AI's understanding of your voice? The next daily run will rebuild it from your recent likes/dislikes.")) return
    setBusy(true)
    try {
      await authedFetch('/api/brand-voice-summary', session.access_token, {
        method: 'DELETE',
        body: JSON.stringify({ profile_id: profileId }),
      })
      await refresh()
    } catch (e) {
      setState((s) => ({ ...s, error: e.message }))
    } finally {
      setBusy(false)
    }
  }

  if (state.loading) {
    return (
      <div style={shell(compact)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)' }}>
          <Loader2 size={14} className="spin" /> Loading voice profile…
        </div>
      </div>
    )
  }

  // Compact (dashboard) read-only render.
  if (compact) {
    if (!state.summary?.summary) return null
    return (
      <div style={{ ...shell(true), background: 'linear-gradient(135deg, rgba(168,85,247,0.10), rgba(168,85,247,0.02))', border: '1px solid rgba(168,85,247,0.30)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: 'rgba(168,85,247,0.18)', color: '#a855f7', display: 'grid', placeItems: 'center' }}>
            <Sparkles size={15} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>
              What the AI has learned about your voice
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
              Updated {fmtDate(state.summary.created_at)} · sample size {state.summary.sample_size}
            </div>
          </div>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-soft)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
          {state.summary.summary}
        </div>
      </div>
    )
  }

  // Full editor view (Profiles page).
  return (
    <div style={shell(false)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ width: 32, height: 32, borderRadius: 9, background: 'rgba(168,85,247,0.18)', color: '#a855f7', display: 'grid', placeItems: 'center' }}>
          <Sparkles size={15} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14 }}>
            Auto-learned brand voice
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            {state.summary
              ? <>Distilled {fmtDate(state.summary.created_at)} from {state.summary.sample_size || 0} feedback samples. Edit to override.</>
              : 'No summary yet. Rate scripts and hooks below; the daily learner builds this within 24 hours.'}
          </div>
        </div>
        {state.history.length > 0 && (
          <button type="button" onClick={() => setShowHistory((v) => !v)} style={pillBtn}>
            <History size={12} /> History ({state.history.length})
          </button>
        )}
      </div>

      {state.error && (
        <div style={errBox}><AlertCircle size={13} /> {state.error}</div>
      )}

      {!editing && state.summary?.summary && (
        <div style={blockBox}>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: 'var(--text-soft)', lineHeight: 1.55 }}>
            {state.summary.summary}
          </div>
          {state.summary.liked_patterns && (
            <div style={{ marginTop: 12 }}>
              <div style={subLabel}>Patterns the brand consistently approves</div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.55 }}>{state.summary.liked_patterns}</div>
            </div>
          )}
          {state.summary.disliked_patterns && (
            <div style={{ marginTop: 12 }}>
              <div style={subLabel}>Patterns the brand consistently rejects</div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.55 }}>{state.summary.disliked_patterns}</div>
            </div>
          )}
        </div>
      )}

      {editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={fieldLbl}>
            Voice summary <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(playbook for the writer — 3–6 sentences)</span>
            <textarea className="input" value={draft.summary}
              onChange={(e) => setDraft((d) => ({ ...d, summary: e.target.value }))}
              rows={5} style={{ marginTop: 4 }} />
          </label>
          <label style={fieldLbl}>
            Liked patterns
            <textarea className="input" value={draft.liked_patterns}
              onChange={(e) => setDraft((d) => ({ ...d, liked_patterns: e.target.value }))}
              rows={3} style={{ marginTop: 4 }} placeholder="One per line. e.g. - Opens with a contrarian claim" />
          </label>
          <label style={fieldLbl}>
            Disliked patterns
            <textarea className="input" value={draft.disliked_patterns}
              onChange={(e) => setDraft((d) => ({ ...d, disliked_patterns: e.target.value }))}
              rows={3} style={{ marginTop: 4 }} placeholder="One per line. e.g. - Conditional 'If he…' openers" />
          </label>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {!editing && (
          <button type="button" onClick={startEdit} style={btn}>
            <Edit3 size={13} /> {state.summary ? 'Edit override' : 'Write a starter summary'}
          </button>
        )}
        {!editing && state.summary && (
          <button type="button" onClick={reset} disabled={busy} style={btnGhost}>
            <RotateCcw size={13} /> Reset (re-learn from scratch)
          </button>
        )}
        {editing && (
          <>
            <button type="button" onClick={save} disabled={busy || !draft.summary.trim()} style={btnPrimary}>
              {busy ? <Loader2 size={13} className="spin" /> : <Save size={13} />} Save override
            </button>
            <button type="button" onClick={() => setEditing(false)} disabled={busy} style={btnGhost}>
              <X size={13} /> Cancel
            </button>
          </>
        )}
      </div>

      {showHistory && state.history.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <div style={subLabel}>Previous summaries</div>
          {state.history.map((h) => (
            <details key={h.id} style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--text-soft)' }}>
                {fmtDate(h.created_at)} · sample size {h.sample_size}
              </summary>
              <div style={{ marginTop: 6, padding: 10, background: 'var(--surface-2)', borderRadius: 8, fontSize: 12.5, color: 'var(--text-soft)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                {h.summary}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}

const shell = (compact) => ({
  padding: compact ? 16 : 18,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 14,
})
const blockBox = {
  padding: 14, background: 'var(--surface-2)',
  borderRadius: 10, border: '1px solid var(--border)',
}
const subLabel = {
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11,
  letterSpacing: '0.06em', textTransform: 'uppercase',
  color: 'var(--muted)', marginBottom: 6,
}
const fieldLbl = { fontSize: 12.5, color: 'var(--text-soft)', fontWeight: 600, display: 'block' }
const errBox = {
  display: 'flex', alignItems: 'center', gap: 6,
  background: 'var(--red-soft)', color: 'var(--red)',
  padding: '8px 10px', borderRadius: 8, fontSize: 12.5, marginBottom: 10,
}
const btn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 12px', borderRadius: 8,
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  color: 'var(--text)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
  fontFamily: 'inherit',
}
const btnPrimary = {
  ...btn,
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  borderColor: 'transparent', color: '#fff',
}
const btnGhost = {
  ...btn, background: 'transparent', color: 'var(--text-soft)',
}
const pillBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 9px', borderRadius: 999,
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  color: 'var(--text-soft)', fontSize: 11.5, cursor: 'pointer',
  fontFamily: 'inherit',
}
