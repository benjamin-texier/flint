import { describe, expect, it } from 'vitest'

import {
  buildMap,
  leftOut,
  squarify,
  type ColumnMass,
  type MassReport,
  type TableMass,
} from './treemap'

const FRAME = { x: 0, y: 0, w: 400, h: 300 }

const column = (over: Partial<ColumnMass> = {}): ColumnMass => ({
  table: 'events',
  column: 'payload',
  type: 'String',
  bytes: 1000,
  uncompressed_bytes: 8000,
  ...over,
})

/** A table whose columns account for all of its bytes — the overhead cell is
 *  tested on its own, and every other case is clearer without it. */
const tbl = (over: Partial<TableMass> = {}): TableMass => {
  const bytes = over.bytes ?? 1000
  return {
    table: 'events',
    bytes,
    uncompressed_bytes: 8000,
    columns: 1,
    column_bytes: bytes,
    projection_bytes: 0,
    ...over,
  }
}

const report = (over: Partial<MassReport> = {}): MassReport => ({
  available: true,
  tables: [tbl()],
  columns: [column()],
  total_tables: 1,
  total_bytes: 1000,
  columns_truncated: false,
  ...over,
})

const area = (r: { w: number; h: number }) => r.w * r.h

describe('squarify', () => {
  it('covers the frame, and each tile takes its share of it', () => {
    const items = [
      { key: 'a', value: 6 },
      { key: 'b', value: 3 },
      { key: 'c', value: 1 },
    ]
    const tiles = squarify(items, FRAME)
    expect(tiles).toHaveLength(3)
    const total = tiles.reduce((sum, t) => sum + area(t), 0)
    expect(total).toBeCloseTo(area(FRAME), 4)
    const a = tiles.find((t) => t.item.key === 'a')!
    expect(area(a) / area(FRAME)).toBeCloseTo(0.6, 4)
  })

  it('keeps tiles roughly square rather than slivers', () => {
    // The whole reason for squarifying: slice-and-dice gives the last of twenty
    // items a rectangle one pixel wide, whose area nobody can judge and whose
    // label does not fit.
    const items = Array.from({ length: 20 }, (_, i) => ({ key: `c${i}`, value: 20 - i }))
    const worst = Math.max(
      ...squarify(items, FRAME).map((t) => Math.max(t.w / t.h, t.h / t.w)),
    )
    expect(worst).toBeLessThan(8)
  })

  it('never overlaps two tiles', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ key: `c${i}`, value: (i % 4) + 1 }))
    const tiles = squarify(items, FRAME)
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        const a = tiles[i]!
        const b = tiles[j]!
        const apart =
          a.x + a.w <= b.x + 0.01 ||
          b.x + b.w <= a.x + 0.01 ||
          a.y + a.h <= b.y + 0.01 ||
          b.y + b.h <= a.y + 0.01
        expect(apart).toBe(true)
      }
    }
  })

  it('drops what has no size instead of drawing a rectangle that catches a mouse', () => {
    const tiles = squarify(
      [
        { key: 'a', value: 5 },
        { key: 'empty', value: 0 },
      ],
      FRAME,
    )
    expect(tiles.map((t) => t.item.key)).toEqual(['a'])
  })

  it('lays out nothing in a frame with no room, rather than throwing', () => {
    expect(squarify([{ key: 'a', value: 1 }], { x: 0, y: 0, w: 0, h: 100 })).toEqual([])
    expect(squarify([], FRAME)).toEqual([])
  })
})

