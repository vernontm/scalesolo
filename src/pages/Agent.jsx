import { useEffect, useRef, useState } from 'react'
import { Bot, Send, Plus, Trash2, Pin } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { useAgent } from '../context/AgentContext.jsx'
import ChatMessage from '../components/ChatMessage.jsx'
import { supabase } from '../lib/supabase.js'

const layout = {
  display: 'grid',
  gridTemplateColumns: '260px 1fr 240px',
  gap: 16,
  alignItems: 'stretch',
  height: 'calc(100vh - 160px)',
  minHeight: 540,
}
const sidebar = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}
const sidebarHead = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '12px 14px', borderBottom: '1px solid var(--border)',
}
const sidebarTitle = {
  fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700,
  letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted)',
  flex: 1,
}
const newBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 10px', borderRadius: 8,
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', border: 'none', cursor: 'pointer',
  fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 600,
  boxShadow: '0 4px 10px rgba(239,68,68,0.25)',
}
const list = { flex: 1, overflow: 'auto', padding: 8 }
const convRow = (active) => ({
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '10px 12px', borderRadius: 8,
  background: active ? 'var(--surface-2)' : 'transparent',
  border: active ? '1px solid rgba(239,68,68,0.35)' : '1px solid transparent',
  cursor: 'pointer',
  marginBottom: 3,
})
const main = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
}
const messagesArea = { flex: 1, overflow: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 8 }
const inputBar = { display: 'flex', alignItems: 'flex-end', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }
const ta = {
  flex: 1, minHeight: 44, maxHeight: 200, resize: 'none',
  padding: '12px 14px',
  background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10,
  color: 'var(--text)', fontSize: 14, outline: 'none', fontFamily: 'inherit',
}
const sendBtn = {
  width: 44, height: 44, borderRadius: 10,
  display: 'grid', placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', border: 'none', cursor: 'pointer',
  boxShadow: '0 4px 12px rgba(239,68,68,0.3)',
}
const factsItem = {
  display: 'flex', alignItems: 'flex-start', gap: 8,
  padding: 10, marginBottom: 6,
  background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8,
  fontSize: 12.5, lineHeight: 1.4, color: 'var(--text-soft)',
}

export default function Agent() {
  const { user, session } = useAuth()
  const { selectedProfile, selectedProfileId } = useProfile()
  const {
    conversations, activeId, setActiveId,
    messages, streamingText, streaming, error,
    send, startNewConversation, deleteConversation,
  } = useAgent()
  const [input_, setInput] = useState('')
  const [pinned, setPinned] = useState([])
  const [pinInput, setPinInput] = useState('')
  const scrollRef = useRef(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, streamingText])

  const refreshPinned = async () => {
    if (!session || !selectedProfileId) return
    const r = await fetch(`/api/agent/pinned-facts?profile_id=${selectedProfileId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    const body = await r.json()
    if (r.ok) setPinned(body.facts || [])
  }
  useEffect(() => { refreshPinned() }, [selectedProfileId, session])

  const addPinned = async () => {
    if (!pinInput.trim()) return
    const r = await fetch('/api/agent/pinned-facts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ profile_id: selectedProfileId, fact: pinInput.trim() }),
    })
    if (r.ok) { setPinInput(''); refreshPinned() }
  }

  const removePinned = async (id) => {
    await fetch(`/api/agent/pinned-facts?id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    refreshPinned()
  }

  const handleSend = () => {
    const t = input_.trim()
    if (!t || streaming) return
    setInput('')
    send(t)
  }

  if (!selectedProfileId) {
    return <div className="card-flat fade-up" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      Pick a brand profile to start chatting with the AI CEO.
    </div>
  }

  return (
    <div style={layout} className="fade-up">
      {/* Conversation list */}
      <aside style={sidebar}>
        <div style={sidebarHead}>
          <span style={sidebarTitle}>Conversations</span>
          <button style={newBtn} onClick={startNewConversation}><Plus size={13} /> New</button>
        </div>
        <div style={list}>
          {conversations.length === 0 ? (
            <div style={{ padding: 14, fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>No conversations yet.</div>
          ) : conversations.map((c) => (
            <div key={c.id} style={convRow(c.id === activeId)} onClick={() => setActiveId(c.id)}>
              <Bot size={14} />
              <div style={{ flex: 1, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.title || 'Untitled'}
              </div>
              <button style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 2 }}
                onClick={(e) => { e.stopPropagation(); if (confirm('Delete this conversation?')) deleteConversation(c.id) }}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* Chat */}
      <section style={main}>
        <div ref={scrollRef} style={messagesArea}>
          {messages.length === 0 && !streamingText ? (
            <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ width: 56, height: 56, borderRadius: 14, background: 'linear-gradient(135deg, var(--red), var(--red-dark))', color: '#fff', margin: '0 auto 12px', display: 'grid', placeItems: 'center', boxShadow: '0 8px 22px rgba(239,68,68,0.3)' }}>
                  <Bot size={24} />
                </div>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>
                  AI CEO for {selectedProfile?.business_name || 'your brand'}
                </div>
                <div style={{ fontSize: 13, marginTop: 6 }}>Ask a question to get started.</div>
              </div>
            </div>
          ) : (
            <>
              {messages.map((m) => <ChatMessage key={m.id} message={m} />)}
              {streamingText && (
                <ChatMessage message={{ id: 'streaming', role: 'assistant', content: [{ type: 'text', text: streamingText }] }} isStreaming />
              )}
            </>
          )}
        </div>
        {error && (
          <div style={{ padding: '10px 14px', background: 'var(--red-soft)', color: 'var(--red)', fontSize: 12.5, borderTop: '1px solid rgba(239,68,68,0.25)' }}>
            {error}
          </div>
        )}
        <div style={inputBar}>
          <textarea
            style={ta}
            placeholder="Ask the AI CEO…"
            value={input_}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
            disabled={streaming}
            rows={1}
          />
          <button style={{ ...sendBtn, opacity: !input_.trim() || streaming ? 0.5 : 1 }} onClick={handleSend} disabled={!input_.trim() || streaming}>
            {streaming ? <span className="spinner" /> : <Send size={17} />}
          </button>
        </div>
      </section>

      {/* Pinned facts */}
      <aside style={sidebar}>
        <div style={sidebarHead}>
          <Pin size={13} style={{ color: 'var(--muted)' }} />
          <span style={sidebarTitle}>Pinned facts</span>
        </div>
        <div style={{ ...list, padding: 12 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <input
              type="text"
              placeholder="Add a fact…"
              className="input"
              style={{ padding: '8px 10px', fontSize: 12.5 }}
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addPinned() }}
            />
            <button className="btn-secondary" style={{ padding: '8px 10px' }} onClick={addPinned}><Plus size={13} /></button>
          </div>
          {pinned.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', padding: 8, lineHeight: 1.5 }}>
              Pin facts the AI CEO should always remember. Things like brand do-not-say words, the founder's story, target market specifics.
            </div>
          ) : pinned.map((f) => (
            <div key={f.id} style={factsItem}>
              <div style={{ flex: 1 }}>{f.fact}</div>
              <button onClick={() => removePinned(f.id)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }} title="Remove">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}
