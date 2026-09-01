/** Who this server has been working for.
 *
 *  `src/clickhouse/spend.rs` measures it. The diagnostics page already ranks
 *  statement *shapes* by cost, which answers what is expensive; this answers who
 *  it was expensive for, and that is usually the more actionable half. A shape
 *  costing forty minutes a week is a query to optimise. The same forty minutes
 *  belonging to one service account is a conversation with whoever owns it.
 *
 *  ## An empty account is not a person
 *
 *  ClickHouse logs work nobody asked for interactively — a materialized view's
 *  push, a subquery arriving from another node, a background flush — under an
 *  empty user. On the first server this was pointed at, that empty name was the
 *  *second largest spender on the machine*: 34% of the window, and 82% of its own
 *  time on one table. Named as a user it sends somebody hunting for an account
 *  that does not exist; named as what it is, it is one of the more useful things
 *  the reading produces, because a view quietly costing a third of a server is
 *  exactly the kind of thing nobody goes looking for.
 *
 *  ## And the window is the log's
 *
 *  Same rule as `lib/cold`, same vocabulary — `saysSpan` is imported rather than
 *  rewritten. A ranking of who spent the week, taken from a log holding five
 *  hours, is a ranking of who was awake this morning.
 */

import { saysSpan } from './cold'

export interface Spender {
  user: string
  /** True where the row is the server's own background work, not an account. */
  background: boolean
  statements: number
  seconds: number
  /** Of everything the window cost. */
  share: number
  read_bytes: number
  read_rows: number
  failed: number
  /** The table this account spent most of its time on. Empty where the log
   *  named none. */
  busiest_table: string
  /** That table's share of *this account's* time, not of the server's. */
  busiest_share: number
  last_seen: string
}

export interface SpendReport {
  available: boolean
  reason?: string
  window_days: number
  covered_days: number
  spenders: Spender[]
  total_seconds: number
  total_statements: number
  accounts: number
  /** False on a server that would not let Flint tag its own statements, where
   *  these figures include Flint reading them. */
  excludes_flint: boolean
}

/** Below this much log, a ranking of who spent the window is a ranking of who
 *  happened to be awake. The same floor `lib/cold` keeps, for the same reason. */
const NEEDS_DAYS = 1

/** And below this, there is no workload to divide up. */
const NEEDS_SECONDS = 10

export function trustworthy(report: SpendReport): { ok: boolean; why?: string } {
  if (!report.available) return { ok: false, why: report.reason ?? 'this reading is unavailable' }
  if (report.covered_days < NEEDS_DAYS) {
    return {
      ok: false,
      why: `system.query_log only goes back ${saysSpan(report.covered_days)}, which ranks who was awake this morning rather than who spends this server`,
    }
  }
  if (report.total_seconds < NEEDS_SECONDS) {
    return {
      ok: false,
      why: `the window holds ${Math.round(report.total_seconds)} seconds of query time altogether, which is not a workload to divide up`,
    }
  }
  return { ok: true }
}

/** How to name a row. Never "the user ''" — see the header. */
export function nameOf(spender: Spender): string {
  return spender.background ? 'The server’s own background work' : spender.user
}

/** The share above which one account is worth a sentence of its own.
 *
 *  A quarter, and it is a judgement: below it "who spends this server" has no
 *  answer worth reporting, because a server shared evenly between six accounts is
 *  a server working correctly. */
const NOTABLE = 0.25

/** The accounts worth saying something about, most expensive first.
 *
 *  Deliberately not "the top three": on a server where one account does
 *  everything, two of those three are noise, and on one shared evenly none of
 *  them is a finding. The threshold is the point.
 */
export function notable(report: SpendReport): Spender[] {
  if (!trustworthy(report).ok) return []
  return report.spenders.filter((s) => s.share >= NOTABLE)
}

/** The sentence for one account.
 *
 *  The busiest table is included only when it is most of what that account does.
 *  "41% of the server, and 12% of that on `events`" is two figures that together
 *  say nothing; "41% of the server, and 82% of that on one table" is a finding
 *  with somewhere to go.
 */
export function saysSpender(spender: Spender, report: SpendReport): string {
  const share = Math.round(spender.share * 100)
  const span = saysSpan(report.covered_days)
  const lead = `${nameOf(spender)} took ${share}% of this server’s query time over the last ${span}`
  const concentrated = spender.busiest_table !== '' && spender.busiest_share >= 0.5
  if (!concentrated) return `${lead}, across ${figure(spender.statements)} statements.`
  return `${lead}, and ${Math.round(spender.busiest_share * 100)}% of that was on one table — ${spender.busiest_table}.`
}

/** Statement counts, in the shape a sentence wants. `lib/format`'s `count` is
 *  for a column; this is prose, and "96.6 K statements" reads badly mid-clause. */
function figure(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)},000`
  return `${(n / 1_000_000).toFixed(1)} million`
}

/** The caveat that has to travel with these figures on a server Flint could not
 *  tag its own statements on. `null` where there is nothing to disclose. */
export function saysCaveat(report: SpendReport): string | null {
  if (!report.available || report.excludes_flint) return null
  return 'This server would not let Flint label its own statements, so Flint’s reading of the log is inside these figures.'
}
