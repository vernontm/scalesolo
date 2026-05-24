// POST /api/studio/render-final — final long-form bake.
//
// Stitches every approved studio_segment into a single MP4. v1 runs
// on Vercel with native ffmpeg via @ffmpeg-installer/ffmpeg, mirroring
// the pattern that api/videos/polish.js already uses. The HyperFrames
// motion-graphics rendering (the real animated title cards / stat
// reveals / etc.) is deferred to a Fly worker — for now, motion
// graphics segments render as styled drawtext overlays so the bake
// still produces a watchable end-to-end MP4.
//
// Per-segment intermediate chunks:
//
//   avatar:                  avatar_video_url (already has voice baked
//                            in by HeyGen since we passed audio_url at
//                            submission time). No re-encode if it's
//                            already in our target codec.
//
//   voiceover_broll:         image_url as a still + voice audio,
//                            duration = voice_duration_secs. Subtle
//                            Ken Burns zoom for motion.
//
//   voiceover_motion_graphics: dark background + drawtext overlay
//                            (script_text wrapped to width) + voice.
//                            Real HyperFrames render lands in the Fly
//                            worker swap.
//
//   pure_motion_graphics:    dark background + drawtext (title /
//                            script_text) + sound_effect if any. Hold
//                            for ~2.5s.
//
// Concat is via the concat demuxer with stream-copy whenever every
// chunk shares the same codec (always, since we control encoding).
// Falls back to filter_complex re-encode if the fast path errors.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import puppeteer from 'puppeteer-core'
import chromium from '@sparticuz/chromium'
import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { gateStudio } from './_lib/gate.js'

const ffmpegPath = ffmpegInstaller.path
const __dirname = dirname(fileURLToPath(import.meta.url))
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const STUDIO_BUCKET = 'studio-media'

// Base URL the headless browser uses to fetch composition HTML during
// the bake. Vercel sets VERCEL_URL at runtime to the current
// deployment's hostname (per-deploy hash on previews, production
// domain on main). Prefer an explicit override for local dev / Fly
// migration; otherwise build it from VERCEL_URL.
function renderBaseUrl() {
  if (process.env.STUDIO_RENDER_BASE_URL) return process.env.STUDIO_RENDER_BASE_URL.replace(/\/$/, '')
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  // Last-resort: if we're literally running on a dev box, the dev server
  // typically lives at :5173 with a Vite proxy serving /studio-compositions.
  return 'http://localhost:5173'
}

// Same encoding the React iframe uses. URL hash carries base64(JSON).
function encodeVarsForUrl(vars) {
  try {
    const json = JSON.stringify(vars || {})
    // Use Buffer for Node so we don't have to deal with browser globals.
    return encodeURIComponent(Buffer.from(json, 'utf8').toString('base64'))
  } catch {
    return ''
  }
}

export const config = {
  maxDuration: 300,
  memory: 3008,
  includeFiles: '{node_modules/@ffmpeg-installer/**,api/_fonts/**}',
}

// ── ffmpeg helpers ──────────────────────────────────────────────────────────
function runFFmpeg(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr += d.toString('utf8')
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
    })
    proc.stdout.on('data', () => { /* drain */ })
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stderr)
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.split('\n').slice(-10).join('\n')}`))
    })
  })
}

// Probe duration of an audio file via ffprobe (bundled with ffmpeg-installer).
// Falls back to 0 on failure — caller treats 0 as "use default 4s hold."
async function probeAudioDurationSecs(path) {
  return new Promise((resolve) => {
    const args = ['-i', path, '-hide_banner', '-f', 'null', '-']
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    proc.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/)
      if (!m) return resolve(0)
      const [, hh, mm, ss] = m
      resolve(Number(hh) * 3600 + Number(mm) * 60 + Number(ss))
    })
    proc.on('error', () => resolve(0))
  })
}

// Download a remote URL to a local file inside the work dir.
async function downloadTo(url, dest) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Download failed (${r.status}) for ${url.slice(0, 80)}`)
  const buf = Buffer.from(await r.arrayBuffer())
  await writeFile(dest, buf)
  return dest
}

