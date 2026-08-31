import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { NavLink, useMatch } from 'react-router-dom'

import { api, type ObjectKind } from '../lib/api'
import { rememberDatabase, rememberedDatabase, resolveDatabase } from '../lib/database'
import { KIND_MEANING, internalName } from '../lib/explain'
import { count, splitTail } from '../lib/format'
import { useTabs } from '../editor/tabs'
import { familyColor, shortType } from '../lib/chType'
import { ErrorNote, Loading } from './Note'
import { DatabaseSwitcher } from './DatabaseSwitcher'
import { TypeIcon } from './TypeIcon'

/** Tables first — they are what people came for — then the things derived
 *  from them. */
const KIND_RANK: Record<ObjectKind, number> = {
  table: 0,
  materialized_view: 1,
  view: 2,
  dictionary: 3,
}

const KINDS: ObjectKind[] = ['table', 'materialized_view', 'view', 'dictionary']

/** Short enough for four chips to sit in a 264px rail, still a word rather
 *  than a symbol nobody can decode. */
const SHORT_KIND: Record<ObjectKind, string> = {
  table: 'tables',
  materialized_view: 'mat. views',
  view: 'views',
  dictionary: 'dicts',
}

/** Beyond this the rail stops rendering and asks you to narrow the filter.
 *  `system` alone has well over a hundred tables; some servers have thousands. */
const RENDER_CAP = 300

export function ExplorerRail() {
  const atTable = useMatch('/db/:database/:table')
  const atDatabase = useMatch('/db/:database')
  const routeDb = atTable?.params.database ?? atDatabase?.params.database
  /* On the Query page the rail is not a navigator, it is a keyboard: a click
     writes the name into the statement being typed instead of leaving the page.
     Read off the route rather than off a prop, because the rail is mounted above
     the router's outlet and has no other way to know which it is. */
  const writing = Boolean(useMatch('/query'))
  const tabs = useTabs()

  const [filter, setFilter] = useState('')
  const [kind, setKind] = useState<ObjectKind | null>(null)
  const [plumbing, setPlumbing] = useState(false)
  /* One table's columns at a time. Two open at once and the rail stops being a
     list of tables, which is what somebody scrolling it came for. */
  const [opened, setOpened] = useState<string | null>(null)

  const databases = useQuery({ queryKey: ['databases'], queryFn: api.databases })

  // Away from a database route — the editor, the server page — the rail still
  // has to show something, so it falls back to the same resolution the landing
  // route uses.
  const current = routeDb ?? resolveDatabase(databases.data ?? [], rememberedDatabase())

  const tables = useQuery({
    queryKey: ['tables', current],
    queryFn: () => api.tables(current!),
    enabled: Boolean(current),
  })

  const summary = databases.data?.find((d) => d.name === current)

  // A materialized view's own storage is not an object anybody navigates to,
  // and in this database nine of the first ten rows used to be one.
  const listed = useMemo(
    () => (tables.data ?? []).filter((t) => plumbing || !internalName(t.name)),
    [tables.data, plumbing],
  )
  const folded = (tables.data ?? []).length - listed.length

  const counts = useMemo(() => {
    const map = { table: 0, materialized_view: 0, view: 0, dictionary: 0 } as Record<ObjectKind, number>
    for (const t of listed) map[t.kind] += 1
    return map
  }, [listed])

  const query = filter.trim().toLowerCase()
  const visible = useMemo(() => {
    let list = listed
    if (kind) list = list.filter((t) => t.kind === kind)
    if (query) list = list.filter((t) => t.name.toLowerCase().includes(query))
    return [...list].sort(
      (a, b) =>
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        (b.total_rows ?? b.parts_rows) - (a.total_rows ?? a.parts_rows) ||
        a.name.localeCompare(b.name),
    )
  }, [listed, kind, query])

  return (
    <aside className="rail">
      {current && databases.data ? (
        <DatabaseSwitcher
          current={current}
          databases={databases.data}
          // What the rail lists, not what ClickHouse holds: a header that counts
          // nine objects the list below it does not show is a header nobody can
          // reconcile.
          objects={listed.length}
          sizeBytes={summary?.bytes ?? 0}
        />
      ) : (
        <div className="switch">
          <p className="switch__facts">{databases.error ? 'not connected' : 'loading…'}</p>
        </div>
      )}

      <div className="rail__search">
        <svg className="rail__glass" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="6.8" cy="6.8" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10.2 10.2 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          className="rail__input"
          type="search"
          value={filter}
          placeholder="Filter"
          aria-label="Filter objects in this database"
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {/* The kind filters double as the key for the shapes in the list. */}
      <div className="kinds" role="group" aria-label="Filter by kind">
        {KINDS.filter((k) => counts[k] > 0).map((k) => (
          <button
            key={k}
            className={`kinds__item${kind === k ? ' is-on' : ''}`}
            aria-pressed={kind === k}
            title={KIND_MEANING[k]}
            onClick={() => setKind(kind === k ? null : k)}
          >
            <i className={`glyph glyph--${k}`} aria-hidden="true" />
            <span className="kinds__n">{counts[k]}</span>
            <span className="kinds__label">{SHORT_KIND[k]}</span>
          </button>
        ))}
      </div>

      {/* Sits with the chips rather than at the foot of the list: it explains
          why they count fewer objects than the database has, and it is the one
          place somebody would look for the missing ones. */}
      {folded > 0 || plumbing ? (
        <button
          className="rail__plumbing"
          aria-pressed={plumbing}
          onClick={() => setPlumbing((p) => !p)}
          title="The .inner tables ClickHouse creates to hold a materialized view's rows"
        >
          {plumbing
            ? 'hide internal tables'
            : `${folded} internal ${folded === 1 ? 'table' : 'tables'} hidden`}
        </button>
      ) : null}

      <div className="rail__scroll">
        {databases.error ? (
          <ErrorNote error={databases.error} retry={() => databases.refetch()} />
        ) : null}
        {tables.error ? <ErrorNote error={tables.error} retry={() => tables.refetch()} /> : null}
        {tables.isPending && current ? <Loading label="Reading objects" /> : null}

        {tables.isSuccess && visible.length === 0 ? (
          <p className="rail__none">
            {query || kind
              ? folded > 0
                ? `Nothing matches — but ${folded} internal ${
                    folded === 1 ? 'table is' : 'tables are'
                  } folded away.`
                : 'Nothing matches.'
              : 'This database is empty.'}
          </p>
        ) : null}

        {visible.slice(0, RENDER_CAP).map((t) =>
          writing && t.kind !== 'dictionary' ? (
            <WritingNode
              key={t.name}
              database={current!}
              table={t}
              open={opened === t.name}
              onToggle={() => setOpened((name) => (name === t.name ? null : t.name))}
              /* The same click, whichever face the active tab wears: written
                 at the caret in SQL, or asked for in the form. The rail does not
                 branch on it — `pickTable` does, where the tab model lives. */
              onPick={() => tabs.pickTable(current!, t.name)}
              onPickColumn={(column) => tabs.pickColumn(column)}
            />
          ) : (
            <NavLink
              key={t.name}
              to={`/db/${encodeURIComponent(current!)}/${encodeURIComponent(t.name)}`}
              className={({ isActive }) => `objnode${isActive ? ' is-active' : ''}`}
              title={t.comment || t.engine}
              onClick={() => rememberDatabase(current!)}
            >
              <i className={`glyph glyph--${t.kind}`} aria-hidden="true" />
              <ObjectName name={t.name} />
              <span className="objnode__rows">
                {t.kind === 'table' ? count(t.total_rows ?? t.parts_rows) : ''}
              </span>
            </NavLink>
          ),
        )}

        {visible.length > RENDER_CAP ? (
          <p className="rail__none">
            {visible.length - RENDER_CAP} more — narrow the filter to see them.
          </p>
        ) : null}

      </div>

      <NavLink to="/server" className="rail__foot">
        All databases
        <span className="rail__footarrow" aria-hidden="true">
          →
        </span>
      </NavLink>
    </aside>
  )
}

