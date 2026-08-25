/** The no-code query model, and the ClickHouse SQL it generates.
 *
 *  Two rules shape this. The abstraction stays close to SQL rather than hiding
 *  it — the brief is explicit that people should be able to read the generated
 *  query and learn from it, or take it over by hand. And every value that
 *  reaches the query goes through a literal encoder or a closed grammar:
 *  identifiers come from the table's own column list, operators from a fixed
 *  set, and free text is always encoded, never interpolated. */

import { family, isTemporal } from './chType'

export type Agg = 'count' | 'uniq' | 'sum' | 'avg' | 'min' | 'max' | 'median' | 'p95' | 'p99'

export type Bucket = 'minute' | 'hour' | 'day' | 'week' | 'month'

export type Op =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'like'
  | 'notLike'
  | 'in'
  | 'notIn'
  | 'isNull'
  | 'isNotNull'
  | 'between'
  /** A window measured back from now, e.g. the last 24 hours. */
  | 'since'

/** One thing to select: a column, optionally bucketed (if it is a time) or
 *  aggregated. A projection with no aggregate is a dimension, and dimensions
 *  are what the query groups by. */
export interface Projection {
  id: string
  column: string
  agg: Agg | null
  bucket: Bucket | null
}

export interface Condition {
  id: string
  column: string
  op: Op
  value: string
  /** Only for `between`. */
  value2: string
}

/** A filter on an aggregate, which SQL spells HAVING because it is applied
 *  after the grouping rather than before it. */
export interface Having {
  id: string
  /** The alias of an aggregated projection. */
  ref: string
  op: '=' | '!=' | '>' | '>=' | '<' | '<='
  value: string
}

export interface Ordering {
  id: string
  /** The alias of a projection. */
  ref: string
  desc: boolean
}

export interface QuerySpec {
  database: string
  table: string
  projections: Projection[]
  conditions: Condition[]
  having: Having[]
  orderings: Ordering[]
  limit: number
}

export interface ColumnInfo {
  name: string
  type: string
}

export const AGG_LABEL: Record<Agg, string> = {
  count: 'count',
  uniq: 'distinct (approx.)',
  sum: 'sum',
  avg: 'average',
  min: 'minimum',
  max: 'maximum',
  median: 'median',
  p95: '95th percentile',
  p99: '99th percentile',
}

export const OP_LABEL: Record<Op, string> = {
  '=': 'is',
  '!=': 'is not',
  '>': '>',
  '>=': '≥',
  '<': '<',
  '<=': '≤',
  like: 'contains',
  notLike: 'does not contain',
  in: 'is one of',
  notIn: 'is none of',
  isNull: 'is null',
  isNotNull: 'is not null',
  between: 'between',
  since: 'in the last',
}

/** Aggregates that only make sense over a number. */
const NUMERIC_AGGS: Agg[] = ['sum', 'avg', 'median', 'p95', 'p99']

export function aggsFor(type: string): Agg[] {
  const numeric = family(type) === 'number'
  const all: Agg[] = ['count', 'uniq', 'min', 'max', ...NUMERIC_AGGS]
  return numeric ? all : all.filter((a) => !NUMERIC_AGGS.includes(a))
}

export function opsFor(type: string): Op[] {
  const f = family(type)
  const common: Op[] = ['=', '!=', 'isNull', 'isNotNull']
  // A relative window comes first on a time column: "the last 24 hours" is the
  // filter a ClickHouse table is almost always read through, and it is the one
  // that lets the server skip whole partitions.
  if (f === 'time') {
    return ['since', ...common, '>', '>=', '<', '<=', 'between', 'in', 'notIn']
  }
  if (f === 'number') {
    return [...common, '>', '>=', '<', '<=', 'between', 'in', 'notIn']
  }
  if (f === 'string') return [...common, 'like', 'notLike', 'in', 'notIn']
  return [...common, 'in', 'notIn']
}

export function opTakesNoValue(op: Op): boolean {
  return op === 'isNull' || op === 'isNotNull'
}

/** The window shorthands the form offers, in the order it offers them. */
export const WINDOWS = ['15m', '1h', '6h', '24h', '7d', '30d'] as const

const UNITS: Record<string, string> = { m: 'MINUTE', h: 'HOUR', d: 'DAY' }

/** `24h` → 24 hours, `30d` → 30 days. Null for anything else, so a half-typed
 *  window produces no clause rather than a clause that means something else. */
export function parseWindow(value: string): { n: number; unit: string } | null {
  const match = /^\s*(\d+)\s*([mhd])\s*$/i.exec(value)
  if (!match) return null
  const n = Number(match[1])
  const unit = UNITS[match[2]!.toLowerCase()]
  return n > 0 && unit ? { n, unit } : null
}

// ── Encoding ───────────────────────────────────────────────────────────────

/** Backticks unless the name is a bare identifier. ClickHouse escapes a
 *  backtick inside a quoted identifier with a backslash. */
