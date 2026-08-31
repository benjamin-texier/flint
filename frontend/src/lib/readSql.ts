/** Reading a statement back into the form, as far as it will go.
 *
 *  The switch above the editor used to be a one-way door. A form becomes a
 *  statement on every keystroke, but nothing read the statement back, so any
 *  tab that had ever been SQL — including every tab opened from the explorer,
 *  which is most of them — had its Form button greyed out forever. The reason
 *  given was honest and the door was still locked.
 *
 *  So this reads. Not completely, and it never pretends to: the form can say a
 *  single table, some columns, some aggregates, ANDed filters, a grouping, a
 *  HAVING, an order and a limit, and a statement is allowed to say a great deal
 *  more than that. What falls outside is **dropped and named**, one sentence
 *  per loss, and the caller shows the list. That is the trade the house style
 *  already makes everywhere else — say what was left out — applied to a
 *  translation instead of to a list.
 *
 *  Two things it will not do, because they are not losses but different
 *  questions: a statement that is not a SELECT, and a FROM that is not one
 *  table. Dropping a JOIN would leave a form pointed at half the question,
 *  generating SQL for columns the remaining table does not have; there is no
 *  sentence that makes that a reasonable thing to have done silently.
 *
 *  Nothing here is a SQL parser, and it must not grow into one. It stands on
 *  `lib/rewrite`, which already finds clause boundaries and splits lists at
 *  bracket depth zero, and it reads each piece with a closed set of patterns.
 *  A piece that matches none of them is a `dropped` line, never a guess. */

import {
  bodyOf,
  fromRef,
  groupTerms,
  orderTerms,
  selectItems,
  shapeOf,
  whereTerms,
  type Piece,
  type Shape,
} from './rewrite'
import {
  startingSpec,
  type Agg,
  type Bucket,
  type Condition,
  type Having,
  type Op,
  type Ordering,
  type Projection,
  type QuerySpec,
} from './query'

/** Either a question the form can hold, and everything that did not fit, or
 *  the one sentence saying why there is no form for this at all. */
export type Reading = { spec: QuerySpec; dropped: string[] } | { unread: string }

export interface ReadOptions {
  /** The tab's database, for a statement that names a table and no schema. */
  database?: string
  /** The form this statement came out of, when there was one.
   *
   *  Two things it recovers that the text cannot. The server binds a filter's
   *  value as a query parameter, so a generated statement says
   *  `WHERE city = {p0:String}` and the value lives nowhere in the SQL — but it
   *  is still sitting in the spec that produced it. And the generated LIMIT is
   *  the page plus one, the row that makes "there is more behind this" a fact;
   *  read literally it would walk the limit up by one on every round trip. */
  prior?: QuerySpec | null
}

/* ── The closed vocabulary ────────────────────────────────────────────────
 *
 *  Every function the form can write, and nothing else. Both directions of the
 *  product's own generator are here — `uniq` is what the Builder asks for and
 *  `uniqExact` is what the exact distinct count renders as — because a reader
 *  that only understood its own output would fail on the statement the server
 *  handed back a moment earlier. */

const AGG_CALLS: Record<string, Agg> = {
  count: 'count',
  sum: 'sum',
  avg: 'avg',
  min: 'min',
  max: 'max',
  median: 'median',
  uniq: 'uniq',
  // Read as the estimate, which is what the form has to offer. Named as a loss
  // where it matters: an exact count read back as an approximate one is a
  // different number, and nobody should discover that from the rows.
  uniqexact: 'uniq',
}

const BUCKET_CALLS: Record<string, Bucket> = {
  tostartofminute: 'minute',
  tostartofhour: 'hour',
  tostartofday: 'day',
  tomonday: 'week',
  tostartofmonth: 'month',
}

/** `quantile(0.95)(ms)` — a parametric call, which the ordinary call pattern
 *  below cannot see because its parentheses come in two pairs. */
const QUANTILE = /^quantile(?:exact)?\s*\(\s*(0?\.\d+)\s*\)\s*\((.*)\)$/is

/** The comparison operators, written the several ways ClickHouse accepts. */
const COMPARISONS: Record<string, Op> = {
  '=': '=',
  '==': '=',
  '!=': '!=',
  '<>': '!=',
  '>': '>',
  '>=': '>=',
  '<': '<',
  '<=': '<=',
}

