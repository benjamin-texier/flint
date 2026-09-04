import { useEffect, useState, type ReactNode } from 'react'

import { edgeClass, edgeLabel, edgesOf, NO_EDGES, type Edges } from '../lib/edges'

/** Watches a horizontal scroller and reports which of its ends still has
 *  something past it.
 *
 *  A callback ref rather than a `useRef` the caller passes in, and that is the
 *  whole of the interesting part: every page here renders a spinner first and
 *  the table on the request after it, so an effect keyed on a ref object runs
 *  once, against `null`, and never again — the deps never change because a ref
 *  object never changes. Keeping the node in state is what gives the effect
 *  something to depend on.
 *
 *  Three things move the answer and all three are listened for: the reader
 *  scrolling, the box being resized (a window drag, the rail appearing), and
 *  the *content* changing width — a table that gains a column when a second
 *  request lands fires neither a scroll nor a resize on the scroller itself, so
 *  the observer watches the children too. */
export function useEdges() {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [edges, setEdges] = useState<Edges>(NO_EDGES)

  useEffect(() => {
    // No reset when the node goes: the only way it goes is with the component
    // that renders both it and this state.
    if (!node) return
    const measure = () =>
      setEdges((was) => {
        const now = edgesOf(node.scrollLeft, node.clientWidth, node.scrollWidth)
        return was.left === now.left && was.right === now.right ? was : now
      })
    measure()
    node.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    for (const child of Array.from(node.children)) observer.observe(child)
    return () => {
      node.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [node])

  return { edges, ref: setNode, node }
}

/** A table too wide for its column, with both things a reader needs said about
 *  it: a shade on the side that continues, and a way to reach that side from
 *  the keyboard.
 *
 *  The second is the part that was actually broken. A `div` with
 *  `overflow-x: auto` is scrollable by a mouse wheel and by a trackpad and by
 *  nothing else — a keyboard reader could not reach the Ratio and Share columns
 *  of the object list at all. Making the scroller focusable is the fix WCAG
 *  2.1.1 asks for, and it is only applied while the content actually overflows:
 *  a tab stop on a table with nothing hidden is a tab stop that teaches people
 *  to stop pressing Tab. */
export function Wide({
  label,
  className,
  children,
}: {
  /** What is inside, for the screen reader — "Objects", "Columns", not
   *  "scrollable region". */
  label: string
  /** Extra classes for the scroller, for the panels that style their own. */
  className?: string
  children: ReactNode
}) {
  const { edges, ref } = useEdges()
  const overflows = edges.left || edges.right

  return (
    <div className={`wide${edgeClass(edges)}`}>
      <div
        ref={ref}
        className={`panel__scroll${className ? ` ${className}` : ''}`}
        role={overflows ? 'region' : undefined}
        aria-label={overflows ? edgeLabel(label, edges) : undefined}
        tabIndex={overflows ? 0 : undefined}
      >
        {children}
      </div>
    </div>
  )
}
