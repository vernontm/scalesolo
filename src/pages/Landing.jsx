import { useNavigate } from 'react-router-dom'
import {
  Zap, ArrowRight, Check, Sparkles, Boxes, UserCircle2, Calendar,
  Layers, Wand2, RefreshCw, ShieldCheck, Quote,
} from 'lucide-react'

// Marketing landing page for scalesolo.ai. Renders only when the visitor
// is signed out (App.jsx routes "/" → Landing for that case). Inspired
// structure: hero w/ app screenshot + glow → trust strip → feature
// grid → templates → testimonials → pricing → footer.

const HERO_IMG  = '/landing/hero-spaces.png'   // 16:9 product shot, swap with generated asset
const FEAT_IMG_BUILD   = '/landing/feat-build.png'
const FEAT_IMG_RUN     = '/landing/feat-run.png'
const FEAT_IMG_AVATAR  = '/landing/feat-avatar.png'

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
    body: 'Train a HeyGen photo avatar from one selfie. Cycle outfits across runs so every video looks fresh.',
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
  { icon: Layers,      title: 'Brand-voice scripts',  body: 'Claude reads your brand bible + recent posts, drafts ideas in your voice, and dedupes against the last 12+ takes.' },
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

const tiers = [
  {
    name: 'Solo Starter', price: 49, blurb: 'One brand, hands-off content.',
    features: ['1 brand profile', '1 active workflow', '100K AI tokens / mo', '10 avatar videos / mo', 'Multi-platform scheduling'],
  },
  {
    name: 'Solo Pro', price: 79, blurb: 'The everything plan for serious creators.', popular: true,
    features: ['2 brand profiles', 'Unlimited workflows', '500K AI tokens / mo', '30 avatar videos / mo', 'Cycle-looks rotation', 'Workflow templates'],
  },
  {
    name: 'Solo Studio', price: 149, blurb: 'Multi-brand creators and tiny agencies.',
    features: ['5 brand profiles', '2M AI tokens / mo', '100 avatar videos / mo', 'Everything in Pro', 'Publish your own templates', 'Founder Slack access'],
  },
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
            <button onClick={goSignup} style={ghostBtn}>Sign in</button>
            <button onClick={goSignup} style={primaryBtn}>Start free <ArrowRight size={13} /></button>
          </div>
        </div>
      </header>

      {/* ── HERO ────────────────────────────────────────────────────── */}
      <section style={hero}>
        {/* Glow column behind the headline */}
        <div aria-hidden style={heroGlow} />
        <h1 style={heroH1}>
          A month of content<br /><span style={{ color: 'var(--red)' }}>in an afternoon.</span>
        </h1>
        <p style={heroSub}>
          ScaleSolo writes posts in your voice, films them with your AI avatar, captions and schedules them across every platform — automatically, on the cadence you set.
        </p>
        <div style={heroCtas}>
          <button onClick={goSignup} style={ctaPrimary}>Start free <ArrowRight size={14} /></button>
          <a href="#features" style={ctaGhost}>See how it works</a>
        </div>
        <div style={trustPills}>
          <span style={pill}><Check size={11} /> No credit card required</span>
          <span style={pill}><Check size={11} /> 5-min setup</span>
          <span style={pill}><Check size={11} /> Cancel anytime</span>
        </div>

        {/* App screenshot card with under-glow */}
        <div style={shotWrap}>
          <div aria-hidden style={shotGlow} />
          <div style={shotCard}>
            <img src={HERO_IMG} alt="ScaleSolo Spaces canvas" style={shotImg}
              onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement.classList.add('placeholder') }}
            />
            <div className="placeholder-fallback" style={shotPlaceholder}>
              <Sparkles size={32} style={{ opacity: 0.55, marginBottom: 10 }} />
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, opacity: 0.75 }}>
                Spaces canvas — drop your generated screenshot at /landing/hero-spaces.png
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── PLATFORM TRUST STRIP ────────────────────────────────────── */}
      <section style={trustSection}>
        <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginBottom: 18, letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'var(--font-display)', fontWeight: 700 }}>
          Posts where your audience already is
        </div>
        <div style={logoRow}>
          {trustLogos.map((l) => (
            <div key={l.name} style={logoChip}>{l.name}</div>
          ))}
        </div>
      </section>

      {/* ── FEATURES ────────────────────────────────────────────────── */}
      <section id="features" style={section}>
        <h2 style={sectionH}>Automate your content in minutes</h2>
        <p style={sectionSub}>Everything you need to publish daily — without writing a script, hitting record, or opening an editor.</p>
        <div style={featuresGrid}>
          {features.map((f, i) => (
            <div key={f.title} style={{ ...featureCard, gridColumn: i === 0 ? 'span 1' : 'span 1' }}>
              <div style={featureCardImg}>
                <img src={f.img} alt={f.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={(e) => { e.currentTarget.style.display = 'none' }}
                />
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
      <section style={section}>
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
      <section id="templates" style={section}>
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
      <section id="testimonials" style={section}>
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
      <section id="pricing" style={section}>
        <h2 style={sectionH}>Choose what fits you</h2>
        <p style={sectionSub}>All tiers include unlimited workflows, social scheduling, and brand-voice generation. Pick by output volume.</p>
        <div style={pricingRow}>
          {tiers.map((t) => (
            <div key={t.name} style={{ ...tierCard, ...(t.popular ? tierCardPopular : null) }}>
              {t.popular && <div style={popularBadge}>Most popular</div>}
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18 }}>{t.name}</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{t.blurb}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 18, marginBottom: 18 }}>
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 36 }}>${t.price}</span>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>/mo</span>
              </div>
              <button onClick={goSignup} style={t.popular ? ctaPrimary : ctaGhost}>{t.popular ? 'Get started' : 'Choose plan'}</button>
              <div style={{ height: 1, background: 'var(--border)', margin: '20px 0' }} />
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {t.features.map((f) => (
                  <li key={f} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, color: 'var(--text-soft)' }}>
                    <Check size={13} style={{ color: '#2ecc71', marginTop: 2, flexShrink: 0 }} /> {f}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* ── FINAL CTA ───────────────────────────────────────────────── */}
      <section style={finalCta}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 36, margin: 0, marginBottom: 12 }}>
          Stop writing the same caption every Monday.
        </h2>
        <p style={{ fontSize: 16, color: 'var(--muted)', maxWidth: 520, margin: '0 auto 28px' }}>
          Wire up one workflow. Let it run. Spend the rest of your week building the thing you actually want to build.
        </p>
        <button onClick={goSignup} style={{ ...ctaPrimary, fontSize: 14, padding: '12px 22px' }}>
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
const page = {
  background: '#0a0a0c',
  color: 'var(--text)',
  minHeight: '100vh',
  fontFamily: 'var(--font-body, system-ui, sans-serif)',
  position: 'relative',
  overflowX: 'hidden',
}

