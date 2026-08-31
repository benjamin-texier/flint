import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import { firstLine, fold, summary } from '../lib/changes'
import { EmptyNote, ErrorNote, Loading } from './Note'

/** How this object's structure came to be what it is.
 *
 *  Under the definition, because the definition is *what* it is and this is
 *  *how*. No other ClickHouse console shows it, and the server has been recording
 *  it all along — `system.query_log` knows the kind of every statement and the
 *  tables it touched.
 *
 *  Each row says whether it came through Flint. Read off the `query_id` the job
 *  runner already sets, so nothing extra is written to make it true, and a
 *  statement somebody ran in a terminal is honestly marked as not having come
 *  from here. */
export function Changes({ database, table }: { database: string; table: string }) {
  const report = useQuery({
    queryKey: ['changes', database, table],
    queryFn: () => api.changes(database, table),
    staleTime: 30_000,
    retry: false,
  })
  const data = report.data
  const changes = data?.changes ?? []
  /* Folded, because Flint's own workspace bootstrap runs
     `CREATE TABLE IF NOT EXISTS` on every start and thirty restarts is thirty
     identical rows burying the one `ALTER` somebody came to find. */
  const runs = fold(changes)
  const line = summary(data)

  return (
    <section className="card">
      <header className="card__head">
        <h3 className="card__title">How it got here</h3>
        {line ? <span className="src__facts">{line}</span> : null}
      </header>

      {report.isPending ? <Loading label="Reading the query log" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}
      {data && !data.available ? (
        <EmptyNote title="Nothing recorded it">{data.reason}.</EmptyNote>
      ) : null}

      {data?.available && changes.length === 0 ? (
        <p className="chg__none">
          Nothing has created, altered, renamed or dropped this in the log Flint can see
          {data.oldest ? `, which goes back to ${data.oldest}` : ''}. A `CREATE DATABASE` names no
          table and never appears here, and the log has a TTL — so this is quiet, not empty.
        </p>
      ) : null}

      {runs.length ? (
        <>
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Kind</th>
                <th>Statement</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run, i) => {
                const c = run.latest
                return (
                <tr key={`${c.at}-${i}`}>
                  <td className="mono-dim">
                    {relativeTime(c.at)}
                    {run.times > 1 ? (
                      <span className="chg__times">
                        ×{run.times}, back to {relativeTime(run.first_at)}
                      </span>
                    ) : null}
                  </td>
                  <td className="tbl__key">
                    {c.user}
                    {c.through_flint ? <span className="chg__via">through Flint</span> : null}
                  </td>
                  {/* ClickHouse's own word, repeated rather than translated: it
                      files `TRUNCATE` under `Drop`, and paraphrasing that would
                      be Flint disagreeing with the log it is quoting. */}
                  <td className="mono-dim">{c.kind}</td>
                  <td>
                    <span className="chg__sql" title={c.statement}>
                      {firstLine(c.statement)}
                    </span>
                    {c.error ? (
                      <span className="says says--throw">refused: {firstLine(c.error)}</span>
                    ) : null}
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
          {data?.oldest ? (
            <p className="chg__none">
              The log Flint can see goes back to {data.oldest}. Anything older has aged out of
              `system.query_log`, so this history starts there rather than at the beginning.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