/** A value the server bound rather than wrote: `{p0:String}`. */
const BOUND = /^\{[A-Za-z_]\w*:.+\}$/s

let counter = 0
/** Ids are per-piece and never leave the browser, so a counter is enough — and
 *  a counter keeps this function pure enough to assert on in a test, which
 *  `crypto.randomUUID()` would not. */
function id(): string {
  counter += 1
  return `read-${counter}`
}

export function readSpec(sql: string, options: ReadOptions = {}): Reading {
  const shape = shapeOf(sql)
  if (!shape.isSelect) {
    return { unread: 'The form asks questions, and this statement is not a SELECT.' }
  }
  if (shape.compound) {
    return {
      unread:
        'This statement joins two answers with a set operator, and the form holds one question at a time.',
    }
  }
  if (!shape.clauses.from) {
    return { unread: 'This statement reads from nothing the form could point at.' }
  }
  return readShape(shape, options)
}

function readShape(shape: Shape, options: ReadOptions): Reading {
  const dropped: string[] = []

  const target = fromRef(shape)
  const inner = target ? null : subqueryOf(shape)
  if (!target && !inner) {
    return {
      unread:
        'The form reads one table, and this statement reads something else — a join, a table function, or several tables at once.',
    }
  }

  /* A wrapper is unwrapped rather than refused.
   *
   *  Not a nicety: it is the exact shape of everything the form itself
   *  generates. `SELECT * FROM (SELECT * FROM db.t) LIMIT 501` is what comes
   *  back from the server for the emptiest question there is, and a reader
   *  that could not see through one layer of it would refuse its own output. */
  let base: QuerySpec
  if (inner) {
    const read = readSpec(inner, options)
    if ('unread' in read) return read
    base = read.spec
    dropped.push(...read.dropped)
  } else {
    base = startingSpec(target!.database ?? options.database ?? '', target!.table)
  }

  const spec: QuerySpec = { ...base }

  for (const [clause, said] of UNREADABLE_CLAUSES) {
    if (shape.clauses[clause]) dropped.push(said)
  }

  const projections = readProjections(shape, dropped)
  // `SELECT *` selects everything, which is what an empty projection list means
  // to the form — so an outer `*` keeps whatever the inner statement chose
  // rather than blanking it.
  if (projections !== null) spec.projections = projections

  const conditions = [
    ...readConditions(shape, 'prewhere', dropped, options.prior),
    ...readConditions(shape, 'where', dropped, options.prior),
  ]
  if (conditions.length) spec.conditions = [...spec.conditions, ...conditions]

  const having = readHaving(shape, dropped, options.prior)
  if (having.length) spec.having = having

  const orderings = readOrderings(shape, dropped)
  if (orderings.length) spec.orderings = orderings

  const limit = readLimit(shape, dropped, options.prior)
  if (limit !== null) spec.limit = limit

  checkGrouping(shape, spec, dropped)

  return { spec, dropped }
}

/** Clauses with no counterpart in the form at all. Each one is a whole sentence
 *  because each one is a whole idea the question is about to stop containing. */
const UNREADABLE_CLAUSES: [keyof Shape['clauses'], string][] = [
  [
    'with',
    'The WITH at the top defines names the form has no place for — it is gone, and any clause that used it went with it.',
  ],
  [
    'settings',
    'The SETTINGS clause is dropped: the form sends a question, and the settings a statement carries are not part of one.',
  ],
  ['format', 'The FORMAT clause is dropped — the form always reads rows back as rows.'],
]

/** The FROM body when it is one parenthesised statement and nothing else, so
 *  that a wrapper can be read through. An alias after it is ignored; anything
 *  else after it means this is not a lone subquery and the caller refuses. */
function subqueryOf(shape: Shape): string | null {
  const body = bodyOf(shape, 'from')
  if (!body.startsWith('(')) return null
  let depth = 0
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) {
        const tail = body.slice(i + 1).trim()
        // `(…) AS t` or `(…) t` is still one subquery; `(…) JOIN …` is not.
        if (tail && !/^(AS\s+)?[A-Za-z_]\w*$/i.test(tail)) return null
        return body.slice(1, i)
      }
    }
  }
  return null
}

/* ── The select list ─────────────────────────────────────────────────────── */

/** The projections, or null for a select list that asks for everything — which
 *  is the form's empty list, not a form with nothing in it. */
