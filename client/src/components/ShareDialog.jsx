import { useEffect, useState } from 'react'
import { Check, Copy, RefreshCw, X } from 'lucide-react'
import { api } from '../api/client.js'
import { Avatar } from './ui.jsx'

export default function ShareDialog({ doc, onClose }) {
  const [share, setShare] = useState(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  const load = () =>
    api(`/docs/${doc.id}/share`)
      .then(setShare)
      .catch((e) => setError(e.message))
  useEffect(() => {
    load()
  }, [doc.id])

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const patch = async (body) => {
    try {
      await api(`/docs/${doc.id}/share`, { method: 'PATCH', body })
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  const link = share ? `${location.origin}/join/${share.shareToken}` : ''
  const copy = async () => {
    await navigator.clipboard.writeText(link)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>Share “{doc.title}”</h2>
            <p>Anyone with the link can join after signing in.</p>
          </div>
          <button className="btn ghost icon sm" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          {error && <div className="form-error">{error}</div>}
          {!share ? (
            <p className="help">Loading…</p>
          ) : (
            <>
              <div className="section">
                <div className="row between">
                  <div className="section-title">Invite link</div>
                  <select
                    value={share.shareRole}
                    onChange={(e) => patch({ shareRole: e.target.value })}
                    style={{ width: 'auto', height: 28, fontSize: 12.5 }}
                    aria-label="Role granted by the link"
                  >
                    <option value="editor">Can edit</option>
                    <option value="viewer">Can view</option>
                  </select>
                </div>
                <div className="link-row">
                  <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Share link" />
                  <button className="btn primary" onClick={copy}>
                    {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <button className="btn ghost sm" onClick={() => patch({ regenerate: true })} style={{ justifySelf: 'start' }}>
                  <RefreshCw size={13} /> Reset link
                </button>
              </div>

              <div className="section">
                <div className="section-title">People with access</div>
                <div className="people">
                  {share.collaborators.length === 0 && <p className="help">Only you so far.</p>}
                  {share.collaborators.map((c) => (
                    <div key={c.id} className="person">
                      <Avatar user={c} size="md" />
                      <div className="who">
                        <strong>{c.name}</strong>
                        <span>{c.email}</span>
                      </div>
                      <select value={c.role} onChange={(e) => patch({ collaborator: { id: c.id, role: e.target.value } })}>
                        <option value="editor">Can edit</option>
                        <option value="viewer">Can view</option>
                        <option value="remove">Remove</option>
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
