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
import type { Agg, Bucket, Condition, Having, Op, Ordering, Projection, QuerySpec } from './query'
import { aliasOf, parseWindow, startingSpec } from './query'

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

/* ── The document, back ────────────────────────────────────────────────────
 *
 *  One direction is enough to *ask* a question. It is not enough to publish
 *  one. A published document is a bookmark, and a bookmark nobody can reopen is
 *  a dead end: "this URL returns exactly what you are looking at" is only
 *  believable if pasting it back proves it in two seconds. So the document has
 *  to come back as the form that would have written it.
 *
 *  The property the tests hold this to: for every document `specToDsl` can
 *  produce, `specToDsl(dslToSpec(d))` is `d` again. Not the same spec — ids are
 *  minted fresh, and a bucketed dimension has no seat of its own to return to —
 *  the same *question*.
 *
 *  Where the form cannot hold what the document says, it shows nothing and says
 *  why. Refusing is the unusual choice in this codebase, which prefers a lossy
 *  answer that names its losses, and it is the right one exactly here: a filter
 *  quietly dropped on the way in leaves a form asking a different question than
 *  the URL printed beside it, with nothing on screen saying so. Every refusal
 *  below is a difference in which rows come back. Nothing is refused for being
 *  merely inelegant.
 */

/** The form that would have written this document, or why none would have. */
export type Rehydration = { spec: QuerySpec } | { blocked: string }

/** The document's operator words, back in the Builder's. */
const OPS_BACK = new Map<string, Op>(
  (Object.entries(OPS) as [Op, string][]).map(([op, word]) => [word, op]),
)

const AGGS_BACK = new Map<string, Agg>(
  (Object.entries(AGGS) as [Agg, string][]).map(([agg, word]) => [word, agg]),
)

/** The buckets the form has a control for. The server knows more units than
 *  this — a year, for one — and a document asking for one of those is a real
 *  question the form has no row to show it in. */
const BUCKETS = new Set<string>(['minute', 'hour', 'day', 'week', 'month'])

/** A window's unit, back as the letter `parseWindow` reads. Weeks, months and
 *  years are missing for the same reason: `24h` and `30d` are the whole of the
 *  shorthand the form's field accepts. */
const WINDOW_LETTERS = new Map<string, string>([
  ['minute', 'm'],
  ['hour', 'h'],
  ['day', 'd'],
])

const HAVING_OPS = new Set<string>(['=', '!=', '>', '>=', '<', '<='])

/* The keys each object of a document may carry.
 *
 *  Mirrors `#[serde(deny_unknown_fields)]` on the Rust side, and for a stronger
 *  reason than symmetry. A field this file does not know about is a field it
 *  drops, and the fields it does not know about are `period`, `from`, `to` and
 *  `compare` — every one of them a narrowing. Dropping one turns "December
 *  against November" into "everything, ever" and reopens it in a form that
 *  looks complete. So an unknown key is a refusal, not a shrug. */
const QUERY_KEYS = [
  'dataset',
  'select',
  'dimensions',
  'metrics',
  'filter',
  'having',
  'time',
  'order',
  'limit',
  'timezone',
  'query_id',
]
const TIME_KEYS = ['column', 'last', 'unit', 'granularity']
const METRIC_KEYS = ['aggregation', 'column', 'as']
const ORDER_KEYS = ['column', 'desc']
const NODE_KEYS = ['all', 'any', 'not', 'column', 'op', 'value', 'values']

/** The first key `known` does not list, or null. */
function strayKey(value: unknown, known: string[]): string | null {
  if (typeof value !== 'object' || value === null) return null
  return Object.keys(value as Record<string, unknown>).find((k) => !known.includes(k)) ?? null
}

function newId(): string {
  return crypto.randomUUID()
}

/** The two-bound shape `between` becomes on the way out.
 *
 *  Recognised rather than remembered: the document has no `between`, because
 *  the server has no `between` and does not need one where it has a tree. Two
 *  bounds on one column, the lower first, is what one looks like. */
function isBetween(node: DslFilter): boolean {
  const pair = node.all
  if (!pair || pair.length !== 2) return false
  const [lower, upper] = pair as [DslFilter, DslFilter]
  return (
    !!lower.column &&
    lower.column === upper.column &&
    lower.op === 'gte' &&
    upper.op === 'lte' &&
    lower.value !== undefined &&
    upper.value !== undefined
  )
}

