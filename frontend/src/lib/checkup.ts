/** One verdict over a whole server: what to change, and what it gives back.
 *
 *  Called a checkup and not an audit, which is the word for it, because
 *  `/infra/audit` is already the audit *trail* — who did what — and two pages
 *  with one name is how somebody ends up on the wrong one. `Reports` was taken
 *  too, by the ones that run on a schedule.
 *
 *  Flint had a great deal of analysis and no way to be *asked*. The schema
 *  review is per table, the projection advisor is per table, the storage
 *  reading is per disk, and every one of them answers well — to somebody who
 *  already knew to go and look. This is the page for somebody who does not:
 *  connect a server, and be told.
 *
 *  ## Nothing here measures anything
 *
 *  Every figure comes from a report the backend already produces. This file
 *  *judges* — which is the split the codebase keeps everywhere: Rust measures
 *  against `system.*`, and a pure module here decides what the numbers mean,
 *  where the decision can be argued with in a test. So the audit is a
 *  composition rather than a new scan, and adding a finding is a function
 *  rather than a query.
 *
 *  ## There is no score
 *
 *  The one thing this page must not do is add a gigabyte to a second. A
 *  "health score of 72" is a number nobody can reconstruct, disagree with, or
 *  act on, and it hides exactly the trade-off the reader came to make. So a
 *  finding carries **what acting gives back, in its own unit**, and findings
 *  are only ever ranked against others in the same unit.
 *
 *  What *is* comparable across units is whether something is already going
 *  wrong. A failing insert and a wasteful column are not two points on one
 *  scale; they are two different questions, and the first one is not a
 *  trade-off. Hence `urgency`, which has two values and not five. */

import type { Heavy } from './api'
import { saysCost, saysTable, trustworthy, type ColdReport } from './cold'
import { bytes } from './format'
import { nameOf, notable, saysCaveat, saysSpender, type SpendReport } from './spend'
import type { BackupReport } from './backups'
import type { QueryReport, StorageReport, TrafficReport } from './diagnose'
import { partitionVerdict } from './diagnose'
import type { DetachedReport } from './parts'

/** Which question a finding belongs to. The reader's four, not Flint's
 *  module list. */
export type Area = 'schema' | 'queries' | 'server' | 'risk'

export const AREAS: { id: Area; label: string; lead: string }[] = [
  {
    id: 'server',
    label: 'The server',
    lead: 'What the machine is doing, and what it is close to.',
  },
  {
    id: 'queries',
    label: 'The workload',
    lead: 'What the statements cost, what failed, and what would have served them.',
  },
  { id: 'schema', label: 'The schema', lead: 'Where the bytes are, and what holds them.' },
  { id: 'risk', label: 'What is not covered', lead: 'Nothing is wrong yet.' },
]

/** What acting on a finding gives back.
 *
 *  A tagged union rather than a number, so nothing can accidentally sum two
 *  kinds. `none` is not zero — it is a finding whose worth is not a quantity,
 *  and printing `0` beside it would be a claim that acting is worthless. */
export type Gain =
  | { kind: 'bytes'; n: number }
  | { kind: 'seconds'; n: number }
  | { kind: 'rows'; n: number }
  | { kind: 'none' }

/** Whether this is already costing something, or would prevent something.
 *
 *  Two values on purpose. A five-level severity invites a weighted sum, which
 *  is the score this page refuses to produce. */
export type Urgency = 'now' | 'worth'

export interface Finding {
  /** Stable across runs, so two reports can be compared and a finding can be
   *  put away. Built from what the finding is *about*, never from its wording
   *  — a sentence Flint rewrites should not read as a new problem. */
  id: string
  area: Area
  urgency: Urgency
  /** The claim, in one line. */
  title: string
  /** Why it is a claim, in words. */
  why: string
  /** The numbers it rests on, verbatim, so the reader can disagree. */
  evidence: string
  gain: Gain
  /** The object this is about, where there is one. */
  object?: string
  /** Where the control that acts on it lives. A link and never a button: this
   *  page reports, and the page that owns the action owns its confirmation,
   *  its tier and its wording. */
  act?: { to: string; label: string }
}

