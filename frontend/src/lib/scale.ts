/** The scale a comparison bar should use.
 *
 *  Scaling a column of bars to the largest value is right until one value is a
 *  hundred times the rest — which is the normal shape of a ClickHouse table,
 *  where a `String` column of JSON blobs sits beside eighty `UInt8`s. Every
 *  other bar then rounds to a hairline, and a column where 88 of 89 rows are
 *  identical hairlines says nothing at all.
 *
 *  So the scale is the 90th percentile rather than the maximum, and the handful
 *  of values above it are drawn full width and marked as running past it. The
 *  bulk of the column becomes comparable, and nothing is hidden: the exact
 *  figures sit in the cells beside the bar.
 *
 *  On a narrow table the two agree — with four values or fewer the 90th
 *  percentile *is* the maximum — so a small table behaves exactly as it did and
 *  nothing is ever marked. */
export function barScale(values: readonly number[]): number {
  const present = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (present.length === 0) return 0
  const index = Math.ceil(0.9 * (present.length - 1))
  return present[index] ?? present[present.length - 1]!
}

/** The floor under a cell that holds anything at all, as a fraction of the
 *  scale.
 *
 *  "Small" and "not there" are different answers, and a grid of cells exists to
 *  tell them apart — so anything present keeps a visible share of the ink even
 *  where its true share rounds to nothing. Everything above the floor keeps its
 *  real proportion.
 *
 *  The figure is high for a floor. A tenth would be arithmetically honest and,
 *  on screen, a square nobody can tell from an empty one: verified in a browser
 *  rather than reasoned about, at 8% a partition holding a hundred rows beside
 *  one holding a million was white, and the row read as a table with no data in
 *  it at all.
 *
 *  Shared by the partition grid and the co-access matrix, because they are the
 *  same physics drawn twice — one product, one floor. Two constants of the same
 *  name in two files is how the two drift apart. */
export const CELL_FLOOR = 0.2
