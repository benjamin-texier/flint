import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'

import { api, type SchemaGraph, type TableSummary } from '../lib/api'
import { trafficIndex, trafficMax, type TableTraffic } from '../lib/diagnose'
import {
  FULL_GRAPH_LIMIT,
  defaultFocus,
  focusSubgraph,
  lineageSubgraph,
  nodeId,
  type GraphNode,
} from '../lib/graph'
import { rememberDatabase } from '../lib/database'
import { type PipelineReport } from '../lib/pipeline'
import { GRAINS, type Grain } from '../lib/timeline'
import { isWindow, type Window as AffinityWindow } from '../lib/affinity'
import { internalName } from '../lib/explain'
import { bytes, count, exact, ratio } from '../lib/format'
import { MetricLine } from '../components/MetricLine'
import { AffinityMatrix } from '../components/AffinityMatrix'
import { MassMap } from '../components/MassMap'
import { PartitionGrid } from '../components/PartitionGrid'
import { SchemaCanvas } from '../components/SchemaCanvas'
import { DatabaseProjections } from '../components/DatabaseProjections'
import { DatabaseReview } from '../components/DatabaseReview'
import { TablePeek } from '../components/TablePeek'
import { ShareBar } from '../components/StratumBar'
import { KindGlyph } from '../components/TypeBadge'
import { Dash } from '../components/Dash'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'

/** The window the diagram's traffic overlay asks for. A week is long enough
 *  that a weekly report still counts as read and short enough to be current. */
const TRAFFIC_DAYS = 7

/** And the window the diagram's flow reading asks for. The same week, so the
 *  two overlays on one diagram answer over one period: "read a lot, carried
 *  nothing" is a sentence about a table, and it is only a sentence if both
 *  halves cover the same days. */
const FLOW_DAYS = 7

/** The three readings of one database, each answering something the others
 *  structurally cannot.
 *
 *  `Flow` is the diagram: who feeds whom — permanent, and with no time in it.
 *  `Time` is the partition grid: the same tables against the partitions they
 *  hold, which is where a TTL's cut-off, a backfill and a failed ingest live.
 *  `Mass` is the treemap: where the disk actually is, down to the column, which
 *  neither of the others can say — the diagram draws a three-terabyte table and
 *  a four-row lookup as the same rectangle. `Together` is the co-access matrix:
 *  which tables turn up in the same statement, which is the coupling nobody
 *  declared and the only one of the four that comes from what people did rather
 *  than from what the database is.
 *
 *  Modes of one section rather than three screens, because the value is in
 *  changing point of view on the database you are already looking at — the same
 *  argument the diagram already makes for inspecting an object in a panel
 *  instead of navigating away. */
type Reading = 'flow' | 'time' | 'mass' | 'together' | 'review' | 'keys'

const READINGS: Reading[] = ['flow', 'time', 'mass', 'together', 'review', 'keys']

/** What the reading is called in the URL and on the control. Kept as one list so
 *  a mode cannot be added to the buttons and forgotten in the address bar. */
const READING_LABEL: Record<Reading, string> = {
  flow: 'Flow',
  time: 'Time',
  mass: 'Mass',
  together: 'Together',
  review: 'Review',
  keys: 'Keys',
}

/** The sentence under the heading: what this reading shows, in the terms of the
 *  database in front of you. A chain of ternaries in the markup was four
 *  sentences nobody could read as a set — and they are a set, since each one has
 *  to say how it differs from the other three. */
function subtitle(reading: Reading, pipelines: number): string {
  if (reading === 'review') {
    return 'The same tables by what their column types cost: one decision per column, however many tables share it.'
  }
  if (reading === 'keys') {
    return 'The same tables by what is asked of them: which ones the workload reads whole, and whether a projection would help.'
  }
  if (reading === 'time') {
    return 'The same tables on a time axis: every partition each one holds, weighed.'
  }
  if (reading === 'mass') {
    return 'The same tables by weight: where this database\u2019s disk actually is, column by column.'
  }
  if (reading === 'together') {
    return 'The same tables by what people do with them: which of them get read in one statement.'
  }
  return pipelines > 0
    ? 'Arrows follow the data: each one points from a source to whatever reads it.'
    : 'Nothing in this database reads from anything else yet.'
}

const READING_MEANING: Record<Reading, string> = {
  flow: 'How data moves: sources, the views that read them, the tables those write into',
  time: 'Every table against the partitions it holds — where a TTL stops, where a backfill landed, where an ingest failed',
  mass: 'Where the disk is, drawn in proportion and divided to the column',
  together:
    'Which tables are read in the same statement — the coupling the schema never declared',
  review:
    'Every column type worth changing across these tables, grouped into the ALTERs it comes to',
  keys:
    'Which of these tables the workload reads end to end, and whether their sorting keys are what it asks for',
}

