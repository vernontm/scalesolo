// Global registry of overlay cards.
//
// Overlays are the second layer of the template system. While full-screen
// compositions (composition_pool) take over the entire frame, overlays
// ride ON TOP of avatar footage in defined safe zones. They never touch
// the center column where the avatar speaks.
//
// This file is the single source of truth for:
//   - Which overlays exist
//   - Which zones each overlay is allowed to occupy
//   - Its default zone
//   - Whether it persists across the whole video or appears briefly
//   - Its typical duration
//
// Per-template style tweaks for each overlay live in the template's
// `overlay_overrides` block — NOT here. This registry is template-
// agnostic; the visual styling is filled in by the renderer using
// template overrides.
//
// Each template's `overlay_pool` is a subset of these IDs — that's how
// templates opt in / opt out of specific overlays.

export const OVERLAY_DEFINITIONS = {
  // Big stat callout that floats on top of avatar footage. Common
  // pairing: avatar says "I grew from 56 to 900 followers" and a
  // stat-callout pops up with "900 FOLLOWERS · 20 DAYS" in r-mid.
  'stat-callout-v1': {
    name: 'Stat callout',
    description: 'Floating number + label card. Use to back up a spoken statistic.',
    allowed_zones: ['l-top', 'l-mid', 'l-bot', 'r-top', 'r-mid', 'r-bot', 'left_overlay', 'right_overlay'],
    default_zone: 'right_overlay',
    persistent: false,
    duration_pattern: 'speaker_paired',
    typical_duration_secs: 3,
  },

  // Tight emphasis cue under the avatar — "ONE WORD" style.
  // Animates in and out fast, lower-third only.
  'word-emphasis-v1': {
    name: 'Word emphasis',
    description: 'Single word or short phrase highlight under the avatar.',
    allowed_zones: ['lower-third'],
    default_zone: 'lower-third',
    persistent: false,
    duration_pattern: 'timed',
    typical_duration_secs: 0.8,
  },

  // Live captions of what the avatar is saying. Reads from the segment's
  // script_text. Speaker-paired so it appears for the duration of the
  // speaking segment.
  'caption-overlay-v1': {
    name: 'Captions',
    description: 'Word-by-word or line-by-line caption track over avatar speech.',
    allowed_zones: ['lower-third'],
    default_zone: 'lower-third',
    persistent: false,
    duration_pattern: 'speaker_paired',
    typical_duration_secs: 4,
  },

  // Branded logo card — used when the avatar mentions a specific tool.
  // E.g. "I use HeyGen for the avatar work" → tool-logo-v1 with HeyGen
  // logo pops in r-top.
  'tool-logo-v1': {
    name: 'Tool logo',
    description: 'Logo card referencing a specific tool the avatar is talking about.',
    allowed_zones: ['l-top', 'l-mid', 'r-top', 'r-mid', 'left_overlay', 'right_overlay'],
    default_zone: 'right_overlay',
    persistent: false,
    duration_pattern: 'speaker_paired',
    typical_duration_secs: 4,
  },

  // Brand watermark — persistent corner mark for the entire video.
  // Different from other overlays: corners run in parallel with side
  // slots, never conflict.
  'watermark-v1': {
    name: 'Watermark',
    description: 'Persistent brand mark in a corner for the whole video.',
    allowed_zones: ['corner-tl', 'corner-tr', 'corner-bl', 'corner-br'],
    default_zone: 'corner-tr',
    persistent: true,
    duration_pattern: 'persistent',
    typical_duration_secs: null,
  },

  // "Save this," "Follow for more," "Subscribe now" prompt. Larger
  // than word-emphasis. Hangs on screen for the moment the avatar
  // asks for engagement.
  'action-prompt-v1': {
    name: 'Action prompt',
    description: 'CTA card prompting follow / save / subscribe / etc.',
    allowed_zones: ['l-mid', 'r-mid', 'lower-third', 'left_overlay', 'right_overlay'],
    default_zone: 'right_overlay',
    persistent: false,
    duration_pattern: 'timed',
    typical_duration_secs: 5,
  },

  // "Source: X" attribution for a stat the avatar just cited. Sits in
  // the lower side slots so it doesn't compete with the speaker.
  'source-citation-v1': {
    name: 'Source citation',
    description: 'Small "Source: …" attribution card.',
    allowed_zones: ['l-bot', 'r-bot', 'left_overlay', 'right_overlay'],
    default_zone: 'left_overlay',
    persistent: false,
    duration_pattern: 'timed',
    typical_duration_secs: 4,
  },

  // Chapter title marker. In landscape it goes in a top side slot;
  // in vertical there's a dedicated top-strip zone above the avatar.
  'chapter-marker-v1': {
    name: 'Chapter marker',
    description: 'Section / chapter title that flags a new beat in the video.',
    // top-strip is only valid in vertical; the zone-resolver
    // rejects it when orientation is landscape.
    allowed_zones: ['l-top', 'r-top', 'top-strip', 'left_overlay', 'right_overlay'],
    default_zone: 'left_overlay',
    persistent: false,
    duration_pattern: 'timed',
    typical_duration_secs: 2.5,
  },
}

// All overlay IDs. Cheap helper for membership checks.
export const OVERLAY_IDS = Object.keys(OVERLAY_DEFINITIONS)

// Zones that are persistent-capable across the whole video. Used by
// the zone-resolver to know that an overlay can run in parallel with
// other overlays without blocking their slot.
export const PERSISTENT_ZONES = new Set([
  'corner-tl', 'corner-tr', 'corner-bl', 'corner-br',
])

// All valid zones across both orientations. Used for validation.
//
// V2 layout (OVERLAY-FIX-V2.md): one large vertically-centered slot
// per side (left_overlay, right_overlay) replaces the V1 6-slot
// stack (l-top/l-mid/l-bot/r-top/r-mid/r-bot). Old zones stay valid
// for backward compatibility — the CSS in _ov-universal.css collapses
// every l-*/r-* zone to the same centered single-slot position, so
// existing data still renders correctly.
export const ALL_ZONES = new Set([
  // V2 zones — preferred
  'left_overlay', 'right_overlay',
  // V1 zones — legacy, still valid, rendered as centered single slot
  'l-top', 'l-mid', 'l-bot',
  'r-top', 'r-mid', 'r-bot',
  'lower-third',
  'top-strip',          // vertical only
  'corner-tl', 'corner-tr', 'corner-bl', 'corner-br',
])

// Zones that only exist in vertical orientation.
export const VERTICAL_ONLY_ZONES = new Set(['top-strip'])

// Zones that only exist in landscape orientation. None currently —
// landscape doesn't have anything vertical lacks. Defined for symmetry
// in case we ever add e.g. a 'side-banner' that's landscape-only.
export const LANDSCAPE_ONLY_ZONES = new Set([])

export function getOverlay(id) {
  return OVERLAY_DEFINITIONS[id] || null
}

export function isValidZoneForOrientation(zone, orientation) {
  if (!ALL_ZONES.has(zone)) return false
  if (orientation === 'landscape' && VERTICAL_ONLY_ZONES.has(zone)) return false
  if (orientation === 'vertical' && LANDSCAPE_ONLY_ZONES.has(zone)) return false
  return true
}
