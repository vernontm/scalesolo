import { useNavigate } from 'react-router-dom'
import {
  Zap, ArrowRight, Check, Sparkles, Boxes, UserCircle2, Calendar,
  Layers, Wand2, RefreshCw, ShieldCheck, Quote,
} from 'lucide-react'
import PricingPlans from '../components/PricingPlans.jsx'

// Marketing landing page for scalesolo.ai. Renders only when the visitor
// is signed out (App.jsx routes "/" → Landing for that case). Re-skinned
// to use the same theme tokens (var(--bg/surface/border/...)) and utility
// classes (.btn-primary, .btn-secondary, .brand-text, .fade-up) that the
// /pricing page uses, so the look-and-feel is consistent with the rest
// of the app's dark theme. No vendor names appear in user-facing copy.

const HERO_IMG   = '/landing/hero-poster.jpg'   // first-frame still extracted from HERO_VIDEO; shows instantly while the video loads
const HERO_VIDEO = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/scalesolo_dash.mp4'
const FEAT_IMG_BUILD   = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/shared/workflow_landing.mp4'
const FEAT_IMG_RUN     = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/autoscheduling_landing.png'
const FEAT_IMG_AVATAR  = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/shared/avatar_landing_video.mp4'

const trustLogos = [
  { name: 'TikTok' }, { name: 'Instagram' }, { name: 'YouTube' },
  { name: 'X' }, { name: 'LinkedIn' }, { name: 'Pinterest' },
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

export default function Landing() {
  const nav = useNavigate()
  const goSignup = () => nav('/login')

  return (
    <div style={page}>
      {/* ── NAV ─────────────────────────────────────────────────────── */}
      <header style={navBar}>
        <div style={navInner}>
          <div style={brand}>
            <div style={brandIcon}><Zap size={14} fill="#fff" stroke="none" /></div>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16 }}>ScaleSolo</span>
          </div>
          <nav style={navLinks}>
            <a href="#features" style={navLink}>Features</a>
            <a href="#templates" style={navLink}>Templates</a>
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
      <section style={hero} className="fade-up">
        {/* Glow column behind the headline */}
        <div aria-hidden style={heroGlow} />

        {/* Eyebrow — pricing-style red pill */}
        <div style={eyebrowWrap}>
          <span style={eyebrow}>
            <Sparkles size={11} strokeWidth={2.5} /> 9 steps to a content engine that never stops
          </span>
        </div>

        <h1 style={heroH1}>
          Set up once.<br /><span className="brand-text">Post forever.</span>
        </h1>
        <p style={heroSub}>
          ScaleSolo writes posts in your voice, films them with your AI avatar, and ships them to TikTok, Instagram, YouTube, X, and LinkedIn — on the cadence you set, without you ever opening the app again.
        </p>
        <div style={heroCtas}>
          <button onClick={goSignup} className="btn-primary" style={ctaSizing}>
            Start free <ArrowRight size={14} />
          </button>
          <a href="#features" className="btn-secondary" style={ctaSizing}>
            See how it works
          </a>
        </div>
        <div style={trustPills}>
          <span style={pill}><Check size={11} /> No credit card required</span>
          <span style={pill}><Check size={11} /> 5-min setup</span>
          <span style={pill}><Check size={11} /> Cancel anytime</span>
        </div>

        {/* Hero video card with under-glow */}
        <div style={shotWrap}>
          <div aria-hidden style={shotGlow} />
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
      </section>

      {/* ── PLATFORM TRUST STRIP ────────────────────────────────────── */}
      <section style={trustSection}>
        <div style={trustEyebrow}>
          Posts where your audience already is
        </div>
        <div style={logoRow}>
          {trustLogos.map((l) => (
            <div key={l.name} style={logoChip}>{l.name}</div>
          ))}
        </div>
      </section>

      {/* ── FEATURES ────────────────────────────────────────────────── */}
      <section id="features" style={section} className="fade-up">
        <h2 style={sectionH}>Automate your content in minutes</h2>
        <p style={sectionSub}>Everything you need to publish daily — without writing a script, hitting record, or opening an editor.</p>
        <div style={featuresGrid}>
          {features.map((f) => (
            <div key={f.title} style={featureCard}>
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

      {/* ── VALUE GRID ──────────────────────────────────────────────── */}
      <section style={section} className="fade-up">
        <h2 style={sectionH}>Built for solo creators who refuse to babysit content</h2>
        <div style={valueGridStyle}>
          {valueGrid.map((v) => (
            <div key={v.title} style={valueCard}>
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
      <section id="testimonials" style={section} className="fade-up">
        <h2 style={sectionH}>Loved by creators who refuse to be on a content treadmill</h2>
        <div style={testimonialGrid}>
          {testimonials.map((t) => (
            <div key={t.name} style={testimonialCard}>
              <Quote size={14} style={{ color: 'var(--red)', opacity: 0.7, marginBottom: 10 }} />
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
      {/* Reuses the shared <PricingPlans /> component so this stays in
          lockstep with /pricing — same founding banner, same monthly /
          annual toggle, same tier copy. Unauthenticated subscribe clicks
          route to /login (the signup page). */}
      <section id="pricing" style={section} className="fade-up">
        <h2 style={sectionH}>Choose what fits you</h2>
        <p style={sectionSub}>All tiers include unlimited workflows, social scheduling, and brand-voice generation. Pick by output volume.</p>
        <PricingPlans />
      </section>

      {/* ── FINAL CTA ───────────────────────────────────────────────── */}
      <section style={finalCta}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 36, margin: 0, marginBottom: 12, color: 'var(--text)' }}>
          Stop writing the same caption every Monday.
        </h2>
        <p style={{ fontSize: 16, color: 'var(--text-soft)', maxWidth: 520, margin: '0 auto 28px' }}>
          Wire up one workflow. Let it run. Spend the rest of your week building the thing you actually want to build.
        </p>
        <button onClick={goSignup} className="btn-primary" style={ctaSizing}>
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

function TemplateCard({ title, blurb, tags }) {
  return (
    <div style={templateCard}>
      <div style={templateGlow} />
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

// ─── styles ───────────────────────────────────────────────────────────
// All surfaces, borders, and text use theme tokens so the page mirrors
// the /pricing aesthetic. Brand-red glows are kept for energy.
const page = {
  background: 'var(--bg)',
  color: 'var(--text)',
  minHeight: '100vh',
  fontFamily: 'var(--font-body, system-ui, sans-serif)',
  position: 'relative',
  overflowX: 'hidden',
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

const hero = {
  position: 'relative',
  maxWidth: 1180, margin: '0 auto', padding: '90px 24px 0',
  textAlign: 'center',
  zIndex: 1,
}
const heroGlow = {
  position: 'absolute', top: 60, left: '50%', transform: 'translateX(-50%)',
  width: 520, height: 520,
  background: 'radial-gradient(circle, rgba(239,68,68,0.45), rgba(239,68,68,0) 70%)',
  filter: 'blur(60px)', pointerEvents: 'none', zIndex: -1,
}
const eyebrowWrap = { display: 'flex', justifyContent: 'center', marginBottom: 22 }
const eyebrow = {
  display: 'inline-flex', alignItems: 'center', gap: 8,
  background: 'var(--red-soft)',
  color: 'var(--red)',
  fontFamily: 'var(--font-display)',
  fontWeight: 700, fontSize: 11,
  letterSpacing: '0.10em', textTransform: 'uppercase',
  padding: '7px 14px', borderRadius: 999,
  border: '1px solid rgba(239,68,68,0.30)',
}
const heroH1 = {
  fontFamily: 'var(--font-display)', fontWeight: 800,
  fontSize: 'clamp(40px, 6vw, 68px)', lineHeight: 1.05,
  margin: 0, marginBottom: 20, letterSpacing: '-0.02em',
  color: 'var(--text)',
}
const heroSub = {
  fontSize: 16.5, color: 'var(--text-soft)',
  maxWidth: 620, margin: '0 auto 28px', lineHeight: 1.55,
}
const heroCtas = { display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }
const ctaSizing = { padding: '12px 22px', fontSize: 14, justifyContent: 'center' }
const trustPills = { display: 'flex', justifyContent: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 50 }
const pill = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  fontSize: 12, color: 'var(--text-soft)',
  background: 'var(--surface-2)', padding: '6px 12px',
  borderRadius: 999, border: '1px solid var(--border)',
}
const shotWrap = { position: 'relative', marginTop: 40, marginBottom: 80 }
const shotGlow = {
  position: 'absolute', left: '50%', bottom: -30, transform: 'translateX(-50%)',
  width: '90%', height: 320,
  background: 'radial-gradient(ellipse at center, rgba(239,68,68,0.5), rgba(239,68,68,0) 70%)',
  filter: 'blur(70px)', pointerEvents: 'none', zIndex: 0,
}
const shotCard = {
  position: 'relative', zIndex: 1,
  borderRadius: 18, overflow: 'hidden',
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  boxShadow: 'var(--shadow-pop, 0 30px 80px rgba(0,0,0,0.45))',
  aspectRatio: '16/10',
  display: 'grid', placeItems: 'center',
}
const shotImg = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' }
const shotPlaceholder = {
  textAlign: 'center', color: 'var(--muted)', padding: 40,
  display: 'flex', flexDirection: 'column', alignItems: 'center',
}

const trustSection = { padding: '40px 24px 60px', background: 'var(--surface-2)', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }
const trustEyebrow = {
  fontSize: 12, color: 'var(--muted)', textAlign: 'center',
  marginBottom: 18, letterSpacing: '0.10em', textTransform: 'uppercase',
  fontFamily: 'var(--font-display)', fontWeight: 700,
}
const logoRow = {
  maxWidth: 1180, margin: '0 auto',
  display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 32, alignItems: 'center',
  opacity: 0.7,
}
const logoChip = {
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16,
  color: 'var(--text-soft)', letterSpacing: '0.02em',
}

const section = { maxWidth: 1180, margin: '0 auto', padding: '90px 24px' }
const sectionH = {
  fontFamily: 'var(--font-display)', fontWeight: 800,
  fontSize: 'clamp(28px, 3.5vw, 40px)', textAlign: 'center', margin: 0, marginBottom: 14,
  letterSpacing: '-0.01em', color: 'var(--text)',
}
const sectionSub = {
  fontSize: 16, color: 'var(--text-soft)', textAlign: 'center',
  maxWidth: 600, margin: '0 auto 50px', lineHeight: 1.5,
}

const featuresGrid = {
  display: 'grid', gap: 18,
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
}
const featureCard = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 18, overflow: 'hidden',
  display: 'flex', flexDirection: 'column',
  boxShadow: 'var(--shadow-card)',
  transition: 'transform 200ms var(--ease), box-shadow 200ms var(--ease)',
}
const featureCardImg = {
  aspectRatio: '16/9', background: 'var(--surface-2)',
  borderBottom: '1px solid var(--border)',
  position: 'relative', overflow: 'hidden',
}
const featureTitle = { fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18, marginBottom: 8, color: 'var(--text)' }
const featureBody = { fontSize: 13.5, color: 'var(--text-soft)', lineHeight: 1.55 }

const valueGridStyle = {
  display: 'grid', gap: 14,
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
}
const valueCard = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 14, padding: '24px 22px',
  boxShadow: 'var(--shadow-card)',
}

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

const testimonialGrid = {
  display: 'grid', gap: 14,
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
}
const testimonialCard = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 14, padding: '22px 20px',
  display: 'flex', flexDirection: 'column', gap: 14,
  boxShadow: 'var(--shadow-card)',
}
const testimonialQuote = { fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-soft)', fontStyle: 'italic' }
const testimonialName = { display: 'flex', alignItems: 'center', gap: 10 }
const testimonialAvatar = {
  width: 32, height: 32, borderRadius: 999,
  background: 'linear-gradient(135deg, rgba(239,68,68,0.6), rgba(168,85,247,0.5))',
  color: '#fff', display: 'grid', placeItems: 'center',
  fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700,
}

const finalCta = {
  textAlign: 'center', maxWidth: 720, margin: '60px auto 100px',
  padding: '60px 24px',
  background: 'radial-gradient(ellipse at center, rgba(239,68,68,0.12), rgba(239,68,68,0) 70%)',
}

const footer = {
  borderTop: '1px solid var(--border)',
  background: 'var(--surface-2)',
  marginTop: 60,
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
