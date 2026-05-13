import { useLocation } from 'react-router-dom'
import { Menu, Bot } from 'lucide-react'
import ThemeToggle from './ThemeToggle.jsx'
import NotificationBell from './NotificationBell.jsx'
import CreditsBadge from './CreditsBadge.jsx'
import ProfileSwitcher from './ProfileSwitcher.jsx'
import { useAgent } from '../context/AgentContext.jsx'

const titles = {
  '/dashboard': { t: 'Dashboard',        s: "Welcome back — here's your overview." },
  '/agent':     { t: 'AI CEO',           s: 'Your always-on strategist.' },
  '/spaces':    { t: 'Spaces',           s: 'Visual content workflows.' },
  '/schedule':  { t: 'Schedule',         s: 'Library, calendar, and social publishing.' },
  '/content':   { t: 'Schedule',         s: 'Library, calendar, and social publishing.' },
  '/email':     { t: 'Email',            s: 'Compose, automate, deliver.' },
  '/avatars':   { t: 'Avatars & voice',  s: 'AI you, on tap.' },
  '/landing':   { t: 'Landing pages',    s: 'Build branded pages in minutes.' },
  '/contacts':  { t: 'Contacts',         s: 'Every conversation, one place.' },
  '/pipeline':  { t: 'Sales pipeline',   s: 'Lead to close, drag-and-drop.' },
  '/forms':     { t: 'Forms',            s: 'Capture leads on autopilot.' },
  '/analytics': { t: 'Analytics',        s: 'Performance with insights.' },
  '/profiles':  { t: 'Brand profiles',   s: 'Switch and manage brands.' },
  '/billing':   { t: 'Billing',          s: 'Plan, payment, invoices.' },
  '/settings':  { t: 'Settings',         s: 'Your workspace, your rules.' },
}

const headerStyle = {
  position: 'sticky',
  top: 0,
  zIndex: 5,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '14px 24px',
  background: 'color-mix(in srgb, var(--bg) 70%, transparent)',
  backdropFilter: 'blur(14px)',
  WebkitBackdropFilter: 'blur(14px)',
  borderBottom: '1px solid var(--border)',
  // No flexWrap on mobile — overflow / hide-on-mobile classes keep
  // the header single-row. Wrapping was producing 3-row stacks on
  // narrow viewports.
  flexWrap: 'nowrap',
  minWidth: 0,
}
const titleStyle = {
  fontFamily: 'var(--font-display)',
  fontSize: 18,
  fontWeight: 700,
  letterSpacing: '-0.01em',
  color: 'var(--text)',
}
const subtitleStyle = { fontSize: 12, color: 'var(--muted)', marginTop: 2 }
const cmdK = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  height: 38,
  padding: '0 12px',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  color: 'var(--text-soft)',
  fontFamily: 'var(--font-display)',
  fontWeight: 600,
  fontSize: 12.5,
  cursor: 'pointer',
  transition: 'border-color 0.15s ease',
}
const kbd = {
  fontFamily: 'monospace',
  fontSize: 11,
  background: 'var(--surface-3)',
  border: '1px solid var(--border)',
  padding: '2px 6px',
  borderRadius: 4,
  color: 'var(--muted)',
}
const menuBtn = {
  display: 'none',          // shown on mobile via media query in global.css
  width: 38, height: 38,
  alignItems: 'center', justifyContent: 'center',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  color: 'var(--text)',
  cursor: 'pointer',
}

export default function Header({ onOpenSidebar }) {
  const { pathname } = useLocation()
  const { setOpen: setAgentOpen } = useAgent()
  const meta = titles[pathname] || { t: 'ScaleSolo', s: '' }

  return (
    <header className="app-header" style={headerStyle}>
      <button
        className="mobile-only"
        style={menuBtn}
        onClick={onOpenSidebar}
        aria-label="Open menu"
      >
        <Menu size={18} />
      </button>

      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <h1 style={{ ...titleStyle, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{meta.t}</h1>
        {/* Subtitle hides under 700px — verbose, eats two lines on
            mobile, and isn't load-bearing copy. */}
        {meta.s && <span className="hide-on-narrow" style={subtitleStyle}>{meta.s}</span>}
      </div>

      {/* AI CEO ⌘K — beta-only. The Agent surface is gated out of the
          sidebar to keep the focused product clear; tack ?beta=1 on the
          URL once and it sticks via localStorage. */}
      {(typeof window !== 'undefined' && window.localStorage?.getItem('scalesolo:beta') === '1') && (
        <button
          className="hide-on-narrow"
          style={cmdK}
          onClick={() => setAgentOpen(true)}
          title="Ask the AI CEO (⌘K)"
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)' }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)' }}
        >
          <Bot size={14} style={{ color: 'var(--red)' }} />
          Ask AI CEO
          <span style={kbd}>⌘K</span>
        </button>
      )}

      {/* On mobile (<900px) we hide ProfileSwitcher, CreditsBadge, and
          ThemeToggle from the header — they're surfaced at the top of
          the sidebar drawer instead so the header stays a single
          single-row line: [burger, title, bell, Generate]. */}
      <span className="hide-on-mobile" style={{ display: 'inline-flex' }}><ProfileSwitcher /></span>
      <span className="hide-on-mobile" style={{ display: 'inline-flex' }}><CreditsBadge /></span>

      <NotificationBell />

      <span className="hide-on-mobile" style={{ display: 'inline-flex' }}><ThemeToggle /></span>
      {/* Header Generate button removed — Spaces and Bulk Upload
          are the canonical ways to make content, both reachable
          from the sidebar. */}
    </header>
  )
}
