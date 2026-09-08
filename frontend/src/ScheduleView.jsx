import React, { useState, useEffect } from 'react'
import { apiFetch, downloadBlob } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'
import { Menu } from './ProjectView'
import { useAuthImage } from './TemplatesView'

const money = v => (v == null ? '' : v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

export function ScheduleView({ projectId, onNavigate }) {
  const [data,   setData]   = useState(null)
  const [job,    setJob]    = useState(null)      // editable job details
  const [busy,   setBusy]   = useState('')
  const [priced, setPriced] = useState(false)

  const load = async () => {
    const [d, p] = await Promise.all([apiFetch(`/projects/${projectId}/schedule`), apiFetch(`/projects/${projectId}`)])
    setData(d)
    setJob({ name: p.name, client: p.client || '', site: p.site || '', description: p.description || '',
             drawing_firm: p.drawing_firm || '', quote_no: p.quote_no || '', rep: p.rep || '' })
  }
  useEffect(() => { load() }, [projectId])

  const saveJob = async () => {
    setBusy('job')
    try { await apiFetch(`/projects/${projectId}`, { method: 'PUT', body: JSON.stringify(job) }); showToast('Job details saved', 'success'); await load() }
    catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }

  const download = async kind => {
    setBusy(kind)
    const stem = `${job.quote_no ? job.quote_no + '_' : ''}${job.name.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_')}`
    try {
      if (kind === 'pdf')     await downloadBlob(`/projects/${projectId}/schedule/pdf?priced=${priced}`, `${stem}_Schedule${priced ? '_Priced' : ''}.pdf`)
      if (kind === 'excel')   await downloadBlob(`/projects/${projectId}/schedule/excel?priced=${priced}`, `${stem}_Schedule.xlsx`)
      if (kind === 'picking') await downloadBlob(`/projects/${projectId}/schedule/picking`, `${stem}_Picking_List.pdf`)
    } catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }

  const crumbs = [
    { label: 'Projects', onClick: () => onNavigate('dashboard') },
    { label: job?.name || '…', onClick: () => onNavigate('project', { id: projectId }) },
    { label: 'Doors', onClick: () => onNavigate('doors', { id: projectId }) },
    { label: 'Schedule' },
  ]
  if (!data || !job) return <><Topbar crumbs={crumbs} onNavigate={onNavigate} /><div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div></>

  const nothing = data.sets.length === 0
  const warn = data.checks.filter(c => c.level === 'warn').length

  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} />
      <div className="page-wrap">
        <div className="page-header">
          <div>
            <h1>Schedule</h1>
            <p className="lede">
              {nothing ? 'Nothing to schedule until door types have sets.'
                : `${data.doors_scheduled} doors across ${data.sets.length} set${data.sets.length !== 1 ? 's' : ''}, ${data.item_count} items.`}
              {data.doors_excluded > 0 && ` ${data.doors_excluded} doors by others left off.`}
            </p>
          </div>
          <div className="spacer" />
          <div className="actions">
            {!nothing && (
              <>
                <label className="check" style={{ marginRight: 8 }} title={data.priced_ok ? '' : 'Some products have no sell price yet'}>
                  <input type="checkbox" checked={priced} disabled={!data.priced_ok} onChange={e => setPriced(e.target.checked)} /> With prices
                </label>
                <button className="btn" onClick={() => download('picking')} disabled={!!busy}>{busy === 'picking' ? <span className="spinner" /> : 'Picking list'}</button>
                <button className="btn" onClick={() => download('excel')} disabled={!!busy}>{busy === 'excel' ? <span className="spinner" /> : 'Excel'}</button>
                <button className="btn btn-primary" onClick={() => download('pdf')} disabled={!!busy}>{busy === 'pdf' ? <span className="spinner" /> : 'Download schedule PDF'}</button>
              </>
            )}
          </div>
        </div>

        <div className="split">
          <div>
            {nothing ? (
              <div className="empty-state">
                <h2>No sets assigned yet.</h2>
                <p>Go to Doors and pick a hardware set for each door type. The schedule builds itself from those choices.</p>
                <button className="btn btn-primary" onClick={() => onNavigate('doors', { id: projectId })}>Go to doors</button>
              </div>
            ) : data.sets.map(s => <SetCard key={s.id} s={s} priced={priced} onNavigate={onNavigate} />)}

            {!nothing && (
              <div className="sched-set">
                <div className="sched-set-head">
                  <h2>Product summary</h2>
                  <span className="muted">{data.summary.length} products · {data.item_count} items</span>
                </div>
                <table className="ledger sched-items">
                  <thead><tr><th>Code</th><th>Product</th><th style={{ textAlign: 'right' }}>Qty</th><th>Unit</th>{priced && <><th style={{ textAlign: 'right' }}>Price</th><th style={{ textAlign: 'right' }}>Value</th></>}</tr></thead>
                  <tbody>
                    {data.summary.map(r => (
                      <tr key={r.sku}><td className="mono">{r.sku}</td><td>{r.name}</td><td className="count-num">{r.qty}</td><td className="muted">{r.unit}</td>
                        {priced && <><td className="num-cell">{money(r.price)}</td><td className="num-cell">{money(r.value)}</td></>}</tr>
                    ))}
                  </tbody>
                  {priced && <tfoot><tr><td colSpan={5} style={{ textAlign: 'right', fontWeight: 600 }}>Total</td><td className="num-cell" style={{ fontWeight: 600 }}>{money(data.total)}</td></tr></tfoot>}
                </table>
              </div>
            )}
          </div>

          <aside>
            <div className={`rail-panel${warn ? ' warn' : ''}`}>
              <h3>Checks</h3>
              {data.checks.length === 0 ? <p className="muted">Nothing to check yet.</p> : (
                <ul className="check-list">
                  {data.checks.map((c, i) => <li key={i} className={c.level}>{c.text}</li>)}
                </ul>
              )}
              {data.doors_no_set > 0 && <button className="link-btn" onClick={() => onNavigate('doors', { id: projectId })}>Back to doors</button>}
            </div>

            <div className="rail-panel" style={{ marginTop: 20 }}>
              <h3>Job details</h3>
              <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>These go on the cover page.</p>
              <div className="form-group"><label>Quote no</label><input className="form-control" value={job.quote_no} onChange={e => setJob({ ...job, quote_no: e.target.value })} /></div>
              <div className="form-group"><label>Client</label><input className="form-control" value={job.client} onChange={e => setJob({ ...job, client: e.target.value })} /></div>
              <div className="form-group"><label>Site</label><input className="form-control" value={job.site} onChange={e => setJob({ ...job, site: e.target.value })} /></div>
              <div className="form-group"><label>Rep</label><input className="form-control" value={job.rep} onChange={e => setJob({ ...job, rep: e.target.value })} /></div>
              <div className="total-row" style={{ borderBottom: 0 }}><span>Estimator</span><strong>{data.project.estimator}</strong></div>
              <div className="total-row" style={{ borderBottom: 0 }}><span>Date</span><strong>{data.project.date}</strong></div>
              <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={saveJob} disabled={busy === 'job'}>{busy === 'job' ? <span className="spinner" /> : 'Save details'}</button>
            </div>

            {!nothing && (
              <div className="rail-panel" style={{ marginTop: 20 }}>
                <h3>Totals</h3>
                <div className="total-row"><span>Doors scheduled</span><strong>{data.doors_scheduled}<span className="muted" style={{ fontWeight: 400 }}> / {data.doors_total}</span></strong></div>
                <div className="total-row"><span>Sets</span><strong>{data.sets.length}</strong></div>
                <div className="total-row"><span>Product lines</span><strong>{data.summary.length}</strong></div>
                <div className="total-row" style={{ borderBottom: 0 }}><span>Items</span><strong>{data.item_count}</strong></div>
                {data.priced_ok && <div className="total-row" style={{ borderBottom: 0 }}><span>Total price</span><strong>{money(data.total)}</strong></div>}
              </div>
            )}
          </aside>
        </div>
      </div>
    </>
  )
}

