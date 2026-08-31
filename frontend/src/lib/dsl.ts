/** The Builder's spec, as a question for the dataset API.
 *
 *  Flint grew two query languages: this one, in the browser, which turns a spec
 *  into SQL and posts the SQL; and the dataset API's, which takes a document and
 *  writes the SQL on the server. Two languages for one product is two sets of
 *  rules that drift — and they had already drifted before anyone noticed, on the
 *  one word where it matters most: `uniq` here meant an *estimate*, honestly
 *  labelled, while `distinct_count` there meant an exact answer. Same concept,
 *  two numbers.
 *
 *  So this translates rather than duplicates. The Builder goes on being the
 *  Builder — the same spec, the same controls — and what it sends is a document
 *  the server reads, which means the operators, the arity rules, the binding and
 *  the identifier checks are all decided in exactly one place.
 *
 *  Nothing is lost on the way, and that was the condition for doing it at all:
 *  the server gained percentiles, an approximate distinct count under a name
 *  that says so, and `HAVING`, because those were the three things this spec
 *  could say and that document could not. What it still cannot say, it says so
 *  about — see `blocked`.
 */

import type { QueryResult } from './api'
import type { Condition, Having, Op, QuerySpec } from './query'
import { aliasOf, parseWindow } from './query'

/** One node of the document's filter tree. Mirrors `src/dataset/mod.rs`. */
export interface DslFilter {
  all?: DslFilter[]
  any?: DslFilter[]
  not?: DslFilter
  column?: string
  op?: string
  value?: string | number | boolean
  values?: (string | number | boolean)[]
}

export interface DslMetric {
  aggregation: string
  column?: string
  as?: string
}

export interface DslTime {
  column?: string
  last?: number
  unit?: string
  granularity?: string
}

export interface DslQuery {
  dataset: string
  select?: string[]
  dimensions?: string[]
  metrics?: DslMetric[]
  filter?: DslFilter
  having?: DslFilter
  /** One time, or several — the document takes either, and one stays one so a
   *  pasted example reads the way the documentation writes it. */
  time?: DslTime | DslTime[]
  order?: { column: string; desc: boolean }[]
  limit?: number
  /** Where the days begin. Left out for the server's own zone — and left out
   *  entirely when this question draws no boundary, because the server refuses
   *  a zone that would place nothing. */
  timezone?: string
  /** The handle this read is filed under, so it can be stopped.
   *
   *  Never part of a translated spec: it is minted per *run*, and a spec that
   *  carried one would make every keystroke look like a different question to
   *  the cache that renders the SQL beside the form. Added at the call. */
  query_id?: string
}

/** Either a question the server can answer, or why it cannot be one. */
export type Translation = { query: DslQuery } | { blocked: string }

/** The Builder's operator names, in the document's words.
 *
 *  `notLike` has no operator of its own on the server, and does not need one:
 *  a tree can negate. That is the shape of most of what looks missing here. */
const OPS: Partial<Record<Op, string>> = {
  '=': 'eq',
  '!=': 'ne',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  like: 'like',
  in: 'in',
  notIn: 'nin',
  isNull: 'isnull',
  isNotNull: 'notnull',
}

/** The Builder's aggregations, in the document's words.
 *
 *  `uniq` becomes `distinct_count_approx` and not `distinct_count`. The Builder
 *  has always labelled this one "distinct (approx.)" and it has always been
 *  right to; mapping it onto the exact one would quietly change what the number
 *  means and make a slow query out of a fast one. */
const AGGS: Record<string, string> = {
  count: 'count',
  uniq: 'distinct_count_approx',
  sum: 'sum',
  avg: 'avg',
  min: 'min',
  max: 'max',
  median: 'median',
  p95: 'p95',
  p99: 'p99',
}

/** `a, b` → `['a', 'b']`, the way the Builder's `in` field is typed. */
function listOf(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '')
}

/** One condition as a node, or null where it is not complete enough to mean
 *  anything — the same rule `conditionSql` follows, so a half-typed filter
 *  produces no clause rather than a clause that means something else. */
function nodeOf(c: Condition): DslFilter | null {
  if (!c.column) return null

  if (c.op === 'isNull' || c.op === 'isNotNull') {
    return { column: c.column, op: OPS[c.op] }
  }
  if (c.value.trim() === '') return null

  if (c.op === 'between') {
    // Two bounds and one meaning, so one node: the server has no `between`,
    // and does not need one where it has a tree.
    if (c.value2.trim() === '') return null
    return {
      all: [
        { column: c.column, op: 'gte', value: c.value.trim() },
        { column: c.column, op: 'lte', value: c.value2.trim() },
      ],
    }
  }
  if (c.op === 'notLike') {
    return { not: { column: c.column, op: 'like', value: c.value.trim() } }
  }
  if (c.op === 'in' || c.op === 'notIn') {
    const values = listOf(c.value)
    return values.length ? { column: c.column, op: OPS[c.op], values } : null
  }
  // `since` is a window, not a comparison, and is lifted out before this.
  const op = OPS[c.op]
  return op ? { column: c.column, op, value: c.value.trim() } : null
}

/** A filter on a computed value. Its operators are a subset of the others', so
 *  it needs no rules of its own. */
function havingNode(h: Having): DslFilter | null {
  if (!h.ref || h.value.trim() === '') return null
  const op = OPS[h.op]
  return op ? { column: h.ref, op, value: h.value.trim() } : null
}

function conjunction(nodes: DslFilter[]): DslFilter | undefined {
  if (nodes.length === 0) return undefined
  // One node stays one node: `{all: [x]}` and `x` mean the same thing, and the
  // shorter one is the one somebody reading the request can follow.
  return nodes.length === 1 ? nodes[0] : { all: nodes }
}

