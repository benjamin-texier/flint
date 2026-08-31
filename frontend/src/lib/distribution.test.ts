import { describe, expect, it } from 'vitest'

import {
  asideFrom,
  bars,
  counted,
  says,
  shapeOf,
  type Distribution,
  type Mode,
} from './distribution'

/** A reading built from bucket counts, which is all any rule here looks at. */
const of = (mode: Mode, counts: number[], over: Partial<Distribution> = {}): Distribution => ({
  available: true,
  reason: null,
  column: 'x',
  type: 'UInt32',
  mode,
  rows: counts.reduce((a, b) => a + b, 0) + (over.tail_rows ?? 0),
  nulls: 0,
  distinct: mode === 'bins' ? 1000 : counts.length,
  buckets: counts.map((rows, i) => ({
    label: mode === 'bins' ? String(i * 10) : `v${i}`,
    rows,
    from: mode === 'bins' ? i * 10 : null,
    to: mode === 'bins' ? (i + 1) * 10 : null,
  })),
  tail_rows: 0,
  tail_values: 0,
  ...over,
})

describe('the named shapes', () => {
  it('calls a column that is one value what it is', () => {
    // A `status` that is 'ok' 99% of the time is a constant with exceptions, and
    // somebody reading it needs to be told that before anything else.
    expect(shapeOf(of('tally', [199_600, 400]))).toBe('single')
  })

  it('separates dominant from single', () => {
    // Half is an answer; nearly all is a different one, and they lead somewhere
    // different — one is a candidate for a dictionary, the other for deletion.
    expect(shapeOf(of('tally', [100_000, 40_000, 20_000, 20_000, 20_000]))).toBe('dominant')
  })

  it('calls a uniform column even, despite the wobble a real one has', () => {
    /* Measured: `uniform` over 200,000 rows gave 12,400 to 12,600 across sixteen
       bins. A threshold near a ratio of 1 would call that uneven, which is the
       trap this constant exists to avoid. */
    const wobbly = [12600, 12400, 12600, 12400, 12600, 12400, 12600, 12400,
                    12400, 12600, 12400, 12600, 12400, 12600, 12400, 12600]
    expect(shapeOf(of('bins', wobbly))).toBe('even')
  })

  it('does not call two peaks with a hole between them even', () => {
    /* Measured on the `bimodal` fixture: 100,000 at each end and fourteen empty
       buckets between. A rule that ignored empties would report an even spread
       across sixteen buckets, which is the opposite of the truth. */
    const two = [100_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100_000]
    expect(shapeOf(of('bins', two))).toBe('clustered')
  })

  it('does not call one broad hump two clusters', () => {
    // Two adjacent peaks are one shape; the valley is what makes them two.
    const hump = [1000, 9000, 9500, 9000, 1000, 0, 0, 0]
    expect(shapeOf(of('bins', hump))).not.toBe('clustered')
  })

  it('calls a falling histogram a tail', () => {
    const falling = [90_000, 40_000, 20_000, 9000, 4000, 2000, 900, 400, 200, 100]
    expect(shapeOf(of('bins', falling))).toBe('tail')
  })

  it('calls a listed minority a tail, whatever the bars look like', () => {
    /* The claim is about the *remainder*: twelve values out of nine hundred that
       together are a tenth of the table is a tail however evenly those twelve
       are spread among themselves. */
    const d = of('top', [1000, 950, 900, 880, 850], {
      tail_rows: 95_000,
      tail_values: 888,
      distinct: 893,
    })
    expect(shapeOf(d)).toBe('tail')
  })

  it('falls back to numbers rather than to the nearest name', () => {
    // "Spread across 6 of 10 buckets" says less than "two clusters" and is never
    // wrong, which is the right trade for a shape nothing describes.
    const awkward = [3000, 0, 5000, 4000, 0, 6000, 3500, 0, 0, 4000]
    expect(shapeOf(of('bins', awkward))).toBe('mixed')
  })

  it('is empty when there is nothing to read', () => {
    expect(shapeOf(of('tally', []))).toBe('empty')
  })
})

