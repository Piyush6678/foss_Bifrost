import mongoose from 'mongoose'

// Append-only log of raw CRDT updates received since the last snapshot.
const docUpdateSchema = new mongoose.Schema({
  docId: { type: mongoose.Schema.Types.ObjectId, required: true },
  seq: { type: Number, required: true },
  data: { type: Buffer, required: true },
  createdAt: { type: Date, default: Date.now },
})
docUpdateSchema.index({ docId: 1, seq: 1 }, { unique: true })
export const DocUpdate = mongoose.model('DocUpdate', docUpdateSchema)

// Compacted state: all updates with seq <= upToSeq are merged in here.
const docSnapshotSchema = new mongoose.Schema(
  {
    docId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    data: { type: Buffer, required: true },
    upToSeq: { type: Number, required: true },
    compactions: { type: Number, default: 0 },
  },
  { timestamps: true },
)
export const DocSnapshot = mongoose.model('DocSnapshot', docSnapshotSchema)

// Named, user-created checkpoints for version history.
const versionSchema = new mongoose.Schema(
  {
    docId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    data: { type: Buffer, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: String,
  },
  { timestamps: true },
)
export const Version = mongoose.model('Version', versionSchema)
