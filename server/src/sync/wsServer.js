import { WebSocketServer } from 'ws'
import mongoose from 'mongoose'
import { MAX_FRAME_BYTES, errorMessage } from '@collab/protocol'
import { verifyAccess } from '../middleware/auth.js'
import { Document } from '../models/Document.js'

const HEARTBEAT_MS = 25_000

/**
 * WebSocket endpoint: ws(s)://host/sync/:docId?token=<accessToken>
 * Auth and permission checks happen during the HTTP upgrade, before a socket
 * is ever handed to a room.
 */
export function attachSyncServer(server, rooms) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost')
    const match = url.pathname.match(/^\/sync\/([a-f0-9]{24})$/)
    if (!match) return reject(socket, 404, 'Not Found')
    const claims = verifyAccess(url.searchParams.get('token'))
    if (!claims) return reject(socket, 401, 'Unauthorized')
    try {
      const doc = mongoose.isValidObjectId(match[1]) && (await Document.findById(match[1]))
      if (!doc) return reject(socket, 404, 'Not Found')
      const role = doc.roleOf(claims.sub)
      if (!role) return reject(socket, 403, 'Forbidden')
      const room = await rooms.get(doc._id, doc.engine)
      wss.handleUpgrade(req, socket, head, (ws) => {
        const user = { id: claims.sub, name: claims.name, color: claims.color }
        onConnection(ws, room, user, role, rooms)
      })
    } catch (err) {
      console.error('[ws] upgrade failed', err)
      reject(socket, 500, 'Internal Server Error')
    }
  })

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate()
        continue
      }
      ws.isAlive = false
      ws.ping()
    }
  }, HEARTBEAT_MS)
  wss.on('close', () => clearInterval(heartbeat))

  return wss
}

function onConnection(ws, room, user, role, rooms) {
  ws.isAlive = true
  ws.on('pong', () => (ws.isAlive = true))
  room.addConn(ws, user, role)
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return ws.send(errorMessage('binary_only', 'send binary frames'))
    room.handleMessage(ws, new Uint8Array(data))
  })
  ws.on('close', () => {
    room.removeConn(ws)
    rooms.release(room)
  })
  ws.on('error', () => ws.terminate())
}

function reject(socket, code, text) {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}
