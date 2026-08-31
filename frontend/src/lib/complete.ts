/** What can be typed here, given what is already written.
 *
 *  The editor used to complete from a flat namespace: every table in the
 *  server, every column of every table, offered everywhere. That is a
 *  dictionary, not an assistant — it will happily complete a column of
 *  `system.parts` inside a query that reads `events`, and it has nothing at all
 *  to say about the word `GROUP`.
 *
 *  So this answers a narrower question. Where in the statement is the caret,
 *  what does the statement already read from, and what would be *legal and
 *  useful* in that position: the columns of that table, the clauses this
 *  statement does not have yet, the operators that follow a value, the shape of
 *  the aggregate somebody is halfway through writing. Everything here is a pure
 *  function of the text and the schema snapshot, so the rules are testable
 *  without an editor — `editor/complete.ts` is only the adapter that hands
 *  these to CodeMirror.
 *
 *  Two things it deliberately does not do. It does not read data: no value
 *  suggestions, no "did you mean this host", because that costs a query nobody
 *  asked for. And it never invents a column — a name that is not in the schema
 *  snapshot is not offered, which is what makes tab-completing one safe. */

import type { SchemaEntry } from './api'
import { family, isTemporal } from './chType'
import { statementBeing } from './sql'
import { CLAUSE_ORDER, fromRef, selectItems, shapeOf, type ClauseName, type Ref } from './rewrite'
import { quoteIdent } from './query'

/** Where the caret is, in terms of what belongs there. */
export type Slot =
  /** An empty tab, or the space after a semicolon. */
  | 'statement'
  | 'select'
  | 'from'
  | 'where'
  | 'groupBy'
  | 'having'
  | 'orderBy'
  | 'limit'
  /** Past the end of a clause body: where the next clause goes. */
  | 'tail'
  /** Inside a string literal or a comment. The words there are data or prose,
   *  not SQL, and a menu of operators over somebody's half-typed sentence is
   *  the kind of help that makes people switch autocomplete off. */
  | 'quiet'
  /** Somewhere this file has nothing useful to say. */
  | 'other'

export interface Context {
  slot: Slot
  /** What the statement reads from, when that is a plain table. */
  from: Ref | null
  /** The word being typed, and the span it occupies in the whole document. */
  word: { text: string; from: number; to: number }
  /** A qualifier typed in front of the word: `logs.ts` gives `logs`. */
  qualifier: string | null
  /** Clauses the statement already has, so a second WHERE is never offered. */
  present: ClauseName[]
  /** Aliases the select list defines, which ORDER BY and HAVING may name. */
  aliases: string[]
  /** The last complete token before the word, lower-cased — enough to tell
   *  `WHERE ts` (offer an operator) from `WHERE ts >` (offer a value). */
  previous: string | null
  /** True when the token before the caret could end a value, which is what
   *  makes an operator or a direction the useful suggestion. */
  afterValue: boolean
}

const WORD_CHAR = /[A-Za-z0-9_$]/

/** Which clause the caret sits in. Only the clauses that take a list of
 *  expressions get their own slot; the rest are `other`, where the clause
 *  keywords are still offered and nothing else is. */
const SLOT_OF: Partial<Record<ClauseName, Slot>> = {
  select: 'select',
  from: 'from',
  where: 'where',
  prewhere: 'where',
  groupBy: 'groupBy',
  having: 'having',
  orderBy: 'orderBy',
  limit: 'limit',
}

