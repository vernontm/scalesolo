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
      // affiliate. The endpoint is idempotent (refuses to overwrite an
      // existing attribution) so calling on every SIGNED_IN is safe.
      try {
        if (newSession?.access_token) {
          const ref = localStorage.getItem('scalesolo.ref')
          if (ref) {
            fetch('/api/affiliate/attribute', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${newSession.access_token}` },
              body: JSON.stringify({ code: ref }),
            })
              .then((r) => r.json().catch(() => ({})))
              .then((b) => { if (b?.attributed || b?.error) localStorage.removeItem('scalesolo.ref') })
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
