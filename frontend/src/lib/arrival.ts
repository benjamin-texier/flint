/** The order somebody meets a server they have just connected to.
 *
 *  Flint has always had a great deal to say and no opinion about what to say
 *  first. Connecting landed you on a database, which answers *what exists* —
 *  and nobody's first question on opening a tool pointed at their own server is
 *  what exists. They built it; they know. The question is whether anything in
 *  there is worth their afternoon, and until now the only way to find out was to
 *  already know which page to open.
 *
 *  ## This measures nothing and judges almost nothing
 *
 *  Every finding here is one `lib/checkup` already produces from a report the
 *  backend already serves, and every one of them is also on a page that owns it.
 *  That is the constraint the arrival is built under rather than an accident of
 *  reuse: a home that is the only place a fact appears is a home you cannot act
 *  from, because the control that acts on it lives somewhere you were never sent.
 *
 *  So what is here is **arrangement** — which of thirty true sentences goes
 *  first, how many of them fit before somebody stops reading, and what to say
 *  while the rest are still landing.
 *
 *  ## Why the order is not `rank`'s
 *
 *  `lib/checkup` ranks within an area, for a reader working through that area.
 *  This reader is meeting the server. Ranked by gain alone the list opens with
 *  eight storage rows — all true, all one insight repeated — and the failing
 *  materialized view is ninth. So failures lead, and then the opportunities are
 *  dealt round-robin across the four areas: the first five things somebody reads
 *  should be five different kinds of thing.
 */

import type { Area, Finding } from './checkup'
import { AREAS, rank } from './checkup'
import { bytes } from './format'
import { bucketOf, bucketSequence, GRAIN_LABEL, parseStamp, type Grain } from './timeline'

/** One of the things the page is waiting on, and how it went.
 *
 *  `refused` carries its reason because that is the half that keeps the page
 *  honest on a server Flint is only half granted. A section that vanishes when
 *  a grant is missing teaches the reader that Flint has nothing to say about
 *  it; one that says *which* grant teaches them what to ask their DBA for. */
export interface Reading {
  /** What it was reading, as a person would say it: "the disks", "the query log". */
  label: string
  state: 'reading' | 'read' | 'refused'
  reason?: string
}

/** The findings, in the order a first reader should meet them.
 *
 *  Failures first — those are things that are already going wrong, and no
 *  amount of disk saved outranks a write that is not landing. Then one from
 *  each area in turn, so the top of the list is a tour of the server rather
 *  than the same insight eight times.
 *
 *  Capped, and the caller says how much was left out. A list silently truncated
 *  reads as the whole truth.
 */
export function inOrder(findings: Finding[], cap = 8): Finding[] {
  const ranked = rank(findings)
  const now = ranked.filter((f) => f.urgency === 'now')

  /* One queue per area, each already in the order its own page would use, so
     dealing from them cannot produce an order that page would disagree with. */
  const queues = new Map<Area, Finding[]>(
    AREAS.map((a) => [a.id, ranked.filter((f) => f.urgency !== 'now' && f.area === a.id)]),
  )

  const dealt: Finding[] = []
  while (dealt.length + now.length < cap) {
    /* One full pass that hands out nothing means every queue is empty. Checked
       by watching the round rather than by counting what is left, because the
       queues are being mutated as we go. */
    let handed = false
    for (const area of AREAS) {
      if (dealt.length + now.length >= cap) break
      const next = queues.get(area.id)?.shift()
      if (next) {
        dealt.push(next)
        handed = true
      }
    }
    if (!handed) break
  }

  return [...now, ...dealt]
}

/** One run of the verdict sentence.
 *
 *  Prose and figures kept apart, because they are set in different faces. The
 *  token file states the rule and this is the first place it is followed inside a
 *  *sentence*: Plus Jakarta Sans speaks for the interface, JetBrains Mono speaks
 *  for the data — "everywhere the characters themselves are the content rather
 *  than a label for it". A count in a verdict is content. Setting it in the body
 *  face makes the most confident sentence in the product look like a heading. */
export interface Said {
  text: string
  /** Set in the data face. Only ever a measured figure. */
  figure?: true
}

/** The same sentence as one string — for a `title`, and for a test that is about
 *  the wording rather than the setting. */
export function plain(said: Said[]): string {
  return said.map((s) => s.text).join('')
}

