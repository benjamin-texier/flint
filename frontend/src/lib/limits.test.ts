import { describe, expect, it } from 'vitest'

import {
  appliesTo,
  appliesToNobody,
  byTable,
  closestToCeiling,
  countedPer,
  fullness,
  narrowed,
  reading,
  pressure,
  usageFor,
  window,
  type Consumption,
  type Quota,
  type RowPolicy,
} from './limits'

const policy = (over: Partial<RowPolicy> = {}): RowPolicy => ({
  name: 'p ON analytics.events',
  short_name: 'p',
  database: 'analytics',
  table: 'events',
  storage: 'local_directory',
  filter: "tenant = 'a'",
  restrictive: false,
  apply_to_all: false,
  apply_to_list: ['probe_a'],
  apply_to_except: [],
  ...over,
})

const quota = (over: Partial<Quota> = {}): Quota => ({
  name: 'modest',
  storage: 'local_directory',
  keys: ['user_name'],
  apply_to_all: false,
  apply_to_list: ['probe_a'],
  apply_to_except: [],
  intervals: [],
  ...over,
})

describe('appliesTo', () => {
  it('spells out the shape that catches an account nobody exempted', () => {
    expect(appliesTo(quota({ apply_to_all: true, apply_to_except: ['default'] }))).toBe(
      'everyone except default',
    )
    expect(appliesTo(quota({ apply_to_all: true }))).toBe('everyone')
    expect(appliesTo(quota())).toBe('probe_a')
    expect(appliesTo(quota({ apply_to_list: [] }))).toBe('nobody')
  })

  it('knows when a rule binds no one at all', () => {
    expect(appliesToNobody(quota({ apply_to_list: [] }))).toBe(true)
    expect(appliesToNobody(quota({ apply_to_all: true, apply_to_list: [] }))).toBe(false)
  })
})

describe('countedPer', () => {
  it('separates a ceiling each from a ceiling between them', () => {
    expect(countedPer(quota())).toBe('counted per user name')
    expect(countedPer(quota({ keys: ['ip_address', 'client_key'] }))).toBe(
      'counted per ip address and client key',
    )
    // No key at all means one set of counters for the whole list.
    expect(countedPer(quota({ keys: [] }))).toBe('shared by everyone it applies to')
  })
})

describe('window', () => {
  it('says an interval the way somebody would', () => {
    expect(window(60)).toBe('every minute')
    expect(window(3600)).toBe('every hour')
    expect(window(86400)).toBe('every day')
    expect(window(7200)).toBe('every 2 hours')
    expect(window(90)).toBe('every 90 seconds')
  })
})

describe('fullness', () => {
  it('keeps "not measured" apart from "measured, and zero"', () => {
    // An empty bar reads as idle. Nothing consumed yet is a different fact.
    expect(fullness({ dimension: 'queries', unit: 'count', max: 60 })).toBeNull()
    expect(fullness({ dimension: 'queries', unit: 'count', max: 60, used: 0 })).toBe(0)
    expect(fullness({ dimension: 'queries', unit: 'count', max: 60, used: 30 })).toBe(0.5)
    // A quota can be over its own ceiling; the bar stops at full.
    expect(fullness({ dimension: 'queries', unit: 'count', max: 60, used: 90 })).toBe(1)
  })
})

describe('pressure', () => {
  const at = (used: number | undefined) => ({ dimension: 'queries', unit: 'count' as const, max: 60, used })

  it('bands the figure by what somebody would do about it', () => {
    expect(pressure(at(6))).toBe('ok')
    expect(pressure(at(48))).toBe('close')
    expect(pressure(at(60))).toBe('spent')
    // Over its own ceiling is still spent, not a fourth thing.
    expect(pressure(at(120))).toBe('spent')
  })

  it('is null where nothing has been counted, which is not a band', () => {
    expect(pressure(at(undefined))).toBeNull()
  })
})

