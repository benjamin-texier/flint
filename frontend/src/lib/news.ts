/** What changed since you last looked — the judgement half.
 *
 *  `src/clickhouse/news.rs` measures: it cuts a span into equal periods and
 *  reads what each one cost, what failed in it, what was reshaped and what was
 *  written, with no opinion about any of it. This decides which of those
 *  movements is *news*, and words it. The split is the one `drift.ts`,
 *  `review.ts` and `projection.ts` already follow — the thresholds below are the
 *  arguable part of the feature, and an argument belongs in a test file rather
 *  than inside a SQL string.
 *
 *  **Why a board needs this at all.** Every other page in Flint answers a
 *  question the reader arrived with. Opening Flint, nobody has one yet: the
 *  first question is *is anything different today*, and until now the four
 *  measurements that answer it each lived on the page you had to already
 *  suspect. Nothing here is a new capability. It is the synthesis of things
 *  Flint was already measuring and never said out loud.
 *
 *  Four rules run through all of it:
 *
 *  - **A period the log does not wholly cover is unknown, not empty.** Below
 *    `MIN_HISTORY` covered periods there is no shape to compare against, and the
 *    honest output is the reason rather than a confident sentence built on one
 *    sample. `read` returns that reason instead of headlines.
 *  - **The baseline is the median of the periods, not the one before.** A
 *    single before-and-after pair reads every Monday as a collapse of Sunday,
 *    and cannot tell a daily ingest that stopped from a seed load that was
 *    never going to repeat.
 *  - **A median over the covered periods is itself the regularity test.** For a
 *    median to be above zero, more than half the periods have to have had
 *    something in them — so "was written most days and took nothing today" needs
 *    no second check, and a table loaded once six days ago does not qualify.
 *    This is the rule that makes the silently-stopped ingest reportable at all.
 *  - **A headline is filed by where it sends you**, exactly as `attention.ts`
 *    files a concern. A statement's cost is Data, a reshaped object is
 *    Infrastructure, and the two spaces never share a screen — so one list is
 *    split by destination rather than by who wrote the thing.
 */

import { bytes, count, exact } from './format'

/** Covered prior periods below which nothing is judged. Two readings are a line,
 *  not a shape, and "usual" over one of them is a synonym for "yesterday". */
export const MIN_HISTORY = 3

/** How far past its usual a figure has to go before it is worth a sentence.
 *  Three, not the halving-or-doubling `drift.ts` uses, because these are counts
 *  over a whole period rather than a column's shape: a workload that varies by
 *  half between a Tuesday and a Sunday is a workload behaving normally, and a
 *  board that says so every Monday is a board nobody reads. */
const MOVE = 3

/** What share of the period's total time a statement has to hold before its
 *  movement is anybody's problem. A statement that tripled from a thousandth of
 *  the workload to three thousandths has still done nothing to this server. */
const SHARE = 0.15

/** And what share makes it the thing to look at first. */
const DOMINATES = 0.4

/** Failures below this many are somebody's typo. The point of the count is that
 *  it is being *repeated* — one refused query is a person learning the schema,
 *  a hundred is a caller in a loop against something that no longer exists. */
const FAILURES = 10

/** How many of each kind reach the board. A board is read at a glance; the page
 *  each row links to is where the whole list lives. */
const PER_KIND = 3

// ── The wire ───────────────────────────────────────────────────────────────

export interface Totals {
  ms_now: number
  runs_now: number
  prior_ms: number[]
}

export interface CostMove {
  hash: string
  kind: string
  sample: string
  tables: string[]
  ms_now: number
  runs_now: number
  users: number
  prior_ms: number[]
  last_seen: string
}

export interface FailureMove {
  code: number
  name: string
  now: number
  prior: number[]
  last_seen: string
  message: string
  sample: string
}

export interface StructureChange {
  at: string
  user: string
  kind: string
  tables: string[]
  statement: string
  through_flint: boolean
}

export interface VolumeMove {
  qualified: string
  rows_now: number
  bytes_now: number
  prior_rows: number[]
}

export interface VolumeSection {
  available: boolean
  reason?: string | null
  prior_windows_covered: number
  tables: VolumeMove[]
}

export interface NewsReport {
  available: boolean
  reason?: string | null
  window_hours: number
  windows: number
  prior_windows_covered: number
  oldest: string
  totals: Totals | null
  cost: CostMove[]
  failures: FailureMove[]
  structure: StructureChange[]
  structure_total: number
  volume: VolumeSection
}

// ── The judgement ──────────────────────────────────────────────────────────

export type Rank = 'act' | 'watch' | 'note'
export type Kind = 'cost' | 'failure' | 'structure' | 'volume'

