/** Where the disk is, as proportion.
 *
 *  A list of tables sorted by size is a list to read. "Which of these *is* the
 *  disk" is a question about proportion, and proportion is a shape — one glance
 *  at a treemap says what a column of numbers says only after you have added
 *  several of them up.
 *
 *  Two decisions carry the whole view. The unit is the **column**, because a
 *  column store is the one place where that is the honest unit: a table that is
 *  90% one `String` of JSON is a different object from one whose bytes are
 *  spread evenly, and no per-table figure can tell them apart. And a cell is
 *  coloured by **type family**, using the same vocabulary the type badges use,
 *  because "all of this disk is one Nested" is an answer that no size alone
 *  gives.
 *
 *  Everything here is pure so the layout can be tested without a browser. */

export interface ColumnMass {
  table: string
  column: string
  type: string
  bytes: number
  uncompressed_bytes: number
}

export interface TableMass {
  table: string
  /** Everything the table's active parts take on disk. The same figure the
   *  headline and the object list print for it — a picture that disagreed with
   *  the number above it is a picture people stop believing. */
  bytes: number
  uncompressed_bytes: number
  /** Columns with a size of their own. Zero where the parts are compact. */
  columns: number
  /** What those columns come to; the difference from `bytes` is the marks, the
   *  primary key index and any projections. */
  column_bytes: number
  /** Disk held by this table's projections — inside `bytes`, not beside it. */
  projection_bytes: number
}

