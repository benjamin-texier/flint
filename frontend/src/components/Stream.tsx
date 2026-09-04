import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { count, duration, exact, relativeTime } from '../lib/format'
import {
  consumerState,
  foldErrors,
  foldFiles,
  foldSeconds,
  kafkaVerdicts,
  never,
  orderedSettings,
  queueVerdicts,
  saysAssignments,
  type ConsumerState,
  type FoldedError,
  type KafkaConsumer,
  type KafkaState,
  type QueueState,
} from '../lib/stream'
import { EmptyNote, ErrorNote, Loading } from './Note'
import { Wide } from './Wide'

/** Whether a streaming table is moving anything.
 *
 *  Every other tab on this page describes rows the server holds. A `Kafka` or
 *  an `S3Queue` table holds none — it runs in the background, and when it stops
 *  the only symptom is a target table that quietly stops growing. Nothing in a
 *  query result says so, and until this tab nothing in Flint did either.
 *
 *  The rows are readings; the sentences above them are judgements, and they
 *  live in `lib/stream` where they are tested. */
export function Stream({ database, table }: { database: string; table: string }) {
  const report = useQuery({
    queryKey: ['stream', database, table],
    queryFn: () => api.stream(database, table),
    // A consumer's position moves every couple of seconds. Long enough not to
    // re-ask on every tab switch, short enough that "last poll: 40s ago" is not
    // a lie by the time it is read.
    staleTime: 10_000,
  })

  if (report.isPending) return <Loading label="Reading the background reader" />
  if (report.error) return <ErrorNote error={report.error} retry={() => report.refetch()} />
  const data = report.data
  if (!data) return null

  if (data.kafka) return <Consumers state={data.kafka} />
  if (data.queue) return <Queue state={data.queue} />
  return (
    <EmptyNote title="Nothing runs in the background here">
      This engine is read when somebody queries it, so there is no consumer to report on.
    </EmptyNote>
  )
}

const STATE_LABEL: Record<ConsumerState, string> = {
  unstarted: 'never polled',
  failing: 'failing',
  running: 'running',
  stopped: 'not polling',
}

