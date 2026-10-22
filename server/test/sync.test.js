// End-to-end tests of the sync server: real HTTP + WebSocket + MongoDB
// (in-memory), with headless Yjs / RGA clients speaking our protocol.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { RGA } from '@collab/rga-crdt'
import { MSG, encodeMessage, decodeMessage, encodeJSON, decodeJSON } from '@collab/protocol'
import { config } from '../src/config.js'
import { connectDb, disconnectDb } from '../src/db.js'
import { createApp } from '../src/app.js'
import { RoomManager } from '../src/sync/RoomManager.js'
import { attachSyncServer } from '../src/sync/wsServer.js'
import { DocUpdate } from '../src/models/Persistence.js'

config.compactEvery = 25
config.compactIdleMs = 60_000
config.roomUnloadMs = 50

let server, wss, rooms, base

before(async () => {
  await connectDb(process.env.MONGO_URI || '')
  rooms = new RoomManager()
  server = http.createServer(createApp(rooms))
  wss = attachSyncServer(server, rooms)
  await new Promise((r) => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  for (const ws of wss.clients) ws.terminate()
  wss.close()
  await rooms.closeAll()
  server.close()
  await disconnectDb()
})

// ---------- helpers ----------

async function req(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

let n = 0
async function user() {
  const { body } = await req('/api/auth/signup', {
    method: 'POST',
    body: { name: `U${++n}`, email: `u${n}-${Date.now()}@test.io`, password: 'secret123' },
  })
  return body.accessToken
}

const until = async (cond, ms = 3000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 15))
  }
}

/** Minimal headless peer: a CRDT replica + our sync protocol over ws. */
class Peer {
  constructor(docId, token, engine = 'yjs') {
    this.docId = docId
    this.token = token
    this.engine = engine
    this.readOnly = false
    if (engine === 'yjs') {
      this.doc = new Y.Doc()
      this.doc.on('update', (u, origin) => origin !== this && this.ws?.readyState === 1 && this.send(MSG.UPDATE, u))
    } else {
      this.rga = new RGA(`s${Math.random().toString(36).slice(2, 8)}`)
      this.rga.on((ops, origin) => origin === 'local' && this.ws?.readyState === 1 && this.send(MSG.UPDATE, encodeJSON({ ops })))
    }
  }
  sv() {
    return this.engine === 'yjs' ? Y.encodeStateVector(this.doc) : encodeJSON(this.rga.getStateVector())
  }
  diff(sv) {
    if (this.engine === 'yjs') return Y.encodeStateAsUpdate(this.doc, sv)
    return encodeJSON({ ops: this.rga.diff(decodeJSON(sv)) })
  }
  apply(u) {
    if (this.engine === 'yjs') Y.applyUpdate(this.doc, u, this)
    else {
      const p = decodeJSON(u)
      p.snapshot ? this.rga.applySnapshot(p.snapshot) : this.rga.apply(p.ops)
    }
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.synced = false
      const ws = new WebSocket(`${base.replace('http', 'ws')}/sync/${this.docId}?token=${this.token}`)
      this.ws = ws
      ws.on('open', () => this.send(MSG.SYNC_STEP1, this.sv()))
      ws.on('message', (data) => {
        const { type, payload } = decodeMessage(new Uint8Array(data))
        if (type === MSG.SYNC_STEP1) this.send(MSG.SYNC_STEP2, this.diff(payload))
        else if (type === MSG.SYNC_STEP2) {
          this.apply(payload)
          this.synced = true
          resolve(this)
        } else if (type === MSG.UPDATE) this.apply(payload)
        else if (type === MSG.READ_ONLY) this.readOnly = true
      })
      ws.on('unexpected-response', (_, res) => reject(new Error(`HTTP ${res.statusCode}`)))
      ws.on('error', reject)
    })
  }
  send(type, payload) {
    this.ws.send(encodeMessage(type, payload))
  }
  disconnect() {
    this.ws.close()
    return new Promise((r) => this.ws.once('close', r))
  }
  get text() {
    return this.engine === 'yjs' ? this.doc.getText('t').toString() : this.rga.toString()
  }
}

async function newDoc(token, type = 'doc') {
  const { body } = await req('/api/docs', { method: 'POST', token, body: { type, title: 't' } })
  return body.doc
}

// ---------- tests ----------

test('rejects unauthenticated and unauthorised sockets', async () => {
  const owner = await user()
  const stranger = await user()
  const doc = await newDoc(owner)
  await assert.rejects(new Peer(doc.id, 'bad-token').connect(), /401/)
  await assert.rejects(new Peer(doc.id, stranger).connect(), /403/)
})

