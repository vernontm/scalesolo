// Brand real-asset library UI. Upload the client's ACTUAL photos and
// videos (food, product, venue) — these become the locked references
// campaign media generation builds from, so the product never drifts.
// Each image is auto-analyzed by Claude vision on upload (subject +
// key details) so the planner can reference assets by what they show.
//
// Two-phase signed-URL upload to the brand-assets bucket, mirroring
// SocialExtrasSection's visual-reference flow. Reusable: embedded as a
// campaign wizard step and shown standalone on the Campaigns page.

import { useEffect, useRef, useState } from 'react'
import { Upload, Trash2, Loader2, Lock, Unlock, ImageIcon, Film, AlertCircle } from 'lucide-react'

const CATEGORIES = ['food', 'product', 'interior', 'exterior', 'lifestyle', 'other']

export default function BrandAssetsPanel({ profileId, token, compact = false, onCountChange }) {
  const [assets, setAssets] = useState([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(null) // { done, total } while a batch runs
  const [error, setError] = useState(null)
  const [pendingCategory, setPendingCategory] = useState('food')
  const fileInput = useRef(null)

  const refresh = async () => {
    if (!profileId || !token) return
    setLoading(true)
    try {
      const r = await fetch(`/api/profile/brand-assets?profile_id=${profileId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b?.error || `Load failed (${r.status})`)
      setAssets(b.assets || [])
      onCountChange?.(b.assets?.length || 0)
      setError(null)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { refresh() /* eslint-disable-next-line */ }, [profileId, token])

  const upload = async (files) => {
    const list = Array.from(files || [])
    if (!list.length) return
    setError(null)
    setUploading({ done: 0, total: list.length })
    let done = 0
    try {
      for (const file of list) {
        const contentType = file.type || 'image/jpeg'
        const isVideo = /^video\//.test(contentType)
        // Phase 1: signed URL
        const initRes = await fetch('/api/profile/brand-assets?mode=init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ profile_id: profileId, content_type: contentType, category: pendingCategory }),
        })
        const initBody = await initRes.json()
        if (!initRes.ok) throw new Error(initBody?.error || `Init failed for ${file.name}`)
        // Phase 2: PUT bytes
        const putRes = await fetch(initBody.signed_url, {
          method: 'PUT',
          headers: { 'Content-Type': contentType, 'x-upsert': 'true' },
          body: file,
        })
        if (!putRes.ok) throw new Error(`Upload failed (${putRes.status}) for ${file.name}`)
        // Phase 3: finalize (runs vision for images — can take a few seconds)
        const finRes = await fetch('/api/profile/brand-assets?mode=finalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            profile_id: profileId, path: initBody.path,
            category: pendingCategory, media_type: isVideo ? 'video' : 'image',
          }),
        })
        const finBody = await finRes.json()
        if (!finRes.ok) throw new Error(finBody?.error || `Finalize failed for ${file.name}`)
        if (finBody.asset) setAssets((prev) => [finBody.asset, ...prev])
        done += 1
        setUploading({ done, total: list.length })
      }
      onCountChange?.(assets.length + done)
    } catch (e) { setError(e.message) }
    finally {
      setUploading(null)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const patch = async (id, body) => {
    setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, ...body } : a)))
    try {
      await fetch(`/api/profile/brand-assets?id=${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
    } catch { /* optimistic; a refresh reconciles */ }
  }

  const remove = async (id) => {
    setAssets((prev) => prev.filter((a) => a.id !== id))
    try {
      await fetch(`/api/profile/brand-assets?id=${id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
    } catch { /* ignore */ }
  }

  return (
    <div>
      {error && (
        <div style={errPanel}><AlertCircle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />{error}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <label style={labelSmall}>Category</label>
        <select value={pendingCategory} onChange={(e) => setPendingCategory(e.target.value)} style={selectStyle}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button
          type="button" className="btn-primary"
          onClick={() => fileInput.current?.click()}
          disabled={!!uploading}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          {uploading ? <><Loader2 size={14} className="spin" /> Uploading {uploading.done}/{uploading.total}…</>
            : <><Upload size={14} /> Upload photos / videos</>}
        </button>
        <input
          ref={fileInput} type="file" accept="image/*,video/mp4,video/webm,video/quicktime"
          multiple hidden onChange={(e) => upload(e.target.files)}
        />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          Images are auto-analyzed so the AI keeps your real product exact.
        </span>
      </div>

      {loading && !assets.length ? (
        <div style={{ color: 'var(--muted)', fontSize: 13, padding: 20 }}>Loading assets…</div>
      ) : !assets.length ? (
        <div style={emptyBox}>
          No real assets yet. Upload actual photos of the food, product, or venue.
          Anything showing the real product will be generated from these so it stays a exact match.
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: compact ? 'repeat(auto-fill, minmax(150px, 1fr))' : 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 12,
        }}>
          {assets.map((a) => (
            <AssetCard key={a.id} asset={a} onPatch={patch} onRemove={remove} categories={CATEGORIES} />
          ))}
        </div>
      )}
    </div>
  )
}

function AssetCard({ asset, onPatch, onRemove, categories }) {
  const [label, setLabel] = useState(asset.label || '')
  const subject = asset.vision_json?.subject || ''
  return (
    <div style={cardStyle}>
      <div style={thumbWrap}>
        {asset.media_type === 'video'
          ? <video src={asset.public_url} style={thumbImg} muted playsInline />
          : <img src={asset.public_url} alt={asset.label || 'asset'} style={thumbImg} />}
        <div style={typeBadge}>
          {asset.media_type === 'video' ? <Film size={12} /> : <ImageIcon size={12} />}
        </div>
        <button
          type="button" title="Delete" onClick={() => onRemove(asset.id)}
          style={delBtn}
        ><Trash2 size={13} /></button>
      </div>

      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => label !== (asset.label || '') && onPatch(asset.id, { label })}
        placeholder={asset.media_type === 'video' ? 'Label this clip' : 'Analyzing…'}
        style={labelInput}
      />
      {subject && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, lineHeight: 1.35 }}>{subject}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
        <select
          value={asset.category}
          onChange={(e) => onPatch(asset.id, { category: e.target.value })}
          style={{ ...selectStyle, flex: 1, padding: '5px 8px', fontSize: 12 }}
        >
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button
          type="button"
          title={asset.lock_exact ? 'Exact match locked — AI must reproduce this precisely' : 'Not locked — AI may reinterpret'}
          onClick={() => onPatch(asset.id, { lock_exact: !asset.lock_exact })}
          style={{
            ...lockBtn,
            color: asset.lock_exact ? '#2ecc71' : 'var(--muted)',
            borderColor: asset.lock_exact ? 'rgba(46,204,113,0.45)' : 'var(--border)',
          }}
        >
          {asset.lock_exact ? <Lock size={13} /> : <Unlock size={13} />}
        </button>
      </div>
    </div>
  )
}

const errPanel = {
  marginBottom: 12, padding: '10px 14px',
  background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.35)',
  borderRadius: 8, color: 'var(--red)', fontSize: 13,
}
const labelSmall = { fontSize: 11, fontWeight: 700, letterSpacing: 0.06, textTransform: 'uppercase', color: 'var(--muted)' }
const selectStyle = {
  padding: '8px 10px', fontSize: 13, background: 'var(--surface)',
  border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', fontFamily: 'inherit',
}
const emptyBox = {
  padding: 20, background: 'var(--surface-2)', border: '1px dashed var(--border)',
  borderRadius: 10, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5,
}
const cardStyle = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 10, padding: 8,
}
const thumbWrap = { position: 'relative', width: '100%', aspectRatio: '1/1', borderRadius: 8, overflow: 'hidden', background: 'var(--surface-2)' }
const thumbImg = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' }
const typeBadge = {
  position: 'absolute', top: 6, left: 6, padding: 4, borderRadius: 6,
  background: 'rgba(0,0,0,0.55)', color: '#fff', display: 'grid', placeItems: 'center',
}
const delBtn = {
  position: 'absolute', top: 6, right: 6, padding: 5, borderRadius: 6,
  background: 'rgba(0,0,0,0.55)', color: '#fff', border: 'none', cursor: 'pointer',
  display: 'grid', placeItems: 'center',
}
const labelInput = {
  width: '100%', marginTop: 8, padding: '6px 8px', fontSize: 13,
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  borderRadius: 6, color: 'var(--text)', fontFamily: 'inherit', boxSizing: 'border-box',
}
const lockBtn = {
  padding: '6px 8px', background: 'var(--surface-2)', border: '1px solid var(--border)',
  borderRadius: 6, cursor: 'pointer', display: 'grid', placeItems: 'center',
}
