// Ad-traffic landing page at /faceless-brand. Single-promise funnel:
//   hero → demo video → 4 numbered steps → stats bar → founding pricing.
//
// No top nav (logo only) so visitors can't bounce off into the broader
// feature tour. Footer is legal-only. Every CTA scrolls to the
// founding pricing block at the bottom; from there they hit Stripe
// Checkout. Single path: ad → page → pay → signup.

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Zap, ArrowRight, Check, Play, Volume2, VolumeX, X,
  Camera, Wand2, Mic2, Sparkles,
} from 'lucide-react'
import PricingPlans from '../components/PricingPlans.jsx'

// Shared hero video URL — same one the main / landing uses.
const HERO_VIDEO = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/Scalesolo%20ad.mp4'

export default function LandingFaceless() {
  const [heroMuted, setHeroMuted] = useState(true)
  const [demoOpen, setDemoOpen] = useState(false)
  // Defer hero video mount past first paint so the smoke test (and
  // slow networks) don't hang on the metadata fetch. Same trick the
  // main / landing uses.
  const [showHeroVideo, setShowHeroVideo] = useState(false)
  useEffect(() => {
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(() => setShowHeroVideo(true), { timeout: 500 })
      : window.requestAnimationFrame(() => setShowHeroVideo(true))
    return () => {
      if (window.cancelIdleCallback && window.requestIdleCallback) window.cancelIdleCallback(idle)
      else window.cancelAnimationFrame(idle)
    }
  }, [])

  // Esc closes the demo lightbox + lock body scroll while open.
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

  return (
    <div style={page}>
      {/* ── MINIMAL HEADER: logo only ─────────────────────────────────── */}
      <header style={header}>
        <Link to="/" style={logoLink} aria-label="ScaleSolo home">
          <span style={logoMark}><Zap size={16} strokeWidth={2.6} /></span>
          <span style={logoText}>ScaleSolo</span>
        </Link>
      </header>

      {/* ── HERO ──────────────────────────────────────────────────────── */}
      <section style={hero}>
        <div aria-hidden style={heroGlowOuter} />
        <div aria-hidden style={heroGlowInner} />

        <div style={heroInner}>
          <span style={eyebrow}>For creators going faceless</span>
          <h1 style={h1}>
            Build a <span className="brand-text">faceless brand</span> that posts every day without you.
          </h1>
          <p style={sub}>
            No camera. No editor. No daily grind. Upload a photo, clone your voice, hit run.
            ScaleSolo turns a single script into a finished avatar video and auto-schedules it
            across every platform.
          </p>

          {/* Hero video (deferred mount past first paint) */}
          <div style={videoWrap} className="fade-up">
            <div aria-hidden style={videoHalo} />
            <div style={videoFrame}>
              {showHeroVideo ? (
                <>
                  <video
                    src={HERO_VIDEO}
                    autoPlay
                    muted={heroMuted}
                    loop
                    playsInline
                    preload="metadata"
                    aria-label="ScaleSolo faceless brand demo"
                    style={videoEl}
                    onError={(e) => { e.currentTarget.style.opacity = '0' }}
                  />
                  <button
                    type="button"
                    onClick={() => setHeroMuted((m) => !m)}
                    aria-label={heroMuted ? 'Unmute' : 'Mute'}
                    style={muteBtn}
                  >
                    {heroMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
                  </button>
                </>
              ) : (
                <div style={{ ...videoEl, background: 'rgba(255,255,255,0.04)' }} />
              )}
            </div>
          </div>

          <div style={ctas}>
            <button onClick={scrollToPricing} className="btn-primary" style={ctaSizing}>
              Claim founding price <ArrowRight size={14} />
            </button>
            <button type="button" onClick={() => setDemoOpen(true)} className="btn-secondary" style={ctaSizing}>
              <Play size={13} fill="currentColor" /> Watch full demo
            </button>
          </div>

          <div style={trustPills}>
            <span style={pill}><Check size={11} /> 3-day trial</span>
            <span style={pill}><Check size={11} /> 5-min setup</span>
            <span style={pill}><Check size={11} /> Cancel anytime</span>
          </div>
        </div>
      </section>

      {/* ── STATS BAR ─────────────────────────────────────────────────── */}
      <section style={section}>
        <div className="stats-grid">
          <Stat number="$250B+" label={<>Creator economy<br />size by 2027</>} />
          <Stat number="10x"     label={<>Your monthly<br />content output</>} />
          <Stat number="30+ hrs" label={<>Saved per brand,<br />every single week</>} />
          <Stat number="9+"      label={<>Platforms publishing<br />on full autopilot</>} />
        </div>
      </section>

      {/* ── HOW IT WORKS ──────────────────────────────────────────────── */}
      <section style={section}>
        <div style={sectionHead}>
          <div style={sectionEyebrow}>How it works</div>
          <h2 style={h2}>Four steps. About five minutes.</h2>
          <p style={sectionBody}>
            The exact workflow our founding members use to launch a faceless brand and run
            it on autopilot.
          </p>
        </div>

        <ol style={stepsList}>
          <Step
            n="01"
            Icon={Camera}
            title="Upload your photo or generate an avatar"
            body="Drop a photo, use a generated AI face, or build a new avatar inside the app. Your persona never has to change between videos."
          />
          <Step
            n="02"
            Icon={Wand2}
            title="Build different Looks"
            body="Save outfits, angles, backgrounds, and moods. ScaleSolo rotates through them so your feed never feels copy-pasted."
          />
          <Step
            n="03"
            Icon={Mic2}
            title="Clone your voice or pick one"
            body="Clone your real voice in seconds, or choose from a built-in library. Every script you write reads in your tone, with your pacing."
          />
          <Step
            n="04"
            Icon={Sparkles}
            title="Run the workflow template"
            body="Pick your avatar, type a topic, hit run. You get a finished video with title overlay, captions, hashtags, music, and a branded cover, auto-scheduled across TikTok, Instagram, YouTube Shorts, Facebook Reels, and Threads."
          />
        </ol>

        <div style={stepsCtaWrap}>
          <button onClick={scrollToPricing} className="btn-primary" style={ctaSizing}>
            Lock in founding price <ArrowRight size={14} />
          </button>
        </div>
      </section>

      {/* ── FOUNDING + PRICING ────────────────────────────────────────── */}
      <section id="pricing" style={{ ...section, paddingTop: 24 }}>
        <div style={sectionHead}>
          <div style={sectionEyebrow}>Founding pricing</div>
          <h2 style={h2}>One-hundred lifetime spots. <span className="brand-text">Never goes up.</span></h2>
          <p style={sectionBody}>
            Lock $79/mo (or $65/mo billed annually) for life. Everything in Solo Pro plus 2× AI
            tokens, 50% more video units, and direct input on the roadmap.
          </p>
        </div>
        <PricingPlans />
      </section>

      {/* ── MINIMAL FOOTER ────────────────────────────────────────────── */}
      <footer style={footer}>
        <div>© {new Date().getFullYear()} ScaleSolo</div>
        <div style={footerLinks}>
          <a href="/privacy" style={footerLink}>Privacy</a>
          <a href="/terms" style={footerLink}>Terms</a>
          <Link to="/login" style={footerLink}>Sign in</Link>
        </div>
      </footer>

      {/* ── DEMO LIGHTBOX ─────────────────────────────────────────────── */}
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

function Step({ n, Icon, title, body }) {
  return (
    <li style={stepCard} className="fade-up">
      <div style={stepNum}>{n}</div>
      <div style={stepIconWrap}><Icon size={20} strokeWidth={2.2} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={stepTitle}>{title}</div>
        <div style={stepBody}>{body}</div>
      </div>
    </li>
  )
}

// ── styles ────────────────────────────────────────────────────────────
const page = { background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh' }
const header = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '20px 24px', borderBottom: '1px solid rgba(255,255,255,0.06)',
}
const logoLink = { display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none', color: 'var(--text)' }
const logoMark = {
  width: 28, height: 28, borderRadius: 8,
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', display: 'grid', placeItems: 'center',
  boxShadow: '0 4px 14px rgba(239,68,68,0.32)',
}
const logoText = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, letterSpacing: '-0.01em' }

const hero = {
  position: 'relative', overflow: 'hidden',
  padding: '56px 20px 64px',
  isolation: 'isolate',
}
const heroGlowOuter = {
  position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)',
  width: 'min(900px, 95vw)', height: 900, pointerEvents: 'none', zIndex: -1,
  background: 'radial-gradient(60% 50% at 50% 30%, rgba(239,68,68,0.32) 0%, rgba(239,68,68,0) 70%)',
  filter: 'blur(8px)',
}
const heroGlowInner = {
  position: 'absolute', top: 80, left: '50%', transform: 'translateX(-50%)',
  width: 'min(560px, 80vw)', height: 480, pointerEvents: 'none', zIndex: -1,
  background: 'radial-gradient(40% 50% at 50% 30%, rgba(251,191,36,0.18) 0%, rgba(239,68,68,0) 80%)',
}
const heroInner = {
  maxWidth: 920, margin: '0 auto', display: 'flex', flexDirection: 'column',
  alignItems: 'center', textAlign: 'center', gap: 18,
}
const eyebrow = {
  display: 'inline-flex', alignItems: 'center',
  padding: '5px 12px', borderRadius: 999,
  background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)',
  color: 'var(--red)', fontSize: 11, fontFamily: 'var(--font-display)',
  fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
}
const h1 = {
  fontFamily: 'var(--font-display)', fontWeight: 800,
  fontSize: 'clamp(36px, 6vw, 64px)', lineHeight: 1.04,
  letterSpacing: '-0.025em', margin: 0,
}
const sub = {
  fontSize: 17, color: 'var(--text-soft)', maxWidth: 640,
  lineHeight: 1.55, margin: '4px auto 8px',
}

const videoWrap = { position: 'relative', width: '100%', maxWidth: 820, margin: '8px 0 4px' }
const videoHalo = {
  position: 'absolute', inset: '-22%',
  background: 'conic-gradient(from 0deg, rgba(239,68,68,0) 0%, rgba(239,68,68,0.55) 8%, rgba(255,140,80,0.85) 12%, rgba(239,68,68,0.55) 16%, rgba(239,68,68,0) 24%, rgba(239,68,68,0) 50%, rgba(239,68,68,0.45) 58%, rgba(255,180,120,0.75) 62%, rgba(239,68,68,0.45) 66%, rgba(239,68,68,0) 74%)',
  filter: 'blur(40px)', zIndex: 0,
  animation: 'glowSpin 12s linear infinite',
}
const videoFrame = {
  position: 'relative', zIndex: 1,
  borderRadius: 18, overflow: 'hidden',
  background: '#000',
}
const videoEl = {
  width: '100%', height: 'auto', display: 'block',
  filter: 'drop-shadow(0 30px 60px rgba(0,0,0,0.55)) drop-shadow(0 0 40px rgba(239,68,68,0.18))',
  borderRadius: 18,
}
const muteBtn = {
  position: 'absolute', right: 12, bottom: 12,
  width: 44, height: 44, borderRadius: 999,
  background: 'rgba(0, 0, 0, 0.55)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  border: '1px solid rgba(255, 255, 255, 0.18)',
  color: '#fff',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', zIndex: 3,
}
const ctas = { display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center', marginTop: 6 }
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

const stepsList = {
  listStyle: 'none', padding: 0, margin: 0,
  display: 'grid', gap: 14,
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))',
}
const stepCard = {
  display: 'flex', alignItems: 'flex-start', gap: 16,
  padding: '22px 24px',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))',
  border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 16,
  position: 'relative',
}
const stepNum = {
  fontFamily: 'var(--font-display)', fontWeight: 800,
  fontSize: 18,
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  WebkitBackgroundClip: 'text', backgroundClip: 'text',
  color: 'transparent',
  letterSpacing: '-0.02em',
  paddingTop: 2,
}
const stepIconWrap = {
  width: 40, height: 40, borderRadius: 10, flexShrink: 0,
  background: 'rgba(239,68,68,0.12)',
  border: '1px solid rgba(239,68,68,0.32)',
  color: 'var(--red)',
  display: 'grid', placeItems: 'center',
}
const stepTitle = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, marginBottom: 4 }
const stepBody = { color: 'var(--text-soft)', fontSize: 14, lineHeight: 1.5 }
const stepsCtaWrap = { display: 'flex', justifyContent: 'center', marginTop: 28 }

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
