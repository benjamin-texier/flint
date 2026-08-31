/** The database over time: tables against partitions.
 *
 *  The schema diagram answers "how does data move here". It cannot answer "when
 *  is this data from", because a dependency has no time axis — and time is the
 *  axis ClickHouse actually organises a table on. This is the other picture: one
 *  row per table, one column per partition, in order, with the weight of each
 *  cell drawn.
 *
 *  What it makes visible in one glance, none of which is legible in a total: a
 *  TTL's cut-off, a backfill that wrote six months in an afternoon, a hole where
 *  an ingest failed, and a partition carrying a hundred times the parts of its
 *  neighbours.
 *
 *  Everything here is pure so the grid can be tested without a browser. */

import { barScale, CELL_FLOOR } from './scale'

export interface PartitionCell {
  table: string
  /** The partition as ClickHouse prints it: `202605`, `('eu',2026)`, `all`. */
  partition: string
  partition_id: string
  parts: number
  /** How many partitions this cell covers: one at the partition grain, more
   *  wherever a coarser scale has folded several into a bucket. */
  partitions: number
  rows: number
  bytes: number
  uncompressed_bytes: number
  /** The range the parts actually cover, when there is one. Present whenever the
   *  server filled either of its two date pairs — the old `min_date` for a Date
   *  partition key or `min_time` for a DateTime one — and absent when it filled
   *  neither, which is absence rather than a zero. */
  covers_from?: string
  covers_to?: string
}

export interface TimelineTable {
  table: string
  partitions: number
  parts: number
  rows: number
  bytes: number
  /** Empty when the table has no partition key at all. */
  partition_key: string
}

export interface PartitionTimeline {
  available: boolean
  reason?: string
  tables: TimelineTable[]
  cells: PartitionCell[]
  total_tables: number
  total_bytes: number
  cells_truncated: boolean
  /** The grain these cells came back at. Read from the answer rather than from
   *  the request: a database whose parts carry no date is served its partitions
   *  whatever was asked for, and the control has to show what is on screen. */
  grain: Grain
  /** Whether a scale of time is possible here at all. */
  datable: boolean
  /** The ends of the range the drawn tables cover, for filling the axis in
   *  between. Absent where nothing is dated. */
  span_from?: string
  span_to?: string
  /** What a row is. The grid is the same grid at either scope — "which of these
   *  is growing" does not change shape when the things being asked about get
   *  bigger — but a row's name, its link and the word for a row all follow from
   *  this. */
  scope: Scope
}

export type Scope = 'database' | 'server'

/** What a row is called, in the singular and the plural. */
export const ROW_UNIT: Record<Scope, [string, string]> = {
  database: ['table', 'tables'],
  server: ['database', 'databases'],
}

export function rowUnit(scope: Scope, n: number): string {
  const [one, many] = ROW_UNIT[scope]
  return n === 1 ? one : many
}

/** How wide a column is. `partition` is the server's own unit; the rest are
 *  time, folded by the server, because a table partitioned daily for three years
 *  has a thousand columns and no amount of paging through them shows the shape
 *  of a year. */
export type Grain = 'partition' | 'day' | 'week' | 'month' | 'quarter' | 'year'

export const GRAINS: Grain[] = ['partition', 'day', 'week', 'month', 'quarter', 'year']

export const GRAIN_LABEL: Record<Grain, string> = {
  partition: 'Partitions',
  day: 'Days',
  week: 'Weeks',
  month: 'Months',
  quarter: 'Quarters',
  year: 'Years',
}

export const GRAIN_MEANING: Record<Grain, string> = {
  partition: 'One column per partition, named as ClickHouse names it',
  day: 'One column per day — a quarter of a year to a screen',
  week: 'One column per week, starting Monday — a year to a screen',
  month: 'One column per month — five years to a screen',
  quarter: 'One column per quarter',
  year: 'One column per year',
}