/* ── The judges ─────────────────────────────────────────────────────────────
 *
 * One per report the page fetches. Each takes what the backend measured and
 * returns what it thinks, and each is a place to argue in a test. */

/** Error codes that mean *the statement was wrong*, not the server.
 *
 *  This distinction is what keeps the page believable, and it was forced by
 *  pointing it at a real server: the first run reported 2,368
 *  `UNKNOWN_IDENTIFIER` and 52 `SYNTAX_ERROR` as things happening now. They
 *  were, in the sense that they happened — and every one of them was somebody
 *  typing in an editor. A checkup that opens with eight rows of other people's
 *  typos is a checkup nobody reads to the end, and the real refusal underneath
 *  them goes unread with it.
 *
 *  A denylist rather than an allowlist of the interesting ones, and that
 *  direction is deliberate: ClickHouse adds error codes, and a code Flint has
 *  never heard of is far more likely to be a genuine problem than a new way of
 *  mistyping. So an unknown code is reported, and only the ones known to be a
 *  client's mistake are folded away. */
const MALFORMED = new Set([
  6, // CANNOT_PARSE_TEXT
  27, // CANNOT_PARSE_INPUT_ASSERTION_FAILED — a row of a file the table refused
  38, // CANNOT_PARSE_DATE
  41, // CANNOT_PARSE_DATETIME
  42, // NUMBER_OF_ARGUMENTS_DOESNT_MATCH
  43, // ILLEGAL_TYPE_OF_ARGUMENT
  44, // ILLEGAL_COLUMN
  46, // UNKNOWN_FUNCTION
  47, // UNKNOWN_IDENTIFIER
  53, // TYPE_MISMATCH
  60, // UNKNOWN_TABLE
  62, // SYNTAX_ERROR
  72, // CANNOT_PARSE_NUMBER
  81, // UNKNOWN_DATABASE
  184, // ILLEGAL_AGGREGATION
  215, // NOT_AN_AGGREGATE
  352, // AMBIGUOUS_COLUMN_NAME
  376, // CANNOT_PARSE_UUID
  394, // QUERY_WAS_CANCELLED — somebody pressed stop
  456, // UNKNOWN_QUERY_PARAMETER
  457, // BAD_QUERY_PARAMETER
])

/** Failures and cost, from the query log.
 *
 *  Two different readings of one report, and they are kept apart because they
 *  answer different questions. A statement that *failed* is not a statement
 *  that was slow, and grouping them by "worst" would bury a hundred silent
 *  exceptions under one heavy report. */
