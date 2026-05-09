import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)

  // Pull is_admin from public.user_profiles. RLS lets the user read only
  // their own row, so this is safe with the anon key. Falls back to false
  // on any error (missing row, network blip, RLS denial).
  async function refreshAdminFlag(userId) {
    if (!userId) { setIsAdmin(false); return }
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
      setLoading(false)
      refreshAdminFlag(data.session?.user?.id)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      setLoading(false)
      refreshAdminFlag(newSession?.user?.id)
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

  const value = {
    session,
    user: session?.user ?? null,
    loading,
    isAdmin,
    signIn,
    signInWithGoogle,
    signUp,
    signOut,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider')
  return ctx
}
