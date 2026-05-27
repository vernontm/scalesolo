// POST /api/studio/voiceover/segment
//
// Takes an uploaded voiceover MP3, runs it through ElevenLabs Scribe
// for word-level transcription, then Claude picks segment boundaries
// at natural beats. The server slices the master MP3 into per-segment
// audio files, uploads each as the segment's voice_url, and inserts
// studio_segments rows with status='ready' (voice-wise) so subsequent
// generate-assets only needs to fan out B-roll images / avatar videos.
//
// Body:
//   profile_id           required
//   voiceover_url        required — public URL from /voiceover/upload finalize
//   target_duration_secs optional (ignored — actual duration is transcript length)
//   aspect_ratio         '16:9' | '9:16' | '1:1', defaults '16:9'
//   avatar_id, look_id   optional — passes through to studio_videos row
//   template_id, captions_enabled, etc. — same shape as POST /studio/videos
//
// Returns { video, segments } on success.

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../../_lib/supabase.js'
import { gateStudio } from '../_lib/gate.js'
import { message as anthropicMessage } from '../../_lib/anthropic.js'
import { transcribeFromUrl } from '../../_lib/scribe.js'
import { resolveTemplate } from '../_lib/templates.js'
import { buildCompositionGuidance } from '../_lib/composition-guidance.js'

const STUDIO_BUCKET = 'studio-media'
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const FFMPEG = process.env.FFMPEG_PATH || ffmpegInstaller.path

// Allow Vercel up to 5 minutes for this — Scribe transcription on a
// 60s voiceover is typically ~10-20s, Claude segmentation 5-10s,
// slicing 10-30s depending on segment count + master length, plus
// upload overhead. 300s gives headroom for slow networks.
export const config = { maxDuration: 300 }

// ── Claude tool schema ──────────────────────────────────────────────
//
// Claude receives the word-indexed transcript and emits segments with
// word index ranges (not text). Server resolves words → time windows
// via the Scribe response, then slices the MP3 at those boundaries.
const SEGMENT_TOOL = {
  name: 'segment_voiceover',
  description:
    'Break a user-recorded voiceover into segments. Each segment names a contiguous run of words (by index into the transcript) and picks the visual treatment for that beat.',
  input_schema: {
    type: 'object',
    required: ['title', 'segments'],
    properties: {
      title: { type: 'string', description: '6-10 word video title derived from the transcript.' },
      segments: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['start_word', 'end_word', 'segment_type'],
          properties: {
            start_word: { type: 'integer', description: 'Inclusive index of first word in this segment.' },
            end_word:   { type: 'integer', description: 'Inclusive index of last word in this segment.' },
            segment_type: {
              type: 'string',
              enum: ['avatar', 'voiceover_broll', 'voiceover_motion_graphics'],
              description: 'Visual treatment. avatar = avatar speaking on-camera; voiceover_broll = generated B-roll image; voiceover_motion_graphics = animated HyperFrames scene.',
            },
            image_prompt: { type: 'string', description: 'Specific image prompt when segment_type=voiceover_broll. Otherwise omit.' },
            hyperframes_composition_id: { type: 'string', description: 'Required when segment_type=voiceover_motion_graphics. Pick from the template pool.' },
            hyperframes_variables: { type: 'object', description: 'Variable slot values for the chosen composition.', additionalProperties: true },
          },
        },
      },
    },
  },
}

