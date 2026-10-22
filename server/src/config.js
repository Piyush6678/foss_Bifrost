import 'dotenv/config'

const isProd = process.env.NODE_ENV === 'production'

export const config = {
  port: Number(process.env.PORT || 4000),
  // Leave MONGO_URI empty to run against an in-memory MongoDB (dev / tests).
  mongoUri: process.env.MONGO_URI || '',
  jwtSecret: process.env.JWT_SECRET || (isProd ? null : 'dev-access-secret-change-me'),
  refreshSecret: process.env.JWT_REFRESH_SECRET || (isProd ? null : 'dev-refresh-secret-change-me'),
  accessTtl: '15m',
  refreshTtlMs: 7 * 24 * 3600 * 1000,
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  isProd,
  // Compaction: merge the update log into a snapshot after this many updates...
  compactEvery: Number(process.env.COMPACT_EVERY || 200),
  // ...or after the room has been quiet for this long.
  compactIdleMs: Number(process.env.COMPACT_IDLE_MS || 10_000),
  flushIntervalMs: 250,
  roomUnloadMs: 30_000,
}

if (!config.jwtSecret || !config.refreshSecret) {
  throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be set in production')
}
