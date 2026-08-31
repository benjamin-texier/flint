import { describe, expect, it } from 'vitest'

import type {
  Advice,
  AdviceColumn,
  DatabaseAdvice,
  Existing,
  Measurement,
  Pattern,
  TableStanding,
} from './api'
import {
  benefit,
  decompose,
  candidates,
  coveringProjection,
  cost,
  ddlFor,
  isAggregate,
  limits,
  projectionName,
  read,
  rowsPerRun,
  servedByKey,
  PROJECTION_ROW_FLOOR,
  ranked,
  rankTally,
  standing,
  tally,
  unreadable,
  weighRequest,
  type Candidate,
} from './projection'

/* The example from the brief: a table ordered by (project_id, time), with a
   device_id and a type nobody put in the key. Every fixture below is that
   table, because the whole feature is about the gap between what it is sorted
   by and what gets asked of it. */
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
    tables: ['lab.traffic'],
    projections: [],
    ...over,
  }
}

function advice(patterns: Pattern[], over: Partial<Advice> = {}): Advice {
  return {
    database: 'lab',
    table: 'traffic',
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
    // Nothing left out unless a case says so: equal to what the list holds.
    shapes_total: patterns.length,
    runs_total: patterns.reduce((n, p) => n + p.runs, 0),
    ...over,
    workload: { items: patterns },
  }
}

function measurement(over: Partial<Measurement> = {}): Measurement {
  return {
    keys: ['`device_id`'],
    total_rows: 5_000_000,
    groups: 20_000,
    groups_exact: true,
    max_rows_per_key: 250,
    avg_rows_per_key: 250,
    columns_compressed: 2_150_940,
    parts: 5,
    index_granularity: 8192,
    ...over,
  }
}

describe('reading a statement', () => {
  it('separates an equality from a range, because a key serves them in that order', () => {
    const { access } = read(
      "SELECT count(), sum(value) FROM traffic WHERE device_id = 'dev-1' AND time > now() - INTERVAL 7 DAY",
      'traffic',
      COLUMNS,
    )
    expect(access?.equalities).toEqual([
      { column: 'device_id', kind: 'equality', bucket: null, expr: 'device_id' },
    ])
    expect(access?.ranges).toEqual([{ column: 'time', kind: 'range', bucket: null, expr: 'time' }])
    // `>=` arrives as two punctuation tokens and has to be read as one.
    const ge = read('SELECT count() FROM traffic WHERE time >= now()', 'traffic', COLUMNS)
    expect(ge.access?.ranges).toEqual([
      { column: 'time', kind: 'range', bucket: null, expr: 'time' },
    ])
  })

  it('reads IN as an equality and LIKE as no filter at all', () => {
    const inList = read("SELECT count() FROM traffic WHERE type IN ('view', 'click')", 'traffic', COLUMNS)
    expect(inList.access?.equalities).toEqual([
      { column: 'type', kind: 'equality', bucket: null, expr: 'type' },
    ])
    // A key does nothing for a LIKE, so proposing one for it would produce a
    // projection the server never chooses.
    const like = read("SELECT count() FROM traffic WHERE device_id LIKE 'dev-%'", 'traffic', COLUMNS)
    expect(like.access?.equalities).toEqual([])
    expect(like.access?.ranges).toEqual([])
  })

  it('resolves a grouping through its alias and through a bucket', () => {
    const { access } = read(
      'SELECT toStartOfHour(time) AS h, count() FROM traffic GROUP BY h',
      'traffic',
      COLUMNS,
    )
    // `quoteIdent` leaves a plain name alone, so the generated expression is
    // the one a reader would have written by hand.
    expect(access?.group).toEqual([
      { column: 'time', bucket: 'toStartOfHour', expr: 'toStartOfHour(time)' },
    ])
    expect(access?.aggregates).toEqual(['count()'])
  })

  it('keeps aggregate expressions verbatim, because ClickHouse matches them that way', () => {
    // Measured on a real server: a projection holding count() and sum(value)
    // did not answer avg(value). So the proposal has to carry what the workload
    // actually wrote, not a normalised set.
    const { access } = read(
      'SELECT type, count(), sum(value), quantile(0.95)(value) FROM traffic GROUP BY type',
      'traffic',
      COLUMNS,
    )
    expect(access?.aggregates).toEqual(['count()', 'sum(value)', 'quantile(0.95)(value)'])
  })

  it('refuses what it cannot read, and says which', () => {
    expect(read('INSERT INTO traffic VALUES', 'traffic', COLUMNS).refused).toBe('not-a-select')
    expect(
      read('SELECT 1 FROM traffic UNION ALL SELECT 2 FROM traffic', 'traffic', COLUMNS).refused,
    ).toBe('compound')
    expect(
      read('SELECT t.value FROM traffic AS t JOIN other AS o ON o.id = t.project_id', 'traffic', COLUMNS)
        .refused,
    ).toBe('joins')
    expect(read('SELECT count() FROM other_table', 'traffic', COLUMNS).refused).toBe('not-this-table')
    // Two columns in one conjunct is a comparison no sort order helps with.
    expect(
      read('SELECT count() FROM traffic WHERE project_id = value', 'traffic', COLUMNS).refused,
    ).toBe('opaque-filter')
    // A grouping expression the measurement endpoint would refuse anyway.
    expect(
      read(
        'SELECT toStartOfInterval(time, INTERVAL 3 HOUR) AS b, count() FROM traffic GROUP BY b',
        'traffic',
        COLUMNS,
      ).refused,
    ).toBe('opaque-grouping')
  })

  it('does not read a filter on a function of a column as a filter on the column', () => {
    const columns: AdviceColumn[] = [
      ...COLUMNS,
      { name: 'length', type: 'UInt32', sorting_position: null, in_partition_key: false, compressed_bytes: null },
    ]
    const { access } = read(
      'SELECT count() FROM traffic WHERE length(device_id) = 8',
      'traffic',
      columns,
    )
    // A key ordered by device_id does nothing for `length(device_id) = 8`, so
    // this is not a filter to propose a key from. Reading it as one would put
    // a projection in front of somebody that the server would never choose.
    expect(access?.equalities).toEqual([])
    expect(access?.columns).toContain('device_id')
  })

  it('follows a filter written against a select alias', () => {
    // The commonest bucketed shape there is, and it was unreadable before:
    // ClickHouse lets a WHERE name an alias from the select list.
    const { access } = read(
      'SELECT toStartOfHour(time) AS h, count() FROM traffic WHERE h > now() - INTERVAL 2 DAY GROUP BY h',
      'traffic',
      COLUMNS,
    )
    expect(access?.ranges).toEqual([
      { column: 'time', kind: 'range', bucket: 'toStartOfHour', expr: 'toStartOfHour(time)' },
    ])
  })

  it('warns about a raw filter and stays quiet about a bucketed one', () => {
    // Measured on the same projection: 2,363,170 rows when the filter names
    // `time`, 620 when it names `toStartOfHour(time)`. Only the first is worth
    // a warning, and warning about the second would be noise on the case that
    // works.
    const raw = candidates(
      advice([
        pattern({
          statement:
            'SELECT toStartOfHour(time) AS h, count() FROM traffic WHERE time > now() GROUP BY h',
        }),
      ]),
    ).find((c) => c.kind === 'aggregate')!
    expect(raw.caveats.join(' ')).toContain('until the filter names the same expression')

    const bucketed = candidates(
      advice([
        pattern({
          statement:
            'SELECT toStartOfHour(time) AS h, count() FROM traffic WHERE h > now() GROUP BY h',
        }),
      ]),
    ).find((c) => c.kind === 'aggregate')!
    expect(bucketed.caveats).toEqual([])
    expect(bucketed.key.map((k) => k.expr)).toEqual(['toStartOfHour(time)'])
  })
})

