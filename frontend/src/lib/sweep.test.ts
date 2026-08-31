import { describe, expect, it } from 'vitest'

import type { ColumnFacts, SchemaReview } from './api'
import {
  disagreements,
  families,
  group,
  heldBack,
  writtenBy,
  handOver,
  likeToRegExp,
  reconcile,
  matching,
  rankGroups,
  reach,
  script,
  statements,
  type Member,
} from './sweep'

function column(over: Partial<ColumnFacts> & { name: string; type: string }): ColumnFacts {
  return {
    nullable: over.type.includes('Nullable'),
    codec: '',
    in_sorting_key: false,
    in_partition_key: false,
    compressed_bytes: null,
    uncompressed_bytes: null,
    distinct: over.distinct ?? 5,
    distinct_capped: false,
    distinct_small: Math.min((over.distinct ?? 5) as number, 101),
    nulls: 0,
    empties: 0,
    min: null,
    max: null,
    min_len: null,
    max_len: null,
    not_a_date: null,
    not_a_number: null,
    not_a_uuid: null,
    fractional: null,
    read_by: null,
    ...over,
  }
}

function review(table: string, columns: ColumnFacts[], over: Partial<SchemaReview> = {}) {
  return {
    database: 'default',
    table,
    engine: 'MergeTree',
    sorting_key: 'ts',
    partition_key: 'toYYYYMM(ts)',
    total_rows: 10_000,
    scanned: 10_000,
    verified: true,
    part_type: 'Wide',
    sizes_known: true,
    degraded: false,
    usage_days: 7,
    usage_known: true,
    usage_since: null,
    usage_hours: null,
    writes: 0,
    columns,
    ...over,
  } satisfies SchemaReview
}

/** An Int64 counting seconds that never pass a day: the case the whole page was
 *  built for, and the one that repeats across three sibling tables. */
const seconds = (name: string, bytes: number | null = 1_000_000) =>
  column({
    name,
    type: 'Int64',
    min: '0',
    max: '900',
    compressed_bytes: bytes,
    uncompressed_bytes: bytes ? bytes * 4 : null,
  })

const percentage = (name: string, bytes: number | null = 100_000) =>
  column({
    name,
    type: 'Int64',
    min: '0',
    max: '100',
    compressed_bytes: bytes,
    uncompressed_bytes: bytes ? bytes * 4 : null,
  })

/** The three sibling tables of the occupancy family, each with the same six
 *  columns and the same two problems. */
const occupancy = (table: string, over?: Partial<SchemaReview>) =>
  review(
    table,
    [
      seconds('total_occupied_seconds'),
      seconds('total_available_seconds'),
      percentage('occupancy_percentage'),
    ],
    over,
  )

describe('a LIKE pattern is the selection', () => {
  it('reads % as any run of characters', () => {
    expect(matching(['raw_a', 'raw_b', 'cooked_c'], 'raw_%')).toEqual(['raw_a', 'raw_b'])
  })

  it('reads a suffix pattern the same way', () => {
    expect(matching(['a_estimated', 'b_estimated', 'c'], '%_estimated')).toEqual([
      'a_estimated',
      'b_estimated',
    ])
  })

  // The gotcha worth a test rather than a comment: in LIKE, `_` is a wildcard,
  // so a pattern written to mean "the raw_ prefix" also catches names that have
  // no underscore at all. The page lists what it caught for exactly this reason.
  it('reads _ as a single character, wildcard and not a literal', () => {
    // `rawevents` matches too: the `_` takes its `e` and the `%` takes the
    // rest. Three names caught by a pattern meant for one of them.
    expect(matching(['raw_events', 'rawXevents', 'rawevents', 'raw'], 'raw_%')).toEqual([
      'raw_events',
      'rawXevents',
      'rawevents',
    ])
  })

  it('takes a backslash as the escape for a literal underscore', () => {
    expect(matching(['raw_events', 'rawXevents'], 'raw\\_%')).toEqual(['raw_events'])
  })

  it('does not let a name containing regex punctuation become a pattern', () => {
    expect(likeToRegExp('a.b').test('axb')).toBe(false)
    expect(likeToRegExp('a.b').test('a.b')).toBe(true)
  })

  it('is case sensitive, like LIKE and unlike ILIKE', () => {
    expect(matching(['Raw_events', 'raw_events'], 'raw%')).toEqual(['raw_events'])
  })

  it('treats an empty box as no filter rather than as a filter matching nothing', () => {
    expect(matching(['a', 'b'], '   ')).toEqual(['a', 'b'])
  })
})

