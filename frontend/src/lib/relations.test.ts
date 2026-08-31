import { describe, expect, it } from 'vitest'

import {
  group,
  shortlist,
  thin,
  isGroup,
  leftOut,
  says,
  saysGroup,
  span,
  suggests,
  type Finding,
  type Relations,
} from './relations'

const report = (over: Partial<Relations> = {}): Relations => ({
  available: true,
  rows: 3780,
  findings: [],
  columns: 15,
  considered: 9,
  skipped_constant: 3,
  skipped_unique: 3,
  capped: false,
  numeric: 0,
  ...over,
})

const finding = (over: Partial<Finding> = {}): Finding => ({
  kind: 'determines',
  a: 'status_code',
  a_distinct: 10,
  b: 'success',
  b_distinct: 2,
  ...over,
})

describe('group', () => {
  const mirror = (a: string, b: string, distinct = 2): Finding => ({
    kind: 'mirrors',
    a,
    a_distinct: distinct,
    b,
    b_distinct: distinct,
  })

  it('folds a transitive set of mirrors into one finding', () => {
    // Mirroring is transitive, so four columns arrive as six pairs. Reported
    // that way it is six lines saying one thing — on a real system table that
    // was nine of the first ten findings.
    const items = group([
      mirror('active', 'visible'),
      mirror('active', 'removal_tid'),
      mirror('active', 'removal_csn'),
      mirror('visible', 'removal_tid'),
      mirror('visible', 'removal_csn'),
      mirror('removal_tid', 'removal_csn'),
    ])
    expect(items).toHaveLength(1)
    const one = items[0]!
    expect(isGroup(one)).toBe(true)
    if (isGroup(one)) {
      expect(one.columns).toEqual(['active', 'visible', 'removal_tid', 'removal_csn'])
      // The sentence starts after the first column, which the caller sets in
      // code — returning the whole of it and slicing the name back off is what
      // produced "active visible, removal_tid and removal_csn" on a real table.
      expect(saysGroup(one)).toBe(
        ', visible, removal_tid and removal_csn are all the same information — 2 values each, paired one to one',
      )
    }
  })

  it('leaves a pair as a pair, where "and" reads better than a list of two', () => {
    const items = group([mirror('partition', 'partition_id', 3)])
    expect(isGroup(items[0]!)).toBe(false)
    expect(says(items[0] as Finding)).toContain('are the same information twice')
  })

  it('keeps two separate groups separate, and everything else in order', () => {
    const items = group([
      mirror('a', 'b'),
      mirror('a', 'c'),
      mirror('b', 'c'),
      { kind: 'determines', a: 'x', a_distinct: 10, b: 'y', b_distinct: 2 },
      mirror('p', 'q'),
    ])
    expect(items).toHaveLength(3)
    expect(isGroup(items[0]!)).toBe(true)
    expect(items[1]!.kind).toBe('determines')
    expect(items[2]!.kind).toBe('mirrors')
  })
})

describe('shortlist', () => {
  const of = (kind: Finding['kind'], a: string): Finding => ({ kind, a, a_distinct: 2 })

  it('gives every kind a share, so one family cannot fill the page', () => {
    // Measured: sixteen numeric columns of `system.parts` produced twenty-odd
    // correlations, and in one ranked list they filled every slot — the
    // far-value findings never appeared at all.
    const many = [
      ...Array.from({ length: 20 }, (_, i) => of('correlates', `c${i}`)),
      of('far-values', 'bytes_on_disk'),
      of('constant', 'project_id'),
    ]
    const shown = shortlist(many)
    expect(shown.filter((i) => i.kind === 'correlates')).toHaveLength(6)
    expect(shown.some((i) => i.kind === 'far-values')).toBe(true)
    expect(shown.some((i) => i.kind === 'constant')).toBe(true)
  })

  it('counts a mirror group against the mirrors, not as its own family', () => {
    const items = shortlist(
      [
        { kind: 'mirror-group', columns: ['a', 'b', 'c'], distinct: 2 },
        ...Array.from({ length: 8 }, (_, i) => of('mirrors', `m${i}`)),
      ],
      2,
    )
    expect(items).toHaveLength(2)
  })

  it('keeps the order it was given', () => {
    const items = shortlist([of('mirrors', 'first'), of('correlates', 'second')])
    expect(items.map((i) => (i.kind === 'mirror-group' ? 'group' : i.a))).toEqual([
      'first',
      'second',
    ])
  })
})

describe('says', () => {
  it('states a determination in the terms of the table, with its counts', () => {
    // "a determines b" is a phrase from a database course. What a reader wants
    // is what it means for their rows — and the counts, because they are what
    // make it credible rather than a claim to take on faith.
    expect(says(finding())).toBe(
      'fixes success: 10 values of it, and each one always has the same success',
    )
  })

  it('states a mirror as the redundancy it is', () => {
    expect(says(finding({ kind: 'mirrors', a: 'user_host', a_distinct: 3, b: 'user_agent' }))).toBe(
      'and user_agent are the same information twice — 3 values each, paired one to one',
    )
  })

  it('prints a constant with its value, and says NULL rather than printing it', () => {
    // A column of NULLs is a real finding and `null` printed as a word reads as
    // a string somebody stored.
    expect(says(finding({ kind: 'constant', a: 'project_id', a_distinct: 1, value: '-1' }))).toBe(
      'holds one value in every row: -1',
    )
    expect(says(finding({ kind: 'constant', a: 'note', a_distinct: 1, value: undefined }))).toBe(
      'holds NULL in every row',
    )
  })

  it('agrees with itself in the singular', () => {
    expect(says(finding({ a_distinct: 1 }))).toContain('1 value of it')
  })
})

