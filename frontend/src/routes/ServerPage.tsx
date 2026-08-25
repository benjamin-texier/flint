import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { api } from '../lib/api'
import { isInternal, orderDatabases } from '../lib/database'
import { bytes, count, exact, uptime } from '../lib/format'
import { MetricLine } from '../components/MetricLine'
import { ShareBar } from '../components/StratumBar'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'

/** Every database on the server. Reached deliberately — Flint opens on a
 *  database, not on a server inventory. */
export function ServerPage() {
  const server = useQuery({ queryKey: ['server'], queryFn: api.server })
  const databases = useQuery({ queryKey: ['databases'], queryFn: api.databases })

  if (server.error) return <ErrorNote error={server.error} retry={() => server.refetch()} />
  if (databases.error)
    return <ErrorNote error={databases.error} retry={() => databases.refetch()} />
  if (!server.data || !databases.data) return <Loading label="Reading the server" />

  const list = databases.data
  const totalBytes = list.reduce((sum, d) => sum + d.bytes, 0)
  const totalRows = list.reduce((sum, d) => sum + d.rows, 0)
  // Counted off the list rather than taken from `system.databases`, so the
  // headline and the table below it cannot disagree — the metadata database is
  // listed under one of its two names, and a database this user cannot see is
  // not one this page should claim.
  const totalObjects = list.reduce(
    (sum, d) => sum + d.tables + d.views + d.materialized_views + d.dictionaries,
    0,
  )
  // The share is about where *your* disk goes. `system` is routinely an order
  // of magnitude larger than a young database of your own, and scaling against
  // it drew every real row as a sliver — so ClickHouse's own databases set no
  // scale and get no bar. Their sizes are still in the column beside it.
  const maxBytes = Math.max(...list.filter((d) => !isInternal(d.name)).map((d) => d.bytes), 1)
  const ordered = orderDatabases(list)

  return (
    <article className="page">
      <header className="page__head">
        <p className="eyebrow">Server</p>
        <h1 className="page__title">{server.data.current_user}@ClickHouse</h1>
        <p className="page__sub">
          version {server.data.version} · {server.data.timezone} · up{' '}
          {uptime(server.data.uptime_seconds)}
        </p>
      </header>

      <MetricLine
        metrics={[
          { value: exact(list.length), label: 'databases' },
          { value: exact(totalObjects), label: 'objects' },
          { value: count(totalRows), label: 'rows' },
          { value: bytes(totalBytes), label: 'on disk', accent: true },
        ]}
      />

      <section className="section">
        <h2 className="section__title">Databases</h2>
        {list.length === 0 ? (
          <EmptyNote title="No databases visible">
            This user may lack SHOW DATABASES. Grant it, or connect as a user that has it.
          </EmptyNote>
        ) : (
          <div className="panel">
            <div className="panel__bar">
              <span className="panel__count">
                {list.length} {list.length === 1 ? 'database' : 'databases'}
              </span>
            </div>
            <div className="panel__scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th className="tbl--n">Tables</th>
                <th className="tbl--n">Views</th>
                <th className="tbl--n">Mat. views</th>
                <th className="tbl--n">Dicts</th>
                <th className="tbl--n">Rows</th>
                <th className="tbl--n">On disk</th>
                <th className="tbl__bar">Share</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((d) => (
                <tr key={d.name} className={isInternal(d.name) ? 'is-muted' : undefined}>
                  <td className="tbl__key">
                    <Link to={`/db/${encodeURIComponent(d.name)}`} className="link">
                      {d.name}
                    </Link>
                    {d.comment ? <span className="tbl__note">{d.comment}</span> : null}
                  </td>
                  <td className="tbl--n">{num(d.tables)}</td>
                  <td className="tbl--n">{num(d.views)}</td>
                  <td className="tbl--n">{num(d.materialized_views)}</td>
                  <td className="tbl--n">{num(d.dictionaries)}</td>
                  <td className="tbl--n">{num(d.rows)}</td>
                  <td className="tbl--n">{num(d.bytes, bytes)}</td>
                  <td className="tbl__bar">
                    {isInternal(d.name) ? null : <ShareBar value={d.bytes} max={maxBytes} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
            </div>
          </div>
        )}
      </section>
    </article>
  )
}

/** A zero is a fact — a database with no tables really has none — so it is
 *  shown rather than dashed. A dash is reserved for what ClickHouse does not
 *  report, and every count here comes from a `count()`. It is set quietly, so a
 *  column of zeros does not compete with the numbers that carry something. */
function num(value: number, format: (n: number) => string = count) {
  return value === 0 ? <span className="zero">{format(0)}</span> : format(value)
}