const navBar = {
  position: 'sticky', top: 0, zIndex: 30,
  background: 'rgba(10,10,12,0.78)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
}
const navInner = { maxWidth: 1180, margin: '0 auto', padding: '14px 24px', display: 'flex', alignItems: 'center', gap: 32 }
const brand = { display: 'flex', alignItems: 'center', gap: 8 }
const brandIcon = {
  width: 26, height: 26, borderRadius: 7,
  background: 'linear-gradient(135deg, var(--red), var(--red-dark, #c41e3a))',
  display: 'grid', placeItems: 'center',
}
const navLinks = { display: 'flex', gap: 24, flex: 1, justifyContent: 'center' }
const navLink = { fontSize: 13, color: 'var(--text-soft)', textDecoration: 'none', fontFamily: 'var(--font-display)', fontWeight: 600 }
const navCta = { display: 'flex', alignItems: 'center', gap: 10 }
const ghostBtn = {
  padding: '8px 14px', borderRadius: 8,
  background: 'transparent', border: '1px solid transparent',
  color: 'var(--text-soft)', fontSize: 13, fontFamily: 'var(--font-display)', fontWeight: 600,
  cursor: 'pointer',
}
const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '9px 16px', borderRadius: 999,
  background: 'linear-gradient(135deg, var(--red), var(--red-dark, #c41e3a))',
  border: 'none', color: '#fff', fontSize: 13,
  fontFamily: 'var(--font-display)', fontWeight: 700, cursor: 'pointer',
  boxShadow: '0 6px 16px rgba(239,68,68,0.32)',
}

