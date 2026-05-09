import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { identifySentryUser } from '../lib/sentry.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)

  // Resolve is_admin in two passes:
  //   1. Read from session.user.app_metadata.is_admin — the DB trigger
  //      keeps it in sync with user_profiles.is_admin and Supabase puts
  //      it on the JWT, so this is free.
  //   2. Fall back to a user_profiles SELECT for older sessions issued
  //      before the trigger landed.
  async function refreshAdminFlag(session) {
    const userId = session?.user?.id
    if (!userId) { setIsAdmin(false); return }
    const claim = session?.user?.app_metadata?.is_admin
    if (claim === true)  { setIsAdmin(true); return }
    if (claim === false) { setIsAdmin(false); return }
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('is_admin')
        .eq('id', userId)
        .maybeSingle()
      if (error) { setIsAdmin(false); return }
      setIsAdmin(!!data?.is_admin)
    } catch { setIsAdmin(false) }
  }

  useEffect(() => {
    let active = true

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setSession(data.session)
      identifySentryUser(data.session?.user || null)
      setLoading(false)
      refreshAdminFlag(data.session)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      identifySentryUser(newSession?.user || null)
      setLoading(false)
      refreshAdminFlag(newSession)
      // Affiliate attribution: if the visitor arrived via ?ref=… on the
      // landing page, attribute the freshly-signed-in user to that
      // affiliate. Read from localStorage first; fall back to the
      // scalesolo_ref cookie (which Landing.jsx mirrors so the attribution
      // survives a localStorage wipe — private mode, "clear site data",
      // etc.). Endpoint is idempotent.
      try {
        if (newSession?.access_token) {
          let ref = null
          try { ref = localStorage.getItem('scalesolo.ref') } catch {}
          if (!ref) {
            const m = document.cookie.match(/(?:^|;\s*)scalesolo_ref=([^;]+)/)
            if (m) ref = decodeURIComponent(m[1])
          }
          if (ref) {
            fetch('/api/affiliate/attribute', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${newSession.access_token}` },
              body: JSON.stringify({ code: ref }),
            })
              .then((r) => r.json().catch(() => ({})))
              .then((b) => {
                if (b?.attributed || b?.error) {
                  try { localStorage.removeItem('scalesolo.ref') } catch {}
                  document.cookie = 'scalesolo_ref=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
                }
              })
              .catch(() => {})
          }
        }
      } catch {}
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  const signIn = (email, password) =>
    supabase.auth.signInWithPassword({ email, password })

  const signInWithGoogle = () =>
    supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })

  const signUp = (email, password, meta) =>
    supabase.auth.signUp({
      email,
      password,
      options: {
        data: meta || {},
        // Pin the post-confirmation redirect to this exact origin so the
        // confirm-email link always lands somewhere this SPA can handle.
        // Whatever origin must also be whitelisted in Supabase → Auth →
        // URL Configuration → Redirect URLs.
        emailRedirectTo: typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : undefined,
      },
    })

  const signOut = () => supabase.auth.signOut()

  // Memoize the context value so consumers only re-render when one of
  // these specific fields actually changes. The signIn / signUp /
  // signOut closures are recreated on every render but they're stable
  // shape and only invoked on user action — capturing them once via
  // useMemo prevents a referential identity shuffle from invalidating
  // every consumer of useAuth() on unrelated state changes.
  const value = useMemo(() => ({
    session,
    user: session?.user ?? null,
    loading,
    isAdmin,
    signIn,
    signInWithGoogle,
    signUp,
    signOut,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [session, loading, isAdmin])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider')
  return ctx
}
