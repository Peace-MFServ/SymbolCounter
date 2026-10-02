import React, { useState, useEffect, useMemo, useRef } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'
import { money, groupItems } from './JobView'
import { Picker } from './ProductsView'
import { ReplaceModal } from './SetsView'
import { Cell } from './CostSummaryView'
import { useJobProducts, useReplaceOnJob, ScopeModal } from './JobChanges'
import { useConfirm } from './confirm'
import { IconSearch, IconLeft, IconFile, IconRight, IconEdit } from './icons'

const SHOWN = 150
const refKey = r => (r || '').split(/(\d+)/).map(t => (/^\d+$/.test(t) ? t.padStart(8, '0') : t.toLowerCase())).join('')

/* Every door on the job before the schedule goes out: its set, what goes on
   it and what it costs, all changeable in place. On a sets-only job, every
   set and how many of it. */
export function DoorSummaryView({ projectId, onNavigate }) {
  const [data, setData] = useState(null)
  const [q, setQ] = useState('')
  const [setF, setSetF] = useState('')
  const [open, setOpen] = useState(null)          // the door (or set) shown open
  const [more, setMore] = useState(false)
  const [picker, setPicker] = useState(null)      // { mode: 'replace' | 'add', row, item }
  const [scopeAsk, setScopeAsk] = useState(null)
  const products = useJobProducts(projectId)
  const { ask, modal: confirmModal } = useConfirm()
  const load = () => apiFetch(`/projects/${projectId}/door-summary`).then(setData).catch(err => showToast(err.message, 'error'))
  useEffect(() => { load() }, [projectId])
  const replaceJob = useReplaceOnJob(projectId, products, load)

  const setsOnly = !!data?.sets_only
  const setById = useMemo(() => Object.fromEntries((data?.sets || []).map(s => [s.id, s])), [data])
  const doorsOf = useMemo(() => {
    const by = {}
    for (const d of data?.doors || []) if (d.set_id) (by[d.set_id] ||= []).push(d)
    return by
  }, [data])
  const sets = useMemo(() => [...(data?.sets || [])].sort((a, b) => refKey(a.code).localeCompare(refKey(b.code))), [data])

  const rows = useMemo(() => {
    if (!data) return []
    const n = q.trim().toLowerCase()
    const hit = s => !n || `${s.code} ${s.name}`.toLowerCase().includes(n) || s.items.some(i => `${i.sku} ${i.name}`.toLowerCase().includes(n))
    if (setsOnly) return sets.filter(s => (!setF || String(s.id) === setF) && hit(s))
    return data.doors.filter(d => {
      if (setF === 'none') { if (d.set_id) return false } else if (setF && String(d.set_id) !== setF) return false
      if (!n) return true
      const s = setById[d.set_id]
      return `${d.ref} ${d.floor}`.toLowerCase().includes(n) || (s && hit(s))
    })
  }, [data, q, setF, setsOnly, sets, setById])

  const crumbs = [
    { label: 'Jobs', onClick: () => onNavigate('dashboard') },
    { label: data?.name || '…', onClick: () => onNavigate('job', { id: projectId }) },
    { label: setsOnly ? 'Set summary' : 'Door summary' },
  ]
  if (!data) return <><Topbar crumbs={crumbs} onNavigate={onNavigate} /><div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div></>
  const ro = !data.can_edit
  const t = data.totals

  // ── changes ──────────────────────────────────────────────────────────────
  const saveDoor = async (d, patch) => {
    try {
      await apiFetch(`/doors/${d.id}`, { method: 'PUT', body: JSON.stringify({ ref: d.ref, floor: d.floor, handed: d.handed,
        door_type_id: d.door_type_id, set_id: d.set_id, note: d.note, ...patch }) })
      await load()
    } catch (err) { showToast(err.message, 'error') }
  }
  const setQty = async (s, n) => {
    try { await apiFetch(`/projects/${projectId}/sets/${s.id}/quantity`, { method: 'PUT', body: JSON.stringify({ count: n }) }); await load() }
    catch (err) { showToast(err.message, 'error') }
  }
  const setPrice = async (item, sell) => {
    try {
      await apiFetch(`/projects/${projectId}/cost-summary/${item.product_id}`, { method: 'PUT', body: JSON.stringify({ sell }) })
      showToast(`${item.sku} is ${money(sell)} on the whole job`, 'success'); await load()
    } catch (err) { showToast(err.message, 'error') }
  }
  const scope = opts => new Promise(resolve => setScopeAsk({ ...opts, resolve }))
  // row is a door, or on a sets-only job a set
  const change = async (row, op, title) => {
    try {
      if (setsOnly) {
        await apiFetch(`/projects/${projectId}/sets/${row.id}/change`, { method: 'POST', body: JSON.stringify(op) })
        showToast('Set changed', 'success'); await load(); return
      }
      const s = setById[row.set_id]
      const others = (doorsOf[s.id] || []).length - 1
      let jobWide = null
      if (op.kind === 'replace') {
        const elsewhere = sets.filter(x => x.id !== s.id && x.doors && x.items.some(i => i.product_id === op.product_id))
        if (elsewhere.length) {
          const doors = s.doors + elsewhere.reduce((n, x) => n + x.doors, 0)
          jobWide = `Every set on this job with ${op.sku}: ${[s, ...elsewhere].map(x => x.code).join(', ')}, ${doors} doors in all.`
        }
      }
      const where = others > 0 || jobWide ? await scope({ title, door: row.ref, set: s.code, others, jobWide }) : 'set'
      if (!where) return
      if (where === 'job') {
        const r = await apiFetch(`/projects/${projectId}/replace-product`, { method: 'POST',
          body: JSON.stringify({ product_id: op.product_id, new_product_id: op.new_product_id, apply: true }) })
        showToast(`${r.old.sku} replaced with ${r.new.sku} on ${r.doors} doors`, 'success')
      } else {
        const r = await apiFetch(`/projects/${projectId}/doors/${row.id}/change`, { method: 'POST', body: JSON.stringify({ ...op, scope: where }) })
        showToast(where === 'door' && others > 0 ? `${row.ref} now has its own set, ${r.code}` : `Changed on ${r.doors} door${r.doors !== 1 ? 's' : ''}`, 'success')
      }
      await load()
    } catch (err) { showToast(err.message, 'error') }
  }
  const remove = async (row, item) => {
    if (setsOnly && !await ask({ title: `Take ${item.sku} off ${row.code}?`, confirm: 'Take it off', danger: true })) return
    change(row, { kind: 'remove', product_id: item.product_id, sku: item.sku }, `Take ${item.sku} off ${row.ref || row.code}?`)
  }
  const picked = p => {
    const { mode, row, item } = picker
    setPicker(null)
    if (mode === 'add') change(row, { kind: 'add', product_id: p.id, qty: 1, sku: p.sku }, `Add ${p.sku} to ${row.ref || row.code}?`)
    else change(row, { kind: 'replace', product_id: item.product_id, new_product_id: p.id, sku: item.sku }, `Replace ${item.sku} with ${p.sku} on ${row.ref || row.code}?`)
  }
  const pickerSet = picker ? (setsOnly ? picker.row : setById[picker.row.set_id]) : null

  const setOptions = sets.map(s => ({ value: String(s.id), label: `${s.code}  ${s.name}` }))
  const shown = more ? rows : rows.slice(0, SHOWN)
  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} />
      {confirmModal}
      {replaceJob.ui}
      {scopeAsk && <ScopeModal ask={scopeAsk} onAnswer={a => { scopeAsk.resolve(a); setScopeAsk(null) }} />}
      {picker && <ReplaceModal item={picker.mode === 'replace' ? picker.item : null} products={products}
                               taken={new Set(pickerSet.items.map(i => i.product_id))}
                               title={picker.mode === 'add' ? `Add a product to ${picker.row.ref || picker.row.code}` : 'Replace a product'}
                               nowLabel={`On ${picker.row.ref || picker.row.code} now`} pickLabel={picker.mode === 'add' ? 'Add this' : 'Use this'}
                               onPick={picked} onClose={() => setPicker(null)} />}
      <div className="page-wrap adm-wrap">
        <div className="adm-head">
          <div className="adm-title">
            <h1>{setsOnly ? 'Set summary' : 'Door summary'}</h1>
            <p className="lede">{setsOnly ? 'Every set on the job and how many of each.' : 'Every door on the job, before the schedule goes out.'} Click a row to see and change what goes on it.</p>
          </div>
          <div className="adm-actions">
            <button className="btn btn-line" onClick={() => onNavigate('job', { id: projectId })}><IconLeft size={17} /> Back to job</button>
            <button className="btn btn-line" onClick={() => onNavigate('cost', { id: projectId })}>Cost summary</button>
            <button className="btn btn-primary" onClick={() => onNavigate('schedule', { id: projectId })}><IconFile size={17} /> Produce schedule</button>
          </div>
        </div>

        <div className="ds-stats">
          <div className="ds-stat"><span>{setsOnly ? 'Quantity' : 'Doors'}</span><strong>{t.doors}</strong></div>
          <div className="ds-stat"><span>Sets</span><strong>{t.sets}</strong></div>
          <div className="ds-stat"><span>Job value</span><strong>{t.value != null ? money(t.value) : <em>not all priced</em>}</strong></div>
          {!setsOnly && t.no_set > 0 && (
            <button className="ds-stat warn" onClick={() => setSetF('none')}><span>Doors without a set</span><strong>{t.no_set}</strong></button>
          )}
        </div>

        <div className="adm-filters">
          <label className="adm-search">
            <IconSearch size={17} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={setsOnly ? 'Find a set or product...' : 'Find a door, floor, set or product...'} />
          </label>
          <Picker value={setF} onChange={setSetF} all="All sets"
                  options={[...(setsOnly ? [] : [{ value: 'none', label: 'Doors without a set' }]), ...setOptions]} />
          <span className="ds-count">{rows.length} {setsOnly ? `set${rows.length !== 1 ? 's' : ''}` : `door${rows.length !== 1 ? 's' : ''}`}</span>
        </div>

        <div className="adm-card">
          <div className="adm-scroll">
            <table className="ds-grid">
              <colgroup>
                <col style={{ width: 44 }} />
                {setsOnly
                  ? <><col style={{ width: 120 }} /><col /><col style={{ width: 110 }} /><col style={{ width: '24%' }} /><col style={{ width: 120 }} /><col style={{ width: 130 }} /></>
                  : <><col style={{ width: 150 }} /><col style={{ width: 140 }} /><col style={{ width: '28%' }} /><col /><col style={{ width: 130 }} /></>}
              </colgroup>
              <thead>
                <tr>
                  <th />
                  {setsOnly
                    ? <><th>Set</th><th>Name</th><th className="num">Qty</th><th>Products</th><th className="num">Per set</th><th className="num">Total</th></>
                    : <><th>Door</th><th>Floor</th><th>Set</th><th>Products</th><th className="num">Per door</th></>}
                </tr>
              </thead>
              <tbody>
                {shown.map(row => {
                  const s = setsOnly ? row : setById[row.set_id]
                  const isOpen = open === row.id
                  const toggle = e => { if (!e.target.closest('input, select, button, .inline-edit')) setOpen(isOpen ? null : row.id) }
                  return (
                    <React.Fragment key={row.id}>
                      <tr className={`ds-row${isOpen ? ' open' : ''}`} onClick={toggle}>
                        <td className="ds-chev"><button aria-label={isOpen ? 'Close' : 'Open'} onClick={() => setOpen(isOpen ? null : row.id)}><IconRight size={16} /></button></td>
                        {setsOnly ? (
                          <>
                            <td className="ds-ref">{s.code}</td>
                            <td><div className="ds-name">{s.name}</div></td>
                            <td className="num"><QtyInput value={s.doors} ro={ro} min={0} onSave={n => setQty(s, n)} /></td>
                          </>
                        ) : (
                          <>
                            <td><InlineText value={row.ref} ro={ro} strong onSave={v => v && saveDoor(row, { ref: v })} /></td>
                            <td><InlineText value={row.floor} ro={ro} placeholder="Add floor" onSave={v => saveDoor(row, { floor: v })} /></td>
                            <td>
                              {ro ? (s ? <span className="ds-set">{s.code} <span className="muted">{s.name}</span></span> : <span className="ds-noset">No set</span>) : (
                                <div className={`ds-setpick${s ? '' : ' none'}`}>
                                  <Picker small value={s ? String(s.id) : ''} all="No set" options={setOptions}
                                          onChange={v => saveDoor(row, { set_id: v ? Number(v) : null })} />
                                </div>
                              )}
                            </td>
                          </>
                        )}
                        <td className="ds-prods">{s ? <><strong>{s.items.length} product{s.items.length !== 1 ? 's' : ''}</strong><span>{s.items.slice(0, 4).map(i => i.sku).join(', ')}{s.items.length > 4 ? ' …' : ''}</span></> : <span className="muted">—</span>}</td>
                        <td className="num ds-money">{s?.value_per_door != null ? money(s.value_per_door) : <span className="muted">{s ? 'not priced' : '—'}</span>}</td>
                        {setsOnly && <td className="num ds-money">{s.value != null ? money(s.value) : <span className="muted">—</span>}</td>}
                      </tr>
                      {isOpen && (
                        <tr className="ds-detail-row"><td colSpan={setsOnly ? 7 : 6}>
                          {s ? <SetDetail row={row} s={s} setsOnly={setsOnly} ro={ro} doorsOn={doorsOf[s.id] || []}
                                          onQty={(item, n) => change(row, { kind: 'qty', product_id: item.product_id, qty: n, sku: item.sku }, `Change ${item.sku} to ${n} on ${row.ref || row.code}?`)}
                                          onPrice={setPrice} onRemove={item => remove(row, item)}
                                          onReplace={item => setPicker({ mode: 'replace', row, item })}
                                          onAdd={() => setPicker({ mode: 'add', row })}
                                          onReplaceJob={item => replaceJob.start(item)}
                                          onEditSet={() => onNavigate('set', { id: s.id, projectId })} />
                             : <p className="muted ds-empty">This door has no set. Pick one in the Set column.</p>}
                        </td></tr>
                      )}
                    </React.Fragment>
                  )
                })}
                {rows.length === 0 && <tr><td colSpan={7} className="adm-none" style={{ padding: 40 }}>{q || setF ? 'Nothing matches.' : setsOnly ? 'No sets on this job yet.' : 'No doors on this job yet.'}</td></tr>}
              </tbody>
            </table>
          </div>
          {rows.length > SHOWN && !more && (
            <div className="adm-foot"><button className="btn btn-line" onClick={() => setMore(true)}>Show all {rows.length}</button></div>
          )}
        </div>
      </div>
    </>
  )
}

