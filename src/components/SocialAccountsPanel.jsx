// Social accounts + posting defaults for a brand. Extracted from the Schedule
// page (Content.jsx) so the mobile redesign can move it onto its own
// Connections screen while desktop keeps it inline. Logic is unchanged:
// connect via the upload-post JWT flow, per-brand default platforms + TikTok
// direct-post persisted on the ScaleSolo profile row.
import { useState, useEffect } from 'react'
import { Link2, Plus, ExternalLink, AlertCircle, Check } from 'lucide-react'
import { useProfile } from '../context/ProfileContext.jsx'
import { toast } from './Toast.jsx'

export const SOCIAL_PLATFORMS = [
  { id: 'tiktok',    label: 'TikTok',    color: '#000' },
  { id: 'instagram', label: 'Instagram', color: '#E1306C' },
  { id: 'youtube',   label: 'YouTube',   color: '#FF0000' },
  { id: 'x',         label: 'X',         color: '#000' },
  { id: 'threads',   label: 'Threads',   color: '#000' },
  { id: 'linkedin',  label: 'LinkedIn',  color: '#0A66C2' },
  { id: 'facebook',  label: 'Facebook',  color: '#1877F2' },
  { id: 'pinterest', label: 'Pinterest', color: '#BD081C' },
]

export default function SocialAccountsPanel({ profileId, token }) {
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [connecting, setConnecting] = useState(false)
  // Per-brand posting defaults live on the ScaleSolo profile row (loaded via
  // ProfileContext with all columns), NOT the upload-post profile above.
  const { profiles, refresh: refreshProfiles } = useProfile()
  const ssProfile = (profiles || []).find((p) => p.id === profileId) || null
  const [defaults, setDefaults] = useState([])
  const [directPost, setDirectPost] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const dpKey = JSON.stringify(ssProfile?.default_platforms || [])
  useEffect(() => {
    setDefaults(Array.isArray(ssProfile?.default_platforms) ? ssProfile.default_platforms : [])
    setDirectPost(!!ssProfile?.tiktok_force_direct_post)
    setDirty(false)
  }, [profileId, ssProfile?.id, dpKey, ssProfile?.tiktok_force_direct_post])

  const refresh = () => {
    if (!profileId || !token) return
    setLoading(true); setErr(null)
    fetch(`/api/social/profiles?profile_id=${profileId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json().then((b) => ({ ok: r.ok, body: b })))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body?.error || 'Failed to load social accounts')
        setProfile(body)
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false))
  }
  useEffect(refresh, [profileId, token])

  const onConnect = async () => {
    setConnecting(true); setErr(null)
    try {
      const r = await fetch('/api/social/profiles?action=jwt', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId, redirect_url: window.location.href }),
      })
      const body = await r.json()
      if (!r.ok || !body.access_url) throw new Error(body?.error || `Connect failed (${r.status})`)
      // Open in a new tab so the user keeps their place in ScaleSolo. They
      // come back to this tab and hit "Refresh" to see the new connection.
      window.open(body.access_url, '_blank', 'noopener')
    } catch (e) {
      setErr(e.message)
    } finally {
      setConnecting(false)
    }
  }

  const social = profile?.profile?.social_accounts || {}
  const connectedIds = Object.entries(social)
    .filter(([, info]) => info && (info === true || info.access_token || info.connected || info.username))
    .map(([id]) => id)

  // Toggle a platform in the default set. An empty default set means "all
  // connected" (the scheduler's own fallback), so the first toggle expands to
  // the full connected list before removing the one clicked.
  const toggleDefault = (id) => {
    setDefaults((cur) => {
      const base = (!cur || cur.length === 0) ? [...connectedIds] : cur
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id]
    })
    setDirty(true)
  }
  const saveSettings = async () => {
    setSavingSettings(true)
    try {
      const r = await fetch(`/api/profiles?id=${profileId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ default_platforms: defaults, tiktok_force_direct_post: directPost }),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b.error || 'Failed to save')
      toast({ message: 'Posting defaults saved', kind: 'success' })
      setDirty(false); refreshProfiles()
    } catch (e) { toast({ message: e.message, kind: 'error' }) } finally { setSavingSettings(false) }
  }

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
      padding: 16, marginBottom: 18,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ width: 28, height: 28, borderRadius: 7, background: 'linear-gradient(135deg, #2ecc71, #1abc9c)', color: '#fff', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Link2 size={14} />
        </div>
        <div style={{ flex: 1, minWidth: 150 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14 }}>Social accounts</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Connect the platforms ScaleSolo can publish to for this brand.
          </div>
        </div>
        <button className="btn-secondary" onClick={refresh} disabled={loading} style={{ padding: '6px 10px' }}>
          {loading ? <span className="spinner" /> : 'Refresh'}
        </button>
        <button className="btn-primary" onClick={onConnect} disabled={connecting}>
          {connecting ? <span className="spinner" /> : <Plus size={13} />}
          {connectedIds.length ? 'Add / manage' : 'Connect accounts'}
          <ExternalLink size={11} style={{ opacity: 0.7 }} />
        </button>
      </div>
      {err && (
        <div style={{ padding: '8px 10px', background: 'var(--red-soft)', color: 'var(--red)', fontSize: 12, borderRadius: 8, marginBottom: 10 }}>
          <AlertCircle size={12} style={{ verticalAlign: '-2px', marginRight: 6 }} /> {err}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {SOCIAL_PLATFORMS.map((p) => {
          const connected = connectedIds.includes(p.id)
          const info = social[p.id]
          // Only show a handle in the pill if it looks like an actual
          // username. Upload-Post returns whatever the platform stores;
          // for some that's a numeric ID (Instagram graph user_id,
          // TikTok open_id) or a YouTube channel ID (24 chars,
          // typically starting with UC). All of those are useless to
          // the user and look like leaked internals — filter them.
          const rawHandle = info?.username || info?.display_name || info?.handle || ''
          const looksLikeRealHandle = (() => {
            if (typeof rawHandle !== 'string') return false
            if (!rawHandle.length || rawHandle.length >= 30) return false
            if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(rawHandle)) return false
            // YouTube channel id pattern: UC + 22 alphanumeric/-_ chars.
            if (/^UC[A-Za-z0-9_-]{22}$/.test(rawHandle)) return false
            // Mostly digits → almost certainly an internal ID.
            const digits = (rawHandle.match(/\d/g) || []).length
            if (rawHandle.length >= 10 && digits / rawHandle.length > 0.6) return false
            return true
          })()
          const handle = looksLikeRealHandle ? rawHandle : null
          return (
            <div
              key={p.id}
              title={connected && handle ? `Connected as @${handle}` : connected ? 'Connected' : 'Not connected'}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 10px', borderRadius: 999,
                background: connected ? 'rgba(46,204,113,0.14)' : 'var(--surface-2)',
                border: `1px solid ${connected ? 'rgba(46,204,113,0.45)' : 'var(--border)'}`,
                color: connected ? '#2ecc71' : 'var(--muted)',
                fontSize: 11.5, fontFamily: 'var(--font-display)', fontWeight: 700,
                letterSpacing: '0.02em',
              }}
            >
              <span style={{
                width: 6, height: 6, borderRadius: 999,
                background: connected ? '#2ecc71' : 'var(--muted)',
              }} />
              {p.label}
              {connected && handle && <span style={{ color: 'var(--muted)', fontWeight: 500, display: 'inline-block', maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>· @{handle}</span>}
            </div>
          )
        })}
      </div>

      {connectedIds.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, marginBottom: 2 }}>Posting defaults</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8 }}>
            Which platforms new posts and board drafts publish to by default.{(!defaults || defaults.length === 0) ? ' Right now: all connected.' : ''}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {connectedIds.map((id) => {
              const on = (!defaults || defaults.length === 0) ? true : defaults.includes(id)
              const label = SOCIAL_PLATFORMS.find((p) => p.id === id)?.label || id
              return (
                <button
                  key={id} type="button" onClick={() => toggleDefault(id)}
                  title={on ? 'Posts here by default' : 'Skipped by default'}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 999,
                    cursor: 'pointer', fontSize: 11.5, fontWeight: 700,
                    background: on ? 'rgba(46,204,113,0.14)' : 'var(--surface-2)',
                    border: `1px solid ${on ? 'rgba(46,204,113,0.45)' : 'var(--border)'}`,
                    color: on ? '#2ecc71' : 'var(--muted)',
                  }}
                >
                  {on && <Check size={12} />}{label}
                </button>
              )
            })}
          </div>
          {connectedIds.includes('tiktok') && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer', marginBottom: 4 }}>
              <input type="checkbox" checked={directPost} onChange={() => { setDirectPost((v) => !v); setDirty(true) }} />
              <span>Post to TikTok straight to the public feed (instead of leaving a draft in the TikTok app)</span>
            </label>
          )}
          {dirty && (
            <button className="btn-primary" onClick={saveSettings} disabled={savingSettings} style={{ marginTop: 8 }}>
              {savingSettings ? <span className="spinner" /> : 'Save posting defaults'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
