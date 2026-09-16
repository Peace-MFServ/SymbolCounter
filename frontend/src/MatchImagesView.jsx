import React, { useState, useEffect, useMemo } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'
import { useAuthImage } from './TemplatesView'

/* Pictures the zip could not match by code. Each row: the picture, the app's best
   guess, one click to accept, a search to pick something else, or skip. */
export function MatchImagesView({ onNavigate }) {
  const [items, setItems] = useState(null)
  const [products, setProducts] = useState([])
  const [busy, setBusy] = useState('')
  const load = () => apiFetch('/products/pending-images').then(setItems)
  useEffect(() => { load(); apiFetch('/products').then(ps => setProducts(ps || [])) }, [])

  const crumbs = [{ label: 'Products', onClick: () => onNavigate('products') }, { label: 'Match images' }]
  if (!items) return <><Topbar crumbs={crumbs} onNavigate={onNavigate} active="products" /><div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div></>

  const strong = items.filter(i => i.suggestion && i.suggestion.score >= 0.9 && !i.suggestion.has_image).length
  const assign = async (it, product_id) => {
    try {
      const r = await apiFetch(`/products/pending-images/${encodeURIComponent(it.file)}/assign`, { method: 'POST', body: JSON.stringify({ product_id }) })
      setItems(xs => xs.filter(x => x.file !== it.file)); showToast(`Picture put on ${r.sku}`, 'success')
    } catch (err) { showToast(err.message, 'error') }
  }
  const skip = async it => {
    try { await apiFetch(`/products/pending-images/${encodeURIComponent(it.file)}`, { method: 'DELETE' }); setItems(xs => xs.filter(x => x.file !== it.file)) }
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
            <p className="lede">{items.length} picture{items.length !== 1 ? 's' : ''} waiting. The guess comes from the words in the file name. Accept it, pick another product, or skip the picture.</p>
          </div>
          <div className="spacer" />
          <div className="actions">
            {strong > 0 && <button className="btn btn-primary" onClick={acceptAll} disabled={!!busy}>{busy === 'accept' ? <span className="spinner" /> : `Accept ${strong} confident guesses`}</button>}
            <button className="btn" onClick={() => onNavigate('products')}>Back to products</button>
          </div>
        </div>
        {items.length === 0 ? <div className="empty-state"><h2>Nothing waiting.</h2><p>Import a zip of pictures under Products and anything the codes don't match ends up here.</p></div> : (
          <div className="match-list">
            {items.map(it => <MatchRow key={it.file} it={it} products={products} onAssign={pid => assign(it, pid)} onSkip={() => skip(it)} />)}
          </div>
        )}
      </div>
    </>
  )
}

function MatchRow({ it, products, onAssign, onSkip }) {
  const src = useAuthImage(it.url)
  const [q, setQ] = useState('')
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
        <button className="btn btn-ghost btn-sm" onClick={onSkip}>Skip</button>
      </div>
    </div>
  )
}
