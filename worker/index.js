// ScaleSolo render worker.
//
// Runs the long-tail jobs that hit Vercel's 60s ceiling — primarily the
// video_polish pipeline (ffmpeg compositing of title + watermark + music
// + ZapCap captions). Vercel's polish.js becomes a thin proxy when
// WORKER_URL is set on the Vercel side; the proxy forwards the request,
// the worker does the heavy lifting on Railway with no time limit and
// pre-bundled fonts (no per-cold-start GitHub fetch).
//
// Endpoints:
//   GET  /healthz                — uptime probe
//   POST /jobs/polish            — same body shape as Vercel /api/videos/polish
//   POST /jobs/title-png         — render a title overlay PNG (SVG → sharp);
//                                  used by polish itself, but exposed so the
//                                  Vercel function can hit it directly when we
//                                  haven't moved the full polish over yet.
//
// Auth: shared secret in `x-worker-secret` header. Set `WORKER_SHARED_SECRET`
// on Railway and the same value on Vercel; mismatched requests get 401.

import express from 'express'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import sharp from 'sharp'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PORT          = Number(process.env.PORT || 8080)
const SECRET        = process.env.WORKER_SHARED_SECRET || ''
const SUPABASE_URL  = process.env.SUPABASE_URL
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY
const ffmpegPath    = ffmpegInstaller.path

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.warn('[worker] SUPABASE_URL / SUPABASE_SERVICE_KEY not set — uploads will fail')
}
if (!SECRET) {
  console.warn('[worker] WORKER_SHARED_SECRET not set — anyone can hit this worker (dev only)')
}

const app = express()
app.use(express.json({ limit: '10mb' }))

app.get('/healthz', (_req, res) => res.json({ ok: true, ffmpeg: !!ffmpegPath }))