/* What goes on one door (or set), every line changeable. */
function SetDetail({ row, s, setsOnly, ro, doorsOn, onQty, onPrice, onRemove, onReplace, onAdd, onReplaceJob, onEditSet }) {
  const others = doorsOn.filter(d => d.id !== row.id)
  return (
    <div className="ds-detail">
      <div className="ds-detail-head">
        <div>
          <strong>{s.code} · {s.name}</strong>
          <span className="muted">
            {s.is_standard ? 'Library set' : 'This job’s own set'}
            {!setsOnly && (others.length
              ? ` · also on ${others.slice(0, 8).map(d => d.ref).join(', ')}${others.length > 8 ? ` and ${others.length - 8} more` : ''}`
              : ' · only on this door')}
          </span>
        </div>
        <button className="link-btn inline ds-link" onClick={onEditSet}><IconEdit size={14} /> Open the set</button>
      </div>
      <table className="ledger soft ds-items">
        <thead><tr><th>Code</th><th>Product</th><th className="num">Qty</th><th className="num" title="This job's price, the same as on the Cost summary">Price</th><th className="num">Value</th><th /></tr></thead>
        <tbody>
          {groupItems(s.items).map(g => (
            <React.Fragment key={g.type}>
              <tr className="group-row"><td colSpan={6}>{g.name}</td></tr>
              {g.items.map(it => (
                <tr key={it.product_id}>
                  <td className="mono">{it.sku}</td>
                  <td>{it.name}</td>
                  <td className="num"><QtyInput value={it.qty} ro={ro} onSave={n => onQty(it, n)} /></td>
                  <Cell v={it.sell} ro={ro} flag={it.price == null} onSave={v => onPrice(it, v)}
                        title={it.discounted ? `After the job's discounts: ${money(it.price)}` : 'Click to change this job’s price'} />
                  <td className="num">{it.line_value != null ? money(it.line_value) : <span className="muted">—</span>}</td>
                  <td className="row-actions">
                    {!ro && <button className="btn btn-ghost btn-sm" onClick={() => onReplace(it)}>Replace</button>}
                    {!ro && <button className="btn btn-ghost btn-sm danger" onClick={() => onRemove(it)}>Remove</button>}
                  </td>
                </tr>
              ))}
            </React.Fragment>
          ))}
          {s.items.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 16 }}>No products in this set.</td></tr>}
        </tbody>
        <tfoot><tr><td colSpan={4} className="num">{setsOnly ? 'Per set' : 'Per door'}</td><td className="num strong">{s.value_per_door != null ? money(s.value_per_door) : '—'}</td><td /></tr></tfoot>
      </table>
      <div className="ds-detail-foot">
        {!ro && <button className="btn btn-soft btn-sm" onClick={onAdd}>Add a product</button>}
        <span className="hint">Prices are this job's, the same as the Cost summary: a new price applies to that product everywhere on the job.</span>
      </div>
    </div>
  )
}

