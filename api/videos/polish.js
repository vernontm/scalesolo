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
import { createClient } from '@supabase/supabase-js'
import { NotifyKind } from '../_lib/notify.js'
import { zapcapAddVideoByUrl, zapcapCreateTask, zapcapPollTask } from '../_lib/zapcap.js'
import { renderTitlePng } from '../_lib/title-svg.js'
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

function runFFmpeg(args, timeoutMs = 270_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); if (stderr.length > 200_000) stderr = stderr.slice(-100_000) })
    proc.stdout.on('data', () => {}) // drain
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error('ffmpeg timed out'))
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
    const {
      profile_id, video_url,
      logo_url, watermark_image_url, music_url, title,
      title_style,
      captions_enabled,         // bool — gates the ZapCap pass entirely
      caption_template_id,      // ZapCap template UUID
      watermark_position = 'br',
      watermark_size_pct = 25,
      music_volume = 0.15,
      music_fade_secs = 1.0,
    } = req.body || {}
    const ts = title_style || {}

    if (!profile_id || !video_url) return res.status(400).json({ error: 'profile_id + video_url required' })
    await assertProfileAccess(auth.user.id, profile_id)

    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
    const customerId = cust?.[0]?.id
    const fee = 1500
    if (customerId) {
      const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`)
      if ((Number(pools?.[0]?.balance ?? 0)) < fee) {
        return res.status(402).json({ error: 'Insufficient AI tokens.', code: 'insufficient_credits' })
      }
    }

    // ─── Worker passthrough ────────────────────────────────────────────────
    // If WORKER_URL is set the heavy ffmpeg work runs on Railway / Fly /
    // wherever the worker lives. Vercel's job is then just: auth, credit
    // check, forward, debit. This keeps polishes off the 60s function
    // ceiling and uses the worker's pre-bundled fonts (no cold-start
    // GitHub fetch). ZapCap captions still happen in the proxy below
    // since they're a pure POST → poll loop with no media-bytes work.
    const WORKER_URL = process.env.WORKER_URL
    const WORKER_SECRET = process.env.WORKER_SHARED_SECRET
    if (WORKER_URL && !captions_enabled) {
      try {
        const wRes = await fetch(`${WORKER_URL.replace(/\/$/, '')}/jobs/polish`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(WORKER_SECRET ? { 'x-worker-secret': WORKER_SECRET } : {}),
          },
          body: JSON.stringify({
            profile_id, video_url, logo_url, watermark_image_url,
            music_url, title, title_style,
            watermark_position, watermark_size_pct,
            music_volume, music_fade_secs,
          }),
        })
        const wBody = await wRes.json()
        if (!wRes.ok) throw new Error(wBody.error || `Worker ${wRes.status}`)

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
                p_metadata: { via: 'worker', video_url, has_title: !!title, bytes: wBody.bytes },
              },
            })
            if (result && typeof result === 'object' && result.success === false) {
              console.error('video-polish (worker): consume_credits returned failure', {
                customerId, fee, error_code: result.error_code, profile_id,
              })
            }
          } catch (e) {
            console.error('video-polish (worker): consume_credits threw', {
              customerId, fee, profile_id, message: e?.message,
            })
          }
        }
        NotifyKind.renderDone({
          user_id: auth.user.id,
          profile_id,
          video_url: wBody.video_url,
        }).catch(() => {})
        return res.status(200).json({ video_url: wBody.video_url, bytes: wBody.bytes, via: 'worker' })
      } catch (e) {
        // Worker outage: fall through to the in-Vercel ffmpeg path so
        // the user still gets a render. They'll see slower polishes
        // until WORKER_URL / Railway is back.
        console.warn('[polish] worker forward failed, falling back to in-function ffmpeg:', e.message)
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
          const ext = (effectiveLogoUrl.split('?')[0].split('.').pop() || 'png').toLowerCase()
          const safeExt = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? ext : 'png'
          logoPath = join(workdir, `logo.${safeExt}`)
          await writeFile(logoPath, await fetchToBuffer(effectiveLogoUrl))
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
      // is obvious.
      try {
        await runFFmpeg(args)
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
        const zResult = await zapcapPollTask(zVideoId, zTaskId, { timeoutMs: 5 * 60 * 1000, intervalMs: 4000 })
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
        }
      } catch (e) {
        console.error('video-polish: consume_credits threw', {
          customerId, fee, profile_id, message: e?.message,
        })
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
