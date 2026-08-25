/** Carrying a statement from the editor to whatever will keep it.
 *
 *  A query written in the editor and then retyped on the alerts page is a query
 *  that will differ from the one that was tested. So the editor hands it over
 *  instead, in the URL — the same convention the editor itself already uses for
 *  `/query?sql=…`, which means a handoff is linkable and survives a reload. */

export type Destination = 'alert' | 'report' | 'api'

export const DESTINATIONS: { id: Destination; label: string; path: string }[] = [
  { id: 'alert', label: 'an alert', path: '/alerts' },
  { id: 'report', label: 'a report', path: '/reports' },
  { id: 'api', label: 'an API', path: '/apis' },
]

export interface Handoff {
  sql: string
  database: string
  name: string
}

/** The path to navigate to, with the statement attached. */
export function handoffPath(destination: Destination, handoff: Handoff): string {
  const target = DESTINATIONS.find((d) => d.id === destination)
  if (!target) return '/'
  const params = new URLSearchParams()
  params.set('sql', handoff.sql)
  if (handoff.database) params.set('database', handoff.database)
  if (handoff.name) params.set('name', handoff.name)
  return `${target.path}?${params.toString()}`
}

/** Read a handoff back, or null when this is an ordinary visit.
 *
 *  A statement is the one thing that must be present: a name and a database are
 *  conveniences, and a handoff with neither is still a handoff. */
export function readHandoff(params: URLSearchParams): Handoff | null {
  const sql = params.get('sql')
  if (!sql || !sql.trim()) return null
  return {
    sql,
    database: params.get('database') ?? '',
    name: params.get('name') ?? '',
  }
}

/** A default name for something built out of a statement, when the editor tab
 *  had nothing better to offer. Deliberately dull: a name the reader will
 *  replace is better than one that looks deliberate and is not. */
export function suggestName(handoff: Handoff, fallback: string): string {
  const name = handoff.name.trim()
  if (name && name.toLowerCase() !== 'untitled') return name
  return fallback
}
