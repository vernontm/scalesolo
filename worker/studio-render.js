// Studio long-form video bake. Mirrors api/studio/render-final.js on
// Vercel — same chunk renderers, same concat strategy, same upload
// destination — but runs on Fly with real Chrome (no @sparticuz/Lambda
// RAF-throttling quirks) and no 5-minute function ceiling.
//
// One handler entry point: runStudioRender({ studio_video_id }).
// Loads everything it needs from Supabase via the service-role key
// the worker already has. Writes render_progress directly. Returns
// when the bake is complete (or throws on terminal failure).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import puppeteer from 'puppeteer'

const ffmpegPath = ffmpegInstaller.path
const __dirname = dirname(fileURLToPath(import.meta.url))
const STUDIO_BUCKET = 'studio-media'

// ── Helpers ─────────────────────────────────────────────────────────────────

function runFFmpeg(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr += d.toString('utf8')
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
    })
    proc.stdout.on('data', () => {})
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

async function probeAudioDurationSecs(path) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-i', path, '-hide_banner', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] })
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

async function downloadTo(url, dest) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Download failed (${r.status}) for ${url.slice(0, 80)}`)
  const buf = Buffer.from(await r.arrayBuffer())
  await writeFile(dest, buf)
  return dest
}

function dimensions(aspect) {
  if (aspect === '9:16') return { w: 1080, h: 1920 }
  if (aspect === '1:1')  return { w: 1080, h: 1080 }
  return { w: 1920, h: 1080 }
}

function safeDrawTextLine(s) {
  // eslint-disable-next-line no-control-regex
  return String(s || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim()
}

function wrapText(text, perLine = 38) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > perLine && cur) {
      lines.push(cur); cur = w
    } else {
      cur = (cur ? cur + ' ' : '') + w
    }
  }
  if (cur) lines.push(cur)
  return lines.slice(0, 6).join('\n')
}

// ── Headless Chrome (real Chrome, not @sparticuz) ──────────────────────────
// Fly's Linux container can run unmodified Chrome from puppeteer's bundle.
// One browser per bake, shared across all motion-graphics chunks.
let _browserPromise = null
async function getBrowser() {
  if (_browserPromise) return _browserPromise
  _browserPromise = puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--hide-scrollbars',
    ],
  })
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

function renderBaseUrl(env) {
  if (env.STUDIO_RENDER_BASE_URL) return env.STUDIO_RENDER_BASE_URL.replace(/\/$/, '')
  // No sensible default outside Vercel — callers should always set this.
  throw new Error('STUDIO_RENDER_BASE_URL not set — worker needs an explicit URL to fetch HyperFrames compositions from (e.g., https://scalesolo.ai or the preview branch alias).')
}

function encodeVarsForUrl(vars) {
  try {
    const json = JSON.stringify(vars || {})
    return encodeURIComponent(Buffer.from(json, 'utf8').toString('base64'))
  } catch { return '' }
}

// ── Font resolution ────────────────────────────────────────────────────────
const FONT_CANDIDATES = [
  'Inter-ExtraBold.ttf',
  'Montserrat-ExtraBold.ttf',
  'Poppins-ExtraBold.ttf',
  'Anton-Regular.ttf',
  'Sans-Bold.ttf',
]
let _fontPathCached = null
async function resolveFont() {
  if (_fontPathCached) return _fontPathCached
  for (const filename of FONT_CANDIDATES) {
    // worker/fonts is where the existing polish pipeline keeps its TTFs.
    for (const dir of ['fonts', '_fonts']) {
      const p = join(__dirname, dir, filename)
      try { await readFile(p); _fontPathCached = p; return p } catch {}
    }
  }
  throw new Error('No bundled font found in worker/fonts/ or worker/_fonts/.')
}

// ── Template fetch (overlay overrides, motion, accent, sfx) ───────────────
// The worker doesn't share an import path with /api code, so we fetch
// the resolved template over HTTP from /api/studio/template-resolved.
// The endpoint also returns the resolved motion + sfx plans so the
// worker doesn't need to bundle resolver code. Cached per-bake — the
// template never changes mid-render.
async function fetchResolvedTemplate(baseUrl, env, templateId, accent) {
  const secret = env.WORKER_SHARED_SECRET
  if (!secret) {
    console.warn('[studio-render] WORKER_SHARED_SECRET not set — overlays + SFX disabled.')
    return null
  }
  if (!templateId) return null
  const url = `${baseUrl}/api/studio/template-resolved?id=${encodeURIComponent(templateId)}` +
              (accent ? `&accent=${encodeURIComponent(accent)}` : '')
  try {
    const r = await fetch(url, { headers: { 'x-worker-secret': secret } })
    if (!r.ok) {
      console.warn(`[studio-render] template fetch returned ${r.status} for ${templateId}; overlays + SFX will be skipped.`)
      return null
    }
    const j = await r.json()
    if (!j.template) return null
    // Stash motion + sfx plans on the template object so the rest of
    // the bake can reach them without a second fetch.
    j.template._motion_plan = j.motion_plan || null
    j.template._sfx_plan = j.sfx_plan || null
    return j.template
  } catch (e) {
    console.warn(`[studio-render] template fetch failed: ${e.message}; overlays + SFX will be skipped.`)
    return null
  }
}

// ── SFX scheduling + mixing ───────────────────────────────────────────────
// Composition-id → standalone event mapping. The HF compositions don't
// yet surface per-frame events to the renderer, so we fire each event
// at a heuristic offset within the segment. Tighten this when the
// composition runtime grows real event emission.
const COMPOSITION_EVENTS = {
  'title-card-v1':    [{ event: 'title_hero',     at_secs: 0.3 }],
  'stat-reveal-v1':   [{ event: 'stat_land',      at_secs: 1.2 }],
  'end-card-v1':      [{ event: 'end_card',       at_secs: 0.2 }],
  'subscribe-cta-v1': [{ event: 'subscribe_cta',  at_secs: 0.2 }],
  'quote-card-v1':    [{ event: 'chapter_change', at_secs: 0.3 }],
  'comparison-v1':    [{ event: 'comparison_after', at_secs: 1.6 }],
  'hook-card-v1':     [{ event: 'title_hero',     at_secs: 0.3 }],
  'chapter-card-v1':  [{ event: 'chapter_change', at_secs: 0.3 }],
}

// Build the SFX cue list. Each cue is { sfx_id, file, volume, at_secs }
// in the FINAL concatenated timeline. v1 covers entrance + transition
// + standalone triggers. Exits + emphasis loops are TODO — exits need
// per-primitive duration lookups, emphasis loops need ffmpeg aloop
// orchestration beyond a single amix.
function buildSfxCues(segments, segmentDurations, sfxPlan) {
  if (!sfxPlan || sfxPlan.density === 'off') return []
  const cues = []
  let cursor = 0  // running offset into the final concat track

  const triggerByEvent = Object.fromEntries(
    (sfxPlan.standalone_triggers || []).map((t) => [t.event, t]),
  )

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const dur = segmentDurations[i] || 0
    const segStart = cursor

    // Entrance — every segment (cap at 0 if first segment so it lands
    // on frame 0; clamp later for negative offsets defensively).
    if (sfxPlan.entrance) {
      cues.push({
        sfx_id: sfxPlan.entrance.sfx_id,
        file:   sfxPlan.entrance.file,
        volume: sfxPlan.entrance.volume,
        at_secs: segStart,
      })
    }

    // Transition — fired between segments (skip on first segment).
    if (i > 0 && sfxPlan.transition) {
      cues.push({
        sfx_id: sfxPlan.transition.sfx_id,
        file:   sfxPlan.transition.file,
        volume: sfxPlan.transition.volume,
        at_secs: segStart,  // same beat as entrance — transition + entrance overlap by design
      })
    }

    // Standalone triggers — composition-driven. If this segment uses a
    // composition the worker knows about, fire its event at the
    // configured offset.
    const compEvents = COMPOSITION_EVENTS[seg.hyperframes_composition_id] || []
    for (const evt of compEvents) {
      const trigger = triggerByEvent[evt.event]
      if (!trigger) continue
      cues.push({
        sfx_id: trigger.sfx_id,
        file:   trigger.file,
        volume: trigger.volume,
        at_secs: segStart + Math.min(evt.at_secs, Math.max(0.1, dur - 0.2)),
        event: evt.event,
      })
    }

    cursor += dur
  }
  return cues
}

// Download every unique SFX file referenced by the cue list. baseUrl
// is the same Vercel base URL the worker uses for compositions —
// /public/sfx/<category>/<id>.mp3 is served as static assets.
async function downloadSfxAssets(cues, baseUrl, bypassSecret, workdir) {
  const sfxDir = join(workdir, 'sfx')
  await mkdir(sfxDir, { recursive: true })
  const seen = new Map()  // sfx_id → local path
  const missing = []

  for (const cue of cues) {
    if (seen.has(cue.sfx_id)) continue
    const url = `${baseUrl}${cue.file}`
    const dest = join(sfxDir, `${cue.sfx_id}.mp3`)
    try {
      const headers = {}
      if (bypassSecret) {
        headers['x-vercel-protection-bypass'] = bypassSecret
        headers['x-vercel-set-bypass-cookie'] = 'samesitenone'
      }
      const r = await fetch(url, { headers })
      if (!r.ok) { missing.push({ sfx_id: cue.sfx_id, status: r.status }); continue }
      const buf = Buffer.from(await r.arrayBuffer())
      await writeFile(dest, buf)
      seen.set(cue.sfx_id, dest)
    } catch (e) {
      missing.push({ sfx_id: cue.sfx_id, reason: e?.message || 'fetch error' })
    }
  }
  return { localPaths: seen, missing }
}

// Mix the SFX cues into the final video's audio track. Builds one
// ffmpeg invocation: video + voice + N sfx inputs, each sfx delayed
// via adelay and volume-scaled per the resolved plan, then amixed
// with the voice. Voice is weighted heavily so SFX don't duck speech.
async function mixSfxIntoFinal(finalIn, finalOut, cues, localPaths, masterVolume) {
  // Filter out cues whose files didn't download
  const usable = cues
    .filter((c) => localPaths.has(c.sfx_id))
    .map((c) => ({ ...c, path: localPaths.get(c.sfx_id) }))
  if (!usable.length) return null

  const inputs = ['-y', '-i', finalIn]
  const filterParts = []
  const mixLabels = ['[0:a]']  // voice from final.mp4 as input #0

  for (let i = 0; i < usable.length; i++) {
    const cue = usable[i]
    const inputIdx = i + 1
    inputs.push('-i', cue.path)
    const delayMs = Math.max(0, Math.round(cue.at_secs * 1000))
    // adelay needs both channels; pad-up to stereo and apply volume.
    // afade ensures the cue ends cleanly without click — short 20ms tail.
    filterParts.push(
      `[${inputIdx}:a]aformat=channel_layouts=stereo,volume=${cue.volume.toFixed(3)},` +
      `adelay=${delayMs}|${delayMs}[s${i}]`,
    )
    mixLabels.push(`[s${i}]`)
  }

  const N = mixLabels.length
  // dropout_transition=0 prevents amix from boosting the voice when
  // SFX cues end. normalize=0 keeps the voice at unity (otherwise amix
  // divides everything by N, which destroys speech audibility).
  const weights = ['4'].concat(usable.map(() => '1')).join(' ')
  filterParts.push(
    `${mixLabels.join('')}amix=inputs=${N}:duration=first:dropout_transition=0:normalize=0:weights=${weights}[mixed]`,
  )

  await runFFmpeg([
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '0:v:0', '-map', '[mixed]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    finalOut,
  ], 300_000)
  return finalOut
}

// ── Overlay layer renderer (transparent PNG sequence) ─────────────────────
// Renders public/studio-compositions/overlay-layer-v1.html at full
// segment dimensions with omitBackground=true so we get an alpha
// channel. Returns the framesDir path. Caller composites it onto the
// base segment chunk.
//
// Skipped when placements is empty — returns null, signal to caller
// that no overlay step is needed.
async function renderOverlayPngs(seg, dir, dim, durationSecs, baseUrl, bypassSecret, template) {
  const placements = Array.isArray(seg.overlay_placements) ? seg.overlay_placements : []
  if (!placements.length) return null
  if (!template) return null

  const orientation = dim.w >= dim.h ? 'landscape' : 'vertical'
  const motion = template.motion || {}
  const overlayOverrides = template.overlay_overrides || {}
  const accent = template.colors?.primary_accent || '#e3151e'

  const vars = {
    placements: JSON.stringify(placements),
    overlay_overrides: JSON.stringify(overlayOverrides),
    orientation,
    accent_color: accent,
    motion_entrance: motion.entrance || 'slide_up_fade',
    motion_exit: motion.exit || 'fade_out',
    motion_emphasis: motion.emphasis || 'pulse_glow',
  }

  const browser = await getBrowser()
  const page = await browser.newPage()
  page.on('pageerror', (err) => console.warn(`[overlay-page] ${err.message}`))
  page.on('requestfailed', (req) => {
    console.warn(`[overlay-page] requestfailed ${req.url()}: ${req.failure()?.errorText || 'unknown'}`)
  })

  if (bypassSecret) {
    await page.setExtraHTTPHeaders({
      'x-vercel-protection-bypass': bypassSecret,
      'x-vercel-set-bypass-cookie': 'samesitenone',
    })
  }

  try {
    await page.setViewport({ width: dim.w, height: dim.h, deviceScaleFactor: 1 })
    const varsHash = encodeVarsForUrl(vars)
    const url = `${baseUrl}/studio-compositions/overlay-layer-v1.html?mode=render#vars=${varsHash}`
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 })

    // Same in-page poll as renderHyperFramesChunk — wait for the
    // overlay-layer's timeline to register, which only happens after
    // renderOverlayLayer() has injected the DOM.
    const ready = await page.evaluate(async () => {
      const start = Date.now()
      while (Date.now() - start < 10_000) {
        if (window.__timelines && window.__timelines['overlay-layer-v1']) return true
        await new Promise((r) => setTimeout(r, 60))
      }
      return false
    })
    if (!ready) {
      console.warn(`[studio-render] overlay timeline never registered for seg ${seg.id}; skipping overlay step.`)
      return null
    }

    const fps = 30
    const totalFrames = Math.ceil(Math.max(0.5, durationSecs) * fps)
    const framesDir = join(dir, 'overlay-frames')
    await mkdir(framesDir, { recursive: true })

    // CSS animation handles the actual motion — we just need to capture
    // frames at the right rate. Seek to time t for each frame so the
    // first 500ms of slide_up_fade is properly captured.
    for (let i = 0; i < totalFrames; i++) {
      const tInSegment = i / fps
      // The overlay layer uses pure CSS animations, not GSAP timelines.
      // CSS animation-delay is computed at element-create time and
      // advances with real wall-clock time. To capture deterministic
      // frames we use page.evaluate to set the timeline progress on
      // the placeholder GSAP timeline (forces a tick) AND set the CSS
      // animationPlayState to 'paused' after seeking. Simpler approach:
      // freeze animations at element creation by setting playState to
      // paused, then advance via animation-delay manipulation.
      await page.evaluate((time) => {
        const cards = document.querySelectorAll('.ov > *')
        cards.forEach((card) => {
          card.style.animationDelay = `-${time}s`
          card.style.animationPlayState = 'paused'
        })
      }, tInSegment)

      const framePath = join(framesDir, `frame-${String(i).padStart(5, '0')}.png`)
      // omitBackground=true gives us the alpha channel we need to
      // composite over the avatar/b-roll base chunk.
      await page.screenshot({ path: framePath, type: 'png', omitBackground: true })
    }

    return framesDir
  } finally {
    await page.close().catch(() => {})
  }
}