export function contextAt(doc: string, pos: number): Context {
  const statement = statementBeing(doc, pos)
  const text = statement?.sql ?? ''
  const base = statement?.start ?? pos
  const local = pos - base

  // The word under the caret, and any `qualifier.` in front of it.
  let from = pos
  while (from > 0 && WORD_CHAR.test(doc[from - 1] ?? '')) from -= 1
  const word = { text: doc.slice(from, pos), from, to: pos }
  let qualifier: string | null = null
  if (doc[from - 1] === '.') {
    let q = from - 1
    while (q > 0 && WORD_CHAR.test(doc[q - 1] ?? '')) q -= 1
    if (q < from - 1) qualifier = doc.slice(q, from - 1)
  }

  const shape = shapeOf(text)
  const present = CLAUSE_ORDER.filter((name) => shape.clauses[name])
  const items = selectItems(shape) ?? []
  const aliases = items.map((item) => item.alias).filter((a): a is string => Boolean(a))

  // The clause the caret is in: the last one that starts before it.
  let clause: ClauseName | null = null
  for (const name of CLAUSE_ORDER) {
    const found = shape.clauses[name]
    if (found && found.at < local) clause = name
  }

  const before = text.slice(0, Math.max(0, local - word.text.length - (qualifier ? qualifier.length + 1 : 0)))
  const trimmed = before.trimEnd()
  const previousMatch = /([A-Za-z_][\w$]*|\d[\w.]*|[)*\]]|'[^']*')\s*$/.exec(trimmed)
  const previous = previousMatch?.[1]?.toLowerCase() ?? null
  // A comma is the one separator that means "another one of these", so it does
  // not end a value: after `GROUP BY a,` the useful suggestion is a column, not
  // the next clause.
  const afterValue =
    !/,\s*$/.test(trimmed) &&
    previous !== null &&
    !CLAUSE_WORDS.has(previous) &&
    !OPERATOR_WORDS.has(previous)

  const slot: Slot = quiet(text, local)
    ? 'quiet'
    : !text.trim()
    ? 'statement'
    : clause === null
      ? 'statement'
      : // Past the last clause's body, with a space between: this is where the
        // next clause goes, and offering the columns of the table again there is
        // how the old completion made every keyword unreachable.
        afterValue && SLOT_OF[clause] === undefined
        ? 'tail'
        : (SLOT_OF[clause] ?? 'other')

  return {
    slot,
    from: fromRef(shape),
    word,
    qualifier,
    present,
    aliases,
    previous,
    afterValue,
  }
}

/** True when the caret sits inside a string literal or a line comment.
 *
 *  Counted rather than parsed: an odd number of unescaped quotes before the
 *  caret means one of them is still open. `--` is only a comment when it is not
 *  itself inside a string, which falls out of the same walk. */
function quiet(text: string, at: number): boolean {
  let inString = false
  for (let i = 0; i < at && i < text.length; i += 1) {
    const c = text[i]
    if (inString && c === '\\') {
      i += 1
      continue
    }
    if (c === "'") {
      inString = !inString
      continue
    }
    if (inString) continue
    if (c === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i)
      if (nl === -1 || nl >= at) return true
      i = nl
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      if (close === -1 || close + 2 > at) return true
      i = close + 1
    }
  }
  return inString

}

/** Words that never end a value, so a name after one of them is the start of an
 *  expression rather than something an operator could follow. */
const CLAUSE_WORDS = new Set([
  'select',
  'from',
  'prewhere',
  'where',
  'group',
  'by',
  'having',
  'order',
  'limit',
  'offset',
  'settings',
  'format',
  'distinct',
  'as',
  'on',
  'using',
  'join',
])

const OPERATOR_WORDS = new Set(['and', 'or', 'not', 'in', 'like', 'ilike', 'between', 'is', 'asc', 'desc'])

export interface Candidate {
  label: string
  kind: 'clause' | 'keyword' | 'column' | 'table' | 'database' | 'function' | 'snippet'
  /** What is inserted, when that differs from the label. A clause keyword takes
   *  a trailing space: `GROUP BY` is never the end of a thought. */
  insert?: string
  detail?: string
  info?: string
  /** Higher first. The scale is arbitrary but the ordering is the whole point:
   *  in a WHERE, this table's columns come before ClickHouse's 1,500
   *  functions. */
  boost: number
  /** A CodeMirror snippet, with `#{}` where the caret should land. */
  snippet?: boolean
}

/** The aggregates worth a keystroke, as snippets. `count()` takes no argument
 *  and is by far the most typed function in any ClickHouse session. */
const AGGREGATES: Candidate[] = [
  { label: 'count()', kind: 'function', insert: 'count()', detail: 'rows', boost: 70 },
  { label: 'uniq(…)', kind: 'function', insert: 'uniq(#{})', detail: 'distinct, approximate', boost: 68, snippet: true },
  { label: 'sum(…)', kind: 'function', insert: 'sum(#{})', detail: 'total', boost: 67, snippet: true },
  { label: 'avg(…)', kind: 'function', insert: 'avg(#{})', detail: 'mean', boost: 66, snippet: true },
  { label: 'max(…)', kind: 'function', insert: 'max(#{})', boost: 65, snippet: true },
  { label: 'min(…)', kind: 'function', insert: 'min(#{})', boost: 64, snippet: true },
  { label: 'quantile(0.95)(…)', kind: 'function', insert: 'quantile(0.95)(#{})', detail: '95th percentile', boost: 63, snippet: true },
  { label: 'countIf(…)', kind: 'function', insert: 'countIf(#{})', detail: 'rows matching a condition', boost: 62, snippet: true },
]

