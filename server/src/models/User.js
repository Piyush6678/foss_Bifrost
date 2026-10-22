import mongoose from 'mongoose'

const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d']

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    color: { type: String, default: () => COLORS[Math.floor(Math.random() * COLORS.length)] },
  },
  { timestamps: true },
)

userSchema.methods.toPublic = function () {
  return { id: this._id.toString(), name: this.name, email: this.email, color: this.color }
}

export const User = mongoose.model('User', userSchema)
