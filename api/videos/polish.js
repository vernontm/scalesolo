// POST /api/videos/polish
// Body: {
//   profile_id, video_url,
//   logo_url?, music_url?,
//   script?,                       // for auto-burned subtitles (TikTok-chunked)
//   title?,                        // optional big top overlay
//   watermark_position?,           // 'tr' | 'tl' | 'br' | 'bl' | 'none'
//   watermark_size_pct?,           // 2..40, default 12
//   music_volume?,                 // 0..1, default 0.15
// }
// Returns: { video_url, bytes }
//
// Single-pass ffmpeg-wasm filter chain that:
//   1. Optional title drawtext at top.
//   2. Optional logo overlay scaled to N% of width, padded into a corner.
//   3. Optional auto-subtitles burned in via the `subtitles` filter,
//      generated from the upstream script (3-word chunks, uppercase).
//   4. Optional background music duck-mixed under the original audio.
//
// Designed to mirror VTM's renderFinal() but run inside this Vercel
// Node function. Uses the same ffmpeg-wasm setup as combine.js — see
// that file for the rationale on @ffmpeg/core + fetch wrapper.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { createClient } from '@supabase/supabase-js'
import { createFFmpeg } from '@ffmpeg/ffmpeg'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUNDLED_FONT_PATH = join(__dirname, '..', '_fonts', 'Sans-Bold.ttf')

export const config = { maxDuration: 300 }

let _ffmpeg = null
let _fontMounted = false
async function getFFmpeg() {
  if (_ffmpeg && _ffmpeg.isLoaded()) return _ffmpeg
  const ff = createFFmpeg({ log: false })
  // Same fetch-shim as combine.js so Emscripten can read the WASM core
  // off disk under Node 20 / undici.
  const savedFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url || String(input))
    if (url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(url)) {
      const buf = await readFile(url)
      return new Response(buf, { status: 200, headers: { 'Content-Type': 'application/wasm' } })
    }
    return savedFetch(input, init)
  }
  try { await ff.load() } finally { globalThis.fetch = savedFetch }
  _ffmpeg = ff
  return ff
}

// drawtext + libass need an actual font on disk inside ffmpeg's MEMFS.
// We ship Sans-Bold.ttf with the deploy and mount it once per warm
// container. Without this, the render silently fails ("readFile out.mp4"
// because ffmpeg.run aborted with no output).
async function ensureFontMounted(ff) {
  if (_fontMounted) return
  try {
    const bytes = await readFile(BUNDLED_FONT_PATH)
    ff.FS('writeFile', 'Sans.ttf', new Uint8Array(bytes))
    _fontMounted = true
  } catch (e) {
    console.warn('Polish: font mount failed —', e.message, '— title/subtitles may render with default')
  }
}

function fileExists(ff, name) {
  try { ff.FS('stat', name); return true } catch { return false }
}

async function fetchToBytes(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Fetch ${url} → ${r.status}`)
  const ab = await r.arrayBuffer()
  return new Uint8Array(ab)
}

function srtTime(s) {
  const ms = Math.max(0, Math.round(s * 1000))
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0')
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0')
  const sec = String(Math.floor(ms / 1000) % 60).padStart(2, '0')
  const milli = String(ms % 1000).padStart(3, '0')
  return `${h}:${m}:${sec},${milli}`
}

// TikTok-style: N words/chunk, uppercase, evenly spaced over the
// estimated voice duration. Good enough for rough caption burn-in.
function buildSrt(script, totalSecs, wordsPerChunk = 3) {
  const words = String(script || '').replace(/[*_`]/g, '').split(/\s+/).filter(Boolean)
  if (!words.length || !totalSecs) return ''
  const chunks = []
  const wpc = Math.max(1, Math.min(6, Number(wordsPerChunk) || 3))
  for (let i = 0; i < words.length; i += wpc) {
    chunks.push(words.slice(i, i + wpc).join(' ').toUpperCase())
  }
  const dur = totalSecs / chunks.length
  return chunks
    .map((text, i) => `${i + 1}\n${srtTime(i * dur)} --> ${srtTime((i + 1) * dur)}\n${text}\n`)
    .join('\n')
}

// libass uses BGR hex with alpha prefix (00 = opaque). Input expects '#RRGGBB'.
function hexToAssBgr(hex, fallback = '00FFFFFF') {
  if (!hex || typeof hex !== 'string') return fallback
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return fallback
  const rr = m[1].slice(0, 2)
  const gg = m[1].slice(2, 4)
  const bb = m[1].slice(4, 6)
  return `00${bb}${gg}${rr}`.toUpperCase()
}

// drawtext box color expects 0xRRGGBB@A or AARRGGBB.
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

