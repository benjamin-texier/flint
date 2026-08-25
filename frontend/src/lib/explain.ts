/** Plain language for ClickHouse concepts.
 *
 *  Flint has to work for someone who has run ClickHouse for years and for
 *  someone who opened it yesterday. The way to serve both is not to simplify —
 *  an expert needs the real engine name — but to put the precise term and its
 *  meaning next to each other, every time. The term stays primary; the
 *  sentence sits underneath in a quieter voice. */

import type { ObjectKind } from './graph'

export const KIND_LABEL: Record<ObjectKind, string> = {
  table: 'table',
  view: 'view',
  materialized_view: 'materialized view',
  dictionary: 'dictionary',
}

export const KIND_PLURAL: Record<ObjectKind, string> = {
  table: 'tables',
  view: 'views',
  materialized_view: 'materialized views',
  dictionary: 'dictionaries',
}

export const KIND_MEANING: Record<ObjectKind, string> = {
  table: 'Stores rows on disk.',
  view: 'A saved query. Runs every time you read it and stores nothing.',
  materialized_view:
    'A query that runs on every insert into its source and writes the result into another table.',
  dictionary: 'An in-memory lookup table, refreshed on a schedule.',
}

/** What a table engine actually does, in one sentence.
 *
 *  Keyed on the family rather than the exact name so that `Replicated…` and
 *  `Shared…` variants, which behave the same from a reader's point of view,
 *  do not each need an entry. */
const ENGINE_MEANING: [RegExp, string][] = [
  [
    /^(Replicated|Shared)?ReplacingMergeTree/,
    'Keeps only the last row for each sorting key, so duplicates collapse as parts merge.',
  ],
  [
    /^(Replicated|Shared)?SummingMergeTree/,
    'Adds up the numeric columns of rows that share a sorting key as parts merge.',
  ],
  [
    /^(Replicated|Shared)?AggregatingMergeTree/,
    'Combines rows sharing a sorting key using aggregate functions as parts merge.',
  ],
  [
    /^(Replicated|Shared)?VersionedCollapsingMergeTree/,
    'Cancels out pairs of rows marked as an old and a new version, with a version column to order them.',
  ],
  [
    /^(Replicated|Shared)?CollapsingMergeTree/,
    'Cancels out pairs of rows marked as inserted and deleted as parts merge.',
  ],
  [
    /^(Replicated|Shared)?GraphiteMergeTree/,
    'Thins out Graphite metrics over time according to a rollup configuration.',
  ],
  [
    /^(Replicated|Shared)?MergeTree/,
    'The standard ClickHouse table: rows are written in sorted parts, which is what makes filtering on the sorting key fast.',
  ],
  [/^Distributed/, 'Holds no data itself — it fans queries out across a cluster of other tables.'],
  [/^Merge$/, 'Reads several tables at once as though they were one. Stores nothing.'],
  [/^Memory$/, 'Keeps rows in RAM only. Fast, and gone when the server restarts.'],
  [/^(Stripe|Tiny)?Log$/, 'A simple append-only file. No index, no parts — fine for small tables.'],
  [/^Buffer/, 'Collects rows in memory and flushes them into another table in batches.'],
  [/^Null$/, 'Accepts writes and discards them. Useful as a materialized view source.'],
  [/^Set$/, 'A set of values, built to be used on the right-hand side of IN.'],
  [/^Join$/, 'A prepared join table kept in memory.'],
  [/^(Kafka|RabbitMQ|NATS)/, 'Streams rows in from a message queue as they arrive.'],
  [/^(S3|URL|HDFS|Azure)/, 'Reads and writes files held outside ClickHouse.'],
  [/^File$/, 'Reads and writes a file on the server’s disk.'],
  [/^(MySQL|PostgreSQL|SQLite|MongoDB|ODBC|JDBC|Redis)/, 'Queries another database live, on demand.'],
  [/^MaterializedView$/, KIND_MEANING.materialized_view],
  [/^(Live|Window)?View$/, KIND_MEANING.view],
  [/^Dictionary$/, KIND_MEANING.dictionary],
]

export function explainEngine(engine: string): string | null {
  for (const [pattern, meaning] of ENGINE_MEANING) {
    if (pattern.test(engine)) return meaning
  }
  return null
}

/** True for the tables ClickHouse names and owns itself.
 *
 *  A materialized view's rows live in a table called `.inner_id.<uuid>` (or
 *  `.inner.<view>` on older servers). They are real objects with real sizes,
 *  but nobody wrote them, and in a database with forty views they are most of
 *  every list — so they are folded away until asked for. */
export function internalName(name: string): boolean {
  return name.startsWith('.inner')
}

/** True when the engine keeps its rows on ClickHouse's own disk in parts —
 *  the thing that makes partitions, TTLs and compression meaningful. */
export function storesParts(engine: string): boolean {
  return /MergeTree/.test(engine)
}

/** What each part of a table's shape is for. Shown beneath the value, so the
 *  expression stays the thing you read first. */
export const CLAUSE_MEANING: Record<string, string> = {
  'order by': 'The order rows are stored in. Filters and ranges on these columns are the fast ones.',
  'primary key': 'The prefix of the sorting key that ClickHouse keeps an index over.',
  'partition by': 'Splits the table into separate groups of files, which can be dropped whole.',
  'sample by': 'Lets a query read a deterministic fraction of the rows.',
  ttl: 'How long rows live before ClickHouse deletes them.',
  engine: 'How this table stores and merges its rows.',
  // Shown when the two clauses hold the same columns, which is the default:
  // ClickHouse takes the primary key from the sorting key unless told not to.
  'order by · primary key':
    'The order rows are stored in, and the prefix ClickHouse keeps an index over. The same columns here, as they are unless a table asks for otherwise.',
}
