import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { LayoutGrid, Plus, Pencil, Trash2, Globe, Lock, X, Loader2, ArrowUpRight, Save, Sparkles, RefreshCw, ArrowUp, ArrowDown, ListChecks } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { supabase } from '../lib/supabase'

// Admin-only page. Lists every template (public + private from any user),
// lets the admin edit metadata/visibility/plan-gate, delete, or jump
// directly into the SpaceBuilder canvas to edit nodes & prompts.

const TIERS = [
  { key: 'solo_starter', label: 'Solo Starter' },
  { key: 'solo_pro',     label: 'Solo Pro'     },
  { key: 'solo_studio',  label: 'Solo Studio'  },
  { key: 'founding',     label: 'Founding'     },
]

async function authedFetch(path, init = {}) {
  const session = (await supabase.auth.getSession()).data.session
  return fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session?.access_token || ''}`,
      ...(init.headers || {}),
    },
  })
}

export default function AdminTemplates() {
  const { isAdmin, loading: authLoading } = useAuth()
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null)  // template object being edited
  const [categoryFilter, setCategoryFilter] = useState('all')

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await authedFetch('/api/admin/templates')
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error || `Failed (${r.status})`)
      setTemplates(body.templates || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!authLoading && isAdmin) refresh()
  }, [authLoading, isAdmin, refresh])

  async function handleDelete(t) {
    if (!confirm(`Delete template "${t.name}"? This can't be undone.`)) return
    try {
      const r = await authedFetch(`/api/admin/templates?id=${encodeURIComponent(t.id)}`, { method: 'DELETE' })
      if (!r.ok && r.status !== 204) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body?.error || `Delete failed (${r.status})`)
      }
      setTemplates((arr) => arr.filter((x) => x.id !== t.id))
    } catch (e) {
      alert(e.message)
    }
  }

  if (loading) {
    return <div style={pageStyle}><Loader2 size={18} className="spin" /> Loading templates…</div>
  }

  return (
    <div style={pageStyle}>
      <div style={hero}>
        <div style={heroIcon}><LayoutGrid size={20} /></div>
        <div style={{ flex: 1 }}>
          <div style={heroTitle}>Space templates</div>
          <div style={heroSub}>Manage the global gallery users see when they create a new space.</div>
        </div>
        <Link to="/spaces" style={ghostBtnStyle} title="Build a workflow in your own Spaces, then promote it to a template from the canvas.">
          <Plus size={14} /> Build new in Spaces
        </Link>
      </div>

      {error && <div style={errorBanner}>{error}</div>}

      {templates.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          {(() => {
            const cats = Array.from(new Set(templates.map((t) => t.template_category).filter(Boolean))).sort()
            const opts = [{ key: 'all', label: `All (${templates.length})` }, ...cats.map((c) => ({ key: c, label: c }))]
            return opts.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => setCategoryFilter(o.key)}
                style={{
                  ...pillBtnStyle,
                  padding: '6px 12px', fontSize: 11.5,
                  background: categoryFilter === o.key ? 'rgba(239,68,68,0.18)' : 'var(--surface-2)',
                  borderColor: categoryFilter === o.key ? 'rgba(239,68,68,0.5)' : 'var(--border)',
                  color: categoryFilter === o.key ? 'var(--text)' : 'var(--text-soft)',
                }}
              >
                {o.label}
              </button>
            ))
          })()}
        </div>
      )}

      {templates.length === 0 && !error ? (
        <div style={emptyCard}>
          <div style={cardTitle}>No templates yet</div>
          <div style={cardBody}>
            Build a workflow in your own <Link to="/spaces" style={{ color: 'var(--red)' }}>Spaces</Link>,
            then click <strong>Save as public template</strong> on the space's menu (admin-only) to seed the gallery.
          </div>
        </div>
      ) : (
        <div style={grid}>
          {templates
            .filter((t) => categoryFilter === 'all' || (t.template_category || '') === categoryFilter)
            .map((t) => (
            <div key={t.id} style={card}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
                <div style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 32, height: 32, borderRadius: 8,
                  background: t.template_visibility === 'public' ? 'rgba(46,204,113,0.14)' : 'rgba(168,85,247,0.14)',
                  color: t.template_visibility === 'public' ? '#2ecc71' : '#a855f7',
                  border: `1px solid ${t.template_visibility === 'public' ? 'rgba(46,204,113,0.3)' : 'rgba(168,85,247,0.3)'}`,
                  flexShrink: 0,
                }}>
                  {t.template_visibility === 'public' ? <Globe size={14} /> : <Lock size={14} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={cardTitle}>{t.name}</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                    <span style={visibilityPill(t.template_visibility)}>{t.template_visibility}</span>
                    {t.template_category && <span style={categoryPill}>{t.template_category}</span>}
                    {Array.isArray(t.template_plan_gate) && t.template_plan_gate.length > 0 ? (
                      t.template_plan_gate.map((tier) => (
                        <span key={tier} style={tierPill}>{TIERS.find((x) => x.key === tier)?.label || tier}</span>
                      ))
                    ) : (
                      <span style={freePill}>Free for all</span>
                    )}
                  </div>
                </div>
              </div>
              {(t.template_summary || t.description) && (
                <div style={cardBody}>{t.template_summary || t.description}</div>
              )}
              <div style={cardMeta}>
                {Array.isArray(t.nodes) ? t.nodes.length : 0} nodes · sort {t.template_sort_order ?? 100}
              </div>
              <div style={cardActions}>
                <button type="button" onClick={() => setEditing(t)} style={iconBtnStyle} title="Edit metadata">
                  <Pencil size={13} /> Edit
                </button>
                <Link to={`/spaces?template=${encodeURIComponent(t.id)}`} style={iconBtnStyle} title="Open canvas to edit nodes & prompts">
                  <ArrowUpRight size={13} /> Open canvas
                </Link>
                <button type="button" onClick={() => handleDelete(t)} style={dangerBtnStyle} title="Delete template">
                  <Trash2 size={13} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <EditDrawer template={editing} onClose={() => setEditing(null)} onSaved={(t) => {
          setTemplates((arr) => arr.map((x) => (x.id === t.id ? t : x)))
          setEditing(null)
        }} />
      )}
    </div>
  )
}

