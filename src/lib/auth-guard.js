// Centralized session-expiry handling.
//
// The problem we're solving: Supabase rotates JWTs roughly every hour, and
// the refresh token has a longer life. When the refresh token also can't
// reissue (signing key rotated server-side, refresh token revoked, etc.),
// every API call from the SPA returns 401 forever — but the UI keeps
// running with a dead session and the user has no idea why everything
// suddenly stopped working.
//
// This module fixes that with three layers of defense:
//
//   1. Global fetch interceptor — every /api/* call that comes back 401
//      triggers a one-shot session refresh + retry. If the refresh works,
//      the user never sees the failure. If the refresh fails, we surface
//      a clear modal and walk them through a clean sign-in.
//
//   2. Auth state listener — Supabase emits TOKEN_REFRESHED on success
//      and SIGNED_OUT when the refresh chain dies. We treat unsolicited
//      SIGNED_OUT (one that fires without the user clicking sign-out) as
//      a session-expiry signal too.
//
//   3. SessionExpiredBanner — the actual UI element rendered at the top
//      of the app. Tells the user "your session expired, click to sign
//      back in" instead of letting them puzzle over silent 401 toasts.

import { supabase } from './supabase.js'

let installed = false
let inFlightRefresh = null
let activeUserId = null
let suppressBannerForExplicitSignOut = false

// Track that the user manually clicked Sign Out — we don't want to show
// the "session expired" banner in that case, just let them out cleanly.
// AuthContext's signOut() calls this before invoking supabase.auth.signOut().
export function noteExplicitSignOut() {
  suppressBannerForExplicitSignOut = true
}

// Try to refresh the Supabase session. Coalesces concurrent calls so a
// burst of 401s only fires ONE refresh request, not N. Returns the new
// access token on success, null on failure.
async function tryRefresh() {
  if (inFlightRefresh) return inFlightRefresh
  inFlightRefresh = (async () => {
    try {
      const { data, error } = await supabase.auth.refreshSession()
      if (error) {
        console.warn('[auth-guard] refresh failed:', error?.message)
        return null
      }
      const token = data?.session?.access_token || null
      return token
    } catch (e) {
      console.warn('[auth-guard] refresh threw:', e?.message)
      return null
    } finally {
      // Reset the coalescer after a short tick so legitimately separate
      // 401 bursts (e.g. after several minutes) each get their own
      // refresh attempt instead of being told "no" forever.
      setTimeout(() => { inFlightRefresh = null }, 500)
    }
  })()
  return inFlightRefresh
}

function isApiCall(input) {
  try {
    const url = typeof input === 'string' ? input : (input?.url || '')
    return url.includes('/api/') || url.startsWith('/api')
  } catch {
    return false
  }
}

function fireSessionExpired() {
  if (suppressBannerForExplicitSignOut) return
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('scalesolo:session-expired'))
}

// Install the global fetch interceptor. Idempotent — calling twice is a
// no-op. Should be called exactly once during app boot.
export function installAuthGuard() {
  if (installed) return
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return
  installed = true

  const realFetch = window.fetch.bind(window)

  window.fetch = async function guardedFetch(input, init) {
    // Pass non-/api/ calls through unchanged.
    if (!isApiCall(input)) return realFetch(input, init)

    const resp = await realFetch(input, init)
    if (resp.status !== 401) return resp

    // 401 on an /api/ call. Try ONE refresh + retry. If that fails,
    // surface the expiry banner.
    const newToken = await tryRefresh()
    if (!newToken) {
      fireSessionExpired()
      return resp
    }

    // Build retry init with the new Authorization header. Preserves all
    // the caller's other headers + body. If the caller didn't set an
    // Authorization header in the first place, we still add the new
    // token — most app fetches do, and the few that don't won't be
    // hurt by the extra header.
    const retryHeaders = new Headers(init?.headers || {})
    retryHeaders.set('Authorization', `Bearer ${newToken}`)
    const retryInit = { ...(init || {}), headers: retryHeaders }
    const retried = await realFetch(input, retryInit)
    if (retried.status === 401) {
      // Even with a fresh token, server rejected — refresh must have
      // returned a JWT the server still doesn't accept (signing key
      // rotated, user disabled, etc.). Show the banner.
      fireSessionExpired()
    }
    return retried
  }

  // Listen for Supabase's own auth state transitions. SIGNED_OUT events
  // that we didn't initiate are session-death signals.
  supabase.auth.onAuthStateChange((event, newSession) => {
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      activeUserId = newSession?.user?.id || null
      suppressBannerForExplicitSignOut = false
      return
    }
    if (event === 'SIGNED_OUT') {
      // If this was triggered by the user clicking Sign Out, don't
      // alarm them with a banner. Otherwise treat it as expiry.
      if (activeUserId && !suppressBannerForExplicitSignOut) {
        fireSessionExpired()
      }
      activeUserId = null
      // Reset the explicit-signout latch for next time.
      suppressBannerForExplicitSignOut = false
    }
  })

  // Initial state — capture the current user id so we can detect
  // unsolicited sign-outs vs initial-not-signed-in.
  supabase.auth.getSession().then(({ data }) => {
    activeUserId = data?.session?.user?.id || null
  }).catch(() => {})
}
