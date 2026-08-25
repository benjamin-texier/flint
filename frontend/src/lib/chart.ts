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

export interface Column {
  name: string
  type: string
}

export type ChartKind = 'stat' | 'line' | 'bar' | 'scatter'

export interface ChartSpec {
  kind: ChartKind
  /** Column index for the x axis, or -1 when the row's position is the axis. */
  x: number
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
export function suggestCharts(columns: Column[], rows: number): ChartSpec[] {
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
