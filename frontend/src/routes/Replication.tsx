import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

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
import { allows } from '../lib/spaces'

/** Are the replicas keeping up?
 *
 *  Replication fails quietly. A replica that has lost its Keeper session keeps
 *  answering `SELECT` perfectly while refusing every write, so the first sign is
 *  usually a failed insert somewhere else entirely — which is exactly the kind of
 *  thing a page like this exists to say out loud. */
export function ReplicationView() {
  /* What this deployment permits. `admin`, not `ddl`: these do not touch a row or
     a column, they operate the server — and `RESTART REPLICA` on a busy table is
     something somebody should have decided to allow before the button existed.
     The route checks the same tier; hiding the control is a courtesy. */
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.config() })
  const mayOperate = allows(config.data?.tier, 'admin')
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
        <ReplicaRow
          key={`${replica.database}.${replica.table}`}
          replica={replica}
          mayOperate={mayOperate}
        />
      ))}
    </section>
  )
}

/** What can be asked of this replica.
 *
 *  On the row that says it is behind, because that is the diagnosis these repair
 *  — an action a screen away from the number that justifies it gets used without
 *  the number.
 *
 *  Each one becomes a job, so the answer is a row in Operations rather than a
 *  spinner here: `SYSTEM SYNC REPLICA` waits for the whole backlog, and a button
 *  that holds the page for that is a button people stop trusting. The two fetch
 *  controls are instant and are jobs anyway — the row is the record of who asked.
 *
 *  `Restart` is separated and named for what it is. The other three are routine;
 *  re-initialising a replica from Keeper is the one you do when something is
 *  already wrong. */
function ReplicaActions({ replica }: { replica: Replica }) {
  const queryClient = useQueryClient()
  const ask = useMutation({
    mutationFn: (action: string) =>
      api.replicaAction(replica.database, replica.table, action),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['replication'] })
      queryClient.invalidateQueries({ queryKey: ['cluster', 'replication-queue'] })
    },
  })

  return (
    <div className="racts">
      <button className="btn" onClick={() => ask.mutate('sync')} disabled={ask.isPending}>
        Sync
      </button>
      <button
        className="btn"
        onClick={() => ask.mutate('stop-fetches')}
        disabled={ask.isPending}
        title="Stop pulling parts from the other replicas — what you do before taking this node out."
      >
        Stop fetches
      </button>
      <button className="btn" onClick={() => ask.mutate('start-fetches')} disabled={ask.isPending}>
        Start fetches
      </button>
      <span className="racts__gap" />
      <button
        className="btn"
        onClick={() => ask.mutate('restart')}
        disabled={ask.isPending}
        title="Re-read this replica's state from Keeper. The repair for a replica that lost its session and went read-only."
      >
        Restart replica
      </button>
      {ask.error ? (
        <span className="racts__error">
          {ask.error instanceof Error ? ask.error.message : 'it was refused'}
        </span>
      ) : null}
    </div>
  )
}

function ReplicaRow({ replica, mayOperate }: { replica: Replica; mayOperate: boolean }) {
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

      {mayOperate ? <ReplicaActions replica={replica} /> : null}
    </article>
  )
}
