// Voice training panel — drops into the Profile editor. Collapsible.
// Three sub-panels: reference scripts, opener hooks, hard rules.
// All three feed into the system prompt that script_gen / caption_gen
// use, via api/content/generate.js.

import { useEffect, useState } from 'react'
import {
  Mic, ChevronRight, ThumbsUp, ThumbsDown, Trash2, Plus, X, Sparkles,
  AlertCircle, MessageSquare, Link2, Wand2, Check, Loader2, ExternalLink,
} from 'lucide-react'

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

export default function VoiceTrainingSection({ profileId, session, doNotSay, alwaysInclude, onRulesChange }) {
  const [open, setOpen] = useState(false)
  if (!profileId) return null
  return (
    <div className="card-flat" style={{ padding: 14, background: 'var(--surface-2)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          background: 'transparent', border: 'none', cursor: 'pointer',
          padding: 0, color: 'var(--text)', textAlign: 'left',
        }}
      >
        <div style={{ width: 28, height: 28, borderRadius: 8, background: 'rgba(239,68,68,0.16)', color: 'var(--red)', display: 'grid', placeItems: 'center' }}>
          <Mic size={14} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14 }}>Voice training</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            Paste reference scripts, save approved hooks, and set hard rules. Generation pulls liked items as examples.
          </div>
        </div>
        <ChevronRight size={14} style={{ color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform 0.15s' }} />
      </button>

      {open && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ReferenceVideosPanel profileId={profileId} session={session} />
          <InsightsPanel profileId={profileId} session={session} />
          <ScriptsPanel profileId={profileId} session={session} />
          <HooksPanel profileId={profileId} session={session} />
          <RulesPanel
            doNotSay={doNotSay}
            alwaysInclude={alwaysInclude}
            onChange={onRulesChange}
          />
        </div>
      )}
    </div>
  )
}

