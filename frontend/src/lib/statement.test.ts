import { describe, expect, it } from 'vitest'

import {
  againstShape,
  counter,
  explainable,
  granuleFloor,
  hitRate,
  notable,
  phases,
  pruning,
  setting,
  verdicts,
  type Shape,
  type Statement,
  type StatementReport,
} from './statement'

const statement = (over: Partial<Statement> = {}): Statement => ({
  query_id: 'e3f1',
  outcome: 'QueryFinish',
  kind: 'Select',
  started: '2026-09-20 13:05:04',
  at: '2026-09-20 13:05:05',
  duration_ms: 414,
  user: 'analyst',
  query: 'SELECT count() FROM analytics.events WHERE ts > now() - INTERVAL 1 DAY',
  database: 'analytics',
  tables: ['analytics.events'],
  columns: ['analytics.events.ts'],
  projections: [],
  views: [],
  row_policies: [],
  read_rows: 176_269,
  read_bytes: 19_604_715,
  written_rows: 0,
  written_bytes: 0,
  result_rows: 24_413,
  result_bytes: 4_096,
  memory_usage: 49_856_944,
  peak_threads: 59,
  query_cache: 'None',
  exception_code: 0,
  exception: '',
  via_flint: false,
  log_comment: '',
  hash: '9007354443012340319',
  events: [],
  settings: [],
  flint_settings: 0,
  ...over,
})

const report = (over: Partial<StatementReport> = {}): StatementReport => ({
  available: true,
  window_days: 30,
  statement: statement(),
  running: false,
  stages: { items: [] },
  ...over,
})

const events = (pairs: Record<string, number>) =>
  Object.entries(pairs).map(([name, value]) => ({ name, value }))

const shape = (over: Partial<Shape> = {}): Shape => ({
  hash: '9007354443012340319',
  runs: 37,
  median_ms: 100,
  p95_ms: 300,
  max_ms: 900,
  failures: 0,
  window_days: 30,
  ...over,
})

describe('reading the counters', () => {
  it('treats a counter the server did not record as zero', () => {
    expect(counter(statement(), 'SelectedMarks')).toBe(0)
  })

  it('reads a setting the statement carried', () => {
    const s = statement({ settings: [{ name: 'max_threads', value: '8' }] })
    expect(setting(s, 'max_threads')).toBe('8')
    expect(setting(s, 'max_memory_usage')).toBeNull()
  })

  it('has no pruning to report for a statement that read no table', () => {
    // A `SELECT 1` records no Selected* totals at all, and an empty reading is
    // not a reading of zero: drawing "0 of 0 granules" would be a claim.
    expect(pruning(statement()).marks).toBeNull()
    expect(pruning(statement()).parts).toBeNull()
  })

  it('reports what was skipped where the totals are there', () => {
    const s = statement({
      events: events({
        SelectedParts: 3,
        SelectedPartsTotal: 11,
        SelectedMarks: 5,
        SelectedMarksTotal: 640,
        SelectedRanges: 7,
      }),
    })
    expect(pruning(s).marks).toEqual({ used: 5, total: 640 })
    expect(pruning(s).parts).toEqual({ used: 3, total: 11 })
    expect(pruning(s).ranges).toBe(7)
  })

  it('names only the counters worth a table, and leaves the rest to be folded', () => {
    const s = statement({ events: events({ SelectedMarks: 5, SomethingElse: 1, FileOpen: 3 }) })
    expect(notable(s).map((c) => c.name)).toEqual(['SelectedMarks', 'FileOpen'])
  })
})

describe('the phases before execution', () => {
  it('says nothing where the server counted none of them', () => {
    expect(phases(statement())).toEqual([])
  })

  it('adds execution as the remainder rather than reading a counter for it', () => {
    const s = statement({
      duration_ms: 414,
      events: events({ QueryParseMicroseconds: 79, QueryAnalysisMicroseconds: 146 }),
    })
    expect(phases(s)).toEqual([
      { name: 'Parsing', micros: 79 },
      { name: 'Analysis', micros: 146 },
      { name: 'Execution', micros: 414_000 - 225 },
    ])
  })

  it('clamps a remainder the rounding made negative', () => {
    // The counters are microseconds and the duration is milliseconds, so a
    // sub-millisecond statement can be made of more phase than duration.
    const s = statement({
      duration_ms: 1,
      events: events({ QueryParseMicroseconds: 900, QueryAnalysisMicroseconds: 800 }),
    })
    expect(phases(s).at(-1)).toEqual({ name: 'Execution', micros: 0 })
  })
})

