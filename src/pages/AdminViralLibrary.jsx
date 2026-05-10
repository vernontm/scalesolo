import { useEffect, useMemo, useState } from 'react'
import {
  Sparkles, Plus, Trash2, Pencil, Loader2, RefreshCw, Search, Save, X,
  ExternalLink, ToggleLeft, ToggleRight,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { toast } from '../components/Toast.jsx'

// Admin-only viral library. Holds reference scripts the platform can
// pull as fallback few-shot examples for new brands or for any
// brand-profile that's low on its own training data. Every row is
// admin-curated; the API endpoint is service-role gated.

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

const EMPTY = { text: '', hook: '', format: '', niche: '', source_url: '', notes: '', active: true }

export default function AdminViralLibrary() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null)        // row being edited (null = none)
  const [creating, setCreating] = useState(false)     // shows the New form
  const [filterNiche, setFilterNiche] = useState('')
  const [q, setQ] = useState('')

  const refresh = async () => {
    setLoading(true); setError(null)
    try {
      const r = await authedFetch('/api/admin/viral-library')
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      setItems(body.items || [])
    } catch (e) { setError(e.message); setItems([]) }
    finally { setLoading(false) }
  }
  useEffect(() => { refresh() }, [])

  const niches = useMemo(() => {
    const s = new Set()
    for (const it of items) if (it.niche) s.add(it.niche)
    return Array.from(s).sort()
  }, [items])

  const filtered = useMemo(() => {
    let out = items
    if (filterNiche) out = out.filter((it) => (it.niche || '') === filterNiche)
    const term = q.trim().toLowerCase()
    if (term) {
      out = out.filter((it) =>
        (it.text || '').toLowerCase().includes(term) ||
        (it.hook || '').toLowerCase().includes(term) ||
        (it.notes || '').toLowerCase().includes(term)
      )
    }
    return out
  }, [items, filterNiche, q])

  const remove = async (id) => {
    if (!window.confirm('Delete this viral entry permanently?')) return
    try {
      const r = await authedFetch(`/api/admin/viral-library?id=${id}`, { method: 'DELETE' })
      if (!r.ok && r.status !== 204) {
        const b = await r.json().catch(() => ({}))
        throw new Error(b.error || 'Delete failed')
      }
      toast?.success?.('Deleted')
      refresh()
    } catch (e) { toast?.error?.(e.message) || alert(e.message) }
  }

  const toggleActive = async (item) => {
    try {
      const r = await authedFetch(`/api/admin/viral-library?id=${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !item.active }),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error(b.error || 'Update failed')
      }
      refresh()
    } catch (e) { toast?.error?.(e.message) || alert(e.message) }
  }

  return (
    <div style={{ padding: '32px 28px', maxWidth: 1240, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
        <div style={iconWrap}><Sparkles size={18} /></div>
        <div style={{ flex: 1 }}>
          <div style={heroTitle}>Viral library</div>
          <div style={heroSub}>
            Reference scripts the platform pulls as fallback examples for low-data brand profiles.
            Add high-performing posts you've seen succeed across niches.
          </div>
        </div>
        <button onClick={refresh} disabled={loading} style={btnGhost(loading)}>
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
        </button>
        <button onClick={() => { setCreating(true); setEditing(null) }} className="btn-primary" style={{ padding: '8px 14px', fontSize: 13 }}>
          <Plus size={13} /> Add entry
        </button>
      </div>

      {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>{error}</div>}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 360 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search text, hook, notes…"
            style={searchInput}
          />
        </div>
        <select value={filterNiche} onChange={(e) => setFilterNiche(e.target.value)} style={selectStyle}>
          <option value="">All niches ({items.length})</option>
          {niches.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {/* Create form */}
      {creating && (
        <EntryForm
          initial={EMPTY}
          onCancel={() => setCreating(false)}
          onSaved={() => { setCreating(false); refresh() }}
        />
      )}

      {/* List */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 12, marginTop: 16 }}>
        {filtered.length === 0 && !loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', gridColumn: '1 / -1' }}>
            {items.length === 0 ? 'No entries yet. Click "Add entry" to seed the library.' : 'No entries match the filter.'}
          </div>
        ) : filtered.map((it) => (
          editing?.id === it.id ? (
            <EntryForm
              key={it.id}
              initial={it}
              onCancel={() => setEditing(null)}
              onSaved={() => { setEditing(null); refresh() }}
            />
          ) : (
            <div key={it.id} className="card-flat" style={{ padding: 14, opacity: it.active ? 1 : 0.6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                {it.niche && <Pill kind="niche">{it.niche}</Pill>}
                {it.format && <Pill kind="format">{it.format}</Pill>}
                {!it.active && <Pill kind="off">inactive</Pill>}
                <div style={{ flex: 1 }} />
                <button onClick={() => toggleActive(it)} title={it.active ? 'Deactivate' : 'Reactivate'} style={iconBtn}>
                  {it.active ? <ToggleRight size={13} /> : <ToggleLeft size={13} />}
                </button>
                <button onClick={() => { setEditing(it); setCreating(false) }} title="Edit" style={iconBtn}>
                  <Pencil size={11} />
                </button>
                <button onClick={() => remove(it.id)} title="Delete" style={iconBtn}>
                  <Trash2 size={11} />
                </button>
              </div>
              {it.hook && (
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13.5, color: 'var(--text)', marginBottom: 6 }}>
                  {it.hook}
                </div>
              )}
              <div style={{ fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                {(it.text || '').slice(0, 320)}{it.text?.length > 320 ? '…' : ''}
              </div>
              {it.notes && (
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, fontStyle: 'italic' }}>
                  Note: {it.notes}
                </div>
              )}
              {it.source_url && (
                <a href={it.source_url} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, color: 'var(--red)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 8 }}>
                  <ExternalLink size={10} /> source
                </a>
              )}
            </div>
          )
        ))}
      </div>
    </div>
  )
}

function EntryForm({ initial, onCancel, onSaved }) {
  const [form, setForm] = useState({ ...EMPTY, ...initial })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const isEdit = !!initial?.id

  const save = async () => {
    if (!form.text?.trim()) { setError('text required'); return }
    setBusy(true); setError(null)
    try {
      const path = isEdit ? `/api/admin/viral-library?id=${initial.id}` : '/api/admin/viral-library'
      const r = await authedFetch(path, {
        method: isEdit ? 'PATCH' : 'POST',
        body: JSON.stringify(form),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error || 'Save failed')
      toast?.success?.(isEdit ? 'Updated' : 'Added')
      onSaved()
    } catch (e) { setError(e.message); setBusy(false) }
  }

  return (
    <div className="card-flat" style={{ padding: 14, gridColumn: '1 / -1', borderColor: 'rgba(239,68,68,0.4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Plus size={13} style={{ color: 'var(--red)' }} />
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13.5 }}>
          {isEdit ? 'Edit entry' : 'New viral entry'}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={onCancel} style={iconBtn}><X size={13} /></button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 10 }}>
        <input className="input" placeholder="Hook (opener line)"
          value={form.hook || ''} onChange={(e) => setForm({ ...form, hook: e.target.value })}
          style={{ fontSize: 12.5 }} />
        <input className="input" placeholder="Format (story / listicle / hot_take…)"
          value={form.format || ''} onChange={(e) => setForm({ ...form, format: e.target.value })}
          style={{ fontSize: 12.5 }} />
        <input className="input" placeholder="Niche (relationships / fitness / saas…)"
          value={form.niche || ''} onChange={(e) => setForm({ ...form, niche: e.target.value })}
          style={{ fontSize: 12.5 }} />
        <input className="input" placeholder="Source URL (optional)"
          value={form.source_url || ''} onChange={(e) => setForm({ ...form, source_url: e.target.value })}
          style={{ fontSize: 12.5 }} />
      </div>

      <textarea
        className="textarea"
        placeholder="Full script text (the actual viral copy)"
        value={form.text || ''} onChange={(e) => setForm({ ...form, text: e.target.value })}
        style={{ width: '100%', minHeight: 120, fontSize: 13, marginBottom: 10 }}
      />

      <input
        className="input" placeholder="Notes (why it worked, what to copy)"
        value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })}
        style={{ fontSize: 12.5, marginBottom: 10 }}
      />

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-soft)', marginBottom: 12 }}>
        <input type="checkbox" checked={!!form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
        Active (used as a fallback example)
      </label>

      {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '6px 10px', borderRadius: 6, fontSize: 12, marginBottom: 10 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn-secondary" onClick={onCancel} disabled={busy} style={{ fontSize: 12, padding: '7px 12px' }}>Cancel</button>
        <button className="btn-primary" onClick={save} disabled={busy} style={{ fontSize: 12, padding: '7px 12px' }}>
          {busy ? <Loader2 size={11} className="spin" /> : <Save size={11} />} {isEdit ? 'Save' : 'Add'}
        </button>
      </div>
    </div>
  )
}

function Pill({ kind, children }) {
  const map = {
    niche:  { bg: 'rgba(99,102,241,0.16)', color: '#a5b4fc' },
    format: { bg: 'rgba(245,158,11,0.16)', color: '#fbbf24' },
    off:    { bg: 'rgba(239,68,68,0.16)',  color: 'var(--red)' },
  }
  const s = map[kind] || map.format
  return <span style={{
    fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
    background: s.bg, color: s.color, textTransform: 'uppercase', letterSpacing: '0.04em',
  }}>{children}</span>
}

const iconWrap = {
  width: 38, height: 38, borderRadius: 10,
  background: 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(249,115,22,0.10))',
  border: '1px solid rgba(239,68,68,0.30)', color: 'var(--red)',
  display: 'grid', placeItems: 'center',
}
const heroTitle = { fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22 }
const heroSub = { fontSize: 13, color: 'var(--text-soft)', marginTop: 2 }
const btnGhost = (loading) => ({
  padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--surface-2)', color: 'var(--text-soft)',
  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5,
  cursor: loading ? 'wait' : 'pointer', fontFamily: 'inherit',
})
const iconBtn = {
  width: 24, height: 24, borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--surface-2)', color: 'var(--muted)', cursor: 'pointer',
  display: 'grid', placeItems: 'center',
}
const searchInput = {
  width: '100%', padding: '8px 10px 8px 30px',
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  borderRadius: 8, fontSize: 13, color: 'var(--text)', outline: 'none',
}
const selectStyle = {
  padding: '8px 10px', background: 'var(--surface-2)', border: '1px solid var(--border)',
  borderRadius: 8, fontSize: 13, color: 'var(--text)', outline: 'none', fontFamily: 'inherit',
}