function readProjections(shape: Shape, dropped: string[]): Projection[] | null {
  const items = selectItems(shape)
  if (!items) return null
  if (/^\s*DISTINCT\b/i.test(bodyOf(shape, 'select'))) {
    dropped.push('DISTINCT is dropped — the form has no way to ask for unique rows.')
  }

  const out: Projection[] = []
  let star = false
  for (const item of items) {
    const expr = item.expr.trim()
    if (expr === '*' || /^[A-Za-z_]\w*\.\*$/.test(expr)) {
      star = true
      continue
    }
    const projection = readProjection(expr, dropped)
    if (projection) out.push(projection)
  }

  if (star && out.length) {
    dropped.push(
      'The `*` alongside the named columns is dropped: the form selects the columns it lists, or everything, not both.',
    )
  }
  if (!out.length) return null
  return out
}

function readProjection(expr: string, dropped: string[]): Projection | null {
  const column = columnOf(expr)
  if (column) return { id: id(), column, agg: null, bucket: null }

  const quantile = QUANTILE.exec(expr)
  if (quantile) {
    const agg = quantile[1] === '0.95' || quantile[1] === '.95' ? 'p95' : quantile[1] === '0.99' || quantile[1] === '.99' ? 'p99' : null
    const inner = columnOf(quantile[2]!.trim())
    if (agg && inner) return { id: id(), column: inner, agg, bucket: null }
    dropped.push(`\`${expr}\` is a percentile the form does not offer — that column is gone.`)
    return null
  }

  const call = callOf(expr)
  if (call) {
    const name = call.name.toLowerCase()
    const agg = AGG_CALLS[name]
    if (agg) {
      const arg = call.args.trim()
      // `count()` and `count(*)` are the same question: how many rows.
      if (agg === 'count' && (arg === '' || arg === '*')) {
        return { id: id(), column: '*', agg, bucket: null }
      }
      const inner = columnOf(arg)
      if (inner) {
        if (name === 'uniqexact') {
          dropped.push(
            `\`${expr}\` counted distinct values exactly; the form only offers the estimate, so this column is now approximate.`,
          )
        }
        return { id: id(), column: inner, agg, bucket: null }
      }
    }
    const bucket = BUCKET_CALLS[name]
    if (bucket) {
      const inner = columnOf(call.args.trim())
      if (inner) return { id: id(), column: inner, agg: null, bucket }
    }
  }

  dropped.push(`\`${expr}\` is not something the form can say — that column is gone.`)
  return null
}

/* ── Filters ─────────────────────────────────────────────────────────────── */

function readConditions(
  shape: Shape,
  clause: 'where' | 'prewhere',
  dropped: string[],
  prior: QuerySpec | null | undefined,
): Condition[] {
  const terms = rejoinBetweens(whereTerms(shape, clause))
  if (terms.length && clause === 'prewhere') {
    dropped.push(
      'The PREWHERE is read as an ordinary filter. It means the same rows; ClickHouse decides for itself when to read it early.',
    )
  }
  const out: Condition[] = []
  for (const term of terms) {
    const condition = readCondition(term.text, dropped, prior)
    if (condition) out.push(condition)
  }
  return out
}

/** `whereTerms` splits on every AND at depth zero, and `BETWEEN a AND b` has
 *  one of those in the middle of it. Put those two halves back together. */
function rejoinBetweens(terms: Piece[]): Piece[] {
  const out: Piece[] = []
  for (const term of terms) {
    const open = out[out.length - 1]
    if (open && /\bBETWEEN\b/i.test(open.text) && !/\bBETWEEN\b.+\bAND\b/is.test(open.text)) {
      out[out.length - 1] = {
        text: `${open.text} AND ${term.text}`,
        start: open.start,
        end: term.end,
      }
      continue
    }
    out.push(term)
  }
  return out
}

const IS_NULL = /^(.+?)\s+IS\s+(NOT\s+)?NULL$/is
const LIKE = /^(.+?)\s+(NOT\s+)?LIKE\s+(.+)$/is
const IN = /^(.+?)\s+(NOT\s+)?IN\s*\((.*)\)$/is
const BETWEEN = /^(.+?)\s+BETWEEN\s+(.+?)\s+AND\s+(.+)$/is
const SINCE = /^(.+?)\s*>=\s*now\(\)\s*-\s*INTERVAL\s+(\d+)\s+(MINUTE|HOUR|DAY)S?$/is
const COMPARE = /^(.+?)\s*(==|!=|<>|>=|<=|=|>|<)\s*(.+)$/s

