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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const generate = async () => {
    if (!topic.trim()) return
    if (!selectedProfileId) { setError('Pick a brand profile first.'); return }
    setBusy(true); setError(null); setResult(null)
    try {
      const r = await fetch('/api/carousels/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ profile_id: selectedProfileId, topic: topic.trim(), slide_count: slides }),
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
          {error && <div style={{ marginBottom: 14, background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13 }}><AlertCircle size={14} style={{ verticalAlign: '-2px' }} /> {error}</div>}
          <button className="btn-primary" onClick={generate} disabled={busy || !topic.trim()} style={{ width: '100%', justifyContent: 'center' }}>
            {busy ? <><span className="spinner" /> Designing {slides} slides… (~1-2 min)</> : <><Sparkles size={15} /> Generate carousel</>}
          </button>
          <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>
            ~{(4000 * slides).toLocaleString()} AI tokens ({slides} slides). Nothing posts automatically.
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
