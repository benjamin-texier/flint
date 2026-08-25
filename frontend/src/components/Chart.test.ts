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
