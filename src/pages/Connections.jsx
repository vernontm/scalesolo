// Connections — the brand's social accounts + posting defaults, moved off the
// Schedule screen (monthly setup does not belong on a daily working surface).
// Reachable from the link icon in the mobile Schedule nav bar
// (/schedule/connections). Reuses the shared SocialAccountsPanel so the connect
// + posting-defaults + TikTok logic is exactly what the Schedule used before.
import { ChevronLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import SocialAccountsPanel from '../components/SocialAccountsPanel.jsx'

export default function Connections() {
  const navigate = useNavigate()
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  const token = session?.access_token

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button onClick={() => navigate('/schedule')} aria-label="Back to Schedule"
          style={{ display: 'grid', placeItems: 'center', width: 40, height: 40, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', flexShrink: 0 }}>
          <ChevronLeft size={18} />
        </button>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 20, margin: 0 }}>Connections</h1>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
            The accounts ScaleSolo publishes to, and where new posts go by default.
          </div>
        </div>
      </div>
      <SocialAccountsPanel profileId={selectedProfileId} token={token} />
    </div>
  )
}
