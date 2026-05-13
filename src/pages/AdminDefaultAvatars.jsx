import { useEffect, useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { UserCircle2, Plus, Trash2, X, Loader2, Save, Image as ImageIcon, EyeOff, Eye, Upload, Mic } from 'lucide-react'
import { supabase } from '../lib/supabase'

// Upload to Supabase Storage and return the public URL. Same bucket
// the user-side Avatars page uses — but under a top-level `defaults/`
// folder so admin-curated images are filterable. Bypasses Vercel's
// 4.5MB request body limit.
async function uploadDefaultAvatarImage(file) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
  const path = `defaults/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const { error } = await supabase.storage.from('avatar-media').upload(path, file, {
    contentType: file.type || 'image/jpeg',
    upsert: false,
  })
  if (error) throw new Error(`Storage upload failed: ${error.message}`)
  const { data } = supabase.storage.from('avatar-media').getPublicUrl(path)
  return data.publicUrl
}

// Admin: manage the default avatars that appear on every user's
// /avatars page. CRUD + look management. Voice swap is per-user
// downstream, so we just set the avatar-wide default voice here.

async function authedFetch(path, init = {}) {
  const session = (await supabase.auth.getSession()).data.session
  return fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session?.access_token || ''}`,
      ...(init.headers || {}),
    },
  })
}

export default function AdminDefaultAvatars() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [editing, setEditing] = useState(null) // avatar object or { _new: true }
  const refresh = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const r = await authedFetch('/api/admin/default-avatars')
      const b = await r.json()
      if (!r.ok) throw new Error(b?.error || `Failed (${r.status})`)
      setItems(b.avatars || [])
    } catch (e) {
      setErr(e.message)
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const onDelete = async (id) => {
    if (!confirm('Soft-delete this default avatar? It will be hidden from users. Re-activate from this page later.')) return
    try {
      const r = await authedFetch(`/api/admin/default-avatars?id=${id}`, { method: 'DELETE' })
      if (!r.ok && r.status !== 204) throw new Error(`Delete failed (${r.status})`)
      refresh()
    } catch (e) { setErr(e.message) }
  }

  return (
    <div className="fade-up">
      <div style={hero}>
        <div style={heroIcon}><UserCircle2 size={20} /></div>
        <div style={{ flex: 1 }}>
          <div style={heroTitle}>Default avatars</div>
          <div style={heroSub}>Pre-built avatars shown on every user's /avatars page, with a voice already attached. Users can render with them and swap to their own ElevenLabs voice, but can't edit the avatar or its looks.</div>
        </div>
        <button className="btn-primary" onClick={() => setEditing({ _new: true, name: '', is_active: true, sort_order: 0 })}>
          <Plus size={14} /> New default avatar
        </button>
      </div>

      {err && <div style={errBanner}>{err}</div>}
      {loading ? (
        <div style={loadingRow}><Loader2 size={14} className="spin" /> Loading…</div>
      ) : items.length === 0 ? (
        <div style={emptyState}>
          No default avatars yet. Create one to give every user a head start on the /avatars page.
        </div>
      ) : (
        <div style={grid}>
          {items.map((a) => (
            <div key={a.id} style={card(a.is_active)} className="lift">
              <div style={{
                aspectRatio: '1 / 1', background: 'var(--surface-2)',
                backgroundImage: a.preview_image_url ? `url(${a.preview_image_url})` : 'none',
                backgroundSize: 'cover', backgroundPosition: 'center',
                borderRadius: 10, marginBottom: 10,
                position: 'relative',
              }}>
                {!a.is_active && (
                  <div style={inactiveBadge}><EyeOff size={11} /> Inactive</div>
                )}
                {(a.looks?.length || 0) > 0 && (
                  <div style={lookCount}>{a.looks.length} look{a.looks.length === 1 ? '' : 's'}</div>
                )}
              </div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 15, color: 'var(--text)' }}>{a.name}</div>
              {a.default_voice_label && (
                <div style={{ fontSize: 11.5, color: 'var(--text-soft)', marginTop: 2 }}>
                  Voice: {a.default_voice_label}
                </div>
              )}
              {a.description && (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.4 }}>{a.description}</div>
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                <button onClick={() => setEditing(a)} style={smallBtn}>Edit</button>
                <button onClick={() => onDelete(a.id)} style={{ ...smallBtn, color: 'var(--red)' }}>
                  <Trash2 size={11} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <EditDrawer
          avatar={editing._new ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh() }}
        />
      )}
    </div>
  )
}

