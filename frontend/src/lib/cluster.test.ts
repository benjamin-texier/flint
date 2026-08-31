import { describe, expect, it } from 'vitest'

import {
  ddlFailed,
  foldDdl,
  nodeVerdict,
  rings,
  saysDdl,
  selfOnly,
  stuck,
  withoutUuid,
  type DdlEntry,
  type DdlStatement,
  type Node,
  type QueueEntry,
} from './cluster'

const node = (over: Partial<Node> = {}): Node => ({
  cluster: 'analytics',
  recovery_secs: 0,
  shard_num: 1,
  replica_num: 1,
  host_name: 'ch-0',
  port: 9000,
  is_local: false,
  errors_count: 0,
  is_active: null,
  ...over,
})

describe('rings', () => {
  it('groups a flat table into clusters, shards and replicas', () => {
    const ring = rings([
      node({ shard_num: 2, replica_num: 1, host_name: 'ch-2' }),
      node({ shard_num: 1, replica_num: 2, host_name: 'ch-1' }),
      node({ shard_num: 1, replica_num: 1, host_name: 'ch-0' }),
    ])
    expect(ring).toHaveLength(1)
    expect(ring[0]!.cluster).toBe('analytics')
    expect(ring[0]!.nodes).toBe(3)
    // Shards in configuration order, replicas in theirs — a topology drawn in
    // the order rows happened to arrive is a topology nobody can check against
    // what they deployed.
    expect(ring[0]!.shards.map((s) => s.shard)).toEqual([1, 2])
    expect(ring[0]!.shards[0]!.replicas.map((r) => r.host_name)).toEqual(['ch-0', 'ch-1'])
  })

  it('keeps two clusters apart even when they share a host', () => {
    // Normal in ClickHouse: the same server appears in several cluster
    // definitions. Deduplicating across them would draw one ring that exists
    // nowhere in the configuration.
    const ring = rings([
      node({ cluster: 'a', host_name: 'ch-0' }),
      node({ cluster: 'b', host_name: 'ch-0' }),
    ])
    expect(ring.map((r) => r.cluster).sort()).toEqual(['a', 'b'])
    expect(ring.every((r) => r.nodes === 1)).toBe(true)
  })

  it('has nothing to group when there is nothing', () => {
    expect(rings([])).toEqual([])
  })
})

describe('selfOnly', () => {
  it('recognises the cluster every ClickHouse ships', () => {
    // `default`: one endpoint, and it is this machine. Nobody deployed it, and
    // drawn beside a real ring it reads as a second cluster.
    const [ring] = rings([node({ cluster: 'default', is_local: true })])
    expect(selfOnly(ring!)).toBe(true)
  })

  it('does not fold away a real ring', () => {
    const [ring] = rings([
      node({ cluster: 'demo', shard_num: 1, is_local: true }),
      node({ cluster: 'demo', shard_num: 2, host_name: 'ch-1' }),
    ])
    expect(selfOnly(ring!)).toBe(false)
  })

  it('does not fold away a single remote endpoint', () => {
    // One node that is *not* this one is somebody's deliberate configuration,
    // and quite possibly the interesting one.
    const [ring] = rings([node({ cluster: 'remote-only', is_local: false })])
    expect(selfOnly(ring!)).toBe(false)
  })
})

describe('nodeVerdict', () => {
  it('says nothing about a healthy endpoint', () => {
    // A verdict on every row is a page of noise; silence is the healthy answer.
    expect(nodeVerdict(node())).toBeNull()
  })

  it('reports the back-off, which is the signal that actually moves', () => {
    // Measured against a stopped replica: `errors_count` stayed at zero through
    // a read and a write, and `estimated_recovery_time` went to 60.
    expect(nodeVerdict(node({ recovery_secs: 60 }))?.says).toBe(
      'not being tried for 60s after a failure',
    )
    expect(nodeVerdict(node({ recovery_secs: 9 }))?.level).toBe('watch')
  })

  it('does not oversell the back-off as knowledge about the node', () => {
    // It counted down from 60 to 9 while the stopped replica was already
    // running again, because nothing checks until the timer runs out.
    const says = nodeVerdict(node({ recovery_secs: 30 }))?.says ?? ''
    expect(says).toMatch(/not being tried/)
    expect(says).not.toMatch(/recover|down|unreachable/)
  })

  it('still reports an error count where a build populates one', () => {
    // Kept rather than removed: this server never sets it, another might.
    expect(nodeVerdict(node({ errors_count: 3 }))?.says).toBe('3 connection errors')
    expect(nodeVerdict(node({ errors_count: 1 }))?.says).toBe('1 connection error')
  })

  it('trusts an explicit inactive over everything else', () => {
    expect(nodeVerdict(node({ is_active: false, errors_count: 0 }))?.level).toBe('bad')
    expect(nodeVerdict(node({ is_active: false, recovery_secs: 40 }))?.says).toBe('not active')
  })

  it('does not read a missing is_active as inactive', () => {
    // Null is "this build does not report it". Calling that inactive would light
    // every node on most ClickHouse versions.
    expect(nodeVerdict(node({ is_active: null }))).toBeNull()
    expect(nodeVerdict(node({ is_active: true }))).toBeNull()
  })
})

const entry = (over: Partial<QueueEntry> = {}): QueueEntry => ({
  database: 'analytics',
  table: 'events',
  kind: 'GET_PART',
  created_time: '2026-08-25 12:00:00',
  num_tries: 0,
  last_exception: '',
  is_currently_executing: false,
  postpone_reason: '',
  ...over,
})

