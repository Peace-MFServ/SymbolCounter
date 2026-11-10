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
  const [list, setList] = useState(null)        // a door list read from a spreadsheet
  const fileRef = useRef()
  const splitRef = useRef()
  const [splitH, setSplitH] = useState(0)
  const { ask, modal: confirmModal } = useConfirm()
  useLayoutEffect(() => {
    const fit = () => { if (splitRef.current) setSplitH(Math.max(420, window.innerHeight - splitRef.current.getBoundingClientRect().top - 14)) }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [r, list])

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
    const doubtful = data.doors.some(d => d.status === 'amber' && !d.on_job) || data.checks.length > 0
    setTab(t => (rid === data.id ? t : doubtful ? 'check' : 'all'))
    const first = data.pages.find(p => p.readable) || data.pages[0]
    setSheet(cur => cur && data.pages.some(p => sheetKey(p) === cur) ? cur : first ? sheetKey(first) : null)
    store.set(`planread-last:${projectId}`, { rid: data.id, names: names || data.names, at: Date.now() })
  }

  const upload = async files => {
    const all = [...(files || [])]
    if (all.some(f => /\.xls$/i.test(f.name))) { showToast('That is an old Excel file (.xls). Open it in Excel and save it as .xlsx, then upload that.', 'error'); return }
    const sheetFile = all.find(f => /\.(xlsx|xlsm|csv)$/i.test(f.name))
    if (sheetFile) {
      const fd = new FormData()
      fd.append('file', sheetFile)
      setBusy('upload')
      try {
        const res = await apiFetch(`/projects/${projectId}/door-list`, { method: 'POST', body: fd })
        if (res.problem) { showToast(res.problem, 'error'); return }
        setList(res)
        if (all.length > 1) showToast(`Read ${sheetFile.name}. Upload the other files on their own.`, 'info')
      } catch (err) { showToast(err.message, 'error') }
      finally { setBusy('') }
      return
    }
    const pdfs = all.filter(f => /\.pdf$/i.test(f.name))
    if (!pdfs.length) { showToast('Choose the floor plans as PDF, or the door schedule as Excel (.xlsx) or .csv', 'error'); return }
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
    { label: 'Read doors' },
  ]

  if (list) return <DoorListReview data={list} projectId={projectId} job={job} target={target} setTarget={setTarget}
                                   crumbs={crumbs} onNavigate={onNavigate} onAnother={() => setList(null)} />

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
              <h1>Read doors from plans or a schedule</h1>
              <p className="lede">Upload the architect's floor plans as exported from CAD, or their door schedule as a spreadsheet. The door numbers are read whatever style the architect uses. You look over the few that are not certain, then add them to the job.</p>
            </div>
          </div>
          <input ref={fileRef} type="file" accept=".pdf,.xlsx,.xlsm,.csv" multiple style={{ display: 'none' }} onChange={e => { upload(e.target.files); e.target.value = '' }} />
          <div className={`empty-state drop-zone pr-drop${drag ? ' over' : ''}`} onClick={() => busy || fileRef.current.click()}>
            {busy === 'upload' ? (
              <><span className="spinner spinner-lg" /><h2 style={{ marginTop: 16 }}>Reading</h2><p>Usually a second or two a sheet.</p></>
            ) : (
              <>
                <IconUpload size={28} />
                <h2>Drop the floor plans or the door schedule here</h2>
                <p>Floor plans as PDF, every floor at once. Or the door schedule as Excel (.xlsx) or .csv. Plans that are scans or pictures cannot be read; ask for the CAD export or the spreadsheet.</p>
                <button className="btn btn-primary" onClick={e => { e.stopPropagation(); fileRef.current.click() }}>Choose files</button>
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
  // a sheet goes by its floor; two sheets of one floor (Part 2, Part 3) add what differs in their file names
  const sheetLabel = p => {
    const fl = floorOf(p), bare = p.name.replace(/\.pdf$/i, '')
    if (!fl) return bare.length > 30 ? bare.slice(0, 29) + '…' : bare
    const same = pages.filter(x => floorOf(x) === fl && x.file !== p.file)
    if (!same.length) return fl
    const words = bare.split(/[\s_]+/)
    const others = new Set(same.flatMap(x => x.name.replace(/\.pdf$/i, '').split(/[\s_]+/)))
    // the last word that is this file's alone, with the word before it: "Part 2"
    const i = words.map((w, j) => (!others.has(w) && w !== '-' ? j : -1)).filter(j => j >= 0).pop()
    const own = i === undefined ? '' : `${i > 0 && /^[A-Za-z]+$/.test(words[i - 1]) ? words[i - 1] + ' ' : ''}${words[i]}`
    return `${fl} · ${(own || bare).slice(0, 18)}`
  }
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
          <input ref={fileRef} type="file" accept=".pdf,.xlsx,.xlsm,.csv" multiple style={{ display: 'none' }} onChange={e => { upload(e.target.files); e.target.value = '' }} />
          <button className="btn" onClick={() => fileRef.current.click()} disabled={!!busy}>{busy === 'upload' ? <span className="spinner" /> : 'Read other files'}</button>
        </>
      } />
      {confirmModal}
      <div className="pr-split" ref={splitRef} style={splitH ? { height: splitH } : undefined}>
        {/* Left half: the plan */}
        <section className="pr-pane pr-left">
          <div className="pr-pane-head">
            <div className="pr-sheets">
              {pages.map(p => {
                const k = sheetKey(p), c = bySheet[k] || { green: 0, amber: 0 }
                return (
                  <button key={k} className={`pr-sheet-tab${k === sheet ? ' on' : ''}${!p.readable ? ' bad' : ''}`} onClick={() => { setSheet(k); setFocus(null) }}>
                    <span className="pr-sheet-name" title={p.name}>{sheetLabel(p)}{pages.filter(x => x.file === p.file).length > 1 ? ` · p${p.page}` : ''}</span>
                    <span className="pr-sheet-n">{p.readable ? <>{c.green}{c.amber > 0 && <em> · {c.amber} to check</em>}</> : 'cannot be read'}</span>
                  </button>
                )
              })}
            </div>
            {page && (
              <div className="pr-sheet-bar">
                <label>Floor <input className="form-control" value={floorOf(page)} placeholder="e.g. Ground"
                                    onChange={e => setFloors(f => ({ ...f, [sheet]: e.target.value }))} /></label>
                <span className="muted pr-sheet-file" title={page.name}>{page.name}</span>
              </div>
            )}
            {page?.note && <div className="pr-sheet-note">{page.note}</div>}
            {page && !page.readable && <div className="rail-note">{page.problem}</div>}
          </div>
          {page && <Sheet key={sheet} projectId={projectId} rid={rid} page={page} items={onSheet} focus={focus}
                          stateOf={x => markState(x, choice, counts)} onPick={x => { setFocus(x.id); setTab(x.status === 'amber' ? 'check' : 'all') }}
                          labels={picking ? labels : null} onLabel={l => chooseStyles([l.key])} />}
          <div className="pr-legend">
            <span><i className="m green" /> Read, going on the job</span>
            <span><i className="m amber" /> To look at</span>
            <span><i className="m gap" /> Number missing</span>
            <span><i className="m out" /> Left out</span>
            <span className="pr-legend-tip">Ctrl + scroll to zoom, drag to move</span>
          </div>
        </section>

        {/* Right half: the doors read off it */}
        <section className="pr-pane pr-right">
          <div className="pr-pane-head">
            <div className="pr-counts">
              <div><strong>{adding.length}</strong><span>Doors to add</span></div>
              <div className={open.length ? 'amber' : ''}><strong>{open.length}<em>/{toCheck.length}</em></strong><span>Still to look at</span></div>
              <div><strong>{pages.length}</strong><span>Sheet{pages.length !== 1 ? 's' : ''}</span></div>
              {onJob > 0 && <div><strong>{onJob}</strong><span>Already on job</span></div>}
            </div>
            <div className="pr-style">
              <span className="pr-style-label" title="Wrong style? Pick another, or point at a door tag on the plan.">Door tag style</span>
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
            {r.problems.map(p => <div key={p.file} className="pr-sheet-note"><strong>{p.name}</strong> {p.problem}</div>)}
            <div className="pr-listbar">
              <div className="pr-tabs">
                <button className={tab === 'check' ? 'on' : ''} onClick={() => setTab('check')}>To look at <span>{open.length}</span></button>
                <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>All doors <span>{items.filter(x => x.kind === 'door' && x.status !== 'amber').length}</span></button>
              </div>
              <label className="adm-search pr-search"><IconSearch size={16} /><input placeholder="Find a door or floor" value={q} onChange={e => setQ(e.target.value)} /></label>
            </div>
          </div>
          <div className={`pr-list${tab === 'all' ? ' two' : ''}`}>
            {tab === 'check' && toCheck.length === 0 && <p className="muted pr-empty"><IconCheck size={16} /> Nothing to look at. Every door was read cleanly.</p>}
            {listed.length > 0 && tab === 'check' && <div className="pr-row pr-row-head"><span /><span>Door</span><span>Floor</span><span>Note</span><span /></div>}
            {listed.slice(0, 600).map((x, i) => (
              <React.Fragment key={x.id}>
                {i === firstOut && <div className="pr-list-head">Left out ({listed.length - firstOut})</div>}
                <Row x={x} focus={focus === x.id} choice={choice[x.id]} ref_={refs[x.id] ?? x.ref ?? ''}
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
            <button className="btn btn-primary" onClick={apply} disabled={!adding.length || !!busy}>
              {busy === 'apply' ? <span className="spinner" /> : `Add ${adding.length} door${adding.length !== 1 ? 's' : ''} to the job`}
            </button>
          </div>
        </section>
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
  const keepLabel = x.kind === 'gap' ? 'Add it' : x.kind === 'untagged' ? 'Add' : x.status === 'out' ? 'Count it' : 'Keep'
  const dropLabel = x.kind === 'gap' ? 'No door' : 'Not a door'
  const state = x.on_job ? 'job' : amber ? (choice || 'open') : x.status === 'out' ? (choice === 'keep' ? 'keep' : 'drop') : (choice === 'drop' ? 'drop' : 'keep')
  const numbered = x.kind !== 'untagged'
  return (
    <div ref={el} className={`pr-row ${state}${focus ? ' focus' : ''}${why || amber ? ' full' : ''}`} onClick={onShow}>
      <span className="pr-dot" />
      <div className="pr-c-ref">
        {!numbered
          ? <input className="form-control pr-ref-in" value={ref_} placeholder="Door number" onClick={e => e.stopPropagation()} onChange={e => onRef(e.target.value)} aria-label="Door number" />
          : x.kind === 'gap' || !amber
            ? <span className="pr-ref">{x.ref}</span>
            : <input className="form-control pr-ref-in" value={ref_} onClick={e => e.stopPropagation()} onChange={e => onRef(e.target.value)} aria-label="Door reference" />}
      </div>
      <span className="pr-floor">{floor}</span>
      <div className="pr-why">
        {amber && <IconWarn size={13} />} {!numbered && <strong>Door with no tag. </strong>}{why}
      </div>
      <div className="pr-acts" onClick={e => e.stopPropagation()}>
        {x.on_job ? null : (amber || x.status === 'out') ? (
          <>
            <button className={`btn btn-sm ${choice === 'keep' ? 'btn-primary' : ''}`} onClick={() => onChoose('keep')}
                    disabled={!numbered && !ref_.trim()}>{keepLabel}</button>
            {amber && <button className={`btn btn-sm ${choice === 'drop' ? 'btn-primary' : ''}`} onClick={() => onChoose('drop')}>{dropLabel}</button>}
          </>
        ) : (
          <button className="btn btn-sm btn-ghost pr-leave" onClick={() => onChoose('drop')}>{choice === 'drop' ? 'Put back' : 'Leave out'}</button>
        )}
      </div>
    </div>
  )
}

/* One sheet: the plan as a picture with a mark on every tag. Scroll to move
   about, Ctrl and scroll (or the buttons) to zoom, drag to pan. */
function Sheet({ projectId, rid, page, items, focus, stateOf, onPick, labels, onLabel }) {
  const src = useAuthImage(`/api/projects/${projectId}/plan-reads/${rid}/sheet/${page.file}/${page.page}`)
  const box = useRef()
  const canvas = useRef()
  const [zoom, setZoom] = useState(1)
  const drag = useRef(null)
  const W = page.width, H = page.height
  // "Whole sheet" is the whole sheet: the widest it can be with all of it in view
  const [base, setBase] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setBase(Math.max(120, Math.floor(Math.min(el.clientWidth, el.clientHeight * (W / H)))))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [W, H])
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
  const [loaded, setLoaded] = useState(false)     // the picture has its size: only then can a door be scrolled to
  useEffect(() => {
    if (!focus || !loaded) return
    pending.current = focus
    setZoom(z => Math.max(z, 3))
    setTick(t => t + 1)
  }, [focus, loaded])
  useLayoutEffect(() => {
    const x = items.find(i => i.id === pending.current)
    const el = box.current
    if (!x || !el) return
    pending.current = null
    const c = canvas.current
    el.scrollTo({ left: c.offsetLeft + ((x.x + x.w / 2) / W) * c.offsetWidth - el.clientWidth / 2,
                  top: c.offsetTop + ((x.y + x.h / 2) / H) * c.offsetHeight - el.clientHeight / 2, behavior: 'smooth' })
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
        <div ref={canvas} className="pr-canvas" style={{ width: base ? `${Math.round(base * zoom)}px` : `${zoom * 100}%` }}>
          {src ? <img src={src} alt={page.name} draggable={false} onLoad={() => setLoaded(true)} /> : <div className="pr-loading" style={{ aspectRatio: `${W} / ${H}` }}><span className="spinner spinner-lg" /></div>}
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

/* A door list from the architect's spreadsheet: every row as read, the doubtful
   ones to look at, each door's number and floor correctable, then onto the job. */
function DoorListReview({ data, projectId, job, target, setTarget, crumbs, onNavigate, onAnother }) {
  const [pick, setPick] = useState({})      // id -> true (add) | false (leave out)
  const [edit, setEdit] = useState({})      // id -> { ref, floor }
  const [tab, setTab] = useState(() => data.doors.some(d => d.status === 'amber' && !d.on_job) ? 'check' : 'all')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const { ask, modal: confirmModal } = useConfirm()
  const doors = data.doors
  const val = (d, k) => (edit[d.id]?.[k] ?? d[k] ?? '')
  const isIn = d => !d.on_job && (pick[d.id] ?? (d.status === 'green' ? true : undefined)) === true
  const toCheck = doors.filter(d => d.status === 'amber' && !d.on_job)
  const open = toCheck.filter(d => pick[d.id] === undefined)
  const adding = useMemo(() => {
    const seen = new Set(), out = []
    for (const d of doors) {
      if (!isIn(d)) continue
      const ref = val(d, 'ref').trim()
      if (!ref || seen.has(ref.toUpperCase())) continue
      seen.add(ref.toUpperCase())
      out.push({ ref, floor: val(d, 'floor').trim(),
                 note: [d.room && `Room ${d.room}`, d.fire && `Fire ${d.fire}`, d.type, d.description].filter(Boolean).join(' · ') })
    }
    return out
  }, [doors, pick, edit])
  const onJob = doors.filter(d => d.on_job).length
  const shown = (tab === 'check' ? toCheck : doors)
    .filter(d => !q.trim() || `${val(d, 'ref')} ${val(d, 'floor')} ${d.room} ${d.fire}`.toLowerCase().includes(q.trim().toLowerCase()))
  const set = (d, k, v) => setEdit(e => ({ ...e, [d.id]: { ...e[d.id], [k]: v } }))
  const cols = data.columns || {}
  const from = [
    `door numbers from "${cols.door}"`,
    cols.floor ? `floor from "${cols.floor}"` : doors.some(d => d.floor) ? 'floor from the headings in the sheet' : 'no floor in the sheet',
    cols.room && `room from "${cols.room}"`,
    cols.fire && `fire rating from "${cols.fire}"`,
  ].filter(Boolean).join(', ')

  const apply = async () => {
    if (!adding.length) return
    if (open.length && !await ask({
      title: `${open.length} still to look at`,
      body: `${open.length === 1 ? 'It is' : 'They are'} left off for now. The other ${adding.length} go on the job.`,
      confirm: `Add ${adding.length} door${adding.length !== 1 ? 's' : ''}`,
    })) return
    setBusy(true)
    try {
      const res = await apiFetch(`/projects/${projectId}/door-list/apply`, { method: 'POST',
        body: JSON.stringify({ doors: adding, set_id: target ? Number(target) : null }) })
      showToast(`${res.added} door${res.added !== 1 ? 's' : ''} added to ${res.project}${res.skipped.length ? `, ${res.skipped.length} already on it` : ''}`, 'success')
      onNavigate('door-summary', { id: projectId })
    } catch (err) { showToast(err.message, 'error') }
    finally { setBusy(false) }
  }

  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} crumbsRight={
        <>
          <button className="btn btn-ghost back-jobs" onClick={() => onNavigate('job', { id: projectId })}><IconLeft size={16} /> Back to job</button>
          <button className="btn" onClick={onAnother}>Read other files</button>
        </>
      } />
      {confirmModal}
      <div className="page-wrap wide">
        <div className="pr-head">
          <div className="pv-stats">
            <div className="pv-stat"><div className="num">{adding.length}</div><div className="lbl">Doors to add</div></div>
            <div className={`pv-stat${open.length ? ' pr-stat-amber' : ''}`}><div className="num">{open.length}<span className="of">/{toCheck.length}</span></div><div className="lbl">Still to look at</div></div>
            {onJob > 0 && <div className="pv-stat"><div className="num">{onJob}</div><div className="lbl">Already on job</div></div>}
          </div>
          <div className="pr-style card-panel">
            <div className="pr-style-head"><h2 className="card-title">{data.name}</h2></div>
            <p className="muted dl-from">Sheet "{data.sheet}": {from}.{data.sheets?.length > 1 ? ` The other sheets (${data.sheets.filter(t => t !== data.sheet).join(', ')}) had no door list.` : ''}</p>
          </div>
        </div>

        <div className="dl-grid">
          <section className="card-panel dl-table-wrap">
            <div className="dl-bar">
              <div className="pr-tabs dl-tabs">
                <button className={tab === 'check' ? 'on' : ''} onClick={() => setTab('check')}>To look at <span>{open.length}</span></button>
                <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>All rows <span>{doors.length}</span></button>
              </div>
              <label className="adm-search dl-search"><IconSearch size={16} /><input placeholder="Find a door, floor or room" value={q} onChange={e => setQ(e.target.value)} /></label>
            </div>
            {tab === 'check' && toCheck.length === 0 && <p className="muted pr-empty"><IconCheck size={16} /> Nothing to look at. Every row read cleanly.</p>}
            {shown.length > 0 && (
              <table className="ledger dl-table">
                <thead><tr><th className="dl-tick">Add</th><th>Door</th><th>Floor</th><th>Room</th><th>Fire rating</th><th>Row</th><th></th></tr></thead>
                <tbody>
                  {shown.slice(0, 1500).map(d => {
                    const inn = isIn(d), undecided = d.status === 'amber' && !d.on_job && pick[d.id] === undefined
                    return (
                      <tr key={d.id} className={`${d.on_job ? 'dl-job' : !inn ? 'dl-out' : ''}${undecided ? ' dl-open' : ''}`}>
                        <td className="dl-tick"><input type="checkbox" checked={inn} disabled={d.on_job}
                                                       onChange={e => setPick(p => ({ ...p, [d.id]: e.target.checked }))} aria-label={`Add ${d.ref}`} /></td>
                        <td><input className="form-control dl-in dl-ref" value={val(d, 'ref')} onChange={e => set(d, 'ref', e.target.value)} disabled={d.on_job} /></td>
                        <td><input className="form-control dl-in" value={val(d, 'floor')} placeholder="Floor" onChange={e => set(d, 'floor', e.target.value)} disabled={d.on_job} /></td>
                        <td className="dl-room">{d.room}</td>
                        <td>{d.fire}</td>
                        <td className="muted dl-row">{d.row}</td>
                        <td className="dl-why">
                          {d.on_job ? <span className="muted">Already on the job</span>
                            : d.status === 'amber' ? <>
                                <span className="dl-reason"><IconWarn size={13} /> {d.reasons.join('. ')}</span>
                                {undecided && <span className="dl-acts">
                                  <button className="btn btn-sm" onClick={() => setPick(p => ({ ...p, [d.id]: true }))}>Keep</button>
                                  <button className="btn btn-sm" onClick={() => setPick(p => ({ ...p, [d.id]: false }))}>Not a door</button>
                                </span>}
                              </> : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </section>
          <aside className="pr-side card-panel dl-side">
            <div className="pr-foot">
              <label>Set for these doors
                <select className="form-control" value={target} onChange={e => setTarget(e.target.value)}>
                  <option value="">Choose later</option>
                  {(job?.sets || []).map(js => <option key={js.set.id} value={js.set.id}>{js.set.code} · {js.set.name}</option>)}
                </select>
              </label>
              <p className="muted dl-note">Room and fire rating go into each door's note.</p>
              <button className="btn btn-primary wide" onClick={apply} disabled={!adding.length || busy}>
                {busy ? <span className="spinner" /> : `Add ${adding.length} door${adding.length !== 1 ? 's' : ''} to the job`}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </>
  )
}
