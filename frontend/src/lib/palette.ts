/** One place to type a name and get to the thing.
 *
 *  A rail filter finds a table in the database you are already looking at. On a
 *  server with forty databases that is the wrong question — you know the name,
 *  not where it lives. This searches everything Flint knows about at once:
 *  databases, tables, views, columns, and the things Flint itself keeps.
 *
 *  The ranking is deliberately plain and deterministic. Fuzzy matching feels
 *  clever and puts the wrong row first; a name you typed exactly should win,
 *  then a name that starts with it, then a name that contains it. */

export type Kind =
  | 'database'
  | 'table'
  | 'view'
  | 'column'
  | 'saved'
  | 'dashboard'
  | 'report'
  | 'alert'
  | 'api'
  | 'page'

export interface Entry {
  kind: Kind
  /** What is matched and shown. */
  label: string
  /** Where it lives, shown beside the label — a column's table, a table's
   *  database. Not matched: matching it would make every column of `events`
   *  a hit for "events". */
  context?: string
  /** Where selecting it goes. */
  to: string
}

export interface Hit extends Entry {
  score: number
}

/** How much each kind is worth before the match quality is considered.
 *
 *  A table outranks one of its own columns for the same word, because someone
 *  typing `events` almost always wants the table. Pages come last: they are
 *  always reachable and never the surprising answer. */
const WEIGHT: Record<Kind, number> = {
  table: 60,
  view: 55,
  database: 50,
  saved: 40,
  dashboard: 36,
  report: 32,
  alert: 32,
  api: 32,
  column: 20,
  page: 8,
}

export const KIND_LABEL: Record<Kind, string> = {
  database: 'database',
  table: 'table',
  view: 'view',
  column: 'column',
  saved: 'saved query',
  dashboard: 'dashboard',
  report: 'report',
  alert: 'alert',
  api: 'API',
  page: 'page',
}

/** Where a name breaks: a match starting after one of these counts as starting
 *  at a word, which is why `events` finds `analytics.events` and `raw_events`. */
const BOUNDARY = /[._\- /]/

function quality(label: string, query: string): number {
  const l = label.toLowerCase()
  const q = query.toLowerCase()
  if (l === q) return 1000
  const at = l.indexOf(q)
  if (at < 0) return 0
  if (at === 0) return 600
  if (BOUNDARY.test(l[at - 1] ?? '')) return 400
  return 200
}

/** Rank the entries against a query. Empty query yields nothing: a palette
 *  that shows everything before you type is a list, not a search.
 *
 *  Two rules beyond the scoring, both learned from looking at real results.
 *
 *  *One row per destination.* A column's route is its table's route, so a table
 *  and its own matching column are the same suggestion twice; the better of the
 *  two wins and the other disappears.
 *
 *  *Objects before columns, always.* Searching `events` on a real schema found
 *  seven columns named `events` in seven rollup tables and pushed the view
 *  `events_by_region` off the list. You typed a name, and names are what
 *  objects have — a column match is a way to reach a table you did not name,
 *  which is useful and is never the first answer. */
export function search(entries: readonly Entry[], query: string, limit = 40): Hit[] {
  const q = query.trim()
  if (!q) return []

  const best = new Map<string, Hit>()
  for (const entry of entries) {
    const base = quality(entry.label, q)
    if (base === 0) continue
    // Shorter names win ties: `events` should beat `events_by_region`.
    const brevity = Math.max(0, 30 - entry.label.length) / 10
    const hit: Hit = { ...entry, score: base + WEIGHT[entry.kind] + brevity }
    const key = dedupeKey(entry)
    const held = best.get(key)
    if (!held || rank(hit) < rank(held)) best.set(key, hit)
  }

  return [...best.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)).slice(0, limit)
}

/** Lower is better. The column tier is separate rather than a weight, so no
 *  amount of match quality can lift a column above an object. */
function rank(hit: Hit): number {
  return (hit.kind === 'column' ? 1_000_000 : 0) - hit.score
}

