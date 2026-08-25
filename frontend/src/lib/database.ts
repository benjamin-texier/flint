/** Which database Flint should open on, and in what order they are listed.
 *
 *  Landing on `information_schema` tells you nothing about your data. Landing
 *  on an *empty* database tells you less than that — a rail reading "this
 *  database is empty" is the worst first screen Flint can draw. So the choice
 *  is: whatever you were last looking at, else the fullest database that is not
 *  ClickHouse's own plumbing, else the fullest of what is left.
 *
 *  `default` is deliberately not plumbing. It is where ClickHouse puts a table
 *  you created without saying where, which is to say it is where a great many
 *  people keep everything. Counting it as ClickHouse's meant a server whose
 *  data all lives in `default` opened on whichever empty database happened to
 *  sort first. */

export const INTERNAL_DATABASES = new Set(['system', 'INFORMATION_SCHEMA', 'information_schema'])

/** Everything in a database that Flint can open. Absent counts read as zero,
 *  so a caller that only has names still gets a sensible order. */
export interface DatabaseCounts {
  tables?: number
  views?: number
  materialized_views?: number
  dictionaries?: number
}

export function objectCount(d: DatabaseCounts): number {
  return (d.tables ?? 0) + (d.views ?? 0) + (d.materialized_views ?? 0) + (d.dictionaries ?? 0)
}

const KEY = 'flint.database'

export function isInternal(name: string): boolean {
  return INTERNAL_DATABASES.has(name)
}

export function resolveDatabase<T extends { name: string } & DatabaseCounts>(
  databases: readonly T[],
  remembered?: string | null,
): string | undefined {
  if (remembered && databases.some((d) => d.name === remembered)) return remembered
  const ordered = orderDatabases(databases)
  return (ordered.find((d) => objectCount(d) > 0) ?? ordered[0])?.name
}

/** Reading and writing the remembered database. Both swallow failures: a
 *  browser with site data blocked should still be able to explore. */
export function rememberedDatabase(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function rememberDatabase(name: string): void {
  try {
    localStorage.setItem(KEY, name)
  } catch {
    /* nothing to do — the choice simply will not survive a reload */
  }
}

/** Order for the rail and the server list: your databases first, fullest first
 *  within each group, alphabetical to break a tie. Size leads because a list
 *  where the database holding everything sits below two empty ones is a list
 *  that has to be read rather than glanced at. `keep` is never demoted, so the
 *  database you are viewing stays where you can see it. */
export function orderDatabases<T extends { name: string } & DatabaseCounts>(
  list: readonly T[],
  keep?: string,
): T[] {
  return [...list].sort((a, b) => {
    const ai = isInternal(a.name) && a.name !== keep ? 1 : 0
    const bi = isInternal(b.name) && b.name !== keep ? 1 : 0
    return ai - bi || objectCount(b) - objectCount(a) || a.name.localeCompare(b.name)
  })
}
