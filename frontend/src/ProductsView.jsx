import React, { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch } from './api'
import { showToast } from './toast'
import { Topbar, place } from './Dashboard'
import { useAuthImage } from './TemplatesView'
import { TYPE_NAMES, TYPE_ORDER, money } from './JobView'
import { useLeaveGuard } from './unsaved'
import { IconSearch, IconPlus, IconImage, IconChevron, IconFile, IconBox, IconLayers, IconUpload } from './icons'

const EMPTY = { sku: '', name: '', category: 'Other', unit: 'EACH', cost: '', sell: '', intec_code: '', product_type: '', brand: '', notes: '', active: true }

const PAGE_SIZES = [25, 50, 100]
/* The columns the list can be put in order by, and what to read off a product for each. */
const SORTS = {
  sku:  p => (p.sku || '').toLowerCase(),
  name: p => (p.name || '').toLowerCase(),
  type: p => TYPE_ORDER.indexOf(p.product_type || ''),
  cost: p => (p.cost == null ? -Infinity : p.cost),
  used: p => p.used_in.length,
}

export function ProductsView({ onNavigate }) {
  const [products,   setProducts]   = useState([])
  const [cats,       setCats]       = useState([])
  const [loading,    setLoading]    = useState(true)
  const [q,          setQ]          = useState('')
  const [cat,        setCat]        = useState('')
  const [brand,      setBrand]      = useState('')
  const [setName,    setSetName]    = useState('')
  const [ptype,      setPtype]      = useState(null)    // null = all, '' = untyped, '01'…
  const [withPhoto,  setWithPhoto]  = useState(false)
  const [costOnly,   setCostOnly]   = useState('')      // '' | 'priced' | 'none'
  const [usedOnly,   setUsedOnly]   = useState('')      // '' | 'used' | 'free'
  const [sort,       setSort]       = useState({ key: 'sku', dir: 1 })
  const [page,       setPage]       = useState(1)
  const [pageSize,   setPageSize]   = useState(50)
  const [editing,    setEditing]    = useState(null)   // product object or EMPTY for new
  const [importing,  setImporting]  = useState(false)
  const [pasting,    setPasting]    = useState(false)
  const [imgReport,  setImgReport]  = useState(null)
  const [pendingN,   setPendingN]   = useState(0)
  useEffect(() => { apiFetch('/products/pending-images?limit=1').then(r => setPendingN(r?.total || 0)).catch(() => {}) }, [imgReport])
  const [imgBusy,    setImgBusy]    = useState(false)
  const zipRef = useRef()
  const importImages = async file => {
    if (!file) return
    setImgBusy(true)
    try {
      const form = new FormData(); form.append('file', file)
      const r = await apiFetch('/products/import-images', { method: 'POST', body: form })
      setImgReport(r); await load()
    } catch (err) { showToast('Image import failed: ' + err.message, 'error') }
    setImgBusy(false)
  }
  const fileRef = useRef()

  const load = async () => {
    const [p, c] = await Promise.all([apiFetch('/products'), apiFetch('/products/categories')])
    setProducts(p || []); setCats(c || []); setLoading(false)
  }
  useEffect(() => { load() }, [])

  // everything except the chip row, so the chip counts can be read off it
  const base = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return products.filter(p =>
      (!cat || p.category === cat) &&
      (!brand || (p.brand || '') === brand) &&
      (!setName || p.used_in.includes(setName)) &&
      (costOnly === '' || (costOnly === 'priced' ? p.cost != null : p.cost == null)) &&
      (usedOnly === '' || (usedOnly === 'used' ? p.used_in.length > 0 : p.used_in.length === 0)) &&
      (!needle || p.sku.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle)
        || (p.intec_code || '').toLowerCase().includes(needle)))
  }, [products, q, cat, brand, setName, costOnly, usedOnly])

  const shown = useMemo(() => {
    const rows = base.filter(p =>
      (ptype === null || (p.product_type || '') === ptype) && (!withPhoto || p.image_url))
    const read = SORTS[sort.key] || SORTS.sku
    return [...rows].sort((a, b) => {
      const x = read(a), y = read(b)
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
    })
  }, [base, ptype, withPhoto, sort])

  const pages = Math.max(1, Math.ceil(shown.length / pageSize))
  const cur = Math.min(page, pages)
  const rows = shown.slice((cur - 1) * pageSize, cur * pageSize)
  // any change to what is being looked for starts again at the front
  useEffect(() => { setPage(1) }, [q, cat, brand, setName, costOnly, usedOnly, ptype, withPhoto, pageSize])

  const brands = useMemo(() => [...new Set(products.map(p => p.brand).filter(Boolean))].sort(), [products])
  const setNames = useMemo(() => [...new Set(products.flatMap(p => p.used_in))].sort(), [products])
  const typeCounts = useMemo(() => {
    const n = {}
    for (const p of base) { const t = p.product_type || ''; n[t] = (n[t] || 0) + 1 }
    return n
  }, [base])
  const photoCount = base.filter(p => p.image_url).length
  const extraFilters = (costOnly ? 1 : 0) + (usedOnly ? 1 : 0)

  const by = key => () => setSort(s => ({ key, dir: s.key === key ? -s.dir : 1 }))
  const arrow = key => (sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '')

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

  // the three-dot menu hands a product over here to get its picture changed
  const photoRef = useRef()
  const [photoFor, setPhotoFor] = useState(null)
  const uploadPhoto = async file => {
    if (!file || !photoFor) return
    try {
      const form = new FormData(); form.append('file', file)
      await apiFetch(`/products/${photoFor}/image`, { method: 'POST', body: form })
      showToast('Photo saved', 'success'); await load()
    } catch (err) { showToast(err.message, 'error') }
    setPhotoFor(null)
  }
  const pickPhoto = p => { setPhotoFor(p.id); setTimeout(() => photoRef.current?.click(), 0) }
  const removeProduct = async p => {
    if (!confirm(`Remove ${p.sku} from the list? Sets that use it keep it.`)) return
    try {
      await apiFetch(`/products/${p.id}`, { method: 'DELETE' })
      showToast('Product removed', 'info'); await load()
    } catch (err) { showToast(err.message, 'error') }
  }

  return (
    <>
      <Topbar onNavigate={onNavigate} active="products" />
      <div className="page-wrap adm-wrap">
        <div className="adm-head">
          <div className="adm-title">
            <h1>Products</h1>
            <p className="lede">{products.length} products. Prices are the Cin7 average cost in euro.</p>
          </div>
          <div className="adm-actions">
            <button className="btn btn-line" onClick={() => fileRef.current.click()} disabled={importing}>
              {importing ? <><span className="spinner" /> Importing…</> : <><IconBox size={17} /> Import from Cin7</>}
            </button>
            <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }}
                   onChange={e => { importFile(e.target.files[0]); e.target.value = '' }} />
            <button className="btn btn-line" onClick={() => zipRef.current.click()} disabled={imgBusy}>
              {imgBusy ? <><span className="spinner" /> Importing images…</> : <><IconImage size={17} /> Import images</>}
            </button>
            <input ref={zipRef} type="file" accept=".zip" style={{ display: 'none' }} onChange={e => { importImages(e.target.files[0]); e.target.value = '' }} />
            {pendingN > 0 && (
              <button className="btn btn-soft" onClick={() => onNavigate('match-images')}>
                <IconLayers size={17} /> Match images ({pendingN})
              </button>
            )}
            <button className="btn btn-line" onClick={() => setPasting(true)}><IconFile size={17} /> Intec prices</button>
            <button className="btn btn-primary" onClick={() => setEditing({ ...EMPTY })}><IconPlus size={17} /> Add product</button>
          </div>
        </div>
        <input ref={photoRef} type="file" accept="image/*" style={{ display: 'none' }}
               onChange={e => { uploadPhoto(e.target.files[0]); e.target.value = '' }} />
        {imgReport && <ImageReportModal r={imgReport} onClose={() => setImgReport(null)} onMatch={() => { setImgReport(null); onNavigate('match-images') }} />}
        {pasting && <IntecPasteModal onClose={() => setPasting(false)} onDone={async () => { setPasting(false); await load() }} />}

        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><span className="spinner spinner-lg" /></div>
        ) : products.length === 0 ? (
          <div className="empty-state">
            <h2>No products yet.</h2>
            <p>Import the Cin7 Products Price List to load the catalogue.</p>
            <button className="btn btn-primary" onClick={() => fileRef.current.click()}>Import from Cin7</button>
          </div>
        ) : (
          <>
            <div className="adm-filters">
              <label className="adm-search">
                <IconSearch size={17} />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search code, name or type..." />
              </label>
              {cats.length > 1 && (
                <Picker value={cat} onChange={setCat} all="All categories"
                        options={cats.map(c => ({ value: c.name, label: `${c.name} (${c.count})` }))} />
              )}
              {brands.length > 0 && (
                <Picker value={brand} onChange={setBrand} all="All brands"
                        options={brands.map(b => ({ value: b, label: b }))} />
              )}
              {setNames.length > 0 && (
                <Picker value={setName} onChange={setSetName} all="All sets"
                        options={setNames.map(s => ({ value: s, label: s }))} />
              )}
              <FilterMenu count={extraFilters} onClear={() => { setCostOnly(''); setUsedOnly('') }}>
                <FilterGroup label="Cost" value={costOnly} onChange={setCostOnly} options={[
                  { value: '', label: 'Any' }, { value: 'priced', label: 'Has a cost' }, { value: 'none', label: 'No cost yet' }]} />
                <FilterGroup label="Used in sets" value={usedOnly} onChange={setUsedOnly} options={[
                  { value: '', label: 'Any' }, { value: 'used', label: 'In a set' }, { value: 'free', label: 'Not used yet' }]} />
              </FilterMenu>
            </div>

            <div className="prods-chips">
              <button className={`pchip${ptype === null && !withPhoto ? ' on' : ''}`}
                      onClick={() => { setPtype(null); setWithPhoto(false) }}>All ({base.length})</button>
              <button className={`pchip${withPhoto ? ' on' : ''}`} onClick={() => setWithPhoto(v => !v)}>With pictures ({photoCount})</button>
              {TYPE_ORDER.map(t => typeCounts[t]
                ? <button key={t || 'none'} className={`pchip${ptype === t ? ' on' : ''}`}
                          onClick={() => setPtype(ptype === t ? null : t)}>{TYPE_NAMES[t]} ({typeCounts[t]})</button>
                : null)}
            </div>

            <div className="adm-card">
              <div className="adm-scroll">
                <table className="prod-grid">
                  <colgroup>
                    <col style={{ width: 112 }} /><col style={{ width: '14%' }} /><col style={{ width: '32%' }} />
                    <col style={{ width: '15%' }} /><col style={{ width: '10%' }} /><col style={{ width: '15%' }} />
                    <col style={{ width: 148 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Image</th>
                      <th><button className="th-sort" onClick={by('sku')}>Code{arrow('sku')}</button></th>
                      <th><button className="th-sort" onClick={by('name')}>Product{arrow('name')}</button></th>
                      <th><button className="th-sort" onClick={by('type')}>Type{arrow('type')}</button></th>
                      <th className="num"><button className="th-sort" onClick={by('cost')}>Avg cost{arrow('cost')}</button></th>
                      <th><button className="th-sort" onClick={by('used')}>Used in sets{arrow('used')}</button></th>
                      <th className="num">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(p => (
                      <tr key={p.id}>
                        <td><ProdThumb url={p.image_url} onUpload={() => pickPhoto(p)} /></td>
                        <td className="p-code">{p.sku}</td>
                        <td>
                          <div className="p-name">{p.name}</div>
                          {(p.intec_code || p.notes) && (
                            <div className="p-meta">{[p.intec_code && `Intec code ${p.intec_code}`, p.notes].filter(Boolean).join(' · ')}</div>
                          )}
                        </td>
                        <td>
                          <div className={`p-type${p.product_type ? '' : ' unset'}`}>{p.product_type ? TYPE_NAMES[p.product_type] : 'Not set'}</div>
                          <div className="p-meta">{p.category || 'Other'}</div>
                        </td>
                        <td className="num p-cost">{p.cost != null ? `€${money(p.cost)}` : <span className="p-dash">—</span>}</td>
                        <td>
                          {p.used_in.length ? (
                            <>
                              <div className="p-used">{p.used_in.length} set{p.used_in.length !== 1 ? 's' : ''}</div>
                              <div className="p-meta" title={p.used_in.join(', ')}>{p.used_in.join(', ')}</div>
                            </>
                          ) : <span className="p-dash">Not used yet</span>}
                        </td>
                        <td className="num">
                          <div className="p-actions">
                            <button className="btn btn-soft btn-edit" onClick={e => { e.stopPropagation(); setEditing(p) }}>Edit</button>
                            <ProdMenu onEdit={() => setEditing(p)} onRemove={() => removeProduct(p)} />
                          </div>
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr className="no-hover"><td colSpan={7} className="adm-none">No products match what you are looking for.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {shown.length > 0 && (
                <div className="adm-foot">
                  <span className="adm-count">
                    Showing <strong>{(cur - 1) * pageSize + 1}–{Math.min(cur * pageSize, shown.length)}</strong> of {shown.length} product{shown.length !== 1 ? 's' : ''}
                  </span>
                  <div className="adm-pager">
                    <Picker value={String(pageSize)} onChange={v => setPageSize(Number(v))} small
                            options={PAGE_SIZES.map(n => ({ value: String(n), label: `${n} per page` }))} />
                    <Pager page={cur} pages={pages} onGo={setPage} />
                  </div>
                </div>
              )}
            </div>
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

/* A plain select dressed to match the filter row. */
export function Picker({ value, onChange, options, all, small = false }) {
  return (
    <div className={`picker${small ? ' small' : ''}`}>
      <select value={value} onChange={e => onChange(e.target.value)}>
        {all && <option value="">{all}</option>}
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <IconChevron size={16} />
    </div>
  )
}

/* The filters that are used less often, kept out of the way until asked for.
   Each page fills it with its own groups. */
export function FilterMenu({ count, onClear, children }) {
  const [open, setOpen] = useState(false)
  const ref = useRef()
  useEffect(() => {
    if (!open) return
    const away = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const key = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key) }
  }, [open])
  return (
    <div className="more-filters" ref={ref}>
      <button className={`btn btn-line more-btn${count ? ' on' : ''}`} onClick={() => setOpen(v => !v)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 3H2l8 9.5V20l4 2v-9.5Z" /></svg>
        More filters{count ? ` (${count})` : ''}
      </button>
      {open && (
        <div className="more-pop">
          {children}
          <div className="more-foot"><button className="btn btn-ghost btn-sm" onClick={onClear}>Clear</button></div>
        </div>
      )}
    </div>
  )
}

/* One labelled row of choices inside the More filters panel. */
export function FilterGroup({ label, value, onChange, options }) {
  return (
    <div className="more-group">
      <label>{label}</label>
      <div className="more-opts">
        {options.map(o => (
          <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
        ))}
      </div>
    </div>
  )
}

/* Previous, a window of page numbers with gaps marked, next. */
export function Pager({ page, pages, onGo }) {
  const nums = []
  const push = n => { if (!nums.includes(n)) nums.push(n) }
  push(1)
  for (let n = page - 1; n <= page + 1; n++) if (n > 1 && n < pages) push(n)
  if (page <= 3) for (let n = 2; n <= Math.min(5, pages - 1); n++) push(n)
  if (page >= pages - 2) for (let n = Math.max(2, pages - 4); n < pages; n++) push(n)
  if (pages > 1) push(pages)
  nums.sort((a, b) => a - b)
  const out = []
  nums.forEach((n, i) => {
    if (i && n - nums[i - 1] > 1) out.push(<span key={`gap${n}`} className="pg-gap">…</span>)
    out.push(<button key={n} className={`pg${n === page ? ' on' : ''}`} onClick={() => onGo(n)}>{n}</button>)
  })
  return (
    <div className="pager">
      <button className="pg arrow" disabled={page <= 1} onClick={() => onGo(page - 1)} aria-label="Previous page">
        <IconChevron size={16} style={{ transform: 'rotate(90deg)' }} />
      </button>
      {out}
      <button className="pg arrow" disabled={page >= pages} onClick={() => onGo(page + 1)} aria-label="Next page">
        <IconChevron size={16} style={{ transform: 'rotate(-90deg)' }} />
      </button>
    </div>
  )
}

/* The row's spare actions, drawn on top of the page so the card cannot clip them. */
function ProdMenu({ onEdit, onRemove }) {
  const [at, setAt] = useState(null)
  const ref = useRef()
  const pop = useRef()
  useEffect(() => {
    if (!at) return
    const away = e => {
      const inside = (ref.current && ref.current.contains(e.target)) || (pop.current && pop.current.contains(e.target))
      if (!inside) setAt(null)
    }
    const key = e => { if (e.key === 'Escape') setAt(null) }
    const follow = () => { if (ref.current) setAt(place(ref.current)) }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key)
    window.addEventListener('scroll', follow, true); window.addEventListener('resize', follow)
    return () => {
      document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key)
      window.removeEventListener('scroll', follow, true); window.removeEventListener('resize', follow)
    }
  }, [!!at])
  const pick = fn => e => { e.stopPropagation(); setAt(null); fn() }
  return (
    <div className="row-menu" ref={ref} onClick={e => e.stopPropagation()}>
      <button className="row-dots" aria-label="More actions" onClick={e => setAt(at ? null : place(e.currentTarget))}>···</button>
      {at && createPortal(
        <div className="menu-list row-menu-pop" role="menu" ref={pop}
             style={{ position: 'fixed', top: at.top, right: at.right }} onClick={e => e.stopPropagation()}>
          <button role="menuitem" onClick={pick(onEdit)}>Edit details</button>
          <button role="menuitem" className="danger" onClick={pick(onRemove)}>Remove product</button>
        </div>, document.body)}
    </div>
  )
}

function ProductModal({ product, categories, onClose, onSaved }) {
  const isNew = !product.id
  const [f, setF] = useState({ ...EMPTY, ...product, cost: product.cost ?? '', sell: product.sell ?? '' })
  const [busy, setBusy] = useState(false)
  const [imgUrl, setImgUrl] = useState(product.image_url || '')
  const src = useAuthImage(imgUrl)
  const imgRef = useRef()
  const [start] = useState(() => ({ ...EMPTY, ...product, cost: product.cost ?? '', sell: product.sell ?? '' }))
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }))
  const dirty = Object.keys(f).some(k => String(f[k] ?? '') !== String(start[k] ?? ''))

  const save = async e => {
    e?.preventDefault?.()
    setBusy(true)
    let ok = true
    try {
      const body = { ...f, cost: f.cost === '' ? null : Number(f.cost), sell: f.sell === '' ? null : Number(f.sell) }
      const saved = isNew
        ? await apiFetch('/products', { method: 'POST', body: JSON.stringify(body) })
        : await apiFetch(`/products/${product.id}`, { method: 'PUT', body: JSON.stringify(body) })
      showToast(isNew ? 'Product added' : 'Product saved', 'success')
      onSaved(saved)
    } catch (err) { showToast(err.message, 'error'); ok = false }
    setBusy(false)
    return ok
  }
  const { guard, modal: leaveModal } = useLeaveGuard({ dirty, onSave: save, what: isNew ? 'new product' : 'product' })
  const close = guard(onClose)

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
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && close()}>
      {leaveModal}
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
            <div className="form-group"><label>Average cost <span className="muted">(from Cin7)</span></label><input className="form-control" type="number" step="0.01" value={f.cost} onChange={set('cost')} placeholder="not in yet" /></div>
            <div className="form-group"><label>Last Intec price <span className="muted">(fallback)</span></label><input className="form-control" type="number" step="0.01" value={f.sell} onChange={set('sell')} placeholder="—" /></div>
            <div className="form-group"><label>Unit</label><input className="form-control" value={f.unit} onChange={set('unit')} /></div>
          </div>
          <div className="form-grid">
            <div className="form-group"><label>Type</label>
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
            <button type="button" className="btn btn-ghost" onClick={close}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? <span className="spinner" /> : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}