/** The functions people reach for around a timestamp, which is most of what a
 *  ClickHouse query does to a column that is not being summed. */
const TIME_FUNCTIONS: Candidate[] = [
  { label: 'toStartOfHour(…)', kind: 'function', insert: 'toStartOfHour(#{})', detail: 'bucket by hour', boost: 58, snippet: true },
  { label: 'toStartOfDay(…)', kind: 'function', insert: 'toStartOfDay(#{})', detail: 'bucket by day', boost: 57, snippet: true },
  { label: 'toStartOfMinute(…)', kind: 'function', insert: 'toStartOfMinute(#{})', detail: 'bucket by minute', boost: 56, snippet: true },
  { label: 'toDate(…)', kind: 'function', insert: 'toDate(#{})', boost: 55, snippet: true },
  { label: 'now()', kind: 'function', insert: 'now()', boost: 54 },
]

/** A handful of scalar functions, no more. A complete list of ClickHouse's
 *  built-ins would be two thousand entries and would bury this table's own
 *  columns under them — which is the failure this file exists to fix. The
 *  server's own `system.functions` is one query away for anyone who needs the
 *  rest, and the docs are better at describing them than a completion detail
 *  line is. */
const SCALARS: Candidate[] = [
  { label: 'length(…)', kind: 'function', insert: 'length(#{})', boost: 40, snippet: true },
  { label: 'lower(…)', kind: 'function', insert: 'lower(#{})', boost: 40, snippet: true },
  { label: 'upper(…)', kind: 'function', insert: 'upper(#{})', boost: 40, snippet: true },
  { label: 'round(…)', kind: 'function', insert: 'round(#{})', boost: 40, snippet: true },
  { label: 'coalesce(…)', kind: 'function', insert: 'coalesce(#{})', boost: 40, snippet: true },
  { label: 'if(…)', kind: 'function', insert: 'if(#{}, , )', boost: 40, snippet: true },
  { label: 'toString(…)', kind: 'function', insert: 'toString(#{})', boost: 40, snippet: true },
  { label: 'formatReadableSize(…)', kind: 'function', insert: 'formatReadableSize(#{})', detail: 'bytes as KiB, MiB', boost: 40, snippet: true },
]

/** The shape of a whole query, for an empty tab. Three shapes cover most of
 *  what anybody opens a tab to ask. */
const OPENERS: Candidate[] = [
  {
    label: 'SELECT * FROM …',
    kind: 'snippet',
    insert: 'SELECT *\nFROM #{table}\nLIMIT 100',
    detail: 'a look at the rows',
    boost: 96,
    snippet: true,
  },
  {
    label: 'SELECT count() FROM …',
    kind: 'snippet',
    insert: 'SELECT count()\nFROM #{table}',
    detail: 'how many',
    boost: 95,
    snippet: true,
  },
  {
    label: 'top values by count',
    kind: 'snippet',
    insert:
      'SELECT #{column}, count() AS n\nFROM #{table}\nGROUP BY #{column}\nORDER BY n DESC\nLIMIT 20',
    detail: 'GROUP BY … ORDER BY n DESC',
    boost: 94,
    snippet: true,
  },
]

/** What each clause is for, in the completion's own tooltip. A keyword list
 *  that says nothing teaches nothing, and this list is aimed at somebody who
 *  writes SQL rarely enough to have forgotten which of HAVING and WHERE runs
 *  first. */
const CLAUSE_INFO: Record<ClauseName, string> = {
  with: 'Name a subquery or a constant, and use it below.',
  select: 'The columns and expressions to return.',
  from: 'The table to read.',
  prewhere: 'Filter before the other columns are read — ClickHouse’s own trick for a wide table.',
  where: 'Keep only the rows that match. Runs before the grouping.',
  groupBy: 'One output row per distinct value of these.',
  having: 'Keep only the groups that match. Runs after the grouping, so it can filter an aggregate.',
  orderBy: 'Sort the result. On a large table, order by the sorting key where you can.',
  limit: 'Stop after this many rows.',
  offset: 'Skip this many rows first.',
  settings: 'Per-query server settings.',
  format: 'Wire format. Flint asks for JSON; a FORMAT here overrides that.',
}

const CLAUSE_LABEL: Record<ClauseName, string> = {
  with: 'WITH',
  select: 'SELECT',
  from: 'FROM',
  prewhere: 'PREWHERE',
  where: 'WHERE',
  groupBy: 'GROUP BY',
  having: 'HAVING',
  orderBy: 'ORDER BY',
  limit: 'LIMIT',
  offset: 'OFFSET',
  settings: 'SETTINGS',
  format: 'FORMAT',
}

