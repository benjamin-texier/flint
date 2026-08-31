/** What the result says about itself.
 *
 *  A grid answers "what are the values". It cannot answer the questions people
 *  actually have about a result they have just run: which of these columns is
 *  mostly null, which one is the same value all the way down and therefore
 *  taught me nothing, where do the numbers sit, how long a stretch of time is
 *  this, what are the five hosts that account for the rows. Those are one pass
 *  over data that is already in the browser, and paying a round trip for them
 *  would be absurd.
 *
 *  Two honesty rules run through this file, and both are load-bearing.
 *
 *  Everything here describes *the rows that came back*, not the table. A result
 *  is a LIMIT away from being a sample of unknown bias, so every figure this
 *  produces is labelled that way in the UI and `rows` is always stated beside
 *  it. Calling the mean of 500 rows "the average" would be the single most
 *  misleading thing this page could do.
 *
 *  And a figure that does not apply is absent rather than zero. A `String`
 *  column has no mean; `numbers` is undefined for it, not a mean of 0. The
 *  house rule — a missing figure is dropped, not dashed — starts here, where the
 *  figures are computed. */

import type { QueryResult } from './api'
import { family, type TypeFamily } from './chType'
import { numberOf } from './grid'

/** Past this many rows the pass samples instead. Ten thousand rows over ninety
 *  columns is nine hundred thousand values, which is a visible stall on a
 *  laptop — and the answers do not change: the top five of a column do not move
 *  because the sixth thousand row was skipped. */
const FULL_PASS_CELLS = 400_000

/** Distinct values are counted exactly up to here and then given up on. The
 *  number matters less than the fact that "more than 500" is a different
 *  statement from "512", and the UI says which one it has. */
const DISTINCT_CAP = 500

/** How many of the top values are worth showing. Five fits beside a grid
 *  without becoming a second grid. */
const TOP_N = 5

const BINS = 24

export interface TopValue {
  value: string
  n: number
}

export interface NumberFacts {
  min: number
  max: number
  mean: number
  p50: number
  p95: number
  sum: number
  /** Counts per equal-width bucket between min and max, for a sparkline. */
  bins: number[]
}

export interface TimeFacts {
  /** As they arrived, so the reader sees the value the cell holds. */
  from: string
  to: string
  /** Null when the two ends did not parse as dates — a `DateTime64` string
   *  ClickHouse formatted in a way `Date` does not read. The extent is still
   *  worth showing; the duration is simply not known. */
  seconds: number | null
  bins: number[]
}

export interface ColumnRead {
  name: string
  type: string
  family: TypeFamily
  /** Rows examined — the same for every column of a result, restated per column
   *  because every figure below is a fraction of it. */
  n: number
  nulls: number
  /** Zero-length strings, which are not nulls and are worth their own count:
   *  the difference between "no value" and "the empty value" is the difference
   *  between two bugs. */
  empties: number
  distinct: number
  distinctCapped: boolean
  /** The one value, when there is only one. */
  constant: string | null
  /** True when every non-null value is different — the shape of a key. */
  unique: boolean
  numbers?: NumberFacts
  times?: TimeFacts
  top: TopValue[]
}

export interface ResultRead {
  rows: number
  /** True when the figures come from a sample rather than every row. */
  sampled: boolean
  /** How many rows the pass actually looked at. */
  examined: number
  columns: ColumnRead[]
}

/** One pass over the result. */
export function analyse(result: Pick<QueryResult, 'columns' | 'rows'>): ResultRead {
  const rows = result.rows
  const cells = rows.length * Math.max(1, result.columns.length)
  const step = cells > FULL_PASS_CELLS ? Math.ceil(cells / FULL_PASS_CELLS) : 1
  const sampled = step > 1

  const picked: unknown[][] = []
  for (let r = 0; r < rows.length; r += step) picked.push(rows[r] ?? [])

  return {
    rows: rows.length,
    sampled,
    examined: picked.length,
    columns: result.columns.map((column, index) => readColumn(column, picked, index)),
  }
}

