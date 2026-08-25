import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { api, type SchemaGraph, type TableSummary } from '../lib/api'
import { trafficIndex, trafficMax, type TableTraffic } from '../lib/diagnose'
import {
  FULL_GRAPH_LIMIT,
  defaultFocus,
  focusSubgraph,
  lineageSubgraph,
  nodeId,
} from '../lib/graph'
import { rememberDatabase } from '../lib/database'
import { internalName } from '../lib/explain'
import { bytes, count, exact, ratio } from '../lib/format'
import { MetricLine } from '../components/MetricLine'
import { SchemaCanvas } from '../components/SchemaCanvas'
import { ShareBar } from '../components/StratumBar'
import { KindGlyph } from '../components/TypeBadge'
import { Dash } from '../components/Dash'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'

/** The window the diagram's traffic overlay asks for. A week is long enough
 *  that a weekly report still counts as read and short enough to be current. */
const TRAFFIC_DAYS = 7

/** The database, opened on its schema. The diagram is the point: you should be
 *  able to see how the data moves before reading a single row. */
export function DatabasePage({ database }: { database: string }) {
  const tables = useQuery({ queryKey: ['tables', database], queryFn: () => api.tables(database) })
  const graph = useQuery({ queryKey: ['graph', database], queryFn: () => api.graph(database) })
  /* Read counts for the overlay. Its own query, so a role without
     `system.query_log` loses the overlay and keeps the diagram. */
  const traffic = useQuery({
    queryKey: ['diag', 'traffic', TRAFFIC_DAYS],
    queryFn: () => api.diagnoseTraffic(TRAFFIC_DAYS),
    staleTime: 60_000,
  })

  // Coming back later should land you where you left off.
  useEffect(() => rememberDatabase(database), [database])

  if (tables.error) return <ErrorNote error={tables.error} retry={() => tables.refetch()} />
  if (!tables.data) return <Loading label={`Reading ${database}`} />

  const list = tables.data
  // Rows and bytes count everything, including the tables ClickHouse keeps for
  // its materialized views: that disk is real and it is this database's. The
  // object count does not, because those are not objects anybody made — and a
  // headline that counts nine more than the list below it can show is a
  // headline that cannot be checked.
  const totalBytes = list.reduce((sum, t) => sum + t.parts_bytes, 0)
  const totalRows = list.reduce((sum, t) => sum + (t.total_rows ?? t.parts_rows), 0)
  const objects = list.filter((t) => !internalName(t.name)).length
  const pipelines = graph.data?.edges.length ?? 0

  return (
    <article className="page page--database page--wide">
      <header className="page__head">
        <p className="eyebrow">Database</p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">{database}</h1>
          <Link className="btn" to={`/query?database=${encodeURIComponent(database)}`}>
            Query this database
          </Link>
        </div>
      </header>

      <MetricLine
        metrics={[
          { value: exact(objects), label: 'objects' },
          { value: count(totalRows), label: 'rows' },
          { value: bytes(totalBytes), label: 'on disk' },
          { value: pipelines ? exact(pipelines) : <Dash />, label: 'dependencies', accent: true },
        ]}
      />

      <section className="schema">
        <div className="schema__head">
          <h2 className="schema__title">Schema</h2>
          <p className="schema__sub">
            {pipelines > 0
              ? 'Arrows follow the data: each one points from a source to whatever reads it.'
              : 'Nothing in this database reads from anything else yet.'}
          </p>
        </div>
        {graph.error ? (
          <ErrorNote error={graph.error} retry={() => graph.refetch()} />
        ) : graph.data ? (
          <SchemaView
            graph={graph.data}
            database={database}
            traffic={
              traffic.data?.available ? trafficIndex(traffic.data.traffic) : undefined
            }
            trafficReason={
              traffic.data && !traffic.data.available
                ? `${traffic.data.reason}, so there are no read counts to show`
                : undefined
            }
          />
        ) : (
          <div className="canvas canvas--loading">
            <Loading label="Tracing lineage" />
          </div>
        )}
      </section>

      <ObjectTable database={database} list={list} />
    </article>
  )
}

/** Small schemas are drawn whole. Large ones are drawn around one object,
 *  because 170 objects laid out in full is 7000px tall and fits on screen at
 *  35% zoom, where nothing is readable. */