function EditDrawer({ avatar, onClose, onSaved }) {
  const [draft, setDraft] = useState(avatar || {
    name: '', description: '', heygen_group_id: '',
    elevenlabs_voice_id: '', default_voice_label: '',
    preview_image_url: '', sort_order: 0, is_active: true,
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [looks, setLooks] = useState(avatar?.looks || [])
  const isNew = !avatar?.id

  // Pulled once on drawer open. Picker dropdown lists every voice the
  // master ElevenLabs key can see (premade + professional + cloned).
  const [voices, setVoices] = useState(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await authedFetch('/api/voices/library?admin=1')
        const b = await r.json()
        if (cancelled) return
        if (!r.ok) throw new Error(b?.error || `Voices ${r.status}`)
        setVoices(b.admin || [])
      } catch (e) {
        // Surface but don't block — admin can still paste a voice id
        // manually if the picker fails.
        if (!cancelled) setErr(`Voice picker: ${e.message} (you can still paste a voice id below)`)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Upload handler shared by the preview image + new-look buttons.
  // Uploads first, swaps in the public URL once the bucket returns it.
  const previewFileRef = useRef(null)
  const newLookFileRef = useRef(null)
  const [uploading, setUploading] = useState(null) // 'preview' | 'look' | null
  const onPickPreview = async (file) => {
    if (!file) return
    setErr(null); setUploading('preview')
    try {
      const url = await uploadDefaultAvatarImage(file)
      setDraft((d) => ({ ...d, preview_image_url: url }))
    } catch (e) { setErr(e.message) }
    finally { setUploading(null) }
  }

  const save = async () => {
    setSaving(true); setErr(null)
    try {
      const body = {
        name: draft.name?.trim() || '',
        description: draft.description || '',
        heygen_group_id: draft.heygen_group_id || null,
        elevenlabs_voice_id: draft.elevenlabs_voice_id || null,
        default_voice_label: draft.default_voice_label || null,
        preview_image_url: draft.preview_image_url || null,
        sort_order: Number(draft.sort_order) || 0,
        is_active: draft.is_active !== false,
      }
      if (!body.name) throw new Error('Name is required')
      const url = isNew
        ? '/api/admin/default-avatars'
        : `/api/admin/default-avatars?id=${avatar.id}`
      const r = await authedFetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        body: JSON.stringify(body),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b?.error || `Save failed (${r.status})`)
      onSaved?.()
    } catch (e) {
      setErr(e.message)
      setSaving(false)
    }
  }

  // Upload one or more look images via the file picker. Each file
  // uploads to Storage in parallel; the resulting public URL is then
  // POSTed to /api/admin/default-avatars?action=add_look. Same UX as
  // the user-side Avatars page (uploadToStorage → add-look API).
  const addLookFiles = async (files) => {
    if (!avatar?.id) { setErr('Save the avatar first, then add looks.'); return }
    if (!files?.length) return
    setSaving(true); setUploading('look'); setErr(null)
    try {
      for (const file of files) {
        const url = await uploadDefaultAvatarImage(file)
        const r = await authedFetch(`/api/admin/default-avatars?id=${avatar.id}&action=add_look`, {
          method: 'POST',
          body: JSON.stringify({
            image_url: url,
            label: file.name?.replace(/\.[^.]+$/, '') || '',
            angle_order: looks.length,
          }),
        })
        const b = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(b?.error || `Add look failed (${r.status})`)
        setLooks((arr) => [...arr, b.look])
      }
    } catch (e) { setErr(e.message) }
    finally { setSaving(false); setUploading(null) }
  }

  const deleteLook = async (lookId) => {
    if (!avatar?.id) return
    if (!confirm('Delete this look?')) return
    setSaving(true); setErr(null)
    try {
      const r = await authedFetch(`/api/admin/default-avatars?id=${avatar.id}&action=delete_look&look_id=${lookId}`, {
        method: 'DELETE',
      })
      if (!r.ok && r.status !== 204) throw new Error(`Delete failed (${r.status})`)
      setLooks((arr) => arr.filter((l) => l.id !== lookId))
    } catch (e) { setErr(e.message) }
    finally { setSaving(false) }
  }

  // Portal to document.body so the modal escapes any parent
  // containing-block (App sidebar grid, Admin layout, etc.) and
  // truly uses the full viewport via position:fixed.
  if (typeof document === 'undefined') return null
  return createPortal((
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-lg" onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
        <button onClick={onClose} style={closeBtn} aria-label="Close"><X size={16} /></button>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 20, marginBottom: 16 }}>
          {isNew ? 'New default avatar' : `Edit: ${avatar.name}`}
        </div>

        {err && <div style={errBanner}>{err}</div>}

        <div style={{ display: 'grid', gap: 12 }}>
          <Field label="Name *" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} placeholder="e.g. Kara" />
          <Field label="Description" multiline value={draft.description} onChange={(v) => setDraft({ ...draft, description: v })} placeholder="What's the vibe / archetype of this avatar?" />

          {/* Preview image — file upload that mirrors the user-side
              Avatars page. Click to pick a file; on upload the
              public URL fills draft.preview_image_url. */}
          <div>
            <div style={{ fontSize: 12, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--text-soft)', marginBottom: 4 }}>Preview image</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{
                width: 80, height: 80, borderRadius: 10,
                background: draft.preview_image_url ? `url(${draft.preview_image_url}) center/cover` : 'var(--surface-2)',
                border: '1px solid var(--border)', flexShrink: 0,
                display: 'grid', placeItems: 'center', color: 'var(--muted)',
              }}>
                {!draft.preview_image_url && <ImageIcon size={20} />}
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => previewFileRef.current?.click()}
                  disabled={uploading === 'preview'}
                  className="btn-secondary"
                  style={{ alignSelf: 'flex-start', padding: '8px 12px' }}
                >
                  {uploading === 'preview' ? <><Loader2 size={13} className="spin" /> Uploading…</> : <><Upload size={13} /> Choose photo</>}
                </button>
                <input
                  ref={previewFileRef} type="file" accept="image/jpeg,image/png,image/webp"
                  hidden
                  onChange={(e) => { onPickPreview(e.target.files?.[0]); e.target.value = '' }}
                />
                {draft.preview_image_url && (
                  <button
                    type="button" onClick={() => setDraft({ ...draft, preview_image_url: '' })}
                    style={{ alignSelf: 'flex-start', background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, padding: 0, textDecoration: 'underline' }}
                  >Remove</button>
                )}
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="HeyGen group id" value={draft.heygen_group_id} onChange={(v) => setDraft({ ...draft, heygen_group_id: v })} placeholder="grp_…" />
            <Field label="Sort order" type="number" value={draft.sort_order} onChange={(v) => setDraft({ ...draft, sort_order: v })} />
          </div>

          {/* Voice picker — dropdown of every voice the master ElevenLabs
              key can see. Picking one auto-fills BOTH the voice id and
              the user-facing label so admins don't have to type either
              by hand. Falls back to manual paste if the API call fails. */}
          <div>
            <div style={{ fontSize: 12, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--text-soft)', marginBottom: 4 }}>
              ElevenLabs voice
            </div>
            {Array.isArray(voices) && voices.length > 0 ? (
              <select
                className="input"
                value={draft.elevenlabs_voice_id || ''}
                onChange={(e) => {
                  const id = e.target.value
                  const v = voices.find((x) => x.voice_id === id)
                  setDraft({
                    ...draft,
                    elevenlabs_voice_id: id,
                    default_voice_label: v ? (v.description ? `${v.name} (${v.description})` : v.name) : draft.default_voice_label,
                  })
                }}
                style={{ width: '100%' }}
              >
                <option value="">— Pick a voice —</option>
                {voices.map((v) => (
                  <option key={v.voice_id} value={v.voice_id}>
                    {v.name}{v.category ? ` · ${v.category}` : ''}{v.description ? ` — ${v.description.slice(0, 40)}` : ''}
                  </option>
                ))}
              </select>
            ) : voices === null ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 10px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8 }}>
                <Loader2 size={11} className="spin" style={{ verticalAlign: '-1px', marginRight: 4 }} /> Loading voices from ElevenLabs…
              </div>
            ) : (
              <Field label="" value={draft.elevenlabs_voice_id} onChange={(v) => setDraft({ ...draft, elevenlabs_voice_id: v })} placeholder="vc_…" />
            )}
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              Pulls live from your master ElevenLabs account (premade + professional + your cloned voices). Picking auto-fills the label below.
            </div>
          </div>
          <Field label="Voice label (shown to user)" value={draft.default_voice_label} onChange={(v) => setDraft({ ...draft, default_voice_label: v })} placeholder="e.g. Kara (warm Houston AAVE)" />

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-soft)' }}>
            <input type="checkbox" checked={draft.is_active !== false} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} />
            Active (visible to users)
          </label>
        </div>

        {!isNew && (
          <div style={{ marginTop: 22 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 14, marginBottom: 4 }}>Looks</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.5 }}>
              Add one or more photos of the same avatar — different outfits, angles, settings. Users pick a look at render time or cycle through them automatically. Drop multiple files at once to add them in one go.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10, marginBottom: 12 }}>
              {looks.map((l) => (
                <div key={l.id} style={{
                  position: 'relative', aspectRatio: '1 / 1', borderRadius: 8,
                  background: `url(${l.image_url}) center/cover, var(--surface-2)`,
                  border: '1px solid var(--border)',
                }}>
                  {l.label && (
                    <div style={lookLabel}>{l.label}</div>
                  )}
                  <button
                    onClick={() => deleteLook(l.id)}
                    style={lookDelete}
                    aria-label="Delete look"
                  ><Trash2 size={11} /></button>
                </div>
              ))}
              {/* Inline add tile — clicking opens the file picker, drop
                  onto it works too. Same UX pattern as the user-facing
                  Avatars page but with multi-file support since admins
                  often want to load a whole library in one shot. */}
              <label
                onDragOver={(e) => { e.preventDefault() }}
                onDrop={(e) => {
                  e.preventDefault()
                  const files = Array.from(e.dataTransfer?.files || []).filter((f) => /^image\//.test(f.type))
                  if (files.length) addLookFiles(files)
                }}
                style={{
                  aspectRatio: '1 / 1', borderRadius: 8,
                  border: '1.5px dashed var(--border)',
                  background: 'var(--surface-2)',
                  display: 'grid', placeItems: 'center',
                  color: 'var(--muted)', cursor: 'pointer',
                  textAlign: 'center', padding: 10,
                  fontSize: 11, lineHeight: 1.4,
                }}
              >
                {uploading === 'look' ? (
                  <span><Loader2 size={16} className="spin" style={{ display: 'block', margin: '0 auto 4px' }} /> Uploading…</span>
                ) : (
                  <span>
                    <Plus size={18} style={{ display: 'block', margin: '0 auto 4px', color: 'var(--text-soft)' }} />
                    Add look
                    <div style={{ fontSize: 10, marginTop: 2 }}>(click or drop)</div>
                  </span>
                )}
                <input
                  ref={newLookFileRef} type="file" accept="image/jpeg,image/png,image/webp"
                  multiple hidden
                  onChange={(e) => { addLookFiles(Array.from(e.target.files || [])); e.target.value = '' }}
                />
              </label>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 22, justifyContent: 'flex-end' }}>
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <button onClick={save} disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />} {isNew ? 'Create' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  ), document.body)
}

