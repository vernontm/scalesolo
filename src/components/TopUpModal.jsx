import { useEffect, useState } from 'react'
import { X, Sparkles, Video, Mic, ExternalLink } from 'lucide-react'
import { useCredits, POOL_META } from '../context/CreditsContext.jsx'
import { supabase } from '../lib/supabase.js'

const overlay = {
  position: 'fixed', inset: 0, zIndex: 100,
  background: 'rgba(0,0,0,0.55)',
  display: 'grid', placeItems: 'center',
  padding: 24,
  backdropFilter: 'blur(4px)',
  animation: 'fadeIn 0.2s ease forwards',
}
const card = {
  width: '100%',
  maxWidth: 520,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 18,
  padding: 28,
  boxShadow: 'var(--shadow-pop)',
  position: 'relative',
  maxHeight: '85vh',
  overflowY: 'auto',
}
const close = {
  position: 'absolute', top: 14, right: 14,
  background: 'transparent', border: 'none',
  color: 'var(--muted)', cursor: 'pointer',
  padding: 6, borderRadius: 6,
}
const title = {
  fontFamily: 'var(--font-display)',
  fontSize: 20,
  fontWeight: 700,
  marginBottom: 6,
  letterSpacing: '-0.01em',
}
const subtitle = { color: 'var(--muted)', fontSize: 13, marginBottom: 20, lineHeight: 1.5 }
const packRow = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '14px 16px',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  marginBottom: 10,
  transition: 'border-color 0.15s ease, transform 0.15s ease',
}
const packLabel = { fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14 }
const packMeta  = { fontSize: 12, color: 'var(--muted)', marginTop: 3 }
const packPrice = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 16,
}
const buyBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 14px',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
  fontFamily: 'var(--font-display)',
  fontWeight: 600,
  fontSize: 12.5,
  boxShadow: '0 4px 12px rgba(239,68,68,0.25)',
  transition: 'transform 0.15s ease, box-shadow 0.15s ease',
}
const noteEmpty = {
  padding: '14px 16px',
  background: 'var(--surface-2)',
  border: '1px dashed var(--border)',
  borderRadius: 12,
  color: 'var(--muted)',
  fontSize: 13,
  textAlign: 'center',
}

const ICONS = { ai_tokens: Sparkles, video_units: Video, voice_minutes: Mic }

export default function TopUpModal({ pool, onClose }) {
  const { topupCatalog } = useCredits()
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  // Close on ESC
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const packs = Object.entries(topupCatalog)
    .filter(([, v]) => !pool || v.pool === pool)
    .sort((a, b) => a[1].usd - b[1].usd)

  const Icon = ICONS[pool] || Sparkles
  const meta = POOL_META[pool]

  const buy = async (packKey) => {
    setError(null)
    setBusy(packKey)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const r = await fetch('/api/credits/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ pack: packKey }),
      })
      const body = await r.json()
      if (!r.ok || !body.url) throw new Error(body.error || 'Top-up could not start.')
      window.location.href = body.url
    } catch (e) {
      setError(e.message)
      setBusy(null)
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()} className="fade-up">
        <button style={close} onClick={onClose} aria-label="Close"><X size={18} /></button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center',
            background: 'linear-gradient(135deg, var(--red), var(--red-dark))', color: '#fff',
          }}><Icon size={18} strokeWidth={2.2} /></div>
          <div style={title}>Top up {meta?.label || 'credits'}</div>
        </div>
        <div style={subtitle}>One-off purchase. Credits land in your pool the moment Stripe confirms the payment.</div>

        {packs.length === 0 ? (
          <div style={noteEmpty}>No packs available for this pool yet.</div>
        ) : packs.every(([, p]) => !p.available) ? (
          <div style={noteEmpty}>Top-up packs aren't priced yet — check back soon.</div>
        ) : (
          packs.map(([key, p]) => (
            <div key={key} style={packRow}>
              <div>
                <div style={packLabel}>{p.label}</div>
                <div style={packMeta}>One-off purchase · never expires</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <span style={packPrice}>${p.usd}</span>
                <button
                  style={{ ...buyBtn, opacity: !p.available || busy ? 0.6 : 1, cursor: !p.available || busy ? 'not-allowed' : 'pointer' }}
                  onClick={() => p.available && buy(key)}
                  disabled={!p.available || !!busy}
                >
                  {busy === key ? <span className="spinner" /> : <ExternalLink size={13} />}
                  {p.available ? 'Buy' : 'Soon'}
                </button>
              </div>
            </div>
          ))
        )}

        {error && (
          <div style={{ marginTop: 14, padding: '10px 14px', background: 'var(--red-soft)', color: 'var(--red)', borderRadius: 10, fontSize: 13 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
