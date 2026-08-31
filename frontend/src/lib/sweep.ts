/** Every suggestion in a database at once, grouped, and the ALTERs that follow.
 *
 *  The per-table review (`review.ts`) answers one table at a time, which is the
 *  right unit for *measuring* and the wrong one for *deciding*. A schema with a
 *  naming convention in it — `raw_x`, `raw_x_estimated`, `raw_x_last_state` —
 *  has the same column, with the same problem, in three places, and reviewing
 *  the three tables in turn produces the same finding three times and asks the
 *  reader to notice that it is one decision. They notice by copying thirty
 *  `ALTER` statements out by hand, which is where this file comes from.
 *
 *  So: three axes over one set of findings, and it matters that they are three
 *  readings rather than three features.
 *
 *  **Read by column.** A group is one column name and one proposed type, over
 *  every table that has it. That is the unit somebody holds an opinion about —
 *  "`occupancy_percentage` should be a `UInt8`" is one thought whether it is
 *  true of one table or five.
 *
 *  **Choose by member.** The tick is per table, never per group, because the
 *  evidence is per table: three tables can agree on the type and disagree on
 *  whether it was measured over every row, and one of them can have the column
 *  in its sorting key. A group-level tick would quietly carry the weakest
 *  member's claim on the strongest member's confidence.
 *
 *  **Emit by table.** ClickHouse takes several actions in one `ALTER`, so the
 *  statements are gathered per table — one per table, not one per column. That
 *  is not formatting, and the reason is measured rather than assumed. Against
 *  26.7.5: one `ALTER` with three `MODIFY COLUMN` registers *three* rows in
 *  `system.mutations`, exactly like three separate statements would — but
 *  `system.part_log` shows **one** `MutatePart` for it against **three** for
 *  the separate statements. The mutation entries are per action; the rewrite is
 *  per statement. So six `MODIFY COLUMN` gathered into one `ALTER` read every
 *  part once instead of six times, which on a large table is the difference
 *  between an afternoon and a day.
 *
 *  The honesty rules of `review.ts` survive the grouping or they were never
 *  rules. A group is a verdict only when *every* member was measured over every
 *  row, and it says how many were not. Bytes are summed only over the members
 *  whose bytes exist — the ones in Compact parts are counted apart, never
 *  folded in as zero. And nothing here predicts a saving; the figure is what
 *  those columns occupy today.
 */

import type { SchemaGraph, SchemaReview } from './api'
import { findings, ident, nullFill, type Finding, type Kind, type Severity } from './review'

/** One table's share of one proposal: the unit that is ticked, and the unit
 *  that becomes a single `MODIFY COLUMN`. */
export interface Member {
  table: string
  column: string
  /** The type this table declares today. Carried beside the proposal because a
   *  group whose members start from different types is a fact about the
   *  database that the proposal alone hides — `count` being an `Int64` here and
   *  a `UInt32` there is somebody's migration that only landed on four of five
   *  tables. */
  from: string
  /** The type proposed. Never null here — a member exists only for a finding
   *  that has one. */
  proposal: string
  /** What the column occupies in *this* table today. Null when the parts are
   *  Compact and per-column bytes do not exist. */
  bytes: number | null
  /** False when this table's figures came from a prefix of it. */
  verified: boolean
  /** The numbers this member rests on, as `review.ts` worded them — because the
   *  reader is agreeing with a measurement of *this* table, not of the group. */
  evidence: string
  /** This table's own reasoning. Only ever read to pick the group's, but it has
   *  to be here for that pick to be possible at all. */
  why: string
  /** Why a human has to think before running this one. A key column is the
   *  usual reason, and it is the reason a group cannot be ticked as a block. */
  caution: string | null
  /** True when this table has the column in its sorting or partition key, and
   *  ClickHouse would therefore refuse the change. The one member state that a
   *  bulk tick has to act on rather than merely display. */
  inKey: boolean
  /** The materialized views that write into this table, when any do.
   *
   *  Empty for an ordinary table. Non-empty means the change is half of a pair —
   *  see `writtenBy` — and the member is held out of the SQL for it. */
  fedBy: string[]
  /** What has read this column here lately, when the query log could say. */
  usage: string | null
}

