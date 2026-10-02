import React, { useState, useEffect, useMemo, useRef } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'
import { useAuth } from './auth'
import { useLeaveGuard } from './unsaved'
import { useConfirm, useChoice } from './confirm'
import { Menu } from './ProjectView'
import { IconPlus, IconEdit, IconSave, IconBars, IconDoc, IconCheck, IconWarn, IconFile, IconRight, IconDoor, IconLayers, IconFolder, IconTrash, IconLeft } from './icons'

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
  const { user } = useAuth()
  const [job,      setJob]      = useState(null)
  const [selected, setSelected] = useState(null)      // set id
  const [doors,    setDoors]    = useState([])        // doors of the selected set
  const [busy,     setBusy]     = useState('')
  const [details,  setDetails]  = useState(null)      // editable job details
  const [choosing, setChoosing] = useState(false)     // show the set chooser even when a set is selected
  const { ask, modal: askModal } = useConfirm()
  const { choose, modal: chooseModal } = useChoice()

  const load = async () => {
    const j = await apiFetch(`/projects/${projectId}/job`)
    setJob(j)
    if (!details) setDetails({ name: j.name, client: j.client, site: j.site, quote_no: j.quote_no, rep: j.rep, revision: j.revision })
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
    const ok = await ask({
      title: js.set.is_standard ? `Take ${js.set.code} off this job?` : `Delete this job's copy of ${js.set.code}?`,
      body: n ? `Its ${n} door${n !== 1 ? 's' : ''} will be left without a set.` : (js.set.is_standard ? 'It stays in the set library.' : ''),
      confirm: js.set.is_standard ? 'Take it off' : 'Delete copy', danger: true })
    if (!ok) return
    try { await apiFetch(`/projects/${projectId}/sets/${js.set.id}`, { method: 'DELETE' }); setSelected(null); await load() }
    catch (err) { showToast(err.message, 'error') }
  }
  const deleteFromLibrary = async s => {
    let usedOn = s.used_on || []
    try { usedOn = (await apiFetch(`/sets/${s.id}`)).used_on || [] } catch {}
    const others = usedOn.filter(u => u.project_id !== Number(projectId))
    const ok = await ask({
      title: `Delete ${s.code} from the set library?`,
      body: others.length
        ? `${s.code} ${s.name} is also on ${others.map(u => u.project).join(', ')}. Doors using it on every one of those jobs will be left without a set.`
        : `Doors using ${s.code} on this job will be left without a set.`,
      confirm: 'Delete from library', danger: true })
    if (!ok) return
    try { await apiFetch(`/sets/${s.id}?force=true`, { method: 'DELETE' }); showToast('Set deleted', 'info'); setSelected(null); await load() }
    catch (err) { showToast(err.message, 'error') }
  }
  // Editing a set from a job never touches the library: the set editor saves a
  // library set's changes as this job's own copy. The library MF sets are only
  // changed on the Sets page.
  const editSet = js => onNavigate('set', { id: js.set.id, projectId })
  const copyForJob = async js => {
    try { const c = await apiFetch(`/projects/${projectId}/sets/${js.set.id}/copy-for-job`, { method: 'POST' }); showToast(`${c.code} is now this job's own copy`, 'success'); await load(); setSelected(c.id) }
    catch (err) { showToast(err.message, 'error') }
  }
  const removeDoor = async d => {
    try { await apiFetch(`/doors/${d.id}`, { method: 'DELETE' }); showToast(`Door ${d.ref} removed`, 'info'); await load() }
    catch (err) { showToast(err.message, 'error') }
  }
  const putJob = fields => apiFetch(`/projects/${projectId}`, { method: 'PUT', body: JSON.stringify({
    name: job.name, client: job.client, site: job.site, quote_no: job.quote_no, rep: job.rep,
    description: '', drawing_firm: '', kind: job.kind, ...fields }) })
  const saveDetails = async () => {
    setBusy('details')
    let ok = true
    try {
      await putJob({ ...details, revision: Math.max(1, Number(details.revision) || 1) })
      showToast('Job details saved', 'success'); await load()
    } catch (err) { showToast(err.message, 'error'); ok = false }
    setBusy('')
    return ok
  }
  // the architect sent it back: the next revision, saved straight away
  const nextRevision = async () => {
    const r = (job.revision || 1) + 1
    setBusy('rev')
    try { await putJob({ revision: r }); setDetails(d => ({ ...d, revision: r })); showToast(`Now revision ${r}`, 'success'); await load() }
    catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }
  const copyJob = async () => {
    const name = prompt('Name for the new job', `${job.name} (copy)`)
    if (name === null) return
    try { const r = await apiFetch(`/projects/${projectId}/copy?name=${encodeURIComponent(name)}`, { method: 'POST' }); showToast('Job copied', 'success'); onNavigate('job', { id: r.id }) }
    catch (err) { showToast(err.message, 'error') }
  }

  const detailsDirty = !!job && !!details &&
    (['name', 'client', 'site', 'quote_no', 'rep'].some(k => (details[k] || '') !== (job[k] || '')) ||
     Number(details.revision) !== job.revision)
  const { guard, modal: leaveModal } = useLeaveGuard({ dirty: detailsDirty, onSave: saveDetails, what: 'job details' })
  const goNav = guard(onNavigate)

  const crumbs = [{ label: 'Jobs', onClick: () => goNav('dashboard') }, { label: job?.name || '…' }]
  if (!job || !details) return <><Topbar crumbs={crumbs} onNavigate={onNavigate} /><div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div></>

  const warn = job.checks.filter(c => c.level === 'warn').length
  const mine = !job.owner_id || job.owner_id === user?.id

  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={goNav} crumbsRight={
        <>
          <button className="btn btn-ghost back-jobs" onClick={() => goNav('dashboard')}><IconLeft size={16} /> Back to jobs</button>
          <Menu label="Job actions" items={[
            { label: 'Products by set', onClick: () => goNav('grid', { id: projectId }) },
            { label: 'Copy this job', onClick: guard(copyJob) },
            { label: `Plans and door types${job.plans ? ` (${job.plans})` : ''}`, onClick: () => goNav('doors', { id: projectId }) },
            { label: 'Set library', onClick: () => goNav('sets') },
          ]} />
          <button className="btn" onClick={() => goNav('door-summary', { id: projectId })} disabled={!job.sets.length}>{job.sets_only ? 'Set summary' : 'Door summary'}</button>
          <button className="btn" onClick={() => goNav('cost', { id: projectId })} disabled={!job.sets.length}>Cost summary</button>
          <button className="btn btn-primary" onClick={() => goNav('schedule', { id: projectId })} disabled={!job.sets.length}><IconFile size={16} /> Produce schedule</button>
        </>
      } />
      {leaveModal}
      {askModal}
      {chooseModal}
      <div className="page-wrap wide">
        {!mine && (
          <div className="suggest-bar readonly-bar">
            <div><strong>{job.owner_name}'s job.</strong><span className="muted"> You can look and produce the schedule. Only {job.owner_name} can change it.</span></div>
            <button className="btn" onClick={guard(copyJob)}>Copy this job</button>
          </div>
        )}
        <div className="job-grid">
          {/* Left: sets on this job */}
          <aside className="job-sets card-panel">
            <h2 className="card-title"><IconLayers size={20} /> Sets on this job</h2>
            {job.sets.length === 0 && <p className="muted" style={{ fontSize: 13.5, marginBottom: 12 }}>{mine ? 'None yet. Add one below.' : 'None yet.'}</p>}
            <ul className="set-list">
              {job.sets.map(js => (
                <li key={js.set.id} className={js.set.id === selected && !choosing ? 'on' : ''} onClick={() => { setSelected(js.set.id); setChoosing(false) }}>
                  <div className="set-list-code">{js.set.code}{!js.set.is_standard && <span className="tag">this job</span>}
                    {mine && <button className="set-list-x" title={js.set.is_standard ? `Take ${js.set.code} off this job` : `Delete this job's ${js.set.code}`}
                                     aria-label={`Remove ${js.set.code}`} onClick={e => { e.stopPropagation(); removeSet(js) }}><IconTrash size={15} /></button>}
                  </div>
                  <div className="set-list-name">{js.set.name}</div>
                  <div className="set-list-meta">
                    <span>{job.sets_only ? `Qty ${js.doors}` : `${js.doors} door${js.doors !== 1 ? 's' : ''}`}</span>
                    <span>{js.value != null ? money(js.value) : <span className="muted">no price</span>}</span>
                  </div>
                </li>
              ))}
            </ul>
            {mine && (
              <div className="set-add">
                <button className={'btn ' + (choosing || !current ? 'btn-primary' : 'btn-soft')} onClick={() => setChoosing(true)} disabled={!job.library.length}><IconPlus size={16} /> Add set</button>
              </div>
            )}
            {mine && (
              <div className="side-block">
                <button className="link-btn strong" onClick={() => goNav('set', { id: 'new', projectId })}>New set for this job</button>
                <p className="muted">Stays on this job only.</p>
              </div>
            )}
            {mine && job.types_to_decide > 0 && (
              <div className="rail-note">
                {job.types_to_decide} door type{job.types_to_decide !== 1 ? 's' : ''} from the plans still to decide.{' '}
                <button className="link-btn" onClick={() => goNav('doors', { id: projectId })}>Decide them</button>
              </div>
            )}
          </aside>

          {/* Middle: the selected set */}
          <main className="job-main">
            {!mine && !current ? (
              <div className="card-panel"><p className="muted" style={{ margin: 0 }}>No sets on this job yet.</p></div>
            ) : choosing || !current ? (
              <SetChooser library={job.library} onJob={job.sets.map(js => js.set.id)} onPick={addSet}
                          onCancel={current ? () => setChoosing(false) : null} />
            ) : (
              <SetPanel js={current} doors={doors} projectId={projectId}
                        onEdit={guard(() => editSet(current))} onCopy={() => copyForJob(current)} onRemove={() => removeSet(current)} onDelete={() => deleteFromLibrary(current.set)}
                        onChanged={load} onRemoveDoor={removeDoor} readOnly={!mine} setsOnly={job.sets_only} />
            )}
          </main>

          {/* Right: totals, checks, details */}
          <aside className="job-rail">
            <div className="card-panel">
              <h2 className="card-title"><IconBars size={18} /> Job summary</h2>
              <div className="total-row"><span>{job.sets_only ? 'Quantity' : 'Doors'}</span><strong>{job.doors_total}</strong></div>
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
              <div className="form-group"><label>Revision</label>
                <div className="rev-row">
                  <input className="form-control" type="number" min="1" value={details.revision} onChange={e => setDetails({ ...details, revision: e.target.value })} disabled={!mine} />
                  {mine && <button className="btn btn-soft" onClick={nextRevision} disabled={!!busy || detailsDirty} title={detailsDirty ? 'Save the details first' : 'The architect sent it back: start the next revision'}>
                    {busy === 'rev' ? <span className="spinner" /> : `New revision (${(job.revision || 1) + 1})`}
                  </button>}
                </div>
              </div>
              <div className="form-group"><label>Job name</label><input className="form-control" value={details.name} onChange={e => setDetails({ ...details, name: e.target.value })} disabled={!mine} /></div>
              <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div className="form-group"><label>Quote no</label><input className="form-control" value={details.quote_no} onChange={e => setDetails({ ...details, quote_no: e.target.value })} disabled={!mine} /></div>
                <div className="form-group"><label>Rep</label><input className="form-control" value={details.rep} onChange={e => setDetails({ ...details, rep: e.target.value })} disabled={!mine} /></div>
              </div>
              <div className="form-group"><label>Client</label><input className="form-control" value={details.client} onChange={e => setDetails({ ...details, client: e.target.value })} disabled={!mine} /></div>
              <div className="form-group"><label>Site</label><input className="form-control" value={details.site} onChange={e => setDetails({ ...details, site: e.target.value })} disabled={!mine} /></div>
              {mine && <button className="btn btn-soft wide" onClick={saveDetails} disabled={busy === 'details'}>{busy === 'details' ? <span className="spinner" /> : <><IconSave size={16} /> Save details</>}</button>}
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
      {library.length === 0 && <p className="muted" style={{ marginTop: 16 }}>No sets in the library yet. Add one under Sets.</p>}
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
                          onClick={e => { e.stopPropagation(); onDelete(s) }}><IconTrash size={16} /></span>
                  : !added && <IconRight size={16} />}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* One door on the set. Click the reference to correct it. */
