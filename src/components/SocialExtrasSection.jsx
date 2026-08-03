// Profile-settings panel for the per-platform social tag map +
// brand visual references. Mounted under Profiles.jsx's
// `social_extras` section.
//
// Two stacked panels in one section so users don't have to dig:
//
//   1. Social tags — small grid of platform → input. Save button at
//      the bottom. Sends to /api/account/social-tags (PUT).
//
//   2. Visual references — drag-drop upload, grid of thumbnails with
//      kind + notes editable inline + a delete button. Powered by
//      /api/profile/visual-references (two-phase signed-URL upload).

import { useEffect, useRef, useState } from 'react'
import { Save, Trash2, Upload, Loader2, AlertCircle, Image as ImageIcon, Check } from 'lucide-react'

const TAG_PLATFORMS = [
  { id: 'threads',   label: 'Threads',   placeholder: 'e.g. aithreads' },
  { id: 'instagram', label: 'Instagram', placeholder: 'e.g. #yourbrand' },
  { id: 'twitter',   label: 'Twitter / X', placeholder: 'e.g. #ai' },
  { id: 'facebook',  label: 'Facebook',  placeholder: 'optional hashtag' },
  { id: 'linkedin',  label: 'LinkedIn',  placeholder: 'optional hashtag' },
  { id: 'tiktok',    label: 'TikTok',    placeholder: 'optional hashtag' },
  { id: 'youtube',   label: 'YouTube',   placeholder: 'optional hashtag' },
  { id: 'bluesky',   label: 'Bluesky',   placeholder: 'optional hashtag' },
]
const REF_KINDS = [
  { id: 'threads',   label: 'Threads post' },
  { id: 'carousel',  label: 'Carousel slide' },
  { id: 'graphic',   label: 'Branded graphic' },
  { id: 'thumbnail', label: 'YouTube thumbnail' },
  { id: 'other',     label: 'Other' },
]

export default function SocialExtrasSection({ profileId, token }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      <SocialTagsPanel profileId={profileId} token={token} />
      <div style={{ height: 1, background: 'var(--border)' }} />
      <VisualReferencesPanel profileId={profileId} token={token} />
    </div>
  )
}

// ── Social tags ──────────────────────────────────────────────────

