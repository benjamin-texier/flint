import { describe, expect, it } from 'vitest'
import {
  actualWindow,
  trafficIndex,
  trafficMax,
  usageIndex,
  diskVerdict,
  notable,
  progressOf,
  usableFree,
  type Disk,
  type Running,
  compressionVerdict,
  costShare,
  editorLink,
  everRead,
  partitionVerdict,
  percent,
  scanShare,
  scanVerdict,
  type Pattern,
  type Summary,
  type TableTraffic,
  type Thresholds,
  timeSpent,
} from './diagnose'

const thresholds: Thresholds = { delay_insert: 1000, throw_insert: 3000, from_server: true }

const traffic = (over: Partial<TableTraffic> = {}): TableTraffic => ({
  qualified: 'a.b',
  reads: 10,
  writes: 0,
  read_rows: 1000,
  read_bytes: 0,
  avg_ms: 1,
  readers: 1,
  last_read: '2026-08-01 00:00:00',
  ...over,
})

const pattern = (total_ms: number): Pattern => ({
  hash: String(total_ms),
  runs: 1,
  failures: 0,
  avg_ms: total_ms,
  p95_ms: total_ms,
  max_ms: total_ms,
  total_ms,
  read_bytes: 0,
  read_rows: 0,
  peak_memory: 0,
  users: 1,
  last_seen: '2026-08-01 00:00:00',
  sample: 'SELECT 1',
  tables: [],
})

describe('everRead', () => {
  it('reads the epoch as never', () => {
    expect(everRead('1970-01-01 00:00:00')).toBe(false)
    expect(everRead('')).toBe(false)
    expect(everRead('2026-08-01 12:00:00')).toBe(true)
  })
})

describe('partitionVerdict', () => {
  it('uses the server thresholds, not remembered defaults', () => {
    // The documented defaults are 150/300 on some builds and 1000/3000 on
    // others; judging against the wrong pair invents alarms.
    const tight: Thresholds = { delay_insert: 150, throw_insert: 300, from_server: true }
    expect(partitionVerdict(200, tight).level).toBe('delay')
    expect(partitionVerdict(200, thresholds).level).toBe('ok')
  })

  it('escalates through watch, delay and throw', () => {
    expect(partitionVerdict(10, thresholds).level).toBe('ok')
    expect(partitionVerdict(600, thresholds).level).toBe('watch')
    expect(partitionVerdict(1000, thresholds).level).toBe('delay')
    expect(partitionVerdict(3000, thresholds).level).toBe('throw')
  })

  it('names the number it judged against', () => {
    expect(partitionVerdict(1200, thresholds).says).toContain('1000')
    expect(partitionVerdict(4000, thresholds).says).toContain('3000')
  })
})

describe('compressionVerdict', () => {
  it('flags only what is unusual', () => {
    expect(compressionVerdict(1.1).level).toBe('watch')
    expect(compressionVerdict(4).level).toBe('ok')
    expect(compressionVerdict(35).says).toContain('unusually well')
  })

  it('says nothing about an empty table', () => {
    expect(compressionVerdict(0).says).toBe('nothing stored yet')
  })
})

describe('scanShare', () => {
  it('is the average rows per read over the table size', () => {
    expect(scanShare(traffic({ reads: 10, read_rows: 1000 }), 1000)).toBeCloseTo(0.1)
    expect(scanShare(traffic({ reads: 2, read_rows: 2000 }), 1000)).toBeCloseTo(1)
  })

  it('has no answer without a divisor', () => {
    expect(scanShare(traffic({ reads: 0 }), 1000)).toBeNull()
    expect(scanShare(traffic(), 0)).toBeNull()
  })

  it('calls a full-table read what it is', () => {
    expect(scanVerdict(1).says).toContain('whole table')
    expect(scanVerdict(0.1).level).toBe('ok')
  })
})

describe('costShare', () => {
  it('ranks by total time, so a frequent cheap query outweighs a rare slow one', () => {
    const frequent = pattern(9000)
    const rare = pattern(1000)
    expect(costShare(frequent, [frequent, rare])).toBeCloseTo(0.9)
    expect(costShare(rare, [frequent, rare])).toBeCloseTo(0.1)
  })

  it('does not divide by zero on an idle server', () => {
    const idle = pattern(0)
    expect(costShare(idle, [idle])).toBe(0)
  })
})