function DoorChip({ d, readOnly, onRename, onRemove }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(d.ref)
  const done = keep => { setEditing(false); if (keep) onRename(val); else setVal(d.ref) }
  const title = [d.floor, d.source === 'plan' ? 'from the plan' : '', readOnly ? '' : 'Click to correct'].filter(Boolean).join(' · ')
  if (editing) return (
    <span className="door-chip editing">
      <input autoFocus value={val} onChange={e => setVal(e.target.value)} size={Math.max(3, val.length)}
             onBlur={() => done(true)}
             onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); done(true) } if (e.key === 'Escape') done(false) }} />
    </span>
  )
  return (
    <span className={`door-chip${readOnly ? '' : ' can-edit'}`} title={title}>
      <span className="door-ref" onClick={() => { if (!readOnly) { setVal(d.ref); setEditing(true) } }}>
        {d.ref}{d.handed ? 'h' : ''}{!readOnly && <IconEdit size={11} className="door-pen" />}
      </span>
      {onRemove && <button onClick={onRemove} title="Remove this door">×</button>}
    </span>
  )
}

function SetPanel({ js, doors, projectId, onEdit, onCopy, onRemove, onDelete, onChanged, onRemoveDoor, readOnly = false, setsOnly = false }) {
  const s = js.set
  const groups = groupItems(s.items)
  const [prefix, setPrefix] = useState('')
  const [sep,    setSep]    = useState('')
  const [refs,   setRefs]   = useState('')
  const [qty,    setQty]    = useState('')
  const [from,   setFrom]   = useState('')
  const [to,     setTo]     = useState('')
  const [floor,  setFloor]  = useState('')
  const [busy,   setBusy]   = useState('')
  const [showRange, setShowRange] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [many, setMany] = useState(false)          // the Add multiple doors grid
  const { ask, modal: confirmModal } = useConfirm()
  const removeAll = async () => {
    const fromPlans = doors.filter(d => d.source === 'plan').length
    const ok = await ask({
      title: `Remove all ${doors.length} doors from ${s.code}?`,
      body: fromPlans ? `${fromPlans} of them came off the plans and come back if the plans are rescanned.` : 'This cannot be undone.',
      confirm: 'Remove all', danger: true,
    })
    if (!ok) return
    try {
      const r = await apiFetch(`/projects/${projectId}/doors/remove`, { method: 'POST', body: JSON.stringify({ door_ids: doors.map(d => d.id) }) })
      showToast(`${r.removed} door${r.removed !== 1 ? 's' : ''} removed`, 'info'); await onChanged()
    } catch (err) { showToast(err.message, 'error') }
  }
  // Nothing about the numbering is guessed from the doors already there: what
  // the next ten start with says nothing about the next forty.

  // Door references come off the architect's schedule as they are: EXTY4, EDTW2,
  // rarely in any order. Type one, or paste a handful, and Enter puts them on.
  const addRefs = async e => {
    e.preventDefault()
    const list = refs.split(/[\s,;]+/).map(r => r.trim()).filter(Boolean)
    if (!list.length) return
    setBusy('refs')
    try {
      const r = await apiFetch(`/projects/${projectId}/doors/add-refs`, { method: 'POST',
        body: JSON.stringify({ set_id: s.id, refs: list, floor }) })
      const note = r.skipped.length ? `; already on the job: ${r.skipped.join(', ')}` : ''
      showToast(`${r.added} door${r.added !== 1 ? 's' : ''} added${note}`, r.added ? 'success' : 'error')
      setRefs(''); await onChanged()
    } catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }
  // "Give me twenty": placeholder doors numbered from the next free number, to
  // be corrected in their chips once the real references are known.
  const addQty = async e => {
    e.preventDefault()
    const n = Number(qty)
    if (!n || n < 1) return
    setBusy('qty')
    try {
      const r = await apiFetch(`/projects/${projectId}/doors/add-quantity`, { method: 'POST',
        body: JSON.stringify({ set_id: s.id, count: n, prefix: '', separator: '', pad: 2, start: null, floor }) })
      showToast(`${r.added} door${r.added !== 1 ? 's' : ''} added, ${r.first} to ${r.last}`, 'success')
      setQty(''); await onChanged()
    } catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }
  // a chip's reference, corrected in place
  const renameDoor = async (d, ref) => {
    ref = ref.trim()
    if (!ref || ref === d.ref) return
    try {
      await apiFetch(`/doors/${d.id}`, { method: 'PUT',
        body: JSON.stringify({ ref, floor: d.floor || '', handed: !!d.handed, door_type_id: d.door_type_id, set_id: d.set_id, note: d.note || '' }) })
      await onChanged()
    } catch (err) { showToast(err.message, 'error') }
  }
  const addRange = async e => {
    e.preventDefault(); if (from === '' || to === '') return
    setBusy('range')
    try {
      const r = await apiFetch(`/projects/${projectId}/doors/add-range`, { method: 'POST',
        body: JSON.stringify({ set_id: s.id, prefix, separator: sep, from_no: Number(from), to_no: Number(to),
                               pad: Math.max(String(from).length, String(to).length), floor }) })
      showToast(`${r.added} door${r.added !== 1 ? 's' : ''} added`, 'success')
      setFrom(''); setTo(''); await onChanged()
    } catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }

  const shown = showAll ? doors : doors.slice(0, 40)
  const menuItems = [

    { label: s.is_standard ? 'Remove from job' : 'Delete this copy', onClick: onRemove },

  ]
  return (
    <div className="set-panel">
      {confirmModal}
      <div className="set-panel-head">
        <div>
          <h1>{s.code} · {s.name}</h1>
          <div className="subline">
            {s.is_standard ? 'Library set. Changes made on this job are saved as this job’s own copy' : 'This job’s own copy'}
            {s.fire_rated ? ' · fire rated' : ''}
            <span className="pill">{setsOnly ? `Qty ${js.doors}` : `${js.doors} door${js.doors !== 1 ? 's' : ''}`}</span>
            {js.from_types > 0 && <span className="pill">{js.from_types} type{js.from_types !== 1 ? 's' : ''} from plans</span>}
          </div>
        </div>
        <div className="spacer" />
        <div className="actions">
          {!readOnly && <Menu label="Set actions" items={menuItems} />}
          {!readOnly && <button className="btn btn-primary" onClick={onEdit}><IconEdit size={16} /> Edit set</button>}
        </div>
      </div>

      {setsOnly ? <QuantityCard js={js} projectId={projectId} readOnly={readOnly} onChanged={onChanged} /> : <div className="card-panel">
        <h2 className="card-title">{readOnly ? 'Doors' : 'Add doors'}</h2>
        {readOnly && doors.length === 0 && <p className="muted" style={{ margin: 0 }}>No doors on this set yet.</p>}
        {!readOnly && <form onSubmit={addRefs} className="add-refs-grid">
          <label>Door ref<input className="form-control" value={refs} onChange={e => setRefs(e.target.value)} autoComplete="off"
                                placeholder="e.g. EXTY4, or several: D01 D02 ED03" /></label>
          <button className="btn btn-primary add-many-btn" type="button" onClick={() => setMany(true)}>Add multiple doors</button>
          <label>Floor (optional)<input className="form-control" value={floor} onChange={e => setFloor(e.target.value)} placeholder="e.g. Ground" /></label>
          <button className="btn btn-primary" type="submit" disabled={busy === 'refs' || !refs.trim()}>{busy === 'refs' ? <span className="spinner" /> : <><IconPlus size={16} /> Add door</>}</button>
        </form>}
        {many && <AddManyDoors projectId={projectId} set={s} onClose={() => setMany(false)} onAdded={onChanged} />}
        {!readOnly && <div className="add-range-row">
          <form onSubmit={addQty} className="add-qty-form">
            <span className="muted">Or add a quantity</span>
            <input className="form-control" type="number" min="1" max="2000" value={qty} onChange={e => setQty(e.target.value)} placeholder="e.g. 20" />
            <button className="btn btn-soft" type="submit" disabled={busy === 'qty' || !(Number(qty) >= 1)}>{busy === 'qty' ? <span className="spinner" /> : 'Add'}</button>
          </form>
          {showRange ? (
            <form onSubmit={addRange} className="add-range-form">
              <span className="muted">Or add a range</span>
              <input className="form-control range-prefix" value={prefix + sep} onChange={e => { const m = e.target.value.match(/^(.*?)([.\-\/ ]?)$/); setPrefix(m ? m[1] : e.target.value); setSep(m ? m[2] : '') }} placeholder="Prefix" title="Prefix, e.g. D or DT15." />
              <input className="form-control" type="number" value={from} onChange={e => setFrom(e.target.value)} placeholder="From" />
              <input className="form-control" type="number" value={to} onChange={e => setTo(e.target.value)} placeholder="To" />
              <button className="btn btn-soft" type="submit" disabled={busy === 'range' || from === '' || to === ''}>{busy === 'range' ? <span className="spinner" /> : 'Add range'}</button>
            </form>
          ) : (
            <button className="link-btn" onClick={() => setShowRange(true)}>Or add a range, e.g. 101 to 125</button>
          )}
        </div>}
        {doors.length > 0 && !readOnly && (
          <div className="door-list-head">
            <span className="muted">Click a reference to correct it</span>
            <button className="link-btn inline" onClick={removeAll}>Remove all</button>
          </div>
        )}
        {doors.length > 0 && (
          <div className="door-ref-list">
            {shown.map(d => (
              <DoorChip key={d.id} d={d} readOnly={readOnly} onRename={ref => renameDoor(d, ref)}
                        onRemove={!readOnly && d.source !== 'plan' ? () => onRemoveDoor(d) : null} />
            ))}
            {doors.length > 40 && !showAll && <button className="link-btn" onClick={() => setShowAll(true)}>and {doors.length - 40} more</button>}
          </div>
        )}
      </div>}

      <div className="card-panel">
        <h2 className="card-title">Products in this set</h2>
        <table className="ledger set-products soft">
          <thead><tr><th>Code</th><th>Product</th><th className="num">{setsOnly ? 'Per set' : 'Per door'}</th><th className="num">Price</th><th className="num">Value</th></tr></thead>
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
            {s.items.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 18 }}>No products in this set.</td></tr>}
          </tbody>
          <tfoot>
            <tr><td colSpan={3} /><td className="num">Set value</td><td className="num strong">{s.value_per_door != null ? money(s.value_per_door) : <span className="muted">not all priced</span>}</td></tr>
            <tr><td colSpan={3} /><td className="num">{setsOnly ? `Qty ${js.doors}` : `${js.doors} door${js.doors !== 1 ? 's' : ''}`} @ {s.value_per_door != null ? money(s.value_per_door) : '—'}</td><td className="num strong">{js.value != null ? money(js.value) : '—'}</td></tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

