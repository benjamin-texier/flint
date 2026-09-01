/** Choosing and scaling a chart for a query result.
 *
 *  Flint charts whatever a query returned, so the form has to be inferred from
 *  the shape of the result rather than chosen by hand. The rules come from the
 *  dataviz method, and two of them do most of the work:
 *
 *  - One value is not a chart. A single row with a single number is a figure,
 *    not a one-bar bar chart.
 *  - Never two y-scales. Several measures of different magnitude share one
 *    axis; if that makes them unreadable the answer is two charts, not a second
 *    axis that invents a correlation the data does not contain.
 *
 *  Everything here is pure, so the choice can be tested without a browser. */

import { family } from './chType'
import { CELL_FLOOR, barScale } from './scale'

export interface Column {
  name: string
  type: string
}

export type ChartKind = 'stat' | 'line' | 'area' | 'bar' | 'donut' | 'heatmap' | 'scatter'

export interface ChartSpec {
  kind: ChartKind
  /** Column index for the x axis, or -1 when the row's position is the axis. */
  x: number
  /** The second axis, for the one form that has two: a heatmap's rows. Absent
   *  everywhere else, because no other form here has anywhere to put it. */
  y?: number
  /** Column indices of the measures, in order. */
  series: number[]
  /** Why this form, in one line, for the picker. */
  why: string
  /** Measures the palette could not seat. Reported rather than cycled into a
   *  seventh hue that nobody can tell from the first. */
  omitted?: number
}

/** The palette has six slots and they are never cycled. Past that a chart says
 *  how many series it is leaving out rather than inventing a hue. */
export const MAX_SERIES = 6

/** The most slices a ring can hold and still be read as shares. Past six the
 *  segments stop being separable — and unlike every other cap in Flint this one
 *  does not truncate anything: it withholds the *form*, and the same rows are
 *  drawn as a bar instead. */
export const DONUT_MAX = 6

export interface Classified {
  times: number[]
  metrics: number[]
  labels: number[]
}

/** Which columns can be an axis, a measure, or a label.
 *
 *  A 64-bit integer arrives as a JSON string so the browser cannot silently
 *  round it, which makes "is this a number" a question about the declared type
 *  and never about the value. */
export function classifyColumns(columns: Column[]): Classified {
  const times: number[] = []
  const metrics: number[] = []
  const labels: number[] = []
  columns.forEach((c, i) => {
    const f = family(c.type)
    if (f === 'time') times.push(i)
    else if (f === 'number') metrics.push(i)
    else if (f !== 'nested') labels.push(i)
  })
  return { times, metrics, labels }
}

/** The forms worth offering for this result, best first. Empty when nothing
 *  plots — the table is already the right answer then. */
