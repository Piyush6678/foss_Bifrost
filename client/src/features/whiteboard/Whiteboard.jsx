import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { diffText } from '@collab/rga-crdt'
import { ArrowUpRight, BringToFront, Circle, MousePointer2, Pencil, Redo2, Square, StickyNote, Trash2, Type, Undo2 } from 'lucide-react'
import { usePresence } from '../../crdt/hooks.js'

// ---------------------------------------------------------------------------
// Data model (all inside the Yjs doc, so it merges as a CRDT):
//   shapes: Y.Map<id, Y.Map>  fields: type x y w h color z
//           points: Y.Array<number> (freehand, appended incrementally)
//           text:   Y.Text (sticky notes / text; concurrent typing merges)
// Each field is last-writer-wins on its own, so two people dragging the same
// shape end up at the same position on every peer, and one person recolouring
// while another moves it keeps both changes.
// ---------------------------------------------------------------------------

const LOCAL = 'whiteboard-local' // transaction origin tracked by the UndoManager
const TOOLS = [
  ['select', MousePointer2, 'Select and move (V)'],
  ['rect', Square, 'Rectangle (R)'],
  ['ellipse', Circle, 'Ellipse (O)'],
  ['line', ArrowUpRight, 'Arrow (A)'],
  ['pen', Pencil, 'Freehand (P)'],
  ['sticky', StickyNote, 'Sticky note (S)'],
  ['text', Type, 'Text (T)'],
]
const KEYS = { v: 'select', r: 'rect', o: 'ellipse', a: 'line', p: 'pen', s: 'sticky', t: 'text' }
const COLORS = ['#18181b', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#2563eb', '#7c3aed']
const STICKY = ['#fef3c7', '#fce7f3', '#dcfce7', '#dbeafe', '#ffedd5']
const W = 3000
const H = 2000

const uid = () => Math.random().toString(36).slice(2, 11)

function toPlain(id, ymap) {
  const s = { id }
  ymap.forEach((v, k) => {
    s[k] = v instanceof Y.Array ? v.toArray() : v instanceof Y.Text ? v.toString() : v
  })
  return s
}

/** Diff-based renderer: only shapes touched by a Yjs event get a new object. */
function useShapes(shapesMap) {
  const [shapes, setShapes] = useState(() => {
    const out = {}
    shapesMap.forEach((m, id) => (out[id] = toPlain(id, m)))
    return out
  })
  useEffect(() => {
    const handler = (events) => {
      const touched = new Set()
      for (const e of events) {
        if (e.target === shapesMap) e.changes.keys.forEach((_, k) => touched.add(k))
        else touched.add(e.path[0])
      }
      setShapes((prev) => {
        const next = { ...prev }
        touched.forEach((id) => {
          const m = shapesMap.get(id)
          if (m) next[id] = toPlain(id, m)
          else delete next[id]
        })
        return next
      })
    }
    shapesMap.observeDeep(handler)
    return () => shapesMap.unobserveDeep(handler)
  }, [shapesMap])
  return shapes
}

export default function Whiteboard({ session, readOnly }) {
  const { ydoc, awareness } = session
  const shapesMap = useMemo(() => ydoc.getMap('shapes'), [ydoc])
  const shapes = useShapes(shapesMap)
  const undo = useMemo(() => new Y.UndoManager(shapesMap, { trackedOrigins: new Set([LOCAL]), captureTimeout: 400 }), [shapesMap])
  useEffect(() => () => undo.destroy(), [undo])

  const [tool, setTool] = useState('select')
  const [color, setColor] = useState(COLORS[5])
  const [selected, setSelected] = useState(null)
  const [editingText, setEditingText] = useState(null)
  const svgRef = useRef(null)
  const action = useRef(null)
  const lastDown = useRef({ id: null, t: 0 })
  const people = usePresence(awareness)

  const transact = (fn) => ydoc.transact(fn, LOCAL)
  const sorted = useMemo(() => Object.values(shapes).sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || (a.id < b.id ? -1 : 1)), [shapes])
  const maxZ = () => sorted.reduce((m, s) => Math.max(m, s.z ?? 0), 0)

  const point = (e) => {
    const r = svgRef.current.getBoundingClientRect()
    return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) }
  }

  // ---- presence: pointer + selection ----
  const lastPointer = useRef(0)
  const publishPointer = (p) => {
    const now = performance.now()
    if (now - lastPointer.current < 30) return
    lastPointer.current = now
    awareness.setLocalStateField('pointer', p)
  }
  useEffect(() => {
    awareness.setLocalStateField('selection', selected ? [selected] : [])
  }, [selected, awareness])

  // ---- pointer handling ----
  const onPointerDown = (e) => {
    if (readOnly || e.button !== 0 || editingText) return
    const p = point(e)
    const hitId = e.target.closest('[data-shape]')?.dataset.shape
    const handle = e.target.dataset.handle

    if (tool === 'select') {
      if (handle && selected) {
        const s = shapes[selected]
        action.current = { kind: 'resize', id: selected, start: p, orig: { w: s.w, h: s.h } }
      } else if (hitId) {
        // Manual double-click detection: pointer capture retargets native dblclick.
        const now = performance.now()
        const s = shapes[hitId]
        if (lastDown.current.id === hitId && now - lastDown.current.t < 350 && (s.type === 'sticky' || s.type === 'text')) {
          lastDown.current = { id: null, t: 0 }
          setEditingText(hitId)
          return
        }
        lastDown.current = { id: hitId, t: now }
        setSelected(hitId)
        action.current = { kind: 'move', id: hitId, start: p, orig: { x: s.x, y: s.y }, points: s.points }
      } else {
        setSelected(null)
      }
    } else {
      const id = uid()
      const z = maxZ() + 1
      transact(() => {
        const m = new Y.Map()
        m.set('type', tool)
        m.set('x', p.x)
        m.set('y', p.y)
        m.set('w', 0)
        m.set('h', 0)
        m.set('z', z)
        m.set('color', tool === 'sticky' ? STICKY[Math.floor(Math.random() * STICKY.length)] : color)
        if (tool === 'pen') {
          const pts = new Y.Array()
          pts.push([0, 0])
          m.set('points', pts)
        }
        if (tool === 'sticky' || tool === 'text') m.set('text', new Y.Text(tool === 'text' ? 'Text' : ''))
        shapesMap.set(id, m)
      })
      action.current = { kind: 'create', id, start: p, tool }
    }
    svgRef.current.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e) => {
    const p = point(e)
    publishPointer(p)
    const a = action.current
    if (!a) return
    const m = shapesMap.get(a.id)
    if (!m) return (action.current = null)
    const dx = p.x - a.start.x
    const dy = p.y - a.start.y
    transact(() => {
      if (a.kind === 'move') {
        m.set('x', a.orig.x + dx)
        m.set('y', a.orig.y + dy)
      } else if (a.kind === 'resize') {
        m.set('w', Math.max(20, a.orig.w + dx))
        m.set('h', Math.max(20, a.orig.h + dy))
      } else if (a.tool === 'pen') {
        m.get('points').push([dx, dy])
      } else {
        m.set('w', dx)
        m.set('h', dy)
      }
    })
  }

  const onPointerUp = () => {
    const a = action.current
    action.current = null
    if (!a || a.kind !== 'create') return
    const m = shapesMap.get(a.id)
    if (!m) return
    transact(() => {
      if (a.tool === 'line' || a.tool === 'pen') return
      // Normalise negative sizes and give click-created shapes a default size.
      let { x, y, w, h } = m.toJSON()
      if (w < 0) [x, w] = [x + w, -w]
      if (h < 0) [y, h] = [y + h, -h]
      if (w < 8 && h < 8) {
        w = a.tool === 'sticky' ? 180 : a.tool === 'text' ? 160 : 120
        h = a.tool === 'sticky' ? 140 : a.tool === 'text' ? 40 : 80
      }
      m.set('x', x)
      m.set('y', y)
      m.set('w', w)
      m.set('h', h)
    })
    setSelected(a.id)
    setTool('select')
    if (a.tool === 'sticky' || a.tool === 'text') setEditingText(a.id)
  }

  const onPointerLeave = () => awareness.setLocalStateField('pointer', null)

  // ---- keyboard ----
  const removeSelected = useCallback(() => {
    if (!selected) return
    transact(() => shapesMap.delete(selected))
    setSelected(null)
  }, [selected])

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input, textarea, [contenteditable]')) return
      if (readOnly) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? undo.redo() : undo.undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        undo.redo()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        removeSelected()
      } else if (!mod && KEYS[e.key.toLowerCase()]) {
        setTool(KEYS[e.key.toLowerCase()])
      } else if (e.key === 'Escape') {
        setSelected(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [removeSelected, undo, readOnly])

  const recolor = (c) => {
    setColor(c)
    if (selected && shapes[selected]?.type !== 'sticky') transact(() => shapesMap.get(selected)?.set('color', c))
  }
  const toFront = () => selected && transact(() => shapesMap.get(selected)?.set('z', maxZ() + 1))

  // Stable callbacks keep memoised <Shape>s from re-rendering.
  const editText = useCallback(
    (id, value) => {
      const ytext = shapesMap.get(id)?.get('text')
      if (!ytext) return
      const { index, deleteCount, insert } = diffText(ytext.toString(), value)
      ydoc.transact(() => {
        if (deleteCount) ytext.delete(index, deleteCount)
        if (insert) ytext.insert(index, insert)
      }, LOCAL)
    },
    [shapesMap, ydoc],
  )
  const stopEdit = useCallback(() => setEditingText(null), [])

  // remote selection outlines, keyed by shape id
  const remoteSel = {}
  people.filter((p) => !p.self).forEach((p) => (p.selection || []).forEach((id) => (remoteSel[id] = p.user)))

  return (
    <div className="whiteboard">
      {!readOnly && (
        <div className="wb-toolbar">
          {TOOLS.map(([t, Icon, title]) => (
            <button key={t} className={`tool ${tool === t ? 'active' : ''}`} title={title} aria-label={title} onClick={() => setTool(t)}>
              <Icon size={16} strokeWidth={1.75} />
            </button>
          ))}
          <span className="tool-sep" />
          {COLORS.map((c) => (
            <button
              key={c}
              className={`swatch ${color === c ? 'active' : ''}`}
              style={{ background: c }}
              onClick={() => recolor(c)}
              title="Stroke colour"
              aria-label={`Colour ${c}`}
            />
          ))}
          <span className="tool-sep" />
          <button className="tool" title="Bring to front" aria-label="Bring to front" onClick={toFront} disabled={!selected}>
            <BringToFront size={16} strokeWidth={1.75} />
          </button>
          <button className="tool" title="Delete (Del)" aria-label="Delete" onClick={removeSelected} disabled={!selected}>
            <Trash2 size={16} strokeWidth={1.75} />
          </button>
          <span className="tool-sep" />
          <button className="tool" title="Undo your changes (Ctrl+Z)" aria-label="Undo" onClick={() => undo.undo()}>
            <Undo2 size={16} strokeWidth={1.75} />
          </button>
          <button className="tool" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" onClick={() => undo.redo()}>
            <Redo2 size={16} strokeWidth={1.75} />
          </button>
        </div>
      )}
      {!readOnly && sorted.length === 0 && <div className="wb-hint">Pick a tool and drag on the canvas · double-click a note to edit</div>}
      <div className="wb-scroll">
        <svg
          ref={svgRef}
          width={W}
          height={H}
          className={`wb-canvas tool-${tool}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
        >
          <defs>
            <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" className="grid-dot" />
            </pattern>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
            </marker>
          </defs>
          <rect width={W} height={H} fill="url(#grid)" />
          {sorted.map((s) => (
            <Shape
              key={s.id}
              shape={s}
              selected={selected === s.id}
              remoteUser={remoteSel[s.id]}
              editing={editingText === s.id}
              onEditText={editText}
              onStopEdit={stopEdit}
            />
          ))}
          {selected && shapes[selected] && !['line', 'pen'].includes(shapes[selected].type) && !readOnly && (
            <rect
              data-handle="se"
              className="resize-handle"
              x={shapes[selected].x + shapes[selected].w - 6}
              y={shapes[selected].y + shapes[selected].h - 6}
              width={12}
              height={12}
            />
          )}
          {people
            .filter((p) => !p.self && p.pointer)
            .map((p) => (
              <g key={p.clientId} transform={`translate(${p.pointer.x} ${p.pointer.y})`} className="remote-pointer">
                <path d="M0,0 L0,18 L5,13 L9,22 L12,20 L8,12 L14,12 z" fill={p.user.color} stroke="white" strokeWidth="1.5" />
                <g transform="translate(14 20)">
                  <rect rx="4" height="20" width={p.user.name.length * 7.5 + 12} fill={p.user.color} />
                  <text x="6" y="14" fill="white" fontSize="12">
                    {p.user.name}
                  </text>
                </g>
              </g>
            ))}
        </svg>
      </div>
    </div>
  )
}

const Shape = memo(function Shape({ shape: s, selected, remoteUser, editing, onEditText, onStopEdit }) {
  const x = Math.min(s.x, s.x + s.w)
  const y = Math.min(s.y, s.y + s.h)
  const w = Math.abs(s.w)
  const h = Math.abs(s.h)
  const outline = selected ? 'var(--accent)' : remoteUser?.color
  let body
  switch (s.type) {
    case 'rect':
      body = <rect x={x} y={y} width={w} height={h} rx="8" fill={`${s.color}22`} stroke={s.color} strokeWidth="2" />
      break
    case 'ellipse':
      body = <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill={`${s.color}22`} stroke={s.color} strokeWidth="2" />
      break
    case 'line':
      body = (
        <>
          <line x1={s.x} y1={s.y} x2={s.x + s.w} y2={s.y + s.h} stroke="transparent" strokeWidth="14" />
          <line x1={s.x} y1={s.y} x2={s.x + s.w} y2={s.y + s.h} stroke={s.color} strokeWidth="2.5" markerEnd="url(#arrow)" />
        </>
      )
      break
    case 'pen': {
      const pts = s.points || []
      let d = ''
      for (let i = 0; i < pts.length; i += 2) d += `${i ? 'L' : 'M'}${s.x + pts[i]},${s.y + pts[i + 1]} `
      body = (
        <>
          <path d={d} fill="none" stroke="transparent" strokeWidth="14" />
          <path d={d} fill="none" stroke={s.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )
      break
    }
    case 'sticky':
    case 'text':
      body = (
        <>
          {s.type === 'sticky' && <rect x={x} y={y} width={w} height={h} rx="4" fill={s.color} className="sticky" />}
          <foreignObject x={x} y={y} width={Math.max(w, 20)} height={Math.max(h, 20)}>
            {editing ? (
              <textarea
                className={`wb-text-edit ${s.type}`}
                autoFocus
                value={s.text ?? ''}
                style={s.type === 'text' ? { color: s.color } : undefined}
                onChange={(e) => onEditText(s.id, e.target.value)}
                onBlur={onStopEdit}
                onKeyDown={(e) => e.key === 'Escape' && e.target.blur()}
              />
            ) : (
              <div
                className={`wb-text ${s.type}`}
                style={s.type === 'text' ? { color: s.color } : undefined}
              >
                {s.text || (s.type === 'sticky' ? 'Double-click to write' : '')}
              </div>
            )}
          </foreignObject>
        </>
      )
      break
    default:
      return null
  }
  const bbox =
    s.type === 'pen'
      ? penBox(s)
      : s.type === 'line'
        ? { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) }
        : { x, y, w, h }
  return (
    <g data-shape={s.id} className="shape">
      {body}
      {outline && (
        <rect
          x={bbox.x - 5}
          y={bbox.y - 5}
          width={bbox.w + 10}
          height={bbox.h + 10}
          fill="none"
          stroke={outline}
          strokeDasharray={selected ? '0' : '5 4'}
          strokeWidth="1.5"
          rx="6"
          pointerEvents="none"
        />
      )}
      {remoteUser && !selected && (
        <text x={bbox.x - 4} y={bbox.y - 9} fontSize="11" fill={remoteUser.color} pointerEvents="none">
          {remoteUser.name}
        </text>
      )}
    </g>
  )
})

/** Static, read-only render of a board (used by version previews). */
export function BoardPreview({ ydoc }) {
  const shapes = useShapes(useMemo(() => ydoc.getMap('shapes'), [ydoc]))
  const list = Object.values(shapes).sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
  const box = list.reduce(
    (b, s) => {
      const r = s.type === 'pen' ? penBox(s) : { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) }
      return { x1: Math.min(b.x1, r.x), y1: Math.min(b.y1, r.y), x2: Math.max(b.x2, r.x + r.w), y2: Math.max(b.y2, r.y + r.h) }
    },
    { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity },
  )
  if (!list.length) return <p className="muted small">Empty board</p>
  const pad = 20
  return (
    <svg className="board-preview" viewBox={`${box.x1 - pad} ${box.y1 - pad} ${box.x2 - box.x1 + pad * 2} ${box.y2 - box.y1 + pad * 2}`}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
        </marker>
      </defs>
      {list.map((s) => (
        <Shape key={s.id} shape={s} />
      ))}
    </svg>
  )
}

function penBox(s) {
  const pts = s.points || []
  let minX = 0, minY = 0, maxX = 0, maxY = 0
  for (let i = 0; i < pts.length; i += 2) {
    minX = Math.min(minX, pts[i])
    maxX = Math.max(maxX, pts[i])
    minY = Math.min(minY, pts[i + 1])
    maxY = Math.max(maxY, pts[i + 1])
  }
  return { x: s.x + minX, y: s.y + minY, w: maxX - minX, h: maxY - minY }
}
