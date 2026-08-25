import { describe, expect, it } from 'vitest'

import {
  MAX_SERIES,
  classifyColumns,
  compact,
  needsFacets,
  niceTicks,
  parseNumber,
  parseTime,
  suggestCharts,
  timeLabel,
  type Column,
} from './chart'

const col = (name: string, type: string): Column => ({ name, type })

describe('classifyColumns', () => {
  it('sorts columns into axes, measures and labels', () => {
    const c = classifyColumns([
      col('ts', 'DateTime64(3)'),
      col('city', 'LowCardinality(Nullable(String))'),
      col('events', 'UInt64'),
      col('tags', 'Array(String)'),
    ])
    expect(c.times).toEqual([0])
    expect(c.labels).toEqual([1])
    expect(c.metrics).toEqual([2])
  })

  it('leaves nested columns out of every role — they need unpacking first', () => {
    const c = classifyColumns([col('m', 'Map(String, UInt8)')])
    expect(c).toEqual({ times: [], metrics: [], labels: [] })
  })
})

describe('suggestCharts', () => {
  it('offers nothing to plot when there is no measure', () => {
    expect(suggestCharts([col('city', 'String')], 10)).toEqual([])
  })

  it('calls a single value a figure, never a one-bar chart', () => {
    const s = suggestCharts([col('rows', 'UInt64')], 1)
    expect(s).toHaveLength(1)
    expect(s[0]!.kind).toBe('stat')
  })

  it('leads with a line when there is a time column', () => {
    const s = suggestCharts(
      [col('hour', 'DateTime'), col('city', 'String'), col('events', 'UInt64')],
      100,
    )
    expect(s[0]!.kind).toBe('line')
    expect(s[0]!.x).toBe(0)
    expect(s[0]!.series).toEqual([2])
  })

  it('offers a bar for a label and a measure', () => {
    const s = suggestCharts([col('city', 'String'), col('events', 'UInt64')], 20)
    expect(s[0]!.kind).toBe('bar')
    expect(s[0]!.x).toBe(0)
  })

  it('offers a scatter for two measures with no time', () => {
    const s = suggestCharts([col('temp', 'Float32'), col('latency', 'UInt32')], 500)
    const scatter = s.find((x) => x.kind === 'scatter')!
    expect(scatter.x).toBe(0)
    expect(scatter.series).toEqual([1])
  })

  it('does not offer a scatter once there is a time axis', () => {
    const s = suggestCharts(
      [col('ts', 'DateTime'), col('a', 'Float32'), col('b', 'Float32')],
      500,
    )
    expect(s.some((x) => x.kind === 'scatter')).toBe(false)
  })

  it('caps the series at the palette rather than inventing hues', () => {
    const columns = [col('ts', 'DateTime'), ...Array.from({ length: 9 }, (_, i) => col(`m${i}`, 'UInt64'))]
    const s = suggestCharts(columns, 100)
    expect(s[0]!.series).toHaveLength(MAX_SERIES)
  })

  it('falls back to ranking the rows when there is no axis at all', () => {
    const s = suggestCharts([col('n', 'UInt64')], 50)
    expect(s[0]!.kind).toBe('bar')
    expect(s[0]!.x).toBe(-1)
  })
})

describe('parseTime', () => {
  it('reads a ClickHouse DateTime as UTC, not as local time', () => {
    expect(parseTime('2026-08-24 09:00:00')).toBe(Date.parse('2026-08-24T09:00:00Z'))
  })

  it('respects an explicit zone when one is there', () => {
    expect(parseTime('2026-08-24T09:00:00+02:00')).toBe(Date.parse('2026-08-24T09:00:00+02:00'))
  })

  it('is NaN for a null', () => {
    expect(parseTime(null)).toBeNaN()
  })
})

describe('parseNumber', () => {
  it('reads a 64-bit integer that arrived as a string', () => {
    // Quoted on the wire so the browser cannot silently round it.
    expect(parseNumber('9007199254740993')).toBe(9007199254740992)
    expect(parseNumber('42')).toBe(42)
  })

  it('is NaN for a null or an empty cell', () => {
    expect(parseNumber(null)).toBeNaN()
    expect(parseNumber('')).toBeNaN()
    expect(parseNumber('abc')).toBeNaN()
  })
})

