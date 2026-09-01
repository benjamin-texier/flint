//! The bytes you are paying for and nothing has read.
//!
//! Every other storage reading in Flint answers *where the disk is*: the treemap
//! draws it, the review says what the column types cost, the projection advisor
//! says what the workload would like instead. None of them can answer the
//! question somebody actually has when a disk fills, which is **which of this is
//! doing any work**.
//!
//! Two system tables between them can, and neither can alone:
//!
//! - `system.parts_columns` weighs every column of every active part, so the
//!   cost is known to the column rather than to the table.
//! - `system.query_log.columns` names every column each statement touched,
//!   fully qualified as `database.table.column`.
//!
//! A column in the first and not in the second is one this server stored, merged,
//! backed up and paid for, and did not serve. On a real schema that is routinely
//! most of the disk — a `raw_payload` kept "just in case" beside twelve columns
//! anybody queries — and nothing in ClickHouse will ever mention it.
//!
//! ## What this must never say
//!
//! **It does not say a column is unused.** It says nothing has read it *in the
//! window*, which is a different sentence and the only one the evidence
//! supports. A quarterly report, an incident investigation, a regulator's export
//! and a yearly reconciliation all read columns that look cold for months. The
//! finding is *where to look*; the decision needs somebody who knows what the
//! column is for.
//!
//! Which is why two things travel with the answer and are not optional.
//!
//! **How far back the log actually goes.** `system.query_log` has a TTL, and on
//! a busy server it is often days rather than the window asked for. "Nothing has
//! read this in 30 days" over a log holding 40 hours is a false statement with a
//! true number in it, so the window is reported as *covered*, from the log's own
//! oldest row, and the caller says which one it is quoting.
//!
//! **Whether the table was read at all.** A table no statement touched in the
//! window has every column cold, and reporting that as "14 unread columns" dresses
//! one fact up as fourteen. It is a fact about the table — nobody read it — and
//! it is said that way.
//!
//! ## The qualified name
//!
//! `columns` holds `database.table.column` as a single string, and ClickHouse
//! permits a dot in any of the three. So a column literally named `b.c` in table
//! `a` is indistinguishable from column `c` of table `a.b`. Flint compares the
//! joined string rather than parsing it, which makes it exactly as ambiguous as
//! ClickHouse's own encoding and no more — and the failure mode is a column
//! reported warm that was not, never cold that was read.

use serde::{Deserialize, Serialize};

use super::diagnostics::excluding_flint;
use super::{Client, Reach};
use crate::error::Result;

/// Databases whose contents are ClickHouse's own business.
const USER_DATABASES: &str =
    "database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')";

/// One column that costs something and served nothing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColdColumn {
    pub name: String,
    /// What it occupies on the disk, compressed — the figure the reader is
    /// deciding about.
    pub bytes: u64,
    /// What it would be uncompressed, which is what a reader comparing two
    /// columns of different types is really comparing.
    pub uncompressed_bytes: u64,
}

/// One table, and how much of it went unread.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColdTable {
    pub database: String,
    pub table: String,
    pub qualified: String,
    /// Columns that hold data on disk. Not `system.columns`' count: an ALIAS or
    /// a MATERIALIZED column that was never backfilled occupies nothing, and
    /// counting it would make every table look half-cold.
    pub columns: u64,
    pub cold_columns: u64,
    pub bytes: u64,
    pub cold_bytes: u64,
    /// How many statements read this table at all, over the window.
    ///
    /// Zero is the important value and it changes the sentence: every column of
    /// an unread table is cold, and that is one fact rather than fourteen.
    pub reads: u64,
    /// The coldest few, named and weighed, heaviest first. Capped — the caller
    /// says the count, and `cold_columns` is the truth about how many there are.
    pub coldest: Vec<ColdColumn>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColdReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The window that was asked for, in days.
    pub window_days: u64,
    /// The window the log can actually answer over, in days, from its own oldest
    /// row. Never larger than `window_days`. **The caller quotes this one**, and
    /// a report whose log holds two days must not be read as thirty.
    pub covered_days: f64,
    /// How many statements the window held at all. A handful is not a workload,
    /// and a verdict about what nobody read needs somebody to have been reading.
    pub statements: u64,
    /// Heaviest cold first, capped.
    pub tables: Vec<ColdTable>,
    /// The floor this reading applied. On the wire because a list that dropped
    /// everything under 64 MiB and did not say so reads as "nothing is cold".
    pub floor_bytes: u64,
    /// Across every table considered, not only the listed ones.
    pub total_cold_bytes: u64,
    pub total_bytes: u64,
    pub total_tables: u64,
}

