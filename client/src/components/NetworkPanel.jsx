import { RefreshCw } from 'lucide-react'

// Demo controls: cut the connection, add latency or drop frames, then watch
// the CRDT converge anyway once the network heals.
export default function NetworkPanel({ provider, state }) {
  const { sim, metrics, status } = state
  return (
    <div className="panel-body">
      <p className="help">
        Simulate a bad connection for this tab only. Edits always apply locally first. When the network recovers, a
        state-vector handshake exchanges only the missing changes, and every copy converges.
      </p>

      <label className="setting switch-row">
        <span>
          <strong>Offline mode</strong>
          <span>Close the socket and block reconnection</span>
        </span>
        <span className="switch">
          <input type="checkbox" checked={!!sim.offline} onChange={(e) => provider.setSim({ offline: e.target.checked })} />
          <span className="track" />
        </span>
      </label>

      <div className="section">
        <div className="section-title">Conditions</div>
        <label className="control">
          <span className="control-row">
            Latency <span className="value">{sim.latencyMs} ms</span>
          </span>
          <input
            type="range"
            min="0"
            max="3000"
            step="100"
            value={sim.latencyMs}
            onChange={(e) => provider.setSim({ latencyMs: Number(e.target.value) })}
          />
        </label>
        <label className="control">
          <span className="control-row">
            Packet loss <span className="value">{Math.round(sim.dropRate * 100)}%</span>
          </span>
          <input
            type="range"
            min="0"
            max="0.9"
            step="0.1"
            value={sim.dropRate}
            onChange={(e) => provider.setSim({ dropRate: Number(e.target.value) })}
          />
        </label>
        <p className="help">
          Dropped updates are repaired by anti-entropy: every 10 seconds each peer re-sends its state vector and receives
          whatever it missed.
        </p>
        <button className="btn sm" onClick={() => provider.resync()} disabled={status !== 'connected'} style={{ justifySelf: 'start' }}>
          <RefreshCw size={13} /> Run anti-entropy now
        </button>
      </div>

      <div className="section">
        <div className="section-title">Connection</div>
        <dl className="stats">
          <Stat label="Status" value={status} />
          <Stat label="Round trip" value={metrics.rtt != null ? `${metrics.rtt} ms` : '—'} />
          <Stat label="Frames out / in" value={`${metrics.framesOut} / ${metrics.framesIn}`} />
          <Stat label="Dropped (simulated)" value={metrics.dropped} />
          <Stat label="Reconnects" value={metrics.reconnects} />
          <Stat label="Unsent local changes" value={metrics.unsynced} />
        </dl>
      </div>
    </div>
  )
}

export function Stat({ label, value }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
