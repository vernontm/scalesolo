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
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Film, Sparkles, Plus, ArrowLeft, Wand2, Loader2, Trash2, RefreshCw,
  CheckCircle2, Circle, AlertCircle, Image as ImageIcon, MoreVertical,
  ChevronRight,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { toast, confirmDialog } from '../components/Toast.jsx'
import NewVideoModal from '../components/NewVideoModal.jsx'
import { supabase } from '../lib/supabase.js'

async function authedFetch(path, token, init = {}) {
  // Auto-serialize plain-object bodies. fetch() doesn't do this for
  // you — passing { foo: 'bar' } directly results in the body being
  // String({...}) === '[object Object]', which the server then rejects
  // as malformed JSON ("Invalid JSON" toast). FormData/Blob/string
  // bodies are pass-through.
  let body = init.body
  if (body && typeof body === 'object'
      && !(body instanceof FormData)
      && !(body instanceof Blob)
      && !(body instanceof ArrayBuffer)
      && !(body instanceof URLSearchParams)) {
    body = JSON.stringify(body)
  }
  return fetch(path, {
    ...init,
    body,
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
  const [modalOpen, setModalOpen] = useState(false)

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

  // First-time UX: if there are no videos yet, auto-open the new-video
  // modal so the empty state doesn't leave the user staring at nothing.
  useEffect(() => {
    if (videos !== null && videos.length === 0) setModalOpen(true)
  }, [videos])

  return (
    <div className="fade-up" style={{ maxWidth: 1080, margin: '0 auto', padding: '32px 24px' }}>
      <Header
        title="Studio"
        subtitle={`Long-form video generation${selectedProfile ? ` for ${selectedProfile.business_name}` : ''}.`}
        action={(
          <button className="btn-primary" onClick={() => setModalOpen(true)}>
            <Plus size={14} /> New video
          </button>
        )}
      />

      <RecentVideos videos={videos} onOpen={(v) => navigate(`/studio/${v.id}`)} />

      <NewVideoModal
        open={modalOpen}
        profileId={selectedProfileId}
        onClose={() => setModalOpen(false)}
        onCreated={(video) => {
          setModalOpen(false)
          if (video?.id) navigate(`/studio/${video.id}`)
        }}
      />
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
  const [templates, setTemplates] = useState([])
  // Cost-side affordability — set by CostEstimate when it loads.
  // Used to disable the submit button when the user can't pay.
  const [canRender, setCanRender] = useState(true)
  // Slimmed-down form per PDF feedback. No title (auto-generated), no
  // reference URL / text, no brand_color picker (synced from brand
  // profile), no voice picker (tied to avatar), no overlays / auto-fit
  // toggles (both always on under the hood).
  const [form, setForm] = useState({
    topic_prompt: '',
    avatar_id: '',  // populated to first avatar in useEffect once they load
    look_id: '',
    target_duration_secs: 120,
    aspect_ratio: '16:9',
    template_id: 'sleek',
    captions_enabled: true,
    // Background-music selection. Tracks live on the user's account-wide
    // music library (user_profiles.music_tracks). 'off' = silent bg;
    // 'loop_one' = repeat music_track_id; 'cycle_all' = play all in
    // order, loop the playlist. Volume is a 0..1 multiplier under voice.
    music_mode: 'off',
    music_track_id: '',
    music_volume: 0.12,
    // Voiceover-upload mode. When 'upload', user picks a file instead
    // of providing a topic; the server transcribes + segments.
    voice_source: 'topic',  // 'topic' | 'upload'
    voiceover_file: null,
  })
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  // Account-wide music library, fetched on modal open. Same source the
  // Profiles page edits. Used by the Background-music field to render
  // the track picker when music_mode === 'loop_one'.
  const [musicTracks, setMusicTracks] = useState([])
  useEffect(() => {
    if (!session?.access_token) return
    let cancelled = false
    fetch('/api/account/music-tracks', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => {
        if (cancelled) return
        if (Array.isArray(b?.tracks)) setMusicTracks(b.tracks)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [session?.access_token])

  // Load the visual template gallery. Each template defines the look
  // (background pattern, typography, motion graphics style, etc.); the
  // user picks one then optionally overrides the brand color below.
  useEffect(() => {
    if (!session?.access_token) return
    let cancelled = false
    authedFetch('/api/studio/templates', session.access_token)
      .then((r) => r.ok ? r.json() : { templates: [] })
      .then((b) => {
        if (cancelled) return
        setTemplates(b.templates || [])
      })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.access_token])

  // When the user switches template, sync brand_color to the new
  // template's default unless they've explicitly tweaked it. We track
  // "did the user touch the picker" via brand_color !== any template
  // default — a tiny heuristic that's fine for v1.
  const selectedTemplate = templates.find((t) => t.id === form.template_id) || templates[0]

  // Looks for the selected avatar. Avatar rows come back with a `looks`
  // array (avatar_looks joined in /api/avatars). When the user picks
  // an avatar, we surface its looks for selection so they can pin a
  // specific framing (portrait / landscape / square).
  const selectedAvatar = avatars.find((a) => a.id === form.avatar_id)
  const looks = selectedAvatar?.looks || []
  const selectedLook = looks.find((l) => l.id === form.look_id)

  // Clear look_id if the user picks a different avatar.
  useEffect(() => {
    if (!selectedAvatar || !form.look_id) return
    if (!looks.some((l) => l.id === form.look_id)) {
      setForm((f) => ({ ...f, look_id: '' }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.avatar_id])

  // Aspect/orientation mismatch warning. If the user picks a portrait
  // look but a 16:9 video, HeyGen will letterbox with white pillarbox
  // (the exact bug Ray hit on his first render). Surface this clearly.
  const aspectToOrientation = { '16:9': 'landscape', '9:16': 'portrait', '1:1': 'square' }
  const wantOrient = aspectToOrientation[form.aspect_ratio]
  const lookMismatch = selectedLook?.orientation && wantOrient && selectedLook.orientation !== wantOrient
  const lookUnspecified = selectedLook && !selectedLook.orientation
  // A look without a heygen_look_id hasn't finished training on HeyGen.
  // Picking one used to silently fall back to the avatar's default
  // talking_photo at render time — which is portrait — producing a
  // letterboxed avatar on landscape videos. Block submission instead.
  const lookUntrained = !!selectedLook && !selectedLook.heygen_look_id
  // Compound blocker — surfaced both as a disabled submit button and as
  // a clear inline message above it so the user knows what to fix.
  const lookBlocker = lookMismatch
    ? `The picked look is ${selectedLook?.orientation} but the video is ${form.aspect_ratio} (${wantOrient}). Pick a matching look or re-tag this one.`
    : lookUntrained
      ? `The picked look hasn't finished training on HeyGen yet. Wait for training to complete on the Avatars page, or pick a different look.`
      : null

  // Pull avatars for the active profile. Voice is tied to the avatar
  // (or to the brand profile when "no avatar" is selected) so we don't
  // need a separate voice dropdown anymore.
  useEffect(() => {
    if (!profileId || !session?.access_token) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await authedFetch(`/api/avatars?profile_id=${profileId}`, session.access_token)
        const a = r.ok ? await r.json() : { avatars: [] }
        if (cancelled) return
        const list = a.avatars || []
        setAvatars(list)
        // Default-select the first avatar so the user starts in a valid
        // state — avatar is now required (voice is tied to it).
        if (list.length && !form.avatar_id) setForm((f) => ({ ...f, avatar_id: list[0].id }))
      } catch { /* dropdown stays empty */ }
    })()
    return () => { cancelled = true }
  }, [profileId, session?.access_token])

  const submit = async (e) => {
    e?.preventDefault?.()

    // Two paths: topic-based (existing) or voiceover-upload.
    if (form.voice_source === 'upload') {
      if (!form.voiceover_file) {
        setError('Pick a voiceover audio file to upload.')
        return
      }
    } else if (!form.topic_prompt.trim()) {
      setError('Tell Claude what the video is about.')
      return
    }
    setBusy(true); setError(null)
    try {
      const avatarRow = avatars.find((a) => a.id === form.avatar_id)
      const resolvedVoiceId = avatarRow?.effective_voice_id || avatarRow?.elevenlabs_voice_id || null

      // ── Voiceover-upload branch ───────────────────────────────
      if (form.voice_source === 'upload') {
        const file = form.voiceover_file
        // Phase 1: ask server for a signed upload URL.
        const initR = await authedFetch(
          '/api/studio/voiceover/upload?mode=init',
          session.access_token,
          { method: 'POST', body: JSON.stringify({
            profile_id: profileId,
            filename: file.name,
            content_type: file.type || 'audio/mpeg',
          }) },
        )
        const initBody = await initR.json().catch(() => ({}))
        if (!initR.ok) throw new Error(initBody.error || `Upload init failed (${initR.status})`)
        // Phase 2: PUT file straight to Supabase Storage.
        const putR = await fetch(initBody.signed_url, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${initBody.token}`,
            'Content-Type': initBody.content_type,
            'x-upsert': 'true',
          },
          body: file,
        })
        if (!putR.ok) throw new Error(`Storage upload ${putR.status}`)
        // Phase 3: finalize → returns public URL.
        const finR = await authedFetch(
          '/api/studio/voiceover/upload?mode=finalize',
          session.access_token,
          { method: 'POST', body: JSON.stringify({ profile_id: profileId, path: initBody.path }) },
        )
        const finBody = await finR.json().catch(() => ({}))
        if (!finR.ok) throw new Error(finBody.error || 'Finalize failed')

        toast({ message: 'Voiceover uploaded. Transcribing + segmenting…', kind: 'info' })

        // Phase 4: kick off transcription + segmentation.
        const segR = await authedFetch(
          '/api/studio/voiceover/segment',
          session.access_token,
          { method: 'POST', body: JSON.stringify({
            profile_id: profileId,
            voiceover_url: finBody.voiceover_url,
            avatar_id: form.avatar_id || null,
            look_id: form.look_id || null,
            voice_id: resolvedVoiceId,
            aspect_ratio: form.aspect_ratio,
            template_id: form.template_id || 'sleek',
            captions_enabled: form.captions_enabled !== false,
            music_mode: form.music_mode || 'off',
            music_track_id: form.music_mode === 'loop_one' ? (form.music_track_id || null) : null,
            music_volume: Number(form.music_volume) || 0.12,
          }) },
        )
        const segBody = await segR.json().catch(() => ({}))
        if (!segR.ok) throw new Error(segBody.error || 'Segmentation failed')
        toast({ message: `Created ${segBody.segments?.length || 0} segments from your voiceover.`, kind: 'success' })
        onCreated(segBody.video)
        return
      }

      // ── Topic-based branch (existing flow) ────────────────────
      const body = {
        profile_id: profileId,
        topic_prompt: form.topic_prompt.trim(),
        avatar_id: form.avatar_id || null,
        look_id: form.look_id || null,
        voice_id: resolvedVoiceId,
        target_duration_secs: Number(form.target_duration_secs) || 120,
        aspect_ratio: form.aspect_ratio,
        template_id: form.template_id || 'sleek',
        captions_enabled: form.captions_enabled !== false,
        overlays_enabled: true,
        motion_graphics_enabled: true,
        music_mode: form.music_mode || 'off',
        music_track_id: form.music_mode === 'loop_one' ? (form.music_track_id || null) : null,
        music_volume: Number(form.music_volume) || 0.12,
      }
      const r = await authedFetch('/api/studio/videos', session.access_token, {
        method: 'POST', body: JSON.stringify(body),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Could not create video')
      toast({ message: 'Draft created. Generating the video map…', kind: 'success' })
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
        Six quick choices and Claude drafts your video map. You can edit every segment afterward.
      </div>

      {/* 1. Aspect ratio — vertical / portrait / landscape / square. */}
      <Field label="1.  Aspect ratio" hint="9:16 for TikTok / Reels / Shorts. 16:9 for YouTube. 1:1 for square posts.">
        <div style={{ display: 'flex', gap: 6 }}>
          {[
            { v: '16:9', label: 'Landscape · 16:9' },
            { v: '9:16', label: 'Vertical · 9:16' },
            { v: '1:1',  label: 'Square · 1:1' },
          ].map((r) => (
            <button
              key={r.v}
              type="button"
              onClick={() => set('aspect_ratio', r.v)}
              className={form.aspect_ratio === r.v ? 'btn-primary' : 'btn-secondary'}
              style={{ flex: 1, padding: '10px 8px', fontSize: 12.5, fontWeight: 700 }}
            >{r.label}</button>
          ))}
        </div>
      </Field>

      {/* 2. Avatar — voice is auto-tied to the chosen avatar. Avatar
              video generation itself is toggled later, on the Generate
              Assets step. */}
      <Field label="2.  Avatar" hint="Voice and look are pulled from the avatar you pick. You decide whether to actually render avatar video on the next step.">
        <select className="input" value={form.avatar_id} onChange={(e) => set('avatar_id', e.target.value)}>
          {avatars.length === 0 && <option value="">No avatars yet — create one on the Avatars page</option>}
          {avatars.map((a) => (
            <option key={a.id} value={a.id}>{a.name || a.id.slice(0, 8)}</option>
          ))}
        </select>
      </Field>

      {/* Look picker — thumbnail grid filtered by aspect ratio so only
          matching orientations show. 9:16 → portrait; 16:9 → landscape;
          1:1 → both. Falls back to all looks when orientation isn't
          tagged on a look (legacy data). */}
      {selectedAvatar && looks.length > 0 && (
        <Field label="Look" hint="Click a thumbnail to lock the avatar's framing for this video.">
          {(() => {
            const ar = form.aspect_ratio
            const desired = ar === '9:16' ? 'portrait' : ar === '16:9' ? 'landscape' : null
            // Keep looks whose orientation matches; if none match (or
            // orientation isn't set on any look), show everything so the
            // user is never stuck with an empty grid.
            const filtered = desired
              ? looks.filter((l) => !l.orientation || l.orientation === desired)
              : looks
            const visible = filtered.length ? filtered : looks
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
                {visible.map((l, idx) => {
                  const thumb = l.images?.[0]?.image_url
                  const isSelected = form.look_id === l.id
                  const orientationTag = l.orientation
                  // Looks without a heygen_look_id can't actually be
                  // rendered — they'd fall back to the avatar default
                  // at render time and produce a letterbox mismatch.
                  // Grey them out + show "TRAINING" label so users
                  // skip them in the picker.
                  const isUntrained = !l.heygen_look_id
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => { if (!isUntrained) set('look_id', l.id) }}
                      disabled={isUntrained}
                      style={{
                        padding: 0,
                        background: 'var(--surface)',
                        border: `2px solid ${isSelected ? 'var(--primary)' : 'transparent'}`,
                        borderRadius: 10,
                        overflow: 'hidden',
                        cursor: isUntrained ? 'not-allowed' : 'pointer',
                        position: 'relative',
                        aspectRatio: orientationTag === 'landscape' ? '16/9' : '3/4',
                        opacity: isUntrained ? 0.45 : 1,
                      }}
                      title={isUntrained
                        ? `${l.name || `Look ${idx + 1}`} — still training on HeyGen. Wait for training to finish, then re-open this picker.`
                        : (l.name || `Look ${idx + 1}`)}
                    >
                      {thumb ? (
                        <img src={thumb} alt={l.name || `Look ${idx + 1}`}
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', filter: isUntrained ? 'grayscale(0.7)' : 'none' }} />
                      ) : (
                        <div style={{ width: '100%', height: '100%', background: 'var(--surface-2)' }} />
                      )}
                      <div style={{
                        position: 'absolute', left: 0, right: 0, bottom: 0,
                        padding: '4px 6px',
                        fontSize: 10, fontWeight: 700,
                        color: '#fff',
                        background: 'linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0))',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6,
                      }}>
                        <span style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
                          {l.name || `Look ${idx + 1}`}
                        </span>
                        {orientationTag && (
                          <span style={{ opacity: 0.7, fontWeight: 500 }}>{orientationTag[0].toUpperCase()}</span>
                        )}
                      </div>
                      {/* Untrained badge — top-right corner, hard to miss. */}
                      {isUntrained && (
                        <div style={{
                          position: 'absolute', top: 6, right: 6,
                          padding: '2px 6px',
                          fontSize: 9, fontWeight: 800,
                          letterSpacing: 0.5,
                          textTransform: 'uppercase',
                          background: 'rgba(0,0,0,0.7)',
                          color: '#fbbf24',
                          borderRadius: 4,
                          border: '1px solid rgba(251,191,36,0.5)',
                        }}>Training</div>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })()}
        </Field>
      )}

      {/* 3. Length. No upper cap — type whatever the script needs. */}
      <Field
        label={`3.  Length: ${Math.floor(form.target_duration_secs / 60)}m ${String(form.target_duration_secs % 60).padStart(2, '0')}s (${form.target_duration_secs}s)`}
        hint="30s minimum, no upper cap. Set whatever the script actually requires."
      >
        <input
          type="number"
          className="input"
          min={30}
          step={15}
          value={form.target_duration_secs}
          onChange={(e) => set('target_duration_secs', Math.max(30, Number(e.target.value) || 30))}
          style={{ width: 140 }}
        />
      </Field>

      {/* 4. Source — topic prompt OR uploaded voiceover. */}
      <Field label="4.  Source" required hint="Either describe the video and Claude writes + voices it, or upload your own voiceover and we'll segment it for you.">
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {[
            { v: 'topic',  label: 'Topic prompt' },
            { v: 'upload', label: 'Upload my voiceover' },
          ].map((r) => (
            <button
              key={r.v}
              type="button"
              onClick={() => set('voice_source', r.v)}
              className={form.voice_source === r.v ? 'btn-primary' : 'btn-secondary'}
              style={{ flex: 1, padding: '10px 8px', fontSize: 12.5, fontWeight: 700 }}
            >{r.label}</button>
          ))}
        </div>
        {form.voice_source === 'topic' ? (
          <textarea
            className="input"
            rows={3}
            placeholder="A 90-second explainer on why faceless creators are out-shipping personal brands in 2026."
            value={form.topic_prompt}
            onChange={(e) => set('topic_prompt', e.target.value)}
            maxLength={2000}
          />
        ) : (
          <div>
            <input
              type="file"
              accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/x-m4a,audio/mp4,audio/aac,audio/ogg,audio/flac"
              onChange={(e) => set('voiceover_file', e.target.files?.[0] || null)}
              style={{ width: '100%', padding: 10, background: 'var(--surface)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-soft)', fontSize: 12 }}
            />
            {form.voiceover_file && (
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
                {form.voiceover_file.name} · {(form.voiceover_file.size / 1024 / 1024).toFixed(1)} MB
              </div>
            )}
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
              MP3, WAV, M4A, AAC, OGG, or FLAC. We'll transcribe, split into beats, slice the audio per segment, and pick visuals automatically. You can still upload your own avatar videos for each beat on the next step.
            </div>
          </div>
        )}
      </Field>

      {/* 5. Visual template — selectable cards. Brand color cascades
          from the brand profile, so no separate picker here. */}
      {templates.length > 0 && (
        <Field label="5.  Visual template" hint="Background pattern, typography, motion graphics, and pacing all cascade from here. Brand color syncs from your brand profile.">
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 10,
          }}>
            {templates.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                selected={form.template_id === t.id}
                onClick={() => set('template_id', t.id)}
              />
            ))}
          </div>
        </Field>
      )}

      {/* 6. Captions — the only post-template toggle. Overlays + auto-fit
          are always on under the hood; the user doesn't need a knob. */}
      <Field label="6.  Captions" hint="Word-by-word lower-third captions on every voiceover segment.">
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={form.captions_enabled !== false}
            onChange={(e) => set('captions_enabled', e.target.checked)}
            style={{ width: 18, height: 18 }}
          />
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>
            {form.captions_enabled !== false ? 'Captions on' : 'Captions off'}
          </span>
        </label>
      </Field>

      {/* 7. Background music — pulls from the account-wide music library
          (Profiles page → Music tracks). Loop one track, cycle the whole
          library, or skip music entirely. Volume sits under the voice. */}
      <Field
        label="7.  Background music"
        hint="Plays under the voiceover. Auto fade-in (1.5s) + fade-out (2s)."
      >
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {[
            { v: 'off',        label: 'Off' },
            { v: 'loop_one',   label: 'Loop one song' },
            { v: 'cycle_all',  label: 'Cycle all songs' },
          ].map((r) => (
            <button
              key={r.v}
              type="button"
              onClick={() => set('music_mode', r.v)}
              className={form.music_mode === r.v ? 'btn-primary' : 'btn-secondary'}
              style={{ flex: 1, padding: '10px 8px', fontSize: 12.5, fontWeight: 700 }}
            >{r.label}</button>
          ))}
        </div>

        {/* Track picker — only when looping a single song. */}
        {form.music_mode === 'loop_one' && (
          <div style={{ marginTop: 4 }}>
            {musicTracks.length === 0 ? (
              <div style={{
                padding: '8px 10px', fontSize: 12,
                background: 'var(--surface)', border: '1px dashed var(--border)',
                borderRadius: 6, color: 'var(--muted)',
              }}>
                No tracks in your library yet. Add some on the Profiles page → Music tracks.
              </div>
            ) : (
              <select
                className="input"
                value={form.music_track_id || ''}
                onChange={(e) => set('music_track_id', e.target.value)}
                style={{ width: '100%' }}
              >
                <option value="">— Pick a track —</option>
                {musicTracks.map((t) => (
                  <option key={t.id} value={t.id}>{t.name || t.id}</option>
                ))}
              </select>
            )}
          </div>
        )}

        {/* Cycle-all preview list — informational only. */}
        {form.music_mode === 'cycle_all' && (
          <div style={{
            marginTop: 4, padding: '8px 10px', fontSize: 12,
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 6, color: 'var(--text-soft)',
          }}>
            {musicTracks.length === 0
              ? 'No tracks in your library yet. Add some on the Profiles page → Music tracks.'
              : `Will play in order, looping if the video runs past the playlist: ${musicTracks.map((t) => t.name).filter(Boolean).slice(0, 4).join(' · ')}${musicTracks.length > 4 ? ` + ${musicTracks.length - 4} more` : ''}`}
          </div>
        )}

        {/* Volume — 3-preset picker keeps the UI simple. The numeric value
            saved to the row drives ffmpeg's volume= filter at render time. */}
        {form.music_mode !== 'off' && (
          <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
            {[
              { v: 0.08, label: 'Subtle' },
              { v: 0.12, label: 'Low (default)' },
              { v: 0.18, label: 'Prominent' },
            ].map((r) => (
              <button
                key={r.v}
                type="button"
                onClick={() => set('music_volume', r.v)}
                className={Math.abs(form.music_volume - r.v) < 0.005 ? 'btn-primary' : 'btn-secondary'}
                style={{ flex: 1, padding: '6px 8px', fontSize: 11.5, fontWeight: 600 }}
              >{r.label}</button>
            ))}
          </div>
        )}
      </Field>

      {/* Inline orientation tagger for the selected look. Saves to the
          avatar_looks row so every future video sees the right tag. */}
      {selectedLook && (
        <LookOrientationInlineEditor
          look={selectedLook}
          token={session?.access_token}
          mismatch={lookMismatch ? wantOrient : null}
          unspecified={lookUnspecified}
        />
      )}

      {/* Cost estimate — updates as the user changes aspect / length /
          avatar choice. Disables the generate button when the user
          is short on any pool. */}
      <CostEstimate
        profileId={profileId}
        targetDurationSecs={form.target_duration_secs}
        hasAvatar={!!form.avatar_id}
        onAffordability={setCanRender}
      />

      {error && (
        <div style={{
          background: 'rgba(239,68,68,0.12)', color: 'var(--red)',
          border: '1px solid rgba(239,68,68,0.35)', borderRadius: 8,
          padding: '8px 12px', marginTop: 12, fontSize: 12.5,
        }}>{error}</div>
      )}

      {/* Hard-stop for orientation mismatch or untrained look. Same
          conditions disable the submit button — this banner makes the
          reason visible so the disabled state isn't a mystery. */}
      {lookBlocker && !error && (
        <div style={{
          background: 'rgba(239,68,68,0.12)', color: 'var(--red)',
          border: '1px solid rgba(239,68,68,0.35)', borderRadius: 8,
          padding: '8px 12px', marginTop: 12, fontSize: 12.5,
        }}>{lookBlocker}</div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button
          type="submit"
          className="btn-primary"
          disabled={busy || !form.topic_prompt.trim() || !canRender || !!lookBlocker}
          title={
            lookBlocker
              ? lookBlocker
              : !canRender
                ? 'Not enough credits for this video. Top up or pick a shorter length.'
                : undefined
          }
        >
          {busy ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
          {busy ? 'Creating…' : 'Generate video map'}
        </button>
      </div>
    </form>
  )
}

// Shared cost-estimate card. Hits /api/studio/estimate-cost whenever
// any of the inputs change (debounced) and renders a 3-row block
// (AI tokens, video credits, voice minutes) with low-high ranges +
// remaining balance + an "insufficient" badge when the user is short.
function CostEstimate({ profileId, studioVideoId, targetDurationSecs, hasAvatar, hint, onAffordability }) {
  const { session } = useAuth()
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)

  // Bubble can_render up to parent. Default true while loading so the
  // submit button doesn't flicker disabled then re-enable.
  useEffect(() => {
    if (data && onAffordability) onAffordability(!!data.can_render)
  }, [data, onAffordability])
  // Debounced fetch — typing on the topic field shouldn't fire estimate
  // on every keystroke, but slider changes feel best with near-instant
  // feedback. 200ms hits a good middle.
  useEffect(() => {
    if (!session?.access_token) return
    if (!studioVideoId && !profileId) return
    const t = setTimeout(async () => {
      try {
        const body = studioVideoId
          ? { studio_video_id: studioVideoId }
          : { profile_id: profileId, target_duration_secs: targetDurationSecs, has_avatar: hasAvatar }
        const r = await authedFetch('/api/studio/estimate-cost', session.access_token, {
          method: 'POST', body: JSON.stringify(body),
        })
        const text = await r.text()
        let body2 = null
        try { body2 = JSON.parse(text) } catch { /* not JSON */ }
        if (!r.ok) throw new Error(body2?.error || `HTTP ${r.status}`)
        setData(body2); setErr(null)
      } catch (e) {
        setErr(e.message)
      }
    }, 200)
    return () => clearTimeout(t)
  }, [session?.access_token, profileId, studioVideoId, targetDurationSecs, hasAvatar])

  if (err) {
    return (
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 12 }}>
        Cost estimate unavailable: {err}
      </div>
    )
  }
  if (!data) {
    return (
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Loader2 size={11} className="spin" /> Estimating cost…
      </div>
    )
  }

  const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 })
  const rows = [
    {
      label: 'AI tokens',
      low: data.cost.ai_tokens.low, high: data.cost.ai_tokens.high,
      balance: data.balance.ai_tokens,
      enough: data.sufficient.ai_tokens,
      hint: 'Script generation, overlay enrichment, motion-graphics auto-fit, chat edits.',
    },
    {
      label: 'Video credits',
      low: data.cost.video_units.low, high: data.cost.video_units.high,
      balance: data.balance.video_units,
      enough: data.sufficient.video_units,
      hint: 'HeyGen avatar renders. 1 credit ≈ 6.7 seconds of footage.',
    },
    {
      label: 'Voice minutes',
      low: data.cost.voice_minutes.low, high: data.cost.voice_minutes.high,
      balance: data.balance.voice_minutes,
      enough: data.sufficient.voice_minutes,
      hint: 'ElevenLabs voice synthesis. Roughly the spoken duration of the video.',
    },
  ]

  return (
    <div style={{
      marginTop: 16,
      border: `1px solid ${data.can_render ? 'var(--border)' : 'rgba(239,68,68,0.35)'}`,
      borderRadius: 10,
      background: 'var(--surface-2)',
      padding: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Estimated cost
        </div>
        {!data.can_render && (
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--red)' }}>
            Not enough credits
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
            <span style={{ flex: '0 0 110px', color: 'var(--text-soft)' }}>{r.label}</span>
            <span style={{ flex: '0 0 130px', fontWeight: 700 }}>
              {fmt(r.low)} – {fmt(r.high)}
            </span>
            <span style={{ flex: 1, color: 'var(--muted)' }}>
              Balance: <strong style={{ color: r.enough ? 'var(--text-soft)' : 'var(--red)' }}>{fmt(r.balance)}</strong>
            </span>
          </div>
        ))}
      </div>
      {hint && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8, lineHeight: 1.4 }}>
          {hint}
        </div>
      )}
    </div>
  )
}

// Inline editor for the selected look's orientation. Renders a small
// row with three buttons (portrait / landscape / square) right under
// the form when a look is chosen. Saves directly via PATCH on
// /api/avatars/looks. When the look's tag doesn't match the video's
// aspect ratio, a soft warning explains why (HeyGen letterboxes).
function LookOrientationInlineEditor({ look, token, mismatch, unspecified }) {
  const [orientation, setOrientation] = useState(look.orientation || '')
  const [busy, setBusy] = useState(false)
  // Resync if the user switches looks
  useEffect(() => { setOrientation(look.orientation || '') }, [look.id, look.orientation])

  const save = async (newVal) => {
    setBusy(true)
    setOrientation(newVal)
    try {
      const r = await fetch(`/api/avatars/looks?id=${look.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || ''}` },
        body: JSON.stringify({ orientation: newVal || null }),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error(b.error || 'Could not save orientation')
      }
      // Best-effort: also mutate the local look object so the parent
      // re-renders without a full refetch. The next form open picks up
      // the new value from the avatars endpoint.
      look.orientation = newVal || null
      toast({ message: `Look tagged as ${newVal || 'unspecified'}.`, kind: 'success' })
    } catch (e) {
      setOrientation(look.orientation || '')
      toast({ message: e.message, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const showWarning = !!mismatch || unspecified
  const warningKind = mismatch ? 'mismatch' : 'unspecified'

  return (
    <div style={{
      marginTop: 6, marginBottom: 14, padding: 12,
      background: showWarning ? 'rgba(245,158,11,0.10)' : 'var(--surface-2)',
      border: `1px solid ${showWarning ? 'rgba(245,158,11,0.35)' : 'var(--border)'}`,
      borderRadius: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    }}>
      <div style={{ fontSize: 11.5, color: 'var(--text-soft)', fontWeight: 700 }}>
        Look orientation:
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {[
          { v: 'portrait',  label: 'Portrait' },
          { v: 'landscape', label: 'Landscape' },
          { v: 'square',    label: 'Square' },
        ].map((opt) => (
          <button
            key={opt.v}
            type="button"
            onClick={() => save(opt.v)}
            disabled={busy}
            className={orientation === opt.v ? 'btn-primary' : 'btn-secondary'}
            style={{ fontSize: 11, padding: '5px 10px' }}
          >{opt.label}</button>
        ))}
        {orientation && (
          <button type="button" onClick={() => save('')} disabled={busy}
            className="btn-ghost" style={{ fontSize: 11, padding: '5px 10px', color: 'var(--muted)' }}
          >Clear</button>
        )}
      </div>
      {warningKind === 'mismatch' && (
        <div style={{ fontSize: 11, color: '#fbbf24', marginLeft: 'auto', maxWidth: '50%' }}>
          ⚠ This look is tagged <strong>{look.orientation}</strong> but the video is <strong>{mismatch}</strong>. HeyGen will letterbox with white bars. Pick a {mismatch} look or change the video aspect ratio.
        </div>
      )}
      {warningKind === 'unspecified' && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto', maxWidth: '50%' }}>
          This look hasn't been tagged yet. Tag it once and Studio will warn you on every future video that doesn't match.
        </div>
      )}
    </div>
  )
}

// Card in the template gallery picker. Shows name + description + a
// swatch of the template's default accent so the user can scan options
// quickly. Selected card gets a red border + slight scale-up.
function TemplateCard({ template, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: 14,
        borderRadius: 10,
        background: selected ? 'rgba(239,68,68,0.10)' : 'var(--surface-2)',
        border: `1px solid ${selected ? 'rgba(239,68,68,0.6)' : 'var(--border)'}`,
        color: 'var(--text)',
        cursor: 'pointer',
        transition: 'border-color 0.15s, background 0.15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{
          width: 14, height: 14, borderRadius: 3,
          background: template.primary_accent || '#e3151e',
          border: '1px solid rgba(255,255,255,0.15)',
        }} />
        <strong style={{ fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text)' }}>
          {template.name}
        </strong>
        {selected && (
          <CheckCircle2 size={12} style={{ color: '#2ecc71', marginLeft: 'auto' }} />
        )}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.4 }}>
        {template.description}
      </div>
      {Array.isArray(template.tags) && template.tags.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {template.tags.slice(0, 4).map((tag) => (
            <span key={tag} style={{
              fontSize: 10, color: 'var(--text-soft)',
              background: 'var(--surface)', padding: '1px 6px', borderRadius: 4,
              border: '1px solid var(--border)',
            }}>{tag}</span>
          ))}
        </div>
      )}
    </button>
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
// Read the user's studio_manual_mode pref. Defaults to isAdmin so
// admins (testing the full pipeline) see the power-user UI by default
// while regular users see the straight-through generation flow.
function useStudioManualMode() {
  const { session, isAdmin } = useAuth()
  const [pref, setPref] = useState(null)  // null = still loading
  useEffect(() => {
    if (!session?.access_token) return
    let cancelled = false
    fetch('/api/notifications?action=prefs', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => { if (!cancelled) setPref(b.prefs?.studio_manual_mode) })
      .catch(() => { if (!cancelled) setPref(undefined) })
    return () => { cancelled = true }
  }, [session?.access_token])
  // Explicit true/false in prefs wins; otherwise fall back to admin
  // (treat in-flight load as "use the default" to avoid a flicker).
  if (pref === true) return true
  if (pref === false) return false
  return isAdmin
}

function StudioVideoEditor({ videoId }) {
  const { session } = useAuth()
  const navigate = useNavigate()
  const manualMode = useStudioManualMode()
  const [video, setVideo] = useState(null)
  const [error, setError] = useState(null)
  // Schedule-to-YouTube modal. Opens from the "📤 Schedule to YouTube"
  // button next to the final-render download link.
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false)

  // Initial load + defensive refetch when the tab regains focus. The
  // Realtime channel below handles ongoing updates, but long renders
  // (we've seen 20+ min) can outlive a WebSocket on a backgrounded
  // tab — Chrome aggressively throttles inactive tabs, the socket
  // dies silently, and the UI stays stuck on "rendering" even though
  // the DB has long since flipped to 'rendered'. Re-fetching whenever
  // the tab becomes visible again catches every missed broadcast.
  //
  // Hardened so a non-JSON 401 / 5xx page from Vercel can't silently
  // wedge the UI on an infinite spinner — we surface whatever text we
  // got as an error instead.
  useEffect(() => {
    if (!session?.access_token) return
    let cancelled = false
    const fetchVideo = async () => {
      try {
        const r = await authedFetch(`/api/studio/videos?id=${videoId}`, session.access_token)
        const ct = r.headers.get('content-type') || ''
        if (!ct.includes('application/json')) {
          const text = await r.text().catch(() => '')
          if (!cancelled) setError(`Server returned ${r.status} (${ct || 'unknown'}). ${text.slice(0, 200)}`)
          return
        }
        const b = await r.json()
        if (cancelled) return
        if (!r.ok) { setError(b.error || `HTTP ${r.status}`); return }
        if (!b.video) { setError('Server returned an empty video record.'); return }
        setVideo(b.video)
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Network error loading video')
      }
    }
    // Initial cold load.
    fetchVideo()
    // Refetch when the tab regains visibility (user switched back
    // from another tab/window).
    const onVisible = () => { if (document.visibilityState === 'visible') fetchVideo() }
    document.addEventListener('visibilitychange', onVisible)
    // Window focus catches cases where the OS focused the browser
    // without a tab visibility change (e.g. Cmd-Tab back to Chrome).
    window.addEventListener('focus', fetchVideo)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', fetchVideo)
    }
  }, [videoId, session?.access_token])

  // Asset polling loop. Gates on segment-level state (any row currently
  // in generating_*) rather than parent video status, because the parent
  // stays in 'rendering' for both asset gen AND the final bake phase.
  // Using segment state avoids two bugs:
  //   (a) Loop never stopping after asset gen finishes (parent never gets
  //       flipped back to 'editing')
  //   (b) Loop firing during the final bake when there's nothing to poll
  const anyGenerating = (video?.studio_segments || []).some(
    (s) => s.status === 'generating_image' || s.status === 'generating_audio' || s.status === 'generating_avatar'
  )
  useEffect(() => {
    if (!session?.access_token || !videoId) return
    if (!anyGenerating) return
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
  }, [anyGenerating, videoId, session?.access_token])

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

  // Trigger ElevenLabs Voice Isolator on every user-sliced segment of
  // this video. Surfaces via the purple "Clean voice" banner below the
  // sticky action bar. The fly worker runs each segment through EL's
  // audio-isolation endpoint and writes voice_url + voice_cleaned=true
  // back via realtime — segments update one-by-one (~30s each) as they
  // finish. Used when the auto-trigger during initial segmentation
  // didn't land (cold worker / network blip / older video predating
  // the auto-trigger).
  const triggerVoiceIsolation = async () => {
    if (!session?.access_token || !video?.id) return
    try {
      const r = await authedFetch('/api/studio/voiceover/trigger-isolation', session.access_token, {
        method: 'POST', body: JSON.stringify({ studio_video_id: video.id }),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) {
        toast({ message: b.error || 'Voice isolation trigger failed', kind: 'error' })
        return
      }
      toast({
        message: 'Voice cleaning started. Segments will update as each finishes (~30s/segment).',
        kind: 'success',
      })
    } catch (e) {
      toast({ message: e.message, kind: 'error' })
    }
  }

  const regenerate = async (opts = {}) => {
    if (!session?.access_token || !video) return
    const previousVideo = video
    setVideo({ ...video, status: 'mapping', error: null })
    try {
      const body = { studio_video_id: video.id }
      if (opts.confirmWipeRender) body.confirm_wipe_render = true
      const r = await authedFetch('/api/studio/generate-map', session.access_token, {
        method: 'POST', body: JSON.stringify(body),
      })
      const b = await r.json()
      if (r.status === 409 && b.code === 'render_exists') {
        // Server is asking "are you sure?" before wiping a rendered video.
        // Restore state, then prompt the user. If they confirm, re-fire
        // with the flag set; otherwise leave the video untouched.
        setVideo(previousVideo)
        const ok = await confirmDialog({
          title: 'Wipe the existing render?',
          message:
            'This video has already been rendered. Regenerating the map will replace every segment and you will lose the voice, B-roll, and avatar URLs they reference. The rendered MP4 itself stays in storage and remains playable. Continue?',
          confirmText: 'Wipe and regenerate',
          cancelText: 'Keep render',
          destructive: true,
        })
        if (ok) await regenerate({ confirmWipeRender: true })
        return
      }
      if (!r.ok) throw new Error(b.error || 'Could not regenerate')
      setVideo(b.video)
      toast({ message: 'Map regenerated.', kind: 'success' })
    } catch (e) {
      setVideo({ ...previousVideo, status: 'failed', error: e.message })
      toast({ message: e.message, kind: 'error' })
    }
  }

  // Note: NOT using .fade-up here — its forwards-filled transform
  // keyframe creates a containing block that scopes position:sticky
  // and position:fixed children to this div instead of the viewport.
  // Sticky action bar (top) + fixed chat dock (bottom) both need to
  // attach to the viewport, so we drop the entrance animation on
  // the editor page.
  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '32px 24px' }}>
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
            subtitle={`${fmtStatus(video.status)} · ${video.target_duration_secs}s · ${video.aspect_ratio}${video.template_id ? ` · ${video.template_id}` : ''}`}
            action={
              ['mapped', 'failed', 'editing'].includes(video.status) ? (
                <button className="btn-secondary" onClick={regenerate}>
                  <Wand2 size={13} /> Regenerate map
                </button>
              ) : null
            }
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

          {/* Pinned action bar — Render + progress + status. Sticks to
              the top of the editor scroll area so the user can hit
              "Render" from anywhere on the page. Bar lives between the
              header and the rest of the page so position:sticky works. */}
          {(['mapped', 'editing', 'rendering', 'rendered'].includes(video.status)) && (
            <StickyActionBar
              video={video}
              approvedCount={(video.studio_segments || []).filter((s) => s.approved).length}
              totalCount={(video.studio_segments || []).length}
              segments={(video.studio_segments || []).slice().sort((a, b) => a.segment_index - b.segment_index)}
              manualMode={manualMode}
            />
          )}

          {/* Source-level voice cleaning indicator. Shows whenever this
              video was uploaded as a voiceover AND the source file
              hasn't been run through EL Voice Isolator yet. One EL call
              covers the full source — much faster + cheaper than the old
              per-segment approach. Auto-hides once voiceover_cleaned is
              true (Realtime drives the toggle). */}
          {video.voiceover_source_url && !video.voiceover_cleaned && (
            <div style={{
              padding: '10px 14px', marginBottom: 12, borderRadius: 8,
              background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.35)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            }}>
              <div style={{ fontSize: 12.5, color: 'var(--text)' }}>
                Your voiceover source file hasn't been run through ElevenLabs Voice Isolator yet. Cleaning runs on the full file in one pass — strips background noise + room tone, then re-slices all segments. Takes ~30-90s.
              </div>
              <button
                type="button"
                className="btn"
                onClick={triggerVoiceIsolation}
                style={{ fontSize: 12, padding: '6px 12px', background: '#a855f7', color: '#fff', borderRadius: 6, border: 'none', fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}
              >
                🎙️ Clean voice
              </button>
            </div>
          )}

          {video.status === 'failed' && (
            <FailedCard video={video} onRegenerate={regenerate} />
          )}

          {video.status === 'rendered' && video.final_video_url && (
            <div className="card" style={{ padding: 12, marginBottom: 16, background: 'var(--surface-2)' }}>
              <video
                src={video.final_video_url}
                controls
                style={{ width: '100%', borderRadius: 8, display: 'block', background: '#000' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
                <span>Final render</span>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <a href={video.final_video_url} download style={{ color: 'var(--red)', fontWeight: 700 }}>
                    Download MP4 ↓
                  </a>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setScheduleModalOpen(true)}
                    style={{ fontSize: 12, padding: '6px 12px', background: '#ef4444', color: '#fff', borderRadius: 6, border: 'none', fontWeight: 700, cursor: 'pointer' }}
                  >
                    📤 Schedule to YouTube
                  </button>
                </div>
              </div>
              <RenderQualityNote video={video} />
            </div>
          )}

          {scheduleModalOpen && video.status === 'rendered' && video.final_video_url && (
            <ScheduleYouTubeModal
              video={video}
              session={session}
              onClose={() => setScheduleModalOpen(false)}
            />
          )}

          {(['mapped', 'editing', 'rendering', 'rendered'].includes(video.status)) && (
            <>
              {/* Compact template-change row. Full TemplateSelector
                  retired from the editor — template + captions are
                  now picked in the new-video modal. This row is the
                  one-line "wrong template? swap it" affordance. */}
              <TemplateSwapRow video={video} onApplied={(updated) => setVideo(updated || video)} />
              <SegmentList video={video} manualMode={manualMode} />
              {/* AI chat dock disabled per product feedback —
                  re-enable by uncommenting once the surgical-edit
                  flow is polished. */}
              {/* <StudioChat videoId={video.id} /> */}
            </>
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
  { value: 'screenshot',                 label: 'Use screenshot' },
]
// Composition pool kept in sync with api/studio/_lib/templates.js. When
// new templates ship, append their composition IDs here so the segment
// dropdown displays them correctly. If a segment carries an ID outside
// this list (older video, manual edit), we still show it as a one-off
// option at render time — see the dropdown below.
const HF_COMPOSITION_OPTIONS = [
  '',
  // Sleek v2 pool
  'sleek-scene-headline-v1',
  'sleek-scene-list-v1',
  'sleek-scene-claude-chat-v1',
  'sleek-scene-cta-v1',
  // Atlas v1 pool
  'atlas-scene-headline-v1',
  'atlas-scene-list-v1',
  'atlas-scene-claude-chat-v1',
  'atlas-scene-cta-v1',
  // Legacy / shared
  'end-card-v1',
]
// Transition vocabulary kept in sync with worker/studio-render.js
// DEFAULT_TRANSITION_POOL. Names must match exactly — if a segment row
// carries a transition outside this list we fold it in at render time.
const TRANSITION_OPTIONS = [
  'cut',
  'crossfade',
  'fade_transition',
  'swipe_left', 'swipe_right', 'swipe_up', 'swipe_down',
  'light_flare_wipe', 'light_flare_wipe_fast',
]
const SFX_OPTIONS = ['', 'swoosh', 'whoosh', 'ding', 'pop', 'click', 'impact', 'subtle_chime', 'ux_ding']

function SegmentList({ video, manualMode = false }) {
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

  // Split a segment in two at a cursor offset. The Postgres RPC behind
  // /split shifts downstream indexes up by 1 atomically and clears both
  // halves' asset URLs so the next "Generate" pass regenerates voice +
  // visuals from the new text. Realtime delivers the two updated rows
  // back to the editor so the new segment slots into the list directly.
  const splitSegment = async (segmentId, splitAt) => {
    if (!session?.access_token) return
    try {
      const r = await authedFetch('/api/studio/segments/split', session.access_token, {
        method: 'POST',
        body: JSON.stringify({ segment_id: segmentId, split_at: splitAt }),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) {
        toast({ message: b.error || `Split failed (${r.status})`, kind: 'error' })
        return
      }
      toast({ message: 'Segment split. Re-generate assets for the new piece.', kind: 'success' })
    } catch (e) {
      toast({ message: e.message, kind: 'error' })
    }
  }

  // Per-segment regen. Wipes existing asset URLs + fires generate-assets
  // with segment_ids filter + force=true so only this one row burns
  // provider credits. Used by the regen button on avatar / B-roll rows.
  const regenSegment = async (seg, types) => {
    if (!session?.access_token) return
    const kindLabel = types?.length === 1 ? types[0] : 'voice + asset'
    const ok = await confirmDialog({
      title: `Regenerate ${kindLabel} for segment ${seg.segment_index + 1}?`,
      message: `This will re-spend provider credits on this segment. The current ${kindLabel} files will be replaced.`,
      confirmText: 'Regenerate',
      destructive: false,
    })
    if (!ok) return
    try {
      // Clear the columns the orchestrator looks at so it actually does
      // the work instead of skipping the "already done" check.
      const clear = {}
      if (types?.includes('voice')) clear.voice_url = null
      if (types?.includes('image')) clear.image_url = null
      if (types?.includes('avatar')) clear.avatar_video_url = null
      clear.status = 'pending'
      clear.error = null
      await authedFetch(`/api/studio/segments?id=${seg.id}`, session.access_token, {
        method: 'PATCH', body: JSON.stringify(clear),
      })

      // Kick off generate-assets scoped to just this segment.
      const r = await authedFetch('/api/studio/generate-assets', session.access_token, {
        method: 'POST',
        body: JSON.stringify({
          studio_video_id: video.id,
          segment_ids: [seg.id],
          only_types: types,
          force: true,
        }),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error(b.error || 'Regen dispatch failed')
      }
      toast({ message: `Regenerating segment ${seg.segment_index + 1}…`, kind: 'info' })
    } catch (e) {
      toast({ message: e.message, kind: 'error' })
    }
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
            onSplit={(splitAt) => splitSegment(s.id, splitAt)}
            onRegen={(types) => regenSegment(s, types)}
            // No callback body needed — the upload endpoint patches
            // the row itself; Realtime UPDATE delivers the new
            // avatar_video_url to the editor. Passing a no-op is the
            // simplest signal "yes this row supports upload".
            onUploadAvatar={() => { /* realtime handles refresh */ }}
            onUploadScreenshot={() => { /* realtime handles refresh */ }}
            aspectRatio={video.aspect_ratio}
            videoVoiceoverSourceUrl={video.voiceover_source_url || null}
            manualMode={manualMode}
          />
        ))}
      </div>

    </div>
  )
}

// Inline template selector. Sits between the rendered-video player
// and the segment list on the per-video page. Shows the current
// template, an animated HyperFrames preview iframe of how the
// template looks, a brand-color picker, and a single "Use this
// template" button that applies the shallow swap (template_id +
// brand_color + cascade to motion segments) AND immediately fires
// render-final so the user gets a new MP4 without two clicks.
//
// Defaults to collapsed when the current template/color matches the
// video's saved values (nothing to apply). Expands automatically the
// moment the user picks a different template or color, exposing the
// "Use this template" button.
// Inline captions toggle on the video editor. Patches studio_videos.
// captions_enabled and surfaces a nudge that re-running the map is
// required for the new value to land on existing segments (the
// segmentation pass is what auto-injects caption-overlay-v1 placements
// on speaker segments). Standalone — TemplateSelector handles its own
// patch + re-render flow.
function CaptionsToggle({ video, onChanged }) {
  const { session } = useAuth()
  const [enabled, setEnabled] = useState(video.captions_enabled !== false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  // Re-sync when the underlying video changes (e.g. Realtime push).
  useEffect(() => {
    setEnabled(video.captions_enabled !== false)
  }, [video.captions_enabled])

  const flip = async (next) => {
    if (!session?.access_token || busy) return
    setBusy(true)
    setHint('')
    try {
      const r = await authedFetch(`/api/studio/videos?id=${video.id}`, session.access_token, {
        method: 'PATCH',
        body: { captions_enabled: next },
      })
      if (!r.ok) throw new Error('Save failed')
      const updated = await r.json().catch(() => null)
      setEnabled(next)
      onChanged?.(updated)
      setHint('Re-run "Regenerate map" to apply on existing segments.')
    } catch (e) {
      setHint(`Could not save: ${e.message}`)
      setEnabled(!next)  // revert UI on error
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 10, marginBottom: 12,
    }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: busy ? 'wait' : 'pointer' }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => flip(e.target.checked)}
          style={{ width: 16, height: 16 }}
        />
        <span style={{ fontSize: 13, fontWeight: 700 }}>
          Captions {enabled ? 'on' : 'off'}
        </span>
      </label>
      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>
        Word-by-word lower-third overlay on speaker segments.
      </span>
      {hint && (
        <span style={{ fontSize: 12, color: 'rgba(255,200,120,0.85)', marginLeft: 'auto' }}>
          {hint}
        </span>
      )}
    </div>
  )
}

// Overlays toggle + manual run. When `overlays_enabled` is true, the
// Render button auto-calls enrich-overlays before kicking off the bake
// so placements stay in sync with the script. The "Run now" button
// here is just for the impatient who want to preview before rendering.
function OverlaysToggle({ video, onChanged }) {
  const { session } = useAuth()
  const [enabled, setEnabled] = useState(video.overlays_enabled !== false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => { setEnabled(video.overlays_enabled !== false) }, [video.overlays_enabled])

  const flip = async (next) => {
    if (!session?.access_token || busy) return
    setBusy(true); setErr('')
    try {
      const r = await authedFetch(`/api/studio/videos?id=${video.id}`, session.access_token, {
        method: 'PATCH',
        body: { overlays_enabled: next },
      })
      if (!r.ok) throw new Error('Save failed')
      const updated = await r.json().catch(() => null)
      setEnabled(next)
      onChanged?.(updated)
    } catch (e) {
      setErr(`Could not save: ${e.message}`)
      setEnabled(!next)
    } finally {
      setBusy(false)
    }
  }

  const runNow = async () => {
    if (!session?.access_token || busy) return
    setBusy(true); setErr(''); setResult(null)
    try {
      const r = await authedFetch('/api/studio/enrich-overlays', session.access_token, {
        method: 'POST', body: { studio_video_id: video.id },
      })
      const text = await r.text()
      let body = null
      try { body = JSON.parse(text) } catch { /* not JSON */ }
      if (!r.ok) {
        if (body?.error) throw new Error(body.error)
        if (r.status === 504) throw new Error('Enrichment timed out. Try again.')
        throw new Error(`Request failed (${r.status}). ${text.slice(0, 120)}`)
      }
      if (!body) throw new Error('Server returned a non-JSON response. Check Vercel logs.')
      setResult(body)
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 10, marginBottom: 12, flexWrap: 'wrap',
    }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: busy ? 'wait' : 'pointer' }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => flip(e.target.checked)}
          style={{ width: 16, height: 16 }}
        />
        <span style={{ fontSize: 13, fontWeight: 700 }}>Overlays {enabled ? 'on' : 'off'}</span>
      </label>
      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>
        {enabled
          ? 'Auto-runs before every render. Stat callouts, tool logos, chapter markers, etc.'
          : 'Render skips overlay enrichment. Manage placements manually.'}
      </span>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={runNow}
        style={{ marginLeft: 'auto', padding: '6px 12px', fontSize: 12, fontWeight: 600 }}
      >
        {busy ? 'Working…' : 'Run now'}
      </button>
      {result && (
        <span style={{ fontSize: 12, color: '#84e1bc', fontWeight: 600, flexBasis: '100%' }}>
          {result.segments_updated} segments updated · {result.visual_overlays_added} overlays · {result.captions_injected} captions
        </span>
      )}
      {err && (
        <span style={{ fontSize: 12, color: '#ff6b6b', flexBasis: '100%' }}>{err}</span>
      )}
    </div>
  )
}

// Auto-fit motion-graphics toggle. When on, the Render flow calls
// /api/studio/refresh-motion-graphics before baking so every motion
// segment's composition_id + variables match its actual script. Solves
// the common drift where stat-reveal-v1 with stat_number "10" lingers
// on a segment whose script never mentions a number.
function MotionGraphicsToggle({ video, onChanged }) {
  const { session } = useAuth()
  const [enabled, setEnabled] = useState(video.motion_graphics_enabled !== false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => { setEnabled(video.motion_graphics_enabled !== false) }, [video.motion_graphics_enabled])

  const flip = async (next) => {
    if (!session?.access_token || busy) return
    setBusy(true); setErr('')
    try {
      const r = await authedFetch(`/api/studio/videos?id=${video.id}`, session.access_token, {
        method: 'PATCH',
        body: { motion_graphics_enabled: next },
      })
      if (!r.ok) throw new Error('Save failed')
      const updated = await r.json().catch(() => null)
      setEnabled(next)
      onChanged?.(updated)
    } catch (e) {
      setErr(`Could not save: ${e.message}`)
      setEnabled(!next)
    } finally {
      setBusy(false)
    }
  }

  const runNow = async () => {
    if (!session?.access_token || busy) return
    setBusy(true); setErr(''); setResult(null)
    try {
      const r = await authedFetch('/api/studio/refresh-motion-graphics', session.access_token, {
        method: 'POST', body: { studio_video_id: video.id },
      })
      const text = await r.text()
      let body = null
      try { body = JSON.parse(text) } catch { /* not JSON */ }
      if (!r.ok) {
        if (body?.error) throw new Error(body.error)
        if (r.status === 504) throw new Error('Refresh timed out. Try again.')
        throw new Error(`Request failed (${r.status}). ${text.slice(0, 120)}`)
      }
      if (!body) throw new Error('Server returned a non-JSON response. Check Vercel logs.')
      setResult(body)
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 10, marginBottom: 12, flexWrap: 'wrap',
    }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: busy ? 'wait' : 'pointer' }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => flip(e.target.checked)}
          style={{ width: 16, height: 16 }}
        />
        <span style={{ fontSize: 13, fontWeight: 700 }}>Auto-fit motion graphics {enabled ? 'on' : 'off'}</span>
      </label>
      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>
        {enabled
          ? 'Re-picks composition + content per segment before every render.'
          : 'Motion graphics stay as-is. Edit by hand or via chat.'}
      </span>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={runNow}
        style={{ marginLeft: 'auto', padding: '6px 12px', fontSize: 12, fontWeight: 600 }}
      >
        {busy ? 'Working…' : 'Run now'}
      </button>
      {result && (
        <span style={{ fontSize: 12, color: '#84e1bc', fontWeight: 600, flexBasis: '100%' }}>
          {result.refreshed} / {result.motion_segments_total} motion segments refreshed
          {result.composition_changes?.length > 0 && ` · ${result.composition_changes.length} composition swap(s)`}
        </span>
      )}
      {err && (
        <span style={{ fontSize: 12, color: '#ff6b6b', flexBasis: '100%' }}>{err}</span>
      )}
    </div>
  )
}

// Visual template panel — phase-2 layout per the Scale Solo Updates PDF.
// Compact one-line template-swap row shown above the segment list
// in the editor. Replaces the heavy in-editor TemplateSelector (which
// duplicated the picker the new-video modal already shows). One
// dropdown to switch templates, a captions toggle, a save button.
function TemplateSwapRow({ video, onApplied }) {
  const { session } = useAuth()
  const [templates, setTemplates] = useState([])
  const [templateId, setTemplateId] = useState(video.template_id || 'sleek')
  const [captionsOn, setCaptionsOn] = useState(video.captions_enabled !== false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!session?.access_token) return
    let cancelled = false
    authedFetch('/api/studio/templates', session.access_token)
      .then((r) => r.ok ? r.json() : { templates: [] })
      .then((b) => { if (!cancelled) setTemplates(b.templates || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [session?.access_token])

  const savedTemplate = video.template_id || 'sleek'
  const savedCaptions = video.captions_enabled !== false
  const dirty = templateId !== savedTemplate || captionsOn !== savedCaptions

  const apply = async () => {
    if (!session?.access_token || busy || !dirty) return
    setBusy(true)
    try {
      const patches = []
      if (templateId !== savedTemplate) {
        patches.push(authedFetch('/api/studio/apply-template', session.access_token, {
          method: 'POST',
          body: JSON.stringify({ studio_video_id: video.id, template_id: templateId, deep: false }),
        }))
      }
      if (captionsOn !== savedCaptions) {
        patches.push(authedFetch(`/api/studio/videos?id=${video.id}`, session.access_token, {
          method: 'PATCH',
          body: JSON.stringify({ captions_enabled: captionsOn }),
        }))
      }
      await Promise.all(patches)
      toast({ message: 'Visual settings saved. Re-render to apply.', kind: 'success' })
      onApplied?.({ ...video, template_id: templateId, captions_enabled: captionsOn })
    } catch (e) {
      toast({ message: e.message, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 14px', marginBottom: 12,
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      fontSize: 12.5,
    }}>
      <span style={{ color: 'var(--muted)', fontWeight: 700, fontSize: 11, letterSpacing: 0.1, textTransform: 'uppercase' }}>Template</span>
      <select
        className="input" value={templateId}
        onChange={(e) => setTemplateId(e.target.value)}
        style={{ padding: '6px 10px', fontSize: 12.5, maxWidth: 220 }}
      >
        {templates.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-soft)', cursor: 'pointer' }}>
        <input type="checkbox" checked={captionsOn} onChange={(e) => setCaptionsOn(e.target.checked)} />
        <span>Captions</span>
      </label>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        onClick={apply}
        disabled={!dirty || busy}
        className="btn-primary"
        style={{ fontSize: 12, padding: '6px 14px' }}
      >
        {busy ? <Loader2 size={12} className="spin" /> : null}
        {dirty ? 'Save changes' : 'Saved'}
      </button>
    </div>
  )
}

// Legacy full-screen template selector. Kept around as dead code in
// case we want to revive the rich preview surface — the compact
// TemplateSwapRow above replaces it in the editor today.
// eslint-disable-next-line no-unused-vars
function TemplateSelector({ video, onApplied }) {
  const { session } = useAuth()
  const [templates, setTemplates] = useState([])
  const [templateId, setTemplateId] = useState(video.template_id || 'sleek')
  const [captionsOn, setCaptionsOn] = useState(video.captions_enabled !== false)
  const [busy, setBusy] = useState(false)

  // Load the template list on mount.
  useEffect(() => {
    if (!session?.access_token) return
    authedFetch('/api/studio/templates', session.access_token)
      .then((r) => r.ok ? r.json() : { templates: [] })
      .then((b) => setTemplates(b.templates || []))
      .catch(() => {})
  }, [session?.access_token])

  // Resync when the video row mutates from Realtime / re-render.
  useEffect(() => { setTemplateId(video.template_id || 'sleek') }, [video.template_id])
  useEffect(() => { setCaptionsOn(video.captions_enabled !== false) }, [video.captions_enabled])

  const selected = templates.find((t) => t.id === templateId)
  const savedTemplate = video.template_id || 'sleek'
  const savedCaptions = video.captions_enabled !== false
  const dirty = templateId !== savedTemplate || captionsOn !== savedCaptions

  // Preview iframe vars. Cascade the user's brand primary + secondary
  // colors into the preview so the composition shows the actual palette
  // the bake will use, not the template's stock indigo/red. Falls back
  // to template defaults if the video / profile doesn't have brand
  // colors set yet.
  const previewVars = useMemo(() => {
    if (!selected?.preview) return null
    const vars = { ...(selected.preview.variables || {}) }
    const accent   = video.brand_color           || selected.primary_accent   || '#e3151e'
    const accent_2 = video.brand_color_secondary || selected.secondary_accent || accent
    for (const k of Object.keys(vars)) {
      if (typeof vars[k] !== 'string') continue
      if (vars[k] === '{accent}')   vars[k] = accent
      if (vars[k] === '{accent_2}') vars[k] = accent_2
    }
    vars.accent_color   = accent
    vars.accent_2_color = accent_2
    return vars
  }, [selected?.preview, selected?.primary_accent, selected?.secondary_accent, video.brand_color, video.brand_color_secondary])

  const apply = async () => {
    if (!session?.access_token || busy || !dirty) return
    setBusy(true)
    try {
      // Patch template + captions toggle in one round-trip when both
      // changed, OR two parallel round-trips when only one did.
      const patches = []
      if (templateId !== savedTemplate) {
        patches.push(authedFetch('/api/studio/apply-template', session.access_token, {
          method: 'POST',
          body: JSON.stringify({
            studio_video_id: video.id,
            template_id: templateId,
            deep: false,
          }),
        }))
      }
      if (captionsOn !== savedCaptions) {
        patches.push(authedFetch(`/api/studio/videos?id=${video.id}`, session.access_token, {
          method: 'PATCH',
          body: { captions_enabled: captionsOn },
        }))
      }
      const results = await Promise.all(patches)
      for (const r of results) {
        if (!r.ok) {
          const b = await r.json().catch(() => ({}))
          throw new Error(b.error || 'Could not apply changes')
        }
      }

      // Kick off the final bake. Asset URLs are preserved through the
      // shallow apply, so this is essentially a free re-render: just
      // ffmpeg pulling existing audio/avatar/image bytes from Supabase
      // with the new HyperFrames CSS vars + caption toggle baked in.
      const r2 = await authedFetch('/api/studio/render-final', session.access_token, {
        method: 'POST',
        body: JSON.stringify({ studio_video_id: video.id }),
      })
      const b2 = await r2.json().catch(() => ({}))
      if (!r2.ok) throw new Error(b2.error || 'Re-render failed')
      toast({ message: `Applied ${selected?.name || templateId}. New render is on the way.`, kind: 'success' })

      // Refresh the parent's video row.
      const r3 = await authedFetch(`/api/studio/videos?id=${video.id}`, session.access_token)
      const b3 = await r3.json().catch(() => ({}))
      onApplied?.(b3?.video)
    } catch (e) {
      toast({ message: e.message, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  if (templates.length === 0) return null

  return (
    <div className="card" style={{ marginBottom: 16, padding: 0, overflow: 'hidden' }}>
      <div style={{
        display: 'grid',
        // Left = scrollable list. Right = bigger preview + caption +
        // apply button. minmax keeps the list at a usable width while
        // letting the preview fill remaining space.
        gridTemplateColumns: 'minmax(220px, 280px) 1fr',
      }}>
        {/* Left: scrollable template list */}
        <div style={{
          borderRight: '1px solid var(--border)',
          maxHeight: 420, overflowY: 'auto',
          padding: 12,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>
            Visual template
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {templates.map((t) => {
              const isPicked = t.id === templateId
              const isSaved = t.id === savedTemplate
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => !busy && setTemplateId(t.id)}
                  disabled={busy}
                  style={{
                    textAlign: 'left',
                    padding: '12px 14px',
                    border: `1px solid ${isPicked ? 'var(--red)' : 'var(--border)'}`,
                    borderRadius: 10,
                    background: isPicked ? 'rgba(239,68,68,0.10)' : 'var(--surface-2)',
                    cursor: busy ? 'wait' : 'pointer',
                    transition: 'border-color 0.15s, background 0.15s',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    <span style={{
                      width: 12, height: 12, borderRadius: 3,
                      background: t.primary_accent || '#e3151e',
                      boxShadow: `0 0 8px ${t.primary_accent || '#e3151e'}66`,
                    }} />
                    <strong style={{ fontSize: 13, color: 'var(--text)' }}>{t.name}</strong>
                    {isSaved && (
                      <span style={{
                        fontSize: 9.5, fontWeight: 700, color: 'var(--muted)',
                        letterSpacing: '0.08em', textTransform: 'uppercase',
                        marginLeft: 'auto',
                      }}>In use</span>
                    )}
                  </div>
                  {t.description && (
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.4 }}>
                      {t.description}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Right: preview + captions + apply */}
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Preview · {selected?.name || templateId}
          </div>
          {selected?.preview?.composition_id && previewVars ? (
            <HyperFramesPreview
              compositionId={selected.preview.composition_id}
              variables={previewVars}
              height={null}
              aspectRatio={video.aspect_ratio}
            />
          ) : (
            <div style={{
              aspectRatio: video.aspect_ratio === '9:16' ? '9 / 16' : video.aspect_ratio === '1:1' ? '1 / 1' : '16 / 9',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              display: 'grid',
              placeItems: 'center',
              color: 'var(--muted)',
              fontSize: 12,
            }}>
              No preview available for this template.
            </div>
          )}

          {/* Captions toggle — moved here from the standalone CaptionsToggle
              component. The single "Use this template" button below
              applies both template change AND captions change in one bake. */}
          <label style={{
            display: 'inline-flex', alignItems: 'center', gap: 10,
            cursor: busy ? 'wait' : 'pointer', userSelect: 'none',
            padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8,
            background: 'var(--surface-2)',
          }}>
            <input
              type="checkbox"
              checked={captionsOn}
              disabled={busy}
              onChange={(e) => setCaptionsOn(e.target.checked)}
              style={{ width: 16, height: 16 }}
            />
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Captions {captionsOn ? 'on' : 'off'}
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 4 }}>
              Word-by-word lower-third on every voiceover segment.
            </span>
          </label>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              type="button"
              className="btn-primary"
              disabled={!dirty || busy}
              onClick={apply}
              style={{ fontSize: 13, padding: '10px 18px' }}
              title={dirty
                ? `Apply ${selected?.name || templateId} and re-render the final MP4 (avatar/voice/B-roll assets are reused — no extra cost).`
                : 'No changes to apply.'}
            >
              {busy ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
              {busy ? 'Applying + re-rendering…' : 'Use this template'}
            </button>
            {!dirty && (
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                No changes. Pick a different template or flip captions to enable.
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Old modal-based template switcher — kept only for reference, no
// longer rendered. Inline TemplateSelector above replaces it.
// eslint-disable-next-line no-unused-vars
function TemplateChangeButton({ video, onApplied }) {
  const { session } = useAuth()
  const [open, setOpen] = useState(false)
  const [templates, setTemplates] = useState([])
  const [templateId, setTemplateId] = useState(video.template_id || 'sleek')
  const [brandColor, setBrandColor] = useState(video.brand_color || '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || !session?.access_token) return
    authedFetch('/api/studio/templates', session.access_token)
      .then((r) => r.ok ? r.json() : { templates: [] })
      .then((b) => {
        setTemplates(b.templates || [])
        // Seed brand color from the currently-selected template if the
        // video doesn't already have a custom color set.
        if (!brandColor) {
          const cur = (b.templates || []).find((t) => t.id === templateId)
          if (cur?.primary_accent) setBrandColor(cur.primary_accent)
        }
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session?.access_token])

  const selected = templates.find((t) => t.id === templateId)

  const apply = async (deep) => {
    if (!session?.access_token) return
    if (deep) {
      const ok = await confirmDialog({
        title: 'Wipe the map and re-segment?',
        message: `Re-segmenting with "${selected?.name || templateId}" will replace every segment in the map with a fresh draft Claude writes against the new template's pacing and composition pool. Your voice, B-roll, and avatar URLs will be lost — you'll need to regenerate assets after.\n\nThe existing rendered MP4 stays in storage and remains playable until you bake a new one.`,
        confirmText: 'Wipe and re-segment',
        cancelText: 'Cancel',
        destructive: true,
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      const r = await authedFetch('/api/studio/apply-template', session.access_token, {
        method: 'POST',
        body: JSON.stringify({
          studio_video_id: video.id,
          template_id: templateId,
          brand_color: brandColor || null,
          deep,
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error || 'Could not apply template')
      toast({
        message: deep
          ? `Re-segmenting with ${selected?.name || templateId}…`
          : `Applied ${selected?.name || templateId}. Hit Re-render to bake the new look.`,
        kind: 'success',
      })
      setOpen(false)
      onApplied?.()
    } catch (e) {
      toast({ message: e.message, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)} title="Switch the visual template for this video">
        <Sparkles size={13} /> Change template
      </button>
      {open && (
        <div
          role="dialog" aria-modal="true"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 250,
            background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
            display: 'grid', placeItems: 'center', padding: 20,
          }}
        >
          <div
            style={{
              width: 'min(720px, 100%)', maxHeight: '90vh', overflowY: 'auto',
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 14, padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
            }}
          >
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, margin: '0 0 6px' }}>
              Change visual template
            </h2>
            <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 18px', lineHeight: 1.5 }}>
              Pick a new look. <strong>Update styling only</strong> keeps your script, B-roll, and avatar segments — just swaps the visual identity and brand color. <strong>Re-segment</strong> rebuilds the entire map with the new template's pacing.
            </p>

            <div style={{ marginBottom: 16 }}>
              <Label>Template</Label>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                gap: 8,
              }}>
                {templates.map((t) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    selected={templateId === t.id}
                    onClick={() => {
                      setTemplateId(t.id)
                      // Reset brand color to the new template's default
                      if (t.primary_accent) setBrandColor(t.primary_accent)
                    }}
                  />
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <Label>Brand color</Label>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input
                  type="color"
                  value={brandColor || selected?.primary_accent || '#e3151e'}
                  onChange={(e) => setBrandColor(e.target.value)}
                  style={{ width: 56, height: 36, border: '1px solid var(--border)', borderRadius: 6, background: 'transparent', padding: 0, cursor: 'pointer' }}
                />
                <input
                  type="text"
                  className="input"
                  value={brandColor || selected?.primary_accent || '#e3151e'}
                  onChange={(e) => setBrandColor(e.target.value)}
                  style={{ width: 130, fontSize: 12 }}
                  maxLength={9}
                />
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Cascades into every motion graphic.
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => apply(true)}
                disabled={busy}
                title="Wipe the map and re-run Claude with the new template's pacing + composition pool. Slow + expensive (Claude tokens + lost assets)."
              >
                Re-segment
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => apply(false)}
                disabled={busy}
              >
                {busy ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                Update styling only
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// Context-aware failure card. Failures bubble up to status='failed' from
// any of three pipeline stages; the recovery action depends on which
// stage actually broke. We infer from segment + final_video_url state:
//   • No segments        → mapping failed → safe to Regenerate map
//   • Segments, no assets → asset gen failed → Generate assets (no map loss)
//   • Segments + assets, no final → bake failed → Render final (preserves all work)
function FailedCard({ video, onRegenerate }) {
  const { session } = useAuth()
  const [busy, setBusy] = useState(false)
  const segs = video.studio_segments || []
  const approvedSegs = segs.filter((s) => s.approved)
  const anyAssetUrl = approvedSegs.some((s) => s.voice_url || s.image_url || s.avatar_video_url)

  // Stage inference. When segments + assets + a final_video_url all
  // exist, the failure must have been a re-bake attempt (the old
  // final MP4 stays in storage on a failed re-bake, intentionally,
  // so the user keeps a playable version while they retry). So that
  // case is also a 'bake' failure, NOT a mapping fallback.
  const stage = segs.length === 0 ? 'mapping'
    : !anyAssetUrl ? 'asset-gen'
    : 'bake'

  const label = ({
    mapping:    'Mapping failed',
    'asset-gen': 'Asset generation failed',
    bake:       'Render failed',
  })[stage]

  const hint = ({
    mapping:    'Hit "Regenerate map" to re-run Claude. Your topic and references are preserved.',
    'asset-gen': 'Hit "Retry assets" to re-run failed segments. The map and any completed segments are kept.',
    bake:       'Hit "Retry render" to re-stitch the final MP4. All segments and generated assets are kept.',
  })[stage]

  const retry = async () => {
    if (!session?.access_token) return
    setBusy(true)
    try {
      if (stage === 'mapping') {
        await onRegenerate()
        return
      }
      const endpoint = stage === 'asset-gen' ? '/api/studio/generate-assets' : '/api/studio/render-final'
      const r = await authedFetch(endpoint, session.access_token, {
        method: 'POST', body: JSON.stringify({ studio_video_id: video.id }),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b.error || 'Retry failed')
      toast({ message: stage === 'asset-gen' ? 'Re-running asset generation.' : 'Re-running final render.', kind: 'success' })
    } catch (e) {
      toast({ message: e.message, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ padding: 24, borderColor: 'rgba(239,68,68,0.45)', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--red)', fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>
        <AlertCircle size={14} /> {label}
      </div>
      {hint && <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>{hint}</div>}
      <details style={{ marginBottom: 12 }}>
        <summary style={{ fontSize: 11.5, color: 'var(--muted)', cursor: 'pointer', marginBottom: 6 }}>
          Show error detail
        </summary>
        <pre style={{
          fontSize: 11, lineHeight: 1.4, color: 'var(--text-soft)',
          background: 'var(--surface)', padding: 10, borderRadius: 6,
          border: '1px solid var(--border)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          maxHeight: 220, overflowY: 'auto', margin: 0,
        }}>{video.error || 'No detail provided.'}</pre>
      </details>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn-primary" disabled={busy} onClick={retry}>
          {busy ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />}
          {stage === 'mapping' ? 'Regenerate map' : stage === 'asset-gen' ? 'Retry assets' : 'Retry render'}
        </button>
        {stage !== 'mapping' && (
          <button className="btn-secondary" disabled={busy} onClick={onRegenerate} title="Wipe the map and re-run Claude. Use only if the script itself is the problem.">
            Regenerate map
          </button>
        )}
      </div>
    </div>
  )
}

// Studio chat editor. Sits between the video map and the sticky action
// bar. User types natural-language edits ("swap segment 4's B-roll to a
// beach sunset", "make all title cards use red accent"); the server-side
// chat agent translates into structured patch / swap / insert / delete
// ops against studio_segments. Realtime delivers the resulting mutations
// to the table above so the user sees the edits land live.
//
// History is local-only for v1 — no persistence between page loads.
// Last 12 turns get sent along on each call so multi-step "ok now do X"
// follow-ups work coherently.
function StudioChat({ videoId }) {
  const { session } = useAuth()
  // Transcript visibility — opens automatically the moment the user
  // sends a message OR explicitly toggles via the chevron. The input
  // bar itself is always visible at the bottom of the page.
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [history, setHistory] = useState([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef(null)

  // Scroll the transcript to the bottom whenever a new turn lands.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [history, busy])

  // Auto-open the transcript the first time anything lands in it.
  useEffect(() => {
    if (history.length > 0) setTranscriptOpen(true)
  }, [history.length])

  const send = async () => {
    const msg = draft.trim()
    if (!msg || busy || !session?.access_token) return
    setDraft('')
    setBusy(true)
    // Optimistically render the user turn so the input clears
    // immediately and the user sees their message in the transcript.
    setHistory((h) => [...h, { role: 'user', content: msg }])
    try {
      const r = await authedFetch('/api/studio/chat', session.access_token, {
        method: 'POST',
        body: JSON.stringify({
          studio_video_id: videoId,
          message: msg,
          // Only send role+content. The server doesn't replay tool_use
          // blocks from prior turns; it just needs the conversational
          // shape so multi-turn follow-ups make sense.
          history: history.map((h) => ({ role: h.role, content: h.content })),
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error || 'Chat failed')
      setHistory((h) => [...h, {
        role: 'assistant',
        content: body.assistant_message || 'Done.',
        ops: body.applied_ops || [],
        errors: body.errors || [],
      }])
      if (body.applied_ops?.length) {
        toast({
          message: `Applied ${body.applied_ops.length} edit${body.applied_ops.length === 1 ? '' : 's'} from chat.`,
          kind: 'success',
        })
      }
    } catch (e) {
      setHistory((h) => [...h, { role: 'assistant', content: `Error: ${e.message}`, error: true }])
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (e) => {
    // Enter sends; Shift+Enter inserts newline for multi-line requests.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  // The dock is portaled to document.body so position:fixed actually
  // attaches to the viewport. The editor wrapper uses .fade-up which
  // animates via transform — and any ancestor with a transform creates
  // a containing block, which scopes position:fixed to that ancestor
  // instead of the viewport. The portal escapes that scope entirely.
  const dock = (
    <>
      {/* Fixed bottom dock. Always visible while editing a video. The
          transcript panel slides up out of the dock when there's
          history or the user expands it. */}
      <div style={{
        position: 'fixed',
        left: 0, right: 0, bottom: 0,
        zIndex: 50,
        background: 'color-mix(in srgb, var(--bg) 88%, transparent)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderTop: '1px solid var(--border)',
        boxShadow: '0 -8px 24px rgba(0,0,0,0.4)',
      }}>
        <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px' }}>
          {transcriptOpen && (
            <div
              ref={scrollRef}
              style={{
                maxHeight: 300, overflowY: 'auto',
                padding: '14px 0', display: 'flex', flexDirection: 'column', gap: 10,
                borderBottom: '1px solid var(--border)',
              }}
            >
              {history.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Send a request — Claude edits the map for you. Try "swap segment 4 to a stat-reveal showing 47K" or "drop segment 7".
                </div>
              ) : (
                <>
                  {history.map((m, i) => <ChatTurn key={i} turn={m} />)}
                  {busy && (
                    <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Loader2 size={12} className="spin" /> Thinking…
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* The always-visible input row — search-bar style. */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '12px 0' }}>
            <button
              type="button"
              onClick={() => setTranscriptOpen((v) => !v)}
              title={transcriptOpen ? 'Hide transcript' : 'Show transcript'}
              style={{
                width: 36, height: 36, borderRadius: 10,
                background: 'rgba(239,68,68,0.16)', color: 'var(--red)',
                display: 'grid', placeItems: 'center', flexShrink: 0,
                border: 'none', cursor: 'pointer',
              }}
            >
              <Sparkles size={16} />
            </button>
            <input
              type="text"
              className="input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder='Ask Claude to edit the map — e.g. "make all motion-graphics red" or "drop segment 7"'
              style={{ flex: 1, fontSize: 13.5, height: 40 }}
              disabled={busy}
              maxLength={4000}
            />
            <button
              type="button"
              className="btn-primary"
              onClick={send}
              disabled={busy || !draft.trim()}
              style={{ height: 40, padding: '0 16px', flexShrink: 0 }}
            >
              {busy ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
              {busy ? 'Sending' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </>
  )

  // Spacer stays IN the editor flow so content doesn't slide under the
  // dock. The dock itself escapes via portal so position:fixed snaps
  // to the viewport regardless of ancestor transforms.
  return (
    <>
      <div style={{ height: transcriptOpen ? 380 : 80 }} aria-hidden="true" />
      {typeof document !== 'undefined' && createPortal(dock, document.body)}
    </>
  )
}

function ChatTurn({ turn }) {
  const isUser = turn.role === 'user'
  return (
    <div style={{
      alignSelf: isUser ? 'flex-end' : 'flex-start',
      maxWidth: '85%',
      padding: '8px 12px', borderRadius: 10,
      background: isUser ? 'rgba(239,68,68,0.16)' : 'var(--surface)',
      border: `1px solid ${turn.error ? 'rgba(239,68,68,0.45)' : 'var(--border)'}`,
      color: turn.error ? 'var(--red)' : 'var(--text)',
    }}>
      <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>{turn.content}</div>
      {!isUser && Array.isArray(turn.ops) && turn.ops.length > 0 && (
        <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dashed var(--border)' }}>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 4 }}>
            Applied {turn.ops.length} {turn.ops.length === 1 ? 'edit' : 'edits'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.4 }}>
            {turn.ops.slice(0, 6).map((op, i) => (
              <div key={i}>· {opSummary(op)}</div>
            ))}
            {turn.ops.length > 6 && (
              <div style={{ color: 'var(--muted)' }}>… and {turn.ops.length - 6} more.</div>
            )}
          </div>
        </div>
      )}
      {!isUser && Array.isArray(turn.errors) && turn.errors.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--red)' }}>
          {turn.errors.length} op{turn.errors.length === 1 ? '' : 's'} failed: {turn.errors.map((e) => e.error).join('; ')}
        </div>
      )}
    </div>
  )
}

function opSummary(op) {
  switch (op?.kind) {
    case 'patch_segment':     return `Patched segment ${shortId(op.segment_id)} (${(op.changed || []).join(', ')})`
    case 'delete_segment':    return `Deleted segment ${shortId(op.segment_id)}`
    case 'insert_segment':    return `Inserted new segment at index ${op.at_index}`
    case 'swap_composition':  return `Swapped segment ${shortId(op.segment_id)} → ${op.composition_id}`
    default: return op?.kind || 'unknown op'
  }
}
function shortId(id) { return id ? String(id).slice(0, 8) : '?' }

// Real progress bar driven by studio_videos.render_progress. Realtime
// pushes incremental updates as render-final.js writes per-chunk
// progress, so the user sees the fill animate as the bake progresses.
// Falls back to an indeterminate spinner if render_progress isn't set
// yet (first second of the bake, or videos rendered before this column
// existed).
function RenderProgressBar({ video }) {
  const rp = video.render_progress || null
  const stage = rp?.stage || 'baking'
  const current = Number(rp?.current ?? 0)
  const total = Number(rp?.total ?? 0)
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : null
  const stageLabel = ({
    baking: 'Rendering segments…',
    concat: 'Stitching final video…',
    upload: 'Uploading to storage…',
    done:   'Done',
  })[stage] || 'Rendering…'

  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Loader2 size={12} className="spin" style={{ color: '#fbbf24' }} />
        <strong style={{ color: 'var(--text)' }}>{stageLabel}</strong>
        {pct != null && (
          <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
            {current} / {total} ({pct}%)
          </span>
        )}
      </div>
      <div style={{
        position: 'relative',
        width: '100%', height: 6,
        background: 'rgba(255,255,255,0.08)',
        borderRadius: 999,
        overflow: 'hidden',
      }}>
        {pct != null ? (
          <div style={{
            width: `${pct}%`, height: '100%',
            background: 'linear-gradient(90deg, #fbbf24, var(--red))',
            transition: 'width 0.4s ease-out',
            borderRadius: 999,
          }} />
        ) : (
          <div style={{
            width: '30%', height: '100%',
            background: 'linear-gradient(90deg, transparent, var(--red), transparent)',
            borderRadius: 999,
            animation: 'studioProgressIndet 1.4s linear infinite',
          }} />
        )}
      </div>
      <style>{`
        @keyframes studioProgressIndet {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  )
}

// Inline summary that shows after a successful render when not every
// motion-graphics segment rendered with the full HyperFrames template.
// Without this, a user gets a video where the motion graphics are
// text-on-black drawtext stubs and has no signal as to why.
function RenderQualityNote({ video }) {
  const rp = video.render_progress
  if (!rp || rp.stage !== 'done') return null
  const fb = Array.isArray(rp.hf_fallback) ? rp.hf_fallback : []
  if (fb.length === 0) return null
  const hfOk = Array.isArray(rp.hf_rendered) ? rp.hf_rendered.length : 0
  const total = hfOk + fb.length
  const firstReason = fb[0]?.reason || 'unknown'
  return (
    <details style={{
      marginTop: 8, padding: 10,
      background: 'rgba(245,158,11,0.08)',
      border: '1px solid rgba(245,158,11,0.3)',
      borderRadius: 8,
      fontSize: 12,
    }}>
      <summary style={{ cursor: 'pointer', color: '#fbbf24' }}>
        <AlertCircle size={11} style={{ verticalAlign: 'middle', marginRight: 6 }} />
        <strong>{hfOk} of {total}</strong> motion graphics rendered with the full template ({fb.length} used the text fallback)
      </summary>
      <div style={{ marginTop: 8, color: 'var(--text-soft)' }}>
        First fallback reason: <code style={{ background: 'var(--surface)', padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>{firstReason}</code>
        {fb[0]?.launch_err && (
          <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 11 }}>
            Browser launch error: {fb[0].launch_err}
          </div>
        )}
        <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 11 }}>
          Hit Re-render after the next deploy to retry with the full template.
        </div>
      </div>
    </details>
  )
}

// Bulk-download all avatar segment voices. Triggers a sequential
// browser-native download per file (rather than a server-side ZIP)
// so the worker doesn't have to stream binary data through Vercel's
// 4.5MB response cap. Filenames are zero-padded by segment_index
// so they sort correctly in Finder.
function DownloadAllVoicesButton({ segments }) {
  const avatarVoices = useMemo(
    () => (segments || [])
      .filter((s) => s.segment_type === 'avatar' && s.voice_url)
      .sort((a, b) => a.segment_index - b.segment_index),
    [segments],
  )
  if (avatarVoices.length === 0) return null

  const downloadAll = async () => {
    for (let i = 0; i < avatarVoices.length; i++) {
      const seg = avatarVoices[i]
      const a = document.createElement('a')
      a.href = seg.voice_url
      a.download = `avatar-segment-${String(seg.segment_index + 1).padStart(2, '0')}.mp3`
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Tiny delay so browsers actually queue each download instead
      // of cancelling siblings.
      await new Promise((r) => setTimeout(r, 250))
    }
    toast({ message: `Downloading ${avatarVoices.length} voice file(s)…`, kind: 'info' })
  }

  return (
    <button
      type="button"
      className="btn-secondary"
      onClick={downloadAll}
      style={{ fontSize: 12, padding: '8px 12px' }}
      title={`Download MP3s for all ${avatarVoices.length} avatar segment(s). Use these in your own avatar platform, then upload the rendered videos back via the per-segment Upload button.`}
    >
      ↓ Avatar voices ({avatarVoices.length})
    </button>
  )
}

// Schedule-to-YouTube modal. Loads with Claude-generated title +
// description (summary + chapter timestamps + the profile's
// youtube_description_default boilerplate). User can edit all three
// fields before publishing. Schedule datetime is optional — empty
// = post immediately.
function ScheduleYouTubeModal({ video, session, onClose }) {
  const [busy, setBusy] = useState(false)
  const [loadingMeta, setLoadingMeta] = useState(true)
  const [titles, setTitles] = useState([])           // 3 viral variations from Claude
  const [title, setTitle] = useState('')              // currently-selected (or user-edited) title
  const [description, setDescription] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')  // 'YYYY-MM-DDTHH:MM' local
  const [metaError, setMetaError] = useState(null)
  const [thumbnailUrl, setThumbnailUrl] = useState('')
  const [uploadingThumb, setUploadingThumb] = useState(false)
  // Candidates: 3 AI-generated thumbnails (claude picks prompts → kie
  // renders). Pre-seeded from video.thumbnail_candidates so re-opening
  // the modal doesn't re-spend.
  const [thumbCandidates, setThumbCandidates] = useState(
    Array.isArray(video?.thumbnail_candidates) ? video.thumbnail_candidates : [],
  )
  const [generatingThumbs, setGeneratingThumbs] = useState(false)
  // Lightbox: clicked thumbnail enlarges in a fullscreen overlay so the
  // user can read overlay text + check fine details before picking.
  const [previewUrl, setPreviewUrl] = useState(null)
  // Story graphic state. After publish, user clicks "Create Story
  // Graphic" → POST to create-story-graphic → URL of the rendered
  // 1080x1920 PNG appears + can be downloaded/copied.
  const [storyGraphicUrl, setStoryGraphicUrl] = useState(null)
  const [generatingStory, setGeneratingStory] = useState(false)
  // Edit-mode state. Tracks which thumbnail URL is being edited and
  // what prompt the user is typing. Submit posts to edit-thumbnail
  // and appends the result to thumbCandidates.
  const [editingThumbUrl, setEditingThumbUrl] = useState(null)
  const [editPrompt, setEditPrompt] = useState('')
  const [editingBusy, setEditingBusy] = useState(false)
  // After publish, store the upload-post response so we can substitute
  // any returned YouTube URL into the email template.
  const [publishResult, setPublishResult] = useState(null)
  // Profile boilerplate (loaded once) — we already fetched it server-
  // side when generating the description, but the email template is a
  // separate field we need to pull for the Copy HTML button.
  const [emailTemplate, setEmailTemplate] = useState('')

  // Load auto-generated metadata once on mount.
  useEffect(() => {
    if (!session?.access_token || !video?.id) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await authedFetch('/api/studio/youtube/generate-metadata', session.access_token, {
          method: 'POST', body: JSON.stringify({ studio_video_id: video.id }),
        })
        const b = await r.json().catch(() => ({}))
        if (cancelled) return
        if (!r.ok) {
          setMetaError(b.error || 'Could not generate description.')
          // Still pre-fill title from the video map title if Claude failed
          setTitle((video.title || '').slice(0, 100))
          setTitles([])
          setDescription('')
          return
        }
        const opts = Array.isArray(b.titles) ? b.titles : (b.title ? [b.title] : [])
        setTitles(opts)
        setTitle(opts[0] || (video.title || '').slice(0, 100))
        setDescription(b.full_description || '')
        // Also fetch the email template — separate call so a slow
        // template lookup doesn't block metadata generation.
        try {
          const pr = await authedFetch(`/api/profiles?id=${video.profile_id}`, session.access_token)
          const pj = await pr.json().catch(() => ({}))
          const tpl = pj?.profile?.youtube_email_template_html || pj?.youtube_email_template_html || ''
          setEmailTemplate(tpl)
        } catch { /* non-critical */ }
      } catch (e) {
        if (!cancelled) setMetaError(e.message)
      } finally {
        if (!cancelled) setLoadingMeta(false)
      }
    })()
    return () => { cancelled = true }
  }, [session?.access_token, video?.id])

  const publish = async () => {
    if (!session?.access_token) return
    setBusy(true)
    try {
      const body = {
        profile_id: video.profile_id,
        platforms: ['youtube'],
        video_url: video.final_video_url,
        title: title.slice(0, 100),
        description: description.slice(0, 5000),
      }
      // Local datetime → UTC ISO. Empty = post now.
      if (scheduledAt) {
        try {
          body.scheduled_iso = new Date(scheduledAt).toISOString()
        } catch { /* ignore — server will post immediately */ }
      }
      // Custom YouTube thumbnail (optional). When set, upload-post.com
      // fetches the bytes server-side and pins it as the video's
      // thumbnail. Empty → YouTube auto-picks a frame.
      if (thumbnailUrl) body.youtube_thumbnail_url = thumbnailUrl
      const r = await authedFetch('/api/social/upload-post', session.access_token, {
        method: 'POST', body: JSON.stringify(body),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) {
        toast({ message: b.error || `Publish failed (${r.status})`, kind: 'error' })
        return
      }
      // Stash the response so the Copy HTML button (rendered below
      // when publishResult is set) can substitute any YouTube URL the
      // upload-post returned. For scheduled posts the URL usually
      // isn't available until publish time — Copy HTML falls back to
      // leaving the {{youtube_url}} placeholder in the template.
      setPublishResult(b || {})
      toast({
        message: scheduledAt
          ? `Scheduled to YouTube for ${new Date(scheduledAt).toLocaleString()}.`
          : 'Publishing to YouTube now.',
        kind: 'success',
      })
      // Don't auto-close — let the user copy the HTML first.
    } catch (e) {
      toast({ message: e.message, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          maxWidth: 640, width: '100%', maxHeight: '90vh', overflowY: 'auto',
          padding: 24, background: 'var(--surface)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>📤 Schedule to YouTube</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, color: 'var(--muted)', cursor: 'pointer' }}>×</button>
        </div>

        {loadingMeta ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)' }}>
            Generating title + description with Claude…
          </div>
        ) : (
          <>
            {metaError && (
              <div className="card-flat" style={{ padding: 8, marginBottom: 12, fontSize: 12, color: 'var(--red)' }}>
                Auto-generation failed: {metaError}. You can still type a title + description manually and publish.
              </div>
            )}

            <Field label={<span>Title <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 6 }}>{title.length}/100 — pick a viral hook or edit your own</span></span>}>
              {titles.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                  {titles.map((t, i) => {
                    const isSelected = t === title
                    return (
                      <button
                        key={`${i}-${t}`}
                        type="button"
                        onClick={() => setTitle(t)}
                        style={{
                          textAlign: 'left', cursor: 'pointer',
                          padding: '8px 12px', borderRadius: 6, fontSize: 13,
                          background: isSelected ? 'rgba(239,68,68,0.15)' : 'var(--surface-2)',
                          border: `1px solid ${isSelected ? 'var(--red)' : 'var(--border)'}`,
                          color: 'var(--text)', fontWeight: isSelected ? 600 : 400,
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                        }}
                      >
                        <span style={{ flex: 1 }}>{t}</span>
                        <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>{t.length} ch</span>
                      </button>
                    )
                  })}
                </div>
              )}
              <input
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={100}
                placeholder="Or type your own title here"
                style={{ width: '100%' }}
              />
            </Field>

            <Field label={<span>Description <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 6 }}>{description.length}/5000 — summary + chapters + your boilerplate</span></span>}>
              <textarea
                className="textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={5000}
                style={{ width: '100%', minHeight: 280, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 }}
              />
            </Field>

            <Field label={
              <span>
                Auto-generate thumbnails
                <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 6 }}>Claude + Kie: 3 variations using your reference thumbnails + brand colors</span>
              </span>
            }>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {thumbCandidates.length > 0 ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                    {thumbCandidates.map((c, i) => {
                      const isSelected = c.url === thumbnailUrl
                      const isEditing = c.url === editingThumbUrl
                      return (
                        <div
                          key={`${i}-${c.url}`}
                          style={{
                            position: 'relative',
                            border: `2px solid ${isSelected ? 'var(--red)' : 'transparent'}`,
                            borderRadius: 8,
                            overflow: 'hidden',
                            background: 'var(--surface-2)',
                          }}
                        >
                          <img
                            src={c.url}
                            alt={`option ${i + 1}`}
                            onClick={() => setPreviewUrl(c.url)}
                            style={{
                              width: '100%', aspectRatio: '16 / 9', objectFit: 'cover',
                              display: 'block', cursor: 'zoom-in',
                            }}
                            title="Click to preview full size"
                          />
                          <div style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            gap: 4, padding: '4px 6px',
                          }}>
                            <span style={{
                              fontSize: 10, fontWeight: 700, color: 'var(--muted)',
                              flex: 1, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap',
                            }}>
                              {c.style || `Option ${i + 1}`}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setEditingThumbUrl(isEditing ? null : c.url); setEditPrompt('') }}
                              title="Edit this thumbnail with a follow-up prompt"
                              style={{
                                fontSize: 10, fontWeight: 600,
                                padding: '3px 6px', borderRadius: 4,
                                background: isEditing ? 'rgba(168,85,247,0.2)' : 'transparent',
                                color: 'var(--muted)',
                                border: '1px solid var(--border)', cursor: 'pointer',
                              }}
                            >
                              ✏ Edit
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setThumbnailUrl(c.url) }}
                              style={{
                                fontSize: 10, fontWeight: 700,
                                padding: '3px 8px', borderRadius: 4,
                                background: isSelected ? 'var(--red)' : 'rgba(255,255,255,0.9)',
                                color: isSelected ? '#fff' : '#000',
                                border: 'none', cursor: 'pointer',
                                whiteSpace: 'nowrap', flexShrink: 0,
                              }}
                            >
                              {isSelected ? '✓' : 'Use'}
                            </button>
                          </div>
                          {isEditing && (
                            <div style={{ padding: '4px 6px 6px 6px', borderTop: '1px solid var(--border)' }}>
                              <textarea
                                className="textarea"
                                placeholder="e.g. 'change the background to deep blue', 'make the text larger', 'remove the laptop'"
                                value={editPrompt}
                                onChange={(e) => setEditPrompt(e.target.value)}
                                style={{ width: '100%', minHeight: 50, fontSize: 11, marginBottom: 4 }}
                              />
                              <button
                                type="button"
                                disabled={editingBusy || !editPrompt.trim()}
                                onClick={async (e) => {
                                  e.stopPropagation()
                                  if (!editPrompt.trim() || !session?.access_token) return
                                  setEditingBusy(true)
                                  try {
                                    const r = await authedFetch('/api/studio/youtube/edit-thumbnail', session.access_token, {
                                      method: 'POST',
                                      body: JSON.stringify({
                                        studio_video_id: video.id,
                                        source_url: c.url,
                                        edit_prompt: editPrompt.trim(),
                                      }),
                                    })
                                    const b = await r.json().catch(() => ({}))
                                    if (!r.ok) {
                                      toast({ message: b.error || `Edit failed (${r.status})`, kind: 'error' })
                                      return
                                    }
                                    if (b.candidate) {
                                      setThumbCandidates((prev) => [...prev, b.candidate])
                                      setThumbnailUrl(b.candidate.url)
                                      setEditingThumbUrl(null)
                                      setEditPrompt('')
                                      toast({ message: 'New edited thumbnail added below.', kind: 'success' })
                                    }
                                  } catch (err) {
                                    toast({ message: err.message, kind: 'error' })
                                  } finally {
                                    setEditingBusy(false)
                                  }
                                }}
                                style={{
                                  fontSize: 10, fontWeight: 700,
                                  padding: '4px 8px', borderRadius: 4,
                                  background: '#a855f7', color: '#fff',
                                  border: 'none',
                                  cursor: editingBusy ? 'wait' : 'pointer',
                                  width: '100%',
                                }}
                              >
                                {editingBusy ? '⏳ Editing…' : '🎨 Generate edit'}
                              </button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    No thumbnails generated yet. Click below to have Claude write 3 prompts based on your brand's reference thumbnails + this video's topic, then Kie will render them. ~$0.08 in API spend.
                  </div>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    if (!session?.access_token) return
                    setGeneratingThumbs(true)
                    try {
                      const r = await authedFetch('/api/studio/youtube/generate-thumbnails', session.access_token, {
                        method: 'POST', body: JSON.stringify({ studio_video_id: video.id }),
                      })
                      const b = await r.json().catch(() => ({}))
                      if (!r.ok) {
                        toast({ message: b.error || `Generation failed (${r.status})`, kind: 'error' })
                        return
                      }
                      const next = Array.isArray(b.candidates) ? b.candidates : []
                      setThumbCandidates(next)
                      if (next[0]) setThumbnailUrl(next[0].url)
                      if (b.errors?.length) {
                        toast({ message: `${b.errors.length} of 3 failed: ${b.errors[0]?.error?.slice(0, 100)}`, kind: 'warn' })
                      } else {
                        toast({ message: 'Generated 3 thumbnails — pick one or click Generate again.', kind: 'success' })
                      }
                    } catch (e) {
                      toast({ message: e.message, kind: 'error' })
                    } finally {
                      setGeneratingThumbs(false)
                    }
                  }}
                  disabled={generatingThumbs}
                  style={{
                    alignSelf: 'flex-start',
                    fontSize: 12, padding: '6px 12px',
                    background: '#a855f7', color: '#fff',
                    border: 'none', borderRadius: 6, fontWeight: 600,
                    cursor: generatingThumbs ? 'wait' : 'pointer',
                  }}
                >
                  {generatingThumbs
                    ? '⏳ Generating (30-90s)…'
                    : thumbCandidates.length > 0
                      ? '🔁 Regenerate 3 thumbnails'
                      : '✨ Generate 3 thumbnails'}
                </button>
              </div>
            </Field>

            <Field label={<span>Or upload your own thumbnail <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 6 }}>Optional, JPG/PNG/WebP, ≤2MB, 1280×720</span></span>}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                {thumbnailUrl ? (
                  <img
                    src={thumbnailUrl}
                    alt="thumbnail"
                    style={{ width: 160, height: 90, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)' }}
                  />
                ) : (
                  <div style={{
                    width: 160, height: 90, borderRadius: 4, border: '1px dashed var(--border)',
                    background: 'var(--surface-2)', display: 'grid', placeItems: 'center',
                    fontSize: 10, color: 'var(--muted)',
                  }}>
                    No thumbnail
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label
                    style={{
                      display: 'inline-block', padding: '6px 12px', fontSize: 12, fontWeight: 600,
                      background: uploadingThumb ? 'var(--surface-2)' : 'var(--surface)',
                      border: '1px solid var(--border)', borderRadius: 6,
                      cursor: uploadingThumb ? 'wait' : 'pointer',
                    }}
                  >
                    {uploadingThumb ? 'Uploading…' : (thumbnailUrl ? 'Replace' : 'Upload thumbnail')}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      style={{ display: 'none' }}
                      disabled={uploadingThumb}
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        if (file.size > 2 * 1024 * 1024) {
                          toast({ message: `Thumbnail too big (${(file.size / 1024 / 1024).toFixed(2)}MB) — YouTube limit is 2MB.`, kind: 'error' })
                          e.target.value = ''
                          return
                        }
                        setUploadingThumb(true)
                        try {
                          const fd = new FormData()
                          fd.append('file', file)
                          fd.append('studio_video_id', video.id)
                          const r = await fetch('/api/studio/youtube/upload-thumbnail', {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${session.access_token}` },
                            body: fd,
                          })
                          const b = await r.json().catch(() => ({}))
                          if (!r.ok) {
                            toast({ message: b.error || `Upload failed (${r.status})`, kind: 'error' })
                            return
                          }
                          setThumbnailUrl(b.url || '')
                        } catch (err) {
                          toast({ message: err.message, kind: 'error' })
                        } finally {
                          setUploadingThumb(false)
                          e.target.value = ''
                        }
                      }}
                    />
                  </label>
                  {thumbnailUrl && (
                    <button
                      type="button"
                      onClick={() => setThumbnailUrl('')}
                      style={{ fontSize: 11, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                If empty, YouTube auto-picks a frame from the video.
              </div>
            </Field>

            <Field label={<span>Schedule for <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 6 }}>Leave empty to publish now</span></span>}>
              <input
                type="datetime-local"
                className="input"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                style={{ width: '100%' }}
              />
            </Field>

            {publishResult && emailTemplate && (() => {
              // Copy HTML button — substitutes four placeholders in the
              // user's template:
              //   {{youtube_url}}   → URL from upload-post response (or
              //                        intact if scheduled post w/o URL)
              //   {{title}}         → currently-selected/edited title
              //   {{summary}}       → first paragraph of the description
              //                        (the auto-generated overview,
              //                        before "Chapters:")
              //   {{description}}   → full description (summary +
              //                        chapters + brand boilerplate)
              const youtubeUrlFromResponse =
                publishResult.youtube_url
                || publishResult.video_url
                || publishResult?.results?.youtube?.url
                || publishResult?.results?.youtube?.video_url
                || ''
              // Extract the summary (first paragraph). Description was
              // assembled by generate-metadata as:
              //   <summary>\n\n<chapters>\n\n<boilerplate>
              // — splitting on the first blank line gives us the
              // creator-friendly TL;DR.
              const summary = (description.split(/\n\s*\n/)[0] || '').trim()
              const finalHtml = emailTemplate
                .replace(/\{\{\s*youtube_url\s*\}\}/g, youtubeUrlFromResponse || '{{youtube_url}}')
                .replace(/\{\{\s*title\s*\}\}/g, title || '')
                .replace(/\{\{\s*summary\s*\}\}/g, summary)
                .replace(/\{\{\s*description\s*\}\}/g, description || '')
                // {{thumbnail_url}} — substituted with the thumbnail the
                // user picked in the modal. Falls back to YouTube's auto-
                // generated thumbnail URL if we have the video ID we can
                // derive (works for any youtube_url that includes a /vid
                // path or watch?v= query). Lets the email card show the
                // exact thumbnail YouTube will display.
                .replace(/\{\{\s*thumbnail_url\s*\}\}/g, thumbnailUrl || '{{thumbnail_url}}')
              return (
                <div style={{
                  marginTop: 14, padding: 12, borderRadius: 6,
                  background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.4)',
                }}>
                  <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 8 }}>
                    {scheduledAt
                      ? `📅 Scheduled for ${new Date(scheduledAt).toLocaleString()}. Email HTML has the title, summary, and description filled in — paste the live YouTube URL in place of {{youtube_url}} once the video goes up.`
                      : '🚀 Publishing now. Email HTML has the title, summary, description, and live URL all filled in.'}
                    {youtubeUrlFromResponse && (
                      <span style={{ display: 'block', marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
                        Live URL detected: <code>{youtubeUrlFromResponse}</code>
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 8 }}>
                    Placeholders substituted: <code>{`{{title}}`}</code> · <code>{`{{summary}}`}</code> · <code>{`{{description}}`}</code> · <code>{`{{youtube_url}}`}</code>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(finalHtml)
                        toast({ message: 'Email HTML copied to clipboard.', kind: 'success' })
                      } catch {
                        toast({ message: 'Clipboard write failed. Paste manually below.', kind: 'warn' })
                      }
                    }}
                    style={{
                      fontSize: 12, fontWeight: 700,
                      padding: '6px 12px', borderRadius: 6,
                      background: '#22c55e', color: '#fff',
                      border: 'none', cursor: 'pointer',
                    }}
                  >
                    📋 Copy HTML
                  </button>
                </div>
              )
            })()}

            {publishResult && (
              <div style={{
                marginTop: 10, padding: 12, borderRadius: 6,
                background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.4)',
              }}>
                <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 8 }}>
                  📸 Generate a 9:16 story graphic for Instagram + TikTok stories — uses your title, summary, and selected thumbnail. Perfect for "new video is up" announcements.
                </div>
                {storyGraphicUrl && (
                  <div style={{ marginBottom: 8 }}>
                    <img
                      src={storyGraphicUrl}
                      alt="story graphic"
                      onClick={() => setPreviewUrl(storyGraphicUrl)}
                      style={{ height: 200, borderRadius: 6, border: '1px solid var(--border)', cursor: 'zoom-in' }}
                    />
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!session?.access_token) return
                      setGeneratingStory(true)
                      try {
                        const r = await authedFetch('/api/studio/youtube/create-story-graphic', session.access_token, {
                          method: 'POST',
                          body: JSON.stringify({
                            studio_video_id: video.id,
                            title,
                            summary: (description.split(/\n\s*\n/)[0] || '').trim(),
                            thumbnail_url: thumbnailUrl,
                          }),
                        })
                        const b = await r.json().catch(() => ({}))
                        if (!r.ok) {
                          toast({ message: b.error || `Story graphic failed (${r.status})`, kind: 'error' })
                          return
                        }
                        setStoryGraphicUrl(b.url || null)
                        toast({ message: 'Story graphic generated. Click to preview, or download.', kind: 'success' })
                      } catch (e) {
                        toast({ message: e.message, kind: 'error' })
                      } finally {
                        setGeneratingStory(false)
                      }
                    }}
                    disabled={generatingStory}
                    style={{
                      fontSize: 12, fontWeight: 700,
                      padding: '6px 12px', borderRadius: 6,
                      background: '#a855f7', color: '#fff',
                      border: 'none',
                      cursor: generatingStory ? 'wait' : 'pointer',
                    }}
                  >
                    {generatingStory
                      ? '⏳ Generating…'
                      : storyGraphicUrl ? '🔁 Regenerate' : '📸 Create Story Graphic'}
                  </button>
                  {storyGraphicUrl && (
                    <a
                      href={storyGraphicUrl}
                      download={`story-${video.id}.png`}
                      style={{
                        fontSize: 12, fontWeight: 700,
                        padding: '6px 12px', borderRadius: 6,
                        background: 'var(--surface)', color: 'var(--text)',
                        border: '1px solid var(--border)',
                        textDecoration: 'none',
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                      }}
                    >
                      ⬇ Download PNG
                    </a>
                  )}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                type="button"
                className="btn"
                onClick={onClose}
                disabled={busy}
                style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', padding: '8px 16px', borderRadius: 6, cursor: 'pointer' }}
              >
                {publishResult ? 'Close' : 'Cancel'}
              </button>
              {!publishResult && (
                <button
                  type="button"
                  className="btn"
                  onClick={publish}
                  disabled={busy || !title.trim() || !description.trim()}
                  style={{ background: '#ef4444', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, fontWeight: 700, cursor: busy ? 'wait' : 'pointer' }}
                >
                  {busy ? 'Publishing…' : (scheduledAt ? '📅 Schedule' : '🚀 Publish now')}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* Full-size thumbnail preview lightbox. Click outside (or Esc)
          to close. Stops modal click-outside from also firing. */}
      {previewUrl && (
        <div
          onClick={(e) => { e.stopPropagation(); setPreviewUrl(null) }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 1100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40,
            cursor: 'zoom-out',
          }}
        >
          <img
            src={previewUrl}
            alt="thumbnail full size"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '90vw', maxHeight: '85vh', objectFit: 'contain', borderRadius: 8, boxShadow: '0 8px 40px rgba(0,0,0,0.6)' }}
          />
          <button
            onClick={(e) => { e.stopPropagation(); setPreviewUrl(null) }}
            style={{
              position: 'fixed', top: 24, right: 24,
              background: 'rgba(255,255,255,0.15)', color: '#fff',
              border: 'none', borderRadius: '50%', width: 40, height: 40,
              fontSize: 22, cursor: 'pointer', display: 'grid', placeItems: 'center',
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}

function StickyActionBar({ video, approvedCount, totalCount, segments, manualMode = false }) {
  const { session } = useAuth()
  const [busy, setBusy] = useState(false)
  const [showRegenOptions, setShowRegenOptions] = useState(false)
  // Re-render confirm modal. Opens when the user hits "Re-render" on a
  // done video so they can adjust music settings (and/or step back into
  // the editor to tweak segments) BEFORE the bake fires. Was previously
  // a direct call to onRender() — every re-bake reused whatever music
  // was set at video-creation time, with no way to change it.
  const [showRerenderModal, setShowRerenderModal] = useState(false)
  // Two-checkbox flow for the initial Generate Assets step. Default:
  // voice + B-roll on, avatar off. Avatar is opt-in because it's the
  // most expensive provider call (HeyGen) and lots of users want to
  // export the voice tracks and render avatars elsewhere first.
  const [genElse, setGenElse] = useState(true)
  const [genAvatar, setGenAvatar] = useState(false)
  // can_render arrives from CostEstimate down below. We disable the
  // primary button when it's false. Default true so the button isn't
  // greyed out before the estimate loads.
  const [canRender, setCanRender] = useState(true)
  // Local "we just clicked render-final" flag. Set on click, cleared
  // when Realtime delivers final_video_url. Decoupled from video.status
  // because that's also 'rendering' during asset gen.
  const [baking, setBaking] = useState(false)
  useEffect(() => {
    if (video.status === 'rendered' || video.final_video_url) setBaking(false)
    if (video.status === 'failed') setBaking(false)
  }, [video.status, video.final_video_url])

  const isRendered = video.status === 'rendered'
  const isFailed = video.status === 'failed'

  // Segment-level signals — far more reliable than parent video.status
  // for telling us where we actually are in the pipeline.
  const approvedSegs = segments.filter((s) => s.approved)
  const anyGenerating = approvedSegs.some((s) =>
    s.status === 'generating_image' || s.status === 'generating_audio' || s.status === 'generating_avatar'
  )
  const allAssetsReady = approvedSegs.length > 0 && approvedSegs.every((s) => s.status === 'ready')

  // For rendered videos: check whether their segments still have the
  // assets that built them. If the segments were wiped (e.g. user hit
  // Regenerate map after a successful render), Re-render would fail
  // because there's nothing to stitch. In that case, the button needs
  // to drive asset regen first, not the bake.
  const renderedButAssetsGone = isRendered && approvedSegs.length > 0 && !allAssetsReady

  // Server-side baking signal. The local `baking` flag only flips when
  // THIS browser tab fires render-final, so it drops to false on a page
  // reload mid-bake. video.status='rendering' + render_progress.stage in
  // {baking,concat,upload} means the server is actively working —
  // honor that regardless of local state so the progress bar stays up
  // across reloads / multiple tabs.
  const serverBaking = video.status === 'rendering'
    && video.render_progress?.stage
    && video.render_progress.stage !== 'done'

  // Phase priority: terminal states → bake-in-progress → asset-gen → ready
  // states. Critically, allAssetsReady takes precedence over the parent
  // status='rendering' since the parent doesn't get reset after asset gen.
  const phase = isRendered && allAssetsReady
    ? 'done'
    : renderedButAssetsGone
      ? 'rendered-needs-assets'
      : isFailed
        ? 'failed'
        : (baking || serverBaking)
          ? 'baking'
          : anyGenerating
            ? 'rendering'
            : allAssetsReady
              ? 'ready-to-bake'
              : approvedCount > 0 && ['mapped', 'editing', 'rendering', 'rendered'].includes(video.status)
                ? 'ready-for-assets'
                : 'pre-approval'

  const onAssets = async (only_types = null) => {
    if (!session?.access_token) return
    setBusy(true)
    try {
      const body = { studio_video_id: video.id }
      if (Array.isArray(only_types) && only_types.length) body.only_types = only_types
      const r = await authedFetch('/api/studio/generate-assets', session.access_token, {
        method: 'POST', body: JSON.stringify(body),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error(b.error || 'Could not start asset generation')
      }
      const label = !only_types ? 'Asset generation started.'
        : `${only_types.join(' + ')} regen started.`
      toast({ message: label, kind: 'success' })
    } catch (e) {
      toast({ message: e.message, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const onRender = async () => {
    if (!session?.access_token) return
    setBusy(true)
    setBaking(true)  // local flag drives phase='baking' until final_video_url lands
    try {
      // Auto-fit motion graphics when toggle is on. Re-picks composition
      // + variables per motion segment to match the actual script. Runs
      // FIRST so overlay enrichment downstream sees the updated comp ids.
      if (video.motion_graphics_enabled !== false) {
        toast({ message: 'Refreshing motion graphics…', kind: 'info' })
        const mr = await authedFetch('/api/studio/refresh-motion-graphics', session.access_token, {
          method: 'POST',
          body: JSON.stringify({ studio_video_id: video.id }),
        })
        const mtxt = await mr.text()
        let mbody = null
        try { mbody = JSON.parse(mtxt) } catch { /* not JSON */ }
        if (!mr.ok) {
          const reason = mbody?.error || `refresh returned ${mr.status}`
          toast({ message: `Motion-graphics refresh failed (${reason.slice(0, 80)}). Rendering with existing compositions.`, kind: 'warning' })
        }
      }

      // Auto-enrich overlays when toggle is on. Idempotent — Claude re-
      // emits placements every time so this keeps overlays in sync
      // with the latest script. ~5-15s before the actual render fires.
      if (video.overlays_enabled !== false) {
        toast({ message: 'Adding overlays + captions…', kind: 'info' })
        const er = await authedFetch('/api/studio/enrich-overlays', session.access_token, {
          method: 'POST',
          body: JSON.stringify({ studio_video_id: video.id }),
        })
        const etxt = await er.text()
        let ebody = null
        try { ebody = JSON.parse(etxt) } catch { /* not JSON */ }
        if (!er.ok) {
          // Soft-fail: surface the enrichment error but proceed with
          // the render anyway. Users can flip the toggle off and
          // re-render if they don't want overlays.
          const reason = ebody?.error || `enrich-overlays returned ${er.status}`
          toast({ message: `Overlay enrichment failed (${reason.slice(0, 80)}). Rendering without overlay updates.`, kind: 'warning' })
        }
      }

      const r = await authedFetch('/api/studio/render-final', session.access_token, {
        method: 'POST',
        body: JSON.stringify({ studio_video_id: video.id }),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b.error || 'Render failed')
      toast({ message: 'Final video rendered.', kind: 'success' })
    } catch (e) {
      setBaking(false)
      toast({ message: e.message, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  // Compute which asset classes to generate from the two checkboxes
  // shown in the ready-for-assets phase. Returns null when both are
  // checked (= generate everything, no filter) or an array filter
  // otherwise. Returns false when neither box is checked, which the
  // dispatcher uses to block the click. When manualMode is OFF the
  // checkboxes are hidden entirely — always generate everything.
  const onlyTypesFromCheckboxes = () => {
    if (!manualMode) return null
    if (!genElse && !genAvatar) return false
    if (genElse && genAvatar) return null
    if (genAvatar) return ['avatar']
    return ['voice', 'image']  // "everything else" = voice + B-roll image
  }

  // Continue dispatcher: pick the right action based on the current phase.
  //   ready-to-bake / done → bake (segments already have assets)
  //   ready-for-assets → asset gen filtered by the two checkboxes
  //   rendered-needs-assets → asset gen with same checkbox filter
  //   anything else → asset gen
  const onContinue = () => {
    // Re-render flow: don't fire the bake immediately. Open a confirm
    // modal so the user can adjust background music (and remember they
    // can tweak segments in the editor below) before committing to a
    // full re-bake. ready-to-bake = first-time render, no need for the
    // extra step. done = re-render, definitely needs the extra step.
    if (phase === 'done') {
      setShowRerenderModal(true)
      return
    }
    if (phase === 'ready-to-bake') return onRender()
    const ot = onlyTypesFromCheckboxes()
    if (ot === false) {
      toast({ message: 'Tick at least one option to generate.', kind: 'warning' })
      return
    }
    return onAssets(ot)
  }

  // Per-type cost hints shown next to each regen option. Real costs
  // depend on segment count + provider pricing; these are rough guides
  // so users know what they're committing to before they click.
  const broll = segments.filter((s) => s.approved && s.segment_type === 'voiceover_broll').length
  const avatar = segments.filter((s) => s.approved && s.segment_type === 'avatar').length

  return (
    // No outer position:sticky here — the inner div below handles
    // sticky-to-top placement directly. The old wrapper had
    // bottom:16 from when this bar lived at the bottom of the page.
    <div style={{ marginBottom: 16 }}>
    {showRegenOptions && (
      <RegenOptionsPanel
        broll={broll}
        avatar={avatar}
        busy={busy}
        onPick={async (types) => {
          await onAssets(types)
          setShowRegenOptions(false)
        }}
        onClose={() => setShowRegenOptions(false)}
      />
    )}
    {showRerenderModal && (
      <RerenderConfirmModal
        video={video}
        token={session?.access_token}
        busy={busy}
        onCancel={() => setShowRerenderModal(false)}
        onConfirm={async (musicPatch) => {
          // Persist music tweaks (if any) to the row BEFORE firing the
          // bake — the worker reads music_mode / track / volume off the
          // studio_videos row, not from the request body.
          if (musicPatch && session?.access_token) {
            try {
              await authedFetch(`/api/studio/videos?id=${encodeURIComponent(video.id)}`, session.access_token, {
                method: 'PATCH', body: JSON.stringify(musicPatch),
              })
            } catch (e) {
              toast({ message: `Couldn't save music change: ${e.message}. Re-rendering with previous settings.`, kind: 'warning' })
            }
          }
          setShowRerenderModal(false)
          await onRender()
        }}
      />
    )}
    <div style={{
      // Pinned just under the global ScaleSolo header. position:sticky
      // keeps the bar in the normal flow but glued to the top of the
      // viewport once you scroll past it. top:56 leaves room for the
      // app header (adjust if the global header height changes).
      position: 'sticky',
      top: 56,
      zIndex: 40,
      padding: '12px 16px',
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      // Backdrop blur so content sliding behind it stays legible.
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
    }}>
      <div style={{ flex: 1, fontSize: 12.5, color: 'var(--text-soft)' }}>
        {phase === 'done' && video.final_video_url ? (
          <>
            <CheckCircle2 size={12} style={{ verticalAlign: 'middle', marginRight: 6, color: '#2ecc71' }} />
            <strong style={{ color: 'var(--text)' }}>Render complete.</strong>
            <a
              href={video.final_video_url} target="_blank" rel="noopener noreferrer"
              style={{ marginLeft: 10, color: 'var(--red)', fontWeight: 700 }}
            >Watch ↗</a>
          </>
        ) : phase === 'baking' ? (
          <RenderProgressBar video={video} />
        ) : phase === 'rendering' ? (
          <>
            <Loader2 size={12} className="spin" style={{ verticalAlign: 'middle', marginRight: 6, color: '#fbbf24' }} />
            <strong style={{ color: 'var(--text)' }}>Generating assets…</strong>
            <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
              Voice, B-roll, and avatar segments are filling in below.
            </span>
          </>
        ) : phase === 'ready-to-bake' ? (
          <>
            <CheckCircle2 size={12} style={{ verticalAlign: 'middle', marginRight: 6, color: '#2ecc71' }} />
            <strong style={{ color: 'var(--text)' }}>All assets ready.</strong>
            <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
              Hit Render to stitch them into the final MP4.
            </span>
          </>
        ) : phase === 'rendered-needs-assets' ? (
          <>
            <AlertCircle size={12} style={{ verticalAlign: 'middle', marginRight: 6, color: '#fbbf24' }} />
            <strong style={{ color: 'var(--text)' }}>Your render is saved, but the editable assets are missing.</strong>
            <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
              The final MP4 still plays above. To re-render with edits, regenerate the segment assets first.
              {video.final_video_url && (
                <a href={video.final_video_url} target="_blank" rel="noopener noreferrer"
                  style={{ marginLeft: 8, color: 'var(--red)', fontWeight: 700 }}>Watch the existing render ↗</a>
              )}
            </span>
          </>
        ) : isFailed ? (
          <>
            <AlertCircle size={12} style={{ verticalAlign: 'middle', marginRight: 6, color: 'var(--red)' }} />
            <strong style={{ color: 'var(--red)' }}>Failed:</strong>
            <span style={{ color: 'var(--muted)', marginLeft: 8 }}>{video.error || 'Unknown error'}</span>
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
      {/* Two-checkbox asset-gen control — power-user only. Lets the
          user opt out of HeyGen so they can export the voice tracks
          and render avatars on their own platform, then upload via
          the per-segment Upload button. Hidden when manual mode is
          off (default for normal users) — those users get a single
          Generate Assets button that does the whole pipeline. */}
      {manualMode && (phase === 'ready-for-assets' || phase === 'rendered-needs-assets') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--text-soft)' }}>
            <input
              type="checkbox"
              checked={genElse}
              onChange={(e) => setGenElse(e.target.checked)}
              disabled={busy}
            />
            <span>Voice + B-roll</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--text-soft)' }}
            title="Off by default — export audio first and render avatars on your own platform to save credits.">
            <input
              type="checkbox"
              checked={genAvatar}
              onChange={(e) => setGenAvatar(e.target.checked)}
              disabled={busy}
            />
            <span>Avatar videos</span>
          </label>
        </div>
      )}
      {manualMode && <DownloadAllVoicesButton segments={segments} />}
      <button
        type="button"
        className="btn-primary"
        disabled={busy || phase === 'rendering' || phase === 'baking' || phase === 'pre-approval' || !canRender}
        onClick={onContinue}
        style={{ fontSize: 13, padding: '10px 18px' }}
        title={!canRender
          ? 'Not enough credits to continue. Top up or shorten the video.'
          : undefined}
      >
        {busy || phase === 'rendering' || phase === 'baking' ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
        {phase === 'rendering'
          ? 'Generating…'
          : phase === 'baking'
            ? 'Rendering…'
            : phase === 'ready-to-bake'
              ? 'Render final MP4'
              : phase === 'done'
                ? 'Re-render'
                : phase === 'rendered-needs-assets'
                  ? 'Regen all missing'
                  : 'Generate assets'}
      </button>
    </div>
    {/* Cost estimate moved into the new-video modal (shown once at
        creation time). Removing the duplicate strip from the editor
        per product feedback — keeps the action bar a single tight
        row. canRender stays true since we no longer block here. */}
    </div>
  )
}

