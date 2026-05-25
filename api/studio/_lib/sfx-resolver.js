// Pure-function resolver for a template's SFX block.
//
// Reads:
//   - template.motion         (resolved 4-primitive block from
//                              motion-resolver.js)
//   - template.sfx            (template's SFX config — density,
//                              master_volume, pack, overrides,
//                              standalone_triggers)
//
// Returns:
//   {
//     entrance:   { sfx_id, file, volume } | null,
//     exit:       { sfx_id, file, volume } | null,
//     emphasis:   { sfx_id, file, volume } | null,
//     transition: { sfx_id, file, volume } | null,
//     standalone_triggers: [{ event, sfx_id, file, volume }],
//     master_volume: 0..1,
//     density: 'off' | 'low' | 'medium' | 'high',
//     warnings: string[]
//   }
//
// `null` for a slot means silent (either density gated it out, or the
// pairing was already silent by default, or the template explicitly
// silenced it). The renderer can read each slot and decide whether to
// schedule playback.
//
// Never throws on bad input — degrades gracefully and accumulates
// warnings for the caller. Templates ship by hand, so a bad ID should
// surface as a log line in the render, not a 500.

import { SFX_BANK, STANDALONE_EVENTS, isValidSfxId } from './sfx-bank.js'
import { DEFAULT_PAIRINGS, DENSITY_LAYERS, DENSITY_VALUES, defaultPairing } from './sfx-pairings.js'

const SLOTS = ['entrance', 'exit', 'emphasis', 'transition']
const DEFAULTS = Object.freeze({
  density: 'medium',
  master_volume: 0.5,
  pack: 'default',
})

function clampVolume(v, fallback = 0.5) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

// Build a resolved slot entry. Returns null when sfx_id is null
// (silent) or when the SFX_BANK lookup fails.
function resolveSlot(sfx_id, master_volume, warnings) {
  if (!sfx_id) return null
  if (!isValidSfxId(sfx_id)) {
    warnings.push(`sfx: unknown sfx_id "${sfx_id}" — silencing this slot.`)
    return null
  }
  const entry = SFX_BANK[sfx_id]
  return {
    sfx_id,
    file: entry.file,
    duration_ms: entry.duration_ms,
    loopable: !!entry.loopable,
    // Final per-playback volume = bank default * template master.
    volume: clampVolume(entry.default_volume * master_volume, 0.5),
  }
}

/**
 * resolveSfx — turn a template + its resolved motion block into a
 * playable SFX plan.
 *
 * @param {object} args
 * @param {object} args.motion   — { entrance, exit, emphasis, transition }
 *                                 where each value is either a primitive id
 *                                 (string) or a resolved object { id, spec }
 *                                 produced by motion-resolver.
 * @param {object} [args.sfx]    — template.sfx block (optional). When
 *                                 omitted, the resolver uses defaults
 *                                 across the board.
 * @returns {object} resolved plan (see top-of-file comment)
 */
export function resolveSfx({ motion = {}, sfx = null } = {}) {
  const warnings = []
  const block = sfx && typeof sfx === 'object' ? sfx : {}

  // Density gate
  let density = block.density || DEFAULTS.density
  if (!DENSITY_VALUES.includes(density)) {
    warnings.push(`sfx: invalid density "${density}" — falling back to "${DEFAULTS.density}".`)
    density = DEFAULTS.density
  }
  const activeLayers = DENSITY_LAYERS[density]

  // Master volume
  const master_volume = clampVolume(block.master_volume, DEFAULTS.master_volume)

  // Pack — not yet wired (single "default" pack ships), but plumb it
  // through so the renderer can switch banks later without touching
  // the resolver.
  const pack = typeof block.pack === 'string' ? block.pack : DEFAULTS.pack

  // Per-slot resolution. The slot's primitive id can arrive as either
  // a raw string ("slide_up_fade") or a resolved object from the
  // motion resolver ({ id, spec, default_used }). Normalize.
  const overrides = block.overrides && typeof block.overrides === 'object' ? block.overrides : {}
  const resolved = {}
  for (const slot of SLOTS) {
    if (!activeLayers.has(slot)) { resolved[slot] = null; continue }

    const motionSlot = motion[slot]
    const primitiveId = motionSlot && typeof motionSlot === 'object'
      ? motionSlot.id
      : (typeof motionSlot === 'string' ? motionSlot : null)

    // Pick effective sfx_id: explicit override beats motion default.
    let sfxId
    if (Object.prototype.hasOwnProperty.call(overrides, slot)) {
      sfxId = overrides[slot]  // can be null = explicit silence
    } else if (primitiveId) {
      sfxId = defaultPairing(slot, primitiveId)
    } else {
      sfxId = null
    }

    resolved[slot] = resolveSlot(sfxId, master_volume, warnings)
  }

  // Standalone triggers — content events the composition fires (e.g.
  // "stat_land" right when a stat-reveal-v1's number hits its final
  // frame). Validate event names against the known vocabulary and
  // drop any unknown ones; the renderer can't act on names it doesn't
  // know about.
  const rawTriggers = Array.isArray(block.standalone_triggers) ? block.standalone_triggers : []
  const standalone_triggers = []
  for (const t of rawTriggers) {
    if (!t || typeof t !== 'object') continue
    if (!STANDALONE_EVENTS.has(t.event)) {
      warnings.push(`sfx: unknown standalone event "${t.event}" — skipping.`)
      continue
    }
    const slot = resolveSlot(t.sfx, master_volume, warnings)
    if (!slot) continue
    standalone_triggers.push({ event: t.event, ...slot })
  }

  return {
    density,
    master_volume,
    pack,
    entrance:   resolved.entrance,
    exit:       resolved.exit,
    emphasis:   resolved.emphasis,
    transition: resolved.transition,
    standalone_triggers,
    warnings,
  }
}
