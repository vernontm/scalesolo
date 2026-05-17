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
import { zapcapAddVideoByUrl, zapcapCreateTask, zapcapPollTask } from './zapcap.js'
import { runWorkflow } from './workflow-runner.js'

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

// Startup tmpdir sweep. Crashed jobs (OOM, fly machine kill, SIGKILL on
// suspend) leave behind workdirs that never hit the `finally rm`. On a
// machine that's been alive for many runs, those add up to GBs of /tmp
// — and we just hit ENOSPC on a multi-polish run because of it. Sweep
// any of our own well-known prefixes at boot.
;(async () => {
  try {
    const { readdir, rm: rmAsync } = await import('node:fs/promises')
    const tmp = tmpdir()
    const entries = await readdir(tmp).catch(() => [])
    const prefixes = ['polish-', 'av-', 'audio-', 'norm-']
    let cleaned = 0
    for (const name of entries) {
      if (!prefixes.some((p) => name.startsWith(p))) continue
      try {
        await rmAsync(join(tmp, name), { recursive: true, force: true })
        cleaned++
      } catch {}
    }
    if (cleaned) console.log(`[worker] startup tmp sweep: removed ${cleaned} leftover workdir(s)`)
  } catch (e) {
    console.warn('[worker] startup tmp sweep failed:', e?.message)
  }
})()

const app = express()
app.use(express.json({ limit: '10mb' }))

app.get('/healthz', (_req, res) => res.json({ ok: true, ffmpeg: !!ffmpegPath }))

// Dedicated keepalive endpoint distinct from /healthz so Fly's idle
// detector doesn't filter our pings as "system health-check traffic."
// Hit by the worker's own setInterval (see startKeepAlive below)
// during any active job to keep Fly from auto-suspending mid-encode.
app.get('/__keepalive', (_req, res) => res.json({ ok: true, machine: process.env.FLY_MACHINE_ID || null, active_jobs: activeJobs }))

// ── Keep-alive against Fly auto-suspend ────────────────────────────────
// Fly's auto-suspend only counts INBOUND HTTP. Long-running background
// jobs (run-workflow, polish-async) don't generate inbound traffic
// while they grind, so Fly was suspending machines mid-ffmpeg, killing
// the encode and freezing the workflow forever.
//
// Fix: while any background job is active, self-ping our own public
// /healthz every 30s. The ping leaves the machine, hits Fly's proxy
// edge, returns to the machine — Fly counts that as inbound traffic
// and resets the suspend timer. Idle-cost stays at $0 (suspend on no
// jobs), but active jobs are never interrupted.
let activeJobs = 0
let keepAliveTimer = null
const WORKER_PUBLIC_URL = process.env.WORKER_PUBLIC_URL
  || (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : null)

function startKeepAlive() {
  if (keepAliveTimer) return
  if (!WORKER_PUBLIC_URL) {
    console.warn('[keepalive] no public URL configured (set FLY_APP_NAME or WORKER_PUBLIC_URL); auto-suspend may interrupt long jobs')
    return
  }
  // fly-prefer-instance: pins the keepalive ping to THIS specific
  // machine via Fly's proxy. Without this, if Fly autoscaled a second
  // machine to handle burst (or just for load-balancing), our pings
  // would round-robin between machines and the one actually doing
  // ffmpeg work would miss enough of them to get suspended mid-encode.
  // We saw exactly this on a 17-video run that died at 06:43:21.
  //
  // Also use a dedicated /__keepalive endpoint instead of /healthz —
  // Fly might exclude its own health-check path from the idle detector.
  // Safer to use a distinct URL that's clearly user traffic.
  const machineId = process.env.FLY_MACHINE_ID || process.env.FLY_ALLOC_ID || null
  console.log(`[keepalive] starting (pinging ${WORKER_PUBLIC_URL}/__keepalive every 30s${machineId ? `, pinned to ${machineId}` : ''})`)
  keepAliveTimer = setInterval(async () => {
    try {
      const t0 = Date.now()
      const headers = machineId ? { 'fly-prefer-instance': machineId } : {}
      const r = await fetch(`${WORKER_PUBLIC_URL}/__keepalive`, { method: 'GET', headers })
      const ms = Date.now() - t0
      if (!r.ok) console.warn(`[keepalive] ping returned ${r.status} after ${ms}ms`)
    } catch (e) {
      console.warn('[keepalive] ping failed:', e?.message)
    }
  }, 30_000)
}

function stopKeepAlive() {
  if (!keepAliveTimer) return
  clearInterval(keepAliveTimer)
  keepAliveTimer = null
  console.log('[keepalive] stopped (no active jobs)')
}

// Increment / decrement active job count and toggle the keep-alive.
// Pair every jobStart() with a jobEnd() (in a finally block) so the
// counter never drifts on errors.
function jobStart() {
  activeJobs += 1
  if (activeJobs === 1) startKeepAlive()
}
function jobEnd() {
  activeJobs = Math.max(0, activeJobs - 1)
  if (activeJobs === 0) stopKeepAlive()
}

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

// Measure a single line's rendered width via a one-line probe SVG.
// Used by per-line pill mode so each chip hugs only its own line text.
function measureLineWidth(line, { fontOpts, family, weight, size, blockWidth }) {
  try {
    const probe = `<svg xmlns="http://www.w3.org/2000/svg" width="${blockWidth}" height="${Math.round(size * 1.6)}"><text x="${blockWidth / 2}" y="${size}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="#000" text-anchor="middle" dominant-baseline="alphabetic">${escapeXml(line)}</text></svg>`
    const bb = new Resvg(Buffer.from(probe), { font: fontOpts, background: 'rgba(0,0,0,0)' }).getBBox()
    if (bb && bb.width) return bb.width
  } catch {}
  return Math.min(blockWidth, line.length * size * 0.58)
}