/** A naive timestamp from the server — `2026-05-28 04:15:37` — as a `Date` in
 *  UTC.
 *
 *  Naive on purpose. The server formatted its bucket labels in its own timezone
 *  and Flint has no business converting them: if the labels say `2026-05` then
 *  the sequence between them has to be built in the same frame, or a database on
 *  a server five hours from the browser gets an axis whose generated columns miss
 *  the observed ones by a month at every boundary. So both ends are read as UTC
 *  and every step below stays in UTC — which makes the arithmetic *consistent
 *  with the labels*, which is the only property that matters here. */
export function parseStamp(stamp: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(stamp.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, sec] = m
  return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +sec!))
}

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`

/** The bucket an instant falls in, spelled exactly as the server spells it.
 *
 *  These five formats are a contract with `clickhouse::timeline::Grain::column`:
 *  the client generates the columns *between* the observed ones, so a difference
 *  of one character produces two columns for one month — one from the server with
 *  data in it and one generated and always empty. Both sides are tested against
 *  these same strings. */
export function bucketOf(grain: Grain, at: Date): string {
  switch (grain) {
    case 'day':
      return iso(at)
    case 'week': {
      // Monday, as `toStartOfWeek(x, 1)` gives it. `getUTCDay()` is 0 on Sunday.
      const back = (at.getUTCDay() + 6) % 7
      const monday = new Date(at.getTime())
      monday.setUTCDate(monday.getUTCDate() - back)
      return iso(monday)
    }
    case 'month':
      return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}`
    case 'quarter':
      return `${at.getUTCFullYear()}-Q${Math.floor(at.getUTCMonth() / 3) + 1}`
    case 'year':
      return String(at.getUTCFullYear())
    // A partition has no arithmetic: its name is whatever the key made it, and
    // there is no sequence to walk. The axis is left as the buckets that exist.
    case 'partition':
      return ''
  }
}

/** The start of the bucket after this one. */
function step(grain: Grain, at: Date): Date {
  const next = new Date(at.getTime())
  switch (grain) {
    case 'day':
      next.setUTCDate(next.getUTCDate() + 1)
      break
    case 'week':
      next.setUTCDate(next.getUTCDate() + 7)
      break
    case 'month':
      next.setUTCMonth(next.getUTCMonth() + 1, 1)
      break
    case 'quarter':
      next.setUTCMonth(next.getUTCMonth() + 3, 1)
      break
    case 'year':
      next.setUTCFullYear(next.getUTCFullYear() + 1, 0, 1)
      break
    case 'partition':
      break
  }
  return next
}

/** A hard stop on generated columns. A single part with a corrupt date — 1997,
 *  or 2242 — would otherwise generate ninety thousand daily columns and hang the
 *  page. Past this the axis is left as the buckets that exist, which is what it
 *  was before, and the grid says the axis is not filled rather than pretending
 *  otherwise. */
const MAX_GENERATED = 1200

/** Every bucket between two instants, inclusive, in the server's own spelling.
 *
 *  Empty for the partition grain, which has no sequence, and empty when the
 *  range would generate more columns than any page can use — in both cases the
 *  caller falls back to the buckets that exist. */