export function fromQueries(report: QueryReport): Finding[] {
  if (!report.available) return []
  const out: Finding[] = []

  const refused = report.failures.filter((f) => !MALFORMED.has(f.code))
  const mistyped = report.failures.filter((f) => MALFORMED.has(f.code))

  for (const failure of refused.slice(0, 8)) {
    out.push({
      id: `queries:failure:${failure.code}`,
      area: 'queries',
      // The server refused, ran out, or somebody could not get in. Whether it
      // matters is the reader's call, but it is not a trade-off they have to
      // weigh — it is already happening.
      urgency: 'now',
      title: `${failure.name} — ${failure.occurrences} time${failure.occurrences === 1 ? '' : 's'}`,
      why: failure.message,
      evidence: `Last seen ${failure.last_seen}, over the last ${report.window_days} days.`,
      gain: { kind: 'none' },
      act: { to: '/diagnose?view=queries', label: 'The statements that failed' },
    })
  }

  /* The typos, once, as a count. Kept rather than dropped — somebody asked to
     see what failed — but as one line, because thirty of them are one fact
     about how people use the server and none about the server. */
  if (mistyped.length > 0) {
    const total = mistyped.reduce((n, f) => n + f.occurrences, 0)
    const named = mistyped
      .slice(0, 3)
      .map((f) => `${f.name} ×${f.occurrences}`)
      .join(', ')
    out.push({
      id: 'queries:malformed',
      area: 'queries',
      urgency: 'worth',
      title: `${total} statements were rejected as malformed`,
      why: 'Statements the server could not read: a wrong column name, a syntax error, a cancelled query. These are people and tools, not the machine — worth a glance only if something automated is producing them.',
      evidence: `${named}${mistyped.length > 3 ? `, and ${mistyped.length - 3} more codes` : ''}. Over the last ${report.window_days} days.`,
      gain: { kind: 'none' },
      act: { to: '/diagnose?view=queries', label: 'The statements that failed' },
    })
  }

  /* The costliest shapes, and the cost is total time rather than the slowest
     run. A statement taking four seconds twice a day is not the problem a
     statement taking eighty milliseconds a million times is, and `max_ms`
     ranks them the wrong way round. */
  const costly = [...report.patterns].sort((a, b) => b.total_ms - a.total_ms).slice(0, 5)
  const totalMs = report.patterns.reduce((sum, p) => sum + p.total_ms, 0)
  for (const pattern of costly) {
    const share = totalMs > 0 ? pattern.total_ms / totalMs : 0
    // Under a twentieth of the workload is not a finding, it is a row in a
    // table — and this page is for the ones worth acting on.
    if (share < 0.05) continue
    out.push({
      id: `queries:costly:${pattern.hash}`,
      area: 'queries',
      urgency: 'worth',
      title: `One statement shape is ${Math.round(share * 100)}% of the workload's time`,
      why:
        couldHaveBeen(pattern, report.window_seconds) ??
        (pattern.tables.length > 0
          ? `It reads ${pattern.tables.join(', ')}. Whether its sorting key serves the filter it runs is the question worth asking of it.`
          : 'Whether the tables it reads are keyed for the filter it runs is the question worth asking of it.'),
      evidence: `${pattern.runs} runs, ${Math.round(pattern.total_ms)} ms altogether, p95 ${Math.round(pattern.p95_ms)} ms, ${Math.round(pattern.read_rows / Math.max(1, pattern.runs)).toLocaleString('en')} rows read per run.`,
      gain: { kind: 'seconds', n: pattern.total_ms / 1000 },
      object: pattern.tables[0],
      act: { to: '/diagnose?view=queries', label: 'What the statements cost' },
    })
  }
  return out
}

/** Objects nothing has read.
 *
 *  Held to a real threshold rather than reported wholesale: a table nobody
 *  read this week is ordinary, and a page that said so about forty of them
 *  would be one nobody reads either. What is worth a line is a table that is
 *  large *and* unread, because that is disk being paid for with nothing coming
 *  back. */
export function fromTraffic(report: TrafficReport, floorBytes = 100 * 1024 * 1024): Finding[] {
  if (!report.available) return []
  return (report.unused ?? [])
    .filter((t) => t.bytes >= floorBytes)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 8)
    .map((t) => ({
      id: `queries:unused:${t.qualified}`,
      area: 'queries',
      urgency: 'worth' as const,
      title: `Nothing has read ${t.qualified}`,
      /* Deliberately not "so drop it". The query log has a TTL and a window,
         and a table read by a monthly report is unread in a week — which is
         the mistake this finding would cost somebody their data over. */
      why: 'Not in the window the query log covers. A table read by something monthly looks exactly like this, so the log is where to check before anything else.',
      evidence: `${t.row_count} rows, ${t.bytes} bytes on disk. Last written ${t.last_write}.`,
      gain: { kind: 'bytes', n: t.bytes },
      object: t.qualified,
      act: { to: '/infra/schema', label: 'Schema' },
    }))
}

/** Partitions close to the threshold that stops inserts.
 *
 *  The verdict is the product's own — `partitionVerdict` reads the server's
 *  `parts_to_delay_insert` and `parts_to_throw_insert` rather than a number
 *  invented here, so a server tuned to tolerate more is not told it is in
 *  trouble. */
