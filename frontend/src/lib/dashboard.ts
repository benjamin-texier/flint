/** A dashboard's layout, and the small amount of arithmetic it needs.
 *
 *  The spec is stored as one JSON string, so parsing it is the boundary where a
 *  dashboard saved by an older Flint — or edited by hand — has to be made safe.
 *  Everything here is defensive on the way in and exact on the way out. */

import type { ChartSpec } from './chart'

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
}

export const COLUMNS = 12
export const WIDTHS = [3, 4, 6, 8, 12] as const
export const REFRESH_CHOICES = [0, 10, 30, 60, 300] as const

export function emptySpec(): DashboardSpec {
  return { tiles: [], refreshSeconds: 0 }
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

function readChart(value: unknown): ChartSpec | null {
  if (!value || typeof value !== 'object') return null
  const c = value as Record<string, unknown>
  const kind = str(c.kind)
  if (!['stat', 'line', 'bar', 'scatter'].includes(kind)) return null
  const series = Array.isArray(c.series)
    ? c.series.filter((n): n is number => typeof n === 'number')
    : []
  if (series.length === 0) return null
  return {
    kind: kind as ChartSpec['kind'],
    x: typeof c.x === 'number' ? c.x : -1,
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
