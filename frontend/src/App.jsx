import React, { useState, useEffect } from 'react'
import { useAuth, LoginPage, RegisterPage } from './auth'
import { Dashboard } from './Dashboard'
import { PlanReaderView } from './PlanReaderView'
import { InvitesView } from './InvitesView'
import { ProjectView } from './ProjectView'
import { VerifyView } from './VerifyView'
import { TemplatesView } from './TemplatesView'
import { AccuracyView } from './AccuracyView'
import { ProductsView } from './ProductsView'
import { SetsView, SetEditor } from './SetsView'
import { MatchImagesView } from './MatchImagesView'
import { MatchDocumentsView } from './MatchDocumentsView'
import { ScheduleView } from './ScheduleView'
import { CostSummaryView } from './CostSummaryView'

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
      return <PlanReaderView key={params.id} projectId={params.id} setId={params.setId} newSet={params.newSet} onNavigate={navigate} />
    case 'cost':
      return <CostSummaryView projectId={params.id} onNavigate={navigate} />
    case 'schedule':
      return <ScheduleView projectId={params.id} onNavigate={navigate} />
    case 'invites':
      return <InvitesView onNavigate={navigate} />
    // device counting
    case 'project':
      return <ProjectView id={params.id} onNavigate={navigate} />
    case 'verify':
      return <VerifyView drawingId={params.drawingId} projectId={params.projectId} symTypes={params.symTypes || []} onNavigate={navigate} />
    case 'templates':
      return <TemplatesView onNavigate={navigate} />
    case 'accuracy':
      return <AccuracyView onNavigate={navigate} />
    // products and sets
    case 'products':
      return <ProductsView onNavigate={navigate} />
    case 'match-images':
      return <MatchImagesView onNavigate={navigate} />
    case 'match-documents':
      return <MatchDocumentsView onNavigate={navigate} />
    case 'sets':
      return <SetsView onNavigate={navigate} />
    case 'set':
      return <SetEditor id={params.id} projectId={params.projectId} fromDoors={!!params.fromDoors} onNavigate={navigate} />
    default:
      return <Dashboard onNavigate={navigate} />
  }
}
