//! Where the disk actually is, down to the column.
//!
//! A schema diagram draws every object the same size, so a three-terabyte table
//! and a four-row lookup are the same rectangle. The object list carries the
//! figures but sorts them into a column of numbers, which is a list to read
//! rather than a shape to see — and "which of these is the disk" is a question
//! about proportion, which is what a treemap answers in one glance and a sorted
//! table never quite does.
//!
//! The unit is the *column*, not the table, because a column store is the one
//! place where that is the honest unit: reading four columns of thirty-six is
//! the largest saving the engine offers, and a table that is 90% one `String`
//! of JSON is a completely different object from one whose bytes are spread
//! evenly — which no per-table figure can tell you.
//!
//! A block is the table's real size on disk — `parts.bytes_on_disk`, the same
//! figure the page's headline and the object list carry, because a picture that
//! disagreed with the number above it would be the picture people stop
//! believing. Inside it, `system.parts_columns` divides that up, and what the
//! columns do not account for is the marks and the primary key index: those
//! belong to no column and are drawn as their own cell rather than spread
//! silently over the ones that do.
//!
//! It does not rank by uncompressed size, which is the number people expect and
//! the wrong one — the uncompressed extent is what the data *would* be, and the
//! disk it is filling today is what fills up.
//!
//! **A small table has no per-column sizes at all.** MergeTree writes a part in
//! one of two formats, and a *compact* part — which is what a table of a few
//! hundred rows gets — keeps every column in a single file. ClickHouse reports
//! zero for each column in it, truthfully: there is no per-column figure to
//! report. Those tables are drawn whole, with the reason on them, because
//! filtering them out would quietly remove real tables holding real disk from a
//! picture whose entire claim is that it shows where the disk is.

use serde::{Deserialize, Serialize};

use super::{Client, QueryOptions, Reach};
use crate::error::{Error, Result};

/// One column's bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnMass {
    pub table: String,
    pub column: String,
    /// The declared type, carried so the drawing can colour by type family —
    /// "all of this disk is one Nested" is an answer no size alone gives.
    pub r#type: String,
    pub bytes: u64,
    pub uncompressed_bytes: u64,
}

/// One table's total, and how much of it the columns account for.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableMass {
    pub table: String,
    /// Everything the table's active parts take on disk: column data, marks,
    /// the primary key index. The figure the rest of Flint prints for it.
    pub bytes: u64,
    pub uncompressed_bytes: u64,
    /// Columns with a size of their own. Zero where the parts are compact.
    #[serde(default)]
    pub columns: u64,
    /// What those columns come to. The difference from `bytes` is the marks, the
    /// index and any *projections*, which belong to no column and are drawn as
    /// their own cells.
    #[serde(default)]
    pub column_bytes: u64,
    /// Disk held by this table's projections.
    ///
    /// Inside `bytes`, not beside it: a part's `bytes_on_disk` counts the
    /// projection parts stored under it, which is worth knowing before drawing
    /// anything. Measured rather than assumed, and the small case is a trap — a
    /// toy projection of 827 bytes is under the noise of two identical tables
    /// built from random data, and pointed at the opposite conclusion. A
    /// projection that is nearly a second copy of the table settled it: 4.41 MB
    /// on disk for 2.19 MB of columns and a 2.22 MB projection.
    ///
    /// So without this figure a projection hides inside the marks-and-index
    /// cell, which on such a table would be labelled `marks & index` while
    /// holding half the table.
    #[serde(default)]
    pub projection_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MassReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub tables: Vec<TableMass>,
    pub columns: Vec<ColumnMass>,
    /// Every table in the database holding column data, drawn or not.
    pub total_tables: u64,
    /// Column data across all of them — the figure the drawn share is a share
    /// of. Not the database's size on disk, which is larger; the view says so
    /// rather than letting the two be mistaken for each other.
    pub total_bytes: u64,
    /// True where a table that *is* drawn has columns missing from the answer.
    pub columns_truncated: bool,
    /// Why there is no column breakdown at all, where there is none. The map
    /// still draws every table whole in that case: the sizes are real and only
    /// the division inside them is missing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub columns_reason: Option<String>,
}