describe('what the sorting key already serves', () => {
  it('is about the first key column and nothing else', () => {
    const served = read("SELECT count() FROM traffic WHERE project_id = 3", 'traffic', COLUMNS)
    expect(servedByKey(served.access!, ['project_id', 'time'])).toBe(true)
    // Second in the key is not reachable without the first: this is the whole
    // case a projection exists for.
    const notServed = read("SELECT count() FROM traffic WHERE time > now()", 'traffic', COLUMNS)
    expect(servedByKey(notServed.access!, ['project_id', 'time'])).toBe(false)
  })
})

describe('candidates', () => {
  it('proposes a sort order for a filter the key cannot reach', () => {
    const list = candidates(
      advice([
        pattern({
          statement: "SELECT count(), sum(value) FROM traffic WHERE device_id = 'dev-1234'",
        }),
      ]),
    )
    expect(list).toHaveLength(1)
    expect(list[0]!.kind).toBe('sort')
    expect(list[0]!.key.map((k) => k.column)).toEqual(['device_id'])
    // Only the columns the query reads — the difference measured at 1.7 MB
    // against 22.5 MB for the same key with SELECT *.
    expect(list[0]!.columns).toEqual(['device_id', 'value'])
  })

  it('proposes nothing for a filter the key already serves', () => {
    const list = candidates(
      advice([pattern({ statement: 'SELECT count() FROM traffic WHERE project_id = 3' })]),
    )
    expect(list).toHaveLength(0)
  })

  it('proposes an aggregate projection for a grouping, keeping the aggregates it saw', () => {
    const list = candidates(
      advice([
        pattern({ statement: 'SELECT type, count() FROM traffic GROUP BY type' }),
        pattern({ statement: 'SELECT type, avg(value) FROM traffic GROUP BY type', hash: 'b' }),
      ]),
    )
    const aggregate = list.find((c) => c.kind === 'aggregate')!
    expect(aggregate.key.map((k) => k.column)).toEqual(['type'])
    // Both shapes fold into one proposal, and it stores both aggregates —
    // because a projection holding only count() leaves the avg() query reading
    // the whole table.
    expect(aggregate.aggregates).toEqual(['count()', 'avg(value)'])
    expect(aggregate.patterns).toHaveLength(2)
  })

  it('puts a filtered column into the aggregate key, since a fold cannot be filtered afterwards', () => {
    const list = candidates(
      advice([
        pattern({
          statement: "SELECT type, count() FROM traffic WHERE project_id = 3 GROUP BY type",
        }),
      ]),
    )
    const aggregate = list.find((c) => c.kind === 'aggregate')!
    // Sorted, so the same set of key columns is one proposal however the shapes
    // that produced it happened to be written.
    expect(aggregate.key.map((k) => k.column)).toEqual(['project_id', 'type'])
  })

  it('ranks by the time the workload actually spends', () => {
    const list = candidates(
      advice([
        pattern({ statement: "SELECT count() FROM traffic WHERE device_id = 'a'", total_ms: 100, hash: 'cheap' }),
        pattern({ statement: "SELECT count() FROM traffic WHERE type = 'view'", total_ms: 9000, hash: 'dear' }),
      ]),
    )
    expect(list[0]!.key[0]!.column).toBe('type')
  })

  it('recognises one grouping written two ways as one proposal', () => {
    // A key is a set for an aggregate projection's purposes, and two shapes
    // reaching the same set produced two nearly identical cards before this.
    const list = candidates(
      advice([
        pattern({ statement: "SELECT type, count() FROM traffic WHERE project_id = 3 GROUP BY type", hash: 'a' }),
        pattern({ statement: "SELECT project_id, count() FROM traffic WHERE type = 'view' GROUP BY project_id", hash: 'b' }),
      ]),
    ).filter((c) => c.kind === 'aggregate')
    expect(list).toHaveLength(1)
    expect(list[0]!.key.map((k) => k.column)).toEqual(['project_id', 'type'])
    expect(list[0]!.runs).toBe(20)
  })

  it('names the wider proposal that would serve a narrower one too', () => {
    const list = candidates(
      advice([
        pattern({ statement: 'SELECT type, count() FROM traffic GROUP BY type', hash: 'a' }),
        pattern({ statement: 'SELECT type, project_id, count() FROM traffic GROUP BY type, project_id', hash: 'b' }),
      ]),
    ).filter((c) => c.kind === 'aggregate')
    const narrow = list.find((c) => c.key.length === 1)!
    // Named, not merged: whether one projection or two is the right answer
    // depends on what each measures out at.
    expect(narrow.alsoServedBy).toEqual(['project_id, type'])
  })

  it('marks a proposal argued from one run as thin', () => {
    const list = candidates(
      advice([
        pattern({ statement: "SELECT count() FROM traffic WHERE device_id = 'a'", runs: 1, total_ms: 3, hash: 'once' }),
        pattern({ statement: "SELECT count() FROM traffic WHERE type = 'x'", runs: 200, total_ms: 9000, hash: 'often' }),
      ]),
    )
    const once = list.find((c) => c.key[0]!.column === 'device_id')!
    expect(once.thin).toBe(true)
    expect(once.caveats.join(' ')).toContain('permanent cost')
    expect(list.find((c) => c.key[0]!.column === 'type')!.thin).toBe(false)
  })

  it('says when a proposal has folded in more aggregates than it should', () => {
    const shapes = ['count()', 'sum(value)', 'avg(value)', 'min(value)', 'max(value)'].map((agg, i) =>
      pattern({ statement: `SELECT type, ${agg} FROM traffic GROUP BY type`, hash: `agg${i}` }),
    )
    const candidate = candidates(advice(shapes)).find((c) => c.kind === 'aggregate')!
    expect(candidate.aggregates).toHaveLength(5)
    expect(candidate.caveats.join(' ')).toContain('5 different aggregates')
  })

  it('carries the patterns it could not read, rather than dropping them', () => {
    const report = advice([
      pattern({ statement: 'SELECT t.value FROM traffic AS t JOIN devices AS d ON d.id = t.device_id' }),
    ])
    expect(candidates(report)).toHaveLength(0)
    expect(unreadable(report)).toHaveLength(1)
    expect(unreadable(report)[0]!.why).toContain('more than one table')
  })
})

