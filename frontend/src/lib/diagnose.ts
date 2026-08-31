/** Turning ClickHouse's counters into sentences.
 *
 *  Everything here is a judgement, and every judgement needs a threshold that
 *  came from somewhere. Where ClickHouse has an opinion of its own — how many
 *  parts it will tolerate before it slows an insert down — we use the server's
 *  number rather than a remembered default, because a threshold guessed wrong
 *  turns a healthy table into a false alarm. */

import { PROJECTION_ROW_FLOOR } from './projection'

export interface Summary {
  queries: number
  failures: number
  selects: number
  inserts: number
  read_bytes: number
  read_rows: number
  avg_ms: number
  p95_ms: number
  max_ms: number
  users: number
  since: string
}

export interface Pattern {
  hash: string
  runs: number
  failures: number
  avg_ms: number
  p95_ms: number
  max_ms: number
  total_ms: number
  read_bytes: number
  read_rows: number
  peak_memory: number
  users: number
  last_seen: string
  sample: string
  tables: string[]
}

export interface Failure {
  code: number
  name: string
  occurrences: number
  last_seen: string
  sample: string
  message: string
}

export interface QueryReport {
  available: boolean
  reason?: string
  window_days: number
  /** The same window to the second — `window_days` is this divided down, so
   *  they cannot disagree. A session is minutes, so its `window_days` is zero
   *  and the page phrases it from here. */
  window_seconds: number
  summary: Summary | null
  patterns: Pattern[]
  failures: Failure[]
}

export interface TableTraffic {
  qualified: string
  reads: number
  writes: number
  read_rows: number
  read_bytes: number
  avg_ms: number
  readers: number
  last_read: string
}

export interface UnusedTable {
  qualified: string
  engine: string
  row_count: number
  bytes: number
  last_write: string
}

export interface TrafficReport {
  available: boolean
  reason?: string
  window_days: number
  window_seconds: number
  traffic: TableTraffic[]
  unused: UnusedTable[]
}

export interface TableStorage {
  qualified: string
  row_count: number
  compressed: number
  uncompressed: number
  ratio: number
  parts: number
  partitions: number
  pk_bytes: number
}

export interface PartitionLoad {
  qualified: string
  database: string
  table: string
  /** The opaque id an action takes. `partition` is the human expression and
   *  cannot go into a statement without knowing the key's type. */
  partition_id: string
  partition: string
  parts: number
  row_count: number
  bytes: number
  avg_part: number
}

export interface Thresholds {
  delay_insert: number
  throw_insert: number
  from_server: boolean
}

export interface StorageReport {
  available: boolean
  reason?: string
  tables: TableStorage[]
  partitions: PartitionLoad[]
  thresholds: Thresholds
}

export interface Merge {
  qualified: string
  elapsed: number
  progress: number
  num_parts: number
  bytes: number
  is_mutation: boolean
  memory: number
  result: string
}

export interface Mutation {
  qualified: string
  mutation_id: string
  command: string
  created: string
  parts_to_do: number
  done: boolean
  fail_reason: string
}

export interface ApiUsage {
  slug: string
  calls: number
  failures: number
  avg_ms: number
  p95_ms: number
  read_rows: number
  read_bytes: number
  last_call: string
}

export interface UsageReport {
  available: boolean
  reason?: string
  window_days: number
  usage: ApiUsage[]
}

/** Usage keyed by slug. An endpoint absent from the report has not been called
 *  in the window, which is a different thing from having been called zero
 *  times by a caller who exists — and the page says so. */
export function usageIndex(report: UsageReport | undefined): Map<string, ApiUsage> {
  if (!report?.available) return new Map()
  return new Map(report.usage.map((u) => [u.slug, u]))
}

export interface Running {
  query_id: string
  user: string
  query: string
  kind: string
  database: string
  elapsed: number
  read_rows: number
  read_bytes: number
  written_rows: number
  total_rows: number
  memory: number
  peak_memory: number
  threads: number
  cancelled: boolean
  client: string
}

export interface Disk {
  name: string
  path: string
  free: number
  total: number
  keep_free: number
  kind: string
  read_only: boolean
  broken: boolean
}

export interface ErrorCount {
  name: string
  code: number
  count: number
  last_seen: string
  message: string
}

export interface ActivityReport {
  available: boolean
  reason?: string
  merges: Merge[]
  mutations: Mutation[]
  running: Running[]
  disks: Disk[]
  errors: ErrorCount[]
  /** Lists this role may not read. Without it an empty list would mean both
   *  "nothing is happening" and "you cannot see what is happening". */
  denied: string[]
}

/** How far along a query is, when ClickHouse has an estimate to divide by.
 *  Null rather than zero: "we do not know yet" is not "no progress". */
export function progressOf(query: Running): number | null {
  if (query.total_rows <= 0) return null
  return Math.min(1, query.read_rows / query.total_rows)
}

/** Usable free space: what ClickHouse will actually let itself write into,
 *  which is the free space less the margin it is told to keep. */
