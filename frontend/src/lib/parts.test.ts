import { describe, expect, it } from 'vitest'

import { attachIsRoutine, origin, says, summary, type DetachedPart } from './parts'

const part = (over: Partial<DetachedPart> = {}): DetachedPart => ({
  database: 'analytics',
  table: 'events',
  qualified: 'analytics.events',
  partition_id: '202605',
  name: '202605_4_4_12',
  bytes: 172574,
  detached_at: '2026-08-25 15:00:00',
  disk: 'default',
  reason: '',
  ...over,
})

describe('origin', () => {
  it('reads an empty reason as a deliberate detach', () => {
    // The distinction the whole screen rests on. ClickHouse leaves `reason`
    // empty — not null — when a person ran DETACH PARTITION.
    expect(origin(part())).toBe('detached-by-hand')
    expect(origin(part({ reason: '   ' }))).toBe('detached-by-hand')
  })

  it('reads any reason as the server having put it aside', () => {
    expect(origin(part({ reason: 'broken' }))).toBe('quarantined')
    expect(origin(part({ reason: 'covered-by-broken' }))).toBe('quarantined')
  })
})

describe('says', () => {
  it('does not flag a part somebody detached on purpose', () => {
    // Flagging it would cry wolf on every backup procedure.
    expect(says(part()).level).toBe('idle')
  })

  it('repeats the server\'s own word rather than inventing one', () => {
    // "broken" and "unexpected" mean different things to somebody who knows
    // ClickHouse, and paraphrasing them loses exactly that.
    expect(says(part({ reason: 'unexpected' }))).toEqual({ text: 'unexpected', level: 'watch' })
  })
})

describe('attachIsRoutine', () => {
  it('is true only for a part a person detached', () => {
    expect(attachIsRoutine(part())).toBe(true)
    // Not a refusal — a broken part is sometimes exactly what you want back —
    // but the control must not look like the safe one.
    expect(attachIsRoutine(part({ reason: 'broken' }))).toBe(false)
  })
})

describe('summary', () => {
  const report = (over: Record<string, unknown> = {}) => ({
    available: true,
    parts: [],
    total: 3,
    total_bytes: 100,
    quarantined: 0,
    ...over,
  })

  it('says nothing when there is nothing', () => {
    // A screen that reports "0 B in 0 parts" trains people to skip it.
    expect(summary(report({ total: 0 }))).toBeNull()
    expect(summary(undefined)).toBeNull()
    expect(summary(report({ available: false }))).toBeNull()
  })

  it('distinguishes housekeeping from a symptom', () => {
    expect(summary(report())).toBe('3 detached parts, all detached by hand')
    expect(summary(report({ quarantined: 3 }))).toBe(
      '3 detached parts, every one put aside by the server',
    )
    expect(summary(report({ quarantined: 1 }))).toBe('3 detached parts, 1 put aside by the server')
  })

  it('counts one part in the singular, and drops the `all` with it', () => {
    // "1 detached part, all detached by hand" reads like a mistake: `all` needs
    // something to be all of.
    expect(summary(report({ total: 1 }))).toBe('1 detached part, detached by hand')
    expect(summary(report({ total: 1, quarantined: 1 }))).toBe(
      '1 detached part, put aside by the server',
    )
  })
})
