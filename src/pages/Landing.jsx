import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Zap, ArrowRight, Check, Sparkles, Boxes, UserCircle2, Calendar,
  Layers, Wand2, RefreshCw, ShieldCheck, Quote, Play,
  Instagram, Youtube, Twitter, Linkedin, Music2, Captions as CaptionsIcon,
  Mic2, ShoppingBag, GraduationCap, Newspaper, Menu, X, PenLine, Film,
  Volume2, VolumeX, Star,
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

// Hero asset — can be an image OR a video URL. HeroShot autodetects
// the extension and renders <video> for .mp4/.webm/.mov, otherwise
// falls back to <img>.
const HERO_IMAGE = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/Scalesolo%20ad.mp4'
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
    body: 'Build photorealistic avatars from a single photo. Cycle outfits and looks across runs so every video posts fresh.',
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
  { name: 'Sam D.',     role: 'B2B Marketer',       quote: 'The schedule node replaced two of my tools. Drafts go out at 8am Tuesdays, no babysitting.' },
  { name: 'Aiyana W.',  role: 'Podcast Producer',   quote: 'Upload audio, ScaleSolo transcribes, splits, and renders across looks. We cut 9-clip shorts from a 60-second source in under 4 minutes.' },
]

export default function Landing() {
  const nav = useNavigate()
  // Hero video starts muted (browsers require it for autoplay) and
  // can be unmuted via the overlay button. State lives here so the
  // button can sit inside HeroShot but the muted attribute on the
  // <video> reflects it reactively.
  const [heroMuted, setHeroMuted] = useState(true)
  // "See how it works" CTA → fullscreen demo modal. Plays the same
  // hero ad on-demand, unmuted by default, with native controls so
  // the visitor can scrub / pause.
  const [demoOpen, setDemoOpen] = useState(false)
  useEffect(() => {
    if (!demoOpen) return
    const onKey = (e) => { if (e.key === 'Escape') setDemoOpen(false) }
    document.addEventListener('keydown', onKey)
    // Lock body scroll while the modal is open so the page behind
    // doesn't move when the user scrolls inside the lightbox.
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [demoOpen])
  // "Sign in" goes to the login page for existing users. We pass
  // ?mode=signin explicitly so Login.jsx forces the sign-in tab even
  // if a previous browse session stashed a signup tier in localStorage
  // (otherwise initialTier wins and the signup form opens by mistake).
  const goSignin = () => nav('/login?mode=signin')
  // "Start free" and other primary CTAs scroll to the pricing section
  // so the visitor picks a plan first. Plan buttons in <PricingPlans />
  // route anonymous users straight to Stripe Checkout, and after
  // payment the success URL drops them on /login to finish signup.
  // This keeps the funnel single-path: land → pick plan → pay → signup.
  const goPricing = () => {
    const el = document.getElementById('pricing')
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // Capture affiliate ref code from ?ref=… and stash in BOTH localStorage
  // and a 30-day first-party cookie. Cookies survive a localStorage wipe
  // (private browsing close, "clear site data"), and the SPA still uses
  // localStorage as the primary read path so we don't ship a request just
  // to get the cookie. Auth context attributes whichever one is present
  // post-signup.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const ref = params.get('ref')
      if (ref && /^[a-z0-9_-]{2,64}$/i.test(ref)) {
        const code = ref.toLowerCase()
        localStorage.setItem('scalesolo.ref', code)
        // 30 days; SameSite=Lax so it survives the email-confirm round trip.
        const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toUTCString()
        document.cookie = `scalesolo_ref=${encodeURIComponent(code)}; expires=${expires}; path=/; SameSite=Lax`
      }
    } catch {}
  }, [])

  // Persona-driven canvas morphing. When the user clicks a card in
  // <UseCaseGrid />, we (a) scroll back up to the canvas section and
  // (b) hand the persona down to <WorkflowDemo /> which dims the
  // non-relevant nodes and starts an auto-tour of just that path.
  const [activePersona, setActivePersona] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = () => setMenuOpen(false)
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

      {/* ── FOUNDING BANNER ─────────────────────────────────────────── */}
      <button
        type="button"
        onClick={goPricing}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          padding: '9px 14px', cursor: 'pointer', border: 'none',
          borderBottom: '1px solid rgba(239,68,68,0.25)',
          background: 'linear-gradient(90deg, rgba(239,68,68,0.16), rgba(245,158,11,0.12))',
          color: 'var(--text)', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12.5,
        }}
      >
        <Sparkles size={12} style={{ color: '#f59e0b' }} />
        Founding pricing: locked for life for the first 100 accounts
        <ArrowRight size={12} />
      </button>

      {/* ── NAV ─────────────────────────────────────────────────────── */}
      <header style={navBar}>
        <div style={navInner}>
          <div style={brand}>
            <div style={brandIcon}><Zap size={14} fill="#fff" stroke="none" /></div>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16 }}>ScaleSolo</span>
          </div>
          <nav style={navLinks} className="hide-on-narrow">
            <a href="#features" style={navLink}>Features</a>
            <a href="#faq" style={navLink}>FAQ</a>
            <a href="#pricing" style={navLink}>Pricing</a>
            <a href="/blog" style={navLink}>Blog</a>
          </nav>
          <div style={navCta} className="hide-on-narrow">
            <button onClick={goSignin} className="btn-ghost" style={{ fontSize: 13 }}>Sign in</button>
            <button onClick={goPricing} className="btn-primary">Start free <ArrowRight size={13} /></button>
          </div>
          <button
            type="button"
            className="nav-burger mobile-only"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
        {menuOpen && (
          <div className="nav-mobile-panel">
            <a href="#features"  style={navLink} onClick={closeMenu}>Features</a>
            <a href="#faq"       style={navLink} onClick={closeMenu}>FAQ</a>
            <a href="#pricing"   style={navLink} onClick={closeMenu}>Pricing</a>
            <a href="/blog"      style={navLink} onClick={closeMenu}>Blog</a>
            <div className="nav-mobile-ctas">
              <button onClick={() => { closeMenu(); goSignin() }} className="btn-ghost" style={{ fontSize: 13 }}>Sign in</button>
              <button onClick={() => { closeMenu(); goPricing() }} className="btn-primary">Start free <ArrowRight size={13} /></button>
            </div>
          </div>
        )}
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
          {/* Two-column hero: copy + CTAs left, the product literally
              building a real carousel on the right. Stacks and centers
              under 940px. */}
          <div className="hero2">
            <div className="hero2-copy">
              <h1
                style={{ ...heroH1, margin: 0, marginBottom: 18, color: 'var(--text)' }}
                className="fade-up hero2-h1"
              >
                Create <span className="brand-text">30 days of content</span> in minutes.
              </h1>
              <p style={{ ...heroSub, margin: '0 0 10px' }} className="fade-up hero2-sub hero2-sub-full">
                ScaleSolo is your AI social media manager. Design carousels, avatar videos, and a
                month of posts, then drop them on a calendar that publishes for you. It even hooks
                into Claude, so your AI can run the whole thing.
              </p>
              <p style={{ ...heroSub, margin: '0 0 10px' }} className="fade-up hero2-sub hero2-sub-short">
                Your AI social media manager. Carousels, videos, and a calendar that posts for you.
              </p>
              <div className="fade-up hero2-micro" style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 18 }}>
                3-day free trial. Cancel anytime. Keep everything you make.
              </div>
              <div style={{ ...heroCtas, justifyContent: 'flex-start', marginBottom: 20 }} className="fade-up hero2-row">
                <button onClick={goPricing} className="btn-primary" style={ctaSizing}>
                  Start free <ArrowRight size={14} />
                </button>
              </div>
              <div className="fade-up ss-platform-strip hero2-row" style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'var(--font-display)', fontWeight: 700 }}>Publishes natively to</span>
                {trustLogos.map(({ name, Icon, tint }) => (
                  <span key={name} title={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-soft)', fontSize: 12.5 }}>
                    <Icon size={15} style={{ color: tint }} /> {name}
                  </span>
                ))}
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>+ 4 more</span>
              </div>
            </div>
            <div className="fade-up">
              <CarouselBuildPanel />
            </div>
          </div>
        </div>
      </section>

      {/* ── LIVE DEMOS ──────────────────────────────────────────────── */}
      {/* Real product, real output: a carousel building itself from the
          user's actual slides, the self-filling calendar, Claude driving
          the account over MCP, and a likeness-locked outfit change. */}
      <CalendarShowcase />
      <McpShowcase />
      <OutfitShowcase />



      {/* ── TESTIMONIALS ────────────────────────────────────────────── */}
      <TestimonialsSection />

      {/* ── PRICING ─────────────────────────────────────────────────── */}
      <section id="pricing" style={{ ...section, position: 'relative' }} className="fade-up">
        <div aria-hidden style={{ ...sectionAura, top: '40%', left: '50%', transform: 'translate(-50%, -50%)', width: 720, height: 480, opacity: 0.55 }} />
        <h2 style={sectionH}>Choose what fits you</h2>
        <p style={sectionSub}>Every plan includes the full autopilot pipeline: brand voice, avatars, finishing, and native scheduling. Pick by how much you want to post.</p>
        <PricingPlans />
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
              wardrobes, and delivery, ready to post video at the volume modern social demands.
            </p>
            <ul className="showcase-list">
              <li><Check size={14} /> Production-grade avatars trained from a single reference</li>
              <li><Check size={14} /> Roster multiple presenters per brand for any campaign</li>
              <li><Check size={14} /> Locked wardrobes and styling so every render stays on-brand</li>
              <li><Check size={14} /> Plugs straight into your autopilot workflow</li>
            </ul>
          </div>
          <div className="showcase-img-wrap">
            <img
              loading="lazy" decoding="async"
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
          <div className="showcase-img-wrap">
            <img
              loading="lazy" decoding="async"
              src="https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/captions_landing.png"
              alt="ScaleSolo video finishing: captions, titles, overlays, music, and watermarks"
              className="showcase-img"
              onError={(e) => { e.currentTarget.style.opacity = '0' }}
            />
          </div>
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
              <li><Check size={14} /> Brand watermarks locked in so nothing posts off-brand</li>
            </ul>
          </div>
        </div>
      </section>

      {/* ── SCHEDULE-POST FEATURE SHOWCASE ──────────────────────────── */}
      <section style={section} className="fade-up">
        <div className="showcase-grid">
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
              <li><Check size={14} /> Auto-generates and posts on your set cadence</li>
              <li><Check size={14} /> Native publishing to TikTok, IG, YouTube, X, LinkedIn, Threads, FB</li>
              <li><Check size={14} /> Run brands at scale with every brand on its own autopilot</li>
            </ul>
          </div>
          <div className="showcase-img-wrap">
            <img
              loading="lazy" decoding="async"
              src="https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/schedule_post.png"
              alt="ScaleSolo schedule-post feature"
              className="showcase-img"
              onError={(e) => { e.currentTarget.style.opacity = '0' }}
            />
          </div>
        </div>
      </section>

      {/* Angled gradient separator above features */}
      <div aria-hidden className="feat-separator" />

      {/* ── FEATURES ────────────────────────────────────────────────── */}
      <div className="feat-section">
      <section id="features" style={{ ...section, paddingTop: 20, paddingBottom: 100 }} className="fade-up">
        <h2 style={sectionH}>Everything you need to post daily</h2>
        <p style={sectionSub}>One workspace for the whole content engine: write, render, schedule, post.</p>
        <div className="feat-grid">
          <FeatureCard num="1" eyebrow="Realistic avatars" title="Faceless video on autopilot." body="Build a photorealistic avatar from a single photo. Cycle outfits and looks across runs so every video posts fresh.">
            <AvatarMock />
          </FeatureCard>
          <FeatureCard num="2" eyebrow="Brand profiles" title="One workspace, many brands." body="Each brand keeps its own voice, cadence, platforms, and avatar. Switch profiles, never cross-pollinate.">
            <BrandProfilesMock />
          </FeatureCard>
          <FeatureCard num="3" eyebrow="Workflow builder" title="Drag, drop, run forever." body="A visual canvas that connects script, render, and schedule. Set it up once, hit run, walk away.">
            <SpacesMock />
          </FeatureCard>
          <FeatureCard num="4" eyebrow="Schedule" title="Consistency on autopilot." body="Pick the cadence. ScaleSolo finds the next open slot per platform and posts on time, every time.">
            <CalendarMock />
          </FeatureCard>
        </div>
      </section>
      </div>

      {/* ── FAQ ─────────────────────────────────────────────────────── */}
      <section id="faq" style={section} className="fade-up">
        <h2 style={sectionH}>Questions, <span className="brand-text">answered</span>.</h2>
        <p style={sectionSub}>
          Everything new founders ask before launching their first faceless brand.
        </p>
        <div className="faq-list">
          <FaqItem q="Do I have to show my face?">
            Never. ScaleSolo is built for faceless brands. Your AI avatar speaks for you, and you can run an entire brand without ever turning on a camera.
          </FaqItem>
          <FaqItem q="How long does setup take?">
            About 5 minutes. Pick a workflow, plug in your voice and avatar, and ScaleSolo handles writing, rendering, captioning, and scheduling automatically from there.
          </FaqItem>
          <FaqItem q="What platforms can it post to?">
            Native publishing to TikTok, Instagram, YouTube, X, LinkedIn, Threads, Facebook, and more. 9+ platforms total, no third-party scheduler tax.
          </FaqItem>
          <FaqItem q="Can Claude really manage my account?">
            Yes. ScaleSolo ships a built-in MCP connection, so Claude (or any MCP-compatible AI) can create carousels, write captions, generate images and video, and schedule posts for you, using your brand voice and your credits. You approve the connection once and just talk to your AI.
          </FaqItem>
          <FaqItem q="Can it really make 30 days of content in minutes?">
            That's the core workflow. Tell ScaleSolo your brand and cadence, and it generates a month of on-voice posts, carousels, captions, and hashtags, then fills your posting calendar automatically. You review, tweak what you want, and it publishes on schedule.
          </FaqItem>
          <FaqItem q="Can I run more than one brand?">
            Yes. Brand profiles isolate each brand's voice, avatar, cadence, and platforms so nothing cross-pollinates. Run as many as your plan allows, all on autopilot.
          </FaqItem>
          <FaqItem q="Will the AI actually sound like me?">
            That's the entire point. Import the brand-voice profile you already use with ChatGPT, Claude, or Gemini, or build it on ScaleSolo. The platform learns from your past scripts and top-performing posts so output stays seamless and authentic.
          </FaqItem>
          <FaqItem q="Do I need video editing skills?">
            None. Captions, titles, overlays, music, and watermarks get baked into every render automatically. Pick the look once per brand, ScaleSolo delivers a finished video on every run.
          </FaqItem>
          <FaqItem q="Do I own the videos and assets?">
            Every render lands in your library. Originals are yours to download, repost, or repurpose. No vendor lock-in.
          </FaqItem>
          <FaqItem q="Is there a free trial?">
            Yes. Every plan starts with a 3-day trial so you can build your first faceless brand and see it post on its own before you're billed. Cancel anytime during the trial and you keep everything you've already generated.
          </FaqItem>
        </div>
      </section>

      {/* ── FINAL CTA ───────────────────────────────────────────────── */}
      <FinalCta />

      {/* ── FOOTER ──────────────────────────────────────────────────── */}
      <footer className="ss-footer">
        <div aria-hidden className="ss-footer-glow" />
        <div className="ss-footer-inner">
          <div className="ss-footer-grid">
            <div className="ss-footer-brand-col">
              <div style={brand}>
                <div style={brandIcon}><Zap size={14} fill="#fff" stroke="none" /></div>
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16 }}>ScaleSolo</span>
              </div>
              <p className="ss-footer-tagline">
                The first AI platform that builds a faceless brand for you and runs it on autopilot.
              </p>
              <div className="ss-footer-socials">
                <a href="https://x.com" aria-label="X" className="ss-social"><Twitter size={16} /></a>
                <a href="https://instagram.com" aria-label="Instagram" className="ss-social"><Instagram size={16} /></a>
                <a href="https://youtube.com" aria-label="YouTube" className="ss-social"><Youtube size={16} /></a>
                <a href="https://tiktok.com" aria-label="TikTok" className="ss-social"><Music2 size={16} /></a>
                <a href="https://linkedin.com" aria-label="LinkedIn" className="ss-social"><Linkedin size={16} /></a>
              </div>
            </div>

            <div className="ss-footer-col">
              <div className="ss-footer-col-title">Product</div>
              <a href="#features"  className="ss-footer-link">Features</a>
              <a href="#pricing"   className="ss-footer-link">Pricing</a>
              <a href="/blog"      className="ss-footer-link">Blog</a>
            </div>

            <div className="ss-footer-col">
              <div className="ss-footer-col-title">Resources</div>
              <a href="#faq"     className="ss-footer-link">FAQ</a>
              <a href="mailto:hi@scalesolo.ai" className="ss-footer-link">Contact</a>
            </div>

            <div className="ss-footer-col">
              <div className="ss-footer-col-title">Legal</div>
              <a href="/privacy" className="ss-footer-link">Privacy</a>
              <a href="/terms"   className="ss-footer-link">Terms</a>
            </div>
          </div>

          <div aria-hidden className="ss-footer-wordmark">scalesolo</div>

          <div className="ss-footer-bottom">
            <div className="ss-footer-copyright">© {new Date().getFullYear()} ScaleSolo. Built for founders who'd rather build than post.</div>
            <div className="ss-footer-bottom-links">
              <a href="/privacy" className="ss-footer-link-sm">Privacy</a>
              <span className="ss-dot" />
              <a href="/terms" className="ss-footer-link-sm">Terms</a>
              <span className="ss-dot" />
              <a href="/status" className="ss-footer-link-sm">Status</a>
            </div>
          </div>
        </div>
      </footer>

      {/* Sticky mobile CTA — appears after the visitor scrolls past the
          hero. Hidden on desktop via .ss-mobile-cta. */}
      <MobileCtaBar />

      {/* Demo-video lightbox. Triggered by the "See how it works" CTA
          in the hero. Click backdrop / close button / Esc to dismiss.
          Video plays unmuted with native controls so the visitor can
          actually hear + scrub the demo. */}
      {demoOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="ScaleSolo demo video"
          onClick={() => setDemoOpen(false)}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0, 0, 0, 0.88)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            display: 'grid', placeItems: 'center',
            zIndex: 1000, padding: 24,
            animation: 'fadeIn 180ms var(--ease) forwards',
          }}
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setDemoOpen(false) }}
            aria-label="Close demo"
            style={{
              position: 'absolute', top: 18, right: 18,
              width: 44, height: 44, borderRadius: 999,
              background: 'rgba(255, 255, 255, 0.08)',
              border: '1px solid rgba(255, 255, 255, 0.18)',
              color: '#fff',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <X size={20} />
          </button>
          <video
            // Click on the video itself doesn't close — that's the
            // backdrop's job. Stop propagation so scrubbing / pausing
            // works without the modal collapsing.
            onClick={(e) => e.stopPropagation()}
            src={HERO_IMAGE}
            controls
            autoPlay
            playsInline
            preload="auto"
            style={{
              width: 'min(1100px, 92vw)',
              maxHeight: '86vh',
              borderRadius: 14,
              boxShadow: '0 30px 80px rgba(0, 0, 0, 0.6)',
              background: '#000',
            }}
          />
        </div>
      )}
    </div>
  )
}

