import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { bytes, count, exact, ratio } from '../lib/format'
import {
  GRAINS,
  GRAIN_LABEL,
  GRAIN_MEANING,
  METRIC_LABEL,
  buildGrid,
  columnLabel,
  columnLabels,
  leftOut,
  metricValue,
  notPartitioned,
  rowUnit,
  spanLine,
  unit,
  type Grain,
  type Grid,
  type GridCell,
  type GridRow,
  type Metric,
  type PartitionTimeline,
} from '../lib/timeline'
import { internalName } from '../lib/explain'
import { sparkline } from '../lib/spark'
import { EmptyNote } from './Note'

/** The database drawn on its other axis: time.
 *
 *  The schema diagram shows how data moves and cannot show when it is from — a
 *  dependency is permanent and has no date. This is the complement: one row per
 *  table, one column per partition, in order, with the weight of each cell drawn.
 *  A TTL's cut-off, a backfill, a hole where an ingest failed and a partition
 *  carrying a hundred times the parts of its neighbours are all one glance here
 *  and invisible in every total on the page above.
 *
 *  A real `<table>` rather than a grid of divs: this is tabular data with a
 *  header in both directions, and the row and column headers are what let it be
 *  read at all by anything that is not a pair of eyes. */
export function PartitionGrid({
  report,
  database,
  onGrain,
}: {
  report: PartitionTimeline
  /** The database a row belongs to, for its link. Ignored at server scope,
   *  where a row *is* a database. */
  database: string
  /** Changing the scale is a different question to the server, so the grain
   *  lives with whoever owns the query rather than here. */
  onGrain: (grain: Grain) => void
}) {
  const [metric, setMetric] = useState<Metric>('bytes')
  /* Windows back from the newest partitions, which is where the grid opens.
     Keyed on the database by the page above, so moving to another one starts at
     the newest end again rather than at an offset that meant something on a
     database with three years of history. */
  const [offset, setOffset] = useState(0)
  /* Twelve months back is not twelve partitions back. Changing the scale starts
     at the newest end again rather than keeping a number that meant something
     about the other one. */
  const setGrain = (next: Grain) => {
    setOffset(0)
    onGrain(next)
  }
  const grid = useMemo(() => buildGrid(report, metric, { offset }), [report, metric, offset])
  const omissions = leftOut(grid, report.grain, report.scope)
  /* The heads are labelled as a row rather than one at a time: what a column is
     called depends on what its neighbour was called. */
  const heads = columnLabels(grid.columns, report.grain)
  const windowed = grid.window.older > 0 || grid.window.newer > 0

  if (!report.available) {
    return (
      <EmptyNote title="No partitions to draw">
        {report.reason ?? 'system.parts cannot be read here'}, so this database has no time axis
        to show. The schema diagram is unaffected.
      </EmptyNote>
    )
  }

  /* Nothing with parts is a real answer — a database of views, or one nobody
     has written to yet — and it is said in a sentence rather than as an empty
     grid, which reads as a view that failed to load. */
  if (grid.rows.length === 0) {
    return (
      <EmptyNote title="Nothing stored yet">
        No {rowUnit(report.scope, 1)}
        {report.scope === 'database' ? ` in ${database}` : ' on this server'} holds an active part,
        so there is nothing to lay out over time.
      </EmptyNote>
    )
  }

  const dated = grid.columns.some((c) => c !== 'tuple()' && c !== 'all' && c !== 'undated')

  return (
    <div className="ptime">
      <div className="ptime__bar">
        <p className="ptime__text">
          {spanLine(grid, report.grain, report.scope)}
          {grid.shareOfDisk !== null && grid.omittedTables > 0 ? (
            <span className="ptime__rest">
              {' '}
              · {Math.round(grid.shareOfDisk * 100)}% of the disk in this database
            </span>
          ) : null}
        </p>
        <span className="panel__spacer" />
        {/* Only where there is history to reach. A pair of controls that can
            never do anything is a pair of controls that teaches people this
            grid has nothing more to show. */}
        {windowed ? (
          <div className="ptime__nav" role="group" aria-label="Which partitions are drawn">
            <button
              className="btn"
              disabled={grid.window.older === 0}
              title={`${grid.window.older} older ${unit(report.grain, grid.window.older)} before these`}
              onClick={() => setOffset((o) => o + 1)}
            >
              ← Older
            </button>
            <button
              className="btn"
              disabled={grid.window.newer === 0}
              title={`${grid.window.newer} newer ${unit(report.grain, grid.window.newer)} after these`}
              onClick={() => setOffset((o) => Math.max(0, o - 1))}
            >
              Newer →
            </button>
          </div>
        ) : null}
        {/* Only where the parts carry a date. Three scales that would all
            collapse into one `undated` column is not a choice, so the control
            says why instead of offering it. */}
        {report.datable ? (
          <div className="segmented" role="group" aria-label="How wide a column is">
            {GRAINS.map((g) => (
              <button
                key={g}
                className={`segmented__item${report.grain === g ? ' is-on' : ''}`}
                aria-pressed={report.grain === g}
                title={GRAIN_MEANING[g]}
                onClick={() => setGrain(g)}
              >
                {GRAIN_LABEL[g]}
              </button>
            ))}
          </div>
        ) : (
          <span
            className="label"
            title="No part in this database carries a date range, so there is no time to fold columns into. A table partitioned by something other than a date, or by nothing at all, has none."
          >
            no date to scale by
          </span>
        )}
        <div className="segmented" role="group" aria-label="What a cell weighs">
          {(['bytes', 'rows', 'parts'] as Metric[]).map((m) => (
            <button
              key={m}
              className={`segmented__item${metric === m ? ' is-on' : ''}`}
              aria-pressed={metric === m}
              title={cellMeaning(report.grain, m)}
              onClick={() => setMetric(m)}
            >
              {METRIC_LABEL[m]}
            </button>
          ))}
        </div>
      </div>

      <p className="ptime__legend">
        {cellMeaning(report.grain, metric)} A cell is drawn against the 90th percentile, so one
        backfilled {unit(report.grain, 1)} cannot flatten the rest; the few above it are drawn full
        and marked. An empty square is a {unit(report.grain, 1)} the {rowUnit(report.scope, 1)} has
        nothing in — which is a retention policy or a failed ingest, and never a zero. The line
        beside each name is that row's own shape, scaled to <em>its</em> peak rather than to the
        grid's — growing, flat or stopped is a question about one {rowUnit(report.scope, 1)}, and a
        row flattened against its largest neighbour would only repeat what the squares already say.
      </p>

      <div className="ptime__scroll">
        <table className="ptime__table">
          <caption className="sr-only">
            Every {rowUnit(report.scope, 1)}
            {report.scope === 'database' ? ` in ${database}` : ' on this server'} against the
            partitions it holds, weighed by {METRIC_LABEL[metric].toLowerCase()}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="ptime__corner">
                {report.scope === 'server' ? 'Database' : 'Table'}
              </th>
              {grid.columns.map((partition, i) => (
                <th
                  key={partition}
                  scope="col"
                  /* The pinned column is set apart by a rule, because it is the
                     one column that is not a point in time and the row of
                     months beside it would otherwise read as if it were the
                     next one along. */
                  className={`ptime__col${isPinned(grid, i) ? ' ptime__col--pinned' : ''}`}
                  title={isPinned(grid, i) ? PINNED_MEANING(partition) : partition}
                >
                  <span className="ptime__collabel">{heads[i]}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row) => (
              <tr key={row.table.table}>
                <th scope="row" className="ptime__row">
                  <Link
                    className="objlink"
                    to={
                      report.scope === 'server'
                        ? `/db/${encodeURIComponent(row.table.table)}`
                        : `/db/${encodeURIComponent(database)}/${encodeURIComponent(
                            row.table.table,
                          )}`
                    }
                  >
                    {row.table.table}
                  </Link>
                  <span className="ptime__rowsub">
                    {/* A database has no partition key — its tables each have
                        their own — so the row says how many partitions it holds
                        and stops there. "Not partitioned" under a database name
                        would be a claim about nothing. */}
                    {report.scope === 'server' ? (
                      <span>
                        {exact(row.table.partitions)}{' '}
                        {row.table.partitions === 1 ? 'partition' : 'partitions'}
                      </span>
                    ) : notPartitioned(row.table) ? (
                      /* One cell called `all` in a row of months reads as a
                         date until something says otherwise. */
                      <span title="This table has no PARTITION BY, so every part it has is in the partition ClickHouse calls `all`">
                        not partitioned
                      </span>
                    ) : (
                      <span title={`PARTITION BY ${row.table.partition_key}`}>
                        {exact(row.table.partitions)}{' '}
                        {row.table.partitions === 1 ? 'partition' : 'partitions'}
                      </span>
                    )}
                    {internalName(row.table.table) ? (
                      <span
                        className="ptime__inner"
                        title="ClickHouse keeps a materialized view's rows in a table of its own. That disk is real, so it is drawn."
                      >
                        · view storage
                      </span>
                    ) : null}
                    <span className="panel__spacer" />
                    <Spark row={row} metric={metric} grain={report.grain} pinned={grid.pinned} />
                  </span>
                </th>
                {row.cells.map((cell, i) => (
                  <Cell
                    key={grid.columns[i]}
                    cell={cell}
                    partition={grid.columns[i]!}
                    table={row.table.table}
                    metric={metric}
                    pinned={isPinned(grid, i)}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="ptime__caption">
        {report.grain !== 'partition'
          ? 'Columns are ' +
            GRAIN_LABEL[report.grain].toLowerCase() +
            ', folded by the server' +
            (grid.axisFilled
              ? ' — every one between the ends of the range, so a run of empty squares is a stretch with nothing written in it rather than a stretch nobody drew'
              : '') +
            '. A part sits in the bucket its earliest row falls in — a part can straddle two, and where it starts is the only placement the server can give without reading the data. Its real range is on the cell.'
          : dated
            ? 'Partitions in the order ClickHouse names them, which is chronological wherever the key is a date expression — a partition id is an opaque string and nothing here parses a date out of one.'
            : 'This database partitions by something that is not a date, so the columns are in name order rather than in time order.'}
        {omissions.length ? <span className="ptime__left"> · {omissions.join(' · ')}</span> : null}
      </p>
    </div>
  )
}

/** What the weight means, said once and reused as the control's own tooltip: the
 *  three metrics are three different questions, and which one is on decides what
 *  the grid is showing you.
 *
 *  Computed rather than tabulated. The table it replaces was a second list of
 *  grains, hard-coded here, and adding `quarter` to the real one left this one
 *  behind — so `CELL_MEANING['quarter']` was undefined and reading a metric off
 *  it threw. The cast to `Record<Grain, …>` is what let it past the type check,
 *  which is the argument against writing one: a lookup with no list to forget
 *  cannot fall out of step with `GRAINS`. */
function cellMeaning(grain: Grain, metric: Metric): string {
  const one = unit(grain, 1)
  return metric === 'bytes'
    ? `Each cell is what that ${one} takes on disk.`
    : metric === 'rows'
      ? `Each cell is the rows in that ${one} — which disagrees with disk wherever compression does.`
      : `Each cell is the parts in that ${one}, which is where merge pressure shows before it becomes a failed insert.`
}

/** One row's shape, beside its name.
 *
 *  Drawn over the columns that are on screen and in their order, so the line and
 *  the squares are the same picture — a sparkline over the whole history beside a
 *  windowed row would be two answers to one question. Nothing is drawn where
 *  there is nothing to draw: a table with one bucket has a dot, and a table with
 *  none has no line rather than a flat one on the floor, which would say it held
 *  nothing rather than that nothing is known. */
function Spark({
  row,
  metric,
  grain,
  pinned,
}: {
  row: GridRow
  metric: Metric
  grain: Grain
  /** Trailing columns that are not points in time. Left out of the line: an
   *  unpartitioned table's one bucket is not the latest period, and a line that
   *  climbed to it would say the table's data arrived at the right-hand end of
   *  time. A table with nothing *in* time therefore has no line at all, which is
   *  the honest answer rather than a dot floating outside the axis. */
  pinned: number
}) {
  const W = 84
  const H = 14
  const timed = pinned > 0 ? row.cells.slice(0, row.cells.length - pinned) : row.cells
  const spark = sparkline(
    timed.map((c) => c?.value),
    { width: W, height: H },
  )
  if (spark.peak <= 0) return null

  const label = metric === 'bytes' ? bytes(spark.peak) : exact(spark.peak)
  return (
    <svg
      className="ptime__spark"
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${row.table.table} over the ${unit(grain, 2)} drawn, peaking at ${label}`}
    >
      {spark.segments.map((points) => (
        <polyline key={points} className="ptime__sparkline" points={points} />
      ))}
      {spark.dots.map((d) => (
        <circle key={`${d.x},${d.y}`} className="ptime__sparkdot" cx={d.x} cy={d.y} r={1.6} />
      ))}
    </svg>
  )
}

/** Why a column sits beside the timeline rather than in it. Two different
 *  facts, and a reader who is told the wrong one goes looking for a partition
 *  key that is not the problem. */
function PINNED_MEANING(partition: string): string {
  return partition === 'undated'
    ? 'undated — parts whose date range the server never recorded. They hold real disk, so they keep a column instead of dropping out of a picture of the whole database.'
    : `${partition} — the partition of a table with no PARTITION BY. ClickHouse calls its id \`all\`, and it is kept in view whichever partitions the window is on.`
}

/** Whether a column is the pinned one: the pinned columns are the trailing ones,
 *  so this is an index test rather than a name test — the name it carries is the
 *  server's and Flint does not decide it. */
function isPinned(grid: Grid, i: number): boolean {
  return i >= grid.columns.length - grid.pinned
}

function Cell({
  cell,
  partition,
  table,
  metric,
  pinned,
}: {
  cell: GridCell | undefined
  partition: string
  table: string
  metric: Metric
  pinned: boolean
}) {
  /* Absent is drawn as absent. The house rule elsewhere is that a missing
     figure is dropped rather than dashed; here it is the hole in the row that
     carries the information, so it is left as a hole. */
  if (!cell) {
    return (
      <td className={`ptime__cell${pinned ? ' ptime__cell--pinned' : ''}`}>
        <span
          className="pmark pmark--absent"
          title={`${table} has nothing in ${columnLabel(partition)}`}
          aria-hidden="true"
        />
        <span className="sr-only">nothing</span>
      </td>
    )
  }

  const c = cell.cell
  const compression = ratio(c.uncompressed_bytes, c.bytes)
  const range = c.covers_from && c.covers_to ? `${c.covers_from} → ${c.covers_to}` : null
  const title = [
    `${table} · ${columnLabel(partition)}`,
    `${bytes(c.bytes)} on disk${compression ? ` · ${compression}` : ''}`,
    `${count(c.rows)} rows · ${exact(c.parts)} ${c.parts === 1 ? 'part' : 'parts'}`,
    // Said only where it is more than one: "in 1 partition" on every cell of a
    // partition-grained grid is a line that tells nobody anything.
    c.partitions > 1 ? `across ${exact(c.partitions)} partitions` : null,
    range,
    cell.past ? 'past the scale — drawn full' : null,
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <td className={`ptime__cell${pinned ? ' ptime__cell--pinned' : ''}`}>
      <span
        className={`pmark${cell.past ? ' pmark--past' : ''}`}
        style={{ '--fill': cell.fill } as React.CSSProperties}
        title={title}
        aria-hidden="true"
      />
      <span className="sr-only">
        {metric === 'bytes'
          ? bytes(metricValue(c, metric))
          : exact(metricValue(c, metric))}
      </span>
    </td>
  )
}
