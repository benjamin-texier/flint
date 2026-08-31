import { describe, expect, it } from 'vitest'

import { saysUnnamed, share, short, type TraceReport } from './trace'

const report = (over: Partial<TraceReport> = {}): TraceReport => ({
  frames: [
    { name: 'sipHash64Keyed', samples: 6 },
    { name: 'bcmp', samples: 4 },
  ],
  samples: 12,
  unnamed: 2,
  kind: 'CPU',
  kind_says: 'Processor samples: where the CPU actually was.',
  note: '',
  minutes: 15,
  ...over,
})

describe('share', () => {
  it('divides by what could be named, not by everything', () => {
    // Dividing by a total that includes unnamed frames would make every share
    // quietly too small, and the unnamed count has its own line.
    const r = report()
    expect(share(r.frames[0]!, r.frames)).toBeCloseTo(0.6)
    expect(share(r.frames[1]!, r.frames)).toBeCloseTo(0.4)
  })

  it('does not divide by zero', () => {
    expect(share({ name: 'x', samples: 0 }, [])).toBe(0)
  })
})

describe('saysUnnamed', () => {
  it('says how much of the window is missing from the list', () => {
    expect(saysUnnamed(report())).toBe(
      '2 of 12 samples landed at an address this build has no name for — 17% of the window is missing from the list below.',
    )
  })

  it('never rounds to a share the rows below contradict', () => {
    // 15174 of 15201 is 99.8%: "100% is missing" printed above twenty rows is a
    // claim the reader can see is false, and so is "0%" above a count that is
    // not zero.
    expect(saysUnnamed(report({ samples: 15201, unnamed: 15174 }))).toContain('99% of the window')
    expect(saysUnnamed(report({ samples: 15201, unnamed: 3 }))).toContain('1% of the window')
  })

  it('does not point at a list below when there is no list', () => {
    // Every sample unnamed means no rows: a caveat referring to a table that is
    // not there sends the reader looking for it.
    const all = saysUnnamed(report({ frames: [], samples: 5, unnamed: 5 }))
    expect(all).toBe(
      'All 5 samples landed at an address this build has no name for, so there is no ranking to show.',
    )
    expect(all).not.toContain('below')
  })

  it('stays quiet when the build named everything', () => {
    expect(saysUnnamed(report({ unnamed: 0 }))).toBeNull()
    expect(saysUnnamed(report({ samples: 0, unnamed: 0 }))).toBeNull()
  })
})

describe('short', () => {
  it('cuts the template arguments, which are the bulk and not the point', () => {
    expect(short('DB::ColumnUnique<DB::ColumnVector<unsigned short>>::compareAt(unsigned long)')).toBe(
      'DB::ColumnUnique<…>::compareAt(unsigned long)',
    )
  })

  it('leaves a plain name alone', () => {
    expect(short('sipHash64Keyed(unsigned long)')).toBe('sipHash64Keyed(unsigned long)')
    expect(short('bcmp')).toBe('bcmp')
  })

  it('still trims what is long after the templates are gone', () => {
    const long = `DB::${'Aaaaaaaaaa'.repeat(9)}::run()`
    expect(short(long).length).toBeLessThanOrEqual(72)
    expect(short(long).endsWith('…')).toBe(true)
  })
})
