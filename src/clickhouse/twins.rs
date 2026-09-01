//! Two tables holding the same thing.
//!
//! The copy nobody deleted. A migration that made `events_v2`, filled it,
//! switched the reads over and left `events` on the disk; a table cloned to try a
//! different sorting key; a restore into a second name that was never dropped.
//! Nothing in ClickHouse mentions any of them, they merge and back up like
//! anything else, and the only reason anybody notices is a disk filling.
//!
//! ## Shape alone is not evidence, and measuring proved it
//!
//! The first version of this grouped tables by their column list and stopped
//! there. On a real schema that produced eight-table groups of nothing: `raw_x`,
//! `raw_x_estimated`, `raw_x_last_state` and `raw_x_last_state_mv` share a shape
//! *by design* — that is what a pipeline looks like — and two databases on one
//! server share every shape in them, because they are two environments.
//!
//! So two more conditions, and they are what make the reading worth having:
//!
//! - **The same database.** `default.events` and `staging.events` are not a
//!   duplicate, they are a deployment.
//! - **The same number of rows, to within a whisker.** This is the discriminator,
//!   and it is sharp. Measured against ClickHouse's own demo server: `hits`,
//!   `hits_full_projection` and `hits_index_projection` hold 99,997,497 rows
//!   each — a spread of exactly zero — and `query_log_sharded` and
//!   `query_log_plain` differ by 0.06%. Meanwhile `forex`, `forex_2020s` and
//!   `forex_usd` share a shape and spread 99.8%, and `hackernews_changes_items`
//!   and `hackernews_history` spread 42%. The first two groups are copies of one
//!   dataset. The last two are not, and no amount of shape comparison would have
//!   told them apart.
//!
//! ## What it must not say
//!
//! **Not "delete one".** Two tables with one shape and one row count is also
//! exactly what a deliberate second *layout* of a dataset looks like — a
//! different sorting key, a projection kept as its own table, a shard and its
//! plain twin. All three of those are on the demo server above, and all three are
//! correct engineering. The finding is that the server is holding two copies and
//! what the smaller one costs; whether that is waste is a question about intent,
//! which Flint cannot read.

use serde::{Deserialize, Serialize};

use super::{Client, QueryOptions, Reach};
use crate::error::Result;

/// Databases whose contents are ClickHouse's own business.
const USER_DATABASES: &str =
    "database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')";

/// One of a set of tables that look like copies of each other.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Twin {
    pub table: String,
    pub rows: u64,
    pub bytes: u64,
    /// When its metadata last changed — the closest thing to "which of these is
    /// the new one" that `system.tables` offers, and worth having for exactly
    /// that: the reader is deciding which copy is the survivor.
    pub modified: String,
}

/// A set of tables in one database with one shape and one row count.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwinSet {
    pub database: String,
    /// How many columns they share, name and type.
    pub columns: u64,
    /// Heaviest first. Not "the original first": nothing here can tell which
    /// copy came first — `hits` on ClickHouse's demo server is the smallest of
    /// its three, because the two beside it are alternative layouts of it — and
    /// `modified` is the only hint, which is why each row carries it.
    pub tables: Vec<Twin>,
    /// `(max - min) / max` over the row counts. Zero means identical.
    pub row_spread: f64,
    /// What the set costs beyond its heaviest member.
    ///
    /// **The conservative saving, deliberately.** The total across a set is not a
    /// saving — one of these is the data — and which one somebody keeps decides
    /// what dropping the rest gives back. Keeping the heaviest gives back the
    /// least, so this is the floor: at least this much of the disk is a second
    /// copy, whichever copy survives. Naming the larger figure would be quoting
    /// the best case of a decision Flint is not making.
    pub redundant_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TwinReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub sets: Vec<TwinSet>,
    /// Across every set found, not only the listed ones.
    pub total_sets: u64,
    pub total_redundant_bytes: u64,
    /// The tolerance this reading applied, so the caller can state it.
    pub spread_allowed: f64,
    /// The row floor it applied, for the same reason.
    pub row_floor: u64,
}

/// How far two row counts may differ and still be called the same.
///
/// Two percent, and the slack is deliberate rather than cautious: a copy taken
/// while the source was still being written to is a few thousand rows behind, and
/// a reading that only recognised an exact match would miss precisely the case
/// worth catching — the migration that is still running. Measured spreads on real
/// schemas cluster at 0, 0.0006 and then jump to 0.10; nothing sits in between.
const SPREAD: f64 = 0.02;

/// Below this a table is not worth comparing. A handful of lookup tables sharing
/// a shape and four rows each is not a duplicate, it is an enum.
const ROW_FLOOR: u64 = 100_000;

