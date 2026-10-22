import { useEffect, useRef, useState } from 'react'
import { FileText, GitMerge, Shapes, TextCursorInput } from 'lucide-react'

export const TYPE_INFO = {
  doc: { label: 'Document', title: 'Untitled document', Icon: FileText, desc: 'Rich text with headings, lists and live cursors' },
  board: { label: 'Whiteboard', title: 'Untitled whiteboard', Icon: Shapes, desc: 'Shapes, sticky notes and freehand drawing' },
  text: { label: 'Plain text', title: 'Untitled text', Icon: TextCursorInput, desc: 'Monospace text on the custom RGA engine' },
}

export function TypeIcon({ type, size = 15 }) {
  const Icon = TYPE_INFO[type]?.Icon ?? FileText
  return (
    <span className="type-icon">
      <Icon size={size} strokeWidth={1.75} />
    </span>
  )
}

export function Logo({ size = 'sm' }) {
  return (
    <span className={`logo-mark ${size === 'lg' ? 'lg' : ''}`} aria-hidden>
      <GitMerge size={size === 'lg' ? 20 : 14} strokeWidth={2.25} />
    </span>
  )
}

export function Avatar({ user, size, className = '' }) {
  return (
    <span className={`avatar ${size || ''} ${className}`} style={{ background: user.color }} title={user.name}>
      {user.name?.[0]?.toUpperCase()}
    </span>
  )
}

/** Dropdown menu: `trigger` receives { open, toggle }; children receive close(). */
export function Menu({ trigger, children, align = 'right' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e) => !ref.current?.contains(e.target) && setOpen(false)
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="menu-wrap" ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div className="menu" role="menu" style={align === 'left' ? { left: 0, right: 'auto' } : undefined}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

export function timeAgo(date) {
  const s = Math.round((Date.now() - new Date(date).getTime()) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d > 300 ? 'numeric' : undefined })
}