/* Sets only: how many of this set, and nothing about doors. */
function QuantityCard({ js, projectId, readOnly, onChanged }) {
  const [n, setN] = useState(String(js.doors))
  const [busy, setBusy] = useState(false)
  useEffect(() => { setN(String(js.doors)) }, [js.set.id, js.doors])
  const want = Number(n)
  const ok = n !== '' && Number.isInteger(want) && want >= 0 && want <= 2000
  const save = async e => {
    e.preventDefault()
    if (!ok || want === js.doors) return
    setBusy(true)
    try {
      await apiFetch(`/projects/${projectId}/sets/${js.set.id}/quantity`, { method: 'PUT', body: JSON.stringify({ count: want }) })
      showToast(`${js.set.code}: quantity ${want}`, 'success'); await onChanged()
    } catch (err) { showToast(err.message, 'error') }
    setBusy(false)
  }
  return (
    <div className="card-panel">
      <h2 className="card-title">Quantity</h2>
      {readOnly ? <p style={{ margin: 0 }}><strong>{js.doors}</strong> <span className="muted">of this set</span></p> : (
        <form onSubmit={save} className="qty-set-form">
          <label>How many of this set<input className="form-control" type="number" min="0" max="2000" value={n} onChange={e => setN(e.target.value)} /></label>
          <button className="btn btn-primary" type="submit" disabled={busy || !ok || want === js.doors}>{busy ? <span className="spinner" /> : 'Save quantity'}</button>
          <span className="muted">Each one is the full list of products below.</span>
        </form>
      )}
    </div>
  )
}