// Aspect ratio → ffmpeg dimensions
function dimensions(aspect) {
  if (aspect === '9:16') return { w: 1080, h: 1920 }
  if (aspect === '1:1')  return { w: 1080, h: 1080 }
  return { w: 1920, h: 1080 }
}

// Sanitize for drawtext: ffmpeg's filter parser explodes on quotes, colons,
// commas, backslashes. textfile= sidesteps most of it; we still drop control
// chars that break libfreetype.
function safeDrawTextLine(s) {
  // Strip ASCII control chars + DEL so libfreetype doesn't choke on them.
  // eslint-disable-next-line no-control-regex
  return String(s || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim()
}

// Word-wrap a long script line to a target visual width. Naive but works for
// the 80-char-ish lines Studio scripts produce.
function wrapText(text, perLine = 38) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > perLine && cur) {
      lines.push(cur)
      cur = w
    } else {
      cur = (cur ? cur + ' ' : '') + w
    }
  }
  if (cur) lines.push(cur)
  return lines.slice(0, 6).join('\n')
}

// ── Headless Chrome (Puppeteer) — HyperFrames composition renderer ─────────
// Reused across every motion-graphics chunk in a single bake. Cold start
// is ~2-3s; subsequent compositions reuse the same browser process so
// we only pay it once per render.
let _browserPromise = null
let _browserLaunchErr = null  // captured so handler can include in render_progress diag
async function getBrowser() {
  if (_browserPromise) return _browserPromise
  _browserPromise = (async () => {
    // sparticuz/chromium bundles a serverless-optimized Chromium and the
    // matching launch args. We log the executablePath up-front so any
    // "binary not bundled" silent failure shows up in Vercel logs.
    let executablePath
    try {
      executablePath = await chromium.executablePath()
    } catch (e) {
      _browserLaunchErr = `chromium.executablePath() threw: ${e.message}`
      throw new Error(_browserLaunchErr)
    }
    if (!executablePath) {
      _browserLaunchErr = 'chromium.executablePath() returned empty — binary not bundled into the Vercel function. Check vercel.json includeFiles.'
      throw new Error(_browserLaunchErr)
    }
    console.log(`[studio puppeteer] launching chromium at ${executablePath}`)

    try {
      return await puppeteer.launch({
        args: [
          ...chromium.args,
          '--hide-scrollbars',
          '--disable-web-security',
          // Compose-friendly: avoids the rasterizer crash some Vercel
          // Lambda images hit on initial paint.
          '--disable-dev-shm-usage',
          '--no-sandbox',
        ],
        defaultViewport: { width: 1920, height: 1080 },
        executablePath,
        // Hardcode headless=true. chromium.headless can return a string
        // ('new') on some sparticuz versions, which older puppeteer-core
        // builds reject silently.
        headless: true,
        ignoreHTTPSErrors: true,
      })
    } catch (e) {
      _browserLaunchErr = `puppeteer.launch threw: ${e.message}`
      throw e
    }
  })()
  return _browserPromise
}

async function closeBrowserSafe() {
  if (!_browserPromise) return
  try {
    const b = await _browserPromise
    await b.close()
  } catch { /* swallow on shutdown */ }
  _browserPromise = null
}

