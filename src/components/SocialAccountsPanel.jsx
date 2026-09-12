// Social accounts + posting defaults for a brand. Extracted from the Schedule
// page (Content.jsx) so the mobile redesign can move it onto its own
// Connections screen while desktop keeps it inline. Logic is unchanged:
// connect via the upload-post JWT flow, per-brand default platforms + TikTok
// direct-post persisted on the ScaleSolo profile row.
import { useState, useEffect, useRef } from 'react'
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
  // Posting defaults save automatically (no Save button). autoStatus drives a
  // small "Saving… / Saved" hint; saveTimer debounces rapid toggles into one
  // PATCH.
  const [autoStatus, setAutoStatus] = useState('idle') // idle | saving | saved | error
  const saveTimer = useRef(null)
  const dpKey = JSON.stringify(ssProfile?.default_platforms || [])
  useEffect(() => {
    setDefaults(Array.isArray(ssProfile?.default_platforms) ? ssProfile.default_platforms : [])
    setDirectPost(!!ssProfile?.tiktok_force_direct_post)
  }, [profileId, ssProfile?.id, dpKey, ssProfile?.tiktok_force_direct_post])
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

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

  // Persist the posting preferences. Debounced so a burst of toggles becomes a
  // single PATCH. We pass the next values explicitly (not from state) so the
  // save never races a stale closure.
  const persist = (nextDefaults, nextDirect) => {
    if (!profileId || !token) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setAutoStatus('saving')
    saveTimer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/profiles?id=${profileId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ default_platforms: nextDefaults, tiktok_force_direct_post: nextDirect }),
        })
        const b = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(b.error || 'Failed to save')
        setAutoStatus('saved')
        refreshProfiles()
        setTimeout(() => setAutoStatus((s) => (s === 'saved' ? 'idle' : s)), 1600)
      } catch (e) {
        setAutoStatus('error')
        toast({ message: e.message, kind: 'error' })
      }
    }, 500)
  }

  // Toggle whether a connected platform is in the posting set. An empty stored
  // set means "all connected" (the scheduler's own fallback), so the first
  // toggle materializes the full connected list before flipping the one
  // clicked. We never let the set drop to empty via the UI, otherwise it would
  // silently flip back to that "all connected" meaning.
  const toggleDefault = (id) => {
    const base = (!defaults || defaults.length === 0) ? [...connectedIds] : defaults
    const isOn = base.includes(id)
    let next
    if (isOn) {
      next = base.filter((x) => x !== id)
      if (next.length === 0) {
        toast({ message: 'Keep at least one platform on so posts have somewhere to go.', kind: 'error' })
        return
      }
    } else {
      next = [...base, id]
    }
    setDefaults(next)
    persist(next, directPost)
  }
  const toggleDirect = () => {
    const next = !directPost
    setDirectPost(next)
    persist(defaults, next)
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
            Pick which connected platforms this brand posts to. New posts publish to every platform that is on. Saves automatically.
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
      {/* One row of platforms. Connected platforms are toggles: green + check
          means new posts publish there; a connected-but-off platform is muted
          with a green connection dot. Not-connected platforms are dashed and
          click through to the connect flow. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {SOCIAL_PLATFORMS.map((p) => {
          const connected = connectedIds.includes(p.id)
          // A platform posts by default when it is connected AND either the
          // stored set is empty (means "all connected") or explicitly lists it.
          const on = connected && ((!defaults || defaults.length === 0) || defaults.includes(p.id))
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
          const title = !connected
            ? 'Not connected. Click to connect this platform.'
            : on
              ? `Posts here by default${handle ? ` (@${handle})` : ''}. Click to skip.`
              : `Connected${handle ? ` as @${handle}` : ''} but skipped. Click to post here.`
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => (connected ? toggleDefault(p.id) : onConnect())}
              title={title}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 10px', borderRadius: 999, cursor: 'pointer',
                background: on ? 'rgba(46,204,113,0.14)' : 'var(--surface-2)',
                border: on
                  ? '1px solid rgba(46,204,113,0.45)'
                  : `1px ${connected ? 'solid' : 'dashed'} var(--border)`,
                color: on ? '#2ecc71' : connected ? 'var(--text)' : 'var(--muted)',
                fontSize: 11.5, fontFamily: 'var(--font-display)', fontWeight: 700,
                letterSpacing: '0.02em',
              }}
            >
              {on
                ? <Check size={12} />
                : <span style={{ width: 6, height: 6, borderRadius: 999, background: connected ? '#2ecc71' : 'var(--muted)' }} />}
              {p.label}
              {connected && handle && <span style={{ color: 'var(--muted)', fontWeight: 500, display: 'inline-block', maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>· @{handle}</span>}
            </button>
          )
        })}
      </div>

      {connectedIds.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            {(!defaults || defaults.length === 0)
              ? 'New posts and board drafts publish to all connected platforms.'
              : `New posts publish to ${defaults.length} of ${connectedIds.length} connected platforms.`}
          </span>
          {autoStatus === 'saving' && <span style={{ fontSize: 11, color: 'var(--muted)' }}>Saving…</span>}
          {autoStatus === 'saved' && <span style={{ fontSize: 11, color: '#2ecc71', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Check size={11} /> Saved</span>}
          {autoStatus === 'error' && <span style={{ fontSize: 11, color: 'var(--red)' }}>Save failed</span>}
        </div>
      )}

      {connectedIds.includes('tiktok') && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <input type="checkbox" checked={directPost} onChange={toggleDirect} />
          <span>Post to TikTok straight to the public feed (instead of leaving a draft in the TikTok app)</span>
        </label>
      )}
    </div>
  )
}
