// Default SFX pairings for every motion primitive. Null means silent
// (a valid pairing — most emphasis primitives are intentionally quiet
// since looping sound becomes annoying fast).
//
// Mirrors the tables in SFX-VOCABULARY.md "DEFAULT MOTION → SFX
// PAIRINGS." The resolver in sfx-resolver.js starts with these
// defaults and applies per-template overrides on top.

export const DEFAULT_PAIRINGS = {
  entrance: {
    cut:              null,
    fade_soft:        null,
    fade_quick:       'tick',
    crossfade:        null,
    slide_up_fade:    'swoosh_mid',
    slide_down_fade:  'swoosh_mid',
    slide_left_fade:  'swoosh_fast',
    slide_right_fade: 'swoosh_fast',
    scale_in:         'pop_soft',
    pop_in:           'pop_punch',
    typewriter:       'type_key',        // fires per character — renderer handles repetition
    staggered_lines:  'tick',            // fires per line
    glitch:           'glitch_short',
  },
  exit: {
    cut_out:        null,
    fade_out:       null,
    fade_out_quick: null,
    slide_down_out: 'swoosh_drop',
    slide_up_out:   'swoosh_riser',
    slide_off_left: 'swoosh_fast',
    scale_out:      null,
    glitch_out:     'glitch_short',
  },
  emphasis: {
    none:             null,
    pulse_glow:       null,
    subtle_float:     null,
    breathe_scale:    null,
    jitter:           'static_loop_short',  // loops while element is onscreen
    chromatic_drift:  null,
    shimmer:          null,
    blink_slow:       null,
  },
  transition: {
    cut_transition:  null,
    fade_transition: null,
    dip_to_black:    'dip_thud',
    whip:            'whip_short',
    zoom_in:         'swoosh_riser',
    wipe_right:      'swoosh_mid',
    dissolve_slow:   'swell_warm',
    glitch_cut:      'glitch_long',
    // Horizontal swipes feel mid-paced; vertical swipes read snappier.
    swipe_right:           'swoosh_mid',
    swipe_left:            'swoosh_mid',
    swipe_up:              'swoosh_fast',
    swipe_down:            'swoosh_fast',
    swipe_right_fast:      'whip_short',
    swipe_left_fast:       'whip_short',
    // Light flare wipe — warm cinematic whoosh under the bloom.
    light_flare_wipe:      'whoosh_cinematic',
    light_flare_wipe_fast: 'swoosh_mid',
  },
}

// Which layers fire at each density level. Read by the resolver as a
// gate: when density is "low", exits + emphasis are dropped regardless
// of pairing.
export const DENSITY_LAYERS = {
  off:    new Set(),
  low:    new Set(['entrance', 'transition']),
  medium: new Set(['entrance', 'exit', 'transition']),
  high:   new Set(['entrance', 'exit', 'emphasis', 'transition']),
}

export const DENSITY_VALUES = ['off', 'low', 'medium', 'high']

// Convenience helpers — slot is one of entrance/exit/emphasis/transition.
export function defaultPairing(slot, primitiveId) {
  const table = DEFAULT_PAIRINGS[slot]
  if (!table) return null
  return table[primitiveId] || null
}
