import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Zap, ArrowRight, Check, Sparkles, Boxes, UserCircle2, Calendar,
  Layers, Wand2, RefreshCw, ShieldCheck, Quote, Play,
  Instagram, Youtube, Twitter, Linkedin, Music2, Captions as CaptionsIcon,
} from 'lucide-react'
import PricingPlans from '../components/PricingPlans.jsx'
import WorkflowDemo from '../components/WorkflowDemo.jsx'
import UseCaseGrid from '../components/UseCaseGrid.jsx'

// ─────────────────────────────────────────────────────────────────────
//  Public marketing landing for scalesolo.ai
//
//  Atmospherics:
//    - Rising-flame hero glow (4 stacked radial gradients with two
//      animations: auroraPulse breathing + auroraDrift sway)
//    - Rotating conic-gradient halo around the hero video frame
//      (~12s rotation; subtle but unmistakable)
//    - Floating particle field (12 dots, randomized delays / paths)
//    - Mock canvas section that mimics the in-app Spaces workflow:
//      4 nodes wired with animated SVG connectors (flowing dashes)
//
//  Copy: Option A headline "Set up once. Post forever." + 9-step eyebrow.
//  Vendor names (Claude / HeyGen) removed from user-facing strings.
// ─────────────────────────────────────────────────────────────────────

const HERO_IMAGE = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/dash_landing_1x1.svg'
const FEAT_IMG_BUILD   = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/shared/workflow_landing.mp4'
const FEAT_IMG_RUN     = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/autoscheduling_landing.png'
const FEAT_IMG_AVATAR  = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/shared/avatar_landing_video.mp4'

// Branded platform chips. We render the lucide glyph in each platform's
// brand colour so the trust strip reads as logos, not just labels.
const trustLogos = [
  { name: 'TikTok',    Icon: Music2,    tint: '#fe2c55' },
  { name: 'Instagram', Icon: Instagram, tint: '#e1306c' },
  { name: 'YouTube',   Icon: Youtube,   tint: '#ff0000' },
  { name: 'X',         Icon: Twitter,   tint: '#e7e9ea' },
  { name: 'LinkedIn',  Icon: Linkedin,  tint: '#0a66c2' },
]

const features = [
  {
    icon: Boxes,
    title: 'Visual workflows',
    body: 'Drag, drop, and wire script gen → avatar render → captions → schedule into one auto-running pipeline.',
    img: FEAT_IMG_BUILD,
  },
  {
    icon: UserCircle2,
    title: 'AI avatars that sound like you',
    body: 'Train an AI avatar from one selfie. Cycle outfits across runs so every video looks fresh.',
    img: FEAT_IMG_AVATAR,
  },
  {
    icon: Calendar,
    title: 'Hands-off scheduling',
    body: 'Auto Run fires on your cadence and posts straight to TikTok, Instagram, YouTube, X, and LinkedIn.',
    img: FEAT_IMG_RUN,
  },
]

const valueGrid = [
  { icon: Layers,      title: 'Brand-voice scripts',  body: 'Our AI reads your brand bible + recent posts, drafts ideas in your voice, and dedupes against the last 12+ takes.' },
  { icon: Wand2,       title: 'Title + captions in one call', body: 'Per-platform titles, captions, and hashtags. Schedule node picks the right variant per destination automatically.' },
  { icon: RefreshCw,   title: 'Auto-run forever',     body: 'Pick a cadence , every hour, every day, every week , and the workflow runs without you.' },
  { icon: ShieldCheck, title: 'You own the assets',   body: 'Every render lands in your library. Download originals, repost anywhere, no vendor lock-in.' },
]

const testimonials = [
  { name: 'Jordan M.',  role: 'Course Creator',     quote: 'I used to spend Sundays writing TikToks. Now ScaleSolo posts 5 a week in my voice while I sleep. The cycle-looks feature alone is worth the price.' },
  { name: 'Priya K.',   role: 'Agency Owner',       quote: 'I run 4 brands. The brand-profile system means each client gets their own scripts, voice, and avatars. One workflow per brand and we ship 80 posts a week.' },
  { name: 'Marcus T.',  role: 'Solo Founder',       quote: 'The auto-title + finish-video node saved me from buying CapCut. One paste-in render now produces a finished, captioned, watermarked, scored MP4.' },
  { name: 'Lena R.',    role: 'Lifestyle Creator',  quote: 'I wired in my @brand mention once and the script generator never forgets. Tone is consistent across 3 months of content.' },
  { name: 'Sam D.',     role: 'B2B Marketer',       quote: 'The schedule node + Upload-Post integration replaced two of my tools. Drafts go out at 8am Tuesdays, no babysitting.' },
  { name: 'Aiyana W.',  role: 'Podcast Producer',   quote: 'Audio upload → ElevenLabs transcribe → split → render across looks. We cut 9-clip shorts from 60-second clips in under 4 minutes.' },
]

