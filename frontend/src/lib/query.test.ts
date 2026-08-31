import { describe, expect, it } from 'vitest'

import {
  aggsFor,
  aliasOf,
  literal,
  opsFor,
  quoteIdent,
  quoteString,
  startingSpec,
  type ColumnInfo,
  type Condition,
  type Projection,
  type QuerySpec,
  parseWindow,
  describe as describeSpec,
  cycleSpecOrder,
  dropSpecColumn,
  filterSpec,
  formStillOwns,
  type SpecEdit,
} from './query'

const columns: ColumnInfo[] = [
  { name: 'ts', type: 'DateTime64(3)' },
  { name: 'city', type: 'LowCardinality(Nullable(String))' },
  { name: 'status', type: "Enum8('ok' = 1, 'error' = 3)" },
  { name: 'temperature', type: 'Float32' },
  { name: 'latency_ms', type: 'UInt32' },
  { name: 'weird name', type: 'String' },
]

const proj = (over: Partial<Projection> & { column: string }): Projection => ({
  id: over.column,
  agg: null,
  bucket: null,
  ...over,
})

const cond = (over: Partial<Condition> & { column: string }): Condition => ({
  id: over.column,
  op: '=',
  value: '',
  value2: '',
  ...over,
})

const spec = (over: Partial<QuerySpec> = {}): QuerySpec => ({
  ...startingSpec('analytics', 'events'),
  ...over,
})

