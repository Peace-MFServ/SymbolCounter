import React, { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'
import { useAuthImage } from './TemplatesView'
import { useConfirm } from './confirm'
import { IconUpload, IconCheck, IconWarn, IconSearch, IconLeft } from './icons'

const refKey = r => (r || '').split(/(\d+)/).map(t => (/^\d+$/.test(t) ? t.padStart(8, '0') : t.toLowerCase())).join('')
const sheetKey = x => `${x.file}.${x.page}`
const store = {
  get: k => { try { return JSON.parse(localStorage.getItem(k) || 'null') } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private window */ } },
}

/* Read the doors off a job's floor plans. The tags in one style are found on
   every sheet; the sure ones go straight on, the doubtful ones are listed for
   a person to look at on the plan, and then they are added to the job. */
export function PlanReaderView({ projectId, setId = null, onNavigate }) {
  const [job, setJob] = useState(null)
  const [rid, setRid] = useState(null)
  const [r, setR] = useState(null)              // the reading
  const [busy, setBusy] = useState('')          // 'upload' | 'style' | 'apply'
  const [last, setLast] = useState(null)        // an earlier reading of this job to carry on with
  const [drag, setDrag] = useState(false)
  const [sheet, setSheet] = useState(null)      // "file.page" shown
  const [focus, setFocus] = useState(null)      // id of the door or check picked
  const [tab, setTab] = useState('check')
  const [q, setQ] = useState('')
  const [picking, setPicking] = useState(false) // teach the style by clicking a tag
  const [labels, setLabels] = useState(null)
  const [choice, setChoice] = useState({})      // id -> 'keep' | 'drop'
  const [refs, setRefs] = useState({})          // id -> corrected reference
  const [floors, setFloors] = useState({})      // "file.page" -> floor name
  const [target, setTarget] = useState(setId ? String(setId) : '')
  const fileRef = useRef()
  const { ask, modal: confirmModal } = useConfirm()

  useEffect(() => {
    apiFetch(`/projects/${projectId}/job`).then(setJob).catch(err => showToast(err.message, 'error'))
    const prev = store.get(`planread-last:${projectId}`)
    if (prev?.rid) setLast(prev)
  }, [projectId])

  // decisions are kept in this browser, so a reload does not lose the checking done
  useEffect(() => {
    if (!rid) return
    const s = store.get(`planread:${rid}`) || {}
    setChoice(s.choice || {}); setRefs(s.refs || {}); setFloors(s.floors || {})
  }, [rid])
  useEffect(() => { if (rid) store.set(`planread:${rid}`, { choice, refs, floors }) }, [rid, choice, refs, floors])

  const opened = (data, names) => {
    setR(data); setRid(data.id)
    const first = data.pages.find(p => p.readable) || data.pages[0]
    setSheet(cur => cur && data.pages.some(p => sheetKey(p) === cur) ? cur : first ? sheetKey(first) : null)
    store.set(`planread-last:${projectId}`, { rid: data.id, names: names || data.names, at: Date.now() })
  }

  const upload = async files => {
    const pdfs = [...(files || [])].filter(f => /\.pdf$/i.test(f.name))
    if (!pdfs.length) { showToast('Choose the floor plans as PDF files', 'error'); return }
    const fd = new FormData()
    pdfs.forEach(f => fd.append('files', f))
    setBusy('upload')
    try { opened(await apiFetch(`/projects/${projectId}/plan-reads`, { method: 'POST', body: fd })); setChoice({}); setRefs({}); setFloors({}) }
    catch (err) { showToast(err.message, 'error') }
    finally { setBusy('') }
  }
  const carryOn = async () => {
    setBusy('upload')
    try { opened(await apiFetch(`/projects/${projectId}/plan-reads/${last.rid}`)) }
    catch { showToast('That reading is no longer kept. Upload the plans again.', 'error'); setLast(null) }
    finally { setBusy('') }
  }
  const chooseStyles = async keys => {
    if (!keys.length) return
    setBusy('style'); setPicking(false)
    try { opened(await apiFetch(`/projects/${projectId}/plan-reads/${rid}/styles`, { method: 'PUT', body: JSON.stringify({ keys }) })) }
    catch (err) { showToast(err.message, 'error') }
    finally { setBusy('') }
  }

  useEffect(() => {
    if (!picking || !sheet) { setLabels(null); return }
    const [f, p] = sheet.split('.')
    apiFetch(`/projects/${projectId}/plan-reads/${rid}/labels?file=${f}&page=${p}`).then(setLabels).catch(() => setLabels([]))
  }, [picking, sheet, rid, projectId])

  // ── what the reading comes to ─────────────────────────────────────────────
  const pages = r?.pages || []
  const pageOf = useMemo(() => Object.fromEntries(pages.map(p => [sheetKey(p), p])), [pages])
  const floorOf = x => floors[sheetKey(x)] ?? (pageOf[sheetKey(x)]?.floor || '')
  const items = useMemo(() => {
    if (!r) return []
    const ds = r.doors.map(d => ({ ...d, kind: 'door' }))
    return [...ds, ...r.checks]
  }, [r])
  const refOf = x => (refs[x.id] ?? x.ref ?? '').trim()
  const counts = x => {
    if (x.on_job) return false
    const c = choice[x.id]
    if (x.kind === 'untagged') return c === 'keep' && !!refOf(x)
    if (x.status === 'green') return c !== 'drop'
    if (x.status === 'out') return c === 'keep'
    return c === 'keep'
  }
  const toCheck = items.filter(x => x.status === 'amber' && !x.on_job)
  const open = toCheck.filter(x => !choice[x.id])
  const adding = useMemo(() => {
    const seen = new Set(), out = []
    for (const x of items) {
      if (!counts(x)) continue
      const ref = refOf(x)
      if (!ref || seen.has(ref.toUpperCase())) continue
      seen.add(ref.toUpperCase()); out.push({ ref, floor: floorOf(x) })
    }
    return out
  }, [items, choice, refs, floors])
  const onJob = items.filter(x => x.on_job).length
  const bySheet = useMemo(() => {
    const m = {}
    for (const x of items) {
      const k = sheetKey(x); m[k] ||= { green: 0, amber: 0 }
      if (x.on_job) continue
      if (x.status === 'green' && choice[x.id] !== 'drop') m[k].green++
      if (x.status === 'amber' && !choice[x.id]) m[k].amber++
    }
    return m
  }, [items, choice])

  const lefty = x => (x.on_job || (x.status === 'out' && choice[x.id] !== 'keep') ? 1 : 0)
  const show = x => { setSheet(sheetKey(x)); setFocus(x.id) }
  const decide = (x, c) => {
    setChoice(cur => ({ ...cur, [x.id]: cur[x.id] === c ? undefined : c }))
    // move on to the next one still to look at
    if (tab === 'check' && !choice[x.id]) {
      const i = open.findIndex(o => o.id === x.id)
      const next = open[i + 1] || open[i - 1]
      if (next && next.id !== x.id) show(next)
    }
  }

  const apply = async () => {
    if (!adding.length) return
    if (open.length && !await ask({
      title: `${open.length} still to look at`,
      body: `${open.length === 1 ? 'It is' : 'They are'} left off for now; you can come back and add ${open.length === 1 ? 'it' : 'them'} later. The other ${adding.length} go on the job.`,
      confirm: `Add ${adding.length} door${adding.length !== 1 ? 's' : ''}`,
    })) return
    setBusy('apply')
    try {
      const res = await apiFetch(`/projects/${projectId}/plan-reads/${rid}/apply`, { method: 'POST',
        body: JSON.stringify({ doors: adding, set_id: target ? Number(target) : null }) })
      showToast(`${res.added} door${res.added !== 1 ? 's' : ''} added to ${res.project}${res.skipped.length ? `, ${res.skipped.length} already on it` : ''}`, 'success')
      onNavigate('door-summary', { id: projectId })
    } catch (err) { showToast(err.message, 'error') }
    finally { setBusy('') }
  }

  const crumbs = [
    { label: 'Jobs', onClick: () => onNavigate('dashboard') },
    { label: job?.name || '…', onClick: () => onNavigate('job', { id: projectId }) },
    { label: 'Read doors from plans' },
  ]

  // ── upload ────────────────────────────────────────────────────────────────
  if (!r) {
    const drop = {
      onDragOver: e => { e.preventDefault(); setDrag(true) },
      onDragLeave: () => setDrag(false),
      onDrop: e => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files) },
    }
    return (
      <>
        <Topbar crumbs={crumbs} onNavigate={onNavigate} crumbsRight={
          <button className="btn btn-ghost back-jobs" onClick={() => onNavigate('job', { id: projectId })}><IconLeft size={16} /> Back to job</button>} />
        <div className="page-wrap pr-start" {...drop}>
          <div className="page-header">
            <div>
              <h1>Read doors from floor plans</h1>
              <p className="lede">Upload the architect's floor plans as exported from CAD. The door tags are read off every sheet, whatever style the architect numbers them in. You look over the few that are not certain, then add them to the job.</p>
            </div>
          </div>
          <input ref={fileRef} type="file" accept=".pdf" multiple style={{ display: 'none' }} onChange={e => { upload(e.target.files); e.target.value = '' }} />
          <div className={`empty-state drop-zone pr-drop${drag ? ' over' : ''}`} onClick={() => busy || fileRef.current.click()}>
            {busy === 'upload' ? (
              <><span className="spinner spinner-lg" /><h2 style={{ marginTop: 16 }}>Reading the plans</h2><p>Usually a second or two a sheet.</p></>
            ) : (
              <>
                <IconUpload size={28} />
                <h2>Drop the floor plans here</h2>
                <p>PDF, one or more files, every floor at once. Plans that are scans or pictures cannot be read; ask for the CAD export.</p>
                <button className="btn btn-primary" onClick={e => { e.stopPropagation(); fileRef.current.click() }}>Choose plans</button>
              </>
            )}
          </div>
          {last && !busy && (
            <div className="suggest-bar pr-last">
              <div><strong>Carry on with the plans read before.</strong>
                <span className="muted"> {last.names?.join(', ')}{last.at ? ` · ${new Date(last.at).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })}` : ''}</span></div>
              <button className="btn btn-sm" onClick={carryOn}>Carry on</button>
            </div>
          )}
        </div>
      </>
    )
  }

  // ── look over ─────────────────────────────────────────────────────────────
  const page = pageOf[sheet]
  const onSheet = items.filter(x => sheetKey(x) === sheet)
  const fams = r.families.slice(0, 6)
  const chosen = new Set(r.chosen)
  const extra = r.chosen.filter(k => !fams.some(f => f.key === k))
  const listed = (tab === 'check' ? toCheck : items.filter(x => x.kind === 'door' && x.status !== 'amber'))
    .filter(x => !q.trim() || `${refOf(x)} ${x.printed || ''} ${floorOf(x)}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => tab === 'check' ? 0 : (lefty(a) - lefty(b)) || refKey(refOf(a)).localeCompare(refKey(refOf(b))))
  const firstOut = tab === 'all' ? listed.findIndex(lefty) : -1
  const sets = job?.sets || []

  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} crumbsRight={
        <>
          <button className="btn btn-ghost back-jobs" onClick={() => onNavigate('job', { id: projectId })}><IconLeft size={16} /> Back to job</button>
          <input ref={fileRef} type="file" accept=".pdf" multiple style={{ display: 'none' }} onChange={e => { upload(e.target.files); e.target.value = '' }} />
          <button className="btn" onClick={() => fileRef.current.click()} disabled={!!busy}>{busy === 'upload' ? <span className="spinner" /> : 'Read other plans'}</button>
        </>
      } />
      {confirmModal}
      <div className="page-wrap wide">
        <div className="pr-head">
          <div className="pv-stats">
            <div className="pv-stat"><div className="num">{adding.length}</div><div className="lbl">Doors to add</div></div>
            <div className={`pv-stat${open.length ? ' pr-stat-amber' : ''}`}><div className="num">{open.length}<span className="of">/{toCheck.length}</span></div><div className="lbl">Still to look at</div></div>
            <div className="pv-stat"><div className="num">{pages.length}</div><div className="lbl">Sheets</div></div>
            {onJob > 0 && <div className="pv-stat"><div className="num">{onJob}</div><div className="lbl">Already on job</div></div>}
          </div>
          <div className="pr-style card-panel">
            <div className="pr-style-head">
              <h2 className="card-title">Door tag style</h2>
              <span className="muted">Wrong style? Pick another, or click a door tag on the plan.</span>
            </div>
            <div className="pr-chips">
              {fams.map(f => (
                <button key={f.key} className={`chip-btn${chosen.has(f.key) ? ' on' : ''}`} disabled={!!busy}
                        title={`${f.count} different tags like ${f.example}${f.at_doors != null ? `, ${Math.round(f.at_doors * 100)}% beside a door` : ''}`}
                        onClick={() => chooseStyles(chosen.has(f.key) ? r.chosen.filter(k => k !== f.key) : [...r.chosen, f.key])}>
                  Like {f.example} <span className="pr-chip-n">{f.count}</span>
                </button>
              ))}
              {extra.map(k => <span key={k} className="chip-btn on">Picked on the plan</span>)}
              <button className={`btn btn-sm ${picking ? 'btn-primary' : 'btn-soft'}`} onClick={() => setPicking(p => !p)} disabled={!!busy}>
                {picking ? 'Click a tag on the plan' : 'Point at a tag'}
              </button>
              {busy === 'style' && <span className="spinner" />}
            </div>
          </div>
        </div>

        {r.problems.map(p => <div key={p.file} className="suggest-bar readonly-bar"><div><strong>{p.name}</strong><span className="muted"> {p.problem}</span></div></div>)}

        <div className="pr-grid">
          <section className="pr-plan card-panel">
            <div className="pr-sheets">
              {pages.map(p => {
                const k = sheetKey(p), c = bySheet[k] || { green: 0, amber: 0 }
                return (
                  <button key={k} className={`pr-sheet-tab${k === sheet ? ' on' : ''}${!p.readable ? ' bad' : ''}`} onClick={() => { setSheet(k); setFocus(null) }}>
                    <span className="pr-sheet-name">{floorOf(p) || p.name.replace(/\.pdf$/i, '')}{pages.filter(x => x.file === p.file).length > 1 ? ` · p${p.page}` : ''}</span>
                    <span className="pr-sheet-n">{p.readable ? <>{c.green}{c.amber > 0 && <em> · {c.amber} to check</em>}</> : 'cannot be read'}</span>
                  </button>
                )
              })}
            </div>
            {page && (
              <div className="pr-sheet-bar">
                <label>Floor <input className="form-control" value={floorOf(page)} placeholder="e.g. Ground"
                                    onChange={e => setFloors(f => ({ ...f, [sheet]: e.target.value }))} /></label>
                <span className="muted pr-sheet-file">{page.name}{page.note ? ` · ${page.note}` : ''}</span>
              </div>
            )}
            {page && !page.readable && <div className="rail-note">{page.problem}</div>}
            {page && <Sheet key={sheet} projectId={projectId} rid={rid} page={page} items={onSheet} focus={focus}
                            stateOf={x => markState(x, choice, counts)} onPick={x => { setFocus(x.id); setTab(x.status === 'amber' ? 'check' : 'all') }}
                            labels={picking ? labels : null} onLabel={l => chooseStyles([l.key])} />}
            <div className="pr-legend">
              <span><i className="m green" /> Read, going on the job</span>
              <span><i className="m amber" /> To look at</span>
              <span><i className="m gap" /> Number missing</span>
              <span><i className="m out" /> Left out</span>
            </div>
          </section>

          <aside className="pr-side card-panel">
            <div className="pr-tabs">
              <button className={tab === 'check' ? 'on' : ''} onClick={() => setTab('check')}>To look at <span>{open.length}</span></button>
              <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>All doors <span>{items.filter(x => x.kind === 'door' && x.status !== 'amber').length}</span></button>
            </div>
            {tab === 'all' && <label className="adm-search pr-search"><IconSearch size={16} /><input placeholder="Find a door or floor" value={q} onChange={e => setQ(e.target.value)} /></label>}
            <div className="pr-list">
              {tab === 'check' && toCheck.length === 0 && <p className="muted pr-empty"><IconCheck size={16} /> Nothing to look at. Every door was read cleanly.</p>}
              {listed.slice(0, 400).map((x, i) => (
                <React.Fragment key={x.id}>
                {i === firstOut && <div className="pr-list-head">Left out ({listed.length - firstOut})</div>}
                <Row key={x.id} x={x} focus={focus === x.id} choice={choice[x.id]} ref_={refs[x.id] ?? x.ref ?? ''}
                     floor={floorOf(x)} onShow={() => show(x)} onChoose={c => decide(x, c)}
                     onRef={v => setRefs(m => ({ ...m, [x.id]: v }))} />
                </React.Fragment>
              ))}
            </div>
            <div className="pr-foot">
              <label>Set for these doors
                <select className="form-control" value={target} onChange={e => setTarget(e.target.value)}>
                  <option value="">Choose later</option>
                  {sets.map(js => <option key={js.set.id} value={js.set.id}>{js.set.code} · {js.set.name}</option>)}
                </select>
              </label>
              <button className="btn btn-primary wide" onClick={apply} disabled={!adding.length || !!busy}>
                {busy === 'apply' ? <span className="spinner" /> : `Add ${adding.length} door${adding.length !== 1 ? 's' : ''} to the job`}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </>
  )
}

function markState(x, choice, counts) {
  if (x.on_job) return 'out'
  if (x.kind === 'gap') return choice[x.id] === 'keep' ? 'green' : choice[x.id] === 'drop' ? 'out' : 'gap'
  if (x.status === 'amber' && !choice[x.id]) return 'amber'
  return counts(x) ? 'green' : 'out'
}

function Row({ x, focus, choice, ref_, floor, onShow, onChoose, onRef }) {
  const el = useRef()
  useEffect(() => { if (focus) el.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [focus])
  const amber = x.status === 'amber'
  const why = x.on_job ? 'Already on the job' : (x.reasons || []).join('. ')
  const title = x.kind === 'untagged' ? 'Door with no tag' : x.kind === 'gap' ? null : x.printed ? `Printed ${x.printed}` : null
  const keepLabel = x.kind === 'gap' ? 'Add it' : x.kind === 'untagged' ? 'Add' : x.status === 'out' ? 'Count it' : 'Keep'
  const dropLabel = x.kind === 'gap' ? 'No door' : 'Not a door'
  const state = x.on_job ? 'job' : amber ? (choice || 'open') : x.status === 'out' ? (choice === 'keep' ? 'keep' : 'drop') : (choice === 'drop' ? 'drop' : 'keep')
  return (
    <div ref={el} className={`pr-row ${state}${focus ? ' focus' : ''}`} onClick={onShow}>
      <div className="pr-row-top">
        {x.kind === 'gap' || x.kind === 'untagged' || !amber
          ? <span className="pr-ref">{x.kind === 'untagged' ? (title) : x.ref}</span>
          : <input className="form-control pr-ref-in" value={ref_} onClick={e => e.stopPropagation()} onChange={e => onRef(e.target.value)} aria-label="Door reference" />}
        {title && x.kind !== 'untagged' && <span className="pr-printed">{title}</span>}
        <span className="pr-floor">{floor}</span>
        {!x.on_job && !amber && x.status !== 'out' && (
          <button className="btn btn-sm btn-ghost pr-leave" onClick={e => { e.stopPropagation(); onChoose('drop') }}>{choice === 'drop' ? 'Put back' : 'Leave out'}</button>
        )}
      </div>
      {x.kind === 'untagged' && (
        <input className="form-control pr-ref-in wide" value={ref_} placeholder="Its door number, to add it" onClick={e => e.stopPropagation()} onChange={e => onRef(e.target.value)} />
      )}
      {why && <div className="pr-why">{amber && <IconWarn size={13} />} {why}</div>}
      {!x.on_job && (amber || x.status === 'out') && (
        <div className="pr-acts" onClick={e => e.stopPropagation()}>
          <button className={`btn btn-sm ${choice === 'keep' ? 'btn-primary' : ''}`} onClick={() => onChoose('keep')}
                  disabled={x.kind === 'untagged' && !ref_.trim()}>{keepLabel}</button>
          {amber && <button className={`btn btn-sm ${choice === 'drop' ? 'btn-primary' : ''}`} onClick={() => onChoose('drop')}>{dropLabel}</button>}
        </div>
      )}
    </div>
  )
}

/* One sheet: the plan as a picture with a mark on every tag. Scroll to move
   about, Ctrl and scroll (or the buttons) to zoom, drag to pan. */
function Sheet({ projectId, rid, page, items, focus, stateOf, onPick, labels, onLabel }) {
  const src = useAuthImage(`/api/projects/${projectId}/plan-reads/${rid}/sheet/${page.file}/${page.page}`)
  const box = useRef()
  const [zoom, setZoom] = useState(1)
  const drag = useRef(null)
  const W = page.width, H = page.height
  const pos = x => ({ left: `${(x.x / W) * 100}%`, top: `${(x.y / H) * 100}%`, width: `${(x.w / W) * 100}%`, height: `${(x.h / H) * 100}%` })

  const zoomTo = (z, cx = 0.5, cy = 0.5) => {
    const el = box.current
    if (!el) return
    const nz = Math.min(8, Math.max(1, z))
    const fx = (el.scrollLeft + el.clientWidth * cx) / el.scrollWidth
    const fy = (el.scrollTop + el.clientHeight * cy) / el.scrollHeight
    setZoom(nz)
    requestAnimationFrame(() => {
      el.scrollLeft = fx * el.scrollWidth - el.clientWidth * cx
      el.scrollTop = fy * el.scrollHeight - el.clientHeight * cy
    })
  }
  useEffect(() => {
    const el = box.current
    if (!el) return
    const wheel = e => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const b = el.getBoundingClientRect()
      zoomTo(zoom * (e.deltaY < 0 ? 1.25 : 0.8), (e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [zoom])
  // bring the picked door into the middle, close enough to read
  const pending = useRef(null)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!focus || !src) return
    pending.current = focus
    setZoom(z => Math.max(z, 3))
    setTick(t => t + 1)
  }, [focus, src])
  useLayoutEffect(() => {
    const x = items.find(i => i.id === pending.current)
    const el = box.current
    if (!x || !el) return
    pending.current = null
    const w = el.scrollWidth, h = el.scrollHeight
    el.scrollTo({ left: ((x.x + x.w / 2) / W) * w - el.clientWidth / 2, top: ((x.y + x.h / 2) / H) * h - el.clientHeight / 2, behavior: 'smooth' })
  })

  const down = e => {
    if (e.button !== 0 || e.target.closest('.pr-mark, .pr-label')) return
    drag.current = { x: e.clientX, y: e.clientY, l: box.current.scrollLeft, t: box.current.scrollTop }
  }
  const move = e => {
    const d = drag.current
    if (!d) return
    box.current.scrollLeft = d.l - (e.clientX - d.x)
    box.current.scrollTop = d.t - (e.clientY - d.y)
  }

  return (
    <div className="pr-viewer-wrap">
      <div className="pr-zoom">
        <button className="btn btn-sm" onClick={() => zoomTo(zoom / 1.5)} disabled={zoom <= 1} aria-label="Zoom out">−</button>
        <button className="btn btn-sm" onClick={() => setZoom(1)} disabled={zoom === 1}>Whole sheet</button>
        <button className="btn btn-sm" onClick={() => zoomTo(zoom * 1.5)} disabled={zoom >= 8} aria-label="Zoom in">+</button>
      </div>
      <div ref={box} className={`pr-viewer${labels ? ' picking' : ''}`} onMouseDown={down} onMouseMove={move}
           onMouseUp={() => { drag.current = null }} onMouseLeave={() => { drag.current = null }}>
        <div className="pr-canvas" style={{ width: `${zoom * 100}%` }}>
          {src ? <img src={src} alt={page.name} draggable={false} /> : <div className="pr-loading" style={{ aspectRatio: `${W} / ${H}` }}><span className="spinner spinner-lg" /></div>}
          {src && !labels && items.map(x => (
            <button key={x.id} className={`pr-mark ${stateOf(x)}${x.kind === 'untagged' ? ' swing' : ''}${focus === x.id ? ' focus' : ''}`}
                    style={pos(x)} title={x.ref || (x.reasons || [])[0]} onClick={() => onPick(x)} />
          ))}
          {src && labels && labels.map(l => (
            <button key={l.id} className="pr-label" style={pos(l)} title={`Use the style of ${l.text}`} onClick={() => onLabel(l)} />
          ))}
        </div>
      </div>
    </div>
  )
}
