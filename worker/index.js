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
import { Resvg } from '@resvg/resvg-js'
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
const FONTS_DIR = join(__dirname, 'fonts')
// Filename mapping from dropdown labels in the UI to the bundled TTF in
// worker/fonts/. The "family" string MUST match the font's embedded name
// table — that's what resvg uses to pick the glyph table at render time.
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
function fontConfig(label) { return FONT_FILES[label] || FALLBACK }

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

  const cfg = fontConfig(font)
  const lineHeight = Math.round(size * 1.18)
  const totalTextHeight = lines.length * lineHeight
  const blockHeight = totalTextHeight + bg_padding * 2
  const blockWidth  = max_width

  const fontOpts = {
    fontFiles: Object.values(FONT_FILES).map((f) => join(FONTS_DIR, f.file))
      .concat(join(FONTS_DIR, FALLBACK.file)),
    defaultFontFamily: cfg.family,
    loadSystemFonts: false,
  }

  // Probe render to measure actual text width — bg pill hugs the text
  // instead of stretching across the full canvas.
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
// Probe duration via no-op ffmpeg + stderr parse. Same pattern as the
// Vercel polish.js. Used to position afade out at the right moment
// from the music track's perspective.
function probeDurationSecs(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-i', filePath, '-hide_banner', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    proc.stderr.on('data', (d) => { err += d.toString('utf8') })
    proc.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i)
      if (!m) return reject(new Error('Could not parse duration'))
      resolve(+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]))
    })
    proc.on('error', reject)
  })
}

// Probe rotation metadata. iPhone (and many Android) cameras record
// "portrait" footage as landscape pixels with a rotation flag set on
// the video stream. Players honor that flag transparently — but as
// soon as ffmpeg sees `-filter_complex` it DISABLES auto-rotation
// and feeds raw frames to filters. Without the workaround, an iPhone
// vertical recording comes out of our composite sideways even though
// every preview thumbnail looked correct.
//
// `-frames:v 0` makes ffmpeg parse stream metadata then exit instantly,
// so this probe is ~100ms regardless of clip length.
async function probeRotation(filePath) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, [
      '-i', filePath, '-hide_banner', '-frames:v', '0', '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    proc.stderr.on('data', (d) => { err += d.toString('utf8') })
    proc.on('close', () => {
      // ffmpeg surfaces rotation in two forms depending on container:
      //   "Side data: displaymatrix: rotation of -90.00 degrees"  (mp4/mov)
      //   "rotate          : 90"                                  (older metadata tag)
      let rotation = 0
      const m1 = err.match(/rotation of (-?\d+(?:\.\d+)?) degrees?/i)
      const m2 = err.match(/^\s*rotate\s*:\s*(-?\d+)/im)
      if (m1) rotation = parseFloat(m1[1])
      else if (m2) rotation = parseInt(m2[1], 10)
      // Normalize to [0, 360). -90 = 270, etc.
      resolve(((rotation % 360) + 360) % 360)
    })
    proc.on('error', () => resolve(0))
  })
}

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
    music_fade_secs = 1.0,
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

    // -threads 2 caps decode parallelism. HEVC's reference-frame
    // buffers are per-thread, so unlimited-threads × 1080p HEVC
    // easily eats 4+ GB of RAM. Two threads is the sweet spot on a
    // shared-cpu-2x box: still parallel enough to stay fast, low
    // enough to fit in 4 GB even on a high-bitrate iPhone capture.
    const args = ['-y', '-threads', '2', '-i', inPath]
    let nextIdx = 1
    let titleIdx = -1, logoIdx = -1, musicIdx = -1
    if (titlePngPath) { args.push('-i', titlePngPath); titleIdx = nextIdx++ }
    if (logoPath)     { args.push('-i', logoPath);     logoIdx  = nextIdx++ }
    if (musicPath)    { args.push('-i', musicPath);    musicIdx = nextIdx++ }

    const filters = []
    let vLabel = '[0:v]'

    // Bake rotation metadata into the pixels BEFORE any overlay
    // filtering. We probe the input once and prepend a transpose
    // step when needed. After this, vLabel points to a stream that
    // already has the correct pixel dimensions (portrait if the
    // source was a rotated landscape phone capture).
    //   90  = recorded landscape, displayed CW  → transpose=1 (CW)
    //   270 = recorded landscape, displayed CCW → transpose=2 (CCW)
    //   180 = upside down                       → transpose=1,transpose=1
    //   0   = native, no transform
    const rotation = await probeRotation(inPath).catch(() => 0)
    if (rotation === 90 || rotation === 270 || rotation === 180) {
      const step = rotation === 90 ? 'transpose=1'
        : rotation === 270 ? 'transpose=2'
        : 'transpose=1,transpose=1'
      filters.push(`${vLabel}${step}[vrot]`)
      vLabel = '[vrot]'
    }

    // Cap output resolution at 1080x1920. iPhone 4K HEVC clips
    // (~150-200 MB for 30s) decode 4x more data per frame than
    // 1080p, blowing past 5 min on shared-cpu-2x and triggering
    // Vercel's 504 gateway timeout. We don't need >1080p for
    // social clips anyway — TikTok/Instagram downscale to 1080p
    // before serving. `force_original_aspect_ratio=decrease` only
    // downscales (never upscales), so 1080p sources pass through
    // unchanged with zero overhead.
    filters.push(`${vLabel}scale='min(1080,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease[vscaled]`)
    vLabel = '[vscaled]'

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
      const fadeSecs = Math.max(0, Math.min(10, Number(music_fade_secs ?? 1.0)))
      let videoDur = 0
      try { videoDur = await probeDurationSecs(inPath) } catch { videoDur = 0 }
      const audioChain = [`volume=${vol}`]
      if (videoDur > 0) {
        audioChain.push(`aloop=loop=-1:size=2e+09`)
        audioChain.push(`atrim=duration=${videoDur.toFixed(3)}`)
      } else {
        audioChain.push(`apad`)
      }
      if (videoDur > 0 && fadeSecs > 0 && videoDur > fadeSecs) {
        audioChain.push(`afade=t=out:st=${(videoDur - fadeSecs).toFixed(3)}:d=${fadeSecs.toFixed(3)}`)
      }
      filters.push(`[${musicIdx}:a]${audioChain.join(',')}[mus]`)
      filters.push(`${aLabel}[mus]amix=inputs=2:duration=first:dropout_transition=0[aout]`)
      aLabel = '[aout]'
    }
    if (vLabel === '[0:v]') { filters.push(`[0:v]null[vfin]`); vLabel = '[vfin]' }
    if (aLabel === '[0:a]') { filters.push(`[0:a]anull[afin]`); aLabel = '[afin]' }

    args.push('-filter_complex', filters.join(';'))
    args.push('-map', vLabel, '-map', aLabel)
    // `veryfast` encodes ~30% faster than `fast` with negligible
    // visible quality loss for short social clips. Combined with
    // the 1080p cap above, a 4K HEVC iPhone source now polishes
    // in ~60-90s on shared-cpu-2x (was ~5+ min before, hitting
    // Vercel's 504). -tune fastdecode hints x264 to skip the
    // costliest decoding paths in the output — irrelevant to the
    // viewer, useful for downstream tools (ZapCap especially).
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'fastdecode', '-crf', '24')
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
