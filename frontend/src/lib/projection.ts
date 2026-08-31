/** What the workload asks of a table, what the table is sorted by, and the
 *  projection that would close the gap.
 *
 *  The backend counts; this decides — the same split as the schema review, for
 *  the same reason. Every rule below is a sentence somebody could argue with:
 *  "a filter that is not a prefix of the sorting key reads the whole table",
 *  "an aggregate projection is worth it when the group count is a small
 *  fraction of the row count", "the column list is the difference between a
 *  proposal costing 8% of the table and one costing 100%". Arguments belong in
 *  a test file.
 *
 *  Five rules of conduct, because a projection recommendation that is wrong
 *  costs disk on every insert, forever, until somebody notices.
 *
 *  **Nothing is proposed from a query this file did not understand.** The
 *  parser here reads a single-table SELECT and refuses everything else — a
 *  JOIN, a UNION, a subquery, a filter it cannot attribute to one column. A
 *  pattern that is refused is *shown*, with the reason, rather than dropped:
 *  "Flint cannot read this one" is a fact about the advice, and hiding it makes
 *  the list look more complete than it is.
 *
 *  **The benefit is arithmetic over measurements, never a guess.** What a
 *  pattern costs today is what ClickHouse recorded it costing. What it would
 *  cost with the projection is `parts × index_granularity` for a sort-order
 *  projection and the measured group count for an aggregate one. Both are
 *  bounds, both are labelled as bounds, and neither is offered before the
 *  measurement that grounds it has been run.
 *
 *  **The cost is stated as loudly as the benefit.** A projection is a second
 *  copy of the data. It is written on every insert and merged on every merge,
 *  and `ADD PROJECTION` does none of that to the rows already there — so the
 *  recommendation is two statements and says which one is the mutation. A
 *  re-sorted projection's size is what its columns cost today; a pre-aggregated
 *  one's is the width of its aggregate states, which nothing can read off a
 *  schema, so it is weighed by building it or it is not stated.
 *
 *  **Say what the projection will *not* answer.** A narrow projection is
 *  thirteen times smaller than `SELECT *` and answers only the queries whose
 *  columns it holds. Measured: the same query with one more column in it went
 *  straight back to reading all five million rows. That sentence ships with
 *  every proposal.
 *
 *  **Nothing here runs anything.** This produces text. */

import type {
  Advice,
  AdviceColumn,
  DatabaseAdvice,
  Existing,
  Measurement,
  Pattern,
  TableStanding,
  Weight,
} from './api'
import { tokenize, type Token } from './ddl'
import { bytes, count, exact } from './format'
import { quoteIdent } from './query'
import {
  bodyOf,
  fromRef,
  groupTerms,
  selectItems,
  shapeOf,
  whereTerms,
  type Piece,
  type Shape,
} from './rewrite'

/** Bucketing functions a proposed key may wrap a column in. The same closed
 *  list the backend will accept — a key term it does not recognise is refused
 *  there, so a longer list here would only produce proposals that cannot be
 *  measured. */
export const BUCKETS = [
  'toStartOfMinute',
  'toStartOfFiveMinutes',
  'toStartOfHour',
  'toDate',
  'toStartOfDay',
  'toStartOfWeek',
  'toStartOfMonth',
  'toStartOfQuarter',
  'toStartOfYear',
] as const

const BUCKET_SET = new Set<string>(BUCKETS)

/** Aggregate functions common enough to recognise by name.
 *
 *  Recognising them is only ever used to tell a dimension from a measure in a
 *  select list, and the failure is asymmetric: a function missing from this
 *  list makes a pattern *unreadable*, which the UI says out loud, whereas a
 *  non-aggregate wrongly on it would silently produce a projection ClickHouse
 *  refuses. So the list is conservative, and the combinator suffixes below do
 *  the rest of the work — `sumIf`, `countIf`, `avgMerge`, `quantilesState` are
 *  all reached that way rather than enumerated. */
const AGGREGATES = new Set([
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'any',
  'anyLast',
  'uniq',
  'uniqExact',
  'uniqCombined',
  'uniqHLL12',
  'uniqTheta',
  'median',
  'quantile',
  'quantiles',
  'quantileExact',
  'quantileTDigest',
  'argMin',
  'argMax',
  'groupArray',
  'groupUniqArray',
  'topK',
  'stddevPop',
  'stddevSamp',
  'varPop',
  'varSamp',
  'sumMap',
  'corr',
  'covarPop',
  'entropy',
  'histogram',
  'maxIntersections',
  'sequenceCount',
  'windowFunnel',
  'retention',
])

const COMBINATORS = ['If', 'Array', 'Map', 'State', 'Merge', 'ForEach', 'Distinct', 'OrNull', 'OrDefault', 'Resample']

/** Whether a function name is an aggregate, allowing for ClickHouse's
 *  combinator suffixes — `sumIf`, `uniqExactMerge`, `quantilesTDigestIf`. */
export function isAggregate(name: string): boolean {
  if (AGGREGATES.has(name)) return true
  for (const suffix of COMBINATORS) {
    if (name.endsWith(suffix)) {
      const stem = name.slice(0, -suffix.length)
      if (stem && isAggregate(stem)) return true
    }
  }
  return false
}

/* -- Reading one statement --------------------------------------------- */

/** One term of a projection key: a column, optionally bucketed. */
export interface KeyTerm {
  column: string
  bucket: string | null
  /** How it will be written in the DDL and in the measurement. */
  expr: string
}

export type FilterKind = 'equality' | 'range'

export interface Filter {
  column: string
  kind: FilterKind
  /** The bucketing function the comparison went through, if any.
   *
   *  Load-bearing, and the reason a filter is not just a column name.
   *  `WHERE toStartOfHour(time) > …` reaches a projection keyed on
   *  `toStartOfHour(time)`; `WHERE time > …` does not. Measured, on the same
   *  projection and the same data: 620 rows against 2,363,170. Without this
   *  field the two are indistinguishable and the advice is wrong for one of
   *  them whichever way it is written. */
  bucket: string | null
  expr: string
}

/** What one query shape asks of the table.
 *
 *  Only ever produced from a statement this file read all the way through. The
 *  fields are what the rules need and nothing more — this is not an AST and
 *  must not grow into one. */
export interface Access {
  /** `=` and `IN`, which a sort order serves best. */
  equalities: Filter[]
  /** `>`, `<`, `BETWEEN` — served by a sort order too, but only after the
   *  equalities, which is why the two are kept apart. */
  ranges: Filter[]
  /** The grouping, when there is one this file could resolve to columns. */
  group: KeyTerm[] | null
  /** The aggregate expressions, verbatim and without their aliases.
   *
   *  Verbatim on purpose. ClickHouse matches a query's aggregates against a
   *  projection's **by expression**, not algebraically: measured, a projection
   *  holding `count(), sum(value)` did not answer `avg(value)` — 5,000,000 rows
   *  read, not 15 — and adding `avg(value)` to the projection fixed it. So the
   *  proposal copies what the workload actually wrote. */
  aggregates: string[]
  /** Every column of the table the statement touches. This is what a sort-order
   *  projection has to hold to be usable at all. */
  columns: string[]
  /** `SELECT *`, which means every column and makes a narrow proposal
   *  impossible. */
  star: boolean
}

export type Unreadable =
  | 'not-a-select'
  | 'compound'
  | 'joins'
  | 'not-this-table'
  | 'opaque-filter'
  | 'opaque-grouping'
  | 'no-columns'

