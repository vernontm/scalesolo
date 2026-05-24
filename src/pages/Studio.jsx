// Studio v1 — long-form video generation surface. Currently a
// placeholder confirming the gate, env wiring, and Vercel preview
// deployment all work end-to-end before we start building the video
// map UI on top.
//
// Visible only to users whose ids appear in the STUDIO_BETA_USER_IDS
// env var on Vercel. Hidden from the sidebar / nav until launch.

import { Film, Sparkles } from 'lucide-react'

export default function Studio() {
  return (
    <div className="fade-up" style={{ maxWidth: 880, margin: '0 auto', padding: '40px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12,
          background: 'rgba(239,68,68,0.16)', color: 'var(--red)',
          display: 'grid', placeItems: 'center',
        }}>
          <Film size={20} />
        </div>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, margin: 0 }}>
            Studio
          </h1>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
            Long-form video generation. Private beta.
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 24, padding: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--red)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 12 }}>
          <Sparkles size={13} />
          Coming soon
        </div>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, margin: '0 0 10px' }}>
          The Studio scaffold is live.
        </h2>
        <p style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--text-soft)', margin: 0 }}>
          You are seeing this because your user id is on the STUDIO_BETA_USER_IDS
          allowlist. The video map, HyperFrames composer, and AI chat editor land
          here over the next iterations. Nothing here ships to production users
          until the gate is removed.
        </p>
      </div>
    </div>
  )
}
