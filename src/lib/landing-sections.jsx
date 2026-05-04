// Landing-page section library — schema-driven so the editor never falls back
// to a raw JSON textarea, and inline-editing in preview works out of the box.
//
// Each section type carries:
//   component:   React component that renders the section (props, brand)
//   label, icon: shown in the "+ Add section" picker and section list
//   fields:      { key, kind: 'text'|'textarea'|'image'|'url'|'select'|'array',
//                  label, placeholder?, inline?, of? (array shape) }
//   template:    starter props for "+ Add"
//   bg:          true if the section supports background image/color (hero, cta,
//                stats, video). Applied via the SectionFrame wrapper.

import { useState } from 'react'
import {
  Sparkles, Star, Quote, Check, ChevronDown, Play, Image as ImageIcon, BarChart3, ClipboardList,
} from 'lucide-react'

// ── Style helpers ──────────────────────────────────────────────────────────
const sectionWrap = { padding: '60px 24px', maxWidth: 1100, margin: '0 auto', position: 'relative', zIndex: 1 }
const h1 = { fontFamily: 'var(--font-display)', fontSize: 44, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.1, color: 'var(--text)', marginBottom: 14 }
const h2 = { fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--text)', marginBottom: 14 }
const lead = { fontSize: 17, color: 'var(--text-soft)', lineHeight: 1.6, maxWidth: 720 }
const btnStyle = (brand) => ({
  display: 'inline-flex', alignItems: 'center', gap: 8,
  padding: '12px 22px',
  background: brand?.brand_primary_color
    ? `linear-gradient(135deg, ${brand.brand_primary_color}, ${brand.brand_secondary_color || brand.brand_primary_color})`
    : 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', borderRadius: 10,
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14,
  textDecoration: 'none', boxShadow: '0 8px 24px rgba(239,68,68,0.25)',
  border: 'none', cursor: 'pointer',
})