/** Clauses that may follow the caret's own, and that the statement has not
 *  already got. In canonical order, boosted so the next one to write is the
 *  first one offered: after `FROM logs`, WHERE outranks LIMIT.
 *
 *  HAVING is only offered once there is a GROUP BY, because a HAVING without
 *  one is a filter that will be rejected or, worse, quietly accepted over the
 *  whole result. */
function nextClauses(ctx: Context, base = 90): Candidate[] {
  const has = new Set(ctx.present)
  const after = ctx.slot === 'statement' ? -1 : CLAUSE_ORDER.indexOf(slotClause(ctx.slot))
  return CLAUSE_ORDER.filter((name) => {
    if (has.has(name)) return false
    if (name === 'with' || name === 'select' || name === 'format') return false
    if (name === 'having' && !has.has('groupBy')) return false
    if (name === 'prewhere' && has.has('where')) return false
    return CLAUSE_ORDER.indexOf(name) > after
  }).map((name, i) => ({
    label: CLAUSE_LABEL[name],
    kind: 'clause' as const,
    insert: CLAUSE_LABEL[name] + ' ',
    info: CLAUSE_INFO[name],
    boost: base - i,
  }))
}

function slotClause(slot: Slot): ClauseName {
  switch (slot) {
    case 'select':
      return 'select'
    case 'from':
    case 'tail':
    case 'other':
      return 'from'
    case 'where':
      return 'where'
    case 'groupBy':
      return 'groupBy'
    case 'having':
      return 'having'
    case 'orderBy':
      return 'orderBy'
    case 'limit':
      return 'limit'
    default:
      return 'from'
  }
}

/** Operators, once there is something for them to operate on. */
const COMPARISONS: Candidate[] = [
  { label: '=', kind: 'keyword', insert: '= ', boost: 88 },
  { label: '!=', kind: 'keyword', insert: '!= ', boost: 87 },
  { label: '>', kind: 'keyword', insert: '> ', boost: 86 },
  { label: '<', kind: 'keyword', insert: '< ', boost: 85 },
  { label: 'IN (…)', kind: 'keyword', insert: 'IN (#{})', boost: 84, snippet: true },
  { label: 'LIKE', kind: 'keyword', insert: "LIKE '%#{}%'", boost: 83, snippet: true },
  { label: 'IS NULL', kind: 'keyword', insert: 'IS NULL', boost: 82 },
  { label: 'IS NOT NULL', kind: 'keyword', insert: 'IS NOT NULL', boost: 81 },
  { label: 'BETWEEN … AND …', kind: 'keyword', insert: 'BETWEEN #{} AND ', boost: 80, snippet: true },
]

/** What joins one predicate to the next. Kept apart from the comparisons
 *  because the two are never both the answer: after `host` you want `=`, after
 *  `host = 'a'` you want `AND`. */
const CONNECTORS: { label: string; insert: string }[] = [
  { label: 'AND', insert: 'AND ' },
  { label: 'OR', insert: 'OR ' },
]

function connectors(boost: number): Candidate[] {
  return CONNECTORS.map((c, i) => ({ label: c.label, kind: 'keyword' as const, insert: c.insert, boost: boost - i }))
}

/** Tokens that end a predicate rather than open one: a literal, a closing
 *  bracket, the NULL of an IS NULL, the unit of an INTERVAL. After one of these
 *  the useful suggestion is AND, or the next clause — never another `=`. */
const CLOSERS = new Set([
  'null',
  ')',
  ']',
  'second',
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'quarter',
  'year',
])

function closesPredicate(ctx: Context): boolean {
  const previous = ctx.previous
  if (!previous) return false
  return CLOSERS.has(previous) || previous.startsWith("'") || /^\d/.test(previous)
}

export interface Source {
  schema: readonly SchemaEntry[]
  /** The database unqualified names resolve in. */
  database: string | undefined
}

function entryFor(source: Source, ref: Ref | null): SchemaEntry | null {
  if (!ref) return null
  const db = ref.database ?? source.database
  return (
    source.schema.find((entry) => entry.table === ref.table && entry.database === db) ??
    // A table named without a database that is not in the current one: better to
    // complete its columns than to pretend the table does not exist.
    source.schema.find((entry) => entry.table === ref.table) ??
    null
  )
}

