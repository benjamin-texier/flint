/** The results grid, minus React.
 *
 *  Column widths, the local sort, the clipboard payload and the pinch of
 *  persistence that remembers a column you dragged wider all live here, as
 *  pure functions, so the parts of the grid that are easy to get subtly wrong
 *  can be tested without a DOM. */

import { isNumeric, shortType } from './chType'
import { barScale } from './scale'

export interface GridColumn {
  name: string
  type: string
}

/** How a value reads in a cell. `empty` exists because a zero-length string
 *  and a NULL both render as nothing at all, and in ClickHouse those are very
 *  different answers — one is a value, the other is the absence of one. */
export type CellKind = 'value' | 'null' | 'empty'

export function cellText(value: unknown): { text: string; kind: CellKind } {
  if (value === null || value === undefined) return { text: 'NULL', kind: 'null' }
  if (value === '') return { text: "''", kind: 'empty' }
  if (typeof value === 'object') return { text: JSON.stringify(value), kind: 'value' }
  return { text: String(value), kind: 'value' }
}

/** The value as it should leave the app — clipboard, inspector. A NULL leaves
 *  as an empty field: the destination is nearly always a spreadsheet, where the
 *  literal text `NULL` in a numeric column is worse than a blank. */
export function rawText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/* -- Widths ------------------------------------------------------------- */

const MIN_CH = 6
/** No column may cross this, whatever it holds. One 4 KB JSON blob in the
 *  window used to stretch its column to 4,000 characters and push every other
 *  column off the screen; the inspector is where a long value gets read. */
const MAX_CH = 64
/** Type mark, the gaps around it, room for a sort arrow. */
const HEAD_EXTRA = 7
/** A long column name is allowed to ellipsise rather than set the width. */
const HEAD_CAP = 40
const SAMPLES = 200

/** The floor a type deserves before any value is seen — a `UInt8` never needs
 *  the room a `String` does. */
