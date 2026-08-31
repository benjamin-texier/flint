import { describe, expect, it } from 'vitest'

import {
  cadence,
  countsUp,
  forSpark,
  headline,
  moved,
  omissions,
  ordered,
  pair,
  periodLabel,
  read,
  says,
  thirds,
  type Drift,
  type Finding,
  type Series,
} from './drift'

/** A reading of `n` periods, all alike. The shapes below change one thing about
 *  it at a time, which is the only way to know which rule fired. */
const flat = (n: number, over: Partial<Drift> = {}): Drift => ({
  available: true,
  reason: null,
  database: 'analytics',
  table: 'readings',
  time_column: 'ts',
  step: 'day',
  periods: Array.from({ length: n }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')} 00:00:00`),
  rows: new Array(n).fill(4000),
  series: [],
  columns: 5,
  examined: 4,
  windowed: false,
  ...over,
})

const series = (name: string, over: Partial<Series> = {}): Series => ({
  name,
  type: 'String',
  nulls: null,
  distinct: [],
  mean: null,
  ...over,
})

/** A run of `n` values that steps from `a` to `b` at index `at`. */
const step = (n: number, a: number, b: number, at: number) =>
  Array.from({ length: n }, (_, i) => (i < at ? a : b))

const finding = (over: Partial<Finding> = {}): Finding => ({
  kind: 'fleet',
  column: 'sensor',
  at: '2026-08-15 00:00:00',
  was: '500',
  now: '12',
  ...over,
})

describe('what counts as news', () => {
  it('says nothing about a table that did not change', () => {
    /* The common case on a healthy table, and the one a detector must not
       decorate: a fixture of 483,188 rows gave 5,664 rows a day and 400 devices
       for eighty days, and there is no story in that. */
    const d = flat(12, { series: [series('sensor', { distinct: new Array(12).fill(500) })] })
    const r = read(d)
    expect(r.findings).toEqual([])
    expect(r.partial).toHaveLength(2)
  })

  it('does not read the partial ends as a collapse and a recovery', () => {
    /* Measured on `lab.traffic`: 51,741 then 86,400 then 126,941 and then a
       month of 172,800. The table began part-way through a day and is still
       filling today. Counting either end fires on every table there is. */
    const rows = new Array(12).fill(172_800)
    rows[0] = 51_741
    rows[11] = 90_000
    expect(read(flat(12, { rows })).findings).toEqual([])
  })

  it('finds a fleet that collapsed, and names the period', () => {
    const d = flat(12, { series: [series('sensor', { distinct: step(12, 500, 12, 7) })] })
    const f = read(d).findings.find((x) => x.kind === 'fleet')
    expect(f?.column).toBe('sensor')
    // Rounded together: "500" beside "12.0" reads as two measurements of one
    // quantity taken to different precisions.
    expect([f?.was, f?.now]).toEqual(['500', '12'])
    expect(f?.at).toBe('2026-08-08 00:00:00')
  })

  it('does not call a flag a fleet', () => {
    // 3 distinct values to 1 is a boolean that stopped being set both ways, and
    // calling it a collapse would fire on every flag in every table.
    const d = flat(12, { series: [series('flag', { distinct: step(12, 3, 1, 7) })] })
    expect(read(d).findings).toEqual([])
  })

  it('finds a column that stopped being filled', () => {
    const d = flat(12, {
      series: [series('region', { type: 'Nullable(String)', nulls: step(12, 0.05, 1, 7), distinct: new Array(12).fill(5) })],
    })
    const f = read(d).findings.find((x) => x.kind === 'filling')
    expect([f?.was, f?.now]).toEqual(['5.0%', '100.0%'])
  })

  it('ignores a share that moved by a couple of points', () => {
    // 2% to 4% is a doubling and means almost nothing; a share is already a
    // proportion, so the threshold on it is absolute.
    const d = flat(12, {
      series: [series('region', { type: 'Nullable(String)', nulls: step(12, 0.02, 0.04, 7), distinct: new Array(12).fill(5) })],
    })
    expect(read(d).findings).toEqual([])
  })

  it('names a counter rather than reporting it as a change', () => {
    /* Found the way the rest of this was: a fixture whose day counter reported
       3 → 15 beside three real findings and read exactly like them. */
    const d = flat(12, {
      series: [series('batch', { type: 'UInt32', distinct: new Array(12).fill(1), mean: Array.from({ length: 12 }, (_, i) => i) })],
    })
    const r = read(d)
    expect(r.findings).toEqual([])
    expect(r.sequences).toEqual(['batch'])
  })

  it('still finds a level that sits and then jumps', () => {
    // The shape of every real level change is non-decreasing too, so the counter
    // test has to be *strictly* rising or it throws this away.
    const d = flat(12, {
      series: [series('reading', { type: 'Float64', distinct: new Array(12).fill(20), mean: step(12, 110, 410, 7) })],
    })
    const r = read(d)
    expect(r.sequences).toEqual([])
    expect(r.findings.map((f) => [f.kind, f.was, f.now])).toContainEqual(['level', '110', '410'])
  })

  it('reports a period with no rows without needing a comparison', () => {
    const rows = new Array(12).fill(4000)
    rows[6] = 0
    const f = read(flat(12, { rows })).findings.find((x) => x.kind === 'gap')
    expect(f?.at).toBe('2026-08-07 00:00:00')
  })

  it('does not repeat one piece of news three hundred times', () => {
    // A table that stopped a year ago has a gap in every period since.
    const rows = new Array(20).fill(0)
    rows[0] = 4000
    rows[1] = 4000
    expect(read(flat(20, { rows })).findings.filter((f) => f.kind === 'gap')).toHaveLength(1)
  })

  it('holds nothing out when it read nothing', () => {
    const r = read(flat(5, { rows: [10, 4000, 4000, 4000, 10] }))
    expect(r.findings).toEqual([])
    expect(r.partial).toEqual([])
  })

  it('does not compare periods that hold no rows', () => {
    // A filled period has no reading of anything, and averaging its zero into a
    // third would invent a change out of an absence.
    const rows = new Array(14).fill(4000)
    rows[5] = 0
    rows[6] = 0
    const d = flat(14, { rows, series: [series('sensor', { distinct: new Array(14).fill(500) })] })
    expect(read(d).findings.filter((f) => f.kind !== 'gap')).toEqual([])
  })
})

describe('moved', () => {
  it('judges a rise and the fall that undoes it alike', () => {
    // Against the smaller, 100 → 200 is +100% and 200 → 100 is −50%: one
    // threshold would catch the first and miss the second.
    expect(moved([100, 100, 100, 200, 200, 200])).not.toBeNull()
    expect(moved([200, 200, 200, 100, 100, 100])).not.toBeNull()
  })

  it('counts a doubling, which sits exactly on the boundary', () => {
    expect(moved([100, 100, 100, 200, 200, 200])).toEqual([100, 200])
  })

  it('says nothing about a level that never moved off zero', () => {
    expect(moved([0, 0, 0, 0, 0, 0])).toBeNull()
  })

  it('is not fooled by one spike', () => {
    // Median rather than mean, so a single outage cannot manufacture a finding.
    expect(moved([100, 100, 900, 100, 100, 100])).toBeNull()
  })
})

describe('thirds', () => {
  it('leaves a middle belonging to neither end', () => {
    // So a change in the exact centre is not split across both ends and averaged
    // away by its own median.
    expect(thirds([1, 1, 1, 5, 9, 9, 9])).toEqual([1, 9])
  })

  it('still has an early and a late one when there are few periods', () => {
    expect(thirds([1, 2, 9])).toEqual([1, 9])
  })
})

describe('countsUp', () => {
  it('knows a sequence from a step', () => {
    expect(countsUp([1, 2, 3, 4, 5])).toBe(true)
    expect(countsUp([5, 4, 3, 2, 1])).toBe(true)
    expect(countsUp([1, 1, 1, 5, 5, 5])).toBe(false)
    expect(countsUp([1, 2])).toBe(false)
  })
})

describe('pair', () => {
  it('rounds the two readings of one finding together', () => {
    expect(pair(500, 12)).toEqual(['500', '12'])
    expect(pair(1.25, 3.5)).toEqual(['1.3', '3.5'])
  })
})

describe('periodLabel', () => {
  it('names a period at the step it was cut at', () => {
    // The server sends the same instant for every step, because `WITH FILL` can
    // only walk a real date. A month labelled with a day reads as a day.
    const at = '2026-08-15 09:00:00'
    expect(periodLabel(at, 'hour')).toBe('15 August 09:00')
    expect(periodLabel(at, 'day')).toBe('15 August')
    expect(periodLabel(at, 'week')).toBe('week of 15 August')
    expect(periodLabel(at, 'month')).toBe('August 2026')
  })

  it('hands back anything it cannot read, rather than inventing a date', () => {
    expect(periodLabel('', 'day')).toBe('')
    expect(periodLabel('not-a-date', 'day')).toBe('not-a-date')
  })
})

describe('says', () => {
  it('puts what before when, in the past then the present', () => {
    expect(says(finding(), 'day')).toBe(
      '`sensor` took 500 distinct values and now takes 12, from 15 August.',
    )
  })

  it('names the cadence when the sentence is about volume', () => {
    const f = finding({ kind: 'volume', column: null, was: '4000', now: '12000' })
    expect(says(f, 'day')).toBe('4000 rows a day became 12000, from 15 August.')
    expect(says({ ...f, at: null }, 'hour')).toBe('4000 rows an hour became 12000.')
  })

  it('says a gap as an absence, not as a change', () => {
    expect(says(finding({ kind: 'gap', column: null }), 'day')).toBe(
      'Nothing arrived in 15 August.',
    )
  })
})

describe('headline', () => {
  it('says nothing changed, plainly, when nothing did', () => {
    const d = flat(20)
    expect(headline(d, read(d))).toBe(
      'Nothing about this table has changed shape over the last 20 days.',
    )
  })

  it('counts what it found', () => {
    const d = flat(20)
    expect(headline(d, { findings: [finding()], partial: [], sequences: [] })).toBe(
      '1 thing changed over the last 20 days.',
    )
    expect(
      headline(d, { findings: [finding(), finding()], partial: [], sequences: [] }),
    ).toBe('2 things changed over the last 20 days.')
  })

  it('is not a fault when the table has no time column', () => {
    const d = flat(0, { time_column: null })
    expect(headline(d, read(d))).toContain('no date or time column')
  })
})

describe('omissions', () => {
  it('states the partial ends, because they were not counted', () => {
    const d = flat(12)
    expect(omissions(d, read(d))[0]).toContain('first and last day are partial')
  })

  it('counts the columns it read against the columns there are', () => {
    const d = flat(12)
    expect(omissions(d, read(d)).some((o) => o.includes('4 of 5 columns'))).toBe(true)
  })

  it('names a counter rather than dropping it silently', () => {
    /* "We did not look at `id`" and "`id` did not change" are different
       statements, and only one of them is true. */
    const d = flat(12)
    const one = omissions(d, { findings: [], partial: [], sequences: ['batch'] })
    expect(one.some((o) => o.includes('`batch` counts rather than measures'))).toBe(true)
    const many = omissions(d, { findings: [], partial: [], sequences: ['id', 'batch', 'version'] })
    expect(many.some((o) => o.includes('`id`, `batch` and `version` count'))).toBe(true)
  })

  it('says nothing where nothing was left out', () => {
    const d = flat(12, { examined: 5 })
    expect(omissions(d, { findings: [], partial: [], sequences: [] })).toEqual([])
  })
})

describe('ordered', () => {
  it('puts the columns a finding named first', () => {
    const d = flat(12, { series: [series('a'), series('sensor'), series('b')] })
    const r = { findings: [finding({ column: 'sensor' })], partial: [], sequences: [] }
    expect(ordered(d, r).map((x) => x.name)).toEqual(['sensor', 'a', 'b'])
  })
})

describe('forSpark', () => {
  it('breaks the line where a period holds no rows', () => {
    // A period the server invented has no reading of anything. Drawn as zero it
    // puts a cliff in the chart where there is only an absence.
    expect(forSpark([5, null, 7])).toEqual([5, undefined, 7])
  })
})

describe('cadence', () => {
  it('reads as English for each step', () => {
    expect(cadence('hour')).toBe('an hour')
    expect(cadence('day')).toBe('a day')
    expect(cadence('month')).toBe('a month')
  })
})
