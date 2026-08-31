/** Infrastructure, in one screen: is anything wrong.
 *
 *  Arriving at `/infra` used to mean arriving at Health, which is the busiest
 *  page in the product — ten sections of running queries, merges, disks, errors
 *  and logs. That is the right page for *working on* the server and the wrong one
 *  for finding out whether you need to. This is one row per section, each
 *  carrying the figure that makes it checkable, and a link to the page that has
 *  the detail.
 *
 *  **The rule that shapes every row: a thing that could not be read is not
 *  fine.** A status board that shows green for a section whose grant was denied,
 *  or whose request failed, is worse than no board — it is a board that lies in
 *  exactly the situation somebody built it for. So `unknown` is a first-class
 *  standing, it carries the server's own reason, and nothing in here can produce
 *  `ok` from an absence.
 *
 *  And quiet is the good answer. A row with nothing to report states its fact
 *  plainly and stops; it does not celebrate. An indicator that is always lit is
 *  not an indicator, which is a rule this codebase already keeps for its
 *  attention badges. */

import type { Level } from './diagnose'
import type { Section } from './spaces'

/** What a row can be. `Level` is the product's existing vocabulary — `ok`,
 *  `watch`, `delay`, `throw` — and these two are what a *board* needs beyond it:
 *  a section still being fetched, and one that could not be read at all. */
export type Standing = Level | 'reading' | 'unknown'

export interface Row {
  id: string
  label: string
  to: string
  standing: Standing
  /** One sentence: the fact, with the figure that lets somebody check it. */
  says: string
}

/** What the page knows about one section: the answer, a failure, or neither
 *  yet. Deliberately not react-query's shape — the rules below are the part
 *  worth testing, and they should not need a query client to exercise. */
export interface Reading<T> {
  data?: T
  /** Why the request itself failed, where it did. */
  failed?: string
  pending?: boolean
}

/** A report that says whether it could be produced. Nearly every Flint endpoint
 *  answers in this shape, which is what makes the rule below general. */
interface Answerable {
  available?: boolean
  reason?: string
}

/** The standing of a section that could not answer, or `null` where it did.
 *
 *  Three ways to not know, and they are not the same: the request never
 *  finished, the request failed, or the server answered "I cannot tell you".
 *  Only the last has a reason worth printing, and none of the three is `ok`. */
export function unread<T extends Answerable>(r: Reading<T>, what: string): Row['says'] | null {
  if (r.pending && !r.data) return `reading ${what}…`
  if (r.failed) return `${what} could not be read: ${r.failed}`
  if (!r.data) return `${what} could not be read`
  if (r.data.available === false) {
    return r.data.reason ? `${r.data.reason}` : `${what} is not available on this server`
  }
  return null
}

export function standingOf<T extends Answerable>(r: Reading<T>): Standing | null {
  if (r.pending && !r.data) return 'reading'
  if (r.failed || !r.data) return 'unknown'
  if (r.data.available === false) return 'unknown'
  return null
}

/** The worst of several levels, in the order the product already ranks them. */
export function worst(levels: readonly Level[]): Level {
  const rank: Record<Level, number> = { ok: 0, watch: 1, delay: 2, throw: 3 }
  return levels.reduce((acc, l) => (rank[l] > rank[acc] ? l : acc), 'ok' as Level)
}

/** Build a row for a section, from whatever the page managed to read.
 *
 *  `read` is only consulted where the section answered: the unread cases are
 *  decided above it, once, so no section can accidentally grow its own idea of
 *  what "not available" means. */
export function row<T extends Answerable>(
  section: Section,
  what: string,
  reading: Reading<T>,
  read: (data: T) => { standing: Level; says: string },
): Row {
  const missing = standingOf(reading)
  if (missing) {
    return {
      id: section.id,
      label: section.label,
      to: section.to,
      standing: missing,
      says: unread(reading, what) ?? `${what} could not be read`,
    }
  }
  const { standing, says } = read(reading.data as T)
  return { id: section.id, label: section.label, to: section.to, standing, says }
}

/** How the board reads as a whole: the count of rows that want attention, or
 *  null when none do — which is the common case and the one that should not be
 *  dressed up. `unknown` counts, because not knowing is the thing this page
 *  exists to surface. */
export function headline(rows: readonly Row[]): string | null {
  const loud = rows.filter((r) => r.standing === 'throw' || r.standing === 'delay')
  const watch = rows.filter((r) => r.standing === 'watch')
  const blind = rows.filter((r) => r.standing === 'unknown')
  const parts: string[] = []
  if (loud.length) parts.push(`${loud.length} needing attention`)
  if (watch.length) parts.push(`${watch.length} worth a look`)
  if (blind.length) {
    parts.push(`${blind.length} that could not be read`)
  }
  return parts.length ? parts.join(', ') : null
}
