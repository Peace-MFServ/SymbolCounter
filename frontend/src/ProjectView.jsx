import React, { useState, useEffect, useRef } from 'react'
import { apiFetch, downloadBlob } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'
import { SymbolManagerModal } from './SymbolManager'

const STATUS = {
  uploaded:   ['badge-grey',   'Uploaded'],
  processing: ['badge-orange', 'Detecting…'],
  detected:   ['badge-blue',   'Detected'],
  verified:   ['badge-green',  'Verified'],
  approved:   ['badge-green',  'Approved'],
  error:      ['badge-red',    'Failed'],
}

const drawingName = d => (d.block ? `[${d.block}] ` : '') + (d.level || d.original_name)
const deviceTotal = d => Object.values(d.total_counts || {}).reduce((a, b) => a + b, 0)

export function ProjectView({ id, onNavigate }) {
  const [project,    setProject]   = useState(null)
  const [drawings,   setDrawings]  = useState([])
  const [symTypes,   setSymTypes]  = useState([])
  const [loading,    setLoading]   = useState(true)
  const [uploading,  setUploading] = useState(false)
  const [showSymMgr, setShowSymMgr]= useState(false)
  const [showRevDiff, setShowRevDiff] = useState(false)
  const [dragOver,   setDragOver]  = useState(false)
  const [doorInfo,   setDoorInfo]  = useState(null)   // {doors, types, decide}
  const fileRef = useRef()
  const pollRef = useRef()

  const load = async () => {
    try {
      const [proj, dwgs, syms] = await Promise.all([
        apiFetch(`/projects/${id}`),
        apiFetch(`/projects/${id}/drawings`),
        apiFetch(`/projects/${id}/symbol-types`),
      ])
      setProject(proj)
      setDrawings(dwgs || [])
      setSymTypes(syms || [])
      apiFetch(`/projects/${id}/doors/count`).then(c => { if (c) setDoorInfo(c) }).catch(() => {})
    } finally {
      setLoading(false)
    }
  }

  // Poll only while drawings are processing; legend-derived symbol types
  // appear during detection, so refresh those too.
  const startPoll = () => {
    if (pollRef.current) return
    pollRef.current = setInterval(async () => {
      const cnt = await apiFetch(`/projects/${id}/drawings/processing-count`).catch(() => ({ processing: 0 }))
      if (cnt && cnt.processing === 0) {
        clearInterval(pollRef.current); pollRef.current = null
        apiFetch(`/projects/${id}/symbol-types`).then(t => { if (t) setSymTypes(t) })
        apiFetch(`/projects/${id}/doors/count`).then(c => { if (c) setDoorInfo(c) }).catch(() => {})
      }
      apiFetch(`/projects/${id}/drawings`).then(dwgs => { if (dwgs) setDrawings(dwgs) })
    }, 3000)
  }

  useEffect(() => {
    load()
    startPoll()
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [id])

  const upload = async files => {
    const pdfs = Array.from(files).filter(f => /\.pdf$/i.test(f.name))
    if (pdfs.length === 0) { showToast('Only PDF drawings can be uploaded', 'error'); return }
    setUploading(true)
    for (const file of pdfs) {
      try {
        const form = new FormData()
        form.append('file', file)
        const d = await apiFetch(`/projects/${id}/drawings`, { method: 'POST', body: form })
        if (d) {
          setDrawings(ds => [d, ...ds])
          showToast(`Uploaded ${file.name} — detecting`, 'success')
          startPoll()
        }
      } catch (err) { showToast(`Failed: ${file.name} — ${err.message}`, 'error') }
    }
    setUploading(false)
  }

  const deleteDrawing = async (e, did) => {
    e.stopPropagation()
    if (!confirm('Delete this drawing and its counts?')) return
    await apiFetch(`/drawings/${did}`, { method: 'DELETE' })
    setDrawings(ds => ds.filter(d => d.id !== did))
  }

  const approveDrawing = async (e, did) => {
    e.stopPropagation()
    try {
      await apiFetch(`/drawings/${did}/approve`, { method: 'POST' })
      setDrawings(ds => ds.map(d => d.id === did ? { ...d, status: 'approved' } : d))
      showToast('Drawing approved', 'success')
    } catch (err) { showToast(err.message, 'error') }
  }

  const exportAs = async kind => {
    const name = project?.name || 'project'
    const jobs = {
      excel: [`/projects/${id}/export/excel`, `${name}_Symbol_Count.xlsx`, 'Excel workbook downloaded'],
      json:  [`/projects/${id}/export/json`,  `${name}_export.json`,       'JSON downloaded'],
      pdf:   [`/projects/${id}/export/pdf`,   `${name}_all_drawings.pdf`,  'Annotated PDF downloaded'],
    }
    const [url, file, msg] = jobs[kind]
    try {
      if (kind === 'pdf') showToast('Building PDF…', 'info')
      await downloadBlob(url, file)
      showToast(msg, 'success')
    } catch (err) { showToast('Export failed: ' + err.message, 'error') }
  }

  const downloadDrawing = async (d, kind) => {
    const base = (d.level || d.original_name || 'drawing').replace(/\.pdf$/i, '')
    const jobs = {
      pdf:      [`/drawings/${d.id}/export/pdf`,   `${base}_annotated.pdf`,   'Annotated PDF downloaded', 'Building PDF…'],
      excel:    [`/drawings/${d.id}/export/excel`, `${base}_Symbol_Count.xlsx`, 'Excel downloaded', null],
      original: [`/drawings/${d.id}/file`,         d.original_name || `${base}.pdf`, 'Original PDF downloaded', null],
    }
    const [url, file, msg, pre] = jobs[kind]
    try {
      if (pre) showToast(pre, 'info')
      await downloadBlob(url, file)
      showToast(msg, 'success')
    } catch (err) { showToast('Download failed: ' + err.message, 'error') }
  }

  const openDrawing = d => onNavigate('verify', { drawingId: d.id, projectId: id })

  const crumbs = [
    { label: 'Projects', onClick: () => onNavigate('dashboard') },
    { label: project?.name || '…' },
  ]

  if (loading) return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} />
      <div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div>
    </>
  )

  const detectedCount = drawings.filter(d => ['detected', 'verified', 'approved'].includes(d.status)).length
  const verifiedCount = drawings.filter(d => ['verified', 'approved'].includes(d.status)).length
  const approvedCount = drawings.filter(d => d.status === 'approved').length
  const processing    = drawings.filter(d => ['uploaded', 'processing'].includes(d.status)).length
  const totalDevices  = drawings.reduce((s, d) => s + deviceTotal(d), 0)

  const dropProps = {
    onDragOver:  e => { e.preventDefault(); setDragOver(true) },
    onDragLeave: () => setDragOver(false),
    onDrop:      e => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files) },
  }

  return (
    <>
      <Topbar crumbs={crumbs} onNavigate={onNavigate} />
      <div className="page-wrap" {...dropProps}>
        <div className="page-header">
          <div>
            <h1>{project?.name}</h1>
            <p className="lede">
              {[project?.client, project?.site, project?.drawing_firm].filter(Boolean).join(' · ') || 'No client or site set'}
            </p>
          </div>
          <div className="spacer" />
          <div className="actions">
            <button className="btn" onClick={() => onNavigate('doors', { id })}>Doors{doorInfo?.doors ? ` ${doorInfo.doors}` : ''}</button>
            <button className="btn" onClick={() => setShowSymMgr(true)}>Symbol types</button>
            {drawings.length > 1 && (
              <button className="btn" onClick={() => setShowRevDiff(true)}>Compare revisions</button>
            )}
            {drawings.length > 0 && (
              <Menu label="Export" items={[
                { label: 'Excel workbook',           onClick: () => exportAs('excel') },
                { label: 'JSON data',                onClick: () => exportAs('json') },
                { label: 'Annotated PDF, all drawings', onClick: () => exportAs('pdf') },
                { label: 'Ironmongery schedule',    onClick: () => onNavigate('schedule', { id }) },
              ]} />
            )}
            <button className="btn btn-primary" onClick={() => fileRef.current.click()} disabled={uploading}>
              {uploading ? <><span className="spinner" /> Uploading…</> : 'Upload drawings'}
            </button>
            <input ref={fileRef} type="file" accept=".pdf" multiple style={{ display: 'none' }}
                   onChange={e => { upload(e.target.files); e.target.value = '' }} />
          </div>
        </div>

        {drawings.length === 0 ? (
          <div className={`empty-state drop-zone${dragOver ? ' over' : ''}`}
               onClick={() => fileRef.current.click()}>
            <h2>No drawings yet.</h2>
            <p>
              Drop PDF floor plans here or use Upload drawings. Every device listed in a
              sheet's legend is counted automatically, usually within a few seconds.
            </p>
            <button className="btn btn-primary" onClick={e => { e.stopPropagation(); fileRef.current.click() }}>
              Upload drawings
            </button>
          </div>
        ) : (
          <>
            <div className="pv-stats">
              <div className="pv-stat"><div className="num">{drawings.length}</div><div className="lbl">Drawings</div></div>
              <div className="pv-stat"><div className="num">{totalDevices}</div><div className="lbl">Devices found</div></div>
              <div className="pv-stat"><div className="num">{verifiedCount}<span className="of">/{drawings.length}</span></div><div className="lbl">Verified</div></div>
              <div className="pv-stat"><div className="num">{approvedCount}<span className="of">/{drawings.length}</span></div><div className="lbl">Approved</div></div>
              {processing > 0 && (
                <div className="pv-stat working"><div className="num"><span className="spinner" /></div><div className="lbl">{processing} detecting</div></div>
              )}
              {doorInfo?.doors > 0 && (
                <div className="pv-stat link" onClick={() => onNavigate('doors', { id })} title="Open the door list">
                  <div className="num">{doorInfo.doors}</div>
                  <div className="lbl">Doors{doorInfo.decide > 0 ? ` · ${doorInfo.decide} type${doorInfo.decide !== 1 ? 's' : ''} to decide` : ''}</div>
                </div>
              )}
            </div>

            <table className="ledger dwg-table">
              <thead>
                <tr>
                  <th>Drawing</th>
                  <th>Status</th>
                  <th>Devices found</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {drawings.map(d => {
                  const [cls, label] = STATUS[d.status] || ['badge-grey', d.status]
                  const counts = symTypes
                    .map(st => [st, (d.total_counts || {})[st.code] || 0])
                    .filter(([, v]) => v > 0)
                    .sort((a, b) => b[1] - a[1])
                  const shown = counts.slice(0, 6)
                  return (
                    <tr key={d.id} onClick={() => openDrawing(d)}>
                      <td>
                        <div className="proj-name dwg-name">
                          {drawingName(d)}
                          {d.revision && <span className="rev">Rev {d.revision}</span>}
                        </div>
                        <div className="proj-meta">
                          {d.level ? `${d.original_name} · ` : ''}
                          {d.total_pages} page{d.total_pages !== 1 ? 's' : ''}
                          {d.total_pages_count > 0 && ` · ${d.verified_pages} of ${d.total_pages_count} checked`}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${cls}`}>{label}</span>
                        {d.status === 'error' && d.error_message && (
                          <div className="err-note" title={d.error_message}>{d.error_message}</div>
                        )}
                      </td>
                      <td>
                        {counts.length === 0 ? (
                          <span className="muted">{['uploaded', 'processing'].includes(d.status) ? 'Detecting…' : 'None'}</span>
                        ) : (
                          <div className="dev-cell">
                            <span className="count-num">{deviceTotal(d)}</span>
                            <span className="chips">
                              {shown.map(([st, v]) => (
                                <span key={st.id} className="chip" title={st.name}>
                                  <span className="dot" style={{ background: st.color }} />{st.code} {v}
                                </span>
                              ))}
                              {counts.length > shown.length && (
                                <span className="chip more">+{counts.length - shown.length}</span>
                              )}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="row-actions">
                        {d.status === 'verified' && (
                          <button className="btn btn-ghost btn-sm ok" onClick={e => approveDrawing(e, d.id)}>Approve</button>
                        )}
                        <button className="btn btn-sm" onClick={e => { e.stopPropagation(); openDrawing(d) }}>Review</button>
                        <Menu label="Download" small items={[
                          { label: 'Annotated PDF with counts', onClick: () => downloadDrawing(d, 'pdf') },
                          { label: 'Excel count',               onClick: () => downloadDrawing(d, 'excel') },
                          { label: 'Original PDF',              onClick: () => downloadDrawing(d, 'original') },
                        ]} />
                        <button className="btn btn-ghost btn-sm danger" onClick={e => deleteDrawing(e, d.id)}>Delete</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            <div className={`drop-strip${dragOver ? ' over' : ''}`} onClick={() => fileRef.current.click()}>
              Drop more PDF drawings anywhere on this page, or click to browse.
            </div>

            {symTypes.length > 0 && (
              <CountTable drawings={drawings} symTypes={symTypes} onOpen={openDrawing} />
            )}
          </>
        )}
      </div>

      {showSymMgr && (
        <SymbolManagerModal
          projectId={id}
          onClose={() => setShowSymMgr(false)}
          onChanged={() => apiFetch(`/projects/${id}/symbol-types`).then(t => { if (t) setSymTypes(t) })}
        />
      )}

      {showRevDiff && (
        <RevisionDiffModal drawings={drawings} onClose={() => setShowRevDiff(false)} />
      )}
    </>
  )
}

/* A small dropdown of secondary actions — one button in the header instead of five. */
export function Menu({ label, items, small = false }) {
  const [open, setOpen] = useState(false)
  const ref = useRef()
  useEffect(() => {
    if (!open) return
    const close = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const key = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key) }
  }, [open])
  return (
    <div className="menu" ref={ref} onClick={e => e.stopPropagation()}>
      <button className={`btn${small ? ' btn-sm btn-ghost' : ''}${open ? ' open' : ''}`}
              onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}>
        {label}<span className="caret" />
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map(it => (
            <button key={it.label} role="menuitem" onClick={() => { setOpen(false); it.onClick() }}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

function CountTable({ drawings, symTypes, onOpen }) {
  const [showAll, setShowAll] = useState(false)
  const totals = {}
  drawings.forEach(d => {
    const c = d.total_counts || {}
    symTypes.forEach(st => { totals[st.code] = (totals[st.code] || 0) + (c[st.code] || 0) })
  })
  const withCounts = symTypes.filter(st => totals[st.code] > 0)
  const cols = showAll ? symTypes : withCounts
  const hidden = symTypes.length - withCounts.length

  return (
    <section className="count-section">
      <div className="section-head">
        <h2>Count by drawing</h2>
        {hidden > 0 && (
          <button className="link-btn inline" onClick={() => setShowAll(v => !v)}>
            {showAll ? 'Hide types with no devices' : `Show ${hidden} types with no devices`}
          </button>
        )}
      </div>
      {cols.length === 0 ? (
        <p className="muted">No devices counted yet.</p>
      ) : (
        <div className="count-scroll">
          <table className="count-table">
            <thead>
              <tr>
                <th className="sticky">Drawing</th>
                {cols.map(st => (
                  <th key={st.id} title={st.name}>
                    <span className="dot" style={{ background: st.color }} />
                    <span className="th-name">{st.name}</span>
                  </th>
                ))}
                <th className="total-col">Total</th>
              </tr>
            </thead>
            <tbody>
              {drawings.map(d => {
                const c = d.total_counts || {}
                return (
                  <tr key={d.id} onClick={() => onOpen(d)}>
                    <td className="sticky">
                      <div className="dwg-name">{drawingName(d)}</div>
                      {d.level && <div className="proj-meta">{d.original_name}</div>}
                    </td>
                    {cols.map(st => {
                      const v = c[st.code] || 0
                      return <td key={st.id} className={v ? 'has' : 'zero'}>{v}</td>
                    })}
                    <td className="total-col">{deviceTotal(d)}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="sticky">Total, {drawings.length} drawing{drawings.length !== 1 ? 's' : ''}</td>
                {cols.map(st => <td key={st.id}>{totals[st.code] || 0}</td>)}
                <td className="total-col">{drawings.reduce((s, d) => s + deviceTotal(d), 0)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  )
}

function RevisionDiffModal({ drawings, onClose }) {
  const [drawA, setDrawA] = useState('')
  const [drawB, setDrawB] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)

  const compare = async () => {
    if (!drawA || !drawB || drawA === drawB) return
    setLoading(true)
    try {
      const r = await apiFetch(`/drawings/${drawA}/compare/${drawB}`)
      setResult(r)
    } catch (err) { showToast(err.message, 'error') }
    setLoading(false)
  }

  const allCodes = result ? Object.keys(result.count_diff) : []

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 600 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0 }}>Compare Drawing Revisions</h2>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm" onClick={onClose}>×</button>
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 6 }}>Drawing A (before)</label>
            <select className="form-control" value={drawA} onChange={e => setDrawA(e.target.value)}>
              <option value="">Select drawing…</option>
              {drawings.map(d => (
                <option key={d.id} value={d.id}>
                  {d.level || d.original_name}{d.revision ? ` (Rev ${d.revision})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 6 }}>Drawing B (after)</label>
            <select className="form-control" value={drawB} onChange={e => setDrawB(e.target.value)}>
              <option value="">Select drawing…</option>
              {drawings.map(d => (
                <option key={d.id} value={d.id}>
                  {d.level || d.original_name}{d.revision ? ` (Rev ${d.revision})` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button className="btn btn-primary" onClick={compare}
                disabled={!drawA || !drawB || drawA === drawB || loading}>
          {loading ? <span className="spinner" /> : 'Compare'}
        </button>

        {result && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 13, color: result.changed ? '#fb923c' : 'var(--ok)', marginBottom: 12, fontWeight: 600 }}>
              {result.changed
                ? `Changes detected: ${result.summary}`
                : 'No changes between these drawings'}
            </div>
            {allCodes.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    {['Symbol', 'Before', 'After', 'Change'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', background: 'var(--bg3)', fontSize: 11,
                                           fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.5px',
                                           color: 'var(--text3)', textAlign: 'center', borderBottom: '1px solid var(--border)' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {allCodes.map(code => {
                    const { before, after, delta } = result.count_diff[code]
                    return (
                      <tr key={code}>
                        <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontWeight: 600 }}>{code}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'center', color: 'var(--text2)' }}>{before}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'center', color: 'var(--text2)' }}>{after}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 700,
                                     color: delta > 0 ? 'var(--ok)' : delta < 0 ? 'var(--red)' : 'var(--text3)' }}>
                          {delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {result.spatial_added?.length > 0 && (
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--ok)' }}>
                {result.spatial_added.length} symbol{result.spatial_added.length !== 1 ? 's' : ''} added
              </div>
            )}
            {result.spatial_removed?.length > 0 && (
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--red)' }}>
                {result.spatial_removed.length} symbol{result.spatial_removed.length !== 1 ? 's' : ''} removed
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
