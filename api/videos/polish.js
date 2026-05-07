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

export const config = { maxDuration: 300 }

let _ffmpeg = null
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

// TikTok-style: 3 words/chunk, uppercase, evenly spaced over the
// estimated voice duration. Good enough for rough caption burn-in.
function buildSrt(script, totalSecs, wordsPerChunk = 3) {
  const words = String(script || '').replace(/[*_`]/g, '').split(/\s+/).filter(Boolean)
  if (!words.length || !totalSecs) return ''
  const chunks = []
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(' ').toUpperCase())
  }
  const dur = totalSecs / chunks.length
  return chunks
    .map((text, i) => `${i + 1}\n${srtTime(i * dur)} --> ${srtTime((i + 1) * dur)}\n${text}\n`)
    .join('\n')
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
      watermark_position = 'br',
      watermark_size_pct = 12,
      music_volume = 0.15,
    } = req.body || {}

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

    // ── 1. Stage inputs ────────────────────────────────────────────────────
    const videoBytes = await fetchToBytes(video_url)
    ffmpeg.FS('writeFile', 'in.mp4', videoBytes)

    let logoExt = null
    if (logo_url && watermark_position && watermark_position !== 'none') {
      try {
        const bytes = await fetchToBytes(logo_url)
        logoExt = (logo_url.split('?')[0].split('.').pop() || 'png').toLowerCase()
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
    const srt = script ? buildSrt(script, estDuration) : ''
    if (srt) ffmpeg.FS('writeFile', 'subs.srt', new TextEncoder().encode(srt))

    // ── 2. Build inputs + filter graph ─────────────────────────────────────
    const args = ['-i', 'in.mp4']
    let nextIdx = 1
    let logoIdx = -1, musicIdx = -1
    if (logoExt) { args.push('-i', `logo.${logoExt}`); logoIdx = nextIdx++ }
    if (hasMusic) { args.push('-i', 'music.mp3'); musicIdx = nextIdx++ }

    const filters = []
    let vLabel = '[0:v]'

    if (title) {
      const safe = escDrawtext(String(title).slice(0, 80))
      filters.push(`${vLabel}drawtext=text='${safe}':fontcolor=white:fontsize=64:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h*0.08[vt]`)
      vLabel = '[vt]'
    }

    if (logoExt) {
      const { w, x, y } = overlayPos(watermark_position, watermark_size_pct)
      filters.push(`[${logoIdx}:v]scale=${w}:-1[lg]`)
      filters.push(`${vLabel}[lg]overlay=${x}:${y}[vw]`)
      vLabel = '[vw]'
    }

    if (srt) {
      filters.push(
        `${vLabel}subtitles=subs.srt:force_style='FontName=Sans,Fontsize=22,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,BorderStyle=1,Outline=2,Alignment=2,MarginV=80'[vs]`
      )
      vLabel = '[vs]'
    }

    let aLabel = '[0:a]'
    if (hasMusic) {
      const vol = Math.max(0, Math.min(1, Number(music_volume)))
      filters.push(`[${musicIdx}:a]volume=${vol},apad[mus]`)
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

    await ffmpeg.run(...args)
    const outBytes = ffmpeg.FS('readFile', 'out.mp4')

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
