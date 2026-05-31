// NewLookModal — unified "create a look" survey-style flow.
//
// Consolidates two workflows that used to require expert ops on a
// node graph (outfit changer + camera angles) into a single guided
// modal. The user uploads an avatar photo + optional outfit + optional
// environment, picks an orientation, approves the composed hero shot,
// then optionally generates 4 podcast-style angles (hero / 45L / 45R
// / 90L) from the approved hero. Final step saves everything as one
// avatar_looks row + N avatar_look_images rows + dispatches HeyGen V3
// training on the cover.
//
// Designed to slot into both:
//   • New Avatar flow — parent creates the avatar shell first, then
//     opens this modal with avatarId=<new id> so the user lands in
//     the look-creation flow without an extra click.
//   • New Look on existing avatar — opens directly with the chosen
//     avatar_id; same flow minus the avatar-creation prelude.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  X, ChevronLeft, ChevronRight, Upload, Sparkles, Check, Loader2,
  AlertCircle, RotateCcw, Image as ImageIcon, Camera,
} from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { compressImageIfLarge } from '../lib/image-compress.js'
import { useAuth } from '../context/AuthContext.jsx'

const POLL_INTERVAL_MS = 4000
const POLL_TIMEOUT_MS = 180_000  // 3 min per task

const MODES = [
  { id: 'compose_then_angles', label: 'Swap outfit + create 4 angles', hint: 'Generate a new hero shot from your outfit + environment, then 4 podcast angles.' },
  { id: 'angles_only',         label: 'Just 4 podcast angles',           hint: 'Use the avatar photo as-is. Skip outfit/environment. Just generate the 4 angles.' },
  { id: 'compose_only',        label: 'Just swap the outfit',            hint: 'Generate one new hero shot. Skip the multi-angle pass.' },
]

const BG_SOURCES = [
  { id: 'avatar', label: 'Use the avatar photo background' },
  { id: 'outfit', label: 'Use the outfit photo background' },
]

const ANGLE_LABELS = {
  compose: 'Hero shot',
  hero: 'Hero (dead-on)',
  '45_left': '45° left',
  '45_right': '45° right',
  '90_left': 'Profile left',
}

