/** The console, minus React and minus CodeMirror.
 *
 *  Flint's console is a *prompt on the database*, not a shell. There is no PTY
 *  behind it, no filesystem, no `ls` — so it is called a console rather than a
 *  terminal, on the same principle as the rest of this codebase: a name that
 *  promises something the thing cannot do is a bug that ships in the copy. What
 *  it does have is the one thing a terminal is actually for here: somewhere to
 *  type a statement without leaving the page you are reading.
 *
 *  Everything in this file is a pure function over values, because the parts of
 *  a console that are easy to get subtly wrong — the width of a column, which
 *  history entry Up should recall, whether `use` was spelled at the start of a
 *  statement or in the middle of one — are exactly the parts that are miserable
 *  to test through a DOM.
 *
 *  The printed table is ClickHouse's own `PrettyCompact`, on purpose. Anybody
 *  who has run `clickhouse-client` knows what a result looks like, and a console
 *  that prints results in a *different* shape from the client it is imitating is
 *  a console that has to be learnt twice. */

import { isNumeric } from './chType'
import { cellText, type CellKind } from './grid'
import { bytes, duration, exact } from './format'
import type { QueryResult } from './api'

/* ── The transcript ──────────────────────────────────────────────────────── */

/** What became of one thing somebody typed.
 *
 *  `note` is the console talking rather than the server: the answer to `help`,
 *  the confirmation of a `use`, the line that says a query was cancelled. It is
 *  an entry rather than a toast because a transcript that only records the
 *  statements is a transcript you cannot read back — half the reason the
 *  database changed under you is in the meta-commands. */
export type EntryState = 'running' | 'done' | 'error' | 'cancelled' | 'note'

export interface Entry {
  id: string
  /** What was typed, verbatim. Never the rewritten form: this is a record. */
  sql: string
  /** The database it resolved in — which may not be the one the prompt shows
   *  now, and that is precisely why it is stored per entry. */
  database: string
  at: number
  state: EntryState
  /** Minted by the client before the request leaves, so the statement can be
   *  killed while its own response is still in flight. */
  queryId?: string
  result?: QueryResult
  error?: string
  /** The console's own words, one line per string. */
  note?: string[]
  /** Settings this statement was carrying, on an entry that failed. Only set
   *  when there were any: a failure that had nothing to do with them should not
   *  be given a suspect. */
  carried?: string[]
}

/* ── Meta-commands ───────────────────────────────────────────────────────── */

/** The handful of words the console answers itself.
 *
 *  Deliberately small, because every word taken here is a word ClickHouse can
 *  never have back. Two kinds earn a place and nothing else does.
 *
 *  Three are *about the console* rather than about the data — `help`, `clear`
 *  and the several spellings of "put this away". ClickHouse has no opinion on
 *  any of them.
 *
 *  And two are statements ClickHouse's HTTP interface genuinely cannot honour,
 *  because there is no session behind it to hold them: `USE` and `SET` sent
 *  down the wire apply to the one request that carried them and report success
 *  regardless, which is the product agreeing with you and then doing the other
 *  thing. So the console holds them itself — see `parseSet` — and `settings`
 *  and `reset` come along as the way to see and undo what it is holding. */
export type Meta =
  | { kind: 'help' }
  | { kind: 'clear' }
  | { kind: 'hide' }
  | { kind: 'use'; database: string }
  | { kind: 'set'; changes: SettingChange[] }
  | { kind: 'settings' }
  | { kind: 'reset' }

/** One half of a `SET`. A null value is `DEFAULT` — the setting stops being
 *  carried rather than being carried as the word "DEFAULT". */
export interface SettingChange {
  name: string
  value: string | null
}

/** An unquoted identifier, or a backtick/double-quoted one — the same three
 *  spellings ClickHouse accepts after `USE`. */
const USE = /^use\s+(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][\w$]*))\s*;?\s*$/i

export function parseMeta(input: string): Meta | null {
  const line = input.trim().replace(/;+\s*$/, '').trim()
  const word = line.toLowerCase()
  if (word === 'help' || word === '?' || word === '\\?') return { kind: 'help' }
  if (word === 'clear' || word === 'cls' || word === '\\c') return { kind: 'clear' }
  if (word === 'exit' || word === 'quit' || word === '\\q') return { kind: 'hide' }
  if (word === 'reset') return { kind: 'reset' }
  if (word === 'set' || word === 'settings' || word === '\\s') return { kind: 'settings' }
  const use = USE.exec(input.trim())
  if (use) return { kind: 'use', database: use[1] ?? use[2] ?? use[3] ?? '' }
  const changes = parseSet(input)
  if (changes) return { kind: 'set', changes }
  return null
}