/** Why a pattern produced no advice, in the reader's terms. */
export const UNREADABLE: Record<Unreadable, string> = {
  'not-a-select': 'not a SELECT this reads',
  compound: 'a UNION — two queries in one, with two shapes',
  joins: 'reads more than one table; a projection belongs to one',
  'not-this-table': 'reads this table through a view or a subquery',
  'opaque-filter': 'a filter this cannot attribute to one column',
  'opaque-grouping': 'groups by an expression this cannot resolve to columns',
  'no-columns': 'names no column of this table',
}

export interface Reading {
  access: Access | null
  refused: Unreadable | null
}

function unquote(text: string): string {
  if (text.startsWith('`') || text.startsWith('"')) {
    return text.slice(1, -1).replace(/\\`/g, '`').replace(/``/g, '`').replace(/""/g, '"')
  }
  return text
}

function meaningful(sql: string): Token[] {
  return tokenize(sql).filter((t) => t.kind !== 'space' && t.kind !== 'comment')
}

/** Column names of the table that appear in a fragment.
 *
 *  A token is a column reference when it names one and is not being called —
 *  the tokenizer already marks `name(` as a function, which is what keeps a
 *  table with a column called `date` or `length` from turning every call to
 *  those functions into a filter on it. */
function columnRefs(
  fragment: string,
  known: Set<string>,
  aliases: Map<string, string> = new Map(),
): string[] {
  const out: string[] = []
  for (const tok of meaningful(fragment)) {
    if (tok.kind !== 'name' && tok.kind !== 'quoted') continue
    const name = unquote(tok.text)
    if (known.has(name)) {
      if (!out.includes(name)) out.push(name)
      continue
    }
    // A name that is not a column may still be a select alias standing in for
    // one: `toStartOfHour(time) AS h … WHERE h > now()` is ordinary ClickHouse,
    // and reading it as "a filter on nothing" made the commonest bucketed
    // pattern there is unreadable. One level of resolution — an alias defined
    // in terms of another alias is rare enough to leave unread rather than
    // risk a cycle.
    const behind = aliases.get(name)
    if (!behind) continue
    for (const column of columnRefs(behind, known)) {
      if (!out.includes(column)) out.push(column)
    }
  }
  return out
}

/** The comparison in one WHERE conjunct, as a kind.
 *
 *  Punctuation arrives one character at a time, so `>=` is two tokens and has
 *  to be read as one. Anything this does not recognise — a `LIKE`, a
 *  `has(tags, …)`, an inequality — is not a filter a sort order can use, and
 *  saying so is the whole point: proposing a key for a `LIKE` would produce a
 *  projection that never gets chosen. */
function comparison(term: string): FilterKind | null {
  const tokens = meaningful(term)
  let ops = ''
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!
    if (tok.kind === 'punct' && '=<>!'.includes(tok.text)) {
      ops += tok.text
      continue
    }
    if (ops) break
    if (tok.kind === 'keyword' || tok.kind === 'name') {
      const word = tok.text.toUpperCase()
      if (word === 'IN') return 'equality'
      if (word === 'BETWEEN') return 'range'
      // `NOT IN` and `NOT BETWEEN` select everything but a few values: a sort
      // order does nothing for either.
      if (word === 'NOT') return null
      if (word === 'LIKE' || word === 'ILIKE') return null
    }
  }
  if (ops === '=' || ops === '==') return 'equality'
  if (ops === '>' || ops === '<' || ops === '>=' || ops === '<=') return 'range'
  return null
}

/** Where the comparison starts in a conjunct, so the part before it — the thing
 *  being filtered — can be read on its own. */
function operatorAt(term: string): number | null {
  let depth = 0
  for (const tok of meaningful(term)) {
    if (tok.kind === 'punct' && (tok.text === '(' || tok.text === '[')) {
      depth += 1
      continue
    }
    if (tok.kind === 'punct' && (tok.text === ')' || tok.text === ']')) {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth !== 0) continue
    if (tok.kind === 'punct' && '=<>!'.includes(tok.text)) return tok.at
    if (tok.kind === 'keyword' || tok.kind === 'name') {
      const word = tok.text.toUpperCase()
      if (word === 'IN' || word === 'BETWEEN' || word === 'NOT' || word === 'LIKE' || word === 'ILIKE') {
        return tok.at
      }
    }
  }
  return null
}

/** Resolve one GROUP BY term to a key term.
 *
 *  Three shapes are resolvable and nothing else: a bare column, a bucketing
 *  function of one column, and an alias pointing at either of those in the
 *  select list. `toStartOfInterval(ts, INTERVAL 1 HOUR)` is deliberately not on
 *  that list — it is a perfectly good projection key, but it is not one the
 *  measurement endpoint accepts, and a proposal that cannot be weighed is a
 *  proposal this file will not make. */
function keyTerm(text: string, known: Set<string>, aliases: Map<string, string>): KeyTerm | null {
  const resolved = aliases.get(text.trim()) ?? text.trim()
  const tokens = meaningful(resolved)

  if (tokens.length === 1 && (tokens[0]!.kind === 'name' || tokens[0]!.kind === 'quoted')) {
    const column = unquote(tokens[0]!.text)
    return known.has(column) ? { column, bucket: null, expr: quoteIdent(column) } : null
  }
  // `fn ( column )` and nothing else: four tokens exactly, so a nested call or
  // a second argument falls through to null rather than being half-read.
  if (
    tokens.length === 4 &&
    tokens[0]!.kind === 'function' &&
    BUCKET_SET.has(tokens[0]!.text) &&
    tokens[1]!.text === '(' &&
    (tokens[2]!.kind === 'name' || tokens[2]!.kind === 'quoted') &&
    tokens[3]!.text === ')'
  ) {
    const column = unquote(tokens[2]!.text)
    const bucket = tokens[0]!.text
    return known.has(column)
      ? { column, bucket, expr: `${bucket}(${quoteIdent(column)})` }
      : null
  }
  return null
}

/** Whether an expression is an aggregate call at its top level. */
function aggregateExpr(expr: string): boolean {
  const tokens = meaningful(expr)
  const head = tokens[0]
  if (!head || head.kind !== 'function') return false
  return isAggregate(head.text)
}

/** Read one query shape, or say why it could not be read. */
export function read(statement: string, table: string, columns: readonly AdviceColumn[]): Reading {
  const known = new Set(columns.map((c) => c.name))
  const shape: Shape = shapeOf(statement)

  if (!shape.isSelect) return { access: null, refused: 'not-a-select' }
  if (shape.compound) return { access: null, refused: 'compound' }
  const ref = fromRef(shape)
  if (!ref) return { access: null, refused: 'joins' }
  // The log said this statement touched the table; the FROM has to agree, or
  // what it reads is a view over it and the columns in the statement are the
  // view's, not this table's.
  if (unquote(ref.table) !== table) return { access: null, refused: 'not-this-table' }

  const items = selectItems(shape) ?? []
  const star = items.some((item) => item.expr.trim() === '*' || item.expr.trim().endsWith('.*'))

  // An alias may stand in for its expression anywhere below it — `toStartOfHour(ts) AS h
  // … GROUP BY h` is the commonest grouping there is.
  const aliases = new Map<string, string>()
  for (const item of items) {
    if (item.alias) aliases.set(item.alias, item.expr)
  }

  const aggregates: string[] = []
  for (const item of items) {
    if (aggregateExpr(item.expr) && !aggregates.includes(item.expr)) aggregates.push(item.expr)
  }

  const equalities: Filter[] = []
  const ranges: Filter[] = []
  const terms: Piece[] = [...whereTerms(shape, 'where'), ...whereTerms(shape, 'prewhere')]
  for (const term of terms) {
    // Two columns in one conjunct is `a = b`, which no physical order serves —
    // and it is the one filter shape this refuses outright rather than
    // ignoring, because a proposal built from the rest of such a WHERE would
    // be built from half of it.
    if (columnRefs(term.text, known, aliases).length > 1) {
      return { access: null, refused: 'opaque-filter' }
    }
    const kind = comparison(term.text)
    if (kind === null) continue
    const at = operatorAt(term.text)
    if (at === null) continue
    // What is being compared, read as a key term. `length(device_id) = 8` and
    // `now() - 1` both come back null: neither is something a key on
    // `device_id` would help with, and a filter a key cannot serve is not a
    // reason to build one.
    const subject = keyTerm(term.text.slice(0, at), known, aliases)
    if (!subject) continue
    const filter: Filter = {
      column: subject.column,
      bucket: subject.bucket,
      expr: subject.expr,
      kind,
    }
    if (kind === 'equality') equalities.push(filter)
    else ranges.push(filter)
  }

  let group: KeyTerm[] | null = null
  const grouping = groupTerms(shape)
  if (grouping.terms.length > 0) {
    const resolved: KeyTerm[] = []
    for (const term of grouping.terms) {
      const key = keyTerm(term.text, known, aliases)
      if (!key) return { access: null, refused: 'opaque-grouping' }
      resolved.push(key)
    }
    group = resolved
  }

  // Everything the statement names, from every clause — this is what a
  // sort-order projection has to hold for the server to be able to choose it.
  const touched = new Set<string>()
  for (const clause of ['select', 'where', 'prewhere', 'groupBy', 'having', 'orderBy'] as const) {
    for (const name of columnRefs(bodyOf(shape, clause), known, aliases)) touched.add(name)
  }
  if (touched.size === 0 && !star) return { access: null, refused: 'no-columns' }

  return {
    access: { equalities, ranges, group, aggregates, columns: [...touched], star },
    refused: null,
  }
}

/* -- What the current key already serves -------------------------------- */

/** Whether the sorting key already answers this access.
 *
 *  ClickHouse skips granules on a *prefix* of the sorting key, and only a
 *  prefix: a table ordered by `(project_id, time)` skips nothing for a filter
 *  on `time` alone. So the test is whether the first key column is filtered,
 *  which is the whole of what makes the difference between reading a table and
 *  reading a corner of it. */
export function servedByKey(access: Access, sortingKey: readonly string[]): boolean {
  const first = sortingKey[0]
  if (!first) return false
  return (
    access.equalities.some((f) => f.column === first) || access.ranges.some((f) => f.column === first)
  )
}

/* -- Candidates ---------------------------------------------------------- */

export type CandidateKind = 'aggregate' | 'sort'

export interface Candidate {
  kind: CandidateKind
  /** Stable across renders and across a refetch, so a measurement stays
   *  attached to the proposal it was run for. */
  id: string
  key: KeyTerm[]
  /** For an aggregate candidate, the expressions it would store. */
  aggregates: string[]
  /** For a sort candidate, the columns it would hold. */
  columns: string[]
  /** The shapes this candidate came from, heaviest first. */
  patterns: Pattern[]
  /** Runs behind those shapes, which is the evidence this proposal rests on. */
  runs: number
  /** Keys of other proposals that would serve this one too, because their key
   *  is a superset of it and they store what it stores.
   *
   *  Named rather than merged. Folding every subset into its superset produces
   *  one projection keyed on everything, which is a copy of the table — and
   *  choosing *which* of two overlapping proposals to keep depends on what
   *  each one measures out at, which is the reader's call and not this file's. */
  alsoServedBy: string[]
  /** True when the evidence is too thin to argue from on its own. Not hidden —
   *  the UI folds these and says how many, because a proposal from one run of
   *  one query on a Tuesday is a permanent cost argued from an anecdote. */
  thin: boolean
  /** Everything true of this candidate that the reader has to weigh, in
   *  sentences. A caveat is not a warning label — several of these are the
   *  reason a proposal is *good*. */
  caveats: string[]
  /** An existing projection that already covers it, when one does. */
  coveredBy: string | null
  /** Runs in the window the log says were already answered by a projection. */
  alreadyServed: number
}

/** The proposed name, from the key. Deterministic, so re-opening the page
 *  proposes the same statement and a second press cannot create a second
 *  projection under a different name. */
export function projectionName(kind: CandidateKind, key: readonly KeyTerm[], taken: readonly string[]): string {
  const stem = key
    .map((k) => (k.bucket ? `${bucketWord(k.bucket)}_${k.column}` : k.column))
    .join('_')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48)
  const base = `${kind === 'aggregate' ? 'agg' : 'by'}_${stem || 'key'}`
  if (!taken.includes(base)) return base
  for (let n = 2; n < 100; n += 1) {
    if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`
  }
  return `${base}_${Date.now()}`
}

function bucketWord(bucket: string): string {
  return bucket.replace(/^toStartOf/, '').replace(/^to/, '').toLowerCase()
}

/** The union of two aggregate lists, order preserved. */
function merge(into: string[], from: readonly string[]): void {
  for (const expr of from) if (!into.includes(expr)) into.push(expr)
}

/** Cost of a pattern in the window, as the log measured it. Milliseconds
 *  actually spent, which is the only ranking that is not an opinion. */
export function spent(pattern: Pattern): number {
  return pattern.total_ms
}

/** The proposals, ranked by the time the workload actually spends on the
 *  patterns each one would serve.
 *
 *  Two kinds, and a pattern can produce both: a `GROUP BY` with a filter on a
 *  column the grouping does not hold is served by an aggregate projection only
 *  if the filter column joins the key — which may make the key nearly unique,
 *  which the measurement will then say. Offering both and letting the numbers
 *  decide beats picking one here on a rule of thumb. */
export function candidates(advice: Advice): Candidate[] {
  const readings = new Map<string, Reading>()
  for (const pattern of advice.workload.items) {
    readings.set(pattern.hash, read(pattern.statement, advice.table, advice.columns))
  }

  const byId = new Map<string, Candidate>()

  const add = (
    kind: CandidateKind,
    key: KeyTerm[],
    pattern: Pattern,
    parts: { aggregates?: readonly string[]; columns?: readonly string[]; caveats?: readonly string[] },
  ) => {
    const id = `${kind}:${key.map((k) => k.expr).join(',')}`
    const found = byId.get(id)
    const candidate: Candidate =
      found ??
      ({
        kind,
        id,
        key,
        aggregates: [],
        columns: [],
        patterns: [],
        runs: 0,
        alsoServedBy: [],
        thin: false,
        caveats: [],
        coveredBy: null,
        alreadyServed: 0,
      } satisfies Candidate)
    merge(candidate.aggregates, parts.aggregates ?? [])
    merge(candidate.columns, parts.columns ?? [])
    merge(candidate.caveats, parts.caveats ?? [])
    candidate.patterns.push(pattern)
    candidate.runs += pattern.runs
    if (pattern.projections.length > 0) candidate.alreadyServed += pattern.runs
    if (!found) byId.set(id, candidate)
  }

  for (const pattern of advice.workload.items) {
    const { access } = readings.get(pattern.hash)!
    if (!access) continue
    // More than one table in the statement is already refused by the reader;
    // this catches the case where the log names a view alongside the table.
    if (pattern.tables.length > 1) continue

    const filtered = [...access.equalities, ...access.ranges]

    /* An aggregate projection: only where there is a grouping and something to
       aggregate, and only where every filter can live in the key. A filter on a
       column the projection does not key by cannot be applied to it at all —
       the rows it would need have already been folded together. */
    if (access.group && access.group.length > 0 && access.aggregates.length > 0) {
      const key = [...access.group]
      const caveats: string[] = []
      for (const filter of filtered) {
        const held = key.find((k) => k.column === filter.column)
        if (!held) {
          // Adding it is what makes the projection able to answer, and it is
          // also what may make the projection as large as the table. The
          // measurement is what settles that, not this file. The filter's own
          // expression goes in, bucket and all: a key holding the raw column
          // would not be reached by a filter on a bucket of it either.
          key.push({ column: filter.column, bucket: filter.bucket, expr: filter.expr })
          continue
        }
        // Only when the filter goes through a *different* expression than the
        // key holds. A filter on the bucket reaches a key on the bucket — 620
        // rows, measured — and saying otherwise would be a warning about
        // nothing on the commonest correct case there is.
        if (held.expr !== filter.expr) {
          // Measured: a projection keyed on `toStartOfHour(time)` is not chosen
          // for `WHERE time > …` — 2,363,170 rows read against 620 when the
          // filter names the bucket instead. The projection is right; the query
          // has to say `WHERE toStartOfHour(time) > …` to reach it.
          caveats.push(
            `This pattern filters on ${filter.expr}, and the key holds ${held.expr}. ` +
              'ClickHouse will not use the projection until the filter names the same ' +
              'expression — measured, that is the difference between reading 620 rows and 2.4 ' +
              'million.',
          )
        }
      }
      // Sorted, so `GROUP BY project_id … WHERE type = ?` and `GROUP BY type
      // … WHERE project_id = ?` are recognised as the one projection they are.
      // The order of an aggregate key decides which prefix filters can reach it,
      // and no order serves every shape in the group — so it is made stable
      // rather than argued over, and the reader can reorder the DDL.
      key.sort((a, b) => a.expr.localeCompare(b.expr))
      add('aggregate', key, pattern, { aggregates: access.aggregates, caveats })
    }

    /* A sort-order projection: only where an equality filter is not served by
       the first column of the sorting key. That is exactly the case the primary
       index cannot help with, and the only one where a second physical order
       earns its disk. */
    if (access.equalities.length > 0 && !servedByKey(access, advice.sorting_key)) {
      // Equalities first, then ranges: a range narrows what a prefix of
      // equalities has already found, and the other order narrows nothing.
      const key: KeyTerm[] = []
      for (const filter of [...access.equalities, ...access.ranges]) {
        if (key.some((k) => k.column === filter.column)) continue
        key.push({ column: filter.column, bucket: filter.bucket, expr: filter.expr })
      }
      const caveats: string[] = []
      if (access.star) {
        caveats.push(
          'This pattern selects every column, so the projection has to hold every column — a ' +
            'second full copy of the table on disk. Naming the columns the query needs is what ' +
            'makes the difference between that and a few per cent.',
        )
      }
      const columns = access.star ? advice.columns.map((c) => c.name) : access.columns
      add('sort', key, pattern, { columns, caveats })
    }
  }

  const out = [...byId.values()]
  const total = out.reduce((n, c) => n + weight(c), 0)
  for (const candidate of out) {
    candidate.patterns.sort((a, b) => spent(b) - spent(a))
    candidate.coveredBy = coveringProjection(candidate, advice.existing)
    // The columns a projection holds have no order; the key does, and the DDL
    // has to be stable across renders.
    candidate.columns.sort()
    candidate.thin = isThin(candidate, total)
    if (candidate.aggregates.length > MANY_AGGREGATES) {
      candidate.caveats.push(
        `This would store ${candidate.aggregates.length} different aggregates, because that many ` +
          'shapes group this way. Each one costs width in every row of the projection — if some ' +
          'of those shapes were one-offs, cut them out of the SELECT before running it.',
      )
    }
    if (candidate.runs <= THIN_RUNS) {
      candidate.caveats.push(
        `${candidate.runs === 1 ? 'One run' : `${candidate.runs} runs`} in the window. A ` +
          'projection is written on every insert and merged on every merge, for as long as the ' +
          'table exists — that is a permanent cost to argue from an afternoon.',
      )
    }
  }

  // Which proposals another proposal would also serve. Measured: a projection
  // keyed (project_id, type) answered `GROUP BY project_id` from 750 rows
  // rather than 5,000,000, so a superset key genuinely covers a subset one.
  for (const candidate of out) {
    if (candidate.kind !== 'aggregate') continue
    for (const other of out) {
      if (other === candidate || other.kind !== 'aggregate') continue
      const covers =
        other.key.length > candidate.key.length &&
        candidate.key.every((term) => other.key.some((t) => t.expr === term.expr)) &&
        candidate.aggregates.every((expr) => other.aggregates.includes(expr))
      if (covers) candidate.alsoServedBy.push(other.key.map((k) => k.expr).join(', '))
    }
  }

  return out.sort((a, b) => weight(b) - weight(a))
}

/** Above this many aggregates a proposal is folding in shapes that probably do
 *  not belong together, and says so. */
const MANY_AGGREGATES = 4

/** At or below this many runs, one query is not a workload. */
const THIN_RUNS = 2

/** Share of the window's time below which a proposal is not worth leading with.
 *  A percent of a busy table is still a real cost; the fold is about ordering
 *  the reader's attention, not about hiding anything. */
const THIN_SHARE = 0.05

function isThin(candidate: Candidate, total: number): boolean {
  if (candidate.runs <= THIN_RUNS) return true
  return total > 0 && weight(candidate) / total < THIN_SHARE
}

/** How much of the workload's time this candidate is about. */
export function weight(candidate: Candidate): number {
  return candidate.patterns.reduce((total, p) => total + spent(p), 0)
}

/** The patterns Flint could not read, with the reason — carried beside the
 *  proposals rather than dropped, so a short list of advice over a long list of
 *  queries never reads as "there is nothing else to say". */
export function unreadable(advice: Advice): { pattern: Pattern; why: string }[] {
  const out: { pattern: Pattern; why: string }[] = []
  for (const pattern of advice.workload.items) {
    const { refused } = read(pattern.statement, advice.table, advice.columns)
    if (refused) out.push({ pattern, why: UNREADABLE[refused] })
  }
  return out.sort((a, b) => spent(b.pattern) - spent(a.pattern))
}

/* -- What already covers it ---------------------------------------------- */

/** The aggregate expressions an existing projection's SELECT stores. */
function storedAggregates(query: string): string[] {
  // A projection's query has no FROM, which `shapeOf` handles: it is still a
  // select list, and that is all this needs.
  const items = selectItems(shapeOf(query)) ?? []
  return items.filter((item) => aggregateExpr(item.expr)).map((item) => item.expr)
}

/** The plain columns an existing projection's SELECT holds, or null for
 *  `SELECT *`, which holds all of them. */
function storedColumns(query: string): string[] | null {
  const items = selectItems(shapeOf(query)) ?? []
  if (items.some((item) => item.expr.trim() === '*')) return null
  return items.map((item) => unquote(item.expr.trim()))
}

/** An existing projection that already answers this candidate, by name.
 *
 *  Deliberately strict. Claiming a projection covers a pattern when it does not
 *  is the one failure here that costs somebody a real regression: they would
 *  read "already covered", change nothing, and keep paying for the scan. So a
 *  covering projection has to hold a superset of the key *and* a superset of
 *  what the candidate would store — measured, a superset key does serve a
 *  subset grouping, and a missing aggregate does not. */
export function coveringProjection(candidate: Candidate, existing: readonly Existing[]): string | null {
  for (const projection of existing) {
    if (projection.inert) continue
    const keys = projection.sorting_key.map((k) => k.trim())
    if (candidate.kind === 'aggregate') {
      if (projection.kind !== 'Aggregate') continue
      // Measured: a projection keyed `(project_id, type)` answers `GROUP BY
      // project_id` — 750 rows, not 5,000,000. A superset key is enough.
      const holdsKey = candidate.key.every((term) => keys.includes(term.expr.replace(/`/g, '')))
      if (!holdsKey) continue
      const stored = storedAggregates(projection.query).map(normalise)
      if (candidate.aggregates.map(normalise).every((expr) => stored.includes(expr))) {
        return projection.name
      }
      continue
    }
    if (projection.kind !== 'Normal') continue
    // A sort order is only useful from its front, so the candidate's key has to
    // be a prefix of the projection's.
    const prefix = candidate.key.every(
      (term, i) => keys[i] === term.expr.replace(/`/g, ''),
    )
    if (!prefix) continue
    const held = storedColumns(projection.query)
    if (held === null || candidate.columns.every((c) => held.includes(c))) return projection.name
  }
  return null
}

/** Whitespace out of an expression, so `sum( value )` and `sum(value)` are the
 *  same aggregate — which they are to ClickHouse, and the comparison above is
 *  about what the server will match. */
function normalise(expr: string): string {
  return meaningful(expr)
    .map((t) => t.text)
    .join('')
}

/* -- The statements ------------------------------------------------------ */

export interface Ddl {
  name: string
  /** The SELECT inside the parentheses — what `ALTER … ADD PROJECTION` takes,
   *  and what the API's `add-projection` change carries. */
  query: string
  /** The full statement, for reading and for copying. */
  declare: string
  /** The mutation that builds it over the rows already there. Separate because
   *  it *is* separate: measured, `ADD PROJECTION` leaves zero parts behind and
   *  reports success, so a table can carry a projection that answers nothing,
   *  indefinitely, with no error anywhere. */
  materialize: string
}

export function ddlFor(candidate: Candidate, database: string, table: string, taken: readonly string[]): Ddl {
  const name = projectionName(candidate.kind, candidate.key, taken)
  const keys = candidate.key.map((k) => k.expr).join(', ')
  const query =
    candidate.kind === 'aggregate'
      ? `SELECT ${keys}, ${candidate.aggregates.join(', ')} GROUP BY ${keys}`
      : `SELECT ${candidate.columns.map(quoteIdent).join(', ')} ORDER BY ${keys}`
  const target = `${quoteIdent(database)}.${quoteIdent(table)}`
  return {
    name,
    query,
    declare: `ALTER TABLE ${target}\n  ADD PROJECTION ${quoteIdent(name)} (${query})`,
    materialize: `ALTER TABLE ${target}\n  MATERIALIZE PROJECTION ${quoteIdent(name)}`,
  }
}

/* -- The arithmetic ------------------------------------------------------ */

export interface Benefit {
  /** Rows this pattern reads per run today, from the log. */
  readsNow: number
  /** Rows it would read with the projection — a floor, not a promise. */
  readsThen: number
  /** `readsNow / readsThen`, or null when there is nothing to divide. */
  factor: number | null
  /** The sentence explaining where `readsThen` comes from. */
  basis: string
}

/** Rows a pattern reads in one run, averaged over the window. */
export function rowsPerRun(patterns: readonly Pattern[]): number {
  const runs = patterns.reduce((n, p) => n + p.runs, 0)
  if (runs === 0) return 0
  return Math.round(patterns.reduce((n, p) => n + p.read_rows, 0) / runs)
}

/** What the projection would reduce this candidate's reads to.
 *
 *  Both branches are floors and both were checked against a real server.
 *
 *  A **sort-order** projection cannot read less than one granule per part,
 *  because ClickHouse reads whole granules: measured, a filter matching 250
 *  rows read 40,960 — five parts times a granularity of 8,192 — and not 250. So
 *  the floor is `parts × index_granularity`, raised to the matching rows when
 *  those are more.
 *
 *  An **aggregate** projection holds one row per group per part until the parts
 *  merge, and one per group after: measured, three groups over five parts came
 *  out at 15 rows, and 150 groups at 750. `groups × parts` is therefore the
 *  ceiling on what the query reads, and it is a ceiling that falls as the table
 *  merges. */
export function benefit(candidate: Candidate, measurement: Measurement | null): Benefit | null {
  const readsNow = rowsPerRun(candidate.patterns)
  if (!measurement) return null
  const parts = Math.max(measurement.parts, 1)

  if (candidate.kind === 'aggregate') {
    const readsThen = Math.max(measurement.groups * parts, 1)
    return {
      readsNow,
      readsThen,
      factor: readsThen > 0 && readsNow > 0 ? readsNow / readsThen : null,
      basis:
        `${exact(measurement.groups)} distinct ${measurement.groups === 1 ? 'value' : 'values'} of ` +
        `the key${measurement.groups_exact ? '' : ', about'} — one projection row each, per part. ` +
        `With ${parts} active ${parts === 1 ? 'part' : 'parts'} that is at most ` +
        `${exact(readsThen)} rows to read, falling towards ${exact(measurement.groups)} as the ` +
        `parts merge.`,
    }
  }

  const granuleFloor = parts * measurement.index_granularity
  const matching = measurement.max_rows_per_key ?? null
  const rounded = matching === null ? 0 : roundUp(matching, measurement.index_granularity)
  const readsThen = matching === null ? granuleFloor : Math.max(granuleFloor, rounded)
  // Two bounds, and the sentence has to explain the one that actually won —
  // printing "the floor is 32,768" beside a figure of 98,304 reads as an
  // arithmetic error in Flint, which is how this wording was found.
  const basis =
    matching === null
      ? `ClickHouse reads whole granules and every part contributes at least one, so ` +
        `${parts} × ${exact(measurement.index_granularity)} = ${exact(granuleFloor)} rows is the ` +
        `floor whatever the filter matches.`
      : rounded >= granuleFloor
        ? `The most common key value has ${exact(matching)} rows behind it, and ClickHouse reads ` +
          `whole granules — so those rows cost ${exact(rounded)}. That is above the ` +
          `${exact(granuleFloor)} rows one granule per part imposes ` +
          `(${parts} × ${exact(measurement.index_granularity)}), so what decides this one is how ` +
          `the values are spread and not the granularity.`
        : `The most common key value has only ${exact(matching)} rows behind it, but ClickHouse ` +
          `reads whole granules and every part contributes at least one — so ` +
          `${parts} × ${exact(measurement.index_granularity)} = ${exact(granuleFloor)} rows is the ` +
          `floor, however few rows actually match.`
  return {
    readsNow,
    readsThen,
    factor: readsThen > 0 && readsNow > 0 ? readsNow / readsThen : null,
    basis,
  }
}

function roundUp(value: number, to: number): number {
  return to > 0 ? Math.ceil(value / to) * to : value
}

/** What the projection costs on disk, in words — measured where it can be and
 *  absent where it cannot.
 *
 *  A sort-order projection is a second copy of the columns it holds, so what
 *  those columns cost today is the figure: measured at 1.7 MB against a 22 MB
 *  table for a two-column projection, and 22.5 MB for the same key with
 *  `SELECT *`.
 *
 *  A pre-aggregated one has no such shortcut: its size is the width of the
 *  aggregate *states*, which nothing can read off a schema. So it has a row
 *  count and no bytes until `weighProjection` has built the thing and weighed
 *  it, and this says which of those two it is looking at rather than filling
 *  the gap with an estimate. */
export function cost(
  candidate: Candidate,
  measurement: Measurement | null,
  tableBytes = 0,
  weighed: Weight | null = null,
): string | null {
  if (!measurement) return null
  if (candidate.kind === 'aggregate') {
    const held =
      `One row per group: ${exact(measurement.groups)}${measurement.groups_exact ? '' : ' or so'} ` +
      `against the table's ${exact(measurement.total_rows)}.`
    if (!weighed) {
      // Not a hedge — a fact about what has been done. The bytes depend on the
      // width of the aggregate states, which nothing can read off a schema, so
      // until they are weighed they are absent rather than guessed.
      return (
        `${held} How many bytes that is depends on the width of the aggregate states, which ` +
        `nothing can tell from the schema — it is weighed, or it is not stated.`
      )
    }
    /* A projection is written per part, so what was weighed — one part's worth
       — is the floor and `× parts` is the ceiling. A range and not a figure,
       because which end a key lands on was measured both ways: a key of three
       values came out at exactly 5 × 399 = 1,995 bytes, because every part
       holds all three; a key of 31 days came out at 2,618 against a ceiling of
       5 × 605 = 3,025, because the parts were written in time order and each
       holds only some of the days. Nothing here can tell which case a key is,
       so both ends are given and neither is called the answer. */
    const parts = Math.max(weighed.parts, 1)
    const ceiling = weighed.on_disk * parts
    const share = weighed.table_bytes > 0 ? ceiling / weighed.table_bytes : null
    const proportion =
      share === null
        ? ''
        : share < 0.005
          ? ', which is under half a per cent of the table either way'
          : `, so at most ${Math.round(share * 1000) / 10}% of what the table holds`
    const spread =
      parts === 1
        ? `Weighed at ${bytes(weighed.on_disk)}${proportion}.`
        : `Weighed at ${bytes(weighed.on_disk)} for one part. A projection is written per part ` +
          `and this table has ${parts}, so it costs between that and ${bytes(ceiling)}` +
          `${proportion} — the ceiling if every part holds every group, less where the key ` +
          `follows the order the parts were written in, and falling towards the floor as they ` +
          `merge.`
    return (
      `${held} ${spread} Built by putting the same grouping and the same aggregate states into a ` +
      `scratch table in Flint's own database, reading its parts and dropping it — the states are ` +
      `what a projection actually holds, and weighing the finalized values would under-report a ` +
      `quantile by an order of magnitude.`
    )
  }
  if (measurement.columns_compressed === null) {
    return (
      "A second copy of those columns in another order. This table's parts are Compact, so what " +
      'they cost today is not measurable here and neither is what the copy will cost.'
    )
  }
  // The share is the decisive figure and the one a byte count alone hides. A
  // projection keyed on a small column can still cost the whole table, because
  // it has to hold every column the queries read — and on the table this was
  // built against that was 21 MiB of a 21 MiB table, entirely because one
  // pattern also selected the timestamp.
  const share = tableBytes > 0 ? measurement.columns_compressed / tableBytes : null
  const proportion =
    share === null
      ? ''
      : ` — ${share >= 0.95 ? 'as much as the whole table' : `${Math.round(share * 100)}% of what the table holds`}`
  return (
    `A second copy of those columns in another order. They hold ` +
    `${bytes(measurement.columns_compressed)} in the table today${proportion}; the copy is sorted ` +
    `differently, so it will compress differently — usually a little better, since the sort ` +
    `puts like values together.`
  )
}

/** The sentence that ships with every proposal, because it is the one thing
 *  about projections that surprises people twice: what it will not answer.
 *
 *  Measured. A projection holding `device_id, value` answered
 *  `SELECT count(), sum(value) … WHERE device_id = ?` from 40,960 rows. The same
 *  query with `max(time)` added read all 5,000,000 — the projection does not
 *  hold `time`, so the server cannot use it, and nothing says so at query
 *  time. */
export function limits(candidate: Candidate): string {
  if (candidate.kind === 'aggregate') {
    return (
      'ClickHouse matches a projection’s aggregates by expression, not by algebra: this one ' +
      `answers ${candidate.aggregates.join(', ')} and nothing else. A query asking for a ` +
      'different aggregate over the same grouping reads the table.'
    )
  }
  return (
    `This projection holds ${candidate.columns.length} of the table’s columns. A query on ` +
    'this table that reads any other one cannot use it and reads the table — with no error and ' +
    'no sign that it happened.'
  )
}

/* -- What the projections already there are doing ------------------------- */

export type StandingIssue = 'inert' | 'unused'

/** Something already on this table that is costing and not earning.
 *
 *  The other half of the advice, and the half a tool like this usually leaves
 *  out. A page that only ever proposes adding is a page that grows somebody's
 *  disk forever: a projection is written on every insert and merged on every
 *  merge whether or not a single query has ever chosen it, and nothing in
 *  ClickHouse raises so much as a warning about one that does nothing. */
export interface Standing {
  name: string
  issue: StandingIssue
  says: string
  /** Why to think before acting. Null where there is nothing to weigh — a
   *  projection that was never built holds nothing, and dropping it loses
   *  nothing. */
  caution: string | null
  /** What it costs today, or null for one that holds nothing. */
  bytes: number | null
  /** The ways out, in the order they should be considered. */
  fixes: { label: string; op: string; explain: string }[]
}

/** Projections on this table that are not earning what they cost.
 *
 *  Two findings, and they rest on different evidence, which is why they are
 *  separate. *Inert* is a fact about the table: zero parts, so every query
 *  ignores it, and the log is not consulted at all. *Unused* is a claim about
 *  the workload, and it is only ever made when the log could actually answer —
 *  `used_by` is null where this server does not record which projection served
 *  a query, and a null must never be drawn as a zero. Dropping something is
 *  what this advice leads to, and "I could not tell" is not evidence for it. */
export function standing(advice: Advice): Standing[] {
  const out: Standing[] = []
  for (const p of advice.existing) {
    if (p.inert) {
      out.push({
        name: p.name,
        issue: 'inert',
        bytes: null,
        says:
          'Declared and never built. It holds nothing, every query ignores it, and no statement ' +
          'anywhere reports a problem — the size is the only tell there is.',
        // Nothing to weigh: it holds nothing, so neither way out loses
        // anything that exists.
        caution: null,
        fixes: [
          {
            label: 'Build it',
            op: 'materialize-projection',
            explain:
              'A mutation: it rewrites every part of the table to add what the declaration did ' +
              'not.',
          },
          {
            label: 'Drop it',
            op: 'drop-projection',
            explain: 'Metadata only. It holds nothing, so nothing is lost.',
          },
        ],
      })
      continue
    }
    // Null is "the log could not say", and it is not evidence of anything.
    if (p.used_by !== 0) continue
    // Neither is a window in which nothing read the table at all. On a server
    // that came up ten minutes ago every projection has been used zero times,
    // and "nothing used it" would be true of the log and false about the
    // world. The claim needs a workload to have been observed before it can be
    // made about one.
    if (advice.workload.items.length === 0) continue
    out.push({
      name: p.name,
      issue: 'unused',
      bytes: p.bytes,
      says:
        `Built and holding ${p.rows.toLocaleString('en')} rows, and nothing in the window chose ` +
        'it. It is still written on every insert and merged on every merge.',
      caution:
        `The window is what the log kept, not what was asked for — a report that runs monthly is ` +
        `invisible in ${advice.window_days} days, and so is a reader whose queries this server ` +
        'does not log. Widen the window before acting on this, and check who else queries this ' +
        'table.',
      fixes: [
        {
          label: 'Drop it',
          op: 'drop-projection',
          explain:
            'Metadata and the bytes it holds. The table\u2019s own rows are untouched — a ' +
            'projection is derived from them and can be declared and built again.',
        },
      ],
    })
  }
  return out
}

/* -- Decomposing an aggregate, so the weigher never sees text ------------- */

/** One aggregate in pieces: the name, its parameters, its column arguments.
 *
 *  The weigher builds a `CREATE TABLE`, and the lesson the type probe already
 *  paid for is that no amount of quoting makes arbitrary text safe there. So
 *  nothing crosses as an expression: this takes the statement's own
 *  `quantile(0.95)(value)` apart, and the backend checks every piece against
 *  its own lists and writes the expression itself. */
export interface AggregateTerm {
  name: string
  params: number[]
  args: string[]
}

/** Take one aggregate expression apart, or answer null.
 *
 *  Null is a perfectly good answer and the commonest one worth having: an
 *  aggregate over an *expression* — `sum(value * 2)`, `countIf(status = 'x')` —
 *  is not something this will send to a statement builder, and the cost figure
 *  is dropped rather than guessed. That is the same rule the rest of this file
 *  keeps about a figure that cannot be had. */
export function decompose(expr: string, known: ReadonlySet<string>): AggregateTerm | null {
  const tokens = meaningful(expr)
  const head = tokens[0]
  if (!head || head.kind !== 'function' || !isAggregate(head.text)) return null

  // `name ( … )` or `name ( … ) ( … )`. Anything else — a call inside a call, a
  // trailing operator — is not this shape and is refused whole.
  const groups: string[][] = []
  let i = 1
  while (i < tokens.length) {
    if (tokens[i]!.text !== '(') return null
    let depth = 0
    const inner: string[] = []
    i += 1
    for (; i < tokens.length; i += 1) {
      const tok = tokens[i]!
      if (tok.text === '(' || tok.text === '[') depth += 1
      else if (tok.text === ')' || tok.text === ']') {
        if (depth === 0) break
        depth -= 1
      }
      inner.push(tok.text)
    }
    if (i >= tokens.length || tokens[i]!.text !== ')') return null
    groups.push(inner)
    i += 1
  }
  if (groups.length === 0 || groups.length > 2) return null

  // Two bracket groups means parameters then arguments; one means arguments
  // alone, which is every aggregate that takes none.
  const [first, second] = groups
  const paramTokens = groups.length === 2 ? first! : []
  const argTokens = groups.length === 2 ? second! : first!

  const params: number[] = []
  for (const piece of splitOnCommas(paramTokens)) {
    if (piece.length !== 1) return null
    const value = Number(piece[0])
    if (!Number.isFinite(value)) return null
    params.push(value)
  }

  const args: string[] = []
  for (const piece of splitOnCommas(argTokens)) {
    if (piece.length !== 1) return null
    const name = unquote(piece[0]!)
    if (!known.has(name)) return null
    args.push(name)
  }

  return { name: head.text, params, args }
}

/** Split a flat token run on top-level commas. The runs here have already had
 *  their brackets stripped by the caller, so a comma is a separator. */
function splitOnCommas(tokens: readonly string[]): string[][] {
  const out: string[][] = []
  let current: string[] = []
  for (const text of tokens) {
    if (text === ',') {
      out.push(current)
      current = []
      continue
    }
    current.push(text)
  }
  if (current.length > 0) out.push(current)
  return out.filter((piece) => piece.length > 0)
}

/** The body of a weigh request, or null when any of this candidate's aggregates
 *  is one the weigher will not build. All or nothing: a size measured over some
 *  of the states is not the size of the projection. */
export function weighRequest(
  candidate: Candidate,
  columns: readonly AdviceColumn[],
): { keys: { column: string; bucket: string | null }[]; aggregates: AggregateTerm[] } | null {
  if (candidate.kind !== 'aggregate') return null
  const known = new Set(columns.map((c) => c.name))
  const aggregates: AggregateTerm[] = []
  for (const expr of candidate.aggregates) {
    const term = decompose(expr, known)
    if (!term) return null
    aggregates.push(term)
  }
  return {
    keys: candidate.key.map((k) => ({ column: k.column, bucket: k.bucket })),
    aggregates,
  }
}

/** The key terms as the measurement endpoint wants them. */
export function measureRequest(candidate: Candidate): {
  keys: { column: string; bucket: string | null }[]
  columns: string[]
} {
  return {
    keys: candidate.key.map((k) => ({ column: k.column, bucket: k.bucket })),
    columns: candidate.kind === 'sort' ? candidate.columns : [],
  }
}

/* -- What the whole workload came to ------------------------------------- */

export interface Tally {
  /** Query shapes the page actually has, which is the costliest few. */
  patterns: number
  /** Runs behind them. */
  runs: number
  /** Shapes and runs there were altogether, when the backend could count them.
   *  Equal to the two above when nothing was left out. */
  patternsTotal: number
  runsTotal: number
  /** True when the list is a truncation of something larger and the page has
   *  to say so. */
  capped: boolean
  /** Shapes this file read all the way through. */
  read: number
  /** Shapes whose filter is already a prefix of the sorting key — the ones the
   *  table was designed for, and the answer "nothing to do here" rests on
   *  counting them rather than on finding nothing. */
  servedByKey: number
  /** Runs the log says a projection already answered. */
  servedByProjection: number
  /** Shapes this file refused, which the page lists rather than hides. */
  refused: number
}

export function tally(advice: Advice): Tally {
  const out: Tally = {
    patterns: advice.workload.items.length,
    patternsTotal: advice.shapes_total ?? advice.workload.items.length,
    runsTotal: advice.runs_total ?? 0,
    capped: (advice.shapes_total ?? 0) > advice.workload.items.length,
    runs: 0,
    read: 0,
    servedByKey: 0,
    servedByProjection: 0,
    refused: 0,
  }
  for (const pattern of advice.workload.items) {
    out.runs += pattern.runs
    if (pattern.projections.length > 0) out.servedByProjection += pattern.runs
    const { access } = read(pattern.statement, advice.table, advice.columns)
    if (!access) {
      out.refused += 1
      continue
    }
    out.read += 1
    if (servedByKey(access, advice.sorting_key)) out.servedByKey += 1
  }
  if (out.runsTotal === 0) out.runsTotal = out.runs
  return out
}

/* -- The same question across a database ---------------------------------- */

/** Rows below which a projection cannot save anything.
 *
 *  ClickHouse reads whole granules, and a table smaller than a handful of them
 *  is read in one gulp whatever its order is — a projection over it would be
 *  read in one gulp too, and would cost disk and insert throughput for nothing.
 *  Eight granules at the default 8,192.
 *
 *  Exported because two readings need the same number and a second copy would
 *  drift: this file's ranking, and the scan-share prompt on the diagnose page.
 *  Both learned it the same way — by offering to help a five-row lookup. */
export const PROJECTION_ROW_FLOOR = 8 * 8192

export type TableVerdict =
  /** Its costliest shape reads the table and no key serves it. */
  | 'candidate'
  /** Its costliest shape filters on the first key column already. */
  | 'served'
  /** A projection already answered it, and the log says so. */
  | 'covered'
  /** Its costliest shape asks for the whole table — no filter, no grouping —
   *  and no physical layout changes that. */
  | 'unserveable'
  /** Small enough that reading it whole costs a handful of granules, so there
   *  is nothing for a projection to save. */
  | 'tiny'
  /** Nothing among its costliest shapes was one this reads. */
  | 'unread'

export interface Ranked {
  standing: TableStanding
  verdict: TableVerdict
  /** What the costliest readable shape suggests, when it suggests anything. */
  kind: CandidateKind | null
  /** Rows read per run against the rows the table holds, or null when there is
   *  nothing to divide by. */
  share: number | null
  /** One sentence, and it is about *the costliest shape* rather than about the
   *  table — this view reads three shapes and the tab reads sixty, and a
   *  sentence that conflated the two would be a verdict drawn from a sample. */
  says: string
}

/** A database's tables, ranked by the time its workload spends on them, with a
 *  reading of the costliest shape on each.
 *
 *  The unit here is deliberate. "Does this table want a projection" cannot be
 *  answered from three shapes, and pretending otherwise would need so much
 *  hedging that the page would say nothing. "What does the costliest shape on
 *  this table do, and does the key serve it" *can* be answered from one shape,
 *  because that shape is a well-defined object — and it is enough to decide
 *  which table to open. Everything past that is the table's own tab. */
export function ranked(report: DatabaseAdvice): Ranked[] {
  return report.tables.map((standing) => {
    const perRun = standing.runs > 0 ? standing.read_rows / standing.runs : 0
    const share = standing.rows > 0 && standing.runs > 0 ? perRun / standing.rows : null

    /* Size first, because it settles the question before the shapes are worth
       reading. A three-row lookup reads all of itself and always will; what its
       queries look like cannot change that, and "nothing to serve" — true as it
       is — buries the fact a reader scanning this list actually needs. */
    if (standing.rows > 0 && standing.rows < PROJECTION_ROW_FLOOR) {
      return {
        standing,
        verdict: 'tiny',
        kind: null,
        share,
        says:
          `${count(standing.rows)} rows is a few granules — ClickHouse reads it in one gulp ` +
          'whatever its order is, and a projection over it would be read in one gulp too.',
      }
    }

    /* Every sample, not the first that parses.
     *
     * Reporting on the first readable shape meant one noisy statement masked
     * the answer: on a table whose costliest shapes were a cross join and a
     * profiling scan, this said "nothing to serve" about a table the per-table
     * advisor finds two proposals on. So all of them are read and the strongest
     * finding wins — a shape that argues for a projection is a more useful
     * thing to say about a table than a shape that does not, and the sentence
     * says which of the shapes it is talking about. */
    let access: Access | null = null
    let spoke: Pattern | null = null
    let served: Pattern | null = null
    let covered: Pattern | null = null
    let refusal: Unreadable | null = null
    let readable = 0
    for (const sample of standing.samples) {
      // A statement touching more than this table is not one a projection on
      // it is read from, however expensive it is.
      if (sample.tables.length > 1) continue
      const reading = readAgainst(sample, standing)
      if (!reading.access) {
        refusal = refusal ?? reading.refused
        continue
      }
      readable += 1
      if (sample.projections.length > 0) {
        covered = covered ?? sample
        continue
      }
      if (servedByKey(reading.access, standing.sorting_key)) {
        served = served ?? sample
        continue
      }
      const hasFilter = reading.access.equalities.length > 0 || reading.access.ranges.length > 0
      const hasGrouping =
        Boolean(reading.access.group?.length) && reading.access.aggregates.length > 0
      if ((hasFilter || hasGrouping) && access === null) {
        access = reading.access
        spoke = sample
      }
    }

    const of = `${readable === 1 ? 'its' : `the ${readable}`} costliest ${
      readable === 1 ? 'shape' : 'shapes'
    } read here`

    if (!access || !spoke) {
      // Nothing argued for a projection. What to say instead depends on what
      // was actually there, and the four answers are genuinely different.
      if (covered) {
        return {
          standing,
          verdict: 'covered',
          kind: null,
          share,
          says: `A projection already answers one of ${of} — ${covered.projections
            .map((p) => p.split('.').pop())
            .join(', ')}.`,
        }
      }
      if (served) {
        return {
          standing,
          verdict: 'served',
          kind: null,
          share,
          says: `Of ${of}, the ones with a filter use ${standing.sorting_key[0]} — which the key already serves.`,
        }
      }
      if (readable > 0) {
        return {
          standing,
          verdict: 'unserveable',
          kind: null,
          share,
          says: `None of ${of} filters or groups — they ask for the whole table, and no second layout answers that.`,
        }
      }
      if (refusal === 'no-columns') {
        return {
          standing,
          verdict: 'unserveable',
          kind: null,
          share,
          says:
            'Its costliest shapes name no column of this table — they ask for the whole thing, ' +
            'and no second layout answers that.',
        }
      }
      return {
        standing,
        verdict: 'unread',
        kind: null,
        share,
        says:
          standing.samples.length === 0
            ? 'Nothing was kept from its workload to read.'
            : `Its ${standing.samples.length === 1 ? 'costliest shape is' : 'costliest shapes are'} ` +
              'a join, a union or something else this does not read well enough to advise from.',
      }
    }

    const grouped = Boolean(access.group && access.group.length > 0 && access.aggregates.length > 0)
    const filtered = [...access.equalities, ...access.ranges].map((f) => f.column)

    const kind: CandidateKind = grouped ? 'aggregate' : 'sort'
    return {
      standing,
      verdict: 'candidate',
      kind,
      share,
      says:
        kind === 'aggregate'
          ? `One of ${of} groups by ${access.group!.map((k) => k.expr).join(', ')} and reads the ` +
            'table to do it.'
          : `One of ${of} filters on ${filtered.join(', ')}, which is not a prefix of ` +
            `${standing.sorting_key.length > 0 ? standing.sorting_key.join(', ') : 'any key'}.`,
    }
  })
}

/** Read one sample against the table it belongs to.
 *
 *  The parser wants the table's columns and this view does not carry them — a
 *  column list per table would be most of a schema over the wire to answer a
 *  question about three statements. So the columns are taken from the statement
 *  itself: every name it mentions that is not a function call. That is looser
 *  than the per-table reader and it is loose in the safe direction — it can
 *  only ever find *more* column references, never attribute one to the wrong
 *  table, because the statement has already been checked to touch this table
 *  and no other. */
function readAgainst(sample: Pattern, standing: TableStanding): Reading {
  const names = new Set<string>()
  for (const tok of meaningful(sample.statement)) {
    if (tok.kind === 'name' || tok.kind === 'quoted') names.add(unquote(tok.text))
  }
  for (const term of standing.sorting_key) names.add(term)
  const columns: AdviceColumn[] = [...names].map((name) => ({
    name,
    type: '',
    sorting_position: standing.sorting_key.indexOf(name) + 1 || null,
    in_partition_key: false,
    compressed_bytes: null,
  }))
  return read(sample.statement, standing.table, columns)
}

/** What the ranking left out, for the sentence that has to say so. */
export function rankTally(report: DatabaseAdvice): {
  listed: number
  read: number
  total: number
  candidates: number
} {
  const list = ranked(report)
  return {
    listed: report.tables.length,
    read: report.tables_read,
    total: report.tables_total,
    candidates: list.filter((r) => r.verdict === 'candidate').length,
  }
}
