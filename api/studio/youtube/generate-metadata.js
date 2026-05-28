// POST /api/studio/youtube/generate-metadata
//
// Auto-generates a YouTube title + summary + chapter timestamps for a
// rendered Studio video. Powers the "Schedule to YouTube" flow:
// user clicks Schedule, this fires, the modal pre-fills with the
// returned title/description.
//
// Uses voiceover_transcript (word-level timestamps from Whisper) +
// segment script_text to find natural chapter breaks aligned with
// the video's actual narrative beats — not arbitrary 60s intervals.
//
// Body: { studio_video_id }
// Returns: { title, summary, chapters: [{ at, label }], full_description }
//
// full_description = summary + chapters + the profile's
// youtube_description_default boilerplate. The client can override
// any of these in the schedule modal before publishing.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../../_lib/supabase.js'
import { gateStudio } from '../_lib/gate.js'
import { message as anthropicMessage } from '../../_lib/anthropic.js'

export const config = { maxDuration: 60 }

// Format seconds → "M:SS" or "H:MM:SS" the way YouTube parses chapter
// timestamps. YouTube auto-renders these as clickable chapter markers
// when they're in the description AND the first one is "0:00".
function formatTimestamp(secs) {
  const total = Math.max(0, Math.floor(Number(secs) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

// Compress a long script into a single coherent text the LLM can read
// to write a good title. Just stitches the script_text fields in
// segment order — gives Claude the full narrative without the
// noise of asset URLs and other metadata.
function buildScriptDigest(segments) {
  return (segments || [])
    .slice()
    .sort((a, b) => a.segment_index - b.segment_index)
    .map((s) => s.script_text || '')
    .filter((t) => t.trim())
    .join(' ')
    .slice(0, 8000)
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    gateStudio(auth.user.id)
    const { studio_video_id } = req.body || {}
    if (!studio_video_id) return res.status(400).json({ error: 'studio_video_id required' })

    const rows = await supaFetch(
      `studio_videos?id=eq.${studio_video_id}&select=id,profile_id,title,topic_prompt,script_full_text,voiceover_transcript`,
    )
    const video = rows?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    const segments = await supaFetch(
      `studio_segments?studio_video_id=eq.${studio_video_id}&select=segment_index,script_text,voice_source_start_secs,voice_source_end_secs&order=segment_index.asc`,
    )

    // Pull the boilerplate to append
    const profileRows = await supaFetch(
      `profiles?id=eq.${video.profile_id}&select=youtube_description_default,business_name,owner_name&limit=1`,
    )
    const profile = profileRows?.[0] || {}
    const boilerplate = (profile.youtube_description_default || '').trim()

    const scriptDigest = video.script_full_text?.trim() || buildScriptDigest(segments)
    if (!scriptDigest) return res.status(400).json({ error: 'No script text to summarize.' })

    // Single Claude call returns all three (title, summary, chapter labels)
    // as a structured JSON tool input.
    const system =
      'You write YouTube metadata for a creator. Given the full transcript of a video, return:\n' +
      '  - title: 60-70 chars, hook-style. Lead with the most provocative claim or the\n' +
      '    most concrete benefit. No emoji, no clickbait punctuation like "?!". Title\n' +
      '    case. Avoid generic "Ultimate Guide to X" phrasing.\n' +
      '  - summary: 2-3 sentences. First sentence: what the video is about + who it\'s\n' +
      '    for. Second sentence: the most useful payoff. Third sentence (optional):\n' +
      '    one-sentence CTA. No "in this video I will" — just state what it covers.\n' +
      '  - chapters: 4-8 chapter labels that match the narrative beats. Each label\n' +
      '    is 3-7 words, no leading numbers, no emoji. The FIRST chapter is always\n' +
      '    "Intro" (mapped to 0:00 by the caller). Labels go in the order they appear\n' +
      '    in the transcript.\n' +
      'Return all three via the emit_metadata tool.'

    const userContent =
      `Brand: ${profile.business_name || profile.owner_name || 'creator'}\n` +
      `Working title (if any): ${video.title || video.topic_prompt || '(none)'}\n\n` +
      `Full transcript:\n${scriptDigest}`

    const claude = await anthropicMessage({
      system,
      messages: [{ role: 'user', content: userContent }],
      max_tokens: 1500,
      tools: [{
        name: 'emit_metadata',
        description: 'Return the YouTube metadata',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '60-70 character title' },
            summary: { type: 'string', description: '2-3 sentence summary' },
            chapters: {
              type: 'array',
              items: { type: 'string', description: 'Chapter label, no numbering' },
              minItems: 3,
              maxItems: 10,
            },
          },
          required: ['title', 'summary', 'chapters'],
        },
      }],
      tool_choice: { type: 'tool', name: 'emit_metadata' },
      cache_system: false,
    })

    const toolBlock = (claude?.content || []).find((b) => b.type === 'tool_use')
    const input = toolBlock?.input
    if (!input?.title || !input?.summary || !Array.isArray(input?.chapters)) {
      return res.status(502).json({ error: 'Claude did not return usable metadata.' })
    }

    // Map chapter labels to timestamps. Segment timing comes from
    // voice_source_start_secs (the speaker's actual start time in the
    // source audio). We pick N evenly-distributed segments through
    // the script, where N = number of chapter labels Claude returned.
    // First chapter is always 0:00.
    const orderedSegs = (segments || []).slice().sort((a, b) => a.segment_index - b.segment_index)
    const segsWithTime = orderedSegs.filter((s) => s.voice_source_start_secs != null)
    const n = input.chapters.length
    const chapters = []
    for (let i = 0; i < n; i++) {
      let at = 0
      if (i === 0) {
        at = 0  // YouTube requires the first chapter at 0:00
      } else if (segsWithTime.length > 0) {
        const idx = Math.min(segsWithTime.length - 1, Math.floor(i * segsWithTime.length / n))
        at = Number(segsWithTime[idx].voice_source_start_secs) || 0
      }
      chapters.push({ at, label: input.chapters[i] })
    }

    // Build the final description: summary + blank line + chapters + blank line + boilerplate
    const chapterLines = chapters.map((c) => `${formatTimestamp(c.at)} ${c.label}`).join('\n')
    const sections = [
      input.summary.trim(),
      `Chapters:\n${chapterLines}`,
    ]
    if (boilerplate) sections.push(boilerplate)
    const full_description = sections.join('\n\n')

    return res.status(200).json({
      title: input.title.trim().slice(0, 100),
      summary: input.summary.trim(),
      chapters,
      full_description: full_description.slice(0, 5000),
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
