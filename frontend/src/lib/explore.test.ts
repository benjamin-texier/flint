import { describe, expect, it } from 'vitest'
import {
  costOf,
  exploreSql,
  leads,
  startingFilter,
  startingSpec,
  timeColumns,
  type ExploreSpec,
} from './explore'
import type { ColumnInfo, Condition } from './query'

const columns: ColumnInfo[] = [
  { name: 'ts', type: 'DateTime64(3)' },
  { name: 'city', type: 'LowCardinality(Nullable(String))' },
  { name: 'latency_ms', type: 'UInt32' },
  { name: 'seen_on', type: 'Nullable(Date)' },
  { name: 'payload', type: 'String' },
]

const spec = (over: Partial<ExploreSpec> = {}): ExploreSpec => ({
  database: 'analytics',
  table: 'events',
  columns: [],
  filters: [],
  order: 'natural',
  timeColumn: 'ts',
  limit: 200,
  ...over,
})

const filter = (over: Partial<Condition> = {}): Condition => ({
  id: 'f1',
  column: 'city',
  op: 'like',
  value: 'Oslo',
  value2: '',
  ...over,
})

describe('timeColumns', () => {
  it('finds dates and datetimes however they are wrapped', () => {
    expect(timeColumns(columns)).toEqual(['ts', 'seen_on'])
  })
})

describe('leads', () => {
  it('is true only in first position', () => {
    // Second place does not make a range read cheap, so it does not count.
    expect(leads('ts, city', 'ts')).toBe(true)
    expect(leads('city, ts', 'ts')).toBe(false)
    expect(leads('(ts, city)', 'ts')).toBe(true)
    expect(leads('`ts`', 'ts')).toBe(true)
    expect(leads('', 'ts')).toBe(false)
  })
})

describe('startingSpec', () => {
  it('opens on the newest rows when that is cheap', () => {
    const s = startingSpec('analytics', 'events', columns, 'ts, city')
    expect(s.order).toBe('latest')
    expect(s.timeColumn).toBe('ts')
  })

  it('does not spend a full scan on somebody’s behalf', () => {
    // The table has a time column, but it is not what the table is sorted by:
    // opening on "newest" would read all of it before showing anything.
    const s = startingSpec('analytics', 'events', columns, 'device_id, ts')
    expect(s.order).toBe('natural')
    // Still offered as the column to order by, once somebody asks for it.
    expect(s.timeColumn).toBe('ts')
  })

  it('prefers a time column that leads the sorting key, so the default is cheap', () => {
    const s = startingSpec('analytics', 'events', columns, 'seen_on, city')
    expect(s.timeColumn).toBe('seen_on')
  })

  it('falls back to stored order with no time column at all', () => {
    const s = startingSpec('a', 'b', [{ name: 'id', type: 'UInt64' }], 'id')
    expect(s.order).toBe('natural')
    expect(s.timeColumn).toBe('')
  })
})

describe('exploreSql', () => {
  it('reads everything in stored order by default', () => {
    // `quoteIdent` backticks only what needs it, so plain names stay plain.
    expect(exploreSql(spec(), columns)).toBe('SELECT *\nFROM analytics.events\nLIMIT 200')
  })

  it('orders by the time column both ways', () => {
    expect(exploreSql(spec({ order: 'latest' }), columns)).toContain('ORDER BY ts DESC')
    expect(exploreSql(spec({ order: 'oldest' }), columns)).toContain('ORDER BY ts ASC')
  })

  it('selects only the chosen columns', () => {
    expect(exploreSql(spec({ columns: ['ts', 'city'] }), columns)).toContain('SELECT ts, city')
  })

  it('ignores a column or a filter the table does not have', () => {
    // A stale choice must not produce a statement the server rejects.
    expect(exploreSql(spec({ columns: ['ts', 'gone'] }), columns)).toContain('SELECT ts\n')
    expect(exploreSql(spec({ filters: [filter({ column: 'gone' })] }), columns)).not.toContain(
      'WHERE',
    )
  })

  it('builds the WHERE through the query builder, so quoting is decided once', () => {
    const sql = exploreSql(spec({ filters: [filter()] }), columns)
    expect(sql).toContain("WHERE city LIKE '%Oslo%'")
  })

  it('joins several filters with AND', () => {
    const sql = exploreSql(
      spec({
        filters: [filter(), filter({ id: 'f2', column: 'latency_ms', op: '>=', value: '100' })],
      }),
      columns,
    )
    expect(sql).toContain("WHERE city LIKE '%Oslo%' AND latency_ms >= 100")
  })

  it('quotes an identifier that needs it', () => {
    expect(exploreSql(spec({ database: 'my db', table: 'odd name' }), columns)).toContain(
      'FROM `my db`.`odd name`',
    )
  })

  it('never emits an unbounded read', () => {
    expect(exploreSql(spec({ limit: 0 }), columns)).toContain('LIMIT 1')
    expect(exploreSql(spec({ limit: -5 }), columns)).toContain('LIMIT 1')
  })

  it('drops an ordering whose column has gone', () => {
    expect(exploreSql(spec({ order: 'latest', timeColumn: 'gone' }), columns)).not.toContain(
      'ORDER BY',
    )
  })
})

describe('costOf', () => {
  it('calls a leading-key ordering cheap and says why', () => {
    const cost = costOf(spec({ order: 'latest' }), columns, 'ts, city')
    expect(cost.level).toBe('cheap')
    expect(cost.says).toContain('sorted by ts first')
  })

  it('calls the same ordering a scan when the key does not lead with it', () => {
    // The whole point: "newest first" is nearly free on one table and a full
    // scan on the next, and nothing on screen would otherwise say which.
    const cost = costOf(spec({ order: 'latest' }), columns, 'city, ts')
    expect(cost.level).toBe('scan')
    expect(cost.says).toContain('city, ts')
  })

  it('is honest that a random sample reads everything', () => {
    expect(costOf(spec({ order: 'random' }), columns, 'ts').level).toBe('scan')
  })

  it('mentions the columnar saving only when columns were narrowed', () => {
    expect(costOf(spec({ columns: ['ts'] }), columns, 'ts').says).toContain('1 of 5 columns')
    expect(costOf(spec(), columns, 'ts').says).not.toContain('columns')
    // All of them is not a narrowing.
    expect(costOf(spec({ columns: columns.map((c) => c.name) }), columns, 'ts').says).not.toContain(
      'of 5 columns',
    )
  })
})

describe('startingFilter', () => {
  it('offers a range on a number or a time, a contains on text', () => {
    expect(startingFilter({ name: 'latency_ms', type: 'UInt32' }, 'f').op).toBe('>=')
    expect(startingFilter({ name: 'ts', type: 'DateTime' }, 'f').op).toBe('>=')
    expect(startingFilter({ name: 'city', type: 'String' }, 'f').op).toBe('like')
  })
})
