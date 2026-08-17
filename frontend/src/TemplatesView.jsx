import React, { useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch } from './api'
import { Topbar } from './Dashboard'
import { showToast } from './toast'

// ── Fetch a template image with auth and return an object URL ─────────────────
function useAuthImage(imageUrl) {
  const [objectUrl, setObjectUrl] = useState(null)
  const urlRef = useRef(null)

  useEffect(() => {
    if (!imageUrl) return
    let cancelled = false
    const token = localStorage.getItem('token')
    // imageUrl already includes /api prefix (e.g. /api/files/templates/xxx.png)
    fetch(imageUrl, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.ok ? r.blob() : Promise.reject('bad'))
      .then(blob => {
        if (cancelled) return
        const url = URL.createObjectURL(blob)
        setObjectUrl(url)
        if (urlRef.current) URL.revokeObjectURL(urlRef.current)
        urlRef.current = url
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null }
    }
  }, [imageUrl])

  return objectUrl
}

// ── Lightbox overlay ──────────────────────────────────────────────────────────
function Lightbox({ imageUrl, label, onClose }) {
  const objectUrl = useAuthImage(imageUrl)

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.82)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 16, cursor: 'zoom-out',
      }}
    >
      {objectUrl
        ? <img
            src={objectUrl}
            alt={label}
            onClick={e => e.stopPropagation()}
            style={{
              maxWidth: '80vw', maxHeight: '75vh',
              objectFit: 'contain',
              imageRendering: 'pixelated',
              border: '2px solid var(--border)',
              borderRadius: 8,
              boxShadow: '0 8px 40px rgba(0,0,0,.6)',
              background: 'var(--bg2)',
              cursor: 'default',
            }}
          />
        : <span className="spinner spinner-lg" />
      }
      <div style={{ color: '#fff', fontSize: 13, opacity: 0.7 }}>
        {label} · click or press Esc to close
      </div>
    </div>
  )
}

// ── Authenticated thumbnail ───────────────────────────────────────────────────
function AuthThumb({ imageUrl, alt, onClick }) {
  const objectUrl = useAuthImage(imageUrl)

  if (!objectUrl) {
    return (
      <div
        style={{
          width: 96, height: 96,
          background: 'var(--bg3)',
          borderRadius: 6,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text3)', fontSize: 11,
        }}
      >
        <span className="spinner" />
      </div>
    )
  }

  return (
    <img
      src={objectUrl}
      alt={alt}
      onClick={onClick}
      title="Click to enlarge"
      style={{
        width: 96, height: 96, objectFit: 'contain',
        background: 'var(--bg3)',
        borderRadius: 6,
        imageRendering: 'pixelated',
        cursor: 'zoom-in',
        border: '1px solid var(--border)',
        transition: 'border-color .15s',
      }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--blue)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
    />
  )
}

// ── Single template card ──────────────────────────────────────────────────────
function TemplateCard({ tmpl, onDelete, onEnlarge }) {
  const [confirming, setConfirming] = useState(false)
  const [deleting,   setDeleting]   = useState(false)

  const handleDelete = async () => {
    if (!confirming) { setConfirming(true); return }
    setDeleting(true)
    try {
      await apiFetch(`/templates/${tmpl.id}`, { method: 'DELETE' })
      onDelete(tmpl.id)
      showToast('Template deleted', 'info')
    } catch (e) {
      showToast(e.message || 'Delete failed', 'error')
      setDeleting(false)
      setConfirming(false)
    }
  }

  const total      = (tmpl.confirm_count || 0) + (tmpl.reject_count || 0)
  const qualityPct = Math.round((tmpl.quality_score || 0) * 100)
  const qualityColor = (tmpl.quality_score || 0) >= 0.7 ? '#22c55e'
                     : (tmpl.quality_score || 0) >= 0.4 ? '#f59e0b'
                     : total === 0 ? 'var(--text3)' : '#ef4444'

  return (
    <div style={{
      background: 'var(--bg2)',
      border: '1px solid var(--border)',
      borderRadius: 10, padding: 12,
      display: 'flex', flexDirection: 'column', gap: 8,
      width: 140, flexShrink: 0,
    }}>
      <AuthThumb
        imageUrl={tmpl.image_url}
        alt={tmpl.symbol_code}
        onClick={() => onEnlarge(tmpl)}
      />

      {/* Stats */}
      <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
        {total > 0 ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#22c55e' }}>✓ {tmpl.confirm_count}</span>
              <span style={{ color: tmpl.reject_count > 0 ? '#ef4444' : 'var(--text3)' }}>
                ✗ {tmpl.reject_count}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3 }}>
              <div style={{
                flex: 1, height: 4, background: 'var(--bg4)',
                borderRadius: 2, overflow: 'hidden',
              }}>
                <div style={{
                  width: `${qualityPct}%`, height: '100%',
                  background: qualityColor, borderRadius: 2,
                }} />
              </div>
              <span style={{ color: qualityColor, fontWeight: 600, minWidth: 30, textAlign: 'right' }}>
                {qualityPct}%
              </span>
            </div>
          </>
        ) : (
          <div style={{ fontStyle: 'italic' }}>Not yet used</div>
        )}

        {tmpl.drawing_firm && (
          <div
            style={{
              marginTop: 3, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: 'var(--text3)',
            }}
            title={tmpl.drawing_firm}
          >
            {tmpl.drawing_firm}
          </div>
        )}
        <div style={{ marginTop: 2, color: 'var(--text3)' }}>
          Threshold: {tmpl.effective_threshold}
        </div>
      </div>

      {/* Delete */}
      <button
        className={`btn btn-sm ${confirming ? 'btn-danger' : 'btn-ghost'}`}
        style={{ marginTop: 'auto', fontSize: 11, width: '100%' }}
        onClick={handleDelete}
        disabled={deleting}
      >
        {deleting ? '…' : confirming ? 'Confirm?' : 'Delete'}
      </button>
      {confirming && !deleting && (
        <button
          className="btn btn-ghost btn-sm"
          style={{ fontSize: 11, width: '100%', marginTop: -4 }}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </button>
      )}
    </div>
  )
}

