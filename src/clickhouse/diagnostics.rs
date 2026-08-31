//! What ClickHouse knows about itself, read back as answers rather than tables.
//!
//! Every query here runs against `system.*`, which means three things are
//! normal and none of them is a bug: the log can be switched off, the columns
//! move between versions, and a read-only role is often granted none of it. So
//! each report either carries rows or carries the reason it cannot, and only a
//! genuine failure propagates — reporting "unavailable" for a real defect is
//! how a real defect stays hidden.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};

use super::{Client, Reach, INTROSPECTION_TAG};
use crate::error::{Error, Result};

/// Databases whose contents are ClickHouse's own business.
const USER_DATABASES: &str =
    "database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')";

/// ClickHouse writes `nan` as JSON `null` (`output_format_json_quote_denormals`
/// is off by default), and an average over no rows is `nan`. A number the UI
/// can render beats a null it has to branch on.
fn lenient_f64<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(0.0))
}

fn window(days: u64) -> u64 {
    days.clamp(1, 90)
}

/// A filter that leaves out Flint's own questions about `system.*`.
///
/// Without it the report is mostly self-portrait: the page that ranks queries
/// by cost finds its own metadata queries at the top, because they are the ones
/// running every time someone opens it. `log_comment` arrived in ClickHouse 21,
/// so an older server simply keeps them — better than a query that fails.
pub(super) async fn excluding_flint(ch: &Client) -> Result<String> {
    let tagged = ch
        .system_columns("query_log")
        .await?
        .contains("log_comment");
    Ok(if tagged {
        format!("AND log_comment != '{INTROSPECTION_TAG}' ")
    } else {
        String::new()
    })
}

/// Whether this server's `system.<table>` has everything a query needs, and
/// which columns it lacks when it does not. Naming the missing column turns an
/// unsupported version into something the reader can act on.
///
/// An empty column set means "cannot tell", never "has no columns":
/// `system.columns` is grant-filtered too, so a role granted the log but not
/// the catalogue would otherwise be told every column it needs is missing.
/// When we cannot tell, we say nothing and let the real query speak.
pub(super) async fn missing(ch: &Client, table: &str, needed: &[&str]) -> Result<Vec<String>> {
    let have = ch.system_columns(table).await?;
    if have.is_empty() {
        return Ok(Vec::new());
    }
    Ok(needed
        .iter()
        .filter(|c| !have.contains(**c))
        .map(|c| (*c).to_string())
        .collect())
}

/// The reason a report cannot be produced, in the reader's terms: a GRANT and a
/// server setting are different problems with different fixes, so they get
/// different sentences.
pub(super) fn blocked(reach: Reach, table: &str) -> Option<String> {
    match reach {
        Reach::Readable => None,
        Reach::Denied => Some(format!("this user is not granted SELECT on system.{table}")),
        Reach::Absent => Some(match table {
            "query_log" => "system.query_log is not enabled on this server".to_string(),
            other => format!("this server has no system.{other}"),
        }),
        Reach::Unconfigured => Some(
            "this server has no Keeper configured, so it is not part of a cluster and has \
             nothing to report here"
                .to_string(),
        ),
    }
}

/// A restricted role is a configuration fact, so it is stated, not raised.
fn denial(e: &Error, table: &str) -> Option<String> {
    match e {
        // A server with no Keeper answers this to anything about the cluster.
        // Stated like a grant failure, because it is the same kind of fact: not
        // an error in the request, a shape of deployment.
        Error::ClickHouse { code: 139, .. } => Some(
            "this server has no Keeper configured, so it is not part of a cluster and has \
             nothing to report here"
                .to_string(),
        ),
        Error::ClickHouse { code: 497, .. } | Error::ClickHouse { code: 164, .. } => {
            Some(format!("this user is not granted SELECT on system.{table}"))
        }
        _ => None,
    }
}

async fn rows_or_denial<T: DeserializeOwned>(
    ch: &Client,
    sql: &str,
    table: &str,
) -> Result<std::result::Result<Vec<T>, String>> {
    match ch.rows::<T>(sql).await {
        Ok(rows) => Ok(Ok(rows)),
        Err(e) => match denial(&e, table) {
            Some(reason) => Ok(Err(reason)),
            None => Err(e),
        },
    }
}