describe('stuck', () => {
  it('does not call an ordinary retry stuck', () => {
    // Retrying is how replication works. Flagging one would light the page up on
    // a healthy cluster.
    expect(stuck(entry({ num_tries: 1, last_exception: 'transient' }))).toBe(false)
    expect(stuck(entry({ num_tries: 9, last_exception: '' }))).toBe(false)
  })

  it('calls repeated failures with an exception stuck', () => {
    expect(stuck(entry({ num_tries: 12, last_exception: 'No active replica' }))).toBe(true)
  })
})

const ddl = (over: Partial<DdlEntry> = {}): DdlEntry => ({
  entry: 'query-0001',
  host: 'ch-0',
  query: 'CREATE TABLE t ON CLUSTER analytics …',
  status: 'Finished',
  exception_code: 0,
  exception_text: '',
  query_create_time: '2026-08-25 12:00:00',
  ...over,
})

describe('ddlFailed', () => {
  it('reads the exception, not only the status', () => {
    // The failure this exists for: `Finished` on three nodes and an exception on
    // the fourth. Reading the status alone calls that a success.
    expect(ddlFailed(ddl({ status: 'Finished', exception_code: 60 }))).toBe(true)
    expect(ddlFailed(ddl({ status: 'Finished', exception_text: 'Table already exists' }))).toBe(true)
    expect(ddlFailed(ddl())).toBe(false)
  })
})

describe('foldDdl', () => {
  // The three shapes, measured on a two-node ring rather than invented.
  const ran = (entry: string, host: string): DdlEntry => ({
    entry,
    host,
    query: 'CREATE TABLE t ON CLUSTER demo (n UInt32) ENGINE = MergeTree ORDER BY n',
    status: 'Finished',
    exception_code: 0,
    exception_text: '',
    query_create_time: '2026-08-28 10:00:00',
  })
  const failed = (entry: string, host: string): DdlEntry => ({
    ...ran(entry, host),
    exception_code: 57,
    exception_text: 'Table default.clash already exists.',
  })
  const inactive = (entry: string, host: string): DdlEntry => ({
    ...ran(entry, host),
    status: 'Inactive',
  })
  /** The one statement these rows fold into, so a test reads about a statement
   *  rather than about an array index. */
  const one = (rows: DdlEntry[]): DdlStatement => {
    const [only] = foldDdl(rows)
    if (!only) throw new Error('the fold dropped the statement')
    return only
  }

  it('reads a failure that the server marked Finished', () => {
    // The measured trap: the host where the table was never created carries
    // status `Finished` with code 57 beside it.
      const s = one([ran('query-4', 'ch-a'), failed('query-4', 'ch-b')])
    expect(s.ran).toBe(1)
    expect(s.failed.map((h) => h.host)).toEqual(['ch-b'])
    expect(saysDdl(s)).toBe('Ran on 1 of 2 — failed on ch-b.')
  })

  it('keeps a node that is merely absent apart from one that failed', () => {
    // A stopped node's row is `Inactive` with nulls in both exception columns.
    // Nothing has gone wrong: it runs the statement when it comes back.
      const s = one([ran('query-5', 'ch-a'), inactive('query-5', 'ch-b')])
    expect(s.failed).toHaveLength(0)
    expect(s.pending.map((h) => h.host)).toEqual(['ch-b'])
    expect(saysDdl(s)).toBe('Ran on 1 of 2 — ch-b has not picked it up yet.')
  })

  it('says a clean statement once, not once per host', () => {
      const s = one([ran('query-3', 'ch-a'), ran('query-3', 'ch-b')])
    expect(saysDdl(s)).toBe('Ran on all 2 hosts.')
    expect(saysDdl(one([ran('query-2', 'ch-a')]))).toBe('Ran on the one host in the ring.')
  })

  it('keeps the server order rather than re-sorting on a one-second clock', () => {
    // `query_create_time` has one-second resolution, so two statements issued in
    // the same second would shuffle on every render if the page sorted by it.
    const rows = [ran('query-9', 'ch-a'), ran('query-9', 'ch-b'), ran('query-8', 'ch-a')]
    expect(foldDdl(rows).map((s) => s.entry)).toEqual(['query-9', 'query-8'])
  })
})

describe('withoutUuid', () => {
  it('drops the UUID the initiator wrote into the statement', () => {
    // Taken from the ledger of a real two-node ring: this is what the server
    // stores, not what anybody typed.
    expect(
      withoutUuid(
        "CREATE TABLE default.clash UUID '6c49459e-bc6d-44ae-88f1-8e9f401b230f' ON CLUSTER demo (`n` UInt32) ENGINE = MergeTree ORDER BY n",
      ),
    ).toBe('CREATE TABLE default.clash ON CLUSTER demo (`n` UInt32) ENGINE = MergeTree ORDER BY n')
  })

  it('leaves a statement that carries no UUID exactly as it is', () => {
    const drop = 'DROP TABLE IF EXISTS default.wr_all ON CLUSTER demo SYNC'
    expect(withoutUuid(drop)).toBe(drop)
  })

  it('does not eat a column that happens to be called uuid', () => {
    // A `UUID` type and a UUID literal are different things, and only the second
    // is bookkeeping.
    const create = 'CREATE TABLE t ON CLUSTER demo (`id` UUID, `n` UInt32) ENGINE = MergeTree ORDER BY id'
    expect(withoutUuid(create)).toBe(create)
  })
})