export function quoteIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    ? name
    : `\`${name.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``
}

export function quoteString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

const NUMBER = /^-?(\d+\.?\d*|\.\d+)$/

/** A closed grammar of time expressions people actually want to filter on.
 *  Matching against a fixed shape is what lets these through unquoted without
 *  becoming a hole: anything that is not exactly one of these is a string. */
const TIME_EXPR =
  /^(now\(\)|today\(\)|yesterday\(\))(\s*-\s*INTERVAL\s+\d+\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR))?$/i

/** Encode a user-typed value for a column of `type`. */
export function literal(value: string, type: string): string {
  const trimmed = value.trim()
  if (family(type) === 'number' && NUMBER.test(trimmed)) return trimmed
  if (isTemporal(type) && TIME_EXPR.test(trimmed)) {
    // Normalise the keyword case so the generated SQL reads consistently.
    return trimmed.replace(/interval/i, 'INTERVAL').replace(/\s+/g, ' ')
  }
  return quoteString(trimmed)
}

const BUCKET_FN: Record<Bucket, string> = {
  minute: 'toStartOfMinute',
  hour: 'toStartOfHour',
  day: 'toStartOfDay',
  week: 'toStartOfWeek',
  month: 'toStartOfMonth',
}

/** The SQL for one projection. */
export function expressionOf(p: Projection): string {
  const col = quoteIdent(p.column)
  if (p.agg === null) {
    return p.bucket ? `${BUCKET_FN[p.bucket]}(${col})` : col
  }
  switch (p.agg) {
    case 'count':
      return p.column === '*' ? 'count()' : `count(${col})`
    case 'uniq':
      return `uniq(${col})`
    case 'median':
      return `median(${col})`
    case 'p95':
      return `quantile(0.95)(${col})`
    case 'p99':
      return `quantile(0.99)(${col})`
    default:
      return `${p.agg}(${col})`
  }
}

/** The alias for a projection.
 *
 *  Deliberately never the name of a real column unless the projection *is*
 *  that column unchanged. Aliasing `toStartOfHour(ts)` as `ts` shadows the
 *  column inside the same SELECT, and a WHERE or GROUP BY that then mentions
 *  `ts` compares against the alias instead — a bug that already bit this
 *  codebase once, in the query-history query. */
export function aliasOf(p: Projection): string {
  if (p.agg === null) return p.bucket ? `${p.column}_${p.bucket}` : p.column
  if (p.agg === 'count') return p.column === '*' ? 'rows' : `count_${p.column}`
  return `${p.agg}_${p.column}`
}

/** One condition as SQL, or null when it is not yet complete enough to mean
 *  anything. Exported because the preview builds a WHERE from the same filters
 *  and one place has to decide how a typed value becomes a literal. */
export function conditionSql(c: Condition, type: string): string | null {
  const col = quoteIdent(c.column)
  switch (c.op) {
    case 'isNull':
      return `${col} IS NULL`
    case 'isNotNull':
      return `${col} IS NOT NULL`
    case 'like':
    case 'notLike': {
      if (!c.value.trim()) return null
      const keyword = c.op === 'like' ? 'LIKE' : 'NOT LIKE'
      // `contains` is what the label promises, so wrap in wildcards unless the
      // author wrote their own.
      const raw = c.value.trim()
      const pattern = raw.includes('%') ? raw : `%${raw}%`
      return `${col} ${keyword} ${quoteString(pattern)}`
    }
    case 'in':
    case 'notIn': {
      const items = c.value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
      if (items.length === 0) return null
      const keyword = c.op === 'in' ? 'IN' : 'NOT IN'
      return `${col} ${keyword} (${items.map((v) => literal(v, type)).join(', ')})`
    }
    case 'since': {
      const window = parseWindow(c.value)
      if (!window) return null
      // `now()` rather than a literal: the query means the same thing tomorrow,
      // which is what makes it worth saving or putting on a dashboard.
      return `${col} >= now() - INTERVAL ${window.n} ${window.unit}`
    }
    case 'between': {
      if (!c.value.trim() || !c.value2.trim()) return null
      return `${col} BETWEEN ${literal(c.value, type)} AND ${literal(c.value2, type)}`
    }
    default: {
      if (!c.value.trim()) return null
      return `${col} ${c.op} ${literal(c.value, type)}`
    }
  }
}

/** Render the spec as ClickHouse SQL, one clause per line.
 *
 *  Anything referring to a column not in `columns` is dropped rather than
 *  emitted: the model can outlive a schema change, and a query naming a column
 *  that no longer exists should come back shorter, not broken. */
export function toSql(spec: QuerySpec, columns: ColumnInfo[]): string {
  const typeOf = new Map(columns.map((c) => [c.name, c.type]))
  const known = (name: string) => name === '*' || typeOf.has(name)

  const projections = spec.projections.filter((p) => known(p.column))
  const dimensions = projections.filter((p) => p.agg === null)
  const aggregates = projections.filter((p) => p.agg !== null)

  const select =
    projections.length === 0
      ? ['*']
      : projections.map((p) => {
          const expr = expressionOf(p)
          const alias = aliasOf(p)
          return expr === alias ? expr : `${expr} AS ${quoteIdent(alias)}`
        })

  const where = spec.conditions
    .filter((c) => typeOf.has(c.column))
    .map((c) => conditionSql(c, typeOf.get(c.column)!))
    .filter((s): s is string => s !== null)

  const aliases = new Set(projections.map(aliasOf))
  const order = spec.orderings
    .filter((o) => aliases.has(o.ref))
    .map((o) => `${quoteIdent(o.ref)} ${o.desc ? 'DESC' : 'ASC'}`)

  const lines = [`SELECT ${select.join(', ')}`, `FROM ${quoteIdent(spec.database)}.${quoteIdent(spec.table)}`]
  if (where.length > 0) lines.push(`WHERE ${where.join(' AND ')}`)
  // Grouping is implied by mixing dimensions with aggregates, and groups by the
  // expression rather than the alias so a bucketed time cannot resolve to the
  // wrong thing.
  if (aggregates.length > 0 && dimensions.length > 0) {
    lines.push(`GROUP BY ${dimensions.map(expressionOf).join(', ')}`)
  }
  // Only over an aggregate that is actually selected: HAVING on something the
  // query does not compute is a query the server rejects.
  const aggAliases = new Set(aggregates.map(aliasOf))
  const having = spec.having
    .filter(
      (h) => aggAliases.has(h.ref) && h.value.trim() !== '' && Number.isFinite(Number(h.value)),
    )
    .map((h) => `${quoteIdent(h.ref)} ${h.op} ${Number(h.value)}`)
  if (having.length > 0) lines.push(`HAVING ${having.join(' AND ')}`)
  if (order.length > 0) lines.push(`ORDER BY ${order.join(', ')}`)
  if (spec.limit > 0) lines.push(`LIMIT ${Math.floor(spec.limit)}`)
  return lines.join('\n')
}

/** A spec that shows something useful the moment a table is picked, rather
 *  than an empty form. */
/** The query, read back as a sentence.
 *
 *  The SQL underneath is the contract, but a sentence catches the mistake SQL
 *  hides in plain sight: "count of rows by city" when you meant by day is
 *  obvious in English and easy to miss in a SELECT. It doubles as the default
 *  name when the query is saved, which is why it leads with what is measured. */
export function describe(spec: QuerySpec, columns: ColumnInfo[]): string {
  const typeOf = new Map(columns.map((c) => [c.name, c.type]))
  const known = (name: string) => name === '*' || typeOf.has(name)
  const projections = spec.projections.filter((p) => known(p.column))
  const measures = projections.filter((p) => p.agg !== null)
  const dimensions = projections.filter((p) => p.agg === null)

  const parts: string[] = []
  if (projections.length === 0) {
    parts.push(`every column of ${spec.table || 'the table'}`)
  } else {
    if (measures.length > 0) parts.push(list(measures.map(measureOf)))
    if (dimensions.length > 0) {
      const by = list(dimensions.map((p) => (p.bucket ? `${p.column} by ${p.bucket}` : p.column)))
      parts.push(measures.length > 0 ? `by ${by}` : by)
    }
  }

  const filters = spec.conditions.filter((c) => typeOf.has(c.column)).map(conditionWords)
  if (filters.length > 0) parts.push(`where ${list(filters)}`)

  const aggAliases = new Set(measures.map(aliasOf))
  const kept = spec.having
    .filter((h) => aggAliases.has(h.ref) && h.value.trim() !== '')
    .map((h) => `${h.ref} ${h.op} ${h.value.trim()}`)
  if (kept.length > 0) parts.push(`keeping groups where ${list(kept)}`)

  if (spec.limit > 0) parts.push(`first ${spec.limit}`)
  return parts.join(', ')
}

/** `count of rows`, `average temperature`, `95th percentile of latency_ms`. */
function measureOf(p: Projection): string {
  const label = AGG_LABEL[p.agg!]
  if (p.column === '*') return `${label} of rows`
  return label.endsWith('e') || label.includes('percentile') || label === 'median'
    ? `${label} of ${p.column}`
    : `${label} ${p.column}`
}

function conditionWords(c: Condition): string {
  if (opTakesNoValue(c.op)) return `${c.column} ${OP_LABEL[c.op]}`
  if (c.op === 'since') return `${c.column} in the last ${c.value.trim() || '—'}`
  if (c.op === 'between') return `${c.column} between ${c.value} and ${c.value2}`
  const value = c.value.trim()
  // A list of values in a sentence full of commas needs its own bracket, or
  // "one of Berlin, Paris, first 500" reads as three filters.
  const shown = c.op === 'in' || c.op === 'notIn' ? `“${value}”` : value
  return `${c.column} ${OP_LABEL[c.op]} ${shown || '—'}`
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export function startingSpec(database: string, table: string): QuerySpec {
  return {
    database,
    table,
    projections: [],
    conditions: [],
    having: [],
    orderings: [],
    limit: 500,
  }
}
