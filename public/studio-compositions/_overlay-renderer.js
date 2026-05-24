// Browser copy of api/studio/_lib/overlay-renderer.js. Kept in sync by
// hand — both files have the same logic and must produce byte-identical
// HTML for a given (overlay_id, content, tokens, accent) input. The
// browser copy embeds OVERLAY_IDS inline so we don't need a second
// import in the iframe.
//
// If you edit one, edit both. There's a smoke check in
// scripts/smoke-overlay-renderer.test.js (not yet written) that diffs
// the two against a fixture.

const OVERLAY_IDS = new Set([
  'stat-callout-v1',
  'word-emphasis-v1',
  'caption-overlay-v1',
  'tool-logo-v1',
  'watermark-v1',
  'action-prompt-v1',
  'source-citation-v1',
  'chapter-marker-v1',
])

function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function withAccent(value, accent) {
  if (typeof value !== 'string' || !accent) return value
  return value.replace(/\{accent\}/g, accent)
}

function resolveAccent(node, accent) {
  if (Array.isArray(node)) return node.map((v) => resolveAccent(v, accent))
  if (node && typeof node === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(node)) out[k] = resolveAccent(v, accent)
    return out
  }
  return withAccent(node, accent)
}

function containerStyle(c) {
  if (!c) return ''
  const props = []
  if (c.background) props.push(`background: ${c.background}`)
  if (c.border) props.push(`border: ${c.border}`)
  if (c.border_left) props.push(`border-left: ${c.border_left}`)
  if (c.color) props.push(`color: ${c.color}`)
  if (c.padding) props.push(`padding: ${c.padding}`)
  if (c.line_height != null) props.push(`line-height: ${c.line_height}`)
  if (c.text_align) props.push(`text-align: ${c.text_align}`)
  if (c.gap_px != null) props.push(`gap: ${c.gap_px}px`)
  if (c.border_radius_px != null) {
    const r = typeof c.border_radius_px === 'number' ? `${c.border_radius_px}px` : c.border_radius_px
    props.push(`border-radius: ${r}`)
  }
  if (c.backdrop_blur_px != null) {
    props.push(`backdrop-filter: blur(${c.backdrop_blur_px}px)`)
    props.push(`-webkit-backdrop-filter: blur(${c.backdrop_blur_px}px)`)
  }
  if (c.box_shadow) props.push(`box-shadow: ${c.box_shadow}`)
  if (c.layout === 'flex_row') { props.push('display: flex'); props.push('align-items: center') }
  return props.length ? ` style="${props.join('; ')}"` : ''
}

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

function renderTool(c, t) {
  return `<div class="ov-tool"${containerStyle(t.container)}>
    <div class="logo"${textStyle(t.logo)}>${esc(c.logo || '')}</div>
    <div class="info">
      <div class="name"${textStyle(t.name)}>${esc(c.name || '')}</div>
      ${c.desc ? `<div class="desc"${textStyle(t.desc)}>${esc(c.desc)}</div>` : ''}
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

export function renderOverlay({ overlay_id, content, tokens = {}, accent }) {
  if (!OVERLAY_IDS.has(overlay_id)) return `<!-- unknown overlay: ${esc(overlay_id)} -->`
  const fn = RENDERERS[overlay_id]
  if (!fn) return `<!-- overlay ${esc(overlay_id)} has no renderer yet -->`
  const resolved = accent ? resolveAccent(tokens, accent) : tokens
  return fn(content || {}, resolved)
}

export function renderOverlayLayer({ placements, orientation, overlay_overrides = {}, accent }) {
  const cards = (placements || []).map((p) => {
    const tokens = overlay_overrides[p.overlay_id] || {}
    const inner = renderOverlay({ overlay_id: p.overlay_id, content: p.content, tokens, accent })
    const zone = esc(p.resolved_zone || p.zone || 'r-mid')
    return `<div class="ov ${zone}" data-overlay-id="${esc(p.overlay_id)}">${inner}</div>`
  }).join('\n')
  return `<div class="overlay-layer" data-orientation="${esc(orientation || 'landscape')}">${cards}</div>`
}