// ── InlineText: contentEditable wrapper used in preview when editable ──────
function InlineText({ as = 'span', value, onCommit, style, placeholder, multiline = false, editable = false }) {
  if (!editable) {
    const Tag = as
    return <Tag style={style}>{value || (placeholder ? <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>{placeholder}</span> : '')}</Tag>
  }
  const Tag = as
  return (
    <Tag
      contentEditable
      suppressContentEditableWarning
      onBlur={(e) => {
        const next = (multiline ? e.currentTarget.innerText : e.currentTarget.textContent) || ''
        if (next !== value) onCommit?.(next)
      }}
      onKeyDown={(e) => {
        if (!multiline && e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
      }}
      style={{
        ...style,
        outline: 'none',
        borderRadius: 4,
        cursor: 'text',
        whiteSpace: multiline ? 'pre-wrap' : 'pre',
        minWidth: 30,
        boxShadow: 'inset 0 0 0 1px transparent',
        transition: 'box-shadow 0.12s ease, background 0.12s ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = 'inset 0 0 0 1px rgba(239,68,68,0.35)'; e.currentTarget.style.background = 'rgba(239,68,68,0.05)' }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'inset 0 0 0 1px transparent'; e.currentTarget.style.background = 'transparent' }}
      onClick={(e) => e.stopPropagation()}
    >
      {value || ''}
    </Tag>
  )
}

// Patch a single field into a section's props (used by inline editors)
function makeSetter(section, onChange) {
  return (key, value) => onChange?.({ ...section, props: { ...(section.props || {}), [key]: value } })
}

// ── Background frame wrapper ───────────────────────────────────────────────
function SectionFrame({ children, props, defaultBg }) {
  const bg = props?.background_image_url
  const overlay = props?.background_overlay ?? (bg ? 'rgba(0,0,0,0.45)' : null)
  const wrapStyle = bg
    ? {
        position: 'relative',
        backgroundImage: `url(${bg})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        color: '#fff',
      }
    : (defaultBg ? { background: defaultBg } : {})
  return (
    <div style={wrapStyle}>
      {bg && overlay && <div style={{ position: 'absolute', inset: 0, background: overlay, pointerEvents: 'none' }} />}
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
    </div>
  )
}

// ── HERO ───────────────────────────────────────────────────────────────────
function Hero({ section, brand, editable, onChange }) {
  const props = section.props || {}
  const set = makeSetter(section, onChange)
  return (
    <SectionFrame props={props}>
      <section style={{ ...sectionWrap, paddingTop: 100, paddingBottom: 80, textAlign: 'center' }}>
        {(props.eyebrow || editable) && (
          <InlineText as="div" editable={editable} value={props.eyebrow} onCommit={(v) => set('eyebrow', v)} placeholder="Eyebrow text"
            style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: brand?.brand_primary_color || 'var(--red)', marginBottom: 16, display: 'inline-block' }} />
        )}
        <InlineText as="h1" editable={editable} value={props.title} onCommit={(v) => set('title', v)} placeholder="Big bold headline" style={h1} />
        <InlineText as="p" editable={editable} value={props.subtitle} onCommit={(v) => set('subtitle', v)} placeholder="Supporting subhead" multiline style={{ ...lead, margin: '14px auto 0' }} />
        {(props.cta_label || editable) && (
          <a href={props.cta_url || '#'} style={{ ...btnStyle(brand), marginTop: 28 }} onClick={(e) => editable && e.preventDefault()}>
            <InlineText editable={editable} value={props.cta_label} onCommit={(v) => set('cta_label', v)} placeholder="CTA label" />
          </a>
        )}
        {props.image_url && <img src={props.image_url} alt="" style={{ maxWidth: '100%', marginTop: 40, borderRadius: 14, boxShadow: '0 30px 60px rgba(0,0,0,0.3)' }} />}
      </section>
    </SectionFrame>
  )
}

// ── FEATURES ────────────────────────────────────────────────────────────────
function Features({ section, brand, editable, onChange }) {
  const props = section.props || {}
  const set = makeSetter(section, onChange)
  const items = Array.isArray(props.items) ? props.items : []
  const setItem = (i, k, v) => set('items', items.map((it, j) => j === i ? { ...it, [k]: v } : it))
  return (
    <SectionFrame props={props}>
      <section style={sectionWrap}>
        {(props.title || editable) && (
          <InlineText as="h2" editable={editable} value={props.title} onCommit={(v) => set('title', v)} placeholder="Section title"
            style={{ ...h2, textAlign: 'center', marginBottom: 36, display: 'block' }} />
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 18 }}>
          {items.map((it, i) => (
            <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 22 }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: brand?.brand_primary_color ? `${brand.brand_primary_color}22` : 'var(--red-soft)', color: brand?.brand_primary_color || 'var(--red)', display: 'grid', placeItems: 'center', marginBottom: 10 }}>
                <Sparkles size={18} />
              </div>
              <InlineText as="div" editable={editable} value={it.title} onCommit={(v) => setItem(i, 'title', v)} placeholder="Feature title" style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, marginBottom: 6 }} />
              <InlineText as="div" editable={editable} value={it.body} onCommit={(v) => setItem(i, 'body', v)} placeholder="Feature description" multiline style={{ color: 'var(--text-soft)', fontSize: 13.5, lineHeight: 1.55 }} />
            </div>
          ))}
        </div>
      </section>
    </SectionFrame>
  )
}

// ── TESTIMONIALS ────────────────────────────────────────────────────────────
function Testimonials({ section, brand, editable, onChange }) {
  const props = section.props || {}
  const set = makeSetter(section, onChange)
  const quotes = Array.isArray(props.quotes) ? props.quotes : []
  const setQuote = (i, k, v) => set('quotes', quotes.map((q, j) => j === i ? { ...q, [k]: v } : q))
  return (
    <SectionFrame props={props}>
      <section style={sectionWrap}>
        {(props.title || editable) && <InlineText as="h2" editable={editable} value={props.title} onCommit={(v) => set('title', v)} placeholder="Section title" style={{ ...h2, textAlign: 'center', marginBottom: 28, display: 'block' }} />}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18 }}>
          {quotes.map((q, i) => (
            <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 22 }}>
              <Quote size={18} style={{ color: brand?.brand_primary_color || 'var(--red)', marginBottom: 10 }} />
              <InlineText as="div" editable={editable} value={q.quote} onCommit={(v) => setQuote(i, 'quote', v)} placeholder="Quote text" multiline style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.6, marginBottom: 14 }} />
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                <InlineText editable={editable} value={q.author} onCommit={(v) => setQuote(i, 'author', v)} placeholder="Author" style={{ color: 'var(--text)', fontWeight: 600 }} />
                {(q.role || editable) && <> · <InlineText editable={editable} value={q.role} onCommit={(v) => setQuote(i, 'role', v)} placeholder="Role" /></>}
              </div>
            </div>
          ))}
        </div>
      </section>
    </SectionFrame>
  )
}

// ── PRICING ─────────────────────────────────────────────────────────────────
function Pricing({ section, brand, editable, onChange }) {
  const props = section.props || {}
  const set = makeSetter(section, onChange)
  const tiers = Array.isArray(props.tiers) ? props.tiers : []
  const setTier = (i, k, v) => set('tiers', tiers.map((t, j) => j === i ? { ...t, [k]: v } : t))
  return (
    <SectionFrame props={props}>
      <section style={sectionWrap}>
        {(props.title || editable) && <InlineText as="h2" editable={editable} value={props.title} onCommit={(v) => set('title', v)} placeholder="Section title" style={{ ...h2, textAlign: 'center', marginBottom: 28, display: 'block' }} />}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
          {tiers.map((t, i) => (
            <div key={i} style={{
              background: 'var(--surface)',
              border: t.popular ? `1px solid ${brand?.brand_primary_color || 'var(--red)'}` : '1px solid var(--border)',
              borderRadius: 16, padding: 24, position: 'relative',
              boxShadow: t.popular ? '0 16px 40px rgba(239,68,68,0.18)' : 'none',
            }}>
              {t.popular && <div style={{ position: 'absolute', top: -10, right: 18, background: brand?.brand_primary_color || 'var(--red)', color: '#fff', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '4px 10px', borderRadius: 999 }}>Popular</div>}
              <InlineText as="div" editable={editable} value={t.name} onCommit={(v) => setTier(i, 'name', v)} placeholder="Tier name" style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, marginBottom: 6 }} />
              <InlineText as="div" editable={editable} value={t.price_label} onCommit={(v) => setTier(i, 'price_label', v)} placeholder="$X/mo" style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 30, color: 'var(--text)', marginBottom: 14 }} />
              <ul style={{ listStyle: 'none', padding: 0, margin: '14px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(t.features || []).map((f, j) => (
                  <li key={j} style={{ display: 'flex', gap: 8, fontSize: 13, color: 'var(--text-soft)' }}>
                    <Check size={14} style={{ color: brand?.brand_primary_color || 'var(--red)', marginTop: 2, flexShrink: 0 }} />
                    <InlineText editable={editable} value={f} onCommit={(v) => {
                      const nextFeatures = (t.features || []).map((x, k) => k === j ? v : x)
                      setTier(i, 'features', nextFeatures)
                    }} placeholder="Feature" />
                  </li>
                ))}
              </ul>
              <a href={t.cta_url || '#'} style={{ ...btnStyle(brand), width: '100%', justifyContent: 'center', textAlign: 'center', marginTop: 14, padding: '10px 18px' }} onClick={(e) => editable && e.preventDefault()}>
                <InlineText editable={editable} value={t.cta_label} onCommit={(v) => setTier(i, 'cta_label', v)} placeholder="Get started" />
              </a>
            </div>
          ))}
        </div>
      </section>
    </SectionFrame>
  )
}

// ── FAQ ────────────────────────────────────────────────────────────────────
function Faq({ section, editable, onChange }) {
  const props = section.props || {}
  const set = makeSetter(section, onChange)
  const items = Array.isArray(props.items) ? props.items : []
  const setItem = (i, k, v) => set('items', items.map((it, j) => j === i ? { ...it, [k]: v } : it))
  const [open, setOpen] = useState(0)
  return (
    <SectionFrame props={props}>
      <section style={{ ...sectionWrap, maxWidth: 760 }}>
        {(props.title || editable) && <InlineText as="h2" editable={editable} value={props.title} onCommit={(v) => set('title', v)} placeholder="FAQ title" style={{ ...h2, textAlign: 'center', marginBottom: 28, display: 'block' }} />}
        {items.map((it, i) => (
          <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, marginBottom: 8, overflow: 'hidden' }}>
            <button
              onClick={(e) => { if (!editable) setOpen(open === i ? -1 : i) }}
              style={{ width: '100%', textAlign: 'left', padding: '14px 18px', background: 'transparent', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: editable ? 'text' : 'pointer', color: 'var(--text)', fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14 }}
            >
              <InlineText editable={editable} value={it.q} onCommit={(v) => setItem(i, 'q', v)} placeholder="Question" />
              {!editable && <ChevronDown size={16} style={{ transform: open === i ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease', color: 'var(--muted)' }} />}
            </button>
            {(open === i || editable) && (
              <div style={{ padding: '0 18px 16px' }}>
                <InlineText editable={editable} value={it.a} onCommit={(v) => setItem(i, 'a', v)} placeholder="Answer" multiline style={{ color: 'var(--text-soft)', fontSize: 13.5, lineHeight: 1.6, display: 'block' }} />
              </div>
            )}
          </div>
        ))}
      </section>
    </SectionFrame>
  )
}

// ── CTA ────────────────────────────────────────────────────────────────────
function Cta({ section, brand, editable, onChange }) {
  const props = section.props || {}
  const set = makeSetter(section, onChange)
  return (
    <SectionFrame props={props}>
      <section style={{ ...sectionWrap, textAlign: 'center', maxWidth: 720 }}>
        <div style={{
          background: props.background_image_url ? 'transparent' : (brand?.brand_primary_color
            ? `linear-gradient(135deg, ${brand.brand_primary_color}22, ${brand.brand_secondary_color || brand.brand_primary_color}10)`
            : 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(185,28,28,0.10))'),
          border: props.background_image_url ? 'none' : `1px solid ${brand?.brand_primary_color || 'var(--red)'}40`,
          borderRadius: 18, padding: '40px 24px',
        }}>
          <InlineText as="h2" editable={editable} value={props.title} onCommit={(v) => set('title', v)} placeholder="Ready to begin?" style={{ ...h2, marginBottom: 10, display: 'block' }} />
          {(props.subtitle || editable) && <InlineText as="p" editable={editable} value={props.subtitle} onCommit={(v) => set('subtitle', v)} placeholder="Subhead" multiline style={{ ...lead, margin: '0 auto 24px', display: 'block' }} />}
          {(props.cta_label || editable) && (
            <a href={props.cta_url || '#'} style={btnStyle(brand)} onClick={(e) => editable && e.preventDefault()}>
              <InlineText editable={editable} value={props.cta_label} onCommit={(v) => set('cta_label', v)} placeholder="CTA label" />
            </a>
          )}
        </div>
      </section>
    </SectionFrame>
  )
}

// ── ABOUT ───────────────────────────────────────────────────────────────────
function About({ section, editable, onChange }) {
  const props = section.props || {}
  const set = makeSetter(section, onChange)
  return (
    <SectionFrame props={props}>
      <section style={{ ...sectionWrap, maxWidth: 760 }}>
        {(props.title || editable) && <InlineText as="h2" editable={editable} value={props.title} onCommit={(v) => set('title', v)} placeholder="About" style={{ ...h2, display: 'block' }} />}
        <InlineText as="div" editable={editable} value={props.body} onCommit={(v) => set('body', v)} placeholder="Tell your story…" multiline style={{ ...lead, whiteSpace: 'pre-wrap' }} />
      </section>
    </SectionFrame>
  )
}

// ── STATS ───────────────────────────────────────────────────────────────────
function Stats({ section, brand, editable, onChange }) {
  const props = section.props || {}
  const set = makeSetter(section, onChange)
  const items = Array.isArray(props.items) ? props.items : []
  const setItem = (i, k, v) => set('items', items.map((it, j) => j === i ? { ...it, [k]: v } : it))
  return (
    <SectionFrame props={props}>
      <section style={sectionWrap}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, Math.min(items.length, 4))}, 1fr)`, gap: 18, textAlign: 'center' }}>
          {items.map((s, i) => (
            <div key={i}>
              <InlineText as="div" editable={editable} value={s.value} onCommit={(v) => setItem(i, 'value', v)} placeholder="10x" style={{ fontFamily: 'var(--font-display)', fontSize: 38, fontWeight: 800, color: brand?.brand_primary_color || 'var(--red)' }} />
              <InlineText as="div" editable={editable} value={s.label} onCommit={(v) => setItem(i, 'label', v)} placeholder="Faster output" style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6, fontFamily: 'var(--font-display)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }} />
            </div>
          ))}
        </div>
      </section>
    </SectionFrame>
  )
}

// ── LOGOS ───────────────────────────────────────────────────────────────────
function Logos({ section, editable, onChange }) {
  const props = section.props || {}
  const set = makeSetter(section, onChange)
  const items = Array.isArray(props.items) ? props.items : []
  const setItem = (i, k, v) => set('items', items.map((it, j) => j === i ? { ...it, [k]: v } : it))
  return (
    <SectionFrame props={props}>
      <section style={sectionWrap}>
        {(props.title || editable) && <InlineText as="div" editable={editable} value={props.title} onCommit={(v) => set('title', v)} placeholder="Trusted by" style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 18, display: 'block' }} />}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 36, opacity: 0.7 }}>
          {items.map((it, i) => (
            it.image_url
              ? <img key={i} src={it.image_url} alt={it.name} style={{ height: 28 }} />
              : <InlineText key={i} editable={editable} value={it.name} onCommit={(v) => setItem(i, 'name', v)} placeholder="Brand" style={{ fontFamily: 'var(--font-display)', fontSize: 14, color: 'var(--text-soft)' }} />
          ))}
        </div>
      </section>
    </SectionFrame>
  )
}

