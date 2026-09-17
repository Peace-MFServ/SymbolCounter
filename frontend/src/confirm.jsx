import React, { useState, useCallback, useEffect } from 'react'

/*
  Asking before something that cannot be undone, in the app's own words rather
  than the browser's grey box.

    const { ask, modal } = useConfirm()
    if (!await ask({ title: 'Delete this job?', confirm: 'Delete job', danger: true })) return
*/
export function useConfirm() {
  const [asking, setAsking] = useState(null)
  const ask = useCallback(opts => new Promise(resolve => setAsking({ ...opts, resolve })), [])
  const answer = ok => { asking?.resolve(ok); setAsking(null) }
  const modal = asking ? <ConfirmModal {...asking} onAnswer={answer} /> : null
  return { ask, modal }
}

function ConfirmModal({ title, body = '', confirm = 'Yes', danger = false, onAnswer }) {
  useEffect(() => {
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); onAnswer(false) } }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  })
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onAnswer(false)}>
      <div className="modal unsaved-modal">
        <h2>{title}</h2>
        {body && <p>{body}</p>}
        <div className="modal-actions">
          <button className={danger ? 'btn btn-danger' : 'btn btn-primary'} autoFocus onClick={() => onAnswer(true)}>{confirm}</button>
          <button className="btn" onClick={() => onAnswer(false)}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
