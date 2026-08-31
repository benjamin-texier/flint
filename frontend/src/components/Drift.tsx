import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import {
  forSpark,
  headline,
  omissions,
  ordered,
  periodLabel,
  read,
  says,
  type Drift as Reading,
  type Series,
} from '../lib/drift'
import { sparkline } from '../lib/spark'
import { EmptyNote, ErrorNote, Sentence } from './Note'

/** Whether this table has started behaving differently.
 *
 *  The profile tab is a snapshot: what is in the table, now. This is the same
 *  readings cut into periods on the table's own time column, and it answers the
 *  question a snapshot cannot — *has this changed?* — which is the question
 *  somebody actually arrives with when a dashboard has gone strange.
 *
 *  Findings first and shapes second, deliberately. The sentences are the answer;
 *  the sparklines are there so a reader can check one against the data rather
 *  than take it on faith, and so the tab is still a profile over time for
 *  somebody who arrived without a question.
 *
 *  Asked for rather than run on arrival, the same consent the relations tab
 *  takes: this reads every row of the table once. */
export function Drift({ database, table }: { database: string; table: string }) {
  const found = useQuery({
    queryKey: ['drift', database, table],
    queryFn: () => api.drift(database, table),
    enabled: false,
    staleTime: 5 * 60_000,
  })

  if (found.error) return <ErrorNote error={found.error} retry={() => found.refetch()} />

  if (!found.data) {
    return (
      <section className="rel">
        <p className="rel__ask">
          Cuts this table into periods on its own time column and reads each one: how many rows
          arrived, how much of each column was null, how many distinct values it took. Nothing is
          written and nothing leaves the server.
        </p>
        <button
          className="btn btn--spark"
          onClick={() => found.refetch()}
          disabled={found.isFetching}
        >
          {found.isFetching ? 'Reading the periods…' : 'Read it over time'}
        </button>
      </section>
    )
  }

  const d = found.data
  if (!d.available) {
    return (
      <EmptyNote title="Nothing to read over time">
        {d.reason ?? 'this table cannot be read'}.
      </EmptyNote>
    )
  }

  /* Read once, here, and passed down. Every conclusion on this page comes out of
     one call so they cannot disagree about which periods were compared. */
  const r = read(d)

  /* No time column is an answer rather than a fault — a dimension table has no
     time axis and never will — so it says so and offers nothing else. */
  if (!d.time_column || d.periods.length === 0) {
    return <EmptyNote title="No time to read it over">{headline(d, r)}</EmptyNote>
  }

  const left = omissions(d, r)

  return (
    <section className="rel">
      <div className="rel__bar">
        <p className="rel__span">
          {headline(d, r)} Cut on <code className="rel__col">{d.time_column}</code>, by {d.step}.
        </p>
        <span className="panel__spacer" />
        <button className="btn" onClick={() => found.refetch()} disabled={found.isFetching}>
          {found.isFetching ? 'Reading…' : 'Again'}
        </button>
      </div>

      {r.findings.length ? (
        <ul className="drift__findings">
          {r.findings.map((f, i) => (
            <li key={`${f.kind}-${f.column ?? ''}-${i}`} className={`drift__finding drift__finding--${f.kind}`}>
              <Sentence text={says(f, d.step)} />
            </li>
          ))}
        </ul>
      ) : null}

      <Shape label="rows" values={d.rows.map((n) => n)} periods={d.periods} step={d.step} />

      {ordered(d, r).map((s) => (
        <ColumnShapes key={s.name} series={s} periods={d.periods} step={d.step} />
      ))}

      {left.length ? (
        <ul className="drift__left">
          {left.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function ColumnShapes({
  series,
  periods,
  step,
}: {
  series: Series
  periods: string[]
  step: Reading['step']
}) {
  return (
    <div className="drift__col">
      <p className="drift__name">
        <code className="rel__col">{series.name}</code>{' '}
        <span className="drift__type">{series.type}</span>
      </p>
      {series.nulls ? (
        <Shape
          label="null"
          values={forSpark(series.nulls)}
          periods={periods}
          step={step}
          share
        />
      ) : null}
      <Shape label="distinct" values={forSpark(series.distinct)} periods={periods} step={step} />
      {series.mean ? (
        <Shape label="average" values={forSpark(series.mean)} periods={periods} step={step} />
      ) : null}
    </div>
  )
}

const BOX = { width: 320, height: 26 }

/** One row's shape, with its own peak named beside it.
 *
 *  `sparkline` scales to the row's own maximum rather than to anything outside
 *  it, and its own comment says whoever draws one has to say so — otherwise two
 *  rows of different magnitude look identical and the reader draws exactly the
 *  wrong conclusion. So the peak is printed, every time. */
function Shape({
  label,
  values,
  periods,
  step,
  share = false,
}: {
  label: string
  values: (number | undefined)[]
  periods: string[]
  step: Reading['step']
  share?: boolean
}) {
  const spark = sparkline(values, BOX)
  const present = values.filter((v): v is number => v !== undefined)
  if (present.length === 0) return null

  const peak = share ? `${(spark.peak * 100).toFixed(1)}%` : format(spark.peak)
  const first = periods[0]
  const last = periods[periods.length - 1]

  return (
    <div className="drift__row">
      <span className="drift__label">{label}</span>
      <svg
        className="drift__spark"
        viewBox={`0 0 ${BOX.width} ${BOX.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}, ${periods.length} ${step}s from ${first ? periodLabel(first, step) : ''} to ${last ? periodLabel(last, step) : ''}, peaking at ${peak}`}
      >
        {spark.segments.map((points, i) => (
          <polyline key={i} className="drift__line" points={points} />
        ))}
        {spark.dots.map((p, i) => (
          <circle key={i} className="drift__dot" cx={p.x} cy={p.y} r={1.6} />
        ))}
      </svg>
      <span className="drift__peak">{peak}</span>
    </div>
  )
}

/** Whole numbers whole, fractions to one place. The server rounds the figures it
 *  puts in a sentence; these are the axis of a shape, and only have to be
 *  readable. */
function format(v: number): string {
  return Number.isInteger(v) ? v.toLocaleString('en-GB') : v.toFixed(1)
}