/** One column, one proposed type, everywhere it applies. */
export interface Group {
  column: string
  proposal: string
  kind: Kind
  severity: Severity
  /** `Int64 → UInt16`, and `Int64, Int32 → UInt16` when the tables do not all
   *  start from the same place.
   *
   *  Built here rather than taken from a member's own headline, and the reason
   *  is a bug this had: members share a proposal but not necessarily a declared
   *  type, so the first one's headline was printed over rows it was not true
   *  of — a card reading `Int64 → UInt16` above a table whose column is an
   *  `Int32`. A heading that is wrong about one of the rows under it is worse
   *  than a longer one. */
  headline: string
  /** Every type these tables declare for the column today, commonest first.
   *  More than one entry is itself the finding — see `divergent`. */
  declared: { type: string; tables: number }[]
  /** The reasoning, in words. Taken from a member rather than rewritten here,
   *  because the wording is `review.ts`'s and two spellings of one argument is
   *  how they drift apart. */
  why: string
  /** The declared type that reasoning is actually about.
   *
   *  A sentence like "Int64 reserves 8 bytes per row" is true of the members
   *  declaring an `Int64` and wrong about the one declaring an `Int32` — the
   *  same defect as a headline naming one starting type, one level down. Rather
   *  than rewrite the sentence, the group says which type it describes, and the
   *  page only shows that when the members disagree. */
  whyFor: string
  members: Member[]
  /** Summed over the members whose bytes are known, and over those only. */
  bytes: number
  /** Members whose size is not measurable. Counted rather than added as zero:
   *  "4 tables, 12 GiB" when one of the four is invisible is a figure nobody
   *  can reconcile. */
  unknown: number
  /** Members measured over every row. A group is a verdict when this equals
   *  `members.length`, and a hypothesis otherwise. */
  verified: number
  /** Members carrying a caution. */
  cautioned: number
  /** Members whose table keeps this column in a key, and whose ALTER the server
   *  would refuse. Counted so that "tick all five" can honestly be "tick the
   *  three of five that would run". */
  inKey: number
  /** Members whose table a materialized view writes into, and which therefore
   *  cannot be changed alone. */
  fed: number
  /** The caution, when every member gives the same one — and null when they do
   *  not, which is the only case where it has to be read table by table.
   *
   *  Grouping five tables multiplies the boilerplate by five: the same sentence
   *  about verifying over every row, printed once per member, is `review.ts`'s
   *  own "a caveat printed nine times is a caveat nobody reads" made worse.
   *  Hoisting it is not hiding it — it is said once, where it applies to
   *  everything below it, and it drops back down to the rows the moment the
   *  rows stop agreeing. */
  sharedCaution: string | null
  /** The same for what has read the column, which is per table and often
   *  identical across a family that nothing queries. */
  sharedUsage: string | null
}

/** ClickHouse's `LIKE`, as a regular expression over table names.
 *
 *  The pattern is the selection: `raw_%` is not a list of twelve tables, it is
 *  the rule that has twelve tables in it today and thirteen next week. That is
 *  what a naming convention is for, and it is the reason this is a pattern box
 *  rather than a column of checkboxes.
 *
 *  Evaluated here rather than sent to the server, so that typing in the box
 *  costs nothing and the count under it moves with the keystroke. Which puts an
 *  obligation on this function: it must be ClickHouse's `LIKE` and not an
 *  approximation of it. So `_` is a single-character wildcard — `raw_%` matches
 *  `rawXevents` as well as `raw_events`, which surprises anyone who reads it as
 *  a literal underscore — and `\%` and `\_` are the escapes for the literal
 *  characters. That surprise is why the matched tables are listed under the box
 *  rather than merely counted.
 *
 *  Case-sensitive, like `LIKE` and unlike `ILIKE`. */
