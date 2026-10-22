import { Room } from './Room.js'
import { config } from '../config.js'

/** Loads rooms on demand, shares them between connections, unloads idle ones. */
export class RoomManager {
  constructor() {
    this.rooms = new Map() // docId -> Room
    this.loading = new Map() // docId -> Promise<Room>
    this.unloadTimers = new Map()
    this.closing = new Map() // docId -> Promise (final flush of an unloading room)
  }

  async get(docId, engine) {
    docId = docId.toString()
    this._cancelUnload(docId)
    if (this.rooms.has(docId)) return this.rooms.get(docId)
    if (!this.loading.has(docId)) {
      // Never load while the previous instance is still writing its final
      // state, or the new room would miss the tail of the update log.
      const p = Promise.resolve(this.closing.get(docId))
        .then(() => Room.load(docId, engine))
        .then((room) => {
          this.rooms.set(docId, room)
          return room
        })
        .finally(() => this.loading.delete(docId))
      this.loading.set(docId, p)
    }
    return this.loading.get(docId)
  }

  /** Run fn against a room (loading it if needed) from REST handlers. */
  async withRoom(docId, engine, fn) {
    const room = await this.get(docId, engine)
    try {
      return await fn(room)
    } finally {
      this.release(room)
    }
  }

  release(room) {
    if (room.conns.size) return
    this._cancelUnload(room.docId)
    this.unloadTimers.set(
      room.docId,
      setTimeout(async () => {
        this.unloadTimers.delete(room.docId)
        if (room.conns.size) return
        this.rooms.delete(room.docId)
        await this._close(room)
      }, config.roomUnloadMs),
    )
  }

  /** Called when a document is deleted. */
  async drop(docId) {
    docId = docId.toString()
    this._cancelUnload(docId)
    const room = this.rooms.get(docId)
    if (!room) return
    this.rooms.delete(docId)
    for (const ws of room.conns.keys()) ws.close(4404, 'document deleted')
    room.queue = []
    room.awareness.destroy()
    room.engine.destroy()
  }

  _close(room) {
    const p = room.close().finally(() => this.closing.delete(room.docId))
    this.closing.set(room.docId, p)
    return p
  }

  _cancelUnload(docId) {
    clearTimeout(this.unloadTimers.get(docId))
    this.unloadTimers.delete(docId)
  }

  async closeAll() {
    for (const t of this.unloadTimers.values()) clearTimeout(t)
    this.unloadTimers.clear()
    const rooms = [...this.rooms.values()]
    this.rooms.clear()
    await Promise.all([...rooms.map((r) => this._close(r)), ...this.closing.values()])
  }
}
