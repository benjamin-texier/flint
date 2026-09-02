/** A row of columns, with no axis of its own.
 *
 *  Two pages draw one — the arrival's data by period, and Diagnostics' load
 *  over the window — and the reason they share this rather than each writing
 *  twenty lines of flexbox is the floor rule, which I got backwards the first
 *  time. Both halves matter:
 *
 *  - a bucket that holds something never draws as nothing, so it keeps at least
 *    two pixels however small its share;
 *  - a bucket that holds nothing draws *nothing*, because with a filled axis an
 *    unconditional floor puts a mark on every empty period and says "a little is
 *    here" of a period that holds none.
 *
 *  `cellFill` in `lib/chart` states the same rule for the partition grid. Having
 *  it in one place is the difference between one correct implementation and two
 *  that drift.
 *
 *  No axis and no scale. Both callers print their own ends and their own
 *  sentence underneath, because what the columns *are* differs and the shape does
 *  not — and a y axis on a figure this short would be labels enough to make a
 *  legible thing legible. Same restraint `components/OverTime` states for the
 *  health sparklines. */
export function BarRow({
  bars,
  label,
}: {
  /** Oldest first. `value` is compared against the row's own peak, so the unit
   *  is the caller's business. */
  bars: { key: string; value: number; title: string }[]
  /** What the whole row is, for a reader who cannot see it. The per-column
   *  figures are in each `title`, and a screen reader walking 60 of them is
   *  worse than one sentence — so the columns are hidden and this speaks. */
  label: string
}) {
  const peak = bars.reduce((n, b) => Math.max(n, b.value), 0)
  return (
    <div className="barrow" role="img" aria-label={label}>
      {bars.map((b) => (
        <span
          className="barrow__bar"
          key={b.key}
          style={{ height: b.value > 0 ? `${Math.max(2, Math.round((b.value / peak) * 100))}%` : '0' }}
          title={b.title}
          aria-hidden="true"
        />
      ))}
    </div>
  )
}
