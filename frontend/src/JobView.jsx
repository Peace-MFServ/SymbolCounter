import React, { useState, useEffect, useMemo, useRef } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'
import { Menu } from './ProjectView'
import { IconPlus, IconEdit, IconSave, IconBars, IconDoc, IconCheck, IconWarn, IconFile, IconRight, IconDoor, IconLayers, IconFolder, IconTrash } from './icons'

export const TYPE_NAMES = {
  '01': 'Hinges and pivots', '02': 'Door closers', '03': 'Locks and cylinders', '04': 'Door handles',
  '05': 'Signage', '06': 'Door protection', '07': 'Accessories', '': 'Other',
}
export const TYPE_ORDER = ['01', '02', '03', '04', '05', '06', '07', '']
export const money = v => (v == null ? '' : v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

/* Group a set's items under Intec's type headings, in order. */
export function groupItems(items) {
  const by = {}
  for (const it of items) (by[it.product_type || ''] ||= []).push(it)
  return TYPE_ORDER.filter(t => by[t]).map(t => ({ type: t, name: TYPE_NAMES[t], items: by[t] }))
}

export function JobView({ projectId, onNavigate }) {
  const [job,      setJob]      = useState(null)
  const [selected, setSelected] = useState(null)      // set id
  const [doors,    setDoors]    = useState([])        // doors of the selected set
  const [busy,     setBusy]     = useState('')
  const [details,  setDetails]  = useState(null)      // editable job details
  const [choosing, setChoosing] = useState(false)     // show the set chooser even when a set is selected

  const load = async () => {
    const j = await apiFetch(`/projects/${projectId}/job`)
    setJob(j)
    if (!details) setDetails({ name: j.name, client: j.client, site: j.site, quote_no: j.quote_no, rep: j.rep })
    const stillThere = j.sets.some(s => s.set.id === selected)
    if (!stillThere) setSelected(j.sets[0]?.set.id ?? null)
  }
  useEffect(() => { load() }, [projectId])

  const current = useMemo(() => job?.sets.find(s => s.set.id === selected) || null, [job, selected])

  useEffect(() => {
    if (!current) { setDoors([]); return }
    apiFetch(`/projects/${projectId}/doors`).then(ds => {
      setDoors((ds || []).filter(d => d.effective_set_id === current.set.id))
    })
  }, [current?.set.id, job])

  const addSet = async sid => {
    setChoosing(false)
    try { await apiFetch(`/projects/${projectId}/sets/${sid}/add`, { method: 'POST' }); await load(); setSelected(Number(sid)) }
    catch (err) { showToast(err.message, 'error') }
  }
  const removeSet = async js => {
    const n = js.doors
    const what = js.set.is_standard ? `Take ${js.set.code} off this job?` : `Delete this job's copy of ${js.set.code}?`
    if (!confirm(n ? `${what} Its ${n} door${n !== 1 ? 's' : ''} will be left without a set.` : what)) return
    try { await apiFetch(`/projects/${projectId}/sets/${js.set.id}`, { method: 'DELETE' }); setSelected(null); await load() }
    catch (err) { showToast(err.message, 'error') }
  }
  const deleteFromLibrary = async s => {
    let usedOn = s.used_on || []
    try { usedOn = (await apiFetch(`/sets/${s.id}`)).used_on || [] } catch {}
    const others = usedOn.filter(u => u.project_id !== Number(projectId))
    const msg = others.length
      ? `${s.code} ${s.name} is also on ${others.map(u => u.project).join(', ')}.\n\nDelete it from the library anyway? Doors using it on every job will be left without a set.`
      : `Delete ${s.code} ${s.name} from the set library? Doors using it on this job will be left without a set.`
    if (!confirm(msg)) return
    try { await apiFetch(`/sets/${s.id}?force=true`, { method: 'DELETE' }); showToast('Set deleted', 'info'); setSelected(null); await load() }
    catch (err) { showToast(err.message, 'error') }
  }
  const editSet = async js => {
    const s = js.set
    if (s.is_standard) {
      const others = (await apiFetch(`/sets/${s.id}`)).used_on.filter(u => u.project_id !== Number(projectId))
      if (others.length) {
        const copy = confirm(`${s.code} is also used on ${others.map(u => u.project).join(', ')}.\n\nOK: make a copy for this job only and edit that.\nCancel: edit the standard set, which changes it on every job.`)
        if (copy) {
          const c = await apiFetch(`/projects/${projectId}/sets/${s.id}/copy-for-job`, { method: 'POST' })
          onNavigate('set', { id: c.id, projectId }); return
        }
      }
    }
    onNavigate('set', { id: s.id, projectId })
  }
  const copyForJob = async js => {
    try { const c = await apiFetch(`/projects/${projectId}/sets/${js.set.id}/copy-for-job`, { method: 'POST' }); showToast(`${c.code} is now this job's own copy`, 'success'); await load(); setSelected(c.id) }
    catch (err) { showToast(err.message, 'error') }
  }
  const removeDoor = async d => {
    try { await apiFetch(`/doors/${d.id}`, { method: 'DELETE' }); await load() }
    catch (err) { showToast(err.message, 'error') }
  }
  const saveDetails = async () => {
    setBusy('details')
    try {
      await apiFetch(`/projects/${projectId}`, { method: 'PUT', body: JSON.stringify({ ...details, description: '', drawing_firm: '', kind: job.kind }) })
      showToast('Job details saved', 'success'); await load()
    } catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }
  const copyJob = async () => {
    const name = prompt('Name for the new job', `${job.name} (copy)`)
    if (name === null) return
    try { const r = await apiFetch(`/projects/${projectId}/copy?name=${encodeURIComponent(name)}`, { method: 'POST' }); showToast('Job copied', 'success'); onNavigate('job', { id: r.id }) }
    catch (err) { showToast(err.message, 'error') }
  }

  const crumbs = [{ label: 'Jobs', onClick: () => onNavigate('dashboard') }, { label: job?.name || '…' }]
  if (!job || !details) return <><Topbar crumbs={crumbs} onNavigate={onNavigate} /><div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div></>

  const warn = job.checks.filter(c => c.level === 'warn').length

  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} crumbsRight={
        <>
          <Menu label="Job actions" items={[
            { label: 'Products by set', onClick: () => onNavigate('grid', { id: projectId }) },
            { label: 'Copy this job', onClick: copyJob },
            { label: `Plans and door types${job.plans ? ` (${job.plans})` : ''}`, onClick: () => onNavigate('doors', { id: projectId }) },
            { label: 'Set library', onClick: () => onNavigate('sets') },
          ]} />
          <button className="btn btn-primary" onClick={() => onNavigate('schedule', { id: projectId })} disabled={!job.sets.length}><IconFile size={16} /> Produce schedule</button>
        </>
      } />
      <div className="page-wrap wide">
        <div className="job-grid">
          {/* Left: sets on this job */}
          <aside className="job-sets card-panel">
            <h2 className="card-title"><IconLayers size={20} /> Sets on this job</h2>
            {job.sets.length === 0 && <p className="muted" style={{ fontSize: 13.5, marginBottom: 12 }}>None yet. Add one below.</p>}
            <ul className="set-list">
              {job.sets.map(js => (
                <li key={js.set.id} className={js.set.id === selected && !choosing ? 'on' : ''} onClick={() => { setSelected(js.set.id); setChoosing(false) }}>
                  <div className="set-list-code">{js.set.code}{!js.set.is_standard && <span className="tag">this job</span>}</div>
                  <div className="set-list-name">{js.set.name}</div>
                  <div className="set-list-meta">
                    <span>{js.doors} door{js.doors !== 1 ? 's' : ''}</span>
                    <span>{js.value != null ? money(js.value) : <span className="muted">no price</span>}</span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="set-add">
              <button className={'btn ' + (choosing || !current ? 'btn-primary' : 'btn-soft')} onClick={() => setChoosing(true)} disabled={!job.library.length}><IconPlus size={16} /> Add set</button>
            </div>
            <div className="side-block">
              <button className="link-btn strong" onClick={() => onNavigate('set', { id: 'new', projectId })}>New set for this job</button>
              <p className="muted">Build one from scratch. It stays on this job only.</p>
            </div>
            {job.types_to_decide > 0 && (
              <div className="rail-note">
                {job.types_to_decide} door type{job.types_to_decide !== 1 ? 's' : ''} from the plans still to decide.{' '}
                <button className="link-btn" onClick={() => onNavigate('doors', { id: projectId })}>Decide them</button>
              </div>
            )}
          </aside>

          {/* Middle: the selected set */}
          <main className="job-main">
            {choosing || !current ? (
              <SetChooser library={job.library} onJob={job.sets.map(js => js.set.id)} onPick={addSet} onDelete={deleteFromLibrary}
                          onCancel={current ? () => setChoosing(false) : null} />
            ) : (
              <SetPanel js={current} doors={doors} projectId={projectId}
                        onEdit={() => editSet(current)} onCopy={() => copyForJob(current)} onRemove={() => removeSet(current)} onDelete={() => deleteFromLibrary(current.set)}
                        onChanged={load} onRemoveDoor={removeDoor} />
            )}
          </main>

          {/* Right: totals, checks, details */}
          <aside className="job-rail">
            <div className="card-panel">
              <h2 className="card-title"><IconBars size={18} /> Job summary</h2>
              <div className="total-row"><span>Doors</span><strong>{job.doors_total}</strong></div>
              <div className="total-row"><span>Sets</span><strong>{job.sets.length}</strong></div>
              <div className="total-row"><span>Items</span><strong>{job.items}</strong></div>
              <div className="total-row last"><span>Value</span><strong>{job.value != null ? money(job.value) : <span className="muted" style={{ fontWeight: 400 }}>not all priced</span>}</strong></div>
              <div className={`checks-box ${warn ? 'warn' : 'ok'}`}>
                <div className="checks-head">{warn ? <IconWarn size={18} /> : <IconCheck size={18} />} Checks</div>
                <ul>{job.checks.map((c, i) => <li key={i}>{c.text}</li>)}</ul>
              </div>
            </div>
            <div className="card-panel">
              <h2 className="card-title"><IconDoc size={18} /> Job details</h2>
              <div className="form-group"><label>Job name</label><input className="form-control" value={details.name} onChange={e => setDetails({ ...details, name: e.target.value })} /></div>
              <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div className="form-group"><label>Quote no</label><input className="form-control" value={details.quote_no} onChange={e => setDetails({ ...details, quote_no: e.target.value })} /></div>
                <div className="form-group"><label>Rep</label><input className="form-control" value={details.rep} onChange={e => setDetails({ ...details, rep: e.target.value })} /></div>
              </div>
              <div className="form-group"><label>Client</label><input className="form-control" value={details.client} onChange={e => setDetails({ ...details, client: e.target.value })} /></div>
              <div className="form-group"><label>Site</label><input className="form-control" value={details.site} onChange={e => setDetails({ ...details, site: e.target.value })} /></div>
              <button className="btn btn-soft wide" onClick={saveDetails} disabled={busy === 'details'}>{busy === 'details' ? <span className="spinner" /> : <><IconSave size={16} /> Save details</>}</button>
            </div>
          </aside>
        </div>
      </div>
    </>
  )
}

/* The selected set: its products in type order, and its doors. */
/* ── Pick a set from the library ──────────────────────────────────────────── */
const isFire = s => !/\bNFR\b/i.test(s.name) && (s.fire_rated || /\bFR\b|fire rated/i.test(s.name))
const SET_FILTERS = [
  { key: 'bath',  label: 'Bathroom',   test: s => /bath|wc|toilet|washroom/i.test(s.name) },
  { key: 'fire',  label: 'Fire rated', test: isFire },
  { key: 'heavy', label: 'Heavy duty', test: s => /heavy|riser|plant/i.test(s.name) },
  { key: 'job',   label: 'This job',   test: s => !s.is_standard },
]
const setTag = s => {
  if (!s.is_standard) return { cls: 'job', label: 'This job' }
  if (isFire(s)) return { cls: 'fire', label: 'Fire rated' }
  if (/bath|wc|toilet|washroom/i.test(s.name)) return { cls: 'bath', label: 'Bathroom' }
  if (/heavy|riser|plant/i.test(s.name)) return { cls: 'heavy', label: 'Heavy duty' }
  return { cls: '', label: 'Standard' }
}

function SetChooser({ library, onJob, onPick, onCancel, onDelete }) {
  const [filter, setFilter] = useState('all')
  const filters = SET_FILTERS.filter(f => library.some(f.test))
  const shown = library.filter(s => {
    return filter === 'all' || SET_FILTERS.find(f => f.key === filter).test(s)
  })
  return (
    <div className="card-panel chooser">
      <div className="chooser-head">
        <span className="chooser-icon"><IconFolder size={22} /></span>
        <div>
          <h2>Choose a set</h2>
          <p>A set is the hardware that goes on one kind of door. Pick one from the library, then say how many doors get it.</p>
        </div>
        {onCancel && <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
      </div>
      <div className="chooser-filters" style={{ marginTop: 0 }}>
        <button className={'filter-chip' + (filter === 'all' ? ' on' : '')} onClick={() => setFilter('all')}>All</button>
        {filters.map(f => <button key={f.key} className={'filter-chip' + (filter === f.key ? ' on' : '')} onClick={() => setFilter(f.key)}>{f.label}</button>)}
        <span className="spacer" />
        <span className="muted">{shown.length} set{shown.length !== 1 ? 's' : ''}</span>
      </div>
      {library.length === 0 && <p className="muted" style={{ marginTop: 16 }}>The set library is empty. Import Evan's set file under Sets, or build a new set for this job.</p>}
      {library.length > 0 && shown.length === 0 && <p className="muted" style={{ marginTop: 16 }}>No sets match.</p>}
      <div className="lib-pick">
        {shown.map(s => {
          const tag = setTag(s)
          const added = onJob.includes(s.id)
          return (
            <button key={s.id} className={'lib-card' + (added ? ' added' : '')} onClick={() => !added && onPick(s.id)} disabled={added}>
              <div className="lib-card-top">
                <span className="lib-card-icon"><IconDoor size={18} /></span>
                <span className={'lib-tag ' + (added ? 'added' : tag.cls)}>{added ? 'On this job' : tag.label}</span>
              </div>
              <strong>{s.code}</strong>
              <span className="lib-card-name">{s.name}</span>
              <div className="lib-card-meta">
                <span>{s.product_count} product{s.product_count !== 1 ? 's' : ''}</span>
                <span className="sep" />
                <span>{s.value_per_door != null ? money(s.value_per_door) + ' / door' : 'No price yet'}</span>
                <span className="spacer" />
                {!added && s.copied_from && onDelete
                  ? <span className="lib-card-del" role="button" title="Delete this copy from the library"
                          onClick={e => { e.stopPropagation(); onDelete(s) }}><IconTrash size={14} /> Delete</span>
                  : !added && <IconRight size={16} />}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SetPanel({ js, doors, projectId, onEdit, onCopy, onRemove, onDelete, onChanged, onRemoveDoor }) {
  const s = js.set
  const groups = groupItems(s.items)
  const [prefix, setPrefix] = useState('D')
  const [sep,    setSep]    = useState('')
  const [count,  setCount]  = useState(1)
  const [start,  setStart]  = useState('')
  const [from,   setFrom]   = useState('')
  const [to,     setTo]     = useState('')
  const [floor,  setFloor]  = useState('')
  const [busy,   setBusy]   = useState('')
  const [showRange, setShowRange] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const lastRef = doors.length ? doors[doors.length - 1].ref : ''
  const pad = () => { const m = lastRef.match(/(\d+)$/); return m ? Math.max(2, m[1].length) : 2 }
  const nextNo = () => { const m = lastRef.match(/(\d+)$/); return m ? Number(m[1]) + 1 : 1 }

  // Guess the numbering from the last door on this set, e.g. "DT15.07" -> prefix DT15, sep "."
  useEffect(() => {
    const m = lastRef.match(/^(.*?)([.\-\/ ]?)(\d+)$/)
    if (m) { setPrefix(m[1]); setSep(m[2]) }
    setStart(String(nextNo()).padStart(pad(), '0'))
  }, [s.id, lastRef])

  const addQty = async e => {
    e.preventDefault(); setBusy('qty')
    try {
      const r = await apiFetch(`/projects/${projectId}/doors/add-quantity`, { method: 'POST',
        body: JSON.stringify({ set_id: s.id, count: Number(count) || 1, prefix, separator: sep, pad: Math.max(pad(), String(start).length),
                               start: start === '' ? null : Number(start), floor }) })
      showToast(`${r.added} door${r.added !== 1 ? 's' : ''} added, ${r.first} to ${r.last}`, 'success'); await onChanged()
    } catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }
  const addRange = async e => {
    e.preventDefault(); if (from === '' || to === '') return
    setBusy('range')
    try {
      const r = await apiFetch(`/projects/${projectId}/doors/add-range`, { method: 'POST',
        body: JSON.stringify({ set_id: s.id, prefix, separator: sep, from_no: Number(from), to_no: Number(to), pad: Math.max(pad(), String(to).length), floor }) })
      showToast(`${r.added} door${r.added !== 1 ? 's' : ''} added${r.skipped.length ? `, ${r.skipped.length} already there` : ''}`, 'success')
      setFrom(''); setTo(''); await onChanged()
    } catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }

  const shown = showAll ? doors : doors.slice(0, 40)
  const menuItems = [
    ...(s.is_standard ? [{ label: 'Copy for this job only', onClick: onCopy }] : []),
    { label: s.is_standard ? 'Remove from job' : 'Delete this copy', onClick: onRemove },
    ...(s.is_standard ? [{ label: 'Delete from set library', onClick: onDelete, danger: true }] : []),
  ]
  return (
    <div className="set-panel">
      <div className="set-panel-head">
        <div>
          <h1>{s.code} · {s.name}</h1>
          <div className="subline">
            {s.is_standard ? 'Standard set shared by every job' : 'This job’s own copy'}
            {s.fire_rated ? ' · fire rated' : ''}
            <span className="pill">{js.doors} door{js.doors !== 1 ? 's' : ''}</span>
            {js.from_types > 0 && <span className="pill">{js.from_types} type{js.from_types !== 1 ? 's' : ''} from plans</span>}
          </div>
        </div>
        <div className="spacer" />
        <div className="actions">
          <Menu label="Set actions" items={menuItems} />
          <button className="btn btn-primary" onClick={onEdit}><IconEdit size={16} /> Edit set</button>
        </div>
      </div>

      <div className="card-panel">
        <h2 className="card-title">Add doors</h2>
        <form onSubmit={addQty} className="add-doors-grid">
          <label>Quantity<input className="form-control" type="number" min="1" max="2000" value={count} onChange={e => setCount(e.target.value)} /></label>
          <label>Prefix<input className="form-control" value={prefix + sep} onChange={e => { const m = e.target.value.match(/^(.*?)([.\-\/ ]?)$/); setPrefix(m ? m[1] : e.target.value); setSep(m ? m[2] : '') }} placeholder="D" /></label>
          <label>Start number<input className="form-control" value={start} onChange={e => setStart(e.target.value.replace(/\D/g, ''))} placeholder="01" /></label>
          <label>Floor (optional)<input className="form-control" value={floor} onChange={e => setFloor(e.target.value)} placeholder="e.g. Ground" /></label>
          <button className="btn btn-primary" type="submit" disabled={busy === 'qty'}>{busy === 'qty' ? <span className="spinner" /> : <><IconPlus size={16} /> Add doors</>}</button>
        </form>
        <div className="add-range-row">
          {showRange ? (
            <form onSubmit={addRange} className="add-range-form">
              <span className="muted">Or add a range</span>
              <input className="form-control" type="number" value={from} onChange={e => setFrom(e.target.value)} placeholder="From" />
              <input className="form-control" type="number" value={to} onChange={e => setTo(e.target.value)} placeholder="To" />
              <button className="btn btn-soft" type="submit" disabled={busy === 'range' || from === '' || to === ''}>{busy === 'range' ? <span className="spinner" /> : 'Add range'}</button>
            </form>
          ) : (
            <button className="link-btn" onClick={() => setShowRange(true)}>Or add a range, e.g. 101 to 125</button>
          )}
        </div>
        {doors.length > 0 && (
          <div className="door-ref-list">
            {shown.map(d => (
              <span key={d.id} className="door-chip" title={[d.floor, d.source === 'plan' ? 'from the plan' : ''].filter(Boolean).join(' · ')}>
                {d.ref}{d.handed ? 'h' : ''}
                {d.source !== 'plan' && <button onClick={() => onRemoveDoor(d)} title="Remove this door">×</button>}
              </span>
            ))}
            {doors.length > 40 && !showAll && <button className="link-btn" onClick={() => setShowAll(true)}>and {doors.length - 40} more</button>}
          </div>
        )}
      </div>

      <div className="card-panel">
        <h2 className="card-title">Products in this set</h2>
        <table className="ledger set-products soft">
          <thead><tr><th>Code</th><th>Product</th><th className="num">Per door</th><th className="num">Price</th><th className="num">Value</th></tr></thead>
          <tbody>
            {groups.map(g => (
              <React.Fragment key={g.type}>
                <tr className="group-row"><td colSpan={5}>{g.name}</td></tr>
                {g.items.map(it => (
                  <tr key={it.product_id}>
                    <td className="mono">{it.sku}</td>
                    <td>{it.name}</td>
                    <td className="num">{it.qty}</td>
                    <td className="num">{it.price != null ? money(it.price) : <span className="muted">—</span>}</td>
                    <td className="num">{it.line_value != null ? money(it.line_value) : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
            {s.items.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 18 }}>No products in this set yet. Edit set to add them.</td></tr>}
          </tbody>
          <tfoot>
            <tr><td colSpan={3} /><td className="num">Set value</td><td className="num strong">{s.value_per_door != null ? money(s.value_per_door) : <span className="muted">not all priced</span>}</td></tr>
            <tr><td colSpan={3} /><td className="num">{js.doors} door{js.doors !== 1 ? 's' : ''} @ {s.value_per_door != null ? money(s.value_per_door) : '—'}</td><td className="num strong">{js.value != null ? money(js.value) : '—'}</td></tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
