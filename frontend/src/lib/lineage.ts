/** What a view is made of, read from its definition.
 *
 *  ClickHouse tells Flint which tables a *materialized* view depends on and
 *  nothing whatsoever about a plain one — `dependencies_table` comes back empty
 *  for a `CREATE VIEW`. So for a view the definition is the only account of
 *  where its rows come from, and for a materialized view it is the only account
 *  of where each individual column comes from. This reads both out of the SQL.
 *
 *  Deliberately a best-effort read. It recognises the shape almost every view
 *  has — a select list, a from, some joins, perhaps a union — and gives up
 *  rather than guessing on anything else. A reference it cannot place is
 *  reported as unplaced, never attributed to the wrong table: a lineage you
 *  cannot trust is worse than none. */

import { tokenize, type Token } from './ddl'

/** Something a branch selects from. */
export interface Source {
  database: string | null
  /** Null for a subquery or a table function — there is no name to link to. */
  table: string | null
  alias: string | null
  kind: 'table' | 'subquery' | 'function'
  /** As written, for display when there is no name. */
  text: string
}

/** A column reference inside an expression, resolved where possible. */
export interface Ref {
  database: string | null
  /** Null when no source could be matched — an alias from an enclosing scope,
   *  a constant folded into a name, something this reader does not follow. */
  table: string | null
  column: string
}

export interface ColumnOrigin {
  /** The output name, when the definition gives one. */
  name: string | null
  /** The expression as written, without its trailing alias. */
  expression: string
  /** Where the expression draws from. */
  from: Ref[]
  /** False when the expression is a plain column reference and nothing more. */
  computed: boolean
}

export interface Branch {
  sources: Source[]
  columns: ColumnOrigin[]
  /** Columns the branch reads without selecting them: join keys, filters,
   *  grouping. A view depends on these every bit as much as on the ones it
   *  returns — drop a join key and the view stops working. */
  filters: Ref[]
}

export interface Definition {
  branches: Branch[]
  /** Every source across every branch, de-duplicated, in order of appearance. */
  sources: Source[]
  /** Output columns, merged across branches by position. */
  columns: ColumnOrigin[]
  /** Columns read but not selected, across every branch. */
  filters: Ref[]
  /** True when the definition selects `*` and the columns cannot be listed. */
  star: boolean
}

/** Clause keywords that end a select list or a from clause. */
const BOUNDARY = new Set([
  'FROM',
  'PREWHERE',
  'WHERE',
  'GROUP',
  'HAVING',
  'ORDER',
  'LIMIT',
  'SETTINGS',
  'UNION',
  'FORMAT',
  'INTERSECT',
  'EXCEPT',
  'WINDOW',
  'QUALIFY',
])

/** Words that can never be a column reference inside an expression.
 *
 *  Everything else that is lexically an identifier can be one, keyword or not:
 *  `database`, `comment`, `engine`, `position`, `type` and `key` are all
 *  perfectly ordinary column names — `system.columns` uses four of them — and
 *  the highlighter is right to call them keywords while this reader has to
 *  treat them as columns. */
const STRUCTURAL = new Set([
  'AS',
  'DISTINCT',
  'ALL',
  'ANY',
  'NULL',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'AND',
  'OR',
  'NOT',
  'IN',
  'LIKE',
  'ILIKE',
  'BETWEEN',
  'IS',
  'INTERVAL',
  'CAST',
  'COLLATE',
  'ASC',
  'DESC',
  'NULLS',
  'FIRST',
  'LAST',
  'USING',
  'ON',
  'GLOBAL',
  'RECURSIVE',
  'WITH',
  'SELECT',
  'FINAL',
  'APPLY',
  'STEP',
  'TOTALS',
  'CUBE',
  'ROLLUP',
])

const JOIN_LEAD = new Set([
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'FULL',
  'CROSS',
  'OUTER',
  'ANY',
  'ALL',
  'ASOF',
  'SEMI',
  'ANTI',
  'GLOBAL',
  'ARRAY',
  'PASTE',
])

interface Scan {
  tokens: Token[]
  /** Indices into `tokens` of everything that is not whitespace. */
  sig: number[]
  sql: string
}

