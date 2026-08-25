import { describe, expect, it } from 'vitest'

import { formatDdl, tokenize } from './ddl'

/** Invented schemas, shaped like the real thing: a generated column list, a
 *  join with aliases, a UNION ALL, and the settings ClickHouse staples on. */
const VIEW = `CREATE VIEW shop.order_totals (\`order_id\` Int64, \`placed_at\` DateTime, \`local_placed_at\` DateTime, \`total\` Nullable(Float32), \`currency\` LowCardinality(String), \`customer_name\` Nullable(String)) AS SELECT o.order_id AS order_id, o.placed_at AS placed_at, toDateTime(o.placed_at, getSetting('session_timezone')) AS local_placed_at, o.total AS total, o.currency AS currency, c.name AS customer_name FROM shop.orders AS o INNER JOIN shop.customers AS c ON o.customer_id = c.customer_id SETTINGS enable_dynamic_type = 1, enable_json_type = 1, mongodb_throw_on_unsupported_query = 0`

const MATVIEW = `CREATE MATERIALIZED VIEW shop.daily_sales REFRESH EVERY 10 MINUTE (\`day\` Date, \`channel\` String, \`revenue\` Float64) ENGINE = MergeTree ORDER BY (assumeNotNull(day), assumeNotNull(channel)) SETTINGS index_granularity = 8192 DEFINER = etl SQL SECURITY DEFINER AS SELECT toDate(placed_at) AS day, channel, sum(total) AS revenue FROM shop.orders WHERE isNotNull(total) GROUP BY day, channel UNION ALL SELECT toDate(returned_at) AS day, 'returns' AS channel, sum(total) AS revenue FROM shop.returns WHERE (returned_at > (now() - toIntervalDay(90))) GROUP BY day`

const TABLE = `CREATE TABLE shop.orders (\`order_id\` Int64, \`customer_id\` LowCardinality(String), \`placed_at\` DateTime) ENGINE = ReplacingMergeTree ORDER BY (assumeNotNull(customer_id), assumeNotNull(placed_at)) PARTITION BY assumeNotNull(toYYYYMM(placed_at)) SETTINGS index_granularity = 8192`

/** The invariant: formatting may rewrite the whitespace between tokens, and
 *  nothing else. Comparing the token streams says that precisely — collapsing
 *  whitespace would not, since a break after `(` legitimately introduces a
 *  space where the input had none. */
const shape = (sql: string) =>
  tokenize(sql)
    .filter((t) => t.kind !== 'space')
    .map((t) => `${t.kind}:${t.text}`)

describe('tokenize', () => {
  it('loses nothing', () => {
    for (const sql of [VIEW, MATVIEW, TABLE]) {
      expect(tokenize(sql).map((t) => t.text).join('')).toBe(sql)
    }
  })

  it('tells a type from a keyword from a name', () => {
    const kinds = new Map(tokenize('SELECT toUInt8(x) FROM t').map((t) => [t.text, t.kind]))
    expect(kinds.get('SELECT')).toBe('keyword')
    expect(kinds.get('FROM')).toBe('keyword')
    expect(kinds.get('toUInt8')).toBe('function')
    expect(kinds.get('t')).toBe('name')
  })

  it('reads Nullable(Float32) as two types', () => {
    const types = tokenize('`x` Nullable(Float32)').filter((t) => t.kind === 'type')
    expect(types.map((t) => t.text)).toEqual(['Nullable', 'Float32'])
  })

  it('does not mistake a quoted identifier for the keywords inside it', () => {
    const tokens = tokenize('SELECT `order by` FROM t')
    const quoted = tokens.find((t) => t.text.includes('order'))
    expect(quoted?.kind).toBe('quoted')
    expect(quoted?.text).toBe('`order by`')
  })

  it('does not mistake a string literal for SQL', () => {
    const tokens = tokenize("SELECT 'FROM x' AS s")
    expect(tokens.filter((t) => t.kind === 'string').map((t) => t.text)).toEqual(["'FROM x'"])
    expect(tokens.filter((t) => t.kind === 'keyword').map((t) => t.text)).toEqual(['SELECT', 'AS'])
  })

  it('handles a doubled quote inside a literal', () => {
    expect(tokenize("'it''s'").map((t) => t.text)).toEqual(["'it''s'"])
  })

  it('records where each token came from', () => {
    const sql = 'SELECT a FROM t'
    for (const token of tokenize(sql)) {
      expect(sql.slice(token.at, token.at + token.text.length)).toBe(token.text)
    }
  })

  it('keeps a comment whole', () => {
    const tokens = tokenize('SELECT 1 -- FROM nowhere\nFROM t')
    expect(tokens.filter((t) => t.kind === 'comment').map((t) => t.text)).toEqual([
      '-- FROM nowhere',
    ])
  })
})

