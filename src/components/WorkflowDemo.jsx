import { useEffect, useState } from 'react'
import {
  Zap, Wand2, UserCircle2, Image as ImageIcon, Video, Boxes,
  Captions as CaptionsIcon, Type, Calendar,
  ChevronLeft, ChevronRight, Play, Pause, X,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────
//  WorkflowDemo
//  ──────────
//  An interactive walkthrough of the AI Podcaster workflow, laid out
//  in a 3×3 snake to mirror the real Spaces canvas:
//
//    1 → 2 → 3
//            ↓
//    6 ← 5 ← 4
//    ↓
//    7 → 8 → 9
//
//  Click any node to see what it does. Auto-tour cycles through every
//  4.5s. The connector segment leading INTO the active node is drawn
//  in a brighter stroke so visitors see exactly where they are.
// ─────────────────────────────────────────────────────────────────────

const STEPS = [
  {
    icon: Zap,
    title: 'Auto-run',
    pill: 'TRIGGER', tone: 'gold',
    preview: 'Every day · 8:00 AM',
    body: 'Auto-run kicks off the entire workflow on the cadence you set — every hour, every day, every week. Wire it once and you never click "Run" again.',
    grid: { col: 1, row: 1 },
  },
  {
    icon: UserCircle2,
    title: 'Brand profile',
    pill: 'LOCKED', tone: 'neutral',
    preview: '@kara · 6 hashtags · voice',
    body: 'Your brand bible — voice, audience, hashtag set, fonts, color palette. Every downstream node reads from it so your tone stays identical across 1,000 posts.',
    grid: { col: 2, row: 1 },
  },
  {
    icon: Wand2,
    title: 'Script generator',
    pill: 'DONE', tone: 'green',
    preview: '"Pick a fresh angle for…"',
    body: 'AI writes a full short-form script in your brand voice from a single topic. It dedupes against your last 12+ takes so you never accidentally repeat yourself.',
    grid: { col: 3, row: 1 },
  },
  {
    icon: ImageIcon,
    title: 'Avatar selector',
    pill: 'DONE', tone: 'green',
    preview: 'Kara · 3 looks · cycle on',
    body: "Pick the AI avatar reading the script. Cycle Looks rotates outfits across runs — Monday white, Wednesday red, Friday black — so every video looks freshly shot, even though it's all one workflow.",
    grid: { col: 3, row: 2 },
  },
  {
    icon: Video,
    title: 'Avatar render',
    pill: 'DONE', tone: 'green',
    preview: '6 clips · 32s · 1080p',
    body: 'Renders the talking-head video. Your avatar narrates your script with lip-sync and cadence matched to your voice. If cycle looks is on, you get one clip per outfit.',
    grid: { col: 2, row: 2 },
  },
  {
    icon: Boxes,
    title: 'Combine clips',
    pill: 'DONE', tone: 'green',
    preview: 'Stitched · 32s polished',
    body: 'If multi-clip mode rendered several outfits, this stitches them into one polished video. Single-look workflows pass straight through.',
    grid: { col: 1, row: 2 },
  },
  {
    icon: CaptionsIcon,
    title: 'Title + caption + hashtags',
    pill: 'DONE', tone: 'green',
    preview: '5 platforms · 5 hashtags',
    body: 'Generates a click-worthy title, a platform-tuned caption, and 5 hashtags — once, for every platform. The schedule node automatically picks the right variant for TikTok, Instagram, YouTube, X, and LinkedIn.',
    grid: { col: 1, row: 3 },
  },
  {
    icon: Type,
    title: 'Burn-in captions + title',
    pill: 'DONE', tone: 'green',
    preview: 'TikTok-style · word-by-word',
    body: 'Burns captions and the title onto the video using a 29+ template gallery — TikTok-style word-by-word, big bold karaoke, classic subtitles. Pick a style once and every render uses it.',
    grid: { col: 2, row: 3 },
  },
  {
    icon: Calendar,
    title: 'Schedule + post',
    pill: 'RUN', tone: 'red',
    preview: 'TikTok · IG · YT · X · LI',
    body: "Posts the finished video to every connected social account at the next open slot. Drafts get queued, scheduled posts go out automatically. You're done — for the day, the week, forever.",
    grid: { col: 3, row: 3 },
  },
]

const TONES = {
  red:     { fg: '#ef4444', bg: 'rgba(239,68,68,0.18)',   bd: 'rgba(239,68,68,0.35)' },
  green:   { fg: '#22c55e', bg: 'rgba(34,197,94,0.18)',   bd: 'rgba(34,197,94,0.35)' },
  gold:    { fg: '#f59e0b', bg: 'rgba(245,158,11,0.18)',  bd: 'rgba(245,158,11,0.35)' },
  neutral: { fg: '#a3a3a8', bg: 'rgba(255,255,255,0.04)', bd: 'rgba(255,255,255,0.12)' },
}

// Inline layout — all 9 nodes on a single horizontal row at y=50%,
// evenly distributed across the full canvas width. The viewBox is 0..100
// (with preserveAspectRatio="none") so 1 viewBox unit always equals 1%
// of the canvas, regardless of how wide the canvas actually renders.
const STEP_COUNT = STEPS.length
const stepCenterX = (i) => ((i + 0.5) / STEP_COUNT) * 100

// Static connector paths. We draw center-to-center for each adjacent
// pair; the actual node sits on top (higher z-index) and clips the
// path's ends, so visually only the gap between nodes shows the
// flowing dashed wire — and there's never an awkward end-cap.
const CONNECTORS = Array.from({ length: STEP_COUNT - 1 }, (_, i) => {
  const fromX = stepCenterX(i)
  const toX   = stepCenterX(i + 1)
  return `M ${fromX} 50 L ${toX} 50`
})

export default function WorkflowDemo({ persona, onClearPersona }) {
  const [activeStep, setActiveStep] = useState(0)
  const [autoTour, setAutoTour]     = useState(false)

  // The canvas is intentionally static — all 9 nodes are always
  // visible regardless of which persona (if any) is selected. The
  // `persona` prop only changes what's rendered in the info panel
  // below, where a persona-description callout fades in on top of
  // the per-step copy. Auto-tour and Prev/Next always cover the
  // full 9-step pipeline.
  useEffect(() => {
    if (!autoTour) return
    const id = setInterval(() => {
      setActiveStep((s) => (s + 1) % STEPS.length)
    }, 4500)
    return () => clearInterval(id)
  }, [autoTour])

  const select = (i) => { setActiveStep(i); setAutoTour(false) }
  const prev   = ()  => select((activeStep - 1 + STEPS.length) % STEPS.length)
  const next   = ()  => select((activeStep + 1) % STEPS.length)

  const active = STEPS[activeStep]
  // Sorted persona path used purely for the "key steps" pill row in
  // the panel callout. The canvas itself doesn't read this.
  const personaPath = persona?.steps?.length
    ? [...persona.steps].sort((a, b) => a - b)
    : null

  return (
    <div>
      <div style={canvasScrollWrap}>
      <div style={canvasFrame}>
        {/* Subtle 24px grid + radial red/purple wash */}
        <div aria-hidden style={canvasBackdrop} />

        {/* SVG connector layer */}
        <svg
          style={connectorSvg}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          <defs>
            <linearGradient id="wireGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%"  stopColor="rgba(239,68,68,0.25)" />
              <stop offset="50%" stopColor="rgba(239,68,68,0.85)" />
              <stop offset="100%" stopColor="rgba(239,68,68,0.25)" />
            </linearGradient>
            <linearGradient id="wireGradHot" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%"  stopColor="rgba(255,140,80,0.65)" />
              <stop offset="50%" stopColor="rgba(255,200,120,1)" />
              <stop offset="100%" stopColor="rgba(255,140,80,0.65)" />
            </linearGradient>
          </defs>

          {CONNECTORS.map((d, i) => {
            const isActive = i + 1 === activeStep   // connector i feeds node i+1
            return (
              <path
                key={i}
                d={d}
                stroke={isActive ? 'url(#wireGradHot)' : 'url(#wireGrad)'}
                strokeWidth={isActive ? 0.8 : 0.5}
                fill="none"
                strokeDasharray="1.5 1.7"
                strokeLinecap="round"
                style={{
                  animation: `flowDash ${isActive ? 0.9 : 1.4}s linear ${i * 0.15}s infinite`,
                  filter: isActive ? 'drop-shadow(0 0 1.5px rgba(255,180,100,0.9))' : 'none',
                }}
              />
            )
          })}
        </svg>

        {/* Nodes — all 9 always rendered. The canvas is purely a
            visual showcase; persona selection only affects the panel
            below, not what's drawn here. */}
        {STEPS.map((step, i) => {
          const tone = TONES[step.tone] || TONES.neutral
          const isActive = i === activeStep
          return (
            <button
              key={step.title}
              onClick={() => select(i)}
              style={{
                ...nodeBtn,
                ...nodePos(i),
                ...(isActive ? nodeBtnActive : null),
              }}
              aria-pressed={isActive}
            >
              <div style={stepNumberBadge}>{i + 1}</div>
              <div style={nodeHeader}>
                <div style={nodeIconBox}>
                  <step.icon size={11} strokeWidth={2.4} />
                </div>
                <div style={nodeTitle}>{step.title}</div>
                <div style={{ ...nodePill, color: tone.fg, background: tone.bg, borderColor: tone.bd }}>
                  {step.pill}
                </div>
              </div>
              <div style={nodePreview}>{step.preview}</div>
              <span aria-hidden style={portLeft}  />
              <span aria-hidden style={portRight} />
            </button>
          )
        })}
      </div>
      </div>

      {/* Detail panel — sits below the canvas. Two display modes:
          - Persona selected: a "What this means for <persona>"
            description block fades in at the top, including the persona
            body copy and a row of pills calling out the steps that
            matter most for them. The per-step section below stays
            visible so the visitor can still click around the canvas.
          - Default: just the per-step block. */}
      <div style={panel}>
        {persona && (
          <div style={personaBlock}>
            <div style={personaBlockHead}>
              <div style={personaBlockIcon}>
                <persona.icon size={18} strokeWidth={2.2} />
              </div>
              <div>
                <div style={personaBlockEyebrow}>What this looks like</div>
                <div style={personaBlockTitle}>{persona.label}</div>
              </div>
              <button
                onClick={onClearPersona}
                className="btn-ghost"
                aria-label="Clear persona"
                style={{ marginLeft: 'auto', padding: '6px 10px', fontSize: 11.5 }}
              >
                <X size={12} /> Clear
              </button>
            </div>
            <p style={personaBlockBody}>{persona.body}</p>
            {personaPath?.length > 0 && (
              <div style={personaBlockPills}>
                <span style={personaBlockPillLabel}>Key steps for you:</span>
                {personaPath.map((idx) => (
                  <button
                    key={idx}
                    onClick={() => select(idx)}
                    style={personaBlockPill}
                    title={`Jump to ${STEPS[idx].title}`}
                  >
                    <span style={personaBlockPillNumber}>{idx + 1}</span>
                    {STEPS[idx].title}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div style={panelHead}>
          <span style={panelStep}>STEP {activeStep + 1} OF {STEPS.length}</span>
          <h3 style={panelTitle}>{active.title}</h3>
        </div>
        <p style={panelBody}>{active.body}</p>

        <div style={panelControls}>
          <button onClick={prev} className="btn-secondary" aria-label="Previous step" style={iconBtn}>
            <ChevronLeft size={15} />
          </button>
          <button onClick={next} className="btn-secondary" aria-label="Next step" style={iconBtn}>
            <ChevronRight size={15} />
          </button>
          <button
            onClick={() => setAutoTour((t) => !t)}
            className={autoTour ? 'btn-primary' : 'btn-secondary'}
            style={{ padding: '9px 14px', fontSize: 12 }}
          >
            {autoTour ? <><Pause size={13} /> Pause tour</> : <><Play size={13} fill="currentColor" /> Auto-tour</>}
          </button>
          <div style={dotsRow}>
            {STEPS.map((s, i) => (
              <button
                key={s.title}
                onClick={() => select(i)}
                aria-label={`Go to step ${i + 1}: ${s.title}`}
                style={{ ...dot, ...(i === activeStep ? dotActive : null) }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Layout helper ────────────────────────────────────────────────────
// Inline positioning: every node sits on the horizontal mid-line
// (y = 50%), x-position derived from its index so the 9 steps are
// evenly distributed across the full canvas width.
function nodePos(i) {
  return {
    position: 'absolute',
    left: `${stepCenterX(i)}%`,
    top:  '50%',
    transform: 'translate(-50%, -50%)',
  }
}

// ─── Styles ───────────────────────────────────────────────────────────
// Inline single-row layout — canvas spans the full content width of
// the section. Wrapped in a horizontal-scroll container so the canvas
// keeps its min-width on narrow viewports (the 9 nodes still need room
// to breathe; rather than collapse them, we let the user pan).
const canvasScrollWrap = {
  width: '100%',
  overflowX: 'auto',
  // A tiny bit of bottom padding so the soft red shadow under the
  // canvas isn't clipped by the auto-scroll container's bounds.
  paddingBottom: 6,
  WebkitOverflowScrolling: 'touch',
}
const canvasFrame = {
  position: 'relative',
  width: '100%', minWidth: 1000,
  height: 'clamp(170px, 17vw, 220px)',
  borderRadius: 22,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  overflow: 'hidden',
  boxShadow: 'var(--shadow-card), 0 0 80px rgba(239,68,68,0.10)',
  isolation: 'isolate',
}
const canvasBackdrop = {
  position: 'absolute', inset: 0,
  background:
    'radial-gradient(ellipse at 18% 28%, rgba(239,68,68,0.10), transparent 50%), ' +
    'radial-gradient(ellipse at 82% 72%, rgba(168,85,247,0.08), transparent 50%), ' +
    'linear-gradient(var(--border) 1px, transparent 1px), ' +
    'linear-gradient(90deg, var(--border) 1px, transparent 1px)',
  backgroundSize: 'auto, auto, 24px 24px, 24px 24px',
  maskImage: 'radial-gradient(ellipse at center, black 60%, transparent 100%)',
  WebkitMaskImage: 'radial-gradient(ellipse at center, black 60%, transparent 100%)',
  pointerEvents: 'none', zIndex: 0,
}
const connectorSvg = {
  position: 'absolute', inset: 0, width: '100%', height: '100%',
  pointerEvents: 'none', zIndex: 1,
}

const nodeBtn = {
  // Width is a % of the canvas so it scales as the canvas does and
  // never overruns its cell (cell width is 100/9 ≈ 11.11%; 9.5% leaves
  // ~1.6% / ~16-19px of clear space between nodes for the connector).
  width: '9.5%',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '9px 10px 11px',
  zIndex: 2,
  cursor: 'pointer',
  textAlign: 'left',
  transition: 'transform 220ms var(--ease), border-color 220ms var(--ease), box-shadow 220ms var(--ease), background 220ms var(--ease)',
  fontFamily: 'inherit',
  color: 'inherit',
  willChange: 'transform',
}
const nodeBtnActive = {
  borderColor: 'rgba(239,68,68,0.55)',
  background: 'linear-gradient(180deg, rgba(239,68,68,0.10), var(--surface-2) 70%)',
  boxShadow: '0 0 0 1px rgba(239,68,68,0.35), 0 12px 32px rgba(239,68,68,0.30), 0 0 40px rgba(239,68,68,0.18)',
  transform: 'translate(-50%, -50%) scale(1.04)',
}
const nodeHeader = {
  display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
}
const nodeIconBox = {
  width: 18, height: 18, borderRadius: 5,
  display: 'grid', placeItems: 'center',
  background: 'rgba(239,68,68,0.16)',
  color: 'var(--red)',
  border: '1px solid rgba(239,68,68,0.30)',
  flexShrink: 0,
}
const nodeTitle = {
  fontFamily: 'var(--font-display)',
  fontSize: 11, fontWeight: 700,
  color: 'var(--text)',
  whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis',
}
const nodePill = {
  marginLeft: 'auto',
  fontSize: 8, fontFamily: 'var(--font-display)', fontWeight: 800,
  letterSpacing: '0.06em',
  padding: '2px 5px', borderRadius: 999,
  border: '1px solid currentColor',
}
const nodePreview = {
  fontSize: 10, color: 'var(--text-soft)', lineHeight: 1.4,
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 6, padding: '5px 7px',
  fontFamily: 'var(--font-display)',
  whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis',
}
const stepNumberBadge = {
  position: 'absolute', top: -7, left: -7,
  width: 17, height: 17, borderRadius: '50%',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff',
  display: 'grid', placeItems: 'center',
  fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 9,
  boxShadow: '0 4px 10px rgba(239,68,68,0.45)',
  zIndex: 1,
}
function portStyle(side) {
  return {
    position: 'absolute', top: '50%',
    [side]: -5, transform: 'translateY(-50%)',
    width: 10, height: 10, borderRadius: '50%',
    background: 'var(--red)',
    boxShadow: '0 0 0 3px var(--surface-2), 0 0 8px rgba(239,68,68,0.6)',
  }
}
const portLeft  = portStyle('left')
const portRight = portStyle('right')

// ── Detail panel ─────────────────────────────────────────────────────
// Width matches the canvas so the two read as one composition.
const panel = {
  maxWidth: 760, margin: '20px auto 0',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  padding: '20px 24px',
  boxShadow: 'var(--shadow-card)',
}
// Persona description block — fades in above the per-step section
// when a use-case card is clicked. It explains what the workflow
// means for that audience and offers clickable "key step" pills that
// jump the active step on the canvas without otherwise changing it.
const personaBlock = {
  marginBottom: 18, paddingBottom: 18,
  borderBottom: '1px solid var(--border)',
  background: 'linear-gradient(180deg, rgba(239,68,68,0.06), transparent 100%)',
  borderRadius: 12,
  padding: '14px 14px 16px',
  border: '1px solid rgba(239,68,68,0.22)',
  animation: 'fadeIn 0.35s var(--ease)',
}
const personaBlockHead = {
  display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10,
}
const personaBlockIcon = {
  width: 36, height: 36, borderRadius: 10,
  display: 'grid', placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff',
  boxShadow: '0 6px 16px rgba(239,68,68,0.32)',
  flexShrink: 0,
}
const personaBlockEyebrow = {
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10,
  letterSpacing: '0.10em', textTransform: 'uppercase',
  color: 'var(--red)',
}
const personaBlockTitle = {
  fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 17,
  color: 'var(--text)', letterSpacing: '-0.01em',
  marginTop: 2,
}
const personaBlockBody = {
  fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-soft)',
  margin: '0 0 12px',
}
const personaBlockPills = {
  display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
}
const personaBlockPillLabel = {
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11,
  color: 'var(--muted)',
  letterSpacing: '0.02em',
  marginRight: 4,
}
const personaBlockPill = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '5px 9px 5px 5px', borderRadius: 999,
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  cursor: 'pointer',
  fontFamily: 'inherit', color: 'var(--text)',
  fontSize: 11.5, fontWeight: 600,
  transition: 'border-color 180ms var(--ease), background 180ms var(--ease)',
}
const personaBlockPillNumber = {
  width: 16, height: 16, borderRadius: '50%',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff',
  display: 'grid', placeItems: 'center',
  fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 9,
}

const panelHead = { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 8 }
const panelStep = {
  fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 11,
  letterSpacing: '0.10em', textTransform: 'uppercase',
  color: 'var(--red)',
  padding: '4px 10px', borderRadius: 999,
  background: 'rgba(239,68,68,0.12)',
  border: '1px solid rgba(239,68,68,0.28)',
}
const panelTitle = {
  fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22,
  color: 'var(--text)', letterSpacing: '-0.01em',
  margin: 0,
}
const panelBody = {
  fontSize: 14.5, color: 'var(--text-soft)', lineHeight: 1.6,
  margin: '4px 0 18px',
  maxWidth: 760,
}
const panelControls = {
  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
}
const iconBtn = {
  padding: '9px 12px', justifyContent: 'center',
  display: 'inline-flex', alignItems: 'center',
}
const dotsRow = {
  display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap',
}
const dot = {
  width: 8, height: 8, borderRadius: '50%',
  background: 'var(--border-strong)',
  border: 'none', cursor: 'pointer', padding: 0,
  transition: 'transform 180ms var(--ease), background 180ms var(--ease), box-shadow 180ms var(--ease)',
}
const dotActive = {
  background: 'var(--red)',
  boxShadow: '0 0 10px rgba(239,68,68,0.7)',
  transform: 'scale(1.3)',
}
