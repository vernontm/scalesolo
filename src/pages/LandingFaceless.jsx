// Ad-traffic landing page at /faceless-brand. Funnel structure tuned
// for paid social → signup conversion:
//   1. Hero (autoplay demo + primary CTA)
//   2. Social-proof strip — real faceless brand profiles
//   3. Headline stat — the 403K views screenshot, framed as proof
//   4. Four steps, each anchored on a real product GIF + body copy
//   5. Stats bar (creator economy)
//   6. Final pricing block (founding price)
//   7. Footer
//
// Multiple "Start your free trial" CTAs scroll-link to #pricing, which
// drops straight into PricingPlans. Single conversion target. The
// minimal header (logo only) is intentional — we don't want ad traffic
// bouncing into the broader feature tour.
//
// Step media lives at /landing/faceless-steps/step-{1..4}.mp4 (autoplay
// muted loop, vertical 1080x1920) plus four proof PNGs alongside.

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Zap, ArrowRight, Check, Play, X,
} from 'lucide-react'
import PricingPlans from '../components/PricingPlans.jsx'

const HERO_VIDEO = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/Scalesolo%20ad.mp4'

const STEP_MEDIA = '/landing/faceless-steps/'
// Landscape step GIFs hosted in Supabase storage (landing-media bucket).
// Single source of truth — easier to swap renders without touching the repo.
const STEP_GIF_BASE = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/steps-gif/'

const PROOF_TILES = [
  { src: `${STEP_MEDIA}proof-stats.png`,   alt: '403,840 views in 30 days · Instagram analytics' },
  { src: `${STEP_MEDIA}proof-margo.png`,   alt: 'Soul of Margo · faceless creator profile' },
  { src: `${STEP_MEDIA}proof-3.png`,       alt: 'Faceless brand growth example' },
]

const STEPS = [
  {
    n: '01',
    src: `${STEP_GIF_BASE}step-1-landscape.gif`,
    eyebrow: 'Step 1 · Create your avatar',
    title: 'Drop in one photo. We build your AI avatar.',
    body: 'Type a name, upload one clean headshot, and ScaleSolo turns it into a fully-rigged avatar you can reuse forever. No camera, no studio, no awkward selfie sessions every week.',
  },
  {
    n: '02',
    src: `${STEP_GIF_BASE}step-2-landscape.gif`,
    eyebrow: 'Step 2 · Build your first look',
    title: 'Pick three photos with the same outfit. Done.',
    body: "Same outfit = same look. Save it once and ScaleSolo keeps your feed visually consistent across every video. Rotate multiple Looks so your audience never sees the same scene twice.",
  },
  {
    n: '03',
    src: `${STEP_GIF_BASE}step-3-landscape.gif`,
    eyebrow: 'Step 3 · Give your avatar a voice',
    title: 'Clone your voice or pick one from our library.',
    body: 'Every script reads in your real voice, with your pacing and energy. Or pick from a built-in library if you want to stay completely anonymous. The result sounds human, not robotic.',
  },
  {
    n: '04',
    src: `${STEP_GIF_BASE}step-4-landscape.gif`,
    eyebrow: 'Step 4 · Set it on autopilot',
    title: 'Connect a workflow. Let it post forever.',
    body: 'Wire up your nodes once: idea → script → avatar → video → caption → schedule. Hit auto-run. ScaleSolo creates and posts content to TikTok, Instagram, YouTube Shorts, Facebook Reels, and Threads while you sleep.',
  },
]

