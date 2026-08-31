/** Changing who can do what — the questions the form has to answer before it
 *  draws a button.
 *
 *  All of it is about refusing well. Every control here can be refused for three
 *  different reasons, and they need three different sentences: the deployment is
 *  not at a tier that permits it, the account lives in a file that SQL cannot
 *  write, or the change would take away the last of something. A single "not
 *  allowed" would be true of all three and useful for none.
 */

import type { AccessReport, Grant, Role, RoleGrant, User } from './access'

export interface Grantee {
  name: string
  is_user: boolean
}

/** Storages an account can be changed in.
 *
 *  ClickHouse keeps access control in several places at once and only some of
 *  them are writable: `local_directory` is where SQL puts things, `users_xml`
 *  is the file the container mounts, and `ldap`/`kerberos` are somebody else's
 *  directory entirely. A write against any of the read-only ones comes back as
 *  code 495, so the ones that work are named rather than the ones that do not —
 *  a server with a storage nobody here has seen refuses, which is the safe way
 *  round.
 */
const WRITABLE = new Set(['local_directory', 'memory', 'replicated'])

/** Why this account cannot be changed by Flint — or null when it can.
 *
 *  The reason is the storage, and it is worth saying which: "defined in
 *  users.xml" tells somebody where to go and edit it, where "cannot be changed"
 *  leaves them clicking.
 */
export function whyUnmanageable(storage: string): string | null {
  if (WRITABLE.has(storage)) return null
  if (storage === 'users_xml') {
    return 'defined in users.xml, which SQL cannot write — edit that file instead'
  }
  return `defined in ${storage}, which SQL cannot write`
}

/** What dropping this account or role would take away.
 *
 *  A drop with nothing beside it is a button whose cost is invisible until
 *  afterwards. This is the same reasoning the object drop uses on the Data side,
 *  where the confirmation carries the row count: the number is the decision.
 */
export function costOfDropping(
  report: AccessReport,
  subject: Grantee,
): { grants: number; roles: number; heldBy: string[] } {
  const mine = (g: Grant | RoleGrant) => g.grantee === subject.name && g.is_user === subject.is_user
  return {
    grants: report.grants.filter(mine).length,
    roles: report.role_grants.filter(mine).length,
    // Only meaningful for a role: who would lose it. A user is held by nobody.
    heldBy: subject.is_user
      ? []
      : report.role_grants.filter((g) => g.role === subject.name).map((g) => g.grantee),
  }
}

/** That cost, as the sentence a confirmation needs. */
export function saysCost(cost: ReturnType<typeof costOfDropping>): string {
  const parts: string[] = []
  if (cost.grants) parts.push(`${cost.grants} grant${cost.grants === 1 ? '' : 's'}`)
  if (cost.roles) parts.push(`${cost.roles} role${cost.roles === 1 ? '' : 's'} it holds`)
  if (cost.heldBy.length) {
    parts.push(`${cost.heldBy.length} account${cost.heldBy.length === 1 ? '' : 's'} that hold it`)
  }
  if (!parts.length) return 'It holds nothing and nobody holds it.'
  return `This takes away ${parts.join(', ')}.`
}

/** The roles this account could still be given.
 *
 *  A menu offering a role somebody already holds produces a statement the server
 *  accepts and that changes nothing, which reads as a broken button.
 */
export function grantableRoles(report: AccessReport, subject: Grantee): Role[] {
  const held = new Set(
    report.role_grants
      .filter((g) => g.grantee === subject.name && g.is_user === subject.is_user)
      .map((g) => g.role),
  )
  return report.roles.filter((r) => !held.has(r.name) && r.name !== subject.name)
}

/** The roles this account holds, which are the ones there is any point revoking. */
export function heldRoles(report: AccessReport, subject: Grantee): string[] {
  return report.role_grants
    .filter((g) => g.grantee === subject.name && g.is_user === subject.is_user)
    .map((g) => g.role)
    .sort()
}

/** Whether a scope is spelled the way the server will read it.
 *
 *  `*` in the database position means everything and the table position is then
 *  ignored, which is worth enforcing rather than quietly dropping: somebody who
 *  typed `*` and `events` meant something, and it was not "every table".
 */
export function scopeProblem(database: string, table: string): string | null {
  if (!database.trim()) return 'a database is required, or `*` for every one'
  if (database === '*' && table !== '*' && table.trim()) {
    return 'a grant on every database cannot be narrowed to one table — use `*` for the table too'
  }
  if (!table.trim()) return 'a table is required, or `*` for every one'
  return null
}

/** The privileges an account already has on exactly this scope.
 *
 *  Shown beside the revoke control so it lists what is there rather than
 *  offering all 241 of them, most of which were never granted.
 */
export function grantedOn(
  report: AccessReport,
  subject: Grantee,
  database: string,
  table: string,
): string[] {
  return report.grants
    .filter(
      (g) =>
        g.grantee === subject.name &&
        g.is_user === subject.is_user &&
        g.database === database &&
        g.table === table &&
        !g.revoked,
    )
    .flatMap((g) => g.access)
    .sort()
}

/** The subject a user or role row acts as. */
export function granteeOfUser(user: User): Grantee {
  return { name: user.name, is_user: true }
}

export function granteeOfRole(role: Role): Grantee {
  return { name: role.name, is_user: false }
}
