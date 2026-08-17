import React, { useState, useEffect } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { useAuth } from './auth'

export function Topbar({ title, onBack, onNavigate }) {
  const { user, logout } = useAuth()
  const handleLogout = () => { logout(); onNavigate && onNavigate('login') }
  return (
    <div id="topbar">
      <div className="logo">MF <span>Symbol Counter</span></div>
      {onBack && (
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Back</button>
      )}
      {title && <span style={{ color: 'var(--text2)', fontSize: 13 }}>{title}</span>}
      <div className="spacer" />
      {user && (
        <>
          {onNavigate && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => onNavigate('templates')}
              title="Template Library"
            >
              🗂 Templates
            </button>
          )}
          <span className="user-chip">{user.name}</span>
          <button className="btn btn-ghost btn-sm" onClick={handleLogout}>Sign out</button>
        </>
      )}
    </div>
  )
}

export function Dashboard({ onNavigate }) {
  const [projects, setProjects] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [showNew,  setShowNew]  = useState(false)

  useEffect(() => {
    apiFetch('/projects')
      .then(p => { setProjects(p || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const deleteProject = async (e, id) => {
    e.stopPropagation()
    if (!confirm('Delete this project and all its drawings?')) return
    await apiFetch(`/projects/${id}`, { method: 'DELETE' })
    setProjects(ps => ps.filter(p => p.id !== id))
    showToast('Project deleted', 'info')
  }

  return (
    <>
      <Topbar onNavigate={onNavigate} />
      <div className="page-wrap">
        <div className="page-header">
          <div>
            <h1>Projects</h1>
            <p style={{ color: 'var(--text3)', fontSize: 13, marginTop: 4 }}>
              Manage your drawing sets and symbol counts
            </p>
          </div>
          <div className="spacer" />
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Project</button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><span className="spinner spinner-lg" /></div>
        ) : projects.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text3)' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📁</div>
            <p style={{ fontSize: 15, marginBottom: 8, color: 'var(--text2)' }}>No projects yet</p>
            <p style={{ marginBottom: 20 }}>Create a project to start uploading drawings</p>
            <button className="btn btn-primary" onClick={() => setShowNew(true)}>Create your first project</button>
          </div>
        ) : (
          <div className="projects-grid">
            {projects.map(p => (
              <div key={p.id} className="project-card"
                   onClick={() => onNavigate('project', { id: p.id })}>
                <h3>{p.name}</h3>
                <div className="meta">
                  {p.client && <span>{p.client}</span>}
                  {p.client && p.site && <span> · </span>}
                  {p.site && <span>{p.site}</span>}
                  {!p.client && !p.site && <span style={{ color: 'var(--text3)' }}>No client / site set</span>}
                </div>
                <div className="stats">
                  <div className="stat">
                    <div className="num">{p.drawing_count}</div>
                    <div className="lbl">Drawings</div>
                  </div>
                  {p.verified_count > 0 && (
                    <div className="stat">
                      <div className="num" style={{ color: '#4ade80' }}>{p.verified_count}</div>
                      <div className="lbl">Verified</div>
                    </div>
                  )}
                </div>
                {p.drawing_firm && (
                  <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text3)' }}>
                    🏢 {p.drawing_firm}
                  </div>
                )}
                <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                  <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }}
                          onClick={e => deleteProject(e, p.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showNew && (
        <NewProjectModal
          onClose={() => setShowNew(false)}
          onCreated={p => {
            setProjects(ps => [p, ...ps])
            setShowNew(false)
            onNavigate('project', { id: p.id })
          }}
        />
      )}
    </>
  )
}

function NewProjectModal({ onClose, onCreated }) {
  const [name,   setName]   = useState('')
  const [client, setClient] = useState('')
  const [site,   setSite]   = useState('')
  const [firm,   setFirm]   = useState('')
  const [busy,   setBusy]   = useState(false)

  const submit = async e => {
    e.preventDefault()
    setBusy(true)
    try {
      const p = await apiFetch('/projects', {
        method: 'POST',
        body: JSON.stringify({ name, client, site, drawing_firm: firm }),
      })
      showToast('Project created', 'success')
      onCreated(p)
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>New Project</h2>
        <form onSubmit={submit}>
          <div className="form-group">
            <label>Project Name *</label>
            <input className="form-control" placeholder="e.g. Ford Site, Cork"
                   value={name} onChange={e => setName(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Client</label>
            <input className="form-control" placeholder="e.g. Glenveagh Homes"
                   value={client} onChange={e => setClient(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Site / Address</label>
            <input className="form-control" placeholder="e.g. Centre Park Road, Cork"
                   value={site} onChange={e => setSite(e.target.value)} />
          </div>
          <div className="form-group">
            <label>
              Drawing Firm{' '}
              <span style={{ color: 'var(--text3)', fontWeight: 400 }}>
                (optional — improves detection for this firm's drawing style)
              </span>
            </label>
            <input className="form-control" placeholder="e.g. O'Mahony Pike, EDC Engineers"
                   value={firm} onChange={e => setFirm(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <span className="spinner" /> : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
