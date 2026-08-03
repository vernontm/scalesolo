// Locked TYPOGRAPHY compositor for carousels. The image model paints the
// background/person only; the headline and body are rendered here with fixed
// fonts, sizes, weights, tracking and leading and composited on, so every
// slide in a set is typographically pixel-identical (same as how the signature
// is composited). Only the words change slide to slide.

import sharp from 'sharp'
import { Resvg } from '@resvg/resvg-js'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FONTS_DIR = join(__dirname, '..', '_fonts')

// Headline face per theme (family name MUST match the font file's family).
// Body is always Montserrat (variable) so there is no family collision.
const HEADLINE_FONT = {
  modern: { file: 'Anton-Regular.ttf', family: 'Anton', upper: true },
  bold: { file: 'Anton-Regular.ttf', family: 'Anton', upper: true },
  edgy: { file: 'Anton-Regular.ttf', family: 'Anton', upper: true },
  retro: { file: 'Anton-Regular.ttf', family: 'Anton', upper: true },
  futuristic: { file: 'Oswald-Bold.ttf', family: 'Oswald', upper: true },
  minimal: { file: 'Oswald-Bold.ttf', family: 'Oswald', upper: false },
  cursive: { file: 'GreatVibes-Regular.ttf', family: 'Great Vibes', upper: false },
}
const HEADLINE_DEFAULT = HEADLINE_FONT.bold
const BODY = { file: 'Montserrat-Variable.ttf', family: 'Montserrat', weight: 500 }

const fontFiles = [
  ...new Set(Object.values(HEADLINE_FONT).map((f) => f.file).concat(BODY.file)),
].map((f) => join(FONTS_DIR, f))

const fontOpts = { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Anton' }

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// Measure a single line's pixel width with the real font (resvg bbox probe).
function measure(line, { family, weight, size, box }) {
  try {
    const probe = `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${Math.round(size * 1.8)}"><text x="0" y="${size}" font-family="${family}" font-size="${size}"${weight ? ` font-weight="${weight}"` : ''} fill="#000">${escapeXml(line)}</text></svg>`
    const bb = new Resvg(Buffer.from(probe), { font: fontOpts, background: 'rgba(0,0,0,0)' }).getBBox()
    if (bb && bb.width) return bb.width
  } catch {}
  return Math.min(box, line.length * size * 0.55)
}

// Greedy word-wrap constrained to a pixel width using real metrics.
function wrap(text, { family, weight, size, box }) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w
    if (cur && measure(trial, { family, weight, size, box }) > box) { lines.push(cur); cur = w }
    else cur = trial
  }
  if (cur) lines.push(cur)
  return lines
}

// Build the headline <text> lines with optional accent-colored words.
function headlineSvg(lines, { x, startY, size, lineHeight, family, weight, tracking, color, accentColor, accentSet }) {
  return lines.map((line, i) => {
    const y = startY + i * lineHeight
    const inner = line.split(/\s+/).map((word) => {
      const key = word.toLowerCase().replace(/[^a-z0-9]/g, '')
      const fill = accentSet && accentSet.has(key) ? accentColor : color
      return `<tspan fill="${fill}">${escapeXml(word)} </tspan>`
    }).join('')
    return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}"${weight ? ` font-weight="${weight}"` : ''} letter-spacing="${tracking}" xml:space="preserve">${inner}</text>`
  }).join('\n')
}

// KNOCKOUT headline (editorial template): runs of accent words sit inside a
// solid accent-color box with the letters knocked out (background color);
// everything else is plain ink. Words are laid out individually from real
// glyph measurements so each box hugs its run exactly.
function headlineSvgKnockout(lines, { startY, size, lineHeight, family, ink, accentColor, knockText, accentSet, box }) {
  const gap = Math.round(size * 0.26)         // inter-word gap
  const padX = Math.round(size * 0.14)        // box side padding
  const boxTop = Math.round(size * 0.86)      // box rises this far above baseline
  const boxDrop = Math.round(size * 0.16)     // and drops this far below
  const parts = []
  lines.forEach((line, li) => {
    const y = startY + li * lineHeight
    const words = line.split(/\s+/).filter(Boolean)
    // Lay each word out left-to-right with measured widths.
    let cx = 0
    const placed = words.map((w) => {
      const wWidth = measure(w, { family, size, box })
      const p = { word: w, x: cx, w: wWidth, acc: accentSet && accentSet.has(w.toLowerCase().replace(/[^a-z0-9]/g, '')) }
      cx += wWidth + gap
      return p
    })
    // Boxes behind consecutive accent runs.
    let run = null
    const flush = () => {
      if (!run) return
      parts.push(`<rect x="${run.x0 - padX}" y="${y - boxTop}" width="${run.x1 - run.x0 + padX * 2}" height="${boxTop + boxDrop}" fill="${accentColor}" />`)
      run = null
    }
    for (const p of placed) {
      if (p.acc) { if (!run) run = { x0: p.x, x1: p.x + p.w }; else run.x1 = p.x + p.w }
      else flush()
    }
    flush()
    // The words themselves (knocked-out inside boxes, ink outside).
    for (const p of placed) {
      parts.push(`<text x="${p.x}" y="${y}" font-family="${family}" font-size="${size}" fill="${p.acc ? knockText : ink}">${escapeXml(p.word)}</text>`)
    }
  })
  return parts.join('\n')
}

