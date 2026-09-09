import React, { useState, useEffect, useMemo, useRef } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'
import { TYPE_NAMES, TYPE_ORDER, groupItems, money } from './JobView'

/* ── The standard set library ─────────────────────────────────────────────── */
export function SetsView({ onNavigate, autoImport = false }) {
  const [sets, setSets] = useState([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [importing, setImporting] = useState('')
  const intecRef = useRef()
  const jsonRef = useRef()

  const load = () => apiFetch('/sets').then(s => { setSets(s || []); setLoading(false) })
  useEffect(() => { load(); if (autoImport) setTimeout(() => intecRef.current?.click(), 300) }, [])

  const importIntec = async files => {
    const pdfs = Array.from(files || []).filter(f => f.name.toLowerCase().endsWith('.pdf'))
    if (!pdfs.length) return
    setImporting('intec')
    let totals = { products_added: 0, sets_added: 0, sets_reused: 0 }, fails = 0
    for (const f of pdfs) {
      const form = new FormData(); form.append('file', f)
      try { const r = await apiFetch('/sets/import-intec', { method: 'POST', body: form }); for (const k of Object.keys(totals)) totals[k] += r[k] || 0 }
      catch (err) { fails++; showToast(`${f.name}: ${err.message}`, 'error') }
    }
    if (pdfs.length > fails) showToast(`${totals.sets_added} new set${totals.sets_added !== 1 ? 's' : ''}, ${totals.products_added} new product${totals.products_added !== 1 ? 's' : ''}${totals.sets_reused ? `, ${totals.sets_reused} already there` : ''}`, 'success')
    setImporting(''); load()
  }
  const importJson = async file => {
    if (!file) return
    setImporting('json')
    try {
      const form = new FormData(); form.append('file', file)
      const r = await apiFetch('/sets/import-json', { method: 'POST', body: form })
      showToast(`${r.sets_added} set${r.sets_added !== 1 ? 's' : ''} added, ${r.sets_updated} refreshed, ${r.products_added} product${r.products_added !== 1 ? 's' : ''} created`, 'success')
    } catch (err) { showToast(err.message, 'error') }
    setImporting(''); load()
  }
  const copy = async (e, s) => {
    e.stopPropagation()
    try { const c = await apiFetch(`/sets/${s.id}/copy`, { method: 'POST' }); showToast(`Copied as ${c.code}`, 'success'); onNavigate('set', { id: c.id }) }
    catch (err) { showToast(err.message, 'error') }
  }
  const remove = async (e, s) => {
    e.stopPropagation()
    const used = s.used_on.length
    const msg = used
      ? `${s.code} ${s.name} is on ${s.used_on.map(u => `${u.project} (${u.doors} doors)`).join(', ')}.\n\nDelete it anyway? Those doors will be left without a set.`
      : `Delete set ${s.code} ${s.name}?`
    if (!confirm(msg)) return
    try { await apiFetch(`/sets/${s.id}${used ? '?force=true' : ''}`, { method: 'DELETE' }); showToast('Set deleted', 'info'); load() }
    catch (err) { showToast(err.message, 'error') }
  }

  const shown = sets.filter(s => {
    const n = q.trim().toLowerCase()
    return !n || s.code.toLowerCase().includes(n) || s.name.toLowerCase().includes(n) || s.items.some(i => i.sku.toLowerCase().includes(n))
  })

  return (
    <>
      <Topbar crumbs={[{ label: 'Sets' }]} onNavigate={onNavigate} active="sets" />
      <div className="page-wrap">
        <div className="page-header">
          <div><h1>Standard sets</h1><p className="lede">The hardware for each kind of door, built once and put on every job that has that door.</p></div>
          <div className="spacer" />
          <div className="actions">
            <input ref={intecRef} type="file" accept=".pdf" multiple style={{ display: 'none' }} onChange={e => { importIntec(e.target.files); e.target.value = '' }} />
            <input ref={jsonRef} type="file" accept=".json" style={{ display: 'none' }} onChange={e => { importJson(e.target.files[0]); e.target.value = '' }} />
            <button className="btn" onClick={() => jsonRef.current.click()} disabled={!!importing}>{importing === 'json' ? <span className="spinner" /> : 'Import set file'}</button>
            <button className="btn" onClick={() => intecRef.current.click()} disabled={!!importing}>{importing === 'intec' ? <span className="spinner" /> : 'Import Intec schedule'}</button>
            <button className="btn btn-primary" onClick={() => onNavigate('set', { id: 'new' })}>New set</button>
          </div>
        </div>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><span className="spinner spinner-lg" /></div>
        ) : sets.length === 0 ? (
          <div className="empty-state">
            <h2>No sets yet.</h2>
            <p>Load the office's standard sets from the set file, or drop in old Intec schedule PDFs and every set on them is created. You can also build one by hand.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="btn btn-primary" onClick={() => jsonRef.current.click()}>Import set file</button>
              <button className="btn" onClick={() => intecRef.current.click()}>Import Intec schedule</button>
              <button className="btn" onClick={() => onNavigate('set', { id: 'new' })}>New set</button>
            </div>
          </div>
        ) : (
          <>
            <div className="filter-row"><input className="form-control search" placeholder="Search sets or product codes…" value={q} onChange={e => setQ(e.target.value)} /></div>
            <table className="ledger">
              <thead><tr><th>Set</th><th>Products</th><th className="num">Items per door</th><th className="num">Value per door</th><th>Used on</th><th></th></tr></thead>
              <tbody>
                {shown.map(s => (
                  <tr key={s.id} onClick={() => onNavigate('set', { id: s.id })}>
                    <td><div className="proj-name">{s.code} <span style={{ fontWeight: 400 }}>{s.name}</span></div>
                        <div className="proj-meta">{s.fire_rated ? 'Fire rated' : 'Not fire rated'}{s.description ? ` · ${s.description}` : ''}{s.locked_by ? ` · ${s.locked_by} is editing` : ''}</div></td>
                    <td className="muted" style={{ fontSize: 13, maxWidth: 380 }}>{s.items.map(i => i.sku).join(', ') || 'Empty'}</td>
                    <td className="num count-num">{s.items_per_door}</td>
                    <td className="num">{s.value_per_door != null ? money(s.value_per_door) : <span className="muted">—</span>}</td>
                    <td className="muted" style={{ fontSize: 13 }}>{s.used_on.length ? s.used_on.map(u => `${u.project} (${u.doors})`).join(', ') : 'Not used yet'}</td>
                    <td className="row-actions">
                      <button className="btn btn-sm" onClick={e => { e.stopPropagation(); onNavigate('set', { id: s.id }) }}>Open</button>
                      <button className="btn btn-ghost btn-sm" onClick={e => copy(e, s)}>Copy</button>
                      <button className="btn btn-ghost btn-sm danger" onClick={e => remove(e, s)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </>
  )
}

/* ── One set, grouped the Intec way: hinges, closers, locks, handles, signage, protection, accessories ── */
export function SetEditor({ id, projectId, onNavigate }) {
  const isNew = id === 'new'
  const [set, setSet]       = useState(null)
  const [code, setCode]     = useState('')
  const [name, setName]     = useState('')
  const [desc, setDesc]     = useState('')
  const [fire, setFire]     = useState(false)
  const [items, setItems]   = useState([])
  const [products, setProducts] = useState([])
  const [q, setQ]           = useState('')
  const [busy, setBusy]     = useState(false)
  const [dirty, setDirty]   = useState(false)
  const [lockedBy, setLockedBy] = useState('')
  const [job, setJob]       = useState(null)
  const searchRef = useRef()
  const heartbeat = useRef()

  useEffect(() => {
    apiFetch('/products').then(p => setProducts(p || []))
    if (projectId) apiFetch(`/projects/${projectId}`).then(setJob)
    if (isNew) {
      apiFetch('/sets/next-code').then(r => setCode(r?.code || 'MF 01'))
      setSet({ items: [], used_on: [], is_standard: !projectId })
      return
    }
    let alive = true
    const open = async () => {
      const s = await apiFetch(`/sets/${id}`)
      if (!s || !alive) return
      setSet(s); setCode(s.code); setName(s.name); setDesc(s.description); setFire(s.fire_rated)
      setItems(s.items.map(i => ({ ...i })))
      try {
        await apiFetch(`/sets/${id}/lock`, { method: 'POST' })
        heartbeat.current = setInterval(() => apiFetch(`/sets/${id}/lock`, { method: 'POST' }).catch(() => {}), 120000)
      } catch (err) { setLockedBy(err.message.replace(/^.*?:\s*/, '')) }
    }
    open()
    return () => {
      alive = false
      if (heartbeat.current) clearInterval(heartbeat.current)
      apiFetch(`/sets/${id}/lock`, { method: 'DELETE' }).catch(() => {})
    }
  }, [id])

  const readOnly = !!lockedBy
  const matches = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return []
    const have = new Set(items.map(i => i.product_id))
    return products.filter(p => !have.has(p.id) && (p.sku.toLowerCase().includes(n) || p.name.toLowerCase().includes(n))).slice(0, 8)
  }, [q, products, items])

  const add = p => {
    setItems(xs => [...xs, { product_id: p.id, sku: p.sku, name: p.name, qty: 1, price: p.price, unit: p.unit, product_type: p.product_type || '' }])
    setQ(''); setDirty(true); searchRef.current?.focus()
  }
  const setQty = (pid, v) => { setItems(xs => xs.map(i => i.product_id === pid ? { ...i, qty: Math.max(1, Number(v) || 1) } : i)); setDirty(true) }
  const remove = pid => { setItems(xs => xs.filter(i => i.product_id !== pid)); setDirty(true) }
  const swap = (oldItem, p) => {
    setItems(xs => xs.map(i => i.product_id === oldItem.product_id ? { product_id: p.id, sku: p.sku, name: p.name, qty: i.qty, price: p.price, unit: p.unit, product_type: p.product_type || '' } : i))
    setDirty(true)
  }

  const save = async () => {
    if (!name.trim()) { showToast('Give the set a name', 'error'); return }
    setBusy(true)
    try {
      const body = { code, name, description: desc, fire_rated: fire, notes: '', items: items.map(i => ({ product_id: i.product_id, qty: i.qty })) }
      const s = isNew ? await apiFetch('/sets', { method: 'POST', body: JSON.stringify(body) })
                      : await apiFetch(`/sets/${id}`, { method: 'PUT', body: JSON.stringify(body) })
      if (isNew && projectId) await apiFetch(`/projects/${projectId}/sets/${s.id}/add`, { method: 'POST' })
      showToast('Set saved', 'success'); setDirty(false)
      if (isNew) onNavigate('set', { id: s.id, projectId }); else setSet(s)
    } catch (err) { showToast(err.message, 'error') }
    setBusy(false)
  }
  const back = () => (projectId ? onNavigate('job', { id: projectId }) : onNavigate('sets'))
  const archive = async () => {
    if (isNew) return
    const used = set.used_on?.length || 0
    const msg = !set.is_standard ? 'Delete this copy? Its doors on the job will be left without a set.'
      : used ? `This set is on ${set.used_on.map(u => u.project).join(', ')}.\n\nDelete it anyway? Those doors will be left without a set.`
      : 'Delete this set?'
    if (!confirm(msg)) return
    try { await apiFetch(`/sets/${id}${used || !set.is_standard ? '?force=true' : ''}`, { method: 'DELETE' }); showToast('Set deleted', 'info'); back() }
    catch (err) { showToast(err.message, 'error') }
  }

  const groups = groupItems(items)
  const perDoor = items.reduce((s, i) => s + i.qty, 0)
  const priced = items.length > 0 && items.every(i => i.price != null)
  const value = items.reduce((s, i) => s + (i.price || 0) * i.qty, 0)

  const crumbs = projectId
    ? [{ label: 'Projects', onClick: () => onNavigate('dashboard') }, { label: job?.name || '…', onClick: back }, { label: isNew ? 'New set' : code }]
    : [{ label: 'Sets', onClick: back }, { label: isNew ? 'New set' : `${code} ${name}` }]
  if (!set) return <><Topbar crumbs={crumbs} onNavigate={onNavigate} active="sets" /><div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div></>

  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} active={projectId ? 'projects' : 'sets'} />
      <div className="page-wrap">
        {readOnly && <div className="suggest-bar"><div><strong>{lockedBy} has this set open.</strong><span className="muted"> You can look but not save. It frees up when they close it.</span></div></div>}
        <div className="page-header" style={{ alignItems: 'flex-start' }}>
          <div className="set-title">
            <input className="set-code" value={code} onChange={e => { setCode(e.target.value); setDirty(true) }} placeholder="MF 01" disabled={readOnly} />
            <input className="set-name" value={name} onChange={e => { setName(e.target.value); setDirty(true) }} placeholder="Int Sgl Bathroom Doors FR" disabled={readOnly} />
            <input className="form-control set-desc" value={desc} onChange={e => { setDesc(e.target.value); setDirty(true) }} placeholder="One line on where this set is used" disabled={readOnly} />
            <label className="check"><input type="checkbox" checked={fire} onChange={e => { setFire(e.target.checked); setDirty(true) }} disabled={readOnly} /> Fire rated</label>
          </div>
          <div className="spacer" />
          <div className="actions">
            {!isNew && !readOnly && <button className="btn btn-ghost danger" onClick={archive}>{set.is_standard ? 'Delete set' : 'Delete this copy'}</button>}
            <button className="btn btn-ghost" onClick={back}>{projectId ? 'Back to job' : 'Back to sets'}</button>
            <button className="btn btn-primary" onClick={save} disabled={busy || readOnly}>{busy ? <span className="spinner" /> : dirty || isNew ? 'Save set' : 'Saved'}</button>
          </div>
        </div>

        <div className="split">
          <div>
            {!readOnly && (
              <div className="typeahead" style={{ marginBottom: 14 }}>
                <input ref={searchRef} className="form-control" placeholder="Add a product to this set: type a code or name, press Enter" value={q}
                       onChange={e => setQ(e.target.value)}
                       onKeyDown={e => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); add(matches[0]) } if (e.key === 'Escape') setQ('') }} />
                {matches.length > 0 && (
                  <div className="typeahead-list">
                    {matches.map(p => (
                      <button key={p.id} onClick={() => add(p)}>
                        <span className="mono">{p.sku}</span><span className="ta-name">{p.name}</span><span className="muted">{TYPE_NAMES[p.product_type || '']}</span>
                      </button>
                    ))}
                  </div>
                )}
            <table className="ledger set-items">
              <thead><tr><th>Code</th><th>Product</th><th className="num">Per door</th><th className="num">Price</th><th className="num">Value</th><th></th></tr></thead>
              <tbody>
                {groups.map(g => (
                  <React.Fragment key={g.type}>
                    <tr className="group-row"><td colSpan={6}>{g.name}</td></tr>
                    {g.items.map(i => (
                      <SetRow key={i.product_id} item={i} products={products} readOnly={readOnly}
                              onQty={v => setQty(i.product_id, v)} onRemove={() => remove(i.product_id)} onSwap={p => swap(i, p)} />
                    ))}
                  </React.Fragment>
                ))}
                {items.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 24 }}>No products yet. Search below to add the first one.</td></tr>}
              </tbody>
              {items.length > 0 && (
                <tfoot><tr><td colSpan={3} /><td className="num" style={{ fontWeight: 600 }}>Set value</td><td className="num" style={{ fontWeight: 600 }}>{priced ? money(value) : <span className="muted" style={{ fontWeight: 400 }}>not all priced</span>}</td><td /></tr></tfoot>
              )}
            </table>
                {q && matches.length === 0 && <div className="hint" style={{ marginTop: 6 }}>No product matches. Add it under Products first.</div>}
              </div>
            )}
          </div>
          <aside>
            <div className="rail-panel">
              <h3>This set</h3>
              <div className="total-row"><span>Products</span><strong>{items.length}</strong></div>
              <div className="total-row"><span>Items per door</span><strong>{perDoor}</strong></div>
              <div className="total-row"><span>Value per door</span><strong>{priced ? money(value) : <span className="muted" style={{ fontWeight: 400 }}>{items.length ? 'some prices missing' : '—'}</span>}</strong></div>
              <div className="total-row" style={{ borderBottom: 0 }}><span>{set.is_standard ? 'Standard set' : 'This job only'}</span><strong>{fire ? 'Fire rated' : 'Not fire rated'}</strong></div>
            </div>
            {!isNew && set.is_standard && (
              <div className="rail-panel" style={{ marginTop: 20 }}>
                <h3>Used on</h3>
                {set.used_on.length === 0 ? <p className="muted">No jobs yet.</p>
                  : <>
                      {set.used_on.map(u => <div key={u.project_id} className="total-row"><span>{u.project}</span><strong>{u.doors} door{u.doors !== 1 ? 's' : ''}</strong></div>)}
                      <p className="hint" style={{ marginTop: 8 }}>Saving changes this set on every job listed.</p>
                    </>}
              </div>
            )}
            {set.copied_from && <div className="rail-panel" style={{ marginTop: 20 }}><h3>Started from</h3><p className="muted">{set.copied_from}</p></div>}

          </aside>
        </div>
      </div>
    </>
  )
}