/* ── SET ─────────────────────────────────────────────────────────────────── */

/** A `SET`, taken apart — or null for anything that is not one.
 *
 *  **Why the console holds these itself.** ClickHouse's HTTP interface has no
 *  session: a `SET` sent down it applies to the request that carried it and
 *  nothing else, so a console that forwarded one would report `Ok.` and change
 *  precisely nothing about the next statement. That is the worst kind of bug —
 *  the product agreeing with you and then doing the other thing — so the
 *  console keeps the settings and puts them on every request it makes.
 *
 *  Which means they are the *console's* settings, not a session's. Nothing else
 *  in Flint carries them: not a dashboard tile, not an endpoint, not the same
 *  statement opened in the editor. The note printed after a `SET` says so,
 *  because a setting whose reach you have to guess is worse than no setting. */
const SETTING = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/

export function parseSet(input: string): SettingChange[] | null {
  const line = input.trim().replace(/;+\s*$/, '').trim()
  const head = /^set\s+([\s\S]+)$/i.exec(line)
  if (!head?.[1]) return null

  const changes: SettingChange[] = []
  for (const piece of splitTopLevel(head[1])) {
    const match = SETTING.exec(piece.trim())
    // One malformed pair and the whole thing goes to the server unchanged.
    // `SET ROLE admin` is a real statement and is not a settings assignment,
    // and guessing which half of a line to intercept is how a console starts
    // eating statements.
    if (!match?.[1] || !match[2]) return null
    const raw = match[2].trim()
    changes.push({
      name: match[1],
      value: /^default$/i.test(raw) ? null : unquote(raw),
    })
  }
  return changes.length > 0 ? changes : null
}

/** Split on commas that are not inside a quoted value. `SET s = 'a,b'` is one
 *  assignment, and splitting it naively makes it two broken ones. */
function splitTopLevel(input: string): string[] {
  const out: string[] = []
  let start = 0
  let quote: string | null = null
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i]
    if (quote) {
      if (c === '\\') i += 1
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === ',') {
      out.push(input.slice(start, i))
      start = i + 1
    }
  }
  out.push(input.slice(start))
  return out
}

function unquote(value: string): string {
  const quoted = /^'([\s\S]*)'$/.exec(value) ?? /^"([\s\S]*)"$/.exec(value)
  return quoted?.[1] !== undefined ? quoted[1].replace(/\\(.)/g, '$1') : value
}

/** The settings after a `SET`. A null value removes the name rather than
 *  storing the word — see `SettingChange`. */
export function applySettings(
  current: Readonly<Record<string, string>>,
  changes: readonly SettingChange[],
): Record<string, string> {
  const next = { ...current }
  for (const change of changes) {
    if (change.value === null) delete next[change.name]
    else next[change.name] = change.value
  }
  return next
}

/** What the console is carrying, as lines for the transcript. */
export function describeSettings(settings: Readonly<Record<string, string>>): string[] {
  const names = Object.keys(settings).sort()
  if (names.length === 0)
    return ['This console carries no settings of its own. `SET name = value` adds one.']
  return [
    `Carried on every statement from this console — and nowhere else in Flint:`,
    ...names.map((name) => `  ${name} = ${settings[name] ?? ''}`),
    '`SET name = DEFAULT` drops one, `reset` drops them all.',
  ]
}

/** The answer to `help`. Kept here rather than in the component so it is one
 *  thing to keep true as the console grows keys. */
export const HELP: string[] = [
  'This is a prompt on ClickHouse — SQL goes straight to the server, as the account you signed in as.',
  'Several statements separated by semicolons run in turn, and stop at the first that fails.',
  '',
  '  Enter          run the statement',
  '  Shift+Enter    a new line instead',
  '  ↑ / ↓          walk back through what you have run',
  '  Tab            take the highlighted completion',
  '  Ctrl+C         cancel the statement that is running',
  '  Ctrl+L         empty the transcript',
  '  Ctrl+`         hide the console — it keeps everything',
  '',
  '  use <database> resolve unqualified names somewhere else',
  '  set a = b      carry a setting on every statement from here',
  '  set            say which settings are being carried',
  '  reset          stop carrying all of them',
  '  clear          empty the transcript',
  '  exit           the same as hiding it',
]

