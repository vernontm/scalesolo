import { useEffect, useState } from 'react'
import Papa from 'papaparse'
import {
  Users, Upload, Search, X, ChevronRight, FileText, AlertCircle, CheckCircle2,
} from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'

const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 13 }
const th = { textAlign: 'left', color: 'var(--muted)', fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '12px 14px', borderBottom: '1px solid var(--border)' }
const td = { padding: '14px', borderBottom: '1px solid var(--border)', color: 'var(--text-soft)' }

const FIELDS = [
  { value: 'email', label: 'Email *' },
  { value: 'name', label: 'Name' },
  { value: 'phone', label: 'Phone' },
  { value: 'tags', label: 'Tags (comma-sep)' },
  { value: 'city', label: 'City' },
  { value: 'state', label: 'State' },
  { value: 'country', label: 'Country' },
  { value: 'source', label: 'Source' },
  { value: '_skip', label: '— Skip —' },
]

function autoMap(header) {
  const h = header.toLowerCase().replace(/\s+/g, '')
  if (/email/.test(h)) return 'email'
  if (/^name|fullname|firstname|first_name/.test(h)) return 'name'
  if (/phone|mobile|cell/.test(h)) return 'phone'
  if (/tag/.test(h)) return 'tags'
  if (/city/.test(h)) return 'city'
  if (/state|province/.test(h)) return 'state'
  if (/country/.test(h)) return 'country'
  if (/source|origin/.test(h)) return 'source'
  return '_skip'
}

