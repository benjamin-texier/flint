import { describe, expect, it } from 'vitest'

import {
  blockers,
  columns,
  headline,
  how,
  peel,
  storage,
  type Column,
  type Comparison,
  type Side,
} from './compare'

const col = (name: string, type: string, position: number): Column => ({
  name,
  type,
  position,
  default_kind: '',
  default_expression: '',
})

const side = (table: string, cols: [string, string][], over: Partial<Side> = {}): Side => ({
  database: 'shop',
  table,
  found: true,
  storage: {
    engine: 'MergeTree',
    sorting_key: 'id',
    primary_key: 'id',
    partition_key: '',
    sampling_key: '',
    total_rows: 100,
    total_bytes: 1000,
  },
  columns: cols.map(([n, t], i) => col(n, t, i + 1)),
  ...over,
})

const of = (left: [string, string][], right: [string, string][]): Comparison => ({
  left: side('orders', left),
  right: side('orders_v2', right),
})

describe('how a type changed, read left to right', () => {
  it('knows a widening from a narrowing, which is the same pair reversed', () => {
    // The whole question is direction: UInt32 becoming UInt64 is safe and the
    // other way round is not.
    expect(how('UInt32', 'UInt64')).toBe('widened')
    expect(how('UInt64', 'UInt32')).toBe('narrowed')
    expect(how('Float32', 'Float64')).toBe('widened')
    expect(how('Float64', 'Float32')).toBe('narrowed')
  })

  it('counts the sign bit', () => {
    // A signed type reaches one bit lower: UInt32 fits in Int64 and does not fit
    // in Int32, which is the off-by-one this rule exists for.
    expect(how('UInt32', 'Int64')).toBe('widened')
    expect(how('UInt32', 'Int32')).toBe('narrowed')
    expect(how('Int32', 'UInt64')).toBe('narrowed')
  })

  it('treats LowCardinality as storage, not as a change to what is held', () => {
    expect(how('String', 'LowCardinality(String)')).toBe('storage')
    expect(how('LowCardinality(String)', 'String')).toBe('storage')
  })

  it('separates gaining a null from losing one', () => {
    expect(how('Float64', 'Nullable(Float64)')).toBe('nullable')
    // The dangerous direction, and it gets its own word: the rows that were null
    // have nowhere to go.
    expect(how('Nullable(Float64)', 'Float64')).toBe('required')
  })

  it('does not call a widening safe when it also drops the null', () => {
    expect(how('Nullable(UInt32)', 'UInt64')).toBe('required')
  })

  it('reads Decimal by what it can hold on each side of the point', () => {
    expect(how('Decimal(10, 2)', 'Decimal(12, 2)')).toBe('widened')
    expect(how('Decimal(10, 2)', 'Decimal(10, 4)')).toBe('narrowed')
  })

  it('says only that they differ where it cannot promise more', () => {
    /* Int64 to Float64 is exact to 2^53 and lossy above it; String to DateTime
       parses or throws depending on the rows. Neither is a widening, and calling
       either one would be a promise this cannot keep. */
    expect(how('Int64', 'Float64')).toBe('changed')
    expect(how('String', 'DateTime')).toBe('changed')
  })
})

describe('peel', () => {
  it('takes both wrappers, in either nesting order', () => {
    expect(peel('LowCardinality(Nullable(String))')).toEqual({
      base: 'String',
      nullable: true,
      low: true,
    })
    expect(peel('Nullable(LowCardinality(String))')).toEqual({
      base: 'String',
      nullable: true,
      low: true,
    })
    expect(peel('DateTime64(3)')).toEqual({ base: 'DateTime64(3)', nullable: false, low: false })
  })
})