// ── VIDEO (URL or upload, with YouTube/Vimeo embed support) ───────────────
function detectVideoEmbed(url) {
  if (!url) return null
  const u = url.trim()
  // YouTube
  let m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([\w-]{11})/)
  if (m) return { kind: 'iframe', src: `https://www.youtube.com/embed/${m[1]}` }
  // Vimeo
  m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/)
  if (m) return { kind: 'iframe', src: `https://player.vimeo.com/video/${m[1]}` }
  // Loom
  m = u.match(/loom\.com\/share\/([\w-]+)/)
  if (m) return { kind: 'iframe', src: `https://www.loom.com/embed/${m[1]}` }
  // Direct file
  if (/\.(mp4|webm|mov|m4v|ogg)(\?|$)/i.test(u)) return { kind: 'file', src: u }
  return null
}

function Video({ section, editable, onChange }) {
  const props = section.props || {}
  const set = makeSetter(section, onChange)
  const embed = detectVideoEmbed(props.video_url)
  return (
    <SectionFrame props={props}>
      <section style={{ ...sectionWrap, maxWidth: 900 }}>
        {(props.title || editable) && <InlineText as="h2" editable={editable} value={props.title} onCommit={(v) => set('title', v)} placeholder="See it in action" style={{ ...h2, textAlign: 'center', marginBottom: 28, display: 'block' }} />}
        <div style={{ background: '#000', borderRadius: 14, overflow: 'hidden', aspectRatio: '16/9' }}>
          {embed?.kind === 'iframe' ? (
            <iframe
              src={embed.src}
              title="video"
              frameBorder="0"
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
              style={{ width: '100%', height: '100%', display: 'block' }}
            />
          ) : embed?.kind === 'file' ? (
            <video src={embed.src} controls playsInline style={{ width: '100%', height: '100%', display: 'block' }} />
          ) : (
            <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: '#999', fontSize: 13 }}>
              <div style={{ textAlign: 'center' }}>
                <Play size={36} style={{ marginBottom: 8 }} />
                <div>Add a YouTube, Vimeo, Loom, or direct .mp4 URL in the right rail</div>
              </div>
            </div>
          )}
        </div>
      </section>
    </SectionFrame>
  )
}

