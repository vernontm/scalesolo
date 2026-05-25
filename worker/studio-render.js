// Studio long-form video bake. Mirrors api/studio/render-final.js on
// Vercel — same chunk renderers, same concat strategy, same upload
// destination — but runs on Fly with real Chrome (no @sparticuz/Lambda
// RAF-throttling quirks) and no 5-minute function ceiling.
//
// One handler entry point: runStudioRender({ studio_video_id }).
// Loads everything it needs from Supabase via the service-role key
// the worker already has. Writes render_progress directly. Returns
// when the bake is complete (or throws on terminal failure).

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import puppeteer from 'puppeteer'

// Mirror of DEFAULT_TRANSITION_POOL in api/studio/_lib/motion-primitives.js.
// Worker container doesn't ship the api/ dir so we inline. Keep both in
// sync. Six entries: hard cut, four directional swipes, and the
// light-flare-wipe-fast warm whiteout for variety.
const DEFAULT_TRANSITION_POOL = [
  'swipe_right',
  'swipe_left',
  'swipe_up',
  'swipe_down',
  'cut_transition',
  'light_flare_wipe_fast',
]

// Deterministic djb2 hash pick. Re-renders of the same video produce
// the same transition sequence; different videos cycle different combos.
function pickTransitionForBoundary(seed, idx, pool = DEFAULT_TRANSITION_POOL) {
  if (!Array.isArray(pool) || pool.length === 0) return null
  const key = `${seed || ''}:${idx}`
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0
  return pool[h % pool.length]
}

// Prefer the system-installed ffmpeg over the bundled @ffmpeg-installer
// when available. The bundled one ships ffmpeg 4.0 from 2018 and is
// missing critical filters (xfade, amix normalize=0, acrossfade). On
// Fly the Dockerfile apt-installs modern ffmpeg and sets FFMPEG_PATH;
// locally / on Vercel we fall back to the bundled binary.
const ffmpegPath = process.env.FFMPEG_PATH || ffmpegInstaller.path
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
  // Vercel SSO Deployment Protection sits in front of preview / non-
  // production deployments and rejects requests with a 401 + HTML auth
  // page BEFORE our endpoint sees them. We bypass via the same headers
  // renderHyperFramesChunk + renderOverlayPngs use. Without this the
  // worker can never call template-resolved on preview branches, and
  // overlays + SFX silently disable.
  const headers = { 'x-worker-secret': secret }
  const bypassSecret = env.VERCEL_AUTOMATION_BYPASS_SECRET
  if (bypassSecret) {
    headers['x-vercel-protection-bypass'] = bypassSecret
    // NOTE: do NOT send x-vercel-set-bypass-cookie here. With that
    // header, Vercel returns 307 + Set-Cookie expecting the client
    // to follow the redirect and use the cookie on subsequent
    // requests. Browsers handle that flow. Node's fetch with
    // redirect:'manual' bails on the 307 instead, and Vercel never
    // sees the bypass on the followed-up request. For one-off API
    // calls without a session, omit the cookie header and Vercel
    // returns 200 directly on the first hit.
  }
  try {
    const r = await fetch(url, { headers, redirect: 'manual' })
    if (r.status >= 300 && r.status < 400) {
      console.warn(`[studio-render] template fetch got redirect ${r.status} for ${templateId}. ` +
        `Likely VERCEL_AUTOMATION_BYPASS_SECRET does not match Vercel's Protection Bypass token. ` +
        `Get the token from Vercel → Settings → Deployment Protection → Protection Bypass for Automation, ` +
        `then: fly secrets set VERCEL_AUTOMATION_BYPASS_SECRET=<token> -a scalesolo-worker`)
      return null
    }
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
  // Sleek v2 — three full-screen scenes. Each one calls recordEvent
  // inside its script for precise timing; this table is the heuristic
  // fallback when the runtime didn't emit anything (e.g. older bake).
  'sleek-scene-headline-v1':    [{ event: 'title_hero',     at_secs: 0.5 }],
  'sleek-scene-list-v1':        [{ event: 'chapter_change', at_secs: 0.4 }],
  'sleek-scene-claude-chat-v1': [{ event: 'title_hero',     at_secs: 0.9 }],
  'sleek-scene-cta-v1':         [
    { event: 'end_card',      at_secs: 0.3 },
    { event: 'subscribe_cta', at_secs: 1.1 },
  ],
  // Atlas — similar beat structure, slightly later landings since
  // highlight_sweep takes 2s vs Sleek's 0.6s slide-up-fade.
  'atlas-scene-headline-v1':    [{ event: 'title_hero',     at_secs: 0.6 }],
  'atlas-scene-list-v1':        [{ event: 'chapter_change', at_secs: 0.5 }],
  'atlas-scene-claude-chat-v1': [{ event: 'title_hero',     at_secs: 1.0 }],
  'atlas-scene-cta-v1':         [
    { event: 'end_card',      at_secs: 0.3 },
    { event: 'subscribe_cta', at_secs: 1.2 },
  ],
}

