import { describe, expect, it } from 'vitest'

import {
  MIN_HISTORY,
  costHeadlines,
  failureHeadlines,
  read,
  reach,
  structureHeadlines,
  subjectOf,
  usual,
  volumeHeadlines,
  type CostMove,
  type FailureMove,
  type NewsReport,
  type StructureChange,
  type VolumeMove,
} from './news'

/** A report with nothing in it, five whole prior periods behind it. The shapes
 *  below change one thing about it at a time, which is the only way to know
 *  which rule fired. */
const report = (over: Partial<NewsReport> = {}): NewsReport => ({
  available: true,
  reason: null,
  window_hours: 24,
  windows: 7,
  prior_windows_covered: 5,
  oldest: '2026-08-24 16:23:55',
  totals: { ms_now: 1000, runs_now: 500, prior_ms: [1000, 1000, 1000, 1000, 1000, 0] },
  cost: [],
  failures: [],
  structure: [],
  structure_total: 0,
  volume: { available: true, reason: null, prior_windows_covered: 5, tables: [] },
  ...over,
})

const cost = (over: Partial<CostMove> = {}): CostMove => ({
  hash: '1',
  kind: 'Select',
  sample: 'SELECT count() FROM analytics.events',
  tables: ['analytics.events'],
  ms_now: 0,
  runs_now: 10,
  users: 1,
  prior_ms: [0, 0, 0, 0, 0, 0],
  last_seen: '2026-08-30 12:00:00',
  ...over,
})

const failure = (over: Partial<FailureMove> = {}): FailureMove => ({
  code: 60,
  name: 'UNKNOWN_TABLE',
  now: 0,
  prior: [0, 0, 0, 0, 0, 0],
  last_seen: '2026-08-30 12:00:00',
  message: 'Code: 60. DB::Exception: Unknown table',
  sample: 'SELECT * FROM gone',
  ...over,
})

const volume = (over: Partial<VolumeMove> = {}): VolumeMove => ({
  qualified: 'analytics.events',
  rows_now: 0,
  bytes_now: 0,
  prior_rows: [0, 0, 0, 0, 0, 0],
  ...over,
})

const change = (over: Partial<StructureChange> = {}): StructureChange => ({
  at: '2026-08-30 09:00:00',
  user: 'ana',
  kind: 'Create',
  tables: ['analytics.rollup'],
  statement: 'CREATE TABLE analytics.rollup (…)',
  through_flint: false,
  ...over,
})

describe('usual', () => {
  it('refuses a baseline it does not have the history for', () => {
    expect(usual([9, 9, 9, 9, 9, 9], MIN_HISTORY - 1)).toBeNull()
    expect(usual([9, 9, 9, 9, 9, 9], 0)).toBeNull()
  })

  /** The rule the whole feature rests on. The tail of the array holds periods
   *  the log may not reach; counting those as zeros would manufacture a decline
   *  out of a retention limit. */
  it('reads only the periods the log wholly covers', () => {
    expect(usual([100, 100, 100, 0, 0, 0], 3)).toBe(100)
    expect(usual([100, 100, 100, 0, 0, 0], 6)).toBe(50)
  })

  it('takes the middle of an even count rather than a side of it', () => {
    expect(usual([10, 20, 30, 40, 0, 0], 4)).toBe(25)
  })
})

describe('cost', () => {
  it('says nothing about a statement that grew but costs nothing', () => {
    // 30 ms of a 1,000 ms period is 3%: tripled, and nobody's problem.
    const r = report({ cost: [cost({ ms_now: 30, prior_ms: [10, 10, 10, 10, 10, 0] })] })
    expect(costHeadlines(r)).toEqual([])
  })

  it('says nothing about the statement that always dominates', () => {
    // Half the server's time, every day, including this one. True, and not news.
    const r = report({ cost: [cost({ ms_now: 500, prior_ms: [500, 500, 500, 500, 500, 0] })] })
    expect(costHeadlines(r)).toEqual([])
  })

  it('reports one that has tripled and now holds a share worth holding', () => {
    const r = report({ cost: [cost({ ms_now: 400, prior_ms: [100, 100, 100, 100, 100, 0] })] })
    const h = (costHeadlines(r))[0]!
    expect(h.subject).toBe('analytics.events')
    expect(h.says).toContain('4.0×')
    expect(h.figure).toBe('40% of the time spent')
    // 40% of the server's time is the thing to look at first.
    expect(h.rank).toBe('act')
  })

  it('reports one that was not being run at all', () => {
    const r = report({ cost: [cost({ ms_now: 300, runs_now: 12 })] })
    const h = (costHeadlines(r))[0]!
    expect(h.says).toContain('was not being queried like this before')
    expect(h.rank).toBe('watch')
  })

  it('holds its tongue where there is no history to compare against', () => {
    const r = report({
      prior_windows_covered: 1,
      cost: [cost({ ms_now: 900, prior_ms: [0, 0, 0, 0, 0, 0] })],
    })
    expect(costHeadlines(r)).toEqual([])
  })
})

