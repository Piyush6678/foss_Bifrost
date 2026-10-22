# Merge: a conflict-free collaborative editor

A real-time collaborative **rich-text editor, whiteboard and plain-text editor**, built on the MERN stack plus WebSockets. Many people edit **online or offline, with no locks**. Every replica merges to the **same state**, because every document is a CRDT (Conflict-free Replicated Data Type).

We built the sync engine ourselves; there is no hosted provider:

- **Wire protocol**: our own binary protocol (state-vector handshake, batched updates, presence, ping, anti-entropy).
- **Server**: a Node `ws` server. It is just another CRDT replica that relays updates, persists them to MongoDB and compacts the log.
- **Client**: an offline-first `SyncProvider` with IndexedDB persistence, reconnect backoff and a network simulator.
- **Bonus**: an **RGA sequence CRDT written from scratch** (`packages/rga-crdt`). It powers the plain-text documents and the **CRDT Lab**, and is checked by property-based convergence tests.

## Quick start

```bash
npm install
npm run dev          # server on :4000, React app on :5173
```

Open http://localhost:5173, sign up, and create a document. Then open the same URL in a second tab or browser.

- **MongoDB:** if `MONGO_URI` is not set, the server starts an **in-memory MongoDB**. The first run downloads it (~600 MB) and its data is lost on restart. For persistent data, copy `server/.env.example` to `server/.env` and set `MONGO_URI` (`docker compose up -d` gives you `mongodb://localhost:27017/collab`).
- **CRDT Lab:** http://localhost:5173/lab needs no account and no server.

## Features

