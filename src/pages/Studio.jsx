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
  const [templates, setTemplates] = useState([])
  // Slimmed-down form per PDF feedback. No title (auto-generated), no
  // reference URL / text, no brand_color picker (synced from brand
  // profile), no voice picker (tied to avatar), no overlays / auto-fit
  // toggles (both always on under the hood).
  const [form, setForm] = useState({
    topic_prompt: '',
    avatar_id: '',  // empty string = "Voiceover only — no avatar"
    look_id: '',
    target_duration_secs: 120,
    aspect_ratio: '16:9',
    template_id: 'sleek',
    captions_enabled: true,
  })
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

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
        if (!cancelled) setAvatars(a.avatars || [])
      } catch { /* dropdown stays empty */ }
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
        // Title is auto-generated server-side from the topic.
        topic_prompt: form.topic_prompt.trim(),
        avatar_id: form.avatar_id || null,
        look_id: form.look_id || null,
        // Voice is tied to avatar via brand profile — no separate picker.
        target_duration_secs: Number(form.target_duration_secs) || 120,
        aspect_ratio: form.aspect_ratio,
        template_id: form.template_id || 'sleek',
        // Brand color is synced from the brand profile on the server.
        captions_enabled: form.captions_enabled !== false,
        // Overlays + auto-fit always on. Defaults in DB are true; we
        // explicitly send so even an admin who flipped the defaults
        // gets the intended behavior for new videos.
        overlays_enabled: true,
        motion_graphics_enabled: true,
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

      {/* 2. Avatar — or "Voiceover only" for all motion-graphics + B-roll. */}
      <Field label="2.  Avatar" hint='Voice is auto-tied to your selected avatar. Choose "Voiceover only" for a video built entirely from motion graphics and B-roll.'>
        <select className="input" value={form.avatar_id} onChange={(e) => set('avatar_id', e.target.value)}>
          <option value="">Voiceover only — no avatar (motion graphics + B-roll)</option>
          {avatars.map((a) => (
            <option key={a.id} value={a.id}>{a.name || a.id.slice(0, 8)}</option>
          ))}
        </select>
      </Field>

      {/* Look picker — only when an avatar with looks is selected. */}
      {selectedAvatar && looks.length > 0 && (
        <Field label="Look" hint="Which trained look/framing of this avatar to render with.">
          <select className="input" value={form.look_id} onChange={(e) => set('look_id', e.target.value)}>
            <option value="">Default (first look)</option>
            {looks.map((l) => {
              const o = l.orientation
              const tag = o ? ` · ${o}` : ''
              return (
                <option key={l.id} value={l.id}>
                  {(l.name || `Look ${(l.angle_order ?? 0) + 1}`) + tag}
                </option>
              )
            })}
          </select>
        </Field>
      )}

      {/* 3. Length. */}
      <Field label={`3.  Length: ${form.target_duration_secs}s`} hint="30 seconds to 5 minutes.">
        <input
          type="range"
          min={30} max={300} step={15}
          value={form.target_duration_secs}
          onChange={(e) => set('target_duration_secs', Number(e.target.value))}
          style={{ width: '100%' }}
        />
      </Field>

      {/* 4. Topic. */}
      <Field label="4.  Topic" required hint="What is this video about? One or two sentences. Title is auto-generated.">
        <textarea
          className="input"
          rows={3}
          placeholder="A 90-second explainer on why faceless creators are out-shipping personal brands in 2026."
          value={form.topic_prompt}
          onChange={(e) => set('topic_prompt', e.target.value)}
          maxLength={2000}
        />
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
function StudioVideoEditor({ videoId }) {
  const { session } = useAuth()
  const navigate = useNavigate()
  const [video, setVideo] = useState(null)
  const [error, setError] = useState(null)

  // Initial load + lightweight refresh on focus. The Realtime channel
  // below handles ongoing updates; this is just the cold load.
  // Hardened so a non-JSON 401 / 5xx page from Vercel can't silently
  // wedge the UI on an infinite spinner — we surface whatever text we
  // got as an error instead.
  useEffect(() => {
    if (!session?.access_token) return
    let cancelled = false
    ;(async () => {
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
    })()
    return () => { cancelled = true }
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
            />
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
                <a href={video.final_video_url} download style={{ color: 'var(--red)', fontWeight: 700 }}>
                  Download MP4 ↓
                </a>
              </div>
              <RenderQualityNote video={video} />
            </div>
          )}

          {(['mapped', 'editing', 'rendering', 'rendered'].includes(video.status)) && (
            <>
              <TemplateSelector video={video} onApplied={(updated) => setVideo(updated || video)} />
              <CaptionsToggle video={video} onChanged={(updated) => setVideo(updated || video)} />
              {/* Overlays + auto-fit motion-graphics are forced on
                  every render now — the toggles were redundant. The
                  underlying columns (overlays_enabled,
                  motion_graphics_enabled) stay in the DB so a future
                  admin tool can flip them if needed, but the editor
                  no longer surfaces them. */}
              <SegmentList video={video} />
              <StudioChat videoId={video.id} />
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

function TemplateSelector({ video, onApplied }) {
  const { session } = useAuth()
  const [templates, setTemplates] = useState([])
  const [templateId, setTemplateId] = useState(video.template_id || 'sleek')
  const [brandColor, setBrandColor] = useState(video.brand_color || '')
  const [busy, setBusy] = useState(false)

  // Load the template list on mount.
  useEffect(() => {
    if (!session?.access_token) return
    authedFetch('/api/studio/templates', session.access_token)
      .then((r) => r.ok ? r.json() : { templates: [] })
      .then((b) => {
        const list = b.templates || []
        setTemplates(list)
        // If the video doesn't have a brand_color stored, seed from
        // the selected template's accent so the preview iframe shows
        // something meaningful.
        if (!brandColor) {
          const cur = list.find((t) => t.id === (video.template_id || 'sleek'))
          if (cur?.primary_accent) setBrandColor(cur.primary_accent)
        }
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.access_token])

  // Resync local state when the video row changes (e.g. after onApplied).
  useEffect(() => {
    setTemplateId(video.template_id || 'sleek')
    if (video.brand_color) setBrandColor(video.brand_color)
  }, [video.template_id, video.brand_color])

  const selected = templates.find((t) => t.id === templateId)
  const savedTemplate = video.template_id || 'sleek'
  const savedColor = video.brand_color || (templates.find((t) => t.id === savedTemplate)?.primary_accent ?? '')
  const dirty = templateId !== savedTemplate || (brandColor || '') !== (savedColor || '')

  // Preview iframe vars. Cascade the chosen brand color into every
  // {accent}-shaped value the composition reads.
  const previewVars = useMemo(() => {
    if (!selected?.preview) return null
    const vars = { ...(selected.preview.variables || {}) }
    const accent = brandColor || selected.primary_accent || '#e3151e'
    for (const k of Object.keys(vars)) {
      if (typeof vars[k] === 'string' && vars[k] === '{accent}') vars[k] = accent
    }
    vars.accent_color = accent
    return vars
  }, [selected?.preview, brandColor])

  const apply = async () => {
    if (!session?.access_token || busy || !dirty) return
    setBusy(true)
    try {
      // Step 1 — patch template + cascade color to motion segments.
      const r1 = await authedFetch('/api/studio/apply-template', session.access_token, {
        method: 'POST',
        body: JSON.stringify({
          studio_video_id: video.id,
          template_id: templateId,
          brand_color: brandColor || null,
          deep: false,
        }),
      })
      const b1 = await r1.json().catch(() => ({}))
      if (!r1.ok) throw new Error(b1.error || 'Could not apply template')

      // Step 2 — kick off the final bake immediately. Asset URLs are
      // preserved through the shallow apply, so this is essentially a
      // free re-render: just ffmpeg pulling existing audio/avatar/
      // image bytes from Supabase storage with the new HyperFrames
      // CSS vars baked into the motion segments.
      const r2 = await authedFetch('/api/studio/render-final', session.access_token, {
        method: 'POST',
        body: JSON.stringify({ studio_video_id: video.id }),
      })
      const b2 = await r2.json().catch(() => ({}))
      if (!r2.ok) throw new Error(b2.error || 'Re-render failed')
      toast({ message: `Applied ${selected?.name || templateId}. New render is ready.`, kind: 'success' })

      // Refresh the video row in the parent.
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

  const aspect = video.aspect_ratio === '9:16' ? '9 / 16'
    : video.aspect_ratio === '1:1' ? '1 / 1'
    : '16 / 9'

  return (
    <div className="card" style={{ marginBottom: 16, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        {/* Left column: dropdown + color picker + apply button */}
        <div style={{ flex: '1 1 280px', minWidth: 240, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
              Visual template
            </div>
            <select
              className="input"
              value={templateId}
              onChange={(e) => {
                const next = e.target.value
                setTemplateId(next)
                const t = templates.find((x) => x.id === next)
                if (t?.primary_accent) setBrandColor(t.primary_accent)
              }}
              disabled={busy}
              style={{ width: '100%', fontWeight: 700 }}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.id === savedTemplate ? ' · currently used' : ''}
                </option>
              ))}
            </select>
            {selected?.description && (
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.4 }}>
                {selected.description}
              </div>
            )}
          </div>

          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
              Brand color
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="color"
                value={brandColor || selected?.primary_accent || '#e3151e'}
                onChange={(e) => setBrandColor(e.target.value)}
                disabled={busy}
                style={{ width: 44, height: 32, border: '1px solid var(--border)', borderRadius: 6, background: 'transparent', padding: 0, cursor: 'pointer' }}
              />
              <input
                type="text"
                className="input"
                value={brandColor || selected?.primary_accent || '#e3151e'}
                onChange={(e) => setBrandColor(e.target.value)}
                disabled={busy}
                style={{ flex: 1, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                maxLength={9}
              />
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              Cascades into every motion graphic in the video.
            </div>
          </div>

          <button
            type="button"
            className="btn-primary"
            disabled={!dirty || busy}
            onClick={apply}
            style={{ fontSize: 13, padding: '10px 16px' }}
            title={dirty
              ? `Apply ${selected?.name || templateId} and re-render the final MP4 (avatar/voice/B-roll assets are reused — no extra cost).`
              : 'Pick a different template or color first.'}
          >
            {busy ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
            {busy ? 'Applying + re-rendering…' : 'Use this template'}
          </button>
          {!dirty && (
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              No changes. Pick a different template or brand color to enable.
            </div>
          )}
        </div>

        {/* Right column: live preview iframe */}
        <div style={{ flex: '2 1 360px', minWidth: 280 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
            Preview
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
              aspectRatio: aspect,
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

function StickyActionBar({ video, approvedCount, totalCount, segments }) {
  const { session } = useAuth()
  const [busy, setBusy] = useState(false)
  const [showRegenOptions, setShowRegenOptions] = useState(false)
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

  // Continue dispatcher: pick the right action based on the current phase.
  //   ready-to-bake / done → bake (segments already have assets)
  //   rendered-needs-assets → regen assets first (the existing render
  //     is preserved on the row, so the player keeps working until the
  //     new bake replaces it)
  //   anything else → asset gen
  const onContinue = (phase === 'ready-to-bake' || phase === 'done') ? onRender : onAssets

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
      {(phase === 'rendered-needs-assets' || phase === 'ready-for-assets') && (
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => setShowRegenOptions((v) => !v)}
          style={{ fontSize: 12, padding: '8px 12px' }}
          title="Pick which asset classes to regenerate. Skip the expensive ones (avatar, B-roll) when you just want to test voice or motion graphics."
        >
          Choose…
        </button>
      )}
      <button
        type="button"
        className="btn-primary"
        disabled={busy || phase === 'rendering' || phase === 'baking' || phase === 'pre-approval'}
        onClick={onContinue}
        style={{ fontSize: 13, padding: '10px 18px' }}
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
