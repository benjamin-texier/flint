import { describe, expect, it } from 'vitest'

import type { ColumnFacts, SchemaReview } from './api'
import {
  atStake,
  codecDdl,
  findings,
  KIND_LABEL,
  KINDS,
  narrowestInteger,
  parseKinds,
  rank,
  reading,
  serialiseKinds,
  tally,
  times,
  windowOf,
  type Kind,
} from './review'

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
    // Mirrors the backend: exact to 100, 101 meaning "more".
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

function review(columns: ColumnFacts[], over: Partial<SchemaReview> = {}): SchemaReview {
  return {
    database: 'default',
    table: 'events',
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
  }
}

const of = (columns: ColumnFacts[], over?: Partial<SchemaReview>) =>
  findings(review(columns, over))

describe('narrowestInteger', () => {
  it('picks unsigned when nothing is negative', () => {
    expect(narrowestInteger('0', '200')).toBe('UInt8')
    expect(narrowestInteger('0', '300')).toBe('UInt16')
    expect(narrowestInteger('1', '70000')).toBe('UInt32')
  })

  it('picks signed when something is', () => {
    expect(narrowestInteger('-1', '200')).toBe('Int16')
    expect(narrowestInteger('-128', '127')).toBe('Int8')
    expect(narrowestInteger('-129', '127')).toBe('Int16')
  })

  it('holds an Int64 boundary that a double would round away', () => {
    expect(narrowestInteger('0', '9007199254740993')).toBe('UInt64')
    expect(narrowestInteger('0', '4294967295')).toBe('UInt32')
    expect(narrowestInteger('0', '4294967296')).toBe('UInt64')
  })

  it('answers null for a range that is not integral', () => {
    expect(narrowestInteger('1.5', '2')).toBeNull()
    expect(narrowestInteger(null, '2')).toBeNull()
  })
})

describe('a column that says nothing', () => {
  it('is reported, with the drop spelled out and a warning louder than it', () => {
    const found = of([column({ name: 'tenant', type: 'String', distinct: 1 })])
    expect(found).toHaveLength(1)
    expect(found[0]!.headline).toBe('carries no information here')
    expect(found[0]!.severity).toBe('note')
    expect(found[0]!.ddl).toContain('DROP COLUMN tenant')
    expect(found[0]!.caution).toContain('no undo')
  })

  it('says which kind of nothing it is', () => {
    const nulls = of([
      column({ name: 'note', type: 'Nullable(String)', distinct: 0, nulls: 10_000 }),
    ])
    expect(nulls[0]!.evidence).toContain('null in every row')
  })
})

describe('a Nullable that has never been null', () => {
  it('proposes the plain type', () => {
    const found = of([column({ name: 'host', type: 'Nullable(String)', nulls: 0 })])
    const drop = found.find((f) => f.proposal === 'String')!
    expect(drop.headline).toBe('Nullable(String) → String')
    expect(drop.ddl).toBe('ALTER TABLE default.events\n  MODIFY COLUMN host String')
    expect(drop.severity).toBe('save')
    expect(drop.caution).toContain('could')
  })

  it('counts empty strings apart, because they are not nulls', () => {
    const found = of([column({ name: 'host', type: 'Nullable(String)', nulls: 0, empties: 7 })])
    expect(found[0]!.evidence).toContain('7 empty strings')
  })

  it('says nothing about the Nullable once a null has been seen', () => {
    const found = of([column({ name: 'host', type: 'Nullable(String)', nulls: 1 })])
    expect(found.map((f) => f.proposal)).not.toContain('String')
  })

  it('asks for verification when the numbers came from a prefix', () => {
    const found = of([column({ name: 'host', type: 'Nullable(String)' })], {
      verified: false,
      scanned: 200_000,
      total_rows: 5_000_000,
    })
    expect(found[0]!.verified).toBe(false)
    expect(found[0]!.caution).toContain('Verify over every row')
  })
})

