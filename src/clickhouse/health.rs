//! What the server has been doing, not just what it is doing.
//!
//! Every figure Flint showed about the machine until now was a single instant:
//! memory *now*, merges *now*, delayed inserts *now*. That answers "is it bad
//! right now" and nothing else — and the question an operator actually has is
//! "was it always like this", which needs a line rather than a number.
//!
//! `system.metric_log` is where that line comes from. One row a second, and on
//! this version 1911 columns of it: `CurrentMetric_*` are gauges — what the
//! value was at that instant — and `ProfileEvent_*` are already **deltas** for
//! the interval, not running totals. So gauges aggregate with `max` and events
//! with `sum`, and getting that backwards silently turns a busy second into a
//! flat line.
//!
//! `max` rather than `avg` for the gauges, deliberately. A minute in which memory
//! touched 40 GB for two seconds is a minute worth seeing; averaged with the
//! other fifty-eight it disappears, and the page would report calm where there
//! was a spike.

use serde::{Deserialize, Serialize};

use super::{Client, QueryOptions};
use crate::error::Result;

/// One instant on one line. `v` is null where the figure is not *measurable* in
/// that bucket rather than zero — a cache hit rate with no cache reads behind it
/// is unknown, and drawing it as 0% would invent a bad minute.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Point {
    pub t: String,
    pub v: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Series {
    /// Stable identifier the UI keys its layout on.
    pub key: &'static str,
    pub label: String,
    /// One line saying what the reader is looking at and why it matters. These
    /// are metrics with names only a ClickHouse developer would recognise, and a
    /// chart nobody can interpret is decoration.
    pub says: &'static str,
    /// `bytes`, `count` or `percent` — how the UI should format it.
    pub unit: &'static str,
    /// The ceiling this metric is measured against, where it has one. A pool
    /// with 16 slots at 15 tasks is the story; 15 on its own is a number.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
    pub points: Vec<Point>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SeriesReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// How wide one bucket is. Stated because it decides what the line can
    /// possibly show: a spike shorter than a bucket is a spike this page cannot
    /// see, and the reader should know which.
    pub step_seconds: u64,
    /// The window actually covered, which is not the window asked for when the
    /// log has been running for less time than that.
    pub from: String,
    pub series: Vec<Series>,
}

/// Buckets sized so a window is about two hundred points.
///
/// Wide enough that the query stays cheap on a log with a row per second, narrow
/// enough that a line has shape. Floored at the log's own resolution: asking for
/// buckets smaller than a second would invent detail that was never recorded.
pub fn step_for_hours(hours: u64) -> u64 {
    (hours.max(1) * 3600 / 200).max(1)
}