export function fromStorage(report: StorageReport): Finding[] {
  if (!report.available) return []
  return report.partitions
    .map((p) => ({ p, v: partitionVerdict(p.parts, report.thresholds) }))
    .filter(({ v }) => v.level === 'delay' || v.level === 'throw')
    .sort((a, b) => b.p.parts - a.p.parts)
    .slice(0, 8)
    .map(({ p, v }) => ({
      id: `server:parts:${p.qualified}:${p.partition_id}`,
      area: 'server' as const,
      // `throw` is inserts being refused; `delay` is inserts being slowed. Both
      // are happening, not pending.
      urgency: 'now' as const,
      title: `${p.qualified} — ${p.parts} parts in one partition`,
      why: v.says,
      evidence: `Partition ${p.partition}: ${p.parts} parts, ${p.row_count} rows, ${p.bytes} bytes. The server delays inserts at ${report.thresholds.delay_insert} and refuses them at ${report.thresholds.throw_insert}.`,
      gain: { kind: 'none' as const },
      object: p.qualified,
      act: { to: '/infra/health', label: 'Merges and parts' },
    }))
}

/** Detached parts, which are disk nothing is reading.
 *
 *  One finding for the lot rather than one each: a table with sixty detached
 *  parts is one decision, and sixty rows would bury everything else on the
 *  page. The two origins are kept apart because they mean opposite things —
 *  something a person detached is waiting for them, something ClickHouse
 *  quarantined is a fault. */
export function fromDetached(report: DetachedReport): Finding[] {
  if (!report.available || report.total === 0) return []
  const out: Finding[] = []
  if (report.quarantined > 0) {
    out.push({
      id: 'server:detached:quarantined',
      area: 'server',
      urgency: 'now',
      title: `${report.quarantined} part${report.quarantined === 1 ? '' : 's'} the server quarantined`,
      why: 'ClickHouse detached these itself, which it does when a part is broken or unexpected. Each one is rows that are on the disk and not in the table.',
      evidence: `${report.total} detached parts altogether, ${report.total_bytes} bytes.`,
      gain: { kind: 'none' },
      act: { to: '/infra/health', label: 'Detached parts' },
    })
  }
  const byHand = report.total - report.quarantined
  if (byHand > 0) {
    out.push({
      id: 'server:detached:by-hand',
      area: 'server',
      urgency: 'worth',
      title: `${byHand} part${byHand === 1 ? '' : 's'} detached by hand`,
      why: 'Somebody detached these deliberately. They still occupy the disk, and nothing reads them until they are attached again.',
      evidence: `${report.total_bytes} bytes across ${report.total} detached parts.`,
      gain: { kind: 'bytes', n: report.total_bytes },
      act: { to: '/infra/health', label: 'Detached parts' },
    })
  }
  return out
}

/** Whether anything could be put back.
 *
 *  The strongest finding this page can make, and the quietest: a server with
 *  no backup is fine every day until the one day it is not. */
export function fromBackups(report: BackupReport): Finding[] {
  /* Nothing, and that is the fix rather than an omission.
   *
   * `available: false` on this report means one thing only — Flint could not
   * *read* `system.backups`, because the account is not granted it or the build
   * has no such table. It used to be turned into "This Flint cannot take a
   * backup", with the missing grant printed underneath as the reason, which is
   * a claim about the server made out of a fact about the reader. It is also
   * one the reader can do nothing with: the answer to "you may not look" is a
   * GRANT, not a backup policy.
   *
   * The case that finding was written for is still reported, by the branch
   * below: a Flint with no destination configured reads the log fine, finds it
   * empty, and says so with `Destination: none named`. */
  if (!report.available) return []
  if (report.runs.length === 0) {
    return [
      {
        id: 'risk:backups:none',
        area: 'risk',
        urgency: 'worth',
        title: 'No backup has been taken',
        /* Hedged on purpose, and the hedge is the finding's honesty:
           `system.backups` is per-process and does not survive a restart, so
           an empty list is not proof that nothing was ever backed up. */
        why: report.persistent
          ? 'The backup log goes back further than this server has been up, and there is nothing in it.'
          : 'This server has only the in-memory list, which does not survive a restart — so a backup taken before the last restart would not appear here either way.',
        evidence: `Destination: ${report.disk || 'none named'}.`,
        gain: { kind: 'none' },
        act: { to: '/infra/backups', label: 'Backups' },
      },
    ]
  }
  return []
}