export function bucketSequence(grain: Grain, from: string, to: string): string[] {
  if (grain === 'partition') return []
  const start = parseStamp(from)
  const end = parseStamp(to)
  if (!start || !end || end < start) return []

  const out: string[] = []
  let at = start
  let guard = 0
  while (at <= end) {
    out.push(bucketOf(grain, at))
    at = step(grain, at)
    if (++guard > MAX_GENERATED) return []
  }
  // The last bucket has to be there even when the loop's step overshot the end
  // by less than a bucket — a range ending on the 1st of a month is still that
  // month.
  const last = bucketOf(grain, end)
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

/** How many columns a window holds, per grain.
 *
 *  Not one number for all of them. The cap exists so a browser is not asked to
 *  lay out forty thousand cells, and any figure under a few hundred satisfies
 *  that — so the figure is free to be chosen for the reader instead, and what a
 *  reader wants from a page of columns is a period they can name. A window of
 *  ninety days is a quarter; fifty-two weeks is a year; sixty months is five
 *  years. Paging then moves by something somebody can hold in their head,
 *  rather than by "120 columns", which is not a period at all.
 *
 *  Partitions keep 120, because a partition is whatever the table's key made it
 *  and there is no period to round to. */
export const WINDOW: Record<Grain, number> = {
  partition: 120,
  day: 90,
  week: 52,
  month: 60,
  quarter: 40,
  year: 40,
}

/** What a cell's weight means. Three different questions of the same grid:
 *  bytes is "where is the disk", rows is "where is the data" — they disagree
 *  wherever compression does — and parts is "where is the merge pressure",
 *  which is the one that turns into an incident. */
export type Metric = 'bytes' | 'rows' | 'parts'

export const METRIC_LABEL: Record<Metric, string> = {
  bytes: 'On disk',
  rows: 'Rows',
  parts: 'Parts',
}

/** How many partitions are drawn at once. A daily-partitioned table three years
 *  old has a thousand of them, and a thousand columns is a texture rather than a
 *  grid — as well as forty thousand cells for a browser to lay out.
 *
 *  So the window is a cap on what is *on screen*, not on what can be reached: it
 *  opens on the newest partitions, because that is the end somebody is looking
 *  at, and it moves back through history a window at a time. It has to move,
 *  rather than simply reporting what it dropped — the old end is exactly where a
 *  retention policy shows up, which is the one thing this view is best at, and a
 *  cap that made it permanently unreachable would cut off the view's own best
 *  answer. */
export const COLUMN_LIMIT = 120


export interface GridCell {
  cell: PartitionCell
  value: number
  /** 0..1 against the scale, floored so anything present can be seen. */
  fill: number
  /** Past the scale: drawn full and marked, rather than pretending to fit. */
  past: boolean
}

export interface GridRow {
  table: TimelineTable
  /** One entry per column, `undefined` where the table holds nothing in that
   *  partition. Undefined, not zero: nothing there is not a value of zero. */
  cells: (GridCell | undefined)[]
  /** The table's own busiest cell, for reading a row on its own terms. */
  peak: number
}

/** Which slice of the partitions is on screen.
 *
 *  `offset` counts windows back from the newest, so 0 is where the grid opens
 *  and every larger number is further into history. Counting from the *new* end
 *  is deliberate: partitions arrive at that end, so an offset counted from the
 *  old end would silently mean a different slice every time a table is written
 *  to. */
export interface GridWindow {
  /** Windows back from the newest. */
  offset: number
  /** Columns per window. */
  limit: number
  /** Partitions the drawn tables hold in total. */
  total: number
  /** Partitions newer than this window, and older than it. */
  newer: number
  older: number
}

export interface Grid {
  /** Every column drawn, in order: the windowed timeline first, then any pinned
   *  column. */
  columns: string[]
  /** How many of the trailing columns are pinned rather than part of the
   *  timeline — at most one in practice, and zero on a database where every
   *  table has a partition key. */
  pinned: number
  rows: GridRow[]
  /** The value a full cell represents. */
  scale: number
  window: GridWindow
  /** Tables in this database with parts that the row cap left out. */
  omittedTables: number
  /** Share of the database's disk the drawn rows hold, 0..1. Null when the
   *  server did not report a total to compare against. */
  shareOfDisk: number | null
  /** Whether the axis is continuous: whether the columns are every bucket
   *  between the ends of the range, or only the buckets that have something in
   *  them. It matters to what an empty row means — with a filled axis a gap is a
   *  gap, and without one it is a bucket that was never drawn. */
  axisFilled: boolean
  /** Columns in which no drawn table holds anything at all. Only ever more than
   *  zero on a filled axis, where they are the whole point. */
  emptyColumns: number
  /** The grid is incomplete for a table that *is* drawn — a worse kind of
   *  missing than a capped row count, so it is carried separately. */
  cellsTruncated: boolean
}

/** The columns that are not points in time, and so are pinned beside the
 *  timeline rather than placed in it.
 *
 *  Two things end up here. A table with no partition key at all: ClickHouse
 *  prints that two ways and Flint meets both — `system.parts.partition` is the
 *  key expression's value, which for an empty tuple is the literal `tuple()`,
 *  while `partition_id`, the string every ALTER takes, is `all`. And, at a scale
 *  of time, every part whose range the server never wrote down: those hold real
 *  disk, so they get a column of their own instead of dropping out of a picture
 *  of the whole database. */
const UNPLACEABLE = new Set(['all', 'tuple()', 'undated'])

/** What a column of the grid is called.
 *
 *  `tuple()` at the head of a column is the server being literal about an empty
 *  key, and it is unreadable in a header two characters wider than a month. The
 *  id is the name that means something — it is what a `DROP PARTITION ID` would
 *  take — so that is what the column carries, with the server's own expression
 *  kept in the title. */
export function columnLabel(partition: string): string {
  return partition === 'tuple()' ? 'all' : partition
}

/** The labels for a row of column heads, which is not the same as each column's
 *  name taken on its own.
 *
 *  A daily axis names every column `2026-05-27`, and ten characters do not fit in
 *  a cell's width — so ninety columns arrive clipped to `2026-0…`, which is
 *  ninety identical headers and no axis at all. The answer is the one a chart
 *  axis uses: drop what repeats. The day is what changes, so `05-27` is what is
 *  drawn.
 *
 *  The year is dropped from every column rather than kept on the first, which
 *  was the first attempt: `2026-05-27` does not fit in a cell whether it is the
 *  first column or the ninetieth, so keeping it there bought a clipped header
 *  instead of a legible one. It goes in the line above the grid, where there is
 *  room for it — see `spanLine` — and it stays on every column's title.
 *
 *  Only the date grains are shortened. A partition's name is the server's and is
 *  not Flint's to trim; a month, quarter and year already fit. */
export function columnLabels(columns: readonly string[], grain: Grain = 'partition'): string[] {
  if (grain !== 'day' && grain !== 'week') return columns.map((c) => columnLabel(c))
  return columns.map((c) => {
    const iso = /^\d{4}-(\d{2}-\d{2})$/.exec(c)
    return iso ? iso[1]! : columnLabel(c)
  })
}

/** Order two partitions as the server named them.
 *
 *  A partition is an opaque string ClickHouse chose, and lexicographic order is
 *  chronological exactly when the key is a date expression — `toYYYYMM` gives
 *  `202604` < `202605`, which is both. Two things are worth handling beyond
 *  that: digit runs compare as numbers, so a `toYear`-style key does not put
 *  `9` after `10`; and the partition of an unpartitioned table sorts last,
 *  because it is not a point in time.
 *
 *  Nothing here parses a date out of an identifier the server never promised
 *  was one. The view says so in its caption rather than guessing. */
export function comparePartitions(a: string, b: string): number {
  if (a === b) return 0
  const un = (s: string) => UNPLACEABLE.has(s)
  if (un(a) && un(b)) return a < b ? -1 : 1
  if (un(a)) return 1
  if (un(b)) return -1
  const chunks = (s: string) => s.match(/\d+|\D+/g) ?? [s]
  const left = chunks(a)
  const right = chunks(b)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]!
    const y = right[i]!
    const bothNumeric = /^\d+$/.test(x) && /^\d+$/.test(y)
    if (bothNumeric) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return left.length - right.length
}

