// POST /api/studio/voiceover/repair-positions
//
// Fixes segments that have voice_url set from TTS (or are missing it
// entirely) but where the parent video was originally uploaded as a
// voiceover. Uses the stored Whisper transcript (voiceover_transcript)
// to find each segment's script_text in the word stream and set
// voice_source_start_secs + voice_source_end_secs to the matched
// span's exact word boundaries.
//
// This is the long-term fix for the "TTS vs real voice" drift Ray hit
// on the millionaire video: 6 segments lost their time positions
// during early splits (before the v3 RPC fix) and got re-synthesized.
// Interpolation by character ratio was a band-aid; word matching is
// the principled fix.
//
// Body: { studio_video_id }
// Returns: { repaired: number, skipped: number, details: [...] }

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../../_lib/supabase.js'
import { gateStudio } from '../_lib/gate.js'

export const config = { maxDuration: 60 }

// Normalize a token for fuzzy comparison. Lowercase + strip punctuation +
// strip whitespace. The Whisper transcript usually has clean word tokens
// but the script_text can have apostrophes, commas, periods — those
// shouldn't cause a mismatch.
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Tokenize script_text into normalized words. Drops empties + punctuation.
function tokenize(text) {
  return String(text || '').split(/\s+/).map(norm).filter(Boolean)
}

// Find the best window in `words` (the transcript word stream) that
// matches `scriptTokens` (normalized tokens from script_text). Returns
// { startIdx, endIdx, score } where score is the fraction of matching
// tokens. A perfect match is 1.0.
//
// We anchor on first + last token: search for first-token positions in
// `words` then check how many of the next N tokens line up. Picks the
// window with the highest match rate.
function findBestWindow(words, scriptTokens, { searchFrom = 0 } = {}) {
  if (!scriptTokens.length || !words.length) return null
  const head = scriptTokens[0]
  let best = null
  for (let i = searchFrom; i < words.length; i++) {
    if (norm(words[i].word) !== head) continue
    // Slide forward and count matches in the next scriptTokens.length window
    let matched = 0
    let lastMatchIdx = i
    let wi = i
    for (let st = 0; st < scriptTokens.length && wi < words.length; st++) {
      // Try to find scriptTokens[st] within a small forward window to
      // tolerate ASR insertions ("um", filler words Scribe sometimes
      // picks up that aren't in the script).
      let foundAt = -1
      for (let look = 0; look < 4 && wi + look < words.length; look++) {
        if (norm(words[wi + look].word) === scriptTokens[st]) {
          foundAt = wi + look
          break
        }
      }
      if (foundAt >= 0) {
        matched++
        lastMatchIdx = foundAt
        wi = foundAt + 1
      } else {
        wi++
      }
    }
    const score = matched / scriptTokens.length
    if (!best || score > best.score) {
      best = { startIdx: i, endIdx: lastMatchIdx, score }
    }
  }
  return best
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

    const videos = await supaFetch(
      `studio_videos?id=eq.${studio_video_id}&select=id,profile_id,voiceover_source_url,voiceover_transcript&limit=1`,
    )
    const video = videos?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    if (!video.voiceover_source_url) {
      return res.status(400).json({ error: 'This video was not built from a user-uploaded voiceover (no source audio).' })
    }
    const words = video.voiceover_transcript?.words
    if (!Array.isArray(words) || !words.length) {
      return res.status(400).json({ error: 'No word-level transcript on this video — cannot match positions.' })
    }

    // Pull segments that need repair: voice_source_start_secs OR
    // voice_source_end_secs is null. Sort by segment_index so we can
    // walk the transcript forward without re-searching from the start.
    const segs = await supaFetch(
      `studio_segments?studio_video_id=eq.${studio_video_id}&select=id,segment_index,script_text,voice_source_start_secs,voice_source_end_secs&order=segment_index.asc`,
    )

    let cursor = 0  // walk-forward pointer in the transcript word stream
    let repaired = 0
    let skipped = 0
    const details = []

    for (const seg of segs || []) {
      // For segments that ALREADY have positions, advance the cursor
      // past their end to keep search ranges accurate for later ones.
      if (seg.voice_source_start_secs != null && seg.voice_source_end_secs != null) {
        // Find a cursor advancement so we don't re-match earlier text
        while (cursor < words.length && (words[cursor].end || words[cursor].start || 0) < seg.voice_source_end_secs) {
          cursor++
        }
        continue
      }
      const scriptTokens = tokenize(seg.script_text)
      if (!scriptTokens.length) {
        skipped++
        details.push({ segment_index: seg.segment_index, skipped: 'empty script_text' })
        continue
      }
      const match = findBestWindow(words, scriptTokens, { searchFrom: cursor })
      if (!match || match.score < 0.5) {
        // Try a wider search from index 0 in case the cursor was ahead
        // (sometimes segments are reordered by the user post-segmentation).
        const fallback = findBestWindow(words, scriptTokens, { searchFrom: 0 })
        if (!fallback || fallback.score < 0.5) {
          skipped++
          details.push({
            segment_index: seg.segment_index,
            skipped: `low match score: ${(match?.score ?? 0).toFixed(2)}`,
            preview: seg.script_text?.slice(0, 60),
          })
          continue
        }
        Object.assign(match, fallback)
      }
      const startWord = words[match.startIdx]
      const endWord = words[match.endIdx]
      const startSecs = Number(startWord.start ?? 0)
      const endSecs = Number(endWord.end ?? endWord.start ?? startSecs + 1)
      // Bump cursor for next iteration.
      cursor = match.endIdx + 1

      await supaFetch(`studio_segments?id=eq.${seg.id}`, {
        method: 'PATCH',
        body: {
          voice_source_start_secs: startSecs,
          voice_source_end_secs: endSecs,
          // Clear voice_url so the orchestrator re-slices with the new
          // positions on the next generate-assets pass. Also reset
          // voice_cleaned + rendered_chunk_url so the cleaning + bake
          // both refresh.
          voice_url: null,
          voice_cleaned: false,
          rendered_chunk_url: null,
          status: 'pending',
          error: null,
        },
        prefer: 'return=minimal',
      })
      repaired++
      details.push({
        segment_index: seg.segment_index,
        start_secs: Number(startSecs.toFixed(3)),
        end_secs: Number(endSecs.toFixed(3)),
        match_score: Number(match.score.toFixed(2)),
      })
    }

    return res.status(200).json({ repaired, skipped, details })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
