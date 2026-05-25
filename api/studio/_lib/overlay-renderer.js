// Pure HTML-string renderer for overlay cards.
//
// Takes (overlay_id, content, accent, tokens) and returns an HTML
// string for the inner card. Designed so the same function powers:
//   - Browser-side preview (Studio.jsx iframes)
//   - Worker-side bake (worker/studio-render.js + Puppeteer)
//   - Tests / snapshot diffs
//
// No DOM access. No imports of React. No CSS-in-JS. Just strings.
// Styling lives in public/studio-compositions/_overlays.css; this
// module is responsible for:
//   1. Picking the correct .ov-* root class for the overlay_id
//   2. Slotting content into the right child elements
//   3. Inlining template-specific overrides (from tokens) as style attrs
//
// The renderer reads tokens defensively — every field is optional, and
// missing fields fall back to the Sleek defaults baked into the CSS.
// That means a brand-new template can ship with an EMPTY overlay_overrides
// block and still produce a correct-looking Sleek-ish card.

import { OVERLAY_DEFINITIONS } from './overlay-definitions.js'

// Tiny escape for text content. Not for HTML — the renderer never lets
// callers pass HTML by design.
function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Inline-style helper. Takes a flat key/value object and an optional
// mapping of token-key → css-property. Returns `style="..."` or ''.
function inlineStyle(obj, map) {
  if (!obj) return ''
  const props = []
  for (const [tokenKey, cssProp] of Object.entries(map)) {
    if (obj[tokenKey] == null) continue
    let val = obj[tokenKey]
    if (typeof val === 'number') val = `${val}px`
    props.push(`${cssProp}: ${val}`)
  }
  if (!props.length) return ''
  return ` style="${props.join('; ')}"`
}

// Resolve {accent} placeholders if the renderer is called with a raw
// (un-resolved) tokens block. Safe to call on already-resolved strings.
function withAccent(value, accent) {
  if (typeof value !== 'string' || !accent) return value
  return value.replace(/\{accent\}/g, accent)
}

// Walk an object/array and resolve {accent} in every string leaf.
function resolveAccent(node, accent) {
  if (Array.isArray(node)) return node.map((v) => resolveAccent(v, accent))
  if (node && typeof node === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(node)) out[k] = resolveAccent(v, accent)
    return out
  }
  return withAccent(node, accent)
}

// Common container-token mapping shared by ov-stat, ov-caption,
// ov-tool, ov-chapter, ov-watermark, ov-action, ov-source.
const CONTAINER_PROPS = {
  background: 'background',
  border: 'border',
  border_left: 'border-left',
  color: 'color',
  padding: 'padding',
  line_height: 'line-height',
  text_align: 'text-align',
  layout: null, // handled separately (flex_row)
  gap_px: 'gap',
  backdrop_blur_px: null, // mapped to backdrop-filter via formatter
}

function containerStyle(c) {
  if (!c) return ''
  const props = []
  for (const [tokenKey, cssProp] of Object.entries(CONTAINER_PROPS)) {
    if (!cssProp || c[tokenKey] == null) continue
    let val = c[tokenKey]
    if (typeof val === 'number' && tokenKey === 'gap_px') val = `${val}px`
    props.push(`${cssProp}: ${val}`)
  }
  if (c.border_radius_px != null) {
    const r = typeof c.border_radius_px === 'number' ? `${c.border_radius_px}px` : c.border_radius_px
    props.push(`border-radius: ${r}`)
  }
  if (c.backdrop_blur_px != null) {
    props.push(`backdrop-filter: blur(${c.backdrop_blur_px}px)`)
    props.push(`-webkit-backdrop-filter: blur(${c.backdrop_blur_px}px)`)
  }
  if (c.box_shadow) props.push(`box-shadow: ${c.box_shadow}`)
  if (c.min_width_px != null) props.push(`min-width: ${c.min_width_px}px`)
  if (c.layout === 'flex_row') {
    props.push('display: flex')
    props.push('align-items: center')
  }
  return props.length ? ` style="${props.join('; ')}"` : ''
}

