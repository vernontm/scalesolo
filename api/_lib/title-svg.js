// SVG → PNG title-overlay renderer.
//
// Renders a centered, wrapped title block as a PNG. We use @resvg/resvg-js
// (a Rust-backed SVG rasterizer) instead of sharp's librsvg, because
// librsvg's @font-face data-URI support is unreliable on Vercel's
// serverless runtime — it silently falls back to whatever sans is
// registered with fontconfig, and on Vercel that's effectively nothing,
// so glyphs render as tofu rectangles.
//
// resvg accepts an explicit `font.fontFiles` array of TTF paths and
// registers them with its own font database. As long as the SVG's
// `font-family` matches the font's `name` table family, layout works
// reliably across cold starts.

import { Resvg } from '@resvg/resvg-js'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FONTS_DIR = join(__dirname, '..', '_fonts')

// Filename mapping from the dropdown labels in the UI to the bundled
// .ttf in api/_fonts/. The "family" string MUST match the font file's
// embedded family name — that's what resvg uses to pick the glyph table.
// The names below are taken from the Google Fonts metadata of each
// distributed file.
const FONT_FILES = {
  'Montserrat ExtraBold': { file: 'Montserrat-ExtraBold.ttf', family: 'Montserrat',  weight: 800 },
  'Poppins ExtraBold':    { file: 'Poppins-ExtraBold.ttf',    family: 'Poppins',     weight: 800 },
  'Inter ExtraBold':      { file: 'Inter-ExtraBold.ttf',      family: 'Inter 18pt',  weight: 800 },
  'Bebas Neue':           { file: 'BebasNeue-Regular.ttf',    family: 'Bebas Neue',  weight: 400 },
  'Anton':                { file: 'Anton-Regular.ttf',        family: 'Anton',       weight: 400 },
  'Oswald':               { file: 'Oswald-Bold.ttf',          family: 'Oswald',      weight: 700 },
  'Roboto Black':         { file: 'Roboto-Black.ttf',         family: 'Roboto',      weight: 900 },
}

const FALLBACK = { file: 'Sans-Bold.ttf', family: 'Roboto', weight: 700 }

// Pick a font config for a label, falling back to Sans-Bold.
function fontConfig(label) {
  return FONT_FILES[label] || FALLBACK
}