function ImportModal({ profileId, onClose, onDone }) {
  const { session } = useAuth()
  const [step, setStep] = useState(1)
  const [filename, setFilename] = useState('')
  const [headers, setHeaders] = useState([])
  const [preview, setPreview] = useState([])
  const [rows, setRows] = useState([])
  const [mapping, setMapping] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const onFile = (file) => {
    if (!file) return
    setFilename(file.name)
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const fields = res.meta.fields || []
        setHeaders(fields)
        setMapping(Object.fromEntries(fields.map((f) => [f, autoMap(f)])))
        setRows(res.data)
        setPreview(res.data.slice(0, 5))
        setStep(2)
      },
      error: (e) => setError(e.message),
    })
  }

  const run = async () => {
    setBusy(true); setError(null)
    try {
      const finalMapping = Object.fromEntries(
        Object.entries(mapping).filter(([, v]) => v && v !== '_skip')
      )
      if (!Object.values(finalMapping).includes('email')) {
        throw new Error('Map at least one column to Email.')
      }
      const r = await fetch('/api/contacts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ profile_id: profileId, filename, mapping: finalMapping, rows }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Import failed')
      setResult(body)
      setStep(3)
      onDone?.()
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-lg" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, flex: 1 }}>Import contacts from CSV</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={20} /></button>
        </div>

        {step === 1 && (
          <label style={{
            display: 'block', padding: 40, textAlign: 'center', cursor: 'pointer',
            background: 'var(--surface-2)', border: '2px dashed var(--border)', borderRadius: 14,
          }}>
            <input type="file" accept=".csv,text/csv" hidden onChange={(e) => onFile(e.target.files?.[0])} />
            <Upload size={32} style={{ color: 'var(--muted)', marginBottom: 12 }} />
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: 'var(--text)', marginBottom: 6 }}>
              Drop a CSV file or click to choose
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>First row should be column headers. Email column required.</div>
          </label>
        )}

        {step === 2 && (
          <>
            <div style={{ marginBottom: 14, fontSize: 13, color: 'var(--text-soft)' }}>
              <FileText size={14} style={{ verticalAlign: '-2px' }} /> <strong>{filename}</strong> · {rows.length} rows
            </div>

            <div style={{ marginBottom: 18, padding: 14, background: 'var(--surface-2)', borderRadius: 12, border: '1px solid var(--border)' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>
                Map columns
              </div>
              {headers.map((h) => (
                <div key={h} style={{ display: 'grid', gridTemplateColumns: '1fr 12px 1fr', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontSize: 13, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h}</div>
                  <ChevronRight size={12} style={{ color: 'var(--muted)' }} />
                  <select className="select" value={mapping[h] || '_skip'} onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))}>
                    {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </div>
              ))}
            </div>

            <div style={{ marginBottom: 18 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
                Preview (first 5 rows)
              </div>
              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
                <table style={tableStyle}>
                  <thead><tr>{headers.map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {preview.map((r, i) => (
                      <tr key={i}>{headers.map((h) => <td key={h} style={td}>{r[h]}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 12 }}><AlertCircle size={14} style={{ verticalAlign: '-2px' }} /> {error}</div>}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={() => setStep(1)}>Back</button>
              <button className="btn-primary" onClick={run} disabled={busy}>
                {busy ? <span className="spinner" /> : <Upload size={14} />} Import {rows.length} rows
              </button>
            </div>
          </>
        )}

        {step === 3 && result && (
          <div style={{ textAlign: 'center', padding: '20px 12px' }}>
            <div style={{ width: 56, height: 56, borderRadius: 14, background: 'rgba(46,204,113,0.16)', color: '#2ecc71', display: 'grid', placeItems: 'center', margin: '0 auto 16px' }}>
              <CheckCircle2 size={28} />
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18, marginBottom: 6 }}>Import complete</div>
            <div style={{ color: 'var(--muted)', fontSize: 13.5, marginBottom: 22 }}>
              <strong style={{ color: 'var(--text)' }}>{result.imported}</strong> imported · <strong style={{ color: 'var(--text)' }}>{result.skipped}</strong> skipped (duplicates or no email) · <strong style={{ color: 'var(--text)' }}>{result.failed}</strong> failed
            </div>
            <button className="btn-primary" onClick={onClose}>Done</button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function Contacts() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  const [contacts, setContacts] = useState([])
  const [search, setSearch] = useState('')
  const [importing, setImporting] = useState(false)
  const [loading, setLoading] = useState(true)

  const refresh = () => {
    if (!session || !selectedProfileId) return
    setLoading(true)
    fetch(`https://${import.meta.env.VITE_SUPABASE_URL.replace(/^https?:\/\//, '')}/rest/v1/email_contacts?profile_id=eq.${selectedProfileId}&order=created_at.desc&limit=200&select=id,email,name,phone,tags,status,source,created_at`, {
      headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((rows) => setContacts(rows || []))
      .catch(() => setContacts([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [session, selectedProfileId])

  const filtered = contacts.filter((c) => {
    if (!search) return true
    const s = search.toLowerCase()
    return (c.email || '').toLowerCase().includes(s) || (c.name || '').toLowerCase().includes(s)
  })

  if (!selectedProfileId) {
    return <div className="card-flat fade-up" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      Pick a brand profile to view contacts.
    </div>
  }

  return (
    <div className="fade-up">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
          <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input
            className="input"
            style={{ paddingLeft: 36 }}
            placeholder="Search contacts…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button className="btn-secondary" onClick={() => setImporting(true)}>
          <Upload size={14} /> Import CSV
        </button>
      </div>

      <div className="card-flat" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 50, textAlign: 'center', color: 'var(--muted)' }}>
            <Users size={32} style={{ marginBottom: 12 }} />
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--text)', fontSize: 15, marginBottom: 4 }}>
              {contacts.length === 0 ? 'No contacts yet' : 'No matches'}
            </div>
            <div style={{ fontSize: 13 }}>
              {contacts.length === 0 ? 'Import a CSV or build a form to start collecting.' : 'Try a different search term.'}
            </div>
          </div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Email</th>
                <th style={th}>Name</th>
                <th style={th}>Tags</th>
                <th style={th}>Source</th>
                <th style={th}>Added</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td style={td}><span style={{ color: 'var(--text)', fontWeight: 600 }}>{c.email}</span></td>
                  <td style={td}>{c.name || '—'}</td>
                  <td style={td}>{Array.isArray(c.tags) && c.tags.length ? c.tags.map((t) => <span key={t} className="pill pill-muted" style={{ marginRight: 4 }}>{t}</span>) : '—'}</td>
                  <td style={td}>{c.source || '—'}</td>
                  <td style={td}>{new Date(c.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {importing && <ImportModal profileId={selectedProfileId} onClose={() => setImporting(false)} onDone={refresh} />}
    </div>
  )
}
