// Studio beta gate. Anything under /api/studio/* MUST call this with
// the authed user id before doing anything else. Returns silently when
// the user is on the allowlist; throws a 404-shaped error otherwise so
// the feature appears not to exist to anyone outside the beta.
//
// Allowlist source: STUDIO_BETA_USER_IDS env var, comma-separated.
// Empty / unset means nobody has access (including in prod) — open this
// up by adding user ids to the env var on Vercel.
//
// Why 404 instead of 403: a 403 confirms the route exists. We want
// Studio to be invisible to non-allowlisted users, so the API returns
// the same shape it would return for a typo'd URL.

function allowedSet() {
  const raw = process.env.STUDIO_BETA_USER_IDS || ''
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
}

export function isStudioBetaUser(userId) {
  if (!userId) return false
  return allowedSet().has(userId)
}

export function gateStudio(userId) {
  if (isStudioBetaUser(userId)) return
  const err = new Error('Not found')
  err.status = 404
  throw err
}