export function likeToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] as string
    if (c === '\\' && i + 1 < pattern.length) {
      // Only `%` and `_` are escapable; a backslash before anything else is a
      // backslash, which is what ClickHouse does with it too.
      const next = pattern[i + 1] as string
      if (next === '%' || next === '_') {
        out += escapeLiteral(next)
        i += 1
        continue
      }
      out += escapeLiteral(c)
      continue
    }
    if (c === '%') out += '[\\s\\S]*'
    else if (c === '_') out += '[\\s\\S]'
    else out += escapeLiteral(c)
  }
  return new RegExp(`^${out}$`)
}

function escapeLiteral(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c
}

/** The names a pattern selects. An empty pattern selects everything, because an
 *  empty box is not a filter that matches nothing — it is no filter. */
export function matching(names: string[], pattern: string): string[] {
  const trimmed = pattern.trim()
  if (trimmed === '') return [...names]
  const re = likeToRegExp(trimmed)
  return names.filter((name) => re.test(name))
}

/** Gather every table's findings into one list per (column, proposal).
 *
 *  Only findings that propose a type reach a group: the observation that a
 *  column carries one value throughout proposes a `DROP COLUMN`, which is the
 *  data leaving and is not something anybody should tick eleven of in one go.
 *  It stays where it is, on the table's own review, one table at a time. */
export function group(reviews: SchemaReview[], fed?: Map<string, string[]>): Group[] {
  const groups = new Map<string, Group>()
  for (const review of reviews) {
    for (const finding of findings(review)) {
      if (finding.proposal === null || finding.ddl === null) continue
      const key = `${finding.column} ${finding.proposal}`
      const member = memberOf(review, finding, finding.proposal, fed?.get(review.table) ?? [])
      const existing = groups.get(key)
      if (existing) {
        existing.members.push(member)
        accumulate(existing, member)
        continue
      }
      const fresh: Group = {
        column: finding.column,
        proposal: finding.proposal,
        kind: finding.kind,
        severity: finding.severity,
        headline: '',
        declared: [],
        why: finding.why,
        whyFor: member.from,
        members: [member],
        bytes: 0,
        unknown: 0,
        verified: 0,
        cautioned: 0,
        inKey: 0,
        fed: 0,
        sharedCaution: null,
        sharedUsage: null,
      }
      accumulate(fresh, member)
      groups.set(key, fresh)
    }
  }
  for (const g of groups.values()) {
    g.sharedCaution = shared(g.members.map((m) => m.caution))
    g.sharedUsage = shared(g.members.map((m) => m.usage))
    g.declared = tallyBy(g.members.map((m) => [m.from, 1]))
    // The reasoning follows the commonest declared type, so the sentence is
    // true of as many rows as it can be — and says which those are.
    const commonest = g.declared[0]?.type
    const spokesman = g.members.find((m) => m.from === commonest)
    if (spokesman) {
      g.why = spokesman.why
      g.whyFor = spokesman.from
    }
    const from = g.declared.map((d) => d.type).join(', ')
    g.headline = from === '' ? `→ ${g.proposal}` : `${from} → ${g.proposal}`
    // Biggest table first inside a group, for the same reason the groups
    // themselves are ordered by disk; the name breaks a tie so two runs of the
    // same review put the rows in the same order.
    g.members.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.table.localeCompare(b.table))
  }
  return rankGroups([...groups.values()])
}

/** The one value they all gave, or null if they did not all give one. A single
 *  member agrees with itself, which is the point: a group of one should read
 *  like the table's own review, with its caution where its caution belongs. */
function shared(values: (string | null)[]): string | null {
  const first = values[0] ?? null
  if (first === null) return null
  return values.every((v) => v === first) ? first : null
}

function memberOf(
  review: SchemaReview,
  finding: Finding,
  proposal: string,
  fedBy: string[],
): Member {
  return {
    table: review.table,
    column: finding.column,
    from: review.columns.find((c) => c.name === finding.column)?.type ?? '',
    proposal,
    bytes: finding.bytes,
    verified: finding.verified,
    evidence: finding.evidence,
    why: finding.why,
    caution: finding.caution,
    inKey: finding.inKey,
    fedBy,
    usage: finding.usage,
  }
}