describe('says, for the two correlations', () => {
  const pair = (r: number, kind: 'moves-with' | 'correlates', over?: number): Finding => ({
    kind,
    a: 'read_rows',
    a_distinct: 100,
    b: 'read_bytes',
    b_distinct: 100,
    r,
    compared: over,
  })

  it('carries the sign, because the two directions are different findings', () => {
    // "correlated" on its own hides which way, and two columns that move
    // opposite each other are as related as two that move together.
    expect(says(pair(0.983, 'correlates'))).toBe('and read_bytes move together — r +0.98')
    expect(says(pair(-0.871, 'correlates'))).toBe(
      'and read_bytes move opposite each other — r \u22120.87',
    )
  })

  it('calls a straight line a straight line', () => {
    expect(says(pair(1, 'moves-with'))).toContain('move as one line')
    expect(says(pair(-1, 'moves-with'))).toContain('are one line, inverted')
    expect(suggests(pair(1, 'moves-with'))).toContain('carries no information the other does not')
  })

  it('says how many rows it was taken over, only where that is fewer', () => {
    // `corr` skips a row where either side is NULL — measured against a server.
    // Repeating the table's own count under every finding would be noise.
    expect(says(pair(0.9, 'correlates', 900), 1000)).toContain('over the 900 rows where both are')
    expect(says(pair(0.9, 'correlates', 1000), 1000)).not.toContain('over the')
  })
})

describe('says, for a dominant value', () => {
  const dom = (): Finding => ({
    kind: 'dominant',
    a: 'method',
    a_distinct: 5,
    value: 'GET',
    covering: 3388,
  })

  it('gives the share and the count it came from', () => {
    expect(says(dom(), 3780)).toBe('is GET in 90% of rows — 3,388 of the rows carry it')
  })

  it('says what it means for an index, which is why it matters', () => {
    expect(suggests(dom())).toContain('narrows almost nothing')
  })
})

describe('says, for far values', () => {
  const far = (over: Partial<Finding> = {}): Finding => ({
    kind: 'far-values',
    a: 'bytes_on_disk',
    a_distinct: 200,
    above: 6,
    fence_high: 1_017_000,
    high: 3_300_000,
    q1: 12_118,
    q3: 263_943,
    ...over,
  })

  it('gives the fence, the reach and the middle it was drawn from', () => {
    // A fence without the distribution it came from is a number nobody can
    // argue with. And no unit is knowable — the column may be seconds, bytes or
    // a count — so the figures are figures and the reader supplies the meaning.
    const said = says(far())
    expect(said).toContain('6 rows above 1.02M, reaching 3.3M')
    expect(said).toContain('middle half of the rows sits between 12.1K and 264K')
  })

  it('says both ends when a column reaches past both', () => {
    const said = says(far({ below: 2, fence_low: -500, low: -9000 }))
    expect(said).toContain('6 rows above')
    expect(said).toContain('2 rows below')
    expect(said).toContain(' and ')
  })
})

describe('suggests', () => {
  it('offers something to do only where there is something to do', () => {
    // The finding is a fact about the rows; this is a suggestion. A reader is
    // owed the difference, so a determination — which may be exactly what the
    // table is for — suggests nothing.
    expect(suggests(finding())).toBeNull()
    expect(suggests(finding({ kind: 'mirrors' }))).toContain('could be dropped')
    expect(suggests(finding({ kind: 'constant' }))).toContain('costs disk')
    // Plain prose: backticks in a paragraph render as backticks.
    expect(suggests(finding({ kind: 'constant' }))).not.toContain('`')
  })
})

describe('span', () => {
  it('says what was read and how much of the table was compared', () => {
    expect(span(report())).toBe('3,780 rows read · 9 of 15 columns compared, every pair of them')
  })

  it('says plainly when nothing could be compared', () => {
    // A table of keys and constants has no eligible pair, and an empty list
    // beside "3,780 rows read" would read as a picture that failed.
    expect(span(report({ considered: 1 }))).toContain('no two columns were eligible')
    expect(span(report({ rows: 0 }))).toContain('no rows')
  })
})

describe('thin', () => {
  it('says so where there are too few rows for the evidence to be strong', () => {
    // On two hundred rows, a column of sixteen values fixing a column of two
    // says as much about arithmetic as about the data. Stated rather than used
    // to hide the finding: the number is the reader's to weigh.
    expect(thin(report({ rows: 194 }))).toContain('weak evidence')
    expect(thin(report({ rows: 50_000 }))).toBeNull()
    expect(thin(report({ rows: 0 }))).toBeNull()
  })
})

describe('leftOut', () => {
  it('names each exclusion with its count', () => {
    const said = leftOut(report()).join(' · ')
    expect(said).toContain('3 columns hold one value')
    expect(said).toContain('3 columns have nearly one value per row')
  })

  it('says nothing where nothing was excluded', () => {
    expect(leftOut(report({ skipped_constant: 0, skipped_unique: 0 }))).toEqual([])
  })
})
