import { useState } from 'react'
import { Sparkles, Video, Mic, Plus } from 'lucide-react'
import { useCredits, fmtCount, POOL_META } from '../context/CreditsContext.jsx'
import TopUpModal from './TopUpModal.jsx'

const grid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 14,
}
const card = (color) => ({
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  padding: 18,
  position: 'relative',
  overflow: 'hidden',
})
const accentBar = (color) => ({
  position: 'absolute',
  top: 0, left: 0, right: 0,
  height: 3,
  background: `linear-gradient(90deg, ${color}, transparent)`,
})
const head = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  color: 'var(--muted)',
  fontFamily: 'var(--font-display)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  marginBottom: 10,
}
const big = {
  fontFamily: 'var(--font-display)',
  fontSize: 26,
  fontWeight: 800,
  letterSpacing: '-0.01em',
  color: 'var(--text)',
}
const sub = {
  fontSize: 12,
  color: 'var(--muted)',
  marginTop: 4,
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
}
const meterWrap = {
  marginTop: 10,
  height: 4,
  background: 'var(--surface-2)',
  borderRadius: 999,
  overflow: 'hidden',
}
const meterFill = (pct, color) => ({
  width: `${Math.max(0, Math.min(100, pct))}%`,
  height: '100%',
  background: color,
  transition: 'width 0.3s ease',
})
const topUpBtn = {
  marginTop: 12,
  width: '100%',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '8px 12px',
  borderRadius: 8,
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text-soft)',
  cursor: 'pointer',
  fontFamily: 'var(--font-display)',
  fontSize: 12.5,
  fontWeight: 600,
  transition: 'border-color 0.15s ease, color 0.15s ease',
}

const POOL_DEFS = [
  { key: 'ai_tokens',     label: 'AI tokens',     icon: Sparkles, color: '#ef4444', empty: 'No AI tokens yet — pick a plan.' },
  { key: 'video_units',   label: 'Video units',   icon: Video,    color: '#f59e0b', empty: 'No video units yet.' },
  { key: 'voice_minutes', label: 'Voice minutes', icon: Mic,      color: '#a78bfa', empty: 'Voice agents land in v2.' },
]

export default function CreditsPanel({ compact = false }) {
  const { pools, topupCatalog } = useCredits()
  const [modal, setModal] = useState(null) // { pool: 'ai_tokens' } or null

  const visible = compact ? POOL_DEFS.slice(0, 2) : POOL_DEFS

  return (
    <>
      <div style={grid}>
        {visible.map((d) => {
          const p = pools[d.key] || { balance: 0, monthly_grant: 0 }
          const grant = Number(p.monthly_grant) || 0
          const balance = Number(p.balance) || 0
          const pct = grant > 0 ? (balance / grant) * 100 : 0
          const Icon = d.icon
          return (
            <div key={d.key} style={card(d.color)}>
              <div style={accentBar(d.color)} />
              <div style={head}>
                <Icon size={13} strokeWidth={2.4} />
                {d.label}
              </div>
              <div style={big}>{fmtCount(balance)}</div>
              <div style={sub}>
                <span>{grant > 0 ? `of ${fmtCount(grant)} / month` : (balance ? ' ' : d.empty)}</span>
                {grant > 0 && <span style={{ fontWeight: 600 }}>{Math.round(pct)}%</span>}
              </div>
              {grant > 0 && (
                <div style={meterWrap}><div style={meterFill(pct, d.color)} /></div>
              )}
              {Object.values(topupCatalog).some((p) => p.pool === d.key && p.available) && (
                <button
                  style={topUpBtn}
                  onClick={() => {
                    // Snap the page to the top before opening so the
                    // fixed-position modal is the first thing in view.
                    // Use 'auto' (instant) instead of smooth — smooth
                    // scroll interrupted by the modal open animation
                    // leaves Safari halfway, which is worse than just
                    // jumping. TopUpModal additionally locks body
                    // scroll on mount as the real safety net.
                    try { window.scrollTo({ top: 0, behavior: 'auto' }) } catch {}
                    setModal({ pool: d.key })
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)'; e.currentTarget.style.color = 'var(--text)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-soft)' }}
                >
                  <Plus size={14} /> Top up
                </button>
              )}
            </div>
          )
        })}
      </div>

      {modal && <TopUpModal pool={modal.pool} onClose={() => setModal(null)} />}
    </>
  )
}
