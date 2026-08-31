import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { count, duration } from '../lib/format'
import type { KeeperReport } from '../lib/keeper'
import { EmptyNote, ErrorNote, Loading } from './Note'

/** The Keeper this server talks to.
 *
 *  Everything replicated on a ClickHouse goes through Keeper, and when it is in
 *  trouble the symptom shows up somewhere else entirely — a replica that has
 *  gone read-only, an `ON CLUSTER` statement that never finished. This is the
 *  cause, in its own section, above the places it breaks.
 *
 *  Absence is not an error here and is not reported as one. A ClickHouse with no
 *  Keeper in its configuration does not have `system.zookeeper_connection` at
 *  all — the tables are created conditionally — so asking answers the same
 *  `UNKNOWN_TABLE` an old version would. `system.zookeeper_connection_log`
 *  exists on both and is the tell, which is how the backend can say "no Keeper
 *  is configured" instead of sending somebody to upgrade a server that did not
 *  need upgrading. */
export function Keeper() {
  const report = useQuery({
    queryKey: ['cluster', 'keeper'],
    queryFn: () => api.keeper(),
    staleTime: 20_000,
  })

  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">Keeper</h2>
        <p className="diag__sub">
          The session this server holds, the ensemble as it sees it, and every connect and
          disconnect it has recorded. Everything replicated goes through here, so a problem on
          this line explains problems on several others.
        </p>
      </header>

      {report.isPending ? <Loading label="Reading the Keeper session" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}
      {report.data ? <Body report={report.data} /> : null}
    </section>
  )
}

function Body({ report }: { report: KeeperReport }) {
  if (report.absent) {
    /* Not an error and not a denial: a single-node ClickHouse is a complete
       ClickHouse, and being told it has no Keeper is the answer rather than a
       failure to get one. */
    return <EmptyNote title="No Keeper here">{report.absent}</EmptyNote>
  }

  return (
    <>
      {report.verdicts.length ? (
        <div className="cfg__loud">
          {report.verdicts.map((v, i) => (
            <p key={i}>{v}</p>
          ))}
        </div>
      ) : null}

      {report.session ? (
        <p className="acc__line">
          <span className="label">SESSION</span>
          <span className="mono-dim">
            {report.session.host}:{report.session.port} as “{report.session.name}”, up{' '}
            {duration(report.session.uptime_secs)}, timing out after{' '}
            {duration(report.session.session_timeout_ms / 1000)}
          </span>
          {report.session.expired ? <span className="flag flag--error">expired</span> : null}
        </p>
      ) : (
        <p className="diag__quiet">
          This server holds no Keeper session right now, though it is configured for one.
        </p>
      )}

      <h3 className="acc__group">The ensemble</h3>
      {report.nodes.blocked ? (
        <EmptyNote title="Not visible">{report.nodes.blocked}</EmptyNote>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Node</th>
              <th>State</th>
              <th className="tbl--n">Latency</th>
              <th className="tbl--n">Followers</th>
              <th className="tbl--n">Znodes</th>
              <th className="tbl--n">Watches</th>
            </tr>
          </thead>
          <tbody>
            {report.nodes.items.map((n) => (
              <tr key={`${n.host}:${n.port}`}>
                <td className="tbl__key">
                  {n.host}:{n.port}
                  <span className="says mono-dim">{n.version}</span>
                </td>
                <td>
                  <span className="mono-dim">{n.state}</span>
                  {!n.connected ? <span className="flag flag--error">not answering</span> : null}
                  {n.readonly ? <span className="flag flag--error">read-only</span> : null}
                </td>
                {/* Average beside worst, because an average latency hides the
                    spike that made somebody open this page. */}
                <td className="tbl--n mono-dim">
                  {n.avg_latency} / {n.max_latency} ms
                </td>
                <td className="tbl--n mono-dim">
                  {n.followers ? `${n.synced_followers} of ${n.followers} synced` : ''}
                </td>
                <td className="tbl--n mono-dim">{count(n.znodes)}</td>
                <td className="tbl--n mono-dim">{count(n.watches)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="acc__group">Connects and disconnects</h3>
      {report.history.blocked ? (
        <EmptyNote title="Not visible">{report.history.blocked}</EmptyNote>
      ) : report.history.items.length === 0 ? (
        <p className="diag__quiet">
          Nothing recorded. <code>system.zookeeper_connection_log</code> starts empty and is
          written on each connect, so a server that has never lost its session has one row or
          none.
        </p>
      ) : (
        <>
          {/* The point of the list rather than of any one row: a session that
              keeps being young is a session that keeps being lost, and the
              current-session figure above cannot show that. */}
          <p className="diag__quiet">
            One row per connect and disconnect. A run of these close together is what a flapping
            ensemble looks like, and it is the thing the session figure above cannot say.
          </p>
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>Node</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {report.history.items.map((e, i) => (
                <tr key={i}>
                  <td className="tbl__key mono-dim">{e.at}</td>
                  <td>
                    {e.kind === 'Disconnected' ? (
                      <span className="flag flag--error">disconnected</span>
                    ) : (
                      <span className="flag flag--idle">connected</span>
                    )}
                  </td>
                  <td className="mono-dim">{e.host}</td>
                  {/* Dropped rather than dashed: a plain connect has no reason
                      to give, and four em-dashes down the column would say
                      Flint asked the wrong question of every row. */}
                  <td className="mono-dim">{e.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  )
}
