// Voice training panel — drops into the Profile editor. Collapsible.
// Three sub-panels: reference scripts, opener hooks, hard rules.
// All three feed into the system prompt that script_gen / caption_gen
// use, via api/content/generate.js.

import { useEffect, useState } from 'react'
import {
  Mic, ChevronRight, ThumbsUp, ThumbsDown, Trash2, Plus, X, Sparkles,
  AlertCircle, MessageSquare,
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