const WINDOW_UNIT: Record<string, string> = { MINUTE: 'm', HOUR: 'h', DAY: 'd' }

/** A filter whose value the server bound rather than wrote.
 *
 *  `WHERE city = {p0:String}` is the whole truth the statement carries: the
 *  value is a parameter and never reaches the text. The form that generated it
 *  still holds the value, so that is where this looks — and where there is no
 *  such form, the filter is a loss with a name rather than a filter with an
 *  empty box, which would run as a different question. */
function bound(
  column: string,
  op: Op,
  dropped: string[],
  prior: QuerySpec | null | undefined,
): Condition | null {
  const remembered = prior?.conditions.find((c) => c.column === column && c.op === op)
  if (remembered) return { ...remembered, id: id() }
  dropped.push(
    `The filter on \`${column}\` compares against a value the server bound rather than wrote, and a bound value is not in the statement to read — the filter is gone.`,
  )
  return null
}

function readCondition(
  text: string,
  dropped: string[],
  prior: QuerySpec | null | undefined,
): Condition | null {
  const blank = { id: id(), value: '', value2: '' }

  const nulls = IS_NULL.exec(text)
  if (nulls) {
    const column = columnOf(nulls[1]!.trim())
    if (column) return { ...blank, column, op: nulls[2] ? 'isNotNull' : 'isNull' }
  }

  const since = SINCE.exec(text)
  if (since) {
    const column = columnOf(since[1]!.trim())
    const unit = WINDOW_UNIT[since[3]!.toUpperCase()]
    if (column && unit) return { ...blank, column, op: 'since', value: `${since[2]}${unit}` }
  }

  const like = LIKE.exec(text)
  if (like) {
    const column = columnOf(like[1]!.trim())
    const op: Op = like[2] ? 'notLike' : 'like'
    const written = like[3]!.trim()
    if (column && isBound(written)) return bound(column, op, dropped, prior)
    const value = valueOf(written)
    if (column && value !== null) {
      // The form's "contains" wraps the value in wildcards on the way out, so a
      // pattern that is exactly that comes back as the word it was written from.
      const bare = /^%(.*)%$/s.exec(value)
      return { ...blank, column, op, value: bare && !bare[1]!.includes('%') ? bare[1]! : value }
    }
  }

  const list = IN.exec(text)
  if (list) {
    const column = columnOf(list[1]!.trim())
    const op: Op = list[2] ? 'notIn' : 'in'
    const written = splitList(list[3]!)
    const values = written.map((v) => valueOf(v))
    if (column && values.length && values.every((v) => v !== null)) {
      return { ...blank, column, op, value: values.join(', ') }
    }
    if (column && written.some(isBound)) return bound(column, op, dropped, prior)
  }

  const range = BETWEEN.exec(text)
  if (range) {
    const column = columnOf(range[1]!.trim())
    const low = valueOf(range[2]!.trim())
    const high = valueOf(range[3]!.trim())
    if (column && low !== null && high !== null) {
      return { ...blank, column, op: 'between', value: low, value2: high }
    }
    if (column && (isBound(range[2]!) || isBound(range[3]!))) {
      return bound(column, 'between', dropped, prior)
    }
  }

  const compare = COMPARE.exec(text)
  if (compare) {
    const column = columnOf(compare[1]!.trim())
    const op = COMPARISONS[compare[2]!]
    const written = compare[3]!.trim()
    if (column && op) {
      const value = valueOf(written)
      if (value !== null) return { ...blank, column, op, value }
      if (isBound(written)) return bound(column, op, dropped, prior)
    }
  }

  dropped.push(`The filter \`${oneLine(text)}\` is not a comparison the form can hold — it is gone.`)
  return null
}

/* ── HAVING, ORDER BY, LIMIT, GROUP BY ───────────────────────────────────── */

const HAVING_OPS = new Set(['=', '!=', '>', '>=', '<', '<='])