describe('quoting', () => {
  it('leaves a bare identifier alone', () => {
    expect(quoteIdent('events')).toBe('events')
    expect(quoteIdent('_x9')).toBe('_x9')
  })

  it('backticks anything else', () => {
    expect(quoteIdent('weird name')).toBe('`weird name`')
    expect(quoteIdent('9lives')).toBe('`9lives`')
  })

  it('escapes a backtick inside an identifier', () => {
    expect(quoteIdent('a`b')).toBe('`a\\`b`')
  })

  it('escapes quotes and backslashes in a string', () => {
    expect(quoteString("it's")).toBe("'it\\'s'")
    expect(quoteString('a\\b')).toBe("'a\\\\b'")
  })

  it('cannot be escaped out of by a crafted value', () => {
    const out = quoteString("' OR 1=1 --")
    expect(out).toBe("'\\' OR 1=1 --'")
    // Exactly one opening and one closing quote: the payload stays inside.
    expect(out.match(/(?<!\\)'/g)).toHaveLength(2)
  })
})

describe('literal', () => {
  it('passes a number through for a numeric column', () => {
    expect(literal('42', 'UInt32')).toBe('42')
    expect(literal('-3.5', 'Float64')).toBe('-3.5')
  })

  it('quotes a non-numeric value even on a numeric column', () => {
    expect(literal('42; DROP', 'UInt32')).toBe("'42; DROP'")
    expect(literal('1e9', 'UInt32')).toBe("'1e9'")
  })

  it('quotes numbers for a string column', () => {
    expect(literal('42', 'String')).toBe("'42'")
  })

  it('lets a recognised time expression through unquoted', () => {
    expect(literal('now()', 'DateTime')).toBe('now()')
    expect(literal('today()', 'Date')).toBe('today()')
    expect(literal('now() - INTERVAL 7 DAY', 'DateTime64(3)')).toBe('now() - INTERVAL 7 DAY')
  })

  it('normalises the interval keyword case', () => {
    expect(literal('now() - interval 1 hour', 'DateTime')).toBe('now() - INTERVAL 1 hour')
  })

  it('quotes anything that is not exactly a known time expression', () => {
    expect(literal('now() - INTERVAL 1 DAY; DROP TABLE t', 'DateTime')).toContain("'")
    expect(literal('nowish()', 'DateTime')).toBe("'nowish()'")
    expect(literal('now() + INTERVAL 1 DAY', 'DateTime')).toBe("'now() + INTERVAL 1 DAY'")
    expect(literal('2026-01-01 00:00:00', 'DateTime')).toBe("'2026-01-01 00:00:00'")
  })

  it('does not treat a time expression as special on a non-time column', () => {
    expect(literal('now()', 'String')).toBe("'now()'")
  })
})

describe('aliases', () => {
  /* The expressions these used to assert are the server's now — see
     `lib/dsl.ts`. What stays here is the naming, because the Builder's own
     labels are what the answer comes back keyed by. */
  it('names a plain dimension after its column', () => {
    expect(aliasOf(proj({ column: 'city' }))).toBe('city')
  })

  it('never names a bucket after the column it buckets', () => {
    // That would shadow the column, which is a bug this codebase has now hit
    // on both sides of the wire.
    expect(aliasOf(proj({ column: 'ts', bucket: 'hour' }))).toBe('ts_hour')
  })

  it('names counting rows after the rows', () => {
    expect(aliasOf(proj({ column: '*', agg: 'count' }))).toBe('rows')
    expect(aliasOf(proj({ column: 'latency_ms', agg: 'p95' }))).toBe('p95_latency_ms')
  })
})

describe('what is offered for a type', () => {
  it('keeps arithmetic aggregates off a string', () => {
    expect(aggsFor('String')).not.toContain('avg')
    expect(aggsFor('String')).toContain('uniq')
    expect(aggsFor('Float32')).toContain('avg')
  })

  it('offers ranges on numbers and times, contains on strings', () => {
    expect(opsFor('UInt32')).toContain('between')
    expect(opsFor('DateTime')).toContain('>=')
    expect(opsFor('String')).toContain('like')
    expect(opsFor('String')).not.toContain('between')
  })
})

describe('parseWindow', () => {
  it('reads the shorthands the form offers', () => {
    expect(parseWindow('24h')).toEqual({ n: 24, unit: 'HOUR' })
    expect(parseWindow('15m')).toEqual({ n: 15, unit: 'MINUTE' })
    expect(parseWindow('7d')).toEqual({ n: 7, unit: 'DAY' })
  })

  it('refuses what it cannot mean, so half a window is no clause at all', () => {
    expect(parseWindow('')).toBeNull()
    expect(parseWindow('24')).toBeNull()
    expect(parseWindow('0h')).toBeNull()
    expect(parseWindow('24 weeks')).toBeNull()
  })
})

describe('describe', () => {
  it('reads a bare select back plainly', () => {
    expect(describeSpec(spec(), columns)).toBe('every column of events, first 500')
  })

  it('leads with what is measured, then what it is measured by', () => {
    const sentence = describeSpec(
      spec({
        projections: [
          proj({ column: '*', agg: 'count' }),
          proj({ column: 'city' }),
          proj({ column: 'ts', bucket: 'day' }),
        ],
      }),
      columns,
    )
    expect(sentence).toBe('count of rows, by city and ts by day, first 500')
  })

  it('spells out the filters, and brackets a list so it cannot be misread', () => {
    const sentence = describeSpec(
      spec({
        conditions: [
          cond({ column: 'city', op: 'in', value: 'Berlin, Paris' }),
          cond({ column: 'ts', op: 'since', value: '24h' }),
        ],
      }),
      columns,
    )
    expect(sentence).toContain('where city is one of “Berlin, Paris” and ts in the last 24h')
  })

  it('says what the grouping keeps', () => {
    const sentence = describeSpec(
      spec({
        projections: [proj({ column: 'city' }), proj({ column: '*', agg: 'count' })],
        having: [{ id: 'h', ref: 'rows', op: '>', value: '100' }],
      }),
      columns,
    )
    expect(sentence).toContain('keeping groups where rows > 100')
  })
})

/** The edited question, where the edit was supposed to work. */
const taken = (edit: SpecEdit): QuerySpec => {
  if ('refused' in edit) throw new Error(`expected an edit, got: ${edit.refused}`)
  return edit.spec
}

describe('the grid, writing back into the form', () => {
  const built = spec({
    projections: [
      proj({ column: 'city' }),
      proj({ column: 'ts', bucket: 'hour' }),
      proj({ column: '*', agg: 'count' }),
    ],
  })

  it('cycles a header the way it cycles in SQL: up, down, off', () => {
    const up = cycleSpecOrder(built, 'city')
    expect(up.orderings).toEqual([{ id: expect.any(String), ref: 'city', desc: false }])
    const down = cycleSpecOrder(up, 'city')
    expect(down.orderings[0]!.desc).toBe(true)
    expect(cycleSpecOrder(down, 'city').orderings).toEqual([])
  })

  it('replaces the sort on a plain click and lays a second key under it on a shift-click', () => {
    const first = cycleSpecOrder(built, 'city')
    expect(cycleSpecOrder(first, 'rows').orderings.map((o) => o.ref)).toEqual(['rows'])
    expect(cycleSpecOrder(first, 'rows', true).orderings.map((o) => o.ref)).toEqual([
      'city',
      'rows',
    ])
  })

  it('sends a filter on a dimension to the rows and one on a total to the groups', () => {
    const rows = filterSpec(built, 'city', '=', 'Berlin')
    expect(rows).toEqual({
      spec: expect.objectContaining({
        conditions: [{ id: expect.any(String), column: 'city', op: '=', value: 'Berlin', value2: '' }],
      }),
    })

    // The same click on a computed column cannot mean the same thing: the total
    // does not exist until after the grouping.
    const groups = filterSpec(built, 'rows', '>', '100')
    expect('spec' in groups && groups.spec.having).toEqual([
      { id: expect.any(String), ref: 'rows', op: '>', value: '100' },
    ])
    expect('spec' in groups && groups.spec.conditions).toEqual([])
  })

  it('refuses a filter it cannot say, and names the column it would filter instead', () => {
    // `ts_hour` is a fold of `ts`; the filter would run before the fold.
    const refused = filterSpec(built, 'ts_hour', '=', '2026-01-01 10:00:00')
    expect('refused' in refused && refused.refused).toContain('ts')
    expect('refused' in refused && refused.refused).toContain('before the folding')

    // A total can only be compared. `contains` is not a comparison.
    const wrong = filterSpec(built, 'rows', 'like', 'x')
    expect('refused' in wrong).toBe(true)
  })

  it('takes the sort and the group filter with the column they were about', () => {
    const sorted = cycleSpecOrder(taken(filterSpec(built, 'rows', '>', '10')), 'rows')
    const dropped = dropSpecColumn(sorted, 'rows')
    expect('spec' in dropped && dropped.spec.projections.map((p) => p.column)).toEqual(['city', 'ts'])
    expect('spec' in dropped && dropped.spec.orderings).toEqual([])
    expect('spec' in dropped && dropped.spec.having).toEqual([])
  })

  it('keeps the last column: a SELECT with nothing in it is not a narrower question', () => {
    const one = spec({ projections: [proj({ column: 'city' })] })
    expect('refused' in dropSpecColumn(one, 'city')).toBe(true)
  })
})

describe('whether the form still owns the statement', () => {
  it('says yes to its own statement, whitespace aside', () => {
    // The statement makes a round trip through an editor; a trailing newline is
    // not somebody taking the query over.
    expect(formStillOwns('SELECT 1', 'SELECT 1')).toBe(true)
    expect(formStillOwns('SELECT 1\n', 'SELECT 1')).toBe(true)
  })

  it('says no to one character of somebody else', () => {
    expect(formStillOwns('SELECT 2', 'SELECT 1')).toBe(false)
  })

  it('says no when there was never a form', () => {
    expect(formStillOwns('SELECT 1', null)).toBe(false)
  })
})