// Render a HyperFrames composition to an MP4 chunk by:
//   1. Loading the composition HTML in headless Chrome with mode=render
//      so the runtime registers the GSAP timeline on window.__timelines
//      instead of auto-playing in preview-loop mode.
//   2. Seeking the timeline at 30fps intervals across the segment's
//      target duration and screenshotting each frame.
//   3. ffmpeg-encoding the frame sequence + muxing the voice mp3.
//
// Frame capture is the slow part — ~50-100ms per 1080p PNG. For a 5s
// segment at 30fps (150 frames) that's roughly 8-15s per chunk. The
// browser instance is reused across chunks so cold-start cost is paid
// once per bake.
async function renderHyperFramesChunk(seg, paths, dim, durationSecs, fontPath) {
  const browser = await getBrowser()
  const page = await browser.newPage()

  // Vercel preview deployments default to SSO-protected. Puppeteer
  // running INSIDE the function has no Vercel auth cookies, so without
  // bypass headers it gets redirected to vercel.com/login and the
  // composition never loads (every motion segment fell back here).
  //
  // VERCEL_AUTOMATION_BYPASS_SECRET is auto-injected by Vercel when
  // "Protection Bypass for Automation" is enabled on the project
  // (Settings → Deployment Protection → Protection Bypass for
  // Automation). Sending this as a header lets the function's own
  // Puppeteer instance through the auth wall.
  //
  // If the env var isn't set (Protection Bypass not enabled), we
  // skip the header — works fine for production deployments which
  // aren't behind SSO, and the user sees the redirect-to-login
  // diagnostic in the fallback reason if it's a problem.
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  if (bypassSecret) {
    await page.setExtraHTTPHeaders({
      'x-vercel-protection-bypass': bypassSecret,
      // Tells Vercel to set a bypass cookie on the response so
      // subsequent requests from the same Chrome page (e.g. the
      // CSS, JS, and font subresources) also get through without
      // each needing the header.
      'x-vercel-set-bypass-cookie': 'samesitenone',
    })
  }
  // Capture page console + uncaught errors so when waitForFunction
  // times out we can include them in the thrown error. Without this
  // the failure is just "10000ms exceeded" — useless for diagnosis.
  const pageLogs = []
  const pageErrors = []
  page.on('console', (msg) => {
    pageLogs.push(`[${msg.type()}] ${msg.text()}`)
  })
  page.on('pageerror', (err) => {
    pageErrors.push(err.message)
  })
  page.on('requestfailed', (req) => {
    pageErrors.push(`requestfailed ${req.url()}: ${req.failure()?.errorText || 'unknown'}`)
  })

  try {
    await page.setViewport({ width: dim.w, height: dim.h, deviceScaleFactor: 1 })

    const baseUrl = renderBaseUrl()
    const compId = seg.hyperframes_composition_id
    const varsHash = encodeVarsForUrl(seg.hyperframes_variables || {})
    const url = `${baseUrl}/studio-compositions/${compId}.html?mode=render#vars=${varsHash}`

    // 'load' waits for all sync scripts to finish (including our inline
    // composition script that calls studioPlay). networkidle0 isn't
    // strictly needed since we don't depend on lazy-loaded resources.
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 })

    // Check timeline registration. Previous version used Puppeteer's
    // waitForFunction with polling: 'raf' (default) AND then polling:
    // 100 — both timed out at 15-20s even though the timeline was
    // registered immediately. Headless Chrome on Lambda throttles
    // BOTH requestAnimationFrame AND setTimeout polling for background
    // tabs, defeating waitForFunction entirely.
    //
    // New approach: skip Puppeteer polling entirely. Use a single
    // page.evaluate that runs inside the page context (where setTimeout
    // works) to wait+check directly. The page-context loop runs at the
    // page's own JS clock, not Puppeteer's throttled poll. Since the
    // load event has already fired, the timeline IS registered — we
    // just need to read it.
    try {
      const ready = await Promise.race([
        page.evaluate(async (id) => {
          const start = Date.now()
          while (Date.now() - start < 15000) {
            if (window.__timelines && window.__timelines[id]) return true
            await new Promise((r) => setTimeout(r, 80))
          }
          return false
        }, compId),
        // External safety: if the evaluate itself hangs, kill it.
        new Promise((_, rej) => setTimeout(() => rej(new Error('page.evaluate hung')), 20000)),
      ])
      if (!ready) throw new Error('Waiting failed: 15000ms exceeded')
    } catch (timeoutErr) {
      // Dump the page's state so we can diagnose remotely. Includes
      // whether the runtime script ran, what mode it detected, what
      // vars it parsed, whether GSAP loaded, and any console / pageerror
      // events captured during the page lifecycle.
      const diag = await page.evaluate(() => ({
        url: location.href,
        hash: location.hash,
        search: location.search,
        gsap_loaded: typeof window.gsap !== 'undefined',
        studio_mode: window.__studioMode,
        studio_vars_keys: window.__studioVars ? Object.keys(window.__studioVars) : null,
        studio_composition_id: window.__studioCompositionId,
        studio_play_defined: typeof window.studioPlay === 'function',
        timelines_keys: window.__timelines ? Object.keys(window.__timelines) : null,
        body_innerHTML_preview: (document.body?.innerHTML || '').slice(0, 200),
        script_count: document.querySelectorAll('script').length,
      })).catch((e) => ({ eval_err: e.message }))
      const summary = JSON.stringify({
        timeout: timeoutErr.message,
        diag,
        page_errors: pageErrors.slice(-5),
        page_logs: pageLogs.slice(-10),
      })
      throw new Error(`HyperFrames timeline never registered: ${summary}`)
    }

    // Pull the timeline's actual duration so we can map render time to
    // timeline time. Useful when the composition is shorter than the
    // segment (we hold the last frame) or longer (we capture a portion).
    const tlDur = await page.evaluate((id) => {
      const tl = window.__timelines[id]
      return tl?.duration ? Number(tl.duration()) : 0
    }, compId)

    const captureDur = Math.max(0.5, durationSecs)
    const fps = 30
    const totalFrames = Math.ceil(captureDur * fps)
    const framesDir = paths.framesDir
    await mkdir(framesDir, { recursive: true })

    for (let i = 0; i < totalFrames; i++) {
      // Map the current frame's time in the segment to a position on
      // the composition's GSAP timeline. If the timeline is shorter
      // than the segment, we clamp to its end (holds the final frame).
      const tInSegment = i / fps
      const tInTimeline = tlDur > 0 ? Math.min(tInSegment, tlDur) : tInSegment
      await page.evaluate((id, time) => {
        const tl = window.__timelines[id]
        if (tl?.seek) tl.seek(time, false)
      }, compId, tInTimeline)

      const framePath = join(framesDir, `frame-${String(i).padStart(5, '0')}.png`)
      await page.screenshot({ path: framePath, type: 'png', omitBackground: false })
    }

    // Encode frames → MP4 (no audio yet)
    const videoOnly = join(framesDir, 'video.mp4')
    await runFFmpeg([
      '-y',
      '-framerate', String(fps),
      '-i', join(framesDir, 'frame-%05d.png'),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      videoOnly,
    ], 90_000)

    // Mux voice (or silent track) so concat sees a consistent audio stream.
    const outFile = paths.outChunk
    const args = ['-y', '-i', videoOnly]
    if (paths.voice) args.push('-i', paths.voice)
    args.push(
      '-t', String(captureDur.toFixed(3)),
      '-map', '0:v:0',
    )
    if (paths.voice) {
      args.push('-map', '1:a:0')
    } else {
      args.push('-f', 'lavfi', '-t', String(captureDur.toFixed(3)),
                '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
                '-map', '2:a:0')
    }
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      '-af', 'aresample=async=1:first_pts=0',
      '-pix_fmt', 'yuv420p',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      outFile,
    )
    await runFFmpeg(args, 60_000)
    return outFile
  } finally {
    await page.close().catch(() => {})
  }
}

