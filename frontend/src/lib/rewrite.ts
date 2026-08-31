/** Reading a SELECT well enough to edit one clause of it, and no better.
 *
 *  The Query page lets the grid do what the grid is good at: a click on a
 *  header orders, a click on a cell filters, a column put away is a column the
 *  server stops reading. None of that is allowed to become a hidden second
 *  model of the query — the statement in the editor stays the only truth, so
 *  every one of those gestures comes back here and rewrites the text.
 *
 *  Which means this file has one hard requirement and one deliberate limit.
 *
 *  The requirement: it must never corrupt a statement it does not understand.
 *  Every rewrite is a splice into a span this file located by tokenising, and
 *  anything it cannot locate — a UNION, a statement that is not a SELECT, a
 *  LIMIT with a BY in it — makes the rewrite a no-op and the affordance go
 *  away. Refusing in the UI is cheap. Silently reordering somebody's data is
 *  not.
 *
 *  The limit: this is not a SQL parser and must not grow into one. It finds
 *  clause boundaries at bracket depth zero and splits lists on commas. It has
 *  no opinion about expressions, and everything it puts *into* a statement is
 *  either a quoted identifier or a literal encoded by `lib/query`. */

import { family } from './chType'
import { tokenize, type TokenKind } from './ddl'
import { quoteIdent } from './query'

/** The clauses of a SELECT, in the order ClickHouse wants them written. New
 *  clauses are inserted by finding the first of these that already exists and
 *  sits after the one being added, which is the whole reason this is a list and
 *  not a set. */
export const CLAUSE_ORDER = [
  'with',
  'select',
  'from',
  'prewhere',
  'where',
  'groupBy',
  'having',
  'orderBy',
  'limit',
  'offset',
  'settings',
  'format',
] as const

export type ClauseName = (typeof CLAUSE_ORDER)[number]

export interface Clause {
  name: ClauseName
  /** Offset of the first character of the keyword. */
  at: number
  /** Offset just past the keyword, where the body starts. */
  bodyStart: number
  /** Offset just past the last token of the body — trailing whitespace and
   *  comments excluded, so replacing a body cannot eat a comment written after
   *  it. */
  end: number
}

export interface Shape {
  /** The statement this shape describes, verbatim. Every offset indexes it. */
  sql: string
  clauses: Partial<Record<ClauseName, Clause>>
  /** A SELECT is the only thing worth rewriting; INSERT, CREATE and the rest
   *  are left entirely alone. */
  isSelect: boolean
  /** `SELECT … UNION ALL SELECT …` has two select lists and two ORDER BYs, and
   *  editing "the" ORDER BY of one would silently mean the last. Refused. */
  compound: boolean
}