describe('subjectOf', () => {
  it('names the table, because that is what a reader recognises', () => {
    expect(subjectOf(cost())).toBe('analytics.events')
    expect(subjectOf(cost({ tables: ['a.b', 'c.d'] }))).toBe('a.b and 1 other')
    expect(subjectOf(cost({ tables: ['a.b', 'c.d', 'e.f'] }))).toBe('a.b and 2 others')
  })

  /** A `SYSTEM FLUSH LOGS` is attributed to no table, and sixty characters of
   *  normalised SQL is a fragment nobody can place. */
  it('falls back to the kind rather than to the statement', () => {
    expect(subjectOf(cost({ tables: [], kind: 'System' }))).toBe('a SYSTEM')
    expect(subjectOf(cost({ tables: [], kind: 'Select' }))).toBe('a statement')
  })
})

describe('failures', () => {
  it('ignores the one-off that is somebody learning the schema', () => {
    expect(failureHeadlines(report({ failures: [failure({ now: 3 })] }))).toEqual([])
  })

  it('ignores the daily background of mistyped columns', () => {
    const r = report({ failures: [failure({ now: 40, prior: [40, 38, 41, 39, 40, 0] })] })
    expect(failureHeadlines(r)).toEqual([])
  })

  /** The count is in the figure beside it; a sentence repeating it reads as two
   *  facts that happen to agree. */
  it('reports an error that was not happening before, without counting it twice', () => {
    const h = (failureHeadlines(report({ failures: [failure({ now: 120 })] })))[0]!
    expect(h.subject).toBe('UNKNOWN_TABLE')
    expect(h.rank).toBe('act')
    expect(h.says).toBe('started failing statements that were not failing before')
    expect(h.figure).toBe('120 failed')
  })

  it('reports one that has multiplied', () => {
    const r = report({ failures: [failure({ now: 300, prior: [50, 50, 50, 50, 50, 0] })] })
    const h = (failureHeadlines(r))[0]!
    expect(h.says).toContain('6.0×')
    expect(h.rank).toBe('watch')
  })
})

describe('structure', () => {
  it('says nothing when nothing was reshaped', () => {
    expect(structureHeadlines(report())).toEqual([])
  })

  it('summarises a migration rather than printing every statement of it', () => {
    const r = report({
      structure: [change(), change({ kind: 'Alter' }), change({ kind: 'Alter' })],
      structure_total: 3,
    })
    const h = (structureHeadlines(r))[0]!
    expect(h.says).toBe('changed — 1 created, 2 altered, by ana')
    expect(h.rank).toBe('note')
    expect(h.to).toBe('/infra/schema')
  })

  /** `a and b and 1 more` reads as three clauses of one list. It was on the
   *  screen before it was fixed. */
  it('lists dropped names without stacking two ands', () => {
    const r = report({
      structure: [
        change({ kind: 'Drop', tables: ['a.one'] }),
        change({ kind: 'Drop', tables: ['a.two'] }),
        change({ kind: 'Drop', tables: ['a.three'] }),
      ],
      structure_total: 3,
    })
    expect(structureHeadlines(r)[0]!.says).toContain('a.one, a.two and 1 more dropped')
  })

  it('names what was dropped, and asks to be acted on', () => {
    const r = report({
      structure: [change({ kind: 'Drop', tables: ['analytics.old'] })],
      structure_total: 1,
    })
    const h = (structureHeadlines(r))[0]!
    expect(h.says).toContain('analytics.old dropped')
    expect(h.rank).toBe('act')
  })

  /** Counts follow the list: a figure that counts what the list does not show
   *  is a figure nobody can reconcile. */
  it('says how much of the total it is showing when the list is capped', () => {
    const r = report({ structure: [change(), change()], structure_total: 24 })
    expect(structureHeadlines(r)[0]!.figure).toBe('2 of 24 statements')
  })

  /** One user in the two statements that came back is not one user in the
   *  twenty-four that ran. */
  it('does not name the person off a capped list', () => {
    const r = report({ structure: [change(), change()], structure_total: 24 })
    expect(structureHeadlines(r)[0]!.says).not.toContain('by ana')
  })
})

