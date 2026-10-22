import { useEffect, useState } from 'react'
import { Layers } from 'lucide-react'
import { api } from '../api/client.js'
import { Stat } from './NetworkPanel.jsx'

const kb = (n) => (n == null ? '—' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

export default function MetricsOverlay({ doc, session, state }) {
  const [server, setServer] = useState(null)
  const [local, setLocal] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const tick = () => {
      api(`/docs/${doc.id}/metrics`)
        .then((m) => alive && setServer(m))
        .catch(() => alive && setServer(null))
      setLocal({
        stateBytes: session.adapter.stateSize(),
        ...(session.rga ? session.rga.stats() : {}),
      })
    }
    tick()
    const t = setInterval(tick, 2000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [doc.id, session])

  const compact = async () => {
    setBusy(true)
    try {
      setServer(await api(`/docs/${doc.id}/compact`, { method: 'POST' }))
    } finally {
      setBusy(false)
    }
  }

  const m = state.metrics
  return (
    <div className="panel-body">
      <div className="section">
        <div className="section-title">This replica</div>
        <dl className="stats">
          <Stat label="CRDT engine" value={doc.engine === 'rga' ? 'RGA (custom)' : 'Yjs (YATA)'} />
          <Stat label="Encoded state" value={kb(local?.stateBytes)} />
          {local?.tombstones != null && (
            <>
              <Stat label="Visible chars / tombstones" value={`${local.visible} / ${local.tombstones}`} />
              <Stat label="Ops awaiting causal deps" value={local.pending} />
            </>
          )}
          <Stat label="Sent / received" value={`${kb(m.bytesOut)} / ${kb(m.bytesIn)}`} />
          <Stat label="Round trip" value={m.rtt != null ? `${m.rtt} ms` : '—'} />
        </dl>
      </div>

      <div className="section">
        <div className="section-title">Server room</div>
        {server ? (
          <dl className="stats">
            <Stat label="Connected peers" value={server.connections} />
            <Stat label="Updates received" value={server.updatesIn} />
            <Stat label="Op-log entries" value={server.logEntries} />
            <Stat label="Op-log size" value={kb(server.logBytes)} />
            <Stat label="Snapshot size" value={kb(server.snapshotBytes)} />
            <Stat label="Compactions" value={server.compactions} />
            <Stat
              label="Last compaction"
              value={server.lastCompactionAt ? new Date(server.lastCompactionAt).toLocaleTimeString() : '—'}
            />
          </dl>
        ) : (
          <p className="help">Server unreachable.</p>
        )}
        <p className="help">
          Every update is appended to a log. After 200 entries, or 10 seconds of inactivity, the server folds the log into
          one snapshot and deletes the folded entries, so storage stays bounded no matter how long the session runs.
        </p>
        <button
          className="btn sm"
          onClick={compact}
          disabled={busy || !server || doc.role === 'viewer'}
          style={{ justifySelf: 'start' }}
        >
          <Layers size={13} /> {busy ? 'Compacting…' : 'Compact now'}
        </button>
      </div>
    </div>
  )
}