describe('coverage by what already exists', () => {
  const built = (over: Partial<Existing>): Existing => ({
    name: 'p',
    kind: 'Aggregate',
    query: 'SELECT type, count() GROUP BY type',
    sorting_key: ['type'],
    parts: 5,
    rows: 15,
    bytes: 1995,
    inert: false,
    used_by: 10,
    ...over,
  })

  const aggregate = (key: string[], aggregates: string[]): Candidate => ({
    kind: 'aggregate',
    id: 'x',
    key: key.map((column) => ({ column, bucket: null, expr: `\`${column}\`` })),
    aggregates,
    columns: [],
    patterns: [],
    runs: 0,
    alsoServedBy: [],
    thin: false,
    caveats: [],
    coveredBy: null,
    alreadyServed: 0,
  })

  it('accepts a superset key, which the server does', () => {
    // Measured: a projection keyed (project_id, type) answered GROUP BY
    // project_id from 750 rows rather than 5,000,000.
    const existing = [
      built({
        name: 'p_pt',
        query: 'SELECT project_id, type, count() GROUP BY project_id, type',
        sorting_key: ['project_id', 'type'],
      }),
    ]
    expect(coveringProjection(aggregate(['project_id'], ['count()']), existing)).toBe('p_pt')
  })

  it('refuses when an aggregate is missing, which the server also does', () => {
    // The failure this strictness exists for: reporting "already covered" over
    // a projection that does not hold avg() means somebody changes nothing and
    // keeps paying for the scan.
    expect(coveringProjection(aggregate(['type'], ['avg(value)']), [built({})])).toBeNull()
    expect(coveringProjection(aggregate(['type'], ['count()']), [built({})])).toBe('p')
  })

  it('ignores a projection that was declared and never built', () => {
    expect(coveringProjection(aggregate(['type'], ['count()']), [built({ inert: true })])).toBeNull()
  })

  it('requires a prefix for a sort order, not merely a superset', () => {
    const normal: Existing[] = [
      built({
        name: 'p_narrow',
        kind: 'Normal',
        query: 'SELECT device_id, value ORDER BY device_id',
        sorting_key: ['device_id'],
      }),
    ]
    const sort = (key: string[], columns: string[]): Candidate => ({
      ...aggregate(key, []),
      kind: 'sort',
      columns,
    })
    expect(coveringProjection(sort(['device_id'], ['device_id', 'value']), normal)).toBe('p_narrow')
    // It holds neither `time` nor a key starting with `type`.
    expect(coveringProjection(sort(['device_id'], ['device_id', 'time']), normal)).toBeNull()
    expect(coveringProjection(sort(['type'], ['device_id']), normal)).toBeNull()
  })
})