/** Schema objects are one row per destination — a table and its own matching
 *  column go to the same place, so they are one suggestion. Everything else
 *  keys on its name too, because every report shares the route `/reports` and
 *  collapsing them would leave one.  */
const SCHEMA: ReadonlySet<Kind> = new Set(['database', 'table', 'view', 'column'])

function dedupeKey(entry: Entry): string {
  return SCHEMA.has(entry.kind) ? `obj:${entry.to}` : `${entry.kind}:${entry.to}:${entry.label}`
}

const INTERNAL = new Set(['system', 'INFORMATION_SCHEMA', 'information_schema'])

export interface Sources {
  schema?: { database: string; table: string; columns: string[]; kind?: string }[]
  saved?: { id: string; name: string; sql: string; database: string }[]
  dashboards?: { id: string; name: string }[]
  reports?: { id: string; name: string }[]
  alerts?: { id: string; name: string }[]
  apis?: { id: string; name: string; slug: string }[]
}

export const PAGES: Entry[] = [
  { kind: 'page', label: 'Home', to: '/home' },
  { kind: 'page', label: 'Explore', to: '/' },
  { kind: 'page', label: 'Query', to: '/query' },
  /* The form is a mode of the query page rather than a page of its own, and
     `Build` is still what people type to look for it. */
  { kind: 'page', label: 'Build', to: '/query?mode=build' },
  { kind: 'page', label: 'Dashboards', to: '/dash' },
  { kind: 'page', label: 'Diagnose', to: '/diagnose' },
  { kind: 'page', label: 'Alerts', to: '/alerts' },
  { kind: 'page', label: 'Reports', to: '/reports' },
  { kind: 'page', label: 'APIs', to: '/apis' },
  { kind: 'page', label: 'Server', to: '/server' },
]

/** Everything searchable, flattened once.
 *
 *  ClickHouse's own databases are left out unless nothing else matches — they
 *  hold thousands of columns, and a palette where `name` returns forty rows of
 *  `system.columns` has buried the answer. */
export function buildEntries(sources: Sources): Entry[] {
  const entries: Entry[] = [...PAGES]
  const seenDatabase = new Set<string>()

  for (const t of sources.schema ?? []) {
    if (INTERNAL.has(t.database)) continue
    const path = `/db/${encodeURIComponent(t.database)}/${encodeURIComponent(t.table)}`
    if (!seenDatabase.has(t.database)) {
      seenDatabase.add(t.database)
      entries.push({
        kind: 'database',
        label: t.database,
        to: `/db/${encodeURIComponent(t.database)}`,
      })
    }
    entries.push({
      // A view called a table is a small lie in a tool whose whole job is
      // saying what things are.
      kind: t.kind && t.kind !== 'table' ? 'view' : 'table',
      label: t.table,
      context: t.database,
      to: path,
    })
    for (const column of t.columns) {
      entries.push({
        kind: 'column',
        label: column,
        context: `${t.database}.${t.table}`,
        to: path,
      })
    }
  }

  for (const s of sources.saved ?? []) {
    entries.push({
      kind: 'saved',
      label: s.name,
      context: s.database || undefined,
      to: `/query?sql=${encodeURIComponent(s.sql)}${
        s.database ? `&database=${encodeURIComponent(s.database)}` : ''
      }`,
    })
  }
  for (const d of sources.dashboards ?? []) {
    entries.push({ kind: 'dashboard', label: d.name, to: `/dash/${encodeURIComponent(d.id)}` })
  }
  for (const r of sources.reports ?? []) {
    entries.push({ kind: 'report', label: r.name, to: '/reports' })
  }
  for (const a of sources.alerts ?? []) {
    entries.push({ kind: 'alert', label: a.name, to: '/alerts' })
  }
  for (const a of sources.apis ?? []) {
    entries.push({ kind: 'api', label: a.name, context: `/api/data/${a.slug}`, to: '/apis' })
  }
  return entries
}
