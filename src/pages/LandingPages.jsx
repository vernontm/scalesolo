// Landing-page list + builder. Drag-to-reorder sections via @dnd-kit/sortable.
import { useEffect, useMemo, useState } from 'react'
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Plus, LayoutTemplate, ExternalLink, Eye, Save, Sparkles, Trash2, Copy,
  Wand2, ChevronUp, ChevronDown, GripVertical,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { SECTIONS, SECTION_TEMPLATES, renderSection } from '../lib/landing-sections.jsx'

// ── List view ──────────────────────────────────────────────────────────────
function PagesList({ pages, onCreate, onOpen, onDelete }) {
  return (
    <div className="fade-up">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, flex: 1 }}>Landing pages</h2>
        <button className="btn-primary" onClick={onCreate}><Plus size={14} /> New page</button>
      </div>
      {pages.length === 0 ? (
        <div className="card-flat" style={{ padding: 50, textAlign: 'center', color: 'var(--muted)' }}>
          <LayoutTemplate size={28} style={{ marginBottom: 12 }} />
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)', marginBottom: 6 }}>No landing pages yet</div>
          <div style={{ fontSize: 13, marginBottom: 22, lineHeight: 1.5, maxWidth: 420, margin: '0 auto 22px' }}>
            Build a sales page, lead magnet, or course launch in minutes. Drag sections to reorder, AI fills the copy.
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

// ── Sortable section row in the builder rail ───────────────────────────────
function SectionRow({ section, isActive, onSelect, onRemove, onMove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: section.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  const def = SECTIONS[section.type]
  const Icon = def?.icon
  return (
    <div ref={setNodeRef} style={{ ...style }}>
      <div
        onClick={() => onSelect(section.id)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 10px',
          background: isActive ? 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(185,28,28,0.10))' : 'var(--surface-2)',
          border: isActive ? '1px solid rgba(239,68,68,0.4)' : '1px solid var(--border)',
          borderRadius: 8,
          marginBottom: 4,
          cursor: 'pointer',
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

// ── Property editor for the active section ─────────────────────────────────
function SectionEditor({ section, onChange }) {
  if (!section) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>Pick a section on the left to edit it.</div>
  const props = section.props || {}
  const set = (patch) => onChange({ ...section, props: { ...props, ...patch } })

  // Generic JSON editor for arrays of objects (items, quotes, tiers, etc.)
  const arrayKey = ['items','quotes','tiers'].find((k) => Array.isArray(props[k]))

  return (
    <div>
      {Object.keys(props).map((k) => {
        if (k === arrayKey) return null
        const val = props[k] ?? ''
        const isLong = typeof val === 'string' && val.length > 60
        return (
          <div key={k} style={{ marginBottom: 12 }}>
            <label className="label">{k}</label>
            {isLong ? (
              <textarea className="textarea" value={val} onChange={(e) => set({ [k]: e.target.value })} />
            ) : (
              <input className="input" value={val} onChange={(e) => set({ [k]: e.target.value })} />
            )}
          </div>
        )
      })}
      {arrayKey && (
        <div style={{ marginBottom: 8 }}>
          <label className="label">{arrayKey} (JSON)</label>
          <textarea
            className="textarea"
            style={{ minHeight: 160, fontFamily: 'monospace', fontSize: 12 }}
            value={JSON.stringify(props[arrayKey], null, 2)}
            onChange={(e) => {
              try { set({ [arrayKey]: JSON.parse(e.target.value) }) } catch {}
            }}
          />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Edit the array directly. Visual editor for each row coming later.</div>
        </div>
      )}
    </div>
  )
}

// ── Builder ────────────────────────────────────────────────────────────────
function Builder({ page, onSave, onClose }) {
  const { session } = useAuth()
  const { selectedProfileId, selectedProfile } = useProfile()
  const [name, setName] = useState(page.name || 'Untitled page')
  const [slug, setSlug] = useState(page.slug || `page-${Date.now().toString(36)}`)
  const [sections, setSections] = useState(Array.isArray(page.sections) ? page.sections : [])
  const [activeId, setActiveId] = useState(sections[0]?.id || null)
  const [isPublished, setIsPublished] = useState(!!page.is_published)
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [error, setError] = useState(null)
  const [meta, setMeta] = useState(page.meta || {})

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
          id: page.id,
          profile_id: selectedProfileId,
          name, slug, sections, meta,
          is_published: publish ?? isPublished,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Save failed')
      onSave(body.page)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const generate = async () => {
    if (!aiPrompt.trim()) return
    setAiBusy(true); setError(null)
    try {
      const r = await fetch('/api/landing-pages/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ profile_id: selectedProfileId, description: aiPrompt }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Generation failed')
      if (Array.isArray(body.sections)) setSections(body.sections)
      if (body.meta) setMeta(body.meta)
    } catch (e) { setError(e.message) }
    finally { setAiBusy(false) }
  }

  const publicUrl = page.id && page.slug ? `${window.location.origin}/p/${slug}` : null

  return (
    <div className="fade-up" style={{ display: 'grid', gridTemplateColumns: '260px 1fr 320px', gap: 12, alignItems: 'start' }}>
      {/* Left rail: section list + add */}
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
        {sections.length === 0 && <div style={{ padding: 8, fontSize: 12, color: 'var(--muted)' }}>No sections yet.</div>}

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
                  cursor: 'pointer', fontSize: 12, color: 'var(--text)',
                  fontFamily: 'var(--font-display)', fontWeight: 600,
                }}
              >
                <Icon size={12} /> {def.label}
              </button>
            )
          })}
        </div>
      </aside>

      {/* Center: live preview */}
      <section className="card-flat" style={{ padding: 0, overflow: 'hidden' }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, borderBottom: '1px solid var(--border)' }}>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Page name"
            style={{ flex: 1, fontWeight: 600 }}
          />
          <button className="btn-secondary" onClick={() => save(false)} disabled={busy}>
            {busy ? <span className="spinner" /> : <Save size={13} />} Save draft
          </button>
          <button className="btn-primary" onClick={() => { setIsPublished(true); save(true) }} disabled={busy}>
            {isPublished ? 'Update live' : 'Publish'}
          </button>
        </div>

        {/* AI generate */}
        <div style={{ display: 'flex', gap: 8, padding: 12, borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          <input
            className="input"
            placeholder="Describe a page to generate (e.g. 'A waitlist page for my AI course')"
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') generate() }}
          />
          <button className="btn-secondary" onClick={generate} disabled={aiBusy || !aiPrompt.trim()}>
            {aiBusy ? <span className="spinner" /> : <Wand2 size={13} />} Generate
          </button>
        </div>

        {/* Preview */}
        <div style={{ background: 'var(--bg)', maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' }}>
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
                  cursor: 'pointer',
                  position: 'relative',
                }}
              >
                {renderSection(s, brand)}
              </div>
            ))
          )}
        </div>
      </section>

      {/* Right rail: section editor + page settings */}
      <aside className="card-flat" style={{ position: 'sticky', top: 86, alignSelf: 'flex-start', maxHeight: 'calc(100vh - 110px)', overflowY: 'auto' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 10 }}>
          {activeSection ? `${SECTIONS[activeSection.type]?.label || activeSection.type} settings` : 'Page settings'}
        </div>

        {activeSection ? (
          <SectionEditor section={activeSection} onChange={updateSection} />
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
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────
export default function LandingPages() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  const [pages, setPages] = useState([])
  const [editing, setEditing] = useState(null)
  const [loading, setLoading] = useState(true)

  const refresh = () => {
    if (!session || !selectedProfileId) return
    setLoading(true)
    fetch(`/api/landing-pages?profile_id=${selectedProfileId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((b) => setPages(b.pages || []))
      .finally(() => setLoading(false))
  }
  useEffect(() => { refresh() }, [session, selectedProfileId])

  const onCreate = () => setEditing({
    id: null, name: 'Untitled page', slug: `page-${Date.now().toString(36)}`,
    sections: [], meta: {}, is_published: false,
  })

  const onOpen = async (p) => {
    const r = await fetch(`/api/landing-pages?id=${p.id}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
    const body = await r.json()
    if (r.ok) setEditing(body.page)
  }

  const onDelete = async (p) => {
    if (!confirm(`Delete "${p.name}"?`)) return
    await fetch(`/api/landing-pages?id=${p.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${session.access_token}` } })
    refresh()
  }

  if (!selectedProfileId) {
    return <div className="card-flat fade-up" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      Pick a brand profile to manage landing pages.
    </div>
  }
  if (loading && pages.length === 0) return <div className="card-flat" style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
  if (editing) return <Builder page={editing} onSave={(p) => { refresh(); setEditing(p) }} onClose={() => { refresh(); setEditing(null) }} />
  return <PagesList pages={pages} onCreate={onCreate} onOpen={onOpen} onDelete={onDelete} />
}
