import { describe, expect, it } from 'vitest'

import { accounts, asWindow, policyProblem, seconds } from './govern'

describe('seconds', () => {
  it('reads the units a person writes', () => {
    expect(seconds('60')).toBe(60)
    expect(seconds('1m')).toBe(60)
    expect(seconds('90 s')).toBe(90)
    expect(seconds('1 hour')).toBe(3600)
    expect(seconds('2h')).toBe(7200)
    expect(seconds('1d')).toBe(86400)
  })

  it('refuses what is not a window rather than making it zero', () => {
    expect(seconds('0')).toBeNull()
    expect(seconds('h')).toBeNull()
    expect(seconds('')).toBeNull()
    expect(seconds('a while')).toBeNull()
    expect(seconds('-5m')).toBeNull()
  })
})

describe('accounts', () => {
  it('splits and drops the blanks somebody leaves behind', () => {
    expect(accounts('probe_a, probe_none')).toEqual(['probe_a', 'probe_none'])
    expect(accounts(' bob ,, ')).toEqual(['bob'])
    expect(accounts('')).toEqual([])
  })
})

describe('policyProblem', () => {
  const values = {
    name: 'only_c',
    database: 'analytics',
    table: 'events',
    filter: "tenant = 'c'",
    to: 'probe_none',
  }

  it('says nothing when the form is ready', () => {
    expect(policyProblem(values)).toBeNull()
  })

  it('requires the accounts, with the measured reason', () => {
    // ClickHouse accepts a policy naming nobody and every account still sees
    // every row, so the button says so instead of the server saying nothing.
    const says = policyProblem({ ...values, to: ' , ' })
    expect(says).toMatch(/names nobody/)
    expect(says).toMatch(/does nothing/)
  })

  it('requires a filter, because none is what having no policy already does', () => {
    expect(policyProblem({ ...values, filter: '  ' })).toMatch(/lets every row through/)
  })

  it('asks for the name and the table before anything else', () => {
    expect(policyProblem({ ...values, name: '' })).toBe('a name is required')
    expect(policyProblem({ ...values, table: '' })).toMatch(/database and a table/)
  })
})

describe('asWindow', () => {
  it('gives back the shortest thing a person would have typed', () => {
    // Pre-filling with `3600` would have somebody edit a number they did not
    // write.
    expect(asWindow(60)).toBe('1m')
    expect(asWindow(3600)).toBe('1h')
    expect(asWindow(86400)).toBe('1d')
    expect(asWindow(7200)).toBe('2h')
  })

  it('does not round a window that is not a whole unit', () => {
    // 90 minutes staying `5400s` is honest; `1h` would be a lie.
    expect(asWindow(5400)).toBe('90m')
    expect(asWindow(45)).toBe('45s')
    expect(asWindow(0)).toBe('0s')
  })

  it('round-trips through the parser it pre-fills', () => {
    for (const s of [60, 3600, 86400, 45, 5400]) {
      expect(seconds(asWindow(s))).toBe(s)
    }
  })
})