// Build the SFX cue list. Each cue is { sfx_id, file, volume, at_secs,
// kind: 'oneshot' | 'loop', loop_until_secs? } in the FINAL concatenated
// timeline.
//
// Layers scheduled when active in the density gate:
//   - entrance   (oneshot at segment start)
//   - exit       (oneshot at segment_end - exit_duration_ms)
//   - transition (oneshot at segment_start, skipped on segment 0)
//   - emphasis   (LOOP for the full segment duration with a 200ms fade
//                 tail at the end so it doesn't pop on cut)
//   - standalone (oneshot at composition-event timing, overridden by
//                 per-segment composition_events if the HF runtime
//                 emitted any)
// transitionOverlapSecs can be a number (uniform overlap across all
// boundaries — legacy behavior) or an array where index i is the
// overlap at the boundary BETWEEN segment i and i+1. Per-boundary mode
// is used when the random transition pool produces a different xfade
// duration per boundary.
function buildSfxCues(segments, segmentDurations, sfxPlan, compositionEventLog = {}, motionPlan = null, transitionOverlapSecs = 0) {
  if (!sfxPlan || sfxPlan.density === 'off') return []
  const cues = []
  let cursor = 0

  const triggerByEvent = Object.fromEntries(
    (sfxPlan.standalone_triggers || []).map((t) => [t.event, t]),
  )

  // Pull per-primitive durations off the resolved motion plan. The
  // exit primitive's duration_ms tells us where to slot the exit SFX.
  // Falls back to a sensible default if motion plan wasn't returned.
  const exitDurationMs = motionPlan?.resolved?.exit?.spec?.duration_ms ?? 400

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const dur = segmentDurations[i] || 0
    const segStart = cursor
    const segEnd = segStart + dur

    // Entrance
    if (sfxPlan.entrance) {
      cues.push({
        kind: 'oneshot',
        sfx_id: sfxPlan.entrance.sfx_id,
        file:   sfxPlan.entrance.file,
        volume: sfxPlan.entrance.volume,
        at_secs: segStart,
      })
    }

    // Exit — lands at segment_end - exit_primitive_duration so the
    // sound finishes right as the segment cuts. Clamp to mid-segment
    // if the segment is shorter than the exit duration (very short
    // stinger segments). Skip on the last segment — the video ends
    // there, no exit cue needed.
    if (sfxPlan.exit && i < segments.length - 1) {
      const exitDurationSecs = exitDurationMs / 1000
      const exitAt = Math.max(segStart + dur * 0.5, segEnd - exitDurationSecs)
      cues.push({
        kind: 'oneshot',
        sfx_id: sfxPlan.exit.sfx_id,
        file:   sfxPlan.exit.file,
        volume: sfxPlan.exit.volume,
        at_secs: exitAt,
      })
    }

    // Transition (overlaps with the next segment's entrance — by design)
    if (i > 0 && sfxPlan.transition) {
      cues.push({
        kind: 'oneshot',
        sfx_id: sfxPlan.transition.sfx_id,
        file:   sfxPlan.transition.file,
        volume: sfxPlan.transition.volume,
        at_secs: segStart,
      })
    }

    // Emphasis — loops for the whole segment with a 200ms fade tail at
    // the end. Only scheduled when density is 'high' (the gate handles
    // this — sfxPlan.emphasis is null otherwise).
    if (sfxPlan.emphasis && dur > 0.4) {
      cues.push({
        kind: 'loop',
        sfx_id: sfxPlan.emphasis.sfx_id,
        file:   sfxPlan.emphasis.file,
        // Emphasis loops sit beneath everything — drop a bit so they
        // don't add up across segment boundaries when two emphasis
        // tracks overlap during the transition window.
        volume: sfxPlan.emphasis.volume * 0.7,
        at_secs: segStart,
        loop_until_secs: segEnd,
      })
    }

    // Standalone triggers. Prefer real composition-emitted events from
    // the HF runtime (compositionEventLog[seg.id] = [{event, at_secs}]).
    // Fall back to the heuristic COMPOSITION_EVENTS table when the
    // composition didn't emit any.
    const realEvents = compositionEventLog[seg.id]
    const events = (realEvents && realEvents.length)
      ? realEvents
      : (COMPOSITION_EVENTS[seg.hyperframes_composition_id] || [])
    for (const evt of events) {
      const trigger = triggerByEvent[evt.event]
      if (!trigger) continue
      const tInSegment = Math.min(evt.at_secs, Math.max(0.1, dur - 0.2))
      cues.push({
        kind: 'oneshot',
        sfx_id: trigger.sfx_id,
        file:   trigger.file,
        volume: trigger.volume,
        at_secs: segStart + tInSegment,
        event: evt.event,
      })
    }

    // Advance cursor by this segment's duration, minus the overlap
    // that the xfade crossfade will eat off the next segment. With
    // overlap=0 this is identity (hard-cut concat). With overlap>0
    // SFX cues for subsequent segments land at the correct visual
    // position on the final track. Supports both scalar (uniform) and
    // array (per-boundary) overlap.
    let boundaryOverlap = 0
    if (i < segments.length - 1) {
      boundaryOverlap = Array.isArray(transitionOverlapSecs)
        ? (transitionOverlapSecs[i] || 0)
        : transitionOverlapSecs
    }
    cursor += dur - boundaryOverlap
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
        // No x-vercel-set-bypass-cookie — see fetchResolvedTemplate.
      }
      const r = await fetch(url, { headers, redirect: 'manual' })
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

    if (cue.kind === 'loop') {
      // Emphasis loop: aloop=-1 repeats the source indefinitely, then
      // atrim+asetpts clips it to the desired length, afade adds a
      // 200ms tail so the loop doesn't pop on cut, adelay positions
      // it on the master timeline.
      const lengthSecs = Math.max(0.4, cue.loop_until_secs - cue.at_secs)
      const fadeStart = Math.max(0, lengthSecs - 0.2)
      // aloop's `size` is samples, not seconds; -1 size means "use the
      // whole input". We feed it the small static loop file and trim
      // the result. Sample-rate is normalized to 48k via aformat.
      filterParts.push(
        `[${inputIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,` +
        `aloop=loop=-1:size=2147483647,` +
        `atrim=0:${lengthSecs.toFixed(3)},asetpts=N/SR/TB,` +
        `volume=${cue.volume.toFixed(3)},` +
        `afade=t=out:st=${fadeStart.toFixed(3)}:d=0.2,` +
        `adelay=${delayMs}|${delayMs}[s${i}]`,
      )
    } else {
      // Oneshot: pad-up to stereo, volume, delay onto master timeline.
      filterParts.push(
        `[${inputIdx}:a]aformat=channel_layouts=stereo,volume=${cue.volume.toFixed(3)},` +
        `adelay=${delayMs}|${delayMs}[s${i}]`,
      )
    }
    mixLabels.push(`[s${i}]`)
  }

  const N = mixLabels.length
  // amix on modern ffmpeg (5.0+): normalize=0 keeps each input at its
  // own volume instead of dividing by N. Weight 4 on voice + 1 on
  // each SFX → voice plays at unity, SFX play at cue.volume.
  // dropout_transition=0 prevents amix from boosting voice when SFX
  // cues end.
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

    // Harvest composition-emitted event log. Compositions call
    // window.__hyperframes.recordEvent(name, at_secs) at top-of-script
    // to declare when key beats fire — see public/studio-compositions/
    // _runtime.js for the API. Stashed on the seg object so buildSfxCues
    // can read them later.
    const recordedEvents = await page.evaluate((id) => {
      return (window.__hyperframes && window.__hyperframes.getEvents)
        ? window.__hyperframes.getEvents(id)
        : []
    }, compId).catch(() => [])
    seg._hyperframes_events = Array.isArray(recordedEvents) ? recordedEvents : []

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

      // ── Overlay layer composite ──────────────────────────────────────
      // Overlays ride ON TOP of any voiceover segment — avatar +
      // voiceover_broll + voiceover_motion_graphics. The motion-graphics
      // case is captions-only by the enrichment policy, but the worker
      // doesn't enforce that — it just composites whatever placements
      // exist on the segment. pure_motion_graphics + segments with empty
      // placements are no-ops. Skipped silently when the template fetch
      // failed (resolvedTemplate is null).
      const overlaysEligible = seg.segment_type === 'avatar'
        || seg.segment_type === 'voiceover_broll'
        || seg.segment_type === 'voiceover_motion_graphics'
      const overlayDuration = seg.segment_type === 'avatar'
        ? Math.max(0.5, voiceDuration || 0)
        : Math.max(2, voiceDuration || 4)
      // B-roll segments are visually busy already — overlays compete
      // with the generated image and clutter the frame. Per product
      // direction, only captions are allowed on voiceover_broll. Strip
      // everything else here so neither the renderer nor downstream
      // motion picks them up.
      let effectivePlacements = Array.isArray(seg.overlay_placements) ? seg.overlay_placements : []
      if (seg.segment_type === 'voiceover_broll') {
        effectivePlacements = effectivePlacements.filter((p) => p?.overlay_id === 'caption-overlay-v1')
      }
      if (overlaysEligible && resolvedTemplate && effectivePlacements.length) {
        try {
          // Hand the renderer a seg with the filtered list so it
          // doesn't see the stripped placements.
          const segForOverlays = { ...seg, overlay_placements: effectivePlacements }
          const overlayFramesDir = await renderOverlayPngs(
            segForOverlays, dir, dim, overlayDuration, baseUrl, bypassSecret, resolvedTemplate,
          )
          if (overlayFramesDir) {
            const composited = join(dir, 'out-with-overlay.mp4')
            await compositeOverlayOntoChunk(paths.outChunk, overlayFramesDir, overlayDuration, composited)
            paths.outChunk = composited
            progress.overlay_rendered.push({ seg_id: seg.id, n: effectivePlacements.length })
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

      // Free /tmp aggressively. PNG sequences and intermediate files
      // pile up fast (each HF chunk = ~150 PNGs × 8MB = ~1.2GB), and
      // /tmp is tmpfs-backed on Fly so it counts against RAM. Without
      // this, a 24-segment bake hits the 8GB ceiling and the OOM
      // killer reaps the worker mid-bake. Keep only paths.outChunk
      // (needed for concat) — drop everything else.
      const keepFiles = new Set([paths.outChunk])
      try {
        const dirEntries = await readdir(dir, { withFileTypes: true })
        for (const entry of dirEntries) {
          const full = join(dir, entry.name)
          if (keepFiles.has(full)) continue
          await rm(full, { recursive: true, force: true })
        }
      } catch (e) {
        console.warn(`[studio-render] tmp cleanup failed for seg ${seg.id}: ${e.message}`)
      }

      progress.current = i + 1
      await writeProgress()
    }

    // 5. Concat all chunks with optional crossfade between segments.
    //
    // For fade_transition (Sleek default — 600ms crossfade), we build
    // an xfade chain instead of straight concat. Result: every cut
    // between segments dissolves over 0.6s. For cut_transition (and
    // when we can't read transition primitive), fall back to straight
    // concat — hard cut.
    progress.stage = 'concat'
    await writeProgress()
    const finalPath = join(workdir, 'final.mp4')

    // Map of transition primitive → { ffmpeg_xfade_name, duration_secs }.
    // Only entries listed here use xfade; everything else stays hard cut.
    const XFADE_MAP = {
      fade_transition:       { name: 'fade',       duration: 0.6 },
      dissolve_slow:         { name: 'dissolve',   duration: 1.2 },
      wipe_right:            { name: 'wiperight',  duration: 0.5 },
      zoom_in:               { name: 'zoomin',     duration: 0.6 },
      dip_to_black:          { name: 'fadeblack',  duration: 1.0 },
      // Swipes — ffmpeg's xfade slide* names: "slideleft" = next slides
      // in from the right pushing current to the left, etc. So our
      // semantic "swipe_right" (current exits right, next enters from
      // left) maps to ffmpeg "slideright".
      swipe_right:           { name: 'slideright', duration: 0.8 },
      swipe_left:            { name: 'slideleft',  duration: 0.8 },
      swipe_up:              { name: 'slideup',    duration: 0.8 },
      swipe_down:            { name: 'slidedown',  duration: 0.8 },
      swipe_right_fast:      { name: 'slideright', duration: 0.5 },
      swipe_left_fast:       { name: 'slideleft',  duration: 0.5 },
      // Light flare wipe — fadewhite blooms to white at peak then
      // reveals next clip. Closest ffmpeg approximation of the
      // warm-bloom whiteout described in TRANSITION-LIGHT-FLARE-WIPE.md.
      light_flare_wipe:      { name: 'fadewhite',  duration: 1.2 },
      light_flare_wipe_fast: { name: 'fadewhite',  duration: 0.6 },
      // cut_transition is special — xfade has no zero-duration mode,
      // so we treat it as a 1-frame (~0.04s) fade. Visually
      // indistinguishable from a hard cut, keeps the chain uniform.
      cut_transition:        { name: 'fade',       duration: 0.04 },
    }

    // ── Per-boundary transition selection ─────────────────────────────
    // Pool defaults to DEFAULT_TRANSITION_POOL but templates can override
    // via motion.transition_pool. Empty pool / explicit single transition
    // (motion.transition_pool: false) → fall back to the template's
    // resolved transition primitive used uniformly.
    const motionBlock = resolvedTemplate?.motion || {}
    const templatePool = motionBlock.transition_pool
    let pool
    if (Array.isArray(templatePool)) pool = templatePool
    else if (templatePool === false) pool = null
    else pool = DEFAULT_TRANSITION_POOL
    const fallbackPrim = resolvedTemplate?._motion_plan?.resolved?.transition?.id || 'cut_transition'

    // Build per-boundary plan. boundaryPlan[i] applies to the boundary
    // BETWEEN chunkPaths[i-1] and chunkPaths[i] (i runs 1..N-1).
    const boundaryPlan = []
    for (let i = 1; i < chunkPaths.length; i++) {
      const prim = (pool && pool.length)
        ? pickTransitionForBoundary(studio_video_id, i, pool)
        : fallbackPrim
      boundaryPlan.push({ prim, xf: XFADE_MAP[prim] || null })
    }

    // Cap xfade at 20 chunks. Each input in an xfade chain holds a
    // decoded frame buffer for the crossfade window, and memory grows
    // with N. Past ~20 we OOM during the final concat pass on
    // performance-4x. Beyond the cap fall back to hard-cut concat so
    // the bake completes.
    const XFADE_CHUNK_LIMIT = 20
    const useXfadeChain = chunkPaths.length >= 2
      && chunkPaths.length <= XFADE_CHUNK_LIMIT
      && boundaryPlan.some((b) => b.xf)
    if (chunkPaths.length > XFADE_CHUNK_LIMIT) {
      console.warn(`[studio-render] ${chunkPaths.length} chunks exceeds xfade limit (${XFADE_CHUNK_LIMIT}); falling back to hard-cut concat.`)
    }
    console.log(`[studio-render] transitions: ${boundaryPlan.map((b) => b.prim).join(' → ')}`)

    if (useXfadeChain) {
      // xfade chain. Each step blends current intermediate output with
      // the next chunk, offset by (running total - duration).
      const inputs = []
      const filter = []
      for (let i = 0; i < chunkPaths.length; i++) {
        inputs.push('-i', chunkPaths[i])
      }

      let runningOffset = 0  // running concat time before the current xfade boundary
      let prevVideoLabel = '[0:v]'
      let prevAudioLabel = '[0:a]'
      for (let i = 1; i < chunkPaths.length; i++) {
        const prevDur = chunkDurations[i - 1] || 4
        // Per-boundary xfade. If this boundary's primitive has no xfade
        // mapping (unlikely with the default pool but possible if a
        // template injects a non-xfadeable id), fall back to the
        // hard-cut substitute (1-frame fade).
        const b = boundaryPlan[i - 1].xf || XFADE_MAP.cut_transition
        runningOffset += prevDur - b.duration  // start the xfade `b.duration` BEFORE end of previous
        const offsetStr = runningOffset.toFixed(3)
        const durStr = b.duration.toFixed(3)
        const vOut = `[v${i}]`
        const aOut = `[a${i}]`
        filter.push(`${prevVideoLabel}[${i}:v]xfade=transition=${b.name}:duration=${durStr}:offset=${offsetStr}${vOut}`)
        filter.push(`${prevAudioLabel}[${i}:a]acrossfade=d=${durStr}${aOut}`)
        prevVideoLabel = vOut
        prevAudioLabel = aOut
      }
      // Final outputs map to the last labels
      const finalV = prevVideoLabel
      const finalA = prevAudioLabel
      // FINAL CONCAT — HD delivery preset. Intermediate per-chunk
      // encodes used preset=veryfast + crf=23 since those bytes are
      // throwaway. This pass is what the user downloads, so we trade
      // a bit more CPU time for noticeably better quality:
      //   preset=medium  — ~2× slower than veryfast, ~15% better
      //                    compression-to-quality ratio
      //   crf=20         — visibly cleaner gradients + less banding
      //                    than 23 (the banding in dark red glow
      //                    accents was visible at crf 23)
      //   profile=high level=4.1 — broadest YouTube / TikTok / iOS
      //                    compat for 1080p H.264
      //   audio 192k    — bumped from 128k since voice carries the
      //                    whole video and 128k AAC mono has
      //                    audible artifacts on s/sh sibilants
      await runFFmpeg([
        '-y', ...inputs,
        '-filter_complex', filter.join(';'),
        '-map', finalV, '-map', finalA,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
        '-profile:v', 'high', '-level', '4.1',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', finalPath,
      ], 600_000)
    } else {
      // Hard cut concat — same HD delivery settings as the xfade path.
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
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
        '-profile:v', 'high', '-level', '4.1',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', finalPath,
      ], 600_000)
    }

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
        // Real composition event log, keyed by segment id. Each entry
        // was harvested from window.__hyperframes.getEvents() inside
        // renderHyperFramesChunk. Compositions that didn't record
        // anything fall back to the heuristic COMPOSITION_EVENTS table
        // inside buildSfxCues.
        const eventLog = {}
        for (const s of chunkSegments) {
          if (s._hyperframes_events?.length) eventLog[s.id] = s._hyperframes_events
        }
        const motionPlan = resolvedTemplate?._motion_plan
        // Per-boundary xfade overlap array so SFX cues stay aligned
        // with the now-compressed final timeline. When no xfade chain
        // was used (hard-cut concat fallback), overlaps are all 0.
        const overlapSecs = useXfadeChain
          ? boundaryPlan.map((b) => (b.xf ? b.xf.duration : 0))
          : 0
        const cues = buildSfxCues(chunkSegments, chunkDurations, sfxPlan, eventLog, motionPlan, overlapSecs)
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

    // 7.5. Upsert a Library row so the rendered MP4 shows up in the
    // user's Library tab. Idempotent: re-renders find the existing
    // row via studio_video_id and update media_urls in place instead
    // of creating duplicates. Errors here are non-fatal — render is
    // already done; missing Library entry is recoverable later.
    try {
      const libTitle = (video.title && video.title.trim())
        || (video.topic_prompt || '').slice(0, 80).trim()
        || 'Untitled Studio video'

      const { data: existing } = await supabase
        .from('content_scripts')
        .select('id')
        .eq('studio_video_id', studio_video_id)
        .limit(1)
        .maybeSingle()

      const libRow = {
        profile_id: video.profile_id,
        studio_video_id,
        title: libTitle,
        full_script: video.script_full_text || '',
        media_urls: [finalUrl],
        media_type: 'video',
        status: 'draft',
        generated_by: 'studio',
        generation_prompt: (video.topic_prompt || '').slice(0, 4000) || null,
      }

      if (existing?.id) {
        await supabase.from('content_scripts').update({
          ...libRow,
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id)
      } else {
        await supabase.from('content_scripts').insert(libRow)
      }
    } catch (libErr) {
      console.warn(`[studio-render] Library upsert failed (non-fatal): ${libErr.message}`)
    }

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
