// Landing-page section library — JSX renderers + form schemas for the editor.
// Each section type has:
//   - render(props, brand): JSX
//   - editor(props, onChange): edit form JSX
//   - schema: list of fields exposed in the right-rail editor

import { useState } from 'react'
import { Sparkles, Star, Quote, Check, ChevronDown, Play, Image as ImageIcon, BarChart3 } from 'lucide-react'

// ── Style helpers ──────────────────────────────────────────────────────────
const sectionWrap = { padding: '60px 24px', maxWidth: 1100, margin: '0 auto' }
const h1 = { fontFamily: 'var(--font-display)', fontSize: 44, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.1, color: 'var(--text)', marginBottom: 14 }
const h2 = { fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--text)', marginBottom: 14 }
const lead = { fontSize: 17, color: 'var(--text-soft)', lineHeight: 1.6, maxWidth: 720 }
const btn = (brand) => ({
  display: 'inline-flex', alignItems: 'center', gap: 8,
  padding: '12px 22px',
  background: brand?.brand_primary_color
    ? `linear-gradient(135deg, ${brand.brand_primary_color}, ${brand.brand_secondary_color || brand.brand_primary_color})`
    : 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', borderRadius: 10,
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14,
  textDecoration: 'none', boxShadow: '0 8px 24px rgba(239,68,68,0.25)',
})

// ── HERO ───────────────────────────────────────────────────────────────────
function Hero({ props = {}, brand }) {
  const { eyebrow, title, subtitle, cta_label, cta_url, image_url } = props
  return (
    <section style={{ ...sectionWrap, paddingTop: 100, paddingBottom: 80, textAlign: 'center' }}>
      {eyebrow && <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: brand?.brand_primary_color || 'var(--red)', marginBottom: 16 }}>{eyebrow}</div>}
      <h1 style={h1}>{title || 'Big bold headline goes here.'}</h1>
      <p style={{ ...lead, margin: '14px auto 0' }}>{subtitle || ''}</p>
      {cta_label && <a href={cta_url || '#'} style={{ ...btn(brand), marginTop: 28 }}>{cta_label}</a>}
      {image_url && <img src={image_url} alt="" style={{ maxWidth: '100%', marginTop: 40, borderRadius: 14, boxShadow: '0 30px 60px rgba(0,0,0,0.3)' }} />}
    </section>
  )
}

// ── FEATURES ────────────────────────────────────────────────────────────────
function Features({ props = {}, brand }) {
  const items = Array.isArray(props.items) ? props.items : []
  return (
    <section style={sectionWrap}>
      {props.title && <h2 style={{ ...h2, textAlign: 'center', marginBottom: 36 }}>{props.title}</h2>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 18 }}>
        {items.map((it, i) => (
          <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 22 }}>
            <div style={{ width: 36, height: 36, borderRadius: 9, background: brand?.brand_primary_color ? `${brand.brand_primary_color}22` : 'var(--red-soft)', color: brand?.brand_primary_color || 'var(--red)', display: 'grid', placeItems: 'center', marginBottom: 10 }}>
              <Sparkles size={18} />
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, marginBottom: 6 }}>{it.title}</div>
            <div style={{ color: 'var(--text-soft)', fontSize: 13.5, lineHeight: 1.55 }}>{it.body}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── TESTIMONIALS ────────────────────────────────────────────────────────────
function Testimonials({ props = {} }) {
  const quotes = Array.isArray(props.quotes) ? props.quotes : []
  return (
    <section style={sectionWrap}>
      {props.title && <h2 style={{ ...h2, textAlign: 'center', marginBottom: 28 }}>{props.title}</h2>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18 }}>
        {quotes.map((q, i) => (
          <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 22 }}>
            <Quote size={18} style={{ color: 'var(--red)', marginBottom: 10 }} />
            <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.6, marginBottom: 14 }}>{q.quote}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              <strong style={{ color: 'var(--text)' }}>{q.author}</strong>{q.role ? ` · ${q.role}` : ''}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── PRICING ─────────────────────────────────────────────────────────────────
