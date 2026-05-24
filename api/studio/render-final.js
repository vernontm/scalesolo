// POST /api/studio/render-final — final long-form bake.
//
// Stitches every approved studio_segment into a single MP4. v1 runs
// on Vercel with native ffmpeg via @ffmpeg-installer/ffmpeg, mirroring
// the pattern that api/videos/polish.js already uses. The HyperFrames
// motion-graphics rendering (the real animated title cards / stat
// reveals / etc.) is deferred to a Fly worker — for now, motion
// graphics segments render as styled drawtext overlays so the bake
// still produces a watchable end-to-end MP4.
//
// Per-segment intermediate chunks:
//
//   avatar:                  avatar_video_url (already has voice baked
//                            in by HeyGen since we passed audio_url at
//                            submission time). No re-encode if it's
//                            already in our target codec.
//
//   voiceover_broll:         image_url as a still + voice audio,
//                            duration = voice_duration_secs. Subtle
//                            Ken Burns zoom for motion.
//
//   voiceover_motion_graphics: dark background + drawtext overlay
//                            (script_text wrapped to width) + voice.
//                            Real HyperFrames render lands in the Fly
//                            worker swap.
//
//   pure_motion_graphics:    dark background + drawtext (title /
//                            script_text) + sound_effect if any. Hold
//                            for ~2.5s.
//
// Concat is via the concat demuxer with stream-copy whenever every
// chunk shares the same codec (always, since we control encoding).
// Falls back to filter_complex re-encode if the fast path errors.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { gateStudio } from './_lib/gate.js'

const ffmpegPath = ffmpegInstaller.path
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const STUDIO_BUCKET = 'studio-media'

export const config = {
  maxDuration: 300,
  memory: 3008,
  includeFiles: '{node_modules/@ffmpeg-installer/**,api/_fonts/**}',
}

// ── ffmpeg helpers ──────────────────────────────────────────────────────────
function runFFmpeg(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr += d.toString('utf8')
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
    })
    proc.stdout.on('data', () => { /* drain */ })
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stderr)
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.split('\n').slice(-10).join('\n')}`))
    })
  })
}

// Probe duration of an audio file via ffprobe (bundled with ffmpeg-installer).
// Falls back to 0 on failure — caller treats 0 as "use default 4s hold."
async function probeAudioDurationSecs(path) {
  return new Promise((resolve) => {
    const args = ['-i', path, '-hide_banner', '-f', 'null', '-']
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    proc.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/)
      if (!m) return resolve(0)
      const [, hh, mm, ss] = m
      resolve(Number(hh) * 3600 + Number(mm) * 60 + Number(ss))
    })
    proc.on('error', () => resolve(0))
  })
}

// Download a remote URL to a local file inside the work dir.
async function downloadTo(url, dest) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Download failed (${r.status}) for ${url.slice(0, 80)}`)
  const buf = Buffer.from(await r.arrayBuffer())
  await writeFile(dest, buf)
  return dest
}

// Aspect ratio → ffmpeg dimensions
function dimensions(aspect) {
  if (aspect === '9:16') return { w: 1080, h: 1920 }
  if (aspect === '1:1')  return { w: 1080, h: 1080 }
  return { w: 1920, h: 1080 }
}

// Sanitize for drawtext: ffmpeg's filter parser explodes on quotes, colons,
// commas, backslashes. textfile= sidesteps most of it; we still drop control
// chars that break libfreetype.
function safeDrawTextLine(s) {
  // Strip ASCII control chars + DEL so libfreetype doesn't choke on them.
  // eslint-disable-next-line no-control-regex
  return String(s || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim()
}

// Word-wrap a long script line to a target visual width. Naive but works for
// the 80-char-ish lines Studio scripts produce.
function wrapText(text, perLine = 38) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > perLine && cur) {
      lines.push(cur)
      cur = w
    } else {
      cur = (cur ? cur + ' ' : '') + w
    }
  }
  if (cur) lines.push(cur)
  return lines.slice(0, 6).join('\n')
}