// ── Per-segment chunk renderers ─────────────────────────────────────────────
async function renderAvatarChunk(seg, paths, dim, durationSecs) {
  // HeyGen V3 with audio_url returns a VIDEO-ONLY mp4. We re-mux the
  // voice on top here. Two inputs: HeyGen video [0:v], voice mp3 [1:a].
  // Explicit -map drops any phantom audio in the HeyGen output (no
  // double-audio risk if they ever start returning a track).
  //
  // -t <durationSecs> forces an exact chunk length matching the voice
  // duration. This is critical: -shortest alone leaves sub-frame
  // mismatches between video container length and audio length, which
  // compound across many chunks during concat and show up as drifting
  // lip-sync. Computing duration upstream + forcing it here keeps every
  // chunk dimensionally consistent.
  //
  // -avoid_negative_ts make_zero resets timestamps so the concat filter
  // doesn't have to renormalize them later.
  const outFile = paths.outChunk
  // Default to the voice duration; HeyGen often pads a brief hold at the
  // end of the avatar clip past where the speech ends. We trim to voice.
  const trim = durationSecs > 0 ? durationSecs : 6
  const args = ['-y', '-i', paths.avatarMp4]
  if (paths.voice) args.push('-i', paths.voice)
  args.push(
    '-t', String(trim.toFixed(3)),
    '-vf', `scale=${dim.w}:${dim.h}:force_original_aspect_ratio=increase,crop=${dim.w}:${dim.h}`,
    '-r', '30',
    '-map', '0:v:0',
  )
  if (paths.voice) {
    args.push('-map', '1:a:0')
  } else {
    args.push('-f', 'lavfi', '-t', String(trim.toFixed(3)),
              '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
              '-map', '2:a:0')
  }
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-af', 'aresample=async=1:first_pts=0',
    '-pix_fmt', 'yuv420p',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    outFile,
  )
  await runFFmpeg(args, 120_000)
  return outFile
}