// ── LEAD CAPTURE ────────────────────────────────────────────────────────────
// Renders a name + email + (optional) phone form. On submit, posts to
// /api/landing-pages/lead which upserts into email_contacts and logs an
// activity event. Won't actually submit while editable=true (prevents
// accidental submissions while you're building).
function LeadCapture({ section, brand, editable, onChange, pageId }) {
  const props = section.props || {}
  const set = makeSetter(section, onChange)
  const collectPhone = props.collect_phone !== false
  const [vals, setVals] = useState({ name: '', email: '', phone: '' })
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    if (editable) return
    if (!vals.email.trim()) { setError('Email required'); return }
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/landing-pages/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: pageId,
          name: vals.name.trim(),
          email: vals.email.trim(),
          phone: collectPhone ? vals.phone.trim() : null,
          source_url: typeof window !== 'undefined' ? window.location.href : null,
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error || 'Submission failed')
      setDone(true)
      if (props.redirect_url) setTimeout(() => { window.location.href = props.redirect_url }, 800)
    } catch (e2) { setError(e2.message) }
    finally { setBusy(false) }
  }

  return (
    <SectionFrame props={props}>
      <section style={{ ...sectionWrap, maxWidth: 560, textAlign: 'center' }}>
        {(props.title || editable) && <InlineText as="h2" editable={editable} value={props.title} onCommit={(v) => set('title', v)} placeholder="Get in touch" style={{ ...h2, display: 'block' }} />}
        {(props.subtitle || editable) && <InlineText as="p" editable={editable} value={props.subtitle} onCommit={(v) => set('subtitle', v)} placeholder="We'll be in touch within 24 hours." multiline style={{ ...lead, margin: '0 auto 24px', display: 'block' }} />}
        {done ? (
          <div style={{ padding: 24, background: 'rgba(46,204,113,0.10)', border: '1px solid rgba(46,204,113,0.35)', borderRadius: 14, color: '#2ecc71', fontFamily: 'var(--font-display)', fontWeight: 600 }}>
            {props.success_message || 'Thanks — we got it.'}
          </div>
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 420, margin: '0 auto' }}>
            <input className="input" placeholder="Your name" value={vals.name} onChange={(e) => setVals({ ...vals, name: e.target.value })} disabled={editable} />
            <input className="input" type="email" required placeholder="you@example.com" value={vals.email} onChange={(e) => setVals({ ...vals, email: e.target.value })} disabled={editable} />
            {collectPhone && <input className="input" type="tel" placeholder="Phone (optional)" value={vals.phone} onChange={(e) => setVals({ ...vals, phone: e.target.value })} disabled={editable} />}
            {error && <div style={{ color: 'var(--red)', fontSize: 12.5 }}>{error}</div>}
            <button type="submit" style={{ ...btnStyle(brand), justifyContent: 'center' }} disabled={busy || editable}>
              {busy ? <span className="spinner" /> : null}
              <InlineText editable={editable} value={props.cta_label} onCommit={(v) => set('cta_label', v)} placeholder="Submit" />
            </button>
          </form>
        )}
      </section>
    </SectionFrame>
  )
}

