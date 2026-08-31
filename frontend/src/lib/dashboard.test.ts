import { describe, expect, it } from 'vitest'

import {
  addTile,
  carriesDates,
  COLUMNS,
  emptySpec,
  bindingsFor,
  declaredVariables,
  followsRange,
  rangeParams,
  saysRange,
  variableIssues,
  type DashboardSpec,
  moveTile,
  parseSpec,
  patchTile,
  removeTile,
  serialiseSpec,
  tileZone,
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
    expect(parseSpec('[1,2,3]')).toEqual(emptySpec())
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

  it('keeps every form the picker can produce, and the grid its second axis', () => {
    /* A kind missing from the reader is the one failure nobody sees: the tile
       falls back to a table with no error anywhere saying a chart was dropped.
       So every member of the union is asserted here rather than the two that
       happened to be on somebody's dashboard. */
    for (const kind of ['stat', 'line', 'area', 'bar', 'donut', 'heatmap', 'scatter']) {
      const spec = parseSpec(
        JSON.stringify({ tiles: [{ sql: 'SELECT 1', chart: { kind, x: 0, series: [1] } }] }),
      )
      expect(spec.tiles[0]!.chart?.kind).toBe(kind)
    }
    const grid = parseSpec(
      JSON.stringify({
        tiles: [{ sql: 'SELECT 1', chart: { kind: 'heatmap', x: 0, y: 1, series: [2] } }],
      }),
    )
    expect(grid.tiles[0]!.chart?.y).toBe(1)
    // A stored -1 would send the grid looking for a column that is not there.
    const noAxis = parseSpec(
      JSON.stringify({
        tiles: [{ sql: 'SELECT 1', chart: { kind: 'heatmap', x: 0, y: -1, series: [2] } }],
      }),
    )
    expect(noAxis.tiles[0]!.chart?.y).toBeUndefined()
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

describe('tileZone', () => {
  it('takes the zone the statement declares', () => {
    // What Flint's own builder writes, and unambiguous.
    expect(tileZone("SELECT 1 SETTINGS session_timezone = 'Pacific/Auckland'", 'UTC')).toBe(
      'Pacific/Auckland',
    )
  })

  it("falls back to the server's, which nothing in the statement overrode", () => {
    expect(tileZone('SELECT toStartOfDay(ts) FROM t', 'UTC')).toBe('UTC')
  })

  it('and says nothing where the statement names a place itself', () => {
    // The one case worth getting right: guessing the server's zone here would
    // print a confident sentence that is wrong, which is worse for a reader
    // than an absent one.
    expect(tileZone("SELECT toStartOfDay(ts, 'Europe/Oslo') FROM t", 'UTC')).toBeUndefined()
    // Over-eager on purpose: a path in a filter costs a sentence rather than
    // making a false one.
    expect(tileZone("SELECT * FROM t WHERE path = '/api/x'", 'UTC')).toBeUndefined()
  })

  it('says nothing when it does not know the server’s own either', () => {
    expect(tileZone('SELECT toStartOfDay(ts) FROM t', undefined)).toBeUndefined()
    expect(tileZone('SELECT toStartOfDay(ts) FROM t', '')).toBeUndefined()
  })
})

describe('carriesDates', () => {
  it('is what decides whether the zone is worth a word', () => {
    // A tile showing three counts has a timezone the way it has a row limit.
    expect(carriesDates(['UInt64', 'String'])).toBe(false)
    expect(carriesDates(['DateTime', 'UInt64'])).toBe(true)
    expect(carriesDates(['Date'])).toBe(true)
    expect(carriesDates(['Nullable(DateTime64(3))'])).toBe(true)
  })
})

describe('a dashboard-wide range', () => {
  const spec = (sqls: string[], rangeHours = 24): DashboardSpec => ({
    refreshSeconds: 0,
    rangeHours,
    variables: {},
    tiles: sqls.map((sql, i) => ({
      id: `t${i}`,
      title: `Tile ${i}`,
      sql,
      database: 'analytics',
      chart: null,
      w: 6,
      h: 1,
    })),
  })

  it('computes the window at the moment of asking', () => {
    /* A dashboard is a thing left open on a wall. "The last seven days" is still
       true tomorrow; a pair of timestamps stored yesterday is not. */
    const now = new Date('2026-08-30T12:00:00Z')
    expect(rangeParams(24, now)).toEqual({
      from: '2026-08-29 12:00:00',
      to: '2026-08-30 12:00:00',
    })
  })

  it('binds nothing when the dashboard sets no range', () => {
    expect(rangeParams(0)).toEqual({})
  })

  it('knows which statements ask for it', () => {
    expect(followsRange('SELECT 1 WHERE ts >= {from:DateTime}')).toBe(true)
    expect(followsRange('SELECT 1 WHERE ts < {to:DateTime}')).toBe(true)
    expect(followsRange('SELECT 1 WHERE x = {region:String}')).toBe(false)
    expect(followsRange('SELECT count() FROM t')).toBe(false)
  })

  it('says how many tiles it reaches, and what the rest do', () => {
    // A control that changes six of nine tiles and says nothing about the other
    // three is a control nobody can trust.
    const mixed = spec([
      'SELECT 1 WHERE ts >= {from:DateTime}',
      'SELECT 2',
      'SELECT 3',
    ])
    expect(saysRange(mixed)).toContain('followed by 1 of 3 tiles')
    expect(saysRange(mixed)).toContain('The other 2 do not declare')
  })

  it('reads as one sentence when every tile follows it', () => {
    expect(saysRange(spec(['SELECT 1 WHERE ts >= {from:DateTime}']))).toBe(
      'last 24 hours, on every tile.',
    )
  })

  it('says nothing when there is no range to say anything about', () => {
    expect(saysRange(spec(['SELECT 1'], 0))).toBeNull()
  })

  it('refuses a stored range that is not one of the windows offered', () => {
    // A stored spec is not trusted, and 9,000 hours would read as a bug.
    expect(parseSpec(JSON.stringify({ tiles: [], rangeHours: 9000 })).rangeHours).toBe(0)
    expect(parseSpec(JSON.stringify({ tiles: [], rangeHours: 168 })).rangeHours).toBe(168)
  })
})

describe('variables the tiles declare', () => {
  const board = (
    sqls: string[],
    variables: Record<string, string> = {},
  ): DashboardSpec => ({
    refreshSeconds: 0,
    rangeHours: 0,
    variables,
    tiles: sqls.map((sql, i) => ({
      id: `t${i}`,
      title: `Tile ${i}`,
      sql,
      database: 'analytics',
      chart: null,
      w: 6,
      h: 1,
    })),
  })

  it('collects them from the statements rather than from a list beside them', () => {
    // A list maintained by hand drifts, and here the drift is silent until a
    // tile fails with UNKNOWN_QUERY_PARAMETER.
    const b = board([
      'SELECT 1 WHERE region = {region:String}',
      'SELECT 2 WHERE region = {region:String} AND n > {floor:UInt32}',
    ])
    expect(declaredVariables(b).map((v) => [v.name, v.types, v.usedBy.length])).toEqual([
      ['floor', ['UInt32'], 1],
      ['region', ['String'], 2],
    ])
  })

  it('leaves the window to the range', () => {
    const b = board(['SELECT 1 WHERE ts >= {from:DateTime} AND x = {x:String}'])
    expect(declaredVariables(b).map((v) => v.name)).toEqual(['x'])
  })

  it('says an unset variable will fail rather than come back empty', () => {
    /* Measured: ClickHouse answers `Substitution 'region' is not set`, so the
       tile shows an error where a reader expects data. */
    const b = board(['SELECT 1 WHERE region = {region:String}'])
    expect(variableIssues(b)[0]).toContain('will fail rather than come back empty')
    expect(variableIssues(board(['SELECT 1 WHERE region = {region:String}'], { region: 'eu' })))
      .toEqual([])
  })

  it('counts the tiles an unset variable takes down', () => {
    const b = board([
      'SELECT 1 WHERE region = {region:String}',
      'SELECT 2 WHERE region = {region:String}',
    ])
    expect(variableIssues(b)[0]).toContain('all 2 tiles that ask for it will fail')
  })

  it('names a type the tiles disagree about', () => {
    /* Measured: `{n:String}` accepts `eu-west` while `{n:UInt8}` beside it
       answers "Value eu-west cannot be parsed as UInt8". One bound string, and
       half the dashboard breaks on a value the other half is happy with. */
    const b = board(
      ['SELECT 1 WHERE n = {n:String}', 'SELECT 2 WHERE n = {n:UInt8}'],
      { n: 'eu-west' },
    )
    expect(variableIssues(b)[0]).toContain('declared as String and UInt8 by different tiles')
  })

  it('drops a stored value that is not a string', () => {
    // A variable arriving as an object would be bound as `[object Object]` and
    // fail somewhere far from here.
    const parsed = parseSpec(
      JSON.stringify({ tiles: [], variables: { good: 'x', bad: { a: 1 }, 'no spaces': 'y' } }),
    )
    expect(parsed.variables).toEqual({ good: 'x' })
  })
})

describe('bindingsFor', () => {
  const tile = (sql: string): Tile => ({
    id: 't',
    title: 'T',
    sql,
    database: 'analytics',
    chart: null,
    w: 6,
    h: 1,
  })

  it('sends a tile only what it asked for', () => {
    // A tile is never handed a value it did not declare: ClickHouse would not
    // mind, and the next reader of the request would.
    const spec: DashboardSpec = {
      refreshSeconds: 0,
      rangeHours: 24,
      variables: { region: 'eu', unused: 'x' },
      tiles: [],
    }
    const t = tile('SELECT 1 WHERE region = {region:String}')
    expect(bindingsFor(t, spec)).toEqual({ region: 'eu' })
  })

  it('adds the window only to a tile that declares it', () => {
    const spec: DashboardSpec = { refreshSeconds: 0, rangeHours: 24, variables: {}, tiles: [] }
    const now = new Date('2026-08-30T12:00:00Z')
    expect(bindingsFor(tile('SELECT 1 WHERE ts >= {from:DateTime}'), spec, now)).toEqual({
      from: '2026-08-29 12:00:00',
      to: '2026-08-30 12:00:00',
    })
    expect(bindingsFor(tile('SELECT 1'), spec, now)).toEqual({})
  })
})
