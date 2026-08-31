import { describe, expect, it } from 'vitest'

import { analyse, histogram, observations, quantile } from './analyse'

const result = (
  columns: { name: string; type: string }[],
  rows: unknown[][],
): { columns: { name: string; type: string }[]; rows: unknown[][] } => ({ columns, rows })

describe('analyse', () => {
  it('counts nulls and empty strings apart', () => {
    const read = analyse(
      result([{ name: 'host', type: 'Nullable(String)' }], [['a'], [null], [''], ['a']]),
    )
    const host = read.columns[0]!
    expect(host.n).toBe(4)
    expect(host.nulls).toBe(1)
    expect(host.empties).toBe(1)
    expect(host.distinct).toBe(2)
  })

  it('names the one value of a constant column', () => {
    const read = analyse(result([{ name: 'env', type: 'String' }], [['prod'], ['prod']]))
    expect(read.columns[0]!.constant).toBe('prod')
  })

  it('spots a column that is a different value every row', () => {
    const read = analyse(result([{ name: 'id', type: 'UInt64' }], [['1'], ['2'], ['3']]))
    expect(read.columns[0]!.unique).toBe(true)
  })

  it('does not call a single row unique', () => {
    const read = analyse(result([{ name: 'id', type: 'UInt64' }], [['1']]))
    expect(read.columns[0]!.unique).toBe(false)
  })

  it('reads numbers that arrived as strings, which Int64 always does', () => {
    const read = analyse(
      result([{ name: 'ms', type: 'UInt64' }], [['10'], ['20'], ['30'], ['40']]),
    )
    const facts = read.columns[0]!.numbers!
    expect(facts.min).toBe(10)
    expect(facts.max).toBe(40)
    expect(facts.sum).toBe(100)
    expect(facts.mean).toBe(25)
    expect(facts.p50).toBe(20)
    expect(facts.p95).toBe(40)
  })

  it('leaves the numeric facts absent for a column that has none', () => {
    const read = analyse(result([{ name: 'host', type: 'String' }], [['a']]))
    expect(read.columns[0]!.numbers).toBeUndefined()
    expect(read.columns[0]!.times).toBeUndefined()
  })

  it('measures the stretch of time a timestamp column covers', () => {
    const read = analyse(
      result(
        [{ name: 'ts', type: 'DateTime' }],
        [['2024-05-01 12:00:00'], ['2024-05-01 13:00:00'], ['2024-05-01 12:30:00']],
      ),
    )
    const times = read.columns[0]!.times!
    expect(times.from).toBe('2024-05-01 12:00:00')
    expect(times.to).toBe('2024-05-01 13:00:00')
    expect(times.seconds).toBe(3600)
  })

  it('still reports the extent when the dates do not parse', () => {
    const read = analyse(result([{ name: 'ts', type: 'DateTime' }], [['bbb'], ['aaa']]))
    const times = read.columns[0]!.times!
    expect(times.from).toBe('aaa')
    expect(times.to).toBe('bbb')
    expect(times.seconds).toBeNull()
  })

  it('ranks the top values', () => {
    const read = analyse(
      result([{ name: 'host', type: 'String' }], [['a'], ['b'], ['a'], ['c'], ['a'], ['b']]),
    )
    expect(read.columns[0]!.top.slice(0, 3)).toEqual([
      { value: 'a', n: 3 },
      { value: 'b', n: 2 },
      { value: 'c', n: 1 },
    ])
  })

  it('says when it stopped counting distinct values rather than guessing', () => {
    const rows = Array.from({ length: 900 }, (_, i) => [`v${i}`])
    const read = analyse(result([{ name: 'v', type: 'String' }], rows))
    expect(read.columns[0]!.distinctCapped).toBe(true)
    expect(read.columns[0]!.constant).toBeNull()
    expect(read.columns[0]!.unique).toBe(false)
  })

  it('holds an empty result without inventing anything', () => {
    const read = analyse(result([{ name: 'a', type: 'String' }], []))
    expect(read.rows).toBe(0)
    expect(read.columns[0]!.distinct).toBe(0)
    expect(read.columns[0]!.top).toEqual([])
    expect(observations(read)).toEqual([])
  })

  it('samples a very large result and says so', () => {
    const columns = Array.from({ length: 40 }, (_, i) => ({ name: `c${i}`, type: 'UInt8' }))
    const rows = Array.from({ length: 20_000 }, () => columns.map(() => '1'))
    const read = analyse(result(columns, rows))
    expect(read.sampled).toBe(true)
    expect(read.rows).toBe(20_000)
    expect(read.examined).toBeLessThan(20_000)
  })
})

describe('observations', () => {
  it('leads with the columns that taught the reader nothing', () => {
    const read = analyse(
      result(
        [
          { name: 'env', type: 'String' },
          { name: 'note', type: 'Nullable(String)' },
        ],
        [
          ['prod', null],
          ['prod', null],
        ],
      ),
    )
    expect(observations(read)).toEqual([
      { column: 'env', text: 'one value throughout — prod', tone: 'warn' },
      { column: 'note', text: 'null in every row', tone: 'warn' },
    ])
  })

  it('reports a column that is mostly, but not entirely, null', () => {
    const read = analyse(
      result([{ name: 'a', type: 'Nullable(String)' }], [['x'], ['y'], [null], [null], [null]]),
    )
    expect(observations(read)[0]).toEqual({
      column: 'a',
      text: 'null in 60% of rows',
      tone: 'note',
    })
  })

  it('says both halves of a column that never varies and is often null', () => {
    const read = analyse(
      result([{ name: 'a', type: 'Nullable(String)' }], [['x'], [null], [null], [null]]),
    )
    expect(observations(read)[0]).toEqual({
      column: 'a',
      text: 'one value where it is set — x — and null in 75% of rows',
      tone: 'warn',
    })
  })

  it('separates empty strings from nulls out loud', () => {
    const read = analyse(result([{ name: 'a', type: 'String' }], [['x'], [''], ['y']]))
    expect(observations(read)).toContainEqual({
      column: 'a',
      text: '1 empty string, not null',
      tone: 'note',
    })
  })
})

describe('the maths', () => {
  it('takes the nearest rank rather than interpolating', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2)
    expect(quantile([1, 2, 3, 4], 0.95)).toBe(4)
    expect(quantile([], 0.5)).toBeNaN()
  })

  it('puts every value of a flat column in one bucket', () => {
    expect(histogram([5, 5, 5], 4)).toEqual([3, 0, 0, 0])
  })

  it('buckets a spread and keeps the total', () => {
    const bins = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5)
    expect(bins.reduce((a, b) => a + b, 0)).toBe(10)
    expect(bins).toEqual([2, 2, 2, 2, 2])
  })
})
