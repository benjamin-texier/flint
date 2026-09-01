import { describe, expect, it } from 'vitest'

import {
  fromBackups,
  fromDetached,
  fromHeavy,
  fromQueries,
  fromStorage,
  fromTraffic,
  couldHaveBeen,
  rank,
  saysReport,
  saysSession,
  sessionWindow,
  type Finding,
} from './checkup'

const finding = (over: Partial<Finding>): Finding => ({
  id: 'x',
  area: 'server',
  urgency: 'worth',
  title: 't',
  why: 'w',
  evidence: 'e',
  gain: { kind: 'none' },
  ...over,
})

describe('rank', () => {
  it('puts what is happening now above what is worth doing', () => {
    // Not two points on one scale: a failure is not a trade-off the reader has
    // to weigh, and a wasteful column is nothing else.
    const out = rank([
      finding({ id: 'a', urgency: 'worth', gain: { kind: 'bytes', n: 1e12 } }),
      finding({ id: 'b', urgency: 'now' }),
    ])
    expect(out.map((f) => f.id)).toEqual(['b', 'a'])
  })

  it('never compares a gain against one measured in another unit', () => {
    /* The whole reason there is no score. A hundred gigabytes and four seconds
       are not orderable, so they are kept in their own runs and only sorted
       against their own kind. */
    const out = rank([
      finding({ id: 'sec', gain: { kind: 'seconds', n: 4 } }),
      finding({ id: 'big', gain: { kind: 'bytes', n: 100e9 } }),
      finding({ id: 'small', gain: { kind: 'bytes', n: 1 } }),
    ])
    const bytes = out.filter((f) => f.gain.kind === 'bytes').map((f) => f.id)
    expect(bytes).toEqual(['big', 'small'])
  })

  it('sorts a finding with no quantity last, and not because it matters less', () => {
    const out = rank([
      finding({ id: 'none' }),
      finding({ id: 'some', gain: { kind: 'bytes', n: 5 } }),
    ])
    expect(out.map((f) => f.id)).toEqual(['some', 'none'])
  })

  it('leaves the order of failures alone', () => {
    // Flint has no basis for telling somebody which of their failures matters
    // more, so it does not pretend to.
    const now = [finding({ id: '1', urgency: 'now' }), finding({ id: '2', urgency: 'now' })]
    expect(rank(now).map((f) => f.id)).toEqual(['1', '2'])
  })
})

