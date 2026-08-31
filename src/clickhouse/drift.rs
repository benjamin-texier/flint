//! What a table looked like, period by period.
//!
//! The profile answers *what is in this table*; `relations.rs` answers *what do
//! its columns say about each other*. Both are snapshots, and a snapshot cannot
//! answer the question people actually arrive with when something is wrong:
//! **has this changed?**
//!
//! This module **measures**. It cuts the table into periods on its own time
//! column and reads each one — rows, nulls, distinct values, averages — and has
//! no opinion about any of it. Deciding which of those movements is *news*, and
//! how to word it, is `frontend/src/lib/drift.ts`, where the thresholds are pure
//! functions with a test each. The split is the one `review.rs` and
//! `projection.rs` already follow: the rules are the arguable part, and an
//! argument belongs in a test file rather than inside a SQL string.
//!
//! Three things were measured on real tables before any of this was written, and
//! each decided part of what is read here rather than what is concluded from it.
//!
//! - **The window is bounded by periods, never by rows.** Cost, measured rather
//!   than assumed: 5,000,000 rows and 122 MB in **56 ms** for six aggregates
//!   over 31 periods. A row prefix would be cheaper still and would bias *which*
//!   periods were read, which is the one thing a comparison between periods
//!   cannot survive.
//! - **The server finds the gaps.** `ORDER BY … WITH FILL STEP toIntervalDay(1)`
//!   emits the periods that hold no rows, which `GROUP BY` alone silently omits
//!   and a chart drawn from it quietly closes over. A filled period comes back
//!   with zeros, so `rows = 0` is how the reader above tells "no rows arrived"
//!   from "no reading of anything" — and every other figure in such a period is
//!   sent as `null` rather than as `0`, because an absence is not a measurement.
//! - **The period stays a `DateTime` all the way out.** Grouping on a formatted
//!   string and ordering on the expression behind it is what the server refuses,
//!   and `WITH FILL` can only walk a real date. So the label is formatted where
//!   the step is known — in the frontend — and not here.

use serde::{Deserialize, Serialize};

use super::{Client, QueryOptions};
use crate::error::{Error, Result};

/// How many periods the window holds at most. Enough for a month of days or two
/// years of months, and small enough that the sentence "over the last N" stays
/// something a reader can hold.
const MAX_PERIODS: usize = 60;

/// Columns profiled per period. Every column costs up to three aggregates in the
/// one pass; a two-hundred-column table would be six hundred, which is a
/// different query than the one measured above.
const MAX_COLUMNS: usize = 24;

/// The periods a window is cut into.
///
/// Deliberately not `timeline::Grain`, which is the same idea over a different
/// subject: that one buckets *parts*, carries a `Partition` arm that has no
/// meaning over a column of data, and takes its instant as a `UInt32` out of
/// `greatest(toUnixTimestamp(…), …)`. Sharing an enum whose first variant is
/// invalid for half its callers would be worse than two small ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Step {
    Hour,
    #[default]
    Day,
    Week,
    Month,
}

impl Step {
    fn expr(self, column: &str) -> String {
        match self {
            Step::Hour => format!("toStartOfHour({column})"),
            Step::Day => format!("toStartOfDay({column})"),
            // Monday, because ClickHouse's own week starts there.
            Step::Week => format!("toStartOfWeek({column}, 1)"),
            Step::Month => format!("toStartOfMonth({column})"),
        }
    }

    /// The interval `WITH FILL` steps by, which must match the bucket exactly or
    /// the fill invents periods between the real ones.
    fn interval(self) -> &'static str {
        match self {
            Step::Hour => "toIntervalHour(1)",
            Step::Day => "toIntervalDay(1)",
            Step::Week => "toIntervalWeek(1)",
            Step::Month => "toIntervalMonth(1)",
        }
    }

    /// The step that cuts a span into a readable number of periods. Seconds in,
    /// because that is what the difference of two timestamps is.
    fn for_span(seconds: u64) -> Step {
        const HOUR: u64 = 3_600;
        const DAY: u64 = 24 * HOUR;
        match seconds {
            s if s <= 3 * DAY => Step::Hour,
            s if s <= 90 * DAY => Step::Day,
            s if s <= 730 * DAY => Step::Week,
            _ => Step::Month,
        }
    }
}

