/** Skip indexes and projections: declared, and whether they hold anything.
 *
 *  The size is the status. Adding either one does nothing to the parts that
 *  already exist — measured at zero bytes and no mutation — and the statement
 *  reports success, so a table can carry an index every query ignores
 *  indefinitely with no error anywhere. Neither system table says that in words,
 *  which is why the backend computes it and sends it.
 */

export interface SkipIndex {
  name: string
  kind: string
  expression: string
  granularity: number
  compressed: number
  uncompressed: number
  marks: number
  /** Declared and holding nothing. */
  inert: boolean
}

export interface Projection {
  name: string
  kind: string
  query: string
  sorting_key: string[]
  parts: number
  bytes: number
  rows: number
  inert: boolean
}

export interface DerivedReport {
  indexes: { items: SkipIndex[]; blocked?: string }
  projections: { items: Projection[]; blocked?: string }
  verdicts: string[]
}
