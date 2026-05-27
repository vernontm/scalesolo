// Single source of truth for studio video provider rates.
//
// Used by:
//   - The ContentMix step in the new-video survey (live $ display)
//   - Any future server-side cost estimator
//
// Every rate is in raw US dollars at the lowest unit we care about.
// Update here when a provider's pricing changes; the UI re-imports
// at build time, so a deploy is enough to roll the new numbers out.
//
// Rates verified 2026-05-27. If a provider tier change kicks in,
// drop the new number in and ship; downstream consumers re-read
// automatically.

export const COST_RATES = {
  // HeyGen Avatar IV @ 1080p — what we render with today.
  // https://developers.heygen.com/docs/pricing
  heygen_avatar_per_sec: 0.05,

  // Kie.ai nano-banana-2 at 2K resolution. Per-image flat — the model
  // returns one image per task no matter how much we ask for.
  kie_image_per_image: 0.03,

  // Grok Imagine Image-to-Video 720p — what we'd use for b-roll video
  // segments. Confirmed by Ray 2026-05-27.
  grok_video_per_sec: 0.015,

  // ElevenLabs Scribe (speech-to-text) — used when the user uploads a
  // voiceover and we transcribe it for segmentation.
  el_scribe_per_hour: 0.40,

  // ElevenLabs Turbo v2.5 (TTS) — used when the user picks topic or
  // script source and we synthesize voice for them.
  el_voice_per_1k_chars: 0.0075,

  // Anthropic Claude (Sonnet 4.6) — fixed estimate for one segmentation
  // pass. Real cost varies with script length and brand context size
  // but stays within $0.05–$0.20 in practice. The flat estimate keeps
  // the cost display simple.
  claude_segmentation_flat: 0.12,

  // Fly performance-4x — render compute. A typical 10-min video bake
  // takes 5–10 minutes of machine time. Negligible; rolled into a
  // single flat estimate.
  fly_render_flat: 0.25,
}

// Average per-segment durations observed in real renders. Used to
// convert a percentage of the video into a count of segments (and
// therefore a count of API calls / images / video-gen seconds).
//
// These are means from Ray's first multi-segment renders; if the
// segmentation prompt changes pacing, refresh them.
export const SEGMENT_AVG_DURATIONS = {
  avatar_secs:        7,   // average length of an avatar segment
  broll_image_secs:   12,  // average length of a b-roll-image segment
  broll_video_secs:   10,  // average length of a b-roll-video segment
  motion_secs:        12,  // average length of a motion-graphics segment
}

// Pure helper — given total video seconds and a percent allocation,
// return the dollar estimate for each segment type. Pure function so
// the UI can call it on every slider drag without round-tripping
// the server.
//
// mix shape: { avatar_pct, broll_image_pct, broll_video_pct, motion_pct }
// source: 'topic' | 'script' | 'voiceover' — drives voice-cost line
// scriptChars: char count of the spoken text (for TTS cost when source=topic/script)
export function estimateContentCost(durationSecs, mix, opts = {}) {
  const r = COST_RATES
  const seg = SEGMENT_AVG_DURATIONS
  const safeDur = Math.max(0, Number(durationSecs) || 0)
  const pct = (k) => Math.max(0, Math.min(100, Number(mix?.[k]) || 0)) / 100

  const avatarSecs       = safeDur * pct('avatar_pct')
  const brollImageSecs   = safeDur * pct('broll_image_pct')
  const brollVideoSecs   = safeDur * pct('broll_video_pct')
  const motionSecs       = safeDur * pct('motion_pct')

  // Convert seconds-of-content into provider units.
  const brollImageCount  = Math.ceil(brollImageSecs / seg.broll_image_secs)
  const brollVideoSecsForGen = brollVideoSecs  // Grok charges per output second

  const avatar      = avatarSecs * r.heygen_avatar_per_sec
  const brollImages = brollImageCount * r.kie_image_per_image
  const brollVideos = brollVideoSecsForGen * r.grok_video_per_sec
  const motion      = 0  // pure HyperFrames + Fly compute, rolled into fly_render_flat

  // Voice cost depends on source.
  let voice = 0
  if (opts.source === 'voiceover') {
    voice = (safeDur / 3600) * r.el_scribe_per_hour       // transcription only
  } else {
    const chars = Number(opts.scriptChars) || (safeDur * 12)  // ~12 chars/sec spoken
    voice = (chars / 1000) * r.el_voice_per_1k_chars
  }

  const fixed = r.claude_segmentation_flat + r.fly_render_flat + voice

  return {
    avatar:      round2(avatar),
    brollImages: round2(brollImages),
    brollVideos: round2(brollVideos),
    motion:      round2(motion),
    voice:       round2(voice),
    claude:      round2(r.claude_segmentation_flat),
    flyRender:   round2(r.fly_render_flat),
    fixed:       round2(fixed),
    total:       round2(avatar + brollImages + brollVideos + motion + fixed),
    // Useful for tooltips ("20% × 600s × $0.05/s = $6.00")
    breakdown: {
      avatarSecs:       Math.round(avatarSecs),
      brollImageSecs:   Math.round(brollImageSecs),
      brollImageCount,
      brollVideoSecs:   Math.round(brollVideoSecs),
      motionSecs:       Math.round(motionSecs),
    },
  }
}

function round2(n) {
  return Math.round(n * 100) / 100
}

// Sensible default mix when the user hasn't set one. Mirrors the
// distribution Ray's real videos converge on naturally: lean on
// motion graphics, sprinkle in b-roll, save avatar for impact beats.
export const DEFAULT_CONTENT_MIX = {
  avatar_pct:       15,
  broll_image_pct:  20,
  broll_video_pct:  15,
  motion_pct:       50,
}