// Composite an overlay PNG sequence onto an existing chunk. Re-encodes
// — there's no lossless way to overlay alpha onto an MP4 in place.
async function compositeOverlayOntoChunk(baseMp4, overlayFramesDir, durationSecs, outMp4) {
  const fps = 30
  await runFFmpeg([
    '-y',
    '-i', baseMp4,
    '-framerate', String(fps),
    '-i', join(overlayFramesDir, 'frame-%05d.png'),
    '-filter_complex', '[0:v][1:v]overlay=0:0:shortest=1[v]',
    '-map', '[v]',
    '-map', '0:a:0',
    '-t', String(durationSecs.toFixed(3)),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'copy',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outMp4,
  ], 120_000)
  return outMp4
}

// ── HyperFrames composition renderer (Puppeteer + frame capture) ──────────
async function renderHyperFramesChunk(seg, paths, dim, durationSecs, baseUrl, bypassSecret) {
  const browser = await getBrowser()
  const page = await browser.newPage()
  const pageLogs = []
  const pageErrors = []
  page.on('console', (msg) => pageLogs.push(`[${msg.type()}] ${msg.text()}`))
  page.on('pageerror', (err) => pageErrors.push(err.message))
  page.on('requestfailed', (req) => {
    pageErrors.push(`requestfailed ${req.url()}: ${req.failure()?.errorText || 'unknown'}`)
  })

  // If the composition source is behind Vercel SSO (preview deployments),
  // pass the bypass header so Chrome can fetch the HTML.
  if (bypassSecret) {
    await page.setExtraHTTPHeaders({
      'x-vercel-protection-bypass': bypassSecret,
      'x-vercel-set-bypass-cookie': 'samesitenone',
    })
  }

  try {
    await page.setViewport({ width: dim.w, height: dim.h, deviceScaleFactor: 1 })

    const compId = seg.hyperframes_composition_id
    const varsHash = encodeVarsForUrl(seg.hyperframes_variables || {})
    const url = `${baseUrl}/studio-compositions/${compId}.html?mode=render#vars=${varsHash}`
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 })

    // In-page poll — same pattern as the Vercel version. Real Chrome on
    // Fly doesn't throttle setTimeout for the active page, so this
    // returns almost immediately in the common case (timeline already
    // registered when load fired).
    const ready = await Promise.race([
      page.evaluate(async (id) => {
        const start = Date.now()
        while (Date.now() - start < 15000) {
          if (window.__timelines && window.__timelines[id]) return true
          await new Promise((r) => setTimeout(r, 80))
        }
        return false
      }, compId),
      new Promise((_, rej) => setTimeout(() => rej(new Error('page.evaluate hung')), 20000)),
    ])
    if (!ready) {
      const diag = await page.evaluate(() => ({
        url: location.href,
        gsap_loaded: typeof window.gsap !== 'undefined',
        studio_mode: window.__studioMode,
        studio_play_defined: typeof window.studioPlay === 'function',
        timelines_keys: window.__timelines ? Object.keys(window.__timelines) : null,
        script_count: document.querySelectorAll('script').length,
      })).catch(() => ({}))
      throw new Error(`HyperFrames timeline never registered: ${JSON.stringify({ diag, page_errors: pageErrors.slice(-5) })}`)
    }

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
      const tInSegment = i / fps
      const tInTimeline = tlDur > 0 ? Math.min(tInSegment, tlDur) : tInSegment
      await page.evaluate((id, time) => {
        const tl = window.__timelines[id]
        if (tl?.seek) tl.seek(time, false)
      }, compId, tInTimeline)
      const framePath = join(framesDir, `frame-${String(i).padStart(5, '0')}.png`)
      await page.screenshot({ path: framePath, type: 'png', omitBackground: false })
    }

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

    const outFile = paths.outChunk
    const args = ['-y', '-i', videoOnly]
    if (paths.voice) args.push('-i', paths.voice)
    args.push('-t', String(captureDur.toFixed(3)), '-map', '0:v:0')
    if (paths.voice) args.push('-map', '1:a:0')
    else args.push('-f', 'lavfi', '-t', String(captureDur.toFixed(3)),
                   '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
                   '-map', '2:a:0')
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

