//! The database laid out over time: every table against every partition it has.
//!
//! The schema diagram draws dependencies, which are permanent and have no time
//! axis at all. That is the strangest omission a ClickHouse tool can have,
//! because partitioning by date is the thing this engine does that the others do
//! not — and the shape of a table *over its partitions* is where the answers to
//! most storage questions actually are:
//!
//! - where a TTL stops, and whether it stopped where somebody meant it to
//! - a backfill: six months of history written in one afternoon, sitting in
//!   partitions whose neighbours are a hundredth of the size
//! - a hole, which is either a retention policy or a failed ingest and is never
//!   visible in a total
//! - a partition carrying a thousand parts while the rest carry ten, which is
//!   the merge problem before it becomes a failed insert
//!
//! None of that is legible in `sum(bytes)` on a table row, and none of it is in
//! the diagram. It is one `GROUP BY table, partition` away, which is what this is.
//!
//! Two honesty rules shape what comes back. **Partitions are not sorted here.**
//! A partition id is an opaque string that ClickHouse chose: `202605` for a
//! `toYYYYMM` key, a tuple for a compound one, and the literal `all` for a table
//! with no partition key. Lexicographic order is chronological exactly when the
//! key is a date expression — the common case — and the frontend orders on that
//! basis while saying so. Nothing here pretends to parse a date out of an
//! identifier the server never promised was one. And **the rows are the biggest
//! tables, never an arbitrary prefix**: a grid truncated by whatever the server
//! returned first is a grid nobody can reason about, so the cap ranks by disk and
//! reports what it left out.

use serde::{Deserialize, Serialize};

use super::{Client, QueryOptions, Reach};
use crate::error::{Error, Result};

/* Every `ORDER BY` and `HAVING` in this file names an *expression*, never one of
 * this file's own aliases, and that is not style. `system.parts` has physical
 * columns called `bytes`, `rows`, `table` and `partition`, and this file aliases
 * four of its outputs to exactly those names because they are what the wire
 * should call them — so `ORDER BY bytes` asks ClickHouse to choose between an
 * alias and a column of the same name. It chose correctly here, on this version;
 * an alias shadowing a physical column has already cost this file one refused
 * statement (see `covers_from`), and a sort that silently switched to per-part
 * bytes would not refuse anything — it would just rank the rows wrongly. */

/// One table's parts in one partition — a cell of the grid.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartitionCell {
    pub table: String,
    /// The partition as ClickHouse prints it: `202605`, `('eu',2026)`, or `all`.
    pub partition: String,
    /// The opaque id, which is what any action on this partition would take.
    /// Carried even though this view only reads, because the display string and
    /// the id are the same only for the simplest keys.
    pub partition_id: String,
    pub parts: u64,
    pub rows: u64,
    pub bytes: u64,
    pub uncompressed_bytes: u64,
    /// How many partitions this cell covers. One at the partition grain; more
    /// wherever a coarser scale has folded several into a bucket.
    #[serde(default)]
    pub partitions: u64,
    /// The range the parts actually cover, when there is one.
    ///
    /// Read from `min_date`/`max_date` *or* `min_time`/`max_time`, whichever the
    /// server filled — and it is one or the other, never both. The `_date` pair
    /// is the MergeTree's old Date-key columns and stays at the epoch on a table
    /// partitioned by a `DateTime`; the `_time` pair is the modern one and stays
    /// at the epoch on a table partitioned by a `Date`. Reading only the first,
    /// as this did at first, drops a real range on half the tables in existence
    /// and reports them as undated. Where both are the epoch there genuinely is
    /// no date, and the figure is dropped rather than dashed.
    ///
    /// Named `covers_from` rather than `min_date` for two reasons, one of them
    /// found the hard way: it is a timestamp and not a date, and an output
    /// column aliased `min_date` *shadows the physical column of that name* —
    /// so the aggregate in this field's own expression ended up inside the
    /// query's `GROUP BY` key and ClickHouse refused the statement.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub covers_from: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub covers_to: String,
}

