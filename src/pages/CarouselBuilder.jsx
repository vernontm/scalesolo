import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Images, Sparkles, ArrowRight, AlertCircle, Check } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'

// Streamlined carousel builder: topic + slide count → branded slides →
// captioned draft in the backlog. One screen, one action.
export default function CarouselBuilder() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  const navigate = useNavigate()

  const [topic, setTopic] = useState('')
  const [slides, setSlides] = useState(6)
  const [personMode, setPersonMode] = useState(false)
  const [personUrls, setPersonUrls] = useState([])
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const perSlide = personMode ? 8000 : 4000

  const uploadPhotos = async (files) => {
    if (!selectedProfileId) { setError('Pick a brand profile first.'); return }
    setUploading(true); setError(null)
    try {
      const out = []
      for (const file of Array.from(files).slice(0, 3 - personUrls.length)) {
        const initR = await fetch('/api/content/upload-media?mode=init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ profile_id: selectedProfileId, content_type: file.type || 'image/jpeg', kind: 'image' }),
        })
        const init = await initR.json().catch(() => ({}))
        if (!init.signed_url) throw new Error(init.error || 'Upload init failed')
        const put = await fetch(init.signed_url, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${init.token}`, 'Content-Type': file.type || 'image/jpeg', 'x-upsert': 'true' },
          body: file,
        })
        if (!put.ok) throw new Error('Photo upload failed')
        out.push(init.public_url)
      }
      setPersonUrls((u) => [...u, ...out].slice(0, 3))
    } catch (e) { setError(e.message) } finally { setUploading(false) }
  }

  const generate = async () => {
    if (!topic.trim()) return
    if (!selectedProfileId) { setError('Pick a brand profile first.'); return }
    if (personMode && !personUrls.length) { setError('Add at least one photo of the person, or turn off “Put me in it”.'); return }
    setBusy(true); setError(null); setResult(null)
    try {
      const r = await fetch('/api/carousels/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          profile_id: selectedProfileId, topic: topic.trim(), slide_count: slides,
          person_mode: personMode, reference_urls: personMode ? personUrls : undefined,
        }),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b?.error || `Generation failed (${r.status})`)
      setResult(b)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const label = { fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'rgba(168,85,247,0.14)', color: '#a855f7' }}><Images size={20} /></div>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800 }}>Carousel builder</h2>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 13.5, marginBottom: 22 }}>
        Give it a topic. It writes the slides in your brand voice, designs each one, and drops a captioned carousel in your backlog to schedule.
      </p>

      {!result && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 18 }}>
          <div style={{ marginBottom: 16 }}>
            <div style={label}>Topic</div>
            <textarea
              className="input"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. 5 AI tools every small business owner needs in 2026"
              rows={3}
              style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>
          <div style={{ marginBottom: 18 }}>
            <div style={label}>Slides</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {[4, 5, 6, 7, 8].map((n) => (
                <button key={n} onClick={() => setSlides(n)}
                  style={{
                    width: 44, height: 40, borderRadius: 9, cursor: 'pointer', fontWeight: 700,
                    border: `1px solid ${slides === n ? '#a855f7' : 'var(--border)'}`,
                    background: slides === n ? 'rgba(168,85,247,0.14)' : 'var(--surface-2)',
                    color: slides === n ? '#a855f7' : 'var(--text)',
                  }}>{n}</button>
              ))}
            </div>
          </div>
          {/* Put me in it — two-stage likeness (Seedream portrait → composed graphic). */}
          <div style={{ marginBottom: 16, padding: 12, borderRadius: 10, border: `1px solid ${personMode ? '#a855f7' : 'var(--border)'}`, background: 'var(--surface-2)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={personMode} onChange={(e) => setPersonMode(e.target.checked)} />
              <span style={{ fontWeight: 700, fontSize: 13.5 }}>Put me in it</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Use a person's likeness on every slide</span>
            </label>
            {personMode && (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  {personUrls.map((u, i) => (
                    <img key={u + i} src={u} alt="" style={{ width: 52, height: 52, borderRadius: 8, objectFit: 'cover', border: '1px solid var(--border)' }} />
                  ))}
                  {personUrls.length < 3 && (
                    <label className="btn-secondary" style={{ cursor: 'pointer', padding: '8px 12px', fontSize: 12.5 }}>
                      {uploading ? 'Uploading…' : '+ Add photo'}
                      <input type="file" accept="image/*" multiple hidden onChange={(e) => { uploadPhotos(e.target.files); e.target.value = '' }} />
                    </label>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                  1 to 3 clear, front-facing photos. More references = better likeness. Costs 2x (a portrait plus the composed graphic per slide).
                </div>
              </div>
            )}
          </div>

          {error && <div style={{ marginBottom: 14, background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13 }}><AlertCircle size={14} style={{ verticalAlign: '-2px' }} /> {error}</div>}
          <button className="btn-primary" onClick={generate} disabled={busy || uploading || !topic.trim()} style={{ width: '100%', justifyContent: 'center' }}>
            {busy ? <><span className="spinner" /> Designing {slides} slides… (~1-3 min)</> : <><Sparkles size={15} /> Generate carousel</>}
          </button>
          <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>
            ~{(perSlide * slides).toLocaleString()} AI tokens ({slides} slides{personMode ? ', with likeness' : ''}). Nothing posts automatically.
          </div>
        </div>
      )}

      {result && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(46,204,113,0.12)', color: '#2ecc71', border: '1px solid rgba(46,204,113,0.35)', padding: '10px 14px', borderRadius: 10, fontSize: 13.5, marginBottom: 16 }}>
            <Check size={16} /> Carousel “{result.title}” is in your backlog. Drag it onto a slot to schedule.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, marginBottom: 16 }}>
            {(result.images || []).map((u, i) => (
              <img key={u + i} src={u} alt={`slide ${i + 1}`} style={{ width: '100%', aspectRatio: '3 / 4', objectFit: 'cover', borderRadius: 8, background: '#000', border: '1px solid var(--border)' }} />
            ))}
          </div>
          {result.caption && (
            <div style={{ marginBottom: 16 }}>
              <div style={label}>Caption</div>
              <div style={{ fontSize: 13.5, color: 'var(--text-soft)', lineHeight: 1.6, whiteSpace: 'pre-wrap', padding: 12, background: 'var(--surface-2)', borderRadius: 10, border: '1px solid var(--border)' }}>{result.caption}{result.hashtags ? `\n\n${result.hashtags}` : ''}</div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" onClick={() => navigate('/schedule')} style={{ flex: 1, justifyContent: 'center' }}>
              Go schedule it <ArrowRight size={15} />
            </button>
            <button className="btn-secondary" onClick={() => { setResult(null); setTopic('') }}>Make another</button>
          </div>
        </div>
      )}
    </div>
  )
}
