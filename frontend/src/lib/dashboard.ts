/** A dashboard's layout, and the small amount of arithmetic it needs.
 *
 *  The spec is stored as one JSON string, so parsing it is the boundary where a
 *  dashboard saved by an older Flint — or edited by hand — has to be made safe.
 *  Everything here is defensive on the way in and exact on the way out. */

import type { ChartKind, ChartSpec } from './chart'
import { declaredParams, declaredParamsTyped } from './publish'

export interface Tile {
  id: string
  title: string
  sql: string
  database: string
  /** Null renders the result as a table, which is always a valid answer. */
  chart: ChartSpec | null
  /** Width in grid columns, 1–12. */
  w: number
  /** Height in row units. */
  h: number
}

export interface DashboardSpec {
  tiles: Tile[]
  /** 0 = no automatic refresh. */
  refreshSeconds: number
  /** How far back every tile that asks for it should look, in hours. 0 = the
   *  dashboard sets no range and each tile decides for itself. */
  rangeHours: number
  /** A value for every other `{name:Type}` the tiles declare. Name to value, as
   *  strings, because that is what ClickHouse binds — it parses each one against
   *  the type the *statement* declared, which is what makes this safe. */
  variables: Record<string, string>
}

export const COLUMNS = 12
export const WIDTHS = [3, 4, 6, 8, 12] as const
export const REFRESH_CHOICES = [0, 10, 30, 60, 300] as const

export function emptySpec(): DashboardSpec {
  return { tiles: [], refreshSeconds: 0, rangeHours: 0, variables: {} }
}

/** The windows a dashboard can be set to, and `0` for none.
 *
 *  Relative rather than absolute, and only relative for now: a dashboard is a
 *  thing left open on a wall, and "the last seven days" is still true tomorrow
 *  where a pair of timestamps is not. An absolute window is a different feature
 *  and would need its own controls; leaving it out is a smaller lie than a date
 *  picker that quietly means "seven days from whenever you set it". */
export const RANGES: { hours: number; label: string }[] = [
  { hours: 0, label: 'No range' },
  { hours: 1, label: 'Last hour' },
  { hours: 24, label: 'Last 24 hours' },
  { hours: 24 * 7, label: 'Last 7 days' },
  { hours: 24 * 30, label: 'Last 30 days' },
  { hours: 24 * 90, label: 'Last 90 days' },
]

/** The two names a tile declares to follow the dashboard's range.
 *
 *  A convention rather than a rewrite. The alternative — Flint finding the time
 *  column and injecting a `WHERE` — means parsing SQL, which this codebase
 *  refuses to do and which would be wrong on the first statement with a subquery
 *  in it. A tile that wants the range says so in the language ClickHouse already
 *  gives it, and one that does not is left alone and *said* rather than silently
 *  ignored. */
export const RANGE_PARAMS = ['from', 'to'] as const

/** The window as ClickHouse's own `DateTime` literals, computed at the moment of
 *  asking so a dashboard left open keeps meaning what it says. */
export function rangeParams(hours: number, now = new Date()): Record<string, string> {
  if (hours <= 0) return {}
  const stamp = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ')
  return {
    from: stamp(new Date(now.getTime() - hours * 3_600_000)),
    to: stamp(now),
  }
}

/** Whether a statement asks for the dashboard's range. */
export function followsRange(sql: string): boolean {
  return declaredParams(sql).some((p) => (RANGE_PARAMS as readonly string[]).includes(p))
}

/** How many tiles the range reaches, in the words the product uses for every
 *  other fold: a control that changes six of nine tiles and says nothing about
 *  the other three is a control nobody can trust. */
export function saysRange(spec: DashboardSpec): string | null {
  if (spec.rangeHours <= 0) return null
  const following = spec.tiles.filter((t) => followsRange(t.sql)).length
  const label = RANGES.find((r) => r.hours === spec.rangeHours)?.label ?? `${spec.rangeHours} hours`
  if (spec.tiles.length === 0) return null
  if (following === spec.tiles.length) {
    return `${label.toLowerCase()}, on every tile.`
  }
  const rest = spec.tiles.length - following
  return `${label} — followed by ${following} of ${spec.tiles.length} tiles. The other ${
    rest === 1 ? 'one does' : `${rest} do`
  } not declare {from:DateTime}, so ${rest === 1 ? 'it reads' : 'they read'} whatever ${
    rest === 1 ? 'its' : 'their'
  } own statement says.`
}

const clamp = (n: unknown, lo: number, hi: number, fallback: number): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback
  return Math.min(hi, Math.max(lo, v))
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