// drawtext is fussy about colons, quotes, backslashes, and percent signs.
function escDrawtext(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "’")  // straight apostrophe → curly to dodge ffmpeg quoting
    .replace(/%/g, '\\%')
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const {
      profile_id, video_url,
      logo_url, music_url, script, title,
      title_style,             // { font, color, bg_color, size, bg_padding, y_pos, uppercase }
      caption_style,           // { font, words_per_chunk, text_color, outline_color, outline_thickness, highlight_color, size, y_pos }
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

    const ffmpeg = await getFFmpeg()
    await ensureFontMounted(ffmpeg)

    // ── 1. Stage inputs ────────────────────────────────────────────────────
    const videoBytes = await fetchToBytes(video_url)
    ffmpeg.FS('writeFile', 'in.mp4', videoBytes)

    // Prefer the explicitly-uploaded watermark image if the user picked one
    // in the editor — otherwise fall back to whatever the wired-in input
    // produced (brand logo / image_upload / image_gen first frame).
    const effectiveLogoUrl = req.body?.watermark_image_url || logo_url
    let logoExt = null
    if (effectiveLogoUrl && watermark_position && watermark_position !== 'none') {
      try {
        const bytes = await fetchToBytes(effectiveLogoUrl)
        logoExt = (effectiveLogoUrl.split('?')[0].split('.').pop() || 'png').toLowerCase()
        if (!['png', 'jpg', 'jpeg', 'webp'].includes(logoExt)) logoExt = 'png'
        ffmpeg.FS('writeFile', `logo.${logoExt}`, bytes)
      } catch { logoExt = null }
    }

    let hasMusic = false
    if (music_url) {
      try {
        const bytes = await fetchToBytes(music_url)
        ffmpeg.FS('writeFile', 'music.mp3', bytes)
        hasMusic = true
      } catch { hasMusic = false }
    }

    // Estimate voice duration so SRT timestamps line up. Without ffprobe
    // we use ~2.5 words/sec which matches HeyGen's pacing closely.
    const wordCount = String(script || '').split(/\s+/).filter(Boolean).length
    const estDuration = Math.max(3, Math.round(wordCount / 2.5))
    const srt = script ? buildSrt(script, estDuration, cs.words_per_chunk) : ''
    if (srt) ffmpeg.FS('writeFile', 'subs.srt', new TextEncoder().encode(srt))

    // ── 2. Build inputs + filter graph ─────────────────────────────────────
    const args = ['-i', 'in.mp4']
    let nextIdx = 1
    let logoIdx = -1, musicIdx = -1
    if (logoExt) { args.push('-i', `logo.${logoExt}`); logoIdx = nextIdx++ }
    if (hasMusic) { args.push('-i', 'music.mp3'); musicIdx = nextIdx++ }

    const filters = []
    let vLabel = '[0:v]'

    if (title && _fontMounted) {
      // Big title block — bg-boxed drawtext at title_y_pos% from top.
      const text = ts.uppercase ? String(title).toUpperCase() : String(title)
      const safe = escDrawtext(text.slice(0, 120))
      const tSize = Number(ts.size ?? 72)
      const tBg = hexToDrawtext(ts.bg_color || '#e0467a', '0xE0467A')
      const tFc = hexToDrawtext(ts.color || '#ffffff', 'white')
      const tPad = Math.max(0, Number(ts.bg_padding ?? 28))
      const tYpct = Math.max(0, Math.min(95, Number(ts.y_pos ?? 15))) / 100
      filters.push(
        `${vLabel}drawtext=fontfile=Sans.ttf:text='${safe}':fontcolor=${tFc}:fontsize=${tSize}` +
        `:box=1:boxcolor=${tBg}:boxborderw=${tPad}` +
        `:x=(w-text_w)/2:y=h*${tYpct}-text_h/2[vt]`
      )
      vLabel = '[vt]'
    }

    if (logoExt) {
      const { w, x, y } = overlayPos(watermark_position, watermark_size_pct)
      filters.push(`[${logoIdx}:v]scale=${w}:-1[lg]`)
      filters.push(`${vLabel}[lg]overlay=${x}:${y}[vw]`)
      vLabel = '[vw]'
    }

    if (srt && _fontMounted) {
      // libass force_style — Primary/Outline colors converted to BGR.
      // Y position approximated assuming a 1920px-tall 9:16 source. We
      // can't ffprobe inside ffmpeg-wasm easily, so this is a working
      // estimate that lines up with HeyGen's standard output.
      // We expose the bundled font as "Sans" via fontsdir=. and ignore
      // the user's font choice for now — libass with a single mounted
      // .ttf can only resolve that one face.
      const cSize = Number(cs.size ?? 64) / 3
      const cText = hexToAssBgr(cs.text_color, '00FFFFFF')
      const cOut = hexToAssBgr(cs.outline_color, '00000000')
      const cThick = Math.max(0, Math.min(8, Number(cs.outline_thickness ?? 6) / 1.5))
      const cYpct = Math.max(40, Math.min(95, Number(cs.y_pos ?? 75))) / 100
      const marginV = Math.round(1920 * (1 - cYpct))
      filters.push(
        `${vLabel}subtitles=subs.srt:fontsdir=.:force_style='` +
        `FontName=Sans,Fontsize=${cSize.toFixed(0)},` +
        `PrimaryColour=&H${cText}&,OutlineColour=&H${cOut}&,` +
        `BorderStyle=1,Outline=${cThick.toFixed(1)},Shadow=0,` +
        `Alignment=2,MarginV=${marginV}` +
        `'[vs]`
      )
      vLabel = '[vs]'
    }

    let aLabel = '[0:a]'
    if (hasMusic) {
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
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23')
    args.push('-c:a', 'aac', '-b:a', '128k')
    args.push('-movflags', '+faststart')
    args.push('out.mp4')

    // ffmpeg-wasm 0.10.x doesn't reliably throw when run() fails — it just
    // prints to its (silenced) log and out.mp4 never gets created. Retry
    // with progressively simpler filter chains so a syntax issue in the
    // overlay graph doesn't kill the whole render.
    let outBytes = null
    let lastError = null
    const fallbackPasses = [
      { args, label: 'full chain' },
    ]
    // Strip subtitles if present.
    if (srt && _fontMounted) {
      const noSub = filters.filter((f) => !f.includes('subtitles=subs.srt'))
      // Re-thread vLabel after the cut: last filter that ends in [vs] is gone,
      // so use the prior vLabel (one before subtitles ran).
      let vIn = '[0:v]'
      if (title && _fontMounted) vIn = '[vt]'
      if (logoExt) vIn = '[vw]'
      noSub.push(`${vIn}null[vfin2]`)
      const noSubArgs = [...args]
      const fcIdx = noSubArgs.indexOf('-filter_complex')
      noSubArgs[fcIdx + 1] = noSub.join(';')
      const mapIdx = noSubArgs.indexOf('-map', fcIdx + 1)
      noSubArgs[mapIdx + 1] = '[vfin2]'
      fallbackPasses.push({ args: noSubArgs, label: 'no subtitles' })
    }
    // Strip everything visual — just remux audio mix.
    const minimalArgs = ['-i', 'in.mp4']
    if (hasMusic) {
      minimalArgs.push('-i', 'music.mp3')
      const vol = Math.max(0, Math.min(1, Number(music_volume)))
      minimalArgs.push(
        '-filter_complex', `[1:a]volume=${vol}[m];[0:a][m]amix=inputs=2:duration=first[aout]`,
        '-map', '0:v', '-map', '[aout]',
      )
    } else {
      minimalArgs.push('-c', 'copy')
    }
    minimalArgs.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', 'out.mp4')
    fallbackPasses.push({ args: minimalArgs, label: 'minimal (no overlays)' })

    for (const pass of fallbackPasses) {
      try { ffmpeg.FS('unlink', 'out.mp4') } catch {}
      try {
        await ffmpeg.run(...pass.args)
      } catch (e) {
        lastError = e
        continue
      }
      if (fileExists(ffmpeg, 'out.mp4')) {
        outBytes = ffmpeg.FS('readFile', 'out.mp4')
        if (pass.label !== 'full chain') {
          console.warn(`Polish: fell back to "${pass.label}" — earlier passes failed`)
        }
        break
      }
    }
    if (!outBytes) {
      throw new Error(`Render failed (filter chain rejected by ffmpeg). ${lastError?.message || ''}`.trim())
    }

    // Free FS so warm containers don't accumulate.
    for (const f of ['in.mp4', 'out.mp4', 'subs.srt', 'music.mp3', logoExt && `logo.${logoExt}`].filter(Boolean)) {
      try { ffmpeg.FS('unlink', f) } catch {}
    }

    // ── 3. Upload ──────────────────────────────────────────────────────────
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const path = `${profile_id}/spaces/polished/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
    const buf = Buffer.from(outBytes.buffer, outBytes.byteOffset, outBytes.byteLength)
    const { error: upErr } = await supabase.storage.from('landing-media').upload(path, buf, {
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
            p_metadata: { video_url, has_logo: !!logoExt, has_music: hasMusic, has_subs: !!srt, bytes: outBytes.byteLength },
          },
        })
      } catch {}
    }

    return res.status(200).json({ video_url: pub.publicUrl, bytes: outBytes.byteLength })
  } catch (err) {
    console.error('polish error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
