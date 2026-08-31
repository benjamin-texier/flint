/** The form for writing one row, derived from the table's own columns.
 *
 *  Every question this file answers is a question about a *declared type*, not
 *  about a value: which control a column gets, whether it may be left empty,
 *  what an enum's members are. That is the same discipline the chart suggester
 *  follows and for the same reason — a 64-bit integer arrives as a string, so
 *  the type is the only thing that can be reasoned about.
 *
 *  Nothing here formats a value into SQL. The strings this produces travel to
 *  the server as query parameters declared with the column's own type, and the
 *  server parses each one against the type it is about to store it in. So this
 *  file's job is to ask the right question, never to validate the answer: a
 *  browser-side check of what fits in a `Decimal(38,10)` would be a second,
 *  worse implementation of something ClickHouse already does exactly. */

import { unwrap } from './chType'

/** What a column needs from the person filling in the form. */
export type Control =
  /** A fixed set, from the type itself. */
  | 'enum'
  /** Two states and nothing else. */
  | 'bool'
  /** A single line. Everything that is not one of the above. */
  | 'text'
  /** Many lines: the types where a real value is routinely long. */
  | 'long'

export interface Column {
  name: string
  type: string
  default_kind: string
  default_expression: string
  comment: string
  nullable: boolean
}

export interface Field {
  column: Column
  control: Control
  /** An enum's members, in the order the type declares them. Empty otherwise. */
  members: string[]
  /** Whether leaving this alone is a real option — either the table computes a
   *  value for it or it accepts a null. */
  optional: boolean
  /** What happens if it is left alone, in words, or null where nothing can be
   *  said with certainty. */
  ifLeftAlone: string | null
}

/** Whether a value may be written into this column at all.
 *
 *  `MATERIALIZED` and `ALIAS` columns are there and are computed from the
 *  others, which is a different fact from being absent — and the server's two
 *  refusals say neither. Naming a materialized column in an insert answers
 *  *Cannot insert column c, because it is MATERIALIZED column*; naming an alias
 *  answers *No such column d in table*, as though it were not there at all.
 *  So the form leaves both out and says why, rather than offering a box that
 *  cannot work. */
export function writable(column: Column): boolean {
  return column.default_kind !== 'MATERIALIZED' && column.default_kind !== 'ALIAS'
}

/** An `Enum8('ok' = 1, 'bad' = 2)`'s members, in declaration order.
 *
 *  Read off the type because that is where they are: ClickHouse writes the
 *  whole set into `system.columns.type`, so a list needs no second query and
 *  cannot drift from the column it belongs to.
 *
 *  The quoting is the awkward part and it is real: a member may contain a
 *  comma, a bracket, or an escaped quote — `Enum8('a,b' = 1, 'it\'s' = 2)` is a
 *  legal type — so the members are matched as quoted strings rather than split
 *  on commas. */
export function enumMembers(type: string): string[] {
  const inner = /^Enum(?:8|16)?\((.*)\)$/s.exec(unwrap(type))
  if (!inner?.[1]) return []
  const out: string[] = []
  const re = /'((?:[^'\\]|\\.)*)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(inner[1])) !== null) {
    out.push((m[1] ?? '').replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
  }
  return out
}

/** The types where a real value is routinely longer than a line.
 *
 *  `String` is deliberately not among them, and that was measured by looking at
 *  a form rather than reasoned: it is ClickHouse's *only* string type, so it
 *  holds an email address as often as it holds a JSON blob, and giving every
 *  one of them a textarea turned an eight-column table into a page of boxes.
 *  What is left are the types that are structured by definition — a `Map` or a
 *  `Tuple` written on one line is unreadable however short it is. */
const LONG = /^(JSON|Object|Array|Map|Tuple|Nested|Variant|Dynamic)/