| Area | What you get |
|---|---|
| Rich text | TipTap/ProseMirror bound to a `Y.XmlFragment`, with live cursors and selections, plus per-user undo/redo (you never undo someone else's typing) |
| Whiteboard | Rectangles, ellipses, arrows, freehand, sticky notes and text. Each field merges as last-writer-wins. Sticky-note text is a `Y.Text`, so concurrent typing merges. Live pointers and remote selections; diff-based rendering where only changed shapes re-render |
| Plain text (RGA) | A textarea on our own RGA. Local input becomes a minimal splice, the caret is restored from stable CRDT positions, and remote carets are drawn through a mirror overlay |
| Offline-first | All edits apply locally first and are saved in IndexedDB. On reconnect, a state-vector handshake sends only what each side is missing |
| Presence | Avatar bar, cursors, pointers and selections over the same socket; cleared on disconnect |
| Persistence & compaction | Append-only update log in MongoDB. It is folded into a snapshot every 200 updates, after 10 s idle, and when the room unloads; the folded entries are then deleted |
| Version history | Named server-side snapshots with preview. Restore is applied as a **new forward edit**, so it merges with concurrent work |
| Sharing | Owner / editor / viewer roles and share links. Viewers are enforced read-only **on the server** |
| Network simulator | Per-tab offline switch, latency (0–3 s) and packet loss. Lost frames are repaired by periodic anti-entropy |
| Metrics | Encoded state size, bytes in/out, RTT, server log entries and bytes, snapshot size, compaction count, plus a "Compact now" button |
| CRDT Lab | Three RGA replicas in one tab. You can partition and heal links, add jittered latency (which reorders messages), make random concurrent edits, see the internal node list with tombstones, read the version vectors, and run tombstone GC |

## Architecture

```
React (Vite)                                Node.js
┌──────────────────────────────┐           ┌─────────────────────────────────┐
│ RichEditor │ Whiteboard │ RGA │           │ Express REST  /api/auth /api/docs│
│        CRDT (Yjs | RGA)       │  binary   │ ws  /sync/:docId?token=JWT       │
│ IndexedDB   Awareness         │◄────────► │   RoomManager → Room             │
│ SyncProvider (ours)           │ WebSocket │     replica (YjsEngine|RgaEngine)│
│  handshake · batching ·       │           │     relay · presence · persist   │
│  backoff · anti-entropy · sim │           │     compaction                   │
└──────────────────────────────┘           └───────────────┬─────────────────┘
                                                            │ Mongoose
                                     users · documents · doc_updates · doc_snapshots · versions
```

### Sync protocol (`packages/protocol`)

Each frame is `varUint(type) · varUint8Array(payload)`:

| Type | Meaning |
|---|---|
| `SYNC_STEP1` | "here is my state vector" |
| `SYNC_STEP2` | "here is everything you are missing" |
| `UPDATE` | incremental update (batched over 50 ms) |
| `AWARENESS` | presence |
| `PING` / `PONG` | RTT measurement |
| `READ_ONLY` | the server tells a viewer it cannot write |
| `ERROR` | error report |

On connect, both sides send STEP1 and answer the other's with STEP2. Offline edits travel in that STEP2, and the server relays them as ordinary updates. Every 10 s the client sends STEP1 again (anti-entropy), so a dropped frame always gets repaired. Both CRDTs sit behind the same byte-level adapter interface, so the provider and the server never need to know which one a document uses.

### The RGA (`packages/rga-crdt`)

- **Nodes:** each character is a node with id `site:seq` (`seq` is a contiguous per-site counter) and a Lamport `ts`.
- **Insert:** an insert names its `origin` node. Integration walks right from the origin and skips every node with a greater `(ts, site)`. That rule orders concurrent inserts at the same spot deterministically, and keeps runs typed concurrently from interleaving.
- **Delete:** a delete creates a tombstone. Ops are delivered causally: an op waits until the same site's previous op and the node it references have arrived. Duplicates are ignored, which makes merging idempotent and commutative.
- **No separate op log:** the node list itself is the compacted log. `diff(versionVector)` derives the missing ops straight from the nodes.
- **Tombstone GC:** only allowed when every replica holds an identical state. From then on, every future op has a larger timestamp than every removed node, so dropping tombstones can never change where an op lands. A replica that falls behind a GC'd history bootstraps from a snapshot.

## Tests

```bash
npm test             # RGA unit + 1000-run property test, server integration tests
npm run dev          # then, in another terminal:
npm run e2e:sync     # real client SyncProvider against the dev stack (Node)
npm run e2e:ui       # 20-step headless Chrome walkthrough (set CHROME_PATH if needed)
```

What the tests cover:

- **Property test:** 2–5 replicas run up to 200 random inserts and deletes while partitioned, with lossy, reordered partial delivery and a final heal. All replicas must end up identical.
- **Server integration tests:** auth on WebSocket upgrade, live convergence, concurrent offline edits merging, restart and reload from MongoDB with compaction, viewer write rejection, RGA over the same server, and version snapshots.
- **UI walkthrough:** signup; two-tab rich-text sync; presence and cursors; offline toggle with concurrent edits and merge; metrics; version save and preview; whiteboard draw, move, pointers and sticky text; RGA sync with caret preservation; the full Lab flow including GC.

## Demo script (5 min)

1. Open the same rich doc in two windows and type in both. Point out the live cursors and the presence bar.
2. In one window, open **Network**, turn on **Offline mode**, and edit the same paragraph in both windows. The badge shows how many local changes are waiting.
3. Turn offline mode off. Both windows converge to the same text with nothing lost.
4. Open a **Whiteboard** and drag the same shape from both windows. It ends in the same place everywhere. Type in one sticky note from both sides.
5. Open **Metrics**: watch the op-log grow, then press **Compact now** and watch the snapshot replace it.
6. In **History**, save a version, keep editing, then preview and restore it.
7. Open the **CRDT Lab**: partition all links, type on all three peers, press 🎲, then **Heal all**. Show the converged ✓, the tombstones in the node list, and **GC tombstones**.

## Project layout

```
packages/protocol    wire format shared by client and server
packages/rga-crdt    from-scratch RGA + tests
server/src           express app, auth, docs routes, sync/ (engines, Room, RoomManager, wsServer)
client/src           api/, sync/ (SyncProvider, IndexedDB store), crdt/ (adapters, session, hooks),
                     features/ (auth, dashboard, editor, whiteboard, text, history, presence, lab)
e2e/                 headless end-to-end scripts
```

## Deploying

Run `npm run build`, then start the server with `NODE_ENV=production` and set `MONGO_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET` and `CLIENT_ORIGIN`. The server serves `client/dist` itself, so a single process serves both the app and the WebSocket on one origin. Any host with WebSocket support works (Render, Railway, Fly).

## Known limitations

- A single server instance owns each room. Scaling out would need sticky routing or Redis pub/sub between instances.
- Each tab gets a fresh RGA site id, so a document's version vector grows by one entry per session.
- RGA tombstone GC is only offered in the Lab, where "every replica" is known. A server cannot know about offline clients, so it keeps tombstones and compacts the log instead.

## References

Shapiro et al., *Conflict-free Replicated Data Types* (2011) · Roh et al., *Replicated abstract data types* (RGA, 2011) · Kleppmann & Beresford, *A Conflict-Free Replicated JSON Datatype* (2017) · Nicolaescu et al., *YATA* (Yjs, 2016)
