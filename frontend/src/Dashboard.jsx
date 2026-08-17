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
            <>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onNavigate('accuracy')}
                title="Detection accuracy scoreboard"
              >
                Accuracy
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onNavigate('templates')}
                title="Template library"
              >
                Templates
              </button>
            </>
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

  const totalDrawings = projects.reduce((s, p) => s + (p.drawing_count || 0), 0)
  const totalVerified = projects.reduce((s, p) => s + (p.verified_count || 0), 0)

  return (
    <>
      <Topbar onNavigate={onNavigate} />
      <div className="page-wrap">
        <div className="page-header">
          <div>
            <h1>Projects</h1>
            <p className="lede">Drawing sets and device counts for every job, in one ledger.</p>
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><span className="spinner spinner-lg" /></div>
        ) : (
          <div className="split">
            <div>
              {projects.length === 0 ? (
                <div className="empty-state">
                  <h2>No projects yet.</h2>
                  <p>
                    A project holds the floor plan drawings for one job — create one,
                    drop the PDFs in, and detection starts on its own.
                  </p>
                  <button className="btn btn-primary" onClick={() => setShowNew(true)}>
                    Create your first project
                  </button>
                </div>
              ) : (
                <table className="ledger">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Drawing firm</th>
                      <th style={{ textAlign: 'right' }}>Drawings</th>
                      <th style={{ textAlign: 'right' }}>Verified</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map(p => (
                      <tr key={p.id} onClick={() => onNavigate('project', { id: p.id })}>
                        <td>
                          <div className="proj-name">{p.name}</div>
                          <div className="proj-meta">
                            {[p.client, p.site].filter(Boolean).join(' · ') || 'No client / site set'}
                          </div>
                        </td>
                        <td style={{ fontSize: 13, color: 'var(--text2)' }}>{p.drawing_firm || '—'}</td>
                        <td className="count-num">{p.drawing_count}</td>
                        <td className="count-num" style={{ color: p.verified_count ? 'var(--ok)' : 'var(--text3)' }}>
                          {p.verified_count}
                        </td>
                        <td style={{ textAlign: 'right', width: 90 }}>
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }}
                                  onClick={e => deleteProject(e, p.id)}>Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <aside className="rail">
              <button className="btn btn-primary btn-lg" onClick={() => setShowNew(true)}>
                New Project
              </button>
              <div className="rail-panel">
                <h3>At a glance</h3>
                <div className="total-row"><span>Projects</span><strong>{projects.length}</strong></div>
                <div className="total-row"><span>Drawings</span><strong>{totalDrawings}</strong></div>
                <div className="total-row" style={{ borderBottom: 0 }}><span>Verified</span><strong>{totalVerified}</strong></div>
              </div>
              <div className="rail-panel">
                <h3>Tools</h3>
                <div className="rail-links">
                  <a onClick={() => onNavigate('accuracy')}>Accuracy scoreboard</a>
                  <a onClick={() => onNavigate('templates')}>Template library</a>
                </div>
              </div>
            </aside>
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