/// The metrics worth a line, and what to say about each.
///
/// Five, not fifty. `system.metric_log` has 1911 columns and a page that draws
/// them all is a page nobody reads; these are the ones that answer a question
/// somebody actually has when a ClickHouse is unhappy.
pub async fn series(ch: &Client, hours: u64, step: u64) -> Result<SeriesReport> {
    if let Some(reason) = blocked(ch).await? {
        return Ok(SeriesReport {
            available: false,
            reason: Some(reason),
            step_seconds: step,
            from: String::new(),
            series: Vec::new(),
        });
    }

    // Every one of these is version-dependent — the column set moves between
    // releases — so a missing one costs its line rather than the page.
    let memory = ch
        .col_or("metric_log", "CurrentMetric_MemoryTracking", "0")
        .await?;
    let queries = ch.col_or("metric_log", "CurrentMetric_Query", "0").await?;
    let merges = ch
        .col_or(
            "metric_log",
            "CurrentMetric_BackgroundMergesAndMutationsPoolTask",
            "0",
        )
        .await?;
    let pool = ch
        .col_or(
            "metric_log",
            "CurrentMetric_BackgroundMergesAndMutationsPoolSize",
            "0",
        )
        .await?;
    let delayed = ch
        .col_or("metric_log", "CurrentMetric_DelayedInserts", "0")
        .await?;
    let hits = ch
        .col_or("metric_log", "ProfileEvent_MarkCacheHits", "0")
        .await?;
    let misses = ch
        .col_or("metric_log", "ProfileEvent_MarkCacheMisses", "0")
        .await?;

    #[derive(Deserialize)]
    struct Row {
        t: String,
        memory: f64,
        queries: f64,
        merges: f64,
        pool: f64,
        delayed: f64,
        hits: f64,
        misses: f64,
    }

    let sql = format!(
        "SELECT toString(toStartOfInterval(event_time, INTERVAL {step} SECOND)) AS t, \
                toFloat64(max({memory}))   AS memory, \
                toFloat64(max({queries}))  AS queries, \
                toFloat64(max({merges}))   AS merges, \
                toFloat64(max({pool}))     AS pool, \
                toFloat64(max({delayed}))  AS delayed, \
                toFloat64(sum({hits}))     AS hits, \
                toFloat64(sum({misses}))   AS misses \
         FROM system.metric_log \
         WHERE event_time > now() - INTERVAL {hours} HOUR \
         GROUP BY t \
         ORDER BY t"
    );

    let rows: Vec<Row> = ch
        .rows_with(
            &sql,
            QueryOptions {
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;

    let from = rows.first().map(|r| r.t.clone()).unwrap_or_default();
    // The pool's size is a setting, not a measurement: the ceiling for the whole
    // window is the largest it was seen to be.
    let pool_limit = rows.iter().map(|r| r.pool).fold(0.0_f64, f64::max);

    let line = |key: &'static str,
                label: &str,
                says: &'static str,
                unit: &'static str,
                limit: Option<f64>,
                pick: &dyn Fn(&Row) -> Option<f64>| Series {
        key,
        label: label.to_string(),
        says,
        unit,
        limit,
        points: rows
            .iter()
            .map(|r| Point {
                t: r.t.clone(),
                v: pick(r),
            })
            .collect(),
    };

    Ok(SeriesReport {
        available: true,
        reason: None,
        step_seconds: step,
        from,
        series: vec![
            line(
                "memory",
                "Memory tracked",
                "What ClickHouse knows it allocated. Compared against the server's limit, this is the number that decides whether the next query is refused.",
                "bytes",
                None,
                &|r| Some(r.memory),
            ),
            line(
                "queries",
                "Queries running",
                "Concurrency, at the peak of each bucket. A flat ceiling here usually means a queue somewhere else.",
                "count",
                None,
                &|r| Some(r.queries),
            ),
            line(
                "merges",
                "Merge pool in use",
                "Background merges and mutations against the pool's own size. At the ceiling, new parts pile up faster than they are combined — which is where too-many-parts starts.",
                "count",
                (pool_limit > 0.0).then_some(pool_limit),
                &|r| Some(r.merges),
            ),
            line(
                "delayed",
                "Inserts being slowed",
                "ClickHouse deliberately delaying inserts because a partition has too many parts. Anything but zero here is the server asking for help.",
                "count",
                None,
                &|r| Some(r.delayed),
            ),
            line(
                "mark_cache",
                "Mark cache hit rate",
                "How often a read found its marks in memory. Null where nothing read any marks in that bucket — an idle minute has no hit rate, and drawing it as zero would invent a bad one.",
                "percent",
                Some(100.0),
                &|r| {
                    let total = r.hits + r.misses;
                    (total > 0.0).then(|| r.hits / total * 100.0)
                },
            ),
        ],
    })
}

/// The levels at or worse than the one asked for, by name.
///
/// Named rather than numbered, after two attempts at the arithmetic. `level` is
/// `Enum8('Fatal' = 1 … 'Test' = 9)`, and neither obvious comparison works:
/// `level <= CAST('Warning' AS Enum8(…))` promotes both sides to String, where
/// `'Debug' <= 'Warning'` is true alphabetically and the filter returns the whole
/// log; `toUInt8(level)` goes through `toString` first and fails trying to parse
/// `'Trace'` as a number. An `IN` over names has neither problem, and the SQL
/// then says what it means to anybody reading it.
///
/// Empty means no filter at all. An unrecognised name lands there, which is the
/// only safe direction for a log: showing too much is a nuisance, hiding the line
/// somebody came for is a failure.
fn levels_at_or_worse(name: &str) -> &'static str {
    match name {
        "error" => "'Fatal', 'Critical', 'Error'",
        "warning" => "'Fatal', 'Critical', 'Error', 'Warning'",
        "information" => "'Fatal', 'Critical', 'Error', 'Warning', 'Notice', 'Information'",
        "debug" => "'Fatal', 'Critical', 'Error', 'Warning', 'Notice', 'Information', 'Debug'",
        _ => "",
    }
}

/// One error, counted over a window rather than over the life of the process.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorCount {
    pub name: String,
    pub code: i32,
    /// How many times in the window. `system.error_log` records a delta per
    /// flush, not a running total, so this is a sum and not a difference.
    pub times: u64,
    pub last: String,
    /// The most recent message for this error. One clause is usually all of it;
    /// ClickHouse appends paragraphs to some, and the reader gets what fits.
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Whether these are counted over the window asked for, or over the whole
    /// life of the server.
    ///
    /// The distinction is the entire point of this endpoint. "42 access denied"
    /// means one thing about the last six hours and something else about the
    /// eleven days since a restart, and a panel that does not say which is a
    /// panel nobody can act on. `system.error_log` gives the first;
    /// `system.errors` is the fallback and gives only the second.
    pub windowed: bool,
    pub errors: Vec<ErrorCount>,
    /// Errors per bucket across the window, for a line. Empty where only the
    /// lifetime snapshot was available — there is no history to draw.
    pub points: Vec<Point>,
}

