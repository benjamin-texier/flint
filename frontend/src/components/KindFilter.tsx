import { useEffect, useRef, useState } from 'react'

import { KIND_LABEL, parseKinds, serialiseKinds, type Kind } from '../lib/review'

/** Which kinds of finding are listed.
 *
 *  A review of a wide table produces advice on six different subjects at once,
 *  and a reader almost never wants all six: the person tuning storage has no
 *  use for "this column says nothing", and the person auditing what a table
 *  actually holds does not want to argue about codecs today. Severity cannot do
 *  this — it ranks, and everything here is ranked already by what it costs.
 *
 *  A popover rather than a row of chips, because six labels with their glosses
 *  is a paragraph, and a paragraph of controls above the findings competes with
 *  the findings. Every box starts ticked: this hides, it never reveals, so a
 *  first visit shows the whole list and the reader takes things away.
 *
 *  It keeps the contract the grid's column picker keeps — Escape, or a press
 *  anywhere outside — because a popover only its own button can close is a trap.
 *
 *  Its own file rather than the review panel's, because the same question is
 *  asked wherever findings are listed: the per-table review today, and the
 *  database-wide sweep and the projection advisor as they land. A second copy
 *  of this dropdown would be a second vocabulary the moment one of them gains a
 *  kind — so the label, the tally and the remembered choice all come from
 *  `review.ts`, and a surface adopts the filter by calling `useHiddenKinds`. */
export function KindFilter({
  kinds,
  hidden,
  onPut,
  onAll,
  label = 'kinds',
}: {
  /** What is on offer, with its count — `tally()` over whatever is listed. */
  kinds: { kind: Kind; count: number }[]
  hidden: Set<Kind>
  onPut: (kind: Kind, away: boolean) => void
  onAll: () => void
  /** The word on the button. A surface listing something other than findings
   *  can say so; the default is the one the review uses. */
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      // Escape from inside the popover leaves focus on a checkbox that is about
      // to stop existing, which drops a keyboard reader back to the top of the
      // document. Hand it to the button that opened it, which is where they
      // were.
      toggle.current?.focus()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  // Only the kinds this list actually has: a box ticked off five tables ago for
  // a kind that is not here is not something to report as hidden.
  const off = kinds.filter((entry) => hidden.has(entry.kind)).length
  const on = kinds.length - off

  return (
    <div className="review__picker" ref={box}>
      <button
        className={`review__filter${off > 0 ? ' is-on' : ''}`}
        ref={toggle}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        title="Choose which kinds of finding are listed"
        type="button"
      >
        {off > 0 ? `${label} · ${on} of ${kinds.length}` : label}
      </button>
      {open ? (
        <div className="kindpick" role="group" aria-label="Kinds of finding to list">
          <div className="kindpick__head">
            <span className="kindpick__count">
              {on} of {kinds.length} listed
            </span>
            {off > 0 ? (
              <button className="kindpick__all" onClick={onAll} type="button">
                show all
              </button>
            ) : null}
          </div>
          <div className="kindpick__list">
            {kinds.map(({ kind, count: many }) => (
              <label className="kindpick__item" key={kind}>
                <input
                  type="checkbox"
                  checked={!hidden.has(kind)}
                  onChange={(event) => onPut(kind, !event.target.checked)}
                />
                <span className="kindpick__name">
                  {KIND_LABEL[kind].label}
                  <span className="kindpick__gloss">{KIND_LABEL[kind].gloss}</span>
                </span>
                {/* What ticking it back on would bring, not what is on screen:
                    the number does not move as boxes are ticked. */}
                <span className="kindpick__tally num">{many}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** The kinds put away, remembered.
 *
 *  One key for every surface, deliberately. "Codecs are not my problem" is a
 *  position about the advice, not about the page it was read on, and a reader
 *  who switches one off on a table and finds it back on in the database-wide
 *  sweep has been given two filters that look like one. The stored value is the
 *  list of kinds that are *hidden*, so a Flint that later grows a seventh kind
 *  shows it to everybody rather than hiding it from whoever had a preference
 *  saved. */
const KINDS_KEY = 'flint.review.hidden'

export function useHiddenKinds(): {
  hidden: Set<Kind>
  /** Put a kind away, or bring it back. */
  put: (kind: Kind, away: boolean) => void
  showAll: () => void
} {
  const [hidden, setHidden] = useState<Set<Kind>>(remembered)

  const put = (kind: Kind, away: boolean) =>
    setHidden((current) => {
      const next = new Set(current)
      if (away) next.add(kind)
      else next.delete(kind)
      return remember(next)
    })

  return { hidden, put, showAll: () => setHidden(remember(new Set())) }
}

function remembered(): Set<Kind> {
  try {
    return parseKinds(localStorage.getItem(KINDS_KEY))
  } catch {
    return new Set()
  }
}

function remember(next: Set<Kind>): Set<Kind> {
  try {
    const value = serialiseKinds(next)
    if (value === null) localStorage.removeItem(KINDS_KEY)
    else localStorage.setItem(KINDS_KEY, value)
  } catch {
    /* the choice simply will not survive a reload */
  }
  return next
}
