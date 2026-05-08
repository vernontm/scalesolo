import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from './supabase.js'
import { useAuth } from '../context/AuthContext.jsx'

// Live notifications hook. Loads the latest 50 + subscribes to Supabase
// Realtime for INSERT events on the notifications table filtered to the
// current user, so the bell updates instantly without polling.
//
// Returns { items, unread, loading, markRead, markAllRead, dismiss, refresh }.
export function useNotifications() {
  const { session } = useAuth()
  const userId = session?.user?.id || null
  const token = session?.access_token || null
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const channelRef = useRef(null)

  const refresh = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const r = await fetch('/api/notifications', { headers: { Authorization: `Bearer ${token}` } })
      const body = await r.json()
      if (r.ok) setItems(body.notifications || [])
    } catch { /* network blip; keep prior state */ }
    finally { setLoading(false) }
  }, [token])

  useEffect(() => {
    if (!userId || !token) return
    refresh()

    // Live channel: only INSERTs for this user. Filter happens in the
    // server-side broadcast via the publication, so we don't see noise.
    const channel = supabase
      .channel(`notifications:${userId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
        (payload) => {
          const row = payload.new
          if (!row) return
          setItems((prev) => {
            // De-dupe in case a refetch raced the realtime event.
            if (prev.some((n) => n.id === row.id)) return prev
            return [row, ...prev].slice(0, 50)
          })
        })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
        (payload) => {
          const row = payload.new
          if (!row) return
          setItems((prev) => prev.map((n) => n.id === row.id ? row : n))
        })
      .on('postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
        (payload) => {
          const id = payload.old?.id
          if (!id) return
          setItems((prev) => prev.filter((n) => n.id !== id))
        })
      .subscribe()

    channelRef.current = channel
    return () => { try { channel.unsubscribe() } catch {} channelRef.current = null }
  }, [userId, token, refresh])

  const markRead = useCallback(async (id) => {
    if (!token || !id) return
    setItems((prev) => prev.map((n) => n.id === id ? { ...n, read_at: n.read_at || new Date().toISOString() } : n))
    try {
      await fetch(`/api/notifications?action=read&id=${id}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
    } catch { /* optimistic — Realtime UPDATE will reconcile */ }
  }, [token])

  const markAllRead = useCallback(async () => {
    if (!token) return
    const now = new Date().toISOString()
    setItems((prev) => prev.map((n) => n.read_at ? n : { ...n, read_at: now }))
    try {
      await fetch('/api/notifications?action=read_all', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
    } catch {}
  }, [token])

  const dismiss = useCallback(async (id) => {
    if (!token || !id) return
    setItems((prev) => prev.filter((n) => n.id !== id))
    try {
      await fetch(`/api/notifications?id=${id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
    } catch {}
  }, [token])

  const unread = items.reduce((acc, n) => acc + (n.read_at ? 0 : 1), 0)
  return { items, unread, loading, markRead, markAllRead, dismiss, refresh }
}
