import React, { useState, useEffect } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { useConfirm } from './confirm'
import { ReplaceModal } from './SetsView'

/* Products with this job's prices on them, for the pickers on a job. */
export function useJobProducts(projectId) {
  const [products, setProducts] = useState([])
  useEffect(() => {
    Promise.all([apiFetch('/products'), apiFetch(`/projects/${projectId}/prices`)])
      .then(([ps, jp]) => setProducts((ps || []).map(p => (jp && p.id in jp ? { ...p, price: jp[p.id] } : p))))
      .catch(() => {})
  }, [projectId])
  return products
}

/* Replace a product everywhere on the job: pick the new one, see what it
   touches, then confirm.

     const { start, ui } = useReplaceOnJob(projectId, products, reload)
     start({ product_id, sku, name, product_type }) */
export function useReplaceOnJob(projectId, products, onDone) {
  const [item, setItem] = useState(null)
  const { ask, modal } = useConfirm()
  const pick = async p => {
    const old = item
    setItem(null)
    try {
      const body = { product_id: old.product_id, new_product_id: p.id }
      const r = await apiFetch(`/projects/${projectId}/replace-product`, { method: 'POST', body: JSON.stringify(body) })
      if (!r.sets.length) { showToast(`${old.sku} is not in any set on this job`, 'info'); return }
      const where = r.sets.length === 1 ? `set ${r.sets[0]}` : `${r.sets.length} sets (${r.sets.join(', ')})`
      const ok = await ask({
        title: `Replace ${r.old.sku} with ${r.new.sku} on the whole job?`,
        body: `${r.old.sku} is in ${where}, on ${r.doors} door${r.doors !== 1 ? 's' : ''}. It will be replaced on all of them and the quantities kept.`
          + (r.library_sets ? ' Library sets get this job’s own copy, so the set library and other jobs do not change.' : ''),
        confirm: `Replace on ${r.doors} door${r.doors !== 1 ? 's' : ''}`,
      })
      if (!ok) return
      await apiFetch(`/projects/${projectId}/replace-product`, { method: 'POST', body: JSON.stringify({ ...body, apply: true }) })
      showToast(`${r.old.sku} replaced with ${r.new.sku} on ${r.doors} door${r.doors !== 1 ? 's' : ''}`, 'success')
      await onDone?.()
    } catch (err) { showToast(err.message, 'error') }
  }
  const ui = (
    <>
      {modal}
      {item && <ReplaceModal item={item} products={products} taken={new Set()} title="Replace on the whole job"
                             nowLabel="On this job now" keepNote="Every set keeps its own quantity"
                             onPick={pick} onClose={() => setItem(null)} />}
    </>
  )
  return { start: setItem, ui }
}

/* Which doors a change is for, asked before anything is saved. */
export function ScopeModal({ ask, onAnswer: answer }) {
  // the Enter that saved a quantity must not also pick an option: nothing counts
  // until the window has been open a moment, and no option is focused for you
  const [ready, setReady] = useState(false)
  useEffect(() => { const t = setTimeout(() => setReady(true), 350); return () => clearTimeout(t) }, [])
  const onAnswer = a => { if (ready || a === null) answer(a) }
  useEffect(() => {
    const key = e => { if (e.key === 'Escape') onAnswer(null) }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  })
  const { title, door, set, others, jobWide } = ask
  const all = others + 1
  return (
    <div className="modal-overlay" onMouseDown={e => e.target === e.currentTarget && onAnswer(null)}>
      <div className="modal scope-modal">
        <h2>{title}</h2>
        <p className="muted">{door} uses set {set}, which is on {all} doors on this job.</p>
        <div className="scope-opts">
          <button className="scope-opt" onClick={() => onAnswer('set')}>
            <strong>Change all {all} doors on {set}</strong>
            <span>Every door with this set gets the change.</span>
          </button>
          <button className="scope-opt" onClick={() => onAnswer('door')}>
            <strong>Change {door} only</strong>
            <span>{door} gets its own copy of the set, with the change. The other {others} door{others !== 1 ? 's' : ''} keep{others === 1 ? 's' : ''} {set}.</span>
          </button>
          {jobWide && (
            <button className="scope-opt" onClick={() => onAnswer('job')}>
              <strong>Change it everywhere on this job</strong>
              <span>{jobWide}</span>
            </button>
          )}
        </div>
        <p className="hint">The set library and other jobs never change from here.</p>
        <div className="modal-actions"><button className="btn btn-ghost" onClick={() => onAnswer(null)}>Cancel</button></div>
      </div>
    </div>
  )
}
