// Multi-step "new video" modal. Replaces the inline NewVideoForm with
// an onboarding-survey-style flow.
//
// Step sequence (some conditional on prior answers):
//   1. aspect       — landscape | vertical
//   2. use_avatar   — yes (use avatar on camera) | no (voice only)
//   3. avatar_pick  — pick avatar
//   4. look_pick    — pick look + randomize toggle (only if use_avatar=yes)
//   5. source       — topic prompt | paste script | upload voiceover
//   6. source_details — branches by step 5 choice (topic+length / script text /
//                       file picker)
//   7. template     — template cards + captions toggle + example overlay frame
//   8. music        — background music: off | loop one track | cycle all
//   9. confirm      — cost estimate + Generate
//
// On confirm we either:
//   - POST /api/studio/videos (topic + script paths) then fire
//     /api/studio/generate-map
//   - POST /api/studio/voiceover/upload + /voiceover/segment (upload path)
// and the parent dashboard navigates to the new video.

import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { authedFetch } from '../lib/authedFetch.js'
import { toast } from './Toast.jsx'
import { X, ChevronLeft, Sparkles, Loader2 } from 'lucide-react'

export default function NewVideoModal({ profileId, open, onClose, onCreated }) {
  const { session } = useAuth()
  const [stepIdx, setStepIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [avatars, setAvatars] = useState([])
  const [templates, setTemplates] = useState([])
  // Account-wide music library, loaded on first open. Feeds the
  // music step's track picker (loop_one mode) and the cycle preview.
  const [musicTracks, setMusicTracks] = useState([])

  // Single answers blob — same pattern as OnboardingSurvey.
  const [a, setA] = useState({
    aspect_ratio: '16:9',
    use_avatar: 'yes',           // 'yes' | 'no'
    avatar_id: '',
    look_id: '',
    randomize_look_images: false,
    source: 'topic',             // 'topic' | 'script' | 'voiceover'
    topic_prompt: '',
    target_duration_secs: 120,
    script_text: '',
    voiceover_file: null,
    template_id: 'sleek',
    captions_enabled: true,
    // Background music. 'off' | 'loop_one' | 'cycle_all'. When
    // loop_one, music_track_id points at a row from the user's
    // account music library. Volume is a 0..1 multiplier under voice.
    music_mode: 'off',
    music_track_id: '',
    music_volume: 0.12,
  })
  const set = (k, v) => setA((prev) => ({ ...prev, [k]: v }))

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // Load the overlay CSS stylesheets into the document <head> when the
  // modal first mounts. The template-preview step renders real .ov-card
  // markup, but those classes only ship in /studio-compositions/_ov-*.css
  // which the React SPA doesn't import. Injecting via <link> picks them
  // up live without rebuilding the bundle. Idempotent — checks by href
  // so repeated opens don't create duplicates.
  useEffect(() => {
    if (!open) return
    const sheets = [
      '/studio-compositions/_ov-tokens.css',
      '/studio-compositions/_ov-universal.css',
    ]
    const added = []
    for (const href of sheets) {
      if (document.querySelector(`link[href="${href}"]`)) continue
      const l = document.createElement('link')
      l.rel = 'stylesheet'
      l.href = href
      document.head.appendChild(l)
      added.push(l)
    }
    return () => {
      // Leave the stylesheets in place between modal opens — removing
      // them would re-load (and flicker) the next time. They're tiny
      // and scoped (.ov-* / .tokens-*) so they don't conflict with
      // anything else.
    }
  }, [open])

  // Reset state when opening fresh.
  useEffect(() => {
    if (!open) { setStepIdx(0); setError(null) }
  }, [open])

  // Load avatars + templates + music library on first open. Music
  // tracks come from /api/account/music-tracks (user-scoped library
  // managed on the Profiles page).
  useEffect(() => {
    if (!open || !session?.access_token || !profileId) return
    let cancelled = false
    ;(async () => {
      try {
        const [aRes, tRes, mRes] = await Promise.all([
          authedFetch(`/api/avatars?profile_id=${profileId}`, session.access_token),
          authedFetch('/api/studio/templates', session.access_token),
          authedFetch('/api/account/music-tracks', session.access_token),
        ])
        const aBody = aRes.ok ? await aRes.json() : { avatars: [] }
        const tBody = tRes.ok ? await tRes.json() : { templates: [] }
        const mBody = mRes.ok ? await mRes.json() : { tracks: [] }
        if (cancelled) return
        setAvatars(aBody.avatars || [])
        setTemplates(tBody.templates || [])
        setMusicTracks(Array.isArray(mBody.tracks) ? mBody.tracks : [])
        // Default-select the first avatar so users don't see an empty picker.
        if ((aBody.avatars || []).length && !a.avatar_id) {
          set('avatar_id', aBody.avatars[0].id)
        }
      } catch { /* leave empty */ }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profileId, session?.access_token])

  // Conditional step list. Re-computed on every answer change so back/
  // forward feels natural regardless of which fork the user is on.
  const steps = useMemo(() => {
    const list = ['aspect', 'use_avatar', 'avatar_pick']
    if (a.use_avatar === 'yes') list.push('look_pick')
    list.push('source', 'source_details', 'template', 'music', 'confirm')
    return list
  }, [a.use_avatar])

  const step = steps[stepIdx] || 'confirm'

  const canProceed = () => {
    if (step === 'aspect') return !!a.aspect_ratio
    if (step === 'use_avatar') return a.use_avatar === 'yes' || a.use_avatar === 'no'
    if (step === 'avatar_pick') return !!a.avatar_id
    if (step === 'look_pick') return true  // look optional (we'll default to first matching)
    if (step === 'source') return true
    if (step === 'source_details') {
      if (a.source === 'topic') return !!a.topic_prompt.trim()
      if (a.source === 'script') return a.script_text.trim().length > 20
      if (a.source === 'voiceover') return !!a.voiceover_file
    }
    if (step === 'template') return !!a.template_id
    if (step === 'music') {
      // Must pick a track when looping one. Off + cycle_all are
      // self-explanatory and need no further choice.
      if (a.music_mode === 'loop_one') return !!a.music_track_id
      return true
    }
    return true
  }

  const next = () => {
    setError(null)
    if (stepIdx < steps.length - 1) setStepIdx(stepIdx + 1)
    else submit()
  }
  const back = () => { if (stepIdx > 0) setStepIdx(stepIdx - 1) }

  const selectedAvatar = avatars.find((x) => x.id === a.avatar_id)

  const submit = async () => {
    if (!session?.access_token) return
    setBusy(true); setError(null)
    try {
      const resolvedVoiceId = selectedAvatar?.effective_voice_id || selectedAvatar?.elevenlabs_voice_id || null

      // ── Voiceover upload path ────────────────────────────────
      if (a.source === 'voiceover') {
        const file = a.voiceover_file
        // Some browsers leave file.type empty for audio types (especially
        // .m4a / .wav from older OSes). Best-effort fall back to a MIME
        // we know the server accepts; the server's regex doesn't care
        // about the exact bytes, only the declared content type.
        const inferredType = file.type || guessMimeFromName(file.name) || 'audio/mpeg'
        const initR = await authedFetch(
          '/api/studio/voiceover/upload?mode=init', session.access_token,
          { method: 'POST', body: JSON.stringify({ profile_id: profileId, filename: file.name, content_type: inferredType }) },
        )
        const initBody = await initR.json()
        if (!initR.ok) throw new Error(initBody.error || 'Upload init failed')
        const putR = await fetch(initBody.signed_url, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${initBody.token}`, 'Content-Type': initBody.content_type, 'x-upsert': 'true' },
          body: file,
        })
        if (!putR.ok) {
          // Surface Supabase's actual error message so 400s are
          // debuggable instead of opaque ("Storage upload 400").
          const detail = await putR.text().catch(() => '')
          throw new Error(`Storage upload ${putR.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
        }
        const finR = await authedFetch(
          '/api/studio/voiceover/upload?mode=finalize', session.access_token,
          { method: 'POST', body: JSON.stringify({ profile_id: profileId, path: initBody.path }) },
        )
        const finBody = await finR.json()
        if (!finR.ok) throw new Error(finBody.error || 'Finalize failed')
        toast({ message: 'Voiceover uploaded. Transcribing + segmenting…', kind: 'info' })
        const segR = await authedFetch(
          '/api/studio/voiceover/segment', session.access_token,
          { method: 'POST', body: JSON.stringify({
            profile_id: profileId,
            voiceover_url: finBody.voiceover_url,
            avatar_id: a.use_avatar === 'yes' ? a.avatar_id : null,
            look_id: a.use_avatar === 'yes' ? a.look_id || null : null,
            voice_id: resolvedVoiceId,
            aspect_ratio: a.aspect_ratio,
            template_id: a.template_id,
            captions_enabled: a.captions_enabled,
            randomize_look_images: a.use_avatar === 'yes' ? !!a.randomize_look_images : false,
            music_mode: a.music_mode || 'off',
            music_track_id: a.music_mode === 'loop_one' ? (a.music_track_id || null) : null,
            music_volume: Number(a.music_volume) || 0.12,
          }) },
        )
        const segBody = await segR.json()
        if (!segR.ok) throw new Error(segBody.error || 'Segmentation failed')
        toast({ message: `Created ${segBody.segments?.length || 0} segments.`, kind: 'success' })
        onCreated?.(segBody.video)
        return
      }

      // ── Topic / script path ──────────────────────────────────
      const body = {
        profile_id: profileId,
        topic_prompt: a.source === 'topic' ? a.topic_prompt.trim() : a.script_text.trim().slice(0, 2000),
        // Pass full script text through a separate field when source=script
        // so the segmenter can use it verbatim instead of treating it as a prompt.
        ...(a.source === 'script' ? { fixed_script: a.script_text.trim() } : {}),
        avatar_id: a.use_avatar === 'yes' ? a.avatar_id : a.avatar_id,  // always send; voice-only still uses it
        look_id: a.use_avatar === 'yes' ? (a.look_id || null) : null,
        voice_id: resolvedVoiceId,
        target_duration_secs: a.source === 'topic'
          ? Number(a.target_duration_secs) || 120
          : Math.max(30, Math.round(estimateScriptDuration(a.script_text))),
        aspect_ratio: a.aspect_ratio,
        template_id: a.template_id,
        captions_enabled: a.captions_enabled,
        overlays_enabled: true,
        motion_graphics_enabled: true,
        randomize_look_images: a.use_avatar === 'yes' ? !!a.randomize_look_images : false,
        music_mode: a.music_mode || 'off',
        music_track_id: a.music_mode === 'loop_one' ? (a.music_track_id || null) : null,
        music_volume: Number(a.music_volume) || 0.12,
      }
      const r = await authedFetch('/api/studio/videos', session.access_token, {
        method: 'POST', body: JSON.stringify(body),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Could not create video')
      toast({ message: 'Draft created. Generating the video map…', kind: 'success' })
      authedFetch('/api/studio/generate-map', session.access_token, {
        method: 'POST', body: JSON.stringify({ studio_video_id: data.video.id }),
      }).catch(() => { /* surfaces on the per-video page */ })
      onCreated?.(data.video)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  const progressPct = ((stepIdx + 1) / steps.length) * 100

  return (
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div style={cardStyle}>
        <div style={progressTrack}><div style={{ ...progressFill, width: `${progressPct}%` }} /></div>
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={brandIcon}><Sparkles size={16} /></div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>New video</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: 0.06 }}>
                STEP {stepIdx + 1} OF {steps.length}
              </div>
            </div>
          </div>
          <button onClick={onClose} style={closeBtn} aria-label="Close"><X size={18} /></button>
        </div>

        <div style={bodyStyle}>
          {error && <div style={errorPanel}>{error}</div>}

          {step === 'aspect' && (
            <StepAspect value={a.aspect_ratio} onChange={(v) => set('aspect_ratio', v)} />
          )}
          {step === 'use_avatar' && (
            <StepUseAvatar value={a.use_avatar} onChange={(v) => set('use_avatar', v)} />
          )}
          {step === 'avatar_pick' && (
            <StepAvatarPick
              avatars={avatars}
              voiceOnly={a.use_avatar === 'no'}
              value={a.avatar_id}
              onChange={(v) => { set('avatar_id', v); set('look_id', '') }}
            />
          )}
          {step === 'look_pick' && (
            <StepLookPick
              avatar={selectedAvatar}
              aspectRatio={a.aspect_ratio}
              value={a.look_id}
              randomize={a.randomize_look_images}
              onChange={(v) => set('look_id', v)}
              onRandomize={(v) => set('randomize_look_images', v)}
            />
          )}
          {step === 'source' && (
            <StepSource value={a.source} onChange={(v) => set('source', v)} />
          )}
          {step === 'source_details' && (
            <StepSourceDetails
              source={a.source}
              answers={a}
              setAnswer={set}
            />
          )}
          {step === 'template' && (
            <StepTemplate
              templates={templates}
              value={a.template_id}
              captionsEnabled={a.captions_enabled}
              aspectRatio={a.aspect_ratio}
              onChange={(v) => set('template_id', v)}
              onCaptions={(v) => set('captions_enabled', v)}
            />
          )}
          {step === 'music' && (
            <StepMusic
              tracks={musicTracks}
              mode={a.music_mode}
              trackId={a.music_track_id}
              volume={a.music_volume}
              onMode={(v) => set('music_mode', v)}
              onTrack={(v) => set('music_track_id', v)}
              onVolume={(v) => set('music_volume', v)}
            />
          )}
          {step === 'confirm' && (
            <StepConfirm
              profileId={profileId}
              answers={a}
              templates={templates}
              musicTracks={musicTracks}
            />
          )}
        </div>

        <div style={footerStyle}>
          <button onClick={back} disabled={stepIdx === 0 || busy} className="btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <ChevronLeft size={14} /> Back
          </button>
          <button onClick={next} disabled={!canProceed() || busy} className="btn-primary" style={{ minWidth: 140 }}>
            {busy ? <Loader2 size={14} className="spin" /> : null}
            {step === 'confirm' ? (busy ? 'Generating…' : 'Generate') : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Step components ──────────────────────────────────────────────────

function StepAspect({ value, onChange }) {
  return (
    <Section title="What's the video shape?" hint="Pick the aspect ratio you'll publish to.">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        {[
          { v: '16:9', label: 'Horizontal · 16:9', hint: 'YouTube, web embeds' },
          { v: '9:16', label: 'Vertical · 9:16',   hint: 'TikTok, Reels, Shorts' },
          { v: '1:1',  label: 'Square · 1:1',      hint: 'Feed posts' },
        ].map((opt) => (
          <OptionCard key={opt.v} active={value === opt.v} onClick={() => onChange(opt.v)}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{opt.label}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{opt.hint}</div>
          </OptionCard>
        ))}
      </div>
    </Section>
  )
}

function StepUseAvatar({ value, onChange }) {
  return (
    <Section title="Will you use an AI avatar?" hint="If yes, the avatar speaks on camera. If no, we only use the voice attached to the avatar.">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <OptionCard active={value === 'yes'} onClick={() => onChange('yes')}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Yes — avatar on camera</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>HeyGen renders the avatar talking. You can also upload your own avatar clips later.</div>
        </OptionCard>
        <OptionCard active={value === 'no'} onClick={() => onChange('no')}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>No — voice only</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Voiceover plays over motion graphics + B-roll. We use the voice attached to the chosen avatar.</div>
        </OptionCard>
      </div>
    </Section>
  )
}

function StepAvatarPick({ avatars, voiceOnly, value, onChange }) {
  return (
    <Section
      title={voiceOnly ? 'Pick the voice' : 'Pick an avatar'}
      hint={voiceOnly
        ? "Only the voice attached to this avatar will be used. Look doesn't matter for voice-only videos."
        : 'Choose which avatar will speak on camera. Look comes next.'}
    >
      {avatars.length === 0 ? (
        <div style={emptyPanel}>No avatars yet. Create one on the Avatars page first.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
          {avatars.map((av) => {
            const thumb = av.looks?.[0]?.images?.[0]?.image_url
            return (
              <OptionCard key={av.id} active={value === av.id} onClick={() => onChange(av.id)} style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ aspectRatio: '3/4', background: 'var(--surface-2)' }}>
                  {thumb && <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
                </div>
                <div style={{ padding: '8px 10px', fontWeight: 700, fontSize: 13 }}>{av.name || av.id.slice(0, 6)}</div>
              </OptionCard>
            )
          })}
        </div>
      )}
    </Section>
  )
}

function StepLookPick({ avatar, aspectRatio, value, randomize, onChange, onRandomize }) {
  const looks = avatar?.looks || []
  const desired = aspectRatio === '9:16' ? 'portrait' : aspectRatio === '16:9' ? 'landscape' : null
  const filtered = desired ? looks.filter((l) => !l.orientation || l.orientation === desired) : looks
  const visible = filtered.length ? filtered : looks

  return (
    <Section title="Pick a look" hint={`Looks for ${avatar?.name || 'this avatar'} that match your chosen aspect ratio.`}>
      {visible.length === 0 ? (
        <div style={emptyPanel}>No looks for this avatar match your aspect ratio. Add one on the Avatars page.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10 }}>
          {visible.map((look, i) => {
            const thumb = look.images?.[0]?.image_url
            return (
              <OptionCard key={look.id} active={value === look.id} onClick={() => onChange(look.id)} style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ aspectRatio: desired === 'landscape' ? '16/9' : '3/4', background: 'var(--surface-2)' }}>
                  {thumb && <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
                </div>
                <div style={{ padding: '6px 8px', fontWeight: 700, fontSize: 12 }}>{look.name || `Look ${i + 1}`}</div>
              </OptionCard>
            )
          })}
        </div>
      )}
      <div style={{ marginTop: 14, padding: 14, background: 'var(--surface-2)', borderRadius: 10, border: '1px solid var(--border)' }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={randomize} onChange={(e) => onRandomize(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            <div style={{ fontWeight: 700, fontSize: 13 }}>Randomize images across segments</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Each avatar segment uses a different image from this look — adds variety so the video doesn't feel like one static shot.
            </div>
          </span>
        </label>
      </div>
    </Section>
  )
}

function StepSource({ value, onChange }) {
  return (
    <Section title="Where's the script coming from?" hint="Pick how you want to give us the content.">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        <OptionCard active={value === 'topic'} onClick={() => onChange('topic')}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>AI-generated from a topic</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Describe what the video is about. Claude writes it in your brand voice.</div>
        </OptionCard>
        <OptionCard active={value === 'script'} onClick={() => onChange('script')}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Paste my own script</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Use the script verbatim. We split it into sections and estimate length.</div>
        </OptionCard>
        <OptionCard active={value === 'voiceover'} onClick={() => onChange('voiceover')}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Upload my own voiceover</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>MP3 / WAV. We transcribe, split into beats, pick visuals.</div>
        </OptionCard>
      </div>
    </Section>
  )
}

function StepSourceDetails({ source, answers, setAnswer }) {
  if (source === 'topic') {
    return (
      <Section title="What's the video about?" hint="One or two sentences. Claude uses your brand voice from your profile.">
        <textarea
          className="input" rows={4}
          placeholder="A 90-second explainer on why faceless creators are out-shipping personal brands in 2026."
          value={answers.topic_prompt}
          onChange={(e) => setAnswer('topic_prompt', e.target.value)}
          maxLength={2000}
        />
        <div style={{ marginTop: 16 }}>
          <Label>
            Length: {Math.floor(answers.target_duration_secs / 60)}m {String(answers.target_duration_secs % 60).padStart(2, '0')}s
            ({answers.target_duration_secs}s)
          </Label>
          <input
            type="number"
            className="input"
            min={30}
            step={15}
            value={answers.target_duration_secs}
            onChange={(e) => setAnswer('target_duration_secs', Math.max(30, Number(e.target.value) || 30))}
            style={{ width: 140 }}
          />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
            Type any target length in seconds. 30s minimum, no upper cap — set whatever the script needs.
          </div>
        </div>
      </Section>
    )
  }
  if (source === 'script') {
    const est = estimateScriptDuration(answers.script_text)
    return (
      <Section title="Paste your script" hint="We'll use it verbatim and break into sections.">
        <textarea
          className="input" rows={9}
          placeholder="Paste the full script you want spoken. We'll break it into segments and estimate duration at ~150 words per minute."
          value={answers.script_text}
          onChange={(e) => setAnswer('script_text', e.target.value)}
          maxLength={10000}
        />
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
          {answers.script_text.trim().split(/\s+/).filter(Boolean).length} words · est. {Math.floor(est / 60)}m {String(Math.round(est % 60)).padStart(2, '0')}s
        </div>
      </Section>
    )
  }
  return (
    <Section title="Upload your voiceover" hint="MP3, WAV, M4A, AAC, OGG, or FLAC. Up to ~30 minutes.">
      <input
        type="file"
        accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/x-m4a,audio/mp4,audio/aac,audio/ogg,audio/flac"
        onChange={(e) => setAnswer('voiceover_file', e.target.files?.[0] || null)}
        style={{ width: '100%', padding: 12, background: 'var(--surface-2)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-soft)', fontSize: 12 }}
      />
      {answers.voiceover_file && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
          {answers.voiceover_file.name} · {(answers.voiceover_file.size / 1024 / 1024).toFixed(1)} MB
        </div>
      )}
    </Section>
  )
}

function StepTemplate({ templates, value, captionsEnabled, aspectRatio, onChange, onCaptions }) {
  const selected = templates.find((t) => t.id === value)
  // Sample background for the example screens — drop the right image
  // at /studio-compositions/sample-avatar.jpg and it shows here.
  const sampleSrc = '/studio-compositions/sample-avatar.jpg'
  const frameAspect = aspectRatio === '9:16' ? '9 / 16' : aspectRatio === '1:1' ? '1 / 1' : '16 / 9'
  return (
    <Section title="Visual template" hint="Background pattern, typography, motion graphics, and pacing all cascade from here.">
      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {templates.map((t) => (
            <OptionCard key={t.id} active={value === t.id} onClick={() => onChange(t.id)}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{t.name}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.45 }}>{t.description}</div>
            </OptionCard>
          ))}
        </div>
        <div style={{ position: 'relative', aspectRatio: frameAspect, background: '#000', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)' }}>
          <img src={sampleSrc} alt="Example background" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { e.currentTarget.style.display = 'none' }} />
          {/* Live overlay cards — CSS classes match the bake exactly,
              so what shows here is byte-for-byte what the render
              produces. Positioning + sizing comes entirely from
              _ov-universal.css's .ov.<zone> rules; no inline styles
              needed beyond the absolute-fill wrapper. */}
          <div className={`tokens-${selected?.id || 'sleek'}`} style={{ position: 'absolute', inset: 0 }}>
            <div className="overlay-layer">
              <div className="ov left_overlay">
                <div className="ov-chapter"><div className="title">Faceless <em>Shift</em></div></div>
              </div>
              <div className="ov right_overlay">
                <div className="ov-stat">
                  <div className="label">POSTS / DAY</div>
                  <div className="number">3<span className="unit">x</span></div>
                  <div className="sub">Faceless</div>
                </div>
              </div>
              <div className="ov lower-third">
                <div className="ov-caption"><div className="text">Faceless creators are <span className="highlight">outshipping</span> personal brands in 2026.</div></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 14, padding: 12, background: 'var(--surface-2)', borderRadius: 8, border: '1px solid var(--border)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={captionsEnabled} onChange={(e) => onCaptions(e.target.checked)} />
          <span>Captions on — burned-in subtitles with one highlighted word per phrase.</span>
        </label>
      </div>
    </Section>
  )
}

function StepMusic({ tracks, mode, trackId, volume, onMode, onTrack, onVolume }) {
  const selectedTrack = tracks.find((t) => t.id === trackId)
  return (
    <Section
      title="Background music?"
      hint="Plays under the voiceover. Auto fade-in (1.5s) + fade-out (2s). Pulls from your account music library — manage tracks on the Profiles page."
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        {[
          { v: 'off',        title: 'No music',          hint: 'Voiceover only.' },
          { v: 'loop_one',   title: 'Loop one song',     hint: 'Pick one track. It loops for the whole video.' },
          { v: 'cycle_all',  title: 'Cycle all songs',   hint: 'Play every track in your library, in order. Loops if the video runs past the playlist.' },
        ].map((opt) => (
          <OptionCard key={opt.v} active={mode === opt.v} onClick={() => onMode(opt.v)}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{opt.title}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{opt.hint}</div>
          </OptionCard>
        ))}
      </div>

      {/* Per-mode follow-ups: track picker for loop_one, playlist
          preview for cycle_all. */}
      {mode === 'loop_one' && (
        <div style={{ marginTop: 18 }}>
          <Label>Track</Label>
          {tracks.length === 0 ? (
            <div style={emptyPanel}>
              No tracks in your library yet. Add some on the Profiles page → Music tracks.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
              {tracks.map((t) => (
                <OptionCard key={t.id} active={trackId === t.id} onClick={() => onTrack(t.id)}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{t.name || t.id}</div>
                  {t.url && (
                    <audio
                      controls
                      src={t.url}
                      onClick={(e) => e.stopPropagation()}
                      style={{ width: '100%', marginTop: 8, height: 28 }}
                    />
                  )}
                </OptionCard>
              ))}
            </div>
          )}
          {selectedTrack && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
              Selected: {selectedTrack.name || selectedTrack.id}
            </div>
          )}
        </div>
      )}

      {mode === 'cycle_all' && (
        <div style={{ marginTop: 18 }}>
          <Label>Playlist preview</Label>
          {tracks.length === 0 ? (
            <div style={emptyPanel}>
              No tracks in your library yet. Add some on the Profiles page → Music tracks.
            </div>
          ) : (
            <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 12, color: 'var(--text-soft)', lineHeight: 1.7 }}>
              {tracks.map((t, i) => (
                <div key={t.id}>{i + 1}. {t.name || t.id}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Volume picker — three sensible presets keep the UI focused.
          Power users who want a custom value can tweak music_volume
          via the row directly later. */}
      {mode !== 'off' && (
        <div style={{ marginTop: 18 }}>
          <Label>Volume under voice</Label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {[
              { v: 0.08, label: 'Subtle',         hint: 'Barely there. Voice clearly dominates.' },
              { v: 0.12, label: 'Low (default)',  hint: 'Standard YouTube tutorial mix.' },
              { v: 0.18, label: 'Prominent',      hint: 'Music is felt, voice still leads.' },
            ].map((opt) => (
              <OptionCard
                key={opt.v}
                active={Math.abs(Number(volume) - opt.v) < 0.005}
                onClick={() => onVolume(opt.v)}
              >
                <div style={{ fontWeight: 700, fontSize: 13 }}>{opt.label}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{opt.hint}</div>
              </OptionCard>
            ))}
          </div>
        </div>
      )}
    </Section>
  )
}

function StepConfirm({ profileId, answers, templates, musicTracks = [] }) {
  const { session } = useAuth()
  const [estimate, setEstimate] = useState(null)
  const tmpl = templates.find((t) => t.id === answers.template_id)
  const dur = answers.source === 'topic'
    ? answers.target_duration_secs
    : answers.source === 'script'
      ? Math.round(estimateScriptDuration(answers.script_text))
      : null  // voiceover length only known after transcription

  useEffect(() => {
    if (!session?.access_token) return
    let cancelled = false
    authedFetch('/api/studio/estimate-cost', session.access_token, {
      method: 'POST', body: JSON.stringify({
        profile_id: profileId,
        target_duration_secs: dur || 60,
        has_avatar: answers.use_avatar === 'yes',
      }),
    }).then((r) => r.ok ? r.json() : null).then((d) => { if (!cancelled) setEstimate(d) }).catch(() => {})
    return () => { cancelled = true }
  }, [session?.access_token, profileId, dur, answers.use_avatar])

  return (
    <Section title="Ready to generate?" hint="Quick recap and the estimated cost. You can still tweak segments after generation.">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 13 }}>
        <Recap label="Aspect" value={answers.aspect_ratio} />
        <Recap label="Avatar" value={answers.use_avatar === 'yes' ? 'On camera' : 'Voice only'} />
        <Recap label="Source" value={answers.source === 'topic' ? 'Topic → AI' : answers.source === 'script' ? 'Pasted script' : 'Uploaded voiceover'} />
        <Recap label="Template" value={tmpl?.name || answers.template_id} />
        <Recap label="Length" value={dur != null ? `~${dur}s` : 'Set by voiceover'} />
        <Recap label="Captions" value={answers.captions_enabled ? 'On' : 'Off'} />
        <Recap
          label="Music"
          value={answers.music_mode === 'off'
            ? 'Off'
            : answers.music_mode === 'loop_one'
              ? `Loop · ${musicTracks.find((t) => t.id === answers.music_track_id)?.name || 'unset'}`
              : `Cycle all (${musicTracks.length})`}
        />
      </div>
      {estimate ? (
        <div style={{ marginTop: 14, padding: 12, background: 'var(--surface-2)', borderRadius: 8, border: '1px solid var(--border)', fontSize: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Estimated cost</div>
          {estimate.cost && Object.entries(estimate.cost).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
              <span style={{ color: 'var(--muted)' }}>{k}</span>
              <span>{typeof v === 'object' ? `${v.low}–${v.high}` : v}</span>
            </div>
          ))}
          {!estimate.sufficient && (
            <div style={{ marginTop: 8, color: 'var(--red)' }}>Not enough credits — top up or shorten the video.</div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 14, fontSize: 12, color: 'var(--muted)' }}>Estimating cost…</div>
      )}
    </Section>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────

function estimateScriptDuration(text) {
  const wpm = 150  // average voiceover pace
  const words = (text || '').trim().split(/\s+/).filter(Boolean).length
  return (words / wpm) * 60
}

// Browser-detected file.type is sometimes empty for older audio
// formats (especially .m4a / .wav from older OS combinations).
// Map extensions → MIME so the server-side validator accepts the
// upload init.
function guessMimeFromName(name = '') {
  const ext = name.toLowerCase().split('.').pop()
  switch (ext) {
    case 'mp3':  return 'audio/mpeg'
    case 'wav':  return 'audio/wav'
    case 'm4a':  return 'audio/x-m4a'
    case 'mp4':  return 'audio/mp4'
    case 'aac':  return 'audio/aac'
    case 'ogg':  return 'audio/ogg'
    case 'flac': return 'audio/flac'
    default:     return null
  }
}

function Section({ title, hint, children }) {
  return (
    <div>
      <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.4, marginBottom: 6 }}>{title}</h2>
      {hint && <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18, lineHeight: 1.5 }}>{hint}</div>}
      {children}
    </div>
  )
}

function OptionCard({ active, onClick, children, style }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: 'relative',
        padding: '14px 14px 12px',
        background: active ? 'rgba(239,68,68,0.10)' : 'var(--surface-2)',
        border: active ? '1px solid rgba(239,68,68,0.45)' : '1px solid var(--border)',
        borderRadius: 10, cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
        transition: 'all 0.12s ease',
        ...style,
      }}
    >
      {children}
    </button>
  )
}

function Label({ children }) {
  return <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', letterSpacing: 0.08, textTransform: 'uppercase', marginBottom: 6 }}>{children}</div>
}

function Recap({ label, value }) {
  return (
    <div style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8, border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: 0.1, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  )
}

// ── Styles ───────────────────────────────────────────────────────────

// Full-page modal — no card chrome, no surrounding dim layer. The
// modal IS the page while it's open: solid background, edge-to-edge,
// content centered in a wide column that still scrolls naturally.
const overlayStyle = {
  position: 'fixed', inset: 0, zIndex: 250,
  background: 'var(--bg-base, #0a0a0c)',
  overflowY: 'auto',
}
const cardStyle = {
  // No max-width card — just a centered content column. The modal
  // reads as a normal page rather than a popover.
  width: '100%',
  minHeight: '100vh',
  background: 'transparent',
  display: 'flex', flexDirection: 'column',
}
const progressTrack = { height: 3, background: 'var(--surface-2)' }
const progressFill = {
  height: 3, background: 'linear-gradient(90deg, var(--red), var(--red-dark))',
  transition: 'width 0.25s ease',
}
const headerStyle = {
  padding: '20px 32px',
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
  padding: '40px 32px 24px',
  maxWidth: 1080,
  margin: '0 auto',
  width: '100%',
  boxSizing: 'border-box',
  flex: 1,
}
const footerStyle = {
  padding: '20px 32px 28px',
  borderTop: '1px solid var(--border)',
  display: 'flex', justifyContent: 'space-between',
  maxWidth: 1080,
  margin: '0 auto',
  width: '100%',
  boxSizing: 'border-box',
  // Stick footer at the bottom of the page so the action buttons
  // are always reachable. position:sticky inside an overflow:auto
  // overlay does the right thing on long step bodies.
  position: 'sticky',
  bottom: 0,
  background: 'var(--bg-base, #0a0a0c)',
  zIndex: 1,
}
const errorPanel = {
  marginBottom: 14, padding: '10px 14px',
  background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.35)',
  borderRadius: 8, color: 'var(--red)', fontSize: 13,
}
const emptyPanel = {
  padding: 18, textAlign: 'center', background: 'var(--surface-2)',
  border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--muted)', fontSize: 13,
}