export default function LandingFaceless() {
  const [demoOpen, setDemoOpen] = useState(false)

  // Esc closes lightbox + lock body scroll while open.
  useEffect(() => {
    if (!demoOpen) return
    const onKey = (e) => { if (e.key === 'Escape') setDemoOpen(false) }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [demoOpen])

  const scrollToPricing = () => {
    const el = document.getElementById('pricing')
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // Primary trial CTA reused across the page so every section has an
  // obvious next-step button.
  const TrialCTA = ({ label = 'Start your free trial', secondary = false }) => (
    <button
      type="button"
      onClick={scrollToPricing}
      className={secondary ? 'btn-secondary' : 'btn-primary'}
      style={ctaSizing}
    >
      {label} <ArrowRight size={14} />
    </button>
  )

  return (
    <div style={page}>
      {/* ── MINIMAL HEADER ─────────────────────────────────────────────── */}
      <header style={header}>
        <Link to="/" style={logoLink} aria-label="ScaleSolo home">
          <span style={logoMark}><Zap size={16} strokeWidth={2.6} /></span>
          <span style={logoText}>ScaleSolo</span>
        </Link>
        <button type="button" onClick={scrollToPricing} className="btn-primary" style={headerCta}>
          Start free trial
        </button>
      </header>

      {/* ── SOCIAL PROOF: real faceless brands ─────────────────────────── */}
      <section style={section}>
        <div style={sectionHead}>
          <div style={sectionEyebrow}>Real faceless brands</div>
          <h2 style={h2}>
            Creators are scaling brands like these <span className="brand-text">without ever showing their face.</span>
          </h2>
          <p style={sectionBody}>
            Faceless avatar brands now rack up hundreds of thousands of views, followers, and likes
            on autopilot. ScaleSolo is the engine that powers them.
          </p>
        </div>

        <div style={proofGrid}>
          {PROOF_TILES.map((t) => (
            <div key={t.src} style={proofTile} className="fade-up">
              <img src={t.src} alt={t.alt} style={proofImg} loading="lazy" />
            </div>
          ))}
        </div>

        <div style={stepsCtaWrap}>
          <TrialCTA label="Start building yours · free trial" />
        </div>
      </section>

      {/* ── HOW IT WORKS: 4 steps × videos ─────────────────────────────── */}
      <section style={section}>
        <div style={sectionHead}>
          <div style={sectionEyebrow}>How it works</div>
          <h2 style={h2}>Four steps. About five minutes.</h2>
          <p style={sectionBody}>
            The exact workflow that takes one photo and one idea, and ships a finished video to every
            platform you post on.
          </p>
        </div>

        <ol style={stepsList}>
          {STEPS.map((s, i) => (
            <StepRow key={s.n} step={s} flip={i % 2 === 1} />
          ))}
        </ol>

        <div style={stepsCtaWrap}>
          <TrialCTA label="Get the workflow · free trial" />
        </div>
      </section>

      {/* ── STATS BAR ──────────────────────────────────────────────────── */}
      <section style={section}>
        <div className="stats-grid">
          <Stat number="$250B+" label={<>Creator economy<br />size by 2027</>} />
          <Stat number="10x"     label={<>Your monthly<br />content output</>} />
          <Stat number="30+ hrs" label={<>Saved per brand,<br />every single week</>} />
          <Stat number="9+"      label={<>Platforms publishing<br />on full autopilot</>} />
        </div>

        <div style={stepsCtaWrap}>
          <TrialCTA />
        </div>
      </section>

      {/* ── PRICING ────────────────────────────────────────────────────── */}
      <section id="pricing" style={{ ...section, paddingTop: 24 }}>
        <div style={sectionHead}>
          <div style={sectionEyebrow}>Founding pricing</div>
          <h2 style={h2}>One-hundred lifetime spots. <span className="brand-text">Never goes up.</span></h2>
          <p style={sectionBody}>
            Lock $79/mo (or $65/mo billed annually) for life. Includes 2× AI tokens, 50% more video
            units, and direct input on the roadmap. 3-day free trial, cancel anytime.
          </p>
        </div>
        <PricingPlans />
      </section>

      {/* ── FINAL CTA STRIP ────────────────────────────────────────────── */}
      <section style={{ ...section, paddingTop: 8 }}>
        <div style={finalCta}>
          <div style={finalCtaGlow} aria-hidden />
          <h2 style={{ ...h2, fontSize: 'clamp(26px, 3.6vw, 36px)' }}>
            Start your <span className="brand-text">faceless brand</span> in the next 5 minutes.
          </h2>
          <p style={{ ...sectionBody, maxWidth: 560 }}>
            Drop in a photo, build your first Look, and let ScaleSolo do the rest.
            Free for three days. Then $79/mo, locked for life.
          </p>
          <div style={{ ...ctas, marginTop: 14 }}>
            <TrialCTA />
            <button type="button" onClick={() => setDemoOpen(true)} className="btn-secondary" style={ctaSizing}>
              <Play size={13} fill="currentColor" /> See it in action
            </button>
          </div>
          <div style={trustPills}>
            <span style={pill}><Check size={11} /> 3-day free trial</span>
            <span style={pill}><Check size={11} /> No card commitment</span>
            <span style={pill}><Check size={11} /> Cancel anytime</span>
          </div>
        </div>
      </section>

      {/* ── FOOTER ─────────────────────────────────────────────────────── */}
      <footer style={footer}>
        <div>© {new Date().getFullYear()} ScaleSolo</div>
        <div style={footerLinks}>
          <a href="/privacy" style={footerLink}>Privacy</a>
          <a href="/terms" style={footerLink}>Terms</a>
          <Link to="/login" style={footerLink}>Sign in</Link>
        </div>
      </footer>

      {/* ── DEMO LIGHTBOX ──────────────────────────────────────────────── */}
      {demoOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="ScaleSolo demo video"
          onClick={() => setDemoOpen(false)}
          style={modalBackdrop}
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setDemoOpen(false) }}
            aria-label="Close demo"
            style={modalClose}
          >
            <X size={20} />
          </button>
          <video
            onClick={(e) => e.stopPropagation()}
            src={HERO_VIDEO}
            controls
            autoPlay
            playsInline
            preload="auto"
            style={modalVideo}
          />
        </div>
      )}
    </div>
  )
}