function SocialTagsPanel({ profileId, token }) {
  const [tags, setTags] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!profileId || !token) return
    let cancelled = false
    setLoading(true)
    fetch(`/api/account/social-tags?profile_id=${profileId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((b) => { if (!cancelled) setTags(b?.tags || {}) })
      .catch((e) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [profileId, token])

  const save = async () => {
    setSaving(true); setError(null); setSaved(false)
    try {
      const r = await fetch('/api/account/social-tags', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile_id: profileId, tags }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b?.error || `Save failed (${r.status})`)
      setTags(b?.tags || {})
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 800, marginBottom: 4, letterSpacing: -0.2 }}>Per-platform tags</h3>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.5 }}>
        Tags get appended to every post on the matching platform when it publishes.
        Leave blank to skip. A leading <code>#</code> or <code>@</code> is preserved; bare words are treated as hashtags.
      </p>

      {error && <div style={errorPanel}><AlertCircle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {TAG_PLATFORMS.map((p) => (
          <label key={p.id} style={{ display: 'block' }}>
            <div style={fieldLabel}>{p.label}</div>
            <input
              type="text"
              value={tags[p.id] || ''}
              onChange={(e) => setTags((t) => ({ ...t, [p.id]: e.target.value }))}
              placeholder={p.placeholder}
              disabled={loading}
              maxLength={80}
              style={inputStyle}
            />
          </label>
        ))}
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button onClick={save} disabled={saving || loading} className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
          Save tags
        </button>
        {saved && (
          <span style={{ fontSize: 12.5, color: '#22c55e', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Check size={13} /> Saved
          </span>
        )}
      </div>
    </div>
  )
}

// ── Visual references ────────────────────────────────────────────

function VisualReferencesPanel({ profileId, token }) {
  const [refs, setRefs] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const fileInput = useRef(null)
  const [pendingKind, setPendingKind] = useState('threads')

  const refresh = async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/profile/visual-references?profile_id=${profileId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b?.error || `Load failed (${r.status})`)
      setRefs(b?.references || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { if (profileId && token) refresh() // eslint-disable-next-line
  }, [profileId, token])

  const upload = async (files) => {
    if (!files?.length) return
    setUploading(true); setError(null)
    try {
      for (const file of files) {
        // Phase 1: signed URL
        const initRes = await fetch('/api/profile/visual-references?mode=init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            profile_id: profileId,
            filename: file.name,
            content_type: file.type || 'image/jpeg',
            kind: pendingKind,
          }),
        })
        const initBody = await initRes.json()
        if (!initRes.ok) throw new Error(initBody?.error || `Init failed (${initRes.status}) for ${file.name}`)

        // Phase 2: PUT directly to Supabase signed URL
        const putRes = await fetch(initBody.signed_url, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'image/jpeg' },
          body: file,
        })
        if (!putRes.ok) throw new Error(`Upload failed (${putRes.status}) for ${file.name}`)

        // Phase 3: finalize — insert the DB row
        const finRes = await fetch('/api/profile/visual-references?mode=finalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            profile_id: profileId,
            path: initBody.path,
            kind: pendingKind,
          }),
        })
        const finBody = await finRes.json()
        if (!finRes.ok) throw new Error(finBody?.error || `Finalize failed (${finRes.status}) for ${file.name}`)
      }
      await refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const deleteRef = async (id) => {
    if (!confirm('Delete this reference?')) return
    try {
      const r = await fetch(`/api/profile/visual-references?id=${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error(b?.error || `Delete failed (${r.status})`)
      }
      setRefs((arr) => arr.filter((x) => x.id !== id))
    } catch (e) {
      setError(e.message)
    }
  }

  const updateNotes = async (id, notes) => {
    try {
      await fetch(`/api/profile/visual-references?id=${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ notes }),
      })
    } catch { /* swallow — UI keeps the optimistic update */ }
  }

  return (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 800, marginBottom: 4, letterSpacing: -0.2 }}>Visual references</h3>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.5 }}>
        Upload Threads posts, carousel slides, and branded graphics that look like the brand at its best. The AI reads these when generating new content + image prompts.
      </p>

      {error && <div style={errorPanel}><AlertCircle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />{error}</div>}

      {/* Upload bar */}
      <div style={uploadBar}>
        <select value={pendingKind} onChange={(e) => setPendingKind(e.target.value)} style={inputStyle}>
          {REF_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          multiple
          onChange={(e) => upload(Array.from(e.target.files || []))}
          style={{ display: 'none' }}
        />
        <button
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
          className="btn-primary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          {uploading ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
          Upload images
        </button>
      </div>

      {/* Grid */}
      {loading ? (
        <div style={{ padding: 30, textAlign: 'center' }}><span className="spinner" /></div>
      ) : refs.length === 0 ? (
        <div style={emptyHint}>
          <ImageIcon size={20} style={{ color: 'var(--muted)', marginBottom: 6 }} />
          <div>No references yet. Upload your best Threads posts, carousels, and graphics.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14 }}>
          {refs.map((r) => (
            <RefCard key={r.id} ref_={r} onDelete={() => deleteRef(r.id)} onUpdateNotes={(n) => updateNotes(r.id, n)} />
          ))}
        </div>
      )}
    </div>
  )
}

function RefCard({ ref_, onDelete, onUpdateNotes }) {
  const [notes, setNotes] = useState(ref_.notes || '')
  const save = () => { if (notes !== (ref_.notes || '')) onUpdateNotes(notes) }
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ position: 'relative', aspectRatio: '1 / 1', background: '#000' }}>
        <img
          src={ref_.public_url}
          alt={ref_.kind}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
        <button
          onClick={onDelete}
          aria-label="Delete"
          style={{
            position: 'absolute', top: 6, right: 6,
            background: 'rgba(0,0,0,0.65)', border: 'none', borderRadius: 6,
            color: '#fff', cursor: 'pointer', padding: 5,
          }}
        >
          <Trash2 size={13} />
        </button>
        <div style={{
          position: 'absolute', top: 6, left: 6,
          background: 'rgba(0,0,0,0.65)', color: '#fff',
          padding: '3px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: 0.06,
        }}>
          {ref_.kind}
        </div>
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={save}
        placeholder="What does this reference teach? (optional)"
        rows={2}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '8px 10px',
          fontSize: 12, color: 'var(--text)',
          background: 'transparent', border: 'none', resize: 'none',
          fontFamily: 'inherit',
          borderTop: '1px solid var(--border)',
        }}
      />
    </div>
  )
}

// ── styles ───────────────────────────────────────────────────────

const fieldLabel = {
  fontSize: 11, fontWeight: 700, letterSpacing: 0.06,
  textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6,
}
const inputStyle = {
  width: '100%', padding: '9px 12px', fontSize: 14,
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 8, color: 'var(--text)', fontFamily: 'inherit',
  boxSizing: 'border-box',
}
const uploadBar = {
  display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center',
}
const emptyHint = {
  padding: 28, textAlign: 'center',
  background: 'var(--surface-2)', border: '1px dashed var(--border)',
  borderRadius: 10, color: 'var(--muted)', fontSize: 13,
}
const errorPanel = {
  marginBottom: 14, padding: '10px 14px',
  background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.35)',
  borderRadius: 8, color: 'var(--red)', fontSize: 13,
}
