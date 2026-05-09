import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Zap } from 'lucide-react'
import Sidebar from './components/Sidebar.jsx'
import Header from './components/Header.jsx'
import Login from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Placeholder from './pages/Placeholder.jsx'
import Settings from './pages/Settings.jsx'
import Pricing from './pages/Pricing.jsx'
import Billing from './pages/Billing.jsx'
import Agent from './pages/Agent.jsx'
import Pipeline from './pages/Pipeline.jsx'
import Forms from './pages/Forms.jsx'
import Contacts from './pages/Contacts.jsx'
import Profiles from './pages/Profiles.jsx'
import Content from './pages/Content.jsx'
import Avatars from './pages/Avatars.jsx'
import LandingPages from './pages/LandingPages.jsx'
import LandingPublic from './pages/LandingPublic.jsx'
import Spaces from './pages/Spaces.jsx'
import Library from './pages/Library.jsx'
import Landing from './pages/Landing.jsx'
import Admin from './pages/Admin.jsx'
import AuthCallback from './pages/AuthCallback.jsx'
import FormPublic from './pages/FormPublic.jsx'
import GlobalAgent from './components/GlobalAgent.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import ToastHost from './components/Toast.jsx'
import { useAuth } from './context/AuthContext.jsx'

const layoutStyle = { display: 'flex', minHeight: '100vh' }
// Desktop reserves the sidebar gutter; mobile (<900px) is overridden in
// global.css so the main content takes full width and the sidebar slides in.
const mainStyle = {
  flex: 1,
  marginLeft: 240,
  display: 'flex',
  flexDirection: 'column',
  minHeight: '100vh',
}
const contentStyle = {
  flex: 1,
  width: '100%',
  maxWidth: 1280,
  margin: '0 auto',
  padding: '32px 40px 56px',
}
const loadingStyle = {
  minHeight: '100vh',
  display: 'grid',
  placeItems: 'center',
  background: 'var(--bg)',
}
const loadingInner = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 14,
}
const loadingIcon = {
  width: 44,
  height: 44,
  borderRadius: 12,
  display: 'grid',
  placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff',
  boxShadow: '0 8px 22px rgba(239,68,68,0.3)',
}
const loadingText = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 14,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
}

function LoadingScreen() {
  return (
    <div style={loadingStyle}>
      <div style={loadingInner} className="fade-up">
        <div style={loadingIcon} className="pulse">
          <Zap size={22} strokeWidth={2.5} />
        </div>
        <div style={loadingText}>SCALESOLO</div>
      </div>
    </div>
  )
}

function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const { pathname } = useLocation()
  // Spaces gets a collapsed sidebar so the canvas has more room.
  const compact = pathname.startsWith('/spaces')

  // Sync a body class so CSS rules can target compact mode for the
  // builder overlay + main content margin.
  useEffect(() => {
    if (typeof document === 'undefined') return
    document.body.classList.toggle('compact-sidebar', compact)
    return () => { document.body.classList.remove('compact-sidebar') }
  }, [compact])

  const dynamicMain = { ...mainStyle, marginLeft: compact ? 60 : 240 }

  return (
    <div style={layoutStyle}>
      <Sidebar compact={compact} />
      {mobileOpen && (
        <>
          <div className="mobile-sidebar-overlay" onClick={() => setMobileOpen(false)} />
          <Sidebar mobile onClose={() => setMobileOpen(false)} />
        </>
      )}
      <div style={dynamicMain} className="app-main">
        <Header onOpenSidebar={() => setMobileOpen(true)} />
        <main style={contentStyle}>
          <Routes>
            <Route path="/auth/callback" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/spaces"    element={<Spaces />} />
            <Route path="/schedule"  element={<Content />} />
            <Route path="/content"   element={<Navigate to="/schedule" replace />} />
            <Route path="/avatars"   element={<Avatars />} />
            <Route path="/library"   element={<Library />} />
            <Route path="/profiles"  element={<Profiles />} />
            <Route path="/billing"   element={<Billing />} />
            <Route path="/settings"  element={<Settings />} />
            {/* Beta-gated routes. The pages still mount when reached
                directly (?beta=1 stickies the localStorage flag the
                sidebar reads) so existing deep links keep working —
                they're only hidden from the nav by default. */}
            <Route path="/email"     element={<Placeholder title="Email engine" hint="Composer, sequences, deliverability. Native sending lands in Milestone 4." />} />
            <Route path="/contacts"  element={<Contacts />} />
            <Route path="/pipeline"  element={<Pipeline />} />
            <Route path="/landing"   element={<LandingPages />} />
            <Route path="/analytics" element={<Placeholder title="Analytics" hint="Cross-platform performance with AI-narrated insights. Polished in Milestone 6." />} />
            <Route path="/agent"     element={<Agent />} />
            {/* Admin routes — gated client-side by AdminGate inside
                <Admin/>. Service-role API endpoints under /api/admin/*
                also gate via requireAdmin() server-side. */}
            <Route path="/admin/*"   element={<Admin />} />
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </main>
      </div>
      <GlobalAgent />
    </div>
  )
}

export default function App() {
  const { session, loading } = useAuth()

  if (loading) return <LoadingScreen />
  if (!session) {
    return (
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/f/:slug" element={<FormPublic />} />
          <Route path="/p/:slug" element={<LandingPublic />} />
          <Route path="*" element={<Login />} />
        </Routes>
        <ToastHost />
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/f/:slug" element={<FormPublic />} />
        <Route path="/*" element={<AppShell />} />
      </Routes>
      <ToastHost />
    </ErrorBoundary>
  )
}