// ── Queries ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Summary {
    pub queries: u64,
    pub failures: u64,
    pub selects: u64,
    pub inserts: u64,
    pub read_bytes: u64,
    pub read_rows: u64,
    #[serde(deserialize_with = "lenient_f64")]
    pub avg_ms: f64,
    #[serde(deserialize_with = "lenient_f64")]
    pub p95_ms: f64,
    pub max_ms: u64,
    pub users: u64,
    /// The oldest entry actually retained, which is the real window whatever
    /// was asked for: a seven-day question against a two-day log has a
    /// two-day answer.
    pub since: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pattern {
    pub hash: String,
    pub runs: u64,
    pub failures: u64,
    #[serde(deserialize_with = "lenient_f64")]
    pub avg_ms: f64,
    #[serde(deserialize_with = "lenient_f64")]
    pub p95_ms: f64,
    pub max_ms: u64,
    pub total_ms: u64,
    pub read_bytes: u64,
    pub read_rows: u64,
    pub peak_memory: u64,
    pub users: u64,
    pub last_seen: String,
    pub sample: String,
    #[serde(default)]
    pub tables: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Failure {
    pub code: i32,
    pub name: String,
    pub occurrences: u64,
    pub last_seen: String,
    pub sample: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub window_days: u64,
    pub summary: Option<Summary>,
    pub patterns: Vec<Pattern>,
    pub failures: Vec<Failure>,
}

impl QueryReport {
    fn unavailable(days: u64, reason: impl Into<String>) -> Self {
        Self {
            available: false,
            reason: Some(reason.into()),
            window_days: days,
            summary: None,
            patterns: Vec::new(),
            failures: Vec::new(),
        }
    }
}

/// What ran, what it cost, and what failed — grouped by pattern rather than
/// listed one row at a time, because a single slow query is an anecdote and a
/// slow pattern is a problem.
pub async fn queries(ch: &Client, days: u64, limit: u64) -> Result<QueryReport> {
    let days = window(days);
    if let Some(reason) = blocked(ch.reach("query_log").await?, "query_log") {
        return Ok(QueryReport::unavailable(days, reason));
    }
    let gaps = missing(
        ch,
        "query_log",
        &["query_kind", "normalized_query_hash", "exception_code"],
    )
    .await?;
    if !gaps.is_empty() {
        return Ok(QueryReport::unavailable(
            days,
            format!(
                "this ClickHouse version's system.query_log has no {}",
                gaps.join(", ")
            ),
        ));
    }

    let limit = limit.clamp(1, 200);
    let ours = excluding_flint(ch).await?;
    let has_tables = ch.system_columns("query_log").await?.contains("tables");
    // `groupArray` is bounded: a pattern that ran a hundred thousand times
    // would otherwise build a hundred-thousand-element array to answer "which
    // tables does it touch".
    let tables_expr = if has_tables {
        "arrayDistinct(arrayFlatten(groupArray(20)(tables)))"
    } else {
        "[]"
    };

    let summary_sql = format!(
        "SELECT count()                                       AS queries, \
                countIf(exception_code != 0)                  AS failures, \
                countIf(query_kind = 'Select')                AS selects, \
                countIf(query_kind = 'Insert')                AS inserts, \
                sum(read_bytes)                               AS read_bytes, \
                sum(read_rows)                                AS read_rows, \
                round(avg(query_duration_ms), 1)              AS avg_ms, \
                round(quantile(0.95)(query_duration_ms), 1)   AS p95_ms, \
                max(query_duration_ms)                        AS max_ms, \
                uniqExact(user)                               AS users, \
                toString(min(event_time))                     AS since \
         FROM system.query_log \
         WHERE type != 'QueryStart' AND event_time > now() - INTERVAL {days} DAY {ours}"
    );

    let patterns_sql = format!(
        "SELECT toString(normalized_query_hash)               AS hash, \
                count()                                       AS runs, \
                countIf(exception_code != 0)                  AS failures, \
                round(avg(query_duration_ms), 1)              AS avg_ms, \
                round(quantile(0.95)(query_duration_ms), 1)   AS p95_ms, \
                max(query_duration_ms)                        AS max_ms, \
                sum(query_duration_ms)                        AS total_ms, \
                sum(read_bytes)                               AS read_bytes, \
                sum(read_rows)                                AS read_rows, \
                max(memory_usage)                             AS peak_memory, \
                uniqExact(user)                               AS users, \
                toString(max(event_time))                     AS last_seen, \
                any(query)                                    AS sample, \
                {tables_expr}                                 AS tables \
         FROM system.query_log \
         WHERE type != 'QueryStart' AND event_time > now() - INTERVAL {days} DAY \
           AND query_kind = 'Select' {ours}\
         GROUP BY normalized_query_hash \
         ORDER BY total_ms DESC \
         LIMIT {limit}"
    );

    // Grouped by what went wrong, not by when: twenty rows of the same
    // exception say one thing, and it is easier to read once.
    let failures_sql = format!(
        "SELECT exception_code                                AS code, \
                any(errorCodeToName(exception_code))          AS name, \
                count()                                       AS occurrences, \
                toString(max(event_time))                     AS last_seen, \
                any(query)                                    AS sample, \
                any(exception)                                AS message \
         FROM system.query_log \
         WHERE type != 'QueryStart' AND event_time > now() - INTERVAL {days} DAY \
           AND exception_code != 0 {ours}\
         GROUP BY exception_code \
         ORDER BY occurrences DESC \
         LIMIT 20"
    );

    let summary = match rows_or_denial::<Summary>(ch, &summary_sql, "query_log").await? {
        Ok(rows) => rows.into_iter().next(),
        Err(reason) => return Ok(QueryReport::unavailable(days, reason)),
    };
    let patterns = match rows_or_denial::<Pattern>(ch, &patterns_sql, "query_log").await? {
        Ok(rows) => rows,
        Err(reason) => return Ok(QueryReport::unavailable(days, reason)),
    };
    let failures = match rows_or_denial::<Failure>(ch, &failures_sql, "query_log").await? {
        Ok(rows) => rows,
        Err(reason) => return Ok(QueryReport::unavailable(days, reason)),
    };

    Ok(QueryReport {
        available: true,
        reason: None,
        window_days: days,
        summary,
        patterns,
        failures,
    })
}

// ── Table traffic ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableTraffic {
    pub qualified: String,
    pub reads: u64,
    pub writes: u64,
    pub read_rows: u64,
    pub read_bytes: u64,
    #[serde(deserialize_with = "lenient_f64")]
    pub avg_ms: f64,
    pub readers: u64,
    /// Epoch when nothing in the window read it, which the UI shows as never.
    pub last_read: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnusedTable {
    pub qualified: String,
    pub engine: String,
    pub row_count: u64,
    pub bytes: u64,
    pub last_write: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrafficReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub window_days: u64,
    pub traffic: Vec<TableTraffic>,
    pub unused: Vec<UnusedTable>,
}

impl TrafficReport {
    fn unavailable(days: u64, reason: impl Into<String>) -> Self {
        Self {
            available: false,
            reason: Some(reason.into()),
            window_days: days,
            traffic: Vec::new(),
            unused: Vec::new(),
        }
    }
}

/// Which tables are actually read, how often, and which are only ever written.
///
/// Reads and writes are counted separately on purpose. `tables` in the log
/// names every table a statement touched, so counting all of them as reads
/// credits a materialized view's target table with traffic it never had — it
/// was written by the insert, and nobody has selected from it in weeks.
pub async fn traffic(
    ch: &Client,
    days: u64,
    limit: u64,
    workspace: Option<&str>,
) -> Result<TrafficReport> {
    let days = window(days);
    if let Some(reason) = blocked(ch.reach("query_log").await?, "query_log") {
        return Ok(TrafficReport::unavailable(days, reason));
    }
    let gaps = missing(ch, "query_log", &["tables", "query_kind"]).await?;
    if !gaps.is_empty() {
        return Ok(TrafficReport::unavailable(
            days,
            format!(
                "this ClickHouse version's system.query_log has no {}",
                gaps.join(", ")
            ),
        ));
    }

    let limit = limit.clamp(1, 200);
    let ours = excluding_flint(ch).await?;
    let traffic_sql = format!(
        "SELECT t                                             AS qualified, \
                countIf(query_kind = 'Select')                AS reads, \
                countIf(query_kind = 'Insert')                AS writes, \
                sumIf(read_rows, query_kind = 'Select')       AS read_rows, \
                sumIf(read_bytes, query_kind = 'Select')      AS read_bytes, \
                if(countIf(query_kind = 'Select') > 0, \
                   round(avgIf(query_duration_ms, query_kind = 'Select'), 1), 0) AS avg_ms, \
                uniqExactIf(user, query_kind = 'Select')      AS readers, \
                toString(maxIf(event_time, query_kind = 'Select')) AS last_read \
         FROM system.query_log \
         ARRAY JOIN tables AS t \
         WHERE type != 'QueryStart' AND event_time > now() - INTERVAL {days} DAY {ours}\
           AND notEmpty(t) \
           AND t NOT LIKE 'system.%' \
           AND t NOT LIKE '\\_table\\_function.%' \
         GROUP BY t \
         ORDER BY reads DESC, writes DESC \
         LIMIT {limit}"
    );

    // Flint's own workspace is left out of this list and this list only. Its
    // tables genuinely are read by almost nothing, and a section that invites
    // you to drop what you no longer read must not invite you to drop the
    // saved queries and dashboards Flint is keeping for you. Their disk cost
    // still shows up under storage, where it is a fact rather than a
    // suggestion.
    let not_workspace = match workspace {
        Some(ws) => format!("AND t.database != '{}' ", ws.replace('\'', "''")),
        None => String::new(),
    };

    // The alias is `qualified`, not `name`: `concat(database, '.', name) AS
    // name` shadows the real column, and the same expression in the WHERE then
    // resolves to the alias instead — which silently reported every table as
    // unread.
    let unused_sql = format!(
        "WITH selected AS ( \
             SELECT DISTINCT t FROM system.query_log \
             ARRAY JOIN tables AS t \
             WHERE type != 'QueryStart' AND query_kind = 'Select' {ours}\
               AND event_time > now() - INTERVAL {days} DAY \
         ), \
         stored AS ( \
             SELECT database AS db, table AS tbl, \
                    max(modification_time) AS written, \
                    sum(bytes_on_disk) AS disk \
             FROM system.parts WHERE active GROUP BY db, tbl \
         ) \
         SELECT concat(t.database, '.', t.name)               AS qualified, \
                t.engine                                      AS engine, \
                ifNull(t.total_rows, 0)                       AS row_count, \
                s.disk                                        AS bytes, \
                toString(s.written)                           AS last_write \
         FROM system.tables AS t \
         LEFT JOIN stored AS s ON s.db = t.database AND s.tbl = t.name \
         WHERE t.{USER_DATABASES} \
           {not_workspace}\
           AND t.engine NOT LIKE '%View' \
           AND t.engine != 'Dictionary' \
           AND concat(t.database, '.', t.name) NOT IN (SELECT t FROM selected) \
         ORDER BY bytes DESC \
         LIMIT {limit}"
    );

    let traffic = match rows_or_denial::<TableTraffic>(ch, &traffic_sql, "query_log").await? {
        Ok(rows) => rows,
        Err(reason) => return Ok(TrafficReport::unavailable(days, reason)),
    };
    let unused = match rows_or_denial::<UnusedTable>(ch, &unused_sql, "parts").await? {
        Ok(rows) => rows,
        Err(reason) => return Ok(TrafficReport::unavailable(days, reason)),
    };

    Ok(TrafficReport {
        available: true,
        reason: None,
        window_days: days,
        traffic,
        unused,
    })
}

// ── Storage ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableStorage {
    pub qualified: String,
    pub row_count: u64,
    pub compressed: u64,
    pub uncompressed: u64,
    #[serde(deserialize_with = "lenient_f64")]
    pub ratio: f64,
    pub parts: u64,
    pub partitions: u64,
    pub pk_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartitionLoad {
    pub qualified: String,
    /// The opaque id, which is what an action takes — `partition` is the human
    /// expression and cannot be put in a statement without knowing the key's
    /// type.
    pub partition_id: String,
    /// The two halves as well as the joined name, because an action needs them
    /// separately and splitting `qualified` on a dot is wrong: a ClickHouse
    /// database name may contain one.
    pub database: String,
    pub table: String,
    /// `tuple()` when the table has no partition key at all.
    pub partition: String,
    pub parts: u64,
    pub row_count: u64,
    pub bytes: u64,
    pub avg_part: u64,
}

/// The server's own limits, read rather than assumed: the documented defaults
/// are not what every build ships, and a threshold you guessed wrong turns a
/// healthy table into a false alarm.
#[derive(Debug, Clone, Serialize)]
pub struct Thresholds {
    pub delay_insert: u64,
    pub throw_insert: u64,
    /// False when the settings table could not be read and the documented
    /// defaults are standing in.
    pub from_server: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub tables: Vec<TableStorage>,
    pub partitions: Vec<PartitionLoad>,
    pub thresholds: Thresholds,
}

/// What the data costs on disk, how well it compresses, and how it is cut up.
pub async fn storage(ch: &Client, limit: u64) -> Result<StorageReport> {
    let limit = limit.clamp(1, 200);
    // `primary_key_bytes_in_memory` is the part of a table that is always
    // resident; it is also one of the columns ClickHouse has moved.
    let pk = ch
        .col_or("parts", "primary_key_bytes_in_memory", "0")
        .await?;

    let tables_sql = format!(
        "SELECT concat(database, '.', table)                  AS qualified, \
                sum(rows)                                     AS row_count, \
                sum(data_compressed_bytes)                    AS compressed, \
                sum(data_uncompressed_bytes)                  AS uncompressed, \
                round(sum(data_uncompressed_bytes) / greatest(sum(data_compressed_bytes), 1), 2) AS ratio, \
                count()                                       AS parts, \
                uniqExact(partition)                          AS partitions, \
                sum({pk})                                     AS pk_bytes \
         FROM system.parts \
         WHERE active AND {USER_DATABASES} \
         GROUP BY database, table \
         ORDER BY compressed DESC \
         LIMIT {limit}"
    );

    let partitions_sql = format!(
        "SELECT concat(database, '.', table)                  AS qualified, \
                database                                      AS database, \
                table                                         AS table, \
                partition, \
                any(partition_id)                             AS partition_id, \
                count()                                       AS parts, \
                sum(rows)                                     AS row_count, \
                sum(bytes_on_disk)                            AS bytes, \
                toUInt64(round(avg(bytes_on_disk)))           AS avg_part \
         FROM system.parts \
         WHERE active AND {USER_DATABASES} \
         GROUP BY database, table, partition \
         ORDER BY parts DESC, bytes DESC \
         LIMIT {limit}"
    );

    let tables = match rows_or_denial::<TableStorage>(ch, &tables_sql, "parts").await? {
        Ok(rows) => rows,
        Err(reason) => {
            return Ok(StorageReport {
                available: false,
                reason: Some(reason),
                tables: Vec::new(),
                partitions: Vec::new(),
                thresholds: thresholds(ch).await,
            })
        }
    };
    let partitions = match rows_or_denial::<PartitionLoad>(ch, &partitions_sql, "parts").await? {
        Ok(rows) => rows,
        Err(reason) => {
            return Ok(StorageReport {
                available: false,
                reason: Some(reason),
                tables: Vec::new(),
                partitions: Vec::new(),
                thresholds: thresholds(ch).await,
            })
        }
    };

    Ok(StorageReport {
        available: true,
        reason: None,
        tables,
        partitions,
        thresholds: thresholds(ch).await,
    })
}

/// Documented defaults, used only when the server will not say.
const DEFAULT_DELAY_INSERT: u64 = 1_000;
const DEFAULT_THROW_INSERT: u64 = 3_000;

async fn thresholds(ch: &Client) -> Thresholds {
    #[derive(Deserialize)]
    struct Row {
        name: String,
        value: String,
    }
    let sql = "SELECT name, toString(value) AS value FROM system.merge_tree_settings \
               WHERE name IN ('parts_to_delay_insert', 'parts_to_throw_insert')";
    let rows = ch.rows::<Row>(sql).await.unwrap_or_default();
    let pick = |wanted: &str| {
        rows.iter()
            .find(|r| r.name == wanted)
            .and_then(|r| r.value.parse::<u64>().ok())
    };
    match (pick("parts_to_delay_insert"), pick("parts_to_throw_insert")) {
        (Some(delay), Some(throw)) => Thresholds {
            delay_insert: delay,
            throw_insert: throw,
            from_server: true,
        },
        _ => Thresholds {
            delay_insert: DEFAULT_DELAY_INSERT,
            throw_insert: DEFAULT_THROW_INSERT,
            from_server: false,
        },
    }
}

// ── Replication ────────────────────────────────────────────────────────────

/// One replicated table, as its own replica sees it.
///
/// The figures that matter are not the obvious ones. `absolute_delay` is how far
/// behind this replica is in seconds; `log_max_index - log_pointer` is how many
/// log entries it has not caught up on, which moves first. And `is_readonly` is
/// the state everybody hits: a replica that has lost its Keeper session stops
/// accepting writes and keeps serving reads, so nothing looks wrong until an
/// insert fails.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Replica {
    pub database: String,
    pub table: String,
    pub engine: String,
    pub is_leader: bool,
    pub is_readonly: bool,
    pub session_expired: bool,
    /// Seconds behind. Zero on a replica with nothing to catch up on.
    pub absolute_delay: u64,
    /// How long it has been read-only, when it is.
    pub readonly_for: u64,
    /// What to do about it, when it is read-only. Empty otherwise.
    ///
    /// A sentence rather than a control, because the repair for the worst case
    /// is `SYSTEM RESTORE REPLICA` and Flint has watched that refuse but never
    /// succeed — see `sysops::readonly_remedy` for the three attempts at
    /// provoking the state it fixes. The page names the statement; running it is
    /// somebody's decision.
    #[serde(default)]
    pub remedy: String,
    pub queue_size: u64,
    pub inserts_in_queue: u64,
    pub merges_in_queue: u64,
    /// Log entries not yet applied. Floored at zero on purpose: `log_pointer`
    /// legitimately runs ahead of `log_max_index` on a caught-up replica, and a
    /// raw subtraction would have this page announce "-1 entries behind".
    pub behind_log: u64,
    pub total_replicas: u64,
    pub active_replicas: u64,
    /// Parts ClickHouse gave up on. Not zero means data was lost.
    pub lost_parts: u64,
    pub oldest_queued: String,
    pub queue_exception: String,
    pub zookeeper_exception: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReplicationReport {
    /// False where `system.replicas` cannot be read. Distinct from a server
    /// that simply has no replicated tables, which is `available` and empty.
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub replicas: Vec<Replica>,
}

/// Replication, as each replica reports itself.
pub async fn replication(ch: &Client) -> Result<ReplicationReport> {
    if let Some(reason) = blocked(ch.reach("replicas").await?, "replicas") {
        return Ok(ReplicationReport {
            available: false,
            reason: Some(reason),
            replicas: Vec::new(),
        });
    }

    // `readonly_duration` and `lost_part_count` are recent additions; an older
    // server loses the figure rather than the page.
    // `Nullable(UInt64)`: null while the replica is *not* read-only, which
    // `is_readonly` already says. Zero is the honest stand-in.
    let readonly_for = ch
        .col_or("replicas", "readonly_duration", "0")
        .await
        .map(|c| {
            if c == "0" {
                c
            } else {
                format!("ifNull({c}, 0)")
            }
        })?;
    let lost = ch.col_or("replicas", "lost_part_count", "0").await?;

    let sql = format!(
        "SELECT database                                  AS database, \
                table                                     AS table, \
                engine                                    AS engine, \
                CAST(is_leader != 0 AS Bool)              AS is_leader, \
                CAST(is_readonly != 0 AS Bool)            AS is_readonly, \
                CAST(is_session_expired != 0 AS Bool)     AS session_expired, \
                toUInt64(absolute_delay)                  AS absolute_delay, \
                toUInt64({readonly_for})                  AS readonly_for, \
                queue_size                                AS queue_size, \
                inserts_in_queue                          AS inserts_in_queue, \
                merges_in_queue                           AS merges_in_queue, \
                greatest(toInt64(log_max_index) - toInt64(log_pointer), 0) AS behind_log, \
                total_replicas                            AS total_replicas, \
                active_replicas                           AS active_replicas, \
                toUInt64({lost})                          AS lost_parts, \
                toString(queue_oldest_time)               AS oldest_queued, \
                last_queue_update_exception               AS queue_exception, \
                zookeeper_exception                       AS zookeeper_exception \
         FROM system.replicas \
         ORDER BY database, table \
         LIMIT 2000"
    );

    match rows_or_denial::<Replica>(ch, &sql, "replicas").await? {
        Ok(mut replicas) => {
            // Filled after the read rather than in SQL: it is prose about a
            // state, and the state is what the row already says.
            for r in replicas.iter_mut().filter(|r| r.is_readonly) {
                r.remedy = super::sysops::readonly_remedy(&r.database, &r.table, r.readonly_for);
            }
            Ok(ReplicationReport {
                available: true,
                reason: None,
                replicas,
            })
        }
        Err(reason) => Ok(ReplicationReport {
            available: false,
            reason: Some(reason),
            replicas: Vec::new(),
        }),
    }
}

// ── Published endpoint usage ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiUsage {
    /// Filled in from the tag after the query returns.
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    tag: String,
    pub calls: u64,
    pub failures: u64,
    #[serde(deserialize_with = "lenient_f64")]
    pub avg_ms: f64,
    #[serde(deserialize_with = "lenient_f64")]
    pub p95_ms: f64,
    pub read_rows: u64,
    pub read_bytes: u64,
    pub last_call: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub window_days: u64,
    pub usage: Vec<ApiUsage>,
}

