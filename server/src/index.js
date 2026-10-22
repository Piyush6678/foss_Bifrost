import http from 'node:http'
import { createApp } from './app.js'
import { connectDb, disconnectDb } from './db.js'
import { RoomManager } from './sync/RoomManager.js'
import { attachSyncServer } from './sync/wsServer.js'
import { config } from './config.js'

await connectDb()
const rooms = new RoomManager()
const server = http.createServer(createApp(rooms))
const wss = attachSyncServer(server, rooms)

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] port ${config.port} is already in use: stop the other server or set PORT in server/.env`)
    process.exit(1)
  }
  throw err
})
server.listen(config.port,() => console.log(`[server] http://localhost:${config.port}  ws://localhost:${config.port}/sync/:docId`))

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('[server] flushing rooms...')
  wss.close()
  for (const ws of wss.clients) ws.close(1012, 'server restart')
  await rooms.closeAll()
  await disconnectDb()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