async function renderTitlePng({
  title,
  font = 'Poppins ExtraBold',
  size = 72,
  color = '#ffffff',
  bg_color = '#e0467a',
  bg_padding = 28,
  bg_mode = 'block',         // 'block' (legacy) | 'per_line' (TikTok pills)
  bg_line_gap = 8,
  uppercase = false,
  max_width = 1080,
}) {
  const text = uppercase ? String(title).toUpperCase() : String(title)
  const lines = wrapForSvg(text, size)
  if (!lines.length) return null

  const cfg = fontConfig(font)
  const lineHeight = Math.round(size * 1.18)
  const blockWidth  = max_width

  const fontOpts = {
    fontFiles: Object.values(FONT_FILES).map((f) => join(FONTS_DIR, f.file))
      .concat(join(FONTS_DIR, FALLBACK.file)),
    defaultFontFamily: cfg.family,
    loadSystemFonts: false,
  }

  // Per-line pill mode: each line gets its own rounded chip hugging the
  // line's text width. Pills stack vertically with bg_line_gap between.
  if (bg_mode === 'per_line') {
    const pillVPad = Math.round(bg_padding * 0.45)
    const pillHPad = Math.round(bg_padding * 0.75)
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

  // Block mode (default): one rounded rect around all lines.
  const totalTextHeight = lines.length * lineHeight
  const blockHeight = totalTextHeight + bg_padding * 2

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
    // -noautorotate keeps ffmpeg from silently consuming the rotation
    // metadata before we get to read it. Without this, modern ffmpeg
    // auto-applies the rotation AND suppresses the displaymatrix line
    // in stderr — our regex gets 0 and the polish step skips transpose
    // even though the source needs one. iPhone HEVC .mov clips hit this
    // consistently.
    const proc = spawn(ffmpegPath, [
      '-noautorotate', '-i', filePath, '-hide_banner', '-frames:v', '0', '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    proc.stderr.on('data', (d) => { err += d.toString('utf8') })
    proc.on('close', () => {
      // ffmpeg surfaces rotation in several forms depending on container
      // and ffmpeg version. We try each pattern in order and use the
      // first hit:
      //   1. "displaymatrix: rotation of -90.00 degrees"  (mp4/mov, modern)
      //   2. "rotation of -90.00 degrees"                 (older mp4)
      //   3. "rotate          : 90"                       (metadata tag)
      //   4. "TAG:rotate=90"                              (-show_format style)
      //   5. "Side data:" followed by a matrix block      (HEVC HDR captures)
      let rotation = 0
      const patterns = [
        /displaymatrix:\s*rotation of (-?\d+(?:\.\d+)?)\s*degrees?/i,
        /rotation of (-?\d+(?:\.\d+)?)\s*degrees?/i,
        /^\s*rotate\s*:\s*(-?\d+)/im,
        /TAG:rotate\s*=\s*(-?\d+)/i,
      ]
      for (const re of patterns) {
        const m = err.match(re)
        if (m) { rotation = parseFloat(m[1]); break }
      }
      // Normalize to [0, 360). -90 = 270, etc.
      resolve(((rotation % 360) + 360) % 360)
    })
    proc.on('error', () => resolve(0))
  })
}

// ── Video probe ────────────────────────────────────────────────────────
// Returns { codec, width, height, fps, is_hdr, rotation, audio_codec, has_audio }
// by parsing ffmpeg -i's stderr (cheap, ~100ms regardless of clip length —
// ffmpeg parses container metadata then exits because we asked for 0 frames).
// We don't ship ffprobe (the @ffmpeg-installer package only includes the
// ffmpeg binary), so this stderr-parse approach is the path of least
// dependency.
async function probeVideo(filePath) {
  return new Promise((resolve) => {
    // -noautorotate so the rotation metadata shows in stderr (see
    // probeRotation note above — same reason).
    const proc = spawn(ffmpegPath, [
      '-noautorotate', '-i', filePath, '-hide_banner', '-frames:v', '0', '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    proc.stderr.on('data', (d) => { err += d.toString('utf8') })
    proc.on('close', () => {
      // Video stream line: "Stream #0:0(und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160 [SAR 1:1 DAR 16:9], 64210 kb/s, 60 fps, 60 tbr, ..."
      const vLine = (err.match(/^\s*Stream #\d+:\d+.*?: Video:.*$/m) || [''])[0]
      const codecMatch = vLine.match(/Video:\s+([a-z0-9_]+)/i)
      const sizeMatch  = vLine.match(/,\s*(\d{2,5})x(\d{2,5})/)
      const fpsMatch   = vLine.match(/,\s*([\d.]+)\s*fps/)
      const pixFmt     = (vLine.match(/Video:\s+\S+\s*(?:\([^)]+\)\s*)*(?:\(\w+\s*\/\s*0x[0-9a-f]+\),)?\s*([a-z0-9_]+)/i) || [])[1] || ''
      // HDR markers: bt2020 colorspace, smpte2084 (HDR10 PQ), arib-std-b67 (HLG), 10-bit pixel formats with HDR primaries.
      const isHdr = /bt2020|smpte2084|smpte-2084|arib-std-b67|hlg/i.test(vLine) || /yuv4\d\dp1[02]le/i.test(pixFmt)

      // Rotation (same expanded pattern set as probeRotation)
      let rotation = 0
      const rotPatterns = [
        /displaymatrix:\s*rotation of (-?\d+(?:\.\d+)?)\s*degrees?/i,
        /rotation of (-?\d+(?:\.\d+)?)\s*degrees?/i,
        /^\s*rotate\s*:\s*(-?\d+)/im,
        /TAG:rotate\s*=\s*(-?\d+)/i,
      ]
      for (const re of rotPatterns) {
        const m = err.match(re)
        if (m) { rotation = parseFloat(m[1]); break }
      }
      rotation = ((rotation % 360) + 360) % 360

      // Audio stream line: "Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 256 kb/s"
      const aLine = (err.match(/^\s*Stream #\d+:\d+.*?: Audio:.*$/m) || [''])[0]
      const audioCodec = (aLine.match(/Audio:\s+([a-z0-9_]+)/i) || [])[1] || null

      resolve({
        codec: codecMatch ? codecMatch[1].toLowerCase() : null,
        width:  sizeMatch ? parseInt(sizeMatch[1], 10) : null,
        height: sizeMatch ? parseInt(sizeMatch[2], 10) : null,
        fps:    fpsMatch ? parseFloat(fpsMatch[1]) : null,
        is_hdr: !!isHdr,
        rotation,
        audio_codec: audioCodec,
        has_audio: !!aLine,
        pix_fmt: pixFmt || null,
      })
    })
    proc.on('error', () => resolve({ codec: null, width: null, height: null, fps: null, is_hdr: false, rotation: 0, audio_codec: null, has_audio: false, pix_fmt: null }))
  })
}

// Decide whether the source needs a normalize pass before polish (or any
// other downstream step). Returns a reason string when normalization is
// recommended, or null when the source is already canonical-enough.
//
// Triggers we care about:
//   • non-H.264 codec (HEVC, ProRes, VP9, AV1) — wider compat after normalize
//   • > 1080p resolution — wasted bytes for social, hurts encode speed
//   • > 30fps — overkill for social, doubles bitrate
//   • HDR — washed-out output without explicit tone-map
//   • > 80MB file — likely benefits from a CRF re-encode
//   • rotation metadata — bake it in to avoid downstream double-rotation
function needsNormalize(probe, sizeBytes) {
  if (!probe || !probe.codec) return 'unknown-codec'
  if (probe.codec !== 'h264')                  return `codec:${probe.codec}`
  if ((probe.width || 0) > 1920)               return `width:${probe.width}`
  if ((probe.height || 0) > 1920)              return `height:${probe.height}`  // catches vertical 4K
  if ((probe.fps || 0) > 31)                   return `fps:${probe.fps}`
  if (probe.is_hdr)                            return 'hdr'
  if (sizeBytes && sizeBytes > 80 * 1024 * 1024) return `size:${(sizeBytes / 1024 / 1024).toFixed(0)}MB`
  if (probe.rotation)                          return `rotation:${probe.rotation}`
  return null
}

// Build the ffmpeg filter chain that produces a canonical 1080p / 30fps /
// 8-bit yuv420p / H.264 output regardless of source weirdness. Applied
// inside normalizeFile (below) and reusable for one-off Compress UI button.
function buildNormalizeFilter(probe) {
  const filters = []
  // Honor source rotation by transposing pixels (we apply the INVERSE of
  // the displaymatrix transform — this matches ffmpeg's own autorotate
  // logic). Then drop the metadata tag so downstream readers don't apply
  // it a second time.
  //   rotation 90  → transpose=2 (CCW) — sensor recorded with +90 tag
  //   rotation 270 → transpose=1 (CW)  — typical iPhone vertical (-90 tag)
  //   rotation 180 → vflip,hflip
  if (probe.rotation === 90)  filters.push('transpose=2')
  if (probe.rotation === 270) filters.push('transpose=1')
  if (probe.rotation === 180) filters.push('vflip,hflip')

  // HDR (BT.2020 / PQ / HLG) → SDR (BT.709). Without this, HDR videos
  // come out washed-out gray on platforms that don't do tone-mapping.
  if (probe.is_hdr) {
    filters.push('zscale=t=linear:npl=100')
    filters.push('format=gbrpf32le')
    filters.push('zscale=p=bt709')
    filters.push('tonemap=tonemap=hable:desat=0')
    filters.push('zscale=t=bt709:m=bt709:r=tv')
  }

  // Cap longest edge at 1920 (handles both landscape 1920x1080 and
  // vertical 1080x1920 sources) without upscaling smaller sources.
  filters.push("scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))':flags=lanczos")

  // 30fps cap — drops slo-mo / 60fps overkill for social.
  filters.push('fps=30')

  // Always end with yuv420p for maximum decoder compatibility.
  filters.push('format=yuv420p')
  return filters.join(',')
}

// Normalize a video file in place: read from inPath, write a canonical
// MP4 to outPath. Used by both polishCore (auto-normalize on bad input)
// and normalizeVideoCore (explicit "Compress" button).
async function normalizeFile(inPath, outPath, probe, hasAudio) {
  const vf = buildNormalizeFilter(probe)
  // -noautorotate: probe already determined rotation; the filter chain
  // (transpose=N) bakes it in. Letting ffmpeg autorotate first would
  // double-apply and orient the output wrong.
  const args = ['-y', '-threads', '2', '-noautorotate', '-i', inPath, '-vf', vf]
  // H.264 high profile, CRF 23 (visually transparent for social), faststart
  // for streaming. -preset fast hits the sweet spot between CPU and bitrate.
  args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23')
  args.push('-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p')
  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2')
  } else {
    args.push('-an')
  }
  args.push('-movflags', '+faststart')
  // Strip the legacy rotation metadata tag — we already baked the rotation
  // into the pixel data via the transpose filter. The displaymatrix side
  // data is harder to clear portably (bitstream filters vary by ffmpeg
  // build); polishCore handles that case by short-circuiting the rotation
  // probe entirely when it knows we just normalized (didNormalize flag).
  args.push('-metadata:s:v:0', 'rotate=0')
  args.push(outPath)
  await runFFmpeg(args, 15 * 60_000)
}

// 20 min cap. Was 10 min, but long voiceover-driven polishes (script
// → voice_gen → -stream_loop video) routinely run 8-12 min on
// shared-cpu-2x when the voiceover is multi-minute, so 10 min was
// flaking on legitimate jobs. 20 min still kills truly stuck encodes
// without giving up on long-but-fine ones.
function runFFmpeg(args, timeoutMs = 1_200_000) {
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
    // Bottom-center, kept above the social-UI safe zone (TikTok / IG
    // Reels overlay their caption + handle / mute toggle in roughly
    // the bottom 16-20% of the frame). Anchoring the logo at 18% from
    // the bottom keeps it visible without being clipped by those UIs.
    case 'bc-safe': return { x: '(main_w-overlay_w)/2', y: 'main_h-overlay_h-(main_h*0.18)' }
    case 'br': default: return { x: 'main_w-overlay_w-24', y: 'main_h-overlay_h-24' }
  }
}

// In-memory job registry for the async path. Maps job_id → state.
// Acceptable because:
//   - Fly's auto_stop only kicks in when there are no in-flight
//     requests, so jobs never get killed mid-process.
//   - If the machine genuinely restarts mid-job (deploy / OOM /
//     crash), the client polling the status endpoint will see
//     "not found" and the canvas falls back to a fresh polish.
const jobs = new Map()

function newJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// Job processor — same body as the sync /jobs/polish handler, just
// extracted so both paths share the work and only differ in HTTP
// lifecycle. Updates the jobs map as it runs.
async function runPolishJob(jobId, body) {
  const job = jobs.get(jobId)
  if (!job) return
  // Mark this background job as active so the keep-alive ping fires
  // throughout the ffmpeg encode and Fly can't auto-suspend us.
  jobStart()
  job.status = 'running'
  job.started_at = new Date().toISOString()
  try {
    const result = await polishCore(body)
    job.status = 'done'
    job.result = result
    job.finished_at = new Date().toISOString()
  } catch (err) {
    job.status = 'failed'
    job.error = String(err?.message || err)
    job.finished_at = new Date().toISOString()
    console.error(`polish job ${jobId} failed:`, err?.stack || err)
  } finally {
    // Always decrement, even on error paths — otherwise activeJobs
    // would drift up and keep-alive would never stop.
    jobEnd()
  }
  // Reap after 10 min so the registry doesn't grow forever.
  setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000)
}

// Async submit: returns { job_id, status: 'queued' } immediately
// and processes in background. Caller polls GET /jobs/:id for status.
app.post('/jobs/polish-async', requireSecret, async (req, res) => {
  const body = req.body || {}
  if (!body.profile_id || !body.video_url) {
    return res.status(400).json({ error: 'profile_id + video_url required' })
  }
  const jobId = newJobId()
  jobs.set(jobId, { status: 'queued', queued_at: new Date().toISOString() })
  // Kick off in background — DO NOT await.
  runPolishJob(jobId, body).catch((e) => console.error(`runPolishJob ${jobId} threw:`, e))
  return res.status(202).json({ job_id: jobId, status: 'queued' })
})

// ── Workflow runner job (server-side auto-run) ───────────────────────────
// Called by Vercel cron every minute for each due scheduled_workflows
// row. Body shape (from /api/cron/run-scheduled-workflows):
//   { schedule_id, user_id, profile_id, space_id, trigger_node_id,
//     graph: { nodes, edges }, internal_secret }
//
// Returns 202 immediately and processes in background — the cron has
// already bumped runs_used + advanced next_fire_at, so an error here
// gets reported via the schedule row's last_error on a subsequent
// call from this worker back to Supabase.
app.post('/jobs/run-workflow', requireSecret, async (req, res) => {
  const body = req.body || {}
  const { schedule_id, user_id, profile_id, graph, internal_secret } = body
  // Manual one-shot dispatches (from /api/spaces/run-now) don't have a
  // schedule_id — they're not cron ticks. Everything else still needs
  // to identify the caller + target + auth secret.
  if (!user_id || !profile_id || !graph || !internal_secret) {
    return res.status(400).json({ error: 'user_id, profile_id, graph, internal_secret required' })
  }
  const triggeredBy = body.triggered_by === 'manual_server' ? 'manual_server' : 'server_cron'
  const jobLabel = schedule_id || `manual-${Date.now().toString(36)}`
  res.status(202).json({ accepted: true, schedule_id: schedule_id || null, job_id: jobLabel })

  // Background execution. Errors get reported back via Supabase
  // direct (service-role) so the schedule row's last_error reflects
  // the actual failure even when the cron is long gone.
  ;(async () => {
    // Mark this background workflow as active so the keep-alive ping
    // fires throughout the entire run and Fly can't suspend us mid-
    // execution. jobEnd() is in the finally block below so a thrown
    // exception still decrements the counter cleanly.
    jobStart()
    const startedAt = Date.now()
    let supabase = null
    if (SUPABASE_URL && SERVICE_KEY) {
      supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    }

    // Bell notification at start so the user knows the cron picked up
    // their workflow even before any individual node fires. We insert
    // directly into notifications (same shape api/_lib/notify.js
    // writes) via service-role so Realtime fans it out to the SPA
    // immediately. Failures are non-fatal — notifications are
    // best-effort signaling.
    const notify = async (row) => {
      if (!supabase) return
      try {
        await supabase.from('notifications').insert([{
          user_id, profile_id,
          kind: row.kind, level: row.level,
          title: String(row.title || '').slice(0, 200),
          body: row.body ? String(row.body).slice(0, 2000) : null,
          href: row.href || null,
          meta: row.meta || null,
        }])
      } catch (e) {
        console.warn(`[wf ${jobLabel}] notify failed:`, e?.message)
      }
    }

    const isManual = triggeredBy === 'manual_server'
    await notify({
      kind: 'workflow.started',
      level: 'info',
      title: isManual ? 'Run started on server' : 'Auto-run started',
      body: isManual
        ? 'You can close the tab; the workflow continues running.'
        : 'Your scheduled workflow is running on the server.',
      href: `/spaces?id=${body.space_id || ''}`,
      meta: { schedule_id: schedule_id || null, space_id: body.space_id, triggered_by: triggeredBy },
    })

    // Record a space_runs row so the server run shows up in the
    // canvas Run history alongside browser-side runs. Without this
    // the user only sees zombie / failed browser rows in history
    // and has no idea their server runs are succeeding. We insert
    // status='running' first, then patch with the final status +
    // duration when runWorkflow returns. Failures are non-fatal —
    // history is best-effort.
    let spaceRunId = null
    if (supabase) {
      try {
        const inserted = await supabase.from('space_runs').insert([{
          space_id: body.space_id,
          profile_id,
          triggered_by: triggeredBy,
          status: 'running',
          node_count: Array.isArray(graph?.nodes) ? graph.nodes.length : 0,
          started_at: new Date().toISOString(),
        }]).select('id').single()
        spaceRunId = inserted?.data?.id || null
      } catch (e) {
        console.warn(`[wf ${jobLabel}] space_runs insert failed:`, e?.message)
      }
    }

    // Per-node progress map. Worker writes this back to space_runs
    // after every node start / finish so the canvas can highlight live.
    // We accumulate locally + patch the whole jsonb on each step
    // because Postgres jsonb_set via PostgREST is awkward, and total
    // graph size is small (rarely > 20 nodes). One write per step ≈ 2
    // round-trips per node — well within Realtime's budget.
    const nodeProgress = {}
    const writeProgress = async (nodeId, patch) => {
      const prev = nodeProgress[nodeId] || {}
      nodeProgress[nodeId] = { ...prev, ...patch }
      if (!supabase || !spaceRunId) return
      try {
        await supabase.from('space_runs')
          .update({ node_progress: nodeProgress })
          .eq('id', spaceRunId)
      } catch (e) {
        // Don't let a progress hiccup kill the run. We re-write on
        // the next step anyway so a single dropped update self-heals.
        console.warn(`[wf ${jobLabel}] node_progress write failed:`, e?.message)
      }
    }

    // shouldAbort: short-circuits the workflow at the next node boundary
    // when /api/spaces/cancel-run flipped space_runs.status to 'cancelled'.
    // Caches the answer for 2s so we don't hammer the DB on graphs with
    // many fast nodes — 2s is plenty fast for user perception of a Stop
    // click landing.
    let abortCache = { at: 0, value: false }
    const shouldAbort = async () => {
      if (!supabase || !spaceRunId) return false
      const now = Date.now()
      if (now - abortCache.at < 2_000) return abortCache.value
      try {
        const { data } = await supabase.from('space_runs')
          .select('status').eq('id', spaceRunId).single()
        const v = data?.status === 'cancelled'
        abortCache = { at: now, value: v }
        return v
      } catch (e) {
        // Failing closed (don't abort) keeps a transient DB hiccup from
        // killing a legitimate run. We re-check at the next node.
        return false
      }
    }

    try {
      const result = await runWorkflow({
        graph, userId: user_id, profileId: profile_id, internalSecret: internal_secret,
        log: (m) => console.log(`[wf ${jobLabel}] ${m}`),
        onProgress: writeProgress,
        shouldAbort,
        // In-process worker helpers. workflow-runner uses these directly
        // when present instead of calling back through Vercel /api/videos/*
        // endpoints (worker → Vercel → worker round-trip was the source of
        // FUNCTION_INVOCATION_FAILED on parallel polish fan-out). Passing
        // them by reference avoids circular imports — workflow-runner is
        // imported by this file, can't import from it.
        localFns: {
          polishCore,
          combineAvCore,
          extractAudioCore,
          normalizeVideoCore,
        },
        // run_only_target_id: when set, the worker re-runs ONLY that
        // node and uses every other node's cached data.output as input.
        // Set by Spaces.jsx when the user clicks per-node Run on a
        // multi-clip workflow — without this, the browser would
        // orchestrate polish and hit the FUNCTION_INVOCATION_FAILED /
        // ENOSPC pile-up we saw on Mind Rescue's 5-clip retry.
        runOnlyTargetId: body.run_only_target_id || null,
        // rerun_from_node_id: re-run this node AND every descendant
        // (use cached for ancestors). The browser sends this for
        // per-node Run on multi-clip workflows so polish + schedule_post
        // both re-run when polish is targeted, instead of schedule_post
        // staying on a stale cached single-post output.
        rerunFromNodeId: body.rerun_from_node_id || null,
      })
      const errCount = Object.keys(result.errors).length
      console.log(`[wf ${jobLabel}] done ok=${result.ok} errors=${errCount} duration_ms=${Date.now() - startedAt}`)

      // Finalize the space_runs row with completion state. status
      // mirrors how the browser-side runs label themselves:
      //   - 'success' if no errors
      //   - 'partial' if some nodes errored but the run reached the end
      //   - 'failed' is reserved for the run threw before completing
      //     any node, which can't really happen here (we caught it
      //     inside runWorkflow), so partial/success cover everything.
      if (supabase && spaceRunId) {
        const errorsArr = Object.entries(result.errors).map(([nodeId, msg]) => ({ nodeId, msg }))
        await supabase.from('space_runs').update({
          status: result.ok ? 'success' : 'partial',
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          errors: errorsArr,
        }).eq('id', spaceRunId).then(() => {}, (e) => console.warn(`[wf ${jobLabel}] space_runs finish update failed:`, e?.message))
      }

      // Merge each completed node's output back into spaces.nodes so a
      // refresh re-hydrates the canvas with the generated assets
      // (avatar videos, stitched videos, polished videos, etc.). Without
      // this, server-side runs end up "invisible" on the canvas — only
      // space_runs.node_progress holds the outputs, and that's a transient
      // Realtime source not consulted by GET /api/spaces. Mirrors what
      // the client-side run path implicitly does via autosave.
      if (supabase && body.space_id) {
        try {
          const { data: spaceRow } = await supabase
            .from('spaces')
            .select('nodes')
            .eq('id', body.space_id)
            .single()
          if (spaceRow?.nodes && Array.isArray(spaceRow.nodes)) {
            const nextNodes = spaceRow.nodes.map((n) => {
              const np = nodeProgress[n?.id]
              if (!np) return n
              // Map worker statuses → canvas statuses. The "self_only"
              // run-from-node check requires data.status === 'done' on
              // every direct parent before it'll reuse cached output,
              // so we MUST write status here too. Without it, every
              // downstream Run prompts "X hasn't run yet" even though
              // outputs are present.
              const next = { ...n, data: { ...(n.data || {}) } }
              if (np.status === 'success') {
                next.data.status = 'done'
                next.data.error = null
                if (np.output) next.data.output = np.output
              } else if (np.status === 'failed') {
                next.data.status = 'failed'
                if (np.error) next.data.error = np.error
              } else if (np.status === 'running') {
                // Transient — leave the row alone; the next finalize
                // will flip it.
              }
              return next
            })
            await supabase
              .from('spaces')
              .update({ nodes: nextNodes, updated_at: new Date().toISOString() })
              .eq('id', body.space_id)
          }
        } catch (e) {
          console.warn(`[wf ${jobLabel}] merge node outputs to spaces failed:`, e?.message)
        }
      }

      // Only attribute the error back to a scheduled_workflows row
      // when this run was actually triggered by one. Manual one-shots
      // have no schedule to update.
      if (supabase && !result.ok && schedule_id) {
        const summary = Object.entries(result.errors).map(([id, msg]) => `${id}: ${msg}`).join(' · ').slice(0, 500)
        await supabase.from('scheduled_workflows')
          .update({ last_error: summary, updated_at: new Date().toISOString() })
          .eq('id', schedule_id)
          .then(() => {}, (e) => console.warn('[wf] update last_error failed:', e?.message))
      }

      // Completion bell. Different shape for clean vs partial run so
      // the user can tell at a glance whether to dig in.
      if (result.ok) {
        await notify({
          kind: 'workflow.done',
          level: 'success',
          title: 'Auto-run finished',
          body: `Workflow completed with no errors (${(Date.now() - startedAt) / 1000 | 0}s).`,
          href: `/spaces?id=${body.space_id || ''}`,
          meta: { schedule_id, space_id: body.space_id, duration_ms: Date.now() - startedAt },
        })
      } else {
        const firstError = Object.values(result.errors)[0] || 'unknown'
        await notify({
          kind: 'workflow.failed',
          level: 'error',
          title: `Auto-run finished with ${errCount} error${errCount === 1 ? '' : 's'}`,
          body: String(firstError).slice(0, 200),
          href: `/spaces?id=${body.space_id || ''}`,
          meta: { schedule_id, space_id: body.space_id, errors: result.errors },
        })
      }
    } catch (err) {
      console.error(`[wf ${jobLabel}] threw:`, err?.stack || err)
      if (supabase && schedule_id) {
        await supabase.from('scheduled_workflows')
          .update({ last_error: String(err?.message || err).slice(0, 500), updated_at: new Date().toISOString() })
          .eq('id', schedule_id)
          .then(() => {}, () => {})
      }
      if (supabase) {
        // Mark space_runs row as failed too so the canvas history
        // doesn't leave it stuck on 'running' until the zombie sweeper
        // catches it 15 min later.
        if (spaceRunId) {
          await supabase.from('space_runs').update({
            status: 'failed',
            finished_at: new Date().toISOString(),
            duration_ms: Date.now() - startedAt,
            errors: [{ msg: String(err?.message || err).slice(0, 500) }],
          }).eq('id', spaceRunId).then(() => {}, () => {})
        }
      }
      await notify({
        kind: 'workflow.failed',
        level: 'error',
        title: 'Auto-run crashed',
        body: String(err?.message || err).slice(0, 200),
        href: `/spaces?id=${body.space_id || ''}`,
        meta: { schedule_id, space_id: body.space_id, error: String(err?.message || err) },
      })
    } finally {
      // Decrement keep-alive counter no matter how the run finished.
      // Pairs with the jobStart() at the top of the IIFE.
      jobEnd()
    }
  })().catch(() => {})
})

// Status endpoint. Returns the in-memory state of a job.
app.get('/jobs/:id', requireSecret, (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'Job not found (expired or never existed)' })
  return res.json({ job_id: req.params.id, ...job })
})

// Shared polish work. Both the sync /jobs/polish handler and the
// async background runner call this. Returns { video_url, bytes }
// on success, throws on failure (callers translate to HTTP / job
// state). Cleans up its own tempdir.
async function polishCore(body) {
  const {
    profile_id, video_url,
    logo_url, watermark_image_url, music_url, title,
    title_style = {},
    watermark_position = 'br',
    watermark_size_pct = 25,
    music_volume = 0.15,
    music_fade_secs = 1.0,
    // Voiceover narration — overlays as primary audio. When set:
    //   - mute_video_audio = drop the source camera audio
    //   - loop_video = -stream_loop on the video input so frames
    //     stretch to match a longer voiceover; -shortest on output
    //     trims at the voiceover's natural end
    voiceover_url,
    loop_video = false,
    mute_video_audio = false,
    // Cover-intro prepend. When `embed_cover_intro` is truthy AND a
    // `cover_image_url` is provided, polishCore prepends the cover
    // image as a static intro (default 0.5s) to the final polish
    // output via prependCoverCore. Single worker job — replaces the
    // old "run polish then call /jobs/prepend-cover separately"
    // dance. Caller stores the resulting URL on media_url_with_cover
    // so non-IG platforms (TikTok / YT / FB) see the cover as the
    // start-frame thumbnail.
    cover_image_url,
    embed_cover_intro = false,
    cover_intro_secs = 0.5,
    // Audio cleanup. Default-on. Applies a light highpass + EBU R128
    // loudness normalization to the source video's audio track before
    // mixing it with music / voiceover, so quiet phone recordings get
    // pulled up to a consistent broadcast-loud target instead of being
    // drowned out by the music bed. Skipped automatically when the
    // source audio is being fully replaced (mute_video_audio +
    // voiceover) since there's nothing to clean.
    audio_cleanup = true,
  } = body || {}
  if (!profile_id || !video_url) throw new Error('profile_id + video_url required')
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Storage not configured on worker')

  let workdir = null
  try {
    workdir = await mkdtemp(join(tmpdir(), 'polish-'))
    const inPath  = join(workdir, 'in.mp4')
    const outPath = join(workdir, 'out.mp4')
    const sourceBuf = await fetchToBuffer(video_url)
    await writeFile(inPath, sourceBuf)

    // ── Auto-normalize the source if it's "weird" ──────────────────────
    // Probes the file (codec / size / fps / HDR / rotation) and runs a
    // canonicalization pass to 1080p / 30fps / 8-bit H.264 / AAC MP4
    // when needed. Lets users upload anything (4K HEVC HDR iPhone .mov,
    // ProRes from a DSLR, 60fps slo-mo, sideways portrait) and have
    // polish "just work" on a known-good intermediate. Already-canonical
    // sources skip this step entirely.
    let polishInputPath = inPath
    let didNormalize = false  // when true, polish must NOT re-apply rotation
    const probe = await probeVideo(inPath)
    const normReason = needsNormalize(probe, sourceBuf.byteLength)
    if (normReason) {
      console.log(`[polish] normalizing source (${normReason})`)
      const normPath = join(workdir, 'normalized.mp4')
      try {
        await normalizeFile(inPath, normPath, probe, probe.has_audio)
        polishInputPath = normPath
        didNormalize = true
      } catch (e) {
        // Normalize is best-effort — if it fails we fall back to the raw
        // source and let polish try anyway. Logs surface the reason.
        console.warn(`[polish] normalize failed, using raw source: ${e?.message}`)
      }
    }

    let titlePngPath = null
    if (title) {
      const png = await renderTitlePng({
        title,
        font: title_style.font,
        size: title_style.size,
        color: title_style.color,
        bg_color: title_style.bg_color,
        bg_padding: title_style.bg_padding,
        bg_mode: title_style.bg_mode || 'block',
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

    // Voiceover (primary audio narration). When present, the source
    // video's audio is dropped and the voiceover plays in its place.
    // If loop_video is set + the voiceover is longer than the clip,
    // we add -stream_loop -1 to the video input below so frames keep
    // playing while the narration runs.
    let voiceoverPath = null
    if (voiceover_url) {
      try {
        voiceoverPath = join(workdir, 'voiceover.mp3')
        await writeFile(voiceoverPath, await fetchToBuffer(voiceover_url))
      } catch { voiceoverPath = null }
    }

    // -threads 2 caps decode parallelism. HEVC's reference-frame
    // buffers are per-thread, so unlimited-threads × 1080p HEVC
    // easily eats 4+ GB of RAM. Two threads is the sweet spot on a
    // shared-cpu-2x box: still parallel enough to stay fast, low
    // enough to fit in 4 GB even on a high-bitrate iPhone capture.
    //
    // -stream_loop -1 on the video input lets ffmpeg replay the
    // frames indefinitely; we then use -shortest on output so the
    // final length matches the longest other stream (voiceover).
    // Only enabled when the caller asked for it AND we actually have
    // a voiceover — looping silent video alone is rarely what people
    // mean by polish.
    const shouldLoopVideo = !!(loop_video && voiceoverPath)
    const args = ['-y', '-threads', '2']
    if (shouldLoopVideo) args.push('-stream_loop', '-1')
    // -noautorotate: we explicitly handle rotation via the transpose
    // filter further down, using probeRotation. Without this flag,
    // modern ffmpeg silently applies the source's displaymatrix BEFORE
    // our transpose runs, double-rotating iPhone portrait clips into
    // upside-down or sideways output. (After auto-normalize the source
    // has rotation baked in + metadata stripped, so -noautorotate is a
    // no-op there; for raw sources it's the difference between a
    // correctly-oriented post and a sideways one.)
    args.push('-noautorotate', '-i', polishInputPath)
    let nextIdx = 1
    let titleIdx = -1, logoIdx = -1, musicIdx = -1, voiceIdx = -1
    if (titlePngPath)  { args.push('-i', titlePngPath);  titleIdx = nextIdx++ }
    if (logoPath)      { args.push('-i', logoPath);      logoIdx  = nextIdx++ }
    if (musicPath)     { args.push('-i', musicPath);     musicIdx = nextIdx++ }
    if (voiceoverPath) { args.push('-i', voiceoverPath); voiceIdx = nextIdx++ }

    const filters = []
    let vLabel = '[0:v]'

    // Bake rotation metadata into the pixels BEFORE any overlay
    // filtering. We apply the INVERSE of the displaymatrix transform —
    // same convention ffmpeg's autorotate uses internally.
    //   90  → transpose=2 (CCW) — undoes +90 displaymatrix
    //   270 → transpose=1 (CW)  — undoes -90 displaymatrix (typical iPhone vertical)
    //   180 → vflip,hflip
    //   0   → no transform
    //
    // If auto-normalize already ran, rotation was baked into the pixels.
    // But some muxers can leave the displaymatrix side data on the output
    // anyway, so a re-probe might claim rotation != 0 and we'd transpose
    // a SECOND time (double-rotate → 180° wrong output). Skip the probe
    // entirely when we know we normalized.
    const rotation = didNormalize
      ? 0
      : await probeRotation(polishInputPath).catch(() => 0)
    if (rotation === 90 || rotation === 270 || rotation === 180) {
      const step = rotation === 90 ? 'transpose=2'
        : rotation === 270 ? 'transpose=1'
        : 'vflip,hflip'
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
    // Audio chain. Three sources to juggle:
    //   - source video audio ([0:a])
    //   - voiceover ([voiceIdx:a]) — primary if present
    //   - background music ([musicIdx:a]) — looped + faded to length
    //
    // Order of operations matters here. With a voiceover:
    //   - aLabel starts as either [0:a] (mix with source) or null
    //     (mute_video_audio=true — voiceover replaces source).
    //   - voiceover gets mixed/used directly as primary.
    //   - music, if present, ducks under everything via amix.
    let aLabel = mute_video_audio && voiceoverPath ? null : '[0:a]'

    // Audio cleanup pass — applied to the source audio BEFORE the
    // voiceover / music mix branches below.
    //   highpass=f=80       kills mic rumble + AC hum below 80 Hz
    //   dynaudnorm=g=5:p=0.95
    //                       single-pass dynamic loudness normalizer.
    //                       Pulls quiet phone recordings up to a
    //                       consistent perceived level WITHOUT the
    //                       pump/breathe artifacts that single-pass
    //                       loudnorm produces on speech. g=5 is a
    //                       conservative 5-second window; p=0.95
    //                       keeps peaks just under clipping.
    if (aLabel && audio_cleanup !== false) {
      filters.push(`${aLabel}highpass=f=80,dynaudnorm=g=5:p=0.95[aclean]`)
      aLabel = '[aclean]'
    }

    if (voiceoverPath) {
      // Voiceover at full volume. The 1.0 anull pass through gives us
      // a stable label to feed into amix below.
      filters.push(`[${voiceIdx}:a]volume=1.0[vox]`)
      if (aLabel === null) {
        // Source video muted → voiceover IS the primary track.
        aLabel = '[vox]'
      } else {
        // Mix source audio under the voiceover. Voiceover wins
        // perceptually since aLabel was the source.
        filters.push(`${aLabel}[vox]amix=inputs=2:duration=longest:dropout_transition=0:weights=0.3 1.0[avox]`)
        aLabel = '[avox]'
      }
    }

    if (musicPath) {
      const vol = Math.max(0, Math.min(1, Number(music_volume)))
      const fadeSecs = Math.max(0, Math.min(10, Number(music_fade_secs ?? 1.0)))
      let videoDur = 0
      try { videoDur = await probeDurationSecs(polishInputPath) } catch { videoDur = 0 }
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
      const primary = aLabel || '[0:a]'
      // amix with normalize=0 keeps the user's music_volume setting as
      // the literal mix ratio (default normalize=1 scales every input
      // by 1/N which makes voice end up quieter than expected and the
      // music feel comparatively dominant). weights=2 1 biases the
      // mix toward voice so spoken audio always wins over the bed
      // even when the source recording is soft. The final volume=0.7
      // is headroom to prevent peak clipping on the sum.
      filters.push(`${primary}[mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0:weights=2 1[premix]`)
      filters.push(`[premix]volume=0.7[aout]`)
      aLabel = '[aout]'
    }
    if (vLabel === '[0:v]') { filters.push(`[0:v]null[vfin]`); vLabel = '[vfin]' }
    if (aLabel === '[0:a]') { filters.push(`[0:a]anull[afin]`); aLabel = '[afin]' }

    args.push('-filter_complex', filters.join(';'))
    args.push('-map', vLabel)
    // aLabel is null only when mute_video_audio was set AND no
    // voiceover / music was added. In that case skip audio mapping
    // entirely — output is silent.
    if (aLabel) args.push('-map', aLabel)

    // -shortest stops the output at whichever stream ends first.
    // When we're looping video to match a voiceover, the looped
    // video would otherwise run forever; -shortest trims it to the
    // voiceover's natural length.
    if (shouldLoopVideo) args.push('-shortest')
    // `veryfast` encodes ~30% faster than `fast` with negligible
    // visible quality loss for short social clips. Combined with
    // the 1080p cap above, a 4K HEVC iPhone source now polishes
    // in ~60-90s on shared-cpu-2x (was ~5+ min before, hitting
    // Vercel's 504). -tune fastdecode hints x264 to skip the
    // costliest decoding paths in the output — irrelevant to the
    // viewer, useful for downstream tools (ZapCap especially).
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'fastdecode', '-crf', '24')
    if (aLabel) args.push('-c:a', 'aac', '-b:a', '128k')
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

    // Chain ZapCap captions when requested. Async jobs in particular
    // need this — Vercel's polish.js USED to handle captions after
    // the worker returned, but with big-clip async, Vercel times out
    // before we return, so it never gets that chance. Doing captions
    // here keeps the chain intact for both sync and async callers.
    // Failures are non-fatal — return the composite-only URL with a
    // warning so the user gets something rather than a hard error.
    let finalUrl = pub.publicUrl
    let zapcapMeta = null
    const wantsCaptions = !!(body.captions_enabled !== false && body.caption_template_id)
    if (wantsCaptions) {
      // Step-aware error capture: each ZapCap call lives in its own
      // try block so we know exactly which one threw. "Forbidden
      // resource" on the addVideoByUrl call = API key / account issue.
      // Same error on createTask = template_id doesn't belong to this
      // account. The DB row's zapcap.failed_step field surfaces which.
      let zStep = 'init'
      let zVideoId = null
      let zTaskId = null
      try {
        zStep = 'addVideoByUrl'
        zVideoId = await zapcapAddVideoByUrl(pub.publicUrl, { ttl: '1d' })
        zStep = 'createTask'
        zTaskId = await zapcapCreateTask(zVideoId, {
          templateId: body.caption_template_id,
          language:   body.caption_language || 'en',
          autoApprove: true,
        })
        zStep = 'pollTask'
        const zResult = await zapcapPollTask(zVideoId, zTaskId, { timeoutMs: 6 * 60 * 1000, intervalMs: 4000 })
        const dlUrl = zResult.downloadUrl || zResult.video?.downloadUrl || zResult.url
        if (dlUrl) {
          // ZapCap returns a pre-signed R2 URL with
          // `response-content-disposition=attachment` baked in. Browsers
          // refuse to play those inline (the <video> tag goes black),
          // so the canvas's Finish Video tile shows a black square even
          // though the file is fine. Re-host into Supabase so the URL
          // is plain video/mp4 with no attachment header. Falls back to
          // the raw ZapCap URL on download/upload failure so we never
          // regress to "no video at all".
          try {
            zStep = 'rehost'
            const zRes = await fetch(dlUrl)
            if (!zRes.ok) throw new Error(`ZapCap download ${zRes.status}`)
            const zBuf = Buffer.from(await zRes.arrayBuffer())
            const zPath = `${profile_id}/spaces/polished/zapcap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
            const { error: zErr } = await supabase.storage.from('landing-media').upload(zPath, zBuf, {
              contentType: 'video/mp4', upsert: false,
            })
            if (zErr) throw new Error(`Re-upload failed: ${zErr.message}`)
            const { data: zPub } = supabase.storage.from('landing-media').getPublicUrl(zPath)
            finalUrl = zPub.publicUrl
            zapcapMeta = { template_id: body.caption_template_id, video_id: zVideoId, task_id: zTaskId, rehosted: true }
          } catch (e) {
            console.warn('[worker] ZapCap re-host failed, falling back to R2 URL:', e.message)
            finalUrl = dlUrl
            zapcapMeta = { template_id: body.caption_template_id, video_id: zVideoId, task_id: zTaskId, rehost_failed: e.message }
          }
        } else {
          zapcapMeta = { failed_step: 'pollTask', error: 'ZapCap returned no downloadUrl', template_id: body.caption_template_id }
        }
      } catch (e) {
        console.warn(`[worker] ZapCap failed at step=${zStep}:`, e.status, e.message, JSON.stringify(e.response || {}).slice(0, 300))
        zapcapMeta = {
          failed_step: zStep,
          error: e.message,
          status: e.status || null,
          template_id: body.caption_template_id,
          video_id: zVideoId || null,
        }
      }
    }

    // ── Optional cover-intro prepend ──────────────────────────────────
    // When the caller asked for an embedded cover frame, chain the
    // existing prependCoverCore on top of the polished+captioned
    // output. This replaces the previous two-step autopilot flow
    // (polish → separate /jobs/prepend-cover call) with a single
    // worker invocation. ffmpeg still runs twice internally, but
    // the user sees one job, one returned URL.
    let coverIntroMeta = null
    if (embed_cover_intro && cover_image_url) {
      try {
        const coverResult = await prependCoverCore({
          profile_id,
          video_url: finalUrl,
          cover_image_url,
          duration_secs: cover_intro_secs,
        })
        if (coverResult?.video_url) {
          finalUrl = coverResult.video_url
          coverIntroMeta = {
            duration_secs: coverResult.duration_secs,
            bytes: coverResult.bytes,
          }
        } else {
          coverIntroMeta = { failed: true, reason: 'no_video_url_returned' }
        }
      } catch (e) {
        console.warn('[worker] cover-intro prepend failed, returning uncovered polish:', e?.message)
        coverIntroMeta = { failed: true, reason: e?.message || String(e) }
      }
    }

    return {
      video_url: finalUrl,
      bytes: finalBuf.byteLength,
      zapcap: zapcapMeta,
      cover_intro: coverIntroMeta,
    }
  } finally {
    if (workdir) { try { await rm(workdir, { recursive: true, force: true }) } catch {} }
  }
}

// ── Combine audio + video (fast pre-polish step) ─────────────────────────
// Body: { profile_id, video_url, audio_url, loop_video?: bool }
// Returns: { video_url, bytes }
//
// Purpose: take a silent (or noisy) source clip + a separate voiceover
// audio file and produce ONE mp4 with the voiceover muxed as the
// primary audio. No re-encode of video (-c:v copy), so it's a network-
// bound operation — typically 5-15s for a 30s clip.
//
// This is the new "Combine" node in the canvas. It exists so b-roll
// workflows (Upload media → voice_gen → polish) can decouple audio
// muxing from overlay rendering: the combined file goes into polish
// the same way an avatar_render output does, simplifying polish's
// filter graph dramatically.
async function combineAvCore(body) {
  const { profile_id, video_url, audio_url, loop_video = true } = body || {}
  if (!profile_id || !video_url || !audio_url) throw new Error('profile_id + video_url + audio_url required')
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Storage not configured on worker')

  let workdir = null
  try {
    workdir = await mkdtemp(join(tmpdir(), 'av-'))
    const vPath = join(workdir, 'in.mp4')
    const aPath = join(workdir, 'voice.mp3')
    const outPath = join(workdir, 'out.mp4')

    // Parallel download — they're independent.
    await Promise.all([
      (async () => {
        const r = await fetch(video_url)
        if (!r.ok) throw new Error(`Video download ${r.status}`)
        await writeFile(vPath, Buffer.from(await r.arrayBuffer()))
      })(),
      (async () => {
        const r = await fetch(audio_url)
        if (!r.ok) throw new Error(`Audio download ${r.status}`)
        await writeFile(aPath, Buffer.from(await r.arrayBuffer()))
      })(),
    ])

    // -c:v copy = no re-encode of video frames (fast, lossless).
    // -c:a aac = re-encode the voiceover into a standard mp4 audio
    //   codec; some upstream voice gen formats (Opus, weird mp3) won't
    //   stream-copy cleanly into mp4.
    // -map 0:v / -map 1:a = pull only the video stream from input 0
    //   and only the audio from input 1 (drops any audio that came
    //   with the source clip).
    // -stream_loop -1 + -shortest = loop the video to match the
    //   audio's length, then trim at the audio's natural end.
    const args = ['-y']
    if (loop_video) args.push('-stream_loop', '-1')
    args.push('-i', vPath, '-i', aPath)
    args.push('-map', '0:v:0', '-map', '1:a:0')
    args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k')
    args.push('-shortest', '-movflags', '+faststart')
    args.push(outPath)
    await runFFmpeg(args, 5 * 60_000)

    const buf = await readFile(outPath)
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const path = `${profile_id}/spaces/combined/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
    const { error: upErr } = await supabase.storage.from('landing-media').upload(path, buf, {
      contentType: 'video/mp4', upsert: false,
    })
    if (upErr) throw new Error(`Upload failed: ${upErr.message}`)
    const { data: pub } = supabase.storage.from('landing-media').getPublicUrl(path)
    return { video_url: pub.publicUrl, bytes: buf.byteLength }
  } finally {
    if (workdir) { try { await rm(workdir, { recursive: true, force: true }) } catch {} }
  }
}

app.post('/jobs/combine-av', requireSecret, async (req, res) => {
  try {
    const result = await combineAvCore(req.body || {})
    res.json(result)
  } catch (err) {
    console.error('combine-av job error:', err?.stack || err)
    res.status(500).json({ error: String(err?.message || err) })
  }
})

// ── Prepend cover intro to a video ───────────────────────────────────────
// Body: { profile_id, video_url, cover_image_url, duration_secs? }
// Returns: { video_url, bytes }
//
// Builds a short still segment from the cover image (default 1.0s),
// concatenates it before the source video, and re-encodes the whole
// thing to H.264 / AAC MP4 at the source's native resolution + 30fps.
// Used by the Schedule page's "Embed cover into video" toggle so the
// generated IG cover survives on platforms that auto-thumbnail from
// frame 0 (TikTok, YouTube Shorts, FB Reels).
//
// Yes, this re-encodes the source. We considered concat-demuxer to
// stream-copy the source (cheaper) but it requires the cover segment
// to match codec / SAR / fps / sample rate exactly, and we get
// arbitrary source files — re-encode is the more robust correct
// approach. performance-4x box handles a 30-second 1080p re-encode
// in ~10-15s.
async function prependCoverCore(body) {
  const {
    profile_id, video_url, cover_image_url,
    duration_secs = 0.5,
  } = body || {}
  if (!profile_id || !video_url || !cover_image_url) {
    throw new Error('profile_id + video_url + cover_image_url required')
  }
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Storage not configured on worker')
  const dur = Math.max(0.1, Math.min(5.0, Number(duration_secs) || 1.0))

  let workdir = null
  try {
    workdir = await mkdtemp(join(tmpdir(), 'cover-intro-'))
    const inVideoPath  = join(workdir, 'src.mp4')
    const coverPath    = join(workdir, 'cover.png')
    const outPath      = join(workdir, 'out.mp4')

    // Fetch source + cover in parallel.
    const [vBuf, cBuf] = await Promise.all([
      fetchToBuffer(video_url),
      fetchToBuffer(cover_image_url),
    ])
    await Promise.all([writeFile(inVideoPath, vBuf), writeFile(coverPath, cBuf)])

    // Probe source for dimensions so the cover segment matches and the
    // concat filter doesn't have to upscale/downscale on the join.
    // probeVideo returns { width, height, fps, has_audio, ... }.
    const probe = await probeVideo(inVideoPath)
    const W = probe.width || 1080
    const H = probe.height || 1920
    const FPS = probe.fps && probe.fps > 0 ? Math.min(60, Math.round(probe.fps)) : 30
    const hasAudio = !!probe.has_audio

    // Build the filter graph. The cover image gets looped to `dur`
    // seconds, scaled to the source's WxH with cover-fit + center-crop
    // so a 1:1 or 4:5 template fills a 9:16 source cleanly. Source
    // video is normalized to the same pixel format/SAR so concat
    // doesn't reject the join. Audio: if source has audio, we pad
    // `dur` seconds of silence at the front; if not, the whole
    // output is silent.
    const filterParts = [
      `[0:v]loop=loop=-1:size=1,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},format=yuv420p,trim=duration=${dur},setpts=PTS-STARTPTS[cv]`,
      `[1:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[sv]`,
    ]
    let mapVideo, mapAudio
    if (hasAudio) {
      // Pad source's audio with `dur` seconds of leading silence so
      // the audio timeline matches the video timeline post-concat.
      filterParts.push(`[2:a]atrim=duration=${dur},asetpts=PTS-STARTPTS[ca]`)
      filterParts.push(`[cv][ca][sv][1:a]concat=n=2:v=1:a=1[outv][outa]`)
      mapVideo = '[outv]'
      mapAudio = '[outa]'
    } else {
      filterParts.push(`[cv][sv]concat=n=2:v=1:a=0[outv]`)
      mapVideo = '[outv]'
      mapAudio = null
    }

    const args = [
      '-y',
      '-loop', '1', '-t', String(dur), '-i', coverPath,
      '-i', inVideoPath,
    ]
    if (hasAudio) {
      // anullsrc generates silence that we trim and prepend to the
      // source audio via atrim/asetpts above.
      args.push('-f', 'lavfi', '-t', String(dur + 0.5), '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`)
    }
    args.push(
      '-filter_complex', filterParts.join(';'),
      '-map', mapVideo,
    )
    if (mapAudio) args.push('-map', mapAudio)
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
      '-pix_fmt', 'yuv420p',
    )
    if (hasAudio) args.push('-c:a', 'aac', '-b:a', '128k')
    args.push('-movflags', '+faststart', outPath)

    await runFFmpeg(args, 5 * 60_000)  // 5min ceiling — generous for big sources

    const outBuf = await readFile(outPath)
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const path = `${profile_id}/spaces/cover-intro/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
    const { error: upErr } = await supabase.storage.from('landing-media').upload(path, outBuf, {
      contentType: 'video/mp4', upsert: false,
    })
    if (upErr) throw new Error(`Upload failed: ${upErr.message}`)
    const { data: pub } = supabase.storage.from('landing-media').getPublicUrl(path)
    return { video_url: pub.publicUrl, bytes: outBuf.byteLength, duration_secs: dur }
  } finally {
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
}

// Async submit — same pattern as polish-async. Returns job_id; caller
// polls GET /jobs/:id until status=done.
app.post('/jobs/prepend-cover-async', requireSecret, async (req, res) => {
  const body = req.body || {}
  if (!body.profile_id || !body.video_url || !body.cover_image_url) {
    return res.status(400).json({ error: 'profile_id + video_url + cover_image_url required' })
  }
  const jobId = newJobId()
  jobs.set(jobId, { status: 'queued', queued_at: new Date().toISOString() })
  ;(async () => {
    jobStart()
    const job = jobs.get(jobId)
    job.status = 'running'
    job.started_at = new Date().toISOString()
    try {
      const result = await prependCoverCore(body)
      job.status = 'done'
      job.result = result
      job.finished_at = new Date().toISOString()
    } catch (err) {
      job.status = 'failed'
      job.error = String(err?.message || err)
      job.finished_at = new Date().toISOString()
      console.error(`prepend-cover job ${jobId} failed:`, err?.stack || err)
    } finally {
      jobEnd()
      setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000)
    }
  })()
  return res.status(202).json({ job_id: jobId, status: 'queued' })
})

// ── Extract audio for transcription ──────────────────────────────────────
// Body: { profile_id, video_url }
// Returns: { audio_url, bytes, duration_secs? }
//
// Pulls the audio track out of a video and writes a mono 16kHz mp3 to
// landing-media/<profile_id>/transcripts/. The output is 10–100x smaller
// than the source video (e.g. 200MB .mov → ~2MB .mp3), which lets us
// send it to ElevenLabs Scribe (or any STT) without hitting size or
// timeout limits. Speech recognition doesn't benefit from stereo or
// high sample rates — 16kHz mono is the standard input.
async function extractAudioCore(body) {
  const { profile_id, video_url } = body || {}
  if (!profile_id || !video_url) throw new Error('profile_id + video_url required')
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Storage not configured on worker')

  let workdir = null
  try {
    workdir = await mkdtemp(join(tmpdir(), 'audio-'))
    // Keep the original extension so ffmpeg's demuxer picks the right
    // parser (some containers need the .mov / .webm hint to decode
    // cleanly even though ffmpeg can detect by bytes).
    const extMatch = video_url.split('?')[0].match(/\.([a-z0-9]+)$/i)
    const ext = extMatch ? extMatch[1].toLowerCase() : 'mp4'
    const vPath = join(workdir, `in.${ext}`)
    const aPath = join(workdir, 'out.mp3')

    const r = await fetch(video_url)
    if (!r.ok) throw new Error(`Video download ${r.status}`)
    await writeFile(vPath, Buffer.from(await r.arrayBuffer()))

    // -vn: drop video stream.
    // -ac 1: mono — speech recognition doesn't use stereo.
    // -ar 16000: 16kHz sample rate (Scribe's preferred input).
    // -b:a 64k: 64kbps mp3 — clear voice, tiny file (~30KB/sec).
    // -map 0:a:0?: only first audio track, error-tolerant for silent
    //   videos (the `?` makes the mapping optional so we get an empty
    //   output instead of failing — caller can detect and skip).
    const args = [
      '-y', '-i', vPath,
      '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k',
      '-map', '0:a:0?',
      aPath,
    ]
    await runFFmpeg(args, 10 * 60_000)

    const buf = await readFile(aPath)
    if (buf.byteLength === 0) {
      throw new Error('Extracted audio is empty (video may have no audio track)')
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const path = `${profile_id}/transcripts/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`
    const { error: upErr } = await supabase.storage.from('landing-media').upload(path, buf, {
      contentType: 'audio/mpeg', upsert: false,
    })
    if (upErr) throw new Error(`Upload failed: ${upErr.message}`)
    const { data: pub } = supabase.storage.from('landing-media').getPublicUrl(path)
    return { audio_url: pub.publicUrl, bytes: buf.byteLength }
  } finally {
    if (workdir) { try { await rm(workdir, { recursive: true, force: true }) } catch {} }
  }
}

app.post('/jobs/extract-audio', requireSecret, async (req, res) => {
  try {
    const result = await extractAudioCore(req.body || {})
    res.json(result)
  } catch (err) {
    console.error('extract-audio job error:', err?.stack || err)
    res.status(500).json({ error: String(err?.message || err) })
  }
})

// ── Normalize / compress a video to canonical MP4 ──────────────────────
// Body: { profile_id, video_url, force?: bool }
// Returns: { video_url, bytes, normalized: bool, reason: string|null,
//            probe: { codec, width, height, fps, is_hdr, rotation, ... } }
//
// Reads the probe; if the source isn't already canonical (or force=true),
// runs a CRF 23 H.264 / AAC pass capped at 1080p / 30fps with HDR
// tone-mapping + rotation baked in, then writes to
// landing-media/<profile_id>/normalized/. When the source is already
// canonical we just echo the original URL back (no wasted encode).
//
// Used by:
//   • polishCore (auto-normalizes weird sources before applying overlays)
//   • the Vercel /api/videos/normalize endpoint that the "Compress" UI
//     button on Bulk Upload rows posts to
async function normalizeVideoCore(body) {
  const { profile_id, video_url, force = false } = body || {}
  if (!profile_id || !video_url) throw new Error('profile_id + video_url required')
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Storage not configured on worker')

  let workdir = null
  try {
    workdir = await mkdtemp(join(tmpdir(), 'norm-'))
    const inPath  = join(workdir, 'in.mp4')
    const outPath = join(workdir, 'out.mp4')
    const srcBuf = await fetchToBuffer(video_url)
    await writeFile(inPath, srcBuf)

    const probe = await probeVideo(inPath)
    const reason = force ? 'force' : needsNormalize(probe, srcBuf.byteLength)
    if (!reason) {
      // Already canonical — short-circuit, return original URL.
      return {
        video_url, bytes: srcBuf.byteLength,
        normalized: false, reason: null, probe,
      }
    }

    await normalizeFile(inPath, outPath, probe, probe.has_audio)
    const buf = await readFile(outPath)

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const path = `${profile_id}/normalized/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
    const { error: upErr } = await supabase.storage.from('landing-media').upload(path, buf, {
      contentType: 'video/mp4', upsert: false,
    })
    if (upErr) throw new Error(`Upload failed: ${upErr.message}`)
    const { data: pub } = supabase.storage.from('landing-media').getPublicUrl(path)
    return {
      video_url: pub.publicUrl, bytes: buf.byteLength,
      normalized: true, reason, probe,
      source_bytes: srcBuf.byteLength,
    }
  } finally {
    if (workdir) { try { await rm(workdir, { recursive: true, force: true }) } catch {} }
  }
}

app.post('/jobs/normalize-video', requireSecret, async (req, res) => {
  try {
    const result = await normalizeVideoCore(req.body || {})
    res.json(result)
  } catch (err) {
    console.error('normalize-video job error:', err?.stack || err)
    res.status(500).json({ error: String(err?.message || err) })
  }
})

// Sync wrapper around polishCore. Kept for backward compat — small
// clips (< ~60 MB) finish well within Vercel's 300s timeout via
// this path. Larger clips should use /jobs/polish-async + status
// polling instead.
app.post('/jobs/polish', requireSecret, async (req, res) => {
  try {
    const result = await polishCore(req.body || {})
    res.json(result)
  } catch (err) {
    console.error('polish job error:', err?.stack || err)
    res.status(500).json({ error: String(err?.message || err) })
  }
})

app.listen(PORT, () => console.log(`[worker] listening on :${PORT}`))