function accumulate(g: Group, member: Member) {
  if (member.bytes === null) g.unknown += 1
  else g.bytes += member.bytes
  if (member.verified) g.verified += 1
  if (member.caution !== null) g.cautioned += 1
  if (member.inKey) g.inKey += 1
  if (member.fedBy.length > 0) g.fed += 1
}

/** Most disk first, because that is where the disk is — and never by a
 *  predicted saving, which is a figure this cannot know. A group whose size is
 *  entirely unmeasurable goes after the ones with a figure rather than
 *  pretending to weigh nothing; among those, the one touching more tables comes
 *  first, since it is the larger decision. The column name breaks the last tie
 *  so the order is stable between two runs. */
export function rankGroups(list: Group[]): Group[] {
  return [...list].sort(
    (a, b) =>
      b.bytes - a.bytes ||
      b.members.length - a.members.length ||
      a.column.localeCompare(b.column) ||
      a.proposal.localeCompare(b.proposal),
  )
}

/** What a set of ticks would touch. Tables and statements are the same count —
 *  one `ALTER` per table — and both are worth saying, because the gap between
 *  "30 changes" and "8 statements" is the whole point of the page. */
export function reach(members: Member[]): {
  columns: number
  tables: number
  bytes: number
  unknown: number
  unverified: number
} {
  const tables = new Set<string>()
  let bytes = 0
  let unknown = 0
  let unverified = 0
  for (const m of members) {
    tables.add(m.table)
    if (m.bytes === null) unknown += 1
    else bytes += m.bytes
    if (!m.verified) unverified += 1
  }
  return { columns: members.length, tables: tables.size, bytes, unknown, unverified }
}

/** How much of two tables' columns have to coincide before one is a variant of
 *  the other rather than merely a table with columns in it.
 *
 *  Four fifths of the union, and the figure is doing real work: `raw_x` and
 *  `raw_x_last_state` differ by the column that makes one a last-state table,
 *  and strict equality would put them in separate families and lose exactly the
 *  comparison worth making. Below four fifths they are two tables that happen
 *  to share some names, which every table in a warehouse does — `id`, `ts`,
 *  `tenant` are in all of them and mean different things in each. */
const SIBLING_SHARE = 0.8

/** Tables that are variants of one another. */
export interface Family {
  /** In the order they were reviewed. */
  tables: string[]
  /** The column names every one of them has. */
  shared: string[]
}

/** Group the reviewed tables by how much of their shape they have in common.
 *
 *  Single-linkage: a table joins a family if it is a variant of *any* member,
 *  which is what a chain of siblings actually looks like — `raw_x`,
 *  `raw_x_estimated` and `raw_x_last_state` each differ a little from the
 *  others and all three belong together.
 *
 *  This exists to qualify a disagreement rather than to be looked at: the same
 *  column typed two ways *within* a family is drift, and one of the tables is
 *  wrong. Across families it is two different things wearing one name, which is
 *  ordinary and not worth an alarm. Reporting both identically would make the
 *  useful case impossible to find. */
export function families(reviews: SchemaReview[]): Family[] {
  const names = reviews.map((r) => r.table)
  const cols = new Map(names.map((n, i) => [n, new Set(reviews[i]!.columns.map((c) => c.name))]))
  const sibling = (a: string, b: string) => {
    const x = cols.get(a)!
    const y = cols.get(b)!
    if (x.size === 0 || y.size === 0) return false
    let both = 0
    for (const c of x) if (y.has(c)) both += 1
    return both / (x.size + y.size - both) >= SIBLING_SHARE
  }

  const out: Family[] = []
  for (const name of names) {
    const joined = out.find((f) => f.tables.some((t) => sibling(t, name)))
    if (joined) joined.tables.push(name)
    else out.push({ tables: [name], shared: [] })
  }
  for (const family of out) {
    const [first, ...rest] = family.tables
    const common = new Set(cols.get(first!)!)
    for (const other of rest) {
      for (const c of common) if (!cols.get(other)!.has(c)) common.delete(c)
    }
    family.shared = [...common]
  }
  return out
}

