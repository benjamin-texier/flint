import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { api, type DatabaseAdvice } from '../lib/api'
import { ranked, rankTally, type Ranked, type TableVerdict } from '../lib/projection'
import { bytes, count, exact } from '../lib/format'
import { EmptyNote, ErrorNote, Loading } from './Note'

/** Which of a database's tables the workload argues about.
 *
 *  The question that comes before opening any single table's Projections tab,
 *  and the one that view cannot answer: it is scoped to one table, and on a
 *  database of forty you have to know which.
 *
 *  What it claims is narrower than it looks, deliberately. This reads the three
 *  costliest shapes on each table; the table's own tab reads sixty. "Does this
 *  table want a projection" cannot be answered from three, and hedging it into
 *  a page that said nothing was the alternative. So every sentence here is
 *  about **the costliest shape** — a well-defined object, answerable from one
 *  statement, and enough to decide which table to open. Everything past that is
 *  a click away. */
export function DatabaseProjections({ database, days }: { database: string; days: number }) {
  const report = useQuery({
    queryKey: ['db-projections', database, days],
    queryFn: () => api.databaseProjections(database, days),
    staleTime: 30_000,
  })

  if (report.isPending) return <Loading label="Reading the workload" />
  if (report.error) return <ErrorNote error={report.error} retry={() => report.refetch()} />
  if (!report.data) return null
  return <Body report={report.data} />
}

const TONE: Record<TableVerdict, { label: string; pill: string }> = {
  // None of them is the alarm colour. A table whose key does not serve its
  // workload is not broken, and a column of red over somebody's schema reads as
  // an accusation rather than as a reading.
  candidate: { label: 'worth a look', pill: 'pill pill--caution' },
  served: { label: 'key serves it', pill: 'pill pill--key' },
  covered: { label: 'a projection answers it', pill: 'pill pill--key' },
  // Neither of these is a finding, and neither is a fault. They are here so a
  // reader can see that the table was considered — a row missing from this list
  // and a row saying "nothing to save here" are different answers.
  unserveable: { label: 'nothing to serve', pill: 'pill' },
  tiny: { label: 'too small to matter', pill: 'pill' },
  unread: { label: 'not read', pill: 'pill' },
}

function Body({ report }: { report: DatabaseAdvice }) {
  const list = useMemo(() => ranked(report), [report])
  const counts = useMemo(() => rankTally(report), [report])

  if (report.blocked) {
    return (
      <EmptyNote title="No workload to read">
        {report.blocked}. Without it there is nothing to rank these tables by — which is the
        honest answer here, not an order invented from their schemas.
      </EmptyNote>
    )
  }
  if (list.length === 0) {
    return (
      <EmptyNote title="Nothing has been read here">
        None of this database&rsquo;s {counts.total} tables was touched by a logged SELECT in the
        last {report.window_days} days.
      </EmptyNote>
    )
  }

  return (
    <section className="dbproj">
      <p className="dbproj__lead">
        {/* Every cap states its own count, and there are three here: the tables
            listed, the tables read, and the tables that could hold a projection
            at all. */}
        {counts.listed === counts.read ? (
          <>
            The {counts.read} {counts.read === 1 ? 'table' : 'tables'} anything read in the last{' '}
            {report.window_days} days
          </>
        ) : (
          <>
            The {counts.listed} busiest of {counts.read} tables read in the last{' '}
            {report.window_days} days
          </>
        )}
        , of {counts.total} that could hold a projection, ordered by the time the workload spent
        on each.{' '}
        {counts.candidates > 0 ? (
          <>
            <strong>{counts.candidates}</strong>{' '}
            {counts.candidates === 1 ? 'has a costliest shape' : 'have a costliest shape'} no key
            serves.
          </>
        ) : (
          <>None of their costliest shapes is one a second physical order would help.</>
        )}
      </p>
      <p className="dbproj__caveat">
        Each reading is of a table&rsquo;s <em>costliest few shapes</em>, not of its whole
        workload — this page reads five per table and the table&rsquo;s own tab reads sixty. It is
        enough to know which one to open, and it is not enough to conclude that a table has
        nothing worth doing.
      </p>

      <table className="tbl">
        <thead>
          <tr>
            <th>Table</th>
            <th className="tbl--n">Time</th>
            <th className="tbl--n">Runs</th>
            <th className="tbl--n">Scan</th>
            <th>What its costliest shapes do</th>
          </tr>
        </thead>
        <tbody>
          {list.map((row) => (
            <Row key={row.standing.table} row={row} database={report.database} />
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Row({ row, database }: { row: Ranked; database: string }) {
  const t = row.standing
  return (
    <tr>
      <td className="tbl__key">
        <Link className="link" to={`/db/${encodeURIComponent(database)}/${encodeURIComponent(t.table)}?tab=projections`}>
          {t.table}
        </Link>
        <span className="says mono-dim">
          {count(t.rows)} rows · {bytes(t.bytes)}
          {t.sorting_key.length > 0 ? <> · by {t.sorting_key.join(', ')}</> : <> · no key</>}
          {t.projections > 0 ? (
            <>
              {' '}
              · {t.projections} projection{t.projections === 1 ? '' : 's'}
              {t.projection_bytes > 0 ? <>, {bytes(t.projection_bytes)}</> : null}
            </>
          ) : null}
        </span>
      </td>
      <td className="tbl--n mono-dim">{exact(t.total_ms)} ms</td>
      <td className="tbl--n mono-dim">
        {count(t.runs)}
        <span className="says">
          {t.shapes} {t.shapes === 1 ? 'shape' : 'shapes'}
        </span>
      </td>
      <td className="tbl--n mono-dim">
        {/* Dropped rather than dashed where there is nothing to divide by. And
            said in words at and above the whole table: `read_rows` and the rows
            the parts hold are different measures, and 101% reads as a
            miscount. */}
        {row.share === null ? (
          ''
        ) : row.share >= 0.99 ? (
          <span className="dbproj__whole">all of it</span>
        ) : (
          `${Math.round(row.share * 100)}%`
        )}
      </td>
      <td>
        <span className={TONE[row.verdict].pill}>{TONE[row.verdict].label}</span>
        <span className="says">{row.says}</span>
      </td>
    </tr>
  )
}
