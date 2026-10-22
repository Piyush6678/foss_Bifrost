import { useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import { RGA, diffText } from '@collab/rga-crdt'
import { decodeJSON } from '@collab/protocol'
import { RotateCcw, Save } from 'lucide-react'
import { api } from '../../api/client.js'
import { timeAgo } from '../../components/ui.jsx'
import { BoardPreview } from '../whiteboard/Whiteboard.jsx'

const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

/**
 * Version history. A version is a full CRDT snapshot taken on the server.
 * Restoring never rewinds history (that would fight other peers' merges):
 * we compute the old content and apply it as a *new* forward edit, so it
 * syncs and merges like any other change.
 */
export default function HistoryPanel({ doc, session, readOnly }) {
  const [versions, setVersions] = useState([])
  const [name, setName] = useState('')
  const [preview, setPreview] = useState(null) // { id, name, data }
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () =>
    api(`/docs/${doc.id}/versions`)
      .then(({ versions }) => setVersions(versions))
      .catch((e) => setError(e.message))
  useEffect(() => {
    load()
  }, [doc.id])

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(`/docs/${doc.id}/versions`, { method: 'POST', body: { name: name || `Version ${versions.length + 1}` } })
      setName('')
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const open = async (v) => {
    try {
      const res = await api(`/docs/${doc.id}/versions/${v.id}`)
      setPreview({ ...res, data: fromBase64(res.data) })
    } catch (err) {
      setError(err.message)
    }
  }

  const restore = () => {
    restoreVersion(doc.type, session, preview.data)
    setPreview(null)
  }

  return (
    <div className="panel-body">
      {!readOnly && (
        <form className="section" onSubmit={save}>
          <div className="section-title">Save a checkpoint</div>
          <div className="row gap">
            <input placeholder={`Version ${versions.length + 1}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            <button className="btn primary" disabled={busy}>
              <Save size={14} /> Save
            </button>
          </div>
        </form>
      )}
      {error && <p className="error">{error}</p>}

      <div className="section">
        <div className="section-title">Saved versions</div>
        <ul className="version-list">
          {versions.length === 0 && <li className="help">No saved versions yet.</li>}
          {versions.map((v) => (
            <li key={v.id} className={preview?.id === v.id ? 'active' : ''}>
              <button className="version-item" onClick={() => open(v)}>
                <span className="vdot" />
                <span>
                  <strong>{v.name}</strong>
                  <span>
                    {timeAgo(v.createdAt)} · {v.createdByName}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {preview && (
        <div className="section">
          <div className="row between">
            <div className="section-title">Preview · {preview.name}</div>
            <button className="btn ghost sm" onClick={() => setPreview(null)}>
              Close
            </button>
          </div>
          <div className="preview-box">
            <VersionPreview type={doc.type} data={preview.data} />
          </div>
          {!readOnly && (
            <>
              <button className="btn primary block" onClick={restore}>
                <RotateCcw size={14} /> Restore this version
              </button>
              <p className="help">Restoring applies the old content as a new edit, so it merges with whatever others are typing.</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function VersionPreview({ type, data }) {
  if (type === 'text') return <pre className="text-preview">{RGA.fromSnapshot('preview', decodeJSON(data)).toString()}</pre>
  return <YjsPreview type={type} data={data} />
}

function YjsPreview({ type, data }) {
  const ydoc = useMemo(() => {
    const d = new Y.Doc()
    Y.applyUpdate(d, data)
    return d
  }, [data])
  useEffect(() => () => ydoc.destroy(), [ydoc])
  return type === 'board' ? <BoardPreview ydoc={ydoc} /> : <RichPreview ydoc={ydoc} />
}

function RichPreview({ ydoc }) {
  const editor = useEditor(
    { extensions: [StarterKit.configure({ history: false }), Collaboration.configure({ document: ydoc, field: 'content' })], editable: false },
    [ydoc],
  )
  return <EditorContent editor={editor} className="prose-preview" />
}

function restoreVersion(type, session, data) {
  if (type === 'text') {
    const target = RGA.fromSnapshot('restore', decodeJSON(data)).toString()
    const { index, deleteCount, insert } = diffText(session.rga.toString(), target)
    if (deleteCount) session.rga.delete(index, deleteCount)
    if (insert) session.rga.insert(index, insert)
    return
  }
  const old = new Y.Doc()
  Y.applyUpdate(old, data)
  const live = session.ydoc
  live.transact(() => {
    if (type === 'board') {
      const shapes = live.getMap('shapes')
      ;[...shapes.keys()].forEach((k) => shapes.delete(k))
      old.getMap('shapes').forEach((m, k) => shapes.set(k, m.clone()))
    } else {
      const frag = live.getXmlFragment('content')
      frag.delete(0, frag.length)
      frag.insert(0, old.getXmlFragment('content').toArray().map((n) => n.clone()))
    }
  }, 'restore')
  old.destroy()
}
