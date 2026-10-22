// IndexedDB persistence for RGA documents. Stores one compact snapshot per
// doc. Before every save we merge whatever is already stored, so two tabs of
// the same browser editing offline never overwrite each other's changes.

const DB_NAME = 'collab-rga'
const STORE = 'docs'
let dbPromise = null

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = fn(t.objectStore(STORE))
        t.oncomplete = () => resolve(req?.result)
        t.onerror = () => reject(t.error)
      }),
  )
}

export const loadSnapshot = (docId) => tx('readonly', (s) => s.get(docId))
export const saveSnapshot = (docId, snap) => tx('readwrite', (s) => s.put(snap, docId))

/** Bind an RGA replica to IndexedDB. Returns { ready, destroy }. */
export function persistRga(docId, rga) {
  let timer = null
  let destroyed = false

  const save = async () => {
    timer = null
    try {
      const stored = await loadSnapshot(docId)
      if (stored) rga.applySnapshot(stored, 'idb')
      await saveSnapshot(docId, rga.toSnapshot())
    } catch (err) {
      console.warn('[rga] could not persist', err)
    }
  }

  const ready = loadSnapshot(docId)
    .then((snap) => {
      if (snap && !destroyed) rga.applySnapshot(snap, 'idb')
    })
    .catch(() => {})

  const off = rga.on((ops, origin) => {
    if (origin === 'idb' || destroyed) return
    clearTimeout(timer)
    timer = setTimeout(save, 300)
  })

  return {
    ready,
    destroy: () => {
      destroyed = true
      off()
      if (timer) {
        clearTimeout(timer)
        save()
      }
    },
  }
}
