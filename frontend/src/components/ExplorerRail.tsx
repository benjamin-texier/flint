import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { NavLink, useMatch } from 'react-router-dom'

import { api, type ObjectKind } from '../lib/api'
import { rememberDatabase, rememberedDatabase, resolveDatabase } from '../lib/database'
import { KIND_MEANING, internalName } from '../lib/explain'
import { count, splitTail } from '../lib/format'
import { ErrorNote, Loading } from './Note'
import { DatabaseSwitcher } from './DatabaseSwitcher'

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

  const [filter, setFilter] = useState('')
  const [kind, setKind] = useState<ObjectKind | null>(null)
  const [plumbing, setPlumbing] = useState(false)

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

        {visible.slice(0, RENDER_CAP).map((t) => (
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
        ))}

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