/** The bytes nothing read.
 *
 *  The strongest finding on this page, and the only one that answers *which of
 *  this disk is doing any work* — `fromHeavy` below says where the bytes are,
 *  which is a different and weaker question: a 400 GiB column somebody queries
 *  every hour is where the bytes are and is not a finding.
 *
 *  Two rules, both of them about what may be *claimed* rather than about the
 *  arithmetic, and both enforced in `lib/cold`:
 *
 *  - **The window is the log's**, not the one that was asked for. A log holding
 *    five hours cannot support a sentence about seven days.
 *  - **It never says unused.** A quarterly report reads columns that look cold
 *    for months. The gain is real and the decision is not Flint's, so the
 *    finding is where to look and the link is the table.
 *
 *  A table nothing read at all is deliberately *not* reported here. Every column
 *  of it is cold, so it would outrank every real finding by weight while saying
 *  the least — and "nobody read this table" is a sentence about the table, which
 *  the table's own page makes. This page is about columns you are paying for
 *  inside tables you are using.
 */
export function fromCold(report: ColdReport, floorBytes = 1024 * 1024 * 1024): Finding[] {
  if (!trustworthy(report).ok) return []
  return report.tables
    .filter((t) => t.reads > 0 && t.cold_bytes >= floorBytes)
    .map((t) => {
      return {
        id: `schema:cold:${t.qualified}`,
        area: 'schema' as const,
        /* Never `now`. Nothing is failing: this is disk being spent on data
           nothing asked for, which is a trade-off and not an incident. */
        urgency: 'worth' as const,
        title: `${t.qualified} — ${t.cold_columns} of ${t.columns} columns nothing read`,
        why: saysTable(t, report),
        /* The coldest few by name, then the cost in the same words the table's
           own page uses — `saysCost`, so two pages cannot phrase one figure
           two ways. `bytes` is passed in rather than imported there because
           `lib/cold` judges and `lib/format` renders, and the split is the
           one this codebase keeps everywhere. */
        evidence: `${t.coldest
          .slice(0, 3)
          .map((c) => c.name)
          .join(', ')}${
          t.cold_columns > 3 ? ` and ${t.cold_columns - 3} more` : ''
        }. ${saysCost(t, bytes) ?? ''}`.trim(),
        gain: { kind: 'bytes' as const, n: t.cold_bytes },
        object: t.qualified,
        act: {
          to: `/db/${encodeURIComponent(t.database)}/${encodeURIComponent(t.table)}?tab=columns`,
          label: 'The columns',
        },
      }
    })
}

/** Who the server is working for.
 *
 *  Never `now`: an account taking most of a server is not a fault, it is a fact
 *  about how the server is used, and half the time it is the correct answer —
 *  one dashboard service reading one rollup all day is a well-built pipeline.
 *  What makes it a finding is *concentration*: most of one account's time on one
 *  table is somewhere to look, and the link goes to the workload page that can
 *  say which statements.
 *
 *  The gain is seconds and it is the seconds of the *window*, not of a day: a
 *  page that mixed "4 s per run" with "18 min a week" in one column would let a
 *  reader compare two things that are not comparable. `lib/checkup` only ever
 *  ranks within a unit, which is what keeps that safe.
 */
export function fromSpend(report: SpendReport): Finding[] {
  return notable(report).map((s) => ({
    id: `queries:spend:${s.background ? '__background' : s.user}`,
    area: 'queries' as const,
    urgency: 'worth' as const,
    title: `${nameOf(s)} — ${Math.round(s.share * 100)}% of this server’s query time`,
    why: saysSpender(s, report),
    evidence: `${s.statements.toLocaleString('en')} statements, ${Math.round(s.seconds)} s of ${Math.round(report.total_seconds)} s in the window${
      s.failed ? `, ${s.failed} of them failed` : ''
    }.${saysCaveat(report) ? ` ${saysCaveat(report)}` : ''}`,
    gain: { kind: 'seconds' as const, n: s.seconds },
    object: s.busiest_table || undefined,
    act: { to: '/diagnose', label: 'What the statements cost' },
  }))
}