// Text-token mapping for label/sub/title/etc. fields.
function textStyle(t) {
  if (!t) return ''
  const props = []
  if (t.font) props.push(`font-family: '${t.font}', sans-serif`)
  if (t.weight != null) props.push(`font-weight: ${t.weight}`)
  if (t.size_px != null) props.push(`font-size: ${typeof t.size_px === 'number' ? t.size_px + 'px' : t.size_px}`)
  if (t.size_px_text != null) props.push(`font-size: ${typeof t.size_px_text === 'number' ? t.size_px_text + 'px' : t.size_px_text}`)
  if (t.color) props.push(`color: ${t.color}`)
  if (t.letter_spacing) props.push(`letter-spacing: ${t.letter_spacing}`)
  if (t.uppercase) props.push('text-transform: uppercase')
  if (t.line_height != null) props.push(`line-height: ${t.line_height}`)
  if (t.margin_bottom_px != null) props.push(`margin-bottom: ${t.margin_bottom_px}px`)
  if (t.margin_right_px != null) props.push(`margin-right: ${t.margin_right_px}px`)
  if (t.text_shadow) props.push(`text-shadow: ${t.text_shadow}`)
  if (t.translate_y_px != null) props.push(`transform: translateY(${t.translate_y_px}px)`)
  if (t.drop_shadow) props.push(`filter: drop-shadow(${t.drop_shadow})`)
  return props.length ? ` style="${props.join('; ')}"` : ''
}

// ─── PER-OVERLAY RENDERERS ──────────────────────────────────────────

// IMPORTANT: keep formatting identical to public/studio-compositions/
// _overlay-renderer.js. scripts/smoke-overlay-renderer.mjs diffs the
// two byte-for-byte. Whitespace counts.

function renderStat(c, t) {
  const { label = '', number = '', unit = '', sub = '' } = c
  return `<div class="ov-stat"${containerStyle(t.container)}>
      <div class="label"${textStyle(t.label)}>${esc(label)}</div>
      <div class="number"${textStyle(t.number)}>${esc(number)}${unit ? `<span class="unit"${textStyle(t.unit)}>${esc(unit)}</span>` : ''}</div>
      ${sub ? `<div class="sub"${textStyle(t.sub)}>${esc(sub)}</div>` : ''}
    </div>`
}

function renderEmphasis(c, t) {
  const flourish = t.flourish && t.flourish.enabled === false ? 'no-flourish' : ''
  return `<div class="ov-emphasis ${flourish}"${t.text_align ? ` style="text-align:${t.text_align}"` : ''}>
    <div class="word"${textStyle(t.word)}>${esc(c.word || '')}</div>
  </div>`
}

function renderCaption(c, t) {
  const text = c.text || ''
  const highlight = c.highlight || ''
  let html = esc(text)
  if (highlight) {
    const esced = esc(highlight)
    html = html.replace(esced, `<span class="highlight"${textStyle(t.highlight)}>${esced}</span>`)
  }
  return `<div class="ov-caption"${containerStyle(t.container)}>
    <div class="text"${textStyle(t.text)}>${html}</div>
  </div>`
}

// Map of company names → primary domain for favicon lookup. Add to
// this when new brands come up in production. Lookup is case-
// insensitive; the renderer normalizes name before checking. Any
// brand NOT in this map falls back to `<name-lowered>.com` as a best
// guess, then to the single-letter glyph if the favicon fails.
const BRAND_DOMAINS = {
  claude:       'claude.ai',
  anthropic:    'anthropic.com',
  chatgpt:      'openai.com',
  openai:       'openai.com',
  heygen:       'heygen.com',
  notion:       'notion.so',
  shopify:      'shopify.com',
  stripe:       'stripe.com',
  youtube:      'youtube.com',
  tiktok:       'tiktok.com',
  instagram:    'instagram.com',
  meta:         'meta.com',
  facebook:     'facebook.com',
  twitter:      'twitter.com',
  x:            'x.com',
  google:       'google.com',
  apple:        'apple.com',
  microsoft:    'microsoft.com',
  github:       'github.com',
  elevenlabs:   'elevenlabs.io',
  cursor:       'cursor.com',
  vercel:       'vercel.com',
  supabase:     'supabase.com',
  figma:        'figma.com',
  canva:        'canva.com',
  midjourney:   'midjourney.com',
  perplexity:   'perplexity.ai',
  gemini:       'gemini.google.com',
  runway:       'runwayml.com',
  scalesolo:    'scalesolo.com',
}

function brandDomainFor(name) {
  if (!name || typeof name !== 'string') return null
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (BRAND_DOMAINS[key]) return BRAND_DOMAINS[key]
  if (/^[a-z0-9-]+$/.test(key) && key.length >= 3) return `${key}.com`
  return null
}