// ─── Live demo sections ──────────────────────────────────────────────
// Auto-looping product demos built from REAL output (the user's actual
// carousel slides + a real likeness-locked outfit change). Each runs a
// 100ms ticker only while scrolled into view.

const DEMO_SLIDES = [1, 2, 3, 4, 5, 6, 7].map((i) => `/landing/demo/slide-0${i}.jpg`)
const DEMO_TOPIC = '5 content ideas that actually book clients'

// Ticker that only runs while the element is on screen. Returns [ref, tick].
function useDemoTicker(loopTicks) {
  const ref = useRef(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let timer = null
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !timer) {
        timer = setInterval(() => setTick((t) => (t + 1) % loopTicks), 100)
      } else if (!e.isIntersecting && timer) {
        clearInterval(timer); timer = null
      }
    }, { threshold: 0.25 })
    io.observe(el)
    return () => { io.disconnect(); if (timer) clearInterval(timer) }
  }, [loopTicks])
  return [ref, tick]
}

const demoPanel = {
  position: 'relative', borderRadius: 18, padding: 18,
  background: 'linear-gradient(160deg, rgba(255,255,255,0.045), rgba(255,255,255,0.015))',
  border: '1px solid rgba(255,255,255,0.10)',
  boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
  overflow: 'hidden',
}
const demoKicker = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11,
  letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)',
  marginBottom: 12,
}
const demoMono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }

