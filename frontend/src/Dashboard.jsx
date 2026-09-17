import React, { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch } from './api'
import { showToast } from './toast'
import { useAuth } from './auth'
import logo from './assets/mf-logo.jpeg'
import { IconRight, IconPlus, IconSearch, IconChevron, IconBars } from './icons'
import { useLeaveGuard } from './unsaved'
import { useConfirm } from './confirm'

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
  const { user } = useAuth()
  const [projects, setProjects] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [showNew,  setShowNew]  = useState(false)
  const [view,     setView]     = useState('owner')     // 'owner' | 'all'
  const [search,   setSearch]   = useState(q)
  const [collapsed, setCollapsed] = useState({})        // owner key -> hidden
  const { ask, modal: confirmModal } = useConfirm()

  useEffect(() => {
    apiFetch('/projects')
      .then(p => {
        const list = p || []
        setProjects(list)
        // a long list starts folded away so no one owner fills the page
        const n = {}
        for (const x of list) { const k = ownerKey(x); n[k] = (n[k] || 0) + 1 }
        setCollapsed(Object.fromEntries(Object.entries(n).filter(([, c]) => c > 10).map(([k]) => [k, true])))
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const duplicateProject = async p => {
    try {
      const c = await apiFetch(`/projects/${p.id}/duplicate`, { method: 'POST' })
      showToast(p.drawing_count ? `Copied as ${c.name}. Drawings are not copied.` : `Copied as ${c.name}`, 'success')
      // the copy sits straight under the job it came from, not off at the top
      setProjects(ps => {
        const i = ps.findIndex(x => x.id === p.id)
        return i < 0 ? [c, ...ps] : [...ps.slice(0, i + 1), c, ...ps.slice(i + 1)]
      })
    } catch (err) { showToast(err.message, 'error') }
  }

  const deleteProject = async p => {
    const ok = await ask({
      title: `Delete ${p.name}?`,
      body: p.drawing_count
        ? `Its ${p.drawing_count} drawing${p.drawing_count !== 1 ? 's' : ''} go with it. This cannot be undone.`
        : 'This cannot be undone.',
      confirm: 'Delete job', danger: true,
    })
    if (!ok) return
    try {
      await apiFetch(`/projects/${p.id}`, { method: 'DELETE' })
      setProjects(ps => ps.filter(x => x.id !== p.id))
      showToast(`${p.name} deleted`, 'info')
    } catch (err) { showToast(err.message, 'error') }
  }

  const shown = useMemo(() => {
    const n = search.trim().toLowerCase()
    if (!n) return projects
    return projects.filter(p => [p.name, p.client, p.site, p.quote_no, p.owner_name]
      .filter(Boolean).join(' ').toLowerCase().includes(n))
  }, [projects, search])

  // one card per owner, in the order the jobs come back
  const groups = useMemo(() => {
    const by = new Map()
    for (const p of shown) {
      const key = ownerKey(p)
      if (!by.has(key)) by.set(key, { key, name: p.owner_name || 'No owner', items: [] })
      by.get(key).items.push(p)
    }
    return [...by.values()]
  }, [shown])

  const open = p => onNavigate(openView(p), { id: p.id })
  const canDelete = p => !p.owner_id || p.owner_id === user?.id
  const drawings = shown.reduce((s, p) => s + (p.drawing_count || 0), 0)
  const verified = shown.reduce((s, p) => s + (p.verified_count || 0), 0)

  return (
    <>
      <Topbar onNavigate={onNavigate} />
      {confirmModal}
      <div className="page-wrap jobs-wrap">
        <div className="jobs-grid">
          <div className="jobs-main">
            <div className="jobs-head">
              <h1>Jobs</h1>
              <p className="lede">Every job in the office, in one list.</p>
            </div>

            {!loading && projects.length > 0 && (
              <div className="jobs-controls">
                <div className="seg">
                  <button className={view === 'owner' ? 'on' : ''} onClick={() => setView('owner')}>By owner</button>
                  <button className={view === 'all' ? 'on' : ''} onClick={() => setView('all')}>All projects</button>
                </div>
                <label className="jobs-search">
                  <IconSearch size={17} />
                  <input value={search} onChange={e => setSearch(e.target.value)}
                         placeholder="Search jobs, quotes, or clients..." />
                </label>
              </div>
            )}

            {loading ? (
              <div style={{ textAlign: 'center', padding: 60 }}><span className="spinner spinner-lg" /></div>
            ) : projects.length === 0 ? (
              <div className="empty-state">
                <h2>No projects yet.</h2>
                <p>Create a job to start its door schedule.</p>
                <button className="btn btn-primary" onClick={() => setShowNew(true)}>Create your first project</button>
              </div>
            ) : shown.length === 0 ? (
              <div className="owner-card"><p className="jobs-none">No jobs match “{search}”.</p></div>
            ) : view === 'all' ? (
              <div className="owner-card">
                <JobTable rows={shown} showOwner onOpen={open} canDelete={canDelete}
                          onDelete={deleteProject} onDuplicate={duplicateProject} />
              </div>
            ) : groups.map(g => (
              <div className="owner-card" key={g.key}>
                <div className="owner-head" onClick={() => setCollapsed(c => ({ ...c, [g.key]: !c[g.key] }))}>
                  <span className="owner-avatar" style={avatarStyle(g.name)}>{initials(g.name)}</span>
                  <div className="owner-who">
                    <strong>{g.name}</strong>
                    <span>{g.items.length} project{g.items.length !== 1 ? 's' : ''}</span>
                  </div>
                  <button className="owner-toggle" aria-label={collapsed[g.key] ? 'Show projects' : 'Hide projects'}>
                    <IconChevron size={18} style={{ transform: collapsed[g.key] ? 'none' : 'rotate(180deg)' }} />
                  </button>
                </div>
                {!collapsed[g.key] && (
                  <JobTable rows={g.items} onOpen={open} canDelete={canDelete}
                            onDelete={deleteProject} onDuplicate={duplicateProject} />
                )}
              </div>
            ))}
          </div>

          <aside className="jobs-rail">
            <button className="btn btn-primary btn-lg jobs-new" onClick={() => setShowNew(true)}>
              <IconPlus size={16} /> New job
            </button>
            <div className="glance-card">
              <h3><IconBars size={18} /> At a glance</h3>
              <div className="glance-row"><span>Projects</span><strong>{shown.length}</strong></div>
              <div className="glance-row"><span>Drawings</span><strong>{drawings}</strong></div>
              <div className="glance-row"><span>Verified</span><strong>{verified}</strong></div>
            </div>
            {projects.some(p => p.kind === 'symbols') && (
              <div className="glance-card">
                <h3>Device counting</h3>
                <div className="rail-links">
                  <a onClick={() => onNavigate('accuracy')}>Accuracy scoreboard</a>
                  <a onClick={() => onNavigate('templates')}>Template library</a>
                </div>
              </div>
            )}
          </aside>
        </div>
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

/* The project table that sits inside every owner card. */
function JobTable({ rows, showOwner = false, onOpen, canDelete, onDelete, onDuplicate }) {
  return (
    <div className="job-table-scroll">
      <table className="job-table">
        <colgroup><col style={{ width: '40%' }} /><col style={{ width: '20%' }} /><col style={{ width: '13%' }} />
                  <col style={{ width: '13%' }} /><col /></colgroup>
        <thead>
          <tr><th>Project</th><th>Kind</th><th className="num">Drawings</th><th className="num">Doors</th><th className="num">Actions</th></tr>
        </thead>
        <tbody>
          {rows.map(p => (
            <tr key={p.id} {...rowOpen(() => onOpen(p))}>
              <td>
                <div className="job-name">{p.name}</div>
                <div className="job-meta">
                  {[p.quote_no && `Quote ${p.quote_no}`, p.client, p.site, showOwner ? p.owner_name : '']
                    .filter(Boolean).join(' · ') || 'No client or site set'}
                </div>
              </td>
              <td><span className={`kind-pill ${p.kind === 'doors' ? 'doors' : 'devices'}`}>{p.kind === 'doors' ? 'Door schedule' : 'Device count'}</span></td>
              <td className="num job-num">{p.drawing_count ?? 0}</td>
              <td className="num job-num">
                {p.door_count || <span className="muted">—</span>}
                {p.door_types_to_decide > 0 && <span className="of" title="Door types still to decide"> {p.door_types_to_decide} to decide</span>}
              </td>
              <td className="num">
                <RowMenu onOpen={() => onOpen(p)}
                         onDuplicate={canDelete(p) ? () => onDuplicate(p) : null}
                         onDelete={canDelete(p) ? () => onDelete(p) : null} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RowMenu({ onOpen, onDuplicate, onDelete }) {
  const [at, setAt] = useState(null)          // where to draw it, or null when shut
  const ref = useRef()          // the dots button
  const pop = useRef()          // the menu, drawn on top of the page
  useEffect(() => {
    if (!at) return
    const away = e => {
      const inside = (ref.current && ref.current.contains(e.target)) || (pop.current && pop.current.contains(e.target))
      if (!inside) setAt(null)
    }
    const key = e => { if (e.key === 'Escape') setAt(null) }
    const follow = () => { if (ref.current) setAt(place(ref.current)) }   // stay with the row while the page moves
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key)
    window.addEventListener('scroll', follow, true); window.addEventListener('resize', follow)
    return () => {
      document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key)
      window.removeEventListener('scroll', follow, true); window.removeEventListener('resize', follow)
    }
  }, [!!at])
  const toggle = e => setAt(at ? null : place(e.currentTarget))
  const pick = fn => e => { e.stopPropagation(); setAt(null); fn() }
  return (
    <div className="row-menu" ref={ref} onClick={e => e.stopPropagation()}>
      <button className="row-dots" aria-label="Actions" onClick={toggle}>···</button>
      {at && createPortal(
        <div className="menu-list row-menu-pop" role="menu" ref={pop}
             style={{ position: 'fixed', top: at.top, right: at.right }} onClick={e => e.stopPropagation()}>
          <button role="menuitem" onClick={pick(onOpen)}>Open</button>
          {onDuplicate && <button role="menuitem" onClick={pick(onDuplicate)}>Duplicate</button>}
          {onDelete && <button role="menuitem" className="danger" onClick={pick(onDelete)}>Delete</button>}
        </div>, document.body)}
    </div>
  )
}

const ownerKey = p => String(p.owner_id ?? `n:${p.owner_name || ''}`)
/* A row opens on click, but not when the click was really someone picking out
   text to copy: a drag across it, or a double click on a word. */
let downAt = { x: 0, y: 0 }
export const rowOpen = fn => ({
  onMouseDown: e => { downAt = { x: e.clientX, y: e.clientY } },
  onClick: e => {
    if (e.detail > 1) return
    if (Math.abs(e.clientX - downAt.x) > 4 || Math.abs(e.clientY - downAt.y) > 4) return
    fn(e)
  },
})

export const place = el => {
  const r = el.getBoundingClientRect()
  return { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) }
}
const initials = name => (name || '?').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase()
const AVATARS = [['#DCE6F5', '#12366E'], ['#DCEBE1', '#134A2C'], ['#E8DDF2', '#3B2358'], ['#F6E2D3', '#5E2D0C'], ['#DFE7EC', '#1F3743']]
const avatarStyle = name => {
  let h = 0
  for (const ch of name || '') h = (h * 31 + ch.charCodeAt(0)) % 997
  const [bg, fg] = AVATARS[h % AVATARS.length]
  return { background: bg, color: fg }
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
  const typed = !!(name || client || site || firm || quote)

  const submit = async e => {
    e?.preventDefault?.()
    setBusy(true)
    let ok = true
    try {
      const p = await apiFetch('/projects', {
        method: 'POST',
        body: JSON.stringify({ name, client, site, drawing_firm: firm, quote_no: quote, kind }),
      })
      showToast('Project created', 'success')
      onCreated(p)
    } catch (err) {
      showToast(err.message, 'error')
      ok = false
    } finally {
      setBusy(false)
    }
    return ok
  }
  const { guard, modal: leaveModal } = useLeaveGuard({ dirty: typed, onSave: submit, what: 'new job' })
  const close = guard(onClose)

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && close()}>
      {leaveModal}
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
            <button type="button" className="btn btn-ghost" onClick={close}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <span className="spinner" /> : 'Create job'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
