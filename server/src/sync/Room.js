import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { MSG, encodeMessage, decodeMessage } from '@collab/protocol'
import { createEngine } from './engines.js'
import { DocSnapshot, DocUpdate } from '../models/Persistence.js'
import { config } from '../config.js'

/**
 * One live document. Holds an in-memory replica, the set of connected peers,
 * presence state, and the write-behind persistence queue.
 *
 * The room never locks anything or decides who "wins": every update is merged
 * by the CRDT and relayed, so the result is the same in whatever order peers
 * receive them.
 */
export class Room {
  constructor(docId, engineName) {
    this.docId = docId
    this.engineName = engineName
    this.engine = createEngine(engineName)
    this.conns = new Map() // ws -> { user, role, awarenessIds: Set<number> }

    // Presence uses the y-protocols Awareness data type (a tiny last-writer-wins
    // map keyed by client id). Only the data type is reused; transport is ours.
    this.awarenessDoc = new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.awarenessDoc)
    this.awareness.setLocalState(null) // the server is not a visible participant
    this.awareness.on('update', this._onAwarenessUpdate)

    // persistence state
    this.seq = 0 // last seq assigned to an update
    this.snapshotSeq = 0 // updates <= this are folded into the snapshot
    this.queue = [] // updates waiting to be written
    this.chain = Promise.resolve() // serialises flush/compact
    this.flushTimer = null
    this.idleTimer = null
    this.snapshotBytes = 0
    this.logBytes = 0
    this.compactions = 0
    this.lastCompactionAt = null
    this.updatesIn = 0
    this.compactQueued = false
  }

  static async load(docId, engineName) {
    const room = new Room(docId, engineName)
    const snap = await DocSnapshot.findOne({ docId })
    room.snapshotSeq = snap?.upToSeq ?? 0
    room.snapshotBytes = snap?.data?.length ?? 0
    room.compactions = snap?.compactions ?? 0
    const updates = await DocUpdate.find({ docId, seq: { $gt: room.snapshotSeq } }).sort({ seq: 1 })
    room.engine.load(snap ? toBytes(snap.data) : null, updates.map((u) => toBytes(u.data)))
    room.seq = updates.length ? updates[updates.length - 1].seq : room.snapshotSeq
    room.logBytes = updates.reduce((n, u) => n + u.data.length, 0)
    return room
  }

  // ---------------- connections ----------------

  addConn(ws, user, role) {
    this.conns.set(ws, { user, role, awarenessIds: new Set() })
    if (role === 'viewer') this._send(ws, encodeMessage(MSG.READ_ONLY))
    // Server opens the handshake too, so a client that only listens still
    // learns what it is missing and offers what the server is missing.
    this._send(ws, encodeMessage(MSG.SYNC_STEP1, this.engine.stateVector()))
    const states = this.awareness.getStates()
    if (states.size) {
      this._send(ws, encodeMessage(MSG.AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()])))
    }
  }

  removeConn(ws) {
    const conn = this.conns.get(ws)
    if (!conn) return
    this.conns.delete(ws)
    if (conn.awarenessIds.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...conn.awarenessIds], null)
  }

  handleMessage(ws, data) {
    const conn = this.conns.get(ws)
    if (!conn) return
    let msg
    try {
      msg = decodeMessage(data)
    } catch {
      return // ignore garbage frames
    }
    switch (msg.type) {
      case MSG.SYNC_STEP1:
        // Reply with exactly what the peer lacks, then ask for what we lack.
        this._send(ws, encodeMessage(MSG.SYNC_STEP2, this.engine.diff(msg.payload)))
        this._send(ws, encodeMessage(MSG.SYNC_STEP1, this.engine.stateVector()))
        break
      case MSG.SYNC_STEP2:
      case MSG.UPDATE:
        if (conn.role === 'viewer') {
          this._send(ws, encodeMessage(MSG.READ_ONLY))
          break
        }
        this._applyUpdate(msg.payload, ws)
        break
      case MSG.AWARENESS:
        try {
          awarenessProtocol.applyAwarenessUpdate(this.awareness, msg.payload, ws)
        } catch {
          /* malformed presence update */
        }
        break
      case MSG.PING:
        this._send(ws, encodeMessage(MSG.PONG, msg.payload))
        break
    }
  }

  _applyUpdate(update, origin) {
    if (this.engine.isEmpty(update)) return
    if (!this.engine.apply(update)) return
    this.updatesIn++
    // Offline edits arrive as SYNC_STEP2 and are relayed as ordinary updates.
    this.broadcast(encodeMessage(MSG.UPDATE, update), origin)
    this._persist(update)
  }

  _onAwarenessUpdate = ({ added, updated, removed }, origin) => {
    const conn = origin && this.conns.get(origin)
    if (conn) {
      added.forEach((id) => conn.awarenessIds.add(id))
      removed.forEach((id) => conn.awarenessIds.delete(id))
    }
    const changed = added.concat(updated, removed)
    if (!changed.length) return
    const msg = encodeMessage(MSG.AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed))
    this.broadcast(msg, origin)
  }

  broadcast(msg, except) {
    for (const ws of this.conns.keys()) if (ws !== except) this._send(ws, msg)
  }

  _send(ws, msg) {
    if (ws.readyState === 1) ws.send(msg, { binary: true })
  }

  // ---------------- persistence & compaction ----------------

  _persist(update) {
    this.queue.push(update)
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, config.flushIntervalMs)
    if (!this.compactQueued && this.seq + this.queue.length - this.snapshotSeq >= config.compactEvery) this.compact()
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.compact(), config.compactIdleMs)
  }

  /** Append queued updates to the log. */
  flush() {
    this.chain = this.chain.then(async () => {
      if (!this.queue.length) return
      const batch = this.queue.splice(0)
      const docs = batch.map((data) => ({ docId: this.docId, seq: ++this.seq, data: Buffer.from(data) }))
      try {
        await DocUpdate.insertMany(docs, { ordered: true })
        this.logBytes += batch.reduce((n, u) => n + u.length, 0)
      } catch (err) {
        console.error('[room] flush failed, will retry', err.message)
        this.seq -= docs.length
        this.queue.unshift(...batch)
      }
    })
    return this.chain
  }

  /**
   * Fold the update log into a single snapshot and delete the folded entries.
   * Order matters for crash safety without transactions: the snapshot is
   * written first, so a crash before the delete only leaves duplicates, and
   * replaying a CRDT update twice is a no-op.
   */
  compact() {
    this.flush()
    this.compactQueued = true
    this.chain = this.chain.then(async () => {
      this.compactQueued = false
      if (this.seq === this.snapshotSeq) return
      const upToSeq = this.seq
      const data = Buffer.from(this.engine.encodeSnapshot())
      try {
        await DocSnapshot.updateOne(
          { docId: this.docId },
          { $set: { data, upToSeq }, $inc: { compactions: 1 } },
          { upsert: true },
        )
        await DocUpdate.deleteMany({ docId: this.docId, seq: { $lte: upToSeq } })
        this.snapshotSeq = upToSeq
        this.snapshotBytes = data.length
        this.logBytes = 0
        this.compactions++
        this.lastCompactionAt = new Date()
      } catch (err) {
        console.error('[room] compaction failed', err.message)
      }
    })
    return this.chain
  }

  metrics() {
    const users = [...this.conns.values()].map((c) => c.user.name)
    return {
      engine: this.engineName,
      connections: this.conns.size,
      users,
      updatesIn: this.updatesIn,
      logEntries: this.seq - this.snapshotSeq + this.queue.length,
      logBytes: this.logBytes + this.queue.reduce((n, u) => n + u.length, 0),
      snapshotBytes: this.snapshotBytes,
      compactions: this.compactions,
      lastCompactionAt: this.lastCompactionAt,
      ...this.engine.stats(),
    }
  }

  async close() {
    clearTimeout(this.flushTimer)
    clearTimeout(this.idleTimer)
    await this.compact()
    this.awareness.destroy()
    this.awarenessDoc.destroy()
    this.engine.destroy()
  }
}

const toBytes = (buf) => new Uint8Array(buf)
