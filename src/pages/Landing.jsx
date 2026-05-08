import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Zap, ArrowRight, Check, Sparkles, Boxes, UserCircle2, Calendar,
  Layers, Wand2, RefreshCw, ShieldCheck, Quote, Play,
  Instagram, Youtube, Twitter, Linkedin, Music2, Captions as CaptionsIcon,
} from 'lucide-react'
import PricingPlans from '../components/PricingPlans.jsx'

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

const HERO_IMG   = '/landing/hero-poster.jpg'   // first-frame still extracted from HERO_VIDEO; shows instantly while the video loads
const HERO_VIDEO = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/scalesolo_dash.mp4'
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
  { icon: RefreshCw,   title: 'Auto-run forever',     body: 'Pick a cadence — every hour, every day, every week — and the workflow runs without you.' },
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

// 4-node mock that mirrors the actual in-app Spaces canvas. The
// connectors are SVG paths animated via stroke-dashoffset (flowDash).
const canvasNodes = [
  { Icon: Wand2,        title: 'Script generator',  status: 'DONE', tint: '#ef4444', preview: 'Pick a fresh angle for short-form…' },
  { Icon: UserCircle2,  title: 'Avatar render',     status: 'DONE', tint: '#a855f7', preview: '6 clips · cycle looks' },
  { Icon: CaptionsIcon, title: 'Captions + title',  status: 'DONE', tint: '#f59e0b', preview: 'Burn-in · Poppins ExtraBold' },
  { Icon: Calendar,     title: 'Schedule',          status: 'RUN',  tint: '#22c55e', preview: 'TikTok · IG · YT · X · LI' },
]