describe('volume', () => {
  /** The headline the whole feature is for: nothing else in Flint would ever
   *  have said this, because the table keeps serving reads. */
  it('reports a table that was written most days and took nothing', () => {
    const r = report({
      volume: {
        available: true,
        reason: null,
        prior_windows_covered: 5,
        tables: [volume({ prior_rows: [300, 300, 300, 300, 300, 0] })],
      },
    })
    const h = (volumeHeadlines(r))[0]!
    expect(h.rank).toBe('act')
    expect(h.says).toContain('took nothing')
    expect(h.figure).toBe('usually 300 rows')
    expect(h.to).toBe('/db/analytics/events')
  })

  /** A seed load six days ago is not a daily ingest, and calling it one would
   *  fire on every table on a freshly-loaded server. */
  it('is silent about a table loaded once and never again', () => {
    const r = report({
      volume: {
        available: true,
        reason: null,
        prior_windows_covered: 5,
        tables: [volume({ prior_rows: [5_300_000, 0, 0, 0, 0, 0] })],
      },
    })
    expect(volumeHeadlines(r)).toEqual([])
  })

  it('reports a table taking its first rows', () => {
    const r = report({
      volume: {
        available: true,
        reason: null,
        prior_windows_covered: 5,
        tables: [volume({ qualified: 'parking.v2', rows_now: 300_000, bytes_now: 2_365_778 })],
      },
    })
    const h = (volumeHeadlines(r))[0]!
    expect(h.says).toBe('took its first rows in this window')
    expect(h.figure).toBe('300 K rows, 2.3 MiB')
  })

  /** The same median-of-zero as the seed load above, but with rows today. A
   *  sentence saying "first rows" over a table written six days ago is
   *  contradicted by the page it links to. */
  it('does not call a resumed table a first arrival', () => {
    const r = report({
      volume: {
        available: true,
        reason: null,
        prior_windows_covered: 5,
        tables: [volume({ rows_now: 100, prior_rows: [5000, 0, 0, 0, 0, 0] })],
      },
    })
    expect(volumeHeadlines(r)).toEqual([])
  })

  it('reports a volume that moved in either direction', () => {
    const up = report({
      volume: {
        available: true,
        reason: null,
        prior_windows_covered: 5,
        tables: [volume({ rows_now: 4000, prior_rows: [1000, 1000, 1000, 1000, 1000, 0] })],
      },
    })
    expect(volumeHeadlines(up)[0]!.says).toContain('4.0× the rows')
    const down = report({
      volume: {
        available: true,
        reason: null,
        prior_windows_covered: 5,
        tables: [volume({ rows_now: 100, prior_rows: [1000, 1000, 1000, 1000, 1000, 0] })],
      },
    })
    expect(volumeHeadlines(down)[0]!.says).toContain('a fraction of the rows')
    expect(volumeHeadlines(down)[0]!.figure).toBe('100 against 1 K')
  })

  /** Measured on a real server: an error seen [366, 109, 1, 2, 0] times has a
   *  median of 2, and 1,141 today comes out as 571×. Correct, and nonsense. */
  it('stops quoting a multiplier the baseline cannot carry', () => {
    const r = report({ failures: [failure({ now: 1141, prior: [366, 109, 1, 2, 0, 0] })] })
    const h = failureHeadlines(r)[0]!
    expect(h.says).toBe('failed far more statements than it usually does')
    expect(h.figure).toBe('1,141 against 2 usually')
  })

  it('still quotes one the baseline can', () => {
    const r = report({ failures: [failure({ now: 300, prior: [50, 50, 50, 50, 50, 0] })] })
    expect(failureHeadlines(r)[0]!.says).toBe('failed 6.0× as many statements as it usually does')
  })

  it('says nothing where the server keeps no part log', () => {
    const r = report({
      volume: { available: false, reason: 'no system.part_log', prior_windows_covered: 0, tables: [] },
    })
    expect(volumeHeadlines(r)).toEqual([])
  })
})

describe('read', () => {
  it('is quiet rather than reassuring when there is no news', () => {
    expect(read(report())).toEqual({ headlines: [], blocked: null })
  })

  it('carries the reason the server gave when the log cannot be read', () => {
    const r = report({ available: false, reason: 'system.query_log is not enabled on this server' })
    expect(read(r).blocked).toBe('system.query_log is not enabled on this server')
  })

  /** A confident sentence built on one sample is worse than the reason there is
   *  no sentence. */
  it('says why it cannot judge a server it has too little history for', () => {
    const r = report({ prior_windows_covered: 1 })
    expect(read(r).blocked).toContain('no usual to compare against yet')
    expect(read(r).headlines).toEqual([])
  })

  it('ranks a dead ingest above a schema change, whatever kind they are', () => {
    const r = report({
      structure: [change()],
      structure_total: 1,
      volume: {
        available: true,
        reason: null,
        prior_windows_covered: 5,
        tables: [volume({ prior_rows: [300, 300, 300, 300, 300, 0] })],
      },
    })
    expect(read(r).headlines.map((h) => h.kind)).toEqual(['volume', 'structure'])
  })
})

describe('reach', () => {
  it('quotes the periods the log covered, never the window asked for', () => {
    expect(reach(report({ prior_windows_covered: 5 }))).toBe(
      'The last 24 hours, against the 5 days before',
    )
    expect(reach(report({ prior_windows_covered: 1 }))).toBe(
      'The last 24 hours, against the 1 day before',
    )
    expect(reach(report({ window_hours: 6, prior_windows_covered: 4 }))).toBe(
      'The last 6 hours, against the 4 6-hour periods before',
    )
  })

  /** With nothing behind it there is no comparison to describe, and a caption
   *  saying "against the 0 days before" is a sentence about nothing. */
  it('drops the comparison rather than quoting a zero', () => {
    expect(reach(report({ prior_windows_covered: 0 }))).toBe('The last 24 hours')
  })
})
