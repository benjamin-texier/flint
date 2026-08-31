/** A sparkline over values with holes in them.
 *
 *  A row of ninety squares says where a table's data is, and makes you read
 *  across to answer the question people actually have about a table over time:
 *  growing, flat, or stopped. A line answers that in a glance, so both are drawn
 *  — the line for the shape, the squares for the buckets.
 *
 *  The one rule that makes this different from any charting library's sparkline:
 *  **a hole is not a zero.** A bucket a table has nothing in is not a
 *  measurement of nothing, it is the absence of a measurement, and joining
 *  across it would draw a dive to the floor and a climb back out — an event that
 *  did not happen. So a hole breaks the line, and a value alone between two
 *  holes becomes a dot, because a segment of one point draws nothing at all.
 *
 *  Pure, so it can be tested without a DOM — which is the only way to be sure
 *  about the coordinates. */

export interface SparkPoint {
  x: number
  y: number
}

export interface Spark {
  /** One `points` string per unbroken run, for a `<polyline>` each. */
  segments: string[]
  /** Runs of a single value, which no polyline can draw. */
  dots: SparkPoint[]
  /** The value the top of the box represents. */
  peak: number
}

export interface SparkBox {
  width: number
  height: number
  /** Room for the stroke, so a value at the peak is not sliced in half by the
   *  edge of the box. */
  inset?: number
}

/** Lay values out in a box, left to right, in the order given.
 *
 *  Scaled to the values' own peak rather than to anything outside them: the
 *  question a sparkline answers is about this row's shape, and a row scaled to
 *  its neighbour's maximum is a flat line that says the neighbour is bigger,
 *  which is what the figures beside it already say. Whoever draws one has to say
 *  so — a scale that is not the one next to it is a scale worth a sentence. */
export function sparkline(
  values: readonly (number | undefined)[],
  { width, height, inset = 1.5 }: SparkBox,
): Spark {
  const present = values.filter((v): v is number => v !== undefined && Number.isFinite(v))
  const peak = present.reduce((max, v) => Math.max(max, v), 0)
  if (values.length === 0 || present.length === 0 || peak <= 0 || width <= 0 || height <= 0) {
    return { segments: [], dots: [], peak: 0 }
  }

  const top = inset
  const bottom = Math.max(inset, height - inset)
  const span = Math.max(0, bottom - top)
  // A single column sits in the middle rather than at the left edge, where it
  // would read as the start of a line that is not there.
  const at = (i: number) => (values.length === 1 ? width / 2 : (i / (values.length - 1)) * width)
  const level = (v: number) => bottom - (v / peak) * span

  const segments: string[] = []
  const dots: SparkPoint[] = []
  let run: SparkPoint[] = []
  const close = () => {
    if (run.length === 1) dots.push(run[0]!)
    else if (run.length > 1) {
      segments.push(run.map((p) => `${round(p.x)},${round(p.y)}`).join(' '))
    }
    run = []
  }

  values.forEach((v, i) => {
    if (v === undefined || !Number.isFinite(v)) {
      close()
      return
    }
    run.push({ x: at(i), y: level(v) })
  })
  close()

  return { segments, dots, peak }
}

/** Two decimals is under a tenth of a pixel at any size this is drawn at, and it
 *  keeps the markup readable when somebody inspects it. */
function round(n: number): number {
  return Math.round(n * 100) / 100
}
