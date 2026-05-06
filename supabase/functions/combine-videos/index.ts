// Supabase Edge Function — combine-videos
//
// Concatenates 2..N MP4 URLs into one stitched MP4 using ffmpeg-wasm,
// uploads the result to the `landing-media` bucket, returns the public URL.
//
// Deploy:
//   supabase functions deploy combine-videos --project-ref <ref>
//
// Caller: /api/videos/combine (Vercel) — forwards user requests with the
// service-role key in Authorization. We do NOT trust untrusted callers
// directly; the Vercel proxy authenticates the user + debits credits before
// invoking us. The function expects a Supabase service-role JWT.
//
// Body: { profile_id, video_urls: [...] }
// Returns: { video_url, bytes }

import { serve } from "https://deno.land/std@0.208.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { createFFmpeg, fetchFile } from "https://esm.sh/@ffmpeg/ffmpeg@0.12.10"

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || Deno.env.get('PROJECT_URL') || ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY') || ''

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { profile_id, video_urls } = await req.json()
    if (!profile_id || !Array.isArray(video_urls) || video_urls.length < 2) {
      return json({ error: 'profile_id + at least 2 video_urls required' }, 400)
    }

    const ffmpeg = createFFmpeg({ log: false })
    await ffmpeg.load()

    // 1. Download each clip into the in-memory FS.
    const list: string[] = []
    for (let i = 0; i < video_urls.length; i++) {
      const buf = await fetchFile(video_urls[i])
      const fname = `clip_${i}.mp4`
      ffmpeg.FS('writeFile', fname, buf)
      list.push(fname)
    }

    // 2. Concat via filter_complex (no copy — re-encodes for safe joins
    //    when sources have different codecs / sizes).
    const inputs: string[] = []
    let filter = ''
    for (let i = 0; i < list.length; i++) {
      inputs.push('-i', list[i])
      filter += `[${i}:v:0][${i}:a:0?]`
    }
    filter += `concat=n=${list.length}:v=1:a=1[v][a]`

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
    const bytes = data.byteLength

    // 3. Upload to landing-media via service role.
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const path = `${profile_id}/spaces/combined/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
    const { error: upErr } = await supabase.storage.from('landing-media').upload(path, data.buffer, {
      contentType: 'video/mp4', upsert: false,
    })
    if (upErr) return json({ error: `Upload failed: ${upErr.message}` }, 502)

    const { data: pub } = supabase.storage.from('landing-media').getPublicUrl(path)
    return json({ video_url: pub.publicUrl, bytes })
  } catch (err) {
    return json({ error: String(err?.message || err) }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  }
}
