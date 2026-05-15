// Renders a top-of-app banner when the session-expired event fires.
// Hidden by default — only mounts visible after auth-guard detects a
// dead JWT that refresh couldn't revive. Gives the user a one-click
// recovery instead of a console full of mysterious 401s.

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { noteExplicitSignOut } from '../lib/auth-guard.js'

export default function SessionExpiredBanner() {
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const onExpired = () => setShown(true)
    window.addEventListener('scalesolo:session-expired', onExpired)
    return () => window.removeEventListener('scalesolo:session-expired', onExpired)
  }, [])

  if (!shown) return null

  const reSignIn = async () => {
    try {
      // Mark this as an explicit-signout BEFORE Supabase emits SIGNED_OUT
      // so the guard doesn't re-show this banner on the way out.
      noteExplicitSignOut()
      await supabase.auth.signOut()
    } catch {}
    // Nuke any lingering client state so the next login is clean.
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('sb-') || k.startsWith('supabase.'))
        .forEach((k) => localStorage.removeItem(k))
    } catch {}
    // Hard reload to /login keeps everything tidy — no half-mounted
    // components holding stale session refs.
    window.location.href = '/login?reason=session_expired'
  }

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0,
        zIndex: 9999,
        background: 'linear-gradient(90deg, rgba(239,68,68,0.95), rgba(220,38,38,0.95))',
        color: '#fff',
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        fontFamily: 'var(--font-display, system-ui)',
        fontSize: 13,
        fontWeight: 600,
        boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
      }}
    >
      <span aria-hidden style={{ fontSize: 14 }}>⚠</span>
      <span>Your session expired. Sign back in to continue.</span>
      <button
        onClick={reSignIn}
        style={{
          background: '#fff',
          color: 'rgb(220,38,38)',
          border: 'none',
          padding: '6px 14px',
          borderRadius: 6,
          fontWeight: 700,
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 12.5,
        }}
      >Sign in again</button>
    </div>
  )
}