// ── Per-segment chunk renderers ─────────────────────────────────────────────
async function renderAvatarChunk(seg, paths, dim) {
  // Avatar mp4 already has voice baked in via HeyGen audio_url path. Just
  // normalize to our target codec/resolution and re-encode so concat doesn't
  // hit a timestamp mismatch downstream.
  const inFile = paths.avatarMp4
  const outFile = paths.outChunk
  await runFFmpeg([
    '-y', '-i', inFile,
    '-vf', `scale=${dim.w}:${dim.h}:force_original_aspect_ratio=increase,crop=${dim.w}:${dim.h}`,
    '-r', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outFile,
  ], 120_000)
  return outFile
}

async function renderBrollChunk(seg, paths, dim, durationSecs) {
  // Still image looped for the voice duration, with a subtle 1.0→1.06 zoom
  // (Ken Burns) for motion. Mix in the voice audio.
  const outFile = paths.outChunk
  // zoompan reads frame rate; we set 30fps everywhere.
  const totalFrames = Math.max(30, Math.ceil(durationSecs * 30))
  const vf =
    `scale=${dim.w * 1.2}:${dim.h * 1.2}:force_original_aspect_ratio=increase,` +
    `crop=${dim.w * 1.2}:${dim.h * 1.2},` +
    `zoompan=z='min(zoom+0.0006,1.06)':d=${totalFrames}:s=${dim.w}x${dim.h}:fps=30`
  await runFFmpeg([
    '-y',
    '-loop', '1', '-t', String(durationSecs.toFixed(3)), '-i', paths.image,
    '-i', paths.voice,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-pix_fmt', 'yuv420p',
    '-shortest',
    '-movflags', '+faststart',
    outFile,
  ], 120_000)
  return outFile
}

async function renderMotionChunk(seg, paths, dim, durationSecs, fontPath) {
  // v1 placeholder for HyperFrames motion graphics. Dark bg + the segment's
  // hyperframes_variables.title (or script_text, or composition_id) as a
  // centered headline. Real HyperFrames render lands in the Fly worker.
  const v = seg.hyperframes_variables || {}
  const headline = v.title || v.quote || v.stat_number || seg.script_text || ''
  const sub = v.subtitle || v.stat_label || v.attribution || v.cta || ''
  const wrapped = wrapText(safeDrawTextLine(headline), 32)
  const subWrapped = wrapText(safeDrawTextLine(sub), 48)
  // Write text to a file to dodge filter-quote hell
  await writeFile(paths.textHead, wrapped, 'utf8')
  await writeFile(paths.textSub, subWrapped, 'utf8')

  const inputs = ['-y', '-f', 'lavfi', '-t', String(durationSecs.toFixed(3)), '-i', `color=c=#0a0a0c:s=${dim.w}x${dim.h}:r=30`]
  if (paths.voice) inputs.push('-i', paths.voice)

  const drawHead =
    `drawtext=fontfile=${fontPath}:textfile=${paths.textHead}` +
    `:fontcolor=#e3151e:fontsize=${Math.round(dim.h / 11)}:line_spacing=10` +
    `:x=(w-text_w)/2:y=(h-text_h)/2-${Math.round(dim.h / 16)}`
  const drawSub = sub
    ? `,drawtext=fontfile=${fontPath}:textfile=${paths.textSub}` +
      `:fontcolor=white:fontsize=${Math.round(dim.h / 22)}:line_spacing=8` +
      `:x=(w-text_w)/2:y=(h+text_h)/2+${Math.round(dim.h / 20)}:alpha=0.7`
    : ''
  const filter = `${drawHead}${drawSub}`

  const args = [
    ...inputs,
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p',
  ]
  if (paths.voice) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-shortest')
  } else {
    // Pure motion: silent track at 48k so concat doesn't drop the audio stream.
    args.push('-f', 'lavfi', '-t', String(durationSecs.toFixed(3)),
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-c:a', 'aac', '-b:a', '128k')
    // Reorder: lavfi audio input was appended after the -vf; ffmpeg accepts
    // out-of-position args but the cleanest path is to keep flags adjacent
    // to the streams they apply to. ffmpeg is lenient here.
  }
  args.push('-movflags', '+faststart', paths.outChunk)
  await runFFmpeg(args, 90_000)
  return paths.outChunk
}