/** This table's columns, as candidates. The type rides along in the detail
 *  line, which is the fastest way anybody learns a schema. */
function columnsOf(entry: SchemaEntry | null, boost: number): Candidate[] {
  if (!entry) return []
  return entry.columns.map((name, i) => ({
    label: name,
    kind: 'column' as const,
    insert: quoteIdent(name),
    detail: entry.types[i] ?? '',
    boost,
  }))
}

function tablesOf(source: Source, database: string | undefined, boost: number): Candidate[] {
  return source.schema
    .filter((entry) => entry.database === database)
    .map((entry) => ({
      label: entry.table,
      kind: 'table' as const,
      insert: quoteIdent(entry.table),
      detail: `${entry.columns.length} columns${entry.kind === 'table' ? '' : ` · ${entry.kind.replace('_', ' ')}`}`,
      boost,
    }))
}

function databasesOf(source: Source, boost: number): Candidate[] {
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const entry of source.schema) {
    if (seen.has(entry.database)) continue
    seen.add(entry.database)
    out.push({ label: entry.database, kind: 'database', insert: quoteIdent(entry.database) + '.', boost })
  }
  return out
}

/** The one suggestion that saves the most typing in a ClickHouse session: a
 *  window back from now, on a column the schema says is a timestamp. */
function timeWindow(entry: SchemaEntry | null, column: string | null): Candidate[] {
  if (!entry || !column) return []
  const at = entry.columns.findIndex((name) => name.toLowerCase() === column)
  const type = at === -1 ? null : entry.types[at]
  if (!type || !isTemporal(type)) return []
  return [
    {
      label: '>= now() - INTERVAL 1 HOUR',
      kind: 'keyword',
      insert: '>= now() - INTERVAL #{1} HOUR',
      detail: 'a window back from now',
      info: 'A relative window is what lets ClickHouse skip whole partitions, and it still means the same thing tomorrow — which is what makes the query worth saving.',
      boost: 92,
      snippet: true,
    },
  ]
}

/** Everything that could be typed at the caret, best first.
 *
 *  Filtering against what has actually been typed is left to the caller:
 *  CodeMirror's own fuzzy matcher does it better than a prefix test, and it is
 *  what makes `GROUP` reach `GROUP BY` and `tsoh` reach `toStartOfHour`. */
