import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useAuth } from './AuthContext.jsx'
import { useProfile } from './ProfileContext.jsx'

const AgentContext = createContext(null)

export function AgentProvider({ children }) {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()

  const [conversations, setConversations] = useState([])
  const [activeId, setActiveId] = useState(null)         // null = "new conversation"
  const [messages, setMessages] = useState([])           // messages of the active conv
  const [streamingText, setStreamingText] = useState('') // partial assistant text mid-stream
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState(false)                // floating panel open/closed
  const abortRef = useRef(null)

  // ── Load conversation list whenever the active profile changes ──────────
  const refreshList = useCallback(async () => {
    if (!session || !selectedProfileId) {
      setConversations([])
      return
    }
    try {
      const r = await fetch(`/api/agent/conversations?profile_id=${selectedProfileId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const body = await r.json().catch(() => ({}))
      if (r.ok) {
        setConversations(body.conversations || [])
      } else {
        // surface the failure so the panel can show an error vs. spinning forever
        console.warn('[agent] list conversations failed', body.error || r.status)
        setError(body.error || `Failed to load conversations (${r.status})`)
      }
    } catch (e) {
      console.warn('[agent] list conversations errored', e.message)
      setError(e.message)
    }
  }, [session, selectedProfileId])

  useEffect(() => { refreshList() }, [refreshList])

  // ── Load messages whenever activeId changes ─────────────────────────────
  const loadMessages = useCallback(async (convId) => {
    if (!session || !convId) {
      setMessages([])
      return
    }
    try {
      const r = await fetch(`/api/agent/messages?conversation_id=${convId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const body = await r.json()
      if (r.ok) setMessages(body.messages || [])
    } catch {}
  }, [session])

  useEffect(() => { loadMessages(activeId) }, [activeId, loadMessages])

  // ── Reset selection when profile changes ───────────────────────────────
  useEffect(() => {
    setActiveId(null)
    setMessages([])
    setStreamingText('')
  }, [selectedProfileId])

  // ── Send a message + stream the response ───────────────────────────────
  const send = useCallback(async (text) => {
    if (!session || !selectedProfileId || !text.trim()) return
    setError(null)
    setStreaming(true)
    setStreamingText('')

    // Optimistically append the user message
    const localUser = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      created_at: new Date().toISOString(),
    }
    setMessages((m) => [...m, localUser])

    // Abort any in-flight stream
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller

    let convIdForStream = activeId
    let assistantText = ''
    let messageId = null

    try {
      const resp = await fetch('/api/agent/chat', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          conversation_id: activeId,
          profile_id: selectedProfileId,
          message: text,
        }),
      })

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}))
        throw new Error(errBody.error || `Chat failed (${resp.status})`)
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          if (!raw.startsWith('data: ')) continue
          let evt
          try { evt = JSON.parse(raw.slice(6)) } catch { continue }
          if (evt.type === 'start' && evt.conversation_id) {
            convIdForStream = evt.conversation_id
            if (!activeId) setActiveId(evt.conversation_id)
          } else if (evt.type === 'text') {
            assistantText += evt.text
            setStreamingText(assistantText)
          } else if (evt.type === 'done') {
            messageId = evt.message_id
          } else if (evt.type === 'error') {
            throw new Error(evt.error || 'Stream error')
          }
        }
      }

      // Append the final assistant message
      setMessages((m) => [
        ...m,
        {
          id: messageId || `local-asst-${Date.now()}`,
          role: 'assistant',
          content: [{ type: 'text', text: assistantText }],
          created_at: new Date().toISOString(),
        },
      ])
      setStreamingText('')
      // Refresh conversation list (title may have updated)
      refreshList()
    } catch (e) {
      if (e.name === 'AbortError') return
      setError(e.message)
      setStreamingText('')
    } finally {
      setStreaming(false)
    }
  }, [session, selectedProfileId, activeId, refreshList])

  const startNewConversation = useCallback(() => {
    if (abortRef.current) abortRef.current.abort()
    setActiveId(null)
    setMessages([])
    setStreamingText('')
    setError(null)
  }, [])

  const deleteConversation = useCallback(async (id) => {
    if (!session) return
    await fetch(`/api/agent/conversations?id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    if (activeId === id) startNewConversation()
    refreshList()
  }, [session, activeId, refreshList, startNewConversation])

  // ── Pinning ────────────────────────────────────────────────────────────
  const pinFact = useCallback(async (fact, sourceMessageId) => {
    if (!session || !selectedProfileId) return null
    const r = await fetch('/api/agent/pinned-facts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({
        profile_id: selectedProfileId,
        fact,
        source: sourceMessageId ? 'message' : 'manual',
        source_ref: sourceMessageId || null,
      }),
    })
    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      setError(e.error || 'Failed to pin')
      return null
    }
    return (await r.json()).fact
  }, [session, selectedProfileId])

  return (
    <AgentContext.Provider value={{
      conversations, activeId, setActiveId,
      messages, streamingText, streaming, error,
      send, startNewConversation, deleteConversation,
      refreshList, pinFact,
      open, setOpen,
    }}>
      {children}
    </AgentContext.Provider>
  )
}

export function useAgent() {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error('useAgent must be used inside an AgentProvider')
  return ctx
}
