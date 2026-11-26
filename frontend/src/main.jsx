import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { AuthProvider } from './auth'
import { PortalApp } from './Portal'

// An architect's link (/portal#key) opens the portal and nothing else: no login,
// and none of the team's pages.
const portal = window.location.pathname.replace(/\/+$/, '') === '/portal'

ReactDOM.createRoot(document.getElementById('root')).render(
  portal ? <PortalApp /> : <AuthProvider><App /></AuthProvider>
)
