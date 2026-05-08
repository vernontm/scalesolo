import {
  Mic, GraduationCap, Rocket, Sparkles, Users, Eye, ArrowRight,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────
//  UseCaseGrid
//  ───────────
//  Six persona cards. Clicking one calls onSelectPersona(persona),
//  which the parent uses to (a) scroll back up to the workflow canvas
//  and (b) morph the canvas to highlight only the steps relevant to
//  that persona. The active card gets an accented border + a "Showing
//  on canvas" CTA so it's obvious which one is currently driving the
//  morph.
//
//  `steps` is an array of step indices into the WorkflowDemo STEPS
//  array — the persona's relevant route through the 9-node pipeline.
// ─────────────────────────────────────────────────────────────────────

export const PERSONAS = [
  {
    key: 'podcasters',
    icon: Mic,
    label: 'For Podcasters',
    body: 'Drop a podcast clip → 9 shorts posted in your voice. 0 editing required.',
    steps: [2, 4, 5, 7, 8],   // Script · Render · Combine · Captions · Schedule
  },
  {
    key: 'course-creators',
    icon: GraduationCap,
    label: 'For Course Creators',
    body: 'Sell while you sleep — daily evergreen content in your voice.',
    steps: [1, 2, 7, 8],      // Brand · Script · Captions · Schedule
  },
  {
    key: 'solo-founders',
    icon: Rocket,
    label: 'For Solo Founders',
    body: 'One workflow per launch. Repurpose your hot take into a week of posts.',
    steps: [2, 4, 6, 8],      // Script · Render · Title+caption · Schedule
  },
  {
    key: 'coaches',
    icon: Sparkles,
    label: 'For Coaches',
    body: 'Daily motivational posts that pull from your bible. Set it. Forget it.',
    steps: [1, 2, 7],         // Brand · Script · Captions
  },
  {
    key: 'agencies',
    icon: Users,
    label: 'For Agencies',
    body: '1 brand profile per client. 80 posts shipped per week, all on-brand.',
    steps: [1, 3, 4, 8],      // Brand · Avatar selector · Render · Schedule
  },
  {
    key: 'faceless',
    icon: Eye,
    label: 'For Faceless Brands',
    body: "No camera, no face. Cycle stock looks with your script. Audience never clocks.",
    steps: [3, 4, 5, 8],      // Avatar selector · Render · Combine · Schedule
  },
]

export default function UseCaseGrid({ activePersona, onSelectPersona }) {
  return (
    <div style={grid}>
      {PERSONAS.map((p) => {
        const isActive = activePersona?.key === p.key
        return (
          <button
            key={p.key}
            onClick={() => onSelectPersona(p)}
            style={{ ...card, ...(isActive ? cardActive : null) }}
            className="lift"
            aria-pressed={isActive}
          >
            <div style={{ ...iconBox, ...(isActive ? iconBoxActive : null) }}>
              <p.icon size={22} strokeWidth={2.2} />
            </div>
            <div style={cardHeadline}>{p.label}</div>
            <p style={cardBody}>{p.body}</p>
            <div style={{ ...cardCta, color: isActive ? 'var(--red)' : 'var(--text-soft)' }}>
              {isActive ? 'Showing on canvas above' : 'See workflow'}
              <ArrowRight size={13} />
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────
const grid = {
  display: 'grid', gap: 16,
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  maxWidth: 1100, margin: '0 auto',
}
const card = {
  position: 'relative',
  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12,
  padding: '24px 24px 22px',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  textAlign: 'left', cursor: 'pointer',
  fontFamily: 'inherit', color: 'inherit',
  boxShadow: 'var(--shadow-card)',
  // .lift handles transform + border colour transition on hover.
}
const cardActive = {
  borderColor: 'rgba(239,68,68,0.55)',
  background: 'linear-gradient(180deg, rgba(239,68,68,0.06), var(--surface) 70%)',
  boxShadow: '0 0 0 1px rgba(239,68,68,0.30), 0 14px 36px rgba(239,68,68,0.18)',
}
const iconBox = {
  display: 'grid', placeItems: 'center',
  width: 44, height: 44, borderRadius: 12,
  background: 'var(--red-soft)',
  color: 'var(--red)',
  border: '1px solid rgba(239,68,68,0.30)',
}
const iconBoxActive = {
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff',
  border: '1px solid rgba(239,68,68,0.55)',
  boxShadow: '0 6px 18px rgba(239,68,68,0.40)',
}
const cardHeadline = {
  fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 17,
  color: 'var(--text)', letterSpacing: '-0.01em',
}
const cardBody = {
  fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-soft)', margin: 0,
}
const cardCta = {
  marginTop: 'auto', paddingTop: 6,
  display: 'inline-flex', alignItems: 'center', gap: 6,
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12,
  letterSpacing: '0.02em',
}