describe('usageFor', () => {
  const use = (duration_secs: number, quota_key: string): Consumption => ({
    quota_name: 'modest',
    quota_key,
    duration_secs,
    start_time: '',
    end_time: '',
    ceilings: [],
  })

  it('pairs consumption with the interval it was counted over', () => {
    const usage = [use(60, 'probe_a'), use(3600, 'probe_a'), use(60, 'probe_none')]
    // Matching on the name alone would show an hour's queries against a
    // minute's ceiling.
    expect(usageFor(usage, 'modest', 60).map((u) => u.quota_key)).toEqual(['probe_a', 'probe_none'])
    expect(usageFor(usage, 'modest', 3600)).toHaveLength(1)
    expect(usageFor(usage, 'other', 60)).toHaveLength(0)
  })
})

describe('closestToCeiling', () => {
  const at = (quota_key: string, used: number): Consumption => ({
    quota_name: 'modest',
    quota_key,
    duration_secs: 60,
    start_time: '',
    end_time: '',
    ceilings: [{ dimension: 'queries', unit: 'count', max: 60, used }],
  })

  it('puts whoever is about to be refused first', () => {
    const { shown, hidden } = closestToCeiling([at('a', 1), at('b', 59), at('c', 30)], 2)
    expect(shown.map((u) => u.quota_key)).toEqual(['b', 'c'])
    // The count travels with the list: six of fifty must not read as fifty.
    expect(hidden).toBe(1)
  })

  it('hides nothing when everybody fits', () => {
    expect(closestToCeiling([at('a', 1)], 6).hidden).toBe(0)
  })
})

describe('byTable', () => {
  it('groups policies by the table they narrow, permissive from restrictive', () => {
    const groups = byTable([
      policy({ short_name: 'only_a' }),
      policy({ short_name: 'not_b', restrictive: true }),
      policy({ short_name: 'other', table: 'devices' }),
    ])
    expect(groups.map((g) => g.table)).toEqual(['devices', 'events'])
    const events = groups[1]!
    expect(events.permissive.map((p) => p.short_name)).toEqual(['only_a'])
    expect(events.restrictive.map((p) => p.short_name)).toEqual(['not_b'])
  })
})

describe('reading', () => {
  const group = (permissive: RowPolicy[], restrictive: RowPolicy[]) => ({
    database: 'analytics',
    table: 'events',
    permissive,
    restrictive,
  })

  it('says that permissive policies add up rather than narrow', () => {
    const lines = reading(group([policy({ short_name: 'a' }), policy({ short_name: 'b' })], []))
    expect(lines[0]).toMatch(/any of the 2 permissive policies/)
    expect(lines[0]).toMatch(/they add up/)
  })

  it('names the single policy where there is only one', () => {
    expect(reading(group([policy({ short_name: 'only_a' })], []))).toEqual([
      'sees the rows matching only_a',
    ])
  })

  it('narrows from everything when a restrictive policy stands alone', () => {
    // Verified against the server: a restrictive policy with no permissive one
    // beside it starts from all rows, not from none.
    const lines = reading(group([], [policy({ short_name: 'not_b', restrictive: true })]))
    expect(lines).toEqual(['sees every row, but only those matching not_b'])
  })

  it('applies the restrictive one after the permissive ones', () => {
    const lines = reading(
      group([policy({ short_name: 'a' }), policy({ short_name: 'b' })], [policy({ short_name: 'c', restrictive: true })]),
    )
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatch(/^and then only those matching c$/)
  })
})

describe('narrowed', () => {
  it('lists the accounts the policies name, once each', () => {
    expect(
      narrowed({
        database: 'analytics',
        table: 'events',
        permissive: [policy(), policy({ apply_to_list: ['probe_a', 'zoe'] })],
        restrictive: [],
      }),
    ).toEqual(['probe_a', 'zoe'])
  })

  it('collapses to everyone where a policy applies to all', () => {
    expect(
      narrowed({
        database: 'analytics',
        table: 'events',
        permissive: [policy({ apply_to_all: true, apply_to_list: [] })],
        restrictive: [],
      }),
    ).toEqual(['everyone'])
  })
})
