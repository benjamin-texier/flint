import { describe, expect, it } from 'vitest'

import {
  hiding,
  saysBuild,
  saysFeatures,
  matching,
  restartNote,
  split,
  whoSet,
  type BuildReport,
  type ServerSetting,
  type SessionSetting,
} from './settings'

const build = (over: Partial<BuildReport> = {}): BuildReport => ({
  version: '26.7.5.10',
  describe: 'v26.7.5.10-stable',
  official: true,
  build_type: 'RelWithDebInfo',
  git_hash: 'c7d5ecce',
  git_branch: '26.7',
  git_date: '2026-08-21 06:02:30 +0000',
  platform: 'Linux x86_64',
  compiler: 'clang++-21 21.1.8',
  tzdata: '2025a',
  openssl: '3.5.7',
  missing: [],
  features_total: 44,
  verdicts: [],
  ...over,
})

const server = (over: Partial<ServerSetting> = {}): ServerSetting => ({
  name: 'max_connections',
  value: '4096',
  default: '1024',
  changed: true,
  description: '',
  type: 'UInt64',
  changeable: 'Yes',
  obsolete: false,
  redundant: false,
  ...over,
})

const session = (over: Partial<SessionSetting> = {}): SessionSetting => ({
  name: 'max_threads',
  value: '8',
  default: '0',
  changed: true,
  description: '',
  type: 'UInt64',
  obsolete: false,
  tier: 'Production',
  flints: false,
  from_compatibility: false,
  ...over,
})

describe('restartNote', () => {
  it('says nothing about the ordinary case, which is needing a restart', () => {
    // Measured rather than assumed: 39 of the 46 written settings on a stock
    // server need one, so a "needs a restart" note repeats down almost every
    // row and says nothing.
    expect(restartNote(server({ changeable: 'No' }))).toBeNull()
  })

  it('flags the few somebody can act on today', () => {
    expect(restartNote(server({ changeable: 'Yes' }))).toBe('takes effect on a config reload')
    expect(restartNote(server({ changeable: 'IncreaseOnly' }))).toMatch(/not lowered/)
  })
})

describe('split', () => {
  it('separates config that says something from config that says nothing', () => {
    const { says, inert, obsolete } = split([
      server({ name: 'a' }),
      server({ name: 'b', redundant: true }),
      server({ name: 'c', obsolete: true }),
      // Obsolete wins over redundant: a setting the server ignores is a finding
      // whether or not it repeats a default.
      server({ name: 'd', obsolete: true, redundant: true }),
    ])
    expect(says.map((s) => s.name)).toEqual(['a'])
    expect(inert.map((s) => s.name)).toEqual(['b'])
    expect(obsolete.map((s) => s.name)).toEqual(['c', 'd'])
  })
})

describe('whoSet', () => {
  it('keeps Flint out of the server it is reporting on', () => {
    // The bug this exists to prevent: `log_comment` reading `flint:introspection`
    // presented as this server's configuration.
    const { profile, flints } = whoSet([
      session({ name: 'log_comment', flints: true }),
      session({ name: 'max_threads' }),
    ])
    expect(flints.map((s) => s.name)).toEqual(['log_comment'])
    expect(profile.map((s) => s.name)).toEqual(['max_threads'])
  })

  it('keeps what one compatibility line did out of what somebody chose', () => {
    // 384 of 392 on a real `24.8` account. Folding them into "set for this
    // account" makes the page unreadable and the claim false.
    const { profile, compat } = whoSet([
      session({ name: 'compatibility' }),
      session({ name: 'use_variant_as_common_type', from_compatibility: true }),
      session({ name: 'precise_float_parsing', from_compatibility: true }),
    ])
    expect(profile.map((s) => s.name)).toEqual(['compatibility'])
    expect(compat).toHaveLength(2)
  })

  it("counts a setting Flint sends as Flint's, even where compatibility moved it too", () => {
    // Both are true of `max_execution_time` on such a server, and only one of
    // them is actionable: it is Flint's, and saying so is the point.
    const { flints, compat } = whoSet([
      session({ name: 'max_execution_time', flints: true, from_compatibility: true }),
    ])
    expect(flints).toHaveLength(1)
    expect(compat).toHaveLength(0)
  })
})

describe('matching', () => {
  it('matches the way somebody types', () => {
    const items = [server({ name: 'max_memory_usage' }), server({ name: 'max_connections' })]
    expect(matching(items, 'MEMORY').map((s) => s.name)).toEqual(['max_memory_usage'])
    expect(matching(items, '  ').map((s) => s.name)).toHaveLength(2)
  })

  it('matches a value too, which is how you find who set 4096', () => {
    expect(matching([server({ value: '4096' })], '4096')).toHaveLength(1)
  })
})

describe('hiding', () => {
  it('says what a filter is keeping back', () => {
    // A filtered list is a truncated one, and a truncated list reads as the
    // whole truth unless it says otherwise.
    expect(hiding(3, 46)).toBe('3 of 46; the rest do not match')
    expect(hiding(46, 46)).toBeNull()
  })
})

describe('saysBuild', () => {
  it('carries the channel and the platform, not only the version', () => {
    expect(saysBuild(build())).toBe('v26.7.5.10-stable · RelWithDebInfo · Linux x86_64')
  })

  it('puts an unofficial build first, because that is the thing to know', () => {
    expect(saysBuild(build({ official: false }))).toMatch(/^v26.7.5.10-stable · not an official/)
  })

  it('says nothing where the server said nothing', () => {
    expect(saysBuild(build({ version: '', describe: '' }))).toBeNull()
  })
})

describe('saysFeatures', () => {
  it('says all of them are here rather than leaving a blank', () => {
    // An empty list reads as a failure to look, not as an answer.
    expect(saysFeatures(build())).toBe('All 44 optional features are compiled in.')
  })

  it('names what is missing and counts it against the total', () => {
    expect(saysFeatures(build({ missing: ['aws_s3', 'krb5'] }))).toBe(
      '2 of 44 optional features are compiled out: aws_s3, krb5.',
    )
  })

  it('stays quiet where the table was not readable at all', () => {
    expect(saysFeatures(build({ features_total: 0 }))).toBe('')
  })
})
