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

// SVG paths between consecutive nodes (1→2, 2→3, …, 8→9). viewBox is
// 0 0 100 100; container is forced to the same aspect ratio so 1
// viewBox unit equals 1% of width or height. Each path stops short of
// the node so the connector visually meets the node's edge port.
const CONNECTORS = [
  'M 27 18 L 38 18',                 // 1 → 2
  'M 62 18 L 73 18',                 // 2 → 3
  'M 85 28 Q 85 35 85 42',           // 3 → 4 (down)
  'M 73 50 L 62 50',                 // 4 → 5 (right-to-left)
  'M 38 50 L 27 50',                 // 5 → 6
  'M 15 58 Q 15 65 15 72',           // 6 → 7 (down)
  'M 27 82 L 38 82',                 // 7 → 8
  'M 62 82 L 73 82',                 // 8 → 9
]

export default function WorkflowDemo({ persona, onClearPersona }) {
  const [activeStep, setActiveStep] = useState(0)
  const [autoTour, setAutoTour]     = useState(false)

  // Sorted ascending list of step indices the active persona cares about
  // (e.g. Podcasters → [2,4,5,7,8]). Empty/undefined when no persona.
  const personaPath = persona?.steps?.length
    ? [...persona.steps].sort((a, b) => a - b)
    : null
  const inPath = (i) => !personaPath || personaPath.includes(i)

  // Whenever the persona changes, snap to its first relevant step and
  // auto-start the tour so the visitor sees the path play out.
  useEffect(() => {
    if (personaPath) {
      setActiveStep(personaPath[0])
      setAutoTour(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona?.key])

  // Auto-tour: tick the active step every 4.5s. When a persona is
  // active, cycle ONLY through that persona's steps (looping back to
  // the first relevant step at the end).
  useEffect(() => {
    if (!autoTour) return
    const id = setInterval(() => {
      setActiveStep((s) => {
        if (personaPath) {
          const next = personaPath.find((idx) => idx > s)
          return next !== undefined ? next : personaPath[0]
        }
        return (s + 1) % STEPS.length
      })
    }, 4500)
    return () => clearInterval(id)
  }, [autoTour, personaPath])

  // Pause auto-tour on any explicit click. When a persona is active,
  // wrap prev/next around the persona's steps; otherwise around all 9.
  const select = (i) => { setActiveStep(i); setAutoTour(false) }
  const stepUniverse = personaPath || STEPS.map((_, i) => i)
  const stepIndex = stepUniverse.indexOf(activeStep)
  const prev = () => {
    const safeIdx = stepIndex >= 0 ? stepIndex : 0
    select(stepUniverse[(safeIdx - 1 + stepUniverse.length) % stepUniverse.length])
  }
  const next = () => {
    const safeIdx = stepIndex >= 0 ? stepIndex : -1
    select(stepUniverse[(safeIdx + 1) % stepUniverse.length])
  }

  const active = STEPS[activeStep]

  return (
    <div>
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
            // Connector i wires step i → step i+1.
            const fromStep = i
            const toStep   = i + 1
            const isActive = toStep === activeStep
            // When a persona is active, dim connectors that aren't part
            // of the persona's path (both endpoints must be in the path).
            const onPath = !personaPath || (personaPath.includes(fromStep) && personaPath.includes(toStep))
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
                  opacity: onPath ? 1 : 0.18,
                  transition: 'opacity 320ms var(--ease)',
                }}
              />
            )
          })}
        </svg>

        {/* Nodes */}
        {STEPS.map((step, i) => {
          const tone = TONES[step.tone] || TONES.neutral
          const isActive = i === activeStep
          const isOnPath = inPath(i)
          const dimmed = personaPath && !isOnPath
          return (
            <button
              key={step.title}
              onClick={() => select(i)}
              style={{
                ...nodeBtn,
                ...nodePos(step.grid),
                ...(isOnPath && personaPath && !isActive ? nodeBtnOnPath : null),
                ...(isActive ? nodeBtnActive : null),
                ...(dimmed ? nodeBtnDimmed : null),
              }}
              aria-pressed={isActive}
              aria-disabled={dimmed}
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

      {/* Detail panel — sits below the canvas */}
      <div style={panel}>
        {persona && (
          <div style={personaBadgeRow}>
            <span style={personaBadge}>
              <span style={personaBadgeDot} />
              Showing path for <strong style={{ marginLeft: 4 }}>{persona.label}</strong>
              <span style={personaBadgeMeta}>· {personaPath.length} of {STEPS.length} steps</span>
            </span>
            <button
              onClick={onClearPersona}
              className="btn-ghost"
              aria-label="Show all steps"
              style={{ padding: '6px 10px', fontSize: 11.5 }}
            >
              <X size={12} /> Show all steps
            </button>
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
function nodePos({ col, row }) {
  // Snake layout coordinates (in % of canvas frame).
  const x = col === 1 ? 15 : col === 2 ? 50 : 85
  const y = row === 1 ? 18 : row === 2 ? 50 : 82
  return {
    position: 'absolute',
    left: `${x}%`,
    top:  `${y}%`,
    transform: 'translate(-50%, -50%)',
  }
}

// ─── Styles ───────────────────────────────────────────────────────────
const canvasFrame = {
  position: 'relative',
  maxWidth: 1100, margin: '0 auto',
  aspectRatio: '10 / 7',
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
  width: 'clamp(150px, 18vw, 220px)',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: '12px 14px 14px',
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
// On-path-but-not-active: subtle constant glow so the persona's full
// route is visible even when only one step is "selected". Keeps the
// transform identical to the base so the node doesn't shift.
const nodeBtnOnPath = {
  borderColor: 'rgba(239,68,68,0.40)',
  background: 'linear-gradient(180deg, rgba(239,68,68,0.06), var(--surface-2) 80%)',
  boxShadow: '0 0 0 1px rgba(239,68,68,0.18), 0 8px 24px rgba(239,68,68,0.16)',
}
// Dimmed: not part of the persona's path. Faded but still readable.
const nodeBtnDimmed = {
  opacity: 0.32,
  filter: 'saturate(0.55)',
}
const nodeHeader = {
  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
}
const nodeIconBox = {
  width: 22, height: 22, borderRadius: 6,
  display: 'grid', placeItems: 'center',
  background: 'rgba(239,68,68,0.16)',
  color: 'var(--red)',
  border: '1px solid rgba(239,68,68,0.30)',
  flexShrink: 0,
}
const nodeTitle = {
  fontFamily: 'var(--font-display)',
  fontSize: 12, fontWeight: 700,
  color: 'var(--text)',
  whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis',
}
const nodePill = {
  marginLeft: 'auto',
  fontSize: 9, fontFamily: 'var(--font-display)', fontWeight: 800,
  letterSpacing: '0.06em',
  padding: '2px 6px', borderRadius: 999,
  border: '1px solid currentColor',
}
const nodePreview = {
  fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.45,
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 8, padding: '7px 9px',
  fontFamily: 'var(--font-display)',
  whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis',
}
const stepNumberBadge = {
  position: 'absolute', top: -8, left: -8,
  width: 20, height: 20, borderRadius: '50%',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff',
  display: 'grid', placeItems: 'center',
  fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 10,
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
const panel = {
  maxWidth: 1100, margin: '24px auto 0',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  padding: '22px 26px',
  boxShadow: 'var(--shadow-card)',
}
// Persona badge — sits above panelHead when a persona is morphing the canvas.
const personaBadgeRow = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 12, flexWrap: 'wrap', marginBottom: 14,
  paddingBottom: 14, borderBottom: '1px solid var(--border)',
}
const personaBadge = {
  display: 'inline-flex', alignItems: 'center', gap: 8,
  padding: '7px 13px', borderRadius: 999,
  background: 'rgba(239,68,68,0.12)',
  border: '1px solid rgba(239,68,68,0.35)',
  fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 12,
  color: 'var(--text)',
}
const personaBadgeDot = {
  width: 8, height: 8, borderRadius: '50%',
  background: 'var(--red)',
  boxShadow: '0 0 8px rgba(239,68,68,0.7)',
  animation: 'pulseGlow 1.8s var(--ease) infinite',
}
const personaBadgeMeta = {
  marginLeft: 6, color: 'var(--muted)', fontWeight: 500,
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
