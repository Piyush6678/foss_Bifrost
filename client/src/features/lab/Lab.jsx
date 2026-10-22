import { useEffect, useReducer, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Check, Eraser, Link2, Loader, RotateCcw, Shuffle, Unlink } from 'lucide-react'
import { Logo } from '../../components/ui.jsx'
import ThemeToggle from '../../components/ThemeToggle.jsx'
import { RGA, minVersionVector } from '@collab/rga-crdt'
import RgaTextEditor from '../text/RgaTextEditor.jsx'

// The CRDT Lab runs three RGA replicas in this tab, connected by a simulated
// network with per-link partitions, latency and reordering. It needs no server.

const PEERS = [
  { site: 'alice', name: 'Alice', color: '#dc2626' },
  { site: 'bob', name: 'Bob', color: '#2563eb' },
  { site: 'carol', name: 'Carol', color: '#16a34a' },
]
const LINKS = [
  [0, 1],
  [1, 2],
  [0, 2],
]
const linkKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`)
const colorOf = Object.fromEntries(PEERS.map((p) => [p.site, p.color]))
const WORDS = ['merge', 'crdt', 'peer', 'sync', 'lamport', 'tomb', 'rga', 'offline', 'causal', 'vector']

function makeReplicas() {
  return PEERS.map((p) => new RGA(p.site))
}

export default function Lab() {
  const [replicas, setReplicas] = useState(makeReplicas)
  const [gen, setGen] = useState(0)
  const [links, setLinks] = useState(() => Object.fromEntries(LINKS.map(([a, b]) => [linkKey(a, b), true])))
  const [latency, setLatency] = useState(400)
  const [log, setLog] = useState([])
  const [, force] = useReducer((x) => x + 1, 0)
  const inflight = useRef([]) // { from, to, ops, at }
  const linksRef = useRef(links)
  linksRef.current = links
  const latencyRef = useRef(latency)
  latencyRef.current = latency

  const addLog = (text, kind = '') => setLog((l) => [{ id: Math.random(), text, kind, t: new Date() }, ...l].slice(0, 40))

  // Broadcast every local op to the other peers through the simulated network.
  useEffect(() => {
    const offs = replicas.map((r, i) =>
      r.on((ops, origin) => {
        force()
        if (origin !== 'local') return
        replicas.forEach((_, j) => {
          if (j === i) return
          // Random jitter reorders messages, so delivery is not FIFO.
          const at = performance.now() + latencyRef.current * (0.5 + Math.random())
          inflight.current.push({ from: i, to: j, ops, at })
        })
      }),
    )
    return () => offs.forEach((off) => off())
  }, [replicas])

  // Network clock: deliver due messages over live links; drop them on cut links.
  useEffect(() => {
    const t = setInterval(() => {
      const now = performance.now()
      const keep = []
      for (const m of inflight.current) {
        if (m.at > now) {
          keep.push(m)
          continue
        }
        if (linksRef.current[linkKey(m.from, m.to)]) {
          // Out-of-order ops wait in the replica's pending buffer (shown on each peer card).
          replicas[m.to].apply(m.ops)
        } else {
          addLog(`Dropped ${m.ops.length} op(s) ${PEERS[m.from].name} → ${PEERS[m.to].name} (partition)`, 'bad')
        }
      }
      inflight.current = keep
      force()
    }, 50)
    return () => clearInterval(t)
  }, [replicas])

  /** Anti-entropy between two peers: exchange state vectors, send diffs. */
  const antiEntropy = (a, b) => {
    const ra = replicas[a]
    const rb = replicas[b]
    const toB = ra.diff(rb.getStateVector())
    const toA = rb.diff(ra.getStateVector())
    if (toB === null || toA === null) {
      // history was GC'd; fall back to a snapshot
      rb.applySnapshot(ra.toSnapshot())
      ra.applySnapshot(rb.toSnapshot())
    } else {
      rb.apply(toB)
      ra.apply(toA)
    }
    addLog(`Anti-entropy ${PEERS[a].name} ↔ ${PEERS[b].name}: sent ${toB?.length ?? 'snapshot'} / ${toA?.length ?? 'snapshot'} missing op(s)`, 'ok')
  }

  const toggleLink = (a, b) => {
    const k = linkKey(a, b)
    const up = !links[k]
    setLinks({ ...links, [k]: up })
    if (up) {
      addLog(`Link ${PEERS[a].name} ↔ ${PEERS[b].name} healed`)
      antiEntropy(a, b)
    } else addLog(`Link ${PEERS[a].name} ↔ ${PEERS[b].name} partitioned`, 'bad')
  }

  const setAll = (up) => {
    setLinks(Object.fromEntries(LINKS.map(([a, b]) => [linkKey(a, b), up])))
    addLog(up ? 'All links healed' : 'All peers isolated', up ? '' : 'bad')
    if (up) LINKS.forEach(([a, b]) => antiEntropy(a, b))
  }

  const chaos = () => {
    replicas.forEach((r, i) => {
      for (let k = 0; k < 4; k++) {
        if (r.length && Math.random() < 0.3) r.delete(Math.floor(Math.random() * r.length), 1 + Math.floor(Math.random() * 3))
        else r.insert(Math.floor(Math.random() * (r.length + 1)), `${WORDS[Math.floor(Math.random() * WORDS.length)]} `)
      }
    })
    addLog('Every peer made 4 random concurrent edits', 'warn')
  }

  const vvs = replicas.map((r) => r.getStateVector())
  const texts = replicas.map((r) => r.toString())
  const sameVV = vvs.every((v) => JSON.stringify(sortObj(v)) === JSON.stringify(sortObj(vvs[0])))
  const converged = sameVV && texts.every((t) => t === texts[0]) && replicas.every((r) => r.pending.length === 0)
  const tombstones = replicas.reduce((n, r) => n + r.stats().tombstones, 0)

  const gc = () => {
    const stable = minVersionVector(vvs)
    const removed = replicas.map((r) => r.gc(stable))
    addLog(`Ran tombstone GC at a stable version vector: removed ${removed[0]} tombstone(s) per replica`, 'ok')
    force()
  }

  const reset = () => {
    inflight.current = []
    setReplicas(makeReplicas())
    setGen((g) => g + 1)
    setLinks(Object.fromEntries(LINKS.map(([a, b]) => [linkKey(a, b), true])))
    setLog([])
  }

  return (
    <div className="lab-page">
      <header className="lab-header">
        <div className="row gap">
          <Link to="/" className="btn ghost icon sm" title="Back">
            <ArrowLeft size={16} />
          </Link>
          <Logo />
          <span className="wordmark">CRDT Lab</span>
        </div>
        <div className="row gap">
          <ThemeToggle />
        <span className={`badge converge-pill ${converged ? 'ok' : 'warn'}`}>
          {converged ? <Check size={13} /> : <Loader size={13} />}
          {converged ? 'All replicas converged' : `Replicas diverged · ${inflight.current.length} in flight`}
        </span>
        </div>
      </header>

      <main className="lab-wrap">
        <section className="lab-intro">
          <h1>RGA sequence CRDT, built from scratch</h1>
          <p>
            Three replicas run in this tab on a simulated network. Every character is a node with a unique id{' '}
            <code>(site, seq)</code> and a Lamport timestamp, and a delete leaves a tombstone. Concurrent inserts at the
            same position are ordered by timestamp, then by site id, so every replica reaches the same order without
            locks. Cut the links, type on several peers, then heal them.
          </p>
        </section>

        <section className="card lab-controls">
          <div className="group">
            {LINKS.map(([a, b]) => {
              const up = links[linkKey(a, b)]
              return (
                <button key={linkKey(a, b)} className={`link-btn ${up ? 'up' : 'down'}`} onClick={() => toggleLink(a, b)} title={up ? 'Click to partition' : 'Click to heal'}>
                  {up ? <Link2 size={13} /> : <Unlink size={13} />}
                  {PEERS[a].name} – {PEERS[b].name}
                </button>
              )
            })}
            <span className="divider-v" />
            <button className="btn sm" onClick={() => setAll(false)}>Partition all</button>
            <button className="btn sm" onClick={() => setAll(true)}>Heal all</button>
          </div>
          <label className="latency">
            Latency
            <input type="range" min="0" max="3000" step="100" value={latency} onChange={(e) => setLatency(Number(e.target.value))} />
            <span className="mono small">{latency} ms ±50%</span>
          </label>
          <div className="group" style={{ marginLeft: 'auto' }}>
            <button className="btn sm" onClick={chaos}>
              <Shuffle size={13} /> Random concurrent edits
            </button>
            <button className="btn sm" onClick={gc} disabled={!converged || tombstones === 0} title="Only allowed once every replica holds an identical state">
              <Eraser size={13} /> GC tombstones ({tombstones})
            </button>
            <button className="btn ghost sm" onClick={reset}>
              <RotateCcw size={13} /> Reset
            </button>
          </div>
        </section>

        <section className="peers">
          {replicas.map((r, i) => (
            <PeerCard key={`${PEERS[i].site}-${gen}`} peer={PEERS[i]} rga={r} vv={vvs[i]} />
          ))}
        </section>

        <section className="card log-card">
          <div className="panel-head">
            <h2>Network log</h2>
            <div className="legend">
              <span><i style={{ background: 'var(--bg-muted)', border: '1px solid var(--border-strong)' }} /> live node</span>
              <span><i style={{ border: '1px dashed var(--border-strong)' }} /> tombstone</span>
            </div>
          </div>
          <ul className="net-log">
            {log.length === 0 && <li className="subtle">Type in any peer to start.</li>}
            {log.map((l) => (
              <li key={l.id} className={l.kind}>
                <time>{l.t.toLocaleTimeString()}</time> <span>{l.text}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  )
}

function PeerCard({ peer, rga, vv }) {
  const nodes = rga.toNodes()
  const stats = rga.stats()
  const shown = nodes.slice(0, 400)
  return (
    <div className="card peer-card">
      <div className="peer-head">
        <h3>
          <span className="dot" style={{ background: peer.color }} /> {peer.name}
        </h3>
        <span className="subtle small">
          {stats.visible} chars · {stats.tombstones} tombstones · {stats.pending} pending
        </span>
      </div>
      <RgaTextEditor rga={rga} compact placeholder={`Type as ${peer.name}…`} />
      <div className="vv">
        Version vector
        {Object.entries(sortObj(vv)).map(([s, n]) => (
          <code key={s} style={{ color: colorOf[s] }}>
            {s}:{n}
          </code>
        ))}
        {Object.keys(vv).length === 0 && <code>∅</code>}
      </div>
      <div className="rga-nodes" title="Internal RGA list: every node, including tombstones">
        {shown.map((n) => (
          <span
            key={n.id}
            className={`node ${n.deleted ? 'dead' : ''}`}
            style={{ '--c': colorOf[n.site] || '#71717a' }}
            title={`id ${n.id}\nlamport ${n.ts}\norigin ${n.origin}${n.deleted ? '\n(tombstone)' : ''}`}
          >
            {n.ch === ' ' ? '␣' : n.ch === '\n' ? '↵' : n.ch}
          </span>
        ))}
        {nodes.length > shown.length && <span className="subtle small">+{nodes.length - shown.length} more</span>}
        {nodes.length === 0 && <span className="subtle small">Empty list</span>}
      </div>
    </div>
  )
}

const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))
