import { useEffect, useState } from 'react'
import {
  Plus, Building2, Edit3, Trash2, X, Save, Sparkles, Check, Crown,
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

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-xl" onClick={(e) => e.stopPropagation()} style={{ minHeight: '60vh' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, flex: 1 }}>
            {isNew ? 'Create a brand profile' : 'Edit brand profile'}
          </h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={20} /></button>
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
            <input className="input" value={form.brand_secondary_color || ''} onChange={(e) => set('brand_secondary_color', e.target.value)} placeholder="#b91c1c" />
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
