/** Whether a table has started behaving differently — and how to say so.
 *
 *  `src/clickhouse/drift.rs` measures: it cuts the table into periods on its own
 *  time column and reads each one, with no opinion about any of it. This decides
 *  which of those movements is *news*, and words it. The split is the one
 *  `review.ts` and `projection.ts` already follow — the thresholds below are the
 *  arguable part of the feature, and an argument belongs in a test file rather
 *  than inside a SQL string.
 *
 *  Four rules, and every one of them was measured on a real table before it was
 *  written.
 *
 *  - **The first and last periods are partial, nearly always.** `lab.traffic`
 *    opens 51,741 / 86,400 / 126,941 rows and then sits at 172,800 for a month:
 *    the table began part-way through a day and today is still filling. A
 *    detector that reads those as a collapse and a recovery fires on every table
 *    there is. Both ends are held out of every comparison — and named, because
 *    "not counted" is a fact the reader is owed.
 *  - **Flat is the common answer and it is a good one.** A fixture of 483,188
 *    rows gave 5,664 rows a day, 5.88% nulls and 400 devices for eighty days.
 *    Nothing changed is a sentence, and the page stops after it.
 *  - **A counter always drifts.** Found the way the rest of this was — a fixture
 *    whose day counter reported 3 → 15 beside three real findings and read
 *    exactly like them. A column that rises at *every* period is a sequence, not
 *    a measurement.
 *  - **The comparison is early-third against late-third.** A change six periods
 *    ago is still the answer to "has this changed", and a median that has
 *    absorbed it reports nothing. Thirds catch a change anywhere in the window
 *    and leave a middle belonging to neither, so a change in the exact centre is
 *    not split across both ends and averaged away.
 *
 *  The wording follows the product's own rules: past tense then present, because
 *  that is the shape of news; the date closes the sentence rather than opening
 *  it, because a list that starts every line with a date reads as a log; and a
 *  figure that cannot be had is dropped rather than dashed.
 */

/** Below this there is no early third to compare a late third against. */
const MIN_PERIODS = 6

/** A share that has moved by more than this many points is a finding. Absolute
 *  rather than relative, because a share is already a proportion: 2% to 4% is a
 *  doubling and means almost nothing, 5% to 40% is the thing somebody needs to
 *  know. */
const SHARE_JUMP = 0.1

/** How far a count or a level has to move to be worth a sentence, as a share of
 *  the *larger* of the two readings. At 0.5 that is exactly "doubled, or halved"
 *  — and inclusively so: a doubling sits precisely on the boundary, and there is
 *  no reading of "has this changed" under which twice as many is not an answer.
 *
 *  Relative to the larger so that a rise and the fall that undoes it are judged
 *  alike: against the smaller, 100 → 200 is +100% and 200 → 100 is −50%, and one
 *  threshold would catch the first and miss the second. */
const MOVE = 0.5

/** Below this many distinct values a "collapse" is noise: 3 to 1 is not a fleet
 *  going dark, it is a flag that stopped being set both ways. */
const FLEET = 8

export type Step = 'hour' | 'day' | 'week' | 'month'

export type Kind = 'volume' | 'gap' | 'filling' | 'fleet' | 'level'

export interface Finding {
  kind: Kind
  column: string | null
  at: string | null
  was: string
  now: string
}

export interface Series {
  name: string
  type: string
  /** Absent for a column that cannot be null — which is not the same as a column
   *  that is never null, and the two must not print alike. */
  nulls: number[] | null
  distinct: (number | null)[]
  mean: (number | null)[] | null
}

export interface Drift {
  available: boolean
  reason: string | null
  database: string
  table: string
  time_column: string | null
  step: Step
  periods: string[]
  rows: number[]
  series: Series[]
  columns: number
  examined: number
  windowed: boolean
}

/** Everything this file concludes from a reading, in one place.
 *
 *  One function rather than three, so the findings, the periods held out of them
 *  and the columns excluded from them cannot disagree about which periods were
 *  compared. A page saying "nothing changed" beside a note that the only two
 *  periods it read were the partial ones would be worse than either alone. */
export interface Read {
  findings: Finding[]
  /** The two periods held out, named. Empty where the window was too short to
   *  compare at all — nothing was held out, because nothing was read. */
  partial: string[]
  /** Columns whose level was not compared because they count rather than
   *  measure. */
  sequences: string[]
}