function readHaving(shape: Shape, dropped: string[], prior: QuerySpec | null | undefined): Having[] {
  const out: Having[] = []
  for (const term of whereTerms(shape, 'having')) {
    const compare = COMPARE.exec(term.text)
    const ref = compare ? columnOf(compare[1]!.trim()) : null
    const op = compare ? COMPARISONS[compare[2]!] : undefined
    const value = compare ? valueOf(compare[3]!.trim()) : null
    if (ref && op && HAVING_OPS.has(op) && value !== null) {
      out.push({ id: id(), ref, op: op as Having['op'], value })
      continue
    }
    if (ref && op && HAVING_OPS.has(op) && isBound(compare![3]!)) {
      const remembered = prior?.having.find((h) => h.ref === ref && h.op === op)
      if (remembered) {
        out.push({ ...remembered, id: id() })
        continue
      }
      dropped.push(
        `The HAVING on \`${ref}\` compares against a value the server bound rather than wrote, and a bound value is not in the statement to read — it is gone.`,
      )
      continue
    }
    dropped.push(
      `The HAVING \`${oneLine(term.text)}\` is not a comparison against one computed column — it is gone.`,
    )
  }
  return out
}

function readOrderings(shape: Shape, dropped: string[]): Ordering[] {
  const out: Ordering[] = []
  for (const term of orderTerms(shape)) {
    const ref = columnOf(term.expr)
    if (ref && !term.tail) {
      out.push({ id: id(), ref, desc: term.desc })
      continue
    }
    dropped.push(
      `The order by \`${oneLine(term.expr)}${term.tail ? ' ' + term.tail : ''}\` is not a plain column — it is gone.`,
    )
  }
  return out
}

const LIMIT_BY = /\bBY\b/i

function readLimit(
  shape: Shape,
  dropped: string[],
  prior: QuerySpec | null | undefined,
): number | null {
  if (shape.clauses.offset) {
    dropped.push(`The OFFSET ${bodyOf(shape, 'offset')} is dropped — the form always reads the first page.`)
  }
  const body = bodyOf(shape, 'limit')
  if (!body) return null
  if (LIMIT_BY.test(body)) {
    dropped.push(`\`LIMIT ${oneLine(body)}\` keeps rows per group, which the form cannot ask for — it is gone.`)
    return null
  }
  const parts = body.split(',').map((p) => p.trim())
  if (parts.length === 2) {
    dropped.push(`The offset in \`LIMIT ${oneLine(body)}\` is dropped — the form always reads the first page.`)
  }
  const rows = Number(parts[parts.length - 1])
  if (!Number.isFinite(rows) || rows <= 0) return null
  // The generated statement asks for one row more than the page, so that "there
  // is more behind this" is a fact rather than a guess. Reading that literally
  // would walk the limit up by one every time somebody turned a tab over.
  if (prior && rows === prior.limit + 1) return prior.limit
  return Math.floor(rows)
}

/** The form groups by every column it selects that it does not aggregate. A
 *  statement is free to disagree, and when it does the question is about to
 *  change — so say which way. */
function checkGrouping(shape: Shape, spec: QuerySpec, dropped: string[]): void {
  const { terms, modifier } = groupTerms(shape)
  if (modifier) {
    dropped.push(`${modifier} is dropped — the form returns the groups and no summary row.`)
  }
  const metrics = spec.projections.some((p) => p.agg !== null)
  const dimensions = spec.projections.filter((p) => p.agg === null)
  if (!terms.length) {
    if (metrics && dimensions.length) {
      dropped.push(
        `This statement aggregates without grouping; the form will group by ${dimensions
          .map((p) => `\`${p.column}\``)
          .join(', ')}, which is a different question.`,
      )
    }
    return
  }
  // Compared the way the form means it, not the way it is spelled: a dimension
  // bucketed to the day is selected as `toStartOfDay(ts)` and grouped by the
  // same call, and a set of strings would call those two different things.
  const selected = new Set(dimensions.map((p) => `${p.column}\u0000${p.bucket ?? ''}`))
  const missing = terms
    .map((t) => ({ key: groupKey(t.text), said: oneLine(t.text) }))
    .filter((t) => !t.key || !selected.has(t.key))
  if (missing.length) {
    dropped.push(
      `The grouping by ${missing.map((m) => `\`${m.said}\``).join(', ')} is gone: the form groups by the columns it selects, and ${
        missing.length === 1 ? 'that one is' : 'those are'
      } not among them.`,
    )
  }
}

/** A GROUP BY term as the form would hold it — a column, optionally bucketed —
 *  or null for a term the form has no shape for at all. */
function groupKey(text: string): string | null {
  const column = columnOf(text)
  if (column) return `${column}\u0000`
  const call = callOf(text.trim())
  if (!call) return null
  const bucket = BUCKET_CALLS[call.name.toLowerCase()]
  const inner = bucket ? columnOf(call.args) : null
  return inner ? `${inner}\u0000${bucket}` : null
}

/* ── Small readers ───────────────────────────────────────────────────────── */

/** A bare column reference, or null. A qualifier is dropped without comment:
 *  the form reads one table, so `t.city` and `city` are the same column. */
export function columnOf(expr: string): string | null {
  const text = expr.trim()
  if (!text) return null
  const parts = splitQualified(text)
  if (!parts) return null
  return parts[parts.length - 1]!
}

function splitQualified(text: string): string[] | null {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '`') {
      let j = i + 1
      let name = ''
      while (j < text.length) {
        if (text[j] === '\\' && j + 1 < text.length) {
          name += text[j + 1]
          j += 2
          continue
        }
        if (text[j] === '`') break
        name += text[j]
        j += 1
      }
      if (j >= text.length) return null
      out.push(name)
      i = j + 1
    } else {
      const match = /^[A-Za-z_]\w*/.exec(text.slice(i))
      if (!match) return null
      out.push(match[0])
      i += match[0].length
    }
    if (i === text.length) return out
    if (text[i] !== '.') return null
    i += 1
  }
  return null
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

