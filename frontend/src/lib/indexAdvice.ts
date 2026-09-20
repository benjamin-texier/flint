/** What the workload argues for in skip indexes.
 *
 *  This reads the same measurement the projection advisor reads — every SELECT
 *  against one table in the window, grouped by shape, with what each cost —
 *  and answers a different question from it. That is the whole reason it is a
 *  separate file rather than more rules in `projection.ts`: the evidence is
 *  identical and the proposal is not.
 *
 *  ## A skip index is the cheap answer to the same finding
 *
 *  "This filter is not on a prefix of the sorting key, so the read walks the
 *  table" is the sentence that produces a projection candidate. A projection
 *  answers it by storing a second copy of the data in another order. An index
 *  answers it with a few kilobytes of per-granule summary. They are not
 *  alternatives in the sense of being equivalent — a projection can serve a
 *  grouping and an index never can — but where the finding is a *filter*, the
 *  index is the one to try first, and it is the one nothing in Flint proposed
 *  until now.
 *
 *  ## The kind follows the filter, and the measurement settles the rest
 *
 *  A range wants `minmax`: two values a granule, and that is the whole of what
 *  a `>` needs. An equality wants a membership test, and which one is a real
 *  question — a `set` is exact and stops working above its cap, a bloom filter
 *  is approximate and does not. Flint proposes the one the *type* suggests and
 *  **names the other**, because A9 measures either in seconds and a guess that
 *  can be checked in seconds should not be presented as a conclusion.
 *
 *  ## What this cannot say
 *
 *  Nothing here reports that an existing index is useless. ClickHouse's query
 *  log does not record which skip index served a statement — checked on 26.7,
 *  where `system.query_log` has `used_aggregate_functions`, `used_dictionaries`
 *  and nine more `used_*` columns and nothing about skip indexes. The only
 *  place an index is seen earning its keep is a *plan*, which is what the
 *  what-if below and the statement page read. So the negative finding this
 *  advisor can make is the one the table itself carries: declared and never
 *  built.
 */

import type { Advice, AdviceColumn, Pattern } from './api'
import type { SkipIndex } from './derived'
import {
  keyColumn,
  PROJECTION_ROW_FLOOR,
  read,
  servedByKey,
  spent,
  type Filter,
  type FilterKind,
} from './projection'

export type IndexKind = 'minmax' | 'set' | 'bloom_filter'

export interface Proposal {
  /** Stable across refetches, so a measurement stays attached to the proposal
   *  it was run for — the same rule the projection candidates follow. */
  id: string
  column: string
  type: string
  kind: IndexKind
  /** The other kind worth measuring, where the choice is a real question.
   *  Null where it is not: nothing competes with `minmax` on a range. */
  alternative: IndexKind | null
  /** `equality` or `range`, which is what decided the kind. */
  filter: FilterKind
  /** The comparison the workload actually wrote — `eq`, `lt`, `gte`. What the
   *  measurement plans, because planning `>` for a query that wrote `<`
   *  answers the opposite question: measured on a column ranging −134 to 127,
   *  `< -200` prunes every granule and `> -200` prunes none. */
  op: string
  /** Where this column sits in the sorting key, when it is in it at all. A
   *  column *in* the key but not first is the strongest case there is: the
   *  server cannot prune on it and the column is already correlated with the
   *  order, which is what a skip index is best at. */
  keyPosition: number | null
  /** The shapes that filter on it, heaviest first. */
  patterns: Pattern[]
  runs: number
  /** Milliseconds the window actually spent on those shapes. The ranking, and
   *  never a predicted saving — the rule B4's projection advisor set after a
   *  model of a read came out wrong by 164×. */
  spentMs: number
  /** A value the workload actually compared this column to, where one of the
   *  shapes compared it to a plain literal.
   *
   *  It is what makes a proposal measurable in one press: A9 has to *plan* the
   *  filter, and an index condition is evaluated against the literal. Null
   *  where every shape used a list, a range of expressions or a subquery — and
   *  then the measurement asks for a value rather than inventing one, because
   *  a plan built from a made-up value answers a question nobody asked. */
  sample: string | null
}

/** Why nothing was proposed, in the reader's terms. */
export interface Nothing {
  /** Patterns the SQL reader could not read, with the count. */
  unread: number
  /** Filters the sorting key already serves. */
  servedByKey: number
  /** Columns that already carry an index. */
  alreadyIndexed: string[]
  /** True where the table is too small for any index to skip anything. */
  belowFloor: boolean
}