test('two Yjs peers converge in real time', async () => {
  const token = await user()
  const doc = await newDoc(token)
  const a = await new Peer(doc.id, token).connect()
  const b = await new Peer(doc.id, token).connect()
  a.doc.getText('t').insert(0, 'hello')
  await until(() => b.text === 'hello')
  b.doc.getText('t').insert(5, ' world')
  await until(() => a.text === 'hello world')
  await a.disconnect()
  await b.disconnect()
})

test('offline edits on both sides merge after reconnect', async () => {
  const token = await user()
  const doc = await newDoc(token)
  const a = await new Peer(doc.id, token).connect()
  const b = await new Peer(doc.id, token).connect()
  a.doc.getText('t').insert(0, 'base ')
  await until(() => b.text === 'base ')
  await a.disconnect()
  await b.disconnect()
  // concurrent edits while both are offline, at the same position
  a.doc.getText('t').insert(5, 'from-A ')
  b.doc.getText('t').insert(5, 'from-B ')
  await a.connect()
  await b.connect()
  await until(() => a.text === b.text && a.text.length === 'base from-A from-B '.length)
  assert.match(a.text, /^base (from-A from-B |from-B from-A )$/)
  await a.disconnect()
  await b.disconnect()
})

test('state survives a server restart and the log compacts', async () => {
  const token = await user()
  const doc = await newDoc(token)
  const a = await new Peer(doc.id, token).connect()
  for (let i = 0; i < 30; i++) a.doc.getText('t').insert(i, 'x')
  await until(() => rooms.rooms.get(doc.id)?.compactions >= 1)
  for (let i = 30; i < 60; i++) a.doc.getText('t').insert(i, 'x')
  await until(() => rooms.rooms.get(doc.id)?.updatesIn === 60)
  await a.disconnect()
  // simulate restart: unload every room (flush + compact) and reload from Mongo
  await rooms.closeAll()
  const logLeft = await DocUpdate.countDocuments({ docId: doc.id })
  assert.equal(logLeft, 0, 'log is folded into the snapshot on unload')
  const b = await new Peer(doc.id, token).connect()
  assert.equal(b.text, 'x'.repeat(60))
  const { body: m } = await req(`/api/docs/${doc.id}/metrics`, { token })
  assert.ok(m.compactions >= 2, `expected periodic + final compaction, got ${m.compactions}`)
  await b.disconnect()
})

test('viewers receive updates but cannot write', async () => {
  const owner = await user()
  const viewer = await user()
  const doc = await newDoc(owner)
  const { body: share } = await req(`/api/docs/${doc.id}/share`, { token: owner })
  await req(`/api/docs/${doc.id}/share`, { method: 'PATCH', token: owner, body: { shareRole: 'viewer' } })
  await req(`/api/docs/join/${share.shareToken}`, { method: 'POST', token: viewer })
  const o = await new Peer(doc.id, owner).connect()
  const v = await new Peer(doc.id, viewer).connect()
  assert.ok(v.readOnly)
  o.doc.getText('t').insert(0, 'owner text')
  await until(() => v.text === 'owner text')
  v.doc.getText('t').insert(0, 'HACK ')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(o.text, 'owner text')
  await o.disconnect()
  await v.disconnect()
})

test('RGA documents sync through the same server', async () => {
  const token = await user()
  const doc = await newDoc(token, 'text')
  assert.equal(doc.engine, 'rga')
  const a = await new Peer(doc.id, token, 'rga').connect()
  const b = await new Peer(doc.id, token, 'rga').connect()
  a.rga.insert(0, 'abc')
  await until(() => b.text === 'abc')
  await b.disconnect()
  b.rga.insert(3, '-offline')
  a.rga.delete(0, 1)
  await b.connect()
  await until(() => a.text === b.text && a.text === 'bc-offline')
  await a.disconnect()
  await b.disconnect()
  await rooms.closeAll()
  const c = await new Peer(doc.id, token, 'rga').connect()
  assert.equal(c.text, 'bc-offline')
  await c.disconnect()
})

test('version snapshots can be listed and fetched', async () => {
  const token = await user()
  const doc = await newDoc(token)
  const a = await new Peer(doc.id, token).connect()
  a.doc.getText('t').insert(0, 'v1 content')
  await until(() => rooms.rooms.get(doc.id)?.updatesIn === 1)
  const { status } = await req(`/api/docs/${doc.id}/versions`, { method: 'POST', token, body: { name: 'first' } })
  assert.equal(status, 201)
  const { body } = await req(`/api/docs/${doc.id}/versions`, { token })
  const { body: v } = await req(`/api/docs/${doc.id}/versions/${body.versions[0].id}`, { token })
  const restored = new Y.Doc()
  Y.applyUpdate(restored, Buffer.from(v.data, 'base64'))
  assert.equal(restored.getText('t').toString(), 'v1 content')
  await a.disconnect()
})
