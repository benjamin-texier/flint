/** The configuration this server is actually running with.
 *
 *  Two tables, two questions, and the logic here exists to keep them apart:
 *  `system.server_settings` is the server's own configuration and the same for
 *  every connection, while `system.settings` is what a statement *on this
 *  connection* would run with — which includes everything Flint attached to it.
 */

export interface ServerSetting {
  name: string
  value: string
  default: string
  /** Somebody wrote it in a config file. Not the same as "differs from the
   *  default": on a stock server about half the written ones hold the value the
   *  server would have used anyway. */
  changed: boolean
  description: string
  type: string
  /** `Yes`, `No` or `IncreaseOnly`. */
  changeable: string
  obsolete: boolean
  /** Written down, and identical to the default. Config that says nothing. */
  redundant: boolean
}

export interface SessionSetting {
  name: string
  value: string
  default: string
  changed: boolean
  description: string
  type: string
  obsolete: boolean
  tier: string
  /** Attached by Flint to every statement it sends, rather than configured. */
  flints: boolean
  /** Differs because `compatibility` asked the server to behave like an older
   *  one, and not because anybody chose it. Measured by a counterfactual, so it
   *  is exact rather than inferred. */
  from_compatibility: boolean
}

export interface Section<T> {
  items: T[]
  blocked?: string
}

/** One `SYSTEM` command, as the server publishes it.
 *
 *  Its text comes from the backend so the sentence a button warns under is the
 *  sentence the code acts under. `observable` is false for the two that toggle
 *  a state ClickHouse keeps to itself. */
export interface SystemCommand {
  id: string
  label: string
  statement: string
  costs: string
  observable: boolean
}

/** Which ClickHouse this actually is.
 *
 *  Four things in `system.build_options` answer questions nothing else on the
 *  server answers: whether it is an official build, what kind of build, which
 *  timezone database it was built against — a stale one is wrong quietly — and
 *  which optional features were compiled out.
 */
export interface BuildReport {
  version: string
  describe: string
  official: boolean
  build_type: string
  git_hash: string
  git_branch: string
  git_date: string
  platform: string
  compiler: string
  tzdata: string
  openssl: string
  /** Optional features compiled out. Empty on an official build, which the
   *  total says out loud rather than leaving to be inferred. */
  missing: string[]
  features_total: number
  verdicts: string[]
  blocked?: string
}

export interface SettingsReport {
  server: Section<ServerSetting>
  session: Section<SessionSetting>
  compatibility: string
  server_total: number
  session_total: number
  commands: SystemCommand[]
  build: BuildReport
}

/** The build's identity as one line, or null where the server did not say.
 *
 *  A version alone is not an identity: two servers reporting `26.7.5.10` can be
 *  an official release and somebody's branch, and the git hash is the only thing
 *  that tells them apart.
 */
export function saysBuild(b: BuildReport): string | null {
  if (!b.version) return null
  const parts = [b.describe || b.version]
  if (!b.official) parts.push('not an official build')
  if (b.build_type) parts.push(b.build_type)
  if (b.platform) parts.push(b.platform)
  return parts.join(' · ')
}

/** What was compiled out, as a sentence — or what was compiled in, when nothing
 *  was.
 *
 *  An empty list is the answer on an official build, and leaving it empty reads
 *  as a failure to look rather than as "all of them are here".
 */
export function saysFeatures(b: BuildReport): string {
  if (!b.features_total) return ''
  if (!b.missing.length) {
    return `All ${b.features_total} optional features are compiled in.`
  }
  return `${b.missing.length} of ${b.features_total} optional features are compiled out: ${b.missing.join(', ')}.`
}

/** Whether this setting can be acted on now, as a phrase — or null where it
 *  cannot, which is the ordinary case.
 *
 *  The note is on the minority on purpose, and which side that is had to be
 *  measured rather than assumed: 39 of the 46 written settings on a stock server
 *  need a restart, and 336 of all 439 do. A "needs a restart" note therefore
 *  repeats itself down almost every row and says nothing, while the seven that
 *  can be changed now are exactly the ones somebody can do something about
 *  today.
 */
export function restartNote(setting: ServerSetting): string | null {
  if (setting.changeable === 'Yes') return 'takes effect on a config reload'
  if (setting.changeable === 'IncreaseOnly') return 'can be raised on a reload, not lowered'
  return null
}

/** The written settings, split by whether they say anything.
 *
 *  Both halves are returned rather than the interesting one, because the count
 *  of the inert half is itself the finding: "24 of these 46 lines write down the
 *  value the server would have used anyway" is worth knowing about a config file
 *  somebody is about to edit.
 */
export function split(items: ServerSetting[]): {
  says: ServerSetting[]
  inert: ServerSetting[]
  obsolete: ServerSetting[]
} {
  return {
    obsolete: items.filter((s) => s.obsolete),
    says: items.filter((s) => !s.obsolete && !s.redundant),
    inert: items.filter((s) => !s.obsolete && s.redundant),
  }
}

/** The session settings, split by who set them.
 *
 *  Three groups, because three different people set them and only one of those
 *  is the account. On a server in `compatibility` mode the third group is almost
 *  the whole list — 384 of 392 on a `24.8` account — and it is a group nobody
 *  chose: one line moved all of them at once. Folding it into "set for this
 *  account" makes the page unreadable and the claim false.
 */
export function whoSet(items: SessionSetting[]): {
  profile: SessionSetting[]
  flints: SessionSetting[]
  compat: SessionSetting[]
} {
  return {
    profile: items.filter((s) => !s.flints && !s.from_compatibility),
    flints: items.filter((s) => s.flints),
    compat: items.filter((s) => s.from_compatibility && !s.flints),
  }
}

/** Filter a list by a typed fragment, matching name or value.
 *
 *  Case-insensitive on the name, which is how somebody types `memory` looking
 *  for `max_memory_usage`. The description is deliberately not searched: it is
 *  a paragraph, and matching inside it returns rows whose relevance is invisible
 *  from the row.
 */
export function matching<T extends { name: string; value: string }>(
  items: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter(
    (s) => s.name.toLowerCase().includes(q) || s.value.toLowerCase().includes(q),
  )
}

/** What a filter is hiding, as a sentence — or null when it hides nothing.
 *
 *  A list silently truncated reads as the whole truth, and a filtered list is a
 *  truncated one.
 */
export function hiding(shown: number, total: number): string | null {
  if (shown >= total) return null
  return `${shown} of ${total}; the rest do not match`
}
