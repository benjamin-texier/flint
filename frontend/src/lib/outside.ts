/** Everything this server reads from somewhere else, grouped by where.
 *
 *  The object page answers this one table at a time, which is right for "what
 *  is this table" and wrong for the question somebody actually arrives with.
 *  Credentials rotate on a bucket and thirty tables stop working at once; a host
 *  is decommissioned and nobody knows which tables pointed at it. Both are one
 *  read of `system.tables` away, and neither is answerable from a page you have
 *  to open thirty times.
 *
 *  **Grouped by the far end, not by the engine.** Two `PostgreSQL` tables on two
 *  different servers have nothing to do with each other, and an `S3` table and
 *  an `IcebergS3` table on the same bucket have everything to do with each
 *  other. The grouping key is the address, which is exactly the thing that
 *  breaks together. */

import { externalSource, type ExternalKind, type ExternalSource } from './external'

export interface OutsideTable {
  database: string
  name: string
  engine: string
  engine_full: string
}

export interface OutsideReport {
  tables: { items: OutsideTable[]; blocked?: string }
  total: number
}

export interface OutsideEntry {
  table: OutsideTable
  source: ExternalSource
  /** What this one reads, in the far end's own terms. */
  target: string
}

export interface OutsideGroup {
  /** Stable across renders and unique within a report: the grouping key. */
  key: string
  kind: ExternalKind
  /** What the group is named after: the endpoint where there is one, empty
   *  where the address carries no host of its own. */
  at: string
  /** The engines in it, in the order they were met. Plural on purpose: a bucket
   *  read by an `S3` table and an `IcebergS3` table is one bucket. */
  engines: string[]
  entries: OutsideEntry[]
}

/** The far end two tables would share, or nothing where the definition names
 *  none.
 *
 *  A URL is its own host and a file is its own path, so for those the address
 *  *is* the target and grouping on it would make one group per table, which is
 *  not a grouping — it is the list again. Those group by what they are, which is
 *  the honest amount of structure they have. */
function endpointOf(source: ExternalSource): string {
  if (source.at) return source.at
  if (source.collection) return `collection ${source.collection}`
  return ''
}

/** What kind of far end this is, for the purpose of deciding whether two tables
 *  are pointed at the same one.
 *
 *  Coarser than the kind the page displays, and it has to be: `object_store` and
 *  `lake` are two ways of reading one bucket, and keying on the displayed kind
 *  split `s3:9000` into two rows that were the same machine. What the key must
 *  keep apart is protocols — a Kafka broker and a Postgres server that happen to
 *  share a hostname are not one thing, and a row merging them would be neither. */
function family(kind: ExternalKind): string {
  return kind === 'lake' ? 'object_store' : kind
}

export function groupOutside(tables: OutsideTable[]): OutsideGroup[] {
  const groups = new Map<string, OutsideGroup>()
  for (const table of tables) {
    const source = externalSource(table.engine, table.engine_full)
    if (!source) continue
    const at = endpointOf(source)
    const of = family(source.kind)
    const key = at ? `${of} ${at}` : `${of} ${source.engine}`
    let group = groups.get(key)
    if (!group) {
      group = { key, kind: source.kind, at, engines: [], entries: [] }
      groups.set(key, group)
    }
    if (!group.engines.includes(source.engine)) group.engines.push(source.engine)
    group.entries.push({ table, source, target: source.target })
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.entries.length - a.entries.length ||
      a.at.localeCompare(b.at) ||
      a.key.localeCompare(b.key),
  )
}

/** What to call a group that has no endpoint to be called after.
 *
 *  `File` and `URL` tables name no host: the first is on this server's own disk,
 *  the second carries its host inside each address. So the group is named after
 *  what it is rather than after a hostname it does not have. */
export function groupLabel(group: OutsideGroup): string {
  if (group.at) return group.at
  return group.engines.join(', ')
}

/** How many distinct places this server reads from, and how many tables do it.
 *
 *  Both figures, because either alone misleads: six tables on one bucket and one
 *  table each on six buckets are the same "six tables" and completely different
 *  exposures. */
export function saysOutside(groups: OutsideGroup[], total: number): string {
  const tables = groups.reduce((sum, g) => sum + g.entries.length, 0)
  if (tables === 0) return 'Nothing on this server reads from outside it.'
  const places = `${groups.length} ${groups.length === 1 ? 'place' : 'places'}`
  const reads = `${tables} ${tables === 1 ? 'table' : 'tables'}`
  if (total > tables) {
    return `${reads} of ${total} on this server read from ${places} outside it; the rest are not listed.`
  }
  return `${reads} on this server read from ${places} outside it.`
}
