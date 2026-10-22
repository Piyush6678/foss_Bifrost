import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { User } from '../models/User.js'
import { signAccess, signRefresh, requireAuth } from '../middleware/auth.js'
import { ah, HttpError } from '../middleware/errors.js'
import { config } from '../config.js'

const router = Router()

const signupSchema = z.object({
  name: z.string().trim().min(1).max(60),
  email: z.string().trim().email(),
  password: z.string().min(6).max(200),
})
const loginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1) })

const REFRESH_COOKIE = 'rt'
const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProd,
  path: '/api/auth',
  maxAge: config.refreshTtlMs,
}

function issue(res, user) {
  res.cookie(REFRESH_COOKIE, signRefresh(user), cookieOpts)
  res.json({ accessToken: signAccess(user), user: user.toPublic() })
}

router.post(
  '/signup',
  ah(async (req, res) => {
    const { name, email, password } = signupSchema.parse(req.body)
    if (await User.exists({ email: email.toLowerCase() })) throw new HttpError(409, 'email already registered')
    const user = await User.create({ name, email, passwordHash: await bcrypt.hash(password, 10) })
    res.status(201)
    issue(res, user)
  }),
)

router.post(
  '/login',
  ah(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body)
    const user = await User.findOne({ email: email.toLowerCase() })
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw new HttpError(401, 'invalid email or password')
    issue(res, user)
  }),
)

router.post(
  '/refresh',
  ah(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE]
    let claims
    try {
      claims = jwt.verify(token, config.refreshSecret)
    } catch {
      throw new HttpError(401, 'session expired')
    }
    const user = await User.findById(claims.sub)
    if (!user) throw new HttpError(401, 'session expired')
    issue(res, user)
  }),
)

router.post('/logout', (req, res) => {
  res.clearCookie(REFRESH_COOKIE, { ...cookieOpts, maxAge: undefined })
  res.json({ ok: true })
})

router.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    const user = await User.findById(req.user.id)
    if (!user) throw new HttpError(404, 'not found')
    res.json({ user: user.toPublic() })
  }),
)

export default router
