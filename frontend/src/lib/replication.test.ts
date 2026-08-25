import { describe, expect, it } from 'vitest'
import {
  clusterOf,
  delayOf,
  hasReplication,
  summarise,
  verdictOf,
  worstFirst,
  type Replica,
} from './replication'

const replica = (over: Partial<Replica> = {}): Replica => ({
  database: 'analytics',
  table: 'rep_events',
  engine: 'ReplicatedMergeTree',
  is_leader: true,
  is_readonly: false,
  session_expired: false,
  absolute_delay: 0,
  readonly_for: 0,
  queue_size: 0,
  inserts_in_queue: 0,
  merges_in_queue: 0,
  behind_log: 0,
  total_replicas: 1,
  active_replicas: 1,
  lost_parts: 0,
  oldest_queued: '1970-01-01 00:00:00',
  queue_exception: '',
  zookeeper_exception: '',
  ...over,
})

describe('verdictOf', () => {
  it('calls a caught-up replica caught up', () => {
    expect(verdictOf(replica()).health).toBe('keeping-up')
  })

  it('puts lost parts above everything, because that is data gone', () => {
    const v = verdictOf(replica({ lost_parts: 2, is_readonly: true, absolute_delay: 9999 }))
    expect(v.health).toBe('lost')
    expect(v.says).toContain('not data late')
  })

  it('explains why read-only is the state that hides', () => {
    // Reads keep working, so it surfaces as a failing insert.
    const v = verdictOf(replica({ is_readonly: true, readonly_for: 420 }))
    expect(v.health).toBe('stuck')
    expect(v.says).toContain('for 7m')
    expect(v.says).toContain('failing insert')
  })

  it('carries the Keeper error when there is one', () => {
    expect(
      verdictOf(replica({ is_readonly: true, zookeeper_exception: 'Connection loss' })).says,
    ).toContain('Connection loss')
  })

  it('reads an expired session as read-only, whichever flag is set', () => {
    expect(verdictOf(replica({ session_expired: true })).health).toBe('stuck')
    expect(verdictOf(replica({ session_expired: true })).says).toContain('session expired')
  })

  it('ignores a lag of a few seconds, which is normal operation', () => {
    expect(verdictOf(replica({ absolute_delay: 5 })).health).toBe('keeping-up')
    expect(verdictOf(replica({ absolute_delay: 45 })).health).toBe('behind')
  })

  it('treats a queue with entries to apply as behind, before the delay moves', () => {
    // The queue is the early warning; the delay only confirms it later.
    const v = verdictOf(replica({ behind_log: 12, queue_size: 3 }))
    expect(v.health).toBe('behind')
    expect(v.says).toBe('12 log entries to apply, 3 in its queue')
  })

  it('gets the singular right', () => {
    expect(verdictOf(replica({ behind_log: 1 })).says).toContain('1 log entry to apply')
  })

  it('notices a replica that is not answering', () => {
    const v = verdictOf(replica({ total_replicas: 3, active_replicas: 2 }))
    expect(v.health).toBe('thin')
    expect(v.says).toContain('less redundancy')
  })

  it('mentions the replica count only when there is more than one', () => {
    expect(verdictOf(replica()).says).toBe('caught up')
    expect(verdictOf(replica({ total_replicas: 2, active_replicas: 2 })).says).toContain(
      '2 of 2 replicas up',
    )
  })
})

describe('summarise', () => {
  it('counts only what is not keeping up', () => {
    const report = {
      available: true,
      replicas: [replica(), replica({ is_readonly: true }), replica({ lost_parts: 1 })],
    }
    expect(summarise(report)).toBe('2 of 3 not keeping up')
  })

  it('says nothing when everything is caught up, or when there is nothing', () => {
    expect(summarise({ available: true, replicas: [replica()] })).toBeNull()
    expect(summarise({ available: true, replicas: [] })).toBeNull()
    expect(summarise(undefined)).toBeNull()
  })
})

describe('hasReplication', () => {
  it('is false for a single-node server, which should not get an empty tab', () => {
    expect(hasReplication({ available: true, replicas: [] })).toBe(false)
    expect(hasReplication({ available: false, reason: 'no grant', replicas: [] })).toBe(false)
    expect(hasReplication(undefined)).toBe(false)
    expect(hasReplication({ available: true, replicas: [replica()] })).toBe(true)
  })
})

describe('worstFirst', () => {
  it('puts the replica somebody must act on at the top', () => {
    const order = worstFirst([
      replica({ table: 'fine' }),
      replica({ table: 'late', behind_log: 4 }),
      replica({ table: 'gone', lost_parts: 1 }),
      replica({ table: 'frozen', is_readonly: true }),
    ]).map((r) => r.table)
    expect(order).toEqual(['gone', 'frozen', 'late', 'fine'])
  })

  it('breaks ties by name, so the list does not reshuffle between polls', () => {
    const order = worstFirst([
      replica({ database: 'b', table: 'x' }),
      replica({ database: 'a', table: 'z' }),
      replica({ database: 'a', table: 'a' }),
    ]).map((r) => `${r.database}.${r.table}`)
    expect(order).toEqual(['a.a', 'a.z', 'b.x'])
  })

  it('does not mutate what it was given', () => {
    const list = [replica({ table: 'fine' }), replica({ table: 'gone', lost_parts: 1 })]
    worstFirst(list)
    expect(list.map((r) => r.table)).toEqual(['fine', 'gone'])
  })
})

describe('figures that come from Keeper', () => {
  // All three observed live on a replica whose Keeper connection was cut: the
  // delay came back as seconds-since-the-epoch and the counts as 0 of 0.
  const cutOff = replica({
    is_readonly: true,
    session_expired: true,
    absolute_delay: 1_787_650_776,
    total_replicas: 0,
    active_replicas: 0,
  })

  it('reports no delay rather than fifty-six years', () => {
    expect(delayOf(cutOff)).toBeNull()
    expect(delayOf(replica({ absolute_delay: 12 }))).toBe(12)
  })

  it('reports no replica count rather than 0 of 0', () => {
    expect(clusterOf(cutOff)).toBeNull()
    expect(clusterOf(replica({ total_replicas: 3, active_replicas: 2 }))).toEqual({
      active: 2,
      total: 3,
    })
  })

  it('never lets that delay reach the verdict', () => {
    const v = verdictOf(cutOff)
    expect(v.health).toBe('stuck')
    expect(v.says).not.toContain('behind')
    // And it does not claim a duration it was not given: readonly_duration is
    // null right after a restart, which arrives as zero.
    expect(v.says).not.toContain('for 0')
  })

  it('does not call a cut-off replica thin on the strength of 0 of 0', () => {
    // 0 < 0 is false today, so this is a guard against the day it is not.
    expect(verdictOf(replica({ session_expired: true, total_replicas: 0 })).health).toBe('stuck')
  })
})
