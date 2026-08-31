/** Naming the shape of a column, and saying it.
 *
 *  `src/clickhouse/distribution.rs` measures: it counts rows into buckets — one
 *  per value where there are few, equal-width bins where the column is
 *  continuous, the most common values plus an honest remainder where it is
 *  neither — and has no opinion about the counts. This decides what shape they
 *  make and words it.
 *
 *  The vocabulary is deliberately small. Six shapes, each of which changes what
 *  somebody would do next; a taxonomy with twenty entries would be a quiz rather
 *  than an answer. Everything that does not clearly fit one of them is described
 *  by its own numbers instead of being forced into the nearest name — "spread
 *  across 11 of 16 buckets" says less than "two clusters" and is never wrong.
 *
 *  Two facts about the measurement shape the wording, and both come from the
 *  measuring half's own findings.
 *
 *  - **A tally and a histogram are not the same claim.** Fourteen values that
 *    happen to be powers of two are, as *frequencies*, perfectly even — the long
 *    tail is in the values, not in how often they occur. Binned it would read as
 *    a tail; tallied it reads as fourteen equally common values, which is what
 *    is true. So the sentence always says which of the three was counted.
 *  - **An empty bucket is a fact.** The measuring half fills them in on purpose,
 *    so a gap between two peaks is real and can be relied on here. A shape rule
 *    that ignored empties would call a bimodal column "spread across 16
 *    buckets".
 */

export type Mode = 'tally' | 'bins' | 'top'

export interface Bucket {
  label: string
  rows: number
  from: number | null
  to: number | null
}

export interface Distribution {
  available: boolean
  reason: string | null
  column: string
  type: string
  mode: Mode
  rows: number
  nulls: number
  distinct: number
  buckets: Bucket[]
  tail_rows: number
  tail_values: number
}

/** The named shapes. `mixed` is the honest fallback, not a failure. */
export type Shape =
  | 'empty'
  | 'key'
  | 'single'
  | 'dominant'
  | 'even'
  | 'clustered'
  | 'tail'
  | 'mixed'

/** At or above this share of rows being distinct, the column is an identifier
 *  and has no distribution to show. Measured: `analytics.events.payload` holds
 *  482,212 distinct values in 482,212 rows, and its twelve most common are one
 *  row each — twelve bars of height 1, which is a chart that says nothing. */
const KEYLIKE = 0.95

/** How many times its fair share the listed values have to hold before a
 *  `top`-mode column counts as concentrated.
 *
 *  The rule this replaced compared the listed share against a flat threshold and
 *  got `device_id` wrong: 400 values spread evenly, of which the twelve most
 *  common are 3.0% of the rows — which is exactly 12/400, and even. A power law
 *  over the same 400 would put most of the table in those twelve. Only the ratio
 *  between what they hold and what they would hold if the column were flat can
 *  tell the two apart, because the twelve bars look identical either way. */
const UNFAIR = 3

/** One value holding this share of the rows makes the column that value, for
 *  every practical purpose — a `status` that is 'ok' 99% of the time is a
 *  constant with exceptions, and reads as one. */
const NEARLY_ALL = 0.95

/** And this much makes it the answer without making it the only answer. Half,
 *  because half is already the thing somebody would say about the column — the
 *  first draft put it at 0.6 and reported a value holding exactly 50% of the
 *  table as an unremarkable spread. */
const DOMINANT = 0.5

/** How far the fullest and the emptiest occupied buckets may differ before the
 *  column stops being evenly spread. Two, because a uniform column measured over
 *  a finite table wobbles: `uniform` over 200,000 rows gave 12,400 to 12,600
 *  across sixteen bins, a ratio of 1.02, and a threshold near 1 would call that
 *  uneven. */
const EVEN = 2

/** A peak is a bucket holding at least this share. Below it a bump is noise. */
const PEAK = 0.15

/** Buckets between two peaks that must be near-empty for them to be two clusters
 *  rather than one broad one. */
const VALLEY = 0.02

