import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Clapperboard, Sparkles, ArrowRight, AlertCircle, Check, RefreshCw, Lightbulb, User, Play } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'

const ACCENT = '#0ea5e9'
const ASPECTS = [
  { key: '9:16', label: 'Vertical', hint: 'TikTok / Reels / Shorts' },
  { key: '1:1', label: 'Square', hint: 'Feed' },
  { key: '16:9', label: 'Wide', hint: 'YouTube' },
]

const PROGRESS_MSGS = [
  'Writing your script in your brand voice…',
  'Filming your avatar…',
  'Designing the walkthrough scenes…',
  'Syncing captions to your words…',
  'Baking the final video…',
  'Almost done…',
]

// Resolve a picked avatar (user avatar or admin default) into the compact
// avatar_ref the backend needs to drive HeyGen.
function toAvatarRef(a) {
  if (a.is_default) {
    const look = (a.looks || [])[0] || {}
    return {
      kind: 'default', default_avatar_id: a.id, heygen_group_id: a.heygen_group_id || null,
      heygen_look_id: look.heygen_look_id || null, thumbnail: a.preview_image_url || look.image_url || null,
      voice_id: a.effective_voice_id || a.elevenlabs_voice_id || null, name: a.name || 'Avatar',
    }
  }
  const look = (a.looks || [])[0] || {}
  const img = (look.images || [])[0] || {}
  return {
    kind: 'avatar', avatar_id: a.id, heygen_group_id: a.heygen_group_id || null,
    heygen_look_id: look.heygen_look_id || null, talking_photo_id: a.talking_photo_id || null,
    photo_url: a.photo_url || img.image_url || null, thumbnail: a.thumbnail_url || img.image_url || a.photo_url || null,
    voice_id: a.elevenlabs_voice_id || null, model_version: a.model_version || null, name: a.name || 'Avatar',
  }
}

