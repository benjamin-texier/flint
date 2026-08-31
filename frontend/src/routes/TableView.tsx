import { useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { api, type ColumnDetail, type TableDetailResponse } from '../lib/api'
import { allows } from '../lib/spaces'
import { bytes, count, exact, partsLabel, ratio, shortTime } from '../lib/format'
import { MetricLine, type Metric } from '../components/MetricLine'
import { ShareBar, StratumBar } from '../components/StratumBar'
import { TypeBadge, KindGlyph } from '../components/TypeBadge'
import { TypeIcon } from '../components/TypeIcon'
import { CLAUSE_MEANING, KIND_LABEL, KIND_MEANING, explainEngine } from '../lib/explain'
import { QUEUE_UNREADABLE, backgroundReader, isExternalEngine } from '../lib/external'
import { formatDdl, tokenize } from '../lib/ddl'
import { depthOf, lineagePath } from '../lib/path'
import { lineageSubgraph } from '../lib/graph'
import { SchemaCanvas } from '../components/SchemaCanvas'
import {
  LIMITS,
  costOf,
  exploreSql,
  exportSql,
  startingFilter,
  startingSpec,
  timeColumns,
  type ExploreSpec,
} from '../lib/explore'
import { OP_LABEL, opTakesNoValue, opsFor, type ColumnInfo, type Condition } from '../lib/query'
import { shortType } from '../lib/chType'
import { analyseDefinition, columnUsage, type ColumnOrigin, type Definition } from '../lib/lineage'
import { barScale } from '../lib/scale'
import { Download } from '../components/Download'
import { ResultsGrid } from '../components/ResultsGrid'
import { tableDownloadNote } from '../lib/export'
import { Changes } from '../components/Changes'
import { Impact } from '../components/Impact'
import { Profile } from '../components/Profile'
import { Compare } from '../components/Compare'
import { Drift } from '../components/Drift'
import { Relations } from '../components/Relations'
import { ProjectionAdvisor } from '../components/ProjectionAdvisor'
import { SchemaReview } from '../components/SchemaReview'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'
import { Dash } from '../components/Dash'
import { AddRow } from '../components/AddRow'
import { ChangeRows } from '../components/ChangeRows'
import { Stream } from '../components/Stream'
import { ExternalPanel } from '../components/ExternalSource'

const TABS = [
  'columns',
  'preview',
  'write',
  'stream',
  'sources',
  'readby',
  'path',
  'profile',
  'relations',
  'drift',
  'compare',
  'review',
  'partitions',
  'projections',
  'ddl',
] as const
type Tab = (typeof TABS)[number]

function isTab(value: string | null): value is Tab {
  return TABS.includes((value ?? '') as Tab)
}

export function TableView({ database, table }: { database: string; table: string }) {
  const navigate = useNavigate()

  // The tab lives in the URL so a particular view of a table is a link you can
  // send to someone.
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const setTab = (next: Tab) => {
    const updated = new URLSearchParams(params)
    // The default is whichever tab this object opens on, so the URL stays clean
    // for it and explicit for everything else.
    if (next === defaultTab) updated.delete('tab')
    else updated.set('tab', next)
    setParams(updated, { replace: true })
  }

  const detail = useQuery({
    queryKey: ['table', database, table],
    queryFn: () => api.table(database, table),
  })

  // Read once, here, and handed down: three tabs want it and the hook has to sit
  // above the early returns anyway.
  /* Opens on the rows where there are rows. The data is what somebody came for,
     and a list of column names is what they read *after* seeing that the shape
     is not what they expected. An object that stores nothing has nothing to
     open on, so it keeps its columns. */
  const stores = Boolean(detail.data && (detail.data.total_rows || detail.data.parts_rows))
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  const mayWrite = allows(config.data?.tier, 'data')
  /* And a streaming table opens on what it is doing. A `Kafka` table's preview
     is a `SELECT` that steals messages from its own consumer group — the one
     tab in this product that changes what it looks at — and its columns are a
     declaration nobody is asking about. Whether anything is arriving is the
     question, so it is the tab. */
  const defaultTab: Tab = detail.data && backgroundReader(detail.data.engine)
    ? 'stream'
    : stores
      ? 'preview'
      : 'columns'
  const tab: Tab = isTab(raw) ? raw : defaultTab

  const asSelect = detail.data?.as_select ?? ''
  const definition = useMemo(() => analyseDefinition(asSelect), [asSelect])

  if (detail.error) return <ErrorNote error={detail.error} retry={() => detail.refetch()} />
  if (!detail.data) return <Loading label={`Reading ${database}.${table}`} />

  const t = detail.data
  const rows = t.total_rows ?? t.parts_rows
  const disk = t.total_bytes ?? t.parts_bytes
  const compression = ratio(t.uncompressed_bytes, disk)

  const namedSources = (definition?.sources ?? []).filter((source) => source.table)

  const reader = backgroundReader(t.engine)

  const tabs: [Tab, string, number | null][] = [
    ['columns', 'Columns', t.columns.length],
    ['preview', 'Preview', null],
    /* Rows are Data, so writing one belongs here beside reading them rather
       than under `/infra` — nothing on this tab can change what the table *is*,
       which is the whole of why the two-space rule permits it.

       Gated on the tier, and absent rather than disabled where the deployment
       does not allow writes: a control nobody can press, with a tooltip
       explaining itself, is a worse answer than a tab that is not there.
       Offered on anything the catalogue calls a table, including an empty one —
       "has rows already" would withhold the form from precisely the table
       somebody wants to put a first row into. An engine that refuses an insert
       says so itself; a list of insertable engines kept here would drift. */
    ...((t.kind === 'table' && mayWrite ? [['write', 'Write rows', null]] : []) as [
      Tab,
      string,
      number | null,
    ][]),
    /* Only for the two engines that have one, and second because for those two
       it is the tab somebody came for: a Kafka table's columns are a
       declaration, and whether anything is arriving is the question. */
    ...((reader ? [['stream', reader === 'kafka' ? 'Consuming' : 'Queue', null]] : []) as [
      Tab,
      string,
      number | null,
    ][]),
    ...((namedSources.length > 0
      ? [['sources', 'Sources', namedSources.length]]
      : []) as [Tab, string, number | null][]),
    ['readby', 'Read by', null],
    ['path', 'Path', null],
    ['profile', 'Profile', null],
    /* The three that read the rows rather than the definition, kept together and
       in the order the questions come: what is in it, what its columns say about
       each other, and whether any of that has changed. Both of the last two were
       reachable only by typing the URL until this list was the thing that got
       forgotten — which is exactly the failure a tab strip exists to prevent. */
    ['relations', 'Relations', null],
    ['drift', 'Over time', null],
    ['compare', 'Compare', null],
    // Only where there is a schema to review: a view has no parts and no types
    // of its own to change.
    ...((stores ? [['review', 'Schema review', null]] : []) as [Tab, string, number | null][]),
    // A tab badged zero is a promise of nothing: dropped, the same way an
    // absent figure is dropped from the headline rather than dashed.
    // A link to ?tab=partitions keeps its tab even when the count is zero, so
    // the nav never shows nothing as selected.
    ...((t.partitions.length > 0 || tab === 'partitions'
      ? [['partitions', 'Partitions', t.partitions.length]]
      : []) as [Tab, string, number | null][]),
    /* Present wherever there are parts to hold one, not only where one exists
       already: the question this tab answers is whether the workload argues for
       a projection, and "none yet" is the case it is most useful in. The badge
       still counts only what is there — a zero would promise nothing. */
    ...((stores || tab === 'projections'
      ? [['projections', 'Projections', t.projections.length || null]]
      : []) as [Tab, string, number | null][]),
    ['ddl', 'DDL', null],
  ]

  // A tablist is driven by the arrows, with only the selected tab in the tab
  // order — that is the contract the role announces, and without it a keyboard
  // reader has to walk through eight buttons to reach the panel.
  const onTabKeys = (event: React.KeyboardEvent) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End']
    if (!keys.includes(event.key)) return
    event.preventDefault()
    const ids = tabs.map(([id]) => id)
    const here = ids.indexOf(tab)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? ids.length - 1
          : (here + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length
    setTab(ids[next]!)
    // Selection follows focus here, so the focus has to follow the selection.
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`#tab-${ids[next]}`)?.focus(),
    )
  }

  const openInEditor = () => {
    const sql = `SELECT *\nFROM ${quote(database)}.${quote(table)}\nLIMIT 100`
    navigate(`/query?sql=${encodeURIComponent(sql)}&database=${encodeURIComponent(database)}`)
  }

  return (
    <article className="page">
      <header className="page__head">
        <p className="eyebrow label">
          <Link to={`/db/${encodeURIComponent(database)}`} className="link">
            {database}
          </Link>
          <span className="eyebrow__sep">/</span>
          {KIND_LABEL[t.kind]}
        </p>
        <div className="page__titlerow">
          <h1 className="page__title">
            <KindGlyph kind={t.kind} size="lg" />
            {table}
          </h1>
          <div className="page__actions">
            <button className="btn" onClick={openInEditor}>
              Open in editor
            </button>
          </div>
        </div>
        {/* One sentence on what this kind of object actually does. The engine
            name stays above it, so the expert never has to read past it. */}
        <p className="page__lead">{explainEngine(t.engine) ?? KIND_MEANING[t.kind]}</p>
        {/* And *where*, for the engines that hold nothing themselves. The
            sentence above says an S3 table reads files outside ClickHouse; the
            only follow-up anybody has is which ones. */}
        <ExternalPanel
          engine={t.engine}
          engineFull={t.engine_full}
          paths={t.data_paths}
          database={database}
          table={table}
        />
        {/* The figures below belong to a table nobody wrote, so the page says
            which one rather than presenting them as the view's own. */}
        {t.storage ? (
          <p className="page__lead">
            Its rows live in <code>{t.storage}</code>, the table ClickHouse made for it — the
            rows, size and parts below are that table's.
          </p>
        ) : null}
        {t.comment ? <p className="page__sub">{t.comment}</p> : null}
      </header>

      <MetricLine metrics={headline(t, rows, disk, compression)} />

      <ShapeStrip detail={t} database={database} definition={definition} />

      <nav className="tabs" role="tablist" aria-label={`${table} details`} onKeyDown={onTabKeys}>
        {tabs.map(([id, label, n]) => (
          <button
            key={id}
            id={`tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls="tabpanel"
            tabIndex={tab === id ? 0 : -1}
            className={`tabs__tab${tab === id ? ' is-active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
            {n !== null ? <span className="tabs__n">{n}</span> : null}
          </button>
        ))}
      </nav>

      <div className="tabpanel" id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'columns' ? (
          <Columns
            columns={t.columns}
            definition={definition}
            database={database}
            external={isExternalEngine(t.engine)}
          />
        ) : null}
        {tab === 'sources' ? (
          <Sources definition={definition} database={database} outputs={t.columns} />
        ) : null}
        {tab === 'readby' ? (
          <div className="stack">
            {/* The decision above the exploration. `Read by` answers who uses
                this and which columns; this answers what breaks if it goes —
                transitively, and with what would be lost. Same graph, and the
                one somebody is about to act on comes first. */}
            <Impact database={database} table={table} />
            <ReadBy database={database} table={table} columns={t.columns} />
          </div>
        ) : null}
        {tab === 'write' ? (
          <div className="stack">
            {/* Adding first, changing second: the order the two questions come
                in, and the destructive one is not the thing a mis-click lands
                on when the tab opens. */}
            <section className="writepane">
              <h3 className="writepane__head">Add a row</h3>
              <AddRow database={database} table={table} columns={t.columns} />
            </section>
            <section className="writepane">
              <h3 className="writepane__head">Change or delete rows</h3>
              <ChangeRows database={database} table={table} columns={t.columns} />
            </section>
          </div>
        ) : null}
        {tab === 'stream' ? <Stream database={database} table={table} /> : null}
        {tab === 'path' ? <PathTab database={database} table={table} /> : null}
        {tab === 'profile' ? <Profile database={database} table={table} /> : null}
        {tab === 'relations' ? <Relations database={database} table={table} /> : null}
        {tab === 'drift' ? <Drift database={database} table={table} /> : null}
        {tab === 'compare' ? <Compare database={database} table={table} /> : null}
        {tab === 'review' ? <SchemaReview database={database} table={table} /> : null}
        {tab === 'partitions' ? <Partitions detail={t} /> : null}
        {/* Eager like every other tab here, and measured before it was left
            that way: the advisor and its rules cost 30.4 kB minified, 9.0 kB
            gzipped, on an entry chunk that is already a megabyte. That is the
            same order as the schema review beside it, and the landing chunk's
            size is a question for all of these tabs at once rather than one for
            whichever was added last. */}
        {tab === 'projections' ? <ProjectionAdvisor database={database} table={table} /> : null}
        {tab === 'ddl' ? (
          <div className="stack">
            {/* The definition is *what* it is; the record underneath is *how*. */}
            <Ddl detail={t} />
            <Changes database={database} table={table} />
          </div>
        ) : null}
        {tab === 'preview' && reader ? (
          <EmptyNote title="No preview of a queue">
            {QUEUE_UNREADABLE} The {reader === 'kafka' ? 'Consuming' : 'Queue'} tab reads its state
            instead of its rows.
          </EmptyNote>
        ) : null}
        {tab === 'preview' && !reader ? (
          <Preview
            database={database}
            table={table}
            columns={t.columns}
            sortingKey={t.sorting_key}
            /* Gated on `stores`, not on the numbers themselves. A view sends
               `total_rows: null` and `parts_rows: 0` — and `0` is "no parts",
               not "no rows", so `??` walks straight past the null and lands on
               it. That put "Downloads all 0 rows" under a view holding 3,780,
               which is worse than saying nothing: it promises an empty file.
               `stores` is the question actually being asked — does this object
               keep rows of its own — and it is the same one the tab list uses,
               so the two cannot drift. */
            totalRows={stores ? (t.total_rows ?? t.parts_rows ?? null) : null}
          />
        ) : null}
      </div>
    </article>
  )
}

