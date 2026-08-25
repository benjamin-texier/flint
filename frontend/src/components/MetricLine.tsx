import type { ReactNode } from 'react'

export interface Metric {
  value: ReactNode
  unit?: string
  label: string
  /** Renders in the accent colour. Reserve it for the one number that matters
   *  most on the page. */
  accent?: boolean
}

/** Headline figures as one dense typographic line, not a row of cards.
 *  Values are set in the display face; labels sit beneath in small caps. */
export function MetricLine({ metrics }: { metrics: Metric[] }) {
  return (
    <dl className="metrics">
      {metrics.map((m) => (
        <div className="metrics__item" key={m.label}>
          <dd className={`metrics__value num${m.accent ? ' metrics__value--accent' : ''}`}>
            {m.value}
            {m.unit ? <span className="metrics__unit">{m.unit}</span> : null}
          </dd>
          <dt className="metrics__label label">{m.label}</dt>
        </div>
      ))}
    </dl>
  )
}
