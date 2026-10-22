const LABELS = {
  connected: 'Live',
  connecting: 'Connecting',
  disconnected: 'Reconnecting',
  offline: 'Offline',
  deleted: 'Deleted',
}

export default function StatusBadge({ state }) {
  const { status, synced, metrics } = state
  const kind = status === 'connected' ? (synced ? 'ok' : 'warn') : status === 'offline' || status === 'deleted' ? 'bad' : 'warn'
  const label = status === 'connected' && !synced ? 'Syncing' : LABELS[status] || status
  return (
    <span
      className={`badge status-badge ${kind}`}
      title="Edits are always saved locally first and merge automatically once the connection is back"
    >
      <span className="dot" />
      {label}
      {metrics.unsynced > 0 && (
        <span className="count">
          · {metrics.unsynced} local change{metrics.unsynced > 1 ? 's' : ''}
        </span>
      )}
    </span>
  )
}