describe('columns', () => {
  it('reads a rename as a drop and an add, because nothing else is knowable', () => {
    /* Guessing that `client` became `customer` — from position, or from type —
       would invent a correspondence the server cannot confirm. */
    const c = of([['client', 'String']], [['customer', 'String']])
    expect(columns(c).map((x) => [x.name, x.kind])).toEqual([
      ['client', 'removed'],
      ['customer', 'added'],
    ])
  })

  it('keeps the left table\'s own order', () => {
    // A diff sorted by severity reads as a ranking; a diff in the table's order
    // reads as the table.
    const c = of(
      [
        ['a', 'String'],
        ['b', 'String'],
        ['c', 'String'],
      ],
      [
        ['c', 'String'],
        ['b', 'String'],
        ['a', 'String'],
      ],
    )
    expect(columns(c).map((x) => x.name)).toEqual(['a', 'b', 'c'])
  })

  it('records a move even when the type changed too', () => {
    /* The first version reported only the type, so a pair that swapped places
       while both were retyped never raised the positional warning. */
    const c = of(
      [
        ['a', 'String'],
        ['b', 'UInt32'],
      ],
      [
        ['b', 'UInt64'],
        ['a', 'String'],
      ],
    )
    const b = columns(c).find((x) => x.name === 'b')
    expect(b?.kind).toBe('retyped')
    expect(b?.moved).toBe(true)
    expect(blockers(c).some((s) => s.includes('INSERT without a column list'))).toBe(true)
  })

  it('notices a column that only moved', () => {
    const c = of(
      [
        ['a', 'String'],
        ['b', 'String'],
      ],
      [
        ['b', 'String'],
        ['a', 'String'],
      ],
    )
    expect(columns(c).every((x) => x.kind === 'moved')).toBe(true)
  })
})

describe('storage', () => {
  it('says when a key holds the same columns in a different order', () => {
    /* `(id, at)` and `(at, id)` are different tables to every query that filters
       on one of them, and "the sorting key changed" leaves the reader to notice
       that nothing was added or removed. */
    const c = of([['id', 'UInt32']], [['id', 'UInt32']])
    c.left.storage!.sorting_key = 'id, placed_at'
    c.right.storage!.sorting_key = 'placed_at, id'
    const s = storage(c).find((x) => x.what === 'sorting key')
    expect(s?.reordered).toBe(true)
  })

  it('does not call an actual change a reorder', () => {
    const c = of([['id', 'UInt32']], [['id', 'UInt32']])
    c.left.storage!.sorting_key = 'id, placed_at'
    c.right.storage!.sorting_key = 'id, region'
    expect(storage(c).find((x) => x.what === 'sorting key')?.reordered).toBe(false)
  })

  it('says nothing when nothing differs', () => {
    expect(storage(of([['id', 'UInt32']], [['id', 'UInt32']]))).toEqual([])
  })
})

describe('blockers', () => {
  it('names each thing in the way rather than passing a verdict', () => {
    // "Not a drop-in replacement" is a verdict nobody can act on.
    const c = of(
      [
        ['id', 'UInt64'],
        ['legacy', 'String'],
        ['total', 'Nullable(Float64)'],
      ],
      [
        ['id', 'UInt32'],
        ['total', 'Float64'],
      ],
    )
    const said = blockers(c)
    expect(said.some((s) => s.includes('`legacy` is not in orders_v2'))).toBe(true)
    expect(said.some((s) => s.includes('`id` narrows from UInt64 to UInt32'))).toBe(true)
    expect(said.some((s) => s.includes('`total` is no longer nullable'))).toBe(true)
  })

  it('names what a moved column actually breaks', () => {
    const c = of(
      [
        ['a', 'String'],
        ['b', 'String'],
      ],
      [
        ['b', 'String'],
        ['a', 'String'],
      ],
    )
    expect(blockers(c)[0]).toContain('INSERT without a column list')
  })

  it('is empty where every change is safe', () => {
    const c = of(
      [
        ['id', 'UInt32'],
        ['name', 'String'],
      ],
      [
        ['id', 'UInt64'],
        ['name', 'LowCardinality(String)'],
      ],
    )
    expect(blockers(c)).toEqual([])
  })

  it('says which table is missing rather than failing', () => {
    // Comparing against something that has been dropped is a normal thing to do
    // by accident.
    const c = of([['id', 'UInt32']], [])
    c.right.found = false
    expect(blockers(c)).toEqual(['`shop.orders_v2` does not exist.'])
  })
})

describe('headline', () => {
  it('says identical when they are', () => {
    const c = of([['id', 'UInt32']], [['id', 'UInt32']])
    expect(headline(c)).toContain('identical, column for column')
  })

  it('separates differing from breaking', () => {
    const safe = of([['id', 'UInt32']], [['id', 'UInt64']])
    expect(headline(safe)).toContain('none of it would break a query')

    const broken = of([['id', 'UInt64']], [['id', 'UInt32']])
    expect(headline(broken)).toContain('cannot stand in for orders')
  })

  it('counts the columns that differ against the columns there are', () => {
    const c = of(
      [
        ['id', 'UInt32'],
        ['name', 'String'],
      ],
      [
        ['id', 'UInt64'],
        ['name', 'String'],
      ],
    )
    expect(headline(c)).toContain('1 of the 2 columns across the two differ')
  })
})
