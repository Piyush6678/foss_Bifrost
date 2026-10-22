// Builds everything a live document needs: the CRDT replica, local
// persistence, presence and the sync provider, wired in the right order
// (load from IndexedDB first, then connect, so the handshake diff includes
// everything we edited offline).
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { Awareness } from 'y-protocols/awareness'
import { RGA } from '@collab/rga-crdt'
import { SyncProvider } from '../sync/SyncProvider.js'
import { persistRga } from '../sync/rgaStore.js'
import { YjsAdapter, RgaAdapter } from './adapters.js'
import { freshToken } from '../api/client.js'

const wsBase = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`

const randomSite = () => Math.random().toString(36).slice(2, 10)

export function createSession({ docId, engine, user }) {
  let ydoc = null
  let rga = null
  let persistence
  let adapter
  let ready

  if (engine === 'rga') {
    // One site id per tab: two tabs must never share a per-site op counter.
    rga = new RGA(randomSite())
    const p = persistRga(docId, rga)
    persistence = p
    ready = p.ready
    adapter = new RgaAdapter(rga)
  } else {
    ydoc = new Y.Doc({ gc: true })
    const idb = new IndexeddbPersistence(`collab-${docId}`, ydoc)
    persistence = idb
    ready = idb.whenSynced
    adapter = new YjsAdapter(ydoc, new Set([idb]))
  }

  const awareness = new Awareness(ydoc ?? new Y.Doc())
  awareness.setLocalStateField('user', { name: user.name, color: user.color, id: user.id })

  const provider = new SyncProvider({ url: wsBase(), docId, adapter, awareness, getToken: freshToken })
  ready.then(() => provider.connect())

  return {
    engine,
    ydoc,
    rga,
    awareness,
    provider,
    adapter,
    ready,
    destroy() {
      provider.destroy()
      awareness.destroy()
      persistence.destroy()
      ydoc?.destroy()
    },
  }
}