// Re-render confirm modal. Surfaces between a click on the "Re-render"
// action button and the actual bake call so the user can:
//
//   1. Adjust background music (mode / track / volume) — was previously
//      locked at video-creation time with no way to change.
//   2. Be reminded that segments below are still editable and they can
//      Cancel out to make changes before kicking off the bake.
//
// Returns a diff-only PATCH body via onConfirm (or null if music is
// unchanged) so the caller can decide whether to fire a save before
// invoking the render.
function RerenderConfirmModal({ video, token, busy, onCancel, onConfirm }) {
  // Seed from the saved row so the modal opens with the user's last
  // choice — no surprise resets between re-renders.
  const [musicMode, setMusicMode] = useState(video.music_mode || 'off')
  const [musicTrackId, setMusicTrackId] = useState(video.music_track_id || '')
  const [musicVolume, setMusicVolume] = useState(
    typeof video.music_volume === 'number' ? video.music_volume : 0.12,
  )
  // Sound design toggle. Mirrors the column on studio_videos; defaults
  // true for any video created before the column existed.
  const [sfxEnabled, setSfxEnabled] = useState(
    video.sfx_enabled === undefined || video.sfx_enabled === null ? true : !!video.sfx_enabled,
  )
  const [tracks, setTracks] = useState([])
  // Current brand colors on the BRAND PROFILE. studio_videos snapshots
  // brand_color + brand_color_secondary at create time, so if the user
  // updated their brand colors AFTER the video was created (or rendered
  // with template defaults) the video keeps the stale color until
  // someone PATCHes it. We surface that mismatch here so re-render
  // can sync in one click.
  const [profileColors, setProfileColors] = useState(null)
  const [syncBrandColors, setSyncBrandColors] = useState(false)
  useEffect(() => {
    if (!token) return
    let cancelled = false
    fetch('/api/account/music-tracks', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((b) => { if (!cancelled) setTracks(Array.isArray(b?.tracks) ? b.tracks : []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token])
  useEffect(() => {
    if (!token || !video?.profile_id) return
    let cancelled = false
    fetch(`/api/profiles?id=${encodeURIComponent(video.profile_id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((b) => {
        if (cancelled) return
        const p = Array.isArray(b?.profiles) ? b.profiles[0] : (b?.profile || b)
        if (!p) return
        setProfileColors({
          primary: p.brand_primary_color || null,
          secondary: p.brand_secondary_color || null,
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token, video?.profile_id])

  const norm = (c) => (c || '').toString().trim().toLowerCase()
  const primaryDrift = profileColors?.primary && norm(profileColors.primary) !== norm(video.brand_color)
  const secondaryDrift = profileColors?.secondary && norm(profileColors.secondary) !== norm(video.brand_color_secondary)
  const brandDrift = !!(primaryDrift || secondaryDrift)
  // Default the sync toggle ON whenever drift is detected so the common
  // case ("I updated my brand colors, now re-render") works without an
  // extra click. The user can untick to keep the snapshotted color.
  useEffect(() => { if (brandDrift) setSyncBrandColors(true) }, [brandDrift])

  // Build a diff-only patch — only send fields the user actually changed
  // so an accidental "Render" doesn't overwrite the row with defaults
  // for fields the modal didn't surface.
  const buildPatch = () => {
    const patch = {}
    if (musicMode !== (video.music_mode || 'off')) patch.music_mode = musicMode
    if ((musicTrackId || '') !== (video.music_track_id || '')) {
      patch.music_track_id = musicTrackId || null
    }
    const prevVol = typeof video.music_volume === 'number' ? video.music_volume : 0.12
    if (Math.abs(musicVolume - prevVol) > 0.005) patch.music_volume = musicVolume
    const prevSfx = video.sfx_enabled === undefined || video.sfx_enabled === null ? true : !!video.sfx_enabled
    if (sfxEnabled !== prevSfx) patch.sfx_enabled = sfxEnabled
    if (syncBrandColors && brandDrift) {
      if (primaryDrift) patch.brand_color = profileColors.primary
      if (secondaryDrift) patch.brand_color_secondary = profileColors.secondary
    }
    return Object.keys(patch).length ? patch : null
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center',
        zIndex: 9000, padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 560,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 14, padding: 22,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 17, margin: 0, color: 'var(--text)' }}>
            Re-render settings
          </h3>
          <button
            type="button"
            onClick={onCancel}
            style={{ background: 'transparent', color: 'var(--text-soft)', border: 'none', fontSize: 18, cursor: 'pointer', padding: 4 }}
            aria-label="Cancel"
          >×</button>
        </div>
        <p style={{ margin: '0 0 18px 0', fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.5 }}>
          Adjust background music for this bake. Need to tweak a segment?
          Hit <strong>Cancel</strong> — every segment below is editable.
          Re-open this dialog from the <strong>Re-render</strong> button when you're done.
        </p>

        {brandDrift && (
          <div style={{
            marginBottom: 16,
            padding: '12px 14px',
            background: 'rgba(245, 158, 11, 0.08)',
            border: '1px solid rgba(245, 158, 11, 0.35)',
            borderRadius: 10,
            fontSize: 12.5,
            color: 'var(--text)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <strong style={{ fontFamily: 'var(--font-display)', color: '#f59e0b' }}>
                Brand colors updated since this video was created
              </strong>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-soft)' }}>This video:</span>
                <span style={{
                  width: 18, height: 18, borderRadius: 4,
                  background: video.brand_color || '#000',
                  border: '1px solid rgba(255,255,255,0.1)',
                }} />
                <code style={{ fontSize: 11 }}>{video.brand_color || '—'}</code>
              </div>
              <span style={{ color: 'var(--text-soft)' }}>→</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-soft)' }}>Profile now:</span>
                <span style={{
                  width: 18, height: 18, borderRadius: 4,
                  background: profileColors?.primary || '#000',
                  border: '1px solid rgba(255,255,255,0.1)',
                }} />
                <code style={{ fontSize: 11 }}>{profileColors?.primary || '—'}</code>
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={syncBrandColors}
                onChange={(e) => setSyncBrandColors(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>Use my current brand colors for this re-render</span>
            </label>
          </div>
        )}
        {/* Sound design — per-bake on/off. When disabled the worker
            skips the SFX mix pass entirely, so no entrance whooshes,
            transition swooshes, button dings, or emphasis cues land on
            the final MP4. Useful when adding a voiceover that competes
            with the SFX layer or when the user just wants a quiet cut. */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 8, letterSpacing: 0.2 }}>
            Sound effects
          </div>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 12px',
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 8, cursor: 'pointer', userSelect: 'none',
          }}>
            <input
              type="checkbox"
              checked={sfxEnabled}
              onChange={(e) => setSfxEnabled(e.target.checked)}
              style={{ width: 16, height: 16, margin: 0, accentColor: 'var(--red)' }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>
                {sfxEnabled ? 'On' : 'Off'} — entrance, transition, and emphasis cues
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 2 }}>
                Turn off when the voiceover or music should carry the bake alone.
              </div>
            </div>
          </label>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 8, letterSpacing: 0.2 }}>
            Background music
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {[
              { v: 'off',        label: 'Off' },
              { v: 'loop_one',   label: 'Loop one song' },
              { v: 'cycle_all',  label: 'Cycle all songs' },
            ].map((r) => (
              <button
                key={r.v}
                type="button"
                onClick={() => setMusicMode(r.v)}
                className={musicMode === r.v ? 'btn-primary' : 'btn-secondary'}
                style={{ flex: 1, padding: '10px 8px', fontSize: 12.5, fontWeight: 700 }}
              >{r.label}</button>
            ))}
          </div>

          {musicMode === 'loop_one' && (
            <div style={{ marginTop: 4 }}>
              {tracks.length === 0 ? (
                <div style={{
                  padding: '8px 10px', fontSize: 12,
                  background: 'var(--surface)', border: '1px dashed var(--border)',
                  borderRadius: 6, color: 'var(--muted)',
                }}>
                  No tracks in your library yet. Add some on the Profiles page → Music tracks.
                </div>
              ) : (
                <select
                  className="input"
                  value={musicTrackId || ''}
                  onChange={(e) => setMusicTrackId(e.target.value)}
                  style={{ width: '100%' }}
                >
                  <option value="">— Pick a track —</option>
                  {tracks.map((t) => (
                    <option key={t.id} value={t.id}>{t.name || t.id}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          {musicMode === 'cycle_all' && (
            <div style={{
              marginTop: 4, padding: '8px 10px', fontSize: 12,
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 6, color: 'var(--text-soft)',
            }}>
              {tracks.length === 0
                ? 'No tracks in your library yet. Add some on the Profiles page → Music tracks.'
                : `Will play in order, looping if the video runs past the playlist: ${tracks.map((t) => t.name).filter(Boolean).slice(0, 4).join(' · ')}${tracks.length > 4 ? ` + ${tracks.length - 4} more` : ''}`}
            </div>
          )}

          {musicMode !== 'off' && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-soft)', marginBottom: 6 }}>Volume</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {[
                  { v: 0.08, label: 'Subtle' },
                  { v: 0.12, label: 'Low (default)' },
                  { v: 0.18, label: 'Prominent' },
                ].map((r) => (
                  <button
                    key={r.v}
                    type="button"
                    onClick={() => setMusicVolume(r.v)}
                    className={Math.abs(musicVolume - r.v) < 0.005 ? 'btn-primary' : 'btn-secondary'}
                    style={{ flex: 1, padding: '6px 8px', fontSize: 11.5, fontWeight: 600 }}
                  >{r.label}</button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={onCancel}
            disabled={busy}
            style={{ padding: '10px 16px', fontSize: 13 }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => onConfirm(buildPatch())}
            disabled={busy}
            style={{ padding: '10px 18px', fontSize: 13 }}
          >
            {busy ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
            Re-render
          </button>
        </div>
      </div>
    </div>
  )
}

// Expandable per-class regen picker. Hangs off the sticky action bar
// when phase suggests asset generation. Three checkboxes (voice / image /
// avatar) with rough cost hints so the user knows what they're spending
// on before they click.
function RegenOptionsPanel({ broll, avatar, busy, onPick, onClose }) {
  const [voice, setVoice] = useState(true)
  const [image, setImage] = useState(false)
  const [avatarChecked, setAvatarChecked] = useState(false)
  const chosen = []
  if (voice) chosen.push('voice')
  if (image) chosen.push('image')
  if (avatarChecked) chosen.push('avatar')

  return (
    <div style={{
      marginBottom: 8,
      padding: '14px 16px',
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <strong style={{ fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text)' }}>
          Choose what to regenerate
        </strong>
        <button type="button" className="btn-ghost" onClick={onClose} style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 8px', color: 'var(--muted)' }}>
          Close
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        <RegenOption
          label="Voice"
          checked={voice}
          onChange={setVoice}
          hint="ElevenLabs. Cheapest. Rerun this when you change script text or want to check alignment."
          cost="≈ free at your volume"
        />
        <RegenOption
          label="B-roll images"
          checked={image}
          onChange={setImage}
          hint={`Nano Banana via Kie.ai. ~$0.04 per image. ${broll} B-roll segment${broll === 1 ? '' : 's'} in this video.`}
          cost={broll ? `≈ $${(broll * 0.04).toFixed(2)} estimated` : 'no B-roll rows'}
          disabled={broll === 0}
        />
        <RegenOption
          label="Avatar videos"
          checked={avatarChecked}
          onChange={setAvatarChecked}
          hint={`HeyGen V3. Most expensive class. ${avatar} avatar segment${avatar === 1 ? '' : 's'} in this video.`}
          cost={avatar ? `${avatar} HeyGen render${avatar === 1 ? '' : 's'}` : 'no avatar rows'}
          disabled={avatar === 0}
        />
      </div>
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, fontSize: 11.5, color: 'var(--muted)' }}>
          {chosen.length === 0
            ? 'Pick at least one class.'
            : chosen.length === 3
              ? 'All three — same as the main "Regen all missing" button.'
              : `Will only regenerate: ${chosen.join(', ')}. Other classes will be left alone.`}
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={busy || chosen.length === 0}
          onClick={() => onPick(chosen)}
          style={{ fontSize: 12.5, padding: '8px 14px' }}
        >
          {busy ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />}
          Regenerate selected
        </button>
      </div>
    </div>
  )
}

function RegenOption({ label, checked, onChange, hint, cost, disabled }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: 10, borderRadius: 8,
      background: checked && !disabled ? 'rgba(239,68,68,0.06)' : 'var(--surface-2)',
      border: `1px solid ${checked && !disabled ? 'rgba(239,68,68,0.45)' : 'var(--border)'}`,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
    }}>
      <input
        type="checkbox"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2, accentColor: 'var(--red)' }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
          <strong style={{ fontFamily: 'var(--font-display)', fontSize: 12.5 }}>{label}</strong>
          <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{cost}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.4, marginTop: 3 }}>
          {hint}
        </div>
      </div>
    </label>
  )
}

// One row of the video map. Cards are dense but legible — Studio is
// desktop-first. Each editable field debounces text-input PATCHes and
// fires select/checkbox PATCHes on change.
function SegmentRow({ segment, onPatch, onDelete, onRegen, onSplit, onUploadAvatar, onUploadScreenshot, aspectRatio, manualMode = false, videoVoiceoverSourceUrl = null }) {
  const isAvatar = segment.segment_type === 'avatar'
  const isBroll = segment.segment_type === 'voiceover_broll'
  const isMotion = segment.segment_type === 'voiceover_motion_graphics' || segment.segment_type === 'pure_motion_graphics'
  const isScreenshot = segment.segment_type === 'screenshot'
  const isPureMotion = segment.segment_type === 'pure_motion_graphics'
  // Voice is "locked" when it was sliced from a user-uploaded
  // voiceover instead of synthesized by ElevenLabs. Regen must NOT
  // re-synth in that case — it would replace the user's real recorded
  // voice with TTS. Signal: per-segment voice_source_start_secs OR
  // the parent video having voiceover_source_url set.
  const isVoiceLocked = segment.voice_source_start_secs != null
    || segment.voice_source_end_secs != null
    || !!videoVoiceoverSourceUrl
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

        {/* Rendered chunk preview — set by the worker as soon as each
            segment finishes baking. Aspect-aware so 9:16 vertical bakes
            don't squish into a 16:9 box. Any segment edit invalidates
            this URL on the server side, so a stale preview can't outlive
            the change that broke it. */}
        <ChunkPreview
          url={segment.rendered_chunk_url}
          aspectRatio={aspectRatio}
        />

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

            {isMotion && (() => {
              // Build the option list, folding in the segment's current
              // composition ID if it's outside the canonical pool — keeps
              // the select label honest instead of silently falling back
              // to "No template" when the value doesn't match an option.
              const current = segment.hyperframes_composition_id || ''
              const opts = HF_COMPOSITION_OPTIONS.includes(current)
                ? HF_COMPOSITION_OPTIONS
                : [...HF_COMPOSITION_OPTIONS, current]
              return (
                <select
                  className="input"
                  value={current}
                  onChange={(e) => onPatch({ hyperframes_composition_id: e.target.value || null })}
                  style={{ fontSize: 11.5, padding: '4px 6px', height: 'auto', width: 'auto', minWidth: 140 }}
                >
                  {opts.map((c) => (
                    <option key={c} value={c}>{c || 'No template'}</option>
                  ))}
                </select>
              )
            })()}

            {/* B-roll style toggle: image (Ken Burns on Kie nano-banana
                still) vs video (Grok Imagine image-to-video). Visible
                only on voiceover_broll segments. The icon + label make
                it scannable at a glance — Ray asked to be able to see
                "which ones are going to be video and which ones are
                going to be image B-roll" without inspecting each row.
                Toggling fires a PATCH which invalidates rendered_chunk_url
                so the next render rebuilds with the new mode. */}
            {isBroll && (
              <label
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '4px 8px', borderRadius: 6,
                  fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                  background: segment.is_video_broll ? 'rgba(168,85,247,0.18)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${segment.is_video_broll ? 'rgba(168,85,247,0.55)' : 'var(--border)'}`,
                  color: segment.is_video_broll ? '#c084fc' : 'var(--muted)',
                  whiteSpace: 'nowrap',
                }}
                title={segment.is_video_broll
                  ? 'Grok Imagine animates the still into a short video clip. ~$0.015/sec extra.'
                  : 'Still image with Ken Burns zoom. Default — no extra cost beyond the image.'}
              >
                <input
                  type="checkbox"
                  checked={!!segment.is_video_broll}
                  onChange={(e) => onPatch({ is_video_broll: e.target.checked })}
                  style={{ margin: 0, accentColor: '#a855f7' }}
                />
                {segment.is_video_broll ? '🎬 Video' : '🖼 Image'}
              </label>
            )}

            {(() => {
              // Same value-preservation pattern as the composition select:
              // fold the segment's current transition into the list if it
              // isn't in the canonical pool, so the dropdown always
              // displays the real value rather than the first fallback.
              const tCurrent = segment.transition_in || 'cut'
              const tOpts = TRANSITION_OPTIONS.includes(tCurrent)
                ? TRANSITION_OPTIONS
                : [...TRANSITION_OPTIONS, tCurrent]
              return (
                <select
                  className="input"
                  value={tCurrent}
                  onChange={(e) => onPatch({ transition_in: e.target.value })}
                  style={{ fontSize: 11.5, padding: '4px 6px', height: 'auto', width: 'auto' }}
                  title="Transition in"
                >
                  {tOpts.map((t) => (
                    <option key={t} value={t}>↪ {t}</option>
                  ))}
                </select>
              )
            })()}

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
              {/* Per-segment regen — only for rows that actually have
                  an external asset to regenerate (avatar / B-roll).
                  Voiceover-only motion-graphics regen via the AI chat;
                  pure-motion has nothing to regen. */}
              {(isAvatar || isBroll) && onRegen && (
                <button
                  type="button"
                  onClick={() => {
                    // Build the regen scope. Voice is sliced from the
                    // user's uploaded clip in upload-voiceover mode —
                    // we must NOT re-synth it via ElevenLabs there, or
                    // their actual recorded voice gets replaced with
                    // TTS. Skip 'voice' from the types when locked.
                    const types = []
                    if (!isVoiceLocked) types.push('voice')
                    types.push(isAvatar ? 'avatar' : 'image')
                    onRegen(types)
                  }}
                  className="btn-ghost"
                  style={{ padding: '4px 8px', fontSize: 11, color: 'var(--red)', fontWeight: 700 }}
                  title={
                    isVoiceLocked
                      ? (isAvatar
                          ? 'Re-render the HeyGen avatar video using your uploaded voice slice — voice stays untouched.'
                          : 'Regenerate the B-roll image only. Voice was sliced from your upload and stays untouched.')
                      : (isAvatar
                          ? 'Re-synthesize voice + re-render the HeyGen avatar video for this segment only.'
                          : 'Re-synthesize voice + regenerate the B-roll image for this segment only.')
                  }
                >
                  <RefreshCw size={11} /> Regen
                  {isVoiceLocked && (
                    <span style={{ marginLeft: 4, opacity: 0.7, fontWeight: 500 }}>(image only)</span>
                  )}
                </button>
              )}
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

          {/* Script text (skip for pure motion graphics). Enter splits
              the line into a new segment at the cursor; Shift+Enter
              still inserts a literal newline. */}
          {!isPureMotion && (
            <DebouncedTextarea
              initialValue={segment.script_text || ''}
              onCommit={(v) => onPatch({ script_text: v })}
              onSplit={onSplit}
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

          {/* Motion graphics variable editor (preview shown at top via TemplateSelector) */}
          {isMotion && segment.hyperframes_composition_id && (
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                onClick={() => setShowVarsEditor((v) => !v)}
                className="btn-ghost"
                style={{ fontSize: 11, padding: '4px 8px', color: 'var(--muted)' }}
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

          {/* Generated assets preview + per-segment download/upload affordances */}
          {(segment.image_url || segment.voice_url || segment.avatar_video_url || segment.broll_video_url) && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {/* B-roll preview: prefer the Grok motion clip when it's
                  landed, otherwise fall back to the still image. The
                  Grok mp4 IS the still + 6-30s of motion baked in, so
                  showing it in place of the static thumbnail lets the
                  user spot-check the motion before committing to a full
                  render. Click-to-play (muted autoplay would be too
                  noisy when many segments are visible). */}
              {segment.broll_video_url ? (
                <a href={segment.broll_video_url} target="_blank" rel="noopener noreferrer" style={{ display: 'block', position: 'relative' }}>
                  <video
                    src={segment.broll_video_url}
                    muted
                    playsInline
                    preload="metadata"
                    onMouseEnter={(e) => { try { e.currentTarget.play() } catch { /* noop */ } }}
                    onMouseLeave={(e) => { try { e.currentTarget.pause(); e.currentTarget.currentTime = 0 } catch { /* noop */ } }}
                    style={{ width: 96, height: 54, objectFit: 'cover', borderRadius: 4, border: '1px solid rgba(168,85,247,0.55)', display: 'block', background: '#000' }}
                    title="Hover to play Grok motion preview — click to open"
                  />
                  <span style={{ position: 'absolute', bottom: 2, right: 2, fontSize: 9, fontWeight: 700, background: 'rgba(168,85,247,0.85)', color: '#fff', padding: '1px 4px', borderRadius: 3, pointerEvents: 'none' }}>🎬 GROK</span>
                </a>
              ) : segment.image_url && (
                <a href={segment.image_url} target="_blank" rel="noopener noreferrer" style={{ display: 'block' }}>
                  <img
                    src={segment.image_url} alt="B-roll preview"
                    style={{ width: 96, height: 54, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)' }}
                  />
                </a>
              )}
              {segment.voice_url && (
                <>
                  <audio src={segment.voice_url} controls style={{ height: 28 }} />
                  {/* Download voice MP3 — manual-mode only. Lets the
                      user grab the audio and render avatars elsewhere
                      with it. Hidden in default mode where everything
                      is generated on-platform. */}
                  {manualMode && (
                    <a
                      href={segment.voice_url}
                      download={`segment-${String(segment.segment_index + 1).padStart(2, '0')}-voice.mp3`}
                      style={{ fontSize: 11, color: 'var(--red)', fontWeight: 600 }}
                      title="Download this segment's voice as MP3"
                    >
                      ↓ MP3
                    </a>
                  )}
                </>
              )}
              {segment.avatar_video_url && (
                <a href={segment.avatar_video_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Avatar clip ↗
                </a>
              )}
            </div>
          )}

          {/* Upload-your-own-avatar — only on avatar segments AND only
              in manual mode. Lets users render avatars elsewhere
              (DID, Synthesia, own RVC tool) and plug the file in here.
              Skips HeyGen for this segment on the next bake. Hidden in
              default mode — those users just let HeyGen handle it. */}
          {manualMode && isAvatar && onUploadAvatar && (
            <div style={{ marginTop: 8 }}>
              <UploadAvatarButton
                segmentId={segment.id}
                hasUpload={!!segment.avatar_video_url}
                onUploaded={onUploadAvatar}
              />
            </div>
          )}

          {/* Screenshot upload — always available on screenshot
              segments (not gated by manualMode). The render worker
              uses the uploaded image inside the template-styled
              device frame. */}
          {isScreenshot && onUploadScreenshot && (
            <div style={{ marginTop: 8 }}>
              <UploadScreenshotButton
                segmentId={segment.id}
                hasUpload={!!segment.image_url}
                onUploaded={onUploadScreenshot}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// File-input button for users to drop their own pre-rendered avatar
// video into a segment. POSTs multipart/form-data to /api/studio/
// segments/upload-avatar. Disabled while uploading.
function UploadAvatarButton({ segmentId, hasUpload, onUploaded }) {
  const { session } = useAuth()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef(null)

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file || !session?.access_token) return
    setBusy(true); setErr('')
    try {
      // Phase 1 — ask the server for a signed upload URL. This avoids
      // Vercel's 4.5MB serverless body limit (the previous direct-POST
      // path failed with 413 on any file over ~4MB).
      const initR = await authedFetch(
        `/api/studio/segments/upload-avatar?id=${segmentId}&mode=init`,
        session.access_token,
        { method: 'POST', body: JSON.stringify({
          filename: file.name,
          content_type: file.type || 'video/mp4',
        }) },
      )
      const initBody = await initR.json().catch(() => ({}))
      if (!initR.ok) throw new Error(initBody.error || `Upload init failed (${initR.status})`)
      const { signed_url, path, token, content_type } = initBody

      // Phase 2 — PUT the file straight to Supabase Storage. No size
      // limit imposed by Vercel because the bytes never hit our API.
      // Supabase signed-upload URLs use the supplied token via the
      // Authorization header.
      const putR = await fetch(signed_url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': content_type,
          'x-upsert': 'true',
        },
        body: file,
      })
      if (!putR.ok) {
        const detail = await putR.text().catch(() => '')
        throw new Error(`Storage upload ${putR.status}: ${detail.slice(0, 200)}`)
      }

      // Phase 3 — finalize: tell the server the file is in place so it
      // can patch the segment row.
      const finR = await authedFetch(
        `/api/studio/segments/upload-avatar?id=${segmentId}&mode=finalize`,
        session.access_token,
        { method: 'POST', body: JSON.stringify({ path }) },
      )
      const finBody = await finR.json().catch(() => ({}))
      if (!finR.ok) throw new Error(finBody.error || `Finalize failed (${finR.status})`)
      toast({ message: 'Avatar video uploaded — HeyGen skipped for this segment.', kind: 'success' })
      onUploaded?.()
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="btn-ghost"
        style={{
          fontSize: 11, padding: '4px 10px',
          color: 'var(--text-soft)', border: '1px dashed var(--border)',
          borderRadius: 6, cursor: busy ? 'wait' : 'pointer', background: 'transparent',
        }}
        title="Upload an MP4 you rendered with your own avatar platform (DID, Synthesia, etc). The bake will use this instead of calling HeyGen for this segment."
      >
        {busy ? <Loader2 size={11} className="spin" /> : null}
        {hasUpload ? '↑ Replace my avatar video' : '↑ Use my own avatar video'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/*"
        onChange={onFile}
        style={{ display: 'none' }}
      />
      {err && (
        <span style={{ fontSize: 11, color: 'var(--red)' }}>{err}</span>
      )}
    </div>
  )
}

// File-input button for screenshot segments. Same 3-phase signed-URL
// flow as UploadAvatarButton — keeps the upload off Vercel (Supabase
// Storage handles the bytes directly). On success the server patches
// segment.image_url; realtime delivers the new value back to the UI.
function UploadScreenshotButton({ segmentId, hasUpload, onUploaded }) {
  const { session } = useAuth()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef(null)

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file || !session?.access_token) return
    setBusy(true); setErr('')
    try {
      const initR = await authedFetch(
        `/api/studio/segments/upload-screenshot?id=${segmentId}&mode=init`,
        session.access_token,
        { method: 'POST', body: JSON.stringify({
          filename: file.name,
          content_type: file.type || 'image/png',
        }) },
      )
      const initBody = await initR.json().catch(() => ({}))
      if (!initR.ok) throw new Error(initBody.error || `Upload init failed (${initR.status})`)
      const { signed_url, path, token, content_type } = initBody

      const putR = await fetch(signed_url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': content_type,
          'x-upsert': 'true',
        },
        body: file,
      })
      if (!putR.ok) {
        const detail = await putR.text().catch(() => '')
        throw new Error(`Storage upload ${putR.status}: ${detail.slice(0, 200)}`)
      }

      const finR = await authedFetch(
        `/api/studio/segments/upload-screenshot?id=${segmentId}&mode=finalize`,
        session.access_token,
        { method: 'POST', body: JSON.stringify({ path }) },
      )
      const finBody = await finR.json().catch(() => ({}))
      if (!finR.ok) throw new Error(finBody.error || `Finalize failed (${finR.status})`)
      toast({ message: 'Screenshot uploaded.', kind: 'success' })
      onUploaded?.()
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="btn-ghost"
        style={{
          fontSize: 11, padding: '4px 10px',
          color: 'var(--text-soft)', border: '1px dashed var(--border)',
          borderRadius: 6, cursor: busy ? 'wait' : 'pointer', background: 'transparent',
        }}
        title="Upload an image (PNG / JPG / WEBP) or video (MP4 / MOV / WEBM). It will be rendered inside the template's device-framed card while the voiceover plays. Video gets cut at the next segment."
      >
        {busy ? <Loader2 size={11} className="spin" /> : null}
        {hasUpload ? '↑ Replace screenshot / video' : '↑ Upload screenshot or video'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/*,video/mp4,video/quicktime,video/webm,video/*"
        onChange={onFile}
        style={{ display: 'none' }}
      />
      {err && (
        <span style={{ fontSize: 11, color: 'var(--red)' }}>{err}</span>
      )}
    </div>
  )
}

// Per-segment chunk preview. The worker uploads each baked segment to
// Supabase Storage and writes the URL to segment.rendered_chunk_url
// as soon as it finishes. This lets a long-form bake (52 segments,
// 40+ min) show progress materializing in real time instead of just a
// "current/total" counter, and gives the user a way to spot-check a
// problem segment WITHOUT waiting for the whole final video.
//
// Empty box (no border, no label) when the chunk isn't ready yet —
// keeps the row layout stable instead of jumping when the URL arrives.
function ChunkPreview({ url, aspectRatio }) {
  // Aspect-aware container sizing. Landscape: 80x45 (16:9). Vertical:
  // 36x64 (9:16). Square: 56x56. Worker chunks are always rendered at
  // the project dim, so the URL itself is the right aspect — we just
  // pick a reasonable thumbnail box.
  const isVertical = aspectRatio === '9:16'
  const isSquare = aspectRatio === '1:1'
  const w = isVertical ? 36 : isSquare ? 56 : 80
  const h = isVertical ? 64 : isSquare ? 56 : 45

  if (!url) {
    return (
      <div style={{
        width: w, height: h, borderRadius: 6,
        background: 'var(--surface)', border: '1px dashed var(--border)',
        display: 'grid', placeItems: 'center',
        fontSize: 9, color: 'var(--muted)', flexShrink: 0,
      }} title="No baked chunk yet">
        —
      </div>
    )
  }

  return (
    <video
      src={url}
      muted
      playsInline
      preload="metadata"
      controls={false}
      onClick={(e) => {
        // Click to play/pause — quick spot-check without opening a
        // separate viewer.
        const v = e.currentTarget
        if (v.paused) v.play(); else v.pause()
      }}
      style={{
        width: w, height: h, borderRadius: 6, objectFit: 'cover',
        background: '#000', cursor: 'pointer', flexShrink: 0,
        border: '1px solid var(--border)',
      }}
      title="Baked chunk preview — click to play"
    />
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

function DebouncedTextarea({ initialValue, onCommit, onSplit, placeholder, rows = 2, style }) {
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
  // Enter-to-split. Plain Enter (no modifiers) calls onSplit with the
  // cursor position so the parent can POST /api/studio/segments/split.
  // Shift+Enter still inserts a literal newline as an escape hatch —
  // not that voiceover text needs newlines, but the muscle-memory is
  // worth preserving for users pasting multi-line scripts.
  const onKeyDown = (e) => {
    if (!onSplit) return
    if (e.key !== 'Enter') return
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
    const ta = e.target
    const cursor = typeof ta.selectionStart === 'number' ? ta.selectionStart : value.length
    // Reject cursor at very start / very end — would produce an empty
    // half. Server enforces this too; bailing here avoids a wasted
    // round trip and gives instant visual feedback (the newline just
    // doesn't happen).
    if (cursor <= 0 || cursor >= value.length) return
    e.preventDefault()
    if (timerRef.current) clearTimeout(timerRef.current)

    // Commit the FULL current text first so the server-side split RPC
    // sees the freshest version when it slices at the cursor offset.
    commit(value)

    // Optimistically collapse this textarea to the prefix so the user
    // doesn't see stale full-text while the realtime UPDATE catches up.
    // Without this, the local `value` state stayed at the original full
    // string and the `!focused` guard in useEffect blocked the prefix
    // from arriving — so the original segment row visually still
    // contained both halves of the split.
    const prefix = value.slice(0, cursor).trimEnd()
    if (prefix && prefix !== value) {
      setValue(prefix)
      lastCommittedRef.current = prefix
    }
    // Blur so the useEffect resync isn't gated by `focused`. The newly
    // created sibling row will steal focus naturally on next paint.
    try { ta.blur() } catch { /* noop */ }

    onSplit(cursor)
  }

  return (
    <textarea
      value={value}
      onChange={onChange}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      rows={rows}
      className="input"
      style={{ fontSize: 13, lineHeight: 1.5, resize: 'vertical', ...style }}
      title={onSplit ? 'Press Enter to split into a new segment at the cursor. Shift+Enter for a literal newline.' : undefined}
    />
  )
}
