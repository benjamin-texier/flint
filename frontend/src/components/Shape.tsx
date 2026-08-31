import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { asideFrom, bars, counted, says, shapeOf } from '../lib/distribution'
import { ErrorNote, Loading, Sentence } from './Note'

/** How one column's rows fall across its values.
 *
 *  The profile row above this gives five numbers — distinct, null, min, max,
 *  mean — and five numbers cannot tell an evenly spread column from one that is
 *  two clusters, or from one value and a rounding error. This is the shape those
 *  numbers leave out.
 *
 *  Opened per column rather than drawn for all of them: each needs its own range
 *  before it can be binned, so a table's worth is a query per column, and the
 *  reader wanted one. */
export function Shape({
  database,
  table,
  column,
}: {
  database: string
  table: string
  column: string
}) {
  const found = useQuery({
    queryKey: ['distribution', database, table, column],
    queryFn: () => api.distribution(database, table, column),
    staleTime: 5 * 60_000,
  })

  if (found.isPending) return <Loading label={`Counting ${column}`} />
  if (found.error) return <ErrorNote error={found.error} retry={() => found.refetch()} />
  const d = found.data
  if (!d) return null
  if (!d.available) {
    return <p className="shape__note">{d.reason ?? 'this column cannot be counted'}.</p>
  }

  const shape = shapeOf(d)
  const aside = asideFrom(d)

  /* An identifier has no distribution and no bars worth drawing — twelve bars of
     height one is a chart that says nothing. The sentence is the whole answer. */
  if (shape === 'key' || shape === 'empty') {
    return (
      <div className="shape">
        <Sentence className="shape__says" text={says(d)} />
        {aside ? <p className="shape__note">{aside}</p> : null}
      </div>
    )
  }

  const drawn = bars(d)
  const peak = Math.max(...d.buckets.map((b) => b.rows))

  return (
    <div className="shape">
      <Sentence className="shape__says" text={says(d)} />
      <ol className={`shape__bars shape__bars--${d.mode}`} aria-label={`${column}: ${says(d)}`}>
        {drawn.map((b, i) => (
          <li className="shape__bar" key={`${b.label}-${i}`}>
            {/* The figure is on the bar's title rather than beside it: sixteen
                labelled bars is a table, and the reader came for the outline. */}
            <span
              className="shape__fill"
              style={{ height: `${Math.max(b.share * 100, b.rows > 0 ? 2 : 0)}%` }}
              title={`${b.label}: ${b.rows.toLocaleString('en-GB')} rows`}
            />
            <span className="shape__tick">{b.label}</span>
          </li>
        ))}
      </ol>
      <p className="shape__note">
        {counted(d)} · tallest bar {peak.toLocaleString('en-GB')} rows
        {aside ? ` · ${aside}` : ''}
      </p>
    </div>
  )
}