function DemoKeyframes() {
  return (
    <style>{`
      @keyframes ssPopIn { 0% { opacity: 0; transform: scale(0.75) translateY(8px); } 60% { transform: scale(1.04) translateY(0); } 100% { opacity: 1; transform: scale(1); } }
      @keyframes ssRowIn { 0% { opacity: 0; transform: translateY(6px); } 100% { opacity: 1; transform: translateY(0); } }
      @keyframes ssCaret { 0%, 55% { opacity: 1; } 56%, 100% { opacity: 0; } }
      @keyframes ssWipe { 0%, 8% { clip-path: inset(0 0 0 0); } 46%, 62% { clip-path: inset(0 0 0 100%); } 96%, 100% { clip-path: inset(0 0 0 0); } }
      @keyframes ssWipeLine { 0%, 8% { left: 0%; } 46%, 62% { left: 100%; } 96%, 100% { left: 0%; } }
      .ss-demo-grid { display: grid; grid-template-columns: 1.05fr 1fr; gap: 44px; align-items: center; }
      @media (max-width: 900px) {
        .ss-demo-grid { grid-template-columns: 1fr; gap: 26px; }
        .ss-mcp-grid > div:last-child { order: -1; }
      }
      .hero2 { display: grid; grid-template-columns: 1.04fr 0.96fr; gap: 48px; align-items: center; text-align: left; }
      .hero2-h1 { font-size: clamp(36px, 4.3vw, 58px) !important; }
      .hero2-sub { font-size: 16px; }
      .hero2-sub-short { display: none; }
      .ss-mobile-cta { display: none; }
      @media (max-width: 940px) {
        /* Phone order: headline, then the live builder panel, then the
           rest of the copy. display:contents promotes the copy column's
           children to flex items so the H1 can sit above the panel
           without duplicating it. Everything centers. */
        .hero2 { display: flex; flex-direction: column; gap: 22px; text-align: center; }
        .hero2-copy { display: contents; }
        .hero2-h1 { order: -2; margin-bottom: 0 !important; }
        .hero2 > div:last-child { order: -1; }
        .hero2-row { justify-content: center !important; }
        .hero2-sub, .hero2-micro { text-align: center; margin-left: auto !important; margin-right: auto !important; }
        .hero2-h1 { font-size: clamp(32px, 8.5vw, 44px) !important; }
        .hero2-sub-full { display: none; }
        .hero2-sub-short { display: block; }
        .ss-mobile-cta {
          display: block; position: fixed; left: 0; right: 0; bottom: 0; z-index: 90;
          padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
          background: color-mix(in srgb, var(--bg) 80%, transparent);
          -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
          border-top: 1px solid var(--border);
          animation: ssRowIn 0.25s var(--ease) both;
        }
        .ss-footer { padding-bottom: 96px; }
      }
      @media (max-width: 640px) {
        .hero-section h1 { font-size: clamp(34px, 9.5vw, 44px) !important; }
        .ss-cal-grid { gap: 3px !important; }
        .ss-cal-time { display: none; }
        .ss-platform-strip { gap: 10px !important; }
        .ss-platform-strip span { font-size: 11.5px !important; }
      }
    `}</style>
  )
}

