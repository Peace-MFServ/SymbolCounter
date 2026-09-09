import React, { useState, useEffect, useRef, useMemo } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'
import { useAuthImage } from './TemplatesView'
import { TYPE_NAMES, TYPE_ORDER } from './JobView'

const EMPTY = { sku: '', name: '', category: 'Other', unit: 'EACH', cost: '', sell: '', intec_code: '', product_type: '', brand: '', notes: '', active: true }

export function ProductsView({ onNavigate }) {
  const [products,   setProducts]   = useState([])
  const [cats,       setCats]       = useState([])
  const [loading,    setLoading]    = useState(true)
  const [q,          setQ]          = useState('')
  const [cat,        setCat]        = useState('')
  const [ptype,      setPtype]      = useState(null)    // null = all, '' = untyped, '01'…
  const [editing,    setEditing]    = useState(null)   // product object or EMPTY for new
  const [importing,  setImporting]  = useState(false)
  const fileRef = useRef()

  const load = async () => {
    const [p, c] = await Promise.all([apiFetch('/products'), apiFetch('/products/categories')])
    setProducts(p || []); setCats(c || []); setLoading(false)
  }
  useEffect(() => { load() }, [])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return products.filter(p =>
      (ptype === null || (p.product_type || '') === ptype) &&
      (!cat || p.category === cat) &&
      (!needle || p.sku.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle)
        || (p.intec_code || '').toLowerCase().includes(needle)))
  }, [products, q, cat, ptype])

  const importFile = async file => {
    if (!file) return
    setImporting(true)
    try {
      const form = new FormData(); form.append('file', file)
      const r = await apiFetch('/products/import', { method: 'POST', body: form })
      showToast(`Imported: ${r.added} new, ${r.updated} updated`, 'success')
      await load()
    } catch (err) { showToast('Import failed: ' + err.message, 'error') }
    setImporting(false)
  }

  const crumbs = [{ label: 'Products' }]
  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} active="products" />
      <div className="page-wrap">
        <div className="page-header">
          <div>
            <h1>Products</h1>
            <p className="lede">
              {products.length} products. Prices are Cin7's average cost in euro; a blank one has not landed yet.
            </p>
          </div>
          <div className="spacer" />
          <div className="actions">
            <button className="btn" onClick={() => fileRef.current.click()} disabled={importing}>
              {importing ? <><span className="spinner" /> Importing…</> : 'Import from Cin7'}
            </button>
            <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }}
                   onChange={e => { importFile(e.target.files[0]); e.target.value = '' }} />
            <button className="btn btn-primary" onClick={() => setEditing({ ...EMPTY })}>Add product</button>
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><span className="spinner spinner-lg" /></div>
        ) : products.length === 0 ? (
          <div className="empty-state">
            <h2>No products yet.</h2>
            <p>Export the Products Price List from Cin7 as an Excel file and import it here. Codes, names, categories and costs come across; photos are added as you go.</p>
            <button className="btn btn-primary" onClick={() => fileRef.current.click()}>Import from Cin7</button>
          </div>
        ) : (
          <>
            <div className="filter-row">
              <input className="form-control search" placeholder="Search code, name or Intec code…"
                     value={q} onChange={e => setQ(e.target.value)} />
              <div className="chips">
                <button className={`chip-btn${ptype === null ? ' on' : ''}`} onClick={() => setPtype(null)}>All types</button>
                {TYPE_ORDER.map(t => {
                  const n = products.filter(p => (p.product_type || '') === t).length
                  return n ? <button key={t || 'none'} className={`chip-btn${ptype === t ? ' on' : ''}`} onClick={() => setPtype(ptype === t ? null : t)}>{TYPE_NAMES[t]} {n}</button> : null
                })}
              </div>
            </div>
            <div className="filter-row" style={{ marginTop: -8 }}>
              <div className="chips">
                <button className={`chip-btn${cat === '' ? ' on' : ''}`} onClick={() => setCat('')}>All {products.length}</button>
                {cats.slice(0, 8).map(c => (
                  <button key={c.name} className={`chip-btn${cat === c.name ? ' on' : ''}`}
                          onClick={() => setCat(cat === c.name ? '' : c.name)}>{c.name} {c.count}</button>
                ))}
                {cats.length > 8 && (
                  <select className="form-control chip-select" value={cats.slice(0, 8).some(c => c.name === cat) ? '' : cat}
                          onChange={e => setCat(e.target.value)}>
                    <option value="">More…</option>
                    {cats.slice(8).map(c => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
                  </select>
                )}
              </div>
            </div>

            <table className="ledger prod-table">
              <thead><tr><th>Code</th><th>Product</th><th>Type</th><th style={{ textAlign: 'right' }}>Avg cost</th><th>Photo</th><th>Used in sets</th><th></th></tr></thead>
              <tbody>
                {shown.slice(0, 300).map(p => (
                  <tr key={p.id} onClick={() => setEditing(p)}>
                    <td className="mono">{p.sku}</td>
                    <td>
                      <div className="dwg-name" style={{ fontSize: 15 }}>{p.name}</div>
                      {(p.intec_code || p.notes) && (
                        <div className="proj-meta">{[p.intec_code && `Intec code ${p.intec_code}`, p.notes].filter(Boolean).join(' · ')}</div>
                      )}
                    </td>
                    <td>{p.product_type ? TYPE_NAMES[p.product_type] : <span className="muted">Not set</span>}<div className="proj-meta">{p.category}</div></td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{p.cost != null ? p.cost.toFixed(2) : <span className="muted">—</span>}</td>
                    <td>{p.image_url ? <span className="badge badge-green">Yes</span> : <span className="badge badge-grey">None</span>}</td>
                    <td className="muted" style={{ fontSize: 13 }}>{p.used_in.length ? p.used_in.join(', ') : 'Not used yet'}</td>
                    <td className="row-actions"><button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); setEditing(p) }}>Edit</button></td>
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={7} className="muted" style={{ padding: 24 }}>Nothing matches.</td></tr>}
              </tbody>
            </table>
            {shown.length > 300 && <p className="hint" style={{ marginTop: 8 }}>Showing the first 300 of {shown.length}. Narrow the search to see the rest.</p>}
          </>
        )}
      </div>

      {editing && (
        <ProductModal product={editing} categories={cats.map(c => c.name)}
                      onClose={() => setEditing(null)}
                      onSaved={p => { setEditing(null); load() }} />
      )}
    </>
  )
}

