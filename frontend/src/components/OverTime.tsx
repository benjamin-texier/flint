import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { bytes, count } from '../lib/format'
import {
  current,
  gaps,
  paths,
  peak,
  saturation,
  type Series,
} from '../lib/health'
import { EmptyNote, ErrorNote, Loading } from './Note'

const WINDOWS = [1, 6, 24] as const

/** What the server has been doing, not just what it is doing.
 *
 *  Five lines, from a table with 1911 columns. The restraint is the design: a
 *  page that draws every metric ClickHouse exposes is a page nobody reads, and
 *  each of these answers a question somebody actually has when a server is
 *  unhappy — which is why each carries a sentence saying which question.
 *
 *  No y-axis, no legend, no tooltip. A sparkline's job is to say "this is the
 *  shape of it" beside a number that says "and this is where it is now"; the
 *  moment it needs axes it should have been a chart on a page of its own. */
export function OverTime() {
  const [hours, setHours] = useState<number>(6)
  const report = useQuery({
    queryKey: ['health', 'series', hours],
    queryFn: () => api.series(hours),
    /* A minute. Not five seconds: at the six-hour window a bucket is 108
       seconds wide, so asking faster than that redraws the same line — and
       these panels are read, not watched. `Right now` is the one that needs to
       be live, and it says so. */
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  return (
    <section className="diag">
      <header className="diag__head">
        <h2 className="diag__title">Over time</h2>
        <p className="diag__sub">
          From <code>system.metric_log</code>, which keeps a row a second. Gauges are shown at
          each bucket&apos;s peak rather than its average: a minute in which memory touched its
          limit for two seconds is a minute worth seeing, and an average hides it.
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
        {report.data?.available && report.data.from ? (
          <span className="diag__filternote">
            {report.data.step_seconds}s buckets, from {report.data.from}
          </span>
        ) : null}
      </div>

      {report.isPending ? <Loading label="Reading the metric log" /> : null}
      {report.error ? <ErrorNote error={report.error} retry={() => report.refetch()} /> : null}
      {report.data && !report.data.available ? (
        <EmptyNote title="No history here">{report.data.reason}.</EmptyNote>
      ) : null}

      {report.data?.available
        ? report.data.series.map((s) => <SeriesRow key={s.key} series={s} />)
        : null}
    </section>
  )
}

function format(value: number, unit: Series['unit']): string {
  if (unit === 'bytes') return bytes(value)
  if (unit === 'percent') return `${Math.round(value)}%`
  return count(value)
}

function SeriesRow({ series }: { series: Series }) {
  const now = current(series)
  const top = peak(series)
  const missing = gaps(series)
  const share = saturation(series)
  const runs = paths(series, 600, 34)

  return (
    <div className="spark">
      <div className="spark__head">
        <span className="spark__label">{series.label}</span>
        <span className="spark__now num">
          {now === null ? <span className="dash">not measured</span> : format(now, series.unit)}
        </span>
      </div>

      <svg className="spark__svg" viewBox="0 0 600 34" preserveAspectRatio="none" aria-hidden="true">
        {/* The ceiling, where it is a real limit rather than a drawing
            convenience: a pool at 15 of 32 should look half full. */}
        {series.limit ? <line className="spark__limit" x1="0" y1="0.5" x2="600" y2="0.5" /> : null}
        {runs.map((run, i) => (
          <polyline className="spark__line" points={run} key={i} />
        ))}
      </svg>

      <p className="spark__says">
        {series.says}
        {top !== null ? <span className="spark__peak"> Peak {format(top, series.unit)}</span> : null}
        {share !== null && series.limit ? (
          <span className="spark__peak">
            {' '}
            — {Math.round(share)}% of {format(series.limit, series.unit)}
          </span>
        ) : null}
        {/* Said, not hidden: a line with holes in it should say how many. */}
        {missing ? (
          <span className="spark__gaps">
            {' '}
            {missing} of {series.points.length} buckets had nothing to measure
          </span>
        ) : null}
      </p>
    </div>
  )
}