describe('niceTicks', () => {
  it('lands on round numbers', () => {
    expect(niceTicks(0, 100)).toEqual([0, 20, 40, 60, 80, 100])
    expect(niceTicks(0, 1000)).toEqual([0, 200, 400, 600, 800, 1000])
  })

  it('includes a clean zero rather than a floating-point crumb', () => {
    expect(niceTicks(-10, 10)).toContain(0)
    expect(niceTicks(-10, 10).filter((t) => t === 0)).toHaveLength(1)
  })

  it('returns the single value when there is no span', () => {
    expect(niceTicks(5, 5)).toEqual([5])
  })

  it('terminates on a pathological range', () => {
    expect(niceTicks(0, 1e-12).length).toBeLessThan(41)
    expect(niceTicks(NaN, 10)).toEqual([])
  })
})

describe('compact', () => {
  it.each([
    [0, '0'],
    [42, '42'],
    [1234, '1234'],
    [12_900, '12.9K'],
    [4_200_000, '4.2M'],
    [1_500_000_000, '1.5B'],
    [0.00123, '0.00123'],
  ])('renders %s as %s', (n, expected) => {
    expect(compact(n)).toBe(expected)
  })

  it('is a dash rather than NaN', () => {
    expect(compact(NaN)).toBe('—')
  })
})

describe('timeLabel', () => {
  const t = Date.parse('2026-08-24T09:05:00Z')

  it('shows the time for a short span', () => {
    expect(timeLabel(t, 3600e3)).toBe('09:05')
  })

  it('shows the day for a long one', () => {
    expect(timeLabel(t, 30 * 86400e3)).toBe('24/08')
  })

  it('shows the month across a year', () => {
    expect(timeLabel(t, 800 * 86400e3)).toBe('08/2026')
  })
})

describe('omitted series', () => {
  it('reports the measures it could not seat', () => {
    const columns = [
      col('ts', 'DateTime'),
      ...Array.from({ length: 9 }, (_, i) => col(`m${i}`, 'UInt64')),
    ]
    const line = suggestCharts(columns, 100)[0]!
    expect(line.series).toHaveLength(MAX_SERIES)
    expect(line.omitted).toBe(3)
  })

  it('omits nothing when every measure fits', () => {
    const line = suggestCharts([col('ts', 'DateTime'), col('a', 'UInt64')], 100)[0]!
    expect(line.omitted).toBe(0)
  })
})

describe('needsFacets', () => {
  it('shares one axis when both series use it', () => {
    expect(needsFacets([{ min: 0, max: 240 }, { min: 0, max: 180 }])).toBe(false)
    expect(needsFacets([{ min: 100, max: 200 }, { min: 90, max: 150 }])).toBe(false)
  })

  it('splits when a series is crushed against the baseline', () => {
    // The case that produced a flat line: events ~236 beside temperature ~30.
    // A ratio of only eight, and still unreadable on a shared axis.
    expect(needsFacets([{ min: 210, max: 236 }, { min: 29.9, max: 30.2 }])).toBe(true)
    expect(needsFacets([{ min: 0, max: 1_000_000 }, { min: 10, max: 12 }])).toBe(true)
  })

  it('never splits a single series', () => {
    expect(needsFacets([{ min: 0, max: 240 }])).toBe(false)
    expect(needsFacets([])).toBe(false)
  })

  it('does not divide by zero when every value is the same', () => {
    expect(needsFacets([{ min: 5, max: 5 }, { min: 5, max: 5 }])).toBe(false)
  })

  it('ignores a series with no finite values', () => {
    expect(needsFacets([{ min: 0, max: 240 }, { min: NaN, max: NaN }])).toBe(false)
  })
})

describe('niceTicks tick count', () => {
  it('lands near the target instead of flooring the step', () => {
    // 0–96K used to floor to a 10K step: ten gridlines for a target of five.
    expect(niceTicks(0, 96_000)).toEqual([0, 20_000, 40_000, 60_000, 80_000])
    expect(niceTicks(0, 96_000).length).toBeLessThanOrEqual(6)
  })

  it('keeps counts sane across magnitudes', () => {
    for (const max of [7, 19, 37, 96, 480, 1_900, 96_000, 3_400_000]) {
      const n = niceTicks(0, max).length
      expect(n).toBeGreaterThanOrEqual(3)
      expect(n).toBeLessThanOrEqual(8)
    }
  })
})