/* ── More than one statement ─────────────────────────────────────────────── */

/** A pasted block, split into the statements it holds.
 *
 *  Pasting three statements separated by semicolons is the most ordinary thing
 *  anybody does in a console, and ClickHouse's HTTP interface takes exactly one
 *  per request — so the split happens here and the console runs them in turn,
 *  stopping at the first that fails. Stopping is deliberate: a script is
 *  usually a sequence where the second statement assumed the first one worked.
 *
 *  Quotes and comments are respected, because the semicolon that matters is
 *  never the one inside `'a;b'` or after `--`. */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let start = 0
  let quote: string | null = null
  let comment: 'line' | 'block' | null = null

  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i]
    const next = sql[i + 1]

    if (comment === 'line') {
      if (c === '\n') comment = null
      continue
    }
    if (comment === 'block') {
      if (c === '*' && next === '/') {
        comment = null
        i += 1
      }
      continue
    }
    if (quote) {
      // ClickHouse escapes with a backslash inside a literal, and doubles the
      // quote character inside an identifier. Both end up skipping one char.
      if (c === '\\') i += 1
      else if (c === quote) quote = null
      continue
    }

    if (c === '-' && next === '-') comment = 'line'
    else if (c === '/' && next === '*') comment = 'block'
    else if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === ';') {
      out.push(sql.slice(start, i))
      start = i + 1
    }
  }
  out.push(sql.slice(start))
  return out.map((piece) => piece.trim()).filter((piece) => piece.length > 0)
}

/* ── The printed table ───────────────────────────────────────────────────── */

/** No single cell may be wider than this. One 4 KB JSON blob would otherwise
 *  set the width of the whole table and push every other column off the right,
 *  which is the same failure the grid caps for the same reason. */
const CELL_CAP = 60

export interface PrintedCell {
  /** Already padded to the column's width, so the component does no arithmetic
   *  and the alignment is something a test can assert on. */
  text: string
  kind: CellKind
}

/** One column name, as it sits *inside* the top rule. ClickHouse pads the name
 *  with the rule's own dashes — `┌─name────┬────rows─┐` — and puts them on the
 *  left for a number, so the header lines up with the digits under it. */
export interface PrintedHead {
  before: string
  name: string
  after: string
}

export interface Printed {
  head: PrintedHead[]
  body: PrintedCell[][]
  /** The bottom rule, whole: nothing in it wants its own colour. */
  bottom: string
  widths: number[]
}

function shown(value: unknown): { text: string; kind: CellKind } {
  const { text, kind } = cellText(value)
  const flat = text.replace(/\n/g, '⏎')
  if (flat.length <= CELL_CAP) return { text: flat, kind }
  return { text: `${flat.slice(0, CELL_CAP - 1)}…`, kind }
}

/** A result, as `clickhouse-client` would have printed it. */
export function print(
  columns: readonly { name: string; type: string }[],
  rows: readonly unknown[][],
): Printed {
  /* Measured column by column rather than row by row, because every decision
     about a cell — its width, its alignment, the dashes around its name — is a
     property of the column it is in. */
  const measured = columns.map((column, i) => {
    const right = isNumeric(column.type)
    const cells = rows.map((row) => shown(row[i]))
    const width = cells.reduce((w, cell) => Math.max(w, cell.text.length), column.name.length)
    return { column, right, cells, width }
  })

  const head = measured.map(({ column, right, width }) => {
    const fill = '─'.repeat(width - column.name.length + 1)
    // A number's dashes go in front of its name, so `rows` sits over the last
    // digit of the count rather than over the first.
    return right
      ? { before: fill, name: column.name, after: '─' }
      : { before: '─', name: column.name, after: fill }
  })

  const body = rows.map((_, r) =>
    measured.map(({ cells, right, width }) => {
      const cell = cells[r] ?? { text: '', kind: 'value' as CellKind }
      return {
        text: right ? cell.text.padStart(width) : cell.text.padEnd(width),
        kind: cell.kind,
      }
    }),
  )

  const widths = measured.map(({ width }) => width)
  const bottom = `└─${widths.map((w) => '─'.repeat(w)).join('─┴─')}─┘`
  return { head, body, bottom, widths }
}

