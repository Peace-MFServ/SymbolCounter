import React, { useState, useEffect, useMemo, useRef } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'
import { Menu } from './ProjectView'

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
  const [addingSet, setAddingSet] = useState(false)

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
    setAddingSet(false)
    try { await apiFetch(`/projects/${projectId}/sets/${sid}/add`, { method: 'POST' }); await load(); setSelected(Number(sid)) }
    catch (err) { showToast(err.message, 'error') }
  }
  const removeSet = async js => {
    const n = js.doors
    if (!confirm(n ? `Take ${js.set.code} off this job? Its ${n} door${n !== 1 ? 's' : ''} will be left without a set.` : `Take ${js.set.code} off this job?`)) return
    try { await apiFetch(`/projects/${projectId}/sets/${js.set.id}`, { method: 'DELETE' }); setSelected(null); await load() }
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

  const crumbs = [{ label: 'Projects', onClick: () => onNavigate('dashboard') }, { label: job?.name || '…' }]
  if (!job || !details) return <><Topbar crumbs={crumbs} onNavigate={onNavigate} /><div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div></>

  const warn = job.checks.filter(c => c.level === 'warn').length

  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} />
      <div className="page-wrap wide">
        <div className="page-header">
          <div>
            <h1>{job.name}</h1>
            <p className="lede">{[job.quote_no && `Quote ${job.quote_no}`, job.client, job.site].filter(Boolean).join(' · ') || 'No quote number or client yet'}</p>
          </div>
          <div className="spacer" />
          <div className="actions">
            <Menu label="More" items={[
              { label: 'Products by set', onClick: () => onNavigate('grid', { id: projectId }) },
              { label: 'Copy this job', onClick: copyJob },
              { label: `Plans and door types${job.plans ? ` (${job.plans})` : ''}`, onClick: () => onNavigate('doors', { id: projectId }) },
              { label: 'Set library', onClick: () => onNavigate('sets') },
            ]} />
            <button className="btn btn-primary" onClick={() => onNavigate('schedule', { id: projectId })} disabled={!job.sets.length}>Produce schedule</button>
          </div>
        </div>

        <div className="job-grid">
          {/* Left: sets on this job */}
          <aside className="job-sets">
            <h3>Sets on this job</h3>
            {job.sets.length === 0 && <p className="muted" style={{ fontSize: 13 }}>None yet. Add one from the library below.</p>}
            <ul className="set-list">
              {job.sets.map(js => (
                <li key={js.set.id} className={js.set.id === selected ? 'on' : ''} onClick={() => setSelected(js.set.id)}>
                  <div className="set-list-code">{js.set.code}{!js.set.is_standard && <span className="tag">this job</span>}</div>
                  <div className="set-list-name">{js.set.name}</div>
                  <div className="set-list-meta">
                    <span>{js.doors} door{js.doors !== 1 ? 's' : ''}</span>
                    <span>{js.value != null ? money(js.value) : <span className="muted">no price</span>}</span>
                  </div>
                </li>
              ))}
            </ul>
            {addingSet ? (
              <select className="form-control" autoFocus defaultValue="" onChange={e => e.target.value && addSet(e.target.value)} onBlur={() => setAddingSet(false)}>
                <option value="">Choose a set…</option>
                {job.library.map(s => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
              </select>
            ) : (
              <div className="set-add">
                <button className="btn btn-sm" onClick={() => setAddingSet(true)} disabled={!job.library.length}>Add a set</button>
                <button className="link-btn" onClick={() => onNavigate('set', { id: 'new', projectId })}>New set for this job</button>
              </div>
            )}
            {job.types_to_decide > 0 && (
              <div className="rail-note">
                {job.types_to_decide} door type{job.types_to_decide !== 1 ? 's' : ''} from the plans still to decide.{' '}
                <button className="link-btn" onClick={() => onNavigate('doors', { id: projectId })}>Decide them</button>
              </div>
            )}
          </aside>

          {/* Middle: the selected set */}
          <main className="job-main">
            {!current ? (
              <div className="empty-state" style={{ padding: 48 }}>
                <h2>Start with a set.</h2>
                <p>A set is the hardware that goes on one kind of door. Add one from the library on the left, then say how many doors get it.</p>
                {job.library.length > 0 && (
                  <div className="lib-pick">
                    {job.library.map(s => (
                      <button key={s.id} className="lib-card" onClick={() => addSet(s.id)}>
                        <strong>{s.code}</strong> {s.name}
                        <span>{s.product_count} products · {s.value_per_door != null ? money(s.value_per_door) + ' per door' : 'no price yet'}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <SetPanel js={current} doors={doors} projectId={projectId}
                        onEdit={() => editSet(current)} onCopy={() => copyForJob(current)} onRemove={() => removeSet(current)}
                        onChanged={load} onRemoveDoor={removeDoor} />
            )}
          </main>

          {/* Right: totals, checks, details */}
          <aside className="job-rail">
            <div className="rail-panel">
              <h3>Totals</h3>
              <div className="total-row"><span>Doors</span><strong>{job.doors_total}</strong></div>
              <div className="total-row"><span>Sets</span><strong>{job.sets.length}</strong></div>
              <div className="total-row"><span>Items</span><strong>{job.items}</strong></div>
              <div className="total-row" style={{ borderBottom: 0 }}><span>Value</span><strong>{job.value != null ? money(job.value) : <span className="muted" style={{ fontWeight: 400 }}>not all priced</span>}</strong></div>
            </div>
            <div className={`rail-panel${warn ? ' warn' : ''}`} style={{ marginTop: 16 }}>
              <h3>Checks</h3>
              <ul className="check-list">{job.checks.map((c, i) => <li key={i} className={c.level}>{c.text}</li>)}</ul>
            </div>
            <div className="rail-panel" style={{ marginTop: 16 }}>
              <h3>Job details</h3>
              <div className="form-group"><label>Job name</label><input className="form-control" value={details.name} onChange={e => setDetails({ ...details, name: e.target.value })} /></div>
              <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div className="form-group"><label>Quote no</label><input className="form-control" value={details.quote_no} onChange={e => setDetails({ ...details, quote_no: e.target.value })} /></div>
                <div className="form-group"><label>Rep</label><input className="form-control" value={details.rep} onChange={e => setDetails({ ...details, rep: e.target.value })} /></div>
              </div>
              <div className="form-group"><label>Client</label><input className="form-control" value={details.client} onChange={e => setDetails({ ...details, client: e.target.value })} /></div>
              <div className="form-group"><label>Site</label><input className="form-control" value={details.site} onChange={e => setDetails({ ...details, site: e.target.value })} /></div>
              <button className="btn btn-sm" onClick={saveDetails} disabled={busy === 'details'}>{busy === 'details' ? <span className="spinner" /> : 'Save details'}</button>
            </div>
          </aside>
        </div>
      </div>
    </>
  )
}

/* The selected set: its products in type order, and its doors. */
function SetPanel({ js, doors, projectId, onEdit, onCopy, onRemove, onChanged, onRemoveDoor }) {
  const s = js.set
  const groups = groupItems(s.items)
  const [prefix, setPrefix] = useState('D')
  const [sep,    setSep]    = useState('')
  const [count,  setCount]  = useState(1)
  const [from,   setFrom]   = useState('')
  const [to,     setTo]     = useState('')
  const [floor,  setFloor]  = useState('')
  const [busy,   setBusy]   = useState('')
  const [showAll, setShowAll] = useState(false)
  const lastRef = doors.length ? doors[doors.length - 1].ref : ''

  // Guess the prefix from the last door on this set, e.g. "DT15.07" -> prefix DT15, sep "."
  useEffect(() => {
    const m = lastRef.match(/^(.*?)([.\-\/ ]?)(\d+)$/)
    if (m) { setPrefix(m[1]); setSep(m[2]) }
  }, [s.id, lastRef])

  const pad = () => { const m = lastRef.match(/(\d+)$/); return m ? Math.max(2, m[1].length) : 2 }

  const addQty = async e => {
    e.preventDefault(); setBusy('qty')
    try {
      const r = await apiFetch(`/projects/${projectId}/doors/add-quantity`, { method: 'POST',
        body: JSON.stringify({ set_id: s.id, count: Number(count) || 1, prefix, separator: sep, pad: pad(), floor }) })
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
  return (
    <div className="set-panel">
      <div className="set-panel-head">
        <div>
          <h2><span className="set-ref">{s.code}</span> {s.name}</h2>
          <div className="proj-meta">
            {s.is_standard ? 'Standard set, shared by every job' : 'This job’s own copy'}
            {s.fire_rated ? ' · Fire rated' : ''}
            {s.description ? ` · ${s.description}` : ''}
            {js.from_types > 0 ? ` · ${js.from_types} door type${js.from_types !== 1 ? 's' : ''} from the plans` : ''}
          </div>
        </div>
        <div className="spacer" />
        <div className="actions">
          {s.is_standard && <button className="btn btn-ghost btn-sm" onClick={onCopy} title="Change this set on this job without touching the standard">Copy for this job</button>}
          <button className="btn btn-sm" onClick={onEdit}>Edit set</button>
          <button className="btn btn-ghost btn-sm danger" onClick={onRemove}>Remove from job</button>
        </div>
      </div>

      <table className="ledger set-products">
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
          <tr><td colSpan={3} /><td className="num" style={{ fontWeight: 600 }}>Set value</td><td className="num" style={{ fontWeight: 600 }}>{s.value_per_door != null ? money(s.value_per_door) : <span className="muted">not all priced</span>}</td></tr>
          <tr><td colSpan={3} /><td className="num">{js.doors} door{js.doors !== 1 ? 's' : ''} @ {s.value_per_door != null ? money(s.value_per_door) : '—'}</td><td className="num" style={{ fontWeight: 600 }}>{js.value != null ? money(js.value) : '—'}</td></tr>
        </tfoot>
      </table>

      <div className="doors-block">
        <div className="doors-block-head">
          <h3>Doors on {s.code} <span className="muted" style={{ fontWeight: 400 }}>{doors.length}</span></h3>
        </div>
        {doors.length > 0 ? (
          <div className="door-ref-list">
            {shown.map(d => (
              <span key={d.id} className="door-chip" title={[d.floor, d.source === 'plan' ? 'from the plan' : ''].filter(Boolean).join(' · ')}>
                {d.ref}{d.handed ? 'h' : ''}
                {d.source !== 'plan' && <button onClick={() => onRemoveDoor(d)} title="Remove this door">×</button>}
              </span>
            ))}
            {doors.length > 40 && !showAll && <button className="link-btn" onClick={() => setShowAll(true)}>and {doors.length - 40} more</button>}
          </div>
        ) : <p className="muted" style={{ fontSize: 13, margin: '4px 0 10px' }}>No doors yet. Say how many below.</p>}

        <div className="add-doors">
          <form onSubmit={addQty} className="add-doors-row">
            <label>Add<input className="form-control" type="number" min="1" max="2000" value={count} onChange={e => setCount(e.target.value)} /></label>
            <label>doors numbered<input className="form-control" value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="D" style={{ width: 80 }} /></label>
            <input className="form-control" value={sep} onChange={e => setSep(e.target.value)} placeholder="." style={{ width: 36 }} title="Separator, e.g. a dot" />
            <span className="muted">then a number</span>
            <input className="form-control" value={floor} onChange={e => setFloor(e.target.value)} placeholder="Floor (optional)" style={{ width: 130 }} />
            <button className="btn btn-sm" type="submit" disabled={busy === 'qty'}>{busy === 'qty' ? <span className="spinner" /> : `Add ${count || 1}`}</button>
          </form>
          <form onSubmit={addRange} className="add-doors-row">
            <span className="muted">or a range</span>
            <input className="form-control" type="number" value={from} onChange={e => setFrom(e.target.value)} placeholder="from" style={{ width: 80 }} />
            <input className="form-control" type="number" value={to} onChange={e => setTo(e.target.value)} placeholder="to" style={{ width: 80 }} />
            <button className="btn btn-sm" type="submit" disabled={busy === 'range' || from === '' || to === ''}>{busy === 'range' ? <span className="spinner" /> : 'Add range'}</button>
            <span className="hint">Next would be {prefix}{sep}{String(Math.max(1, (doors.length ? Number((lastRef.match(/(\d+)$/) || [0, 0])[1]) : 0) + 1)).padStart(pad(), '0')}</span>
          </form>
        </div>
      </div>
    </div>
  )
}
