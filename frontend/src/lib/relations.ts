/** What one column of a table says about another.
 *
 *  The profile answers questions about a column alone. This is the next question
 *  and the one nobody types, because you have to already suspect the answer to
 *  ask it: *which of these columns are saying the same thing twice*.
 *
 *  Everything here is pure so the sentences can be tested without a DOM — and
 *  they need testing, because a finding stated badly is worse than none. "`a`
 *  determines `b`" is a phrase from a database course; what somebody wants to
 *  read is what it means for their table. */

import { compact } from './chart'

export type Kind =
  | 'constant'
  | 'determines'
  | 'mirrors'
  | 'moves-with'
  | 'correlates'
  | 'far-values'
  | 'dominant'

export interface Finding {
  kind: Kind
  a: string
  a_distinct: number
  b?: string
  b_distinct?: number
  /** The single value, for a constant. Absent where that value is NULL. */
  value?: string
  /** Pearson's r, signed, for the two correlation kinds. */
  r?: number
  /** Rows both columns were present in — below the table's own count wherever
   *  either is nullable, since a correlation is taken over the pairs that
   *  exist. */
  compared?: number
  /** For a column with far values: how many sit beyond each fence, where the
   *  fences are, how far the column actually reaches, and the quarters the
   *  fences were drawn from. Every figure, because "there are outliers" is a
   *  claim and these are what let somebody judge it. */
  above?: number
  below?: number
  fence_high?: number
  fence_low?: number
  high?: number
  low?: number
  q1?: number
  q3?: number
  /** For a dominant value: how many rows carry it. The value itself is in
   *  `value`, as a constant's is. */
  covering?: number
}

export interface Relations {
  available: boolean
  reason?: string
  rows: number
  findings: Finding[]
  columns: number
  considered: number
  /** Numeric columns compared against each other. */
  numeric: number
  skipped_constant: number
  skipped_unique: number
  capped: boolean
}

/** Several columns that are all the same information.
 *
 *  Mirroring is transitive — if `a` mirrors `b` and `b` mirrors `c` then all
 *  three are one — so a group of four columns arrives from the server as six
 *  separate pairs. Reported that way it is six lines saying one thing, and on a
 *  wide system table that alone was nine of the first ten findings. */
export interface MirrorGroup {
  kind: 'mirror-group'
  columns: string[]
  distinct: number
}

export type Item = Finding | MirrorGroup

export function isGroup(item: Item): item is MirrorGroup {
  return item.kind === 'mirror-group'
}

/** Fold mirror pairs into groups, leaving every other finding as it was.
 *
 *  Order is kept: a group takes the place of the first of its pairs, so the
 *  server's ranking still decides what is read first. */
export function group(findings: readonly Finding[]): Item[] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    const up = parent.get(x)
    if (up === undefined || up === x) return x
    const root = find(up)
    parent.set(x, root)
    return root
  }
  const union = (x: string, y: string) => {
    if (!parent.has(x)) parent.set(x, x)
    if (!parent.has(y)) parent.set(y, y)
    parent.set(find(x), find(y))
  }
  for (const f of findings) {
    if (f.kind === 'mirrors' && f.b) union(f.a, f.b)
  }

  const members = new Map<string, string[]>()
  const distinct = new Map<string, number>()
  for (const f of findings) {
    if (f.kind !== 'mirrors' || !f.b) continue
    const root = find(f.a)
    const list = members.get(root) ?? []
    for (const name of [f.a, f.b]) if (!list.includes(name)) list.push(name)
    members.set(root, list)
    distinct.set(root, f.a_distinct)
  }

  const emitted = new Set<string>()
  const out: Item[] = []
  for (const f of findings) {
    if (f.kind !== 'mirrors' || !f.b) {
      out.push(f)
      continue
    }
    const root = find(f.a)
    if (emitted.has(root)) continue
    emitted.add(root)
    const columns = members.get(root) ?? [f.a, f.b]
    out.push(
      columns.length > 2
        ? { kind: 'mirror-group', columns, distinct: distinct.get(root) ?? f.a_distinct }
        : f,
    )
  }
  return out
}

/** How many findings are listed in all before the rest are counted instead.
 *
 *  A wide table produces dozens: `system.parts` measured forty-eight, and a page
 *  of them is a page nobody reads to the end. */
