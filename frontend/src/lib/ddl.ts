/** Reading a CREATE statement.
 *
 *  ClickHouse returns `create_table_query` as a single line. For a thirty-column
 *  view that is two thousand characters of soft-wrapped text in which nothing
 *  can be found — not the columns, not the join, not the settings. This breaks
 *  it into lines and tells the highlighter what each piece is.
 *
 *  Both jobs run over tokens rather than regular expressions over the raw
 *  string, because DDL is full of quoted names: a column called `order by`, or a
 *  literal containing `FROM`, must not be treated as a clause.
 *
 *  Formatting only ever changes the whitespace *between* tokens. The invariant
 *  the tests assert is that the sequence of non-space tokens comes out
 *  identical — nothing added, removed, altered or reordered — so this can never
 *  corrupt a statement it does not understand, only lay one out badly. */

import { BUILTIN_SET, KEYWORD_SET } from './dialect'

export type TokenKind =
  | 'keyword'
  | 'type'
  | 'function'
  | 'string'
  | 'quoted'
  | 'number'
  | 'comment'
  | 'punct'
  | 'name'
  | 'space'

export interface Token {
  kind: TokenKind
  text: string
  /** Offset in the source, so a caller can recover the original slice of a
   *  run of tokens — an expression, with its own spacing, exactly as written. */
  at: number
}

const SPACE = /\s/
const DIGIT = /[0-9]/
const WORD_START = /[A-Za-z_$]/
const WORD = /[A-Za-z_$0-9]/

/** Scan SQL into tokens. Never throws and never loses a character: joining
 *  every `text` back together reproduces the input. */
export function tokenize(sql: string): Token[] {
  const out: Token[] = []
  let i = 0

  while (i < sql.length) {
    const c = sql[i]!

    if (SPACE.test(c)) {
      let j = i
      while (j < sql.length && SPACE.test(sql[j]!)) j += 1
      out.push({ kind: 'space', text: sql.slice(i, j), at: i })
      i = j
      continue
    }

    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      const end = nl === -1 ? sql.length : nl
      out.push({ kind: 'comment', text: sql.slice(i, end), at: i })
      i = end
      continue
    }

    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      const end = close === -1 ? sql.length : close + 2
      out.push({ kind: 'comment', text: sql.slice(i, end), at: i })
      i = end
      continue
    }

    // A string literal, or an identifier in backticks or double quotes — both
    // of which ClickHouse accepts, and either of which may contain anything.
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === '\\') {
          j += 2
          continue
        }
        if (sql[j] === c) {
          // A doubled quote is an escaped one, not the end.
          if (sql[j + 1] === c) {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      out.push({ kind: c === "'" ? 'string' : 'quoted', text: sql.slice(i, j), at: i })
      i = j
      continue
    }

    if (DIGIT.test(c) || (c === '.' && DIGIT.test(sql[i + 1] ?? ''))) {
      let j = i
      while (j < sql.length && /[0-9a-fA-FxX._+-]/.test(sql[j]!)) {
        // Do not swallow the `-` of `1-2` or the `.` of a qualified name.
        if ((sql[j] === '+' || sql[j] === '-') && !/[eE]/.test(sql[j - 1] ?? '')) break
        if (sql[j] === '.' && !DIGIT.test(sql[j + 1] ?? '')) break
        j += 1
      }
      out.push({ kind: 'number', text: sql.slice(i, j), at: i })
      i = j
      continue
    }

    if (WORD_START.test(c)) {
      let j = i
      while (j < sql.length && WORD.test(sql[j]!)) j += 1
      const text = sql.slice(i, j)
      out.push({ kind: classifyWord(text), text, at: i })
      i = j
      continue
    }

    out.push({ kind: 'punct', text: c, at: i })
    i += 1
  }

  return markFunctions(out)
}

