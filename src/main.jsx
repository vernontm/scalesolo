import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { ThemeProvider } from './context/ThemeContext.jsx'
import { AuthProvider } from './context/AuthContext.jsx'
import { ProfileProvider } from './context/ProfileContext.jsx'
import { CreditsProvider } from './context/CreditsContext.jsx'
import { AgentProvider } from './context/AgentContext.jsx'
import { SpacesRunProvider } from './context/SpacesRunContext.jsx'
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <ProfileProvider>
            <CreditsProvider>
              <AgentProvider>
                <SpacesRunProvider>
                  <App />
                </SpacesRunProvider>
              </AgentProvider>
            </CreditsProvider>
          </ProfileProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
)
