import React, { useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'
import { Menu } from './ProjectView'

const STATUS = {
  decide:   ['badge-orange', 'To decide'],
  assigned: ['badge-green',  'Assigned'],
  excluded: ['badge-grey',   'Not ours'],
}
const EXCLUDED = '__excluded__'
const EMPTY_TYPE = { code: '', description: '', fire_rating: '', acoustic: '', width: '', height: '', spec_text: '', status: 'decide', set_id: null }

const sizeOf = t => (t.width && t.height ? `${t.width} x ${t.height}` : '')
const typeMeta = t => [t.fire_rating, t.acoustic, sizeOf(t)].filter(Boolean).join(' · ')

export function DoorsView({ projectId, onNavigate }) {
  const [project,   setProject]   = useState(null)
  const [summary,   setSummary]   = useState(null)
  const [sets,      setSets]      = useState([])
  const [open,      setOpen]      = useState(null)      // expanded door type id
  const [doors,     setDoors]     = useState({})        // type id -> [doors]
  const [editing,   setEditing]   = useState(null)      // door type (or EMPTY_TYPE) in the modal
  const [busy,      setBusy]      = useState('')        // 'import' | 'rescan' | 'apply' | 'upload'
  const [dragOver,  setDragOver]  = useState(false)
  const fileRef = useRef()
  const planRef = useRef()
  const pollRef = useRef()

  const load = async () => {
    const [p, s, hs] = await Promise.all([
      apiFetch(`/projects/${projectId}`),
      apiFetch(`/projects/${projectId}/doors/summary`),
      apiFetch('/sets'),
    ])
    setProject(p); setSummary(s); setSets(hs || [])
    if (open) loadDoors(open)
  }
  const loadDoors = async tid => {
    const ds = await apiFetch(`/projects/${projectId}/doors?type_id=${tid}`)
    setDoors(x => ({ ...x, [tid]: ds || [] }))
  }
  useEffect(() => { load() }, [projectId])

  // While a plan is still being read, refresh every few seconds.
  const scanning = !!summary?.plan_list?.some(p => ['uploaded', 'processing'].includes(p.status))
  useEffect(() => {
    if (!scanning) { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } ; return }
    if (pollRef.current) return
    pollRef.current = setInterval(async () => {
      const s = await apiFetch(`/projects/${projectId}/doors/summary`).catch(() => null)
      if (s) { setSummary(s); setDoors({}) }
    }, 2500)
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [scanning, projectId])

  const uploadPlans = useCallback(async files => {
    const pdfs = Array.from(files || []).filter(f => f.name.toLowerCase().endsWith('.pdf'))
    if (!pdfs.length) { showToast('Drop PDF floor plans', 'error'); return }
    setBusy('upload')
    let ok = 0
    for (const f of pdfs) {
      const form = new FormData(); form.append('file', f)
      try { await apiFetch(`/projects/${projectId}/drawings`, { method: 'POST', body: form }); ok++ }
      catch (err) { showToast(`${f.name}: ${err.message}`, 'error') }
    }
    if (ok) showToast(`${ok} plan${ok !== 1 ? 's' : ''} uploaded, reading door tags…`, 'success')
    setBusy('')
    await load()
  }, [projectId])

  const removePlan = async p => {
    if (!confirm(`Remove ${p.name} and its ${p.doors} door${p.doors !== 1 ? 's' : ''}?`)) return
    await apiFetch(`/drawings/${p.id}`, { method: 'DELETE' })
    setDoors({}); await load()
  }

  const toggle = tid => {
    if (open === tid) { setOpen(null); return }
    setOpen(tid)
    if (!doors[tid]) loadDoors(tid)
  }

  const saveType = async (t, patch) => {
    const body = { code: t.code, description: t.description, fire_rating: t.fire_rating, acoustic: t.acoustic,
                   width: t.width || null, height: t.height || null, spec_text: t.spec_text,
                   status: t.status, set_id: t.set_id, ...patch }
    try {
      await apiFetch(`/door-types/${t.id}`, { method: 'PUT', body: JSON.stringify(body) })
      await load()
    } catch (err) { showToast(err.message, 'error') }
  }

  const chooseSet = (t, value) => {
    if (value === EXCLUDED) return saveType(t, { status: 'excluded', set_id: null })
    if (value === '')       return saveType(t, { status: 'decide', set_id: null })
    return saveType(t, { status: 'assigned', set_id: Number(value) })
  }

  const setUntyped = async value => {
    const body = value === '' ? { untyped: true, clear_set: true } : { untyped: true, set_id: Number(value) }
    try {
      await apiFetch(`/projects/${projectId}/doors/bulk`, { method: 'PUT', body: JSON.stringify(body) })
      setDoors(x => ({ ...x, 0: undefined })); await load(); if (open === 0) loadDoors(0)
    } catch (err) { showToast(err.message, 'error') }
  }

  const setDoorOverride = async (d, value) => {
    const body = { ref: d.ref, floor: d.floor, handed: d.handed, door_type_id: d.door_type_id,
                   set_id: value === '' ? null : Number(value), note: d.note }
    try {
      await apiFetch(`/doors/${d.id}`, { method: 'PUT', body: JSON.stringify(body) })
      await loadDoors(d.door_type_id || 0); const s = await apiFetch(`/projects/${projectId}/doors/summary`); setSummary(s)
    } catch (err) { showToast(err.message, 'error') }
  }

  const removeDoor = async d => {
    if (!confirm(`Remove door ${d.ref}?${d.source === 'plan' ? ' It will come back if the plans are rescanned.' : ''}`)) return
    await apiFetch(`/doors/${d.id}`, { method: 'DELETE' })
    await load(); loadDoors(d.door_type_id || 0)
  }

  const addDoor = async (t, ref, floor) => {
    try {
      await apiFetch(`/projects/${projectId}/doors`, { method: 'POST', body: JSON.stringify({ ref, floor, door_type_id: t.id || null }) })
      await load(); loadDoors(t.id || 0)
    } catch (err) { showToast(err.message, 'error') }
  }

  const importSchedule = async file => {
    if (!file) return
    setBusy('import')
    try {
      const form = new FormData(); form.append('file', file)
      const r = await apiFetch(`/projects/${projectId}/doors/import-schedule`, { method: 'POST', body: form })
      const bits = [r.types_added && `${r.types_added} new type${r.types_added !== 1 ? 's' : ''}`,
                    r.types_updated && `${r.types_updated} filled in`,
                    r.doors_added && `${r.doors_added} door${r.doors_added !== 1 ? 's' : ''} added`].filter(Boolean)
      showToast(bits.length ? `Schedule imported: ${bits.join(', ')}` : 'Nothing new in that schedule', bits.length ? 'success' : 'info')
      await load()
    } catch (err) { showToast('Import failed: ' + err.message, 'error') }
    setBusy('')
  }

  const rescan = async () => {
    setBusy('rescan')
    try {
      const r = await apiFetch(`/projects/${projectId}/doors/rescan`, { method: 'POST' })
      showToast(`${r.doors} door tags read from ${r.plans} plan${r.plans !== 1 ? 's' : ''}`, 'success')
      setDoors({}); await load()
    } catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }

  const applyAll = async () => {
    setBusy('apply')
    try {
      const r = await apiFetch(`/projects/${projectId}/doors/apply-suggestions`, { method: 'POST' })
      showToast(`${r.applied} door type${r.applied !== 1 ? 's' : ''} assigned`, 'success')
      await load()
    } catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }

  const isDoorsProject = summary?.kind === 'doors'
  const crumbs = isDoorsProject
    ? [{ label: 'Projects', onClick: () => onNavigate('dashboard') }, { label: project?.name || '…', onClick: () => onNavigate('job', { id: projectId }) }, { label: 'Plans and door types' }]
    : [{ label: 'Projects', onClick: () => onNavigate('dashboard') },
       { label: project?.name || '…', onClick: () => onNavigate('project', { id: projectId }) },
       { label: 'Doors' }]
  if (!summary) return <><Topbar crumbs={crumbs} onNavigate={onNavigate} /><div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div></>

  const types = summary.door_types
  const decided = summary.assigned + summary.excluded
  const plans = summary.plan_list || []
  const nothing = summary.doors === 0 && types.length === 0 && plans.length === 0
  const dropProps = {
    onDragOver:  e => { e.preventDefault(); setDragOver(true) },
    onDragLeave: () => setDragOver(false),
    onDrop:      e => { e.preventDefault(); setDragOver(false); uploadPlans(e.dataTransfer.files) },
  }

  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} />
      <div className="page-wrap" {...dropProps}>
        <div className="page-header">
          <div>
            <h1>{isDoorsProject ? 'Plans and door types' : 'Doors'}</h1>
            <p className="lede">
              {isDoorsProject && [project?.quote_no && `Quote ${project.quote_no}`, project?.client, project?.site].filter(Boolean).join(' · ')}
              {isDoorsProject && summary.doors > 0 && ' · '}
              {nothing ? (isDoorsProject ? '' : 'Door tags are read off the plans as they are uploaded.')
                : `${summary.doors} doors on ${summary.plans} plan${summary.plans !== 1 ? 's' : ''}, ${types.length} door type${types.length !== 1 ? 's' : ''}.`}
            </p>
          </div>
          <div className="spacer" />
          <div className="actions">
            <Menu label="More" items={[
              { label: 'Import door schedule (Excel)', onClick: () => fileRef.current.click() },
              { label: 'Rescan plans', onClick: rescan },
              { label: 'Add a door type', onClick: () => setEditing({ ...EMPTY_TYPE }) },
            ]} />
            <input ref={fileRef} type="file" accept=".xlsx,.xlsm" style={{ display: 'none' }}
                   onChange={e => { importSchedule(e.target.files[0]); e.target.value = '' }} />
            <input ref={planRef} type="file" accept=".pdf" multiple style={{ display: 'none' }}
                   onChange={e => { uploadPlans(e.target.files); e.target.value = '' }} />
            <button className="btn" onClick={() => planRef.current.click()} disabled={busy === 'upload'}>
              {busy === 'upload' ? <><span className="spinner" /> Uploading…</> : 'Upload plans'}
            </button>
            {!nothing && (isDoorsProject
              ? <button className="btn btn-primary" onClick={() => onNavigate('job', { id: projectId })}>Back to job</button>
              : <button className="btn btn-primary" onClick={() => onNavigate('schedule', { id: projectId })}>Produce schedule</button>)}
          </div>
        </div>

        {nothing ? (
          <div className={`empty-state drop-zone${dragOver ? ' over' : ''}`} onClick={() => planRef.current.click()}>
            <h2>Step 1: drop the architect's floor plans here.</h2>
            <p>The door tags on them (DT-01, DT-02 …) are read in a few seconds and become the door list. Then you pick a hardware set for each kind of door, and the schedule comes out.</p>
            <button className="btn btn-primary" onClick={e => { e.stopPropagation(); planRef.current.click() }}>Upload plans</button>
          </div>
        ) : (
          <>
            {plans.length > 0 && (
              <div className="plans-strip">
                {plans.map(p => (
                  <div key={p.id} className={`plan-chip ${p.status}`} title={p.error || p.name}>
                    <span className="plan-name">{p.name}</span>
                    <span className="plan-doors">
                      {['uploaded', 'processing'].includes(p.status) ? <><span className="spinner" /> reading…</>
                        : p.status === 'error' ? 'failed' : `${p.doors} door${p.doors !== 1 ? 's' : ''}`}
                    </span>
                    <button className="plan-x" onClick={() => removePlan(p)} title="Remove this plan">×</button>
                  </div>
                ))}
                <div className={`plan-chip add${dragOver ? ' over' : ''}`} onClick={() => planRef.current.click()}>Drop more plans here</div>
              </div>
            )}

            <div className="pv-stats">
              <div className="pv-stat"><div className="num">{summary.doors}</div><div className="lbl">Doors</div></div>
              <div className="pv-stat"><div className="num">{types.length}</div><div className="lbl">Door types</div></div>
              <div className="pv-stat"><div className="num">{decided}<span className="of">/{types.length}</span></div><div className="lbl">Decided</div></div>
              <div className="pv-stat"><div className="num">{summary.assigned_doors}<span className="of">/{summary.doors}</span></div><div className="lbl">Doors with a set</div></div>
              {summary.untyped_doors > 0 && <div className="pv-stat"><div className="num">{summary.untyped_doors}</div><div className="lbl">No type</div></div>}
            </div>

            {summary.suggestions > 0 && (
              <div className="suggest-bar">
                <div>
                  <strong>{summary.suggestions} door type{summary.suggestions !== 1 ? 's' : ''} match{summary.suggestions === 1 ? 'es' : ''} sets used before.</strong>
                  <span className="muted"> Suggestions are marked in the table. Apply them all, or take them one at a time.</span>
                </div>
                <button className="btn btn-sm" onClick={applyAll} disabled={busy === 'apply'}>{busy === 'apply' ? <span className="spinner" /> : 'Apply all'}</button>
              </div>
            )}

            {(types.length > 0 || summary.untyped_doors > 0) && decided === 0 && summary.untyped_with_set === 0 && summary.sets_available > 0 && (
              <p className="step-hint">Step 2: for each kind of door below, choose the hardware set that goes on it. Every door of that kind gets the set.</p>
            )}
            {(types.length > 0 || summary.untyped_doors > 0) && summary.sets_available === 0 && (
              <div className="suggest-bar">
                <div><strong>There are no hardware sets yet, so there is nothing to choose.</strong>
                  <span className="muted"> Import an old Intec schedule to load the sets Evan already uses, or build one by hand.</span></div>
                <button className="btn btn-sm" onClick={() => onNavigate('sets', { importIntec: true })}>Import Intec schedule</button>
              </div>
            )}
            <table className="ledger door-table">
              <thead>
                <tr><th>Type</th><th>Description</th><th style={{ textAlign: 'right' }}>Doors</th><th>Where</th><th>Set</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {summary.untyped_doors > 0 && (() => {
                  const allSet = summary.untyped_with_set === summary.untyped_doors
                  const isOpen = open === 0
                  const fake = { id: 0, set_code: '' }
                  return (
                    <React.Fragment key="untyped">
                      <tr className={isOpen ? 'open' : ''}>
                        <td className="type-code muted">none</td>
                        <td>
                          <div className="dwg-name" style={{ fontSize: 15 }}>Doors with no type on the plan</div>
                          <div className="proj-meta">Numbered {summary.untyped_sample.slice(0, 3).join(', ')}{summary.untyped_sample.length > 3 ? ' …' : ''}. Give them all one set here, or open the list and set them one by one.</div>
                        </td>
                        <td className="count-num">{summary.untyped_doors}</td>
                        <td className="muted floors-cell">{summary.untyped_floors.map(f => `${f.floor} ${f.count}`).join(' · ') || '—'}</td>
                        <td className="set-cell" onClick={e => e.stopPropagation()}>
                          <select className="form-control set-select" value="" onChange={e => setUntyped(e.target.value)}>
                            <option value="">{allSet ? 'Change the set for all…' : summary.untyped_with_set ? `Set the rest (${summary.untyped_doors - summary.untyped_with_set})…` : 'Choose a set for all…'}</option>
                            {sets.map(s => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
                          </select>
                        </td>
                        <td>
                          {allSet ? <span className="badge badge-green">Assigned</span>
                            : summary.untyped_with_set ? <span className="badge badge-orange">{summary.untyped_with_set} of {summary.untyped_doors}</span>
                            : <span className="badge badge-orange">To decide</span>}
                        </td>
                        <td className="row-actions">
                          <button className="btn btn-ghost btn-sm" onClick={() => toggle(0)}>{isOpen ? 'Hide doors' : 'Doors'}</button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="sub-row"><td colSpan={7}>
                          <DoorList type={fake} doors={doors[0]} sets={sets} onOverride={setDoorOverride} onRemove={removeDoor} onAdd={addDoor} />
                        </td></tr>
                      )}
                    </React.Fragment>
                  )
                })()}
                {types.map(t => {
                  const [cls, label] = STATUS[t.status] || ['badge-grey', t.status]
                  const isOpen = open === t.id
                  const selVal = t.status === 'excluded' ? EXCLUDED : (t.set_id ? String(t.set_id) : '')
                  return (
                    <React.Fragment key={t.id}>
                      <tr className={isOpen ? 'open' : ''} onClick={() => setEditing(t)}>
                        <td className="type-code">{t.code}</td>
                        <td>
                          <div className="dwg-name" style={{ fontSize: 15 }}>{t.description || <span className="muted">No description yet</span>}</div>
                          {typeMeta(t) && <div className="proj-meta">{typeMeta(t)}</div>}
                        </td>
                        <td className="count-num">{t.door_count}{t.handed_count > 0 && <span className="of" title="Handed (opposite hand)"> {t.handed_count}h</span>}</td>
                        <td className="muted floors-cell">{t.floors.map(f => `${f.floor} ${f.count}`).join(' · ') || '—'}</td>
                        <td className="set-cell" onClick={e => e.stopPropagation()}>
                          <select className="form-control set-select" value={selVal} onChange={e => chooseSet(t, e.target.value)}>
                            <option value="">Choose a set…</option>
                            {sets.map(s => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
                            <option value={EXCLUDED}>Not ours (by others)</option>
                          </select>
                          {t.suggestion && t.status === 'decide' && (
                            <div className="sugg">
                              <span className="sugg-dot" />Suggested <strong>{t.suggestion.set_code}</strong> {t.suggestion.set_name}
                              <span className="muted"> · {t.suggestion.reason}</span>
                              <button className="link-btn" onClick={() => chooseSet(t, String(t.suggestion.set_id))}>Use it</button>
                            </div>
                          )}
                        </td>
                        <td><span className={`badge ${cls}`}>{label}</span></td>
                        <td className="row-actions">
                          <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); toggle(t.id) }}>{isOpen ? 'Hide doors' : 'Doors'}</button>
                          <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); setEditing(t) }}>Edit</button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="sub-row"><td colSpan={7}>
                          <DoorList type={t} doors={doors[t.id]} sets={sets} onOverride={setDoorOverride} onRemove={removeDoor} onAdd={addDoor} />
                        </td></tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
            {sets.length === 0 && types.length > 0 && (
              <p className="hint" style={{ marginTop: 10 }}>
                Or <button className="link-btn" onClick={() => onNavigate('set', { id: 'new' })}>build a set by hand</button> and it will appear in the Set column.
              </p>
            )}
          </>
        )}
      </div>

      {editing && (
        <TypeModal type={editing} projectId={projectId} onClose={() => setEditing(null)}
                   onSaved={() => { setEditing(null); load() }} />
      )}
    </>
  )
}

