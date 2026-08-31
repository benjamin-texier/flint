//! Is this table's schema the right one for the data in it?
//!
//! Every column of a ClickHouse table was declared once, usually before anyone
//! knew what would go in it, and never revisited. The costs of getting it wrong
//! are quiet and large: a `String` holding six distinct values, a `Nullable`
//! that has never been null, an `Int64` counting to forty. None of it shows up
//! as an error — it shows up as disk, as slower scans, and as a `WHERE` that
//! cannot use an index because the date is stored as text.
//!
//! This module **measures**. It has no opinions: it counts distinct values,
//! nulls, empty strings, lengths, ranges, and how many values fail to parse as
//! the type they look like. Deciding what those numbers *mean* — and what DDL
//! would follow — is the frontend's `lib/review.ts`, where the rules are pure
//! functions with tests. The split is deliberate: rules are where the
//! judgement is, and judgement should be arguable in a test file rather than
//! buried in a SQL string.
//!
//! Two honesty rules run through it.
//!
//! A pass over part of the table is a **hypothesis**, and a pass over the whole
//! column is a **verdict**. They are not the same claim and the response says
//! which one it is: `verified`. "200,000 rows fit in a `UInt16`" is not "the
//! column fits in a `UInt16`", and a tool that conflates the two will eventually
//! propose an `ALTER` that truncates somebody's data.
//!
//! *Part*, and deliberately not *prefix*: the sample is `LIMIT` with no
//! `ORDER BY`, so ClickHouse reads granules in parallel and stops early, and the
//! rows it returns are some 200,000 rather than the first 200,000. That is the
//! better sample and not a shortcut — a genuine prefix of a table ordered by
//! time would only ever show the oldest data, and a column whose range widened
//! last month would look settled. It does mean the sample is not reproducible
//! between two runs, which is another reason a hypothesis is not a verdict.
//! Measured against 26.7.5: on 300,000 rows a value planted in the last 50,000
//! turned up in the sample; it took roughly 5,000,000 before the sample
//! reliably missed it.
//!
//! And a figure that cannot be had is absent rather than guessed. Per-column
//! bytes only exist in `Wide` parts — a `Compact` part keeps every column in one
//! file — so on a small table `compressed_bytes` is `None` and the UI says the
//! size is not measurable here rather than printing a confident zero.

use serde::Serialize;
use serde_json::Value;

use super::diagnostics::excluding_flint;
use super::meta::ColumnDetail;
use super::profile::{family, quote_ident};
use super::{Client, QueryOptions};
use crate::error::{Error, Result};

/// How far back the usage question looks. A week is long enough to catch a
/// weekly report and short enough to stay cheap on a busy `query_log` — and
/// short enough that "nothing read it" still means something, which a year
/// would not.
const USAGE_DAYS: u32 = 7;

/// Rows read when the review is a hypothesis rather than a verdict. Large
/// enough that a rare value is likely to be in it, small enough to be free.
const SAMPLE_ROWS: u64 = 200_000;

/// Where a `LowCardinality` stops paying, and therefore the only threshold the
/// distinct count has to resolve. An estimate is enough for it: a column with
/// 9,800 distinct values and one with 10,200 are the same decision either way.
const DISTINCT_CEILING: u64 = 10_000;

/// `uniqUpTo` refuses a parameter above 100 — measured, not assumed, against
/// 26.7: `Too large parameter for aggregate function uniqUpTo. Maximum: 100`.
/// So the exact count covers the small end, where exactness is what the rules
/// need ("one value throughout" must not be a guess), and the estimate covers
/// the threshold, where it does not.
const EXACT_UP_TO: u64 = 100;

/// Checked at compile time rather than in a test: the server refuses a larger
/// parameter outright, and it fails the whole hundred-aggregate query rather
/// than the one column it belongs to.
const _: () = assert!(EXACT_UP_TO <= 100);