describe('buildMap', () => {
  it('gives each table a block in proportion to its bytes', () => {
    const map = buildMap(
      report({
        tables: [tbl({ bytes: 3000 }), tbl({ table: 'devices', bytes: 1000 })],
        columns: [column({ bytes: 3000 }), column({ table: 'devices', bytes: 1000 })],
        total_tables: 2,
        total_bytes: 4000,
      }),
      FRAME,
    )
    const events = map.blocks.find((b) => b.table.table === 'events')!
    expect(area(events) / area(FRAME)).toBeCloseTo(0.75, 3)
  })

  it('folds the columns too small to see into one cell that says how many', () => {
    // Thirty tiny columns beside one large one is thirty rectangles nobody can
    // hover, read or judge. Folded, they are one cell with a real area and a
    // sentence — and the count is on the cell rather than lost.
    const columns = [
      column({ column: 'payload', bytes: 100_000 }),
      ...Array.from({ length: 30 }, (_, i) => column({ column: `c${i}`, bytes: 40 })),
    ]
    const map = buildMap(
      report({
        tables: [tbl({ bytes: 101_200, columns: 31 })],
        columns,
        total_bytes: 101_200,
      }),
      FRAME,
    )
    const block = map.blocks[0]!
    const fold = block.cells.find((c) => c.columns > 1)!
    expect(fold.label).toBe('30 smaller columns')
    expect(fold.bytes).toBe(1200)
    // A fold has no type: the columns it stands for are not all one type, and
    // colouring it as though they were would be an invented fact.
    expect(fold.type).toBeUndefined()
    expect(block.folded).toBe(30)
  })

  it('positions cells inside their block, not inside the frame', () => {
    // The block is a positioned element and its cells are drawn within it, so
    // frame coordinates would offset every cell twice — which puts a table's
    // columns somewhere off its own block.
    const map = buildMap(
      report({
        tables: [tbl({ table: 'a', bytes: 1000 }), tbl({ table: 'b', bytes: 1000, columns: 2 })],
        columns: [
          column({ table: 'a', bytes: 1000 }),
          column({ table: 'b', column: 'x', bytes: 600 }),
          column({ table: 'b', column: 'y', bytes: 400 }),
        ],
        total_tables: 2,
        total_bytes: 2000,
      }),
      FRAME,
    )
    const b = map.blocks.find((blk) => blk.table.table === 'b')!
    expect(b.x).toBeGreaterThan(0)
    for (const cell of b.cells) {
      expect(cell.x).toBeGreaterThanOrEqual(0)
      expect(cell.x + cell.w).toBeLessThanOrEqual(b.w + 0.01)
      expect(cell.y + cell.h).toBeLessThanOrEqual(b.h + 0.01)
    }
  })

  it('draws a block whole when it is too small to divide', () => {
    const map = buildMap(
      report({
        tables: [tbl({ bytes: 1_000_000 }), tbl({ table: 'tiny', bytes: 100 })],
        columns: [
          column({ bytes: 1_000_000 }),
          column({ table: 'tiny', column: 'a', bytes: 60 }),
          column({ table: 'tiny', column: 'b', bytes: 40 }),
        ],
        total_tables: 2,
        total_bytes: 1_000_100,
      }),
      FRAME,
    )
    const tiny = map.blocks.find((b) => b.table.table === 'tiny')!
    expect(tiny.whole).toBe('small')
    expect(tiny.cells).toEqual([])
  })

  it('does not call a table compact when its columns were merely not fetched', () => {
    // Both arrive as a block with no columns, and the rollup is what tells them
    // apart: it carries `column_bytes` for every table whether or not that
    // table's columns fitted in the answer. Reported as one, a table past the
    // cap told the reader something specific and false about its storage.
    const map = buildMap(
      report({
        tables: [
          tbl({ table: 'fetched', bytes: 900, column_bytes: 900, columns: 1 }),
          tbl({ table: 'past-cap', bytes: 800, column_bytes: 800, columns: 9 }),
          tbl({ table: 'compact', bytes: 700, column_bytes: 0, columns: 0 }),
        ],
        columns: [column({ table: 'fetched', bytes: 900 })],
        total_bytes: 2400,
      }),
      FRAME,
    )
    const by = (t: string) => map.blocks.find((b) => b.table.table === t)!
    expect(by('past-cap').whole).toBe('capped')
    expect(by('compact').whole).toBe('compact')
    const said = leftOut(map).join(' · ')
    expect(said).toContain('1 stored in compact parts')
    expect(said).toContain('1 whose columns were not fetched')
  })

  it('reports the share of the database it accounts for', () => {
    const map = buildMap(
      report({ tables: [tbl({ bytes: 800 })], total_tables: 30, total_bytes: 1000 }),
      FRAME,
    )
    expect(map.shareOfBytes).toBeCloseTo(0.8)
    expect(map.omittedTables).toBe(29)
  })
})

