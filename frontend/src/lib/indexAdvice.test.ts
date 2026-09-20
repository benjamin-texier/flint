import { describe, expect, it } from 'vitest'

import type { Advice, AdviceColumn, Pattern } from './api'
import type { SkipIndex } from './derived'
import {
  claim,
  measurable,
  proposals,
  saysKind,
  saysNothing,
  saysUnmeasurable,
} from './indexAdvice'

/* The brief's table, the same one `projection.test` uses: ordered by
   (project_id, time), with a device_id and a type nobody put in the key. The
   two advisors read the same measurement, so they are argued against the same
   fixture. */
const COLUMNS: AdviceColumn[] = [
  { name: 'time', type: 'DateTime', sorting_position: 2, in_partition_key: false, compressed_bytes: 20_086_390 },
  { name: 'project_id', type: 'UInt32', sorting_position: 1, in_partition_key: false, compressed_bytes: 91_246 },
  { name: 'device_id', type: 'String', sorting_position: null, in_partition_key: false, compressed_bytes: 2_017_025 },
  { name: 'type', type: 'LowCardinality(String)', sorting_position: null, in_partition_key: false, compressed_bytes: 29_367 },
  { name: 'value', type: 'UInt32', sorting_position: null, in_partition_key: false, compressed_bytes: 133_915 },
]

function pattern(over: Partial<Pattern> & { statement: string }): Pattern {
  return {
    hash: over.statement.length.toString(),
    runs: 10,
    avg_ms: 40,
    p95_ms: 60,
    total_ms: 400,
    read_rows: 50_000_000,
    read_bytes: 500_000_000,
    users: 1,
    last_seen: '2026-08-29 09:00:00',
    first_seen: '2026-08-22 09:00:00',
    tables: ['lab.events'],
    projections: [],
    ...over,
  }
}

function advice(patterns: Pattern[], over: Partial<Advice> = {}): Advice {
  return {
    database: 'lab',
    table: 'events',
    engine: 'MergeTree',
    supported: true,
    sorting_key: ['project_id', 'time'],
    partition_key: '',
    total_rows: 5_000_000,
    table_bytes: 24_122_801,
    parts: 5,
    index_granularity: 8192,
    columns: COLUMNS,
    existing: [],
    window_days: 7,
    since: '2026-08-22 09:00:00',
    shapes_total: patterns.length,
    runs_total: patterns.reduce((n, p) => n + p.runs, 0),
    ...over,
    workload: { items: patterns },
  }
}

const index = (over: Partial<SkipIndex> = {}): SkipIndex => ({
  name: 'by_device_id',
  kind: 'bloom_filter',
  expression: 'device_id',
  granularity: 4,
  compressed: 1024,
  uncompressed: 4096,
  marks: 2,
  inert: false,
  ...over,
})