// Shared-secret middleware for every job route.
const requireSecret = (req, res, next) => {
  if (!SECRET) return next()
  const got = req.headers['x-worker-secret']
  if (got !== SECRET) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// ── Title overlay: SVG → PNG via sharp ────────────────────────────────────
// Replaces the broken whitespace-padding "centering" hack in the Vercel
// polish. SVG `text-anchor="middle"` is pixel-accurate per line, with no
// font-metric guesswork. Returns the rendered PNG buffer (binary).
const FONT_FILES = {
  'Montserrat ExtraBold': 'Montserrat-ExtraBold.ttf',
  'Poppins ExtraBold':    'Poppins-ExtraBold.ttf',
  'Inter ExtraBold':      'Inter-ExtraBold.ttf',
  'Bebas Neue':           'BebasNeue-Regular.ttf',
  'Anton':                'Anton-Regular.ttf',
  'Oswald':               'Oswald-Bold.ttf',
  'Roboto Black':         'Roboto-Black.ttf',
}
function fontFamily(label) {
  return label || 'Roboto Black'
}

// Greedy-wrap so titles fit within ~82% of 1080. Letter widths are
// approximated; the SVG renderer wraps the actual glyph metrics so this
// only needs to be a soft hint.
function wrapForSvg(text, fontSize) {
  const usableWidth = 1080 * 0.82
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

async function renderTitlePng({
  title,
  font = 'Poppins ExtraBold',
  size = 72,
  color = '#ffffff',
  bg_color = '#e0467a',
  bg_padding = 28,
  uppercase = false,
  max_width = 1080,
}) {
  const text = uppercase ? String(title).toUpperCase() : String(title)
  const lines = wrapForSvg(text, size)
  if (!lines.length) return null

  // Per-line line-height — slightly tighter than 1.0 for ExtraBold faces.
  const lineHeight = Math.round(size * 1.18)
  const totalTextHeight = lines.length * lineHeight
  const blockHeight = totalTextHeight + bg_padding * 2
  const blockWidth = max_width  // SVG is centered horizontally; we pad x in ffmpeg overlay

  // Build the SVG. Each <text> uses text-anchor="middle" so it's
  // perfectly centered within the canvas, which is exactly what was
  // missing from the drawtext path. <rect> draws the bg pill behind.
  // Local fonts fall through to system fallbacks if the named family
  // isn't installed (we bundle the TTFs at /usr/share/fonts in Docker
  // OR use a <style>@font-face base64 trick — see fontFaceCss below).
  const fontFile = FONT_FILES[fontFamily(font)] || FONT_FILES['Roboto Black']
  const fontFaceCss = await loadFontFaceBase64(fontFile)

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${blockWidth}" height="${blockHeight}">
    <style>${fontFaceCss}
      .t { font-family: 'TitleFont'; font-size: ${size}px; font-weight: 800; fill: ${color}; }
    </style>
    <rect x="0" y="0" width="${blockWidth}" height="${blockHeight}" rx="${Math.round(bg_padding * 0.4)}" ry="${Math.round(bg_padding * 0.4)}" fill="${bg_color}" />
    ${lines.map((l, i) => {
      const y = bg_padding + (i + 1) * lineHeight - Math.round(size * 0.2)
      return `<text class="t" x="${blockWidth / 2}" y="${y}" text-anchor="middle" dominant-baseline="alphabetic">${escapeXml(l)}</text>`
    }).join('\n    ')}
  </svg>`

  // sharp renders the SVG, including @font-face. Density bumps the raster
  // resolution so the rounded edges aren't blurry on 1080p video.
  const png = await sharp(Buffer.from(svg), { density: 144 })
    .png({ compressionLevel: 6 })
    .toBuffer()
  return png
}

// Slurp a TTF, base64-embed as @font-face so SVG renders with the
// designed glyph widths (and centering per text-anchor="middle"
// becomes perfectly accurate). One small fetch per cold start, cached
// in module memory.
const _fontCache = new Map()
async function loadFontFaceBase64(filename) {
  if (_fontCache.has(filename)) return _fontCache.get(filename)
  // Fonts are bundled under worker/fonts/ at deploy time. Fall back to
  // an empty CSS string if the file is missing — sharp will substitute
  // a default sans-serif, still pixel-accurate for centering, just less
  // brand-y.
  const path = join(__dirname, 'fonts', filename)
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

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

app.post('/jobs/title-png', requireSecret, async (req, res) => {
  try {
    const png = await renderTitlePng(req.body || {})
    if (!png) return res.status(400).json({ error: 'title required' })
    res.set('Content-Type', 'image/png').send(png)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Polish job ────────────────────────────────────────────────────────────
function runFFmpeg(args, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); if (stderr.length > 200_000) stderr = stderr.slice(-100_000) })
    proc.stdout.on('data', () => {})
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')) }, timeoutMs)
    proc.on('error', (e) => { clearTimeout(timer); reject(e) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stderr)
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.split('\n').slice(-12).join('\n')}`))
    })
  })
}

async function fetchToBuffer(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`fetch ${r.status} for ${url.slice(0, 80)}`)
  return Buffer.from(await r.arrayBuffer())
}

function overlayPos(pos) {
  switch ((pos || 'br').toLowerCase()) {
    case 'tl': return { x: '24', y: '24' }
    case 'tr': return { x: 'main_w-overlay_w-24', y: '24' }
    case 'bl': return { x: '24', y: 'main_h-overlay_h-24' }
    case 'br': default: return { x: 'main_w-overlay_w-24', y: 'main_h-overlay_h-24' }
  }
}

