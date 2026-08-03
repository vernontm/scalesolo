import { useEffect, useState } from 'react'
import { X, ChevronLeft, ChevronRight, Download } from 'lucide-react'

// Fullscreen media viewer. Pass `video` for a single clip, or `images` (an
// array) for a scrollable carousel — arrows, dots, keyboard (←/→/Esc), and a
// "n / total" counter. Shared by Library and the Carousel builder.
export default function MediaLightbox({ images = [], video = null, startIndex = 0, title = 'asset', onClose }) {
  const list = video ? [video] : (Array.isArray(images) ? images.filter(Boolean) : [])
  const isVideo = !!video
  const [i, setI] = useState(() => Math.max(0, Math.min(startIndex, Math.max(0, list.length - 1))))
  const multi = !isVideo && list.length > 1
  const prev = () => setI((v) => (v - 1 + list.length) % list.length)
  const next = () => setI((v) => (v + 1) % list.length)

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
      else if (multi && e.key === 'ArrowLeft') prev()
      else if (multi && e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [multi, list.length])

  if (!list.length) return null
  const url = list[i]
  const slug = String(title || 'asset').replace(/\W+/g, '-').toLowerCase()
  const download = () => {
    const a = document.createElement('a')
    a.href = url; a.download = `${slug}${multi ? `-${i + 1}` : ''}.${isVideo ? 'mp4' : 'jpg'}`
    document.body.appendChild(a); a.click(); a.remove()
  }
  const iconBtn = { background: 'rgba(0,0,0,0.6)', border: 'none', color: '#fff', cursor: 'pointer', display: 'grid', placeItems: 'center', backdropFilter: 'blur(4px)' }

  return (
    <div onClick={() => onClose?.()} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', display: 'grid', placeItems: 'center', zIndex: 300, padding: 24 }}>
      <button onClick={(e) => { e.stopPropagation(); onClose?.() }} style={{ ...iconBtn, position: 'absolute', top: 16, right: 16, padding: 8, borderRadius: 8 }}><X size={16} /></button>
      <button onClick={(e) => { e.stopPropagation(); download() }} style={{ ...iconBtn, position: 'absolute', top: 16, right: 64, padding: '8px 12px', borderRadius: 8, fontSize: 12, gridAutoFlow: 'column', gap: 6, alignItems: 'center' }}><Download size={13} /> Download</button>

      {multi && (
        <button onClick={(e) => { e.stopPropagation(); prev() }} aria-label="Previous" style={{ ...iconBtn, position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', width: 44, height: 44, borderRadius: 999 }}><ChevronLeft size={22} /></button>
      )}
      {multi && (
        <button onClick={(e) => { e.stopPropagation(); next() }} aria-label="Next" style={{ ...iconBtn, position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)', width: 44, height: 44, borderRadius: 999 }}><ChevronRight size={22} /></button>
      )}

      {isVideo ? (
        <video src={url} controls autoPlay onClick={(e) => e.stopPropagation()} style={{ maxWidth: '92vw', maxHeight: '86vh', borderRadius: 8, background: '#000' }} />
      ) : (
        <img src={url} alt={`slide ${i + 1}`} onClick={(e) => e.stopPropagation()} style={{ maxWidth: '92vw', maxHeight: '86vh', borderRadius: 8, objectFit: 'contain' }} />
      )}

      {multi && (
        <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {list.map((_, idx) => (
              <button key={idx} onClick={() => setI(idx)} aria-label={`slide ${idx + 1}`}
                style={{ width: 8, height: 8, borderRadius: 999, border: 'none', cursor: 'pointer', padding: 0, background: idx === i ? '#fff' : 'rgba(255,255,255,0.4)' }} />
            ))}
          </div>
          <span style={{ color: '#fff', fontSize: 12.5, fontWeight: 600 }}>{i + 1} / {list.length}</span>
        </div>
      )}
    </div>
  )
}
