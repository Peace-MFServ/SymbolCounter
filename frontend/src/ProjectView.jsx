import React, { useState, useEffect, useRef } from 'react'
import { apiFetch, downloadBlob } from './api'
import { showToast } from './toast'
import { Topbar } from './Dashboard'
import { SymbolManagerModal } from './SymbolManager'

export function ProjectView({ id, onNavigate }) {
  const [project,    setProject]   = useState(null)
  const [drawings,   setDrawings]  = useState([])
  const [symTypes,   setSymTypes]  = useState([])
  const [loading,    setLoading]   = useState(true)
  const [uploading,  setUploading] = useState(false)
  const [showSymMgr, setShowSymMgr]= useState(false)
  const [showRevDiff, setShowRevDiff] = useState(false)
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
    } finally {
      setLoading(false)
    }
  }

  // Smart polling: only poll while drawings are processing
  const startPoll = () => {
    if (pollRef.current) return
    pollRef.current = setInterval(async () => {
      const cnt = await apiFetch(`/projects/${id}/drawings/processing-count`).catch(() => ({ processing: 0 }))
      if (cnt && cnt.processing === 0) {
        clearInterval(pollRef.current); pollRef.current = null
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
    setUploading(true)
    for (const file of files) {
      try {
        const form = new FormData()
        form.append('file', file)
        const d = await apiFetch(`/projects/${id}/drawings`, { method: 'POST', body: form })
        if (d) {
          setDrawings(ds => [d, ...ds])
          showToast(`Uploaded: ${file.name}`, 'success')
          startPoll()
        }
      } catch (err) { showToast(`Failed: ${file.name} — ${err.message}`, 'error') }
    }
    setUploading(false)
  }

  const deleteDrawing = async (e, did) => {
    e.stopPropagation()
    if (!confirm('Delete this drawing?')) return
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

  const exportExcel = async () => {
    try {
      await downloadBlob(`/projects/${id}/export/excel`,
        `${project?.name || 'project'}_Symbol_Count.xlsx`)
      showToast('Excel exported', 'success')
    } catch (err) { showToast('Export error: ' + err.message, 'error') }
  }

  const exportJSON = async () => {
    try {
      await downloadBlob(`/projects/${id}/export/json`,
        `${project?.name || 'project'}_export.json`)
      showToast('JSON exported', 'success')
    } catch (err) { showToast('Export error: ' + err.message, 'error') }
  }

  const exportProjectPDF = async () => {
    try {
      showToast('Building PDF…', 'info')
      await downloadBlob(`/projects/${id}/export/pdf`,
        `${project?.name || 'project'}_all_drawings.pdf`)
      showToast('PDF downloaded', 'success')
    } catch (err) { showToast('PDF error: ' + err.message, 'error') }
  }

  const exportDrawingPDF = async (e, did, name) => {
    e.stopPropagation()
    try {
      showToast('Building PDF…', 'info')
      await downloadBlob(`/drawings/${did}/export/pdf`, `${name || 'drawing'}_annotated.pdf`)
      showToast('PDF downloaded', 'success')
    } catch (err) { showToast('PDF error: ' + err.message, 'error') }
  }

  const statusBadge = s => {
    const map = {
      uploaded:   ['badge-grey',   'Uploaded'],
      processing: ['badge-orange', 'Processing…'],
      detected:   ['badge-blue',   'Detected'],
      verified:   ['badge-green',  'Verified'],
      approved:   ['badge-green',  'Approved'],
      error:      ['badge-red',    'Error'],
    }
    const [cls, label] = map[s] || ['badge-grey', s]
    return <span className={`badge ${cls}`}>{label}</span>
  }

  const progressBar = d => {
    if (!d.total_pages_count || d.total_pages_count === 0) return null
    const pct = Math.round((d.verified_pages / d.total_pages_count) * 100)
    return (
      <div style={{ width: 60, height: 4, background: 'var(--bg3)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? 'var(--ok)' : 'var(--link)',
                      transition: 'width .3s' }} />
      </div>
    )
  }

  if (loading) return (
    <>
      <Topbar onBack={() => onNavigate('dashboard')} onNavigate={onNavigate} />
      <div style={{ textAlign: 'center', padding: 80 }}><span className="spinner spinner-lg" /></div>
    </>
  )

  const verifiedCount = drawings.filter(d => ['verified','approved'].includes(d.status)).length
  const approvedCount = drawings.filter(d => d.status === 'approved').length

  return (
    <>
      <Topbar onBack={() => onNavigate('dashboard')} title={project?.name} onNavigate={onNavigate} />
      <div className="page-wrap">
        <div className="page-header">
          <div>
            <h1>{project?.name}</h1>
            <p style={{ color: 'var(--text3)', fontSize: 13, marginTop: 4 }}>
              {project?.client}{project?.client && project?.site ? ' · ' : ''}{project?.site}
              {project?.drawing_firm && ` · ${project.drawing_firm}`}
            </p>
          </div>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={() => setShowSymMgr(true)}>⚙ Symbols</button>
          {drawings.length > 1 && (
            <button className="btn btn-ghost" onClick={() => setShowRevDiff(true)}>⇄ Compare Revisions</button>
          )}
          {drawings.length > 0 && (
            <>
              <button className="btn btn-ghost" onClick={exportExcel}>⬇ Excel</button>
              <button className="btn btn-ghost" onClick={exportJSON}>⬇ JSON</button>
              <button className="btn btn-ghost" onClick={exportProjectPDF}>⬇ PDF (all)</button>
            </>
          )}
          <button className="btn btn-primary" onClick={() => fileRef.current.click()} disabled={uploading}>
            {uploading ? <><span className="spinner" /> Uploading…</> : '+ Upload PDFs'}
          </button>
          <input ref={fileRef} type="file" accept=".pdf" multiple style={{ display: 'none' }}
                 onChange={e => { upload(Array.from(e.target.files)); e.target.value = '' }} />
        </div>

        {/* Project progress bar */}
        {drawings.length > 0 && (
          <div style={{ display: 'flex', gap: 20, marginBottom: 20, padding: '12px 16px',
                        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
            <Stat label="Total" value={drawings.length} />
            <Stat label="Detected" value={drawings.filter(d => ['detected','verified','approved'].includes(d.status)).length} color="var(--link)" />
            <Stat label="Verified" value={verifiedCount} color="var(--ok)" />
            <Stat label="Approved" value={approvedCount} color="var(--ok)" />
          </div>
        )}

        {/* Drop zone */}
        <div style={{ border: '2px dashed var(--border)', borderRadius: 10, padding: '20px',
                      textAlign: 'center', marginBottom: 20, color: 'var(--text3)',
                      cursor: 'pointer' }}
             onClick={() => fileRef.current.click()}
             onDragOver={e => e.preventDefault()}
             onDrop={e => { e.preventDefault(); upload(Array.from(e.dataTransfer.files)) }}>
          <div style={{ fontSize: 24, marginBottom: 4 }}>📐</div>
          <p style={{ fontSize: 13 }}>Drop PDF floor plans here, or click to browse</p>
        </div>

        {drawings.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>
            No drawings uploaded yet.
          </div>
        ) : (
          drawings.map(d => (
            <div key={d.id} className="drawing-row" style={{ cursor: 'pointer' }}
                 onClick={() => onNavigate('verify', { drawingId: d.id, projectId: id })}>
              <div className="name">
                <strong>
                  {d.block ? `[${d.block}] ` : ''}{d.level || d.original_name}
                  {d.revision && (
                    <span style={{ marginLeft: 6, fontSize: 11, background: 'var(--bg3)',
                                   padding: '1px 6px', borderRadius: 4, color: 'var(--text3)', fontWeight: 400 }}>
                      Rev {d.revision}
                    </span>
                  )}
                </strong>
                <span>
                  {d.original_name} · {d.total_pages} page{d.total_pages !== 1 ? 's' : ''}
                  {d.total_pages_count > 0 && ` · ${d.verified_pages}/${d.total_pages_count} verified`}
                </span>
              </div>
              {progressBar(d)}
              {/* Dynamic count pills for all symbol types */}
              <div className="counts-pills">
                {symTypes.map(st => {
                  const v = (d.total_counts || {})[st.code] || 0
                  if (v === 0) return null
                  return (
                    <span key={st.id} className="pill"
                          style={{ background: st.color + '22', color: st.color }}>
                      {st.code}: {v}
                    </span>
                  )
                })}
              </div>
              {statusBadge(d.status)}
              {d.status === 'error' && d.error_message && (
                <span style={{ fontSize: 11, color: 'var(--red)' }} title={d.error_message}>
                  {d.error_message.length > 60 ? d.error_message.slice(0, 60) + '…' : d.error_message}
                </span>
              )}
              {d.status === 'verified' && (
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--ok)', fontSize: 11 }}
                        onClick={e => approveDrawing(e, d.id)}>
                  Approve
                </button>
              )}
              <button className="btn btn-ghost btn-sm" title="Download annotated PDF"
                      onClick={e => exportDrawingPDF(e, d.id, d.level || d.original_name)}>
                ⬇ PDF
              </button>
              <button className="btn btn-ghost btn-sm"
                      onClick={e => { e.stopPropagation(); onNavigate('verify', { drawingId: d.id, projectId: id }) }}>
                Review →
              </button>
              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }}
                      onClick={e => deleteDrawing(e, d.id)}>×</button>
            </div>
          ))
        )}

        {/* Symbol count summary table */}
        {drawings.length > 0 && symTypes.length > 0 && (
          <CountTable drawings={drawings} symTypes={symTypes} onNavigate={onNavigate} id={id} />
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

function Stat({ label, value, color }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <span style={{ fontSize: 18, fontWeight: 700, color: color || 'var(--text)' }}>{value}</span>
      <span style={{ fontSize: 11, color: 'var(--text3)' }}>{label}</span>
    </div>
  )
}

function CountTable({ drawings, symTypes, onNavigate, id }) {
  const TH  = { padding: '10px 14px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                letterSpacing: '.5px', color: 'var(--text3)', borderBottom: '1px solid var(--border)',
                background: 'var(--bg2)', textAlign: 'left', whiteSpace: 'nowrap' }
  const TDc = { padding: '10px 14px', borderBottom: '1px solid #1e2230', textAlign: 'center', fontSize: 13 }
  const TDl = { padding: '10px 14px', borderBottom: '1px solid #1e2230', fontSize: 13 }
  const TFT = { padding: '10px 14px', background: 'var(--bg2)', fontWeight: 700,
                borderTop: '2px solid var(--border)', textAlign: 'center', fontSize: 13 }

  const sColor = s => {
    if (s === 'approved')  return 'var(--ok)'
    if (s === 'verified')  return 'var(--ok)'
    if (s === 'detected')  return 'var(--link)'
    if (s === 'processing')return 'var(--accent)'
    if (s === 'error')     return 'var(--red)'
    return '#8892a8'
  }
  const sLabel = s => {
    if (s === 'approved')   return 'Approved'
    if (s === 'verified')   return 'Verified'
    if (s === 'detected')   return 'Detected'
    if (s === 'processing') return 'Processing'
    if (s === 'error')      return 'Error'
    return 'Uploaded'
  }

  const totals = {}
  symTypes.forEach(st => { totals[st.code] = 0 })
  drawings.forEach(d => {
    const c = d.total_counts || {}
    symTypes.forEach(st => { totals[st.code] = (totals[st.code] || 0) + (c[st.code] || 0) })
  })

  return (
    <div className="count-table-wrap">
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.6px',
                    color: 'var(--text2)', marginBottom: 12 }}>
        Symbol Count Summary
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 500 }}>
          <thead>
            <tr>
              <th style={{ ...TH, width: '30%' }}>Drawing</th>
              <th style={{ ...TH, width: '10%' }}>Block</th>
              <th style={{ ...TH, width: '8%' }}>Rev</th>
              <th style={{ ...TH, width: '12%' }}>Status</th>
              {symTypes.map(st => (
                <th key={st.id} style={{ ...TH, textAlign: 'center', color: st.color }}>{st.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {drawings.map(d => {
              const c = d.total_counts || {}
              return (
                <tr key={d.id}
                    onClick={() => onNavigate('verify', { drawingId: d.id, projectId: id })}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#1e2230'}
                    onMouseLeave={e => e.currentTarget.style.background = ''}>
                  <td style={TDl}>
                    <div style={{ fontWeight: 500 }}>{d.level || d.original_name}</div>
                    {d.level && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{d.original_name}</div>}
                  </td>
                  <td style={{ ...TDl, color: 'var(--text3)', fontSize: 12 }}>{d.block || '—'}</td>
                  <td style={{ ...TDl, color: 'var(--text3)', fontSize: 12 }}>{d.revision || '—'}</td>
                  <td style={TDl}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                                   background: sColor(d.status), marginRight: 6, verticalAlign: 'middle' }} />
                    <span style={{ fontSize: 12, color: 'var(--text2)' }}>{sLabel(d.status)}</span>
                    {d.status === 'error' && d.error_message && (
                      <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 2,
                                    maxWidth: 240, whiteSpace: 'normal' }}>{d.error_message}</div>
                    )}
                  </td>
                  {symTypes.map(st => {
                    const v = c[st.code] || 0
                    return (
                      <td key={st.id} style={TDc}>
                        <span style={{ color: v > 0 ? st.color : 'var(--text3)', fontWeight: v > 0 ? 700 : 400 }}>
                          {v}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} style={{ ...TFT, textAlign: 'left', color: 'var(--text2)', fontSize: 12 }}>
                TOTAL — {drawings.length} drawing{drawings.length !== 1 ? 's' : ''}
              </td>
              {symTypes.map(st => (
                <td key={st.id} style={TFT}>
                  <span style={{ color: st.color }}>{totals[st.code] || 0}</span>
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
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