/// How much each published endpoint is actually called.
///
/// Read from the tag Flint stamps on every published call rather than from a
/// log of its own: the question is already answerable, and a second write on
/// every API request would be a real cost for a duplicate answer. The trade is
/// stated where it matters — with `system.query_log` off, there is no usage to
/// show, and the page says so rather than showing zeroes.
pub async fn api_usage(ch: &Client, days: u64) -> Result<UsageReport> {
    let days = window(days);
    if let Some(reason) = blocked(ch.reach("query_log").await?, "query_log") {
        return Ok(UsageReport {
            available: false,
            reason: Some(reason),
            window_days: days,
            usage: Vec::new(),
        });
    }

    let prefix = crate::published::CALL_TAG_PREFIX;
    // The tag comes back whole and is parsed in Rust: `replaceOne` would also
    // strip the prefix out of the middle of somebody else's comment, and it
    // cannot check that what remains is a slug Flint would ever have issued.
    let sql = format!(
        "SELECT log_comment                                   AS tag, \
                count()                                       AS calls, \
                countIf(exception_code != 0)                  AS failures, \
                round(avg(query_duration_ms), 1)              AS avg_ms, \
                round(quantile(0.95)(query_duration_ms), 1)   AS p95_ms, \
                sum(read_rows)                                AS read_rows, \
                sum(read_bytes)                               AS read_bytes, \
                toString(max(event_time))                     AS last_call \
         FROM system.query_log \
         WHERE type != 'QueryStart' \
           AND event_time > now() - INTERVAL {days} DAY \
           AND startsWith(log_comment, '{prefix}') \
         GROUP BY log_comment \
         ORDER BY calls DESC \
         LIMIT 200"
    );

    match rows_or_denial::<ApiUsage>(ch, &sql, "query_log").await? {
        Ok(rows) => Ok(UsageReport {
            available: true,
            reason: None,
            window_days: days,
            usage: rows
                .into_iter()
                .filter_map(|mut row| {
                    let slug = crate::published::slug_of_tag(&row.tag)?.to_string();
                    row.slug = slug;
                    row.tag = String::new();
                    Some(row)
                })
                .collect(),
        }),
        Err(reason) => Ok(UsageReport {
            available: false,
            reason: Some(reason),
            window_days: days,
            usage: Vec::new(),
        }),
    }
}

