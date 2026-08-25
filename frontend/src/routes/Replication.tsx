import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { count, relativeTime } from '../lib/format'
import {
  HEALTH_LABEL,
  clusterOf,
  delayOf,
  summarise,
  verdictOf,
  worstFirst,
  type Replica,
} from '../lib/replication'
import { EmptyNote, ErrorNote, Loading } from '../components/Note'

/** Infrastructure — Replication. */
export function ReplicationPage() {
  return (
    <div className="page page--diagnose">
      <header className="page__head">
        <p className="eyebrow">INFRASTRUCTURE</p>
        <div className="page__titlerow">
          <h1 className="page__title page__title--hero">Whether the replicas are keeping up</h1>
        </div>
      </header>
      <ReplicationView />
    </div>
  )
}

/** Are the replicas keeping up?
 *
 *  Replication fails quietly. A replica that has lost its Keeper session keeps
 *  answering `SELECT` perfectly while refusing every write, so the first sign is
 *  usually a failed insert somewhere else entirely — which is exactly the kind of
 *  thing a page like this exists to say out loud. */
export function ReplicationView() {
  const report = useQuery({
    queryKey: ['replication'],
    queryFn: () => api.replication(),
    // "Right now", like running queries: a replica falling behind is a moving
    // number, and a stale one is worse than none.
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  })

  const replicas = report.data?.replicas ?? []

  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">Replicas</h2>
        <p className="diag__sub">
          One row per replicated table on <em>this</em> node. Read-only outranks every delay: a
          replica that lost its Keeper session still serves reads, so it looks healthy until an
          insert fails. Lost parts outrank even that — those are gone, not late.
        </p>
      </header>

      {report.isPending ? <Loading label="Reading the replicas" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}

      {/* Only when something is wrong. On a cluster with a hundred replicas the
          count is the headline; with everything caught up it is a vanity number,
          and the rows below already say so one at a time. */}
      {summarise(report.data) ? (
        <p className="says says--watch">{summarise(report.data)}</p>
      ) : null}

      {report.data && !report.data.available ? (
        <EmptyNote title="Not visible to this user">{report.data.reason}</EmptyNote>
      ) : null}

      {report.data?.available && replicas.length === 0 ? (
        <EmptyNote title="Nothing is replicated">
          No table on this server uses a Replicated engine, so there is no replication to check.
          Nothing is wrong — a single node is a perfectly ordinary way to run ClickHouse.
        </EmptyNote>
      ) : null}

      {worstFirst(replicas).map((replica) => (
        <ReplicaRow key={`${replica.database}.${replica.table}`} replica={replica} />
      ))}
    </section>
  )
}

function ReplicaRow({ replica }: { replica: Replica }) {
  const verdict = verdictOf(replica)
  const queued = replica.oldest_queued && !replica.oldest_queued.startsWith('1970')
  /* Both of these are answers Keeper gives. Without a session the server still
     returns numbers — a delay of seconds-since-the-epoch, a count of 0 of 0 —
     and printing them would state as fact something nobody measured. */
  const delay = delayOf(replica)
  const cluster = clusterOf(replica)

  return (
    <article className={`pipe pipe--${verdict.health}`}>
      <header className="pipe__head">
        <h3 className="pipe__name">
          {replica.database}.{replica.table}
        </h3>
        <span
          className={`flag flag--${
            verdict.health === 'keeping-up'
              ? 'ok'
              : verdict.health === 'lost' || verdict.health === 'stuck'
                ? 'firing'
                : 'idle'
          }`}
        >
          {HEALTH_LABEL[verdict.health]}
        </span>
        {/* Leadership decides which replica assigns merges. Worth showing, not
            worth a verdict: a follower is not a problem. */}
        {replica.is_leader ? <span className="flag flag--idle">leader</span> : null}
      </header>

      <p className="pipe__says">{verdict.says}</p>

      <p className="pipe__facts">
        <span className="mono-dim">{replica.engine}</span>
        <span className="mono-dim">
          {cluster ? `${cluster.active}/${cluster.total} up` : 'replicas unknown'}
        </span>
        <span className="mono-dim">{delay === null ? 'delay unknown' : `${delay}s behind`}</span>
        <span className="mono-dim">
          queue {count(replica.queue_size)} ({count(replica.inserts_in_queue)} insert
          {replica.inserts_in_queue === 1 ? '' : 's'}, {count(replica.merges_in_queue)} merge
          {replica.merges_in_queue === 1 ? '' : 's'})
        </span>
        {queued ? (
          <span className="mono-dim">oldest queued {relativeTime(replica.oldest_queued)}</span>
        ) : null}
      </p>

      {/* Both exceptions, separately: a queue entry that keeps failing and a
          Keeper connection that dropped are different repairs. */}
      {replica.queue_exception ? (
        <p className="says says--throw">queue: {replica.queue_exception}</p>
      ) : null}
      {replica.zookeeper_exception && replica.zookeeper_exception !== replica.queue_exception ? (
        <p className="says says--throw">Keeper: {replica.zookeeper_exception}</p>
      ) : null}
    </article>
  )
}
