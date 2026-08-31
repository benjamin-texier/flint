/** Quotas, settings profiles and row policies — how much, and which rows.
 *
 *  The logic here is mostly about saying what a configuration *means*, because
 *  none of these three tables mean what they look like. A quota's ceiling is per
 *  account or shared depending on a `keys` column three fields away; a profile
 *  is attached from either end and the stock one is attached from the end nobody
 *  reads; and row policies compose by a rule that is easy to state backwards.
 */

export type Unit = 'count' | 'bytes' | 'seconds'

export interface Ceiling {
  dimension: string
  unit: Unit
  max: number
  /** Absent where the interval has not started, or usage could not be read. */
  used?: number
}

export interface Interval {
  duration_secs: number
  randomized: boolean
  ceilings: Ceiling[]
}

export interface Quota {
  name: string
  storage: string
  keys: string[]
  apply_to_all: boolean
  apply_to_list: string[]
  apply_to_except: string[]
  intervals: Interval[]
}

export interface Consumption {
  quota_name: string
  quota_key: string
  duration_secs: number
  start_time: string
  end_time: string
  ceilings: Ceiling[]
}

export interface ProfileSetting {
  setting: string
  value: string
  min: string
  max: string
  writability: string
}

export interface Profile {
  name: string
  storage: string
  apply_to_all: boolean
  apply_to_list: string[]
  apply_to_except: string[]
  settings: ProfileSetting[]
  inherits: string[]
  attached_by_account: string[]
}

export interface Pinned {
  holder: string
  is_user: boolean
  settings: ProfileSetting[]
}

export interface RowPolicy {
  name: string
  short_name: string
  database: string
  table: string
  storage: string
  filter: string
  restrictive: boolean
  apply_to_all: boolean
  apply_to_list: string[]
  apply_to_except: string[]
}

export interface Section<T> {
  items: T[]
  /** Present only when the list is empty for a reason. */
  blocked?: string
}

export interface LimitsReport {
  quotas: Section<Quota>
  usage_scope: 'everyone' | 'you'
  usage: Section<Consumption>
  profiles: Section<Profile>
  pinned: Section<Pinned>
  policies: Section<RowPolicy>
}

interface Applicable {
  apply_to_all: boolean
  apply_to_list: string[]
  apply_to_except: string[]
}

/** Who a quota, profile or policy applies to, in one phrase.
 *
 *  Three fields encode it and only one combination is common, so reading them
 *  raw is a small puzzle every time. `apply_to_all` with an `except` list is the
 *  one worth spelling out: it is the shape that catches an account somebody
 *  added last week and forgot to exempt.
 */
export function appliesTo(x: Applicable): string {
  if (x.apply_to_all) {
    return x.apply_to_except.length
      ? `everyone except ${x.apply_to_except.join(', ')}`
      : 'everyone'
  }
  return x.apply_to_list.length ? x.apply_to_list.join(', ') : 'nobody'
}

/** Whether anybody is subject to this at all. */
export function appliesToNobody(x: Applicable): boolean {
  return !x.apply_to_all && x.apply_to_list.length === 0
}

/** Whether a quota's ceilings are per account or shared between them.
 *
 *  The difference between "sixty queries each" and "sixty queries between you",
 *  which the `keys` column decides and nothing on the screen otherwise shows.
 */
export function countedPer(quota: Quota): string {
  if (quota.keys.length === 0) return 'shared by everyone it applies to'
  return `counted per ${quota.keys.map((k) => k.replace(/_/g, ' ')).join(' and ')}`
}

/** The window a quota's ceilings apply over, as a person would say it. */
export function window(seconds: number): string {
  const units: [number, string][] = [
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ]
  for (const [size, name] of units) {
    if (seconds % size === 0 && seconds >= size) {
      const n = seconds / size
      return n === 1 ? `every ${name}` : `every ${n} ${name}s`
    }
  }
  return `every ${seconds} seconds`
}

/** How full something is against its ceiling, 0 to 1 — or null where there is
 *  nothing to measure.
 *
 *  The primitive, shared with the Health page's "right now" gauges: those are a
 *  different shape but the same question, and two copies of the arithmetic would
 *  eventually be two copies of the *thresholds*, which is the part that must not
 *  differ between two screens showing the same kind of bar.
 */
export function fullnessOf(used: number | undefined, max: number): number | null {
  if (used === undefined || max <= 0) return null
  return Math.min(1, used / max)
}

/** How full a ceiling is, 0 to 1 — or null where nothing has been consumed
 *  against it yet, which is not the same as zero and must not draw as an empty
 *  bar somebody reads as "measured, and idle". */
export function fullness(c: Ceiling): number | null {
  return fullnessOf(c.used, c.max)
}