/* A label you click to type over. Enter or leaving the box saves, Escape cancels. */
function InlineText({ value, onSave, ro = false, strong = false, placeholder = '' }) {
  const [on, setOn] = useState(false)
  const [v, setV] = useState(value)
  const done = keep => { setOn(false); const t = v.trim(); if (keep && t !== (value || '')) onSave(t) }
  if (ro) return <span className={strong ? 'ds-ref' : ''}>{value || <span className="muted">—</span>}</span>
  if (on) return <input className="form-control inline-input" autoFocus value={v} onChange={e => setV(e.target.value)}
                        onBlur={() => done(true)} onKeyDown={e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') { setV(value); setOn(false) } }} />
  return (
    <span className={`inline-edit${strong ? ' ds-ref' : ''}${value ? '' : ' empty'}`} title="Click to change" onClick={() => { setV(value || ''); setOn(true) }}>
      {value || placeholder}<IconEdit size={12} className="inline-pen" />
    </span>
  )
}

/* A quantity box that saves when you leave it or press Enter. */
function QtyInput({ value, onSave, ro = false, min = 1 }) {
  const [v, setV] = useState(String(value))
  useEffect(() => { setV(String(value)) }, [value])
  if (ro) return <span>{value}</span>
  const commit = () => {
    const n = Number(v)
    if (v === '' || !Number.isInteger(n) || n < min) { setV(String(value)); return }
    if (n !== value) onSave(n)
  }
  return <input className="qty" type="number" min={min} value={v} onChange={e => setV(e.target.value)}
                onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setV(String(value)); e.target.blur() } }} />
}