describe('text that would rather be a dictionary', () => {
  it('proposes LowCardinality when values repeat enough', () => {
    const found = of([column({ name: 'method', type: 'String', distinct: 5 })])
    expect(found[0]!.headline).toBe('String → LowCardinality(String)')
    expect(found[0]!.why).toContain('repeats about 2,000 times')
  })

  it('keeps the Nullable wrapper where there is one', () => {
    const found = of([column({ name: 'agent', type: 'Nullable(String)', distinct: 4, nulls: 3 })])
    expect(found[0]!.proposal).toBe('LowCardinality(Nullable(String))')
  })

  it('holds back when each value barely repeats', () => {
    // 2,000 distinct over 10,000 rows: five repeats, under the floor.
    const found = of([column({ name: 'path', type: 'String', distinct: 2000 })])
    expect(found.map((f) => f.proposal)).not.toContain('LowCardinality(String)')
  })

  it('holds back on a tiny table, where every column looks low-cardinality', () => {
    const found = of([column({ name: 'method', type: 'String', distinct: 3 })], {
      scanned: 40,
      total_rows: 40,
    })
    expect(found.map((f) => f.proposal)).not.toContain('LowCardinality(String)')
  })

  it('says nothing about a column that already is one', () => {
    const found = of([column({ name: 'method', type: 'LowCardinality(String)', distinct: 5 })])
    expect(found).toHaveLength(0)
  })
})

describe('how the count is worded', () => {
  it('says a number when the count is exact and "about" when it is an estimate', () => {
    const small = of([column({ name: 'method', type: 'String', distinct: 5 })])
    expect(small[0]!.evidence).toBe('5 distinct values in 10,000 rows')

    const big = of([column({ name: 'path', type: 'String', distinct: 900 })])
    expect(big[0]!.evidence).toBe('about 900 distinct values in 10,000 rows')
  })

  it('will not call a column dead on an estimate', () => {
    // The estimate says one; the exact count has given up. No claim.
    const found = of([
      column({ name: 'x', type: 'String', distinct: 1, distinct_small: 101 } as never),
    ])
    expect(found.map((f) => f.headline)).not.toContain('carries no information here')
  })
})

describe('a dictionary that has outgrown itself', () => {
  it('proposes taking it off', () => {
    const found = of([
      column({ name: 'url', type: 'LowCardinality(String)', distinct: 10_001, distinct_capped: true }),
    ])
    expect(found[0]!.headline).toBe('LowCardinality(String) → String')
    expect(found[0]!.severity).toBe('fix')
  })
})

describe('an integer with more room than it uses', () => {
  it('proposes the narrowest that fits, and states the headroom', () => {
    const found = of([column({ name: 'status', type: 'Int32', min: '200', max: '503' })])
    expect(found[0]!.headline).toBe('Int32 → UInt16')
    expect(found[0]!.evidence).toContain('65,535')
    expect(found[0]!.caution).toContain('Headroom')
  })

  it('leaves a column that already fits alone', () => {
    expect(of([column({ name: 'flag', type: 'UInt8', min: '0', max: '1' })])).toHaveLength(0)
  })

  it('does not narrow past a negative value', () => {
    const found = of([column({ name: 'delta', type: 'Int64', min: '-40000', max: '10' })])
    expect(found[0]!.headline).toBe('Int64 → Int32')
  })
})

describe('a float holding whole numbers', () => {
  it('says so and proposes an integer', () => {
    const found = of([
      column({ name: 'ms', type: 'Float32', fractional: 0, min: '0', max: '900' }),
    ])
    expect(found[0]!.headline).toBe('Float32 → UInt16')
    expect(found[0]!.why).toContain('mantissa')
  })

  it('still reports it when no integer type fits', () => {
    const found = of([
      column({ name: 'big', type: 'Float64', fractional: 0, min: '0', max: '1e30' }),
    ])
    expect(found[0]!.proposal).toBeNull()
    expect(found[0]!.ddl).toBeNull()
    expect(found[0]!.headline).toBe('holds only whole numbers')
  })

  it('says nothing when a fraction has been seen', () => {
    expect(
      of([column({ name: 'ratio', type: 'Float64', fractional: 3, min: '0', max: '1' })]),
    ).toHaveLength(0)
  })
})

