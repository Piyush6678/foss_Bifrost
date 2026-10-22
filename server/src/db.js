import mongoose from 'mongoose'
import { config } from './config.js'

let memoryServer = null

export async function connectDb(uri = config.mongoUri) {
  if (!uri) {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    memoryServer = await MongoMemoryServer.create()
    uri = memoryServer.getUri()
    console.log('[db] MONGO_URI not set, using in-memory MongoDB (data is lost on restart)')
  }
  await mongoose.connect(uri)
  console.log('[db] connected')
}

export async function disconnectDb() {
  await mongoose.disconnect()
  if (memoryServer) await memoryServer.stop()
  memoryServer = null
}