function DoorList({ type, doors, sets, onOverride, onRemove, onAdd }) {
  const [ref, setRef] = useState('')
  const [floor, setFloor] = useState('')
  if (!doors) return <div style={{ padding: 16 }}><span className="spinner" /></div>
  return (
    <div className="door-sub">
      <table className="ledger">
        <thead><tr><th>Door</th><th>Floor</th><th>Hand</th><th>From</th><th>Set</th><th></th></tr></thead>
        <tbody>
          {doors.map(d => (
            <tr key={d.id}>
              <td className="mono">{d.ref}</td>
              <td>{d.floor || <span className="muted">—</span>}</td>
              <td className="muted">{d.handed ? 'Handed' : ''}</td>
              <td className="muted" style={{ fontSize: 13 }}>{d.source === 'plan' ? d.drawing || 'Plan' : d.source === 'schedule' ? 'Door schedule' : 'Typed in'}{d.note ? ` · ${d.note}` : ''}</td>
              <td>
                <select className="form-control set-select small" value={d.set_id ? String(d.set_id) : ''} onChange={e => onOverride(d, e.target.value)}>
                  <option value="">{type.set_code ? `Same as type (${type.set_code})` : 'Same as type'}</option>
                  {sets.map(s => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
                </select>
              </td>
              <td className="row-actions"><button className="btn btn-ghost btn-sm danger" onClick={() => onRemove(d)}>Remove</button></td>
            </tr>
          ))}
          {doors.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 16 }}>No doors of this type yet.</td></tr>}
        </tbody>
      </table>
      <form className="add-door" onSubmit={e => { e.preventDefault(); if (!ref.trim()) return; onAdd(type, ref.trim(), floor.trim()); setRef(''); setFloor('') }}>
        <input className="form-control" placeholder="Door ref (e.g. G-01-12)" value={ref} onChange={e => setRef(e.target.value)} />
        <input className="form-control" placeholder="Floor" value={floor} onChange={e => setFloor(e.target.value)} />
        <button className="btn btn-sm" type="submit">Add a door</button>
        <span className="hint">For a door that is not tagged on the plans.</span>
      </form>
    </div>
  )
}

