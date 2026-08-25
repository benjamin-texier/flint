/** Reports, as the UI sees them.
 *
 *  A dashboard shows now; a report keeps then. That difference is the whole
 *  feature, and it is why a run is a stored snapshot rather than a link back to
 *  a live query: re-running it next month would answer next month's question. */

import type { ChartSpec } from './chart'
import { splitStatements } from './sql'

export type Schedule =
  | { kind: 'every'; hours: number }
  | { kind: 'daily'; minute: number }
  | { kind: 'weekly'; dow: number; minute: number }

export interface Section {
  title: string
  sql: string
  database: string
  chart?: ChartSpec | null
}

export interface Report {
  id: string
  name: string
  spec: string
  schedule: string
  webhook: string
  enabled: boolean
  created_at: string
  updated_at: string
  last_run: string
  last_status: string
  runs: number
}

export interface ReportRun {
  run_id: string
  report_id: string
  report: string
  at: string
  status: string
  error: string
  delivered: boolean
  delivery_error: string
  sections: number
}

export interface SectionResult {
  title: string
  sql: string
  columns: { name: string; type: string }[]
  rows: unknown[][]
  truncated: boolean
  error: string
  chart?: ChartSpec | null
}

export interface Snapshot {
  run_id: string
  report_id: string
  report: string
  at: string
  status: string
  error: string
  /** JSON; parse with `parseSections`. */
  sections: string
}

export const DAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const

/** The intervals worth offering for an interval schedule. */
export const EVERY_HOURS = [1, 3, 6, 12, 24] as const

export function serialiseSchedule(s: Schedule): string {
  return JSON.stringify(s)
}

/** Null when the stored schedule cannot be read, so the UI can say the report
 *  is broken rather than showing a plausible default it will not honour. */
export function parseSchedule(raw: string): Schedule | null {
  try {
    const d = JSON.parse(raw) as Partial<Schedule> & { kind?: string }
    if (d.kind === 'every') {
      const hours = (d as { hours?: unknown }).hours
      return typeof hours === 'number' && hours >= 1 && hours <= 720 ? { kind: 'every', hours } : null
    }
    if (d.kind === 'daily') {
      const minute = (d as { minute?: unknown }).minute
      return typeof minute === 'number' && minute >= 0 && minute < 1440
        ? { kind: 'daily', minute }
        : null
    }
    if (d.kind === 'weekly') {
      const { dow, minute } = d as { dow?: unknown; minute?: unknown }
      return typeof dow === 'number' &&
        dow >= 1 &&
        dow <= 7 &&
        typeof minute === 'number' &&
        minute >= 0 &&
        minute < 1440
        ? { kind: 'weekly', dow, minute }
        : null
    }
    return null
  } catch {
    return null
  }
}

