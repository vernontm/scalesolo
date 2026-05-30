// Studio visual templates. Each entry is the full spec for one preset
// that bundles every visual + motion + audio decision into one choice.
// Users pick one when starting a new video, then customize the brand
// color via a color picker. Everything else cascades from here.
//
// Why constants instead of a DB table:
//   - Iteration speed. Tweaking a template spec is a code change, not
//     a migration. We need to move fast in v1.
//   - Type safety. Each template's shape is enforced in the renderer
//     pipeline; a malformed DB row would be discovered at run time.
//   - Versioning. Templates are part of the deploy. A user opening an
//     old video that referenced a deleted template id sees a graceful
//     fallback to 'sleek' instead of a 500.
//
// When Ray drops in more templates from his Claude-assisted spec work,
// they just slot in here as new entries. Both Studio's frontend
// (template picker) and the segmentation prompt + render pipeline read
// from this exact same export.

export const SLEEK = {
  id: 'sleek',
  name: 'Sleek',
  description: 'Dark canvas, animated red grid, chrome typography, glass-morphism cards, soft red glow. ScaleSolo signature.',
  when_to_use: 'Tech, AI, modern brands. Anything that benefits from a futuristic, premium feel.',
  tags: ['tech', 'ai', 'modern', 'premium', 'futuristic'],
  recommended_for: ['explainers', 'product launches', 'founder content'],

  background: {
    base_color: '#0a0a0c',
    pattern: 'grid',
    pattern_color: '{accent}',
    pattern_opacity: 0.15,
    pattern_motion: 'drift_slow',
    glow: { color: '{accent}', position: 'top_right', intensity: 0.4 },
    texture_overlay: 'none',
  },
  colors: {
    primary_accent: '#e3151e',
    secondary_accent: '#ff3742',  // brighter red for gradients / glow tail
    text_primary: '#ffffff',
    text_secondary: 'rgba(255,255,255,0.65)',
    text_muted: 'rgba(255,255,255,0.40)',
    surface_card: 'rgba(255,255,255,0.06)',
    surface_border: 'rgba(255,255,255,0.12)',
  },
  typography: {
    display_font: 'Plus Jakarta Sans',
    display_weight: 900,
    display_treatment: 'chrome',
    display_case: 'sentence',
    display_letter_spacing: '-0.02em',
    body_font: 'Plus Jakarta Sans',
    body_weight: 600,
    mono_font: 'JetBrains Mono',
    mono_weight: 700,
    accent_word_treatment: 'color_glow',
  },
  cards: {
    container_style: 'glass_morphism',
    border_treatment: 'subtle_red',
    border_width_px: 1,
    corner_radius_px: 12,
    shadow_style: 'soft_glow',
    backdrop_blur_px: 12,
  },
  // Motion vocabulary v1 — exactly 4 primitives, one per slot. IDs are
  // validated against api/studio/_lib/motion-primitives.js. All elements
  // in this template use these 4 — no per-composition or per-overlay
  // overrides. See MOTION-VOCABULARY.md for the full spec.
  motion: {
    entrance:   'slide_up_fade',   // gentle rise + fade, 500ms
    exit:       'fade_out',        // standard 400ms ease-in
    emphasis:   'pulse_glow',      // 2s box/text-shadow pulse on accent
    transition: 'fade_transition', // 600ms crossfade between segments
  },
  default_transition: 'fade',
  // v1 full-screen composition pool. Expanded from the original 7 to 10
  // per the new architecture brief. Three are new and don't have HTML
  // files yet (hook-card-v1, caption-card-v1, subscribe-cta-v1) — the
  // renderer should fall back to the drawtext stub for them until the
  // compositions ship. Three more (process-timeline-v1, chapter-card-v1,
  // diagram-card-v1) are v2 and intentionally NOT in this pool.
  composition_pool: [
    // Sleek v2 pool — four full-screen compositions, content-driven:
    //   - sleek-scene-headline-v1: any "big text on screen" moment
    //     (titles, quotes, stat reveals, single-line punchlines).
    //     The accent span is where the punchy number / phrase lands.
    //   - sleek-scene-list-v1: anything enumerated — 3-5 items.
    //   - sleek-scene-claude-chat-v1: when the speaker references
    //     asking / telling Claude something. Renders a Claude UI
    //     mock with the user's prompt + Claude's reply typing out
    //     word-by-word.
    //   - sleek-scene-cta-v1: the final segment only. Big button +
    //     hero handle. Auto-fit reserves this for the LAST segment.
    'sleek-scene-headline-v1',
    // Typewriter variant of the headline — same fonts + gradient,
    // words land one-by-one with a blinking cursor. Use for hooks
    // and identity beats where the "still being typed" feel adds
    // anticipation. Same composition_id contract — meta-strip is
    // stripped by the worker.
    'sleek-scene-headline-typewriter-v1',
    'sleek-scene-list-v1',
    'sleek-scene-claude-chat-v1',
    'sleek-scene-cta-v1',
  ],
  // sleek-scene-screenshot-v1 is INTENTIONALLY not in composition_pool.
  // It's reserved for segment_type='screenshot' — the worker hardcodes
  // {template_id}-scene-screenshot-v1 in that branch. Adding it to the
  // pool would let Claude pick it for a motion-graphics segment, which
  // would fail at render time (no screenshot_url variable).
  composition_overrides: {
    'stat-reveal-v1': { number_treatment: 'chrome_with_red_glow' },
    'quote-card-v1':  { quote_mark_color: '{accent}', quote_mark_opacity: 0.18 },
  },

  // ─── ZONE SYSTEM ─────────────────────────────────────
  // Per-orientation overlay placement grid. The center column /
  // center rows are never touched here — those are reserved for the
  // avatar. The zone-resolver enforces those rules; this block just
  // declares the geometry for the renderer to position cards.
  zone_system: {
    landscape: {
      side_column_width_pct: 27,
      side_column_inset_pct: 3,
      side_slot_positions: { top: 5, mid: 38, bot: 60 },
      lower_third:      { bottom_pct: 5, side_inset_pct: 3 },
      corners_inset_pct: 3,
    },
    vertical: {
      side_column_width_pct: 28,
      side_column_inset_pct: 3,
      side_slot_positions: { top: 14, mid: 40, bot: 62 },
      top_strip:        { top_pct: 3, side_inset_pct: 3 },
      lower_third:      { bottom_pct: 5, side_inset_pct: 3 },
      corners_inset_pct: 3,
    },
  },

  // ─── OVERLAY POOL ────────────────────────────────────
  // All 8 v1 overlays enabled for Sleek. Subset templates may opt
  // out of some (e.g. a minimalist preset might drop tool-logo +
  // chapter-marker for cleaner look).
  overlay_pool: [
    'stat-callout-v1',
    // word-emphasis-v1 removed: captions already highlight one
    // emphasized word per phrase via the .highlight span, and both
    // overlays live in lower-third → they were stacking visually.
    'caption-overlay-v1',
    'tool-logo-v1',
    'watermark-v1',
    'action-prompt-v1',
    'source-citation-v1',
    // chapter-marker-v1 retired — Ray didn't want the top-left
    // "VTM SCENE" / chapter labels on any template. The worker also
    // filters out any chapter-marker placements that come through
    // from older enrichment runs as a defensive backstop.
  ],

  // ─── OVERLAY OVERRIDES ──────────────────────────────
  // Per-overlay style tokens for Sleek, extracted verbatim from the
  // canonical showcase at outputs/sleek-overlays.html. The renderer
  // reads these to build each overlay card — every value here maps to
  // a specific CSS property on the matching .ov-* class in the
  // overlay_overrides retired — the universal .ov-card system in
  // _ov-universal.css now drives ALL overlay styling. Per-template
  // visual flavor comes from the .tokens-<template> CSS class (set
  // via accent + accent_2 brand colors). Leaving an empty object
  // here so any legacy code path that reads `tmpl.overlay_overrides`
  // gets a defined value instead of undefined.
  overlay_overrides: {},
  audio: {
    // Legacy fields kept for backwards compat — generate-map.js still
    // reads `audio.sfx_pool` + `audio.sfx_density` when assembling the
    // segmentation prompt. The new resolver reads from `sfx` below.
    sfx_pool: ['swoosh', 'subtle_chime', 'impact'],
    sfx_density: 'medium',
    music_mood: 'futuristic_calm',
    music_volume: 0.12,
  },
  // SFX block — read by sfx-resolver.js. Pairs each of Sleek's motion
  // primitives with a sound. Overrides bump the entrance + transition
  // whoosh from the default `swoosh_mid` to the more cinematic
  // `swoosh_low` to match Sleek's premium, deliberate feel.
  // Standalone triggers fire at known content beats (title hero, stat
  // land, end card) — see STANDALONE_EVENTS in sfx-bank.js.
  sfx: {
    density: 'medium',
    // -6dB from the previous 0.5 default — Ray was hearing SFX too hot
    // over the voice. 10^(-6/20) ≈ 0.501, so 0.5 × 0.501 ≈ 0.25.
    master_volume: 0.25,
    pack: 'default',
    overrides: {
      // Ray's hand-picked SFX. Lighter, snappier "designed UI" feel
      // than the generated bank. Each maps to a single Sleek beat:
      //   entrance   → ux_swipe   (segment opens, light whoosh)
      //   exit       → ux_swipe   (mirror entrance — same character)
      //   transition → ux_zoom    (between-segment crossfade beat)
      //   emphasis   → null       (no looping emphasis SFX in v1)
      entrance:   'ux_swipe',
      exit:       'ux_swipe',
      transition: 'ux_zoom',
    },
    standalone_triggers: [
      { event: 'title_hero',     sfx: 'ux_ding'  },
      { event: 'stat_land',      sfx: 'ux_ding'  },
      // chapter_change retired with chapter-marker-v1 — kept out of
      // the trigger list so no SFX fires on a beat that no longer
      // has a visible overlay.
      { event: 'subscribe_cta',  sfx: 'ux_ding'  },
      { event: 'end_card',       sfx: 'ux_ding'  },
      // Plays once when overlay cards animate in (segStart + 0.25s).
      // Worker auto-emits this event on any segment whose
      // overlay_placements array is non-empty.
      { event: 'card_enter',     sfx: 'ux_zoom'  },
    ],
  },
  pacing: {
    segment_duration_avg_secs: 4.5,
    hook_segment_max_secs: 2.5,
    rhythm: 'balanced',
    hard_cap_motion_density: 0.5,
  },
  avatar: {
    frame_treatment: 'full',
    avatar_glow: 'matching_accent',
    orientation_preferred: 'landscape',
  },
  captions: {
    enabled: true,
    position: 'lower_third',
    font_scale: 'large',
    animation: 'word_by_word',
    highlight_color: '{accent}',
  },

  // Drives the inline template-selector live preview iframe. Each
  // template gets a dedicated *-template-preview-*.html composition
  // that showcases its full visual signature in one frame: the
  // background pattern + motion, typography treatment, card style,
  // accent glow, etc. Cheap to swap when the accent_color changes
  // since the composition reads CSS vars from window.__studioVars.
  preview: {
    composition_id: 'template-preview-sleek-v1',
    variables: {
      label: '[ THE SHIFT ]',
      stat_number: '10x',
      stat_label: 'faster shipping with AI as your back-end team.',
      corner_label: 'STAT-REVEAL-V1',
      accent_color: '{accent}',
      accent_2_color: '{accent_2}',
    },
  },
}