/** Where the bytes are.
 *
 *  This one deliberately makes no proposal. Knowing a column is a `String`
 *  occupying 40 GB does not say it is the wrong type — that takes reading the
 *  values, which the schema review does and this page has not been asked to
 *  do. So the finding is *where to look*, with the figure that makes it worth
 *  looking, and the link is to the reading that measures it. Saying more than
 *  the metadata supports would be the one thing this page cannot afford. */
export function fromHeavy(reports: Heavy[], floorBytes = 1024 * 1024 * 1024): Finding[] {
  return reports
    .flatMap((r) =>
      r.columns.map((c) => ({ database: r.database, column: c })),
    )
    .filter(({ column }) => column.compressed >= floorBytes)
    .sort((a, b) => b.column.compressed - a.column.compressed)
    .slice(0, 10)
    .map(({ database, column }) => ({
      id: `schema:heavy:${database}.${column.table}.${column.column}`,
      area: 'schema' as const,
      urgency: 'worth' as const,
      title: `${column.column} in ${database}.${column.table} holds ${column.compressed} bytes`,
      why: `A ${column.type}. Whether that is the right type for what is in it is a question about the values, which the schema review answers by reading them.`,
      evidence: `${column.compressed} bytes compressed, ${column.uncompressed} uncompressed.`,
      gain: { kind: 'bytes' as const, n: column.compressed },
      object: `${database}.${column.table}`,
      act: {
        to: `/db/${encodeURIComponent(database)}/${encodeURIComponent(column.table)}?tab=review`,
        label: 'Measure this table',
      },
    }))
}

/* ── Putting them in order ──────────────────────────────────────────────── */

/** Everything happening now, then everything worth doing, biggest first
 *  *within its own unit*.
 *
 *  The two-step is the whole ranking, and it is as far as an honest one goes.
 *  Inside `now` the order is arbitrary and says so by being stable rather than
 *  sorted: those are failures, and Flint has no basis for telling somebody
 *  which of their failures matters more. Inside `worth`, findings are compared
 *  only against others measured in the same unit, and a finding with no
 *  quantity sorts after the ones that have one — not because it matters less,
 *  but because there is nothing to place it by. */
export function rank(findings: Finding[]): Finding[] {
  const weight = (g: Gain) => (g.kind === 'none' ? -1 : g.n)
  return [...findings].sort((a, b) => {
    if (a.urgency !== b.urgency) return a.urgency === 'now' ? -1 : 1
    if (a.urgency === 'now') return 0
    if (a.gain.kind !== b.gain.kind) return a.gain.kind === 'none' ? 1 : -1
    return weight(b.gain) - weight(a.gain)
  })
}

export function inArea(findings: Finding[], area: Area): Finding[] {
  return rank(findings.filter((f) => f.area === area))
}

/** The lead sentence: what the report found, in one line.
 *
 *  It counts what is happening now and what is worth doing separately, because
 *  they are different offers — one is "go and look", the other is "when you
 *  have time". A single total would flatten them into a number that reads as a
 *  grade. */
export function saysReport(findings: Finding[], stillReading: number): string {
  const now = findings.filter((f) => f.urgency === 'now').length
  const worth = findings.length - now
  const tail = stillReading > 0 ? ` ${stillReading} more still reading.` : ''
  if (findings.length === 0) {
    return stillReading > 0
      ? `Reading ${stillReading} things about this server.`
      : 'Nothing on this server is asking to be changed.'
  }
  const parts: string[] = []
  if (now > 0) parts.push(`${now} ${now === 1 ? 'thing is' : 'things are'} happening now`)
  if (worth > 0) parts.push(`${worth} ${worth === 1 ? 'is' : 'are'} worth doing`)
  return `${parts.join(', ')}.${tail}`
}

