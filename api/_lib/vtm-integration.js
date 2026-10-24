// Trust + authorization for the VTM CRM integration.
//
// Two layers:
//   1. App trust: the CRM backend signs a short-lived token with the shared
//      secret VTM_INTEGRATION_SECRET. No secret, no access. The endpoints are
//      inert (503) until Ray sets the secret, so shipping this is safe.
//   2. Per-user role: the acting VTM user's role lives INSIDE the signed token
//      (set by the CRM backend from its own session, never by the browser), so
//      a read-only user cannot elevate. ScaleSolo re-checks role -> capability
//      on every call.
//
// Token format (compact, HS256-style): base64url(payloadJson).base64url(hmac).
// Claims: { aid: actorId, role, pid: profileId or "*", act: action|null, iat, exp }.

import { createHmac, timingSafeEqual } from 'node:crypto'

const MAX_SKEW_MS = 2 * 60 * 1000 // reject tokens issued more than 2 min in the future

// Role -> write actions it may perform. Reads are allowed for every valid role.
// Phase 1 ships the pure-DB writes; the live-posting writes (schedule/approve a
// post, reschedule, unschedule, delete) are PHASE2 below until the shared action
// functions exist, so the CRM cannot trigger a real publish through here yet.
export const CAPABILITIES = {
  viewer: [],
  manager: ['edit-caption', 'approve-card', 'move-card'],
  admin: ['edit-caption', 'approve-card', 'move-card', 'set-defaults', 'set-external-ref', 'create-brand', 'connect-link'],
}
export const PHASE2_ACTIONS = new Set([
  'send-to-schedule', 'generate-captions', 'approve-post',
  'reschedule-post', 'unschedule-post', 'delete-post',
])

export function isConfigured() {
  return !!process.env.VTM_INTEGRATION_SECRET
}
export function canRead(role) {
  return ['viewer', 'manager', 'admin'].includes(role)
}
export function canDo(role, action) {
  return (CAPABILITIES[role] || []).includes(action)
}

function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}
function sign(payloadB64, secret) {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url')
}

// Verify a token from the Authorization header ("Bearer <token>") or a raw
// token string. Returns the claims, or throws an Error with .status set.
export function verifyToken(headerValue) {
  const secret = process.env.VTM_INTEGRATION_SECRET
  if (!secret) { const e = new Error('Integration not configured'); e.status = 503; throw e }

  const raw = String(headerValue || '').replace(/^Bearer\s+/i, '').trim()
  const parts = raw.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    const e = new Error('Malformed integration token'); e.status = 401; throw e
  }
  const [payloadB64, sig] = parts
  const expected = sign(payloadB64, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    const e = new Error('Bad integration signature'); e.status = 401; throw e
  }

  let claims
  try { claims = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) } catch {
    const e = new Error('Bad integration payload'); e.status = 401; throw e
  }
  const now = Date.now()
  if (!claims.exp || now > Number(claims.exp)) { const e = new Error('Integration token expired'); e.status = 401; throw e }
  if (claims.iat && Number(claims.iat) - now > MAX_SKEW_MS) { const e = new Error('Integration token not yet valid'); e.status = 401; throw e }
  if (!['viewer', 'manager', 'admin'].includes(claims.role)) { const e = new Error('Unknown role'); e.status = 403; throw e }
  return claims
}

// Append-only audit write. Fails soft so a missing table (migration not applied
// yet) never blocks the action.
export async function audit(supaFetch, { actorId, role, action, profileId, targetId = null, result = 'ok', meta = null }) {
  try {
    await supaFetch('integration_audit', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        source: 'vtm_crm',
        actor_id: actorId || null,
        actor_role: role || null,
        action,
        profile_id: profileId && profileId !== '*' ? profileId : null,
        target_id: targetId,
        result,
        meta,
      },
    })
  } catch { /* best effort only */ }
}
