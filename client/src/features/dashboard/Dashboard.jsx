import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { ChevronDown, FlaskConical, Inbox, LogOut, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { api } from '../../api/client.js'
import { useAuth } from '../auth/AuthContext.jsx'
import { Avatar, Logo, Menu, TYPE_INFO, TypeIcon, timeAgo } from '../../components/ui.jsx'
import ThemeToggle from '../../components/ThemeToggle.jsx'

const CACHE_KEY = 'collab-docs'
const FILTERS = [
  ['all', 'All'],
  ['doc', 'Documents'],
  ['board', 'Whiteboards'],
  ['text', 'Plain text'],
]

export function NewMenu({ onCreate, disabled }) {
  return (
    <Menu
      trigger={({ toggle }) => (
        <button className="btn primary" onClick={toggle} disabled={disabled} data-new-menu>
          <Plus size={15} /> New <ChevronDown size={14} style={{ marginRight: -4, opacity: 0.7 }} />
        </button>
      )}
    >
      {(close) =>
        Object.entries(TYPE_INFO).map(([type, info]) => (
          <button
            key={type}
            className="menu-item"
            data-new={type}
            onClick={() => {
              close()
              onCreate(type)
            }}
          >
            <info.Icon size={16} strokeWidth={1.75} />
            <span>
              {info.label}
              <span className="desc">{info.desc}</span>
            </span>
          </button>
        ))
      }
    </Menu>
  )
}

export function Sidebar({ counts }) {
  const { user, logout } = useAuth()
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <Logo />
        <span className="wordmark">Merge</span>
      </div>
      <NavLink to="/" end className="nav-item">
        <Inbox size={16} strokeWidth={1.75} /> All documents
        {counts != null && <span className="count">{counts}</span>}
      </NavLink>
      <div className="nav-label">Explore</div>
      <NavLink to="/lab" className="nav-item">
        <FlaskConical size={16} strokeWidth={1.75} /> CRDT Lab
      </NavLink>
      <div className="sidebar-foot">
        <Avatar user={user} size="md" />
        <div className="who">
          <strong>{user.name}</strong>
          <span>{user.email}</span>
        </div>
        <ThemeToggle />
        <button className="btn ghost icon sm" onClick={logout} title="Sign out">
          <LogOut size={15} />
        </button>
      </div>
    </aside>
  )
}

export default function Dashboard() {
  const { offline } = useAuth()
  const navigate = useNavigate()
  const [docs, setDocs] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY)) || []
    } catch {
      return []
    }
  })
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null)
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')

  const load = () =>
    api('/docs')
      .then(({ docs }) => {
        setDocs(docs)
        localStorage.setItem(CACHE_KEY, JSON.stringify(docs))
        setError('')
      })
      .catch((e) => setError(navigator.onLine ? e.message : 'You are offline. Showing cached documents.'))

  useEffect(() => {
    load()
  }, [])

  const create = async (type) => {
    try {
      const { doc } = await api('/docs', { method: 'POST', body: { type, title: TYPE_INFO[type].title } })
      navigate(`/d/${doc.id}`)
    } catch (e) {
      setError(e.message)
    }
  }

  const rename = async (doc, title) => {
    setEditing(null)
    if (!title.trim() || title === doc.title) return
    await api(`/docs/${doc.id}`, { method: 'PATCH', body: { title } }).catch((e) => setError(e.message))
    load()
  }

  const remove = async (doc) => {
    if (!window.confirm(`Delete "${doc.title}" for everyone? This cannot be undone.`)) return
    await api(`/docs/${doc.id}`, { method: 'DELETE' }).catch((e) => setError(e.message))
    load()
  }

  const visible = useMemo(
    () =>
      docs.filter((d) => (filter === 'all' || d.type === filter) && d.title.toLowerCase().includes(query.trim().toLowerCase())),
    [docs, filter, query],
  )

  return (
    <div className="shell">
      <Sidebar counts={docs.length} />
      <main className="main">
        <div className="page">
          <div className="page-head">
            <div>
              <h1>Documents</h1>
              <p>Everything you own or have been invited to. Edits sync live and keep working offline.</p>
            </div>
            <NewMenu onCreate={create} disabled={offline} />
          </div>

          {docs.length === 0 ? (
            <div className="empty">
              <h3>No documents yet</h3>
              <p>Create your first document, or open a share link from a teammate to join theirs.</p>
              <div className="empty-actions">
                {Object.entries(TYPE_INFO).map(([type, info]) => (
                  <button key={type} className="btn" data-new={type} onClick={() => create(type)} disabled={offline}>
                    <info.Icon size={15} strokeWidth={1.75} /> New {info.label.toLowerCase()}
                  </button>
                ))}
              </div>
              {error && <span className="notice">{error}</span>}
            </div>
          ) : (
            <>
              <div className="toolbar-row">
                <div className="segmented" role="tablist">
                  {FILTERS.map(([key, label]) => (
                    <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="row gap">
                  {error && <span className="notice">{error}</span>}
                  <label className="search">
                    <Search size={14} />
                    <input placeholder="Search documents" value={query} onChange={(e) => setQuery(e.target.value)} />
                  </label>
                </div>
              </div>

              <div className="table">
                <div className="table-head">
                  <span>Name</span>
                  <span>Type</span>
                  <span>Access</span>
                  <span>Last edited</span>
                  <span />
                </div>
                {visible.length === 0 && (
                  <div className="table-row">
                    <span className="subtle">No documents match.</span>
                  </div>
                )}
                {visible.map((d) => (
                  <div key={d.id} className="table-row">
                    <span className="cell-name">
                      <TypeIcon type={d.type} />
                      {editing === d.id ? (
                        <input
                          defaultValue={d.title}
                          autoFocus
                          onBlur={(e) => rename(d, e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
                        />
                      ) : (
                        <Link to={`/d/${d.id}`}>{d.title}</Link>
                      )}
                    </span>
                    <span>{TYPE_INFO[d.type]?.label}</span>
                    <span className="role">{d.role}</span>
                    <span title={new Date(d.updatedAt).toLocaleString()}>{timeAgo(d.updatedAt)}</span>
                    {d.role === 'viewer' ? (
                      <span />
                    ) : (
                      <Menu
                        trigger={({ toggle }) => (
                          <button className="btn ghost icon sm" onClick={toggle} title="More actions">
                            <MoreHorizontal size={16} />
                          </button>
                        )}
                      >
                        {(close) => (
                          <>
                            <button
                              className="menu-item"
                              onClick={() => {
                                close()
                                setEditing(d.id)
                              }}
                            >
                              <Pencil size={15} /> Rename
                            </button>
                            {d.role === 'owner' && (
                              <>
                                <div className="menu-sep" />
                                <button
                                  className="menu-item danger"
                                  onClick={() => {
                                    close()
                                    remove(d)
                                  }}
                                >
                                  <Trash2 size={15} /> Delete
                                </button>
                              </>
                            )}
                          </>
                        )}
                      </Menu>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