function scan(sql: string): Scan {
  const tokens = tokenize(sql)
  const sig: number[] = []
  tokens.forEach((t, i) => {
    if (t.kind !== 'space' && t.kind !== 'comment') sig.push(i)
  })
  return { tokens, sig, sql }
}

/** Could this token be naming a column? */
function columnish(s: Scan, n: number): boolean {
  const token = at(s, n)
  if (!token) return false
  if (token.kind === 'quoted') return true
  if (token.kind === 'name') return true
  if (token.kind === 'keyword') return !STRUCTURAL.has(token.text.toUpperCase())
  return false
}

const at = (s: Scan, n: number): Token | undefined => {
  const index = s.sig[n]
  return index === undefined ? undefined : s.tokens[index]
}

/** The upper-cased text of a significant token, or '' when it is a literal or a
 *  quoted name — neither of which can ever be a keyword. */
function kw(s: Scan, n: number): string {
  const token = at(s, n)
  if (!token) return ''
  if (token.kind === 'keyword' || token.kind === 'name' || token.kind === 'type') {
    return token.text.toUpperCase()
  }
  return ''
}

/** The original slice spanned by significant tokens `from`..`to` inclusive. */
function slice(s: Scan, from: number, to: number): string {
  const first = at(s, from)
  const last = at(s, to)
  if (!first || !last) return ''
  return s.sql.slice(first.at, last.at + last.text.length).trim()
}

/** Walk from `n` to the token after the group it opens, tracking depth. */
function depthAt(s: Scan, from: number, to: number): number[] {
  const depths: number[] = []
  let depth = 0
  for (let n = from; n <= to; n += 1) {
    const token = at(s, n)
    if (!token) break
    if (token.kind === 'punct' && token.text === ')') depth -= 1
    depths.push(depth)
    if (token.kind === 'punct' && token.text === '(') depth += 1
  }
  return depths
}

/** Split `from`..`to` at top-level occurrences of a keyword sequence. */
function splitTopLevel(s: Scan, from: number, to: number, words: string[]): [number, number][] {
  const depths = depthAt(s, from, to)
  const cuts: number[] = []
  for (let n = from; n <= to; n += 1) {
    if (depths[n - from] !== 0) continue
    if (words.every((w, k) => kw(s, n + k) === w)) cuts.push(n)
  }
  const spans: [number, number][] = []
  let start = from
  for (const cut of cuts) {
    if (cut > start) spans.push([start, cut - 1])
    start = cut + words.length
  }
  spans.push([start, to])
  return spans.filter(([a, b]) => a <= b)
}

/** Split at top-level commas. */
function splitCommas(s: Scan, from: number, to: number): [number, number][] {
  const depths = depthAt(s, from, to)
  const spans: [number, number][] = []
  let start = from
  for (let n = from; n <= to; n += 1) {
    const token = at(s, n)
    if (!token) break
    if (depths[n - from] === 0 && token.kind === 'punct' && token.text === ',') {
      if (n > start) spans.push([start, n - 1])
      start = n + 1
    }
  }
  if (start <= to) spans.push([start, to])
  return spans
}

/** The spans of a branch that hold conditions rather than sources: join
 *  conditions, filters, grouping. Collected separately because the FROM clause
 *  between them is full of table names, which are not column references. */
function filterSpans(s: Scan, from: number, to: number): [number, number][] {
  if (from > to) return []
  const depths = depthAt(s, from, to)
  const spans: [number, number][] = []
  let start = -1
  const close = (n: number) => {
    if (start >= 0 && n - 1 >= start) spans.push([start, n - 1])
    start = -1
  }
  for (let n = from; n <= to; n += 1) {
    if (depths[n - from] !== 0) continue
    const word = kw(s, n)
    if (word === 'ON' || word === 'WHERE' || word === 'PREWHERE' || word === 'HAVING') {
      close(n)
      start = n + 1
    } else if ((word === 'GROUP' || word === 'ORDER') && kw(s, n + 1) === 'BY') {
      close(n)
      start = n + 2
    } else if (
      word === 'FROM' ||
      word === 'SETTINGS' ||
      word === 'UNION' ||
      word === 'FORMAT' ||
      word === 'LIMIT' ||
      word === 'USING' ||
      JOIN_LEAD.has(word)
    ) {
      close(n)
    }
  }
  close(to + 1)
  return spans
}