/** A row of the rail while a query is being written.
 *
 *  Three separate gestures, because they are three separate intentions and one
 *  row that guesses between them is a row that guesses wrong: the name writes
 *  the table into the statement, the caret opens the column list so the columns
 *  can be written in too, and the arrow still goes to the table's own page for
 *  when the question is "what *is* this".
 *
 *  Nothing here overwrites what is in the editor. An insertion lands at the
 *  caret; the only exception is a statement that is empty, where a bare table
 *  name would be no use and a whole `SELECT` is what was meant. */
function WritingNode({
  database,
  table,
  open,
  onToggle,
  onPick,
  onPickColumn,
}: {
  database: string
  table: { name: string; kind: ObjectKind; comment: string; engine: string; total_rows: number | null; parts_rows: number }
  open: boolean
  onToggle: () => void
  onPick: () => void
  onPickColumn: (column: string) => void
}) {
  // Asked for only when the row is opened: the rail lists 155 objects and
  // reading every column list would be 155 queries nobody wanted.
  const detail = useQuery({
    queryKey: ['table', database, table.name],
    queryFn: () => api.table(database, table.name),
    enabled: open,
    staleTime: 5 * 60_000,
  })

  return (
    <div className={`objnode objnode--writing${open ? ' is-open' : ''}`}>
      <div className="objnode__line">
        <button
          className="objnode__twist"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} the columns of ${table.name}`}
          type="button"
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3.5 2 7 5l-3.5 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          className="objnode__write"
          onClick={onPick}
          title={`Write ${table.name} into the statement`}
          type="button"
        >
          <i className={`glyph glyph--${table.kind}`} aria-hidden="true" />
          <ObjectName name={table.name} />
        </button>
        <span className="objnode__rows">
          {table.kind === 'table' ? count(table.total_rows ?? table.parts_rows) : ''}
        </span>
        <NavLink
          className="objnode__open"
          to={`/db/${encodeURIComponent(database)}/${encodeURIComponent(table.name)}`}
          title={`Open ${table.name}`}
          aria-label={`Open ${table.name}`}
        >
          →
        </NavLink>
      </div>

      {open ? (
        <div className="objcols" role="group" aria-label={`Columns of ${table.name}`}>
          {detail.isPending ? <Loading label="Reading columns" /> : null}
          {detail.error ? <ErrorNote error={detail.error} /> : null}
          {detail.data?.columns.map((column) => (
            <button
              className="objcol"
              key={column.name}
              onClick={() => onPickColumn(column.name)}
              title={`${column.name} · ${column.type} — write it at the caret`}
              type="button"
            >
              <TypeIcon type={column.type} />
              <span className="objcol__name">{column.name}</span>
              <span className="objcol__type" style={{ color: familyColor(column.type) }}>
                {shortType(column.type)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** A name that gives way in the middle. The rail is 264px wide and these names
 *  run to forty characters with twenty of prefix in common, so the end is the
 *  only part worth protecting. */
function ObjectName({ name }: { name: string }) {
  const [head, tail] = splitTail(name)
  // Only when something was actually taken out, so a short name still shows the
  // row's own tooltip — its comment, or failing that its engine.
  return (
    <span className="objnode__name" title={tail ? name : undefined}>
      <span className="objnode__head">{head}</span>
      {tail ? <span className="objnode__tail">{tail}</span> : null}
    </span>
  )
}
