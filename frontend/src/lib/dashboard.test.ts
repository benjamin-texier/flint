import { describe, expect, it } from 'vitest'

import {
  COLUMNS,
  addTile,
  emptySpec,
  moveTile,
  parseSpec,
  patchTile,
  removeTile,
  serialiseSpec,
  type Tile,
} from './dashboard'

const tile = (over: Partial<Tile> = {}): Omit<Tile, 'id'> => ({
  title: 'T',
  sql: 'SELECT 1',
  database: 'analytics',
  chart: null,
  w: 6,
  h: 1,
  ...over,
})

describe('parseSpec', () => {
  it('reads a well-formed spec', () => {
    const spec = parseSpec(
      JSON.stringify({
        refreshSeconds: 30,
        tiles: [{ id: 'a', title: 'Hits', sql: 'SELECT 1', database: 'd', w: 8, h: 2 }],
      }),
    )
    expect(spec.refreshSeconds).toBe(30)
    expect(spec.tiles).toHaveLength(1)
    expect(spec.tiles[0]!.w).toBe(8)
  })

  it('survives text that is not JSON at all', () => {
    expect(parseSpec('{not json')).toEqual(emptySpec())
    expect(parseSpec('')).toEqual(emptySpec())
    expect(parseSpec('null')).toEqual(emptySpec())
    expect(parseSpec('[1,2,3]')).toEqual({ tiles: [], refreshSeconds: 0 })
  })

  it('drops a tile with no SQL — it could only ever render an empty card', () => {
    const spec = parseSpec(JSON.stringify({ tiles: [{ sql: '   ' }, { sql: 'SELECT 1' }] }))
    expect(spec.tiles).toHaveLength(1)
  })

  it('clamps a width that would break the grid', () => {
    const spec = parseSpec(JSON.stringify({ tiles: [{ sql: 'SELECT 1', w: 99, h: -4 }] }))
    expect(spec.tiles[0]!.w).toBe(COLUMNS)
    expect(spec.tiles[0]!.h).toBe(1)
  })

  it('gives a tile an id when the stored one is missing', () => {
    const spec = parseSpec(JSON.stringify({ tiles: [{ sql: 'SELECT 1' }] }))
    expect(spec.tiles[0]!.id).toBe('tile-0')
  })

  it('refuses a chart spec it does not recognise', () => {
    const bad = parseSpec(
      JSON.stringify({ tiles: [{ sql: 'SELECT 1', chart: { kind: 'pie', series: [1] } }] }),
    )
    expect(bad.tiles[0]!.chart).toBeNull()
    const noSeries = parseSpec(
      JSON.stringify({ tiles: [{ sql: 'SELECT 1', chart: { kind: 'line', series: [] } }] }),
    )
    expect(noSeries.tiles[0]!.chart).toBeNull()
  })

  it('keeps a chart spec it does recognise', () => {
    const spec = parseSpec(
      JSON.stringify({
        tiles: [{ sql: 'SELECT 1', chart: { kind: 'line', x: 0, series: [1, 2] } }],
      }),
    )
    expect(spec.tiles[0]!.chart).toEqual({ kind: 'line', x: 0, series: [1, 2], why: '' })
  })

  it('round-trips through serialise', () => {
    const spec = addTile(emptySpec(), tile({ title: 'Hits' }))
    const back = parseSpec(serialiseSpec(spec))
    expect(back.tiles[0]!.title).toBe('Hits')
    expect(back.tiles).toHaveLength(1)
  })
})

describe('editing tiles', () => {
  it('adds with a fresh id', () => {
    const spec = addTile(addTile(emptySpec(), tile()), tile())
    expect(new Set(spec.tiles.map((t) => t.id)).size).toBe(2)
  })

  it('removes by id and leaves the rest', () => {
    const spec = addTile(addTile(emptySpec(), tile({ title: 'A' })), tile({ title: 'B' }))
    const after = removeTile(spec, spec.tiles[0]!.id)
    expect(after.tiles.map((t) => t.title)).toEqual(['B'])
  })

  it('patches one tile only', () => {
    const spec = addTile(addTile(emptySpec(), tile({ title: 'A' })), tile({ title: 'B' }))
    const after = patchTile(spec, spec.tiles[1]!.id, { w: 12 })
    expect(after.tiles[0]!.w).toBe(6)
    expect(after.tiles[1]!.w).toBe(12)
  })
})

describe('moveTile', () => {
  const build = () =>
    ['A', 'B', 'C'].reduce((s, title) => addTile(s, tile({ title })), emptySpec())

  it('moves a tile to a new index', () => {
    const spec = build()
    const after = moveTile(spec, spec.tiles[2]!.id, 0)
    expect(after.tiles.map((t) => t.title)).toEqual(['C', 'A', 'B'])
  })

  it('clamps a target past either end', () => {
    const spec = build()
    expect(moveTile(spec, spec.tiles[0]!.id, 99).tiles.map((t) => t.title)).toEqual(['B', 'C', 'A'])
    expect(moveTile(spec, spec.tiles[2]!.id, -5).tiles.map((t) => t.title)).toEqual(['C', 'A', 'B'])
  })

  it('is a no-op for an unknown id or an unchanged position', () => {
    const spec = build()
    expect(moveTile(spec, 'nope', 0)).toBe(spec)
    expect(moveTile(spec, spec.tiles[1]!.id, 1)).toBe(spec)
  })
})