/** The whole table as plain text, for the clipboard.
 *
 *  Selecting the transcript with the mouse already copies something reasonable,
 *  but it copies whatever the selection happened to cross. This is the button's
 *  version: the same box somebody is looking at, exactly. */
export function asText(printed: Printed): string {
  const top = `┌${printed.head.map((h) => `${h.before}${h.name}${h.after}`).join('┬')}┐`
  const rows = printed.body.map((row) => `│ ${row.map((c) => c.text).join(' │ ')} │`)
  return [top, ...rows, printed.bottom].join('\n')
}

/** The rows, as a spreadsheet wants them: tab-separated, NULL as a blank
 *  field — the same bargain `grid.rawText` already struck for the grid. */
export function asTsv(columns: readonly { name: string }[], rows: readonly unknown[][]): string {
  const head = columns.map((c) => c.name).join('\t')
  const body = rows.map((row) =>
    row
      .map((value) =>
        value === null || value === undefined
          ? ''
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value),
      )
      .join('\t'),
  )
  return [head, ...body].join('\n')
}

/* ── What the statement cost ─────────────────────────────────────────────── */

export interface Summary {
  /** The line under the table. Always true, always short. */
  line: string
  /** What was left out, or null when nothing was. Its own field rather than
   *  more words on `line`, because it is the sentence that must not be missed
   *  and it gets its own colour for that reason. */
  capped: string | null
}

/** The status line, in the house rule: every cap states its own count.
 *
 *  `truncated` means Flint stopped reading, not that ClickHouse stopped
 *  producing — so the sentence says how many are on screen *and* the floor the
 *  server put under the total, and never implies the two are the same number. */
export function summarise(result: QueryResult): Summary {
  const elapsed = duration(result.statistics.elapsed)
  const read =
    result.statistics.rows_read > 0
      ? ` · read ${exact(result.statistics.rows_read)} rows, ${bytes(result.statistics.bytes_read)}`
      : ''

  if (result.kind === 'command') return { line: `Ok. ${elapsed}${read}`, capped: null }

  const n = result.rows.length
  const rows = n === 1 ? '1 row' : `${exact(n)} rows`
  const line = `${rows} in set · ${elapsed}${read}`
  if (!result.truncated) return { line, capped: null }

  const floor = result.rows_before_limit_at_least
  const capped =
    floor && floor > n
      ? `Showing ${exact(n)} of at least ${exact(floor)} — add a LIMIT, or open it in the editor.`
      : `Showing the first ${exact(n)} — add a LIMIT, or open it in the editor.`
  return { line, capped }
}

/* ── What went wrong ─────────────────────────────────────────────────────── */

/** Where a ClickHouse error stops being an answer and starts being a grammar.
 *
 *  A syntax error from ClickHouse is two sentences and then eight hundred
 *  words: `Expected one of:` followed by every token the parser would have
 *  accepted, which on a 26.x server is most of the language. Printed in full it
 *  is twelve red lines that bury the one line saying *where* the statement went
 *  wrong — which is the whole of what the reader needs.
 *
 *  So the head is shown and the rest is offered. Not dropped: it is genuinely
 *  useful about one time in twenty, and a console that silently shortens what
 *  the server said is a console you cannot trust when it matters. */
const NOISE = /\s*(Expected one of:|Stack trace:)/

export function splitError(message: string): { head: string; rest: string | null } {
  const at = message.search(NOISE)
  if (at === -1) return { head: message.trim(), rest: null }
  const head = message.slice(0, at).trim()
  // Nothing before the noise: better the whole wall than an empty error.
  if (!head) return { head: message.trim(), rest: null }
  return { head, rest: message.slice(at).trim() }
}

/** The one line a screen reader should hear when something settles.
 *
 *  The transcript is a `log` region and is not announced as it grows — a table
 *  read out cell by cell is not an answer. So one sentence is, and it has to
 *  cover *every* outcome rather than only the happy one: an error, a
 *  cancellation and the console's own reply are exactly the results somebody
 *  who cannot see the drawer most needs told about, and announcing only the
 *  successes leaves a failed statement completely silent.
 *
 *  An error is announced by its head, not its grammar — see `splitError`. */