/// How wide a column is.
///
/// `Partition` is the server's own unit and the default: one column per
/// partition, named as ClickHouse names it. The rest are *time*, which is a
/// different question — a table partitioned daily for three years has a thousand
/// columns, and no amount of paging through them shows the shape of a year. The
/// coarser grains ask the server to fold them, which it can do because a part
/// carries the range it covers.
///
/// Buckets are only possible where the parts carry a real range. Where they do
/// not — a partition key that is not a date, or no partition key at all — the
/// parts still hold real disk, so they land in an `undated` column rather than
/// being dropped from a picture of the whole database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Grain {
    #[default]
    Partition,
    Day,
    Week,
    Month,
    Quarter,
    Year,
}

/// The column a part belongs to at this grain, as SQL.
///
/// `UNDATED` rather than an empty string, so a column that exists for a reason
/// is never confused with one whose name the server failed to give.
pub const UNDATED: &str = "undated";

impl Grain {
    /// `instant` is seconds since the epoch — a `UInt32`, because it comes out
    /// of `greatest()` over two `toUnixTimestamp` calls, which is the only way
    /// to take whichever of the server's two date pairs it happened to fill.
    /// Zero means "no instant", so the guard is on the number while every date
    /// function gets it back as a `DateTime` first: ClickHouse refuses a
    /// `UInt32` to `toStartOfMonth`, which is how this was found — in an error
    /// from a real server rather than in a type.
    fn column(self, instant: &str) -> String {
        let at = format!("toDateTime({instant})");
        match self {
            // The server's own name for the partition, whatever shape it is.
            Grain::Partition => "partition".to_string(),
            Grain::Day => format!("if({instant} > 0, toString(toDate({at})), '{UNDATED}')"),
            // Monday, because ClickHouse's own week starts there and a column
            // labelled with a Sunday would disagree with every other date
            // function on the server.
            Grain::Week => {
                format!("if({instant} > 0, toString(toDate(toStartOfWeek({at}, 1))), '{UNDATED}')")
            }
            // `2026-05` rather than `2026-05-01`: the first of the month is not
            // what the column means, and a reader who sees a date reads it as a
            // day.
            Grain::Month => format!(
                "if({instant} > 0, formatDateTime(toStartOfMonth({at}), '%Y-%m'), '{UNDATED}')"
            ),
            // `2026-Q2`, built rather than formatted: ClickHouse has no quarter
            // in `formatDateTime`, and `2026-04-01` would read as a day again.
            Grain::Quarter => format!(
                "if({instant} > 0, concat(toString(toYear({at})), '-Q', toString(toQuarter({at}))), '{UNDATED}')"
            ),
            Grain::Year => {
                format!("if({instant} > 0, toString(toYear({at})), '{UNDATED}')")
            }
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Grain::Partition => "partition",
            Grain::Day => "day",
            Grain::Week => "week",
            Grain::Month => "month",
            Grain::Quarter => "quarter",
            Grain::Year => "year",
        }
    }
}

/// A row of the grid: one table, and what it holds in total.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineTable {
    pub table: String,
    pub partitions: u64,
    pub parts: u64,
    pub rows: u64,
    pub bytes: u64,
    /// The partition key expression, empty when the table has none. Empty is
    /// worth drawing: a single `all` column is not a timeline, and saying "not
    /// partitioned" is the whole answer for that row.
    #[serde(default)]
    pub partition_key: String,
}

