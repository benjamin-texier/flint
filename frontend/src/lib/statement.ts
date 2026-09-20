/** One statement, read back as sentences.
 *
 *  `src/clickhouse/statement.rs` carries the row whole and has no opinion about
 *  any of it — the split every reading in Flint follows. This decides what may
 *  be *said*, and the whole of it is arithmetic over figures the server wrote
 *  down while the statement ran. Nothing here re-plans, predicts or
 *  recommends: a page about one call that had already happened is the last
 *  place a guess belongs, because the reader can check every number on it.
 *
 *  Two things make this different from `plan.ts`, which answers a question that
 *  sounds identical.
 *
 *  **A plan is a hypothesis and these are facts.** `EXPLAIN PLAN indexes = 1`
 *  asked today re-plans against today's parts, so it answers about a table that
 *  has merged and grown since the statement ran. `SelectedMarks` against
 *  `SelectedMarksTotal` is what the server actually skipped, on the run being
 *  read. Where a page shows both, it has to say which is which, and the words
 *  here are past tense for that reason.
 *
 *  **The counters are not a plan.** They say how much was skipped and never by
 *  what: there is no index name in `ProfileEvents`. So the sentences below stop
 *  at the arithmetic — "three of eleven parts were read" — and the page offers
 *  the plan alongside for somebody who wants to know which key did it. Saying
 *  "the primary key narrowed this" from a counter would be inventing the one
 *  part the log does not record.
 */

import { bytes, count, exact, times } from './format'
import type { Tone, Used, Verdict } from './plan'

export interface Counter {
  name: string
  value: number
}

export interface Setting {
  name: string
  value: string
}

export interface Stage {
  name: string
  micros: number
  input_rows: number
  input_bytes: number
  output_rows: number
  output_bytes: number
  processors: number
}

export interface Shape {
  hash: string
  runs: number
  median_ms: number
  p95_ms: number
  max_ms: number
  failures: number
  window_days: number
}

export interface Statement {
  query_id: string
  outcome: string
  kind: string
  started: string
  at: string
  duration_ms: number
  user: string
  query: string
  database: string
  tables: string[]
  columns: string[]
  projections: string[]
  views: string[]
  row_policies: string[]
  read_rows: number
  read_bytes: number
  written_rows: number
  written_bytes: number
  result_rows: number
  result_bytes: number
  memory_usage: number
  peak_threads: number
  query_cache: string
  exception_code: number
  exception: string
  via_flint: boolean
  log_comment: string
  hash: string
  events: Counter[]
  settings: Setting[]
  flint_settings: number
}

export interface StatementReport {
  available: boolean
  reason?: string
  window_days: number
  statement: Statement | null
  running: boolean
  stages: { items: Stage[]; blocked?: string }
  shape?: Shape
}

/** A counter, or zero where the server did not record it.
 *
 *  Zero and absent are deliberately not told apart *here* — every counter this
 *  module reads is a count of something that happened, so "did not happen" and
 *  "was not counted" produce the same sentence, which is silence. The one place
 *  the difference matters is a ratio, and those check the denominator instead.
 */
export function counter(statement: Statement, name: string): number {
  return statement.events.find((c) => c.name === name)?.value ?? 0
}

/** A setting this statement carried, if it carried one. */
export function setting(statement: Statement, name: string): string | null {
  return statement.settings.find((s) => s.name === name)?.value ?? null
}

function used(statement: Statement, part: string, whole: string): Used | null {
  const total = counter(statement, whole)
  if (total <= 0) return null
  return { used: counter(statement, part), total }
}

/** What the server skipped, as it recorded it while running.
 *
 *  Null where the totals are absent, which is every statement that read no
 *  MergeTree table: a `SELECT 1`, a read of a dictionary, an insert of
 *  literals. An empty reading is not a reading of zero.
 */
export function pruning(statement: Statement): {
  parts: Used | null
  marks: Used | null
  ranges: number
} {
  return {
    parts: used(statement, 'SelectedParts', 'SelectedPartsTotal'),
    marks: used(statement, 'SelectedMarks', 'SelectedMarksTotal'),
    ranges: counter(statement, 'SelectedRanges'),
  }
}

/** The named phases before execution, in microseconds.
 *
 *  ClickHouse counts five of them and they do **not** add up to the duration:
 *  everything after the pipeline is built is execution, which no counter
 *  records. So the remainder is computed rather than read, and it is named
 *  *execution* rather than *other* — it is the part that did the work, and on
 *  almost every statement worth looking at it is all of it.
 *
 *  A negative remainder is possible and is clamped to zero rather than
 *  printed: the counters are microseconds and the duration is milliseconds, so
 *  a sub-millisecond statement can round to a duration smaller than the phases
 *  it is made of. A bar that goes backwards is worse than one that stops.
 */