describe('the statements', () => {
  it('writes an aggregate projection as a grouped select with no FROM', () => {
    const candidate = candidates(
      advice([pattern({ statement: 'SELECT type, count(), sum(value) FROM traffic GROUP BY type' })]),
    )[0]!
    const ddl = ddlFor(candidate, 'lab', 'traffic', [])
    expect(ddl.query).toBe('SELECT type, count(), sum(value) GROUP BY type')
    expect(ddl.declare).toContain('ALTER TABLE lab.traffic')
    expect(ddl.declare).toContain('ADD PROJECTION agg_type')
    // The mutation is a second statement, because it is a second statement:
    // ADD PROJECTION builds nothing and reports success.
    expect(ddl.materialize).toContain('MATERIALIZE PROJECTION agg_type')
  })

  it('writes a sort projection over only the columns the workload reads', () => {
    const candidate = candidates(
      advice([
        pattern({ statement: "SELECT device_id, value FROM traffic WHERE device_id = 'a'" }),
      ]),
    )[0]!
    const ddl = ddlFor(candidate, 'lab', 'traffic', [])
    expect(ddl.query).toBe('SELECT device_id, value ORDER BY device_id')
    expect(ddl.name).toBe('by_device_id')
  })

  it('quotes a column name that needs it', () => {
    const columns: AdviceColumn[] = [
      ...COLUMNS,
      { name: 'odd name', type: 'String', sorting_position: null, in_partition_key: false, compressed_bytes: null },
    ]
    const candidate = candidates(
      advice([pattern({ statement: 'SELECT value FROM traffic WHERE `odd name` = 1' })], {
        columns,
      }),
    )[0]!
    expect(ddlFor(candidate, 'lab', 'traffic', []).query).toBe(
      'SELECT `odd name`, value ORDER BY `odd name`',
    )
  })

  it('does not propose a name a projection already has', () => {
    const key = [{ column: 'type', bucket: null, expr: '`type`' }]
    expect(projectionName('aggregate', key, [])).toBe('agg_type')
    expect(projectionName('aggregate', key, ['agg_type'])).toBe('agg_type_2')
  })

  it('makes a legal identifier out of a bucketed key', () => {
    const key = [{ column: 'time', bucket: 'toStartOfHour', expr: 'toStartOfHour(`time`)' }]
    expect(projectionName('aggregate', key, [])).toBe('agg_hour_time')
  })
})

describe('the arithmetic', () => {
  const sortCandidate = (): Candidate =>
    candidates(
      advice([
        pattern({
          statement: "SELECT count(), sum(value) FROM traffic WHERE device_id = 'dev-1234'",
          runs: 5,
          read_rows: 25_000_000,
        }),
      ]),
    )[0]!

  it('floors a sort projection at one granule per part, which is what the server does', () => {
    // Measured: a filter matching 250 rows read 40,960 — five parts times a
    // granularity of 8,192 — and not 250. Promising 250 would be wrong by 164×.
    const reading = benefit(sortCandidate(), measurement())!
    expect(reading.readsNow).toBe(5_000_000)
    expect(reading.readsThen).toBe(40_960)
    expect(reading.factor).toBeCloseTo(122.07, 1)
    expect(reading.basis).toContain('whole granules')
    // The sentence has to explain the figure beside it. Here the granule floor
    // won, so it says so.
    expect(reading.basis).toContain('40,960 rows is the floor')
  })

  it('raises the floor when the matching rows exceed a granule, and says which bound won', () => {
    const reading = benefit(sortCandidate(), measurement({ max_rows_per_key: 100_000 }))!
    // Rounded up to whole granules, and above the per-part floor.
    expect(reading.readsThen).toBe(106_496)
    // Printing "the floor is 40,960" beside a figure of 106,496 reads as an
    // arithmetic error in Flint — which is how this branch was found, on the
    // dev stack's own events table.
    expect(reading.basis).toContain('those rows cost 106,496')
    expect(reading.basis).toContain('how the values are spread')
  })

  it('counts an aggregate projection rather than modelling it', () => {
    // Measured: three distinct values over five parts came out at 15 rows.
    const candidate = candidates(
      advice([
        pattern({
          statement: 'SELECT type, count() FROM traffic GROUP BY type',
          runs: 3,
          read_rows: 15_000_000,
        }),
      ]),
    ).find((c) => c.kind === 'aggregate')!
    const reading = benefit(candidate, measurement({ groups: 3, max_rows_per_key: 1_666_667 }))!
    expect(reading.readsNow).toBe(5_000_000)
    expect(reading.readsThen).toBe(15)
    expect(reading.basis).toContain('as the parts merge')
  })

  it('says nothing at all before the measurement', () => {
    expect(benefit(sortCandidate(), null)).toBeNull()
    expect(cost(sortCandidate(), null)).toBeNull()
  })

  it('averages the reads over the runs, not over the patterns', () => {
    expect(
      rowsPerRun([
        pattern({ statement: 'a', runs: 2, read_rows: 200 }),
        pattern({ statement: 'b', runs: 8, read_rows: 800 }),
      ]),
    ).toBe(100)
  })
})

