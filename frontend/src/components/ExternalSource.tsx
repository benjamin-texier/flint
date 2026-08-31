import {
  EXTERNAL_KIND_LABEL,
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
}: {
  engine: string
  engineFull: string
  scope?: 'table' | 'database'
  /** `data_paths`, which is where a `File` table's path lives. */
  paths?: string[]
}) {
  const source = externalSource(engine, engineFull, { scope, paths })
  if (!source) return null
  return <Panel source={source} />
}

function Panel({ source }: { source: Source }) {
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
    </section>
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
