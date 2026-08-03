// Brand name + handle "signature" lockup, composited onto every carousel
// slide so it lands reliably (pixel-perfect) instead of hoping the image
// model spells it right. Name is set in a script face (Great Vibes),
// the handle in a clean uppercase sans, bottom-left with a soft shadow so
// it reads on light or dark slides.

import sharp from 'sharp'
import { Resvg } from '@resvg/resvg-js'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FONTS_DIR = join(__dirname, '..', '_fonts')
const SCRIPT_FONT = join(FONTS_DIR, 'GreatVibes-Regular.ttf')   // family: "Great Vibes"
const SANS_FONT = join(FONTS_DIR, 'Montserrat-ExtraBold.ttf')   // family: "Montserrat"

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// Render the signature block as a transparent PNG at the given pixel width.
// `dark` picks near-black text with a soft light glow (for light slides);
// otherwise white text with a soft dark shadow (for dark slides).
function renderSignaturePng({ name, handle, width, dark }) {
  const nameSize = Math.round(width * 0.115)
  const handleSize = Math.round(width * 0.042)
  const padX = Math.round(width * 0.02)
  const gap = Math.round(nameSize * 0.12)
  const height = Math.round(nameSize * 1.15 + gap + handleSize * 1.5)
  const fill = dark ? '#141414' : '#ffffff'
  const shadow = dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.45)'
  const nameY = Math.round(nameSize * 0.92)
  const handleY = Math.round(nameY + gap + handleSize * 1.1)
  const cleanHandle = handle ? (handle.startsWith('@') ? handle : `@${handle}`).toUpperCase() : ''

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="1" stdDeviation="${Math.max(1, Math.round(nameSize * 0.03))}" flood-color="${shadow}" flood-opacity="1"/>
      </filter>
    </defs>
    <g filter="url(#sh)">
      <text x="${padX}" y="${nameY}" font-family="Great Vibes" font-size="${nameSize}" word-spacing="${Math.round(nameSize * 0.18)}" fill="${fill}" dominant-baseline="alphabetic">${escapeXml(name)}</text>
      ${cleanHandle ? `<text x="${padX}" y="${handleY}" font-family="Montserrat" font-weight="800" font-size="${handleSize}" letter-spacing="${Math.round(handleSize * 0.14)}" fill="${fill}" dominant-baseline="alphabetic">${escapeXml(cleanHandle)}</text>` : ''}
    </g>
  </svg>`

  return new Resvg(Buffer.from(svg), {
    background: 'rgba(0,0,0,0)',
    font: { fontFiles: [SCRIPT_FONT, SANS_FONT], loadSystemFonts: false, defaultFontFamily: 'Great Vibes' },
  }).render().asPng()
}

// Upload a buffer to Supabase storage (landing-media bucket, public) and
// return the public URL. Mirrors api/images/_mirror.js.
async function uploadPng(buf, profileId) {
  const path = `${profileId || 'shared'}/carousel/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  const up = await fetch(
    `${process.env.SUPABASE_URL}/storage/v1/object/landing-media/${encodeURI(path)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'image/png', 'x-upsert': 'true' }, body: buf },
  )
  if (!up.ok) throw new Error(`lockup upload failed (${up.status})`)
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/landing-media/${path}`
}

// Fetch a slide image, composite the signature bottom-left, re-upload, and
// return the new URL. Returns the original url on any failure (best-effort).
export async function compositeLockup(imageUrl, { name, handle, dark = true, profileId } = {}) {
  try {
    if (!name && !handle) return imageUrl
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return imageUrl
    const r = await fetch(imageUrl)
    if (!r.ok) return imageUrl
    const base = sharp(Buffer.from(await r.arrayBuffer()))
    const meta = await base.metadata()
    const W = meta.width || 1024
    const H = meta.height || 1365
    const sigWidth = Math.round(W * 0.42)
    const sig = renderSignaturePng({ name, handle, width: sigWidth, dark })
    const sigMeta = await sharp(sig).metadata()
    const margin = Math.round(W * 0.055)
    const top = Math.round(H - (sigMeta.height || 0) - margin)
    const out = await base
      .composite([{ input: sig, left: margin, top: Math.max(0, top) }])
      .png()
      .toBuffer()
    return await uploadPng(out, profileId)
  } catch {
    return imageUrl
  }
}