// ── Activity, right now ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Merge {
    pub qualified: String,
    #[serde(deserialize_with = "lenient_f64")]
    pub elapsed: f64,
    #[serde(deserialize_with = "lenient_f64")]
    pub progress: f64,
    pub num_parts: u64,
    pub bytes: u64,
    pub is_mutation: bool,
    pub memory: u64,
    pub result: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mutation {
    pub qualified: String,
    pub mutation_id: String,
    pub command: String,
    pub created: String,
    pub parts_to_do: u64,
    pub done: bool,
    pub fail_reason: String,
}

/// A query in flight. The one view an operator reaches for first when a server
/// is misbehaving, and the only one that can answer "what is doing this".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Running {
    pub query_id: String,
    pub user: String,
    pub query: String,
    pub kind: String,
    pub database: String,
    #[serde(deserialize_with = "lenient_f64")]
    pub elapsed: f64,
    pub read_rows: u64,
    pub read_bytes: u64,
    pub written_rows: u64,
    /// ClickHouse's own estimate of the total, when it has one. Zero means it
    /// does not know yet, which is not the same as zero rows to read.
    pub total_rows: u64,
    pub memory: u64,
    pub peak_memory: u64,
    pub threads: u64,
    pub cancelled: bool,
    pub client: String,
}