function Stat({ number, label }) {
  return (
    <div className="stat-cell">
      <div className="stat-number">{number}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

// Step card: landscape 16:9 GIF on one side, copy on the other.
// Alternates side via `flip`. Browser handles GIF playback natively —
// loading="lazy" defers fetch until the row scrolls near the viewport
// so the page doesn't pull four big GIFs at first paint.
function StepRow({ step, flip }) {
  return (
    <li style={{ ...stepRow, flexDirection: flip ? 'row-reverse' : 'row' }}>
      <div style={stepMediaWrap} className="step-media-wrap">
        <div style={stepMediaHalo} aria-hidden />
        <div style={stepMediaFrame}>
          <img
            src={step.src}
            alt={step.title}
            style={stepGifEl}
            loading="lazy"
            onError={(e) => { e.currentTarget.style.opacity = '0' }}
          />
        </div>
      </div>
      <div style={stepCopy} className="step-copy">
        <div style={stepN}>{step.n}</div>
        <div style={stepEyebrow}>{step.eyebrow}</div>
        <h3 style={stepHeadline}>{step.title}</h3>
        <p style={stepBodyCopy}>{step.body}</p>
      </div>
    </li>
  )
}

// ── styles ────────────────────────────────────────────────────────────
const page = { background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh' }
const header = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '16px 24px', borderBottom: '1px solid rgba(255,255,255,0.06)',
  maxWidth: 1180, margin: '0 auto',
}
const headerCta = { padding: '8px 16px', fontSize: 13, gap: 6 }
const logoLink = { display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none', color: 'var(--text)' }
const logoMark = {
  width: 28, height: 28, borderRadius: 8,
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', display: 'grid', placeItems: 'center',
  boxShadow: '0 4px 14px rgba(239,68,68,0.32)',
}
const logoText = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, letterSpacing: '-0.01em' }

const ctas = { display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center', marginTop: 14 }
const ctaSizing = { padding: '13px 24px', fontSize: 14, justifyContent: 'center' }
const trustPills = { display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }
const pill = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  fontSize: 12, color: 'var(--text-soft)',
  background: 'var(--surface-2)', padding: '6px 12px',
  borderRadius: 999, border: '1px solid var(--border)',
}

const section = { maxWidth: 1180, margin: '0 auto', padding: '48px 20px' }
const sectionHead = { textAlign: 'center', maxWidth: 760, margin: '0 auto 36px' }
const sectionEyebrow = {
  display: 'inline-flex', padding: '4px 12px', borderRadius: 999,
  background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.25)',
  color: 'var(--red)', fontSize: 10.5, fontFamily: 'var(--font-display)',
  fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase',
  marginBottom: 12,
}
const h2 = {
  fontFamily: 'var(--font-display)', fontWeight: 800,
  fontSize: 'clamp(28px, 4vw, 42px)', lineHeight: 1.08,
  letterSpacing: '-0.02em', margin: 0,
}
const sectionBody = { color: 'var(--text-soft)', fontSize: 15, lineHeight: 1.55, margin: '14px auto 0' }

// Social-proof grid: 3 phone screenshots side by side, vertical aspect.
const proofGrid = {
  display: 'grid', gap: 18,
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))',
  maxWidth: 920, margin: '0 auto',
}
const proofTile = {
  position: 'relative',
  borderRadius: 18,
  background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))',
  border: '1px solid rgba(255,255,255,0.06)',
  padding: 10,
  boxShadow: '0 20px 50px -10px rgba(0,0,0,0.5)',
}
const proofImg = {
  display: 'block',
  width: '100%', height: 'auto', aspectRatio: '1290 / 2796',
  objectFit: 'cover',
  borderRadius: 12,
}