/** Where a branch's select list ends: the first top-level boundary keyword. */
function boundary(s: Scan, from: number, to: number): number {
  const depths = depthAt(s, from, to)
  for (let n = from; n <= to; n += 1) {
    if (depths[n - from] !== 0) continue
    if (BOUNDARY.has(kw(s, n))) return n
  }
  return to + 1
}

/** Read `[db.]name`, a parenthesised subquery, or a table function, plus any
 *  alias, starting at `n`. Returns the source and where it ended. */
function readSource(s: Scan, n: number, to: number): { source: Source; next: number } | null {
  const first = at(s, n)
  if (!first) return null

  let cursor = n
  let database: string | null = null
  let table: string | null = null
  let kind: Source['kind'] = 'table'

  if (first.kind === 'punct' && first.text === '(') {
    // Skip the whole group.
    let depth = 0
    while (cursor <= to) {
      const token = at(s, cursor)
      if (!token) break
      if (token.kind === 'punct' && token.text === '(') depth += 1
      if (token.kind === 'punct' && token.text === ')') {
        depth -= 1
        if (depth === 0) {
          cursor += 1
          break
        }
      }
      cursor += 1
    }
    kind = 'subquery'
  } else if (first.kind === 'function' || columnish(s, n)) {
    const name = unquote(first.text)
    const dot = at(s, cursor + 1)
    if (dot?.kind === 'punct' && dot.text === '.' && columnish(s, cursor + 2)) {
      database = name
      table = unquote(at(s, cursor + 2)!.text)
      cursor += 3
    } else {
      table = name
      cursor += 1
    }
    // A table function — `numbers(10)`, `s3(...)` — is not a table.
    const after = at(s, cursor)
    if (after?.kind === 'punct' && after.text === '(') {
      kind = 'function'
      let depth = 0
      while (cursor <= to) {
        const token = at(s, cursor)
        if (!token) break
        if (token.kind === 'punct' && token.text === '(') depth += 1
        if (token.kind === 'punct' && token.text === ')') {
          depth -= 1
          if (depth === 0) {
            cursor += 1
            break
          }
        }
        cursor += 1
      }
    }
  } else {
    return null
  }

  const end = cursor - 1
  let alias: string | null = null
  if (kw(s, cursor) === 'AS') {
    if (columnish(s, cursor + 1)) {
      alias = unquote(at(s, cursor + 1)!.text)
      cursor += 2
    }
  } else {
    // A bare alias, but not the keyword that starts the next clause.
    if (
      columnish(s, cursor) &&
      !BOUNDARY.has(kw(s, cursor)) &&
      !JOIN_LEAD.has(kw(s, cursor)) &&
      kw(s, cursor) !== 'ON' &&
      kw(s, cursor) !== 'USING' &&
      kw(s, cursor) !== 'FINAL'
    ) {
      alias = unquote(at(s, cursor)!.text)
      cursor += 1
    }
  }

  return {
    source: { database, table, alias, kind, text: slice(s, n, end) },
    next: cursor,
  }
}

function unquote(text: string): string {
  if (text.length > 1 && (text[0] === '`' || text[0] === '"')) {
    return text.slice(1, -1).replace(/``|""/g, (m) => m[0]!)
  }
  return text
}

/** Everything a branch selects from: the FROM item and each JOIN's. */
function readSources(s: Scan, from: number, to: number): Source[] {
  const sources: Source[] = []
  let n = from
  while (n <= to) {
    const read = readSource(s, n, to)
    if (!read) {
      n += 1
      continue
    }
    sources.push(read.source)
    n = read.next
    // Skip to the next thing that introduces a source: a comma, or a join.
    while (n <= to) {
      const token = at(s, n)
      if (!token) break
      if (token.kind === 'punct' && token.text === ',') {
        n += 1
        break
      }
      if (kw(s, n) === 'JOIN') {
        n += 1
        break
      }
      // `ON <condition>` belongs to the join, not to a source.
      n += 1
    }
  }
  return sources
}

/** Column references in an expression, resolved through the branch's sources —
 *  and through the aliases the same select list has already defined, because
 *  ClickHouse lets one select item build on another: `table_catalog AS
 *  TABLE_CATALOG` reads the alias two lines up, not a column of any table. Such
 *  a reference resolves to whatever that alias itself came from. */
