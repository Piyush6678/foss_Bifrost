import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import authRoutes from './routes/auth.js'
import { docsRouter } from './routes/docs.js'
import { errorHandler } from './middleware/errors.js'
import { config } from './config.js'

export function createApp(rooms) {
  const app = express()
  app.set('trust proxy', 1)
  app.use(helmet({ contentSecurityPolicy: false }))
  app.use(cors({ origin: config.clientOrigin, credentials: true }))
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())

  app.get('/api/health', (req, res) => res.json({ ok: true, rooms: rooms.rooms.size }))
  app.use('/api/auth', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }), authRoutes)
  app.use('/api/docs', docsRouter(rooms))
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }))

  // In production the server also serves the built React app.
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist')
  if (fs.existsSync(dist)) {
    app.use(express.static(dist))
    app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')))
  }

  app.use(errorHandler)
  return app
}