/* One product row, with the quantity and a Replace that keeps the quantity. */
function SetRow({ item, products, readOnly, onQty, onRemove, onSwap }) {
  const [swapping, setSwapping] = useState(false)
  const [q, setQ] = useState('')
  const matches = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return []
    return products.filter(p => p.id !== item.product_id && (p.sku.toLowerCase().includes(n) || p.name.toLowerCase().includes(n))).slice(0, 6)
  }, [q, products, item.product_id])
  return (
    <tr>
      <td className="mono">{item.sku}</td>
      <td>
        {item.name}
        {swapping && (
          <div className="typeahead" style={{ marginTop: 6 }}>
            <input className="form-control" autoFocus placeholder="Replace with… type a code or name" value={q} onChange={e => setQ(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Escape') { setSwapping(false); setQ('') } if (e.key === 'Enter' && matches[0]) { e.preventDefault(); onSwap(matches[0]); setSwapping(false); setQ('') } }} />
            {matches.length > 0 && (
              <div className="typeahead-list">
                {matches.map(p => <button key={p.id} onClick={() => { onSwap(p); setSwapping(false); setQ('') }}><span className="mono">{p.sku}</span><span className="ta-name">{p.name}</span></button>)}
              </div>
            )}
          </div>
        )}
      </td>
      <td className="num"><input className="qty" type="number" min="1" value={item.qty} onChange={e => onQty(e.target.value)} disabled={readOnly} /></td>
      <td className="num">{item.price != null ? money(item.price) : <span className="muted">—</span>}</td>
      <td className="num">{item.price != null ? money(item.price * item.qty) : <span className="muted">—</span>}</td>
      <td className="row-actions">
        {!readOnly && <button className="btn btn-ghost btn-sm" onClick={() => setSwapping(v => !v)}>{swapping ? 'Keep' : 'Replace'}</button>}
        {!readOnly && <button className="btn btn-ghost btn-sm danger" onClick={onRemove}>Remove</button>}
      </td>
    </tr>
  )
}