describe('a cache hit rate', () => {
  it('is absent where the statement never touched that cache', () => {
    expect(hitRate(statement(), 'MarkCacheHits', 'MarkCacheMisses')).toBeNull()
  })

  it('is hits over both, never hits over misses', () => {
    const s = statement({ events: events({ MarkCacheHits: 30, MarkCacheMisses: 10 }) })
    expect(hitRate(s, 'MarkCacheHits', 'MarkCacheMisses')).toEqual({ used: 30, total: 40 })
  })
})

describe('this run against its own shape', () => {
  it('says nothing below five runs, because a median of two is one of the two', () => {
    expect(againstShape(statement(), shape({ runs: 3 }))).toBeNull()
  })

  it('says nothing where there is no shape at all', () => {
    expect(againstShape(statement(), undefined)).toBeNull()
  })

  it('calls out a run several times its shape', () => {
    const v = againstShape(statement({ duration_ms: 400 }), shape({ median_ms: 100 }))
    expect(v?.tone).toBe('cost')
    expect(v?.text).toContain('4.0×')
  })

  it('warns that an unusually fast run is the wrong one to read', () => {
    const v = againstShape(statement({ duration_ms: 20 }), shape({ median_ms: 100 }))
    expect(v?.tone).toBe('note')
    expect(v?.text).toContain('faster')
  })

  it('confirms an ordinary run is a fair one to read', () => {
    const v = againstShape(statement({ duration_ms: 110 }), shape({ median_ms: 100 }))
    expect(v?.text).toContain('fair one to read')
  })
})

