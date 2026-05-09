// useAbortableFetch — unified pattern for "fetch on mount / on deps change,
// abort the previous request before starting a new one, no setState
// after unmount." Replaces the ad-hoc `let alive = true` flags scattered
// across pages.
//
// Usage:
//   const { data, loading, error, refetch } = useAbortableFetch(
//     async (signal) => {
//       const r = await fetch('/api/foo', { signal, headers: { Authorization: `Bearer ${token}` } })
//       if (!r.ok) throw new Error(`Failed (${r.status})`)
//       return r.json()
//     },
//     [token, profileId],          // deps array — refetches when these change
//     { skip: !token }              // optional: skip the fetch when truthy
//   )
//
// The fetcher receives an AbortSignal; pass it through to fetch() so
// the underlying request really gets cancelled (otherwise we just stop
// reading the response, which is wasteful but not incorrect).

import { useCallback, useEffect, useRef, useState } from 'react'

export function useAbortableFetch(fetcher, deps = [], opts = {}) {
  const { skip = false } = opts
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(!skip)
  const [error, setError] = useState(null)
  const acRef = useRef(null)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const refetch = useCallback(async () => {
    if (acRef.current) {
      try { acRef.current.abort() } catch {}
    }
    const ac = new AbortController()
    acRef.current = ac
    setLoading(true); setError(null)
    try {
      const result = await fetcherRef.current(ac.signal)
      if (ac.signal.aborted) return
      setData(result)
    } catch (e) {
      if (e?.name === 'AbortError' || ac.signal.aborted) return
      setError(e)
    } finally {
      if (acRef.current === ac) {
        setLoading(false)
        acRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (skip) {
      setLoading(false)
      return
    }
    refetch()
    return () => {
      if (acRef.current) {
        try { acRef.current.abort() } catch {}
        acRef.current = null
      }
    }
    // Caller-controlled deps. ESLint can't statically prove they're
    // stable, but this is the explicit contract of the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip, ...deps])

  return { data, loading, error, refetch, setData }
}
