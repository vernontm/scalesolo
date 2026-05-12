import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useAuth } from './AuthContext.jsx'

const CreditsContext = createContext(null)

const EMPTY_POOLS = {
  ai_tokens:     { balance: 0, monthly_grant: 0, last_reset_at: null },
  video_units:   { balance: 0, monthly_grant: 0, last_reset_at: null },
  voice_minutes: { balance: 0, monthly_grant: 0, last_reset_at: null },
}

export function CreditsProvider({ children }) {
  const { session } = useAuth()
  const [pools, setPools] = useState(EMPTY_POOLS)
  const [topupCatalog, setTopupCatalog] = useState({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    if (!session) {
      setPools(EMPTY_POOLS)
      setTopupCatalog({})
      return
    }
    setLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/credits', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Failed to load credits')
      setPools(body.pools || EMPTY_POOLS)
      setTopupCatalog(body.topup_catalog || {})
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [session])

  useEffect(() => { refresh() }, [refresh])

  // Refresh after Stripe top-up redirect (?topup=success)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (url.searchParams.get('topup') === 'success') {
      // Webhook may take a moment; poll a few times.
      let attempts = 0
      const tick = () => {
        attempts++
        refresh()
        if (attempts < 4) setTimeout(tick, 1500)
      }
      tick()
      url.searchParams.delete('topup')
      window.history.replaceState({}, '', url.toString())
    }
  }, [refresh])

  // Refresh aggressively after first-signup redirect (?welcome=1). The
  // subscription.created webhook may race the dashboard load: the user
  // can land here before Stripe has even called our endpoint, never
  // mind before the credit-grant RPC finished. Poll for ~24 seconds at
  // 2-second intervals until the pools come back non-empty.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (url.searchParams.get('welcome') !== '1') return
    if (!session) return
    let attempts = 0
    let stopped = false
    const tick = async () => {
      if (stopped) return
      attempts++
      await refresh()
      if (attempts < 12) setTimeout(tick, 2000)
    }
    tick()
    // Strip the param so a manual refresh doesn't re-run the loop.
    url.searchParams.delete('welcome')
    window.history.replaceState({}, '', url.toString())
    return () => { stopped = true }
  }, [refresh, session])

  // Realtime: subscribe to credit_pools changes for this user's customer
  // so any deduction (avatar render, polish, top-up grant) reflects in
  // the UI without a page refresh. RLS on credit_pools already filters
  // server-side, so the subscription only delivers rows the user can
  // legitimately see. We bounce through a refresh() rather than splicing
  // the payload because the realtime row only contains the changed
  // pool — refresh keeps the whole pools object consistent and picks
  // up new pools (e.g. voice_minutes) added later.
  useEffect(() => {
    if (!session) return
    let channel
    try {
      channel = supabase
        .channel(`credit-pools:${session.user.id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'credit_pools' },
          () => { refresh() },
        )
        .subscribe()
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[credits] realtime subscribe failed', e)
    }
    return () => {
      if (channel) {
        try { supabase.removeChannel(channel) } catch {}
      }
    }
  }, [session, refresh])

  // Memoize so the topup-success poll (which calls refresh 4×) doesn't
  // recreate the context value object 4× and re-render every consumer.
  const value = useMemo(
    () => ({ pools, topupCatalog, loading, error, refresh }),
    [pools, topupCatalog, loading, error, refresh],
  )
  return <CreditsContext.Provider value={value}>{children}</CreditsContext.Provider>
}

export function useCredits() {
  const ctx = useContext(CreditsContext)
  if (!ctx) throw new Error('useCredits must be used inside a CreditsProvider')
  return ctx
}

// Format helpers
export function fmtCount(n) {
  n = Number(n) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`
  return n.toLocaleString()
}

export const POOL_META = {
  ai_tokens:     { label: 'AI tokens',   short: 'tokens',  color: '#ef4444' },
  video_units:   { label: 'Video units', short: 'video',   color: '#f59e0b' },
  voice_minutes: { label: 'Voice min',   short: 'voice',   color: '#a78bfa' },
}
