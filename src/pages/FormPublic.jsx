// Public, unauthenticated form render page at /f/:slug
// Note: requires the URL to also include the profile_id via query (?p=<id>) OR
// we look up by global unique slug — in this simple v1 we assume slug+profile.
// For now: parse from path /f/:slug and require profile via ?p=...
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Zap, CheckCircle2 } from 'lucide-react'
import ThemeToggle from '../components/ThemeToggle.jsx'

const page = {
  minHeight: '100vh',
  display: 'grid',
  placeItems: 'center',
  padding: 32,
}
const card = {
  width: '100%', maxWidth: 520,
  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 18,
  padding: 36, boxShadow: 'var(--shadow-pop)',
}
const cornerStyle = { position: 'fixed', top: 18, right: 18, zIndex: 5 }
const brand = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24 }
const brandIcon = {
  width: 32, height: 32, borderRadius: 9, display: 'grid', placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))', color: '#fff',
}

export default function FormPublic() {
  const { slug } = useParams()
  const [params] = useSearchParams()
  const profileId = params.get('p')
  const [form, setForm] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [values, setValues] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(null)

  useEffect(() => {
    // Lookup the form by slug using the public form-by-slug GET (we also expose form JSON via /api/forms?slug=&p=)
    if (!slug) return
    fetch(`/api/forms-public?slug=${encodeURIComponent(slug)}${profileId ? `&p=${profileId}` : ''}`)
      .then((r) => r.json())
      .then((body) => {
        if (body.error) throw new Error(body.error)
        setForm(body.form)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [slug, profileId])

  const handleChange = (id, value) => setValues((v) => ({ ...v, [id]: value }))

  const submit = async (e) => {
    e.preventDefault()
    if (!form) return
    setSubmitting(true); setError(null)
    try {
      const r = await fetch('/api/forms/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ form_id: form.id, payload: values, source_url: window.location.href }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Submission failed')
      setSubmitted(body.confirmation || { kind: 'message', message: 'Thanks — we got it.' })
      if (body.confirmation?.kind === 'redirect' && body.confirmation.url) {
        setTimeout(() => { window.location.href = body.confirmation.url }, 800)
      }
    } catch (e) { setError(e.message) }
    finally { setSubmitting(false) }
  }

  if (loading) return <div style={page}><div className="spinner" /></div>

  if (submitted) {
    return (
      <div style={page}>
        <div style={cornerStyle}><ThemeToggle /></div>
        <div style={card} className="fade-up">
          <div style={{ textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: 14, background: 'rgba(46,204,113,0.16)', color: '#2ecc71', display: 'grid', placeItems: 'center', margin: '0 auto 18px' }}>
              <CheckCircle2 size={28} />
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 20, marginBottom: 8 }}>
              {submitted.kind === 'redirect' ? 'Redirecting…' : 'You\'re all set'}
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 14 }}>
              {submitted.message || 'Thanks — we got it.'}
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!form) {
    return (
      <div style={page}>
        <div style={card} className="fade-up">
          <div style={{ textAlign: 'center', color: 'var(--muted)' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18, color: 'var(--text)', marginBottom: 8 }}>
              Form not found
            </div>
            <div style={{ fontSize: 13 }}>{error || "This form doesn't exist or isn't published."}</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={page}>
      <div style={cornerStyle}><ThemeToggle /></div>
      <form style={card} onSubmit={submit} className="fade-up">
        <div style={brand}>
          <div style={brandIcon}><Zap size={16} strokeWidth={2.5} /></div>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: 'var(--text-soft)' }}>
            Powered by ScaleSolo
          </div>
        </div>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 24, marginBottom: 22, letterSpacing: '-0.01em' }}>
          {form.name}
        </div>
        <input type="text" name="hp" tabIndex={-1} autoComplete="off" style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
          onChange={(e) => handleChange('hp', e.target.value)} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {(form.sections || []).flatMap((s) => s.fields || []).map((field) => (
            <FieldRender key={field.id} field={field} value={values[field.id] || ''} onChange={(v) => handleChange(field.id, v)} />
          ))}
        </div>
        {error && <div style={{ marginTop: 16, padding: '10px 14px', background: 'var(--red-soft)', color: 'var(--red)', borderRadius: 10, fontSize: 13 }}>{error}</div>}
        <button type="submit" className="btn-primary" style={{ marginTop: 22, width: '100%', justifyContent: 'center' }} disabled={submitting}>
          {submitting ? <span className="spinner" /> : null} Submit
        </button>
      </form>
    </div>
  )
}

function FieldRender({ field, value, onChange }) {
  const common = { id: field.id, required: !!field.required, placeholder: field.placeholder || '' }
  const opts = Array.isArray(field.options) ? field.options : []

  if (field.type === 'textarea') {
    return (
      <div>
        <label className="label" htmlFor={field.id}>{field.label}{field.required && <span style={{ color: 'var(--red)' }}> *</span>}</label>
        <textarea className="textarea" {...common} value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    )
  }
  if (field.type === 'dropdown') {
    return (
      <div>
        <label className="label" htmlFor={field.id}>{field.label}{field.required && <span style={{ color: 'var(--red)' }}> *</span>}</label>
        <select className="select" {...common} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    )
  }
  if (field.type === 'multi-choice' || field.type === 'checkbox') {
    return (
      <div>
        <div className="label">{field.label}{field.required && <span style={{ color: 'var(--red)' }}> *</span>}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {opts.map((o) => (
            <label key={o} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-soft)' }}>
              <input
                type={field.type === 'checkbox' ? 'checkbox' : 'radio'}
                name={field.id}
                value={o}
                checked={field.type === 'checkbox' ? (Array.isArray(value) ? value.includes(o) : false) : value === o}
                onChange={(e) => {
                  if (field.type === 'checkbox') {
                    const cur = Array.isArray(value) ? value : []
                    onChange(e.target.checked ? [...cur, o] : cur.filter((x) => x !== o))
                  } else {
                    onChange(o)
                  }
                }}
              /> {o}
            </label>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div>
      <label className="label" htmlFor={field.id}>{field.label}{field.required && <span style={{ color: 'var(--red)' }}> *</span>}</label>
      <input className="input" type={field.type} {...common} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}
