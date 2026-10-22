import { Router } from 'express'
import crypto from 'node:crypto'
import { z } from 'zod'
import { Document, DOC_TYPES } from '../models/Document.js'
import { DocSnapshot, DocUpdate, Version } from '../models/Persistence.js'
import { requireAuth } from '../middleware/auth.js'
import { ah, HttpError } from '../middleware/errors.js'

const RANK = { viewer: 1, editor: 2, owner: 3 }

export function docsRouter(rooms) {
  const router = Router()
  router.use(requireAuth)

  /** Load a document and make sure the caller has at least `minRole`. */
  async function load(req, minRole = 'viewer') {
    const doc = await Document.findById(req.params.id)
    if (!doc) throw new HttpError(404, 'not found')
    const role = doc.roleOf(req.user.id)
    if (!role) throw new HttpError(404, 'not found')
    if (RANK[role] < RANK[minRole]) throw new HttpError(403, 'forbidden')
    return doc
  }

  router.get(
    '/',
    ah(async (req, res) => {
      const docs = await Document.find({ $or: [{ ownerId: req.user.id }, { 'collaborators.userId': req.user.id }] }).sort({
        updatedAt: -1,
      })
      res.json({ docs: docs.map((d) => d.toPublic(req.user.id)) })
    }),
  )

  const createSchema = z.object({
    title: z.string().trim().max(200).optional(),
    type: z.enum(Object.keys(DOC_TYPES)),
  })
  router.post(
    '/',
    ah(async (req, res) => {
      const { title, type } = createSchema.parse(req.body)
      const doc = await Document.create({ title: title || 'Untitled', type, engine: DOC_TYPES[type], ownerId: req.user.id })
      res.status(201).json({ doc: doc.toPublic(req.user.id) })
    }),
  )

  router.post(
    '/join/:token',
    ah(async (req, res) => {
      const doc = await Document.findOne({ shareToken: req.params.token })
      if (!doc) throw new HttpError(404, 'invalid or expired link')
      if (!doc.roleOf(req.user.id)) {
        doc.collaborators.push({ userId: req.user.id, role: doc.shareRole })
        await doc.save()
      }
      res.json({ doc: doc.toPublic(req.user.id) })
    }),
  )

  router.get(
    '/:id',
    ah(async (req, res) => {
      const doc = await load(req)
      res.json({ doc: doc.toPublic(req.user.id) })
    }),
  )

  router.patch(
    '/:id',
    ah(async (req, res) => {
      const { title } = z.object({ title: z.string().trim().min(1).max(200) }).parse(req.body)
      const doc = await load(req, 'editor')
      doc.title = title
      await doc.save()
      res.json({ doc: doc.toPublic(req.user.id) })
    }),
  )

  router.delete(
    '/:id',
    ah(async (req, res) => {
      const doc = await load(req, 'owner')
      await rooms.drop(doc._id)
      await Promise.all([
        DocUpdate.deleteMany({ docId: doc._id }),
        DocSnapshot.deleteMany({ docId: doc._id }),
        Version.deleteMany({ docId: doc._id }),
        doc.deleteOne(),
      ])
      res.json({ ok: true })
    }),
  )

  // ---------- sharing ----------

  router.get(
    '/:id/share',
    ah(async (req, res) => {
      const doc = await load(req, 'owner')
      await doc.populate('collaborators.userId', 'name email color')
      res.json({
        shareToken: doc.shareToken,
        shareRole: doc.shareRole,
        collaborators: doc.collaborators
          .filter((c) => c.userId)
          .map((c) => ({ id: c.userId._id, name: c.userId.name, email: c.userId.email, color: c.userId.color, role: c.role })),
      })
    }),
  )

  const shareSchema = z.object({
    shareRole: z.enum(['editor', 'viewer']).optional(),
    regenerate: z.boolean().optional(),
    collaborator: z.object({ id: z.string(), role: z.enum(['editor', 'viewer', 'remove']) }).optional(),
  })
  router.patch(
    '/:id/share',
    ah(async (req, res) => {
      const body = shareSchema.parse(req.body)
      const doc = await load(req, 'owner')
      if (body.shareRole) doc.shareRole = body.shareRole
      if (body.regenerate) doc.shareToken = crypto.randomBytes(12).toString('base64url')
      if (body.collaborator) {
        const { id, role } = body.collaborator
        doc.collaborators =
          role === 'remove'
            ? doc.collaborators.filter((c) => c.userId.toString() !== id)
            : doc.collaborators.map((c) => (c.userId.toString() === id ? { userId: c.userId, role } : c))
      }
      await doc.save()
      res.json({ shareToken: doc.shareToken, shareRole: doc.shareRole })
    }),
  )

  // ---------- sync metrics & compaction ----------

  router.get(
    '/:id/metrics',
    ah(async (req, res) => {
      const doc = await load(req)
      res.json(await rooms.withRoom(doc._id, doc.engine, (room) => room.metrics()))
    }),
  )

  router.post(
    '/:id/compact',
    ah(async (req, res) => {
      const doc = await load(req, 'editor')
      const metrics = await rooms.withRoom(doc._id, doc.engine, async (room) => {
        await room.compact()
        return room.metrics()
      })
      res.json(metrics)
    }),
  )

  // ---------- version history ----------

  router.get(
    '/:id/versions',
    ah(async (req, res) => {
      const doc = await load(req)
      const versions = await Version.find({ docId: doc._id }, { data: 0 }).sort({ createdAt: -1 })
      res.json({
        versions: versions.map((v) => ({ id: v._id, name: v.name, createdByName: v.createdByName, createdAt: v.createdAt })),
      })
    }),
  )

  router.post(
    '/:id/versions',
    ah(async (req, res) => {
      const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body)
      const doc = await load(req, 'editor')
      const data = await rooms.withRoom(doc._id, doc.engine, (room) => Buffer.from(room.engine.encodeSnapshot()))
      const v = await Version.create({ docId: doc._id, name, data, createdBy: req.user.id, createdByName: req.user.name })
      res.status(201).json({ version: { id: v._id, name: v.name, createdByName: v.createdByName, createdAt: v.createdAt } })
    }),
  )

  router.get(
    '/:id/versions/:vid',
    ah(async (req, res) => {
      const doc = await load(req)
      const v = await Version.findOne({ _id: req.params.vid, docId: doc._id })
      if (!v) throw new HttpError(404, 'not found')
      res.json({ id: v._id, name: v.name, engine: doc.engine, data: v.data.toString('base64') })
    }),
  )

  return router
}
