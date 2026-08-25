import { describe, expect, it } from 'vitest'

import { analyseDefinition, columnUsage, originOf } from './lineage'

/** Invented schema throughout: a shop, its orders and its customers. */
const JOINED = `SELECT o.order_id AS order_id, toDateTime(o.placed_at, getSetting('session_timezone')) AS local_placed_at, o.total AS total, c.name AS customer_name, concat(c.city, ', ', c.country) AS place FROM shop.orders AS o INNER JOIN shop.customers AS c ON o.customer_id = c.customer_id WHERE isNotNull(o.total)`

const UNIONED = `SELECT toDate(placed_at) AS day, channel, sum(total) AS revenue FROM shop.orders WHERE isNotNull(total) GROUP BY day, channel UNION ALL SELECT toDate(returned_at) AS day, 'returns' AS channel, sum(refund) AS revenue FROM shop.returns GROUP BY day`

const names = (d: ReturnType<typeof analyseDefinition>) => d?.columns.map((c) => c.name)
const refs = (d: ReturnType<typeof analyseDefinition>, column: string) =>
  originOf(d, column)?.from.map((r) => `${r.table ?? '?'}.${r.column}`)

describe('analyseDefinition', () => {
  it('reads the output columns in order', () => {
    expect(names(analyseDefinition(JOINED))).toEqual([
      'order_id',
      'local_placed_at',
      'total',
      'customer_name',
      'place',
    ])
  })

  it('lists what the definition selects from', () => {
    const d = analyseDefinition(JOINED)
    expect(d?.sources.map((s) => `${s.database}.${s.table} as ${s.alias}`)).toEqual([
      'shop.orders as o',
      'shop.customers as c',
    ])
  })

  it('resolves a qualified reference through its alias', () => {
    const d = analyseDefinition(JOINED)
    expect(refs(d, 'order_id')).toEqual(['orders.order_id'])
    expect(refs(d, 'customer_name')).toEqual(['customers.name'])
  })

  it('follows every column an expression touches', () => {
    expect(refs(analyseDefinition(JOINED), 'place')).toEqual([
      'customers.city',
      'customers.country',
    ])
  })

  it('knows a computed column from a passed-through one', () => {
    const d = analyseDefinition(JOINED)
    expect(originOf(d, 'total')?.computed).toBe(false)
    expect(originOf(d, 'local_placed_at')?.computed).toBe(true)
    expect(originOf(d, 'local_placed_at')?.expression).toBe(
      "toDateTime(o.placed_at, getSetting('session_timezone'))",
    )
  })

  it('does not mistake a function name for a column', () => {
    expect(refs(analyseDefinition(JOINED), 'local_placed_at')).toEqual(['orders.placed_at'])
  })

  it('attributes a bare column when there is only one source to attribute it to', () => {
    const d = analyseDefinition('SELECT total AS total FROM shop.orders')
    expect(refs(d, 'total')).toEqual(['orders.total'])
  })

  it('leaves a bare column unplaced when two sources could own it', () => {
    const d = analyseDefinition(
      'SELECT total AS total FROM shop.orders AS o INNER JOIN shop.customers AS c ON o.customer_id = c.customer_id',
    )
    expect(refs(d, 'total')).toEqual(['?.total'])
  })

  it('reports an unknown prefix as unplaced rather than guessing', () => {
    const d = analyseDefinition('SELECT elsewhere.total AS total FROM shop.orders AS o')
    expect(refs(d, 'total')).toEqual(['?.elsewhere.total'])
  })

  it('takes the name from the reference when there is no AS', () => {
    const d = analyseDefinition('SELECT o.total, o.currency FROM shop.orders AS o')
    expect(names(d)).toEqual(['total', 'currency'])
    expect(refs(d, 'total')).toEqual(['orders.total'])
  })

  it('merges the branches of a union by position', () => {
    const d = analyseDefinition(UNIONED)
    expect(d?.branches).toHaveLength(2)
    expect(names(d)).toEqual(['day', 'channel', 'revenue'])
    expect(d?.sources.map((s) => s.table)).toEqual(['orders', 'returns'])
    // `day` is computed from a different column on each side.
    expect(refs(d, 'day')).toEqual(['orders.placed_at', 'returns.returned_at'])
    expect(refs(d, 'revenue')).toEqual(['orders.total', 'returns.refund'])
  })

  it('keeps a constant branch from inventing a source', () => {
    const d = analyseDefinition(UNIONED)
    expect(refs(d, 'channel')).toEqual(['orders.channel'])
  })

  it('says when it cannot list the columns at all', () => {
    const d = analyseDefinition('SELECT * FROM shop.orders')
    expect(d?.star).toBe(true)
    expect(d?.sources.map((s) => s.table)).toEqual(['orders'])
  })

  it('marks a subquery as one rather than inventing a table', () => {
    const d = analyseDefinition(
      'SELECT day AS day FROM (SELECT toDate(placed_at) AS day FROM shop.orders) AS inner_q',
    )
    expect(d?.sources[0]?.kind).toBe('subquery')
    expect(d?.sources[0]?.table).toBeNull()
    expect(d?.sources[0]?.alias).toBe('inner_q')
  })

  it('marks a table function as one', () => {
    const d = analyseDefinition('SELECT number AS n FROM numbers(10)')
    expect(d?.sources[0]?.kind).toBe('function')
  })

  it('reads a view with no FROM at all', () => {
    const d = analyseDefinition("SELECT 1 AS one, 'two' AS two")
    expect(names(d)).toEqual(['one', 'two'])
    expect(d?.sources).toEqual([])
    expect(refs(d, 'one')).toEqual([])
  })

  it('does not fall over on a definition it cannot read', () => {
    expect(analyseDefinition('')).toBeNull()
    expect(analyseDefinition('DROP TABLE shop.orders')).toBeNull()
    expect(analyseDefinition('SELECT')).toBeNull()
  })

  it('reads a column whose name is also a SQL keyword', () => {
    // `system.columns` selects `database`, `comment`, `position` and `type`.
    // The highlighter is right to call those keywords; this reader has to know
    // they are columns.
    const d = analyseDefinition(
      'SELECT database AS table_catalog, position AS ordinal_position, comment AS note FROM system.columns',
    )
    expect(names(d)).toEqual(['table_catalog', 'ordinal_position', 'note'])
    expect(refs(d, 'table_catalog')).toEqual(['columns.database'])
    expect(refs(d, 'note')).toEqual(['columns.comment'])
    expect(originOf(d, 'table_catalog')?.computed).toBe(false)
  })

  it('still knows a literal from a column', () => {
    const d = analyseDefinition('SELECT NULL AS nothing, x AS something FROM shop.orders')
    expect(refs(d, 'nothing')).toEqual([])
    expect(refs(d, 'something')).toEqual(['orders.x'])
  })

  it('is not fooled by a keyword inside a quoted name', () => {
    const d = analyseDefinition('SELECT o.`from` AS `group by` FROM shop.orders AS o')
    expect(names(d)).toEqual(['group by'])
    expect(refs(d, 'group by')).toEqual(['orders.from'])
  })

  it('is not fooled by a string that looks like SQL', () => {
    const d = analyseDefinition("SELECT 'FROM shop.customers' AS note FROM shop.orders")
    expect(d?.sources.map((s) => s.table)).toEqual(['orders'])
    expect(refs(d, 'note')).toEqual([])
  })

  it('says which source columns are read, and what each one feeds', () => {
    const usage = columnUsage(analyseDefinition(JOINED)!)
    expect([...usage.keys()]).toEqual(['orders', 'customers'])
    expect(Object.fromEntries(usage.get('orders')!)).toEqual({
      order_id: ['order_id'],
      placed_at: ['local_placed_at'],
      total: ['total'],
      customer_id: [],
    })
    expect(Object.fromEntries(usage.get('customers')!)).toEqual({
      name: ['customer_name'],
      city: ['place'],
      country: ['place'],
      customer_id: [],
    })
  })

  it('counts one source column feeding two outputs', () => {
    const usage = columnUsage(
      analyseDefinition('SELECT total AS gross, total * 1.2 AS net FROM shop.orders')!,
    )
    expect(usage.get('orders')?.get('total')).toEqual(['gross', 'net'])
  })

  it('resolves a reference to an alias of the same select list', () => {
    // ClickHouse lets one select item build on another, and
    // `INFORMATION_SCHEMA.columns` does it for half its columns. Attributing
    // `table_catalog` to a column of `system.columns` would invent one.
    const d = analyseDefinition(
      'SELECT database AS table_catalog, table_catalog AS TABLE_CATALOG FROM system.columns',
    )
    expect(refs(d, 'table_catalog')).toEqual(['columns.database'])
    expect(refs(d, 'TABLE_CATALOG')).toEqual(['columns.database'])
  })

  it('follows a chain of aliases to the column at the end of it', () => {
    const d = analyseDefinition(
      'SELECT total AS a, a * 2 AS b, b + 1 AS c FROM shop.orders',
    )
    expect(refs(d, 'c')).toEqual(['orders.total'])
  })

  it('an alias only resolves against the items before it', () => {
    // `later` is defined after `early` reads it, so it is not in scope and is
    // read as a column instead — which is what ClickHouse would do too.
    const d = analyseDefinition('SELECT later AS early, total AS later FROM shop.orders')
    expect(refs(d, 'early')).toEqual(['orders.later'])
  })

  it('counts grouping by a derived column as reading what it derives from', () => {
    const usage = columnUsage(
      analyseDefinition(
        'SELECT toDate(placed_at) AS day, sum(total) AS revenue FROM shop.orders GROUP BY day',
      )!,
    )
    expect(usage.get('orders')?.get('placed_at')).toEqual(['day'])
  })
})
