// Studio v1 — long-form video generation.
//
// Two views:
//   /studio       — list of recent videos + "Create new video" form
//   /studio/:id   — per-video editor (StudioVideoEditor below) — placeholder
//                   until the video map UI lands in task #7.
//
// Visible only to users on STUDIO_BETA_USER_IDS (gate enforced in App.jsx).

import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Film, Sparkles, Plus, ArrowLeft, Wand2, Loader2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { toast } from '../components/Toast.jsx'

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

export default function Studio() {
  const { id } = useParams()
  if (id) return <StudioVideoEditor videoId={id} />
  return <StudioHome />
}

// ── Home: recent video list + new-video form ────────────────────────────────
function StudioHome() {
  const { session } = useAuth()
  const { selectedProfileId, selectedProfile } = useProfile()
  const navigate = useNavigate()
  const [videos, setVideos] = useState(null)        // null = loading, [] = empty
  const [showForm, setShowForm] = useState(false)

  // Load recent videos when the active profile changes.
  useEffect(() => {
    if (!selectedProfileId || !session?.access_token) { setVideos([]); return }
    let cancelled = false
    setVideos(null)
    authedFetch(`/api/studio/videos?profile_id=${selectedProfileId}`, session.access_token)
      .then((r) => r.ok ? r.json() : { videos: [] })
      .then((b) => { if (!cancelled) setVideos(b.videos || []) })
      .catch(() => { if (!cancelled) setVideos([]) })
    return () => { cancelled = true }
  }, [selectedProfileId, session?.access_token])

  // First-time UX: if there are no videos yet, drop the user straight
  // into the new-video form instead of staring at an empty list.
  useEffect(() => {
    if (videos !== null && videos.length === 0) setShowForm(true)
  }, [videos])

  return (
    <div className="fade-up" style={{ maxWidth: 1080, margin: '0 auto', padding: '32px 24px' }}>
      <Header
        title="Studio"
        subtitle={`Long-form video generation${selectedProfile ? ` for ${selectedProfile.business_name}` : ''}.`}
        action={!showForm && videos?.length > 0 ? (
          <button className="btn-primary" onClick={() => setShowForm(true)}>
            <Plus size={14} /> New video
          </button>
        ) : null}
      />

      {showForm ? (
        <NewVideoForm
          profileId={selectedProfileId}
          onCancel={videos?.length ? () => setShowForm(false) : null}
          onCreated={(video) => navigate(`/studio/${video.id}`)}
        />
      ) : (
        <RecentVideos videos={videos} onOpen={(v) => navigate(`/studio/${v.id}`)} />
      )}
    </div>
  )
}

function Header({ title, subtitle, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12,
        background: 'rgba(239,68,68,0.16)', color: 'var(--red)',
        display: 'grid', placeItems: 'center', flexShrink: 0,
      }}>
        <Film size={20} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, margin: 0 }}>{title}</h1>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{subtitle}</div>
      </div>
      {action}
    </div>
  )
}