export function read(d: Drift): Read {
  const findings: Finding[] = []
  const sequences: string[] = []
  const { periods, rows } = d
  if (periods.length < MIN_PERIODS + 2) return { findings, partial: [], sequences }

  const inner = range(1, periods.length - 1)
  const partial = [periods[0]!, periods[periods.length - 1]!]

  /* A gap is not a comparison and does not wait for one: a period between two
     that have rows, holding none, is a fact on its own. Capped, because a table
     that stopped a year ago has three hundred of them and the list is one piece
     of news repeated. */
  const holes = inner.filter((i) => rows[i] === 0 && (rows[i - 1] ?? 0) > 0)
  for (const k of holes.slice(0, 3)) {
    findings.push({ kind: 'gap', column: null, at: periods[k]!, was: 'rows', now: 'none' })
  }

  // Only periods that hold rows can be compared; a filled one has no reading of
  // anything.
  const live = inner.filter((k) => (rows[k] ?? 0) > 0)
  if (live.length < MIN_PERIODS) return { findings, partial, sequences }

  const volumes = live.map((k) => rows[k]!)
  const vol = moved(volumes)
  if (vol) {
    findings.push(finding('volume', null, periods, live, volumes, vol))
  }

  for (const s of d.series) {
    if (s.nulls) {
      const vals = live.map((k) => s.nulls![k] ?? 0)
      const [early, late] = thirds(vals)
      if (Math.abs(late - early) > SHARE_JUMP) {
        findings.push({
          kind: 'filling',
          column: s.name,
          at: crossing(periods, live, vals, early, late),
          was: percent(early),
          now: percent(late),
        })
      }
    }

    const distinct = live.map((k) => s.distinct[k] ?? 0)
    const [dEarly, dLate] = thirds(distinct)
    if (Math.max(dEarly, dLate) >= FLEET) {
      const d2 = moved(distinct)
      if (d2) findings.push(finding('fleet', s.name, periods, live, distinct, d2))
    }

    if (s.mean) {
      const vals = live.map((k) => s.mean![k]).filter((v): v is number => v !== null)
      if (vals.length === live.length) {
        if (countsUp(vals)) {
          sequences.push(s.name)
        } else {
          const m = moved(vals)
          if (m) findings.push(finding('level', s.name, periods, live, vals, m))
        }
      }
    }
  }

  return { findings, partial, sequences }
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i)
}

function finding(
  kind: Kind,
  column: string | null,
  periods: string[],
  live: number[],
  values: number[],
  [early, late]: [number, number],
): Finding {
  const [was, now] = pair(early, late)
  return { kind, column, at: crossing(periods, live, values, early, late), was, now }
}

/** The median of the first third and of the last third. Median rather than mean
 *  throughout, so one spike cannot manufacture a finding and one outage cannot
 *  hide one. */
export function thirds(values: readonly number[]): [number, number] {
  const n = values.length
  const cut = Math.max(1, Math.floor(n / 3))
  return [median(values.slice(0, cut)), median(values.slice(n - cut))]
}

/** The two levels, where they differ by at least `MOVE` of the larger. */
export function moved(values: readonly number[]): [number, number] | null {
  const [early, late] = thirds(values)
  const scale = Math.max(Math.abs(early), Math.abs(late))
  if (scale <= 0) return null
  return Math.abs(late - early) / scale >= MOVE ? [early, late] : null
}

/** Whether a column counts rather than measures.
 *
 *  **Strictly** rising at every step, which is the whole distinction. A column
 *  that sits flat and then jumps — the shape of every real level change — is
 *  non-decreasing too, so the weaker test would throw away the findings this
 *  file exists to make. */
export function countsUp(values: readonly number[]): boolean {
  if (values.length <= 2) return false
  const up = values.every((v, i) => i === 0 || v > values[i - 1]!)
  const down = values.every((v, i) => i === 0 || v < values[i - 1]!)
  return up || down
}

/** The period the reading first crosses the midpoint between its two levels, so
 *  a finding can say *when* — the difference between "this column changed" and
 *  "this column stopped being filled on 15 August", which is something somebody
 *  can go and look up. */
function crossing(
  periods: string[],
  live: number[],
  values: readonly number[],
  early: number,
  late: number,
): string | null {
  const mid = (early + late) / 2
  const rising = late > early
  const at = live.findIndex((_, i) => (rising ? values[i]! > mid : values[i]! < mid))
  return at === -1 ? null : (periods[live[at]!] ?? null)
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const v = [...values].sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 === 0 ? ((v[mid - 1]! + v[mid]!) / 2) : v[mid]!
}

/** The two readings of one finding, rounded *together*.
 *
 *  Rounded apart they read as two measurements of different precision — "500"
 *  beside "12.0" in the same sentence — when they are one before-and-after of
 *  the same quantity. The larger decides for both. */
