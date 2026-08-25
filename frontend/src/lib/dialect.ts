/** ClickHouse's vocabulary, in one place.
 *
 *  The editor's highlighter and the DDL view both need to know a keyword from a
 *  type name from an ordinary identifier. Keeping the two lists here means the
 *  CREATE statement on a table page and the same statement pasted into the
 *  editor cannot end up coloured differently. Plain strings, so nothing that
 *  imports this pulls CodeMirror in with it. */

export const KEYWORDS =
  'select from where prewhere group by order limit offset having distinct all any as on using join left right inner full outer cross array asof semi anti global union intersect except with recursive case when then else end and or not in like ilike between is null asc desc nulls first last insert into values update delete alter table create drop attach detach rename truncate optimize final deduplicate materialize view materialized live window dictionary database if exists replace engine partition primary key sample sign version ttl settings codec default alias ephemeral comment cluster on function format outfile infile set show describe explain grant revoke system kill query check exchange move to disk volume freeze unfreeze modify add column index projection constraint apply clear rows step totals cube rollup interval extract cast collate populate'

export const BUILTINS =
  'MergeTree ReplacingMergeTree SummingMergeTree AggregatingMergeTree CollapsingMergeTree VersionedCollapsingMergeTree GraphiteMergeTree ReplicatedMergeTree ReplicatedReplacingMergeTree Distributed Memory Log TinyLog StripeLog Null Set Join View MaterializedView Dictionary Buffer Kafka S3 URL File MySQL PostgreSQL SQLite MongoDB HDFS Merge Int8 Int16 Int32 Int64 Int128 Int256 UInt8 UInt16 UInt32 UInt64 UInt128 UInt256 Float32 Float64 Decimal Decimal32 Decimal64 Decimal128 Decimal256 Bool String FixedString UUID Date Date32 DateTime DateTime64 Enum8 Enum16 Array Tuple Map Nested Nullable LowCardinality AggregateFunction SimpleAggregateFunction IPv4 IPv6 JSON Dynamic Variant Point Ring Polygon MultiPolygon'

/** Keywords are matched without regard to case, the way SQL reads them. */
export const KEYWORD_SET = new Set(KEYWORDS.split(' '))

/** Type and engine names are matched exactly: ClickHouse's are case-sensitive,
 *  and `SELECT x AS string` is a column called `string`, not a type. */
export const BUILTIN_SET = new Set(BUILTINS.split(' '))
