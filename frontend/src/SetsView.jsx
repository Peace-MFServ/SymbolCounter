import React, { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch } from './api'
import { showToast } from './toast'
import { Topbar, place } from './Dashboard'
import { IconTrash, IconSearch, IconPlus, IconFile, IconDoc } from './icons'
import { TYPE_NAMES, groupItems, money } from './JobView'
import { useLeaveGuard } from './unsaved'
import { Picker, Pager, FilterMenu, FilterGroup } from './ProductsView'

const PAGE_SIZES = [25, 50, 100]
const PRODUCTS_SHOWN = 84           // characters of the code list a row shows before "+ n more"
/* The columns the library can be put in order by. */
const SORTS = {
  code:  s => (s.code || '').toLowerCase(),
  count: s => s.items.length,
  items: s => s.items_per_door,
  value: s => (s.value_per_door == null ? -Infinity : s.value_per_door),
  used:  s => s.used_on.reduce((n, u) => n + u.doors, 0),
}

/* ── The standard set library ─────────────────────────────────────────────── */
export function SetsView({ onNavigate, autoImport = false }) {
  const [sets, setSets] = useState([])
  const [loading, setLoading] = useState(true)
  const [typed, setTyped] = useState('')
  const [q, setQ] = useState('')
  const [rating, setRating] = useState('')        // '' | 'fire' | 'nonfire'
  const [job, setJob] = useState('')              // a project name off used_on
  const [usedOnly, setUsedOnly] = useState('')    // '' | 'used' | 'free'
  const [priced, setPriced] = useState('')        // '' | 'yes' | 'no'
  const [origin, setOrigin] = useState('')        // '' | 'copy' | 'original'
  const [sort, setSort] = useState({ key: 'code', dir: 1 })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [open, setOpen] = useState({})            // set id -> product list unfolded
  const [importing, setImporting] = useState('')
  const intecRef = useRef()
  const jsonRef = useRef()

  const load = () => apiFetch('/sets').then(s => { setSets(s || []); setLoading(false) })
  useEffect(() => { load(); if (autoImport) setTimeout(() => intecRef.current?.click(), 300) }, [])
  // typing settles before the list is filtered
  useEffect(() => { const t = setTimeout(() => setQ(typed), 260); return () => clearTimeout(t) }, [typed])

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
  const copy = async s => {
    try { const c = await apiFetch(`/sets/${s.id}/copy`, { method: 'POST' }); showToast(`Copied as ${c.code}`, 'success'); onNavigate('set', { id: c.id }) }
    catch (err) { showToast(err.message, 'error') }
  }
  const remove = async s => {
    const used = s.used_on.length
    const msg = used
      ? `${s.code} ${s.name} is on ${s.used_on.map(u => `${u.project} (${u.doors} doors)`).join(', ')}.\n\nDelete it anyway? Those doors will be left without a set.`
      : `Delete set ${s.code} ${s.name}?`
    if (!confirm(msg)) return
    try { await apiFetch(`/sets/${s.id}${used ? '?force=true' : ''}`, { method: 'DELETE' }); showToast('Set deleted', 'info'); load() }
    catch (err) { showToast(err.message, 'error') }
  }

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase()
    const rows = sets.filter(s =>
      (!rating || (rating === 'fire' ? s.fire_rated : !s.fire_rated)) &&
      (!job || s.used_on.some(u => u.project === job)) &&
      (usedOnly === '' || (usedOnly === 'used' ? s.used_on.length > 0 : s.used_on.length === 0)) &&
      (priced === '' || (priced === 'yes' ? s.priced_ok : !s.priced_ok)) &&
      (origin === '' || (origin === 'copy' ? !!s.copied_from : !s.copied_from)) &&
      (!n || s.code.toLowerCase().includes(n) || s.name.toLowerCase().includes(n)
        || s.items.some(i => i.sku.toLowerCase().includes(n) || (i.name || '').toLowerCase().includes(n))))
    const read = SORTS[sort.key] || SORTS.code
    return [...rows].sort((a, b) => {
      const x = read(a), y = read(b)
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
    })
  }, [sets, q, rating, job, usedOnly, priced, origin, sort])

  const pages = Math.max(1, Math.ceil(shown.length / pageSize))
  const cur = Math.min(page, pages)
  const rows = shown.slice((cur - 1) * pageSize, cur * pageSize)
  useEffect(() => { setPage(1) }, [q, rating, job, usedOnly, priced, origin, pageSize])

  const jobs = useMemo(
    () => [...new Set(sets.flatMap(s => s.used_on.map(u => u.project)))].sort(),
    [sets])
  const extraFilters = (usedOnly ? 1 : 0) + (priced ? 1 : 0) + (origin ? 1 : 0)
  const clearExtras = () => { setUsedOnly(''); setPriced(''); setOrigin('') }
  const by = key => () => setSort(s => ({ key, dir: s.key === key ? -s.dir : 1 }))
  const arrow = key => (sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '')
  const openJob = u => onNavigate('job', { id: u.project_id })

  return (
    <>
      <Topbar onNavigate={onNavigate} active="sets" />
      <div className="page-wrap adm-wrap">
        <div className="adm-head">
          <div className="adm-title">
            <h1>Standard sets</h1>
            <p className="lede">{sets.length} set{sets.length !== 1 ? 's' : ''}. Pre-configured products for doors.</p>
          </div>
          <div className="adm-actions">
            <input ref={intecRef} type="file" accept=".pdf" multiple style={{ display: 'none' }} onChange={e => { importIntec(e.target.files); e.target.value = '' }} />
            <input ref={jsonRef} type="file" accept=".json" style={{ display: 'none' }} onChange={e => { importJson(e.target.files[0]); e.target.value = '' }} />
            <button className="btn btn-line" onClick={() => jsonRef.current.click()} disabled={!!importing}>
              {importing === 'json' ? <><span className="spinner" /> Importing…</> : <><IconFile size={17} /> Import set file</>}
            </button>
            <button className="btn btn-line" onClick={() => intecRef.current.click()} disabled={!!importing}>
              {importing === 'intec' ? <><span className="spinner" /> Reading…</> : <><IconDoc size={17} /> Import Intec schedule</>}
            </button>
            <button className="btn btn-primary" onClick={() => onNavigate('set', { id: 'new' })}><IconPlus size={17} /> New set</button>
          </div>
        </div>

        {loading ? (
          <div className="adm-card"><SetsSkeleton /></div>
        ) : sets.length === 0 ? (
          <div className="empty-state">
            <h2>No standard sets yet</h2>
            <p>Create a set or import a set file to get started. Old Intec schedule PDFs work too: every set on them is created.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="btn btn-primary" onClick={() => onNavigate('set', { id: 'new' })}><IconPlus size={16} /> New set</button>
              <button className="btn btn-line" onClick={() => jsonRef.current.click()}>Import set file</button>
              <button className="btn btn-line" onClick={() => intecRef.current.click()}>Import Intec schedule</button>
            </div>
          </div>
        ) : (
          <>
            <div className="adm-filters">
              <label className="adm-search">
                <IconSearch size={17} />
                <input value={typed} onChange={e => setTyped(e.target.value)} placeholder="Search sets or product codes..." />
              </label>
              <Picker value={rating} onChange={setRating} all="All ratings"
                      options={[{ value: 'fire', label: 'Fire rated' }, { value: 'nonfire', label: 'Not fire rated' }]} />
              {jobs.length > 0 && (
                <Picker value={job} onChange={setJob} all="All jobs"
                        options={jobs.map(j => ({ value: j, label: j }))} />
              )}
              <FilterMenu count={extraFilters} onClear={clearExtras}>
                <FilterGroup label="Used on a job" value={usedOnly} onChange={setUsedOnly} options={[
                  { value: '', label: 'Any' }, { value: 'used', label: 'In use' }, { value: 'free', label: 'Not used yet' }]} />
                <FilterGroup label="Prices" value={priced} onChange={setPriced} options={[
                  { value: '', label: 'Any' }, { value: 'yes', label: 'All priced' }, { value: 'no', label: 'Missing prices' }]} />
                <FilterGroup label="Origin" value={origin} onChange={setOrigin} options={[
                  { value: '', label: 'Any' }, { value: 'original', label: 'Built here' }, { value: 'copy', label: 'Copies' }]} />
              </FilterMenu>
            </div>

            <div className="adm-card">
              <div className="adm-scroll">
                <table className="set-grid">
                  <colgroup>
                    <col style={{ width: '23%' }} /><col style={{ width: '27%' }} /><col style={{ width: '11%' }} />
                    <col style={{ width: '12%' }} /><col style={{ width: '14%' }} /><col style={{ width: 210 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th><button className="th-sort" onClick={by('code')}>Set{arrow('code')}</button></th>
                      <th><button className="th-sort" onClick={by('count')}>Products{arrow('count')}</button></th>
                      <th className="num"><button className="th-sort" onClick={by('items')}>Items per door{arrow('items')}</button></th>
                      <th className="num"><button className="th-sort" onClick={by('value')}>Value per door{arrow('value')}</button></th>
                      <th><button className="th-sort" onClick={by('used')}>Used on{arrow('used')}</button></th>
                      <th className="num">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(s => (
                      <tr key={s.id} onClick={() => onNavigate('set', { id: s.id })}>
                        <td>
                          <div className="s-name">{s.code} <span>{s.name}</span></div>
                          <div className="s-meta">
                            {[s.fire_rated ? 'Fire rated' : 'Not fire rated', s.description,
                              s.locked_by && `${s.locked_by} is editing`].filter(Boolean).join(' · ')}
                          </div>
                        </td>
                        <td><SetProducts items={s.items} open={!!open[s.id]}
                                         onToggle={() => setOpen(o => ({ ...o, [s.id]: !o[s.id] }))} /></td>
                        <td className="num s-count">{s.items_per_door}</td>
                        <td className="num s-value">{s.value_per_door != null ? `€${money(s.value_per_door)}` : <span className="s-dash">—</span>}</td>
                        <td><SetUses uses={s.used_on} onOpen={openJob} /></td>
                        <td className="num">
                          <div className="s-actions">
                            <button className="btn btn-soft btn-row" onClick={e => { e.stopPropagation(); onNavigate('set', { id: s.id }) }}>Open</button>
                            <button className="btn btn-line btn-row" onClick={e => { e.stopPropagation(); copy(s) }}>Copy</button>
                            <SetMenu onOpen={() => onNavigate('set', { id: s.id })} onCopy={() => copy(s)} onDelete={() => remove(s)} />
                          </div>
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr className="no-hover"><td colSpan={6}>
                        <div className="adm-empty">
                          <strong>No sets found</strong>
                          <span>Try changing your search or filters.</span>
                        </div>
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {shown.length > 0 && (
                <div className="adm-foot">
                  <span className="adm-count">
                    Showing <strong>{(cur - 1) * pageSize + 1}–{Math.min(cur * pageSize, shown.length)}</strong> of {shown.length} set{shown.length !== 1 ? 's' : ''}
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
    </>
  )
}

/* The product codes, cut to about two lines, with the rest behind "+ n more". */
function SetProducts({ items, open, onToggle }) {
  if (!items.length) return <span className="s-dash">Empty</span>
  let fit = 0, len = 0
  while (fit < items.length && len + items[fit].sku.length + 2 <= PRODUCTS_SHOWN) { len += items[fit].sku.length + 2; fit++ }
  if (fit === 0) fit = 1
  const rest = items.length - fit
  const list = open ? items : items.slice(0, fit)
  return (
    <div className="s-products">
      <span className={`s-codes${open ? ' open' : ''}`}>{list.map(i => i.sku).join(', ')}</span>
      {rest > 0 && (
        <button className="s-more" onClick={e => { e.stopPropagation(); onToggle() }}>
          {open ? 'Show less' : `+ ${rest} more`}
        </button>
      )}
    </div>
  )
}

/* The jobs a set is on, two at a time, each one a way into that job. */
function SetUses({ uses, onOpen }) {
  const [all, setAll] = useState(false)
  if (!uses.length) return <span className="s-dash">Not used yet</span>
  const list = all ? uses : uses.slice(0, 2)
  const rest = uses.length - list.length
  return (
    <div className="s-uses">
      {list.map(u => (
        <button key={u.project_id} className="s-use" onClick={e => { e.stopPropagation(); onOpen(u) }}>
          {u.project} <span>({u.doors})</span>
        </button>
      ))}
      {rest > 0 && <button className="s-more" onClick={e => { e.stopPropagation(); setAll(true) }}>+ {rest} more</button>}
    </div>
  )
}

/* Copy and Delete out of the way, drawn on top of the page so the card cannot clip them. */
function SetMenu({ onOpen, onCopy, onDelete }) {
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
          <button role="menuitem" onClick={pick(onOpen)}>Open set</button>
          <button role="menuitem" onClick={pick(onCopy)}>Copy set</button>
          <button role="menuitem" className="danger" onClick={pick(onDelete)}>Delete set</button>
        </div>, document.body)}
    </div>
  )
}

/* Grey bars while the library loads, so the table does not flash empty. */
function SetsSkeleton() {
  return (
    <div className="adm-skel">
      {Array.from({ length: 6 }).map((_, i) => (
        <div className="adm-skel-row" key={i}>
          <span style={{ width: '22%' }} /><span style={{ width: '30%' }} /><span style={{ width: '8%' }} />
          <span style={{ width: '10%' }} /><span style={{ width: '14%' }} />
        </div>
      ))}
    </div>
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
    if (!name.trim()) { showToast('Give the set a name', 'error'); return false }
    setBusy(true)
    let ok = true
    try {
      const body = { code, name, description: desc, fire_rated: fire, notes: '', items: items.map(i => ({ product_id: i.product_id, qty: i.qty })) }
      const s = isNew ? await apiFetch('/sets', { method: 'POST', body: JSON.stringify(body) })
                      : await apiFetch(`/sets/${id}`, { method: 'PUT', body: JSON.stringify(body) })
      if (isNew && projectId) await apiFetch(`/projects/${projectId}/sets/${s.id}/add`, { method: 'POST' })
      showToast('Set saved', 'success'); setDirty(false)
      if (isNew) onNavigate('set', { id: s.id, projectId }); else setSet(s)
    } catch (err) { showToast(err.message, 'error'); ok = false }
    setBusy(false)
    return ok
  }
  const back = () => (projectId ? onNavigate('job', { id: projectId }) : onNavigate('sets'))
  // leaving with unsaved changes asks first
  const { guard, modal: leaveModal } = useLeaveGuard({ dirty: dirty && !readOnly, onSave: save, what: 'set' })
  const goBack = guard(back)
  const goNav = guard(onNavigate)
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
    ? [{ label: 'Jobs', onClick: () => goNav('dashboard') }, { label: job?.name || '…', onClick: goBack }, { label: isNew ? 'New set' : code }]
    : [{ label: 'Sets', onClick: goBack }, { label: isNew ? 'New set' : `${code} ${name}` }]
  if (!set) return <><Topbar crumbs={crumbs} onNavigate={onNavigate} active="sets" /><div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div></>

  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={goNav} active={projectId ? 'projects' : 'sets'} />
      {leaveModal}
      <div className="page-wrap">
        {readOnly && <div className="suggest-bar"><div><strong>{lockedBy} has this set open.</strong><span className="muted"> You can look but not save. It frees up when they close it.</span></div></div>}
        <div className="page-header set-edit-head">
          <div className="set-title">
            <input className="set-code" value={code} onChange={e => { setCode(e.target.value); setDirty(true) }} placeholder="MF 01" disabled={readOnly} />
            <input className="set-name" value={name} onChange={e => { setName(e.target.value); setDirty(true) }} placeholder="Int Sgl Bathroom Doors FR" disabled={readOnly} />
            <input className="form-control set-desc" value={desc} onChange={e => { setDesc(e.target.value); setDirty(true) }} placeholder="Description (optional)" disabled={readOnly} />
            <label className="check"><input type="checkbox" checked={fire} onChange={e => { setFire(e.target.checked); setDirty(true) }} disabled={readOnly} /> Fire rated</label>
          </div>
          <div className="spacer" />
          <div className="actions">
            <button className="btn btn-ghost" onClick={goBack}>{projectId ? 'Back to job' : 'Back to sets'}</button>
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
              </div>
            )}
            <table className="ledger set-items soft">
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
                {items.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 24 }}>No products yet.</td></tr>}
              </tbody>
              {items.length > 0 && (
                <tfoot><tr><td colSpan={3} /><td className="num" style={{ fontWeight: 600 }}>Set value</td><td className="num" style={{ fontWeight: 600 }}>{priced ? money(value) : <span className="muted" style={{ fontWeight: 400 }}>not all priced</span>}</td><td /></tr></tfoot>
              )}
            </table>
            {!readOnly && q && matches.length === 0 && <div className="hint" style={{ marginTop: 6 }}>No product matches. Add it under Products first.</div>}
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
            {!isNew && !readOnly && (
              <div className="rail-panel" style={{ marginTop: 20 }}>
                <h3>{set.is_standard ? 'Delete set' : 'Delete this copy'}</h3>
                <p className="muted" style={{ marginBottom: 12 }}>{set.is_standard ? 'Removes it from the set library. You will be asked to confirm.' : 'Removes this copy from the job. You will be asked to confirm.'}</p>
                <button className="btn btn-outline-danger wide" onClick={archive}><IconTrash size={16} /> {set.is_standard ? 'Delete set' : 'Delete this copy'}</button>
              </div>
            )}
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