describe('text that is really something else', () => {
  it('spots a UUID by its length and its parse', () => {
    const found = of([
      column({ name: 'id', type: 'String', not_a_uuid: 0, min_len: 36, max_len: 36, distinct: 9000, distinct_capped: true }),
    ])
    expect(found[0]!.headline).toBe('String → UUID')
    expect(found[0]!.caution).toContain('lower-case')
  })

  it('spots a date, and is not fooled by a column of digits', () => {
    const dates = of([
      column({
        name: 'day',
        type: 'String',
        not_a_date: 0,
        not_a_number: 900,
        min_len: 10,
        max_len: 10,
        distinct_capped: true,
      }),
    ])
    expect(dates[0]!.headline).toBe('String → Date')
    expect(dates[0]!.severity).toBe('fix')

    // `20240501` parses as a date *and* as a number: it is a number.
    const digits = of([
      column({
        name: 'code',
        type: 'String',
        not_a_date: 0,
        not_a_number: 0,
        min_len: 8,
        max_len: 8,
        distinct_capped: true,
      }),
    ])
    expect(digits.map((f) => f.proposal)).not.toContain('Date')
  })

  it('proposes DateTime when the values are longer than a date', () => {
    const found = of([
      column({
        name: 'at',
        type: 'String',
        not_a_date: 0,
        not_a_number: 900,
        min_len: 19,
        max_len: 19,
        distinct_capped: true,
      }),
    ])
    expect(found[0]!.proposal).toBe('DateTime')
    expect(found[0]!.caution).toContain('time zone')
  })

  it('proposes FixedString for one fixed length that is not a UUID', () => {
    const found = of([
      column({
        name: 'cc',
        type: 'String',
        min_len: 2,
        max_len: 2,
        not_a_uuid: 900,
        distinct: 10_001,
        distinct_capped: true,
      }),
    ])
    expect(found[0]!.headline).toBe('String → FixedString(2)')
    expect(found[0]!.caution).toContain('pads')
  })
})

describe('a column that is part of the table’s order', () => {
  it('is warned about rather than silently proposed', () => {
    const found = of([
      column({ name: 'ts', type: 'Nullable(DateTime)', nulls: 0, in_sorting_key: true }),
    ])
    expect(found[0]!.caution).toContain('sorting key')

    const partitioned = of([
      column({ name: 'day', type: 'Nullable(Date)', nulls: 0, in_partition_key: true }),
    ])
    expect(partitioned[0]!.caution).toContain('partition key')
  })
})

describe('what reads the column', () => {
  it('says how many queries read it, when the log could say', () => {
    const found = of([column({ name: 'method', type: 'String', distinct: 5, read_by: 87 })])
    expect(found[0]!.usage).toBe('read by 87 queries in 7 days')
  })

  it('says nothing at all when the log could not be read', () => {
    expect(of([column({ name: 'method', type: 'String', distinct: 5 })])[0]!.usage).toBeNull()
  })

  it('distinguishes "nothing read it" from "I could not tell"', () => {
    const none = of([column({ name: 'method', type: 'String', distinct: 5, read_by: 0 })])
    expect(none[0]!.usage).toBe('nothing has read this column in 7 days')
  })

  it('will not call an unread column unused when the table is being written', () => {
    const written = findings(
      review([column({ name: 'tenant', type: 'String', distinct: 1, read_by: 0 })], { writes: 14 }),
    )
    expect(written[0]!.usage).toBe(
      'nothing has read this column in 7 days, though the table took 14 inserts',
    )
    // The dangerous sentence, and the one that replaces it.
    expect(written[0]!.why).not.toContain('would go unnoticed')
    expect(written[0]!.why).toContain('fails the moment it is dropped')
  })

  it('adds the fact to a dead column, where it changes the advice', () => {
    const dead = of([column({ name: 'tenant', type: 'String', distinct: 1, read_by: 0 })])
    expect(dead[0]!.why).toContain('would go unnoticed')
    const readDead = of([column({ name: 'tenant', type: 'String', distinct: 1, read_by: 9 })])
    expect(readDead[0]!.why).not.toContain('would go unnoticed')
  })
})

