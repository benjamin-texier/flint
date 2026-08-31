import { useQuery } from '@tanstack/react-query'

import { Keeper } from '../components/Keeper'

import { api } from '../lib/api'
import { count } from '../lib/format'
import {
  foldDdl,
  saysDdl,
  withoutUuid,
  nodeVerdict,
  rings,
  selfOnly,
  stuck,
  type DdlReport,
  type QueueReport,
  type Topology as TopologyReport,
} from '../lib/cluster'
import { Section, type Q } from '../components/Diag'
import { EmptyNote } from '../components/Note'
import { ReplicationView } from './Replication'

/** Infrastructure — Clusters: the ring around this node.
 *
 *  Read from the one server Flint sits beside, which is enough: `system.clusters`
 *  is this server's own configuration, `system.replication_queue` is what this
 *  replica has left to apply, and `system.distributed_ddl_queue` is a ledger every
 *  node shares. A per-server Flint can therefore tell the truth about the ring
 *  without becoming a fleet console.
 *
 *  A server that is not in a cluster is not a broken cluster. Everything on this
 *  page has to be sayable about a single node that is perfectly healthy, and the
 *  page says exactly that rather than drawing one box and calling it a topology. */
export function ClusterPage() {
  const topology = useQuery({ queryKey: ['cluster', 'topology'], queryFn: () => api.topology(), staleTime: 30_000 })
  const queue = useQuery({
    queryKey: ['cluster', 'replication-queue'],
    queryFn: () => api.replicationQueue(),
    // A queue is a moving thing, and a stale one is worse than none.
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  })
  const ddl = useQuery({ queryKey: ['cluster', 'ddl-queue'], queryFn: () => api.ddlQueue(), staleTime: 20_000 })

  return (
    <div className="page page--diagnose">
      <header className="page__head">
        <p className="eyebrow">INFRASTRUCTURE</p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">The ring around this node</h1>
        </div>
      </header>

      <Topology report={topology} />
      {/* Above the places it breaks. A replica gone read-only and an
          `ON CLUSTER` that never finished are both symptoms of this line. */}
      <Keeper />
      <ReplicationView />
      <Queue report={queue} />
      <Ddl report={ddl} />
    </div>
  )
}

