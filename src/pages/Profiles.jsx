import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Plus, Building2, Edit3, Trash2, X, Save, Sparkles, Check, Crown,
  Upload, ClipboardCopy, MessageSquare, Wand2, Loader2, ChevronRight,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'

const grid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
  gap: 14,
  marginTop: 14,
}
const cardStyle = (active) => ({
  background: 'var(--surface)',
  border: active ? '1px solid rgba(239,68,68,0.45)' : '1px solid var(--border)',
  borderRadius: 14,
  padding: 18,
  cursor: 'pointer',
  position: 'relative',
  transition: 'transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
  boxShadow: active ? '0 12px 28px rgba(239,68,68,0.18)' : 'none',
})
const tagPill = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  background: 'var(--red-soft)', color: 'var(--red)',
  fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 600,
  padding: '3px 8px', borderRadius: 999,
}
const initialsStyle = (color) => ({
  width: 44, height: 44, borderRadius: 12,
  display: 'grid', placeItems: 'center',
  background: color || 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16,
  boxShadow: '0 6px 14px rgba(0,0,0,0.20)',
})

const FORM_DEFAULTS = {
  business_name: '',
  industry: '',
  business_type: '',
  website_url: '',
  brand_bible: '',
  brand_primary_color: '#ef4444',
  brand_secondary_color: '',
  preferred_tone: '',
  target_audience: '',
  core_hashtags: '',
  instagram_handle: '',
  tiktok_handle: '',
  youtube_handle: '',
  linkedin_handle: '',
  threads_handle: '',
  x_handle: '',
}

function initialsOf(name) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('') || '?'
}

