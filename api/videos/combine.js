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
import { randomUUID } from 'node:crypto'

// Allow up to 5 minutes for big stitches. Hobby plan caps at 60s; if you
// hit that, upgrade to Pro or pre-flight reject huge clip counts.
export const config = { maxDuration: 300 }

// Cache the FFmpeg instance + the in-flight load promise so two
// simultaneous cold-start calls don't both monkey-patch globalThis.fetch
// (the loader writes globalThis.fetch during load() — without
// single-flight, the second caller's `savedFetch` capture races and
// permanently swallows real HTTPS calls until restore).
let _ffmpegInstance = null
let _ffmpegLoadPromise = null

async function getFFmpeg() {
  if (_ffmpegInstance && _ffmpegInstance.isLoaded()) return _ffmpegInstance
  if (_ffmpegLoadPromise) return _ffmpegLoadPromise
  _ffmpegLoadPromise = (async () => {
    const ff = createFFmpeg({ log: false })
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
  })()
  try {
    return await _ffmpegLoadPromise
  } finally {
    _ffmpegLoadPromise = null
  }
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

    // FFmpeg-wasm has ONE in-memory filesystem per instance, and we
    // share that instance across invocations on the same warm Lambda
    // for cold-start perf. To keep two concurrent renders from
    // clobbering each other's clip / list / output files, every FS path
    // is prefixed with a per-request UUID. Cleanup unlinks on success
    // and on error.
    const ns = randomUUID().slice(0, 8)
    const clipName = (i) => `${ns}-clip_${i}.mp4`
    const listName = `${ns}-list.txt`
    const outName  = `${ns}-out.mp4`
    const inputsCreated = []

    let outBytes = null
    try {
      // 1. Download each clip into ffmpeg's in-memory FS.
      for (let i = 0; i < video_urls.length; i++) {
        const bytes = await fetchToBytes(video_urls[i])
        ffmpeg.FS('writeFile', clipName(i), bytes)
        inputsCreated.push(clipName(i))
      }

      // 2. Try the fast path first: concat demuxer + stream copy. HeyGen's
      //    output is consistent enough that this works for the typical case
      //    and avoids the multi-minute re-encode.
      const listText = video_urls.map((_, i) => `file '${clipName(i)}'`).join('\n') + '\n'
      ffmpeg.FS('writeFile', listName, new TextEncoder().encode(listText))

      try {
        await ffmpeg.run(
          '-f', 'concat', '-safe', '0',
          '-i', listName,
          '-c', 'copy',
          '-movflags', '+faststart',
          outName,
        )
        outBytes = ffmpeg.FS('readFile', outName)
      } catch (e) {
        // Fast path failed (codec / timestamp mismatch). Fall through to
        // re-encode with filter_complex so mismatched clips still stitch.
        try { ffmpeg.FS('unlink', outName) } catch {}
      }

      if (!outBytes || !outBytes.byteLength) {
        const inputs = []
        let filter = ''
        for (let i = 0; i < video_urls.length; i++) {
          inputs.push('-i', clipName(i))
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
          outName,
        )
        outBytes = ffmpeg.FS('readFile', outName)
      }
    } finally {
      // Cleanup every FS path we touched so a warm container doesn't
      // accumulate them. `try` per file because some may not exist
      // (e.g. mid-fastpath error before listName was written).
      for (const f of inputsCreated) {
        try { ffmpeg.FS('unlink', f) } catch {}
      }
      try { ffmpeg.FS('unlink', listName) } catch {}
      try { ffmpeg.FS('unlink', outName)  } catch {}
    }

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
      // consume_credits is atomic on the DB side (FOR UPDATE → check →
      // update inside one plpgsql function). It still CAN fail on a
      // tight race where two concurrent requests both pass the
      // pre-check and only one wins the row lock — at that point the
      // render is already done + uploaded. Don't swallow: log loudly
      // and tag the row so it can be reconciled later. We deliberately
      // do NOT delete the upload (the user already sees the result and
      // shouldn't lose work over a race we can fix in support).
      try {
        const result = await supaFetch('rpc/consume_credits', {
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
        // RPC returns { success, error_code, ... } — check the shape.
        if (result && typeof result === 'object' && result.success === false) {
          console.error('combine-videos: consume_credits returned failure', {
            customerId, fee, error_code: result.error_code, profile_id,
          })
          try {
            const { captureApiError } = await import('../_lib/sentry.js')
            captureApiError(new Error('consume_credits returned success=false'), {
              route: 'combine-videos:consume',
              userId: auth.user.id,
              profileId: profile_id,
              extra: { customerId, fee, error_code: result.error_code, kind: 'free_generation_leak' },
            })
          } catch {}
        }
      } catch (e) {
        console.error('combine-videos: consume_credits threw', {
          customerId, fee, profile_id, message: e?.message,
        })
        try {
          const { captureApiError } = await import('../_lib/sentry.js')
          captureApiError(e, {
            route: 'combine-videos:consume',
            userId: auth.user.id,
            profileId: profile_id,
            extra: { customerId, fee, kind: 'free_generation_leak' },
          })
        } catch {}
      }
    }

    return res.status(200).json({ video_url, bytes: outBytes.byteLength, clips: video_urls.length })
  } catch (err) {
    console.error('combine-videos error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
