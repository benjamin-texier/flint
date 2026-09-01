/** The first question, offered rather than waited for.
 *
 *  A query page with nothing on it is a blank editor and a caret, and a blank
 *  editor is the moment somebody decides to go back to the terminal. Everything
 *  needed to ask the four questions almost every read of a new table starts with
 *  is already on screen — the table, its columns, their types — so the empty
 *  state offers them instead of describing a keyboard shortcut.
 *
 *  Two rules hold this honest, and both are the reason it is a pure function
 *  with a test rather than four template strings in a component:
 *
 *  - **Only questions the columns can answer.** No hour buckets on a table with
 *    no timestamp, no commonest-value on a table of Float64s. An offer that
 *    fails on click teaches somebody not to click the next one.
 *  - **The words say what the SQL does.** `LIMIT 100` with no ORDER BY is *a
 *    hundred rows*, never "the first hundred" — the server hands back whichever
 *    blocks it reached first, and calling that a prefix is a lie the reader
 *    cannot see through. See `docs/features.md` on sampling.
 *
 *  Each opener carries its own SQL. Nothing here runs anything: the caller puts
 *  the statement in the tab and runs it, so what happens on click is exactly
 *  what happens when somebody types the same thing.
 */

import { family, isTemporal } from './chType'
import { literal, quoteIdent } from './query'

export interface Column {
  name: string
  type: string
}

export interface Opener {
  /** Stable across renders, so React can key on it. */
  id: string
  /** The question in words. Sentence case, no full stop — it is a title. */
  title: string
  /** Why this one is worth a click, or what it will cost. Kept to a clause. */
  note: string
  sql: string
}

/** How a table is addressed in a generated statement. The database is included
 *  whenever it is known: a statement that only works while the tab happens to
 *  be pointed at the right database is a statement nobody can paste. */
function ref(database: string | undefined, table: string): string {
  return database ? `${quoteIdent(database)}.${quoteIdent(table)}` : quoteIdent(table)
}

/** The column to bucket time by: the first temporal one, preferring one the
 *  table is sorted by — reading an hour histogram off the sorting key is the
 *  difference between a granule scan and a full one, and this page is where
 *  people learn that. */
function timeColumn(columns: Column[], sortingKey: string[]): Column | undefined {
  const temporal = columns.filter((c) => isTemporal(c.type))
  return temporal.find((c) => sortingKey.includes(c.name)) ?? temporal[0]
}

/** The column whose commonest values are worth counting: a `LowCardinality`
 *  first, because the type is the table's own statement that the values repeat.
 *  Failing that, any string — a grouping over a wide unique column is a slow way
 *  to learn that every value occurs once, so it is offered last and only when
 *  there is nothing better. */
function groupColumn(columns: Column[]): Column | undefined {
  const strings = columns.filter((c) => family(c.type) === 'string')
  return strings.find((c) => /LowCardinality|Enum/.test(c.type)) ?? strings[0]
}

/** What to offer when there is no table yet — a blank SQL tab, which is the
 *  state this page opens in.
 *
 *  Two statements, and they are the two people actually type into a fresh
 *  console: what is in here, and what is running. Both read `system` and need no
 *  subject, so neither can be offered and then fail. They are also the two that
 *  teach the system tables, which is the only reason a query page beats a
 *  dashboard: you can ask the server about itself.
 *
 *  Flint has pages that answer both better — the explorer, Diagnostics — and
 *  that is not an argument for hiding them here. The tab is empty; the choice is
 *  between a statement to press and a paragraph about a keyboard shortcut. */
export function serverOpeners(database: string | undefined): Opener[] {
  const scope = database ? ` in ${database}` : ''
  const where = database ? `WHERE database = ${literal(database, 'String')}` : `WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')`
  return [
    {
      id: 'objects',
      title: `What is${scope}`,
      note: 'the objects and what they weigh, biggest first',
      sql:
        'SELECT name, engine, total_rows AS rows, formatReadableSize(total_bytes) AS size\n' +
        `FROM system.tables\n${where}\nORDER BY total_bytes DESC\nLIMIT 40`,
    },
    {
      id: 'running',
      title: 'What is running right now',
      note: 'every query in flight on this server, longest first',
      sql:
        'SELECT elapsed, formatReadableSize(memory_usage) AS memory, user, query\n' +
        'FROM system.processes\nORDER BY elapsed DESC',
    },
  ]
}

/** What to offer for one table. Ordered cheapest-first, because the order is
 *  also the order somebody meeting a table should ask in. */
export function openers(
  database: string | undefined,
  table: string,
  columns: Column[],
  sortingKey: string[] = [],
): Opener[] {
  if (!table || columns.length === 0) return []
  const from = ref(database, table)
  const out: Opener[] = [
    {
      id: 'rows',
      title: 'How many rows',
      note: 'reads the counts, not the rows',
      sql: `SELECT count() AS rows FROM ${from}`,
    },
    {
      id: 'peek',
      title: 'A hundred rows of it',
      // Not "the first hundred": with no ORDER BY the server returns whichever
      // blocks it reached first, and every one of them is as arbitrary as the
      // next.
      note: 'a hundred rows, whichever the server reaches first',
      sql: `SELECT *\nFROM ${from}\nLIMIT 100`,
    },
  ]

  const when = timeColumn(columns, sortingKey)
  if (when) {
    out.push({
      id: 'over-time',
      title: `Rows by the hour, on ${when.name}`,
      note: sortingKey.includes(when.name)
        ? `${when.name} is in the sorting key, so this reads a slice`
        : `${when.name} is not in the sorting key — this reads the column whole`,
      sql:
        `SELECT toStartOfHour(${quoteIdent(when.name)}) AS hour, count() AS rows\n` +
        `FROM ${from}\nGROUP BY hour\nORDER BY hour DESC\nLIMIT 48`,
    })
  }

  const by = groupColumn(columns)
  if (by) {
    out.push({
      id: 'commonest',
      title: `The commonest ${by.name}`,
      note: 'groups the whole column',
      sql:
        `SELECT ${quoteIdent(by.name)}, count() AS rows\n` +
        `FROM ${from}\nGROUP BY ${quoteIdent(by.name)}\nORDER BY rows DESC\nLIMIT 20`,
    })
  }

  return out
}