/** One column name that these tables do not agree about.
 *
 *  It is the one finding on this page that no per-table review could ever
 *  reach, and it comes in two halves worth keeping apart.
 *
 *  The **declared** half is metadata only and covers *every* column, not just
 *  the ones a rule flagged: `user_id` being a `String` in one table and a
 *  `UInt64` in another is a disagreement whether or not either is worth
 *  changing on its own — every join between them casts, and no per-table review
 *  can see it because each table is individually fine.
 *
 *  The **proposed** half falls out of the grouping: one column heading for two
 *  different types means the measurements disagreed about what it holds.
 *
 *  Deliberately not a finding: no DDL follows, and proposing one — "make them
 *  all the widest" — would be this page inventing a fact about data it has not
 *  measured. It is a thing to go and look at, and `withinFamily` says how hard
 *  to look. */
export interface Divergence {
  column: string
  /** Every type it is declared as today, with the tables declaring it,
   *  commonest first. */
  declared: { type: string; tables: string[] }[]
  /** Every type proposed for it, likewise. Empty when no rule fired. */
  proposals: { type: string; tables: string[] }[]
  /** True when every table involved is a variant of the others, which makes the
   *  disagreement drift between siblings rather than two unrelated tables
   *  sharing a common noun. */
  withinFamily: boolean
}

/** What the reviewed tables do not agree about.
 *
 *  Reads the declared types straight off the reviews rather than off the
 *  findings, so a column that is correct in both tables and merely *different*
 *  is still reported. That is the case the grouping alone could never produce,
 *  and it costs nothing: the types are already in hand. */
export function disagreements(reviews: SchemaReview[], groups: Group[]): Divergence[] {
  const kin = families(reviews)
  const familyOf = new Map<string, number>()
  kin.forEach((f, i) => f.tables.forEach((t) => familyOf.set(t, i)))

  const declared = new Map<string, Map<string, string[]>>()
  for (const review of reviews) {
    for (const column of review.columns) {
      const byType = declared.get(column.name) ?? new Map<string, string[]>()
      byType.set(column.type, [...(byType.get(column.type) ?? []), review.table])
      declared.set(column.name, byType)
    }
  }

  const proposed = new Map<string, Map<string, string[]>>()
  for (const g of groups) {
    const byType = proposed.get(g.column) ?? new Map<string, string[]>()
    byType.set(g.proposal, [...(byType.get(g.proposal) ?? []), ...g.members.map((m) => m.table)])
    proposed.set(g.column, byType)
  }

  const out: Divergence[] = []
  for (const [column, byType] of declared) {
    const declaredList = spread(byType)
    const proposalList = spread(proposed.get(column) ?? new Map())
    if (declaredList.length < 2 && proposalList.length < 2) continue
    const involved = [
      ...new Set([
        ...declaredList.flatMap((d) => d.tables),
        ...proposalList.flatMap((p) => p.tables),
      ]),
    ]
    const first = familyOf.get(involved[0]!)
    out.push({
      column,
      declared: declaredList,
      proposals: proposalList,
      withinFamily: involved.every((t) => familyOf.get(t) === first),
    })
  }
  /* Drift between siblings first: it is the half somebody can act on, and a
     list led by three common nouns that mean different things in different
     tables is a list nobody reads to the end. */
  return out.sort(
    (a, b) => Number(b.withinFamily) - Number(a.withinFamily) || a.column.localeCompare(b.column),
  )
}

/** Types with how many tables declare each, commonest first and the name
 *  breaking a tie so two runs of one review word a card the same way. Counts
 *  rather than names, because this feeds a group heading where the names are
 *  already the rows underneath. */
function tallyBy(pairs: [string, number][]): { type: string; tables: number }[] {
  const counts = new Map<string, number>()
  for (const [type, n] of pairs) {
    if (type === '') continue
    counts.set(type, (counts.get(type) ?? 0) + n)
  }
  return [...counts.entries()]
    .map(([type, tables]) => ({ type, tables }))
    .sort((a, b) => b.tables - a.tables || a.type.localeCompare(b.type))
}