function SchemaView({
  graph,
  database,
  traffic,
  trafficReason,
}: {
  graph: SchemaGraph
  database: string
  traffic?: Map<string, TableTraffic>
  trafficReason?: string
}) {
  /* Fixed to the whole diagram, not the slice drawn: a scale that moves when
     you focus or filter makes a quiet object look busy. */
  const readMax = useMemo(
    () => (traffic ? trafficMax(traffic, graph.nodes) : 0),
    [traffic, graph.nodes],
  )
  const large = graph.nodes.length > FULL_GRAPH_LIMIT
  const [root, setRoot] = useState<string | undefined>(() => defaultFocus(graph))
  const [depth, setDepth] = useState(2)
  const [showAll, setShowAll] = useState(false)
  /** The object whose whole path is being drawn, if any. Independent of the
   *  neighbourhood machinery: a schema small enough to draw whole still has
   *  paths through it worth isolating. */
  const [lineage, setLineage] = useState<string | null>(null)

  const focused = useMemo(() => {
    if (lineage) return lineageSubgraph(graph, lineage)
    return large && !showAll && root ? focusSubgraph(graph, root, depth) : null
  }, [graph, large, showAll, root, depth, lineage])

  const shown = focused?.graph ?? graph
  const rootName = root?.slice(root.indexOf('.') + 1)
  const lineageName = lineage?.slice(lineage.indexOf('.') + 1)

  const bar = lineage ? (
    <div className="focusbar">
      <span className="focusbar__text">
        The whole path through <span className="focusbar__name">{lineageName}</span>
        <span className="focusbar__rest">
          {' '}
          · {shown.nodes.length} of {graph.nodes.length} objects — everything these rows come
          from and everything they reach
        </span>
      </span>
      <span className="panel__spacer" />
      <button className="btn" onClick={() => setLineage(null)}>
        {large ? 'Back to a neighbourhood' : 'Back to the whole schema'}
      </button>
    </div>
  ) : large ? (
    <div className="focusbar">
      {showAll ? (
        <>
          <span className="focusbar__text">
            All {graph.nodes.length} objects. Dense enough that you will want to zoom.
          </span>
          <button className="btn" onClick={() => setShowAll(false)}>
            Back to a neighbourhood
          </button>
        </>
      ) : (
        <>
          {/* The centre is named once, and the name is the control that
              changes it — a separate labelled picker beside the sentence
              said the same thing twice, and a native select sized to the
              longest of 170 object names took a third of the row to do
              it. */}
          <span className="focusbar__text">
            Around{' '}
            <span className="focusbar__centre">
              <span className="focusbar__name">{rootName}</span>
              <span className="focusbar__caret" aria-hidden="true" />
              <select
                className="focusbar__select"
                aria-label="Object at the centre of the diagram"
                value={root ?? ''}
                onChange={(e) => setRoot(e.target.value)}
              >
                {[...graph.nodes]
                  .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
                  .map((n) => (
                    <option key={nodeId(n)} value={nodeId(n)}>
                      {n.name}
                    </option>
                  ))}
              </select>
            </span>
            {focused && focused.hidden > 0 ? (
              <span className="focusbar__rest">
                {' '}
                · {focused.hidden} more not drawn — any of them can be the centre
              </span>
            ) : null}
          </span>
          <div className="segmented" role="group" aria-label="Hops from the centre">
            {[1, 2, 3].map((d) => (
              <button
                key={d}
                className={`segmented__item${depth === d ? ' is-on' : ''}`}
                aria-pressed={depth === d}
                title={`${d} hop${d > 1 ? 's' : ''} out from the centre`}
                onClick={() => setDepth(d)}
              >
                {d}
              </button>
            ))}
          </div>
          <span className="focusbar__unit label">hops out</span>
          <span className="panel__spacer" />
          <button className="btn" onClick={() => setShowAll(true)}>
            Show all {graph.nodes.length}
          </button>
        </>
      )}
    </div>
  ) : null

  return (
    <SchemaCanvas
      graph={shown}
      onCentre={large && !showAll && !lineage ? setRoot : undefined}
      onLineage={setLineage}
      bar={bar}
      traffic={traffic}
      trafficMax={readMax}
      trafficDays={TRAFFIC_DAYS}
      trafficReason={trafficReason}
      key={`${database}:${showAll}:${lineage ?? ''}`}
    />
  )
}

/** Which column the list is ordered by. The columns do the sorting themselves,
 *  as they do in the results grid — a separate row of sort buttons said the same
 *  thing twice and took the width of four objects' names to do it. */
type SortKey = 'name' | 'engine' | 'columns' | 'rows' | 'bytes' | 'ratio'

interface Sort {
  key: SortKey
  dir: 'asc' | 'desc'
}

/** A first click starts a column the way that column is usually wanted: names
 *  and engines read forwards, quantities biggest-first. */
const FIRST_DIR: Record<SortKey, Sort['dir']> = {
  name: 'asc',
  engine: 'asc',
  columns: 'desc',
  rows: 'desc',
  bytes: 'desc',
  ratio: 'desc',
}

function sortValue(t: TableSummary, key: SortKey): string | number {
  switch (key) {
    case 'name':
      return t.name
    case 'engine':
      return t.engine
    case 'columns':
      return t.columns
    case 'rows':
      return t.total_rows ?? t.parts_rows
    case 'bytes':
      return t.parts_bytes
    case 'ratio':
      return t.parts_bytes ? (t.total_bytes ?? 0) / t.parts_bytes : 0
  }
}

/** True when the object holds its own rows. A view stores nothing — its rows,
 *  its size and its compression are not missing figures but inapplicable ones,
 *  and a hundred rows of em-dashes down four columns reads as broken data
 *  rather than as "this kind of object has no size". */
function stores(kind: TableSummary['kind']): boolean {
  return kind !== 'view' && kind !== 'materialized_view'
}