describe('says', () => {
  it('quotes a value and ranges a bin, because they are different claims', () => {
    expect(says(of('tally', [199_600, 400]))).toContain('`v0`')
    const binned = of('bins', [90_000, 40_000, 20_000, 9000, 4000, 2000, 900, 400, 200, 100])
    expect(says(binned)).toContain('first bucket')
  })

  it('names both clusters', () => {
    const two = [100_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100_000]
    expect(says(of('bins', two))).toBe('Two clusters, with nothing between them: around 0 and around 150.')
  })

  it('counts the tail in values as well as rows', () => {
    const d = of('top', [1000, 950, 900, 880, 850], {
      tail_rows: 95_000,
      tail_values: 888,
      distinct: 893,
    })
    expect(says(d)).toContain('888 more values hold the rest')
  })

  it('says a table of nulls is not a distribution', () => {
    // Drawing an empty axis would suggest the question had been answered.
    const d = of('tally', [], { rows: 0, nulls: 4000 })
    expect(says(d)).toContain('is null, so there is no distribution')
  })
})

describe('counted', () => {
  it('says which of the three a bar is', () => {
    /* A bar means three different things across the modes, and fourteen powers
       of two are perfectly even as frequencies while looking like a tail as
       values — so the sentence always says which was counted. */
    expect(counted(of('tally', [1, 1, 1]))).toBe('3 values, each counted')
    expect(counted(of('bins', [1, 2, 3]))).toBe('3 equal buckets across the range')
    expect(counted(of('top', [1, 2], { distinct: 900 }))).toBe(
      'the 2 most common of 900 values',
    )
  })
})

describe('asideFrom', () => {
  it('says what is not on the axis', () => {
    const d = of('tally', [900, 100], { nulls: 250 })
    expect(asideFrom(d)).toBe('250 of 1,250 rows are null and are not on this axis.')
  })

  it('says nothing when nothing is missing', () => {
    expect(asideFrom(of('tally', [900, 100]))).toBeNull()
  })
})

describe('bars', () => {
  it('scales to the fullest bucket, not to the total', () => {
    /* A column whose largest bucket is 3% of the table draws sixteen invisible
       bars against the total, and the shape — which is the entire point —
       disappears. */
    const b = bars(of('bins', [30, 60, 10]))
    expect(b.map((x) => x.share)).toEqual([0.5, 1, 1 / 6])
  })

  it('survives a column with no rows', () => {
    expect(bars(of('bins', [0, 0]))).toEqual([
      { label: '0', rows: 0, share: 0 },
      { label: '10', rows: 0, share: 0 },
    ])
  })
})

describe('what a top reading can and cannot see', () => {
  const top = (counts: number[], distinct: number, total: number): Distribution =>
    of('top', counts, {
      distinct,
      rows: total,
      tail_rows: total - counts.reduce((a, b) => a + b, 0),
      tail_values: distinct - counts.length,
    })

  it('does not call an evenly spread column a tail', () => {
    /* Measured on `analytics.events.device_id`: 400 values spread evenly, whose
       twelve most common are 3.0% of 482,212 rows — which is exactly 12/400. A
       power law over the same 400 draws the same twelve bars, so only the ratio
       to a flat share can tell them apart. */
    const even = top(new Array(12).fill(1206), 400, 482_212)
    expect(shapeOf(even)).toBe('even')
    expect(says(even)).toContain('about their share of the values')
  })

  it('calls a genuine power law a tail', () => {
    const heavy = top([30_000, 20_000, 10_000, 5000, 4000, 3000, 2000, 1500, 1000, 900, 800, 700], 900, 120_000)
    expect(shapeOf(heavy)).toBe('tail')
  })

  it('knows an identifier from a distribution', () => {
    /* `analytics.events.payload`: 482,212 distinct values in 482,212 rows, and
       its twelve most common are one row each. Twelve bars of height 1 is a
       chart that says nothing, and every shape rule below would have had an
       opinion about it. */
    const key = top(new Array(12).fill(1), 482_212, 482_212)
    expect(shapeOf(key)).toBe('key')
    expect(says(key)).toContain('identifier, not a distribution')
  })
})
