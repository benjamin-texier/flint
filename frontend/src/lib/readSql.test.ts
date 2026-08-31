import { describe, expect, it } from 'vitest'

import { readSpec, type Reading } from './readSql'
import { startingSpec, type QuerySpec } from './query'

/** Ids are minted per piece and mean nothing to a reader, so assertions are
 *  written against everything else. */
function bare(reading: Reading) {
  if ('unread' in reading) throw new Error(`unread: ${reading.unread}`)
  const { spec, dropped } = reading
  return {
    ...spec,
    projections: spec.projections.map(({ id: _id, ...p }) => p),
    conditions: spec.conditions.map(({ id: _id, ...c }) => c),
    having: spec.having.map(({ id: _id, ...h }) => h),
    orderings: spec.orderings.map(({ id: _id, ...o }) => o),
    dropped,
  }
}

function read(sql: string, options?: Parameters<typeof readSpec>[1]) {
  return bare(readSpec(sql, options))
}

describe('what the form can hold whole', () => {
  it('reads the statement the explorer opens a table with', () => {
    const spec = read('SELECT\n  *\nFROM default.raw_parking_spot_data\nLIMIT 100')
    expect(spec.database).toBe('default')
    expect(spec.table).toBe('raw_parking_spot_data')
    expect(spec.projections).toEqual([])
    expect(spec.limit).toBe(100)
    expect(spec.dropped).toEqual([])
  })

  it('takes the tab database when the statement names none', () => {
    const spec = read('SELECT * FROM hits', { database: 'web' })
    expect(spec.database).toBe('web')
    expect(spec.table).toBe('hits')
  })

  it('reads columns, aggregates and buckets', () => {
    const spec = read(
      "SELECT toStartOfDay(ts) AS ts_day, city, count() AS rows, avg(ms) AS avg_ms, quantile(0.95)(ms) AS p95_ms FROM web.hits GROUP BY toStartOfDay(ts), city",
    )
    expect(spec.projections).toEqual([
      { column: 'ts', agg: null, bucket: 'day' },
      { column: 'city', agg: null, bucket: null },
      { column: '*', agg: 'count', bucket: null },
      { column: 'ms', agg: 'avg', bucket: null },
      { column: 'ms', agg: 'p95', bucket: null },
    ])
    expect(spec.dropped).toEqual([])
  })

  it('reads every filter shape the form writes', () => {
    const spec = read(
      "SELECT * FROM web.hits WHERE `city` = 'Oslo' AND status != 200 AND path LIKE '%admin%' " +
        "AND method IN ('GET', 'POST') AND referrer IS NULL AND ms BETWEEN 10 AND 20 " +
        'AND ts >= now() - INTERVAL 24 HOUR',
    )
    expect(spec.conditions).toEqual([
      { column: 'city', op: '=', value: 'Oslo', value2: '' },
      { column: 'status', op: '!=', value: '200', value2: '' },
      { column: 'path', op: 'like', value: 'admin', value2: '' },
      { column: 'method', op: 'in', value: 'GET, POST', value2: '' },
      { column: 'referrer', op: 'isNull', value: '', value2: '' },
      { column: 'ms', op: 'between', value: '10', value2: '20' },
      { column: 'ts', op: 'since', value: '24h', value2: '' },
    ])
    expect(spec.dropped).toEqual([])
  })

  it('reads HAVING, ORDER BY and LIMIT', () => {
    const spec = read(
      'SELECT city, count() AS rows FROM web.hits GROUP BY city HAVING rows >= 10 ORDER BY rows DESC, city LIMIT 40',
    )
    expect(spec.having).toEqual([{ ref: 'rows', op: '>=', value: '10' }])
    expect(spec.orderings).toEqual([
      { ref: 'rows', desc: true },
      { ref: 'city', desc: false },
    ])
    expect(spec.limit).toBe(40)
    expect(spec.dropped).toEqual([])
  })

  it('reads an order by an aggregate expression back to the name the form uses', () => {
    // The generated statement orders by `count()`, never by the alias it put on
    // it — matching plain columns only dropped the sort off every aggregate.
    const spec = read(
      'SELECT toStartOfHour(ts) AS ts_hour, count() AS rows FROM web.hits ' +
        'GROUP BY toStartOfHour(ts) ORDER BY count() DESC, toStartOfHour(ts)',
    )
    expect(spec.orderings).toEqual([
      { ref: 'rows', desc: true },
      { ref: 'ts_hour', desc: false },
    ])
    expect(spec.dropped).toEqual([])
  })

  it('reads a rolling window as one window, not a window and a filter', () => {
    // Both halves, exactly as the server renders them: half-open, so the
    // boundary row is counted once.
    const spec = read(
      "SELECT * FROM web.hits WHERE `ts` >= now() - INTERVAL 7 DAY AND `ts` < now()",
    )
    expect(spec.conditions).toEqual([{ column: 'ts', op: 'since', value: '7d', value2: '' }])
    expect(spec.dropped).toEqual([])
  })

  it('keeps a `< now()` that is nobody window', () => {
    const spec = read('SELECT * FROM web.hits WHERE `ts` < now()')
    expect(spec.conditions).toEqual([{ column: 'ts', op: '<', value: 'now()', value2: '' }])
  })

  it('reads the zone out of the settings the generated statement carries', () => {
    const spec = read(
      "SELECT * FROM web.hits WHERE `ts` >= now() - INTERVAL 1 DAY\nSETTINGS session_timezone = 'Europe/Oslo'",
    )
    expect(spec.timezone).toBe('Europe/Oslo')
    expect(spec.dropped).toEqual([])
  })

  it('still drops the settings when they say more than the zone', () => {
    const spec = read("SELECT * FROM t SETTINGS session_timezone = 'UTC', max_threads = 1")
    expect(spec.timezone).toBe('UTC')
    expect(spec.dropped[0]).toMatch(/SETTINGS/)
  })

  it('sees through the wrapper the server generates', () => {
    const spec = read(
      'SELECT *\nFROM (\nSELECT * FROM `default`.`raw_parking_spot_data`\n)\nLIMIT 501',
    )
    expect(spec.table).toBe('raw_parking_spot_data')
    expect(spec.database).toBe('default')
    // The probe row is not part of the question, so it is not in the box.
    expect(spec.limit).toBe(500)
    expect(spec.dropped).toEqual([])
  })

  it('leaves a limit alone on a statement that is not a generated wrapper', () => {
    expect(read('SELECT * FROM db.t LIMIT 501').limit).toBe(501)
    // A wrapper, but over a question rather than over a bare table read.
    expect(read('SELECT * FROM (SELECT a FROM db.t WHERE a > 1) LIMIT 501').limit).toBe(501)
  })

  it('keeps the page the form asked for rather than the extra row', () => {
    const prior: QuerySpec = { ...startingSpec('default', 't'), limit: 500 }
    const spec = read('SELECT * FROM (SELECT * FROM default.t) LIMIT 501', { prior })
    expect(spec.limit).toBe(500)
  })
})

