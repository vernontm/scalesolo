import { Zap } from 'lucide-react'
import ThemeToggle from '../components/ThemeToggle.jsx'
import PricingPlans, { PRICING_TIERS, FOUNDING_TIER } from '../components/PricingPlans.jsx'

// Page wrapper for /pricing. The actual founding-banner + toggle + tier
// grid lives in <PricingPlans />, which is reused on the public landing
// page so the two surfaces never drift.

const page = {
  minHeight: '100vh',
  padding: '40px 24px 80px',
  position: 'relative',
}
const cornerStyle = { position: 'fixed', top: 18, right: 18, zIndex: 5 }
const brandRow = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  justifyContent: 'center',
  marginBottom: 18,
}
const brandIcon = {
  width: 38,
  height: 38,
  borderRadius: 11,
  display: 'grid',
  placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff',
  boxShadow: '0 6px 18px rgba(239,68,68,0.32)',
}
const heroTitle = {
  fontFamily: 'var(--font-display)',
  fontSize: 38,
  fontWeight: 800,
  textAlign: 'center',
  letterSpacing: '-0.02em',
  marginTop: 16,
  marginBottom: 8,
}
const heroSub = {
  textAlign: 'center',
  color: 'var(--muted)',
  fontSize: 15,
  maxWidth: 560,
  margin: '0 auto 26px',
  lineHeight: 1.6,
}

export default function Pricing() {
  return (
    <div style={page}>
      <div style={cornerStyle}><ThemeToggle /></div>

      <div className="fade-up">
        <div style={brandRow}>
          <div style={brandIcon}><Zap size={20} strokeWidth={2.5} /></div>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18 }}>ScaleSolo</div>
        </div>
        <h1 style={heroTitle}>
          The first content workflow that <span className="brand-text">writes in your voice</span>, on autopilot.
        </h1>
        <p style={heroSub}>
          Train ScaleSolo on your brand once. It generates, edits, and schedules in your voice across TikTok, Instagram, YouTube, X, and LinkedIn — every day, while you sleep. Pick a plan. 3-day free trial, cancel anytime.
        </p>

        <PricingPlans />
      </div>
    </div>
  )
}

// Re-export for backwards compatibility — other modules already import
// PRICING_TIERS / FOUNDING_TIER from this path.
export { PRICING_TIERS, FOUNDING_TIER }
