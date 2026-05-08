// SVG → PNG title-overlay renderer.
//
// The drawtext path in api/videos/polish.js was producing visibly off-
// center text because:
//   • ffmpeg < 7 has no text_align option, so multi-line drawtext
//     renders left-aligned within its drawn box.
//   • The fix attempted in wrapTitleLines() pads shorter lines with
//     space chars to "match" the longest line. Spaces aren't the
//     same width as average glyphs in proportional fonts, so the
//     centering is a few pixels off — visible on bold faces with
//     wide glyph variance (Montserrat ExtraBold, Poppins ExtraBold).
//
// This renderer takes the same title + style props and produces a PNG
// with the text *truly centered*: SVG `<text text-anchor="middle">`
// uses real glyph metrics from the embedded font. Worker has its own
// copy of this logic (same SVG, same approach); we keep them in sync
// by hand because they live in different deploy targets.
//
// renderTitlePng({ title, font, size, color, bg_color, bg_padding,
//                  uppercase, max_width }) → Buffer (PNG bytes) | null

import sharp from 'sharp'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Filename mapping from the dropdown labels in the UI to the bundled
// .ttf in api/_fonts/. Drop matching files there to enable the look;
// missing files silently fall back to a system sans, which still
// centers correctly via SVG text metrics — just without the brand
// face.
const FONT_FILES = {
  'Montserrat ExtraBold': 'Montserrat-ExtraBold.ttf',
  'Poppins ExtraBold':    'Poppins-ExtraBold.ttf',
  'Inter ExtraBold':      'Inter-ExtraBold.ttf',
  'Bebas Neue':           'BebasNeue-Regular.ttf',
  'Anton':                'Anton-Regular.ttf',
  'Oswald':               'Oswald-Bold.ttf',
  'Roboto Black':         'Roboto-Black.ttf',
}

const _fontCache = new Map()
async function loadFontFaceCss(filename) {
  if (_fontCache.has(filename)) return _fontCache.get(filename)
  const path = join(__dirname, '..', '_fonts', filename)
  try {
    const buf = await readFile(path)
    const css = `@font-face { font-family: 'TitleFont'; font-style: normal; font-weight: 800; src: url(data:font/ttf;base64,${buf.toString('base64')}) format('truetype'); }`
    _fontCache.set(filename, css)
    return css
  } catch {
    _fontCache.set(filename, '')
    return ''
  }
}

// Greedy word wrap. SVG itself doesn't auto-wrap, so we precompute the
// line breaks. The width estimate is approximate (font * 0.58); SVG's
// actual rasterizer will use real metrics for the centering, so a few
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

  const lineHeight  = Math.round(size * 1.18)
  const totalText   = lines.length * lineHeight
  const blockHeight = totalText + bg_padding * 2
  const blockWidth  = max_width

  const fontFile = FONT_FILES[font] || FONT_FILES['Roboto Black']
  const fontFaceCss = fontFile ? await loadFontFaceCss(fontFile) : ''
  const fontFamilyCss = fontFaceCss ? "'TitleFont', sans-serif" : 'sans-serif'

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${blockWidth}" height="${blockHeight}">
    <style>${fontFaceCss}
      .t { font-family: ${fontFamilyCss}; font-size: ${size}px; font-weight: 800; fill: ${color}; }
    </style>
    <rect x="0" y="0" width="${blockWidth}" height="${blockHeight}" rx="${Math.round(bg_padding * 0.4)}" ry="${Math.round(bg_padding * 0.4)}" fill="${bg_color}" />
    ${lines.map((l, i) => {
      const y = bg_padding + (i + 1) * lineHeight - Math.round(size * 0.2)
      return `<text class="t" x="${blockWidth / 2}" y="${y}" text-anchor="middle" dominant-baseline="alphabetic">${escapeXml(l)}</text>`
    }).join('\n    ')}
  </svg>`

  // density=144 raises the rendered DPI so rounded edges aren't blurry
  // when overlaid on 1080p video.
  return sharp(Buffer.from(svg), { density: 144 })
    .png({ compressionLevel: 6 })
    .toBuffer()
}