function classifyWord(word: string): TokenKind {
  if (BUILTIN_SET.has(word)) return 'type'
  if (KEYWORD_SET.has(word.toLowerCase())) return 'keyword'
  return 'name'
}

/** A name with a `(` right after it is being called. The editor colours those
 *  differently, so this does too. */
function markFunctions(tokens: Token[]): Token[] {
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i]!.kind !== 'name') continue
    const next = tokens[i + 1]
    if (next && next.kind === 'punct' && next.text === '(') tokens[i] = { ...tokens[i]!, kind: 'function' }
  }
  return tokens
}

/* -- Formatting --------------------------------------------------------- */

/** A clause that starts a line. `list` clauses put their comma-separated
 *  arguments one per line beneath; `inline` ones keep theirs alongside. */
interface Clause {
  words: string[]
  style: 'list' | 'inline'
  /** True for a clause that can only appear in the DDL preamble. `COMMENT`,
   *  `ENGINE`, `TTL` and `KEY` are also perfectly ordinary column names, so once
   *  a select list has started they are treated as such — otherwise
   *  `SELECT comment AS column_comment` reads as a COMMENT clause and every
   *  line after it loses its layout. */
  ddl?: true
}

const CLAUSES: Clause[] = [
  { words: ['SELECT'], style: 'list' },
  { words: ['SETTINGS'], style: 'list' },
  { words: ['WITH'], style: 'inline' },
  { words: ['FROM'], style: 'inline' },
  { words: ['LEFT', 'ARRAY', 'JOIN'], style: 'inline' },
  { words: ['ARRAY', 'JOIN'], style: 'inline' },
  { words: ['LEFT', 'JOIN'], style: 'inline' },
  { words: ['RIGHT', 'JOIN'], style: 'inline' },
  { words: ['INNER', 'JOIN'], style: 'inline' },
  { words: ['FULL', 'JOIN'], style: 'inline' },
  { words: ['CROSS', 'JOIN'], style: 'inline' },
  { words: ['JOIN'], style: 'inline' },
  { words: ['ON'], style: 'inline' },
  { words: ['PREWHERE'], style: 'inline' },
  { words: ['WHERE'], style: 'inline' },
  { words: ['GROUP', 'BY'], style: 'inline' },
  { words: ['HAVING'], style: 'inline' },
  { words: ['ORDER', 'BY'], style: 'inline' },
  { words: ['LIMIT', 'BY'], style: 'inline' },
  { words: ['LIMIT'], style: 'inline' },
  { words: ['UNION', 'ALL'], style: 'inline' },
  { words: ['UNION', 'DISTINCT'], style: 'inline' },
  { words: ['FORMAT'], style: 'inline' },
  // The DDL side of the house.
  { words: ['ENGINE'], style: 'inline', ddl: true },
  { words: ['PARTITION', 'BY'], style: 'inline', ddl: true },
  { words: ['PRIMARY', 'KEY'], style: 'inline', ddl: true },
  { words: ['SAMPLE', 'BY'], style: 'inline', ddl: true },
  { words: ['TTL'], style: 'inline', ddl: true },
  { words: ['POPULATE'], style: 'inline', ddl: true },
  { words: ['COMMENT'], style: 'inline', ddl: true },
]

const INDENT = '    '

