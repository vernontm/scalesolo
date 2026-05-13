import { useEffect, useState, useCallback } from 'react'
import { UserCircle2, Plus, Trash2, X, Loader2, Save, Image as ImageIcon, EyeOff, Eye } from 'lucide-react'
import { supabase } from '../lib/supabase'

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
  const [newLook, setNewLook] = useState({ image_url: '', label: '', heygen_look_id: '' })
  const isNew = !avatar?.id

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

  const addLook = async () => {
    if (!avatar?.id) { setErr('Save the avatar first, then add looks.'); return }
    if (!newLook.image_url) { setErr('image_url required'); return }
    setSaving(true); setErr(null)
    try {
      const r = await authedFetch(`/api/admin/default-avatars?id=${avatar.id}&action=add_look`, {
        method: 'POST',
        body: JSON.stringify(newLook),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b?.error || `Add look failed (${r.status})`)
      setLooks((arr) => [...arr, b.look])
      setNewLook({ image_url: '', label: '', heygen_look_id: '' })
    } catch (e) { setErr(e.message) }
    finally { setSaving(false) }
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

  return (
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
          <Field label="Preview image URL" value={draft.preview_image_url} onChange={(v) => setDraft({ ...draft, preview_image_url: v })} placeholder="https://…/preview.png" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="HeyGen group id" value={draft.heygen_group_id} onChange={(v) => setDraft({ ...draft, heygen_group_id: v })} placeholder="grp_…" />
            <Field label="Sort order" type="number" value={draft.sort_order} onChange={(v) => setDraft({ ...draft, sort_order: v })} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="ElevenLabs voice id" value={draft.elevenlabs_voice_id} onChange={(v) => setDraft({ ...draft, elevenlabs_voice_id: v })} placeholder="vc_…" />
            <Field label="Voice label (shown to user)" value={draft.default_voice_label} onChange={(v) => setDraft({ ...draft, default_voice_label: v })} placeholder="e.g. Kara (warm Houston AAVE)" />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-soft)' }}>
            <input type="checkbox" checked={draft.is_active !== false} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} />
            Active (visible to users)
          </label>
        </div>

        {!isNew && (
          <div style={{ marginTop: 22 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 14, marginBottom: 8 }}>Looks</div>
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
              {looks.length === 0 && (
                <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--muted)' }}>No looks yet. Add one below.</div>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 8, alignItems: 'end' }}>
              <Field label="Image URL" value={newLook.image_url} onChange={(v) => setNewLook({ ...newLook, image_url: v })} placeholder="https://…/look.png" />
              <Field label="Label (optional)" value={newLook.label} onChange={(v) => setNewLook({ ...newLook, label: v })} placeholder="e.g. Black tee" />
              <Field label="HeyGen look id (optional)" value={newLook.heygen_look_id} onChange={(v) => setNewLook({ ...newLook, heygen_look_id: v })} />
              <button onClick={addLook} disabled={saving || !newLook.image_url} className="btn-secondary" style={{ padding: '8px 12px' }}>
                <Plus size={12} /> Add look
              </button>
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
  )
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
