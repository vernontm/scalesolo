import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Images, Clapperboard, ArrowRight, PlusSquare, Boxes } from 'lucide-react'
import useIsMobile from '../hooks/useIsMobile.js'

// Create hub — template cards with a 9:16 preview of what the template
// actually produces (drop example media in public/media/create/<key>.gif or
// .mp4), a short "what it does for you" line, and a Create-from-scratch card
// that opens a blank Spaces board. New formats slot in as more cards.
const TEMPLATES = [
  {
    key: 'carousel',
    icon: Images,
    title: 'Carousel',
    desc: 'Turns one topic into a designed multi-slide post: hook cover, tip slides, CTA, caption and hashtags. Optionally puts YOU on every slide from a single photo.',
    helps: 'Great for TikTok photo mode, Instagram and LinkedIn saves.',
    to: '/create/carousel',
    accent: '#a855f7',
  },
  {
    key: 'walkthrough',
    icon: Clapperboard,
    title: 'AI Walkthrough Video',
    desc: 'A talking-head avatar video over an animated screen walkthrough. Pick a photo, a voice and a topic, the rest generates.',
    helps: 'Great for tutorials, product demos and faceless-to-face content.',
    to: '/create/walkthrough',
    accent: '#0ea5e9',
  },
]

// 9:16 preview frame. Tries <key>.mp4 then <key>.gif from /media/create/;
// falls back to a styled icon placeholder until example media is added.
function PreviewFrame({ tpl, isMobile }) {
  const [stage, setStage] = useState(0) // 0 = try mp4, 1 = try gif, 2 = fallback
  const Icon = tpl.icon
  const frame = {
    aspectRatio: '9 / 16', width: '100%', borderRadius: 12, overflow: 'hidden',
    background: `linear-gradient(160deg, ${tpl.accent}30, ${tpl.accent}08)`,
    border: '1px solid var(--border)', display: 'grid', placeItems: 'center',
    position: 'relative',
    // Phone: a full-width 9:16 preview is a whole screen tall, so cap it to a
    // centered portrait card and let the title/copy sit right below it.
    ...(isMobile ? { maxWidth: 190, margin: '0 auto' } : {}),
  }
  if (stage === 0) {
    return (
      <div style={frame}>
        <video
          src={`/media/create/${tpl.key}.mp4`}
          autoPlay loop muted playsInline
          onError={() => setStage(1)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </div>
    )
  }
  if (stage === 1) {
    return (
      <div style={frame}>
        <img
          src={`/media/create/${tpl.key}.gif`}
          alt={`${tpl.title} example`}
          onError={() => setStage(2)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </div>
    )
  }
  return (
    <div style={frame}>
      <div style={{ textAlign: 'center', color: tpl.accent }}>
        <Icon size={40} strokeWidth={1.6} />
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>Example coming soon</div>
      </div>
    </div>
  )
}

export default function Create() {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const cardBase = {
    textAlign: 'left', cursor: 'pointer',
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 16, padding: 16,
    display: 'flex', flexDirection: 'column',
    transition: 'border-color 0.15s ease, transform 0.15s ease',
  }
  return (
    <div style={{ maxWidth: 980, margin: '0 auto' }}>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 800, letterSpacing: '-0.01em' }}>
        What do you want to create?
      </h2>
      <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4, marginBottom: 22 }}>
        Start from a template, or build your own flow from scratch.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 16 }}>
        {TEMPLATES.map((t) => (
          <button
            key={t.key}
            onClick={() => navigate(t.to)}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = t.accent; e.currentTarget.style.transform = 'translateY(-2px)' }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'none' }}
            style={cardBase}
          >
            <PreviewFrame tpl={t} isMobile={isMobile} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
              <div style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: `${t.accent}1f`, color: t.accent, flexShrink: 0 }}>
                <t.icon size={15} />
              </div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16, color: 'var(--text)' }}>{t.title}</div>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.5, marginTop: 8 }}>{t.desc}</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.45, marginTop: 6 }}>{t.helps}</div>
            <div style={{ marginTop: 'auto', paddingTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6, color: t.accent, fontWeight: 700, fontSize: 13 }}>
              Start <ArrowRight size={14} />
            </div>
          </button>
        ))}

        {/* Create from scratch — a fresh, blank Spaces board. */}
        <button
          onClick={() => navigate('/spaces?new=1')}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#ef4444'; e.currentTarget.style.transform = 'translateY(-2px)' }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'none' }}
          style={cardBase}
        >
          <div style={{
            aspectRatio: '9 / 16', width: '100%', borderRadius: 12,
            border: '1.5px dashed var(--border)', background: 'var(--surface-2)',
            display: 'grid', placeItems: 'center',
            ...(isMobile ? { maxWidth: 190, margin: '0 auto' } : {}),
          }}>
            <div style={{ textAlign: 'center', color: '#ef4444' }}>
              <PlusSquare size={40} strokeWidth={1.4} />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>Blank canvas</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
            <div style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'rgba(239,68,68,0.12)', color: '#ef4444', flexShrink: 0 }}>
              <Boxes size={15} />
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16, color: 'var(--text)' }}>Create from scratch</div>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.5, marginTop: 8 }}>
            Open a blank Spaces board and wire your own flow: drop in media, generate scripts, images and video, and schedule, all on one canvas.
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.45, marginTop: 6 }}>
            Full control when a template does not fit.
          </div>
          <div style={{ marginTop: 'auto', paddingTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6, color: '#ef4444', fontWeight: 700, fontSize: 13 }}>
            Open a blank board <ArrowRight size={14} />
          </div>
        </button>
      </div>
    </div>
  )
}