/** The one sentence at the top: what this server's own state amounts to.
 *
 *  It is a *verdict*, not a count, and it speaks even when the answer is good —
 *  "nothing here is asking to be changed" is what somebody came for, and a
 *  heading that disappears when there is nothing wrong leaves them wondering
 *  whether anything ran.
 *
 *  While readings are still landing it says so instead of guessing, because a
 *  verdict that changes from "nothing wrong" to "three things are failing" four
 *  seconds after it is read is worse than one that waited.
 */
export function verdict(findings: Finding[], readings: Reading[]): Said[] {
  const pending = readings.filter((r) => r.state === 'reading').length
  const now = findings.filter((f) => f.urgency === 'now').length
  const worth = findings.length - now

  /* "One" stays prose. It is a word here, not a measurement — nobody reads
     `1 thing` as a figure they might act on, and setting it in the data face
     would make the calmest verdict the loudest-looking one. */
  if (now > 0) {
    return now === 1
      ? [{ text: 'One thing on this server is going wrong now.' }]
      : [
          { text: String(now), figure: true },
          { text: ' things on this server are going wrong now.' },
        ]
  }
  if (worth > 0) {
    return worth === 1
      ? [{ text: 'One thing here is worth changing.' }]
      : [{ text: String(worth), figure: true }, { text: ' things here are worth changing.' }]
  }
  if (pending > 0) return [{ text: 'Reading this server.' }]

  /* Nothing found — but "nothing is wrong" is only as wide as the readings
     behind it, and on a locked-down account most of them never happened. Found
     on ClickHouse's own demo server, where five of six readings are refused and
     the page cheerfully cleared a seven-terabyte machine it had barely looked
     at. The caption underneath already names which ones; the headline has to
     stop *claiming*, because the headline is the sentence people repeat.

     Half is the line, and it is a judgement rather than a measurement: below it
     the refusals are gaps in an answer, above it there is no answer to have
     gaps in. */
  const refused = readings.filter((r) => r.state === 'refused').length
  if (refused > readings.length / 2) {
    return [{ text: 'Flint could not read enough of this server to say.' }]
  }
  return [{ text: 'Nothing on this server is asking to be changed.' }]
}

/** The server's disk, as one measured line.
 *
 *  This is what stands where a row of four big figures used to. The figures were
 *  true and they were the template answer — a count of databases, a count of
 *  objects, a count of rows, a total on disk, in the same weight, none of them
 *  saying which part of the server is the *mass* of it.
 *
 *  One strip does say it, and it is the subject's own shape: a column, laid out
 *  by weight, which is the only thing ClickHouse has ever drawn. On most servers
 *  it makes one point immediately and without a word — that one database is
 *  nine tenths of the machine — and that point is the beginning of every
 *  conversation about a disk.
 *
 *  Past `cap` the tail folds into one segment that counts itself, because a strip
 *  of forty two-pixel slivers is a texture rather than a measurement. Segments
 *  keep their order by weight, so the fold is always the right-hand end.
 */
export interface Stratum {
  name: string
  bytes: number
  share: number
  /** True for the folded tail. It has a count in its name and no page to open. */
  folded?: true
}

export function strata(
  items: { name: string; bytes: number }[],
  cap = 6,
): { bands: Stratum[]; total: number } {
  const weighed = items.filter((i) => i.bytes > 0).sort((a, b) => b.bytes - a.bytes)
  const total = weighed.reduce((sum, i) => sum + i.bytes, 0)
  if (total === 0) return { bands: [], total: 0 }

  const head = weighed.slice(0, cap)
  const tail = weighed.slice(cap)
  const bands: Stratum[] = head.map((i) => ({
    name: i.name,
    bytes: i.bytes,
    share: i.bytes / total,
  }))
  if (tail.length > 0) {
    const bytes = tail.reduce((sum, i) => sum + i.bytes, 0)
    bands.push({
      name: `${tail.length} more`,
      bytes,
      share: bytes / total,
      folded: true,
    })
  }
  return { bands, total }
}

/** What was read to reach that verdict, and what would not be read.
 *
 *  Both halves in one sentence, because they are one claim: a verdict is only
 *  as wide as the readings behind it, and "nothing is wrong" over four refused
 *  grants is a sentence that should be qualified where it is made and nowhere
 *  else.
 *
 *  Returns `null` when there is nothing to qualify — everything answered, and
 *  nothing is still in flight. A caption saying "read all six of six" is a line
 *  the reader has to parse in order to learn nothing.
 */