function RecentVideos({ videos, onOpen }) {
  if (videos === null) return <Empty msg={<><Loader2 size={14} className="spin" /> Loading…</>} />
  if (!videos.length) return null  // form is shown instead
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {videos.map((v) => (
        <button
          key={v.id}
          type="button"
          onClick={() => onOpen(v)}
          className="card-flat"
          style={{
            display: 'flex', alignItems: 'center', gap: 14,
            padding: 16, textAlign: 'left', cursor: 'pointer',
            background: 'var(--surface-2)', border: '1px solid var(--border)',
          }}
        >
          <div style={{
            width: 56, height: 56, borderRadius: 10,
            background: 'var(--surface)', border: '1px solid var(--border)',
            display: 'grid', placeItems: 'center', flexShrink: 0,
            color: 'var(--muted)',
          }}>
            <Film size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, marginBottom: 2 }}>
              {v.title || (v.topic_prompt || 'Untitled').slice(0, 80)}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {fmtStatus(v.status)} · {v.target_duration_secs}s · {v.aspect_ratio} · {new Date(v.created_at).toLocaleDateString()}
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}

function fmtStatus(s) {
  return ({
    draft:     'Draft',
    mapping:   'Mapping…',
    mapped:    'Ready for review',
    editing:   'Editing',
    rendering: 'Rendering…',
    rendered:  'Done',
    failed:    'Failed',
  })[s] || s
}

// ── Form ────────────────────────────────────────────────────────────────────
function NewVideoForm({ profileId, onCancel, onCreated }) {
  const { session } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [avatars, setAvatars] = useState([])
  const [voices, setVoices] = useState([])
  const [form, setForm] = useState({
    title: '',
    topic_prompt: '',
    reference_url: '',
    reference_text: '',
    avatar_id: '',
    voice_id: '',
    target_duration_secs: 120,
    aspect_ratio: '16:9',
  })
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  // Pull avatars + voices for the active profile so the dropdowns have
  // something to show. Both endpoints are tolerant of empty responses.
  useEffect(() => {
    if (!profileId || !session?.access_token) return
    let cancelled = false
    ;(async () => {
      try {
        const [a, v, vBYO] = await Promise.all([
          authedFetch(`/api/avatars?profile_id=${profileId}`, session.access_token).then((r) => r.ok ? r.json() : { avatars: [] }),
          authedFetch(`/api/voices/library`, session.access_token).then((r) => r.ok ? r.json() : { shared: [] }),
          authedFetch(`/api/voices/library?byo=1&profile_id=${profileId}`, session.access_token).then((r) => r.ok ? r.json() : { byok: [] }),
        ])
        if (cancelled) return
        setAvatars(a.avatars || [])
        setVoices([...(vBYO.byok || []), ...(v.shared || [])])
      } catch { /* dropdowns stay empty */ }
    })()
    return () => { cancelled = true }
  }, [profileId, session?.access_token])

  const submit = async (e) => {
    e?.preventDefault?.()
    if (!form.topic_prompt.trim()) {
      setError('Tell Claude what the video is about.')
      return
    }
    setBusy(true); setError(null)
    try {
      const body = {
        profile_id: profileId,
        title: form.title.trim() || null,
        topic_prompt: form.topic_prompt.trim(),
        reference_url: form.reference_url.trim() || null,
        reference_text: form.reference_text.trim() || null,
        avatar_id: form.avatar_id || null,
        voice_id: form.voice_id || null,
        target_duration_secs: Number(form.target_duration_secs) || 120,
        aspect_ratio: form.aspect_ratio,
      }
      const r = await authedFetch('/api/studio/videos', session.access_token, {
        method: 'POST', body: JSON.stringify(body),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Could not create video')
      toast({ message: 'Draft created. Generating the video map…', kind: 'success' })
      onCreated(data.video)
    } catch (e2) {
      setError(e2.message)
    } finally {
      setBusy(false)
    }
  }

  if (!profileId) {
    return <Empty msg="Pick a brand profile first to start a Studio video." />
  }

  return (
    <form onSubmit={submit} className="card" style={{ padding: 24 }}>
      {onCancel && (
        <button type="button" onClick={onCancel} className="btn-ghost" style={{ fontSize: 12, padding: '4px 8px', marginBottom: 12 }}>
          <ArrowLeft size={12} /> Back to videos
        </button>
      )}
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>New long-form video</h2>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 20 }}>
        Tell Claude what to make. We will draft a video map you can edit row by row before rendering.
      </div>

      <Field label="Topic" required hint="What is this video about? One or two sentences is fine.">
        <textarea
          className="input"
          rows={3}
          placeholder="A 90-second explainer on why faceless creators are out-shipping personal brands in 2026."
          value={form.topic_prompt}
          onChange={(e) => set('topic_prompt', e.target.value)}
          maxLength={2000}
        />
      </Field>

      <Field label="Title" hint="Optional. We will auto-generate one if you skip.">
        <input
          className="input"
          placeholder="Auto-generated from topic"
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
          maxLength={200}
        />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field label="Avatar">
          <select className="input" value={form.avatar_id} onChange={(e) => set('avatar_id', e.target.value)}>
            <option value="">Voiceover only (no avatar)</option>
            {avatars.map((a) => (
              <option key={a.id} value={a.id}>{a.name || a.id.slice(0, 8)}</option>
            ))}
          </select>
        </Field>

        <Field label="Voice">
          <select className="input" value={form.voice_id} onChange={(e) => set('voice_id', e.target.value)}>
            <option value="">Brand default</option>
            {voices.map((v) => (
              <option key={v.voice_id || v.id} value={v.voice_id || v.id}>
                {v.label || v.name || (v.voice_id || v.id).slice(0, 12)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Aspect ratio">
          <div style={{ display: 'flex', gap: 6 }}>
            {['16:9', '9:16', '1:1'].map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => set('aspect_ratio', r)}
                className={form.aspect_ratio === r ? 'btn-primary' : 'btn-secondary'}
                style={{ flex: 1, padding: '8px 6px', fontSize: 12, fontWeight: 700 }}
              >{r}</button>
            ))}
          </div>
        </Field>

        <Field label={`Length: ${form.target_duration_secs}s`} hint="30s to 5min for v1.">
          <input
            type="range"
            min={30} max={300} step={15}
            value={form.target_duration_secs}
            onChange={(e) => set('target_duration_secs', Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </Field>
      </div>

      <Field label="Reference video URL" hint="Optional. YouTube or other. We will pull the transcript as source material.">
        <input
          className="input"
          placeholder="https://youtube.com/watch?v=…"
          value={form.reference_url}
          onChange={(e) => set('reference_url', e.target.value)}
          maxLength={500}
        />
      </Field>

      <Field label="Reference text" hint="Optional. Paste an outline, data, transcript, or anything Claude should reference verbatim.">
        <textarea
          className="input"
          rows={5}
          placeholder="Paste your outline, transcript, or notes…"
          value={form.reference_text}
          onChange={(e) => set('reference_text', e.target.value)}
          maxLength={50000}
        />
      </Field>

      {error && (
        <div style={{
          background: 'rgba(239,68,68,0.12)', color: 'var(--red)',
          border: '1px solid rgba(239,68,68,0.35)', borderRadius: 8,
          padding: '8px 12px', marginTop: 12, fontSize: 12.5,
        }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn-primary" disabled={busy || !form.topic_prompt.trim()}>
          {busy ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
          {busy ? 'Creating…' : 'Generate video map'}
        </button>
      </div>
    </form>
  )
}

function Field({ label, required, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
        <label style={{ fontSize: 11.5, fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--text-soft)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {label}{required && <span style={{ color: 'var(--red)', marginLeft: 2 }}>*</span>}
        </label>
      </div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

function Empty({ msg }) {
  return (
    <div className="card-flat" style={{ padding: 28, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
      {msg}
    </div>
  )
}

// ── Per-video editor (placeholder until task #7 lands the video map) ─────────
function StudioVideoEditor({ videoId }) {
  const { session } = useAuth()
  const navigate = useNavigate()
  const [video, setVideo] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!session?.access_token) return
    let cancelled = false
    authedFetch(`/api/studio/videos?id=${videoId}`, session.access_token)
      .then(async (r) => {
        const b = await r.json()
        if (cancelled) return
        if (!r.ok) { setError(b.error || 'Could not load video'); return }
        setVideo(b.video)
      })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [videoId, session?.access_token])

  return (
    <div className="fade-up" style={{ maxWidth: 1080, margin: '0 auto', padding: '32px 24px' }}>
      <button type="button" className="btn-ghost" onClick={() => navigate('/studio')} style={{ fontSize: 12, padding: '4px 8px', marginBottom: 12 }}>
        <ArrowLeft size={12} /> All videos
      </button>

      {error ? (
        <Empty msg={error} />
      ) : !video ? (
        <Empty msg={<><Loader2 size={14} className="spin" /> Loading…</>} />
      ) : (
        <>
          <Header
            title={video.title || video.topic_prompt?.slice(0, 80) || 'Untitled video'}
            subtitle={`${fmtStatus(video.status)} · ${video.target_duration_secs}s · ${video.aspect_ratio}`}
          />
          <div className="card" style={{ padding: 28 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--red)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 12 }}>
              <Sparkles size={13} />
              Coming next
            </div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, margin: '0 0 8px' }}>
              The video map lives here.
            </h2>
            <p style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-soft)', margin: 0 }}>
              Topic: <strong style={{ color: 'var(--text)' }}>{video.topic_prompt}</strong>
              <br />Status: <strong style={{ color: 'var(--text)' }}>{video.status}</strong>
              <br />Segments: <strong style={{ color: 'var(--text)' }}>{video.studio_segments?.length || 0}</strong>
            </p>
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--muted)' }}>
              The Claude segmentation pass + video map table arrive in the next iteration.
            </div>
          </div>
        </>
      )}
    </div>
  )
}
