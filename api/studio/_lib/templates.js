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
    secondary_accent: null,
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
  motion: {
    entrance_style: 'slide_up_fade',
    exit_style: 'fade',
    emphasis: 'subtle',
    speed: 'smooth',
  },
  default_transition: 'fade',
  // v1 full-screen composition pool. Expanded from the original 7 to 10
  // per the new architecture brief. Three are new and don't have HTML
  // files yet (hook-card-v1, caption-card-v1, subscribe-cta-v1) — the
  // renderer should fall back to the drawtext stub for them until the
  // compositions ship. Three more (process-timeline-v1, chapter-card-v1,
  // diagram-card-v1) are v2 and intentionally NOT in this pool.
  composition_pool: [
    'hook-card-v1',          // NEW — punchy opener, full-screen
    'title-card-v1',
    'caption-card-v1',       // NEW — full-screen variant of the caption overlay
    'stat-reveal-v1',
    'list-overlay-v1',
    'quote-card-v1',
    'lower-third-v1',
    'comparison-v1',
    'subscribe-cta-v1',      // NEW — engagement card before end
    'end-card-v1',
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
  // Per-overlay style tweaks for Sleek. Values match the existing
  // composition styling: chrome + red accent, glass-morphism cards,
  // red glow on accent characters.
  //
  // When the showcase HTML at /outputs/sleek-overlays.html lands,
  // tighten these to match its exact tokens. Reasonable defaults now
  // so the data layer can ship + the renderer has something to read.
  overlay_overrides: {
    'stat-callout-v1': {
      background_style: 'glass_morphism',
      number_treatment: 'chrome_with_glow',
      accent_color: '{accent}',
      border_treatment: 'subtle_red',
    },
    'word-emphasis-v1': {
      highlight_color: '{accent}',
      background_style: 'glass_morphism',
      animation: 'pop_in',
    },
    'caption-overlay-v1': {
      highlight_color: '{accent}',
      background_style: 'glass_morphism',
      animation: 'word_by_word',
      font_scale: 'large',
    },
    'tool-logo-v1': {
      background_style: 'glass_morphism',
      border_treatment: 'subtle_red',
      label_position: 'below',
    },
    'watermark-v1': {
      logo_variant: 'mark_only',
      opacity: 0.8,
    },
    'action-prompt-v1': {
      background_style: 'solid',
      accent_color: '{accent}',
      pulse: true,
    },
    'source-citation-v1': {
      background_style: 'hairline',
      text_color: 'rgba(255,255,255,0.55)',
    },
    'chapter-marker-v1': {
      background_style: 'glass_morphism',
      number_treatment: 'mono_caps',
      accent_color: '{accent}',
    },
  },
  audio: {
    sfx_pool: ['swoosh', 'subtle_chime', 'impact'],
    sfx_density: 'medium',
    music_mood: 'futuristic_calm',
    music_volume: 0.12,
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
    },
  },
}

// Add more templates here as Ray finishes spec'ing them.
export const TEMPLATES = [SLEEK]
export const TEMPLATE_BY_ID = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]))

export function getTemplate(id) {
  return TEMPLATE_BY_ID[id] || SLEEK
}

// Resolve "{accent}" placeholders against the brand color the user chose.
// Returns a cloned template with strings interpolated. Used by both the
// segmentation prompt and (eventually) the renderer when it picks CSS
// variables for the iframe.
export function resolveTemplate(id, brandColor) {
  const tmpl = getTemplate(id)
  const accent = brandColor || tmpl.colors.primary_accent
  const replace = (v) => typeof v === 'string' ? v.replace(/\{accent\}/g, accent) : v
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
  // Force the resolved accent into colors.primary_accent too so anything
  // downstream that reads that field gets the user's color, not the
  // template's default.
  resolved.colors.primary_accent = accent
  return resolved
}
