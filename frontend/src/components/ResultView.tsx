import { useEffect, useMemo, useState } from 'react'

import type { QueryResult } from '../lib/api'
import { suggestCharts, type ChartKind, type ChartSpec } from '../lib/chart'
import { downloadNote } from '../lib/export'
import { Chart } from './Chart'
import { Download } from './Download'
import { ResultAnalysis } from './ResultAnalysis'
import { ResultsGrid, type GridQuery } from './ResultsGrid'

/** A result: the values, a chart of them, and what they add up to.
 *
 *  The table is the default and never goes away: the dataviz method requires a
 *  chart to have a table-view twin so no value is reachable only by hovering.
 *  The chart forms on offer come from the shape of the result, so a query with
 *  a timestamp and a measure suggests a line without anyone asking.
 *
 *  The analyses sit *beside* the values rather than replacing them, because the
 *  two are read together — "which host is this spike" is a question about a
 *  chart and a top-values list at the same time. On a narrow window they stack,
 *  and the values stay on top. */
export function ResultView({
  result,
  chosenKind = null,
  onChartChange,
  query,
  download,
}: {
  result: QueryResult
  /** The form to open on, when the caller remembers one.
   *
   *  A chart used to be chosen per *result*, which meant every re-run put the
   *  reader back on the table: narrowing a filter and running again cost a click
   *  to get the picture back, and the picture is usually the reason the query is
   *  being narrowed. The caller keeps the choice — the query tab does — and this
   *  honours it for as long as the new result still has that form to offer. */
  chosenKind?: ChartKind | null
  /** The form the reader picked, so a tile can be built from it. */
  onChartChange?: (spec: ChartSpec | null) => void
  /** Present when there is an editable statement behind this result: the grid's
   *  headers then rewrite it. See `GridQuery`. */
  query?: GridQuery
  /** The statement itself, where this result has one that can be re-run for a
   *  file. Absent for a result with no statement behind it — a fixed panel, a
   *  sample — which is why this is a prop rather than read off `query`. */
  download?: {
    sql: string
    database?: string
    stem?: string
    /** What this download hands over, where the caller knows better than the
     *  result does — a generated statement knows its own limit. */
    note?: string
  }
}) {
  const specs = useMemo(
    () => suggestCharts(result.columns, result.rows.length),
    [result.columns, result.rows.length],
  )
  const [kind, setKind] = useState<ChartKind | null>(chosenKind)
  const [analysing, setAnalysing] = useState(false)
  /* The chosen form is remembered by *kind*, not by index: a re-run can return
     a different set of suggestions, and slot 2 of the old list is not slot 2 of
     the new one. */
  const chosen = kind === null ? null : specs.findIndex((s) => s.kind === kind)
  const spec: ChartSpec | null = chosen === null || chosen < 0 ? null : (specs[chosen] ?? null)

  /* A result whose shape changed under the choice — a grouping dropped, a
     measure taken out — has no such chart to show. Dropped rather than left
     dangling, and the caller is told, because whoever is holding this choice is
     also building a dashboard tile out of it. */
  useEffect(() => {
    if (kind !== null && !specs.some((s) => s.kind === kind)) {
      setKind(null)
      onChartChange?.(null)
    }
  }, [specs, kind, onChartChange])

  const choose = (i: number | null) => {
    const next = i === null ? null : (specs[i] ?? null)
    setKind(next?.kind ?? null)
    onChartChange?.(next)
  }

  return (
    <div className="rview">
      <div className="rview__bar">
        {specs.length > 0 ? (
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
        ) : null}
        {spec ? <span className="rview__why">{spec.why}</span> : null}
        <div className="rview__spacer" />
        {/* Beside `analyses` rather than under the grid: both are things to do
            with the whole result rather than with a row, and a control that
            hands over a file belongs where the reader is already looking for
            what to do next. */}
        {download ? (
          <Download
            sql={download.sql}
            database={download.database}
            stem={download.stem}
            note={download.note ?? downloadNote(result.rows.length, result.truncated)}
          />
        ) : null}
        <button
          className={`gridshell__toggle${analysing ? ' is-on' : ''}`}
          aria-pressed={analysing}
          onClick={() => setAnalysing((on) => !on)}
          title="What these rows add up to: distributions, top values, nulls"
          type="button"
        >
          analyses
        </button>
      </div>

      <div className={`rview__body${analysing ? ' is-split' : ''}`}>
        <div className="rview__main">
          {spec ? <Chart result={result} spec={spec} /> : <ResultsGrid result={result} query={query} />}
        </div>
        {analysing ? (
          <ResultAnalysis
            result={result}
            // Clicking a top value narrows the query — but only where there is a
            // query to narrow.
            onFilter={query ? (column, value) => query.onFilter(column, '=', value) : undefined}
          />
        ) : null}
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