export interface Headline {
  id: string
  kind: Kind
  rank: Rank
  /** What this is about: a table, an error, a statement's tables. */
  subject: string
  /** What happened to it, as a sentence that follows the subject. */
  says: string
  /** The measurement behind the sentence. Absent where there is none worth
   *  giving — dropped, not dashed. */
  figure?: string
  /** Where it can be proved, and what files it into a space. */
  to: string
}

export interface Read {
  headlines: Headline[]
  /** Why nothing could be judged. Null whenever the report was read normally —
   *  including when it was read and there was simply no news, which is the
   *  common case and must not be dressed up as a failure. */
  blocked: string | null
}

/** The usual figure for one period, over the periods there is history for.
 *
 *  Null below `MIN_HISTORY`, which is the whole reason this returns a nullable:
 *  every caller has to decide what to do without a baseline, and none of them
 *  may invent one.
 *
 *  The slice is not decoration. `prior` is fixed-length and newest-first, so the
 *  tail holds periods the log may not reach; averaging those in as zeros
 *  manufactures a decline out of a retention limit. */
export function usual(prior: number[], covered: number): number | null {
  if (covered < MIN_HISTORY) return null
  const seen = prior.slice(0, covered)
  if (seen.length < MIN_HISTORY) return null
  const sorted = [...seen].sort((a, b) => a - b)
  const mid = sorted.length / 2
  return sorted.length % 2
    ? (sorted[Math.floor(mid)] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** Past this, the multiplier stops being quoted.
 *
 *  Measured on a real server, which is the only reason this exists: an error
 *  code seen [366, 109, 1, 2, 0] times over five days has a median of 2, and
 *  1,141 of them today came out as **571×**. Every step of that is correct and
 *  the sentence is nonsense — a ratio against a baseline of two claims a
 *  precision the baseline cannot carry. So past twenty it says "far more" and
 *  lets the figure beside it hold the truth, which is the same rule as dropping
 *  an absent figure rather than dashing it. */
const LOUD = 20

/** How many times over, or null where the ratio is too large to mean anything.
 *  Never `1.0×`: a movement that rounds to unchanged has no business being
 *  printed beside a sentence saying it moved — which is why the callers gate on
 *  `MOVE` before they ever get here. */
function times(now: number, was: number): string | null {
  const ratio = now / was
  if (ratio >= LOUD) return null
  return ratio >= 10 ? `${Math.round(ratio)}×` : `${(Math.round(ratio * 10) / 10).toFixed(1)}×`
}

function share(ms: number, total: number): number {
  return total > 0 ? ms / total : 0
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** What a statement is called on a board that has no room for it.
 *
 *  Its tables, because that is what a reader recognises — and the statement
 *  itself where ClickHouse attributed it to none, which is the ordinary case for
 *  a `SYSTEM` command. Never the SQL: sixty characters of a normalised statement
 *  is a fragment nobody can place. */
export function subjectOf(move: CostMove): string {
  const first = move.tables[0]
  if (first && move.tables.length === 1) return first
  if (first) {
    return `${first} and ${move.tables.length - 1} other${move.tables.length === 2 ? '' : 's'}`
  }
  return move.kind === 'Select' ? 'a statement' : `a ${move.kind.toUpperCase()}`
}

/** Statements that have started costing what they did not cost.
 *
 *  Both gates are needed and neither is enough. The share gate alone would
 *  report the three statements that always dominate this server, every day,
 *  forever — a board that repeats yesterday's answer is furniture. The movement
 *  gate alone would report a query that went from four milliseconds to twelve. */
export function costHeadlines(report: NewsReport): Headline[] {
  const total = report.totals?.ms_now ?? 0
  const covered = report.prior_windows_covered
  return report.cost
    .flatMap((move): Headline[] => {
      const held = share(move.ms_now, total)
      if (held < SHARE) return []
      const was = usual(move.prior_ms, covered)
      if (was === null) return []
      const rank: Rank = held >= DOMINATES ? 'act' : 'watch'
      const base = {
        id: `cost:${move.hash}`,
        kind: 'cost' as const,
        rank,
        subject: subjectOf(move),
        figure: `${percent(held)} of the time spent`,
        to: '/diagnose',
      }
      if (was === 0) {
        return [
          {
            ...base,
            says: `was not being queried like this before, and now holds ${percent(
              held,
            )} of the time this server spent — ${count(move.runs_now)} run${
              move.runs_now === 1 ? '' : 's'
            }`,
          },
        ]
      }
      if (move.ms_now >= was * MOVE) {
        const over = times(move.ms_now, was)
        return [
          {
            ...base,
            says: `cost ${
              over ? `${over} what it usually costs` : 'far more than it usually costs'
            }, and holds ${percent(held)} of the time this server spent`,
          },
        ]
      }
      return []
    })
    .slice(0, PER_KIND)
}

/** Errors that are new, or that have multiplied.
 *
 *  Not "errors happened" — a server with users has errors every day, and a board
 *  that lights up for the daily background of somebody mistyping a column name
 *  is one people learn to stop reading. */
export function failureHeadlines(report: NewsReport): Headline[] {
  const covered = report.prior_windows_covered
  return report.failures
    .flatMap((move): Headline[] => {
      if (move.now < FAILURES) return []
      const was = usual(move.prior, covered)
      if (was === null) return []
      const base = {
        id: `failure:${move.code}`,
        kind: 'failure' as const,
        subject: move.name,
        figure: `${exact(move.now)} failed`,
        to: '/diagnose',
      }
      if (was === 0) {
        return [
          {
            ...base,
            rank: 'act' as const,
            // The count is in the figure beside this. Saying it twice on one row
            // reads as two facts that happen to agree.
            says: 'started failing statements that were not failing before',
          },
        ]
      }
      if (move.now >= was * MOVE) {
        const over = times(move.now, was)
        return [
          {
            ...base,
            rank: 'watch' as const,
            says: over
              ? `failed ${over} as many statements as it usually does`
              : 'failed far more statements than it usually does',
            // Both figures, because the sentence no longer carries the baseline
            // and a count alone cannot be reconciled against "usually".
            figure: `${exact(move.now)} against ${exact(was)} usually`,
          },
        ]
      }
      return []
    })
    .slice(0, PER_KIND)
}

/** Objects created, altered, dropped or renamed inside the window.
 *
 *  One headline rather than one per statement. A schema migration is twelve
 *  `ALTER`s and one intention, and a board that prints twelve rows has buried
 *  everything else on it under somebody's Tuesday afternoon. What the row owes
 *  the reader is the shape — and a `DROP`, named, because that is the one nobody
 *  wants to find out about a week later. */
export function structureHeadlines(report: NewsReport): Headline[] {
  if (report.structure_total === 0) return []
  const dropped = report.structure.filter((c) => c.kind === 'Drop')
  const created = report.structure.filter((c) => c.kind === 'Create').length
  const altered = report.structure.filter((c) => c.kind === 'Alter').length
  const renamed = report.structure.filter((c) => c.kind === 'Rename').length

  const parts: string[] = []
  if (created) parts.push(`${created} created`)
  if (altered) parts.push(`${altered} altered`)
  if (dropped.length) parts.push(`${dropped.length} dropped`)
  if (renamed) parts.push(`${renamed} renamed`)

  const names = dropped.flatMap((c) => c.tables).filter(Boolean)
  // The list is capped and the count is not, so nothing read off the list may
  // be stated about the whole — a sentence that counts what the list below it
  // does not show is a sentence nobody can reconcile. Naming the person is the
  // trap here: one user in the fifty statements that came back is not one user
  // in the two hundred that ran.
  const capped = report.structure_total > report.structure.length
  const people = new Set(report.structure.map((c) => c.user))
  const by = !capped && people.size === 1 ? `, by ${[...people][0]}` : ''

  return [
    {
      id: 'structure',
      kind: 'structure',
      rank: dropped.length ? 'act' : 'note',
      subject: 'The schema',
      says: names.length ? `changed — ${dropList(names)} dropped${by}` : `changed — ${parts.join(', ')}${by}`,
      figure: capped
        ? `${report.structure.length} of ${exact(report.structure_total)} statements`
        : `${exact(report.structure_total)} statement${
            report.structure_total === 1 ? '' : 's'
          }`,
      to: '/infra/schema',
    },
  ]
}

/** Two names, then a count. `a and b`, `a, b and 3 more` — never the `a and b
 *  and 1 more` that joining a slice with "and" produces, which reads as three
 *  clauses of one list and was on the screen before it was fixed. */
function dropList(names: string[]): string {
  if (names.length === 1) return names[0] ?? ''
  const [first, second] = names
  if (names.length === 2) return `${first} and ${second}`
  return `${first}, ${second} and ${names.length - 2} more`
}

/** Where a table's own page is. Data, by the URL rule — a table that stopped
 *  taking rows is a fact about the data, whatever it took an operator to cause. */
function tableAt(qualified: string): string {
  const cut = qualified.indexOf('.')
  if (cut < 0) return '/server'
  const database = qualified.slice(0, cut)
  const table = qualified.slice(cut + 1)
  return `/db/${encodeURIComponent(database)}/${encodeURIComponent(table)}`
}

/** Tables that stopped being written to, started being written to, or moved.
 *
 *  Stopped first, always. It is the failure that is invisible everywhere else:
 *  the table keeps serving reads and every dashboard on it keeps drawing, so the
 *  first symptom of a dead ingest is somebody asking why last week's number has
 *  not moved. Nothing else in Flint would have said it. */
export function volumeHeadlines(report: NewsReport): Headline[] {
  if (!report.volume.available) return []
  const covered = report.volume.prior_windows_covered
  const stopped: Headline[] = []
  const moved: Headline[] = []
  const arrived: Headline[] = []

  for (const table of report.volume.tables) {
    const was = usual(table.prior_rows, covered)
    if (was === null) continue
    const base = {
      id: `volume:${table.qualified}`,
      kind: 'volume' as const,
      subject: table.qualified,
      to: tableAt(table.qualified),
    }
    if (table.rows_now === 0) {
      // A median above zero *is* the regularity test: more than half the
      // periods had rows, so this is a table that was being written and is
      // not. A table loaded once and never again has a median of zero and
      // never reaches here.
      if (was > 0) {
        stopped.push({
          ...base,
          rank: 'act',
          says: 'was written to on most of the days before this one, and took nothing',
          figure: `usually ${count(was)} rows`,
        })
      }
      continue
    }
    if (was === 0) {
      // Only where every covered period really was empty. A table written once
      // in six days also has a median of zero, and calling that a first arrival
      // would be a sentence contradicted by the page it links to.
      if (table.prior_rows.slice(0, covered).every((n) => n === 0)) {
        arrived.push({
          ...base,
          rank: 'note',
          says: 'took its first rows in this window',
          figure: `${count(table.rows_now)} rows, ${bytes(table.bytes_now)}`,
        })
      }
      continue
    }
    if (table.rows_now >= was * MOVE) {
      const over = times(table.rows_now, was)
      moved.push({
        ...base,
        rank: 'watch',
        says: over
          ? `took ${over} the rows it usually takes`
          : 'took far more rows than it usually takes',
        figure: `${count(table.rows_now)} against ${count(was)}`,
      })
    } else if (table.rows_now * MOVE <= was) {
      // No multiplier on the way down. "Three times fewer" is not a quantity
      // anybody parses, and the two figures beside it are exact.
      moved.push({
        ...base,
        rank: 'watch',
        says: 'took a fraction of the rows it usually takes',
        figure: `${count(table.rows_now)} against ${count(was)}`,
      })
    }
  }

  return [...stopped, ...moved, ...arrived].slice(0, PER_KIND + 1)
}

/** Every reading, ranked, or the reason there is none.
 *
 *  Ranked across the kinds rather than grouped by them: a dead ingest and a
 *  dropped table are the same urgency to the person reading, and filing them
 *  under two headings makes that a comparison they have to do themselves. */
export function read(report: NewsReport | undefined): Read {
  if (!report) return { headlines: [], blocked: null }
  if (!report.available) {
    return {
      headlines: [],
      blocked:
        report.reason ??
        'nothing on this server recorded what happened, so there is nothing to compare',
    }
  }
  if (report.prior_windows_covered < MIN_HISTORY) {
    return {
      headlines: [],
      blocked: `system.query_log holds ${
        report.prior_windows_covered === 0 ? 'less than one window' : 'too little'
      } before this one, so there is no usual to compare against yet`,
    }
  }
  const order: Record<Rank, number> = { act: 0, watch: 1, note: 2 }
  const headlines = [
    ...volumeHeadlines(report),
    ...costHeadlines(report),
    ...failureHeadlines(report),
    ...structureHeadlines(report),
  ].sort((a, b) => order[a.rank] - order[b.rank])
  return { headlines, blocked: null }
}

/** What the comparison actually stood on, for the caption beside the heading.
 *
 *  The second half is never a claim about the window that was *asked* for. The
 *  log's own retention is the real reach, and a caption quoting six days over a
 *  log holding two is precisely the defect this sentence exists to prevent — so
 *  it counts the periods that came back covered and nothing else. */
export function reach(report: NewsReport): string {
  const covered = report.prior_windows_covered
  const window =
    report.window_hours === 24 ? 'The last 24 hours' : `The last ${report.window_hours} hours`
  if (covered === 0) return window
  const unit = report.window_hours === 24 ? 'day' : `${report.window_hours}-hour period`
  return `${window}, against the ${covered} ${unit}${covered === 1 ? '' : 's'} before`
}