// ── Font resolution ─────────────────────────────────────────────────────────
// Look for a TTF/OTF bundled under api/_fonts/ (same convention polish.js uses).
// Falls back to a system DejaVu if no project font is shipped.
async function resolveFont() {
  const candidates = [
    'api/_fonts/PlusJakartaSans-Black.ttf',
    'api/_fonts/PlusJakartaSans-ExtraBold.ttf',
    'api/_fonts/PlusJakartaSans-Bold.ttf',
    'api/_fonts/Inter-Bold.ttf',
  ]
  for (const c of candidates) {
    try {
      await readFile(c)
      return c
    } catch { /* try next */ }
  }
  // System fallback. DejaVu is on the Vercel Lambda image.
  return '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
}

// ── Main handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  let workdir = null
  try {
    gateStudio(auth.user.id)
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'Supabase storage not configured' })
    }

    const videoId = req.body?.studio_video_id
    if (!videoId) return res.status(400).json({ error: 'studio_video_id required' })

    const vRows = await supaFetch(`studio_videos?id=eq.${videoId}&select=*&limit=1`)
    const video = vRows?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    const segments = await supaFetch(
      `studio_segments?studio_video_id=eq.${videoId}&approved=eq.true&select=*&order=segment_index.asc&limit=500`
    )
    if (!segments?.length) return res.status(400).json({ error: 'No approved segments to render' })

    // Block rendering until every approved segment that needs an asset has
    // it. pure_motion_graphics rows skip asset gen so they can be 'ready'
    // without urls; we don't require voice_url for them either.
    const blocking = segments.filter((s) => {
      if (s.segment_type === 'pure_motion_graphics') return false
      if (s.status === 'error') return true
      if (!s.voice_url) return true
      if (s.segment_type === 'voiceover_broll' && !s.image_url) return true
      if (s.segment_type === 'avatar' && !s.avatar_video_url) return true
      return false
    })
    if (blocking.length) {
      return res.status(400).json({
        error: `${blocking.length} segment(s) still missing assets. Wait for asset generation to complete or fix errors.`,
      })
    }

    // Mark parent as rendering so the UI shows progress.
    await supaFetch(`studio_videos?id=eq.${videoId}`, {
      method: 'PATCH', body: { status: 'rendering', error: null }, prefer: 'return=minimal',
    })

    workdir = await mkdtemp(join(tmpdir(), `studio-render-${videoId.slice(0, 8)}-`))
    const dim = dimensions(video.aspect_ratio)
    const fontPath = await resolveFont()
    const chunkPaths = []

    // Render each segment to an intermediate MP4
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const dir = join(workdir, `seg-${String(i).padStart(3, '0')}`)
      await mkdir(dir, { recursive: true })
      const paths = {
        avatarMp4: join(dir, 'avatar.mp4'),
        image:     join(dir, 'image.jpg'),
        voice:     null,
        textHead:  join(dir, 'head.txt'),
        textSub:   join(dir, 'sub.txt'),
        outChunk:  join(dir, 'out.mp4'),
      }

      // Pull voice (if any) — we need its duration for non-avatar chunks.
      let voiceDuration = seg.voice_duration_secs || 0
      if (seg.voice_url && seg.segment_type !== 'pure_motion_graphics') {
        paths.voice = join(dir, 'voice.mp3')
        await downloadTo(seg.voice_url, paths.voice)
        if (!voiceDuration) voiceDuration = await probeAudioDurationSecs(paths.voice)
      }

      if (seg.segment_type === 'avatar') {
        await downloadTo(seg.avatar_video_url, paths.avatarMp4)
        await renderAvatarChunk(seg, paths, dim)
      } else if (seg.segment_type === 'voiceover_broll') {
        await downloadTo(seg.image_url, paths.image)
        await renderBrollChunk(seg, paths, dim, Math.max(2, voiceDuration || 4))
      } else if (seg.segment_type === 'voiceover_motion_graphics') {
        await renderMotionChunk(seg, paths, dim, Math.max(2, voiceDuration || 4), fontPath)
      } else if (seg.segment_type === 'pure_motion_graphics') {
        await renderMotionChunk(seg, paths, dim, 2.5, fontPath)
      } else {
        continue
      }
      chunkPaths.push(paths.outChunk)

      // Realtime ping so the UI sees per-chunk progress. We don't have a
      // per-segment status to set here ('ready' is from asset gen), so we
      // touch the parent's updated_at by patching status to itself.
      await supaFetch(`studio_videos?id=eq.${videoId}`, {
        method: 'PATCH', body: { status: 'rendering' }, prefer: 'return=minimal',
      }).catch(() => {})
    }

    // Concat all chunks. Every chunk shares the same codec/dimensions, so
    // the concat demuxer with stream copy is the fast path.
    const listFile = join(workdir, 'concat.txt')
    const listText = chunkPaths.map((p) => `file '${p}'`).join('\n') + '\n'
    await writeFile(listFile, listText, 'utf8')
    const finalPath = join(workdir, 'final.mp4')

    try {
      await runFFmpeg([
        '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c', 'copy', '-movflags', '+faststart', finalPath,
      ], 90_000)
    } catch {
      // Fast path failed → re-encode concat.
      const inputs = []
      let filter = ''
      for (let i = 0; i < chunkPaths.length; i++) {
        inputs.push('-i', chunkPaths[i])
        filter += `[${i}:v:0][${i}:a:0]`
      }
      filter += `concat=n=${chunkPaths.length}:v=1:a=1[v][a]`
      await runFFmpeg([
        '-y', ...inputs,
        '-filter_complex', filter,
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', finalPath,
      ], 180_000)
    }

    // Upload to studio-media bucket
    const buf = await readFile(finalPath)
    const path = `${video.profile_id}/studio/final/${videoId}-${Date.now()}.mp4`
    const up = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${STUDIO_BUCKET}/${encodeURI(path)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'video/mp4',
          'x-upsert': 'true',
        },
        body: buf,
      }
    )
    if (!up.ok) {
      const detail = await up.text().catch(() => '')
      throw new Error(`Upload failed (${up.status}): ${detail.slice(0, 300)}`)
    }
    const finalUrl = `${SUPABASE_URL}/storage/v1/object/public/${STUDIO_BUCKET}/${path}`

    // Finalize parent video
    await supaFetch(`studio_videos?id=eq.${videoId}`, {
      method: 'PATCH',
      body: { status: 'rendered', final_video_url: finalUrl, error: null },
      prefer: 'return=minimal',
    })

    return res.status(200).json({
      ok: true,
      final_video_url: finalUrl,
      segments_rendered: chunkPaths.length,
    })
  } catch (err) {
    // Surface error on the parent so the UI can show a retry path.
    if (req.body?.studio_video_id) {
      await supaFetch(`studio_videos?id=eq.${req.body.studio_video_id}`, {
        method: 'PATCH',
        body: { status: 'failed', error: String(err.message || err).slice(0, 1000) },
        prefer: 'return=minimal',
      }).catch(() => {})
    }
    return res.status(err.status || 500).json({ error: err.message })
  } finally {
    if (workdir) {
      await rm(workdir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
