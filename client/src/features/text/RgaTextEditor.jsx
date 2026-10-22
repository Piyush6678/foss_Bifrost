import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { diffText } from '@collab/rga-crdt'
import { usePresence } from '../../crdt/hooks.js'

/**
 * A <textarea> bound to our RGA CRDT.
 *  - Local input: diff the old/new value (common prefix/suffix) into a
 *    single splice, which becomes RGA insert/delete ops.
 *  - Remote ops: re-render the text and restore the caret from *stable RGA
 *    positions* (node ids), so your cursor does not jump when others type
 *    before it.
 *  - Remote cursors/selections: a transparent mirror <div> behind the
 *    textarea with the same metrics, with caret markers placed at
 *    their positions.
 */
export default function RgaTextEditor({ rga, awareness, readOnly, compact = false, placeholder }) {
  const ta = useRef(null)
  const mirror = useRef(null)
  const lastText = useRef(rga.toString())
  const selPos = useRef({ a: rga.positionAt(0), h: rga.positionAt(0) })
  const [version, setVersion] = useState(0)
  const people = usePresence(awareness)

  const publishSelection = () => {
    const el = ta.current
    if (!el) return
    selPos.current = { a: rga.positionAt(el.selectionStart), h: rga.positionAt(el.selectionEnd) }
    awareness?.setLocalStateField('sel', selPos.current)
  }

  useLayoutEffect(() => {
    const el = ta.current
    el.value = lastText.current = rga.toString()
    return rga.on((ops, origin) => {
      if (origin === 'local') return
      const text = rga.toString()
      if (text !== el.value) {
        const focused = document.activeElement === el
        const { a, h } = selPos.current
        el.value = text
        if (focused) el.setSelectionRange(rga.indexOfPosition(a), rga.indexOfPosition(h))
      }
      lastText.current = text
      setVersion((v) => v + 1)
    })
  }, [rga])

  const onInput = () => {
    const el = ta.current
    const next = el.value
    const { index, deleteCount, insert } = diffText(lastText.current, next)
    if (deleteCount) rga.delete(index, deleteCount)
    if (insert) rga.insert(index, insert)
    lastText.current = rga.toString()
    publishSelection()
    setVersion((v) => v + 1)
  }

  const syncScroll = () => {
    if (mirror.current) mirror.current.scrollTop = ta.current.scrollTop
  }

  // ---- remote cursor overlay ----
  const remotes = people.filter((p) => !p.self && p.sel)
  const segments = useMemo(() => {
    const text = rga.toString()
    const cursors = remotes.map((p) => {
      const a = rga.indexOfPosition(p.sel.a)
      const h = rga.indexOfPosition(p.sel.h)
      return { id: p.clientId, user: p.user, start: Math.min(a, h), end: Math.max(a, h), head: h }
    })
    const cuts = new Set([0, text.length])
    cursors.forEach((c) => {
      cuts.add(c.start)
      cuts.add(c.end)
    })
    const points = [...cuts].sort((x, y) => x - y)
    const out = []
    points.forEach((p, i) => {
      cursors.filter((c) => c.head === p).forEach((c) => out.push({ caret: c }))
      const next = points[i + 1]
      if (next == null) return
      const cover = cursors.find((c) => c.start <= p && c.end >= next && c.end > c.start)
      out.push({ text: text.slice(p, next), color: cover?.user.color })
    })
    return out
  }, [version, remotes.map((r) => `${r.clientId}:${r.sel.a}:${r.sel.h}`).join('|'), rga])

  return (
    <div className={`rga-editor ${compact ? 'compact' : ''}`}>
      <div className="rga-mirror" ref={mirror} aria-hidden>
        {segments.map((s, i) =>
          s.caret ? (
            <span key={`c${s.caret.id}`} className="remote-caret" style={{ '--c': s.caret.user.color }}>
              <span className="remote-caret-label">{s.caret.user.name}</span>
            </span>
          ) : (
            <span key={i} style={s.color ? { background: `${s.color}33` } : undefined}>
              {s.text}
            </span>
          ),
        )}
        {'​'}
      </div>
      <textarea
        ref={ta}
        className="rga-textarea"
        spellCheck={false}
        readOnly={readOnly}
        placeholder={placeholder ?? 'Type here. This plain-text doc runs on our from-scratch RGA CRDT.'}
        onInput={onInput}
        onSelect={publishSelection}
        onKeyUp={publishSelection}
        onMouseUp={publishSelection}
        onFocus={publishSelection}
        onScroll={syncScroll}
      />
    </div>
  )
}