// ─── ATLAS ─────────────────────────────────────────────────────────────
// Atlas is the second first-class template. Indigo + purple gradient,
// dot-pattern background with an orbiting spotlight, "highlight sweep"
// effect on accent text. Designed for vertical (9:16) but also picks
// fine for any aspect — the scene scales to fit. Mirror structure to
// SLEEK so the resolver, prompts, worker etc. can read it the same way.
export const ATLAS = {
  id: 'atlas',
  name: 'Atlas',
  description: 'Indigo-to-purple gradient, dot-pattern background, "highlight sweep" accents. Refined, modern, premium.',
  when_to_use: 'Tech founder / SaaS / AI content. When you want something more "designed editorial" and less "dark cinematic."',
  tags: ['tech', 'ai', 'modern', 'premium', 'editorial'],
  recommended_for: ['explainers', 'product walkthroughs', 'founder content'],

  background: {
    base_color: '#0a0a0f',
    pattern: 'dots',
    pattern_color: 'rgba(255,255,255,0.07)',
    pattern_motion: 'spotlight_orbit',
    glow: { color: '{accent}', position: 'top_center', intensity: 0.18 },
  },
  colors: {
    primary_accent: '#818cf8',     // indigo-soft (matches the dot bright + handle gradient start)
    secondary_accent: '#a855f7',   // purple
    text_primary: '#ffffff',
    text_secondary: 'rgba(255,255,255,0.7)',
    text_muted: 'rgba(255,255,255,0.42)',
    surface_card: 'rgba(255,255,255,0.04)',
    surface_border: 'rgba(255,255,255,0.08)',
  },
  typography: {
    display_font: 'Plus Jakarta Sans',
    display_weight: 800,
    display_treatment: 'highlight_sweep',
    body_font: 'Plus Jakarta Sans',
    body_weight: 500,
    mono_font: 'JetBrains Mono',
  },

  composition_pool: [
    'atlas-scene-headline-v1',
    'atlas-scene-list-v1',
    'atlas-scene-claude-chat-v1',
    'atlas-scene-cta-v1',
  ],
  // atlas-scene-screenshot-v1 reserved for segment_type='screenshot' —
  // see SLEEK note above.

  // Atlas uses the same overlay set as Sleek. Visual styling is
  // driven entirely by the universal .ov-card system in
  // _ov-universal.css — Atlas just gets a different .tokens-atlas
  // CSS class on the overlay wrapper, which swaps accent colors,
  // fonts, and radius. No per-template overlay_overrides needed.
  overlay_pool: SLEEK.overlay_pool,
  overlay_overrides: {},

  // Motion + sfx — same vocabulary as Sleek, slightly different feel.
  // Highlight sweep ≈ pulse_glow. Use ux_swipe for entrance/exit so the
  // dot-pattern transitions don't fight with a heavier whoosh.
  motion: {
    entrance: 'slide_up_fade',
    exit: 'fade_out',
    emphasis: 'pulse_glow',
    transition: 'fade_transition',
  },
  sfx: {
    density: 'medium',
    // -6dB from the previous 0.5 default — Ray was hearing SFX too hot
    // over the voice. 10^(-6/20) ≈ 0.501, so 0.5 × 0.501 ≈ 0.25.
    master_volume: 0.25,
    pack: 'default',
    overrides: {
      entrance: 'ux_swipe',
      exit: 'ux_swipe',
      transition: 'ux_zoom',
    },
    standalone_triggers: [
      { event: 'title_hero',     sfx: 'ux_ding' },
      // chapter_change retired with chapter-marker-v1.
      { event: 'subscribe_cta',  sfx: 'ux_ding' },
      { event: 'end_card',       sfx: 'ux_ding' },
      { event: 'card_enter',     sfx: 'ux_zoom' },
    ],
  },

  audio: SLEEK.audio,  // legacy block, kept for backwards compat
  pacing: SLEEK.pacing,
  zone_system: SLEEK.zone_system,
  default_transition: 'fade',

  preview: {
    // The picker shows this composition in a live iframe. We reuse the
    // actual headline composition so what you see is what bakes.
    composition_id: 'atlas-scene-headline-v1',
    variables: {
      title_pre: 'Ship faster with',
      title_highlight: 'AI as your team',
      accent_color: '{accent}',
      accent_2_color: '{accent_2}',
    },
  },
}