export default function NewLookModal({ avatarId, profileId, onClose, onCreated }) {
  const { session } = useAuth()
  const token = session?.access_token

  // Single answers blob — same pattern as NewVideoModal / GenerateMonthModal.
  const [stepIdx, setStepIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [a, setA] = useState({
    name: '',
    avatar_image_url: '',
    outfit_image_url: '',
    environment_image_url: '',
    background_source: 'avatar',
    // Pose direction. Either a reference image OR a free-text
    // description. Both null/empty = sensible default ("speaking to
    // camera, no props"). When the user uploads a pose ref AND
    // writes a description, the prompt uses both — image for body /
    // hand position, text for clarifying detail.
    pose_kind: 'default',   // 'default' | 'image' | 'text'
    pose_image_url: '',
    pose_description: '',
    orientation: 'horizontal', // 'horizontal' | 'vertical'
    mode: 'compose_then_angles',
    hero_image_url: '',                // approved hero (compose output or original avatar in angles_only)
    angle_images: {},                  // { hero: url, '45_left': url, ... }
  })
  const set = (k, v) => setA((prev) => ({ ...prev, [k]: v }))

  // Conditional step list. Each step's logic is gated on which mode
  // the user picked and which fields they've filled.
  const steps = useMemo(() => {
    const out = ['name', 'avatar_upload', 'mode']
    if (a.mode === 'compose_then_angles' || a.mode === 'compose_only') {
      // Pose direction lands between Environment and Orientation —
      // logically it's the last creative-direction choice before the
      // framing decision, and it only matters when we're actually
      // composing a new hero shot.
      out.push('outfit_upload', 'environment', 'pose')
    }
    out.push('orientation')
    if (a.mode === 'compose_then_angles' || a.mode === 'compose_only') {
      out.push('compose_preview')
    }
    if (a.mode === 'compose_then_angles' || a.mode === 'angles_only') {
      out.push('angles_preview')
    }
    out.push('confirm')
    return out
  }, [a.mode])
  const step = steps[stepIdx] || 'confirm'

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // Reset error whenever the user advances/retreats.
  useEffect(() => { setError(null) }, [stepIdx])

  // ── Step gates ─────────────────────────────────────────────────
  const canNext = () => {
    if (step === 'name') return a.name.trim().length >= 1
    if (step === 'avatar_upload') return !!a.avatar_image_url
    if (step === 'mode') return MODES.some((m) => m.id === a.mode)
    if (step === 'outfit_upload') return !!a.outfit_image_url
    if (step === 'environment') {
      // Either an env photo, or a fallback source picked.
      return !!a.environment_image_url || !!a.background_source
    }
    if (step === 'pose') {
      // Default needs no further input. Image / text variants need
      // their respective field filled.
      if (a.pose_kind === 'default') return true
      if (a.pose_kind === 'image') return !!a.pose_image_url
      if (a.pose_kind === 'text') return a.pose_description.trim().length >= 4
      return true
    }
    if (step === 'orientation') return a.orientation === 'horizontal' || a.orientation === 'vertical'
    if (step === 'compose_preview') return !!a.hero_image_url
    if (step === 'angles_preview') return Object.keys(a.angle_images).length >= 1
    return true
  }

  const back = () => setStepIdx((i) => Math.max(0, i - 1))
  const next = () => {
    if (!canNext()) return
    // Pre-step hooks. When entering compose_preview for the first time
    // we don't auto-fire — the user picks "Generate" inside the step
    // so they can review their inputs first.
    setStepIdx((i) => Math.min(steps.length - 1, i + 1))
  }

  // ── Persistence — save final look ──────────────────────────────
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      // Build the images array in the canonical order: hero → 45L → 45R → 90L.
      // For compose_only, we save just the hero_image_url as the only image.
      const images = []
      if (a.mode === 'compose_only') {
        images.push({ url: a.hero_image_url, label: 'Hero' })
      } else {
        const order = ['hero', '45_left', '45_right', '90_left']
        for (const angle of order) {
          const url = a.angle_images[angle]
          if (url) images.push({ url, label: ANGLE_LABELS[angle] || angle })
        }
      }
      if (!images.length) throw new Error('No images to save — generate at least one before confirming.')

      const r = await fetch('/api/avatars/looks/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          avatar_id: avatarId,
          name: a.name.trim(),
          orientation: a.orientation,
          images,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error || `Save failed (${r.status})`)
      onCreated?.(body.look)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div style={cardStyle}>
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={brandIcon}><Sparkles size={16} /></div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>New look</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: 0.06 }}>
                STEP {stepIdx + 1} OF {steps.length}
              </div>
            </div>
          </div>
          <button onClick={onClose} style={closeBtn} aria-label="Close"><X size={18} /></button>
        </div>

        <div style={bodyStyle}>
          {error && (
            <div style={errorPanel}>
              <AlertCircle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
              {error}
            </div>
          )}

          {step === 'name' && (
            <StepName value={a.name} onChange={(v) => set('name', v)} />
          )}
          {step === 'avatar_upload' && (
            <StepUpload
              title="Upload a photo of your avatar"
              hint="Clear, well-lit shot. Face fully visible. This is the identity anchor for every generated image."
              value={a.avatar_image_url}
              profileId={profileId}
              onChange={(v) => set('avatar_image_url', v)}
            />
          )}
          {step === 'mode' && (
            <StepMode value={a.mode} onChange={(v) => set('mode', v)} />
          )}
          {step === 'outfit_upload' && (
            <StepUpload
              title="Upload the outfit you want them in"
              hint="A photo of the outfit on a mannequin, hanger, or another person. Identity isn't pulled from this — only the garments, colors, and patterns."
              value={a.outfit_image_url}
              profileId={profileId}
              onChange={(v) => set('outfit_image_url', v)}
            />
          )}
          {step === 'environment' && (
            <StepEnvironment
              envUrl={a.environment_image_url}
              bgSource={a.background_source}
              profileId={profileId}
              onChangeEnv={(v) => set('environment_image_url', v)}
              onChangeBgSource={(v) => set('background_source', v)}
              hasOutfit={!!a.outfit_image_url}
            />
          )}
          {step === 'pose' && (
            <StepPose
              kind={a.pose_kind}
              imageUrl={a.pose_image_url}
              description={a.pose_description}
              profileId={profileId}
              onChangeKind={(v) => {
                set('pose_kind', v)
                // Clear the other field's value when switching modes
                // so a stale upload from "image" doesn't leak into the
                // "text" prompt.
                if (v !== 'image')   set('pose_image_url', '')
                if (v !== 'text')    set('pose_description', '')
              }}
              onChangeImage={(v) => set('pose_image_url', v)}
              onChangeDescription={(v) => set('pose_description', v)}
            />
          )}
          {step === 'orientation' && (
            <StepOrientation value={a.orientation} onChange={(v) => set('orientation', v)} />
          )}
          {step === 'compose_preview' && (
            <StepComposePreview
              a={a} set={set} token={token} profileId={profileId}
            />
          )}
          {step === 'angles_preview' && (
            <StepAnglesPreview
              a={a} set={set} token={token} profileId={profileId}
            />
          )}
          {step === 'confirm' && (
            <StepConfirm a={a} />
          )}
        </div>

        <div style={footerStyle}>
          <button onClick={back} disabled={stepIdx === 0 || busy} className="btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <ChevronLeft size={14} /> Back
          </button>
          {step !== 'confirm' ? (
            <button onClick={next} disabled={!canNext() || busy} className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              Next <ChevronRight size={14} />
            </button>
          ) : (
            <button onClick={submit} disabled={busy} className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 160 }}>
              {busy ? <><Loader2 size={14} className="spin" /> Saving…</> : <><Check size={14} /> Save look</>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Steps
// ─────────────────────────────────────────────────────────────────

function StepName({ value, onChange }) {
  return (
    <Section title="Name this look" hint="A short tag for the wardrobe / setting. Shown wherever this look is referenced.">
      <input
        autoFocus
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Black tee in studio"
        style={titleInput}
        maxLength={80}
      />
    </Section>
  )
}

function StepMode({ value, onChange }) {
  return (
    <Section
      title="What do you want to generate?"
      hint="You can do both, or just one. Skip the outfit/background steps if you only want angles."
    >
      <div style={{ display: 'grid', gap: 10 }}>
        {MODES.map((m) => (
          <button
            key={m.id} type="button"
            onClick={() => onChange(m.id)}
            style={{
              padding: '16px 18px', textAlign: 'left',
              background: value === m.id ? 'rgba(239,68,68,0.10)' : 'var(--surface)',
              border: `1.5px solid ${value === m.id ? 'var(--red)' : 'var(--border)'}`,
              borderRadius: 10, cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{m.label}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>{m.hint}</div>
          </button>
        ))}
      </div>
    </Section>
  )
}

function StepUpload({ title, hint, value, profileId, onChange }) {
  return (
    <Section title={title} hint={hint}>
      <ImageDropzone url={value} profileId={profileId} onChange={onChange} />
    </Section>
  )
}

function StepEnvironment({ envUrl, bgSource, profileId, onChangeEnv, onChangeBgSource, hasOutfit }) {
  return (
    <Section
      title="Pick the environment"
      hint="Upload an environment photo OR choose which existing photo's background to reuse. You don't need a separate environment if you're happy with the avatar or outfit photo's background."
    >
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.06, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>Optional environment photo</div>
        <ImageDropzone url={envUrl} profileId={profileId} onChange={onChangeEnv} optional />
      </div>
      {!envUrl && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.06, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>
            Or use the background from
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {BG_SOURCES.filter((s) => s.id !== 'outfit' || hasOutfit).map((s) => (
              <button
                key={s.id} type="button"
                onClick={() => onChangeBgSource(s.id)}
                style={{
                  padding: '12px 14px', textAlign: 'left',
                  background: bgSource === s.id ? 'rgba(239,68,68,0.10)' : 'var(--surface)',
                  border: `1.5px solid ${bgSource === s.id ? 'var(--red)' : 'var(--border)'}`,
                  borderRadius: 8, cursor: 'pointer', fontSize: 13.5, fontWeight: 600,
                }}
              >{s.label}</button>
            ))}
          </div>
        </div>
      )}
    </Section>
  )
}

// Pre-tuned text descriptions surfaced as one-tap presets for users
// who aren't sure what to write. Picking a preset drops the user into
// 'text' mode with the prompt pre-filled — they can still tweak it.
// All presets assume avatar-friendly close-up framing (chest-up).
const POSE_PRESETS = {
  podcast: 'Seated on a podcast set with a professional condenser microphone on a boom arm in front of them, leaning slightly forward toward the mic, hands gesturing naturally mid-sentence as if explaining a point. Engaged, conversational expression, eye contact with the camera. Subtle shoulder turn so they read as in-conversation rather than posed.',
  presenter: 'Standing confidently in front of the camera, square to frame, one hand gesturing open-palm as if presenting an idea, the other relaxed at their side. Warm, authoritative expression. Subtle smile mid-sentence. Posture upright, shoulders relaxed back. No props in their hands.',
  casual: 'Seated comfortably in a modern lounge chair, leaning back at a relaxed angle, one arm resting on the armrest, the other hand gesturing softly while speaking. Conversational expression, half-smile, talking as if to a friend off-camera. Loose posture, no tension.',
  tutorial: 'Seated at a clean desk, slightly angled toward the camera. One hand resting on the desk near a closed laptop, the other hand gesturing while explaining a concept. Focused, helpful expression making eye contact with the camera. Clear teaching energy. No notebook or pen in their hands.',
  executive: 'Polished executive headshot energy. Standing or seated, hands clasped in front of them or one tucked behind, shoulders square, posture upright. Calm, decisive expression with a soft smile. Direct eye contact with the camera. Confident, no exaggerated gesture.',
}

function StepPose({ kind, imageUrl, description, profileId, onChangeKind, onChangeImage, onChangeDescription }) {
  // Order matters: defaults at the top (lowest friction), presets in
  // the middle, custom paths at the bottom. Presets share an id prefix
  // so the dispatch loop below can look them up generically.
  const options = [
    {
      id: 'default',
      label: 'Default — talking to camera',
      hint: 'Relaxed natural posture, hands at sides or in lap. No mic, no devices, no extra props.',
    },
    {
      id: 'preset_podcast',
      label: 'Podcast host',
      hint: 'Pro condenser mic on a boom arm, leaning in, gesturing mid-sentence.',
      isPreset: true,
    },
    {
      id: 'preset_presenter',
      label: 'Standing presenter',
      hint: 'On their feet, square to camera, open-palm gesture as if presenting an idea.',
      isPreset: true,
    },
    {
      id: 'preset_casual',
      label: 'Casual sit-down',
      hint: 'Lounge chair, leaning back, talking as if to a friend off-camera.',
      isPreset: true,
    },
    {
      id: 'preset_tutorial',
      label: 'Tutorial at desk',
      hint: 'Seated at a clean desk, one hand resting near the laptop, explaining a concept.',
      isPreset: true,
    },
    {
      id: 'preset_executive',
      label: 'Executive headshot',
      hint: 'Polished, hands clasped, shoulders square. Calm, decisive, no exaggerated gesture.',
      isPreset: true,
    },
    {
      id: 'image',
      label: 'Match a reference pose',
      hint: 'Upload a photo of anyone in the pose you want. We use only the body language — identity + outfit stay from your earlier uploads.',
    },
    {
      id: 'text',
      label: 'Describe the pose in words',
      hint: 'e.g. "Sitting in a black leather chair, arms resting on the armrests, looking thoughtful."',
    },
  ]
  // When user picks a preset, switch to text mode and pre-populate
  // the description with the canned prompt. This is a one-way pre-fill —
  // once they edit, it stays text mode with their tweaks. The chip
  // highlight below tracks the still-matches-canned state.
  const handleKindChange = (id) => {
    if (id.startsWith('preset_')) {
      const key = id.replace('preset_', '')
      if (POSE_PRESETS[key]) {
        onChangeKind('text')
        onChangeDescription(POSE_PRESETS[key])
        return
      }
    }
    onChangeKind(id)
  }
  return (
    <Section
      title="Pose & body language"
      hint="Avatars stay framed chest-up close to the camera. This step controls how they're sitting / standing and what they're doing with their hands."
    >
      {/* When kind is 'text' AND the description still equals one of
          the canned preset prompts, that preset's chip wins the
          highlight (not the generic "Describe the pose in words"
          chip). The moment the user edits the text away from the
          canned version, the generic text chip takes over. */}
      {(() => null)() /* keep flow simple; logic inline below */}
      <div style={{ display: 'grid', gap: 10 }}>
        {options.map((opt) => {
          const matchedPresetKey = kind === 'text'
            ? Object.keys(POSE_PRESETS).find((k) => POSE_PRESETS[k] === description)
            : null
          let isPresetActive = false
          if (opt.isPreset) {
            const key = opt.id.replace('preset_', '')
            isPresetActive = key === matchedPresetKey
          }
          // For the plain "text" entry: only active when we're in
          // text mode AND no preset matches the current description.
          const isPlainTextActive = opt.id === 'text' && kind === 'text' && !matchedPresetKey
          // Default + image: active iff their kind matches.
          const isOtherActive = (opt.id === 'default' || opt.id === 'image') && opt.id === kind
          const active = isPresetActive || isPlainTextActive || isOtherActive
          return (
            <button
              key={opt.id} type="button"
              onClick={() => handleKindChange(opt.id)}
              style={{
                padding: '14px 16px', textAlign: 'left',
                background: active ? 'rgba(239,68,68,0.10)' : 'var(--surface)',
                border: `1.5px solid ${active ? 'var(--red)' : 'var(--border)'}`,
                borderRadius: 10, cursor: 'pointer',
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{opt.label}</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>{opt.hint}</div>
            </button>
          )
        })}
      </div>

      {kind === 'image' && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.06, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>Pose reference photo</div>
          <ImageDropzone url={imageUrl} profileId={profileId} onChange={onChangeImage} />
          <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--muted)' }}>
            Only the body pose, hand position, and posture are pulled from this photo. The face, hair, and outfit are ignored.
          </div>
        </div>
      )}
      {kind === 'text' && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.06, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>Pose description</div>
          <textarea
            value={description}
            onChange={(e) => onChangeDescription(e.target.value)}
            placeholder="The man is sitting in a black leather chair, leaning slightly forward, hands clasped in his lap. Calm, focused expression."
            rows={4}
            style={{
              width: '100%', padding: 12, fontSize: 14, lineHeight: 1.5,
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 10, color: 'var(--text)', fontFamily: 'inherit',
              resize: 'vertical', boxSizing: 'border-box',
            }}
            maxLength={500}
          />
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)', textAlign: 'right' }}>
            {description.length} / 500
          </div>
        </div>
      )}
    </Section>
  )
}

