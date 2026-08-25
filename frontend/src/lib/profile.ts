/** Reading a profile: what each column is *for*.
 *
 *  The brief asks Flint to open a table and say `timestamp → Time`,
 *  `device_id → Identifier`, `city → Dimension`, `temperature → Metric`. That
 *  is a guess, and it is made from what the data actually looks like rather
 *  than from the name alone — a `UInt32` with three distinct values is a
 *  category whatever it is called, and a `String` with one distinct value per
 *  row is an identifier. Names only break ties. */

import { family, isNumeric, isTemporal } from './chType'

export interface ColumnProfile {
  name: string
  type: string
  nullable: boolean
  nulls: number
  distinct: number
  min: string | null
  max: string | null
  mean: string | null
  median: string | null
  top: string[]
}

export interface TableProfile {
  database: string
  table: string
  scanned: number
  sampled: boolean
  columns: ColumnProfile[]
}

export type Role =
  | 'time'
  | 'identifier'
  | 'geographic'
  | 'metric'
  | 'category'
  | 'dimension'
  | 'structure'

export const ROLE_LABEL: Record<Role, string> = {
  time: 'time',
  identifier: 'identifier',
  geographic: 'geographic',
  metric: 'metric',
  category: 'category',
  dimension: 'dimension',
  structure: 'structure',
}

export const ROLE_MEANING: Record<Role, string> = {
  time: 'When it happened. What you filter a range on, and bucket a chart by.',
  identifier: 'Names one thing. Nearly every row has its own value, so grouping by it tells you little.',
  geographic: 'A place. Latitude and longitude pair up into a map.',
  metric: 'Something measured. What you sum, average or take a percentile of.',
  category: 'A small fixed set of values. What you break a measurement down by.',
  dimension: 'A label with many values. Group by it, but expect a long list.',
  structure: 'Nested data — an array, a map, a tuple. Needs unpacking before it plots.',
}

/** A column with (nearly) one distinct value per row identifies its row. */
const IDENTIFIER_RATIO = 0.92
/** Above this, a label stops being a handful of categories. */
const CATEGORY_MAX = 50

const GEO = /^(lat|lon|lng|latitude|longitude|geohash)$/i
const ID_NAME = /(^|_)(id|uuid|guid|key)$/i

export function roleOf(column: ColumnProfile, scanned: number): Role {
  const { type, distinct, name } = column

  if (isTemporal(type)) return 'time'
  if (family(type) === 'nested') return 'structure'
  if (GEO.test(name) && isNumeric(type)) return 'geographic'

  // Enough rows for the distinct count to mean anything. Below that the data
  // cannot settle the question and the name is all there is.
  const measurable = scanned >= 100

  // A near-unique column identifies its row, whatever its type or name.
  if (measurable && distinct / scanned >= IDENTIFIER_RATIO) return 'identifier'

  // The name only breaks ties, and only where the data is silent. `device_id`
  // with four hundred values across half a million rows is something you group
  // by — calling it an identifier because of its suffix would hide the most
  // useful dimension in the table.
  if (!measurable && ID_NAME.test(name)) return 'identifier'

  // Cardinality decides before the type does: a UInt8 status column with three
  // values is a category, not something to average.
  if (distinct > 0 && distinct <= CATEGORY_MAX) return 'category'
  if (isNumeric(type)) return 'metric'
  return 'dimension'
}

/** Most-common values are worth showing only when there are few enough of them
 *  to be a set rather than a sample. */
export function showsTopValues(column: ColumnProfile): boolean {
  return column.top.length > 0 && column.distinct <= CATEGORY_MAX * 4
}

export function nullRatio(column: ColumnProfile, scanned: number): number {
  return scanned > 0 ? column.nulls / scanned : 0
}

/** The roles present, in the order they are useful to read. */
export const ROLE_ORDER: Role[] = [
  'time',
  'metric',
  'category',
  'dimension',
  'identifier',
  'geographic',
  'structure',
]
