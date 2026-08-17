import React, { useState, useEffect } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'

const PRESET_COLORS = [
  '#22c55e','#3b82f6','#f97316','#a78bfa','#f43f5e',
  '#06b6d4','#eab308','#ec4899','#14b8a6','#8b5cf6',
]

export function SymbolManagerModal({ projectId, onClose, onChanged }) {
  const [types,     setTypes]    = useState([])
  const [loading,   setLoading]  = useState(true)
  const [newName,   setNewName]  = useState('')
  const [newCode,   setNewCode]  = useState('')
  const [newColor,  setNewColor] = useState('#8892a8')
  const [saving,    setSaving]   = useState(false)
  const [editId,    setEditId]   = useState(null)
  const [editName,  setEditName] = useState('')
  const [editCode,  setEditCode] = useState('')
  const [editColor, setEditColor]= useState('')

  useEffect(() => {
    apiFetch(`/projects/${projectId}/symbol-types`)
      .then(t => { setTypes(t || []); setLoading(false) })
  }, [])

  const add = async e => {
    e.preventDefault()
    if (!newName.trim() || !newCode.trim()) return
    setSaving(true)
    try {
      const t = await apiFetch(`/projects/${projectId}/symbol-types`, {
        method: 'POST',
        body: JSON.stringify({
          name: newName.trim(), code: newCode.trim(),
          color: newColor, sort_order: types.length,
        }),
      })
      if (t) { setTypes(ts => [...ts, t]); setNewName(''); setNewCode(''); setNewColor('#8892a8'); onChanged() }
    } catch (err) { showToast(err.message, 'error') }
    setSaving(false)
  }

  const startEdit = t => { setEditId(t.id); setEditName(t.name); setEditCode(t.code); setEditColor(t.color) }

  const saveEdit = async () => {
    try {
      const t = await apiFetch(`/symbol-types/${editId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editName, code: editCode.trim(), color: editColor, sort_order: 0 }),
      })
      if (t) { setTypes(ts => ts.map(x => x.id === editId ? t : x)); setEditId(null); onChanged() }
    } catch (err) { showToast(err.message, 'error') }
  }

  const del = async id => {
    if (!confirm('Delete this symbol type?')) return
    await apiFetch(`/symbol-types/${id}`, { method: 'DELETE' })
    setTypes(ts => ts.filter(t => t.id !== id))
    onChanged()
  }

  const reset = async () => {
    if (!confirm('Reset to default symbol types? This will delete any custom types.')) return
    const t = await apiFetch(`/projects/${projectId}/symbol-types/reset`, { method: 'POST' })
    if (t) { setTypes(t); onChanged() }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0 }}>Configure Symbol Types</h2>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm" onClick={reset} style={{ marginRight: 8 }}>
            Reset to defaults
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 16 }}>
          Define what symbols this project should detect. The code is what appears on the drawing (e.g. "S" for Smoke Detector).
        </p>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}><span className="spinner" /></div>
        ) : (
          <div style={{ marginBottom: 16 }}>
            {types.map(t => editId === t.id ? (
              <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ width: 14, height: 14, borderRadius: '50%', background: editColor, flexShrink: 0, display: 'inline-block' }} />
                <input className="form-control" value={editName} onChange={e => setEditName(e.target.value)}
                       style={{ flex: 2, padding: '5px 8px' }} placeholder="Name" />
                <input className="form-control" value={editCode} onChange={e => setEditCode(e.target.value)}
                       style={{ width: 80, padding: '5px 8px', fontFamily: 'monospace' }} placeholder="Code" />
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', width: 120 }}>
                  {PRESET_COLORS.map(c => (
                    <span key={c} onClick={() => setEditColor(c)}
                          style={{ width: 16, height: 16, borderRadius: '50%', background: c, cursor: 'pointer',
                                   outline: editColor === c ? '2px solid white' : 'none', outlineOffset: 1 }} />
                  ))}
                </div>
                <button className="btn btn-primary btn-sm" onClick={saveEdit}>Save</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditId(null)}>Cancel</button>
              </div>
            ) : (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: t.color, flexShrink: 0, display: 'inline-block' }} />
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{t.name}</span>
                <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text2)', background: 'var(--bg3)', padding: '2px 8px', borderRadius: 4 }}>{t.code}</span>
                {t.template_count > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text3)' }}>{t.template_count} template{t.template_count !== 1 ? 's' : ''}</span>
                )}
                <button className="btn btn-ghost btn-sm" onClick={() => startEdit(t)}>Edit</button>
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => del(t.id)}>✕</button>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={add} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <div style={{ flex: 2, minWidth: 140 }}>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Symbol Name</label>
            <input className="form-control" value={newName} onChange={e => setNewName(e.target.value)}
                   placeholder="e.g. Smoke Detector" style={{ padding: '7px 10px' }} />
          </div>
          <div style={{ width: 90 }}>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Code on drawing</label>
            <input className="form-control" value={newCode} onChange={e => setNewCode(e.target.value)}
                   placeholder="e.g. S" style={{ padding: '7px 10px', fontFamily: 'monospace' }} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Colour</label>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', width: 120 }}>
              {PRESET_COLORS.map(c => (
                <span key={c} onClick={() => setNewColor(c)}
                      style={{ width: 18, height: 18, borderRadius: '50%', background: c, cursor: 'pointer',
                               outline: newColor === c ? '2px solid white' : 'none', outlineOffset: 1 }} />
              ))}
            </div>
          </div>
          <button type="submit" className="btn btn-primary"
                  disabled={saving || !newName.trim() || !newCode.trim()}>
            {saving ? <span className="spinner" /> : '+ Add Symbol'}
          </button>
        </form>
      </div>
    </div>
  )
}
