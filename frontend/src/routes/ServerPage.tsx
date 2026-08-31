import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { api } from '../lib/api'
import { isInternal, orderDatabases } from '../lib/database'
import { bytes, count, exact, uptime } from '../lib/format'
import { MetricLine } from '../components/MetricLine'
import { PartitionGrid } from '../components/PartitionGrid'
import type { Grain } from '../lib/timeline'
import { ShareBar } from '../components/StratumBar'
import { MyGrants } from '../components/MyGrants'
import { Outside } from '../components/Outside'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'

/** Every database on the server. Reached deliberately — Flint opens on a
 *  database, not on a server inventory. */
export function ServerPage() {
  const server = useQuery({ queryKey: ['server'], queryFn: api.server })
  const databases = useQuery({ queryKey: ['databases'], queryFn: api.databases })
  /* The list above answers "where is the disk" — it is sorted and it carries a
     share bar. What no view on this server could be asked until now is which of
     these is *growing*, which is a question about time, so the same grid the
     database pages use is drawn here with a database where a table was. */
  const [grain, setGrain] = useState<Grain>('month')
  const timeline = useQuery({
    queryKey: ['server', 'timeline', grain],
    queryFn: () => api.serverTimeline(grain),
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  })

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
          { value: bytes(totalBytes), label: 'on disk' },
        ]}
        lead
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

      {/* Between the two readings of what is *here* and before the grants: the
          list above is where the disk is, and this is where the disk is not.
          Data rather than Infrastructure, deliberately - it is read-only, and
          where the data comes from is the analyst's question as much as the
          operator's. Under `/infra` it would vanish from every deployment that
          runs with that space switched off. */}
      <section className="section">
        <h2 className="section__title">Reads from outside</h2>
        <p className="section__sub">
          The tables on this server whose rows are somewhere else, grouped by where. A bucket read
          by six tables breaks for all six at once, which is a fact no page that shows one table at
          a time can put in front of you.
        </p>
        <Outside />
      </section>

      <section className="section">
        <h2 className="section__title">Over time</h2>
        <p className="section__sub">
          Every database against the partitions it holds. The list above says which is biggest;
          this says which is growing, and where each one stops.
        </p>
        {timeline.error ? (
          <ErrorNote error={timeline.error} retry={() => timeline.refetch()} />
        ) : timeline.data ? (
          <PartitionGrid report={timeline.data} database="" onGrain={setGrain} />
        ) : (
          <Loading label="Reading partitions" />
        )}
      </section>

      {/* Under the list of databases because that list is its subject, and the
          list is why the question gets asked at all: ClickHouse *filters* the
          system tables rather than refusing them, so a user with no grants gets
          a perfectly successful, perfectly empty inventory. Measured — a user
          holding nothing still gets 200 from every endpoint on this page. There
          is no error to explain the absence, which is exactly why the absence
          needs explaining. */}
      <MyGrants />
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
