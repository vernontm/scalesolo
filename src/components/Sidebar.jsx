import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Sparkles,
  Mail,
  Users,
  KanbanSquare,
  ClipboardList,
  LayoutTemplate,
  UserCircle2,
  BarChart3,
  Bot,
  Building2,
  Boxes,
  CreditCard,
  Settings,
  Zap,
  LogOut,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'

// Sidebar groups. `beta: true` items only show when the URL has ?beta=1
// (or localStorage has scalesolo:beta='1'). The product is intentionally
// scoped down to "automated content workflows": Spaces + Schedule +
// Avatars + Brand profiles. CRM-y features (Contacts, Pipeline, Landing,
// Email) and the standalone AI CEO are kept in the codebase but hidden
// from the nav so the message stays sharp. Flip the flag and they're
// all back.
const navGroups = [
  {
    label: 'Workspace',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/agent',     label: 'AI CEO',    icon: Bot, beta: true },
    ],
  },
  {
    label: 'Create',
    items: [
      { to: '/spaces',  label: 'Spaces',   icon: Boxes },
      { to: '/schedule', label: 'Schedule', icon: Sparkles },
      { to: '/avatars', label: 'Avatars',  icon: UserCircle2 },
      { to: '/email',   label: 'Email',    icon: Mail, beta: true },
      { to: '/landing', label: 'Landing',  icon: LayoutTemplate, beta: true },
    ],
  },
  {
    label: 'Grow',
    beta: true,
    items: [
      { to: '/contacts',  label: 'Contacts',  icon: Users, beta: true },
      { to: '/pipeline',  label: 'Pipeline',  icon: KanbanSquare, beta: true },
      { to: '/analytics', label: 'Analytics', icon: BarChart3, beta: true },
    ],
  },
  {
    label: 'Account',
    items: [
      { to: '/profiles', label: 'Brand profiles', icon: Building2 },
      { to: '/billing',  label: 'Billing',        icon: CreditCard },
      { to: '/settings', label: 'Settings',       icon: Settings },
    ],
  },
]

// Once a session, lock in the beta flag if ?beta=1 was in the URL so
// reloading without the param keeps showing the gated nav (otherwise
// the user has to tack ?beta=1 onto every link).
function readBetaFlag() {
  if (typeof window === 'undefined') return false
  try {
    const url = new URL(window.location.href)
    if (url.searchParams.get('beta') === '1') {
      window.localStorage.setItem('scalesolo:beta', '1')
      return true
    }
    if (url.searchParams.get('beta') === '0') {
      window.localStorage.removeItem('scalesolo:beta')
      return false
    }
    return window.localStorage.getItem('scalesolo:beta') === '1'
  } catch { return false }
}

const sidebarStyle = {
  position: 'fixed',
  top: 0,
  left: 0,
  width: 240,
  height: '100vh',
  background: 'var(--surface)',
  borderRight: '1px solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  padding: '22px 14px',
  zIndex: 95,
}
const brandStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '4px 10px 22px',
  marginBottom: 6,
  borderBottom: '1px solid var(--border)',
}
const brandIconStyle = {
  width: 34,
  height: 34,
  borderRadius: 10,
  display: 'grid',
  placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff',
  boxShadow: '0 4px 14px rgba(239,68,68,0.3)',
}
const brandTextStyle = {
  fontFamily: 'var(--font-display)',
  fontWeight: 800,
  fontSize: 15,
  letterSpacing: '-0.01em',
}
const brandTagStyle = {
  fontSize: 10,
  color: 'var(--muted)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  marginTop: 2,
}
const navStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  marginTop: 6,
  flex: 1,
  overflow: 'auto',
}
const navLabelStyle = {
  fontFamily: 'var(--font-display)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
  padding: '14px 12px 6px',
}
const footerStyle = {
  marginTop: 'auto',
  paddingTop: 12,
  borderTop: '1px solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}
const userRow = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 12px',
  fontSize: 12.5,
  color: 'var(--text-soft)',
}
const avatarBubble = {
  width: 28,
  height: 28,
  borderRadius: '50%',
  display: 'grid',
  placeItems: 'center',
  background: 'var(--surface-2)',
  color: 'var(--text)',
  fontWeight: 700,
  fontSize: 12,
  fontFamily: 'var(--font-display)',
  border: '1px solid var(--border)',
}
const signOutBtn = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '10px 12px',
  borderRadius: 10,
  background: 'transparent',
  border: 'none',
  color: 'var(--muted)',
  fontFamily: 'var(--font-display)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'color 0.15s ease, background 0.15s ease',
}

