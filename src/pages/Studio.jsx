// Studio v1 — long-form video generation.
//
// Two views:
//   /studio       — list of recent videos + "Create new video" form
//   /studio/:id   — per-video editor with editable video map table
//
// The video map table is the central editing surface. Each row is a
// studio_segment. Edits PATCH through /api/studio/segments on blur (text
// fields) or on change (selects, checkboxes). Realtime subscription on
// public.studio_segments streams server-side asset-generation updates
// (status changes, image_url / voice_url / avatar_video_url fills)
// back into the table without a refetch.
//
// Visible only to users on STUDIO_BETA_USER_IDS (gate enforced in App.jsx).

import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Film, Sparkles, Plus, ArrowLeft, Wand2, Loader2, Trash2, RefreshCw,
  CheckCircle2, Circle, AlertCircle, Image as ImageIcon, MoreVertical,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { toast, confirmDialog } from '../components/Toast.jsx'
import { supabase } from '../lib/supabase.js'

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
// Loads the video + segments, subscribes to Realtime so asset generation
// updates flow into the table without a refetch, and renders the
// editable video map. While status='mapping' a loading card replaces the
// table (segments don't exist yet). Once mapped, the table is live.
function StudioVideoEditor({ videoId }) {
  const { session } = useAuth()
  const navigate = useNavigate()
  const [video, setVideo] = useState(null)
  const [error, setError] = useState(null)

  // Initial load + lightweight refresh on focus. The Realtime channel
  // below handles ongoing updates; this is just the cold load.
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

  // Asset polling loop. While status='rendering', hit /api/studio/poll-assets
  // every 6s so Kie.ai and HeyGen job completions get pulled in. Realtime
  // also pushes the segment UPDATE events, so this is just the trigger that
  // makes the server-side check happen — the UI updates come through the
  // Realtime channel below.
  useEffect(() => {
    if (!session?.access_token || !videoId) return
    if (video?.status !== 'rendering') return
    let cancelled = false
    let timer = null

    const tick = async () => {
      try {
        await authedFetch(`/api/studio/poll-assets?studio_video_id=${videoId}`, session.access_token)
      } catch { /* network blip, just try again on the next tick */ }
      if (!cancelled) timer = setTimeout(tick, 6000)
    }
    // First tick after 2s so the initial dispatcher response renders before
    // the first poll starts hitting the DB.
    timer = setTimeout(tick, 2000)
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [video?.status, videoId, session?.access_token])

  // Realtime subscription: video status changes + per-segment updates
  // stream in without polling. Used for the mapping → mapped transition
  // and for live asset-generation status (pending → generating_image →
  // ready) — segment UPDATE events from /api/studio/poll-assets flow
  // through here.
  useEffect(() => {
    if (!videoId) return
    const channel = supabase
      .channel(`studio_video:${videoId}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'studio_videos', filter: `id=eq.${videoId}` },
        (payload) => {
          const row = payload.new
          if (!row) return
          // Preserve the inlined segments array, which doesn't exist on
          // the bare studio_videos row coming through Realtime.
          setVideo((prev) => prev ? { ...prev, ...row, studio_segments: prev.studio_segments } : row)
        })
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'studio_segments', filter: `studio_video_id=eq.${videoId}` },
        (payload) => {
          const row = payload.new
          if (!row) return
          setVideo((prev) => {
            if (!prev) return prev
            const segs = prev.studio_segments || []
            if (segs.some((s) => s.id === row.id)) return prev
            return { ...prev, studio_segments: [...segs, row] }
          })
        })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'studio_segments', filter: `studio_video_id=eq.${videoId}` },
        (payload) => {
          const row = payload.new
          if (!row) return
          setVideo((prev) => prev ? {
            ...prev,
            studio_segments: (prev.studio_segments || []).map((s) => s.id === row.id ? { ...s, ...row } : s),
          } : prev)
        })
      .on('postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'studio_segments', filter: `studio_video_id=eq.${videoId}` },
        (payload) => {
          const id = payload.old?.id
          if (!id) return
          setVideo((prev) => prev ? {
            ...prev,
            studio_segments: (prev.studio_segments || []).filter((s) => s.id !== id),
          } : prev)
        })
      .subscribe()
    return () => { try { channel.unsubscribe() } catch { /* noop */ } }
  }, [videoId])

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

// ── HyperFrames preview ─────────────────────────────────────────────────────
// Browser-side preview of a HyperFrames composition. Iframes the static
// HTML in public/studio-compositions/<id>.html and passes the segment's
// variables via the URL hash (base64'd JSON). Zero server cost — every
// chat-driven tweak just reloads the iframe with new vars.
//
// Schema for each composition is declared inline on its <html> tag as
// data-composition-variables. The mini editor below renders one input
// per declared variable so the user (or chat) can tweak without writing JSON.

const COMPOSITION_SCHEMAS = {
  'title-card-v1': [
    { id: 'title', label: 'Title', default: 'Faceless brands are quietly winning' },
    { id: 'subtitle', label: 'Subtitle', default: '' },
    { id: 'accent_word', label: 'Accent word in title', default: 'winning' },
    { id: 'accent_color', label: 'Accent color', type: 'color', default: '#e3151e' },
  ],
  'stat-reveal-v1': [
    { id: 'stat_number', label: 'Number', default: '403,840' },
    { id: 'stat_label', label: 'Label', default: 'VIEWS IN 20 DAYS' },
    { id: 'stat_caption', label: 'Caption', default: '' },
    { id: 'accent_color', label: 'Accent color', type: 'color', default: '#e3151e' },
  ],
  'list-overlay-v1': [
    { id: 'title', label: 'Headline', default: 'Three things faceless brands do right' },
    { id: 'bullets', label: 'Bullets (one per line)', type: 'textarea', default: '' },
    { id: 'accent_color', label: 'Accent color', type: 'color', default: '#e3151e' },
  ],
  'quote-card-v1': [
    { id: 'quote', label: 'Quote', type: 'textarea', default: '' },
    { id: 'attribution', label: 'Attribution', default: '' },
    { id: 'accent_color', label: 'Accent color', type: 'color', default: '#e3151e' },
  ],
  'lower-third-v1': [
    { id: 'name', label: 'Name', default: '' },
    { id: 'role', label: 'Role / handle', default: '' },
    { id: 'accent_color', label: 'Accent color', type: 'color', default: '#e3151e' },
  ],
  'comparison-v1': [
    { id: 'left_label', label: 'Left label', default: 'PERSONAL BRAND' },
    { id: 'left_text', label: 'Left description', type: 'textarea', default: '' },
    { id: 'right_label', label: 'Right label', default: 'FACELESS BRAND' },
    { id: 'right_text', label: 'Right description', type: 'textarea', default: '' },
    { id: 'accent_color', label: 'Accent color', type: 'color', default: '#e3151e' },
  ],
  'end-card-v1': [
    { id: 'title', label: 'Headline', default: 'Try ScaleSolo for $1.' },
    { id: 'subtitle', label: 'Subtitle', default: 'Three days. Every feature. No commitment.' },
    { id: 'cta', label: 'CTA', default: 'scalesolo.ai' },
    { id: 'accent_color', label: 'Accent color', type: 'color', default: '#e3151e' },
  ],
}

function encodeVars(vars) {
  try {
    return encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(vars || {})))))
  } catch {
    return ''
  }
}

function HyperFramesPreview({ compositionId, variables, height = 200, aspectRatio = '16:9' }) {
  // Bump a key when the variables change so the iframe fully reloads
  // (rather than only updating the hash, which can leave stale GSAP state).
  const [reloadKey, setReloadKey] = useState(0)
  const lastVarsRef = useRef('')

  useEffect(() => {
    const serialized = JSON.stringify(variables || {})
    if (serialized !== lastVarsRef.current) {
      lastVarsRef.current = serialized
      setReloadKey((k) => k + 1)
    }
  }, [variables])

  if (!compositionId) return null
  const src = `/studio-compositions/${compositionId}.html#vars=${encodeVars(variables)}`
  // Aspect ratio styling: 16:9 default, 9:16 vertical, 1:1 square
  const aspect = aspectRatio === '9:16' ? '9 / 16' : aspectRatio === '1:1' ? '1 / 1' : '16 / 9'
  return (
    <div style={{ background: '#000', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
      <iframe
        key={reloadKey}
        src={src}
        title={compositionId}
        sandbox="allow-scripts"
        style={{
          width: '100%',
          aspectRatio: aspect,
          height: height ? undefined : 'auto',
          maxHeight: height,
          border: 'none',
          display: 'block',
          background: '#000',
        }}
      />
    </div>
  )
}

// Per-variable editor inline under a motion-graphics row's preview.
// Reads the schema for the row's composition_id and renders simple
// inputs. Saves on blur to studio_segments.hyperframes_variables.
function CompositionVariableEditor({ compositionId, variables, onPatch }) {
  const schema = COMPOSITION_SCHEMAS[compositionId]
  if (!schema || !schema.length) return null
  const vars = variables || {}
  const setVar = (id, value) => {
    const next = { ...vars }
    if (value === '' || value == null) delete next[id]
    else next[id] = value
    onPatch({ hyperframes_variables: next })
  }
  return (
    <div style={{
      marginTop: 8, padding: 10,
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6,
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8,
    }}>
      {schema.map((f) => (
        <CompositionVarField key={f.id} field={f} value={vars[f.id]} onCommit={(v) => setVar(f.id, v)} />
      ))}
    </div>
  )
}

function CompositionVarField({ field, value, onCommit }) {
  if (field.type === 'color') {
    return (
      <div>
        <Label>{field.label}</Label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="color"
            value={value || field.default || '#e3151e'}
            onChange={(e) => onCommit(e.target.value)}
            style={{ width: 36, height: 28, border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', padding: 0 }}
          />
          <code style={{ fontSize: 11, color: 'var(--muted)' }}>{value || field.default || '#e3151e'}</code>
        </div>
      </div>
    )
  }
  if (field.type === 'textarea') {
    return (
      <div style={{ gridColumn: '1 / -1' }}>
        <Label>{field.label}</Label>
        <DebouncedTextarea
          initialValue={value || ''}
          onCommit={onCommit}
          placeholder={field.default || ''}
          rows={3}
        />
      </div>
    )
  }
  return (
    <div>
      <Label>{field.label}</Label>
      <DebouncedInput
        initialValue={value || ''}
        onCommit={onCommit}
        placeholder={field.default || ''}
      />
    </div>
  )
}

function Label({ children }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>
      {children}
    </div>
  )
}

// ── Video map table (editable) ──────────────────────────────────────────────
// Allowlists mirror the server's CHECK constraints + Claude's tool schema.
// Keep these in sync with api/studio/generate-map.js.
const SEGMENT_TYPE_OPTIONS = [
  { value: 'avatar',                     label: 'Avatar on camera' },
  { value: 'voiceover_broll',            label: 'Voiceover + B-roll' },
  { value: 'voiceover_motion_graphics',  label: 'Voiceover + Motion graphics' },
  { value: 'pure_motion_graphics',       label: 'Motion graphics only (no VO)' },
]
const HF_COMPOSITION_OPTIONS = [
  '', 'title-card-v1', 'stat-reveal-v1', 'list-overlay-v1',
  'quote-card-v1', 'lower-third-v1', 'comparison-v1', 'end-card-v1',
]
const TRANSITION_OPTIONS = ['cut', 'fade', 'crossfade', 'whip', 'zoom', 'wipe', 'dip_to_black']
const SFX_OPTIONS = ['', 'swoosh', 'whoosh', 'ding', 'pop', 'click', 'impact', 'subtle_chime']

function SegmentList({ video }) {
  const { session } = useAuth()
  const segments = useMemo(
    () => (video.studio_segments || []).slice().sort((a, b) => a.segment_index - b.segment_index),
    [video.studio_segments]
  )

  // Optimistic patch helper. Mutates state immediately, fires PATCH
  // in the background. Realtime UPDATE for the same row will overwrite
  // the optimistic value with the server's canonical version.
  const patchSegment = async (id, patch) => {
    if (!session?.access_token) return
    try {
      const r = await authedFetch(`/api/studio/segments?id=${id}`, session.access_token, {
        method: 'PATCH', body: JSON.stringify(patch),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        toast({ message: b.error || 'Save failed', kind: 'error' })
      }
    } catch (e) {
      toast({ message: e.message, kind: 'error' })
    }
  }

  const deleteSegment = async (id) => {
    const ok = await confirmDialog({ title: 'Delete this segment?', destructive: true, confirmText: 'Delete' })
    if (!ok) return
    await authedFetch(`/api/studio/segments?id=${id}`, session.access_token, { method: 'DELETE' })
  }

  const approvedCount = segments.filter((s) => s.approved).length

  return (
    <div>
      {video.script_full_text && (
        <details className="card" style={{ padding: 12, marginBottom: 16, background: 'var(--surface-2)' }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Full script ({video.script_full_text.length} chars)
          </summary>
          <div style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--text)', whiteSpace: 'pre-wrap', marginTop: 10 }}>
            {video.script_full_text}
          </div>
        </details>
      )}

      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        marginBottom: 12, padding: '8px 12px',
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        borderRadius: 8, fontSize: 12,
      }}>
        <strong style={{ color: 'var(--text)' }}>{segments.length}</strong>
        <span style={{ color: 'var(--muted)' }}>segments</span>
        <span style={{ color: 'var(--border)' }}>·</span>
        <strong style={{ color: 'var(--text)' }}>{approvedCount}</strong>
        <span style={{ color: 'var(--muted)' }}>approved</span>
        <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11 }}>
          Edits save on blur. Status updates stream live.
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {segments.map((s) => (
          <SegmentRow
            key={s.id}
            segment={s}
            onPatch={(patch) => patchSegment(s.id, patch)}
            onDelete={() => deleteSegment(s.id)}
            aspectRatio={video.aspect_ratio}
          />
        ))}
      </div>

      {/* Sticky footer action bar — always visible so the user always
          has a clear next step. The "Continue" button kicks off asset
          generation (task #9). Until that lands it transitions status
          to 'editing' as a sentinel that the user has reviewed. */}
      <StickyActionBar
        video={video}
        approvedCount={approvedCount}
        totalCount={segments.length}
      />
    </div>
  )
}

function StickyActionBar({ video, approvedCount, totalCount }) {
  const { session } = useAuth()
  const [busy, setBusy] = useState(false)
  const canContinue =
    approvedCount > 0 &&
    ['mapped', 'editing'].includes(video.status)

  const isRendering = video.status === 'rendering'
  const isRendered = video.status === 'rendered'

  const onContinue = async () => {
    if (!canContinue || !session?.access_token) return
    setBusy(true)
    try {
      // Kicks off ElevenLabs voice for every approved segment, plus
      // Kie.ai image jobs for B-roll rows and HeyGen V3 jobs for avatar
      // rows. Async jobs are picked up by /api/studio/poll-assets,
      // which the per-video page polls every 6s while status='rendering'.
      const r = await authedFetch('/api/studio/generate-assets', session.access_token, {
        method: 'POST',
        body: JSON.stringify({ studio_video_id: video.id }),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error(b.error || 'Could not start asset generation')
      }
      toast({ message: 'Asset generation started.', kind: 'success' })
    } catch (e) {
      toast({ message: e.message, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{
      position: 'sticky',
      bottom: 16,
      marginTop: 24,
      padding: '12px 16px',
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      zIndex: 10,
    }}>
      <div style={{ flex: 1, fontSize: 12.5, color: 'var(--text-soft)' }}>
        {isRendering ? (
          <>
            <Loader2 size={12} className="spin" style={{ verticalAlign: 'middle', marginRight: 6, color: '#fbbf24' }} />
            <strong style={{ color: 'var(--text)' }}>Generating assets…</strong>
            <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
              Voice, B-roll, and avatar segments are filling in below.
            </span>
          </>
        ) : isRendered ? (
          <>
            <CheckCircle2 size={12} style={{ verticalAlign: 'middle', marginRight: 6, color: '#2ecc71' }} />
            <strong style={{ color: 'var(--text)' }}>Render complete.</strong>
          </>
        ) : (
          <>
            <strong style={{ color: 'var(--text)' }}>{approvedCount} of {totalCount}</strong> segments approved.
            {approvedCount < totalCount && (
              <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
                Unapproved segments will be skipped on render.
              </span>
            )}
            {approvedCount === totalCount && totalCount > 0 && (
              <span style={{ color: '#2ecc71', marginLeft: 8 }}>All set.</span>
            )}
          </>
        )}
      </div>
      <button
        type="button"
        className="btn-primary"
        disabled={!canContinue || busy || isRendering}
        onClick={onContinue}
        style={{ fontSize: 13, padding: '10px 18px' }}
      >
        {busy || isRendering ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
        {isRendering
          ? 'Generating…'
          : video.status === 'editing'
            ? 'Generate assets'
            : 'Continue to render'}
      </button>
    </div>
  )
}

// One row of the video map. Cards are dense but legible — Studio is
// desktop-first. Each editable field debounces text-input PATCHes and
// fires select/checkbox PATCHes on change.
function SegmentRow({ segment, onPatch, onDelete, aspectRatio }) {
  const isAvatar = segment.segment_type === 'avatar'
  const isBroll = segment.segment_type === 'voiceover_broll'
  const isMotion = segment.segment_type === 'voiceover_motion_graphics' || segment.segment_type === 'pure_motion_graphics'
  const isPureMotion = segment.segment_type === 'pure_motion_graphics'
  const [showVarsEditor, setShowVarsEditor] = useState(false)

  const borderColor = segment.approved
    ? 'rgba(46,204,113,0.45)'
    : segment.status === 'error'
      ? 'rgba(239,68,68,0.45)'
      : 'var(--border)'

  return (
    <div className="card-flat" style={{
      padding: 14, background: 'var(--surface-2)',
      border: `1px solid ${borderColor}`, transition: 'border-color 0.15s',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        {/* Index + approve toggle */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'var(--surface)', border: '1px solid var(--border)',
            display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700,
            color: 'var(--muted)',
          }}>
            {segment.segment_index + 1}
          </div>
          <button
            type="button"
            onClick={() => onPatch({ approved: !segment.approved })}
            title={segment.approved ? 'Approved' : 'Approve'}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: segment.approved ? '#2ecc71' : 'var(--muted)',
              padding: 0, display: 'grid', placeItems: 'center',
            }}
          >
            {segment.approved ? <CheckCircle2 size={20} /> : <Circle size={20} />}
          </button>
        </div>

        {/* Main content column */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Top row: type select + composition + transition + SFX + status + actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <select
              className="input"
              value={segment.segment_type}
              onChange={(e) => onPatch({ segment_type: e.target.value })}
              style={{ fontSize: 11.5, padding: '4px 6px', height: 'auto', width: 'auto', minWidth: 160 }}
            >
              {SEGMENT_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>

            {isMotion && (
              <select
                className="input"
                value={segment.hyperframes_composition_id || ''}
                onChange={(e) => onPatch({ hyperframes_composition_id: e.target.value || null })}
                style={{ fontSize: 11.5, padding: '4px 6px', height: 'auto', width: 'auto', minWidth: 140 }}
              >
                {HF_COMPOSITION_OPTIONS.map((c) => (
                  <option key={c} value={c}>{c || 'No template'}</option>
                ))}
              </select>
            )}

            <select
              className="input"
              value={segment.transition_in}
              onChange={(e) => onPatch({ transition_in: e.target.value })}
              style={{ fontSize: 11.5, padding: '4px 6px', height: 'auto', width: 'auto' }}
              title="Transition in"
            >
              {TRANSITION_OPTIONS.map((t) => (
                <option key={t} value={t}>↪ {t}</option>
              ))}
            </select>

            <select
              className="input"
              value={segment.sound_effect || ''}
              onChange={(e) => onPatch({ sound_effect: e.target.value || null })}
              style={{ fontSize: 11.5, padding: '4px 6px', height: 'auto', width: 'auto' }}
              title="Sound effect"
            >
              {SFX_OPTIONS.map((sfx) => (
                <option key={sfx} value={sfx}>♪ {sfx || 'none'}</option>
              ))}
            </select>

            <StatusBadge
              status={segment.status}
              error={segment.error}
              segmentType={segment.segment_type}
              approved={segment.approved}
            />

            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              <button
                type="button"
                onClick={onDelete}
                className="btn-ghost"
                style={{ padding: 4, color: 'var(--muted)' }}
                title="Delete segment"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>

          {/* Script text (skip for pure motion graphics) */}
          {!isPureMotion && (
            <DebouncedTextarea
              initialValue={segment.script_text || ''}
              onCommit={(v) => onPatch({ script_text: v })}
              placeholder={isAvatar ? 'What the avatar says…' : 'What the voiceover says…'}
              rows={2}
              style={{ marginBottom: 8 }}
            />
          )}

          {/* Type-specific prompt field */}
          {isBroll && (
            <DebouncedInput
              initialValue={segment.image_prompt || ''}
              onCommit={(v) => onPatch({ image_prompt: v })}
              placeholder="B-roll image prompt — be specific (subject, lighting, mood)"
              icon={<ImageIcon size={12} />}
            />
          )}
          {isAvatar && (
            <DebouncedInput
              initialValue={segment.motion_gesture_prompt || ''}
              onCommit={(v) => onPatch({ motion_gesture_prompt: v })}
              placeholder="Avatar direction (optional): expression, gesture, energy"
            />
          )}

          {/* Motion graphics live preview + variable editor */}
          {isMotion && segment.hyperframes_composition_id && (
            <div style={{ marginTop: 10 }}>
              <HyperFramesPreview
                compositionId={segment.hyperframes_composition_id}
                variables={segment.hyperframes_variables}
                height={200}
                aspectRatio={aspectRatio}
              />
              <button
                type="button"
                onClick={() => setShowVarsEditor((v) => !v)}
                className="btn-ghost"
                style={{ fontSize: 11, padding: '4px 8px', marginTop: 6, color: 'var(--muted)' }}
              >
                {showVarsEditor ? 'Hide variables' : 'Edit variables'}
              </button>
              {showVarsEditor && (
                <CompositionVariableEditor
                  compositionId={segment.hyperframes_composition_id}
                  variables={segment.hyperframes_variables}
                  onPatch={onPatch}
                />
              )}
            </div>
          )}

          {/* Generated assets preview (read-only thumbnails) */}
          {(segment.image_url || segment.voice_url || segment.avatar_video_url) && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {segment.image_url && (
                <a href={segment.image_url} target="_blank" rel="noopener noreferrer" style={{ display: 'block' }}>
                  <img
                    src={segment.image_url} alt="B-roll preview"
                    style={{ width: 96, height: 54, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)' }}
                  />
                </a>
              )}
              {segment.voice_url && (
                <audio src={segment.voice_url} controls style={{ height: 28 }} />
              )}
              {segment.avatar_video_url && (
                <a href={segment.avatar_video_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Avatar clip ↗
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status, error, segmentType, approved }) {
  if (status === 'ready') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, color: '#2ecc71' }}>
        <CheckCircle2 size={11} /> Ready
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span title={error || ''} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, color: 'var(--red)' }}>
        <AlertCircle size={11} /> Error
      </span>
    )
  }
  if (status?.startsWith('generating_') || status === 'rendering_chunk') {
    const label = ({
      generating_image:   'Image…',
      generating_audio:   'Voice…',
      generating_avatar:  'Avatar…',
      rendering_chunk:    'Rendering…',
    })[status] || 'Working…'
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, color: '#fbbf24' }}>
        <Loader2 size={11} className="spin" /> {label}
      </span>
    )
  }
  // 'pending' state. Spell out what's actually missing per segment type so
  // the user knows it's a "needs generating" state, not a "blocked on you"
  // state.
  if (!approved) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: 'var(--muted)' }}>
        Skipped
      </span>
    )
  }
  const tip = ({
    avatar:                     'Needs voice + avatar render',
    voiceover_broll:            'Needs voice + B-roll image',
    voiceover_motion_graphics:  'Needs voice (motion graphics render at bake time)',
    pure_motion_graphics:       'Nothing to generate (renders at bake time)',
  })[segmentType] || ''
  return (
    <span title={tip} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: 'var(--muted)' }}>
      Awaiting generate
    </span>
  )
}

