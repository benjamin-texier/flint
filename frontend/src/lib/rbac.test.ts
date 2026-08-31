import { describe, expect, it } from 'vitest'

import type { AccessReport, Grant, RoleGrant, User } from './access'
import {
  costOfDropping,
  grantableRoles,
  grantedOn,
  heldRoles,
  saysCost,
  scopeProblem,
  whyUnmanageable,
} from './rbac'

const user = (over: Partial<User> = {}): User => ({
  name: 'bob',
  storage: 'local_directory',
  auth_type: ['sha256_password'],
  host_ip: [],
  host_names: [],
  default_roles_all: true,
  default_roles_list: [],
  default_database: '',
  valid_until: [],
  ...over,
})

const grant = (over: Partial<Grant> = {}): Grant => ({
  grantee: 'bob',
  is_user: true,
  database: 'analytics',
  table: '*',
  with_grant_option: false,
  revoked: false,
  access: ['SELECT'],
  ...over,
})

const roleGrant = (over: Partial<RoleGrant> = {}): RoleGrant => ({
  grantee: 'bob',
  is_user: true,
  role: 'analyst',
  is_default: true,
  with_admin_option: false,
  ...over,
})

const report = (over: Partial<AccessReport> = {}): AccessReport => ({
  available: true,
  users: [user()],
  roles: [
    { name: 'analyst', storage: 'local_directory' },
    { name: 'writer', storage: 'local_directory' },
  ],
  grants: [grant()],
  role_grants: [roleGrant()],
  privileges: ['SELECT', 'INSERT'],
  ...over,
})

const bob = { name: 'bob', is_user: true }

describe('whyUnmanageable', () => {
  it('names the file, because that is where somebody has to go', () => {
    // "Cannot be changed" leaves them clicking; naming users.xml does not.
    expect(whyUnmanageable('users_xml')).toMatch(/users\.xml/)
    expect(whyUnmanageable('ldap')).toBe('defined in ldap, which SQL cannot write')
  })

  it('says nothing about the storages SQL writes', () => {
    expect(whyUnmanageable('local_directory')).toBeNull()
    expect(whyUnmanageable('replicated')).toBeNull()
    expect(whyUnmanageable('memory')).toBeNull()
  })

  it('refuses a storage it has never heard of rather than assuming it is writable', () => {
    // The safe way round: a server with something new refuses, instead of
    // offering a button that comes back as code 495.
    expect(whyUnmanageable('some_future_storage')).toMatch(/cannot write/)
  })
})

describe('costOfDropping', () => {
  it('counts what a drop takes away', () => {
    const cost = costOfDropping(report(), bob)
    expect(cost).toEqual({ grants: 1, roles: 1, heldBy: [] })
    expect(saysCost(cost)).toBe('This takes away 1 grant, 1 role it holds.')
  })

  it('counts who would lose a role, which is a different question', () => {
    const cost = costOfDropping(
      report({ role_grants: [roleGrant(), roleGrant({ grantee: 'zoe' })] }),
      { name: 'analyst', is_user: false },
    )
    expect(cost.heldBy).toEqual(['bob', 'zoe'])
    expect(saysCost(cost)).toMatch(/2 accounts that hold it/)
  })

  it('says so plainly when there is nothing to lose', () => {
    const cost = costOfDropping(report({ grants: [], role_grants: [] }), bob)
    expect(saysCost(cost)).toBe('It holds nothing and nobody holds it.')
  })

  it('does not count a role grant as a user grant', () => {
    // Same name, different kind of grantee: `is_user` is the whole difference.
    const cost = costOfDropping(report({ grants: [grant({ is_user: false })] }), bob)
    expect(cost.grants).toBe(0)
  })
})

describe('grantableRoles', () => {
  it('leaves out what is already held', () => {
    // A menu offering a role somebody holds produces a statement the server
    // accepts and that changes nothing, which reads as a broken button.
    expect(grantableRoles(report(), bob).map((r) => r.name)).toEqual(['writer'])
  })

  it('never offers a role to itself', () => {
    expect(
      grantableRoles(report({ role_grants: [] }), { name: 'analyst', is_user: false }).map(
        (r) => r.name,
      ),
    ).toEqual(['writer'])
  })
})

describe('heldRoles', () => {
  it('lists what there is any point revoking', () => {
    expect(heldRoles(report(), bob)).toEqual(['analyst'])
    expect(heldRoles(report(), { name: 'zoe', is_user: true })).toEqual([])
  })
})

describe('scopeProblem', () => {
  it('refuses to quietly widen what somebody typed', () => {
    // Whoever typed `*` and `events` meant something, and it was not "every
    // table" — so it is refused rather than silently reinterpreted.
    expect(scopeProblem('*', 'events')).toMatch(/cannot be narrowed/)
  })

  it('accepts the three shapes a grant actually has', () => {
    expect(scopeProblem('*', '*')).toBeNull()
    expect(scopeProblem('analytics', '*')).toBeNull()
    expect(scopeProblem('analytics', 'events')).toBeNull()
  })

  it('asks for what is missing', () => {
    expect(scopeProblem('', '*')).toMatch(/database is required/)
    expect(scopeProblem('analytics', '')).toMatch(/table is required/)
  })
})

describe('grantedOn', () => {
  it('lists only what is on exactly this scope', () => {
    const r = report({
      grants: [
        grant({ access: ['SELECT', 'INSERT'] }),
        grant({ database: 'system', access: ['SELECT'] }),
      ],
    })
    expect(grantedOn(r, bob, 'analytics', '*')).toEqual(['INSERT', 'SELECT'])
    expect(grantedOn(r, bob, 'analytics', 'events')).toEqual([])
  })

  it('leaves out a partial revoke, which is not a grant', () => {
    const r = report({ grants: [grant({ revoked: true })] })
    expect(grantedOn(r, bob, 'analytics', '*')).toEqual([])
  })
})