function SetCard({ s, priced, onNavigate }) {
  const [showDoors, setShowDoors] = useState(false)
  return (
    <div className="sched-set">
      <div className="sched-set-head">
        <h2><span className="set-ref">{s.code}</span> {s.name}</h2>
        <span className="muted">{s.doors} door{s.doors !== 1 ? 's' : ''}{priced ? ` @ ${money(s.per_door)} = ${money(s.value)}` : ''}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => onNavigate('set', { id: s.id })}>Edit set</button>
      </div>
      <table className="ledger sched-items">
        <thead><tr><th>Code</th><th>Product</th><th style={{ textAlign: 'right' }}>Qty</th><th>Unit</th>{priced && <><th style={{ textAlign: 'right' }}>Price</th><th style={{ textAlign: 'right' }}>Value</th></>}<th>Photo</th></tr></thead>
        <tbody>
          {s.items.map(it => (
            <tr key={it.sku}>
              <td className="mono">{it.sku}</td><td>{it.name}</td><td className="count-num">{it.qty}</td><td className="muted">{it.unit}</td>
              {priced && <><td className="num-cell">{money(it.price)}</td><td className="num-cell">{money(it.value)}</td></>}
              <td><Thumb url={it.image_url} /></td>
            </tr>
          ))}
          {s.items.length === 0 && <tr><td colSpan={priced ? 7 : 5} className="muted" style={{ padding: 16 }}>This set has no products yet.</td></tr>}
        </tbody>
      </table>
      <div className="door-refs">
        <button className="link-btn" onClick={() => setShowDoors(v => !v)}>{showDoors ? 'Hide door references' : 'Door references'}</button>
        {showDoors && <div className="door-ref-list">{s.door_refs.map(r => <span key={r.ref} className="mono">{r.ref}{r.handed ? 'h' : ''}</span>)}</div>}
      </div>
    </div>
  )
}

function Thumb({ url }) {
  const src = useAuthImage(url)
  if (!url) return <span className="badge badge-grey">None</span>
  return <div className="thumb">{src && <img src={src} alt="" />}</div>
}
