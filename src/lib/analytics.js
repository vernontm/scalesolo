// Client-side analytics wiring. Two things in one module so the
// AppShell has a single import to mount:
//
//   1. Google Analytics 4 (gtag.js) loader + route-change page_view
//      tracker. Gated on import.meta.env.VITE_GA_MEASUREMENT_ID so
//      builds without the env var ship with no GA at all (clean dev,
//      preview deploys, etc).
//
//   2. Signed-in user heartbeat ticker. POSTs to /api/heartbeat every
//      30s + on page focus while a session exists. Powers the admin
//      Dashboard's "Active now" + "Today" counters via
//      /api/admin/presence.

import { useEffect, useRef } from 'react'

const GA_ID = import.meta.env?.VITE_GA_MEASUREMENT_ID || ''
const HEARTBEAT_INTERVAL_MS = 30_000

// Idempotent gtag.js injection. Calling twice is a no-op so a
// hot-module reload during development doesn't load two copies.
function ensureGtagLoaded() {
  if (!GA_ID) return
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (window.__gaLoaded) return
  window.__gaLoaded = true

  // Async script tag matching Google's recommended snippet.
  const s = document.createElement('script')
  s.async = true
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`
  document.head.appendChild(s)

  // gtag stub — pushes everything into the dataLayer queue until the
  // async script lands and replaces it with the real implementation.
  window.dataLayer = window.dataLayer || []
  window.gtag = function gtag() { window.dataLayer.push(arguments) }
  window.gtag('js', new Date())
  // send_page_view: false because we drive page_views manually on
  // route changes — otherwise GA double-counts the initial nav.
  window.gtag('config', GA_ID, { send_page_view: false })
}

// Fire a page_view event when the route changes. Pulls the current
// location at call time so React Router's location object stays the
// source of truth.
export function trackPageView(path) {
  if (!GA_ID || typeof window === 'undefined' || !window.gtag) return
  window.gtag('event', 'page_view', {
    page_path: path,
    page_location: window.location.href,
    page_title: typeof document !== 'undefined' ? document.title : '',
  })
}

// Hook: mount the GA loader once and post a page_view whenever the
// pathname changes. Mount at the AppShell level so it runs for every
// route within the signed-in app.
export function useGoogleAnalytics(pathname) {
  useEffect(() => { ensureGtagLoaded() }, [])
  useEffect(() => {
    if (!pathname) return
    trackPageView(pathname)
  }, [pathname])
}

// Hook: keep posting heartbeats while the user is signed in. Skips
// when there's no session (so the public landing page doesn't hit
// the endpoint). Resets the 30s timer on visibility change so a tab
// that's been backgrounded fires a fresh ping the moment it returns
// to focus — the admin "Active now" counter should reflect "I'm
// looking at this RIGHT now" rather than "I had this tab open 4
// minutes ago and walked away".
export function useHeartbeat(session) {
  const lastPostRef = useRef(0)
  useEffect(() => {
    if (!session?.access_token) return
    const post = async () => {
      // Throttle: never fire two heartbeats in under 10s, even if
      // visibility changes rapidly.
      if (Date.now() - lastPostRef.current < 10_000) return
      lastPostRef.current = Date.now()
      try {
        await fetch('/api/heartbeat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: '{}',
          // keepalive lets the ping fly even mid-tab-close so the
          // last "still here" beat lands before the user navigates
          // away.
          keepalive: true,
        })
      } catch {
        // Silent — failed heartbeats degrade the admin counter, but
        // they're not user-facing.
      }
    }
    post()  // initial beat on session attach
    const interval = setInterval(post, HEARTBEAT_INTERVAL_MS)
    const onVis = () => { if (!document.hidden) post() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [session?.access_token])
}
