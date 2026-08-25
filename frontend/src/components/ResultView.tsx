import { useMemo, useState } from 'react'

import type { QueryResult } from '../lib/api'
import { suggestCharts, type ChartSpec } from '../lib/chart'
import { Chart } from './Chart'
import { ResultsGrid } from './ResultsGrid'

/** A result, as a table or as a chart.
 *
 *  The table is the default and never goes away: the dataviz method requires a
 *  chart to have a table-view twin so no value is reachable only by hovering.
 *  The chart forms on offer come from the shape of the result, so a query with
 *  a timestamp and a measure suggests a line without anyone asking. */
export function ResultView({
  result,
  onChartChange,
}: {
  result: QueryResult
  /** The form the reader picked, so a tile can be built from it. */
  onChartChange?: (spec: ChartSpec | null) => void
}) {
  const specs = useMemo(
    () => suggestCharts(result.columns, result.rows.length),
    [result.columns, result.rows.length],
  )
  const [chosen, setChosen] = useState<number | null>(null)
  const spec: ChartSpec | null = chosen === null ? null : (specs[chosen] ?? null)

  const choose = (i: number | null) => {
    setChosen(i)
    onChartChange?.(i === null ? null : (specs[i] ?? null))
  }

  return (
    <div className="rview">
      {specs.length > 0 ? (
        <div className="rview__bar">
          <div className="segmented" role="group" aria-label="How to show the result">
            <button
              className={`segmented__item${spec === null ? ' is-on' : ''}`}
              aria-pressed={spec === null}
              onClick={() => choose(null)}
            >
              Table
            </button>
            {specs.map((s, i) => (
              <button
                key={s.kind + i}
                className={`segmented__item${chosen === i ? ' is-on' : ''}`}
                aria-pressed={chosen === i}
                title={s.why}
                onClick={() => choose(i)}
              >
                {LABEL[s.kind]}
              </button>
            ))}
          </div>
          {spec ? <span className="rview__why">{spec.why}</span> : null}
        </div>
      ) : null}

      <div className="rview__body">
        {spec ? <Chart result={result} spec={spec} /> : <ResultsGrid result={result} />}
      </div>
    </div>
  )
}

const LABEL: Record<ChartSpec['kind'], string> = {
  stat: 'Figure',
  line: 'Line',
  bar: 'Bar',
  scatter: 'Scatter',
}