/// One column's readings, period by period, in the same order as `periods`.
///
/// Absences are `null` rather than zero throughout: a period that the fill
/// invented has no reading of anything, and `0.0` would be a measurement.
#[derive(Debug, Clone, Serialize)]
pub struct Series {
    pub name: String,
    pub r#type: String,
    /// Share of rows where the column is NULL. Absent for a column that cannot
    /// be null — not zero, because "never null" and "not asked" are different.
    pub nulls: Option<Vec<Option<f64>>>,
    pub distinct: Vec<Option<u64>>,
    /// Only for numerics.
    pub mean: Option<Vec<Option<f64>>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Drift {
    pub available: bool,
    pub reason: Option<String>,
    pub database: String,
    pub table: String,
    /// The column the periods are cut on. Absent where the table has no date or
    /// time column at all, which is not a fault — plenty of tables do not.
    pub time_column: Option<String>,
    pub step: Step,
    /// The period labels, oldest first, gaps included.
    pub periods: Vec<String>,
    /// Rows in each, in the same order. Zero where the period was filled in.
    pub rows: Vec<u64>,
    pub series: Vec<Series>,
    /// Columns the table has, and how many of them this looked at.
    pub columns: u64,
    pub examined: u64,
    /// True when the window was cut to `MAX_PERIODS` and the table is older.
    pub windowed: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct Column {
    name: String,
    r#type: String,
}

pub async fn drift(ch: &Client, database: &str, table: &str) -> Result<Drift> {
    let columns: Vec<Column> = match ch
        .rows_with(
            "SELECT name AS name, type AS type FROM system.columns \
             WHERE database = {db:String} AND table = {tbl:String} \
             ORDER BY position",
            params(database, table),
        )
        .await
    {
        Ok(c) => c,
        Err(e) if refused(&e) => return Ok(empty(database, table, Some(said(&e)))),
        Err(e) => return Err(e),
    };

    let Some(time_column) = pick_time_column(ch, database, table, &columns).await? else {
        // Not a fault, and not an error to report: a dimension table has no time
        // axis and never will. The page says so and offers nothing.
        return Ok(Drift {
            columns: columns.len() as u64,
            ..empty(database, table, None)
        });
    };

    // The span decides the step, so it is asked for first and on its own — one
    // cheap aggregate over the primary key rather than a guess.
    let quoted_time = quote(&time_column);
    let span: Vec<SpanRow> = ch
        .rows_with(
            &format!(
                "SELECT toUInt64(ifNull(toUnixTimestamp(min({quoted_time})), 0)) AS lo, \
                 toUInt64(ifNull(toUnixTimestamp(max({quoted_time})), 0)) AS hi \
                 FROM {}.{}",
                quote(database),
                quote(table)
            ),
            params(database, table),
        )
        .await
        .or_else(|e| if refused(&e) { Ok(Vec::new()) } else { Err(e) })?;

    let Some(SpanRow { lo, hi }) = span.into_iter().next() else {
        return Ok(Drift {
            time_column: Some(time_column),
            columns: columns.len() as u64,
            ..empty(database, table, None)
        });
    };
    if hi == 0 || hi <= lo {
        // One instant, or none: there is no "over time" to read.
        return Ok(Drift {
            time_column: Some(time_column),
            columns: columns.len() as u64,
            ..empty(database, table, None)
        });
    }
    let step = Step::for_span(hi - lo);

    /* Which columns to read. The time column is skipped — its own distinct count
    and average are the period, restated — and so is anything the pass cannot
    say something useful about. */
    let examined: Vec<&Column> = columns
        .iter()
        .filter(|c| c.name != time_column && !unreadable(&c.r#type))
        .take(MAX_COLUMNS)
        .collect();

    let bucket = step.expr(&quoted_time);
    /* The period stays a `DateTime` all the way out. Grouping on a formatted
    string and then ordering on the expression behind it is what the server
    refuses — and `WITH FILL` can only step along a real date anyway. Which
    leaves the label: the server's own `2026-08-01 00:00:00`, formatted for the
    step where it is drawn rather than here, because a filled period would take
    the default for any second column derived from the key and a month labelled
    with a day is the mistake `timeline.rs` already documents. */
    let mut select = vec![
        format!("{bucket} AS period"),
        "toUInt64(count()) AS n".to_string(),
    ];
    for (i, c) in examined.iter().enumerate() {
        let q = quote(&c.name);
        select.push(format!("toUInt64(uniqCombined({q})) AS u{i}"));
        if nullable(&c.r#type) {
            select.push(format!("toUInt64(countIf({q} IS NULL)) AS z{i}"));
        }
        if numeric(&c.r#type) {
            select.push(format!("toFloat64(avg({q})) AS a{i}"));
        }
    }

    /* `WITH FILL` is what makes a gap visible: `GROUP BY` alone omits a period
    with no rows, and a chart drawn from that quietly closes over it. The step
    must match the bucket exactly, or the fill invents periods between the real
    ones. The window is the *last* N periods, taken by ordering descending and
    reversing here — the recent end is the one somebody is asking about. */
    let sql = format!(
        "SELECT {} FROM {}.{} WHERE {quoted_time} IS NOT NULL \
         GROUP BY period ORDER BY period WITH FILL STEP {}",
        select.join(", "),
        quote(database),
        quote(table),
        step.interval(),
    );

    let rows: Vec<serde_json::Value> = match ch.rows_with(&sql, params(database, table)).await {
        Ok(r) => r,
        Err(e) if refused(&e) => {
            return Ok(Drift {
                time_column: Some(time_column),
                columns: columns.len() as u64,
                ..empty(database, table, Some(said(&e)))
            })
        }
        Err(e) => return Err(e),
    };

    let windowed = rows.len() > MAX_PERIODS;
    let rows: Vec<serde_json::Value> = if windowed {
        rows[rows.len() - MAX_PERIODS..].to_vec()
    } else {
        rows
    };

    let periods: Vec<String> = rows
        .iter()
        .map(|r| text(r, "period").unwrap_or_default())
        .collect();
    let counts: Vec<u64> = rows.iter().map(|r| num(r, "n")).collect();

    let mut series = Vec::new();
    for (i, c) in examined.iter().enumerate() {
        let present = |k: usize| counts[k] > 0;
        let distinct = (0..rows.len())
            .map(|k| present(k).then(|| num(&rows[k], &format!("u{i}"))))
            .collect();
        let nulls = nullable(&c.r#type).then(|| {
            (0..rows.len())
                .map(|k| {
                    present(k).then(|| num(&rows[k], &format!("z{i}")) as f64 / counts[k] as f64)
                })
                .collect()
        });
        let mean = numeric(&c.r#type).then(|| {
            (0..rows.len())
                .map(|k| {
                    present(k)
                        .then(|| float(&rows[k], &format!("a{i}")))
                        .flatten()
                })
                .collect()
        });
        series.push(Series {
            name: c.name.clone(),
            r#type: c.r#type.clone(),
            nulls,
            distinct,
            mean,
        });
    }

    Ok(Drift {
        available: true,
        reason: None,
        database: database.to_string(),
        table: table.to_string(),
        time_column: Some(time_column),
        step,
        periods,
        rows: counts,
        series,
        columns: columns.len() as u64,
        examined: examined.len() as u64,
        windowed,
    })
}

#[derive(Deserialize)]
struct SpanRow {
    lo: u64,
    hi: u64,
}

/// The time column the periods are cut on.
///
/// The sorting key first, because a MergeTree that is queried by time is almost
/// always sorted by it, and that is the column the data is actually laid out
/// along — bucketing on any other date in the row would read the whole table to
/// answer. Failing that, the first date column by position, which is the
/// convention nearly every event table follows.
async fn pick_time_column(
    ch: &Client,
    database: &str,
    table: &str,
    columns: &[Column],
) -> Result<Option<String>> {
    let dated: Vec<&str> = columns
        .iter()
        .filter(|c| temporal(&c.r#type))
        .map(|c| c.name.as_str())
        .collect();
    if dated.is_empty() {
        return Ok(None);
    }

    #[derive(Deserialize)]
    struct KeyRow {
        sorting_key: String,
    }
    let key: Vec<KeyRow> = ch
        .rows_with(
            "SELECT sorting_key AS sorting_key FROM system.tables \
             WHERE database = {db:String} AND name = {tbl:String}",
            params(database, table),
        )
        .await
        .unwrap_or_default();
    let key = key
        .into_iter()
        .next()
        .map(|k| k.sorting_key)
        .unwrap_or_default();

    // Word-boundary rather than `contains`: a key of `created_at` must not match
    // a column called `at`.
    let in_key = dated.iter().find(|name| {
        key.split(|c: char| !c.is_alphanumeric() && c != '_')
            .any(|part| part == **name)
    });
    Ok(Some(in_key.copied().unwrap_or(dated[0]).to_string()))
}

fn temporal(declared: &str) -> bool {
    let t = declared
        .trim_start_matches("LowCardinality(")
        .trim_start_matches("Nullable(");
    t.starts_with("Date")
}

fn nullable(declared: &str) -> bool {
    declared.contains("Nullable(")
}

fn numeric(declared: &str) -> bool {
    let t = declared
        .trim_start_matches("LowCardinality(")
        .trim_start_matches("Nullable(");
    t.starts_with("UInt")
        || t.starts_with("Int")
        || t.starts_with("Float")
        || t.starts_with("Decimal")
}

/// Types this pass has nothing to say about. An aggregate over a nested or
/// binary column either fails or answers something nobody asked — and a
/// `uniqCombined` over a megabyte of JSON per row is a promise about cost that
/// this module should not make.
fn unreadable(declared: &str) -> bool {
    let t = declared
        .trim_start_matches("LowCardinality(")
        .trim_start_matches("Nullable(");
    t.starts_with("Array")
        || t.starts_with("Map")
        || t.starts_with("Tuple")
        || t.starts_with("Nested")
        || t.starts_with("AggregateFunction")
        || t.starts_with("SimpleAggregateFunction")
        || t.starts_with("JSON")
        || t.starts_with("Object")
}

fn params(database: &str, table: &str) -> QueryOptions {
    QueryOptions {
        params: vec![
            ("db".into(), database.to_string()),
            ("tbl".into(), table.to_string()),
        ],
        ..QueryOptions::internal()
    }
}

/// An identifier inside an expression. Backticks doubled, which is ClickHouse's
/// own escape — the one place here where a name is not a bound parameter,
/// because a parameter cannot be an expression.
fn quote(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn num(row: &serde_json::Value, key: &str) -> u64 {
    row.get(key)
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .unwrap_or(0)
}

fn float(row: &serde_json::Value, key: &str) -> Option<f64> {
    row.get(key)
        .and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .filter(|v| v.is_finite())
}

fn text(row: &serde_json::Value, key: &str) -> Option<String> {
    row.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn refused(e: &Error) -> bool {
    matches!(
        e,
        Error::ClickHouse { code: 497, .. }   // ACCESS_DENIED
            | Error::ClickHouse { code: 241, .. } // MEMORY_LIMIT_EXCEEDED
            | Error::ClickHouse { code: 159, .. } // TIMEOUT_EXCEEDED
            | Error::ClickHouse { code: 60, .. } // UNKNOWN_TABLE — dropped mid-read
    )
}

fn said(e: &Error) -> String {
    match e {
        Error::ClickHouse { code: 241, .. } => {
            "this table is too wide for one pass within the server's memory limit".to_string()
        }
        Error::ClickHouse { code: 159, .. } => "the scan ran past the query timeout".to_string(),
        other => other.to_string().lines().next().unwrap_or("").to_string(),
    }
}

fn empty(database: &str, table: &str, reason: Option<String>) -> Drift {
    Drift {
        available: reason.is_none(),
        reason,
        database: database.to_string(),
        table: table.to_string(),
        time_column: None,
        step: Step::Day,
        periods: Vec::new(),
        rows: Vec::new(),
        series: Vec::new(),
        columns: 0,
        examined: 0,
        windowed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_span_picks_a_readable_step() {
        // The one judgement left in this half, and it is about legibility rather
        // than about the data: how many periods a reader can hold at once.
        assert_eq!(Step::for_span(3_600), Step::Hour);
        assert_eq!(Step::for_span(30 * 86_400), Step::Day);
        assert_eq!(Step::for_span(200 * 86_400), Step::Week);
        assert_eq!(Step::for_span(2_000 * 86_400), Step::Month);
    }

    #[test]
    fn the_fill_step_matches_the_bucket() {
        /* If these two ever disagree the fill invents periods between the real
        ones — a chart with twice as many points as the table has, and no error
        anywhere to say so. */
        for (step, bucket, interval) in [
            (Step::Hour, "toStartOfHour", "Hour"),
            (Step::Day, "toStartOfDay", "Day"),
            (Step::Week, "toStartOfWeek", "Week"),
            (Step::Month, "toStartOfMonth", "Month"),
        ] {
            assert!(step.expr("`ts`").starts_with(bucket));
            assert_eq!(step.interval(), format!("toInterval{interval}(1)"));
        }
    }

    #[test]
    fn a_type_is_read_through_its_wrappers() {
        // ClickHouse nests them, and every predicate here is asked about the
        // type as declared rather than as stored.
        assert!(temporal("Nullable(DateTime64(3))"));
        assert!(temporal("LowCardinality(Date)"));
        assert!(!temporal("String"));
        assert!(numeric("Nullable(UInt32)"));
        assert!(!numeric("LowCardinality(String)"));
        assert!(nullable("Nullable(String)"));
        assert!(!nullable("String"));
    }

    #[test]
    fn a_column_this_pass_cannot_read_is_left_out() {
        /* An aggregate over a nested or binary column either fails or answers
        something nobody asked — and a `uniqCombined` over a megabyte of JSON per
        row is a promise about cost this module should not make. */
        for t in [
            "Array(String)",
            "Map(String, UInt8)",
            "Tuple(UInt8, UInt8)",
            "JSON",
        ] {
            assert!(unreadable(t), "{t} should be left out");
        }
        assert!(!unreadable("Nullable(String)"));
    }

    #[test]
    fn an_identifier_survives_a_backtick() {
        // A column really can be called `a`b`, and this is the one place in the
        // module where a name is not a bound parameter.
        assert_eq!(quote("a`b"), "`a``b`");
    }
}
