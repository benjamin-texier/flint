import { describe, expect, it } from 'vitest'

import { names, notable, saysCost, saysReport, saysRows, saysSet, type TwinReport, type TwinSet } from './twins'

const gib = (n: number) => `${(n / 2 ** 30).toFixed(1)} GiB`

const twin = (table: string, bytes: number, rows = 99_997_497) => ({
  table,
  rows,
  bytes,
  modified: '2026-05-11 18:48:13',
})

/** The set the real demo server produces, which is what this was written
 *  against: three layouts of one 100-million-row dataset. */
const hits = (over: Partial<TwinSet> = {}): TwinSet => ({
  database: 'default',
  columns: 105,
  tables: [
    twin('hits_full_projection', 41_451_048_586),
    twin('hits_index_projection', 15_727_881_732),
    twin('hits', 14_438_210_664),
  ],
  row_spread: 0,
  redundant_bytes: 30_166_092_396,
  total_bytes: 71_617_140_982,
  ...over,
})

const report = (over: Partial<TwinReport> = {}): TwinReport => ({
  available: true,
  sets: [hits()],
  total_sets: 1,
  total_redundant_bytes: 30_166_092_396,
  spread_allowed: 0.02,
  row_floor: 100_000,
  ...over,
})

describe('how alike the row counts are', () => {
  it('calls identical counts identical', () => {
    expect(saysRows(hits())).toBe('exactly the same number of rows')
  })

  it('distinguishes a copy taken while the source was still being written', () => {
    /* Worth its own wording: a fraction apart means the migration may still be
       running, which is more interesting than a finished one. */
    expect(saysRows(hits({ row_spread: 0.00059 }))).toBe(
      'the same number of rows to within a tenth of a percent',
    )
    expect(saysRows(hits({ row_spread: 0.015 }))).toBe('the same number of rows to within 1.5%')
  })
})

describe('listing the names', () => {
  it('joins two with and', () => {
    const set = hits({ tables: [twin('query_log_sharded', 1), twin('query_log_plain', 1)] })
    expect(names(set)).toBe('query_log_sharded and query_log_plain')
  })

  it('joins three with commas and a final and', () => {
    expect(names(hits())).toBe('hits_full_projection, hits_index_projection and hits')
  })
})

describe('the sentence for one set', () => {
  it('states the evidence and counts the copies', () => {
    expect(saysSet(hits())).toBe(
      'hits_full_projection, hits_index_projection and hits hold 105 identical columns and exactly the same number of rows — 3 copies of one dataset.',
    )
  })

  it('never says what to do with either copy', () => {
    /* The two most convincing sets on a real server are both deliberate — a
       projection kept as its own table, a shard beside its plain twin. The
       difference between a stale copy and a second layout is a fact about
       somebody's intentions, and Flint cannot read it. */
    const said = saysSet(hits()) + saysCost(hits(), gib)
    for (const verb of ['drop', 'delete', 'remove', 'should', 'waste']) {
      expect(said.toLowerCase()).not.toContain(verb)
    }
  })
})

describe('what a set costs', () => {
  it('quotes the conservative saving and says it is conservative', () => {
    const said = saysCost(hits(), gib)
    expect(said).toContain('66.7 GiB altogether')
    expect(said).toContain('at least 28.1 GiB')
    expect(said).toContain('whichever one you would keep')
  })
})

describe('which sets are worth a finding', () => {
  it('drops the ones too small to notice', () => {
    // Two 40 MiB copies of a lookup table are true, harmless and crowding.
    const small = hits({ redundant_bytes: 40 * 1024 * 1024 })
    expect(notable(report({ sets: [small] }))).toEqual([])
  })

  it('keeps a floor the caller can lower', () => {
    // A database's own page has no floor: there this is the answer rather than
    // one finding among thirty.
    const small = hits({ redundant_bytes: 40 * 1024 * 1024 })
    expect(notable(report({ sets: [small] }), 0)).toHaveLength(1)
  })

  it('finds none where the reading was refused', () => {
    expect(notable(report({ available: false, reason: 'no grant' }))).toEqual([])
  })
})

describe('the lead over a whole reading', () => {
  it('counts sets rather than tables', () => {
    // Three copies of one dataset is one thing to think about, not three.
    const said = saysReport(report(), gib)
    expect(said).toBe(
      '1 set of tables holds the same data twice or more, costing at least 28.1 GiB beyond one copy each.',
    )
  })

  it('says nothing where nothing crosses the floor', () => {
    expect(saysReport(report({ sets: [] }), gib)).toBeNull()
  })
})