// ── Per-segment chunk renderers (mirror render-final.js) ───────────────────
async function renderAvatarChunk(seg, paths, dim, durationSecs) {
  const outFile = paths.outChunk
  const trim = durationSecs > 0 ? durationSecs : 6
  const args = ['-y', '-i', paths.avatarMp4]
  if (paths.voice) args.push('-i', paths.voice)
  args.push('-t', String(trim.toFixed(3)),
    '-vf', `scale=${dim.w}:${dim.h}:force_original_aspect_ratio=increase,crop=${dim.w}:${dim.h}`,
    '-r', '30', '-map', '0:v:0')
  if (paths.voice) args.push('-map', '1:a:0')
  else args.push('-f', 'lavfi', '-t', String(trim.toFixed(3)),
                 '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-map', '2:a:0')
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
  const outFile = paths.outChunk
  const dur = durationSecs.toFixed(3)
  const totalFrames = Math.max(30, Math.ceil(durationSecs * 30))
  const ZOOM_MAX = 0.12
  const prepW = Math.round(dim.w * 1.3)
  const prepH = Math.round(dim.h * 1.3)
  const vf = [
    `scale=${prepW}:${prepH}:force_original_aspect_ratio=increase`,
    `crop=${prepW}:${prepH}`,
    `fps=30`,
    `zoompan=z='1+${ZOOM_MAX}*on/${totalFrames}':d=1:s=${dim.w}x${dim.h}:fps=30:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
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
  const v = seg.hyperframes_variables || {}
  const headline = v.title || v.quote || v.stat_number || seg.script_text || ''
  const sub = v.subtitle || v.stat_label || v.attribution || v.cta || ''
  const wrapped = wrapText(safeDrawTextLine(headline), 32)
  const subWrapped = wrapText(safeDrawTextLine(sub), 48)
  await writeFile(paths.textHead, wrapped, 'utf8')
  await writeFile(paths.textSub, subWrapped, 'utf8')
  const inputs = ['-y', '-f', 'lavfi', '-t', String(durationSecs.toFixed(3)),
                  '-i', `color=c=#0a0a0c:s=${dim.w}x${dim.h}:r=30`]
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
    ...inputs, '-vf', filter,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
  ]
  if (paths.voice) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-shortest')
  } else {
    args.push('-f', 'lavfi', '-t', String(durationSecs.toFixed(3)),
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-c:a', 'aac', '-b:a', '128k')
  }
  args.push('-movflags', '+faststart', paths.outChunk)
  await runFFmpeg(args, 90_000)
  return paths.outChunk
}