const hero = {
  position: 'relative',
  maxWidth: 1180, margin: '0 auto', padding: '90px 24px 0',
  textAlign: 'center',
  zIndex: 1,
}
const heroGlow = {
  position: 'absolute', top: 60, left: '50%', transform: 'translateX(-50%)',
  width: 520, height: 520,
  background: 'radial-gradient(circle, rgba(239,68,68,0.55), rgba(239,68,68,0) 70%)',
  filter: 'blur(60px)', pointerEvents: 'none', zIndex: -1,
}
const heroH1 = {
  fontFamily: 'var(--font-display)', fontWeight: 800,
  fontSize: 'clamp(40px, 6vw, 68px)', lineHeight: 1.05,
  margin: 0, marginBottom: 20, letterSpacing: '-0.02em',
}
const heroSub = {
  fontSize: 16.5, color: 'var(--text-soft)',
  maxWidth: 560, margin: '0 auto 28px', lineHeight: 1.55,
}
const heroCtas = { display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }
const ctaPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: 8,
  padding: '12px 22px', borderRadius: 999,
  background: 'linear-gradient(135deg, var(--red), var(--red-dark, #c41e3a))',
  border: 'none', color: '#fff', fontSize: 14,
  fontFamily: 'var(--font-display)', fontWeight: 700, cursor: 'pointer',
  boxShadow: '0 10px 30px rgba(239,68,68,0.35)',
  textDecoration: 'none',
}
const ctaGhost = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '12px 22px', borderRadius: 999,
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  color: 'var(--text)', fontSize: 14, fontFamily: 'var(--font-display)', fontWeight: 700,
  cursor: 'pointer', textDecoration: 'none',
}
const trustPills = { display: 'flex', justifyContent: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 50 }
const pill = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  fontSize: 12, color: 'var(--text-soft)',
  background: 'rgba(255,255,255,0.03)', padding: '6px 12px',
  borderRadius: 999, border: '1px solid rgba(255,255,255,0.06)',
}
const shotWrap = { position: 'relative', marginTop: 40, marginBottom: 80 }
const shotGlow = {
  position: 'absolute', left: '50%', bottom: -30, transform: 'translateX(-50%)',
  width: '90%', height: 320,
  background: 'radial-gradient(ellipse at center, rgba(239,68,68,0.6), rgba(239,68,68,0) 70%)',
  filter: 'blur(70px)', pointerEvents: 'none', zIndex: 0,
}
const shotCard = {
  position: 'relative', zIndex: 1,
  borderRadius: 14, overflow: 'hidden',
  border: '1px solid rgba(255,255,255,0.08)',
  background: 'var(--surface)',
  boxShadow: '0 30px 80px rgba(239,68,68,0.18), 0 0 60px rgba(239,68,68,0.08)',
  aspectRatio: '16/10',
  display: 'grid', placeItems: 'center',
}
const shotImg = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' }
const shotPlaceholder = {
  textAlign: 'center', color: 'var(--muted)', padding: 40,
  display: 'flex', flexDirection: 'column', alignItems: 'center',
}

const trustSection = { padding: '40px 24px 60px', background: 'rgba(255,255,255,0.015)' }
const logoRow = {
  maxWidth: 1180, margin: '0 auto',
  display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 32, alignItems: 'center',
  opacity: 0.6,
}
const logoChip = {
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16,
  color: 'var(--text-soft)', letterSpacing: '0.02em',
}

