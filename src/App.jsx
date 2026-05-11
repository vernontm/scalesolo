import { lazy, Suspense, useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Zap } from 'lucide-react'
import Sidebar from './components/Sidebar.jsx'
import Header from './components/Header.jsx'
// Eager: routes that the user is likely to land on immediately
// (auth + dashboard) or that are tiny stand-alones. Everything else
// loads on demand to keep the initial JS bundle lean.
import Login from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Placeholder from './pages/Placeholder.jsx'
import Landing from './pages/Landing.jsx'
import Pricing from './pages/Pricing.jsx'
import LandingPublic from './pages/LandingPublic.jsx'
import AuthCallback from './pages/AuthCallback.jsx'
import FormPublic from './pages/FormPublic.jsx'

// Lazy: heavy or rarely-visited app routes. Spaces alone is ~250KB
// (ReactFlow + node registry); admin pages are admin-only; Analytics +
// LandingPages aren't on the hot path for a freshly-signed-in user.
const Settings      = lazy(() => import('./pages/Settings.jsx'))
const Affiliate     = lazy(() => import('./pages/Affiliate.jsx'))
const Analytics     = lazy(() => import('./pages/Analytics.jsx'))
const Billing       = lazy(() => import('./pages/Billing.jsx'))
const Agent         = lazy(() => import('./pages/Agent.jsx'))
const Pipeline      = lazy(() => import('./pages/Pipeline.jsx'))
const Forms         = lazy(() => import('./pages/Forms.jsx'))
const Contacts      = lazy(() => import('./pages/Contacts.jsx'))
const Profiles      = lazy(() => import('./pages/Profiles.jsx'))
const Content       = lazy(() => import('./pages/Content.jsx'))
const Avatars       = lazy(() => import('./pages/Avatars.jsx'))
const LandingPages  = lazy(() => import('./pages/LandingPages.jsx'))
const Spaces        = lazy(() => import('./pages/Spaces.jsx'))
const Library       = lazy(() => import('./pages/Library.jsx'))
const Admin         = lazy(() => import('./pages/Admin.jsx'))

// GlobalAgent (bottom-right AI chat FAB) was removed. The bottom-right
// slot is now a Spaces-only workflow-guide toggle rendered inside
// Spaces.jsx so it can read templateGuide / guideHidden state directly.
import ErrorBoundary from './components/ErrorBoundary.jsx'
import ToastHost from './components/Toast.jsx'
import { useAuth } from './context/AuthContext.jsx'
import { useProfile } from './context/ProfileContext.jsx'

// Tiny fallback shown while a lazy route's chunk is fetching. Subtle
// enough that users don't notice on warm caches; visible enough on a
// cold load to confirm something's happening.
function RouteFallback() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 80, color: 'var(--muted)' }}>
      <span className="spinner" />
    </div>
  )
}

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
  // Profile-switch full remount. When the active brand profile
  // changes, every page mounted in <Routes> can hold stale state
  // pinned to the previous profile (e.g. fetched avatars, canvas
  // nodes still referencing the old profile's media). Wrapping
  // <Routes> in a key on the profile id makes React unmount the
  // entire route subtree on change and remount it fresh — every
  // useState resets, every useEffect re-fires with the new profile.
  // Cheap to do because route components were already lazy-loaded
  // chunks so the remount has no JS load cost.
  const { selectedProfileId } = useProfile()

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
          <Suspense fallback={<RouteFallback />}>
          {/* Profile-keyed Routes: see the comment near useProfile()
              above. The key change unmounts the previous page tree
              completely so stale per-profile state can't leak across
              brand switches. Fallback key 'no-profile' keeps the
              initial render stable while ProfileContext loads. */}
          <Routes key={selectedProfileId || 'no-profile'}>
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
            <Route path="/affiliate" element={<Affiliate />} />
            {/* Beta-gated routes. The pages still mount when reached
                directly (?beta=1 stickies the localStorage flag the
                sidebar reads) so existing deep links keep working —
                they're only hidden from the nav by default. */}
            <Route path="/email"     element={<Placeholder title="Email engine" hint="Composer, sequences, deliverability. Native sending lands in Milestone 4." />} />
            <Route path="/contacts"  element={<Contacts />} />
            <Route path="/pipeline"  element={<Pipeline />} />
            <Route path="/landing"   element={<LandingPages />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/agent"     element={<Agent />} />
            {/* Admin routes — gated client-side by AdminGate inside
                <Admin/>. Service-role API endpoints under /api/admin/*
                also gate via requireAdmin() server-side. */}
            <Route path="/admin/*"   element={<Admin />} />
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
          </Suspense>
        </main>
      </div>
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