export function usableFree(disk: Disk): number {
  return Math.max(0, disk.free - disk.keep_free)
}

export function diskVerdict(disk: Disk): Verdict {
  if (disk.broken) {
    return { level: 'throw', says: 'ClickHouse has marked this disk broken' }
  }
  if (disk.total <= 0) {
    return { level: 'ok', says: 'no size reported' }
  }
  const share = usableFree(disk) / disk.total
  if (disk.read_only) {
    return { level: 'watch', says: 'read-only, so nothing can be written here' }
  }
  // A full disk is the incident nobody sees coming, and the last few per cent
  // go faster than anyone expects.
  if (share < 0.05) {
    return { level: 'throw', says: 'under a twentieth of it is left' }
  }
  if (share < 0.15) {
    return { level: 'watch', says: 'under a seventh of it is left' }
  }
  return { level: 'ok', says: 'room to spare' }
}

/** A query worth a second look: long, or holding a lot of memory. Deliberately
 *  generous — a slow query is not a problem, it is a thing to notice. */
export function notable(query: Running): boolean {
  return query.elapsed >= 30 || query.memory >= 1_000_000_000
}

/** ClickHouse answers "nothing ever read this" with the epoch. */
export function everRead(last: string): boolean {
  return Boolean(last) && !last.startsWith('1970-01-01') && !last.startsWith('0000')
}

export type Level = 'ok' | 'watch' | 'delay' | 'throw'

export interface Verdict {
  level: Level
  /** One sentence: what this number means for the person reading it. */
  says: string
}

/** Parts in a single partition, against the server's own tolerance.
 *
 *  ClickHouse slows inserts at `parts_to_delay_insert` and rejects them at
 *  `parts_to_throw_insert`. Halfway to the first is where a chart is still
 *  worth a glance, which is what `watch` means — nothing is wrong yet. */
export function partitionVerdict(parts: number, t: Thresholds): Verdict {
  if (parts >= t.throw_insert) {
    return {
      level: 'throw',
      says: `at or past ${t.throw_insert} parts, ClickHouse refuses new inserts into this partition`,
    }
  }
  if (parts >= t.delay_insert) {
    return {
      level: 'delay',
      says: `past ${t.delay_insert} parts, ClickHouse deliberately slows inserts here`,
    }
  }
  if (parts >= t.delay_insert / 2) {
    return {
      level: 'watch',
      says: `over halfway to the ${t.delay_insert}-part mark where inserts start being slowed`,
    }
  }
  return { level: 'ok', says: 'merges are keeping up' }
}

/** What a compression ratio is telling you. Deliberately narrow: the only
 *  claim worth making from one number is that something is unusual. */
export function compressionVerdict(ratio: number): Verdict {
  if (!Number.isFinite(ratio) || ratio <= 0) return { level: 'ok', says: 'nothing stored yet' }
  if (ratio < 1.5) {
    return {
      level: 'watch',
      says: 'barely compressing — often a String column holding values that have a narrower type',
    }
  }
  if (ratio > 20) return { level: 'ok', says: 'compressing unusually well' }
  return { level: 'ok', says: 'compressing normally' }
}

/** How much of a table an average read walks through.
 *
 *  This is the one number that says whether the sorting key is earning its
 *  keep: a query that reads every row to answer a question about a few is a
 *  query whose ORDER BY does not match it. Null when there is nothing to
 *  divide by — a table with no rows, or one nothing has read. */
export function scanShare(t: TableTraffic, rows: number): number | null {
  if (!t.reads || rows <= 0) return null
  const perRead = t.read_rows / t.reads
  return perRead / rows
}

export function scanVerdict(share: number): Verdict {
  if (share >= 0.9) {
    return {
      level: 'watch',
      says: 'each read walks the whole table — the sorting key is not narrowing these queries',
    }
  }
  if (share >= 0.5) {
    return { level: 'watch', says: 'each read covers more than half the table' }
  }
  return { level: 'ok', says: 'reads are landing on part of the table' }
}

/** A pattern's share of all the time spent querying, which is the honest
 *  ranking: the slowest single statement is an anecdote, while the pattern
 *  that ran ten thousand times at 40ms is where the server actually went. */
export function costShare(pattern: Pattern, patterns: Pattern[]): number {
  const total = timeSpent(patterns)
  return total > 0 ? pattern.total_ms / total : 0
}

/** Milliseconds across every pattern in the list — the denominator behind the
 *  shares. Printed rather than implied: a column of percentages with no total
 *  in sight is a column nobody can check. */
export function timeSpent(patterns: Pattern[]): number {
  return patterns.reduce((sum, p) => sum + p.total_ms, 0)
}

/** The editor, loaded with this shape.
 *
 *  `sample` is a real statement out of the log rather than a normalised
 *  fingerprint, so it runs as it is. The database comes from the tables the
 *  pattern touched — a query written against `analytics` should not open
 *  pointed at `default` — and is left out when the pattern names none, where the
 *  editor's own default is the better guess. */
