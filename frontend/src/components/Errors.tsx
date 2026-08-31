import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { count, relativeTime } from '../lib/format'
import { paths, type Series } from '../lib/health'
import { EmptyNote, ErrorNote, Loading } from './Note'

const WINDOWS = [1, 6, 24] as const

/** What has been going wrong, and when.
 *
 *  This used to sit inside "Right now" and count since the server started, which
 *  is the one thing it could not be: on a server up for eleven days, "42 access
 *  denied" says nothing about whether anybody should care today. `system.error_log`
 *  samples the counters over time, so the question becomes answerable — and where
 *  that table is switched off the panel falls back to the lifetime snapshot and
 *  says so, rather than quietly changing what its numbers mean. */
export function Errors() {
  const [hours, setHours] = useState<number>(6)
  const report = useQuery({
    queryKey: ['health', 'errors', hours],
    queryFn: () => api.healthErrors(hours),
    /* A minute. Not five seconds: at the six-hour window a bucket is 108
       seconds wide, so asking faster than that redraws the same line — and
       these panels are read, not watched. `Right now` is the one that needs to
       be live, and it says so. */
    refetchInterval: 60_000,
    staleTime: 20_000,
  })
  const data = report.data
  const errors = data?.errors ?? []

  /* The same shape the sparklines use, so the line is drawn by the same code
     with the same rules about gaps. */
  const series: Series = {
    key: 'errors',
    label: 'Errors',
    says: '',
    unit: 'count',
    points: data?.points ?? [],
  }
  const runs = data?.windowed ? paths(series, 600, 26) : []

  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">What has gone wrong</h2>
        <p className="diag__sub">
          {data && !data.windowed
            ? 'Counted since the server started — this build keeps no error history, so there is no window to narrow and no trend to draw.'
            : 'From system.error_log, which samples the counters over time. Not only from queries: some of these happen where nothing was asked, and appear nowhere else in Flint.'}
        </p>
      </header>

      {data?.windowed !== false ? (
        <div className="diag__filter">
          <span className="label">WINDOW</span>
          <div className="segmented">
            {WINDOWS.map((h) => (
              <button
                key={h}
                className={`segmented__item${hours === h ? ' is-on' : ''}`}
                onClick={() => setHours(h)}
              >
                {h === 1 ? '1 hour' : h === 24 ? '24 hours' : `${h} hours`}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {report.isPending ? <Loading label="Reading the error log" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}
      {data && !data.available ? <EmptyNote title="Not available here">{data.reason}.</EmptyNote> : null}

      {data?.available && errors.length === 0 ? (
        <p className="diag__quiet">
          {data.windowed
            ? 'Nothing has gone wrong in this window.'
            : 'Nothing has gone wrong since the server started.'}
        </p>
      ) : null}

      {runs.length ? (
        <svg className="spark__svg" viewBox="0 0 600 26" preserveAspectRatio="none" aria-hidden="true">
          {runs.map((run, i) => (
            <polyline className="spark__line spark__line--bad" points={run} key={i} />
          ))}
        </svg>
      ) : null}

      {errors.length ? (
        <table className="tbl">
          <thead>
            <tr>
              <th>Error</th>
              <th className="tbl--n">Times</th>
              <th>Last</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {errors.map((e) => (
              <tr key={`${e.code}-${e.name}`}>
                <td className="tbl__key">{e.name}</td>
                <td className="tbl--n">{count(e.times)}</td>
                <td className="mono-dim">{relativeTime(e.last)}</td>
                <td>
                  {/* One clause. ClickHouse appends paragraphs to some of these,
                      and a table cell is not where they belong. */}
                  <span className="diag__msg" title={e.message}>
                    {e.message.split('\n')[0]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  )
}
