/** Data's home, as arithmetic.
 *
 *  Infrastructure has had a board since `/infra` stopped redirecting to Health:
 *  one row per section, each carrying the figure that says whether to go there.
 *  Data had nothing of the kind — its space link landed on a database, which
 *  answers "what is on this server" and not "what is this workspace for".
 *
 *  This is the other question. Deliberately **not** an inventory of the server:
 *  Flint opens on a database and always has (see `App`), and a second screen
 *  listing databases would be the inventory screen that decision exists to
 *  avoid. What is inventoried here is what *Flint itself keeps* — the saved
 *  statements, the endpoints serving them, the dashboards and alerts built on
 *  them. That is why the whole page needs a workspace and is absent without
 *  one: with nothing kept there is nothing here to say.
 *
 *  Everything below is a pure function over what the API already returns. No
 *  endpoint was added for this page, which is the constraint that decided most
 *  of its content: where a figure does not exist on the wire it is not on the
 *  screen either. */

import type { Dashboard, SavedQuery } from './api'
import type { ApiUsage, UsageReport } from './diagnose'
import type { Published } from './publish'
import { parseSpec } from './dashboard'

/** A statement, reduced to what makes two of them the same question.
 *
 *  Whitespace and a trailing semicolon only. **Case is kept**, which is the
 *  choice worth defending: folding it would let `city = 'Paris'` and
 *  `city = 'paris'` count as one statement, and those are two different
 *  questions with two different answers. Keyword case surviving a copy-paste is
 *  the common case; a literal changing case is the one that would produce a
 *  claim that is simply false.
 *
 *  So this matches *copies*, not rewrites — which is exactly the claim the page
 *  makes with it ("where the same statement also runs"), and never a stronger
 *  one about dependency. A statement published and then edited stops matching,
 *  and the honest reading of that is "these are now two statements". */
export function statementKey(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;+$/, '')
    .trim()
}

/** Where else a saved statement's text is running. */
export interface Reach {
  /** The slugs of endpoints publishing this exact statement. */
  endpoints: string[]
  /** How many dashboard tiles run it. */
  tiles: number
}

const EMPTY: Reach = { endpoints: [], tiles: 0 }

/** For each saved statement, what else runs it.
 *
 *  Keyed by statement text rather than by id because nothing on the wire links
 *  them: an endpoint carries its own `sql`, a tile carries its own `sql`, and
 *  neither records the saved statement it was copied from. Inferring the link
 *  is the same bargain the schema graph makes with its edges — useful, stated
 *  as an inference, never dressed up as a foreign key. */
export function reachOf(
  saved: readonly SavedQuery[],
  endpoints: readonly Published[],
  dashboards: readonly Dashboard[],
): Map<string, Reach> {
  const bySql = new Map<string, Reach>()
  const at = (sql: string): Reach => {
    const key = statementKey(sql)
    const found = bySql.get(key)
    if (found) return found
    const fresh: Reach = { endpoints: [], tiles: 0 }
    bySql.set(key, fresh)
    return fresh
  }

  for (const endpoint of endpoints) at(endpoint.sql).endpoints.push(endpoint.slug)
  for (const dashboard of dashboards) {
    for (const tile of parseSpec(dashboard.spec).tiles) at(tile.sql).tiles += 1
  }

  const byId = new Map<string, Reach>()
  for (const statement of saved) {
    byId.set(statement.id, bySql.get(statementKey(statement.sql)) ?? EMPTY)
  }
  return byId
}

/** One clause for what a statement feeds. Empty reach is a sentence too — a
 *  statement nobody has built on is the most interesting row in the list, and
 *  leaving it blank would hide the only thing there is to say about it. */
export function describeReach(reach: Reach | undefined): string {
  const parts: string[] = []
  const served = reach?.endpoints.length ?? 0
  const tiles = reach?.tiles ?? 0
  if (served) parts.push(`serves ${served} endpoint${served === 1 ? '' : 's'}`)
  if (tiles) parts.push(`${tiles} tile${tiles === 1 ? '' : 's'}`)
  return parts.length ? parts.join(' · ') : 'nowhere else'
}

/** How many of these run nowhere but here. For the line under the list: a cap
 *  that states what it left out, and the one count on this page somebody might
 *  act on. */
export function countUnreached(
  saved: readonly SavedQuery[],
  reach: Map<string, Reach>,
): number {
  return saved.filter((s) => {
    const r = reach.get(s.id)
    return !r || (r.endpoints.length === 0 && r.tiles === 0)
  }).length
}

/** The statements most recently worked on.
 *
 *  `updated_at` and not `created_at`: the list answers "what is being worked
 *  on", and a statement saved a year ago and edited this morning is being
 *  worked on. Sorted on the stored string, which ClickHouse writes as
 *  `YYYY-MM-DD hh:mm:ss` — lexicographic order is chronological order in that
 *  format, and parsing a date to sort it would only add a way to fail. */
export function recentlyTouched(saved: readonly SavedQuery[], cap: number): SavedQuery[] {
  return [...saved].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).slice(0, cap)
}

/** An endpoint with whatever the query log knows about it. */
export interface Served {
  endpoint: Published
  /** Absent where the log is off, and where it is on but this endpoint has not
   *  been called in the window. The page says which. */
  usage: ApiUsage | undefined
}

/** Live endpoints, busiest first.
 *
 *  Disabled ones are left out entirely rather than listed at zero: this block
 *  is about traffic being served, and an endpoint that is switched off is not
 *  serving any — it belongs on the page that can switch it back on.
 *
 *  Where the log cannot be read, every endpoint comes back with no usage and
 *  the order falls back to the name. A list silently sorted by nothing would be
 *  a list claiming these are the busiest. */
export function busiest(
  endpoints: readonly Published[],
  usage: UsageReport | undefined,
  cap: number,
): Served[] {
  const index = new Map((usage?.available ? usage.usage : []).map((u) => [u.slug, u]))
  return endpoints
    .filter((e) => e.enabled)
    .map((endpoint) => ({ endpoint, usage: index.get(endpoint.slug) }))
    .sort((a, b) => {
      const calls = (b.usage?.calls ?? -1) - (a.usage?.calls ?? -1)
      return calls !== 0 ? calls : a.endpoint.slug < b.endpoint.slug ? -1 : 1
    })
    .slice(0, cap)
}

/** The usage report, narrowed to the endpoints that still exist.
 *
 *  A slug outlives its endpoint: the query log keeps the calls for as long as
 *  its own TTL says, and deleting the endpoint does not — cannot — take them out
 *  of it. So the raw report carries rows for addresses that are now 404s, and on
 *  a workspace that has been worked in for a while they are the loudest rows in
 *  it. Beside "4 endpoints live" that is a total nobody can reconcile with
 *  anything on the page, and in a list of what needs attention it is a name with
 *  nowhere to go.
 *
 *  Undefined until the endpoint list has arrived, deliberately: with an empty
 *  list this would narrow the report to nothing and quietly claim no traffic. */
export function trafficOf(
  usage: UsageReport | undefined,
  endpoints: readonly Published[] | undefined,
): UsageReport | undefined {
  if (!usage || !endpoints) return undefined
  const known = new Set(endpoints.map((e) => e.slug))
  return { ...usage, usage: usage.usage.filter((u) => known.has(u.slug)) }
}

/** Calls served in the window. Null where the log could not be read — which is
 *  not zero, and must not be shown as zero. */
export function callsServed(usage: UsageReport | undefined): number | null {
  if (!usage?.available) return null
  return usage.usage.reduce((total, u) => total + u.calls, 0)
}
