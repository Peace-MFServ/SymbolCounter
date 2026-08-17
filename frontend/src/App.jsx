import React, { useState, useEffect } from 'react'
import { useAuth, LoginPage, RegisterPage } from './auth'
import { Dashboard } from './Dashboard'
import { ProjectView } from './ProjectView'
import { VerifyView } from './VerifyView'
import { TemplatesView } from './TemplatesView'

export default function App() {
  const { user, loading } = useAuth()
  const [view,   setView]   = useState('dashboard')
  const [params, setParams] = useState({})

  const navigate = (target, p = {}) => {
    setView(target)
    setParams(p)
  }

  // Redirect to login when not authed
  useEffect(() => {
    if (!loading && !user && view !== 'register') setView('login')
    if (!loading && user  && (view === 'login' || view === 'register')) setView('dashboard')
  }, [user, loading]) // eslint-disable-line

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
                  height: '100vh', gap: 12, color: 'var(--text3)' }}>
      <span className="spinner spinner-lg" />
      Loading…
    </div>
  )

  if (!user) {
    if (view === 'register') return <RegisterPage onNavigate={navigate} />
    return <LoginPage onNavigate={navigate} />
  }

  switch (view) {
    case 'project':
      return <ProjectView id={params.id} onNavigate={navigate} />
    case 'verify':
      return (
        <VerifyView
          drawingId={params.drawingId}
          projectId={params.projectId}
          symTypes={params.symTypes || []}
          onNavigate={navigate}
        />
      )
    case 'templates':
      return <TemplatesView onNavigate={navigate} />
    default:
      return <Dashboard onNavigate={navigate} />
  }
}
