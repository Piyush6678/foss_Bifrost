import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { RGA, diffText, minVersionVector } from '../src/index.js'

const sync = (a, b) => {
  a.apply(b.diff(a.getStateVector()))
  b.apply(a.diff(b.getStateVector()))
}

test('local insert and delete', () => {
  const r = new RGA('a')
  r.insert(0, 'hello')
  r.insert(5, ' world')
  r.delete(0, 1)
  r.insert(0, 'H')
  assert.equal(r.toString(), 'Hello world')
  assert.equal(r.length, 11)
})

test('concurrent inserts at the same position converge', () => {
  const a = new RGA('a')
  const b = new RGA('b')
  a.insert(0, 'ab')
  sync(a, b)
  a.insert(1, 'X')
  b.insert(1, 'Y')
  sync(a, b)
  assert.equal(a.toString(), b.toString())
  assert.equal(a.toString().length, 4)
})

test('concurrent typing runs do not interleave', () => {
  const a = new RGA('a')
  const b = new RGA('b')
  a.insert(0, 'hello')
  b.insert(0, 'world')
  sync(a, b)
  assert.equal(a.toString(), b.toString())
  assert.ok(['helloworld', 'worldhello'].includes(a.toString()))
})

test('delete concurrent with insert after the deleted char', () => {
  const a = new RGA('a')
  const b = new RGA('b')
  a.insert(0, 'abc')
  sync(a, b)
  a.delete(1, 1) // remove b
  b.insert(2, 'Z') // after b
  sync(a, b)
  assert.equal(a.toString(), 'aZc')
  assert.equal(b.toString(), 'aZc')
})

test('concurrent deletes of the same char', () => {
  const a = new RGA('a')
  const b = new RGA('b')
  a.insert(0, 'xyz')
  sync(a, b)
  a.delete(1, 1)
  b.delete(1, 1)
  sync(a, b)
  assert.equal(a.toString(), 'xz')
  assert.deepEqual(a.getStateVector(), b.getStateVector())
})

test('duplicate and out-of-order delivery is idempotent', () => {
  const a = new RGA('a')
  const ops = [...a.insert(0, 'abc'), ...a.delete(1, 1), ...a.insert(1, 'Q')]
  const b = new RGA('b')
  b.apply([...ops].reverse())
  b.apply(ops)
  assert.equal(b.toString(), a.toString())
  assert.equal(b.pending.length, 0)
})

test('snapshot round trip keeps tombstones and merges idempotently', () => {
  const a = new RGA('a')
  a.insert(0, 'snapshot')
  a.delete(0, 4)
  const snap = JSON.parse(JSON.stringify(a.toSnapshot()))
  const b = RGA.fromSnapshot('b', snap)
  assert.equal(b.toString(), 'shot')
  b.applySnapshot(snap)
  assert.equal(b.toString(), 'shot')
  assert.equal(b.stats().tombstones, 4)
})

test('own history reload keeps seq monotonic', () => {
  const a = new RGA('a')
  a.insert(0, 'abc')
  const a2 = RGA.fromSnapshot('a', a.toSnapshot())
  const ops = a2.insert(3, 'd')
  assert.equal(ops[0].seq, 4)
})

test('positions survive concurrent edits', () => {
  const a = new RGA('a')
  const b = new RGA('b')
  a.insert(0, 'hello world')
  sync(a, b)
  const cursor = a.positionAt(6) // before "world"
  b.insert(0, '>> ')
  sync(a, b)
  assert.equal(a.indexOfPosition(cursor), 9)
  b.delete(3, 6) // delete "hello " including the anchor char
  sync(a, b)
  assert.equal(a.indexOfPosition(cursor), 3)
})

test('tombstone gc at quiescence keeps convergence', () => {
  const peers = ['a', 'b', 'c'].map((s) => new RGA(s))
  peers[0].insert(0, 'garbage collected text')
  peers[1].apply(peers[0].diff({}))
  peers[2].apply(peers[0].diff({}))
  peers[1].delete(0, 8)
  for (const p of peers) p.apply(peers[1].diff(p.getStateVector()))
  const stable = minVersionVector(peers.map((p) => p.getStateVector()))
  for (const p of peers) assert.equal(p.gc(stable), 8)
  peers[0].insert(0, 'X')
  peers[2].insert(0, 'Y')
  peers[1].insert(peers[1].length, '!')
  for (const p of peers) for (const q of peers) if (p !== q) p.apply(q.diff(p.getStateVector()))
  const texts = peers.map((p) => p.toString())
  assert.equal(new Set(texts).size, 1)
  // fresh replica must bootstrap via snapshot after gc
  assert.equal(peers[0].diff({}), null)
  const fresh = RGA.fromSnapshot('d', peers[0].toSnapshot())
  assert.equal(fresh.toString(), texts[0])
})

test('diffText computes minimal splice', () => {
  assert.deepEqual(diffText('hello', 'hallo'), { index: 1, deleteCount: 1, insert: 'a' })
  assert.deepEqual(diffText('abc', 'abXc'), { index: 2, deleteCount: 0, insert: 'X' })
  assert.deepEqual(diffText('abc', 'a'), { index: 1, deleteCount: 2, insert: '' })
})

// ---------- property-based convergence ----------
// N replicas each perform random inserts/deletes while partitioned and only
// occasionally exchange random subsets of ops in random order. After a final
// full exchange every replica must hold an identical document.

const opArb = fc.record({
  peer: fc.nat(),
  kind: fc.constantFrom('ins', 'ins', 'del', 'sync'),
  pos: fc.nat(),
  text: fc.string({ minLength: 1, maxLength: 3 }),
  len: fc.integer({ min: 1, max: 3 }),
  other: fc.nat(),
})

test('property: random concurrent edits converge on all replicas', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 2, max: 5 }),
      fc.array(opArb, { minLength: 1, maxLength: 200 }),
      fc.infiniteStream(fc.boolean()),
      (n, script, coin) => {
        const peers = Array.from({ length: n }, (_, i) => new RGA(`p${i}`))
        const inbox = peers.map(() => [])
        for (const step of script) {
          const p = peers[step.peer % n]
          if (step.kind === 'ins') {
            const ops = p.insert(step.pos % (p.length + 1), step.text)
            peers.forEach((_, i) => i !== step.peer % n && inbox[i].push(...ops))
          } else if (step.kind === 'del' && p.length) {
            const ops = p.delete(step.pos % p.length, step.len)
            peers.forEach((_, i) => i !== step.peer % n && inbox[i].push(...ops))
          } else if (step.kind === 'sync') {
            // deliver a random, shuffled subset of the inbox (simulates lossy, reordering network)
            const i = step.other % n
            const deliver = []
            const keep = []
            for (const op of inbox[i]) (coin.next().value ? deliver : keep).push(op)
            deliver.reverse()
            peers[i].apply(deliver)
            inbox[i] = keep
          }
        }
        // heal the partition: anti-entropy via state vectors
        for (const p of peers) for (const q of peers) if (p !== q) p.apply(q.diff(p.getStateVector()))
        const texts = peers.map((p) => p.toString())
        return texts.every((t) => t === texts[0]) && peers.every((p) => p.pending.length === 0)
      },
    ),
    { numRuns: 1000 },
  )
})