#[derive(Debug, Clone, Serialize)]
pub struct ColumnFacts {
    pub name: String,
    pub r#type: String,
    pub nullable: bool,
    /// The codec as declared, empty when the column takes the table's default.
    pub codec: String,
    /// A column in the sorting or partition key is not one to retype casually:
    /// the key is the table's physical order. The rules need to know.
    pub in_sorting_key: bool,
    pub in_partition_key: bool,
    /// `None` when the parts are Compact and per-column bytes do not exist.
    pub compressed_bytes: Option<u64>,
    pub uncompressed_bytes: Option<u64>,
    /// Approximate — `uniqCombined`, one pass and bounded memory. Only ever used
    /// against the `LowCardinality` threshold, where a percent of error changes
    /// nothing.
    pub distinct: u64,
    /// True when the estimate is above the ceiling where a dictionary stops
    /// paying.
    pub distinct_capped: bool,
    /// Exact when it is 100 or less; 101 means "more than a hundred". This is
    /// the figure a rule may draw a conclusion from — "one value throughout"
    /// cannot rest on an estimate.
    pub distinct_small: u64,
    pub nulls: u64,
    /// Zero-length strings, which are not nulls — a difference that decides
    /// whether dropping a `Nullable` is safe.
    pub empties: u64,
    /// As text, always: an `Int64` past 2^53 does not survive a double, and the
    /// whole point of a range is to compare it against a type's ceiling.
    pub min: Option<String>,
    pub max: Option<String>,
    pub min_len: Option<u64>,
    pub max_len: Option<u64>,
    /// Non-empty values that do *not* parse as a date, a number, a UUID. Zero
    /// means the whole column would survive the conversion — which is the only
    /// evidence that makes retyping text safe to propose.
    pub not_a_date: Option<u64>,
    pub not_a_number: Option<u64>,
    pub not_a_uuid: Option<u64>,
    /// Floats that are not whole numbers. Zero means the column is an integer
    /// that has been paying for a mantissa.
    pub fractional: Option<u64>,
    /// Queries that read this column in the window, from `system.query_log`.
    ///
    /// `None` and `Some(0)` are very different answers and must not be confused:
    /// the first is "this server does not keep a query log, or will not show it
    /// to me", the second is "nothing has read this column all week". Only the
    /// second licenses an opinion.
    pub read_by: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SchemaReview {
    pub database: String,
    pub table: String,
    pub engine: String,
    pub sorting_key: String,
    pub partition_key: String,
    pub total_rows: u64,
    /// Rows this pass actually looked at.
    pub scanned: u64,
    /// True when that was every row, so a finding is a verdict rather than a
    /// hypothesis.
    pub verified: bool,
    /// `Wide`, `Compact`, `mixed`, or empty for a table with no parts.
    pub part_type: String,
    /// Whether per-column bytes could be read at all.
    pub sizes_known: bool,
    /// True when the full measurement failed and this is the reduced one. The
    /// UI says so rather than looking thin for no reason.
    pub degraded: bool,
    /// The window the usage figures cover.
    pub usage_days: u32,
    /// Whether the query log could be read at all. False leaves every
    /// `read_by` null rather than zero.
    pub usage_known: bool,
    /// The oldest moment the query log still holds inside the window asked for.
    ///
    /// Load-bearing, and the reason is measured: on the machine this was built
    /// against, `system.query_log` has a one-day TTL and held twelve hours of
    /// history. "Nothing has read this column in 7 days" was wrong by a factor
    /// of fourteen — and it is the sentence somebody would drop a column on.
    /// A window the reader did not get is not a window.
    pub usage_since: Option<String>,
    /// How many hours back that is, computed by the server.
    ///
    /// The subtraction belongs here and not in the browser: `event_time` is on
    /// ClickHouse's clock and `Date.now()` is on the reader's, and comparing
    /// them silently adds the offset between the two. The figure this wording
    /// rests on cannot afford a two-hour error when it is the difference between
    /// "twelve hours" and "fourteen".
    pub usage_hours: Option<u64>,
    /// Inserts into this table in the window.
    ///
    /// Load-bearing, and discovered the hard way: for an INSERT ClickHouse
    /// leaves `columns` empty, so a table written to every minute looks
    /// completely unused from the read counts alone. A column nothing *reads*
    /// is not a column nothing *needs* — an INSERT that names it fails the
    /// moment it is dropped.
    pub writes: Option<u64>,
    pub columns: Vec<ColumnFacts>,
}

/// One row of `system.parts_columns`, per column.
#[derive(Debug, serde::Deserialize)]
struct SizeRow {
    column: String,
    compressed: u64,
    uncompressed: u64,
}

#[derive(Debug, serde::Deserialize)]
struct PartTypeRow {
    part_type: String,
}

/// Per-column bytes, and what kind of parts they came from.
///
/// Only active parts, and only the MergeTree family answers at all — a `View`
/// or a `Distributed` table has no parts of its own, which is not a failure and
/// is reported as "not known" rather than as zero.
async fn sizes(ch: &Client, database: &str, table: &str) -> (Vec<SizeRow>, String) {
    let opts = || QueryOptions {
        params: vec![
            ("db".into(), database.to_string()),
            ("t".into(), table.to_string()),
        ],
        quote_64bit_integers: false,
        introspection: true,
        ..Default::default()
    };

    let types: Vec<PartTypeRow> = ch
        .rows_with(
            "SELECT DISTINCT toString(part_type) AS part_type \
             FROM system.parts \
             WHERE database = {db:String} AND table = {t:String} AND active",
            opts(),
        )
        .await
        .unwrap_or_default();
    let part_type = match types.as_slice() {
        [] => String::new(),
        [one] => one.part_type.clone(),
        _ => "mixed".to_string(),
    };

    let rows: Vec<SizeRow> = ch
        .rows_with(
            "SELECT column, \
                    sum(column_data_compressed_bytes)   AS compressed, \
                    sum(column_data_uncompressed_bytes) AS uncompressed \
             FROM system.parts_columns \
             WHERE database = {db:String} AND table = {t:String} AND active \
             GROUP BY column",
            opts(),
        )
        .await
        .unwrap_or_default();

    (rows, part_type)
}

#[derive(Debug, serde::Deserialize)]
struct UsageRow {
    column: String,
    queries: u64,
}

/// Which of this table's columns anything has actually read, and how often.
///
/// The cost of a column is only half the question; the other half is whether
/// anybody reads it. A `String` that would be a third the size as a
/// `LowCardinality` is worth more if every query touches it, and a column
/// nothing has read all week is a different conversation altogether — one about
/// whether it should be there.
///
/// Flint's own questions are left out. Without that the answer is a
/// self-portrait: the page measuring a table is, this week, one of the things
/// that read it most.
///
/// Returns `None` — not an empty map — when the log cannot be read, because
/// "nothing read this column" and "I cannot see the log" must never look alike.
struct Usage {
    reads: std::collections::HashMap<String, u64>,
    writes: u64,
    /// Hours of history the log actually holds, on the server's own clock.
    hours: Option<u64>,
    /// The oldest event the log still has in the window, or `None` when it has
    /// nothing at all to say.
    since: Option<String>,
}

async fn usage(ch: &Client, database: &str, table: &str) -> Option<Usage> {
    if !matches!(ch.reach("query_log").await, Ok(super::Reach::Readable)) {
        return None;
    }
    // `columns` arrived in ClickHouse 21; without it there is nothing to ask.
    if !ch
        .system_columns("query_log")
        .await
        .ok()?
        .contains("columns")
    {
        return None;
    }
    let ours = excluding_flint(ch).await.ok()?;
    let qualified = format!("{database}.{table}");
    let prefix = format!("{qualified}.");
    let sql = format!(
        "SELECT column, count() AS queries FROM (             SELECT arrayJoin(columns) AS column             FROM system.query_log             WHERE event_date >= today() - {USAGE_DAYS}               AND type = 'QueryFinish'               AND has(tables, {{q:String}}) {ours}          ) WHERE startsWith(column, {{p:String}})          GROUP BY column"
    );
    let rows: Vec<UsageRow> = ch
        .rows_with(
            &sql,
            QueryOptions {
                params: vec![
                    ("q".into(), qualified.clone()),
                    ("p".into(), prefix.clone()),
                ],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await
        .ok()?;

    // And the writes, which the per-column counts cannot see: an INSERT logs no
    // columns at all, so without this a table taking rows every minute reads as
    // dead.
    #[derive(serde::Deserialize)]
    struct Writes {
        n: u64,
    }
    let writes: Vec<Writes> = ch
        .rows_with(
            &format!(
                "SELECT count() AS n FROM system.query_log \
                 WHERE event_date >= today() - {USAGE_DAYS} \
                   AND type = 'QueryFinish' AND query_kind = 'Insert' \
                   AND has(tables, {{q:String}}) {ours}"
            ),
            QueryOptions {
                params: vec![("q".into(), qualified)],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await
        .unwrap_or_default();

    // How far back the log actually reaches. Asked of the whole log rather than
    // of this table's rows: the question is what the *log* keeps, and a table
    // nobody touched yesterday would otherwise look like a log that starts
    // today.
    #[derive(serde::Deserialize)]
    struct Since {
        since: String,
        hours: u64,
    }
    let since: Vec<Since> = ch
        .rows_with(
            &format!(
                "SELECT toString(min(event_time))                     AS since, \
                        dateDiff('hour', min(event_time), now())      AS hours \
                 FROM system.query_log \
                 WHERE event_date >= today() - {USAGE_DAYS}"
            ),
            QueryOptions {
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await
        .unwrap_or_default();

    let reach = since.into_iter().next();
    Some(Usage {
        reads: rows
            .into_iter()
            .map(|row| {
                (
                    row.column
                        .strip_prefix(&prefix)
                        .unwrap_or(&row.column)
                        .to_string(),
                    row.queries,
                )
            })
            .collect(),
        writes: writes.first().map(|w| w.n).unwrap_or(0),
        hours: reach.as_ref().map(|row| row.hours),
        since: reach
            .map(|row| row.since)
            .filter(|since| !since.starts_with("1970") && !since.starts_with("0000")),
    })
}

/// The longest sample of a query kept. A single statement can be a hundred
/// kilobytes of generated SQL, and nobody reads that in a card.
const SAMPLE_CLIP: usize = 2_000;

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct Reader {
    /// One shape of query, not one run: `normalized_query_hash` groups the
    /// hundred runs that differ only in a literal, which is what makes this a
    /// list somebody can read.
    pub runs: u64,
    pub read_bytes: u64,
    pub read_rows: u64,
    pub max_ms: u64,
    pub users: u64,
    pub last_seen: String,
    pub sample: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Readers {
    pub column: String,
    pub days: u32,
    /// Distinct query shapes that read this column in the window — including the
    /// ones past the limit. A list of five that does not say it was five of
    /// twenty-three reads as the whole truth.
    pub shapes: u64,
    /// Hours of history the log actually holds, on the server's clock. The
    /// panel says this rather than `days` where the two disagree.
    pub hours: Option<u64>,
    /// False when the query log could not be read — which is not the same as
    /// nothing having read the column, and must not be shown as if it were.
    pub available: bool,
    pub entries: Vec<Reader>,
}

/// The queries that actually read one column, biggest reader first.
///
/// The counts on the review say *whether* a column is read; this says by what.
/// It exists because the question everybody asks next — is it filtered on, is it
/// in an ORDER BY — is one `system.query_log` cannot answer: it records the
/// columns a query touched, not what it did with them. The choice is between
/// guessing from the SQL text with regular expressions, which is folklore, and
/// showing the reader their own queries. This shows the queries.
pub async fn readers(
    ch: &Client,
    database: &str,
    table: &str,
    column: &str,
    days: u32,
    limit: u32,
) -> Result<Readers> {
    let empty = Readers {
        column: column.to_string(),
        days,
        shapes: 0,
        hours: None,
        available: false,
        entries: Vec::new(),
    };
    if !matches!(ch.reach("query_log").await, Ok(super::Reach::Readable)) {
        return Ok(empty);
    }
    if !ch
        .system_columns("query_log")
        .await
        .map(|cols| cols.contains("columns"))
        .unwrap_or(false)
    {
        return Ok(empty);
    }
    let ours = excluding_flint(ch).await?;
    let days = days.clamp(1, 90);
    let limit = limit.clamp(1, 20);
    let sql = format!(
        "SELECT count()                            AS runs, \
                sum(read_bytes)                    AS read_bytes, \
                sum(read_rows)                     AS read_rows, \
                max(query_duration_ms)             AS max_ms, \
                uniqExact(user)                    AS users, \
                toString(max(event_time))          AS last_seen, \
                substring(any(query), 1, {SAMPLE_CLIP}) AS sample \
         FROM system.query_log \
         WHERE event_date >= today() - {days} \
           AND type = 'QueryFinish' \
           AND has(columns, {{c:String}}) {ours}\
         GROUP BY normalized_query_hash \
         ORDER BY read_bytes DESC \
         LIMIT {limit}"
    );
    let entries: Vec<Reader> = ch
        .rows_with(
            &sql,
            QueryOptions {
                params: vec![("c".into(), format!("{database}.{table}.{column}"))],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;
    #[derive(serde::Deserialize)]
    struct Reach {
        hours: u64,
    }
    #[derive(serde::Deserialize)]
    struct Shapes {
        shapes: u64,
    }
    // Counted separately from the ranked list, because the list is capped and
    // this is the figure that says so.
    let counted: Vec<Shapes> = ch
        .rows_with(
            &format!(
                "SELECT uniqExact(normalized_query_hash) AS shapes \
                 FROM system.query_log \
                 WHERE event_date >= today() - {days} \
                   AND type = 'QueryFinish' \
                   AND has(columns, {{c:String}}) {ours}"
            ),
            QueryOptions {
                params: vec![("c".into(), format!("{database}.{table}.{column}"))],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await
        .unwrap_or_default();
    let reach: Vec<Reach> = ch
        .rows_with(
            &format!(
                "SELECT dateDiff('hour', min(event_time), now()) AS hours \
                 FROM system.query_log WHERE event_date >= today() - {days}"
            ),
            QueryOptions {
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await
        .unwrap_or_default();

    Ok(Readers {
        available: true,
        hours: reach.first().map(|row| row.hours),
        shapes: counted.first().map(|row| row.shapes).unwrap_or(0),
        entries,
        ..empty
    })
}

/// One column of a database, ranked by what it occupies.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct HeavyColumn {
    pub table: String,
    pub column: String,
    pub r#type: String,
    pub compressed: u64,
    pub uncompressed: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Heavy {
    pub database: String,
    /// Columns with measurable bytes in this database, including the ones past
    /// the limit — so a list of twelve says what it is twelve of.
    pub columns_total: u64,
    /// Bytes the per-column accounting can actually see.
    pub visible: u64,
    /// What the database's active parts occupy altogether.
    pub on_disk: u64,
    /// Parts that keep every column in one file, and are therefore invisible to
    /// the ranking below.
    pub compact_parts: u64,
    pub parts: u64,
    pub columns: Vec<HeavyColumn>,
}

/// Where a database's disk actually is, one column at a time.
///
/// The schema review answers this for a table; nobody with a hundred and sixty
/// tables starts there. This is the question before it — which tables are worth
/// opening — and it is answered from metadata alone: no sampling, no data read,
/// one query over `system.parts_columns`.
///
/// The coverage is reported beside the ranking because it is often not total.
/// Per-column bytes exist only in `Wide` parts, so a database of small tables can
/// have most of its disk in `Compact` parts that this cannot see into. A ranking
/// that quietly covered 78% of a database while looking like all of it is the
/// kind of half-truth the rest of this codebase refuses.
pub async fn heavy(ch: &Client, database: &str, limit: u32) -> Result<Heavy> {
    let limit = limit.clamp(1, 200);
    let opts = || QueryOptions {
        params: vec![("db".into(), database.to_string())],
        quote_64bit_integers: false,
        introspection: true,
        ..Default::default()
    };

    let columns: Vec<HeavyColumn> = ch
        .rows_with(
            &format!(
                "SELECT table, column, any(type) AS type, \
                        sum(column_data_compressed_bytes)   AS compressed, \
                        sum(column_data_uncompressed_bytes) AS uncompressed \
                 FROM system.parts_columns \
                 WHERE database = {{db:String}} AND active \
                 GROUP BY table, column \
                 HAVING compressed > 0 \
                 ORDER BY compressed DESC \
                 LIMIT {limit}"
            ),
            opts(),
        )
        .await
        .unwrap_or_default();

    #[derive(serde::Deserialize)]
    struct Counted {
        n: u64,
    }
    let counted: Vec<Counted> = ch
        .rows_with(
            "SELECT uniqExact((table, column)) AS n \
             FROM system.parts_columns \
             WHERE database = {db:String} AND active AND column_data_compressed_bytes > 0",
            opts(),
        )
        .await
        .unwrap_or_default();

    #[derive(serde::Deserialize)]
    struct Coverage {
        on_disk: u64,
        compact_parts: u64,
        parts: u64,
    }
    let coverage: Vec<Coverage> = ch
        .rows_with(
            "SELECT sum(bytes_on_disk)                AS on_disk, \
                    countIf(part_type = 'Compact')    AS compact_parts, \
                    count()                           AS parts \
             FROM system.parts \
             WHERE database = {db:String} AND active",
            opts(),
        )
        .await
        .unwrap_or_default();
    let coverage = coverage.first();

    let visible: Vec<VisibleRow> = ch
        .rows_with(
            "SELECT sum(column_data_compressed_bytes) AS visible \
             FROM system.parts_columns \
             WHERE database = {db:String} AND active",
            opts(),
        )
        .await
        .unwrap_or_default();

    Ok(Heavy {
        database: database.to_string(),
        columns_total: counted.first().map(|row| row.n).unwrap_or(0),
        visible: visible.first().map(|row| row.visible).unwrap_or(0),
        on_disk: coverage.map(|c| c.on_disk).unwrap_or(0),
        compact_parts: coverage.map(|c| c.compact_parts).unwrap_or(0),
        parts: coverage.map(|c| c.parts).unwrap_or(0),
        columns,
    })
}

#[derive(serde::Deserialize)]
struct VisibleRow {
    visible: u64,
}

/// The aggregates worth asking for a column of this type.
///
/// Proportional on purpose: an 85-column table would otherwise ask four hundred
/// questions, most of them meaningless — the longest string in a `DateTime`
/// column, the parse failures of a `UInt8`.
fn measures(index: usize, col: &ColumnDetail) -> Vec<String> {
    let q = quote_ident(&col.name);
    let i = index;
    let fam = family(&col.r#type);
    // Every row is NULL and nothing else can be measured. The null count is the
    // whole story, and `uniqUpTo` over `Nullable(Nothing)` fails the query.
    if fam == "empty" {
        return vec![format!("sum(isNull({q})) AS c{i}_nulls")];
    }

    let mut out = vec![
        format!("sum(isNull({q})) AS c{i}_nulls"),
        format!("uniqCombined({q}) AS c{i}_uniq"),
        format!("uniqUpTo({EXACT_UP_TO})({q}) AS c{i}_small"),
    ];
    match fam {
        "number" | "time" => {
            out.push(format!("toString(min({q})) AS c{i}_min"));
            out.push(format!("toString(max({q})) AS c{i}_max"));
            // Whole numbers wearing a float's clothes. `%` would refuse a
            // Float64, so the test is against the rounded value.
            if col.r#type.contains("Float") {
                out.push(format!(
                    "countIf(isNotNull({q}) AND toFloat64({q}) != round(toFloat64({q}))) AS c{i}_frac"
                ));
            }
        }
        "string" | "category" => {
            // Lengths and parse checks are over the values that are actually
            // there: a null or an empty string proves nothing about whether the
            // column could be a date, and counting them as failures would
            // silence the finding on every column that has one.
            let present = format!("isNotNull({q}) AND toString({q}) != ''");
            out.push(format!("min(length(toString({q}))) AS c{i}_minlen"));
            out.push(format!("max(length(toString({q}))) AS c{i}_maxlen"));
            out.push(format!(
                "countIf(isNotNull({q}) AND toString({q}) = '') AS c{i}_empty"
            ));
            if fam == "string" {
                out.push(format!(
                    "countIf({present} AND isNull(toDateTimeOrNull(toString({q})))) AS c{i}_nodate"
                ));
                out.push(format!(
                    "countIf({present} AND isNull(toFloat64OrNull(toString({q})))) AS c{i}_nonum"
                ));
                out.push(format!(
                    "countIf({present} AND isNull(toUUIDOrNull(toString({q})))) AS c{i}_nouuid"
                ));
            }
        }
        _ => {}
    }
    out
}

/// The table being reviewed, as everything the measurement needs to know about
/// it. A struct rather than eight arguments: they travel together, and the two
/// that are easiest to swap by accident — `database` and `table` — are named at
/// the call site this way.
pub struct Subject<'a> {
    pub database: &'a str,
    pub table: &'a str,
    pub columns: &'a [ColumnDetail],
    pub engine: &'a str,
    pub sorting_key: &'a str,
    pub partition_key: &'a str,
    pub total_rows: u64,
}

/// Measure a table's columns.
///
/// `verify` is the difference between a hypothesis and a verdict: false reads a
/// bounded sample, true reads every row of every column the review needs. The
/// caller is expected to have told somebody what that costs — this function
/// will happily scan a billion rows if asked.
pub async fn review(ch: &Client, subject: Subject<'_>, verify: bool) -> Result<SchemaReview> {
    let Subject {
        database,
        table,
        columns,
        engine,
        sorting_key,
        partition_key,
        total_rows,
    } = subject;
    let (size_rows, part_type) = sizes(ch, database, table).await;
    let measured_usage = usage(ch, database, table).await;
    let usage_known = measured_usage.is_some();
    let writes = measured_usage.as_ref().map(|u| u.writes);
    let usage_since = measured_usage.as_ref().and_then(|u| u.since.clone());
    let usage_hours = measured_usage.as_ref().and_then(|u| u.hours);
    let read_counts = measured_usage.map(|u| u.reads);
    let sizes_known = size_rows.iter().any(|r| r.compressed > 0);

    let empty = |degraded: bool, scanned: u64| SchemaReview {
        database: database.to_string(),
        table: table.to_string(),
        engine: engine.to_string(),
        sorting_key: sorting_key.to_string(),
        partition_key: partition_key.to_string(),
        total_rows,
        scanned,
        verified: verify,
        part_type: part_type.clone(),
        sizes_known,
        degraded,
        usage_days: USAGE_DAYS,
        usage_known,
        usage_since: usage_since.clone(),
        usage_hours,
        writes,
        columns: Vec::new(),
    };

    if columns.is_empty() {
        return Ok(empty(false, 0));
    }

    let source = if verify {
        format!("{}.{}", quote_ident(database), quote_ident(table))
    } else {
        // A bounded sample — some rows, not the first ones; see the module doc —
        // with the columns named so the scan is only over what
        // is being measured.
        let list = columns
            .iter()
            .map(|c| quote_ident(&c.name))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "(SELECT {list} FROM {}.{} LIMIT {SAMPLE_ROWS})",
            quote_ident(database),
            quote_ident(table)
        )
    };

    let full: Vec<String> = std::iter::once("count() AS n_rows".to_string())
        .chain(
            columns
                .iter()
                .enumerate()
                .flat_map(|(i, col)| measures(i, col)),
        )
        .collect();
    // The same degradation the profile uses, for the same reason: ClickHouse has
    // a lot of types and some of them refuse an aggregate that looks perfectly
    // reasonable. A review of the counts beats an error page.
    let minimal: Vec<String> = std::iter::once("count() AS n_rows".to_string())
        .chain(
            columns
                .iter()
                .enumerate()
                .map(|(i, col)| format!("sum(isNull({})) AS c{i}_nulls", quote_ident(&col.name))),
        )
        .collect();

    let mut row: Option<serde_json::Map<String, Value>> = None;
    let mut degraded = false;
    for (attempt, list) in [&full, &minimal].iter().enumerate() {
        let sql = format!("SELECT {} FROM {source}", list.join(", "));
        match ch
            .row_with(
                &sql,
                QueryOptions {
                    quote_64bit_integers: false,
                    // Tagged as Flint's own, or the review reads the table it is
                    // reviewing and then reports itself as one of the things
                    // that read it. The usage figures are the whole reason this
                    // matters: an untagged measurement inflates every count it
                    // publishes, and the biggest reader of a column becomes the
                    // page asking about it.
                    introspection: true,
                    ..Default::default()
                },
            )
            .await
        {
            Ok(r) => {
                row = r;
                degraded = attempt > 0;
                break;
            }
            Err(e) if attempt == 0 => {
                tracing::warn!(
                    "full schema review of {database}.{table} failed, falling back to counts: {e}"
                );
            }
            Err(e) => return Err(e),
        }
    }
    let row = row.ok_or_else(|| Error::Decode("the review query returned no row".into()))?;

    let u64_at = |key: String| row.get(&key).and_then(Value::as_u64);
    let string_at = |key: String| {
        row.get(&key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|s| !s.is_empty())
    };

    let facts = columns
        .iter()
        .enumerate()
        .map(|(i, col)| {
            let size = size_rows.iter().find(|r| r.column == col.name);
            // Zero is what a Compact part reports for every column, and it is
            // not a size — it is the absence of one.
            let bytes = size.filter(|s| s.compressed > 0);
            ColumnFacts {
                name: col.name.clone(),
                r#type: col.r#type.clone(),
                nullable: col.nullable,
                codec: col.compression_codec.clone(),
                in_sorting_key: col.in_sorting_key,
                in_partition_key: col.in_partition_key,
                compressed_bytes: bytes.map(|s| s.compressed),
                uncompressed_bytes: bytes.map(|s| s.uncompressed),
                distinct: u64_at(format!("c{i}_uniq")).unwrap_or(0),
                distinct_capped: u64_at(format!("c{i}_uniq")).is_some_and(|d| d > DISTINCT_CEILING),
                distinct_small: u64_at(format!("c{i}_small")).unwrap_or(0),
                nulls: u64_at(format!("c{i}_nulls")).unwrap_or(0),
                empties: u64_at(format!("c{i}_empty")).unwrap_or(0),
                min: string_at(format!("c{i}_min")),
                max: string_at(format!("c{i}_max")),
                min_len: u64_at(format!("c{i}_minlen")),
                max_len: u64_at(format!("c{i}_maxlen")),
                not_a_date: u64_at(format!("c{i}_nodate")),
                not_a_number: u64_at(format!("c{i}_nonum")),
                not_a_uuid: u64_at(format!("c{i}_nouuid")),
                fractional: u64_at(format!("c{i}_frac")),
                // Absent when the log could not be read; zero when it could and
                // nothing had touched the column.
                read_by: read_counts
                    .as_ref()
                    .map(|counts| counts.get(&col.name).copied().unwrap_or(0)),
            }
        })
        .collect();

    Ok(SchemaReview {
        columns: facts,
        degraded,
        scanned: row.get("n_rows").and_then(Value::as_u64).unwrap_or(0),
        ..empty(degraded, 0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(name: &str, ch_type: &str) -> ColumnDetail {
        ColumnDetail {
            name: name.to_string(),
            r#type: ch_type.to_string(),
            nullable: ch_type.contains("Nullable"),
            ..Default::default()
        }
    }

    #[test]
    fn asks_a_number_for_its_range_and_a_string_for_its_lengths() {
        let numeric = measures(0, &column("n", "UInt64")).join(" ");
        assert!(numeric.contains("min(n)"));
        // Both counts: the estimate for the threshold, the exact one for the
        // rules that may not guess.
        assert!(numeric.contains("uniqCombined(n)"));
        assert!(numeric.contains("uniqUpTo(100)(n)"));
        // Nothing about text: the longest value of a UInt64 is not a question.
        assert!(!numeric.contains("length"));
        assert!(!numeric.contains("toDateTimeOrNull"));

        let text = measures(1, &column("s", "String")).join(" ");
        assert!(text.contains("max(length(toString(s)))"));
        assert!(text.contains("toDateTimeOrNull"));
        assert!(text.contains("toUUIDOrNull"));
        // A range over a String is a kilobyte of JSON, not a fact.
        assert!(!text.contains("min(s)"));
    }

    #[test]
    fn only_asks_a_float_whether_it_is_whole() {
        assert!(measures(0, &column("f", "Float64"))
            .join(" ")
            .contains("round"));
        assert!(!measures(0, &column("i", "Int32"))
            .join(" ")
            .contains("round"));
    }

    #[test]
    fn measures_an_always_null_column_only_for_its_nulls() {
        let all = measures(3, &column("x", "Nullable(Nothing)"));
        assert_eq!(all.len(), 1);
        assert!(all[0].contains("isNull"));
    }

    #[test]
    fn does_not_count_an_absent_value_as_a_failed_conversion() {
        // An empty string is not evidence that the column cannot be a date; a
        // review that counted it would never propose the change.
        let text = measures(0, &column("s", "String")).join(" ");
        assert!(text.contains("toString(s) != ''"));
    }

    #[test]
    fn quotes_an_awkward_column_name_everywhere_it_appears() {
        let odd = measures(0, &column("odd name", "String")).join(" ");
        assert!(odd.contains("`odd name`"));
        assert!(!odd.contains("(odd name)"));
    }
}