describe('what is said about the cost', () => {
  it('gives a sort projection the bytes its columns hold today, and the share', () => {
    const candidate = candidates(
      advice([pattern({ statement: "SELECT value FROM traffic WHERE device_id = 'a'" })]),
    )[0]!
    expect(cost(candidate, measurement(), 24_122_801)).toContain('2.1 MiB')
    // The share is the figure that stops a bad projection: a small key can
    // still cost the whole table, because the projection holds every column the
    // queries read.
    expect(cost(candidate, measurement(), 24_122_801)).toContain('9% of what the table holds')
    expect(cost(candidate, measurement({ columns_compressed: 23_900_000 }), 24_122_801)).toContain(
      'as much as the whole table',
    )
  })

  it('drops the figure rather than dashing it where Compact parts hide it', () => {
    const candidate = candidates(
      advice([pattern({ statement: "SELECT value FROM traffic WHERE device_id = 'a'" })]),
    )[0]!
    const said = cost(candidate, measurement({ columns_compressed: null }))!
    expect(said).toContain('Compact')
    expect(said).not.toContain('—')
  })

  it('gives an aggregate projection a row count and no bytes, because bytes would be a guess', () => {
    const candidate = candidates(
      advice([pattern({ statement: 'SELECT type, count() FROM traffic GROUP BY type' })]),
    ).find((c) => c.kind === 'aggregate')!
    const said = cost(candidate, measurement({ groups: 3 }))!
    expect(said).toContain('One row per group')
    expect(said).not.toMatch(/\d+ (B|KB|MB|GB)/)
  })
})

describe('what the projection will not answer', () => {
  it('names the column count for a sort projection', () => {
    // The surprise measured twice: the same query with one extra column read
    // all 5,000,000 rows again, silently.
    const candidate = candidates(
      advice([
        pattern({ statement: "SELECT device_id, value FROM traffic WHERE device_id = 'a'" }),
      ]),
    )[0]!
    expect(limits(candidate)).toContain('2 of the table’s columns')
    expect(limits(candidate)).toContain('no error')
  })

  it('names the aggregates for an aggregate projection', () => {
    const candidate = candidates(
      advice([pattern({ statement: 'SELECT type, count() FROM traffic GROUP BY type' })]),
    ).find((c) => c.kind === 'aggregate')!
    expect(limits(candidate)).toContain('count()')
    expect(limits(candidate)).toContain('by expression, not by algebra')
  })
})

describe('aggregate detection', () => {
  it('follows ClickHouse’s combinator suffixes rather than listing them', () => {
    expect(isAggregate('sum')).toBe(true)
    expect(isAggregate('sumIf')).toBe(true)
    expect(isAggregate('uniqExactMerge')).toBe(true)
    expect(isAggregate('quantilesState')).toBe(true)
    expect(isAggregate('toStartOfHour')).toBe(false)
    expect(isAggregate('length')).toBe(false)
  })
})

