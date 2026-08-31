import { describe, expect, it } from 'vitest'

import { CELL_FLOOR } from './scale'
import {
  HEAT_COLS,
  MAX_SERIES,
  buildGrid,
  buildRing,
  cellFill,
  classifyColumns,
  compact,
  needsFacets,
  niceTicks,
  parseNumber,
  parseTime,
  ringPath,
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

describe('the forms that assert something about a whole', () => {
  const shares = [col('city', 'String'), col('events', 'UInt64')]

  it('offers shares for a handful of labelled parts', () => {
    expect(suggestCharts(shares, 4).map((s) => s.kind)).toContain('donut')
  })

  it('withholds shares past six parts rather than trimming the ring', () => {
    // Not a cap on the slices: the form is withheld and the same rows are a
    // bar, so there is nothing left out and nothing to say was left out.
    expect(suggestCharts(shares, 7).map((s) => s.kind)).not.toContain('donut')
    expect(suggestCharts(shares, 7).map((s) => s.kind)).toContain('bar')
  })

  it('withholds shares from a result Flint cut', () => {
    // A share computed over an arbitrary prefix is a wrong number, not an
    // incomplete one.
    expect(suggestCharts(shares, 4, true).map((s) => s.kind)).not.toContain('donut')
  })

  it('offers a stack only from two measures up', () => {
    const one = [col('h', 'DateTime'), col('n', 'UInt64')]
    const two = [...one, col('m', 'UInt64')]
    expect(suggestCharts(one, 10).map((s) => s.kind)).not.toContain('area')
    expect(suggestCharts(two, 10).map((s) => s.kind)).toContain('area')
  })

  it('offers a grid where the value sits at a crossing', () => {
    const s = suggestCharts(
      [col('hour', 'DateTime'), col('host', 'String'), col('events', 'UInt64')],
      50,
    )
    const grid = s.find((k) => k.kind === 'heatmap')
    expect(grid).toBeDefined()
    expect([grid!.x, grid!.y]).toEqual([0, 1])
  })

  it('offers no grid with only one axis', () => {
    expect(suggestCharts([col('host', 'String'), col('n', 'UInt64')], 20).map((s) => s.kind)).not.toContain(
      'heatmap',
    )
  })
})

describe('buildRing', () => {
  it('turns values into shares that close the circle', () => {
    const r = buildRing(['a', 'b', 'c'], [50, 30, 20])
    expect(typeof r).not.toBe('string')
    const ring = r as Exclude<typeof r, string>
    expect(ring.total).toBe(100)
    expect(ring.slices.map((s) => s.share)).toEqual([0.5, 0.3, 0.2])
    expect(ring.slices[2]!.to).toBeCloseTo(Math.PI * 2)
  })

  it('refuses a negative rather than drawing it, and says how many', () => {
    const r = buildRing(['a', 'b'], [10, -4])
    expect(r).toContain('One of these values is')
  })

  it('refuses a total of nothing, which is a true answer with no picture', () => {
    expect(buildRing(['a', 'b'], [0, 0])).toContain('add up to nothing')
  })

  it('never prints a bare zero beside a slice that is drawn', () => {
    const r = buildRing(['big', 'tiny'], [1_000_000, 1]) as Exclude<
      ReturnType<typeof buildRing>,
      string
    >
    expect(r.slices[1]!.share).toBeGreaterThan(0)
  })
})

describe('ringPath', () => {
  it('draws two arcs for the slice that is the whole circle', () => {
    // A single arc from a point back to itself draws nothing at all, and one
    // row at 100% is what a GROUP BY over a quiet window returns.
    const d = ringPath(0, 0, 10, 6, 0, Math.PI * 2)
    expect(d.match(/A /g)).toHaveLength(4)
  })

  it('sets the large-arc flag past a half turn', () => {
    expect(ringPath(0, 0, 10, 6, 0, Math.PI * 1.5)).toContain('A 10 10 0 1 1')
    expect(ringPath(0, 0, 10, 6, 0, Math.PI * 0.5)).toContain('A 10 10 0 0 1')
  })
})

describe('buildGrid', () => {
  const text = (v: unknown) => String(v)
  const rows: unknown[][] = [
    ['09:00', 'alpha', 10],
    ['09:00', 'beta', 4],
    ['10:00', 'alpha', 8],
  ]

  it('keeps both axes in the order the query returned them', () => {
    // The order is the question's — sorting would overrule an ORDER BY that
    // exists precisely to put the interesting host first.
    const g = buildGrid(rows, 0, 1, 2, text)!
    expect(g.xs).toEqual(['09:00', '10:00'])
    expect(g.ys).toEqual(['alpha', 'beta'])
  })

  it('tells a crossing that never happened from one that returned zero', () => {
    const g = buildGrid([...rows, ['10:00', 'beta', 0]], 0, 1, 2, text)!
    expect(g.cells[1]![1]).toBe(0)
    const without = buildGrid(rows, 0, 1, 2, text)!
    expect(without.cells[1]![1]).toBeNull()
    expect(cellFill(0, 10)).toBe(CELL_FLOOR)
    expect(cellFill(null, 10)).toBe(0)
  })

  it('counts what it left off each axis rather than dropping it silently', () => {
    const many: unknown[][] = []
    for (let i = 0; i < HEAT_COLS + 5; i += 1) many.push([`c${i}`, 'y', i])
    const g = buildGrid(many, 0, 1, 2, text)!
    expect(g.xs).toHaveLength(HEAT_COLS)
    expect(g.xCut).toBe(5)
    expect(g.yCut).toBe(0)
  })

  it('measures the ink against the 90th percentile and counts what runs past', () => {
    // Twenty crossings, one of them a hundred times the rest — which is the
    // ordinary shape of a ClickHouse grid and the reason the scale is not the
    // maximum. Scaled to 1000 the other nineteen would all sit on the floor.
    const spiky: unknown[][] = []
    for (let i = 0; i < 20; i += 1) spiky.push([`c${i}`, 'y', i === 19 ? 1000 : 10])
    const g = buildGrid(spiky, 0, 1, 2, text)!
    expect(g.scale).toBe(10)
    expect(g.past).toBe(1)
    expect(cellFill(1000, g.scale)).toBe(1)
  })
})