export function metricValue(cell: PartitionCell, metric: Metric): number {
  return metric === 'bytes' ? cell.bytes : metric === 'rows' ? cell.rows : cell.parts
}

/** True when the table has no partition key: everything it holds is in one
 *  partition ClickHouse calls `all`. Worth saying on the row, because a lone
 *  cell in a grid of months reads as a date until something says otherwise. */
export function notPartitioned(table: TimelineTable): boolean {
  return table.partition_key.trim() === ''
}

/** Which columns a window lands on.
 *
 *  Clamped rather than wrapped or refused: an offset past the oldest partition
 *  comes back as the oldest window, so a control that is one click from the end
 *  cannot leave the grid empty. */
export function windowOf(
  all: readonly string[],
  limit: number,
  offset: number,
): { columns: string[]; window: GridWindow } {
  const size = Math.max(1, limit)
  const windows = Math.max(1, Math.ceil(all.length / size))
  const at = Math.min(Math.max(0, Math.floor(offset)), windows - 1)
  const end = Math.max(0, all.length - at * size)
  const start = Math.max(0, end - size)
  return {
    columns: all.slice(start, end),
    window: {
      offset: at,
      limit: size,
      total: all.length,
      newer: all.length - end,
      older: start,
    },
  }
}

/** Lay the report out as a grid. */
export function buildGrid(
  report: PartitionTimeline,
  metric: Metric,
  view: { limit?: number; offset?: number } = {},
): Grid {
  const observed = new Set(report.cells.map((c) => c.partition))
  /* The axis is every bucket between the ends of the range, not only the buckets
     with something in them. Without this a month nothing was written in has no
     column at all, so the gap closes up and the view cannot show the one thing
     it advertises — a hole where an ingest failed. Generated columns are added
     to the observed ones rather than replacing them: the server's answer is the
     truth about what exists, and this only fills the space between. */
  const filled =
    report.grain !== 'partition' && report.span_from && report.span_to
      ? bucketSequence(report.grain, report.span_from, report.span_to)
      : []
  for (const bucket of filled) observed.add(bucket)
  const every = [...observed].sort(comparePartitions)
  /* The unpartitioned column is pinned rather than windowed.
     It is not a point in time, so it has no place in a sequence of them — and
     without pinning it travels with whichever window happens to hold the newest
     partitions, which means paging back into history turns every unpartitioned
     table into an empty row. An empty row reads as "this table holds nothing",
     which is exactly wrong: it holds everything it has, in the column you have
     just scrolled away from. */
  const timed = every.filter((p) => !UNPLACEABLE.has(p))
  const pinned = every.filter((p) => UNPLACEABLE.has(p))
  const { columns: timeline, window } = windowOf(
    timed,
    view.limit ?? WINDOW[report.grain] ?? COLUMN_LIMIT,
    view.offset ?? 0,
  )
  const columns = [...timeline, ...pinned]
  const kept = new Set(columns)
  const index = new Map(columns.map((p, i) => [p, i]))

  /* The same scale rule as the stratum bar, and for the same reason: one
     backfilled partition holding three years of history is a hundred times its
     neighbours, and scaling to the maximum would round every ordinary month to
     an invisible square. The handful above the 90th percentile are drawn full
     and marked as running past it. */
  const scale = barScale(
    report.cells.filter((c) => kept.has(c.partition)).map((c) => metricValue(c, metric)),
  )

  const byTable = new Map<string, PartitionCell[]>()
  for (const cell of report.cells) {
    if (!kept.has(cell.partition)) continue
    const list = byTable.get(cell.table)
    if (list) list.push(cell)
    else byTable.set(cell.table, [cell])
  }

  const rows: GridRow[] = report.tables.map((table) => {
    const cells: (GridCell | undefined)[] = new Array(columns.length).fill(undefined)
    let peak = 0
    for (const cell of byTable.get(table.table) ?? []) {
      const at = index.get(cell.partition)
      if (at === undefined) continue
      const value = metricValue(cell, metric)
      peak = Math.max(peak, value)
      cells[at] = {
        cell,
        value,
        fill: scale > 0 && value > 0 ? Math.max(CELL_FLOOR, Math.min(1, value / scale)) : 0,
        past: scale > 0 && value > scale,
      }
    }
    return { table, cells, peak }
  })

  const drawnBytes = report.tables.reduce((sum, t) => sum + t.bytes, 0)
  const emptyColumns = columns.filter((_, i) => rows.every((r) => !r.cells[i])).length

  return {
    columns,
    pinned: pinned.length,
    rows,
    scale,
    window,
    omittedTables: Math.max(0, report.total_tables - report.tables.length),
    shareOfDisk: report.total_bytes > 0 ? drawnBytes / report.total_bytes : null,
    axisFilled: filled.length > 0,
    emptyColumns,
    cellsTruncated: report.cells_truncated,
  }
}

