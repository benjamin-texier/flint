import { describe, expect, it } from 'vitest'

import {
  busiest,
  callsServed,
  countUnreached,
  describeReach,
  reachOf,
  recentlyTouched,
  statementKey,
  trafficOf,
} from './workspace'

import type { Dashboard, SavedQuery } from './api'
import type { UsageReport } from './diagnose'
import type { Published } from './publish'

const saved = (id: string, sql: string, updated = '2026-01-01 00:00:00'): SavedQuery => ({
  id,
  name: id,
  sql,
  database: 'analytics',
  created_at: '2025-01-01 00:00:00',
  updated_at: updated,
})

const endpoint = (slug: string, sql: string, enabled = true): Published => ({
  revision: 1,
  state: 'live',
  description: '',
  cache_ttl: 0,
  contract: '',
  published_by: '',
  id: slug,
  name: slug,
  slug,
  sql,
  database: 'analytics',
  defaults: '{}',
  token_hashed: true,
  expires_at: '',
  run_as: '',
  timezone: '',
  public: false,
  enabled,
  max_rows: 1000,
  created_at: '2025-01-01 00:00:00',
  updated_at: '2025-01-01 00:00:00',
})

const dashboard = (id: string, sqls: string[]): Dashboard => ({
  id,
  name: id,
  spec: JSON.stringify({
    refreshSeconds: 0,
    tiles: sqls.map((sql, i) => ({ id: `t${i}`, title: `t${i}`, sql, database: 'analytics' })),
  }),
  created_at: '2025-01-01 00:00:00',
  updated_at: '2025-01-01 00:00:00',
})

describe('statementKey', () => {
  it('sees through the formatting a copy picks up', () => {
    expect(statementKey('SELECT 1\n  FROM t ;')).toBe(statementKey('SELECT 1 FROM t'))
  })

  it('keeps the case of a literal, because two of them are two questions', () => {
    // The whole reason this does not fold case. Conflating these would publish
    // a claim that is simply false about which endpoint serves what.
    expect(statementKey("SELECT * FROM t WHERE city = 'Paris'")).not.toBe(
      statementKey("SELECT * FROM t WHERE city = 'paris'"),
    )
  })
})

describe('reachOf', () => {
  it('finds the endpoints and tiles running the same statement', () => {
    const statements = [saved('a', 'SELECT 1'), saved('b', 'SELECT 2')]
    const reach = reachOf(
      statements,
      [endpoint('one', 'SELECT 1'), endpoint('two', 'select 1')],
      [dashboard('d1', ['SELECT 1', 'SELECT 2'])],
    )
    // `select 1` is a different key: keywords are text like anything else here.
    expect(reach.get('a')).toEqual({ endpoints: ['one'], tiles: 1 })
    expect(reach.get('b')).toEqual({ endpoints: [], tiles: 1 })
  })

  it('counts a disabled endpoint, because it is still a copy of the statement', () => {
    // Different question from `busiest`, which is about traffic. Here the ask is
    // "does anything else hold this text", and a switched-off endpoint does.
    const reach = reachOf([saved('a', 'SELECT 1')], [endpoint('one', 'SELECT 1', false)], [])
    expect(reach.get('a')?.endpoints).toEqual(['one'])
  })

  it('gives a statement nothing runs an empty reach rather than nothing at all', () => {
    const reach = reachOf([saved('a', 'SELECT 1')], [], [])
    expect(reach.get('a')).toEqual({ endpoints: [], tiles: 0 })
  })

  it('survives a dashboard whose spec is not JSON', () => {
    // Specs are strings written by an older Flint or edited by hand; `parseSpec`
    // is the boundary that makes them safe and this is the page relying on it.
    const broken: Dashboard = { ...dashboard('d', []), spec: 'not json' }
    expect(() => reachOf([saved('a', 'SELECT 1')], [], [broken])).not.toThrow()
  })
})

describe('describeReach', () => {
  it('says what a statement feeds', () => {
    expect(describeReach({ endpoints: ['a', 'b'], tiles: 1 })).toBe('serves 2 endpoints · 1 tile')
    expect(describeReach({ endpoints: ['a'], tiles: 0 })).toBe('serves 1 endpoint')
    expect(describeReach({ endpoints: [], tiles: 3 })).toBe('3 tiles')
  })

  it('says so plainly when nothing does', () => {
    expect(describeReach({ endpoints: [], tiles: 0 })).toBe('nowhere else')
    expect(describeReach(undefined)).toBe('nowhere else')
  })
})

describe('countUnreached', () => {
  it('counts the statements nothing else runs', () => {
    const statements = [saved('a', 'SELECT 1'), saved('b', 'SELECT 2'), saved('c', 'SELECT 3')]
    const reach = reachOf(statements, [endpoint('one', 'SELECT 1')], [])
    expect(countUnreached(statements, reach)).toBe(2)
  })
})

