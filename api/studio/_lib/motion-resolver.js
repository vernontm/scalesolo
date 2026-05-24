// Pure-function resolver for a template's motion block.
//
// Input: a template (or just its `motion` sub-object).
// Output: a 4-slot resolved block where every slot holds a known primitive
//         id AND the underlying spec, plus a list of any warnings produced
//         along the way (unknown ids, wrong-category assignments, missing
//         slots). Never throws — invalid configs degrade gracefully to the
//         defaults (cut / cut_out / none / cut_transition).
//
// The strict variant — resolveMotionStrict — does throw on validation
// errors. Use it in CI / tests / template-editor save paths where a
// malformed config should surface loudly rather than silently degrade.

import {
  ALL_SLOTS,
  MOTION_DEFAULTS,
  SLOT_TO_REGISTRY,
  SLOT_TO_SET,
  getPrimitive,
  isValidPrimitive,
} from './motion-primitives.js'

export class MotionValidationError extends Error {
  constructor(message, ctx = {}) {
    super(message)
    this.name = 'MotionValidationError'
    this.ctx = ctx
  }
}

/**
 * Resolve a template's motion block to a fully-populated 4-slot config.
 *
 * @param {object} motion — template.motion (or the template itself; we
 *                          look for a `.motion` key if so).
 * @returns {{ resolved: object, warnings: string[] }}
 */
export function resolveMotion(motion) {
  const block = motion && motion.motion ? motion.motion : (motion || {})
  const warnings = []
  const resolved = {}

  for (const slot of ALL_SLOTS) {
    const requested = block[slot]
    if (!requested) {
      // Missing slot — fall back silently. The defaults are the
      // documented behavior, not an error.
      const fallback = MOTION_DEFAULTS[slot]
      resolved[slot] = {
        id: fallback,
        spec: getPrimitive(slot, fallback),
        default_used: true,
      }
      continue
    }
    if (!isValidPrimitive(slot, requested)) {
      // Could be: (a) totally unknown id, or (b) id valid for a different
      // category. Either way we fall back, but the warning tells the
      // editor which problem to fix.
      const validOptions = Object.keys(SLOT_TO_REGISTRY[slot])
      warnings.push(
        `motion.${slot}: "${requested}" is not a valid ${slot} primitive. ` +
        `Falling back to "${MOTION_DEFAULTS[slot]}". Valid options: ${validOptions.join(', ')}.`,
      )
      const fallback = MOTION_DEFAULTS[slot]
      resolved[slot] = {
        id: fallback,
        spec: getPrimitive(slot, fallback),
        default_used: true,
        invalid_input: requested,
      }
      continue
    }
    resolved[slot] = {
      id: requested,
      spec: getPrimitive(slot, requested),
      default_used: false,
    }
  }

  return { resolved, warnings }
}

/**
 * Strict variant — throws on the first validation problem instead of
 * degrading. Use during template authoring / CI.
 *
 * @throws MotionValidationError
 */
export function resolveMotionStrict(motion) {
  const block = motion && motion.motion ? motion.motion : (motion || {})
  const resolved = {}

  for (const slot of ALL_SLOTS) {
    const requested = block[slot]
    if (!requested) {
      throw new MotionValidationError(
        `motion.${slot} is required (no default applied in strict mode).`,
        { slot },
      )
    }
    if (!SLOT_TO_SET[slot].has(requested)) {
      const validOptions = Object.keys(SLOT_TO_REGISTRY[slot])
      throw new MotionValidationError(
        `motion.${slot}: "${requested}" is not a valid ${slot} primitive. ` +
        `Valid options: ${validOptions.join(', ')}.`,
        { slot, requested, valid_options: validOptions },
      )
    }
    resolved[slot] = {
      id: requested,
      spec: getPrimitive(slot, requested),
      default_used: false,
    }
  }

  return { resolved, warnings: [] }
}
