import { ZodError } from 'zod'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Wrap async route handlers so rejections reach the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) return res.status(400).json({ error: 'invalid input', details: err.issues })
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message })
  if (err?.name === 'CastError') return res.status(404).json({ error: 'not found' })
  console.error(err)
  res.status(500).json({ error: 'internal error' })
}