/// Free space, which is the incident nobody sees coming.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Disk {
    pub name: String,
    pub path: String,
    pub free: u64,
    pub total: u64,
    /// What ClickHouse refuses to fill — free space is only free above this.
    pub keep_free: u64,
    pub kind: String,
    pub read_only: bool,
    pub broken: bool,
}

/// A server-lifetime error counter. Some of these never reach `query_log`
/// because nothing failed a query — they are the background noise a server
/// makes, and a rising one is a lead.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorCount {
    pub name: String,
    pub code: i32,
    pub count: u64,
    pub last_seen: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub merges: Vec<Merge>,
    pub mutations: Vec<Mutation>,
    pub running: Vec<Running>,
    pub disks: Vec<Disk>,
    pub errors: Vec<ErrorCount>,
    /// Which of these lists this role may not read. Without it an empty list
    /// means both "nothing is happening" and "you cannot see what is
    /// happening", and those are not the same answer.
    pub denied: Vec<String>,
}

/// Work the server is doing this instant, and work it has not finished.
///
/// An empty list is the healthy answer for both, which is why they are reported
/// together: "no merges running, no mutations pending" is a sentence worth
/// being able to say.
pub async fn activity(ch: &Client) -> Result<ActivityReport> {
    let merges_sql = "SELECT concat(database, '.', table)      AS qualified, \
                             round(elapsed, 1)                 AS elapsed, \
                             round(progress, 3)                AS progress, \
                             num_parts, \
                             total_size_bytes_compressed       AS bytes, \
                             CAST(is_mutation AS Bool)         AS is_mutation, \
                             memory_usage                      AS memory, \
                             result_part_name                  AS result \
                      FROM system.merges \
                      ORDER BY elapsed DESC \
                      LIMIT 50";

    // Unfinished only: a completed mutation is history, and history is not a
    // diagnostic. The failure reason is the point — a mutation stuck on one
    // part reports it here and nowhere else in the UI.
    let mutations_sql = "SELECT concat(database, '.', table)    AS qualified, \
                                mutation_id, \
                                command, \
                                toString(create_time)          AS created, \
                                parts_to_do, \
                                CAST(is_done AS Bool)          AS done, \
                                latest_fail_reason             AS fail_reason \
                         FROM system.mutations \
                         WHERE NOT is_done \
                         ORDER BY create_time ASC \
                         LIMIT 50";

    // Flint's own introspection is left out: the query fetching this list is
    // itself running, and a page that mostly shows you Flint looking at Flint
    // answers nothing. `log_comment` is a setting, so it is visible here.
    let running_sql = format!(
        "SELECT query_id                                  AS query_id, \
                user                                       AS user, \
                query                                      AS query, \
                toString(query_kind)                       AS kind, \
                current_database                           AS database, \
                round(elapsed, 2)                          AS elapsed, \
                read_rows                                  AS read_rows, \
                read_bytes                                 AS read_bytes, \
                written_rows                               AS written_rows, \
                total_rows_approx                          AS total_rows, \
                memory_usage                               AS memory, \
                peak_memory_usage                          AS peak_memory, \
                length(thread_ids)                         AS threads, \
                CAST(is_cancelled != 0 AS Bool)            AS cancelled, \
                concat(client_name, ' ', http_user_agent)  AS client \
         FROM system.processes \
         WHERE Settings['log_comment'] != '{INTROSPECTION_TAG}' \
           AND is_internal = 0 \
         ORDER BY elapsed DESC \
         LIMIT 100"
    );

    let disks_sql = "SELECT name                              AS name, \
                            path                              AS path, \
                            free_space                        AS free, \
                            total_space                       AS total, \
                            keep_free_space                   AS keep_free, \
                            toString(type)                    AS kind, \
                            CAST(is_read_only != 0 AS Bool)   AS read_only, \
                            CAST(is_broken != 0 AS Bool)      AS broken \
                     FROM system.disks \
                     ORDER BY name";

    let errors_sql = "SELECT name                             AS name, \
                             code                             AS code, \
                             value                            AS count, \
                             toString(last_error_time)        AS last_seen, \
                             last_error_message               AS message \
                      FROM system.errors \
                      WHERE value > 0 \
                      ORDER BY value DESC \
                      LIMIT 30";

    let merges = match rows_or_denial::<Merge>(ch, merges_sql, "merges").await? {
        Ok(rows) => rows,
        Err(reason) => {
            return Ok(ActivityReport {
                available: false,
                reason: Some(reason),
                merges: Vec::new(),
                mutations: Vec::new(),
                running: Vec::new(),
                disks: Vec::new(),
                errors: Vec::new(),
                denied: Vec::new(),
            })
        }
    };
    // From here each list is optional on its own: a role granted
    // `system.merges` but not `system.processes` keeps the rest of the section,
    // and the one it lost is named rather than shown as empty.
    let mut denied = Vec::new();
    let mutations = or_denied(
        &mut denied,
        "mutations",
        rows_or_denial::<Mutation>(ch, mutations_sql, "mutations").await?,
    );
    let running = or_denied(
        &mut denied,
        "processes",
        rows_or_denial::<Running>(ch, &running_sql, "processes").await?,
    );
    let disks = or_denied(
        &mut denied,
        "disks",
        rows_or_denial::<Disk>(ch, disks_sql, "disks").await?,
    );
    let errors = or_denied(
        &mut denied,
        "errors",
        rows_or_denial::<ErrorCount>(ch, errors_sql, "errors").await?,
    );

    Ok(ActivityReport {
        available: true,
        reason: None,
        merges,
        mutations,
        running,
        disks,
        errors,
        denied,
    })
}

