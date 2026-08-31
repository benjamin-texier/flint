import { describe, expect, it } from 'vitest'

import { firstLine, fold, summary, type Change, type ChangeReport } from './changes'

const change = (over: Partial<Change> = {}): Change => ({
  at: '2026-08-25 16:17:14',
  user: 'default',
  kind: 'Drop',
  statement: 'DROP TABLE `analytics`.`events`',
  through_flint: false,
  error: '',
  ...over,
})

const report = (changes: Change[]): ChangeReport => ({
  available: true,
  changes,
  oldest: '2026-08-24 16:23:55',
})

describe('summary', () => {
  it('says nothing when nothing has happened', () => {
    // An object nobody has altered is the ordinary case; a line reporting
    // "0 changes" trains people to skip the one that matters.
    expect(summary(report([]))).toBeNull()
    expect(summary(undefined)).toBeNull()
    expect(summary({ available: false, changes: [], oldest: '' })).toBeNull()
  })

  it('counts what came through Flint apart', () => {
    expect(summary(report([change({ through_flint: true }), change()]))).toBe(
      '2 statements, 1 through Flint',
    )
  })

  it('counts refusals, because somebody having tried is the point', () => {
    expect(summary(report([change({ error: 'Not enough privileges' })]))).toBe(
      '1 statement, 1 refused',
    )
  })
})

describe('firstLine', () => {
  it('takes the first line of a thirty-line CREATE', () => {
    expect(firstLine('CREATE TABLE x\n(\n  a UInt8\n)')).toBe('CREATE TABLE x')
  })

  it('truncates a single enormous line rather than stretching the row', () => {
    const long = `SELECT ${'x'.repeat(400)}`
    expect(firstLine(long).length).toBe(160)
    expect(firstLine(long).endsWith('…')).toBe(true)
  })

  it('handles an empty statement without inventing one', () => {
    expect(firstLine('')).toBe('')
  })
})

describe('fold', () => {
  it('collapses a run of identical statements and counts it', () => {
    // Flint's own workspace bootstrap runs CREATE TABLE IF NOT EXISTS on every
    // start; thirty restarts is thirty identical rows burying the one ALTER
    // somebody is looking for.
    const runs = fold([
      change({ at: '2026-08-25 16:00:00', statement: 'CREATE TABLE x' }),
      change({ at: '2026-08-25 15:00:00', statement: 'CREATE TABLE x' }),
      change({ at: '2026-08-25 14:00:00', statement: 'CREATE TABLE x' }),
    ])
    expect(runs).toHaveLength(1)
    expect(runs[0]!.times).toBe(3)
    expect(runs[0]!.latest.at).toBe('2026-08-25 16:00:00')
    expect(runs[0]!.first_at).toBe('2026-08-25 14:00:00')
  })

  it('folds only consecutive ones', () => {
    // Two identical ALTERs with somebody else's DROP between them are three
    // events. Merging them because the text matches would rewrite what happened.
    const runs = fold([
      change({ statement: 'ALTER TABLE x ADD COLUMN a UInt8' }),
      change({ statement: 'DROP TABLE y', kind: 'Drop' }),
      change({ statement: 'ALTER TABLE x ADD COLUMN a UInt8' }),
    ])
    expect(runs.map((r) => r.times)).toEqual([1, 1, 1])
  })

  it('keeps a refused attempt apart from an identical one that worked', () => {
    // "It was refused, then it succeeded" is the story; folding them loses it.
    const runs = fold([
      change({ statement: 'DROP TABLE x' }),
      change({ statement: 'DROP TABLE x', error: 'Not enough privileges' }),
    ])
    expect(runs).toHaveLength(2)
  })

  it('keeps two users apart', () => {
    const runs = fold([change({ user: 'alice' }), change({ user: 'bob' })])
    expect(runs).toHaveLength(2)
  })

  it('has nothing to fold in nothing', () => {
    expect(fold([])).toEqual([])
  })
})