describe('taking an aggregate apart for the weigher', () => {
  const known = new Set(COLUMNS.map((c) => c.name))

  it('reads a bare call, a call with an argument, and a parameterised one', () => {
    expect(decompose('count()', known)).toEqual({ name: 'count', params: [], args: [] })
    expect(decompose('sum(value)', known)).toEqual({ name: 'sum', params: [], args: ['value'] })
    // Two bracket groups: parameters first, then arguments.
    expect(decompose('quantile(0.95)(value)', known)).toEqual({
      name: 'quantile',
      params: [0.95],
      args: ['value'],
    })
    expect(decompose('argMax(value, time)', known)).toEqual({
      name: 'argMax',
      params: [],
      args: ['value', 'time'],
    })
  })

  it('answers null for anything it will not hand to a statement builder', () => {
    // An aggregate over an expression is perfectly good SQL and is not
    // something this decomposes. The figure is dropped, not guessed.
    expect(decompose('sum(value * 2)', known)).toBeNull()
    expect(decompose("countIf(type = 'error')", known)).toBeNull()
    expect(decompose('sum(no_such_column)', known)).toBeNull()
    // Not an aggregate at all.
    expect(decompose('toStartOfHour(time)', known)).toBeNull()
    expect(decompose('value', known)).toBeNull()
  })

  it('quotes nothing and passes column names through as names', () => {
    const columns: AdviceColumn[] = [
      ...COLUMNS,
      { name: 'odd name', type: 'UInt32', sorting_position: null, in_partition_key: false, compressed_bytes: null },
    ]
    expect(decompose('sum(`odd name`)', new Set(columns.map((c) => c.name)))).toEqual({
      name: 'sum',
      params: [],
      args: ['odd name'],
    })
  })

  it('refuses the whole request when one aggregate cannot be taken apart', () => {
    // All or nothing: a size measured over some of the states is not the size
    // of the projection.
    const good = candidates(
      advice([pattern({ statement: 'SELECT type, count(), sum(value) FROM traffic GROUP BY type' })]),
    ).find((c) => c.kind === 'aggregate')!
    expect(weighRequest(good, COLUMNS)).toEqual({
      keys: [{ column: 'type', bucket: null }],
      aggregates: [
        { name: 'count', params: [], args: [] },
        { name: 'sum', params: [], args: ['value'] },
      ],
    })

    const mixed = candidates(
      advice([
        pattern({ statement: 'SELECT type, count() FROM traffic GROUP BY type', hash: 'a' }),
        pattern({ statement: 'SELECT type, sum(value * 2) FROM traffic GROUP BY type', hash: 'b' }),
      ]),
    ).find((c) => c.kind === 'aggregate')!
    expect(weighRequest(mixed, COLUMNS)).toBeNull()
  })

  it('is not offered for a sort-order proposal, which has no states to weigh', () => {
    const sort = candidates(
      advice([pattern({ statement: "SELECT value FROM traffic WHERE device_id = 'a'" })]),
    )[0]!
    expect(weighRequest(sort, COLUMNS)).toBeNull()
  })
})

describe('what an aggregate projection is said to cost', () => {
  const aggregate = () =>
    candidates(
      advice([pattern({ statement: 'SELECT type, count() FROM traffic GROUP BY type' })]),
    ).find((c) => c.kind === 'aggregate')!

  it('says the bytes are not stated until they are weighed', () => {
    const said = cost(aggregate(), measurement({ groups: 3 }), 24_122_801)!
    expect(said).toContain('One row per group')
    expect(said).toContain('weighed, or it is not stated')
    expect(said).not.toMatch(/\d+ (B|KiB|MiB|GiB)/)
  })

  it('and gives them with their share once it has, per part and in total', () => {
    // The real figures from the table this was checked against: an aggregate
    // projection over three values weighed 1,995 bytes across five parts, and
    // one part of the same grouping built by the weigher measured 399.
    const said = cost(aggregate(), measurement({ groups: 3 }), 24_122_801, {
      rows: 3,
      on_disk: 399,
      uncompressed: 86,
      parts: 5,
      table_bytes: 24_122_801,
      built: 'CREATE TABLE <scratch> …',
    })!
    // A range, not a figure. Measured both ways: this key put all three of its
    // values in every part and landed exactly on the ceiling, while a key of 31
    // days came out 15% under it.
    expect(said).toContain('399 B for one part')
    expect(said).toContain('this table has 5')
    expect(said).toContain('1.9 KiB')
    expect(said).toContain('the ceiling if every part holds every group')
    // Under half a per cent is said in words: "0%" would read as free and
    // "0.008%" is more precision than the figure carries.
    expect(said).toContain('under half a per cent of the table')
  })

  it('does not talk about parts when there is only one', () => {
    const said = cost(aggregate(), measurement({ groups: 3 }), 24_122_801, {
      rows: 3,
      on_disk: 399,
      uncompressed: 86,
      parts: 1,
      table_bytes: 24_122_801,
      built: 'CREATE TABLE <scratch> …',
    })!
    expect(said).toContain('Weighed at 399 B')
    expect(said).not.toContain('per part')
  })
})

describe('projections that are already there and not earning', () => {
  const existing = (over: Partial<Existing>): Existing => ({
    name: 'p',
    kind: 'Aggregate',
    query: 'SELECT type, count() GROUP BY type',
    sorting_key: ['type'],
    parts: 5,
    rows: 15,
    bytes: 1995,
    inert: false,
    used_by: 10,
    ...over,
  })

  it('says nothing about one that is being used', () => {
    expect(standing(advice([], { existing: [existing({})] }))).toEqual([])
  })

  it('names one that was declared and never built, without consulting the log', () => {
    // A fact about the table, not a claim about the workload: it holds nothing,
    // so every query ignores it whatever the log says. The verdict stands even
    // where the log could not be read at all.
    const [found] = standing(
      advice([], { existing: [existing({ name: 'by_value', inert: true, parts: 0, rows: 0, bytes: 0, used_by: null })] }),
    )
    expect(found!.issue).toBe('inert')
    expect(found!.says).toContain('never built')
    // Nothing to lose either way, so nothing to weigh.
    expect(found!.caution).toBeNull()
    expect(found!.fixes.map((f) => f.op)).toEqual(['materialize-projection', 'drop-projection'])
  })

  it('names one that is built and unused, with the reason to think first', () => {
    const [found] = standing(
      advice([pattern({ statement: 'SELECT count() FROM traffic' })], {
        existing: [existing({ name: 'by_city', used_by: 0 })],
      }),
    )
    expect(found!.issue).toBe('unused')
    expect(found!.bytes).toBe(1995)
    expect(found!.caution).toContain('a report that runs monthly is invisible')
    expect(found!.fixes.map((f) => f.op)).toEqual(['drop-projection'])
  })

  it('never calls a projection unused when the log could not say', () => {
    // The whole reason `used_by` is nullable. A null drawn as a zero here ends
    // with somebody dropping a projection their workload depends on.
    expect(standing(advice([], { existing: [existing({ used_by: null })] }))).toEqual([])
  })

  it('nor when nothing read the table in the window at all', () => {
    // On a server that came up ten minutes ago every projection has been used
    // zero times. That is true of the log and false about the world, and it is
    // not something to offer a DROP on.
    expect(standing(advice([], { existing: [existing({ used_by: 0 })] }))).toEqual([])
    // With a workload to compare against, the same projection is a finding.
    const seen = standing(
      advice([pattern({ statement: 'SELECT count() FROM traffic' })], {
        existing: [existing({ used_by: 0 })],
      }),
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]!.issue).toBe('unused')
  })
})

