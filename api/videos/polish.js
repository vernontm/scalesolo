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
// Native ffmpeg via the ffmpeg-static binary. We tried ffmpeg-wasm first
// but Node-side WASM is single-threaded and a libx264 re-encode of a
// 30-second clip takes 2-5 minutes — well past Vercel's 60s/300s limits.
// The static binary is ~50x faster and runs the whole thing in <30s for
// typical HeyGen output.
//
// Pipeline:
//   1. Download video / logo / music to /tmp.
//   2. Build a single ffmpeg invocation with optional drawtext (title) +
//      overlay (logo) + subtitles (auto from script) + amix (bg music).
//   3. Spawn ffmpeg-static, stream stderr to a buffer for diagnostics.
//   4. Upload the result to landing-media via service role.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { createClient } from '@supabase/supabase-js'
import ffmpegPath from 'ffmpeg-static'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUNDLED_FONT_PATH = join(__dirname, '..', '_fonts', 'Sans-Bold.ttf')

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
function overlayPos(pos, sizePct) {
  const w = `(main_w*${Number(sizePct) / 100})`
  const pad = `(main_w*0.04)`
  switch (pos) {
    case 'tl': return { w, x: pad, y: pad }
    case 'tr': return { w, x: `(main_w-overlay_w-${pad})`, y: pad }
    case 'bl': return { w, x: pad, y: `(main_h-overlay_h-${pad})` }
    case 'br':
    default:   return { w, x: `(main_w-overlay_w-${pad})`, y: `(main_h-overlay_h-${pad})` }
  }
}
function escDrawtext(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "’")
    .replace(/%/g, '\\%')
}