export default function Landing() {
  const nav = useNavigate()
  const goSignup = () => nav('/login')

  // Persona-driven canvas morphing. When the user clicks a card in
  // <UseCaseGrid />, we (a) scroll back up to the canvas section and
  // (b) hand the persona down to <WorkflowDemo /> which dims the
  // non-relevant nodes and starts an auto-tour of just that path.
  const [activePersona, setActivePersona] = useState(null)
  const canvasRef = useRef(null)
  const handleSelectPersona = (p) => {
    // Toggle off if the same card is clicked twice.
    if (activePersona?.key === p.key) {
      setActivePersona(null)
      return
    }
    setActivePersona(p)
    canvasRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // Lock the public landing to the dark brand palette regardless of any
  // light theme an app user may have persisted. The CSS-var overrides
  // on the page wrapper (see `page` style) take care of everything
  // *inside* the landing , this effect only forces body background +
  // color-scheme dark while mounted so iOS Safari's rubber-band scroll
  // doesn't flash white on overscroll.
  useEffect(() => {
    const html = document.documentElement
    const body = document.body
    const prevColorScheme = html.style.colorScheme
    const prevBodyBg = body.style.background
    html.style.colorScheme = 'dark'
    body.style.background = '#111112'
    return () => {
      html.style.colorScheme = prevColorScheme
      body.style.background = prevBodyBg
    }
  }, [])

  return (
    <div style={page}>
      {/* Floating particle field , sits behind everything, decorative only */}
      <ParticleField />

      {/* ── NAV ─────────────────────────────────────────────────────── */}
      <header style={navBar}>
        <div style={navInner}>
          <div style={brand}>
            <div style={brandIcon}><Zap size={14} fill="#fff" stroke="none" /></div>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16 }}>ScaleSolo</span>
          </div>
          <nav style={navLinks}>
            <a href="#pricing" style={navLink}>Pricing</a>
          </nav>
          <div style={navCta}>
            <button onClick={goSignup} className="btn-ghost" style={{ fontSize: 13 }}>Sign in</button>
            <button onClick={goSignup} className="btn-primary">Start free <ArrowRight size={13} /></button>
          </div>
        </div>
      </header>

      {/* ── HERO ────────────────────────────────────────────────────── */}
      <section style={hero} className="hero-section">
        {/* Rising-flame glow stack , 4 layers, two animations
            so the bloom breathes AND drifts sideways slightly. */}
        <div aria-hidden style={{ ...heroFlameOuter, animation: 'auroraPulse 6.5s var(--ease) infinite, auroraDrift 11s var(--ease) infinite' }} />
        <div aria-hidden style={{ ...heroFlameMid,   animation: 'auroraPulse 5.5s var(--ease) infinite' }} />
        <div aria-hidden style={heroFlameCore} />
        <div aria-hidden style={heroFlameWisp} />

        <div style={heroGrid} className="hero-grid">
          <div style={heroCopy} className="hero-copy">
            <h1 style={{ ...heroH1, textAlign: 'left' }} className="fade-up">
              Set up once.<br /><span className="brand-text">Post forever.</span>
            </h1>
            <p style={{ ...heroSub, margin: '0 0 32px', textAlign: 'left' }} className="fade-up">
              Drop a topic. Pick a proven workflow. Walk away with finished posts, written, rendered, and scheduled to every platform.
            </p>
            <div style={{ ...heroCtas, justifyContent: 'flex-start' }} className="fade-up hero-ctas">
              <button onClick={goSignup} className="btn-primary" style={ctaSizing}>
                Start free <ArrowRight size={14} />
              </button>
              <a href="#canvas" className="btn-secondary" style={ctaSizing}>
                <Play size={13} fill="currentColor" /> See how it works
              </a>
            </div>
            <div style={{ ...trustPills, justifyContent: 'flex-start', marginBottom: 0 }} className="fade-up hero-pills">
              <span style={pill}><Check size={11} /> No credit card required</span>
              <span style={pill}><Check size={11} /> 5-min setup</span>
              <span style={pill}><Check size={11} /> Cancel anytime</span>
            </div>
          </div>

          {/* Hero image with rotating conic-gradient halo */}
          <div style={{ ...shotWrap, marginTop: 0, marginBottom: 0 }} className="fade-up hero-shot">
            <div aria-hidden style={shotUnderGlow} />
            <div style={shotFrame}>
              <div aria-hidden style={{ ...shotHalo, animation: 'glowSpin 12s linear infinite' }} />
              <HeroShot src={HERO_IMAGE} />
            </div>
          </div>
        </div>
      </section>

      {/* ── BRAND PROFILE SHOWCASE ──────────────────────────────────── */}
      <section style={section} className="fade-up">
        <div className="showcase-grid">
          <div className="showcase-img-wrap">
            <img
              src="https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/brand_profile.png"
              alt="ScaleSolo brand profile, voice, training, and performance insights"
              className="showcase-img"
              onError={(e) => { e.currentTarget.style.opacity = '0' }}
            />
          </div>
          <div className="showcase-copy">
            <div className="feat-eyebrow">Brand profiles</div>
            <h2 className="showcase-title">The first platform that actually sounds like you.</h2>
            <p className="showcase-body">
              Bring your own voice or build it here. Paste in the brand-voice profile you already
              use with ChatGPT, Claude, or Gemini, or fill out our guided brief, and ScaleSolo
              uses it to write every caption, script, and hook so the output stays seamless and
              authentic to you.
            </p>
            <ul className="showcase-list">
              <li><Check size={14} /> Import your voice from any AI tool, or build it on ScaleSolo</li>
              <li><Check size={14} /> Studies your past scripts, hooks, and top-performing posts</li>
              <li><Check size={14} /> Learns what lands and what flops to sharpen every run</li>
              <li><Check size={14} /> Run multiple brands side-by-side with no cross-contamination</li>
            </ul>
          </div>
        </div>
      </section>

      {/* ── AVATAR WORKFLOW SHOWCASE ────────────────────────────────── */}
      <section style={section} className="fade-up">
        <div className="showcase-grid">
          <div className="showcase-copy">
            <div className="feat-eyebrow">Realistic avatars</div>
            <h2 className="showcase-title">A studio cast for every brand.</h2>
            <p className="showcase-body">
              Train photorealistic AI avatars for any brand on the platform: founders, spokespeople,
              creators, internal teams. Build a roster of on-brand presenters with consistent looks,
              wardrobes, and delivery, ready to ship video at the volume modern social demands.
            </p>
            <ul className="showcase-list">
              <li><Check size={14} /> Production-grade avatars trained from a single reference</li>
              <li><Check size={14} /> Roster multiple presenters per brand for any campaign</li>
              <li><Check size={14} /> Locked wardrobes and styling so every render stays on-brand</li>
              <li><Check size={14} /> Drop straight into any Spaces workflow</li>
            </ul>
          </div>
          <div className="showcase-img-wrap">
            <img
              src="https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/avatar_landing.png"
              alt="Avatar and look creation in ScaleSolo"
              className="showcase-img"
              onError={(e) => { e.currentTarget.style.opacity = '0' }}
            />
          </div>
        </div>
      </section>

      {/* ── VIDEO FINISHING SHOWCASE ────────────────────────────────── */}
      <section style={section} className="fade-up">
        <div className="showcase-grid">
          <div className="showcase-copy">
            <div className="feat-eyebrow">Video finishing</div>
            <h2 className="showcase-title">Render-ready videos. Zero editor.</h2>
            <p className="showcase-body">
              Captions, titles, overlays, music, and watermarks get baked into every render automatically.
              Pick the look once per brand and ScaleSolo delivers a finished, captioned, scored video on
              every run, no CapCut, no Descript, no manual passes.
            </p>
            <ul className="showcase-list">
              <li><Check size={14} /> Auto-captions with brand-styled fonts and colors</li>
              <li><Check size={14} /> Hook titles, lower-thirds, and overlays per platform</li>
              <li><Check size={14} /> Licensed music and SFX added on the right beat</li>
              <li><Check size={14} /> Brand watermarks locked in so nothing ships off-brand</li>
            </ul>
          </div>
          <div className="showcase-img-wrap">
            <img
              src="https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/captions_landing.png"
              alt="ScaleSolo video finishing: captions, titles, overlays, music, and watermarks"
              className="showcase-img"
              onError={(e) => { e.currentTarget.style.opacity = '0' }}
            />
          </div>
        </div>
      </section>

      {/* ── SCHEDULE-POST FEATURE SHOWCASE ──────────────────────────── */}
      <section style={section} className="fade-up">
        <div className="showcase-grid">
          <div className="showcase-img-wrap">
            <img
              src="https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/schedule_post.png"
              alt="ScaleSolo schedule-post feature"
              className="showcase-img"
              onError={(e) => { e.currentTarget.style.opacity = '0' }}
            />
          </div>
          <div className="showcase-copy">
            <div className="feat-eyebrow">Fully autonomous</div>
            <h2 className="showcase-title">Set it once. Build a brand on autopilot.</h2>
            <p className="showcase-body">
              ScaleSolo is the first platform where the workflow itself does the work. Wire it up
              once with your voice, avatar, cadence, and platforms, then content gets generated,
              rendered, and posted automatically, on schedule, forever. No daily check-ins. No queue refilling.
              No human in the loop.
            </p>
            <ul className="showcase-list">
              <li><Check size={14} /> Hands-off after setup with no daily content management</li>
              <li><Check size={14} /> Auto-generates and ships posts on your set cadence</li>
              <li><Check size={14} /> Native publishing to TikTok, IG, YouTube, X, LinkedIn, Threads, FB</li>
              <li><Check size={14} /> Run brands at scale with every brand on its own autopilot</li>
            </ul>
          </div>
        </div>
      </section>

      {/* Angled gradient separator above features */}
      <div aria-hidden className="feat-separator" />

      {/* ── FEATURES ────────────────────────────────────────────────── */}
      <div className="feat-section">
      <section id="features" style={{ ...section, paddingTop: 20, paddingBottom: 100 }} className="fade-up">
        <h2 style={sectionH}>Everything you need to ship daily</h2>
        <p style={sectionSub}>One workspace for the whole content engine: write, render, schedule, ship.</p>
        <div className="feat-grid">
          <FeatureCard num="1" eyebrow="Realistic avatars" title="Faceless video on autopilot." body="Train an AI avatar from one selfie. Cycle outfits across runs so every render ships looking fresh.">
            <AvatarMock />
          </FeatureCard>
          <FeatureCard num="2" eyebrow="Brand profiles" title="One workspace, many brands." body="Each brand keeps its own voice, cadence, platforms, and avatar. Switch profiles, never cross-pollinate.">
            <BrandProfilesMock />
          </FeatureCard>
          <FeatureCard num="3" eyebrow="Spaces" title="Drag, drop, run forever." body="A visual canvas to wire script → render → schedule. Set it up once, hit run, walk away.">
            <SpacesMock />
          </FeatureCard>
          <FeatureCard num="4" eyebrow="Schedule" title="Consistency on autopilot." body="Pick the cadence. ScaleSolo finds the next open slot per platform and ships on time, every time.">
            <CalendarMock />
          </FeatureCard>
        </div>
      </section>
      </div>

      {/* ── PRICING ─────────────────────────────────────────────────── */}
      <section id="pricing" style={{ ...section, position: 'relative' }} className="fade-up">
        <div aria-hidden style={{ ...sectionAura, top: '40%', left: '50%', transform: 'translate(-50%, -50%)', width: 720, height: 480, opacity: 0.55 }} />
        <h2 style={sectionH}>Choose what fits you</h2>
        <p style={sectionSub}>All tiers include unlimited workflows, social scheduling, and brand-voice generation. Pick by output volume.</p>
        <PricingPlans />
      </section>

      {/* ── FOOTER ──────────────────────────────────────────────────── */}
      <footer style={footer}>
        <div style={footerInner}>
          <div style={brand}>
            <div style={brandIcon}><Zap size={14} fill="#fff" stroke="none" /></div>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16 }}>ScaleSolo</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 360, lineHeight: 1.5 }}>
            Automated content workflows for solo creators. Write in your voice, film with your avatar, post on autopilot.
          </div>
          <div style={footerLinks}>
            <div>
              <div style={footerColTitle}>Product</div>
              <a href="#features" style={footerLink}>Features</a>
              <a href="#canvas" style={footerLink}>How it works</a>
              <a href="#use-cases" style={footerLink}>Use cases</a>
              <a href="#templates" style={footerLink}>Templates</a>
              <a href="#pricing" style={footerLink}>Pricing</a>
            </div>
            <div>
              <div style={footerColTitle}>Company</div>
              <a href="mailto:hi@scalesolo.ai" style={footerLink}>Contact</a>
              <a href="/privacy" style={footerLink}>Privacy</a>
              <a href="/terms" style={footerLink}>Terms</a>
            </div>
          </div>
        </div>
        <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', padding: '20px 0', borderTop: '1px solid var(--border)' }}>
          © {new Date().getFullYear()} ScaleSolo. Built for creators who'd rather create than post.
        </div>
      </footer>
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────