// Steps list: each step is a row with video + copy. Flips sides on
// even steps.
const stepsList = {
  listStyle: 'none', padding: 0, margin: 0,
  display: 'flex', flexDirection: 'column', gap: 60,
}
const stepRow = {
  display: 'flex', alignItems: 'center',
  gap: 48, flexWrap: 'wrap',
}
const stepMediaWrap = {
  position: 'relative',
  flex: '1 1 380px', maxWidth: 560, minWidth: 280,
  margin: '0 auto',
}
const stepMediaHalo = {
  position: 'absolute', inset: '-14%',
  background: 'radial-gradient(45% 45% at 50% 50%, rgba(239,68,68,0.28), transparent 70%)',
  filter: 'blur(40px)', pointerEvents: 'none', zIndex: 0,
}
const stepMediaFrame = {
  position: 'relative', zIndex: 1,
  borderRadius: 18, overflow: 'hidden',
  background: '#000',
  border: '4px solid rgba(255,255,255,0.08)',
  boxShadow: '0 40px 80px -10px rgba(0,0,0,0.55)',
  aspectRatio: '1920 / 1080',
}
const stepGifEl = {
  width: '100%', height: '100%', display: 'block',
  objectFit: 'cover',
}
const stepCopy = {
  flex: '1 1 360px', minWidth: 280,
}
const stepN = {
  fontFamily: 'var(--font-display)', fontWeight: 800,
  fontSize: 64,
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  WebkitBackgroundClip: 'text', backgroundClip: 'text',
  color: 'transparent',
  letterSpacing: '-0.04em',
  lineHeight: 0.9,
  marginBottom: 6,
}
const stepEyebrow = {
  display: 'inline-flex', padding: '4px 12px', borderRadius: 999,
  background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.25)',
  color: 'var(--red)', fontSize: 10.5, fontFamily: 'var(--font-display)',
  fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase',
  marginBottom: 12,
}
const stepHeadline = {
  fontFamily: 'var(--font-display)', fontWeight: 800,
  fontSize: 'clamp(22px, 2.6vw, 30px)', lineHeight: 1.15,
  letterSpacing: '-0.02em', margin: 0,
}
const stepBodyCopy = {
  marginTop: 12, color: 'var(--text-soft)',
  fontSize: 15.5, lineHeight: 1.6,
}
const stepsCtaWrap = { display: 'flex', justifyContent: 'center', marginTop: 36, gap: 12, flexWrap: 'wrap' }

// Final-CTA strip.
const finalCta = {
  position: 'relative',
  maxWidth: 760, margin: '0 auto',
  padding: '48px 28px',
  borderRadius: 24,
  background: 'linear-gradient(180deg, rgba(239,68,68,0.10), rgba(239,68,68,0.02))',
  border: '1px solid rgba(239,68,68,0.32)',
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  gap: 14, textAlign: 'center',
  overflow: 'hidden', isolation: 'isolate',
}
const finalCtaGlow = {
  position: 'absolute', top: '-40%', left: '50%',
  transform: 'translateX(-50%)',
  width: '120%', height: 360,
  background: 'radial-gradient(50% 50% at 50% 50%, rgba(251,191,36,0.18), transparent 70%)',
  filter: 'blur(40px)', pointerEvents: 'none', zIndex: -1,
}

const footer = {
  borderTop: '1px solid rgba(255,255,255,0.06)',
  padding: '24px 20px',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  flexWrap: 'wrap', gap: 12,
  fontSize: 12.5, color: 'var(--muted)',
  maxWidth: 1180, margin: '32px auto 0',
}
const footerLinks = { display: 'inline-flex', gap: 18 }
const footerLink = { color: 'var(--muted)', textDecoration: 'none' }

const modalBackdrop = {
  position: 'fixed', inset: 0,
  background: 'rgba(0, 0, 0, 0.88)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  display: 'grid', placeItems: 'center',
  zIndex: 1000, padding: 24,
  animation: 'fadeIn 180ms var(--ease) forwards',
}
const modalClose = {
  position: 'absolute', top: 18, right: 18,
  width: 44, height: 44, borderRadius: 999,
  background: 'rgba(255, 255, 255, 0.08)',
  border: '1px solid rgba(255, 255, 255, 0.18)',
  color: '#fff',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer',
}
const modalVideo = {
  width: 'min(1100px, 92vw)', maxHeight: '86vh',
  borderRadius: 14, boxShadow: '0 30px 80px rgba(0, 0, 0, 0.6)',
  background: '#000',
}