// Spawn ffmpeg with the given args, capture stderr for error reporting.
// Resolves on exit code 0, rejects with stderr tail on anything else.
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
      logo_url, watermark_image_url, music_url, script, title,
      title_style, caption_style,
      watermark_position = 'br',
      watermark_size_pct = 25,
      music_volume = 0.15,
      music_fade_secs = 1.5,
    } = req.body || {}
    const ts = title_style || {}
    const cs = caption_style || {}

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

    const SUPABASE_URL = process.env.SUPABASE_URL
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
    if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Storage not configured' })

    if (!ffmpegPath) return res.status(500).json({ error: 'ffmpeg binary not bundled' })

    workdir = await mkdtemp(join(tmpdir(), 'polish-'))
    const inPath = join(workdir, 'in.mp4')
    const outPath = join(workdir, 'out.mp4')

    // ── 1. Stage inputs to /tmp ────────────────────────────────────────────
    await writeFile(inPath, await fetchToBuffer(video_url))

    const effectiveLogoUrl = watermark_image_url || logo_url
    let logoPath = null
    if (effectiveLogoUrl && watermark_position !== 'none') {
      try {
        const ext = (effectiveLogoUrl.split('?')[0].split('.').pop() || 'png').toLowerCase()
        const safeExt = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? ext : 'png'
        logoPath = join(workdir, `logo.${safeExt}`)
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

    // Estimate duration from script word count (~2.5 wps for HeyGen).
    const wordCount = String(script || '').split(/\s+/).filter(Boolean).length
    const estDuration = Math.max(3, Math.round(wordCount / 2.5))
    const srt = script ? buildSrt(script, estDuration, cs.words_per_chunk) : ''
    let srtPath = null
    if (srt) {
      srtPath = join(workdir, 'subs.srt')
      await writeFile(srtPath, srt, 'utf8')
    }

    // ── 2. Build filter graph ─────────────────────────────────────────────
    const args = ['-y', '-i', inPath]
    let nextIdx = 1, logoIdx = -1, musicIdx = -1
    if (logoPath) { args.push('-i', logoPath); logoIdx = nextIdx++ }
    if (musicPath) { args.push('-i', musicPath); musicIdx = nextIdx++ }

    const filters = []
    let vLabel = '[0:v]'

    if (title) {
      const text = ts.uppercase ? String(title).toUpperCase() : String(title)
      const safe = escDrawtext(text.slice(0, 120))
      const tSize = Number(ts.size ?? 72)
      const tBg = hexToDrawtext(ts.bg_color || '#e0467a', '0xE0467A')
      const tFc = hexToDrawtext(ts.color || '#ffffff', 'white')
      const tPad = Math.max(0, Number(ts.bg_padding ?? 28))
      const tYpct = Math.max(0, Math.min(95, Number(ts.y_pos ?? 15))) / 100
      filters.push(
        `${vLabel}drawtext=fontfile=${BUNDLED_FONT_PATH}:text='${safe}':fontcolor=${tFc}:fontsize=${tSize}` +
        `:box=1:boxcolor=${tBg}:boxborderw=${tPad}` +
        `:x=(w-text_w)/2:y=h*${tYpct}-text_h/2[vt]`
      )
      vLabel = '[vt]'
    }

    if (logoPath) {
      const { w, x, y } = overlayPos(watermark_position, watermark_size_pct)
      filters.push(`[${logoIdx}:v]scale=${w}:-1[lg]`)
      filters.push(`${vLabel}[lg]overlay=${x}:${y}[vw]`)
      vLabel = '[vw]'
    }

    if (srtPath) {
      const cSize = Number(cs.size ?? 64) / 3
      const cText = hexToAssBgr(cs.text_color, '00FFFFFF')
      const cOut = hexToAssBgr(cs.outline_color, '00000000')
      const cThick = Math.max(0, Math.min(8, Number(cs.outline_thickness ?? 6) / 1.5))
      const cYpct = Math.max(40, Math.min(95, Number(cs.y_pos ?? 75))) / 100
      const marginV = Math.round(1920 * (1 - cYpct))
      // ffmpeg's subtitles filter takes a path with : escaped.
      const escSrt = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:')
      const escFontDir = dirname(BUNDLED_FONT_PATH).replace(/\\/g, '/').replace(/:/g, '\\:')
      filters.push(
        `${vLabel}subtitles='${escSrt}':fontsdir='${escFontDir}':force_style='` +
        `FontName=Sans Bold,Fontsize=${cSize.toFixed(0)},` +
        `PrimaryColour=&H${cText}&,OutlineColour=&H${cOut}&,` +
        `BorderStyle=1,Outline=${cThick.toFixed(1)},Shadow=0,` +
        `Alignment=2,MarginV=${marginV}` +
        `'[vs]`
      )
      vLabel = '[vs]'
    }

    let aLabel = '[0:a]'
    if (musicPath) {
      const vol = Math.max(0, Math.min(1, Number(music_volume)))
      const fade = Math.max(0, Math.min(8, Number(music_fade_secs ?? 1.5)))
      const fadeChain = fade > 0
        ? `volume=${vol},afade=t=out:st=${Math.max(0, estDuration - fade).toFixed(2)}:d=${fade.toFixed(2)},apad`
        : `volume=${vol},apad`
      filters.push(`[${musicIdx}:a]${fadeChain}[mus]`)
      filters.push(`${aLabel}[mus]amix=inputs=2:duration=first:dropout_transition=0[aout]`)
      aLabel = '[aout]'
    }

    if (vLabel === '[0:v]') { filters.push(`[0:v]null[vfin]`); vLabel = '[vfin]' }
    if (aLabel === '[0:a]') { filters.push(`[0:a]anull[afin]`); aLabel = '[afin]' }

    args.push('-filter_complex', filters.join(';'))
    args.push('-map', vLabel, '-map', aLabel)
    // ultrafast keeps re-encode under 30s for typical HeyGen output.
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23')
    args.push('-c:a', 'aac', '-b:a', '128k')
    args.push('-movflags', '+faststart')
    args.push(outPath)

    // ── 3. Run with one fallback if the overlay graph blows up ────────────
    try {
      await runFFmpeg(args)
    } catch (e) {
      console.warn('Polish: full chain failed, retrying minimal —', e.message)
      // Minimal pass: original audio + just the music mix if present, no overlays.
      const minArgs = ['-y', '-i', inPath]
      if (musicPath) {
        minArgs.push('-i', musicPath)
        const vol = Math.max(0, Math.min(1, Number(music_volume)))
        minArgs.push(
          '-filter_complex', `[1:a]volume=${vol}[m];[0:a][m]amix=inputs=2:duration=first[aout]`,
          '-map', '0:v', '-map', '[aout]',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        )
      } else {
        minArgs.push('-c', 'copy')
      }
      minArgs.push('-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outPath)
      await runFFmpeg(minArgs)
    }

    const outBuf = await readFile(outPath)

    // ── 4. Upload to storage ──────────────────────────────────────────────
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const path = `${profile_id}/spaces/polished/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
    const { error: upErr } = await supabase.storage.from('landing-media').upload(path, outBuf, {
      contentType: 'video/mp4', upsert: false,
    })
    if (upErr) return res.status(502).json({ error: `Upload failed: ${upErr.message}` })
    const { data: pub } = supabase.storage.from('landing-media').getPublicUrl(path)

    if (customerId) {
      try {
        await supaFetch('rpc/consume_credits', {
          method: 'POST',
          body: {
            p_customer_id: customerId, p_pool_type: 'ai_tokens', p_amount: fee,
            p_action: 'consume:video-polish', p_profile_id: profile_id,
            p_metadata: { video_url, has_logo: !!logoPath, has_music: !!musicPath, has_subs: !!srt, bytes: outBuf.byteLength },
          },
        })
      } catch {}
    }

    return res.status(200).json({ video_url: pub.publicUrl, bytes: outBuf.byteLength })
  } catch (err) {
    console.error('polish error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  } finally {
    if (workdir) {
      try { await rm(workdir, { recursive: true, force: true }) } catch {}
    }
  }
}