/** Shards and replicas, as this server's configuration describes them. */
function Topology({ report }: { report: Q<TopologyReport> }) {
  const data = report.data
  const all = rings(data?.nodes ?? [])
  /* The `default` ring — one endpoint, itself — is on every ClickHouse and
     nobody deployed it. Folded away beside a real one, and counted rather than
     dropped in silence. */
  const found = all.filter((r) => !selfOnly(r))
  const folded = all.length - found.length

  return (
    <Section
      title="Shards and replicas"
      sub="From this server's own cluster configuration — what it believes it can send a query to, not what has answered lately."
      q={report}
    >
      {data?.single_node ? (
        <p className="diag__quiet">
          This server is not in a cluster. The one entry it has points at itself, which is what
          every default ClickHouse configuration carries — nothing here is missing.
        </p>
      ) : null}

      {!data?.single_node && found.length === 0 ? (
        <EmptyNote title="No clusters configured">
          Nothing in this server's configuration names a cluster, so there is no ring to draw.
        </EmptyNote>
      ) : null}

      {folded && found.length ? (
        <p className="diag__sub">
          {folded} self-only cluster{folded === 1 ? '' : 's'} hidden — one endpoint, this server,
          which every ClickHouse configuration carries.
        </p>
      ) : null}

      {!data?.single_node
        ? found.map((ring) => (
            <div className="ring" key={ring.cluster}>
              <div className="ring__head">
                <span className="ring__name">{ring.cluster}</span>
                <span className="ring__count">
                  {ring.shards.length} shard{ring.shards.length === 1 ? '' : 's'} ·{' '}
                  {ring.nodes} endpoint{ring.nodes === 1 ? '' : 's'}
                </span>
              </div>
              <div className="ring__shards">
                {ring.shards.map((shard) => (
                  <div className="shard" key={shard.shard}>
                    <span className="shard__num">shard {shard.shard}</span>
                    <div className="shard__replicas">
                      {shard.replicas.map((replica) => {
                        const verdict = nodeVerdict(replica)
                        return (
                          <div
                            className={`rnode${replica.is_local ? ' rnode--here' : ''}${
                              verdict ? ` rnode--${verdict.level}` : ''
                            }`}
                            key={`${replica.host_name}:${replica.port}:${replica.replica_num}`}
                          >
                            <span className="rnode__host">{replica.host_name}</span>
                            <span className="rnode__port">:{replica.port}</span>
                            {replica.is_local ? <span className="rnode__here">this server</span> : null}
                            {verdict ? <span className="rnode__says">{verdict.says}</span> : null}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        : null}
    </Section>
  )
}

/** What this replica has fetched and not yet applied. */
function Queue({ report }: { report: Q<QueueReport> }) {
  const data = report.data
  const entries = data?.entries ?? []
  const stuckCount = entries.filter(stuck).length

  return (
    <Section
      title="Replication queue"
      sub="Work this replica has been told about and not yet done. Ordered by failures rather than by age: an entry retried two hundred times is the story, whatever its neighbours' timestamps say."
      q={report}
    >
      {data?.available && entries.length === 0 ? (
        <p className="diag__quiet">Nothing queued — this replica has applied everything it knows about.</p>
      ) : null}

      {entries.length ? (
        <>
          <p className="diag__sub">
            {entries.length === data?.total
              ? `${count(data.total)} queued`
              : `Showing ${entries.length} of ${count(data?.total ?? 0)} queued`}
            {stuckCount ? `, ${stuckCount} failing repeatedly` : ''}
          </p>
          <table className="tbl">
            <thead>
              <tr>
                <th>Table</th>
                <th>Wants</th>
                <th className="tbl--n">Tries</th>
                <th>Since</th>
                <th>Why it has not happened</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.database}.${e.table}-${e.created_time}-${i}`}>
                  <td className="tbl__key">
                    {e.database}.{e.table}
                  </td>
                  <td className="mono-dim">{e.kind}</td>
                  <td className="tbl--n">
                    {e.num_tries}
                    {stuck(e) ? <span className="says says--throw">stuck</span> : null}
                  </td>
                  <td className="mono-dim">{e.created_time}</td>
                  <td className="mono-dim">
                    {e.last_exception || e.postpone_reason || (e.is_currently_executing ? 'running now' : '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </Section>
  )
}

/** `ON CLUSTER` statements, and the node that did not get one. */
function Ddl({ report }: { report: Q<DdlReport> }) {
  const statements = foldDdl(report.data?.entries ?? [])
  const failed = statements.filter((s) => s.failed.length).length
  const waiting = statements.filter((s) => !s.failed.length && s.pending.length).length

  return (
    <Section
      title="Distributed DDL"
      sub="Every ON CLUSTER statement, folded back to one row from the row-per-host the server keeps. A host that failed is marked Finished by the server, so the status alone would call it a success."
      q={report}
    >
      {report.data?.available && statements.length === 0 ? (
        <p className="diag__quiet">Nothing in the ledger — no ON CLUSTER statement has run.</p>
      ) : null}

      {statements.length ? (
        <>
          {/* The counts follow the list they describe, and each names what it
              counts: a statement that failed somewhere and one still waiting on
              a node are different problems with different remedies. */}
          <p className="diag__sub">
            {count(statements.length)} recent {statements.length === 1 ? 'statement' : 'statements'}
            {failed ? `, ${failed} that failed on a host` : ''}
            {waiting ? `, ${waiting} still waiting on a host` : ''}
          </p>
          <table className="tbl">
            <thead>
              <tr>
                <th>Statement</th>
                <th>Where it ran</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {statements.map((s) => (
                <tr key={s.entry}>
                  {/* The written statement in the column, the server's rewrite
                      in the title: the UUID it inserts is the same shape on
                      every row and is never what the reader came for. */}
                  <td className="tbl__key mono-dim" title={s.query}>
                    {withoutUuid(s.query)}
                  </td>
                  <td>
                    {s.failed[0] ? (
                      <>
                        <span className="flag flag--job-bad">{saysDdl(s)}</span>
                        {/* One exception, not one per host: four nodes failing
                            the same statement fail it for the same reason, and
                            four copies of one sentence is a wall. */}
                        <span className="says says--throw">
                          {s.failed[0].exception_text || `code ${s.failed[0].exception_code}`}
                        </span>
                      </>
                    ) : s.pending.length ? (
                      <span className="says">{saysDdl(s)}</span>
                    ) : (
                      <span className="mono-dim">{saysDdl(s)}</span>
                    )}
                  </td>
                  <td className="mono-dim">{s.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </Section>
  )
}