function readColumn(
  column: { name: string; type: string },
  rows: readonly unknown[][],
  index: number,
): ColumnRead {
  const kind = family(column.type)
  let nulls = 0
  let empties = 0
  const counts = new Map<string, number>()
  let capped = false
  const numbers: number[] = []
  const dates: number[] = []
  let earliest: { at: number; text: string } | null = null
  let latest: { at: number; text: string } | null = null

  for (const row of rows) {
    const value = row[index]
    if (value === null || value === undefined) {
      nulls += 1
      continue
    }
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    if (text === '') empties += 1

    if (counts.size < DISTINCT_CAP || counts.has(text)) {
      counts.set(text, (counts.get(text) ?? 0) + 1)
    } else {
      capped = true
    }

    if (kind === 'number') {
      const n = numberOf(value)
      if (n !== null) numbers.push(n)
    } else if (kind === 'time') {
      const at = parseTime(text)
      if (at !== null) {
        dates.push(at)
        if (!earliest || at < earliest.at) earliest = { at, text }
        if (!latest || at > latest.at) latest = { at, text }
      } else {
        // Unparseable, but still an extent: string order is the right order for
        // every format ClickHouse emits for a date.
        if (!earliest || text < earliest.text) earliest = { at: Number.NaN, text }
        if (!latest || text > latest.text) latest = { at: Number.NaN, text }
      }
    }
  }

  const present = rows.length - nulls
  const distinct = counts.size
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_N)
    .map(([value, n]) => ({ value, n }))

  return {
    name: column.name,
    type: column.type,
    family: kind,
    n: rows.length,
    nulls,
    empties,
    distinct,
    distinctCapped: capped,
    constant: !capped && distinct === 1 ? (top[0]?.value ?? null) : null,
    unique: !capped && present > 1 && distinct === present,
    ...(numbers.length > 0 ? { numbers: numberFacts(numbers) } : null),
    ...(earliest && latest
      ? {
          times: {
            from: earliest.text,
            to: latest.text,
            seconds:
              Number.isFinite(earliest.at) && Number.isFinite(latest.at)
                ? (latest.at - earliest.at) / 1000
                : null,
            bins: histogram(dates, BINS),
          },
        }
      : null),
    top,
  }
}

function numberFacts(values: number[]): NumberFacts {
  const sorted = [...values].sort((a, b) => a - b)
  const sum = values.reduce((total, value) => total + value, 0)
  return {
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: sum / values.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    sum,
    bins: histogram(values, BINS),
  }
}

/** The nearest-rank percentile, which is what ClickHouse's own `quantileExact`
 *  reports: no interpolation between two neighbours that may be a thousand
 *  apart. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[index]!
}

/** Equal-width buckets, for a sparkline. An empty range — every value the same
 *  — is one full bucket rather than a division by zero. */
export function histogram(values: readonly number[], bins: number): number[] {
  const out = new Array<number>(bins).fill(0)
  if (values.length === 0) return out
  let min = Infinity
  let max = -Infinity
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return out
  if (max === min) {
    out[0] = values.length
    return out
  }
  const width = (max - min) / bins
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    const at = Math.min(bins - 1, Math.max(0, Math.floor((value - min) / width)))
    out[at] = (out[at] ?? 0) + 1
  }
  return out
}

/** ClickHouse sends `2024-05-01 12:00:00`, which `Date` reads as local time —
 *  right for a duration, and the duration is all this is used for. */
function parseTime(text: string): number | null {
  const at = Date.parse(text.includes('T') ? text : text.replace(' ', 'T'))
  return Number.isFinite(at) ? at : null
}

/* -- What is worth saying out loud ------------------------------------- */

export interface Observation {
  /** The column this is about, for the UI to point at. */
  column: string
  text: string
  /** `note` is a fact about the data; `warn` is a fact about the *query* — a
   *  column that tells the reader nothing, which is usually a column that
   *  should not have been selected or a filter that has already been applied. */
  tone: 'note' | 'warn'
}

/** The handful of things a reader should be told without having to look.
 *
 *  Deliberately short and deliberately not clever: no correlations, no outlier
 *  hunting, no "this looks like an id". Each of these is a fact anyone would
 *  check by hand and nobody does — and each one changes what you do next, which
 *  is the bar for taking up a line of the page. */
export function observations(read: ResultRead): Observation[] {
  const out: Observation[] = []
  for (const column of read.columns) {
    if (column.n === 0) continue
    if (column.nulls === column.n) {
      out.push({ column: column.name, text: 'null in every row', tone: 'warn' })
      continue
    }
    if (column.constant !== null) {
      // One value *and* a pile of nulls is two facts, and either alone
      // misleads: "one value throughout" hides the nulls, and "null in 75% of
      // rows" hides that the rest never varies.
      const share = Math.round((column.nulls / column.n) * 100)
      out.push({
        column: column.name,
        text:
          column.nulls === 0
            ? `one value throughout — ${short(column.constant)}`
            : `one value where it is set — ${short(column.constant)} — and null in ${share}% of rows`,
        tone: 'warn',
      })
      continue
    }
    if (column.nulls > 0 && column.nulls / column.n >= 0.5) {
      out.push({
        column: column.name,
        text: `null in ${Math.round((column.nulls / column.n) * 100)}% of rows`,
        tone: 'note',
      })
    }
    if (column.unique) {
      out.push({ column: column.name, text: 'a different value in every row', tone: 'note' })
    }
    if (column.empties > 0) {
      out.push({
        column: column.name,
        text: `${column.empties} empty ${column.empties === 1 ? 'string' : 'strings'}, not null`,
        tone: 'note',
      })
    }
  }
  return out
}

function short(value: string): string {
  const text = value === '' ? "''" : value
  return text.length > 40 ? text.slice(0, 39) + '…' : text
}