function EditDrawer({ template, onClose, onSaved }) {
  const [name, setName] = useState(template.name || '')
  const [summary, setSummary] = useState(template.template_summary || '')
  const [visibility, setVisibility] = useState(template.template_visibility || 'private')
  const [sortOrder, setSortOrder] = useState(template.template_sort_order ?? 100)
  const [planGate, setPlanGate] = useState(Array.isArray(template.template_plan_gate) ? [...template.template_plan_gate] : [])
  const [category, setCategory] = useState(template.template_category || '')
  const [steps, setSteps] = useState(Array.isArray(template.template_guide) ? template.template_guide : [])
  const [busy, setBusy] = useState(false)
  const [genBusy, setGenBusy] = useState(false)
  const [stepsBusy, setStepsBusy] = useState(false)
  const [err, setErr] = useState(null)
  // Available nodes from the template payload — used as a dropdown so each
  // step can optionally link to the canvas node it explains.
  const nodeOptions = Array.isArray(template.nodes)
    ? template.nodes.map((n) => ({
        id: n.id,
        label: n?.data?.name || n?.data?.type || n.id?.slice(0, 8),
        type: n?.data?.type,
      }))
    : []

  const updateStep = (idx, patch) => setSteps((arr) => arr.map((s, i) => i === idx ? { ...s, ...patch } : s))
  const addStep = () => setSteps((arr) => [...arr, { step: arr.length + 1, title: '', body: '', node_id: null, node_type: null }])
  const removeStep = (idx) => setSteps((arr) => arr.filter((_, i) => i !== idx).map((s, i) => ({ ...s, step: i + 1 })))
  const moveStep = (idx, delta) => setSteps((arr) => {
    const next = [...arr]
    const j = idx + delta
    if (j < 0 || j >= next.length) return arr
    ;[next[idx], next[j]] = [next[j], next[idx]]
    return next.map((s, i) => ({ ...s, step: i + 1 }))
  })

  function toggleTier(tier) {
    setPlanGate((arr) => arr.includes(tier) ? arr.filter((x) => x !== tier) : [...arr, tier])
  }

  async function save() {
    setBusy(true); setErr(null)
    try {
      // Strip empty steps so we don't ship blank rows. A step is real
      // when it has a title or body.
      const cleanSteps = steps
        .filter((s) => (s.title && s.title.trim()) || (s.body && s.body.trim()))
        .map((s, i) => ({
          step: i + 1,
          title: (s.title || '').trim(),
          body: (s.body || '').trim(),
          node_id: s.node_id || null,
          node_type: s.node_type || null,
        }))
      const r = await authedFetch(`/api/admin/templates?id=${encodeURIComponent(template.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim() || 'Untitled template',
          summary: summary.trim() || null,
          visibility,
          plan_gate: planGate,
          sort_order: Number(sortOrder),
          category: category.trim() || null,
          guide: cleanSteps.length ? cleanSteps : null,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error || `Save failed (${r.status})`)
      onSaved(body.template)
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function autoSteps() {
    setStepsBusy(true); setErr(null)
    try {
      const r = await authedFetch(`/api/admin/templates-steps?id=${encodeURIComponent(template.id)}`, {
        method: 'POST',
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error || `Generate failed (${r.status})`)
      if (Array.isArray(body.steps) && body.steps.length) {
        setSteps(body.steps.map((s, i) => ({ ...s, step: i + 1 })))
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setStepsBusy(false)
    }
  }

  async function autoDescribe() {
    setGenBusy(true); setErr(null)
    try {
      const r = await authedFetch(`/api/admin/templates-describe?id=${encodeURIComponent(template.id)}`, {
        method: 'POST',
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error || `Generate failed (${r.status})`)
      if (body.summary) setSummary(body.summary)
    } catch (e) {
      setErr(e.message)
    } finally {
      setGenBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-card modal-card-md" onClick={(e) => e.stopPropagation()} style={{ padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={cardTitle}>Edit template</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', ...iconOnlyBtn }}><X size={14} /></button>
        </div>

        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Category (e.g. Avatars, Podcast, Product)">
          <input className="input" value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} placeholder="Optional. Used as a filter chip in the user-facing picker." />
        </Field>
        <Field label="Summary (shown on the gallery card)">
          <textarea className="input" value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} maxLength={600} />
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              onClick={autoDescribe}
              disabled={genBusy}
              style={{
                ...iconBtnStyle,
                background: 'rgba(168,85,247,0.10)',
                borderColor: 'rgba(168,85,247,0.4)',
                color: '#c4b5fd',
              }}
              title="Auto-generate a summary by reading the workflow's nodes"
            >
              {genBusy ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />} Auto-generate description
            </button>
          </div>
        </Field>

        <Field label="Visibility">
          <div style={{ display: 'flex', gap: 8 }}>
            <RadioPill checked={visibility === 'public'}  onChange={() => setVisibility('public')}  label="Public — visible to every user" />
            <RadioPill checked={visibility === 'private'} onChange={() => setVisibility('private')} label="Private — only the creator" />
          </div>
        </Field>

        <Field label="Plan gate (empty = free for all)">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {TIERS.map((t) => (
              <TierToggle key={t.key} label={t.label} checked={planGate.includes(t.key)} onChange={() => toggleTier(t.key)} />
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
            If any tier is selected, only users on that tier (or higher) can clone the template. Selecting none = free for everyone.
          </div>
        </Field>

        <Field label="Setup steps (shown in the side panel when a user opens this template)">
          <div style={{ marginBottom: 8 }}>
            <button
              type="button"
              onClick={autoSteps}
              disabled={stepsBusy}
              style={{
                ...iconBtnStyle,
                background: 'rgba(168,85,247,0.10)',
                borderColor: 'rgba(168,85,247,0.4)',
                color: '#c4b5fd',
              }}
              title="Read the workflow's nodes and write a step-by-step setup guide"
            >
              {stepsBusy ? <Loader2 size={12} className="spin" /> : <ListChecks size={12} />} Auto-generate steps
            </button>
          </div>
          {steps.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 0' }}>
              No steps yet. Click "Auto-generate steps" or "Add step" to start.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {steps.map((s, i) => (
                <div key={i} style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: 10,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <span style={{
                      display: 'inline-grid', placeItems: 'center',
                      width: 20, height: 20, borderRadius: 999,
                      background: 'var(--red)', color: '#fff',
                      fontSize: 10, fontFamily: 'var(--font-display)', fontWeight: 700,
                    }}>{i + 1}</span>
                    <div style={{ flex: 1 }} />
                    <button type="button" onClick={() => moveStep(i, -1)} disabled={i === 0} style={{ ...iconOnlyBtn, opacity: i === 0 ? 0.4 : 1 }} title="Move up"><ArrowUp size={11} /></button>
                    <button type="button" onClick={() => moveStep(i, +1)} disabled={i === steps.length - 1} style={{ ...iconOnlyBtn, opacity: i === steps.length - 1 ? 0.4 : 1 }} title="Move down"><ArrowDown size={11} /></button>
                    <button type="button" onClick={() => removeStep(i)} style={{ ...iconOnlyBtn, color: 'var(--red)', borderColor: 'rgba(239,68,68,0.4)' }} title="Delete step"><Trash2 size={11} /></button>
                  </div>
                  <input
                    className="input"
                    placeholder="Step title (e.g. Pick your avatar)"
                    value={s.title || ''}
                    onChange={(e) => updateStep(i, { title: e.target.value })}
                    maxLength={120}
                    style={{ marginBottom: 6 }}
                  />
                  <textarea
                    className="input"
                    placeholder="What the user needs to do here. Keep it 1-3 sentences."
                    value={s.body || ''}
                    onChange={(e) => updateStep(i, { body: e.target.value })}
                    rows={2}
                    maxLength={600}
                    style={{ marginBottom: 6, fontFamily: 'inherit' }}
                  />
                  {nodeOptions.length > 0 && (
                    <select
                      className="input"
                      value={s.node_id || ''}
                      onChange={(e) => {
                        const id = e.target.value || null
                        const found = nodeOptions.find((n) => n.id === id)
                        updateStep(i, { node_id: id, node_type: found?.type || null })
                      }}
                      style={{ fontSize: 12 }}
                    >
                      <option value="">No linked node (just an instruction)</option>
                      {nodeOptions.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.label}{n.type && n.label !== n.type ? ` · ${n.type}` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ))}
            </div>
          )}
          <button type="button" onClick={addStep} className="btn-ghost" style={{ marginTop: 8, padding: '6px 12px', fontSize: 12 }}>
            <Plus size={12} /> Add step
          </button>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
            Steps appear in the side guide panel when a user opens this template. Linking a step to a node lets users click the step to jump to that node on the canvas.
          </div>
        </Field>

        <Field label="Sort order (lower = earlier in the gallery)">
          <input className="input" type="number" min={0} max={9999} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
        </Field>

        {err && <div style={errorBanner}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="button" onClick={save} className="btn-primary" disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />} Save changes
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-soft)', marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  )
}

function RadioPill({ checked, onChange, label }) {
  return (
    <button type="button" onClick={onChange} style={{
      ...pillBtnStyle,
      background: checked ? 'rgba(239,68,68,0.18)' : 'var(--surface-2)',
      borderColor: checked ? 'rgba(239,68,68,0.5)' : 'var(--border)',
      color: checked ? 'var(--text)' : 'var(--text-soft)',
    }}>
      {label}
    </button>
  )
}

function TierToggle({ label, checked, onChange }) {
  return (
    <button type="button" onClick={onChange} style={{
      ...pillBtnStyle, padding: '6px 12px', fontSize: 12,
      background: checked ? 'rgba(46,204,113,0.18)' : 'var(--surface-2)',
      borderColor: checked ? 'rgba(46,204,113,0.5)' : 'var(--border)',
      color: checked ? 'var(--text)' : 'var(--text-soft)',
    }}>
      {label}
    </button>
  )
}

const pageStyle = { padding: '32px 28px', maxWidth: 1100, margin: '0 auto' }
const hero = { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 }
const heroIcon = {
  width: 38, height: 38, borderRadius: 10,
  background: 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(249,115,22,0.10))',
  border: '1px solid rgba(239,68,68,0.30)',
  color: 'var(--red)',
  display: 'grid', placeItems: 'center',
}
const heroTitle = { fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, color: 'var(--text)', letterSpacing: '-0.01em' }
const heroSub = { fontSize: 13, color: 'var(--text-soft)', marginTop: 2 }
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 14 }
const card = {
  padding: 16, background: 'var(--surface)',
  border: '1px solid var(--border)', borderRadius: 14,
  display: 'flex', flexDirection: 'column',
}
const emptyCard = { ...card, maxWidth: 640 }
const cardTitle = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)' }
const cardBody = { fontSize: 13, color: 'var(--text-soft)', lineHeight: 1.5, marginBottom: 12 }
const cardMeta = { fontSize: 11, color: 'var(--muted)', marginBottom: 10, fontFamily: 'var(--font-mono, monospace)', letterSpacing: '0.04em' }
const cardActions = { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'auto' }
const ghostBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 12px', borderRadius: 8,
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  color: 'var(--text)', fontSize: 12, fontWeight: 700,
  textDecoration: 'none', cursor: 'pointer',
}
const iconBtnStyle = {
  ...ghostBtnStyle,
  padding: '6px 10px', fontSize: 11.5,
}
const iconOnlyBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 28, height: 28, borderRadius: 6,
  background: 'transparent', border: '1px solid var(--border)',
  color: 'var(--text-soft)', cursor: 'pointer', padding: 0,
}
const dangerBtnStyle = {
  ...iconBtnStyle,
  borderColor: 'rgba(239,68,68,0.4)',
  color: 'var(--red)',
  background: 'rgba(239,68,68,0.10)',
}
const visibilityPill = (v) => ({
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9.5,
  letterSpacing: '0.08em', textTransform: 'uppercase',
  padding: '2px 7px', borderRadius: 999,
  background: v === 'public' ? 'rgba(46,204,113,0.16)' : 'rgba(168,85,247,0.16)',
  color: v === 'public' ? '#2ecc71' : '#a855f7',
})
const tierPill = {
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9.5,
  letterSpacing: '0.04em',
  padding: '2px 7px', borderRadius: 999,
  background: 'rgba(99,102,241,0.16)', color: '#a5b4fc',
}
const categoryPill = {
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9.5,
  letterSpacing: '0.04em', textTransform: 'uppercase',
  padding: '2px 7px', borderRadius: 999,
  background: 'rgba(245,158,11,0.16)', color: '#fbbf24',
  border: '1px solid rgba(245,158,11,0.28)',
}
const freePill = {
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9.5,
  letterSpacing: '0.04em',
  padding: '2px 7px', borderRadius: 999,
  background: 'rgba(255,255,255,0.06)', color: 'var(--muted)',
}
const errorBanner = {
  padding: '8px 12px', borderRadius: 8,
  background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.4)',
  color: 'var(--red)', fontSize: 13, marginBottom: 12,
}
const pillBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 12px', borderRadius: 999,
  fontSize: 12, fontWeight: 600,
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  color: 'var(--text-soft)', cursor: 'pointer',
}