/** The clauses that decide how this table reads from disk, laid out as a
 *  definition list rather than buried in the CREATE statement. */
function ShapeStrip({
  detail,
  database,
  definition,
}: {
  detail: TableDetailResponse
  database: string
  definition: Definition | null
}) {
  const [explain, setExplain] = useState(explainWanted)

  // ClickHouse fills `dependencies_table` for a materialized view and leaves it
  // empty for a plain one, so where it says nothing the definition is asked
  // instead — it is the only account a view has of where its rows come from.
  const declared = detail.depends_on.length > 0
  const readsFrom = (
    declared
      ? detail.depends_on.map((r) => ({ database: r.database, name: r.name }))
      : (definition?.sources ?? [])
          .filter((source) => source.table)
          .map((source) => ({ database: source.database ?? database, name: source.table! }))
  )
    // An object cannot read itself. Where the parse resolves to this very
    // object it is an artefact of an unqualified name, and drawing it says the
    // opposite of the truth.
    .filter((r) => !(r.database === database && r.name === detail.name))

  // ClickHouse defaults the primary key to the sorting key, so on most tables
  // the two clauses hold the same columns — and printing four identical lines
  // twice, side by side, in the widest part of the page says nothing. Printed
  // once, the split becomes the signal: seeing them apart means they are.
  const sameKey = Boolean(detail.sorting_key) && detail.sorting_key === detail.primary_key
  const keys: [string, string | null][] = sameKey
    ? [[BOTH_KEYS, detail.sorting_key]]
    : [
        ['order by', detail.sorting_key || null],
        ['primary key', detail.primary_key || null],
      ]

  // `ENGINE / View` under an eyebrow that already reads VIEW, over a lead that
  // already says what a view does, is the same fact three times. The engine
  // earns its place when it is `ReplacingMergeTree`, not when it restates the
  // kind — and the sentence beneath it would be false here anyway, since a view
  // does not store or merge anything.
  const engineRestatesKind =
    detail.engine.toLowerCase().replace(/[\s_]/g, '') ===
    KIND_LABEL[detail.kind].toLowerCase().replace(/[\s_]/g, '')

  const items: [string, string | null][] = [
    ['engine', engineRestatesKind ? null : detail.engine],
    ...keys,
    ['partition by', detail.partition_key || null],
    ['sample by', detail.sampling_key || null],
    ['ttl', detail.ttl],
  ]
  const present = items.filter(([, value]) => value)
  // A view often has no clauses at all once the engine stops restating its kind
  // — but it still has a lineage, and that is the row worth keeping.
  if (present.length === 0 && readsFrom.length === 0 && detail.dependents.length === 0) return null

  const teachable = present.some(([key]) => CLAUSE_MEANING[key])

  return (
    <dl className="shape">
      {teachable ? (
        <button
          className="shape__toggle"
          onClick={() => setExplain(rememberExplain(!explain))}
          aria-pressed={explain}
          type="button"
        >
          {explain ? 'hide the explanations' : 'what do these mean?'}
        </button>
      ) : null}
      {present.map(([key, value]) => (
        <div className="shape__item" key={key}>
          <dt className="shape__key">{key}</dt>
          <dd className="shape__value">{value}</dd>
          {explain && CLAUSE_MEANING[key] ? (
            <dd className="shape__why">{CLAUSE_MEANING[key]}</dd>
          ) : null}
        </div>
      ))}
      {detail.dependents.length > 0 || readsFrom.length > 0 ? (
        <div className="shape__item shape__item--wide">
          <dt className="shape__key">
            lineage
            {!declared && readsFrom.length > 0 ? (
              <span className="shape__source"> · read from the definition</span>
            ) : null}
          </dt>
          <dd className="shape__value shape__lineage">
            {readsFrom.map((r) => (
              <Link
                key={`up-${r.database}.${r.name}`}
                className="lineage lineage--up"
                to={`/db/${encodeURIComponent(r.database)}/${encodeURIComponent(r.name)}`}
                title={`Reads from ${r.database}.${r.name}`}
              >
                {/* Qualified when it lives elsewhere: `analytics.streetlights`
                    reading `raw.streetlights` rendered as a bare name looks
                    exactly like an object reading itself. */}
                ← {r.database === database ? r.name : `${r.database}.${r.name}`}
              </Link>
            ))}
            {detail.dependents.map((r) => (
              <Link
                key={`down-${r.database}.${r.name}`}
                className="lineage lineage--down"
                to={`/db/${encodeURIComponent(r.database)}/${encodeURIComponent(r.name)}`}
                title={`${r.database}.${r.name} reads from this table`}
              >
                {r.name} →
              </Link>
            ))}
          </dd>
        </div>
      ) : null}
    </dl>
  )
}

