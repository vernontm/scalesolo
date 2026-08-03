import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Images, Sparkles, ArrowRight, AlertCircle, Check, RefreshCw, Upload, X, Lightbulb } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import MediaLightbox from '../components/MediaLightbox.jsx'

// Preset visual themes. `css` styles the live sample text; `key` matches the
// backend THEME_PROMPTS that steer the image model.
const THEMES = [
  { key: 'modern', label: 'Modern', css: { fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 800, letterSpacing: '-0.02em' } },
  { key: 'bold', label: 'Bold', css: { fontFamily: '"Arial Black", system-ui, sans-serif', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '-0.01em' } },
  { key: 'edgy', label: 'Edgy', css: { fontFamily: 'Impact, "Arial Black", sans-serif', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', fontStyle: 'italic' } },
  { key: 'cursive', label: 'Cursive', css: { fontFamily: '"Snell Roundhand", "Brush Script MT", cursive', fontStyle: 'italic', fontWeight: 600 } },
  { key: 'futuristic', label: 'Futuristic', css: { fontFamily: '"Courier New", monospace', textTransform: 'uppercase', letterSpacing: '0.16em', fontWeight: 700 } },
  { key: 'minimal', label: 'Minimal', css: { fontFamily: 'Georgia, "Times New Roman", serif', fontWeight: 400 } },
  { key: 'retro', label: 'Retro', css: { fontFamily: '"Courier New", monospace', fontWeight: 700, letterSpacing: '0.04em' } },
]

const PROGRESS_MSGS = [
  'Writing your slides in your brand voice…',
  'Designing the slide layouts…',
  'Rendering your slides…',
  'Adding your text and style…',
  'Polishing the details…',
  'Almost done…',
]

export default function CarouselBuilder() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  const navigate = useNavigate()

  const [topic, setTopic] = useState('')
  const [slides, setSlides] = useState(6)
  const [theme, setTheme] = useState('modern')
  const [extraStyle, setExtraStyle] = useState('')
  const [ideas, setIdeas] = useState([])
  const [ideasLoading, setIdeasLoading] = useState(false)
  const [refs, setRefs] = useState([])       // [{ url, selected }]
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [lightbox, setLightbox] = useState(null)
  const [progress, setProgress] = useState(null) // { pct, msg }
  const progressTimer = useRef(null)

  const refsKey = selectedProfileId ? `scalesolo.carousel.refs.${selectedProfileId}` : null

  // Load saved references (persist per brand, no re-upload) + topic ideas.
  useEffect(() => {
    if (!refsKey) return
    try { const s = JSON.parse(localStorage.getItem(refsKey) || '[]'); if (Array.isArray(s)) setRefs(s.map((u) => ({ url: u, selected: false }))) } catch {}
    fetchIdeas()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProfileId])

  const persistRefs = (list) => { try { if (refsKey) localStorage.setItem(refsKey, JSON.stringify(list.map((r) => r.url))) } catch {} }

  const fetchIdeas = async () => {
    if (!selectedProfileId) return
    setIdeasLoading(true)
    try {
      const r = await fetch('/api/carousels/ideas', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ profile_id: selectedProfileId }),
      })
      const b = await r.json().catch(() => ({}))
      if (Array.isArray(b.ideas)) setIdeas(b.ideas)
    } catch {} finally { setIdeasLoading(false) }
  }

  const uploadFiles = async (files) => {
    if (!selectedProfileId) { setError('Pick a brand profile first.'); return }
    const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (!imgs.length) return
    setUploading(true); setError(null)
    try {
      const added = []
      for (const file of imgs) {
        const initR = await fetch('/api/content/upload-media?mode=init', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ profile_id: selectedProfileId, content_type: file.type || 'image/jpeg', kind: 'image' }),
        })
        const init = await initR.json().catch(() => ({}))
        if (!init.signed_url) throw new Error(init.error || 'Upload init failed')
        const put = await fetch(init.signed_url, { method: 'PUT', headers: { Authorization: `Bearer ${init.token}`, 'Content-Type': file.type || 'image/jpeg', 'x-upsert': 'true' }, body: file })
        if (!put.ok) throw new Error('Upload failed')
        added.push({ url: init.public_url, selected: true })
      }
      setRefs((cur) => { const next = [...added, ...cur]; persistRefs(next); return next })
    } catch (e) { setError(e.message) } finally { setUploading(false) }
  }

  const toggleRef = (url) => setRefs((cur) => cur.map((r) => (r.url === url ? { ...r, selected: !r.selected } : r)))
  const removeRef = (url) => setRefs((cur) => { const next = cur.filter((r) => r.url !== url); persistRefs(next); return next })

  const startProgress = (expectMs) => {
    const t0 = Date.now()
    setProgress({ pct: 3, msg: PROGRESS_MSGS[0] })
    progressTimer.current = setInterval(() => {
      const pct = Math.min(92, Math.round(((Date.now() - t0) / expectMs) * 100))
      const msg = PROGRESS_MSGS[Math.min(PROGRESS_MSGS.length - 1, Math.floor((pct / 93) * PROGRESS_MSGS.length))]
      setProgress({ pct, msg })
    }, 400)
  }
  const stopProgress = (done) => {
    if (progressTimer.current) { clearInterval(progressTimer.current); progressTimer.current = null }
    if (done) { setProgress({ pct: 100, msg: 'Done!' }); setTimeout(() => setProgress(null), 700) } else setProgress(null)
  }
  useEffect(() => () => { if (progressTimer.current) clearInterval(progressTimer.current) }, [])

  const selectedRefs = refs.filter((r) => r.selected).map((r) => r.url)

  const generate = async () => {
    if (!topic.trim()) return
    if (!selectedProfileId) { setError('Pick a brand profile first.'); return }
    setBusy(true); setError(null); setResult(null)
    startProgress(slides * (selectedRefs.length ? 26000 : 15000))
    try {
      const r = await fetch('/api/carousels/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          profile_id: selectedProfileId, topic: topic.trim(), slide_count: slides,
          theme, extra_style: extraStyle.trim() || undefined,
          reference_urls: selectedRefs.length ? selectedRefs : undefined,
        }),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b?.error || `Generation failed (${r.status})`)
      stopProgress(true); setResult(b)
    } catch (e) { stopProgress(false); setError(e.message) } finally { setBusy(false) }
  }

  const themeCss = THEMES.find((t) => t.key === theme)?.css || {}
  const label = { fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }

  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {/* ── LEFT: preview ─────────────────────────────────────────────── */}
      <div style={{ flex: '1 1 320px', minWidth: 300, position: 'sticky', top: 12 }}>
        <div style={label}>Preview</div>
        {result ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(46,204,113,0.12)', color: '#2ecc71', border: '1px solid rgba(46,204,113,0.35)', padding: '9px 12px', borderRadius: 10, fontSize: 13, marginBottom: 12 }}>
              <Check size={15} /> In your backlog. Drag onto a slot to schedule.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8, marginBottom: 14 }}>
              {(result.images || []).map((u, i) => (
                <img key={u + i} src={u} alt={`slide ${i + 1}`} onClick={() => setLightbox(i)} title="Click to enlarge"
                  style={{ width: '100%', aspectRatio: '3 / 4', objectFit: 'cover', borderRadius: 8, background: '#000', border: '1px solid var(--border)', cursor: 'zoom-in' }} />
              ))}
            </div>
            {result.caption && (
              <div style={{ fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.55, whiteSpace: 'pre-wrap', padding: 11, background: 'var(--surface-2)', borderRadius: 10, border: '1px solid var(--border)', marginBottom: 12 }}>
                {result.caption}{result.hashtags ? `\n\n${result.hashtags}` : ''}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-primary" onClick={() => navigate('/schedule')} style={{ flex: 1, justifyContent: 'center' }}>Go schedule it <ArrowRight size={15} /></button>
              <button className="btn-secondary" onClick={() => { setResult(null) }}>New</button>
            </div>
            {lightbox !== null && <MediaLightbox images={result.images || []} startIndex={lightbox} title={result.title} onClose={() => setLightbox(null)} />}
          </div>
        ) : (
          // Empty state: a theme-styled cover mock so the vibe is visible.
          <div style={{ aspectRatio: '3 / 4', borderRadius: 14, border: '1px dashed var(--border)', background: 'var(--surface)', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
            <div>
              <div style={{ ...themeCss, fontSize: 30, color: 'var(--text)', lineHeight: 1.1, marginBottom: 10 }}>
                {topic ? topic.split(' ').slice(0, 6).join(' ') : 'Your headline'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Slides appear here after you generate.</div>
            </div>
          </div>
        )}
      </div>

      {/* ── RIGHT: form ───────────────────────────────────────────────── */}
      <div style={{ flex: '1 1 420px', minWidth: 320 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'rgba(168,85,247,0.14)', color: '#a855f7' }}><Images size={19} /></div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 21, fontWeight: 800 }}>Carousel builder</h2>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 18 }}>Give it a topic, pick a look, add any references. It designs the slides and drops a captioned carousel in your backlog.</p>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 18 }}>
          {/* Topic + AI ideas */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ ...label, marginBottom: 0, flex: 1 }}>Topic</div>
              <button onClick={fetchIdeas} disabled={ideasLoading} title="New ideas" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>
                <RefreshCw size={12} style={{ animation: ideasLoading ? 'spin 1s linear infinite' : 'none' }} /> Ideas
              </button>
            </div>
            {ideas.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {ideas.map((idea, i) => (
                  <button key={i} onClick={() => setTopic(idea)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '5px 10px', borderRadius: 999, cursor: 'pointer', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-soft)', textAlign: 'left' }}>
                    <Lightbulb size={12} style={{ color: '#a855f7', flexShrink: 0 }} /> {idea}
                  </button>
                ))}
              </div>
            )}
            <textarea className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Type a topic, or click an idea above…" rows={2} style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }} />
          </div>

          {/* Slides */}
          <div style={{ marginBottom: 16 }}>
            <div style={label}>Slides</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {[4, 5, 6, 7, 8].map((n) => (
                <button key={n} onClick={() => setSlides(n)} style={{ width: 42, height: 38, borderRadius: 9, cursor: 'pointer', fontWeight: 700, border: `1px solid ${slides === n ? '#a855f7' : 'var(--border)'}`, background: slides === n ? 'rgba(168,85,247,0.14)' : 'var(--surface-2)', color: slides === n ? '#a855f7' : 'var(--text)' }}>{n}</button>
              ))}
            </div>
          </div>

          {/* Theme */}
          <div style={{ marginBottom: 16 }}>
            <div style={label}>Style</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 8 }}>
              {THEMES.map((t) => (
                <button key={t.key} onClick={() => setTheme(t.key)} style={{ padding: '10px 6px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${theme === t.key ? '#a855f7' : 'var(--border)'}`, background: theme === t.key ? 'rgba(168,85,247,0.10)' : 'var(--surface-2)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <span style={{ ...t.css, fontSize: 22, color: 'var(--text)', lineHeight: 1 }}>Aa</span>
                  <span style={{ fontSize: 11, color: theme === t.key ? '#a855f7' : 'var(--muted)', fontWeight: 600 }}>{t.label}</span>
                </button>
              ))}
            </div>
            <input className="input" value={extraStyle} onChange={(e) => setExtraStyle(e.target.value)} placeholder="Optional: extra style notes (e.g. navy + gold, hand-drawn accents)" style={{ width: '100%', boxSizing: 'border-box', marginTop: 8, fontSize: 12.5 }} />
          </div>

          {/* References */}
          <div style={{ marginBottom: 16 }}>
            <div style={label}>References <span style={{ textTransform: 'none', fontWeight: 500 }}>(people, logos, products — optional)</span></div>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); uploadFiles(e.dataTransfer.files) }}
              style={{ border: `1.5px dashed ${dragOver ? '#a855f7' : 'var(--border)'}`, background: dragOver ? 'rgba(168,85,247,0.08)' : 'var(--surface-2)', borderRadius: 10, padding: 14, textAlign: 'center', transition: 'all .12s' }}
            >
              <Upload size={18} style={{ color: 'var(--muted)', marginBottom: 4 }} />
              <div style={{ fontSize: 12.5, color: 'var(--text-soft)' }}>
                Drag images here, or <label style={{ color: '#a855f7', cursor: 'pointer', fontWeight: 600 }}>browse<input type="file" accept="image/*" multiple hidden onChange={(e) => { uploadFiles(e.target.files); e.target.value = '' }} /></label>
                {uploading && ' · uploading…'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Saved for next time. Click a thumbnail to use it in this carousel.</div>
            </div>
            {refs.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                {refs.map((r) => (
                  <div key={r.url} style={{ position: 'relative' }}>
                    <img src={r.url} alt="" onClick={() => toggleRef(r.url)} title={r.selected ? 'Using in this carousel' : 'Click to use'}
                      style={{ width: 54, height: 54, borderRadius: 8, objectFit: 'cover', cursor: 'pointer', border: `2px solid ${r.selected ? '#a855f7' : 'var(--border)'}`, opacity: r.selected ? 1 : 0.6 }} />
                    {r.selected && <div style={{ position: 'absolute', bottom: -4, right: -4, background: '#a855f7', color: '#fff', borderRadius: 999, width: 16, height: 16, display: 'grid', placeItems: 'center' }}><Check size={10} /></div>}
                    <button onClick={() => removeRef(r.url)} title="Remove" style={{ position: 'absolute', top: -6, left: -6, width: 16, height: 16, borderRadius: 999, border: 'none', background: 'rgba(0,0,0,0.7)', color: '#fff', cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 0 }}><X size={10} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && <div style={{ marginBottom: 14, background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13 }}><AlertCircle size={14} style={{ verticalAlign: '-2px' }} /> {error}</div>}
          <button className="btn-primary" onClick={generate} disabled={busy || uploading || !topic.trim()} style={{ width: '100%', justifyContent: 'center' }}>
            <Sparkles size={15} /> Generate carousel
          </button>
          <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>
            ~{(4000 * slides).toLocaleString()} AI tokens ({slides} slides{selectedRefs.length ? `, ${selectedRefs.length} ref${selectedRefs.length > 1 ? 's' : ''}` : ''}). Nothing posts automatically.
          </div>
        </div>
      </div>

      {/* ── Progress popup ────────────────────────────────────────────── */}
      {progress && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', zIndex: 300, backdropFilter: 'blur(3px)' }}>
          <div style={{ width: 'min(90vw, 360px)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 26, textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
            <div style={{ width: 54, height: 54, margin: '0 auto 14px', borderRadius: 14, display: 'grid', placeItems: 'center', background: 'rgba(168,85,247,0.14)', color: '#a855f7', animation: 'pulse 1.4s ease-in-out infinite' }}>
              <Images size={26} />
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Building your carousel</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', minHeight: 34, marginBottom: 14 }}>{progress.msg}</div>
            <div style={{ height: 8, borderRadius: 999, background: 'var(--surface-3, var(--surface-2))', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${progress.pct}%`, background: 'linear-gradient(90deg, #a855f7, #ec4899)', borderRadius: 999, transition: 'width .4s ease' }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>{progress.pct}%</div>
          </div>
          <style>{`@keyframes pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.08);opacity:.75}}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      )}
    </div>
  )
}