/// The grid, plus everything it is leaving out.
#[derive(Debug, Clone, Serialize)]
pub struct PartitionTimeline {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub tables: Vec<TimelineTable>,
    pub cells: Vec<PartitionCell>,
    /// Every table in this database with active parts, drawn or not.
    pub total_tables: u64,
    /// Disk held by the whole database, so the caption can say what share of it
    /// the drawn rows account for. A cap that hides 90 tables holding 2% of the
    /// disk and one that hides 2% of the tables holding 90% of it are not the
    /// same cap, and only this figure tells them apart.
    pub total_bytes: u64,
    /// True when the cell query hit its own ceiling. Separate from the table
    /// cap: this one means the grid is incomplete *for a table that is drawn*,
    /// which is the worse kind of missing and has to be said differently.
    pub cells_truncated: bool,
    /// The grain these cells are at.
    pub grain: &'static str,
    /// Whether a coarser grain is possible at all: whether *any* part in this
    /// database carries a real range. On a database that partitions by
    /// something other than a date the answer is no, and the control says so
    /// rather than offering three scales that would all collapse into one
    /// `undated` column.
    pub datable: bool,
    /// The whole range the drawn tables cover, so the axis can be *continuous*.
    ///
    /// Without it the columns are only the buckets that exist, and a month in
    /// which nothing at all was written has no column rather than an empty one —
    /// so a gap in the data closes up silently and the view stops being able to
    /// show the one thing it claims: a hole where an ingest failed. The buckets
    /// between these two ends are filled in by the client, which is where the
    /// arithmetic belongs; the server's job is to say where the ends are.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub span_from: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub span_to: String,
    /// What a row is: a table of one database, or a whole database of the
    /// server. The grid is the same grid — the question "which of these is
    /// growing" does not change shape when the things being asked about get
    /// bigger — but a row's name, its link and the word for a row all follow
    /// from this, so it travels with the answer rather than being remembered by
    /// whoever asked.
    pub scope: &'static str,
}

/// Whose rows the grid is drawing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope<'a> {
    /// The tables of one database.
    Database(&'a str),
    /// Every database on the server. `system` included: it is where a great deal
    /// of a server's disk actually goes, and a picture of "which of my databases
    /// is growing" that quietly dropped the one growing fastest would be worse
    /// than no picture.
    Server,
}

impl Scope<'_> {
    fn as_str(self) -> &'static str {
        match self {
            Scope::Database(_) => "database",
            Scope::Server => "server",
        }
    }

    /// The expression that identifies a row.
    fn row(self) -> &'static str {
        match self {
            Scope::Database(_) => "table",
            Scope::Server => "database",
        }
    }

    /// What narrows the parts to this scope. A parameter, never interpolation:
    /// a database name is a string from the server.
    fn filter(self) -> &'static str {
        match self {
            Scope::Database(_) => "AND database = {db:String} ",
            Scope::Server => "",
        }
    }
}

/// How many tables the grid draws. Rows are cheap to read and columns are not,
/// so this is generous compared to the diagram's own cap.
const DEFAULT_TABLES: u64 = 40;
const MAX_TABLES: u64 = 200;
/// A ceiling on cells, because a wide database of daily partitions is a product
/// of two large numbers. 12000 is around 60 tables of 200 partitions.
const MAX_CELLS: u64 = 12_000;