function typeFloor(type: string): number {
  const t = type.replace(/Nullable\(|LowCardinality\(|\)/g, '')
  if (/^(U?Int8|Bool)$/.test(t)) return 6
  if (/^(U?Int(16|32)|Float32)$/.test(t)) return 11
  if (/^(U?Int64|Float64|Decimal)/.test(t)) return 16
  if (/^Date$/.test(t)) return 11
  if (/^DateTime/.test(t)) return 21
  if (/^UUID$/.test(t)) return 34
  if (/^(Array|Map|Tuple|JSON|Nested)/.test(t)) return 30
  return 22
}

/** Every `SAMPLES`th value of a column, so a 10,000-row result costs the same
 *  to measure as a 200-row one. */
export function sampleColumn(rows: readonly unknown[][], index: number): unknown[] {
  const step = Math.max(1, Math.ceil(rows.length / SAMPLES))
  const out: unknown[] = []
  for (let r = 0; r < rows.length; r += step) out.push(rows[r]?.[index])
  return out
}

/** Width in characters: wide enough for the header, wide enough for the values
 *  actually present, and never wider than the cap. Measured against the data
 *  rather than the type alone, so a `String` column of country codes stops
 *  taking the room a `String` column of URLs would. */
export function widthChars(column: GridColumn, samples: readonly unknown[]): number {
  const head = Math.min(column.name.length + shortType(column.type).length + HEAD_EXTRA, HEAD_CAP)
  let widest = 0
  for (const value of samples) widest = Math.max(widest, cellText(value).text.length)
  const content = widest > 0 ? widest : typeFloor(column.type)
  return Math.min(Math.max(head, Math.min(content, MAX_CH), MIN_CH), MAX_CH)
}

/* -- Sorting ------------------------------------------------------------ */

export type SortDir = 'asc' | 'desc'
export interface Sort {
  column: number
  dir: SortDir
}

/** The next sort after a click on a header.
 *
 *  A plain click owns the order: unsorted → ascending → descending → unsorted,
 *  on that column alone. A shift-click *adds a level* instead, which is the one
 *  gesture a result grid cannot do without — "by engine, then by size" is the
 *  question, and asking it in two clicks beats rewriting the ORDER BY. A level
 *  clicked a third time leaves, so a stack is undone the way it was built. */
export function nextSort(levels: readonly Sort[], column: number, extend = false): Sort[] {
  const at = levels.findIndex((level) => level.column === column)
  if (!extend) {
    if (levels.length !== 1 || at !== 0) return [{ column, dir: 'asc' }]
    return levels[0]!.dir === 'asc' ? [{ column, dir: 'desc' }] : []
  }
  if (at === -1) return [...levels, { column, dir: 'asc' }]
  const level = levels[at]!
  if (level.dir === 'asc') {
    const next = [...levels]
    next[at] = { column, dir: 'desc' }
    return next
  }
  return levels.filter((_, i) => i !== at)
}

/** Int64 arrives from ClickHouse as a quoted string precisely because it does
 *  not survive a double, so comparing it as one would reorder rows that differ
 *  only in their last digits. */
function compareNumeric(a: string, b: string): number {
  if (/^-?\d+$/.test(a) && /^-?\d+$/.test(b)) {
    const x = BigInt(a)
    const y = BigInt(b)
    return x < y ? -1 : x > y ? 1 : 0
  }
  const x = Number(a)
  const y = Number(b)
  if (Number.isNaN(x) || Number.isNaN(y)) return a.localeCompare(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Row indices in display order.
 *
 *  This sorts the rows already in the browser and never re-queries, which is
 *  why NULLs go last in both directions rather than wherever ClickHouse would
 *  have put them: the order has to be explainable from what is on screen. Ties
 *  fall through to the next level and then to the order the server sent, so a
 *  sort is stable and reversible however many levels deep it goes. */
export function displayOrder(
  rows: readonly unknown[][],
  columns: readonly GridColumn[],
  levels: readonly Sort[],
): number[] {
  const order = rows.map((_, i) => i)
  if (levels.length === 0) return order
  const plan = levels.map((level) => ({
    column: level.column,
    sign: level.dir === 'asc' ? 1 : -1,
    numeric: isNumeric(columns[level.column]?.type ?? ''),
  }))
  return order.sort((a, b) => {
    for (const level of plan) {
      const x = rows[a]?.[level.column]
      const y = rows[b]?.[level.column]
      const xNull = x === null || x === undefined
      const yNull = y === null || y === undefined
      if (xNull || yNull) {
        if (xNull && yNull) continue
        return xNull ? 1 : -1
      }
      const cmp = level.numeric
        ? compareNumeric(rawText(x), rawText(y))
        : rawText(x).localeCompare(rawText(y), undefined, { numeric: true })
      if (cmp !== 0) return level.sign * cmp
    }
    return a - b
  })
}

/* -- Selection ---------------------------------------------------------- */

/** A cell address in *display* space: `row` counts down the rows as they are
 *  currently sorted, `col` counts across the columns as they are currently
 *  laid out. Both are what the eye sees, which is what a copy has to match. */
export interface CellRef {
  row: number
  col: number
}

export interface Span {
  row0: number
  row1: number
  col0: number
  col1: number
}

export function span(a: CellRef, b: CellRef): Span {
  return {
    row0: Math.min(a.row, b.row),
    row1: Math.max(a.row, b.row),
    col0: Math.min(a.col, b.col),
    col1: Math.max(a.col, b.col),
  }
}

export function inSpan(s: Span, row: number, col: number): boolean {
  return row >= s.row0 && row <= s.row1 && col >= s.col0 && col <= s.col1
}

export function spanSize(s: Span): number {
  return (s.row1 - s.row0 + 1) * (s.col1 - s.col0 + 1)
}

/* -- Clipboard ---------------------------------------------------------- */

/** A tab or a newline inside a value would tear the block apart on paste, so
 *  those fields go out quoted — the dialect every spreadsheet already reads. */
function tsvField(value: string): string {
  if (!/[\t\n\r"]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

/** The clipboard payload for a selection: display order, visual column order,
 *  raw values. `rowIndices` are indices into `rows`, `colIndices` indices into
 *  `columns`, both already in the order they appear on screen. */
export function toTSV(
  rows: readonly unknown[][],
  columns: readonly GridColumn[],
  rowIndices: readonly number[],
  colIndices: readonly number[],
  withHeader = false,
): string {
  const lines: string[] = []
  if (withHeader) {
    lines.push(colIndices.map((c) => tsvField(columns[c]?.name ?? '')).join('\t'))
  }
  for (const r of rowIndices) {
    lines.push(colIndices.map((c) => tsvField(rawText(rows[r]?.[c]))).join('\t'))
  }
  return lines.join('\n')
}

/** A number out of a result cell, or null.
 *
 *  ClickHouse quotes 64-bit integers and decimals in JSON for user queries —
 *  the browser would silently round them past 2^53 otherwise — so a perfectly
 *  good `Int64` arrives as the string `"9007199254740993"`. Refusing to add
 *  those up because of their wire format would make the statistics wrong on
 *  exactly the columns people select most. `Number()` on a full-width integer
 *  past 2^53 still rounds, so a sum of very large ids is approximate; that is a
 *  property of doubles, not of the parsing. */
function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/* -- Totals ------------------------------------------------------------- */

/** The calculations a totals row can show. `count` is the one that means
 *  something for every type, so it is what a text column would get if it were
 *  ever asked. */
export type Aggregate = 'sum' | 'avg' | 'min' | 'max' | 'count'

export const AGGREGATES: Aggregate[] = ['sum', 'avg', 'min', 'max', 'count']

/** One column, aggregated over the rows on screen — the footer figure.
 *
 *  `null` for a column the type says is not a number, because a sum of strings
 *  is not a figure that was withheld, it is a question that does not apply. The
 *  count is over the values that are actually there: a column of ten rows with
 *  four NULLs counts four, which is the number a reader of that column needs. */
export function columnAggregate(
  rows: readonly unknown[][],
  columns: readonly GridColumn[],
  index: number,
  kind: Aggregate,
): number | null {
  const column = columns[index]
  if (!column || !isNumeric(column.type)) return null
  let n = 0
  let sum = 0
  let min = Infinity
  let max = -Infinity
  for (const row of rows) {
    const value = numeric(row[index])
    if (value === null) continue
    n += 1
    sum += value
    if (value < min) min = value
    if (value > max) max = value
  }
  if (kind === 'count') return n
  if (n === 0) return null
  if (kind === 'sum') return sum
  if (kind === 'avg') return sum / n
  return kind === 'min' ? min : max
}

/** The next calculation in the cycle, so a click walks the list. */
export function nextAggregate(kind: Aggregate): Aggregate {
  return AGGREGATES[(AGGREGATES.indexOf(kind) + 1) % AGGREGATES.length]!
}

/* -- Data bars ---------------------------------------------------------- */

/** Per-column scales for in-cell bars, or null for a column that gets none.
 *
 *  A bar in a cell answers "how big is this one, among these" without reading a
 *  single figure, which is what a column of ten thousand counts is for. Two
 *  columns get no bar on purpose:
 *
 *  - anything the type says is not a number, so a `String` of digits is left as
 *    the text it is, exactly as the selection statistics leave it;
 *  - a column holding a negative value, because a bar needs a baseline and a
 *    baseline the reader cannot see is a lie. The figures are still right there.
 *
 *  The scale is [`barScale`](./scale.ts) — the 90th percentile — so one outlying
 *  row cannot flatten the column, and a value past it simply fills the cell. */
export function barScales(
  rows: readonly unknown[][],
  columns: readonly GridColumn[],
): (number | null)[] {
  return columns.map((column, index) => {
    if (!isNumeric(column.type)) return null
    const values: number[] = []
    for (const value of sampleColumn(rows, index)) {
      const n = numeric(value)
      if (n === null) continue
      if (n < 0) return null
      values.push(n)
    }
    const scale = barScale(values)
    return scale > 0 ? scale : null
  })
}

/** How much of the cell the bar covers, 0 when there is nothing to draw. */
export function barWidth(value: unknown, scale: number | null): number {
  if (!scale) return 0
  const n = numeric(value)
  if (n === null || n <= 0) return 0
  return Math.min(100, (n / scale) * 100)
}

/* -- Selection statistics ----------------------------------------------- */

export interface SelectionStats {
  /** Every cell in the block, whatever it holds. */
  cells: number
  /** Cells that carried a number. */
  numbers: number
  sum: number
  avg: number
  min: number
  max: number
}

/** Sum, average, extent and count over a selected block — the spreadsheet
 *  reflex, which a grid of numbers has to answer without a round trip.
 *
 *  Indices are the ones already on screen (display row order, visual column
 *  order), the same convention [`toTSV`](#toTSV) takes, so the figures describe
 *  the block the reader can see. Null when the block holds no number at all:
 *  five zeros for a selection of strings is worse than nothing.
 *
 *  What counts as a number is the column's declared type, never the shape of
 *  the value: a `String` column of digits is text somebody chose to store as
 *  text, and summing it because it looks numeric is the kind of help nobody
 *  asked for. */
export function selectionStats(
  rows: readonly unknown[][],
  columns: readonly GridColumn[],
  rowIndices: readonly number[],
  colIndices: readonly number[],
): SelectionStats | null {
  let numbers = 0
  let sum = 0
  let min = Infinity
  let max = -Infinity
  const counted = colIndices.filter((c) => {
    const column = columns[c]
    return column ? isNumeric(column.type) : false
  })
  for (const r of rowIndices) {
    const row = rows[r]
    if (!row) continue
    for (const c of counted) {
      const n = numeric(row[c])
      if (n === null) continue
      numbers += 1
      sum += n
      if (n < min) min = n
      if (n > max) max = n
    }
  }
  if (numbers === 0) return null
  return {
    cells: rowIndices.length * colIndices.length,
    numbers,
    sum,
    avg: sum / numbers,
    min,
    max,
  }
}

/* -- Long values -------------------------------------------------------- */

/** A structured value, indented, for the inspector — or null when the value is
 *  a scalar and there is nothing to unfold. */
export function prettyJSON(value: unknown): string | null {
  if (value !== null && typeof value === 'object') return JSON.stringify(value, null, 2)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^[[{]/.test(trimmed)) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed === null || typeof parsed !== 'object') return null
    return JSON.stringify(parsed, null, 2)
  } catch {
    return null
  }
}

/* -- Remembered widths -------------------------------------------------- */

/** Two results with the same columns and the same types are the same shape, and
 *  a width dragged on one should hold on the next run. The name alone is not
 *  enough: `SELECT toString(id)` is a different column from `SELECT id`. */
export function shapeKey(columns: readonly GridColumn[]): string {
  const shape = columns.map((c) => `${c.name}:${c.type}`).join('\u0000')
  let hash = 2166136261
  for (let i = 0; i < shape.length; i++) {
    hash ^= shape.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${columns.length}-${(hash >>> 0).toString(36)}`
}