export function announce(entries: readonly Entry[]): string {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (!entry || entry.state === 'running') continue
    if (entry.state === 'note') return entry.note?.find((line) => line.trim()) ?? ''
    if (entry.state === 'cancelled') return 'Cancelled.'
    if (entry.state === 'error') return splitError(entry.error ?? '').head
    if (entry.result) {
      const said = summarise(entry.result)
      return said.capped ? `${said.line}. ${said.capped}` : said.line
    }
  }
  return ''
}

/** Which of the carried settings this failure is plausibly about.
 *
 *  The line under an error used to name *everything* the console was holding,
 *  on the reasoning that a poisoned console's second failure looks nothing like
 *  its cause. True — but on a read-only deployment a refused `CREATE TABLE`
 *  came back accused of `max_threads`, which is the same fault inverted:
 *  instead of hiding a cause it invents one, and a false lead costs more than
 *  no lead.
 *
 *  So two things have to hold before a setting is offered as the suspect. The
 *  message has to be *about* a setting — every ClickHouse error that is says so
 *  in the word — and it has to name one the console is actually carrying. That
 *  keeps `Setting x is neither a builtin setting…` and drops `Cannot execute
 *  query in readonly mode`, which is the whole distinction. */
export function blame(message: string, carried: readonly string[]): string[] {
  if (!/\bsettings?\b/i.test(message)) return []
  return carried.filter((name) => new RegExp(`\\b${escapeName(name)}\\b`).test(message))
}

/** A ClickHouse setting name is `[A-Za-z_][A-Za-z0-9_]*`, so there is nothing
 *  to escape — but the name arrives from a `SET` somebody typed, and building a
 *  regexp out of unescaped input is a habit worth not having. */
function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/* ── History ─────────────────────────────────────────────────────────────── */

/** How many statements the console remembers between reloads. Two hundred is
 *  about a week of the way people actually use one of these, and small enough
 *  that it never becomes a reason localStorage fills up. */
export const HISTORY_CAP = 200

/** Newest last, no immediate repeats — pressing Enter twice on the same
 *  statement should not cost two presses of Up to walk past. */
export function remember(history: readonly string[], sql: string): string[] {
  const line = sql.trim()
  if (!line) return [...history]
  if (history[history.length - 1] === line) return [...history]
  const next = [...history, line]
  return next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next
}

/** Where Up and Down land.
 *
 *  `index` counts back from the end: 0 is the newest, and `null` is "not in the
 *  history, editing the live line". Walking down off the end returns to `null`
 *  with an empty string, which is what restores the prompt somebody was in the
 *  middle of typing — the caller keeps the draft; this only says where to go. */
export function recall(
  history: readonly string[],
  index: number | null,
  direction: -1 | 1,
): { index: number | null; sql: string | null } {
  if (history.length === 0) return { index, sql: null }
  // Down from the live line is not a move. Returning an empty string here
  // would wipe the half-written statement of anybody who pressed the wrong
  // arrow, which is the one thing a history must never do.
  if (index === null && direction === 1) return { index: null, sql: null }
  // Up is "further back", which is a *larger* index into a list counted from
  // the end. The sign flip lives here so no caller has to remember it.
  const next = index === null ? 0 : index - direction
  if (next < 0) return { index: null, sql: '' }
  if (next >= history.length) return { index: history.length - 1, sql: history[0] ?? null }
  return { index: next, sql: history[history.length - 1 - next] ?? null }
}

/** The database the page behind the console is about, if it is about one.
 *
 *  The console follows the page you are reading until you tell it not to. A
 *  prompt that resolves unqualified names in a database *other* than the one
 *  whose tables are listed six inches to the left is the kind of trap that
 *  costs somebody an afternoon — so the default is "here", and `use` is how you
 *  pin it somewhere else deliberately. */
export function databaseInPath(pathname: string): string | null {
  const match = /^\/db\/([^/]+)/.exec(pathname)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

/* ── The prompt's own state ──────────────────────────────────────────────── */

/** How tall the drawer may get, in pixels, given the window.
 *
 *  A floor so a drag cannot leave a console with nothing in it, and a ceiling
 *  short of the whole window because the point of the thing is that the page
 *  behind it is still there. */
export function clampHeight(height: number, viewport: number): number {
  const ceiling = Math.max(220, Math.round(viewport * 0.85))
  return Math.min(Math.max(Math.round(height), 180), ceiling)
}
