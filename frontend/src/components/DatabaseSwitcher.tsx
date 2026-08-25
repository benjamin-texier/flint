import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { DatabaseSummary } from '../lib/api'
import { isInternal, orderDatabases, rememberDatabase } from '../lib/database'
import { bytes } from '../lib/format'

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

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const ordered = orderDatabases(databases, current)
  const firstInternal = ordered.findIndex((d) => isInternal(d.name) && d.name !== current)

  const pick = (name: string) => {
    rememberDatabase(name)
    setOpen(false)
    navigate(`/db/${encodeURIComponent(name)}`)
  }

  return (
    <div className="switch" ref={wrap}>
      <button
        className="switch__button"
        onClick={() => setOpen((o) => !o)}
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
        <div className="switch__menu" role="listbox" aria-label="Databases">
          {ordered.map((db, i) => (
            <div key={db.name}>
              {i === firstInternal && firstInternal > 0 ? (
                <p className="switch__divider">ClickHouse internals</p>
              ) : null}
              <button
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
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
