// Global registry of motion primitives for the Studio template system.
//
// Mirrors MOTION-VOCABULARY.md v1 — 37 primitives across 4 categories.
// Each primitive is a complete, self-contained motion behavior. Duration,
// easing, and intensity are baked in. There are NO runtime parameters or
// modifiers — adding a new behavior requires a new primitive here AND a
// matching keyframe block in the renderer.
//
// Architecture rules (from the spec):
//   1. Each template specifies exactly 4 primitives: one entrance, one
//      exit, one emphasis, one transition.
//   2. All elements in a template use those same 4 primitives — no per-
//      composition or per-overlay overrides.
//   3. Primitives are deterministic. Same input → same animation.
//   4. The renderer implements each primitive once, globally.
//
// This file is the single source of truth for which primitive IDs are
// valid and which category they belong to. The resolver
// (motion-resolver.js) reads from here. The renderer will read keyframe
// definitions from a sibling stylesheet/JS module — not yet wired.

// ─── ENTRANCE (13) ────────────────────────────────────────────────────
export const ENTRANCE_PRIMITIVES = {
  cut:              { duration_ms: 0,    easing: 'linear',                                  category: 'instant' },
  fade_soft:        { duration_ms: 500,  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',           category: 'fade' },
  fade_quick:       { duration_ms: 200,  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',           category: 'fade' },
  crossfade:        { duration_ms: 600,  easing: 'linear',                                  category: 'fade', overlap: true },
  slide_up_fade:    { duration_ms: 500,  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',           category: 'slide' },
  slide_down_fade:  { duration_ms: 500,  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',           category: 'slide' },
  slide_left_fade:  { duration_ms: 500,  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',           category: 'slide' },
  slide_right_fade: { duration_ms: 500,  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',           category: 'slide' },
  scale_in:         { duration_ms: 400,  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',           category: 'scale' },
  pop_in:           { duration_ms: 500,  easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',       category: 'scale' },
  typewriter:       { duration_ms: null, easing: 'linear',                                  category: 'character', per_char_ms: 40, long_text_per_char_ms: 25, requires_js: true },
  staggered_lines:  { duration_ms: 500,  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',           category: 'character', stagger_ms: 100 },
  glitch:           { duration_ms: 350,  easing: 'steps(1)',                                category: 'character', requires_chromatic_aberration: true },
}

// ─── EXIT (8) ─────────────────────────────────────────────────────────
export const EXIT_PRIMITIVES = {
  cut_out:        { duration_ms: 0,   easing: 'linear' },
  fade_out:       { duration_ms: 400, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
  fade_out_quick: { duration_ms: 150, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
  slide_down_out: { duration_ms: 400, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
  slide_up_out:   { duration_ms: 400, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
  slide_off_left: { duration_ms: 400, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
  scale_out:      { duration_ms: 300, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
  glitch_out:     { duration_ms: 250, easing: 'steps(1)', requires_chromatic_aberration: true },
}

// ─── EMPHASIS (8) ─────────────────────────────────────────────────────
// All emphasis primitives loop infinitely while the element is on screen.
export const EMPHASIS_PRIMITIVES = {
  none:             { duration_ms: 0,    easing: 'linear',      loop: false },
  pulse_glow:       { duration_ms: 2000, easing: 'ease-in-out', loop: true, target: 'shadow' },
  subtle_float:     { duration_ms: 4000, easing: 'ease-in-out', loop: true, target: 'transform' },
  breathe_scale:    { duration_ms: 3000, easing: 'ease-in-out', loop: true, target: 'transform' },
  jitter:           { duration_ms: 200,  easing: 'steps(1)',    loop: true, target: 'transform' },
  chromatic_drift:  { duration_ms: 3000, easing: 'ease-in-out', loop: true, target: 'text-shadow' },
  shimmer:          { duration_ms: 5000, easing: 'ease-in-out', loop: true, target: 'background-position' },
  blink_slow:       { duration_ms: 1200, easing: 'steps(1)',    loop: true, target: 'opacity' },
}

// ─── TRANSITION (16) ──────────────────────────────────────────────────
export const TRANSITION_PRIMITIVES = {
  cut_transition:        { duration_ms: 0,    easing: 'linear' },
  fade_transition:       { duration_ms: 600,  easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  dip_to_black:          { duration_ms: 1000, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', phases: ['fade_out_300', 'hold_black_200', 'fade_in_500'] },
  whip:                  { duration_ms: 400,  easing: 'cubic-bezier(0.8, 0, 0.2, 1)', requires_js: true },
  zoom_in:               { duration_ms: 600,  easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  wipe_right:            { duration_ms: 500,  easing: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  dissolve_slow:         { duration_ms: 1200, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  glitch_cut:            { duration_ms: 350,  easing: 'steps(1)', requires_js: true, requires_chromatic_aberration: true },
  // Swipes — scene A exits one direction, scene B enters from the opposite.
  swipe_right:           { duration_ms: 800,  easing: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  swipe_left:            { duration_ms: 800,  easing: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  swipe_up:              { duration_ms: 800,  easing: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  swipe_down:            { duration_ms: 800,  easing: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  swipe_right_fast:      { duration_ms: 500,  easing: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  swipe_left_fast:       { duration_ms: 500,  easing: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  // Cinematic warm flare — bright bloom hides the cut at peak whiteout.
  light_flare_wipe:      { duration_ms: 1200, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  light_flare_wipe_fast: { duration_ms: 600,  easing: 'cubic-bezier(0.65, 0, 0.35, 1)' },
}

// Membership sets — cheap O(1) lookup for validation.
export const ENTRANCE_IDS   = new Set(Object.keys(ENTRANCE_PRIMITIVES))
export const EXIT_IDS       = new Set(Object.keys(EXIT_PRIMITIVES))
export const EMPHASIS_IDS   = new Set(Object.keys(EMPHASIS_PRIMITIVES))
export const TRANSITION_IDS = new Set(Object.keys(TRANSITION_PRIMITIVES))

// Default fallbacks when a template omits a slot or specifies an invalid
// primitive ID. Picked so the renderer NEVER crashes on a typo — it just
// renders the most boring possible motion (no animation at all).
export const MOTION_DEFAULTS = Object.freeze({
  entrance:   'cut',
  exit:       'cut_out',
  emphasis:   'none',
  transition: 'cut_transition',
})

// Convenience: which set does a slot key map to?
export const SLOT_TO_SET = {
  entrance:   ENTRANCE_IDS,
  exit:       EXIT_IDS,
  emphasis:   EMPHASIS_IDS,
  transition: TRANSITION_IDS,
}

export const SLOT_TO_REGISTRY = {
  entrance:   ENTRANCE_PRIMITIVES,
  exit:       EXIT_PRIMITIVES,
  emphasis:   EMPHASIS_PRIMITIVES,
  transition: TRANSITION_PRIMITIVES,
}

export const ALL_SLOTS = ['entrance', 'exit', 'emphasis', 'transition']

// Default pool used to randomize transitions PER SEGMENT BOUNDARY.
// Every video gets a deterministic but varied mix of these. Picked
// because they cover four flavors:
//   1. hard cut         — punctuation, no flourish
//   2. horizontal swipe — directional, snappy
//   3. vertical swipe   — directional, snappy
//   4. light flare wipe — cinematic warm whiteout
// The worker reads this list and seeds picks by (studio_video_id, idx)
// so re-renders are stable. A template can opt out by setting
// motion.transition_pool: [] or motion.transition_pool: false.
export const DEFAULT_TRANSITION_POOL = [
  'swipe_right',
  'swipe_left',
  'swipe_up',
  'swipe_down',
  'cut_transition',
  'light_flare_wipe_fast',
]

// Deterministic pick from a transition pool. Uses a tiny string hash
// (djb2) so re-rendering the same video produces the same transition
// sequence. idx is the segment-boundary index (1-based: boundary between
// segment 0 and 1 is idx=1).
export function pickTransitionForBoundary(seed, idx, pool = DEFAULT_TRANSITION_POOL) {
  if (!Array.isArray(pool) || pool.length === 0) return null
  const key = `${seed || ''}:${idx}`
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0
  return pool[h % pool.length]
}

// Look up a primitive's spec by slot + id. Returns null if not found.
export function getPrimitive(slot, id) {
  const reg = SLOT_TO_REGISTRY[slot]
  if (!reg) return null
  return reg[id] || null
}

// Check whether a primitive id is valid for the given slot.
export function isValidPrimitive(slot, id) {
  const set = SLOT_TO_SET[slot]
  return set ? set.has(id) : false
}
