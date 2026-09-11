import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { DatabaseSummary } from '../lib/api'
import { arrowTo, isInternal, orderDatabases, rememberDatabase } from '../lib/database'
import { bytes } from '../lib/format'

/** The options a screen reader would walk, in the order they are drawn.
 *
 *  Read off the DOM rather than kept in state: the focus has to move between
 *  real elements, and the list is two groups deep now, so an index into
 *  `ordered` is not an index into anything focusable. */
function options(box: HTMLElement | null): HTMLElement[] {
  return Array.from(box?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
}

/** Which database you are in, and how to change it.
 *
 *  The rail shows one database at a time rather than a tree of all of them.
 *  On a server with thirty databases holding hundreds of tables each, a tree
 *  is unusable — and even on a small one it costs two levels of indentation
 *  for information you already know. */
export function DatabaseSwitcher({
  current,
  databases,
  objects,
  sizeBytes,
}: {
  current: string
  databases: DatabaseSummary[]
  objects: number
  sizeBytes: number
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  /* Whether the focus has to be put back when the menu goes.
     Decided at the moment of closing and not after it, which is the whole
     reason this is a ref: by the time an effect on `open` runs, React has
     unmounted the menu, so "was the focus inside it" can no longer be asked —
     `menu.current` is null and `activeElement` has already fallen back to the
     body. Asking too late is exactly how the first version of this silently
     restored nothing. */
  const restore = useRef(false)

  /* One place decides to close, so one place can record where the focus was. */
  const close = () => {
    restore.current = Boolean(menu.current?.contains(document.activeElement))
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      // A press outside is the reader choosing somewhere else to be; the focus
      // goes where they pressed and must not be dragged back here.
      if (!wrap.current?.contains(event.target as Node)) {
        restore.current = false
        setOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  /* Focus follows the list, both ways. Opening a menu and leaving the focus
     behind on the button gives the arrows below nothing to walk, and Escape
     then dismisses a menu the reader was never in — so they land back where
     they already were with no idea anything happened. Sending it back to the
     trigger on the way out is the other half: a focus dropped on the body
     restarts the next Tab at the top of the document, which on this page is
     forty tab stops from where the reader was. Both halves are the contract
     `NodeMenu` and an endpoint's revisions already keep. */
  useEffect(() => {
    if (open) {
      options(menu.current)[0]?.focus()
      return
    }
    if (!restore.current) return
    restore.current = false
    trigger.current?.focus()
  }, [open])

  /* Arrows walk, Home and End jump — see `arrowTo` for where each key lands
     and why it wraps. Escape is the document handler's, above, so there is one
     of it. Enter and Space need nothing: every option is a real button, so the
     browser already fires their click. */
  const onMenuKeys = (event: React.KeyboardEvent) => {
    const items = options(menu.current)
    const next = arrowTo(event.key, items.indexOf(document.activeElement as HTMLElement), items.length)
    if (next === null) return
    event.preventDefault()
    items[next]?.focus()
  }

  const ordered = orderDatabases(databases, current)
  /* `orderDatabases` has already put the internals last, so the split is a
     partition rather than a search. Only labelled when there is something on
     both sides of it: a server whose every database is internal needs no
     heading telling it so. */
  const mine = ordered.filter((d) => !isInternal(d.name) || d.name === current)
  const internal = ordered.filter((d) => isInternal(d.name) && d.name !== current)
  const groups = [
    { label: 'Your databases', items: mine, divided: false },
    { label: 'ClickHouse internals', items: internal, divided: mine.length > 0 },
  ].filter((g) => g.items.length > 0)

  const pick = (name: string) => {
    rememberDatabase(name)
    close()
    navigate(`/db/${encodeURIComponent(name)}`)
  }

  return (
    <div className="switch" ref={wrap}>
      <button
        ref={trigger}
        className="switch__button"
        onClick={() => setOpen((o) => !o)}
        /* Down on the trigger opens the list and lands on its first option,
           which is what `aria-haspopup` promises and what every reader who has
           used a select expects. */
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          setOpen(true)
        }}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="switch__name">{current}</span>
        <span className="switch__caret" aria-hidden="true" />
      </button>
      <p className="switch__facts">
        {objects} {objects === 1 ? 'object' : 'objects'}
        {sizeBytes > 0 ? ` · ${bytes(sizeBytes)}` : ''}
      </p>

      {open ? (
        /* Grouped rather than divided. A `listbox` may hold options and groups
           and nothing else, and the internals divider used to be a `<p>` inside
           a `<div>` wrapping each option — so not one of these options was a
           child of the list that was supposed to contain them, and a screen
           reader had no list to read. Two `group`s carry the same split, and
           the heading each was drawn as is now the group's own name. */
        <div
          ref={menu}
          className="switch__menu"
          role="listbox"
          aria-label="Databases"
          onKeyDown={onMenuKeys}
        >
          {groups.map((group) => (
            <div className="switch__group" role="group" aria-label={group.label} key={group.label}>
              {group.divided ? <p className="switch__divider">{group.label}</p> : null}
              {group.items.map((db) => (
                <button
                  key={db.name}
                  className={`switch__option${db.name === current ? ' is-on' : ''}`}
                  role="option"
                  aria-selected={db.name === current}
                  onClick={() => pick(db.name)}
                >
                  <span className="switch__optname">{db.name}</span>
                  <span className="switch__optmeta">
                    {db.tables + db.views + db.materialized_views + db.dictionaries}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