/** A value as the form's field holds it: text, because a field is text. */
function typed(value: string | number | boolean | undefined): string {
  return value === undefined ? '' : String(value)
}

/** One node as a filter row, or a sentence saying why it cannot be one. */
function conditionOf(node: DslFilter): Condition | string {
  const stray = strayKey(node, NODE_KEYS)
  if (stray) return `The form does not know the filter field \`${stray}\`.`

  if (node.any) {
    // The one refusal that is about the form's shape rather than its
    // vocabulary. Its filters are a list, and a list is an AND; there is no
    // control anywhere on it that would show an OR, so an `any` reopened as a
    // list of rows would return rows the document never asked for.
    return 'This question has an `any` in it — the form filters with AND only.'
  }

  if (node.not) {
    const inner = node.not
    if (inner.op !== 'like' || !inner.column || inner.value === undefined) {
      // `notLike` is the only negation the form can spell, and it spells it as
      // a `not` around a `like` because that is what the form's own translation
      // produces. Any other negation is a tree.
      return 'The form can only negate a `like`.'
    }
    return {
      id: newId(),
      column: inner.column,
      op: 'notLike',
      value: typed(inner.value),
      value2: '',
    }
  }

  if (node.all) {
    if (!isBetween(node)) return 'This question nests its filters; the form keeps a flat list.'
    const [lower, upper] = node.all as [DslFilter, DslFilter]
    return {
      id: newId(),
      column: lower.column as string,
      op: 'between',
      value: typed(lower.value),
      value2: typed(upper.value),
    }
  }

  const op = node.op ? OPS_BACK.get(node.op) : undefined
  if (!node.column || !op) {
    return node.op
      ? `The form has no \`${node.op}\` filter.`
      : 'A filter in this question names no operator.'
  }
  if (op === 'in' || op === 'notIn') {
    // Back into the one comma-separated field the form offers, which `listOf`
    // splits the same way on the trip out.
    return {
      id: newId(),
      column: node.column,
      op,
      value: (node.values ?? []).map(typed).join(', '),
      value2: '',
    }
  }
  return { id: newId(), column: node.column, op, value: typed(node.value), value2: '' }
}

/** The tree's top level as the rows the form shows.
 *
 *  A single `between` is its own `all` at the top, because `conjunction`
 *  unwraps a list of one — so it has to be recognised before an `all` is read
 *  as a list of rows. Read the other way it would still ask the same question,
 *  but it would come back as two rows where somebody used one control. */
function rowsOf(filter: DslFilter): DslFilter[] {
  if (isBetween(filter)) return [filter]
  return filter.all ?? [filter]
}