/* Add multiple doors: a short sheet, one door a row. Enter goes to the next
   row; a column copied out of Excel can be pasted straight in. */
function AddManyDoors({ projectId, set, onClose, onAdded }) {
  const blank = () => ({ ref: '', floor: '' })
  const [rows, setRows] = useState(() => Array.from({ length: 8 }, blank))
  const [onJob, setOnJob] = useState(null)        // refs already on the job, lower case
  const [busy, setBusy] = useState(false)
  const cells = useRef({})
  useEffect(() => {
    apiFetch(`/projects/${projectId}/doors`).then(ds => setOnJob(new Set((ds || []).map(d => (d.ref || '').trim().toLowerCase()))))
  }, [projectId])
  // straight away when the row is there, so fast typing never lands in the row above
  const focus = (i, col) => { const el = cells.current[`${i}-${col}`]; if (el) el.focus(); else setTimeout(() => cells.current[`${i}-${col}`]?.focus(), 0) }
  const set_ = (i, col, v) => setRows(rs => rs.map((r, k) => (k === i ? { ...r, [col]: v } : r)))
  const key = (e, i, col) => {
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && col === 'ref')) {
      e.preventDefault()
      if (i === rows.length - 1) setRows(rs => [...rs, blank()])
      focus(i + 1, col)
    }
    if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); focus(i - 1, col) }
  }
  // a block pasted from Excel: one door a line, a second column is the floor
  const paste = (e, i, col) => {
    const text = e.clipboardData.getData('text')
    if (!/[\n\t]/.test(text)) return
    e.preventDefault()
    const lines = text.replace(/\r/g, '').split('\n').filter((l, k, a) => l.trim() || k < a.length - 1).map(l => l.split('\t'))
    setRows(rs => {
      const out = [...rs]
      lines.forEach((cols, k) => {
        const at = i + k
        while (out.length <= at) out.push(blank())
        const r = { ...out[at] }
        if (col === 'ref') { r.ref = (cols[0] || '').trim(); if (cols.length > 1) r.floor = (cols[1] || '').trim() }
        else r.floor = (cols[0] || '').trim()
        out[at] = r
      })
      if (out[out.length - 1].ref) out.push(blank())
      return out
    })
  }
  const norm = r => r.ref.trim().replace(/\s+/g, ' ')
  const seen = {}
  const status = rows.map(r => {
    const k = norm(r).toLowerCase()
    if (!k) return ''
    if (onJob?.has(k)) return 'Already on the job'
    if (seen[k]) return 'Twice in this list'
    seen[k] = true
    return 'ok'
  })
  const ready = rows.filter((r, i) => status[i] === 'ok')
  const problems = status.filter(x => x && x !== 'ok').length
  const typed = rows.some(r => r.ref.trim())
  const add = async () => {
    if (!ready.length) return
    setBusy(true)
    try {
      const r = await apiFetch(`/projects/${projectId}/doors/add-refs`, { method: 'POST',
        body: JSON.stringify({ set_id: set.id, rows: ready.map(x => ({ ref: norm(x), floor: x.floor.trim() })) }) })
      showToast(`${r.added} door${r.added !== 1 ? 's' : ''} added to ${set.code}`, 'success')
      await onAdded(); onClose()
    } catch (err) { showToast(err.message, 'error') }
    setBusy(false)
  }
  const { guard, modal: leaveModal } = useLeaveGuard({ dirty: typed && !busy, onSave: async () => { await add(); return true }, what: 'doors' })
  const close = guard(onClose)
  return (
    <div className="modal-overlay" onMouseDown={e => e.target === e.currentTarget && !busy && close()}>
      {leaveModal}
      <div className="modal many-doors">
        <div className="md-head">
          <h2>Add multiple doors to {set.code}</h2>
          <p className="muted">Type a door reference and press Enter for the next row. A column copied from Excel can be pasted in. Floor is optional.</p>
        </div>
        <div className="sheet-wrap">
          <table className="sheet">
            <thead><tr><th className="sheet-n" /><th>Door reference</th><th>Floor</th><th className="sheet-st" /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={status[i] && status[i] !== 'ok' ? 'bad' : ''}>
                  <td className="sheet-n">{i + 1}</td>
                  <td><input ref={el => (cells.current[`${i}-ref`] = el)} value={r.ref} autoFocus={i === 0} spellCheck={false}
                             onChange={e => set_(i, 'ref', e.target.value)} onKeyDown={e => key(e, i, 'ref')} onPaste={e => paste(e, i, 'ref')} /></td>
                  <td><input ref={el => (cells.current[`${i}-floor`] = el)} value={r.floor}
                             onChange={e => set_(i, 'floor', e.target.value)} onKeyDown={e => key(e, i, 'floor')} onPaste={e => paste(e, i, 'floor')} /></td>
                  <td className="sheet-st">{status[i] && status[i] !== 'ok' ? status[i] : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="link-btn inline sheet-more" onClick={() => { setRows(rs => [...rs, ...Array.from({ length: 5 }, blank)]); focus(rows.length, 'ref') }}>Add 5 more rows</button>
        <div className="modal-actions md-foot">
          <span className="muted">{ready.length ? `${ready.length} door${ready.length !== 1 ? 's' : ''} ready` : 'No doors typed yet'}{problems ? `, ${problems} marked in red will be left out` : ''}</span>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={close} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={add} disabled={busy || !ready.length || onJob === null}>
            {busy ? <span className="spinner" /> : `Add ${ready.length || ''} door${ready.length !== 1 ? 's' : ''} to ${set.code}`}
          </button>
        </div>
      </div>
    </div>
  )
}