/** The database, opened on its schema. The diagram is the point: you should be
 *  able to see how the data moves before reading a single row. */
export function DatabasePage({ database }: { database: string }) {
  /* The reading lives in the URL, so a particular view of a database is a link
     you can send to somebody — the same rule the object page's tabs follow. The
     diagram is the default and stays unwritten, so the plain address means what
     it has always meant. */
  const [params, setParams] = useSearchParams()
  const raw = params.get('view')
  const reading: Reading = READINGS.includes(raw as Reading) ? (raw as Reading) : 'flow'
  const setReading = (next: Reading) => {
    const updated = new URLSearchParams(params)
    if (next === 'flow') updated.delete('view')
    else updated.set('view', next)
    setParams(updated, { replace: true })
  }
  /* The pattern the review is aimed at, in the URL for the same reason the
     reading is: "the review of default, raw_% only" is a link somebody sends.
     Empty stays unwritten, so a plain address means the whole database. */
  const pattern = params.get('like') ?? ''
  const setPattern = (next: string) => {
    const updated = new URLSearchParams(params)
    if (next === '') updated.delete('like')
    else updated.set('like', next)
    setParams(updated, { replace: true })
  }
  const tables = useQuery({ queryKey: ['tables', database], queryFn: () => api.tables(database) })
  const graph = useQuery({ queryKey: ['graph', database], queryFn: () => api.graph(database) })
  /* The time axis is fetched only once somebody asks for it: it is a
     `GROUP BY table, partition` over `system.parts`, which is cheap but not
     free, and nobody should pay for it on a page they opened for the diagram. */
  /* The scale is part of the question, so it is part of the key: switching to
     months is a different query, not a different rendering of the same one. And
     part of the URL, for the same reason `view` is — "the partition grid of this
     database, by month" is a picture somebody sends, and the server's own grain
     stays unwritten so the plain link keeps its plain meaning. */
  const rawGrain = params.get('grain')
  const grain: Grain = GRAINS.includes(rawGrain as Grain) ? (rawGrain as Grain) : 'partition'
  const setGrain = (next: Grain) => {
    const updated = new URLSearchParams(params)
    if (next === 'partition') updated.delete('grain')
    else updated.set('grain', next)
    setParams(updated, { replace: true })
  }
  const timeline = useQuery({
    queryKey: ['timeline', database, grain],
    queryFn: () => api.timeline(database, grain),
    enabled: reading === 'time',
    staleTime: 30_000,
    /* Changing the scale is a new query, and a new query with no placeholder
       unmounts the grid and puts a spinner where it was — which costs the reader
       the picture they were reading in order to show them a slightly different
       one. The previous answer stays on screen until the new one lands; it is
       marked stale by `isFetching`, and the control that caused it is the
       feedback that something is happening. */
    placeholderData: (previous) => previous,
  })
  const mass = useQuery({
    queryKey: ['mass', database],
    queryFn: () => api.mass(database),
    enabled: reading === 'mass',
    staleTime: 30_000,
  })
  /* How far back the log is read. In the URL like the grain, so "what these
     tables were doing yesterday" is a link; a week stays unwritten, since it is
     what the plain address has always meant. */
  const rawDays = Number(params.get('days'))
  const days: AffinityWindow = isWindow(rawDays) ? rawDays : 7
  const setDays = (next: AffinityWindow) => {
    const updated = new URLSearchParams(params)
    if (next === 7) updated.delete('days')
    else updated.set('days', String(next))
    setParams(updated, { replace: true })
  }
  const affinity = useQuery({
    queryKey: ['affinity', database, days],
    queryFn: () => api.affinity(database, days),
    enabled: reading === 'together',
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  })
  /* Read counts for the overlay. Its own query, so a role without
     `system.query_log` loses the overlay and keeps the diagram. */
  const traffic = useQuery({
    queryKey: ['diag', 'traffic', TRAFFIC_DAYS],
    queryFn: () => api.diagnoseTraffic(TRAFFIC_DAYS),
    staleTime: 60_000,
  })
  /* What each materialized view actually moved, which is what makes the dots on
     the diagram a measurement rather than an ornament. Server-wide and shared
     with the Pipelines page through the same key, since it is the same report;
     its own query for the same reason traffic is — a role that cannot read
     `system.query_views_log` loses the reading and keeps the diagram. */
  const pipeline = useQuery({
    queryKey: ['pipelines', FLOW_DAYS],
    queryFn: () => api.pipelines(FLOW_DAYS),
    staleTime: 60_000,
  })

  /** The object selected in the diagram, whose rows are shown below it. Held
   *  here rather than in the canvas because the canvas is not the only thing
   *  that answers to it — see the swap at the foot of this page. */
  const [peek, setPeek] = useState<GraphNode | null>(null)

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
          { value: pipelines ? exact(pipelines) : <Dash />, label: 'dependencies' },
        ]}
      />

      <section className="schema">
        <div className="schema__head">
          <h2 className="schema__title">Schema</h2>
          <p className="schema__sub">{subtitle(reading, pipelines)}</p>
          <span className="panel__spacer" />
          <div className="segmented" role="group" aria-label="How to read this database">
            {READINGS.map((r) => (
              <button
                key={r}
                className={`segmented__item${reading === r ? ' is-on' : ''}`}
                aria-pressed={reading === r}
                title={READING_MEANING[r]}
                onClick={() => setReading(r)}
              >
                {READING_LABEL[r]}
              </button>
            ))}
          </div>
        </div>
        {reading === 'keys' ? (
          <DatabaseProjections database={database} days={days} key={database} />
        ) : reading === 'review' ? (
          <DatabaseReview
            database={database}
            tables={list}
            graph={graph.data}
            pattern={pattern}
            onPattern={setPattern}
            key={database}
          />
        ) : reading === 'together' ? (
          affinity.error ? (
            <ErrorNote error={affinity.error} retry={() => affinity.refetch()} />
          ) : affinity.data ? (
            <AffinityMatrix
              report={affinity.data}
              graph={graph.data}
              database={database}
              onWindow={setDays}
              key={database}
            />
          ) : (
            <div className="canvas canvas--loading">
              <Loading label="Reading the query log" />
            </div>
          )
        ) : reading === 'mass' ? (
          mass.error ? (
            <ErrorNote error={mass.error} retry={() => mass.refetch()} />
          ) : mass.data ? (
            <MassMap report={mass.data} database={database} key={database} />
          ) : (
            <div className="canvas canvas--loading">
              <Loading label="Measuring columns" />
            </div>
          )
        ) : reading === 'time' ? (
          timeline.error ? (
            <ErrorNote error={timeline.error} retry={() => timeline.refetch()} />
          ) : timeline.data ? (
            <PartitionGrid
              report={timeline.data}
              database={database}
              onGrain={setGrain}
              key={database}
            />
          ) : (
            <div className="canvas canvas--loading">
              <Loading label="Reading partitions" />
            </div>
          )
        ) : graph.error ? (
          <ErrorNote error={graph.error} retry={() => graph.refetch()} />
        ) : graph.data ? (
          <SchemaView
            graph={graph.data}
            database={database}
            onSelect={setPeek}
            traffic={
              traffic.data?.available ? trafficIndex(traffic.data.traffic) : undefined
            }
            trafficReason={
              traffic.data && !traffic.data.available
                ? `${traffic.data.reason}, so there are no read counts to show`
                : undefined
            }
            report={pipeline.data}
            flowReason={
              pipeline.error
                ? `The view log could not be read (${String(
                    (pipeline.error as Error).message ?? pipeline.error,
                  )}), so nothing on the diagram can be said to have moved`
                : pipeline.isPending
                  ? 'Reading what the views moved…'
                  : undefined
            }
          />
        ) : (
          <div className="canvas canvas--loading">
            <Loading label="Tracing lineage" />
          </div>
        )}
      </section>

      {/* Selecting an object in the diagram swaps the inventory for its rows:
          the next question after "what is this joined to" is nearly always
          "and what is in it". Only under the diagram — the other readings have
          their own idea of what a click means, and the selection does not
          survive leaving `flow` anyway. */}
      {reading === 'flow' && peek ? (
        <TablePeek node={peek} database={database} onClose={() => setPeek(null)} />
      ) : reading === 'review' || reading === 'keys' ? null : (
        <ObjectTable database={database} list={list} />
      )}
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
  report,
  flowReason,
  onSelect,
}: {
  graph: SchemaGraph
  database: string
  traffic?: Map<string, TableTraffic>
  trafficReason?: string
  /** The pipelines report, passed down whole: the canvas takes the reading
   *  itself, over the slice of the schema it is actually drawing. */
  report?: PipelineReport
  flowReason?: string
  /** Passed straight through to the canvas: the page below the diagram shows
   *  what is inside whatever is selected. */
  onSelect?: (node: GraphNode | null) => void
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
      // Whose path this is, when it is a path. The bar names it; on a diagram
      // of eleven boxes the name is not enough to find it in.
      here={lineage ?? undefined}
      onCentre={large && !showAll && !lineage ? setRoot : undefined}
      onLineage={setLineage}
      onSelect={onSelect}
      bar={bar}
      traffic={traffic}
      trafficMax={readMax}
      trafficDays={TRAFFIC_DAYS}
      trafficReason={trafficReason}
      report={report}
      flowReason={flowReason}
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
