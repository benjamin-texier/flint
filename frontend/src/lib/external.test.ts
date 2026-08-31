import { describe, expect, it } from 'vitest'

import {
  externalNotes,
  externalSource,
  externalWhere,
  isExternalEngine,
  objectPath,
} from './external'

/* The definitions below are copied out of `system.tables.engine_full` on a
   ClickHouse 26.7 rather than written by hand — including the `[HIDDEN]`, which
   is the server's own masking and the thing most of this has to survive. */

describe('objectPath', () => {
  it('splits a path-style endpoint', () => {
    expect(objectPath('http://s3:9000/flint/events/*.parquet')).toEqual({
      endpoint: 's3:9000',
      bucket: 'flint',
      path: 'events/*.parquet',
      region: '',
    })
  })

  it('splits a virtual-hosted AWS URL, region and all', () => {
    expect(objectPath('https://logs.s3.eu-west-2.amazonaws.com/2024/*.gz')).toEqual({
      endpoint: 's3.eu-west-2.amazonaws.com',
      bucket: 'logs',
      path: '2024/*.gz',
      region: 'eu-west-2',
    })
  })

  it('splits a path-style AWS URL', () => {
    expect(objectPath('https://s3.us-east-1.amazonaws.com/logs/2024/part.parquet')).toEqual({
      endpoint: 's3.us-east-1.amazonaws.com',
      bucket: 'logs',
      path: '2024/part.parquet',
      region: 'us-east-1',
    })
  })

  it('names no endpoint for an s3:// URL, because the URL names none', () => {
    expect(objectPath('s3://warehouse/events/')).toEqual({
      endpoint: '',
      bucket: 'warehouse',
      path: 'events/',
      region: '',
    })
  })

  it('keeps a glob intact rather than percent-encoding it', () => {
    expect(objectPath('http://minio:9000/lake/y={2020..2024}/*.parquet')?.path).toBe(
      'y={2020..2024}/*.parquet',
    )
  })

  it('is null for a string it does not recognise', () => {
    expect(objectPath('/var/lib/clickhouse/user_files/a.csv')).toBeNull()
  })
})

