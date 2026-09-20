import { describe, expect, it } from 'vitest'

import { granulesRead, handOver, pruned, verdicts, type Outcome } from './whatif'
import { readPlan } from './plan'

/** The shape ClickHouse actually prints, taken from a real run rather than
 *  invented: 26.7, a set index over one partition of 3.2M rows. */
const BEFORE = `Output: count()
Aggregating
│  Keys:
│  Aggregates: count()
└──Filter ((WHERE + Change column names to column identifiers))
   │  Filter column: source_id = 's-1042'
   └──ReadFromMergeTree (flint.whatif_x)
         Read type: Default
         Parts: 4 | Granules: 396
         Indexes:
           PrimaryKey
             Condition: true
             Parts: 4/4
             Granules: 396/396
           Ranges: 4`

const AFTER = `Output: count()
Aggregating
│  Keys:
│  Aggregates: count()
└──Filter ((WHERE + Change column names to column identifiers))
   │  Filter column: source_id = 's-1042'
   └──ReadFromMergeTree (flint.whatif_x)
         Read type: Default
         Parts: 1 | Granules: 4
         Indexes:
           PrimaryKey
             Condition: true
             Parts: 4/4
             Granules: 396/396
           Skip
             Name: by_source_id
             Description: set GRANULARITY 4
             Condition: (source_id in ['s-1042', 's-1042'])
             Parts: 1/4
             Granules: 4/396
           Ranges: 1`

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  partition: '202608',
  sampled_rows: 3_242_371,
  sampled_parts: 4,
  table_rows: 42_878_173,
  table_parts: 18,
  clipped: false,
  before_plan: BEFORE,
  after_plan: AFTER,
  index_bytes: 1550,
  statement: 'ALTER TABLE default.events\n  ADD INDEX …',
  name: 'by_source_id',
  expression: 'source_id',
  kind: 'set(100)',
  granularity: 4,
  refused: null,
  ...over,
})

describe('reading the two plans', () => {
  it('finds what the hypothetical index pruned', () => {
    expect(pruned(readPlan(AFTER))).toEqual({ used: 4, total: 396 })
  })

  it('finds nothing to report in the plan taken before it existed', () => {
    expect(pruned(readPlan(BEFORE))).toBeNull()
  })

  it('reads what the filter cost without it', () => {
    expect(granulesRead(readPlan(BEFORE))).toBe(396)
  })
})

describe('what the measurement supports saying', () => {
  it('leads with the server refusing to build it, and says nothing else', () => {
    const said = verdicts(outcome({ refused: 'Data type UUID of argument for minmax index' }))
    expect(said).toHaveLength(1)
    expect(said[0]?.tone).toBe('cost')
    expect(said[0]?.evidence).toContain('UUID')
  })

  it('reports the share skipped, and what it read without the index', () => {
    const [first] = verdicts(outcome())
    expect(first?.tone).toBe('good')
    // 4 of 396 is 1.01% kept, so 99% skipped — not `>99%`, which the
    // percentage rule reserves for a share that would round *to* 100.
    expect(first?.text).toContain('99%')
    expect(first?.text).toContain('396')
    expect(first?.evidence).toContain('1.5 KiB')
  })

  it('names the granule floor where the read is already at it', () => {
    // Four granules over four parts is one apiece, which is the least any
    // read of those parts could have touched.
    const said = verdicts(outcome())
    expect(said.some((v) => v.text.includes('floor for this copy'))).toBe(true)
  })

  it('is as loud about an index that skipped nothing', () => {
    const useless = AFTER.replace('Granules: 4/396', 'Granules: 396/396').replace(
      'Parts: 1/4',
      'Parts: 4/4',
    )
    const said = verdicts(outcome({ after_plan: useless }))
    expect(said[0]?.tone).toBe('cost')
    expect(said[0]?.text).toContain('skipped nothing')
    // And says what it would cost forever, which is the point of knowing.
    expect(said[0]?.evidence).toContain('every insert')
  })

  it('says so when the index was built and the plan ignored it', () => {
    const ignored = AFTER.replace(/           Skip[\s\S]*?Granules: 4\/396\n/, '')
    const said = verdicts(outcome({ after_plan: ignored }))
    expect(said[0]?.tone).toBe('cost')
    expect(said[0]?.text).toContain('did not use it')
  })

  it('always states what it measured on, and against what whole', () => {
    const said = verdicts(outcome())
    const scope = said.find((v) => v.text.includes('partition 202608'))
    // In the product's own figures, which round past a million: a checkup
    // that said 42,878,173 rows would be the only page in Flint that did.
    expect(scope?.text).toContain('42.9 M')
    expect(scope?.text).toContain('3.2 M')
  })

  it('says a clipped sample was only part of the partition', () => {
    const said = verdicts(outcome({ clipped: true }))
    expect(said.some((v) => v.text.includes('part of partition'))).toBe(true)
  })
})

describe('handing the alteration over', () => {
  it('fills in the form Infrastructure already has', () => {
    const to = handOver('default', 'events', outcome())
    expect(to).toContain('/infra/schema?')
    expect(to).toContain('op=add-index')
    expect(to).toContain('alter=default.events')
    expect(to).toContain('kind=set%28100%29')
    expect(to).toContain('granularity=4')
  })
})