export function phases(statement: Statement): { name: string; micros: number }[] {
  const named: [string, string][] = [
    ['Parsing', 'QueryParseMicroseconds'],
    ['Analysis', 'QueryAnalysisMicroseconds'],
    ['Planning', 'QueryPlanBuildMicroseconds'],
    ['Optimising the plan', 'QueryPlanOptimizeMicroseconds'],
    ['Building the pipeline', 'QueryPipelineBuildMicroseconds'],
  ]
  const out = named
    .map(([name, key]) => ({ name, micros: counter(statement, key) }))
    .filter((p) => p.micros > 0)
  if (out.length === 0) return []
  const before = out.reduce((n, p) => n + p.micros, 0)
  const execution = Math.max(0, statement.duration_ms * 1000 - before)
  return [...out, { name: 'Execution', micros: execution }]
}

/** The counters worth a table, in the order they answer questions.
 *
 *  A statement carries anywhere from a dozen to two hundred of them and the
 *  page shows the rest folded. This list is the judgement about which ones a
 *  reader is served by seeing first — and, like every other cap in the
 *  product, the page states how many it left out rather than implying this is
 *  all of them.
 */
export const NOTABLE = [
  'SelectedParts',
  'SelectedPartsTotal',
  'SelectedMarks',
  'SelectedMarksTotal',
  'SelectedRanges',
  'SelectedRows',
  'SelectedBytes',
  'OSCPUVirtualTimeMicroseconds',
  'RealTimeMicroseconds',
  'UserTimeMicroseconds',
  'SystemTimeMicroseconds',
  'OSCPUWaitMicroseconds',
  'MarkCacheHits',
  'MarkCacheMisses',
  'QueryConditionCacheHits',
  'QueryConditionCacheMisses',
  'NetworkSendBytes',
  'NetworkReceiveBytes',
  'ReadCompressedBytes',
  'FileOpen',
]

export function notable(statement: Statement): Counter[] {
  const wanted = new Set(NOTABLE)
  return statement.events.filter((c) => wanted.has(c.name))
}

/** How much of the window's reading this run skipped, as a share. */
function shareOf(u: Used): number {
  return u.total > 0 ? u.used / u.total : 1
}

function pct(share: number): string {
  const n = share * 100
  // Same rule as everywhere else a percentage is printed next to the figures
  // it came from: never round a real difference away to 0% or 100%.
  if (n > 0 && n < 1) return '<1%'
  if (n < 100 && n > 99) return '>99%'
  return `${Math.round(n)}%`
}

/** A cache hit rate, where the statement touched that cache at all. */
export function hitRate(statement: Statement, hits: string, misses: string): Used | null {
  const h = counter(statement, hits)
  const m = counter(statement, misses)
  return h + m > 0 ? { used: h, total: h + m } : null
}

/** How this run compares with its own shape.
 *
 *  Below five runs there is no comparison to make and this says nothing: a
 *  median of two is one of the two, and telling somebody their statement was
 *  "twice the median" of a pair is a sentence with no information in it.
 */
export function againstShape(statement: Statement, shape: Shape | undefined): Verdict | null {
  if (!shape || shape.runs < 5 || shape.median_ms <= 0) return null
  const ratio = statement.duration_ms / shape.median_ms
  const many = `${count(shape.runs)} runs in ${shape.window_days} days`
  if (ratio >= 2) {
    return {
      tone: 'cost',
      text: `This run took ${times(ratio)} what this shape normally takes.`,
      evidence: `${exact(Math.round(statement.duration_ms))} ms against a median of ${exact(Math.round(shape.median_ms))} ms over ${many}`,
    }
  }
  if (ratio <= 0.5) {
    return {
      tone: 'note',
      text: 'This run was faster than this shape normally is, so it is not the one to read for what the shape costs.',
      evidence: `${exact(Math.round(statement.duration_ms))} ms against a median of ${exact(Math.round(shape.median_ms))} ms over ${many}`,
    }
  }
  return {
    tone: 'note',
    text: 'This run is about what this shape normally costs, so it is a fair one to read.',
    evidence: `${exact(Math.round(statement.duration_ms))} ms against a median of ${exact(Math.round(shape.median_ms))} ms over ${many}`,
  }
}

/** The floor under any read of a MergeTree table.
 *
 *  ClickHouse reads whole granules, so a filter matching one row still reads
 *  its granule, and every part that matches contributes at least one. The
 *  projection advisor states this as arithmetic rather than a caveat, and the
 *  same honesty is owed here: "it read 40,960 rows to return 250" is a
 *  complaint about a statement that could not have done better.
 */
export function granuleFloor(statement: Statement): number | null {
  const marks = counter(statement, 'SelectedMarks')
  return marks > 0 ? marks * 8192 : null
}

