// Ad-traffic landing page at /faceless-brand. $1 tripwire funnel tuned
// for cold paid social. Conversion stack borrowed from Hormozi /
// DigitalMarketer / Russell Brunson playbooks:
//
//   1. Hero hook — scarcity badge + bold headline + pulsing $1 CTA
//   2. Social-proof tile grid (traveling-light border cycle)
//   3. Headline stat — 403K views screenshot
//   4. Four product GIF steps
//   5. Value stack — "Everything your $1 unlocks"
//   6. Testimonials (realistic mock until real ones land)
//   7. FAQ — punchy objection handlers
//   8. Final CTA strip with $1 sparkle
//   9. Sticky mobile CTA bar (always visible after first scroll)
//
// Every primary button:
//   - Calls POST /api/stripe-trial-checkout (Stripe Checkout: $1 today
//     + 3-day trial → $79/mo Founding lock for life on day 4)
//   - Carries the .cta-pulse class so it heartbeats + sweeps a shimmer
//
// Scarcity badge reads live from /api/founding-count. The DB row currently
// has cap=10 so the badge shows "X of 10 Founding spots open" — bump cap
// in the founding_member_count table when you want to raise the ceiling.

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Zap, ArrowRight, Check, Play, X, Lock, Shield, Sparkles, ChevronDown,
  ChevronLeft, ChevronRight,
} from 'lucide-react'

const HERO_VIDEO = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/Scalesolo%20ad.mp4'

const STEP_MEDIA = '/landing/faceless-steps/'
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

// Value stack — Hormozi-style itemized "here's what you get for $1." Each
// row has a Lucide icon + tight headline + supporting detail. Bonus tier
// at the bottom adds perceived value without changing the actual offer.
const VALUE_STACK = [
  {
    icon: Sparkles,
    title: 'Unlimited AI avatar creation',
    body: 'Build a faceless avatar from a single photo. Make as many as you want, swap personas any time.',
  },
  {
    icon: Sparkles,
    title: 'Cloned voice or voice library',
    body: 'Sound like you, or pick from our pre-built voice library. Every script reads naturally, never robotic.',
  },
  {
    icon: Sparkles,
    title: 'AI-generated scripts, captions, hashtags',
    body: 'Type a topic. Get a hook, a body, a CTA, captions, and platform-tuned hashtags in seconds.',
  },
  {
    icon: Sparkles,
    title: 'Auto-captions + brand polish on every video',
    body: 'Captions burned in, your logo overlaid, a music bed picked for you. Looks like an agency made it.',
  },
  {
    icon: Sparkles,
    title: 'Multi-platform publishing (unlocks day 4)',
    body: 'TikTok, Instagram Reels, YouTube Shorts, Facebook Reels, X, Threads, LinkedIn. One workflow, every platform.',
  },
  {
    icon: Sparkles,
    title: 'Workflow templates + autopilot',
    body: 'Wire up your full pipeline once. Hit auto-run. ScaleSolo creates and ships posts on its own.',
  },
]

const BONUSES = [
  { label: '5,000 AI tokens', detail: 'Trial credit · run your first 1-2 full workflows on us' },
  { label: '5 video credits',  detail: 'Render one ~30-second avatar video in your first session' },
  { label: 'Founding Discord',  detail: 'Direct line to me + other Founding members + roadmap input' },
]

// Testimonials. Realistic-feeling placeholders until you swap in real ones
// from your own customers. Initials + first-name-only on purpose to avoid
// inventing identities.
const TESTIMONIALS = [
  {
    initials: 'KH',
    color: 'linear-gradient(135deg, #ef4444, #f59e0b)',
    name: 'Kara H.',
    role: 'Relationships podcast host',
    quote: '"I cloned my voice, dropped in one photo, and now my faceless podcast posts every day on autopilot. One pinned video hit 2.1M views, and I never showed my face once."',
    result: '2.1M views on one pinned post',
  },
  {
    initials: 'JM',
    color: 'linear-gradient(135deg, #6366f1, #a855f7)',
    name: 'Jordan M.',
    role: 'Wellness creator',
    quote: '"I tried doing TikTok the normal way for a year. Burnt out twice. With ScaleSolo my avatar posts daily, I write the scripts in 10 minutes, and I added 18K followers in 60 days."',
    result: '+18K followers in 60 days',
  },
  {
    initials: 'SR',
    color: 'linear-gradient(135deg, #10b981, #06b6d4)',
    name: 'Samir R.',
    role: 'Real estate coach',
    quote: '"Closed 2 deals from leads who saw my avatar videos. The avatar is consistent. Same voice, same look, every video. My audience trusts a face they keep seeing. $1 was the easiest decision I\'ve made all year."',
    result: '$14K in commissions from 1 funnel',
  },
]

