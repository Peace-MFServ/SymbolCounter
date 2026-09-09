import React, { useState, useEffect } from 'react'
import { apiFetch } from './api'
import { Topbar } from './Dashboard'
import { TYPE_NAMES, money } from './JobView'

/* Sets down, products across: the whole job on one screen. */
export function GridView({ projectId, onNavigate }) {
  const [g, setG] = useState(null)
  useEffect(() => { apiFetch(`/projects/${projectId}/grid`).then(setG) }, [projectId])
  const crumbs = [
    { label: 'Projects', onClick: () => onNavigate('dashboard') },
    { label: g?.name || '…', onClick: () => onNavigate('job', { id: projectId }) },
    { label: 'Products by set' },
  ]
  if (!g) return <><Topbar crumbs={crumbs} onNavigate={onNavigate} /><div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div></>

  // type headings across the top, spanning their products
  const spans = []
  for (const p of g.products) {
    const last = spans[spans.length - 1]
    if (last && last.type === p.type) last.n++; else spans.push({ type: p.type, n: 1 })
  }
  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} />
      <div className="page-wrap wide">
        <div className="page-header">
          <div><h1>Products by set</h1><p className="lede">{g.sets.length} set{g.sets.length !== 1 ? 's' : ''}, {g.products.length} products, {g.doors_total} doors. Each cell is the quantity per door.</p></div>
          <div className="spacer" />
          <div className="actions"><button className="btn" onClick={() => onNavigate('job', { id: projectId })}>Back to job</button></div>
        </div>
        {g.sets.length === 0 ? <div className="empty-state"><h2>No sets on this job yet.</h2></div> : (
          <div className="grid-scroll">
            <table className="ledger grid-table">
              <thead>
                <tr className="grid-types">
                  <th colSpan={3} />
                  {spans.map((sp, i) => <th key={i} colSpan={sp.n}>{TYPE_NAMES[sp.type]}</th>)}
                  <th />
                </tr>
                <tr>
                  <th className="sticky">Set</th><th className="num">Doors</th><th className="num">Per door</th>
                  {g.products.map(p => <th key={p.sku} className="grid-prod" title={p.name}><span>{p.sku}</span></th>)}
                  <th className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {g.sets.map(r => (
                  <tr key={r.set_id} onClick={() => onNavigate('job', { id: projectId })}>
                    <td className="sticky"><strong>{r.code}</strong> <span className="muted">{r.name}</span></td>
                    <td className="num count-num">{r.doors}</td>
                    <td className="num">{r.value_per_door != null ? money(r.value_per_door) : '—'}</td>
                    {g.products.map(p => <td key={p.sku} className={`num cell${r.cells[p.sku] ? ' on' : ''}`}>{r.cells[p.sku] || ''}</td>)}
                    <td className="num">{r.value != null ? money(r.value) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="sticky">Total for the job</td><td className="num">{g.doors_total}</td><td />
                  {g.products.map(p => <td key={p.sku} className="num">{p.total || ''}</td>)}
                  <td className="num">{g.value != null ? money(g.value) : '—'}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
