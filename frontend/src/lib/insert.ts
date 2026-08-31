/** Putting a name into a statement without spoiling the one that is there.
 *
 *  Clicking a table in the rail while the Query page is open should write SQL,
 *  not navigate away. The rule this file enforces is the conservative one: the
 *  click inserts at the caret and never overwrites. The only exception is a
 *  statement that is empty, where there is nothing to overwrite and a bare table
 *  name would be no use — so that one case gets a whole statement, which is what
 *  somebody clicking a table from an empty tab meant.
 *
 *  The spacing matters more than it looks. `SELECT ts, hostcount()` is what you
 *  get from an inserter that does not look at the character to its left, and it
 *  is the reason people stop using one. */

import { contextAt } from './complete'
import { quoteIdent } from './query'
import { statementBeing } from './sql'

export interface Insertion {
  /** The text to put in. */
  text: string
  /** The span it replaces — `from === to` for a plain insertion. */
  from: number
  to: number
  /** Where the caret should end up, as an offset into `text`. Defaults to its
   *  end. */
  caret?: number
}

/** Characters after which no space is wanted. */
const OPENS = new Set(['', ' ', '\n', '\t', '(', '.', ',', '`'])

function spacer(doc: string, pos: number): string {
  const before = pos > 0 ? (doc[pos - 1] ?? '') : ''
  return OPENS.has(before) ? '' : ' '
}

/** The name of a table as it should be written from here: unqualified when it
 *  is in the database the tab is already pointed at, because that is what
 *  anybody would type. */
export function tableName(
  ref: { database: string; table: string },
  currentDatabase: string | undefined,
): string {
  const table = quoteIdent(ref.table)
  return ref.database === currentDatabase ? table : `${quoteIdent(ref.database)}.${table}`
}

/** A whole first query, for an empty tab. `SELECT *` rather than a column list:
 *  the reader has not said what they want yet, and the grid is where they will
 *  say it. */
export function openingStatement(name: string): string {
  return `SELECT *\nFROM ${name}\nLIMIT 100`
}

/** What clicking a table should do to the document. */
export function tableInsertion(
  doc: string,
  pos: number,
  ref: { database: string; table: string },
  currentDatabase: string | undefined,
): Insertion {
  const name = tableName(ref, currentDatabase)
  const statement = statementBeing(doc, pos)
  if (!statement || !statement.sql.trim()) {
    // Replace the blank span rather than inserting into it, so a tab holding
    // three newlines does not end up with the statement three lines down. With
    // no statement at all — an empty tab, or the space after a semicolon — the
    // blank being replaced is whatever whitespace surrounds the caret.
    const from = statement?.start ?? blankStart(doc, pos)
    const to = statement?.end ?? blankEnd(doc, pos)
    return { text: openingStatement(name), from, to }
  }
  return { text: spacer(doc, pos) + name, from: pos, to: pos }
}

/** Whitespace either side of the caret, when there is no statement to speak of.
 *  Stops at a semicolon in both directions: the blank after `SELECT 1;` is not
 *  the semicolon's to give away. */
function blankStart(doc: string, pos: number): number {
  let at = pos
  while (at > 0 && /\s/.test(doc[at - 1] ?? '')) at -= 1
  // The whitespace after a semicolon is what separates two statements. Eating
  // it would run the new query onto the end of the old one.
  return at > 0 && doc[at - 1] === ';' ? pos : at
}

function blankEnd(doc: string, pos: number): number {
  let at = pos
  while (at < doc.length && /\s/.test(doc[at] ?? '')) at += 1
  return at
}

/** What clicking a column should do.
 *
 *  A comma is added when the caret is inside a list that already has an item in
 *  it — which is the difference between clicking four columns and getting a
 *  select list, and clicking four columns and getting a syntax error. The
 *  question of *where* the caret is is answered by `complete`, so the comma and
 *  the completion menu can never disagree about it. */
export function columnInsertion(doc: string, pos: number, column: string): Insertion {
  const name = quoteIdent(column)
  const ctx = contextAt(doc, pos)
  const inList = ctx.slot === 'select' || ctx.slot === 'groupBy' || ctx.slot === 'orderBy'
  // A caret sitting *inside* a word ends an item too — `SELECT ts|` is a list
  // with one item in it, even though completion would treat that word as the
  // one being typed.
  const closesItem = ctx.afterValue || ctx.word.text.length > 0
  if (inList && closesItem) return { text: `, ${name}`, from: pos, to: pos }
  return { text: spacer(doc, pos) + name, from: pos, to: pos }
}
