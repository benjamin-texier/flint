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
 *  Values are set in the display face; labels sit beneath in small caps.
 *
 *  `lead` is for the line that *is* the page's headline — an object's rows, disk
 *  and parts under its name. The stylesheet has always claimed the numbers are
 *  the loudest thing on the page; at the shared size, under a 30px title, they
 *  were not. Everywhere else the line is one section among several and stays at
 *  the size it was. */
export function MetricLine({ metrics, lead = false }: { metrics: Metric[]; lead?: boolean }) {
  return (
    <dl className={`metrics${lead ? ' metrics--lead' : ''}`}>
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