describe('buildMap — what the columns do not account for', () => {
  it('draws the marks and the index as their own cell', () => {
    // Real disk that belongs to no column. Spread over the columns it would
    // overstate every one of them; left out, a block's parts would not add up
    // to the block.
    const map = buildMap(
      report({
        tables: [tbl({ bytes: 100_000, column_bytes: 60_000, columns: 1 })],
        columns: [column({ bytes: 60_000 })],
        total_bytes: 100_000,
      }),
      FRAME,
    )
    const overhead = map.blocks[0]!.cells.find((c) => c.kind === 'overhead')!
    expect(overhead.label).toBe('marks & index')
    expect(overhead.bytes).toBe(40_000)
    expect(overhead.type).toBeUndefined()
  })

  it('draws it however small, so the block always adds up', () => {
    // A cell dropped for being small does not vanish: `squarify` fills the frame
    // with whatever it is given, so the bytes would be redistributed over the
    // columns and overstate every one of them. One two-pixel stripe is better.
    const map = buildMap(
      report({
        tables: [tbl({ bytes: 1_000_000, column_bytes: 999_000, columns: 1 })],
        columns: [column({ bytes: 999_000 })],
        total_bytes: 1_000_000,
      }),
      FRAME,
    )
    const cells = map.blocks[0]!.cells
    expect(cells.some((c) => c.kind === 'overhead')).toBe(true)
    expect(cells.reduce((sum, c) => sum + c.bytes, 0)).toBe(1_000_000)
  })

  it('gives a projection its own cell rather than burying it in the overhead', () => {
    // A part's `bytes_on_disk` counts the projection parts stored under it —
    // measured, and the small case is a trap: a toy projection is under the
    // noise of two tables built from random data. A projection that is nearly a
    // second copy settled it, and on such a table the marks-and-index cell would
    // otherwise be labelled for the smaller of the two things inside it.
    const map = buildMap(
      report({
        tables: [
          tbl({ bytes: 4_410_000, column_bytes: 2_190_000, projection_bytes: 2_210_000, columns: 3 }),
        ],
        columns: [column({ bytes: 2_190_000 })],
        total_bytes: 4_410_000,
      }),
      FRAME,
    )
    const cells = map.blocks[0]!.cells
    const proj = cells.find((c) => c.kind === 'projection')!
    const marks = cells.find((c) => c.kind === 'overhead')!
    expect(proj.label).toBe('projections')
    expect(proj.bytes).toBe(2_210_000)
    // The marks are what is left, and on a real table that is a small figure
    // beside a projection this size — which is the whole point of separating
    // them: one label was carrying both.
    expect(marks.bytes).toBe(10_000)
    // And the block still adds up.
    expect(cells.reduce((sum, c) => sum + c.bytes, 0)).toBe(4_410_000)
  })

  it('draws a table with no per-column sizes whole, and says which reason it is', () => {
    // A compact part keeps every column in one file, so ClickHouse reports zero
    // for each of them — truthfully. Filtering such a table out would remove
    // real disk from a picture whose whole claim is that it shows where the
    // disk is.
    const map = buildMap(
      report({
        tables: [tbl({ table: 'devices', bytes: 4000, columns: 0, column_bytes: 0 })],
        columns: [],
        total_bytes: 4000,
      }),
      FRAME,
    )
    expect(map.blocks[0]!.whole).toBe('compact')
    expect(leftOut(map).join(' ')).toContain('compact parts')
  })
})

describe('leftOut', () => {
  it('says nothing when the map is the whole truth', () => {
    expect(leftOut(buildMap(report(), FRAME))).toEqual([])
  })

  it('states each cap with its count', () => {
    const map = buildMap(
      report({
        tables: [tbl({ bytes: 1_000_000 }), tbl({ table: 'tiny', bytes: 100 })],
        columns: [column({ bytes: 1_000_000 }), column({ table: 'tiny', bytes: 100 })],
        total_tables: 5,
        total_bytes: 2_000_000,
        columns_truncated: true,
      }),
      FRAME,
    )
    const said = leftOut(map).join(' · ')
    expect(said).toContain('3 smaller tables not drawn')
    expect(said).toContain('1 too small here to divide into columns')
    expect(said).toContain('cell cap')
  })
})