describe('ordering and the total', () => {
  it('puts the biggest column first and the unmeasurable ones last', () => {
    const list = rank([
      { column: 'a', bytes: null, severity: 'save' } as never,
      { column: 'b', bytes: 10, severity: 'save' } as never,
      { column: 'c', bytes: 5000, severity: 'note' } as never,
    ])
    expect(list.map((f) => f.column)).toEqual(['c', 'b', 'a'])
  })

  it('adds up what is at stake, once per column, and counts what it cannot', () => {
    const stake = atStake([
      { column: 'a', bytes: 100, severity: 'save' } as never,
      { column: 'a', bytes: 100, severity: 'fix' } as never,
      { column: 'b', bytes: null, severity: 'save' } as never,
      { column: 'c', bytes: 400, severity: 'note' } as never,
    ])
    expect(stake).toEqual({ bytes: 100, columns: 1, unknown: 1 })
  })
})

describe('what a finding is about', () => {
  it('gathers the rules a reader has one opinion about into one kind', () => {
    // Two different rules, one decision: a String holding something that has a
    // type of its own. Splitting them would make the filter a list of rules.
    const uuid = of([
      column({
        name: 'id',
        type: 'String',
        not_a_uuid: 0,
        not_a_number: 4,
        min_len: 36,
        max_len: 36,
        distinct: 9000,
        distinct_capped: true,
      }),
    ])
    const date = of([
      column({
        name: 'day',
        type: 'String',
        not_a_date: 0,
        not_a_number: 4,
        min_len: 10,
        max_len: 10,
        distinct: 9000,
        distinct_capped: true,
      }),
    ])
    expect(uuid[0]!.kind).toBe('text')
    expect(date[0]!.kind).toBe('text')
  })

  it('is a different question from severity', () => {
    // A dictionary that has outgrown itself and one a column is asking for are
    // the same subject and different verdicts. A filter on severity could not
    // put "dictionaries" away, which is the whole reason kind exists.
    const wanted = of([column({ name: 'host', type: 'String', distinct: 6 })])[0]!
    const outgrown = of([
      column({
        name: 'path',
        type: 'LowCardinality(String)',
        distinct: 40_000,
        distinct_capped: true,
      }),
    ])[0]!
    expect(wanted.kind).toBe(outgrown.kind)
    expect(wanted.severity).not.toBe(outgrown.severity)
  })

  it('gives every kind a label and a gloss', () => {
    for (const kind of KINDS) {
      expect(KIND_LABEL[kind].label.length).toBeGreaterThan(0)
      expect(KIND_LABEL[kind].gloss.length).toBeGreaterThan(0)
    }
  })
})

describe('the kinds on offer', () => {
  it('counts only the kinds this table actually has', () => {
    // Offering to hide a kind with nothing in it reads as a filter that failed.
    const found = of([
      column({ name: 'host', type: 'String', distinct: 6 }),
      column({ name: 'agent', type: 'String', distinct: 9 }),
      column({ name: 'n', type: 'UInt64', min: '0', max: '200', distinct: 150 }),
    ])
    expect(tally(found)).toEqual([
      { kind: 'dictionary', count: 2 },
      { kind: 'width', count: 1 },
    ])
  })

  it('keeps the settled order rather than the order findings came in', () => {
    const entries = tally([
      { kind: 'codecs' } as never,
      { kind: 'nullable' } as never,
      { kind: 'dictionary' } as never,
    ])
    expect(entries.map((e) => e.kind)).toEqual(['dictionary', 'nullable', 'codecs'])
  })

  it('has nothing to offer for a table with no findings', () => {
    expect(tally([])).toEqual([])
  })
})

