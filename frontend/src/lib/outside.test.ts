import { describe, expect, it } from 'vitest'

import { groupLabel, groupOutside, saysOutside, type OutsideTable } from './outside'

/* Definitions copied out of `system.tables` on the development fixture. */
const TABLES: OutsideTable[] = [
  {
    database: 'elsewhere',
    name: 'bucket_events',
    engine: 'S3',
    engine_full: "S3('http://s3:9000/flint/events/*.parquet', 'flintkey', '[HIDDEN]', 'Parquet')",
  },
  {
    database: 'elsewhere',
    name: 'bucket_clicks',
    engine: 'IcebergS3',
    engine_full: "IcebergS3('http://s3:9000/flint/clicks/')",
  },
  {
    database: 'elsewhere',
    name: 'pg_orders',
    engine: 'PostgreSQL',
    engine_full: "PostgreSQL('pg.internal:5432', 'shop', 'orders', 'pguser', '[HIDDEN]', 'public')",
  },
  {
    database: 'elsewhere',
    name: 'pg_customers',
    engine: 'PostgreSQL',
    engine_full: "PostgreSQL('pg.internal:5432', 'shop', 'customers', 'pguser', '[HIDDEN]')",
  },
  {
    database: 'elsewhere',
    name: 'my_customers',
    engine: 'MySQL',
    engine_full: "MySQL('mysql.internal:3306', 'shop', 'customers', 'root', '[HIDDEN]')",
  },
]

describe('groupOutside', () => {
  it('puts two engines on one bucket in one group', () => {
    const groups = groupOutside(TABLES)
    const bucket = groups.find((g) => g.at === 's3:9000')
    expect(bucket?.entries).toHaveLength(2)
    // A bucket read by an S3 table and an Iceberg table is one bucket.
    expect(bucket?.engines).toEqual(['S3', 'IcebergS3'])
  })

  it('keeps two tables on one Postgres together', () => {
    const groups = groupOutside(TABLES)
    const pg = groups.find((g) => g.at === 'pg.internal:5432')
    expect(pg?.entries.map((e) => e.table.name)).toEqual(['pg_orders', 'pg_customers'])
    expect(pg?.entries[0]?.target).toBe('shop.public.orders')
  })

  it('does not merge a Postgres and a MySQL that are different hosts', () => {
    expect(groupOutside(TABLES)).toHaveLength(3)
  })

  it('does not merge two protocols that share a hostname', () => {
    // The one that would silently produce a row that is neither.
    const groups = groupOutside([
      {
        database: 'd',
        name: 'a',
        engine: 'PostgreSQL',
        engine_full: "PostgreSQL('host:5432', 'db', 't', 'u', '[HIDDEN]')",
      },
      {
        database: 'd',
        name: 'b',
        engine: 'Kafka',
        engine_full: "Kafka SETTINGS kafka_broker_list = 'host:5432', kafka_topic_list = 't'",
      },
    ])
    expect(groups).toHaveLength(2)
  })

  it('groups the engines that name no host by what they are', () => {
    const groups = groupOutside([
      { database: 'd', name: 'a', engine: 'File', engine_full: "File('CSV')" },
      { database: 'd', name: 'b', engine: 'File', engine_full: "File('TSV')" },
      { database: 'd', name: 'c', engine: 'URL', engine_full: "URL('https://a.example/x', 'CSV')" },
    ])
    // Two files together, the URL apart: grouping a URL on its own address
    // would make one group per table, which is the list again.
    expect(groups.map((g) => g.entries.length).sort()).toEqual([1, 2])
  })

  it('puts the busiest place first', () => {
    expect(groupOutside(TABLES)[0]?.entries).toHaveLength(2)
  })

  it('ignores a table whose engine keeps its own rows', () => {
    expect(
      groupOutside([
        { database: 'd', name: 't', engine: 'MergeTree', engine_full: 'MergeTree ORDER BY id' },
      ]),
    ).toEqual([])
  })
})

describe('groupLabel', () => {
  it('names a group after its endpoint', () => {
    const pg = groupOutside(TABLES).find((g) => g.at === 'pg.internal:5432')!
    expect(groupLabel(pg)).toBe('pg.internal:5432')
  })

  it('names one after what it is where there is no host', () => {
    const files = groupOutside([
      { database: 'd', name: 'a', engine: 'File', engine_full: "File('CSV')" },
    ])
    expect(groupLabel(files[0]!)).toBe('File')
  })
})

describe('saysOutside', () => {
  it('gives both figures, since either alone misleads', () => {
    expect(saysOutside(groupOutside(TABLES), 5)).toBe(
      '5 tables on this server read from 3 places outside it.',
    )
  })

  it('says what a cap left out', () => {
    expect(saysOutside(groupOutside(TABLES), 900)).toBe(
      '5 tables of 900 on this server read from 3 places outside it; the rest are not listed.',
    )
  })

  it('says so plainly where there is nothing', () => {
    expect(saysOutside([], 0)).toBe('Nothing on this server reads from outside it.')
  })
})
