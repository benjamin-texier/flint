import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { KIND_LABEL, buildEntries, search, type Hit } from '../lib/palette'

/** One place to type a name and get to the thing.
 *
 *  Everything is fetched when the palette opens, not before: the corpus is
 *  every column on the server, and paying for it on every page load to serve a
 *  shortcut most visits never use is the wrong trade. */
export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  const enabled = open
  const schema = useQuery({ queryKey: ['schema'], queryFn: () => api.schema(), enabled })
  const saved = useQuery({
    queryKey: ['saved-queries'],
    queryFn: () => api.savedQueries(),
    enabled,
    retry: false,
  })
  const dashboards = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => api.dashboards(),
    enabled,
    retry: false,
  })
  const reports = useQuery({ queryKey: ['reports'], queryFn: () => api.reports(), enabled, retry: false })
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api.alerts(), enabled, retry: false })
  const apis = useQuery({ queryKey: ['published'], queryFn: () => api.published(), enabled, retry: false })

  const entries = useMemo(
    () =>
      buildEntries({
        schema: schema.data?.map((s) => ({
          database: s.database,
          table: s.table,
          columns: s.columns,
          kind: s.kind,
        })),
        saved: saved.data,
        dashboards: dashboards.data,
        reports: reports.data,
        alerts: alerts.data,
        apis: apis.data,
      }),
    [schema.data, saved.data, dashboards.data, reports.data, alerts.data, apis.data],
  )

  const hits = useMemo(() => search(entries, query), [entries, query])

  // Reset on each opening: a palette that remembers last time's query makes you
  // clear it before you can use it.
  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      input.current?.focus()
    }
  }, [open])

  useEffect(() => setCursor(0), [query])

  if (!open) return null

  const go = (hit: Hit | undefined) => {
    if (!hit) return
    onClose()
    navigate(hit.to)
  }

  return (
    <div
      className="pal"
      role="dialog"
      aria-modal="true"
      aria-label="Find anything"
      onPointerDown={(e) => {
        // Only the backdrop closes it; a click inside is not a dismissal.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="pal__box">
        <input
          ref={input}
          className="pal__input"
          value={query}
          placeholder="Find a table, a column, a dashboard…"
          aria-label="Find anything"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(c + 1, Math.max(0, hits.length - 1)))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(0, c - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              go(hits[cursor])
            }
          }}
        />

        {query.trim() && hits.length === 0 ? (
          <p className="pal__empty">
            Nothing here is called “{query.trim()}”.
            {schema.isPending ? ' Still reading the schema.' : ''}
          </p>
        ) : null}

        {!query.trim() ? (
          <p className="pal__empty">
            Type a name. Tables, columns, dashboards, reports, alerts and endpoints are all in
            here — ClickHouse's own databases are not, or every search for `name` would find
            them.
          </p>
        ) : null}

        {hits.length ? (
          <ul className="pal__list" role="listbox">
            {hits.map((hit, i) => (
              <li key={`${hit.kind}-${hit.to}-${hit.label}-${i}`}>
                <button
                  className={`pal__hit${i === cursor ? ' is-on' : ''}`}
                  role="option"
                  aria-selected={i === cursor}
                  onPointerEnter={() => setCursor(i)}
                  onClick={() => go(hit)}
                >
                  <span className="pal__kind">{KIND_LABEL[hit.kind]}</span>
                  <span className="pal__label">{hit.label}</span>
                  {hit.context ? <span className="pal__context">{hit.context}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <p className="pal__foot">
          <span className="kbd">↑↓</span> move · <span className="kbd">↵</span> open ·{' '}
          <span className="kbd">esc</span> close
        </p>
      </div>
    </div>
  )
}

/** ⌘K, or Ctrl-K where there is no ⌘. Also `/` when nothing else has focus,
 *  which is the other thing everyone tries. */
export function usePaletteShortcut(onOpen: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.tagName === 'INPUT' ||
          e.target.tagName === 'TEXTAREA' ||
          e.target.isContentEditable)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        onOpen()
      } else if (e.key === '/' && !typing) {
        e.preventDefault()
        onOpen()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onOpen])
}
