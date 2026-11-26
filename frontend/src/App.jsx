import React, { useState, useEffect } from 'react'
import { useAuth, LoginPage, RegisterPage } from './auth'
import { Dashboard } from './Dashboard'
import { PlanReaderView } from './PlanReaderView'
import { InvitesView } from './InvitesView'

export default function App() {
  const { user, loading } = useAuth()
  const [view,   setView]   = useState('dashboard')
  const [params, setParams] = useState({})

  const navigate = (target, p = {}) => {
    setView(target)
    setParams(p)
    window.scrollTo(0, 0)
  }

  useEffect(() => {
    if (!loading && !user && view !== 'register') setView('login')
    if (!loading && user  && (view === 'login' || view === 'register')) setView('dashboard')
  }, [user, loading]) // eslint-disable-line

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 12, color: 'var(--text3)' }}>
      <span className="spinner spinner-lg" />
      Loading…
    </div>
  )

  if (!user) {
    if (view === 'register') return <RegisterPage onNavigate={navigate} />
    return <LoginPage onNavigate={navigate} />
  }

  switch (view) {
    case 'plan-reader':
      return <PlanReaderView key={params.id} projectId={params.id} onNavigate={navigate} />
    case 'invites':
      return <InvitesView onNavigate={navigate} />
    default:
      return <Dashboard onNavigate={navigate} />
  }
}