describe('remembering which kinds were put away', () => {
  it('drops anything that is not a kind Flint has now', () => {
    // A preference saved against a category since renamed would otherwise hide
    // a list with no checkbox left to un-hide it.
    expect([...parseKinds('codecs,gorillas,width')]).toEqual(['codecs', 'width'])
  })

  it('reads nothing stored as nothing hidden', () => {
    expect(parseKinds(null)).toEqual(new Set())
    expect(parseKinds('')).toEqual(new Set())
  })

  it('writes the settled order, so ticking two boxes either way round stores one string', () => {
    const a = new Set<Kind>(['codecs', 'nullable'])
    const b = new Set<Kind>(['nullable', 'codecs'])
    expect(serialiseKinds(a)).toBe('nullable,codecs')
    expect(serialiseKinds(b)).toBe(serialiseKinds(a))
  })

  it('says nothing rather than an empty string when nothing is hidden', () => {
    // An absent key and an empty one mean the same thing, and two spellings of
    // one state is a bug waiting for the next reader.
    expect(serialiseKinds(new Set())).toBeNull()
  })

  it('survives the round trip', () => {
    const kinds = new Set<Kind>(['dictionary', 'text', 'constant'])
    expect(parseKinds(serialiseKinds(kinds))).toEqual(kinds)
  })
})

describe('the tally over a grouped reading', () => {
  it('counts anything carrying a kind, not findings alone', () => {
    // `sweep.ts` groups the same findings by column across a database and
    // carries the kind through; one filter has to be able to count both.
    const groups: { kind: Kind; column: string; members: number }[] = [
      { kind: 'width', column: 'n', members: 4 },
      { kind: 'width', column: 'm', members: 2 },
      { kind: 'codecs', column: 'ts', members: 9 },
    ]
    expect(tally(groups)).toEqual([
      { kind: 'width', count: 2 },
      { kind: 'codecs', count: 1 },
    ])
  })
})

describe('a table with nothing to say about it', () => {
  it('produces no findings rather than filler', () => {
    expect(
      of([
        column({ name: 'ts', type: 'DateTime', distinct: 9000, distinct_capped: true }),
        column({ name: 'n', type: 'UInt8', min: '0', max: '255', distinct: 200 }),
      ]),
    ).toEqual([])
  })
})

describe('reading a measurement', () => {
  const outcome = (over: Partial<import('./api').ProbeOutcome> = {}) => ({
    column: 'path', from_type: 'String', to_type: 'LowCardinality(String)',
    rows: 3540, before_compressed: 16272, after_compressed: 6740,
    before_raw: 137465, after_raw: 17240,
    column_compressed: null, total_rows: 3540, refused: null,
    before_scanned: 0, after_scanned: 0,
    ...over,
  })

  it('names the ratio the probe measured, compressed and raw apart', () => {
    const r = reading(outcome())
    expect(times(r.ratio)).toBe('2.4×')
    expect(times(r.rawRatio)).toBe('8×')
    expect(r.worse).toBe(false)
  })

  it('projects onto the real column only when its size is known', () => {
    expect(reading(outcome()).projected).toBeNull()
    const known = reading(outcome({ column_compressed: 40_000_000 }))
    expect(known.projected).toBeCloseTo(40_000_000 / (16272 / 6740), 0)
  })

  it('says when a change makes the column bigger', () => {
    const r = reading(outcome({ before_compressed: 500, after_compressed: 900 }))
    expect(r.worse).toBe(true)
    expect(times(r.ratio)).toBe('0.6×')
  })

  it('holds a refusal without inventing a ratio', () => {
    const r = reading(outcome({ rows: 0, before_compressed: 0, after_compressed: 0, before_raw: 0, after_raw: 0, refused: 'Cannot convert NULL value' }))
    expect(r.ratio).toBeNull()
    expect(times(r.ratio)).toBeNull()
    expect(r.projected).toBeNull()
  })
})

describe('the work the probe weighed', () => {
  const outcome = (over = {}) => ({
    column: 'path', from_type: 'String', to_type: 'LowCardinality(String)',
    rows: 2_000_000, before_compressed: 708_474, after_compressed: 58_327,
    before_raw: 55_218_995, after_raw: 4_016_046,
    before_scanned: 45_214_270, after_scanned: 4_000_000,
    column_compressed: null, total_rows: 2_000_000, refused: null,
    ...over,
  })

  it('names how many times fewer bytes the same grouping moved', () => {
    expect(times(reading(outcome()).scanRatio)).toBe('11.3×')
  })

  it('offers no scan figure when the work could not be weighed', () => {
    const r = reading(outcome({ before_scanned: 0, after_scanned: 0 }))
    expect(r.scanRatio).toBeNull()
  })
})

