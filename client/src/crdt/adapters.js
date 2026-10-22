// Adapters give SyncProvider one byte-level interface over either CRDT:
//   stateVector() / diff(sv) / applyRemote(update, origin)
//   onLocalUpdate(cb) / mergeUpdates(list) / isEmpty(update)
import * as Y from 'yjs'
import { encodeJSON, decodeJSON } from '@collab/protocol'

export class YjsAdapter {
  /** @param {Y.Doc} doc  @param {Set<any>} ignoreOrigins origins that are not user edits (e.g. IndexedDB load) */
  constructor(doc, ignoreOrigins = new Set()) {
    this.doc = doc
    this.ignoreOrigins = ignoreOrigins
    this.remoteOrigins = new Set()
  }
  stateVector() {
    return Y.encodeStateVector(this.doc)
  }
  diff(sv) {
    return Y.encodeStateAsUpdate(this.doc, sv)
  }
  applyRemote(update, origin) {
    this.remoteOrigins.add(origin)
    Y.applyUpdate(this.doc, update, origin)
  }
  onLocalUpdate(cb) {
    const handler = (update, origin) => {
      if (this.remoteOrigins.has(origin) || this.ignoreOrigins.has(origin)) return
      cb(update)
    }
    this.doc.on('update', handler)
    return () => this.doc.off('update', handler)
  }
  mergeUpdates(updates) {
    return updates.length === 1 ? updates[0] : Y.mergeUpdates(updates)
  }
  isEmpty(update) {
    return update.length <= 2
  }
  stateSize() {
    return Y.encodeStateAsUpdate(this.doc).length
  }
}

export class RgaAdapter {
  /** @param {import('@collab/rga-crdt').RGA} rga */
  constructor(rga) {
    this.rga = rga
  }
  stateVector() {
    return encodeJSON(this.rga.getStateVector())
  }
  diff(sv) {
    const ops = this.rga.diff(sv?.length ? decodeJSON(sv) : {})
    return encodeJSON(ops ? { ops } : { snapshot: this.rga.toSnapshot() })
  }
  applyRemote(update) {
    const payload = decodeJSON(update)
    if (payload.snapshot) this.rga.applySnapshot(payload.snapshot)
    else if (payload.ops) this.rga.apply(payload.ops)
  }
  onLocalUpdate(cb) {
    return this.rga.on((ops, origin) => {
      if (origin === 'local' && ops.length) cb(encodeJSON({ ops }))
    })
  }
  mergeUpdates(updates) {
    if (updates.length === 1) return updates[0]
    return encodeJSON({ ops: updates.flatMap((u) => decodeJSON(u).ops) })
  }
  isEmpty(update) {
    return update.length <= 10 && !decodeJSON(update).ops?.length
  }
  stateSize() {
    return encodeJSON(this.rga.toSnapshot()).length
  }
}