export function shapeOf(d: Distribution): Shape {
  if (d.rows === 0 || d.buckets.length === 0) return 'empty'
  const counts = d.buckets.map((b) => b.rows)
  const total = d.rows
  const top = Math.max(...counts)

  /* Before every other rule: a column whose values are all different is an
     identifier, and an identifier has no distribution. Every rule below would
     have something to say about it and all of them would be beside the point. */
  if (d.distinct / total >= KEYLIKE) return 'key'

  /* The order is the design, and it was wrong twice before it was right. Each
     rule below is checked before the ones that would also be true of the same
     column, so the column gets its most informative name rather than its first
     matching one. */

  if (top / total >= NEARLY_ALL) return 'single'

  /* Before `dominant`, because a symmetric pair of peaks holds exactly half in
     each — and "`v0` is 50.0% of the rows" is a true sentence that hides the
     fact somebody actually needs, which is that there is nothing in between. */
  const peaks = peakIndexes(counts, total)
  if (peaks.length >= 2 && separated(counts, peaks, total)) return 'clustered'

  /* A `top` reading only ever sees the head, so the question it can answer is
     not "what do these twelve look like" but "do they hold more than their
     share". Evenly spread over four hundred values, or a power law over the
     same four hundred, draw the same twelve bars. */
  if (d.mode === 'top' && d.tail_values > 0) {
    const listed = counts.reduce((a, b) => a + b, 0)
    const fair = d.buckets.length / d.distinct
    if (fair > 0 && listed / total / fair >= UNFAIR) return 'tail'
    return 'even'
  }

  /* Also before `dominant`. A duration whose first bucket is 54% is dominant and
     falling, and the slope is the better sentence — "piled at the low end" tells
     somebody the shape, "bucket 0 holds 54%" tells them one bar. */
  if (d.mode === 'bins' && descending(counts)) return 'tail'

  if (top / total >= DOMINANT) return 'dominant'

  const occupied = counts.filter((n) => n > 0)
  if (
    occupied.length === counts.length &&
    occupied.length >= 3 &&
    top / Math.min(...occupied) <= EVEN
  ) {
    // Only where there are no empties: sixteen buckets of which two are full and
    // even with each other are two clusters, not an even spread.
    return 'even'
  }

  return 'mixed'
}

function peakIndexes(counts: readonly number[], total: number): number[] {
  return counts.map((n, i) => (n / total >= PEAK ? i : -1)).filter((i) => i >= 0)
}

/** Whether the peaks form exactly two groups with a real valley between them.
 *
 *  Two rules, and the first draft had neither. Adjacent peaks are **one** group —
 *  the three buckets at the top of a broad hump are one cluster, not three — and
 *  a valley has to be at least two buckets wide, because a single empty bucket
 *  in a ragged column is noise. Without both, a shape of `3000 0 5000 4000 0
 *  6000 3500 0 0 4000` was reported as two clusters, which is a sentence about a
 *  column that does not exist.
 *
 *  Exactly two, and more than two falls back to `mixed` with its own numbers.
 *  Three clusters is a real thing and a rarer one, and naming it would be a
 *  third rule earning its keep on a shape nobody has yet brought. */
function separated(counts: readonly number[], peaks: readonly number[], total: number): boolean {
  const groups: number[][] = []
  for (const i of peaks) {
    const last = groups[groups.length - 1]
    const previous = last ? last[last.length - 1] : undefined
    if (previous !== undefined && i - previous === 1) last!.push(i)
    else groups.push([i])
  }
  if (groups.length !== 2) return false
  const left = groups[0]!
  const right = groups[1]!
  const between = counts.slice(left[left.length - 1]! + 1, right[0]!)
  return between.length >= 2 && between.every((n) => n / total <= VALLEY)
}

/** Monotone non-increasing, allowing the wobble a real column has. */
function descending(counts: readonly number[]): boolean {
  const first = counts[0] ?? 0
  const last = counts[counts.length - 1] ?? 0
  if (first <= last * 2) return false
  let falls = 0
  for (let i = 1; i < counts.length; i++) if (counts[i]! <= counts[i - 1]!) falls++
  return falls >= counts.length - 2
}

/** What was counted, in one clause — because a bar means three different things
 *  across the three modes and a chart that does not say which is a chart that
 *  can be read three ways. */
export function counted(d: Distribution): string {
  switch (d.mode) {
    case 'tally':
      return `${exact(d.distinct)} ${d.distinct === 1 ? 'value' : 'values'}, each counted`
    case 'bins':
      return `${d.buckets.length} equal buckets across the range`
    case 'top':
      return `the ${d.buckets.length} most common of ${exact(d.distinct)} values`
  }
}

