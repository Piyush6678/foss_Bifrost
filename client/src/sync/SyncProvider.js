import { Observable } from 'lib0/observable'
import * as awarenessProtocol from 'y-protocols/awareness'
import { MSG, encodeMessage, decodeMessage, encodeJSON, decodeJSON } from '@collab/protocol'

const BATCH_MS = 50 // coalesce keystrokes into one frame
const PING_MS = 5_000
const ANTI_ENTROPY_MS = 10_000 // periodic state-vector exchange repairs any lost frame
const BACKOFF_MIN = 500
const BACKOFF_MAX = 10_000

/**
 * Our WebSocket sync provider. CRDT-agnostic: it talks to an adapter
 * (YjsAdapter | RgaAdapter) that turns state vectors / diffs / updates into
 * bytes. Nothing in here ever blocks local editing: when the socket is down,
 * edits just accumulate in the CRDT and the reconnect handshake ships the
 * difference.
 *
 * Events: 'status' ({status}), 'synced' (bool), 'readonly' (bool), 'metrics'.
 */
export class SyncProvider extends Observable {
  constructor({ url, docId, adapter, awareness, getToken }) {
    super()
    this.url = url
    this.docId = docId
    this.adapter = adapter
    this.awareness = awareness
    this.getToken = getToken
    this.ws = null
    this.status = 'disconnected'
    this.synced = false
    this.readOnly = false
    this.destroyed = false
    this.attempt = 0
    this.batch = []
    this.batchTimer = null
    this.timers = []
    this.reconnectTimer = null
    // network simulator (demo controls)
    this.sim = { offline: false, latencyMs: 0, dropRate: 0 }
    this.metrics = { framesOut: 0, framesIn: 0, bytesOut: 0, bytesIn: 0, dropped: 0, rtt: null, unsynced: 0, reconnects: 0 }

    this._offLocal = adapter.onLocalUpdate((update) => this._onLocalUpdate(update))
    awareness.on('update', this._onAwarenessUpdate)
    window.addEventListener('online', this._onOnline)
    window.addEventListener('offline', this._onOffline)
    window.addEventListener('beforeunload', this._onUnload)
  }

  // ---------------- connection lifecycle ----------------

