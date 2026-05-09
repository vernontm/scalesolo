import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus, Upload, X, UserCircle2, Sparkles, Video, AlertCircle, CheckCircle2,
  RefreshCw, Trash2, Wand2, Image as ImageIcon, ArrowLeft, Play, ChevronRight,
  Mic, Library, Volume2, Loader2, Check, Search,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { useCredits } from '../context/CreditsContext.jsx'
import { supabase } from '../lib/supabase.js'
import { toast, confirmDialog } from '../components/Toast.jsx'

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
          <button aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6, borderRadius: 6 }}><X size={20} /></button>
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
          <button aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6, borderRadius: 6 }}><X size={20} /></button>
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
// ─── Look folder ───────────────────────────────────────────────────────────
// Inline, expandable. Cover thumb + name + image count. Click header to
// collapse / expand. Inside: image grid + drop zone for more images +
// inline rename.
function LookFolder({ look, index, onAddImages, onDeleteImage, onRename, busy }) {
  const [open, setOpen] = useState(true)
  const [editingName, setEditingName] = useState(false)
  const [draftName, setDraftName] = useState(look.name || '')
  const inpRef = useRef(null)
  const images = (look.images || []).slice().sort((a, b) => (a.order_index || 0) - (b.order_index || 0))
  const cover = images[0]?.image_url || look.image_url

  const onPick = (e) => {
    const files = Array.from(e.target.files || [])
    if (files.length) onAddImages(files)
    if (inpRef.current) inpRef.current.value = ''
  }
  const commitRename = () => {
    setEditingName(false)
    const trimmed = (draftName || '').trim()
    if (trimmed && trimmed !== (look.name || '')) onRename(trimmed)
  }

  return (
    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: 10, cursor: 'pointer',
        }}
      >
        {cover ? (
          <img src={cover} alt="" style={{ width: 50, height: 50, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
        ) : (
          <div style={{ width: 50, height: 50, borderRadius: 6, background: 'var(--surface-3)', display: 'grid', placeItems: 'center', color: 'var(--muted)', flexShrink: 0 }}>
            <ImageIcon size={18} />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          {editingName ? (
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { setEditingName(false); setDraftName(look.name || '') } }}
              onClick={(e) => e.stopPropagation()}
              className="input"
              style={{ padding: '4px 8px', fontSize: 13 }}
            />
          ) : (
            <div
              onDoubleClick={(e) => { e.stopPropagation(); setEditingName(true); setDraftName(look.name || `Look ${index + 1}`) }}
              style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: 'var(--text)' }}
              title="Double-click to rename"
            >
              {look.name || `Look ${index + 1}`}
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            {images.length} {images.length === 1 ? 'image' : 'images'}
          </div>
        </div>
        <ChevronRight size={16} style={{ color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform 0.15s' }} />
      </div>

      {open && (
        <div style={{ padding: 10, paddingTop: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
            {images.map((im) => (
              <div key={im.id} style={{ position: 'relative' }}>
                <img src={im.image_url} alt={im.name || 'Look image'} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }} />
                <button
                  aria-label="Delete this image"
                  onClick={async (e) => {
                    e.stopPropagation()
                    const ok = await confirmDialog({ title: 'Delete this image?', confirmText: 'Delete', destructive: true })
                    if (ok) onDeleteImage(im.id)
                  }}
                  style={{
                    position: 'absolute', top: 4, right: 4,
                    background: 'rgba(0,0,0,0.7)', color: '#fff', border: 'none',
                    borderRadius: 999, width: 20, height: 20, cursor: 'pointer',
                    display: 'grid', placeItems: 'center',
                  }}
                  title="Remove"
                ><X size={11} /></button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => inpRef.current?.click()}
              disabled={busy}
              style={{
                aspectRatio: '1', borderRadius: 6,
                background: 'var(--surface)', border: '1px dashed var(--border)',
                color: 'var(--muted)', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
                fontSize: 11,
              }}
            >
              {busy ? <span className="spinner" /> : <Plus size={14} />}
              Add
            </button>
            <input ref={inpRef} type="file" multiple accept="image/jpeg,image/png,image/webp" hidden onChange={onPick} />
          </div>
        </div>
      )}
    </div>
  )
}

function AvatarDetail({ avatar, models, onBack, onChange }) {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
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

  // Add multiple images to an existing look folder.
  const addImagesToLook = async (lookId, files) => {
    setBusy(true); setError(null)
    try {
      for (const file of files) {
        const url = await uploadToStorage(file, avatar.profile_id)
        await fetch('/api/avatars/look-images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ look_id: lookId, image_url: url, name: file.name }),
        })
      }
      onChange()
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const deleteLookImage = async (id) => {
    await fetch(`/api/avatars/look-images?id=${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${session.access_token}` },
    })
    onChange()
  }

  const renameLook = async (lookId, name) => {
    // avatar_looks API doesn't have a generic PATCH yet — use Supabase REST via /api/avatars passthrough.
    // For now, write to the same upload-look endpoint as a no-op; rename via direct supabase client below.
    try {
      const { supabase } = await import('../lib/supabase.js')
      await supabase.from('avatar_looks').update({ name }).eq('id', lookId)
      onChange()
    } catch (e) { setError(e.message) }
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
    const ok = await confirmDialog({
      title: `Delete avatar "${avatar.name}"?`,
      message: 'This removes the avatar and all its look images. Renders already in the library are not affected.',
      confirmText: 'Delete', destructive: true,
    })
    if (!ok) return
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
          {/* Looks — folder view. Each look is a named bucket of images;
              the spaces avatar picker lets users pick Single (one image)
              or Randomize (any image in the look) per render. */}
          <div className="card-flat" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase', flex: 1 }}>Looks</div>
              <button className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
                {busy ? <span className="spinner" /> : <Plus size={13} />} New look
              </button>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => uploadLook(e.target.files?.[0])} />
            </div>

            {looks.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                No looks yet. Upload your first photo to create a look. Add more photos to it later for different angles, outfits, or expressions.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {looks.map((l, idx) => (
                  <LookFolder
                    key={l.id}
                    look={l}
                    index={idx}
                    onAddImages={(files) => addImagesToLook(l.id, files)}
                    onDeleteImage={deleteLookImage}
                    onRename={(name) => renameLook(l.id, name)}
                    busy={busy}
                  />
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
            ) : (
            <div style={{ maxHeight: 480, overflowY: 'auto', paddingRight: 4 }}>
            {renders.map((r) => (
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
            )}
          </div>
        </div>

        {/* Right rail: settings */}
        <aside className="card-flat" style={{ alignSelf: 'flex-start' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>Settings</div>

          {/* Model engine picker removed — single avatar pipeline now uses
              HeyGen V3 photo→video flow regardless of "model_version". */}
          <div style={{ marginBottom: 14, display: 'none' }}>
          </div>

          <AvatarVoiceSection
            avatar={avatar}
            session={session}
            profileId={selectedProfileId}
            onChange={(voiceId) => updateAvatar({ elevenlabs_voice_id: voiceId || null })}
          />

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
// Voice section — drops into the AvatarDetail right-rail. Surfaces the
// current voice + a "Choose voice" button that opens a modal with three
// tabs (Library / My voices / Clone new) and a paste-an-id fallback.
// All three converge on PATCHing avatars.elevenlabs_voice_id via the
// `onChange` callback the parent passes in.
function AvatarVoiceSection({ avatar, session, profileId, onChange }) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const audioRef = useRef(null)

  const previewCurrent = async () => {
    if (!avatar.elevenlabs_voice_id || !session?.access_token) return
    setPreviewing(true)
    try {
      const r = await fetch('/api/voices/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ voice_id: avatar.elevenlabs_voice_id, profile_id: profileId }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Preview failed')
      const a = audioRef.current || new Audio()
      audioRef.current = a
      a.src = body.audio_url
      a.onended = () => setPreviewing(false)
      a.onerror = () => setPreviewing(false)
      await a.play()
    } catch (e) {
      toast?.error?.(e.message) || alert(e.message)
      setPreviewing(false)
    }
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <label className="label" style={{ flex: 1, marginBottom: 0 }}>Voice</label>
        {avatar.elevenlabs_voice_id && (
          <button
            type="button" onClick={previewCurrent} disabled={previewing}
            title="Preview current voice"
            style={{
              background: 'transparent', border: 'none', color: 'var(--muted)',
              cursor: previewing ? 'wait' : 'pointer', padding: 4, borderRadius: 4,
            }}
          >
            {previewing ? <Loader2 size={12} className="spin" /> : <Volume2 size={12} />}
          </button>
        )}
      </div>
      <div style={{
        padding: '10px 12px', background: 'var(--surface-2)',
        border: '1px solid var(--border)', borderRadius: 8,
        fontSize: 12, color: 'var(--text)',
      }}>
        {avatar.elevenlabs_voice_id ? (
          <>
            <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-soft)' }}>
              {avatar.elevenlabs_voice_id}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
              Used as the default voice for renders.
            </div>
          </>
        ) : (
          <div style={{ color: 'var(--muted)' }}>No voice assigned. HeyGen's default TTS is used.</div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button
          type="button" className="btn-secondary"
          onClick={() => setPickerOpen(true)}
          style={{ flex: 1, justifyContent: 'center', fontSize: 12, padding: '7px 10px' }}
        >
          <Library size={12} /> Choose voice
        </button>
        {avatar.elevenlabs_voice_id && (
          <button
            type="button" className="btn-ghost"
            onClick={() => onChange(null)}
            style={{ fontSize: 12, padding: '7px 10px' }}
            title="Remove this voice"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {pickerOpen && (
        <VoicePickerModal
          session={session}
          profileId={profileId}
          currentVoiceId={avatar.elevenlabs_voice_id}
          onPick={(voiceId) => { onChange(voiceId); setPickerOpen(false) }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}

// Modal: Library / My voices / Clone new / Paste ID. Lazy-loads the
// /api/voices/library list on mount; the clone tab uploads a sample to
// landing-media first then POSTs the public URL to /api/voices/create.
function VoicePickerModal({ session, profileId, currentVoiceId, onPick, onClose }) {
  const [tab, setTab] = useState('library')   // 'library' | 'mine' | 'clone' | 'paste'
  const [shared, setShared] = useState(null)   // null = loading
  const [cloned, setCloned] = useState(null)
  const [error, setError] = useState(null)
  const [q, setQ] = useState('')
  const [previewingId, setPreviewingId] = useState(null)
  const audioRef = useRef(null)

  const refresh = async () => {
    if (!session?.access_token) return
    setError(null); setShared(null); setCloned(null)
    try {
      const r = await fetch('/api/voices/library', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Failed to load voices')
      setShared(body.shared || [])
      setCloned(body.cloned || [])
    } catch (e) {
      setError(e.message)
      setShared([]); setCloned([])
    }
  }
  useEffect(() => { refresh() /* eslint-disable-next-line */ }, [session?.access_token])

  const playPreview = async (voice) => {
    if (previewingId === voice.voice_id) {
      try { audioRef.current?.pause() } catch {}
      setPreviewingId(null)
      return
    }
    setPreviewingId(voice.voice_id)
    try {
      // Prefer the static preview_url ElevenLabs ships for premade voices —
      // free + faster than calling our TTS endpoint.
      let url = voice.preview_url
      if (!url) {
        const r = await fetch('/api/voices/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ voice_id: voice.voice_id, profile_id: profileId }),
        })
        const body = await r.json()
        if (!r.ok) throw new Error(body.error || 'Preview failed')
        url = body.audio_url
      }
      const a = audioRef.current || new Audio()
      audioRef.current = a
      a.src = url
      a.onended = () => setPreviewingId(null)
      a.onerror = () => setPreviewingId(null)
      await a.play()
    } catch (e) {
      toast?.error?.(e.message) || alert(e.message)
      setPreviewingId(null)
    }
  }

  // Stop any preview when the modal closes.
  useEffect(() => () => { try { audioRef.current?.pause() } catch {} }, [])

  const filterList = (list) => {
    if (!list) return list
    const term = q.trim().toLowerCase()
    if (!term) return list
    return list.filter((v) => (v.name || '').toLowerCase().includes(term) || (v.description || '').toLowerCase().includes(term))
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620, padding: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <Library size={16} style={{ color: 'var(--red)' }} />
          <h3 style={{ flex: 1, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, margin: 0 }}>Choose a voice</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, padding: '10px 18px 0' }}>
          {[
            { id: 'library', label: 'Library', icon: Library },
            { id: 'mine',    label: `My voices${cloned ? ` (${cloned.length})` : ''}`, icon: UserCircle2 },
            { id: 'clone',   label: 'Clone new', icon: Mic },
            { id: 'paste',   label: 'Paste ID',  icon: Search },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: '7px 12px', borderRadius: 8, fontSize: 12.5,
                fontFamily: 'var(--font-display)', fontWeight: 600,
                background: tab === t.id ? 'linear-gradient(135deg, var(--red), var(--red-dark))' : 'transparent',
                color: tab === t.id ? '#fff' : 'var(--text-soft)',
                border: tab === t.id ? 'none' : '1px solid var(--border)',
                cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5,
              }}
            ><t.icon size={11} /> {t.label}</button>
          ))}
        </div>

        {/* Search bar (library + mine tabs only) */}
        {(tab === 'library' || tab === 'mine') && (
          <div style={{ padding: '10px 18px 0' }}>
            <div style={{ position: 'relative' }}>
              <Search size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
              <input
                value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="Search voices..."
                style={{
                  width: '100%', padding: '7px 10px 7px 28px', fontSize: 12.5,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  borderRadius: 8, color: 'var(--text)', outline: 'none',
                }}
              />
            </div>
          </div>
        )}

        {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, margin: '12px 18px 0' }}>{error}</div>}

        <div style={{ padding: '12px 18px 18px', maxHeight: '60vh', overflowY: 'auto' }}>
          {tab === 'library' && (
            shared === null ? <div style={{ padding: 24, textAlign: 'center' }}><Loader2 size={18} className="spin" /></div> :
            <VoiceList list={filterList(shared)} currentVoiceId={currentVoiceId} previewingId={previewingId} onPreview={playPreview} onPick={onPick} />
          )}
          {tab === 'mine' && (
            cloned === null ? <div style={{ padding: 24, textAlign: 'center' }}><Loader2 size={18} className="spin" /></div> :
            cloned.length === 0
              ? <div style={{ padding: 18, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                  No cloned voices yet. Use the "Clone new" tab to record one from a sample.
                </div>
              : <VoiceList list={filterList(cloned)} currentVoiceId={currentVoiceId} previewingId={previewingId} onPreview={playPreview} onPick={onPick} />
          )}
          {tab === 'clone' && (
            <CloneVoiceForm
              session={session}
              profileId={profileId}
              onCloned={(voiceId) => { onPick(voiceId); refresh() }}
            />
          )}
          {tab === 'paste' && (
            <PasteVoiceIdForm onPick={onPick} />
          )}
        </div>
      </div>
    </div>
  )
}

function VoiceList({ list, currentVoiceId, previewingId, onPreview, onPick }) {
  if (!list?.length) return <div style={{ padding: 18, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No voices match.</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {list.map((v) => {
        const active = v.voice_id === currentVoiceId
        return (
          <div key={v.voice_id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 12px', borderRadius: 10,
            background: active ? 'rgba(46,204,113,0.08)' : 'var(--surface-2)',
            border: `1px solid ${active ? 'rgba(46,204,113,0.4)' : 'var(--border)'}`,
          }}>
            <button
              type="button" onClick={() => onPreview(v)}
              title={previewingId === v.voice_id ? 'Stop' : 'Preview'}
              style={{
                width: 30, height: 30, borderRadius: '50%',
                background: 'var(--surface)', border: '1px solid var(--border)',
                color: 'var(--text)', cursor: 'pointer',
                display: 'grid', placeItems: 'center', flexShrink: 0,
              }}
            >
              {previewingId === v.voice_id ? <Loader2 size={12} className="spin" /> : <Play size={11} fill="currentColor" />}
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13.5 }}>{v.name}</div>
                {active && <span style={{
                  fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999,
                  background: 'rgba(46,204,113,0.16)', color: '#2ecc71',
                }}>Current</span>}
                {v.labels?.gender && <span style={pillStyle}>{v.labels.gender}</span>}
                {v.labels?.accent && <span style={pillStyle}>{v.labels.accent}</span>}
                {v.labels?.use_case && <span style={pillStyle}>{v.labels.use_case}</span>}
              </div>
              {v.description && (
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {v.description}
                </div>
              )}
            </div>
            {!active && (
              <button
                type="button" className="btn-secondary"
                onClick={() => onPick(v.voice_id)}
                style={{ fontSize: 11.5, padding: '6px 10px' }}
              >
                <Check size={11} /> Use
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

const pillStyle = {
  fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999,
  background: 'var(--surface)', color: 'var(--text-soft)', border: '1px solid var(--border)',
  textTransform: 'capitalize',
}

function CloneVoiceForm({ session, profileId, onCloned }) {
  const [file, setFile] = useState(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inpRef = useRef(null)

  const submit = async (e) => {
    e.preventDefault()
    if (!file || !name.trim()) {
      setError('Pick an audio sample and give it a name.'); return
    }
    if (!session?.access_token || !profileId) {
      setError('Sign in and pick a brand profile first.'); return
    }
    setBusy(true); setError(null)
    try {
      // Upload the sample to Supabase storage so /api/voices/create
      // can fetch it server-side. landing-media is already public.
      const ext = (file.name.split('.').pop() || 'mp3').toLowerCase()
      const path = `${profileId}/voice-samples/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const { error: upErr } = await supabase.storage.from('landing-media').upload(path, file, {
        contentType: file.type || 'audio/mpeg', upsert: false,
      })
      if (upErr) throw new Error(`Upload failed: ${upErr.message}`)
      const { data } = supabase.storage.from('landing-media').getPublicUrl(path)
      const sampleUrl = data.publicUrl

      const r = await fetch('/api/voices/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          profile_id: profileId,
          name: name.trim(),
          description: description.trim() || undefined,
          sample_url: sampleUrl,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      toast?.success?.(`Voice "${name.trim()}" cloned.`)
      onCloned?.(body.voice_id)
    } catch (err) {
      setError(err.message); setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.5 }}>
        Upload 30s–2min of clean speech. ElevenLabs Instant Voice Cloning will
        produce a custom voice that you can use immediately. ≥1 min of audio,
        single speaker, low background noise gives the best results.
      </div>
      <input
        ref={inpRef}
        type="file"
        accept="audio/mpeg,audio/wav,audio/mp4,audio/m4a,audio/x-m4a,audio/ogg,.mp3,.wav,.m4a,.ogg"
        onChange={(e) => setFile(e.target.files?.[0] || null)}
        hidden
      />
      <button
        type="button" onClick={() => inpRef.current?.click()}
        style={{
          padding: 14, borderRadius: 10,
          background: 'var(--surface-2)', border: '1px dashed var(--border)',
          cursor: 'pointer', textAlign: 'center', fontSize: 13, color: 'var(--text-soft)',
          fontFamily: 'inherit',
        }}
      >
        {file ? (
          <>
            <Mic size={16} style={{ color: 'var(--red)', marginBottom: 6 }} />
            <div style={{ color: 'var(--text)', fontWeight: 600 }}>{file.name}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{(file.size / (1024 * 1024)).toFixed(1)} MB · click to replace</div>
          </>
        ) : (
          <>
            <Mic size={16} style={{ color: 'var(--muted)', marginBottom: 6 }} />
            <div>Drop or pick an audio sample</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>MP3 / WAV / M4A · max 25MB</div>
          </>
        )}
      </button>
      <div>
        <label className="label">Voice name</label>
        <input
          className="input" value={name} onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Ray (founder voice)"
        />
      </div>
      <div>
        <label className="label">Description (optional)</label>
        <input
          className="input" value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="Tone, accent, style notes — helps you remember which voice this is."
        />
      </div>
      {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5 }}>{error}</div>}
      <button type="submit" className="btn-primary" disabled={busy} style={{ justifyContent: 'center' }}>
        {busy ? <Loader2 size={13} className="spin" /> : <Mic size={13} />}
        {busy ? 'Cloning…' : 'Clone voice'}
      </button>
    </form>
  )
}

function PasteVoiceIdForm({ onPick }) {
  const [voiceId, setVoiceId] = useState('')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.5 }}>
        Paste an ElevenLabs voice ID — e.g. one you've cloned in your own
        ElevenLabs dashboard. Voice IDs are 20-char alphanumeric strings.
      </div>
      <input
        className="input" value={voiceId}
        onChange={(e) => setVoiceId(e.target.value.trim())}
        placeholder="21m00Tcm4TlvDq8ikWAM"
      />
      <button
        type="button" className="btn-primary"
        disabled={!voiceId} onClick={() => onPick(voiceId)}
        style={{ justifyContent: 'center' }}
      >
        <Check size={13} /> Use this voice
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Avatar list view
function AvatarList({ avatars, models, onCreate, onOpen }) {
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
              <div
                key={a.id} className="card"
                role="button" tabIndex={0}
                aria-label={`Open avatar ${a.name || 'untitled'}`}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(a) } }}
                style={{ cursor: 'pointer', padding: 0, overflow: 'hidden' }}
                onClick={() => onOpen(a)}
              >
                {a.photo_url || a.thumbnail_url ? (
                  <img src={a.photo_url || a.thumbnail_url} alt={a.name} style={{ width: '100%', height: 200, objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: '100%', height: 200, background: 'var(--surface-2)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: 40, color: 'var(--muted)' }}>
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

    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
export default function Avatars() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  const [avatars, setAvatars] = useState([])
  const [models, setModels] = useState({})
  const [loading, setLoading] = useState(true)
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

  useEffect(() => { refresh() }, [session, selectedProfileId])

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
              toast({
                kind: 'warn',
                message: `Avatar saved, but training had an issue: ${trainingError}\n\nYou can still upload looks and try again later.`,
                ttl: 9000,
              })
            }
          }}
        />
      )}
    </>
  )
}