function readRefs(
  s: Scan,
  from: number,
  to: number,
  sources: Source[],
  aliases: Map<string, Ref[]> = new Map(),
): Ref[] {
  const byAlias = new Map<string, Source>()
  for (const source of sources) {
    if (source.alias) byAlias.set(source.alias.toLowerCase(), source)
    if (source.table) byAlias.set(source.table.toLowerCase(), source)
  }
  const named = sources.filter((x) => x.table)
  const only = named.length === 1 ? named[0]! : null

  const refs: Ref[] = []
  const seen = new Set<string>()
  const push = (ref: Ref) => {
    const key = `${ref.table ?? '?'}.${ref.column}`
    if (seen.has(key)) return
    seen.add(key)
    refs.push(ref)
  }

  for (let n = from; n <= to; n += 1) {
    const token = at(s, n)
    if (!token) break
    if (!columnish(s, n)) continue

    const dot = at(s, n + 1)
    if (dot?.kind === 'punct' && dot.text === '.' && columnish(s, n + 2)) {
      const next = at(s, n + 2)!
      const prefix = unquote(token.text)
      const column = unquote(next.text)
      const source = byAlias.get(prefix.toLowerCase())
      push({
        database: source?.database ?? null,
        table: source?.table ?? null,
        column: source ? column : `${prefix}.${column}`,
      })
      n += 2
      continue
    }

    // An earlier alias of this same select list, standing in for whatever it
    // was computed from.
    const alias = aliases.get(unquote(token.text))
    if (alias) {
      for (const ref of alias) push(ref)
      continue
    }

    // A bare column. A function call was marked as one by the tokenizer, and a
    // type name is a type, so neither reaches here.
    push({
      database: only?.database ?? null,
      table: only?.table ?? null,
      column: unquote(token.text),
    })
  }
  return refs
}

/** The alias a select item gives its result, and where the expression ends. */
function readAlias(s: Scan, from: number, to: number): { name: string | null; end: number } {
  if (to > from && kw(s, to - 1) === 'AS' && columnish(s, to)) {
    return { name: unquote(at(s, to)!.text), end: to - 2 }
  }
  // `expr alias` with no AS, only when the expression is a bare reference.
  if (to === from && columnish(s, from)) {
    return { name: unquote(at(s, from)!.text), end: to }
  }
  if (to - from === 2 && at(s, from + 1)?.text === '.' && columnish(s, to)) {
    return { name: unquote(at(s, to)!.text), end: to }
  }
  return { name: null, end: to }
}

/** True when the span is nothing but a column reference. */
function isPlainRef(s: Scan, from: number, to: number): boolean {
  if (to === from) return columnish(s, from)
  if (to - from === 2) {
    return at(s, from + 1)?.text === '.' && columnish(s, from) && columnish(s, to)
  }
  return false
}

function readBranch(s: Scan, from: number, to: number): Branch | null {
  // The select list starts after SELECT, and after DISTINCT if it is there.
  let n = from
  while (n <= to && kw(s, n) !== 'SELECT') n += 1
  if (n > to) return null
  n += 1
  if (kw(s, n) === 'DISTINCT' || kw(s, n) === 'ALL') n += 1

  const listEnd = boundary(s, n, to) - 1
  if (listEnd < n) return null

  // The FROM clause, if any.
  let sources: Source[] = []
  const fromAt = (() => {
    const depths = depthAt(s, listEnd + 1, to)
    for (let k = listEnd + 1; k <= to; k += 1) {
      if (depths[k - listEnd - 1] === 0 && kw(s, k) === 'FROM') return k
    }
    return -1
  })()
  if (fromAt >= 0) {
    const fromEnd = boundary(s, fromAt + 1, to) - 1
    sources = readSources(s, fromAt + 1, Math.max(fromAt + 1, fromEnd))
  }

  const columns: ColumnOrigin[] = []
  // Built up as we go, so an item can resolve against the aliases defined before
  // it — which is exactly the scope ClickHouse gives them.
  const defined = new Map<string, Ref[]>()
  for (const [a, b] of splitCommas(s, n, listEnd)) {
    const { name, end } = readAlias(s, a, b)
    const expressionEnd = Math.max(a, end)
    const from = readRefs(s, a, expressionEnd, sources, defined)
    columns.push({
      name,
      expression: slice(s, a, expressionEnd),
      from,
      computed: !isPlainRef(s, a, expressionEnd),
    })
    if (name) defined.set(name, from)
  }

  // Conditions read columns too, and `GROUP BY day` may mean the `day` this very
  // select computed — so the same alias scope applies, and grouping by a derived
  // column counts as reading whatever it derives from.
  const filters: Ref[] = []
  const seen = new Set<string>()
  for (const [a, b] of filterSpans(s, listEnd + 1, to)) {
    for (const ref of readRefs(s, a, b, sources, defined)) {
      const key = `${ref.table ?? '?'}.${ref.column}`
      if (seen.has(key)) continue
      seen.add(key)
      filters.push(ref)
    }
  }

  return { sources, columns, filters }
}

