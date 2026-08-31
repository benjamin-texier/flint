import { beforeEach, describe, expect, it } from 'vitest'

import { FlintError } from './api'
import {
  outageOf,
  probeDelay,
  reachAnswered,
  reachFailed,
  reachSnapshot,
  resetReach,
  subscribeReach,
} from './reach'

const flintError = (kind: string, status: number) =>
  new FlintError('boom', kind, null, status)

describe('outageOf', () => {
  it('reads a fetch that never got an answer as Flint being gone', () => {
    expect(outageOf(flintError('network', 0))).toBe('flint')
  })

  /* The one this whole strip was written for: in development that is Vite
     answering for a backend that is not running, in production a reverse
     proxy. Neither sends a Flint error envelope, which is what tells them
     apart from Flint's own 502. */
  it('reads a bare gateway status as Flint being gone', () => {
    expect(outageOf(flintError('http', 502))).toBe('flint')
    expect(outageOf(flintError('http', 503))).toBe('flint')
    expect(outageOf(flintError('http', 504))).toBe('flint')
  })

  it('reads Flint’s own transport error as ClickHouse being gone', () => {
    expect(outageOf(flintError('transport', 502))).toBe('clickhouse')
  })

  /* A 502 that Flint classified is one bad answer to one question. Calling it
     an outage would blank the page over a single unparseable response. */
  it('leaves a classified 502 to the panel that asked', () => {
    expect(outageOf(flintError('decode', 502))).toBeNull()
  })

  it('says nothing about the ordinary refusals', () => {
    expect(outageOf(flintError('unauthorized', 401))).toBeNull()
    expect(outageOf(flintError('forbidden', 403))).toBeNull()
    expect(outageOf(flintError('clickhouse', 400))).toBeNull()
    expect(outageOf(new Error('something else'))).toBeNull()
    expect(outageOf(null)).toBeNull()
  })
})

describe('probeDelay', () => {
  it('starts quick, because most outages are a restart', () => {
    expect(probeDelay(0)).toBe(2_000)
  })

  it('backs off, and stops backing off', () => {
    expect(probeDelay(1)).toBeGreaterThan(probeDelay(0))
    expect(probeDelay(99)).toBe(30_000)
    expect(probeDelay(-1)).toBe(2_000)
  })
})

describe('the store', () => {
  beforeEach(() => resetReach())

  it('starts with nothing wrong', () => {
    expect(reachSnapshot().outage).toBeNull()
  })

  it('holds the moment the outage started, not the last failure of it', () => {
    reachFailed(flintError('network', 0), 1_000)
    reachFailed(flintError('network', 0), 9_000)
    expect(reachSnapshot()).toEqual({ outage: 'flint', since: 1_000 })
  })

  /* Flint coming back while ClickHouse stays down is a different sentence on
     the strip, and a different thing to check. */
  it('follows the outage changing hands', () => {
    reachFailed(flintError('network', 0), 1_000)
    reachFailed(flintError('transport', 502), 5_000)
    expect(reachSnapshot()).toEqual({ outage: 'clickhouse', since: 5_000 })
  })

  it('ignores a failure that says nothing about reachability', () => {
    reachFailed(flintError('forbidden', 403))
    expect(reachSnapshot().outage).toBeNull()
  })

  it('clears as soon as anything answers', () => {
    reachFailed(flintError('network', 0), 1_000)
    reachAnswered()
    expect(reachSnapshot().outage).toBeNull()
  })

  it('tells its listeners, and only when something changed', () => {
    let calls = 0
    const stop = subscribeReach(() => (calls += 1))
    reachFailed(flintError('network', 0))
    reachFailed(flintError('network', 0))
    expect(calls).toBe(1)
    reachAnswered()
    reachAnswered()
    expect(calls).toBe(2)
    stop()
    reachFailed(flintError('network', 0))
    expect(calls).toBe(2)
  })
})
