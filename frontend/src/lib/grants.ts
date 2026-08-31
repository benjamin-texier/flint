/** What the person at the keyboard may see.
 *
 *  Read-only, and in Data on purpose: the question is asked by somebody whose
 *  database is missing from the list, not by whoever arranges access. Managing
 *  it stays in Infrastructure.
 */

export interface Grant {
  what: string
  on: string
  revoked: boolean
  grantable: boolean
  statement: string
  direct: boolean
  via: string[]
}

export interface MyGrants {
  user: string
  roles: string[]
  grants: Grant[]
  revokes: Grant[]
  partial?: string
}

/** How many privileges one grant line actually carries.
 *
 *  A full-access user's line is one statement listing fifty of them —
 *  `CHECK, SHOW, SELECT, INSERT, … ON *.*` — and the parentheses of a
 *  column-level grant hold commas that are not separators:
 *  `SELECT(event_time, query_duration_ms)` is one privilege, not two. */
export function privileges(what: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const c of what) {
    if (c === '(') depth += 1
    if (c === ')') depth -= 1
    if (c === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += c
  }
  if (current.trim()) out.push(current.trim())
  return out
}

/** How many to show before folding, and why this many.
 *
 *  Enough that an ordinary grant is never folded, few enough that the
 *  full-access line does not become the page. */
const SHOWN = 6

/** The privileges a row shows, and what it says about the ones it does not.
 *
 *  A truncated list that does not say it was truncated reads as the whole
 *  truth, and here that means somebody believing they hold six privileges when
 *  the server gave them fifty. */
export function foldPrivileges(what: string): { shown: string[]; hidden: number } {
  const all = privileges(what)
  if (all.length <= SHOWN) return { shown: all, hidden: 0 }
  return { shown: all.slice(0, SHOWN), hidden: all.length - SHOWN }
}

/** Where a grant came from, as a phrase.
 *
 *  Returns null for the ordinary case — granted directly, nothing to explain.
 *  A privilege held by two paths says both, because losing one of them is the
 *  event that makes somebody ask. */
export function saysVia(g: Grant): string | null {
  if (!g.via.length) return null
  const roles = g.via.join(', ')
  return g.direct ? `directly, and through ${roles}` : `through ${roles}`
}

/** The one-line summary above the list.
 *
 *  Every number in it is counted off the list below rather than reported
 *  separately, so the header and the table cannot disagree. */
export function saysGrants(mine: MyGrants): string {
  // Short on purpose. The explaining is done once, below, by the note that
  // fills the space where the table would be — saying it in both places makes
  // the reader check whether the two sentences differ.
  if (!mine.grants.length && !mine.revokes.length) return 'nothing granted.'

  const parts = [`${mine.grants.length} ${mine.grants.length === 1 ? 'grant' : 'grants'}`]
  if (mine.roles.length) {
    parts.push(`${mine.roles.length === 1 ? 'a role' : `${mine.roles.length} roles`} switched on`)
  }
  if (mine.revokes.length) {
    parts.push(`${mine.revokes.length} taken back`)
  }
  let says = `${parts.join(', ')}.`
  // Once, rather than on every row. A full-access user has it on all six of
  // theirs, and six copies of one sentence is a column of wallpaper — the same
  // lesson the distributed DDL ledger had to learn about exceptions.
  if (mine.grants.length > 1 && mine.grants.every((g) => g.grantable)) {
    says += ' Every one of them can be passed on to somebody else.'
  }
  return says
}

/** Whether the column explaining *how* a grant arrived has anything to say.
 *
 *  It is empty for the ordinary user — granted directly, not passable on — and
 *  a column that is blank in every row is furniture. It also goes quiet when
 *  every grant is grantable, because the summary line says that once instead. */
export function showsHow(grants: Grant[]): boolean {
  const allGrantable = grants.length > 1 && grants.every((g) => g.grantable)
  return grants.some((g) => saysVia(g) !== null || (g.grantable && !allGrantable))
}
