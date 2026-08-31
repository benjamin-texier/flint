import { describe, expect, it } from 'vitest'

import { everLoaded, saysFound, saysLifetime, type Dictionary } from './dictionaries'

const dict = (over: Partial<Dictionary> = {}): Dictionary => ({
  database: 'reference',
  name: 'tenant_label',
  status: 'LOADED',
  source: 'ClickHouse: reference.tenants',
  layout: 'Hashed',
  elements: 3,
  bytes: 10_472,
  queries: 2,
  found_rate: 0.5,
  hit_rate: 1,
  lifetime_min: 300,
  lifetime_max: 600,
  last_success: '2026-08-26 11:02:54',
  overdue_secs: 0,
  loading_secs: 0.004,
  errors: 0,
  exception: '',
  worrying: false,
  ...over,
})

describe('everLoaded', () => {
  it('reads the epoch as never', () => {
    expect(everLoaded(dict())).toBe(true)
    expect(everLoaded(dict({ last_success: '1970-01-01 00:00:00' }))).toBe(false)
  })
})

describe('saysLifetime', () => {
  it('separates a range from a fixed interval', () => {
    expect(saysLifetime(dict())).toBe('every 300–600s')
    expect(saysLifetime(dict({ lifetime_min: 60, lifetime_max: 60 }))).toBe('every 60s')
  })

  it('reads zero as never only where the server has seen the definition', () => {
    expect(saysLifetime(dict({ lifetime_max: 0, lifetime_min: 0 }))).toBe(
      'never refreshes on its own',
    )
  })

  it('says nothing about a lifetime it has not been told', () => {
    // The dev fixture had exactly this: a broken dictionary declared with
    // LIFETIME(MIN 300 MAX 600) reporting 0/0, because it never loaded. Saying
    // "never refreshes" there asserts a configuration Flint has not seen.
    expect(
      saysLifetime(
        dict({ last_success: '1970-01-01 00:00:00', lifetime_min: 0, lifetime_max: 0 }),
      ),
    ).toBe('')
  })
})

describe('saysFound', () => {
  it('says nothing about a rate over no lookups', () => {
    // Zero of zero is not zero per cent.
    expect(saysFound(dict({ queries: 0, found_rate: 0 }))).toBeNull()
  })

  it('carries the count beside the share, because the share needs it', () => {
    expect(saysFound(dict())).toBe('50% of 2 lookups found their key')
    expect(saysFound(dict({ queries: 400, found_rate: 0 }))).toBe(
      '0% of 400 lookups found their key',
    )
  })
})