describe('what the cap left out', () => {
  it('says nothing when the list is the whole workload', () => {
    const counts = tally(advice([pattern({ statement: 'SELECT count() FROM traffic', runs: 4 })]))
    expect(counts.capped).toBe(false)
    expect(counts.patterns).toBe(1)
    expect(counts.patternsTotal).toBe(1)
    expect(counts.runsTotal).toBe(4)
  })

  it('and reports both totals when it is a truncation', () => {
    // The backend hands back the costliest sixty. A page reporting those as
    // the whole workload invites somebody to conclude that nothing else asks
    // anything of this table — which is the rule this repo states in as many
    // words: a list silently truncated reads as the whole truth.
    const counts = tally(
      advice([pattern({ statement: 'SELECT count() FROM traffic', runs: 4 })], {
        shapes_total: 213,
        runs_total: 4100,
      }),
    )
    expect(counts.capped).toBe(true)
    expect(counts.patterns).toBe(1)
    expect(counts.patternsTotal).toBe(213)
    expect(counts.runs).toBe(4)
    expect(counts.runsTotal).toBe(4100)
  })

  it('falls back to what it has when the backend could not count', () => {
    const counts = tally(
      advice([pattern({ statement: 'SELECT count() FROM traffic', runs: 4 })], {
        shapes_total: null,
        runs_total: null,
      }),
    )
    expect(counts.capped).toBe(false)
    expect(counts.patternsTotal).toBe(1)
    expect(counts.runsTotal).toBe(4)
  })
})

describe('ranking a database', () => {
  function table(over: Partial<TableStanding> & { table: string }): TableStanding {
    return {
      engine: 'MergeTree',
      rows: 5_000_000,
      bytes: 24_000_000,
      parts: 5,
      sorting_key: ['project_id', 'time'],
      projections: 0,
      projection_bytes: 0,
      shapes: 4,
      runs: 40,
      total_ms: 900,
      read_rows: 200_000_000,
      samples: [],
      ...over,
    }
  }

  function report(tables: TableStanding[], over: Partial<DatabaseAdvice> = {}): DatabaseAdvice {
    return {
      database: 'lab',
      window_days: 7,
      tables,
      tables_total: tables.length,
      tables_read: tables.length,
      ...over,
    }
  }

  it('names a table whose costliest shape no key serves', () => {
    const [r] = ranked(
      report([
        table({
          table: 'traffic',
          samples: [pattern({ statement: "SELECT count() FROM traffic WHERE device_id = 'a'" })],
        }),
      ]),
    )
    expect(r!.verdict).toBe('candidate')
    expect(r!.kind).toBe('sort')
    // The sentence is about the shape, not about the table: this view reads
    // three shapes and the tab reads sixty.
    expect(r!.says).toContain('filters on device_id')
    expect(r!.share).toBe(1)
  })

  it('and one whose costliest shape the key already serves', () => {
    const [r] = ranked(
      report([
        table({
          table: 'traffic',
          samples: [pattern({ statement: 'SELECT count() FROM traffic WHERE project_id = 3' })],
        }),
      ]),
    )
    expect(r!.verdict).toBe('served')
    expect(r!.says).toContain('which the key already serves')
  })

  it('takes the log at its word when a projection already answered it', () => {
    const [r] = ranked(
      report([
        table({
          table: 'traffic',
          samples: [
            pattern({
              statement: 'SELECT type, count() FROM traffic GROUP BY type',
              projections: ['lab.traffic.p_by_type'],
            }),
          ],
        }),
      ]),
    )
    expect(r!.verdict).toBe('covered')
    expect(r!.says).toContain('p_by_type')
  })

  it('walks past a shape it cannot read to one it can', () => {
    const [r] = ranked(
      report([
        table({
          table: 'traffic',
          samples: [
            // A join, and the costliest — skipped rather than reported on.
            pattern({
              statement: 'SELECT count() FROM traffic AS t JOIN devices AS d ON d.id = t.device_id',
              tables: ['lab.traffic', 'lab.devices'],
              hash: 'join',
            }),
            pattern({
              statement: 'SELECT type, count() FROM traffic GROUP BY type',
              hash: 'agg',
            }),
          ],
        }),
      ]),
    )
    expect(r!.verdict).toBe('candidate')
    expect(r!.kind).toBe('aggregate')
  })

  it('says so plainly when it could read none of them', () => {
    const [r] = ranked(
      report([
        table({
          table: 'traffic',
          samples: [
            pattern({
              statement: 'SELECT count() FROM traffic AS t JOIN devices AS d ON d.id = t.device_id',
              tables: ['lab.traffic', 'lab.devices'],
            }),
          ],
        }),
      ]),
    )
    expect(r!.verdict).toBe('unread')
    expect(r!.kind).toBeNull()
    expect(r!.says).toContain('does not read well enough')
  })

  it('counts what the cap left out', () => {
    const counts = rankTally(
      report(
        [
          table({
            table: 'traffic',
            samples: [pattern({ statement: "SELECT count() FROM traffic WHERE device_id = 'a'" })],
          }),
        ],
        { tables_total: 31, tables_read: 12 },
      ),
    )
    expect(counts).toEqual({ listed: 1, read: 12, total: 31, candidates: 1 })
  })
})

