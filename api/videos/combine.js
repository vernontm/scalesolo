// POST /api/videos/combine
// Body: { profile_id, video_urls: [...] }
// Returns: { video_url } — the stitched MP4 in landing-media.
//
// Runs ffmpeg-wasm 0.10.x directly inside this Vercel Node function.
// We tried Supabase Edge Functions first but Deno Deploy has no
// SharedArrayBuffer / Web Worker support and 0.10.x's `ffmpeg.load()`
// can't fetch the WASM core blob there. Node has neither restriction,
// so we just download each clip, concat, and upload via service role.
//
// Notes:
// - Use the concat *demuxer* with `-c copy` whenever clips share codec/
//   container (HeyGen output is consistent), so we skip re-encode and
//   stay well under Vercel's timeout.
// - WASM core is fetched at runtime from unpkg, so the Vercel deploy
//   bundle stays small (the @ffmpeg/ffmpeg npm package itself is ~30KB).

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { createClient } from '@supabase/supabase-js'
import { createFFmpeg } from '@ffmpeg/ffmpeg'
import { readFile } from 'node:fs/promises'

// Allow up to 5 minutes for big stitches. Hobby plan caps at 60s; if you
// hit that, upgrade to Pro or pre-flight reject huge clip counts.
export const config = { maxDuration: 300 }

let _ffmpegInstance = null
async function getFFmpeg() {
  if (_ffmpegInstance && _ffmpegInstance.isLoaded()) return _ffmpegInstance
  // In Node, @ffmpeg/ffmpeg 0.10.x resolves the core via `require('@ffmpeg/core')`
  // — passing a URL corePath would break that. We installed @ffmpeg/core@0.10.0
  // as a dep so the default resolution just works.
  const ff = createFFmpeg({ log: false })

  // Emscripten's WASM loader calls globalThis.fetch(<absolute path>) on Node,
  // and Node 20's undici fetch rejects bare paths with "Failed to parse URL".
  // Wrap fetch so absolute paths get served from disk; fall back to the real
  // fetch for everything else. Restore after load.
  const savedFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url || String(input))
    if (url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(url)) {
      const buf = await readFile(url)
      return new Response(buf, { status: 200, headers: { 'Content-Type': 'application/wasm' } })
    }
    return savedFetch(input, init)
  }
  try {
    await ff.load()
  } finally {
    globalThis.fetch = savedFetch
  }
  _ffmpegInstance = ff
  return ff
}

async function fetchToBytes(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Fetch ${url} failed: ${r.status}`)
  const ab = await r.arrayBuffer()
  return new Uint8Array(ab)
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, video_urls } = req.body || {}
    if (!profile_id || !Array.isArray(video_urls) || video_urls.length < 2) {
      return res.status(400).json({ error: 'profile_id + at least 2 video_urls required' })
    }
    await assertProfileAccess(auth.user.id, profile_id)

    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
    const customerId = cust?.[0]?.id
    const fee = 1500 + 500 * video_urls.length
    if (customerId) {
      const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`)
      if ((Number(pools?.[0]?.balance ?? 0)) < fee) {
        return res.status(402).json({ error: 'Insufficient AI tokens for combine.', code: 'insufficient_credits' })
      }
    }

    const SUPABASE_URL = process.env.SUPABASE_URL
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
    if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Storage not configured' })

    const ffmpeg = await getFFmpeg()

    // 1. Download each clip into ffmpeg's in-memory FS.
    for (let i = 0; i < video_urls.length; i++) {
      const bytes = await fetchToBytes(video_urls[i])
      ffmpeg.FS('writeFile', `clip_${i}.mp4`, bytes)
    }

    // 2. Try the fast path first: concat demuxer + stream copy. HeyGen's
    //    output is consistent enough that this works for the typical case
    //    and avoids the multi-minute re-encode.
    const listText = video_urls.map((_, i) => `file 'clip_${i}.mp4'`).join('\n') + '\n'
    ffmpeg.FS('writeFile', 'list.txt', new TextEncoder().encode(listText))

    let outBytes = null
    try {
      await ffmpeg.run(
        '-f', 'concat', '-safe', '0',
        '-i', 'list.txt',
        '-c', 'copy',
        '-movflags', '+faststart',
        'out.mp4',
      )
      outBytes = ffmpeg.FS('readFile', 'out.mp4')
    } catch (e) {
      // Fast path failed (codec / timestamp mismatch). Fall through to
      // re-encode with filter_complex so mismatched clips still stitch.
      try { ffmpeg.FS('unlink', 'out.mp4') } catch {}
    }

    if (!outBytes || !outBytes.byteLength) {
      const inputs = []
      let filter = ''
      for (let i = 0; i < video_urls.length; i++) {
        inputs.push('-i', `clip_${i}.mp4`)
        filter += `[${i}:v:0][${i}:a:0?]`
      }
      filter += `concat=n=${video_urls.length}:v=1:a=1[v][a]`
      await ffmpeg.run(
        ...inputs,
        '-filter_complex', filter,
        '-map', '[v]', '-map', '[a]?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        'out.mp4',
      )
      outBytes = ffmpeg.FS('readFile', 'out.mp4')
    }

    // Free the input files so a warm container doesn't accumulate them.
    for (let i = 0; i < video_urls.length; i++) {
      try { ffmpeg.FS('unlink', `clip_${i}.mp4`) } catch {}
    }
    try { ffmpeg.FS('unlink', 'list.txt') } catch {}
    try { ffmpeg.FS('unlink', 'out.mp4') } catch {}

    // 3. Upload via service role.
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const path = `${profile_id}/spaces/combined/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
    const buf = Buffer.from(outBytes.buffer, outBytes.byteOffset, outBytes.byteLength)
    const { error: upErr } = await supabase.storage.from('landing-media').upload(path, buf, {
      contentType: 'video/mp4', upsert: false,
    })
    if (upErr) return res.status(502).json({ error: `Upload failed: ${upErr.message}` })

    const { data: pub } = supabase.storage.from('landing-media').getPublicUrl(path)
    const video_url = pub.publicUrl

    if (customerId) {
      try {
        await supaFetch('rpc/consume_credits', {
          method: 'POST',
          body: {
            p_customer_id: customerId,
            p_pool_type: 'ai_tokens',
            p_amount: fee,
            p_action: 'consume:combine-videos',
            p_profile_id: profile_id,
            p_metadata: { clips: video_urls.length, bytes: outBytes.byteLength },
          },
        })
      } catch {}
    }

    return res.status(200).json({ video_url, bytes: outBytes.byteLength, clips: video_urls.length })
  } catch (err) {
    console.error('combine-videos error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