/** Which database a logged statement was written against, as far as the tables
 *  it touched can say. Unqualified names in the SQL resolve against this, so
 *  anything that re-runs or explains the statement needs the same answer the
 *  editor link gives — hence one function rather than two. */
export function databaseOf(pattern: Pattern): string | undefined {
  const qualified = pattern.tables.find((name) => name.includes('.'))
  return qualified ? qualified.slice(0, qualified.indexOf('.')) : undefined
}

/** The two halves of a `database.table` as the query log writes it, or null.
 *
 *  Split on the *first* dot, which is where the log's own convention puts it:
 *  `system.query_log.tables` holds unquoted `db.table`, so a name that needed
 *  quoting could not be told apart here anyway. Null rather than a guess for
 *  anything that is not two parts — a table function, an empty entry — because
 *  the callers turn this into a link, and a link to the wrong table is worse
 *  than no link. */
export function splitQualified(qualified: string): { database: string; table: string } | null {
  const at = qualified.indexOf('.')
  if (at <= 0 || at === qualified.length - 1) return null
  return { database: qualified.slice(0, at), table: qualified.slice(at + 1) }
}

/** Where a qualified name goes, and where its projections argument is.
 *
 *  The scan share on this page is already the sentence a projection answers —
 *  "each read walks the whole table, the sorting key is not narrowing these
 *  queries" — and it had nowhere to lead. This is the lead. It is a *question*
 *  and not a recommendation: whether a projection is worth its disk depends on
 *  the shapes behind those reads, which is the tab's job to read and not this
 *  page's to assume. */
export function tableLink(qualified: string): string | null {
  const parts = splitQualified(qualified)
  if (!parts) return null
  return `/db/${encodeURIComponent(parts.database)}/${encodeURIComponent(parts.table)}`
}

export function projectionsLink(qualified: string): string | null {
  const at = tableLink(qualified)
  return at && `${at}?tab=projections`
}

/* The floor lives in `lib/projection`, which is where the rest of the reasoning
   about granules does. Two copies of the same number in two files is how they
   come to disagree. */

/** Whether the scan share on this row is worth carrying a question about.
 *
 *  Two conditions, and the second is the one that had to be added after
 *  looking: the reads have to be covering most of the table *and* the table has
 *  to be big enough for that to cost anything. */
export function worthAskingAboutProjections(share: number | null, rows: number): boolean {
  return share !== null && share >= 0.5 && rows >= PROJECTION_ROW_FLOOR
}

export function editorLink(pattern: Pattern): string {
  // Runs of spaces are collapsed but the lines are kept: a statement Flint sent
  // itself arrives padded out by its own line continuations, and thirty spaces
  // mid-line reads as a broken paste. Anything past that is the editor's own
  // Format button, which asks ClickHouse.
  const params = new URLSearchParams({ sql: pattern.sample.replace(/[ \t]+/g, ' ').trim() })
  const database = databaseOf(pattern)
  if (database) params.set('database', database)
  return `/query?${params}`
}

/** The window the reader actually got, which is not always the one they asked
 *  for: a seven-day question against a log that only keeps two days has a
 *  two-day answer, and saying so is the difference between a diagnostic and a
 *  guess. */
export function actualWindow(summary: Summary | null, asked: number): string {
  if (!summary || !summary.queries || !everRead(summary.since)) return `${asked} days`
  const since = Date.parse(`${summary.since.replace(' ', 'T')}Z`)
  if (!Number.isFinite(since)) return `${asked} days`
  const days = (Date.now() - since) / 86_400_000
  if (days >= asked * 0.9) return `${asked} days`
  if (days < 1) return 'a few hours — that is all the log keeps'
  return `${Math.round(days)} days — that is all the log keeps`
}

export function percent(share: number): string {
  if (share >= 0.1) return `${Math.round(share * 100)}%`
  if (share >= 0.01) return `${(share * 100).toFixed(1)}%`
  return '<1%'
}

/** Traffic keyed by qualified `database.table`.
 *
 *  Qualified rather than bare, so a table named `events` in two databases keeps
 *  its own reads, and so an object the diagram borrows from another database —
 *  a dictionary's source, a view's upstream — can be looked up at all. */
export function trafficIndex(rows: TableTraffic[] | undefined): Map<string, TableTraffic> {
  return new Map((rows ?? []).map((row) => [row.qualified, row]))
}

/** The read count the bars are scaled against: the busiest of a fixed set of
 *  objects, not of whatever is currently on screen.
 *
 *  Passing the whole diagram's nodes rather than the filtered slice is the
 *  point — a scale that moves when you filter makes a quiet table look busy the
 *  moment its noisy neighbour leaves the view. Zero when nothing was read, so
 *  the caller never divides by a scale of nothing. */
export function trafficMax(
  index: Map<string, TableTraffic>,
  objects: { database: string; name: string }[],
): number {
  let max = 0
  for (const o of objects) {
    max = Math.max(max, index.get(`${o.database}.${o.name}`)?.reads ?? 0)
  }
  return max
}
