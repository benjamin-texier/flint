import { describe, expect, it } from 'vitest'
import { buildModel } from './Chart'
import type { ChartSpec } from '../lib/chart'
import type { QueryResult } from '../lib/api'

/** A result whose measure never approaches zero, so the y-domain rule shows. */
const result = (cols: string[], rows: unknown[][]): QueryResult =>
  ({
    query_id: 'q',
    columns: cols.map((name) => ({ name, type: name === 'h' ? 'DateTime' : 'UInt64' })),
    rows: rows as QueryResult['rows'],
    statistics: null,
    truncated: false,
  }) as unknown as QueryResult

const rows = [
  ['2026-01-01 00:00:00', '230', '410'],
  ['2026-01-01 01:00:00', '236', '395'],
  ['2026-01-01 02:00:00', '242', '402'],
]

const spec = (kind: ChartSpec['kind'], series: number[]): ChartSpec =>
  ({ kind, x: 0, series, why: 'test' }) as ChartSpec

describe('buildModel y-domain', () => {
  it('baselines a bar at zero, because length encodes the value', () => {
    const m = buildModel(result(['h', 'n'], rows), spec('bar', [1]))
    expect(m?.yMin).toBe(0)
  })

  it('baselines a single filled line at zero, because area encodes the value', () => {
    const m = buildModel(result(['h', 'n'], rows), spec('line', [1]))
    expect(m?.yMin).toBe(0)
  })

  it('leaves a multi-series line zoomed, since there is no fill to mislead', () => {
    const m = buildModel(result(['h', 'n', 'm'], rows), spec('line', [1, 2]))
    expect(m?.yMin).toBe(230)
  })

  it('names each row for a bar label', () => {
    const m = buildModel(result(['h', 'n'], rows), spec('bar', [1]))
    expect(m?.rowLabelShort(0)).toBe('2026-01-01 00:00:00')
  })
})

describe('the order a line is drawn in', () => {
  // A grouped query comes back in whatever order the engine produced it, which
  // for a time series drew a scribble rather than a shape.
  const shuffled = [
    ['2026-01-01 02:00:00', '242'],
    ['2026-01-01 00:00:00', '230'],
    ['2026-01-01 01:00:00', '236'],
  ]

  it('draws a line left to right whatever order the rows arrived in', () => {
    const m = buildModel(result(['h', 'n'], shuffled), spec('line', [1]))
    expect(m?.series[0]!.points.map((p) => p.y)).toEqual([230, 236, 242])
    const xs = m!.series[0]!.points.map((p) => p.x)
    expect([...xs].sort((a, b) => a - b)).toEqual(xs)
  })

  it('leaves a bar in the order the query returned it', () => {
    // A bar chart's order is the question's — "the forty that cost the most" is
    // an answer, and re-sorting it would overrule an ORDER BY somebody wrote.
    const m = buildModel(result(['h', 'n'], shuffled), spec('bar', [1]))
    expect(m?.series[0]!.points.map((p) => p.y)).toEqual([242, 230, 236])
  })
})

describe('the stack', () => {
  it('bands each measure on top of the one below, and the top edge is the sum', () => {
    const m = buildModel(result(['h', 'n', 'm'], rows), spec('area', [1, 2]))
    expect(m?.stacked?.[0]!.lower).toEqual([0, 0, 0])
    expect(m?.stacked?.[0]!.upper).toEqual([230, 236, 242])
    expect(m?.stacked?.[1]!.upper).toEqual([640, 631, 644])
    // The measures themselves stay raw, so the tooltip reports what each one
    // was rather than where its band happened to sit.
    expect(m?.series[1]!.points.map((p) => p.y)).toEqual([410, 395, 402])
  })

  it('baselines at zero and reaches the tallest total', () => {
    const m = buildModel(result(['h', 'n', 'm'], rows), spec('area', [1, 2]))
    expect(m?.yMin).toBe(0)
    expect(m?.yMax).toBe(644)
  })

  it('drops a missing value out of the total instead of carrying it across', () => {
    const gappy = [
      ['2026-01-01 00:00:00', '10', '5'],
      ['2026-01-01 01:00:00', '10', null],
      ['2026-01-01 02:00:00', '10', '5'],
    ]
    const m = buildModel(result(['h', 'n', 'm'], gappy), spec('area', [1, 2]))
    expect(m?.stacked?.[1]!.upper).toEqual([15, 10, 15])
  })

  it('refuses a negative in words rather than drawing a top edge that lies', () => {
    // The picker offers the form from the shape of the result and never sees a
    // value, so this is where the claim it makes meets the numbers.
    const negative = [
      ['2026-01-01 00:00:00', '10', '-5'],
      ['2026-01-01 01:00:00', '10', '5'],
    ]
    const m = buildModel(result(['h', 'n', 'm'], negative), spec('area', [1, 2]))
    expect(m?.refusal).toContain('stack cannot draw that')
    expect(m?.stacked).toBeUndefined()
  })

  it('orders a stack left to right, like the line it is a fill of', () => {
    const shuffled = [
      ['2026-01-01 02:00:00', '1', '1'],
      ['2026-01-01 00:00:00', '2', '2'],
      ['2026-01-01 01:00:00', '3', '3'],
    ]
    const m = buildModel(result(['h', 'n', 'm'], shuffled), spec('area', [1, 2]))
    expect(m?.series[0]!.points.map((p) => p.y)).toEqual([2, 3, 1])
  })
})