function ProfileEditor({ profile, onClose, onSaved }) {
  const { session } = useAuth()
  const isNew = !profile?.id
  const [form, setForm] = useState({ ...FORM_DEFAULTS, ...(profile || {}) })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [helper, setHelper] = useState(null)  // 'paste' | 'prompt' | 'interview' | null

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  // Merge a parsed-fields object from any of the three helpers into the
  // current form. Empty/null values from the helper don't overwrite.
  const mergeFields = (fields) => {
    if (!fields || typeof fields !== 'object') return
    setForm((f) => {
      const next = { ...f }
      for (const [k, v] of Object.entries(fields)) {
        if (v == null) continue
        if (typeof v === 'string' && !v.trim()) continue
        if (Array.isArray(v) && !v.length) continue
        next[k] = v
      }
      return next
    })
    setHelper(null)
  }

  const save = async () => {
    if (!form.business_name?.trim()) {
      setError('Business name is required.')
      return
    }
    setBusy(true); setError(null)
    try {
      // Strip context-side helpers + read-only columns before sending.
      const STRIP = new Set([
        '_role', '_allowed_pages', 'role', 'allowed_pages',
        'created_at', 'updated_at',
      ])
      const clean = Object.fromEntries(Object.entries(form).filter(([k]) => !STRIP.has(k)))
      const r = await fetch('/api/profiles', {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(isNew ? clean : { id: profile.id, ...clean }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Save failed')
      onSaved(body.profile)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  // Portal the modal to document.body so it can't be clipped or constrained
  // by any ancestor (overflow, transform, contain, backdrop-filter, etc.).
  return createPortal((
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-xl" onClick={(e) => e.stopPropagation()} style={{ minHeight: '60vh' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, flex: 1 }}>
            {isNew ? 'Create a brand profile' : 'Edit brand profile'}
          </h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={20} /></button>
        </div>

        {/* Bible-import shortcuts. All three feed back into the same form
            via mergeFields() so users can review before saving. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
          <button type="button" className="btn-ghost" onClick={() => setHelper('paste')} style={{ fontSize: 12 }}>
            <Upload size={13} /> Import bible (paste)
          </button>
          <button type="button" className="btn-ghost" onClick={() => setHelper('prompt')} style={{ fontSize: 12 }}>
            <ClipboardCopy size={13} /> Get extraction prompt
          </button>
          <button type="button" className="btn-ghost" onClick={() => setHelper('interview')} style={{ fontSize: 12 }}>
            <MessageSquare size={13} /> Brand interview
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label="Business name" required>
            <input className="input" value={form.business_name} onChange={(e) => set('business_name', e.target.value)} placeholder="ScaleSolo" autoFocus />
          </Field>
          <Field label="Industry">
            <input className="input" value={form.industry || ''} onChange={(e) => set('industry', e.target.value)} placeholder="Coaching, e-commerce, etc." />
          </Field>
          <Field label="Business type">
            <select className="select" value={form.business_type || ''} onChange={(e) => set('business_type', e.target.value)}>
              <option value="">Choose…</option>
              <option value="creator">Creator</option>
              <option value="coach">Coach</option>
              <option value="consultant">Consultant</option>
              <option value="ecommerce">E-commerce</option>
              <option value="freelancer">Freelancer</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Website">
            <input className="input" value={form.website_url || ''} onChange={(e) => set('website_url', e.target.value)} placeholder="https://yourbrand.com" />
          </Field>
          <Field label="Preferred tone">
            <input className="input" value={form.preferred_tone || ''} onChange={(e) => set('preferred_tone', e.target.value)} placeholder="Direct, candid, action-oriented" />
          </Field>
          <Field label="Target audience">
            <input className="input" value={form.target_audience || ''} onChange={(e) => set('target_audience', e.target.value)} placeholder="Solopreneurs scaling past $10k/mo" />
          </Field>
          <Field label="Brand primary color">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="color" value={form.brand_primary_color || '#ef4444'} onChange={(e) => set('brand_primary_color', e.target.value)} style={{ width: 44, height: 40, border: '1px solid var(--border)', borderRadius: 8, background: 'transparent', padding: 0, cursor: 'pointer' }} />
              <input className="input" value={form.brand_primary_color || ''} onChange={(e) => set('brand_primary_color', e.target.value)} placeholder="#ef4444" />
            </div>
          </Field>
          <Field label="Brand secondary color">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="color"
                value={form.brand_secondary_color || '#b91c1c'}
                onChange={(e) => set('brand_secondary_color', e.target.value)}
                style={{ width: 44, height: 40, border: '1px solid var(--border)', borderRadius: 8, background: 'transparent', padding: 0, cursor: 'pointer' }}
              />
              <input
                className="input"
                value={form.brand_secondary_color || ''}
                onChange={(e) => set('brand_secondary_color', e.target.value)}
                placeholder="#b91c1c"
              />
            </div>
          </Field>
        </div>

        <div style={{ marginTop: 14 }}>
          <Field label={
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              Brand bible
              <span className="pill pill-muted" style={{ marginLeft: 6 }}><Sparkles size={10} /> Embedded for AI CEO</span>
            </span>
          }>
            <textarea
              className="textarea"
              style={{ minHeight: 260, width: '100%' }}
              value={form.brand_bible || ''}
              onChange={(e) => set('brand_bible', e.target.value)}
              placeholder={`Voice: direct, candid, never preachy.\nAudience: solopreneurs scaling past $10k/mo.\nOffer: AI-native operating system.\nDo-not-say: "synergy", "leverage" as a verb.\nSignature phrases: "ship it", "10x the brand".`}
            />
          </Field>
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
            Social handles (without @)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            {[
              ['instagram_handle', 'Instagram'],
              ['tiktok_handle',    'TikTok'],
              ['youtube_handle',   'YouTube'],
              ['linkedin_handle',  'LinkedIn'],
              ['threads_handle',   'Threads'],
              ['x_handle',         'X / Twitter'],
            ].map(([key, label]) => (
              <Field key={key} label={label}>
                <input className="input" value={form[key] || ''} onChange={(e) => set(key, e.target.value)} placeholder="handle" />
              </Field>
            ))}
          </div>
        </div>

        {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginTop: 14 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            {busy ? <span className="spinner" /> : <Save size={14} />}
            {isNew ? 'Create profile' : 'Save changes'}
          </button>
        </div>
      </div>

      {helper === 'paste' && (
        <BiblePasteModal
          token={session.access_token}
          profileId={profile?.id}
          onClose={() => setHelper(null)}
          onApply={mergeFields}
        />
      )}
      {helper === 'prompt' && (
        <PromptHelperModal
          onClose={() => setHelper(null)}
          onApply={mergeFields}
        />
      )}
      {helper === 'interview' && (
        <InterviewModal
          onClose={() => setHelper(null)}
          onApply={mergeFields}
        />
      )}
    </div>
  ), document.body)
}

// ─── Bible paste modal — paste raw text, Claude parses, preview & apply ────
function BiblePasteModal({ token, profileId, onClose, onApply }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [parsed, setParsed] = useState(null)
  const [error, setError] = useState(null)
  const parse = async () => {
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/profiles/parse-bible', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile_id: profileId, raw_text: text }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Parse failed')
      setParsed(body.fields)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  const fieldRows = parsed ? Object.entries(parsed).filter(([, v]) => v != null && (typeof v === 'string' ? v.trim() : true)) : []
  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 110 }}>
      <div className="modal-card modal-card-lg" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <Upload size={18} style={{ color: 'var(--red)' }} />
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, flex: 1 }}>Import a brand bible</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={18} /></button>
        </div>
        {!parsed ? (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.5 }}>
              Paste your brand bible, voice doc, or any prose that describes your brand. Claude will extract structured fields (voice, audience, colors, fonts, handles, etc.) you can review before applying.
            </div>
            <textarea
              className="textarea"
              style={{ minHeight: 240, width: '100%' }}
              placeholder="Paste raw text here…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn-primary" onClick={parse} disabled={busy || !text.trim()}>
                {busy ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />} Parse with Claude
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>
              Review the extracted fields. Apply to fill the form, then save when you're happy.
            </div>
            <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
              {fieldRows.map(([k, v]) => (
                <div key={k} style={{ marginBottom: 8 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{k}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
                    {typeof v === 'string' ? v : JSON.stringify(v, null, 2)}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 14 }}>
              <button className="btn-secondary" onClick={() => setParsed(null)}>Back</button>
              <button className="btn-primary" onClick={() => onApply(parsed)}>
                <Check size={13} /> Apply {fieldRows.length} fields
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Prompt-helper modal — copyable prompt + paste-back JSON ───────────────
const EXTRACTION_PROMPT = `You are extracting a brand identity. Output ONLY a JSON object with these keys (omit any you can't infer):

{
  "business_name": "string",
  "industry": "string",
  "preferred_tone": "comma-separated voice descriptors",
  "target_audience": "string",
  "brand_primary_color": "#rrggbb",
  "brand_secondary_color": "#rrggbb",
  "brand_colors": [{ "name": "string", "hex": "#rrggbb" }],
  "brand_fonts":  [{ "name": "string", "usage": "display|body|mono" }],
  "logo_url": "https://...",
  "website_url": "https://...",
  "core_hashtags": "#tag1 #tag2",
  "instagram_handle": "no @",
  "tiktok_handle": "no @",
  "youtube_handle": "no @",
  "linkedin_handle": "no @",
  "threads_handle": "no @",
  "x_handle": "no @",
  "brand_bible": "<long-form: voice, audience, offer, do-not-say, signature phrases>",
  "brand_bible_summary": "<≤120 words, plain prose>"
}

Rules:
- Only use info I provide or that's strongly implied by it.
- Hex colors must be #rrggbb. Skip any color you don't have a hex for.
- Never use em dashes anywhere.

My brand: <DESCRIBE YOUR BRAND IN A FEW SENTENCES OR PASTE EXISTING DOCS HERE>`

function PromptHelperModal({ onClose, onApply }) {
  const [pasted, setPasted] = useState('')
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const apply = () => {
    setError(null)
    try {
      const m = pasted.match(/\{[\s\S]*\}/)?.[0]
      if (!m) { setError('No JSON found in paste'); return }
      const fields = JSON.parse(m)
      onApply(fields)
    } catch (e) { setError(`Invalid JSON: ${e.message}`) }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(EXTRACTION_PROMPT); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }
  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 110 }}>
      <div className="modal-card modal-card-lg" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <ClipboardCopy size={18} style={{ color: 'var(--red)' }} />
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, flex: 1 }}>Get an extraction prompt</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
          Step 1. Copy this prompt and paste it into ChatGPT, Claude, or any AI you use. Replace the bracketed placeholder with your brand info or paste docs there.
        </div>
        <div style={{ position: 'relative', marginBottom: 14 }}>
          <pre style={{
            background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8,
            padding: 12, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-soft)',
            whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto', margin: 0,
          }}>{EXTRACTION_PROMPT}</pre>
          <button
            type="button"
            onClick={copy}
            style={{
              position: 'absolute', top: 6, right: 6, fontSize: 11,
              padding: '4px 9px', borderRadius: 999, cursor: 'pointer',
              background: copied ? 'rgba(46,204,113,0.18)' : 'var(--surface)',
              border: `1px solid ${copied ? '#2ecc71' : 'var(--border)'}`,
              color: copied ? '#2ecc71' : 'var(--text)',
            }}
          >{copied ? 'Copied' : 'Copy prompt'}</button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
          Step 2. Paste the JSON the AI gives you back, then apply.
        </div>
        <textarea
          className="textarea"
          style={{ minHeight: 160, width: '100%', fontFamily: 'monospace', fontSize: 11.5 }}
          placeholder='{"business_name": "...", "preferred_tone": "..."}'
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
        />
        {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={apply} disabled={!pasted.trim()}>
            <Check size={13} /> Apply
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Interview wizard — 8 questions, builds the form step by step ──────────
const INTERVIEW_STEPS = [
  { key: 'business_name',   label: "What's your business name?",   placeholder: 'ScaleSolo' },
  { key: 'industry',        label: 'Industry / niche?',            placeholder: 'AI for solopreneurs' },
  { key: 'target_audience', label: 'Who do you sell to? Describe them in one sentence.', placeholder: 'Solopreneurs scaling past $10k/mo using AI' },
  { key: 'preferred_tone',  label: 'Brand voice — 3 to 5 adjectives.', placeholder: 'Direct, candid, action-oriented' },
  { key: 'offer',           label: 'What do you offer? Free-form.', placeholder: 'AI-native operating system for solo founders', textarea: true },
  { key: 'do_not_say',      label: 'Words or phrases you would NEVER use? (Optional)', placeholder: '"synergy", "leverage" as a verb', textarea: true },
  { key: 'brand_primary_color', label: 'Primary brand color (hex)', placeholder: '#ef4444', color: true },
  { key: 'core_hashtags',   label: 'Signature hashtags? (Optional)', placeholder: '#scalesolo #aitools' },
]

function InterviewModal({ onClose, onApply }) {
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState({})
  const cur = INTERVIEW_STEPS[step]
  const last = step === INTERVIEW_STEPS.length - 1

  const next = () => last ? finish() : setStep(step + 1)
  const back = () => setStep(Math.max(0, step - 1))
  const finish = () => {
    const fields = { ...answers }
    // Bake the offer + do_not_say into a starter brand_bible if user filled them.
    const bible = []
    if (answers.preferred_tone)  bible.push(`Voice: ${answers.preferred_tone}`)
    if (answers.target_audience) bible.push(`Audience: ${answers.target_audience}`)
    if (answers.offer)           bible.push(`Offer: ${answers.offer}`)
    if (answers.do_not_say)      bible.push(`Do-not-say: ${answers.do_not_say}`)
    if (bible.length) fields.brand_bible = bible.join('\n')
    delete fields.offer
    delete fields.do_not_say
    onApply(fields)
  }

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 110 }}>
      <div className="modal-card modal-card-md" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <MessageSquare size={18} style={{ color: 'var(--red)' }} />
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, flex: 1 }}>Brand interview</h3>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{step + 1} / {INTERVIEW_STEPS.length}</span>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={18} /></button>
        </div>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, color: 'var(--text)', marginBottom: 10 }}>
          {cur.label}
        </div>
        {cur.color ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="color"
              value={answers[cur.key] || '#ef4444'}
              onChange={(e) => setAnswers({ ...answers, [cur.key]: e.target.value })}
              style={{ width: 50, height: 44, border: '1px solid var(--border)', borderRadius: 8, background: 'transparent', padding: 0, cursor: 'pointer' }}
            />
            <input className="input" value={answers[cur.key] || ''} onChange={(e) => setAnswers({ ...answers, [cur.key]: e.target.value })} placeholder={cur.placeholder} />
          </div>
        ) : cur.textarea ? (
          <textarea className="textarea" style={{ minHeight: 120, width: '100%' }} value={answers[cur.key] || ''} onChange={(e) => setAnswers({ ...answers, [cur.key]: e.target.value })} placeholder={cur.placeholder} />
        ) : (
          <input className="input" value={answers[cur.key] || ''} onChange={(e) => setAnswers({ ...answers, [cur.key]: e.target.value })} placeholder={cur.placeholder} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') next() }} />
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 16 }}>
          <button className="btn-secondary" onClick={back} disabled={step === 0}>Back</button>
          <button className="btn-primary" onClick={next}>
            {last ? <><Check size={13} /> Finish</> : <>Next <ChevronRight size={13} /></>}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, required, children }) {
  return (
    <div>
      <label className="label">{label}{required && <span style={{ color: 'var(--red)' }}> *</span>}</label>
      {children}
    </div>
  )
}

export default function Profiles() {
  const { profiles, selectedProfileId, setSelectedProfileId, refresh } = useProfile()
  const { session } = useAuth()
  const [editing, setEditing] = useState(null)

  const startNew = () => setEditing({})

  const onSaved = async (profile) => {
    await refresh()
    setEditing(null)
    if (profile?.id) setSelectedProfileId(profile.id)
  }

  const onDelete = async (p) => {
    if (!confirm(`Delete "${p.business_name}" and all of its data? This cannot be undone.`)) return
    await fetch(`/api/profiles?id=${p.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    await refresh()
  }

  return (
    <div className="fade-up">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, flex: 1 }}>Brand profiles</h2>
        <button className="btn-primary" onClick={startNew}><Plus size={14} /> New profile</button>
      </div>

      {profiles.length === 0 ? (
        <div className="card-flat" style={{ padding: 50, textAlign: 'center', color: 'var(--muted)', marginTop: 14 }}>
          <Building2 size={28} style={{ marginBottom: 12 }} />
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)', marginBottom: 6 }}>
            Set up your first brand
          </div>
          <div style={{ fontSize: 13, marginBottom: 22, lineHeight: 1.5, maxWidth: 420, margin: '0 auto 22px' }}>
            One brand profile = one identity ScaleSolo can scale. Create one to unlock content, email, pipeline, AI CEO, and everything else.
          </div>
          <button className="btn-primary" onClick={startNew}><Plus size={15} /> Create brand profile</button>
        </div>
      ) : (
        <div style={grid}>
          {profiles.map((p) => {
            const isActive = p.id === selectedProfileId
            const role = p._role || p.role
            return (
              <div
                key={p.id}
                style={cardStyle(isActive)}
                onClick={() => setSelectedProfileId(p.id)}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.transform = 'translateY(-2px)' }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.transform = 'translateY(0)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={initialsStyle(p.brand_primary_color ? `linear-gradient(135deg, ${p.brand_primary_color}, ${p.brand_secondary_color || p.brand_primary_color})` : null)}>
                    {initialsOf(p.business_name)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.business_name}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      {p.industry || (p.business_type ? p.business_type : '—')}
                    </div>
                  </div>
                  {isActive && <span style={tagPill}><Check size={11} /> Active</span>}
                  {role === 'owner' && <span style={{ ...tagPill, background: 'rgba(245,158,11,0.16)', color: '#f59e0b' }}><Crown size={11} /> Owner</span>}
                </div>
                {p.brand_bible && (
                  <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.5, maxHeight: 60, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.brand_bible.slice(0, 140)}{p.brand_bible.length > 140 ? '…' : ''}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
                  <button className="btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }} onClick={(e) => { e.stopPropagation(); setEditing(p) }}>
                    <Edit3 size={12} /> Edit
                  </button>
                  {role === 'owner' && (
                    <button className="btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }} onClick={(e) => { e.stopPropagation(); onDelete(p) }}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editing && <ProfileEditor profile={editing} onClose={() => setEditing(null)} onSaved={onSaved} />}
    </div>
  )
}
