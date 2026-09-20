import { describe, expect, it } from 'vitest'

import { analyzePolicy, rerunPolicy, worthExplaining } from './cost'

describe('rerunPolicy', () => {
  it('runs a cheap statement again without asking', () => {
    expect(rerunPolicy({ elapsed: 0.04, bytesRead: 2_000_000 })).toEqual({ auto: true })
  })

  it('runs again when nothing is known yet', () => {
    expect(rerunPolicy(null)).toEqual({ auto: true })
  })

  it('holds a slow one back, and says what it cost', () => {
    const verdict = rerunPolicy({ elapsed: 9.2, bytesRead: 4 * 1024 ** 3 })
    expect(verdict.auto).toBe(false)
    expect(verdict.auto === false && verdict.why).toContain('9.20 s')
    expect(verdict.auto === false && verdict.why).toContain('GiB')
  })

  it('holds back on the bytes alone, however fast it was', () => {
    expect(rerunPolicy({ elapsed: 0.3, bytesRead: 40 * 1024 ** 3 }).auto).toBe(false)
  })
})

describe('worthExplaining', () => {
  it('offers the plan once a run has read a lot', () => {
    expect(worthExplaining(300 * 1024 ** 2)).toBe(true)
    expect(worthExplaining(4 * 1024 ** 3)).toBe(true)
  })

  it('stays quiet on a small read', () => {
    expect(worthExplaining(0)).toBe(false)
    expect(worthExplaining(19 * 1024 ** 2)).toBe(false)
  })

  it('does not judge by what came back', () => {
    // The signal is bytes read and nothing else: an aggregate reads a hundred
    // million rows to answer with one, and a rule built on that ratio would
    // flag every `SELECT count()` ever written.
    expect(worthExplaining(1024 ** 3)).toBe(true)
  })
})

describe('whether Analyze may just go', () => {
  it('asks when nothing has run yet, where a rewrite would not', () => {
    // The difference between the two, and the only one: a rewrite follows a
    // run, and Analyze is reached from a menu whose other entries are free.
    expect(rerunPolicy(null)).toEqual({ auto: true })
    const policy = analyzePolicy(null)
    expect(policy.auto).toBe(false)
    if (!policy.auto) expect(policy.why).toContain('no telling what it will cost')
  })

  it('goes where the last run was cheap', () => {
    expect(analyzePolicy({ elapsed: 0.04, bytesRead: 1024 })).toEqual({ auto: true })
  })

  it('asks where the last run was expensive, and says what it cost', () => {
    const policy = analyzePolicy({ elapsed: 42, bytesRead: 8 * 1024 * 1024 * 1024 })
    expect(policy.auto).toBe(false)
    if (!policy.auto) expect(policy.why).toContain('42')
  })
})
