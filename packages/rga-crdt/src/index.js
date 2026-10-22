// A from-scratch RGA (Replicated Growable Array) sequence CRDT.
//
// Reference: Roh et al., "Replicated abstract data types: Building blocks for
// collaborative applications" (2011); Shapiro et al., "Conflict-free Replicated
// Data Types" (2011).
//
// Model
//  - Every character is a node with a globally unique id `${site}:${seq}`, where
//    `seq` is a per-site contiguous counter and `ts` is a Lamport timestamp.
//  - Nodes form a linked list. Deleted nodes stay as tombstones so that
//    concurrent inserts that reference them can still be positioned.
//  - An insert names its `origin` (the node it was typed after). To integrate,
//    we walk right from the origin skipping every node that is "greater"
//    (higher ts, ties broken by site). That rule makes concurrent inserts at the
//    same position land in the same order on every replica.
//  - Delivery is causal: an op is buffered until the previous op from the same
//    site and the node it references are present. Duplicates are ignored, so
//    ops can be re-sent freely (idempotent, commutative, associative merge).
//  - There is no separate op log: the node list *is* the compacted log. Any
//    diff for a remote version vector is derived from the nodes themselves.

export const HEAD = '_head'

const idOf = (site, seq) => `${site}:${seq}`

// a > b in the RGA total order
const greater = (a, b) => a.ts > b.ts || (a.ts === b.ts && a.site > b.site)

export class RGA {
  /** @param {string} site unique replica id */
  constructor(site) {
    if (!site || site.includes(':')) throw new Error('site id must be a non-empty string without ":"')
    this.site = site
    this.clock = 0 // Lamport clock
    this.seq = 0 // own per-site op counter
    this.vv = {} // version vector: site -> highest contiguous seq integrated
    this.head = { id: HEAD, ts: Infinity, site: '', next: null, prev: null, deleted: true }
    this.nodes = new Map([[HEAD, this.head]])
    this.pending = [] // ops waiting for causal dependencies
    this.visibleLength = 0
    this.tombstones = 0
    this.gcBase = null // version vector at the last tombstone GC, if any
    this.listeners = new Set()
  }

  // ---------- local editing (visible-index API) ----------

