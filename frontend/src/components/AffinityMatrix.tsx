import { useMemo } from 'react'
import { Link } from 'react-router-dom'

import { exact } from '../lib/format'
import {
  WINDOWS,
  WINDOW_LABEL,
  WINDOW_MEANING,
  buildMatrix,
  declaredPairs,
  leftOut,
  shortName,
  span,
  type AffinityReport,
  type MatrixCell,
  type Window,
} from '../lib/affinity'
import type { SchemaGraph } from '../lib/graph'
import { EmptyNote } from './Note'

/** Which tables get read in the same statement.
 *
 *  The diagram beside this one draws what somebody declared. This draws what
 *  actually happens — and the point is the difference: a cell that is heavy and
 *  has no ring around it is a join performed constantly that no object in the
 *  database records. That relationship exists whether or not anybody wrote it
 *  down, and this is the only view here that can find it. */
export function AffinityMatrix({
  report,
  graph,
  database,
  onWindow,
}: {
  report: AffinityReport
  /** The declared edges, for marking the cells the schema already knows about.
   *  Optional: the matrix is worth drawing without them, with the marks and
   *  their meaning left off rather than guessed. */
  graph?: SchemaGraph
  database: string
  /** Changing the window is a different question to the server, so it lives with
   *  whoever owns the query. */
  onWindow: (days: Window) => void
}) {
  const declared = useMemo(() => declaredPairs(graph?.edges ?? []), [graph])
  const matrix = useMemo(() => buildMatrix(report, declared), [report, declared])
  const omissions = leftOut(matrix, report)

  if (!report.available) {
    return (
      <EmptyNote title="Nothing to read this from">
        {report.reason ?? 'system.query_log cannot be read here'}, so what is queried together
        cannot be known. The schema diagram is unaffected — it does not need the log.
      </EmptyNote>
    )
  }

  if (matrix.labels.length < 2) {
    return (
      <EmptyNote title="Nothing read together yet">
        {span(report)}. Two tables have to appear in one statement for this to have anything to
        draw.
      </EmptyNote>
    )
  }

  return (
    <div className="paff">
      <div className="paff__bar">
        <p className="paff__text">
          {span(report)}
          {matrix.undeclared > 0 ? (
            <span className="paff__rest">
              {' '}
              · {exact(matrix.undeclared)} of the pairs drawn are not declared anywhere in the
              schema
            </span>
          ) : null}
        </p>
        <span className="panel__spacer" />
        <div className="segmented" role="group" aria-label="How far back the log is read">
          {WINDOWS.map((d) => (
            <button
              key={d}
              className={`segmented__item${report.days === d ? ' is-on' : ''}`}
              aria-pressed={report.days === d}
              title={WINDOW_MEANING[d]}
              onClick={() => onWindow(d)}
            >
              {WINDOW_LABEL[d]}
            </button>
          ))}
        </div>
      </div>

      <p className="paff__legend">
        A cell is how often two tables were named in the same statement, against the busiest pair.
        {graph ? (
          <>
            {' '}
            A <span className="paff__ringword">ring</span> means the schema already declares a
            dependency between them — a view being read pulls its sources into the same row of the
            log, so those are expected. The heavy cells <em>without</em> one are the finding: a join
            nothing in the database records.
          </>
        ) : null}
      </p>

      <div className="paff__scroll">
        <table className="paff__table">
          <caption className="sr-only">
            Tables of {database} against the tables they are read with, over the last {report.days}{' '}
            days
          </caption>
          <thead>
            <tr>
              <th scope="col" className="paff__corner">
                Table
              </th>
              {matrix.labels.map((label) => (
                <th key={label} scope="col" className="paff__col" title={label}>
                  <span className="paff__collabel">{shortName(label, database)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.labels.map((label, row) => {
              const node = report.nodes.find((n) => n.qualified === label)
              const [db, ...rest] = label.split('.')
              return (
                <tr key={label}>
                  <th scope="row" className="paff__row">
                    <Link
                      className="objlink"
                      to={`/db/${encodeURIComponent(db ?? database)}/${encodeURIComponent(
                        rest.join('.'),
                      )}`}
                    >
                      {shortName(label, database)}
                    </Link>
                    <span className="paff__rowsub">
                      {exact(node?.queries ?? 0)} reads ·{' '}
                      {exact(node?.readers ?? 0)}{' '}
                      {(node?.readers ?? 0) === 1 ? 'reader' : 'readers'}
                    </span>
                  </th>
                  {matrix.labels.map((other, col) => (
                    <Cell
                      key={other}
                      cell={matrix.cells[row]![col]}
                      self={row === col}
                      a={shortName(label, database)}
                      b={shortName(other, database)}
                    />
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="paff__caption">
        Read from <code>system.query_log</code> over the last {report.days} days: finished
        statements only, ClickHouse's own tables and Flint's own introspection left out.
        {omissions.length ? <span className="paff__left"> · {omissions.join(' · ')}</span> : null}
      </p>
    </div>
  )
}

function Cell({
  cell,
  self,
  a,
  b,
}: {
  cell: MatrixCell | undefined
  self: boolean
  a: string
  b: string
}) {
  /* The diagonal is a table with itself, which is not a fact about anything —
     its own read count is on the row header. Drawn as a hairline rather than
     left blank so the eye can find the diagonal and read outwards from it. */
  if (self) {
    return (
      <td className="paff__cell">
        <span className="amark amark--self" aria-hidden="true" />
        <span className="sr-only">itself</span>
      </td>
    )
  }
  if (!cell) {
    return (
      <td className="paff__cell">
        <span className="amark amark--never" title={`${a} and ${b} were never read together`} aria-hidden="true" />
        <span className="sr-only">never together</span>
      </td>
    )
  }
  return (
    <td className="paff__cell">
      <span
        className={`amark${cell.declared ? ' amark--declared' : ''}${cell.past ? ' amark--past' : ''}`}
        style={{ '--fill': cell.fill } as React.CSSProperties}
        title={`${a} + ${b}\n${exact(cell.queries)} statements named both${
          cell.declared
            ? '\nthe schema declares a dependency between them'
            : '\nnothing in the schema relates these two'
        }${cell.past ? '\npast the scale — drawn full' : ''}`}
      />
      <span className="sr-only">
        {exact(cell.queries)}
        {cell.declared ? ', declared' : ''}
      </span>
    </td>
  )
}
