import { Sparkles } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useCredits, fmtCount } from '../context/CreditsContext.jsx'

const wrap = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  height: 38,
  padding: '0 12px',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  cursor: 'pointer',
  fontSize: 12.5,
  fontFamily: 'var(--font-display)',
  color: 'var(--text)',
  transition: 'border-color 0.15s ease',
}
const iconWrap = {
  width: 22, height: 22, borderRadius: 6,
  display: 'grid', placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff',
}
const value = { fontWeight: 700 }
const label = { color: 'var(--muted)', fontWeight: 600, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }

export default function CreditsBadge() {
  const { pools } = useCredits()
  const navigate = useNavigate()
  const tokens = pools.ai_tokens?.balance ?? 0

  const low = tokens > 0 && tokens < (pools.ai_tokens?.monthly_grant || 0) * 0.1

  return (
    <button
      style={{ ...wrap, borderColor: low ? 'rgba(239,68,68,0.35)' : 'var(--border)' }}
      onClick={() => navigate('/billing')}
      title="View credit balances"
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)' }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = low ? 'rgba(239,68,68,0.35)' : 'var(--border)' }}
    >
      <div style={iconWrap}><Sparkles size={13} strokeWidth={2.4} /></div>
      <span style={label}>Tokens</span>
      <span style={value}>{fmtCount(tokens)}</span>
    </button>
  )
}
