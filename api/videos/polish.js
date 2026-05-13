// POST /api/videos/polish
// Body: {
//   profile_id, video_url,
//   logo_url?, watermark_image_url?, music_url?,
//   script?,                       // for auto-burned subtitles (TikTok-chunked)
//   title?, title_style?,          // big top overlay + styling
//   caption_style?,                // subtitles styling
//   watermark_position?, watermark_size_pct?,
//   music_volume?, music_fade_secs?,
// }
// Returns: { video_url, bytes }
//
// Native ffmpeg via @ffmpeg-installer/ffmpeg (a fuller build that
// includes drawtext / libfreetype, which the slimmer ffmpeg-static
// distribution we tried first DOES NOT — every title overlay was
// failing with "No such filter: 'drawtext'"). We tried ffmpeg-wasm
// first but Node-side WASM is single-threaded and a libx264 re-encode
// of a 30-second clip takes 2-5 minutes — well past Vercel's limits.
// The static binary is ~50x faster.
//
// Pipeline:
//   1. Download video / logo / music to /tmp.
//   2. Build a single ffmpeg invocation with optional drawtext (title) +
//      overlay (logo) + amix (bg music). Captions are a separate
//      ZapCap pass — see captions node.
//   3. Spawn ffmpeg, stream stderr to a buffer for diagnostics.
//   4. Upload the result to landing-media via service role.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { isUserOnTrial, TRIAL_LOCKS } from '../_lib/billing.js'
import { createClient } from '@supabase/supabase-js'
import { NotifyKind } from '../_lib/notify.js'
import { zapcapAddVideoByUrl, zapcapCreateTask, zapcapPollTask } from '../_lib/zapcap.js'
import { renderTitlePng } from '../_lib/title-svg.js'
import { buildTimeline as buildShotstackTimeline, submitRender as submitShotstackRender, pollRender as pollShotstackRender } from '../_lib/shotstack.js'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
const ffmpegPath = ffmpegInstaller.path
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUNDLED_FONT_PATH = join(__dirname, '..', '_fonts', 'Sans-Bold.ttf')

// Map dropdown labels (UI) to remote TTF URLs we can fetch on demand.
// Hosted on github.com/google/fonts (Google Fonts repository) — these
// paths are stable. Fetched once per cold start and cached in /tmp.
const FONT_URL_MAP = {
  'Montserrat ExtraBold': 'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-ExtraBold.ttf',
  'Poppins ExtraBold':    'https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-ExtraBold.ttf',
  'Inter ExtraBold':      'https://raw.githubusercontent.com/google/fonts/main/ofl/inter/static/Inter_28pt-ExtraBold.ttf',
  'Bebas Neue':           'https://raw.githubusercontent.com/google/fonts/main/ofl/bebasneue/BebasNeue-Regular.ttf',
  'Anton':                'https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf',
  'Oswald':               'https://raw.githubusercontent.com/google/fonts/main/ofl/oswald/static/Oswald-Bold.ttf',
  'Roboto Black':         'https://raw.githubusercontent.com/google/fonts/main/apache/roboto/static/Roboto-Black.ttf',
}

// Filenames inside `api/_fonts/` for each label. Drop the .ttf there
// to bundle it with the Vercel function — kills the cold-start
// GitHub fetch and the GitHub rate-limit risk. Missing files fall
// back to BUNDLED_FONT_PATH (the always-present sans).
const FONT_FILES = {
  'Montserrat ExtraBold': 'Montserrat-ExtraBold.ttf',
  'Poppins ExtraBold':    'Poppins-ExtraBold.ttf',
  'Inter ExtraBold':      'Inter-ExtraBold.ttf',
  'Bebas Neue':           'BebasNeue-Regular.ttf',
  'Anton':                'Anton-Regular.ttf',
  'Oswald':               'Oswald-Bold.ttf',
  'Roboto Black':         'Roboto-Black.ttf',
}

const _fontPathCache = new Map()
async function resolveFontPath(label) {
  if (!label || label === 'Sans') return BUNDLED_FONT_PATH
  if (_fontPathCache.has(label)) return _fontPathCache.get(label)

  // Try bundled first. Fast path — no network, no /tmp dance.
  const filename = FONT_FILES[label]
  if (filename) {
    const bundledPath = join(__dirname, '..', '_fonts', filename)
    try {
      await readFile(bundledPath)
      _fontPathCache.set(label, bundledPath)
      return bundledPath
    } catch { /* not bundled — fall through to download */ }
  }

  // Network fallback: only used until the .ttf is dropped into _fonts/.
  if (!FONT_URL_MAP[label]) {
    _fontPathCache.set(label, BUNDLED_FONT_PATH)
    return BUNDLED_FONT_PATH
  }
  const safeName = label.replace(/[^a-zA-Z0-9]/g, '_') + '.ttf'
  const target = join(tmpdir(), 'scalesolo-fonts', safeName)
  try {
    await readFile(target)
    _fontPathCache.set(label, target)
    return target
  } catch {}
  try {
    const r = await fetch(FONT_URL_MAP[label])
    if (!r.ok) throw new Error(`font fetch ${label} → ${r.status}`)
    const buf = Buffer.from(await r.arrayBuffer())
    const dir = join(tmpdir(), 'scalesolo-fonts')
    await mkdir(dir, { recursive: true }).catch(() => {})
    await writeFile(target, buf)
    _fontPathCache.set(label, target)
    return target
  } catch (e) {
    console.warn(`Polish: font "${label}" not bundled and fetch failed (${e.message}); falling back to bundled sans.`)
    return BUNDLED_FONT_PATH
  }
}