describe('what the workload argues for', () => {
  it('proposes a membership index for an equality the key cannot prune', () => {
    const { proposals: found } = proposals(
      advice([pattern({ statement: "SELECT value FROM events WHERE device_id = 'a1'" })]),
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.column).toBe('device_id')
    // A String says many values, so a bloom filter — and the set is named,
    // because measuring it takes the same few seconds.
    expect(found[0]?.kind).toBe('bloom_filter')
    expect(found[0]?.alternative).toBe('set')
  })

  it('proposes a set where the type says there are few values', () => {
    const { proposals: found } = proposals(
      advice([pattern({ statement: "SELECT value FROM events WHERE type = 'error'" })]),
    )
    expect(found[0]?.kind).toBe('set')
    expect(found[0]?.alternative).toBe('bloom_filter')
  })

  it('proposes minmax for a range, and names no alternative', () => {
    // Nothing competes with minmax on a `>`: a membership test cannot answer
    // one at all.
    const { proposals: found } = proposals(
      advice([pattern({ statement: 'SELECT value FROM events WHERE value > 100' })]),
    )
    expect(found[0]?.kind).toBe('minmax')
    expect(found[0]?.alternative).toBeNull()
  })

  it('proposes nothing for a filter the sorting key already serves', () => {
    const { proposals: found, nothing } = proposals(
      advice([pattern({ statement: 'SELECT value FROM events WHERE project_id = 7' })]),
    )
    expect(found).toHaveLength(0)
    expect(nothing.servedByKey).toBe(1)
  })

  it('does propose for a key column the server cannot prune on', () => {
    // `time` is second in the key, and without an equality on `project_id`
    // the server prunes nothing with it — which is exactly the case an index
    // is best at, because the column is already correlated with the order.
    const { proposals: found } = proposals(
      advice([pattern({ statement: "SELECT value FROM events WHERE time > '2026-01-01'" })]),
    )
    expect(found[0]?.column).toBe('time')
    expect(found[0]?.keyPosition).toBe(2)
  })

  it('leaves a key column alone when the prefix before it is pinned', () => {
    const { proposals: found } = proposals(
      advice([
        pattern({ statement: "SELECT value FROM events WHERE project_id = 7 AND time > '2026-01-01'" }),
      ]),
    )
    expect(found).toHaveLength(0)
  })

  it('does not propose from a filter that went through a function', () => {
    // `toStartOfHour(time)` and `time` prune differently — measured in
    // `projection.ts` — so an index on the bare column would not serve it.
    const { proposals: found } = proposals(
      advice([
        pattern({ statement: "SELECT value FROM events WHERE toStartOfHour(time) = '2026-01-01 00:00:00'" }),
      ]),
    )
    expect(found).toHaveLength(0)
  })

  it('names a column that already carries an index instead of proposing it again', () => {
    const { proposals: found, nothing } = proposals(
      advice([pattern({ statement: "SELECT value FROM events WHERE device_id = 'a1'" })]),
      [index()],
    )
    expect(found).toHaveLength(0)
    expect(nothing.alreadyIndexed).toEqual(['device_id'])
  })

  it('does not treat an index on an expression as an index on the column', () => {
    const { proposals: found } = proposals(
      advice([pattern({ statement: "SELECT value FROM events WHERE device_id = 'a1'" })]),
      [index({ expression: 'lower(device_id)' })],
    )
    expect(found).toHaveLength(1)
  })

  it('ranks by the time the window actually spent, never by a predicted saving', () => {
    const { proposals: found } = proposals(
      advice([
        pattern({ statement: "SELECT value FROM events WHERE device_id = 'a1'", total_ms: 100 }),
        pattern({ statement: "SELECT value FROM events WHERE type = 'error'", total_ms: 9_000 }),
      ]),
    )
    expect(found.map((p) => p.column)).toEqual(['type', 'device_id'])
    expect(found[0]?.spentMs).toBe(9_000)
  })

  it('sums the shapes behind one column rather than proposing it twice', () => {
    const { proposals: found } = proposals(
      advice([
        pattern({ statement: "SELECT value FROM events WHERE device_id = 'a1'", runs: 3, total_ms: 100 }),
        pattern({ statement: "SELECT time FROM events WHERE device_id = 'b2'", runs: 4, total_ms: 200 }),
      ]),
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.runs).toBe(7)
    expect(found[0]?.spentMs).toBe(300)
    expect(found[0]?.patterns).toHaveLength(2)
  })

  it('prefers minmax where one shape ranges over a column another compares', () => {
    // A membership test cannot answer the range, and minmax answers both.
    const { proposals: found } = proposals(
      advice([
        pattern({ statement: 'SELECT time FROM events WHERE value = 3' }),
        pattern({ statement: 'SELECT time FROM events WHERE value > 100' }),
      ]),
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe('minmax')
  })

  it('proposes nothing at all on a table too small to skip anything in', () => {
    const { proposals: found, nothing } = proposals(
      advice([pattern({ statement: "SELECT value FROM events WHERE device_id = 'a1'" })], {
        total_rows: 900,
      }),
    )
    expect(found).toHaveLength(0)
    expect(nothing.belowFloor).toBe(true)
  })

  it('counts the shapes it could not read', () => {
    const { nothing } = proposals(
      advice([pattern({ statement: 'SELECT * FROM events JOIN other USING (id)' })]),
    )
    expect(nothing.unread).toBe(1)
  })
})

describe('what it says', () => {
  const one = () =>
    proposals(advice([pattern({ statement: "SELECT value FROM events WHERE device_id = 'a1'" })]))
      .proposals[0]!

  it('states the claim with where the column sits', () => {
    expect(claim(one())).toContain('is not in the sorting key')
    expect(claim(one())).toContain('compared for equality')
  })

  it('says why this kind, and that the other is a measurement away', () => {
    expect(saysKind(one())).toContain('bloom filter')
    expect(saysKind(one())).toContain('the numbers decide')
  })

  it('says nothing about a range having an alternative, because it has none', () => {
    const range = proposals(
      advice([pattern({ statement: 'SELECT value FROM events WHERE value > 100' })]),
    ).proposals[0]!
    expect(saysKind(range)).not.toContain('the numbers decide')
  })

  it('explains an empty list rather than leaving it empty', () => {
    const { nothing } = proposals(
      advice([pattern({ statement: 'SELECT value FROM events WHERE project_id = 7' })]),
    )
    expect(saysNothing(nothing, advice([]))).toContain('already served by the sorting key')
  })

  it('says nothing when there is nothing to explain', () => {
    const { nothing } = proposals(advice([]))
    expect(saysNothing(nothing, advice([]))).toBeNull()
  })
})

describe('a value to measure against', () => {
  it('carries the literal the workload actually compared to', () => {
    const { proposals: found } = proposals(
      advice([pattern({ statement: "SELECT value FROM events WHERE device_id = 'a1'" })]),
    )
    expect(found[0]?.sample).toBe('a1')
  })

  it('carries a number as written', () => {
    const { proposals: found } = proposals(
      advice([pattern({ statement: 'SELECT time FROM events WHERE value > 100' })]),
    )
    expect(found[0]?.sample).toBe('100')
  })

  it('has none where every shape compared to something that is not a literal', () => {
    // `IN ('a','b')` is a list and `now() - INTERVAL 7 DAY` an expression;
    // measuring against a made-up value would be a plan about nothing.
    const { proposals: found } = proposals(
      advice([pattern({ statement: "SELECT value FROM events WHERE device_id IN ('a1','b2')" })]),
    )
    expect(found[0]?.sample).toBeNull()
  })

  it('takes the first real value across the shapes behind one column', () => {
    const { proposals: found } = proposals(
      advice([
        pattern({ statement: "SELECT value FROM events WHERE device_id IN ('a1','b2')" }),
        pattern({ statement: "SELECT time FROM events WHERE device_id = 'c3'" }),
      ]),
    )
    expect(found[0]?.sample).toBe('c3')
  })
})

describe('a sorting key written through assumeNotNull', () => {
  /* What ClickHouse writes into the key for a Nullable column, which is most
     tables anybody generates. Measured on a real 42.9 M-row table: a filter on
     the bare column reads 17 of 5,241 granules, so the key serves it and
     nothing should be proposed for it. */
  const wrapped = (patterns: Pattern[]) =>
    advice(patterns, { sorting_key: ['assumeNotNull(project_id)', 'assumeNotNull(time)'] })

  it('proposes nothing for a filter the wrapped key already serves', () => {
    const { proposals: found } = proposals(
      wrapped([pattern({ statement: 'SELECT value FROM events WHERE project_id = 7' })]),
    )
    expect(found).toHaveLength(0)
  })

  it('still proposes for a column that is genuinely outside it', () => {
    const { proposals: found } = proposals(
      wrapped([pattern({ statement: "SELECT value FROM events WHERE device_id = 'a1'" })]),
    )
    expect(found.map((p) => p.column)).toEqual(['device_id'])
  })

  it('reads the prefix rule through the wrapper too', () => {
    const pinned = proposals(
      wrapped([
        pattern({ statement: "SELECT value FROM events WHERE project_id = 7 AND time > '2026-01-01'" }),
      ]),
    )
    expect(pinned.proposals).toHaveLength(0)
    const loose = proposals(
      wrapped([pattern({ statement: "SELECT value FROM events WHERE time > '2026-01-01'" })]),
    )
    expect(loose.proposals.map((p) => p.column)).toEqual(['time'])
  })
})

describe('the comparison the workload wrote', () => {
  it('carries `<` as `lt` rather than flattening it to a range', () => {
    // Measured on a column ranging −134 to 127: `< -200` prunes every granule
    // and `> -200` prunes none. Planning the wrong one answers the opposite
    // question.
    const { proposals: found } = proposals(
      advice([pattern({ statement: 'SELECT time FROM events WHERE value < 100' })]),
    )
    expect(found[0]?.op).toBe('lt')
  })

  it('carries `>=` as `gte`', () => {
    const { proposals: found } = proposals(
      advice([pattern({ statement: 'SELECT time FROM events WHERE value >= 100' })]),
    )
    expect(found[0]?.op).toBe('gte')
  })

  it('reads an IN as an equality against one of the list', () => {
    const { proposals: found } = proposals(
      advice([pattern({ statement: "SELECT value FROM events WHERE device_id IN ('a1','b2')" })]),
    )
    expect(found[0]?.op).toBe('in')
  })

  it('takes the range when one shape ranges and another compares', () => {
    const { proposals: found } = proposals(
      advice([
        pattern({ statement: 'SELECT time FROM events WHERE value = 3' }),
        pattern({ statement: 'SELECT time FROM events WHERE value < 100' }),
      ]),
    )
    expect(found[0]?.kind).toBe('minmax')
    expect(found[0]?.op).toBe('lt')
    expect(found[0]?.sample).toBe('100')
  })
})

describe('whether a proposal can be measured in a press', () => {
  const only = (statement: string) => proposals(advice([pattern({ statement })])).proposals[0]!

  it('can, where there is one comparison and one value', () => {
    expect(measurable(only("SELECT value FROM events WHERE device_id = 'a1'"))).toBe(true)
  })

  it('cannot measure an IN, and says a list is a different question', () => {
    const p = only("SELECT value FROM events WHERE device_id IN ('a1','b2')")
    expect(measurable(p)).toBe(false)
    expect(saysUnmeasurable(p)).toContain('a list')
  })

  it('cannot measure a BETWEEN, and says it is two comparisons', () => {
    const p = only('SELECT value FROM events WHERE value BETWEEN 1 AND 9')
    expect(measurable(p)).toBe(false)
    expect(saysUnmeasurable(p)).toContain('two comparisons')
  })

  it('cannot measure a comparison against an expression', () => {
    const p = only("SELECT value FROM events WHERE time > now() - INTERVAL 7 DAY")
    expect(measurable(p)).toBe(false)
    expect(saysUnmeasurable(p)).toContain('needs one')
  })
})
