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

export async function renderTitlePng({
  title,
  font = 'Poppins ExtraBold',
  size = 72,
  color = '#ffffff',
  bg_color = '#e0467a',
  bg_padding = 28,
  uppercase = false,
  max_width = 1080,
} = {}) {
  const text = uppercase ? String(title || '').toUpperCase() : String(title || '')
  const lines = wrapForSvg(text, size, max_width)
  if (!lines.length) return null

  const cfg = fontConfig(font)
  const lineHeight  = Math.round(size * 1.18)
  const totalText   = lines.length * lineHeight
  const blockHeight = totalText + bg_padding * 2
  const blockWidth  = max_width

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${blockWidth}" height="${blockHeight}">
    <rect x="0" y="0" width="${blockWidth}" height="${blockHeight}" rx="${Math.round(bg_padding * 0.4)}" ry="${Math.round(bg_padding * 0.4)}" fill="${bg_color}" />
    ${lines.map((l, i) => {
      const y = bg_padding + (i + 1) * lineHeight - Math.round(size * 0.2)
      return `<text x="${blockWidth / 2}" y="${y}" font-family="${cfg.family}" font-size="${size}" font-weight="${cfg.weight}" fill="${color}" text-anchor="middle" dominant-baseline="alphabetic">${escapeXml(l)}</text>`
    }).join('\n    ')}
  </svg>`

  const resvg = new Resvg(Buffer.from(svg), {
    background: 'rgba(0,0,0,0)',
    font: {
      // Register every bundled .ttf so any choice in the dropdown finds
      // its face. resvg pulls the `name` table family from each file.
      fontFiles: Object.values(FONT_FILES).map((f) => join(FONTS_DIR, f.file))
        .concat(join(FONTS_DIR, FALLBACK.file)),
      // Fallback chain when an SVG font-family doesn't match anything.
      defaultFontFamily: cfg.family,
      loadSystemFonts: false,
    },
  })
  return resvg.render().asPng()
}
