// Server-side CRDT replicas. The server is just another peer: it merges every
// update it receives exactly like a client would, which is what lets it answer
// "what are you missing?" (sync step 2) for any reconnecting client.
//
// Both engines expose the same byte-oriented interface so Room never needs to
// know which CRDT backs a document:
//   stateVector()          -> Uint8Array
//   diff(remoteSV)         -> Uint8Array   (everything the remote is missing)
//   apply(update)          -> boolean      (false if the update was malformed)
//   isEmpty(update)        -> boolean
//   encodeSnapshot()       -> Uint8Array   (compact full state)
//   load(snapshot, updates)
//   stats()
import * as Y from 'yjs'
import { RGA } from '@collab/rga-crdt'
import { encodeJSON, decodeJSON } from '@collab/protocol'

export class YjsEngine {
  constructor() {
    // gc:true turns deleted content into tiny tombstone structs, so the doc
    // does not keep the text of everything ever deleted.
    this.doc = new Y.Doc({ gc: true })
  }

  load(snapshot, updates) {
    if (snapshot) Y.applyUpdate(this.doc, snapshot)
    for (const u of updates) Y.applyUpdate(this.doc, u)
  }

  stateVector() {
    return Y.encodeStateVector(this.doc)
  }

  diff(remoteSV) {
    return Y.encodeStateAsUpdate(this.doc, remoteSV?.length ? remoteSV : undefined)
  }

  apply(update) {
    try {
      Y.applyUpdate(this.doc, update, 'remote')
      return true
    } catch {
      return false
    }
  }

  // An encoded Yjs update with no structs and no deletes is exactly [0, 0].
  isEmpty(update) {
    return update.length <= 2
  }

  encodeSnapshot() {
    return Y.encodeStateAsUpdate(this.doc)
  }

  stats() {
    return { engine: 'yjs', stateBytes: Y.encodeStateAsUpdate(this.doc).length }
  }

  destroy() {
    this.doc.destroy()
  }
}

// Payloads for the RGA engine are JSON:
//   state vector: { site: seq }
//   update:       { ops: [...] }  or  { snapshot: {...} } when history was GC'd
export class RgaEngine {
  constructor() {
    this.rga = new RGA('server')
  }

  load(snapshot, updates) {
    if (snapshot) this.rga.applySnapshot(decodeJSON(snapshot), 'load')
    for (const u of updates) this._applyPayload(decodeJSON(u))
  }

  stateVector() {
    return encodeJSON(this.rga.getStateVector())
  }

  diff(remoteSV) {
    const vv = remoteSV?.length ? decodeJSON(remoteSV) : {}
    const ops = this.rga.diff(vv)
    return encodeJSON(ops ? { ops } : { snapshot: this.rga.toSnapshot() })
  }

  apply(update) {
    try {
      const payload = decodeJSON(update)
      if (!payload || (!Array.isArray(payload.ops) && !payload.snapshot)) return false
      this._applyPayload(payload)
      return true
    } catch {
      return false
    }
  }

  isEmpty(update) {
    try {
      const p = decodeJSON(update)
      return !p.snapshot && (!p.ops || p.ops.length === 0)
    } catch {
      return true
    }
  }

  _applyPayload(payload) {
    if (payload.snapshot) this.rga.applySnapshot(payload.snapshot)
    else this.rga.apply(payload.ops.filter(isValidOp))
  }

  encodeSnapshot() {
    return encodeJSON(this.rga.toSnapshot())
  }

  stats() {
    return { engine: 'rga', stateBytes: this.encodeSnapshot().length, ...this.rga.stats() }
  }

  destroy() {}
}

function isValidOp(op) {
  return (
    op &&
    (op.type === 'ins' || op.type === 'del') &&
    typeof op.site === 'string' &&
    !op.site.includes(':') &&
    Number.isInteger(op.seq) &&
    op.seq > 0 &&
    Number.isFinite(op.ts) &&
    (op.type === 'ins' ? typeof op.origin === 'string' && typeof op.ch === 'string' && op.ch.length === 1 : typeof op.target === 'string')
  )
}

export const createEngine = (engine) => (engine === 'rga' ? new RgaEngine() : new YjsEngine())