app.post('/jobs/polish', requireSecret, async (req, res) => {
  const {
    profile_id, video_url,
    logo_url, watermark_image_url, music_url, title,
    title_style = {},
    watermark_position = 'br',
    watermark_size_pct = 25,
    music_volume = 0.15,
    music_fade_secs = 1.5,
  } = req.body || {}
  if (!profile_id || !video_url) return res.status(400).json({ error: 'profile_id + video_url required' })
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Storage not configured on worker' })

  let workdir = null
  try {
    workdir = await mkdtemp(join(tmpdir(), 'polish-'))
    const inPath  = join(workdir, 'in.mp4')
    const outPath = join(workdir, 'out.mp4')
    await writeFile(inPath, await fetchToBuffer(video_url))

    let titlePngPath = null
    if (title) {
      const png = await renderTitlePng({
        title,
        font: title_style.font,
        size: title_style.size,
        color: title_style.color,
        bg_color: title_style.bg_color,
        bg_padding: title_style.bg_padding,
        uppercase: title_style.uppercase,
      })
      if (png) {
        titlePngPath = join(workdir, 'title.png')
        await writeFile(titlePngPath, png)
      }
    }

    let logoPath = null
    const effectiveLogoUrl = logo_url || watermark_image_url
    if (effectiveLogoUrl && watermark_position !== 'none') {
      try {
        logoPath = join(workdir, 'logo.png')
        await writeFile(logoPath, await fetchToBuffer(effectiveLogoUrl))
      } catch { logoPath = null }
    }

    let musicPath = null
    if (music_url) {
      try {
        musicPath = join(workdir, 'music.mp3')
        await writeFile(musicPath, await fetchToBuffer(music_url))
      } catch { musicPath = null }
    }

    const args = ['-y', '-i', inPath]
    let nextIdx = 1
    let titleIdx = -1, logoIdx = -1, musicIdx = -1
    if (titlePngPath) { args.push('-i', titlePngPath); titleIdx = nextIdx++ }
    if (logoPath)     { args.push('-i', logoPath);     logoIdx  = nextIdx++ }
    if (musicPath)    { args.push('-i', musicPath);    musicIdx = nextIdx++ }

    const filters = []
    let vLabel = '[0:v]'
    if (titleIdx !== -1) {
      // SVG is rendered at video width already. Position by y_pos pct.
      const yPct = Math.max(0, Math.min(95, Number(title_style.y_pos ?? 15))) / 100
      filters.push(`[${titleIdx}:v]format=rgba[tov]`)
      filters.push(`${vLabel}[tov]overlay=(W-w)/2:H*${yPct}-h/2[vt]`)
      vLabel = '[vt]'
    }
    if (logoPath) {
      const sizeFrac = Math.max(0.04, Math.min(0.4, Number(watermark_size_pct) / 100))
      filters.push(`[${logoIdx}:v]${vLabel}scale2ref=w=main_w*${sizeFrac.toFixed(3)}:h=ow/mdar[lg][refv]`)
      const { x, y } = overlayPos(watermark_position)
      filters.push(`[refv][lg]overlay=${x}:${y}[vw]`)
      vLabel = '[vw]'
    }
    let aLabel = '[0:a]'
    if (musicPath) {
      const vol = Math.max(0, Math.min(1, Number(music_volume)))
      filters.push(`[${musicIdx}:a]volume=${vol},apad[mus]`)
      filters.push(`${aLabel}[mus]amix=inputs=2:duration=first:dropout_transition=0[aout]`)
      aLabel = '[aout]'
    }
    if (vLabel === '[0:v]') { filters.push(`[0:v]null[vfin]`); vLabel = '[vfin]' }
    if (aLabel === '[0:a]') { filters.push(`[0:a]anull[afin]`); aLabel = '[afin]' }

    args.push('-filter_complex', filters.join(';'))
    args.push('-map', vLabel, '-map', aLabel)
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '24')
    args.push('-c:a', 'aac', '-b:a', '128k')
    args.push('-movflags', '+faststart', outPath)

    await runFFmpeg(args)
    const finalBuf = await readFile(outPath)

    // Upload back to Supabase storage. Vercel side passed the same
    // bucket name, so the URL shape stays compatible with the rest of
    // the app (no migration of media_urls).
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const path = `${profile_id}/spaces/polished/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
    const { error: upErr } = await supabase.storage.from('landing-media').upload(path, finalBuf, {
      contentType: 'video/mp4', upsert: false,
    })
    if (upErr) throw new Error(`Upload failed: ${upErr.message}`)
    const { data: pub } = supabase.storage.from('landing-media').getPublicUrl(path)

    res.json({ video_url: pub.publicUrl, bytes: finalBuf.byteLength })
  } catch (err) {
    console.error('polish job error:', err?.stack || err)
    res.status(500).json({ error: String(err?.message || err) })
  } finally {
    if (workdir) { try { await rm(workdir, { recursive: true, force: true }) } catch {} }
  }
})

app.listen(PORT, () => console.log(`[worker] listening on :${PORT}`))
