import { useEffect, useState, useSyncExternalStore } from 'react'
import { createSession } from './session.js'

/** Create (and tear down) a live CRDT session for one document. */
export function useSession(doc, user) {
  const [session, setSession] = useState(null)
  useEffect(() => {
    if (!doc || !user) return
    const s = createSession({ docId: doc.id, engine: doc.engine, user })
    let alive = true
    s.ready.then(() => alive && setSession(s))
    return () => {
      alive = false
      setSession(null)
      s.destroy()
    }
  }, [doc?.id, doc?.engine, user?.id])
  return session
}

/** Connection status, sync flag, read-only flag and metrics of a provider. */
export function useProviderState(provider) {
  const [state, setState] = useState(() => snapshot(provider))
  useEffect(() => {
    if (!provider) return
    const update = () => setState(snapshot(provider))
    update()
    const events = ['status', 'synced', 'readonly', 'metrics', 'sim']
    events.forEach((e) => provider.on(e, update))
    return () => events.forEach((e) => provider.off(e, update))
  }, [provider])
  return state
}

const snapshot = (p) =>
  p
    ? { status: p.status, synced: p.synced, readOnly: p.readOnly, metrics: { ...p.metrics }, sim: { ...p.sim } }
    : { status: 'connecting', synced: false, readOnly: false, metrics: {}, sim: {} }

/** All awareness states as [{ clientId, ...state }], including our own. */
export function usePresence(awareness) {
  const subscribe = (cb) => {
    if (!awareness) return () => {}
    awareness.on('change', cb)
    return () => awareness.off('change', cb)
  }
  const getSnapshot = () => (awareness ? cacheStates(awareness) : EMPTY)
  return useSyncExternalStore(subscribe, getSnapshot)
}

const EMPTY = []
const cache = new WeakMap()
function cacheStates(awareness) {
  // useSyncExternalStore needs a stable reference until something changes.
  const states = awareness.getStates()
  const key = JSON.stringify([...states.entries()])
  const hit = cache.get(awareness)
  if (hit && hit.key === key) return hit.value
  const value = [...states.entries()].filter(([, s]) => s?.user).map(([clientId, s]) => ({ clientId, ...s, self: clientId === awareness.clientID }))
  cache.set(awareness, { key, value })
  return value
}
