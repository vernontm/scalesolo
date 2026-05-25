// Registry of all 42 SFX in the generic sound bank. Mirrors
// SFX-VOCABULARY.md v1. Each entry carries the file path (relative to
// /public), duration, category, and a default volume that the resolver
// multiplies by the template's master_volume at render time.
//
// Audio files: generated via the script in /scripts/generate_sfx.py
// (ElevenLabs Sound Effects API). Output is mp3 at 44.1kHz/128kbps,
// organized by category folder. Run once and drop the resulting /sfx/
// directory into /public/. The renderer treats a missing file as a
// soft warn + silence — never a crash. See sfx-resolver.js for the
// file_missing fallback behavior.
//
// IMPORTANT: file paths below assume mp3 output. If you change the
// generator to wav, update both this file AND any worker mixing logic
// that lists the file extension.

export const SFX_BANK = {
  // ─── IMPACTS (8) ──────────────────────────────────────────────────
  impact_soft:  { id: 'impact_soft',  file: '/sfx/impacts/impact_soft.mp3',  duration_ms: 350, default_volume: 0.8, category: 'impact' },
  impact_hard:  { id: 'impact_hard',  file: '/sfx/impacts/impact_hard.mp3',  duration_ms: 400, default_volume: 0.9, category: 'impact' },
  impact_bass:  { id: 'impact_bass',  file: '/sfx/impacts/impact_bass.mp3',  duration_ms: 800, default_volume: 0.9, category: 'impact' },
  pop_soft:     { id: 'pop_soft',     file: '/sfx/impacts/pop_soft.mp3',     duration_ms: 200, default_volume: 0.6, category: 'impact' },
  pop_punch:    { id: 'pop_punch',    file: '/sfx/impacts/pop_punch.mp3',    duration_ms: 250, default_volume: 0.7, category: 'impact' },
  slam_metal:   { id: 'slam_metal',   file: '/sfx/impacts/slam_metal.mp3',   duration_ms: 500, default_volume: 0.9, category: 'impact' },
  thud_paper:   { id: 'thud_paper',   file: '/sfx/impacts/thud_paper.mp3',   duration_ms: 300, default_volume: 0.6, category: 'impact' },
  boom_sub:     { id: 'boom_sub',     file: '/sfx/impacts/boom_sub.mp3',     duration_ms: 600, default_volume: 0.85, category: 'impact' },

  // ─── WHOOSHES (7) ─────────────────────────────────────────────────
  swoosh_low:        { id: 'swoosh_low',        file: '/sfx/whooshes/swoosh_low.mp3',        duration_ms: 600, default_volume: 0.6, category: 'whoosh' },
  swoosh_mid:        { id: 'swoosh_mid',        file: '/sfx/whooshes/swoosh_mid.mp3',        duration_ms: 400, default_volume: 0.65, category: 'whoosh' },
  swoosh_fast:       { id: 'swoosh_fast',       file: '/sfx/whooshes/swoosh_fast.mp3',       duration_ms: 250, default_volume: 0.7, category: 'whoosh' },
  swoosh_riser:      { id: 'swoosh_riser',      file: '/sfx/whooshes/swoosh_riser.mp3',      duration_ms: 800, default_volume: 0.7, category: 'whoosh' },
  swoosh_drop:       { id: 'swoosh_drop',       file: '/sfx/whooshes/swoosh_drop.mp3',       duration_ms: 600, default_volume: 0.65, category: 'whoosh' },
  whip_short:        { id: 'whip_short',        file: '/sfx/whooshes/whip_short.mp3',        duration_ms: 300, default_volume: 0.75, category: 'whoosh' },
  air_brush:         { id: 'air_brush',         file: '/sfx/whooshes/air_brush.mp3',         duration_ms: 500, default_volume: 0.5, category: 'whoosh' },

  // ─── UI / PINGS (6) ───────────────────────────────────────────────
  ping_clean:   { id: 'ping_clean',   file: '/sfx/ui/ping_clean.mp3',   duration_ms: 700,  default_volume: 0.55, category: 'ui' },
  ping_soft:    { id: 'ping_soft',    file: '/sfx/ui/ping_soft.mp3',    duration_ms: 800,  default_volume: 0.5, category: 'ui' },
  chime_short:  { id: 'chime_short',  file: '/sfx/ui/chime_short.mp3',  duration_ms: 600,  default_volume: 0.6, category: 'ui' },
  tick:         { id: 'tick',         file: '/sfx/ui/tick.mp3',         duration_ms: 80,   default_volume: 0.5, category: 'ui' },
  notif_pop:    { id: 'notif_pop',    file: '/sfx/ui/notif_pop.mp3',    duration_ms: 300,  default_volume: 0.6, category: 'ui' },
  bell_brass:   { id: 'bell_brass',   file: '/sfx/ui/bell_brass.mp3',   duration_ms: 1200, default_volume: 0.55, category: 'ui' },

  // ─── GLITCH / DIGITAL (6) ─────────────────────────────────────────
  glitch_short:      { id: 'glitch_short',      file: '/sfx/glitch/glitch_short.mp3',      duration_ms: 250,  default_volume: 0.7, category: 'glitch' },
  glitch_long:       { id: 'glitch_long',       file: '/sfx/glitch/glitch_long.mp3',       duration_ms: 600,  default_volume: 0.75, category: 'glitch' },
  static_burst:      { id: 'static_burst',      file: '/sfx/glitch/static_burst.mp3',      duration_ms: 200,  default_volume: 0.65, category: 'glitch' },
  static_loop_short: { id: 'static_loop_short', file: '/sfx/glitch/static_loop_short.mp3', duration_ms: 1000, default_volume: 0.45, category: 'glitch', loopable: true },
  vhs_rewind:        { id: 'vhs_rewind',        file: '/sfx/glitch/vhs_rewind.mp3',        duration_ms: 800,  default_volume: 0.7, category: 'glitch' },
  bit_crush:         { id: 'bit_crush',         file: '/sfx/glitch/bit_crush.mp3',         duration_ms: 400,  default_volume: 0.7, category: 'glitch' },

  // ─── MECHANICAL / TACTILE (5) ─────────────────────────────────────
  type_key:     { id: 'type_key',     file: '/sfx/mechanical/type_key.mp3',     duration_ms: 60,  default_volume: 0.5, category: 'mechanical' },
  type_clack:   { id: 'type_clack',   file: '/sfx/mechanical/type_clack.mp3',   duration_ms: 80,  default_volume: 0.6, category: 'mechanical' },
  paper_rustle: { id: 'paper_rustle', file: '/sfx/mechanical/paper_rustle.mp3', duration_ms: 500, default_volume: 0.5, category: 'mechanical' },
  wood_knock:   { id: 'wood_knock',   file: '/sfx/mechanical/wood_knock.mp3',   duration_ms: 200, default_volume: 0.6, category: 'mechanical' },
  stamp:        { id: 'stamp',        file: '/sfx/mechanical/stamp.mp3',        duration_ms: 350, default_volume: 0.75, category: 'mechanical' },

  // ─── CINEMATIC / ATMOSPHERIC (5) ──────────────────────────────────
  riser_short:       { id: 'riser_short',       file: '/sfx/cinematic/riser_short.mp3',       duration_ms: 1000, default_volume: 0.6, category: 'cinematic' },
  drone_hit:         { id: 'drone_hit',         file: '/sfx/cinematic/drone_hit.mp3',         duration_ms: 1500, default_volume: 0.7, category: 'cinematic' },
  swell_warm:        { id: 'swell_warm',        file: '/sfx/cinematic/swell_warm.mp3',        duration_ms: 1200, default_volume: 0.5, category: 'cinematic' },
  dip_thud:          { id: 'dip_thud',          file: '/sfx/cinematic/dip_thud.mp3',          duration_ms: 600,  default_volume: 0.8, category: 'cinematic' },
  whoosh_cinematic:  { id: 'whoosh_cinematic',  file: '/sfx/cinematic/whoosh_cinematic.mp3',  duration_ms: 1000, default_volume: 0.65, category: 'cinematic' },

  // ─── USER UX (4) ─ Ray's hand-picked SFX in /public/sfx/ux/.
  // Take precedence over the generated bank for the four most common
  // beats. Smaller, snappier, more "designed UI" feel than the
  // ElevenLabs-generated ones.
  ux_click: { id: 'ux_click', file: '/sfx/ux/mouse-click.mp3', duration_ms: 120, default_volume: 0.6, category: 'ui' },
  ux_ding:  { id: 'ux_ding',  file: '/sfx/ux/ding.mp3',        duration_ms: 600, default_volume: 0.55, category: 'ui' },
  ux_swipe: { id: 'ux_swipe', file: '/sfx/ux/swipe.mp3',       duration_ms: 350, default_volume: 0.7, category: 'whoosh' },
  ux_zoom:  { id: 'ux_zoom',  file: '/sfx/ux/zoom.mp3',        duration_ms: 500, default_volume: 0.7, category: 'cinematic' },

  // ─── STINGERS / HITS (5) ──────────────────────────────────────────
  sting_short:     { id: 'sting_short',     file: '/sfx/stingers/sting_short.mp3',     duration_ms: 600,  default_volume: 0.7, category: 'stinger' },
  sting_subscribe: { id: 'sting_subscribe', file: '/sfx/stingers/sting_subscribe.mp3', duration_ms: 800,  default_volume: 0.75, category: 'stinger' },
  sting_logo:      { id: 'sting_logo',      file: '/sfx/stingers/sting_logo.mp3',      duration_ms: 1200, default_volume: 0.8, category: 'stinger' },
  sting_punch:     { id: 'sting_punch',     file: '/sfx/stingers/sting_punch.mp3',     duration_ms: 400,  default_volume: 0.85, category: 'stinger' },
  sting_resolve:   { id: 'sting_resolve',   file: '/sfx/stingers/sting_resolve.mp3',   duration_ms: 1000, default_volume: 0.7, category: 'stinger' },
}

export const SFX_IDS = Object.keys(SFX_BANK)

// Standalone trigger event vocabulary. Compositions emit these events
// at known beats (title hero appears, stat lands, CTA fires); the
// template's standalone_triggers array maps them to SFX ids. Defined
// up here so the resolver can validate.
export const STANDALONE_EVENTS = new Set([
  'title_hero',          // big headline reveal
  'stat_land',           // stat number lands at end of pop_in
  'end_card',            // final segment hero element appears
  'subscribe_cta',       // subscribe-cta-v1 composition reveals
  'chapter_change',      // chapter-marker-v1 swap
  'comparison_after',    // comparison-v1 AFTER column reveals
  'command_complete',    // mono-terminal command finishes
])

export function getSfx(id) {
  return SFX_BANK[id] || null
}

export function isValidSfxId(id) {
  return Object.prototype.hasOwnProperty.call(SFX_BANK, id)
}