// ── REGISTRY (with editor field schemas) ───────────────────────────────────
const COMMON_BG_FIELDS = [
  { key: 'background_image_url', kind: 'image',   label: 'Background image', bucket: 'landing-media' },
  { key: 'background_overlay',   kind: 'text',    label: 'Background overlay (CSS, e.g. rgba(0,0,0,0.45))', placeholder: 'rgba(0,0,0,0.45)' },
]

export const SECTIONS = {
  hero: {
    component: Hero, label: 'Hero', icon: Sparkles,
    fields: [
      { key: 'eyebrow',   kind: 'text',     label: 'Eyebrow' },
      { key: 'title',     kind: 'text',     label: 'Title' },
      { key: 'subtitle',  kind: 'textarea', label: 'Subtitle' },
      { key: 'cta_label', kind: 'text',     label: 'CTA label' },
      { key: 'cta_url',   kind: 'url',      label: 'CTA URL' },
      { key: 'image_url', kind: 'image',    label: 'Image (below text)', bucket: 'landing-media' },
      ...COMMON_BG_FIELDS,
    ],
    template: { title: 'Scale your brand 10x faster', subtitle: 'One platform. AI on tap. Built for solopreneurs.', cta_label: 'Start free trial', cta_url: '#' },
  },
  features: {
    component: Features, label: 'Features', icon: Star,
    fields: [
      { key: 'title', kind: 'text', label: 'Title' },
      { key: 'items', kind: 'array', label: 'Features',
        of: [
          { key: 'title', kind: 'text', label: 'Title' },
          { key: 'body',  kind: 'textarea', label: 'Body' },
        ],
      },
      ...COMMON_BG_FIELDS,
    ],
    template: { title: 'Everything you need', items: [
      { title: 'AI CEO',         body: 'Always-on strategist that knows your brand voice.' },
      { title: 'Content engine', body: 'Generate posts, scripts, and ads in seconds.' },
      { title: 'Avatar videos',  body: 'AI clones of you, rendering on-demand.' },
    ]},
  },
  testimonials: {
    component: Testimonials, label: 'Testimonials', icon: Quote,
    fields: [
      { key: 'title',  kind: 'text', label: 'Title' },
      { key: 'quotes', kind: 'array', label: 'Quotes',
        of: [
          { key: 'quote',  kind: 'textarea', label: 'Quote' },
          { key: 'author', kind: 'text',     label: 'Author' },
          { key: 'role',   kind: 'text',     label: 'Role / company' },
        ],
      },
      ...COMMON_BG_FIELDS,
    ],
    template: { title: 'What people are saying', quotes: [
      { quote: 'It replaced my $400/mo stack in one week.', author: 'Maya Chen', role: 'Coach' },
      { quote: 'I finally ship daily without burning out.',  author: 'Jake Patel', role: 'Founder' },
    ]},
  },
  pricing: {
    component: Pricing, label: 'Pricing', icon: BarChart3,
    fields: [
      { key: 'title', kind: 'text', label: 'Title' },
      { key: 'tiers', kind: 'array', label: 'Tiers',
        of: [
          { key: 'name',         kind: 'text',  label: 'Name' },
          { key: 'price_label',  kind: 'text',  label: 'Price (e.g. $49/mo)' },
          { key: 'features',     kind: 'lines', label: 'Features (one per line)' },
          { key: 'cta_label',    kind: 'text',  label: 'CTA label' },
          { key: 'cta_url',      kind: 'url',   label: 'CTA URL' },
          { key: 'popular',      kind: 'bool',  label: 'Mark as Most Popular' },
        ],
      },
      ...COMMON_BG_FIELDS,
    ],
    template: { title: 'Simple pricing', tiers: [
      { name: 'Solo Starter', price_label: '$49/mo', features: ['1 brand profile', '100K AI tokens', '10 video units'], cta_label: 'Start trial', cta_url: '#' },
      { name: 'Solo Pro',     price_label: '$79/mo', features: ['2 brand profiles', '500K AI tokens', '30 video units'], cta_label: 'Start trial', cta_url: '#', popular: true },
    ]},
  },
  faq: {
    component: Faq, label: 'FAQ', icon: ChevronDown,
    fields: [
      { key: 'title', kind: 'text', label: 'Title' },
      { key: 'items', kind: 'array', label: 'Questions',
        of: [
          { key: 'q', kind: 'text',     label: 'Question' },
          { key: 'a', kind: 'textarea', label: 'Answer' },
        ],
      },
    ],
    template: { title: 'Frequently asked', items: [
      { q: 'How does the trial work?', a: '3-day free trial. Cancel anytime.' },
      { q: 'Can I cancel?',            a: 'Yes, in one click from your billing page.' },
    ]},
  },
  cta: {
    component: Cta, label: 'CTA', icon: Sparkles,
    fields: [
      { key: 'title',     kind: 'text',     label: 'Title' },
      { key: 'subtitle',  kind: 'textarea', label: 'Subtitle' },
      { key: 'cta_label', kind: 'text',     label: 'Button label' },
      { key: 'cta_url',   kind: 'url',      label: 'Button URL' },
      ...COMMON_BG_FIELDS,
    ],
    template: { title: 'Ready to ship?', subtitle: 'Free for 3 days. No card friction.', cta_label: 'Get started', cta_url: '#' },
  },
  about: {
    component: About, label: 'About', icon: ImageIcon,
    fields: [
      { key: 'title', kind: 'text',     label: 'Title' },
      { key: 'body',  kind: 'textarea', label: 'Body' },
    ],
    template: { title: 'About', body: 'A short story about your brand.' },
  },
  stats: {
    component: Stats, label: 'Stats', icon: BarChart3,
    fields: [
      { key: 'items', kind: 'array', label: 'Stats',
        of: [
          { key: 'value', kind: 'text', label: 'Value' },
          { key: 'label', kind: 'text', label: 'Label' },
        ],
      },
      ...COMMON_BG_FIELDS,
    ],
    template: { items: [
      { value: '10x',  label: 'Faster output' },
      { value: '$300', label: 'Saved per month' },
      { value: '24/7', label: 'AI on tap' },
    ]},
  },
  logos: {
    component: Logos, label: 'Logos', icon: ImageIcon,
    fields: [
      { key: 'title', kind: 'text', label: 'Title' },
      { key: 'items', kind: 'array', label: 'Brands',
        of: [
          { key: 'name',      kind: 'text',  label: 'Name' },
          { key: 'image_url', kind: 'image', label: 'Logo image', bucket: 'landing-media' },
        ],
      },
    ],
    template: { title: 'Trusted by', items: [{ name: 'Brand A' }, { name: 'Brand B' }, { name: 'Brand C' }] },
  },
  video: {
    component: Video, label: 'Video', icon: Play,
    fields: [
      { key: 'title',     kind: 'text',  label: 'Title' },
      { key: 'video_url', kind: 'video', label: 'Video URL or upload', bucket: 'landing-media',
        helper: 'Paste YouTube, Vimeo, Loom, or upload an .mp4 (≤100 MB).' },
      ...COMMON_BG_FIELDS,
    ],
    template: { title: 'See it in action', video_url: '' },
  },
  lead_capture: {
    component: LeadCapture, label: 'Lead capture', icon: ClipboardList,
    fields: [
      { key: 'title',           kind: 'text',     label: 'Title' },
      { key: 'subtitle',        kind: 'textarea', label: 'Subtitle' },
      { key: 'cta_label',       kind: 'text',     label: 'Button label' },
      { key: 'collect_phone',   kind: 'bool',     label: 'Collect phone (optional field)' },
      { key: 'success_message', kind: 'textarea', label: 'Success message' },
      { key: 'redirect_url',    kind: 'url',      label: 'Redirect URL after submit (optional)' },
      ...COMMON_BG_FIELDS,
    ],
    template: {
      title: 'Get started',
      subtitle: "Drop your email and we'll be in touch within 24 hours.",
      cta_label: 'Get in touch',
      collect_phone: true,
      success_message: "Thanks — we'll reach out shortly.",
    },
  },
}

export const SECTION_TEMPLATES = Object.fromEntries(
  Object.entries(SECTIONS).map(([k, v]) => [k, v.template])
)

// renderSection in PREVIEW (page-rendering) mode is NOT editable by default.
export function renderSection(section, brand, opts = {}) {
  const def = SECTIONS[section.type]
  if (!def) return null
  const Component = def.component
  return (
    <Component
      section={section}
      brand={brand}
      editable={!!opts.editable}
      onChange={opts.onChange}
      pageId={opts.pageId}
    />
  )
}
