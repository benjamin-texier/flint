import { describe, expect, it } from 'vitest'

import { lockSupport, saysLock } from './wall'

describe('what the browser can do about the screen', () => {
  it('knows the lock is there when it is', () => {
    // Measured over http://127.0.0.1: present, and granted.
    expect(lockSupport({ wakeLock: {} }, true)).toBe('available')
  })

  it('blames the context rather than the browser when that is the cause', () => {
    /* Measured over http://10.0.8.10 — a Flint on a LAN address, which is
       exactly how a wall display is served: `navigator.wakeLock` is undefined
       because the context is insecure, not because the browser is old. Saying
       "your browser cannot" would send somebody to install a different one. */
    expect(lockSupport({}, false)).toBe('insecure')
    expect(saysLock('insecure')).toContain('plain HTTP')
    expect(saysLock('insecure')).toContain('HTTPS')
  })

  it('says the browser cannot where the context is fine and the API is absent', () => {
    expect(lockSupport({}, true)).toBe('unsupported')
    expect(saysLock('unsupported')).toContain('may sleep')
  })

  it('survives a browser with no navigator at all', () => {
    expect(lockSupport(undefined, undefined)).toBe('unsupported')
  })

  it('says nothing when the lock will hold', () => {
    // A dashboard that announces a working screen lock is announcing the absence
    // of a problem.
    expect(saysLock('available')).toBeNull()
  })
})