const section = { maxWidth: 1180, margin: '0 auto', padding: '90px 24px' }
const sectionH = {
  fontFamily: 'var(--font-display)', fontWeight: 800,
  fontSize: 'clamp(28px, 3.5vw, 40px)', textAlign: 'center', margin: 0, marginBottom: 14,
  letterSpacing: '-0.01em',
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
  background: 'var(--surface)', border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 14, overflow: 'hidden',
  display: 'flex', flexDirection: 'column',
  transition: 'transform 200ms ease, box-shadow 200ms ease',
}
const featureCardImg = {
  aspectRatio: '16/9', background: 'var(--surface-2)',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
  position: 'relative', overflow: 'hidden',
}
const featureTitle = { fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18, marginBottom: 8 }
const featureBody = { fontSize: 13.5, color: 'var(--text-soft)', lineHeight: 1.55 }

const valueGridStyle = {
  display: 'grid', gap: 14,
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
}
const valueCard = {
  background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 12, padding: '24px 22px',
}

const templatesRow = {
  display: 'grid', gap: 16,
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
}
const templateCard = {
  position: 'relative', overflow: 'hidden',
  background: 'var(--surface)', border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 14, padding: '24px 22px', minHeight: 180,
}
const templateGlow = {
  position: 'absolute', top: -50, right: -50, width: 220, height: 220,
  background: 'radial-gradient(circle, rgba(239,68,68,0.25), rgba(239,68,68,0) 70%)',
  filter: 'blur(40px)', pointerEvents: 'none',
}
const tagChip = {
  fontSize: 11, color: 'var(--red)',
  background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)',
  padding: '3px 8px', borderRadius: 999,
  fontFamily: 'var(--font-display)', fontWeight: 700,
}

const testimonialGrid = {
  display: 'grid', gap: 14,
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
}
const testimonialCard = {
  background: 'var(--surface)', border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 12, padding: '22px 20px',
  display: 'flex', flexDirection: 'column', gap: 14,
}
const testimonialQuote = { fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-soft)', fontStyle: 'italic' }
const testimonialName = { display: 'flex', alignItems: 'center', gap: 10 }
const testimonialAvatar = {
  width: 32, height: 32, borderRadius: 999,
  background: 'linear-gradient(135deg, rgba(239,68,68,0.6), rgba(168,85,247,0.5))',
  color: '#fff', display: 'grid', placeItems: 'center',
  fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700,
}

const pricingRow = {
  display: 'grid', gap: 14,
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  alignItems: 'stretch',
}
const tierCard = {
  background: 'var(--surface)', border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 14, padding: '26px 22px',
  display: 'flex', flexDirection: 'column',
  position: 'relative',
}
const tierCardPopular = {
  border: '1px solid rgba(239,68,68,0.4)',
  boxShadow: '0 0 0 1px rgba(239,68,68,0.18), 0 20px 50px rgba(239,68,68,0.18)',
  background: 'linear-gradient(180deg, rgba(239,68,68,0.05), var(--surface) 60%)',
}
const popularBadge = {
  position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark, #c41e3a))',
  color: '#fff', fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700,
  padding: '4px 12px', borderRadius: 999, letterSpacing: '0.04em',
}

const finalCta = {
  textAlign: 'center', maxWidth: 720, margin: '60px auto 100px',
  padding: '60px 24px',
  background: 'radial-gradient(ellipse at center, rgba(239,68,68,0.12), rgba(239,68,68,0) 70%)',
}

const footer = {
  borderTop: '1px solid rgba(255,255,255,0.06)',
  background: 'rgba(255,255,255,0.015)',
  marginTop: 60,
}
const footerInner = {
  maxWidth: 1180, margin: '0 auto',
  padding: '50px 24px 30px',
  display: 'grid', gap: 30,
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  alignItems: 'flex-start',
}
const footerLinks = { display: 'flex', gap: 50, justifyContent: 'flex-end', flexWrap: 'wrap' }
const footerColTitle = {
  fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700,
  color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12,
}
const footerLink = {
  display: 'block', fontSize: 13, color: 'var(--text-soft)',
  textDecoration: 'none', marginBottom: 8,
}