function Field({ label, value, onChange, placeholder, multiline, type = 'text' }) {
  return (
    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-soft)' }}>
      <div style={{ marginBottom: 4, fontFamily: 'var(--font-display)', fontWeight: 700 }}>{label}</div>
      {multiline ? (
        <textarea
          rows={3} value={value || ''} placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="input"
          style={{ width: '100%', fontFamily: 'inherit', fontSize: 13, resize: 'vertical' }}
        />
      ) : (
        <input
          type={type} value={value ?? ''} placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="input"
          style={{ width: '100%', fontSize: 13 }}
        />
      )}
    </label>
  )
}

const hero = { display: 'flex', alignItems: 'center', gap: 12, padding: 18, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, marginBottom: 16 }
const heroIcon = { width: 38, height: 38, borderRadius: 10, background: 'linear-gradient(135deg, var(--red), var(--red-dark))', color: '#fff', display: 'grid', placeItems: 'center' }
const heroTitle = { fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18, color: 'var(--text)' }
const heroSub = { fontSize: 12.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.5, maxWidth: 720 }
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }
const card = (active) => ({
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 12, padding: 12,
  opacity: active ? 1 : 0.7,
})
const inactiveBadge = { position: 'absolute', top: 8, left: 8, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 999, background: 'rgba(245,158,11,0.18)', border: '1px solid rgba(245,158,11,0.45)', color: '#fbbf24', fontSize: 10.5, fontWeight: 700 }
const lookCount = { position: 'absolute', bottom: 8, right: 8, padding: '3px 8px', borderRadius: 999, background: 'rgba(0,0,0,0.5)', color: '#fff', fontSize: 10.5, fontWeight: 700 }
const smallBtn = { flex: 1, padding: '6px 8px', fontSize: 11.5, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }
const closeBtn = { position: 'absolute', top: 14, right: 14, background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6 }
const errBanner = { background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 12px', borderRadius: 8, fontSize: 13, marginBottom: 12 }
const loadingRow = { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 13, padding: 20 }
const emptyState = { padding: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14, background: 'var(--surface)', border: '1px dashed var(--border)', borderRadius: 12 }
const lookLabel = { position: 'absolute', bottom: 4, left: 4, right: 4, padding: '3px 6px', background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 10, borderRadius: 4, textAlign: 'center' }
const lookDelete = { position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,0.55)', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', padding: 4, display: 'grid', placeItems: 'center' }
