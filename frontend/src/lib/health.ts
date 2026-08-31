/** The server over time, as the interface reads it.
 *
 *  Everything here exists to draw a line without lying about it. Two rules do
 *  most of the work:
 *
 *  - **A gap is a gap.** A point whose value is null was not measurable in that
 *    bucket — a cache hit rate with no reads behind it — and the line breaks
 *    rather than dropping to zero. A line that dives to the floor says "it went
 *    bad"; a break says "nobody knows", and those are different sentences.
 *  - **The scale starts at zero.** A sparkline auto-scaled to its own minimum
 *    turns a metric that wobbled between 41% and 43% into a dramatic mountain
 *    range. Zero-based, with the ceiling being the series' own limit where it has
 *    one, is the only reading that survives being glanced at.
 */

export interface Point {
  t: string
  v: number | null
}

export interface Series {
  key: string
  label: string
  says: string
  unit: 'bytes' | 'count' | 'percent'
  limit?: number
  points: Point[]
}

export interface SeriesReport {
  available: boolean
  reason?: string
  step_seconds: number
  from: string
  series: Series[]
}

export interface ErrorCount {
  name: string
  code: number
  times: number
  last: string
  message: string
}

export interface ErrorReport {
  available: boolean
  reason?: string
  /** Whether the counts are over the window asked for, or over the whole life of
   *  the server. The distinction is the point: "42 access denied" means one thing
   *  about six hours and something else about eleven days, and a panel that does
   *  not say which is a panel nobody can act on. */
  windowed: boolean
  errors: ErrorCount[]
  points: Point[]
}

export interface MergedTable {
  qualified: string
  merges: number
  rows: number
  bytes: number
  avg_ms: number
  worst_ms: number
  failed: number
  ttl_merges: number
}

export interface MergeReport {
  available: boolean
  reason?: string
  step_seconds: number
  series: Series[]
  tables: MergedTable[]
  total_tables: number
  failed: number
  last_exception: string
}

export interface LogLine {
  at: string
  level: string
  logger: string
  message: string
  query_id: string
}

export interface LogReport {
  available: boolean
  reason?: string
  lines: LogLine[]
}

/** The last value that was actually measured, or null if none was. */
export function current(series: Series): number | null {
  for (let i = series.points.length - 1; i >= 0; i--) {
    const v = series.points[i]?.v
    if (v !== null && v !== undefined) return v
  }
  return null
}

/** The highest value in the window, or null if nothing was measured. */
export function peak(series: Series): number | null {
  const values = series.points.map((p) => p.v).filter((v): v is number => v !== null)
  return values.length ? Math.max(...values) : null
}

/** How many buckets had nothing to measure. Stated in the UI rather than hidden:
 *  a line with holes in it should say how many. */
export function gaps(series: Series): number {
  return series.points.filter((p) => p.v === null).length
}

/** The top of the scale.
 *
 *  The series' own limit where it has one — a pool of 32 slots is drawn against
 *  32, so half-full looks half-full — and otherwise the peak, with a little air
 *  above it so a flat line at maximum is not indistinguishable from the frame.
 *  Never zero: a zero-height box has no line in it at all. */
export function ceiling(series: Series): number {
  const top = series.limit ?? peak(series) ?? 0
  if (top <= 0) return 1
  return series.limit ? top : top * 1.05
}

/** The polyline segments of a sparkline, in a 0..w by 0..h box.
 *
 *  Segments, plural, and that is the point: a null point ends the current run and
 *  the next value starts a new one, so a gap is drawn as a gap. Y is flipped
 *  because SVG counts downwards and a metric does not. */
export function paths(series: Series, w: number, h: number): string[] {
  const points = series.points
  if (points.length === 0) return []
  const top = ceiling(series)
  const span = Math.max(1, points.length - 1)
  const runs: string[][] = []
  let run: string[] = []

  points.forEach((p, i) => {
    if (p.v === null) {
      if (run.length) runs.push(run)
      run = []
      return
    }
    const x = (i / span) * w
    const y = h - (Math.min(p.v, top) / top) * h
    run.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  })
  if (run.length) runs.push(run)

  // A single measured point among gaps has no line to draw; doubled, it becomes
  // a visible tick rather than nothing at all.
  return runs.map((r) => (r.length === 1 ? `${r[0]} ${r[0]}` : r.join(' ')))
}

/** How close to its ceiling a series has been, where the ceiling is a real
 *  limit rather than a drawing convenience.
 *
 *  Null where there is no limit: "80% of nothing" is not a figure. */
export function saturation(series: Series): number | null {
  if (!series.limit) return null
  const top = peak(series)
  return top === null ? null : (top / series.limit) * 100
}