/// An empty list, and a note of which one was refused. A closure cannot do this
/// because each call has a different row type.
fn or_denied<T>(
    denied: &mut Vec<String>,
    what: &str,
    outcome: std::result::Result<Vec<T>, String>,
) -> Vec<T> {
    match outcome {
        Ok(rows) => rows,
        Err(_) => {
            denied.push(what.to_string());
            Vec::new()
        }
    }
}

/// Stop a query that is running now.
///
/// Allowed even where Flint is read-only, and the distinction is the point:
/// `FLINT_READONLY` promises Flint will not change *your data*. A KILL destroys
/// nothing — it stops work in progress — where `SYSTEM REFRESH VIEW` rewrites a
/// table and is refused. An operator staring at a runaway SELECT on a read-only
/// deployment is exactly who needs this.
pub async fn kill(ch: &Client, query_id: &str) -> Result<String> {
    // A ClickHouse query id is any string the client chose — Flint mints UUIDs
    // for its own, but another tool may send `nightly-rollup-3`. Requiring a
    // UUID here rejected exactly the queries an operator most wants to stop,
    // and bought nothing: the id goes to ClickHouse as a bound parameter, so it
    // cannot become SQL whatever it contains.
    let id = query_id.trim();
    if id.is_empty() || id.len() > 256 {
        return Err(Error::BadRequest(
            "a query id is between 1 and 256 characters".into(),
        ));
    }
    #[derive(Deserialize)]
    struct Killed {
        /// ClickHouse's own word for what it did — `waiting`, `finished`. An
        /// empty result means the query had already ended.
        #[serde(default)]
        kill_status: String,
    }
    // `KILL ... SYNC` waits, which can hang this request behind a query that
    // ignores the signal; ASYNC asks and returns, and the list refreshes.
    let rows: Vec<Killed> = ch
        .rows_with(
            "KILL QUERY WHERE query_id = {id:String} ASYNC",
            super::QueryOptions {
                params: vec![("id".into(), id.to_string())],
                allow_write: true,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;
    Ok(rows
        .into_iter()
        .next()
        .map(|k| k.kill_status)
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_caught_up_replica_is_never_negatively_behind() {
        // `log_pointer` runs ahead of `log_max_index` on a healthy replica —
        // observed as 1 against 0 on a fresh table — so the difference is
        // floored rather than shown.
        // Mirrors the `greatest(toInt64(log_max_index) - toInt64(log_pointer), 0)`
        // in the query above: ahead or level reads as caught up, and only a real
        // gap is reported.
        for (max, pointer, expected) in [(0i64, 1i64, 0i64), (5, 7, 0), (10, 10, 0), (12, 4, 8)] {
            assert_eq!((max - pointer).max(0), expected, "{max} vs {pointer}");
        }
    }

    #[test]
    fn a_query_id_is_whatever_the_client_called_it() {
        // ClickHouse ids are arbitrary strings; a UUID check here rejected the
        // queries an operator most wants to stop.
        for id in ["slow-one-aaaa", "nightly rollup 3", "a", "üñî"] {
            assert!(!id.trim().is_empty() && id.len() <= 256, "{id}");
        }
    }

    #[test]
    fn window_stays_within_something_a_log_can_answer() {
        assert_eq!(window(7), 7);
        assert_eq!(window(0), 1, "a zero-day window has no answer in it");
        assert_eq!(window(9_999), 90);
    }

    #[test]
    fn a_grant_and_a_setting_are_different_sentences() {
        // The whole point of the probe: these send the reader to different
        // places, so they must not share a message.
        let denied = blocked(Reach::Denied, "query_log").unwrap();
        let absent = blocked(Reach::Absent, "query_log").unwrap();
        assert!(denied.contains("granted"), "{denied}");
        assert!(absent.contains("not enabled"), "{absent}");
        assert_ne!(denied, absent);
        assert!(blocked(Reach::Readable, "query_log").is_none());
    }

    #[test]
    fn an_unknown_system_table_is_named_in_its_own_reason() {
        assert_eq!(
            blocked(Reach::Absent, "projections").unwrap(),
            "this server has no system.projections"
        );
    }

    #[test]
    fn a_null_average_reads_as_zero() {
        // ClickHouse sends `null` for nan, which is what an average over no
        // rows is. A summary of an empty window must still deserialise.
        let json = r#"{"queries":0,"failures":0,"selects":0,"inserts":0,"read_bytes":0,
                       "read_rows":0,"avg_ms":null,"p95_ms":null,"max_ms":0,"users":0,
                       "since":"1970-01-01 00:00:00"}"#;
        let s: Summary = serde_json::from_str(json).expect("an empty window still parses");
        assert_eq!(s.avg_ms, 0.0);
        assert_eq!(s.p95_ms, 0.0);
    }

    #[test]
    fn traffic_tolerates_a_table_nothing_read() {
        let json = r#"{"qualified":"a.b","reads":0,"writes":3,"read_rows":0,"read_bytes":0,
                       "avg_ms":null,"readers":0,"last_read":"1970-01-01 00:00:00"}"#;
        let t: TableTraffic = serde_json::from_str(json).expect("write-only tables parse");
        assert_eq!(t.avg_ms, 0.0);
        assert_eq!(t.writes, 3);
    }
}

#[cfg(test)]
mod workspace_tests {
    /// The workspace filter is built by hand into SQL, so the quoting is worth
    /// pinning: a database name with an apostrophe must not end the literal.
    #[test]
    fn a_quote_in_the_workspace_name_cannot_escape_the_literal() {
        let ws = "it's";
        let clause = format!("AND t.database != '{}' ", ws.replace('\'', "''"));
        assert_eq!(clause, "AND t.database != 'it''s' ");
    }
}