export function suggestCharts(columns: Column[], rows: number, truncated = false): ChartSpec[] {
  const { times, metrics, labels } = classifyColumns(columns)
  const out: ChartSpec[] = []

  if (metrics.length === 0) return out

  // One row, one number: a figure. A bar chart of a single bar is the most
  // common way a chart misses its own point.
  if (rows === 1) {
    return metrics.slice(0, 1).map((m) => ({
      kind: 'stat' as const,
      x: -1,
      series: [m],
      why: 'A single value reads as a figure, not a chart.',
    }))
  }

  // A time column and something measured — the shape almost every ClickHouse
  // result with a timestamp wants.
  if (times.length > 0) {
    out.push({
      kind: 'line',
      x: times[0]!,
      series: metrics.slice(0, MAX_SERIES),
      why: 'A time column and a measure — how it moved.',
      omitted: Math.max(0, metrics.length - MAX_SERIES),
    })
  }

  /* Several measures over time, read as parts of one total. Offered only from
     two measures up, because a single filled series is what `line` already
     draws — a one-slice stack is the same picture under a second name.

     What it asserts is the whole point and the reason it says so out loud: the
     top edge is the sum. Flint cannot know whether these measures are parts of
     anything — `avg(d), max(d)` stacks as readily as `hits, misses` and the
     total means nothing — so the offer names the claim and lets the reader see
     in one glance whether it holds. The refusal that *can* be computed is made
     later, from the values: a stack cannot draw a negative. */
  if (times.length > 0 && metrics.length >= 2) {
    out.push({
      kind: 'area',
      x: times[0]!,
      series: metrics.slice(0, MAX_SERIES),
      why: 'Parts of a total over time — stacked, so the top edge is the sum.',
      omitted: Math.max(0, metrics.length - MAX_SERIES),
    })
  }

  // A label and one measure: compare magnitude.
  if (labels.length > 0) {
    out.push({
      kind: 'bar',
      x: labels[0]!,
      series: metrics.slice(0, 1),
      why: 'A label and a measure — which is biggest.',
    })
  }

  // Two measures and no time: whether they relate. One series only — an
  // all-pairs form like scatter stops being separable past three.
  if (times.length === 0 && metrics.length >= 2) {
    out.push({
      kind: 'scatter',
      x: metrics[0]!,
      series: [metrics[1]!],
      why: 'Two measures — whether they move together.',
    })
  }

  /* A share of a whole — and it is offered only where it can *be* one.
     A donut asserts that its slices are everything, which is a claim almost no
     ClickHouse result can make: `ORDER BY c DESC LIMIT 10` is complete as asked
     and is still the top ten of something larger. So the form is withheld
     rather than annotated, on three conditions, and the same numbers stay one
     click away as a bar — which asserts nothing about a whole and is the
     honest drawing of a top-ten.

     - **Six slices at most.** Past that the segments blur into each other and
       the reader is comparing angles they cannot tell apart. This is a refusal
       to offer the form, not a cap on the slices: a 40-row result becomes a
       bar, so there is nothing left out and nothing to say was left out.
     - **A result Flint did not cut.** `truncated` means the page limit stopped
       the rows, and a share computed over an arbitrary prefix is a wrong
       number rather than an incomplete one.
     - **A label and one measure.** Two measures are two wholes, and there is
       one ring.

     A donut rather than a pie for one reason that is not taste: the hole is
     where the total goes. A share with no total beside it cannot be checked
     against anything, and the pie has nowhere to put it. */
  if (labels.length > 0 && rows <= DONUT_MAX && !truncated) {
    out.push({
      kind: 'donut',
      x: labels[0]!,
      series: [metrics[0]!],
      why: `Six or fewer parts — each one's share of the ${rows} together.`,
    })
  }

  /* Two axes and a measure: the value lives at a crossing rather than along a
     line. This is the shape a `GROUP BY hour, host` comes back in, and drawn
     as a line it is one scribble per host.

     A time column counts as an axis here even though it is continuous,
     because by the time it reaches a heatmap the query has already bucketed it
     — `toStartOfHour(ts)` returns a category, and the grid draws the buckets
     the question asked for rather than inventing its own. */
  const axes = [...times, ...labels].sort((a, b) => a - b)
  if (axes.length >= 2) {
    out.push({
      kind: 'heatmap',
      x: axes[0]!,
      y: axes[1]!,
      series: [metrics[0]!],
      why: 'Two axes and a measure — where it concentrates.',
    })
  }

  // Numbers but no axis of any kind: rank the rows in the order they came.
  if (out.length === 0) {
    out.push({
      kind: 'bar',
      x: -1,
      series: metrics.slice(0, 1),
      why: 'A measure with no label — the rows in order.',
    })
  }

  return out
}

/** Whether these series can honestly share one y axis.
 *
 *  The forbidden fix for two measures of different scale is a second y axis,
 *  whose alignment is arbitrary and invents a correlation. The real fix is to
 *  stop sharing: one panel per series, each with its own scale, sharing the x.
 *
 *  The test is not the ratio of the maxima — it is whether a series' whole
 *  range ends up crushed against the baseline of the shared axis, where its
 *  shape is unreadable however large the number is. Events around 236 beside a
 *  temperature around 30 is a ratio of only eight, and the temperature still
 *  renders as a flat line along the bottom. */
