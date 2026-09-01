import { describe, expect, it } from 'vitest'

import {
  coldShare,
  saysCost,
  saysReport,
  saysSpan,
  saysTable,
  trustworthy,
  type ColdReport,
  type ColdTable,
} from './cold'

/** Stands in for `format`'s `bytes`, rounded the same way — coarsely enough to
 *  reproduce the collision this is about. */
const mib = (n: number) => `${Math.round(n / 1024 / 1024)} MiB`

const report = (over: Partial<ColdReport> = {}): ColdReport => ({
  available: true,
  window_days: 7,
  covered_days: 6.2,
  statements: 40_000,
  tables: [],
  floor_bytes: 0,
  total_cold_bytes: 0,
  total_bytes: 0,
  total_tables: 0,
  ...over,
})

const table = (over: Partial<ColdTable> = {}): ColdTable => ({
  database: 'default',
  table: 'events',
  qualified: 'default.events',
  columns: 14,
  cold_columns: 12,
  bytes: 60_000_000_000,
  cold_bytes: 41_000_000_000,
  reads: 900,
  coldest: [],
  ...over,
})

describe('whether a cold reading may be believed', () => {
  it('believes a week of a busy log', () => {
    expect(trustworthy(report()).ok).toBe(true)
  })

  it('refuses a log that does not go back a day', () => {
    /* The case that made this exist. Asked about seven days, a real server's
       log answered for five hours — and "no statement has read this in 7 days"
       over five hours of evidence is a false statement made of true numbers. */
    const said = trustworthy(report({ covered_days: 0.22 }))
    expect(said.ok).toBe(false)
    expect(said.why).toContain('5 hours')
  })

  it('refuses a window nobody was querying in', () => {
    // Every column on a server nobody touched last night is cold, trivially.
    const said = trustworthy(report({ statements: 3 }))
    expect(said.ok).toBe(false)
    expect(said.why).toContain('3 statements')
  })

  it('passes the reading’s own refusal through', () => {
    const said = trustworthy(
      report({ available: false, reason: 'this user is not granted SELECT on system.parts_columns' }),
    )
    expect(said.ok).toBe(false)
    expect(said.why).toContain('parts_columns')
  })
})

describe('how long the evidence covers', () => {
  it('reads hours below two days, because 0.2 days is a figure nobody pictures', () => {
    expect(saysSpan(0.22)).toBe('5 hours')
    expect(saysSpan(1)).toBe('24 hours')
    expect(saysSpan(1 / 24)).toBe('1 hour')
  })

  it('reads days above that', () => {
    expect(saysSpan(6.2)).toBe('6 days')
    expect(saysSpan(30)).toBe('30 days')
  })

  it('says so rather than printing zero', () => {
    expect(saysSpan(0)).toBe('no time at all')
  })

  it('reads minutes where hours would round to nothing', () => {
    expect(saysSpan(20 / (24 * 60))).toBe('20 minutes')
  })
})

describe('the sentence for one table', () => {
  it('makes a table nothing read one fact, not nineteen hundred', () => {
    /* system.metric_log: 1,906 columns, every one cold, zero reads. Reported as
       1,906 findings it would bury everything else on the page — and it is one
       fact, about the table. */
    const said = saysTable(table({ columns: 1906, cold_columns: 1906, reads: 0 }), report())
    expect(said).toBe('No statement read default.events at all in the last 6 days.')
  })

  it('names the columns when the table itself is busy', () => {
    const said = saysTable(table(), report())
    expect(said).toContain('12 of default.events’s 14 stored columns')
    expect(said).toContain('last 6 days')
  })

  it('explains a table read whose columns are all cold', () => {
    // `SELECT count()` names no column, and a filter the index answered alone
    // leaves none in the log either.
    const said = saysTable(table({ columns: 14, cold_columns: 14, reads: 60 }), report())
    expect(said).toContain('read 60 times')
    expect(said).toContain('index answered alone')
  })

  it('never says a column is unused', () => {
    // The one word this module must not produce: the evidence is about a window.
    for (const t of [table(), table({ reads: 0 }), table({ cold_columns: 14 })]) {
      expect(saysTable(t, report())).not.toContain('unused')
    }
  })
})

describe('the share of a table that is cold', () => {
  it('is the cold bytes over the whole', () => {
    expect(coldShare(table())).toBeCloseTo(41 / 60, 3)
  })

  it('is absent rather than zero for a table holding nothing', () => {
    expect(coldShare(table({ bytes: 0, cold_bytes: 0 }))).toBeNull()
  })
})

describe('what the cold part costs', () => {
  it('gives a share rather than a second figure in the same unit', () => {
    /* The defect: 24,533,236 of 24,868,732 bytes both print as "24 MiB", and
       "24 MiB of the 24 MiB this table occupies" reads as a bug. */
    const said = saysCost(table({ bytes: 24_868_732, cold_bytes: 24_533_236 }), mib)
    expect(said).toBe('That is 23 MiB, 99% of what the table occupies.')
  })

  it('never claims 100% while a warm column is in the list', () => {
    const said = saysCost(table({ bytes: 1_000_000_000, cold_bytes: 999_999_999 }), mib)
    expect(said).toContain('99%')
  })

  it('says nothing about a share for a table nothing read', () => {
    // "All of it" is what "nothing read this table" already said.
    const said = saysCost(table({ reads: 0, bytes: 2_600_000, cold_bytes: 2_600_000 }), mib)
    expect(said).toBe('The whole 2 MiB of it.')
  })

  it('is absent where there is nothing to cost', () => {
    expect(saysCost(table({ bytes: 0, cold_bytes: 0 }), mib)).toBeNull()
  })
})

describe('the lead over a whole reading', () => {
  it('names the span the figure means', () => {
    const said = saysReport(report({ tables: [table()], total_tables: 1 }))
    expect(said).toBe('Over the last 6 days, 1 table holds data no statement read.')
  })

  it('says nothing where nothing may be claimed', () => {
    expect(saysReport(report({ covered_days: 0.1, tables: [table()], total_tables: 1 }))).toBeNull()
    expect(saysReport(report())).toBeNull()
  })
})
