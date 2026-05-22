// Ad-traffic landing page at /faceless-brand. Funnel is a $1 tripwire:
//   1. Social-proof tile grid (3 faceless brand profiles)
//   2. Headline stat (403,840 views proof)
//   3. Four steps, each anchored on a real product GIF + body copy
//   4. Scarcity bar — $1 trial, $79/mo after, only 100 Founding spots
//   5. Final CTA strip
//   6. Footer
//
// Every CTA hits POST /api/stripe-trial-checkout which creates a
// Stripe Checkout session that charges $1 today + starts a 3-day
// trial on the $79/mo Founding price. After 3 days the subscription
// auto-converts. Modeled after DigitalMarketer's "$1 charter trial"
// landing. The pricing comparison table is intentionally hidden on
// /faceless-brand — full PricingPlans still lives on /pricing and in
// the in-app paywall for warm traffic.
//
// Step media: landscape GIFs hosted in Supabase storage.

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Zap, ArrowRight, Check, Play, X,
} from 'lucide-react'

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
  const [busy, setBusy] = useState(false)
  const [checkoutError, setCheckoutError] = useState(null)

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

  // Single click target: POSTs to the $1-trial Stripe endpoint and
  // hands the browser off to the returned Checkout URL. The endpoint
  // is anonymous — Stripe collects the email itself during checkout.
  const startTrial = async () => {
    if (busy) return
    setBusy(true)
    setCheckoutError(null)
    try {
      const r = await fetch('/api/stripe-trial-checkout', { method: 'POST' })
      const body = await r.json().catch(() => ({}))
      if (!r.ok || !body.url) throw new Error(body?.error || `Couldn't start checkout (${r.status})`)
      window.location.href = body.url
    } catch (e) {
      setCheckoutError(e.message || 'Something went wrong starting your trial.')
      setBusy(false)
    }
  }

  // Primary CTA used across the page. Every visible button on the
  // funnel is one of these — single conversion target.
  const TrialCTA = ({ label = 'Start your trial for $1', secondary = false }) => (
    <button
      type="button"
      onClick={startTrial}
      disabled={busy}
      className={secondary ? 'btn-secondary' : 'btn-primary'}
      style={{ ...ctaSizing, opacity: busy ? 0.7 : 1, cursor: busy ? 'wait' : 'pointer' }}
    >
      {busy ? 'Opening checkout…' : label} <ArrowRight size={14} />
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
        <button type="button" onClick={startTrial} disabled={busy} className="btn-primary" style={headerCta}>
          {busy ? 'Opening…' : 'Start trial · $1'}
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
          <TrialCTA label="Start building yours · $1 trial" />
        </div>
      </section>

      {/* ── HEADLINE STAT: 403K views copy + Talk It Out image ─────────── */}
      <section style={section}>
        <div style={proofSplit}>
          <div style={proofSplitText}>
            <div style={sectionEyebrow}>The result, in one screenshot</div>
            <h2 style={h2}>
              <span style={{ background: 'linear-gradient(90deg, #10b981, #6ee7b7)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>403,840 views.</span>
            </h2>
            <h3 style={proofH3}>Zero on-camera time. One faceless avatar.</h3>
            <p style={sectionBody}>
              30 days. One creator. One avatar. The exact ScaleSolo workflow you're about to see.
              305,383 accounts reached, 163% growth, and not a single video where the creator showed
              their face.
            </p>
            <div style={{ ...stepsCtaWrap, marginTop: 22, justifyContent: 'flex-start' }}>
              <TrialCTA />
            </div>
          </div>
          <div style={proofSplitMedia}>
            <div style={proofHalo} aria-hidden />
            <img
              src={`${STEP_MEDIA}proof-podcast.png`}
              alt="Faceless brand built with ScaleSolo"
              style={proofPhone}
              loading="lazy"
            />
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS: 4 steps × videos ─────────────────────────────── */}
      <section style={section}>
        <div style={sectionHead}>
          <div style={sectionEyebrow}>How it works</div>
          <h2 style={h2}>Launch Your AI Avatar Brand in minutes</h2>
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
          <TrialCTA label="Get the workflow · $1 trial" />
        </div>
      </section>

      {/* ── FINAL CTA STRIP ($1 tripwire) ──────────────────────────────── */}
      <section style={{ ...section, paddingTop: 8 }}>
        <div style={finalCta}>
          <div style={finalCtaGlow} aria-hidden />
          <div style={sectionEyebrow}>Founding access · only 100 spots</div>
          <h2 style={{ ...h2, fontSize: 'clamp(28px, 3.6vw, 40px)' }}>
            Get instant access for <span className="brand-text">$1</span>.
          </h2>
          <p style={{ ...sectionBody, maxWidth: 580 }}>
            Try ScaleSolo for 3 days. Build avatars, generate videos, polish, and post manually —
            it's all yours. Auto-scheduling unlocks the moment your trial converts. After day 3
            you lock in our Founding price for life. Cancel anytime online before then and you
            won't be billed again.
          </p>
          <div style={{ ...ctas, marginTop: 14 }}>
            <TrialCTA label="Get instant access for $1" />
            <button type="button" onClick={() => setDemoOpen(true)} className="btn-secondary" style={ctaSizing}>
              <Play size={13} fill="currentColor" /> See it in action
            </button>
          </div>
          <div style={trustPills}>
            <span style={pill}><Check size={11} /> $1 today · 3-day trial</span>
            <span style={pill}><Check size={11} /> Cancel anytime, no hassle</span>
            <span style={pill}><Check size={11} /> Founding price locked for life</span>
          </div>
          {checkoutError && (
            <div style={errorBox} role="alert">
              {checkoutError}
            </div>
          )}
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

// Split section: 403K stats screenshot + headline copy side by side.
const proofSplit = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))',
  gap: 32,
  alignItems: 'center',
  maxWidth: 1080,
  margin: '0 auto',
}
const proofSplitText = { textAlign: 'left' }
const proofH3 = {
  marginTop: 8, fontFamily: 'var(--font-display)',
  fontSize: 'clamp(20px, 2.4vw, 26px)', fontWeight: 700,
  color: 'var(--text)', letterSpacing: '-0.015em',
}
const proofSplitMedia = {
  position: 'relative',
  display: 'grid', placeItems: 'center',
}
const proofHalo = {
  position: 'absolute', inset: '-15%',
  background: 'radial-gradient(40% 40% at 50% 50%, rgba(16,185,129,0.35), transparent 70%)',
  filter: 'blur(40px)', pointerEvents: 'none', zIndex: 0,
}
const proofPhone = {
  position: 'relative', zIndex: 1,
  width: '100%', maxWidth: 320,
  aspectRatio: '1290 / 2796', objectFit: 'cover',
  borderRadius: 28, border: '4px solid rgba(255,255,255,0.06)',
  boxShadow: '0 40px 80px -10px rgba(0,0,0,0.55), 0 0 0 2px rgba(16,185,129,0.35)',
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
const errorBox = {
  marginTop: 12,
  padding: '10px 14px',
  borderRadius: 10,
  background: 'rgba(239,68,68,0.12)',
  border: '1px solid rgba(239,68,68,0.35)',
  color: '#ffd2d2',
  fontSize: 13,
  maxWidth: 480,
  lineHeight: 1.4,
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
