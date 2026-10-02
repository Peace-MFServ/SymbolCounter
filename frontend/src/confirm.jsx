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

/*
  A question with more than one answer, each saying what it does.

    const { choose, modal } = useChoice()
    const pick = await choose({ title, body, choices: [{ value: 'copy', label, note }, ...] })
    // pick is the chosen value, or null for Cancel
*/
export function useChoice() {
  const [asking, setAsking] = useState(null)
  const choose = useCallback(opts => new Promise(resolve => setAsking({ ...opts, resolve })), [])
  const answer = v => { asking?.resolve(v); setAsking(null) }
  const modal = asking ? <ChoiceModal {...asking} onAnswer={answer} /> : null
  return { choose, modal }
}

function ChoiceModal({ title, body = '', choices, hint = '', onAnswer }) {
  useEffect(() => {
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); onAnswer(null) } }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  })
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onAnswer(null)}>
      <div className="modal scope-modal">
        <h2>{title}</h2>
        {body && <p className="muted">{body}</p>}
        <div className="scope-opts">
          {choices.map(c => (
            <button key={c.value} className={`scope-opt${c.danger ? ' danger' : ''}`} onClick={() => onAnswer(c.value)}>
              <strong>{c.label}</strong>
              {c.note && <span>{c.note}</span>}
            </button>
          ))}
        </div>
        {hint && <p className="hint">{hint}</p>}
        <div className="modal-actions"><button className="btn btn-ghost" onClick={() => onAnswer(null)}>Cancel</button></div>
      </div>
    </div>
  )
}