describe('editorLink', () => {
  it('opens the statement against the database its tables live in', () => {
    const link = editorLink({ ...pattern(10), sample: 'SELECT 1', tables: ['analytics.events'] })
    expect(link).toContain('database=analytics')
    expect(link).toContain('sql=SELECT+1')
  })

  it('leaves the database out when the pattern names no qualified table', () => {
    const link = editorLink({ ...pattern(10), sample: 'SELECT 1', tables: [] })
    expect(link).not.toContain('database=')
  })

  it('collapses the padding a logged statement arrives with, keeping its lines', () => {
    const link = editorLink({ ...pattern(10), sample: 'SELECT 1,\n     2', tables: [] })
    expect(decodeURIComponent(link.replace(/\+/g, ' '))).toContain('SELECT 1,\n 2')
  })
})

describe('timeSpent', () => {
  it('is the denominator behind the shares', () => {
    const patterns = [pattern(9000), pattern(1000)]
    expect(timeSpent(patterns)).toBe(10_000)
    expect(costShare(patterns[0]!, patterns)).toBeCloseTo(patterns[0]!.total_ms / timeSpent(patterns))
  })

  it('is zero for nothing at all', () => {
    expect(timeSpent([])).toBe(0)
  })
})

describe('actualWindow', () => {
  const summary = (since: string, queries = 5): Summary => ({
    queries,
    failures: 0,
    selects: queries,
    inserts: 0,
    read_bytes: 0,
    read_rows: 0,
    avg_ms: 1,
    p95_ms: 1,
    max_ms: 1,
    users: 1,
    since,
  })

  it('reports the asked window when the log really goes back that far', () => {
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
    expect(actualWindow(summary(old), 7)).toBe('7 days')
  })

  it('says so when the log is shorter than the question', () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
    expect(actualWindow(summary(recent), 30)).toContain('all the log keeps')
  })

  it('falls back to the asked window with nothing logged', () => {
    expect(actualWindow(null, 7)).toBe('7 days')
    expect(actualWindow(summary('1970-01-01 00:00:00', 0), 7)).toBe('7 days')
  })
})

describe('percent', () => {
  it('keeps a digit where rounding would say zero', () => {
    expect(percent(0.46)).toBe('46%')
    expect(percent(0.043)).toBe('4.3%')
    expect(percent(0.0001)).toBe('<1%')
  })
})

describe('trafficIndex', () => {
  const rows = [
    { ...traffic(), qualified: 'analytics.events', reads: 30 },
    { ...traffic(), qualified: 'analytics.devices', reads: 4 },
    { ...traffic(), qualified: 'reference.cities', reads: 900 },
  ]

  it('keeps same-named tables in different databases apart', () => {
    const index = trafficIndex([
      { ...traffic(), qualified: 'analytics.events', reads: 30 },
      { ...traffic(), qualified: 'reference.events', reads: 900 },
    ])
    expect(index.get('analytics.events')?.reads).toBe(30)
    expect(index.get('reference.events')?.reads).toBe(900)
  })

  it('is empty rather than undefined with no report', () => {
    expect(trafficIndex(undefined).size).toBe(0)
  })

  it('reaches an object the diagram borrows from another database', () => {
    const index = trafficIndex(rows)
    expect(index.get('reference.cities')?.reads).toBe(900)
  })
})

describe('trafficMax', () => {
  const index = trafficIndex([
    { ...traffic(), qualified: 'analytics.events', reads: 30 },
    { ...traffic(), qualified: 'analytics.devices', reads: 4 },
    { ...traffic(), qualified: 'elsewhere.busy', reads: 5000 },
  ])

  it('scales only against the objects it was given', () => {
    // `elsewhere.busy` is not on this diagram, so it must not shrink the bars.
    const nodes = [
      { database: 'analytics', name: 'events' },
      { database: 'analytics', name: 'devices' },
    ]
    expect(trafficMax(index, nodes)).toBe(30)
  })

  it('never returns a scale of nothing', () => {
    expect(trafficMax(index, [])).toBe(0)
    expect(trafficMax(index, [{ database: 'analytics', name: 'unheard_of' }])).toBe(0)
  })
})