describe('what it will not read at all', () => {
  const unread = (sql: string) => {
    const reading = readSpec(sql)
    if (!('unread' in reading)) throw new Error('expected a refusal')
    return reading.unread
  }

  it('refuses anything that is not a SELECT', () => {
    expect(unread('INSERT INTO t VALUES (1)')).toMatch(/not a SELECT/)
  })

  it('refuses a set operator', () => {
    expect(unread('SELECT a FROM t UNION ALL SELECT a FROM u')).toMatch(/set operator/)
  })

  it('refuses a join, because half a question is not a question', () => {
    expect(unread('SELECT * FROM a JOIN b ON a.id = b.id')).toMatch(/one table/)
  })

  it('refuses a table function', () => {
    expect(unread('SELECT * FROM numbers(10)')).toMatch(/one table/)
  })
})

describe('what it drops, and says it dropped', () => {
  it('names an expression it cannot say', () => {
    const spec = read('SELECT city, multiIf(a, 1, 2) AS bucketed FROM web.hits')
    expect(spec.projections).toEqual([{ column: 'city', agg: null, bucket: null }])
    expect(spec.dropped).toEqual([
      '`multiIf(a, 1, 2)` is not something the form can say — that column is gone.',
    ])
  })

  it('drops a filter with an OR in it, whole', () => {
    const spec = read("SELECT * FROM t WHERE a = 1 OR b = 2")
    expect(spec.conditions).toEqual([])
    expect(spec.dropped).toEqual([
      'The filter `a = 1 OR b = 2` is not a comparison the form can hold — it is gone.',
    ])
  })

  it('says an exact distinct count came back as an estimate', () => {
    const spec = read('SELECT uniqExact(user) AS users FROM t')
    expect(spec.projections).toEqual([{ column: 'user', agg: 'uniq', bucket: null }])
    expect(spec.dropped[0]).toMatch(/approximate/)
  })

  it('says DISTINCT is gone', () => {
    const spec = read('SELECT DISTINCT city FROM t')
    expect(spec.projections).toEqual([{ column: 'city', agg: null, bucket: null }])
    expect(spec.dropped[0]).toMatch(/DISTINCT is dropped/)
  })

  it('says a WITH, a SETTINGS and a FORMAT are gone', () => {
    const spec = read("WITH 1 AS one SELECT one, city FROM t SETTINGS max_threads = 1 FORMAT JSON")
    expect(spec.dropped.filter((d) => /WITH|SETTINGS|FORMAT/.test(d))).toHaveLength(3)
  })

  it('says an offset is gone', () => {
    expect(read('SELECT * FROM t LIMIT 10 OFFSET 20').dropped[0]).toMatch(/OFFSET 20/)
    expect(read('SELECT * FROM t LIMIT 20, 10').dropped[0]).toMatch(/offset/)
  })

  it('says a LIMIT BY is gone and leaves the limit alone', () => {
    const spec = read('SELECT * FROM t LIMIT 1 BY host')
    expect(spec.limit).toBe(startingSpec('', '').limit)
    expect(spec.dropped[0]).toMatch(/per group/)
  })

  it('says a grouping the form will not reproduce is gone', () => {
    const spec = read('SELECT count() AS rows FROM t GROUP BY city')
    expect(spec.dropped[0]).toMatch(/grouping by `city`/)
  })

  it('warns when the form is about to add a grouping the statement did not have', () => {
    const spec = read('SELECT city, count() AS rows FROM t')
    expect(spec.dropped[0]).toMatch(/aggregates without grouping/)
  })

  it('says an order by an expression is gone', () => {
    const spec = read('SELECT * FROM t ORDER BY length(city) DESC')
    expect(spec.orderings).toEqual([])
    expect(spec.dropped[0]).toMatch(/not a plain column/)
  })

  it('reads a PREWHERE as a filter, and says so', () => {
    const spec = read("SELECT * FROM t PREWHERE day = '2026-01-01'")
    expect(spec.conditions).toEqual([{ column: 'day', op: '=', value: '2026-01-01', value2: '' }])
    expect(spec.dropped[0]).toMatch(/PREWHERE/)
  })
})

describe('values the server bound rather than wrote', () => {
  const SQL = 'SELECT * FROM (SELECT * FROM default.t) WHERE `city` = {p0:String} LIMIT 501'

  it('recovers them from the form that generated the statement', () => {
    const prior: QuerySpec = {
      ...startingSpec('default', 't'),
      conditions: [{ id: 'a', column: 'city', op: '=', value: 'Oslo', value2: '' }],
    }
    const spec = read(SQL, { prior })
    expect(spec.conditions).toEqual([{ column: 'city', op: '=', value: 'Oslo', value2: '' }])
    expect(spec.dropped).toEqual([])
  })

  it('drops them, by name, when there is no such form', () => {
    const spec = read(SQL)
    expect(spec.conditions).toEqual([])
    expect(spec.dropped[0]).toMatch(/`city`/)
    expect(spec.dropped[0]).toMatch(/bound/)
  })
})
