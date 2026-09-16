import React, { useState, useEffect, useMemo } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'
import { useAuthImage } from './TemplatesView'
import { TYPE_NAMES, TYPE_ORDER } from './JobView'

/* Pictures the zip could not match by code. Each row: the picture, the app's best
   guess, one click to accept, a search to pick something else, or skip. */
export function MatchImagesView({ onNavigate }) {
  const [items, setItems] = useState(null)
  const [total, setTotal] = useState(0)
  const [strong, setStrong] = useState(0)
  const [products, setProducts] = useState([])
  const [busy, setBusy] = useState('')
  const PAGE = 40
  const mapRef = React.useRef()
  const applyMap = async file => {
    if (!file) return
    setBusy('map')
    try {
      const form = new FormData(); form.append('file', file)
      const r = await apiFetch('/products/pending-images/apply-map', { method: 'POST', body: form })
      showToast(`${r.placed} pictures placed${r.missing_product.length ? `, ${r.missing_product.length} codes not found` : ''}${r.missing_file.length ? `, ${r.missing_file.length} files not waiting` : ''}`, r.placed ? 'success' : 'error')
      await load()
    } catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }
  const load = async (offset = 0) => {
    const r = await apiFetch(`/products/pending-images?offset=${offset}&limit=${PAGE}`)
    setTotal(r.total); setStrong(r.strong)
    setItems(xs => offset && xs ? [...xs, ...r.items] : r.items)
  }
  useEffect(() => { load(); apiFetch('/products').then(ps => setProducts(ps || [])) }, [])

  const crumbs = [{ label: 'Products', onClick: () => onNavigate('products') }, { label: 'Match images' }]
  if (!items) return <><Topbar crumbs={crumbs} onNavigate={onNavigate} active="products" /><div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div></>

  const assign = async (it, product_id) => {
    try {
      const r = await apiFetch(`/products/pending-images/${encodeURIComponent(it.file)}/assign`, { method: 'POST', body: JSON.stringify({ product_id }) })
      setItems(xs => xs.filter(x => x.file !== it.file)); setTotal(t => t - 1); showToast(`Picture put on ${r.sku}`, 'success')
    } catch (err) { showToast(err.message, 'error') }
  }
  const skip = async it => {
    try { await apiFetch(`/products/pending-images/${encodeURIComponent(it.file)}`, { method: 'DELETE' }); setItems(xs => xs.filter(x => x.file !== it.file)); setTotal(t => t - 1) }
    catch (err) { showToast(err.message, 'error') }
  }
  const acceptAll = async () => {
    if (!confirm(`Put ${strong} pictures on the products the app is confident about?`)) return
    setBusy('accept')
    try { const r = await apiFetch('/products/pending-images/accept-suggestions', { method: 'POST', body: JSON.stringify({ min_score: 0.9 }) }); showToast(`${r.accepted} pictures placed`, 'success'); await load() }
    catch (err) { showToast(err.message, 'error') }
    setBusy('')
  }

  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} active="products" />
      <div className="page-wrap wide">
        <div className="page-header">
          <div>
            <h1>Match images</h1>
            <p className="lede">{total} picture{total !== 1 ? 's' : ''} waiting. The guess comes from the words in the file name. Accept it, pick another product, or skip the picture.</p>
          </div>
          <div className="spacer" />
          <div className="actions">
            {strong > 0 && <button className="btn btn-primary" onClick={acceptAll} disabled={!!busy}>{busy === 'accept' ? <span className="spinner" /> : `Accept ${strong} confident guesses`}</button>}
            <button className="btn" onClick={() => mapRef.current.click()} disabled={!!busy}>{busy === 'map' ? <span className="spinner" /> : 'Apply mapping file'}</button>
            <input ref={mapRef} type="file" accept=".csv,.txt" style={{ display: 'none' }} onChange={e => { applyMap(e.target.files[0]); e.target.value = '' }} />
            <button className="btn" onClick={() => onNavigate('products')}>Back to products</button>
          </div>
        </div>
        {items.length === 0 ? <div className="empty-state"><h2>Nothing waiting.</h2><p>Import a zip of pictures under Products and anything the codes don't match ends up here.</p></div> : (
          <>
            <div className="match-list">
              {items.map(it => <MatchRow key={it.file} it={it} products={products} onAssign={pid => assign(it, pid)} onSkip={() => skip(it)}
                                         onCreated={p => { setItems(xs => xs.filter(x => x.file !== it.file)); setTotal(t => t - 1); setProducts(ps => [...ps, p]) }} />)}
            </div>
            {items.length < total && (
              <div style={{ textAlign: 'center', marginTop: 16 }}>
                <button className="btn" onClick={() => load(items.length)}>Show more ({total - items.length} left)</button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}

function MatchRow({ it, products, onAssign, onSkip, onCreated }) {
  const src = useAuthImage(it.url)
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [nf, setNf] = useState({ sku: '', name: '', product_type: '' })
  const [saving, setSaving] = useState(false)
  const create = async e => {
    e.preventDefault(); setSaving(true)
    try {
      const p = await apiFetch(`/products/pending-images/${encodeURIComponent(it.file)}/create`, { method: 'POST', body: JSON.stringify(nf) })
      showToast(`${p.sku} added with this picture`, 'success'); onCreated && onCreated(p)
    } catch (err) { showToast(err.message, 'error') }
    setSaving(false)
  }
  const matches = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return []
    return products.filter(p => p.sku.toLowerCase().includes(n) || p.name.toLowerCase().includes(n) || (p.intec_code || '').toLowerCase().includes(n)).slice(0, 8)
  }, [q, products])
  const s = it.suggestion
  const conf = s ? (s.score >= 0.9 ? 'Confident' : s.score >= 0.6 ? 'Likely' : 'Weak guess') : null
  return (
    <div className="match-row">
      <div className="match-thumb">{src ? <img src={src} alt="" /> : <span className="spinner" />}</div>
      <div className="match-file"><div className="mono">{it.file}</div></div>
      <div className="match-sug">
        {s ? (
          <>
            <div><strong>{s.sku}</strong> <span className="muted">{s.name}</span></div>
            <div className="match-meta"><span className={`badge ${s.score >= 0.9 ? 'badge-green' : 'badge-grey'}`}>{conf}</span>{s.has_image && <span className="muted"> already has a picture, this would replace it</span>}</div>
          </>
        ) : <span className="muted">No idea from the name. Search for the product.</span>}
        <div className="typeahead" style={{ marginTop: 8 }}>
          <input className="form-control" placeholder="Or search a product code or name" value={q} onChange={e => setQ(e.target.value)}
                 onKeyDown={e => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); onAssign(matches[0].id) } if (e.key === 'Escape') setQ('') }} />
          {matches.length > 0 && (
            <div className="typeahead-list">
              {matches.map(p => <button key={p.id} onClick={() => onAssign(p.id)}><span className="mono">{p.sku}</span><span className="ta-name">{p.name}</span>{p.image_url && <span className="muted">has picture</span>}</button>)}
            </div>
          )}
        </div>
      </div>
      <div className="match-actions">
        {s && <button className="btn btn-primary btn-sm" onClick={() => onAssign(s.product_id)}>Use {s.sku}</button>}
        <button className="btn btn-soft btn-sm" onClick={() => setCreating(v => !v)}>{creating ? 'Cancel' : 'New product'}</button>
        <button className="btn btn-ghost btn-sm" onClick={onSkip}>Skip</button>
      </div>
      {creating && (
        <form className="match-new" onSubmit={create}>
          <input className="form-control" placeholder="Name, e.g. Gold lever handle" value={nf.name} onChange={e => setNf({ ...nf, name: e.target.value })} required autoFocus />
          <input className="form-control" placeholder="Code (optional)" value={nf.sku} onChange={e => setNf({ ...nf, sku: e.target.value })} />
          <select className="form-control" value={nf.product_type} onChange={e => setNf({ ...nf, product_type: e.target.value })}>
            <option value="">Type…</option>
            {TYPE_ORDER.filter(t => t).map(t => <option key={t} value={t}>{TYPE_NAMES[t]}</option>)}
          </select>
          <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>{saving ? <span className="spinner" /> : 'Save product with this picture'}</button>
        </form>
      )}
    </div>
  )
}
