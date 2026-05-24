// Pure-function zone resolver for the overlay system.
//
// Single entry point: resolveZone(args). Validates the placement
// against the rules in Ray's brief and either returns the resolved
// zone or throws ZoneResolutionError with a clear message.
//
// The 6 rules enforced (mirror the brief verbatim):
//   1. overlay_id exists in overlay_definitions
//   2. overlay_id is in the current template's overlay_pool
//   3. requested_zone is in the overlay's allowed_zones
//   4. requested_zone is valid for the current orientation
//      (top-strip rejects in landscape)
//   5. requested_zone isn't already occupied by a non-persistent
//      overlay (unless it's a corner — those run in parallel)
//   6. center column is never targeted
//
// Failures throw with a `code` field so callers can branch on the
// specific violation:
//   - UNKNOWN_OVERLAY
//   - OVERLAY_NOT_IN_POOL
//   - ZONE_NOT_ALLOWED
//   - ZONE_WRONG_ORIENTATION
//   - ZONE_OCCUPIED
//   - CENTER_COLUMN_BANNED
//   - INVALID_ZONE
//
// Don't silently fall back to a different zone — let the caller decide
// how to handle a violation (usually: surface as a validation error
// on the segment row so the user sees what's wrong).

import {
  getOverlay,
  isValidZoneForOrientation,
  PERSISTENT_ZONES,
  ALL_ZONES,
} from './overlay-definitions.js'

export class ZoneResolutionError extends Error {
  constructor(code, message, ctx = {}) {
    super(message)
    this.name = 'ZoneResolutionError'
    this.code = code
    this.ctx = ctx
  }
}

// Zones that ARE the center column. These are explicitly disallowed —
// the avatar always lives there. Defined as a set even though we don't
// expose any zone names that map to center, so rule 6 fires on any
// future code that tries to sneak one in.
const BANNED_ZONES = new Set([
  'center', 'center-col', 'avatar', 'avatar-zone', 'middle-col',
])

/**
 * resolveZone — pick a final zone for an overlay placement.
 *
 * @param {object} args
 * @param {string} args.overlay_id        — registry key from overlay-definitions.js
 * @param {string} [args.requested_zone]  — caller's preferred zone. Falls back to the
 *                                          overlay's default_zone when omitted.
 * @param {'landscape'|'vertical'} args.orientation
 * @param {string[]} [args.template_overlay_pool] — current template's overlay_pool array
 * @param {string[]} [args.currently_occupied_zones] — zone names already taken by other
 *                                          overlays in this composition. Persistent
 *                                          corner overlays don't count as occupying.
 * @returns {{ zone: string, default_used: boolean }}
 * @throws ZoneResolutionError
 */
export function resolveZone({
  overlay_id,
  requested_zone,
  orientation,
  template_overlay_pool = null,
  currently_occupied_zones = [],
}) {
  // Rule 1 — overlay exists
  const overlay = getOverlay(overlay_id)
  if (!overlay) {
    throw new ZoneResolutionError(
      'UNKNOWN_OVERLAY',
      `Unknown overlay id "${overlay_id}". Add it to overlay-definitions.js or use one of: ${Object.keys(getOverlay)}`,
      { overlay_id },
    )
  }

  // Rule 2 — overlay is in this template's pool
  if (template_overlay_pool && !template_overlay_pool.includes(overlay_id)) {
    throw new ZoneResolutionError(
      'OVERLAY_NOT_IN_POOL',
      `Overlay "${overlay_id}" is not in the current template's overlay_pool. Enable it on the template or pick a different overlay.`,
      { overlay_id, template_overlay_pool },
    )
  }

  // Pick the requested zone or fall back to the overlay's default.
  let zone = requested_zone || overlay.default_zone
  const default_used = !requested_zone

  // Sanity: zone is a known zone name at all
  if (!ALL_ZONES.has(zone)) {
    throw new ZoneResolutionError(
      'INVALID_ZONE',
      `Zone "${zone}" is not a known zone. Valid zones: ${[...ALL_ZONES].join(', ')}.`,
      { overlay_id, zone },
    )
  }

  // Rule 6 (early) — explicit center-column bans
  if (BANNED_ZONES.has(zone)) {
    throw new ZoneResolutionError(
      'CENTER_COLUMN_BANNED',
      `Center column is reserved for the avatar — overlays cannot render there.`,
      { overlay_id, zone },
    )
  }

  // Rule 3 — zone is in this overlay's allowed_zones
  if (!overlay.allowed_zones.includes(zone)) {
    throw new ZoneResolutionError(
      'ZONE_NOT_ALLOWED',
      `Overlay "${overlay_id}" cannot render in zone "${zone}". Allowed zones: ${overlay.allowed_zones.join(', ')}.`,
      { overlay_id, zone, allowed_zones: overlay.allowed_zones },
    )
  }

  // Rule 4 — zone is valid for the current orientation
  if (!orientation) {
    throw new ZoneResolutionError(
      'INVALID_ZONE',
      'orientation is required (landscape or vertical).',
      { overlay_id, zone },
    )
  }
  if (!isValidZoneForOrientation(zone, orientation)) {
    throw new ZoneResolutionError(
      'ZONE_WRONG_ORIENTATION',
      `Zone "${zone}" is not valid for orientation "${orientation}". (e.g. top-strip is vertical-only.)`,
      { overlay_id, zone, orientation },
    )
  }

  // Rule 5 — zone isn't occupied (corners are exempt: parallel-capable)
  if (!PERSISTENT_ZONES.has(zone) && currently_occupied_zones.includes(zone)) {
    throw new ZoneResolutionError(
      'ZONE_OCCUPIED',
      `Zone "${zone}" is already occupied by another overlay. Conflicting overlays should queue, not stack.`,
      { overlay_id, zone, currently_occupied_zones },
    )
  }

  return { zone, default_used }
}

/**
 * Convenience: validate a batch of overlay placements at once. Used
 * when a composition references multiple overlays — e.g. the chat
 * editor wants to insert several overlays on the same segment.
 * Returns the resolved-zones array OR throws on the first violation
 * with the index of the failing placement included in the error ctx.
 *
 * Placements are checked in order, with each successful placement
 * adding to the running `occupied` set so later placements see
 * earlier ones as taken (except corners which are always parallel).
 */
export function resolveZones(placements, { orientation, template_overlay_pool } = {}) {
  const occupied = []
  const resolved = []
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i]
    try {
      const r = resolveZone({
        overlay_id: p.overlay_id,
        requested_zone: p.requested_zone,
        orientation,
        template_overlay_pool,
        currently_occupied_zones: occupied,
      })
      resolved.push({ ...p, resolved_zone: r.zone, default_used: r.default_used })
      // Persistent corners don't block other overlays; non-persistent
      // zones do.
      if (!PERSISTENT_ZONES.has(r.zone)) {
        occupied.push(r.zone)
      }
    } catch (err) {
      if (err instanceof ZoneResolutionError) {
        err.ctx.placement_index = i
        err.ctx.placement = p
      }
      throw err
    }
  }
  return resolved
}