export default function WalkthroughBuilder() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  const navigate = useNavigate()

  const [topic, setTopic] = useState('')
  const [ideas, setIdeas] = useState([])
  const [ideasLoading, setIdeasLoading] = useState(false)
  const [avatars, setAvatars] = useState([])       // combined selectable list
  const [avatarKey, setAvatarKey] = useState(null) // selected avatar identity
  const [voices, setVoices] = useState([])
  const [voiceId, setVoiceId] = useState('')
  const [aspect, setAspect] = useState('9:16')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [row, setRow] = useState(null)             // walkthrough_videos row (script/status/final)
  const [progress, setProgress] = useState(null)   // { pct, msg }
  const progressTimer = useRef(null)
  const pollTimer = useRef(null)

  // Load avatars + voices + ideas on brand change.
  useEffect(() => {
    if (!selectedProfileId) return
    setRow(null); setError(null)
    ;(async () => {
      try {
        const r = await fetch(`/api/avatars?profile_id=${selectedProfileId}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
        const b = await r.json().catch(() => ({}))
        const mine = (b.avatars || []).filter((a) => (a.looks || []).length)
        const defaults = (b.default_avatars || [])
        const list = [...defaults, ...mine]
        setAvatars(list)
        if (list.length) {
          const first = list[0]
          setAvatarKey(first.is_default ? `d:${first.id}` : `a:${first.id}`)
          const ref = toAvatarRef(first)
          if (ref.voice_id) setVoiceId(ref.voice_id)
        }
      } catch {}
      try {
        const r = await fetch('/api/voices/library', { headers: { Authorization: `Bearer ${session.access_token}` } })
        const b = await r.json().catch(() => ({}))
        setVoices(b.shared || b.voices || [])
      } catch {}
      fetchIdeas()
    })()
    return () => { stopPoll(); stopProgress(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProfileId])

  const selectedAvatar = avatars.find((a) => (a.is_default ? `d:${a.id}` : `a:${a.id}`) === avatarKey)

  const fetchIdeas = async () => {
    if (!selectedProfileId) return
    setIdeasLoading(true)
    try {
      const r = await fetch('/api/walkthroughs/ideas', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ profile_id: selectedProfileId }),
      })
      const b = await r.json().catch(() => ({}))
      if (Array.isArray(b.ideas)) setIdeas(b.ideas)
    } catch {} finally { setIdeasLoading(false) }
  }

  const startProgress = (expectMs) => {
    const t0 = Date.now()
    setProgress({ pct: 3, msg: PROGRESS_MSGS[0] })
    progressTimer.current = setInterval(() => {
      const pct = Math.min(94, Math.round(((Date.now() - t0) / expectMs) * 100))
      const msg = PROGRESS_MSGS[Math.min(PROGRESS_MSGS.length - 1, Math.floor((pct / 95) * PROGRESS_MSGS.length))]
      setProgress((p) => ({ pct: Math.max(p?.pct || 0, pct), msg }))
    }, 500)
  }
  const stopProgress = (done) => {
    if (progressTimer.current) { clearInterval(progressTimer.current); progressTimer.current = null }
    if (done) { setProgress({ pct: 100, msg: 'Done!' }); setTimeout(() => setProgress(null), 800) } else setProgress(null)
  }
  const stopPoll = () => { if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null } }
  useEffect(() => () => { stopProgress(false); stopPoll() }, [])

  // Step 1: write the script + create the row.
  const generateScript = async () => {
    if (!topic.trim()) return
    if (!selectedProfileId) { setError('Pick a brand profile first.'); return }
    if (!selectedAvatar) { setError('Pick an avatar first.'); return }
    setBusy(true); setError(null); setRow(null)
    startProgress(9000)
    try {
      const r = await fetch('/api/walkthroughs/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          profile_id: selectedProfileId, topic: topic.trim(),
          avatar_ref: toAvatarRef(selectedAvatar), voice_id: voiceId || undefined, aspect_ratio: aspect,
        }),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b?.error || `Scripting failed (${r.status})`)
      stopProgress(true)
      setRow({ id: b.id, title: b.title, script: b.script, status: 'scripted' })
    } catch (e) { stopProgress(false); setError(e.message) } finally { setBusy(false) }
  }

  // Step 2: kick off the paid avatar + render pipeline, then poll to done.
  const makeVideo = async () => {
    if (!row?.id) return
    setBusy(true); setError(null)
    startProgress(180000)
    try {
      const r = await fetch('/api/walkthroughs/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ id: row.id }),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b?.error || `Generation failed (${r.status})`)
      setRow((cur) => ({ ...cur, status: b.status || 'generating' }))
      // Poll status until rendered/failed.
      pollTimer.current = setInterval(async () => {
        try {
          const sr = await fetch(`/api/walkthroughs?id=${row.id}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
          const sb = await sr.json().catch(() => ({}))
          const w = sb.walkthrough
          if (!w) return
          setRow((cur) => ({ ...cur, ...w }))
          if (w.status === 'rendered') { stopPoll(); stopProgress(true); setBusy(false) }
          else if (w.status === 'failed') { stopPoll(); stopProgress(false); setBusy(false); setError(w.error || 'Generation failed.') }
        } catch {}
      }, 5000)
    } catch (e) { stopProgress(false); setError(e.message); setBusy(false) }
  }

  const label = { fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }
  const segs = row?.script?.segments || []

  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {/* ── LEFT: preview ─────────────────────────────────────────────── */}
      <div style={{ flex: '1 1 320px', minWidth: 300, position: 'sticky', top: 12 }}>
        <div style={label}>Preview</div>
        {row?.final_url ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(46,204,113,0.12)', color: '#2ecc71', border: '1px solid rgba(46,204,113,0.35)', padding: '9px 12px', borderRadius: 10, fontSize: 13, marginBottom: 12 }}>
              <Check size={15} /> Your video is ready and saved to your Library.
            </div>
            <video src={row.final_url} controls playsInline style={{ width: '100%', borderRadius: 12, background: '#000', aspectRatio: aspect === '16:9' ? '16 / 9' : aspect === '1:1' ? '1 / 1' : '9 / 16', maxHeight: 520 }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn-primary" onClick={() => navigate('/library')} style={{ flex: 1, justifyContent: 'center' }}>Open in Library <ArrowRight size={15} /></button>
              <button className="btn-secondary" onClick={() => { setRow(null); setTopic('') }}>New</button>
            </div>
          </div>
        ) : segs.length ? (
          // Script preview (after step 1)
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              {selectedAvatar && <img src={toAvatarRef(selectedAvatar).thumbnail} alt="" style={{ width: 40, height: 40, borderRadius: 10, objectFit: 'cover', border: '1px solid var(--border)' }} />}
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 15, lineHeight: 1.2 }}>{row.title}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {segs.map((s, i) => (
                <div key={s.id} style={{ padding: 11, background: 'var(--surface-2)', borderRadius: 10, border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: ACCENT, marginBottom: 3 }}>{s.kind === 'intro' ? 'Hook' : s.kind === 'cta' ? 'Call to action' : `Point ${i}`} · {s.heading}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.5 }}>{s.narration}</div>
                </div>
              ))}
            </div>
            <button className="btn-primary" onClick={makeVideo} disabled={busy} style={{ width: '100%', justifyContent: 'center', marginTop: 14 }}>
              <Play size={15} /> Make the video
            </button>
            <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>Films your avatar and bakes the walkthrough. Takes a couple minutes.</div>
          </div>
        ) : (
          <div style={{ aspectRatio: aspect === '16:9' ? '16 / 9' : aspect === '1:1' ? '1 / 1' : '9 / 16', maxHeight: 520, borderRadius: 14, border: '1px dashed var(--border)', background: 'var(--surface)', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
            <div>
              {selectedAvatar ? (
                <img src={toAvatarRef(selectedAvatar).thumbnail} alt="" style={{ width: 84, height: 84, borderRadius: 18, objectFit: 'cover', margin: '0 auto 12px', border: '1px solid var(--border)' }} />
              ) : (
                <div style={{ width: 84, height: 84, borderRadius: 18, background: 'var(--surface-2)', display: 'grid', placeItems: 'center', margin: '0 auto 12px' }}><User size={30} style={{ color: 'var(--muted)' }} /></div>
              )}
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Your walkthrough appears here after you generate.</div>
            </div>
          </div>
        )}
      </div>

      {/* ── RIGHT: form ───────────────────────────────────────────────── */}
      <div style={{ flex: '1 1 420px', minWidth: 320 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'rgba(14,165,233,0.14)', color: ACCENT }}><Clapperboard size={19} /></div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 21, fontWeight: 800 }}>AI Walkthrough</h2>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 18 }}>Pick your avatar and a voice, give it a topic. It writes the script, films your avatar, and bakes a captioned walkthrough into your Library.</p>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 18 }}>
          {/* Topic + ideas */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ ...label, marginBottom: 0, flex: 1 }}>Topic</div>
              <button onClick={fetchIdeas} disabled={ideasLoading} title="New ideas" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>
                <RefreshCw size={12} style={{ animation: ideasLoading ? 'spin 1s linear infinite' : 'none' }} /> Ideas
              </button>
            </div>
            {ideas.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {ideas.map((idea, i) => (
                  <button key={i} onClick={() => setTopic(idea)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '5px 10px', borderRadius: 999, cursor: 'pointer', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-soft)', textAlign: 'left' }}>
                    <Lightbulb size={12} style={{ color: ACCENT, flexShrink: 0 }} /> {idea}
                  </button>
                ))}
              </div>
            )}
            <textarea className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What should this video teach or show?" rows={2} style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }} />
          </div>

          {/* Avatar */}
          <div style={{ marginBottom: 16 }}>
            <div style={label}>Avatar</div>
            {avatars.length ? (
              <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
                {avatars.map((a) => {
                  const key = a.is_default ? `d:${a.id}` : `a:${a.id}`
                  const ref = toAvatarRef(a)
                  const on = key === avatarKey
                  return (
                    <button key={key} onClick={() => { setAvatarKey(key); if (ref.voice_id) setVoiceId(ref.voice_id) }} title={ref.name}
                      style={{ flex: '0 0 auto', width: 66, cursor: 'pointer', border: 'none', background: 'transparent', padding: 0 }}>
                      <img src={ref.thumbnail} alt={ref.name} style={{ width: 66, height: 82, borderRadius: 10, objectFit: 'cover', border: `2px solid ${on ? ACCENT : 'var(--border)'}`, opacity: on ? 1 : 0.7 }} />
                      <div style={{ fontSize: 10.5, color: on ? ACCENT : 'var(--muted)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: on ? 700 : 500 }}>{ref.name}</div>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 0' }}>No avatars yet. Add one on the <button onClick={() => navigate('/avatars')} style={{ color: ACCENT, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>Avatars</button> page.</div>
            )}
          </div>

          {/* Voice */}
          <div style={{ marginBottom: 16 }}>
            <div style={label}>Voice</div>
            <select className="input" value={voiceId} onChange={(e) => setVoiceId(e.target.value)} style={{ width: '100%', boxSizing: 'border-box' }}>
              <option value="">Brand default voice</option>
              {voices.map((v) => (<option key={v.voice_id} value={v.voice_id}>{v.name}{v.category ? ` · ${v.category}` : ''}</option>))}
            </select>
          </div>

          {/* Aspect */}
          <div style={{ marginBottom: 16 }}>
            <div style={label}>Format</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {ASPECTS.map((o) => (
                <button key={o.key} onClick={() => setAspect(o.key)} title={o.hint} style={{ flex: 1, padding: '9px 6px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${aspect === o.key ? ACCENT : 'var(--border)'}`, background: aspect === o.key ? 'rgba(14,165,233,0.12)' : 'var(--surface-2)', color: aspect === o.key ? ACCENT : 'var(--text)', fontWeight: 600, fontSize: 12.5 }}>{o.label}</button>
              ))}
            </div>
          </div>

          {error && <div style={{ marginBottom: 14, background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13 }}><AlertCircle size={14} style={{ verticalAlign: '-2px' }} /> {error}</div>}
          <button className="btn-primary" onClick={generateScript} disabled={busy || !topic.trim() || !selectedAvatar} style={{ width: '100%', justifyContent: 'center' }}>
            <Sparkles size={15} /> {row ? 'Rewrite script' : 'Write my script'}
          </button>
          <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>
            Step 1 writes the script (free). Making the video uses AI credits.
          </div>
        </div>
      </div>

      {/* ── Progress popup ────────────────────────────────────────────── */}
      {progress && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', zIndex: 300, backdropFilter: 'blur(3px)' }}>
          <div style={{ width: 'min(90vw, 360px)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 26, textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
            <div style={{ width: 54, height: 54, margin: '0 auto 14px', borderRadius: 14, display: 'grid', placeItems: 'center', background: 'rgba(14,165,233,0.14)', color: ACCENT, animation: 'pulse 1.4s ease-in-out infinite' }}>
              <Clapperboard size={26} />
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Building your walkthrough</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', minHeight: 34, marginBottom: 14 }}>{progress.msg}</div>
            <div style={{ height: 8, borderRadius: 999, background: 'var(--surface-3, var(--surface-2))', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${progress.pct}%`, background: `linear-gradient(90deg, ${ACCENT}, #6366f1)`, borderRadius: 999, transition: 'width .5s ease' }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>{progress.pct}%</div>
          </div>
          <style>{`@keyframes pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.08);opacity:.75}}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      )}
    </div>
  )
}