// Render the full locked text block (headline + body) as a transparent PNG
// sized to the text column. Returns { png, width, height }.
export function renderTextBlock({ headline, body, accent, theme, colWidth, ink, accentColor, knockout, knockText }) {
  const hf = HEADLINE_FONT[theme] || HEADLINE_DEFAULT
  const hSize = Math.round(colWidth * 0.135)
  const hLine = Math.round(hSize * (hf.family === 'Great Vibes' ? 1.05 : 1.0))
  const hTrack = Math.round(hSize * -0.01)
  const bSize = Math.round(colWidth * 0.052)
  const bLine = Math.round(bSize * 1.42)
  const gap = Math.round(hSize * 0.55)
  const color = ink === 'light' ? '#ffffff' : '#141414'
  const bodyColor = ink === 'light' ? 'rgba(255,255,255,0.92)' : 'rgba(20,20,20,0.86)'

  const headText = hf.upper ? String(headline || '').toUpperCase() : String(headline || '')
  const hLines = wrap(headText, { family: hf.family, size: hSize, box: colWidth })
  const accentSet = accent
    ? new Set(String(accent).toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean))
    : null

  // Body: split into paragraphs on blank lines, wrap each.
  const paras = String(body || '').split(/\n{2,}|\r?\n/).map((p) => p.trim()).filter(Boolean)
  const bLinesByPara = paras.map((p) => wrap(p, { family: BODY.family, weight: BODY.weight, size: bSize, box: colWidth }))

  const hBlockH = hLines.length * hLine
  let bBlockH = 0
  bLinesByPara.forEach((lines, i) => { bBlockH += lines.length * bLine; if (i < bLinesByPara.length - 1) bBlockH += Math.round(bLine * 0.5) })
  const totalH = hBlockH + (bBlockH ? gap + bBlockH : 0) + Math.round(hSize * 0.3)

  const hStartY = hSize
  // Knockout mode shifts content right by the box padding so a box on the
  // first word isn't clipped by the SVG edge.
  const hSvg = knockout
    ? `<g transform="translate(${Math.round(hSize * 0.14)},0)">${headlineSvgKnockout(hLines, { startY: hStartY, size: hSize, lineHeight: hLine, family: hf.family, ink: color, accentColor, knockText: knockText || '#f5f0e8', accentSet, box: colWidth })}</g>`
    : headlineSvg(hLines, { x: 0, startY: hStartY, size: hSize, lineHeight: hLine, family: hf.family, weight: null, tracking: hTrack, color, accentColor, accentSet })

  let by = hBlockH + gap + bSize
  const bSvgParts = []
  bLinesByPara.forEach((lines) => {
    lines.forEach((line) => {
      bSvgParts.push(`<text x="0" y="${by}" font-family="${BODY.family}" font-size="${bSize}" font-weight="${BODY.weight}" fill="${bodyColor}">${escapeXml(line)}</text>`)
      by += bLine
    })
    by += Math.round(bLine * 0.5)
  })

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${colWidth}" height="${totalH}">${hSvg}\n${bSvgParts.join('\n')}</svg>`
  const png = new Resvg(Buffer.from(svg), { background: 'rgba(0,0,0,0)', font: fontOpts }).render().asPng()
  return { png, height: totalH }
}

async function uploadPng(buf, profileId) {
  const path = `${profileId || 'shared'}/carousel/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  const up = await fetch(
    `${process.env.SUPABASE_URL}/storage/v1/object/landing-media/${encodeURI(path)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'image/png', 'x-upsert': 'true' }, body: buf },
  )
  if (!up.ok) throw new Error(`text upload failed (${up.status})`)
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/landing-media/${path}`
}

// Composite the locked headline + body onto a slide image. `person` shifts the
// text into the left column; otherwise it spans a wider left-aligned column.
// Returns the original url on any failure (best-effort).
export async function compositeSlideText(imageUrl, { headline, body, accent, theme, ink = 'dark', accentColor, person, profileId, knockout, knockText } = {}) {
  try {
    if (!headline && !body) return imageUrl
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return imageUrl
    const r = await fetch(imageUrl)
    if (!r.ok) return imageUrl
    const base = sharp(Buffer.from(await r.arrayBuffer()))
    const meta = await base.metadata()
    const W = meta.width || 1024
    const H = meta.height || 1365
    const marginX = Math.round(W * 0.06)
    const marginTop = Math.round(H * 0.08)
    const colWidth = Math.round(W * (person ? 0.5 : 0.82))
    const { png } = renderTextBlock({ headline, body, accent, theme, colWidth, ink, accentColor: accentColor || '#ff3b30', knockout, knockText })
    const out = await base
      .composite([{ input: png, left: marginX, top: marginTop }])
      .png()
      .toBuffer()
    return await uploadPng(out, profileId)
  } catch {
    return imageUrl
  }
}
