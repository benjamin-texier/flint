import { describe, expect, it } from 'vitest'

import { nullRatio, roleOf, showsTopValues, type ColumnProfile } from './profile'

const col = (over: Partial<ColumnProfile> & { name: string; type: string }): ColumnProfile => ({
  nullable: false,
  nulls: 0,
  distinct: 10,
  min: null,
  max: null,
  mean: null,
  median: null,
  top: [],
  ...over,
})

describe('roleOf', () => {
  const rows = 500_000

  it('reads a timestamp as time', () => {
    expect(roleOf(col({ name: 'ts', type: 'DateTime64(3)', distinct: 127_916 }), rows)).toBe('time')
    expect(roleOf(col({ name: 'day', type: 'Date', distinct: 90 }), rows)).toBe('time')
  })

  it('reads a near-unique column as an identifier, whatever its type', () => {
    expect(roleOf(col({ name: 'payload', type: 'String', distinct: 510_051 }), rows)).toBe(
      'identifier',
    )
    expect(roleOf(col({ name: 'seq', type: 'UInt64', distinct: 499_000 }), rows)).toBe('identifier')
  })

  it('reads a small set of values as a category, even when it is a number', () => {
    // The heuristic that matters: cardinality before type. Averaging a status
    // code is meaningless.
    expect(roleOf(col({ name: 'status_code', type: 'UInt8', distinct: 3 }), rows)).toBe('category')
    expect(roleOf(col({ name: 'status', type: "Enum8('ok' = 1)", distinct: 3 }), rows)).toBe(
      'category',
    )
  })

  it('reads a wide-ranging number as a metric', () => {
    expect(roleOf(col({ name: 'temperature', type: 'Float32', distinct: 250 }), rows)).toBe('metric')
    expect(roleOf(col({ name: 'latency_ms', type: 'UInt32', distinct: 900 }), rows)).toBe('metric')
  })

  it('reads a label with many values as a dimension', () => {
    expect(roleOf(col({ name: 'device_id', type: 'LowCardinality(String)', distinct: 400 }), rows)).toBe(
      'dimension',
    )
  })

  it('reads coordinates as geographic', () => {
    expect(roleOf(col({ name: 'latitude', type: 'Float64', distinct: 90_000 }), rows)).toBe(
      'geographic',
    )
    expect(roleOf(col({ name: 'lon', type: 'Float32', distinct: 80_000 }), rows)).toBe('geographic')
  })

  it('does not read a non-numeric column as geographic on its name alone', () => {
    expect(roleOf(col({ name: 'lat', type: 'String', distinct: 9 }), rows)).not.toBe('geographic')
  })

  it('reads nested data as structure', () => {
    expect(roleOf(col({ name: 'tags', type: 'Array(String)', distinct: 4 }), rows)).toBe('structure')
    expect(roleOf(col({ name: 'attrs', type: 'Map(String, String)', distinct: 900 }), rows)).toBe(
      'structure',
    )
  })

  it('trusts cardinality over an id-shaped name', () => {
    // Five thousand accounts across half a million rows is a dimension: it is
    // exactly what you would group by. The suffix does not overrule that.
    expect(roleOf(col({ name: 'account_id', type: 'String', distinct: 5_000 }), rows)).toBe(
      'dimension',
    )
  })

  it('falls back to the name only when the data cannot answer', () => {
    // Twelve rows: the distinct count is not evidence either way.
    expect(roleOf(col({ name: 'account_id', type: 'String', distinct: 12 }), 12)).toBe('identifier')
    expect(roleOf(col({ name: 'city', type: 'String', distinct: 12 }), 12)).toBe('category')
  })

  it('does not call everything an identifier on a tiny sample', () => {
    // Four distinct values in four rows is not evidence of anything.
    expect(roleOf(col({ name: 'city', type: 'String', distinct: 4 }), 4)).toBe('category')
  })
})

describe('showsTopValues', () => {
  it('shows them for a category', () => {
    expect(showsTopValues(col({ name: 'city', type: 'String', distinct: 5, top: ['Lyon'] }))).toBe(
      true,
    )
  })

  it('hides them when there are far too many to be a set', () => {
    expect(
      showsTopValues(col({ name: 'payload', type: 'String', distinct: 510_051, top: ['{...}'] })),
    ).toBe(false)
  })

  it('hides them when there are none', () => {
    expect(showsTopValues(col({ name: 'x', type: 'Float64', distinct: 900, top: [] }))).toBe(false)
  })
})

describe('nullRatio', () => {
  it('is a fraction of what was scanned', () => {
    expect(nullRatio(col({ name: 'city', type: 'String', nulls: 29_995 }), 509_900)).toBeCloseTo(
      0.0588,
      3,
    )
  })

  it('is zero rather than NaN for an empty table', () => {
    expect(nullRatio(col({ name: 'city', type: 'String', nulls: 0 }), 0)).toBe(0)
  })
})
