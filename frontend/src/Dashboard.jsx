import React, { useState, useEffect } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { useAuth } from './auth'
import logo from './assets/mf-logo.jpeg'
import { IconRight, IconPlus } from './icons'

export function Topbar({ crumbs = [], onNavigate, right = null, active = 'projects', compact = false, crumbsRight = null }) {
  const { user, logout } = useAuth()
  const handleLogout = () => { logout(); onNavigate && onNavigate('login') }
  const initials = (user?.name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()
  return (
    <>
      <div id="topbar">
        <a className="logo" onClick={() => onNavigate && onNavigate('dashboard')}>
          <img src={logo} alt="MF Services" />
          <span className="logo-words"><strong>MF Services</strong><span>Door Schedules</span></span>
        </a>
        {user && onNavigate && !compact && (
          <nav className="topnav">
            <a className={active === 'projects' ? 'on' : ''} onClick={() => onNavigate('dashboard')}>Jobs</a>
            <a className={active === 'products' ? 'on' : ''} onClick={() => onNavigate('products')}>Products</a>
            <a className={active === 'sets' ? 'on' : ''} onClick={() => onNavigate('sets')}>Sets</a>
            <a className={active === 'accuracy' ? 'on' : ''} onClick={() => onNavigate('accuracy')}>Accuracy</a>
          </nav>
        )}
        <div className="spacer" />
        {right}
        {user && !compact && (
          <div className="userchip">
            <span className="avatar">{initials}</span>
            <span className="user-name">{user.name}<small>Estimator</small></span>
            <button className="btn btn-ghost btn-sm" onClick={handleLogout}>Sign out</button>
          </div>
        )}
      </div>
      {crumbs.length > 0 && (
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="crumb-sep"><IconRight size={14} /></span>}
              {c.onClick && i < crumbs.length - 1
                ? <a onClick={c.onClick}>{c.label}</a>
                : <span className="crumb-cur">{c.label}</span>}
            </React.Fragment>
          ))}
          {crumbsRight && <div className="crumbs-right">{crumbsRight}</div>}
        </nav>
      )}
    </>
  )
}

export function Dashboard({ onNavigate, q = '' }) {
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
            <h1>Jobs</h1>
            <p className="lede">{q ? `Jobs matching “${q}”.` : 'Every job in the office, in one list.'}</p>
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
                    A project is one job. For a door schedule, drop the architect's floor plans in and
                    the doors are read off them. For a device count, drop the services drawings in.
                  </p>
                  <button className="btn btn-primary" onClick={() => setShowNew(true)}>
                    Create your first project
                  </button>
                </div>
              ) : (
                <table className="ledger">
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Kind</th>
                      <th style={{ textAlign: 'right' }}>Drawings</th>
                      <th style={{ textAlign: 'right' }}>Doors</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.filter(p => !q || [p.name, p.client, p.site, p.quote_no].join(' ').toLowerCase().includes(q.toLowerCase())).map(p => (
                      <tr key={p.id} onClick={() => onNavigate(openView(p), { id: p.id })}>
                        <td>
                          <div className="proj-name">{p.name}</div>
                          <div className="proj-meta">
                            {[p.quote_no && `Quote ${p.quote_no}`, p.client, p.site].filter(Boolean).join(' · ') || 'No client / site set'}
                            {p.owner_name ? ` · ${p.owner_name}` : ''}
                          </div>
                        </td>
                        <td><span className={`badge ${p.kind === 'doors' ? 'badge-orange' : 'badge-grey'}`}>{p.kind === 'doors' ? 'Door schedule' : 'Device count'}</span></td>
                        <td className="count-num">{p.drawing_count}</td>
                        <td className="count-num">
                          {p.door_count || <span className="muted">—</span>}
                          {p.door_types_to_decide > 0 && <span className="of" title="Door types still to decide"> {p.door_types_to_decide} to decide</span>}
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
                <IconPlus size={16} /> New job
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
            onNavigate(openView(p), { id: p.id })
          }}
        />
      )}
    </>
  )
}

const openView = p => (p.kind === 'doors' ? 'job' : 'project')

function NewProjectModal({ onClose, onCreated }) {
  const [kind,   setKind]   = useState('doors')
  const [name,   setName]   = useState('')
  const [client, setClient] = useState('')
  const [site,   setSite]   = useState('')
  const [firm,   setFirm]   = useState('')
  const [quote,  setQuote]  = useState('')
  const [busy,   setBusy]   = useState(false)

  const submit = async e => {
    e.preventDefault()
    setBusy(true)
    try {
      const p = await apiFetch('/projects', {
        method: 'POST',
        body: JSON.stringify({ name, client, site, drawing_firm: firm, quote_no: quote, kind }),
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
        <h2>New job</h2>
        <form onSubmit={submit}>
          <div className="kind-pick">
            <button type="button" className={kind === 'doors' ? 'on' : ''} onClick={() => setKind('doors')}>
              <strong>Door schedule</strong>
              <span>Sets, doors and quantities, with the schedule PDF at the end. Plans can be read in if you have them.</span>
            </button>
            <button type="button" className={kind === 'symbols' ? 'on' : ''} onClick={() => setKind('symbols')}>
              <strong>Device count</strong>
              <span>Fire and security drawings in, symbol counts out.</span>
            </button>
          </div>
          <div className="form-group">
            <label>Project Name *</label>
            <input className="form-control" placeholder="e.g. Ford Site, Cork"
                   value={name} onChange={e => setName(e.target.value)} required />
          </div>
          <div className="form-grid" style={{ gridTemplateColumns: kind === 'doors' ? '1fr 140px' : '1fr' }}>
            <div className="form-group">
              <label>Client</label>
              <input className="form-control" placeholder="e.g. Glenveagh Homes"
                     value={client} onChange={e => setClient(e.target.value)} />
            </div>
            {kind === 'doors' && (
              <div className="form-group">
                <label>Quote no</label>
                <input className="form-control" placeholder="33301" value={quote} onChange={e => setQuote(e.target.value)} />
              </div>
            )}
          </div>
          <div className="form-group">
            <label>Site / Address</label>
            <input className="form-control" placeholder="e.g. Centre Park Road, Cork"
                   value={site} onChange={e => setSite(e.target.value)} />
          </div>
          {kind === 'symbols' && (
            <div className="form-group">
              <label>
                Drawing Firm{' '}
                <span style={{ color: 'var(--text3)', fontWeight: 400 }}>
                  (optional, improves detection for this firm's drawing style)
                </span>
              </label>
              <input className="form-control" placeholder="e.g. O'Mahony Pike, EDC Engineers"
                     value={firm} onChange={e => setFirm(e.target.value)} />
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <span className="spinner" /> : 'Create job'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
