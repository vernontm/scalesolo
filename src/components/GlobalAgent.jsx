import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Bot, X, Send, Plus, History, Trash2, Maximize2, Sparkles,
} from 'lucide-react'
import { useAgent } from '../context/AgentContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import ChatMessage from './ChatMessage.jsx'

const fab = {
  position: 'fixed',
  right: 24, bottom: 24,
  width: 56, height: 56,
  borderRadius: '50%',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff',
  border: 'none', cursor: 'pointer',
  display: 'grid', placeItems: 'center',
  boxShadow: '0 14px 36px rgba(239,68,68,0.4)',
  zIndex: 60,
  transition: 'transform 0.2s var(--ease)',
}
const overlay = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.35)',
  backdropFilter: 'blur(2px)',
  zIndex: 70,
  animation: 'fadeIn 0.2s ease forwards',
}
const panel = {
  position: 'fixed',
  right: 0, top: 0, bottom: 0,
  width: 'min(440px, 92vw)',
  background: 'var(--bg)',
  borderLeft: '1px solid var(--border)',
  zIndex: 80,
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '-30px 0 60px rgba(0,0,0,0.45)',
  animation: 'fadeUp 0.25s var(--ease) forwards',
}
const head = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '14px 16px',
  borderBottom: '1px solid var(--border)',
  background: 'var(--surface)',
}
const headIcon = {
  width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))', color: '#fff',
  boxShadow: '0 4px 10px rgba(239,68,68,0.25)',
}
const title = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14 }
const subtitle = { fontSize: 11, color: 'var(--muted)', marginTop: 1 }
const headBtn = {
  width: 32, height: 32, display: 'grid', placeItems: 'center',
  background: 'transparent', border: '1px solid var(--border)', borderRadius: 8,
  color: 'var(--text-soft)', cursor: 'pointer',
}
const historyDrawer = {
  borderBottom: '1px solid var(--border)',
  background: 'var(--surface)',
  padding: 12,
  maxHeight: 220,
  overflow: 'auto',
}
const historyEmpty = {
  textAlign: 'center', padding: '20px 12px', fontSize: 12.5, color: 'var(--muted)',
}
const historyRow = (active) => ({
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '10px 12px',
  borderRadius: 8,
  background: active ? 'var(--surface-2)' : 'transparent',
  border: active ? '1px solid rgba(239,68,68,0.35)' : '1px solid transparent',
  cursor: 'pointer',
  marginBottom: 4,
  transition: 'background 0.12s ease',
})
const messagesWrap = {
  flex: 1, overflow: 'auto',
  padding: 14, display: 'flex', flexDirection: 'column', gap: 8,
}
const emptyState = {
  flex: 1, display: 'grid', placeItems: 'center', padding: 20,
  textAlign: 'center', color: 'var(--muted)',
}
const emptyIcon = {
  width: 56, height: 56, borderRadius: 14, display: 'grid', placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))', color: '#fff',
  margin: '0 auto 14px', boxShadow: '0 8px 22px rgba(239,68,68,0.3)',
}
const inputWrap = {
  display: 'flex', alignItems: 'flex-end', gap: 8,
  padding: 12, borderTop: '1px solid var(--border)',
  background: 'var(--surface)',
}
const input = {
  flex: 1, minHeight: 40, maxHeight: 140,
  resize: 'none',
  padding: '10px 12px',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  color: 'var(--text)', fontSize: 14,
  outline: 'none', fontFamily: 'inherit',
}
const sendBtn = {
  width: 40, height: 40, borderRadius: 10,
  display: 'grid', placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', border: 'none', cursor: 'pointer',
  boxShadow: '0 4px 12px rgba(239,68,68,0.3)',
  transition: 'transform 0.12s ease',
}

const STARTER_PROMPTS = [
  'What should I post this week?',
  'Draft a welcome email for new subscribers.',
  'Audit my brand voice from the last 5 posts.',
  'Where is engagement coming from this month?',
]

