import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { foldPrivileges, saysGrants, saysVia, showsHow, type Grant } from '../lib/grants'
import { EmptyNote, ErrorNote, Loading } from './Note'

/** Data — what the person at the keyboard may see.
 *
 *  It sits under the list of databases because that list is its subject: an
 *  analyst who cannot find a database is asking this question, and asking it
 *  here saves them a walk through an operator's pages to find an answer about
 *  themselves.
 *
 *  Read-only, deliberately. Arranging access is Infrastructure's Users & RBAC,
 *  where a mistake costs somebody else something. */
export function MyGrants() {
  const mine = useQuery({ queryKey: ['me', 'grants'], queryFn: api.myGrants, staleTime: 60_000 })

  return (
    <section className="section">
      <h2 className="section__title">What you may see</h2>
      <p className="section__sub">
        Asked of the server as you, with <code>SHOW GRANTS</code> — which answers even where
        the access tables refuse, and refusing them is the ordinary case for the person asking.
      </p>

      {mine.isPending ? <Loading label="Reading your grants" /> : null}
      {mine.error ? <ErrorNote error={mine.error} retry={() => mine.refetch()} /> : null}

      {mine.data ? (
        <>
          <p className="diag__sub">
            {mine.data.user} — {saysGrants(mine.data)}
          </p>

          {/* A short list that looks complete is the failure mode here: the
              reader concludes they hold less than they do, or — worse, if a
              role's grants are the missing ones — that a database is closed to
              them when it is not. */}
          {mine.data.partial ? (
            <div className="cfg__loud">
              <p>{mine.data.partial}</p>
            </div>
          ) : null}

          {mine.data.grants.length ? (
            <GrantTable grants={mine.data.grants} may="May" />
          ) : null}

          {/* Kept below the grants and named as what it is. `SHOW GRANTS`
              returns statements, and some of them take something away — listed
              among the permissions, a revoke reads as one. */}
          {mine.data.revokes.length ? (
            <>
              <p className="diag__sub">
                And {mine.data.revokes.length === 1 ? 'one exception' : 'these exceptions'}, carved
                back out of the grants above.
              </p>
              <GrantTable grants={mine.data.revokes} may="May not" />
            </>
          ) : null}

          {!mine.data.grants.length && !mine.data.revokes.length ? (
            <EmptyNote title="Nothing granted">
              This user holds no grants on this server. Every database is invisible rather than
              empty, and an operator has to grant something before anything appears.
            </EmptyNote>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

/** The list, with the third column only where it would say something.
 *
 *  For the ordinary user every grant is direct and none is passable on, so
 *  `How` is blank in every row — furniture with a heading on it. */
function GrantTable({ grants, may }: { grants: Grant[]; may: string }) {
  const how = showsHow(grants)

  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>{may}</th>
          <th>On</th>
          {how ? <th>How</th> : null}
        </tr>
      </thead>
      <tbody>
        {grants.map((g) => (
          <Row grant={g} how={how} key={`${g.what}-${g.on}`} />
        ))}
      </tbody>
    </table>
  )
}

function Row({ grant, how }: { grant: Grant; how: boolean }) {
  const { shown, hidden } = foldPrivileges(grant.what)
  const via = saysVia(grant)

  return (
    <tr>
      {/* The whole statement in the title: the fold below keeps the column
          readable, and somebody checking an exact privilege should not have to
          go and ask the server again. */}
      <td className="tbl__key mono-dim" title={grant.statement}>
        {shown.join(', ')}
        {hidden ? <span className="says">and {hidden} more</span> : null}
      </td>
      <td className="mono-dim">{grant.on}</td>
      {how ? (
        <td>
          {via ? <span className="says">{via}</span> : null}
          {grant.grantable ? <span className="says">can grant it to others</span> : null}
        </td>
      ) : null}
    </tr>
  )
}
