import { describe, expect, it } from 'vitest'

import { specToDsl, type DslQuery } from './dsl'
import { startingSpec, type Condition, type Having, type Projection, type QuerySpec } from './query'

const spec = (over: Partial<QuerySpec> = {}): QuerySpec => ({
  ...startingSpec('analytics', 'events'),
  ...over,
})

const dim = (column: string, bucket: Projection['bucket'] = null): Projection => ({
  id: column,
  column,
  agg: null,
  bucket,
})

const met = (column: string, agg: Projection['agg']): Projection => ({
  id: `${agg}-${column}`,
  column,
  agg,
  bucket: null,
})

const cond = (over: Partial<Condition>): Condition => ({
  id: 'c',
  column: 'city',
  op: '=',
  value: '',
  value2: '',
  ...over,
})

const have = (over: Partial<Having> = {}): Having => ({
  id: 'h',
  ref: 'count_*',
  op: '>',
  value: '10',
  ...over,
})

/** The query, or a failure that names what blocked it. */
function query(s: QuerySpec): DslQuery {
  const out = specToDsl(s)
  if ('blocked' in out) throw new Error(`blocked: ${out.blocked}`)
  return out.query
}

function blocked(s: QuerySpec): string {
  const out = specToDsl(s)
  if (!('blocked' in out)) throw new Error('expected it to be blocked')
  return out.blocked
}

describe('specToDsl and the timezone', () => {
  it('sends it where there is a boundary to move', () => {
    // A bucket is a wall between days, and a window's edges are midnights.
    // Either one is somewhere, and on a server in another country it is
    // quietly somewhere else.
    const bucketed = query(
      spec({ projections: [dim('ts', 'day'), met('*', 'count')], timezone: 'Pacific/Auckland' }),
    )
    expect(bucketed.timezone).toBe('Pacific/Auckland')

    const windowed = query(
      spec({
        projections: [dim('city')],
        conditions: [cond({ column: 'ts', op: 'since', value: '7d' })],
        timezone: 'Pacific/Auckland',
      }),
    )
    expect(windowed.timezone).toBe('Pacific/Auckland')
  })

  it('leaves it out where there is none', () => {
    // The server refuses a zone that would place nothing, so sending a stale
    // one from an earlier question would turn it into a refusal the Builder
    // could not explain.
    const flat = query(spec({ projections: [dim('city')], timezone: 'Pacific/Auckland' }))
    expect(flat.timezone).toBeUndefined()
  })

  it("and leaves it out for the server's own", () => {
    const own = query(spec({ projections: [dim('ts', 'day'), met('*', 'count')], timezone: '' }))
    expect(own.timezone).toBeUndefined()
  })
})

