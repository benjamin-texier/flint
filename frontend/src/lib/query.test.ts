import { describe, expect, it } from 'vitest'

import {
  aggsFor,
  aliasOf,
  expressionOf,
  literal,
  opsFor,
  quoteIdent,
  quoteString,
  startingSpec,
  toSql,
  type ColumnInfo,
  type Condition,
  type Projection,
  type QuerySpec,
  parseWindow,
  describe as describeSpec,
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

describe('expressions and aliases', () => {
  it('renders a plain dimension as itself', () => {
    expect(expressionOf(proj({ column: 'city' }))).toBe('city')
    expect(aliasOf(proj({ column: 'city' }))).toBe('city')
  })

  it('buckets a time column', () => {
    const p = proj({ column: 'ts', bucket: 'hour' })
    expect(expressionOf(p)).toBe('toStartOfHour(ts)')
    // Never aliased back to `ts`: that would shadow the column.
    expect(aliasOf(p)).toBe('ts_hour')
  })

  it('renders each aggregate the ClickHouse way', () => {
    expect(expressionOf(proj({ column: 'temperature', agg: 'avg' }))).toBe('avg(temperature)')
    expect(expressionOf(proj({ column: 'city', agg: 'uniq' }))).toBe('uniq(city)')
    expect(expressionOf(proj({ column: 'latency_ms', agg: 'p95' }))).toBe(
      'quantile(0.95)(latency_ms)',
    )
    expect(expressionOf(proj({ column: 'latency_ms', agg: 'median' }))).toBe('median(latency_ms)')
    expect(expressionOf(proj({ column: '*', agg: 'count' }))).toBe('count()')
    expect(aliasOf(proj({ column: '*', agg: 'count' }))).toBe('rows')
  })

  it('backticks an odd column name inside an expression', () => {
    expect(expressionOf(proj({ column: 'weird name', agg: 'max' }))).toBe('max(`weird name`)')
  })
})

describe('toSql', () => {
  it('turns a window into an interval measured from now, not a literal', () => {
    const sql = toSql(spec({ conditions: [cond({ column: 'ts', op: 'since', value: '24h' })] }), columns)
    expect(sql).toContain('WHERE ts >= now() - INTERVAL 24 HOUR')
  })

  it('drops a window it cannot read rather than guessing one', () => {
    const sql = toSql(spec({ conditions: [cond({ column: 'ts', op: 'since', value: '24' })] }), columns)
    expect(sql).not.toContain('WHERE')
  })

  it('filters an aggregate with HAVING, by the alias it selected', () => {
    const sql = toSql(
      spec({
        projections: [proj({ column: 'city' }), proj({ column: '*', agg: 'count' })],
        having: [{ id: 'h', ref: 'rows', op: '>', value: '100' }],
      }),
      columns,
    )
    expect(sql).toContain('GROUP BY city')
    expect(sql).toContain('HAVING rows > 100')
  })

  it('ignores a HAVING on something the query does not compute', () => {
    const sql = toSql(
      spec({
        projections: [proj({ column: 'city' })],
        having: [{ id: 'h', ref: 'rows', op: '>', value: '100' }],
      }),
      columns,
    )
    expect(sql).not.toContain('HAVING')
  })

  it('selects everything when nothing is chosen', () => {
    expect(toSql(spec(), columns)).toBe('SELECT *\nFROM analytics.events\nLIMIT 500')
  })

  it('emits no GROUP BY without an aggregate', () => {
    const sql = toSql(spec({ projections: [proj({ column: 'city' }), proj({ column: 'ts' })] }), columns)
    expect(sql).not.toContain('GROUP BY')
  })

  it('groups by the dimensions as soon as an aggregate appears', () => {
    const sql = toSql(
      spec({
        projections: [
          proj({ column: 'ts', bucket: 'hour' }),
          proj({ column: 'city' }),
          proj({ column: 'temperature', agg: 'avg' }),
        ],
      }),
      columns,
    )
    expect(sql).toContain('SELECT toStartOfHour(ts) AS ts_hour, city, avg(temperature) AS avg_temperature')
    // Grouped by the expression, not the alias.
    expect(sql).toContain('GROUP BY toStartOfHour(ts), city')
  })

  it('emits no GROUP BY when everything is aggregated', () => {
    const sql = toSql(spec({ projections: [proj({ column: '*', agg: 'count' })] }), columns)
    expect(sql).toContain('SELECT count() AS rows')
    expect(sql).not.toContain('GROUP BY')
  })

  it('joins conditions with AND', () => {
    const sql = toSql(
      spec({
        conditions: [
          cond({ column: 'status', op: '!=', value: 'ok' }),
          cond({ column: 'latency_ms', op: '>', value: '100' }),
        ],
      }),
      columns,
    )
    expect(sql).toContain("WHERE status != 'ok' AND latency_ms > 100")
  })

  it('renders each operator', () => {
    const one = (c: Partial<Condition> & { column: string }) =>
      toSql(spec({ conditions: [cond(c)] }), columns).split('\n').find((l) => l.startsWith('WHERE'))
    expect(one({ column: 'city', op: 'isNull' })).toBe('WHERE city IS NULL')
    expect(one({ column: 'city', op: 'isNotNull' })).toBe('WHERE city IS NOT NULL')
    expect(one({ column: 'city', op: 'like', value: 'Lyo' })).toBe("WHERE city LIKE '%Lyo%'")
    expect(one({ column: 'city', op: 'notLike', value: 'Lyo' })).toBe("WHERE city NOT LIKE '%Lyo%'")
    expect(one({ column: 'city', op: 'in', value: 'Lyon, Paris' })).toBe(
      "WHERE city IN ('Lyon', 'Paris')",
    )
    expect(one({ column: 'latency_ms', op: 'between', value: '10', value2: '20' })).toBe(
      'WHERE latency_ms BETWEEN 10 AND 20',
    )
  })

  it("keeps an author's own wildcards in a contains filter", () => {
    const sql = toSql(spec({ conditions: [cond({ column: 'city', op: 'like', value: 'Lyo%' })] }), columns)
    expect(sql).toContain("LIKE 'Lyo%'")
  })

  it('drops a condition with nothing filled in', () => {
    const sql = toSql(spec({ conditions: [cond({ column: 'city', op: '=', value: '  ' })] }), columns)
    expect(sql).not.toContain('WHERE')
  })

  it('drops an incomplete between', () => {
    const sql = toSql(
      spec({ conditions: [cond({ column: 'latency_ms', op: 'between', value: '10', value2: '' })] }),
      columns,
    )
    expect(sql).not.toContain('WHERE')
  })

  it('orders by an alias, and only a real one', () => {
    const sql = toSql(
      spec({
        projections: [proj({ column: 'temperature', agg: 'avg' })],
        orderings: [
          { id: '1', ref: 'avg_temperature', desc: true },
          { id: '2', ref: 'nonexistent', desc: false },
        ],
      }),
      columns,
    )
    expect(sql).toContain('ORDER BY avg_temperature DESC')
    expect(sql).not.toContain('nonexistent')
  })

  it('omits LIMIT when it is zero', () => {
    expect(toSql(spec({ limit: 0 }), columns)).not.toContain('LIMIT')
  })

  it('ignores columns the table no longer has', () => {
    const sql = toSql(
      spec({
        projections: [proj({ column: 'city' }), proj({ column: 'dropped_column' })],
        conditions: [cond({ column: 'also_gone', op: '=', value: 'x' })],
      }),
      columns,
    )
    expect(sql).toContain('SELECT city')
    expect(sql).not.toContain('dropped_column')
    expect(sql).not.toContain('also_gone')
  })

  it('backticks an odd table or database name', () => {
    const sql = toSql({ ...spec(), database: 'my db', table: 'odd table' }, columns)
    expect(sql).toContain('FROM `my db`.`odd table`')
  })

  it('produces one clause per line', () => {
    const sql = toSql(
      spec({
        projections: [proj({ column: 'city' }), proj({ column: '*', agg: 'count' })],
        conditions: [cond({ column: 'city', op: 'isNotNull' })],
        orderings: [{ id: '1', ref: 'rows', desc: true }],
      }),
      columns,
    )
    expect(sql.split('\n').map((l) => l.split(' ')[0])).toEqual([
      'SELECT',
      'FROM',
      'WHERE',
      'GROUP',
      'ORDER',
      'LIMIT',
    ])
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