/** Read a stored spec without trusting any of it. A tile with no SQL is
 *  dropped: it can never render, and keeping it only produces an empty card
 *  nobody can explain. */
export function parseSpec(raw: string): DashboardSpec {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return emptySpec()
  }
  if (!value || typeof value !== 'object') return emptySpec()
  const obj = value as Record<string, unknown>
  const tiles = Array.isArray(obj.tiles) ? obj.tiles : []

  return {
    refreshSeconds: clamp(obj.refreshSeconds, 0, 3600, 0),
    // Clamped to a window somebody chose rather than to any number: a stored
    // spec is not trusted, and a range of 9,000 hours would read as a bug.
    rangeHours: RANGES.some((r) => r.hours === obj.rangeHours) ? (obj.rangeHours as number) : 0,
    variables: readVariables(obj.variables),
    tiles: tiles
      .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object')
      .map((t, i) => ({
        id: str(t.id) || `tile-${i}`,
        title: str(t.title, 'Untitled'),
        sql: str(t.sql),
        database: str(t.database),
        chart: readChart(t.chart),
        w: clamp(t.w, 1, COLUMNS, 6),
        h: clamp(t.h, 1, 4, 1),
      }))
      .filter((t) => t.sql.trim().length > 0),
  }
}

/** Stored values, none of them trusted: anything that is not a string pair is
 *  dropped rather than coerced, because a variable that arrives as an object
 *  would be bound as `[object Object]` and fail somewhere far from here. */
function readVariables(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [name, v] of Object.entries(value as Record<string, unknown>)) {
    if (/^[A-Za-z0-9_]+$/.test(name) && typeof v === 'string') out[name] = v
  }
  return out
}

/** The kinds a stored tile may name.
 *
 *  Read off the union rather than written out a second time: a list here that
 *  drifts from `ChartKind` fails in the one direction nobody notices — an
 *  unrecognised kind falls through to `null`, and the tile comes back as a
 *  table with no error anywhere saying a chart was dropped. */
const KINDS: Record<ChartKind, true> = {
  stat: true,
  line: true,
  area: true,
  bar: true,
  donut: true,
  heatmap: true,
  scatter: true,
}

function readChart(value: unknown): ChartSpec | null {
  if (!value || typeof value !== 'object') return null
  const c = value as Record<string, unknown>
  const kind = str(c.kind)
  if (!Object.hasOwn(KINDS, kind)) return null
  const series = Array.isArray(c.series)
    ? c.series.filter((n): n is number => typeof n === 'number')
    : []
  if (series.length === 0) return null
  return {
    kind: kind as ChartSpec['kind'],
    x: typeof c.x === 'number' ? c.x : -1,
    // The heatmap's second axis, and only ever a real column index: a stored
    // `y` of -1 would send the grid looking for a column that is not there.
    ...(typeof c.y === 'number' && c.y >= 0 ? { y: c.y } : {}),
    series,
    why: str(c.why),
  }
}

export function serialiseSpec(spec: DashboardSpec): string {
  return JSON.stringify(spec)
}

export function addTile(spec: DashboardSpec, tile: Omit<Tile, 'id'>): DashboardSpec {
  return {
    ...spec,
    tiles: [...spec.tiles, { ...tile, id: crypto.randomUUID() }],
  }
}

export function removeTile(spec: DashboardSpec, id: string): DashboardSpec {
  return { ...spec, tiles: spec.tiles.filter((t) => t.id !== id) }
}

export function patchTile(spec: DashboardSpec, id: string, changes: Partial<Tile>): DashboardSpec {
  return { ...spec, tiles: spec.tiles.map((t) => (t.id === id ? { ...t, ...changes } : t)) }
}

/** Move a tile to a new index, clamped. Used by the drag handler and by the
 *  keyboard buttons, so both paths cannot disagree. */
export function moveTile(spec: DashboardSpec, id: string, to: number): DashboardSpec {
  const from = spec.tiles.findIndex((t) => t.id === id)
  if (from === -1) return spec
  const target = Math.min(spec.tiles.length - 1, Math.max(0, to))
  if (target === from) return spec
  const tiles = [...spec.tiles]
  const [moved] = tiles.splice(from, 1)
  tiles.splice(target, 0, moved!)
  return { ...spec, tiles }
}