// Debounced input: commits to onCommit() ~600ms after the user stops
// typing, or immediately on blur. Local state holds the in-flight value
// so the field stays responsive during PATCH round-trips. Realtime
// UPDATE events for the same row replace local state when the field is
// not focused (avoids stomping mid-edit).
function DebouncedInput({ initialValue, onCommit, placeholder, icon }) {
  const [value, setValue] = useState(initialValue || '')
  const [focused, setFocused] = useState(false)
  const lastCommittedRef = useRef(initialValue || '')
  const timerRef = useRef(null)

  useEffect(() => {
    if (!focused && initialValue !== value && initialValue !== lastCommittedRef.current) {
      setValue(initialValue || '')
      lastCommittedRef.current = initialValue || ''
    }
  }, [initialValue, focused, value])

  const commit = (v) => {
    if (v === lastCommittedRef.current) return
    lastCommittedRef.current = v
    onCommit(v)
  }
  const onChange = (e) => {
    const v = e.target.value
    setValue(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => commit(v), 600)
  }
  const onBlur = () => {
    setFocused(false)
    if (timerRef.current) clearTimeout(timerRef.current)
    commit(value)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '0 8px' }}>
      {icon && <span style={{ color: 'var(--muted)', display: 'grid', placeItems: 'center' }}>{icon}</span>}
      <input
        value={value}
        onChange={onChange}
        onFocus={() => setFocused(true)}
        onBlur={onBlur}
        placeholder={placeholder}
        style={{
          flex: 1, background: 'transparent', border: 'none', outline: 'none',
          color: 'var(--text)', fontSize: 12, padding: '8px 0',
        }}
      />
    </div>
  )
}

function DebouncedTextarea({ initialValue, onCommit, placeholder, rows = 2, style }) {
  const [value, setValue] = useState(initialValue || '')
  const [focused, setFocused] = useState(false)
  const lastCommittedRef = useRef(initialValue || '')
  const timerRef = useRef(null)

  useEffect(() => {
    if (!focused && initialValue !== value && initialValue !== lastCommittedRef.current) {
      setValue(initialValue || '')
      lastCommittedRef.current = initialValue || ''
    }
  }, [initialValue, focused, value])

  const commit = (v) => {
    if (v === lastCommittedRef.current) return
    lastCommittedRef.current = v
    onCommit(v)
  }
  const onChange = (e) => {
    const v = e.target.value
    setValue(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => commit(v), 600)
  }
  const onBlur = () => {
    setFocused(false)
    if (timerRef.current) clearTimeout(timerRef.current)
    commit(value)
  }

  return (
    <textarea
      value={value}
      onChange={onChange}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
      placeholder={placeholder}
      rows={rows}
      className="input"
      style={{ fontSize: 13, lineHeight: 1.5, resize: 'vertical', ...style }}
    />
  )
}
