import React, { useState, useEffect, useRef } from 'react'
import logo from './assets/mf-logo.jpeg'
import { IconUpload, IconCheck, IconWarn, IconFile, IconTrash } from './icons'

/* The architect's page: a PIN, their details and the project's, the plans, a
   brief, and send. Nothing else of the app is reachable from here. */
const store = {
  get: k => { try { return JSON.parse(sessionStorage.getItem(k) || 'null') } catch { return null } },
  set: (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)) } catch { /* private window */ } },
  del: k => { try { sessionStorage.removeItem(k) } catch { /* private window */ } },
}
const BRIEF_MIN = 40
const fmtSize = n => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

async function call(path, { session, body, method = 'POST' } = {}) {
  const res = await fetch(`/api/portal${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(session ? { 'X-Portal-Session': session } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* no body */ }
  if (!res.ok) { const e = new Error(data?.detail || 'Something went wrong. Try again.'); e.status = res.status; throw e }
  return data
}

export function PortalApp() {
  const token = decodeURIComponent((window.location.hash || '').slice(1)).trim()
  const [stage, setStage] = useState('checking')   // checking | stopped | pin | form | done
  const [message, setMessage] = useState('')
  const [session, setSession] = useState(() => store.get(`portal:${token}`)?.session || '')
  const [me, setMe] = useState(null)
  const [done, setDone] = useState(null)

  useEffect(() => {
    document.title = 'MF Services · Send your plans'
    if (!token) { setMessage('This link is not complete. Open it again from the email, or contact MF Services.'); setStage('stopped'); return }
    call('/open', { body: { token } })
      .then(r => {
        if (r.state !== 'open') { setMessage(r.message); setStage('stopped'); return }
        if (!session) { setStage('pin'); return }
        // still inside from earlier in this tab
        call('/me', { session, method: 'GET' }).then(m => { setMe(m); setStage('form') }).catch(() => { setSession(''); setStage('pin') })
      })
      .catch(err => { setMessage(err.message); setStage('stopped') })
  }, [])

  const entered = r => {
    setSession(r.session); store.set(`portal:${token}`, { session: r.session })
    setMe(r); setStage('form')
  }
  const ended = err => {
    // the session ran out or the link was closed while they were on the page
    if (err.status === 401) { setSession(''); store.del(`portal:${token}`); setStage('pin'); return true }
    if (err.status === 403) { setMessage(err.message); setStage('stopped'); return true }
    return false
  }

  return (
    <div className="pt-page">
      <header className="pt-top">
        <img src={logo} alt="MF Services" />
        <span className="pt-top-words"><strong>MF Services</strong><span>Door schedule request</span></span>
      </header>
      <main className="pt-main">
        {stage === 'checking' && <div className="pt-center"><span className="spinner spinner-lg" /></div>}
        {stage === 'stopped' && (
          <section className="pt-card pt-narrow">
            <h1>Send your plans</h1>
            <p className="pt-stop">{message}</p>
          </section>
        )}
        {stage === 'pin' && <PinStep token={token} onIn={entered} />}
        {stage === 'form' && me && <FormStep token={token} session={session} me={me} setMe={setMe} onEnded={ended}
                                             onSent={r => { store.del(`portal:${token}`); store.del(`portal-form:${token}`); setDone(r); setStage('done') }} />}
        {stage === 'done' && done && (
          <section className="pt-card pt-narrow">
            <div className="pt-done-mark"><IconCheck size={28} /></div>
            <h1>Thank you. Your plans are with us.</h1>
            <p>Your reference is <strong className="pt-ref">{done.ref}</strong>. Quote it if you contact us about this project.</p>
            <p>We will have the door schedule back to you within {done.turnaround_hours} hours. If anything on the plans needs explaining, we will call you.</p>
          </section>
        )}
      </main>
      <footer className="pt-foot">MF Services · Ironmongery and door hardware</footer>
    </div>
  )
}

function PinStep({ token, onIn }) {
  const [pin, setPin] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async e => {
    e.preventDefault()
    setBusy(true); setErr('')
    try { onIn(await call('/unlock', { body: { token, pin } })) }
    catch (x) { setErr(x.message); setPin('') }
    finally { setBusy(false) }
  }
  return (
    <section className="pt-card pt-narrow">
      <h1>Send your plans</h1>
      <p>Enter the PIN MF Services gave you with this link.</p>
      <form onSubmit={submit} className="pt-pin-form">
        <label className="pt-label" htmlFor="pin">PIN</label>
        <input id="pin" className="form-control pt-pin" value={pin} onChange={e => setPin(e.target.value.toUpperCase())}
               placeholder="XXXX-XXXX-XXXX" autoComplete="off" autoCapitalize="characters" spellCheck={false} autoFocus maxLength={20} />
        {err && <p className="pt-err"><IconWarn size={14} /> {err}</p>}
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy || pin.replace(/[^A-Za-z0-9]/g, '').length < 12}>
          {busy ? <span className="spinner" /> : 'Continue'}
        </button>
      </form>
    </section>
  )
}

const EMPTY = { company: '', name: '', email: '', phone: '', project: '', site: '', brief: '', agree: false }

function FormStep({ token, session, me, setMe, onEnded, onSent }) {
  const [f, setF] = useState(() => ({ ...EMPTY, company: me.firm || '', email: me.email || '', project: me.project || '', ...(store.get(`portal-form:${token}`) || {}) }))
  const [queue, setQueue] = useState([])        // files on their way up: { key, name, size, pct, err }
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const pick = useRef()
  const working = useRef(false)
  useEffect(() => { store.set(`portal-form:${token}`, f) }, [f])
  const set = k => e => setF(cur => ({ ...cur, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  // one file at a time, each with its own progress
  const add = list => {
    const items = [...(list || [])].map(file => ({ key: `${file.name}.${file.size}.${Math.random()}`, file, name: file.name, size: file.size, pct: 0, err: '' }))
    const bad = items.filter(x => !/\.(pdf|xlsx|xlsm|csv)$/i.test(x.name))
    bad.forEach(x => { x.err = 'Only PDF floor plans and Excel (.xlsx) or .csv door lists can be sent.' })
    const big = items.filter(x => !x.err && x.size > me.limits.file_mb * 1024 * 1024)
    big.forEach(x => { x.err = `Too big. The largest a file can be is ${me.limits.file_mb} MB.` })
    setQueue(q => [...q, ...items])
  }
  useEffect(() => {
    if (working.current) return
    const next = queue.find(x => !x.err && x.pct < 100 && !x.sent)
    if (!next) return
    working.current = true
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/portal/files')
    xhr.setRequestHeader('X-Portal-Session', session)
    xhr.upload.onprogress = e => { if (e.lengthComputable) setQueue(q => q.map(x => (x.key === next.key ? { ...x, pct: Math.min(99, Math.round((e.loaded / e.total) * 100)) } : x))) }
    xhr.onload = () => {
      working.current = false
      let data = null
      try { data = JSON.parse(xhr.responseText) } catch { /* not json */ }
      if (xhr.status === 200) {
        setMe(m => ({ ...m, files: [...m.files, data] }))
        setQueue(q => q.filter(x => x.key !== next.key))
      } else {
        const e = new Error(data?.detail || 'This file could not be sent. Try again.'); e.status = xhr.status
        if (onEnded(e)) return
        setQueue(q => q.map(x => (x.key === next.key ? { ...x, err: e.message, sent: true } : x)))
      }
    }
    xhr.onerror = () => { working.current = false; setQueue(q => q.map(x => (x.key === next.key ? { ...x, err: 'The connection dropped. Remove it and try again.', sent: true } : x))) }
    const fd = new FormData()
    fd.append('file', next.file)
    xhr.send(fd)
  }, [queue])

  const remove = async file => {
    try { const r = await call(`/files/${file.id}`, { session, method: 'DELETE' }); setMe(m => ({ ...m, files: r.files })) }
    catch (e) { if (!onEnded(e)) setErr(e.message) }
  }

  const pdfs = me.files.filter(x => x.kind === 'pdf')
  const lists = me.files.filter(x => x.kind !== 'pdf' && x.doors > 0)
  const uploading = queue.some(x => !x.err)
  const missing = [
    !f.company.trim() && 'your company', !f.name.trim() && 'your name', !/^\S+@\S+\.\S+$/.test(f.email.trim()) && 'your email',
    f.phone.replace(/\D/g, '').length < 6 && 'a phone number', !f.project.trim() && 'the project name', !f.site.trim() && 'the site address',
    !pdfs.length && !lists.length && 'the floor plans or door schedule', f.brief.trim().length < BRIEF_MIN && 'the brief', !f.agree && 'the tick at the end',
  ].filter(Boolean)
  const send = async e => {
    e.preventDefault()
    if (missing.length || uploading) return
    setBusy(true); setErr('')
    try { onSent(await call('/send', { session, body: f })) }
    catch (x) { if (!onEnded(x)) setErr(x.message) }
    finally { setBusy(false) }
  }

  return (
    <form className="pt-form" onSubmit={send}>
      <section className="pt-intro">
        <h1>Send your plans</h1>
        <p>For {me.firm}. Fill in each part below and press Send at the end. We will have the door schedule back to you within {me.turnaround_hours} hours.</p>
      </section>

      <section className="pt-card">
        <h2><span className="pt-step">1</span> Your details</h2>
        <div className="pt-grid">
          <Field label="Company" value={f.company} onChange={set('company')} autoComplete="organization" />
          <Field label="Your name" value={f.name} onChange={set('name')} autoComplete="name" />
          <Field label="Email" type="email" value={f.email} onChange={set('email')} autoComplete="email" />
          <Field label="Phone" type="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" />
        </div>
      </section>

      <section className="pt-card">
        <h2><span className="pt-step">2</span> The project</h2>
        <div className="pt-grid">
          <Field label="Project name" value={f.project} onChange={set('project')} />
          <Field label="Site address" value={f.site} onChange={set('site')} />
        </div>
      </section>

      <section className="pt-card">
        <h2><span className="pt-step">3</span> Floor plans and door schedule</h2>
        <p className="pt-help">Every floor, as PDFs exported from CAD, with every door labelled. If you have the door schedule as Excel (.xlsx) or .csv, add it too: it is the quickest way for us, and on its own it is enough. Scans and pictures of plans cannot be read.</p>
        <input ref={pick} type="file" multiple accept=".pdf,.xlsx,.xlsm,.csv" style={{ display: 'none' }} onChange={e => { add(e.target.files); e.target.value = '' }} />
        <div className={`pt-drop${drag ? ' over' : ''}`} onClick={() => pick.current.click()}
             onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
             onDrop={e => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files) }}>
          <IconUpload size={26} />
          <strong>Drop the files here, or click to choose them</strong>
          <span>Plans as PDF, door schedule as .xlsx or .csv, up to {me.limits.file_mb} MB each</span>
        </div>
        {(me.files.length > 0 || queue.length > 0) && (
          <ul className="pt-files">
            {me.files.map(x => (
              <li key={x.id} className={x.note ? 'warn' : 'ok'}>
                <IconFile size={18} />
                <div className="pt-file-main">
                  <span className="pt-file-name">{x.name}</span>
                  <span className="pt-file-meta">
                    {fmtSize(x.size)} · {x.kind === 'pdf' ? `${x.pages} sheet${x.pages !== 1 ? 's' : ''}` : x.doors ? `door schedule, ${x.doors} door${x.doors !== 1 ? 's' : ''}` : 'spreadsheet'}
                    {!x.note && (x.kind === 'pdf' || x.doors > 0) && <span className="pt-good"> · <IconCheck size={13} /> can be read</span>}
                  </span>
                  {x.note && <span className="pt-file-note"><IconWarn size={13} /> {x.note}</span>}
                </div>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(x)} aria-label={`Remove ${x.name}`}><IconTrash size={15} /></button>
              </li>
            ))}
            {queue.map(x => (
              <li key={x.key} className={x.err ? 'bad' : 'up'}>
                <IconFile size={18} />
                <div className="pt-file-main">
                  <span className="pt-file-name">{x.name}</span>
                  {x.err ? <span className="pt-file-note"><IconWarn size={13} /> {x.err}</span>
                    : <span className="pt-bar"><span style={{ width: `${x.pct}%` }} /></span>}
                  {!x.err && <span className="pt-file-meta">{x.pct > 0 && x.pct < 99 ? `Sending, ${x.pct}%` : x.pct >= 99 ? 'Checking the file...' : 'Waiting to send'}</span>}
                </div>
                {x.err && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setQueue(q => q.filter(y => y.key !== x.key))}>Dismiss</button>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pt-card">
        <h2><span className="pt-step">4</span> Brief</h2>
        <p className="pt-help">A few lines on the project: what kind of building, how many floors or units, and anything we should know about the doors (fire doors, access control, phases, what is out of scope).</p>
        <textarea className="form-control pt-brief" rows={6} value={f.brief} onChange={set('brief')} maxLength={8000} aria-label="Brief" />
        <div className={`pt-count${f.brief.trim().length >= BRIEF_MIN ? ' ok' : ''}`}>
          {f.brief.trim().length >= BRIEF_MIN ? 'Thank you' : `At least ${BRIEF_MIN - f.brief.trim().length} more characters`}
        </div>
      </section>

      <section className="pt-card pt-send">
        <label className="pt-agree">
          <input type="checkbox" checked={f.agree} onChange={set('agree')} />
          <span>These are floor plans exported from CAD with every door labelled, or a door schedule listing every door. I understand the {me.turnaround_hours} hour turnaround depends on this.</span>
        </label>
        {err && <p className="pt-err"><IconWarn size={14} /> {err}</p>}
        <div className="pt-send-row">
          <span className="pt-missing">
            {uploading ? 'Waiting for the files to finish sending.' : missing.length ? `Still needed: ${missing.join(', ')}.` : 'Ready to send.'}
          </span>
          <button className="btn btn-primary btn-lg" type="submit" disabled={busy || uploading || missing.length > 0}>
            {busy ? <span className="spinner" /> : 'Send to MF Services'}
          </button>
        </div>
      </section>
    </form>
  )
}

function Field({ label, ...rest }) {
  return (
    <label className="pt-field">
      <span className="pt-label">{label}</span>
      <input className="form-control" {...rest} required />
    </label>
  )
}