// Add more templates here as Ray finishes spec'ing them.
export const TEMPLATES = [SLEEK, ATLAS]
export const TEMPLATE_BY_ID = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]))

export function getTemplate(id) {
  return TEMPLATE_BY_ID[id] || SLEEK
}

// Resolve "{accent}" + "{accent_2}" placeholders against the user's
// brand primary + secondary colors. Returns a cloned template with
// strings interpolated. Used by both the segmentation prompt and the
// renderer when it picks CSS variables for the iframe.
//
// brandColor / brandColor2 are both optional. Each falls back to the
// template's own primary/secondary accent so a template selected
// without any brand-color override still renders correctly.
export function resolveTemplate(id, brandColor, brandColor2) {
  const tmpl = getTemplate(id)
  const accent   = brandColor  || tmpl.colors.primary_accent
  const accent_2 = brandColor2 || tmpl.colors.secondary_accent || accent
  const replace = (v) => {
    if (typeof v !== 'string') return v
    return v.replace(/\{accent_2\}/g, accent_2).replace(/\{accent\}/g, accent)
  }
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(node)) out[k] = walk(v)
      return out
    }
    return replace(node)
  }
  const resolved = walk(tmpl)
  // Force the resolved accents into colors so anything downstream
  // that reads them gets the user's brand colors, not the template's
  // defaults.
  resolved.colors.primary_accent = accent
  resolved.colors.secondary_accent = accent_2
  return resolved
}