function buildSystemPrompt(tmpl, captionsEnabled) {
  const pool = tmpl.composition_pool || []
  return `You are Studio's voiceover segmentation engine. The user recorded a voiceover; your job is to break the transcript into beats and pick a visual treatment for each.

Hard rules:
- script_text is FIXED — you can't change the words. Just choose segment boundaries (start_word / end_word, inclusive) on the indexed transcript.
- Segments must be CONTIGUOUS and COVER THE FULL TRANSCRIPT — no gaps, no overlap. The first segment starts at word 0; the last segment ends at the final word index.
- Aim for 4-9 second beats. Don't make 30-second segments; break long thoughts at natural punctuation.
- The first segment is ALWAYS segment_type: avatar (the hook is the speaker on camera).
- Vary segment_type — don't put 3 of the same type in a row.

Visual template: "${tmpl.name}". ${tmpl.description || ''}

Composition pool (you may ONLY pick from this list):
${pool.map((id) => `  - ${id}`).join('\n')}

${buildCompositionGuidance(tmpl)}

When segment_type is voiceover_broll, write a specific image_prompt that matches the words being spoken. "Woman in early-30s at a desk, side-lit window light, looking at laptop, warm cinematic tone" beats "office scene." Match the template palette when relevant.

When segment_type is voiceover_motion_graphics, set hyperframes_composition_id from the pool above and emit hyperframes_variables that match the actual spoken words in that segment.

Captions: ${captionsEnabled ? 'ON — handled automatically. Do not emit caption_overlay placements; they get added downstream from script_text.' : 'OFF.'}

Call segment_voiceover exactly once.`
}

function buildUserPrompt(words) {
  // Compact indexed transcript Claude can reason about without
  // overflowing tokens. Words inline with their index.
  const lines = []
  let row = []
  for (let i = 0; i < words.length; i++) {
    row.push(`${i}:${words[i].word}`)
    if (row.length === 12) { lines.push(row.join(' ')); row = [] }
  }
  if (row.length) lines.push(row.join(' '))
  return `Word-indexed transcript (index:word per token):\n\n${lines.join('\n')}\n\nSegment the transcript now. Every word from 0 to ${words.length - 1} must be covered by exactly one segment. Call segment_voiceover.`
}

function extractToolInput(claudeBody) {
  if (!claudeBody?.content) return null
  for (const block of claudeBody.content) {
    if (block.type === 'tool_use' && block.name === 'segment_voiceover') return block.input
  }
  return null
}

// Normalize Scribe's word list — different model versions / output
// shapes ship under slightly different keys.
function extractWords(scribeRaw) {
  const out = []
  const src = Array.isArray(scribeRaw?.words) ? scribeRaw.words
            : Array.isArray(scribeRaw?.segments) ? scribeRaw.segments.flatMap((s) => s.words || [])
            : []
  for (const w of src) {
    const text = (w.text || w.word || '').toString().trim()
    const start = Number(w.start ?? w.start_time)
    const end = Number(w.end ?? w.end_time)
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue
    out.push({ word: text, start, end })
  }
  return out
}

