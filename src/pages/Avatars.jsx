import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus, Upload, X, UserCircle2, Sparkles, Video, AlertCircle, CheckCircle2,
  RefreshCw, Trash2, Wand2, Image as ImageIcon, ArrowLeft, Play,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { useCredits } from '../context/CreditsContext.jsx'
import { supabase } from '../lib/supabase.js'

// Upload a File directly to Supabase Storage (avatar-media bucket) and return
// the public URL. Bypasses Vercel's ~4.5MB request body limit entirely.
async function uploadToStorage(file, profileId) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
  const path = `${profileId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const { error } = await supabase.storage.from('avatar-media').upload(path, file, {
    contentType: file.type || 'image/jpeg',
    upsert: false,
  })
  if (error) throw new Error(`Storage upload failed: ${error.message}`)
  const { data } = supabase.storage.from('avatar-media').getPublicUrl(path)
  return data.publicUrl
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
const fmtUsd = (cents) => `$${(Number(cents) / 100).toFixed(2)}`
const fmtSeconds = (s) => `${Math.round(s)}s`

// (data-URL helper removed — we now upload to Storage directly)

function estimateDurationSecs(text) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean).length
  return Math.max(3, Math.round(words / 2.5))
}

// ─────────────────────────────────────────────────────────────────────────────
// Model picker — used in create wizard + render composer
function ModelPicker({ models, value, onChange, durationSecs }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
      {Object.entries(models || {}).map(([key, m]) => {
        const active = value === key
        const totalCents = (m.cents_per_sec || 0) * (durationSecs || 30)
        const totalUnits = Math.max(1, Math.ceil((m.video_units_per_sec || 0) * (durationSecs || 30)))
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            style={{
              textAlign: 'left',
              padding: '14px 16px',
              background: active
                ? 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(185,28,28,0.10))'
                : 'var(--surface-2)',
              border: active ? '1px solid rgba(239,68,68,0.45)' : '1px solid var(--border)',
              borderRadius: 12,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              position: 'relative',
            }}
          >
            {m.badge && (
              <div style={{
                position: 'absolute', top: -10, right: 14,
                background: active ? 'linear-gradient(135deg, var(--red), var(--red-dark))' : 'var(--surface-3)',
                color: active ? '#fff' : 'var(--muted)',
                fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                textTransform: 'uppercase', padding: '3px 8px', borderRadius: 999,
              }}>{m.badge}</div>
            )}
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>
              {m.label}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
              {m.description}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, gap: 8 }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-soft)' }}>
                <strong style={{ color: 'var(--text)', fontFamily: 'var(--font-display)' }}>
                  ${(m.cents_per_sec / 100).toFixed(2)}
                </strong>
                <span style={{ color: 'var(--muted)' }}>/sec</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                ~{fmtUsd(totalCents)} for {fmtSeconds(durationSecs || 30)}
              </div>
            </div>
            <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--red)', fontFamily: 'var(--font-display)', fontWeight: 600 }}>
              {totalUnits} video unit{totalUnits === 1 ? '' : 's'} per render
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Create avatar modal (upload photo)
function CreateAvatarModal({ profileId, models, onClose, onCreated }) {
  const { session } = useAuth()
  const [name, setName] = useState('')
  const [model, setModel] = useState('v4')
  const [photoFile, setPhotoFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Revoke object URL when the modal unmounts.
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [])
  // (We intentionally don't depend on previewUrl — the swap-revoke happens in onFile.)

  const onFile = async (file) => {
    if (!file) return
    if (file.size > 10 * 1024 * 1024) {
      setError('Image must be under 10MB.')
      return
    }
    setError(null)
    setPhotoFile(file)
    // Revoke any previous object URL before creating a new one (avoid memory leak).
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(URL.createObjectURL(file))
  }

  const create = async () => {
    if (!name.trim() || !photoFile) return
    setBusy(true); setError(null)
    try {
      // 1. Upload the binary directly to Supabase Storage (no Vercel size cap).
      const photoUrl = await uploadToStorage(photoFile, profileId)
      // 2. Hand the URL to our API; HeyGen mints a talking_photo from it.
      const r = await fetch('/api/avatars/upload-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          profile_id: profileId,
          name: name.trim(),
          model_version: model,
          photo_url: photoUrl,
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error || `Upload failed (${r.status})`)
      onCreated(body.avatar, body.training_error)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-lg" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, var(--red), var(--red-dark))', color: '#fff', display: 'grid', placeItems: 'center', marginRight: 12 }}>
            <UserCircle2 size={18} />
          </div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, flex: 1 }}>Create avatar</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={20} /></button>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label className="label">Avatar name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Ray (talking head)" autoFocus />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label className="label">Reference photo</label>
          {previewUrl ? (
            <div style={{ position: 'relative', display: 'inline-block', marginBottom: 6 }}>
              <img src={previewUrl} alt="preview" style={{ width: 160, height: 160, objectFit: 'cover', borderRadius: 12, border: '1px solid var(--border)' }} />
              <button
                onClick={() => { setPhotoFile(null); setPreviewUrl(null) }}
                style={{ position: 'absolute', top: 6, right: 6, width: 26, height: 26, borderRadius: '50%', background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none', cursor: 'pointer', display: 'grid', placeItems: 'center' }}
                title="Remove"
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <label style={{
              display: 'block', cursor: 'pointer',
              padding: 30, textAlign: 'center',
              background: 'var(--surface-2)', border: '2px dashed var(--border)', borderRadius: 12,
            }}>
              <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => onFile(e.target.files?.[0])} />
              <ImageIcon size={26} style={{ color: 'var(--muted)', marginBottom: 10 }} />
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, color: 'var(--text)', marginBottom: 4 }}>
                Click or drop a photo
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                JPG / PNG / WebP, max 10MB. Single face, well-lit, looking at the camera works best.
              </div>
            </label>
          )}
        </div>

        <div style={{ marginBottom: 16 }}>
          <label className="label">Model engine</label>
          <ModelPicker models={models} value={model} onChange={setModel} durationSecs={30} />
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>
            You can change the model anytime — costs are charged per render, not per avatar.
          </div>
        </div>

        {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>
          <AlertCircle size={14} style={{ verticalAlign: '-2px' }} /> {error}
        </div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={create} disabled={busy || !name.trim() || !photoFile}>
            {busy ? <span className="spinner" /> : <Sparkles size={14} />}
            Create avatar
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Render composer modal — for an existing avatar
function RenderComposer({ avatar, models, onClose, onSubmitted }) {
  const { session } = useAuth()
  const { refresh: refreshCredits } = useCredits()
  const [script, setScript] = useState('')
  const [model, setModel] = useState(avatar.model_version || 'v4')
  const [voiceId, setVoiceId] = useState(avatar.elevenlabs_voice_id || '')
  const [lookId, setLookId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [submitted, setSubmitted] = useState(null)

  const looks = avatar.looks || []
  const durationSecs = useMemo(() => estimateDurationSecs(script), [script])
  const m = models?.[model] || {}
  const totalCents = (m.cents_per_sec || 0) * durationSecs
  const totalUnits = Math.max(1, Math.ceil((m.video_units_per_sec || 0) * durationSecs))

  const submit = async () => {
    if (!script.trim() || !voiceId.trim()) return
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/avatars/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          avatar_id: avatar.id,
          script: script.trim(),
          voice_id: voiceId.trim(),
          look_id: lookId,
          model_version: model,
        }),
      })
      const body = await r.json()
      if (!r.ok) {
        if (r.status === 402) throw new Error(`Insufficient video units. Need ${body.required}.`)
        throw new Error(body.error || 'Render submit failed')
      }
      refreshCredits()
      setSubmitted(body)
      onSubmitted?.()
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-xl" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, var(--red), var(--red-dark))', color: '#fff', display: 'grid', placeItems: 'center', marginRight: 12 }}>
            <Video size={18} />
          </div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, flex: 1 }}>Render with {avatar.name}</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={20} /></button>
        </div>

        {submitted ? (
          <div style={{ textAlign: 'center', padding: '20px 12px' }}>
            <div style={{ width: 56, height: 56, borderRadius: 14, background: 'rgba(46,204,113,0.16)', color: '#2ecc71', display: 'grid', placeItems: 'center', margin: '0 auto 16px' }}>
              <CheckCircle2 size={28} />
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18, marginBottom: 6 }}>Render submitted</div>
            <div style={{ color: 'var(--muted)', fontSize: 13.5, marginBottom: 18 }}>
              {submitted.units_charged} video units charged · ~{fmtUsd((models[submitted.render?.model_version]?.cents_per_sec || 0) * submitted.duration_secs)} cost · usually ready in 30-90 seconds
            </div>
            <button className="btn-primary" onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            {looks.length > 1 && (
              <div style={{ marginBottom: 16 }}>
                <label className="label">Pick a look</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    onClick={() => setLookId(null)}
                    style={{
                      width: 72, height: 72, borderRadius: 10,
                      border: lookId === null ? '2px solid var(--red)' : '1px solid var(--border)',
                      background: 'var(--surface-2)', cursor: 'pointer', display: 'grid', placeItems: 'center',
                      color: 'var(--muted)', fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 600,
                    }}
                  >Default</button>
                  {looks.map((l) => (
                    <img
                      key={l.id}
                      src={l.image_url}
                      alt="look"
                      onClick={() => setLookId(l.id)}
                      style={{
                        width: 72, height: 72, objectFit: 'cover', borderRadius: 10, cursor: 'pointer',
                        border: lookId === l.id ? '2px solid var(--red)' : '1px solid var(--border)',
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            <div style={{ marginBottom: 16 }}>
              <label className="label">Script</label>
              <textarea
                className="textarea"
                style={{ minHeight: 140 }}
                value={script}
                onChange={(e) => setScript(e.target.value)}
                placeholder="What should the avatar say? Aim for 30-60 seconds (75-150 words)."
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11.5, color: 'var(--muted)' }}>
                <span>{script.trim().split(/\s+/).filter(Boolean).length} words</span>
                <span>≈ {fmtSeconds(durationSecs)} · {fmtUsd(totalCents)} · {totalUnits} unit{totalUnits === 1 ? '' : 's'}</span>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label className="label">ElevenLabs voice ID</label>
              <input
                className="input"
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
                placeholder="e.g. 21m00Tcm4TlvDq8ikWAM (paste from elevenlabs.io)"
              />
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
                Set a default voice for this avatar in its settings to skip this step next time.
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label className="label">Model engine</label>
              <ModelPicker models={models} value={model} onChange={setModel} durationSecs={durationSecs} />
            </div>

            {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>
              <AlertCircle size={14} style={{ verticalAlign: '-2px' }} /> {error}
            </div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn-primary" onClick={submit} disabled={busy || !script.trim() || !voiceId.trim()}>
                {busy ? <span className="spinner" /> : <Wand2 size={14} />}
                Render ({totalUnits} unit{totalUnits === 1 ? '' : 's'})
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Avatar detail view (looks gallery + render history)
function AvatarDetail({ avatar, models, onBack, onChange }) {
  const { session } = useAuth()
  const fileRef = useRef(null)
  const [renderOpen, setRenderOpen] = useState(false)
  const [renders, setRenders] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const refreshRenders = async () => {
    if (!session) return
    // Cheap fetch via Supabase REST (RLS-scoped)
    const r = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/avatar_renders?avatar_id=eq.${avatar.id}&order=created_at.desc&limit=20&select=*`,
      { headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` } }
    )
    if (r.ok) setRenders(await r.json())
  }

  useEffect(() => { refreshRenders() }, [session, avatar.id])

  // Poll any in-flight renders
  useEffect(() => {
    const inflight = renders.filter((r) => r.status !== 'done' && r.status !== 'failed' && r.heygen_video_id)
    if (inflight.length === 0) return
    const id = setInterval(async () => {
      for (const r of inflight) {
        try {
          await fetch(`/api/avatars/render-status?id=${r.id}`, {
            headers: { Authorization: `Bearer ${session.access_token}` },
          })
        } catch {}
      }
      refreshRenders()
    }, 10000)
    return () => clearInterval(id)
  }, [renders, session])

  const uploadLook = async (file) => {
    if (!file) return
    setBusy(true); setError(null)
    try {
      const photoUrl = await uploadToStorage(file, avatar.profile_id)
      const r = await fetch('/api/avatars/upload-look', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ avatar_id: avatar.id, photo_url: photoUrl }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error || `Upload failed (${r.status})`)
      onChange()
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const updateAvatar = async (patch) => {
    setError(null)
    const r = await fetch(`/api/avatars?id=${avatar.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(patch),
    })
    if (!r.ok) {
      const b = await r.json().catch(() => ({}))
      setError(b.error || 'Save failed')
    } else {
      onChange()
    }
  }

  const deleteAvatar = async () => {
    if (!confirm(`Delete avatar "${avatar.name}"?`)) return
    await fetch(`/api/avatars?id=${avatar.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${session.access_token}` },
    })
    onBack()
    onChange()
  }

  const looks = avatar.looks || []
  const m = models?.[avatar.model_version || 'v4'] || {}

  return (
    <div className="fade-up">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <button className="btn-ghost" onClick={onBack}><ArrowLeft size={14} /> Back</button>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, flex: 1 }}>{avatar.name}</h2>
        {avatar.training_status === 'failed' && <span className="pill pill-danger">Training failed</span>}
        {avatar.training_status === 'training' && <span className="pill pill-warning">Training</span>}
        {avatar.training_status === 'ready' && avatar.talking_photo_id && <span className="pill pill-success">Ready</span>}
        <button className="btn-primary" onClick={() => setRenderOpen(true)}><Wand2 size={14} /> New render</button>
      </div>

      {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}><AlertCircle size={14} style={{ verticalAlign: '-2px' }} /> {error}</div>}
      {avatar.training_error && (
        <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 12.5, marginBottom: 14 }}>
          <strong>Training error:</strong> {avatar.training_error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16, alignItems: 'start' }}>
        <div>
          {/* Looks */}
          <div className="card-flat" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase', flex: 1 }}>Looks</div>
              <button className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
                {busy ? <span className="spinner" /> : <Upload size={13} />} Upload look
              </button>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => uploadLook(e.target.files?.[0])} />
            </div>
            {looks.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                No looks yet. Upload more photos for different angles, outfits, or expressions.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }}>
                {looks.map((l) => (
                  <div key={l.id} style={{ position: 'relative' }}>
                    <img src={l.image_url} alt="look" style={{ width: '100%', height: 140, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--border)' }} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Renders */}
          <div className="card-flat">
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>Recent renders</div>
            {renders.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                No renders yet. Hit "New render" to generate one.
              </div>
            ) : renders.map((r) => (
              <div key={r.id} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 12px', marginBottom: 8,
                background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10,
              }}>
                <div style={{ width: 38, height: 38, borderRadius: 8, background: 'var(--surface-3)', color: 'var(--muted)', display: 'grid', placeItems: 'center' }}>
                  <Video size={16} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.title || '(untitled)'}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                    {r.model_version?.toUpperCase() || 'V4'} · {r.duration_secs ? `${r.duration_secs}s` : '—'} · {r.video_units_charged ?? 0} units · {new Date(r.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </div>
                </div>
                {r.status === 'done' && r.final_video_url ? (
                  <a className="btn-secondary" href={r.final_video_url} target="_blank" rel="noreferrer" style={{ padding: '6px 10px' }}>
                    <Play size={12} /> Watch
                  </a>
                ) : r.status === 'failed' ? (
                  <span className="pill pill-danger">Failed</span>
                ) : (
                  <span className="pill pill-warning">
                    <span className="spinner" style={{ width: 10, height: 10, display: 'inline-block', verticalAlign: '-1px', marginRight: 4 }} />
                    Rendering
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Right rail: settings */}
        <aside className="card-flat" style={{ alignSelf: 'flex-start' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>Settings</div>

          <div style={{ marginBottom: 14 }}>
            <label className="label">Model engine</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {Object.entries(models || {}).map(([k, mm]) => (
                <button key={k}
                  onClick={() => updateAvatar({ model_version: k })}
                  style={{
                    flex: 1, padding: '8px 10px', borderRadius: 8,
                    background: avatar.model_version === k ? 'linear-gradient(135deg, var(--red), var(--red-dark))' : 'var(--surface-2)',
                    color: avatar.model_version === k ? '#fff' : 'var(--text-soft)',
                    border: avatar.model_version === k ? 'none' : '1px solid var(--border)',
                    fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 11.5, cursor: 'pointer',
                  }}>
                  {k.toUpperCase()}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
              Default for new renders. ${(m.cents_per_sec / 100).toFixed(2)}/sec.
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label className="label">Default voice ID</label>
            <input
              className="input"
              defaultValue={avatar.elevenlabs_voice_id || ''}
              placeholder="ElevenLabs voice ID"
              onBlur={(e) => {
                if (e.target.value !== (avatar.elevenlabs_voice_id || '')) updateAvatar({ elevenlabs_voice_id: e.target.value })
              }}
            />
          </div>

          <button className="btn-ghost" style={{ color: 'var(--red)', width: '100%', justifyContent: 'center' }} onClick={deleteAvatar}>
            <Trash2 size={13} /> Delete avatar
          </button>
        </aside>
      </div>

      {renderOpen && <RenderComposer avatar={avatar} models={models} onClose={() => setRenderOpen(false)} onSubmitted={refreshRenders} />}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Avatar list view
function AvatarList({ avatars, publicAvatars = [], loadingPublic, models, onCreate, onOpen }) {
  return (
    <div className="fade-up">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, flex: 1 }}>Avatars</h2>
        <button className="btn-primary" onClick={onCreate}><Plus size={14} /> New avatar</button>
      </div>

      {avatars.length === 0 ? (
        <div className="card-flat" style={{ padding: 50, textAlign: 'center', color: 'var(--muted)' }}>
          <UserCircle2 size={28} style={{ marginBottom: 12 }} />
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)', marginBottom: 6 }}>
            No avatars yet
          </div>
          <div style={{ fontSize: 13, marginBottom: 22, lineHeight: 1.5, maxWidth: 420, margin: '0 auto 22px' }}>
            Upload a photo of yourself or your spokesperson, pick an engine, and start rendering AI videos in seconds.
          </div>
          <button className="btn-primary" onClick={onCreate}><Plus size={15} /> Create your first avatar</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
          {avatars.map((a) => {
            const m = models?.[a.model_version || 'v4'] || {}
            return (
              <div key={a.id} className="card" style={{ cursor: 'pointer', padding: 0, overflow: 'hidden' }} onClick={() => onOpen(a)}>
                {a.photo_url || a.thumbnail_url ? (
                  <img src={a.photo_url || a.thumbnail_url} alt={a.name} style={{ width: '100%', height: 200, objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: '100%', height: 200, background: 'var(--surface-2)', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
                    <UserCircle2 size={48} />
                  </div>
                )}
                <div style={{ padding: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>{a.name}</div>
                    <span className="pill" style={{ background: 'var(--red-soft)', color: 'var(--red)' }}>{(a.model_version || 'v4').toUpperCase()}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                    {m.cents_per_sec ? `${(m.cents_per_sec / 100).toFixed(2)} / sec · ` : ''}
                    {a.training_status === 'failed' ? 'Training failed' : (a.talking_photo_id ? 'Ready' : 'Not trained')}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* HeyGen public stock library — always visible so users can pick a
          ready-made avatar without uploading. */}
      <div style={{ marginTop: 28, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
          HeyGen library
        </h3>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {loadingPublic ? 'Loading…' : `${publicAvatars.length} stock avatars`}
        </div>
      </div>
      {publicAvatars.length === 0 && !loadingPublic ? (
        <div className="card-flat" style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
          No public avatars available right now.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
          {publicAvatars.map((g) => {
            const id = g.id || g.group_id
            const name = g.group_name || g.name || 'Stock avatar'
            const thumb = g.preview_image_url || g.preview_image || g.thumbnail_url || g.image_url
            return (
              <div key={id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {thumb ? (
                  <img src={thumb} alt={name} style={{ width: '100%', height: 180, objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: '100%', height: 180, background: 'var(--surface-2)', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
                    <UserCircle2 size={36} />
                  </div>
                )}
                <div style={{ padding: 12 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>HeyGen stock · pick in Spaces</div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
export default function Avatars() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  const [avatars, setAvatars] = useState([])
  const [publicAvatars, setPublicAvatars] = useState([])
  const [models, setModels] = useState({})
  const [loading, setLoading] = useState(true)
  const [loadingPublic, setLoadingPublic] = useState(false)
  const [creating, setCreating] = useState(false)
  const [openedId, setOpenedId] = useState(null)

  const refresh = async () => {
    if (!session || !selectedProfileId) return
    setLoading(true)
    const r = await fetch(`/api/avatars?profile_id=${selectedProfileId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    if (r.ok) {
      const body = await r.json()
      setAvatars(body.avatars || [])
      setModels(body.models || {})
    }
    setLoading(false)
  }

  // Auto-load HeyGen's public avatar library so users can pick from stock
  // characters without uploading their own.
  const refreshPublic = async () => {
    if (!session || !selectedProfileId) return
    setLoadingPublic(true)
    try {
      const r = await fetch(`/api/avatars/heygen-library?profile_id=${selectedProfileId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (r.ok) {
        const body = await r.json()
        setPublicAvatars(Array.isArray(body.groups) ? body.groups : [])
      }
    } catch {} finally {
      setLoadingPublic(false)
    }
  }

  useEffect(() => { refresh(); refreshPublic() }, [session, selectedProfileId])

  const opened = openedId ? avatars.find((a) => a.id === openedId) : null

  // When opening an avatar, fetch its full detail (with looks)
  const [openedDetail, setOpenedDetail] = useState(null)
  useEffect(() => {
    if (!openedId || !session) { setOpenedDetail(null); return }
    fetch(`/api/avatars?id=${openedId}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then((r) => r.json())
      .then((b) => setOpenedDetail(b.avatar))
  }, [openedId, session, avatars])

  if (!selectedProfileId) {
    return <div className="card-flat fade-up" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      Pick a brand profile to manage avatars.
    </div>
  }

  if (loading && avatars.length === 0) {
    return <div className="card-flat" style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
  }

  if (openedId && openedDetail) {
    return <AvatarDetail avatar={openedDetail} models={models} onBack={() => setOpenedId(null)} onChange={refresh} />
  }

  return (
    <>
      <AvatarList
        avatars={avatars}
        publicAvatars={publicAvatars}
        loadingPublic={loadingPublic}
        models={models}
        onCreate={() => setCreating(true)}
        onOpen={(a) => setOpenedId(a.id)}
      />
      {creating && (
        <CreateAvatarModal
          profileId={selectedProfileId}
          models={models}
          onClose={() => setCreating(false)}
          onCreated={(avatar, trainingError) => {
            setCreating(false)
            refresh()
            if (avatar?.id) setOpenedId(avatar.id)
            // Only alert on hard failures. "training" status is normal —
            // HeyGen is generating asynchronously and the avatar will
            // become ready in a few minutes.
            if (trainingError && avatar?.training_status === 'failed') {
              alert(`Avatar saved, but HeyGen training had an issue:\n\n${trainingError}\n\nYou can still upload looks and try again later.`)
            }
          }}
        />
      )}
    </>
  )
}