/** What a column is, in the singular and the plural. Every sentence about this
 *  grid has to agree with the scale it is on: a line that counts "partitions"
 *  over a row of months is a line that describes a different picture. */
export const UNIT: Record<Grain, [string, string]> = {
  partition: ['partition', 'partitions'],
  day: ['day', 'days'],
  week: ['week', 'weeks'],
  month: ['month', 'months'],
  quarter: ['quarter', 'quarters'],
  year: ['year', 'years'],
}

export function unit(grain: Grain, n: number): string {
  const [one, many] = UNIT[grain]
  return n === 1 ? one : many
}

/** What the pinned column is called, which depends on why it is pinned: at the
 *  server's own grain it is a table with no partition key, and at a scale of
 *  time it is a part whose range was never recorded. */
export function pinnedName(grain: Grain): string {
  return grain === 'partition' ? 'the unpartitioned column' : 'the undated column'
}

/** What is on screen, in one sentence.
 *
 *  Counts follow the list, which on this grid takes some care: the pinned column
 *  is drawn but is not one of the columns the window is counting through, so
 *  including it in "4 of 12" would give a figure that cannot be reconciled with
 *  either the columns or the total. It is named separately instead. */
export function spanLine(
  grid: Grid,
  grain: Grain = 'partition',
  scope: Scope = 'database',
): string {
  const tables = `${grid.rows.length} ${rowUnit(scope, grid.rows.length)}`
  const shown = grid.columns.length - grid.pinned
  /* Nothing on the time axis at all — every column is the pinned one. Said as a
     fact about the tables rather than as a count of columns: "3 tables across 0
     partitions, plus the unpartitioned column" is a sentence that contradicts
     itself in eight words, and it is what a database partitioned by nothing
     produced until this branch was actually rendered. */
  if (shown === 0 && grid.pinned > 0) {
    return `${tables}, none of them ${grain === 'partition' ? 'partitioned' : 'dated'}`
  }
  const windowed = grid.window.older > 0 || grid.window.newer > 0
  const columns = windowed
    ? `${shown} of ${grid.window.total} ${unit(grain, grid.window.total)}`
    : `${shown} ${unit(grain, shown)}`
  const pinned = grid.pinned > 0 ? `, plus ${pinnedName(grain)}` : ''
  /* The window's ends, spelled out, on the grains whose column heads had to give
     the year up to stay legible. This is the one line on the view with room for
     ten characters, so it is where the year lives. */
  const dated = grid.columns.slice(0, shown)
  const ends =
    (grain === 'day' || grain === 'week') && dated.length > 0
      ? ` · ${dated[0]} to ${dated[dated.length - 1]}`
      : ''
  return `${tables} across ${columns}${pinned}${ends}`
}

