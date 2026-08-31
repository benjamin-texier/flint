import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import {
  accessOf,
  grantsFor,
  holdersOf,
  notesForRole,
  notesForUser,
  rolesFor,
  scopeOf,
  type AccessReport,
  type Note,
} from '../lib/access'
import { Create, Manage } from '../components/AccessActions'
import { LimitsView } from '../components/Limits'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'
import { granteeOfRole, granteeOfUser } from '../lib/rbac'
import { allows } from '../lib/spaces'

/** Infrastructure — Access. */
export function AccessPage() {
  return (
    <div className="page page--diagnose">
      <header className="page__head">
        <p className="eyebrow">INFRASTRUCTURE</p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">Who can do what</h1>
        </div>
      </header>
      <AccessView />
      <LimitsView />
    </div>
  )
}

/** Who can do what.
 *
 *  Read-only, and it says so: pointing out that a user can connect without a
 *  password is a diagnostic; changing that is a decision that belongs in a
 *  statement somebody wrote on purpose. */
export function AccessView() {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })
  const report = useQuery({
    queryKey: ['access'],
    queryFn: () => api.access(),
    staleTime: 30_000,
  })
  /* Changing access is `admin`, which the tier enum's own doc already named it
     as belonging to. Not because a grant destroys data — it does not — but
     because it is the only write that hands somebody *else* every other one.
     Hidden rather than offered and refused: a control that fails at click time
     is worse than one that was never there. */
  const may = allows(config.data?.tier, 'admin')

  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">Users, roles and grants</h2>
        <p className="diag__sub">
          {may
            ? 'Flint points out that somebody can connect without a password, or that a role nobody holds is still carrying grants — and at this tier it can change them. Every statement runs as whoever is signed in, so the server refuses what that account may not do.'
            : 'Read-only at this tier. Flint will point out that somebody can connect without a password, or that a role nobody holds is still carrying grants — it will not change any of it.'}
        </p>
        {may ? <Create /> : null}
      </header>

      {report.isPending ? <Loading label="Reading access control" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}

      {report.data && !report.data.available ? (
        <EmptyNote title="Not visible to this user">{report.data.reason}</EmptyNote>
      ) : null}

      {report.data?.available ? <Body report={report.data} may={may} /> : null}
    </section>
  )
}

function Body({ report, may }: { report: AccessReport; may: boolean }) {
  return (
    <>
      <h3 className="acc__group">
        {report.users.length} user{report.users.length === 1 ? '' : 's'}
      </h3>
      <ul className="acc">
        {report.users.map((user) => {
          const grants = grantsFor(report, user.name, true)
          const roles = rolesFor(report, user.name)
          const notes = notesForUser(user, report.grants, report.role_grants)
          return (
            <li className="acc__item" key={user.name}>
              <div className="acc__head">
                <span className="acc__name">{user.name}</span>
                <span className="mono-dim">{user.auth_type.join(', ') || 'no auth listed'}</span>
                {notes.map((note, i) => (
                  <Flagged note={note} key={i} />
                ))}
              </div>
              {may ? (
                <Manage subject={granteeOfUser(user)} storage={user.storage} report={report} />
              ) : null}
              {roles.length ? (
                <p className="acc__line">
                  <span className="label">ROLES</span>
                  {roles.map((r) => (
                    <span className="acc__role" key={r.role}>
                      {r.role}
                      {r.is_default ? '' : ' (not default)'}
                      {r.with_admin_option ? ' · admin' : ''}
                    </span>
                  ))}
                </p>
              ) : null}
              {grants.length ? (
                <table className="tbl acc__grants">
                  <thead>
                    <tr>
                      <th>On</th>
                      <th>May</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {grants.map((g, i) => (
                      <tr key={i}>
                        <td className="tbl__key">{scopeOf(g)}</td>
                        <td className="mono-dim">{accessOf(g)}</td>
                        <td>
                          {g.with_grant_option ? (
                            <span className="flag flag--idle">and may grant it</span>
                          ) : null}
                          {/* Rare and invisible if you only read the positive
                              rows, which is exactly why it is shown. */}
                          {g.revoked ? <span className="flag flag--error">revoked</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </li>
          )
        })}
      </ul>

      <h3 className="acc__group">
        {report.roles.length} role{report.roles.length === 1 ? '' : 's'}
      </h3>
      {report.roles.length === 0 ? (
        <p className="diag__quiet">No roles are defined — every grant here is direct to a user.</p>
      ) : null}
      <ul className="acc">
        {report.roles.map((role) => {
          const grants = grantsFor(report, role.name, false)
          const holders = holdersOf(report, role.name)
          const notes = notesForRole(role, report.grants, report.role_grants)
          return (
            <li className="acc__item" key={role.name}>
              <div className="acc__head">
                <span className="acc__name">{role.name}</span>
                <span className="mono-dim">
                  {holders.length ? `held by ${holders.join(', ')}` : 'held by nobody'}
                </span>
                {notes.map((note, i) => (
                  <Flagged note={note} key={i} />
                ))}
              </div>
              {may ? (
                <Manage subject={granteeOfRole(role)} storage={role.storage} report={report} />
              ) : null}
              {grants.length ? (
                <table className="tbl acc__grants">
                  <thead>
                    <tr>
                      <th>On</th>
                      <th>May</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {grants.map((g, i) => (
                      <tr key={i}>
                        <td className="tbl__key">{scopeOf(g)}</td>
                        <td className="mono-dim">{accessOf(g)}</td>
                        <td>
                          {g.with_grant_option ? (
                            <span className="flag flag--idle">and may grant it</span>
                          ) : null}
                          {g.revoked ? <span className="flag flag--error">revoked</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </li>
          )
        })}
      </ul>
    </>
  )
}

function Flagged({ note }: { note: Note }) {
  return (
    <span className={`flag flag--${note.level === 'alarm' ? 'firing' : 'error'}`}>{note.says}</span>
  )
}
