import React, { useState, useEffect, useCallback } from 'react'

/*
  Nothing is lost by accident: if a screen has changes that were never saved and
  the estimator leaves it, ask first. Save and leave, leave anyway, or stay put.
*/
export function useLeaveGuard({ dirty, onSave, what = 'changes' }) {
  const [pending, setPending] = useState(null)   // what to do once they answer
  const [busy, setBusy] = useState(false)

  // closing the tab or refreshing gets the browser's own warning
  useEffect(() => {
    if (!dirty) return
    const warn = e => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // wrap any navigation: guard(onNavigate)('job', { id })
  const guard = useCallback(fn => (...args) => {
    if (!dirty) return fn(...args)
    setPending(() => () => fn(...args))
  }, [dirty])

  const run = () => { const go = pending; setPending(null); if (go) go() }
  const saveAndGo = async () => {
    setBusy(true)
    let ok = true
    try { ok = await onSave() } catch { ok = false }
    setBusy(false)
    if (ok === false) { setPending(null); return }   // save failed: stay and show the error
    run()
  }

  const modal = pending
    ? <UnsavedModal what={what} busy={busy} onSave={saveAndGo} onDiscard={run} onCancel={() => setPending(null)} />
    : null
  return { guard, modal, asking: !!pending }
}

function UnsavedModal({ what, busy, onSave, onDiscard, onCancel }) {
  useEffect(() => {
    const key = e => { if (e.key === 'Escape' && !busy) onCancel() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [busy, onCancel])
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="modal unsaved-modal">
        <h2>Save your {what}?</h2>
        <p>Your changes have not been saved. If you leave now they are lost.</p>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onSave} disabled={busy}>{busy ? <span className="spinner" /> : 'Save and leave'}</button>
          <button className="btn" onClick={onDiscard} disabled={busy}>Leave without saving</button>
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Stay here</button>
        </div>
      </div>
    </div>
  )
}