/** The shape, as a sentence somebody would say. */
export function says(d: Distribution): string {
  const total = d.rows
  if (total === 0) {
    return d.nulls > 0
      ? `Every one of the ${exact(d.nulls)} rows is null, so there is no distribution to read.`
      : 'There are no rows to read a distribution from.'
  }
  const top = d.buckets.reduce((a, b) => (b.rows > a.rows ? b : a), d.buckets[0]!)
  const share = (n: number) => `${((n / total) * 100).toFixed(1)}%`

  switch (shapeOf(d)) {
    case 'single':
      return `Nearly every row is ${value(top.label, d)} — ${share(top.rows)} of them.`
    case 'dominant':
      return `${value(top.label, d)} is ${share(top.rows)} of the rows; the rest are spread across ${
        occupiedCount(d) - 1
      } other ${occupiedCount(d) - 1 === 1 ? 'bucket' : 'buckets'}.`
    case 'key':
      return `Every row has its own value — ${exact(d.distinct)} of them in ${exact(
        total,
      )} rows. This is an identifier, not a distribution.`
    case 'even':
      if (d.mode === 'top') {
        return `Evenly spread: the ${d.buckets.length} most common of ${exact(
          d.distinct,
        )} values hold ${share(listedRows(d))} of the rows, which is about their share of the values.`
      }
      return d.mode === 'tally'
        ? `${exact(d.distinct)} values, all about equally common.`
        : `Evenly spread across the range — every bucket holds between ${share(
            Math.min(...d.buckets.map((b) => b.rows)),
          )} and ${share(top.rows)}.`
    case 'clustered':
      return `Two clusters, with nothing between them: ${peakLabels(d).join(' and ')}.`
    case 'tail':
      return d.mode === 'top'
        ? `A long tail: the ${d.buckets.length} most common values are only ${share(
            d.buckets.reduce((a, b) => a + b.rows, 0),
          )} of the rows, and ${exact(d.tail_values)} more ${
            d.tail_values === 1 ? 'value holds' : 'values hold'
          } the rest.`
        : `Piled at the low end and falling away — ${share(top.rows)} of the rows are in the first bucket.`
    case 'mixed':
      return `Spread across ${occupiedCount(d)} of ${d.buckets.length} buckets, the fullest holding ${share(
        top.rows,
      )}.`
    case 'empty':
      return 'Nothing to read.'
  }
}

/** How many rows are missing from the picture, said rather than left to be
 *  noticed. A NULL is not a value and has no place on an axis of values, which
 *  is why it is excluded from the count and named here instead. */
export function asideFrom(d: Distribution): string | null {
  if (d.nulls === 0) return null
  const of = d.rows + d.nulls
  return `${exact(d.nulls)} of ${exact(of)} rows are null and are not on this axis.`
}

function listedRows(d: Distribution): number {
  return d.buckets.reduce((a, b) => a + b.rows, 0)
}

function occupiedCount(d: Distribution): number {
  return d.buckets.filter((b) => b.rows > 0).length
}

function peakLabels(d: Distribution): string[] {
  const total = d.rows
  return d.buckets
    .filter((b) => b.rows / total >= PEAK)
    .map((b) => (d.mode === 'bins' ? `around ${b.label}` : value(b.label, d)))
}

/** A bucket's label as it should read in a sentence. A binned bucket is a range
 *  and says so; a value is quoted, because `alpha` and alpha are different
 *  claims about what is in the column. */
function value(label: string, d: Distribution): string {
  return d.mode === 'bins' ? `around ${label}` : `\`${label}\``
}

function exact(n: number): string {
  return n.toLocaleString('en-GB')
}

/** The bars, scaled to the fullest bucket.
 *
 *  To the fullest rather than to the total: a column whose largest bucket is 3%
 *  of the table draws sixteen invisible bars against the total, and the shape —
 *  which is the entire point — disappears. The figure beside the chart says what
 *  the full height is, the same contract the sparklines keep. */
export function bars(d: Distribution): { label: string; rows: number; share: number }[] {
  const peak = d.buckets.reduce((m, b) => Math.max(m, b.rows), 0)
  return d.buckets.map((b) => ({
    label: b.label,
    rows: b.rows,
    share: peak > 0 ? b.rows / peak : 0,
  }))
}