function TemplateCard({ title, blurb, tags }) {
  return (
    <div style={templateCard} className="lift">
      <div aria-hidden style={templateGlow} />
      <div style={{ position: 'relative' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16, marginBottom: 6 }}>{title}</div>
        <div style={{ fontSize: 13, color: 'var(--text-soft)', lineHeight: 1.5, marginBottom: 14 }}>{blurb}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {tags.map((t) => (
            <span key={t} style={tagChip}>{t}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

// Decorative particle field , pure CSS dots with randomized animation
// delays. Sits behind everything; not interactive.
function ParticleField() {
  // Pre-shuffled positions so SSR + first paint match.
  const dots = [
    { left: '6%',  top: '12%', size: 4, dur: 8.4, delay: 0.2 },
    { left: '14%', top: '38%', size: 3, dur: 9.1, delay: 1.6 },
    { left: '22%', top: '8%',  size: 5, dur: 7.6, delay: 0.9 },
    { left: '38%', top: '54%', size: 3, dur: 10,  delay: 2.4 },
    { left: '46%', top: '18%', size: 4, dur: 8,   delay: 0 },
    { left: '58%', top: '62%', size: 3, dur: 9.5, delay: 1.2 },
    { left: '67%', top: '24%', size: 5, dur: 7.2, delay: 2.0 },
    { left: '75%', top: '48%', size: 3, dur: 10.5,delay: 0.7 },
    { left: '83%', top: '14%', size: 4, dur: 8.6, delay: 1.4 },
    { left: '90%', top: '40%', size: 3, dur: 9.9, delay: 2.8 },
    { left: '30%', top: '78%', size: 4, dur: 8.2, delay: 0.5 },
    { left: '70%', top: '82%', size: 3, dur: 9.3, delay: 1.8 },
  ]
  return (
    <div aria-hidden style={particleField}>
      {dots.map((d, i) => (
        <span key={i} style={{
          position: 'absolute',
          left: d.left, top: d.top,
          width: d.size, height: d.size,
          borderRadius: '50%',
          background: 'rgba(239, 68, 68, 0.6)',
          boxShadow: '0 0 8px rgba(239, 68, 68, 0.7)',
          animation: `floatDrift ${d.dur}s var(--ease) ${d.delay}s infinite`,
        }} />
      ))}
    </div>
  )
}

// (CanvasMock removed , replaced by <WorkflowDemo /> from
// src/components/WorkflowDemo.jsx, an interactive 9-node walkthrough
// of the AI Podcaster pipeline.)

// ─────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────
// The CSS-var overrides below pin the public landing to the dark brand
// palette even when an app user has persisted a light theme. Vars defined
// on this wrapper cascade to every descendant, so anything using
// var(--surface) / var(--text) / etc. resolves to the dark values
// regardless of the [data-theme] attribute on <html>.
const page = {
  '--bg':           '#111112',
  '--surface':      '#1a1a1c',
  '--surface-2':    '#222226',
  '--surface-3':    '#2a2a30',
  '--border':       'rgba(255, 255, 255, 0.07)',
  '--border-strong':'rgba(255, 255, 255, 0.12)',
  '--text':         '#f0f0f0',
  '--text-soft':    '#cccccd',
  '--muted':        '#9a9aa3',
  '--red-soft':     'rgba(239, 68, 68, 0.12)',
  '--shadow-card':  '0 12px 32px rgba(0, 0, 0, 0.35)',
  '--shadow-pop':   '0 20px 50px rgba(0, 0, 0, 0.55)',
  colorScheme:      'dark',
  background:       'var(--bg)',
  color:            'var(--text)',
  minHeight: '100vh',
  fontFamily: 'var(--font-body, system-ui, sans-serif)',
  position: 'relative',
  overflowX: 'hidden',
}

const particleField = {
  position: 'fixed', inset: 0,
  pointerEvents: 'none',
  zIndex: 0,
}

const navBar = {
  position: 'sticky', top: 0, zIndex: 30,
  background: 'color-mix(in srgb, var(--bg) 82%, transparent)',
  backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
  borderBottom: '1px solid var(--border)',
}
const navInner = { maxWidth: 1180, margin: '0 auto', padding: '14px 24px', display: 'flex', alignItems: 'center', gap: 32 }
const brand = { display: 'flex', alignItems: 'center', gap: 8 }
const brandIcon = {
  width: 26, height: 26, borderRadius: 7,
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  display: 'grid', placeItems: 'center',
  boxShadow: '0 4px 12px rgba(239,68,68,0.32)',
}
const navLinks = { display: 'flex', gap: 24, flex: 1, justifyContent: 'center' }
const navLink = { fontSize: 13, color: 'var(--text-soft)', textDecoration: 'none', fontFamily: 'var(--font-display)', fontWeight: 600 }
const navCta = { display: 'flex', alignItems: 'center', gap: 10 }

// ── Hero ────────────────────────────────────────────────────────────
const hero = {
  position: 'relative',
  maxWidth: 1180, margin: '0 auto', padding: '165px 24px 20px',
  zIndex: 1,
  isolation: 'isolate',
}
const heroGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
  gap: 56,
  alignItems: 'center',
}
const heroCopy = { textAlign: 'left' }

// Outer-most flame: tall radial column, deep red core fading orange.
const heroFlameOuter = {
  position: 'absolute', top: 80, left: '50%',
  transform: 'translateX(-50%)',
  width: 'min(900px, 95vw)', height: 1100,
  background: 'radial-gradient(50% 45% at 50% 65%, rgba(255, 100, 60, 0.55), rgba(239,68,68,0.22) 45%, rgba(239,68,68,0) 70%)',
  filter: 'blur(40px)',
  pointerEvents: 'none', zIndex: -2,
  willChange: 'transform, opacity',
}
// Mid layer: tighter, pure red core
const heroFlameMid = {
  position: 'absolute', top: 200, left: '50%',
  transform: 'translateX(-50%)',
  width: 'min(560px, 85vw)', height: 800,
  background: 'radial-gradient(40% 50% at 50% 60%, rgba(239, 68, 68, 0.55), rgba(185, 28, 28, 0.18) 50%, rgba(0,0,0,0) 75%)',
  filter: 'blur(50px)',
  pointerEvents: 'none', zIndex: -2,
}
// Hot core
const heroFlameCore = {
  position: 'absolute', top: 280, left: '50%',
  transform: 'translateX(-50%)',
  width: 280, height: 600,
  background: 'radial-gradient(35% 50% at 50% 65%, rgba(255, 200, 120, 0.45), rgba(255, 100, 50, 0.20) 40%, rgba(0,0,0,0) 80%)',
  filter: 'blur(30px)',
  pointerEvents: 'none', zIndex: -1,
  mixBlendMode: 'screen',
}
// Subtle wisp at very bottom (ground glow)
const heroFlameWisp = {
  position: 'absolute', bottom: -60, left: '50%',
  transform: 'translateX(-50%)',
  width: '105%', height: 260,
  background: 'radial-gradient(50% 100% at 50% 100%, rgba(255, 80, 40, 0.45), rgba(239,68,68,0.10) 45%, rgba(0,0,0,0) 70%)',
  filter: 'blur(40px)',
  pointerEvents: 'none', zIndex: -1,
}

const eyebrowWrap = { display: 'flex', justifyContent: 'center', marginBottom: 22 }
const eyebrow = {
  display: 'inline-flex', alignItems: 'center', gap: 8,
  background: 'rgba(239,68,68,0.14)',
  color: 'var(--red)',
  fontFamily: 'var(--font-display)',
  fontWeight: 700, fontSize: 11,
  letterSpacing: '0.10em', textTransform: 'uppercase',
  padding: '7px 14px', borderRadius: 999,
  border: '1px solid rgba(239,68,68,0.30)',
  boxShadow: '0 4px 16px rgba(239,68,68,0.18)',
  backdropFilter: 'blur(6px)',
}
const heroH1 = {
  fontFamily: 'var(--font-display)', fontWeight: 800,
  fontSize: 'clamp(44px, 6.4vw, 78px)', lineHeight: 1.02,
  margin: 0, marginBottom: 22, letterSpacing: '-0.025em',
  color: 'var(--text)',
  animationDelay: '120ms',
}
const heroSub = {
  fontSize: 17, color: 'var(--text-soft)',
  maxWidth: 640, margin: '0 auto 32px', lineHeight: 1.55,
  animationDelay: '200ms',
}
const heroCtas = { display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap', animationDelay: '280ms' }
const ctaSizing = { padding: '13px 24px', fontSize: 14, justifyContent: 'center' }
const trustPills = { display: 'flex', justifyContent: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 60, animationDelay: '360ms' }
const pill = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  fontSize: 12, color: 'var(--text-soft)',
  background: 'var(--surface-2)', padding: '6px 12px',
  borderRadius: 999, border: '1px solid var(--border)',
}

// ── Hero video frame with rotating halo ─────────────────────────────
const shotWrap = { position: 'relative', marginTop: 28, marginBottom: 100, animationDelay: '440ms' }
const shotUnderGlow = {
  position: 'absolute', left: '50%', bottom: -40, transform: 'translateX(-50%)',
  width: '90%', height: 360,
  background: 'radial-gradient(ellipse at center, rgba(239,68,68,0.55), rgba(255,120,60,0.18) 40%, rgba(0,0,0,0) 75%)',
  filter: 'blur(70px)', pointerEvents: 'none', zIndex: 0,
}
// Wrap that holds both the rotating halo and the actual card
const shotFrame = {
  position: 'relative', zIndex: 1,
  borderRadius: 22, padding: 2,
  background: 'transparent',
  isolation: 'isolate',
}
// The rotating conic-gradient. Sits behind the card via z-index, larger
// than the card so the halo extends past the corners.
const shotHalo = {
  position: 'absolute',
  inset: '-30%',
  background: 'conic-gradient(from 0deg, rgba(239,68,68,0) 0%, rgba(239,68,68,0.55) 8%, rgba(255,140,80,0.85) 12%, rgba(239,68,68,0.55) 16%, rgba(239,68,68,0) 24%, rgba(239,68,68,0) 50%, rgba(239,68,68,0.45) 58%, rgba(255,180,120,0.75) 62%, rgba(239,68,68,0.45) 66%, rgba(239,68,68,0) 74%)',
  filter: 'blur(40px)',
  pointerEvents: 'none', zIndex: 0,
  willChange: 'transform',
}
const shotCard = {
  position: 'relative', zIndex: 1,
  background: 'transparent',
  display: 'grid', placeItems: 'center',
}
const shotImg = {
  width: '100%', height: 'auto', display: 'block',
  position: 'relative', zIndex: 1,
  filter: 'drop-shadow(0 30px 60px rgba(0,0,0,0.55)) drop-shadow(0 0 40px rgba(239,68,68,0.18))',
  transition: 'transform 200ms ease-out',
  willChange: 'transform',
}

// Hero dashboard image with subtle 3D tilt that follows the cursor.
function HeroShot({ src }) {
  const cardRef = useRef(null)
  const imgRef = useRef(null)
  const handleMove = (e) => {
    const el = cardRef.current
    const img = imgRef.current
    if (!el || !img) return
    const r = el.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width  // 0..1
    const py = (e.clientY - r.top) / r.height
    const rx = (0.5 - py) * 8   // tilt up/down
    const ry = (px - 0.5) * 10  // tilt left/right
    img.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) scale(1.02)`
  }
  const handleLeave = () => {
    if (imgRef.current) imgRef.current.style.transform = 'perspective(900px) rotateX(0deg) rotateY(0deg) scale(1)'
  }
  return (
    <div ref={cardRef} style={shotCard} onMouseMove={handleMove} onMouseLeave={handleLeave}>
      <img
        ref={imgRef}
        src={src}
        alt="ScaleSolo dashboard"
        style={shotImg}
        onError={(e) => { e.currentTarget.style.opacity = '0' }}
      />
    </div>
  )
}

// ── Feature cards (with CSS-animated dash mocks) ────────────────────
function FeatureCard({ num, eyebrow, title, body, children }) {
  return (
    <div className="feat-card lift">
      <div className="feat-num">{num}</div>
      <div className="feat-mock">{children}</div>
      <div className="feat-eyebrow">{eyebrow}</div>
      <div className="feat-title">{title}</div>
      <div className="feat-body">{body}</div>
    </div>
  )
}

function AvatarMock() {
  return (
    <div className="mock-avatar">
      <div className="phone">
        <span className="rec-dot" />
        <span className="rec-label">REC</span>
        <div className="aura" />
        <div className="halo" />
        <div className="face">
          <div className="face-inner" />
        </div>
        <div className="scan" />
        <span className="spark s1" />
        <span className="spark s2" />
        <span className="spark s3" />
        <span className="spark s4" />
        <div className="outfit-track">
          <span className="chip c1" />
          <span className="chip c2" />
          <span className="chip c3" />
          <span className="chip c4" />
        </div>
      </div>
    </div>
  )
}

function BrandProfilesMock() {
  // 3 stacked brand cards, fanned, each with its own accent.
  return (
    <div className="mock-brands">
      <div className="brand-card brand-c">
        <div className="brand-dot" />
        <div className="brand-lines"><span /><span /></div>
      </div>
      <div className="brand-card brand-b">
        <div className="brand-dot" />
        <div className="brand-lines"><span /><span /></div>
      </div>
      <div className="brand-card brand-a">
        <div className="brand-dot" />
        <div className="brand-lines"><span /><span /></div>
      </div>
    </div>
  )
}

function SpacesMock() {
  // Canvas-style: 3 nodes connected by an edge with a moving dot.
  return (
    <div className="mock-spaces">
      <svg viewBox="0 0 200 100" preserveAspectRatio="none">
        <path id="spaces-path" d="M 28 50 L 100 28 L 172 50" />
        <circle r="3" className="flow-dot">
          <animateMotion dur="2.4s" repeatCount="indefinite">
            <mpath href="#spaces-path" />
          </animateMotion>
        </circle>
      </svg>
      <div className="node n1"><span /><span /></div>
      <div className="node n2"><span /><span /></div>
      <div className="node n3"><span /><span /></div>
    </div>
  )
}

function CalendarMock() {
  // 3 rows × 7 cols. Decide which cells are colored.
  const layout = [
    ['red', null, 'violet', null, 'red', null, null],
    [null, 'violet', null, 'red', null, null, 'red'],
    ['violet', null, null, null, 'red', 'violet', null],
  ]
  return (
    <div className="mock-cal">
      {layout.flat().map((kind, i) => (
        <div
          key={i}
          className={`cell ${kind ? `fill ${kind}` : ''}`}
          style={kind ? { animationDelay: `${i * 70}ms` } : undefined}
        />
      ))}
    </div>
  )
}

// ── Trust strip ─────────────────────────────────────────────────────
const trustSection = { padding: '40px 24px 60px', background: 'transparent', position: 'relative', zIndex: 1 }
const trustEyebrow = {
  fontSize: 12, color: 'var(--muted)', textAlign: 'center',
  marginBottom: 22, letterSpacing: '0.10em', textTransform: 'uppercase',
  fontFamily: 'var(--font-display)', fontWeight: 700,
}
const logoRow = {
  maxWidth: 1180, margin: '0 auto',
  display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 12, alignItems: 'center',
}
const logoChip = {
  display: 'inline-flex', alignItems: 'center', gap: 8,
  padding: '8px 14px', borderRadius: 999,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13,
  letterSpacing: '0.01em',
  transition: 'transform 200ms var(--ease), border-color 200ms var(--ease)',
}

// ── Generic section ─────────────────────────────────────────────────
const section = { maxWidth: 1180, margin: '0 auto', padding: '40px 24px 60px', position: 'relative', zIndex: 1 }
const sectionH = {
  fontFamily: 'var(--font-display)', fontWeight: 800,
  fontSize: 'clamp(28px, 3.8vw, 44px)', textAlign: 'center', margin: 0, marginBottom: 14,
  letterSpacing: '-0.02em', color: 'var(--text)',
}
const sectionSub = {
  fontSize: 16, color: 'var(--text-soft)', textAlign: 'center',
  maxWidth: 600, margin: '0 auto 50px', lineHeight: 1.5,
}
// Decorative red bloom for inside sections
const sectionAura = {
  position: 'absolute',
  width: 460, height: 460,
  background: 'radial-gradient(circle, rgba(239,68,68,0.22), rgba(239,68,68,0) 70%)',
  filter: 'blur(60px)',
  pointerEvents: 'none', zIndex: 0,
}

// ── Features ────────────────────────────────────────────────────────
const featuresGrid = {
  display: 'grid', gap: 18,
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  position: 'relative', zIndex: 1,
}
const featureCard = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 18, overflow: 'hidden',
  display: 'flex', flexDirection: 'column',
  boxShadow: 'var(--shadow-card)',
}
const featureCardImg = {
  aspectRatio: '16/9', background: 'var(--surface-2)',
  borderBottom: '1px solid var(--border)',
  position: 'relative', overflow: 'hidden',
}
const featureTitle = { fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18, marginBottom: 8, color: 'var(--text)' }
const featureBody = { fontSize: 13.5, color: 'var(--text-soft)', lineHeight: 1.55 }

// ── Canvas mock ─────────────────────────────────────────────────────
// (Canvas / node styles moved into src/components/WorkflowDemo.jsx
// alongside the new interactive walkthrough.)

// ── Value grid ──────────────────────────────────────────────────────
const valueGridStyle = {
  display: 'grid', gap: 14,
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
}
const valueCard = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 14, padding: '24px 22px',
  boxShadow: 'var(--shadow-card)',
}

// ── Templates ───────────────────────────────────────────────────────
const templatesRow = {
  display: 'grid', gap: 16,
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
}
const templateCard = {
  position: 'relative', overflow: 'hidden',
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 18, padding: '24px 22px', minHeight: 180,
  boxShadow: 'var(--shadow-card)',
}
const templateGlow = {
  position: 'absolute', top: -50, right: -50, width: 220, height: 220,
  background: 'radial-gradient(circle, rgba(239,68,68,0.20), rgba(239,68,68,0) 70%)',
  filter: 'blur(40px)', pointerEvents: 'none',
}
const tagChip = {
  fontSize: 11, color: 'var(--red)',
  background: 'var(--red-soft)', border: '1px solid rgba(239,68,68,0.25)',
  padding: '3px 8px', borderRadius: 999,
  fontFamily: 'var(--font-display)', fontWeight: 700,
}

// ── Testimonials ────────────────────────────────────────────────────
const testimonialGrid = {
  display: 'grid', gap: 14,
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  position: 'relative', zIndex: 1,
}
const testimonialCard = {
  position: 'relative',
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 14, padding: '22px 20px',
  display: 'flex', flexDirection: 'column', gap: 14,
  boxShadow: 'var(--shadow-card)',
}
const quoteBadge = {
  display: 'inline-grid', placeItems: 'center',
  width: 26, height: 26, borderRadius: 8,
  background: 'rgba(239,68,68,0.14)',
  color: 'var(--red)',
  border: '1px solid rgba(239,68,68,0.28)',
}
const testimonialQuote = { fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-soft)', fontStyle: 'italic' }
const testimonialName = { display: 'flex', alignItems: 'center', gap: 10 }
const testimonialAvatar = {
  width: 32, height: 32, borderRadius: 999,
  background: 'linear-gradient(135deg, rgba(239,68,68,0.6), rgba(168,85,247,0.5))',
  color: '#fff', display: 'grid', placeItems: 'center',
  fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700,
}

// ── Final CTA ───────────────────────────────────────────────────────
const finalCta = {
  textAlign: 'center', maxWidth: 720, margin: '60px auto 100px',
  padding: '60px 24px',
  background: 'radial-gradient(ellipse at center, rgba(239,68,68,0.16), rgba(239,68,68,0) 70%)',
  position: 'relative', zIndex: 1,
}

// ── Footer ──────────────────────────────────────────────────────────
const footer = {
  borderTop: '1px solid var(--border)',
  background: 'var(--surface-2)',
  marginTop: 60,
  position: 'relative', zIndex: 1,
}
const footerInner = {
  maxWidth: 1180, margin: '0 auto',
  padding: '50px 24px 30px',
  display: 'grid', gap: 30,
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
}
const footerLinks = { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 24 }
const footerColTitle = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12, marginBottom: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-soft)' }
const footerLink = { display: 'block', fontSize: 13, color: 'var(--muted)', textDecoration: 'none', marginBottom: 6 }
