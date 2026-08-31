/** Whether a click may spend the server's time.
 *
 *  Once the grid can rewrite the statement, a header click means a new query.
 *  On `system.query_log` that is forty milliseconds and the page should just do
 *  it — waiting for a second gesture to confirm a sort is the kind of caution
 *  that makes a tool feel slow. On a billion-row table that same click is a
 *  forty-second scan, and running it because somebody wanted to see the largest
 *  values first is not a courtesy.
 *
 *  So the decision is made from what the last run of *this* statement actually
 *  cost, which is the only honest estimate available in a browser: ClickHouse
 *  has already told us how long it took and how much it read. Cheap last time,
 *  go; expensive last time, rewrite the text and let the reader press Run.
 *
 *  The thresholds are deliberately generous — the failure this guards against is
 *  a surprise minute of cluster time, not a surprise 300 ms. */

import { bytes, duration } from './format'

/** Under a second and a quarter of a gigabyte: a query nobody would notice
 *  running again. */
const ELAPSED_LIMIT = 2
const BYTES_LIMIT = 256 * 1024 * 1024

export interface LastRun {
  /** Seconds, as `statistics.elapsed` reports them. */
  elapsed: number
  bytesRead: number
}

export type Rerun =
  | { auto: true }
  /** `why` is shown beside the Run button, so the reader knows what the page is
   *  waiting for rather than wondering why nothing happened. */
  | { auto: false; why: string }

export function rerunPolicy(last: LastRun | null): Rerun {
  // Nothing has run yet, so nothing is known to be expensive. A first run is
  // somebody pressing Run, and this is not asked then.
  if (!last) return { auto: true }
  if (last.elapsed <= ELAPSED_LIMIT && last.bytesRead <= BYTES_LIMIT) return { auto: true }
  return {
    auto: false,
    why: `the last run took ${duration(last.elapsed)} and read ${bytes(last.bytesRead)}`,
  }
}

/* -- A read worth understanding ---------------------------------------- */

/** Past this, a read is worth being able to ask about. Not "wrong": a quarter
 *  of a gigabyte may be exactly what the question needed, and a tool that calls
 *  every large scan a mistake teaches people to ignore it. The offer is to
 *  explain, and it appears on the figures rather than on a guess about intent. */
const WORTH_EXPLAINING = 256 * 1024 * 1024

/** Whether to offer the plan beside a run's statistics.
 *
 *  The trigger is bytes read, deliberately — not rows returned. An aggregate
 *  reads a hundred million rows to answer with one, and that is not a defect;
 *  `SELECT count()` would be flagged by any rule built on the ratio of returned
 *  to read. What the plan can actually settle is whether all that reading was
 *  necessary, and the only honest prompt for asking is that there was a lot of
 *  it. */
export function worthExplaining(bytesRead: number): boolean {
  return bytesRead >= WORTH_EXPLAINING
}