export const SHOW = 24

/** How many of any one kind are listed before the rest are counted instead.
 *
 *  A single ranked list is the house rule everywhere else, and here it fails: a
 *  table of sixteen numeric columns produces twenty-odd correlations, and on
 *  `system.parts` they filled every slot — the far-value findings, rarer and
 *  more interesting, never appeared at all. So each family gets a share and the
 *  caption counts what it did not show. */
export const PER_KIND = 6

/** The findings to list: the strongest of each kind, in the server's own order,
 *  up to the totals. */
export function shortlist(items: readonly Item[], perKind = PER_KIND, total = SHOW): Item[] {
  const seen = new Map<string, number>()
  const out: Item[] = []
  for (const item of items) {
    // A mirror group is the same family as a mirror pair: both say "these are
    // one thing", and a table with several of each should not spend two
    // allowances on one idea.
    const family = item.kind === 'mirror-group' ? 'mirrors' : item.kind
    const used = seen.get(family) ?? 0
    if (used >= perKind) continue
    seen.set(family, used + 1)
    out.push(item)
    if (out.length >= total) break
  }
  return out
}

/** What a group says, *after* its first column — which the caller sets in code,
 *  exactly as it does for a single finding. Returning the whole sentence and
 *  having the component slice the first name back off is what produced
 *  "active visible, removal_tid and removal_csn" on a real table: the comma went
 *  with the slice.
 *
 *  A pair keeps the two-column sentence — "and" reads better than a list of two
 *  — so a group is only ever three columns or more. */
export function saysGroup(g: MirrorGroup): string {
  const [, ...others] = g.columns
  const [last, ...rest] = [...others].reverse()
  const names = rest.length ? `${rest.reverse().join(', ')} and ${last}` : `and ${last}`
  return `, ${names} are all the same information — ${g.distinct} values each, paired one to one`
}



/** What a finding says, in the terms of the table it is about.
 *
 *  Each carries its own counts, because the counts are what make it credible: a
 *  reader who is told two columns mirror each other wants to see that it is
 *  three values against three, not a claim to take on faith. */
export function says(f: Finding, rows?: number): string {
  if (f.kind === 'constant') {
    return f.value === undefined
      ? 'holds NULL in every row'
      : `holds one value in every row: ${f.value}`
  }
  if (f.kind === 'mirrors') {
    return `and ${f.b} are the same information twice — ${f.a_distinct} values each, paired one to one`
  }
  if (f.kind === 'moves-with' || f.kind === 'correlates') {
    /* The sign carries as much as the number: two columns that move opposite
       each other are as related as two that move together, and "correlated" on
       its own hides which. */
    const r = f.r ?? 0
    const how =
      f.kind === 'moves-with'
        ? r > 0
          ? `and ${f.b} move as one line`
          : `and ${f.b} are one line, inverted`
        : r > 0
          ? `and ${f.b} move together`
          : `and ${f.b} move opposite each other`
    /* The row count only where it differs from the table's. A correlation skips
       a row where either side is NULL, and a figure drawn from fewer rows than
       the reader was told about should say so — but repeating the same number
       under every finding is noise. */
    const over =
      f.compared !== undefined && rows !== undefined && f.compared < rows
        ? `, over the ${f.compared.toLocaleString('en-US')} ${plural(f.compared, 'row')} where both are present`
        : ''
    return `${how} — r ${signed(r)}${over}`
  }
  if (f.kind === 'dominant') {
    const share = rows && f.covering ? Math.round((f.covering / rows) * 100) : null
    const of = f.covering
      ? ` — ${f.covering.toLocaleString('en-US')} of the rows carry it`
      : ''
    return share !== null
      ? `is ${f.value} in ${share}% of rows${of}`
      : `is ${f.value} in most rows${of}`
  }
  if (f.kind === 'far-values') {
    /* No unit is knowable here — the column may be seconds, bytes or a count —
       so the figures are printed as figures and the reader supplies the meaning.
       The quarters are given because a fence without the distribution it was
       drawn from is a number nobody can argue with. */
    const ends: string[] = []
    if (f.above) {
      ends.push(
        `${f.above.toLocaleString('en-US')} ${plural(f.above, 'row')} above ${compact(f.fence_high ?? 0)}, reaching ${compact(f.high ?? 0)}`,
      )
    }
    if (f.below) {
      ends.push(
        `${f.below.toLocaleString('en-US')} ${plural(f.below, 'row')} below ${compact(f.fence_low ?? 0)}, down to ${compact(f.low ?? 0)}`,
      )
    }
    const middle =
      f.q1 !== undefined && f.q3 !== undefined
        ? `, where the middle half of the rows sits between ${compact(f.q1)} and ${compact(f.q3)}`
        : ''
    return `reaches far past the rest of itself: ${ends.join(' and ')}${middle}`
  }
  return `fixes ${f.b}: ${f.a_distinct} ${plural(f.a_distinct, 'value')} of it, and each one always has the same ${f.b}`
}