// 1) Carousel builder panel: topic types itself, slides pop in, lands in
// backlog. Lives in the HERO as the primary product visual.
function CarouselBuildPanel() {
  // Typing runs at 2 chars per 100ms tick so the demo gets to the
  // payoff (the slides) quickly.
  const TYPE_END = 23, GEN_END = 40, SLIDES_END = 82, LOOP = 125
  const [ref, tick] = useDemoTicker(LOOP)
  const typed = DEMO_TOPIC.slice(0, Math.min(tick * 2, DEMO_TOPIC.length))
  const generating = tick >= TYPE_END && tick < GEN_END
  const genPct = generating ? Math.round(((tick - TYPE_END) / (GEN_END - TYPE_END)) * 100) : (tick >= GEN_END ? 100 : 0)
  const slidesShown = tick < GEN_END ? 0 : Math.min(7, Math.floor((tick - GEN_END) / 6) + 1)
  const done = tick >= SLIDES_END
  return (
    <div ref={ref}>
      <DemoKeyframes />
      <div style={demoPanel}>
          <div style={demoKicker}><Wand2 size={12} /> Generate a carousel</div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
            background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 10, marginBottom: 12, fontSize: 13, color: 'var(--text)',
          }}>
            <Sparkles size={13} style={{ color: '#f59e0b', flexShrink: 0 }} />
            <span style={{ minHeight: 18 }}>
              {typed}
              {tick < GEN_END && <span style={{ animation: 'ssCaret 0.9s step-end infinite' }}>|</span>}
            </span>
          </div>
          {(generating || slidesShown === 0) && (
            <div style={{ height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden', marginBottom: 12 }}>
              <div style={{ height: '100%', width: `${genPct}%`, borderRadius: 999, background: 'linear-gradient(90deg, var(--red), #f59e0b)', transition: 'width 0.12s linear' }} />
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {DEMO_SLIDES.map((src, i) => (
              <div key={src} style={{ aspectRatio: '3 / 4', borderRadius: 8, overflow: 'hidden', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {i < slidesShown && (
                  <img
                    src={src} alt={`Carousel slide ${i + 1} generated by ScaleSolo`}
                    loading="lazy" decoding="async"
                    style={{ width: '100%', height: '100%', objectFit: 'cover', animation: 'ssPopIn 0.5s var(--ease) both' }}
                  />
                )}
              </div>
            ))}
            <div style={{
              aspectRatio: '3 / 4', borderRadius: 8, display: 'grid', placeItems: 'center',
              border: '1px dashed rgba(255,255,255,0.14)', color: 'var(--muted)', fontSize: 11, textAlign: 'center', padding: 6,
            }}>
              {done ? <span style={{ color: '#2ecc71', fontWeight: 700, animation: 'ssRowIn 0.4s var(--ease) both' }}>Saved to backlog ✓</span> : '7 slides'}
            </div>
          </div>
          {done && (
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-soft)', animation: 'ssRowIn 0.4s var(--ease) both' }}>
              <Check size={13} style={{ color: '#2ecc71' }} /> Caption + hashtags written in your voice. Ready to schedule.
            </div>
          )}
      </div>
    </div>
  )
}

// 2) The scheduling calendar filling itself from the backlog.
function CalendarShowcase() {
  const LOOP = 150
  const [ref, tick] = useDemoTicker(LOOP)
  const CHIPS = [
    { label: 'Carousel', color: '#a855f7' },
    { label: 'Avatar reel', color: '#0ea5e9' },
    { label: 'Quote post', color: '#f59e0b' },
    { label: 'Podcast clip', color: '#2ecc71' },
  ]
  // Cells fill in a deterministic scatter, 20 of 28 by the end of the loop.
  const ORDER = [2, 5, 9, 12, 16, 19, 23, 26, 1, 7, 10, 14, 17, 21, 24, 27, 3, 8, 15, 22]
  const filled = Math.min(ORDER.length, Math.max(0, Math.floor((tick - 12) / 5)))
  const filledSet = new Set(ORDER.slice(0, filled))
  const chipGone = (i) => filled > i * 3
  const doneBadge = filled >= ORDER.length
  return (
    <section style={section} className="fade-up" ref={ref}>
      <div className="ss-demo-grid">
        <div style={demoPanel}>
          <div style={demoKicker}><Calendar size={12} /> The scheduling calendar</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center', marginRight: 2 }}>Backlog:</span>
            {CHIPS.map((c, i) => (
              <span key={c.label} style={{
                fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
                background: `${c.color}22`, color: c.color, border: `1px solid ${c.color}55`,
                opacity: chipGone(i) ? 0.25 : 1, transition: 'opacity 0.4s',
              }}>{c.label}</span>
            ))}
          </div>
          <div className="ss-cal-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 5 }}>
            {Array.from({ length: 28 }, (_, i) => {
              const isFilled = filledSet.has(i)
              const color = CHIPS[i % CHIPS.length].color
              return (
                <div key={i} style={{
                  aspectRatio: '1', borderRadius: 7, padding: 4,
                  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
                  display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                }}>
                  <span style={{ fontSize: 8.5, color: 'var(--muted)' }}>{i + 1}</span>
                  {isFilled && (
                    <div style={{ animation: 'ssPopIn 0.4s var(--ease) both' }}>
                      <div style={{ height: 4, borderRadius: 999, background: color, marginBottom: 2 }} />
                      <span className="ss-cal-time" style={{ fontSize: 7.5, color: 'var(--muted)' }}>11:00</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div style={{ marginTop: 12, minHeight: 18, fontSize: 12, color: 'var(--text-soft)' }}>
            {doneBadge
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: '#2ecc71', fontWeight: 700, animation: 'ssRowIn 0.4s var(--ease) both' }}><Check size={13} /> A month scheduled. Publishing runs itself.</span>
              : <span>Dragging backlog posts onto open slots…</span>}
          </div>
        </div>
        <div className="showcase-copy">
          <div className="feat-eyebrow">The scheduling calendar</div>
          <h2 className="showcase-title">A calendar that fills itself.</h2>
          <p className="showcase-body">
            Everything you create lands in a backlog next to your calendar. Drag a post onto any
            open slot and it goes live at that time, natively, on every platform you picked. Or
            let ScaleSolo fill the month for you from your posting schedule.
          </p>
          <ul className="showcase-list">
            <li><Check size={14} /> Open slots come from your posting schedule per brand</li>
            <li><Check size={14} /> Drag and drop from backlog to slot, scheduled in one step</li>
            <li><Check size={14} /> Publishes natively to TikTok, IG, YouTube, X, LinkedIn + more</li>
            <li><Check size={14} /> Draft mode for TikTok when you want to post from the app</li>
          </ul>
          <DemoCta stat="A month of posts scheduled in minutes" label="Fill your calendar free" />
        </div>
      </div>
    </section>
  )
}

// 3) Claude driving the account over MCP.
function McpShowcase() {
  // Fully static mockup: the complete conversation is visible at once so
  // the panel never grows or shifts while you read it.
  const USER_MSG = 'Plan my week: 2 carousels, a fresh headshot, and a teaser video.'
  const MCP_VIDEO_URL = '/landing/demo/mcp-talk.mp4' // real Veo output: the burgundy-blazer headshot talking
  const TOOLS = [
    { text: 'create_carousel  "5 Content Ideas That Book Clients"', thumb: '/landing/demo/slide-01.jpg' },
    { text: 'create_carousel  "Turn Followers Into Customers"', thumb: '/landing/demo/slide-02.jpg' },
    { text: 'generate_image  "studio headshot, burgundy blazer"', thumb: '/landing/demo/outfit-after.jpg' },
    { text: 'generate_video  "8s brand teaser, vertical"', video: MCP_VIDEO_URL },
    { text: 'schedule_post  Tue 11:00 AM' },
    { text: 'schedule_post  Thu 11:00 AM' },
    { text: 'schedule_post  Fri 6:00 PM' },
  ]
  return (
    <section style={section} className="fade-up">
      <div className="ss-demo-grid ss-mcp-grid">
        <div className="showcase-copy">
          <div className="feat-eyebrow">Claude + MCP</div>
          <h2 className="showcase-title">Tell Claude. It's posted.</h2>
          <p className="showcase-body">
            ScaleSolo plugs straight into Claude through MCP. Your AI assistant can design
            carousels, generate images and full videos, write captions, and schedule posts,
            all in your brand voice, all on your account. You talk, it ships.
          </p>
          <ul className="showcase-list">
            <li><Check size={14} /> Built-in MCP connection, approve it once</li>
            <li><Check size={14} /> Generate images and videos straight from the chat</li>
            <li><Check size={14} /> Create, caption, and schedule without opening the app</li>
            <li><Check size={14} /> Uses your brand voice, templates, and credits</li>
          </ul>
          <DemoCta stat="A whole week of content from one message" label="Connect Claude free" />
        </div>
        <div style={demoPanel}>
          <div style={demoKicker}><Sparkles size={12} /> Claude, connected via MCP</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{
              alignSelf: 'flex-end', maxWidth: '85%', padding: '9px 12px', borderRadius: '12px 12px 4px 12px',
              background: 'rgba(239,68,68,0.16)', border: '1px solid rgba(239,68,68,0.3)',
              fontSize: 12.5, color: 'var(--text)',
            }}>
              {USER_MSG}
            </div>
            {TOOLS.map((t) => (
              <div key={t.text} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{
                  ...demoMono, display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 10.5, color: 'var(--text-soft)', padding: '6px 10px',
                  background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8,
                }}>
                  <span style={{ color: '#2ecc71', fontWeight: 700 }}>✓</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.text}</span>
                  {/* REAL output preview: the actual generated slide / headshot. */}
                  {t.thumb && (
                    <img src={t.thumb} alt="Generated output preview" loading="lazy" decoding="async"
                      style={{ width: 26, height: 34, objectFit: 'cover', objectPosition: 'top', borderRadius: 5, border: '1px solid rgba(255,255,255,0.18)', flexShrink: 0 }} />
                  )}
                </div>
                {/* REAL Veo output: the generated headshot talking, as a chat attachment. */}
                {t.video && (
                  <video src={t.video} muted playsInline autoPlay loop preload="metadata"
                    style={{ width: 132, aspectRatio: '9 / 16', objectFit: 'cover', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', marginLeft: 24, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }} />
                )}
              </div>
            ))}
            {(
              <div style={{
                alignSelf: 'flex-start', maxWidth: '85%', padding: '9px 12px', borderRadius: '12px 12px 12px 4px',
                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                fontSize: 12.5, color: 'var(--text)',
              }}>
                Done. 2 carousels, a new headshot, and a teaser video are ready, and your
                week is scheduled: Tue, Thu, and Fri.
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

// 4) Likeness-locked outfit change, real before/after with a sweeping wipe.
function OutfitShowcase() {
  return (
    <section style={section} className="fade-up">
      <div className="ss-demo-grid">
        <div style={{ ...demoPanel, padding: 14 }}>
          <div style={demoKicker}><Wand2 size={12} /> Real output, likeness locked</div>
          <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', background: '#f3f0ea', aspectRatio: '5 / 6' }}>
            <img
              src="/landing/demo/outfit-after.jpg" alt="AI outfit change result: burgundy blazer, same likeness"
              loading="lazy" decoding="async"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }}
            />
            <img
              src="/landing/demo/outfit-before.webp" alt="Original reference photo before the AI outfit change"
              loading="lazy" decoding="async"
              style={{
                position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top',
                background: '#f3f0ea', animation: 'ssWipe 7s ease-in-out infinite',
              }}
            />
            <div style={{
              position: 'absolute', top: 0, bottom: 0, width: 2, background: 'rgba(0,0,0,0.55)',
              boxShadow: '0 0 12px rgba(0,0,0,0.35)', animation: 'ssWipeLine 7s ease-in-out infinite',
            }} />
            <span style={{ position: 'absolute', top: 10, left: 10, fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', padding: '3px 8px', borderRadius: 999, background: 'rgba(0,0,0,0.55)', color: '#fff' }}>BEFORE</span>
            <span style={{ position: 'absolute', top: 10, right: 10, fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', padding: '3px 8px', borderRadius: 999, background: 'rgba(0,0,0,0.55)', color: '#fff' }}>AFTER</span>
          </div>
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ ...demoMono, fontSize: 11, padding: '5px 10px', borderRadius: 999, background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-soft)' }}>
              "@ray in a burgundy blazer"
            </span>
            <span style={{ fontSize: 11, color: '#2ecc71', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Check size={12} /> Likeness locked</span>
          </div>
        </div>
        <div className="showcase-copy">
          <div className="feat-eyebrow">The creative studio</div>
          <h2 className="showcase-title">Change the outfit, not the photoshoot.</h2>
          <p className="showcase-body">
            Upload one photo of yourself and regenerate it in any outfit, pose, or setting while
            your face stays exactly you. This example is one prompt on the ScaleSolo canvas.
            Use the results in carousels, thumbnails, and avatar videos.
          </p>
          <ul className="showcase-list">
            <li><Check size={14} /> One reference photo, unlimited wardrobe</li>
            <li><Check size={14} /> Drag any image onto the canvas and mention it with @</li>
            <li><Check size={14} /> Feeds straight into carousels and avatar videos</li>
            <li><Check size={14} /> Every render saves to your library automatically</li>
          </ul>
          <DemoCta stat="One photo in, unlimited wardrobe out" label="Try the studio free" />
        </div>
      </div>
    </section>
  )
}

// Sticky bottom CTA for phones — shows once the visitor scrolls past the
// hero so it never covers the hero's own Start free button.
function MobileCtaBar() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 480)
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  if (!show) return null
  return (
    <div className="ss-mobile-cta">
      <button className="btn-primary" onClick={scrollToPricing} style={{ width: '100%', justifyContent: 'center', padding: '13px 16px', fontSize: 14.5 }}>
        Start trial for free <ArrowRight size={14} />
      </button>
    </div>
  )
}

// Scroll helper shared by the section CTAs (mirrors the hero's goPricing).
function scrollToPricing() {
  document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// Outcome stat + contextual CTA + risk-reversal microcopy for demo sections.
function DemoCta({ stat, label }) {
  return (
    <div style={{ marginTop: 18 }}>
      {stat && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 999, background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.30)', color: 'var(--red)', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12, marginBottom: 12 }}>
          <Zap size={12} /> {stat}
        </div>
      )}
      <div>
        <button className="btn-primary" onClick={scrollToPricing} style={{ padding: '11px 20px', fontSize: 13.5 }}>
          {label} <ArrowRight size={13} />
        </button>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>3-day free trial. Cancel anytime. Keep everything you make.</div>
      </div>
    </div>
  )
}

function TestimonialsSection() {
  return (
    <section style={{ ...section, paddingTop: 24, paddingBottom: 24 }} className="fade-up">
      <h2 style={sectionH}>Founders run their whole brand on <span className="brand-text">ScaleSolo</span>.</h2>
      <p style={sectionSub}>From solo creators to agencies running four brands at once.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, maxWidth: 1080, margin: '0 auto' }}>
        {testimonials.map((t) => (
          <div key={t.name} style={{ padding: 20, borderRadius: 14, background: 'linear-gradient(160deg, rgba(255,255,255,0.045), rgba(255,255,255,0.015))', border: '1px solid rgba(255,255,255,0.10)', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 3 }}>
              {[0, 1, 2, 3, 4].map((i) => <Star key={i} size={13} fill="#f59e0b" stroke="none" />)}
            </div>
            <p style={{ fontSize: 13.5, color: 'var(--text-soft)', lineHeight: 1.6, flex: 1, margin: 0 }}>"{t.quote}"</p>
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 13.5, color: 'var(--text)' }}>{t.name}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t.role}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function FinalCta() {
  return (
    <section style={{ ...section, position: 'relative', textAlign: 'center', paddingTop: 60, paddingBottom: 90 }} className="fade-up">
      <div aria-hidden style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 680, height: 420, background: 'radial-gradient(ellipse, rgba(239,68,68,0.16), transparent 65%)', pointerEvents: 'none' }} />
      <h2 style={{ ...sectionH, position: 'relative' }}>
        Your next 30 days of content<br />are <span className="brand-text">one click away</span>.
      </h2>
      <p style={{ ...sectionSub, position: 'relative' }}>
        Design it, schedule it, and let ScaleSolo post it. You stay the creator. It stays the manager.
      </p>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap', position: 'relative' }}>
        <button className="btn-primary" onClick={scrollToPricing} style={{ padding: '14px 28px', fontSize: 15 }}>
          Start free <ArrowRight size={15} />
        </button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, position: 'relative' }}>3-day free trial. Cancel anytime. Keep everything you make.</div>
    </section>
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
  overflowX: 'clip',
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
  maxWidth: 1180, margin: '0 auto', padding: '41px 24px 20px',
  zIndex: 1,
  isolation: 'isolate',
}
// Single-column hero: H1 → video → subhead → CTAs → trust pills.
// Centred horizontally so the video sits visually under the headline
// rather than off to one side.
const heroGrid = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 24,
  maxWidth: 920,
  margin: '0 auto',
}
const heroCopy = { textAlign: 'center', width: '100%' }

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
  borderRadius: 18,
  overflow: 'hidden',
}
const shotImg = {
  width: '100%', height: 'auto', display: 'block',
  position: 'relative', zIndex: 1,
  borderRadius: 18,
  filter: 'drop-shadow(0 30px 60px rgba(0,0,0,0.55)) drop-shadow(0 0 40px rgba(239,68,68,0.18))',
  transition: 'transform 200ms ease-out',
  willChange: 'transform',
}

// Hero dashboard image with subtle 3D tilt that follows the cursor.
// Typewriter that cycles through a sequence of phrases. Types each
// one char-by-char, holds a beat, backspaces it, then advances to
// the next. Loops forever.
//
// Each phrase is { text, red? } — `red` is an array of substrings
// that should render in the brand-red gradient when typed; every
// other character is rendered white (var(--text)).
//
// Renders inline so it inherits the parent H1's alignment + wrap
// behavior. Parent H1 should reserve enough vertical room
// (min-height) so content below doesn't shift between phases.
function Typewriter({ phrases = [], typeSpeed = 55, backSpeed = 30, holdMs = 1400 }) {
  const [text, setText] = useState('')
  const [phase, setPhase] = useState('type')   // 'type' | 'hold' | 'back'
  const [idx, setIdx] = useState(0)            // which phrase
  // Normalize each phrase into a { text, red } shape so the render
  // path doesn't have to branch on whether the caller passed plain
  // strings or phrase objects.
  const norm = phrases.map((p) => (typeof p === 'string' ? { text: p, red: [] } : { text: p.text || '', red: p.red || [] }))
  const current = norm[idx] || { text: '', red: [] }
  useEffect(() => {
    let t
    if (phase === 'type') {
      if (text.length < current.text.length) {
        t = setTimeout(() => setText(current.text.slice(0, text.length + 1)), typeSpeed)
      } else {
        t = setTimeout(() => setPhase('hold'), holdMs)
      }
    } else if (phase === 'hold') {
      t = setTimeout(() => setPhase('back'), holdMs)
    } else if (phase === 'back') {
      if (text.length > 0) {
        t = setTimeout(() => setText(text.slice(0, -1)), backSpeed)
      } else {
        setIdx((idx + 1) % norm.length)
        setPhase('type')
      }
    }
    return () => clearTimeout(t)
  }, [text, phase, idx, current.text, typeSpeed, backSpeed, holdMs, norm.length])
  // Resolve red highlight substrings into [start, end) index ranges
  // against the current phrase. Substrings missing from the phrase
  // (typo, etc) are silently dropped.
  const redRanges = current.red
    .map((sub) => {
      const s = current.text.indexOf(sub)
      return s === -1 ? null : [s, s + sub.length]
    })
    .filter(Boolean)
  // Walk the currently-typed substring and split it into white and
  // red-gradient segments based on whether each character index
  // falls inside one of the red ranges.
  const segments = []
  let i = 0
  while (i < text.length) {
    const inRed = redRanges.find(([s, e]) => i >= s && i < e)
    if (inRed) {
      const end = Math.min(text.length, inRed[1])
      segments.push({ red: true, str: text.slice(i, end), key: i })
      i = end
    } else {
      const nextRedStart = redRanges
        .map(([s]) => s)
        .filter((s) => s > i)
        .reduce((min, s) => Math.min(min, s), text.length)
      const end = Math.min(nextRedStart, text.length)
      segments.push({ red: false, str: text.slice(i, end), key: i })
      i = end
    }
  }
  return (
    <>
      {segments.map((seg) =>
        seg.red ? (
          <span key={seg.key} className="brand-text">{seg.str}</span>
        ) : (
          <span key={seg.key} style={{ color: 'var(--text)' }}>{seg.str}</span>
        )
      )}
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: '2px',
          marginLeft: 4,
          background: 'var(--text)',
          height: '0.95em',
          verticalAlign: 'middle',
          animation: 'caretBlink 1s steps(2, start) infinite',
        }}
      />
    </>
  )
}

function HeroShot({ src, muted, onToggleMute }) {
  const cardRef = useRef(null)
  const mediaRef = useRef(null)
  // Treat any URL ending in a known video extension as a video so the
  // hero can be either an image or an autoplay loop, controlled by
  // the HERO_IMAGE constant alone. The 3D-tilt interaction works on
  // both <img> and <video>.
  const isVideo = /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(String(src || ''))
  // Defer the video mount until after first paint so its network
  // fetch doesn't block Playwright's networkidle wait in CI smoke
  // tests (a hanging video resource was timing out the test at 30s).
  // Real users see no visual difference — the video appears within
  // an animation frame of hydration.
  const [showVideo, setShowVideo] = useState(false)
  useEffect(() => {
    if (!isVideo) return
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(() => setShowVideo(true), { timeout: 500 })
      : window.requestAnimationFrame(() => setShowVideo(true))
    return () => {
      if (window.cancelIdleCallback && window.requestIdleCallback) window.cancelIdleCallback(idle)
      else window.cancelAnimationFrame(idle)
    }
  }, [isVideo])
  const handleMove = (e) => {
    const el = cardRef.current
    const media = mediaRef.current
    if (!el || !media) return
    const r = el.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width  // 0..1
    const py = (e.clientY - r.top) / r.height
    const rx = (0.5 - py) * 8   // tilt up/down
    const ry = (px - 0.5) * 10  // tilt left/right
    media.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) scale(1.02)`
  }
  const handleLeave = () => {
    if (mediaRef.current) mediaRef.current.style.transform = 'perspective(900px) rotateX(0deg) rotateY(0deg) scale(1)'
  }
  return (
    <div ref={cardRef} style={shotCard} onMouseMove={handleMove} onMouseLeave={handleLeave}>
      {isVideo ? (
        showVideo ? (
          <>
            <video
              ref={mediaRef}
              src={src}
              autoPlay
              muted={muted}
              loop
              playsInline
              preload="metadata"
              aria-label="ScaleSolo product demo"
              style={shotImg}
              onError={(e) => { e.currentTarget.style.opacity = '0' }}
            />
            {/* Unmute toggle — overlays the video frame. Click stops
                propagation so it doesn't trigger the parent tilt
                handlers. Sits over the bottom-right corner. */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleMute?.() }}
              aria-label={muted ? 'Unmute video' : 'Mute video'}
              title={muted ? 'Unmute' : 'Mute'}
              style={{
                position: 'absolute',
                right: 12, bottom: 12,
                width: 44, height: 44,
                borderRadius: 999,
                background: 'rgba(0, 0, 0, 0.55)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                border: '1px solid rgba(255, 255, 255, 0.18)',
                color: '#fff',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer',
                zIndex: 3,
                transition: 'transform 120ms var(--ease), background 120ms var(--ease)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.08)'; e.currentTarget.style.background = 'rgba(0,0,0,0.75)' }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = ''; e.currentTarget.style.background = 'rgba(0,0,0,0.55)' }}
            >
              {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
          </>
        ) : (
          // Placeholder during the brief post-paint window before the
          // <video> mounts. Keeps the frame from collapsing and matches
          // the same dimensions the video will take.
          <div ref={mediaRef} style={{ ...shotImg, background: 'rgba(255,255,255,0.04)' }} />
        )
      ) : (
        <img
          loading="lazy" decoding="async"
          ref={mediaRef}
          src={src}
          alt="ScaleSolo dashboard"
          style={shotImg}
          onError={(e) => { e.currentTarget.style.opacity = '0' }}
        />
      )}
    </div>
  )
}

// ── Feature cards (with CSS-animated dash mocks) ────────────────────
function KillCard({ Icon, name, cost, delay = 0 }) {
  return (
    <div className="kill-card lift" style={{ animationDelay: `${delay * 80}ms` }}>
      <div className="kill-card-glow" aria-hidden />
      <div className="kill-card-icon"><Icon size={18} strokeWidth={2.2} /></div>
      <div className="kill-card-name">{name}</div>
      <div className="kill-card-row">
        <span className="kill-card-cost">{cost}</span>
        <span className="kill-card-stamp">REPLACED</span>
      </div>
    </div>
  )
}

function FaqItem({ q, children }) {
  return (
    <details className="faq-item">
      <summary className="faq-q">
        <span>{q}</span>
        <span aria-hidden className="faq-chev">+</span>
      </summary>
      <div className="faq-a">{children}</div>
    </details>
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

function UseCaseCard({ Icon, tag, title, body, steps }) {
  return (
    <div className="usecase-card lift">
      <div className="usecase-icon"><Icon size={22} strokeWidth={2.2} /></div>
      <div className="usecase-tag">{tag}</div>
      <div className="usecase-title">{title}</div>
      <p className="usecase-body">{body}</p>
      <ul className="usecase-steps">
        {steps.map((s) => (
          <li key={s}><Check size={12} /> {s}</li>
        ))}
      </ul>
    </div>
  )
}

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