/** Everything that can be said about this run, most consequential first. */
export function verdicts(report: StatementReport): Verdict[] {
  const s = report.statement
  if (!s) return []
  const out: Verdict[] = []

  if (s.exception_code !== 0) {
    out.push({
      tone: 'cost',
      text: 'This statement failed.',
      // The first line only: a ClickHouse exception's tail is the statement it
      // failed on, which is already on the page above in full.
      evidence: s.exception.split('\n')[0] || `code ${s.exception_code}`,
    })
  }

  const { parts, marks } = pruning(s)
  if (marks) {
    const share = shareOf(marks)
    out.push(
      share < 1
        ? {
            tone: 'good',
            text: `It skipped ${pct(1 - share)} of the table it read: ${exact(marks.used)} of ${exact(marks.total)} granules.`,
            evidence: parts ? `${exact(parts.used)} of ${exact(parts.total)} parts` : null,
          }
        : {
            tone: 'cost',
            text: `Nothing was skipped: all ${exact(marks.total)} granules were read.`,
            evidence: parts ? `${exact(parts.used)} of ${exact(parts.total)} parts` : null,
          },
    )
  }

  // Read against returned, which is the backlog's "filtering efficiency" and
  // the one ratio that survives contact with a real log. The floor keeps it
  // from firing on a statement that read a thousand rows: reading 1,000 to
  // return 1 is a dictionary lookup, not a problem.
  if (s.result_rows > 0 && s.read_rows >= 1_000_000) {
    const ratio = s.read_rows / s.result_rows
    if (ratio >= 100) {
      const floor = granuleFloor(s)
      out.push({
        tone: 'cost',
        text: `It read ${count(s.read_rows)} rows to return ${count(s.result_rows)}.`,
        evidence:
          floor && floor >= s.read_rows
            ? `${bytes(s.read_bytes)} — and granules are read whole, so ${exact(floor)} rows is the floor for the ${exact(counter(s, 'SelectedMarks'))} it touched`
            : bytes(s.read_bytes),
      })
    }
  }
  if (s.result_rows === 0 && s.read_rows >= 1_000_000 && s.exception_code === 0) {
    out.push({
      tone: 'note',
      text: `It read ${count(s.read_rows)} rows and returned none.`,
      evidence: bytes(s.read_bytes),
    })
  }

  if (s.row_policies.length > 0) {
    out.push({
      tone: 'note',
      text: `A row policy decided what this statement could see, so its rows are not everyone's: ${s.row_policies.join(', ')}.`,
      evidence: null,
    })
  }

  if (s.projections.length > 0) {
    out.push({
      tone: 'good',
      text: `A projection answered it rather than the table: ${s.projections.join(', ')}.`,
      evidence: null,
    })
  }

  // Planning that is a real share of a short statement. Both halves matter: ten
  // milliseconds of planning under a four-minute scan is noise, and the same
  // ten under a twelve-millisecond statement is nearly all of it.
  const ph = phases(s)
  const execution = ph.find((p) => p.name === 'Execution')
  if (execution && s.duration_ms > 0) {
    const before = ph.filter((p) => p.name !== 'Execution').reduce((n, p) => n + p.micros, 0)
    const share = before / (s.duration_ms * 1000)
    if (share >= 0.3) {
      out.push({
        tone: 'note',
        text: `Most of this statement was spent getting ready to run it, not running it: ${pct(share)} went on parsing, analysis and planning.`,
        evidence: `${exact(Math.round(before / 1000))} ms of ${exact(s.duration_ms)} ms`,
      })
    }
  }

  const memory = setting(s, 'max_memory_usage')
  if (memory && Number(memory) > 0 && s.memory_usage > 0) {
    const share = s.memory_usage / Number(memory)
    if (share >= 0.8) {
      out.push({
        tone: 'cost',
        text: 'It came close to the memory it was allowed, which is the shape of a statement that fails on a busier day.',
        evidence: `${bytes(s.memory_usage)} of ${bytes(Number(memory))}`,
      })
    }
  }

  const marksCache = hitRate(s, 'MarkCacheHits', 'MarkCacheMisses')
  if (marksCache && marksCache.total >= 100 && shareOf(marksCache) < 0.5) {
    out.push({
      tone: 'note',
      text: `It missed the mark cache more often than it hit it, so it was reading index marks off the disk: ${exact(marksCache.used)} of ${exact(marksCache.total)}.`,
      evidence: null,
    })
  }

  const against = againstShape(s, report.shape)
  if (against) out.push(against)

  return out
}

/** The one-line verdict a list row can carry. */
export function tone(statement: Statement): Tone {
  if (statement.exception_code !== 0) return 'cost'
  return 'note'
}