/** The same closed grammar of time expressions `lib/query` writes out, read the
 *  other way. Matching a fixed shape is what lets these through as values: they
 *  are the only unquoted text the form's own encoder ever produces. */
const TIME_EXPR =
  /^(now\(\)|today\(\)|yesterday\(\))(\s*-\s*INTERVAL\s+\d+\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR))?$/i

export function isBound(text: string): boolean {
  return BOUND.test(text.trim())
}

/** A literal, as the form would have typed it: the text of a string without its
 *  quotes, a number as written, a `now() - INTERVAL …` left whole because the
 *  form's own encoder writes that back unquoted.
 *
 *  Null for everything else, and deliberately so. The form has one box for a
 *  value and a type-aware encoder behind it; handing that box an expression
 *  would re-encode it as the string it is not. This is also what stops a
 *  greedy comparison from reading `a = 1 OR b = 2` as a filter on `a` whose
 *  value is `1 OR b = 2` — a filter that would run, and mean something else. */
export function valueOf(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) return null
    return unescapeString(trimmed.slice(1, -1))
  }
  if (NUMBER.test(trimmed)) return trimmed
  if (TIME_EXPR.test(trimmed)) return trimmed.replace(/\s+/g, ' ')
  return null
}

function unescapeString(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\\' && i + 1 < body.length) {
      const next = body[i + 1]!
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next
      i += 1
      continue
    }
    if (body[i] === "'" && body[i + 1] === "'") {
      out += "'"
      i += 1
      continue
    }
    out += body[i]
  }
  return out
}

/** `name(args)`, with the parentheses balanced across the whole argument list
 *  so that `quantile(0.95)(ms)` is not mistaken for a call to `quantile`. */
function callOf(expr: string): { name: string; args: string } | null {
  const match = /^([A-Za-z_]\w*)\s*\(/.exec(expr)
  if (!match) return null
  let depth = 0
  for (let i = match[0].length - 1; i < expr.length; i += 1) {
    if (expr[i] === '(') depth += 1
    else if (expr[i] === ')') {
      depth -= 1
      if (depth === 0) {
        if (i !== expr.length - 1) return null
        return { name: match[1]!, args: expr.slice(match[0].length, i) }
      }
    }
  }
  return null
}

/** Split an `IN` list on commas at depth zero, leaving strings alone. */
function splitList(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = false
  let start = 0
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]
    if (quote) {
      if (c === '\\') i += 1
      else if (c === "'") quote = false
      continue
    }
    if (c === "'") quote = true
    else if (c === '(' || c === '[') depth += 1
    else if (c === ')' || c === ']') depth -= 1
    else if (c === ',' && depth === 0) {
      out.push(body.slice(start, i))
      start = i + 1
    }
  }
  out.push(body.slice(start))
  return out.map((v) => v.trim()).filter(Boolean)
}

/** A clause quoted back in a sentence has to stay one line, or the notice
 *  becomes the statement again. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 72 ? `${flat.slice(0, 71)}…` : flat
}
