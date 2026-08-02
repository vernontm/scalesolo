import { useNavigate } from 'react-router-dom'
import { Images, Clapperboard, ArrowRight } from 'lucide-react'

// Create hub — pick a format, land in its guided build. New formats slot in
// as more cards. AI Walkthrough routes to Studio (the avatar-video pipeline);
// Carousel routes to its builder.
const CARDS = [
  {
    key: 'carousel',
    icon: Images,
    title: 'Carousel',
    desc: 'A multi-slide photo post — hook, tips, and a CTA. Perfect for TikTok photo mode, Instagram, and LinkedIn.',
    to: '/create/carousel',
    accent: '#a855f7',
  },
  {
    key: 'walkthrough',
    icon: Clapperboard,
    title: 'AI Walkthrough Video',
    desc: 'A talking-head avatar video over an animated walkthrough. Pick a photo, a voice, and a topic — the rest generates.',
    to: '/studio',
    accent: '#0ea5e9',
  },
]

export default function Create() {
  const navigate = useNavigate()
  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 800, letterSpacing: '-0.01em' }}>
        What do you want to create?
      </h2>
      <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4, marginBottom: 22 }}>
        Pick a format to start a guided build.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        {CARDS.map((c) => (
          <button
            key={c.key}
            onClick={() => navigate(c.to)}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = c.accent; e.currentTarget.style.transform = 'translateY(-2px)' }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'none' }}
            style={{
              textAlign: 'left', cursor: 'pointer',
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 16, padding: 22,
              display: 'flex', flexDirection: 'column',
              transition: 'border-color 0.15s ease, transform 0.15s ease',
            }}
          >
            <div style={{
              width: 52, height: 52, borderRadius: 14, marginBottom: 14,
              display: 'grid', placeItems: 'center',
              background: `${c.accent}1f`, color: c.accent,
            }}>
              <c.icon size={26} />
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 19, color: 'var(--text)' }}>{c.title}</div>
            <div style={{ fontSize: 13.5, color: 'var(--text-soft)', lineHeight: 1.55, marginTop: 6 }}>{c.desc}</div>
            <div style={{ marginTop: 16, display: 'inline-flex', alignItems: 'center', gap: 6, color: c.accent, fontWeight: 700, fontSize: 13 }}>
              Start <ArrowRight size={15} />
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
