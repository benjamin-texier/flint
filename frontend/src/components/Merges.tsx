import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { bytes, count, duration } from '../lib/format'
import { current, paths, peak, type Series } from '../lib/health'
import { EmptyNote, ErrorNote, Loading } from './Note'

const WINDOWS = [1, 6, 24] as const

/** What this server has been merging.
 *
 *  "Right now" already says what is merging this second, which answers nothing
 *  about whether the machine has been doing this all night. From
 *  `system.part_log`: how many merges finished, how much they wrote, and which
 *  tables the work went to.
 *
 *  Only `MergeParts` — a merge that *finished*. `MergePartsStart` is the same
 *  merge counted at its beginning, and a page that summed both would double every
 *  figure on it. */
export function Merges() {
  const [hours, setHours] = useState<number>(6)
  const report = useQuery({
    queryKey: ['health', 'merges', hours],
    queryFn: () => api.merges(hours),
    /* A minute. Not five seconds: at the six-hour window a bucket is 108
       seconds wide, so asking faster than that redraws the same line — and
       these panels are read, not watched. `Right now` is the one that needs to
       be live, and it says so. */
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const data = report.data
  const tables = data?.tables ?? []

  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">Merging, over time</h2>
        <p className="diag__sub">
          From <code>system.part_log</code>, counting merges that finished. A table high on this
          list is not in trouble — merging is what a MergeTree does — but a table whose worst
          merge is minutes long, or whose merges fail, is worth a look.
        </p>
      </header>

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

      {report.isPending ? <Loading label="Reading the part log" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}
      {data && !data.available ? <EmptyNote title="No history here">{data.reason}.</EmptyNote> : null}

      {data?.available && tables.length === 0 ? (
        <p className="diag__quiet">Nothing merged in this window.</p>
      ) : null}

      {data?.failed ? (
        <p className="says says--wide says--throw">
          {count(data.failed)} merge{data.failed === 1 ? '' : 's'} failed
          {data.last_exception ? `: ${data.last_exception.split('\n')[0]}` : ''}
        </p>
      ) : null}

      {data?.series.map((s) => <Line key={s.key} series={s} />) ?? null}

      {tables.length && data ? (
        <>
          {/* Counts follow the list: the header must not claim more tables than
              the rows below it show. */}
          <p className="diag__sub">
            {tables.length === data.total_tables
              ? `${count(data.total_tables)} table${data.total_tables === 1 ? '' : 's'} merged`
              : `Showing the ${tables.length} busiest of ${count(data.total_tables)} tables that merged`}
          </p>
          <table className="tbl">
            <thead>
              <tr>
                <th>Table</th>
                <th className="tbl--n">Merges</th>
                <th className="tbl--n">Rows</th>
                <th className="tbl--n">Written</th>
                <th className="tbl--n">Average</th>
                <th className="tbl--n">Worst</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t.qualified}>
                  <td className="tbl__key">{t.qualified}</td>
                  <td className="tbl--n">{count(t.merges)}</td>
                  <td className="tbl--n">{count(t.rows)}</td>
                  <td className="tbl--n mono-dim">{bytes(t.bytes)}</td>
                  {/* `duration` takes seconds; the part log records
                      milliseconds. Left unconverted, a 122ms merge printed as
                      "2m 2s" — plausible enough to survive a reading, and
                      wrong by a thousand. */}
                  <td className="tbl--n mono-dim">{duration(t.avg_ms / 1000)}</td>
                  <td className="tbl--n mono-dim">{duration(t.worst_ms / 1000)}</td>
                  <td className="mono-dim">
                    {t.failed ? (
                      <span className="says says--throw">
                        {count(t.failed)} failed
                      </span>
                    ) : null}
                    {/* Only when it is most of the work. A table with two TTL
                        merges out of four hundred is not a table doing expiry. */}
                    {t.ttl_merges > t.merges / 2 ? (
                      <span>{Math.round((t.ttl_merges / t.merges) * 100)}% for TTL</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  )
}

function Line({ series }: { series: Series }) {
  const now = current(series)
  const top = peak(series)
  const runs = paths(series, 600, 26)
  const fmt = (v: number) => (series.unit === 'bytes' ? bytes(v) : count(v))

  return (
    <div className="spark">
      <div className="spark__head">
        <span className="spark__label">{series.label}</span>
        <span className="spark__now num">
          {now === null ? <span className="dash">not measured</span> : fmt(now)}
        </span>
      </div>
      <svg className="spark__svg" viewBox="0 0 600 26" preserveAspectRatio="none" aria-hidden="true">
        {runs.map((run, i) => (
          <polyline className="spark__line" points={run} key={i} />
        ))}
      </svg>
      <p className="spark__says">
        {series.says}
        {top !== null ? <span className="spark__peak"> Peak {fmt(top)} in one bucket.</span> : null}
      </p>
    </div>
  )
}