function Columns({
  columns,
  definition,
  database,
  external = false,
}: {
  columns: ColumnDetail[]
  definition: Definition | null
  database: string
  /** True where the rows are not on this server, which makes the per-column
   *  sizes below not a measurement of anything here. */
  external?: boolean
}) {
  // Views, materialized views and dictionaries report no per-column storage.
  // A scale of 0 makes the bars render as nothing rather than as a row of ticks
  // that look like data.
  //
  // An external table is worse than that, and it is why `external` exists.
  // `system.columns` does not report zero for an `S3`, a `URL` or a `File`
  // table: it reports ClickHouse's own planning estimate, a flat 100 MB
  // compressed and 1 GB raw *per column*, identical down the table. Flint drew
  // that as "95 MiB on disk, 954 MiB raw, 10×" on a table holding nothing at
  // all. The rows are in a bucket; nothing on this server has measured them,
  // and the columns are dropped rather than filled with a number the server
  // made up to cost a query plan with.
  const anySizes = !external && columns.some((c) => c.uncompressed_bytes > 0)
  const max = useMemo(
    () => (anySizes ? barScale(columns.map((c) => c.uncompressed_bytes)) : 0),
    [columns, anySizes],
  )
  // Named, because the legend has to account for them: a bar drawn full width
  // when the figure beside it is ten times its neighbour's needs a word.
  const past = max > 0 ? columns.filter((c) => c.uncompressed_bytes > max).length : 0

  // What a view has instead of storage: an account of where each column came
  // from. The columns that would be four dashes wide give up their room to it.
  const origins = useMemo(() => {
    const map = new Map<string, ColumnOrigin>()
    for (const column of definition?.columns ?? []) {
      if (column.name) map.set(column.name, column)
    }
    return map
  }, [definition])

  const showFrom = origins.size > 0
  const showKeys = columns.some(
    (c) =>
      c.in_primary_key ||
      c.in_sorting_key ||
      c.in_partition_key ||
      c.in_sampling_key ||
      c.ttl_expression,
  )

  if (columns.length === 0) {
    return <EmptyNote title="No columns reported">This object exposes no column metadata.</EmptyNote>
  }

  return (
    <div className="panel">
      <div className="panel__bar">
        <span className="panel__count">
          {columns.length} {columns.length === 1 ? 'column' : 'columns'}
        </span>
        <span className="panel__spacer" />
        {anySizes ? (
          <span className="panel__hint">
            bar shows raw extent, filled to size on disk
            {past > 0 ? ` · ${past} past the scale` : ''}
          </span>
        ) : showFrom ? (
          <span className="panel__hint">from · read out of the definition</span>
        ) : null}
      </div>
      <div className="panel__scroll">
    <table className="tbl tbl--cols">
      <thead>
        <tr>
          <th className="tbl--n">#</th>
          <th>Name</th>
          <th>Type</th>
          {showKeys ? <th>Keys</th> : null}
          {showFrom ? <th>From</th> : null}
          {anySizes ? (
            <>
              <th className="tbl--n">On disk</th>
              <th className="tbl--n">Raw</th>
              <th className="tbl--n">Ratio</th>
              <th className="tbl__bar" />
            </>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {columns.map((c) => {
          const r = ratio(c.uncompressed_bytes, c.compressed_bytes)
          const origin = origins.get(c.name)
          return (
            <tr key={c.name}>
              <td className="tbl--n tbl__pos">{c.position}</td>
              <td className="tbl__key">
                {c.name}
                {c.nullable ? (
                  <span className="nullable" title="Nullable">
                    ?
                  </span>
                ) : null}
                {c.comment ? <span className="tbl__note">{c.comment}</span> : null}
                {c.default_kind ? (
                  <span className="tbl__note">
                    {c.default_kind.toLowerCase()} {c.default_expression}
                  </span>
                ) : null}
                {origin?.computed ? (
                  <span className="tbl__note tbl__expr mono-dim" title={origin.expression}>
                    {origin.expression}
                  </span>
                ) : null}
              </td>
              <td>
                <span className="tbl__head">
                  <TypeIcon type={c.type} />
                  <TypeBadge type={c.type} />
                </span>
                {c.compression_codec ? (
                  <span className="codec" title="Compression codec">
                    {c.compression_codec.replace(/^CODEC\((.*)\)$/, '$1')}
                  </span>
                ) : null}
              </td>
              {showKeys ? (
                <td className="tbl__keys">
                  {c.in_primary_key ? <span className="pill pill--key">pk</span> : null}
                  {c.in_sorting_key && !c.in_primary_key ? (
                    <span className="pill pill--key">sort</span>
                  ) : null}
                  {c.in_partition_key ? <span className="pill">part</span> : null}
                  {c.in_sampling_key ? <span className="pill">sample</span> : null}
                  {c.ttl_expression ? (
                    <span className="pill" title={c.ttl_expression}>
                      ttl
                    </span>
                  ) : null}
                </td>
              ) : null}
              {showFrom ? (
                <td className="tbl__from">
                  <Origin origin={origin} database={database} />
                </td>
              ) : null}
              {anySizes ? (
                <>
                  <td className="tbl--n">
                    {c.compressed_bytes ? bytes(c.compressed_bytes) : <Dash />}
                  </td>
                  <td className="tbl--n mono-dim">
                    {c.uncompressed_bytes ? bytes(c.uncompressed_bytes) : <Dash />}
                  </td>
                  <td className="tbl--n mono-dim">{r ?? <Dash />}</td>
                  <td className="tbl__bar">
                    <StratumBar
                      compressed={c.compressed_bytes}
                      uncompressed={c.uncompressed_bytes}
                      max={max}
                      title={
                        c.uncompressed_bytes
                          ? `${bytes(c.compressed_bytes)} on disk from ${bytes(
                              c.uncompressed_bytes,
                            )} raw${r ? ` (${r})` : ''}`
                          : undefined
                      }
                    />
                  </td>
                </>
              ) : null}
            </tr>
          )
        })}
      </tbody>
    </table>
      </div>
    </div>
  )
}

/** Where one column of a view comes from. Each source table is a link, because
 *  the next question after "where does this come from" is always "show me". A
 *  reference the reader could not place is marked as unplaced rather than
 *  attributed to whichever table looked likely. */
function Origin({ origin, database }: { origin: ColumnOrigin | undefined; database: string }) {
  if (!origin || origin.from.length === 0) return <Dash />
  return (
    <span className="origin">
      {origin.from.map((ref) => (
        <span className="origin__ref" key={`${ref.table ?? '?'}.${ref.column}`}>
          {ref.table ? (
            <>
              <Link
                className="link"
                to={`/db/${encodeURIComponent(ref.database ?? database)}/${encodeURIComponent(
                  ref.table,
                )}`}
              >
                {ref.table}
              </Link>
              <span className="origin__dot">.</span>
            </>
          ) : (
            <span className="origin__unplaced" title="Flint could not tell which source this is">
              ?{' '}
            </span>
          )}
          {ref.column}
        </span>
      ))}
    </span>
  )
}

/** The schemas this view is built out of.
 *
 *  Answers the question the Columns tab raises and cannot settle: not only where
 *  each output column comes from, but what the source tables actually hold, and
 *  how much of them this view touches. "Six of forty-two columns" is what a
 *  schema change needs to know. */
function Sources({
  definition,
  database,
  outputs,
}: {
  definition: Definition | null
  database: string
  outputs: ColumnDetail[]
}) {
  // The view's own column types, to set against the ones it reads. A column that
  // arrives `UInt64` and leaves `Nullable(UInt64)` was made nullable by a join,
  // and that is the kind of thing nobody notices until a query returns a null
  // it was not expecting.
  const outputType = useMemo(
    () => new Map(outputs.map((c) => [c.name, c.type])),
    [outputs],
  )
  const sources = (definition?.sources ?? []).filter((source) => source.table)
  const others = (definition?.sources ?? []).filter((source) => !source.table)
  const usage = useMemo(
    () => (definition ? columnUsage(definition) : new Map<string, Map<string, string[]>>()),
    [definition],
  )

  const schemas = useQueries({
    queries: sources.map((source) => ({
      queryKey: ['table', source.database ?? database, source.table],
      queryFn: () => api.table(source.database ?? database, source.table!),
    })),
  })

  if (sources.length === 0 && others.length === 0) {
    return (
      <EmptyNote title="Nothing to read from">
        This definition selects no table — it computes its rows from constants
        alone.
      </EmptyNote>
    )
  }

  return (
    <div className="stack">
      {sources.map((source, i) => {
        const query = schemas[i]
        const read = usage.get(source.table!) ?? new Map<string, string[]>()
        const schema = query?.data
        const columns = schema?.columns ?? []
        const used = columns.filter((c) => read.has(c.name))
        const unused = columns.filter((c) => !read.has(c.name))
        // A reference that matched no column of the table it was attributed to:
        // said out loud rather than quietly dropped.
        const unmatched = [...read.keys()].filter((name) => !columns.some((c) => c.name === name))

        return (
          <section className="card" key={`${source.database ?? database}.${source.table}`}>
            <header className="card__head">
              <h3 className="card__title">
                <Link
                  className="link"
                  to={`/db/${encodeURIComponent(source.database ?? database)}/${encodeURIComponent(
                    source.table!,
                  )}`}
                >
                  {source.table}
                </Link>
                {source.alias && source.alias !== source.table ? (
                  <span className="src__alias"> as {source.alias}</span>
                ) : null}
              </h3>
              {schema ? (
                <span className="src__facts">
                  <span className="src__engine">{schema.engine}</span> · {used.length} of{' '}
                  {columns.length} columns read
                </span>
              ) : query?.isPending ? (
                <span className="src__facts">reading</span>
              ) : (
                <span className="src__facts">schema unavailable</span>
              )}
            </header>

            {query?.error ? (
              <ErrorNote error={query.error} retry={() => void query.refetch()} />
            ) : null}

            {used.length > 0 ? (
              <div className="panel__scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Column</th>
                      <th>Type</th>
                      <th>Feeds</th>
                    </tr>
                  </thead>
                  <tbody>
                    {used.map((c) => {
                      const feeds = read.get(c.name) ?? []
                      return (
                        <tr key={c.name}>
                          <td className="tbl__key">{c.name}</td>
                          <td>
                            <span className="tbl__head">
                              <TypeIcon type={c.type} />
                              <TypeBadge type={c.type} />
                            </span>
                          </td>
                          <td>
                            {feeds.length > 0 ? (
                              <span className="src__feeds">
                                {feeds.map((feed) => {
                                  const landed = outputType.get(feed)
                                  return (
                                    <span className="src__feed" key={feed}>
                                      {feed}
                                      {landed && landed !== c.type ? (
                                        <span
                                          className="src__cast"
                                          title={`Read as ${c.type}, returned as ${landed}`}
                                        >
                                          {' → '}
                                          {landed}
                                        </span>
                                      ) : null}
                                    </span>
                                  )
                                })}
                              </span>
                            ) : (
                              <span className="src__only">read, not returned</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}

            {unmatched.length > 0 ? (
              <p className="src__note">
                {unmatched.length} reference{unmatched.length === 1 ? '' : 's'} could not be matched
                to a column here: <span className="mono-dim">{unmatched.join(', ')}</span>
              </p>
            ) : null}

            {unused.length > 0 ? (
              <details className="src__rest">
                <summary className="src__resthead">
                  {unused.length} column{unused.length === 1 ? '' : 's'} this definition does not
                  read
                </summary>
                <p className="src__restlist mono-dim">{unused.map((c) => c.name).join(', ')}</p>
              </details>
            ) : null}
          </section>
        )
      })}

      {others.length > 0 ? (
        <section className="card">
          <header className="card__head">
            <h3 className="card__title">
              {others.length} source{others.length === 1 ? '' : 's'} with no schema to show
            </h3>
          </header>
          <ul className="plain">
            {others.map((source) => (
              <li key={source.text} className="mono-dim">
                {source.kind === 'subquery' ? 'a subquery' : 'a table function'}
                {source.alias ? ` as ${source.alias}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

/** Who reads this object, column by column.
 *
 *  The mirror of the Sources tab, and the question you have when you are about
 *  to change something: if this column goes, what breaks. ClickHouse cannot
 *  answer it — it tracks a materialized view's dependencies and nothing else —
 *  so the readers come from the schema graph, which recovers plain views by
 *  reading their definitions, and each reader's own definition then says which
 *  of these columns it actually touches. */
function ReadBy({
  database,
  table,
  columns,
}: {
  database: string
  table: string
  columns: ColumnDetail[]
}) {
  // The same query key the database page uses, so arriving from the diagram
  // costs nothing.
  const graph = useQuery({ queryKey: ['graph', database], queryFn: () => api.graph(database) })

  const readers = useMemo(() => {
    const id = `${database}.${table}`
    const data = graph.data
    if (!data) return []
    const ids = data.edges
      .filter((edge) => edge.from === id && (edge.kind === 'reads' || edge.kind === 'loads'))
      .map((edge) => edge.to)
    return [...new Set(ids)]
      .map((rid) => data.nodes.find((node) => `${node.database}.${node.name}` === rid))
      .filter((node): node is NonNullable<typeof node> => Boolean(node))
  }, [graph.data, database, table])

  const details = useQueries({
    queries: readers.map((reader) => ({
      queryKey: ['table', reader.database, reader.name],
      queryFn: () => api.table(reader.database, reader.name),
    })),
  })

  /** Column of this table -> the readers that touch it, and what they call it. */
  const consumers = useMemo(() => {
    const map = new Map<string, { reader: string; database: string; feeds: string[] }[]>()
    readers.forEach((reader, i) => {
      const definition = analyseDefinition(details[i]?.data?.as_select ?? '')
      if (!definition) return
      const read = columnUsage(definition).get(table)
      if (!read) return
      for (const [column, feeds] of read) {
        const list = map.get(column) ?? []
        list.push({ reader: reader.name, database: reader.database, feeds })
        map.set(column, list)
      }
    })
    return map
    // Keyed on the definitions themselves rather than on the query objects,
    // which are new on every render.
  }, [readers, details.map((d) => d.data?.as_select).join('\u0000'), table])

  if (graph.error) return <ErrorNote error={graph.error} retry={() => void graph.refetch()} />
  if (graph.isPending) return <Loading label="Tracing who reads this" />

  if (readers.length === 0) {
    return (
      <EmptyNote title="Nothing reads this">
        No view, materialized view or dictionary in {database} selects from this object. Changing its
        columns breaks nothing else here.
      </EmptyNote>
    )
  }

  const pending = details.some((d) => d.isPending)
  const consumed = columns.filter((c) => consumers.has(c.name))
  const untouched = columns.filter((c) => !consumers.has(c.name))

  return (
    <div className="stack">
      <section className="card">
        <header className="card__head">
          <h3 className="card__title">
            Read by {readers.length} object{readers.length === 1 ? '' : 's'}
          </h3>
          <span className="src__facts">
            {pending
              ? 'reading their definitions'
              : `${consumed.length} of ${columns.length} columns consumed`}
          </span>
        </header>
        <ul className="plain">
          {readers.map((reader, i) => (
            <li key={`${reader.database}.${reader.name}`}>
              <Link
                className="link"
                to={`/db/${encodeURIComponent(reader.database)}/${encodeURIComponent(reader.name)}`}
              >
                {reader.name}
              </Link>
              <span className="src__alias"> {reader.engine}</span>
              {details[i]?.error ? (
                <span className="src__only"> · definition unavailable</span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {consumed.length > 0 ? (
        <section className="card">
          <header className="card__head">
            <h3 className="card__title">Columns something depends on</h3>
          </header>
          <div className="panel__scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Type</th>
                  <th>Read by</th>
                </tr>
              </thead>
              <tbody>
                {consumed.map((c) => (
                  <tr key={c.name}>
                    <td className="tbl__key">{c.name}</td>
                    <td>
                      <span className="tbl__head">
                        <TypeIcon type={c.type} />
                        <TypeBadge type={c.type} />
                      </span>
                    </td>
                    <td>
                      <span className="origin">
                        {(consumers.get(c.name) ?? []).map((use) => (
                          <span className="origin__ref" key={`${use.database}.${use.reader}`}>
                            <Link
                              className="link"
                              to={`/db/${encodeURIComponent(use.database)}/${encodeURIComponent(
                                use.reader,
                              )}`}
                            >
                              {use.reader}
                            </Link>
                            {use.feeds.length > 0 ? (
                              <span className="src__alias"> as {use.feeds.join(', ')}</span>
                            ) : (
                              <span className="src__only"> · in a join or a filter</span>
                            )}
                          </span>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {!pending && untouched.length > 0 ? (
        <section className="card">
          <header className="card__head">
            <h3 className="card__title">
              {untouched.length} column{untouched.length === 1 ? '' : 's'} nothing here reads
            </h3>
            <span className="src__facts">safe to change, as far as this database goes</span>
          </header>
          <p className="src__restlist mono-dim">{untouched.map((c) => c.name).join(', ')}</p>
        </section>
      ) : null}
    </div>
  )
}

function Partitions({ detail }: { detail: TableDetailResponse }) {
  const parts = detail.partitions
  if (parts.length === 0) {
    return (
      <EmptyNote title="No partitions">
        {detail.partition_key
          ? 'This table is partitioned but currently holds no active parts.'
          : 'This table is not partitioned. Add a PARTITION BY clause to split it on disk.'}
      </EmptyNote>
    )
  }
  const max = Math.max(...parts.map((p) => p.bytes), 1)

  return (
    <div className="panel">
      <div className="panel__bar">
        <span className="panel__count">
          {parts.length} {parts.length === 1 ? 'partition' : 'partitions'}
        </span>
        <span className="panel__spacer" />
        <span className="panel__hint">a partition can be detached or dropped on its own</span>
      </div>
      <div className="panel__scroll">
    <table className="tbl">
      <thead>
        <tr>
          <th>Partition</th>
          <th className="tbl--n">Parts</th>
          <th className="tbl--n">Rows</th>
          <th className="tbl--n">On disk</th>
          <th className="tbl--n">Ratio</th>
          <th>Last merge</th>
          <th className="tbl__bar">Share</th>
        </tr>
      </thead>
      <tbody>
        {parts.map((p) => (
          <tr key={p.partition}>
            <td className="tbl__key">{p.partition}</td>
            <td className="tbl--n">{p.parts}</td>
            <td className="tbl--n">{count(p.rows)}</td>
            <td className="tbl--n">{bytes(p.bytes)}</td>
            <td className="tbl--n mono-dim">{ratio(p.uncompressed_bytes, p.bytes) ?? <Dash />}</td>
            <td className="mono-dim">{shortTime(p.modified)}</td>
            <td className="tbl__bar">
              <ShareBar value={p.bytes} max={max} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
      </div>
    </div>
  )
}

function Ddl({ detail }: { detail: TableDetailResponse }) {
  // A view's CREATE statement is its definition, plus the column list ClickHouse
  // generates from that definition, plus the settings of the session that
  // created it. Printing both in full, one panel above the other, showed the
  // same SELECT twice — most of the page, said twice. So the definition leads
  // and the whole statement is one click away.
  const hasDefinition = Boolean(detail.as_select)

  return (
    <div className="stack">
      {hasDefinition ? (
        <>
          <SqlCard title="Definition" sql={detail.as_select} />
          <details className="fold">
            <summary className="fold__head">
              Full CREATE statement
              <span className="fold__hint">
                the definition above, with the column list ClickHouse derives from it and the
                settings of the session that created it
              </span>
            </summary>
            <SqlCard sql={detail.create_query} />
          </details>
        </>
      ) : (
        <SqlCard title="CREATE statement" sql={detail.create_query} />
      )}

      {detail.data_paths.length > 0 ? (
        <section className="card">
          <header className="card__head">
            <h3 className="card__title">Data paths</h3>
          </header>
          <ul className="plain">
            {detail.data_paths.map((path) => (
              <li key={path} className="mono-dim">
                {path}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

function SqlCard({ title, sql }: { title?: string; sql: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(sql).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }

  return (
    <section className="card">
      <header className={`card__head${title ? '' : ' card__head--bare'}`}>
        {title ? <h3 className="card__title">{title}</h3> : null}
        <button className="btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </header>
      <Sql sql={sql} />
    </section>
  )
}

/** SQL as something readable: broken into lines, and coloured the way the editor
 *  colours it. Deliberately not a CodeMirror instance — CodeMirror is two thirds
 *  of the bundle and lives in the editor's own lazily-loaded chunk. A table page
 *  should not drag it in to print one statement. */
function Sql({ sql }: { sql: string }) {
  const tokens = useMemo(() => tokenize(formatDdl(sql)), [sql])
  if (!sql.trim()) return <pre className="code code--sql">—</pre>

  return (
    <pre className="code code--sql">
      {tokens.map((token, i) =>
        token.kind === 'space' ? (
          token.text
        ) : (
          <span className={`sql--${token.kind}`} key={i}>
            {token.text}
          </span>
        ),
      )}
    </pre>
  )
}

/** The whole path this object sits on, drawn.
 *
 *  `Sources` and `Read by` answer about the immediate neighbours. The question
 *  that needs a whole tab is the one that spans them: where do these rows
 *  ultimately come from, and where do they ultimately end up.
 *
 *  This was a chain of rows, one hop per row, and the argument for it was that a
 *  chain is honest about depth in a way a picture is not. It was also, on the
 *  overwhelmingly common shape — one hop down to one view — four words and a
 *  pill in an otherwise empty tab, which is not a reading of anything. So the
 *  depth moved into the caption, where it is still stated, and the path itself
 *  is drawn by the same canvas the database page draws: same nodes, same
 *  engines, same panel when you click one, same full screen. There is no second
 *  diagram in this product, and there is no second answer to "what feeds this".
 *
 *  `lineageSubgraph` is the same function the database page's own "whole path
 *  through…" uses, so the two views cannot disagree about what the path is. */
function PathTab({ database, table }: { database: string; table: string }) {
  const graph = useQuery({
    queryKey: ['graph', database],
    queryFn: () => api.graph(database),
  })
  const id = `${database}.${table}`
  const path = useMemo(
    () => (graph.data ? lineagePath(graph.data, id) : null),
    [graph.data, id],
  )
  const drawn = useMemo(
    () => (graph.data ? lineageSubgraph(graph.data, id) : null),
    [graph.data, id],
  )

  if (graph.error) return <ErrorNote error={graph.error} retry={() => graph.refetch()} />
  if (!path || !drawn || !graph.data) return <Loading label="Following the arrows" />

  const { up, down } = depthOf(path)
  if (up === 0 && down === 0) {
    return (
      <EmptyNote title="Nothing feeds this, and nothing reads it">
        No view, materialized view or dictionary in this database refers to {table}, and it refers
        to nothing itself — so it sits on no path.
      </EmptyNote>
    )
  }

  /* The count follows the drawing, and the depths follow the count: "3 of 41
     objects" is what was kept, and the hops are how far it reaches in each
     direction — which is the one thing a picture of six boxes does not tell you
     at a glance. */
  const bar = (
    <div className="focusbar">
      <span className="focusbar__text">
        The whole path through <span className="focusbar__name">{table}</span>
        <span className="focusbar__rest">
          {' '}
          · {drawn.graph.nodes.length} of {graph.data.nodes.length} objects ·{' '}
          {up > 0 ? `${up} hop${up === 1 ? '' : 's'} back to a source` : 'nothing feeds this'} ·{' '}
          {down > 0 ? `${down} hop${down === 1 ? '' : 's'} on to a leaf` : 'nothing reads it'}
        </span>
      </span>
    </div>
  )

  return (
    <div className="lpath">
      <SchemaCanvas graph={drawn.graph} here={id} bar={bar} key={id} />

      {path.incomplete.length > 0 ? (
        <p className="lpath__note">
          {path.incomplete.map((s) => s.id).join(', ')}{' '}
          {path.incomplete.length === 1 ? 'lives' : 'live'} in another database. Flint loaded this
          database's schema, not theirs, so the path may continue past{' '}
          {path.incomplete.length === 1 ? 'it' : 'them'} — open{' '}
          {path.incomplete.length === 1 ? 'it' : 'one'} to keep following.
        </p>
      ) : null}
    </div>
  )
}

/** Looking at the actual rows.
 *
 *  `SELECT * LIMIT 200` answers one question and stops. What somebody meeting a
 *  table for the first time wants is what it holds *now*, what a typical row
 *  looks like, and what is in here matching something they care about — so this
 *  is a small explorer over one table, and it says what each choice costs. */
function Preview({
  database,
  table,
  columns,
  sortingKey,
  totalRows,
}: {
  database: string
  table: string
  columns: ColumnDetail[]
  sortingKey: string
  totalRows: number | null
}) {
  const info: ColumnInfo[] = useMemo(
    () => columns.map((c) => ({ name: c.name, type: c.type })),
    [columns],
  )
  const [spec, setSpec] = useState<ExploreSpec>(() =>
    startingSpec(database, table, info, sortingKey),
  )
  const [picking, setPicking] = useState(false)
  const [inspect, setInspect] = useState<number | null>(null)

  const sql = useMemo(() => exploreSql(spec, info), [spec, info])
  // The same question without the preview's limit: everything the reader chose,
  // and all the rows that match it.
  const fileSql = useMemo(() => exportSql(spec, info), [spec, info])
  const cost = useMemo(() => costOf(spec, info, sortingKey), [spec, info, sortingKey])
  const times = useMemo(() => timeColumns(info), [info])

  const rows = useQuery({
    queryKey: ['explore', sql],
    queryFn: () => api.run({ sql, database }),
    // Held while the next one loads, so changing a control does not blank the
    // table you are reading.
    placeholderData: (prev) => prev,
  })

  const patch = (change: Partial<ExploreSpec>) => setSpec((s) => ({ ...s, ...change }))

  return (
    <div className="explore">
      <div className="explore__bar">
        <div className="segmented" role="group" aria-label="Which rows">
          {([
            ['latest', 'Newest'],
            ['oldest', 'Oldest'],
            ['natural', 'Stored order'],
            ['random', 'Random'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              className={`segmented__item${spec.order === id ? ' is-on' : ''}`}
              aria-pressed={spec.order === id}
              disabled={(id === 'latest' || id === 'oldest') && times.length === 0}
              title={
                (id === 'latest' || id === 'oldest') && times.length === 0
                  ? 'This table has no date or datetime column to order by'
                  : undefined
              }
              onClick={() => patch({ order: id })}
            >
              {label}
            </button>
          ))}
        </div>

        {times.length > 1 && (spec.order === 'latest' || spec.order === 'oldest') ? (
          <label className="explore__field">
            <span className="label">BY</span>
            <select
              className="input"
              value={spec.timeColumn}
              onChange={(e) => patch({ timeColumn: e.target.value })}
            >
              {times.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="explore__field">
          <span className="label">ROWS</span>
          <select
            className="input"
            value={spec.limit}
            onChange={(e) => patch({ limit: Number(e.target.value) })}
          >
            {LIMITS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <button
          className={`btn${spec.columns.length > 0 ? ' is-on' : ''}`}
          onClick={() => setPicking((p) => !p)}
          aria-pressed={picking}
        >
          {spec.columns.length > 0
            ? `Reading ${spec.columns.length} of ${columns.length} columns`
            : 'Read fewer columns'}
        </button>

        <button
          className="btn"
          onClick={() =>
            patch({
              filters: [
                ...spec.filters,
                startingFilter(info[0]!, `f${spec.filters.length}-${Date.now()}`),
              ],
            })
          }
          disabled={info.length === 0}
        >
          Add a filter
        </button>
      </div>

      {picking ? (
        <div className="explore__columns">
          <p className="explore__hint">
            Reading fewer columns is the biggest saving a column store offers, and it is invisible
            unless somebody says so — the bytes below are what this actually read.
          </p>
          <div className="explore__chips">
            <button
              className={`chip${spec.columns.length === 0 ? ' is-on' : ''}`}
              onClick={() => patch({ columns: [] })}
            >
              all
            </button>
            {columns.map((c) => {
              const on = spec.columns.includes(c.name)
              return (
                <button
                  key={c.name}
                  className={`chip${on ? ' is-on' : ''}`}
                  onClick={() =>
                    patch({
                      columns: on
                        ? spec.columns.filter((n) => n !== c.name)
                        : [...spec.columns, c.name],
                    })
                  }
                >
                  {c.name}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      {spec.filters.length > 0 ? (
        <div className="explore__filters">
          {spec.filters.map((f) => (
            <FilterRow
              key={f.id}
              filter={f}
              columns={info}
              onChange={(next) =>
                patch({ filters: spec.filters.map((c) => (c.id === f.id ? next : c)) })
              }
              onRemove={() => patch({ filters: spec.filters.filter((c) => c.id !== f.id) })}
            />
          ))}
        </div>
      ) : null}

      {/* What this costs and why — the part a first-time reader cannot guess and
          an expert checks by habit. */}
      <p className={`explore__cost explore__cost--${cost.level}`}>{cost.says}</p>

      <details className="explore__sql">
        <summary>the statement</summary>
        <pre>{sql}</pre>
      </details>

      {rows.error ? <ErrorNote error={rows.error} retry={() => rows.refetch()} /> : null}
      {rows.isPending && !rows.data ? <Loading label="Reading rows" /> : null}

      {rows.data ? (
        rows.data.rows.length === 0 ? (
          <EmptyNote title="No rows match">
            {spec.filters.length > 0
              ? 'Nothing in this table satisfies every filter above.'
              : 'This table is empty.'}
          </EmptyNote>
        ) : (
          <>
            <div className="explore__notebar">
              <p className="explore__note label">
                {rows.data.rows.length} rows · {bytes(rows.data.statistics.bytes_read)} read ·{' '}
                {count(rows.data.statistics.rows_read)} rows scanned
                {rows.data.truncated ? ' · more behind this' : ''}
              </p>
              {/* Beside what the preview cost, because that is the line a
                  reader is already using to judge the size of what they are
                  looking at — and this one says the size of what they would
                  get instead. */}
              <Download
                sql={fileSql}
                database={database}
                stem={`${database}.${table}`}
                note={tableDownloadNote(totalRows, spec.filters.length > 0, rows.data.rows.length)}
              />
            </div>
            <div className="explore__grid">
              <ResultsGrid result={rows.data} />
            </div>
            {/* A wide row is unreadable across; the only way to read one is
                down. */}
            <div className="explore__rows">
              {rows.data.rows.slice(0, 12).map((_, i) => (
                <button
                  key={i}
                  className={`chip${inspect === i ? ' is-on' : ''}`}
                  onClick={() => setInspect(inspect === i ? null : i)}
                >
                  row {i + 1}
                </button>
              ))}
            </div>
            {inspect !== null && rows.data.rows[inspect] ? (
              <RowInspector
                columns={rows.data.columns}
                row={rows.data.rows[inspect]!}
                index={inspect}
                onClose={() => setInspect(null)}
              />
            ) : null}
          </>
        )
      ) : null}
    </div>
  )
}

function FilterRow({
  filter,
  columns,
  onChange,
  onRemove,
}: {
  filter: Condition
  columns: ColumnInfo[]
  onChange: (next: Condition) => void
  onRemove: () => void
}) {
  const type = columns.find((c) => c.name === filter.column)?.type ?? 'String'
  const ops = opsFor(type)
  return (
    <div className="explore__filter">
      <select
        className="input"
        value={filter.column}
        onChange={(e) => {
          const next = columns.find((c) => c.name === e.target.value)
          onChange(next ? { ...startingFilter(next, filter.id) } : filter)
        }}
      >
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
      <select
        className="input"
        value={filter.op}
        onChange={(e) => onChange({ ...filter, op: e.target.value as Condition['op'] })}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {OP_LABEL[op]}
          </option>
        ))}
      </select>
      {opTakesNoValue(filter.op) ? null : (
        <input
          className="input"
          value={filter.value}
          placeholder="value"
          onChange={(e) => onChange({ ...filter, value: e.target.value })}
        />
      )}
      {filter.op === 'between' ? (
        <input
          className="input"
          value={filter.value2}
          placeholder="and"
          onChange={(e) => onChange({ ...filter, value2: e.target.value })}
        />
      ) : null}
      <button className="btn" onClick={onRemove} aria-label="Remove this filter">
        ×
      </button>
    </div>
  )
}

/** One row, read down. Thirty-six columns across is not reading. */
function RowInspector({
  columns,
  row,
  index,
  onClose,
}: {
  columns: { name: string; type: string }[]
  row: unknown[]
  index: number
  onClose: () => void
}) {
  return (
    <section className="rowin">
      <header className="rowin__head">
        <h4 className="rowin__title">Row {index + 1}</h4>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </header>
      <dl className="rowin__body">
        {columns.map((c, i) => {
          const value = row[i]
          const empty = value === null || value === ''
          return (
            <div className="rowin__item" key={c.name}>
              <dt className="rowin__key">
                {c.name} <span className="mono-dim">{shortType(c.type)}</span>
              </dt>
              <dd className={`rowin__value${empty ? ' rowin__value--empty' : ''}`}>
                {value === null ? '∅ null' : value === '' ? '∅ empty' : String(value)}
              </dd>
            </div>
          )
        })}
      </dl>
    </section>
  )
}

function quote(identifier: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)
    ? identifier
    : `\`${identifier.replace(/`/g, '\\`')}\``
}

/** The headline figures an object actually has.
 *
 *  A view stores nothing, so rows, bytes, compression and parts are all absent
 *  for one — and four dashes across the widest band on the page say only that
 *  Flint asked the wrong questions. An absent figure is dropped rather than
 *  dashed, and a view is given the quantity it does have: how many objects it
 *  reads from. */
function headline(
  t: TableDetailResponse,
  rows: number,
  disk: number,
  compression: string | null,
): Metric[] {
  const out: Metric[] = []
  if (rows) out.push({ value: count(rows), label: 'rows' })
  if (disk) out.push({ value: bytes(disk), label: 'on disk' })
  if (compression) out.push({ value: compression, label: 'compression' })
  out.push({ value: exact(t.columns.length), label: 'columns' })
  if (t.parts) out.push({ value: exact(t.parts), label: partsLabel(t.parts, t.partitions.length) })
  if (!rows && !disk && t.depends_on.length > 0) {
    out.push({
      value: exact(t.depends_on.length),
      label: t.depends_on.length === 1 ? 'source' : 'sources',
    })
  }
  return out
}

/** The merged heading for the common case where the primary key is the sorting
 *  key. Kept as a constant because `explain.ts` keys its sentence on it. */
const BOTH_KEYS = 'order by · primary key'

const EXPLAIN_KEY = 'flint.explain'

/** Whether the teaching lines are wanted. On by default — the whole point is
 *  that nobody should have to already know what a sorting key is — but the
 *  answer is remembered, so nobody has to read it 170 times either. */
function explainWanted(): boolean {
  try {
    return localStorage.getItem(EXPLAIN_KEY) !== 'off'
  } catch {
    return true
  }
}

function rememberExplain(next: boolean): boolean {
  try {
    localStorage.setItem(EXPLAIN_KEY, next ? 'on' : 'off')
  } catch {
    /* the choice simply will not survive a reload */
  }
  return next
}