export function needsFacets(ranges: { min: number; max: number }[]): boolean {
  const good = ranges.filter((r) => Number.isFinite(r.min) && Number.isFinite(r.max))
  if (good.length < 2) return false
  const sharedMin = Math.min(...good.map((r) => r.min))
  const sharedMax = Math.max(...good.map((r) => r.max))
  const sharedSpan = sharedMax - sharedMin
  if (sharedSpan <= 0) return false
  // A series whose top sits in the bottom sixth of the shared axis has nowhere
  // to draw its shape.
  return good.some((r) => (r.max - sharedMin) / sharedSpan < 0.16)
}

/** ClickHouse renders a DateTime as `2026-08-24 09:00:00`, which `Date.parse`
 *  reads as local time. Reading it as UTC keeps the axis consistent with what
 *  the server actually returned. */
export function parseTime(value: unknown): number {
  if (value === null || value === undefined) return NaN
  const s = String(value).trim()
  const iso = s.includes('T') ? s : s.replace(' ', 'T')
  return Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`)
}

/** A cell as a number, or NaN. Handles the 64-bit-integer-as-string case. */
export function parseNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return NaN
  const n = Number(value)
  return Number.isFinite(n) ? n : NaN
}

/** Axis ticks on 1 / 2 / 5 boundaries, so they read as round numbers. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min === max) return [min]
  const raw = (max - min) / Math.max(1, target)
  const mag = 10 ** Math.floor(Math.log10(raw))
  /* Pick the round step whose tick count lands closest to the target, rather
     than the largest step below `raw`. Flooring gives a step of 10K on a 0–96K
     axis — ten gridlines for a target of five. */
  const step = [1, 2, 5, 10]
    .map((m) => m * mag)
    .reduce((best, s) =>
      Math.abs((max - min) / s - target) < Math.abs((max - min) / best - target) ? s : best,
    )
  const first = Math.ceil(min / step) * step
  const ticks: number[] = []
  // Bounded by count as well as by value: a floating-point step can otherwise
  // creep along without ever exceeding the end.
  for (let v = first, i = 0; v <= max + step * 1e-9 && i < 40; v += step, i += 1) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v)
  }
  return ticks
}

/** Axis and label numbers: compact, and never more precision than a reader can
 *  use. */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e12) return `${trim(n / 1e12)}T`
  if (abs >= 1e9) return `${trim(n / 1e9)}B`
  if (abs >= 1e6) return `${trim(n / 1e6)}M`
  if (abs >= 1e4) return `${trim(n / 1e3)}K`
  if (abs >= 1) return trim(n)
  if (abs === 0) return '0'
  return String(Number(n.toPrecision(3)))
}

function trim(n: number): string {
  return String(Math.abs(n) >= 100 ? Math.round(n) : Number(n.toPrecision(3)))
}

/** A time axis label at the resolution the span calls for: a day wants hours, a
 *  year wants months. */
export function timeLabel(ms: number, spanMs: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  if (spanMs < 3 * 3600e3) return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  if (spanMs < 3 * 86400e3) {
    return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}h`
  }
  if (spanMs < 365 * 86400e3) return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`
  return `${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`
}

/* -- The two forms that are not a series of points -------------------------
 *
 * A line, a bar, an area and a scatter are all the same model seen four ways:
 * an x, some measures, one point per row. A ring and a grid are not — one row
 * becomes a slice of a whole, or a cell at a crossing — so each gets its own
 * model here rather than a fourth branch inside the one built for points.
 *
 * Both are pure and both are where the honesty lives, which is why they are in
 * `lib` and not in the component: the arithmetic that decides a share is wrong,
 * or that a grid was cut, has to be testable without a browser. */

/** One segment of the ring. `share` is of the total actually drawn, which is
 *  every row — the form is withheld rather than truncated, so there is never a
 *  remainder hiding outside the circle. */
export interface Slice {
  label: string
  value: number
  share: number
  /** Radians from twelve o'clock, clockwise. */
  from: number
  to: number
}

export interface Ring {
  slices: Slice[]
  total: number
}

/** The ring, or the reason there isn't one.
 *
 *  Two refusals, and both are arithmetic rather than taste:
 *
 *  - **A negative has no share.** A share is a part of a total, and a part that
 *    subtracts from it has no angle: −20 out of a total of 100 is not −72°, it
 *    is a question the form cannot answer. ClickHouse produces these readily —
 *    a `sum(delta)`, a difference between two counts — so this is the ordinary
 *    case rather than the exotic one.
 *  - **A total of zero has no shares at all.** Every slice would be 0/0. This
 *    is not an error in the query: `count()` over a window where nothing
 *    happened is a true answer, and it is a true answer with no picture.
 *
 *  Either way the caller gets a sentence to print, not an empty circle. An
 *  empty circle reads as a chart that failed to load. */
export function buildRing(labels: string[], values: number[]): Ring | string {
  const bad = values.filter((v) => Number.isFinite(v) && v < 0).length
  if (bad > 0) {
    return `${
      bad === 1 ? 'One of these values is' : `${bad} of these values are`
    } negative, and a negative has no share of a total. Read them as a bar.`
  }
  const good = values.map((v) => (Number.isFinite(v) ? v : 0))
  const total = good.reduce((a, b) => a + b, 0)
  if (total <= 0) {
    return 'These add up to nothing, so no slice has a share. The figures are in the table.'
  }
  let angle = 0
  const slices = good.map((value, i) => {
    const share = value / total
    const from = angle
    angle += share * Math.PI * 2
    return { label: labels[i] ?? '', value, share, from, to: angle }
  })
  return { slices, total }
}

/** An annulus segment as an SVG path, from twelve o'clock, clockwise.
 *
 *  The full-circle case is not hypothetical — one row at 100% and the rest at
 *  zero is what a `GROUP BY` over a quiet window returns — and an arc whose two
 *  ends are the same point draws nothing at all. Two half arcs instead, so the
 *  one slice that *is* the whole is visible rather than invisible. */
export function ringPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  from: number,
  to: number,
): string {
  const at = (r: number, a: number) =>
    `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`
  if (to - from >= Math.PI * 2 - 1e-9) {
    const mid = from + Math.PI
    return (
      `M ${at(outer, from)} A ${outer} ${outer} 0 0 1 ${at(outer, mid)}` +
      ` A ${outer} ${outer} 0 0 1 ${at(outer, from)}` +
      ` M ${at(inner, from)} A ${inner} ${inner} 0 0 0 ${at(inner, mid)}` +
      ` A ${inner} ${inner} 0 0 0 ${at(inner, from)} Z`
    )
  }
  const big = to - from > Math.PI ? 1 : 0
  return (
    `M ${at(outer, from)} A ${outer} ${outer} 0 ${big} 1 ${at(outer, to)}` +
    ` L ${at(inner, to)} A ${inner} ${inner} 0 ${big} 0 ${at(inner, from)} Z`
  )
}

/** How many crossings a grid draws before it starts saying what it left out.
 *
 *  A month of hours is 31 by 24, which is the densest shape anybody actually
 *  asks a ClickHouse for and the reason these are the numbers they are: the
 *  canonical heatmap fits exactly, and the cap is reached by results that were
 *  going to be unreadable anyway. */
export const HEAT_COLS = 36
export const HEAT_ROWS = 24

export interface Grid {
  /** Distinct x values, in the order the query returned them. */
  xs: string[]
  ys: string[]
  /** Row-major, `ys.length` by `xs.length`. `null` is a crossing the query
   *  never returned — which is not the fact that it returned a zero, and the
   *  grid draws the two differently. */
  cells: (number | null)[][]
  /** What a full cell's worth of ink is measured against. */
  scale: number
  /** Distinct values past the cap, per axis. Stated rather than dropped. */
  xCut: number
  yCut: number
  /** Cells above the scale, drawn full and marked. */
  past: number
}

/** The grid, in the order the query asked for.
 *
 *  Both axes keep first-appearance order rather than being sorted, on the same
 *  rule the bar chart follows: the order is the question's. Sorting a heatmap's
 *  columns alphabetically would overrule an `ORDER BY total DESC` that exists
 *  precisely to put the interesting host first, and a bucketed time column
 *  already arrives in the order it means.
 *
 *  The scale is the 90th percentile and not the maximum, which is the same
 *  physics as every other cell grid in Flint — one outlying crossing otherwise
 *  washes the entire grid to the floor and the picture says nothing. Cells
 *  above it are drawn full and counted, so nothing is hidden by the choice. */
export function buildGrid(
  rows: unknown[][],
  xCol: number,
  yCol: number,
  valueCol: number,
  text: (v: unknown) => string,
): Grid | null {
  const xs: string[] = []
  const ys: string[] = []
  const allX = new Set<string>()
  const allY = new Set<string>()
  const seen = new Map<string, number>()
  for (const r of rows) {
    const x = text(r[xCol])
    const y = text(r[yCol])
    allX.add(x)
    allY.add(y)
    if (!xs.includes(x) && xs.length < HEAT_COLS) xs.push(x)
    if (!ys.includes(y) && ys.length < HEAT_ROWS) ys.push(y)
    seen.set(`${x} ${y}`, parseNumber(r[valueCol]))
  }
  if (xs.length === 0 || ys.length === 0) return null

  const cells = ys.map((y) =>
    xs.map((x) => {
      const v = seen.get(`${x} ${y}`)
      return v === undefined || !Number.isFinite(v) ? null : v
    }),
  )
  const values = cells.flat().filter((v): v is number => v !== null)
  const scale = barScale(values)
  return {
    xs,
    ys,
    cells,
    scale,
    xCut: allX.size - xs.length,
    yCut: allY.size - ys.length,
    past: scale > 0 ? values.filter((v) => v > scale).length : 0,
  }
}

/** A cell's share of the ink, or none for a crossing that never happened.
 *
 *  The floor is the shared one: "small" and "not there" are different answers
 *  and a grid of cells exists to tell them apart, so anything present keeps a
 *  visible share of the ink even where its true share rounds to nothing. */
export function cellFill(value: number | null, scale: number): number {
  if (value === null) return 0
  if (scale <= 0) return CELL_FLOOR
  return Math.max(CELL_FLOOR, Math.min(1, value / scale))
}

/* ── How tall a plot is ──────────────────────────────────────────────────
 * The chart used to be 300px tall and 720px wide whatever it was given. The
 * width was a sizing loop — `.chart` is a flex item, so its width came from its
 * content, and its content was an SVG asking for 100% of it — and the height was
 * simply a constant. On the query page that put a 720×300 drawing inside a
 * 1366×671 box: a quarter of the space, with the rest white. A chart that does
 * not fill its frame reads as a chart that failed to load, which is the worst
 * thing it can do on the one screen somebody might show to a colleague.
 *
 * So both are measured, and the height is bounded rather than free. Two bounds,
 * for two different ways of being wrong:
 *
 * - **A floor**, because a plot squeezed under about 200px stops being readable
 *   — the gridlines and the x-axis band eat it — and it is better to overflow a
 *   short container than to draw something nobody can read in it.
 * - **An aspect cap**, because a time series 1300px wide and 650px tall is a
 *   wall. Data drawn taller than about half its width exaggerates every wiggle
 *   into a mountain; the convention across every chart library worth copying is
 *   somewhere between 16:9 and 21:9, and half is inside that.
 *
 * Small multiples are the exception and take the room: each series gets its own
 * panel, so the ceiling is per panel rather than for the stack. */

/** The floor. Below this the axis band and the gridlines are most of the ink. */
const PLOT_MIN_H = 200
/** Never taller than this, however tall the container. */
const PLOT_MAX_H = 560
/** Nor taller than this share of its own width. */
const PLOT_ASPECT = 0.5

export function plotHeight(
  width: number,
  available: number,
  /** How many panels the height is shared between — one for a single plot, one
   *  per series for small multiples. */
  panels = 1,
): number {
  // A figure is a stat, or a container that has not been measured yet. Fall
  // back to the aspect rule over the width, which is always known first.
  const room = available > 0 ? available : Math.round(width * PLOT_ASPECT)
  const cap = Math.min(PLOT_MAX_H, Math.round(width * PLOT_ASPECT)) * Math.max(1, panels)
  return Math.max(PLOT_MIN_H, Math.min(room, cap))
}