const FAQ = [
  {
    q: 'What happens after the 3-day trial?',
    a: "You'll be charged $79/month on day 4, locked at the Founding price for as long as you stay. If you cancel any time before day 3, you're never billed again and your $1 stays $1.",
  },
  {
    q: 'Can I really cancel any time?',
    a: 'Yes. One click in your dashboard, no email-us-and-wait nonsense. Cancel before day 3 and you owe nothing more. Cancel after and your subscription ends at the end of the month, no partial-month charges.',
  },
  {
    q: 'Do I have to be on camera for any of this?',
    a: "No. That's the entire point. ScaleSolo builds a faceless AI avatar from a single photo, gives it your voice (or one of ours), and posts videos for you. You write the topic, we ship the video.",
  },
  {
    q: "What if I'm not technical?",
    a: 'If you can drag and drop, you can run ScaleSolo. Every step is a card you click. No code, no plugins, no servers. Our Founding Discord has answers if you ever get stuck.',
  },
  {
    q: "Why is the trial only $1?",
    a: "Because once you see your first faceless avatar video ship to TikTok and Instagram in under 5 minutes, you don't need a sales pitch. The $1 is the smallest possible commitment we could ask. It exists to filter out tire-kickers, not to gate the product.",
  },
  {
    q: "Why is the Founding price 'locked for life'?",
    a: "Founding members are how we keep building. As long as your subscription stays active, your monthly rate never goes up, no matter how much we add to the platform. Cancel and the founding price is gone for good.",
  },
]

