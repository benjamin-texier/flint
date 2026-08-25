/** A value ClickHouse does not report, as opposed to a zero. Views have no row
 *  count; that is different from having none. */
export function Dash() {
  return <span className="dash">—</span>
}
