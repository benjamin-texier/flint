import { describe, expect, it } from 'vitest'

import { readPlan, verdicts } from './plan'

/** Verbatim from ClickHouse 26.7, `EXPLAIN PLAN indexes = 1` over
 *  `system.query_log` with a filter on the sorting key. Kept as it arrived,
 *  escaped quotes and box drawing included: the parser's whole job is to cope
 *  with this exact text. */
const PRUNED = String.raw`Output: sum(query_duration_ms)

Aggregating
│  Keys:
│  Aggregates: sum(query_duration_ms)
│  Skip merging: 0
└──ReadFromMergeTree (system.query_log)
      Read type: Default
      Parts: 3 | Granules: 5
      Output: query_duration_ms
      Prewhere filter
      Prewhere filter column:  event_time >= \'2026-08-26 08:12:30\' AND type = \'QueryFinish\'
      Indexes:
        Min-Max
          Condition: true
          Parts: 4/4
          Granules: 11/11
        Partition
          Condition: true
          Parts: 4/4
          Granules: 11/11
        PrimaryKey
          Keys:
            event_time
          Condition: (event_time in [1787731950, +Inf))
          Parts: 3/4
          Granules: 5/11
          Search Algorithm: generic exclusion search
        Skip
          Name: event_time_index
          Description: minmax GRANULARITY 1
          Condition: (event_time in [1787731950, +Inf))
          Parts: 3/3
          Granules: 5/5
        Ranges: 3
`

/** The same server, filtering on a column that is not in the key. */
const NOT_PRUNED = String.raw`└──ReadFromMergeTree (system.query_log)
      Read type: Default
      Parts: 5 | Granules: 12
      Output: query_duration_ms
      Prewhere filter
      Prewhere filter column:  user = \'jeeves\'
      Indexes:
        Min-Max
          Condition: true
          Parts: 5/5
          Granules: 12/12
        PrimaryKey
          Keys:
            event_date
            event_time
          Condition: true
          Parts: 5/5
          Granules: 12/12
`

const JOINED = String.raw`Aggregating
│  Aggregates: count()
└──Join (JOIN FillRightFirst)
   │  a ⋈ b
   │  Type: inner | Strictness: all | Algorithm: SpillingHashJoin(ConcurrentHashJoin)
   │  Join conditions: CAST(type AS String) = name
   ├──ReadFromMergeTree (system.query_log)
   │     Read type: Default
   │     Parts: 4 | Granules: 11
   │     Prewhere filter column:  event_date >= \'2026-08-26\'
   │     Indexes:
   │       PrimaryKey
   │         Keys:
   │           event_date
   │         Condition: (event_date in [20330, +Inf))
   │         Parts: 4/4
   │         Granules: 11/11
   └──ReadFromMemoryStorage (system.tables)
`

describe('readPlan', () => {
  it('reads the node, its counts and its prewhere through the box drawing', () => {
    const plan = readPlan(PRUNED)
    expect(plan.reads).toHaveLength(1)
    const read = plan.reads[0]!
    expect(read.table).toBe('system.query_log')
    expect(read.readType).toBe('Default')
    expect(read.parts).toBe(3)
    expect(read.granules).toBe(5)
    // Unescaped, because `\'` printed as-is reads as a bug in Flint.
    expect(read.prewhere).toBe("event_time >= '2026-08-26 08:12:30' AND type = 'QueryFinish'")
  })

  it('attributes each field to the index it belongs to, not to the read above', () => {
    const read = readPlan(PRUNED).reads[0]!
    expect(read.indexes.map((i) => i.kind)).toEqual([
      'MinMax',
      'Partition',
      'PrimaryKey',
      'Skip',
    ])
    const primary = read.indexes.find((i) => i.kind === 'PrimaryKey')!
    expect(primary.keys).toEqual(['event_time'])
    expect(primary.parts).toEqual({ used: 3, total: 4 })
    expect(primary.granules).toEqual({ used: 5, total: 11 })
    const skip = read.indexes.find((i) => i.kind === 'Skip')!
    expect(skip.name).toBe('event_time_index')
    expect(skip.description).toBe('minmax GRANULARITY 1')
  })

  it('reads a multi-column key as a list', () => {
    const primary = readPlan(NOT_PRUNED).reads[0]!.indexes.find((i) => i.kind === 'PrimaryKey')!
    expect(primary.keys).toEqual(['event_date', 'event_time'])
  })

  it('reads a join, both of its reads, and the condition', () => {
    const plan = readPlan(JOINED)
    expect(plan.reads.map((r) => r.table)).toEqual(['system.query_log', 'system.tables'])
    expect(plan.joins).toHaveLength(1)
    const join = plan.joins[0]!
    expect(join.order).toBe('FillRightFirst')
    expect(join.kind).toBe('inner')
    expect(join.algorithm).toBe('SpillingHashJoin(ConcurrentHashJoin)')
    expect(join.condition).toBe('CAST(type AS String) = name')
  })

  it('makes nothing up out of a plan it cannot read', () => {
    expect(readPlan('')).toEqual({ reads: [], joins: [] })
    expect(readPlan('SELECT 1\nFROM t')).toEqual({ reads: [], joins: [] })
    expect(verdicts(readPlan('nonsense'))).toEqual([])
  })
})

