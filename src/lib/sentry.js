// Sentry init for the React SPA. Loaded as the very first import in
// src/main.jsx so unhandled errors during render still get captured.
//
// Reads VITE_SENTRY_DSN from the build env. When unset (local dev,
// Vercel preview without the var), this becomes a no-op — no errors
// are sent and Sentry's instrumentation has near-zero overhead.

import * as Sentry from '@sentry/react'

let _initialized = false

export function initSentry() {
  if (_initialized) return
  const dsn = import.meta.env.VITE_SENTRY_DSN
  if (!dsn) return  // local / unset → silent no-op

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE || 'production',
    release: import.meta.env.VITE_SENTRY_RELEASE || undefined,
    // Performance + replay are nice-to-haves but expensive. Off by
    // default; flip on a per-deploy basis if we want them.
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    // Most user emails / passwords / brand bibles are PII. Default off.
    sendDefaultPii: false,
    // Sentry's beforeSend gets every event — we strip auth headers + any
    // ?ref= ?tier= query params from breadcrumbs / requests so they
    // don't ship to a third-party.
    beforeBreadcrumb(crumb) {
      if (crumb?.data?.url) {
        try {
          const u = new URL(crumb.data.url, window.location.origin)
          for (const k of ['ref', 'tier', 'access_token', 'refresh_token']) u.searchParams.delete(k)
          crumb.data.url = u.toString()
        } catch {}
      }
      return crumb
    },
    ignoreErrors: [
      // Browser noise that's never actionable.
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications.',
      'Non-Error promise rejection captured',
    ],
  })
  _initialized = true
}

// Use as <SentryErrorBoundary fallback={...}> at the root tree.
export const SentryErrorBoundary = Sentry.ErrorBoundary

// Lets the SPA tag the current user once we know who they are.
// Falls through silently when Sentry isn't initialized.
export function identifySentryUser(user) {
  if (!_initialized) return
  if (!user) {
    Sentry.setUser(null)
    return
  }
  Sentry.setUser({ id: user.id })  // never email/name — we set sendDefaultPii:false
}

export { Sentry }