/// Every row of a scope against every partition it has, or against a scale of
/// time when one is asked for.
pub async fn partition_timeline(
    ch: &Client,
    scope: Scope<'_>,
    table_limit: Option<u64>,
    grain: Grain,
) -> Result<PartitionTimeline> {
    if let Some(why) = blocked(ch).await? {
        return Ok(empty(Some(why), grain, scope));
    }
    let limit = table_limit.unwrap_or(DEFAULT_TABLES).clamp(1, MAX_TABLES);

    /* The instant a part covers, from whichever pair of columns this server
    filled. Both pairs exist on every version Flint supports, but only one of
    them is ever populated for a given table: `min_date` for a Date partition
    key, `min_time` for a DateTime one. Guarded all the same — a system table
    gaining and losing columns across versions is the reason `col_or` exists. */
    let min_date_col = ch.col_or("parts", "min_date", "toDate(0)").await?;
    let max_date_col = ch.col_or("parts", "max_date", "toDate(0)").await?;
    let min_time_col = ch.col_or("parts", "min_time", "toDateTime(0)").await?;
    let max_time_col = ch.col_or("parts", "max_time", "toDateTime(0)").await?;
    // Seconds since the epoch, or zero where the server filled neither.
    let from_at = format!(
        "greatest(toUnixTimestamp(toDateTime({min_date_col})), toUnixTimestamp({min_time_col}))"
    );
    let to_at = format!(
        "greatest(toUnixTimestamp(toDateTime({max_date_col})), toUnixTimestamp({max_time_col}))"
    );
    let stamp = |at: &str| format!("if({at} > 0, toString(toDateTime({at})), '')");
    let row = scope.row();
    let scoped = scope.filter();
    let opts = || QueryOptions {
        params: match scope {
            Scope::Database(db) => vec![("db".into(), db.to_string())],
            // The parameter is unused at server scope; sending it anyway would
            // be a statement carrying a binding its SQL never mentions.
            Scope::Server => Vec::new(),
        },
        ..QueryOptions::internal()
    };

    #[derive(Deserialize)]
    struct Totals {
        tables: u64,
        bytes: u64,
    }
    let totals: Totals = match ch
        .row_with::<Totals>(
            &format!(
                "SELECT toUInt64(uniqExact({row}))          AS tables, \
                        toUInt64(sum(bytes_on_disk))        AS bytes \
                 FROM system.parts \
                 WHERE active {scoped}"
            ),
            opts(),
        )
        .await
    {
        Ok(row) => row.unwrap_or(Totals {
            tables: 0,
            bytes: 0,
        }),
        Err(e) if degraded(&e) => return Ok(empty(Some(denied()), grain, scope)),
        Err(e) => return Err(e),
    };

    /* Whether time is an axis on this database at all. Asked of the parts rather
    than of the partition keys: a `toYYYYMM(ts)` key says a date is in there,
    and only the parts say whether the server wrote the range down. */
    #[derive(Deserialize)]
    struct Datable {
        dated: u64,
    }
    let datable = ch
        .row_with::<Datable>(
            &format!(
                "SELECT toUInt64(countIf({from_at} > 0)) AS dated \
                 FROM system.parts WHERE active {scoped}"
            ),
            opts(),
        )
        .await
        .ok()
        .flatten()
        .map(|d| d.dated > 0)
        .unwrap_or(false);
    // A scale nobody can draw is not offered: the request falls back to the
    // server's own partitions, and the report says why by way of `datable`.
    let grain = if datable { grain } else { Grain::Partition };

    // The rows: the biggest tables, because a cap has to rank by something and
    // disk is what this grid is about.
    let ranked = format!(
        "SELECT {row}                                   AS table, \
                toUInt64(uniqExact(partition))          AS partitions, \
                toUInt64(count())                       AS parts, \
                toUInt64(sum(rows))                     AS rows, \
                toUInt64(sum(bytes_on_disk))            AS bytes \
         FROM system.parts \
         WHERE active {scoped}\
         GROUP BY {row} \
         ORDER BY sum(bytes_on_disk) DESC, {row} ASC \
         LIMIT {limit}"
    );
    let mut tables: Vec<TimelineTable> = match ch.rows_with(&ranked, opts()).await {
        Ok(rows) => rows,
        Err(e) if degraded(&e) => return Ok(empty(Some(denied()), grain, scope)),
        Err(e) => return Err(e),
    };

    if tables.is_empty() {
        // No active parts anywhere: a database of views, or an empty one. That
        // is an answer, not a failure — the grid says so rather than erroring.
        return Ok(PartitionTimeline {
            available: true,
            reason: None,
            tables,
            cells: Vec::new(),
            total_tables: totals.tables,
            total_bytes: totals.bytes,
            cells_truncated: false,
            grain: grain.as_str(),
            datable,
            span_from: String::new(),
            span_to: String::new(),
            scope: scope.as_str(),
        });
    }

    // The cells, for the drawn tables only. The subquery repeats the ranking
    // rather than interpolating the names: a table name is a string from the
    // server and building an `IN ('a','b')` list out of it would be the one
    // place in this file that quotes an identifier by hand.
    let column = grain.column(&from_at);
    /* At the partition grain the id is the partition's own and is worth carrying;
    a bucket of several partitions has no single id, and inventing one — the
    first, say — would hand a caller an id that acts on a fraction of what the
    cell shows. So it is empty there, deliberately. */
    let id = if grain == Grain::Partition {
        "any(partition_id)".to_string()
    } else {
        "''".to_string()
    };
    let cells_sql = format!(
        "SELECT {row}                                   AS table, \
                {column}                                AS partition, \
                {id}                                    AS partition_id, \
                toUInt64(count())                       AS parts, \
                toUInt64(uniqExact(partition))          AS partitions, \
                toUInt64(sum(rows))                     AS rows, \
                toUInt64(sum(bytes_on_disk))            AS bytes, \
                toUInt64(sum(data_uncompressed_bytes))  AS uncompressed_bytes, \
                {from_stamp}                            AS covers_from, \
                {to_stamp}                              AS covers_to \
         FROM system.parts \
         WHERE active {scoped}AND {row} IN ( \
             SELECT r FROM ( \
                 SELECT {row} AS r, sum(bytes_on_disk) AS b \
                 FROM system.parts \
                 WHERE active {scoped}\
                 GROUP BY r ORDER BY b DESC, r ASC LIMIT {limit} \
             ) \
         ) \
         GROUP BY {row}, partition \
         ORDER BY {row} ASC, partition ASC \
         LIMIT {cap}",
        from_stamp = stamp(&format!("min({from_at})")),
        to_stamp = stamp(&format!("max({to_at})")),
        cap = MAX_CELLS + 1
    );
    /* The ends of the axis, over the drawn tables only: a table the row cap left
    out must not stretch the axis with a range whose row is not there to see. */
    #[derive(Deserialize)]
    struct Span {
        span_from: String,
        span_to: String,
    }
    let span_sql = format!(
        "SELECT {from_stamp}                            AS span_from, \
                {to_stamp}                              AS span_to \
         FROM system.parts \
         WHERE active {scoped}AND {from_at} > 0 AND {row} IN ( \
             SELECT r FROM ( \
                 SELECT {row} AS r, sum(bytes_on_disk) AS b \
                 FROM system.parts \
                 WHERE active {scoped}\
                 GROUP BY r ORDER BY b DESC, r ASC LIMIT {limit} \
             ) \
         )",
        from_stamp = stamp(&format!("min({from_at})")),
        to_stamp = stamp(&format!("max({to_at})")),
    );
    let span = ch
        .row_with::<Span>(&span_sql, opts())
        .await
        .ok()
        .flatten()
        .unwrap_or(Span {
            span_from: String::new(),
            span_to: String::new(),
        });

    let mut cells: Vec<PartitionCell> = match ch.rows_with(&cells_sql, opts()).await {
        Ok(rows) => rows,
        Err(e) if degraded(&e) => return Ok(empty(Some(denied()), grain, scope)),
        Err(e) => return Err(e),
    };
    let cells_truncated = cells.len() as u64 > MAX_CELLS;
    cells.truncate(MAX_CELLS as usize);

    // The partition key, which decides whether a row is a timeline at all. A
    // table with no key has every part in `all`, and one cell called `all` in a
    // grid of months reads as a date until something says otherwise.
    #[derive(Deserialize)]
    struct Key {
        table: String,
        partition_key: String,
    }
    /* Only at database scope. A *database* has no partition key — its tables
    each have their own — so asking would produce a row of them and a label
    that means nothing about the row it is under. */
    let keys: Vec<Key> = if matches!(scope, Scope::Server) {
        Vec::new()
    } else {
        ch.rows_with(
            "SELECT name AS table, partition_key AS partition_key \
             FROM system.tables WHERE database = {db:String}",
            opts(),
        )
        .await
        .unwrap_or_default()
    };
    for t in &mut tables {
        if let Some(k) = keys.iter().find(|k| k.table == t.table) {
            t.partition_key = k.partition_key.clone();
        }
    }

    Ok(PartitionTimeline {
        available: true,
        reason: None,
        tables,
        cells,
        total_tables: totals.tables,
        total_bytes: totals.bytes,
        cells_truncated,
        grain: grain.as_str(),
        datable,
        span_from: span.span_from,
        span_to: span.span_to,
        scope: scope.as_str(),
    })
}

