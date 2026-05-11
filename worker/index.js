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

    try {
      const result = await runWorkflow({
        graph, userId: user_id, profileId: profile_id, internalSecret: internal_secret,
        log: (m) => console.log(`[wf ${jobLabel}] ${m}`),
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
  } = body || {}
  if (!profile_id || !video_url) throw new Error('profile_id + video_url required')
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Storage not configured on worker')

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
    args.push('-i', inPath)
    let nextIdx = 1
    let titleIdx = -1, logoIdx = -1, musicIdx = -1, voiceIdx = -1
    if (titlePngPath)  { args.push('-i', titlePngPath);  titleIdx = nextIdx++ }
    if (logoPath)      { args.push('-i', logoPath);      logoIdx  = nextIdx++ }
    if (musicPath)     { args.push('-i', musicPath);     musicIdx = nextIdx++ }
    if (voiceoverPath) { args.push('-i', voiceoverPath); voiceIdx = nextIdx++ }

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
      const primary = aLabel || '[0:a]'
      filters.push(`${primary}[mus]amix=inputs=2:duration=first:dropout_transition=0[aout]`)
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

    return { video_url: finalUrl, bytes: finalBuf.byteLength, zapcap: zapcapMeta }
  } finally {
    if (workdir) { try { await rm(workdir, { recursive: true, force: true }) } catch {} }
  }
}

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