  /** Insert `text` so that its first char ends up at visible `index`. */
  insert(index, text) {
    if (!text) return []
    let origin = index <= 0 ? HEAD : this._visibleNodeAt(index - 1).id
    const ops = []
    // Iterate UTF-16 code units so indices line up with DOM selection offsets.
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      const op = { type: 'ins', site: this.site, seq: ++this.seq, ts: ++this.clock, origin, ch }
      this._integrate(op)
      ops.push(op)
      origin = idOf(op.site, op.seq)
    }
    this._emit(ops, 'local')
    return ops
  }

  /** Delete `length` visible chars starting at visible `index`. */
  delete(index, length = 1) {
    const targets = []
    let node = index <= 0 ? this.head : this._visibleNodeAt(index - 1)
    while (targets.length < length && (node = node.next)) {
      if (!node.deleted) targets.push(node.id)
    }
    const ops = targets.map((target) => {
      const op = { type: 'del', site: this.site, seq: ++this.seq, ts: ++this.clock, target }
      this._integrate(op)
      return op
    })
    if (ops.length) this._emit(ops, 'local')
    return ops
  }

  // ---------- remote ops ----------

  /**
   * Apply remote ops in any order, with duplicates allowed. Returns the ops
   * that were integrated now; the rest wait in `pending` for their causal deps.
   */
  apply(ops, origin = 'remote') {
    for (const op of ops) {
      if (op.seq > (this.vv[op.site] || 0)) this.pending.push(op)
    }
    const applied = []
    let progress = true
    while (progress && this.pending.length) {
      progress = false
      const still = []
      for (const op of this.pending) {
        const have = this.vv[op.site] || 0
        if (op.seq <= have) continue // duplicate
        if (this._ready(op, have)) {
          this._integrate(op)
          applied.push(op)
          progress = true
        } else {
          still.push(op)
        }
      }
      this.pending = still
    }
    if (applied.length) this._emit(applied, origin)
    return applied
  }

  _ready(op, have) {
    if (op.seq !== have + 1) return false
    const dep = op.type === 'ins' ? op.origin : op.target
    return this.nodes.has(dep)
  }

  _integrate(op) {
    this.clock = Math.max(this.clock, op.ts)
    this.vv[op.site] = Math.max(this.vv[op.site] || 0, op.seq)
    if (op.site === this.site) this.seq = Math.max(this.seq, op.seq) // reloaded own history
    if (op.type === 'ins') {
      const node = {
        id: idOf(op.site, op.seq),
        site: op.site,
        seq: op.seq,
        ts: op.ts,
        ch: op.ch,
        origin: op.origin,
        deleted: false,
        delOp: null,
        next: null,
        prev: null,
      }
      let prev = this.nodes.get(op.origin)
      let next = prev.next
      while (next && greater(next, node)) {
        prev = next
        next = next.next
      }
      node.prev = prev
      node.next = next
      prev.next = node
      if (next) next.prev = node
      this.nodes.set(node.id, node)
      this.visibleLength++
    } else {
      const node = this.nodes.get(op.target)
      // A concurrent second delete of the same node is still recorded so the
      // per-site seq stays contiguous, but only the first one flips the flag.
      if (!node.deleted) {
        node.deleted = true
        node.delOp = { site: op.site, seq: op.seq, ts: op.ts }
        this.visibleLength--
        this.tombstones++
      } else {
        ;(node.extraDels ||= []).push({ site: op.site, seq: op.seq, ts: op.ts })
      }
    }
  }

  // ---------- sync ----------

  getStateVector() {
    return { ...this.vv }
  }

  /**
   * Every op the holder of `remoteVV` is missing, in causal (ts) order.
   * Returns null when tombstone GC removed history the remote still needs;
   * the caller should send `toSnapshot()` instead.
   */
  diff(remoteVV = {}) {
    if (this.gcBase && !dominates(remoteVV, this.gcBase)) return null
    const missing = (site, seq) => seq > (remoteVV[site] || 0)
    const ops = []
    for (let n = this.head.next; n; n = n.next) {
      if (missing(n.site, n.seq)) ops.push({ type: 'ins', site: n.site, seq: n.seq, ts: n.ts, origin: n.origin, ch: n.ch })
      const dels = n.delOp ? [n.delOp, ...(n.extraDels || [])] : []
      for (const d of dels) {
        if (missing(d.site, d.seq)) ops.push({ type: 'del', site: d.site, seq: d.seq, ts: d.ts, target: n.id })
      }
    }
    // Ops whose delete targets were garbage-collected never reach here (GC only
    // runs once every peer has them). Sorting by ts yields a causal order.
    ops.sort((a, b) => a.ts - b.ts || (a.site < b.site ? -1 : a.site > b.site ? 1 : 0))
    return ops
  }

  // ---------- tombstone GC ----------

  /**
   * Physically drop tombstones. Only safe when every replica that will ever
   * send ops again has integrated exactly the same state (`stableVV` equals the
   * version vector of all peers). Under that condition every future op has a
   * larger Lamport ts than all existing nodes, so removed nodes could never
   * have influenced where it lands, and nobody can reference a deleted node.
   */
  gc(stableVV) {
    if (!dominates(stableVV, this.vv) || !dominates(this.vv, stableVV)) {
      throw new Error('gc requires the local state to equal the stable version vector')
    }
    let removed = 0
    for (let n = this.head.next; n; ) {
      const next = n.next
      if (n.deleted) {
        n.prev.next = next
        if (next) next.prev = n.prev
        this.nodes.delete(n.id)
        removed++
      }
      n = next
    }
    // Surviving nodes may name a removed origin; repoint to the previous
    // surviving node so a snapshot loaded elsewhere is self-consistent.
    for (let n = this.head.next; n; n = n.next) {
      if (!this.nodes.has(n.origin)) n.origin = n.prev.id
    }
    this.tombstones = 0
    this.gcBase = { ...this.vv }
    return removed
  }

  // ---------- snapshots (compact persistence) ----------

  toSnapshot() {
    const nodes = []
    for (let n = this.head.next; n; n = n.next) {
      const row = [n.site, n.seq, n.ts, n.ch, n.origin]
      if (n.delOp) row.push([n.delOp, ...(n.extraDels || [])].map((d) => [d.site, d.seq, d.ts]))
      nodes.push(row)
    }
    return { v: 1, vv: { ...this.vv }, clock: this.clock, gcBase: this.gcBase, nodes }
  }

  /**
   * Merge a snapshot. An empty replica (or one strictly behind a GC'd
   * snapshot) adopts the snapshot's list as-is; otherwise its ops are replayed
   * through the normal causal pipeline, which makes the merge idempotent.
   */
  applySnapshot(snap, origin = 'remote') {
    const empty = this.head.next === null && this.pending.length === 0
    if (snap.gcBase && (empty || !dominates(this.vv, snap.gcBase))) {
      if (!empty && !dominates(snap.vv, this.vv)) {
        throw new Error('cannot merge local edits into a garbage-collected snapshot')
      }
      this._loadList(snap)
      this._emit([], origin)
      return
    }
    const ops = []
    for (const [site, seq, ts, ch, orig, dels] of snap.nodes) {
      ops.push({ type: 'ins', site, seq, ts, origin: orig, ch })
      for (const [ds, dq, dt] of dels || []) ops.push({ type: 'del', site: ds, seq: dq, ts: dt, target: idOf(site, seq) })
    }
    ops.sort((a, b) => a.ts - b.ts)
    this.apply(ops, origin)
  }

  _loadList(snap) {
    this.head.next = null
    this.nodes = new Map([[HEAD, this.head]])
    this.visibleLength = 0
    this.tombstones = 0
    let prev = this.head
    for (const [site, seq, ts, ch, origin, dels] of snap.nodes) {
      const node = { id: idOf(site, seq), site, seq, ts, ch, origin, deleted: false, delOp: null, next: null, prev }
      if (dels?.length) {
        const [first, ...rest] = dels.map(([s, q, t]) => ({ site: s, seq: q, ts: t }))
        node.deleted = true
        node.delOp = first
        if (rest.length) node.extraDels = rest
        this.tombstones++
      } else {
        this.visibleLength++
      }
      prev.next = node
      prev = node
      this.nodes.set(node.id, node)
    }
    this.vv = { ...snap.vv }
    this.clock = Math.max(this.clock, snap.clock)
    this.seq = Math.max(this.seq, this.vv[this.site] || 0)
    this.gcBase = snap.gcBase ? { ...snap.gcBase } : null
    this.pending = []
  }

  static fromSnapshot(site, snap) {
    const r = new RGA(site)
    r.applySnapshot(snap, 'load')
    r.seq = Math.max(r.seq, r.vv[site] || 0)
    return r
  }

  // ---------- reading ----------

  toString() {
    let s = ''
    for (let n = this.head.next; n; n = n.next) if (!n.deleted) s += n.ch
    return s
  }

  get length() {
    return this.visibleLength
  }

  /** Full internal list including tombstones (for visualisation). */
  toNodes() {
    const out = []
    for (let n = this.head.next; n; n = n.next) {
      out.push({ id: n.id, site: n.site, ts: n.ts, ch: n.ch, deleted: n.deleted, origin: n.origin })
    }
    return out
  }

  // ---------- stable positions (cursors that survive concurrent edits) ----------

  /** Id of the node just left of visible `index` (HEAD for 0). */
  positionAt(index) {
    return index <= 0 ? HEAD : this._visibleNodeAt(index - 1).id
  }

  /** Current visible index for a position produced by `positionAt`. */
  indexOfPosition(id) {
    if (id === HEAD) return 0
    const target = this.nodes.get(id)
    if (!target) return 0
    let i = 0
    for (let n = this.head.next; n; n = n.next) {
      if (!n.deleted) i++
      if (n === target) return i
    }
    return i
  }

  _visibleNodeAt(index) {
    let i = -1
    let last = this.head
    for (let n = this.head.next; n; n = n.next) {
      if (!n.deleted) {
        last = n
        if (++i === index) return n
      }
    }
    return last // clamp past the end
  }

  // ---------- events ----------

  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  _emit(ops, origin) {
    for (const fn of this.listeners) fn(ops, origin)
  }

  stats() {
    return { visible: this.visibleLength, tombstones: this.tombstones, nodes: this.nodes.size - 1, pending: this.pending.length }
  }
}

/** true if version vector `a` has seen everything in `b` */
export function dominates(a = {}, b = {}) {
  for (const [site, seq] of Object.entries(b)) if ((a[site] || 0) < seq) return false
  return true
}

/** element-wise minimum: what every listed replica has seen */
export function minVersionVector(vvs) {
  if (!vvs.length) return {}
  const sites = new Set(vvs.flatMap((v) => Object.keys(v)))
  const out = {}
  for (const s of sites) out[s] = Math.min(...vvs.map((v) => v[s] || 0))
  return out
}

/**
 * Turn a plain-text edit (old -> new) into a minimal splice using the common
 * prefix/suffix. Used by textarea bindings to translate DOM input into ops.
 */
export function diffText(oldText, newText) {
  let start = 0
  const minLen = Math.min(oldText.length, newText.length)
  while (start < minLen && oldText[start] === newText[start]) start++
  let endOld = oldText.length
  let endNew = newText.length
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
    endOld--
    endNew--
  }
  return { index: start, deleteCount: endOld - start, insert: newText.slice(start, endNew) }
}