// ── Reference videos ────────────────────────────────────────────────────────
// Paste a TikTok / Reel / YouTube URL → server resolves + transcribes
// via ElevenLabs Scribe → appears in the list. Hit Analyze on any
// transcribed row to have Claude extract patterns into the Insights
// panel below for review.
function ReferenceVideosPanel({ profileId, session }) {
  const [items, setItems] = useState(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [analyzingId, setAnalyzingId] = useState(null)
  const [error, setError] = useState(null)
  const token = session?.access_token

  const refresh = async () => {
    if (!token) return
    try {
      const r = await authedFetch(`/api/reference-videos?profile_id=${profileId}`, token)
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      setItems(body.videos || [])
      setError(null)
    } catch (e) { setError(e.message); setItems([]) }
  }
  useEffect(() => { refresh() /* eslint-disable-next-line */ }, [profileId, token])

  const submit = async () => {
    if (!url.trim() || !token) return
    setBusy(true); setError(null)
    try {
      const r = await authedFetch('/api/reference-videos', token, {
        method: 'POST',
        body: JSON.stringify({ profile_id: profileId, source_url: url.trim() }),
      })
      const body = await r.json()
      if (!r.ok) {
        if (r.status === 402) throw new Error(body.error || 'Monthly transcription limit reached.')
        throw new Error(body.error || `Failed (${r.status})`)
      }
      setUrl('')
      await refresh()
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const analyze = async (id) => {
    setAnalyzingId(id); setError(null)
    try {
      const r = await authedFetch('/api/reference-videos/analyze', token, {
        method: 'POST',
        body: JSON.stringify({ id }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Analyze failed (${r.status})`)
      // No state to update here — InsightsPanel below polls on its own
      // tab opening, but in case the user has it expanded already we
      // hint that fresh insights are available.
      window.dispatchEvent(new CustomEvent('voice-training:insights-changed', { detail: { profileId } }))
    } catch (e) { setError(e.message) }
    finally { setAnalyzingId(null) }
  }

  const remove = async (id) => {
    if (!confirm('Delete this reference video and its insights?')) return
    try {
      await authedFetch(`/api/reference-videos?id=${id}`, token, { method: 'DELETE' })
      setItems((arr) => (arr || []).filter((r) => r.id !== id))
    } catch (e) { setError(e.message) }
  }

  return (
    <Section
      title="Reference videos"
      hint="Paste TikTok / Reel / YouTube URLs of creators you want to learn from. We transcribe with ElevenLabs Scribe; Claude extracts pattern insights you can approve below."
    >
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Link2 size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input
            className="input"
            placeholder="https://www.tiktok.com/@user/video/123… or any direct video URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            style={{ width: '100%', paddingLeft: 28, fontSize: 12 }}
          />
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={!url.trim() || busy}
          style={{
            padding: '8px 12px', borderRadius: 8,
            background: busy ? 'var(--surface-2)' : 'linear-gradient(135deg, var(--red), var(--red-dark))',
            color: busy ? 'var(--text-soft)' : '#fff',
            border: 'none', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12,
            cursor: busy ? 'wait' : 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          {busy ? <Loader2 size={12} className="spin" /> : <Plus size={12} />} Add
        </button>
      </div>

      {error && <ErrorPill message={error} />}

      {!items ? <Loading /> : items.length === 0 ? (
        <Empty msg="No references yet. Paste a URL above to add the first." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((r) => (
            <ReferenceVideoRow
              key={r.id}
              row={r}
              onAnalyze={() => analyze(r.id)}
              onDelete={() => remove(r.id)}
              busy={analyzingId === r.id}
            />
          ))}
        </div>
      )}
    </Section>
  )
}

function ReferenceVideoRow({ row, onAnalyze, onDelete, busy }) {
  const [showTranscript, setShowTranscript] = useState(false)
  const status = row.status
  const ready = status === 'ready' && row.transcript
  return (
    <div style={{
      padding: 10, borderRadius: 8,
      background: 'var(--surface)', border: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {row.thumbnail_url ? (
          <img src={row.thumbnail_url} alt="" style={{ width: 48, height: 48, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} />
        ) : (
          <div style={{ width: 48, height: 48, borderRadius: 6, background: 'var(--surface-2)', display: 'grid', placeItems: 'center', flexShrink: 0, color: 'var(--muted)' }}>
            <Link2 size={14} />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
            {row.creator_handle ? <strong>@{row.creator_handle}</strong> : <span style={{ color: 'var(--muted)' }}>—</span>}
            <a href={row.source_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--muted)' }} title="Open original">
              <ExternalLink size={10} />
            </a>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            <StatusBadge status={status} error={row.error} />
            {row.duration_secs ? ` · ${row.duration_secs}s` : ''}
            {row.transcript_lang ? ` · ${row.transcript_lang.toUpperCase()}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {ready && (
            <button type="button" onClick={onAnalyze} disabled={busy} title="Analyze with Claude → write insights" style={btnSmall}>
              {busy ? <Loader2 size={11} className="spin" /> : <Wand2 size={11} />}
              Analyze
            </button>
          )}
          <IconBtn onClick={onDelete} title="Delete"><Trash2 size={11} /></IconBtn>
        </div>
      </div>

      {ready && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() => setShowTranscript((v) => !v)}
            style={{
              background: 'transparent', border: 'none',
              color: 'var(--muted)', fontSize: 10.5, cursor: 'pointer',
              padding: 0,
            }}
          >
            {showTranscript ? '▾' : '▸'} Transcript ({row.transcript.length.toLocaleString()} chars)
          </button>
          {showTranscript && (
            <div style={{
              marginTop: 6, padding: 10, borderRadius: 6,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              fontSize: 11.5, color: 'var(--text-soft)', lineHeight: 1.55,
              maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap',
            }}>{row.transcript}</div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Insights review queue ───────────────────────────────────────────────────
// Lists pending insights from brand_bible_insights. Approve merges the
// insight into the right voice-training table; Reject discards it.
// Listens for a custom event from ReferenceVideosPanel so a fresh
// analyze refreshes this list immediately without a polling loop.
function InsightsPanel({ profileId, session }) {
  const [items, setItems] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)
  const token = session?.access_token

  const refresh = async () => {
    if (!token) return
    try {
      const r = await authedFetch(`/api/insights?profile_id=${profileId}`, token)
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      setItems(body.insights || [])
      setError(null)
    } catch (e) { setError(e.message); setItems([]) }
  }
  useEffect(() => { refresh() /* eslint-disable-next-line */ }, [profileId, token])

  // Refresh whenever ReferenceVideosPanel signals a new analyze.
  useEffect(() => {
    const onChanged = (e) => {
      if (e.detail?.profileId === profileId) refresh()
    }
    window.addEventListener('voice-training:insights-changed', onChanged)
    return () => window.removeEventListener('voice-training:insights-changed', onChanged)
    /* eslint-disable-next-line */
  }, [profileId, token])

  const act = async (id, action) => {
    setBusyId(id); setError(null)
    try {
      const r = await authedFetch('/api/insights', token, {
        method: 'PATCH',
        body: JSON.stringify({ id, action }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      setItems((arr) => (arr || []).filter((x) => x.id !== id))
    } catch (e) { setError(e.message) }
    finally { setBusyId(null) }
  }

  return (
    <Section
      title="Insights to review"
      hint="Patterns Claude extracted from your reference videos. Approve to merge into hooks / scripts / voice summary; reject to drop."
    >
      {error && <ErrorPill message={error} />}
      {!items ? <Loading /> : items.length === 0 ? (
        <Empty msg="No pending insights. Add a reference video above and click Analyze." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((i) => (
            <InsightRow
              key={i.id}
              row={i}
              busy={busyId === i.id}
              onApprove={() => act(i.id, 'approve')}
              onReject={() => act(i.id, 'reject')}
            />
          ))}
        </div>
      )}
    </Section>
  )
}

function InsightRow({ row, busy, onApprove, onReject }) {
  const t = row.insight_type
  const fit = row.payload?.fit || 'medium'
  const fitColor = fit === 'high' ? '#2ecc71' : fit === 'low' ? 'var(--muted)' : 'var(--amber)'
  return (
    <div style={{ padding: 10, borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
        <Pill style={pillForType(t)}>{t.replace(/_/g, ' ')}</Pill>
        <span style={{ fontSize: 9.5, color: fitColor, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          fit: {fit}
        </span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-display)', fontWeight: 700, marginBottom: 4 }}>
        {row.title || '(untitled)'}
      </div>
      {row.payload?.description && (
        <div style={{ fontSize: 11.5, color: 'var(--text-soft)', lineHeight: 1.5, marginBottom: 6 }}>
          {row.payload.description}
        </div>
      )}
      {row.payload?.example && (
        <div style={{
          fontSize: 11.5, color: 'var(--text)', lineHeight: 1.5,
          padding: '6px 10px', background: 'var(--surface-2)', borderLeft: '2px solid var(--red)',
          borderRadius: 4, marginBottom: 8, fontStyle: 'italic',
        }}>"{row.payload.example}"</div>
      )}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onReject} disabled={busy} style={btnSmallGhost}>
          {busy ? <Loader2 size={11} className="spin" /> : <X size={11} />} Reject
        </button>
        <button type="button" onClick={onApprove} disabled={busy} style={btnSmallPrimary}>
          {busy ? <Loader2 size={11} className="spin" /> : <Check size={11} />} Approve
        </button>
      </div>
    </div>
  )
}

function StatusBadge({ status, error }) {
  const map = {
    pending:      { color: 'var(--muted)', label: 'queued' },
    transcribing: { color: 'var(--amber)', label: 'transcribing…' },
    ready:        { color: '#2ecc71',     label: 'ready' },
    failed:       { color: 'var(--red)',  label: 'failed' },
  }
  const m = map[status] || { color: 'var(--muted)', label: status }
  return (
    <span title={error || ''} style={{ color: m.color, fontWeight: 700, textTransform: 'uppercase', fontSize: 9.5, letterSpacing: '0.06em' }}>
      {m.label}
    </span>
  )
}

function pillForType(t) {
  const colors = {
    hook_pattern:      { bg: 'rgba(245,158,11,0.16)', fg: '#f59e0b' },
    structural_beat:   { bg: 'rgba(96,165,250,0.16)', fg: '#60a5fa' },
    vocabulary:        { bg: 'rgba(168,85,247,0.16)', fg: '#a78bfa' },
    pacing:            { bg: 'rgba(46,204,113,0.16)', fg: '#2ecc71' },
    cta_pattern:       { bg: 'rgba(236,72,153,0.16)', fg: '#f472b6' },
    audience_signal:   { bg: 'rgba(34,211,238,0.16)', fg: '#22d3ee' },
    adaptable_element: { bg: 'rgba(46,204,113,0.20)', fg: '#2ecc71' },
    conflict:          { bg: 'rgba(239,68,68,0.18)',  fg: 'var(--red)' },
  }
  return colors[t] || {}
}

const btnSmall = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 8px', borderRadius: 6,
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  color: 'var(--text)', fontSize: 11, fontWeight: 600,
  cursor: 'pointer', fontFamily: 'inherit',
}
const btnSmallPrimary = {
  ...btnSmall,
  background: 'linear-gradient(135deg, #2ecc71, #1ea860)',
  color: '#fff', borderColor: 'transparent',
}
const btnSmallGhost = {
  ...btnSmall,
  background: 'transparent', color: 'var(--muted)',
}

// ── Reference scripts ────────────────────────────────────────────────────────
function ScriptsPanel({ profileId, session }) {
  const [items, setItems] = useState(null)
  const [draft, setDraft] = useState({ text: '', hook: '', format: '', notes: '', rating: 1 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const refresh = async () => {
    if (!session?.access_token) return
    try {
      const r = await authedFetch(`/api/brand-scripts?profile_id=${profileId}`, session.access_token)
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Failed')
      setItems(body.scripts || [])
    } catch (e) { setError(e.message); setItems([]) }
  }
  useEffect(() => { refresh() /* eslint-disable-next-line */ }, [profileId, session?.access_token])

  const add = async () => {
    if (!draft.text.trim()) return
    setBusy(true); setError(null)
    try {
      const r = await authedFetch('/api/brand-scripts', session.access_token, {
        method: 'POST',
        body: JSON.stringify({ profile_id: profileId, ...draft }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Failed')
      setDraft({ text: '', hook: '', format: '', notes: '', rating: 1 })
      refresh()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const updateOne = async (id, patch) => {
    try {
      const r = await authedFetch(`/api/brand-scripts?id=${id}`, session.access_token, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      if (!r.ok) throw new Error('Update failed')
      refresh()
    } catch (e) { setError(e.message) }
  }

  const remove = async (id) => {
    if (!window.confirm('Delete this reference script?')) return
    try {
      await authedFetch(`/api/brand-scripts?id=${id}`, session.access_token, { method: 'DELETE' })
      refresh()
    } catch {}
  }

  return (
    <Section
      title="Reference scripts"
      hint={`Paste real scripts in the brand's voice — your own past hits, or examples you want to emulate. Generation uses your “loved” scripts as few-shot examples.`}
    >
      {error && <ErrorPill message={error} />}

      {/* Add new */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 10 }}>
        <textarea
          className="textarea"
          placeholder="Paste a full script here. 1-3 sentence hook + body works best."
          value={draft.text}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          style={{ width: '100%', minHeight: 90, fontSize: 13, marginBottom: 8 }}
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 8 }}>
          <input
            className="input" placeholder="Format (story, listicle, etc.)"
            value={draft.format}
            onChange={(e) => setDraft({ ...draft, format: e.target.value })}
            style={{ fontSize: 12 }}
          />
          <input
            className="input" placeholder="Notes (what's good about it?)"
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            style={{ fontSize: 12 }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <RatingPicker value={draft.rating} onChange={(r) => setDraft({ ...draft, rating: r })} />
          <button
            type="button" className="btn-primary"
            onClick={add} disabled={busy || !draft.text.trim()}
            style={{ marginLeft: 'auto', fontSize: 12, padding: '6px 12px' }}
          >
            <Plus size={11} /> Add script
          </button>
        </div>
      </div>

      {/* List */}
      {items === null ? <Loading /> : items.length === 0 ? (
        <Empty msg="No reference scripts yet. Paste 3-5 of the brand's best to teach it the voice." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((s) => (
            <div key={s.id} style={rowStyle(s.rating)}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.5 }}>
                  {(s.text || '').slice(0, 280)}{s.text?.length > 280 ? '…' : ''}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {s.format && <Pill>{s.format}</Pill>}
                  {s.notes && <Pill style={{ background: 'rgba(46,204,113,0.12)', color: '#2ecc71', borderColor: 'rgba(46,204,113,0.25)' }}>“{s.notes}”</Pill>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <RatingButton on={s.rating === 1} onClick={() => updateOne(s.id, { rating: s.rating === 1 ? 0 : 1 })} kind="up" />
                <RatingButton on={s.rating === -1} onClick={() => updateOne(s.id, { rating: s.rating === -1 ? 0 : -1 })} kind="down" />
                <IconBtn onClick={() => remove(s.id)} title="Delete">
                  <Trash2 size={11} />
                </IconBtn>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

// ── Hooks ────────────────────────────────────────────────────────────────────
function HooksPanel({ profileId, session }) {
  const [items, setItems] = useState(null)
  const [draft, setDraft] = useState({ hook: '', rating: 1 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const refresh = async () => {
    if (!session?.access_token) return
    try {
      const r = await authedFetch(`/api/brand-hooks?profile_id=${profileId}`, session.access_token)
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Failed')
      setItems(body.hooks || [])
    } catch (e) { setError(e.message); setItems([]) }
  }
  useEffect(() => { refresh() /* eslint-disable-next-line */ }, [profileId, session?.access_token])

  const add = async () => {
    if (!draft.hook.trim()) return
    setBusy(true); setError(null)
    try {
      const r = await authedFetch('/api/brand-hooks', session.access_token, {
        method: 'POST',
        body: JSON.stringify({ profile_id: profileId, hook: draft.hook, rating: draft.rating }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Failed')
      setDraft({ hook: '', rating: 1 })
      refresh()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const updateOne = async (id, patch) => {
    try {
      await authedFetch(`/api/brand-hooks?id=${id}`, session.access_token, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      refresh()
    } catch (e) { setError(e.message) }
  }
  const remove = async (id) => {
    if (!window.confirm('Delete this hook?')) return
    try {
      await authedFetch(`/api/brand-hooks?id=${id}`, session.access_token, { method: 'DELETE' })
      refresh()
    } catch {}
  }

  return (
    <Section
      title="Approved opener hooks"
      hint="Save the opening lines that work. Generation rotates through these instead of defaulting to its own pattern."
    >
      {error && <ErrorPill message={error} />}

      <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'flex-start' }}>
        <input
          className="input"
          placeholder='e.g. "Most relationship advice gets this wrong:"'
          value={draft.hook}
          onChange={(e) => setDraft({ ...draft, hook: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }}
          style={{ flex: 1, fontSize: 12.5 }}
        />
        <RatingPicker value={draft.rating} onChange={(r) => setDraft({ ...draft, rating: r })} />
        <button
          type="button" className="btn-secondary"
          onClick={add} disabled={busy || !draft.hook.trim()}
          style={{ fontSize: 12, padding: '6px 12px' }}
        ><Plus size={11} /> Add</button>
      </div>

      {items === null ? <Loading /> : items.length === 0 ? (
        <Empty msg="No hooks saved yet. Add 5-10 openers you'd actually use." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((h) => (
            <div key={h.id} style={rowStyle(h.rating)}>
              <div style={{ flex: 1, fontSize: 12.5, color: 'var(--text)' }}>{h.hook}</div>
              <div style={{ display: 'flex', gap: 4 }}>
                <RatingButton on={h.rating === 1} onClick={() => updateOne(h.id, { rating: h.rating === 1 ? 0 : 1 })} kind="up" />
                <RatingButton on={h.rating === -1} onClick={() => updateOne(h.id, { rating: h.rating === -1 ? 0 : -1 })} kind="down" />
                <IconBtn onClick={() => remove(h.id)} title="Delete">
                  <Trash2 size={11} />
                </IconBtn>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

// ── Hard rules ───────────────────────────────────────────────────────────────
function RulesPanel({ doNotSay, alwaysInclude, onChange }) {
  return (
    <Section
      title="Hard rules"
      hint="Strict instructions for every generation. Do-not-say is enforced word-for-word; always-include picks one item per script."
    >
      <RuleList
        title="Do NOT say"
        icon={X}
        items={doNotSay}
        onChange={(arr) => onChange('do_not_say', arr)}
        placeholder='e.g. "synergy", "leverage" (as a verb)'
      />
      <div style={{ height: 12 }} />
      <RuleList
        title="ALWAYS include (one of)"
        icon={Sparkles}
        items={alwaysInclude}
        onChange={(arr) => onChange('always_include', arr)}
        placeholder='e.g. "ship it", "scale 10x"'
      />
    </Section>
  )
}

function RuleList({ title, icon: Icon, items, onChange, placeholder }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim()
    if (!v) return
    onChange([...(items || []), v].slice(0, 50))
    setDraft('')
  }
  const remove = (i) => onChange((items || []).filter((_, j) => j !== i))
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Icon size={11} style={{ color: 'var(--muted)' }} />
        <div style={{ fontSize: 11.5, fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--text-soft)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{title}</div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input
          className="input" value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder={placeholder}
          style={{ flex: 1, fontSize: 12.5 }}
        />
        <button type="button" className="btn-secondary" onClick={add} disabled={!draft.trim()} style={{ fontSize: 12, padding: '6px 12px' }}>Add</button>
      </div>
      {(items || []).length === 0 ? (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', fontStyle: 'italic' }}>None set.</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(items || []).map((t, i) => (
            <span key={i} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 11.5, padding: '4px 8px', borderRadius: 999,
              background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)',
            }}>
              {t}
              <button type="button" onClick={() => remove(i)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0 }}>
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Shared mini-components ───────────────────────────────────────────────────
function Section({ title, hint, children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12.5, color: 'var(--text)' }}>{title}</div>
      </div>
      {hint && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>{hint}</div>}
      {children}
    </div>
  )
}
function Loading() { return <div style={{ padding: 8, fontSize: 12, color: 'var(--muted)' }}>Loading…</div> }
function Empty({ msg }) { return <div style={{ padding: 12, fontSize: 12, color: 'var(--muted)', textAlign: 'center', background: 'var(--surface)', border: '1px dashed var(--border)', borderRadius: 8 }}>{msg}</div> }
function ErrorPill({ message }) { return <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '6px 10px', borderRadius: 6, fontSize: 12, marginBottom: 8 }}><AlertCircle size={11} style={{ marginRight: 5, verticalAlign: '-1px' }} />{message}</div> }
function Pill({ children, style }) { return <span style={{ fontSize: 10.5, padding: '2px 7px', borderRadius: 999, background: 'var(--surface-2)', color: 'var(--text-soft)', border: '1px solid var(--border)', ...style }}>{children}</span> }
function rowStyle(rating) {
  return {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 10px', borderRadius: 8,
    background: rating === 1 ? 'rgba(46,204,113,0.06)' : rating === -1 ? 'rgba(239,68,68,0.06)' : 'var(--surface)',
    border: `1px solid ${rating === 1 ? 'rgba(46,204,113,0.30)' : rating === -1 ? 'rgba(239,68,68,0.30)' : 'var(--border)'}`,
  }
}
function RatingPicker({ value, onChange }) {
  return (
    <div style={{ display: 'inline-flex', gap: 4 }}>
      <RatingButton on={value === 1} onClick={() => onChange(value === 1 ? 0 : 1)} kind="up" />
      <RatingButton on={value === -1} onClick={() => onChange(value === -1 ? 0 : -1)} kind="down" />
    </div>
  )
}
function RatingButton({ on, onClick, kind }) {
  const Icon = kind === 'up' ? ThumbsUp : ThumbsDown
  const onColor = kind === 'up' ? '#2ecc71' : 'var(--red)'
  return (
    <button
      type="button" onClick={onClick}
      title={kind === 'up' ? 'Like' : 'Dislike'}
      style={{
        width: 24, height: 24, borderRadius: 6,
        background: on ? (kind === 'up' ? 'rgba(46,204,113,0.16)' : 'rgba(239,68,68,0.16)') : 'transparent',
        border: `1px solid ${on ? onColor : 'var(--border)'}`,
        color: on ? onColor : 'var(--muted)',
        cursor: 'pointer', display: 'grid', placeItems: 'center',
      }}
    ><Icon size={11} /></button>
  )
}
function IconBtn({ children, onClick, title }) {
  return (
    <button type="button" onClick={onClick} title={title} style={{ width: 24, height: 24, borderRadius: 6, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
      {children}
    </button>
  )
}
