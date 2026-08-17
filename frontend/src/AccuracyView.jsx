import React, { useState, useEffect } from 'react'
import { apiFetch } from './api'
import { Topbar } from './Dashboard'
import { useAuthImage } from './TemplatesView'

// Colour for a 0–1 rate: green when strong, amber when shaky, red when poor
const rateColor = v =>
  v == null ? 'var(--text3)' : v >= 0.85 ? 'var(--ok)' : v >= 0.6 ? '#B47E00' : 'var(--red)'

const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`)

function RateBar({ value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 120 }}>
      <div style={{ flex: 1, height: 6, background: 'var(--bg2)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${(value || 0) * 100}%`, height: '100%',
                      background: rateColor(value), borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 12, color: rateColor(value), minWidth: 36, textAlign: 'right' }}>
        {pct(value)}
      </span>
    </div>
  )
}

const HEALTH_STYLE = {
  toxic:    { label: 'Toxic',    color: 'var(--red)', hint: 'Almost every match is wrong — delete this template or snip a cleaner example.' },
  warning:  { label: 'Weak',     color: '#B47E00', hint: 'More misses than hits — consider re-snipping.' },
  good:     { label: 'Good',     color: 'var(--ok)', hint: '' },
  untested: { label: 'Untested', color: 'var(--text3)', hint: 'No verified drawings have used this template yet.' },
}

function HealthBadge({ health }) {
  const h = HEALTH_STYLE[health] || HEALTH_STYLE.untested
  return (
    <span title={h.hint}
          style={{ fontSize: 11, fontWeight: 600, color: h.color,
                   border: `1px solid ${h.color}`, borderRadius: 4, padding: '1px 7px' }}>
      {h.label}
    </span>
  )
}

function TemplateThumb({ imageUrl }) {
  const objectUrl = useAuthImage(imageUrl)
  return objectUrl
    ? <img src={objectUrl} alt="" style={{ width: 44, height: 44, objectFit: 'contain',
                                           background: '#fff', borderRadius: 4,
                                           border: '1px solid var(--border)' }} />
    : <div style={{ width: 44, height: 44, borderRadius: 4, background: 'var(--bg2)' }} />
}

const TH = { textAlign: 'left', padding: '8px 10px', fontSize: 11, color: 'var(--text3)',
             textTransform: 'uppercase', letterSpacing: '0.05em',
             borderBottom: '1px solid var(--border)' }
const TD = { padding: '8px 10px', fontSize: 13, borderBottom: '1px solid var(--border)',
             verticalAlign: 'middle' }

function Stat({ label, value, color }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 90 }}>
      <div style={{ fontSize: 22, fontWeight: 600, color: color || 'var(--text1)' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{label}</div>
    </div>
  )
}