async function renderBrollChunk(seg, paths, dim, durationSecs) {
  // Still image with ONE continuous Ken-Burns zoom-in across the
  // whole chunk. Took two tries to get right:
  //
  // Attempt 1 used zoompan with z='min(zoom+0.0006,1.06)':d=totalFrames.
  // Bug: with -loop 1, ffmpeg treats each repeated frame as a new
  // "input image" for zoompan, so the zoom counter restarted every
  // input frame — visible re-zoom every couple seconds.
  //
  // Attempt 2 used the crop filter with t-based width/height
  // expressions. Bug: crop's w/h are evaluated ONCE at filter
  // configure time, not per frame, so the time variable t collapsed
  // to 0 and the configure step errored out with "Failed to configure
  // input pad".
  //
  // Working approach: zoompan with `d=1` (one output frame per input
  // frame) and zoom expression keyed on `on` (output frame counter,
  // monotonically increasing across the whole filter run — NOT per
  // input frame). Gives one continuous zoom from 1.0 to 1.12 across
  // every frame in the segment regardless of how the input loops.
  const outFile = paths.outChunk
  const dur = durationSecs.toFixed(3)
  const totalFrames = Math.max(30, Math.ceil(durationSecs * 30))
  const ZOOM_MAX = 0.12  // ends at 1.12x
  // 1.3x prep scale gives headroom so the crop never reads pixels
  // outside the source as the image zooms in.
  const prepW = Math.round(dim.w * 1.3)
  const prepH = Math.round(dim.h * 1.3)
  const vf = [
    `scale=${prepW}:${prepH}:force_original_aspect_ratio=increase`,
    `crop=${prepW}:${prepH}`,            // exact prep-canvas size
    `fps=30`,
    // zoompan operates at the prep-canvas resolution, outputting at
    // canvas resolution. `on` is the output frame index (0..N-1).
    `zoompan=z='1+${ZOOM_MAX}*on/${totalFrames}':d=1` +
      `:s=${dim.w}x${dim.h}:fps=30` +
      `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    `setsar=1`,
  ].join(',')
  await runFFmpeg([
    '-y',
    '-loop', '1', '-t', dur, '-i', paths.image,
    '-i', paths.voice,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-pix_fmt', 'yuv420p',
    '-shortest',
    '-movflags', '+faststart',
    outFile,
  ], 120_000)
  return outFile
}

async function renderMotionChunk(seg, paths, dim, durationSecs, fontPath) {
  // v1 placeholder for HyperFrames motion graphics. Dark bg + the segment's
  // hyperframes_variables.title (or script_text, or composition_id) as a
  // centered headline. Real HyperFrames render lands in the Fly worker.
  const v = seg.hyperframes_variables || {}
  const headline = v.title || v.quote || v.stat_number || seg.script_text || ''
  const sub = v.subtitle || v.stat_label || v.attribution || v.cta || ''
  const wrapped = wrapText(safeDrawTextLine(headline), 32)
  const subWrapped = wrapText(safeDrawTextLine(sub), 48)
  // Write text to a file to dodge filter-quote hell
  await writeFile(paths.textHead, wrapped, 'utf8')
  await writeFile(paths.textSub, subWrapped, 'utf8')

  const inputs = ['-y', '-f', 'lavfi', '-t', String(durationSecs.toFixed(3)), '-i', `color=c=#0a0a0c:s=${dim.w}x${dim.h}:r=30`]
  if (paths.voice) inputs.push('-i', paths.voice)

  const drawHead =
    `drawtext=fontfile=${fontPath}:textfile=${paths.textHead}` +
    `:fontcolor=#e3151e:fontsize=${Math.round(dim.h / 11)}:line_spacing=10` +
    `:x=(w-text_w)/2:y=(h-text_h)/2-${Math.round(dim.h / 16)}`
  const drawSub = sub
    ? `,drawtext=fontfile=${fontPath}:textfile=${paths.textSub}` +
      `:fontcolor=white:fontsize=${Math.round(dim.h / 22)}:line_spacing=8` +
      `:x=(w-text_w)/2:y=(h+text_h)/2+${Math.round(dim.h / 20)}:alpha=0.7`
    : ''
  const filter = `${drawHead}${drawSub}`

  const args = [
    ...inputs,
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p',
  ]
  if (paths.voice) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-shortest')
  } else {
    // Pure motion: silent track at 48k so concat doesn't drop the audio stream.
    args.push('-f', 'lavfi', '-t', String(durationSecs.toFixed(3)),
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-c:a', 'aac', '-b:a', '128k')
    // Reorder: lavfi audio input was appended after the -vf; ffmpeg accepts
    // out-of-position args but the cleanest path is to keep flags adjacent
    // to the streams they apply to. ffmpeg is lenient here.
  }
  args.push('-movflags', '+faststart', paths.outChunk)
  await runFFmpeg(args, 90_000)
  return paths.outChunk
}

// ── Font resolution ─────────────────────────────────────────────────────────
// Resolve to an absolute path inside the bundled function. Uses
// __dirname (matching api/videos/polish.js's pattern) so the path is
// valid at runtime on Vercel Lambda, not just the relative-to-cwd
// "api/_fonts/..." that doesn't exist there. We pin to Inter ExtraBold
// since it's the closest match to Studio's brand display weight; falls
// through the bundled file list in case the preferred file is missing.
const FONT_CANDIDATES = [
  'Inter-ExtraBold.ttf',
  'Montserrat-ExtraBold.ttf',
  'Poppins-ExtraBold.ttf',
  'Anton-Regular.ttf',
  'Sans-Bold.ttf',  // Always-present last-resort sans
]
let _fontPathCached = null
async function resolveFont() {
  if (_fontPathCached) return _fontPathCached
  for (const filename of FONT_CANDIDATES) {
    const p = join(__dirname, '..', '_fonts', filename)
    try {
      await readFile(p)
      _fontPathCached = p
      return p
    } catch { /* try next */ }
  }
  throw new Error('No bundled font found in api/_fonts/. Add one to the repo.')
}

// ── Main handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  let workdir = null
  try {
    gateStudio(auth.user.id)
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'Supabase storage not configured' })
    }

    const videoId = req.body?.studio_video_id
    if (!videoId) return res.status(400).json({ error: 'studio_video_id required' })

    const vRows = await supaFetch(`studio_videos?id=eq.${videoId}&select=*&limit=1`)
    const video = vRows?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    const segments = await supaFetch(
      `studio_segments?studio_video_id=eq.${videoId}&approved=eq.true&select=*&order=segment_index.asc&limit=500`
    )
    if (!segments?.length) return res.status(400).json({ error: 'No approved segments to render' })

    // Block rendering until every approved segment that needs an asset has
    // it. pure_motion_graphics rows skip asset gen so they can be 'ready'
    // without urls; we don't require voice_url for them either.
    const blocking = segments.filter((s) => {
      if (s.segment_type === 'pure_motion_graphics') return false
      if (s.status === 'error') return true
      if (!s.voice_url) return true
      if (s.segment_type === 'voiceover_broll' && !s.image_url) return true
      if (s.segment_type === 'avatar' && !s.avatar_video_url) return true
      return false
    })
    if (blocking.length) {
      return res.status(400).json({
        error: `${blocking.length} segment(s) still missing assets. Wait for asset generation to complete or fix errors.`,
      })
    }

    // Initial progress write: stage=baking, current=0, total=N. The
    // frontend reads this via Realtime so the sticky bar can show a
    // real progress bar instead of a spinner. hf_rendered tracks
    // segments that successfully rendered with the full HyperFrames
    // composition; hf_fallback tracks segments that had to use the
    // drawtext stub (with the reason so we can debug).
    const progress = {
      stage: 'baking',
      current: 0,
      total: segments.length,
      started_at: new Date().toISOString(),
      hf_rendered: [],
      hf_fallback: [],
    }
    await supaFetch(`studio_videos?id=eq.${videoId}`, {
      method: 'PATCH',
      body: { status: 'rendering', error: null, render_progress: progress },
      prefer: 'return=minimal',
    })

    workdir = await mkdtemp(join(tmpdir(), `studio-render-${videoId.slice(0, 8)}-`))
    const dim = dimensions(video.aspect_ratio)
    const fontPath = await resolveFont()
    const chunkPaths = []

    const writeProgress = async () => {
      await supaFetch(`studio_videos?id=eq.${videoId}`, {
        method: 'PATCH',
        body: { render_progress: progress },
        prefer: 'return=minimal',
      }).catch(() => { /* progress is best-effort, don't fail bake on a stat write */ })
    }

    // Render each segment to an intermediate MP4
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const dir = join(workdir, `seg-${String(i).padStart(3, '0')}`)
      await mkdir(dir, { recursive: true })
      const paths = {
        avatarMp4: join(dir, 'avatar.mp4'),
        image:     join(dir, 'image.jpg'),
        voice:     null,
        textHead:  join(dir, 'head.txt'),
        textSub:   join(dir, 'sub.txt'),
        framesDir: join(dir, 'frames'),
        outChunk:  join(dir, 'out.mp4'),
      }

      // Pull voice (if any) — we need its duration for non-avatar chunks.
      let voiceDuration = seg.voice_duration_secs || 0
      if (seg.voice_url && seg.segment_type !== 'pure_motion_graphics') {
        paths.voice = join(dir, 'voice.mp3')
        await downloadTo(seg.voice_url, paths.voice)
        if (!voiceDuration) voiceDuration = await probeAudioDurationSecs(paths.voice)
      }

      if (seg.segment_type === 'avatar') {
        await downloadTo(seg.avatar_video_url, paths.avatarMp4)
        // Pass voiceDuration so the chunk gets trimmed to an exact
        // length — critical for lip-sync across many chunks.
        await renderAvatarChunk(seg, paths, dim, Math.max(0.5, voiceDuration || 0))
      } else if (seg.segment_type === 'voiceover_broll') {
        await downloadTo(seg.image_url, paths.image)
        await renderBrollChunk(seg, paths, dim, Math.max(2, voiceDuration || 4))
      } else if (seg.segment_type === 'voiceover_motion_graphics' || seg.segment_type === 'pure_motion_graphics') {
        // Try real HyperFrames rendering (Puppeteer screen-capture) first.
        // Falls back to the ffmpeg drawtext stub if Chromium fails for
        // any reason — composition not found, timeline registration
        // timeout, etc. — so the bake never blocks on a single bad
        // composition. We track WHY each fallback fired so the UI can
        // show the user which segments rendered with the full template
        // vs the text stub.
        const wantDuration = seg.segment_type === 'pure_motion_graphics'
          ? 2.5
          : Math.max(2, voiceDuration || 4)
        const hasComp = !!seg.hyperframes_composition_id
        let usedHF = false
        if (hasComp) {
          try {
            await renderHyperFramesChunk(seg, paths, dim, wantDuration, fontPath)
            usedHF = true
            progress.hf_rendered.push(seg.id)
          } catch (e) {
            const reason = e?.message || String(e)
            const launchErr = _browserLaunchErr
            console.warn(`[studio-render] HyperFrames render failed for ${seg.hyperframes_composition_id} on segment ${seg.id}: ${reason}${launchErr ? ` (browser launch err: ${launchErr})` : ''}`)
            progress.hf_fallback.push({
              seg_id: seg.id,
              composition_id: seg.hyperframes_composition_id,
              // Bumped from 240 → 1200 so the diag-JSON survives.
              reason: reason.slice(0, 1200),
              launch_err: launchErr ? launchErr.slice(0, 240) : null,
            })
            await renderMotionChunk(seg, paths, dim, wantDuration, fontPath)
          }
        } else {
          progress.hf_fallback.push({
            seg_id: seg.id,
            composition_id: null,
            reason: 'no composition_id set on segment',
          })
          await renderMotionChunk(seg, paths, dim, wantDuration, fontPath)
        }
      } else {
        continue
      }
      chunkPaths.push(paths.outChunk)
      progress.current = i + 1
      await writeProgress()
    }

    // Concat all chunks via filter_complex re-encode. We intentionally
    // skip the concat-demuxer stream-copy fast path because Studio renders
    // need exact lip-sync across many chunks, and each chunk's container
    // length can be off by a frame or two from where its audio actually
    // ends (a known -shortest quirk). Stream copy preserves those off-by-N
    // durations, which compound: chunk 1 fine, chunk 2 slightly off,
    // chunk 3 worse, etc. — visible as drifting lip-sync after the first
    // segment. Filter_complex re-encodes everything and resets timestamps,
    // eliminating drift at the cost of ~30-60s extra render time.
    progress.stage = 'concat'
    await writeProgress()

    const listFile = join(workdir, 'concat.txt')
    const listText = chunkPaths.map((p) => `file '${p}'`).join('\n') + '\n'
    await writeFile(listFile, listText, 'utf8')
    const finalPath = join(workdir, 'final.mp4')

    const inputs = []
    let filter = ''
    for (let i = 0; i < chunkPaths.length; i++) {
      inputs.push('-i', chunkPaths[i])
      filter += `[${i}:v:0][${i}:a:0]`
    }
    filter += `concat=n=${chunkPaths.length}:v=1:a=1[v][a]`
    await runFFmpeg([
      '-y', ...inputs,
      '-filter_complex', filter,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', finalPath,
    ], 240_000)

    progress.stage = 'upload'
    await writeProgress()

    // Upload to studio-media bucket
    const buf = await readFile(finalPath)
    const path = `${video.profile_id}/studio/final/${videoId}-${Date.now()}.mp4`
    const up = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${STUDIO_BUCKET}/${encodeURI(path)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'video/mp4',
          'x-upsert': 'true',
        },
        body: buf,
      }
    )
    if (!up.ok) {
      const detail = await up.text().catch(() => '')
      throw new Error(`Upload failed (${up.status}): ${detail.slice(0, 300)}`)
    }
    const finalUrl = `${SUPABASE_URL}/storage/v1/object/public/${STUDIO_BUCKET}/${path}`

    // Finalize parent video. Keep render_progress around (with stage='done')
    // so the UI can show "X of Y motion graphics rendered with template, Z
    // fell back" after the render completes, instead of dropping the diag
    // info on success.
    progress.stage = 'done'
    progress.current = segments.length
    await supaFetch(`studio_videos?id=eq.${videoId}`, {
      method: 'PATCH',
      body: {
        status: 'rendered',
        final_video_url: finalUrl,
        error: null,
        render_progress: progress,
      },
      prefer: 'return=minimal',
    })

    return res.status(200).json({
      ok: true,
      final_video_url: finalUrl,
      segments_rendered: chunkPaths.length,
    })
  } catch (err) {
    // Surface error on the parent so the UI can show a retry path.
    if (req.body?.studio_video_id) {
      await supaFetch(`studio_videos?id=eq.${req.body.studio_video_id}`, {
        method: 'PATCH',
        body: { status: 'failed', error: String(err.message || err).slice(0, 1000) },
        prefer: 'return=minimal',
      }).catch(() => {})
    }
    return res.status(err.status || 500).json({ error: err.message })
  } finally {
    // Close any Chrome instance the HyperFrames renderer launched so
    // subsequent invocations on the same warm Lambda don't pile up
    // browser processes / leak memory.
    await closeBrowserSafe()
    if (workdir) {
      await rm(workdir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
