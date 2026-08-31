import { describe, expect, it } from 'vitest'

import { actingAs, admits } from './session'

const session = (over: Partial<import('./api').Session>): import('./api').Session => ({
  required: false,
  user: 'default',
  endpoint: 'http://localhost:8123',
  service_user: 'default',
  ...over,
})

describe('admits', () => {
  it('lets everybody in where nobody signs in', () => {
    expect(admits(session({ required: false, user: 'default' }))).toBe(true)
  })

  it('lets a signed-in person in', () => {
    expect(admits(session({ required: true, user: 'analyst' }))).toBe(true)
  })

  it('keeps out a browser with no session where one is required', () => {
    expect(admits(session({ required: true, user: null }))).toBe(false)
  })

  it('admits nobody before the answer arrives', () => {
    // The third state, and the one that has actually caused bugs: read as
    // admitted, the shell renders and fires a request that can only be refused.
    expect(admits(undefined)).toBe(false)
  })
})

describe('actingAs', () => {
  it('names the signed-in user', () => {
    expect(actingAs(session({ required: true, user: 'analyst', service_user: 'flint' }))).toBe(
      'analyst',
    )
  })

  it('falls back to the account Flint connects as', () => {
    // Something always runs the statements. On a deployment with no sign-in
    // that is the manifest account, and naming it beats naming nobody.
    expect(actingAs(session({ required: false, user: null, service_user: 'flint' }))).toBe('flint')
  })

  it('names nobody only when nothing is known yet', () => {
    expect(actingAs(undefined)).toBeNull()
  })

  it('has nobody to fall back to on an unpinned Flint', () => {
    // No server in the manifest means no account in it either, so there is no
    // name to give before somebody signs in. `admits` is false in this state,
    // which is why nothing renders it — but the fallback must not invent one.
    expect(
      actingAs(session({ required: true, user: null, endpoint: null, service_user: null })),
    ).toBeNull()
  })
})