describe('formatDdl', () => {
  it('changes nothing but whitespace', () => {
    for (const sql of [VIEW, MATVIEW, TABLE]) {
      expect(shape(formatDdl(sql))).toEqual(shape(sql))
    }
  })

  it('puts one column per line in the CREATE list', () => {
    const lines = formatDdl(TABLE).split('\n')
    expect(lines[0]).toBe('CREATE TABLE shop.orders (')
    expect(lines[1]).toBe('    `order_id` Int64,')
    expect(lines[2]).toBe('    `customer_id` LowCardinality(String),')
    expect(lines[3]).toBe('    `placed_at` DateTime')
    expect(lines[4]).toBe(')')
  })

  it('gives every clause its own line', () => {
    const lines = formatDdl(TABLE).split('\n')
    expect(lines).toContain('ENGINE = ReplacingMergeTree')
    expect(lines).toContain('ORDER BY (assumeNotNull(customer_id), assumeNotNull(placed_at))')
    expect(lines).toContain('PARTITION BY assumeNotNull(toYYYYMM(placed_at))')
  })

  it('puts one selected expression per line, and one setting', () => {
    const lines = formatDdl(VIEW).split('\n')
    expect(lines).toContain('AS SELECT')
    expect(lines).toContain('    o.order_id AS order_id,')
    expect(lines).toContain(
      "    toDateTime(o.placed_at, getSetting('session_timezone')) AS local_placed_at,",
    )
    expect(lines).toContain('FROM shop.orders AS o')
    // A join condition earns its own line, as it does in the editor: it is the
    // part of a join anyone actually reads.
    expect(lines).toContain('INNER JOIN shop.customers AS c')
    expect(lines).toContain('ON o.customer_id = c.customer_id')
    expect(lines).toContain('SETTINGS')
    expect(lines).toContain('    enable_dynamic_type = 1,')
  })

  it('does not break the AS of an alias', () => {
    for (const line of formatDdl(VIEW).split('\n')) {
      expect(line).not.toBe('AS')
    }
  })

  it('does not break inside a function call argument list', () => {
    expect(formatDdl(TABLE)).toContain('(assumeNotNull(customer_id), assumeNotNull(placed_at))')
  })

  it('breaks a UNION ALL onto its own line', () => {
    expect(formatDdl(MATVIEW).split('\n')).toContain('UNION ALL')
  })

  it('leaves a clause keyword that is only a column name alone', () => {
    const sql = 'CREATE TABLE t (`order by` String, `from` Int8) ENGINE = Memory'
    const lines = formatDdl(sql).split('\n')
    expect(lines[1]).toBe('    `order by` String,')
    expect(lines[2]).toBe('    `from` Int8')
    expect(shape(formatDdl(sql))).toEqual(shape(sql))
  })

  it('treats a DDL clause word in a select list as the column name it is', () => {
    // `comment`, `engine` and `ttl` are ordinary column names in `system.tables`
    // and elsewhere. Reading one as a clause used to cost every line after it
    // its layout.
    const sql =
      'SELECT name AS name, comment AS note, engine AS engine, ttl AS ttl FROM system.tables'
    expect(formatDdl(sql).split('\n')).toEqual([
      'SELECT',
      '    name AS name,',
      '    comment AS note,',
      '    engine AS engine,',
      '    ttl AS ttl',
      'FROM system.tables',
    ])
  })

  it('still reads the DDL clauses that come before the select', () => {
    const sql =
      "CREATE MATERIALIZED VIEW shop.m (`a` Int8) ENGINE = MergeTree ORDER BY a COMMENT 'why' AS SELECT comment AS a FROM shop.orders"
    const lines = formatDdl(sql).split('\n')
    expect(lines).toContain('ENGINE = MergeTree')
    expect(lines).toContain("COMMENT 'why'")
    expect(lines).toContain('AS SELECT')
    expect(lines).toContain('    comment AS a')
  })

  it('does not treat ON CLUSTER as a join condition', () => {
    const sql = 'CREATE TABLE t ON CLUSTER c (`a` Int8) ENGINE = Memory'
    expect(formatDdl(sql).split('\n')[0]).toBe('CREATE TABLE t ON CLUSTER c (')
  })

  it('formats a bare SELECT, which is what a view definition is', () => {
    const lines = formatDdl('SELECT a, b FROM t WHERE a > 1').split('\n')
    expect(lines).toEqual(['SELECT', '    a,', '    b', 'FROM t', 'WHERE a > 1'])
  })

  it('survives something it does not understand', () => {
    const junk = 'GIBBERISH ((( `unclosed'
    expect(shape(formatDdl(junk))).toEqual(shape(junk))
  })

  it('leaves the case the author wrote alone', () => {
    // The regex formatter this replaced upper-cased only the clauses it happened
    // to break on, so `select a from t` came back as `select a` / `FROM t` —
    // casing the tool introduced, inconsistent with itself.
    expect(formatDdl('select a, b from t where c = 1').split('\n')).toEqual([
      'select',
      '    a,',
      '    b',
      'from t',
      'where c = 1',
    ])
  })

  it('keeps a multi-word clause together', () => {
    expect(formatDdl('SELECT a FROM t GROUP BY a HAVING count() > 1').split('\n')).toEqual([
      'SELECT',
      '    a',
      'FROM t',
      'GROUP BY a',
      'HAVING count() > 1',
    ])
  })

  it('is idempotent', () => {
    for (const sql of [VIEW, MATVIEW, TABLE]) {
      expect(formatDdl(formatDdl(sql))).toBe(formatDdl(sql))
    }
  })
})
