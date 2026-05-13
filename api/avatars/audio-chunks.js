// POST /api/avatars/audio-chunks
// Body: { audio_url, look_count, profile_id }
//
// Voice-driven avatar render flow. Given an uploaded audio clip and the
// number of look images on an avatar, this endpoint:
//   1. Transcribes the audio with ElevenLabs Speech-to-Text (word-level
//      timings).
//   2. Greedily groups words into sentence-shaped chunks at punctuation
//      breaks, balancing total duration across `look_count` buckets.
//   3. ffmpeg-slices the source audio into one MP3 per bucket.
//   4. Uploads each slice to Supabase storage.
//   5. Returns [{ audio_url, sentence, start, duration }, ...] in order.
//
// avatar_render then submits one HeyGen photo render per chunk —
// audio + image — and stitches them later. Mirrors the script-driven
// path's "split across look images" logic so a 60s voice clip behaves
// the same way a 60s script would: one clip per look, narrative order
// preserved.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { isUserOnTrial, TRIAL_LOCKS } from '../_lib/billing.js'
import { customerIdForUser } from '../_lib/credits.js'
import { MODELS } from '../_lib/heygen.js'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
const ffmpegPath = ffmpegInstaller.path

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
const SUPABASE_URL  = process.env.SUPABASE_URL
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY

// HeyGen rejects any single render longer than 180 seconds. We use 179
// as a safety margin (rounding + chunk-boundary jitter can otherwise
// trip the limit on a "180.04s" clip). For multi-look renders the audio
// is split into N buckets, so the effective cap on the WHOLE upload
// is 179 × look_count — but each individual bucket must still be ≤179s
// after the split, which we verify post-balance.
const HEYGEN_MAX_RENDER_SECS = 179

export const config = { maxDuration: 120 }

async function fetchToBuffer(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`fetch ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

// ffprobe-via-ffmpeg for audio duration. We don't bundle ffprobe so we
// parse stderr from a no-op ffmpeg invocation. Faster + no extra binary.
function probeDurationSecs(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-i', filePath, '-hide_banner', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    proc.stderr.on('data', (d) => { err += d.toString('utf8') })
    proc.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i)
      if (!m) return reject(new Error('Could not parse audio duration'))
      const h = +m[1], min = +m[2], s = parseFloat(m[3])
      resolve(h * 3600 + min * 60 + s)
    })
    proc.on('error', reject)
  })
}

function runFFmpeg(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    const t = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')) }, timeoutMs)
    proc.on('error', (e) => { clearTimeout(t); reject(e) })
    proc.on('close', (code) => {
      clearTimeout(t)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.split('\n').slice(-6).join(' ')}`))
    })
  })
}

// Group ElevenLabs word events into sentence-shaped chunks. Sentences
// break at hard punctuation (. ! ? \n) or at gaps > 700ms. Each chunk
// gets { text, start, end } in seconds.
function groupSentences(words) {
  const chunks = []
  let cur = { text: '', start: null, end: null }
  let lastEnd = 0
  for (const w of words || []) {
    if (w.type !== 'word') continue
    const text = String(w.text || '')
    if (!text.trim()) continue
    const start = Number(w.start) || 0
    const end   = Number(w.end)   || start
    const gap = start - lastEnd
    if (cur.text && gap > 0.7) {
      chunks.push({ ...cur })
      cur = { text: '', start: null, end: null }
    }
    if (cur.start == null) cur.start = start
    cur.text += (cur.text ? ' ' : '') + text.trim()
    cur.end = end
    lastEnd = end
    if (/[.!?]/.test(text.trim().slice(-1))) {
      chunks.push({ ...cur })
      cur = { text: '', start: null, end: null }
      lastEnd = end
    }
  }
  if (cur.text) chunks.push(cur)
  return chunks
}

