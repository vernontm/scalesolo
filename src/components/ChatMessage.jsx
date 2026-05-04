import { Bot, User, Pin, Check } from 'lucide-react'
import { useState } from 'react'
import { useAgent } from '../context/AgentContext.jsx'

const row = (isUser) => ({
  display: 'flex',
  gap: 12,
  padding: '14px 18px',
  background: isUser ? 'transparent' : 'var(--surface)',
  borderRadius: 12,
  border: isUser ? '1px solid transparent' : '1px solid var(--border)',
})
const avatarUser = {
  width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center',
  background: 'var(--surface-2)', color: 'var(--text-soft)', flexShrink: 0,
  border: '1px solid var(--border)',
}
const avatarBot = {
  width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', flexShrink: 0,
  boxShadow: '0 4px 10px rgba(239,68,68,0.25)',
}
const body = {
  flex: 1,
  minWidth: 0,
  fontSize: 14,
  lineHeight: 1.55,
  color: 'var(--text)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}
const meta = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 11,
  color: 'var(--muted)',
  marginBottom: 4,
  fontFamily: 'var(--font-display)',
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
}
const pinBtn = (pinned) => ({
  marginLeft: 'auto',
  display: 'inline-flex', alignItems: 'center', gap: 4,
  background: pinned ? 'var(--red-soft)' : 'transparent',
  color: pinned ? 'var(--red)' : 'var(--muted)',
  border: '1px solid ' + (pinned ? 'rgba(239,68,68,0.35)' : 'var(--border)'),
  borderRadius: 6,
  padding: '4px 8px',
  fontSize: 11,
  fontFamily: 'var(--font-display)',
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'all 0.15s ease',
})

function asText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => c.text || '').join('')
  return String(content)
}

export default function ChatMessage({ message, isStreaming = false }) {
  const isUser = message.role === 'user'
  const text = asText(message.content)
  const [pinned, setPinned] = useState(false)
  const [pinning, setPinning] = useState(false)
  const { pinFact } = useAgent()

  async function onPin() {
    setPinning(true)
    // Pin a short summary of the message (cap at 240 chars).
    const fact = text.slice(0, 240) + (text.length > 240 ? '…' : '')
    const result = await pinFact(fact, !message.id?.startsWith('local-') ? message.id : null)
    if (result) setPinned(true)
    setPinning(false)
  }

  return (
    <div style={row(isUser)}>
      <div style={isUser ? avatarUser : avatarBot}>
        {isUser ? <User size={15} strokeWidth={2.2} /> : <Bot size={16} strokeWidth={2.2} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={meta}>
          <span>{isUser ? 'You' : 'AI CEO'}</span>
          {isStreaming && (
            <span style={{ color: 'var(--red)', textTransform: 'none', letterSpacing: 0 }}>
              <span className="spinner" style={{ width: 10, height: 10, display: 'inline-block', verticalAlign: '-1px', marginRight: 4 }} />
              streaming
            </span>
          )}
          {!isUser && !isStreaming && text && (
            <button style={pinBtn(pinned)} onClick={onPin} disabled={pinning || pinned}>
              {pinned ? <Check size={11} /> : <Pin size={11} />}
              {pinned ? 'Pinned' : (pinning ? '…' : 'Pin')}
            </button>
          )}
        </div>
        <div style={body}>{text}</div>
      </div>
    </div>
  )
}
