import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Plus, ClipboardList, Eye, ExternalLink, Trash2, Sparkles, Save, Copy } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'

const grid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: 14,
  marginTop: 14,
}
const formCard = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  padding: 18,
  cursor: 'pointer',
  transition: 'transform 0.15s ease, border-color 0.15s ease',
}

const FIELD_TYPES = [
  { value: 'text',         label: 'Short text' },
  { value: 'textarea',     label: 'Long text' },
  { value: 'email',        label: 'Email' },
  { value: 'phone',        label: 'Phone' },
  { value: 'dropdown',     label: 'Dropdown' },
  { value: 'multi-choice', label: 'Multi-choice' },
  { value: 'checkbox',     label: 'Checkbox' },
]

const newField = (type = 'text') => ({
  id: `f_${Math.random().toString(36).slice(2, 8)}`,
  type, label: 'New question', required: false, placeholder: '',
  ...(['dropdown', 'multi-choice', 'checkbox'].includes(type) ? { options: ['Option 1', 'Option 2'] } : {}),
})

const newSection = () => ({
  id: `s_${Math.random().toString(36).slice(2, 8)}`,
  title: '',
  fields: [newField('email')],
})

// ── List view ──────────────────────────────────────────────────────────────
function FormsList({ forms, onCreate, onOpen, onDelete }) {
  return (
    <div className="fade-up">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, flex: 1 }}>Forms</h2>
        <button className="btn-primary" onClick={onCreate}><Plus size={14} /> New form</button>
      </div>
      {forms.length === 0 ? (
        <div className="card-flat" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', marginTop: 14 }}>
          <ClipboardList size={28} style={{ marginBottom: 12, color: 'var(--muted)' }} />
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--text)', fontSize: 15 }}>
            No forms yet
          </div>
          <div style={{ fontSize: 13, marginTop: 4 }}>Build a form to capture leads from anywhere on the web.</div>
        </div>
      ) : (
        <div style={grid}>
          {forms.map((f) => (
            <div
              key={f.id} style={formCard}
              role="button" tabIndex={0}
              aria-label={`Open form ${f.name || 'untitled'}`}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(f) } }}
              onClick={() => onOpen(f)}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)' }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.borderColor = 'var(--border)' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <ClipboardList size={16} style={{ color: 'var(--red)' }} />
                <span className={f.is_published ? 'pill pill-success' : 'pill pill-muted'}>
                  {f.is_published ? 'Live' : 'Draft'}
                </span>
              </div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{f.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                /f/{f.slug} · updated {new Date(f.updated_at).toLocaleDateString()}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                <button className="btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }} onClick={(e) => { e.stopPropagation(); onDelete(f) }}>
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Builder ────────────────────────────────────────────────────────────────
function FormBuilder({ form, onSave, onClose }) {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  const [name, setName] = useState(form.name || '')
  const [slug, setSlug] = useState(form.slug || '')
  const [sections, setSections] = useState(form.sections?.length ? form.sections : [newSection()])
  const [confirmation, setConfirmation] = useState(form.confirmation || { kind: 'message', message: 'Thanks — we got it.' })
  const [isPublished, setIsPublished] = useState(!!form.is_published)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')

  const updateField = (sectionIdx, fieldIdx, patch) => {
    setSections((prev) => prev.map((s, i) => i !== sectionIdx ? s : ({
      ...s,
      fields: s.fields.map((f, j) => j !== fieldIdx ? f : { ...f, ...patch }),
    })))
  }
  const addField = (sectionIdx, type = 'text') => {
    setSections((prev) => prev.map((s, i) => i !== sectionIdx ? s : ({ ...s, fields: [...s.fields, newField(type)] })))
  }
  const removeField = (sectionIdx, fieldIdx) => {
    setSections((prev) => prev.map((s, i) => i !== sectionIdx ? s : ({ ...s, fields: s.fields.filter((_, j) => j !== fieldIdx) })))
  }

  const save = async () => {
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/forms', {
        method: form.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          id: form.id,
          profile_id: selectedProfileId,
          name, slug,
          sections,
          confirmation,
          is_published: isPublished,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Save failed')
      onSave(body.form)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const generate = async () => {
    if (!aiPrompt.trim()) return
    setAiBusy(true); setError(null)
    try {
      const r = await fetch('/api/forms/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ profile_id: selectedProfileId, description: aiPrompt }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Generation failed')
      if (body.sections) setSections(body.sections)
      if (body.confirmation) setConfirmation(body.confirmation)
    } catch (e) { setError(e.message) }
    finally { setAiBusy(false) }
  }

  const publicUrl = form.id && form.slug ? `${window.location.origin}/f/${form.slug}` : null

  return (
    <div className="fade-up" style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16 }}>
      {/* Left: builder */}
      <div className="card-flat">
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 18, gap: 10 }}>
          <button className="btn-ghost" onClick={onClose}>← Forms</button>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Form name"
            style={{ flex: 1, fontWeight: 600 }}
          />
          <button className="btn-secondary" onClick={save} disabled={busy}>
            {busy ? <span className="spinner" /> : <Save size={14} />} Save draft
          </button>
          <button className="btn-primary" onClick={() => { setIsPublished(true); setTimeout(save, 0) }} disabled={busy}>
            {isPublished ? 'Update live' : 'Publish'}
          </button>
        </div>

        {/* AI generate row */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            className="input"
            placeholder="Describe a form to generate (e.g. 'A lead form for my coaching program')"
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') generate() }}
          />
          <button className="btn-secondary" onClick={generate} disabled={aiBusy || !aiPrompt.trim()}>
            {aiBusy ? <span className="spinner" /> : <Sparkles size={14} />} Generate
          </button>
        </div>

        {/* Sections */}
        {sections.map((section, si) => (
          <div key={section.id} style={{ marginBottom: 16, padding: 14, background: 'var(--surface-2)', borderRadius: 12, border: '1px solid var(--border)' }}>
            <div style={{ marginBottom: 10, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Section {si + 1}
            </div>
            {section.fields.map((field, fi) => (
              <div key={field.id} style={{ display: 'grid', gridTemplateColumns: '180px 1fr 50px', gap: 8, marginBottom: 10 }}>
                <select className="select" value={field.type} onChange={(e) => updateField(si, fi, { type: e.target.value })}>
                  {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <div>
                  <input className="input" value={field.label} onChange={(e) => updateField(si, fi, { label: e.target.value })} placeholder="Question label" />
                  {['dropdown','multi-choice','checkbox'].includes(field.type) && (
                    <textarea className="textarea" style={{ marginTop: 6, fontSize: 12, minHeight: 50 }}
                      placeholder="One option per line"
                      value={(field.options || []).join('\n')}
                      onChange={(e) => updateField(si, fi, { options: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
                    />
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input type="checkbox" checked={!!field.required} onChange={(e) => updateField(si, fi, { required: e.target.checked })} />
                    Req
                  </label>
                  <button onClick={() => removeField(si, fi)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0 }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
            <button className="btn-ghost" onClick={() => addField(si)} style={{ marginTop: 4 }}>
              <Plus size={13} /> Add field
            </button>
          </div>
        ))}
        {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginTop: 12 }}>{error}</div>}
      </div>

      {/* Right: settings */}
      <aside className="card-flat" style={{ alignSelf: 'flex-start' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>
          Form settings
        </div>
        <div style={{ marginBottom: 14 }}>
          <label className="label">URL slug</label>
          <input className="input" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="my-lead-form" />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Public URL: /f/{slug || '<slug>'}</div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label className="label">Confirmation</label>
          <select className="select" value={confirmation.kind} onChange={(e) => setConfirmation((c) => ({ ...c, kind: e.target.value }))}>
            <option value="message">Show a message</option>
            <option value="redirect">Redirect to URL</option>
          </select>
          {confirmation.kind === 'message' ? (
            <textarea className="textarea" style={{ marginTop: 8 }} value={confirmation.message || ''} onChange={(e) => setConfirmation((c) => ({ ...c, message: e.target.value }))} />
          ) : (
            <input className="input" style={{ marginTop: 8 }} placeholder="https://example.com/thanks" value={confirmation.url || ''} onChange={(e) => setConfirmation((c) => ({ ...c, url: e.target.value }))} />
          )}
        </div>
        {publicUrl && (
          <div style={{ marginBottom: 14, padding: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Public URL</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <code style={{ flex: 1, fontSize: 11, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{publicUrl}</code>
              <button className="btn-ghost" style={{ padding: 4 }} onClick={() => navigator.clipboard.writeText(publicUrl)} title="Copy">
                <Copy size={12} />
              </button>
              <a className="btn-ghost" style={{ padding: 4 }} href={publicUrl} target="_blank" rel="noreferrer" title="Open">
                <ExternalLink size={12} />
              </a>
            </div>
          </div>
        )}
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
          {form.id ? 'Submissions appear in Contacts with the form name as their source. Stage drag-drop in Pipeline triggers activity events.' : 'Save draft to get a shareable URL.'}
        </div>
      </aside>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────
export default function Forms() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  const [forms, setForms] = useState([])
  const [editing, setEditing] = useState(null) // form object or { __new: true }
  const [params] = useSearchParams()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = async () => {
    if (!session || !selectedProfileId) return
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/forms?profile_id=${selectedProfileId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      setForms(body.forms || [])
    } catch (e) {
      setError(e.message)
      setForms([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [session, selectedProfileId])

  const onCreate = async () => {
    setEditing({
      id: null, name: 'Untitled form', slug: `form-${Date.now().toString(36)}`,
      sections: [newSection()],
      confirmation: { kind: 'message', message: 'Thanks — we got it.' },
      is_published: false,
    })
  }

  const onOpen = async (f) => {
    const r = await fetch(`/api/forms?id=${f.id}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
    const body = await r.json()
    if (r.ok) setEditing(body.form)
  }

  const onDelete = async (f) => {
    if (!confirm(`Delete "${f.name}"?`)) return
    await fetch(`/api/forms?id=${f.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${session.access_token}` } })
    refresh()
  }

  if (!selectedProfileId) {
    return <div className="card-flat fade-up" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      Pick a brand profile to manage forms.
    </div>
  }

  if (editing) {
    return <FormBuilder form={editing} onSave={(f) => { refresh(); setEditing(f) }} onClose={() => { refresh(); setEditing(null) }} />
  }
  return <FormsList forms={forms} onCreate={onCreate} onOpen={onOpen} onDelete={onDelete} />
}