/** Everything the grid is not showing, as phrases to print under it.
 *
 *  Each cap states its own count. A grid silently holding back 90 tables and 200
 *  partitions reads as the whole database, which is the one thing it must never
 *  do. Nothing left out means nothing said — a caption that reports zero
 *  omissions on every screen is a caption nobody reads. */
export function leftOut(
  grid: Grid,
  grain: Grain = 'partition',
  scope: Scope = 'database',
): string[] {
  const out: string[] = []
  if (grid.omittedTables > 0) {
    out.push(`${grid.omittedTables} smaller ${rowUnit(scope, grid.omittedTables)} not drawn`)
  }
  /* Said as "before" and "after these" rather than as a total, because with a
     window that moves the reader's question is which way the rest lies. */
  if (grid.window.older > 0) {
    out.push(`${grid.window.older} older ${unit(grain, grid.window.older)} before these`)
  }
  if (grid.window.newer > 0) {
    out.push(`${grid.window.newer} newer ${unit(grain, grid.window.newer)} after these`)
  }
  /* Not an omission — the opposite. But it belongs in the same line, because a
     reader looking at a run of empty columns wants to know whether that is the
     data or the drawing, and this is where the picture accounts for itself. */
  if (grid.emptyColumns > 0) {
    out.push(
      `${grid.emptyColumns} ${unit(grain, grid.emptyColumns)} with nothing in any ${rowUnit(
        scope,
        1,
      )} drawn`,
    )
  }
  if (grid.cellsTruncated) {
    out.push(
      `some ${UNIT[grain][1]} of the ${rowUnit(scope, 2)} drawn are missing — this is past the cell cap`,
    )
  }
  return out
}