function ObjectTable({ database, list }: { database: string; list: TableSummary[] }) {
  const [query, setQuery] = useState('')
  const [plumbing, setPlumbing] = useState(false)
  const [sort, setSort] = useState<Sort>({ key: 'bytes', dir: 'desc' })

  const maxBytes = Math.max(...list.map((t) => t.parts_bytes), 1)
  const hidden = plumbing ? 0 : list.filter((t) => internalName(t.name)).length

  const ordered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const copy = list.filter(
      (t) =>
        (plumbing || !internalName(t.name)) &&
        (!needle ||
          t.name.toLowerCase().includes(needle) ||
          t.engine.toLowerCase().includes(needle)),
    )
    const dir = sort.dir === 'asc' ? 1 : -1
    return copy.sort((a, b) => {
      const x = sortValue(a, sort.key)
      const y = sortValue(b, sort.key)
      const cmp = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)
      // Ties fall back to the name, so the order is stable and readable rather
      // than whatever ClickHouse happened to return.
      return cmp !== 0 ? cmp * dir : a.name.localeCompare(b.name)
    })
  }, [list, sort, query, plumbing])

  const order = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: FIRST_DIR[key] },
    )

  const head = (key: SortKey, label: string, numeric?: boolean) => (
    <th
      className={numeric ? 'tbl--n' : undefined}
      aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button className={`tblsort${sort.key === key ? ' is-on' : ''}`} onClick={() => order(key)}>
        {label}
        <span className="tblsort__arrow" aria-hidden="true">
          {sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : ''}
        </span>
      </button>
    </th>
  )

  if (list.length === 0) {
    return (
      <section className="section">
        <EmptyNote title={`${database} is empty`}>
          Create a table in ClickHouse and it shows up here on refresh.
        </EmptyNote>
      </section>
    )
  }

  return (
    <section className="section">
      <div className="panel">
        <div className="panel__bar">
          <span className="panel__count">
            {ordered.length === list.length
              ? `${list.length} ${list.length === 1 ? 'object' : 'objects'}`
              : `${ordered.length} of ${list.length} objects`}
          </span>
          <div className="searchbox">
            <svg className="searchbox__glass" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="6.8" cy="6.8" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M10.2 10.2 14 14"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            <input
              className="searchbox__input"
              type="search"
              value={query}
              placeholder="Find an object"
              aria-label="Filter the objects in this database"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <span className="panel__spacer" />
          {hidden > 0 || plumbing ? (
            <button
              className="panel__toggle"
              aria-pressed={plumbing}
              onClick={() => setPlumbing((p) => !p)}
              title="The .inner tables ClickHouse creates to hold a materialized view's rows"
            >
              {plumbing ? 'Hide internal tables' : `Show ${hidden} internal tables`}
            </button>
          ) : null}
        </div>
        {ordered.length === 0 ? (
          <p className="panel__nomatch">
            {query.trim()
              ? `Nothing here is called “${query.trim()}”.`
              : 'Every object in this database is a materialized view’s own storage.'}
          </p>
        ) : (
        <div className="panel__scroll">
      <table className="tbl">
        <thead>
          <tr>
            {head('name', 'Name')}
            {head('engine', 'Engine')}
            <th>Sorting key</th>
            {head('columns', 'Cols', true)}
            {head('rows', 'Rows', true)}
            {head('bytes', 'On disk', true)}
            {head('ratio', 'Ratio', true)}
            <th className="tbl__bar">Share</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((t) => (
            <tr key={t.name}>
              <td className="tbl__key">
                <Link
                  to={`/db/${encodeURIComponent(database)}/${encodeURIComponent(t.name)}`}
                  className="objlink"
                >
                  <KindGlyph kind={t.kind} />
                  <span className="link">{t.name}</span>
                </Link>
                {t.comment ? <span className="tbl__note">{t.comment}</span> : null}
              </td>
              <td className="mono-dim">{t.engine}</td>
              <td className="tbl__expr" title={t.sorting_key}>
                {t.sorting_key || (stores(t.kind) ? <Dash /> : null)}
              </td>
              <td className="tbl--n">{t.columns}</td>
              {/* A view's rows, size and compression belong to whatever it
                  reads, so its cells stay empty rather than claiming a figure
                  went missing. */}
              <td className="tbl--n">
                {!stores(t.kind) ? null : t.total_rows !== null || t.parts_rows ? (
                  count(t.total_rows ?? t.parts_rows)
                ) : (
                  <Dash />
                )}
              </td>
              <td className="tbl--n">
                {!stores(t.kind) ? null : t.parts_bytes ? bytes(t.parts_bytes) : <Dash />}
              </td>
              <td className="tbl--n mono-dim">
                {!stores(t.kind) ? null : (ratio(t.total_bytes ?? 0, t.parts_bytes) ?? <Dash />)}
              </td>
              <td className="tbl__bar">
                {stores(t.kind) ? <ShareBar value={t.parts_bytes} max={maxBytes} /> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
        </div>
        )}
      </div>
    </section>
  )
}
