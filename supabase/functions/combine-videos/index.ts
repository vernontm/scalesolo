// Supabase Edge Function — combine-videos
//
// Concatenates 2..N MP4 URLs into one stitched MP4 using ffmpeg-wasm,
// uploads the result to the `landing-media` bucket, returns the public URL.
//
// Deploy:
//   supabase functions deploy combine-videos --project-ref vbvmfiepwyxlfafbwtkb
//
// Note on the FFmpeg version: the 0.12.x line uses Web Workers and
// SharedArrayBuffer which Supabase's Deno Deploy runtime does not support
// (cross-origin-isolated headers required). The 0.10.x line is single-
// threaded and runs cleanly in Deno; we use 0.10.1 here, imported via
// esm.sh's Deno target so the package resolves correctly.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { createFFmpeg, fetchFile } from "https://esm.sh/@ffmpeg/ffmpeg@0.10.1?target=deno"

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || Deno.env.get('PROJECT_URL') || ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY') || ''

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() })
  if (req.method !== 'POST') return j({ error: 'Method not allowed' }, 405)

  try {
    const { profile_id, video_urls } = await req.json()
    if (!profile_id || !Array.isArray(video_urls) || video_urls.length < 2) {
      return j({ error: 'profile_id + at least 2 video_urls required' }, 400)
    }

    const ffmpeg = createFFmpeg({ log: false, corePath: 'https://unpkg.com/@ffmpeg/core@0.10.0/dist/ffmpeg-core.js' })
    if (!ffmpeg.isLoaded()) await ffmpeg.load()

    // 1. Download each clip into the in-memory FS.
    for (let i = 0; i < video_urls.length; i++) {
      const buf = await fetchFile(video_urls[i])
      ffmpeg.FS('writeFile', `clip_${i}.mp4`, buf)
    }

    // 2. Build filter_complex so re-encoding handles mismatched codecs/sizes.
    const inputs: string[] = []
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
      'out.mp4'
    )

    const data = ffmpeg.FS('readFile', 'out.mp4')

    // 3. Upload via service role.
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const path = `${profile_id}/spaces/combined/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
    const { error: upErr } = await supabase.storage.from('landing-media').upload(path, data.buffer, {
      contentType: 'video/mp4', upsert: false,
    })
    if (upErr) return j({ error: `Upload failed: ${upErr.message}` }, 502)

    const { data: pub } = supabase.storage.from('landing-media').getPublicUrl(path)
    return j({ video_url: pub.publicUrl, bytes: data.byteLength, clips: video_urls.length })
  } catch (err: any) {
    console.error('combine-videos error:', err?.stack || err)
    return j({ error: String(err?.message || err) }, 500)
  }
})

function j(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  })
}
function cors(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  }
}