export const config = { maxDuration: 300 }

async function fetchToBuffer(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Fetch ${url} → ${r.status}`)
  const ab = await r.arrayBuffer()
  return Buffer.from(ab)
}

function srtTime(s) {
  const ms = Math.max(0, Math.round(s * 1000))
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0')
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0')
  const sec = String(Math.floor(ms / 1000) % 60).padStart(2, '0')
  const milli = String(ms % 1000).padStart(3, '0')
  return `${h}:${m}:${sec},${milli}`
}

function buildSrt(script, totalSecs, wordsPerChunk = 3) {
  const words = String(script || '').replace(/[*_`]/g, '').split(/\s+/).filter(Boolean)
  if (!words.length || !totalSecs) return ''
  const wpc = Math.max(1, Math.min(6, Number(wordsPerChunk) || 3))
  const chunks = []
  for (let i = 0; i < words.length; i += wpc) {
    chunks.push(words.slice(i, i + wpc).join(' ').toUpperCase())
  }
  const dur = totalSecs / chunks.length
  return chunks
    .map((text, i) => `${i + 1}\n${srtTime(i * dur)} --> ${srtTime((i + 1) * dur)}\n${text}\n`)
    .join('\n')
}

function hexToAssBgr(hex, fallback = '00FFFFFF') {
  if (!hex || typeof hex !== 'string') return fallback
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return fallback
  const rr = m[1].slice(0, 2), gg = m[1].slice(2, 4), bb = m[1].slice(4, 6)
  return `00${bb}${gg}${rr}`.toUpperCase()
}
function hexToDrawtext(hex, fallback = 'white') {
  if (!hex || typeof hex !== 'string') return fallback
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return fallback
  return `0x${m[1].toUpperCase()}`
}
// `overlay` knows main_w/main_h, so corner padding can stay percent-of-main.
// `scale` does NOT — its expression context only sees the input being
// scaled. That's why earlier `scale=(main_w*0.25):-1` blew up. We do the
// logo resize via `scale2ref` instead (see filter chain), so this helper
// only returns the X/Y offset expressions now.
function overlayPos(pos) {
  const pad = `(main_w*0.04)`
  switch (pos) {
    case 'tl': return { x: pad,                          y: pad }
    case 'tr': return { x: `(main_w-overlay_w-${pad})`,  y: pad }
    case 'bl': return { x: pad,                          y: `(main_h-overlay_h-${pad})` }
    // Centered horizontally, lifted 18% from the bottom so it sits
    // above where TikTok / IG Reels render the caption + handle band.
    case 'bc-safe': return { x: `(main_w-overlay_w)/2`, y: `(main_h-overlay_h-(main_h*0.18))` }
    case 'br':
    default:   return { x: `(main_w-overlay_w-${pad})`,  y: `(main_h-overlay_h-${pad})` }
  }
}
function escDrawtext(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "’")
    .replace(/%/g, '\\%')
}

// drawtext renders single-line by default and ffmpeg's filter-graph
// parser eats backslash-escaped newlines unpredictably (`text='a\nb'`
// can come out as a literal "\n" instead of a line break). The reliable
// fix is `textfile=`: write real newlines to a temp file and let drawtext
// read it. Returns the wrapped string so we can persist it to disk.
//
// Wrap heuristic: assume 1080-wide HeyGen output, with ~0.62 glyph-width-
// to-fontsize ratio for ExtraBold sans faces (Poppins / Montserrat /
// Inter ExtraBold). Bumped from 0.55 since heavier weights actually
// take more horizontal space than that.
function wrapTitleLines(rawText, fontSize) {
  const text = String(rawText || '').trim()
  if (!text) return ''
  const usableWidth = 1080 * 0.82
  const glyphWidth  = Math.max(8, Number(fontSize) * 0.62)
  const maxChars    = Math.max(6, Math.floor(usableWidth / glyphWidth))
  const words = text.split(/\s+/).filter(Boolean)
  if (!words.length) return text
  const lines = []
  let cur = ''
  for (const w of words) {
    if (!cur) { cur = w; continue }
    if ((cur + ' ' + w).length > maxChars) { lines.push(cur); cur = w }
    else cur = cur + ' ' + w
  }
  if (cur) lines.push(cur)
  // ffmpeg < 7.0 doesn't support drawtext's text_align option, so we
  // can't ask drawtext to center each line within the bounding box.
  // The whole block is x-centered via x=(w-text_w)/2 so all lines will
  // be the same horizontal extent — good enough when line lengths are
  // similar after greedy wrap. Pad the shorter line(s) with whitespace
  // on each side so they visually center under the longer line.
  if (lines.length > 1) {
    const maxLen = Math.max(...lines.map((l) => l.length))
    return lines.map((l) => {
      const total = maxLen - l.length
      if (total <= 0) return l
      const left = Math.floor(total / 2)
      const right = total - left
      return ' '.repeat(left) + l + ' '.repeat(right)
    }).join('\n')
  }
  return lines.join('\n')
}

// Spawn ffmpeg with the given args, capture stderr for error reporting.
// Resolves on exit code 0, rejects with stderr tail on anything else.
// Probe a media file's duration in seconds. We don't bundle ffprobe
// so we run a no-op ffmpeg invocation and parse the Duration line off
// stderr. Used to know how long the video runs so the music can fade
// out at exactly (videoDuration - fade) instead of guessing from
// stream metadata that may not exist yet.
function probeDurationSecs(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-i', filePath, '-hide_banner', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    proc.stderr.on('data', (d) => { err += d.toString('utf8') })
    proc.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i)
      if (!m) return reject(new Error('Could not parse video duration'))
      const h = +m[1], min = +m[2], s = parseFloat(m[3])
      resolve(h * 3600 + min * 60 + s)
    })
    proc.on('error', reject)
  })
}

