/** Changing a table's columns and its TTL.
 *
 *  The prose lives in the backend — each operation's cost is a sentence about
 *  *this* table ("rewrites 400,000 rows across two parts", "done means this
 *  replica only") and is fetched with the operations rather than written again
 *  here. A second copy of six paragraphs in TypeScript is the drift the `SYSTEM`
 *  console already had to have removed from it once.
 */

export interface Offered {
  op: string
  label: string
  /** Whether it rewrites data on disk. Measured against a real table, not
   *  reasoned from the statement: adding a column does not, renaming one does. */
  rewrites: boolean
  /** Whether it can destroy data, which is what decides its tier. */
  destroys: boolean
  /** The fields the form has to collect. */
  needs: string[]
  /** What it costs this table, in the backend's own words. */
  costs: string
}

/** The fields an operation needs that are still empty.
 *
 *  `default_expr` is optional on the one operation that offers it — a column
 *  with no default is the ordinary case — so it is asked for and not required.
 */
export function missing(o: Offered, values: Record<string, string>): string[] {
  return o.needs.filter((f) => f !== 'default_expr' && !(values[f] ?? '').trim())
}

/** The request body for one operation. */
export function body(
  o: Offered,
  database: string,
  table: string,
  values: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { database, table, op: o.op }
  for (const field of o.needs) {
    const v = (values[field] ?? '').trim()
    // An empty optional field is left out rather than sent as an empty string:
    // the backend refuses empty fragments, and it should not have to tell the
    // difference between "no default wanted" and "a default somebody cleared".
    if (v) out[field] = v
  }
  return out
}

/** What to call a field in a form. */
export function asks(field: string): string {
  switch (field) {
    case 'column':
      return 'Column'
    case 'kind':
      return 'Type'
    case 'to':
      return 'New name'
    case 'expr':
      return 'TTL expression'
    case 'default_expr':
      return 'Default (optional)'
    case 'name':
      return 'Name'
    case 'expression':
      return 'Indexes'
    case 'granularity':
      return 'Granularity'
    case 'query':
      return 'Query'
    default:
      return field
  }
}