describe('the verdicts', () => {
  it('has nothing to say about a statement it was given none of', () => {
    expect(verdicts(report({ statement: null }))).toEqual([])
  })

  it('leads with the failure, and keeps only the first line of the exception', () => {
    const s = statement({
      exception_code: 241,
      exception: 'Memory limit exceeded\nWhile executing SELECT secret FROM vault',
    })
    const [first] = verdicts(report({ statement: s }))
    expect(first?.tone).toBe('cost')
    expect(first?.evidence).toBe('Memory limit exceeded')
  })

  it('credits a read that skipped most of the table', () => {
    const s = statement({
      events: events({ SelectedMarks: 5, SelectedMarksTotal: 640, SelectedParts: 3, SelectedPartsTotal: 11 }),
    })
    const said = verdicts(report({ statement: s }))
    // `>99%` rather than `99%`: five granules of 640 is 99.2% skipped, and
    // rounding a real difference to a round number is the one thing the
    // percentage rule forbids.
    expect(said.some((v) => v.tone === 'good' && v.text.includes('skipped >99%'))).toBe(true)
  })

  it('calls a read that skipped nothing what it is', () => {
    const s = statement({ events: events({ SelectedMarks: 640, SelectedMarksTotal: 640 }) })
    const said = verdicts(report({ statement: s }))
    expect(said.some((v) => v.tone === 'cost' && v.text.includes('Nothing was skipped'))).toBe(true)
  })

  it('does not call a small read wasteful however lopsided the ratio', () => {
    // 1,000 rows to return one is a lookup, not a finding.
    const s = statement({ read_rows: 1_000, result_rows: 1 })
    expect(verdicts(report({ statement: s })).some((v) => v.text.includes('to return'))).toBe(false)
  })

  it('names the granule floor where the read could not have been smaller', () => {
    const s = statement({
      read_rows: 40_960,
      result_rows: 250,
      events: events({ SelectedMarks: 5 }),
    })
    // Below the million-row floor this says nothing at all, which is the point:
    // the floor exists so the page cannot complain about arithmetic.
    expect(verdicts(report({ statement: s })).some((v) => v.text.includes('to return'))).toBe(false)
    expect(granuleFloor(s)).toBe(40_960)
  })

  it('reports a big read that returned nothing without calling it a failure', () => {
    const s = statement({ read_rows: 5_000_000, result_rows: 0 })
    const said = verdicts(report({ statement: s }))
    expect(said.some((v) => v.tone === 'note' && v.text.includes('returned none'))).toBe(true)
  })

  it('says a row policy decided what could be seen', () => {
    const s = statement({ row_policies: ['tenant_only ON analytics.events'] })
    expect(verdicts(report({ statement: s })).some((v) => v.text.includes('row policy'))).toBe(true)
  })

  it('credits a projection that answered instead of the table', () => {
    const s = statement({ projections: ['by_day'] })
    const said = verdicts(report({ statement: s }))
    expect(said.some((v) => v.tone === 'good' && v.text.includes('by_day'))).toBe(true)
  })

  it('reports planning that ate a short statement', () => {
    const s = statement({
      duration_ms: 12,
      events: events({ QueryPlanBuildMicroseconds: 10_560 }),
    })
    const said = verdicts(report({ statement: s }))
    expect(said.some((v) => v.text.includes('getting ready to run it'))).toBe(true)
  })

  it('says nothing about planning under a long statement', () => {
    const s = statement({
      duration_ms: 126_871,
      events: events({ QueryPlanBuildMicroseconds: 10_560 }),
    })
    const said = verdicts(report({ statement: s }))
    expect(said.some((v) => v.text.includes('getting ready to run it'))).toBe(false)
  })

  it('warns where a statement nearly hit the memory it was allowed', () => {
    const s = statement({
      memory_usage: 900,
      settings: [{ name: 'max_memory_usage', value: '1000' }],
    })
    const said = verdicts(report({ statement: s }))
    expect(said.some((v) => v.tone === 'cost' && v.text.includes('memory it was allowed'))).toBe(true)
  })

  it('says nothing about memory where no ceiling was carried', () => {
    // The figure alone has no scale, which is B3's rule about every gauge on
    // the health page and is no less true here.
    const said = verdicts(report({ statement: statement({ memory_usage: 9_000_000_000 }) }))
    expect(said.some((v) => v.text.includes('memory it was allowed'))).toBe(false)
  })

  it('reports a mark cache missing more than it hits, once there is enough of it', () => {
    const few = statement({ events: events({ MarkCacheHits: 1, MarkCacheMisses: 9 }) })
    expect(verdicts(report({ statement: few })).some((v) => v.text.includes('mark cache'))).toBe(false)
    const many = statement({ events: events({ MarkCacheHits: 10, MarkCacheMisses: 990 }) })
    expect(verdicts(report({ statement: many })).some((v) => v.text.includes('mark cache'))).toBe(true)
  })
})

describe('putting a logged statement behind EXPLAIN', () => {
  it('drops the FORMAT the log kept, which EXPLAIN will not take', () => {
    expect(explainable('SELECT 1 FROM t FORMAT TSV')).toBe('SELECT 1 FROM t')
    expect(explainable('SELECT 1 FROM t format JSONEachRow  ')).toBe('SELECT 1 FROM t')
  })

  it('drops a trailing semicolon', () => {
    expect(explainable('SELECT 1;')).toBe('SELECT 1')
  })

  it('does not reach inside a string that ends in one', () => {
    // The closing quote is not part of a bare word, so the pattern cannot
    // match — which is the whole of why it is anchored and narrow.
    expect(explainable("SELECT 1 WHERE x = 'a FORMAT TSV'")).toBe(
      "SELECT 1 WHERE x = 'a FORMAT TSV'",
    )
  })

  it('leaves a FORMAT that is not at the end alone', () => {
    expect(explainable('SELECT formatDateTime(ts, FORMAT) FROM t')).toBe(
      'SELECT formatDateTime(ts, FORMAT) FROM t',
    )
  })
})
