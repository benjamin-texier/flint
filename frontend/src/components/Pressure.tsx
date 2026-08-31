import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../lib/api'
import { bytes, count, duration } from '../lib/format'
import { fullnessOf, pressureOf } from '../lib/limits'
import {
  saysQuiet,
  saysUptime,
  split,
  staleness,
  type Gauge,
  type NowReport,
  type Unit,
} from '../lib/now'
import { EmptyNote, ErrorNote, Loading } from './Note'

/** What the server is running against.
 *
 *  The section above says what is *running*; this says how much room is left to
 *  run it in. Every figure here is paired with its ceiling wherever the server
 *  publishes one, because eighty numbers with no scale is a wall and the same
 *  eighty against what the server will allow is a page somebody can act on.
 *
 *  `system.events` is deliberately not among the sources. It counts from boot,
 *  and on a server up for eleven days "forty-two million selects" is true and
 *  says nothing about this minute — the same mistake the errors panel made once
 *  and had to be rebuilt out of. The rates come from `system.metric_log`, whose
 *  `ProfileEvent_*` columns are already per-second deltas. */
export function Pressure() {
  /* Off by default, and it says the interval. A page that quietly asks a
     production server for two hundred metrics every two seconds is a page that
     costs something nobody agreed to; a snapshot with the reading's own age on
     it is honest, and watching is one click. */
  const [watching, setWatching] = useState(false)
  const report = useQuery({
    queryKey: ['now'],
    queryFn: () => api.now(),
    refetchInterval: watching ? 5_000 : false,
    placeholderData: (prev) => prev,
  })

  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">What it is running against</h2>
        <p className="diag__sub">
          From <code>system.metrics</code> and <code>system.asynchronous_metrics</code>, which are
          instantaneous, each paired with the ceiling the server would refuse at. A ceiling of zero
          means no limit and is left off rather than drawn as a full bar.
          {report.data?.uptime_secs !== undefined ? (
            <> The server is {saysUptime(report.data.uptime_secs)}.</>
          ) : null}
        </p>
        <p className="rbac__row">
          <button
            className={`btn${watching ? ' is-on' : ''}`}
            aria-pressed={watching}
            onClick={() => setWatching(!watching)}
          >
            {watching ? 'Watching, every 5s' : 'Keep watching'}
          </button>
          {!watching ? (
            <button className="btn" onClick={() => report.refetch()} disabled={report.isFetching}>
              {report.isFetching ? 'Reading…' : 'Read it again'}
            </button>
          ) : null}
        </p>
      </header>

      {report.isPending ? <Loading label="Reading the metrics" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}
      {report.data ? <Body report={report.data} /> : null}
    </section>
  )
}

function Body({ report }: { report: NowReport }) {
  const { firing, quiet, saturation, figures } = split(report.gauges.items)
  const clear = saysQuiet(quiet)
  const stale = staleness(report.rates_age_secs)

  if (report.gauges.blocked) {
    return <EmptyNote title="Not visible to this user">{report.gauges.blocked}</EmptyNote>
  }

  return (
    <>
      {firing.length ? (
        <div className="cfg__loud">
          {firing.map((g) => (
            <p key={g.source}>
              <strong>
                {g.name}: {figure(g.value, g.unit)}
              </strong>
              {g.note ? ` — ${g.note}` : ''}
            </p>
          ))}
        </div>
      ) : null}
      {/* Named rather than counted. "3 checks are clear" says nothing about
          which, and the value of the line is that somebody sees the thing they
          were worried about is one of the ones being watched. */}
      {clear ? <p className="diag__quiet">{clear}</p> : null}

      {saturation.length ? <Gauges title="Against a ceiling" items={saturation} /> : null}
      {figures.length ? (
        <Gauges title="For context — the server publishes no limit for these" items={figures} />
      ) : null}

      <h3 className="acc__group">Per second</h3>
      {report.rates.blocked ? (
        <EmptyNote title="No rate to take">{report.rates.blocked}</EmptyNote>
      ) : (
        <>
          <p className="diag__quiet">
            From the newest bucket of <code>system.metric_log</code>, whose{' '}
            <code>ProfileEvent_*</code> columns are deltas rather than running totals.{' '}
            {stale ? <span className="says--watch">{stale}</span> : `Measured at ${report.rates_at}.`}
          </p>
          <table className="tbl">
            <tbody>
              {report.rates.items.map((r) => (
                <tr key={r.source}>
                  <td className="tbl__key">{r.name}</td>
                  <td className="tbl--n mono-dim">{figure(r.per_second, r.unit)}</td>
                  <td className="mono-dim">per second</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  )
}

function Gauges({ title, items }: { title: string; items: Gauge[] }) {
  /* The context group has no ceilings at all, so the column would be empty down
     every row — a heading nobody can reconcile with the cells under it. The
     first version of this claimed in a comment that the case never arose, and
     the browser had it in every row. */
  const anyCeiling = items.some((g) => g.ceiling !== undefined)
  return (
    <>
      <h3 className="acc__group">{title}</h3>
      <table className="tbl">
        <thead>
          <tr>
            <th>Figure</th>
            <th className="tbl--n">Now</th>
            {anyCeiling ? <th className="tbl--n">Ceiling</th> : null}
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {items.map((g) => (
            <tr key={g.source}>
              <td className="tbl__key" title={g.source}>
                {g.name}
                {/* The object the figure is about, where it is about one. A
                    parts count with no table name is a number nobody can act
                    on. */}
                {g.detail ? <span className="says">{g.detail}</span> : null}
              </td>
              <td className="tbl--n">
                {g.ceiling !== undefined ? (
                  <Bar value={g.value} ceiling={g.ceiling} unit={g.unit} />
                ) : (
                  <span className="mono-dim">{figure(g.value, g.unit)}</span>
                )}
              </td>
              {/* Dropped rather than dashed. The column is the ceiling's and
                  never a place to repeat the value. */}
              {anyCeiling ? (
                <td className="tbl--n mono-dim">
                  {g.ceiling !== undefined ? figure(g.ceiling, g.unit) : ''}
                </td>
              ) : null}
              <td>
                {g.note ? <span className="says">{g.note}</span> : null}
                {g.ceiling_from ? (
                  <span className="says mono-dim">{g.ceiling_from}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function Bar({ value, ceiling, unit }: { value: number; ceiling: number; unit: Unit }) {
  const f = fullnessOf(value, ceiling)
  const band = pressureOf(value, ceiling)
  if (f === null || band === null) return <span className="mono-dim">{figure(value, unit)}</span>
  return (
    <span className="gauge" title={`${figure(value, unit)} of ${figure(ceiling, unit)}`}>
      <span className="gauge__value">{figure(value, unit)}</span>
      <span className="gauge__track">
        {/* The same `max(2px, …)` as the quota bars: a percent of a percent
            rounds to nothing and draws as an empty bar, and an empty bar says
            none rather than some. */}
        <span
          className={`gauge__fill gauge__fill--${band}`}
          style={{ width: f > 0 ? `max(2px, ${f * 100}%)` : 0 }}
        />
      </span>
    </span>
  )
}

function figure(n: number, unit: Unit): string {
  if (unit === 'bytes') return bytes(n)
  if (unit === 'seconds') return duration(n)
  return count(n)
}