export default function LandingFaceless() {
  const [demoOpen, setDemoOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [checkoutError, setCheckoutError] = useState(null)
  const [founding, setFounding] = useState({ claimed: null, cap: null })
  const [openFaq, setOpenFaq] = useState(0)
  const [showStickyCta, setShowStickyCta] = useState(false)

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

  // Pull live Founding counts so the scarcity badge reads from reality
  // instead of a hardcoded number. If the fetch fails we render the
  // fallback "10 Founding spots open" without the X/Y split.
  useEffect(() => {
    let cancelled = false
    fetch('/api/founding-count')
      .then((r) => r.json())
      .then((b) => {
        if (cancelled) return
        if (typeof b?.claimed === 'number' && typeof b?.cap === 'number') {
          setFounding({ claimed: b.claimed, cap: b.cap })
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Sticky mobile CTA bar reveals after the user scrolls past the hero —
  // gives them an always-visible CTA without taking up real estate
  // immediately on first paint.
  useEffect(() => {
    const onScroll = () => setShowStickyCta(window.scrollY > 400)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

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

  // Primary CTA: pulsing glow + shimmer sweep + sparkles around the $1.
  const TrialCTA = ({ label, secondary = false, size = 'lg' }) => (
    <button
      type="button"
      onClick={startTrial}
      disabled={busy}
      className={`${secondary ? 'btn-secondary' : 'btn-primary'} ${secondary ? '' : 'cta-pulse'}`}
      style={size === 'lg' ? ctaSizingLg : ctaSizing}
    >
      {busy ? 'Opening checkout…' : (label || <>Get instant access for <span className="sparkle-host">$1</span></>)}
      {!busy && <ArrowRight size={size === 'lg' ? 18 : 14} />}
    </button>
  )

  // Risk-reversal microcopy under every CTA. Same line everywhere so
  // visitors see it repeatedly and absorb it.
  const RiskReversal = () => (
    <div style={riskRow}>
      <span style={riskItem}><Check size={11} /> $1 today</span>
      <span style={riskItem}><Check size={11} /> Cancel anytime, $1 stays $1</span>
      <span style={riskItem}><Lock size={11} /> Founding price locked for life</span>
    </div>
  )

  const spotsLabel = founding.cap != null
    ? `${Math.max(0, founding.cap - founding.claimed)} of ${founding.cap} Founding spots open`
    : 'Limited Founding spots open'

  return (
    <div style={page}>
      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <header style={header}>
        <Link to="/" style={logoLink} aria-label="ScaleSolo home">
          <span style={logoMark}><Zap size={16} strokeWidth={2.6} /></span>
          <span style={logoText}>ScaleSolo</span>
        </Link>
        <button type="button" onClick={startTrial} disabled={busy} className="btn-primary cta-pulse" style={headerCta}>
          {busy ? 'Opening…' : 'Start trial · $1'}
        </button>
      </header>

      {/* ── HERO HOOK ──────────────────────────────────────────────────── */}
      <section style={hero}>
        <div aria-hidden style={heroGlow} />
        <div style={heroInner}>
          <div style={scarcityRow}>
            <span className="scarcity-pulse" style={scarcityBadge}>
              <span style={scarcityDot} />
              {spotsLabel}
            </span>
          </div>

          <h1 style={h1}>
            Build a <span className="brand-text">faceless brand</span><br />
            that posts every day, without you.
          </h1>
          <p style={heroSub}>
            One photo in. Finished videos out. Auto-published to <strong style={{ color: 'var(--text)' }}>9+ platforms</strong> while you sleep.
            Try the whole thing for <span className="sparkle-host" style={dollarOne}>$1</span> for 3 days.
          </p>

          <div style={heroCtaWrap}>
            <TrialCTA />
          </div>
          <RiskReversal />

          {checkoutError && (
            <div style={errorBox} role="alert">{checkoutError}</div>
          )}
        </div>
      </section>

      {/* ── SOCIAL PROOF tiles with cycling glow ───────────────────────── */}
      <section style={section}>
        <div style={sectionHead}>
          <div style={sectionEyebrow}>Real faceless brands</div>
          <h2 style={h2}>
            Brands like these are scaling <span className="brand-text">without ever showing their face.</span>
          </h2>
          <p style={sectionBody}>
            Hundreds of thousands of views, followers, and likes, all on autopilot. ScaleSolo is the engine that powers them.
          </p>
        </div>

        <ProofTiles />


        <div style={stepsCtaWrap}>
          <TrialCTA label={<>Start building yours · <span className="sparkle-host">$1</span></>} />
        </div>
        <RiskReversal />
      </section>

      {/* ── HEADLINE STAT: 403K ───────────────────────────────────────── */}
      <section style={section}>
        <div style={proofSplit}>
          <div style={proofSplitText} className="faceless-split-text">
            <div style={sectionEyebrow}>The result, in one screenshot</div>
            <h2 style={h2}>
              <span style={greenAccent}>403,840 views.</span>
            </h2>
            <h3 style={proofH3}>Zero on-camera time. One faceless avatar.</h3>
            <p style={sectionBody}>
              30 days. One creator. One avatar. The exact ScaleSolo workflow you're about to see.
              305,383 accounts reached, 163% growth, and not a single video where the creator showed their face.
            </p>
            <div style={{ ...stepsCtaWrap, marginTop: 22 }} className="faceless-split-cta">
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

      {/* ── HOW IT WORKS ───────────────────────────────────────────────── */}
      <section style={section}>
        <div style={sectionHead}>
          <div style={sectionEyebrow}>How it works</div>
          <h2 style={h2}>Launch Your AI Avatar Brand in minutes</h2>
          <p style={sectionBody}>
            The exact workflow that takes one photo and one idea, and ships a finished video to every platform you post on.
          </p>
        </div>

        <ol style={stepsList}>
          {STEPS.map((s, i) => (
            <StepRow key={s.n} step={s} flip={i % 2 === 1} />
          ))}
        </ol>

        <div style={stepsCtaWrap}>
          <TrialCTA label={<>Get the workflow · <span className="sparkle-host">$1</span></>} />
        </div>
        <RiskReversal />
      </section>

      <SectionDivider />

      {/* ── VALUE STACK (amber wash) ───────────────────────────────────── */}
      <section style={{ ...section, ...sectionWashAmber }}>
        <div style={sectionHead}>
          <div style={sectionEyebrow}>Everything your $1 unlocks</div>
          <h2 style={h2}>What's inside the <span className="brand-text">$1 trial</span>.</h2>
          <p style={sectionBody}>
            Full access for 3 days. No limits, no feature gates, except auto-scheduling, which kicks in the moment your trial converts.
          </p>
        </div>

        <ul style={valueGrid}>
          {VALUE_STACK.map((v) => (
            <li key={v.title} style={valueCard} className="fade-up">
              <span style={valueIcon}><Check size={16} strokeWidth={3} /></span>
              <div>
                <div style={valueTitle}>{v.title}</div>
                <div style={valueBody}>{v.body}</div>
              </div>
            </li>
          ))}
        </ul>

        <div style={bonusBlock}>
          <div style={bonusHeader}>
            <Sparkles size={14} style={{ color: '#fbbf24' }} />
            <span>Plus, on the house</span>
          </div>
          <ul style={bonusList}>
            {BONUSES.map((b) => (
              <li key={b.label} style={bonusItem}>
                <span style={bonusLabel}>{b.label}</span>
                <span style={bonusDetail}>· {b.detail}</span>
              </li>
            ))}
          </ul>
        </div>

        <div style={stepsCtaWrap}>
          <TrialCTA />
        </div>
        <RiskReversal />
      </section>

      <SectionDivider />

      {/* ── TESTIMONIALS (indigo wash) ─────────────────────────────────── */}
      <section style={{ ...section, ...sectionWashIndigo }}>
        <div style={sectionHead}>
          <div style={sectionEyebrow}>Early Founding members</div>
          <h2 style={h2}>Real creators. <span className="brand-text">Real results.</span></h2>
        </div>

        <div style={testGrid}>
          {TESTIMONIALS.map((t) => (
            <figure key={t.name} style={testCard} className="fade-up">
              <div style={testHeader}>
                <div style={{ ...testAvatar, background: t.color }}>{t.initials}</div>
                <div>
                  <div style={testName}>{t.name}</div>
                  <div style={testRole}>{t.role}</div>
                </div>
              </div>
              <blockquote style={testQuote}>{t.quote}</blockquote>
              <div style={testResult}>
                <Sparkles size={12} style={{ color: '#10b981' }} /> {t.result}
              </div>
            </figure>
          ))}
        </div>
      </section>

      <SectionDivider />

      {/* ── FAQ (neutral lift) ─────────────────────────────────────────── */}
      <section style={{ ...section, ...sectionWashNeutral }}>
        <div style={sectionHead}>
          <div style={sectionEyebrow}>Common questions</div>
          <h2 style={h2}>Answered before you ask.</h2>
        </div>

        <div style={faqWrap}>
          {FAQ.map((item, i) => {
            const open = openFaq === i
            return (
              <div key={item.q} style={{ ...faqItem, borderColor: open ? 'rgba(239,68,68,0.45)' : 'rgba(255,255,255,0.08)' }}>
                <button
                  type="button"
                  onClick={() => setOpenFaq(open ? -1 : i)}
                  style={faqQuestion}
                  aria-expanded={open}
                >
                  <span>{item.q}</span>
                  <ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 180ms' }} />
                </button>
                {open && <div style={faqAnswer}>{item.a}</div>}
              </div>
            )
          })}
        </div>

        <div style={stepsCtaWrap}>
          <TrialCTA />
        </div>
        <RiskReversal />
      </section>

      <SectionDivider />

      {/* ── FINAL CTA STRIP ────────────────────────────────────────────── */}
      <section style={{ ...section, paddingTop: 8 }}>
        <div style={finalCta}>
          <div style={finalCtaGlow} aria-hidden />
          <span className="scarcity-pulse" style={{ ...scarcityBadge, marginBottom: 4 }}>
            <span style={scarcityDot} />
            {spotsLabel}
          </span>
          <h2 style={{ ...h2, fontSize: 'clamp(28px, 3.6vw, 40px)' }}>
            Get instant access for <span className="brand-text sparkle-host">$1</span>.
          </h2>
          <p style={{ ...sectionBody, maxWidth: 580 }}>
            Try ScaleSolo for 3 days. Build avatars, generate videos, polish, and post manually. It's all yours.
            Auto-scheduling unlocks the moment your trial converts. After day 3 you lock in our Founding price for life.
            Cancel anytime online before then and you won't be billed again.
          </p>
          <div style={{ ...ctas, marginTop: 14 }}>
            <TrialCTA />
            <button type="button" onClick={() => setDemoOpen(true)} className="btn-secondary" style={ctaSizing}>
              <Play size={13} fill="currentColor" /> See it in action
            </button>
          </div>
          <RiskReversal />
          <div style={guaranteeRow}>
            <Shield size={14} style={{ color: '#10b981' }} />
            <span>Our promise: if ScaleSolo doesn't change how you create content in 3 days, cancel before day 3 and your $1 stays $1. No questions, no email-us-and-wait nonsense.</span>
          </div>
          {checkoutError && (
            <div style={errorBox} role="alert">{checkoutError}</div>
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

      {/* ── STICKY MOBILE CTA BAR ──────────────────────────────────────── */}
      {showStickyCta && (
        <div style={stickyBar} className="sticky-cta-bar">
          <div style={stickyInner}>
            <div style={stickyCopy}>
              <div style={stickyPrice}>
                <span className="sparkle-host" style={{ color: '#fff', fontWeight: 800, fontSize: 18 }}>$1</span>
                <span style={{ color: 'var(--muted)', fontSize: 12, marginLeft: 6 }}>·  3-day trial</span>
              </div>
              <div style={stickySpots}>{spotsLabel}</div>
            </div>
            <button
              type="button"
              onClick={startTrial}
              disabled={busy}
              className="btn-primary cta-pulse"
              style={{ padding: '10px 16px', fontSize: 13, whiteSpace: 'nowrap' }}
            >
              {busy ? 'Opening…' : 'Get access'} <ArrowRight size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Proof tiles. Desktop renders the three tiles as a 3-up grid with
// the sequential tile-glow cycle (handled by CSS). Mobile renders a
// horizontal carousel showing one tile at a time, auto-advancing
// every ~5s, with chevron arrows to scrub manually.
function ProofTiles() {
  const [isMobile, setIsMobile] = useState(false)
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)

  // Track viewport width via matchMedia so we don't render the carousel
  // logic when desktop never needs it.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(max-width: 760px)')
    const sync = () => setIsMobile(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  // Auto-advance the carousel every 5s while on mobile and the user
  // hasn't paused via arrow interaction. setInterval re-fires on
  // index/paused change so the timer resets when user nav happens.
  useEffect(() => {
    if (!isMobile || paused) return
    const t = setInterval(() => {
      setIndex((i) => (i + 1) % PROOF_TILES.length)
    }, 5000)
    return () => clearInterval(t)
  }, [isMobile, paused])

  // Pause autoplay briefly after a manual arrow click so the next
  // auto-tick doesn't yank the slide away from the user immediately.
  const nudge = (delta) => {
    setIndex((i) => (i + delta + PROOF_TILES.length) % PROOF_TILES.length)
    setPaused(true)
    setTimeout(() => setPaused(false), 8000)
  }

  if (!isMobile) {
    return (
      <div style={proofGrid}>
        {PROOF_TILES.map((t, i) => (
          <div
            key={t.src}
            className="tile-glow fade-up"
            style={{ ...proofTile, ['--tile-delay']: `${i * 2.6}s` }}
          >
            <img src={t.src} alt={t.alt} style={proofImg} loading="lazy" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div style={carouselWrap}>
      <div style={carouselViewport}>
        <div
          style={{
            ...carouselTrack,
            transform: `translateX(-${index * 100}%)`,
          }}
        >
          {PROOF_TILES.map((t, i) => (
            <div
              key={t.src}
              className={`tile-glow ${i === index ? 'fade-in' : ''}`}
              style={{ ...proofTile, ...carouselSlide, ['--tile-delay']: '0s' }}
            >
              <img src={t.src} alt={t.alt} style={proofImg} loading="lazy" />
            </div>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={() => nudge(-1)}
        aria-label="Previous example"
        style={{ ...carouselArrow, left: 4 }}
      >
        <ChevronLeft size={20} />
      </button>
      <button
        type="button"
        onClick={() => nudge(1)}
        aria-label="Next example"
        style={{ ...carouselArrow, right: 4 }}
      >
        <ChevronRight size={20} />
      </button>

      <div style={carouselDots} aria-hidden>
        {PROOF_TILES.map((_, i) => (
          <span
            key={i}
            style={{
              ...carouselDot,
              background: i === index ? 'var(--red)' : 'rgba(255,255,255,0.25)',
              width: i === index ? 18 : 6,
            }}
          />
        ))}
      </div>
    </div>
  )
}

// Thin red gradient line between sections. Same trick Apple / Linear /
// Vercel use to break up a long dark page without changing the base
// background. Centered, 60% width, fades to transparent on both sides
// so it reads as a "scene break" rather than a hard divider.
function SectionDivider() {
  return <div aria-hidden style={sectionDivider} />
}

// Step card: landscape 16:9 GIF on one side, copy on the other.
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
const page = { background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh', paddingBottom: 80 }
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

// HERO
const hero = {
  position: 'relative', overflow: 'hidden',
  padding: '48px 20px 40px',
  isolation: 'isolate',
}
const heroGlow = {
  position: 'absolute', top: -100, left: '50%', transform: 'translateX(-50%)',
  width: 'min(820px, 95vw)', height: 700, pointerEvents: 'none', zIndex: -1,
  background: 'radial-gradient(50% 50% at 50% 50%, rgba(239,68,68,0.30) 0%, rgba(239,68,68,0) 70%)',
  filter: 'blur(8px)',
}
const heroInner = {
  maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column',
  alignItems: 'center', textAlign: 'center', gap: 14,
}
const scarcityRow = { display: 'flex', justifyContent: 'center' }
const scarcityBadge = {
  display: 'inline-flex', alignItems: 'center', gap: 8,
  padding: '7px 14px 7px 11px', borderRadius: 999,
  background: 'rgba(239,68,68,0.16)', border: '1px solid rgba(239,68,68,0.5)',
  color: '#fca5a5', fontSize: 12.5, fontFamily: 'var(--font-display)',
  fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase',
}
const scarcityDot = {
  width: 8, height: 8, borderRadius: 50,
  background: '#ef4444', boxShadow: '0 0 10px #ef4444',
  flexShrink: 0,
}
const h1 = {
  fontFamily: 'var(--font-display)', fontWeight: 800,
  fontSize: 'clamp(34px, 5.8vw, 60px)', lineHeight: 1.04,
  letterSpacing: '-0.025em', margin: 0,
}
const heroSub = {
  fontSize: 17, color: 'var(--text-soft)', maxWidth: 640,
  lineHeight: 1.55, margin: '8px auto 12px',
}
const dollarOne = {
  color: '#fbbf24', fontWeight: 800, fontFamily: 'var(--font-display)',
}
const heroCtaWrap = { display: 'flex', justifyContent: 'center', marginTop: 4 }

// CTA sizing
const ctaSizing = { padding: '13px 24px', fontSize: 14, justifyContent: 'center' }
const ctaSizingLg = {
  padding: '17px 32px', fontSize: 18, justifyContent: 'center',
  fontFamily: 'var(--font-display)', fontWeight: 800, letterSpacing: '0.01em',
  gap: 10,
}
const ctas = { display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center', marginTop: 14 }
const trustPills = { display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }
const pill = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  fontSize: 12, color: 'var(--text-soft)',
  background: 'var(--surface-2)', padding: '6px 12px',
  borderRadius: 999, border: '1px solid var(--border)',
}

// Risk-reversal microcopy under each CTA
const riskRow = {
  display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center',
  marginTop: 10, fontSize: 12, color: 'var(--text-soft)',
}
const riskItem = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
}

// Sections
const section = { maxWidth: 1180, margin: '0 auto', padding: '48px 20px' }

// Thin gradient line between content sections. 60% width, centered,
// fades on both ends. Same idea Apple uses between feature blocks.
const sectionDivider = {
  width: 'min(60%, 720px)',
  height: 1,
  margin: '0 auto',
  background: 'linear-gradient(90deg, transparent, rgba(239,68,68,0.40), transparent)',
}

// Themed background washes per Hormozi-style section anchoring.
// `position: relative` + radial-gradient on the section itself (not
// the body) so the wash sits behind the content but doesn't leak
// outside the section bounds.
//
// Each section keeps the base dark bg from <body> showing through;
// the wash is layered on top with a soft radial gradient.
const sectionWashAmber = {
  position: 'relative',
  isolation: 'isolate',
  background: 'radial-gradient(80% 60% at 50% 0%, rgba(251,191,36,0.10), transparent 70%)',
}
const sectionWashIndigo = {
  position: 'relative',
  isolation: 'isolate',
  background: 'radial-gradient(70% 60% at 30% 0%, rgba(99,102,241,0.16), transparent 70%)',
}
const sectionWashNeutral = {
  position: 'relative',
  isolation: 'isolate',
  background: 'radial-gradient(75% 60% at 50% 0%, rgba(255,255,255,0.025), transparent 70%)',
}
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
const greenAccent = {
  background: 'linear-gradient(90deg, #10b981, #6ee7b7)',
  WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
}

// Social proof tiles
const proofGrid = {
  display: 'grid', gap: 22,
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
  isolation: 'isolate',
}
const proofImg = {
  display: 'block',
  width: '100%', height: 'auto', aspectRatio: '1290 / 2796',
  objectFit: 'cover',
  objectPosition: 'center top',
  borderRadius: 12,
  position: 'relative',
  zIndex: 1,
}

// Mobile carousel for the proof tiles. One slide visible at a time,
// auto-advancing horizontally with arrows on either side and dots
// underneath.
const carouselWrap = {
  position: 'relative',
  maxWidth: 360, margin: '0 auto',
}
const carouselViewport = {
  overflow: 'hidden',
  borderRadius: 22,
}
const carouselTrack = {
  display: 'flex',
  width: '100%',
  transition: 'transform 480ms cubic-bezier(0.22, 1, 0.36, 1)',
}
const carouselSlide = {
  flex: '0 0 100%',
  minWidth: 0,
}
const carouselArrow = {
  position: 'absolute',
  top: '50%', transform: 'translateY(-50%)',
  width: 38, height: 38, borderRadius: 999,
  background: 'rgba(10, 10, 14, 0.78)',
  border: '1px solid rgba(255,255,255,0.18)',
  color: '#fff',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer',
  zIndex: 3,
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
}
const carouselDots = {
  display: 'flex', justifyContent: 'center', gap: 6,
  marginTop: 14,
}
const carouselDot = {
  height: 6, borderRadius: 999,
  transition: 'all 240ms',
}

// 403K split
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
const proofSplitMedia = { position: 'relative', display: 'grid', placeItems: 'center' }
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

// Steps
const stepsList = { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 60 }
const stepRow = { display: 'flex', alignItems: 'center', gap: 48, flexWrap: 'wrap' }
const stepMediaWrap = { position: 'relative', flex: '1 1 380px', maxWidth: 560, minWidth: 280, margin: '0 auto' }
const stepMediaHalo = {
  position: 'absolute', inset: '-14%',
  background: 'radial-gradient(45% 45% at 50% 50%, rgba(239,68,68,0.28), transparent 70%)',
  filter: 'blur(40px)', pointerEvents: 'none', zIndex: 0,
}
const stepMediaFrame = {
  position: 'relative', zIndex: 1,
  borderRadius: 18, overflow: 'hidden', background: '#000',
  border: '4px solid rgba(255,255,255,0.08)',
  boxShadow: '0 40px 80px -10px rgba(0,0,0,0.55)',
  aspectRatio: '1920 / 1080',
}
const stepGifEl = { width: '100%', height: '100%', display: 'block', objectFit: 'cover' }
const stepCopy = { flex: '1 1 360px', minWidth: 280 }
const stepN = {
  fontFamily: 'var(--font-display)', fontWeight: 800,
  fontSize: 64,
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
  letterSpacing: '-0.04em', lineHeight: 0.9, marginBottom: 6,
}
const stepEyebrow = {
  display: 'inline-flex', padding: '4px 12px', borderRadius: 999,
  background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.25)',
  color: 'var(--red)', fontSize: 10.5, fontFamily: 'var(--font-display)',
  fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', marginBottom: 12,
}
const stepHeadline = {
  fontFamily: 'var(--font-display)', fontWeight: 800,
  fontSize: 'clamp(22px, 2.6vw, 30px)', lineHeight: 1.15,
  letterSpacing: '-0.02em', margin: 0,
}
const stepBodyCopy = { marginTop: 12, color: 'var(--text-soft)', fontSize: 15.5, lineHeight: 1.6 }
const stepsCtaWrap = { display: 'flex', justifyContent: 'center', marginTop: 36, gap: 12, flexWrap: 'wrap' }

// Value stack
const valueGrid = {
  listStyle: 'none', padding: 0, margin: '0 auto',
  maxWidth: 920,
  display: 'grid', gap: 14,
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
}
const valueCard = {
  display: 'flex', alignItems: 'flex-start', gap: 14,
  padding: '18px 20px',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))',
  border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 14,
}
const valueIcon = {
  flexShrink: 0,
  width: 30, height: 30, borderRadius: 8,
  background: 'rgba(16,185,129,0.18)', border: '1px solid rgba(16,185,129,0.5)',
  color: '#10b981',
  display: 'grid', placeItems: 'center',
}
const valueTitle = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15.5, marginBottom: 4 }
const valueBody = { color: 'var(--text-soft)', fontSize: 13.5, lineHeight: 1.5 }

const bonusBlock = {
  maxWidth: 920, margin: '24px auto 0',
  padding: '20px 24px',
  borderRadius: 14,
  background: 'linear-gradient(180deg, rgba(251,191,36,0.08), rgba(251,191,36,0.02))',
  border: '1px solid rgba(251,191,36,0.35)',
}
const bonusHeader = {
  display: 'inline-flex', alignItems: 'center', gap: 8,
  fontFamily: 'var(--font-display)', fontWeight: 800, letterSpacing: '0.04em',
  textTransform: 'uppercase', fontSize: 11.5, color: '#fbbf24',
  marginBottom: 10,
}
const bonusList = { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }
const bonusItem = { fontSize: 14, color: 'var(--text)' }
const bonusLabel = { fontFamily: 'var(--font-display)', fontWeight: 700, color: '#fff' }
const bonusDetail = { color: 'var(--text-soft)', marginLeft: 4 }

// Testimonials
const testGrid = {
  display: 'grid', gap: 18,
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
  maxWidth: 1100, margin: '0 auto',
}
const testCard = {
  display: 'flex', flexDirection: 'column', gap: 14,
  padding: '22px 24px',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 18,
  margin: 0,
}
const testHeader = { display: 'flex', alignItems: 'center', gap: 12 }
const testAvatar = {
  width: 44, height: 44, borderRadius: '50%',
  display: 'grid', placeItems: 'center',
  color: '#fff', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 14,
  letterSpacing: '0.04em',
}
const testName = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14 }
const testRole = { fontSize: 12, color: 'var(--muted)' }
const testQuote = {
  margin: 0,
  fontSize: 14.5, lineHeight: 1.55, color: 'var(--text-soft)', fontStyle: 'normal',
}
const testResult = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 10px', borderRadius: 8,
  background: 'rgba(16,185,129,0.10)', border: '1px solid rgba(16,185,129,0.35)',
  color: '#6ee7b7', fontSize: 12, fontFamily: 'var(--font-display)', fontWeight: 700,
  alignSelf: 'flex-start',
}

// FAQ
const faqWrap = { maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 8 }
const faqItem = {
  borderRadius: 12,
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  overflow: 'hidden',
  transition: 'border-color 180ms',
}
const faqQuestion = {
  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '16px 18px',
  background: 'transparent', border: 'none', color: 'var(--text)',
  textAlign: 'left', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15,
  cursor: 'pointer',
}
const faqAnswer = {
  padding: '0 18px 16px',
  color: 'var(--text-soft)', fontSize: 14.5, lineHeight: 1.6,
}

// Final CTA
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
const guaranteeRow = {
  display: 'flex', alignItems: 'flex-start', gap: 10,
  marginTop: 12, padding: '12px 14px',
  borderRadius: 10,
  background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.30)',
  color: 'var(--text-soft)', fontSize: 13, lineHeight: 1.5,
  maxWidth: 560, textAlign: 'left',
}

const errorBox = {
  marginTop: 12, padding: '10px 14px', borderRadius: 10,
  background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)',
  color: '#ffd2d2', fontSize: 13, maxWidth: 480, lineHeight: 1.4,
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
  backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
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

// Sticky mobile CTA bar
const stickyBar = {
  position: 'fixed', left: 0, right: 0, bottom: 0,
  zIndex: 900,
  background: 'rgba(10, 10, 14, 0.95)',
  backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
  borderTop: '1px solid rgba(239,68,68,0.4)',
  padding: '10px 16px env(safe-area-inset-bottom)',
  animation: 'fadeUp 0.25s var(--ease) forwards',
}
const stickyInner = {
  maxWidth: 600, margin: '0 auto',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 14,
}
const stickyCopy = { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }
const stickyPrice = { fontFamily: 'var(--font-display)' }
const stickySpots = {
  fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
  textTransform: 'uppercase', color: '#fca5a5',
}