/// Below this a table is not worth a sentence on a server-wide reading. A 4 MiB
/// lookup with three unread columns is true and is not news, and a page of them
/// buries the 400 GiB one.
///
/// Overridable, and one caller does: a page about *one* table is not choosing
/// between tables, so every cold column on it is worth naming however small.
pub const FLOOR_BYTES: u64 = 64 * 1024 * 1024;

/// How many cold columns to name per table. Enough to make the point; the count
/// beside them is what says how many there are.
const NAMED: usize = 6;

/// What this server is paying for and not serving.
///
/// `database` narrows it to one; `None` reads every database that is not
/// ClickHouse's own.
pub async fn cold(
    ch: &Client,
    database: Option<&str>,
    days: u64,
    limit: u64,
    floor_bytes: u64,
) -> Result<ColdReport> {
    let days = days.clamp(1, 90);
    let empty = |reason: String| ColdReport {
        available: false,
        reason: Some(reason),
        window_days: days,
        covered_days: 0.0,
        statements: 0,
        tables: Vec::new(),
        total_cold_bytes: 0,
        total_bytes: 0,
        total_tables: 0,
        floor_bytes,
    };

    /* Both, and both named separately: a role granted one and not the other is
    common, and "cannot answer" without saying which half is missing sends
    somebody to ask for the wrong GRANT. */
    if let Some(why) = blocked(ch, "parts_columns").await? {
        return Ok(empty(why));
    }
    if let Some(why) = blocked(ch, "query_log").await? {
        return Ok(empty(why));
    }

    let scope = match database {
        Some(_) => "database = {db:String}".to_string(),
        None => USER_DATABASES.to_string(),
    };
    let params = match database {
        Some(db) => vec![("db".into(), db.to_string())],
        None => Vec::new(),
    };
    let opts = |extra: Vec<(String, String)>| super::QueryOptions {
        params: [params.clone(), extra].concat(),
        quote_64bit_integers: false,
        introspection: true,
        ..Default::default()
    };

    let flint = excluding_flint(ch).await?;

    /* How far back the log goes, and how much is in it. Asked first and asked
    separately, because it decides what the rest of the answer may claim —
    and because an empty log makes everything look cold, which is the single
    most misleading thing this module could produce. */
    #[derive(Deserialize)]
    struct Span {
        covered_days: f64,
        statements: u64,
    }
    let span: Option<Span> = ch
        .row_with(
            &format!(
                "SELECT toUInt64(count())                                    AS statements, \
                        least( \
                            {days}.0, \
                            dateDiff('second', min(event_time), now()) / 86400.0 \
                        )                                                    AS covered_days \
                 FROM system.query_log \
                 WHERE event_time > now() - INTERVAL {days} DAY \
                   AND type = 'QueryFinish' {flint}"
            ),
            opts(Vec::new()),
        )
        .await?;
    let (covered_days, statements) = span
        .map(|s| (s.covered_days.max(0.0), s.statements))
        .unwrap_or((0.0, 0));

    /* The whole measurement in one statement, and deliberately so: the read set
    is potentially millions of names, and shipping it here to subtract in Rust
    would move the server's own index scan into this process's memory. */
    let sql = format!(
        "WITH read_columns AS ( \
             SELECT DISTINCT arrayJoin(columns) AS qualified \
             FROM system.query_log \
             WHERE event_time > now() - INTERVAL {days} DAY \
               AND type = 'QueryFinish' {flint} \
         ), \
         read_tables AS ( \
             SELECT arrayJoin(tables) AS qualified, count() AS reads \
             FROM system.query_log \
             WHERE event_time > now() - INTERVAL {days} DAY \
               AND type = 'QueryFinish' {flint} \
             GROUP BY qualified \
         ), \
         weighed AS ( \
             SELECT database, \
                    table, \
                    column, \
                    sum(column_data_compressed_bytes)   AS bytes, \
                    sum(column_data_uncompressed_bytes) AS uncompressed \
             FROM system.parts_columns \
             WHERE active AND {scope} \
             GROUP BY database, table, column \
             /* A column that occupies nothing is not a saving and not a \
                finding: an ALIAS, or a MATERIALIZED column added and never \
                backfilled. Counting them would make every table look half \
                cold. */ \
             HAVING bytes > 0 \
         ) \
         SELECT w.database                                          AS database, \
                w.table                                             AS table, \
                concat(w.database, '.', w.table)                    AS qualified, \
                toUInt64(count())                                   AS columns, \
                toUInt64(countIf(cold))                             AS cold_columns, \
                toUInt64(sum(w.bytes))                              AS bytes, \
                toUInt64(sumIf(w.bytes, cold))                      AS cold_bytes, \
                toUInt64(any(t.reads))                              AS reads, \
                arraySlice( \
                    arraySort( \
                        (x) -> -x.2, \
                        groupArrayIf( \
                            (w.column, w.bytes, w.uncompressed), \
                            cold \
                        ) \
                    ), \
                    1, {NAMED} \
                )                                                   AS coldest \
         FROM ( \
             SELECT *, \
                    concat(database, '.', table, '.', column) NOT IN ( \
                        SELECT qualified FROM read_columns \
                    ) AS cold \
             FROM weighed \
         ) AS w \
         LEFT JOIN read_tables AS t ON t.qualified = concat(w.database, '.', w.table) \
         GROUP BY w.database, w.table \
         HAVING cold_bytes > 0 \
         ORDER BY cold_bytes DESC \
         LIMIT {}",
        limit.clamp(1, 200)
    );

    #[derive(Deserialize)]
    struct Row {
        database: String,
        table: String,
        qualified: String,
        columns: u64,
        cold_columns: u64,
        bytes: u64,
        cold_bytes: u64,
        reads: u64,
        /// `(name, compressed, uncompressed)`, as ClickHouse hands back a tuple.
        coldest: Vec<(String, u64, u64)>,
    }
    let rows: Vec<Row> = ch.rows_with(&sql, opts(Vec::new())).await?;

    /* The totals are over everything considered rather than over what is
    listed, and over everything above the floor rather than over every row:
    a total that counts what the list does not show is a total nobody can
    reconcile, and one that counts nothing is a total that understates the
    disk. So it is stated as what it is — the tables worth a sentence. */
    let kept: Vec<ColdTable> = rows
        .into_iter()
        .filter(|r| r.cold_bytes >= floor_bytes)
        .map(|r| ColdTable {
            database: r.database,
            table: r.table,
            qualified: r.qualified,
            columns: r.columns,
            cold_columns: r.cold_columns,
            bytes: r.bytes,
            cold_bytes: r.cold_bytes,
            reads: r.reads,
            coldest: r
                .coldest
                .into_iter()
                .map(|(name, bytes, uncompressed_bytes)| ColdColumn {
                    name,
                    bytes,
                    uncompressed_bytes,
                })
                .collect(),
        })
        .collect();

    Ok(ColdReport {
        available: true,
        reason: None,
        window_days: days,
        covered_days,
        statements,
        total_cold_bytes: kept.iter().map(|t| t.cold_bytes).sum(),
        total_bytes: kept.iter().map(|t| t.bytes).sum(),
        total_tables: kept.len() as u64,
        tables: kept,
        floor_bytes,
    })
}

async fn blocked(ch: &Client, table: &str) -> Result<Option<String>> {
    Ok(match ch.reach(table).await? {
        Reach::Readable => None,
        Reach::Denied => Some(format!("this user is not granted SELECT on system.{table}")),
        Reach::Absent | Reach::Unconfigured => Some(format!(
            "system.{table} is not available on this server, so Flint cannot tell what has been read"
        )),
    })
}
