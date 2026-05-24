// Wraps the /studio route. Hits /api/studio/check on mount, decides
// whether to render Studio or a generic NotFound. Keeps Studio
// invisible to non-allowlisted users — they see the same screen they
// would see for a typo'd URL.
//
// The check call is cached in module scope for the session: once we
// know a user is in / out, we don't re-probe. Logging out clears it
// via the explicit reset() export consumed by AuthContext on sign-out.

import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'

let cachedAllowed = null   // null = unknown, true/false = resolved

export function resetStudioGateCache() { cachedAllowed = null }

export default function StudioGate({ children, fallback }) {
  const { session } = useAuth()
  const [allowed, setAllowed] = useState(cachedAllowed)

  useEffect(() => {
    if (cachedAllowed !== null) return
    if (!session?.access_token) { setAllowed(false); return }
    let cancelled = false
    fetch('/api/studio/check', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.ok ? r.json() : { allowed: false })
      .then((body) => {
        if (cancelled) return
        cachedAllowed = !!body.allowed
        setAllowed(cachedAllowed)
      })
      .catch(() => {
        if (cancelled) return
        cachedAllowed = false
        setAllowed(false)
      })
    return () => { cancelled = true }
  }, [session?.access_token])

  if (allowed === null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 80, color: 'var(--muted)' }}>
        <span className="spinner" />
      </div>
    )
  }
  if (allowed === false) return fallback
  return children
}