function Consumers({ state }: { state: KafkaState }) {
  if (state.consumers.blocked) {
    return <EmptyNote title="Not visible to this user">{state.consumers.blocked}</EmptyNote>
  }
  const consumers = state.consumers.items
  if (consumers.length === 0) {
    return (
      <EmptyNote title="No consumers">
        The server reports no consumer for this table. It has one per{' '}
        <code>kafka_num_consumers</code> from the moment it is created, so none at all means the
        table was only just made — or that this replica is not the one running it.
      </EmptyNote>
    )
  }

  const verdicts = kafkaVerdicts(state)

  return (
    <div className="stack">
      {verdicts.length > 0 ? (
        <div className="cfg__loud">
          {verdicts.map((v) => (
            <p key={v}>{v}</p>
          ))}
        </div>
      ) : null}

      {/* Who drains the topic. First, because it is the fact that decides
          whether any of the figures below can move at all. */}
      <div className="panel">
        <div className="panel__bar">
          <span className="panel__count">Drained by</span>
          <span className="panel__spacer" />
          <span className="panel__hint">a Kafka table consumes only while something reads it</span>
        </div>
        <div className="strm__chains">
          {state.dependencies.length === 0 ? (
            <p className="strm__none">
              Nothing. No materialized view selects from this table, so its consumers sit idle.
            </p>
          ) : (
            state.dependencies.map((chain) => (
              <p className="strm__chain" key={chain.join('>')}>
                {chain.map((step, i) => (
                  <span key={step}>
                    {i > 0 ? <span className="strm__arrow">→</span> : null}
                    <code>{step}</code>
                  </span>
                ))}
              </p>
            ))
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel__bar">
          <span className="panel__count">
            {consumers.length} {consumers.length === 1 ? 'consumer' : 'consumers'}
          </span>
          <span className="panel__spacer" />
          <span className="panel__hint">from system.kafka_consumers</span>
        </div>
        <Wide label="Consumers">
          <table className="tbl">
            <thead>
              <tr>
                <th>Consumer</th>
                <th className="tbl--n">Read</th>
                <th className="tbl--n">Commits</th>
                <th>Last poll</th>
                <th>Last commit</th>
              </tr>
            </thead>
            <tbody>
              {consumers.map((c, i) => (
                <Consumer key={c.consumer_id || i} consumer={c} />
              ))}
            </tbody>
          </table>
        </Wide>
      </div>
    </div>
  )
}

function Consumer({ consumer }: { consumer: KafkaConsumer }) {
  const state = consumerState(consumer)
  const folded = foldErrors(consumer.errors)
  return (
    <tr>
      <td className="tbl__key">
        {/* A consumer with no id has not joined the group. Naming it by its
            state rather than printing an empty cell, which would read as a
            missing reading rather than as the reading it is. */}
        {consumer.consumer_id ? (
          <span className="strm__id">{consumer.consumer_id}</span>
        ) : (
          <span className="mono-dim">not joined</span>
        )}
        <span className={`flag flag--${state === 'failing' ? 'throw' : state === 'running' ? 'ok' : 'watch'}`}>
          {STATE_LABEL[state]}
        </span>
        <span className="says says--wide">{saysAssignments(consumer.assignments)}</span>
        {consumer.assigned > 0 ? (
          <span className="says says--wide">
            assigned {exact(consumer.assigned)}{' '}
            {consumer.assigned === 1 ? 'time' : 'times'}, revoked {exact(consumer.revocations)}
          </span>
        ) : null}
        {folded.map((error) => (
          <Error key={error.text} error={error} />
        ))}
      </td>
      <td className="tbl--n mono-dim">{count(consumer.messages_read)}</td>
      <td className="tbl--n mono-dim">{count(consumer.commits)}</td>
      <td className="mono-dim">
        {/* Dropped rather than dashed, and the sentence beside it says which of
            the two nothings this is. */}
        {never(consumer.last_poll) ? (
          <span className="says">never</span>
        ) : (
          relativeTime(consumer.last_poll)
        )}
      </td>
      <td className="mono-dim">
        {never(consumer.last_commit) ? (
          <span className="says">never</span>
        ) : (
          relativeTime(consumer.last_commit)
        )}
      </td>
    </tr>
  )
}

/** One error, however many times the ring holds it. */
function Error({ error }: { error: FoldedError }) {
  return (
    <span className="says says--wide says--throw">
      {error.text}
      {error.count > 1 ? (
        <span className="strm__repeat">
          {' '}
          — the same error {error.count} times
          {/* The span, not the two ends: ten copies two seconds apart render as
              "just now to just now", which is a range that says nothing. */}
          {foldSeconds(error.first, error.last) > 0
            ? ` over ${duration(foldSeconds(error.first, error.last))}`
            : ''}
        </span>
      ) : null}
    </span>
  )
}

function Queue({ state }: { state: QueueState }) {
  const verdicts = queueVerdicts(state)
  const settings = orderedSettings(state.settings)
  const files = state.files.items
  const folded = foldFiles(files)

  return (
    <div className="stack">
      {verdicts.length > 0 ? (
        <div className="cfg__loud">
          {verdicts.map((v) => (
            <p key={v}>{v}</p>
          ))}
        </div>
      ) : null}

      {settings.length > 0 ? (
        <dl className="xsrc__facts">
          {settings.map((s) => (
            <div className="xsrc__fact" key={s.name}>
              <dt className="xsrc__label">{s.name.replace(/_/g, ' ')}</dt>
              <dd className="xsrc__value">{s.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {state.files.blocked ? (
        <EmptyNote title="Not visible to this user">{state.files.blocked}</EmptyNote>
      ) : files.length === 0 ? (
        <EmptyNote title="Nothing in the log">
          This queue has taken no object that <code>system.s3queue_log</code> still holds. The log
          has a TTL, so a queue that last ran a long time ago reads the same as one that has never
          run.
        </EmptyNote>
      ) : (
        <div className="panel">
          <div className="panel__bar">
            <span className="panel__count">
              {exact(state.processed)} processed · {exact(state.failed)} failed ·{' '}
              {count(state.rows)} rows
            </span>
            <span className="panel__spacer" />
            {/* Every cap states its own count, and this one states its window
                too: the log has a TTL, and a history that quietly stops is
                worse than none. */}
            <span className="panel__hint">
              {files.length < state.total
                ? `the ${files.length} most recent attempts of ${state.total}`
                : `all ${state.total} attempts`}
              {folded.length < files.length ? `, ${folded.length} rows after folding repeats` : ''}
              {state.since ? `, back to ${state.since}` : ''}
            </span>
          </div>
          <Wide label="Attempts">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Object</th>
                  <th className="tbl--n">Rows</th>
                  <th>Taken</th>
                </tr>
              </thead>
              <tbody>
                {folded.map(({ file: f, attempts, first, last }) => (
                  <tr key={`${f.name}-${f.status}-${last}`}>
                    <td className="tbl__key">
                      <span className="strm__id">{f.name}</span>
                      {f.status === 'Failed' ? (
                        <span className="flag flag--throw">failed</span>
                      ) : null}
                      {attempts > 1 ? (
                        <span className="says">
                          {attempts} attempts
                          {foldSeconds(first, last) > 0
                            ? ` over ${duration(foldSeconds(first, last))}`
                            : ''}
                        </span>
                      ) : null}
                      {f.exception ? (
                        <span className="says says--wide says--throw">{f.exception}</span>
                      ) : null}
                    </td>
                    {/* Zero is printed rather than dropped. An object taken and
                        parsed into nothing is the quiet failure this tab exists
                        for, and a blank cell would hide exactly it. */}
                    <td className="tbl--n mono-dim">{count(f.rows)}</td>
                    <td className="mono-dim">
                      {f.started ? relativeTime(f.started) : ''}
                      {f.millis > 0 ? <span className="says">took {f.millis} ms</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Wide>
        </div>
      )}
    </div>
  )
}