export default function Landing() {
  const nav = useNavigate()
  const goSignup = () => nav('/login')

  // Lock the public landing to the dark brand palette regardless of any
  // light theme an app user may have persisted. The CSS-var overrides
  // on the page wrapper (see `page` style) take care of everything
  // *inside* the landing — this effect only forces body background +
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
      {/* Floating particle field — sits behind everything, decorative only */}
      <ParticleField />

      {/* ── NAV ─────────────────────────────────────────────────────── */}
      <header style={navBar}>
        <div style={navInner}>
          <div style={brand}>
            <div style={brandIcon}><Zap size={14} fill="#fff" stroke="none" /></div>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16 }}>ScaleSolo</span>
          </div>
          <nav style={navLinks}>
            <a href="#features" style={navLink}>Features</a>
            <a href="#canvas" style={navLink}>How it works</a>
            <a href="#testimonials" style={navLink}>Loved by</a>
            <a href="#pricing" style={navLink}>Pricing</a>
          </nav>
          <div style={navCta}>
            <button onClick={goSignup} className="btn-ghost" style={{ fontSize: 13 }}>Sign in</button>
            <button onClick={goSignup} className="btn-primary">Start free <ArrowRight size={13} /></button>
          </div>
        </div>
      </header>

      {/* ── HERO ────────────────────────────────────────────────────── */}
      <section style={hero}>
        {/* Rising-flame glow stack — 4 layers, two animations
            so the bloom breathes AND drifts sideways slightly. */}
        <div aria-hidden style={{ ...heroFlameOuter, animation: 'auroraPulse 6.5s var(--ease) infinite, auroraDrift 11s var(--ease) infinite' }} />
        <div aria-hidden style={{ ...heroFlameMid,   animation: 'auroraPulse 5.5s var(--ease) infinite' }} />
        <div aria-hidden style={heroFlameCore} />
        <div aria-hidden style={heroFlameWisp} />

        <div className="fade-up" style={{ animationDelay: '40ms' }}>
          <div style={eyebrowWrap}>
            <span style={eyebrow}>
              <Sparkles size={11} strokeWidth={2.5} /> 9 steps to a content engine that never stops
            </span>
          </div>
        </div>
        <h1 style={heroH1} className="fade-up">
          Set up once.<br /><span className="brand-text">Post forever.</span>
        </h1>
        <p style={heroSub} className="fade-up" >
          ScaleSolo writes posts in your voice, films them with your AI avatar, and ships them to TikTok, Instagram, YouTube, X, and LinkedIn — on the cadence you set, without you ever opening the app again.
        </p>
        <div style={heroCtas} className="fade-up">
          <button onClick={goSignup} className="btn-primary" style={ctaSizing}>
            Start free <ArrowRight size={14} />
          </button>
          <a href="#canvas" className="btn-secondary" style={ctaSizing}>
            <Play size={13} fill="currentColor" /> See how it works
          </a>
        </div>
        <div style={trustPills} className="fade-up">
          <span style={pill}><Check size={11} /> No credit card required</span>
          <span style={pill}><Check size={11} /> 5-min setup</span>
          <span style={pill}><Check size={11} /> Cancel anytime</span>
        </div>

        {/* Hero video card with rotating conic-gradient halo */}
        <div style={shotWrap} className="fade-up">
          <div aria-hidden style={shotUnderGlow} />
          <div style={shotFrame}>
            {/* The animated halo: a giant conic gradient masked to a ring,
                rotated continuously. Sits behind the card. */}
            <div aria-hidden style={{ ...shotHalo, animation: 'glowSpin 12s linear infinite' }} />
            <div style={shotCard}>
              <video
                src={HERO_VIDEO}
                poster={HERO_IMG}
                autoPlay loop muted playsInline preload="metadata"
                aria-label="ScaleSolo Spaces canvas demo"
                style={shotImg}
                onError={(e) => { e.currentTarget.style.opacity = '0' }}
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── PLATFORM TRUST STRIP ────────────────────────────────────── */}
      <section style={trustSection}>
        <div style={trustEyebrow}>
          Posts where your audience already is
        </div>
        <div style={logoRow}>
          {trustLogos.map(({ name, Icon, tint }) => (
            <div key={name} style={{ ...logoChip, color: tint, borderColor: `${tint}33` }}>
              <Icon size={16} strokeWidth={2.2} />
              <span style={{ color: 'var(--text-soft)' }}>{name}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── FEATURES ────────────────────────────────────────────────── */}
      <section id="features" style={section} className="fade-up">
        <h2 style={sectionH}>Automate your content in minutes</h2>
        <p style={sectionSub}>Everything you need to publish daily — without writing a script, hitting record, or opening an editor.</p>
        <div style={featuresGrid}>
          {features.map((f) => (
            <div key={f.title} style={featureCard} className="lift">
              <div style={featureCardImg}>
                {/\.(mp4|webm|mov)(\?|$)/i.test(f.img) ? (
                  <video src={f.img} autoPlay loop muted playsInline preload="metadata"
                    aria-label={f.title}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    onError={(e) => { e.currentTarget.style.display = 'none' }}
                  />
                ) : (
                  <img src={f.img} alt={f.title} style={{ width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'center' }}
                    onError={(e) => { e.currentTarget.style.display = 'none' }}
                  />
                )}
              </div>
              <div style={{ padding: '20px 22px' }}>
                <f.icon size={18} style={{ color: 'var(--red)', marginBottom: 10 }} />
                <div style={featureTitle}>{f.title}</div>
                <div style={featureBody}>{f.body}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── MOCK SPACES CANVAS ──────────────────────────────────────── */}
      <section id="canvas" style={section} className="fade-up">
        <h2 style={sectionH}>Drag, drop, ship.</h2>
        <p style={sectionSub}>Wire your workflow once on the visual canvas. Click Run. Walk away. Forever.</p>
        <CanvasMock />
      </section>

      {/* ── VALUE GRID ──────────────────────────────────────────────── */}
      <section style={section} className="fade-up">
        <h2 style={sectionH}>Built for solo creators who refuse to babysit content</h2>
        <div style={valueGridStyle}>
          {valueGrid.map((v) => (
            <div key={v.title} style={valueCard} className="lift">
              <v.icon size={20} style={{ color: 'var(--red)', marginBottom: 12 }} />
              <div style={featureTitle}>{v.title}</div>
              <div style={featureBody}>{v.body}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── TEMPLATES ───────────────────────────────────────────────── */}
      <section id="templates" style={section} className="fade-up">
        <h2 style={sectionH}>Start faster with pre-built workflows</h2>
        <p style={sectionSub}>Clone a template, point it at your brand, hit Auto Run.</p>
        <div style={templatesRow}>
          <TemplateCard
            title="AI Podcaster"
            blurb="Script → avatar render → finish video → schedule. The flagship hands-off pipeline."
            tags={['Auto-run', 'Cycle looks', 'Multi-platform']}
          />
          <TemplateCard
            title="Lead-magnet shorts"
            blurb="Write a hook for tomorrow's lead magnet. Caption it, watermark it, post it everywhere."
            tags={['B2B', 'Daily cadence']}
          />
          <TemplateCard
            title="Audio-first reels"
            blurb="Drop a 60-second voice memo. ScaleSolo transcribes, slices, renders 9 clips, stitches, ships."
            tags={['Audio upload', 'Auto-title']}
          />
        </div>
      </section>

      {/* ── TESTIMONIALS ────────────────────────────────────────────── */}
      <section id="testimonials" style={{ ...section, position: 'relative' }} className="fade-up">
        {/* Soft scattered red glows behind the testimonial grid */}
        <div aria-hidden style={{ ...sectionAura, top: '15%', left: '10%' }} />
        <div aria-hidden style={{ ...sectionAura, bottom: '10%', right: '12%', width: 360, height: 360 }} />
        <h2 style={sectionH}>Loved by creators who refuse to be on a content treadmill</h2>
        <div style={testimonialGrid}>
          {testimonials.map((t) => (
            <div key={t.name} style={testimonialCard} className="lift">
              <div style={quoteBadge}><Quote size={11} strokeWidth={2.5} /></div>
              <div style={testimonialQuote}>{t.quote}</div>
              <div style={testimonialName}>
                <div style={testimonialAvatar}>{t.name.split(' ').map((s) => s[0]).join('').slice(0, 2)}</div>
                <div>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13 }}>{t.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t.role}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── PRICING ─────────────────────────────────────────────────── */}
      <section id="pricing" style={{ ...section, position: 'relative' }} className="fade-up">
        <div aria-hidden style={{ ...sectionAura, top: '40%', left: '50%', transform: 'translate(-50%, -50%)', width: 720, height: 480, opacity: 0.55 }} />
        <h2 style={sectionH}>Choose what fits you</h2>
        <p style={sectionSub}>All tiers include unlimited workflows, social scheduling, and brand-voice generation. Pick by output volume.</p>
        <PricingPlans />
      </section>

      {/* ── FINAL CTA ───────────────────────────────────────────────── */}
      <section style={finalCta}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'clamp(28px, 4vw, 44px)', margin: 0, marginBottom: 12, color: 'var(--text)', letterSpacing: '-0.02em' }}>
          Stop writing the same caption every Monday.
        </h2>
        <p style={{ fontSize: 16, color: 'var(--text-soft)', maxWidth: 520, margin: '0 auto 28px' }}>
          Wire up one workflow. Let it run. Spend the rest of your week building the thing you actually want to build.
        </p>
        <button onClick={goSignup} className="btn-primary" style={{ ...ctaSizing, padding: '14px 26px', fontSize: 15 }}>
          Start free <ArrowRight size={15} />
        </button>
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

// Decorative particle field — pure CSS dots with randomized animation
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

// Mock visual of the in-app Spaces canvas: 4 nodes wired up by SVG
// connectors with animated flowing dashes. The connector path is
// drawn from each node's right edge to the next node's left edge
// via a gentle Bézier curve.
function CanvasMock() {
  return (
    <div style={canvasFrame}>
      {/* Subtle grid backdrop, soft red wash */}
      <div aria-hidden style={canvasBackdrop} />

      {/* Connector lines behind the nodes */}
      <svg style={connectorSvg} viewBox="0 0 1000 220" preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id="wireGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"  stopColor="rgba(239,68,68,0.15)" />
            <stop offset="50%" stopColor="rgba(239,68,68,0.85)" />
            <stop offset="100%" stopColor="rgba(239,68,68,0.15)" />
          </linearGradient>
        </defs>
        {/* Three Bézier paths between the 4 nodes */}
        <path d="M 235,110 C 280,110 280,110 325,110" stroke="url(#wireGrad)" strokeWidth="2" fill="none" strokeDasharray="6 7" style={{ animation: 'flowDash 1.4s linear infinite' }} />
        <path d="M 485,110 C 530,110 530,110 575,110" stroke="url(#wireGrad)" strokeWidth="2" fill="none" strokeDasharray="6 7" style={{ animation: 'flowDash 1.4s linear infinite', animationDelay: '0.3s' }} />
        <path d="M 735,110 C 780,110 780,110 825,110" stroke="url(#wireGrad)" strokeWidth="2" fill="none" strokeDasharray="6 7" style={{ animation: 'flowDash 1.4s linear infinite', animationDelay: '0.6s' }} />
      </svg>

      {/* Nodes */}
      <div style={nodesRow}>
        {canvasNodes.map((n, i) => (
          <div
            key={n.title}
            style={{ ...nodeCard, animation: `nodeBreathe 4s var(--ease) ${i * 0.6}s infinite` }}
          >
            <div style={nodeHeader}>
              <div style={{ ...nodeIconBox, background: `${n.tint}1f`, color: n.tint }}>
                <n.Icon size={12} strokeWidth={2.4} />
              </div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 700 }}>{n.title}</div>
              <div style={{
                marginLeft: 'auto', fontSize: 9.5, fontFamily: 'var(--font-display)', fontWeight: 800,
                letterSpacing: '0.06em', padding: '2px 7px', borderRadius: 999,
                background: n.status === 'RUN' ? 'rgba(239,68,68,0.18)' : 'rgba(34,197,94,0.18)',
                color: n.status === 'RUN' ? '#ef4444' : '#22c55e',
                border: `1px solid ${n.status === 'RUN' ? 'rgba(239,68,68,0.35)' : 'rgba(34,197,94,0.35)'}`,
              }}>
                {n.status}
              </div>
            </div>
            <div style={nodePreview}>{n.preview}</div>
            <div style={nodePort('left')} />
            <div style={nodePort('right')} />
          </div>
        ))}
      </div>
    </div>
  )
}

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
  maxWidth: 1180, margin: '0 auto', padding: '110px 24px 0',
  textAlign: 'center',
  zIndex: 1,
  isolation: 'isolate',
}

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
  borderRadius: 18, overflow: 'hidden',
  border: '1px solid rgba(239,68,68,0.45)',
  background: 'var(--surface)',
  boxShadow: '0 30px 80px rgba(0,0,0,0.55), 0 0 60px rgba(239,68,68,0.18)',
  aspectRatio: '16/10',
  display: 'grid', placeItems: 'center',
}
const shotImg = { width: '100%', height: '100%', objectFit: 'cover', display: 'block', position: 'relative', zIndex: 1 }

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
const section = { maxWidth: 1180, margin: '0 auto', padding: '90px 24px', position: 'relative', zIndex: 1 }
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
const canvasFrame = {
  position: 'relative',
  maxWidth: 1100, margin: '0 auto',
  borderRadius: 22,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  padding: '50px 32px',
  overflow: 'hidden',
  boxShadow: 'var(--shadow-card), 0 0 80px rgba(239,68,68,0.10)',
  isolation: 'isolate',
}
const canvasBackdrop = {
  position: 'absolute', inset: 0,
  background:
    'radial-gradient(ellipse at 20% 30%, rgba(239,68,68,0.10), transparent 50%), ' +
    'radial-gradient(ellipse at 80% 70%, rgba(168,85,247,0.08), transparent 50%), ' +
    // 24px grid
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
const nodesRow = {
  position: 'relative', zIndex: 2,
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 24, flexWrap: 'wrap',
}
const nodeCard = {
  flex: '1 1 200px', minWidth: 200, maxWidth: 240,
  position: 'relative',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: '12px 14px',
  boxShadow: 'var(--shadow-card)',
}
const nodeHeader = {
  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
}
const nodeIconBox = {
  width: 22, height: 22, borderRadius: 6,
  display: 'grid', placeItems: 'center',
  border: '1px solid currentColor',
  flexShrink: 0,
}
const nodePreview = {
  fontSize: 11.5, color: 'var(--text-soft)', lineHeight: 1.5,
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 8, padding: '8px 10px',
  fontFamily: 'var(--font-display)',
}
function nodePort(side) {
  return {
    position: 'absolute', top: '50%',
    [side]: -5, transform: 'translateY(-50%)',
    width: 10, height: 10, borderRadius: '50%',
    background: 'var(--red)',
    boxShadow: '0 0 0 3px var(--surface), 0 0 8px rgba(239,68,68,0.6)',
  }
}

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