describe('specToDsl', () => {
  it('names the dataset the way the API does', () => {
    expect(query(spec({ projections: [dim('city')] })).dataset).toBe('analytics.events')
  })

  it('reads a spec with no aggregate as a plain selection', () => {
    const q = query(spec({ projections: [dim('city'), dim('status')] }))
    expect(q.select).toEqual(['city', 'status'])
    expect(q.dimensions).toBeUndefined()
    expect(q.metrics).toBeUndefined()
  })

  it('reads one with an aggregate as a grouping', () => {
    const q = query(spec({ projections: [dim('city'), met('*', 'count')] }))
    expect(q.dimensions).toEqual(['city'])
    // `count(*)` counts rows, and the document says that by naming no column.
    expect(q.metrics).toEqual([{ aggregation: 'count', as: 'rows' }])
    expect(q.select).toBeUndefined()
  })

  it('keeps the names already on screen', () => {
    // The answer's keys have to be the ones the Builder is showing, or the
    // table redraws with different headings than the controls that made it.
    const q = query(spec({ projections: [met('latency_ms', 'p95')] }))
    expect(q.metrics?.[0]?.as).toBe('p95_latency_ms')
  })

  it('maps the approximate distinct count onto the approximate one', () => {
    // The drift that made converging worth doing: this has always been an
    // estimate here and the exact answer there, under one word.
    const q = query(spec({ projections: [met('city', 'uniq')] }))
    expect(q.metrics?.[0]?.aggregation).toBe('distinct_count_approx')
  })

  it('turns a bucket into the question’s time granularity', () => {
    const q = query(spec({ projections: [dim('ts', 'day'), met('*', 'count')] }))
    expect(q.time).toEqual({ column: 'ts', granularity: 'day' })
    // Named in `time`, so not repeated as a dimension.
    expect(q.dimensions).toBeUndefined()
  })

  it('turns "in the last" into a window', () => {
    const q = query(
      spec({ projections: [met('*', 'count')], conditions: [cond({ column: 'ts', op: 'since', value: '24h' })] }),
    )
    expect(q.time).toEqual({ column: 'ts', last: 24, unit: 'hour' })
    expect(q.filter).toBeUndefined()
  })

  describe('filters', () => {
    it('sends one condition as one node rather than a group of one', () => {
      const q = query(spec({ projections: [dim('city')], conditions: [cond({ value: 'Oslo' })] }))
      expect(q.filter).toEqual({ column: 'city', op: 'eq', value: 'Oslo' })
    })

    it('and several as a conjunction', () => {
      const q = query(
        spec({
          projections: [dim('city')],
          conditions: [cond({ value: 'Oslo' }), cond({ id: 'd', column: 'n', op: '>', value: '5' })],
        }),
      )
      expect(q.filter).toEqual({
        all: [
          { column: 'city', op: 'eq', value: 'Oslo' },
          { column: 'n', op: 'gt', value: '5' },
        ],
      })
    })

    it('expresses the operators the server does not have out of the ones it does', () => {
      // `between` is two bounds and `notLike` is a negation. Neither needs an
      // operator of its own where there is a tree.
      const between = query(
        spec({
          projections: [dim('city')],
          conditions: [cond({ column: 'n', op: 'between', value: '1', value2: '9' })],
        }),
      )
      expect(between.filter).toEqual({
        all: [
          { column: 'n', op: 'gte', value: '1' },
          { column: 'n', op: 'lte', value: '9' },
        ],
      })

      const unlike = query(
        spec({ projections: [dim('city')], conditions: [cond({ op: 'notLike', value: '%a%' })] }),
      )
      expect(unlike.filter).toEqual({ not: { column: 'city', op: 'like', value: '%a%' } })
    })

    it('splits a list, and drops one that has nothing in it', () => {
      const q = query(
        spec({ projections: [dim('city')], conditions: [cond({ op: 'in', value: 'Oslo, Lyon' })] }),
      )
      expect(q.filter).toEqual({ column: 'city', op: 'in', values: ['Oslo', 'Lyon'] })

      const empty = query(
        spec({ projections: [dim('city')], conditions: [cond({ op: 'in', value: ' , ' })] }),
      )
      expect(empty.filter).toBeUndefined()
    })

    it('leaves a half-typed condition out rather than guessing at it', () => {
      // The same rule the SQL builder follows: no clause beats a clause that
      // means something the person typing has not finished saying.
      const q = query(spec({ projections: [dim('city')], conditions: [cond({ value: '' })] }))
      expect(q.filter).toBeUndefined()
    })

    it('asks whether a column is null without a value', () => {
      const q = query(spec({ projections: [dim('city')], conditions: [cond({ op: 'isNull' })] }))
      expect(q.filter).toEqual({ column: 'city', op: 'isnull' })
    })
  })

  it('sends a filter on a computed value as `having`', () => {
    const q = query(spec({ projections: [dim('city'), met('*', 'count')], having: [have()] }))
    expect(q.having).toEqual({ column: 'count_*', op: 'gt', value: '10' })
  })

  it('carries the order and the limit', () => {
    const q = query(
      spec({
        projections: [dim('city')],
        orderings: [{ id: 'o', ref: 'city', desc: true }],
        limit: 25,
      }),
    )
    expect(q.order).toEqual([{ column: 'city', desc: true }])
    expect(q.limit).toBe(25)
  })

  describe('questions with more than one time in them', () => {
    /* These three were refused for a while, because the document held one
       `time` and the Builder had always allowed several. Blocking them made
       Flint unable to ask what Flint could ask, which is not a trade converging
       two languages is allowed to make. */

    it('buckets two columns', () => {
      const q = query(
        spec({ projections: [dim('ts', 'day'), dim('seen_at', 'hour'), met('*', 'count')] }),
      )
      expect(q.time).toEqual([
        { column: 'ts', granularity: 'day' },
        { column: 'seen_at', granularity: 'hour' },
      ])
    })

    it('narrows on two windows', () => {
      const q = query(
        spec({
          projections: [met('*', 'count')],
          conditions: [
            cond({ column: 'created_at', op: 'since', value: '7d' }),
            cond({ id: 'd', column: 'updated_at', op: 'since', value: '24h' }),
          ],
        }),
      )
      expect(q.time).toEqual([
        { column: 'created_at', last: 7, unit: 'day' },
        { column: 'updated_at', last: 24, unit: 'hour' },
      ])
    })

    it('buckets one column and windows another', () => {
      const q = query(
        spec({
          projections: [dim('ts', 'day'), met('*', 'count')],
          conditions: [cond({ column: 'seen_at', op: 'since', value: '24h' })],
        }),
      )
      expect(q.time).toEqual([
        { column: 'ts', granularity: 'day' },
        { column: 'seen_at', last: 24, unit: 'hour' },
      ])
    })

    it('reads a window and a bucket on one column as one entry', () => {
      // Two entries on the same column would filter it twice, which is not
      // wrong and is not what anybody wrote.
      const q = query(
        spec({
          projections: [dim('ts', 'day'), met('*', 'count')],
          conditions: [cond({ column: 'ts', op: 'since', value: '7d' })],
        }),
      )
      expect(q.time).toEqual({ column: 'ts', granularity: 'day', last: 7, unit: 'day' })
    })

    it('still says so when a window is not a window', () => {
      expect(
        blocked(
          spec({
            projections: [met('*', 'count')],
            conditions: [cond({ column: 'ts', op: 'since', value: 'a fortnight' })],
          }),
        ),
      ).toContain('not a window')
    })

    it('and before a table is chosen', () => {
      expect(blocked({ ...startingSpec('analytics', ''), projections: [] })).toContain('table')
    })
  })
})