function spread(byType: Map<string, string[]>): { type: string; tables: string[] }[] {
  return [...byType.entries()]
    .map(([type, tables]) => ({ type, tables: [...new Set(tables)] }))
    .sort((a, b) => b.tables.length - a.tables.length || a.type.localeCompare(b.type))
}

/** Tables that something else writes into, and what writes them.
 *
 *  A materialized view is a trigger with a `SELECT` in it, and the `SELECT` is
 *  not part of the target's DDL. Narrow the target's column and the view keeps
 *  running against the old expression, casting into the new type on every
 *  insert from then on — and a narrowing cast in ClickHouse truncates rather
 *  than refusing. So the `ALTER` succeeds, the table looks right, and the wrong
 *  numbers arrive quietly for as long as nobody looks.
 *
 *  Which makes retyping a view's target not a decision about one table. It is a
 *  pair to change together, and this page will not tick one half of it: the
 *  member is shown with the column's problem intact — the reader is entitled to
 *  know it is here too — and left out of the SQL, exactly like a column in a
 *  sorting key.
 *
 *  Read from the lineage Flint already draws, so it costs nothing and is as
 *  good as that diagram is. The README is explicit that the graph is largely
 *  *inferred*, which is the right amount of caution for a refusal: it is a
 *  reason to make somebody look, never a reason to claim the pair is safe. */
export function writtenBy(graph: SchemaGraph | undefined, database: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!graph) return out
  const name = (id: string) => (id.startsWith(`${database}.`) ? id.slice(database.length + 1) : id)
  for (const edge of graph.edges) {
    if (edge.kind !== 'writes') continue
    const target = name(edge.to)
    out.set(target, [...(out.get(target) ?? []), name(edge.from)])
  }
  return out
}

/** Where a single change is carried to be run: Infrastructure → Schema, with
 *  the operation and its fields in the address.
 *
 *  This page is Data, and Data does not write structure — so the hand-over is
 *  the same link the projection advisor uses rather than a second way of
 *  applying DDL. It carries one `MODIFY COLUMN`, because the panel at the other
 *  end takes one action on one table; a whole group leaves through the SQL
 *  block instead, which is the only form that keeps the grouping. */
export function handOver(database: string, member: Member): string {
  const params = new URLSearchParams({
    alter: `${database}.${member.table}`,
    op: 'modify-column',
    column: member.column,
    kind: member.proposal,
  })
  // Carried in the address rather than left for the panel to work out, because
  // the panel does not know what the column is today — it takes the type it is
  // given. A drop of the Nullable without this arrives there as a statement
  // ClickHouse refuses outright, and the reader is handed the server's error
  // instead of the change they asked for. See `nullFill`.
  const fill = nullFill(member.from, member.proposal)
  if (fill !== null) params.set('default_expr', fill)
  return `/infra/schema?${params.toString()}`
}

/** What a tick means once the numbers under it have moved.
 *
 *  A tick is an intention — "this column, this table, changed" — and the
 *  proposal it was made against is a measurement that can be superseded. It
 *  will be, routinely and on purpose: a sample of 200,000 rows says a duration
 *  column fits in a `UInt16`, and reading every row finds the one day somebody
 *  measured a full 86,400 seconds. That is not an edge case, it is what
 *  verifying is *for*, and the `ALTER` built from the stale proposal would
 *  silently truncate the column.
 *
 *  So the SQL is never built from what was ticked. It is built from what those
 *  ticks resolve to against the findings as they stand now, and the differences
 *  are reported rather than applied quietly. */
/** True when a member cannot be changed on its own: the server would refuse it,
 *  or something else writes into the table and would have to change with it.
 *  One predicate, consulted by the bulk tick, the hand-over link and the row's
 *  own checkbox, so the three cannot come to different conclusions about one
 *  row. */
export function heldBack(member: Member): boolean {
  return member.inKey || member.fedBy.length > 0
}