/// What has been going wrong, and when.
///
/// Prefers `system.error_log`, which samples the counters over time, and falls
/// back to `system.errors`, which is a single snapshot since the server started.
/// Both are worth having and they are not the same fact, so the answer says which
/// one it is rather than quietly changing meaning.
pub async fn errors(ch: &Client, hours: u64, step: u64) -> Result<ErrorReport> {
    match ch.reach("error_log").await? {
        super::Reach::Readable => windowed_errors(ch, hours, step).await,
        // Denied or absent: the lifetime snapshot is still there, and it is
        // better than nothing as long as it says what it is.
        _ => lifetime_errors(ch).await,
    }
}

async fn windowed_errors(ch: &Client, hours: u64, step: u64) -> Result<ErrorReport> {
    #[derive(Deserialize)]
    struct Row {
        name: String,
        code: i32,
        times: u64,
        last: String,
        message: String,
    }
    let sql = format!(
        "SELECT error                                       AS name, \
                toInt32(any(code))                          AS code, \
                toUInt64(sum(value))                        AS times, \
                toString(max(last_error_time))              AS last, \
                argMax(last_error_message, last_error_time) AS message \
         FROM system.error_log \
         WHERE event_time > now() - INTERVAL {hours} HOUR \
         GROUP BY error \
         ORDER BY times DESC \
         LIMIT 40"
    );
    let rows: Vec<Row> = ch.rows(&sql).await?;

    #[derive(Deserialize)]
    struct Bucket {
        t: String,
        n: f64,
    }
    let series_sql = format!(
        "SELECT toString(toStartOfInterval(event_time, INTERVAL {step} SECOND)) AS t, \
                toFloat64(sum(value))                                          AS n \
         FROM system.error_log \
         WHERE event_time > now() - INTERVAL {hours} HOUR \
         GROUP BY t \
         ORDER BY t"
    );
    let buckets: Vec<Bucket> = ch
        .rows_with(
            &series_sql,
            QueryOptions {
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;

    Ok(ErrorReport {
        available: true,
        reason: None,
        windowed: true,
        errors: rows
            .into_iter()
            .map(|r| ErrorCount {
                name: r.name,
                code: r.code,
                times: r.times,
                last: r.last,
                message: r.message,
            })
            .collect(),
        points: buckets
            .into_iter()
            .map(|b| Point {
                t: b.t,
                v: Some(b.n),
            })
            .collect(),
    })
}

async fn lifetime_errors(ch: &Client) -> Result<ErrorReport> {
    if let Some(reason) = blocked_table(ch, "errors").await? {
        return Ok(ErrorReport {
            available: false,
            reason: Some(reason),
            windowed: false,
            errors: Vec::new(),
            points: Vec::new(),
        });
    }
    #[derive(Deserialize)]
    struct Row {
        name: String,
        code: i32,
        times: u64,
        last: String,
        message: String,
    }
    // `value` here *is* cumulative — it is the counter itself, not a sample of
    // it — which is exactly why this answer means something different.
    let sql = "SELECT name                        AS name, \
                      toInt32(code)               AS code, \
                      toUInt64(value)             AS times, \
                      toString(last_error_time)   AS last, \
                      last_error_message          AS message \
               FROM system.errors \
               WHERE value > 0 \
               ORDER BY value DESC \
               LIMIT 40";
    let rows: Vec<Row> = ch.rows(sql).await?;
    Ok(ErrorReport {
        available: true,
        reason: None,
        windowed: false,
        errors: rows
            .into_iter()
            .map(|r| ErrorCount {
                name: r.name,
                code: r.code,
                times: r.times,
                last: r.last,
                message: r.message,
            })
            .collect(),
        points: Vec::new(),
    })
}

/// One table's merging, over a window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergedTable {
    pub qualified: String,
    pub merges: u64,
    pub rows: u64,
    pub bytes: u64,
    pub avg_ms: u64,
    /// The worst single merge. A table whose average is a second and whose worst
    /// is four minutes has a story the average hides.
    pub worst_ms: u64,
    /// Merges that ended in an error. Zero on a healthy server, and the first
    /// number to read when it is not.
    pub failed: u64,
    /// The share of merges the TTL asked for rather than the merge scheduler.
    /// A table that spends its merging on expiry is doing different work from one
    /// that is combining new parts, and the two look identical in a count.
    pub ttl_merges: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MergeReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub step_seconds: u64,
    /// Merges per bucket and bytes written per bucket, in the same shape the
    /// other lines use so the drawing code is the same drawing code.
    pub series: Vec<Series>,
    pub tables: Vec<MergedTable>,
    /// Everything merged in the window, not just the tables listed — a list cut
    /// at twenty reads as the whole truth otherwise.
    pub total_tables: u64,
    pub failed: u64,
    /// The most recent merge failure, where there was one.
    pub last_exception: String,
}

/// What this server has been merging.
///
/// `system.part_log` records one row per part event, and the one that matters
/// here is `MergeParts` — a merge that *finished*. `MergePartsStart` is the same
/// merge counted again at its beginning, and summing both would double every
/// figure on the page.
pub async fn merges(ch: &Client, hours: u64, step: u64, limit: u64) -> Result<MergeReport> {
    if let Some(reason) = blocked_table(ch, "part_log").await? {
        return Ok(MergeReport {
            available: false,
            reason: Some(reason),
            step_seconds: step,
            series: Vec::new(),
            tables: Vec::new(),
            total_tables: 0,
            failed: 0,
            last_exception: String::new(),
        });
    }

    #[derive(Deserialize)]
    struct Bucket {
        t: String,
        merges: f64,
        bytes: f64,
    }
    let series_sql = format!(
        "SELECT toString(toStartOfInterval(event_time, INTERVAL {step} SECOND)) AS t, \
                toFloat64(count())                                             AS merges, \
                toFloat64(sum(size_in_bytes))                                  AS bytes \
         FROM system.part_log \
         WHERE event_type = 'MergeParts' AND event_time > now() - INTERVAL {hours} HOUR \
         GROUP BY t \
         ORDER BY t"
    );
    let buckets: Vec<Bucket> = ch
        .rows_with(
            &series_sql,
            QueryOptions {
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;

    #[derive(Deserialize)]
    struct TableRow {
        qualified: String,
        merges: u64,
        rows: u64,
        bytes: u64,
        avg_ms: u64,
        worst_ms: u64,
        failed: u64,
        ttl_merges: u64,
    }
    let tables_sql = format!(
        "SELECT concat(database, '.', table)                       AS qualified, \
                toUInt64(count())                                  AS merges, \
                toUInt64(sum(rows))                                AS rows, \
                toUInt64(sum(size_in_bytes))                       AS bytes, \
                toUInt64(round(avg(duration_ms)))                  AS avg_ms, \
                toUInt64(max(duration_ms))                         AS worst_ms, \
                toUInt64(countIf(error != 0))                      AS failed, \
                toUInt64(countIf(merge_reason != 'RegularMerge'))  AS ttl_merges \
         FROM system.part_log \
         WHERE event_type = 'MergeParts' AND event_time > now() - INTERVAL {hours} HOUR \
         GROUP BY database, table \
         ORDER BY merges DESC \
         LIMIT {}",
        limit.clamp(1, 200)
    );
    let tables: Vec<TableRow> = ch.rows(&tables_sql).await?;

    #[derive(Deserialize)]
    struct Overall {
        total_tables: u64,
        failed: u64,
        last_exception: String,
    }
    let overall_sql = format!(
        "SELECT toUInt64(uniqExact((database, table)))           AS total_tables, \
                toUInt64(countIf(error != 0))                    AS failed, \
                argMax(exception, if(error != 0, event_time, toDateTime(0))) AS last_exception \
         FROM system.part_log \
         WHERE event_type = 'MergeParts' AND event_time > now() - INTERVAL {hours} HOUR"
    );
    let overall: Option<Overall> = ch.row(&overall_sql).await?;

    let line = |key: &'static str,
                label: &str,
                says: &'static str,
                unit: &'static str,
                pick: &dyn Fn(&Bucket) -> f64| Series {
        key,
        label: label.to_string(),
        says,
        unit,
        limit: None,
        points: buckets
            .iter()
            .map(|b| Point {
                t: b.t.clone(),
                v: Some(pick(b)),
            })
            .collect(),
    };

    Ok(MergeReport {
        available: true,
        reason: None,
        step_seconds: step,
        series: vec![
            line(
                "merges",
                "Merges finished",
                "One per merge that completed. `MergePartsStart` is the same merge counted at its beginning and is deliberately left out — summing both would double every figure here.",
                "count",
                &|b| b.merges,
            ),
            line(
                "merged_bytes",
                "Written by merges",
                "What the merges put back on disk. Read against the count: many small merges and few large ones are different problems.",
                "bytes",
                &|b| b.bytes,
            ),
        ],
        tables: tables
            .into_iter()
            .map(|t| MergedTable {
                qualified: t.qualified,
                merges: t.merges,
                rows: t.rows,
                bytes: t.bytes,
                avg_ms: t.avg_ms,
                worst_ms: t.worst_ms,
                failed: t.failed,
                ttl_merges: t.ttl_merges,
            })
            .collect(),
        total_tables: overall.as_ref().map(|o| o.total_tables).unwrap_or(0),
        failed: overall.as_ref().map(|o| o.failed).unwrap_or(0),
        last_exception: overall.map(|o| o.last_exception).unwrap_or_default(),
    })
}

/// One line of the server's own log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogLine {
    pub at: String,
    /// `Error`, `Warning`, `Information`, `Debug`, `Trace`.
    pub level: String,
    /// Where in ClickHouse it came from — a table, a background task, a pool.
    pub logger: String,
    pub message: String,
    /// The statement it belongs to, where it belongs to one. Empty for the
    /// server's own background chatter, which is most of it.
    pub query_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub lines: Vec<LogLine>,
}

/// The tail of `system.text_log` — the thing people open a shell for.
///
/// Errors and warnings by default, because the interesting lines are a rounding
/// error in the volume: this server has 2.2 million rows in that table and a few
/// hundred of them matter. `Debug` and `Trace` are available on request and
/// deliberately not the default — a page that opens on ten thousand lines of
/// trace is a page that hides the one line you wanted.
pub async fn log(ch: &Client, min_level: &str, limit: u64) -> Result<LogReport> {
    if let Some(reason) = blocked_table(ch, "text_log").await? {
        return Ok(LogReport {
            available: false,
            reason: Some(reason),
            lines: Vec::new(),
        });
    }

    // `Enum8('Fatal' = 1 … 'Test' = 9)`, so "this level and worse" is a numeric
    // comparison — and it has to be spelled as one. Comparing the column to a
    // `CAST('Warning' AS Enum8(…))` reads like it should work and does not:
    // ClickHouse promotes both sides to String, `'Debug' <= 'Warning'` is true
    // alphabetically, and the filter silently returns everything. Which is
    // exactly what it did.
    let wanted = levels_at_or_worse(min_level);
    let filter = if wanted.is_empty() {
        String::new()
    } else {
        format!("WHERE level IN ({wanted}) ")
    };

    let sql = format!(
        "SELECT toString(event_time)      AS at, \
                toString(level)           AS level, \
                logger_name               AS logger, \
                message                   AS message, \
                toString(query_id)        AS query_id \
         FROM system.text_log \
         {filter}\
         ORDER BY event_time DESC \
         LIMIT {}",
        limit.clamp(1, 500)
    );

    let lines: Vec<LogLine> = ch
        .rows_with(
            &sql,
            QueryOptions {
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;

    Ok(LogReport {
        available: true,
        reason: None,
        lines,
    })
}

async fn blocked(ch: &Client) -> Result<Option<String>> {
    blocked_table(ch, "metric_log").await
}

/// Why a history table cannot be read.
///
/// `Absent` is the common one and it is not a fault: both of these are switched
/// off in some deployments on purpose, and the sentence says how to turn them on
/// rather than implying something is broken.
async fn blocked_table(ch: &Client, table: &str) -> Result<Option<String>> {
    Ok(match ch.reach(table).await? {
        super::Reach::Readable => None,
        super::Reach::Denied => Some(format!("this user is not granted SELECT on system.{table}")),
        super::Reach::Absent => Some(format!(
            "system.{table} is switched off on this server, so there is no history to read — \
             `<{table}>` in the server configuration turns it on"
        )),
        super::Reach::Unconfigured => Some(format!("system.{table} cannot be read on this server")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_level_includes_everything_worse_than_it() {
        // The bug this guards: two different arithmetic spellings of the same
        // filter both silently returned the whole log. Names cannot go wrong the
        // same way, and this checks the nesting rather than the strings.
        let error = levels_at_or_worse("error");
        let warning = levels_at_or_worse("warning");
        let information = levels_at_or_worse("information");
        assert!(error.contains("'Fatal'") && error.contains("'Error'"));
        assert!(
            !error.contains("'Warning'"),
            "error must not include warnings"
        );
        assert!(
            warning.contains("'Error'"),
            "warning must include what is worse"
        );
        assert!(information.contains("'Warning'") && information.contains("'Notice'"));
        assert!(!information.contains("'Debug'"));
        // Everything: no filter at all, rather than a list of all nine.
        assert_eq!(levels_at_or_worse("trace"), "");
        assert_eq!(levels_at_or_worse("nonsense"), "");
    }

    #[test]
    fn buckets_are_sized_to_about_two_hundred_points() {
        // An hour in 18-second buckets, a day in seven-minute ones: enough shape
        // to see a spike, few enough rows to stay cheap on a log with one row a
        // second.
        assert_eq!(step_for_hours(1), 18);
        assert_eq!(step_for_hours(6), 108);
        assert_eq!(step_for_hours(24), 432);
    }

    #[test]
    fn a_bucket_is_never_finer_than_the_log_itself() {
        // Zero hours would divide to zero, and a zero-second interval is not a
        // query ClickHouse will run. The log has a row a second, so one second
        // is the floor that means anything.
        assert_eq!(step_for_hours(0), 18);
    }
}