/* Paste the rows out of Intec's Cost Summary grid: sell prices land on the product file. */
function IntecPasteModal({ onClose, onDone }) {
  const [text, setText] = useState('')
  const [updateCost, setUpdateCost] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      const r = await apiFetch('/products/import-intec-costs', { method: 'POST', body: JSON.stringify({ text, update_cost: updateCost }) })
      showToast(`${r.rows} rows read: ${r.updated} products updated, ${r.added} added`, 'success')
      await onDone()
    } catch (err) { showToast(err.message, 'error') }
    setBusy(false)
  }
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 720 }}>
        <h2>Sell prices from Intec</h2>
        <p className="muted" style={{ marginBottom: 12 }}>
          In Intec, open a job's Cost Summary, select all the rows, copy, and paste them here.
          Each product's sell price is updated. Products not in the file yet are added.
        </p>
        <textarea className="form-control" rows={12} value={text} onChange={e => setText(e.target.value)}
                  placeholder={'CH311\tEuro Profile Escutcheon 4mm Stainless steel\t21.00\t0.87\t49.43\t1.30\t0.00\t0.00\t1.30\t27.30\t33.08'}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, whiteSpace: 'pre' }} />
        <label className="check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={updateCost} onChange={e => setUpdateCost(e.target.checked)} />
          Also overwrite costs with Intec's (normally leave off: Cin7 is the source of cost)
        </label>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={submit} disabled={busy || !text.trim()}>{busy ? <span className="spinner" /> : 'Import prices'}</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}