export interface Intent {
  table: string
  column: string
  proposal: string
}

export interface Reconciled {
  /** The members the statements are actually built from. */
  chosen: Member[]
  /** Ticks whose proposal has moved since they were made. */
  changed: { table: string; column: string; was: string; now: string }[]
  /** Ticks whose finding is gone — the fuller measurement decided there was
   *  nothing to change here after all. */
  dropped: Intent[]
}

/** Resolve ticks against the findings as they stand.
 *
 *  A tick matching a member exactly is that member. A tick whose column still
 *  has a proposal, but a different one, follows the new proposal and says so.
 *  A tick with no proposal left at all is dropped and named — "you asked for
 *  this and it is no longer advised" is a sentence somebody needs to read, not
 *  a row that vanishes between two renders. */
export function reconcile(intents: Intent[], groups: Group[]): Reconciled {
  /* Every member, by table and column. Insertion order is the group order,
     which is ranked by disk — so where a column has two proposals and the tick
     matches neither, the one taken is the larger decision rather than whichever
     the map happened to hold. */
  const byColumn = new Map<string, Member[]>()
  for (const g of groups) {
    for (const m of g.members) {
      const key = `${m.table} ${m.column}`
      const list = byColumn.get(key)
      if (list) list.push(m)
      else byColumn.set(key, [m])
    }
  }

  const chosen: Member[] = []
  const changed: Reconciled['changed'] = []
  const dropped: Intent[] = []

  for (const intent of intents) {
    const candidates = byColumn.get(`${intent.table} ${intent.column}`)
    if (!candidates || candidates.length === 0) {
      dropped.push(intent)
      continue
    }
    const exact = candidates.find((m) => m.proposal === intent.proposal)
    if (exact) {
      chosen.push(exact)
      continue
    }
    const moved = candidates[0]!
    chosen.push(moved)
    changed.push({
      table: intent.table,
      column: intent.column,
      was: intent.proposal,
      now: moved.proposal,
    })
  }

  return { chosen, changed, dropped }
}

/** Two ticks that would modify the same column of the same table.
 *
 *  It happens for real: a `Nullable(String)` with no nulls in it draws both
 *  "drop the Nullable" and "make it a dictionary", and the two propose
 *  different types. One `ALTER` cannot do both, and one that names a column
 *  twice is rejected outright — so a conflict is reported rather than silently
 *  reconciled, and the caller has to resolve it. */
export interface Conflict {
  table: string
  column: string
  kept: string
  dropped: string
}

/** The statements, one per table, and whatever could not be reconciled.
 *
 *  Order is the order the members arrive in, table by table, so the statement a
 *  reader is looking for is where they put it. Within a table the column order
 *  follows the same rule. */
export function statements(
  database: string,
  chosen: Member[],
): { sql: string[]; conflicts: Conflict[]; cleanups: number } {
  const byTable = new Map<string, Member[]>()
  const conflicts: Conflict[] = []
  const claimed = new Map<string, string>()

  for (const member of chosen) {
    const key = `${member.table} ${member.column}`
    const already = claimed.get(key)
    if (already !== undefined) {
      if (already !== member.proposal) {
        conflicts.push({
          table: member.table,
          column: member.column,
          kept: already,
          dropped: member.proposal,
        })
      }
      continue
    }
    claimed.set(key, member.proposal)
    const list = byTable.get(member.table)
    if (list) list.push(member)
    else byTable.set(member.table, [member])
  }

  let cleanups = 0
  const sql = [...byTable.entries()].flatMap(([table, members]) => {
    // The types line up under each other. A block of thirty MODIFY COLUMNs is
    // read as a column of types before it is read as sentences, and ragged
    // types make the reader check each line to see whether it is the UInt8 or
    // the UInt16 they meant.
    const lines = (list: Member[], tail: (m: Member) => string) => {
      const width = Math.max(...list.map((m) => ident(m.column).length))
      return list
        .map((m) => `    MODIFY COLUMN ${ident(m.column).padEnd(width)} ${tail(m)}`)
        .join(',\n')
    }
    const head = `ALTER TABLE ${ident(database)}.${ident(table)}`
    const out = [
      `${head}\n${lines(members, (m) => {
        const fill = nullFill(m.from, m.proposal)
        return fill === null ? m.proposal : `${m.proposal} DEFAULT ${fill}`
      })}`,
    ]
    // A second statement per table, for the columns whose Nullable is being
    // dropped — see `nullFill`. It puts them back to the plain type the card
    // promised, it cannot be folded into the ALTER above (one column, named
    // twice, is rejected), and it is free: measured against 26.7 it registers
    // no row in `system.mutations` where the statement above it registers one
    // per column. So the reader gets one extra statement and no extra rewrite.
    const cleared = members.filter((m) => nullFill(m.from, m.proposal) !== null)
    if (cleared.length > 0) {
      cleanups += 1
      out.push(`${head}\n${lines(cleared, () => 'REMOVE DEFAULT')}`)
    }
    return out
  })

  return { sql, conflicts, cleanups }
}