/* ── A traffic session ──────────────────────────────────────────────────────
 *
 * The reading this page was asked for first: mark a moment, go and exercise
 * the application, come back and see *those* calls rather than the week around
 * them. A QA pass over a frontend puts hundreds of statements through a server
 * in ten minutes, and a seven-day window buries every one of them.
 *
 * The mark is a timestamp and nothing else, which is what lets this work with
 * no workspace: there is no session object anywhere, only a moment the browser
 * remembers and a window computed from it when the reader comes back. It
 * survives a reload because the whole point is to leave the tab and come back
 * to it. */

/** Where the mark is kept. The browser's, not the server's — see above. */
export const SESSION_KEY = 'flint.checkup.session'

/** A window in seconds from a mark, or null where there is no mark.
 *
 *  Rounded up rather than down: a session of 90 seconds asked for as 90 can
 *  miss the last statement, because the server writes the log row after the
 *  statement ends and the clocks are not the same clock. A second of slack
 *  costs nothing and the alternative is a missing row nobody can explain. */
export function sessionWindow(startedAt: number | null, now = Date.now()): number | null {
  if (startedAt === null) return null
  return Math.max(60, Math.ceil((now - startedAt) / 1000) + 1)
}

/** How long a session has been running, in words a reader would use. */
export function saysSession(startedAt: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - startedAt) / 1000))
  if (secs < 90) return `${secs} seconds`
  const mins = Math.round(secs / 60)
  if (mins < 90) return `${mins} minutes`
  return `${(secs / 3600).toFixed(1)} hours`
}

/** Whether a statement could have been asked differently.
 *
 *  The question the session exists to answer, and the one place this file
 *  comes close to advice. It is deliberately narrow: three readings, each
 *  computable from what `system.query_log` already recorded, and none of them
 *  requiring Flint to understand the statement.
 *
 *  What it will not do is guess at SQL. "This should have a `LIMIT`" needs to
 *  know whether the statement has one, and finding that out means parsing —
 *  which this codebase refuses everywhere and would get wrong on the first
 *  statement with a subquery. So every reading here is arithmetic over
 *  measurements. */
export function couldHaveBeen(
  pattern: {
    read_rows: number
    read_bytes: number
    runs: number
    total_ms: number
    tables: string[]
  },
  windowSeconds: number,
): string | null {
  const perRun = pattern.runs > 0 ? pattern.read_rows / pattern.runs : 0
  const perSecond = windowSeconds > 0 ? pattern.runs / windowSeconds : 0

  /* A million rows read per run, on a server that answers in milliseconds, is
     the shape of a scan. It is not proof of one — a genuine aggregate over a
     million rows reads a million rows — which is why this says "worth asking"
     rather than "wrong". */
  if (perRun >= 1_000_000) {
    return `Each run reads about ${Math.round(perRun).toLocaleString('en')} rows. If it filters on something that is not a prefix of the sorting key, that is a scan the key could have avoided.`
  }

  /* Asked in a loop: the most common thing a QA pass over a frontend reveals,
     and the reason the session exists.

     A *rate*, not a count, and that is the whole reason the window is a
     parameter: 120 runs of one shape is a loop inside a minute and is nothing
     at all across a week. Only a session can tell those apart.

     The first version of this looked for few rows per run instead, and it
     could never have fired. Measured on a real point lookup returning three
     rows: `read_rows` was **25,600** — three granules, because in ClickHouse
     the floor for a read is a granule and never a row. A rows-per-run
     threshold is a threshold about the server's block size, not about the
     statement. */
  if (perSecond >= 0.5 && pattern.runs >= 20) {
    const rate =
      perSecond >= 1 ? `${Math.round(perSecond)} a second` : 'about one every two seconds'
    return `${pattern.runs} runs — ${rate}. That is the shape of a question asked once per item, which one statement with an IN or a JOIN would answer in a single pass.`
  }

  /* Cheap each time and enormous in total. Nothing is wrong with any one run;
     the finding is that the total is worth a cache or a materialised view. */
  if (pattern.runs >= 500 && pattern.total_ms / pattern.runs < 50) {
    return `${pattern.runs} runs averaging ${Math.round(pattern.total_ms / pattern.runs)} ms. Each one is cheap and there are a great many — a materialised view or a cache in front of it would give back the total rather than the average.`
  }
  return null
}