export function clockOf(minute: number): string {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function minuteOf(clock: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** The schedule as a sentence. The server's timezone is named because a report
 *  due at nine is due at nine *somewhere*, and guessing which is how a morning
 *  summary arrives in the afternoon. */
export function describeSchedule(s: Schedule, timezone?: string): string {
  const where = timezone ? ` (${timezone})` : ''
  if (s.kind === 'every') {
    return s.hours === 1 ? 'Every hour' : `Every ${s.hours} hours`
  }
  if (s.kind === 'daily') return `Every day at ${clockOf(s.minute)}${where}`
  return `Every ${DAYS[s.dow - 1]} at ${clockOf(s.minute)}${where}`
}

/** Read a stored snapshot defensively.
 *
 *  A snapshot is data written by an *older* Flint, and it will outlive the code
 *  that wrote it — six months of them, by design. So every field is checked and
 *  repaired rather than trusted: an early version kept column names as bare
 *  strings, and handing one of those to the grid crashed the whole page, taking
 *  the app down over a record from March. A snapshot Flint cannot fully
 *  understand must still render as much of itself as it can. */
export function parseSections(raw: string): SectionResult[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  return parsed.flatMap((item): SectionResult[] => {
    if (!item || typeof item !== 'object') return []
    const s = item as Record<string, unknown>
    const rows = Array.isArray(s.rows) ? (s.rows.filter(Array.isArray) as unknown[][]) : []
    return [
      {
        title: typeof s.title === 'string' ? s.title : '',
        sql: typeof s.sql === 'string' ? s.sql : '',
        columns: normaliseColumns(s.columns),
        rows,
        truncated: s.truncated === true,
        error: typeof s.error === 'string' ? s.error : '',
        chart: (s.chart ?? null) as SectionResult['chart'],
      },
    ]
  })
}

/** Columns as `{name, type}`, whatever shape they were stored in. The type is
 *  only used to pick a width and a colour, so an unknown one is empty rather
 *  than a guess. */
function normaliseColumns(raw: unknown): { name: string; type: string }[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((c): { name: string; type: string }[] => {
    if (typeof c === 'string') return [{ name: c, type: '' }]
    if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>
      const name = typeof o.name === 'string' ? o.name : ''
      const type = typeof o.type === 'string' ? o.type : ''
      return name ? [{ name, type }] : []
    }
    return []
  })
}

export type Status = 'ok' | 'partial' | 'failed' | 'skipped' | 'none'

export function statusOf(raw: string): Status {
  if (raw === 'ok' || raw === 'partial' || raw === 'failed' || raw === 'skipped') return raw
  return 'none'
}

export const STATUS_LABEL: Record<Status, string> = {
  ok: 'Complete',
  // Named, not rounded: a report where two of five sections failed is neither
  // fine nor useless, and both roundings mislead.
  partial: 'Ran with gaps',
  failed: 'Failed',
  skipped: 'Skipped',
  none: 'Never run',
}

/** Maps a report status onto the flag tones the app already has. */
export const STATUS_TONE: Record<Status, string> = {
  ok: 'ok',
  partial: 'error',
  failed: 'firing',
  skipped: 'idle',
  none: 'idle',
}

/** A dashboard's tiles, as report sections.
 *
 *  The two are nearly the same thing said about different moments: a tile is a
 *  statement and a chart shown now, a section is the same statement and chart
 *  kept. So a dashboard someone already arranged is the best possible starting
 *  point for a report, and retyping it would only introduce differences.
 *
 *  Tiles with no statement are dropped, matching how the dashboard itself reads
 *  its layout — a report built from a broken tile would fail a section for a
 *  reason that has nothing to do with the report. */
export function sectionsFromDashboard(tiles: {
  title: string
  sql: string
  database: string
  chart: ChartSpec | null
}[]): Section[] {
  return tiles
    .filter((t) => t.sql.trim())
    .map((t) => ({
      title: t.title,
      sql: t.sql,
      database: t.database,
      chart: t.chart,
    }))
}

/** A saved query, as a report section.
 *
 *  The other half of the same idea. A dashboard is a report someone already
 *  arranged; a saved query is a *question* someone already named and tested, and
 *  a report is mostly a handful of those asked on a schedule. Retyping one into
 *  a section is how a report comes to differ from the query it was supposed to
 *  keep.
 *
 *  A saved query may hold several statements — the editor runs the one under the
 *  cursor, so nothing stopped anybody saving a buffer with three. A section is
 *  one statement, so this returns one section per statement rather than one
 *  section that will fail at run time, and numbers them after the first so the
 *  reader can see what was unpacked. */
export function sectionsFromSaved(query: { name: string; sql: string; database: string }): Section[] {
  const statements = splitStatements(query.sql).filter((s) => s.sql.trim())
  // A comment-only query comes across as it was saved rather than blanked: the
  // section's own check panel will say it is not a statement, which is more use
  // than a section that arrived mysteriously empty. Only a buffer with nothing
  // in it at all takes this branch, and it needs one section so that pressing
  // the button visibly does something.
  if (statements.length === 0) {
    return [{ title: query.name, sql: '', database: query.database, chart: null }]
  }
  return statements.map((statement, i) => ({
    title: statements.length > 1 ? `${query.name} (${i + 1})` : query.name,
    sql: statement.sql.trim(),
    database: query.database,
    chart: null,
  }))
}

export function problemWithReport(input: { name: string; sections: Section[] }): string | null {
  if (!input.name.trim()) return 'Give the report a name.'
  if (!input.sections.some((s) => s.sql.trim())) {
    return 'A report needs at least one section with a statement.'
  }
  return null
}

/** Shape a stored section back into what the chart and table components read,
 *  so a snapshot renders through exactly the same code a live result does. */
export function asResult(section: SectionResult) {
  return {
    query_id: '',
    columns: section.columns,
    rows: section.rows as never,
    truncated: section.truncated,
    rows_before_limit_at_least: null,
    statistics: { elapsed: 0, rows_read: 0, bytes_read: 0 },
    summary: {},
    kind: 'read' as const,
  }
}