// Distribute the sentences across `n` buckets, balancing total duration.
// Greedy: walks through sentences in order, places each in the smallest
// bucket so far. Order is preserved within each bucket — the narrative
// of the original audio carries through. Returns [{ start, duration,
// text }, ...] for the n buckets.
function balanceIntoBuckets(sentences, n, totalDuration) {
  if (!sentences.length) return []
  if (n <= 1) {
    return [{
      start: sentences[0].start,
      end: sentences[sentences.length - 1].end,
      duration: totalDuration,
      text: sentences.map((s) => s.text).join(' '),
    }]
  }
  // Pre-create n buckets sized by the proportional ideal cut.
  // Simple O(n) walk: greedily pack until the bucket has roughly
  // totalDuration/n seconds, then move to the next.
  const target = totalDuration / n
  const out = []
  let cur = { sentences: [], start: null, end: null, dur: 0 }
  let remaining = n
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]
    if (cur.start == null) cur.start = s.start
    cur.sentences.push(s)
    cur.end = s.end
    cur.dur = cur.end - cur.start
    const sentencesLeft = sentences.length - i - 1
    const bucketsLeft = remaining
    // Close the bucket when we've hit the target duration AND we
    // still have enough sentences left to fill the remaining buckets.
    const wantClose = cur.dur >= target && bucketsLeft > 1 && sentencesLeft >= bucketsLeft - 1
    // Force close if we're running out of sentences relative to buckets.
    const mustClose = sentencesLeft < bucketsLeft - 1 ? false : (sentencesLeft === bucketsLeft - 1)
    if (wantClose || mustClose) {
      out.push({
        start: cur.start, end: cur.end,
        duration: cur.end - cur.start,
        text: cur.sentences.map((x) => x.text).join(' '),
      })
      cur = { sentences: [], start: null, end: null, dur: 0 }
      remaining--
    }
  }
  if (cur.sentences.length) {
    out.push({
      start: cur.start, end: cur.end,
      duration: cur.end - cur.start,
      text: cur.sentences.map((x) => x.text).join(' '),
    })
  }
  // Pad shorter audio: if we ended up with fewer buckets than n
  // (e.g. very short audio), the avatar render simply uses fewer
  // looks. avatar_render handles the count mismatch.
  return out
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  let workdir = null
  try {
    const { audio_url, look_count = 1, profile_id } = req.body || {}
    if (!audio_url) return res.status(400).json({ error: 'audio_url required' })
    if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
    await assertProfileAccess(auth.user.id, profile_id)

    if (!ELEVENLABS_API_KEY) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' })
    if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Storage not configured' })

    const n = Math.max(1, Math.min(8, Number(look_count) || 1))

    workdir = await mkdtemp(join(tmpdir(), 'audio-chunks-'))
    const inPath = join(workdir, 'in.mp3')
    await writeFile(inPath, await fetchToBuffer(audio_url))

    // Duration gates, in order:
    //   1. Trial users: cap at TRIAL_LOCKS.max_duration_secs (30s).
    //      Reject hard — trials can't render long-form, period.
    //   2. HeyGen per-render limit: 179s per CHUNK. Single-image
    //      renders are one chunk; multi-look randomized renders
    //      split into `n` chunks, so the effective whole-upload
    //      cap is 179 × n. The post-balance check below enforces
    //      the per-chunk limit after the split actually lands.
    //   3. Video credit pre-flight: V4 = 0.15 video_units/sec.
    const totalDuration = await probeDurationSecs(inPath)
    const onTrial = await isUserOnTrial(auth.user.id).catch(() => false)
    if (onTrial && totalDuration > TRIAL_LOCKS.max_duration_secs + 0.5) {
      return res.status(400).json({
        error: `Trial is capped at ${TRIAL_LOCKS.max_duration_secs}s per render. Upgrade for longer videos.`,
        code: 'trial_duration_exceeded',
      })
    }
    const effectiveMax = HEYGEN_MAX_RENDER_SECS * n
    if (totalDuration > effectiveMax + 0.5) {
      const friendly = n === 1
        ? `Audio is ${Math.round(totalDuration)}s — HeyGen renders top out at ${HEYGEN_MAX_RENDER_SECS}s per single-image clip. Trim it, or switch the avatar's image strategy to "Randomize" so we can split across multiple looks.`
        : `Audio is ${Math.round(totalDuration)}s — with ${n} looks the cap is ${effectiveMax}s (${HEYGEN_MAX_RENDER_SECS}s per look). Trim it or add more looks to the avatar.`
      return res.status(400).json({
        error: friendly,
        code: 'audio_over_heygen_max',
        per_render_max_secs: HEYGEN_MAX_RENDER_SECS,
        effective_max_secs: effectiveMax,
        look_count: n,
      })
    }
    if (!onTrial) {
      // Credit pre-flight. V4 burns 0.15 video_units per second (see
      // api/_lib/heygen.js MODELS.v4). Round UP so a 33.4s clip is
      // billed at 5.1 units, not 5.0. If the user lacks balance, fail
      // BEFORE we call HeyGen or ElevenLabs.
      const unitsPerSec = MODELS.v4?.video_units_per_sec || 0.15
      const need = Math.max(1, Math.ceil(totalDuration * unitsPerSec))
      const customerId = await customerIdForUser(auth.user.id).catch(() => null)
      if (customerId) {
        const pools = await supaFetch(
          `credit_pools?customer_id=eq.${customerId}&pool_type=eq.video_units&select=balance`,
        ).catch(() => [])
        const have = Number(pools?.[0]?.balance ?? 0)
        if (have < need) {
          return res.status(402).json({
            error: `This ${Math.round(totalDuration)}s clip needs ${need} video credits — you have ${have}. Top up or trim the audio.`,
            code: 'insufficient_credits',
            need, have,
          })
        }
      }
    }

    // ── Transcribe with ElevenLabs (word-level timings) ──────────────
    const fd = new FormData()
    fd.append('model_id', 'scribe_v1')
    fd.append('file', new Blob([await readFile(inPath)], { type: 'audio/mpeg' }), 'in.mp3')
    fd.append('timestamps_granularity', 'word')
    const sttRes = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      body: fd,
    })
    if (!sttRes.ok) {
      const txt = await sttRes.text().catch(() => '')
      return res.status(502).json({ error: `Transcription failed: ${sttRes.status}`, detail: txt.slice(0, 200) })
    }
    const stt = await sttRes.json()
    const sentences = groupSentences(stt?.words || [])
    if (!sentences.length) {
      return res.status(422).json({ error: 'Transcription returned no words. Re-upload a clearer voice take.' })
    }

    // ── Distribute sentences into N buckets balanced by duration ──────
    const buckets = balanceIntoBuckets(sentences, n, totalDuration)
    if (!buckets.length) return res.status(422).json({ error: 'Could not split audio into chunks' })

    // Sentence-boundary balancing can put more time in one bucket than
    // the simple "totalDuration / n" estimate — especially when one
    // sentence is much longer than the others. If any bucket would
    // overshoot HeyGen's 179s render limit, refuse here BEFORE calling
    // HeyGen. The user's options are to trim the audio or add more
    // looks (which gives the balancer more buckets to spread into).
    const longest = buckets.reduce((max, b) => {
      const dur = (b?.[b.length - 1]?.end || 0) - (b?.[0]?.start || 0)
      return dur > max ? dur : max
    }, 0)
    if (longest > HEYGEN_MAX_RENDER_SECS + 0.5) {
      return res.status(400).json({
        error: `Splitting this audio across ${n} look${n === 1 ? '' : 's'} still leaves one chunk at ${Math.round(longest)}s — HeyGen renders top out at ${HEYGEN_MAX_RENDER_SECS}s per clip. Add more looks to the avatar so the chunks come out shorter, or trim the audio.`,
        code: 'chunk_over_heygen_max',
        longest_chunk_secs: Math.round(longest),
        per_render_max_secs: HEYGEN_MAX_RENDER_SECS,
        look_count: n,
      })
    }

    // ── ffmpeg-slice each bucket into its own MP3 ─────────────────────
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const baseId = `${profile_id}/avatar-audio-chunks/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const chunks = []
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]
      const outPath = join(workdir, `chunk-${i}.mp3`)
      // -ss before -i for fast seek on the source, -t for duration.
      // Re-encode (libmp3lame) so chunk boundaries are sample-accurate.
      // Bitrate 128 keeps file small enough for HeyGen ingest.
      await runFFmpeg([
        '-y',
        '-ss', String(b.start.toFixed(3)),
        '-t',  String(Math.max(0.5, b.duration).toFixed(3)),
        '-i',  inPath,
        '-c:a', 'libmp3lame', '-b:a', '128k',
        outPath,
      ])
      const buf = await readFile(outPath)
      const path = `${baseId}/chunk-${String(i + 1).padStart(2, '0')}.mp3`
      const { error: upErr } = await supabase.storage.from('landing-media').upload(path, buf, {
        contentType: 'audio/mpeg', upsert: false,
      })
      if (upErr) throw new Error(`Chunk upload failed: ${upErr.message}`)
      const { data: pub } = supabase.storage.from('landing-media').getPublicUrl(path)
      chunks.push({
        audio_url: pub.publicUrl,
        sentence: b.text,
        start: Number(b.start.toFixed(3)),
        duration: Number(b.duration.toFixed(3)),
        order: i + 1,
      })
    }

    return res.status(200).json({
      chunks,
      total_duration: Number(totalDuration.toFixed(3)),
      transcription: stt?.text || '',
      n_requested: n,
      n_returned: chunks.length,
    })
  } catch (err) {
    console.error('audio-chunks error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  } finally {
    if (workdir) { try { await rm(workdir, { recursive: true, force: true }) } catch {} }
  }
}
