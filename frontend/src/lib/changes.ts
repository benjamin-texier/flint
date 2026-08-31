/** How an object's structure came to be what it is.
 *
 *  From `system.query_log`, which records what kind of statement ran and which
 *  tables it touched. Two limits carried into the interface rather than left to
 *  be discovered, because a history that quietly stops is worse than none:
 *  the log has a TTL — often thirty days, sometimes less — and a
 *  `CREATE DATABASE` names no table, so it can never appear here. */

export interface Change {
  at: string
  user: string
  /** ClickHouse's own word: `Create`, `Alter`, `Drop`, `Rename`. Repeated rather
   *  than translated — it classifies `TRUNCATE` as a `Drop`, and paraphrasing
   *  that into "truncate" would be Flint disagreeing with the log it is quoting. */
  kind: string
  statement: string
  /** Whether it went through Flint. Read off the `query_id` its job runner sets,
   *  so nothing extra is written to make this work — and a statement somebody ran
   *  in `clickhouse-client` is honestly marked as not having come from here. */
  through_flint: boolean
  error: string
}

export interface ChangeReport {
  available: boolean
  reason?: string
  changes: Change[]
  /** The oldest entry the log still holds. Where the history stops, and why. */
  oldest: string
}

/** A run of the same change, collapsed.
 *
 *  Flint's own workspace bootstrap runs `CREATE TABLE IF NOT EXISTS` on every
 *  start, so the structural history of `flint.jobs` on a server Flint has been
 *  restarted thirty times against is thirty identical rows — a wall that buries
 *  the one `ALTER` somebody actually wants to find. Repeats are folded and
 *  *counted*, which is the same treatment the explorer gives internal tables: a
 *  list quietly shortened reads as the whole truth. */
export interface Run {
  /** The most recent of the run. */
  latest: Change
  /** How many identical statements it stands for. 1 for an ordinary change. */
  times: number
  /** When the oldest of them ran, where there is more than one. */
  first_at: string
}

/** Fold consecutive identical statements by the same user.
 *
 *  Consecutive only, deliberately. Two `ALTER`s a month apart with somebody
 *  else's `DROP` between them are three events in a history, and merging them
 *  because the text matches would rewrite what happened. */
export function fold(changes: Change[]): Run[] {
  const runs: Run[] = []
  for (const change of changes) {
    const last = runs[runs.length - 1]
    const same =
      last &&
      last.latest.statement === change.statement &&
      last.latest.user === change.user &&
      last.latest.kind === change.kind &&
      Boolean(last.latest.error) === Boolean(change.error)
    if (same) {
      last.times += 1
      // The list arrives newest first, so each further row is older.
      last.first_at = change.at
    } else {
      runs.push({ latest: change, times: 1, first_at: change.at })
    }
  }
  return runs
}

/** One line for the whole record, or null when there is nothing to say. */
export function summary(report: ChangeReport | undefined): string | null {
  if (!report?.available) return null
  const total = report.changes.length
  if (total === 0) return null
  const mine = report.changes.filter((c) => c.through_flint).length
  const failed = report.changes.filter((c) => c.error).length
  const parts = [`${total} statement${total === 1 ? '' : 's'}`]
  if (mine) parts.push(`${mine} through Flint`)
  if (failed) parts.push(`${failed} refused`)
  return parts.join(', ')
}

/** The first line of a statement, which is all a row has space for.
 *
 *  A `CREATE TABLE` is thirty lines of column definitions; the rest belongs where
 *  the reader can ask for it, not in a table cell. */
export function firstLine(statement: string): string {
  const line = statement.split('\n')[0]?.trim() ?? ''
  return line.length > 160 ? `${line.slice(0, 159)}…` : line
}