/** How many distinct values a type suggests, for the one choice that is a
 *  judgement rather than a reading.
 *
 *  `LowCardinality` is ClickHouse being told by whoever made the table that
 *  this column has few values, and `Enum` and `Bool` are that in the type
 *  system itself. Everything else is assumed to have many, which is the safe
 *  direction: a bloom filter on a column with six values works and wastes a
 *  little space, where a `set` on a column with a million silently stops
 *  pruning past its cap.
 */
function few(type: string): boolean {
  return /LowCardinality|Enum|\bBool\b/i.test(type)
}

function kindFor(filter: FilterKind, type: string): { kind: IndexKind; alternative: IndexKind | null } {
  if (filter === 'range') return { kind: 'minmax', alternative: null }
  return few(type)
    ? { kind: 'set', alternative: 'bloom_filter' }
    : { kind: 'bloom_filter', alternative: 'set' }
}

/** Whether this column already carries an index.
 *
 *  Matched on the expression as the table declares it, trimmed of the quoting
 *  a DDL round-trip adds. Not a parse: an index on `lower(name)` and a filter
 *  on `name` are different things, and treating them as the same would hide a
 *  proposal behind an index that cannot serve it.
 */
function indexed(column: string, existing: readonly SkipIndex[]): boolean {
  const want = column.replace(/`/g, '').trim()
  return existing.some((i) => i.expression.replace(/`/g, '').trim() === want)
}

/** A filter the sorting key cannot prune on.
 *
 *  The prefix rule, per column: ClickHouse prunes on a prefix of the key, so a
 *  filter on the first key column is served and one on the third is not —
 *  unless everything before it is pinned by an equality, which is the same
 *  condition `servedByKey` tests for the access as a whole.
 */
function unserved(column: string, access: { equalities: Filter[] }, key: readonly string[]): boolean {
  // Through `assumeNotNull`, because the server sees through it: a table keyed
  // on `assumeNotNull(account_id)` prunes 17 granules of 5,241 for a filter on
  // the bare column. Comparing the terms as text proposed an index for a
  // filter the primary key already answers perfectly, which is the one piece
  // of advice an index advisor must not give.
  const columns = key.map((term) => keyColumn(term))
  const at = columns.indexOf(column)
  if (at === -1) return true
  if (at === 0) return false
  return !columns
    .slice(0, at)
    .every((earlier) => access.equalities.some((f) => f.column === earlier))
}

/** What the workload argues for, heaviest first. */
export function proposals(
  advice: Advice,
  existing: readonly SkipIndex[] = [],
): { proposals: Proposal[]; nothing: Nothing } {
  const nothing: Nothing = {
    unread: 0,
    servedByKey: 0,
    alreadyIndexed: [],
    belowFloor: advice.total_rows > 0 && advice.total_rows < PROJECTION_ROW_FLOOR,
  }
  if (nothing.belowFloor) return { proposals: [], nothing }

  const byColumn = new Map<string, Proposal>()
  const types = new Map(advice.columns.map((c: AdviceColumn) => [c.name, c]))

  for (const pattern of advice.workload.items) {
    const { access, refused } = read(pattern.statement, advice.table, advice.columns)
    if (refused || !access) {
      nothing.unread += 1
      continue
    }
    const filters: { filter: Filter; kind: FilterKind }[] = [
      ...access.equalities.map((filter) => ({ filter, kind: 'equality' as const })),
      ...access.ranges.map((filter) => ({ filter, kind: 'range' as const })),
    ]
    if (filters.length > 0 && servedByKey(access, advice.sorting_key)) {
      // Counted once per shape rather than per filter: the sentence it feeds
      // is about shapes the key already answers.
      nothing.servedByKey += 1
    }
    for (const { filter, kind } of filters) {
      // A filter that went through a function is a filter on that expression,
      // not on the column — `toStartOfHour(time)` and `time` prune
      // differently, which `projection.ts` measured. An index on the bare
      // column would not serve it, so it is not proposed from it.
      if (filter.bucket) continue
      if (!unserved(filter.column, access, advice.sorting_key)) continue
      const column = types.get(filter.column)
      if (!column) continue
      if (indexed(filter.column, existing)) {
        if (!nothing.alreadyIndexed.includes(filter.column)) {
          nothing.alreadyIndexed.push(filter.column)
        }
        continue
      }
      const chosen = kindFor(kind, column.type)
      const found = byColumn.get(filter.column)
      if (found) {
        if (!found.patterns.some((p) => p.hash === pattern.hash)) {
          found.patterns.push(pattern)
          found.runs += pattern.runs
          found.spentMs += spent(pattern)
        }
        // The first value found, and only where there was none: any of them
        // is a value the workload really compared to, and picking between
        // them would be a preference with nothing behind it.
        if (found.sample === null && filter.value !== null) found.sample = filter.value
        // An equality and a range on the same column across two shapes: the
        // range is the one an index has to serve, because `minmax` answers
        // both and a membership test answers only the equality.
        if (kind === 'range' && found.filter === 'equality') {
          found.filter = 'range'
          found.kind = 'minmax'
          found.alternative = null
          found.op = filter.op ?? 'gt'
          found.sample = filter.value ?? found.sample
        }
        continue
      }
      byColumn.set(filter.column, {
        sample: filter.value,
        // `eq` where the reader could not name the comparison: an `IN` is an
        // equality against one of a list, and one of them is what an index
        // would be asked about.
        op: filter.op ?? (kind === 'range' ? 'gt' : 'eq'),
        id: `index:${filter.column}`,
        column: filter.column,
        type: column.type,
        kind: chosen.kind,
        alternative: chosen.alternative,
        filter: kind,
        keyPosition: column.sorting_position ?? null,
        patterns: [pattern],
        runs: pattern.runs,
        spentMs: spent(pattern),
      })
    }
  }

  const ranked = [...byColumn.values()].sort((a, b) => b.spentMs - a.spentMs)
  for (const proposal of ranked) proposal.patterns.sort((a, b) => spent(b) - spent(a))
  return { proposals: ranked, nothing }
}

