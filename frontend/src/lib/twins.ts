/** Two tables holding the same thing.
 *
 *  `src/clickhouse/twins.rs` measures it — one shape, one database, one row
 *  count to within 2% — and the module header there records why the first two
 *  conditions are not enough on their own. This file decides what may be said,
 *  and the whole difficulty is in one sentence: **a copy is not necessarily
 *  waste.**
 *
 *  Measured against ClickHouse's own demo server, the reading finds exactly two
 *  sets and both are real: `hits`, `hits_full_projection` and
 *  `hits_index_projection` hold 99,997,497 rows each, and `query_log_sharded`
 *  and `query_log_plain` differ by 0.06%. Both are also, obviously, deliberate —
 *  they are alternative *layouts* of one dataset, which is exactly what a copy
 *  nobody deleted looks like from the outside.
 *
 *  So the sentence says what is on the disk and never what to do with it. The
 *  reader knows whether `events_v2` replaced `events` in March; Flint cannot, and
 *  a tool that guesses at that is a tool that eventually tells somebody to drop
 *  the wrong table.
 */

export interface Twin {
  table: string
  rows: number
  bytes: number
  modified: string
}

export interface TwinSet {
  database: string
  columns: number
  /** Heaviest first. Not the original first — nothing here can tell. */
  tables: Twin[]
  row_spread: number
  /** The least dropping the rest gives back, whichever copy survives. */
  redundant_bytes: number
  total_bytes: number
}

export interface TwinReport {
  available: boolean
  reason?: string
  sets: TwinSet[]
  total_sets: number
  total_redundant_bytes: number
  spread_allowed: number
  row_floor: number
}

/** Below this a set is not worth a place on a board.
 *
 *  A gigabyte. Two 40 MiB copies of a lookup table are true, harmless and
 *  crowding: the reading is for disk somebody would notice, and the database's
 *  own page has no floor because there it is the answer rather than one finding
 *  among thirty. */
const FLOOR_BYTES = 1024 * 1024 * 1024

/** The sets worth a finding, costliest first. */
export function notable(report: TwinReport, floorBytes = FLOOR_BYTES): TwinSet[] {
  if (!report.available) return []
  return report.sets.filter((s) => s.redundant_bytes >= floorBytes)
}

/** How alike the row counts are, in words.
 *
 *  Exactness is worth distinguishing: identical counts are a copy, and counts a
 *  fraction apart are a copy that was taken while the source was still being
 *  written — which is a *more* interesting finding, because it means the
 *  migration may still be running. */
export function saysRows(set: TwinSet): string {
  if (set.row_spread === 0) return 'exactly the same number of rows'
  const pct = set.row_spread * 100
  const said = pct < 0.1 ? 'within a tenth of a percent' : `within ${pct.toFixed(1)}%`
  return `the same number of rows to ${said}`
}

/** The names, as a reader would list them. */
export function names(set: TwinSet): string {
  const list = set.tables.map((t) => t.table)
  if (list.length === 2) return `${list[0]} and ${list[1]}`
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/** The sentence for one set.
 *
 *  It states the evidence and stops. No verb about what to do with either copy:
 *  see the header — the two most convincing sets on a real server are both
 *  deliberate, and the difference between a stale copy and a second layout is a
 *  fact about somebody's intentions.
 */
export function saysSet(set: TwinSet): string {
  const n = set.tables.length
  return `${names(set)} hold ${set.columns} identical columns and ${saysRows(set)}${
    n > 2 ? ` — ${n} copies of one dataset` : ''
  }.`
}

/** What holding them costs, and what it does not promise.
 *
 *  `bytes` is passed in because this module judges and `lib/format` renders — the
 *  split the codebase keeps everywhere. */
export function saysCost(set: TwinSet, bytes: (n: number) => string): string {
  return `${bytes(set.total_bytes)} altogether; at least ${bytes(
    set.redundant_bytes,
  )} of that is a second copy, whichever one you would keep.`
}

/** The lead over a whole reading, or `null` where there is nothing to lead.
 *
 *  Counts sets rather than tables: three copies of one dataset is one thing to
 *  think about, not three. */
export function saysReport(report: TwinReport, bytes: (n: number) => string): string | null {
  const sets = notable(report)
  if (sets.length === 0) return null
  const redundant = sets.reduce((sum, s) => sum + s.redundant_bytes, 0)
  return `${sets.length} ${
    sets.length === 1 ? 'set of tables holds' : 'sets of tables hold'
  } the same data twice or more, costing at least ${bytes(redundant)} beyond one copy each.`
}
