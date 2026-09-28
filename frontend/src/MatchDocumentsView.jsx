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
  const [unread, setUnread] = useState(0)
  const [products, setProducts] = useState([])
  const [busy, setBusy] = useState('')
  const [plan, setPlan] = useState(null)       // what Attach found would do, waiting for a yes
  const PAGE = 40
  const load = async (offset = 0) => {
    const r = await apiFetch(`/products/documents/pending?offset=${offset}&limit=${PAGE}`)
    setTotal(r.total); setUnread(r.unread)
    setItems(xs => offset && xs ? [...xs, ...r.items] : r.items)
  }
  // open every waiting sheet and note the codes printed in it
  const readAll = async () => {
    setBusy('read')
    try {
      const r = await apiFetch('/products/documents/read', { method: 'POST' })
      showToast(`${r.read} document${r.read !== 1 ? 's' : ''} read${r.scans ? `, ${r.scans} scanned with no text` : ''}`, 'success')
      await load()
    } catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }
  const lookFound = async () => {
    setBusy('look')
    try { setPlan(await apiFetch('/products/documents/attach-found?apply=false', { method: 'POST' })) }
    catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }
  const applyFound = async () => {
    setBusy('apply')
    try {
      const r = await apiFetch('/products/documents/attach-found?apply=true', { method: 'POST' })
      showToast(`${r.documents} datasheet${r.documents !== 1 ? 's' : ''} put on ${r.links} product${r.links !== 1 ? 's' : ''}`, 'success')
      setPlan(null); await load()
    } catch (err) { showToast(err.message, 'error') }
    setBusy('')
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
            {unread > 0 && (
              <button className="btn btn-primary" onClick={readAll} disabled={!!busy}>
                {busy === 'read' ? <><span className="spinner" /> Reading {unread} documents…</> : `Read the waiting datasheets (${unread})`}
              </button>
            )}
            {unread === 0 && total > 0 && (
              <button className="btn btn-soft" onClick={lookFound} disabled={!!busy}>
                {busy === 'look' ? <span className="spinner" /> : 'Attach what the sheets name'}
              </button>
            )}
            <button className="btn btn-line" onClick={() => onNavigate('products')}>Back to products</button>
          </div>
        </div>
        {plan && <PlanModal plan={plan} busy={busy} onApply={applyFound} onClose={() => setPlan(null)} />}
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
  const [picked, setPicked] = useState(() => new Set(it.suggestions
    .filter(s => s.source === 'sheet' ? !it.catalogue : s.score >= 0.6).map(s => s.product_id)))
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
  const rows = [...it.suggestions.map(s => ({ id: s.product_id, sku: s.sku, name: s.name, score: s.score, source: s.source, seen: s.seen_as })),
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
      {it.has_text === false && <p className="doc-note">A scanned sheet: there is no text in it to read, so match it by hand.</p>}
      {it.catalogue && <p className="doc-note">It names {rows.filter(r => r.source === 'sheet').length} of your products, so it reads like a catalogue. Nothing is ticked; tick the ones it is really for.</p>}
      <div className="doc-body">
        {rows.length > 0 ? (
          <div className="doc-picks">
            {rows.map(r => (
              <label key={r.id} className={`doc-pick${picked.has(r.id) ? ' on' : ''}`}>
                <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
                <span className="doc-sku">{r.sku}</span>
                <span className="doc-name">{r.name}</span>
                {r.source === 'sheet'
                  ? <span className="doc-score on-sheet" title={`Printed in the sheet as ${r.seen}`}>{r.score >= 1 ? 'on the sheet' : 'range on the sheet'}</span>
                  : r.score != null && <span className="doc-score">{r.score >= 0.9 ? 'code match' : r.score >= 0.6 ? 'likely' : 'guess'}</span>}
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

/* Everything the sheets name, before any of it is attached. */
function PlanModal({ plan, busy, onApply, onClose }) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" style={{ maxWidth: 720 }}>
        <h2>Attach what the sheets name</h2>
        {plan.documents === 0 ? (
          <p>None of the waiting datasheets print a code from your product file.{plan.catalogues ? ` ${plan.catalogues} read like catalogues and are left for you.` : ''}</p>
        ) : (
          <>
            <p className="muted" style={{ margin: '-8px 0 12px' }}>
              {plan.documents} datasheet{plan.documents !== 1 ? 's' : ''} onto {plan.links} product{plan.links !== 1 ? 's' : ''}, each by a code printed in the sheet. Nothing is attached yet.
              {plan.catalogues ? ` ${plan.catalogues} that read like catalogues are left for you.` : ''}
            </p>
            <div className="doc-check" style={{ maxHeight: 360 }}>
              {plan.plan.map(d => (
                <div key={d.document_id}><span>{d.title}</span><strong title={d.products.map(p => `${p.sku} (printed as ${p.seen_as})`).join('\n')}>{d.products.map(p => p.sku).join(', ')}</strong></div>
              ))}
            </div>
          </>
        )}
        <div className="modal-actions">
          {plan.documents > 0 && <button className="btn btn-primary" onClick={onApply} disabled={!!busy}>{busy === 'apply' ? <span className="spinner" /> : `Attach ${plan.documents} datasheet${plan.documents !== 1 ? 's' : ''}`}</button>}
          <button className="btn btn-ghost" onClick={onClose} disabled={!!busy}>{plan.documents > 0 ? 'Cancel' : 'Close'}</button>
        </div>
      </div>
    </div>
  )
}