describe('externalSource', () => {
  it('is null for an engine that keeps its own rows', () => {
    expect(externalSource('MergeTree', 'MergeTree ORDER BY id')).toBeNull()
    expect(externalSource('ReplicatedMergeTree', "ReplicatedMergeTree('/path', 'r1')")).toBeNull()
  })

  it('reads a bucket, its endpoint and its format', () => {
    const s = externalSource(
      'S3',
      "S3('http://s3:9000/flint/events/*.parquet', 'flintkey', '[HIDDEN]', 'Parquet')",
    )
    expect(s).toMatchObject({
      engine: 'S3',
      kind: 'object_store',
      target: 'flint/events/*.parquet',
      at: 's3:9000',
      masked: true,
      unread: 0,
    })
    expect(s?.facts).toEqual([
      { label: 'format', value: 'Parquet' },
      { label: 'access key', value: 'flintkey' },
    ])
  })

  it('says when a bucket is read without credentials', () => {
    // Written `NOSIGN` and handed back `'NOSIGN'`: the server quotes it.
    const s = externalSource(
      'S3',
      "S3('https://datasets.s3.eu-west-2.amazonaws.com/y={2020..2024}/*.csv.gz', 'NOSIGN', 'CSVWithNames', 'gzip')",
    )
    expect(s).toMatchObject({
      target: 'datasets/y={2020..2024}/*.csv.gz',
      at: 's3.eu-west-2.amazonaws.com',
      masked: false,
      unread: 0,
    })
    expect(s?.facts).toEqual([
      { label: 'region', value: 'eu-west-2' },
      { label: 'credentials', value: 'none — read anonymously' },
      { label: 'format', value: 'CSVWithNames' },
      { label: 'compression', value: 'gzip' },
    ])
  })

  it('counts an argument it cannot name rather than labelling it', () => {
    // A session token sits between the secret and the format, and this does not
    // pretend to know which of the two trailing strings it is.
    const s = externalSource('S3', "S3('s3://b/k', 'key', '[HIDDEN]', 'sessiontoken', 'Parquet')")
    expect(s?.unread).toBe(1)
    expect(s?.facts).toContainEqual({ label: 'format', value: 'Parquet' })
  })

  it('reads a lake table as a lake table', () => {
    const s = externalSource('IcebergS3', "IcebergS3('s3://warehouse/orders/')")
    expect(s).toMatchObject({ kind: 'lake', target: 'warehouse/orders/' })
  })

  it('qualifies a PostgreSQL table with its schema, and only when it was given', () => {
    expect(
      externalSource(
        'PostgreSQL',
        "PostgreSQL('pg.internal:5432', 'shop', 'orders', 'pguser', '[HIDDEN]', 'public')",
      ),
    ).toMatchObject({
      kind: 'database',
      target: 'shop.public.orders',
      at: 'pg.internal:5432',
      facts: [{ label: 'as', value: 'pguser' }],
    })
    expect(
      externalSource('PostgreSQL', "PostgreSQL('pg:5432', 'shop', 'orders', 'u', '[HIDDEN]')")
        ?.target,
    ).toBe('shop.orders')
  })

  it('reads the same engine differently as a database', () => {
    expect(
      externalSource('PostgreSQL', "PostgreSQL('pg:5432', 'shop', 'pguser', '[HIDDEN]')", {
        scope: 'database',
      }),
    ).toMatchObject({ target: 'shop', at: 'pg:5432' })
  })

  it('does not read the schema slot off an unmasked password', () => {
    // The one server in a hundred with `format_display_secrets_in_show_and_select`
    // on writes the password out. The positions must not shift under it.
    expect(
      externalSource(
        'PostgreSQL',
        "PostgreSQL('pg:5432', 'shop', 'orders', 'pguser', 'hunter2', 'reporting')",
      ),
    ).toMatchObject({ target: 'shop.reporting.orders', masked: false })
  })

  it('reads MySQL and MongoDB', () => {
    expect(
      externalSource('MySQL', "MySQL('mysql:3306', 'shop', 'orders', 'root', '[HIDDEN]')"),
    ).toMatchObject({ target: 'shop.orders', at: 'mysql:3306' })
    expect(
      externalSource('MongoDB', "MongoDB('mongo:27017', 'shop', 'orders', 'm', '[HIDDEN]')"),
    ).toMatchObject({ target: 'shop.orders', at: 'mongo:27017' })
  })

  it('reads Redis without mistaking its password for its pool size', () => {
    expect(externalSource('Redis', "Redis('redis:6379', 0, '[HIDDEN]', 16) PRIMARY KEY k")).toMatchObject({
      target: 'database 0',
      at: 'redis:6379',
      facts: [{ label: 'pool', value: '16' }],
    })
  })

  it('reads a Kafka table out of its settings', () => {
    const s = externalSource(
      'Kafka',
      "Kafka SETTINGS kafka_broker_list = 'kafka1:9092,kafka2:9092', kafka_topic_list = 'events,clicks', kafka_group_name = 'flint-consumers', kafka_format = 'JSONEachRow', kafka_num_consumers = 2",
    )
    expect(s).toMatchObject({
      kind: 'stream',
      target: 'events, clicks',
      at: 'kafka1:9092, kafka2:9092',
    })
    expect(s?.facts).toEqual([
      { label: 'consumer group', value: 'flint-consumers' },
      { label: 'format', value: 'JSONEachRow' },
      { label: 'consumers', value: '2' },
    ])
  })

  it('reads a URL table', () => {
    expect(externalSource('URL', "URL('https://example.org/data.jsonl', 'JSONEachRow')")).toMatchObject({
      kind: 'http',
      target: 'https://example.org/data.jsonl',
      facts: [{ label: 'format', value: 'JSONEachRow' }],
    })
  })

  it('takes a File table’s path from the server, since its definition has none', () => {
    expect(
      externalSource('File', "File('CSV')", { paths: ['/var/lib/clickhouse/data/db/t/'] }),
    ).toMatchObject({
      kind: 'file',
      target: '/var/lib/clickhouse/data/db/t/',
      facts: [{ label: 'format', value: 'CSV' }],
    })
  })

  it('says a named collection is the whole answer', () => {
    const s = externalSource('S3', "S3(prod_bucket, format = 'Parquet')")
    expect(s?.collection).toBe('prod_bucket')
    expect(s?.facts).toContainEqual({ label: 'format', value: 'Parquet' })
    expect(s?.target).toBe('')
  })

  it('is not confused by a comma or a bracket inside a path', () => {
    const s = externalSource('S3', "S3('http://m:9000/b/k={a,b}/*.csv', 'CSV')")
    expect(s?.target).toBe('b/k={a,b}/*.csv')
    expect(s?.facts).toEqual([{ label: 'format', value: 'CSV' }])
  })
})

describe('isExternalEngine', () => {
  it.each(['S3', 'S3Queue', 'Kafka', 'PostgreSQL', 'IcebergS3', 'URL', 'MongoDB'])(
    'knows %s stores nothing of its own',
    (engine) => expect(isExternalEngine(engine)).toBe(true),
  )

  it.each(['MergeTree', 'ReplicatedReplacingMergeTree', 'Memory', 'View', 'Distributed'])(
    'knows %s is not external',
    (engine) => expect(isExternalEngine(engine)).toBe(false),
  )
})

describe('externalNotes', () => {
  const of = (engine: string, full: string) => externalSource(engine, full)!

  it('says the masking is the server’s, not Flint’s', () => {
    expect(externalNotes(of('S3', "S3('s3://b/k', 'key', '[HIDDEN]', 'CSV')")).join(' ')).toMatch(
      /ClickHouse masks the credential/,
    )
  })

  it('counts the arguments it did not name, in the singular and the plural', () => {
    expect(externalNotes({ ...of('S3', "S3('s3://b/k')"), unread: 1 })[0]).toMatch(/One further/)
    expect(externalNotes({ ...of('S3', "S3('s3://b/k')"), unread: 3 })[0]).toMatch(/3 further/)
  })

  it('says nothing where the definition held nothing back', () => {
    expect(externalNotes(of('URL', "URL('https://example.org/a.csv', 'CSV')"))).toEqual([])
  })

  it('points at the named collection rather than pretending to read it', () => {
    expect(externalNotes(of('S3', 'S3(prod_bucket)'))[0]).toMatch(/named collection prod_bucket/)
  })
})

describe('externalWhere', () => {
  it('joins the target to its endpoint', () => {
    expect(externalWhere(externalSource('S3', "S3('http://s3:9000/b/k/*.csv')")!)).toBe(
      'b/k/*.csv on s3:9000',
    )
  })

  it('leaves out an endpoint the URL already carried', () => {
    expect(externalWhere(externalSource('URL', "URL('https://e.org/a.csv')")!)).toBe(
      'https://e.org/a.csv',
    )
  })
})
