import { describe, expect, it } from 'vitest'

import { declared, inferred, verdict, type Impact } from './impact'

const impact = (over: Partial<Impact> = {}): Impact => ({
  available: true,
  qualified: 'analytics.events',
  rows: 504328,
  bytes: 2815045,
  dependents: [],
  complete: true,
  ...over,
})

const dep = (how: 'declared' | 'inferred', name: string) => ({
  qualified: `analytics.${name}`,
  kind: 'view',
  how,
})

describe('declared and inferred', () => {
  it('keeps the two kinds of certainty apart', () => {
    const i = impact({ dependents: [dep('declared', 'a'), dep('inferred', 'b')] })
    expect(declared(i).map((d) => d.qualified)).toEqual(['analytics.a'])
    expect(inferred(i).map((d) => d.qualified)).toEqual(['analytics.b'])
  })

  it('has nothing to say about nothing', () => {
    expect(declared(undefined)).toEqual([])
    expect(inferred(undefined)).toEqual([])
  })
})

describe('verdict', () => {
  it('says nothing when nothing depends on it', () => {
    // The ordinary case. A line reading "0 objects would break" trains people to
    // skip the line that matters.
    expect(verdict(impact())).toBeNull()
  })

  it('never gives a number without its certainty', () => {
    // "5 objects would break" reads as a promise Flint cannot make about the
    // half it inferred.
    expect(
      verdict(impact({ dependents: [dep('declared', 'a'), dep('declared', 'b'), dep('inferred', 'c')] })),
    ).toBe('2 objects would break, 1 more names it')
  })

  it('reads correctly with only inferred dependents', () => {
    expect(verdict(impact({ dependents: [dep('inferred', 'a')] }))).toBe('1 object names it')
    expect(verdict(impact({ dependents: [dep('inferred', 'a'), dep('inferred', 'b')] }))).toBe(
      '2 objects name it',
    )
  })

  it('reads correctly with one of each', () => {
    expect(verdict(impact({ dependents: [dep('declared', 'a'), dep('inferred', 'b')] }))).toBe(
      '1 object would break, 1 more names it',
    )
  })

  it('says it does not know rather than implying nothing', () => {
    // An empty list from a role that cannot read definitions means "unknown".
    // Reporting that as "nothing depends on this" is how a confirmation lies.
    const blind = verdict(impact({ complete: false }))
    expect(blind).toMatch(/cannot say/)
  })

  it('says nothing at all when the endpoint is unavailable', () => {
    expect(verdict(impact({ available: false }))).toBeNull()
    expect(verdict(undefined)).toBeNull()
  })
})