describe('verdicts', () => {
  it('says what the primary key did, with the figures', () => {
    const said = verdicts(readPlan(PRUNED))
    const pruning = said.find((v) => v.text.includes('primary key'))!
    expect(pruning.tone).toBe('good')
    expect(pruning.text).toContain('on event_time')
    expect(pruning.text).toContain('5 of 11 granules')
    expect(pruning.evidence).toBe('3 of 4 parts, 5 of 11 granules')
  })

  it('says when the query never constrained the key, and names it', () => {
    const said = verdicts(readPlan(NOT_PRUNED))
    const none = said.find((v) => v.text.includes('Nothing was pruned'))!
    expect(none.tone).toBe('cost')
    expect(none.text).toContain('every one of the 12 granules')
    expect(none.text).toContain('Nothing in the query constrained the key')
    expect(none.text).toContain('event_date, event_time')
  })

  it('distinguishes a key that excluded nothing from a key nothing mentioned', () => {
    // Measured on a real log: the filter *was* on the key and pruned nothing,
    // because every row in the table was inside the window asked for. Calling
    // that a mistake would send somebody to fix a filter that is already right.
    // Anchored on the key list, because `Condition: true` also appears in the
    // Min-Max block above and a bare replace would edit the wrong index.
    const matched = NOT_PRUNED.replace(
      'event_time\n          Condition: true',
      'event_time\n          Condition: (event_date in [20684, +Inf))',
    )
    const said = verdicts(readPlan(matched))
    const verdict = said.find((v) => v.text.includes('excluded nothing'))!
    expect(verdict.tone).toBe('note')
    expect(verdict.text).toContain('all 12 granules matched')
    expect(verdict.evidence).toContain('event_date in [20684')
    expect(said.some((v) => v.text.includes('Nothing was pruned'))).toBe(false)
  })

  it('credits the PREWHERE the server chose by itself', () => {
    const said = verdicts(readPlan(PRUNED))
    const prewhere = said.find((v) => v.text.includes('PREWHERE'))!
    expect(prewhere.tone).toBe('good')
    expect(prewhere.evidence).toContain("type = 'QueryFinish'")
  })

  it('reports a skip index that earned nothing without advising about it', () => {
    const said = verdicts(readPlan(PRUNED))
    const skip = said.find((v) => v.text.includes('skip index'))!
    // 5/5: it saw five granules and kept five.
    expect(skip.text).toContain('pruned nothing here')
    expect(skip.tone).toBe('note')
    // No recommendation: one query is not the whole workload.
    expect(skip.text).not.toMatch(/drop|remove|should/i)
  })

  it('names the side a join builds, and the cast it does per row', () => {
    const said = verdicts(readPlan(JOINED))
    expect(said.find((v) => v.text.includes('builds from the right side'))).toBeTruthy()
    const cast = said.find((v) => v.text.includes('casts on every row'))!
    expect(cast.tone).toBe('cost')
    expect(cast.evidence).toBe('CAST(type AS String) = name')
  })

  it('says which table a verdict is about once there is more than one', () => {
    const said = verdicts(readPlan(JOINED))
    expect(said.some((v) => v.text.includes('system.query_log'))).toBe(true)
    // And says nothing of the sort when there is only one read to talk about.
    expect(verdicts(readPlan(PRUNED)).every((v) => !v.text.includes('on system.query_log'))).toBe(
      true,
    )
  })

  it('credits an order the sorting key served', () => {
    const inOrder = PRUNED.replace('Read type: Default', 'Read type: InOrder')
    const said = verdicts(readPlan(inOrder))
    expect(said.find((v) => v.text.includes('costs no sort'))!.tone).toBe('good')
  })
})