/** How much trouble a ceiling is in.
 *
 *  Three bands rather than a percentage, because the decision a person makes
 *  from this figure has three outcomes: ignore it, watch it, or find out whose
 *  queries are being refused. `null` is the fourth state and not a band — the
 *  interval has not started, so there is nothing to be in trouble about.
 */
export function pressure(c: Ceiling): 'ok' | 'close' | 'spent' | null {
  return pressureOf(c.used, c.max)
}

/** The same three bands over a bare pair. One set of thresholds for the
 *  product, wherever a bar is drawn. */
export function pressureOf(used: number | undefined, max: number): 'ok' | 'close' | 'spent' | null {
  const f = fullnessOf(used, max)
  if (f === null) return null
  if (f >= 1) return 'spent'
  return f >= 0.8 ? 'close' : 'ok'
}

/** Consumption of one quota over one interval, matched to the quota's own
 *  ceilings. Keyed by both name and duration: a quota with two intervals has a
 *  usage row for each, and pairing them by name alone shows an hour's queries
 *  against a minute's ceiling. */
export function usageFor(
  usage: Consumption[],
  quota: string,
  duration_secs: number,
): Consumption[] {
  return usage.filter((u) => u.quota_name === quota && u.duration_secs === duration_secs)
}

/** The accounts worth a column, nearest their ceiling first.
 *
 *  A quota keyed by user name has one set of counters per account, and a server
 *  with fifty users would otherwise draw fifty columns and scroll off the right
 *  of the screen. Sorted by how full the fullest ceiling is, because the only
 *  reason to look at this table is to find whoever is about to be refused —
 *  and the count of what was left out travels with the list, so a table showing
 *  six of fifty cannot be read as the whole truth.
 */
export function closestToCeiling(
  usage: Consumption[],
  limit: number,
): { shown: Consumption[]; hidden: number } {
  const worst = (u: Consumption) =>
    u.ceilings.reduce((acc, c) => Math.max(acc, fullness(c) ?? 0), 0)
  const sorted = [...usage].sort((a, b) => worst(b) - worst(a))
  return { shown: sorted.slice(0, limit), hidden: Math.max(0, sorted.length - limit) }
}

export interface TablePolicies {
  database: string
  table: string
  permissive: RowPolicy[]
  restrictive: RowPolicy[]
}

/** Row policies grouped by the table they narrow.
 *
 *  Policies only mean anything together: one permissive policy on a table is a
 *  filter, two are a union, and a restrictive one alongside them is an
 *  intersection. Listing them flat invites reading each as if it were the whole
 *  rule.
 */
export function byTable(policies: RowPolicy[]): TablePolicies[] {
  const groups = new Map<string, TablePolicies>()
  for (const p of policies) {
    const key = `${p.database}.${p.table}`
    let g = groups.get(key)
    if (!g) {
      g = { database: p.database, table: p.table, permissive: [], restrictive: [] }
      groups.set(key, g)
    }
    ;(p.restrictive ? g.restrictive : g.permissive).push(p)
  }
  return [...groups.values()].sort((a, b) =>
    `${a.database}.${a.table}`.localeCompare(`${b.database}.${b.table}`),
  )
}

/** What this table's policies do, in the order the server applies them.
 *
 *  Verified against ClickHouse rather than taken from the shape of the tables,
 *  because the interesting halves are both counter-intuitive:
 *
 *  - A user **no policy names sees every row**. A table with a row policy on it
 *    is not a protected table; it is protected for the accounts the policies
 *    name and nobody else. This is the mistake worth designing the screen
 *    around.
 *  - A **restrictive policy with no permissive one beside it narrows from
 *    everything**, rather than from nothing. The base is all rows unless a
 *    permissive policy names you, in which case it is the union of yours.
 */
export function reading(g: TablePolicies): string[] {
  const lines: string[] = []
  const onlyPermissive = g.permissive.length === 1 ? g.permissive[0] : undefined
  const onlyRestrictive = g.restrictive.length === 1 ? g.restrictive[0] : undefined
  if (onlyPermissive) {
    lines.push(`sees the rows matching ${onlyPermissive.short_name}`)
  } else if (g.permissive.length > 1) {
    lines.push(
      `sees the rows matching any of the ${g.permissive.length} permissive policies — they add up, they do not narrow each other`,
    )
  }
  if (g.restrictive.length) {
    const base = g.permissive.length ? 'and then only those' : 'sees every row, but only those'
    lines.push(
      `${base} matching ${onlyRestrictive ? onlyRestrictive.short_name : `all ${g.restrictive.length} restrictive policies`}`,
    )
  }
  return lines
}

/** The accounts any of a table's policies names, sorted and deduplicated. */
export function narrowed(g: TablePolicies): string[] {
  const named = new Set<string>()
  for (const p of [...g.permissive, ...g.restrictive]) {
    if (p.apply_to_all) return ['everyone']
    for (const n of p.apply_to_list) named.add(n)
  }
  return [...named].sort()
}