describe('a column on the table’s default compression', () => {
  it('offers to weigh codecs, and proposes nothing', () => {
    const found = of([
      column({ name: 'ts', type: 'DateTime', distinct: 9000, distinct_capped: true, compressed_bytes: 4_000_000 }),
    ])
    const codec = found.find((f) => f.weigh === 'codecs')!
    expect(codec.headline).toBe('takes the table’s default compression')
    expect(codec.proposal).toBeNull()
    expect(codec.ddl).toBeNull()
    expect(codec.why).toContain('lossless')
  })

  it('leaves a column alone when somebody has already chosen one', () => {
    const found = of([
      column({ name: 'ts', type: 'DateTime', codec: 'CODEC(DoubleDelta, ZSTD)', distinct: 9000, distinct_capped: true, compressed_bytes: 4_000_000 }),
    ])
    expect(found.some((f) => f.weigh === 'codecs')).toBe(false)
  })

  it('does not offer it for text, where the dictionary is the lever', () => {
    const found = of([column({ name: 'host', type: 'String', distinct: 5, compressed_bytes: 9_000_000 })])
    expect(found.some((f) => f.weigh === 'codecs')).toBe(false)
  })

  it('holds back on a column too small to be worth a mutation', () => {
    const small = of([
      column({ name: 'ts', type: 'DateTime', distinct: 9000, distinct_capped: true, compressed_bytes: 4_000 }),
    ])
    expect(small.some((f) => f.weigh === 'codecs')).toBe(false)
  })

  it('holds back when the size cannot be measured at all', () => {
    // Compact parts: no per-column bytes, so no way to say it is worth doing.
    const unknown = of([
      column({ name: 'ts', type: 'DateTime', distinct: 9000, distinct_capped: true }),
    ])
    expect(unknown.some((f) => f.weigh === 'codecs')).toBe(false)
  })

  it('writes the whole column definition into the ALTER, type included', () => {
    expect(codecDdl('default', 'events', 'ts', 'DateTime', 'DoubleDelta, ZSTD')).toBe(
      'ALTER TABLE default.events\n  MODIFY COLUMN ts DateTime CODEC(DoubleDelta, ZSTD)',
    )
  })
})

describe('the window the figures actually cover', () => {
  const reaching = (hours: number | null) =>
    review([column({ name: 'a', type: 'String', distinct: 5, read_by: 0 })], {
      usage_hours: hours,
      usage_days: 7,
    })

  it('says the window asked for when the log really reaches that far', () => {
    expect(windowOf(reaching(7 * 24))).toBe('7 days')
    // And within a couple of hours of it: the distinction is noise there.
    expect(windowOf(reaching(7 * 24 - 1))).toBe('7 days')
  })

  it('says what the log keeps when that is less — measured at 12 hours', () => {
    // The machine this was built against: a one-day TTL holding twelve hours.
    // "7 days" there is wrong by a factor of fourteen.
    expect(windowOf(reaching(12))).toBe('the 12 hours the log keeps')
  })

  it('switches to days once there are a couple', () => {
    expect(windowOf(reaching(72))).toBe('the 3 days the log keeps')
  })

  it('has a floor, because "the 0 hours the log keeps" says nothing', () => {
    expect(windowOf(reaching(1))).toBe('the last hour, which is all the log keeps')
    expect(windowOf(reaching(0))).toBe('the last hour, which is all the log keeps')
  })

  it('falls back to the window asked for when the log will not say', () => {
    expect(windowOf(reaching(null))).toBe('7 days')
  })

  it('puts the real window into the sentence somebody would act on', () => {
    const found = findings(reaching(12))
    expect(found[0]!.usage).toBe('nothing has read this column in the 12 hours the log keeps')
  })

  it('takes the hours from the server rather than subtracting two clocks', () => {
    // The figure arrives already computed; nothing here parses a timestamp.
    // When that arithmetic was done in the browser it was two hours out.
    const said = findings(reaching(12))
    expect(said[0]!.usage).not.toContain('7 days')
  })
})
