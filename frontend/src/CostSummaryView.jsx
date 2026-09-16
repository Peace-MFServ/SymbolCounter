import React, { useState, useEffect, useRef } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'
import { money } from './JobView'

/* Intec's Cost Summary: every product on the job with cost, markup, sell,
   discounts, line value and margin. Any price cell can be typed over. */
export function CostSummaryView({ projectId, onNavigate }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState('')
  const load = () => apiFetch(`/projects/${projectId}/cost-summary`).then(setData)
  useEffect(() => { load() }, [projectId])

  const crumbs = [
    { label: 'Jobs', onClick: () => onNavigate('dashboard') },
    { label: data?.name || '…', onClick: () => onNavigate('job', { id: projectId }) },
    { label: 'Cost summary' },
  ]
  if (!data) return <><Topbar crumbs={crumbs} onNavigate={onNavigate} /><div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div></>

  const edit = async (row, field, value) => {
    try {
      const r = await apiFetch(`/projects/${projectId}/cost-summary/${row.product_id}`, { method: 'PUT', body: JSON.stringify({ [field]: value }) })
      setData(d => ({ ...d, rows: d.rows.map(x => x.product_id === row.product_id ? r.row : x), totals: r.totals }))
    } catch (err) { showToast(err.message, 'error') }
  }
  const setDiscount = async which => {
    const v = prompt(`Discount ${which.toUpperCase()} for every line, in percent`, '0')
    if (v === null) return
    setBusy('disc')
    try {
      const r = await apiFetch(`/projects/${projectId}/cost-summary/discount`, { method: 'POST', body: JSON.stringify({ which, value: Number(v) || 0 }) })
      setData(d => ({ ...d, rows: r.rows, totals: r.totals }))
    } catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }
  const reset = async () => {
    if (!confirm('Put every line back to the prices in the product file? Your edits on this job will be lost.')) return
    setBusy('reset')
    try {
      const r = await apiFetch(`/projects/${projectId}/cost-summary/reset`, { method: 'POST' })
      setData(d => ({ ...d, rows: r.rows, totals: r.totals })); showToast('Prices reset from the product file', 'info')
    } catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }

  const t = data.totals
  const ro = !data.can_edit
  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} />
      <div className="page-wrap wide">
        <div className="page-header">
          <div>
            <h1>Cost summary</h1>
            <p className="lede">
              {t.lines} product{t.lines !== 1 ? 's' : ''} on the job.
              {t.unpriced > 0 && ` ${t.unpriced} with no cost yet.`}
              {ro ? ' Only the job owner can change prices.' : ' Click any cost, markup, sell or discount to change it for this job.'}
            </p>
          </div>
          <div className="spacer" />
          <div className="actions">
            {!ro && <button className="btn" onClick={reset} disabled={!!busy}>{busy === 'reset' ? <span className="spinner" /> : 'Update prices from product file'}</button>}
            <button className="btn" onClick={() => onNavigate('job', { id: projectId })}>Back to job</button>
          </div>
        </div>

        {data.rows.length === 0 ? <div className="empty-state"><h2>No products on this job yet.</h2><p>Add a set to the job first.</p></div> : (
          <div className="grid-scroll">
            <table className="ledger cost-table">
              <thead>
                <tr>
                  <th>Code</th><th>Product</th>
                  <th className="num">Qty</th><th className="num">Cost</th><th className="num">Markup %</th><th className="num">Sell</th>
                  <th className="num">Disc. A %</th><th className="num">Disc. B %</th><th className="num">Actual S.P.</th><th className="num">Line value</th><th className="num">Margin %</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map(r => (
                  <tr key={r.product_id}>
                    <td className="mono">{r.sku}</td>
                    <td className="cost-name" title={r.name}>{r.name}</td>
                    <td className={'num' + (r.qty ? '' : ' flag')}>{fmt(r.qty)}</td>
                    <Cell v={r.cost} flag={!r.cost} edited={r.cost_edited} ro={ro} onSave={v => edit(r, 'cost', v)} title={r.cost_edited && r.product_cost != null ? `Product file: ${money(r.product_cost)}` : ''} />
                    <Cell v={r.markup} ro={ro} onSave={v => edit(r, 'markup', v)} />
                    <Cell v={r.sell} edited={r.sell_edited} ro={ro} onSave={v => edit(r, 'sell', v)} title={r.sell_edited && r.product_sell != null ? `Product file: ${money(r.product_sell)}` : ''} />
                    <Cell v={r.disc_a} ro={ro} onSave={v => edit(r, 'disc_a', v)} />
                    <Cell v={r.disc_b} ro={ro} onSave={v => edit(r, 'disc_b', v)} />
                    <td className="num">{fmt(r.actual)}</td>
                    <td className="num shade">{fmt(r.line_value)}</td>
                    <td className="num">{fmt(r.margin)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="strong">Totals</td>
                  <td className="num strong">{fmt(t.cost_total)}</td>
                  <td className="num strong">{fmt(t.markup)}</td>
                  <td />
                  <td className="num">{!ro && <button className="btn btn-sm" onClick={() => setDiscount('a')} disabled={!!busy}>Set</button>}</td>
                  <td className="num">{!ro && <button className="btn btn-sm" onClick={() => setDiscount('b')} disabled={!!busy}>Set</button>}</td>
                  <td />
                  <td className="num strong shade">{fmt(t.line_total)}</td>
                  <td className="num strong">{fmt(t.margin)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="hint" style={{ marginTop: 12 }}>
          Markup is on cost, margin is on the actual selling price. Actual S.P. is the sell price less discounts A and B.
          Edited cells have a blue mark. The priced schedule uses the actual selling prices from this page.
        </p>
      </div>
    </>
  )
}

const fmt = n => (n == null ? '—' : Number(n).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

/* A number you can click and type over. Enter or Tab saves, Escape cancels. */
function Cell({ v, flag = false, edited = false, ro = false, onSave, title = '' }) {
  const [on, setOn] = useState(false)
  const [val, setVal] = useState('')
  const ref = useRef()
  const start = () => { if (ro) return; setVal(v == null ? '' : String(v)); setOn(true) }
  useEffect(() => { if (on && ref.current) { ref.current.focus(); ref.current.select() } }, [on])
  const commit = () => {
    setOn(false)
    const n = Number(val)
    if (val === '' || Number.isNaN(n) || n === v) return
    onSave(n)
  }
  const cls = 'num cell-edit' + (flag ? ' flag' : '') + (edited ? ' edited' : '') + (ro ? ' ro' : '')
  if (on) return <td className={cls}><input ref={ref} className="cell-input" type="number" step="0.01" value={val} onChange={e => setVal(e.target.value)}
                                            onBlur={commit} onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commit() } if (e.key === 'Escape') setOn(false) }} /></td>
  return <td className={cls} onClick={start} title={title || (ro ? '' : 'Click to change')}>{fmt(v)}</td>
}
