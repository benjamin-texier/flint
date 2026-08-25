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