// ── Main entry point ──────────────────────────────────────────────────────
export async function runStudioRender({ supabase, env, studio_video_id }) {
  // 1. Load video + segments
  const { data: video, error: vErr } = await supabase
    .from('studio_videos').select('*').eq('id', studio_video_id).single()
  if (vErr) throw new Error(`Load video failed: ${vErr.message}`)
  if (!video) throw new Error('Video not found')

  const { data: segments, error: sErr } = await supabase
    .from('studio_segments').select('*').eq('studio_video_id', studio_video_id)
    .eq('approved', true).order('segment_index', { ascending: true }).limit(500)
  if (sErr) throw new Error(`Load segments failed: ${sErr.message}`)
  if (!segments?.length) throw new Error('No approved segments to render')

  // 2. Block on missing assets
  const blocking = segments.filter((s) => {
    if (s.segment_type === 'pure_motion_graphics') return false
    if (s.status === 'error') return true
    if (!s.voice_url) return true
    if (s.segment_type === 'voiceover_broll' && !s.image_url) return true
    if (s.segment_type === 'avatar' && !s.avatar_video_url) return true
    return false
  })
  if (blocking.length) {
    throw new Error(`${blocking.length} segment(s) still missing assets`)
  }

  const baseUrl = renderBaseUrl(env)
  const bypassSecret = env.VERCEL_AUTOMATION_BYPASS_SECRET || null

  // 2.5. Fetch resolved template once. Carries overlay_overrides + motion
  // + accent that the overlay-layer composition needs. Null is fine —
  // overlays will be skipped and the bake proceeds without them.
  const resolvedTemplate = await fetchResolvedTemplate(
    baseUrl, env, video.template_id, video.brand_color,
  )

  // 3. Initial progress write
  const progress = {
    stage: 'baking', current: 0, total: segments.length,
    started_at: new Date().toISOString(),
    hf_rendered: [], hf_fallback: [],
    overlay_rendered: [], overlay_skipped: [],
  }
  await supabase.from('studio_videos')
    .update({ status: 'rendering', error: null, render_progress: progress })
    .eq('id', studio_video_id)

  const writeProgress = async () => {
    await supabase.from('studio_videos')
      .update({ render_progress: progress })
      .eq('id', studio_video_id)
      .then(() => {}, () => {}) // best-effort
  }

  const workdir = await mkdtemp(join(tmpdir(), `studio-render-${studio_video_id.slice(0, 8)}-`))
  const dim = dimensions(video.aspect_ratio)
  const fontPath = await resolveFont()
  const chunkPaths = []
  // Parallel array — duration of each rendered chunk. Used to schedule
  // SFX cues at the right offset into the final concat track.
  const chunkDurations = []
  // Parallel array — segment row that produced each chunk. Used to
  // resolve composition-based standalone SFX triggers.
  const chunkSegments = []

  try {
    // 4. Render each segment to an intermediate MP4
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

      let voiceDuration = seg.voice_duration_secs || 0
      if (seg.voice_url && seg.segment_type !== 'pure_motion_graphics') {
        paths.voice = join(dir, 'voice.mp3')
        await downloadTo(seg.voice_url, paths.voice)
        if (!voiceDuration) voiceDuration = await probeAudioDurationSecs(paths.voice)
      }

      if (seg.segment_type === 'avatar') {
        await downloadTo(seg.avatar_video_url, paths.avatarMp4)
        await renderAvatarChunk(seg, paths, dim, Math.max(0.5, voiceDuration || 0))
      } else if (seg.segment_type === 'voiceover_broll') {
        await downloadTo(seg.image_url, paths.image)
        await renderBrollChunk(seg, paths, dim, Math.max(2, voiceDuration || 4))
      } else if (seg.segment_type === 'voiceover_motion_graphics' || seg.segment_type === 'pure_motion_graphics') {
        const wantDuration = seg.segment_type === 'pure_motion_graphics' ? 2.5 : Math.max(2, voiceDuration || 4)
        if (seg.hyperframes_composition_id) {
          try {
            await renderHyperFramesChunk(seg, paths, dim, wantDuration, baseUrl, bypassSecret)
            progress.hf_rendered.push(seg.id)
          } catch (e) {
            const reason = e?.message || String(e)
            console.warn(`[studio-render] HF render failed for ${seg.hyperframes_composition_id}: ${reason}`)
            progress.hf_fallback.push({
              seg_id: seg.id,
              composition_id: seg.hyperframes_composition_id,
              reason: reason.slice(0, 1200),
            })
            await renderMotionChunk(seg, paths, dim, wantDuration, fontPath)
          }
        } else {
          progress.hf_fallback.push({ seg_id: seg.id, composition_id: null, reason: 'no composition_id' })
          await renderMotionChunk(seg, paths, dim, wantDuration, fontPath)
        }
      } else {
        continue
      }

      // ── Overlay layer composite (avatar + broll only) ───────────────
      // Overlays ride ON TOP of speaker footage. They're a no-op for
      // pure_motion_graphics and full-screen HF compositions (those are
      // already self-contained). Skipped silently when:
      //   - the segment has no overlay_placements, OR
      //   - the template fetch failed (resolvedTemplate is null), OR
      //   - the segment type isn't avatar / voiceover_broll.
      const overlaysEligible = seg.segment_type === 'avatar' || seg.segment_type === 'voiceover_broll'
      const overlayDuration = seg.segment_type === 'avatar'
        ? Math.max(0.5, voiceDuration || 0)
        : Math.max(2, voiceDuration || 4)
      if (overlaysEligible && resolvedTemplate && Array.isArray(seg.overlay_placements) && seg.overlay_placements.length) {
        try {
          const overlayFramesDir = await renderOverlayPngs(
            seg, dir, dim, overlayDuration, baseUrl, bypassSecret, resolvedTemplate,
          )
          if (overlayFramesDir) {
            const composited = join(dir, 'out-with-overlay.mp4')
            await compositeOverlayOntoChunk(paths.outChunk, overlayFramesDir, overlayDuration, composited)
            paths.outChunk = composited
            progress.overlay_rendered.push({ seg_id: seg.id, n: seg.overlay_placements.length })
          } else {
            progress.overlay_skipped.push({ seg_id: seg.id, reason: 'no_frames_dir' })
          }
        } catch (e) {
          // Overlay failure must NOT break the bake. Log it, surface it
          // in render_progress, and ship the base chunk as-is.
          const reason = (e?.message || String(e)).slice(0, 800)
          console.warn(`[studio-render] overlay composite failed for seg ${seg.id}: ${reason}`)
          progress.overlay_skipped.push({ seg_id: seg.id, reason })
        }
      }

      chunkPaths.push(paths.outChunk)
      // Probe the chunk so we know its exact post-encode duration for
      // SFX scheduling. ffprobe via audio-duration probe works for
      // both MP4-with-audio and MP4-with-silent-audio.
      const probedDur = await probeAudioDurationSecs(paths.outChunk)
      chunkDurations.push(probedDur || (seg.segment_type === 'avatar' ? Math.max(0.5, voiceDuration || 0) : (voiceDuration || 4)))
      chunkSegments.push(seg)
      progress.current = i + 1
      await writeProgress()
    }

    // 5. Concat all chunks via filter_complex
    progress.stage = 'concat'
    await writeProgress()
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
    ], 300_000)

    // 5.5. SFX mix pass. Schedules entrance + transition + composition-
    // driven standalone triggers onto the final concat track. v1 skips
    // exits and looping emphasis primitives — see buildSfxCues() doc.
    // Any failure here is recoverable: we ship the voice-only finalPath
    // and surface the reason in progress.sfx_skipped.
    let deliveredPath = finalPath
    const sfxPlan = resolvedTemplate?._sfx_plan
    if (sfxPlan && sfxPlan.density !== 'off') {
      try {
        progress.stage = 'sfx_mix'
        await writeProgress()
        const cues = buildSfxCues(chunkSegments, chunkDurations, sfxPlan)
        if (cues.length) {
          const { localPaths, missing } = await downloadSfxAssets(cues, baseUrl, bypassSecret, workdir)
          if (missing.length) {
            console.warn(`[studio-render] ${missing.length} SFX file(s) missing — they'll be silent in the mix:`,
              missing.map((m) => m.sfx_id).join(', '))
            progress.sfx_missing = missing
          }
          if (localPaths.size) {
            const mixedPath = join(workdir, 'final-mixed.mp4')
            await mixSfxIntoFinal(finalPath, mixedPath, cues, localPaths, sfxPlan.master_volume)
            deliveredPath = mixedPath
            progress.sfx_mixed = { cues: cues.length, sounds_used: localPaths.size }
          } else {
            progress.sfx_skipped = { reason: 'no_sfx_files_available', missing: missing.length }
          }
        } else {
          progress.sfx_skipped = { reason: 'no_cues_scheduled' }
        }
      } catch (e) {
        const reason = (e?.message || String(e)).slice(0, 800)
        console.warn(`[studio-render] SFX mix failed: ${reason}`)
        progress.sfx_skipped = { reason }
        deliveredPath = finalPath  // fall back to voice-only track
      }
    }

    // 6. Upload via supabase storage
    progress.stage = 'upload'
    await writeProgress()
    const buf = await readFile(deliveredPath)
    const path = `${video.profile_id}/studio/final/${studio_video_id}-${Date.now()}.mp4`
    const { error: upErr } = await supabase.storage.from(STUDIO_BUCKET)
      .upload(path, buf, { contentType: 'video/mp4', upsert: true })
    if (upErr) throw new Error(`Upload failed: ${upErr.message}`)
    const { data: pub } = supabase.storage.from(STUDIO_BUCKET).getPublicUrl(path)
    const finalUrl = pub.publicUrl

    // 7. Finalize
    progress.stage = 'done'
    progress.current = segments.length
    await supabase.from('studio_videos').update({
      status: 'rendered',
      final_video_url: finalUrl,
      error: null,
      render_progress: progress,
    }).eq('id', studio_video_id)

    return {
      ok: true,
      final_video_url: finalUrl,
      hf_rendered: progress.hf_rendered.length,
      hf_fallback: progress.hf_fallback.length,
      overlay_rendered: progress.overlay_rendered.length,
      overlay_skipped: progress.overlay_skipped.length,
      sfx_mixed: progress.sfx_mixed || null,
      sfx_skipped: progress.sfx_skipped || null,
      sfx_missing: progress.sfx_missing?.length || 0,
    }
  } finally {
    await closeBrowserSafe()
    await rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
}