/* What the zip did: matched, no product for this file, second picture for the same product. */
function ImageReportModal({ r, onClose, onMatch }) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 720 }}>
        <h2>Images imported</h2>
        <div className="total-row"><span>Pictures matched to a product</span><strong>{r.matched}</strong></div>
        <div className="total-row"><span>Files with no matching product code</span><strong>{r.unmatched.length}</strong></div>
        <div className="total-row last"><span>Duplicates (a second picture for the same product, skipped)</span><strong>{r.duplicates.length}</strong></div>
        {r.unmatched.length > 0 && (
          <p style={{ margin: '16px 0 0' }}>The {r.unmatched.length} unmatched pictures are kept. On the next screen the app guesses the product from the file name and you confirm each one.</p>
        )}
        {r.duplicates.length > 0 && (
          <>
            <h3 style={{ margin: '16px 0 6px', fontSize: 14 }}>Duplicates skipped</h3>
            <pre className="report-list">{r.duplicates.map(d => `${d.sku}  ←  ${d.file}`).join('\n')}</pre>
          </>
        )}
        <div className="modal-actions">
          {r.unmatched.length > 0 && <button className="btn btn-primary" onClick={onMatch}>Match them now</button>}
          <button className={r.unmatched.length > 0 ? 'btn btn-ghost' : 'btn btn-primary'} onClick={onClose}>{r.unmatched.length > 0 ? 'Later' : 'Done'}</button>
        </div>
      </div>
    </div>
  )
}


/* 72px picture box. A product with no picture shows an upload box instead. */
function ProdThumb({ url, onUpload }) {
  const src = useAuthImage(url)
  if (url) return <span className="prod-pic">{src ? <img src={src} alt="" /> : null}</span>
  return (
    <button type="button" className="prod-pic empty" title="Add photo"
            onClick={e => { e.stopPropagation(); onUpload() }}>
      <IconUpload size={21} />
      <span>Upload</span>
    </button>
  )
}