export function pair(was: number, now: number): [string, string] {
  const coarse = Math.max(Math.abs(was), Math.abs(now)) >= 100
  const one = (v: number) => (coarse ? String(Math.round(v)) : v.toFixed(1))
  return [one(was), one(now)]
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`
}

/** What one period is called, at the step it was cut at.
 *
 *  The server sends the instant — `2026-08-15 00:00:00` — for every step, because
 *  `WITH FILL` can only walk a real date and a label derived beside it would come
 *  back empty on exactly the periods that matter, the ones with no rows. So the
 *  formatting happens here, where the step is known: a month labelled with a day
 *  reads as a day, which is the mistake the partition grid already documents. */
export function periodLabel(instant: string, step: Step): string {
  const [date, time = ''] = instant.split(' ')
  const [y, m, d] = (date ?? '').split('-')
  /* Shape, not presence: `not-a-date` splits into three truthy pieces and would
     sail past a check that only asks whether they are there, producing a label
     with `NaN` in it. Anything this cannot read is handed back untouched — a
     label Flint does not understand is still the server's own answer, and
     printing it beats printing a guess. */
  if (!/^\d{4}$/.test(y ?? '') || !/^\d{2}$/.test(m ?? '')) return instant
  const month = MONTHS[Number(m) - 1] ?? m
  switch (step) {
    case 'hour':
      return `${Number(d)} ${month} ${time.slice(0, 5)}`
    case 'day':
      return `${Number(d)} ${month}`
    case 'week':
      return `week of ${Number(d)} ${month}`
    case 'month':
      return `${month} ${y}`
  }
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** How often a period comes round, for a sentence that has to name the cadence:
 *  "4,000 rows a day became 12,000". */
export function cadence(step: Step): string {
  return step === 'hour' ? 'an hour' : `a ${step}`
}

/** One finding, as a sentence.
 *
 *  Past tense then present, always in that order, because that is the shape of
 *  the news: this is what it was, this is what it is. The date closes the
 *  sentence rather than opening it — the reader wants to know *what* before
 *  *when*, and a list that opens every line with a date reads as a log. */
export function says(f: Finding, step: Step): string {
  const from = f.at ? `, from ${periodLabel(f.at, step)}` : ''
  const col = f.column ? `\`${f.column}\`` : ''
  switch (f.kind) {
    case 'gap':
      return f.at
        ? `Nothing arrived in ${periodLabel(f.at, step)}.`
        : 'A period passed with no rows in it.'
    case 'volume':
      return `${f.was} rows ${cadence(step)} became ${f.now}${from}.`
    case 'filling':
      return `${col} was ${f.was} null and is now ${f.now}${from}.`
    case 'fleet':
      return `${col} took ${f.was} distinct values and now takes ${f.now}${from}.`
    case 'level':
      return `${col} averaged ${f.was} and now averages ${f.now}${from}.`
  }
}

/** The headline: what the page found, or that it found nothing.
 *
 *  `null` where the table could not be read at all — the caller has the reason
 *  and says it in the server's own words rather than paraphrasing it here. */
export function headline(d: Drift, r: Read): string {
  if (!d.time_column) {
    return 'This table has no date or time column, so there is no "over time" to read.'
  }
  if (d.periods.length === 0) {
    return 'This table holds no rows to cut into periods.'
  }
  const span = `${d.periods.length} ${d.step}${d.periods.length === 1 ? '' : 's'}`
  if (r.findings.length === 0) {
    return `Nothing about this table has changed shape over the last ${span}.`
  }
  const n = r.findings.length
  return `${n} thing${n === 1 ? '' : 's'} changed over the last ${span}.`
}

/** What the reading left out, in one line — or nothing, where it left nothing
 *  out. Every cap, fold and exclusion states its own count; an exclusion nobody
 *  is told about turns a partial answer into a wrong one. */
export function omissions(d: Drift, r: Read): string[] {
  const out: string[] = []
  if (r.partial.length === 2) {
    out.push(
      `The first and last ${d.step} are partial — the table began part-way through one and is still filling the other — so neither was compared.`,
    )
  }
  if (d.examined < d.columns) {
    out.push(
      `${d.examined} of ${d.columns} columns were read; the rest are the time column itself, or types this pass has nothing to say about.`,
    )
  }
  if (d.windowed) {
    out.push(`Older ${d.step}s than these exist and were not read.`)
  }
  if (r.sequences.length) {
    out.push(
      `${list(r.sequences)} ${r.sequences.length === 1 ? 'counts' : 'count'} rather than measures, so ${r.sequences.length === 1 ? 'its' : 'their'} level was not compared — a counter's average rises every ${d.step} by construction.`,
    )
  }
  return out
}

function list(names: readonly string[]): string {
  const q = names.map((n) => `\`${n}\``)
  if (q.length <= 2) return q.join(' and ')
  return `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`
}

/** The series worth drawing, and in what order.
 *
 *  A column named by a finding first, because the reader is looking at the
 *  sentence and wants the shape under it. Then the rest, so the page is still a
 *  profile over time for somebody who arrived without a question. */
export function ordered(d: Drift, r: Read): Series[] {
  const named = new Set(r.findings.map((f) => f.column).filter((c): c is string => c !== null))
  return [...d.series].sort((a, b) => {
    const an = named.has(a.name) ? 0 : 1
    const bn = named.has(b.name) ? 0 : 1
    return an - bn || d.series.indexOf(a) - d.series.indexOf(b)
  })
}

/** A series' values as the sparkline wants them: `undefined` for a period that
 *  holds no rows, so the line breaks there rather than diving to zero.
 *
 *  The distinction is the whole point of the fill: a period the server invented
 *  has no reading of anything, and drawing it as zero would put a cliff in the
 *  chart where there is only an absence. */
export function forSpark(values: readonly (number | null)[]): (number | undefined)[] {
  return values.map((v) => (v === null ? undefined : v))
}