/** Two decimals and always a sign: `+0.98` and `−0.98` are different findings
 *  and an unsigned one is neither. The minus is the typographic one, as
 *  everywhere else here. */
function signed(r: number): string {
  const at = Math.abs(r).toFixed(2)
  return r < 0 ? `\u2212${at}` : `+${at}`
}

/** What to do about it, where there is something to do. Kept apart from what was
 *  found: the finding is a fact about the rows and this is a suggestion, and a
 *  reader is owed the difference. */
export function suggests(f: Finding): string | null {
  if (f.kind === 'constant') {
    // No backticks: this is a sentence in a paragraph, not markdown, and they
    // rendered as themselves — `SELECT *` with the marks showing.
    return 'It costs disk in every part and travels in every SELECT *. Nothing in the schema says it has stopped varying — only the data does.'
  }
  if (f.kind === 'mirrors') {
    return 'One of the two could be dropped, or derived from the other, without losing anything the rows contain.'
  }
  if (f.kind === 'moves-with') {
    return 'A straight line through the rows: one of the two carries no information the other does not, whatever the units say.'
  }
  if (f.kind === 'dominant') {
    return 'A filter on it narrows almost nothing, and an index or a partition key on it would leave one group holding nearly the whole table.'
  }
  return null
}

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`)

/** The counts under the list. Every cap and every exclusion says its own number,
 *  because a list of three findings over a table of forty columns reads as "there
 *  is almost nothing here" unless it says what it did not look at. */
export function leftOut(r: Relations): string[] {
  const out: string[] = []
  if (r.skipped_constant > 0) {
    out.push(
      `${r.skipped_constant} ${plural(r.skipped_constant, 'column')} hold one value and are listed rather than paired`,
    )
  }
  if (r.skipped_unique > 0) {
    out.push(
      `${r.skipped_unique} ${plural(r.skipped_unique, 'column')} have nearly one value per row — a near-key fixes everything, which is arithmetic rather than a finding`,
    )
  }
  if (r.capped) {
    out.push('more columns were eligible than one pass compares; the coarsest were kept')
  }
  return out
}

/** What to say about how much evidence there is.
 *
 *  A determination over few rows is easily coincidence: with two hundred rows, a
 *  column of sixteen values fixing a column of two says as much about the
 *  arithmetic as about the data. The number is the reader's to weigh, so it is
 *  stated rather than used to hide the finding. */
export function thin(r: Relations): string | null {
  return r.rows > 0 && r.rows < 1000
    ? `Over ${r.rows.toLocaleString('en-US')} rows these are weak evidence: on few rows, one column fixing another is easily coincidence.`
    : null
}

/** The sentence above the list: what was read, and how much of the table the
 *  comparison actually covered. */
export function span(r: Relations): string {
  if (r.rows === 0) return 'This table holds no rows, so there is nothing to compare'
  const rows = `${r.rows.toLocaleString('en-US')} ${plural(r.rows, 'row')}`
  if (r.considered < 2) {
    return `${rows} read · no two columns were eligible to compare`
  }
  const pairs = `${r.considered} of ${r.columns} ${plural(r.columns, 'column')} compared, every pair of them`
  // The numeric pass is a different question over different columns, so it
  // carries its own count rather than being folded into the first.
  return r.numeric >= 2
    ? `${rows} read · ${pairs} · ${r.numeric} of them numeric, correlated as well`
    : `${rows} read · ${pairs}`
}
