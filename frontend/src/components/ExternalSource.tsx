import { useMutation } from '@tanstack/react-query'

import { api } from '../lib/api'
import { saysAttempt, verdictOf } from '../lib/connect'
import {
  EXTERNAL_KIND_LABEL,
  backgroundReader,
  externalNotes,
  externalSource,
  externalWhere,
  type ExternalSource as Source,
} from '../lib/external'

/** The address of a table whose rows are not in ClickHouse.
 *
 *  Every other block on an object's page describes rows the server holds. For an
 *  `S3`, a `PostgreSQL` or a `Kafka` table there are none, and the figures those
 *  blocks would print are all zero — so this takes their place at the top of the
 *  page and answers the only question that object raises: *which bucket, which
 *  database, which topic*.
 *
 *  It is deliberately not a card among cards. It sits in the header, under the
 *  sentence that says what the engine does, because for these tables the
 *  location **is** the identity: `events` on `kafka1:9092` is a different table
 *  from `events` on `kafka2:9092`, and nothing else on the page can tell them
 *  apart. */
export function ExternalPanel({
  engine,
  engineFull,
  scope = 'table',
  paths,
  database,
  table,
}: {
  engine: string
  engineFull: string
  scope?: 'table' | 'database'
  /** `data_paths`, which is where a `File` table's path lives. */
  paths?: string[]
  /** Which object this describes, so the panel can offer to check it. Absent
   *  on a database, which has nothing to ask for. */
  database?: string
  table?: string
}) {
  const source = externalSource(engine, engineFull, { scope, paths })
  if (!source) return null
  return (
    <Panel
      source={source}
      /* Only where there is a table to check. A database engine has no rows to
         ask for, and the two queue engines are refused by the backend anyway —
         reading them takes from them, and they have a tab that reads their
         state instead. */
      check={
        scope === 'table' && table && database && !backgroundReader(engine)
          ? { database, table }
          : null
      }
    />
  )
}

function Panel({
  source,
  check,
}: {
  source: Source
  check: { database: string; table: string } | null
}) {
  const notes = externalNotes(source)
  return (
    <section className="xsrc" aria-label="Where these rows are">
      <p className="xsrc__kind">{EXTERNAL_KIND_LABEL[source.kind]}</p>

      {/* The location, in the far end's own spelling. Selectable and in the data
          font because the next thing somebody does with a bucket path is paste
          it into a terminal. */}
      <p className="xsrc__where">
        {source.target ? <span className="xsrc__target">{source.target}</span> : null}
        {source.at ? (
          <span className="xsrc__at">
            {source.target ? <span className="xsrc__on">on</span> : null}
            {source.at}
          </span>
        ) : null}
        {!source.target && !source.at && source.collection ? (
          <span className="xsrc__target">{source.collection}</span>
        ) : null}
      </p>

      {source.facts.length > 0 ? (
        <dl className="xsrc__facts">
          {source.facts.map((fact) => (
            <div className="xsrc__fact" key={fact.label}>
              <dt className="xsrc__label">{fact.label}</dt>
              <dd className="xsrc__value">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {notes.map((note) => (
        <p className="xsrc__note" key={note}>
          {note}
        </p>
      ))}

      {check ? <Check database={check.database} table={check.table} /> : null}
    </section>
  )
}

/** Ask the far end, once, now.
 *
 *  A button rather than something the page does on its own. Everything else on
 *  this page is a read of `system.*` on a server Flint is already talking to;
 *  this opens a connection to somebody else's infrastructure, and a page that
 *  contacts a production Postgres because a tab was opened is a page nobody can
 *  leave open. */
function Check({ database, table }: { database: string; table: string }) {
  const ask = useMutation({ mutationFn: () => api.connect(database, table) })
  const attempt = ask.data
  const verdict = attempt ? verdictOf(attempt) : null

  return (
    <div className="xsrc__check">
      <button className="btn btn--quiet" onClick={() => ask.mutate()} disabled={ask.isPending}>
        {ask.isPending ? 'Asking…' : attempt ? 'Check again' : 'Check the connection'}
      </button>
      {/* The request itself failing is a different thing from the far end not
          answering — one is Flint or ClickHouse, the other is the address. */}
      {ask.error ? (
        <span className="xsrc__verdict xsrc__verdict--failed">
          {ask.error instanceof Error ? ask.error.message : 'The check could not be run.'}
        </span>
      ) : null}
      {attempt && verdict ? (
        <span className={`xsrc__verdict xsrc__verdict--${verdict}`}>{saysAttempt(attempt)}</span>
      ) : null}
    </div>
  )
}

/** The same address on one line, for the diagram's side panel — where the
 *  location has to compete with the keys, the traffic and the sample, and a
 *  four-line block would win an argument it should not be in. */
export function ExternalLine({ engine, engineFull }: { engine: string; engineFull: string }) {
  const source = externalSource(engine, engineFull)
  const where = source ? externalWhere(source) : ''
  if (!source || !where) return null
  return (
    <p className="xsrcline" title={`${EXTERNAL_KIND_LABEL[source.kind]}: ${where}`}>
      <span className="xsrcline__kind">{EXTERNAL_KIND_LABEL[source.kind]}</span>
      <span className="xsrcline__where">{where}</span>
    </p>
  )
}
