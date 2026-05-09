// Server-side Sentry. One init per Lambda cold-start; subsequent
// invocations on the same warm container reuse the SDK. No-op when
// SENTRY_DSN env var isn't set (local dev, Vercel preview without
// the secret).
//
// Usage in API endpoints:
//   import { captureApiError } from '../_lib/sentry.js'
//   try { ... } catch (e) {
//     captureApiError(e, { route: 'images/generate', userId, profileId })
//     return res.status(500).json({ error: e.message })
//   }
//
// Or, for the global "give me everything" case, wrap the handler:
//   export default withSentry(handler)

import * as Sentry from '@sentry/node'

let _initialized = false

function ensureInit() {
  if (_initialized) return
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'production',
    release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  })
  _initialized = true
}

// Call this from any handler's catch with whatever context is helpful.
// Safe to call when Sentry isn't configured — it's a cheap no-op.
export function captureApiError(err, ctx = {}) {
  ensureInit()
  if (!_initialized) {
    // Even without Sentry, log loudly so Vercel keeps a record.
    console.error('[api error]', ctx?.route || 'unknown', err?.stack || err)
    return
  }
  try {
    Sentry.withScope((scope) => {
      if (ctx?.route)     scope.setTag('route', ctx.route)
      if (ctx?.userId)    scope.setUser({ id: ctx.userId })
      if (ctx?.profileId) scope.setTag('profile_id', ctx.profileId)
      if (ctx?.extra)     scope.setExtras(ctx.extra)
      Sentry.captureException(err)
    })
  } catch (e) {
    console.error('[sentry capture failed]', e?.message)
    console.error('[api error]', ctx?.route, err?.stack || err)
  }
}

// Convenience wrapper for top-level handler exception capture. Lets us
// avoid wrapping every catch when we just want "log the throw."
export function withSentry(handler, route) {
  return async (req, res) => {
    try {
      return await handler(req, res)
    } catch (err) {
      captureApiError(err, { route })
      // Re-throw — Vercel translates it into a 500 with a clean error,
      // which is the standard non-Sentry behavior.
      throw err
    }
  }
}
