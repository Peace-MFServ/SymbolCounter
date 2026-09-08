import React, { useState, useEffect, useMemo, useRef } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'

/* ── List of sets ─────────────────────────────────────────────────────────── */
export function SetsView({ onNavigate, autoImport = false }) {
  const [sets, setSets] = useState([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [importing, setImporting] = useState(false)
  const intecRef = useRef()

  const load = () => apiFetch('/sets').then(s => { setSets(s || []); setLoading(false) })
  useEffect(() => { load(); if (autoImport) setTimeout(() => intecRef.current?.click(), 300) }, [])

  const importIntec = async files => {
    const pdfs = Array.from(files || []).filter(f => f.name.toLowerCase().endsWith('.pdf'))
    if (!pdfs.length) return
    setImporting(true)
    let totals = { products_added: 0, sets_added: 0, sets_reused: 0, doors: 0 }, fails = 0
    for (const f of pdfs) {
      const form = new FormData(); form.append('file', f)
      try {
        const r = await apiFetch('/sets/import-intec', { method: 'POST', body: form })
        for (const k of Object.keys(totals)) totals[k] += r[k] || 0
      } catch (err) { fails++; showToast(`${f.name}: ${err.message}`, 'error') }
    }
    if (pdfs.length > fails) {
      showToast(`Imported ${pdfs.length - fails} schedule${pdfs.length - fails !== 1 ? 's' : ''}: ${totals.sets_added} new set${totals.sets_added !== 1 ? 's' : ''}, ${totals.products_added} new product${totals.products_added !== 1 ? 's' : ''}` +
                (totals.sets_reused ? `, ${totals.sets_reused} already there` : ''), 'success')
    }
    setImporting(false); load()
  }

  const copy = async (e, s) => {
    e.stopPropagation()
    try {
      const c = await apiFetch(`/sets/${s.id}/copy`, { method: 'POST' })
      showToast(`Copied as ${c.code}`, 'success')
      onNavigate('set', { id: c.id })
    } catch (err) { showToast(err.message, 'error') }
  }

  const remove = async (e, s) => {
    e.stopPropagation()
    if (s.used_on.length) { showToast(`${s.code} is on ${s.used_on.map(u => u.project).join(', ')}. Reassign those doors first.`, 'error'); return }
    if (!confirm(`Delete set ${s.code} ${s.name}?`)) return
    try { await apiFetch(`/sets/${s.id}`, { method: 'DELETE' }); showToast('Set deleted', 'info'); load() }
    catch (err) { showToast(err.message, 'error') }
  }

  const shown = sets.filter(s => {
    const n = q.trim().toLowerCase()
    return !n || s.code.toLowerCase().includes(n) || s.name.toLowerCase().includes(n)
      || s.items.some(i => i.sku.toLowerCase().includes(n))
  })

  return (
    <>
      <Topbar crumbs={[{ label: 'Sets' }]} onNavigate={onNavigate} active="sets" />
      <div className="page-wrap">
        <div className="page-header">
          <div><h1>Hardware sets</h1><p className="lede">A set is built once and used on every job that has that kind of door.</p></div>
          <div className="spacer" />
          <div className="actions">
            <input ref={intecRef} type="file" accept=".pdf" multiple style={{ display: 'none' }}
                   onChange={e => { importIntec(e.target.files); e.target.value = '' }} />
            <button className="btn" onClick={() => intecRef.current.click()} disabled={importing}>
              {importing ? <><span className="spinner" /> Importing…</> : 'Import Intec schedule'}
            </button>
            <button className="btn btn-primary" onClick={() => onNavigate('set', { id: 'new' })}>New set</button>
          </div>
        </div>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><span className="spinner spinner-lg" /></div>
        ) : sets.length === 0 ? (
          <div className="empty-state">
            <h2>No sets yet.</h2>
            <p>The quickest start is an old Intec schedule PDF. Drop in a few recent quotes and every set and product on them is loaded, ready to reuse. You can also build a set by hand.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="btn btn-primary" onClick={() => intecRef.current.click()} disabled={importing}>{importing ? <span className="spinner" /> : 'Import Intec schedule'}</button>
              <button className="btn" onClick={() => onNavigate('set', { id: 'new' })}>New set</button>
            </div>
          </div>
        ) : (
          <>
            <div className="filter-row"><input className="form-control search" placeholder="Search sets or product codes…" value={q} onChange={e => setQ(e.target.value)} /></div>
            <table className="ledger">
              <thead><tr><th>Set</th><th>Products</th><th style={{ textAlign: 'right' }}>Items per door</th><th style={{ textAlign: 'right' }}>Cost per door</th><th>Used on</th><th></th></tr></thead>
              <tbody>
                {shown.map(s => (
                  <tr key={s.id} onClick={() => onNavigate('set', { id: s.id })}>
                    <td><div className="proj-name">{s.code} <span style={{ fontWeight: 400 }}>{s.name}</span></div>
                        <div className="proj-meta">{s.fire_rated ? 'Fire rated' : 'Not fire rated'}{s.description ? ` · ${s.description}` : ''}</div></td>
                    <td className="muted" style={{ fontSize: 13, maxWidth: 380 }}>{s.items.map(i => i.sku).join(', ') || 'Empty'}</td>
                    <td className="count-num">{s.items_per_door}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{s.cost_per_door != null ? s.cost_per_door.toFixed(2) : <span className="muted">—</span>}</td>
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

/* ── One set ──────────────────────────────────────────────────────────────── */
export function SetEditor({ id, onNavigate }) {
  const isNew = id === 'new'
  const [set, setSet]         = useState(null)
  const [code, setCode]       = useState('')
  const [name, setName]       = useState('')
  const [desc, setDesc]       = useState('')
  const [fire, setFire]       = useState(false)
  const [items, setItems]     = useState([])     // [{product_id, sku, name, qty, cost, unit}]
  const [products, setProducts] = useState([])
  const [q, setQ]             = useState('')
  const [busy, setBusy]       = useState(false)
  const [dirty, setDirty]     = useState(false)
  const searchRef = useRef()

  useEffect(() => {
    apiFetch('/products').then(p => setProducts(p || []))
    if (isNew) {
      apiFetch('/sets/next-code').then(r => setCode(r?.code || 'MF 01'))
      setSet({ items: [], used_on: [] })
    } else {
      apiFetch(`/sets/${id}`).then(s => {
        if (!s) return
        setSet(s); setCode(s.code); setName(s.name); setDesc(s.description); setFire(s.fire_rated)
        setItems(s.items.map(i => ({ product_id: i.product_id, sku: i.sku, name: i.name, qty: i.qty, cost: i.cost, unit: i.unit })))
      })
    }
  }, [id])

  const matches = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return []
    const have = new Set(items.map(i => i.product_id))
    return products.filter(p => !have.has(p.id) && (p.sku.toLowerCase().includes(n) || p.name.toLowerCase().includes(n))).slice(0, 8)
  }, [q, products, items])

  const add = p => {
    setItems(xs => [...xs, { product_id: p.id, sku: p.sku, name: p.name, qty: 1, cost: p.cost, unit: p.unit }])
    setQ(''); setDirty(true); searchRef.current?.focus()
  }
  const setQty = (pid, v) => { setItems(xs => xs.map(i => i.product_id === pid ? { ...i, qty: Math.max(1, Number(v) || 1) } : i)); setDirty(true) }
  const remove = pid => { setItems(xs => xs.filter(i => i.product_id !== pid)); setDirty(true) }

  const save = async () => {
    if (!name.trim()) { showToast('Give the set a name', 'error'); return }
    setBusy(true)
    try {
      const body = { code, name, description: desc, fire_rated: fire, notes: '', items: items.map(i => ({ product_id: i.product_id, qty: i.qty })) }
      const s = isNew
        ? await apiFetch('/sets', { method: 'POST', body: JSON.stringify(body) })
        : await apiFetch(`/sets/${id}`, { method: 'PUT', body: JSON.stringify(body) })
      showToast('Set saved', 'success'); setDirty(false)
      if (isNew) onNavigate('set', { id: s.id }); else setSet(s)
    } catch (err) { showToast(err.message, 'error') }
    setBusy(false)
  }

  const copy = async () => {
    if (isNew) return
    const c = await apiFetch(`/sets/${id}/copy`, { method: 'POST' })
    showToast(`Copied as ${c.code}`, 'success'); onNavigate('set', { id: c.id })
  }

  const archive = async () => {
    if (isNew || !confirm('Remove this set?')) return
    try { await apiFetch(`/sets/${id}`, { method: 'DELETE' }); showToast('Set removed', 'info'); onNavigate('sets') }
    catch (err) { showToast(err.message, 'error') }
  }

  const perDoor = items.reduce((s, i) => s + i.qty, 0)
  const costKnown = items.length > 0 && items.every(i => i.cost != null)
  const cost = items.reduce((s, i) => s + (i.cost || 0) * i.qty, 0)

  const crumbs = [{ label: 'Sets', onClick: () => onNavigate('sets') }, { label: isNew ? 'New set' : `${code} ${name}` }]
  if (!set) return <><Topbar crumbs={crumbs} onNavigate={onNavigate} active="sets" /><div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div></>

  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} active="sets" />
      <div className="page-wrap">
        <div className="page-header" style={{ alignItems: 'flex-start' }}>
          <div className="set-title">
            <input className="set-code" value={code} onChange={e => { setCode(e.target.value); setDirty(true) }} placeholder="MF 01" />
            <input className="set-name" value={name} onChange={e => { setName(e.target.value); setDirty(true) }} placeholder="Int Sgl Apartment Entrance FR" />
            <input className="form-control set-desc" value={desc} onChange={e => { setDesc(e.target.value); setDirty(true) }} placeholder="One line on where this set is used" />
            <label className="check"><input type="checkbox" checked={fire} onChange={e => { setFire(e.target.checked); setDirty(true) }} /> Fire rated</label>
          </div>
          <div className="spacer" />
          <div className="actions">
            {!isNew && <button className="btn" onClick={copy}>Copy set</button>}
            <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <span className="spinner" /> : dirty || isNew ? 'Save set' : 'Saved'}</button>
          </div>
        </div>

        <div className="split">
          <div>
            <table className="ledger set-items">
              <thead><tr><th>Code</th><th>Product</th><th style={{ textAlign: 'right' }}>Qty per door</th><th></th></tr></thead>
              <tbody>
                {items.map(i => (
                  <tr key={i.product_id}>
                    <td className="mono">{i.sku}</td>
                    <td>{i.name}</td>
                    <td style={{ textAlign: 'right' }}><input className="qty" type="number" min="1" value={i.qty} onChange={e => setQty(i.product_id, e.target.value)} /></td>
                    <td className="row-actions"><button className="btn btn-ghost btn-sm danger" onClick={() => remove(i.product_id)}>Remove</button></td>
                  </tr>
                ))}
                {items.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 24 }}>No products yet. Search below to add the first one.</td></tr>}
              </tbody>
            </table>
            <div className="typeahead">
              <input ref={searchRef} className="form-control" placeholder="Add a product: type a code or name…" value={q}
                     onChange={e => setQ(e.target.value)}
                     onKeyDown={e => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); add(matches[0]) } if (e.key === 'Escape') setQ('') }} />
              {matches.length > 0 && (
                <div className="typeahead-list">
                  {matches.map(p => (
                    <button key={p.id} onClick={() => add(p)}>
                      <span className="mono">{p.sku}</span><span className="ta-name">{p.name}</span><span className="muted">{p.category}</span>
                    </button>
                  ))}
                </div>
              )}
              {q && matches.length === 0 && <div className="hint" style={{ marginTop: 6 }}>No product matches. Add it under Products first.</div>}
            </div>
          </div>
          <aside>
            <div className="rail-panel">
              <h3>This set</h3>
              <div className="total-row"><span>Products</span><strong>{items.length}</strong></div>
              <div className="total-row"><span>Items per door</span><strong>{perDoor}</strong></div>
              <div className="total-row"><span>Cost per door</span><strong>{costKnown ? cost.toFixed(2) : <span className="muted" style={{ fontWeight: 400 }}>{items.length ? 'some costs missing' : '—'}</span>}</strong></div>
              <div className="total-row" style={{ borderBottom: 0 }}><span>Fire rated</span><strong>{fire ? 'Yes' : 'No'}</strong></div>
            </div>
            {!isNew && (
              <div className="rail-panel" style={{ marginTop: 20 }}>
                <h3>Where it's used</h3>
                {set.used_on.length === 0 ? <p className="muted">Not assigned to any doors yet.</p>
                  : set.used_on.map(u => <div key={u.project_id} className="total-row"><span>{u.project}</span><strong>{u.doors} door{u.doors !== 1 ? 's' : ''}</strong></div>)}
              </div>
            )}
            {set.copied_from && <div className="rail-panel" style={{ marginTop: 20, borderColor: 'var(--border)' }}><h3>Started from</h3><p className="muted">Copied from {set.copied_from}.</p></div>}
            {!isNew && <button className="link-btn" style={{ marginTop: 16, color: 'var(--red)' }} onClick={archive}>Remove this set</button>}
          </aside>
        </div>
      </div>
    </>
  )
}