describe('fromQueries', () => {
  const pattern = (over: Record<string, unknown> = {}) => ({
    hash: 'h1',
    runs: 10,
    failures: 0,
    avg_ms: 10,
    p95_ms: 20,
    max_ms: 30,
    total_ms: 1000,
    read_bytes: 0,
    read_rows: 500,
    peak_memory: 0,
    users: 1,
    last_seen: 'now',
    sample: 'SELECT 1',
    tables: ['a.b'],
    ...over,
  })
  const report = (over: Record<string, unknown> = {}) =>
    ({
      available: true,
      window_days: 7,
      window_seconds: 7 * 86400,
      summary: null,
      patterns: [],
      failures: [],
      ...over,
    }) as Parameters<typeof fromQueries>[0]

  it('says nothing at all when the query log cannot be read', () => {
    expect(fromQueries(report({ available: false }))).toEqual([])
  })

  it('does not open with other people’s typos', () => {
    /* Forced by a real server: the first run reported 2,368
       UNKNOWN_IDENTIFIER and 52 SYNTAX_ERROR as things happening now, and
       every one was somebody typing in an editor. Eight rows of that is a
       checkup nobody reads to the end. */
    const out = fromQueries(
      report({
        failures: [
          { code: 47, name: 'UNKNOWN_IDENTIFIER', occurrences: 2368, last_seen: 'x', sample: 's', message: 'm' },
          { code: 62, name: 'SYNTAX_ERROR', occurrences: 52, last_seen: 'x', sample: 's', message: 'm' },
        ],
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.urgency).toBe('worth')
    expect(out[0]!.title).toBe('2420 statements were rejected as malformed')
  })

  it('reports a code it has never heard of, rather than assuming it is a typo', () => {
    // A denylist and not an allowlist, on purpose: ClickHouse adds error
    // codes, and an unfamiliar one is likelier to be a real problem than a
    // new way of mistyping.
    const out = fromQueries(
      report({
        failures: [
          { code: 99999, name: 'SOMETHING_NEW', occurrences: 1, last_seen: 'x', sample: 's', message: 'm' },
        ],
      }),
    )
    expect(out[0]!.urgency).toBe('now')
  })

  it('reports a failure as happening now, whatever it cost', () => {
    const out = fromQueries(
      report({
        failures: [
          {
            code: 241,
            name: 'MEMORY_LIMIT_EXCEEDED',
            occurrences: 3,
            last_seen: 'x',
            sample: 's',
            message: 'ran out',
          },
        ],
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.urgency).toBe('now')
    expect(out[0]!.title).toContain('MEMORY_LIMIT_EXCEEDED')
    expect(out[0]!.title).toContain('3 times')
  })

  it('ranks the costly shapes by total time, not by the slowest run', () => {
    /* A statement taking four seconds twice a day is not the problem a
       statement taking eighty milliseconds a million times is, and max_ms
       ranks them the wrong way round. */
    const out = fromQueries(
      report({
        patterns: [
          pattern({ hash: 'slow-once', total_ms: 100, max_ms: 9999 }),
          pattern({ hash: 'fast-often', total_ms: 900, max_ms: 5 }),
        ],
      }),
    )
    expect(out.map((f) => f.id)).toEqual(['queries:costly:fast-often', 'queries:costly:slow-once'])
  })

  it('leaves out a shape that is a rounding error of the workload', () => {
    const out = fromQueries(
      report({
        patterns: [pattern({ hash: 'big', total_ms: 9900 }), pattern({ hash: 'tiny', total_ms: 10 })],
      }),
    )
    expect(out.map((f) => f.id)).toEqual(['queries:costly:big'])
  })

  it('measures the gain in seconds, since that is what it would give back', () => {
    const out = fromQueries(report({ patterns: [pattern({ total_ms: 2500 })] }))
    expect(out[0]!.gain).toEqual({ kind: 'seconds', n: 2.5 })
  })
})

describe('fromTraffic', () => {
  const unused = (qualified: string, bytes: number) => ({
    qualified,
    engine: 'MergeTree',
    row_count: 10,
    bytes,
    last_write: 'then',
  })
  const report = (list: ReturnType<typeof unused>[]) =>
    ({ available: true, window_days: 7, window_seconds: 7 * 86400, unused: list }) as unknown as Parameters<typeof fromTraffic>[0]

  it('ignores a small unread table, because every server has forty', () => {
    expect(fromTraffic(report([unused('a.small', 1024)]))).toEqual([])
  })

  it('reports a large one, and refuses to tell anybody to drop it', () => {
    // A table read by a monthly report is unread in a week, which is the
    // mistake this finding would otherwise cost somebody their data over.
    const out = fromTraffic(report([unused('a.big', 500 * 1024 * 1024)]))
    expect(out).toHaveLength(1)
    expect(out[0]!.why).not.toMatch(/drop/i)
    expect(out[0]!.why).toContain('monthly')
  })
})

describe('fromBackups', () => {
  it('says nothing at all when the log could not be read', () => {
    /* `available: false` here means only that Flint could not read
       `system.backups`. It used to produce "This Flint cannot take a backup"
       with the missing grant printed as the reason — a claim about the server
       built out of a fact about the reader, and one nothing can be done with:
       the answer to "you may not look" is a GRANT, not a backup policy. */
    const out = fromBackups({
      available: false,
      reason: 'this user is not granted SELECT on system.backups',
      persistent: false,
      object_storage: false,
      runs: [],
      disk: '',
    })
    expect(out).toEqual([])
  })

  it('still says a Flint with no destination has never backed anything up', () => {
    // The case the removed finding was written for, reported by the branch that
    // can actually tell: the log reads fine, and it is empty.
    const out = fromBackups({
      available: true,
      persistent: true,
      object_storage: false,
      runs: [],
      disk: '',
    })
    expect(out[0]!.id).toBe('risk:backups:none')
    expect(out[0]!.evidence).toContain('none named')
  })

  it('hedges an empty list where the log does not survive a restart', () => {
    /* `system.backups` is per-process, so an empty list is not proof that
       nothing was ever backed up — and saying it was would be the kind of
       claim somebody acts on. */
    const volatile = fromBackups({
      available: true,
      persistent: false,
      object_storage: false,
      runs: [],
      disk: 'backups',
    })
    expect(volatile[0]!.why).toContain('does not survive a restart')
    const durable = fromBackups({
      available: true,
      persistent: true,
      object_storage: false,
      runs: [],
      disk: 'backups',
    })
    expect(durable[0]!.why).toContain('goes back further')
  })

  it('says nothing where backups have been taken', () => {
    expect(
      fromBackups({
        available: true,
        persistent: true,
        object_storage: false,
        runs: [{} as never],
        disk: 'backups',
      }),
    ).toEqual([])
  })
})

describe('fromDetached', () => {
  const report = (total: number, quarantined: number) =>
    ({
      available: true,
      parts: [],
      total,
      total_bytes: 4096,
      quarantined,
    }) as Parameters<typeof fromDetached>[0]

  it('keeps a fault apart from a decision', () => {
    // Something ClickHouse quarantined is a fault; something a person detached
    // is waiting for them. Opposite meanings, so opposite urgencies.
    const out = fromDetached(report(5, 2))
    expect(out.map((f) => [f.id, f.urgency])).toEqual([
      ['server:detached:quarantined', 'now'],
      ['server:detached:by-hand', 'worth'],
    ])
  })

  it('says nothing when there are none', () => {
    expect(fromDetached(report(0, 0))).toEqual([])
  })
})

describe('fromStorage', () => {
  const report = (parts: number) =>
    ({
      available: true,
      tables: [],
      thresholds: { delay_insert: 150, throw_insert: 300, active_parts: 0 },
      partitions: [
        {
          qualified: 'a.b',
          database: 'a',
          table: 'b',
          partition_id: 'p',
          partition: '2026-01',
          parts,
          row_count: 1,
          bytes: 1,
        },
      ],
    }) as unknown as Parameters<typeof fromStorage>[0]

  it('uses the server’s own tolerance rather than a number invented here', () => {
    // A server tuned to accept more parts is not told it is in trouble.
    expect(fromStorage(report(10))).toEqual([])
    expect(fromStorage(report(200))).toHaveLength(1)
  })

  it('calls a partition past the threshold something happening now', () => {
    const out = fromStorage(report(400))
    expect(out[0]!.urgency).toBe('now')
    expect(out[0]!.evidence).toContain('300')
  })
})

describe('fromHeavy', () => {
  const heavy = (bytes: number) =>
    ({
      database: 'analytics',
      columns_total: 1,
      visible: bytes,
      on_disk: bytes,
      compact_parts: 0,
      parts: 1,
      columns: [
        { table: 'events', column: 'payload', type: 'String', compressed: bytes, uncompressed: bytes * 3 },
      ],
    }) as Parameters<typeof fromHeavy>[0][number]

  it('leaves a small column alone', () => {
    expect(fromHeavy([heavy(1024)])).toEqual([])
  })

  it('proposes nothing, because metadata cannot say the type is wrong', () => {
    /* Knowing a String occupies 40 GB does not say it is the wrong type —
       that takes reading the values, which the review does and this page has
       not been asked to. So the finding is where to look. */
    const out = fromHeavy([heavy(40 * 1024 * 1024 * 1024)])
    expect(out).toHaveLength(1)
    expect(out[0]!.why).toContain('a question about the values')
    expect(out[0]!.act?.to).toContain('tab=review')
    expect(out[0]!.gain.kind).toBe('bytes')
  })
})

describe('saysReport', () => {
  it('counts the two offers separately, because they are different offers', () => {
    const said = saysReport(
      [finding({ urgency: 'now' }), finding({}), finding({})],
      0,
    )
    expect(said).toBe('1 thing is happening now, 2 are worth doing.')
  })

  it('says what is still coming rather than implying it is done', () => {
    expect(saysReport([], 3)).toBe('Reading 3 things about this server.')
    expect(saysReport([finding({})], 2)).toContain('2 more still reading')
  })

  it('does not celebrate an empty report', () => {
    // An indicator that is always lit is not an indicator; nor is one that
    // congratulates.
    expect(saysReport([], 0)).toBe('Nothing on this server is asking to be changed.')
  })
})

describe('couldHaveBeen', () => {
  const shape = (over: Record<string, number | string[]>) => ({
    read_rows: 0,
    read_bytes: 0,
    runs: 1,
    total_ms: 1,
    tables: [],
    ...over,
  }) as Parameters<typeof couldHaveBeen>[0]

  it('names a scan by the rows each run reads, and calls it a question', () => {
    // Not proof: a genuine aggregate over a million rows reads a million rows.
    const said = couldHaveBeen(shape({ runs: 4, read_rows: 8_000_000 }), 60)
    expect(said).toContain('2,000,000 rows')
    expect(said).toContain('If it filters')
  })

  it('recognises a loop by its rate, which only a window can measure', () => {
    /* 120 runs of one shape is a loop inside a minute and nothing across a
       week, so the rate is the finding and the count is not.

       The first version looked for few rows per run and could never have
       fired: measured on a real point lookup returning three rows,
       `read_rows` was 25,600 — three granules, because in ClickHouse the
       floor for a read is a granule. */
    const inAMinute = couldHaveBeen(shape({ runs: 120, read_rows: 3_072_000 }), 60)
    expect(inAMinute).toContain('120 runs — 2 a second')
    expect(inAMinute).toContain('IN or a JOIN')
    expect(couldHaveBeen(shape({ runs: 120, read_rows: 3_072_000 }), 7 * 86400)).toBeNull()
  })

  it('recognises cheap-each-time and enormous-in-total', () => {
    const said = couldHaveBeen(shape({ runs: 900, read_rows: 900 * 500, total_ms: 900 * 20 }), 7 * 86400)
    expect(said).toContain('materialised view')
  })

  it('says nothing about an ordinary statement', () => {
    expect(couldHaveBeen(shape({ runs: 5, read_rows: 500, total_ms: 400 }), 7 * 86400)).toBeNull()
  })

  it('never claims anything a parser would be needed for', () => {
    /* "This should have a LIMIT" needs to know whether it has one, and that
       means parsing SQL — which this codebase refuses. Every reading here is
       arithmetic over what the log already measured. */
    const all = [
      couldHaveBeen(shape({ runs: 4, read_rows: 8_000_000 }), 60),
      couldHaveBeen(shape({ runs: 300, read_rows: 3000 }), 60),
      couldHaveBeen(shape({ runs: 900, read_rows: 450000, total_ms: 18000 }), 7 * 86400),
    ].join(' ')
    expect(all).not.toMatch(/LIMIT|SELECT \*|WHERE/i)
  })
})

describe('sessionWindow', () => {
  it('is nothing without a mark', () => {
    expect(sessionWindow(null)).toBeNull()
  })

  it('rounds up, because the log row is written after the statement ends', () => {
    // A second of slack costs nothing; the alternative is a missing row
    // nobody can explain.
    expect(sessionWindow(1000, 1000 + 90_400)).toBe(92)
  })

  it('never asks for less than a minute', () => {
    // Shorter than that catches the clock skew, not the work.
    expect(sessionWindow(1000, 1000 + 2000)).toBe(60)
  })
})

describe('saysSession', () => {
  it('uses the unit that suits the length', () => {
    expect(saysSession(0, 45_000)).toBe('45 seconds')
    expect(saysSession(0, 12 * 60_000)).toBe('12 minutes')
    expect(saysSession(0, 3 * 3600_000)).toBe('3.0 hours')
  })
})