/** The statements as one block, with what the reader is carrying stated at the
 *  top of it.
 *
 *  The header is a SQL comment on purpose: this block is the one part of the
 *  page that leaves the page. Pasted into a terminal an hour later, it has to
 *  still say that six of its eighteen changes rest on a sample of a quarter of
 *  a million rows rather than on the column. A caveat that stays behind on the
 *  screen it was copied from is a caveat that was never given. */
export function script(database: string, chosen: Member[]): string {
  const { sql, conflicts, cleanups } = statements(database, chosen)
  if (sql.length === 0) return ''
  const r = reach(chosen)
  const applied = r.columns - conflicts.length
  /* The statements that actually rewrite parts, as opposed to the REMOVE
     DEFAULT ones that do not. Held in a name because both lines below have to
     agree with it about the verb: "1 statement rewrite" is the sort of sentence
     a reader stops trusting the rest of the block for. */
  const heavy = sql.length - cleanups
  const head = [
    `-- Flint / ${database}: ${plural(applied, 'column')} over ${plural(r.tables, 'table')}, ${plural(sql.length, 'statement')}.`,
    r.unverified > 0
      ? `-- ${r.unverified.toLocaleString('en-GB')} of them rest on a sample of the table rather than on every row of it.`
      : '-- Every one was measured over every row of its table.',
    cleanups > 0
      ? `-- ${plural(heavy, 'statement')} ${heavy === 1 ? 'rewrites every part of its columns' : 'rewrite every part of their columns'}, once for the whole statement.`
      : '-- Each statement rewrites every part of its columns, once for the whole statement.',
  ]
  // Said here and not only on the card, because this block is the part of the
  // page that leaves the page. Dropping a Nullable needs a DEFAULT to run at
  // all, and the DEFAULT turns a null into the type's zero value instead of
  // refusing — so the one sentence a reader must not lose on the way to their
  // terminal is that these statements will quietly absorb a null Flint did not
  // see, not fail on it.
  if (cleanups > 0) {
    // Broken across lines by hand, and the reason is the block it lands in:
    // `.sweep__sql` sets `white-space: pre`, because wrapping SQL at whatever
    // width the panel happens to be is how a statement becomes unreadable. So a
    // comment past that width does not wrap either — it runs off the right edge
    // and reads as a sentence that stops halfway. These two are the longest
    // lines the header carries and the ones it can least afford to have
    // truncated, so they are written to fit.
    head.push(
      `-- ${plural(cleanups, 'REMOVE DEFAULT statement')} ${cleanups === 1 ? 'rewrites' : 'rewrite'} nothing: dropping a Nullable`,
      '--   needs a DEFAULT to be accepted, and that clause puts the column back to a',
      '--   plain type.',
      "-- Read those DEFAULTs first. A null becomes the type's zero value silently",
      '--   rather than failing the ALTER, and nothing brings it back.',
    )
  }
  return `${head.join('\n')}\n\n${sql.join(';\n\n')};\n`
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString('en-GB')} ${noun}${n === 1 ? '' : 's'}`
}