/// Tables that look like copies of each other, costliest set first.
///
/// `database` narrows it to one; `None` reads every database that is not
/// ClickHouse's own. Needs no query log — `system.columns` and `system.tables`
/// are enough, which is what lets this answer on a server where almost nothing
/// else about the workload can be read.
pub async fn twins(ch: &Client, database: Option<&str>, limit: u64) -> Result<TwinReport> {
    if let Some(why) = blocked(ch).await? {
        return Ok(TwinReport {
            available: false,
            reason: Some(why),
            sets: Vec::new(),
            total_sets: 0,
            total_redundant_bytes: 0,
            spread_allowed: SPREAD,
            row_floor: ROW_FLOOR,
        });
    }

    let scope = match database {
        Some(_) => "database = {db:String}",
        None => USER_DATABASES,
    };
    let params = match database {
        Some(db) => vec![("db".into(), db.to_string())],
        None => Vec::new(),
    };

    /* `arraySort` before hashing, because `groupArray` has no defined order and
    two tables with the same columns in a different position must hash alike —
    which they should: a column list is a set here, not a sequence. The type
    goes into the hash with the name, so `id UInt64` and `id String` are not
    one shape. */
    let sql = format!(
        "WITH shapes AS ( \
             SELECT database, \
                    table, \
                    cityHash64(arraySort(groupArray(concat(name, ':', type)))) AS shape, \
                    toUInt64(count()) AS columns \
             FROM system.columns \
             WHERE {scope} \
             GROUP BY database, table \
         ), \
         sized AS ( \
             SELECT s.database          AS database, \
                    s.table             AS table, \
                    s.shape             AS shape, \
                    s.columns           AS columns, \
                    toUInt64(t.total_rows)  AS rows, \
                    toUInt64(t.total_bytes) AS bytes, \
                    toString(t.metadata_modification_time) AS modified \
             FROM shapes AS s \
             INNER JOIN system.tables AS t \
                 ON t.database = s.database AND t.name = s.table \
             /* Only things that store rows of their own. A view has no rows to \
                compare and its shape is its source's; an `.inner` table is a \
                materialized view's storage and is already accounted for by the \
                view that owns it. */ \
             WHERE t.engine NOT LIKE '%View' \
               AND t.engine != 'Dictionary' \
               AND NOT startsWith(s.table, '.inner') \
               AND t.total_rows >= {ROW_FLOOR} \
         ) \
         SELECT database                                                  AS database, \
                toUInt64(any(columns))                                    AS columns, \
                /* Heaviest first, and by bytes — `x.3` in the tuple below. It \
                   was `x.2`, the row count, which is equal across a twin set by \
                   construction and therefore sorted nothing at all. */ \
                arrayReverseSort( \
                    (x) -> x.3, \
                    groupArray((table, rows, bytes, modified)) \
                )                                                         AS tables, \
                (toFloat64(max(rows)) - toFloat64(min(rows))) / greatest(1.0, toFloat64(max(rows))) \
                                                                          AS row_spread, \
                toUInt64(sum(bytes))                                      AS total_bytes, \
                /* Everything but the heaviest: the least you get back, \
                   whichever copy survives. See the field. */ \
                toUInt64(sum(bytes) - max(bytes))                         AS redundant_bytes \
         FROM sized \
         GROUP BY database, shape \
         HAVING count() > 1 AND row_spread <= {SPREAD} \
         ORDER BY redundant_bytes DESC \
         LIMIT {}",
        limit.clamp(1, 200)
    );

    #[derive(Deserialize)]
    struct Row {
        database: String,
        columns: u64,
        /// `(table, rows, bytes, modified)`.
        tables: Vec<(String, u64, u64, String)>,
        row_spread: f64,
        total_bytes: u64,
        redundant_bytes: u64,
    }
    let rows: Vec<Row> = ch
        .rows_with(
            &sql,
            QueryOptions {
                params,
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;

    let sets: Vec<TwinSet> = rows
        .into_iter()
        .map(|r| TwinSet {
            database: r.database,
            columns: r.columns,
            tables: r
                .tables
                .into_iter()
                .map(|(table, rows, bytes, modified)| Twin {
                    table,
                    rows,
                    bytes,
                    modified,
                })
                .collect(),
            row_spread: r.row_spread,
            redundant_bytes: r.redundant_bytes,
            total_bytes: r.total_bytes,
        })
        .collect();

    Ok(TwinReport {
        available: true,
        reason: None,
        total_sets: sets.len() as u64,
        total_redundant_bytes: sets.iter().map(|s| s.redundant_bytes).sum(),
        sets,
        spread_allowed: SPREAD,
        row_floor: ROW_FLOOR,
    })
}

async fn blocked(ch: &Client) -> Result<Option<String>> {
    Ok(match ch.reach("columns").await? {
        Reach::Readable => None,
        Reach::Denied => Some("this user is not granted SELECT on system.columns".to_string()),
        Reach::Absent | Reach::Unconfigured => {
            Some("system.columns is not available on this server".to_string())
        }
    })
}
