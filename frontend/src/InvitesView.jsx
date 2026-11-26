import React, { useState, useEffect } from 'react'
import { apiFetch } from './api'
import { showToast } from './toast'
import { Topbar, ago } from './Dashboard'
import { useConfirm } from './confirm'
import { IconPlus, IconCopy } from './icons'

const linkOf = inv => `${window.location.origin}/portal#${inv.token}`
const STATE = {
  open: { text: 'Open', cls: 'wait' },
  sent: { text: 'Plans sent', cls: 'done' },
  locked: { text: 'Locked', cls: 'late' },
  expired: { text: 'Expired', cls: '' },
  closed: { text: 'Closed', cls: '' },
}
const copy = async (text, what) => {
  try { await navigator.clipboard.writeText(text); showToast(`${what} copied`, 'success') }
  catch { showToast('Could not copy. Select the text and copy it.', 'error') }
}

/* The links architects use to send plans in: one per project, each with its own PIN. */
export function InvitesView({ onNavigate }) {
  const [list, setList] = useState(null)
  const [making, setMaking] = useState(false)
  const [shown, setShown] = useState(null)        // { invite, pin }: a link and PIN just made, shown this once
  const { ask, modal: confirmModal } = useConfirm()
  const load = () => apiFetch('/invites').then(setList).catch(err => showToast(err.message, 'error'))
  useEffect(() => { load() }, [])

  const act = async (inv, path, body) => {
    try {
      const r = await apiFetch(`/invites/${inv.id}/${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined })
      if (r?.pin) setShown(r)
      load()
    } catch (err) { showToast(err.message, 'error') }
  }
  const remove = async inv => {
    if (!await ask({ title: `Delete the link for ${inv.firm}?`, body: inv.state === 'sent' ? 'The job made from it stays.' : 'It stops working, and any files sent on it are deleted.', confirm: 'Delete link', danger: true })) return
    try { await apiFetch(`/invites/${inv.id}`, { method: 'DELETE' }); load() }
    catch (err) { showToast(err.message, 'error') }
  }

  return (
    <>
      <Topbar onNavigate={onNavigate} active="invites" />
      {confirmModal}
      {making && <MakeInvite onClose={() => setMaking(false)} onMade={r => { setMaking(false); setShown(r); load() }} />}
      {shown && <ShowInvite data={shown} onClose={() => setShown(null)} />}
      <div className="page-wrap">
        <div className="page-header">
          <div>
            <h1>Architect links</h1>
            <p className="lede">Each link lets one architect send one project's plans in. Make a link and Outlook opens with the email ready: the link and its PIN, to the architect. Five wrong PINs locks the link.</p>
          </div>
          <div className="spacer" />
          <button className="btn btn-primary btn-lg" onClick={() => setMaking(true)}><IconPlus size={16} /> New link</button>
        </div>
        {!list ? <div style={{ textAlign: 'center', padding: 60 }}><span className="spinner spinner-lg" /></div>
          : list.length === 0 ? (
            <div className="empty-state">
              <h2>No links yet.</h2>
              <p>Make a link for an architect, send it with its PIN, and their plans arrive in Incoming.</p>
              <button className="btn btn-primary" onClick={() => setMaking(true)}>New link</button>
            </div>
          ) : (
            <div className="owner-card">
              <div className="job-table-scroll">
                <table className="job-table inv-table">
                  <thead><tr><th>Architect</th><th>Made</th><th>State</th><th className="num">Actions</th></tr></thead>
                  <tbody>
                    {list.map(inv => {
                      const st = STATE[inv.state] || STATE.closed
                      return (
                        <tr key={inv.id}>
                          <td>
                            <div className="job-name">{inv.firm}</div>
                            <div className="job-meta">{[inv.project, inv.email].filter(Boolean).join(' · ') || 'No project or email given'}</div>
                          </td>
                          <td className="muted">{ago(inv.created_at)}{inv.created_by ? ` by ${inv.created_by}` : ''}</td>
                          <td>
                            <span className={`stage-pill ${st.cls}`}>{st.text}</span>
                            <div className="job-meta">
                              {inv.state === 'sent' ? `Sent ${ago(inv.sent_at)}`
                                : inv.state === 'open' ? `Until ${new Date(inv.expires_at).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })}${inv.failed ? ` · ${inv.failed} wrong PIN${inv.failed !== 1 ? 's' : ''}` : ''}`
                                : inv.state === 'locked' ? 'Too many wrong PINs' : ''}
                            </div>
                          </td>
                          <td className="num">
                            <div className="inv-acts">
                              {inv.state === 'sent' && inv.project_id && <button className="btn btn-sm" onClick={() => onNavigate('plan-reader', { id: inv.project_id })}>Open job</button>}
                              {inv.state === 'open' && <button className="btn btn-sm" onClick={() => copy(linkOf(inv), 'Link')}><IconCopy size={13} /> Copy link</button>}
                              {inv.state === 'locked' && <button className="btn btn-sm btn-primary" onClick={() => act(inv, 'unlock')}>Unlock</button>}
                              {['open', 'locked'].includes(inv.state) && <button className="btn btn-sm" onClick={() => act(inv, 'new-pin')}>New PIN</button>}
                              {['expired', 'closed'].includes(inv.state) && <button className="btn btn-sm" onClick={() => act(inv, 'extend', { days: 14 })}>Open for 14 days</button>}
                              {['open', 'locked'].includes(inv.state) && <button className="btn btn-sm btn-ghost" onClick={() => act(inv, 'close')}>Close</button>}
                              <button className="btn btn-sm btn-ghost danger-text" onClick={() => remove(inv)}>Delete</button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
      </div>
    </>
  )
}

function MakeInvite({ onClose, onMade }) {
  const [firm, setFirm] = useState('')
  const [email, setEmail] = useState('')
  const [project, setProject] = useState('')
  const [days, setDays] = useState(14)
  const [busy, setBusy] = useState(false)
  const submit = async e => {
    e.preventDefault()
    setBusy(true)
    try { onMade(await apiFetch('/invites', { method: 'POST', body: JSON.stringify({ firm, email, project, days: Number(days) }) })) }
    catch (err) { showToast(err.message, 'error') }
    finally { setBusy(false) }
  }
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <h2>New link for an architect</h2>
        <p className="muted" style={{ margin: '6px 0 18px' }}>One link per project. They fill in their own details and the project's when they open it.</p>
        <div className="form-group">
          <label>Architect firm *</label>
          <input className="form-control" value={firm} onChange={e => setFirm(e.target.value)} placeholder="e.g. O'Mahony Pike" required autoFocus />
        </div>
        <div className="form-grid">
          <div className="form-group">
            <label>Their email</label>
            <input className="form-control" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="The email goes to them" />
          </div>
          <div className="form-group">
            <label>Project, if known</label>
            <input className="form-control" value={project} onChange={e => setProject(e.target.value)} placeholder="e.g. Block BA02" />
          </div>
        </div>
        <div className="form-group">
          <label>Link works for</label>
          <select className="form-control" value={days} onChange={e => setDays(e.target.value)} style={{ maxWidth: 200 }}>
            {[3, 7, 14, 30, 60].map(d => <option key={d} value={d}>{d} days</option>)}
          </select>
        </div>
        <div className="modal-actions" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" disabled={busy || !firm.trim()}>{busy ? <span className="spinner" /> : 'Make the link'}</button>
        </div>
      </form>
    </div>
  )
}

/* The link and PIN, shown once, and the email that carries both: opened in
   Outlook ready to send, or copied. The PIN is not kept anywhere it can be read again. */
function ShowInvite({ data, onClose }) {
  const { invite, pin } = data
  const link = linkOf(invite)
  const subject = `Send your floor plans to MF Services${invite.project ? `: ${invite.project}` : ''}`
  const email = `Hello,

Please send the floor plans for ${invite.project || 'your project'} through this link:

${link}

Your PIN to open it: ${pin}

Upload the floor plans as PDFs exported from CAD, with every door labelled, and add a short brief about the project. We will have your door schedule back to you within 48 hours.

Kind regards,
MF Services`
  const q = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(email)}`
  const mailto = `mailto:${encodeURIComponent(invite.email || '')}?${q}`
  const owa = `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(invite.email || '')}&${q}`
  return (
    <div className="modal-overlay">
      <div className="modal inv-show">
        <h2>Link for {invite.firm}</h2>
        <p className="rail-note" style={{ marginTop: 10 }}>Send the email now: the PIN is shown this once and cannot be looked up again. If it is lost, make a new PIN.</p>
        <label className="inv-label">PIN</label>
        <div className="inv-copyrow">
          <code className="inv-pin">{pin}</code>
          <button className="btn btn-sm" onClick={() => copy(pin, 'PIN')}><IconCopy size={13} /> Copy PIN</button>
        </div>
        <label className="inv-label">Link</label>
        <div className="inv-copyrow">
          <input className="form-control mono" readOnly value={link} onFocus={e => e.target.select()} />
          <button className="btn btn-sm" onClick={() => copy(link, 'Link')}><IconCopy size={13} /> Copy link</button>
        </div>
        <label className="inv-label">The email, with the link and the PIN{invite.email ? `, to ${invite.email}` : ''}</label>
        <textarea className="form-control inv-email" readOnly value={email} rows={10} />
        <div className="modal-actions inv-send">
          <a className="btn btn-primary" href={mailto}>Open in Outlook</a>
          <a className="btn" href={owa} target="_blank" rel="noopener noreferrer">Outlook on the web</a>
          <button className="btn" onClick={() => copy(email, 'Email')}>Copy email</button>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
