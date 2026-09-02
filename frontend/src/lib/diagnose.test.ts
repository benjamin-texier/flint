import { describe, expect, it } from 'vitest'
import {
  actualWindow,
  compressionVerdict,
  costShare,
  databaseOf,
  diskVerdict,
  editorLink,
  loadBars,
  saysBucket,
  everRead,
  notable,
  partitionVerdict,
  percent,
  progressOf,
  projectionsLink,
  scanShare,
  scanVerdict,
  splitQualified,
  tableLink,
  timeSpent,
  trafficIndex,
  trafficMax,
  type Disk,
  type Pattern,
  type Running,
  type Summary,
  type TableTraffic,
  type Thresholds,
  usableFree,
  usageIndex,
  worthAskingAboutProjections,
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

describe('databaseOf', () => {
  const pattern = (tables: string[]) => ({ tables, sample: 'SELECT 1' }) as never

  it('takes the database from the first qualified table', () => {
    expect(databaseOf(pattern(['analytics.events', 'other.x']))).toBe('analytics')
  })

  it('answers undefined when nothing was qualified', () => {
    // Then the statement resolves against whatever the caller's default is,
    // which is the honest answer rather than a guess at one.
    expect(databaseOf(pattern(['events']))).toBeUndefined()
    expect(databaseOf(pattern([]))).toBeUndefined()
  })

  it('is the same answer the editor link uses, so re-running and explaining agree', () => {
    const p = pattern(['analytics.events'])
    expect(editorLink(p)).toContain('database=analytics')
    expect(editorLink(p)).toContain(databaseOf(p)!)
  })
})

describe('where a logged table name leads', () => {
  it('splits on the first dot, which is where the log puts it', () => {
    expect(splitQualified('analytics.events')).toEqual({
      database: 'analytics',
      table: 'events',
    })
    // A table whose name contains a dot: the log writes it unquoted, so the
    // first dot is the only boundary there is to find.
    expect(splitQualified('lab.odd.name')).toEqual({ database: 'lab', table: 'odd.name' })
  })

  it('answers null rather than guessing at anything that is not two parts', () => {
    // The callers turn this into a link, and a link to the wrong table is
    // worse than no link at all.
    expect(splitQualified('numbers')).toBeNull()
    expect(splitQualified('.events')).toBeNull()
    expect(splitQualified('analytics.')).toBeNull()
    expect(tableLink('numbers')).toBeNull()
    expect(projectionsLink('numbers')).toBeNull()
  })

  it('encodes both halves, because a database may be named anything', () => {
    expect(tableLink('my db.my table')).toBe('/db/my%20db/my%20table')
    expect(projectionsLink('analytics.events')).toBe('/db/analytics/events?tab=projections')
  })
})

describe('when a scan share is worth a question', () => {
  it('needs the reads to cover most of the table', () => {
    expect(worthAskingAboutProjections(0.99, 5_000_000)).toBe(true)
    expect(worthAskingAboutProjections(0.34, 5_000_000)).toBe(false)
    expect(worthAskingAboutProjections(null, 5_000_000)).toBe(false)
  })

  it('and needs the table to be big enough for that to cost anything', () => {
    // A five-row lookup reads 100% of itself and always will. Asking whether a
    // projection would help it is not a question — it is advice, and it is
    // wrong. Found by looking at the page rather than by reasoning about it:
    // three of the six rows offering the link were dictionary sources.
    expect(worthAskingAboutProjections(1, 5)).toBe(false)
    expect(worthAskingAboutProjections(1, 400)).toBe(false)
    // Eight granules at the default 8,192, which is where reading the whole
    // table starts to be more than one gulp.
    expect(worthAskingAboutProjections(1, 65_536)).toBe(true)
    expect(worthAskingAboutProjections(1, 65_535)).toBe(false)
  })
})

describe('loadBars', () => {
  const b = (at: string, queries = 1) => ({
    at,
    queries,
    failures: 0,
    read_bytes: queries,
    total_ms: queries,
  })

  it('fills the gaps between the buckets that hold something', () => {
    const out = loadBars([b('2026-09-01 12:00:00', 5), b('2026-09-01 15:00:00', 3)], 3600)
    expect(out.map((x) => x.at)).toEqual([
      '2026-09-01 12:00:00',
      '2026-09-01 13:00:00',
      '2026-09-01 14:00:00',
      '2026-09-01 15:00:00',
    ])
    expect(out.map((x) => x.queries)).toEqual([5, 0, 0, 3])
  })

  /* The real answer from the dev server: 3-hour buckets over a 7-day window,
     with the log only covering about a day. */
  it('fills to the data, not to the window that was asked for', () => {
    const out = loadBars(
      [b('2026-09-01 12:00:00'), b('2026-09-01 15:00:00'), b('2026-09-02 06:00:00')],
      10_800,
    )
    expect(out).toHaveLength(7)
    expect(out[0]!.at).toBe('2026-09-01 12:00:00')
    expect(out[out.length - 1]!.at).toBe('2026-09-02 06:00:00')
    // Six days of empty columns in front of the data would invite the reader to
    // conclude the server was idle for them, when nothing was kept.
    expect(out.every((x) => x.at >= '2026-09-01 12:00:00')).toBe(true)
  })

  it('is empty where there is no shape to draw', () => {
    expect(loadBars([], 3600)).toEqual([])
    // One column is a figure with a chart around it.
    expect(loadBars([b('2026-09-01 12:00:00')], 3600)).toEqual([])
  })

  it('refuses a step it cannot use rather than looping', () => {
    const two = [b('2026-09-01 12:00:00'), b('2026-09-01 13:00:00')]
    expect(loadBars(two, 0)).toEqual([])
    expect(loadBars(two, -1)).toEqual([])
    expect(loadBars(two, NaN)).toEqual([])
  })

  /* A step and a span that would generate more columns than any page can lay
     out — a malformed pair, or a log with one very old entry. The held buckets
     come back unfilled rather than four hundred thousand columns. */
  it('hands back the held buckets rather than generating past its cap', () => {
    const out = loadBars([b('2020-01-01 00:00:00'), b('2026-09-01 00:00:00')], 60)
    expect(out).toHaveLength(2)
  })

  it('drops a stamp it cannot read rather than placing it at the epoch', () => {
    expect(loadBars([b('not a date'), b('also not')], 3600)).toEqual([])
    const out = loadBars([b('2026-09-01 12:00:00'), b('nonsense'), b('2026-09-01 13:00:00')], 3600)
    expect(out.map((x) => x.at)).toEqual(['2026-09-01 12:00:00', '2026-09-01 13:00:00'])
  })

  it('is ordered oldest first whatever order it was given', () => {
    const out = loadBars([b('2026-09-01 15:00:00', 3), b('2026-09-01 12:00:00', 5)], 10_800)
    expect(out.map((x) => x.queries)).toEqual([5, 3])
  })
})

describe('saysBucket', () => {
  it('names every period the server can send', () => {
    for (const [s, said] of [
      [60, 'a minute'],
      [3600, 'an hour'],
      [10_800, 'three hours'],
      [86_400, 'a day'],
      [604_800, 'a week'],
    ] as const) {
      expect(saysBucket(s)).toBe(said)
    }
  })

  it('falls back to the number rather than to nothing', () => {
    expect(saysBucket(137)).toBe('137 seconds')
  })
})
