/** The bytes you are paying for and nothing has read.
 *
 *  `src/clickhouse/cold.rs` measures it — `system.parts_columns` for what each
 *  column costs, `system.query_log.columns` for what anything actually touched,
 *  and the difference. This file decides what may be *said* about that, which is
 *  a much narrower thing than the numbers suggest and is the whole reason it is
 *  its own module with its own tests.
 *
 *  ## The claim is about the window, never about the column
 *
 *  "Nothing has read this column in the last six days" is a fact. "This column
 *  is unused" is a guess, and a costly one: a quarterly report, an incident
 *  investigation, a regulator's export and a year-end reconciliation all read
 *  columns that look cold for months. So every sentence here names its window,
 *  and none of them contains the word unused.
 *
 *  ## And the window is the log's, not the one we asked for
 *
 *  This is the part that makes the reading honest, and it took pointing it at a
 *  real server to see why. `system.query_log` has a TTL. Asked about seven days,
 *  the log on a busy machine answered for **five hours** — and a page saying "no
 *  statement has read this in 7 days" over five hours of evidence is a false
 *  statement built entirely out of true numbers.
 *
 *  So `covered_days` is what gets quoted, and below a day of it nothing is
 *  claimed at all. A log covering twenty minutes cannot tell a cold column from
 *  a column nobody happened to need during lunch.
 */

/** One column that costs something and served nothing. */
export interface ColdColumn {
  name: string
  bytes: number
  uncompressed_bytes: number
}

/** One table, and how much of it went unread. */
export interface ColdTable {
  database: string
  table: string
  qualified: string
  columns: number
  cold_columns: number
  bytes: number
  cold_bytes: number
  /** Statements that read this table at all. Zero changes the sentence. */
  reads: number
  coldest: ColdColumn[]
}

export interface ColdReport {
  available: boolean
  reason?: string
  window_days: number
  /** What the log can actually answer over. See the header — quote this one. */
  covered_days: number
  statements: number
  tables: ColdTable[]
  floor_bytes: number
  total_cold_bytes: number
  total_bytes: number
  total_tables: number
}

/** Below this much log, nothing about what is cold may be claimed.
 *
 *  A day, and it is a floor rather than a target: a window that does not contain
 *  at least one of whatever this server does daily cannot distinguish a column
 *  nobody needs from a column nobody needed *yet*. Anything shorter and the
 *  reading says why it is holding rather than producing a confident list. */
const NEEDS_DAYS = 1

/** And below this many statements. An idle window is not evidence of anything:
 *  every column on a server nobody queried last night is cold, trivially. */
const NEEDS_STATEMENTS = 50

/** Whether this report may be turned into claims at all, and why not. */
export function trustworthy(report: ColdReport): { ok: boolean; why?: string } {
  if (!report.available) return { ok: false, why: report.reason ?? 'this reading is unavailable' }
  if (report.covered_days < NEEDS_DAYS) {
    return {
      ok: false,
      why: `system.query_log only goes back ${saysSpan(report.covered_days)}, which is not long enough to tell a column nobody needs from one nobody needed today`,
    }
  }
  if (report.statements < NEEDS_STATEMENTS) {
    return {
      ok: false,
      why: `only ${report.statements} statements ran in that window, which is too few to say what nothing reads`,
    }
  }
  return { ok: true }
}

/** How long the evidence covers, in the unit that suits its size.
 *
 *  From the covered span and never from the window asked for — see the header.
 *  Hours below two days, because "0.2 days" is a figure nobody can picture and
 *  the whole point of printing it is that the reader weighs it. */
export function saysSpan(days: number): string {
  if (days <= 0) return 'no time at all'
  if (days < 1 / 24) return `${Math.max(1, Math.round(days * 24 * 60))} minutes`
  if (days < 2) {
    const hours = Math.round(days * 24)
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  }
  const whole = Math.round(days)
  return `${whole} days`
}

/** What share of a table nothing read. `null` for a table with no bytes, where
 *  the ratio is not a small number but an absent one. */
export function coldShare(table: ColdTable): number | null {
  if (table.bytes <= 0) return null
  return table.cold_bytes / table.bytes
}

/** The sentence for one table.
 *
 *  Two shapes, and which one applies is the most useful thing this module
 *  decides. A table **no statement touched** has every column cold, and calling
 *  that "1,906 unread columns" dresses one fact up as nineteen hundred: the fact
 *  is about the table. A table that *is* read, with columns inside it that are
 *  not, is the finding worth the name — somebody uses this table every day and
 *  most of what it costs is not what they use.
 */
export function saysTable(table: ColdTable, report: ColdReport): string {
  const span = saysSpan(report.covered_days)
  if (table.reads === 0) {
    return `No statement read ${table.qualified} at all in the last ${span}.`
  }
  if (table.cold_columns === table.columns) {
    /* Read, and yet every weighed column cold. It happens: `SELECT count()`
       reads no column at all, and a statement that only touches the sorting key
       through the index leaves no column in the log either. Worth its own
       sentence rather than being counted as the reader's problem. */
    return `${table.qualified} was read ${saysReads(table.reads)}, but no statement named any of its ${table.columns} stored columns — a count, or a filter the index answered alone.`
  }
  return `${table.cold_columns} of ${table.qualified}’s ${table.columns} stored columns went unread in the last ${span}, and they are most of what it costs.`
}

function saysReads(reads: number): string {
  return reads === 1 ? 'once' : `${reads} times`
}

/** What the cold part of a table costs, in the shape that reads as a sentence.
 *
 *  Two figures rounded to the same unit is how this went wrong the first time:
 *  24,533,236 of 24,868,732 bytes both print as "24 MiB", and "24 MiB of the
 *  24 MiB this table occupies" reads as a bug rather than as a near-total. So the
 *  second figure is a *share* — a percentage cannot collide with the first one —
 *  and a table nothing read at all gets neither, because "all of it" is what
 *  "nothing read this table" already said.
 *
 *  `null` where there is nothing to cost: a table holding no bytes.
 */
export function saysCost(
  table: ColdTable,
  bytes: (n: number) => string,
): string | null {
  if (table.cold_bytes <= 0) return null
  if (table.reads === 0) return `The whole ${bytes(table.bytes)} of it.`
  const share = coldShare(table)
  if (share === null) return `${bytes(table.cold_bytes)} of it.`
  /* Rounded, and 99 is the ceiling below 100: a table with one warm byte in it
     is not "100% cold", and the reader who spots the warm column in the list
     below should not have to reconcile it with a total. */
  const pct = Math.min(99, Math.round(share * 100))
  return `That is ${bytes(table.cold_bytes)}, ${pct}% of what the table occupies.`
}

/** The lead sentence over a whole reading, or `null` where there is nothing to
 *  lead. Names the span, because the span is what the figure means. */
export function saysReport(report: ColdReport): string | null {
  const trust = trustworthy(report)
  if (!trust.ok) return null
  if (report.tables.length === 0) return null
  return `Over the last ${saysSpan(report.covered_days)}, ${report.total_tables} ${
    report.total_tables === 1 ? 'table holds' : 'tables hold'
  } data no statement read.`
}
