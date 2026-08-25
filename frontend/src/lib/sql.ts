/** Splitting a buffer into statements, so the editor can run just the one
 *  under the cursor. ClickHouse's HTTP interface takes a single statement per
 *  request, and "run everything in the tab" is rarely what you meant. */

export interface Statement {
  sql: string
  start: number
  end: number
}

/** Split on `;`, ignoring semicolons inside strings, identifiers and comments. */
export function splitStatements(text: string): Statement[] {
  const statements: Statement[] = []
  let start = 0
  let i = 0

  const push = (end: number) => {
    const sql = text.slice(start, end)
    if (sql.trim()) statements.push({ sql, start, end })
  }

  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]

    if (c === '-' && next === '-') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl + 1
      continue
    }
    if (c === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2)
      i = close === -1 ? text.length : close + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      i += 1
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        // ClickHouse also accepts a doubled quote as an escape.
        if (text[i] === c && text[i + 1] === c) {
          i += 2
          continue
        }
        if (text[i] === c) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (c === ';') {
      push(i)
      i += 1
      start = i
      continue
    }
    i += 1
  }
  push(text.length)
  return statements
}

/** The statement the caret sits in, or the last one if the caret is past the
 *  final semicolon. */
export function statementAt(text: string, offset: number): Statement | null {
  const statements = splitStatements(text)
  if (statements.length === 0) return null
  for (const s of statements) {
    if (offset >= s.start && offset <= s.end) return s
  }
  return statements[statements.length - 1] ?? null
}

/** The first table a statement reads from, used to offer bare column names.
 *  `@codemirror/lang-sql` takes a static `defaultTable`, so Flint re-derives
 *  it from whatever the caret's statement selects from. */
export function tableInStatement(sql: string): { database?: string; table: string } | null {
  // Skip comments and string literals so `-- FROM x` and 'FROM x' do not win.
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")

  // Either a backtick-quoted name (which may contain anything, spaces
  // included) or a bare identifier, optionally qualified by a database.
  const NAME = String.raw`(?:\x60([^\x60]+)\x60|([A-Za-z_][\w$]*))`
  const match = new RegExp(String.raw`\b(?:from|join)\s+${NAME}(?:\s*\.\s*${NAME})?`, 'i').exec(
    stripped,
  )
  if (!match) return null

  const first = match[1] ?? match[2]
  const second = match[3] ?? match[4]
  if (!first) return null

  // `FROM db.table` gives both; `FROM table` gives only the table.
  return second ? { database: first, table: second } : { table: first }
}
