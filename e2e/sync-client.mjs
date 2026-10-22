// Headless test of the real client sync code (SyncProvider + adapters)
// against a running dev stack:  npm run dev  then  npm run e2e:sync
globalThis.window = new EventTarget()
const Y = await import('yjs')
const { Awareness } = await import('y-protocols/awareness')
const { RGA } = await import('@collab/rga-crdt')
const { SyncProvider } = await import('../client/src/sync/SyncProvider.js')
const { YjsAdapter, RgaAdapter } = await import('../client/src/crdt/adapters.js')

const BASE = process.env.APP_URL || 'http://localhost:5173'
const WS = BASE.replace(/^http/, 'ws')
const until = async (cond, label, ms = 15000) => {
  const t = Date.now()
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timeout: ' + label)
    await new Promise((r) => setTimeout(r, 20))
  }
  console.log('  ✓', label)
}
const api = async (path, body, token) => {
  const r = await fetch(BASE + '/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body && JSON.stringify(body),
  })
  return r.json()
}

const pw = crypto.randomUUID()
const { accessToken: token, user } = await api('/auth/signup', { name: 'E2E', email: `e2e-${Date.now()}@test.io`, password: pw })

function yjsPeer(docId) {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  awareness.setLocalStateField('user', { name: user.name, color: user.color, id: user.id })
  const provider = new SyncProvider({ url: WS, docId, adapter: new YjsAdapter(doc), awareness, getToken: async () => token })
  provider.connect()
  return { doc, awareness, provider, text: () => doc.getText('t').toString() }
}

console.log('Yjs document through the client SyncProvider')
const { doc } = await api('/docs', { type: 'doc', title: 'e2e' }, token)
const a = yjsPeer(doc.id)
const b = yjsPeer(doc.id)
await until(() => a.provider.synced && b.provider.synced, 'both providers connected + synced')
await until(() => a.awareness.getStates().size === 2 && b.awareness.getStates().size === 2, 'presence: each sees the other')

a.doc.getText('t').insert(0, 'hello')
await until(() => b.text() === 'hello', 'live update A → B (50 ms batching)')

a.provider.setSim({ offline: true })
await until(() => a.provider.status === 'offline', 'A offline via simulator')
await until(() => b.awareness.getStates().size === 1, "B no longer sees A's presence")
a.doc.getText('t').insert(5, ' from A offline')
b.doc.getText('t').insert(0, 'B online: ')
await until(() => a.provider.metrics.unsynced > 0, 'A counts unsent local changes')
a.provider.setSim({ offline: false })
await until(() => a.text() === b.text() && a.text() === 'B online: hello from A offline', 'reconnect handshake merges both sides')
await until(() => a.provider.metrics.unsynced === 0, 'unsent counter cleared')

b.provider.setSim({ dropRate: 0.9 })
for (let i = 0; i < 10; i++) b.doc.getText('t').insert(0, String(i))
await new Promise((r) => setTimeout(r, 400))
console.log('    B dropped', b.provider.metrics.dropped, 'frame(s); A has', a.text().length, 'chars, B has', b.text().length)
b.provider.setSim({ dropRate: 0 })
b.provider.resync()
a.provider.resync()
await until(() => a.text() === b.text(), 'anti-entropy repairs dropped frames')

console.log('RGA document through the client SyncProvider')
const { doc: tdoc } = await api('/docs', { type: 'text', title: 'e2e-rga' }, token)
const peers = ['x', 'y'].map((site) => {
  const rga = new RGA(site + Math.random().toString(36).slice(2, 6))
  const awareness = new Awareness(new Y.Doc())
  const provider = new SyncProvider({ url: WS, docId: tdoc.id, adapter: new RgaAdapter(rga), awareness, getToken: async () => token })
  provider.connect()
  return { rga, provider }
})
await until(() => peers.every((p) => p.provider.synced), 'RGA peers synced')
peers[0].rga.insert(0, 'abc')
await until(() => peers[1].rga.toString() === 'abc', 'RGA live update')
peers[1].provider.setSim({ offline: true })
peers[1].rga.insert(3, 'Z')
peers[0].rga.insert(3, 'Y')
peers[1].provider.setSim({ offline: false })
await until(() => peers[0].rga.toString() === peers[1].rga.toString() && peers[0].rga.length === 5, 'RGA concurrent offline inserts converge')

const m = await api(`/docs/${doc.id}/metrics`, null, token)
console.log('server metrics', JSON.stringify(m))
for (const p of [a, b, ...peers]) p.provider.destroy()
console.log('ALL CLIENT E2E CHECKS PASSED')
process.exit(0)