export default function GlobalAgent() {
  const { user } = useAuth()
  const { selectedProfile, selectedProfileId } = useProfile()
  const {
    open, setOpen,
    conversations, activeId, setActiveId,
    messages, streamingText, streaming, error,
    send, startNewConversation, deleteConversation,
  } = useAgent()
  const navigate = useNavigate()
  const [input_, setInput] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const scrollRef = useRef(null)

  // Auto-scroll on new message / streaming
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, streamingText])

  // Cmd/Ctrl+K opens
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(true)
      }
      if (e.key === 'Escape' && open) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!user) return null

  const handleSend = () => {
    const text = input_.trim()
    if (!text || streaming) return
    setInput('')
    send(text)
  }

  return (
    <>
      {!open && (
        <button
          style={fab}
          onClick={() => setOpen(true)}
          aria-label="Open AI CEO"
          title="AI CEO (⌘K)"
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px) scale(1.04)' }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0) scale(1)' }}
        >
          <Bot size={24} strokeWidth={2.2} />
        </button>
      )}

      {open && (
        <>
          <div style={overlay} onClick={() => setOpen(false)} />
          <aside style={panel}>
            <div style={head}>
              <div style={headIcon}><Bot size={16} strokeWidth={2.2} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={title}>AI CEO</div>
                <div style={subtitle}>
                  {selectedProfile ? selectedProfile.business_name : 'Pick a brand profile to begin'}
                </div>
              </div>
              <button style={headBtn} title="History" onClick={() => setShowHistory((s) => !s)}>
                <History size={15} />
              </button>
              <button style={headBtn} title="New conversation" onClick={startNewConversation}>
                <Plus size={15} />
              </button>
              <button style={headBtn} title="Open full page" onClick={() => { setOpen(false); navigate('/agent') }}>
                <Maximize2 size={14} />
              </button>
              <button style={headBtn} title="Close" onClick={() => setOpen(false)}>
                <X size={15} />
              </button>
            </div>

            {showHistory && (
              <div style={historyDrawer}>
                {conversations.length === 0 ? (
                  <div style={historyEmpty}>No conversations yet.</div>
                ) : conversations.map((c) => (
                  <div key={c.id} style={historyRow(c.id === activeId)} onClick={() => { setActiveId(c.id); setShowHistory(false) }}>
                    <Bot size={14} strokeWidth={2} />
                    <div style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: c.id === activeId ? 'var(--text)' : 'var(--text-soft)' }}>
                      {c.title || 'Untitled'}
                    </div>
                    <button
                      style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4 }}
                      onClick={(e) => { e.stopPropagation(); if (confirm('Delete this conversation?')) deleteConversation(c.id) }}
                      title="Delete"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div ref={scrollRef} style={messagesWrap}>
              {messages.length === 0 && !streamingText ? (
                <div style={emptyState}>
                  <div style={emptyIcon}><Sparkles size={24} strokeWidth={2.2} /></div>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: 'var(--text)', marginBottom: 6 }}>
                    Your AI CEO is ready.
                  </div>
                  <div style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
                    Ask anything about your brand, content, or strategy.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 320, margin: '0 auto' }}>
                    {STARTER_PROMPTS.map((p) => (
                      <button
                        key={p}
                        onClick={() => { setInput(p); setTimeout(() => handleSend(), 0) }}
                        style={{
                          textAlign: 'left',
                          padding: '10px 14px',
                          background: 'var(--surface-2)', border: '1px solid var(--border)',
                          borderRadius: 10, fontSize: 13, color: 'var(--text-soft)',
                          cursor: 'pointer',
                        }}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {messages.map((m) => <ChatMessage key={m.id} message={m} />)}
                  {streamingText && (
                    <ChatMessage
                      message={{ id: 'streaming', role: 'assistant', content: [{ type: 'text', text: streamingText }] }}
                      isStreaming
                    />
                  )}
                </>
              )}
            </div>

            {error && (
              <div style={{ padding: '10px 14px', background: 'var(--red-soft)', color: 'var(--red)', fontSize: 12.5, borderTop: '1px solid rgba(239,68,68,0.25)' }}>
                {error}
              </div>
            )}

            <div style={inputWrap}>
              <textarea
                style={input}
                placeholder={selectedProfileId ? "Ask the AI CEO…" : "Pick a brand profile first"}
                value={input_}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
                }}
                disabled={!selectedProfileId || streaming}
                rows={1}
              />
              <button
                style={{ ...sendBtn, opacity: !input_.trim() || streaming ? 0.5 : 1, cursor: !input_.trim() || streaming ? 'default' : 'pointer' }}
                onClick={handleSend}
                disabled={!input_.trim() || streaming || !selectedProfileId}
              >
                {streaming ? <span className="spinner" /> : <Send size={16} strokeWidth={2.2} />}
              </button>
            </div>
          </aside>
        </>
      )}
    </>
  )
}
