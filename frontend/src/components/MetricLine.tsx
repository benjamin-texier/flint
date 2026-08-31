import type { ReactNode } from 'react'

import type { Level } from '../lib/diagnose'

export interface Metric {
  value: ReactNode
  unit?: string
  label: string
  /** What this figure says about itself, where it says anything.
   *
   *  This used to be `accent?: boolean`, which two different call sites read two
   *  different ways: three of them meant "the headline number of the page" and
   *  three meant "this number is in a state worth noticing". The second is a
   *  verdict, and painting a verdict with the interaction colour tells the
   *  reader there is something to click on a figure nobody can click.
   *
   *  So emphasis is gone — a metric value is already the largest, heaviest thing
   *  on its line, and a colour on top of that was saying the same thing twice —
   *  and a figure that has a verdict now says which one, in the vocabulary the
   *  rest of the product already reads. */
  level?: Level
}

/** Headline figures as one dense typographic line, not a row of cards.
 *  Values are set in the display face; labels sit beneath in small caps. */
export function MetricLine({ metrics }: { metrics: Metric[] }) {
  return (
    <dl className="metrics">
      {metrics.map((m) => (
        <div className="metrics__item" key={m.label}>
          <dd
            className={`metrics__value num${
              m.level && m.level !== 'ok' ? ` metrics__value--${m.level}` : ''
            }`}
          >
            {m.value}
            {m.unit ? <span className="metrics__unit">{m.unit}</span> : null}
          </dd>
          <dt className="metrics__label label">{m.label}</dt>
        </div>
      ))}
    </dl>
  )
}