/** The comparisons the measurement can plan.
 *
 *  The backend's filter grammar is the published face's — one operator, one
 *  value — so `BETWEEN` has no keyword there and an `IN` is a list this
 *  advisor deliberately refuses to pick one value out of. Both are honest
 *  proposals and neither is measurable in a press, which the card says rather
 *  than offering a button that fails.
 */
const PLANNABLE = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte'])

/** Whether the measurement can be run from this proposal alone. */
export function measurable(proposal: Proposal): boolean {
  return proposal.sample !== null && PLANNABLE.has(proposal.op)
}

/** Why it cannot be, where it cannot. */
export function saysUnmeasurable(proposal: Proposal): string | null {
  if (measurable(proposal)) return null
  if (!PLANNABLE.has(proposal.op)) {
    return proposal.op === 'between'
      ? 'a BETWEEN is two comparisons; measure it below as one of them'
      : 'an IN is a list, and measuring one value of it is a different question — pick one below'
  }
  return 'no plain value in these shapes, so the measurement below needs one'
}

/** The claim a proposal makes, in one sentence. */
export function claim(proposal: Proposal): string {
  const where =
    proposal.keyPosition === null
      ? 'is not in the sorting key'
      : proposal.keyPosition === 1
        ? 'is the first column of the sorting key'
        : `is ${ordinal(proposal.keyPosition)} in the sorting key, which the server cannot prune on`
  const how =
    proposal.filter === 'range'
      ? 'compared as a range'
      : 'compared for equality'
  return `${proposal.column} ${where}, and the workload filters on it ${how}.`
}

function ordinal(n: number): string {
  const words = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth']
  return words[n] ?? `${n}th`
}

/** What to say about the kind, including the one this does not choose. */
export function saysKind(proposal: Proposal): string {
  if (proposal.kind === 'minmax') {
    return 'A minmax index keeps the smallest and largest value in each granule, which is the whole of what a range comparison needs.'
  }
  const chosen =
    proposal.kind === 'set'
      ? `A set index keeps every distinct value in each granule, which is exact — and ${proposal.type} says there are few of them.`
      : `A bloom filter answers "could this be here", which is what equality needs on a column with many values — ${proposal.type} suggests many.`
  return `${chosen} Measuring the other one takes the same few seconds, and the numbers decide.`
}

/** Why the list is empty, where it is. Never nothing: a page that proposes
 *  nothing and says nothing has told the reader there is nothing to find. */
export function saysNothing(nothing: Nothing, advice: Advice): string | null {
  if (nothing.belowFloor) {
    return `This table holds ${advice.total_rows.toLocaleString('en')} rows. A read touches at least one whole granule in every part, so there is nothing here for an index to skip.`
  }
  const parts: string[] = []
  if (nothing.servedByKey > 0) {
    parts.push(
      `${nothing.servedByKey} ${nothing.servedByKey === 1 ? 'shape is' : 'shapes are'} already served by the sorting key`,
    )
  }
  if (nothing.alreadyIndexed.length > 0) {
    parts.push(`${nothing.alreadyIndexed.join(', ')} already ${nothing.alreadyIndexed.length === 1 ? 'carries an index' : 'carry indexes'}`)
  }
  if (nothing.unread > 0) {
    parts.push(
      `${nothing.unread} ${nothing.unread === 1 ? 'shape was' : 'shapes were'} not readable — a join, a view, or a filter this cannot attribute to one column`,
    )
  }
  if (parts.length === 0) return null
  return `${parts.join('; ')}.`
}
