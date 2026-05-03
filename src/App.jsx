import { Routes, Route, Navigate } from 'react-router-dom'
import { Zap } from 'lucide-react'
import Sidebar from './components/Sidebar.jsx'
import Header from './components/Header.jsx'
import Login from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Placeholder from './pages/Placeholder.jsx'
import Settings from './pages/Settings.jsx'
import Pricing from './pages/Pricing.jsx'
import Billing from './pages/Billing.jsx'
import { useAuth } from './context/AuthContext.jsx'

const layoutStyle = { display: 'flex', minHeight: '100vh' }
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
  return (
    <div style={layoutStyle}>
      <Sidebar />
      <div style={mainStyle}>
        <Header />
        <main style={contentStyle}>
          <Routes>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/content"   element={<Placeholder title="Content engine" hint="Avatar videos, carousels, scripts, scheduled posts. Built in Milestone 6." />} />
            <Route path="/email"     element={<Placeholder title="Email engine" hint="Composer, sequences, deliverability. Native sending lands in Milestone 4." />} />
            <Route path="/contacts"  element={<Placeholder title="Contacts" hint="Lists, segments, activity timeline. Expanded in Milestone 5." />} />
            <Route path="/pipeline"  element={<Placeholder title="Sales pipeline" hint="Drag-and-drop kanban for deals. Built in Milestone 5." />} />
            <Route path="/forms"     element={<Placeholder title="Forms & lead capture" hint="Drag-and-drop form builder. Built in Milestone 5." />} />
            <Route path="/landing"   element={<Placeholder title="Landing pages" hint="Section-based page builder. Built in Milestone 7." />} />
            <Route path="/avatars"   element={<Placeholder title="Avatars & voice" hint="HeyGen avatars, ElevenLabs voice clones, render composer. Polished in Milestone 6." />} />
            <Route path="/analytics" element={<Placeholder title="Analytics" hint="Cross-platform performance with AI-narrated insights. Polished in Milestone 6." />} />
            <Route path="/agent"     element={<Placeholder title="AI CEO" hint="Persistent memory and pinned facts land in Milestone 3." />} />
            <Route path="/profiles"  element={<Placeholder title="Brand profiles" hint="Multi-brand management. Functional now, polished alongside billing in Milestone 1." />} />
            <Route path="/billing"   element={<Billing />} />
            <Route path="/settings"  element={<Settings />} />
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
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
      <Routes>
        <Route path="/pricing" element={<Pricing />} />
        <Route path="*" element={<Login />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route path="/pricing" element={<Pricing />} />
      <Route path="/*" element={<AppShell />} />
    </Routes>
  )
}
