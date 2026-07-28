// Campaigns — per-client marketing campaign home. Lists the active
// brand's campaigns with a status funnel, launches the Create Campaign
// wizard, and links each campaign's generated posts into the existing
// approval swipe queue. Posts themselves are reviewed/approved/scheduled
// through the normal /schedule flow; this page is the campaign-level view.

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Megaphone, Plus, Loader2, CheckCircle2, Clock, Send, Trash2 } from 'lucide-react'
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
            <CampaignCard key={c.id} campaign={c} onOpenQueue={() => navigate('/schedule/queue')} onDelete={() => removeCampaign(c.id)} />
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

function CampaignCard({ campaign, onOpenQueue, onDelete }) {
  const c = campaign.counts || {}
  const created = useMemo(() => {
    try { return new Date(campaign.created_at).toLocaleDateString() } catch { return '' }
  }, [campaign.created_at])
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
        <Stat icon={<CheckCircle2 size={14} />} label="Posted" value={c.posted || 0} />
        <div style={{ marginLeft: 'auto', alignSelf: 'center' }}>
          {(c.pending || 0) > 0 && (
            <button className="btn-ghost" onClick={onOpenQueue} style={{ fontSize: 13 }}>
              Review {c.pending} in queue →
            </button>
          )}
        </div>
      </div>
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
