import { describe, expect, it } from 'vitest'

import { index, moved, saysAway, saysStanding, split, standingOf, type Answer } from './answers'
import type { Finding } from './checkup'

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'schema:cold:analytics.events',
  area: 'schema',
  urgency: 'worth',
  title: '1.2 GiB nothing has read',
  why: 'Twelve columns of this table were not touched by any logged SELECT.',
  evidence: '1.2 GiB across 12 columns',
  gain: { kind: 'bytes', n: 1_288_490_188 },
  ...over,
})

const answer = (over: Partial<Answer> = {}): Answer => ({
  finding: 'schema:cold:analytics.events',
  at: '2026-09-01 09:12:44.000',
  state: 'dismissed',
  note: '',
  who: 'analyst',
  area: 'schema',
  object: 'analytics.events',
  title: '1.2 GiB nothing has read',
  gain_kind: 'bytes',
  gain_n: 1_288_490_188,
  times: 1,
  ...over,
})

describe('whether a finding has moved out from under its answer', () => {
  it('says nothing when the figure is where it was', () => {
    expect(moved({ kind: 'bytes', n: 1_288_490_188 }, { kind: 'bytes', n: 1_288_490_188 })).toBeNull()
  })

  it('says nothing about a wobble', () => {
    // 10% on a gigabyte is a merge, not a change of mind.
    expect(moved({ kind: 'bytes', n: 1_400_000_000 }, { kind: 'bytes', n: 1_288_490_188 })).toBeNull()
  })

  it('reports a figure that has doubled, with both numbers', () => {
    const says = moved({ kind: 'bytes', n: 4_000_000_000 }, { kind: 'bytes', n: 1_288_490_188 })
    expect(says).toContain('1.2 GiB')
    expect(says).toContain('3.7 GiB')
  })

  it('reports a figure that has halved, because that is also a different question', () => {
    expect(moved({ kind: 'bytes', n: 300_000_000 }, { kind: 'bytes', n: 1_288_490_188 })).not.toBeNull()
  })

  it('holds the floor: doubling a few megabytes is not news', () => {
    expect(moved({ kind: 'bytes', n: 12_000_000 }, { kind: 'bytes', n: 6_000_000 })).toBeNull()
  })

  it('holds a floor per unit, not one floor for every unit', () => {
    // Nine seconds of query time is under the floor; ninety is not, and both
    // are numbers a byte floor would get backwards.
    expect(moved({ kind: 'seconds', n: 12 }, { kind: 'seconds', n: 4 })).toBeNull()
    expect(moved({ kind: 'seconds', n: 200 }, { kind: 'seconds', n: 40 })).not.toBeNull()
  })

  it('cannot move where there is nothing to measure', () => {
    // "Nothing is backed up" is the same claim it was in March.
    expect(moved({ kind: 'none' }, { kind: 'none', n: 0 })).toBeNull()
    expect(moved({ kind: 'bytes', n: 9e9 }, { kind: 'none', n: 0 })).toBeNull()
  })

  it('treats a change of unit as a change of question', () => {
    const says = moved({ kind: 'seconds', n: 40 }, { kind: 'bytes', n: 1_000_000_000 })
    expect(says).toContain('seconds')
  })

  it('reports a figure that was never recorded and is now real', () => {
    // An answer given by a version that did not store the worth.
    const says = moved({ kind: 'bytes', n: 4_000_000_000 }, { kind: 'bytes', n: 0 })
    expect(says).toContain('not measured')
  })
})

describe('where a finding stands', () => {
  it('is open with no answer at all', () => {
    expect(standingOf(finding(), undefined)).toEqual({ kind: 'open' })
  })

  it('is put away by a dismissal about the same figure', () => {
    expect(standingOf(finding(), answer()).kind).toBe('away')
  })

  it('comes back when the figure it was dismissed about has moved', () => {
    const standing = standingOf(finding({ gain: { kind: 'bytes', n: 9_000_000_000 } }), answer())
    expect(standing.kind).toBe('stale')
    if (standing.kind === 'stale') expect(standing.says).toContain('1.2 GiB')
  })

  it('keeps an accepted finding listed', () => {
    // Hiding work somebody has taken on is how it stops happening.
    expect(standingOf(finding(), answer({ state: 'accepted' })).kind).toBe('accepted')
  })

  it('reads a reopened finding as its own standing, not as unanswered', () => {
    // Listed exactly like an open one — that is what reopening means — but
    // marked, because the history is the one thing it still has to say.
    expect(standingOf(finding(), answer({ state: 'reopened' })).kind).toBe('reopened')
  })

  it('leaves a finding open on a state it does not recognise', () => {
    // A row written by a later version is not a reason to hide something.
    expect(standingOf(finding(), answer({ state: 'snoozed' })).kind).toBe('open')
  })
})

describe('splitting a list', () => {
  const answers = index([answer()])

  it('puts a dismissed finding aside and leaves the rest', () => {
    const other = finding({ id: 'schema:twins:a+b', gain: { kind: 'none' } })
    const { open, away } = split([finding(), other], answers)
    expect(open.map((f) => f.id)).toEqual(['schema:twins:a+b'])
    expect(away.map((f) => f.id)).toEqual(['schema:cold:analytics.events'])
  })

  it('keeps a stale dismissal in the list rather than aside', () => {
    const grown = finding({ gain: { kind: 'bytes', n: 9_000_000_000 } })
    const { open, away } = split([grown], answers)
    expect(open).toHaveLength(1)
    expect(away).toHaveLength(0)
  })

  it('counts what it put aside, and says nothing when it put nothing aside', () => {
    expect(saysAway([])).toBeNull()
    expect(saysAway([finding()])).toBe('1 finding put away')
    expect(saysAway([finding(), finding()])).toBe('2 findings put away')
  })
})

describe('what a marked row says', () => {
  it('says nothing about an open one', () => {
    expect(saysStanding({ kind: 'open' })).toBeNull()
  })

  it('names who, and their note where they left one', () => {
    expect(saysStanding({ kind: 'away', answer: answer({ note: 'kept for the audit' }) })).toBe(
      'Put away by analyst — kept for the audit',
    )
    expect(saysStanding({ kind: 'accepted', answer: answer() })).toBe('Accepted by analyst')
  })

  it('carries the reason a dismissal came back, and the note it was put away with', () => {
    // The note is the context for deciding again, which is the only thing a
    // stale row asks anybody to do.
    const says = saysStanding({
      kind: 'stale',
      answer: answer({ note: 'small enough to leave' }),
      says: 'it was 1.2 GiB then, and is 9.0 GiB now',
    })
    expect(says).toBe(
      'Put away by analyst — small enough to leave. Back because it was 1.2 GiB then, and is 9.0 GiB now',
    )
  })
})

describe('a finding that was put away and taken back', () => {
  it('is listed like any other, and still says so', () => {
    const standing = standingOf(finding(), answer({ state: 'reopened', times: 3 }))
    expect(standing.kind).toBe('reopened')
    expect(split([finding()], index([answer({ state: 'reopened' })])).away).toHaveLength(0)
    expect(saysStanding(standing)).toBe('Reopened by analyst')
  })
})
