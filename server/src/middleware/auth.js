import jwt from 'jsonwebtoken'
import { config } from '../config.js'

export const signAccess = (user) =>
  jwt.sign({ sub: user._id.toString(), name: user.name, color: user.color }, config.jwtSecret, { expiresIn: config.accessTtl })

export const signRefresh = (user) =>
  jwt.sign({ sub: user._id.toString() }, config.refreshSecret, { expiresIn: Math.floor(config.refreshTtlMs / 1000) })

/** Returns the token claims or null. */
export function verifyAccess(token) {
  try {
    return jwt.verify(token, config.jwtSecret)
  } catch {
    return null
  }
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const claims = header.startsWith('Bearer ') ? verifyAccess(header.slice(7)) : null
  if (!claims) return res.status(401).json({ error: 'unauthorized' })
  req.user = { id: claims.sub, name: claims.name, color: claims.color }
  next()
}
