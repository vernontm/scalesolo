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
      // Kick off segmentation in the background — the per-video page
      // polls for status and renders the map when it transitions to
      // 'mapped'. Don't await: navigate immediately so the user sees
      // a "mapping…" state instead of staring at the form.
      authedFetch('/api/studio/generate-map', session.access_token, {
        method: 'POST',
        body: JSON.stringify({ studio_video_id: data.video.id }),
      }).catch(() => { /* failures surface on the per-video page via status='failed' */ })
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

// ── Per-video editor ────────────────────────────────────────────────────────
// While task #7 (full editable video map table) is in flight, this view
// already loads the segments and renders a read-only preview so we can
// confirm the segmentation pass is producing sane output end-to-end.
function StudioVideoEditor({ videoId }) {
  const { session } = useAuth()
  const navigate = useNavigate()
  const [video, setVideo] = useState(null)
  const [error, setError] = useState(null)

  // Load + poll. Polls every 2s while status is 'mapping' or
  // 'rendering', stops on terminal states. Realtime subscription
  // arrives in task #7; polling is fine for now.
  useEffect(() => {
    if (!session?.access_token) return
    let cancelled = false
    let timer = null

    const tick = async () => {
      try {
        const r = await authedFetch(`/api/studio/videos?id=${videoId}`, session.access_token)
        const b = await r.json()
        if (cancelled) return
        if (!r.ok) { setError(b.error || 'Could not load video'); return }
        setVideo(b.video)
        if (['mapping', 'rendering'].includes(b.video?.status)) {
          timer = setTimeout(tick, 2000)
        }
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
    }
    tick()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [videoId, session?.access_token])

  const regenerate = async () => {
    if (!session?.access_token || !video) return
    setVideo({ ...video, status: 'mapping', error: null })
    try {
      const r = await authedFetch('/api/studio/generate-map', session.access_token, {
        method: 'POST', body: JSON.stringify({ studio_video_id: video.id }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || 'Could not regenerate')
      setVideo(b.video)
      toast({ message: 'Map regenerated.', kind: 'success' })
    } catch (e) {
      setVideo({ ...video, status: 'failed', error: e.message })
      toast({ message: e.message, kind: 'error' })
    }
  }

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
            action={['mapped', 'failed', 'editing'].includes(video.status) && (
              <button className="btn-secondary" onClick={regenerate}>
                <Wand2 size={13} /> Regenerate map
              </button>
            )}
          />

          {video.status === 'mapping' && (
            <div className="card" style={{ padding: 28, textAlign: 'center' }}>
              <Loader2 size={24} className="spin" style={{ color: 'var(--red)' }} />
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, margin: '12px 0 4px' }}>
                Drafting your video map…
              </h2>
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                Claude is beating the script into segments in your brand voice. Usually 10 to 30 seconds.
              </div>
            </div>
          )}

          {video.status === 'failed' && (
            <div className="card" style={{ padding: 24, borderColor: 'rgba(239,68,68,0.45)' }}>
              <div style={{ color: 'var(--red)', fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>Mapping failed</div>
              <div style={{ fontSize: 13, color: 'var(--text-soft)' }}>{video.error || 'Unknown error'}</div>
              <button className="btn-primary" style={{ marginTop: 12 }} onClick={regenerate}>
                <Wand2 size={13} /> Try again
              </button>
            </div>
          )}

          {(['mapped', 'editing', 'rendering', 'rendered'].includes(video.status)) && (
            <SegmentList video={video} />
          )}

          {video.status === 'draft' && (
            <Empty msg="Draft created but mapping has not been kicked off yet. Hit Regenerate map to start." />
          )}
        </>
      )}
    </div>
  )
}

function SegmentList({ video }) {
  const segments = (video.studio_segments || []).slice().sort((a, b) => a.segment_index - b.segment_index)
  return (
    <div>
      {video.script_full_text && (
        <div className="card" style={{ padding: 16, marginBottom: 16, background: 'var(--surface-2)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
            Full script
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>
            {video.script_full_text}
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
        {segments.length} segments · read-only preview
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {segments.map((s) => (
          <div key={s.id} className="card-flat" style={{ padding: 14, background: 'var(--surface-2)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 8,
                background: 'var(--surface)', border: '1px solid var(--border)',
                display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700,
                color: 'var(--muted)', flexShrink: 0,
              }}>
                {s.segment_index + 1}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                  <SegmentTypeBadge type={s.segment_type} />
                  {s.hyperframes_composition_id && (
                    <span style={{ fontSize: 10.5, color: 'var(--muted)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '2px 6px', borderRadius: 4 }}>
                      {s.hyperframes_composition_id}
                    </span>
                  )}
                  {s.transition_in && s.transition_in !== 'cut' && (
                    <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>↪ {s.transition_in}</span>
                  )}
                  {s.sound_effect && (
                    <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>♪ {s.sound_effect}</span>
                  )}
                </div>
                {s.script_text && (
                  <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text)', marginBottom: 4 }}>
                    {s.script_text}
                  </div>
                )}
                {s.image_prompt && (
                  <div style={{ fontSize: 11.5, color: 'var(--text-soft)', fontStyle: 'italic' }}>
                    B-roll: {s.image_prompt}
                  </div>
                )}
                {s.motion_gesture_prompt && (
                  <div style={{ fontSize: 11.5, color: 'var(--text-soft)' }}>
                    Direction: {s.motion_gesture_prompt}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16, fontSize: 11.5, color: 'var(--muted)', textAlign: 'center' }}>
        Editable table + HyperFrames previews land in the next iterations.
      </div>
    </div>
  )
}

function SegmentTypeBadge({ type }) {
  const palette = {
    avatar:                     { label: 'Avatar',    bg: 'rgba(239,68,68,0.16)',   fg: 'var(--red)' },
    voiceover_broll:            { label: 'B-roll',    bg: 'rgba(99,102,241,0.16)',  fg: '#818cf8'    },
    voiceover_motion_graphics:  { label: 'Motion',    bg: 'rgba(245,158,11,0.16)',  fg: '#fbbf24'    },
    pure_motion_graphics:       { label: 'Sting',     bg: 'rgba(46,204,113,0.16)',  fg: '#2ecc71'    },
  }
  const p = palette[type] || { label: type, bg: 'var(--surface)', fg: 'var(--text-soft)' }
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
      background: p.bg, color: p.fg, letterSpacing: '0.02em',
    }}>
      {p.label}
    </span>
  )
}
