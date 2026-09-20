/** What an index would have done, read out of the two plans that measured it.
 *
 *  `src/clickhouse/whatif.rs` builds the thing on a copy of one partition and
 *  runs `EXPLAIN PLAN indexes = 1` twice, before and after. It has no opinion
 *  about either. This decides what may be said, and almost all of it is
 *  `plan.ts` — the same parser, the same sentences the editor and the statement
 *  page already use, because a second reading of a plan would be a second set
 *  of words for one fact.
 *
 *  What is new here is the *comparison*, and two things about it have to be
 *  kept straight or the page overstates its own measurement.
 *
 *  **The share is the finding; the counts belong to the copy.** Before and
 *  after are measured on the same rows with one thing different, which is what
 *  makes "it skipped 99% of the granules" a fact. The 396 it skipped them out
 *  of is the copy's own number: the real table has more parts, and a part
 *  contributes at least one granule to every read. So the proportion travels
 *  and the absolute figures are labelled as the sample's.
 *
 *  **An index that prunes nothing is the more useful answer.** It costs a write
 *  on every insert and disk on every part, forever, and the measurement is the
 *  only place anybody would find out before paying for it. So that reading is
 *  as loud as the good one, which is why neither is a "recommendation".
 */

import { bytes, count } from './format'
import { readPlan, type Plan, type Used, type Verdict } from './plan'

export interface Outcome {
  partition: string
  sampled_rows: number
  sampled_parts: number
  table_rows: number
  table_parts: number
  /** The partition was bigger than the cap and the copy was cut. */
  clipped: boolean
  before_plan: string
  after_plan: string
  index_bytes: number
  statement: string
  name: string
  expression: string
  kind: string
  granularity: number
  /** The server's own words where it would not build the index. */
  refused: string | null
}

/** What the hypothetical index did on the copy, or null where the plan carries
 *  no skip index at all — which happens when the server declined to use the
 *  one that was built, and is itself a finding. */
export function pruned(after: Plan): Used | null {
  for (const read of after.reads) {
    const skip = read.indexes.find((i) => i.kind.toLowerCase() === 'skip')
    if (skip?.granules) return skip.granules
  }
  return null
}

/** What the read cost before the index, as the plan reports it. */
export function granulesRead(plan: Plan): number | null {
  for (const read of plan.reads) {
    if (read.granules !== null) return read.granules
  }
  return null
}

function share(u: Used): number {
  return u.total > 0 ? u.used / u.total : 1
}

function pct(n: number): string {
  const v = n * 100
  if (v > 0 && v < 1) return '<1%'
  if (v < 100 && v > 99) return '>99%'
  return `${Math.round(v)}%`
}

/** Everything the measurement supports saying, most consequential first. */
export function verdicts(outcome: Outcome): Verdict[] {
  if (outcome.refused) {
    return [
      {
        tone: 'cost',
        text: 'The server would not build this index on this column.',
        evidence: outcome.refused,
      },
    ]
  }
  const after = readPlan(outcome.after_plan)
  const before = readPlan(outcome.before_plan)
  const out: Verdict[] = []
  const skipped = pruned(after)

  if (!skipped) {
    // Built, and the planner did not reach for it. Worth saying plainly: the
    // index exists in the copy, so this is not "it could not be built" — it is
    // "this filter cannot use it".
    out.push({
      tone: 'cost',
      text: 'The index was built and the plan did not use it: this filter cannot reach it.',
      evidence: `${bytes(outcome.index_bytes)} of index, and no skip entry in the plan`,
    })
    return out
  }

  const kept = share(skipped)
  const wasRead = granulesRead(before)
  if (kept < 1) {
    out.push({
      tone: 'good',
      text: `It skipped ${pct(1 - kept)} of the read: ${count(skipped.used)} of ${count(skipped.total)} granules, where the same filter read ${wasRead === null ? 'all of them' : count(wasRead)} without it.`,
      evidence: `${bytes(outcome.index_bytes)} of index over ${count(outcome.sampled_rows)} rows`,
    })
  } else {
    out.push({
      tone: 'cost',
      text: 'It skipped nothing: every granule the filter touched was read anyway.',
      evidence: `${bytes(outcome.index_bytes)} of index, paid for on every insert`,
    })
  }

  // The floor, stated wherever a pruning figure is: a read bottoms out at one
  // granule per part it touches, so "four granules" on a four-part copy is the
  // least this filter could ever have read.
  if (kept < 1 && skipped.used > 0 && skipped.used <= outcome.sampled_parts) {
    out.push({
      tone: 'note',
      text: 'That is the floor for this copy: a read touches at least one whole granule in every part it reaches.',
      evidence: `${count(outcome.sampled_parts)} parts in the sample`,
    })
  }

  out.push({
    tone: 'note',
    text: `Measured on ${outcome.clipped ? 'part of ' : ''}partition ${outcome.partition} — ${count(outcome.sampled_rows)} of ${count(outcome.table_rows)} rows, copied and thrown away.`,
    evidence: `${count(outcome.sampled_parts)} parts here against ${count(outcome.table_parts)} in the table`,
  })

  return out
}

/** Where the alteration is carried to be run.
 *
 *  Infrastructure → Schema, with `add-index`'s own four fields filled in —
 *  the form B4 built, reached for the first time from the Data side. This
 *  panel measures and hands over; no Data control writes structure. */
export function handOver(database: string, table: string, outcome: Outcome): string {
  const params = new URLSearchParams({
    alter: `${database}.${table}`,
    op: 'add-index',
    name: outcome.name,
    expression: outcome.expression,
    kind: outcome.kind,
    granularity: String(outcome.granularity),
  })
  return `/infra/schema?${params.toString()}`
}
