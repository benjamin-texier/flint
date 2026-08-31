import { describe, expect, it } from 'vitest'

import {
  foldPrivileges,
  privileges,
  saysGrants,
  saysVia,
  showsHow,
  type Grant,
  type MyGrants,
} from './grants'

const grant = (over: Partial<Grant> = {}): Grant => ({
  what: 'SELECT',
  on: 'analytics.*',
  revoked: false,
  grantable: false,
  statement: 'GRANT SELECT ON analytics.* TO probe_a',
  direct: true,
  via: [],
  ...over,
})

const mine = (over: Partial<MyGrants> = {}): MyGrants => ({
  user: 'probe_a',
  roles: [],
  grants: [grant()],
  revokes: [],
  ...over,
})

describe('privileges', () => {
  it('does not split inside a column list', () => {
    // Measured on a real grant: the commas between column names are not
    // separators, and splitting on them turns one privilege into two.
    expect(privileges('SELECT(event_time, query_duration_ms)')).toEqual([
      'SELECT(event_time, query_duration_ms)',
    ])
  })

  it('splits the fifty a full-access user holds', () => {
    const all = privileges('CHECK, SHOW, SELECT, INSERT, ALTER, CREATE, DROP')
    expect(all).toHaveLength(7)
    expect(all[0]).toBe('CHECK')
    expect(all[6]).toBe('DROP')
  })
})

describe('foldPrivileges', () => {
  it('leaves an ordinary grant alone', () => {
    expect(foldPrivileges('SELECT')).toEqual({ shown: ['SELECT'], hidden: 0 })
  })

  it('counts what it folded away rather than trailing off', () => {
    // The `default` user's grant is one statement listing fifty privileges. A
    // list cut short without saying so has somebody believe they hold six.
    const many = Array.from({ length: 50 }, (_, i) => `P${i}`).join(', ')
    const { shown, hidden } = foldPrivileges(many)
    expect(shown).toHaveLength(6)
    expect(hidden).toBe(44)
  })
})

describe('saysVia', () => {
  it('says nothing about the ordinary case', () => {
    expect(saysVia(grant())).toBeNull()
  })

  it('names both paths when a privilege arrives twice', () => {
    // `probe_a` holds this directly and through `analyst`. Somebody who loses
    // the role and keeps the access needs to see the other path.
    expect(saysVia(grant({ via: ['analyst'] }))).toBe('directly, and through analyst')
    expect(saysVia(grant({ direct: false, via: ['analyst'] }))).toBe('through analyst')
  })
})

describe('showsHow', () => {
  it('stays away when every row would be blank', () => {
    // Granted directly, not passable on: there is nothing to explain, and a
    // column blank in every row is furniture.
    expect(showsHow([grant(), grant({ on: 'logs.*' })])).toBe(false)
  })

  it('appears for a grant that came through a role', () => {
    expect(showsHow([grant(), grant({ direct: false, via: ['analyst'] })])).toBe(true)
  })

  it('appears where only some rows can be passed on', () => {
    expect(showsHow([grant(), grant({ grantable: true })])).toBe(true)
  })
})

describe('saysGrants', () => {
  it('leaves the explaining of an empty answer to the note that does it', () => {
    // A user with nothing gets zero rows from `SHOW GRANTS` and no error. The
    // note below says why at length; a summary that says it too has the reader
    // comparing two sentences for a difference that is not there.
    expect(saysGrants(mine({ grants: [] }))).toBe('nothing granted.')
  })

  it('says a shared property once instead of on every row', () => {
    // The full-access user has `WITH GRANT OPTION` on all six of their grants,
    // and six copies of one sentence is a column of wallpaper.
    const all = [grant({ grantable: true }), grant({ on: '*.*', grantable: true })]
    expect(saysGrants(mine({ grants: all }))).toContain('Every one of them can be passed on')
    expect(showsHow(all)).toBe(false)
  })

  it('counts the roles and what was taken back', () => {
    expect(saysGrants(mine({ roles: ['analyst'], revokes: [grant({ revoked: true })] }))).toBe(
      '1 grant, a role switched on, 1 taken back.',
    )
  })

  it('does not mention roles or revokes that are not there', () => {
    expect(saysGrants(mine())).toBe('1 grant.')
  })
})
