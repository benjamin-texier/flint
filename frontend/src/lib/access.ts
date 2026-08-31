/** Who can do what.
 *
 *  A dump of `system.grants` is unreadable — ClickHouse stores one row per
 *  privilege, so a full-access user is seventy rows. What a reader wants is the
 *  scopes, and then the handful of facts worth knowing about them: who can log
 *  in without a password, who can grant to others, which role nobody holds.
 *
 *  Read-only by design. Flint will point these out; changing them is a decision
 *  that belongs in a statement somebody wrote on purpose. */

export interface User {
  name: string
  /** Where the account is defined. `local_directory` is what SQL writes;
   *  `users_xml` is a file, and SQL cannot touch it. */
  storage: string
  auth_type: string[]
  host_ip: string[]
  host_names: string[]
  default_roles_all: boolean
  default_roles_list: string[]
  default_database: string
  /** One per authentication method; epoch means no expiry. */
  valid_until: string[]
}

export interface Role {
  name: string
  storage: string
}

export interface Grant {
  grantee: string
  is_user: boolean
  database: string
  table: string
  with_grant_option: boolean
  revoked: boolean
  access: string[]
}

export interface RoleGrant {
  grantee: string
  is_user: boolean
  role: string
  is_default: boolean
  with_admin_option: boolean
}

export interface AccessReport {
  available: boolean
  reason?: string
  users: User[]
  roles: Role[]
  grants: Grant[]
  role_grants: RoleGrant[]
  /** Every privilege this server understands, for the grant form to offer.
   *  Empty where `system.privileges` could not be read, in which case the form
   *  takes free text and lets ClickHouse do the refusing. */
  privileges: string[]
}

/** `analytics.*`, `system.query_log`, `everything`. */
export function scopeOf(grant: Grant): string {
  if (grant.database === '*') return 'everything'
  if (grant.table === '*') return `${grant.database}.*`
  return `${grant.database}.${grant.table}`
}

/** The privileges, shortened where there are too many to read.
 *
 *  A grantee with everything has seventy access types; listing them all says
 *  less than saying there are seventy. */
export function accessOf(grant: Grant, show = 4): string {
  if (grant.access.length <= show) return grant.access.join(', ')
  return `${grant.access.slice(0, show).join(', ')} and ${grant.access.length - show} more`
}

export interface Note {
  /** `watch` is a fact worth seeing; `alarm` is one somebody should act on. */
  level: 'alarm' | 'watch'
  says: string
}

/** What is worth pointing out about one user.
 *
 *  Deliberately few. Every self-hosted ClickHouse has every user reachable from
 *  anywhere, so saying that about each of them is noise — it is only worth
 *  saying beside something else. */
export function notesForUser(
  user: User,
  grants: Grant[],
  roleGrants: RoleGrant[],
): Note[] {
  const notes: Note[] = []
  const mine = grants.filter((g) => g.is_user && g.grantee === user.name)
  const roles = roleGrants.filter((r) => r.is_user && r.grantee === user.name)

  if (user.auth_type.includes('no_password')) {
    notes.push({
      level: 'alarm',
      says: 'can connect with no password at all',
    })
  }
  if (mine.some((g) => g.database === '*' && !g.revoked)) {
    notes.push({ level: 'watch', says: 'has rights on everything' })
  }
  if (mine.some((g) => g.with_grant_option)) {
    notes.push({ level: 'watch', says: 'can grant its rights to others' })
  }
  if (roles.some((r) => r.with_admin_option)) {
    notes.push({ level: 'watch', says: 'can grant its roles to others' })
  }
  if (!mine.length && !roles.length) {
    notes.push({
      level: 'watch',
      says: 'has no rights and no roles — it can connect and see nothing',
    })
  }
  // Epoch is ClickHouse's way of saying "never expires", and there is one
  // entry per authentication method — the earliest real one is the one that
  // matters.
  const expiries = user.valid_until.filter((v) => v && !v.startsWith('1970')).sort()
  if (expiries.length) {
    notes.push({ level: 'watch', says: `expires ${expiries[0]!.slice(0, 16)}` })
  }
  return notes
}

/** A role nobody holds is carrying grants for nobody: dead configuration that
 *  still looks like policy. */
export function notesForRole(role: Role, grants: Grant[], roleGrants: RoleGrant[]): Note[] {
  const notes: Note[] = []
  const held = roleGrants.some((r) => r.role === role.name)
  const mine = grants.filter((g) => !g.is_user && g.grantee === role.name)
  if (!held) {
    notes.push({ level: 'watch', says: 'nobody holds this role' })
  }
  if (!mine.length) {
    notes.push({ level: 'watch', says: 'it grants nothing' })
  }
  if (mine.some((g) => g.database === '*' && !g.revoked)) {
    notes.push({ level: 'watch', says: 'it grants rights on everything' })
  }
  return notes
}

export function grantsFor(report: AccessReport, name: string, isUser: boolean): Grant[] {
  return report.grants.filter((g) => g.is_user === isUser && g.grantee === name)
}

export function rolesFor(report: AccessReport, name: string): RoleGrant[] {
  return report.role_grants.filter((r) => r.is_user && r.grantee === name)
}

export function holdersOf(report: AccessReport, role: string): string[] {
  return report.role_grants.filter((r) => r.role === role).map((r) => r.grantee)
}