/** What `POST /api/data` answers with. */
export interface DslAnswer {
  rows: Record<string, unknown>[]
  columns: string[]
  types: Record<string, string>
  sql: string
  truncated: boolean
  statistics: { elapsed: number; rows_read: number; bytes_read: number }
  page: { returned: number; has_more: boolean }
  /** The zone this answer's dates were cut in — always said, whether or not it
   *  was asked for. Null only where Flint could not learn the server's own. */
  timezone: string | null
}

/** The answer, in the shape the results grid reads.
 *
 *  The dataset API returns a row as an object keyed by column, which is what a
 *  script wants; the grid wants an array in column order, which is what the
 *  editor's own endpoint returns. Neither shape is wrong, so this converts
 *  rather than arguing — and it converts *here*, in one tested function,
 *  instead of inside a component where the mapping would be invisible. */
export function asResult(answer: DslAnswer, queryId = ''): QueryResult {
  const columns = answer.columns.map((name) => ({
    // A column the server did not type is a column the grid left-aligns, which
    // is the safe way to be wrong about one.
    name,
    type: answer.types?.[name] ?? '',
  }))
  return {
    query_id: queryId,
    columns,
    rows: answer.rows.map((row) => answer.columns.map((name) => row[name] ?? null)),
    truncated: answer.truncated,
    rows_before_limit_at_least: null,
    statistics: answer.statistics,
    /* The whole `QueryResult`, not most of it.

       This used to hand back the six fields the Builder's own panels read and
       be cast to a `QueryResult` at the call site. That cast was a promise
       nobody was keeping: the stats strip in the editor reads `kind` and
       `summary.written_rows`, so the first result from a form to reach it would
       have thrown on an object that never had them. A dataset read is always a
       read and never writes, so both are knowable here — and stating them is
       what lets one strip serve both faces of the page. */
    summary: {
      read_rows: answer.statistics.rows_read,
      read_bytes: answer.statistics.bytes_read,
      written_rows: 0,
      result_rows: answer.rows.length,
      result_bytes: 0,
      elapsed_ns: Math.round(answer.statistics.elapsed * 1e9),
    },
    kind: 'read',
  }
}

export function specToDsl(spec: QuerySpec): Translation {
  if (!spec.table) return { blocked: 'Choose a table first.' }

  const dimensions = spec.projections.filter((p) => p.agg === null)
  const metrics = spec.projections.filter((p) => p.agg !== null)

  /* Every time in the question, as its own entry.
     
     This used to refuse two buckets, two windows, and a window and a bucket on
     different columns — three questions the Builder had always been able to
     ask, blocked because the document held one `time` and one only. It holds a
     list now. The lesson kept: converging two languages is only honest if the
     one that survives can say everything the other could. */
  const times: DslTime[] = []

  for (const p of dimensions) {
    if (p.bucket) times.push({ column: p.column, granularity: p.bucket })
  }

  for (const c of spec.conditions) {
    if (c.op !== 'since') continue
    if (c.value.trim() === '') continue
    const parsed = parseWindow(c.value)
    if (!parsed) return { blocked: `"${c.value}" is not a window — try 24h, 7d, 15m.` }
    // A window and a bucket on the same column are one entry, not two: the
    // document reads them together, and two entries would filter twice.
    const existing = times.find((t) => t.column === c.column)
    const entry = existing ?? { column: c.column }
    entry.last = parsed.n
    // The server takes the unit's name, not SQL's keyword for it.
    entry.unit = parsed.unit.toLowerCase()
    if (!existing) times.push(entry)
  }

  const unsupported = metrics.find((p) => !AGGS[p.agg as string])
  if (unsupported) {
    return { blocked: `Flint cannot compute ${unsupported.agg} through this API yet.` }
  }

  const filters = spec.conditions
    .filter((c) => c.op !== 'since')
    .map(nodeOf)
    .filter((n): n is DslFilter => n !== null)
  const havings = spec.having.map(havingNode).filter((n): n is DslFilter => n !== null)

  const query: DslQuery = { dataset: `${spec.database}.${spec.table}` }

  const bucketed = times.some((t) => t.granularity)
  if (metrics.length || bucketed) {
    // An aggregate. Dimensions are what is grouped by, and the bucketed one is
    // the time — the document names it in `time`, so it is not repeated here.
    const grouped = dimensions.filter((p) => p.bucket === null).map((p) => p.column)
    if (grouped.length) query.dimensions = grouped
    if (metrics.length) {
      query.metrics = metrics.map((p) => ({
        aggregation: AGGS[p.agg as string] as string,
        // `count(*)` counts rows, and the document says that by naming no
        // column at all.
        ...(p.column === '*' ? {} : { column: p.column }),
        // The Builder's own name for it, so the answer's keys are the ones
        // already on screen.
        as: aliasOf(p),
      }))
    }
  } else if (dimensions.length) {
    query.select = dimensions.map((p) => p.column)
  }

  const filter = conjunction(filters)
  if (filter) query.filter = filter
  const having = conjunction(havings)
  if (having) query.having = having
  // One stays one: the object is the shape the documentation shows and almost
  // every request sends, and a list of one would be noise in a pasted example.
  if (times.length === 1) query.time = times[0]
  else if (times.length > 1) query.time = times

  const order = spec.orderings
    .filter((o) => o.ref)
    .map((o) => ({ column: o.ref, desc: o.desc }))
  if (order.length) query.order = order
  if (spec.limit > 0) query.limit = spec.limit

  // Only where there is a boundary for it to move. The server refuses a zone
  // on a question with no window and no bucket, and sending one anyway would
  // turn a zone left over from an earlier question into a refusal the Builder
  // could not explain — the picker is hidden in that case for the same reason.
  if (spec.timezone && times.length) query.timezone = spec.timezone

  return { query }
}