function linkStyle(isActive) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 12px',
    borderRadius: 10,
    fontFamily: 'var(--font-display)',
    fontSize: 13.5,
    fontWeight: 600,
    color: isActive ? 'var(--text)' : 'var(--muted)',
    background: isActive
      ? 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(185,28,28,0.12))'
      : 'transparent',
    border: isActive
      ? '1px solid rgba(239,68,68,0.35)'
      : '1px solid transparent',
    transition: 'color 0.15s ease, background 0.15s ease, border-color 0.15s ease',
  }
}

export default function Sidebar({ mobile = false, compact = false, onClose }) {
  const { user, signOut } = useAuth()
  const initials = (user?.email || 'U').slice(0, 2).toUpperCase()
  const isCompact = compact && !mobile
  const showBeta = readBetaFlag()

  // Filter out beta-only groups + items unless the flag is on. Empty
  // groups (all items hidden) get dropped entirely so we don't render
  // a header with nothing under it.
  const visibleGroups = navGroups
    .filter((g) => showBeta || !g.beta)
    .map((g) => ({ ...g, items: g.items.filter((it) => showBeta || !it.beta) }))
    .filter((g) => g.items.length > 0)

  const handleNavClick = () => {
    if (mobile && onClose) onClose()
  }

  // Compact mode: 60px wide, icons only, group labels hidden, no labels next
  // to nav items, no email row in footer.
  const computedSidebarStyle = {
    ...sidebarStyle,
    width: isCompact ? 60 : 240,
    padding: isCompact ? '22px 6px' : '22px 14px',
    transition: 'width 0.2s var(--ease)',
  }

  return (
    <aside
      className={mobile ? 'mobile-sidebar' : 'desktop-sidebar'}
      style={computedSidebarStyle}
    >
      <div style={{ ...brandStyle, padding: isCompact ? '4px 0 18px' : '4px 10px 22px', justifyContent: isCompact ? 'center' : 'flex-start' }}>
        <div style={brandIconStyle}><Zap size={18} strokeWidth={2.5} /></div>
        {!isCompact && (
          <div>
            <div style={brandTextStyle}>ScaleSolo</div>
            <div style={brandTagStyle}>Scale 10× faster</div>
          </div>
        )}
      </div>

      <nav style={navStyle}>
        {visibleGroups.map((group) => (
          <div key={group.label}>
            {!isCompact && <div style={navLabelStyle}>{group.label}</div>}
            {isCompact && <div style={{ height: 8 }} />}
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={handleNavClick}
                title={isCompact ? item.label : undefined}
                style={({ isActive }) => ({
                  ...linkStyle(isActive),
                  justifyContent: isCompact ? 'center' : 'flex-start',
                  padding: isCompact ? '10px 0' : '10px 12px',
                })}
                onMouseEnter={(e) => {
                  if (!e.currentTarget.style.background.includes('gradient')) {
                    e.currentTarget.style.color = 'var(--text)'
                    e.currentTarget.style.background = 'var(--surface-2)'
                  }
                }}
                onMouseLeave={(e) => {
                  const active = e.currentTarget.getAttribute('aria-current') === 'page'
                  if (!active) {
                    e.currentTarget.style.color = 'var(--muted)'
                    e.currentTarget.style.background = 'transparent'
                  }
                }}
              >
                <item.icon size={isCompact ? 18 : 17} strokeWidth={2} />
                {!isCompact && item.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div style={footerStyle}>
        {!isCompact && (
          <div style={userRow}>
            <div style={avatarBubble}>{initials}</div>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.email || 'Signed in'}
            </div>
          </div>
        )}
        <button
          style={{
            ...signOutBtn,
            justifyContent: isCompact ? 'center' : 'flex-start',
            padding: isCompact ? '10px 0' : '10px 12px',
          }}
          onClick={signOut}
          title={isCompact ? 'Sign out' : undefined}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--text)'
            e.currentTarget.style.background = 'var(--surface-2)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--muted)'
            e.currentTarget.style.background = 'transparent'
          }}
        >
          <LogOut size={16} strokeWidth={2} />
          {!isCompact && 'Sign out'}
        </button>
      </div>
    </aside>
  )
}