// Run ffmpeg to extract a slice [start, end] of the source file to
// a new MP3. Re-encodes (rather than -c copy) so the slice has
// frame-accurate boundaries — copy can land on the wrong keyframe
// and leave a click/pop.
function sliceMp3(sourcePath, outPath, startSecs, endSecs) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-ss', startSecs.toFixed(3),
      '-to', endSecs.toFixed(3),
      '-i', sourcePath,
      '-vn',
      '-c:a', 'libmp3lame',
      '-q:a', '4',
      outPath,
    ]
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    p.stderr.on('data', (b) => { stderr += b.toString() })
    p.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`))
    })
  })
}

async function uploadMp3(buf, profileId, segmentIdx) {
  const path = `${profileId}/studio/voiceover-slices/${Date.now()}-${segmentIdx}-${Math.random().toString(36).slice(2, 8)}.mp3`
  const up = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${STUDIO_BUCKET}/${encodeURI(path)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'audio/mpeg',
        'x-upsert': 'true',
      },
      body: buf,
    },
  )
  if (!up.ok) {
    const detail = await up.text().catch(() => '')
    throw new Error(`Slice upload ${up.status}: ${detail.slice(0, 200)}`)
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${STUDIO_BUCKET}/${path}`
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  let workdir = null
  try {
    gateStudio(auth.user.id)
    const body = req.body || {}
    const { profile_id, voiceover_url } = body
    if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
    if (!voiceover_url) return res.status(400).json({ error: 'voiceover_url required' })
    await assertProfileAccess(auth.user.id, profile_id)

    // ── Step 1: Transcribe the master voiceover ─────────────────
    const scribe = await transcribeFromUrl(voiceover_url, {
      model_id: 'scribe_v2',
      language_code: body.language_code || 'en',
      no_verbatim: true,
    })
    const words = extractWords(scribe.raw)
    if (!words.length) {
      return res.status(502).json({
        error: 'Transcription returned no word timestamps. Try a clearer recording.',
      })
    }

    // ── Step 2: Claude segmentation against word-indexed transcript
    const aspect_ratio = body.aspect_ratio || '16:9'
    const captions_enabled = body.captions_enabled !== false
    const template_id = body.template_id || 'sleek'
    const resolvedTemplate = resolveTemplate(template_id, body.brand_color, body.brand_color_secondary)

    let claudeResp
    try {
      claudeResp = await anthropicMessage({
        system: buildSystemPrompt(resolvedTemplate, captions_enabled),
        messages: [{ role: 'user', content: buildUserPrompt(words) }],
        tools: [SEGMENT_TOOL],
        tool_choice: { type: 'tool', name: 'segment_voiceover' },
        max_tokens: 8000,
      })
    } catch (apiErr) {
      return res.status(502).json({ error: `Claude API error: ${(apiErr?.message || String(apiErr)).slice(0, 500)}` })
    }
    const mapInput = extractToolInput(claudeResp)
    if (!mapInput || !Array.isArray(mapInput.segments) || !mapInput.segments.length) {
      return res.status(502).json({
        error: 'Claude did not return a usable segmentation. Try regenerating.',
      })
    }

    // Validate + sanitize segments. Force start_word=0 on the first
    // segment + cover-to-the-end on the last so we never lose audio.
    const rawSegments = mapInput.segments
      .map((s) => ({
        start_word: Math.max(0, Math.min(words.length - 1, Number(s.start_word) || 0)),
        end_word:   Math.max(0, Math.min(words.length - 1, Number(s.end_word)   || 0)),
        segment_type: ['avatar', 'voiceover_broll', 'voiceover_motion_graphics'].includes(s.segment_type)
          ? s.segment_type : 'voiceover_broll',
        image_prompt: typeof s.image_prompt === 'string' ? s.image_prompt.slice(0, 600) : null,
        hyperframes_composition_id: (resolvedTemplate.composition_pool || []).includes(s.hyperframes_composition_id)
          ? s.hyperframes_composition_id : null,
        hyperframes_variables: s.hyperframes_variables && typeof s.hyperframes_variables === 'object' ? s.hyperframes_variables : {},
      }))
      .filter((s) => s.end_word >= s.start_word)
      .sort((a, b) => a.start_word - b.start_word)
    if (!rawSegments.length) {
      return res.status(502).json({ error: 'Segmentation produced no valid segments.' })
    }
    rawSegments[0].start_word = 0
    rawSegments[rawSegments.length - 1].end_word = words.length - 1
    rawSegments[0].segment_type = 'avatar'

    // ── Step 3: Download the master MP3 once, slice per segment ─
    workdir = await mkdtemp(join(tmpdir(), 'voiceover-'))
    const masterPath = join(workdir, 'master.mp3')
    const dl = await fetch(voiceover_url)
    if (!dl.ok) throw new Error(`Could not fetch voiceover ${dl.status}`)
    const masterBuf = Buffer.from(await dl.arrayBuffer())
    await writeFile(masterPath, masterBuf)

    const segments = []
    for (let i = 0; i < rawSegments.length; i++) {
      const seg = rawSegments[i]
      const startSecs = words[seg.start_word].start
      // End at the next segment's start so adjacent slices butt up
      // perfectly. For the last segment, use the end of the last word.
      const endSecs = i < rawSegments.length - 1
        ? words[rawSegments[i + 1].start_word].start
        : words[seg.end_word].end
      const slicePath = join(workdir, `seg-${i}.mp3`)
      await sliceMp3(masterPath, slicePath, startSecs, endSecs)
      const sliceBuf = await readFile(slicePath)
      const voiceUrl = await uploadMp3(sliceBuf, profile_id, i)
      const scriptText = words.slice(seg.start_word, seg.end_word + 1).map((w) => w.word).join(' ')
      segments.push({
        segment_index: i,
        segment_type: seg.segment_type,
        script_text: scriptText,
        voice_url: voiceUrl,
        voice_duration_secs: Number((endSecs - startSecs).toFixed(3)),
        voice_source_start_secs: Number(startSecs.toFixed(3)),
        voice_source_end_secs: Number(endSecs.toFixed(3)),
        approved: true,
        status: 'pending',  // will flip to 'ready' once non-voice assets land
        image_prompt: seg.segment_type === 'voiceover_broll' ? seg.image_prompt : null,
        hyperframes_composition_id: seg.segment_type === 'voiceover_motion_graphics' ? seg.hyperframes_composition_id : null,
        hyperframes_variables: seg.segment_type === 'voiceover_motion_graphics' ? seg.hyperframes_variables : {},
        overlay_placements: [],
      })
    }

    // ── Step 4: Resolve voice id from avatar + create studio_videos
    // row. Voice ID is what HeyGen would use if the user later
    // generated avatar videos — keeping it set means the row passes
    // generate-assets's "no voice configured" gate.
    let voiceId = body.voice_id || null
    if (!voiceId && body.avatar_id) {
      try {
        const av = await supaFetch(`avatars?id=eq.${body.avatar_id}&select=elevenlabs_voice_id&limit=1`)
        voiceId = av?.[0]?.elevenlabs_voice_id || null
      } catch { /* best-effort */ }
    }

    // Pull brand colors from the profile if not supplied.
    let brandPrimary = body.brand_color
    let brandSecondary = body.brand_color_secondary
    if (!brandPrimary || !brandSecondary) {
      try {
        const prof = await supaFetch(`profiles?id=eq.${profile_id}&select=brand_primary_color,brand_secondary_color&limit=1`)
        const p = prof?.[0]
        if (p?.brand_primary_color && !brandPrimary) brandPrimary = p.brand_primary_color
        if (p?.brand_secondary_color && !brandSecondary) brandSecondary = p.brand_secondary_color
      } catch { /* best-effort */ }
    }

    const title = (typeof mapInput.title === 'string' ? mapInput.title : 'Untitled voiceover').slice(0, 200)
    const totalDurSecs = Number((words[words.length - 1].end - words[0].start).toFixed(3))
    const videoRow = {
      user_id: auth.user.id,
      profile_id,
      status: 'editing',
      title,
      topic_prompt: title,
      avatar_id: body.avatar_id || null,
      look_id: body.look_id || null,
      voice_id: voiceId,
      target_duration_secs: Math.ceil(totalDurSecs),
      aspect_ratio,
      template_id,
      captions_enabled,
      overlays_enabled: true,
      motion_graphics_enabled: true,
      music_mode: ['off', 'loop_one', 'cycle_all'].includes(body.music_mode) ? body.music_mode : 'off',
      music_track_id: body.music_track_id || null,
      music_volume: typeof body.music_volume === 'number' ? body.music_volume : 0.12,
      content_mix: body.content_mix && typeof body.content_mix === 'object' ? body.content_mix : null,
      brand_color: brandPrimary || null,
      brand_color_secondary: brandSecondary || null,
      voiceover_source_url: voiceover_url,
      voiceover_transcript: { words, language_code: scribe.language_code, duration_secs: scribe.duration_secs },
    }
    const created = await supaFetch('studio_videos', { method: 'POST', body: videoRow })
    const video = Array.isArray(created) ? created[0] : created
    if (!video?.id) throw new Error('Studio video insert returned no row')

    // ── Step 5: Insert segments ─────────────────────────────────
    const insertRows = segments.map((s) => ({ ...s, studio_video_id: video.id, profile_id }))
    const insertedSegs = await supaFetch('studio_segments', { method: 'POST', body: insertRows })

    return res.status(201).json({ video, segments: insertedSegs })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || String(err) })
  } finally {
    if (workdir) {
      try { await rm(workdir, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
    }
  }
}
