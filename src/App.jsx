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
import Agent from './pages/Agent.jsx'
import Pipeline from './pages/Pipeline.jsx'
import Forms from './pages/Forms.jsx'
import Contacts from './pages/Contacts.jsx'
import Profiles from './pages/Profiles.jsx'
import Content from './pages/Content.jsx'
import FormPublic from './pages/FormPublic.jsx'
import GlobalAgent from './components/GlobalAgent.jsx'
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
            <Route path="/content"   element={<Content />} />
            <Route path="/email"     element={<Placeholder title="Email engine" hint="Composer, sequences, deliverability. Native sending lands in Milestone 4." />} />
            <Route path="/contacts"  element={<Contacts />} />
            <Route path="/pipeline"  element={<Pipeline />} />
            <Route path="/forms"     element={<Forms />} />
            <Route path="/landing"   element={<Placeholder title="Landing pages" hint="Section-based page builder. Built in Milestone 7." />} />
            <Route path="/avatars"   element={<Placeholder title="Avatars & voice" hint="HeyGen avatars, ElevenLabs voice clones, render composer. Polished in Milestone 6." />} />
            <Route path="/analytics" element={<Placeholder title="Analytics" hint="Cross-platform performance with AI-narrated insights. Polished in Milestone 6." />} />
            <Route path="/agent"     element={<Agent />} />
            <Route path="/profiles"  element={<Profiles />} />
            <Route path="/billing"   element={<Billing />} />
            <Route path="/settings"  element={<Settings />} />
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
      <Routes>
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/f/:slug" element={<FormPublic />} />
        <Route path="*" element={<Login />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route path="/pricing" element={<Pricing />} />
      <Route path="/f/:slug" element={<FormPublic />} />
      <Route path="/*" element={<AppShell />} />
    </Routes>
  )
}