/** What each clause is written as when this file has to write one. */
const KEYWORD: Record<ClauseName, string> = {
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

/** Word sequences that start a clause, longest first so `GROUP BY` is matched
 *  before a bare `GROUP` could be.
 *
 *  What is *not* here matters as much as what is. The JOIN family, `ON`,
 *  `USING` and `ARRAY JOIN` are all part of the FROM clause's body: a rewrite
 *  never needs to touch them, and treating them as boundaries would only give
 *  this file more ways to be wrong. `WITH ROLLUP`, `WITH CUBE` and
 *  `WITH TOTALS` are likewise left inside the GROUP BY they modify — which is
 *  also why `WITH` only counts as a clause when it opens the statement. */
const STARTS: { words: string[]; name: ClauseName }[] = [
  { words: ['GROUP', 'BY'], name: 'groupBy' },
  { words: ['ORDER', 'BY'], name: 'orderBy' },
  { words: ['WITH'], name: 'with' },
  { words: ['SELECT'], name: 'select' },
  { words: ['FROM'], name: 'from' },
  { words: ['PREWHERE'], name: 'prewhere' },
  { words: ['WHERE'], name: 'where' },
  { words: ['HAVING'], name: 'having' },
  { words: ['LIMIT'], name: 'limit' },
  { words: ['OFFSET'], name: 'offset' },
  { words: ['SETTINGS'], name: 'settings' },
  { words: ['FORMAT'], name: 'format' },
]

/** Set operators. One of these at depth zero and the statement is compound. */
const COMPOUND = new Set(['UNION', 'INTERSECT', 'EXCEPT'])

interface Tok {
  kind: TokenKind
  text: string
  at: number
  end: number
  /** Bracket depth *before* this token, so an opening paren is at the depth it
   *  was opened from and its contents are one deeper. */
  depth: number
}

/** Tokens that carry meaning: whitespace and comments dropped, offsets kept. */
function meaningful(sql: string): Tok[] {
  const out: Tok[] = []
  let depth = 0
  for (const token of tokenize(sql)) {
    if (token.kind === 'space' || token.kind === 'comment') continue
    const tok: Tok = {
      kind: token.kind,
      text: token.text,
      at: token.at,
      end: token.at + token.text.length,
      depth,
    }
    if (token.kind === 'punct') {
      if (token.text === '(' || token.text === '[') depth += 1
      if (token.text === ')' || token.text === ']') depth = Math.max(0, depth - 1)
    }
    out.push(tok)
  }
  return out
}

function isWord(tok: Tok | undefined, word: string): boolean {
  return Boolean(tok) && tok!.text.toUpperCase() === word && tok!.kind !== 'quoted' && tok!.kind !== 'string'
}

/** Locate the clauses of a statement. Always returns a shape — a statement
 *  this file cannot rewrite is described honestly rather than thrown over. */
export function shapeOf(sql: string): Shape {
  const tokens = meaningful(sql)
  const clauses: Partial<Record<ClauseName, Clause>> = {}
  let compound = false

  // Which clause each token belongs to, so a clause can end at the last token
  // that is actually its own.
  let current: Clause | null = null
  const close = (endToken: Tok | undefined) => {
    if (current && endToken) current.end = endToken.end
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!
    if (tok.depth !== 0) continue
    if (COMPOUND.has(tok.text.toUpperCase()) && tok.kind === 'keyword') {
      // `WITH ... UNION` cannot happen, but `GROUP BY x WITH TOTALS` can, and
      // `EXCEPT` is also a column modifier — `SELECT * EXCEPT (id)`. Only a set
      // operator that is not inside brackets and not following a select-list
      // modifier reaches here, and the cheap test that separates them is
      // whether a FROM has already been seen.
      if (clauses.from) {
        compound = true
        break
      }
    }

    const start = STARTS.find(
      (candidate) =>
        candidate.words.every((word, k) => isWord(tokens[i + k], word)) &&
        // `WITH` opens a statement or modifies a GROUP BY; only the first is a
        // clause of its own.
        (candidate.name !== 'with' || i === 0),
    )
    if (!start) continue
    // A clause named twice is a statement this file misread — keep the first
    // and stop trusting the rest.
    if (clauses[start.name]) continue
    close(tokens[i - 1])
    const last = tokens[i + start.words.length - 1]!
    current = { name: start.name, at: tok.at, bodyStart: last.end, end: last.end }
    clauses[start.name] = current
    i += start.words.length - 1
  }
  close(tokens[tokens.length - 1])

  const first = tokens[0]
  const isSelect =
    Boolean(clauses.select) &&
    Boolean(first) &&
    (isWord(first, 'SELECT') || isWord(first, 'WITH'))

  return { sql, clauses, isSelect, compound }
}

/** True when a click in the grid may rewrite this statement. A SELECT with a
 *  FROM and no set operator: everything else keeps its local behaviour and the
 *  UI says so rather than pretending. */
export function rewritable(shape: Shape): boolean {
  return shape.isSelect && !shape.compound && Boolean(shape.clauses.from)
}

/** The text of a clause's body, trimmed. */
export function bodyOf(shape: Shape, name: ClauseName): string {
  const clause = shape.clauses[name]
  if (!clause) return ''
  return shape.sql.slice(clause.bodyStart, clause.end).trim()
}

/* -- Splitting lists ---------------------------------------------------- */

export interface Piece {
  text: string
  start: number
  end: number
}

/** Split a span on separators at depth zero, keeping each piece's offsets.
 *  `words` are matched case-insensitively as whole tokens (`AND`), `punct` as
 *  literal characters (`,`). */
function splitSpan(
  sql: string,
  from: number,
  to: number,
  separator: { punct?: string; word?: string },
): Piece[] {
  const tokens = meaningful(sql.slice(from, to)).map((tok) => ({
    ...tok,
    at: tok.at + from,
    end: tok.end + from,
  }))
  const pieces: Piece[] = []
  let start = from
  const push = (end: number) => {
    const raw = sql.slice(start, end)
    const text = raw.trim()
    if (!text) return
    const lead = raw.length - raw.trimStart().length
    pieces.push({ text, start: start + lead, end: start + lead + text.length })
  }
  for (const tok of tokens) {
    const hit =
      tok.depth === 0 &&
      ((separator.punct !== undefined && tok.kind === 'punct' && tok.text === separator.punct) ||
        (separator.word !== undefined && isWord(tok, separator.word)))
    if (!hit) continue
    push(tok.at)
    start = tok.end
  }
  push(to)
  return pieces
}

/* -- The FROM target --------------------------------------------------- */

export interface Ref {
  database?: string
  table: string
}

/** What the statement reads from, when that is a plain table.
 *
 *  A subquery, a table function (`numbers(10)`, `s3(…)`) or a JOIN of two
 *  tables all answer null: the grid's column list may still be perfectly
 *  sortable, but "the table's other columns" is not a question with an answer,
 *  so the affordances that need one stay hidden. */
export function fromRef(shape: Shape): Ref | null {
  const clause = shape.clauses.from
  if (!clause) return null
  const tokens = meaningful(shape.sql.slice(clause.bodyStart, clause.end))
  const name = (tok: Tok | undefined): string | null => {
    if (!tok) return null
    if (tok.kind === 'quoted') return tok.text.slice(1, -1).replace(/\\`/g, '`')
    if (tok.kind === 'name' || tok.kind === 'keyword' || tok.kind === 'type') return tok.text
    return null
  }
  const first = name(tokens[0])
  if (!first) return null
  // A table function is a name followed by `(`; a subquery opens with `(`.
  if (tokens[1]?.kind === 'punct' && tokens[1].text === '(') return null
  if (tokens[1]?.kind === 'punct' && tokens[1].text === '.') {
    const second = name(tokens[2])
    if (!second) return null
    return rest(tokens, 3) ? null : { database: first, table: second }
  }
  return rest(tokens, 1) ? null : { table: first }
}

/** Anything past the table name that is not an alias — a JOIN, a FINAL, a
 *  sample clause. Those do not stop a sort, but they do mean "the table" is no
 *  longer one thing, so the column-picking side of the page steps back. */
function rest(tokens: Tok[], from: number): boolean {
  const tail = tokens.slice(from).filter((tok) => !isWord(tok, 'AS') && !isWord(tok, 'FINAL'))
  // One bare name after the table is an alias, which changes nothing.
  return tail.length > 1 || (tail.length === 1 && tail[0]!.kind !== 'name')
}

/* -- The select list --------------------------------------------------- */

export interface Item extends Piece {
  /** The expression without its alias. */
  expr: string
  alias: string | null
  /** The name this item's column arrives under, which is what the grid shows
   *  and therefore what a click on a header has to match. Null for an
   *  expression whose result name is ClickHouse's business — `count()` comes
   *  back as `count()`, but `a + b` comes back as `plus(a, b)` and guessing is
   *  worse than admitting. */
  resultName: string | null
}

/** The items of the select list, or null when there is no select clause.
 *  `SELECT *` is one item whose `expr` is `*`. */
export function selectItems(shape: Shape): Item[] | null {
  const clause = shape.clauses.select
  if (!clause) return null
  // DISTINCT belongs to the clause, not to the first item.
  let from = clause.bodyStart
  const head = meaningful(shape.sql.slice(clause.bodyStart, clause.end))[0]
  if (head && (isWord(head, 'DISTINCT') || isWord(head, 'ALL'))) from = clause.bodyStart + head.end
  return splitSpan(shape.sql, from, clause.end, { punct: ',' }).map(asItem)
}

function asItem(piece: Piece): Item {
  const tokens = meaningful(piece.text)
  const last = tokens[tokens.length - 1]
  const beforeLast = tokens[tokens.length - 2]
  // `expr AS name`, or `expr name` — the second is legal and common, but only
  // recognised when what precedes it could not be an operator waiting for its
  // right-hand side.
  if (last && beforeLast && isWord(beforeLast, 'AS')) {
    return {
      ...piece,
      expr: piece.text.slice(0, beforeLast.at).trim(),
      alias: unquote(last),
      resultName: unquote(last),
    }
  }
  if (tokens.length > 1 && last && last.kind === 'name' && beforeLast && closesAValue(beforeLast)) {
    return {
      ...piece,
      expr: piece.text.slice(0, last.at).trim(),
      alias: last.text,
      resultName: last.text,
    }
  }
  const single = tokens.length === 1 ? tokens[0]! : null
  // A lone token is a column name whatever the dialect calls it. Half of
  // `system.query_log` is named after SQL keywords — `query`, `time`, `type`,
  // `event_date` — and treating those as unnameable expressions would quietly
  // switch off every affordance that works by result-column name: the header's
  // drop, the strip's column list, the pruning of a stale ORDER BY.
  const name =
    single && single.kind !== 'string' && single.kind !== 'number' && single.text !== '*'
      ? unquote(single)
      : single && single.text === '*'
        ? '*'
        : // `count()` and friends: three tokens, and ClickHouse names the column
          // after the call as written.
          nameOfCall(tokens)
  return { ...piece, expr: piece.text, alias: null, resultName: name }
}

/** `count()`, `uniq(x)`, `sum(bytes)` all come back under the text of the call
 *  with its spaces removed, which is what makes a header click on an aggregate
 *  work at all. Anything with an operator in it is left unnamed. */
function nameOfCall(tokens: Tok[]): string | null {
  if (tokens.length < 3) return null
  if (tokens[0]!.kind !== 'function' && tokens[0]!.kind !== 'name') return null
  const flat = tokens.map((tok) => tok.text).join('')
  return /^[A-Za-z_]\w*\([^()]*\)$/.test(flat) ? flat : null
}

function unquote(tok: Tok): string {
  if (tok.kind === 'quoted') return tok.text.slice(1, -1).replace(/\\`/g, '`').replace(/""/g, '"')
  return tok.text
}

/** True when the token before a bare name could end a value, which is what
 *  makes that name an alias rather than the other half of an expression. */
function closesAValue(tok: Tok): boolean {
  if (tok.kind === 'punct') return tok.text === ')' || tok.text === ']'
  if (tok.kind === 'keyword') return isWord(tok, 'NULL') || isWord(tok, 'END')
  return tok.kind === 'name' || tok.kind === 'number' || tok.kind === 'string' || tok.kind === 'quoted'
}

/* -- Editing ----------------------------------------------------------- */

/** Where a clause that does not exist yet has to go, and the separator to put
 *  in front of it. A statement already written across lines gets one more
 *  line; a one-liner stays a one-liner. */
function insertionPoint(shape: Shape, name: ClauseName): { at: number; before: string; after: string } {
  const index = CLAUSE_ORDER.indexOf(name)
  const multiline = shape.sql.trim().includes('\n')
  const gap = multiline ? '\n' : ' '
  for (const other of CLAUSE_ORDER.slice(index + 1)) {
    const clause = shape.clauses[other]
    if (clause) return { at: clause.at, before: '', after: gap }
  }
  // Past the last clause: after the final token, so a trailing comment or a
  // blank line at the end of the tab survives.
  const last = Object.values(shape.clauses).reduce((end, clause) => Math.max(end, clause.end), 0)
  return { at: last, before: gap, after: '' }
}

/** Replace a clause's body, add the clause, or remove it — the one primitive
 *  every rewrite below is written in terms of. `body` empty removes. */
export function setClause(shape: Shape, name: ClauseName, body: string): string {
  const clause = shape.clauses[name]
  const sql = shape.sql
  if (!body.trim()) {
    if (!clause) return sql
    // Take the whitespace in front of the keyword with it, so removing the last
    // clause of a multi-line statement does not leave a blank line behind.
    let from = clause.at
    while (from > 0 && /\s/.test(sql[from - 1] ?? '')) from -= 1
    return sql.slice(0, from) + sql.slice(clause.end)
  }
  if (clause) return sql.slice(0, clause.bodyStart) + ' ' + body + sql.slice(clause.end)
  const { at, before, after } = insertionPoint(shape, name)
  return sql.slice(0, at) + before + KEYWORD[name] + ' ' + body + after + sql.slice(at)
}

/* -- ORDER BY ---------------------------------------------------------- */

export interface OrderTerm {
  /** The expression as written, which is what goes back into the SQL. */
  expr: string
  desc: boolean
  /** The trailing modifiers this file does not interpret but must not lose —
   *  `NULLS LAST`, `WITH FILL`, a COLLATE. */
  tail: string
}

const DIRECTION = /\s+(ASC|DESC|ASCENDING|DESCENDING)\b/i
const MODIFIERS = /\s+(NULLS\s+(FIRST|LAST)|COLLATE\s+.*|WITH\s+FILL\b.*)$/i

export function orderTerms(shape: Shape): OrderTerm[] {
  const clause = shape.clauses.orderBy
  if (!clause) return []
  return splitSpan(shape.sql, clause.bodyStart, clause.end, { punct: ',' }).map((piece) => {
    let text = piece.text
    let tail = ''
    const mods = MODIFIERS.exec(text)
    if (mods) {
      tail = mods[0].trim()
      text = text.slice(0, mods.index)
    }
    const dir = DIRECTION.exec(text)
    let desc = false
    if (dir && dir.index + dir[0].length === text.length) {
      desc = /^DESC/i.test(dir[1]!)
      text = text.slice(0, dir.index)
    }
    return { expr: text.trim(), desc, tail }
  })
}

function renderOrder(terms: OrderTerm[]): string {
  return terms
    .map((term) => `${term.expr}${term.desc ? ' DESC' : ''}${term.tail ? ' ' + term.tail : ''}`)
    .join(', ')
}

/** Two expressions that mean the same column. Whitespace and the backticks are
 *  noise here; case is not, because ClickHouse's identifiers are
 *  case-sensitive. */
function sameExpr(a: string, b: string): boolean {
  const plain = (s: string) => s.trim().replace(/\s+/g, '').replace(/`/g, '')
  return plain(a) === plain(b)
}

/** The next ORDER BY after a click on a header.
 *
 *  The cycle is the grid's own — unsorted → ascending → descending → unsorted —
 *  because that is the gesture people already have in their hands from the
 *  local sort this replaces. A shift-click adds a level instead, and a level
 *  clicked past descending leaves, so a stack is undone the way it was built.
 *
 *  `ref` is an expression, already quoted if it needs to be. Ordering by the
 *  expression rather than by the select-list alias is deliberate: an alias that
 *  shadows a column name resolves to the wrong thing, and this codebase has
 *  been bitten by exactly that. */
export function cycleOrder(sql: string, ref: string, extend = false): string {
  const shape = shapeOf(sql)
  if (!rewritable(shape)) return sql
  const terms = orderTerms(shape)
  const at = terms.findIndex((term) => sameExpr(term.expr, ref))

  if (!extend) {
    if (terms.length === 1 && at === 0) {
      return setClause(shape, 'orderBy', terms[0]!.desc ? '' : renderOrder([{ ...terms[0]!, desc: true }]))
    }
    return setClause(shape, 'orderBy', renderOrder([{ expr: ref, desc: false, tail: '' }]))
  }
  if (at === -1) {
    return setClause(shape, 'orderBy', renderOrder([...terms, { expr: ref, desc: false, tail: '' }]))
  }
  const term = terms[at]!
  const next = term.desc
    ? terms.filter((_, i) => i !== at)
    : terms.map((t, i) => (i === at ? { ...t, desc: true } : t))
  return setClause(shape, 'orderBy', renderOrder(next))
}

/** Take one term out of the ORDER BY, leaving the others in their order. The
 *  chip strip above the grid needs this: an ORDER BY of three terms should be
 *  undoable one at a time, and a click on a header can only cycle the term it
 *  belongs to. */
export function removeOrderTerm(sql: string, ref: string): string {
  const shape = shapeOf(sql)
  if (!rewritable(shape)) return sql
  const terms = orderTerms(shape)
  const kept = terms.filter((term) => !sameExpr(term.expr, ref))
  if (kept.length === terms.length) return sql
  return setClause(shape, 'orderBy', renderOrder(kept))
}

/** Drop the ORDER BY entirely. */
export function clearOrder(sql: string): string {
  const shape = shapeOf(sql)
  if (!rewritable(shape)) return sql
  return setClause(shape, 'orderBy', '')
}

/* -- WHERE ------------------------------------------------------------- */

/** The conjuncts of the WHERE, as removable pieces.
 *
 *  A body with a top-level OR in it comes back as one piece, not several. `a OR
 *  b AND c` means `a OR (b AND c)`, so its comma-level split on AND is not a
 *  list of conjuncts at all, and offering "remove this one" over that list
 *  would change what the query means. One opaque chip is the honest answer. */
export function whereTerms(shape: Shape, name: 'where' | 'prewhere' | 'having' = 'where'): Piece[] {
  const clause = shape.clauses[name]
  if (!clause) return []
  const whole: Piece = {
    text: shape.sql.slice(clause.bodyStart, clause.end).trim(),
    start: clause.bodyStart,
    end: clause.end,
  }
  const ors = splitSpan(shape.sql, clause.bodyStart, clause.end, { word: 'OR' })
  if (ors.length > 1) return [whole]
  return splitSpan(shape.sql, clause.bodyStart, clause.end, { word: 'AND' })
}

/** AND a predicate into the WHERE, or write the WHERE.
 *
 *  An existing body holding a top-level OR is bracketed on the way in: `a OR b`
 *  ANDed with `c` is `(a OR b) AND c`, and forgetting the brackets there turns
 *  a filter into a different query that still runs. */
export function addFilter(sql: string, predicate: string, name: 'where' | 'having' = 'where'): string {
  const shape = shapeOf(sql)
  if (!rewritable(shape) || !predicate.trim()) return sql
  const clause = shape.clauses[name]
  if (!clause) return setClause(shape, name, predicate)
  const body = shape.sql.slice(clause.bodyStart, clause.end).trim()
  if (!body) return setClause(shape, name, predicate)
  const needsBrackets = splitSpan(shape.sql, clause.bodyStart, clause.end, { word: 'OR' }).length > 1
  const left = needsBrackets ? `(${body})` : body
  return setClause(shape, name, `${left} AND ${predicate}`)
}

/** Remove one conjunct, by the span `whereTerms` reported. Removing the last
 *  one removes the clause. */
export function removeTerm(sql: string, term: Piece, name: 'where' | 'prewhere' | 'having' = 'where'): string {
  const shape = shapeOf(sql)
  const clause = shape.clauses[name]
  if (!clause) return sql
  const terms = whereTerms(shape, name)
  const kept = terms.filter((piece) => piece.start !== term.start || piece.end !== term.end)
  if (kept.length === terms.length) return sql
  return setClause(shape, name, kept.map((piece) => piece.text).join(' AND '))
}

/* -- GROUP BY ---------------------------------------------------------- */

/** The terms of the GROUP BY, as removable pieces.
 *
 *  `WITH TOTALS`, `WITH ROLLUP` and `WITH CUBE` live inside this clause's body
 *  and are not terms: they modify the grouping rather than adding to it, and a
 *  chip offering to remove one would be offering to change what the other terms
 *  mean. The tail comes back as its own piece so the strip can show it and leave
 *  it alone. */
export function groupTerms(shape: Shape): { terms: Piece[]; modifier: string | null } {
  const clause = shape.clauses.groupBy
  if (!clause) return { terms: [], modifier: null }
  const body = shape.sql.slice(clause.bodyStart, clause.end)
  const mods = /\s+WITH\s+(TOTALS|ROLLUP|CUBE)\s*$/i.exec(body)
  const end = mods ? clause.bodyStart + mods.index : clause.end
  return {
    terms: splitSpan(shape.sql, clause.bodyStart, end, { punct: ',' }),
    modifier: mods ? mods[0].trim().toUpperCase() : null,
  }
}

/** Take one term out of the GROUP BY, keeping any modifier.
 *
 *  And take the projection with it. A grouping term that is also selected is by
 *  definition not an aggregate — you cannot group by one — so leaving it in the
 *  select list produces `SELECT hour, count() … GROUP BY type`, which ClickHouse
 *  rejects outright. "Stop grouping by hour" means hour stops being a dimension,
 *  and a click that returns a broken query has answered a question nobody asked.
 *
 *  Removing the last term removes the clause, which over a select list holding
 *  an aggregate turns the query into a single global row. That *is* the change
 *  the click asked for, and the result says how many rows came back. */
export function removeGroupTerm(sql: string, ref: string): string {
  const shape = shapeOf(sql)
  if (!rewritable(shape)) return sql
  const { terms, modifier } = groupTerms(shape)
  const kept = terms.filter((piece) => !sameExpr(piece.text, ref))
  if (kept.length === terms.length) return sql

  const items = selectItems(shape) ?? []
  const doomed = items.filter(
    (item) => sameExpr(item.expr, ref) || (item.alias !== null && sameExpr(item.alias, ref)),
  )
  // Nothing would be left to select: refuse the whole thing rather than leave a
  // `SELECT FROM`.
  if (doomed.length > 0 && doomed.length === items.length) return sql

  const body = kept.map((piece) => piece.text).join(', ')
  let next = setClause(shape, 'groupBy', body ? (modifier ? `${body} ${modifier}` : body) : '')
  for (const item of doomed) {
    const name = item.resultName ?? item.text
    next = dropSelectItem(next, name)
  }
  return next
}

/** Remove one select item by the name its column arrives under, and everything
 *  that named it. Used where a rewrite has to take a projection with it. */
function dropSelectItem(sql: string, name: string): string {
  const shape = shapeOf(sql)
  const items = selectItems(shape) ?? []
  const kept = items.filter((item) => (item.resultName ?? item.text) !== name)
  if (kept.length === items.length || kept.length === 0) return sql
  return pruneReferences(setSelectList(sql, kept.map((item) => item.text)), name)
}

/** Drop the clauses that named a column this query no longer produces.
 *
 *  `ORDER BY n` after `n` has left the select list is not a stale detail, it is
 *  an error from the server — and the same is true of a HAVING that mentions it.
 *  A WHERE is left alone: it runs before the projection and may perfectly well
 *  filter on a column the result does not show. */
export function pruneReferences(sql: string, name: string): string {
  let next = removeOrderTerm(sql, name)
  const shape = shapeOf(next)
  const terms = whereTerms(shape, 'having')
  const doomed = terms.filter((term) => mentions(term.text, name))
  for (const term of doomed) {
    // Re-read each time: removing one term moves the others.
    const fresh = whereTerms(shapeOf(next), 'having').find((t) => t.text === term.text)
    if (fresh) next = removeTerm(next, fresh, 'having')
  }
  return next
}

/** True when an expression names this column — as a token, so `n` does not match
 *  `now()` and a string literal holding the name does not count. */
function mentions(expression: string, name: string): boolean {
  return meaningful(expression).some(
    (tok) => (tok.kind === 'name' || tok.kind === 'quoted') && unquote(tok) === name,
  )
}

/* -- The select list, LIMIT -------------------------------------------- */

/** Replace the select list with these expressions.
 *
 *  A DISTINCT is carried over rather than rewritten away: dropping a column out
 *  of `SELECT DISTINCT a, b` while losing the DISTINCT changes the row count,
 *  and a rewrite that changes the row count is not the rewrite anybody
 *  clicked. */
export function setSelectList(sql: string, exprs: string[]): string {
  const shape = shapeOf(sql)
  if (!rewritable(shape) || exprs.length === 0) return sql
  const clause = shape.clauses.select!
  const head = meaningful(shape.sql.slice(clause.bodyStart, clause.end))[0]
  const distinct = head && isWord(head, 'DISTINCT') ? 'DISTINCT ' : ''
  return setClause(shape, 'select', distinct + exprs.join(', '))
}

/** Drop one column from the select list, expanding a `*` first.
 *
 *  `columns` is the result's own column list, which is exactly what the star
 *  expanded to on the last run — so this is the one place a `SELECT *` can be
 *  narrowed without asking the server what it contains. */
export function dropColumn(sql: string, column: string, columns: readonly string[]): string {
  const shape = shapeOf(sql)
  if (!rewritable(shape)) return sql
  const items = selectItems(shape)
  if (!items) return sql
  const star = items.length === 1 && items[0]!.expr === '*'
  if (star) {
    const kept = columns.filter((name) => name !== column)
    if (kept.length === 0 || kept.length === columns.length) return sql
    // A star expansion names no aliases, so nothing downstream can be referring
    // to this column by a name the query defined — but an ORDER BY on it is
    // still an ORDER BY on a column that will no longer be produced.
    return pruneReferences(setSelectList(sql, kept.map(quoteIdent)), column)
  }
  const kept = items.filter((item) => item.resultName !== column)
  if (kept.length === 0 || kept.length === items.length) return sql
  return pruneReferences(setSelectList(sql, kept.map((item) => item.text)), column)
}

/** True when the select list is a DISTINCT. The strip says so, because it is the
 *  difference between a hundred rows and a hundred distinct rows and nothing
 *  else on the page reveals it. */
export function isDistinct(shape: Shape): boolean {
  const clause = shape.clauses.select
  if (!clause) return false
  const head = meaningful(shape.sql.slice(clause.bodyStart, clause.end))[0]
  return Boolean(head && isWord(head, 'DISTINCT'))
}

/** Clauses the statement has that nothing on this page will touch.
 *
 *  A `WITH`, an `OFFSET`, a `SETTINGS` or a `FORMAT` changes what the query
 *  means or costs, and a strip that reads the query back as a sentence while
 *  quietly skipping them is a strip that lies by omission. Named, not editable —
 *  the editor above is where those get changed. */
export function untouched(shape: Shape): ClauseName[] {
  return (['with', 'offset', 'settings', 'format'] as ClauseName[]).filter(
    (name) => shape.clauses[name],
  )
}

const LIMIT_BY = /\bBY\b/i

/** Replace the LIMIT. `LIMIT n BY expr` is left alone: it is a different
 *  operator that happens to share a keyword, and rewriting its count is not
 *  what a row cap means. */
export function setLimit(sql: string, rows: number): string {
  const shape = shapeOf(sql)
  if (!rewritable(shape) || !Number.isFinite(rows)) return sql
  const body = bodyOf(shape, 'limit')
  if (LIMIT_BY.test(body)) return sql
  if (rows <= 0) return setClause(shape, 'limit', '')
  return setClause(shape, 'limit', String(Math.floor(rows)))
}

/* -- Predicates from a value ------------------------------------------- */

export type CellOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'isNull' | 'isNotNull' | 'like'

export const CELL_OP_LABEL: Record<CellOp, string> = {
  '=': 'is',
  '!=': 'is not',
  '>': '>',
  '>=': '\u2265',
  '<': '<',
  '<=': '\u2264',
  isNull: 'is null',
  isNotNull: 'is not null',
  like: 'contains',
}

/** The operators worth offering over a column of this type.
 *
 *  Ordering a `String` by `>` is legal and almost never meant; `contains` on a
 *  `DateTime` is legal and never meant. A filter menu that offers everything
 *  everywhere makes the reader do the type checking, which is the one thing the
 *  schema is already holding. */
export function cellOpsFor(type: string): CellOp[] {
  const f = family(type)
  const both: CellOp[] = ['=', '!=']
  const nulls: CellOp[] = ['isNull', 'isNotNull']
  if (f === 'number' || f === 'time') return [...both, '>', '>=', '<', '<=', ...nulls]
  if (f === 'string') return [...both, 'like', ...nulls]
  return [...both, ...nulls]
}

/** A predicate over a column, from a value the reader pointed at.
 *
 *  The value arrives out of a result cell, which means it is already a string
 *  whatever the column's type — ClickHouse quotes 64-bit integers on the wire —
 *  so the encoding decision is the column's type's to make, not the value's
 *  shape's. That is `literal`'s job, and going through it is what keeps a cell
 *  holding `'; DROP` a filter on a string rather than a hole. */
export function cellPredicate(
  column: string,
  type: string,
  op: CellOp,
  value: unknown,
  literal: (value: string, type: string) => string,
): string | null {
  const col = quoteIdent(column)
  if (op === 'isNull') return `${col} IS NULL`
  if (op === 'isNotNull') return `${col} IS NOT NULL`
  if (value === null || value === undefined) {
    // "Filter to this cell" on an empty cell means the null, not the empty
    // string: they are different answers and the grid already draws them
    // differently.
    return op === '=' ? `${col} IS NULL` : op === '!=' ? `${col} IS NOT NULL` : null
  }
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (op === 'like') return `${col} LIKE ${literal(`%${text}%`, 'String')}`
  return `${col} ${op} ${literal(text, type)}`
}