describe('usageIndex', () => {
  const usage = (slug: string, calls: number) => ({
    slug,
    calls,
    failures: 0,
    avg_ms: 1,
    p95_ms: 1,
    read_rows: 0,
    read_bytes: 0,
    last_call: '2026-08-01 00:00:00',
  })

  it('keys usage by slug', () => {
    const index = usageIndex({
      available: true,
      window_days: 7,
      usage: [usage('a', 3), usage('b', 1)],
    })
    expect(index.get('a')?.calls).toBe(3)
    expect(index.get('missing')).toBeUndefined()
  })

  it('is empty when the log cannot be read, so nothing reads as zero calls', () => {
    // The distinction the page depends on: "not called" and "we cannot tell"
    // must not look the same.
    expect(usageIndex({ available: false, reason: 'no grant', window_days: 7, usage: [] }).size).toBe(0)
    expect(usageIndex(undefined).size).toBe(0)
  })
})

describe('progressOf', () => {
  const running = (over: Partial<Running> = {}): Running => ({
    query_id: 'q',
    user: 'default',
    query: 'SELECT 1',
    kind: 'Select',
    database: 'analytics',
    elapsed: 1,
    read_rows: 0,
    read_bytes: 0,
    written_rows: 0,
    total_rows: 0,
    memory: 0,
    peak_memory: 0,
    threads: 1,
    cancelled: false,
    client: '',
    ...over,
  })

  it('is a share when ClickHouse has an estimate', () => {
    expect(progressOf(running({ read_rows: 50, total_rows: 200 }))).toBe(0.25)
  })

  it('is null when there is nothing to divide by', () => {
    // "We do not know yet" is not "no progress", and a bar at zero would say
    // the second.
    expect(progressOf(running({ read_rows: 50, total_rows: 0 }))).toBeNull()
  })

  it('never exceeds one, since the estimate can be low', () => {
    expect(progressOf(running({ read_rows: 300, total_rows: 200 }))).toBe(1)
  })
})

describe('diskVerdict', () => {
  const disk = (over: Partial<Disk> = {}): Disk => ({
    name: 'default',
    path: '/var/lib/clickhouse/',
    free: 500,
    total: 1000,
    keep_free: 0,
    kind: 'Local',
    read_only: false,
    broken: false,
    ...over,
  })

  it('discounts the margin ClickHouse keeps', () => {
    // 100 free of 1000, but 90 of it is reserved: 1% usable, not 10%.
    expect(usableFree(disk({ free: 100, keep_free: 90 }))).toBe(10)
    expect(diskVerdict(disk({ free: 100, keep_free: 90 })).level).toBe('throw')
    expect(diskVerdict(disk({ free: 100, keep_free: 0 })).level).toBe('watch')
  })

  it('escalates as it fills', () => {
    expect(diskVerdict(disk({ free: 500 })).level).toBe('ok')
    expect(diskVerdict(disk({ free: 100 })).level).toBe('watch')
    expect(diskVerdict(disk({ free: 20 })).level).toBe('throw')
  })

  it('puts a broken disk above everything, including a full one', () => {
    expect(diskVerdict(disk({ broken: true, free: 900 })).says).toContain('broken')
  })

  it('mentions read-only, which is not the same as full', () => {
    expect(diskVerdict(disk({ read_only: true })).says).toContain('read-only')
  })

  it('says nothing it cannot know', () => {
    expect(diskVerdict(disk({ total: 0 })).says).toBe('no size reported')
  })
})

describe('notable', () => {
  const q = (over: Partial<Running>) =>
    ({
      query_id: 'q', user: 'u', query: '', kind: '', database: '', elapsed: 0,
      read_rows: 0, read_bytes: 0, written_rows: 0, total_rows: 0, memory: 0,
      peak_memory: 0, threads: 1, cancelled: false, client: '', ...over,
    }) as Running

  it('notices a long query or a hungry one', () => {
    expect(notable(q({ elapsed: 45 }))).toBe(true)
    expect(notable(q({ memory: 2_000_000_000 }))).toBe(true)
  })

  it('leaves an ordinary query alone', () => {
    expect(notable(q({ elapsed: 2, memory: 10_000 }))).toBe(false)
  })
})
