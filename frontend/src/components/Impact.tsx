import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { api } from '../lib/api'
import { bytes, count } from '../lib/format'
import { declared, inferred, verdict } from '../lib/impact'

/** If this went away.
 *
 *  Above `Read by`, which answers the neighbouring question — who uses this and
 *  which of its columns. This one is transitive and it carries what would be
 *  lost, because those are the two things a decision needs and neither is in a
 *  list of names.
 *
 *  The certainty split is the whole point. `declared` is ClickHouse's own
 *  dependency list, so the server will itself break; `inferred` is Flint having
 *  read a definition with something that is deliberately not a SQL parser. A
 *  single number over both would be a promise Flint cannot make about half of
 *  it. */
export function Impact({ database, table }: { database: string; table: string }) {
  const report = useQuery({
    queryKey: ['impact', database, table],
    queryFn: () => api.impact(database, table),
    staleTime: 30_000,
    retry: false,
  })
  const data = report.data
  const line = verdict(data)
  const sure = declared(data)
  const guessed = inferred(data)

  /* Nothing depends on it and nothing is stored: there is no sentence worth a
     panel. A table with rows still gets one, because "what would be lost" is an
     answer even when nothing breaks. */
  if (!data?.available) return null
  if (!line && data.rows === 0) return null

  return (
    <section className="card">
      <header className="card__head">
        <h3 className="card__title">If this went away</h3>
        <span className="src__facts">
          {data.rows > 0 ? `${count(data.rows)} rows · ${bytes(data.bytes)}` : 'stores nothing'}
        </span>
      </header>

      {line ? <p className="impact__line">{line}.</p> : null}

      {sure.length ? (
        <>
          <p className="impact__kind">
            ClickHouse itself depends on these — it registered the dependency, and dropping this
            breaks them:
          </p>
          <ul className="plain">
            {sure.map((d) => (
              <li key={d.qualified}>
                <Link className="link" to={`/db/${enc(d.qualified)}`}>
                  {d.qualified}
                </Link>
                <span className="impact__what">{d.kind}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {guessed.length ? (
        <>
          <p className="impact__kind">
            {/* Said as what it is. The reader deserves to know which half of this
                list is a reading of SQL rather than the server's own record. */}
            These name it in their definition. Flint read that with something that is not a SQL
            parser, so it can miss a reference built out of strings — and catch one in a comment:
          </p>
          <ul className="plain">
            {guessed.map((d) => (
              <li key={d.qualified}>
                <Link className="link" to={`/db/${enc(d.qualified)}`}>
                  {d.qualified}
                </Link>
                <span className="impact__what">{d.kind}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {!line && data.rows > 0 ? (
        <p className="impact__line">Nothing reads it. Only its own rows would go.</p>
      ) : null}
    </section>
  )
}

/** `analytics.events` as a route: the table page takes them separately. */
function enc(qualified: string): string {
  const dot = qualified.indexOf('.')
  if (dot < 0) return encodeURIComponent(qualified)
  return `${encodeURIComponent(qualified.slice(0, dot))}/${encodeURIComponent(
    qualified.slice(dot + 1),
  )}`
}
