import { describe, expect, it } from 'vitest'

import { saysQuiet, saysUptime, split, staleness, type Gauge } from './now'

const gauge = (over: Partial<Gauge> = {}): Gauge => ({
  name: 'Queries running',
  source: 'Query',
  value: 1,
  unit: 'count',
  kind: 'saturation',
  ceiling: 1000,
  ceiling_from: 'server_settings.max_concurrent_queries',
  note: '',
  detail: '',
  ...over,
})

describe('split', () => {
  it('keeps an alarm that is not firing out of the alarms', () => {
    // Four zeroes under a heading that says something is wrong is a heading
    // nobody trusts the fifth time.
    const { firing, quiet } = split([
      gauge({ name: 'Inserts being delayed', kind: 'should-be-zero', value: 0 }),
      gauge({ name: 'Replicas gone read-only', kind: 'should-be-zero', value: 2 }),
    ])
    expect(firing.map((g) => g.name)).toEqual(['Replicas gone read-only'])
    expect(quiet.map((g) => g.name)).toEqual(['Inserts being delayed'])
  })

  it('separates what has a ceiling from what is only context', () => {
    const { saturation, figures } = split([
      gauge(),
      gauge({ name: 'Active parts', kind: 'figure', ceiling: undefined, ceiling_from: '' }),
    ])
    expect(saturation).toHaveLength(1)
    expect(figures.map((g) => g.name)).toEqual(['Active parts'])
  })
})

describe('saysQuiet', () => {
  it('names the checks that are clear rather than counting them', () => {
    // The value of the line is that somebody sees the thing they were worried
    // about is one of the ones being checked.
    expect(
      saysQuiet([
        gauge({ name: 'Inserts being delayed' }),
        gauge({ name: 'Replicas gone read-only' }),
      ]),
    ).toBe('All clear: inserts being delayed, replicas gone read-only.')
  })

  it('says nothing when there is nothing to be clear about', () => {
    expect(saysQuiet([])).toBeNull()
  })
})

describe('staleness', () => {
  it('stays quiet while the reading is fresh', () => {
    expect(staleness(0)).toBeNull()
    expect(staleness(2)).toBeNull()
  })

  it('says the delay once it is worth saying, and why', () => {
    expect(staleness(9)).toMatch(/9 seconds ago/)
    expect(staleness(9)).toMatch(/buffers/)
  })

  it('changes what it means past a bucket, rather than repeating itself', () => {
    // Nine seconds is a buffer. Two minutes is a collector that has stopped,
    // and reporting the second as the first would keep somebody waiting.
    expect(staleness(120)).toMatch(/may have stopped collecting/)
  })
})

describe('saysUptime', () => {
  it('reads as the context sentence it is', () => {
    expect(saysUptime(85_800)).toBe('up 23h 50m')
    expect(saysUptime(90_000)).toBe('up 1 day, 1h')
    expect(saysUptime(180_000)).toBe('up 2 days, 2h')
    expect(saysUptime(90)).toBe('up 1 minute')
    expect(saysUptime(600)).toBe('up 10 minutes')
  })

  it('is dropped rather than guessed when the server does not say', () => {
    expect(saysUptime(undefined)).toBeNull()
  })
})