/** Which zone a tile's dates are cut in, where that can be said with certainty.
 *
 *  A dashboard reader never sees a tile's SQL — only its chart and the database
 *  it came from — so a bar per day is a bar per *somebody's* day and the page
 *  is the only thing that can say whose. On a server in UTC read from Paris,
 *  every one of those days ends at two in the morning, and nothing on screen
 *  says so.
 *
 *  Three answers, and the middle one is the point:
 *
 *  - The statement carries `SETTINGS session_timezone`, which is what Flint's
 *    own builder writes: that zone, certainly.
 *  - The statement mentions a place anywhere — `toStartOfDay(ts, 'Oslo')`, or
 *    anything else that looks like one — and Flint says **nothing**. Guessing
 *    the server's zone here would print a confident sentence that is wrong,
 *    which is worse for a reader than an absent one. The test is deliberately
 *    over-eager for the same reason: it errs toward silence.
 *  - Otherwise nothing in the statement overrides the session, so the server's
 *    zone is the answer, and it is a fact rather than a guess.
 */
export function tileZone(sql: string, serverZone: string | undefined): string | undefined {
  const declared = /SETTINGS\s+session_timezone\s*=\s*'([^']+)'/i.exec(sql)
  if (declared) return declared[1]
  // Any quoted `Word/Word` — a zone named as a function argument, and also a
  // path or a URL, which is a false positive that costs a sentence rather than
  // making a wrong one.
  if (/'[^']*\w+\/\w+[^']*'/.test(sql)) return undefined
  return serverZone || undefined
}

/** Whether a result actually carries a date, which is what decides whether the
 *  zone is worth a word. A tile showing three counts has a timezone the way it
 *  has a row limit — true, and not what its reader needs told. */
export function carriesDates(types: string[]): boolean {
  return types.some((t) => t.includes('Date'))
}

/** Every `{name:Type}` the tiles declare, apart from the two the range owns.
 *
 *  Collected from the statements rather than declared beside them, for the same
 *  reason the page index is read from the page: a list somebody maintains by
 *  hand drifts from the thing it lists, and here the drift is silent until a
 *  tile fails with `UNKNOWN_QUERY_PARAMETER`. */
export function declaredVariables(spec: DashboardSpec): Variable[] {
  const by = new Map<string, Variable>()
  for (const tile of spec.tiles) {
    for (const { name, type } of declaredParamsTyped(tile.sql)) {
      if ((RANGE_PARAMS as readonly string[]).includes(name)) continue
      const found = by.get(name) ?? { name, types: [], usedBy: [] }
      if (!found.types.includes(type)) found.types.push(type)
      found.usedBy.push(tile.title)
      by.set(name, found)
    }
  }
  return [...by.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
}

export interface Variable {
  name: string
  /** The type each tile declared it with. More than one means the tiles disagree
   *  about what this is, and one bound string cannot satisfy both. */
  types: string[]
  /** The tiles that ask for it, by title. */
  usedBy: string[]
}

/** What will go wrong before anything is run.
 *
 *  Both of these were produced against a real server before they were written.
 *  An unset parameter is not an empty result — ClickHouse answers
 *  `Substitution 'region' is not set` and the tile shows an error where a reader
 *  expects data. And a name declared as two types takes one bound string for
 *  both: `{n:String}` accepts `eu-west` while `{n:UInt8}` beside it answers
 *  `Value eu-west cannot be parsed as UInt8`, so half the dashboard breaks on a
 *  value the other half is happy with. */
export function variableIssues(spec: DashboardSpec): string[] {
  const out: string[] = []
  for (const v of declaredVariables(spec)) {
    if (v.types.length > 1) {
      out.push(
        `\`${v.name}\` is declared as ${v.types.join(' and ')} by different tiles. One value has to satisfy both, and most values will not.`,
      )
    }
    const value = spec.variables[v.name]
    if (value === undefined || value === '') {
      const n = v.usedBy.length
      out.push(
        `\`${v.name}\` has no value, so ${n === 1 ? 'the tile' : `all ${n} tiles`} that ${n === 1 ? 'asks' : 'ask'} for it will fail rather than come back empty.`,
      )
    }
  }
  return out
}

/** Everything to bind for one tile: the window where it asks for one, and every
 *  variable it declares. Per tile rather than one map for the dashboard, so a
 *  tile is never sent a value it did not ask for. */
export function bindingsFor(
  tile: Tile,
  spec: DashboardSpec,
  now = new Date(),
): Record<string, string> {
  const declared = new Set(declaredParams(tile.sql))
  const out: Record<string, string> = {}
  if (followsRange(tile.sql)) Object.assign(out, rangeParams(spec.rangeHours, now))
  for (const [name, value] of Object.entries(spec.variables)) {
    if (declared.has(name)) out[name] = value
  }
  return out
}