export function saysRead(readings: Reading[]): string | null {
  const reading = readings.filter((r) => r.state === 'reading')
  const refused = readings.filter((r) => r.state === 'refused')
  const parts: string[] = []

  if (reading.length > 0) {
    parts.push(
      reading.length === readings.length
        ? `Reading ${list(reading.map((r) => r.label))}.`
        : `Still reading ${list(reading.map((r) => r.label))}.`,
    )
  }
  if (refused.length > 0) {
    parts.push(
      `${capitalise(list(refused.map((r) => r.label)))} ${refused.length === 1 ? 'is' : 'are'} not readable as this account, so nothing here speaks for ${refused.length === 1 ? 'it' : 'them'}.`,
    )
  }
  return parts.length ? parts.join(' ') : null
}

/** `a`, `a and b`, `a, b and c`. The Oxford comma is deliberately absent: these
 *  are short noun phrases, and the list appears mid-sentence. */
function list(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/* ── How the data got here ───────────────────────────────────────────────
 * The arrival had no dimension of time on it. Every figure was a state — this
 * much disk, this many objects, these findings — and the one thing a column
 * store is famous for is volume accumulating. A reader could not tell a server
 * that has been filling steadily for two years from one that took everything in
 * a single afternoon, and those are different servers to be responsible for.
 *
 * Read off the timeline `system.parts` already answers, so it costs no query log
 * and works on the servers whose log is switched off. Which also fixes what it
 * can honestly claim: this is **where the rows are, by the period they fall
 * in** — not how much was written each month. On a table partitioned by
 * `toYYYYMM(ts)` those are the same sentence; on one partitioned by anything
 * else they are not, and the server says which by refusing a scale of time at
 * all (`datable`).
 *
 * ## The 1970 lump
 *
 * A table with no partition key has no date, and the server folds it into the
 * epoch bucket. Drawn as a bar it is a mountain labelled January 1970, which is
 * the most confidently wrong thing this page could say — and on a schema of
 * flat analytics tables it is most of the disk. So it is separated out and
 * *counted* instead: the bars are the dated data, and the undated bytes are
 * named beside them.
 *
 * Told apart by the date, because the cells do not carry the partition key.
 * Data genuinely from the first days of 1970 does not occur in a ClickHouse
 * table; data with no date occurs constantly. The assumption is stated here and
 * asserted below rather than left in the shape of a suspiciously tall first bar.
 */

/** The epoch, and a little after it: ClickHouse hands back `1970-01-01` or
 *  `1970-01-02` depending on which of its two date pairs it filled. */
const UNDATED_BEFORE = Date.UTC(1970, 0, 4)

/** A `Date` back in the format `parseStamp` reads, which is what
 *  `bucketSequence` takes. `timeline`'s own `iso` prints the date alone and
 *  `parseStamp` requires the time, so a stamp built from it parses as null and
 *  the axis silently comes back empty. */
function isoStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

export interface Bar {
  /** The bucket as the server spells it, which is what the axis prints. */
  bucket: string
  bytes: number
  rows: number
}

export interface Growth {
  /** Every bucket between the ends, oldest first — including the empty ones.
   *
   *  Filled rather than only the buckets that hold something, and the axis is
   *  the reason. Bars spaced by *presence* put 2001 next to 2002 with a year
   *  between them and 2008-12 next to 2009-01 with a month, under two labels
   *  inviting the position to be read as time. `Grid` states the same rule for
   *  the same reason: with a filled axis a gap is a gap, and without one it is a
   *  bucket that was never drawn. */
  bars: Bar[]
  /** What had no date to be placed by, named rather than drawn. */
  undated: { bytes: number; rows: number }
  grain: Grain
  /** Whether `bars` is every bucket between the ends or only the ones holding
   *  something. False means the gaps are not to scale, and the caption says so
   *  rather than letting the reader assume otherwise. */
  filled: boolean
}

/** How many columns the figure can carry and still be read. Above this the bars
 *  are hairlines and the shape stops being a shape.
 *
 *  There is no floor to go with it. A server holding three months of data draws
 *  three bars, and that is the truth about it; going finer than the month would
 *  mean asking the server for a grain it was not asked for, to make a short
 *  history look longer. */
const MAX_BARS = 64

/** Coarsest-last. The figure asks the server for months and coarsens from there
 *  rather than asking again: re-bucketing is arithmetic over cells already in
 *  hand, and a second round trip to draw the same bytes at a different scale is
 *  a request nobody needs. */
const LADDER: Grain[] = ['month', 'quarter', 'year']

/** The server's data over time, or null where there is no such reading.
 *
 *  Null rather than an empty figure in four cases, and they are different things
 *  the caller does not have to tell apart: the reading was refused, the parts
 *  carry no date at all, nothing is dated once the epoch lump is taken out, or
 *  only one bucket is. One bar is not a growth — it is a total with a chart
 *  around it.
 *
 *  ## The grain is chosen here, not asked for
 *
 *  Asking for months and drawing them was the first version, and it is wrong on
 *  the servers this page is for: one row from 2001 and one from 2026 is a filled
 *  axis of three hundred and eight monthly columns, in which two years of real
 *  data is a sixty-pixel smear at the right-hand end. Measured on a fixture that
 *  had exactly that shape. So the span decides — months while they fit, then
 *  quarters, then years — and the caption names whichever it landed on.
 *
 *  ## Buckets come from the date, not from the partition name
 *
 *  A cell's `partition` is whatever the table's key produced, and two tables on
 *  one server rarely share a key. `covers_from` — the earliest row the parts
 *  hold — is comparable across all of them, and re-bucketing it is what lets the
 *  grain be chosen at all. It places a partition at its earliest row, which is
 *  the rule and is why the caption says "by the period its rows fall in".
 */
export function growth(
  timeline: {
    available: boolean
    datable: boolean
    grain: Grain
    cells: { partition: string; bytes: number; rows: number; covers_from?: string }[]
  } | undefined,
): Growth | null {
  if (!timeline?.available || !timeline.datable) return null

  /* Dated cells with their instant, and the undated ones counted. */
  const dated: { at: Date; bytes: number; rows: number }[] = []
  const undated = { bytes: 0, rows: 0 }
  for (const cell of timeline.cells) {
    const at = cell.covers_from ? parseStamp(cell.covers_from) : null
    if (at === null || at.getTime() < UNDATED_BEFORE) {
      undated.bytes += cell.bytes
      undated.rows += cell.rows
      continue
    }
    dated.push({ at, bytes: cell.bytes, rows: cell.rows })
  }
  if (dated.length === 0) return null

  dated.sort((a, b) => a.at.getTime() - b.at.getTime())
  const from = dated[0]!.at
  const to = dated[dated.length - 1]!.at

  /* The finest grain whose filled axis fits, and the coarsest as the floor: a
     span of forty years has to be drawn at *something*, and years is it. */
  const grain =
    LADDER.find((g) => {
      const axis = bucketSequence(g, isoStamp(from), isoStamp(to))
      return axis.length > 0 && axis.length <= MAX_BARS
    }) ?? LADDER[LADDER.length - 1]!

  const axis = bucketSequence(grain, isoStamp(from), isoStamp(to))
  const byBucket = new Map<string, Bar>()
  for (const d of dated) {
    const bucket = bucketOf(grain, d.at)
    const bar = byBucket.get(bucket) ?? { bucket, bytes: 0, rows: 0 }
    bar.bytes += d.bytes
    bar.rows += d.rows
    byBucket.set(bucket, bar)
  }
  if (byBucket.size < 2) return null

  /* Fall back to the buckets that hold something where no axis could be
     generated — `bucketSequence` refuses a range past its own cap, and returns
     nothing at all for the partition grain. Uneven spacing is a lesser fault
     than no figure, and `filled` says which of the two this is. */
  const filled = axis.length >= byBucket.size
  const bars = filled
    ? axis.map((bucket) => byBucket.get(bucket) ?? { bucket, bytes: 0, rows: 0 })
    : [...byBucket.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1))
  return { bars, undated, grain, filled }
}

/** What the figure covers, said under it. Never "growth" — see the header: this
 *  is where the rows are, by the period they fall in. */
export function saysGrowth(g: Growth): string {
  const span = `${g.bars[0]!.bucket} to ${g.bars[g.bars.length - 1]!.bucket}`
  const unit = GRAIN_LABEL[g.grain].toLowerCase()
  const tail =
    g.undated.bytes > 0
      ? `. A further ${bytes(g.undated.bytes)} is in tables with no date to place it by.`
      : ''
  const per = `by the ${unit} its rows fall in, ${span}`
  /* Said only when it is not: an axis to scale is what a reader assumes, and
     stating the assumption every time is noise. */
  const spacing = g.filled ? '' : ', with only the periods that hold something drawn'
  return `On disk ${per}${spacing}${tail}`
}