export function candidates(ctx: Context, source: Source): Candidate[] {
  // A qualified name is a closed question — `logs.` can only be followed by a
  // column of `logs`, or a table of the database `logs`.
  if (ctx.qualifier) {
    const table = entryFor(source, { table: ctx.qualifier })
    const asDatabase = tablesOf(source, ctx.qualifier, 88)
    const asTable = columnsOf(table, 90)
    return [...asTable, ...asDatabase]
  }

  const entry = entryFor(source, ctx.from)
  const out: Candidate[] = []

  switch (ctx.slot) {
    case 'statement':
      out.push(...OPENERS, ...tablesOf(source, source.database, 50), ...databasesOf(source, 30))
      out.push(
        { label: 'SELECT', kind: 'clause', insert: 'SELECT ', info: CLAUSE_INFO.select, boost: 60 },
        { label: 'WITH', kind: 'clause', insert: 'WITH ', info: CLAUSE_INFO.with, boost: 20 },
        { label: 'EXPLAIN', kind: 'keyword', insert: 'EXPLAIN ', boost: 10 },
        { label: 'DESCRIBE', kind: 'keyword', insert: 'DESCRIBE ', boost: 10 },
        { label: 'SHOW TABLES', kind: 'keyword', insert: 'SHOW TABLES', boost: 10 },
      )
      break

    case 'select':
      if (ctx.afterValue) {
        out.push(...nextClauses(ctx))
        out.push({ label: 'AS', kind: 'keyword', insert: 'AS ', boost: 70 })
      }
      out.push(...columnsOf(entry, ctx.afterValue ? 40 : 90))
      out.push({ label: '*', kind: 'keyword', insert: '*', detail: 'every column', boost: 60 })
      out.push(...AGGREGATES, ...TIME_FUNCTIONS, ...SCALARS)
      if (!ctx.present.includes('from')) {
        out.push({ label: 'FROM', kind: 'clause', insert: 'FROM ', info: CLAUSE_INFO.from, boost: 91 })
      }
      break

    case 'from':
      if (ctx.afterValue) {
        out.push(...nextClauses(ctx))
        out.push(
          { label: 'FINAL', kind: 'keyword', insert: 'FINAL', detail: 'collapse the parts first — a full merge, per query', boost: 50 },
          { label: 'AS', kind: 'keyword', insert: 'AS ', boost: 45 },
          { label: 'LEFT JOIN … ON …', kind: 'keyword', insert: 'LEFT JOIN #{} ON ', boost: 44, snippet: true },
          { label: 'INNER JOIN … ON …', kind: 'keyword', insert: 'INNER JOIN #{} ON ', boost: 43, snippet: true },
          { label: 'ARRAY JOIN', kind: 'keyword', insert: 'ARRAY JOIN ', boost: 42 },
        )
      } else {
        out.push(...tablesOf(source, source.database, 90), ...databasesOf(source, 60))
      }
      break

    case 'where':
    case 'having': {
      if (ctx.afterValue) {
        const closed = closesPredicate(ctx)
        out.push(...timeWindow(entry, ctx.previous))
        out.push(...connectors(closed ? 96 : 79))
        if (!closed) out.push(...COMPARISONS)
        out.push(...nextClauses(ctx, closed ? 90 : 70))
      }
      out.push(...columnsOf(entry, ctx.afterValue ? 40 : 90))
      if (ctx.slot === 'having') out.push(...aliasCandidates(ctx, 92))
      out.push(...AGGREGATES.slice(0, 4), ...TIME_FUNCTIONS, ...SCALARS)
      break
    }

    case 'groupBy':
      if (ctx.afterValue) {
        out.push(...nextClauses(ctx))
        out.push({ label: 'WITH TOTALS', kind: 'keyword', insert: 'WITH TOTALS', detail: 'one extra row for the whole set', boost: 50 })
      }
      out.push(...columnsOf(entry, ctx.afterValue ? 40 : 90), ...TIME_FUNCTIONS)
      break

    case 'orderBy':
      if (ctx.afterValue) {
        out.push(
          { label: 'DESC', kind: 'keyword', insert: 'DESC', boost: 95 },
          { label: 'ASC', kind: 'keyword', insert: 'ASC', boost: 94 },
        )
        out.push(...nextClauses(ctx))
      }
      // An ORDER BY may name a select-list alias, and after a GROUP BY that is
      // usually the only way to sort by the aggregate.
      out.push(...aliasCandidates(ctx, 92), ...columnsOf(entry, ctx.afterValue ? 40 : 90))
      break

    case 'limit':
      if (!ctx.afterValue) {
        out.push(
          { label: '100', kind: 'keyword', insert: '100', boost: 90 },
          { label: '1000', kind: 'keyword', insert: '1000', boost: 89 },
          { label: '10', kind: 'keyword', insert: '10', boost: 88 },
        )
      } else {
        out.push(...nextClauses(ctx))
        out.push({ label: 'BY', kind: 'keyword', insert: 'BY ', detail: 'this many rows per group', boost: 60 })
      }
      break

    case 'tail':
      out.push(...nextClauses(ctx))
      break

    case 'quiet':
      break

    default:
      out.push(...nextClauses(ctx), ...columnsOf(entry, 60))
  }

  return dedupe(out)
}

function aliasCandidates(ctx: Context, boost: number): Candidate[] {
  return ctx.aliases.map((alias) => ({
    label: alias,
    kind: 'column' as const,
    insert: quoteIdent(alias),
    detail: 'from the select list',
    boost,
  }))
}

/** A column called `count` and the `count()` function would otherwise both
 *  appear as themselves; a table's column always wins its own label. */
function dedupe(candidates: Candidate[]): Candidate[] {
  const seen = new Map<string, Candidate>()
  for (const candidate of candidates) {
    const existing = seen.get(candidate.label)
    if (!existing || candidate.boost > existing.boost) seen.set(candidate.label, candidate)
  }
  return [...seen.values()].sort((a, b) => b.boost - a.boost || a.label.localeCompare(b.label))
}

/** The completion that would be taken if the reader pressed Tab now, for the
 *  tests and for the hint line under the editor. */
export function best(doc: string, pos: number, source: Source): Candidate | null {
  const ctx = contextAt(doc, pos)
  const typed = ctx.word.text.toLowerCase()
  const list = candidates(ctx, source)
  const matching = typed
    ? list.filter((candidate) => candidate.label.toLowerCase().startsWith(typed))
    : list
  return matching[0] ?? null
}

/** The family of a column, for the completion icon. Keeps the editor's icons
 *  and the grid's type marks reading off the same six families. */
export function familyOf(detail: string | undefined): string {
  return detail ? family(detail) : 'other'
}