export function dslToSpec(query: DslQuery, ownDatabase = ''): Rehydration {
  const stray = strayKey(query, QUERY_KEYS)
  if (stray) return { blocked: `The form does not know the field \`${stray}\`.` }

  const raw = (query.dataset ?? '').trim()
  if (!raw) return { blocked: 'This document names no dataset.' }
  // The first dot, the way `dataset::parse_name` splits it: a database name
  // cannot contain one and a table name can.
  const dot = raw.indexOf('.')
  const database = dot === -1 ? ownDatabase : raw.slice(0, dot)
  const table = dot === -1 ? raw : raw.slice(dot + 1)
  if (!database) return { blocked: `\`${raw}\` names no database, and this page has none to lend it.` }
  if (!table) return { blocked: `\`${raw}\` is half a name — write \`database.table\`.` }

  const select = query.select ?? []
  const dimensions = query.dimensions ?? []
  const metrics = query.metrics ?? []
  if (select.length && (dimensions.length || metrics.length)) {
    // The server refuses this pair too, and for the same reason: they are two
    // ways of saying what comes back.
    return { blocked: '`select` and `dimensions` are two ways of saying what comes back.' }
  }

  const times = query.time === undefined ? [] : Array.isArray(query.time) ? query.time : [query.time]
  const projections: Projection[] = []
  const windows: Condition[] = []

  for (const column of select.length ? select : dimensions) {
    projections.push({ id: newId(), column, agg: null, bucket: null })
  }

  for (const time of times) {
    const strayTime = strayKey(time, TIME_KEYS)
    if (strayTime) return { blocked: `The form does not know the time field \`${strayTime}\`.` }
    if (!time.column) {
      // The server resolves an absent column against the dataset's own, where
      // it has exactly one. That takes describing the dataset, which is a round
      // trip, and this is a pure function — so the document has to say.
      return { blocked: 'A time in this question names no column, and the form cannot guess it.' }
    }
    if (time.granularity !== undefined) {
      if (!BUCKETS.has(time.granularity)) {
        return { blocked: `\`${time.granularity}\` is not one of the form's buckets.` }
      }
      projections.push({
        id: newId(),
        column: time.column,
        agg: null,
        bucket: time.granularity as Bucket,
      })
    }
    if (time.last !== undefined) {
      // The plural the documentation writes and the singular the form sends are
      // the same unit; the server takes either, so this does too.
      const letter = WINDOW_LETTERS.get((time.unit ?? '').toLowerCase().replace(/s$/, ''))
      if (!letter) {
        return { blocked: `The form has no window in ${time.unit ?? 'that unit'} — only minutes, hours and days.` }
      }
      windows.push({
        id: newId(),
        column: time.column,
        op: 'since',
        value: `${time.last}${letter}`,
        value2: '',
      })
    }
    if (time.granularity === undefined && time.last === undefined) {
      return { blocked: 'A time in this question is neither a window nor a bucket.' }
    }
  }

  const bucketed = projections.some((p) => p.bucket !== null)
  if (dimensions.length && !metrics.length && !bucketed) {
    // `SELECT city FROM t GROUP BY city` and `SELECT city FROM t` are different
    // answers — the first one dedupes. The form has no grouping it can express
    // without something computed over it, so it cannot show this one.
    return { blocked: 'This question groups without computing anything, which the form cannot show.' }
  }

  for (const metric of metrics) {
    const strayMetric = strayKey(metric, METRIC_KEYS)
    if (strayMetric) return { blocked: `The form does not know the metric field \`${strayMetric}\`.` }
    const agg = AGGS_BACK.get(metric.aggregation)
    if (!agg) return { blocked: `The form cannot compute \`${metric.aggregation}\`.` }
    // `count` with no column counts rows, which the form spells `count(*)`.
    const projection: Projection = {
      id: newId(),
      column: metric.column ?? '*',
      agg,
      bucket: null,
    }
    // What this column will be called in the answer, and therefore what an
    // `order` or a `having` elsewhere in the document is pointing at. The form
    // names its own columns and has no field to override it, so a document that
    // calls one something else cannot be reopened here without silently
    // renaming a key somebody's chart is reading. Said, rather than done.
    const given = metric.as ?? (metric.column ? `${metric.aggregation}_${metric.column}` : metric.aggregation)
    const wanted = aliasOf(projection)
    if (given !== wanted) {
      return { blocked: `This question calls a column \`${given}\`; the form would call it \`${wanted}\`.` }
    }
    projections.push(projection)
  }

  const conditions: Condition[] = []
  if (query.filter) {
    for (const node of rowsOf(query.filter)) {
      const row = conditionOf(node)
      if (typeof row === 'string') return { blocked: row }
      conditions.push(row)
    }
  }
  // After the filters, because that is where they came from: `specToDsl` reads
  // the windows out of the same list and the order among them is what the
  // document's `time` entries preserve.
  conditions.push(...windows)

  const having: Having[] = []
  for (const node of query.having ? rowsOf(query.having) : []) {
    const row = conditionOf(node)
    if (typeof row === 'string') return { blocked: row }
    if (!HAVING_OPS.has(row.op)) {
      return { blocked: `The form has no \`${row.op}\` to compare a computed value with.` }
    }
    having.push({ id: newId(), ref: row.column, op: row.op as Having['op'], value: row.value })
  }

  const orderings: Ordering[] = []
  for (const sort of query.order ?? []) {
    const straySort = strayKey(sort, ORDER_KEYS)
    if (straySort) return { blocked: `The form does not know the order field \`${straySort}\`.` }
    orderings.push({ id: newId(), ref: sort.column, desc: sort.desc })
  }

  return {
    spec: {
      ...startingSpec(database, table),
      projections,
      conditions,
      having,
      orderings,
      // No limit in the document is no limit in the form, and not the 500 a
      // fresh one starts at: a document that asked for everything must not come
      // back capped by a default nobody wrote down.
      limit: query.limit ?? 0,
      timezone: query.timezone ?? '',
    },
  }
}
