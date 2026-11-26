import React, { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch } from './api'
import { showToast } from './toast'
import { useAuth } from './auth'
import logo from './assets/mf-logo.jpeg'
import { IconRight, IconPlus, IconSearch, IconBars } from './icons'
import { useLeaveGuard } from './unsaved'
import { useConfirm } from './confirm'

export function Topbar({ crumbs = [], onNavigate, right = null, active = 'jobs', compact = false, crumbsRight = null }) {
  const { user, logout } = useAuth()
  const handleLogout = () => { logout(); onNavigate && onNavigate('login') }
  const initials = (user?.name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()
  return (
    <>
      <div id="topbar">
        <a className="logo" onClick={() => onNavigate && onNavigate('dashboard')}>
          <img src={logo} alt="MF Services" />
          <span className="logo-words"><strong>MF Services</strong><span>Door Reader</span></span>
        </a>
        {user && onNavigate && !compact && (
          <nav className="topnav">
            <a className={active === 'jobs' ? 'on' : ''} onClick={() => onNavigate('dashboard')}>Jobs</a>
            <a className={active === 'invites' ? 'on' : ''} onClick={() => onNavigate('invites')}>Architect links</a>
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

/* Time against the clock an architect was promised: "31h left", "Overdue by 3h". */
export function clockOf(p, now = Date.now()) {
  if (!p.due_at || p.stage === 'checked') return null
  const h = (new Date(p.due_at).getTime() - now) / 3600000
  if (h < 0) return { text: `Overdue by ${fmtHours(-h)}`, cls: 'late' }
  return { text: `${fmtHours(h)} left`, cls: h < 12 ? 'soon' : '' }
}
const fmtHours = h => (h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${Math.floor(h)}h` : `${Math.floor(h / 24)}d ${Math.floor(h % 24)}h`)
export const ago = iso => {
  if (!iso) return ''
  const m = (Date.now() - new Date(iso).getTime()) / 60000
  if (m < 1) return 'just now'
  if (m < 60) return `${Math.round(m)} min ago`
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`
  return new Date(iso).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })
}
const stageText = p => {
  if (p.kind === 'symbols') return { text: `${p.drawing_count || 0} drawing${p.drawing_count !== 1 ? 's' : ''}, ${p.verified_count || 0} checked`, cls: '' }
  if (p.stage === 'checked') return { text: `Checked${p.owner_name ? ` by ${p.owner_name}` : ''}`, cls: 'done' }
  if (p.source === 'portal' && !p.owner_id) return { text: 'Waiting', cls: 'wait' }
  if (p.source === 'portal') return { text: `${p.owner_name} has it`, cls: 'mine' }
  return { text: 'Made here', cls: '' }
}

export function Dashboard({ onNavigate }) {
  const { user } = useAuth()
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [wiping, setWiping] = useState(false)
  const [search, setSearch] = useState('')
  const [now, setNow] = useState(Date.now())
  const { ask, modal: confirmModal } = useConfirm()

  const load = () => apiFetch('/projects').then(p => setProjects(p || [])).catch(err => showToast(err.message, 'error')).finally(() => setLoading(false))
  useEffect(() => {
    load()
    // the clocks move, and new jobs come in while the page is open
    const t = setInterval(() => { setNow(Date.now()); load() }, 60000)
    return () => clearInterval(t)
  }, [])

  const incoming = useMemo(() => projects.filter(p => p.source === 'portal' && p.stage !== 'checked')
    .sort((a, b) => new Date(a.due_at) - new Date(b.due_at)), [projects])
  const shown = useMemo(() => {
    const n = search.trim().toLowerCase()
    return !n ? projects : projects.filter(p => [p.name, p.client, p.site, p.quote_no, p.owner_name].filter(Boolean).join(' ').toLowerCase().includes(n))
  }, [projects, search])

  const open = p => onNavigate(p.kind === 'symbols' ? 'project' : 'plan-reader', { id: p.id })
  const take = async p => {
    try {
      const t = await apiFetch(`/projects/${p.id}/take`, { method: 'POST' })
      setProjects(ps => ps.map(x => (x.id === p.id ? { ...x, ...t } : x)))
      open(t)
    } catch (err) { showToast(err.message, 'error'); load() }
  }
  const canDelete = p => !p.owner_id || p.owner_id === user?.id
  const deleteProject = async p => {
    const ok = await ask({ title: `Delete ${p.name}?`, body: 'Its plans and the doors confirmed on it go with it. This cannot be undone.', confirm: 'Delete job', danger: true })
    if (!ok) return
    try {
      await apiFetch(`/projects/${p.id}`, { method: 'DELETE' })
      setProjects(ps => ps.filter(x => x.id !== p.id))
      showToast(`${p.name} deleted`, 'info')
    } catch (err) { showToast(err.message, 'error') }
  }
  const late = incoming.filter(p => clockOf(p, now)?.cls === 'late').length
  const waiting = incoming.filter(p => !p.owner_id).length

  return (
    <>
      <Topbar onNavigate={onNavigate} />
      {confirmModal}
      <div className="page-wrap jobs-wrap">
        <div className="jobs-grid">
          <div className="jobs-main">
            <div className="jobs-head">
              <div>
                <h1>Jobs</h1>
                <p className="lede">Plans sent in by architects arrive in Incoming with the clock running. Take one, check its doors, mark it checked.</p>
              </div>
            </div>

            {!loading && (
              <div className="owner-card in-card">
                <div className="in-head">
                  <h2>Incoming</h2>
                  <span className="muted">{incoming.length ? `${incoming.length} to check${waiting ? `, ${waiting} not taken yet` : ''}` : 'Nothing waiting'}</span>
                </div>
                {incoming.length === 0 ? (
                  <p className="jobs-none">When an architect sends plans through their link, the job appears here.</p>
                ) : (
                  <div className="job-table-scroll">
                    <table className="job-table in-table">
                      <thead><tr><th>Project</th><th>Sent in</th><th>Time left</th><th className="num">Doors read</th><th className="num">Who</th></tr></thead>
                      <tbody>
                        {incoming.map(p => {
                          const c = clockOf(p, now)
                          return (
                            <tr key={p.id} {...rowOpen(() => open(p))}>
                              <td><div className="job-name">{p.name}</div><div className="job-meta">{[p.client, p.site].filter(Boolean).join(' · ')}</div></td>
                              <td className="muted">{ago(p.received_at)}</td>
                              <td>{c && <span className={`in-clock ${c.cls}`}>{c.text}</span>}</td>
                              <td className="num job-num">
                                {p.draft?.green != null ? <>{p.draft.green}{p.draft.amber > 0 && <span className="of"> {p.draft.amber} to look at</span>}
                                  {p.draft.unreadable > 0 && <span className="of"> {p.draft.unreadable} sheet{p.draft.unreadable !== 1 ? 's' : ''} cannot be read</span>}</> : <span className="muted">Reading...</span>}
                              </td>
                              <td className="num" onClick={e => e.stopPropagation()}>
                                {p.owner_id ? <span className="in-who">{p.owner_id === user?.id ? 'You' : p.owner_name}</span>
                                  : <button className="btn btn-sm btn-primary" onClick={() => take(p)}>Take it</button>}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <div className="jobs-controls">
              <h2 className="all-title">All jobs</h2>
              {projects.length > 0 && (
                <label className="jobs-search">
                  <IconSearch size={17} />
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search jobs, clients or who has them" />
                </label>
              )}
            </div>
            {loading ? (
              <div style={{ textAlign: 'center', padding: 60 }}><span className="spinner spinner-lg" /></div>
            ) : projects.length === 0 ? (
              <div className="empty-state">
                <h2>No jobs yet.</h2>
                <p>Send an architect a link, or make a job here and upload the plans yourself.</p>
                <button className="btn btn-primary" onClick={() => setShowNew(true)}>New job</button>
              </div>
            ) : shown.length === 0 ? (
              <div className="owner-card"><p className="jobs-none">No jobs match “{search}”.</p></div>
            ) : (
              <div className="owner-card">
                <div className="job-table-scroll">
                  <table className="job-table">
                    <colgroup><col style={{ width: '38%' }} /><col style={{ width: '14%' }} /><col style={{ width: '22%' }} /><col style={{ width: '12%' }} /><col /></colgroup>
                    <thead><tr><th>Job</th><th>Kind</th><th>Where it is</th><th className="num">Doors confirmed</th><th className="num">Actions</th></tr></thead>
                    <tbody>
                      {shown.map(p => {
                        const st = stageText(p)
                        return (
                          <tr key={p.id} {...rowOpen(() => open(p))}>
                            <td>
                              <div className="job-name">{p.name}</div>
                              <div className="job-meta">{[p.source === 'portal' ? 'Sent in by the architect' : null, p.client, p.site, p.quote_no && `Quote ${p.quote_no}`].filter(Boolean).join(' · ') || 'No client or site set'}</div>
                            </td>
                            <td><span className={`kind-pill ${p.kind === 'symbols' ? 'devices' : 'doors'}`}>{p.kind === 'symbols' ? 'Device count' : 'Doors'}</span></td>
                            <td><span className={`stage-pill ${st.cls}`}>{st.text}</span></td>
                            <td className="num job-num">{p.kind === 'symbols' ? <span className="muted">—</span> : p.door_count || <span className="muted">—</span>}</td>
                            <td className="num">
                              <RowMenu onOpen={() => open(p)} onDelete={canDelete(p) ? () => deleteProject(p) : null} />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <aside className="jobs-rail">
            <button className="btn btn-primary btn-lg jobs-new" onClick={() => onNavigate('invites')}>
              <IconPlus size={16} /> Send an architect a link
            </button>
            <button className="btn btn-lg jobs-new" onClick={() => setShowNew(true)}>New job</button>
            <div className="glance-card">
              <h3><IconBars size={18} /> At a glance</h3>
              <div className="glance-row"><span>To check</span><strong>{incoming.length}</strong></div>
              <div className="glance-row"><span>Not taken yet</span><strong>{waiting}</strong></div>
              <div className="glance-row"><span>Overdue</span><strong className={late ? 'warn-num' : ''}>{late}</strong></div>
              <div className="glance-row"><span>Jobs</span><strong>{projects.length}</strong></div>
            </div>
            {projects.length > 0 && (
              <div className="glance-card">
                <h3>Clean start</h3>
                <p className="muted clean-note">Delete every job, everyone's. Products, sets in the library and architect links are kept.</p>
                <button className="btn btn-sm danger-text" onClick={() => setWiping(true)}>Delete all jobs</button>
              </div>
            )}
            <div className="glance-card">
              <h3>Device counting</h3>
              <div className="rail-links">
                <a onClick={() => onNavigate('accuracy')}>Accuracy scoreboard</a>
                <a onClick={() => onNavigate('templates')}>Template library</a>
              </div>
            </div>
          </aside>
        </div>
      </div>

      {wiping && <DeleteAll count={projects.length} onClose={() => setWiping(false)}
                            onDone={n => { setWiping(false); setProjects([]); showToast(`${n} job${n !== 1 ? 's' : ''} deleted`, 'info') }} />}
      {showNew && (
        <NewProjectModal onClose={() => setShowNew(false)}
                         onCreated={p => { setProjects(ps => [p, ...ps]); setShowNew(false); open(p) }} />
      )}
    </>
  )
}

function RowMenu({ onOpen, onDelete }) {
  const [at, setAt] = useState(null)
  const ref = useRef()
  const pop = useRef()
  useEffect(() => {
    if (!at) return
    const away = e => {
      const inside = (ref.current && ref.current.contains(e.target)) || (pop.current && pop.current.contains(e.target))
      if (!inside) setAt(null)
    }
    const key = e => { if (e.key === 'Escape') setAt(null) }
    const follow = () => { if (ref.current) setAt(place(ref.current)) }
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
             style={{ position: 'fixed', top: at.top, bottom: at.bottom, right: at.right }} onClick={e => e.stopPropagation()}>
          <button role="menuitem" onClick={pick(onOpen)}>Open</button>
          {onDelete && <button role="menuitem" className="danger" onClick={pick(onDelete)}>Delete</button>}
        </div>, document.body)}
    </div>
  )
}

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

// Where a row's menu opens: under its button, or above it near the bottom of the window
export const place = (el, height = 120) => {
  const r = el.getBoundingClientRect()
  const right = Math.max(8, window.innerWidth - r.right)
  if (r.bottom + 4 + height > window.innerHeight && r.top - 4 - height > 0)
    return { top: 'auto', bottom: window.innerHeight - r.top + 4, right }
  return { top: r.bottom + 4, bottom: 'auto', right }
}

function NewProjectModal({ onClose, onCreated }) {
  const [kind, setKind] = useState('doors')
  const [firm, setFirm] = useState('')
  const [name, setName] = useState('')
  const [client, setClient] = useState('')
  const [site, setSite] = useState('')
  const [quote, setQuote] = useState('')
  const [busy, setBusy] = useState(false)
  const typed = !!(name || client || site || quote || firm)

  const submit = async e => {
    e?.preventDefault?.()
    setBusy(true)
    let ok = true
    try {
      const p = await apiFetch('/projects', { method: 'POST', body: JSON.stringify({ name, client, site, quote_no: quote, kind, drawing_firm: firm }) })
      onCreated(p)
    } catch (err) { showToast(err.message, 'error'); ok = false }
    finally { setBusy(false) }
    return ok
  }
  const { guard, modal: leaveModal } = useLeaveGuard({ dirty: typed, onSave: submit, what: 'new job' })
  const close = guard(onClose)

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && close()}>
      {leaveModal}
      <div className="modal new-job-modal">
        <h2>New job</h2>
        <p className="muted" style={{ margin: '6px 0 18px' }}>For plans or drawings you already have. You upload them on the next page.</p>
        <form onSubmit={submit}>
          <div className="kind-pick two">
            <button type="button" className={kind === 'doors' ? 'on' : ''} onClick={() => setKind('doors')}>
              <strong>Doors from plans</strong>
              <span>Floor plans in, every door read, checked and given its set.</span>
            </button>
            <button type="button" className={kind === 'symbols' ? 'on' : ''} onClick={() => setKind('symbols')}>
              <strong>Device count</strong>
              <span>Fire and security drawings in, symbol counts out.</span>
            </button>
          </div>
          <div className="form-group">
            <label>Project name *</label>
            <input className="form-control" placeholder="e.g. Ford Site, Cork" value={name} onChange={e => setName(e.target.value)} required autoFocus />
          </div>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 140px' }}>
            <div className="form-group">
              <label>Client</label>
              <input className="form-control" placeholder="e.g. Glenveagh Homes" value={client} onChange={e => setClient(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Quote no</label>
              <input className="form-control" placeholder="33301" value={quote} onChange={e => setQuote(e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label>Site / address</label>
            <input className="form-control" placeholder="e.g. Centre Park Road, Cork" value={site} onChange={e => setSite(e.target.value)} />
          </div>
          {kind === 'symbols' && (
            <div className="form-group">
              <label>Drawing firm <span style={{ color: 'var(--text3)', fontWeight: 400 }}>(optional, improves detection for this firm's drawing style)</span></label>
              <input className="form-control" placeholder="e.g. O'Mahony Pike, EDC Engineers" value={firm} onChange={e => setFirm(e.target.value)} />
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-ghost" onClick={close}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? <span className="spinner" /> : 'Create job'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

/* Every job gone at once. It cannot be undone, so the words have to be typed. */
const CLEAN_START = 'DELETE ALL JOBS'
function DeleteAll({ count, onClose, onDone }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const ok = typed.trim().toUpperCase() === CLEAN_START
  const go = async e => {
    e.preventDefault()
    if (!ok || busy) return
    setBusy(true)
    try { const r = await apiFetch('/projects/delete-all', { method: 'POST', body: JSON.stringify({ confirm: typed }) }); onDone(r.deleted) }
    catch (err) { showToast(err.message, 'error'); setBusy(false) }
  }
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !busy && onClose()}>
      <form className="modal unsaved-modal" onSubmit={go}>
        <h2>Delete all {count} job{count !== 1 ? 's' : ''}?</h2>
        <p style={{ marginTop: 10 }}>Every job goes, whoever made it: its plans, drawings, doors and its own sets. This cannot be undone.</p>
        <p style={{ marginTop: 8 }}>Products, the sets library and architect links are kept.</p>
        <label className="pr-add-label" style={{ marginTop: 16 }}><span>Type <strong>{CLEAN_START}</strong> to confirm</span>
          <input className="form-control" autoFocus value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <div className="modal-actions">
          <button className="btn btn-danger" type="submit" disabled={!ok || busy}>{busy ? <span className="spinner" /> : 'Delete all jobs'}</button>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </div>
  )
}