// ── Symbol group ──────────────────────────────────────────────────────────────
function SymbolGroup({ code, name, color, templates, onDeleteTemplate, onEnlarge }) {
  const [open, setOpen] = useState(true)

  return (
    <div style={{
      background: 'var(--bg2)',
      border: '1px solid var(--border)',
      borderRadius: 10, overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px', background: 'none', border: 'none',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{
          width: 10, height: 10, borderRadius: '50%',
          background: color || 'var(--text3)', flexShrink: 0,
        }} />
        <span style={{ fontWeight: 600, color: 'var(--text)', fontSize: 14 }}>
          {name || code}
        </span>
        <span style={{
          background: 'var(--bg3)', color: 'var(--text3)',
          borderRadius: 99, padding: '1px 8px', fontSize: 12,
        }}>
          {templates.length} template{templates.length !== 1 ? 's' : ''}
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--text3)', fontSize: 11 }}>
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div style={{
          padding: '0 16px 16px',
          display: 'flex', flexWrap: 'wrap', gap: 12,
        }}>
          {templates.length === 0 ? (
            <p style={{ fontSize: 13, fontStyle: 'italic' }}>
              No templates yet — use the snip tool when reviewing a drawing.
            </p>
          ) : (
            templates.map(t => (
              <TemplateCard
                key={t.id}
                tmpl={t}
                onDelete={onDeleteTemplate}
                onEnlarge={onEnlarge}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────
export function TemplatesView({ onNavigate }) {
  const [templates, setTemplates] = useState([])
  const [symTypes,  setSymTypes]  = useState([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState(null)
  const [lightbox,  setLightbox]  = useState(null) // { image_url, symbol_code }

  useEffect(() => {
    Promise.all([
      apiFetch('/templates/all'),
      apiFetch('/projects')
        .then(ps => ps?.length > 0 ? apiFetch(`/projects/${ps[0].id}/symbol-types`) : [])
        .catch(() => []),
    ])
      .then(([tmpls, types]) => {
        setTemplates(tmpls || [])
        setSymTypes(types || [])
        setLoading(false)
      })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [])

  const handleDelete = useCallback(id => {
    setTemplates(prev => prev.filter(t => t.id !== id))
  }, [])

  const handleEnlarge = useCallback(tmpl => {
    setLightbox(tmpl)
  }, [])

  // Group by symbol_code
  const grouped = templates.reduce((acc, t) => {
    if (!acc[t.symbol_code]) acc[t.symbol_code] = []
    acc[t.symbol_code].push(t)
    return acc
  }, {})

  const knownCodes = symTypes.map(st => st.code)
  const extraCodes = Object.keys(grouped).filter(c => !knownCodes.includes(c)).sort()
  const allCodes   = [...knownCodes, ...extraCodes]

  const colorFor = code => symTypes.find(s => s.code === code)?.color || 'var(--text3)'
  const nameFor  = code => symTypes.find(s => s.code === code)?.name  || code

  return (
    <>
      <Topbar
        title="Template Library"
        onBack={() => onNavigate('dashboard')}
        onNavigate={onNavigate}
      />

      <div className="page-wrap">
        <div className="page-header">
          <div>
            <h1>Template Library</h1>
            <p style={{ marginTop: 4 }}>
              Review and manage symbol templates used for detection.
              Templates are auto-created when you verify drawings, or manually snipped in the review view.
            </p>
          </div>
          <div className="spacer" />
          <div style={{ color: 'var(--text3)', fontSize: 13, alignSelf: 'flex-end' }}>
            {templates.length} total template{templates.length !== 1 ? 's' : ''}
          </div>
        </div>

        {loading && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text3)', padding: 40 }}>
            <span className="spinner" /> Loading templates…
          </div>
        )}

        {error && (
          <div style={{
            padding: '12px 16px', background: 'var(--bg3)',
            border: '1px solid var(--red)', borderRadius: 8,
            color: 'var(--red)', fontSize: 13,
          }}>
            {error}
          </div>
        )}

        {!loading && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {allCodes
              .filter(code => (grouped[code]?.length > 0) || symTypes.find(s => s.code === code))
              .map(code => (
                <SymbolGroup
                  key={code}
                  code={code}
                  name={nameFor(code)}
                  color={colorFor(code)}
                  templates={grouped[code] || []}
                  onDeleteTemplate={handleDelete}
                  onEnlarge={handleEnlarge}
                />
              ))
            }
            {allCodes.length === 0 && (
              <div style={{
                textAlign: 'center', padding: 60, color: 'var(--text3)', fontSize: 14,
              }}>
                No templates yet. Verify a drawing to start building the library.
              </div>
            )}
          </div>
        )}
      </div>

      {lightbox && (
        <Lightbox
          imageUrl={lightbox.image_url}
          label={`${lightbox.symbol_name || lightbox.symbol_code} — template #${lightbox.id}`}
          onClose={() => setLightbox(null)}
        />
      )}
    </>
  )
}