describe('one column, one proposal, every table that has it', () => {
  it('collapses the same finding across sibling tables into one group', () => {
    const groups = group([
      occupancy('raw_parking_spot_occupancy'),
      occupancy('raw_parking_spot_occupancy_estimated'),
      occupancy('raw_parking_spot_occupancy_last_state'),
    ])

    // Three tables times three columns is nine ALTERs by hand; three decisions
    // here.
    expect(groups).toHaveLength(3)
    for (const g of groups) expect(g.members).toHaveLength(3)
    expect(groups.map((g) => g.proposal).filter((p) => p === 'UInt16')).toHaveLength(2)
  })

  it('sums bytes only over the members that have them, and counts the rest apart', () => {
    const groups = group([
      review('a', [seconds('count', 900)]),
      review('b', [seconds('count', 100)]),
      // Compact parts: this table's column has no measurable size, and must not
      // arrive in the total as a zero.
      review('c', [seconds('count', null)], { part_type: 'Compact', sizes_known: false }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]!.bytes).toBe(1_000)
    expect(groups[0]!.unknown).toBe(1)
    expect(groups[0]!.members).toHaveLength(3)
  })

  it('counts the members whose key would make the server refuse', () => {
    const groups = group([
      review('a', [seconds('ts_bucket')]),
      review('b', [{ ...seconds('ts_bucket'), in_sorting_key: true }]),
    ])

    expect(groups[0]!.members).toHaveLength(2)
    expect(groups[0]!.inKey).toBe(1)
  })

  it('is a verdict only when every member was measured over every row', () => {
    const groups = group([
      review('a', [seconds('count')]),
      review('b', [seconds('count')], { verified: false, scanned: 200_000 }),
    ])

    expect(groups[0]!.members).toHaveLength(2)
    expect(groups[0]!.verified).toBe(1)
  })

  it('keeps two different proposals for one column as two decisions', () => {
    const groups = group([
      review('a', [seconds('count')]),
      review('b', [percentage('count')]),
    ])

    expect(groups.map((g) => g.proposal).sort()).toEqual(['UInt16', 'UInt8'])
  })

  it('leaves DROP COLUMN out: nobody should tick eleven of those at once', () => {
    const groups = group([
      review('a', [column({ name: 'tenant', type: 'String', distinct: 1 })]),
      review('b', [column({ name: 'tenant', type: 'String', distinct: 1 })]),
    ])

    expect(groups).toEqual([])
  })

  it('names every type the members start from, not just the first one', () => {
    const groups = group([
      review('a', [seconds('count')]),
      review('b', [{ ...seconds('count'), type: 'Int32' }]),
    ])

    // The bug this replaced: the card read `Int64 → UInt16` above a row whose
    // column is an Int32, because the headline came from whichever member
    // happened to be seen first.
    // Commonest first, and the name breaks a tie, so two runs of the same
    // review word the card the same way.
    expect(groups[0]!.headline).toBe('Int32, Int64 → UInt16')
    expect(groups[0]!.declared).toEqual([
      { type: 'Int32', tables: 1 },
      { type: 'Int64', tables: 1 },
    ])
  })

  it('attributes the reasoning to the type it is actually about', () => {
    const groups = group([
      review('a', [seconds('count')]),
      review('b', [seconds('count')]),
      review('c', [{ ...seconds('count'), type: 'Int32' }]),
    ])

    // Two Int64s against one Int32: the sentence follows the majority and says
    // so, rather than sitting over the Int32 row claiming eight bytes.
    expect(groups[0]!.whyFor).toBe('Int64')
    expect(groups[0]!.why).toContain('Int64 reserves 8 bytes')
  })

  it('carries the type each table declares today, beside the one proposed', () => {
    const groups = group([review('a', [seconds('count')])])
    expect(groups[0]!.members[0]!.from).toBe('Int64')
  })

  it('ranks by the disk at stake, then by how many tables the decision covers', () => {
    const ranked = rankGroups([
      { column: 'small', proposal: 'UInt8', bytes: 10, members: [1, 2, 3] },
      { column: 'big', proposal: 'UInt8', bytes: 900, members: [1] },
      { column: 'none', proposal: 'UInt8', bytes: 0, members: [1, 2] },
    ] as never)

    expect(ranked.map((g) => g.column)).toEqual(['big', 'small', 'none'])
  })
})

describe('a table something else writes into is half a decision', () => {
  const graph = {
    database: 'default',
    nodes: [],
    edges: [
      { from: 'default.raw_x', to: 'default.hourly_mv', kind: 'reads' as const },
      { from: 'default.hourly_mv', to: 'default.hourly', kind: 'writes' as const },
    ],
  }

  it('reads the writers off the lineage Flint already draws', () => {
    expect([...writtenBy(graph, 'default')]).toEqual([['hourly', ['hourly_mv']]])
  })

  it('has no opinion when there is no graph to read', () => {
    expect(writtenBy(undefined, 'default').size).toBe(0)
  })

  // The failure this exists to prevent: the ALTER succeeds, the view keeps
  // running its old SELECT, and a narrowing cast truncates on every insert
  // from then on without complaining once.
  it('holds a view target back the same way a key column is held back', () => {
    const groups = group(
      [review('hourly', [seconds('count')]), review('plain', [seconds('count')])],
      writtenBy(graph, 'default'),
    )

    const fed = groups[0]!.members.find((m) => m.table === 'hourly')!
    const free = groups[0]!.members.find((m) => m.table === 'plain')!
    expect(fed.fedBy).toEqual(['hourly_mv'])
    expect(heldBack(fed)).toBe(true)
    expect(free.fedBy).toEqual([])
    expect(heldBack(free)).toBe(false)
    expect(groups[0]!.fed).toBe(1)
  })

  it('holds nothing back when no graph was given', () => {
    const groups = group([review('hourly', [seconds('count')])])
    expect(heldBack(groups[0]!.members[0]!)).toBe(false)
  })
})

describe('tables that are variants of one another', () => {
  const shaped = (table: string, names: string[]) =>
    review(
      table,
      names.map((n) => column({ name: n, type: 'String' })),
    )

  it('keeps siblings together across the column that makes one a last-state table', () => {
    const kin = families([
      shaped('raw_x', ['a', 'b', 'c', 'd', 'e']),
      shaped('raw_x_last_state', ['a', 'b', 'c', 'd', 'e', 'updated_at']),
    ])

    expect(kin).toHaveLength(1)
    expect(kin[0]!.shared).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('follows a chain: each differs a little from the next and all belong together', () => {
    const kin = families([
      shaped('raw_x', ['a', 'b', 'c', 'd', 'e']),
      shaped('raw_x_estimated', ['a', 'b', 'c', 'd', 'e', 'estimated_at']),
      shaped('raw_x_last_state', ['a', 'b', 'c', 'd', 'e', 'estimated_at', 'updated_at']),
    ])

    expect(kin).toHaveLength(1)
    expect(kin[0]!.tables).toHaveLength(3)
  })

  it('does not make a family of two tables that merely share an id and a ts', () => {
    const kin = families([
      shaped('events', ['id', 'ts', 'a', 'b', 'c']),
      shaped('invoices', ['id', 'ts', 'x', 'y', 'z']),
    ])

    expect(kin).toHaveLength(2)
  })
})

describe('what these tables do not agree about', () => {
  const of = (reviews: SchemaReview[]) => disagreements(reviews, group(reviews))

  it('says nothing when every table declares and proposes the same', () => {
    expect(of([review('a', [seconds('count')]), review('b', [seconds('count')])])).toEqual([])
  })

  it('reports a column heading for two different types', () => {
    const found = of([review('a', [seconds('count')]), review('b', [percentage('count')])])

    expect(found).toHaveLength(1)
    expect(found[0]!.column).toBe('count')
    expect(found[0]!.proposals.map((p) => p.type).sort()).toEqual(['UInt16', 'UInt8'])
  })

  // The case the grouping alone could never produce: both tables are correct on
  // their own, so no rule fires, and every join between them still casts.
  it('reports a column typed two ways even when neither is worth changing', () => {
    const found = of([
      review('a', [column({ name: 'user_id', type: 'String', distinct: 50_000 })]),
      review('b', [column({ name: 'user_id', type: 'UInt64', distinct: 50_000 })]),
    ])

    expect(found).toHaveLength(1)
    expect(found[0]!.proposals).toEqual([])
    expect(found[0]!.declared).toEqual([
      { type: 'String', tables: ['a'] },
      { type: 'UInt64', tables: ['b'] },
    ])
  })

  it('names which table holds which type, since that is the actionable half', () => {
    const found = of([
      review('a', [seconds('count')]),
      review('b', [{ ...seconds('count'), type: 'Int32' }]),
    ])

    expect(found[0]!.declared.map((d) => `${d.type}:${d.tables.join()}`).sort()).toEqual([
      'Int32:b',
      'Int64:a',
    ])
  })

  it('calls it drift only between tables that are variants of each other', () => {
    const drift = of([
      review('a', [seconds('count'), column({ name: 'ts2', type: 'DateTime' })]),
      review('b', [
        { ...seconds('count'), type: 'Int32' },
        column({ name: 'ts2', type: 'DateTime' }),
      ]),
    ])
    expect(drift[0]!.withinFamily).toBe(true)

    // Two tables with nothing in common but the name of one column.
    const apart = of([
      review('a', [seconds('count'), column({ name: 'p', type: 'String' })]),
      review('b', [
        { ...seconds('count'), type: 'Int32' },
        column({ name: 'q', type: 'String' }),
        column({ name: 'r', type: 'String' }),
        column({ name: 's', type: 'String' }),
      ]),
    ])
    expect(apart[0]!.withinFamily).toBe(false)
  })
})

describe('a single change leaves through Infrastructure', () => {
  it('builds the link the Alter panel at the other end reads', () => {
    const url = handOver('default', {
      table: 'raw_traffic_data',
      column: 'count',
      from: 'Int64',
      proposal: 'UInt16',
      bytes: 1,
      verified: true,
      evidence: '',
      why: '',
      caution: null,
      inKey: false,
      fedBy: [],
      usage: null,
    })

    expect(url).toBe(
      '/infra/schema?alter=default.raw_traffic_data&op=modify-column&column=count&kind=UInt16',
    )
  })

  it('escapes a type whose punctuation would otherwise end the parameter', () => {
    const url = handOver('default', {
      table: 't',
      column: 'label',
      from: 'String',
      proposal: 'LowCardinality(Nullable(String))',
      bytes: 1,
      verified: true,
      evidence: '',
      why: '',
      caution: null,
      inKey: false,
      fedBy: [],
      usage: null,
    })

    expect(url).toContain('kind=LowCardinality%28Nullable%28String%29%29')
  })
})

describe('a tick is an intention, not a frozen proposal', () => {
  const groups = (max: string) =>
    group([
      review('a', [
        column({
          name: 'total_occupied_seconds',
          type: 'Int64',
          min: '0',
          max,
          compressed_bytes: 1_000,
        }),
      ]),
    ])

  it('keeps a tick that still matches', () => {
    const out = reconcile(
      [{ table: 'a', column: 'total_occupied_seconds', proposal: 'UInt16' }],
      groups('900'),
    )

    expect(out.chosen).toHaveLength(1)
    expect(out.chosen[0]!.proposal).toBe('UInt16')
    expect(out.changed).toEqual([])
    expect(out.dropped).toEqual([])
  })

  // The case the whole thing exists for: a sample says the seconds fit in a
  // UInt16, and reading every row finds the day somebody measured 86,400. The
  // ALTER built from the stale tick would have truncated the column.
  it('follows the proposal to where a fuller measurement moved it', () => {
    const out = reconcile(
      [{ table: 'a', column: 'total_occupied_seconds', proposal: 'UInt16' }],
      groups('86400'),
    )

    expect(out.chosen[0]!.proposal).toBe('UInt32')
    expect(out.changed).toEqual([
      { table: 'a', column: 'total_occupied_seconds', was: 'UInt16', now: 'UInt32' },
    ])
  })

  it('drops a tick whose finding is gone, and names it', () => {
    const out = reconcile([{ table: 'a', column: 'gone', proposal: 'UInt8' }], groups('900'))

    expect(out.chosen).toEqual([])
    expect(out.dropped).toEqual([{ table: 'a', column: 'gone', proposal: 'UInt8' }])
  })

  it('takes the larger decision when a tick matches neither proposal', () => {
    const two = group([
      review('a', [seconds('count', 900)]),
      review('b', [percentage('count', 100)]),
    ])
    // Table `a` only appears in the UInt16 group; a stale tick naming UInt8 for
    // it has to land on the one proposal that table actually has.
    const out = reconcile([{ table: 'a', column: 'count', proposal: 'UInt8' }], two)

    expect(out.chosen[0]!.proposal).toBe('UInt16')
    expect(out.changed[0]!.was).toBe('UInt8')
  })
})

describe('the statements come out one per table', () => {
  const member = (over: Partial<Member> & { table: string; column: string }): Member => ({
    from: 'Int64',
    proposal: 'UInt16',
    bytes: 1_000,
    verified: true,
    evidence: 'range 0 … 900',
    why: '',
    caution: null,
    inKey: false,
    fedBy: [],
    usage: null,
    ...over,
  })

  it('gathers every column of one table into a single ALTER', () => {
    const { sql } = statements('default', [
      member({ table: 'raw_parking_spot_occupancy', column: 'total_occupied_seconds' }),
      member({ table: 'raw_parking_spot_occupancy', column: 'occupancy_percentage', proposal: 'UInt8' }),
      member({ table: 'raw_parking_spot_occupancy_estimated', column: 'total_occupied_seconds' }),
    ])

    expect(sql).toHaveLength(2)
    expect(sql[0]!).toBe(
      'ALTER TABLE default.raw_parking_spot_occupancy\n' +
        '    MODIFY COLUMN total_occupied_seconds UInt16,\n' +
        '    MODIFY COLUMN occupancy_percentage   UInt8',
    )
  })

  it('quotes a name that is not a bare identifier, on both ends', () => {
    const { sql } = statements('my db', [member({ table: 'my table', column: 'my col' })])
    expect(sql[0]!).toContain('ALTER TABLE `my db`.`my table`')
    expect(sql[0]!).toContain('MODIFY COLUMN `my col` UInt16')
  })

  // Two rules can land on one column — a Nullable(String) with no nulls draws
  // both "drop the Nullable" and "make it a dictionary". One ALTER cannot do
  // both, and ClickHouse rejects a statement that names a column twice.
  it('refuses to modify one column twice and says which tick it dropped', () => {
    const { sql, conflicts } = statements('default', [
      member({ table: 't', column: 'label', proposal: 'String' }),
      member({ table: 't', column: 'label', proposal: 'LowCardinality(String)' }),
    ])

    expect(sql).toHaveLength(1)
    expect(sql[0]!).toContain('MODIFY COLUMN label String')
    expect(sql[0]!).not.toContain('LowCardinality')
    expect(conflicts).toEqual([
      { table: 't', column: 'label', kept: 'String', dropped: 'LowCardinality(String)' },
    ])
  })

  it('counts the same tick once when it arrives twice', () => {
    const { sql, conflicts } = statements('default', [
      member({ table: 't', column: 'n' }),
      member({ table: 't', column: 'n' }),
    ])

    expect(sql[0]!.match(/MODIFY COLUMN/g)).toHaveLength(1)
    expect(conflicts).toEqual([])
  })

  it('says what is being carried, in the text that gets copied', () => {
    const out = script('default', [
      member({ table: 'a', column: 'n' }),
      member({ table: 'b', column: 'n', verified: false }),
    ])

    expect(out).toContain('2 columns over 2 tables, 2 statements')
    expect(out).toContain('1 of them rest')
    expect(out.trimEnd().endsWith(';')).toBe(true)
  })

  it('does not claim a verdict the members did not give', () => {
    const out = script('default', [member({ table: 'a', column: 'n' })])
    expect(out).toContain('measured over every row')
  })

  it('is empty when nothing is ticked, rather than a header over no SQL', () => {
    expect(script('default', [])).toBe('')
  })

  it('counts the tables a set of ticks reaches, not the ticks', () => {
    expect(
      reach([
        member({ table: 'a', column: 'x' }),
        member({ table: 'a', column: 'y' }),
        member({ table: 'b', column: 'x', bytes: null }),
      ]),
    ).toEqual({ columns: 3, tables: 2, bytes: 2_000, unknown: 1, unverified: 0 })
  })
})