function ProductModal({ product, categories, onClose, onSaved }) {
  const isNew = !product.id
  const [f, setF] = useState({ ...EMPTY, ...product, cost: product.cost ?? '', sell: product.sell ?? '' })
  const [busy, setBusy] = useState(false)
  const [imgUrl, setImgUrl] = useState(product.image_url || '')
  const src = useAuthImage(imgUrl)
  const imgRef = useRef()
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }))

  const save = async e => {
    e.preventDefault()
    setBusy(true)
    try {
      const body = { ...f, cost: f.cost === '' ? null : Number(f.cost), sell: f.sell === '' ? null : Number(f.sell) }
      const saved = isNew
        ? await apiFetch('/products', { method: 'POST', body: JSON.stringify(body) })
        : await apiFetch(`/products/${product.id}`, { method: 'PUT', body: JSON.stringify(body) })
      showToast(isNew ? 'Product added' : 'Product saved', 'success')
      onSaved(saved)
    } catch (err) { showToast(err.message, 'error') }
    setBusy(false)
  }

  const uploadPhoto = async file => {
    if (!file || isNew) return
    try {
      const form = new FormData(); form.append('file', file)
      const p = await apiFetch(`/products/${product.id}/image`, { method: 'POST', body: form })
      setImgUrl(p.image_url + '?t=' + Date.now())
      showToast('Photo saved', 'success')
    } catch (err) { showToast(err.message, 'error') }
  }

  const archive = async () => {
    if (!confirm('Remove this product from the list? Sets that use it keep it.')) return
    await apiFetch(`/products/${product.id}`, { method: 'DELETE' })
    showToast('Product removed', 'info'); onSaved(null)
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 640 }}>
        <h2>{isNew ? 'Add product' : product.sku}</h2>
        <form onSubmit={save}>
          <div className="form-grid">
            <div className="form-group"><label>Code</label><input className="form-control" value={f.sku} onChange={set('sku')} required /></div>
            <div className="form-group"><label>Category</label>
              <input className="form-control" list="cat-list" value={f.category} onChange={set('category')} />
              <datalist id="cat-list">{categories.map(c => <option key={c} value={c} />)}</datalist>
            </div>
          </div>
          <div className="form-group"><label>Name</label><input className="form-control" value={f.name} onChange={set('name')} required /></div>
          <div className="form-grid three">
            <div className="form-group"><label>Average cost <span className="muted">(EUR, from Cin7)</span></label><input className="form-control" type="number" step="0.01" value={f.cost} onChange={set('cost')} placeholder="not in yet" /></div>
            <div className="form-group"><label>Last Intec price <span className="muted">(fallback)</span></label><input className="form-control" type="number" step="0.01" value={f.sell} onChange={set('sell')} placeholder="—" /></div>
            <div className="form-group"><label>Unit</label><input className="form-control" value={f.unit} onChange={set('unit')} /></div>
          </div>
          <div className="form-grid">
            <div className="form-group"><label>Type <span className="muted">(where it sits on a set)</span></label>
              <select className="form-control" value={f.product_type} onChange={set('product_type')}>
                {TYPE_ORDER.map(t => <option key={t || 'none'} value={t}>{t ? `${t} ${TYPE_NAMES[t]}` : 'Not set'}</option>)}
              </select>
            </div>
            <div className="form-group"><label>Brand</label><input className="form-control" value={f.brand} onChange={set('brand')} /></div>
          </div>
          <div className="form-grid">
            <div className="form-group"><label>Intec code <span className="muted">(if different)</span></label><input className="form-control" value={f.intec_code} onChange={set('intec_code')} /></div>
            <div className="form-group"><label>Notes</label><input className="form-control" value={f.notes} onChange={set('notes')} /></div>
          </div>
          {!isNew && (
            <div className="form-group">
              <label>Photo</label>
              <div className="photo-row">
                <div className="photo-box">{src ? <img src={src} alt="" /> : <span className="muted">No photo</span>}</div>
                <button type="button" className="btn btn-sm" onClick={() => imgRef.current.click()}>{imgUrl ? 'Replace photo' : 'Add photo'}</button>
                <input ref={imgRef} type="file" accept="image/*" style={{ display: 'none' }}
                       onChange={e => { uploadPhoto(e.target.files[0]); e.target.value = '' }} />
              </div>
            </div>
          )}
          <div className="modal-actions">
            {!isNew && <button type="button" className="btn btn-ghost danger" onClick={archive}>Remove</button>}
            <div className="spacer" />
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? <span className="spinner" /> : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
