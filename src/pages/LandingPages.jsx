// Landing-page builder.
// New in this revision:
//   - Schema-driven section editor (no JSON textareas anywhere).
//   - Inline-editable preview (click any text in the preview to edit it).
//   - AI edit chat — type "change theme to orange" to mutate the whole page.
//   - Image / video uploader writes to Supabase Storage `landing-media` bucket.
//   - Generation runs with a stepped progress bar so the wait feels active.

import { useEffect, useMemo, useState, useRef } from 'react'
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Plus, LayoutTemplate, ExternalLink, Save, Sparkles, Trash2, Copy,
  Wand2, GripVertical, Upload, X, MessageSquare, Image as ImageIcon, Link as LinkIcon, Send,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { supabase } from '../lib/supabase.js'
import { SECTIONS, SECTION_TEMPLATES, renderSection } from '../lib/landing-sections.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers

async function uploadToLandingMedia(file, profileId, bucket = 'landing-media') {
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase()
  const path = `${profileId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  })
  if (error) throw new Error(error.message)
  const { data } = supabase.storage.from(bucket).getPublicUrl(path)
  return data.publicUrl
}

// ─────────────────────────────────────────────────────────────────────────────
// Pages list

function PagesList({ pages, onCreate, onOpen, onDelete, error }) {
  return (
    <div className="fade-up">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, flex: 1 }}>Landing pages</h2>
        <button className="btn-primary" onClick={onCreate}><Plus size={14} /> New page</button>
      </div>
      {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>{error}</div>}
      {pages.length === 0 ? (
        <div className="card-flat" style={{ padding: 50, textAlign: 'center', color: 'var(--muted)' }}>
          <LayoutTemplate size={28} style={{ marginBottom: 12 }} />
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)', marginBottom: 6 }}>No landing pages yet</div>
          <div style={{ fontSize: 13, marginBottom: 22, lineHeight: 1.5, maxWidth: 420, margin: '0 auto 22px' }}>
            Build a sales page, lead magnet, or course launch in minutes. AI fills the copy, you click to edit.
          </div>
          <button className="btn-primary" onClick={onCreate}><Plus size={15} /> Create your first page</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
          {pages.map((p) => (
            <div key={p.id} className="card" style={{ cursor: 'pointer' }} onClick={() => onOpen(p)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <LayoutTemplate size={16} style={{ color: 'var(--red)' }} />
                <span className={p.is_published ? 'pill pill-success' : 'pill pill-muted'}>{p.is_published ? 'Live' : 'Draft'}</span>
              </div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{p.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>/p/{p.slug} · updated {new Date(p.updated_at).toLocaleDateString()}</div>
              <button className="btn-ghost" style={{ marginTop: 12, padding: '6px 10px', fontSize: 12 }} onClick={(e) => { e.stopPropagation(); onDelete(p) }}>
                <Trash2 size={12} /> Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sortable section row in the left rail

function SectionRow({ section, isActive, onSelect, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: section.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  const def = SECTIONS[section.type]
  const Icon = def?.icon
  return (
    <div ref={setNodeRef} style={style}>
      <div
        onClick={() => onSelect(section.id)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 10px',
          background: isActive ? 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(185,28,28,0.10))' : 'var(--surface-2)',
          border: isActive ? '1px solid rgba(239,68,68,0.4)' : '1px solid var(--border)',
          borderRadius: 8, marginBottom: 4, cursor: 'pointer',
        }}
      >
        <span {...attributes} {...listeners} style={{ cursor: 'grab', color: 'var(--muted)', display: 'grid', placeItems: 'center' }}>
          <GripVertical size={14} />
        </span>
        {Icon && <Icon size={13} style={{ color: 'var(--red)' }} />}
        <span style={{ flex: 1, fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 12.5, color: 'var(--text)' }}>
          {def?.label || section.type}
        </span>
        <button onClick={(e) => { e.stopPropagation(); onRemove(section.id) }} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 2 }}>
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Field editor — schema-driven, never falls back to JSON

function FieldEditor({ field, value, onChange, profileId }) {
  const set = (v) => onChange(v)

  if (field.kind === 'text') {
    return <input className="input" value={value || ''} onChange={(e) => set(e.target.value)} placeholder={field.placeholder} />
  }
  if (field.kind === 'textarea') {
    return <textarea className="textarea" value={value || ''} onChange={(e) => set(e.target.value)} placeholder={field.placeholder} />
  }
  if (field.kind === 'url') {
    return (
      <div style={{ position: 'relative' }}>
        <LinkIcon size={13} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
        <input
          className="input"
          style={{ paddingLeft: 34 }}
          value={value || ''}
          onChange={(e) => set(e.target.value)}
          placeholder={field.placeholder || 'https://yoursite.com/page'}
        />
      </div>
    )
  }
  if (field.kind === 'bool') {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-soft)' }}>
        <input type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked)} />
        {field.label}
      </label>
    )
  }
  if (field.kind === 'lines') {
    // simple multi-line list (one per line)
    const text = Array.isArray(value) ? value.join('\n') : (value || '')
    return (
      <textarea
        className="textarea"
        style={{ minHeight: 90, fontFamily: 'inherit' }}
        value={text}
        placeholder="One per line"
        onChange={(e) => set(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
      />
    )
  }
  if (field.kind === 'image' || field.kind === 'video') {
    return <MediaField value={value || ''} onChange={set} profileId={profileId} kind={field.kind} bucket={field.bucket || 'landing-media'} helper={field.helper} />
  }
  if (field.kind === 'array') {
    const items = Array.isArray(value) ? value : []
    return (
      <div>
        {items.map((item, i) => (
          <div key={i} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: 10, marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <div style={{ fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', flex: 1 }}>
                #{i + 1}
              </div>
              <button
                onClick={() => set(items.filter((_, j) => j !== i))}
                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}
                title="Remove"
              ><Trash2 size={12} /></button>
            </div>
            {field.of.map((sub) => (
              <div key={sub.key} style={{ marginBottom: 8 }}>
                <label className="label" style={{ fontSize: 10.5 }}>{sub.label}</label>
                <FieldEditor
                  field={sub}
                  value={item[sub.key]}
                  onChange={(v) => set(items.map((it, j) => j === i ? { ...it, [sub.key]: v } : it))}
                  profileId={profileId}
                />
              </div>
            ))}
          </div>
        ))}
        <button
          className="btn-ghost"
          onClick={() => set([...items, {}])}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          <Plus size={12} /> Add {field.label?.toLowerCase().replace(/s$/, '') || 'item'}
        </button>
      </div>
    )
  }
  return null
}

// Image / video field with both URL paste + file upload
function MediaField({ value, onChange, profileId, kind, bucket, helper }) {
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const onFile = async (file) => {
    if (!file) return
    const max = kind === 'video' ? 100 * 1024 * 1024 : 5 * 1024 * 1024
    if (file.size > max) {
      setError(`File must be under ${kind === 'video' ? '100' : '5'} MB.`)
      return
    }
    setError(null); setBusy(true)
    try {
      const url = await uploadToLandingMedia(file, profileId, bucket)
      onChange(url)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="input"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={kind === 'video' ? 'https://youtu.be/… or https://…/video.mp4' : 'https://…/image.jpg'}
        />
        <button
          className="btn-secondary"
          style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          {busy ? <span className="spinner" /> : <Upload size={13} />} Upload
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={kind === 'video' ? 'video/*' : 'image/*'}
          hidden
          onChange={(e) => onFile(e.target.files?.[0])}
        />
      </div>
      {value && kind === 'image' && (
        <div style={{ marginTop: 6 }}>
          <img src={value} alt="" style={{ maxHeight: 80, maxWidth: '100%', borderRadius: 6, border: '1px solid var(--border)' }} />
        </div>
      )}
      {error && <div style={{ marginTop: 4, color: 'var(--red)', fontSize: 11.5 }}>{error}</div>}
      {helper && <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>{helper}</div>}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema-driven Section editor

function SectionEditor({ section, onChange, profileId }) {
  if (!section) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>Pick a section in the rail or click any text in the preview.</div>
  const def = SECTIONS[section.type]
  if (!def) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>Unknown section type</div>
  const props = section.props || {}
  const setField = (key, value) => onChange({ ...section, props: { ...props, [key]: value } })

  return (
    <div>
      {def.fields.map((f) => (
        <div key={f.key} style={{ marginBottom: 14 }}>
          {f.kind !== 'bool' && <label className="label">{f.label}</label>}
          <FieldEditor field={f} value={props[f.key]} onChange={(v) => setField(f.key, v)} profileId={profileId} />
        </div>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Stepped progress bar (used by generate + AI edit)

const GENERATE_STEPS = [
  'Reading your brand bible…',
  'Outlining the page structure…',
  'Writing the hero copy…',
  'Generating supporting sections…',
  'Polishing tone and voice…',
  'Almost there…',
]
const EDIT_STEPS = [
  'Reading the page…',
  'Understanding your edit…',
  'Applying changes…',
  'Tightening up the layout…',
]

function ProgressOverlay({ steps, label = 'Generating', onCancel }) {
  const [stepIdx, setStepIdx] = useState(0)
  const [pct, setPct] = useState(5)
  useEffect(() => {
    let cancelled = false
    let p = 5
    const tick = () => {
      if (cancelled) return
      // ease toward 95% over ~12 seconds
      p = Math.min(95, p + (95 - p) * 0.07)
      setPct(p)
      const idx = Math.min(steps.length - 1, Math.floor((p / 95) * steps.length))
      setStepIdx(idx)
      setTimeout(tick, 450)
    }
    tick()
    return () => { cancelled = true }
  }, [])
  return (
    <div className="modal-overlay" style={{ zIndex: 110 }}>
      <div className="modal-card modal-card-md" style={{ textAlign: 'center', padding: 36 }}>
        <div style={{ width: 52, height: 52, borderRadius: 14, margin: '0 auto 14px', background: 'linear-gradient(135deg, var(--red), var(--red-dark))', color: '#fff', display: 'grid', placeItems: 'center', boxShadow: '0 8px 24px rgba(239,68,68,0.32)' }} className="pulse">
          <Wand2 size={22} />
        </div>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18, marginBottom: 6 }}>{label}</div>
        <div style={{ color: 'var(--muted)', fontSize: 13.5, marginBottom: 22, minHeight: 20 }}>{steps[stepIdx]}</div>
        <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden', border: '1px solid var(--border)' }}>
          <div style={{
            width: `${pct}%`, height: '100%',
            background: 'linear-gradient(90deg, var(--red), var(--red-dark))',
            transition: 'width 0.4s ease',
            boxShadow: '0 0 12px rgba(239,68,68,0.5)',
          }} />
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>{Math.round(pct)}%</div>
        {onCancel && (
          <button className="btn-ghost" style={{ marginTop: 16 }} onClick={onCancel}>Cancel</button>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder

function Builder({ page, onSave, onClose }) {
  const { session } = useAuth()
  const { selectedProfileId, selectedProfile } = useProfile()
  const [name, setName] = useState(page.name || 'Untitled page')
  const [slug, setSlug] = useState(page.slug || `page-${Date.now().toString(36)}`)
  const [sections, setSections] = useState(Array.isArray(page.sections) ? page.sections : [])
  const [activeId, setActiveId] = useState(sections[0]?.id || null)
  const [isPublished, setIsPublished] = useState(!!page.is_published)
  const [busy, setBusy] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [editing, setEditing] = useState(false)        // AI edit in flight
  const [aiPrompt, setAiPrompt] = useState('')
  const [editPrompt, setEditPrompt] = useState('')
  const [error, setError] = useState(null)
  const [meta, setMeta] = useState(page.meta || {})
  const [editableInline, setEditableInline] = useState(true)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const activeSection = sections.find((s) => s.id === activeId) || null
  const brand = selectedProfile

  const updateSection = (next) => {
    setSections((arr) => arr.map((s) => s.id === next.id ? next : s))
  }

  const addSection = (type) => {
    const tpl = SECTION_TEMPLATES[type] || {}
    const newSection = { id: `s_${Math.random().toString(36).slice(2, 8)}`, type, props: { ...tpl } }
    setSections((arr) => [...arr, newSection])
    setActiveId(newSection.id)
  }

  const removeSection = (id) => {
    setSections((arr) => arr.filter((s) => s.id !== id))
    if (activeId === id) setActiveId(null)
  }

  const onDragEnd = (e) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIdx = sections.findIndex((s) => s.id === active.id)
    const newIdx = sections.findIndex((s) => s.id === over.id)
    if (oldIdx >= 0 && newIdx >= 0) setSections(arrayMove(sections, oldIdx, newIdx))
  }

  const save = async (publish) => {
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/landing-pages', {
        method: page.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          id: page.id, profile_id: selectedProfileId,
          name, slug, sections, meta,
          is_published: publish ?? isPublished,
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error || 'Save failed')
      onSave(body.page)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const generate = async () => {
    if (!aiPrompt.trim()) return
    setGenerating(true); setError(null)
    try {
      const r = await fetch('/api/landing-pages/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ profile_id: selectedProfileId, description: aiPrompt }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error || 'Generation failed')
      if (Array.isArray(body.sections)) {
        setSections(body.sections)
        setActiveId(body.sections[0]?.id || null)
      }
      if (body.meta) setMeta(body.meta)
      setAiPrompt('')
    } catch (e) { setError(e.message) }
    finally { setGenerating(false) }
  }

  const aiEdit = async () => {
    if (!editPrompt.trim() || sections.length === 0) return
    setEditing(true); setError(null)
    try {
      const r = await fetch('/api/landing-pages/edit-with-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ profile_id: selectedProfileId, page_id: page.id, sections, instruction: editPrompt }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error || 'Edit failed')
      if (Array.isArray(body.sections)) setSections(body.sections)
      setEditPrompt('')
    } catch (e) { setError(e.message) }
    finally { setEditing(false) }
  }

  const publicUrl = page.id && slug ? `${window.location.origin}/p/${slug}` : null

  return (
    <div className="fade-up" style={{ display: 'grid', gridTemplateColumns: '260px 1fr 320px', gap: 12, alignItems: 'start' }}>
      {/* LEFT RAIL */}
      <aside className="card-flat" style={{ position: 'sticky', top: 86, alignSelf: 'flex-start', maxHeight: 'calc(100vh - 110px)', overflowY: 'auto' }}>
        <button className="btn-ghost" onClick={onClose} style={{ marginBottom: 10 }}>← Pages</button>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 10 }}>Sections</div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {sections.map((s) => (
              <SectionRow key={s.id} section={s} isActive={s.id === activeId} onSelect={setActiveId} onRemove={removeSection} />
            ))}
          </SortableContext>
        </DndContext>
        {sections.length === 0 && <div style={{ padding: 8, fontSize: 12, color: 'var(--muted)' }}>No sections yet. Add one below or generate from a brief.</div>}

        <div style={{ height: 1, background: 'var(--border)', margin: '12px 0' }} />
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>Add section</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
          {Object.entries(SECTIONS).map(([key, def]) => {
            const Icon = def.icon
            return (
              <button
                key={key}
                onClick={() => addSection(key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 10px', borderRadius: 8,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  cursor: 'pointer', fontSize: 11.5, color: 'var(--text)',
                  fontFamily: 'var(--font-display)', fontWeight: 600, textAlign: 'left',
                }}
              >
                <Icon size={12} /> {def.label}
              </button>
            )
          })}
        </div>
      </aside>

      {/* CENTER PREVIEW */}
      <section className="card-flat" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, borderBottom: '1px solid var(--border)' }}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Page name" style={{ flex: 1, fontWeight: 600 }} />
          <button className="btn-ghost" title="Toggle inline editing" onClick={() => setEditableInline((v) => !v)} style={{ fontSize: 11.5 }}>
            {editableInline ? '✏️ Editing' : '👁 Preview'}
          </button>
          <button className="btn-secondary" onClick={() => save(false)} disabled={busy}>
            {busy ? <span className="spinner" /> : <Save size={13} />} Save draft
          </button>
          <button className="btn-primary" onClick={() => { setIsPublished(true); save(true) }} disabled={busy || sections.length === 0}>
            {isPublished ? 'Update live' : 'Publish'}
          </button>
        </div>

        {/* AI generate row */}
        <div style={{ display: 'flex', gap: 8, padding: 12, borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          <input
            className="input"
            placeholder="Describe a page to generate (e.g. 'A waitlist page for my AI course')"
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') generate() }}
          />
          <button className="btn-secondary" onClick={generate} disabled={generating || !aiPrompt.trim()}>
            <Wand2 size={13} /> Generate
          </button>
        </div>

        {/* AI edit row */}
        {sections.length > 0 && (
          <div style={{ display: 'flex', gap: 8, padding: 12, borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
            <MessageSquare size={14} style={{ color: 'var(--red)', alignSelf: 'center', flexShrink: 0 }} />
            <input
              className="input"
              placeholder="Tell the AI what to change (e.g. 'change theme color to orange', 'add a gradient behind stats')"
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') aiEdit() }}
            />
            <button className="btn-secondary" onClick={aiEdit} disabled={editing || !editPrompt.trim()}>
              <Send size={13} /> Edit with AI
            </button>
          </div>
        )}

        {/* Preview */}
        <div style={{ background: 'var(--bg)', maxHeight: 'calc(100vh - 290px)', overflowY: 'auto' }}>
          {sections.length === 0 ? (
            <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)' }}>
              <Sparkles size={28} style={{ marginBottom: 12 }} />
              <div style={{ fontSize: 14 }}>Add a section from the left rail, or describe a page to generate one with AI.</div>
            </div>
          ) : (
            sections.map((s) => (
              <div
                key={s.id}
                onClick={() => setActiveId(s.id)}
                style={{
                  borderBottom: '1px dashed var(--border)',
                  outline: activeId === s.id ? '2px solid rgba(239,68,68,0.45)' : 'none',
                  outlineOffset: -2,
                  position: 'relative',
                }}
              >
                {renderSection(s, brand, { editable: editableInline, onChange: updateSection, pageId: page.id })}
              </div>
            ))
          )}
        </div>
      </section>

      {/* RIGHT RAIL */}
      <aside className="card-flat" style={{ position: 'sticky', top: 86, alignSelf: 'flex-start', maxHeight: 'calc(100vh - 110px)', overflowY: 'auto' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 10 }}>
          {activeSection ? `${SECTIONS[activeSection.type]?.label || activeSection.type} settings` : 'Page settings'}
        </div>

        {activeSection ? (
          <SectionEditor section={activeSection} onChange={updateSection} profileId={selectedProfileId} />
        ) : (
          <>
            <div style={{ marginBottom: 12 }}>
              <label className="label">URL slug</label>
              <input className="input" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="my-page" />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>/p/{slug || '<slug>'}</div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label className="label">Meta title</label>
              <input className="input" value={meta.title || ''} onChange={(e) => setMeta((m) => ({ ...m, title: e.target.value }))} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label className="label">Meta description</label>
              <textarea className="textarea" value={meta.description || ''} onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))} />
            </div>
            {publicUrl && (
              <div style={{ padding: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Public URL</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <code style={{ flex: 1, fontSize: 11, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{publicUrl}</code>
                  <button className="btn-ghost" style={{ padding: 4 }} onClick={() => navigator.clipboard.writeText(publicUrl)}><Copy size={12} /></button>
                  <a className="btn-ghost" style={{ padding: 4 }} href={publicUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} /></a>
                </div>
              </div>
            )}
          </>
        )}

        {error && <div style={{ marginTop: 12, background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 12px', borderRadius: 10, fontSize: 12.5 }}>{error}</div>}
      </aside>

      {generating && <ProgressOverlay steps={GENERATE_STEPS} label="Generating landing page" />}
      {editing && <ProgressOverlay steps={EDIT_STEPS} label="Applying your edit" />}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Page

export default function LandingPages() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  const [pages, setPages] = useState([])
  const [editing, setEditing] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = async () => {
    if (!session || !selectedProfileId) return
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/landing-pages?profile_id=${selectedProfileId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      setPages(body.pages || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { refresh() }, [session, selectedProfileId])

  const onCreate = () => setEditing({
    id: null, name: 'Untitled page', slug: `page-${Date.now().toString(36)}`,
    sections: [], meta: {}, is_published: false,
  })

  const onOpen = async (p) => {
    try {
      const r = await fetch(`/api/landing-pages?id=${p.id}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      const body = await r.json()
      if (r.ok) setEditing(body.page)
      else setError(body.error || 'Failed to open')
    } catch (e) { setError(e.message) }
  }

  const onDelete = async (p) => {
    if (!confirm(`Delete "${p.name}"?`)) return
    try {
      await fetch(`/api/landing-pages?id=${p.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${session.access_token}` } })
      refresh()
    } catch (e) { setError(e.message) }
  }

  if (!selectedProfileId) {
    return <div className="card-flat fade-up" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      Pick a brand profile to manage landing pages.
    </div>
  }
  if (loading && pages.length === 0) return <div className="card-flat" style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
  if (editing) return <Builder page={editing} onSave={(p) => { refresh(); setEditing(p) }} onClose={() => { refresh(); setEditing(null) }} />
  return <PagesList pages={pages} onCreate={onCreate} onOpen={onOpen} onDelete={onDelete} error={error} />
}