describe('the readings that are not findings', () => {
  function table(over: Partial<TableStanding> & { table: string }): TableStanding {
    return {
      engine: 'MergeTree',
      rows: 5_000_000,
      bytes: 24_000_000,
      parts: 5,
      sorting_key: ['project_id', 'time'],
      projections: 0,
      projection_bytes: 0,
      shapes: 4,
      runs: 40,
      total_ms: 900,
      read_rows: 200_000_000,
      samples: [],
      ...over,
    }
  }
  const report = (t: TableStanding): DatabaseAdvice => ({
    database: 'lab',
    window_days: 7,
    tables: [t],
    tables_total: 1,
    tables_read: 1,
  })

  it('does not call a shape with no filter and no grouping a candidate', () => {
    // This is what produced "filters on , which is not a prefix of device_id,
    // ts" — an empty column list read straight out onto the page.
    const [r] = ranked(
      report(table({ table: 'traffic', samples: [pattern({ statement: 'SELECT count() FROM traffic' })] })),
    )
    expect(r!.verdict).toBe('unserveable')
    expect(r!.says).toContain('name no column of this table')
  })

  it('nor one that reads columns but filters on nothing', () => {
    const [r] = ranked(
      report(
        table({
          table: 'traffic',
          samples: [pattern({ statement: 'SELECT device_id, value FROM traffic LIMIT 100' })],
        }),
      ),
    )
    expect(r!.verdict).toBe('unserveable')
    expect(r!.says).toContain('filters or groups')
  })

  it('nor a table too small for a granule to matter', () => {
    // A three-row lookup reads all of itself and always will. Offering to help
    // it is not a reading, it is advice, and it is wrong — the same mistake the
    // diagnose page made and the reason both now share one floor.
    const [r] = ranked(
      report(
        table({
          table: 'cities',
          rows: 5,
          samples: [pattern({ statement: "SELECT count() FROM cities WHERE region = 'x'" })],
        }),
      ),
    )
    expect(r!.verdict).toBe('tiny')
    expect(r!.says).toContain('one gulp')

    // And one just over the floor still is.
    const [big] = ranked(
      report(
        table({
          table: 'cities',
          rows: PROJECTION_ROW_FLOOR,
          sorting_key: ['city'],
          samples: [pattern({ statement: "SELECT count() FROM cities WHERE region = 'x'" })],
        }),
      ),
    )
    expect(big!.verdict).toBe('candidate')
  })
})

describe('one noisy shape does not mask the answer', () => {
  function table(over: Partial<TableStanding> & { table: string }): TableStanding {
    return {
      engine: 'MergeTree',
      rows: 5_000_000,
      bytes: 24_000_000,
      parts: 5,
      sorting_key: ['project_id', 'time'],
      projections: 0,
      projection_bytes: 0,
      shapes: 5,
      runs: 40,
      total_ms: 900,
      read_rows: 200_000_000,
      samples: [],
      ...over,
    }
  }

  it('finds the shape that argues for a projection behind the ones that do not', () => {
    /* This is the case that made the first version useless. On a machine
       somebody develops on, a table's costliest shapes are a cross join and a
       profiling scan — and reporting on the first readable one said "nothing to
       serve" about a table the per-table advisor finds two proposals on. */
    const [r] = ranked({
      database: 'lab',
      window_days: 7,
      tables_total: 1,
      tables_read: 1,
      tables: [
        table({
          table: 'traffic',
          samples: [
            pattern({
              statement: 'SELECT count() FROM traffic AS t JOIN devices AS d ON d.id = t.device_id',
              tables: ['lab.traffic', 'lab.devices'],
              hash: 'join',
            }),
            pattern({ statement: 'SELECT uniqCombined(value) FROM traffic', hash: 'profile' }),
            pattern({ statement: "SELECT count() FROM traffic WHERE device_id = 'a'", hash: 'real' }),
          ],
        }),
      ],
    })
    expect(r!.verdict).toBe('candidate')
    expect(r!.kind).toBe('sort')
    // And it says which of the shapes it is talking about, rather than
    // implying it read the whole workload.
    expect(r!.says).toContain('costliest shapes read here')
  })
})
