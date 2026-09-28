import React, { useState, useEffect, useMemo } from 'react'
import { apiFetch, openBlob } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'

/* Datasheets and certificates the zip could not place by code. Each row: the
   document, the app's best guesses ticked ready, a search to add any product,
   and one click to attach to all of them. A sheet usually covers a range. */
export function MatchDocumentsView({ onNavigate }) {
  const [items, setItems] = useState(null)
  const [total, setTotal] = useState(0)
  const [products, setProducts] = useState([])
  const PAGE = 40
  const load = async (offset = 0) => {
    const r = await apiFetch(`/products/documents/pending?offset=${offset}&limit=${PAGE}`)
    setTotal(r.total)
    setItems(xs => offset && xs ? [...xs, ...r.items] : r.items)
  }
  useEffect(() => { load(); apiFetch('/products').then(ps => setProducts(ps || [])) }, [])

  const crumbs = [{ label: 'Products', onClick: () => onNavigate('products') }, { label: 'Match datasheets' }]
  if (!items) return <><Topbar crumbs={crumbs} onNavigate={onNavigate} active="products" /><div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div></>

  const gone = id => { setItems(xs => xs.filter(x => x.id !== id)); setTotal(t => t - 1) }
  const attach = async (it, ids) => {
    try {
      const r = await apiFetch(`/products/documents/${it.id}/attach`, { method: 'POST', body: JSON.stringify({ product_ids: ids }) })
      gone(it.id); showToast(`${it.title} put on ${r.attached} product${r.attached !== 1 ? 's' : ''}`, 'success')
    } catch (err) { showToast(err.message, 'error') }
  }
  const skip = async it => {
    try { await apiFetch(`/products/documents/${it.id}`, { method: 'DELETE' }); gone(it.id) }
    catch (err) { showToast(err.message, 'error') }
  }
  const setKind = async (it, kind) => {
    try {
      const d = await apiFetch(`/products/documents/${it.id}`, { method: 'PUT', body: JSON.stringify({ kind }) })
      setItems(xs => xs.map(x => x.id === it.id ? { ...x, kind: d.kind } : x))
    } catch (err) { showToast(err.message, 'error') }
  }

  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} active="products" />
      <div className="page-wrap adm-wrap">
        <div className="adm-head">
          <div className="adm-title">
            <h1>Match datasheets</h1>
            <p className="lede">{total} document{total !== 1 ? 's' : ''} not yet on a product. Tick the products each one covers, or skip it.</p>
          </div>
          <div className="adm-actions">
            <button className="btn btn-line" onClick={() => onNavigate('products')}>Back to products</button>
          </div>
        </div>
        {items.length === 0 ? (
          <div className="adm-card"><div className="adm-empty"><strong>Nothing waiting</strong><span>Every document is on a product.</span></div></div>
        ) : (
          <>
            {items.map(it => (
              <DocRow key={it.id} it={it} products={products}
                      onAttach={ids => attach(it, ids)} onSkip={() => skip(it)} onKind={k => setKind(it, k)} />
            ))}
            {items.length < total && (
              <div style={{ textAlign: 'center', margin: '18px 0' }}>
                <button className="btn btn-line" onClick={() => load(items.length)}>Show more ({total - items.length} left)</button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}

function DocRow({ it, products, onAttach, onSkip, onKind }) {
  const [picked, setPicked] = useState(() => new Set(it.suggestions.filter(s => s.score >= 0.6).map(s => s.product_id)))
  const [q, setQ] = useState('')
  const [extra, setExtra] = useState([])     // products found by the search and ticked
  const toggle = id => setPicked(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const found = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return []
    const shown = new Set([...it.suggestions.map(s => s.product_id), ...extra.map(p => p.id)])
    return products.filter(p => !shown.has(p.id) && (p.sku.toLowerCase().includes(n) || p.name.toLowerCase().includes(n))).slice(0, 8)
  }, [q, products, it.suggestions, extra])
  const add = p => { setExtra(xs => [...xs, p]); setPicked(s => new Set(s).add(p.id)); setQ('') }
  const rows = [...it.suggestions.map(s => ({ id: s.product_id, sku: s.sku, name: s.name, score: s.score })),
                ...extra.map(p => ({ id: p.id, sku: p.sku, name: p.name }))]
  return (
    <div className="adm-card doc-row">
      <div className="doc-head">
        <div className="doc-title">
          <strong>{it.title}</strong>
          <span className="p-meta">{it.original_name}{it.pages ? ` · ${it.pages} page${it.pages !== 1 ? 's' : ''}` : ''}</span>
        </div>
        <div className="seg doc-kind">
          <button className={it.kind === 'datasheet' ? 'on' : ''} onClick={() => onKind('datasheet')}>Datasheet</button>
          <button className={it.kind === 'certificate' ? 'on' : ''} onClick={() => onKind('certificate')}>Certificate</button>
        </div>
        <button className="btn btn-line btn-row" onClick={() => openBlob(it.url).catch(e => showToast(e.message, 'error'))}>Open</button>
      </div>
      <div className="doc-body">
        {rows.length > 0 ? (
          <div className="doc-picks">
            {rows.map(r => (
              <label key={r.id} className={`doc-pick${picked.has(r.id) ? ' on' : ''}`}>
                <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
                <span className="doc-sku">{r.sku}</span>
                <span className="doc-name">{r.name}</span>
                {r.score != null && <span className="doc-score">{r.score >= 0.9 ? 'code match' : r.score >= 0.6 ? 'likely' : 'guess'}</span>}
              </label>
            ))}
          </div>
        ) : <p className="p-dash" style={{ margin: '0 0 8px' }}>No guess from the name. Search for the products it covers.</p>}
        <div className="combo doc-search">
          <input className="form-control" value={q} onChange={e => setQ(e.target.value)} placeholder="Add a product: code or name" />
          {found.length > 0 && (
            <div className="combo-list">
              {found.map(p => <button type="button" key={p.id} onClick={() => add(p)}><span className="doc-sku">{p.sku}</span> {p.name}</button>)}
            </div>
          )}
        </div>
      </div>
      <div className="doc-foot">
        <button className="btn btn-primary btn-row" disabled={picked.size === 0} onClick={() => onAttach([...picked])}>
          Attach to {picked.size} product{picked.size !== 1 ? 's' : ''}
        </button>
        <button className="btn btn-ghost btn-row" onClick={onSkip}>Skip</button>
      </div>
    </div>
  )
}
