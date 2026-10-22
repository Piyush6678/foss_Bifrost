import mongoose from 'mongoose'
import crypto from 'node:crypto'

// type -> CRDT engine that backs it
export const DOC_TYPES = { doc: 'yjs', board: 'yjs', text: 'rga' }

const documentSchema = new mongoose.Schema(
  {
    title: { type: String, default: 'Untitled', trim: true, maxlength: 200 },
    type: { type: String, enum: Object.keys(DOC_TYPES), required: true },
    engine: { type: String, enum: ['yjs', 'rga'], required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    collaborators: [
      {
        _id: false,
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        role: { type: String, enum: ['editor', 'viewer'], default: 'editor' },
      },
    ],
    shareToken: { type: String, default: () => crypto.randomBytes(12).toString('base64url'), index: true },
    shareRole: { type: String, enum: ['editor', 'viewer'], default: 'editor' },
  },
  { timestamps: true },
)
documentSchema.index({ 'collaborators.userId': 1 })

/** 'owner' | 'editor' | 'viewer' | null */
documentSchema.methods.roleOf = function (userId) {
  if (!userId) return null
  if (this.ownerId.toString() === userId.toString()) return 'owner'
  const c = this.collaborators.find((c) => c.userId.toString() === userId.toString())
  return c ? c.role : null
}

documentSchema.methods.toPublic = function (userId) {
  return {
    id: this._id.toString(),
    title: this.title,
    type: this.type,
    engine: this.engine,
    ownerId: this.ownerId.toString(),
    role: this.roleOf(userId),
    updatedAt: this.updatedAt,
    createdAt: this.createdAt,
  }
}

export const Document = mongoose.model('Document', documentSchema)