function StepOrientation({ value, onChange }) {
  return (
    <Section
      title="Horizontal or vertical?"
      hint="Horizontal matches a podcast / talking-head shot. Vertical is for Reels, TikTok, Shorts. Affects framing and headroom."
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
        {[
          { v: 'horizontal', label: 'Horizontal · 16:9', hint: 'Podcast, YouTube, web embeds' },
          { v: 'vertical',   label: 'Vertical · 9:16',   hint: 'TikTok, Reels, Shorts' },
        ].map((opt) => (
          <button
            key={opt.v} type="button"
            onClick={() => onChange(opt.v)}
            style={{
              padding: '18px 16px', textAlign: 'left',
              background: value === opt.v ? 'rgba(239,68,68,0.10)' : 'var(--surface)',
              border: `1.5px solid ${value === opt.v ? 'var(--red)' : 'var(--border)'}`,
              borderRadius: 10, cursor: 'pointer',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14 }}>{opt.label}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{opt.hint}</div>
          </button>
        ))}
      </div>
    </Section>
  )
}

function StepComposePreview({ a, set, token, profileId }) {
  const [taskId, setTaskId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const dispatch = async () => {
    setBusy(true); setError(null); setTaskId(null); set('hero_image_url', '')
    try {
      const r = await fetch('/api/avatars/looks/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          mode: 'compose',
          profile_id: profileId,
          aspect_ratio: a.orientation === 'horizontal' ? '16:9' : '9:16',
          avatar_image_url: a.avatar_image_url,
          outfit_image_url: a.outfit_image_url || null,
          environment_image_url: a.environment_image_url || null,
          background_source: a.background_source,
          // Pose direction. The server picks how to weave these into
          // the prompt based on which is set.
          pose_image_url: a.pose_kind === 'image' ? (a.pose_image_url || null) : null,
          pose_description: a.pose_kind === 'text' ? (a.pose_description || null) : null,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error || `Compose dispatch failed (${r.status})`)
      const id = body?.task_ids?.[0]?.task_id
      if (!id) throw new Error('No task id returned')
      setTaskId(id)
    } catch (e) {
      setError(e.message)
    }
  }

  // Poll until ready / failed / timeout.
  useEffect(() => {
    if (!taskId) return
    let cancelled = false
    const start = Date.now()
    const tick = async () => {
      if (cancelled) return
      try {
        const r = await fetch(
          `/api/avatars/looks/poll-generation?task_id=${encodeURIComponent(taskId)}&profile_id=${encodeURIComponent(profileId)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        const body = await r.json()
        if (cancelled) return
        if (body.state === 'ready' && body.url) {
          set('hero_image_url', body.url)
          setBusy(false)
          return
        }
        if (body.state === 'failed') {
          setError(body.error || 'Image generation failed')
          setBusy(false)
          return
        }
        if (Date.now() - start > POLL_TIMEOUT_MS) {
          setError('Generation timed out after 3 minutes. Try again.')
          setBusy(false)
          return
        }
        setTimeout(tick, POLL_INTERVAL_MS)
      } catch (e) {
        if (!cancelled) { setError(e.message); setBusy(false) }
      }
    }
    tick()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  return (
    <Section title="Review the hero shot" hint="Generated from your avatar, outfit, and environment. If it's not quite right, regenerate. Once approved we'll use it as the source for the 4 angles.">
      {error && <div style={errorPanel}><AlertCircle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />{error}</div>}
      {!a.hero_image_url && !busy && (
        <button onClick={() => { setBusy(true); dispatch() }} className="btn-primary" style={{ padding: '12px 20px', fontSize: 14 }}>
          <Sparkles size={14} style={{ marginRight: 6, verticalAlign: -2 }} /> Generate hero shot
        </button>
      )}
      {busy && (
        <div style={{ padding: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--muted)' }}>
          <Loader2 size={18} className="spin" /> Compositing…
        </div>
      )}
      {a.hero_image_url && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          {/* maxHeight caps the preview to roughly the visible body
              area so the image never pushes the Back/Next buttons off
              screen. Object-fit:contain so the full frame is visible
              even when the aspect ratio is wider/taller than the box. */}
          <div style={{
            background: '#000', borderRadius: 12, overflow: 'hidden',
            border: '1px solid var(--border)',
            maxHeight: 'min(58vh, 520px)',
            maxWidth: '100%',
            aspectRatio: a.orientation === 'vertical' ? '9 / 16' : '16 / 9',
          }}>
            <img
              src={a.hero_image_url}
              alt="Hero shot"
              style={{ height: '100%', width: 'auto', maxWidth: '100%', objectFit: 'contain', display: 'block' }}
            />
          </div>
          <button
            onClick={() => { setBusy(true); set('hero_image_url', ''); dispatch() }}
            className="btn-ghost"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          ><RotateCcw size={13} /> Regenerate</button>
        </div>
      )}
    </Section>
  )
}

function StepAnglesPreview({ a, set, token, profileId }) {
  const [tasks, setTasks] = useState([])  // [{angle, task_id, error}]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Per-angle state: 'idle' | 'running' | 'ready' | 'failed'
  const [angleState, setAngleState] = useState({})
  const aspectRatio = a.orientation === 'horizontal' ? '16:9' : '9:16'

  const seedImage = a.hero_image_url || a.avatar_image_url

  const dispatch = async () => {
    setBusy(true); setError(null)
    set('angle_images', {})
    setAngleState({ hero: 'running', '45_left': 'running', '45_right': 'running', '90_left': 'running' })
    try {
      const r = await fetch('/api/avatars/looks/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          mode: 'angles',
          profile_id: profileId,
          aspect_ratio: aspectRatio,
          hero_image_url: seedImage,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error || `Angles dispatch failed (${r.status})`)
      setTasks(body.task_ids || [])
    } catch (e) {
      setError(e.message); setBusy(false)
    }
  }

  // Poll each task independently. As each finishes, fold the url into
  // angle_images and flip that angle's state to 'ready'. Modal advances
  // only when at least one is ready (user can save partial sets).
  useEffect(() => {
    if (!tasks.length) return
    let cancelled = false
    const starts = tasks.reduce((m, t) => ({ ...m, [t.angle]: Date.now() }), {})
    const pollOne = async (entry) => {
      if (cancelled || !entry.task_id) {
        setAngleState((s) => ({ ...s, [entry.angle]: 'failed' }))
        return
      }
      const tick = async () => {
        if (cancelled) return
        try {
          const r = await fetch(
            `/api/avatars/looks/poll-generation?task_id=${encodeURIComponent(entry.task_id)}&profile_id=${encodeURIComponent(profileId)}`,
            { headers: { Authorization: `Bearer ${token}` } },
          )
          const body = await r.json()
          if (cancelled) return
          if (body.state === 'ready' && body.url) {
            set('angle_images', { ...a.angle_images, [entry.angle]: body.url })
            setAngleState((s) => ({ ...s, [entry.angle]: 'ready' }))
            return
          }
          if (body.state === 'failed') {
            setAngleState((s) => ({ ...s, [entry.angle]: 'failed' }))
            return
          }
          if (Date.now() - starts[entry.angle] > POLL_TIMEOUT_MS) {
            setAngleState((s) => ({ ...s, [entry.angle]: 'failed' }))
            return
          }
          setTimeout(tick, POLL_INTERVAL_MS)
        } catch (e) {
          if (!cancelled) setAngleState((s) => ({ ...s, [entry.angle]: 'failed' }))
        }
      }
      tick()
    }
    tasks.forEach(pollOne)
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks])

  // Per-angle regenerate (single task only).
  const regenOne = async (angle) => {
    setError(null)
    setAngleState((s) => ({ ...s, [angle]: 'running' }))
    set('angle_images', { ...a.angle_images, [angle]: null })
    try {
      // Use the same /generate endpoint with a single-angle dispatch
      // pattern. Easiest: fire angles mode and pluck just this angle's
      // task_id; the others will run too but we ignore them. (Server
      // could be specialized later if cost matters.)
      // Simpler still: dispatch angles mode and let the existing
      // polling pick up only the requested angle.
      const r = await fetch('/api/avatars/looks/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          mode: 'angles', profile_id: profileId,
          aspect_ratio: aspectRatio,
          hero_image_url: seedImage,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error || `Regenerate failed (${r.status})`)
      const match = (body.task_ids || []).find((t) => t.angle === angle)
      if (!match?.task_id) throw new Error(`No task returned for ${angle}`)
      // Poll just this one.
      const startedAt = Date.now()
      const tick = async () => {
        const rr = await fetch(
          `/api/avatars/looks/poll-generation?task_id=${encodeURIComponent(match.task_id)}&profile_id=${encodeURIComponent(profileId)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        const bb = await rr.json()
        if (bb.state === 'ready' && bb.url) {
          set('angle_images', { ...a.angle_images, [angle]: bb.url })
          setAngleState((s) => ({ ...s, [angle]: 'ready' }))
          return
        }
        if (bb.state === 'failed' || Date.now() - startedAt > POLL_TIMEOUT_MS) {
          setAngleState((s) => ({ ...s, [angle]: 'failed' }))
          setError(bb.error || `${angle} regen timed out`)
          return
        }
        setTimeout(tick, POLL_INTERVAL_MS)
      }
      tick()
    } catch (e) {
      setError(e.message)
      setAngleState((s) => ({ ...s, [angle]: 'failed' }))
    }
  }

  const allDone = ['hero', '45_left', '45_right', '90_left'].every((k) => angleState[k] === 'ready' || angleState[k] === 'failed')

  return (
    <Section title="Review the 4 angles" hint="Hero + two 45° turns + a hard left profile. Each is independently regenerable — re-roll just the ones you don't like.">
      {error && <div style={errorPanel}><AlertCircle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />{error}</div>}
      {!tasks.length && !busy && (
        <button onClick={dispatch} className="btn-primary" style={{ padding: '12px 20px', fontSize: 14 }}>
          <Camera size={14} style={{ marginRight: 6, verticalAlign: -2 }} /> Generate 4 angles
        </button>
      )}
      {tasks.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          {['hero', '45_left', '45_right', '90_left'].map((angle) => {
            const url = a.angle_images[angle]
            const state = angleState[angle] || 'idle'
            return (
              <div key={angle} style={{
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 10, overflow: 'hidden',
              }}>
                <div style={{
                  aspectRatio: aspectRatio === '9:16' ? '9 / 16' : '16 / 9',
                  background: '#000', position: 'relative',
                }}>
                  {url ? (
                    <img src={url} alt={ANGLE_LABELS[angle]} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  ) : (
                    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
                      {state === 'failed' ? <AlertCircle size={20} color="var(--red)" /> : <Loader2 size={20} className="spin" />}
                    </div>
                  )}
                </div>
                <div style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ fontWeight: 700, fontSize: 12, flex: 1 }}>{ANGLE_LABELS[angle]}</div>
                  <button
                    onClick={() => regenOne(angle)}
                    disabled={state === 'running'}
                    className="btn-ghost"
                    style={{ padding: '4px 8px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    title="Regenerate this angle"
                  >
                    {state === 'running' ? <Loader2 size={11} className="spin" /> : <RotateCcw size={11} />} Regen
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}

function StepConfirm({ a }) {
  const count = a.mode === 'compose_only' ? (a.hero_image_url ? 1 : 0) : Object.values(a.angle_images).filter(Boolean).length
  return (
    <Section title="Save the look" hint="Cover photo = the first image. We'll train it on HeyGen V3 so it's ready to render the moment it appears in your avatar.">
      <div style={recapGrid}>
        <Recap label="Look name" value={a.name || '(unnamed)'} />
        <Recap label="Orientation" value={a.orientation} />
        <Recap label="Images" value={`${count} ${count === 1 ? 'image' : 'images'} ready to save`} />
        <Recap label="Mode" value={MODES.find((m) => m.id === a.mode)?.label || a.mode} />
      </div>
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────
// Image dropzone — drag-drop or click to pick. Auto-compresses
// anything >8MB so we stay under storage limits, then uploads
// directly to the avatar-media bucket and writes back the public URL.
// ─────────────────────────────────────────────────────────────────

function ImageDropzone({ url, profileId, onChange, optional }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const fileInput = useRef(null)

  const handle = async (file) => {
    if (!file) return
    setBusy(true); setErr(null)
    try {
      const compressed = await compressImageIfLarge(file, 8 * 1024 * 1024)
      const ext = (compressed.name?.split('.').pop() || 'jpg').toLowerCase()
      const path = `${profileId}/look-input/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const { error } = await supabase.storage.from('avatar-media').upload(path, compressed, {
        contentType: compressed.type || 'image/jpeg',
        upsert: false,
      })
      if (error) throw new Error(`Upload failed: ${error.message}`)
      const { data } = supabase.storage.from('avatar-media').getPublicUrl(path)
      onChange(data.publicUrl)
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (url) {
    return (
      <div style={{
        position: 'relative', display: 'inline-block',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, overflow: 'hidden', maxWidth: 280,
      }}>
        <img src={url} alt="Uploaded" style={{ width: '100%', height: 'auto', display: 'block', maxHeight: 280, objectFit: 'cover' }} />
        <button
          onClick={() => onChange('')}
          style={{
            position: 'absolute', top: 6, right: 6,
            background: 'rgba(0,0,0,0.7)', border: 'none', borderRadius: 6,
            color: '#fff', cursor: 'pointer', padding: 6,
          }}
          title="Remove"
        ><X size={12} /></button>
      </div>
    )
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        disabled={busy}
        style={{
          width: '100%', maxWidth: 480,
          padding: '24px 18px', borderRadius: 12,
          background: 'var(--surface)', border: '1.5px dashed var(--border)',
          cursor: busy ? 'wait' : 'pointer',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
          color: 'var(--muted)',
        }}
      >
        {busy ? <Loader2 size={20} className="spin" /> : <Upload size={20} />}
        <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>
          {busy ? 'Uploading…' : 'Click to upload'}
        </div>
        <div style={{ fontSize: 11.5 }}>JPG / PNG / WebP · auto-compresses if &gt; 8MB</div>
        {optional && <div style={{ fontSize: 11.5, fontStyle: 'italic' }}>Optional — skip with Next</div>}
      </button>
      <input
        ref={fileInput} type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handle(f); e.target.value = '' }}
      />
      {err && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>{err}</div>}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Tiny helpers + styles
// ─────────────────────────────────────────────────────────────────

function Section({ title, hint, children }) {
  // Flex column so step bodies fill the available height. Children
  // can scroll internally if they really need to, but each step
  // should be sized to fit so they don't.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <h2 style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.4, marginBottom: 4 }}>{title}</h2>
      {hint && <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 }}>{hint}</div>}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{children}</div>
    </div>
  )
}
function Recap({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.06, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, color: 'var(--text)' }}>{value}</div>
    </div>
  )
}

// Viewport-locked layout — same pattern as NewVideoModal. The whole
// modal is the page while it's open: header / body (flex:1, no inner
// scroll) / footer. Step bodies are sized to fit the available height
// so the user never scrolls inside the modal.
const overlayStyle = {
  position: 'fixed', inset: 0, zIndex: 260,
  background: 'var(--bg-base, #0a0a0c)',
  overflow: 'hidden',
  height: '100vh',
}
const cardStyle = {
  width: '100%',
  height: '100vh',
  background: 'transparent',
  display: 'flex', flexDirection: 'column',
}
const headerStyle = {
  padding: '18px 32px',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  borderBottom: '1px solid var(--border)',
  maxWidth: 1080,
  margin: '0 auto',
  width: '100%',
  boxSizing: 'border-box',
}
const brandIcon = {
  width: 30, height: 30, borderRadius: 8,
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', display: 'grid', placeItems: 'center',
}
const closeBtn = {
  background: 'transparent', border: 'none', cursor: 'pointer',
  color: 'var(--muted)', padding: 6, display: 'inline-flex', alignItems: 'center',
}
const bodyStyle = {
  padding: '24px 32px 18px',
  maxWidth: 1080,
  margin: '0 auto',
  width: '100%',
  boxSizing: 'border-box',
  flex: 1, minHeight: 0,
  overflow: 'hidden',
  display: 'flex', flexDirection: 'column',
}
const footerStyle = {
  padding: '16px 32px',
  borderTop: '1px solid var(--border)',
  display: 'flex', justifyContent: 'space-between',
  maxWidth: 1080,
  margin: '0 auto',
  width: '100%',
  boxSizing: 'border-box',
  background: 'var(--bg-base, #0a0a0c)',
  flexShrink: 0,
}
const errorPanel = {
  marginBottom: 14, padding: '10px 14px',
  background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.35)',
  borderRadius: 8, color: 'var(--red)', fontSize: 13,
}
const titleInput = {
  width: '100%', maxWidth: 480, padding: '12px 14px', fontSize: 15,
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 10, color: 'var(--text)', fontFamily: 'inherit',
  boxSizing: 'border-box',
}
const recapGrid = {
  display: 'grid', gap: 12,
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  borderRadius: 10, padding: 16,
}