export function analyseDefinition(sql: string): Definition | null {
  if (!sql.trim()) return null
  const s = scan(sql)
  if (s.sig.length === 0) return null

  const last = s.sig.length - 1
  const spans = [
    ...splitTopLevel(s, 0, last, ['UNION', 'ALL']),
  ].flatMap((span) => splitTopLevel(s, span[0], span[1], ['UNION', 'DISTINCT']))

  const branches = spans
    .map(([a, b]) => readBranch(s, a, b))
    .filter((b): b is Branch => b !== null)
  if (branches.length === 0) return null

  const sources: Source[] = []
  const seen = new Set<string>()
  for (const branch of branches) {
    for (const source of branch.sources) {
      const key = `${source.database ?? ''}.${source.table ?? source.text}`
      if (seen.has(key)) continue
      seen.add(key)
      sources.push(source)
    }
  }

  // Merge by position: a UNION's branches line up column by column.
  const width = Math.max(...branches.map((b) => b.columns.length))
  const columns: ColumnOrigin[] = []
  for (let i = 0; i < width; i += 1) {
    const parts = branches.map((b) => b.columns[i]).filter((c): c is ColumnOrigin => Boolean(c))
    if (parts.length === 0) continue
    const from: Ref[] = []
    const keys = new Set<string>()
    for (const part of parts) {
      for (const ref of part.from) {
        const key = `${ref.table ?? '?'}.${ref.column}`
        if (keys.has(key)) continue
        keys.add(key)
        from.push(ref)
      }
    }
    columns.push({
      name: parts.find((p) => p.name)?.name ?? null,
      expression: parts[0]!.expression,
      from,
      computed: parts.some((p) => p.computed),
    })
  }

  const filters: Ref[] = []
  const filterKeys = new Set<string>()
  for (const branch of branches) {
    for (const ref of branch.filters) {
      const key = `${ref.table ?? '?'}.${ref.column}`
      if (filterKeys.has(key)) continue
      filterKeys.add(key)
      filters.push(ref)
    }
  }

  const star = columns.some((c) => c.expression === '*' || c.expression.endsWith('.*'))

  return { branches, sources, columns, filters, star }
}

/** The origin of one output column of a view, by name. */
export function originOf(definition: Definition | null, column: string): ColumnOrigin | null {
  if (!definition) return null
  return definition.columns.find((c) => c.name === column) ?? null
}

/** For each source table, which of its columns the definition reads, and which
 *  output columns each one feeds.
 *
 *  This is the question a schema change actually asks: if this column goes, what
 *  breaks. Keyed by table name rather than by database-qualified name, because
 *  that is what the reference resolved to. */
export function columnUsage(definition: Definition): Map<string, Map<string, string[]>> {
  const usage = new Map<string, Map<string, string[]>>()
  const touch = (ref: Ref): string[] | null => {
    if (!ref.table) return null
    let table = usage.get(ref.table)
    if (!table) {
      table = new Map<string, string[]>()
      usage.set(ref.table, table)
    }
    const feeds = table.get(ref.column) ?? []
    table.set(ref.column, feeds)
    return feeds
  }

  for (const column of definition.columns) {
    for (const ref of column.from) {
      const feeds = touch(ref)
      if (feeds && column.name && !feeds.includes(column.name)) feeds.push(column.name)
    }
  }
  // Read but not returned: an empty list of what it feeds is the point.
  for (const ref of definition.filters) touch(ref)
  return usage
}
