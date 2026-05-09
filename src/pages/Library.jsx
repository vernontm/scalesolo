import { useEffect, useMemo, useState } from 'react'
import { Library as LibraryIcon, Download, Play, Image as ImageIcon, Search, X, Trash2, CheckSquare, Square } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'

// All generated assets for the active brand profile, pulled from
// content_scripts. One tile per item — image / video tiles are clickable
// (full-screen preview) and offer a one-click download.

const sortOptions = [
  { value: 'newest',  label: 'Newest first' },
  { value: 'oldest',  label: 'Oldest first' },
  { value: 'title',   label: 'Title A → Z' },
]

const kindOptions = [
  { value: 'all',     label: 'All assets' },
  { value: 'video',   label: 'Videos only' },
  { value: 'image',   label: 'Images only' },
]

function downloadUrl(url, filename) {
  const a = document.createElement('a')
  a.href = url
  if (filename) a.download = filename
  a.target = '_blank'
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export default function LibraryPage() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  const [items, setItems] = useState(null)
  const [error, setError] = useState(null)
  const [sort, setSort] = useState('newest')
  const [kind, setKind] = useState('all')
  const [q, setQ] = useState('')
  const [previewItem, setPreviewItem] = useState(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [deleting, setDeleting] = useState(false)

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const clearSelection = () => setSelectedIds(new Set())
  const exitSelectMode = () => { setSelectMode(false); clearSelection() }

  const deleteSelected = async () => {
    if (!session?.access_token || selectedIds.size === 0) return
    const n = selectedIds.size
    if (!window.confirm(`Delete ${n} asset${n === 1 ? '' : 's'}? This can't be undone.`)) return
    setDeleting(true)
    const ids = Array.from(selectedIds)
    const failed = []
    for (const id of ids) {
      try {
        const r = await fetch(`/api/content?id=${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        if (!r.ok && r.status !== 204) failed.push(id)
      } catch {
        failed.push(id)
      }
    }
    setItems((prev) => (prev || []).filter((it) => !ids.includes(it.id) || failed.includes(it.id)))
    setSelectedIds(new Set(failed))
    setDeleting(false)
    if (failed.length) setError(`${failed.length} asset${failed.length === 1 ? '' : 's'} could not be deleted.`)
    else exitSelectMode()
  }

  useEffect(() => {
    if (!session?.access_token || !selectedProfileId) return
    let cancelled = false
    setItems(null); setError(null)
    ;(async () => {
      try {
        const r = await fetch(`/api/content?profile_id=${selectedProfileId}&filter=library`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const body = await r.json()
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
        if (!cancelled) setItems(Array.isArray(body.items) ? body.items : [])
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load library')
      }
    })()
    return () => { cancelled = true }
  }, [session?.access_token, selectedProfileId])

  const filtered = useMemo(() => {
    if (!items) return null
    let out = items.filter((it) => Array.isArray(it.media_urls) && it.media_urls.length > 0)
    if (kind !== 'all') {
      out = out.filter((it) => (it.media_type || 'image') === kind)
    }
    const term = q.trim().toLowerCase()
    if (term) {
      out = out.filter((it) =>
        (it.title || '').toLowerCase().includes(term) ||
        (it.caption || '').toLowerCase().includes(term) ||
        (it.full_script || '').toLowerCase().includes(term)
      )
    }
    if (sort === 'newest') out.sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))
    if (sort === 'oldest') out.sort((a, b) => new Date(a.updated_at || a.created_at || 0) - new Date(b.updated_at || b.created_at || 0))
    if (sort === 'title')  out.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
    return out
  }, [items, sort, kind, q])

  // Esc closes the preview
  useEffect(() => {
    if (!previewItem) return
    document.querySelectorAll('video').forEach((v) => { try { v.pause() } catch {} })
    const onKey = (e) => { if (e.key === 'Escape') setPreviewItem(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewItem])

  return (
    <div style={{ padding: '24px 24px 48px', maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <LibraryIcon size={20} style={{ color: 'var(--red)' }} />
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 22, margin: 0 }}>Library</h1>
        <div style={{ flex: 1 }} />
        {filtered && (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {filtered.length} {filtered.length === 1 ? 'asset' : 'assets'}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18, alignItems: 'center' }}>
        {selectMode ? (
          <>
            <button
              onClick={exitSelectMode}
              style={{ ...selectStyle, cursor: 'pointer' }}
            >Cancel</button>
            <button
              onClick={() => {
                if (!filtered) return
                const allIds = filtered.map((it) => it.id)
                const allSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id))
                setSelectedIds(allSelected ? new Set() : new Set(allIds))
              }}
              style={{ ...selectStyle, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              {filtered && filtered.length > 0 && filtered.every((it) => selectedIds.has(it.id))
                ? <><CheckSquare size={13} /> Deselect all</>
                : <><Square size={13} /> Select all</>}
            </button>
            <button
              onClick={deleteSelected}
              disabled={deleting || selectedIds.size === 0}
              style={{
                padding: '8px 12px', borderRadius: 8, fontSize: 13, fontFamily: 'inherit',
                background: 'var(--red)', color: '#fff', border: 'none',
                cursor: (deleting || selectedIds.size === 0) ? 'not-allowed' : 'pointer',
                opacity: (deleting || selectedIds.size === 0) ? 0.6 : 1,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              <Trash2 size={13} /> Delete {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
            </button>
          </>
        ) : (
          <button
            onClick={() => setSelectMode(true)}
            style={{ ...selectStyle, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <CheckSquare size={13} /> Select
          </button>
        )}
        <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 360 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title, caption, script…"
            style={{
              width: '100%', padding: '8px 10px 8px 30px',
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 8, fontSize: 13, color: 'var(--text)', outline: 'none',
            }}
          />
        </div>
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={selectStyle}>
          {kindOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} style={selectStyle}>
          {sortOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {error && (
        <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {filtered === null ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--muted)', border: '1px dashed var(--border)', borderRadius: 12 }}>
          <ImageIcon size={28} style={{ marginBottom: 10, opacity: 0.6 }} />
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, marginBottom: 4, color: 'var(--text)' }}>
            Nothing here yet
          </div>
          <div style={{ fontSize: 13 }}>
            Generated images and videos saved from your spaces show up here.
          </div>
        </div>
      ) : (
        <div style={{
          display: 'grid', gap: 14,
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        }}>
          {filtered.map((it) => {
            const url = it.media_urls?.[0]
            const isVideo = (it.media_type || 'image') === 'video'
            const isSelected = selectedIds.has(it.id)
            return (
              <div
                key={it.id}
                onClick={() => {
                  if (selectMode) toggleSelect(it.id)
                  else setPreviewItem({ url, type: isVideo ? 'video' : 'image', item: it })
                }}
                style={{
                  background: 'var(--surface)',
                  border: isSelected ? '2px solid var(--red)' : '1px solid var(--border)',
                  borderRadius: 12, overflow: 'hidden', cursor: 'pointer',
                  display: 'flex', flexDirection: 'column',
                  transition: 'transform 120ms ease, box-shadow 120ms ease',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 20px rgba(0,0,0,0.12)' }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = '' }}
              >
                <div style={{ position: 'relative', aspectRatio: '9/16', background: '#000' }}>
                  {selectMode && (
                    <div
                      onClick={(e) => { e.stopPropagation(); toggleSelect(it.id) }}
                      style={{
                        position: 'absolute', top: 8, left: 8, zIndex: 2,
                        width: 26, height: 26, borderRadius: 6,
                        background: isSelected ? 'var(--red)' : 'rgba(0,0,0,0.55)',
                        color: '#fff', display: 'grid', placeItems: 'center',
                        cursor: 'pointer', backdropFilter: 'blur(4px)',
                      }}
                    >
                      {isSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                    </div>
                  )}
                  {isVideo ? (
                    <>
                      <video src={url} autoPlay loop muted playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      <div style={{
                        position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                        background: 'linear-gradient(180deg, rgba(0,0,0,0) 50%, rgba(0,0,0,0.45) 100%)',
                        pointerEvents: 'none',
                      }}>
                        <div style={{ background: 'rgba(0,0,0,0.55)', borderRadius: 999, padding: 8, color: '#fff' }}>
                          <Play size={16} fill="#fff" />
                        </div>
                      </div>
                    </>
                  ) : (
                    <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); downloadUrl(url, `${(it.title || 'asset').replace(/\W+/g, '-').toLowerCase()}.${isVideo ? 'mp4' : 'png'}`) }}
                    title="Download"
                    style={{
                      position: 'absolute', top: 8, right: 8,
                      background: 'rgba(0,0,0,0.6)', border: 'none', color: '#fff',
                      padding: 6, borderRadius: 6, cursor: 'pointer',
                      display: 'grid', placeItems: 'center', backdropFilter: 'blur(4px)',
                    }}
                  ><Download size={13} /></button>
                </div>
                <div style={{ padding: 10 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.title || 'Untitled'}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
                    {new Date(it.updated_at || it.created_at).toLocaleDateString()} · {it.status || 'draft'}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {previewItem && (
        <div
          onClick={() => setPreviewItem(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
            display: 'grid', placeItems: 'center', zIndex: 200,
            padding: 24,
          }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); setPreviewItem(null) }}
            style={{
              position: 'absolute', top: 16, right: 16,
              background: 'rgba(0,0,0,0.6)', border: 'none', color: '#fff',
              padding: 8, borderRadius: 8, cursor: 'pointer',
            }}
          ><X size={16} /></button>
          <button
            onClick={(e) => { e.stopPropagation(); downloadUrl(previewItem.url, `${(previewItem.item?.title || 'asset').replace(/\W+/g, '-').toLowerCase()}.${previewItem.type === 'video' ? 'mp4' : 'png'}`) }}
            style={{
              position: 'absolute', top: 16, right: 64,
              background: 'rgba(0,0,0,0.6)', border: 'none', color: '#fff',
              padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
              fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          ><Download size={13} /> Download</button>
          {previewItem.type === 'video' ? (
            <video
              src={previewItem.url}
              controls autoPlay
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: '92vw', maxHeight: '88vh', borderRadius: 8, background: '#000' }}
            />
          ) : (
            <img
              src={previewItem.url}
              alt=""
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: '92vw', maxHeight: '88vh', borderRadius: 8 }}
            />
          )}
        </div>
      )}
    </div>
  )
}

const selectStyle = {
  padding: '8px 10px',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 13,
  color: 'var(--text)',
  outline: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
}
