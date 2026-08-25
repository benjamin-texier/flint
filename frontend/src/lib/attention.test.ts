import { describe, expect, it } from 'vitest'
import {
  alertConcerns,
  concise,
  concerns,
  countFor,
  endpointConcerns,
  replicaConcerns,
  reportConcerns,
  summarise,
  withoutName,
} from './attention'
import type { Alert } from './alert'
import type { Report } from './report'
import type { Replica } from './replication'

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: 'a',
  name: 'Errors',
  sql: 'SELECT 1',
  database: '',
  condition: '{}',
  interval_seconds: 300,
  webhook: '',
  enabled: true,
  created_at: '',
  updated_at: '',
  state: '',
  last_event: '',
  last_message: '',
  last_delivered: false,
  last_delivery_error: '',
  ...over,
})

const report = (over: Partial<Report> = {}): Report => ({
  id: 'r',
  name: 'Monday',
  spec: '{}',
  schedule: '{}',
  webhook: '',
  enabled: true,
  created_at: '',
  updated_at: '',
  last_run: '',
  last_status: '',
  runs: 1,
  ...over,
})

describe('alertConcerns', () => {
  it('lists a firing alert', () => {
    const items = alertConcerns([alert({ state: 'firing', last_message: 'Errors is firing: …' })])
    expect(items).toHaveLength(1)
    expect(items[0]!.concern).toBe('firing')
    expect(items[0]!.says).toContain('firing')
  })

  it('lists an alert that cannot run, which is easier to miss', () => {
    // "we have no idea whether this is true" is not the same as "it is fine".
    const items = alertConcerns([alert({ state: 'error' })])
    expect(items[0]!.concern).toBe('broken')
    expect(items[0]!.says).toContain('telling you nothing')
  })

  it('says nothing about a healthy or a brand-new alert', () => {
    expect(alertConcerns([alert({ state: 'ok' })])).toEqual([])
    expect(alertConcerns([alert({ state: '' })])).toEqual([])
  })

  it('ignores an alert somebody paused', () => {
    // Pausing it was a decision; nagging about it second-guesses that.
    expect(alertConcerns([alert({ state: 'firing', enabled: false })])).toEqual([])
  })

  it('survives having no alerts at all', () => {
    expect(alertConcerns(undefined)).toEqual([])
  })
})

describe('reportConcerns', () => {
  it('separates a failure from a partial run', () => {
    expect(reportConcerns([report({ last_status: 'failed' })])[0]!.concern).toBe('failed')
    expect(reportConcerns([report({ last_status: 'partial' })])[0]!.concern).toBe('partial')
  })

  it('says nothing about a complete or a never-run report', () => {
    expect(reportConcerns([report({ last_status: 'ok' })])).toEqual([])
    expect(reportConcerns([report({ last_status: '' })])).toEqual([])
    expect(reportConcerns([report({ last_status: 'skipped' })])).toEqual([])
  })

  it('ignores a paused report', () => {
    expect(reportConcerns([report({ last_status: 'failed', enabled: false })])).toEqual([])
  })
})

describe('endpointConcerns', () => {
  const usage = (failures: number, calls = 10) => ({
    available: true,
    window_days: 7,
    usage: [
      {
        slug: 'by-city',
        calls,
        failures,
        avg_ms: 1,
        p95_ms: 1,
        read_rows: 0,
        read_bytes: 0,
        last_call: '2026-08-01 00:00:00',
      },
    ],
  })

  it('reports failing calls with their share', () => {
    expect(endpointConcerns(usage(3))[0]!.says).toBe('3 of 10 calls failed')
  })

  it('says nothing where the log could not be read', () => {
    // Not "no failures": we could not tell, and inventing reassurance is worse
    // than staying quiet.
    expect(endpointConcerns({ available: false, window_days: 7, usage: [] })).toEqual([])
    expect(endpointConcerns(undefined)).toEqual([])
  })

  it('says nothing when nothing failed', () => {
    expect(endpointConcerns(usage(0))).toEqual([])
  })
})

describe('countFor', () => {
  it('counts only what points at that page', () => {
    const items = concerns({
      alerts: [alert({ state: 'firing' }), alert({ state: 'error' })],
      reports: [report({ last_status: 'failed' })],
    })
    expect(countFor(items, '/alerts')).toBe(2)
    expect(countFor(items, '/reports')).toBe(1)
    expect(countFor(items, '/apis')).toBe(0)
  })
})

