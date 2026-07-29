// Campaigns — per-client marketing campaign home. Lists the active
// brand's campaigns with a status funnel, launches the Create Campaign
// wizard, and links each campaign's generated posts into the existing
// approval swipe queue. Posts themselves are reviewed/approved/scheduled
// through the normal /schedule flow; this page is the campaign-level view.

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Megaphone, Plus, Loader2, CheckCircle2, Clock, Send, Trash2, Image as ImageIcon, Video, Sparkles, ChevronDown, ChevronRight, AlertCircle, RefreshCw } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import CreateCampaignModal from '../components/CreateCampaignModal.jsx'
import { toast, confirmDialog } from '../components/Toast.jsx'

const STATUS_LABEL = {
  draft: 'Draft', planning: 'Generating…', ready: 'Ready to review',
  scheduled: 'Scheduled', complete: 'Complete',
}
const STATUS_COLOR = {
  draft: 'var(--muted)', planning: '#f59e0b', ready: '#2ecc71',
  scheduled: '#60a5fa', complete: 'var(--muted)',
}

export default function Campaigns() {
  const { session } = useAuth()
  const { selectedProfileId, selectedProfile } = useProfile()
  const token = session?.access_token
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const [campaigns, setCampaigns] = useState([])
  const [loading, setLoading] = useState(false)
  const [showWizard, setShowWizard] = useState(false)

  const refresh = async () => {
    if (!selectedProfileId || !token) return
    setLoading(true)
    try {
      const r = await fetch(`/api/campaigns?profile_id=${selectedProfileId}`, { headers: { Authorization: `Bearer ${token}` } })
      const b = await r.json()
      if (r.ok) setCampaigns(b.campaigns || [])
    } catch { /* keep prior */ }
    finally { setLoading(false) }
  }
  useEffect(() => { refresh() /* eslint-disable-next-line */ }, [selectedProfileId, token])

  // Deep-link: /campaigns?new=1 (from the Profiles card button) opens the wizard.
  useEffect(() => {
    if (params.get('new') === '1' && selectedProfileId) {
      setShowWizard(true)
      params.delete('new'); setParams(params, { replace: true })
    }
    // eslint-disable-next-line
  }, [params, selectedProfileId])

  const removeCampaign = async (id) => {
    const ok = await confirmDialog({ title: 'Delete this campaign?', message: 'The generated posts stay in your schedule; only the campaign grouping is removed.', confirmText: 'Delete' })
    if (!ok) return
    setCampaigns((c) => c.filter((x) => x.id !== id))
    try {
      await fetch(`/api/campaigns?id=${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    } catch { /* ignore */ }
  }

  if (!selectedProfileId) {
    return <div style={{ padding: 40, color: 'var(--muted)' }}>Pick a brand profile to see its campaigns.</div>
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.5, display: 'flex', alignItems: 'center', gap: 10 }}>
            <Megaphone size={22} /> Campaigns
          </h1>
          <div style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>
            {selectedProfile?.business_name ? `for ${selectedProfile.business_name}` : 'Multi-day content campaigns from your brand, specials, and real assets.'}
          </div>
        </div>
        <button className="btn-primary" onClick={() => setShowWizard(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Plus size={16} /> New campaign
        </button>
      </div>

      {loading && !campaigns.length ? (
        <div style={{ padding: 40, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Loader2 size={16} className="spin" /> Loading campaigns…
        </div>
      ) : !campaigns.length ? (
        <div style={{ marginTop: 24, padding: 40, background: 'var(--surface-2)', border: '1px dashed var(--border)', borderRadius: 14, textAlign: 'center' }}>
          <Megaphone size={28} style={{ color: 'var(--muted)', marginBottom: 12 }} />
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>No campaigns yet</div>
          <div style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 18, maxWidth: 460, marginInline: 'auto', lineHeight: 1.5 }}>
            Spin up a 7 or 30 day campaign. We build the posts from your brand bible, specials, standout selling points, upcoming holidays, and your real photos.
          </div>
          <button className="btn-primary" onClick={() => setShowWizard(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Plus size={16} /> Create your first campaign
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 20, display: 'grid', gap: 12 }}>
          {campaigns.map((c) => (
            <CampaignCard key={c.id} campaign={c} token={token} onOpenQueue={() => navigate('/schedule/queue')} onDelete={() => removeCampaign(c.id)} onChanged={refresh} />
          ))}
        </div>
      )}

      {showWizard && (
        <CreateCampaignModal
          profileId={selectedProfileId}
          token={token}
          onClose={() => setShowWizard(false)}
          onComplete={({ inserted }) => { toast({ kind: 'success', message: `Campaign generated — ${inserted} posts are in your approval queue.` }); refresh() }}
        />
      )}
    </div>
  )
}

function CampaignCard({ campaign, token, onOpenQueue, onDelete, onChanged }) {
  const c = campaign.counts || {}
  const created = useMemo(() => {
    try { return new Date(campaign.created_at).toLocaleDateString() } catch { return '' }
  }, [campaign.created_at])

  const [expanded, setExpanded] = useState(false)
  const [posts, setPosts] = useState(null)     // null = not loaded
  const [assets, setAssets] = useState([])     // profile's real asset library
  const [gen, setGen] = useState(null)         // { running, done, total }
  const [busyIds, setBusyIds] = useState({})   // per-post generating state

  const mediaNeeded = c.media_needed || 0
  const mediaReady = c.media_ready || 0
  const mediaTotal = c.media_total || 0

  const loadPosts = async () => {
    try {
      const r = await fetch(`/api/campaigns?id=${campaign.id}&posts=1`, { headers: { Authorization: `Bearer ${token}` } })
      const b = await r.json()
      if (r.ok) setPosts(b.posts || [])
    } catch { /* keep */ }
  }
  const loadAssets = async () => {
    try {
      const r = await fetch(`/api/profile/brand-assets?profile_id=${campaign.profile_id}`, { headers: { Authorization: `Bearer ${token}` } })
      const b = await r.json()
      if (r.ok) setAssets(b.assets || [])
    } catch { /* keep */ }
  }
  const toggleExpand = () => {
    const next = !expanded
    setExpanded(next)
    if (next && posts === null) { loadPosts(); loadAssets() }
  }

  // Live view: while media is generating (batch running, or any post
  // still rendering — e.g. one kicked off in another tab), poll the post
  // list so finished images/videos pop in without a manual refresh.
  const anyGenerating = Array.isArray(posts) && posts.some((p) => p.media_gen_status === 'generating')
  useEffect(() => {
    if (!expanded) return
    if (!gen && !anyGenerating) return
    const t = setInterval(loadPosts, 8000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, !!gen, anyGenerating])

  // Campaign-wide: loop the batch endpoint until nothing remains. Each
  // call processes one post (resuming in-flight ones), returning how many
  // still need media so we can drive a progress bar. Refreshes the grid
  // after every post so they appear the moment they finish.
  const runAllMedia = async () => {
    const total = mediaNeeded + (c.media_generating || 0)
    setGen({ running: true, done: 0, total: total || 1 })
    setExpanded(true)
    loadPosts(); loadAssets()   // show the grid filling in
    let guard = 0
    try {
      while (guard++ < 800) {
        const r = await fetch('/api/campaigns/generate-media', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ campaign_id: campaign.id }),
        })
        const b = await r.json()
        if (!r.ok) { toast({ kind: 'error', message: b?.error || 'Media generation failed.' }); break }
        if (b.done && !b.processed) break
        const remaining = b.remaining || 0
        setGen({ running: true, done: Math.max(0, total - remaining), total: total || 1 })
        if (b.state === 'ready' || b.state === 'failed') loadPosts()   // live: pop it in
        if (remaining <= 0 && b.state !== 'pending') break
      }
    } finally {
      setGen(null)
      loadPosts()
      onChanged?.()
    }
  }

  // Single post: generate (or retry) media for one row.
  const runOne = async (id) => {
    setBusyIds((m) => ({ ...m, [id]: true }))
    try {
      let guard = 0
      while (guard++ < 60) {
        const r = await fetch('/api/campaigns/generate-media', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ content_id: id }),
        })
        const b = await r.json()
        if (!r.ok) { toast({ kind: 'error', message: b?.error || 'Generation failed.' }); break }
        if (b.state === 'pending') { continue }  // resume polling
        if (b.state === 'failed') { toast({ kind: 'error', message: b.error || 'Generation failed.' }) }
        break
      }
    } finally {
      setBusyIds((m) => { const n = { ...m }; delete n[id]; return n })
      loadPosts(); onChanged?.()
    }
  }

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 16 }}>{campaign.name || 'Untitled campaign'}</span>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, color: STATUS_COLOR[campaign.status] || 'var(--muted)', border: `1px solid ${STATUS_COLOR[campaign.status] || 'var(--border)'}` }}>
              {STATUS_LABEL[campaign.status] || campaign.status}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
            {campaign.duration_days} days · {campaign.posts_per_day}/day · {campaign.start_date || 'no start date'} · created {created}
          </div>
        </div>
        <button onClick={onDelete} title="Delete campaign" style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 8, padding: 8, cursor: 'pointer', color: 'var(--muted)' }}>
          <Trash2 size={14} />
        </button>
      </div>

      <div style={{ display: 'flex', gap: 18, marginTop: 14, flexWrap: 'wrap' }}>
        <Stat icon={<Clock size={14} />} label="Awaiting review" value={c.pending || 0} />
        <Stat icon={<CheckCircle2 size={14} />} label="Approved" value={c.approved || 0} />
        <Stat icon={<Send size={14} />} label="Scheduled" value={c.scheduled || 0} />
        <Stat icon={<ImageIcon size={14} />} label="Media ready" value={`${mediaReady}/${mediaTotal}`} />
        <div style={{ marginLeft: 'auto', alignSelf: 'center' }}>
          {(c.pending || 0) > 0 && (
            <button className="btn-ghost" onClick={onOpenQueue} style={{ fontSize: 13 }}>
              Review {c.pending} in queue →
            </button>
          )}
        </div>
      </div>

      {/* Media generation bar */}
      {mediaTotal > 0 && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button className="btn-primary" onClick={runAllMedia} disabled={!!gen || mediaNeeded === 0}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              {gen ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
              {gen ? 'Generating media…' : mediaNeeded > 0 ? `Generate media (${mediaNeeded})` : 'All media generated'}
            </button>
            <button className="btn-ghost" onClick={toggleExpand} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {expanded ? 'Hide' : 'Show'} posts
            </button>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              Review each post's prompt and reference photo before generating. Nothing publishes automatically, you schedule the good ones after.
            </span>
          </div>
          {gen && (
            <div style={{ marginTop: 10, height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.min(100, Math.round((gen.done / gen.total) * 100))}%`, background: 'linear-gradient(90deg, var(--red), var(--red-dark))', transition: 'width 0.3s' }} />
            </div>
          )}
        </div>
      )}

      {expanded && (
        <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
          {posts === null ? (
            <div style={{ color: 'var(--muted)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}><Loader2 size={14} className="spin" /> Loading posts…</div>
          ) : posts.filter((p) => p.media_type !== 'text').length === 0 ? (
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>No media posts in this campaign.</div>
          ) : (
            posts.filter((p) => p.media_type !== 'text').map((p) => (
              <PostRow key={p.id} post={p} assets={assets} token={token}
                busy={!!busyIds[p.id] || !!gen} onGenerate={() => runOne(p.id)} onSaved={loadPosts} />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function PostRow({ post, assets, token, busy, onGenerate, onSaved }) {
  const hasMedia = Array.isArray(post.media_urls) && post.media_urls.length > 0
  const isVideo = post.media_type === 'video'
  const generating = post.media_gen_status === 'generating' || busy
  const failed = post.media_gen_status === 'failed' && !hasMedia
  const thumb = hasMedia ? post.media_urls[0] : null
  const box = { width: 56, height: 56, borderRadius: 8, overflow: 'hidden', flexShrink: 0, background: 'var(--surface)', display: 'grid', placeItems: 'center', color: 'var(--muted)', position: 'relative' }

  const brief = post.media_brief || {}
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState(brief.prompt || '')
  const [refIds, setRefIds] = useState(Array.isArray(brief.reference_asset_ids) ? brief.reference_asset_ids : [])
  const [saving, setSaving] = useState(false)
  const dirty = prompt !== (brief.prompt || '') ||
    JSON.stringify(refIds) !== JSON.stringify(Array.isArray(brief.reference_asset_ids) ? brief.reference_asset_ids : [])

  // Only real photos are usable as generation references.
  const imageAssets = (assets || []).filter((a) => a.media_type === 'image')
  const byId = Object.fromEntries((assets || []).map((a) => [a.id, a]))

  const toggleRef = (id) => setRefIds((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])

  const save = async () => {
    setSaving(true)
    try {
      const r = await fetch('/api/campaigns/brief', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content_id: post.id, prompt, reference_asset_ids: refIds }),
      })
      const b = await r.json()
      if (!r.ok) { toast({ kind: 'error', message: b?.error || 'Could not save prompt.' }); return false }
      toast({ kind: 'success', message: 'Prompt saved.' })
      onSaved?.()
      return true
    } catch (e) { toast({ kind: 'error', message: e.message }); return false }
    finally { setSaving(false) }
  }
  const saveAndGenerate = async () => {
    if (dirty) { const ok = await save(); if (!ok) return }
    onGenerate()
  }

  return (
    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 8 }}>
        {thumb ? (
          <a href={thumb} target="_blank" rel="noreferrer" style={{ ...box, cursor: 'zoom-in' }} title="Open full size">
            {isVideo
              ? <><video src={thumb} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.7)' }}><Video size={16} /></span></>
              : <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
          </a>
        ) : (
          <div style={box}>{isVideo ? <Video size={18} /> : <ImageIcon size={18} />}</div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{post.title || 'Untitled'}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ textTransform: 'capitalize' }}>{post.media_type}</span>
            {failed && <span style={{ color: 'var(--red)', display: 'inline-flex', alignItems: 'center', gap: 3 }}><AlertCircle size={11} /> failed</span>}
            {hasMedia && <span style={{ color: '#2ecc71', display: 'inline-flex', alignItems: 'center', gap: 3 }}><CheckCircle2 size={11} /> ready{post.media_urls.length > 1 ? ` · ${post.media_urls.length} slides` : ''}</span>}
          </div>
        </div>
        <button onClick={() => setOpen((o) => !o)} className="btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, flexShrink: 0 }}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Prompt
        </button>
        <button onClick={saveAndGenerate} disabled={generating} className={hasMedia ? 'btn-ghost' : 'btn-primary'}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, flexShrink: 0 }}>
          {generating ? <Loader2 size={13} className="spin" /> : hasMedia ? <RefreshCw size={13} /> : <Sparkles size={13} />}
          {generating ? 'Working…' : hasMedia ? 'Regenerate' : failed ? 'Retry' : 'Generate'}
        </button>
      </div>

      {open && (
        <div style={{ padding: '4px 12px 14px', borderTop: '1px solid var(--border)', display: 'grid', gap: 12 }}>
          <div>
            <div style={{ ...fieldLabel, marginTop: 10 }}>Generation prompt {isVideo ? '(motion / video)' : '(image)'}</div>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4}
              placeholder="Describe exactly what this image/video should show…"
              style={{ width: '100%', padding: 10, fontSize: 13, lineHeight: 1.5, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }} />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              The real reference photo below is locked so the product stays exact. This text controls everything else (scene, mood, motion).
            </div>
          </div>

          <div>
            <div style={fieldLabel}>Reference photo{refIds.length !== 1 ? 's' : ''} it builds from {refIds.length === 0 && <span style={{ color: '#f59e0b', textTransform: 'none', fontWeight: 400 }}>· none selected (AI will invent the product — pick one)</span>}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', maxHeight: 180, overflowY: 'auto', padding: 2 }}>
              {imageAssets.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>No photos in this brand's asset library yet.</div>
              ) : imageAssets.map((a) => {
                const sel = refIds.includes(a.id)
                return (
                  <button key={a.id} type="button" onClick={() => toggleRef(a.id)} title={a.label || a.category}
                    style={{ width: 64, height: 64, borderRadius: 8, overflow: 'hidden', padding: 0, cursor: 'pointer', position: 'relative',
                      border: `2px solid ${sel ? 'var(--red)' : 'var(--border)'}`, background: 'var(--surface)' }}>
                    <img src={a.public_url} alt={a.label || ''} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: sel ? 1 : 0.7 }} />
                    {sel && <span style={{ position: 'absolute', top: 2, right: 2, background: 'var(--red)', color: '#fff', borderRadius: 10, width: 16, height: 16, display: 'grid', placeItems: 'center' }}><CheckCircle2 size={11} /></span>}
                  </button>
                )
              })}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={save} disabled={!dirty || saving} className="btn-ghost" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving ? <Loader2 size={13} className="spin" /> : null} Save prompt
            </button>
            <button onClick={saveAndGenerate} disabled={generating} className="btn-primary" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {generating ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
              {dirty ? 'Save + generate' : hasMedia ? 'Regenerate' : 'Generate'}
            </button>
            {dirty && <span style={{ fontSize: 11, color: 'var(--muted)' }}>unsaved changes</span>}
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ icon, label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ color: 'var(--muted)' }}>{icon}</span>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1 }}>{value}</div>
        <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.05 }}>{label}</div>
      </div>
    </div>
  )
}
