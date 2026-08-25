import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { KIND_LABEL } from '../lib/explain'
import type { GraphNode } from '../lib/graph'
import { KindGlyph } from './TypeBadge'

/** Kept clear of the window edge, so a menu opened in the bottom corner still
 *  shows all of itself. */
const EDGE = 8

/** What you can do with a node, at the cursor.
 *
 *  A diagram is a place you point at things, and pointing at a thing and asking
 *  what can be done with it is a right click everywhere else. The panel keeps
 *  the same two actions at the bottom; this is the shortcut for when you know
 *  which node you mean and do not need to read about it first. */
export function NodeMenu({
  node,
  x,
  y,
  onCentre,
  onLineage,
  onClose,
}: {
  node: GraphNode
  /** Viewport coordinates of the click. */
  x: number
  y: number
  /** Absent when the whole schema is on screen and there is nothing to re-root. */
  onCentre?: () => void
  /** Draw only what feeds this object and what it feeds, all the way out. */
  onLineage?: () => void
  onClose: () => void
}) {
  const el = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ x, y })

  // Measure once, then flip against whichever edge is in the way. Cheaper and
  // steadier than guessing the size from the number of items.
  useLayoutEffect(() => {
    const box = el.current?.getBoundingClientRect()
    if (!box) return
    setAt({
      x: Math.max(EDGE, Math.min(x, window.innerWidth - box.width - EDGE)),
      y: Math.max(EDGE, Math.min(y, window.innerHeight - box.height - EDGE)),
    })
  }, [x, y])

  // Anything that is not a choice from the menu dismisses it — a click
  // elsewhere, Escape, a scroll, leaving the window.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!el.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('wheel', onClose, { passive: true })
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  // Arrows walk the items, so the menu is usable from the context-menu key as
  // well as from the mouse that opened it.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = Array.from(
      el.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    )
    const here = items.indexOf(document.activeElement as HTMLElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    items[(here + step + items.length) % items.length]?.focus()
  }

  const copy = () => {
    void navigator.clipboard?.writeText(`${node.database}.${node.name}`)
    onClose()
  }

  return (
    <div
      className="nmenu"
      ref={el}
      role="menu"
      aria-label={`${node.name} actions`}
      style={{ left: at.x, top: at.y }}
      onKeyDown={onKeyDown}
    >
      <p className="nmenu__head">
        <KindGlyph kind={node.kind} />
        <span className="nmenu__name">{node.name}</span>
        <span className="nmenu__kind">{KIND_LABEL[node.kind]}</span>
      </p>

      <Link
        className="nmenu__item"
        role="menuitem"
        autoFocus
        to={`/db/${encodeURIComponent(node.database)}/${encodeURIComponent(node.name)}`}
        onClick={onClose}
      >
        Open
      </Link>

      {onCentre ? (
        <button
          className="nmenu__item"
          role="menuitem"
          onClick={() => {
            onCentre()
            onClose()
          }}
        >
          Centre here
        </button>
      ) : null}

      {onLineage ? (
        <button
          className="nmenu__item"
          role="menuitem"
          onClick={() => {
            onLineage()
            onClose()
          }}
        >
          Show its whole path
        </button>
      ) : null}

      <button className="nmenu__item" role="menuitem" onClick={copy}>
        Copy name
      </button>
    </div>
  )
}
