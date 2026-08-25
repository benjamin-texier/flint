/** Looking at the actual rows.
 *
 *  `SELECT * LIMIT 200` answers one question — what does a row look like — and
 *  then stops. The questions people actually have about a table they are meeting
 *  for the first time are: what does it hold *now* (the newest rows, not the
 *  first ones by primary key), what does a typical row look like, and what is in
 *  here that matches something I care about.
 *
 *  Two things this is careful about. The cost of an ordering is stated, because
 *  on a columnar store "newest first" is nearly free on one table and a full
 *  scan on the next, and which one it is depends on the sorting key. And the
 *  columns are chosen, because reading four columns out of thirty-six is the
 *  single biggest performance difference available in ClickHouse and it is
 *  invisible unless somebody says so. */

import { conditionSql, quoteIdent, type Condition, type ColumnInfo } from './query'

export type Order = 'natural' | 'latest' | 'oldest' | 'random'

export interface ExploreSpec {
  database: string
  table: string
  /** Empty means every column. */
  columns: string[]
  filters: Condition[]
  order: Order
  /** The column `latest` and `oldest` sort by. */
  timeColumn: string
  limit: number
}

export const LIMITS = [50, 200, 1000] as const

const TIME = /^(Nullable\()?(LowCardinality\()?Date/i

/** Columns worth ordering by. A `Date` or `DateTime`, at any nesting ClickHouse
 *  wraps them in. */
export function timeColumns(columns: ColumnInfo[]): string[] {
  return columns.filter((c) => TIME.test(c.type)).map((c) => c.name)
}

/** The first thing to show somebody, which is the newest rows when the table
 *  knows what newest means. */
export function startingSpec(
  database: string,
  table: string,
  columns: ColumnInfo[],
  sortingKey: string,
): ExploreSpec {
  const times = timeColumns(columns)
  const leading = times.find((t) => leads(sortingKey, t))
  const timeColumn = leading ?? times[0] ?? ''
  return {
    database,
    table,
    columns: [],
    filters: [],
    // Newest first only where it is cheap. A table sorted by something else
    // pays a full scan to answer it, and opening a page by spending that on
    // somebody's behalf is not a courtesy — the button is right there, and the
    // cost is written beside it.
    order: leading ? 'latest' : 'natural',
    timeColumn,
    limit: 200,
  }
}

/** Whether `column` is the first thing the table is sorted by. Only the leading
 *  position makes a range read cheap; second place does not help. */
export function leads(sortingKey: string, column: string): boolean {
  const first = sortingKey.split(',')[0]?.trim() ?? ''
  if (!first) return false
  const bare = first.replace(/^\(|\)$/g, '').trim()
  return bare === column || bare === `\`${column}\``
}

export function exploreSql(spec: ExploreSpec, columns: ColumnInfo[]): string {
  const known = new Map(columns.map((c) => [c.name, c.type]))
  const chosen = spec.columns.filter((c) => known.has(c))
  const select = chosen.length > 0 ? chosen.map(quoteIdent).join(', ') : '*'

  const where = spec.filters
    .filter((f) => known.has(f.column))
    .map((f) => conditionSql(f, known.get(f.column)!))
    .filter((s): s is string => s !== null)

  const lines = [
    `SELECT ${select}`,
    `FROM ${quoteIdent(spec.database)}.${quoteIdent(spec.table)}`,
  ]
  if (where.length > 0) lines.push(`WHERE ${where.join(' AND ')}`)

  const order = orderBy(spec, known)
  if (order) lines.push(`ORDER BY ${order}`)
  lines.push(`LIMIT ${Math.max(1, Math.floor(spec.limit))}`)
  return lines.join('\n')
}

function orderBy(spec: ExploreSpec, known: Map<string, string>): string | null {
  switch (spec.order) {
    case 'natural':
      return null
    case 'random':
      return 'rand()'
    case 'latest':
    case 'oldest': {
      if (!spec.timeColumn || !known.has(spec.timeColumn)) return null
      return `${quoteIdent(spec.timeColumn)} ${spec.order === 'latest' ? 'DESC' : 'ASC'}`
    }
  }
}

export interface Cost {
  /** `cheap` reads a range or a few columns; `scan` reads the table. */
  level: 'cheap' | 'scan'
  says: string
}

/** What this will cost, and why — the part a first-time ClickHouse reader has no
 *  way to guess and an expert checks by habit. */
export function costOf(spec: ExploreSpec, columns: ColumnInfo[], sortingKey: string): Cost {
  const chosen = spec.columns.length
  const total = columns.length
  const narrowing =
    chosen > 0 && chosen < total
      ? ` Reading ${chosen} of ${total} columns, which on a column store is most of the saving available.`
      : ''

  if (spec.order === 'random') {
    return {
      level: 'scan',
      says: `A random sample has to look at every row before it can pick any, so this reads the whole table.${narrowing}`,
    }
  }
  if ((spec.order === 'latest' || spec.order === 'oldest') && spec.timeColumn) {
    if (leads(sortingKey, spec.timeColumn)) {
      return {
        level: 'cheap',
        says: `The table is sorted by ${spec.timeColumn} first, so this reads one end of it and stops.${narrowing}`,
      }
    }
    return {
      level: 'scan',
      says: `The table is sorted by ${sortingKey || 'nothing in particular'}, not by ${spec.timeColumn} — so ordering by it reads the whole table and then sorts.${narrowing}`,
    }
  }
  return {
    level: 'cheap',
    says: `In stored order, so this reads the first rows it finds and stops.${narrowing}`,
  }
}

/** A filter the reader can start from, given a column: the operator that is
 *  most often wanted for its type. */
export function startingFilter(column: ColumnInfo, id: string): Condition {
  const numeric = /Int|Float|Decimal/i.test(column.type)
  const time = TIME.test(column.type)
  return {
    id,
    column: column.name,
    // The operator most often wanted for the type: a range on a number or a
    // time, a contains on anything textual.
    op: numeric || time ? '>=' : 'like',
    value: '',
    value2: '',
  }
}
