import React, { useState, useEffect, useRef } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'

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
  const [busy,      setBusy]      = useState('')        // 'import' | 'rescan' | 'apply'
  const fileRef = useRef()

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

  const setDoorOverride = async (d, value) => {
    const body = { ref: d.ref, floor: d.floor, handed: d.handed, door_type_id: d.door_type_id,
                   set_id: value === '' ? null : Number(value), note: d.note }
    try {
      await apiFetch(`/doors/${d.id}`, { method: 'PUT', body: JSON.stringify(body) })
      await loadDoors(d.door_type_id); const s = await apiFetch(`/projects/${projectId}/doors/summary`); setSummary(s)
    } catch (err) { showToast(err.message, 'error') }
  }

  const removeDoor = async d => {
    if (!confirm(`Remove door ${d.ref}?${d.source === 'plan' ? ' It will come back if the plans are rescanned.' : ''}`)) return
    await apiFetch(`/doors/${d.id}`, { method: 'DELETE' })
    await load(); loadDoors(d.door_type_id)
  }

  const addDoor = async (t, ref, floor) => {
    try {
      await apiFetch(`/projects/${projectId}/doors`, { method: 'POST', body: JSON.stringify({ ref, floor, door_type_id: t.id }) })
      await load(); loadDoors(t.id)
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

  const crumbs = [
    { label: 'Projects', onClick: () => onNavigate('dashboard') },
    { label: project?.name || '…', onClick: () => onNavigate('project', { id: projectId }) },
    { label: 'Doors' },
  ]
  if (!summary) return <><Topbar crumbs={crumbs} onNavigate={onNavigate} /><div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div></>

  const types = summary.door_types
  const decided = summary.assigned + summary.excluded
  const nothing = summary.doors === 0 && types.length === 0

  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} />
      <div className="page-wrap">
        <div className="page-header">
          <div>
            <h1>Doors</h1>
            <p className="lede">
              {nothing ? 'Door tags are read off the plans as they are uploaded.'
                : `${summary.doors} doors on ${summary.plans} plan${summary.plans !== 1 ? 's' : ''}, ${types.length} door type${types.length !== 1 ? 's' : ''}. Pick a set for each type; every door of that type gets it.`}
            </p>
          </div>
          <div className="spacer" />
          <div className="actions">
            <button className="btn" onClick={() => fileRef.current.click()} disabled={busy === 'import'}>
              {busy === 'import' ? <><span className="spinner" /> Importing…</> : 'Import door schedule'}
            </button>
            <input ref={fileRef} type="file" accept=".xlsx,.xlsm" style={{ display: 'none' }}
                   onChange={e => { importSchedule(e.target.files[0]); e.target.value = '' }} />
            <button className="btn" onClick={rescan} disabled={busy === 'rescan'}>{busy === 'rescan' ? <><span className="spinner" /> Reading…</> : 'Rescan plans'}</button>
            <button className="btn btn-primary" onClick={() => setEditing({ ...EMPTY_TYPE })}>Add door type</button>
          </div>
        </div>

        {nothing ? (
          <div className="empty-state">
            <h2>No doors yet.</h2>
            <p>Upload the architect's GA plans on the project page and the door tags (DT-01, D01-001 …) are picked up automatically. The door schedule spreadsheet adds descriptions, sizes and fire ratings.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="btn btn-primary" onClick={() => onNavigate('project', { id: projectId })}>Go to drawings</button>
              <button className="btn" onClick={() => fileRef.current.click()}>Import door schedule</button>
            </div>
          </div>
        ) : (
          <>
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

            <table className="ledger door-table">
              <thead>
                <tr><th>Type</th><th>Description</th><th style={{ textAlign: 'right' }}>Doors</th><th>Where</th><th>Set</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
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
            {sets.length === 0 && (
              <p className="hint" style={{ marginTop: 10 }}>
                There are no hardware sets yet. <button className="link-btn" onClick={() => onNavigate('set', { id: 'new' })}>Create the first set</button> and it will appear in the Set column.
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