describe('recentlyTouched', () => {
  it('puts the most recently edited first and caps the list', () => {
    const statements = [
      saved('old', 'SELECT 1', '2026-01-01 00:00:00'),
      saved('new', 'SELECT 2', '2026-03-02 09:00:00'),
      saved('mid', 'SELECT 3', '2026-02-01 00:00:00'),
    ]
    expect(recentlyTouched(statements, 2).map((s) => s.id)).toEqual(['new', 'mid'])
  })

  it('leaves the caller’s list alone', () => {
    const statements = [saved('a', 'SELECT 1', '2026-01-01 00:00:00'), saved('b', 'SELECT 2', '2026-02-01 00:00:00')]
    recentlyTouched(statements, 2)
    expect(statements.map((s) => s.id)).toEqual(['a', 'b'])
  })
})

const usageReport = (usage: { slug: string; calls: number }[]): UsageReport => ({
  available: true,
  window_days: 7,
  usage: usage.map((u) => ({
    slug: u.slug,
    calls: u.calls,
    failures: 0,
    avg_ms: 10,
    p95_ms: 20,
    read_rows: 0,
    read_bytes: 0,
    last_call: '2026-03-02 09:00:00',
  })),
})

describe('busiest', () => {
  it('orders live endpoints by the traffic they served', () => {
    const list = busiest(
      [endpoint('quiet', 'SELECT 1'), endpoint('loud', 'SELECT 2')],
      usageReport([
        { slug: 'quiet', calls: 3 },
        { slug: 'loud', calls: 900 },
      ]),
      5,
    )
    expect(list.map((s) => s.endpoint.slug)).toEqual(['loud', 'quiet'])
  })

  it('leaves a disabled endpoint out: it is serving no traffic to rank', () => {
    const list = busiest([endpoint('off', 'SELECT 1', false)], usageReport([]), 5)
    expect(list).toEqual([])
  })

  it('sorts an uncalled endpoint below a called one and keeps it', () => {
    // Never called is a fact worth showing. It is not zero calls either — the
    // row says which, and this only fixes where it sits.
    const list = busiest(
      [endpoint('never', 'SELECT 1'), endpoint('once', 'SELECT 2')],
      usageReport([{ slug: 'once', calls: 1 }]),
      5,
    )
    expect(list.map((s) => [s.endpoint.slug, s.usage?.calls])).toEqual([
      ['once', 1],
      ['never', undefined],
    ])
  })

  it('falls back to the name when the log cannot be read', () => {
    // Not an arbitrary order dressed up as a ranking: with no figures there is
    // no "busiest", and the page says as much beside the list.
    const list = busiest([endpoint('b', 'SELECT 1'), endpoint('a', 'SELECT 2')], undefined, 5)
    expect(list.map((s) => s.endpoint.slug)).toEqual(['a', 'b'])
  })
})

describe('trafficOf', () => {
  it('drops the calls to endpoints that no longer exist', () => {
    // The query log outlives the endpoint. Left in, these rows are the loudest
    // on a workspace that has been used for a while, and they belong to
    // addresses that now answer 404.
    const narrowed = trafficOf(
      usageReport([
        { slug: 'gone', calls: 2400 },
        { slug: 'here', calls: 7 },
      ]),
      [endpoint('here', 'SELECT 1')],
    )
    expect(narrowed?.usage.map((u) => u.slug)).toEqual(['here'])
    expect(callsServed(narrowed)).toBe(7)
  })

  it('keeps a disabled endpoint, which is not the same as a deleted one', () => {
    const narrowed = trafficOf(usageReport([{ slug: 'off', calls: 5 }]), [
      endpoint('off', 'SELECT 1', false),
    ])
    expect(callsServed(narrowed)).toBe(5)
  })

  it('waits for the endpoint list rather than claiming no traffic', () => {
    // Narrowing against a list that has not arrived would filter everything out
    // and print a confident zero.
    expect(trafficOf(usageReport([{ slug: 'here', calls: 7 }]), undefined)).toBeUndefined()
  })

  it('carries the report’s own refusal through', () => {
    const off: UsageReport = { available: false, reason: 'query_log is off', window_days: 7, usage: [] }
    expect(trafficOf(off, [])?.available).toBe(false)
  })
})

describe('callsServed', () => {
  it('adds up the window', () => {
    expect(callsServed(usageReport([{ slug: 'a', calls: 2 }, { slug: 'b', calls: 5 }]))).toBe(7)
  })

  it('is null and not zero where the log is off', () => {
    // The figure that must never be invented: "nobody called your endpoints" and
    // "we cannot see who called your endpoints" are opposite conclusions.
    expect(callsServed({ available: false, reason: 'query_log is off', window_days: 7, usage: [] })).toBeNull()
    expect(callsServed(undefined)).toBeNull()
  })
})