/** Break a statement across lines. Only whitespace changes. */
export function formatDdl(sql: string): string {
  const tokens = tokenize(sql)
  const sig: number[] = []
  tokens.forEach((t, i) => {
    if (t.kind !== 'space') sig.push(i)
  })
  if (sig.length === 0) return sql.trim()

  /** A significant token as a clause word would be written, or '' when it is
   *  something a clause can never be made of — a quoted name, a literal. */
  const word = (n: number): string => {
    const index = sig[n]
    if (index === undefined) return ''
    const token = tokens[index]!
    return token.kind === 'keyword' || token.kind === 'name' || token.kind === 'type'
      ? token.text.toUpperCase()
      : ''
  }

  /** Set once a top-level SELECT has been seen: past that point the statement
   *  is a query, and the DDL clause words are just column names. */
  let selecting = false

  const clauseAt = (n: number): Clause | null => {
    for (const clause of CLAUSES) {
      if (!clause.words.every((w, k) => word(n + k) === w)) continue
      // `ON CLUSTER x` is not a join condition.
      if (clause.words[0] === 'ON' && word(n + clause.words.length) === 'CLUSTER') continue
      if (clause.ddl && selecting) continue
      return clause
    }
    // `AS SELECT` opens a definition and deserves a line of its own, as one
    // heading. The `AS` of `expr AS alias` deserves nothing.
    if (word(n) === 'AS' && word(n + 1) === 'SELECT') {
      return { words: ['AS', 'SELECT'], style: 'list' }
    }
    if (word(n) === 'AS' && word(n + 1) === 'WITH') {
      return { words: ['AS', 'WITH'], style: 'inline' }
    }
    return null
  }

  const isCreate = word(0) === 'CREATE' || word(0) === 'ATTACH'

  const parts: string[] = []
  let indent = 0
  let depth = 0
  let breakNext = false
  /** Paren depth of the CREATE column list, once inside it. */
  let columnList: number | null = null
  /** Does the clause now running list its arguments one per line? */
  let listing = false
  /** Clause words already emitted, waiting to be walked past. */
  let skip = 0

  const newline = () => parts.push('\n' + INDENT.repeat(indent))

  for (let n = 0; n < sig.length; n += 1) {
    if (skip > 0) {
      skip -= 1
      continue
    }

    const index = sig[n]!
    const token = tokens[index]!
    // Whatever whitespace stood before this token collapses to one space,
    // unless a line break takes its place.
    const spaced = n > 0 && sig[n - 1]! + 1 !== index

    // Clause detection only at the top level: inside a column list, `TTL` and
    // `COMMENT` belong to the column, not to the statement.
    const clause = depth === 0 ? clauseAt(n) : null

    // Every break is decided before anything is written, so a newline never
    // leaves behind the space it was meant to replace. Getting that wrong is
    // invisible on the first pass and shows up as drift on the second.
    const closesColumnList =
      token.kind === 'punct' &&
      token.text === ')' &&
      columnList !== null &&
      depth === columnList

    if (closesColumnList) {
      indent = 0
      newline()
      depth -= 1
      columnList = null
      listing = false
      breakNext = false
      parts.push(token.text)
      continue
    }

    if (clause) {
      if (parts.length > 0) {
        indent = 0
        newline()
      }
      clause.words.forEach((_w, k) => {
        if (k > 0) parts.push(' ')
        parts.push(tokens[sig[n + k]!]!.text)
      })
      skip = clause.words.length - 1
      listing = clause.style === 'list'
      if (clause.words[clause.words.length - 1] === 'SELECT') selecting = true
      indent = 1
      breakNext = listing
      continue
    }

    if (breakNext) {
      newline()
      breakNext = false
    } else if (spaced) {
      parts.push(' ')
    }

    if (token.kind === 'punct') {
      if (token.text === '(') {
        depth += 1
        // The parenthesised column list of a CREATE: the first top-level group,
        // sitting directly after the object's name.
        if (isCreate && columnList === null && depth === 1 && n > 0) {
          const previous = tokens[sig[n - 1]!]!
          if (previous.kind === 'name' || previous.kind === 'quoted') {
            parts.push(token.text)
            columnList = 1
            indent = 1
            breakNext = true
            continue
          }
        }
      } else if (token.text === ')') {
        depth -= 1
      } else if (token.text === ',') {
        const listLevel = columnList ?? 0
        if (depth === listLevel && (columnList !== null || listing)) {
          parts.push(token.text)
          breakNext = true
          continue
        }
      }
    }

    parts.push(token.text)
  }

  return parts.join('').trim()
}
