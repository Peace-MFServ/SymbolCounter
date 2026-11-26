import React, { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { apiFetch, useAuthImage, downloadBlob } from './api'
import { showToast } from './toast'
import { Topbar, clockOf } from './Dashboard'
import logo from './assets/mf-logo.jpeg'
import { useAuth } from './auth'
import { useConfirm } from './confirm'
import { JobSteps } from './JobSteps'
import { IconUpload, IconCheck, IconWarn, IconSearch, IconLeft, IconPlus, IconFile } from './icons'

const refKey = r => (r || '').split(/(\d+)/).map(t => (/^\d+$/.test(t) ? t.padStart(8, '0') : t.toLowerCase())).join('')
const sheetKey = x => `${x.file}.${x.page}`
const MAX_ZOOM = 12
const store = {
  get: k => { try { return JSON.parse(localStorage.getItem(k) || 'null') } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private window */ } },
}
const fmtSize = n => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/* Read the doors off a job's floor plans. The tags in one style are found on
   every sheet; the sure ones are ready to confirm, the doubtful ones are listed
   for a person to look at on the plan, and then they are confirmed on the job. */
export function PlanReaderView({ projectId, setId = null, newSet = null, onNavigate }) {
  const { user } = useAuth()
  const [job, setJob] = useState(null)
  const [rid, setRid] = useState(null)
  const [r, setR] = useState(null)              // the reading
  const [busy, setBusy] = useState('')          // 'upload' | 'style' | 'apply' | 'job'
  const [booting, setBooting] = useState(true)  // looking for the job's plans as last read
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
  const [list, setList] = useState(null)        // a door list read from a spreadsheet
  const [lib, setLib] = useState(null)          // the sets: the job's own and the library
  const [target, setTarget] = useState(setId ? String(setId) : '')   // the set for every door not given one
  const [setOf, setSetOf] = useState({})        // id -> the set given to that door here
  const [ticked, setTicked] = useState(() => new Set())   // doors ticked to be given one set together
  const lastTick = useRef(null)
  const [placing, setPlacing] = useState(false)  // adding a door by hand: waiting for a click on the plan
  const [adding1, setAdding1] = useState(null)   // the door being added by hand: { file, page, x, y } (x, y null if it is on no sheet)
  const [fixing, setFixing] = useState(false)   // the wrong labels were read: show what else could be the door numbers
  const fileRef = useRef()
  const loadJob = () => {
    apiFetch(`/projects/${projectId}/job`).then(setLib).catch(() => {})
    return apiFetch(`/projects/${projectId}`).then(setJob).catch(err => showToast(err.message, 'error'))
  }
  const splitRef = useRef()
  const { ask, modal: confirmModal } = useConfirm()

  useEffect(() => {
    loadJob()
    apiFetch(`/projects/${projectId}/plan-reads`).then(data => { if (data?.id) opened(data) })
      .catch(() => {}).finally(() => setBooting(false))
  }, [projectId])

  // decisions are kept in this browser, so a reload does not lose the checking done
  useEffect(() => {
    if (!rid) return
    const s = store.get(`planread:${rid}`) || {}
    setChoice(s.choice || {}); setRefs(s.refs || {}); setFloors(s.floors || {}); setSetOf(s.setOf || {}); setTicked(new Set())
  }, [rid])
  useEffect(() => { if (rid) store.set(`planread:${rid}`, { choice, refs, floors, setOf }) }, [rid, choice, refs, floors, setOf])

  // back from making a new set for this job: give it to the doors it was made for
  const [doorsVer, setDoorsVer] = useState(0)
  useEffect(() => {
    if (!newSet) return
    const k = `newset:${projectId}`
    let st = null
    try { st = JSON.parse(sessionStorage.getItem(k) || 'null') } catch { st = null }
    if (!st) return
    if (st.itemIds?.length && !rid) return              // wait for the plans to open
    try { sessionStorage.removeItem(k) } catch { /* private window */ }
    const sid = String(newSet)
    if (st.itemIds?.length) setSetOf(m => { const o = { ...m }; for (const i of st.itemIds) o[i] = sid; return o })
    if (st.target) setTarget(sid)
    const n = (st.itemIds?.length || 0) + (st.doorIds?.length || 0)
    const after = () => { loadJob(); setDoorsVer(v => v + 1); if (n) showToast(`New set given to ${n} door${n !== 1 ? 's' : ''}`, 'success') }
    if (st.doorIds?.length) {
      apiFetch(`/projects/${projectId}/doors/assign-set`, { method: 'POST', body: JSON.stringify({ door_ids: st.doorIds, set_id: Number(sid) }) })
        .then(() => apiFetch(`/projects/${projectId}/plan-reads`)).then(d => { if (d?.id) setR(cur => (cur ? { ...cur, job_doors: d.job_doors } : cur)); after() })
        .catch(err => showToast(err.message, 'error'))
    } else after()
  }, [newSet, rid])
  const startNewSet = ({ items: xs = [], doorIds = [], target: forAll = false }) => {
    const st = { doorIds: [...doorIds, ...xs.filter(x => x.on_job && x.door_id).map(x => x.door_id)],
                 itemIds: xs.filter(x => !x.on_job).map(x => x.id), target: forAll }
    try { sessionStorage.setItem(`newset:${projectId}`, JSON.stringify(st)) } catch { /* private window */ }
    onNavigate('set', { id: 'new', projectId, fromDoors: true })
  }

  const opened = data => {
    setR(data); setRid(data.id)
    const doubtful = data.doors.some(d => d.status === 'amber' && !d.on_job) || data.checks.length > 0
    setTab(t => (rid === data.id ? t : doubtful ? 'check' : 'all'))
    // open on the sheet with the most doors on it, not on whichever file came first
    const per = {}
    for (const d of data.doors) per[sheetKey(d)] = (per[sheetKey(d)] || 0) + 1
    const first = [...data.pages].filter(p => p.readable && p.kind !== 'types').sort((a, b) => (per[sheetKey(b)] || 0) - (per[sheetKey(a)] || 0))[0]
      || data.pages.find(p => p.readable) || data.pages[0]
    setSheet(cur => cur && data.pages.some(p => sheetKey(p) === cur) ? cur : first ? sheetKey(first) : null)
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
    if (!pdfs.length) { showToast('Choose the floor plans as PDF, or the door list as Excel (.xlsx) or .csv', 'error'); return }
    const fd = new FormData()
    pdfs.forEach(f => fd.append('files', f))
    setBusy('upload')
    try {
      if (rid) {
        const data = await apiFetch(`/projects/${projectId}/plan-reads/${rid}/files`, { method: 'POST', body: fd })
        opened(data)
        const fresh = data.pages.filter(pg => pg.file >= data.names.length - pdfs.length)
        if (fresh[0]) setSheet(sheetKey(fresh[0]))
        showToast(`${pdfs.length} plan${pdfs.length !== 1 ? 's' : ''} added and read`, 'success')
      } else {
        opened(await apiFetch(`/projects/${projectId}/plan-reads`, { method: 'POST', body: fd }))
        setChoice({}); setRefs({}); setFloors({}); setSetOf({}); setTicked(new Set())
      }
      loadJob()
    }
    catch (err) { showToast(err.message, 'error') }
    finally { setBusy('') }
  }
  const readSentList = async i => {
    setBusy('upload')
    try {
      const res = await apiFetch(`/projects/${projectId}/files/${i}/door-list`, { method: 'POST' })
      if (res.problem) { showToast(res.problem, 'error'); return }
      setList(res)
    } catch (err) { showToast(err.message, 'error') }
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

  // the job itself: take it, mark it checked
  const jobAct = async (path, body) => {
    setBusy('job')
    try { setJob(await apiFetch(`/projects/${projectId}/${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined })) }
    catch (err) { showToast(err.message, 'error'); loadJob() }
    finally { setBusy('') }
  }

  // ── what the reading comes to ─────────────────────────────────────────────
  const pages = r?.pages || []
  const pageOf = useMemo(() => Object.fromEntries(pages.map(p => [sheetKey(p), p])), [pages])
  const floorOf = x => floors[sheetKey(x)] ?? (pageOf[sheetKey(x)]?.floor || '')
  const items = useMemo(() => {
    if (!r) return []
    const jd = r.job_doors || {}
    return [...r.doors.map(d => ({ ...d, kind: 'door' })), ...r.checks].map(x => {
      const ref = (refs[x.id] ?? x.ref ?? '').trim()
      const j = ref ? jd[ref.toUpperCase()] : null
      return { ...x, on_job: !!j, door_id: j?.id ?? null, job_set: j?.set_id ?? null, excluded: !!j?.excluded, ex_reason: j?.reason || '' }
    })
  }, [r, refs])
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
      seen.add(ref.toUpperCase())
      out.push({ ref, floor: floorOf(x), set_id: Number(setOf[x.id] || target) || null, side: x.side || '',
                 note: [x.dtype, x.side && x.side[0].toUpperCase() + x.side.slice(1), x.fire,
                        x.type && x.type !== ref && `Type ${x.type}`, ...(x.also || [])].filter(Boolean).join(' · ') })
    }
    return out
  }, [items, choice, refs, floors, setOf, target])
  // the sets a door can be given: the job's own first, then the library
  const setOptions = useMemo(() => [
    ...(lib?.sets || []).map(js => ({ value: String(js.set.id), code: js.set.code, label: `${js.set.code} · ${js.set.name}`, group: 'On this job' })),
    ...(lib?.library || []).map(x => ({ value: String(x.id), code: x.code, label: `${x.code} · ${x.name}`, group: 'Set library' })),
  ], [lib])
  const setCode = x => setOptions.find(o => o.value === String(x.on_job ? (x.job_set || '') : (setOf[x.id] || target || '')))?.code || ''
  const tickable = x => x.on_job || (!(x.status === 'out' && choice[x.id] !== 'keep') && choice[x.id] !== 'drop')
  // each door confirmed once, however many times its number is printed
  const jobItems = useMemo(() => { const seen = new Set(); return items.filter(x => x.on_job && !seen.has(x.door_id) && seen.add(x.door_id)) }, [items])
  const onJob = r ? Object.keys(r.job_doors || {}).length : (job?.door_count || 0)
  const excludedN = Object.values(r?.job_doors || {}).filter(v => v.excluded).length
  const withSet = adding.filter(a => a.set_id).length + Object.values(r?.job_doors || {}).filter(v => v.set_id).length
  const [excluding, setExcluding] = useState(null)     // the doors about to be excluded
  const [showOut, setShowOut] = useState(false)        // the excluded doors, folded away at the foot of the list
  const bySheet = useMemo(() => {
    const m = {}
    for (const x of items) {
      const k = sheetKey(x); m[k] ||= { green: 0, amber: 0 }
      if (x.on_job) { m[k].green++; continue }
      if (x.status === 'green' && choice[x.id] !== 'drop') m[k].green++
      if (x.status === 'amber' && !choice[x.id]) m[k].amber++
    }
    return m
  }, [items, choice])

  // doors the door types sheet sorted: external and internal, and each type
  const sided = items.filter(x => x.side && (x.kind === 'door' || x.kind === 'listed') && !(x.status === 'out' && !x.on_job) && choice[x.id] !== 'drop')
  const external = sided.filter(x => x.side === 'external')
  const externalOut = external.length > 0 && external.every(x => x.on_job && x.excluded)
  const inScope = sided.filter(x => !(x.on_job && x.excluded))
  const typeGroups = useMemo(() => {
    const g = {}
    for (const x of sided) if (x.dtype && !(x.on_job && x.excluded)) (g[x.dtype] ||= []).push(x)
    return Object.entries(g).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
  }, [items, choice])
  const leaveExternal = on => (on ? excludeThese(external.filter(x => !(x.on_job && x.excluded)), 'External, not in scope') : includeThese(external))
  const tick = (x, e, rows) => {
    const on = !ticked.has(x.id)
    const next = new Set(ticked)
    // shift-click ticks the run from the last door ticked to this one
    const from = lastTick.current != null && rows ? rows.findIndex(r => r.id === lastTick.current) : -1
    const to = rows ? rows.findIndex(r => r.id === x.id) : -1
    const run = e?.shiftKey && from >= 0 && to >= 0 ? rows.slice(Math.min(from, to), Math.max(from, to) + 1).filter(tickable) : [x]
    for (const d of run) on ? next.add(d.id) : next.delete(d.id)
    lastTick.current = x.id
    setTicked(next)
  }
  const tickThese = xs => {
    const able = xs.filter(tickable)
    const all = able.length > 0 && able.every(x => ticked.has(x.id))
    const next = new Set(ticked)
    for (const x of able) all ? next.delete(x.id) : next.add(x.id)
    setTicked(next)
  }
  const saveJobSet = async (xs, sid) => {
    const ids = [...new Set(xs.map(x => x.door_id).filter(Boolean))]
    if (!ids.length) return
    const was = r.job_doors
    setR(cur => ({ ...cur, job_doors: Object.fromEntries(Object.entries(cur.job_doors).map(([k, v]) => [k, ids.includes(v.id) ? { ...v, set_id: sid ? Number(sid) : null } : v])) }))
    try {
      await apiFetch(`/projects/${projectId}/doors/assign-set`, { method: 'POST', body: JSON.stringify({ door_ids: ids, set_id: sid ? Number(sid) : null }) })
      loadJob()
    } catch (err) { setR(cur => ({ ...cur, job_doors: was })); showToast(err.message, 'error') }
  }
  const excludeThese = async (xs, reason) => {
    const pending = xs.filter(x => !x.on_job && refOf(x))
    const confirmed = xs.filter(x => x.on_job && x.door_id && !x.excluded)
    try {
      if (pending.length) {
        const res = await apiFetch(`/projects/${projectId}/plan-reads/${rid}/apply`, { method: 'POST',
          body: JSON.stringify({ doors: pending.map(x => ({ ref: refOf(x), floor: floorOf(x), note: '', excluded: true, reason, side: x.side || '' })) }) })
        setR(cur => ({ ...cur, job_doors: res.job_doors }))
      }
      if (confirmed.length) {
        await apiFetch(`/projects/${projectId}/doors/exclude`, { method: 'POST', body: JSON.stringify({ door_ids: confirmed.map(x => x.door_id), excluded: true, reason }) })
        const d = await apiFetch(`/projects/${projectId}/plan-reads`); if (d?.id) setR(cur => ({ ...cur, job_doors: d.job_doors }))
      }
      const n = pending.length + confirmed.length
      showToast(`${n} door${n !== 1 ? 's' : ''} excluded: ${reason}`, 'info')
      setTicked(new Set()); loadJob()
    } catch (err) { showToast(err.message, 'error') }
  }
  const includeThese = async xs => {
    const ids = xs.filter(x => x.on_job && x.excluded).map(x => x.door_id)
    if (!ids.length) return
    try {
      await apiFetch(`/projects/${projectId}/doors/exclude`, { method: 'POST', body: JSON.stringify({ door_ids: ids, excluded: false }) })
      const d = await apiFetch(`/projects/${projectId}/plan-reads`); if (d?.id) setR(cur => ({ ...cur, job_doors: d.job_doors }))
      setTicked(new Set()); loadJob()
    } catch (err) { showToast(err.message, 'error') }
  }
  const giveTicked = sid => {
    const n = ticked.size
    const picked = items.filter(x => ticked.has(x.id))
    saveJobSet(picked.filter(x => x.on_job), sid)
    setSetOf(m => { const o = { ...m }; for (const x of picked) if (!x.on_job) o[x.id] = sid; return o })
    const name = setOptions.find(o => o.value === sid)?.code
    showToast(sid ? `${n} door${n !== 1 ? 's' : ''} given ${name}` : `Set taken off ${n} door${n !== 1 ? 's' : ''}`, 'success')
    setTicked(new Set())
  }
  const addByHand = async ref => {
    const at = adding1
    // already read off the plans, or confirmed: show it, do not add it twice
    const same = items.find(x => refOf(x).toUpperCase() === ref.toUpperCase() && (x.on_job || counts(x) || x.status === 'amber'))
    if (same) {
      showToast(`${refOf(same)} is already in the list`, 'info')
      setAdding1(null); setPlacing(false); setTab(same.status === 'amber' && !same.on_job ? 'check' : 'all'); show(same)
      return
    }
    try {
      const data = await apiFetch(`/projects/${projectId}/plan-reads/${rid}/manual`, { method: 'POST',
        body: JSON.stringify({ ref, file: at.file, page: at.page, x: at.x, y: at.y }) })
      setR(data); setAdding1(null); setPlacing(false); setTab('all')
      if (at.x != null) setFocus(data.added)
      showToast(`${ref} added. Confirm it with the others.`, 'success')
    } catch (err) { showToast(err.message, 'error') }
  }
  const removeByHand = async x => {
    try { setR(await apiFetch(`/projects/${projectId}/plan-reads/${rid}/manual/${x.id}`, { method: 'DELETE' })) }
    catch (err) { showToast(err.message, 'error') }
  }
  const unconfirm = async x => {
    try {
      const res = await apiFetch(`/projects/${projectId}/doors/remove`, { method: 'POST', body: JSON.stringify({ doors: [{ ref: refOf(x) }] }) })
      setR(cur => ({ ...cur, job_doors: res.job_doors })); loadJob()
    } catch (err) { showToast(err.message, 'error') }
  }
  const lefty = x => (!x.on_job && x.status === 'out' && choice[x.id] !== 'keep' ? 1 : 0)
  const show = x => { setSheet(sheetKey(x)); if (x.x != null) setFocus(x.id) }
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
      body: `${open.length === 1 ? 'It is' : 'They are'} left for now; you can come back and confirm ${open.length === 1 ? 'it' : 'them'} later. The other ${adding.length} are confirmed.`,
      confirm: `Confirm ${adding.length} door${adding.length !== 1 ? 's' : ''}`,
    })) return
    setBusy('apply')
    try {
      const res = await apiFetch(`/projects/${projectId}/plan-reads/${rid}/apply`, { method: 'POST', body: JSON.stringify({ doors: adding, set_id: target ? Number(target) : null }) })
      showToast(`${res.added} door${res.added !== 1 ? 's' : ''} confirmed${res.skipped.length ? `, ${res.skipped.length} already were` : ''}`, 'success')
      setR(cur => ({ ...cur, job_doors: res.job_doors }))
      setTicked(new Set()); setTab('all'); loadJob()
    } catch (err) { showToast(err.message, 'error') }
    finally { setBusy('') }
  }
  const download = () => downloadBlob(`/projects/${projectId}/doors.xlsx`, `${(job?.name || 'job').replace(/[^\w .-]+/g, '')} doors.xlsx`)
    .catch(err => showToast(err.message, 'error'))

  const crumbs = [
    { label: 'Jobs', onClick: () => onNavigate('dashboard') },
    { label: job?.name || '…' },
  ]
  // checked means every door was looked at: say what has not been, before it is marked
  const unreadable = (r?.pages || []).filter(p => !p.readable)
  const markChecked = async () => {
    const left = [
      open.length && `${open.length} door${open.length !== 1 ? 's are' : ' is'} still to look at`,
      adding.length && `${adding.length} door${adding.length !== 1 ? 's' : ''} read off the plans ${adding.length !== 1 ? 'are' : 'is'} not confirmed yet`,
      unreadable.length && `${unreadable.length} sheet${unreadable.length !== 1 ? 's' : ''} could not be read (${unreadable.map(p => p.name).join(', ')}), so any doors on ${unreadable.length !== 1 ? 'them' : 'it'} are not in the list`,
    ].filter(Boolean)
    if (left.length && !await ask({ title: 'Mark it checked anyway?', body: `${left.join('. ')}.`, confirm: 'Mark checked' })) return
    jobAct('checked', { done: true })
  }
  // door schedules the architect sent with the job, each with its place in the files sent
  const sentLists = (job?.files || []).map((f, i) => ({ ...f, i })).filter(f => f.kind !== 'pdf')
  const mine = !job?.owner_id || job.owner_id === user?.id
  const theirs = job && !mine ? job.owner_name : ''
  const jobButtons = job && (
    job.source === 'portal' && !job.owner_id
      ? <button className="btn btn-primary" onClick={() => jobAct('take')} disabled={!!busy}>Take it</button>
      : job.stage === 'checked'
        ? <>{mine && <button className="btn btn-ghost" onClick={() => jobAct('checked', { done: false })} disabled={!!busy}>Reopen</button>}<span className="stage-pill done">Checked{job.owner_name ? ` by ${job.owner_name}` : ''}</span></>
        : mine && <button className="btn btn-primary" onClick={markChecked} disabled={!!busy || !onJob}
                          title={onJob ? 'Every door on this job has been looked over' : 'Confirm the doors first'}>Mark checked</button>
  )

  if (list) return <DoorListReview data={list} projectId={projectId} crumbs={crumbs} onNavigate={onNavigate} onBack={() => setList(null)} theirs={theirs}
                                   setOptions={setOptions} target={target} setTarget={setTarget}
                                   onDone={res => { setList(null); if (r) setR(cur => ({ ...cur, job_doors: res.job_doors })); loadJob() }} />

  if (booting) return <><Topbar crumbs={crumbs} onNavigate={onNavigate} /><div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /><p className="muted" style={{ marginTop: 14 }}>Opening the plans</p></div></>

  // ── upload ────────────────────────────────────────────────────────────────
  const plansRead = r && r.pages.some(p => p.kind !== 'types')
  if (!r || !plansRead) {
    const drop = {
      onDragOver: e => { e.preventDefault(); setDrag(true) },
      onDragLeave: () => setDrag(false),
      onDrop: e => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files) },
    }
    return (
      <>
        <Topbar crumbs={crumbs} onNavigate={onNavigate} crumbsRight={
          <>{job?.source === 'portal' && <BriefButton job={job} onRead={readSentList} busy={busy} />}<JobSteps projectId={projectId} at="doors" onNavigate={onNavigate} />{jobButtons}</>} />
        <div className="page-wrap pr-start" {...drop}>
          {sentLists.length > 0 && (job?.door_count
            ? <SentLists lists={sentLists} onRead={readSentList} busy={busy} />
            : <SentLists lists={sentLists} onRead={readSentList} busy={busy} big />)}
          {job?.door_count > 0 && <JobDoors key={`${job.door_count}.${doorsVer}`} onNewSet={mine ? ids => startNewSet({ doorIds: ids }) : null} projectId={projectId} setOptions={setOptions} canEdit={mine} onChanged={loadJob}
                                            onDownload={download} onNext={() => onNavigate('cost', { id: projectId })} />}
          <div className="page-header">
            <div>
              <h1>{sentLists.length ? 'Or read the doors from the plans' : 'Read the doors from the plans'}</h1>
              <p className="lede">Upload the architect's floor plans as exported from CAD, or their door list as a spreadsheet. The door numbers are read whatever style the architect uses. You look over the few that are not certain, then confirm them.</p>
            </div>
          </div>
          <input ref={fileRef} type="file" accept=".pdf,.xlsx,.xlsm,.csv" multiple style={{ display: 'none' }} onChange={e => { upload(e.target.files); e.target.value = '' }} />
          <div className={`empty-state drop-zone pr-drop${drag ? ' over' : ''}`} onClick={() => busy || fileRef.current.click()}>
            {busy === 'upload' ? (
              <><span className="spinner spinner-lg" /><h2 style={{ marginTop: 16 }}>Reading</h2><p>Usually a second or two a sheet.</p></>
            ) : (
              <>
                <IconUpload size={28} />
                <h2>Drop the floor plans or the door list here</h2>
                <p>Floor plans as PDF, every floor at once. Or the door list as Excel (.xlsx) or .csv. Plans that are scans or pictures cannot be read; ask for the CAD export or the spreadsheet.</p>
                <button className="btn btn-primary" onClick={e => { e.stopPropagation(); fileRef.current.click() }}>Choose files</button>
              </>
            )}
          </div>
        </div>
      </>
    )
  }

  // ── look over ─────────────────────────────────────────────────────────────
  const page = pageOf[sheet]
  // a sheet goes by its floor; two sheets of one floor (Part 2, Part 3) add what differs in their file names
  const sheetLabel = p => {
    if (p.kind === 'types') return 'Door types'
    const fl = floorOf(p), bare = p.name.replace(/\.pdf$/i, '')
    if (!fl) return bare.length > 30 ? bare.slice(0, 29) + '…' : bare
    const same = pages.filter(x => floorOf(x) === fl && x.file !== p.file)
    if (!same.length) return fl
    const words = bare.split(/[\s_]+/)
    const others = new Set(same.flatMap(x => x.name.replace(/\.pdf$/i, '').split(/[\s_]+/)))
    const i = words.map((w, j) => (!others.has(w) && w !== '-' ? j : -1)).filter(j => j >= 0).pop()
    const own = i === undefined ? '' : `${i > 0 && /^[A-Za-z]+$/.test(words[i - 1]) ? words[i - 1] + ' ' : ''}${words[i]}`
    return `${fl} · ${(own || bare).slice(0, 18)}`
  }
  const onSheet = items.filter(x => sheetKey(x) === sheet)
  const fams = r.families.slice(0, 6)
  const chosen = new Set(r.chosen)
  const extra = r.chosen.filter(k => !fams.some(f => f.key === k))
  const jobOnce = new Set(jobItems.map(x => x.id))
  const everyDoor = items.filter(x => x.on_job ? jobOnce.has(x.id) : (x.kind === 'door' && x.status !== 'amber'))
  const outOfScope = everyDoor.filter(x => x.on_job && x.excluded)
    .sort((a, b) => refKey(refOf(a)).localeCompare(refKey(refOf(b))))
  const allDoors = everyDoor.filter(x => !(x.on_job && x.excluded))
  const listed = (tab === 'check' ? toCheck : allDoors)
    .filter(x => !q.trim() || `${refOf(x)} ${x.printed || ''} ${floorOf(x)}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => tab === 'check' ? 0 : (lefty(a) - lefty(b)) || refKey(refOf(a)).localeCompare(refKey(refOf(b))))
  const firstOut = tab === 'all' ? listed.findIndex(lefty) : -1

  const clock = job && clockOf(job)
  const scans = pages.filter(p => !p.readable)
  return (
    <div className="pr-full">
      {/* One slim bar: where you are, the job, and what to do with it */}
      <header className="pr-bar">
        <a className="pr-bar-logo" onClick={() => onNavigate('dashboard')} title="Jobs"><img src={logo} alt="MF Services" /></a>
        <button className="btn btn-ghost btn-sm pr-bar-back" onClick={() => onNavigate('dashboard')}><IconLeft size={15} /> Jobs</button>
        <div className="pr-bar-title" title={job?.name}>
          <strong>{job?.name || '…'}</strong>
          <span>{[job?.client, job?.site].filter(Boolean).join(' · ')}</span>
        </div>
        {clock && <span className={`in-clock ${clock.cls}`}>{clock.text}</span>}
        {scans.length > 0 && <span className="pr-bar-warn"><IconWarn size={13} /> {scans.length} sheet{scans.length !== 1 ? 's' : ''} cannot be read</span>}
        {job?.source === 'portal' && <BriefButton job={job} onRead={readSentList} busy={busy} />}
        {theirs && <span className="pr-bar-theirs">{theirs} has this job</span>}
        <span className="spacer" />
        <JobSteps projectId={projectId} at="doors" onNavigate={onNavigate} compact />
        <input ref={fileRef} type="file" accept=".pdf,.xlsx,.xlsm,.csv" multiple style={{ display: 'none' }} onChange={e => { upload(e.target.files); e.target.value = '' }} />
        {mine && <button className="btn btn-sm" onClick={() => fileRef.current.click()} disabled={!!busy}>{busy === 'upload' ? <><span className="spinner" /> Reading...</> : 'Add plans'}</button>}
        <button className="btn btn-sm" onClick={download} disabled={!onJob} title="The confirmed doors as a spreadsheet, with their sets">Download doors</button>
        {jobButtons}
      </header>
      {confirmModal}
      {adding1 && <AddDoorModal placed={adding1.x != null} floor={page ? floorOf(page) : ''} onAdd={addByHand} onClose={() => setAdding1(null)} />}
      {excluding && <ExcludeModal count={excluding.length} onClose={() => setExcluding(null)}
                                  onExclude={reason => { const xs = excluding; setExcluding(null); excludeThese(xs, reason) }} />}
      <div className="pr-split" ref={splitRef}>
        {/* Left half: the plan, edge to edge */}
        <section className="pr-pane pr-left">
          <div className="pr-sheetrow">
            <div className="pr-sheets">
              {pages.map(p => {
                const k = sheetKey(p), c = bySheet[k] || { green: 0, amber: 0 }
                return (
                  <button key={k} className={`pr-sheet-tab${k === sheet ? ' on' : ''}${!p.readable ? ' bad' : ''}`} onClick={() => { setSheet(k); setFocus(null) }} title={p.name}>
                    <span className="pr-sheet-name">{sheetLabel(p)}{pages.filter(x => x.file === p.file).length > 1 ? ` · p${p.page}` : ''}</span>
                    <span className="pr-sheet-n">{p.kind === 'types' ? 'sheet' : p.readable ? <>{c.green}{c.amber > 0 && <em> · {c.amber} to check</em>}</> : 'cannot be read'}</span>
                  </button>
                )
              })}
            </div>
            {page && page.kind !== 'types' && (
              <label className="pr-floor-in">Floor
                <input className="form-control" value={floorOf(page)} placeholder="e.g. Ground" onChange={e => setFloors(f => ({ ...f, [sheet]: e.target.value }))} />
              </label>
            )}
          </div>
          {(page?.info || page?.note || (page && !page.readable)) && (
            <SheetNotes key={sheet} info={page.info} note={page.note} problem={page && !page.readable ? page.problem : ''} />
          )}
          {placing && (
            <div className="pr-placing">
              <strong>Click where the door is on the plan.</strong>
              <button className="link-btn inline" onClick={() => page && setAdding1({ file: page.file, page: page.page, x: null, y: null })}>It is not on this plan</button>
              <button className="link-btn inline" onClick={() => setPlacing(false)}>Cancel</button>
            </div>
          )}
          {page && <Sheet key={sheet} projectId={projectId} rid={rid} page={page} items={onSheet} focus={focus}
                          stateOf={x => markState(x, choice, counts)} ticked={ticked} setCode={setCode}
                          onPick={(x, e) => { if (e?.shiftKey && tickable(x)) { tick(x); return } setFocus(x.id); setTab(x.status === 'amber' && !x.on_job ? 'check' : 'all') }}
                          labels={picking ? labels : null} onLabel={l => chooseStyles([l.key])}
                          placing={placing} onPlace={pt => setAdding1({ file: page.file, page: page.page, ...pt })} />}
        </section>

        {/* Right half: the doors read off it */}
        <section className="pr-pane pr-right">
          <div className="pr-pane-head">
            <div className="pr-counts-row">
            <div className="pr-counts">
              <div className={onJob - excludedN ? 'green' : ''}><strong>{onJob - excludedN}</strong><span>Confirmed</span></div>
              <div className={adding.length ? 'blue' : ''}><strong>{adding.length}</strong><span>To confirm</span></div>
              <div className={open.length ? 'amber' : ''}><strong>{open.length}</strong><span>Still to look at</span></div>
              <div><strong>{withSet}<em>/{onJob - excludedN + adding.length}</em></strong><span>Have a set</span></div>
              {excludedN > 0 && <div className="muted-count"><strong>{excludedN}</strong><span>Excluded</span></div>}
            </div>
            {external.length > 0 && mine && (
              <label className="pr-extout" title="External doors stay on the job, greyed out, and are listed as excluded on the schedule">
                <input type="checkbox" checked={externalOut} onChange={e => leaveExternal(e.target.checked)} /> Leave external doors out ({external.length})
              </label>
            )}
            {!fixing && <button className="link-btn inline pr-fix-link" onClick={() => setFixing(true)}>Not the door numbers?</button>}
            </div>
            {fixing && <div className="pr-style">
              <div className="pr-style-top">
                <span className="pr-style-label">These labels were read as the door numbers. If that is wrong, choose the right ones, or click a door number on the plan.</span>
                <button className="link-btn inline" onClick={() => { setFixing(false); setPicking(false) }}>Close</button>
              </div>
              <div className="pr-chips">
                {fams.map(f => (
                  <button key={f.key} className={`chip-btn${chosen.has(f.key) ? ' on' : ''}`} disabled={!!busy}
                          title={`${f.count} different tags like ${f.example}${f.at_doors != null ? `, ${Math.round(f.at_doors * 100)}% beside a door` : ''}`}
                          onClick={() => chooseStyles(chosen.has(f.key) ? r.chosen.filter(k => k !== f.key) : [...r.chosen, f.key])}>
                    Labels like {f.example} <span className="pr-chip-n">{f.count}</span>
                  </button>
                ))}
                {extra.map(k => <span key={k} className="chip-btn on">Picked on the plan</span>)}
                <button className={`btn btn-sm ${picking ? 'btn-primary' : 'btn-soft'}`} onClick={() => setPicking(p => !p)} disabled={!!busy}>
                  {picking ? 'Now click a door number on the plan' : 'Click one on the plan'}
                </button>
                {busy === 'style' && <span className="spinner" />}
              </div>
            </div>}
            {r.problems.map(p => <div key={p.file} className="pr-sheet-note"><strong>{p.name}</strong> {p.problem}</div>)}
            {sentLists.length > 0 && <SentLists lists={sentLists} onRead={readSentList} busy={busy} />}
            <div className="pr-listbar">
              <div className="pr-tabs">
                <button className={tab === 'check' ? 'on' : ''} onClick={() => setTab('check')}>To look at <span>{open.length}</span></button>
                <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>All doors <span>{allDoors.length}</span></button>
              </div>
              <button className={`btn btn-sm pr-add-door ${placing ? 'btn-primary' : 'btn-soft'}`} onClick={() => { setPlacing(v => !v); setPicking(false) }}
                      title="A door the reader missed: add it yourself"><IconPlus size={14} /> Add a door</button>
              <label className="adm-search pr-search"><IconSearch size={16} /><input placeholder="Find a door or floor" value={q} onChange={e => setQ(e.target.value)} /></label>
            </div>
          </div>
          {(tab === 'all' || ticked.size > 0) && (
            <div className={`pr-bulk${ticked.size ? ' on' : ''}`}>
              {ticked.size ? (
                <>
                  <strong>{ticked.size} door{ticked.size !== 1 ? 's' : ''} ticked</strong>
                  <span>Give {ticked.size === 1 ? 'it' : 'them'}</span>
                  <SetPick value="" options={setOptions} blank="Choose a set..." onChange={giveTicked} always
                           onNew={mine ? () => startNewSet({ items: items.filter(x => ticked.has(x.id)) }) : null} />
                  <button className="link-btn inline" onClick={() => giveTicked('')}>Take set off</button>
                  {mine && <button className="btn btn-sm" onClick={() => setExcluding(items.filter(x => ticked.has(x.id)))}>Exclude</button>}
                  {mine && items.some(x => ticked.has(x.id) && x.excluded) && <button className="link-btn inline" onClick={() => includeThese(items.filter(x => ticked.has(x.id)))}>Include again</button>}
                  <button className="link-btn inline" onClick={() => setTicked(new Set())}>Untick all</button>
                </>
              ) : (
                <>
                  <span>Tick doors to give them one set together:</span>
                  <button className="chip-btn" onClick={() => tickThese(onSheet)}>This sheet</button>
                  <button className="chip-btn" onClick={() => tickThese(items.filter(x => !(x.on_job && x.excluded)))}>Every door</button>
                  {inScope.some(x => x.side === 'internal') && <button className="chip-btn" onClick={() => tickThese(inScope.filter(x => x.side === 'internal'))}>Internal ({inScope.filter(x => x.side === 'internal').length})</button>}
                  {inScope.some(x => x.side === 'external') && <button className="chip-btn" onClick={() => tickThese(inScope.filter(x => x.side === 'external'))}>External ({inScope.filter(x => x.side === 'external').length})</button>}
                  {typeGroups.map(([t, xs]) => <button key={t} className="chip-btn" onClick={() => tickThese(xs)}>{t} ({xs.length})</button>)}
                  <span className="muted">or pick a set on a door's own row</span>
                </>
              )}
            </div>
          )}
          <div className={`pr-list${tab === 'all' ? ' two' : ''}`}>
            {tab === 'check' && toCheck.length === 0 && <p className="muted pr-empty"><IconCheck size={16} /> Nothing to look at. Every door was read cleanly.</p>}
            {listed.length > 0 && tab === 'check' && <div className="pr-row pr-row-head"><span /><span /><span>Door</span><span>Floor</span><span>Note</span><span>Set</span><span /></div>}
            {listed.slice(0, 600).map((x, i) => (
              <React.Fragment key={x.id}>
                {i === firstOut && <div className="pr-list-head">Left out ({listed.length - firstOut})</div>}
                <Row x={x} focus={focus === x.id} choice={choice[x.id]} ref_={refs[x.id] ?? x.ref ?? ''}
                     floor={floorOf(x)} onShow={() => show(x)} onChoose={c => decide(x, c)}
                     onRef={v => setRefs(m => ({ ...m, [x.id]: v }))}
                     canSet={tickable(x)} ticked={ticked.has(x.id)} onTick={e => tick(x, e, listed)}
                     setValue={x.on_job ? String(x.job_set || '') : (setOf[x.id] || '')} setOptions={setOptions} fallback={x.on_job ? '' : target}
                     onNewSet={mine ? () => startNewSet({ items: [x] }) : null}
                     onSet={v => (x.on_job ? saveJobSet([x], v) : setSetOf(m => ({ ...m, [x.id]: v })))}
                     onRemove={() => removeByHand(x)} onUnconfirm={mine ? () => unconfirm(x) : null}
                     onInclude={mine ? () => includeThese([x]) : null} />
              </React.Fragment>
            ))}
            {tab === 'all' && outOfScope.length > 0 && (
              <div className="pr-list-head pr-out-head">
                <button className="link-btn inline" onClick={() => setShowOut(v => !v)}>
                  Excluded ({outOfScope.length}) · {showOut ? 'Hide' : 'Show'}
                </button>
                <span className="muted">{[...new Set(outOfScope.map(x => x.ex_reason))].join(', ')}</span>
              </div>
            )}
            {tab === 'all' && showOut && outOfScope.map(x => (
              <Row key={x.id} x={x} focus={focus === x.id} choice={choice[x.id]} ref_={refs[x.id] ?? x.ref ?? ''}
                   floor={floorOf(x)} onShow={() => show(x)} onChoose={c => decide(x, c)} onRef={() => {}}
                   canSet={false} ticked={false} onTick={() => {}} setValue="" setOptions={setOptions}
                   onSet={() => {}} onRemove={() => {}} onInclude={mine ? () => includeThese([x]) : null} />
            ))}
          </div>
          <div className="pr-foot">
            <label>Set for every door not given one above
              <SetPick value={target} options={setOptions} blank="None: choose later" onChange={setTarget} always wide
                       onNew={mine ? () => startNewSet({ target: true }) : null} />
            </label>
            {!adding.length && onJob > 0 && <button className="btn" onClick={() => onNavigate('cost', { id: projectId })}>Next: prices</button>}
            <button className="btn btn-primary" onClick={apply} disabled={!adding.length || !!busy || !mine}>
              {busy === 'apply' ? <span className="spinner" /> : adding.length ? `Confirm ${adding.length} door${adding.length !== 1 ? 's' : ''}` : onJob ? 'All confirmed' : 'No doors to confirm'}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

/* What the architect sent with the job: who, the brief and the files as sent,
   opened from the bar so the plan keeps the screen. */
function BriefButton({ job, onRead, busy }) {
  const [open, setOpen] = useState(false)
  const box = useRef()
  useEffect(() => {
    if (!open) return
    const away = e => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    const key = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key) }
  }, [open])
  const c = job.contact || {}
  const files = job.files || []
  const scans = files.filter(f => f.kind === 'pdf' && f.unreadable?.length)
  return (
    <div className="pr-brief" ref={box}>
      <button className={`btn btn-sm ${open ? 'btn-soft' : 'btn-ghost'}`} onClick={() => setOpen(!open)}>
        {c.name || 'Architect'}{c.company ? `, ${c.company}` : ''} · Brief and files ({files.length})
      </button>
      {open && (
        <div className="pr-brief-pop">
          <div className="pr-brief-who">
            <strong>{c.name}</strong>{c.company ? `, ${c.company}` : ''}
            {c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
            {c.phone && <a href={`tel:${c.phone.replace(/\s+/g, '')}`}>{c.phone}</a>}
          </div>
          <h3>Brief</h3>
          <p className="pr-sent-brief">{job.brief}</p>
          <h3>Files sent</h3>
          <ul className="pr-sent-files">
            {files.map((f, i) => (
              <li key={i}>
                <IconFile size={15} />
                <span className="pr-sent-fname">{f.name}</span>
                <span className="muted">{fmtSize(f.size)}</span>
                <button className="link-btn inline" onClick={() => downloadBlob(`/projects/${job.id}/files/${i}`, f.name).catch(err => showToast(err.message, 'error'))}>Download</button>
                {f.kind !== 'pdf' && <button className="link-btn inline" disabled={!!busy} onClick={() => { setOpen(false); onRead(i) }}>Read the doors in it</button>}
              </li>
            ))}
          </ul>
          {scans.length > 0 && <p className="pr-sent-warn"><IconWarn size={13} /> {scans.map(f => f.name).join(', ')}: some sheets have no text and look like scans. Doors on those sheets cannot be read; ask the architect for the CAD export.</p>}
        </div>
      )}
    </div>
  )
}

/* What the reader says about a sheet: one line, opened in full on a click. */
function SheetNotes({ info, note, problem }) {
  const [open, setOpen] = useState(false)
  const text = [problem, note, info].filter(Boolean)
  const warn = !!(problem || note)
  return (
    <div className={`pr-notes${warn ? ' warn' : ''}${open ? ' open' : ''}`} onClick={() => setOpen(!open)} title={open ? 'Show less' : 'Show all'}>
      {warn && <IconWarn size={13} />}
      <span>{text.join(' ')}</span>
    </div>
  )
}

/* Doors that are on the drawings but not ours to supply: why, said once for them all. */
const EXCLUDE_REASONS = ['By others', 'External, not in scope', 'Existing door, no new ironmongery', 'Supplied with the door']
function ExcludeModal({ count, onExclude, onClose }) {
  const [reason, setReason] = useState('By others')
  useEffect(() => {
    const key = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [])
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="modal unsaved-modal" onSubmit={e => { e.preventDefault(); if (reason.trim()) onExclude(reason.trim()) }}>
        <h2>Exclude {count} door{count !== 1 ? 's' : ''}</h2>
        <p style={{ marginTop: 8 }}>They stay on the job, greyed out, with no set or price. The schedule lists them under Excluded on its Notes page.</p>
        <div className="ex-chips">
          {EXCLUDE_REASONS.map(r => <button type="button" key={r} className={`chip-btn${reason === r ? ' on' : ''}`} onClick={() => setReason(r)}>{r}</button>)}
        </div>
        <label className="pr-add-label">Reason
          <input className="form-control" value={reason} onChange={e => setReason(e.target.value)} maxLength={120} autoFocus />
        </label>
        <div className="modal-actions">
          <button className="btn btn-primary" type="submit" disabled={!reason.trim()}>Exclude {count} door{count !== 1 ? 's' : ''}</button>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  )
}

/* The doors confirmed on a job that has no plans to show them on: each with its
   set, ticked to give several one set, or taken off. */
function JobDoors({ projectId, setOptions, canEdit, onChanged, onDownload, onNext, onNewSet }) {
  const [doors, setDoors] = useState(null)
  const [ticked, setTicked] = useState(() => new Set())
  const [q, setQ] = useState('')
  const [excluding, setExcluding] = useState(null)
  const [showOut, setShowOut] = useState(false)
  const load = () => apiFetch(`/projects/${projectId}/doors`).then(setDoors).catch(err => showToast(err.message, 'error'))
  useEffect(() => { load() }, [projectId])
  if (!doors) return null
  const give = async (ids, sid) => {
    try {
      await apiFetch(`/projects/${projectId}/doors/assign-set`, { method: 'POST', body: JSON.stringify({ door_ids: ids, set_id: sid ? Number(sid) : null }) })
      setTicked(new Set()); await load(); onChanged()
    } catch (err) { showToast(err.message, 'error') }
  }
  const remove = async d => {
    try { await apiFetch(`/projects/${projectId}/doors/remove`, { method: 'POST', body: JSON.stringify({ doors: [{ ref: d.ref }] }) }); await load(); onChanged() }
    catch (err) { showToast(err.message, 'error') }
  }
  const matching = doors.filter(d => !q.trim() || `${d.ref} ${d.floor} ${d.note} ${d.side}`.toLowerCase().includes(q.trim().toLowerCase()))
  const shown = matching.filter(d => !d.excluded || showOut)
  const ext = doors.filter(d => d.side === 'external')
  const extOut = ext.length > 0 && ext.every(d => d.excluded)
  const noSet = doors.filter(d => !d.effective_set_id && !d.excluded).length
  const nExcluded = doors.filter(d => d.excluded).length
  const exclude = async (ids, excluded, reason = '') => {
    try {
      await apiFetch(`/projects/${projectId}/doors/exclude`, { method: 'POST', body: JSON.stringify({ door_ids: ids, excluded, reason }) })
      setTicked(new Set()); await load(); onChanged()
    } catch (err) { showToast(err.message, 'error') }
  }
  const allTicked = shown.length > 0 && shown.every(d => ticked.has(d.id))
  return (
    <section className="jd card-panel">
      <div className="jd-head">
        <h2>Doors on this job <span className="muted">{doors.length}</span></h2>
        <span className={noSet ? 'jd-noset' : 'jd-ok'}>{noSet ? `${noSet} without a set` : 'Every door has a set'}</span>
        {nExcluded > 0 && <span className="muted">{nExcluded} excluded</span>}
        {ext.length > 0 && canEdit && (
          <label className="pr-extout">
            <input type="checkbox" checked={extOut} onChange={e => (e.target.checked
              ? exclude(ext.filter(d => !d.excluded).map(d => d.id), true, 'External, not in scope')
              : exclude(ext.map(d => d.id), false))} /> Leave external doors out ({ext.length})
          </label>
        )}
        <span className="spacer" />
        <label className="adm-search jd-search"><IconSearch size={16} /><input placeholder="Find a door or note" value={q} onChange={e => setQ(e.target.value)} /></label>
        <button className="btn btn-sm" onClick={onDownload}>Download doors</button>
        <button className="btn btn-sm btn-primary" onClick={onNext} disabled={noSet > 0} title={noSet ? 'Give every door a set first' : ''}>Next: prices</button>
      </div>
      {canEdit && (
        <div className={`pr-bulk${ticked.size ? ' on' : ''}`}>
          {ticked.size ? (
            <>
              <strong>{ticked.size} door{ticked.size !== 1 ? 's' : ''} ticked</strong>
              <span>Give {ticked.size === 1 ? 'it' : 'them'}</span>
              <SetPick value="" options={setOptions} blank="Choose a set..." onChange={sid => give([...ticked], sid)} always
                       onNew={onNewSet ? () => onNewSet([...ticked]) : null} />
              <button className="link-btn inline" onClick={() => give([...ticked], '')}>Take set off</button>
              <button className="btn btn-sm" onClick={() => setExcluding([...ticked])}>Exclude</button>
              {doors.some(d => ticked.has(d.id) && d.excluded) && <button className="link-btn inline" onClick={() => exclude([...ticked], false)}>Include again</button>}
              <button className="link-btn inline" onClick={() => setTicked(new Set())}>Untick all</button>
            </>
          ) : <span>Tick doors to give them one set together, or pick a set on a door's own row.</span>}
        </div>
      )}
      {excluding && <ExcludeModal count={excluding.length} onClose={() => setExcluding(null)}
                                  onExclude={reason => { const ids = excluding; setExcluding(null); exclude(ids, true, reason) }} />}
      <table className="ledger jd-table">
        <thead><tr>
          <th className="jd-tick">{canEdit && <input type="checkbox" checked={allTicked} onChange={() => setTicked(allTicked ? new Set() : new Set(shown.map(d => d.id)))} aria-label="Tick every door shown" />}</th>
          <th>Door</th><th>Floor</th><th>Note</th><th>Set</th><th /></tr></thead>
        <tbody>
          {shown.map(d => (
            <tr key={d.id} className={`${ticked.has(d.id) ? 'ticked' : ''}${d.excluded ? ' jd-excluded' : ''}`}>
              <td className="jd-tick">{canEdit && <input type="checkbox" checked={ticked.has(d.id)} onChange={() => setTicked(t => { const n = new Set(t); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n })} aria-label={`Tick ${d.ref}`} />}</td>
              <td className="jd-ref">{d.ref}</td>
              <td>{d.floor}</td>
              <td className="jd-note">{d.note}</td>
              <td>{d.excluded ? <span className="pr-excl">Excluded: {d.excluded_reason}</span>
                : canEdit ? <SetPick value={String(d.effective_set_id || '')} options={setOptions} onChange={sid => give([d.id], sid)} onNew={onNewSet ? () => onNewSet([d.id]) : null} /> : d.effective_set_code}</td>
              <td className="jd-acts">{canEdit && (d.excluded
                ? <button className="btn btn-sm btn-ghost" onClick={() => exclude([d.id], false)}>Include</button>
                : <button className="btn btn-sm btn-ghost" onClick={() => remove(d)}>Remove</button>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {nExcluded > 0 && (
        <div className="pr-list-head pr-out-head">
          <button className="link-btn inline" onClick={() => setShowOut(v => !v)}>Excluded ({nExcluded}) · {showOut ? 'Hide' : 'Show'}</button>
        </div>
      )}
    </section>
  )
}

/* The architect's door schedule: the most direct way to the doors, so it is offered first. */
function SentLists({ lists, onRead, busy, big = false, confirmed = 0, onDownload = null }) {
  return (
    <div className={`pr-lists${big ? ' big' : ''}`}>
      {big && <h2>The architect sent a door schedule</h2>}
      {lists.map(f => (
        <div key={f.i} className="pr-list-file">
          <IconFile size={16} />
          <span className="pr-list-name">{f.name}</span>
          <span className="muted">{f.doors ? `${f.doors} door${f.doors !== 1 ? 's' : ''} in it` : 'no door numbers found in it'}</span>
          <button className={`btn btn-sm ${big ? 'btn-primary' : 'btn-soft'}`} disabled={!!busy} onClick={() => onRead(f.i)}>Read the doors in it</button>
        </div>
      ))}
      {big && confirmed > 0 && (
        <p className="pr-lists-done"><IconCheck size={15} /> {confirmed} door{confirmed !== 1 ? 's' : ''} confirmed on this job.
          {onDownload && <button className="link-btn inline" onClick={onDownload}>Download doors</button>}</p>
      )}
    </div>
  )
}

function markState(x, choice, counts) {
  if (x.on_job && x.excluded) return 'out'
  if (x.on_job) return 'green'
  if (x.kind === 'gap') return choice[x.id] === 'keep' ? 'green' : choice[x.id] === 'drop' ? 'out' : 'gap'
  if (x.status === 'amber' && !choice[x.id]) return 'amber'
  return counts(x) ? 'green' : 'out'
}

function Row({ x, focus, choice, ref_, floor, onShow, onChoose, onRef, canSet, ticked, onTick, setValue, setOptions, fallback, onSet, onNewSet, onRemove, onUnconfirm, onInclude }) {
  const el = useRef()
  useEffect(() => { if (focus) el.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [focus])
  const amber = x.status === 'amber' && !x.on_job
  const why = x.on_job ? '' : (x.reasons || []).join('. ')
  const keepLabel = x.kind === 'gap' || x.kind === 'listed' ? 'Add it' : x.kind === 'untagged' ? 'Add' : x.status === 'out' ? 'Count it' : 'Keep'
  const dropLabel = x.kind === 'gap' || x.kind === 'listed' ? 'No door' : 'Not a door'
  const state = x.on_job ? (x.excluded ? 'drop excluded' : 'keep onjob') : amber ? (choice || 'open') : x.status === 'out' ? (choice === 'keep' ? 'keep' : 'drop') : (choice === 'drop' ? 'drop' : 'keep')
  const numbered = x.kind !== 'untagged'
  // the door's type, where the plan gives one beside its number: B01.00.005 is an EDR251
  const kind = (x.type && !String(x.ref).startsWith(x.type)) || x.dtype
    ? <span className="pr-type" title="What the drawings say about this door">
        {[x.dtype, x.side && x.side[0].toUpperCase() + x.side.slice(1), x.fire, x.type && !String(x.ref).startsWith(x.type) && x.type].filter(Boolean).join(' · ')}
      </span> : null
  return (
    <div ref={el} className={`pr-row ${state}${focus ? ' focus' : ''}${why || amber ? ' full' : ''}${ticked ? ' ticked' : ''}`} onClick={onShow}>
      {canSet
        ? <input type="checkbox" className="pr-tick" checked={ticked} onChange={() => {}} onClick={e => { e.stopPropagation(); onTick(e) }} aria-label={`Tick ${x.ref || 'this door'}`} />
        : <span />}
      <span className="pr-dot" />
      <div className="pr-c-ref">
        {x.on_job
          ? <span className="pr-ref">{ref_ || x.ref}{kind}</span>
          : !numbered
          ? <input className="form-control pr-ref-in" value={ref_} placeholder="Door number" onClick={e => e.stopPropagation()} onChange={e => onRef(e.target.value)} aria-label="Door number" />
          : x.kind === 'gap' || !amber
            ? <span className="pr-ref">{x.ref}{kind}</span>
            : <input className="form-control pr-ref-in" value={ref_} onClick={e => e.stopPropagation()} onChange={e => onRef(e.target.value)} aria-label="Door reference" />}
      </div>
      <span className="pr-floor">{floor}</span>
      <div className="pr-why">
        {amber && <IconWarn size={13} />} {!numbered && <strong>Door with no tag. </strong>}{why}
      </div>
      {x.excluded ? <span className="pr-excl" title={x.ex_reason}>Excluded: {x.ex_reason}</span>
        : canSet ? <SetPick value={setValue} options={setOptions} fallback={fallback} onChange={onSet} onNew={onNewSet} /> : <span />}
      <div className="pr-acts" onClick={e => e.stopPropagation()}>
        {amber && <button className="btn btn-sm btn-soft pr-where" onClick={onShow} title="Move the plan to this door">Where is it</button>}
        {x.on_job && x.excluded ? (
          onInclude && <button className="btn btn-sm btn-ghost pr-leave" onClick={onInclude} title="Put this door back in scope">Include</button>
        ) : x.on_job ? (
          <>
            <span className="pr-onjob" title="This door is confirmed on the job">Confirmed</span>
            {onUnconfirm && <button className="btn btn-sm btn-ghost pr-leave" onClick={onUnconfirm} title="Take this door off the job">Undo</button>}
          </>
        ) : (amber || x.status === 'out') ? (
          <>
            <button className={`btn btn-sm ${choice === 'keep' ? 'btn-primary' : ''}`} onClick={() => onChoose('keep')}
                    disabled={!numbered && !ref_.trim()}>{keepLabel}</button>
            {amber && <button className={`btn btn-sm ${choice === 'drop' ? 'btn-primary' : ''}`} onClick={() => onChoose('drop')}>{dropLabel}</button>}
          </>
        ) : (
          x.src === 'manual'
            ? <button className="btn btn-sm btn-ghost pr-leave" onClick={onRemove} title="You added this door by hand">Remove</button>
            : <button className="btn btn-sm btn-ghost pr-leave" onClick={() => onChoose('drop')}>{choice === 'drop' ? 'Put back' : 'Leave out'}</button>
        )}
      </div>
    </div>
  )
}

/* A door the reader missed, added by hand: just its number. */
function AddDoorModal({ placed, floor, onAdd, onClose }) {
  const [ref, setRef] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const key = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [])
  const submit = async e => {
    e.preventDefault()
    if (!ref.trim() || busy) return
    setBusy(true)
    await onAdd(ref.trim())
    setBusy(false)
  }
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="modal unsaved-modal pr-add-modal" onSubmit={submit}>
        <h2>Add a door</h2>
        <p>{placed ? 'It will be marked where you clicked' : 'It will not be marked on a plan'}{floor ? `, on ${floor}` : ''}.</p>
        <label className="pr-add-label">Door number
          <input className="form-control" autoFocus value={ref} onChange={e => setRef(e.target.value)} placeholder="e.g. D-14" autoComplete="off" />
        </label>
        <div className="modal-actions">
          <button className="btn btn-primary" type="submit" disabled={!ref.trim() || busy}>{busy ? <span className="spinner" /> : 'Add the door'}</button>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  )
}


/* A door's set. The long list of sets is only built once the box is about to
   be used, so hundreds of doors do not each carry the whole library. */
function SetPick({ value, options, onChange, onNew = null, fallback = '', blank = '', always = false, wide = false }) {
  const [armed, setArmed] = useState(always)
  const cur = options.find(o => o.value === String(value || ''))
  const fb = options.find(o => o.value === String(fallback || ''))
  const groups = [...new Set(options.map(o => o.group))]
  return (
    <select className={`form-control pr-setpick${cur ? ' on' : ''}${wide ? ' wide' : ''}`} value={cur ? cur.value : ''}
            title={cur ? cur.label : fb ? `${fb.label} (the set for every door not given one)` : 'Give this door a set'}
            onMouseEnter={() => setArmed(true)} onFocus={() => setArmed(true)} onClick={e => e.stopPropagation()}
            onChange={e => (e.target.value === '__new' ? onNew && onNew() : onChange(e.target.value))}>
      <option value="">{blank || (fb ? `${fb.code} (all)` : 'Set...')}</option>
      {onNew && armed && <option value="__new">+ New set for this job...</option>}
      {armed
        ? groups.map(g => <optgroup key={g} label={g}>{options.filter(o => o.group === g).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>)
        : cur && <option value={cur.value}>{cur.label}</option>}
    </select>
  )
}

/* One sheet: the plan as a picture with a mark on every tag. Scroll to move
   about, Ctrl and scroll (or the buttons) to zoom, drag to pan. */
function Sheet({ projectId, rid, page, items, focus, stateOf, onPick, labels, onLabel, ticked, setCode, placing, onPlace }) {
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
  // a mark sits on its tag's middle and is never smaller than a size the eye picks out on the whole sheet
  const mark = x => {
    const [mw, mh] = x.kind === 'gap' || x.kind === 'untagged' ? [26, 26] : x.status === 'amber' ? [26, 18] : [22, 15]
    return { left: `${((x.x + x.w / 2) / W) * 100}%`, top: `${((x.y + x.h / 2) / H) * 100}%`,
             width: `max(calc(${(x.w / W) * 100}% + 8px), ${mw}px)`, height: `max(calc(${(x.h / H) * 100}% + 8px), ${mh}px)` }
  }

  const zoomTo = (z, cx = 0.5, cy = 0.5) => {
    const el = box.current
    if (!el) return
    const nz = Math.min(MAX_ZOOM, Math.max(1, z))
    const c = canvas.current
    if (!c || nz === zoomNow.current) return
    // the point of the sheet under the pointer stays under the pointer
    const px = el.scrollLeft + el.clientWidth * cx, py = el.scrollTop + el.clientHeight * cy
    anchor.current = { fx: (px - c.offsetLeft) / c.offsetWidth, fy: (py - c.offsetTop) / c.offsetHeight, cx, cy }
    zoomNow.current = nz
    setZoom(nz)
  }
  const zoomNow = useRef(1)
  const anchor = useRef(null)
  useLayoutEffect(() => {
    zoomNow.current = zoom
    const a = anchor.current, el = box.current, c = canvas.current
    if (!a || !el || !c) return
    anchor.current = null
    el.scrollLeft = c.offsetLeft + a.fx * c.offsetWidth - el.clientWidth * a.cx
    el.scrollTop = c.offsetTop + a.fy * c.offsetHeight - el.clientHeight * a.cy
  }, [zoom])
  useEffect(() => {
    const el = box.current
    if (!el) return
    // the wheel zooms, towards the pointer, as in any drawing viewer; dragging moves the plan
    const wheel = e => {
      e.preventDefault()
      const b = el.getBoundingClientRect()
      const step = Math.exp(-Math.max(-120, Math.min(120, e.deltaY * (e.deltaMode === 1 ? 33 : 1))) * 0.0016)
      zoomTo(zoomNow.current * step, (e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])
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
    if (!x || !el || x.x == null) return
    pending.current = null
    const c = canvas.current
    el.scrollTo({ left: c.offsetLeft + ((x.x + x.w / 2) / W) * c.offsetWidth - el.clientWidth / 2,
                  top: c.offsetTop + ((x.y + x.h / 2) / H) * c.offsetHeight - el.clientHeight / 2, behavior: 'smooth' })
  })

  const down = e => {
    if (e.button !== 0 || (!placing && e.target.closest('.pr-mark, .pr-label'))) return
    drag.current = { x: e.clientX, y: e.clientY, l: box.current.scrollLeft, t: box.current.scrollTop }
  }
  // adding a door by hand: a click (not a drag) on the plan says where it is
  const up = e => {
    const d = drag.current
    drag.current = null
    if (!placing || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || !canvas.current) return
    const b = canvas.current.getBoundingClientRect()
    const fx = (e.clientX - b.left) / b.width, fy = (e.clientY - b.top) / b.height
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return
    onPlace({ x: fx * W, y: fy * H })
  }
  const dbl = e => {
    if (placing || labels || e.target.closest('.pr-mark, .pr-label')) return
    const b = box.current.getBoundingClientRect()
    zoomTo(zoom * 2, (e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height)
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
        <button className="btn btn-sm pr-zoom-n" onClick={() => { zoomNow.current = 1; setZoom(1) }} disabled={zoom === 1} title="Whole sheet">{zoom === 1 ? 'Fit' : `${Math.round(zoom * 100)}%`}</button>
        <button className="btn btn-sm" onClick={() => zoomTo(zoom * 1.5)} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in">+</button>
      </div>
      <div className="pr-key">
        <span><i className="m green" /> Door</span>
        <span><i className="m amber" /> To look at</span>
        <span><i className="m gap" /> Number missing</span>
        <span><i className="m out" /> Left out</span>
        <span className="pr-key-tip">Scroll to zoom · drag to move · double-click to zoom in</span>
      </div>
      <div ref={box} className={`pr-viewer${labels || placing ? ' picking' : ''}${placing ? ' placing' : ''}`} onMouseDown={down} onMouseMove={move}
           onMouseUp={up} onMouseLeave={() => { drag.current = null }} onDoubleClick={dbl}>
        <div ref={canvas} className={`pr-canvas${zoom >= 2.5 ? ' near' : ''}`} style={{ width: base ? `${Math.round(base * zoom)}px` : `${zoom * 100}%` }}>
          {src ? <img src={src} alt={page.name} draggable={false} onLoad={() => setLoaded(true)} /> : <div className="pr-loading" style={{ aspectRatio: `${W} / ${H}` }}><span className="spinner spinner-lg" /></div>}
          {src && !labels && items.filter(x => x.x != null).map(x => (
            <button key={x.id} className={`pr-mark ${stateOf(x)}${x.kind === 'untagged' ? ' swing' : ''}${focus === x.id ? ' focus' : ''}${ticked?.has(x.id) ? ' ticked' : ''}`}
                    data-kind={x.kind} style={mark(x)} title={`${x.ref || (x.reasons || [])[0]}${setCode?.(x) ? ` · ${setCode(x)}` : ''}`} onClick={e => onPick(x, e)}>
              {x.src === 'manual' && <span className="pr-mark-ref">{x.ref}</span>}
              {stateOf(x) === 'green' && setCode?.(x) && <span className="pr-mark-set">{setCode(x)}</span>}
            </button>
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
   ones to look at, each door's number and floor correctable, then confirmed. */
function DoorListReview({ data, projectId, crumbs, onNavigate, onBack, onDone, theirs, setOptions, target, setTarget }) {
  const [pick, setPick] = useState({})      // id -> true (confirm) | false (leave out)
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
                 note: [d.room && `Room ${d.room}`, d.size && `Size ${d.size}`, d.fire && `Fire ${d.fire}`, d.type, d.description].filter(Boolean).join(' · ') })
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
    cols.size && `size from "${cols.size}"`,
    cols.fire && `fire rating from "${cols.fire}"`,
  ].filter(Boolean).join(', ')

  const apply = async () => {
    if (!adding.length) return
    if (open.length && !await ask({
      title: `${open.length} still to look at`,
      body: `${open.length === 1 ? 'It is' : 'They are'} left out for now. The other ${adding.length} are confirmed.`,
      confirm: `Confirm ${adding.length} door${adding.length !== 1 ? 's' : ''}`,
    })) return
    setBusy(true)
    try {
      const res = await apiFetch(`/projects/${projectId}/door-list/apply`, { method: 'POST', body: JSON.stringify({ doors: adding, set_id: target ? Number(target) : null }) })
      showToast(`${res.added} door${res.added !== 1 ? 's' : ''} confirmed${res.skipped.length ? `, ${res.skipped.length} already were` : ''}`, 'success')
      onDone(res)
    } catch (err) { showToast(err.message, 'error') }
    finally { setBusy(false) }
  }

  return (
    <>
      <Topbar crumbs={[...crumbs, { label: data.name }]} onNavigate={onNavigate} crumbsRight={
        <button className="btn btn-ghost back-jobs" onClick={onBack}><IconLeft size={16} /> Back to the plans</button>} />
      {confirmModal}
      <div className="page-wrap wide">
        <div className="pr-head">
          <div className="pv-stats">
            <div className="pv-stat"><div className="num">{adding.length}</div><div className="lbl">To confirm</div></div>
            <div className={`pv-stat${open.length ? ' pr-stat-amber' : ''}`}><div className="num">{open.length}<span className="of">/{toCheck.length}</span></div><div className="lbl">Still to look at</div></div>
            {onJob > 0 && <div className="pv-stat"><div className="num">{onJob}</div><div className="lbl">Already confirmed</div></div>}
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
                <thead><tr><th className="dl-tick">Confirm</th><th>Door</th><th>Floor</th><th>Room</th><th>Size</th><th>Fire rating</th><th>Row</th><th></th></tr></thead>
                <tbody>
                  {shown.slice(0, 1500).map(d => {
                    const inn = isIn(d), undecided = d.status === 'amber' && !d.on_job && pick[d.id] === undefined
                    return (
                      <tr key={d.id} className={`${d.on_job ? 'dl-job' : !inn ? 'dl-out' : ''}${undecided ? ' dl-open' : ''}`}>
                        <td className="dl-tick"><input type="checkbox" checked={inn} disabled={d.on_job}
                                                       onChange={e => setPick(p => ({ ...p, [d.id]: e.target.checked }))} aria-label={`Confirm ${d.ref}`} /></td>
                        <td><input className="form-control dl-in dl-ref" value={val(d, 'ref')} onChange={e => set(d, 'ref', e.target.value)} disabled={d.on_job} /></td>
                        <td><input className="form-control dl-in" value={val(d, 'floor')} placeholder="Floor" onChange={e => set(d, 'floor', e.target.value)} disabled={d.on_job} /></td>
                        <td className="dl-room">{d.room}</td>
                        <td className="dl-size">{d.size}</td>
                        <td>{d.fire}</td>
                        <td className="muted dl-row">{d.row}</td>
                        <td className="dl-why">
                          {d.on_job ? <span className="muted">Already confirmed</span>
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
                <SetPick value={target} options={setOptions} blank="None: choose later" onChange={setTarget} always wide />
              </label>
              <p className="muted dl-note">Room, size and fire rating go into each door's note.</p>
              {theirs && <p className="muted dl-note">{theirs} has this job. Only they can confirm doors on it.</p>}
              <button className="btn btn-primary wide" onClick={apply} disabled={!adding.length || busy || !!theirs}>
                {busy ? <span className="spinner" /> : `Confirm ${adding.length} door${adding.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </>
  )
}