function renderTool(c, t) {
  const name = c.name || ''
  const fallbackGlyph = esc(c.logo || (name ? name[0].toUpperCase() : '?'))
  const domain = brandDomainFor(name)
  // Use Google's S2 favicon service. Free, no API key, 128px max.
  // Falls back to single-letter glyph if the image fails to load
  // (onerror swaps the <img> for a <span>).
  const inner = domain
    ? `<img src="https://www.google.com/s2/favicons?domain=${esc(domain)}&sz=128" alt="${esc(name)}" onerror="this.outerHTML='<span>${fallbackGlyph}</span>'">`
    : `<span>${fallbackGlyph}</span>`
  return `<div class="ov-tool"${containerStyle(t.container)}>
    <div class="logo"${textStyle(t.logo)}>${inner}</div>
    <div class="info">
      <div class="name"${textStyle(t.name)}>${esc(name)}</div>
    </div>
  </div>`
}

function renderWatermark(c, t) {
  const prefix = t.prefix && t.prefix.char && t.prefix.char !== '@'
    ? `<span style="color:${t.prefix.color || 'var(--accent)'};margin-right:${t.prefix.margin_right_px || 4}px">${esc(t.prefix.char)}</span>` : ''
  const suppressBefore = prefix ? ' data-no-prefix="1"' : ''
  return `<div class="ov-watermark"${containerStyle(t.container)}${suppressBefore}>${prefix}${esc(c.handle || '')}</div>`
}

function renderAction(c, t) {
  return `<div class="ov-action"${containerStyle(t.container)}>
    <span class="arrow"${textStyle(t.arrow)}>${esc(c.arrow || '↓')}</span><span${textStyle(t.text)}>${esc(c.text || '')}</span>
  </div>`
}

function renderSource(c, t) {
  return `<div class="ov-source"${containerStyle(t.container)}>
    <div class="label"${textStyle(t.label)}>${esc(c.label || 'Source')}</div>
    <div class="citation"${textStyle(t.citation)}>${esc(c.citation || '')}</div>
  </div>`
}

function renderChapter(c, t) {
  const stripOff = t.side_strip && t.side_strip.enabled === false
  return `<div class="ov-chapter"${containerStyle(t.container)}${stripOff ? ' data-no-strip="1"' : ''}>
    <div class="meta"${textStyle(t.meta)}>${esc(c.meta || '')}</div>
    <div class="title"${textStyle(t.title)}>${esc(c.title || '')}</div>
  </div>`
}

// Dispatch table.
const RENDERERS = {
  'stat-callout-v1':    renderStat,
  'word-emphasis-v1':   renderEmphasis,
  'caption-overlay-v1': renderCaption,
  'tool-logo-v1':       renderTool,
  'watermark-v1':       renderWatermark,
  'action-prompt-v1':   renderAction,
  'source-citation-v1': renderSource,
  'chapter-marker-v1':  renderChapter,
}

/**
 * Render a single overlay card to an HTML string.
 *
 * @param {object} args
 * @param {string} args.overlay_id        — registry key
 * @param {object} args.content           — slot values: { label, number, ... }
 * @param {object} [args.tokens]          — template overlay_overrides[overlay_id]
 * @param {string} [args.accent]          — brand color, used to interpolate {accent}
 *                                          in tokens if they aren't already resolved.
 * @returns {string} HTML string for the inner card (no positioning wrapper)
 */
export function renderOverlay({ overlay_id, content, tokens = {}, accent }) {
  const def = OVERLAY_DEFINITIONS[overlay_id]
  if (!def) {
    return `<!-- unknown overlay: ${esc(overlay_id)} -->`
  }
  const fn = RENDERERS[overlay_id]
  if (!fn) {
    return `<!-- overlay ${esc(overlay_id)} has no renderer yet -->`
  }
  const resolvedTokens = accent ? resolveAccent(tokens, accent) : tokens
  return fn(content || {}, resolvedTokens)
}

/**
 * Render a full overlay layer — a list of placements positioned in
 * their resolved zones. Returns a single `.overlay-layer` element with
 * one positioned `.ov.<zone>` child per placement.
 *
 * @param {object} args
 * @param {Array<{overlay_id, resolved_zone, content}>} args.placements
 * @param {'landscape'|'vertical'} args.orientation
 * @param {object} [args.overlay_overrides]   — keyed by overlay_id
 * @param {string} [args.accent]
 * @returns {string} HTML string for the full layer
 */
export function renderOverlayLayer({ placements, orientation, overlay_overrides = {}, accent }) {
  const cards = (placements || []).map((p) => {
    const tokens = overlay_overrides[p.overlay_id] || {}
    const inner = renderOverlay({
      overlay_id: p.overlay_id,
      content: p.content,
      tokens,
      accent,
    })
    const zone = esc(p.resolved_zone || p.zone || 'r-mid')
    return `<div class="ov ${zone}" data-overlay-id="${esc(p.overlay_id)}">${inner}</div>`
  }).join('\n')

  return `<div class="overlay-layer" data-orientation="${esc(orientation || 'landscape')}">${cards}</div>`
}
