import { useMemo } from 'react'

import type { QueryResult } from '../lib/api'
import { analyse, observations, type ColumnRead } from '../lib/analyse'
import { familyColor, shortType } from '../lib/chType'
import { count, exact, figure, stretch } from '../lib/format'
import { TypeIcon } from './TypeIcon'

/** The result, read back to you.
 *
 *  This is the half of a query result that a grid cannot show: not the values
 *  but their shape — where the numbers sit, how long a stretch of time this is,
 *  which handful of values account for the rows, which column never varies and
 *  therefore taught you nothing. All of it from the rows already in the browser,
 *  in one pass, so it costs no query.
 *
 *  Every figure here is about *the rows that came back*. The panel says so once,
 *  at the top, and then never repeats it — a caveat printed forty times is a
 *  caveat nobody reads. What it does repeat is the count each figure is out of,
 *  because "6 distinct" means something different over 500 rows than over
 *  50,000.
 *
 *  The top values are buttons when there is a statement to edit: clicking one
 *  narrows the query to it. That is the shortest path in this app from "what is
 *  in here" to "show me only that", and it is the reason this panel is beside
 *  the grid rather than on a page of its own. */
export function ResultAnalysis({
  result,
  onFilter,
}: {
  result: QueryResult
  /** Present only when the statement behind the result can take a WHERE. */
  onFilter?: (column: { name: string; type: string }, value: string) => void
}) {
  const read = useMemo(() => analyse(result), [result])
  const notes = useMemo(() => observations(read), [read])

  return (
    <aside className="analysis" aria-label="What this result says about itself">
      <header className="analysis__head">
        <h3 className="analysis__title">Analyses</h3>
        <p className="analysis__scope">
          over the {count(read.rows)} {read.rows === 1 ? 'row' : 'rows'} returned
          {read.sampled ? `, sampled every ${Math.round(read.rows / read.examined)}th` : ''}
          {/* Not "in the table". The result is a LIMIT away from being a sample
              of unknown bias and this is the only place that can say so. */}
        </p>
      </header>

      {notes.length > 0 ? (
        <ul className="analysis__notes">
          {notes.map((note) => (
            <li
              className={`analysis__note${note.tone === 'warn' ? ' is-warn' : ''}`}
              key={note.column + note.text}
            >
              <span className="analysis__notecol">{note.column}</span>
              {note.text}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="analysis__cols">
        {read.columns.map((column) => (
          <ColumnCard key={column.name} column={column} onFilter={onFilter} />
        ))}
      </div>
    </aside>
  )
}

function ColumnCard({
  column,
  onFilter,
}: {
  column: ColumnRead
  onFilter?: (column: { name: string; type: string }, value: string) => void
}) {
  const facts: string[] = []
  // Distinct is worth stating once it is not either "one" (already said as a
  // note) or "all of them" (said as a note too).
  if (column.distinct > 1) {
    facts.push(
      column.distinctCapped
        ? `over ${count(column.distinct)} distinct`
        : `${count(column.distinct)} distinct`,
    )
  }
  if (column.nulls > 0) facts.push(`${count(column.nulls)} null`)

  return (
    <section className="acol">
      <header className="acol__head">
        <TypeIcon type={column.type} />
        <span className="acol__name" title={column.name}>
          {column.name}
        </span>
        <span
          className="acol__type"
          style={{ color: familyColor(column.type) }}
          title={column.type}
        >
          {shortType(column.type)}
        </span>
      </header>

      {facts.length > 0 ? <p className="acol__facts">{facts.join(' · ')}</p> : null}

      {column.numbers ? (
        <>
          <Spark bins={column.numbers.bins} type={column.type} />
          <dl className="acol__stats num">
            <Figure label="p50" value={column.numbers.p50} />
            <Figure label="p95" value={column.numbers.p95} />
            <Figure label="max" value={column.numbers.max} />
            <Figure label="mean" value={column.numbers.mean} />
          </dl>
        </>
      ) : null}

      {column.times ? (
        <>
          <Spark bins={column.times.bins} type={column.type} />
          <p className="acol__span">
            {/* The extent reads as one line because that is the question: from
                when to when, and how much of a stretch that is. */}
            {column.times.from} → {column.times.to}
            {column.times.seconds !== null && column.times.seconds > 0 ? (
              <span className="acol__spanlen">{stretch(column.times.seconds)}</span>
            ) : null}
          </p>
        </>
      ) : null}

      {/* Top values, for anything that is neither a measure nor a clock — and
          for either of those too when it holds only a handful of values, which
          is what an enum stored as a UInt8 looks like, and what a timestamp
          rounded to the hour looks like. The five commonest timestamps of a raw
          `DateTime` column, on the other hand, are five rows that happened to
          share a second: nothing anybody needs. */}
      {column.top.length > 1 &&
      ((column.family !== 'number' && column.family !== 'time') || column.distinct <= 12) ? (
        <ul className="acol__top">
          {column.top.map((top) => {
            const share = column.n > 0 ? (top.n / column.n) * 100 : 0
            const label = top.value === '' ? "''" : top.value
            return (
              <li className="acol__topitem" key={top.value}>
                {onFilter ? (
                  <button
                    className="acol__val"
                    style={{ '--share': `${share}%` } as React.CSSProperties}
                    onClick={() => onFilter({ name: column.name, type: column.type }, top.value)}
                    title={`Keep only rows where ${column.name} is ${label} — ${exact(top.n)} of ${exact(column.n)}`}
                    type="button"
                  >
                    <span className="acol__valtext">{label}</span>
                    <span className="acol__valn num">{count(top.n)}</span>
                  </button>
                ) : (
                  <span
                    className="acol__val"
                    style={{ '--share': `${share}%` } as React.CSSProperties}
                    title={`${exact(top.n)} of ${exact(column.n)}`}
                  >
                    <span className="acol__valtext">{label}</span>
                    <span className="acol__valn num">{count(top.n)}</span>
                  </span>
                )}
              </li>
            )
          })}
          {column.distinct > column.top.length ? (
            <li className="acol__more">
              {column.distinctCapped
                ? 'and more than this panel counted'
                : `and ${count(column.distinct - column.top.length)} more`}
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  )
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="acol__stat">
      <dt className="acol__statkey">{label}</dt>
      <dd className="acol__statval" title={exact(Math.round(value * 100) / 100)}>
        {figure(value)}
      </dd>
    </div>
  )
}

/** A distribution, at the size of a line of text.
 *
 *  Twenty-four bars scaled to the tallest one: this is a shape, not a
 *  measurement, and the figures underneath are where a number gets read. Drawn
 *  as a `<svg>` with no axes on purpose — an axis on something 22 pixels tall is
 *  ink that carries nothing.
 *
 *  A bar of one row still gets a visible sliver rather than a hairline that
 *  rounds away, because "a few rows out here" is exactly what the tail of a
 *  latency distribution is for. */
function Spark({ bins, type }: { bins: number[]; type: string }) {
  const peak = Math.max(...bins, 1)
  const total = bins.reduce((sum, n) => sum + n, 0)
  if (total === 0) return null
  const width = 100 / bins.length
  return (
    <svg
      className="acol__spark"
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Distribution across ${bins.length} buckets, tallest holding ${peak} rows`}
    >
      {bins.map((n, i) => {
        if (n === 0) return null
        const h = Math.max(1.5, (n / peak) * 24)
        return (
          <rect
            key={i}
            x={i * width + width * 0.12}
            y={24 - h}
            width={width * 0.76}
            height={h}
            fill={familyColor(type)}
          />
        )
      })}
    </svg>
  )
}
