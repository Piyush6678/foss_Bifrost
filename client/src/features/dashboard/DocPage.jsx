import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Activity, ArrowLeft, Eye, History, Share2, Wifi, X } from 'lucide-react'
import { api } from '../../api/client.js'
import { useAuth } from '../auth/AuthContext.jsx'
import { useSession, useProviderState } from '../../crdt/hooks.js'
import { TypeIcon } from '../../components/ui.jsx'
import StatusBadge from '../../components/StatusBadge.jsx'
import ThemeToggle from '../../components/ThemeToggle.jsx'
import PresenceBar from '../presence/PresenceBar.jsx'
import NetworkPanel from '../../components/NetworkPanel.jsx'
import MetricsOverlay from '../../components/MetricsOverlay.jsx'
import ShareDialog from '../../components/ShareDialog.jsx'
import HistoryPanel from '../history/HistoryPanel.jsx'
import RichEditor from '../editor/RichEditor.jsx'
import Whiteboard from '../whiteboard/Whiteboard.jsx'
import RgaTextEditor from '../text/RgaTextEditor.jsx'

const metaKey = (id) => `collab-doc-${id}`

const PANELS = {
  network: { title: 'Network', Icon: Wifi },
  metrics: { title: 'Sync metrics', Icon: Activity },
  history: { title: 'Version history', Icon: History },
}

export default function DocPage() {
  const { id } = useParams()
  const { user } = useAuth()
  const [doc, setDoc] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(metaKey(id)))
    } catch {
      return null
    }
  })
  const [error, setError] = useState('')
  const [panel, setPanel] = useState(null) // 'history' | 'network' | 'metrics' | 'share'

  useEffect(() => {
    api(`/docs/${id}`)
      .then(({ doc }) => {
        setDoc(doc)
        localStorage.setItem(metaKey(id), JSON.stringify(doc))
      })
      .catch((e) => {
        // Offline with cached metadata: keep going, the CRDT lives in IndexedDB.
        if (e.status) setError(e.status === 404 ? 'This document does not exist, or you do not have access to it.' : e.message)
      })
  }, [id])

  const session = useSession(doc, user)
  const state = useProviderState(session?.provider)
  const readOnly = doc?.role === 'viewer' || state.readOnly

  const rename = async (title) => {
    if (!title.trim() || title === doc.title) return
    try {
      const { doc: d } = await api(`/docs/${id}`, { method: 'PATCH', body: { title } })
      setDoc(d)
      localStorage.setItem(metaKey(id), JSON.stringify(d))
    } catch (e) {
      setError(e.message)
    }
  }

  if (error && !doc) {
    return (
      <div className="center">
        <div className="empty" style={{ maxWidth: 440 }}>
          <h3>Document unavailable</h3>
          <p>{error}</p>
          <Link className="btn" to="/">
            <ArrowLeft size={15} /> Back to documents
          </Link>
        </div>
      </div>
    )
  }
  if (!doc) return <div className="center subtle">Loading…</div>

  const toggle = (p) => setPanel(panel === p ? null : p)
  const panelButton = (key) => {
    const { Icon } = PANELS[key]
    const label = key[0].toUpperCase() + key.slice(1)
    return (
      <button className={`btn ghost ${panel === key ? 'active' : ''}`} onClick={() => toggle(key)} title={PANELS[key].title}>
        <Icon size={15} strokeWidth={1.75} />
        <span className="label">{label}</span>
      </button>
    )
  }

  return (
    <div className="doc-page">
      <header className="doc-header">
        <div className="crumbs">
          <Link to="/" className="btn ghost icon sm" title="Back to documents">
            <ArrowLeft size={16} />
          </Link>
          <Link to="/">Documents</Link>
          <span className="sep">/</span>
          <TypeIcon type={doc.type} size={14} />
          <input
            className="title-input"
            defaultValue={doc.title}
            key={doc.title}
            readOnly={doc.role === 'viewer'}
            onBlur={(e) => rename(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
            aria-label="Document title"
          />
          {readOnly && (
            <span className="badge">
              <Eye size={12} /> View only
            </span>
          )}
        </div>
        <div className="header-actions">
          <PresenceBar awareness={session?.awareness} />
          <StatusBadge state={state} />
          <span className="divider-v" />
          {panelButton('network')}
          {panelButton('metrics')}
          {panelButton('history')}
          <ThemeToggle />
          {doc.role === 'owner' && (
            <button className="btn primary" onClick={() => toggle('share')} style={{ marginLeft: 6 }}>
              <Share2 size={14} /> Share
            </button>
          )}
        </div>
      </header>

      <div className="doc-body">
        <main className={`doc-main ${doc.type}`}>
          {!session ? (
            <div className="center subtle">Opening local copy…</div>
          ) : doc.type === 'doc' ? (
            <RichEditor session={session} user={user} readOnly={readOnly} />
          ) : doc.type === 'board' ? (
            <Whiteboard session={session} readOnly={readOnly} />
          ) : (
            <RgaTextEditor rga={session.rga} awareness={session.awareness} readOnly={readOnly} />
          )}
        </main>
        {PANELS[panel] && session && (
          <aside className="side-panel">
            <div className="panel-head">
              <h2>{PANELS[panel].title}</h2>
              <button className="btn ghost icon sm" onClick={() => setPanel(null)} title="Close panel">
                <X size={16} />
              </button>
            </div>
            {panel === 'network' && <NetworkPanel provider={session.provider} state={state} />}
            {panel === 'metrics' && <MetricsOverlay doc={doc} session={session} state={state} />}
            {panel === 'history' && <HistoryPanel doc={doc} session={session} readOnly={readOnly} />}
          </aside>
        )}
      </div>
      {panel === 'share' && <ShareDialog doc={doc} onClose={() => setPanel(null)} />}
    </div>
  )
}