describe('summarise', () => {
  it('is null when there is nothing to say', () => {
    // The common case. A badge that is always lit stops being read.
    expect(summarise([])).toBeNull()
  })

  it('leads with what is firing', () => {
    const items = concerns({
      alerts: [alert({ state: 'firing' }), alert({ state: 'firing' }), alert({ state: 'error' })],
      reports: [report({ last_status: 'partial' })],
    })
    expect(summarise(items)).toBe(
      '2 alerts firing, 1 that cannot run, 1 other thing to look at',
    )
  })

  it('gets the singular right', () => {
    expect(summarise(concerns({ alerts: [alert({ state: 'firing' })] }))).toBe('1 alert firing')
  })
})

describe('concise', () => {
  it('keeps a short line whole', () => {
    expect(concise('is firing: rows > 0 (measured 3)')).toBe('is firing: rows > 0 (measured 3)')
  })

  it('cuts a ClickHouse exception at its first sentence', () => {
    // The whole thing carries the statement, the scope and the build version.
    const raw =
      "could not run: Unknown table expression identifier 'a.nowhere' in scope SELECT count() FROM a.nowhere. (UNKNOWN_TABLE) (version 26.7.5.10 (official build))"
    const short = concise(raw)
    expect(short.length).toBeLessThanOrEqual(96)
    expect(short).not.toContain('official build')
  })

  it('ellipsises a first sentence that is still too long', () => {
    const long = `x${'y'.repeat(200)}`
    const short = concise(long)
    expect(short).toHaveLength(96)
    expect(short.endsWith('…')).toBe(true)
  })

  it('survives an empty message', () => {
    expect(concise('')).toBe('')
  })
})

describe('withoutName', () => {
  it('drops the name the scheduler prefixed', () => {
    // "Errors — Errors is firing: …" reads like a stutter.
    expect(withoutName('Errors is firing: rows > 0', 'Errors')).toBe('is firing: rows > 0')
  })

  it('is case insensitive about it', () => {
    expect(withoutName('errors is firing', 'Errors')).toBe('is firing')
  })

  it('leaves a message that merely contains the name alone', () => {
    expect(withoutName('something about Errors', 'Errors')).toBe('something about Errors')
  })

  it('does not eat a longer name that starts the same way', () => {
    expect(withoutName('Errorsmith is firing', 'Errors')).toBe('Errorsmith is firing')
  })

  it('survives an empty message', () => {
    expect(withoutName('', 'Errors')).toBe('')
  })
})

const replica = (over: Partial<Replica> = {}): Replica => ({
  database: 'analytics',
  table: 'rep_events',
  engine: 'ReplicatedMergeTree',
  is_leader: true,
  is_readonly: false,
  session_expired: false,
  absolute_delay: 0,
  readonly_for: 0,
  queue_size: 0,
  inserts_in_queue: 0,
  merges_in_queue: 0,
  behind_log: 0,
  total_replicas: 1,
  active_replicas: 1,
  lost_parts: 0,
  oldest_queued: '1970-01-01 00:00:00',
  queue_exception: '',
  zookeeper_exception: '',
  ...over,
})

describe('replicaConcerns', () => {
  it('says nothing about replicas that are keeping up', () => {
    expect(replicaConcerns({ available: true, replicas: [replica()] })).toEqual([])
  })

  it('says nothing when it cannot see system.replicas', () => {
    // "Cannot tell" is not "everything is fine", and it is not a concern either.
    expect(replicaConcerns({ available: false, reason: 'no grant', replicas: [] })).toEqual([])
    expect(replicaConcerns(undefined)).toEqual([])
  })

  it('raises a read-only replica as broken, and points at its own tab', () => {
    const items = replicaConcerns({
      available: true,
      replicas: [replica({ is_readonly: true, session_expired: true })],
    })
    expect(items).toHaveLength(1)
    const [item] = items as [(typeof items)[number]]
    expect(item.concern).toBe('broken')
    expect(item.name).toBe('analytics.rep_events')
    // Infrastructure's page, not Data's: the space that can act on it owns the
    // link, and `countIn` files the concern by reading this very path.
    expect(item.to).toBe('/infra/replication')
  })

  it('raises falling behind as partial, not as an alarm', () => {
    const items = replicaConcerns({ available: true, replicas: [replica({ behind_log: 40 })] })
    expect(items.map((i) => i.concern)).toEqual(['partial'])
  })

  it('keeps the line short enough to sit on one row', () => {
    const items = replicaConcerns({
      available: true,
      replicas: [replica({ is_readonly: true, readonly_for: 3600 })],
    })
    expect(items.every((i) => i.says.length <= 96)).toBe(true)
  })
})
