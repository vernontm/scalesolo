import { useLocation } from 'react-router-dom'
import { Search, Bell, Plus } from 'lucide-react'
import ThemeToggle from './ThemeToggle.jsx'

const titles = {
  '/dashboard': { t: 'Dashboard',        s: "Welcome back — here's your overview." },
  '/agent':     { t: 'AI CEO',           s: 'Your always-on strategist.' },
  '/content':   { t: 'Content',          s: 'Generate, schedule, recycle.' },
  '/email':     { t: 'Email',            s: 'Compose, automate, deliver.' },
  '/avatars':   { t: 'Avatars & voice',  s: 'AI you, on tap.' },
  '/landing':   { t: 'Landing pages',    s: 'Build branded pages in minutes.' },
  '/contacts':  { t: 'Contacts',         s: 'Every conversation, one place.' },
  '/pipeline':  { t: 'Sales pipeline',   s: 'Lead to close, drag-and-drop.' },
  '/forms':     { t: 'Forms',            s: 'Capture leads on autopilot.' },
  '/analytics': { t: 'Analytics',        s: 'Performance with insights.' },
  '/profiles':  { t: 'Brand profiles',   s: 'Switch and manage brands.' },
  '/settings':  { t: 'Settings',         s: 'Your workspace, your rules.' },
}

const headerStyle = {
  position: 'sticky',
  top: 0,
  zIndex: 5,
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  padding: '18px 40px',
  background: 'color-mix(in srgb, var(--bg) 70%, transparent)',
  backdropFilter: 'blur(14px)',
  WebkitBackdropFilter: 'blur(14px)',
  borderBottom: '1px solid var(--border)',
}
const titleStyle = {
  fontFamily: 'var(--font-display)',
  fontSize: 20,
  fontWeight: 700,
  letterSpacing: '-0.01em',
  color: 'var(--text)',
}
const subtitleStyle = { fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }
const searchWrap = { marginLeft: 'auto', position: 'relative', width: 280 }
const searchInputStyle = {
  width: '100%',
  padding: '10px 14px 10px 38px',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  color: 'var(--text)',
  fontSize: 13,
  outline: 'none',
}
const searchIconStyle = {
  position: 'absolute',
  left: 12,
  top: '50%',
  transform: 'translateY(-50%)',
  color: 'var(--muted)',
}
const iconBtnStyle = {
  width: 38,
  height: 38,
  display: 'grid',
  placeItems: 'center',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  color: 'var(--text)',
  cursor: 'pointer',
  position: 'relative',
}
const dotStyle = {
  position: 'absolute',
  top: 9,
  right: 9,
  width: 7,
  height: 7,
  borderRadius: '50%',
  background: 'var(--red)',
  boxShadow: '0 0 8px var(--red)',
}

export default function Header() {
  const { pathname } = useLocation()
  const meta = titles[pathname] || { t: 'ScaleSolo', s: '' }

  return (
    <header style={headerStyle}>
      <div>
        <h1 style={titleStyle}>{meta.t}</h1>
        {meta.s && <span style={subtitleStyle}>{meta.s}</span>}
      </div>

      <div style={searchWrap}>
        <Search size={16} style={searchIconStyle} />
        <input style={searchInputStyle} placeholder="Search…" />
      </div>

      <ThemeToggle />

      <button style={iconBtnStyle} aria-label="Notifications">
        <Bell size={17} />
        <span style={dotStyle} />
      </button>

      <button className="btn-primary">
        <Plus size={16} strokeWidth={2.5} />
        New
      </button>
    </header>
  )
}
