import type { Level } from '../lib/diagnose'

/** The stratum bar — Flint's signature read on a column store.
 *
 *  The ghost outline is the column's *uncompressed* extent, the solid fill its
 *  size on disk, both scaled against the largest column in the table. So a
 *  wide ghost with a sliver of fill says "big but compresses beautifully",
 *  and a bar that is nearly all fill says "this is what your disk is". You
 *  cannot see either of those in `DESCRIBE TABLE`.
 *
 *  The scale is linear and comes from `barScale`: the 90th percentile rather
 *  than the maximum, so one outlying column cannot flatten every other bar. A
 *  column past the scale is drawn full width and marked with an accent edge —
 *  it runs off the end rather than pretending to fit. And a column that holds
 *  anything at all keeps a visible floor: it says "present but small", which is
 *  true, where a bar rounded down to nothing says "empty", which is not. */
const FLOOR = 2
export function StratumBar({
  compressed,
  uncompressed,
  max,
  title,
}: {
  compressed: number
  uncompressed: number
  max: number
  title?: string
}) {
  if (max <= 0) return <div className="stratum stratum--empty" aria-hidden="true" />

  const ghost = Math.min(100, (uncompressed / max) * 100)
  const fill = Math.min(100, (compressed / max) * 100)
  const over = uncompressed > max

  return (
    <div
      className={`stratum${over ? ' is-over' : ''}`}
      title={over && title ? `${title} — past the scale` : title}
      role="img"
      aria-label={title}
    >
      <div
        className="stratum__ghost"
        style={{ width: `${uncompressed > 0 ? Math.max(ghost, FLOOR) : 0}%` }}
      />
      <div
        className="stratum__fill"
        style={{ width: `${compressed > 0 ? Math.max(fill, FLOOR) : 0}%` }}
      />
    </div>
  )
}

/** A single-value variant for partition rows, where there is no compression
 *  story to tell — only relative size. */
export function ShareBar({
  value,
  max,
  level,
}: {
  value: number
  max: number
  /** Colours the fill by the product's own verdict, where the caller has one.
   *
   *  Left off by default: most share bars are a proportion of something with no
   *  good or bad about it — a table's share of a database is just its size — and
   *  colouring those would spend the alarm palette on arithmetic. A disk has a
   *  verdict, and there the colour is the fastest thing on the row to read. */
  level?: Level
}) {
  const width = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="stratum" aria-hidden="true">
      <div
        className={`stratum__fill${level && level !== 'ok' ? ` stratum__fill--${level}` : ''}`}
        style={{ width: `${value > 0 ? Math.max(width, FLOOR) : 0}%` }}
      />
    </div>
  )
}