// ffmpeg budget scales with source length. Title + watermark + music
// composites at ~0.5-1× realtime on Vercel's serverless x86 runtime,
// so a 60s clip wraps in 30-60s and a 180s clip wraps in 90-180s.
// We give a generous 2.5× source duration with a 30s baseline for
// startup + I/O, then cap at 260s so there's still ~40s of headroom
// before Vercel's 300s gateway timeout (which would 502 the user).
//
// For callers that don't know the duration (probe failed, etc.) we
// default to 240s which handles anything up to ~90s of source.
const FFMPEG_BASE_TIMEOUT_MS = 30_000
const FFMPEG_PER_SEC_MS      = 2_500
const FFMPEG_TIMEOUT_CAP_MS  = 260_000
const FFMPEG_DEFAULT_TIMEOUT_MS = 240_000
function timeoutForDuration(durationSecs) {
  if (!durationSecs || durationSecs <= 0) return FFMPEG_DEFAULT_TIMEOUT_MS
  const calc = FFMPEG_BASE_TIMEOUT_MS + Math.ceil(durationSecs * FFMPEG_PER_SEC_MS)
  return Math.min(FFMPEG_TIMEOUT_CAP_MS, calc)
}
function runFFmpeg(args, timeoutMs = FFMPEG_DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); if (stderr.length > 200_000) stderr = stderr.slice(-100_000) })
    proc.stdout.on('data', () => {}) // drain
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s. The clip may be longer than the function's budget allows (~${Math.round(FFMPEG_TIMEOUT_CAP_MS / 1000 / 2.5)}s of source max), or the filter chain is unusually heavy. Try a shorter clip or fewer overlays.`))
    }, timeoutMs)
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stderr)
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.split('\n').slice(-12).join('\n')}`))
    })
  })
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  let workdir = null

  try {
    // Destructured as `let` for watermark_* so the trial-lock block
    // below can reassign them in place without renaming every
    // downstream reference. Other fields stay const.
    const {
      profile_id, video_url,
      logo_url, music_url, title,
      title_style,
      captions_enabled,         // bool — gates the ZapCap pass entirely
      caption_template_id,      // ZapCap template UUID
      music_volume = 0.15,
      music_fade_secs = 1.0,
      // Voiceover narration — typically an upstream voice_gen output.
      // When set, the worker uses it as the primary audio (replaces or
      // overrides the source video's audio) and can loop the video to
      // match the voiceover length.
      voiceover_url,
      loop_video = false,
      mute_video_audio = false,
    } = req.body || {}
    let watermark_image_url = req.body?.watermark_image_url
    let watermark_position  = req.body?.watermark_position ?? 'br'
    let watermark_size_pct  = req.body?.watermark_size_pct ?? 25
    const ts = title_style || {}

    if (!profile_id || !video_url) return res.status(400).json({ error: 'profile_id + video_url required' })
    await assertProfileAccess(auth.user.id, profile_id)

    // Trial enforcement. Reassigns the watermark_* lets so every
    // downstream code path (Shotstack early, worker forward, ffmpeg
    // local fallback) sees the locked values. No way for the client
    // to override.
    if (await isUserOnTrial(auth.user.id)) {
      watermark_image_url = TRIAL_LOCKS.forced_watermark_url
      watermark_position  = TRIAL_LOCKS.forced_watermark_position
      watermark_size_pct  = TRIAL_LOCKS.forced_watermark_size_pct
    }

    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
    const customerId = cust?.[0]?.id
    const fee = 1500
    if (customerId) {
      const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`)
      if ((Number(pools?.[0]?.balance ?? 0)) < fee) {
        return res.status(402).json({ error: 'Insufficient AI tokens.', code: 'insufficient_credits' })
      }
    }

    // Pre-compute the work flags + supabase client so the Shotstack and
    // worker paths (which sit ahead of the local ffmpeg path) can share
    // them without re-declaring further down.
    const SUPABASE_URL_EARLY = process.env.SUPABASE_URL
    const SERVICE_KEY_EARLY = process.env.SUPABASE_SERVICE_KEY
    const supabaseEarly = (SUPABASE_URL_EARLY && SERVICE_KEY_EARLY)
      ? createClient(SUPABASE_URL_EARLY, SERVICE_KEY_EARLY, { auth: { persistSession: false } })
      : null
    const effectiveLogoUrlEarly = watermark_image_url || logo_url
    const wantsCaptionsEarly = !!(captions_enabled && caption_template_id)
    const wantsFfmpegEarly = !!(title || (effectiveLogoUrlEarly && watermark_position !== 'none') || music_url)

    // ─── Shotstack passthrough ─────────────────────────────────────────────
    // Only used when WORKER_URL is NOT set. The Shotstack block sits
    // higher in the file than the worker block, so without this gate
    // Shotstack would always win when both env vars are configured —
    // exactly the bug we hit when migrating to the Fly worker. With
    // WORKER_URL set, this branch is skipped and execution flows down
    // to the worker block below. If the worker errors, the final
    // fallback is the local in-Vercel ffmpeg path.
    if (process.env.SHOTSTACK_API_KEY && !process.env.WORKER_URL && wantsFfmpegEarly && supabaseEarly) {
      try {
        // No local duration probe — Shotstack resolves the video's
        // natural length server-side via `length: "auto"` on the clip
        // (and `length: "end"` on overlays). Probing locally meant
        // streaming the whole video through ffmpeg just to read its
        // Duration line, which OOM'd the function on big clips.
        const videoLen = null

        // Title PNG → Storage. Same renderer the ffmpeg path uses, so
        // typography is pixel-identical across the two backends. We
        // skip the title silently on render error rather than fail the
        // whole polish.
        let titlePngUrl = null
        if (title) {
          try {
            const png = await renderTitlePng({
              title: String(title).slice(0, 120),
              font: ts.font, size: Number(ts.size ?? 72),
              color: ts.color || '#ffffff', bg_color: ts.bg_color || '#e0467a',
              bg_padding: Math.max(0, Number(ts.bg_padding ?? 28)),
              uppercase: !!ts.uppercase, max_width: 1080,
            })
            if (png) {
              const tPath = `${profile_id}/spaces/polished/title-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
              const { error } = await supabaseEarly.storage.from('landing-media').upload(tPath, png, {
                contentType: 'image/png', upsert: false,
              })
              if (!error) {
                titlePngUrl = supabaseEarly.storage.from('landing-media').getPublicUrl(tPath).data.publicUrl
              }
            }
          } catch (e) {
            console.warn('[polish:shotstack] title PNG step failed, continuing without title:', e.message)
          }
        }

        const ssPayload = buildShotstackTimeline({
          videoUrl: video_url,
          videoLen,
          titlePngUrl,
          titleYpos: ts.y_pos,
          logoUrl: effectiveLogoUrlEarly && watermark_position !== 'none' ? effectiveLogoUrlEarly : null,
          watermarkPosition: watermark_position,
          watermarkSizePct: watermark_size_pct,
          musicUrl: music_url,
          musicVolume: music_volume,
          musicFadeSecs: music_fade_secs,
          aspectRatio: req.body?.aspect_ratio || '9:16',
          resolution:  req.body?.resolution  || '1080',
        })

        const renderId = await submitShotstackRender(ssPayload)
        const { url: ssUrl } = await pollShotstackRender(renderId)

        // ZapCap captions chain on after Shotstack — same dance as the
        // local ffmpeg path, just feeding the Shotstack output URL.
        let zapcapMeta = null
        let captionedUrl = ssUrl
        if (wantsCaptionsEarly) {
          try {
            const zVideoId = await zapcapAddVideoByUrl(ssUrl, { ttl: '1d' })
            const zTaskId = await zapcapCreateTask(zVideoId, { templateId: caption_template_id, autoApprove: true })
            const zResult = await zapcapPollTask(zVideoId, zTaskId, { timeoutMs: 180_000, intervalMs: 2500 })
            captionedUrl = zResult.downloadUrl || zResult.video?.downloadUrl || zResult.url || ssUrl
            zapcapMeta = { template_id: caption_template_id, video_id: zVideoId, task_id: zTaskId }
          } catch (e) {
            // Captions failure → keep the Shotstack composite, surface
            // a warning. Same forgiving behavior as the ffmpeg path.
            console.warn('[polish:shotstack] ZapCap failed, returning composite-only:', e.message)
            zapcapMeta = { error: e.message }
          }
        }

        // Mirror the final asset to our own Storage so the canvas has
        // a stable URL (Shotstack's CDN URLs expire after ~24h on free
        // plans). Skipped for files > MIRROR_MAX_BYTES so big clips
        // don't OOM the Vercel function — for those we accept the
        // shorter-lived upstream URL since downstream consumers
        // (Upload-Post) fetch immediately on submit.
        const MIRROR_MAX_BYTES = 60 * 1024 * 1024  // 60 MB
        let finalUrl = captionedUrl
        let bytes = 0
        try {
          // HEAD first to peek the Content-Length. Avoid pulling 100+ MB
          // into a Buffer just to discover we shouldn't have.
          const head = await fetch(captionedUrl, { method: 'HEAD' }).catch(() => null)
          const len = Number(head?.headers?.get('content-length') || 0)
          if (len && len > MIRROR_MAX_BYTES) {
            console.warn(`[polish:shotstack] skipping mirror — file ${(len / 1024 / 1024).toFixed(1)} MB > ${(MIRROR_MAX_BYTES / 1024 / 1024)} MB cap`)
            bytes = len
          } else {
            const buf = await fetchToBuffer(captionedUrl)
            bytes = buf.byteLength
            const outPath = `${profile_id}/spaces/polished/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
            const { error } = await supabaseEarly.storage.from('landing-media').upload(outPath, buf, {
              contentType: 'video/mp4', upsert: false,
            })
            if (!error) {
              finalUrl = supabaseEarly.storage.from('landing-media').getPublicUrl(outPath).data.publicUrl
            }
          }
        } catch (e) {
          console.warn('[polish:shotstack] could not mirror to Storage, using upstream URL:', e.message)
        }

        if (customerId) {
          try {
            await supaFetch('rpc/consume_credits', {
              method: 'POST',
              body: {
                p_customer_id: customerId, p_pool_type: 'ai_tokens', p_amount: fee,
                p_action: 'consume:video-polish', p_profile_id: profile_id,
                p_metadata: { via: 'shotstack', video_url, has_title: !!title, has_captions: wantsCaptionsEarly, zapcap: zapcapMeta, bytes },
              },
            })
          } catch (e) {
            console.error('video-polish (shotstack): consume_credits threw', e?.message)
          }
        }

        NotifyKind.renderDone({
          user_id: auth.user.id,
          profile_id,
          video_url: finalUrl,
        }).catch(() => {})

        return res.status(200).json({ video_url: finalUrl, bytes, zapcap: zapcapMeta, via: 'shotstack' })
      } catch (e) {
        // Any failure in the Shotstack path → fall through to the
        // worker / local-ffmpeg paths below. The user still gets a
        // polish; we just lose the speed benefit for this one run.
        console.warn('[polish] Shotstack path failed, falling back:', e.message)
      }
    }

    // ─── Worker passthrough ────────────────────────────────────────────────
    // When WORKER_URL is set the heavy ffmpeg compositing runs on Fly /
    // Railway / wherever the worker lives. Vercel's job is then just:
    // forward to worker, optionally chain ZapCap captions, debit credits.
    // No video bytes pass through Vercel anymore — solves the OOM that
    // plagued the in-function ffmpeg path on big clips.
    //
    // Ordering: worker is the PREFERRED fast path. Shotstack (block above)
    // is the fallback when WORKER_URL is unset OR the worker errors.
    // Local ffmpeg is the last-resort fallback after both.
    const WORKER_URL = process.env.WORKER_URL
    const WORKER_SECRET = process.env.WORKER_SHARED_SECRET
    if (WORKER_URL && wantsFfmpegEarly) {
      try {
        // Step 1 — submit ASYNC. Worker returns a job_id immediately,
        // processes ffmpeg in background. We then long-poll status
        // up to ~250s (leaving 50s headroom under Vercel's 300s gateway
        // timeout for the ZapCap chain + mirror that runs after). For
        // big clips (4K HEVC, 100MB+) that take longer than 250s, we
        // surface a 202 with the worker_job_id so the canvas can keep
        // polling on its own — no more 504s.
        const workerBase = `${WORKER_URL.replace(/\/$/, '')}`
        const headers = {
          'Content-Type': 'application/json',
          ...(WORKER_SECRET ? { 'x-worker-secret': WORKER_SECRET } : {}),
        }
        const submitRes = await fetch(`${workerBase}/jobs/polish-async`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            profile_id, video_url, logo_url, watermark_image_url,
            music_url, title, title_style,
            watermark_position, watermark_size_pct,
            music_volume, music_fade_secs,
            // Voiceover overlay — worker treats this as the primary
            // audio track. mute_video_audio drops the source camera
            // audio; loop_video stretches video frames to match a
            // longer voiceover by tagging the ffmpeg input with
            // -stream_loop -1 and -shortest on output.
            voiceover_url: voiceover_url || undefined,
            loop_video: !!loop_video || undefined,
            mute_video_audio: !!mute_video_audio || undefined,
            // Worker chains ZapCap captions itself so the full polish
            // result (composite + captions) is one atomic job. Critical
            // for the async path — when Vercel times out we return the
            // worker job_id; the canvas polls until done; the result
            // it gets is already captioned. Without this, async clips
            // would skip captions entirely.
            captions_enabled: wantsCaptionsEarly,
            caption_template_id: caption_template_id || undefined,
            caption_language:    req.body?.caption_language || undefined,
          }),
        })
        const submitBody = await submitRes.json().catch(() => ({}))
        if (!submitRes.ok || !submitBody?.job_id) {
          throw new Error(submitBody?.error || `Worker submit ${submitRes.status}`)
        }
        const jobId = submitBody.job_id

        // Long-poll worker status. 5s interval, 250s deadline. Most
        // clips complete in 20-90s; the 4K HEVC outliers that don't
        // exit this loop early. When they don't, we hand the canvas
        // the job_id to keep polling against /api/videos/polish-status.
        const POLL_DEADLINE_MS = 250_000
        const POLL_INTERVAL_MS = 5_000
        const start = Date.now()
        let wBody = null
        while (Date.now() - start < POLL_DEADLINE_MS) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
          const r = await fetch(`${workerBase}/jobs/${encodeURIComponent(jobId)}`, { headers })
          const body = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(body?.error || `Worker status ${r.status}`)
          if (body.status === 'done') { wBody = body.result; break }
          if (body.status === 'failed') throw new Error(body.error || 'Worker reported failure')
          // 'queued' or 'running' — keep polling.
        }
        if (!wBody) {
          // Still cooking. Hand the job_id back so the canvas keeps
          // polling via /api/videos/polish-status. 202 = Accepted,
          // processing continues.
          return res.status(202).json({
            polling: true,
            worker_job_id: jobId,
            worker_url: WORKER_URL,
            poll_url: `/api/videos/polish-status?job_id=${encodeURIComponent(jobId)}`,
            estimated_remaining_secs: 90,
          })
        }

        // Worker now chains ZapCap captions itself (see worker/index.js
        // polishCore). wBody.video_url is the final captioned URL; the
        // ZapCap metadata comes back in wBody.zapcap. No second Vercel-
        // side pass needed. This is critical for the async (>250s) path
        // — without worker-side captions, big clips that timeout
        // Vercel's outer loop would skip captions entirely.
        const finalUrl = wBody.video_url
        const zapcapMeta = wBody.zapcap || null

        // Debit credits after the worker confirms success. Atomic on
        // the DB side; we still surface failures so a tight race that
        // gifts a render shows up in logs instead of silently.
        if (customerId) {
          try {
            const result = await supaFetch('rpc/consume_credits', {
              method: 'POST',
              body: {
                p_customer_id: customerId, p_pool_type: 'ai_tokens', p_amount: fee,
                p_action: 'consume:video-polish', p_profile_id: profile_id,
                p_metadata: { via: 'worker', video_url, has_title: !!title, has_captions: wantsCaptionsEarly, zapcap: zapcapMeta, bytes: wBody.bytes },
              },
            })
            if (result && typeof result === 'object' && result.success === false) {
              console.error('video-polish (worker): consume_credits returned failure', {
                customerId, fee, error_code: result.error_code, profile_id,
              })
              try {
                const { captureApiError } = await import('../_lib/sentry.js')
                captureApiError(new Error('consume_credits returned success=false'), {
                  route: 'video-polish:worker:consume',
                  userId: auth.user.id, profileId: profile_id,
                  extra: { customerId, fee, error_code: result.error_code, kind: 'free_generation_leak' },
                })
              } catch {}
            }
          } catch (e) {
            console.error('video-polish (worker): consume_credits threw', {
              customerId, fee, profile_id, message: e?.message,
            })
            try {
              const { captureApiError } = await import('../_lib/sentry.js')
              captureApiError(e, {
                route: 'video-polish:worker:consume',
                userId: auth.user.id, profileId: profile_id,
                extra: { customerId, fee, kind: 'free_generation_leak' },
              })
            } catch {}
          }
        }
        NotifyKind.renderDone({
          user_id: auth.user.id,
          profile_id,
          video_url: finalUrl,
        }).catch(() => {})
        return res.status(200).json({ video_url: finalUrl, bytes: wBody.bytes, zapcap: zapcapMeta, via: 'worker' })
      } catch (e) {
        // Worker outage / error.
        //
        // Voiceover polishes can NOT safely fall through to local
        // Vercel ffmpeg — that path doesn't know about voiceover_url /
        // loop_video / mute_video_audio, so a "successful" fallback
        // would produce a video with the source camera audio instead
        // of the user's intended narration. Fail loud here so the
        // user re-deploys the worker / checks logs instead of
        // shipping a silently-broken polish.
        if (voiceover_url) {
          console.error('[polish] worker failed AND voiceover_url was requested — refusing local fallback:', e.message)
          return res.status(502).json({
            error: `Polish worker failed: ${e.message}. ` +
              'Voiceover polishes require the Fly worker (local ffmpeg fallback ignores voiceover audio). ' +
              'Check fly logs / redeploy the worker, then retry.',
          })
        }
        console.warn('[polish] worker forward failed, falling back:', e.message)
      }
    }

    const SUPABASE_URL = process.env.SUPABASE_URL
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
    if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Storage not configured' })

    if (!ffmpegPath) return res.status(500).json({ error: 'ffmpeg binary not bundled' })

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const effectiveLogoUrl = watermark_image_url || logo_url
    const wantsCaptions = !!(captions_enabled && caption_template_id)
    const wantsFfmpeg = !!(title || (effectiveLogoUrl && watermark_position !== 'none') || music_url)

    // ────────────────────────────────────────────────────────────────────────
    // Phase A — native ffmpeg compositing (title + watermark + music). Skipped
    // entirely if the user only wants captions, in which case we hand the
    // original video URL straight to ZapCap.
    // ────────────────────────────────────────────────────────────────────────
    let intermediateUrl = video_url
    let intermediateBuf = null
    let logoPath = null, musicPath = null

    if (wantsFfmpeg) {
      workdir = await mkdtemp(join(tmpdir(), 'polish-'))
      const inPath = join(workdir, 'in.mp4')
      const outPath = join(workdir, 'out.mp4')
      await writeFile(inPath, await fetchToBuffer(video_url))

      if (effectiveLogoUrl && watermark_position !== 'none') {
        try {
          const bytes = await fetchToBuffer(effectiveLogoUrl)
          // Sniff for SVG either by file extension OR by leading bytes.
          // The trial watermark is an SVG; ffmpeg can't decode SVG natively
          // so we rasterize to PNG via resvg (already imported for the
          // title overlay path) before writing it to disk. Without this
          // step ffmpeg hits "Invalid PNG signature 0x3C73766720786D6C"
          // (which is the ASCII for `<svg xml`).
          const head = bytes.slice(0, 512).toString('utf8').trim().toLowerCase()
          const isSvgByBytes = head.startsWith('<?xml') ? head.includes('<svg') : head.startsWith('<svg')
          const isSvgByExt = /\.svg(\?|$)/i.test(effectiveLogoUrl.split('?')[0])
          if (isSvgByExt || isSvgByBytes) {
            try {
              const { Resvg } = await import('@resvg/resvg-js')
              const pngBuf = new Resvg(bytes, {
                background: 'rgba(0,0,0,0)',
                // Render at 512px wide — ffmpeg's overlay filter scales
                // from there to the final video width fraction so we
                // just need a high-resolution source.
                fitTo: { mode: 'width', value: 512 },
              }).render().asPng()
              logoPath = join(workdir, 'logo.png')
              await writeFile(logoPath, pngBuf)
            } catch (rasterErr) {
              console.warn('[polish] SVG rasterize failed, skipping watermark:', rasterErr.message)
              logoPath = null
            }
          } else {
            const ext = (effectiveLogoUrl.split('?')[0].split('.').pop() || 'png').toLowerCase()
            const safeExt = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? ext : 'png'
            logoPath = join(workdir, `logo.${safeExt}`)
            await writeFile(logoPath, bytes)
          }
        } catch { logoPath = null }
      }

      if (music_url) {
        try {
          musicPath = join(workdir, 'music.mp3')
          await writeFile(musicPath, await fetchToBuffer(music_url))
        } catch { musicPath = null }
      }

      // Render the title overlay AHEAD of the ffmpeg invocation as an
      // SVG-derived PNG. The previous drawtext-with-whitespace-padding
      // path was visibly off-center because spaces aren't the same
      // width as average glyphs in proportional fonts. SVG with
      // text-anchor="middle" uses real glyph metrics, so each line
      // is pixel-perfect centered. We then overlay the PNG at the
      // requested vertical position via ffmpeg's overlay filter.
      let titlePngPath = null
      if (title) {
        try {
          const png = await renderTitlePng({
            title: String(title).slice(0, 120),
            font: ts.font,
            size: Number(ts.size ?? 72),
            color: ts.color || '#ffffff',
            bg_color: ts.bg_color || '#e0467a',
            bg_padding: Math.max(0, Number(ts.bg_padding ?? 28)),
            uppercase: !!ts.uppercase,
            max_width: 1080,
          })
          if (png) {
            titlePngPath = join(workdir, 'title.png')
            await writeFile(titlePngPath, png)
          }
        } catch (e) {
          console.warn('[polish] title PNG render failed; skipping title overlay:', e.message)
          titlePngPath = null
        }
      }

      const args = ['-y', '-i', inPath]
      let nextIdx = 1, titleIdx = -1, logoIdx = -1, musicIdx = -1
      if (titlePngPath) { args.push('-i', titlePngPath); titleIdx = nextIdx++ }
      if (logoPath)     { args.push('-i', logoPath);     logoIdx  = nextIdx++ }
      if (musicPath)    { args.push('-i', musicPath);    musicIdx = nextIdx++ }

      const filters = []
      let vLabel = '[0:v]'

      if (titleIdx !== -1) {
        // SVG → PNG title is rendered at video width (1080) already.
        // Position by y_pos % from top. format=rgba so the alpha
        // channel from sharp's PNG carries through the overlay.
        const tYpct = Math.max(0, Math.min(95, Number(ts.y_pos ?? 15))) / 100
        filters.push(`[${titleIdx}:v]format=rgba[tov]`)
        filters.push(`${vLabel}[tov]overlay=(W-w)/2:H*${tYpct}-h/2[vt]`)
        vLabel = '[vt]'
      }

      if (logoPath) {
        // `scale` filter has no `main_w` in its expression context, so
        // `scale=(main_w*0.25):-1` blew up with "self-referencing
        // expression". Use `scale2ref` to size the logo relative to the
        // main video width, preserving aspect via `ow/mdar`. scale2ref
        // outputs [scaled_logo, passthrough_main_video].
        const sizeFrac = Math.max(0.04, Math.min(0.4, Number(watermark_size_pct) / 100))
        filters.push(
          `[${logoIdx}:v]${vLabel}scale2ref=w=main_w*${sizeFrac.toFixed(3)}:h=ow/mdar[lg][refv]`
        )
        const { x, y } = overlayPos(watermark_position)
        filters.push(`[refv][lg]overlay=${x}:${y}[vw]`)
        vLabel = '[vw]'
      }

      let aLabel = '[0:a]'
      if (musicPath) {
        const vol = Math.max(0, Math.min(1, Number(music_volume)))
        const fadeSecs = Math.max(0, Math.min(10, Number(music_fade_secs ?? 1.0)))
        // Probe the source video duration so we can:
        //   • aloop the music to cover the full video length (most music
        //     files are shorter than the speaker's content; without
        //     looping, amix duration=first keeps the longest stream
        //     trimmed but the second half of the video has silence).
        //   • afade out cleanly at exactly (videoDuration - fadeSecs),
        //     so the track always ends with a deliberate fade instead
        //     of a hard cut at amix-time.
        let videoDur = 0
        try { videoDur = await probeDurationSecs(inPath) } catch { videoDur = 0 }

        const audioChain = []
        audioChain.push(`volume=${vol}`)
        // Loop forever, then cap with atrim. -1 = infinite. amix's
        // duration=first will still cut us at video length, but afade's
        // start time needs the source to actually exist at that time.
        if (videoDur > 0) {
          audioChain.push(`aloop=loop=-1:size=2e+09`)
          audioChain.push(`atrim=duration=${videoDur.toFixed(3)}`)
        } else {
          // Probe failed — fall back to apad so amix has something to
          // mix even past the music's natural end.
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
      // File-size discipline: Supabase Storage's global 50 MB upload cap
      // (per request, separate from the bucket's file_size_limit) was
      // bombing polishes that overran. CRF 26 + preset fast cuts size
      // roughly in half vs ultrafast/crf23 with minimal quality drop,
      // and -maxrate clamps the peak so we don't blow past 45 MB even on
      // a high-motion 60-second clip. faststart keeps the moov atom up
      // front for instant browser/TikTok playback.
      args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '26')
      args.push('-maxrate', '5500k', '-bufsize', '11000k')
      args.push('-c:a', 'aac', '-b:a', '128k')
      args.push('-movflags', '+faststart', outPath)

      // No silent fallback — if the overlay chain fails we want the user to
      // know, not to ship them the unmodified video and call it done. The
      // ffmpeg stderr tail surfaces in the response so the failing filter
      // is obvious. Timeout scales with the source's duration so a 3-min
      // clip doesn't get killed at 90s mid-encode.
      try {
        await runFFmpeg(args, timeoutForDuration(videoDur))
      } catch (e) {
        const tail = String(e?.message || e).split('\n').slice(-8).join('\n')
        console.error('Polish: ffmpeg chain failed\nfilter_complex:\n' + filters.join(';') + '\n\nstderr tail:\n' + tail)
        return res.status(502).json({
          error: 'Polish render failed.',
          ffmpeg_error: tail,
          filter_complex: filters.join(';'),
          hint: 'Check the filter_complex above — usually a font path, overlay coord, or audio fade timing issue.',
        })
      }

      intermediateBuf = await readFile(outPath)

      // If captions are coming next, we need a public URL ZapCap can reach.
      // Stage to a short-lived "intermediate" path; ZapCap pulls within
      // seconds so a TTL cleanup isn't urgent.
      if (wantsCaptions) {
        const stagePath = `${profile_id}/spaces/polished/intermediate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
        const { error: stageErr } = await supabase.storage.from('landing-media').upload(stagePath, intermediateBuf, {
          contentType: 'video/mp4', upsert: false,
        })
        if (stageErr) return res.status(502).json({ error: `Stage upload failed: ${stageErr.message}` })
        const { data: stagePub } = supabase.storage.from('landing-media').getPublicUrl(stagePath)
        intermediateUrl = stagePub.publicUrl
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Phase B — ZapCap caption pass. Submits the (possibly composited)
    // intermediate URL, polls until rendered, downloads the result.
    // ────────────────────────────────────────────────────────────────────────
    let finalBuf = intermediateBuf
    let zapcapMeta = null
    if (wantsCaptions) {
      try {
        const zVideoId = await zapcapAddVideoByUrl(intermediateUrl, { ttl: '1d' })
        const zTaskId = await zapcapCreateTask(zVideoId, { templateId: caption_template_id, autoApprove: true })
        // ZapCap budget: 180s. With ffmpeg capped at 90s and ~30s of
        // I/O (download / upload), this fits inside Vercel's 300s
        // gateway timeout with breathing room. 99% of ZapCap renders
        // for 30-60s clips finish within 90s; 180s catches the long
        // tail. If even that fails the polish surfaces a clear error
        // instead of a 502 from the gateway.
        // Polling at 2.5s — well above ZapCap's rate limit.
        const zResult = await zapcapPollTask(zVideoId, zTaskId, { timeoutMs: 180_000, intervalMs: 2500 })
        const downloadUrl = zResult.downloadUrl || zResult.video?.downloadUrl || zResult.url
        if (!downloadUrl) throw new Error('ZapCap task completed without a downloadUrl')
        finalBuf = await fetchToBuffer(downloadUrl)
        zapcapMeta = { template_id: caption_template_id, video_id: zVideoId, task_id: zTaskId }
      } catch (e) {
        // If captions specifically fail, return the ffmpeg-composited video
        // (if any) with a warning instead of the whole render erroring.
        if (intermediateBuf) {
          console.warn('Polish: ZapCap captions failed, returning composite-only —', e.message)
          finalBuf = intermediateBuf
          zapcapMeta = { error: e.message }
        } else {
          return res.status(502).json({ error: `ZapCap: ${e.message}` })
        }
      }
    }

    if (!finalBuf) {
      // Nothing was requested — return the original URL as a no-op.
      return res.status(200).json({ video_url, bytes: 0, no_op: true })
    }

    // ────────────────────────────────────────────────────────────────────────
    // Final upload
    // ────────────────────────────────────────────────────────────────────────
    const path = `${profile_id}/spaces/polished/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
    const { error: upErr } = await supabase.storage.from('landing-media').upload(path, finalBuf, {
      contentType: 'video/mp4', upsert: false,
    })
    if (upErr) return res.status(502).json({ error: `Upload failed: ${upErr.message}` })
    const { data: pub } = supabase.storage.from('landing-media').getPublicUrl(path)

    if (customerId) {
      try {
        const result = await supaFetch('rpc/consume_credits', {
          method: 'POST',
          body: {
            p_customer_id: customerId, p_pool_type: 'ai_tokens', p_amount: fee,
            p_action: 'consume:video-polish', p_profile_id: profile_id,
            p_metadata: {
              video_url, has_logo: !!logoPath, has_music: !!musicPath,
              has_captions: wantsCaptions, zapcap: zapcapMeta, bytes: finalBuf.byteLength,
            },
          },
        })
        if (result && typeof result === 'object' && result.success === false) {
          console.error('video-polish: consume_credits returned failure', {
            customerId, fee, error_code: result.error_code, profile_id,
          })
          try {
            const { captureApiError } = await import('../_lib/sentry.js')
            captureApiError(new Error('consume_credits returned success=false'), {
              route: 'video-polish:consume',
              userId: auth.user.id, profileId: profile_id,
              extra: { customerId, fee, error_code: result.error_code, kind: 'free_generation_leak' },
            })
          } catch {}
        }
      } catch (e) {
        console.error('video-polish: consume_credits threw', {
          customerId, fee, profile_id, message: e?.message,
        })
        try {
          const { captureApiError } = await import('../_lib/sentry.js')
          captureApiError(e, {
            route: 'video-polish:consume',
            userId: auth.user.id, profileId: profile_id,
            extra: { customerId, fee, kind: 'free_generation_leak' },
          })
        } catch {}
      }
    }

    // Don't auto-insert a "Polished video" content_scripts row here. The
    // save_library node downstream is the canonical owner of the library
    // entry — auto-inserting from polish.js produced a separate empty
    // row for every render, polluting the Library tab. Polished URL is
    // returned to the canvas; if the user wants a library record without
    // wiring save_library, they can drag one in.
    NotifyKind.renderDone({
      user_id: auth.user.id,
      profile_id,
      video_url: pub.publicUrl,
    }).catch(() => {})

    return res.status(200).json({
      video_url: pub.publicUrl,
      bytes: finalBuf.byteLength,
      zapcap: zapcapMeta,
      content_id: null,
    })
  } catch (err) {
    console.error('polish error:', err?.stack || err)
    if (auth?.user?.id) {
      NotifyKind.renderFailed({
        user_id: auth.user.id,
        profile_id: req.body?.profile_id,
        error: String(err?.message || err).slice(0, 280),
      }).catch(() => {})
    }
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  } finally {
    if (workdir) {
      try { await rm(workdir, { recursive: true, force: true }) } catch {}
    }
  }
}