const DEFAULT_TABLES: u64 = 24;
const MAX_TABLES: u64 = 120;
/// A ceiling on cells. A treemap of more than about a thousand rectangles is a
/// texture, and the fold that keeps it readable happens in the layout — this is
/// only the backstop against a database of five hundred wide tables.
const MAX_COLUMNS: u64 = 4_000;

pub async fn column_mass(
    ch: &Client,
    database: &str,
    table_limit: Option<u64>,
) -> Result<MassReport> {
    // Only `system.parts` is required: without it there are no sizes and no
    // picture. `system.parts_columns` divides those sizes up, and a role that
    // cannot read it loses the division rather than the map.
    if let Some(why) = blocked(ch, "parts").await? {
        return Ok(empty(Some(why)));
    }
    let limit = table_limit.unwrap_or(DEFAULT_TABLES).clamp(1, MAX_TABLES);
    let opts = || QueryOptions {
        params: vec![("db".into(), database.to_string())],
        ..QueryOptions::internal()
    };

    #[derive(Deserialize)]
    struct Totals {
        tables: u64,
        bytes: u64,
    }
    let totals: Totals = match ch
        .row_with::<Totals>(
            "SELECT toUInt64(uniqExact(table))          AS tables, \
                    toUInt64(sum(bytes_on_disk))        AS bytes \
             FROM system.parts \
             WHERE active AND database = {db:String}",
            opts(),
        )
        .await
    {
        Ok(row) => row.unwrap_or(Totals {
            tables: 0,
            bytes: 0,
        }),
        Err(e) if degraded(&e) => return Ok(empty(Some(denied("parts")))),
        Err(e) => return Err(e),
    };

    let ranked = format!(
        "SELECT table                                   AS table, \
                toUInt64(sum(bytes_on_disk))            AS bytes, \
                toUInt64(sum(data_uncompressed_bytes))  AS uncompressed_bytes, \
                toUInt64(0)                             AS columns, \
                toUInt64(0)                             AS column_bytes \
         FROM system.parts \
         WHERE active AND database = {{db:String}} \
         GROUP BY table \
         HAVING sum(bytes_on_disk) > 0 \
         ORDER BY sum(bytes_on_disk) DESC, table ASC \
         LIMIT {limit}"
    );
    let mut tables: Vec<TableMass> = match ch.rows_with(&ranked, opts()).await {
        Ok(rows) => rows,
        Err(e) if degraded(&e) => return Ok(empty(Some(denied("parts")))),
        Err(e) => return Err(e),
    };

    if tables.is_empty() {
        return Ok(MassReport {
            available: true,
            reason: None,
            tables,
            columns: Vec::new(),
            total_tables: totals.tables,
            total_bytes: totals.bytes,
            columns_truncated: false,
            columns_reason: None,
        });
    }

    // The division. Everything from here can fail without costing the map its
    // blocks, so each failure becomes a sentence rather than an error.
    if let Some(why) = blocked(ch, "parts_columns").await? {
        return Ok(MassReport {
            available: true,
            reason: None,
            tables,
            columns: Vec::new(),
            total_tables: totals.tables,
            total_bytes: totals.bytes,
            columns_truncated: false,
            columns_reason: Some(why),
        });
    }

    /* Projections, where this server has them. `system.projection_parts` arrived
    in 21.x, so its absence is an older server and not a fault — the map then
    draws what it always drew, with the projections silently inside the
    marks-and-index cell as they were before this was fetched at all. */
    #[derive(Deserialize)]
    struct Proj {
        table: String,
        projection_bytes: u64,
    }
    let projections: Vec<Proj> = if ch.has_system_table("projection_parts").await? {
        ch.rows_with(
            "SELECT table                                       AS table, \
                    toUInt64(sum(bytes_on_disk))                AS projection_bytes \
             FROM system.projection_parts \
             WHERE active AND database = {db:String} \
             GROUP BY table",
            opts(),
        )
        .await
        .unwrap_or_default()
    } else {
        Vec::new()
    };
    for t in &mut tables {
        if let Some(p) = projections.iter().find(|p| p.table == t.table) {
            t.projection_bytes = p.projection_bytes;
        }
    }

    #[derive(Deserialize)]
    struct Rollup {
        table: String,
        columns: u64,
        column_bytes: u64,
    }
    /* A failure here used to become an empty rollup, which left every table with
    `column_bytes = 0` — and a zero there is how the map knows a table's parts
    are compact. So one failed query made every block on the page claim
    something specific and false about how its data is stored. The error
    becomes the reason instead, and the map says *that*. */
    let rollup: Vec<Rollup> = match ch
        .rows_with(
            "SELECT table                                          AS table, \
                    toUInt64(countDistinctIf(column, column_data_compressed_bytes > 0)) AS columns, \
                    toUInt64(sum(column_data_compressed_bytes))    AS column_bytes \
             FROM system.parts_columns \
             WHERE active AND database = {db:String} \
             GROUP BY table",
            opts(),
        )
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::debug!("mass map without a column breakdown: {e}");
            return Ok(MassReport {
                available: true,
                reason: None,
                tables,
                columns: Vec::new(),
                total_tables: totals.tables,
                total_bytes: totals.bytes,
                columns_truncated: false,
                columns_reason: Some(if degraded(&e) {
                    denied("parts_columns")
                } else {
                    "this server would not answer for the column sizes".to_string()
                }),
            });
        }
    };
    for t in &mut tables {
        if let Some(r) = rollup.iter().find(|r| r.table == t.table) {
            t.columns = r.columns;
            t.column_bytes = r.column_bytes;
        }
    }

    let columns_sql = format!(
        "SELECT table                                          AS table, \
                column                                         AS column, \
                any(type)                                      AS type, \
                toUInt64(sum(column_data_compressed_bytes))    AS bytes, \
                toUInt64(sum(column_data_uncompressed_bytes))  AS uncompressed_bytes \
         FROM system.parts_columns \
         WHERE active AND database = {{db:String}} AND table IN ( \
             SELECT table FROM ( \
                 SELECT table, sum(bytes_on_disk) AS b \
                 FROM system.parts \
                 WHERE active AND database = {{db:String}} \
                 GROUP BY table HAVING b > 0 ORDER BY b DESC, table ASC LIMIT {limit} \
             ) \
         ) \
         GROUP BY table, column \
         HAVING sum(column_data_compressed_bytes) > 0 \
         ORDER BY sum(column_data_compressed_bytes) DESC, table ASC, column ASC \
         LIMIT {}",
        MAX_COLUMNS + 1
    );
    let mut columns: Vec<ColumnMass> = match ch.rows_with(&columns_sql, opts()).await {
        Ok(rows) => rows,
        Err(e) if degraded(&e) => Vec::new(),
        Err(e) => return Err(e),
    };
    let columns_truncated = columns.len() as u64 > MAX_COLUMNS;
    columns.truncate(MAX_COLUMNS as usize);

    Ok(MassReport {
        available: true,
        reason: None,
        tables,
        columns,
        total_tables: totals.tables,
        total_bytes: totals.bytes,
        columns_truncated,
        columns_reason: None,
    })
}

fn empty(reason: Option<String>) -> MassReport {
    MassReport {
        available: false,
        reason,
        tables: Vec::new(),
        columns: Vec::new(),
        total_tables: 0,
        total_bytes: 0,
        columns_truncated: false,
        columns_reason: None,
    }
}

fn denied(table: &str) -> String {
    format!("this user is not granted SELECT on system.{table}")
}

fn degraded(e: &Error) -> bool {
    matches!(
        e,
        Error::ClickHouse { code: 497, .. } | Error::ClickHouse { code: 164, .. }
    )
}

async fn blocked(ch: &Client, table: &str) -> Result<Option<String>> {
    Ok(match ch.reach(table).await? {
        Reach::Readable => None,
        Reach::Denied => Some(denied(table)),
        Reach::Absent | Reach::Unconfigured => {
            Some(format!("this ClickHouse has no system.{table}"))
        }
    })
}
