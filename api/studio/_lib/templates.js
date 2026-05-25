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
    'sleek-scene-list-v1',
    'sleek-scene-claude-chat-v1',
    'sleek-scene-cta-v1',
  ],
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
    'word-emphasis-v1',
    'caption-overlay-v1',
    'tool-logo-v1',
    'watermark-v1',
    'action-prompt-v1',
    'source-citation-v1',
    'chapter-marker-v1',
  ],

  // ─── OVERLAY OVERRIDES ──────────────────────────────
  // Per-overlay style tokens for Sleek, extracted verbatim from the
  // canonical showcase at outputs/sleek-overlays.html. The renderer
  // reads these to build each overlay card — every value here maps to
  // a specific CSS property on the matching .ov-* class in the
  // showcase. Keep this block in sync with that file: if the showcase
  // changes, these tokens change too.
  overlay_overrides: {
    // .ov-stat — dark-glass card with chrome-gradient number + red drop-glow.
    // Dark background reads against any footage; saturate(140) keeps
    // the backdrop blur feeling like glass rather than a flat panel.
    'stat-callout-v1': {
      container: {
        background: 'linear-gradient(180deg, rgba(10,10,12,0.78) 0%, rgba(10,10,12,0.65) 100%)',
        backdrop_blur_px: 20,
        border: '1px solid rgba(255,255,255,0.16)',
        border_radius_px: 14,
        padding: '22px 28px',
        min_width_px: 220,
        text_align: 'center',
        box_shadow: '0 16px 48px rgba(0,0,0,0.55), 0 0 30px rgba(227,21,30,0.18), 0 1px 0 rgba(255,255,255,0.10) inset',
      },
      label:  { font: 'JetBrains Mono', weight: 700, size_px: 10, color: '{accent}', letter_spacing: '0.2em', uppercase: true, margin_bottom_px: 6 },
      number: { font: 'Plus Jakarta Sans', weight: 900, size_px: 48, treatment: 'chrome_vertical', drop_shadow: '0 0 12px rgba(227,21,30,0.4)', letter_spacing: '-0.03em', line_height: 1 },
      unit:   { size_px: 26 },
      sub:    { font: 'Plus Jakarta Sans', weight: 600, size_px: 13, color: 'var(--text-secondary)', letter_spacing: '0.05em', uppercase: true },
    },

    // .ov-emphasis — single red word with double text-shadow glow and
    // accent dash flourishes on either side.
    'word-emphasis-v1': {
      word: {
        font: 'Plus Jakarta Sans', weight: 900, size_px: 72,
        uppercase: true, letter_spacing: '-0.02em', line_height: 1,
        color: '{accent}',
        text_shadow: '0 0 30px rgba(227,21,30,0.8), 0 0 60px rgba(227,21,30,0.4)',
      },
      flourish: { enabled: true, width_px: 16, height_px: 4, color: '{accent}', glow: '0 0 12px {accent}', margin_x_px: 16, radius_px: 2 },
      text_align: 'center',
    },

    // .ov-caption — glass lower-third with red-highlighted span on the
    // emphasis word.
    'caption-overlay-v1': {
      container: {
        background: 'linear-gradient(180deg, rgba(10,10,12,0.80) 0%, rgba(10,10,12,0.68) 100%)',
        backdrop_blur_px: 20,
        border: '1px solid rgba(255,255,255,0.16)',
        border_radius_px: 14,
        padding: '24px 40px', text_align: 'center',
        box_shadow: '0 16px 48px rgba(0,0,0,0.55), 0 0 40px rgba(227,21,30,0.18), 0 1px 0 rgba(255,255,255,0.10) inset',
      },
      text:      { font: 'Plus Jakarta Sans', weight: 700, size_px: 28, color: 'var(--text-primary)', letter_spacing: '-0.015em', line_height: 1.25 },
      highlight: { color: '{accent}', text_shadow: '0 0 20px rgba(227,21,30,0.6)' },
    },

    // .ov-tool — deeper glass card with a 44x44 logo tile (dark gradient +
    // red border + red glow) next to a name/desc stack.
    'tool-logo-v1': {
      container: {
        background: 'linear-gradient(180deg, rgba(10,10,12,0.78) 0%, rgba(10,10,12,0.65) 100%)',
        backdrop_blur_px: 20,
        border: '1px solid rgba(255,255,255,0.16)',
        border_radius_px: 14,
        padding: '18px 22px', layout: 'flex_row', gap_px: 16,
        min_width_px: 220,
        box_shadow: '0 16px 48px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.10) inset',
      },
      logo: {
        size_px: 44, border_radius_px: 8,
        background: 'linear-gradient(135deg, #1a1a1f, #0a0a0c)',
        border: '1px solid {accent}',
        box_shadow: '0 0 16px rgba(227,21,30,0.3)',
        color: '{accent}', font: 'Plus Jakarta Sans', weight: 900, size_px_text: 22,
      },
      name: { font: 'Plus Jakarta Sans', weight: 800, size_px: 16, color: 'var(--text-primary)', letter_spacing: '-0.01em', line_height: 1.1, margin_bottom_px: 3 },
      desc: { font: 'JetBrains Mono', size_px: 11, color: '{accent}', letter_spacing: '0.1em', uppercase: true, line_height: 1 },
    },

    // .ov-watermark — dark glass pill with red "@" prefix.
    'watermark-v1': {
      container: {
        background: 'rgba(10,10,12,0.6)', backdrop_blur_px: 8,
        border: '1px solid var(--surface-border)', border_radius_px: 8,
        padding: '8px 14px',
      },
      handle: { font: 'JetBrains Mono', weight: 600, size_px: 12, color: 'var(--text-secondary)', letter_spacing: '0.08em' },
      prefix: { char: '@', color: '{accent}', margin_right_px: 4 },
    },

    // .ov-action — solid red CTA pill with double red shadow (no glass).
    'action-prompt-v1': {
      container: {
        background: '{accent}', color: '#ffffff',
        padding: '14px 20px', border_radius_px: 10,
        text_align: 'center', line_height: 1.3,
        box_shadow: '0 6px 24px rgba(227,21,30,0.5), 0 0 40px rgba(227,21,30,0.3)',
      },
      text:  { font: 'Plus Jakarta Sans', weight: 800, size_px: 14, uppercase: true, letter_spacing: '0.05em' },
      arrow: { weight: 900, margin_right_px: 6, translate_y_px: -1 },
    },

    // .ov-source — dark glass with left red border-strip (no top/right/
    // bottom border, radius only on the right side).
    'source-citation-v1': {
      container: {
        background: 'rgba(10,10,12,0.6)', backdrop_blur_px: 8,
        border_left: '2px solid {accent}',
        border_radius_px: '0 8px 8px 0',
        padding: '10px 14px',
      },
      label:    { font: 'JetBrains Mono', weight: 700, size_px: 9, color: '{accent}', letter_spacing: '0.2em', uppercase: true, line_height: 1, margin_bottom_px: 4 },
      citation: { font: 'Plus Jakarta Sans', weight: 600, size_px: 13, color: 'var(--text-secondary)', letter_spacing: '-0.005em', line_height: 1.25 },
    },

    // .ov-chapter — wider, glassier card. The meta+title sits in a
    // surface that reads as a clear UI element against the speaker
    // behind it. Bumped padding, min-width, deeper blur, dual shadow
    // (drop + inset highlight) so the card has real depth.
    'chapter-marker-v1': {
      container: {
        background: 'linear-gradient(180deg, rgba(10,10,12,0.78) 0%, rgba(10,10,12,0.65) 100%)',
        backdrop_blur_px: 20,
        border: '1px solid rgba(255,255,255,0.16)',
        border_radius_px: 14,
        padding: '18px 28px',
        min_width_px: 240,
        box_shadow: '0 16px 48px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.10) inset',
      },
      side_strip: { enabled: true, width_px: 4, color: '{accent}', glow: '0 0 18px {accent}', inset_top_pct: 15, inset_bottom_pct: 15, border_radius_px: '0 3px 3px 0' },
      meta:  { font: 'JetBrains Mono', weight: 700, size_px: 11, color: '{accent}', letter_spacing: '0.2em', uppercase: true, line_height: 1, margin_bottom_px: 10 },
      title: { font: 'Plus Jakarta Sans', weight: 800, size_px: 22, color: 'var(--text-primary)', letter_spacing: '-0.02em', line_height: 1.05 },
    },
  },
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
    master_volume: 0.5,
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
      { event: 'chapter_change', sfx: 'ux_click' },
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

  // Atlas uses the same overlay set as Sleek — the renderer reads
  // overlay_overrides per-template. Inherited from SLEEK's tokens but
  // with the indigo accent baked in. The renderer's {accent} resolver
  // will interpolate the user's brand color over this default.
  overlay_pool: SLEEK.overlay_pool,
  overlay_overrides: {
    ...SLEEK.overlay_overrides,
    // Re-tint chapter-marker side-strip + caption highlight in indigo
    // so cards feel native to Atlas instead of "Sleek with a different
    // background." The {accent} resolver handles the rest.
  },

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
    master_volume: 0.5,
    pack: 'default',
    overrides: {
      entrance: 'ux_swipe',
      exit: 'ux_swipe',
      transition: 'ux_zoom',
    },
    standalone_triggers: [
      { event: 'title_hero',     sfx: 'ux_ding' },
      { event: 'chapter_change', sfx: 'ux_click' },
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