// Greedy word wrap. The width estimate is approximate (font * 0.58);
// resvg's actual rasterizer uses real metrics for centering, so a few
// extra characters per line are fine.
function wrapForSvg(text, fontSize, maxWidth) {
  const usableWidth = maxWidth * 0.82
  const glyphWidth = fontSize * 0.58
  const maxChars = Math.max(6, Math.floor(usableWidth / glyphWidth))
  const words = String(text || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const lines = []
  let cur = ''
  for (const w of words) {
    if (!cur) { cur = w; continue }
    if ((cur + ' ' + w).length > maxChars) { lines.push(cur); cur = w }
    else cur = cur + ' ' + w
  }
  if (cur) lines.push(cur)
  return lines
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// Measure a single line's rendered width via a one-line probe SVG.
// Returns the text bbox width in px so per-line pill backgrounds can
// hug each line individually (Hormozi-style) instead of one big rect.
function measureLineWidth(line, { fontOpts, family, weight, size, blockWidth }) {
  try {
    const probe = `<svg xmlns="http://www.w3.org/2000/svg" width="${blockWidth}" height="${Math.round(size * 1.6)}"><text x="${blockWidth / 2}" y="${size}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="#000" text-anchor="middle" dominant-baseline="alphabetic">${escapeXml(line)}</text></svg>`
    const bb = new Resvg(Buffer.from(probe), { font: fontOpts, background: 'rgba(0,0,0,0)' }).getBBox()
    if (bb && bb.width) return bb.width
  } catch {}
  // Fallback estimate when resvg's bbox probe fails on a glyph it
  // doesn't have in its registered font db.
  return Math.min(blockWidth, line.length * size * 0.58)
}

export async function renderTitlePng({
  title,
  font = 'Poppins ExtraBold',
  size = 72,
  color = '#ffffff',
  bg_color = '#e0467a',
  bg_padding = 28,
  bg_mode = 'block',        // 'block' = one rounded rect around all lines (legacy)
                            // 'per_line' = one pill per line that hugs each line's text width
  bg_line_gap = 8,          // px gap between per-line pills when bg_mode='per_line'
  uppercase = false,
  max_width = 1080,
} = {}) {
  const text = uppercase ? String(title || '').toUpperCase() : String(title || '')
  const lines = wrapForSvg(text, size, max_width)
  if (!lines.length) return null

  const cfg = fontConfig(font)
  const lineHeight  = Math.round(size * 1.18)
  const blockWidth  = max_width

  const fontOpts = {
    fontFiles: Object.values(FONT_FILES).map((f) => join(FONTS_DIR, f.file))
      .concat(join(FONTS_DIR, FALLBACK.file)),
    defaultFontFamily: cfg.family,
    loadSystemFonts: false,
  }

  // ── Per-line "pill" mode: each line gets its own rounded rect that
  //    hugs just that line's text width. Pills stack vertically with
  //    bg_line_gap between them. This is the TikTok-style title look
  //    where each line is its own highlighted chip.
  if (bg_mode === 'per_line') {
    const pillVPad = Math.round(bg_padding * 0.45)   // vertical padding INSIDE each pill
    const pillHPad = Math.round(bg_padding * 0.75)   // horizontal padding INSIDE each pill
    const pillHeight = lineHeight + pillVPad * 2
    const blockHeight = pillHeight * lines.length + bg_line_gap * (lines.length - 1)
    const radius = Math.round(pillHeight * 0.22)

    const linesSvg = lines.map((line, i) => {
      const w = measureLineWidth(line, { fontOpts, family: cfg.family, weight: cfg.weight, size, blockWidth })
      const rectWidth = Math.min(blockWidth, Math.round(w + pillHPad * 2))
      const rectX = Math.round((blockWidth - rectWidth) / 2)
      const rectY = i * (pillHeight + bg_line_gap)
      const textY = rectY + pillVPad + lineHeight - Math.round(size * 0.2)
      return `
        <rect x="${rectX}" y="${rectY}" width="${rectWidth}" height="${pillHeight}" rx="${radius}" ry="${radius}" fill="${bg_color}" />
        <text x="${blockWidth / 2}" y="${textY}" font-family="${cfg.family}" font-size="${size}" font-weight="${cfg.weight}" fill="${color}" text-anchor="middle" dominant-baseline="alphabetic">${escapeXml(line)}</text>`
    }).join('\n    ')

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${blockWidth}" height="${blockHeight}">${linesSvg}</svg>`
    return new Resvg(Buffer.from(svg), { background: 'rgba(0,0,0,0)', font: fontOpts }).render().asPng()
  }

  // ── Block mode (default): one rounded rect around the entire text
  //    block, sized to hug the widest line. Existing behavior.
  const totalText   = lines.length * lineHeight
  const blockHeight = totalText + bg_padding * 2

  const probeLines = lines.map((l, i) => {
    const y = bg_padding + (i + 1) * lineHeight - Math.round(size * 0.2)
    return `<text x="${blockWidth / 2}" y="${y}" font-family="${cfg.family}" font-size="${size}" font-weight="${cfg.weight}" fill="${color}" text-anchor="middle" dominant-baseline="alphabetic">${escapeXml(l)}</text>`
  }).join('\n    ')
  const probeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${blockWidth}" height="${blockHeight}">${probeLines}</svg>`
  let textWidth = blockWidth
  try {
    const bb = new Resvg(Buffer.from(probeSvg), { font: fontOpts, background: 'rgba(0,0,0,0)' }).getBBox()
    if (bb && bb.width) textWidth = bb.width
  } catch {}

  const rectWidth = Math.min(blockWidth, Math.round(textWidth + bg_padding * 2))
  const rectX     = Math.round((blockWidth - rectWidth) / 2)

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${blockWidth}" height="${blockHeight}">
    <rect x="${rectX}" y="0" width="${rectWidth}" height="${blockHeight}" rx="${Math.round(bg_padding * 0.4)}" ry="${Math.round(bg_padding * 0.4)}" fill="${bg_color}" />
    ${probeLines}
  </svg>`

  return new Resvg(Buffer.from(svg), { background: 'rgba(0,0,0,0)', font: fontOpts }).render().asPng()
}
