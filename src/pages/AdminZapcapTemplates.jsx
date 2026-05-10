// Admin page for the ZapCap caption template catalog.
//
// Two flows:
//   1. "Sync from ZapCap" — pulls live id+title from the upstream API,
//      upserts each row leaving preview_gif_url / sort_order / active
//      untouched. New templates appear at the bottom (sort_order = 100
//      default) until you reorder them.
//   2. Per-row paste of a Supabase Storage URL into Preview GIF, plus
//      sort order, an active toggle, and an inline title override.
//
// Saves are inline (PATCH on blur) so the workflow is "click cell, paste,
// tab away" — no save button to forget.

import { useEffect, useState } from 'react'
import { Captions, Loader2, RefreshCw, Eye, EyeOff, Trash2, AlertCircle, Check } from 'lucide-react'
import { supabase } from '../lib/supabase.js'

async function authedFetch(path, init = {}) {
  const sess = (await supabase.auth.getSession()).data.session
  return fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sess?.access_token || ''}`,
      ...(init.headers || {}),
    },
  })
}

export default function AdminZapcapTemplates() {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null) // 'sync' | null
  const [savingId, setSavingId] = useState(null)
  const [syncResult, setSyncResult] = useState(null)

  const refresh = async () => {
    try {
      const r = await authedFetch('/api/admin/zapcap-templates')
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error || `Load failed (${r.status})`)
      setRows(body.templates || [])
      setError(null)
    } catch (e) {
      setError(e.message); setRows([])
    }
  }
  useEffect(() => { refresh() }, [])

  const sync = async () => {
    setBusy('sync'); setSyncResult(null)
    try {
      const r = await authedFetch('/api/admin/zapcap-templates?action=sync', { method: 'POST' })
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error || `Sync failed (${r.status})`)
      setSyncResult({ kind: 'ok', message: `Synced ${body.upserted} of ${body.live_total} templates from ZapCap.` })
      await refresh()
    } catch (e) {
      setSyncResult({ kind: 'err', message: e.message })
    } finally {
      setBusy(null)
    }
  }

  const patch = async (template_id, updates) => {
    setSavingId(template_id)
    setRows((arr) => (arr || []).map((r) => r.template_id === template_id ? { ...r, ...updates } : r))
    try {
      const r = await authedFetch('/api/admin/zapcap-templates', {
        method: 'PATCH',
        body: JSON.stringify({ template_id, ...updates }),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error(b?.error || `Save failed (${r.status})`)
      }
    } catch (e) {
      setError(e.message)
      refresh()
    } finally {
      setSavingId(null)
    }
  }

  const remove = async (template_id) => {
    if (!confirm(`Remove "${template_id}" from the catalog? Sync re-adds it next run.`)) return
    setSavingId(template_id)
    try {
      await authedFetch(`/api/admin/zapcap-templates?template_id=${encodeURIComponent(template_id)}`, { method: 'DELETE' })
      setRows((arr) => (arr || []).filter((r) => r.template_id !== template_id))
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div style={{ padding: '32px 28px', maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: 'linear-gradient(135deg, rgba(59,130,246,0.18), rgba(96,165,250,0.10))',
          border: '1px solid rgba(59,130,246,0.30)',
          color: '#60a5fa', display: 'grid', placeItems: 'center',
        }}>
          <Captions size={18} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22 }}>ZapCap caption templates</div>
          <div style={{ fontSize: 13, color: 'var(--text-soft)', marginTop: 2 }}>
            Sync IDs and titles from ZapCap. Drop a Supabase Storage GIF in the Preview column; users see it in the captions picker instead of ZapCap's demo footage.
          </div>
        </div>
        <button
          onClick={sync}
          disabled={busy === 'sync'}
          style={{
            padding: '8px 14px', borderRadius: 8,
            background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
            color: '#fff', border: 'none', fontWeight: 700, fontFamily: 'var(--font-display)',
            cursor: busy === 'sync' ? 'wait' : 'pointer', fontSize: 13,
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          {busy === 'sync' ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
          Sync from ZapCap
        </button>
      </div>

      {syncResult && (
        <div style={{
          padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14,
          background: syncResult.kind === 'ok' ? 'rgba(46,204,113,0.10)' : 'var(--red-soft)',
          color: syncResult.kind === 'ok' ? '#2ecc71' : 'var(--red)',
          border: `1px solid ${syncResult.kind === 'ok' ? 'rgba(46,204,113,0.30)' : 'rgba(239,68,68,0.30)'}`,
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}>
          {syncResult.kind === 'ok' ? <Check size={13} /> : <AlertCircle size={13} />}
          {syncResult.message}
        </div>
      )}

      {error && (
        <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>{error}</div>
      )}

      {!rows ? (
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} className="spin" /></div>
      ) : rows.length === 0 ? (
        <div style={{
          padding: 40, textAlign: 'center', color: 'var(--muted)',
          background: 'var(--surface)', border: '1px dashed var(--border)', borderRadius: 12, fontSize: 13,
        }}>
          No templates yet. Click <strong>Sync from ZapCap</strong> to pull the catalog.
        </div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th style={th}>Preview</th>
                  <th style={th}>Title</th>
                  <th style={th}>Template ID</th>
                  <th style={{ ...th, width: 360 }}>Preview GIF URL (Supabase)</th>
                  <th style={{ ...th, width: 80, textAlign: 'right' }}>Sort</th>
                  <th style={{ ...th, width: 70, textAlign: 'center' }}>Active</th>
                  <th style={{ ...th, width: 60, textAlign: 'center' }}>Synced</th>
                  <th style={{ ...th, width: 50 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.template_id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: 8 }}>
                      <PreviewCell url={r.preview_gif_url} />
                    </td>
                    <td style={{ padding: 8 }}>
                      <InlineInput
                        value={r.title || ''}
                        placeholder="Title"
                        onCommit={(v) => patch(r.template_id, { title: v })}
                      />
                    </td>
                    <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 11, color: 'var(--text-soft)' }}>
                      {r.template_id}
                    </td>
                    <td style={{ padding: 8 }}>
                      <InlineInput
                        value={r.preview_gif_url || ''}
                        placeholder="https://…/landing-media/captions/style.gif"
                        onCommit={(v) => patch(r.template_id, { preview_gif_url: v.trim() || null })}
                      />
                    </td>
                    <td style={{ padding: 8, textAlign: 'right' }}>
                      <InlineInput
                        type="number"
                        value={String(r.sort_order ?? 100)}
                        onCommit={(v) => patch(r.template_id, { sort_order: parseInt(v, 10) || 0 })}
                        style={{ maxWidth: 60, textAlign: 'right' }}
                      />
                    </td>
                    <td style={{ padding: 8, textAlign: 'center' }}>
                      <button
                        type="button"
                        onClick={() => patch(r.template_id, { active: !r.active })}
                        title={r.active ? 'Visible to users' : 'Hidden from picker'}
                        style={{
                          background: 'transparent', border: 'none', cursor: 'pointer',
                          color: r.active ? '#2ecc71' : 'var(--muted)', padding: 4,
                        }}
                      >
                        {r.active ? <Eye size={14} /> : <EyeOff size={14} />}
                      </button>
                    </td>
                    <td style={{ padding: 8, textAlign: 'center', fontSize: 11, color: 'var(--muted)' }}>
                      {r.last_synced_at ? new Date(r.last_synced_at).toLocaleDateString() : '—'}
                    </td>
                    <td style={{ padding: 8, textAlign: 'center' }}>
                      {savingId === r.template_id ? (
                        <Loader2 size={12} className="spin" style={{ color: 'var(--muted)' }} />
                      ) : (
                        <button
                          type="button" onClick={() => remove(r.template_id)} title="Remove (sync re-adds)"
                          style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4 }}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function PreviewCell({ url }) {
  if (!url) {
    return (
      <div style={{
        width: 64, height: 64, borderRadius: 6,
        background: 'var(--surface-2)', border: '1px dashed var(--border)',
        display: 'grid', placeItems: 'center', color: 'var(--muted)', fontSize: 10,
      }}>none</div>
    )
  }
  const isVideo = /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url)
  return (
    <div style={{
      width: 64, height: 64, borderRadius: 6,
      background: '#000', border: '1px solid var(--border)', overflow: 'hidden',
    }}>
      {isVideo
        ? <video src={url} muted loop autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : <img src={url} alt="preview" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      }
    </div>
  )
}

// Inline cell with focused-out commit. Avoids a save button per row;
// the table just feels editable in place.
function InlineInput({ value, placeholder, type = 'text', onCommit, style }) {
  const [draft, setDraft] = useState(value || '')
  useEffect(() => { setDraft(value || '') }, [value])
  return (
    <input
      type={type}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if ((draft ?? '') !== (value ?? '')) onCommit(draft) }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.target.blur()
        if (e.key === 'Escape') { setDraft(value || ''); e.target.blur() }
      }}
      style={{
        width: '100%', padding: '6px 8px', borderRadius: 6,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        color: 'var(--text)', fontSize: 12,
        ...(style || {}),
      }}
    />
  )
}

const th = {
  padding: '10px 8px', textAlign: 'left',
  fontFamily: 'var(--font-display)', fontSize: 10.5, fontWeight: 700,
  letterSpacing: '0.06em', textTransform: 'uppercase',
  color: 'var(--muted)', background: 'var(--surface-2)',
}