function Pricing({ props = {}, brand }) {
  const tiers = Array.isArray(props.tiers) ? props.tiers : []
  return (
    <section style={sectionWrap}>
      {props.title && <h2 style={{ ...h2, textAlign: 'center', marginBottom: 28 }}>{props.title}</h2>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
        {tiers.map((t, i) => (
          <div key={i} style={{
            background: 'var(--surface)',
            border: t.popular ? `1px solid ${brand?.brand_primary_color || 'var(--red)'}` : '1px solid var(--border)',
            borderRadius: 16, padding: 24,
            position: 'relative',
            boxShadow: t.popular ? '0 16px 40px rgba(239,68,68,0.18)' : 'none',
          }}>
            {t.popular && <div style={{ position: 'absolute', top: -10, right: 18, background: brand?.brand_primary_color || 'var(--red)', color: '#fff', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '4px 10px', borderRadius: 999 }}>Popular</div>}
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{t.name}</div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 30, color: 'var(--text)', marginBottom: 14 }}>{t.price_label}</div>
            <ul style={{ listStyle: 'none', padding: 0, margin: '14px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(t.features || []).map((f, j) => (
                <li key={j} style={{ display: 'flex', gap: 8, fontSize: 13, color: 'var(--text-soft)' }}>
                  <Check size={14} style={{ color: brand?.brand_primary_color || 'var(--red)', marginTop: 2, flexShrink: 0 }} />
                  {f}
                </li>
              ))}
            </ul>
            <a href={t.cta_url || '#'} style={{ ...btn(brand), width: '100%', justifyContent: 'center', textAlign: 'center', marginTop: 14, padding: '10px 18px' }}>{t.cta_label || 'Get started'}</a>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── FAQ ────────────────────────────────────────────────────────────────────
function Faq({ props = {} }) {
  const items = Array.isArray(props.items) ? props.items : []
  const [open, setOpen] = useState(0)
  return (
    <section style={{ ...sectionWrap, maxWidth: 760 }}>
      {props.title && <h2 style={{ ...h2, textAlign: 'center', marginBottom: 28 }}>{props.title}</h2>}
      {items.map((it, i) => (
        <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, marginBottom: 8, overflow: 'hidden' }}>
          <button
            onClick={() => setOpen(open === i ? -1 : i)}
            style={{ width: '100%', textAlign: 'left', padding: '14px 18px', background: 'transparent', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', color: 'var(--text)', fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14 }}
          >
            <span>{it.q}</span>
            <ChevronDown size={16} style={{ transform: open === i ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease', color: 'var(--muted)' }} />
          </button>
          {open === i && <div style={{ padding: '0 18px 16px', color: 'var(--text-soft)', fontSize: 13.5, lineHeight: 1.6 }}>{it.a}</div>}
        </div>
      ))}
    </section>
  )
}

// ── CTA ────────────────────────────────────────────────────────────────────
function Cta({ props = {}, brand }) {
  return (
    <section style={{ ...sectionWrap, textAlign: 'center', maxWidth: 720 }}>
      <div style={{
        background: brand?.brand_primary_color
          ? `linear-gradient(135deg, ${brand.brand_primary_color}22, ${brand.brand_secondary_color || brand.brand_primary_color}10)`
          : 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(185,28,28,0.10))',
        border: `1px solid ${brand?.brand_primary_color || 'var(--red)'}40`,
        borderRadius: 18, padding: '40px 24px',
      }}>
        <h2 style={{ ...h2, marginBottom: 10 }}>{props.title || 'Ready to begin?'}</h2>
        {props.subtitle && <p style={{ ...lead, margin: '0 auto 24px' }}>{props.subtitle}</p>}
        {props.cta_label && <a href={props.cta_url || '#'} style={btn(brand)}>{props.cta_label}</a>}
      </div>
    </section>
  )
}

// ── ABOUT ───────────────────────────────────────────────────────────────────
function About({ props = {} }) {
  return (
    <section style={{ ...sectionWrap, maxWidth: 760 }}>
      {props.title && <h2 style={h2}>{props.title}</h2>}
      <div style={{ ...lead, whiteSpace: 'pre-wrap' }}>{props.body || ''}</div>
    </section>
  )
}

// ── STATS ───────────────────────────────────────────────────────────────────
function Stats({ props = {}, brand }) {
  const items = Array.isArray(props.items) ? props.items : []
  return (
    <section style={sectionWrap}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(items.length, 4)}, 1fr)`, gap: 18, textAlign: 'center' }}>
        {items.map((s, i) => (
          <div key={i}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 38, fontWeight: 800, color: brand?.brand_primary_color || 'var(--red)' }}>{s.value}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6, fontFamily: 'var(--font-display)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── LOGOS ───────────────────────────────────────────────────────────────────
function Logos({ props = {} }) {
  const items = Array.isArray(props.items) ? props.items : []
  return (
    <section style={sectionWrap}>
      {props.title && <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 18 }}>{props.title}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 36, opacity: 0.7 }}>
        {items.map((it, i) => (
          it.image_url
            ? <img key={i} src={it.image_url} alt={it.name} style={{ height: 28 }} />
            : <span key={i} style={{ fontFamily: 'var(--font-display)', fontSize: 14, color: 'var(--text-soft)' }}>{it.name}</span>
        ))}
      </div>
    </section>
  )
}

// ── VIDEO ──────────────────────────────────────────────────────────────────
function Video({ props = {} }) {
  return (
    <section style={{ ...sectionWrap, maxWidth: 900 }}>
      {props.title && <h2 style={{ ...h2, textAlign: 'center', marginBottom: 28 }}>{props.title}</h2>}
      <div style={{ background: '#000', borderRadius: 14, overflow: 'hidden', aspectRatio: '16/9' }}>
        {props.video_url ? (
          <video src={props.video_url} controls style={{ width: '100%', height: '100%', display: 'block' }} />
        ) : (
          <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: '#999' }}><Play size={36} /></div>
        )}
      </div>
    </section>
  )
}

// ── REGISTRY ───────────────────────────────────────────────────────────────
export const SECTIONS = {
  hero:         { component: Hero,         label: 'Hero',         icon: Sparkles },
  features:     { component: Features,     label: 'Features',     icon: Star },
  testimonials: { component: Testimonials, label: 'Testimonials', icon: Quote },
  pricing:      { component: Pricing,      label: 'Pricing',      icon: BarChart3 },
  faq:          { component: Faq,          label: 'FAQ',          icon: ChevronDown },
  cta:          { component: Cta,          label: 'CTA',          icon: Sparkles },
  about:        { component: About,        label: 'About',        icon: ImageIcon },
  stats:        { component: Stats,        label: 'Stats',        icon: BarChart3 },
  logos:        { component: Logos,        label: 'Logos',        icon: ImageIcon },
  video:        { component: Video,        label: 'Video',        icon: Play },
}

export const SECTION_TEMPLATES = {
  hero:         { title: 'Scale your brand 10x faster', subtitle: 'One platform. AI on tap. Built for solopreneurs.', cta_label: 'Start free trial', cta_url: '#' },
  features:     { title: 'Everything you need', items: [
    { title: 'AI CEO',           body: 'Always-on strategist that knows your brand voice.' },
    { title: 'Content engine',   body: 'Generate posts, scripts, and ads in seconds.' },
    { title: 'Avatar videos',    body: 'AI clones of you, rendering on-demand.' },
  ]},
  testimonials: { title: 'What people are saying', quotes: [
    { quote: 'It replaced my $400/mo stack in one week.', author: 'Maya Chen', role: 'Coach' },
    { quote: 'I finally ship daily without burning out.',  author: 'Jake Patel', role: 'Founder' },
  ]},
  pricing:      { title: 'Simple pricing', tiers: [
    { name: 'Solo Starter', price_label: '$49/mo', features: ['1 brand profile', '100K AI tokens', '10 video units'], cta_label: 'Start trial', cta_url: '#' },
    { name: 'Solo Pro',     price_label: '$79/mo', features: ['2 brand profiles', '500K AI tokens', '30 video units'], cta_label: 'Start trial', cta_url: '#', popular: true },
  ]},
  faq:          { title: 'Frequently asked', items: [
    { q: 'How does the trial work?', a: '3-day free trial. Cancel anytime.' },
    { q: 'Can I cancel?',            a: 'Yes, in one click from your billing page.' },
  ]},
  cta:          { title: 'Ready to ship?', subtitle: 'Free for 3 days. No card friction.', cta_label: 'Get started', cta_url: '#' },
  about:        { title: 'About', body: 'A short story about your brand.' },
  stats:        { items: [
    { value: '10x',  label: 'Faster output' },
    { value: '$300', label: 'Saved per month' },
    { value: '24/7', label: 'AI on tap' },
  ]},
  logos:        { title: 'Trusted by', items: [{ name: 'Brand A' }, { name: 'Brand B' }, { name: 'Brand C' }] },
  video:        { title: 'See it in action', video_url: '' },
}

export function renderSection(section, brand) {
  const def = SECTIONS[section.type]
  if (!def) return null
  const Component = def.component
  return <Component props={section.props} brand={brand} />
}
