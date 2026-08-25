import { describe, expect, it } from 'vitest'
import {
  accessOf,
  grantsFor,
  holdersOf,
  notesForRole,
  notesForUser,
  rolesFor,
  scopeOf,
  type AccessReport,
  type Grant,
  type Role,
  type RoleGrant,
  type User,
} from './access'

const user = (over: Partial<User> = {}): User => ({
  name: 'reader',
  auth_type: ['sha256_password'],
  host_ip: ['::/0'],
  host_names: [],
  default_roles_all: true,
  default_roles_list: [],
  default_database: '',
  valid_until: ['1970-01-01 00:00:00'],
  ...over,
})

const grant = (over: Partial<Grant> = {}): Grant => ({
  grantee: 'reader',
  is_user: true,
  database: 'analytics',
  table: '*',
  with_grant_option: false,
  revoked: false,
  access: ['SELECT'],
  ...over,
})

const roleGrant = (over: Partial<RoleGrant> = {}): RoleGrant => ({
  grantee: 'reader',
  is_user: true,
  role: 'analyst',
  is_default: true,
  with_admin_option: false,
  ...over,
})

describe('scopeOf', () => {
  it('reads as the thing it covers', () => {
    expect(scopeOf(grant())).toBe('analytics.*')
    expect(scopeOf(grant({ table: 'events' }))).toBe('analytics.events')
    expect(scopeOf(grant({ database: '*', table: '*' }))).toBe('everything')
  })
})

describe('accessOf', () => {
  it('lists a few privileges whole', () => {
    expect(accessOf(grant({ access: ['SELECT', 'INSERT'] }))).toBe('SELECT, INSERT')
  })

  it('counts the rest rather than listing seventy', () => {
    const many = Array.from({ length: 70 }, (_, i) => `P${i}`)
    expect(accessOf(grant({ access: many }))).toBe('P0, P1, P2, P3 and 66 more')
  })
})

describe('notesForUser', () => {
  it('raises an alarm for a user with no password', () => {
    const notes = notesForUser(user({ auth_type: ['no_password'] }), [], [])
    expect(notes[0]!.level).toBe('alarm')
    expect(notes[0]!.says).toContain('no password')
  })

  it('sees no_password among several auth methods', () => {
    // Recent ClickHouse allows more than one; no_password anywhere is the fact.
    // Given a grant, so the "sees nothing" note does not fire as well.
    const notes = notesForUser(
      user({ auth_type: ['sha256_password', 'no_password'] }),
      [grant()],
      [],
    )
    expect(notes).toHaveLength(1)
    expect(notes[0]!.level).toBe('alarm')
  })

  it('points out rights on everything, and the power to pass them on', () => {
    const notes = notesForUser(
      user(),
      [grant({ database: '*', table: '*', with_grant_option: true })],
      [],
    )
    expect(notes.map((n) => n.says)).toEqual([
      'has rights on everything',
      'can grant its rights to others',
    ])
  })

  it('points out a user who can grant its roles onward', () => {
    const notes = notesForUser(user(), [grant()], [roleGrant({ with_admin_option: true })])
    expect(notes.map((n) => n.says)).toContain('can grant its roles to others')
  })

  it('notices a user who can log in and see nothing', () => {
    expect(notesForUser(user(), [], [])[0]!.says).toContain('see nothing')
  })

  it('does not call a normal user out for being reachable', () => {
    // Every self-hosted ClickHouse has every user on ::/0; saying it each time
    // is noise.
    expect(notesForUser(user(), [grant()], [roleGrant()])).toEqual([])
  })

  it('mentions an expiry, and not the epoch ClickHouse uses for "never"', () => {
    // One entry per authentication method, so this is an array and the
    // earliest real date is the one that matters.
    expect(notesForUser(user({ valid_until: ['2027-01-01 00:00:00'] }), [grant()], [])[0]!.says)
      .toContain('expires 2027-01-01')
    expect(notesForUser(user({ valid_until: ['1970-01-01 00:00:00'] }), [grant()], [])).toEqual([])
    expect(notesForUser(user({ valid_until: [] }), [grant()], [])).toEqual([])
    expect(
      notesForUser(
        user({ valid_until: ['1970-01-01 00:00:00', '2028-06-01 00:00:00', '2027-01-01 00:00:00'] }),
        [grant()],
        [],
      )[0]!.says,
    ).toContain('expires 2027-01-01')
  })

  it('does not attribute another user’s grants', () => {
    expect(notesForUser(user(), [grant({ grantee: 'someone_else' })], [])[0]!.says).toContain(
      'see nothing',
    )
  })

  it('ignores a role grant of the same name', () => {
    // `is_user` separates "the user reader" from "the role reader".
    expect(notesForUser(user(), [grant({ is_user: false })], [])[0]!.says).toContain('see nothing')
  })
})

describe('notesForRole', () => {
  const role: Role = { name: 'analyst', storage: 'local_directory' }

  it('calls out a role nobody holds', () => {
    const notes = notesForRole(role, [grant({ is_user: false, grantee: 'analyst' })], [])
    expect(notes.map((n) => n.says)).toEqual(['nobody holds this role'])
  })

  it('calls out a role that grants nothing', () => {
    const notes = notesForRole(role, [], [roleGrant()])
    expect(notes.map((n) => n.says)).toEqual(['it grants nothing'])
  })

  it('says nothing about a role that is held and grants something', () => {
    expect(
      notesForRole(role, [grant({ is_user: false, grantee: 'analyst' })], [roleGrant()]),
    ).toEqual([])
  })
})

describe('lookups', () => {
  const report: AccessReport = {
    available: true,
    users: [user()],
    roles: [{ name: 'analyst', storage: '' }],
    grants: [grant(), grant({ is_user: false, grantee: 'analyst', database: 'system' })],
    role_grants: [roleGrant(), roleGrant({ grantee: 'other' })],
  }

  it('keeps a user and a role of the same name apart', () => {
    expect(grantsFor(report, 'reader', true)).toHaveLength(1)
    expect(grantsFor(report, 'analyst', false)[0]!.database).toBe('system')
    expect(grantsFor(report, 'analyst', true)).toHaveLength(0)
  })

  it('finds a user’s roles and a role’s holders', () => {
    expect(rolesFor(report, 'reader').map((r) => r.role)).toEqual(['analyst'])
    expect(holdersOf(report, 'analyst')).toEqual(['reader', 'other'])
  })
})