function TypeModal({ type, projectId, onClose, onSaved }) {
  const isNew = !type.id
  const [f, setF] = useState({ ...EMPTY_TYPE, ...type, width: type.width ?? '', height: type.height ?? '' })
  const [busy, setBusy] = useState(false)
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }))

  const save = async e => {
    e.preventDefault(); setBusy(true)
    try {
      const body = { code: f.code, description: f.description, fire_rating: f.fire_rating, acoustic: f.acoustic,
                     width: f.width === '' ? null : Number(f.width), height: f.height === '' ? null : Number(f.height),
                     spec_text: f.spec_text, status: f.status, set_id: f.set_id }
      if (isNew) await apiFetch(`/projects/${projectId}/door-types`, { method: 'POST', body: JSON.stringify(body) })
      else       await apiFetch(`/door-types/${type.id}`, { method: 'PUT', body: JSON.stringify(body) })
      showToast(isNew ? 'Door type added' : 'Door type saved', 'success'); onSaved()
    } catch (err) { showToast(err.message, 'error') }
    setBusy(false)
  }
  const remove = async () => {
    if (!confirm(`Remove door type ${type.code}?`)) return
    try { await apiFetch(`/door-types/${type.id}`, { method: 'DELETE' }); showToast('Door type removed', 'info'); onSaved() }
    catch (err) { showToast(err.message, 'error') }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 640 }}>
        <h2>{isNew ? 'Add door type' : `${type.code} ${type.description || ''}`}</h2>
        <form onSubmit={save}>
          <div className="form-grid" style={{ gridTemplateColumns: '140px 1fr' }}>
            <div className="form-group"><label>Code</label><input className="form-control" value={f.code} onChange={set('code')} placeholder="DT-01" required /></div>
            <div className="form-group"><label>Description</label><input className="form-control" value={f.description} onChange={set('description')} placeholder="Room Entrance Door" /></div>
          </div>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
            <div className="form-group"><label>Fire rating</label><input className="form-control" value={f.fire_rating} onChange={set('fire_rating')} placeholder="FD30s" /></div>
            <div className="form-group"><label>Acoustic</label><input className="form-control" value={f.acoustic} onChange={set('acoustic')} placeholder="37dB Rw" /></div>
            <div className="form-group"><label>Width</label><input className="form-control" type="number" value={f.width} onChange={set('width')} placeholder="mm" /></div>
            <div className="form-group"><label>Height</label><input className="form-control" type="number" value={f.height} onChange={set('height')} placeholder="mm" /></div>
          </div>
          <div className="form-group">
            <label>Ironmongery per the architect <span className="muted">(from the door schedule or spec)</span></label>
            <textarea className="form-control" rows={4} value={f.spec_text} onChange={set('spec_text')} />
          </div>
          <div className="modal-actions">
            {!isNew && <button type="button" className="btn btn-ghost danger" onClick={remove}>Remove</button>}
            <div className="spacer" />
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? <span className="spinner" /> : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