export function AccuracyView({ onNavigate }) {
  const [data,    setData]    = useState(null)
  const [error,   setError]   = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch('/accuracy')
      .then(d => { setData(d); setLoading(false) })
      .catch(err => { setError(err.message); setLoading(false) })
  }, [])

  return (
    <>
      <Topbar title="Accuracy" onBack={() => onNavigate('dashboard')} onNavigate={onNavigate} />
      <div className="page-wrap">
        <div className="page-header">
          <div>
            <h1>Detection Accuracy</h1>
            <p style={{ color: 'var(--text3)', fontSize: 13, marginTop: 4 }}>
              Computed from real verification history — every kept, deleted, or added marker counts.
              Precision = how often the machine was right. Recall = how much it found.
            </p>
          </div>
        </div>

        {loading && (
          <div style={{ textAlign: 'center', padding: 60 }}><span className="spinner spinner-lg" /></div>
        )}
        {error && (
          <div className="card" style={{ padding: 24, color: 'var(--red)' }}>
            Failed to load accuracy data: {error}
          </div>
        )}

        {data && (
          <>
            {/* Overall */}
            <div className="card" style={{ padding: '18px 24px', marginBottom: 20,
                                           display: 'flex', gap: 32, flexWrap: 'wrap',
                                           alignItems: 'center' }}>
              <Stat label="Precision" value={pct(data.overall.precision)}
                    color={rateColor(data.overall.precision)} />
              <Stat label="Recall" value={pct(data.overall.recall)}
                    color={rateColor(data.overall.recall)} />
              <Stat label="Feedback events" value={data.overall.sample} />
              <Stat label="Pages verified"
                    value={`${data.overall.verified_pages}/${data.overall.total_pages}`} />
              <Stat label="Drawings approved"
                    value={`${data.overall.approved_drawings}/${data.overall.drawings}`} />
            </div>

            {/* Per symbol type */}
            <div className="card" style={{ padding: 0, marginBottom: 20, overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px', fontWeight: 600 }}>By symbol type</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={TH}>Symbol</th><th style={TH}>Precision</th><th style={TH}>Recall</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Kept</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Deleted</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Added by hand</th>
                </tr></thead>
                <tbody>
                  {data.by_code.map(r => (
                    <tr key={r.code}>
                      <td style={TD}>{r.name} <span style={{ color: 'var(--text3)', fontSize: 11 }}>({r.code})</span></td>
                      <td style={TD}><RateBar value={r.precision} /></td>
                      <td style={TD}><RateBar value={r.recall} /></td>
                      <td style={{ ...TD, textAlign: 'right' }}>{r.confirms}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{r.false_positives + r.wrong_type}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{r.missed}</td>
                    </tr>
                  ))}
                  {data.by_code.length === 0 && (
                    <tr><td style={{ ...TD, color: 'var(--text3)' }} colSpan={6}>
                      No verification history yet — verify a drawing and numbers appear here.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Per firm + per method, side by side */}
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 20 }}>
              <div className="card" style={{ padding: 0, flex: 2, minWidth: 320, overflow: 'hidden' }}>
                <div style={{ padding: '14px 20px', fontWeight: 600 }}>By drawing firm</div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={TH}>Firm</th><th style={TH}>Precision</th><th style={TH}>Recall</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Sample</th>
                  </tr></thead>
                  <tbody>
                    {data.by_firm.map(r => (
                      <tr key={r.firm}>
                        <td style={TD}>{r.firm}</td>
                        <td style={TD}><RateBar value={r.precision} /></td>
                        <td style={TD}><RateBar value={r.recall} /></td>
                        <td style={{ ...TD, textAlign: 'right' }}>{r.sample}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card" style={{ padding: 0, flex: 1, minWidth: 260, overflow: 'hidden' }}>
                <div style={{ padding: '14px 20px', fontWeight: 600 }}>By detection method</div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={TH}>Method</th><th style={TH}>Precision</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Sample</th>
                  </tr></thead>
                  <tbody>
                    {data.by_method.map(r => (
                      <tr key={r.method}>
                        <td style={TD}>{r.method}</td>
                        <td style={TD}><RateBar value={r.precision} /></td>
                        <td style={{ ...TD, textAlign: 'right' }}>{r.sample}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Template health */}
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px', fontWeight: 600 }}>
                Template health
                <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)', marginLeft: 10 }}>
                  manage in Templates
                </span>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={TH}></th><th style={TH}>Symbol</th><th style={TH}>Firm</th>
                  <th style={TH}>Health</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Uses</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Confirmed</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Rejected</th>
                  <th style={TH}>Precision</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Threshold</th>
                </tr></thead>
                <tbody>
                  {data.templates.map(t => (
                    <tr key={t.id} style={t.health === 'toxic' ? { background: 'rgba(220,38,38,0.06)' } : undefined}>
                      <td style={TD}><TemplateThumb imageUrl={t.image_url} /></td>
                      <td style={TD}>{t.symbol_name} <span style={{ color: 'var(--text3)', fontSize: 11 }}>({t.symbol_code})</span></td>
                      <td style={{ ...TD, color: 'var(--text3)', fontSize: 12 }}>{t.firm || '—'}</td>
                      <td style={TD}><HealthBadge health={t.health} /></td>
                      <td style={{ ...TD, textAlign: 'right' }}>{t.use_count}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{t.confirm_count}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{t.reject_count}</td>
                      <td style={TD}><RateBar value={t.precision} /></td>
                      <td style={{ ...TD, textAlign: 'right' }}>{t.effective_threshold}</td>
                    </tr>
                  ))}
                  {data.templates.length === 0 && (
                    <tr><td style={{ ...TD, color: 'var(--text3)' }} colSpan={9}>
                      No templates yet — snip some with the Snip tool in the verify canvas.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  )
}