  async connect() {
    if (this.destroyed || this.sim.offline || this.ws) return
    clearTimeout(this.reconnectTimer)
    this._setStatus('connecting')
    let token
    try {
      token = await this.getToken()
    } catch {
      return this._scheduleReconnect()
    }
    if (this.destroyed || this.sim.offline || this.ws) return
    const ws = new WebSocket(`${this.url}/sync/${this.docId}?token=${encodeURIComponent(token)}`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      this._setStatus('connected')
      this._sendNow(encodeMessage(MSG.SYNC_STEP1, this.adapter.stateVector()))
      if (this.awareness.getLocalState()) {
        this._sendNow(encodeMessage(MSG.AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.awareness.clientID])))
      }
      this.timers = [
        setInterval(() => this._send(encodeMessage(MSG.PING, encodeJSON(performance.now()))), PING_MS),
        setInterval(() => this._send(encodeMessage(MSG.SYNC_STEP1, this.adapter.stateVector())), ANTI_ENTROPY_MS),
      ]
    }

    ws.onmessage = (ev) => {
      const data = new Uint8Array(ev.data)
      const deliver = () => this._onMessage(data)
      if (this.sim.latencyMs) setTimeout(deliver, this.sim.latencyMs)
      else deliver()
    }

    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      this.timers.forEach(clearInterval)
      this.timers = []
      this._setSynced(false)
      // Remote presence is stale once we are cut off.
      const remote = [...this.awareness.getStates().keys()].filter((id) => id !== this.awareness.clientID)
      awarenessProtocol.removeAwarenessStates(this.awareness, remote, this)
      if (ev.code === 4404) {
        this._setStatus('deleted')
        return
      }
      this._setStatus(this.sim.offline || !navigator.onLine ? 'offline' : 'disconnected')
      this._scheduleReconnect()
    }
    ws.onerror = () => {}
  }

  disconnect() {
    clearTimeout(this.reconnectTimer)
    if (this.ws) {
      const ws = this.ws
      ws.onclose({ code: 1000 }) // run cleanup synchronously
      ws.close()
    }
  }

  _scheduleReconnect() {
    if (this.destroyed || this.sim.offline || !navigator.onLine) return
    clearTimeout(this.reconnectTimer)
    const delay = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5)
    this.reconnectTimer = setTimeout(() => {
      this.metrics.reconnects++
      this.connect()
    }, delay)
  }

  _onOnline = () => {
    this.attempt = 0
    this.connect()
  }
  _onOffline = () => this.disconnect()
  _onUnload = () => awarenessProtocol.removeAwarenessStates(this.awareness, [this.awareness.clientID], 'local')

  // ---------------- incoming ----------------

  _onMessage(data) {
    this.metrics.framesIn++
    this.metrics.bytesIn += data.length
    let msg
    try {
      msg = decodeMessage(data)
    } catch {
      return
    }
    switch (msg.type) {
      case MSG.SYNC_STEP1:
        // Server asks what it is missing -> ship everything it lacks,
        // including every edit made while we were offline.
        if (!this.readOnly) {
          this._send(encodeMessage(MSG.SYNC_STEP2, this.adapter.diff(msg.payload)))
          this.metrics.unsynced = 0
        }
        break
      case MSG.SYNC_STEP2:
        this.adapter.applyRemote(msg.payload, this)
        this._setSynced(true)
        break
      case MSG.UPDATE:
        if (this.sim.dropRate && Math.random() < this.sim.dropRate) {
          this.metrics.dropped++
          break
        }
        this.adapter.applyRemote(msg.payload, this)
        break
      case MSG.AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(this.awareness, msg.payload, this)
        break
      case MSG.PONG:
        this.metrics.rtt = Math.round(performance.now() - decodeJSON(msg.payload))
        break
      case MSG.READ_ONLY:
        if (!this.readOnly) {
          this.readOnly = true
          this.emit('readonly', [true])
        }
        break
      case MSG.ERROR:
        console.warn('[sync] server error', decodeJSON(msg.payload))
        break
    }
    this.emit('metrics', [this.metrics])
  }

  // ---------------- outgoing ----------------

  _onLocalUpdate(update) {
    if (this.adapter.isEmpty(update)) return
    if (this.status !== 'connected' || this.readOnly) {
      // Nothing is lost: the CRDT already holds the change. The next
      // handshake computes and sends the diff.
      if (!this.readOnly) this.metrics.unsynced++
      this.emit('metrics', [this.metrics])
      return
    }
    this.batch.push(update)
    this.batchTimer ??= setTimeout(() => {
      this.batchTimer = null
      const merged = this.adapter.mergeUpdates(this.batch.splice(0))
      if (this.sim.dropRate && Math.random() < this.sim.dropRate) {
        this.metrics.dropped++ // anti-entropy will repair this
        return
      }
      this._send(encodeMessage(MSG.UPDATE, merged))
    }, BATCH_MS)
  }

  _onAwarenessUpdate = ({ added, updated, removed }, origin) => {
    if (origin !== 'local') return
    const changed = added.concat(updated, removed)
    this._send(encodeMessage(MSG.AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)))
  }

  _send(msg) {
    if (this.sim.latencyMs) setTimeout(() => this._sendNow(msg), this.sim.latencyMs)
    else this._sendNow(msg)
  }

  _sendNow(msg) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(msg)
    this.metrics.framesOut++
    this.metrics.bytesOut += msg.length
  }

  // ---------------- state ----------------

  setSim(patch) {
    const wasOffline = this.sim.offline
    this.sim = { ...this.sim, ...patch }
    if (this.sim.offline && !wasOffline) {
      this.disconnect()
      this._setStatus('offline')
    } else if (!this.sim.offline && wasOffline) {
      this.attempt = 0
      this.connect()
    }
    this.emit('sim', [this.sim])
  }

  /** Force a state-vector exchange right now (used by the demo "resync" button). */
  resync() {
    this._send(encodeMessage(MSG.SYNC_STEP1, this.adapter.stateVector()))
  }

  _setStatus(status) {
    if (this.status === status) return
    this.status = status
    this.emit('status', [{ status }])
  }

  _setSynced(synced) {
    if (this.synced === synced) return
    this.synced = synced
    this.emit('synced', [synced])
  }

  destroy() {
    this.destroyed = true
    this._onUnload()
    this.disconnect()
    clearTimeout(this.batchTimer)
    this._offLocal()
    this.awareness.off('update', this._onAwarenessUpdate)
    window.removeEventListener('online', this._onOnline)
    window.removeEventListener('offline', this._onOffline)
    window.removeEventListener('beforeunload', this._onUnload)
    super.destroy()
  }
}
