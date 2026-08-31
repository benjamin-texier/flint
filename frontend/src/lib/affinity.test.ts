import { describe, expect, it } from 'vitest'

import {
  WINDOWS,
  buildMatrix,
  declaredPairs,
  leftOut,
  pairKey,
  isWindow,
  shortName,
  span,
  type AffinityReport,
} from './affinity'

const report = (over: Partial<AffinityReport> = {}): AffinityReport => ({
  available: true,
  nodes: [
    { qualified: 'analytics.events', queries: 100, readers: 3 },
    { qualified: 'analytics.devices', queries: 40, readers: 1 },
    { qualified: 'reference.cities', queries: 20, readers: 1 },
  ],
  pairs: [{ a: 'analytics.devices', b: 'analytics.events', queries: 30 }],
  days: 7,
  considered: 200,
  single: 150,
  wide: 0,
  max_tables: 3,
  ...over,
})

describe('pairKey', () => {
  it('is the same fact whichever way round the pair arrives', () => {
    expect(pairKey('b', 'a')).toBe(pairKey('a', 'b'))
  })
})

describe('declaredPairs', () => {
  it('drops the direction, because the cell asks only whether it is declared', () => {
    // Keeping the arrow would leave the cell above the diagonal and the one
    // below it disagreeing about one relationship.
    const set = declaredPairs([{ from: 'a.mv', to: 'a.target' }])
    expect(set.has(pairKey('a.target', 'a.mv'))).toBe(true)
  })
})

describe('shortName', () => {
  it('keeps the prefix of a table from somewhere else', () => {
    // When a query reaches across a database boundary, the boundary is the
    // information — the same rule the diagram's boxes follow.
    expect(shortName('analytics.events', 'analytics')).toBe('events')
    expect(shortName('reference.cities', 'analytics')).toBe('reference.cities')
  })
})

describe('buildMatrix', () => {
  it('leaves a cell undefined where two tables were never read together', () => {
    // Never together and together rarely are different answers, and the second
    // is the one worth drawing faintly.
    const m = buildMatrix(report(), new Set())
    const [events, devices, cities] = m.labels
    expect([events, devices, cities]).toEqual([
      'analytics.events',
      'analytics.devices',
      'reference.cities',
    ])
    expect(m.cells[0]![1]).toBeDefined()
    expect(m.cells[0]![2]).toBeUndefined()
  })

  it('is symmetric, because being read together is', () => {
    const m = buildMatrix(report(), new Set())
    expect(m.cells[0]![1]!.queries).toBe(m.cells[1]![0]!.queries)
  })

  it('leaves the diagonal empty rather than pairing a table with itself', () => {
    const m = buildMatrix(report(), new Set())
    expect(m.cells[0]![0]).toBeUndefined()
  })

  it('marks the pairs the schema declares, and counts the ones it does not', () => {
    // The whole point: a heavy cell with no ring is a join performed constantly
    // that nothing in the database records.
    const declared = declaredPairs([{ from: 'analytics.devices', to: 'analytics.events' }])
    expect(buildMatrix(report(), declared).cells[0]![1]!.declared).toBe(true)
    expect(buildMatrix(report(), declared).undeclared).toBe(0)
    expect(buildMatrix(report(), new Set()).undeclared).toBe(1)
  })

  it('gives a pair seen once a visible floor', () => {
    const m = buildMatrix(
      report({
        pairs: [
          { a: 'analytics.devices', b: 'analytics.events', queries: 1 },
          { a: 'analytics.events', b: 'reference.cities', queries: 900 },
        ],
      }),
      new Set(),
    )
    expect(m.cells[0]![1]!.fill).toBeGreaterThan(0)
    expect(m.cells[0]![1]!.queries).toBe(1)
  })

  it('counts the pairs whose other end is not a row here', () => {
    const m = buildMatrix(report(), new Set(), 2)
    expect(m.labels).toHaveLength(2)
    expect(m.omittedNodes).toBe(1)
    const said = leftOut(
      buildMatrix(
        report({
          pairs: [
            { a: 'analytics.devices', b: 'analytics.events', queries: 30 },
            { a: 'analytics.events', b: 'reference.cities', queries: 5 },
          ],
        }),
        new Set(),
        2,
      ),
      report({ wide: 4, max_tables: 31 }),
    ).join(' · ')
    expect(said).toContain('1 less-read tables not drawn')
    expect(said).toContain('1 pairs with a table that is not a row here')
    expect(said).toContain('the widest named 31')
  })
})

describe('the windows offered', () => {
  it('offers three, each a different question', () => {
    // A day is what is happening now, a week is ordinary work including whatever
    // runs on Mondays, a month reaches the report nobody remembers scheduling.
    // A slider would let somebody ask for eleven days, which answers nothing in
    // particular.
    expect([...WINDOWS]).toEqual([1, 7, 30])
  })

  it('refuses a window it does not offer, so an edited URL cannot ask for one', () => {
    // Beyond a month `system.query_log` has usually been trimmed, and a
    // ninety-day answer would really be "whatever survived the TTL".
    expect(isWindow(7)).toBe(true)
    expect(isWindow(90)).toBe(false)
    expect(isWindow(Number('nonsense'))).toBe(false)
  })
})

describe('span', () => {
  it('says how many statements could make a pair at all', () => {
    // On most servers the single-table statements are the majority, and a
    // sparse matrix beside a large total reads as a picture that failed.
    expect(span(report())).toBe('200 statements over 7 days · 50 named more than one table')
  })

  it('says so plainly when nothing was read together', () => {
    expect(span(report({ considered: 12, single: 12 }))).toContain('nothing was read together')
  })

  it('does not print a window with no statements in it as a figure', () => {
    expect(span(report({ considered: 0, single: 0 }))).toBe('No statement read this database over 7 days')
  })
})