export interface MassReport {
  available: boolean
  reason?: string
  tables: TableMass[]
  columns: ColumnMass[]
  total_tables: number
  total_bytes: number
  columns_truncated: boolean
  /** Why there is no column breakdown at all, where there is none. The map
   *  still draws every table: the sizes are real, only the division is missing. */
  columns_reason?: string
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** One item to lay out: anything with a size and an identity. */
export interface Weighted {
  key: string
  value: number
}

export interface Tile<T extends Weighted = Weighted> extends Rect {
  item: T
}

/** Squarified treemap layout.
 *
 *  The naive slice-and-dice layout — divide the whole strip by the first value,
 *  then the remainder by the second — produces slivers: a cell one pixel wide
 *  and four hundred tall has an area you cannot judge and a label you cannot
 *  put in it, which defeats the only thing a treemap is for. Squarifying keeps
 *  each row of cells as close to square as it can, at the cost of an order that
 *  is only roughly largest-first.
 *
 *  Items are laid out in the order given — sort before calling. Non-positive
 *  values are dropped rather than drawn as zero-area rectangles that still
 *  catch a mouse. */
export function squarify<T extends Weighted>(items: readonly T[], frame: Rect): Tile<T>[] {
  const live = items.filter((i) => i.value > 0)
  const total = live.reduce((sum, i) => sum + i.value, 0)
  if (live.length === 0 || total <= 0 || frame.w <= 0 || frame.h <= 0) return []

  const tiles: Tile<T>[] = []
  // Value per unit of area, so a row's values can be turned into a length.
  const density = total / (frame.w * frame.h)
  let rest = { ...frame }
  let queue = [...live]

  while (queue.length > 0) {
    const short = Math.min(rest.w, rest.h)
    const row: T[] = []
    let rowValue = 0
    let best = Infinity

    /* Take items into the row while doing so improves its worst aspect ratio.
       The first item always joins: a row of one is the only row a single
       remaining item can be in. */
    while (queue.length > 0) {
      const next = queue[0]!
      const withNext = worstRatio([...row, next], rowValue + next.value, short, density)
      if (row.length > 0 && withNext > best) break
      row.push(next)
      rowValue += next.value
      best = withNext
      queue = queue.slice(1)
    }

    // The row occupies a strip across the short side of what is left.
    const thickness = rowValue / density / short
    let along = 0
    for (const item of row) {
      const length = (item.value / rowValue) * short
      tiles.push(
        rest.w >= rest.h
          ? { item, x: rest.x, y: rest.y + along, w: thickness, h: length }
          : { item, x: rest.x + along, y: rest.y, w: length, h: thickness },
      )
      along += length
    }
    rest =
      rest.w >= rest.h
        ? { x: rest.x + thickness, y: rest.y, w: rest.w - thickness, h: rest.h }
        : { x: rest.x, y: rest.y + thickness, w: rest.w, h: rest.h - thickness }
    // Floating point leaves a hair of the frame behind; stop rather than lay
    // out invisible rows in it.
    if (rest.w <= 0.01 || rest.h <= 0.01) break
  }
  return tiles
}

/** The worst aspect ratio in a row, which is what squarifying minimises. */
function worstRatio<T extends Weighted>(
  row: readonly T[],
  rowValue: number,
  short: number,
  density: number,
): number {
  if (rowValue <= 0) return Infinity
  const thickness = rowValue / density / short
  let worst = 0
  for (const item of row) {
    const length = (item.value / rowValue) * short
    if (length <= 0 || thickness <= 0) return Infinity
    worst = Math.max(worst, Math.max(thickness / length, length / thickness))
  }
  return worst
}

/** A cell of the finished map: one column, or one fold standing for several. */
/** A cell's rectangle is relative to its **block**, not to the frame: the block
 *  is a positioned element on the page and its cells are drawn inside it, so
 *  frame coordinates would offset every one of them twice. */
export interface MassCell extends Rect {
  table: string
  /** The column's name, or a fold's or the overhead cell's own sentence. */
  label: string
  /** The type family's colour token. Absent on a fold — the columns it stands
   *  for are not all one type and colouring it as though they were would be an
   *  invented fact — and on the overhead cell, which is not a column at all. */
  type?: string
  bytes: number
  uncompressed_bytes: number
  /** How many columns this cell stands for. 1 for a column, more for a fold,
   *  0 for the overhead cell. */
  columns: number
  /** What this cell is. `overhead` is the marks and the primary key index and
   *  `projection` is a projection's parts: real disk that belongs to no column,
   *  drawn as its own cell rather than spread silently across the ones that do.
   *
   *  A projection is its own cell rather than part of the overhead because it is
   *  a different kind of fact — marks are the cost of storing the columns, and a
   *  projection is a second copy of some of them that somebody asked for. On a
   *  table whose projection is nearly a full copy the two together would be half
   *  the block, under a label that named only the smaller half. */
  kind: 'column' | 'fold' | 'overhead' | 'projection'
}

export interface MassBlock extends Rect {
  table: TableMass
  cells: MassCell[]
  /** Columns folded into the tail cell, if any. */
  folded: number
  /** Why the block is not divided, where it is not.
   *
   *  Three different facts, which must not be reported as one. `small` is about
   *  this drawing: the rectangle has no room, and a wider frame would divide it.
   *  `compact` is about the server: a MergeTree part below the compact threshold
   *  keeps every column in one file, so ClickHouse has no per-column size to
   *  give and no frame will ever produce one. `capped` is about this request:
   *  the sizes exist and were not fetched, because the answer had already
   *  reached the number of columns it will carry.
   *
   *  `capped` used to be reported as `compact`, since both arrive as a block
   *  with no columns — so a table past the cap told the reader something
   *  specific and false about how ClickHouse stores it. The rollup knows the
   *  difference: it carries `column_bytes` for every table whether or not that
   *  table's columns were fetched. */
  whole: null | 'small' | 'compact' | 'capped'
}

export interface MassMap {
  blocks: MassBlock[]
  /** Tables holding column data that the row cap left out, and their share. */
  omittedTables: number
  /** Share of the database's column data the drawn blocks hold, 0..1, or null
   *  where the server reported no total. */
  shareOfBytes: number | null
  columnsTruncated: boolean
}

/** A block smaller than this is drawn whole: dividing 60 square pixels between
 *  thirty columns produces thirty cells nobody can see, hover or read. */
const DIVIDE_ABOVE = 2600
/** A cell below this is folded into the tail, because a rectangle this small
 *  can carry neither a label nor a judgement about its own area. */
const FOLD_BELOW = 420

/** Lay a database's columns out in a frame. */
export function buildMap(report: MassReport, frame: Rect): MassMap {
  const byTable = new Map<string, ColumnMass[]>()
  for (const c of report.columns) {
    const list = byTable.get(c.table)
    if (list) list.push(c)
    else byTable.set(c.table, [c])
  }

  const blocks: MassBlock[] = squarify(
    report.tables.map((t) => ({ key: t.table, value: t.bytes, table: t })),
    frame,
  ).map(({ item, ...rect }) => {
    const columns = [...(byTable.get(item.table.table) ?? [])].sort((a, b) => b.bytes - a.bytes)
    const area = rect.w * rect.h
    if (item.table.column_bytes <= 0) {
      return { ...rect, table: item.table, cells: [], folded: 0, whole: 'compact' as const }
    }
    if (columns.length === 0) {
      return { ...rect, table: item.table, cells: [], folded: 0, whole: 'capped' as const }
    }
    if (area < DIVIDE_ABOVE) {
      return { ...rect, table: item.table, cells: [], folded: 0, whole: 'small' as const }
    }

    /* Fold the tail first, then lay out — folding after the layout would leave
       the fold's cell wherever the last column happened to land, at the size of
       one column rather than of all of them. */
    const share = (bytes: number) => (bytes / item.table.bytes) * area
    const kept = columns.filter((c) => share(c.bytes) >= FOLD_BELOW)
    const tail = columns.slice(kept.length)
    const items: (Weighted & { cell: Omit<MassCell, keyof Rect> })[] = kept.map((c) => ({
      key: `${c.table}.${c.column}`,
      value: c.bytes,
      cell: {
        table: c.table,
        label: c.column,
        type: c.type,
        bytes: c.bytes,
        uncompressed_bytes: c.uncompressed_bytes,
        columns: 1,
        kind: 'column' as const,
      },
    }))
    if (tail.length > 0) {
      const bytes = tail.reduce((sum, c) => sum + c.bytes, 0)
      items.push({
        key: `${item.table.table}.__rest`,
        value: bytes,
        cell: {
          table: item.table.table,
          label: `${tail.length} smaller ${tail.length === 1 ? 'column' : 'columns'}`,
          bytes,
          uncompressed_bytes: tail.reduce((sum, c) => sum + c.uncompressed_bytes, 0),
          columns: tail.length,
          kind: 'fold' as const,
        },
      })
    }

    /* What the columns do not account for: the marks and the primary key index.
       It is real disk and it belongs to no column, so it gets a cell of its own
       — spreading it over the columns would overstate every one of them, and
       leaving it out would make the block's parts fail to add up to the block.
 
       And it is drawn whenever it exists, however small, which is where this had
       a hole: it used to pass through the same size threshold as a column, and a
       cell dropped for being small does not vanish — `squarify` fills the frame
       with whatever it is given, so those bytes were silently redistributed over
       the columns, overstating every one of them. Exactly what the paragraph
       above forbids. The threshold is a rule about *columns*, of which there can
       be hundreds; there is one of these, and a two-pixel stripe that keeps the
       arithmetic true is a better cell than none.
 
       Measured on a real server: 0.31% of `system.text_log`, 4.87% of
       `part_log`, and 9.81% of `metric_log` — which has two thousand columns and
       therefore two thousand sets of marks. On a table with compact parts it is
       everything, and the block is drawn whole instead. */
    const projections = Math.min(
      item.table.projection_bytes,
      Math.max(0, item.table.bytes - item.table.column_bytes),
    )
    if (projections > 0) {
      items.push({
        key: `${item.table.table}.__projections`,
        value: projections,
        cell: {
          table: item.table.table,
          label: 'projections',
          bytes: projections,
          uncompressed_bytes: projections,
          columns: 0,
          kind: 'projection' as const,
        },
      })
    }
    const overhead = Math.max(0, item.table.bytes - item.table.column_bytes - projections)
    if (overhead > 0) {
      items.push({
        key: `${item.table.table}.__overhead`,
        value: overhead,
        cell: {
          table: item.table.table,
          label: 'marks & index',
          bytes: overhead,
          uncompressed_bytes: overhead,
          columns: 0,
          kind: 'overhead' as const,
        },
      })
    }

    return {
      ...rect,
      table: item.table,
      cells: squarify(items, { x: 0, y: 0, w: rect.w, h: rect.h }).map(({ item: i, ...r }) => ({
        ...r,
        ...i.cell,
      })),
      folded: tail.length,
      whole: null,
    }
  })

  const drawn = report.tables.reduce((sum, t) => sum + t.bytes, 0)
  return {
    blocks,
    omittedTables: Math.max(0, report.total_tables - report.tables.length),
    shareOfBytes: report.total_bytes > 0 ? drawn / report.total_bytes : null,
    columnsTruncated: report.columns_truncated,
  }
}

/** Everything the map is not showing. Each cap states its own count, as
 *  everywhere else: a picture silently holding back half a database reads as
 *  the whole one. */
export function leftOut(map: MassMap): string[] {
  const out: string[] = []
  if (map.omittedTables > 0) {
    out.push(
      `${map.omittedTables} smaller ${map.omittedTables === 1 ? 'table' : 'tables'} not drawn`,
    )
  }
  /* The two reasons a block is undivided are different facts. One is about this
     drawing and would go away in a wider frame; the other is about how the
     server stores a small table and never will. */
  const small = map.blocks.filter((b) => b.whole === 'small').length
  if (small > 0) {
    out.push(`${small} too small here to divide into columns`)
  }
  const compact = map.blocks.filter((b) => b.whole === 'compact').length
  if (compact > 0) {
    out.push(
      `${compact} stored in compact parts, which keep every column in one file — ClickHouse reports no per-column sizes for them`,
    )
  }
  const capped = map.blocks.filter((b) => b.whole === 'capped').length
  if (capped > 0) {
    out.push(`${capped} whose columns were not fetched — the answer had reached its column cap`)
  }
  if (map.columnsTruncated) {
    out.push('some columns of the tables drawn are missing — this database is past the cell cap')
  }
  return out
}