/** Which control a column gets. */
export function controlFor(type: string): Control {
  const bare = unwrap(type)
  if (/^Enum(8|16)?\(/.test(bare)) return 'enum'
  if (/^Bool$/.test(bare)) return 'bool'
  if (LONG.test(bare)) return 'long'
  return 'text'
}

/** Whether the declared type accepts a null.
 *
 *  Read off the type rather than trusted from `ColumnDetail.nullable`, so the
 *  answer is right for a `LowCardinality(Nullable(String))` — where the
 *  wrapper is on the inside and a naive prefix test says no. */
export function nullable(type: string): boolean {
  return /\bNullable\(/.test(type)
}

/** The form, in the order the table declares its columns.
 *
 *  Declaration order and not, say, keys first: this is the shape somebody
 *  already has in their head from the Columns tab, and re-ordering the same
 *  list differently in two places is how a reader loses track of which table
 *  they are looking at. */
export function fieldsFor(columns: Column[]): Field[] {
  return columns.filter(writable).map((column) => {
    const isNull = nullable(column.type)
    const hasDefault = column.default_kind === 'DEFAULT'
    return {
      column,
      control: controlFor(column.type),
      members: enumMembers(column.type),
      optional: isNull || hasDefault,
      ifLeftAlone: hasDefault
        ? `the table writes ${column.default_expression}`
        : isNull
          ? 'the row gets a null'
          : /* Not "the type's zero", which is what ClickHouse will in fact
               write: `''` for a String, `0` for a UInt8, the epoch for a
               DateTime. Saying so would be true and would read as a promise
               Flint is making, when it is the engine's behaviour and differs
               per type. The form asks for a value instead. */
            null,
    }
  })
}

/** The columns the form is not offering, and why — one sentence, or null where
 *  there are none.
 *
 *  Said rather than silently dropped, on the same rule as every other fold in
 *  the product: a form showing nine of a table's eleven columns, with nothing
 *  saying so, reads as a form that has lost two. */
export function saysComputed(columns: Column[]): string | null {
  const computed = columns.filter((c) => !writable(c))
  if (computed.length === 0) return null
  const names = computed.map((c) => `\`${c.name}\``).join(', ')
  return `${names} ${computed.length === 1 ? 'is' : 'are'} computed by the server from the other columns, so ${
    computed.length === 1 ? 'it is' : 'they are'
  } not written with the row.`
}

/** What a filled-in form sends.
 *
 *  Three states per column, and they have to stay three: a value, an explicit
 *  null, and *not mentioned at all*. The last is what makes a `DEFAULT` apply,
 *  and it is why "leave alone" cannot be a magic string — any string that meant
 *  *default* would be a string somebody might have meant to store.
 *
 *  And an empty box is an empty string, not a null. Measured against a server
 *  rather than assumed: binding `''` to a `Nullable(String)` stores a
 *  zero-length string and `IS NULL` comes back false. Two different answers, so
 *  the form has two different ways to ask for them. */
export type Entry = { kind: 'value'; text: string } | { kind: 'null' } | { kind: 'default' }

export interface Payload {
  column: string
  value: string | null
}

export function payload(fields: Field[], entries: Record<string, Entry>): Payload[] {
  const out: Payload[] = []
  for (const field of fields) {
    const entry = entries[field.column.name] ?? { kind: 'default' }
    if (entry.kind === 'default') continue
    out.push({ column: field.column.name, value: entry.kind === 'null' ? null : entry.text })
  }
  return out
}

/** What the table will fill in, said before the button rather than reported
 *  after it. A row that comes back holding three columns nobody typed is a row
 *  somebody wanted to have been warned about first.
 *
 *  A string with backticks in it, rendered by `Sentence` — which is the
 *  convention the whole codebase writes in, and the one that keeps the wording
 *  assertable in a test. Building the list as JSX instead put literal
 *  backticks on the screen, which by `Note.tsx`'s own account is now the third
 *  time that has shipped. */
export function saysDefaulting(fields: Field[], entries: Record<string, Entry>): string | null {
  const left = willDefault(fields, entries)
  if (left.length === 0) return null
  const names = left.map((n) => `\`${n}\``).join(', ')
  return `${left.length} of ${fields.length} ${
    left.length === 1 ? 'column is' : 'columns are'
  } left to the table: ${names}.`
}

/** What the server reported after the write. Its answer and not the form's:
 *  the route read the table's own columns at the moment of writing, and that
 *  is the list that is actually true of the row now on disk. */
export function saysWritten(defaulted: string[]): string {
  if (defaulted.length === 0) return 'Written.'
  const names = defaulted.map((n) => `\`${n}\``).join(', ')
  return `Written. The table filled in ${names}.`
}

export function willDefault(fields: Field[], entries: Record<string, Entry>): string[] {
  return fields
    .filter((f) => (entries[f.column.name] ?? { kind: 'default' }).kind === 'default')
    .map((f) => f.column.name)
}