fn empty(reason: Option<String>, grain: Grain, scope: Scope<'_>) -> PartitionTimeline {
    PartitionTimeline {
        available: false,
        reason,
        tables: Vec::new(),
        cells: Vec::new(),
        total_tables: 0,
        total_bytes: 0,
        cells_truncated: false,
        grain: grain.as_str(),
        datable: false,
        span_from: String::new(),
        span_to: String::new(),
        scope: scope.as_str(),
    }
}

fn denied() -> String {
    "this user is not granted SELECT on system.parts".to_string()
}

/// Errors that mean "you may not read this", rather than "this query is wrong".
/// 497 is `ACCESS_DENIED`, 164 `READONLY` — the two a restricted role hits on
/// `system.parts`, and neither is worth a 500 when the honest answer is that the
/// grid cannot be drawn for this user.
fn degraded(e: &Error) -> bool {
    matches!(
        e,
        Error::ClickHouse { code: 497, .. } | Error::ClickHouse { code: 164, .. }
    )
}

async fn blocked(ch: &Client) -> Result<Option<String>> {
    Ok(match ch.reach("parts").await? {
        Reach::Readable => None,
        Reach::Denied => Some(denied()),
        Reach::Absent | Reach::Unconfigured => {
            Some("this ClickHouse has no system.parts".to_string())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The instant expression as the query builds it, for readability below.
    const AT: &str = "at";

    #[test]
    fn the_partition_grain_asks_the_server_for_its_own_name() {
        // Not a date function of any kind: at this grain the column is whatever
        // ClickHouse calls the partition, including `tuple()` and `all`.
        assert_eq!(Grain::Partition.column(AT), "partition");
    }

    #[test]
    fn a_coarser_grain_buckets_by_time_and_names_what_it_cannot_place() {
        // Every date grain has to answer for the parts with no instant: they
        // hold real disk, so they get a column rather than disappearing from a
        // picture of the whole database.
        for grain in [
            Grain::Day,
            Grain::Week,
            Grain::Month,
            Grain::Quarter,
            Grain::Year,
        ] {
            let sql = grain.column(AT);
            assert!(sql.contains("at > 0"), "{sql}");
            assert!(sql.contains("'undated'"), "{sql}");
        }
    }

    #[test]
    fn a_month_is_labelled_as_a_month_and_not_as_its_first_day() {
        // `2026-05-01` reads as a day, and a column that means May must not.
        let sql = Grain::Month.column(AT);
        assert!(sql.contains("'%Y-%m'"), "{sql}");
        assert!(!sql.contains("toDate(toStartOfMonth"), "{sql}");
    }

    #[test]
    fn a_week_starts_on_monday_like_every_other_date_function_here() {
        // `toStartOfWeek` defaults to Sunday; a column labelled with a Sunday
        // would disagree with the rest of the server.
        assert!(Grain::Week
            .column(AT)
            .contains("toStartOfWeek(toDateTime(at), 1)"));
    }

    #[test]
    fn every_date_function_gets_a_datetime_while_the_guard_gets_the_number() {
        // The instant arrives as seconds since the epoch, because taking
        // whichever of the server's two date pairs it filled means `greatest()`
        // over two timestamps. ClickHouse refuses a `UInt32` to
        // `toStartOfMonth` — found in an error from a real server.
        for grain in [
            Grain::Day,
            Grain::Week,
            Grain::Month,
            Grain::Quarter,
            Grain::Year,
        ] {
            let sql = grain.column(AT);
            assert!(sql.starts_with("if(at > 0,"), "{sql}");
            assert!(!sql.contains("toStartOfMonth(at)"), "{sql}");
            assert!(!sql.contains("toDate(at)"), "{sql}");
        }
    }

    #[test]
    fn a_quarter_is_built_because_no_format_string_has_one() {
        // `formatDateTime` has no quarter, and `2026-04-01` — the obvious
        // fallback — reads as a day, which is the one thing a quarter column
        // must not do.
        let sql = Grain::Quarter.column(AT);
        assert!(sql.contains("'-Q'"), "{sql}");
        assert!(sql.contains("toQuarter"), "{sql}");
    }

    #[test]
    fn the_grain_names_itself_the_way_the_wire_spells_it() {
        assert_eq!(Grain::Partition.as_str(), "partition");
        assert_eq!(Grain::Month.as_str(), "month");
    }
}
