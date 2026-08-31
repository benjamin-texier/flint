//! The shape of one column.
//!
//! The profile gives five numbers per column — distinct, null, min, max, mean —
//! and five numbers cannot say whether a column is evenly spread, piled at one
//! end, split into two clusters, or one value and a rounding error. That is the
//! difference between knowing a column's range and knowing its distribution, and
//! it is the last of the brief's analysis list that the product had no answer
//! for.
//!
//! This module **measures**: it counts rows into buckets and says nothing about
//! what the counts mean. Naming the shape and wording it is
//! `frontend/src/lib/distribution.ts`, where the thresholds are pure functions
//! with a test each — the split `review.rs` and `projection.rs` set.
//!
//! Asked for one column at a time. A table's worth would be one query per
//! column, and the profile already reads every column in a single pass for the
//! numbers that a single pass can produce; a histogram is not one of them,
//! because each column needs its own range before it can be binned.
//!
//! Four things were measured on real tables before this was written, and each
//! one decided part of what is counted.
//!
//! - **ClickHouse's own `histogram(n)` is the wrong tool here.** It answers in
//!   9 ms and returns *adaptive* bins: unequal widths and fractional heights —
//!   `(12, 208.08, 105473.75)` on a real column. Bars of equal width drawn from
//!   bins of unequal width misstate density, which is the one thing a histogram
//!   exists to show, and 105,473.75 is not a number of rows. Equal-width bins
//!   cost 15 ms over the same 482,212 rows and are exact.
//! - **Empty buckets vanish from a `GROUP BY`, and the axis lies.**
//!   `analytics.device_daily.events` binned into twelve came back as five rows —
//!   bins 0, 1, 6, 7 and 11. Drawn in order they read as five adjacent bars, a
//!   smooth ramp; the truth is 42,000 rows at the top of the range and 800
//!   scattered below it. `WITH FILL FROM 0 TO n STEP 1` emits the empties, the
//!   same way the drift reader gets its gaps.
//! - **A column with few distinct values is a tally, not a histogram.** That
//!   same column holds six distinct values across a range twelve wide, so seven
//!   of its twelve bins were empty *by construction* and the chart was reporting
//!   an artefact of the binning rather than a fact about the data. Below
//!   `TALLY_MAX` the values are counted as themselves.
//! - **A high-cardinality string has neither a range nor a tally.** It gets its
//!   most common values and an honest remainder: what is not listed is counted
//!   and said, never dropped.

use serde::{Deserialize, Serialize};

use super::{Client, QueryOptions};
use crate::error::{Error, Result};

/// At or below this many distinct values, the values are counted as themselves.
/// Above it there are more bars than a reader can tell apart anyway.
const TALLY_MAX: u64 = 32;

/// Buckets a binned column is cut into. Sixteen is enough to show a second peak
/// and few enough that each bar is still wide enough to see.
const BINS: u64 = 16;

/// Values listed for a column that is neither binnable nor small enough to
/// tally. The rest are counted into one remainder rather than dropped.
const TOP: u64 = 12;

/// How the counts were produced, which the reader above needs in order to know
/// what a bucket *is*.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// One bucket per distinct value, all of them.
    Tally,
    /// Equal-width bins across the column's range, empties included.
    Bins,
    /// The most common values, with everything else counted into `tail_rows`.
    Top,
}

#[derive(Debug, Clone, Serialize)]
pub struct Bucket {
    /// What to print under the bar. For `bins` this is the lower edge, because a
    /// bin is named by where it starts.
    pub label: String,
    pub rows: u64,
    /// The edges, for a binned column only — so the reader can say how wide a
    /// bar is rather than leaving the axis to be guessed.
    pub from: Option<f64>,
    pub to: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Distribution {
    pub available: bool,
    pub reason: Option<String>,
    pub column: String,
    pub r#type: String,
    pub mode: Mode,
    /// Rows the count was taken over, NULLs excluded — a NULL is not a value and
    /// has no place on an axis of values. How many there were is said separately.
    pub rows: u64,
    pub nulls: u64,
    pub distinct: u64,
    pub buckets: Vec<Bucket>,
    /// For `top`: the rows and the values that are not in `buckets`.
    pub tail_rows: u64,
    pub tail_values: u64,
}

pub async fn distribution(
    ch: &Client,
    database: &str,
    table: &str,
    column: &str,
) -> Result<Distribution> {
    #[derive(Deserialize)]
    struct Col {
        r#type: String,
    }
    let cols: Vec<Col> = ch
        .rows_with(
            "SELECT type AS type FROM system.columns \
             WHERE database = {db:String} AND table = {tbl:String} AND name = {col:String}",
            params(database, table, column),
        )
        .await?;
    let Some(Col { r#type }) = cols.into_iter().next() else {
        return Err(Error::BadRequest(format!(
            "`{column}` is not a column of `{database}`.`{table}`"
        )));
    };

    let q = quote(column);
    let from = format!("{}.{}", quote(database), quote(table));

    #[derive(Deserialize)]
    struct Facts {
        n: u64,
        nulls: u64,
        u: u64,
        lo: Option<f64>,
        hi: Option<f64>,
    }
    /* One pass for everything the choice of mode depends on. `min`/`max` are cast
    through Float64 only where the type allows it — asking a String for its range
    answers with a kilobyte of the first value, which is the trap `profile.rs`
    documents. */
    let range = if numeric(&r#type) || temporal(&r#type) {
        format!(
            "toFloat64OrNull(toString(min({q}))) AS lo, toFloat64OrNull(toString(max({q}))) AS hi"
        )
    } else {
        "NULL AS lo, NULL AS hi".to_string()
    };
    let facts: Vec<Facts> = match ch
        .rows_with(
            &format!(
                "SELECT toUInt64(count()) AS n, toUInt64(countIf({q} IS NULL)) AS nulls, \
                 toUInt64(uniqExact({q})) AS u, {range} FROM {from}"
            ),
            params(database, table, column),
        )
        .await
    {
        Ok(f) => f,
        Err(e) if refused(&e) => return Ok(empty(column, &r#type, Some(said(&e)))),
        Err(e) => return Err(e),
    };
    let Some(f) = facts.into_iter().next() else {
        return Ok(empty(column, &r#type, None));
    };
    if f.n == f.nulls {
        // Every row is NULL: there is no distribution, and drawing an empty axis
        // would suggest the question was answered.
        return Ok(Distribution {
            available: true,
            rows: 0,
            nulls: f.nulls,
            distinct: 0,
            ..empty(column, &r#type, None)
        });
    }

    let live = f.n - f.nulls;

    /* Small enough to be itself, or continuous enough to be binned, or neither.
    The order matters: a numeric column of six values is a tally, because six
    values across a range of twelve produce empty bins by construction and the
    chart would be reporting the binning rather than the data. */
    if f.u <= TALLY_MAX {
        let rows: Vec<serde_json::Value> = read(
            ch,
            &format!(
                "SELECT toString({q}) AS label, toUInt64(count()) AS n FROM {from} \
                 WHERE {q} IS NOT NULL GROUP BY {q} ORDER BY n DESC, label"
            ),
            database,
            table,
            column,
        )
        .await?;
        return Ok(Distribution {
            available: true,
            reason: None,
            column: column.to_string(),
            r#type,
            mode: Mode::Tally,
            rows: live,
            nulls: f.nulls,
            distinct: f.u,
            buckets: rows
                .iter()
                .map(|r| Bucket {
                    label: text(r, "label").unwrap_or_default(),
                    rows: num(r, "n"),
                    from: None,
                    to: None,
                })
                .collect(),
            tail_rows: 0,
            tail_values: 0,
        });
    }

    if let (true, Some(lo), Some(hi)) = (numeric(&r#type) || temporal(&r#type), f.lo, f.hi) {
        if hi > lo {
            let width = (hi - lo) / BINS as f64;
            let integral = whole(&r#type);
            /* `WITH FILL` for the same reason the drift reader needs it: a bin
            with no rows is omitted by `GROUP BY`, and a chart drawn from what
            came back closes the gap silently. The clamp on the last bin is
            because the maximum value lands one past the end by arithmetic. */
            let rows: Vec<serde_json::Value> = read(
                ch,
                &format!(
                    "SELECT bin, n FROM ( \
                       SELECT least({}, toUInt32(floor((toFloat64OrNull(toString({q})) - {lo}) / {width}))) AS bin, \
                              toUInt64(count()) AS n \
                       FROM {from} WHERE {q} IS NOT NULL GROUP BY bin \
                     ) ORDER BY bin WITH FILL FROM 0 TO {} STEP 1",
                    BINS - 1,
                    BINS
                ),
                database,
                table,
                column,
            )
            .await?;
            return Ok(Distribution {
                available: true,
                reason: None,
                column: column.to_string(),
                r#type,
                mode: Mode::Bins,
                rows: live,
                nulls: f.nulls,
                distinct: f.u,
                buckets: rows
                    .iter()
                    .map(|r| {
                        let i = num(r, "bin") as f64;
                        Bucket {
                            label: trim(lo + i * width, integral),
                            rows: num(r, "n"),
                            from: Some(lo + i * width),
                            to: Some(lo + (i + 1.0) * width),
                        }
                    })
                    .collect(),
                tail_rows: 0,
                tail_values: 0,
            });
        }
    }

    // Neither small nor continuous: the common values, and an honest remainder.
    let rows: Vec<serde_json::Value> = read(
        ch,
        &format!(
            "SELECT toString({q}) AS label, toUInt64(count()) AS n FROM {from} \
             WHERE {q} IS NOT NULL GROUP BY {q} ORDER BY n DESC, label LIMIT {TOP}"
        ),
        database,
        table,
        column,
    )
    .await?;
    let buckets: Vec<Bucket> = rows
        .iter()
        .map(|r| Bucket {
            label: text(r, "label").unwrap_or_default(),
            rows: num(r, "n"),
            from: None,
            to: None,
        })
        .collect();
    let listed: u64 = buckets.iter().map(|b| b.rows).sum();
    Ok(Distribution {
        available: true,
        reason: None,
        column: column.to_string(),
        r#type,
        mode: Mode::Top,
        rows: live,
        nulls: f.nulls,
        distinct: f.u,
        tail_rows: live.saturating_sub(listed),
        tail_values: f.u.saturating_sub(buckets.len() as u64),
        buckets,
    })
}

async fn read(
    ch: &Client,
    sql: &str,
    database: &str,
    table: &str,
    column: &str,
) -> Result<Vec<serde_json::Value>> {
    ch.rows_with(sql, params(database, table, column)).await
}

fn params(database: &str, table: &str, column: &str) -> QueryOptions {
    QueryOptions {
        params: vec![
            ("db".into(), database.to_string()),
            ("tbl".into(), table.to_string()),
            ("col".into(), column.to_string()),
        ],
        ..QueryOptions::internal()
    }
}

/// A bin's lower edge, as short as it can be without lying.
///
/// `208.08278830699174` is arithmetic, not a label. And an *integer* column has
/// no fractional edges to report at all: a `UInt32` holding 100 to 939 binned
/// into sixteen produced an edge of `886.56`, which is a number the column
/// cannot contain and a reader would have to unlearn.
fn trim(v: f64, whole: bool) -> String {
    if whole || (v == v.trunc() && v.abs() < 1e15) {
        format!("{}", v.round() as i64)
    } else {
        let s = format!("{v:.2}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// Whether the column's own type has no fractions in it.
fn whole(declared: &str) -> bool {
    let t = strip(declared);
    t.starts_with("UInt") || t.starts_with("Int") || t.starts_with("Date")
}

fn strip(declared: &str) -> &str {
    declared
        .trim_start_matches("LowCardinality(")
        .trim_start_matches("Nullable(")
}

fn numeric(declared: &str) -> bool {
    let t = strip(declared);
    t.starts_with("UInt")
        || t.starts_with("Int")
        || t.starts_with("Float")
        || t.starts_with("Decimal")
}

fn temporal(declared: &str) -> bool {
    strip(declared).starts_with("Date")
}

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

fn text(row: &serde_json::Value, key: &str) -> Option<String> {
    row.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn refused(e: &Error) -> bool {
    matches!(
        e,
        Error::ClickHouse { code: 497, .. }   // ACCESS_DENIED
            | Error::ClickHouse { code: 241, .. } // MEMORY_LIMIT_EXCEEDED
            | Error::ClickHouse { code: 159, .. } // TIMEOUT_EXCEEDED
    )
}

fn said(e: &Error) -> String {
    match e {
        Error::ClickHouse { code: 241, .. } => {
            "counting this column's values ran past the server's memory limit".to_string()
        }
        Error::ClickHouse { code: 159, .. } => "the scan ran past the query timeout".to_string(),
        other => other.to_string().lines().next().unwrap_or("").to_string(),
    }
}

fn empty(column: &str, declared: &str, reason: Option<String>) -> Distribution {
    Distribution {
        available: reason.is_none(),
        reason,
        column: column.to_string(),
        r#type: declared.to_string(),
        mode: Mode::Tally,
        rows: 0,
        nulls: 0,
        distinct: 0,
        buckets: Vec::new(),
        tail_rows: 0,
        tail_values: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_type_is_read_through_its_wrappers() {
        assert!(numeric("Nullable(UInt32)"));
        assert!(numeric("LowCardinality(Int8)"));
        assert!(!numeric("LowCardinality(String)"));
        assert!(temporal("Nullable(DateTime64(3))"));
        assert!(!temporal("String"));
    }

    #[test]
    fn a_bin_edge_is_a_label_rather_than_arithmetic() {
        // `208.08278830699174` is what the division produces and nothing anyone
        // wants under a bar.
        assert_eq!(trim(208.082_788_306_991_74, false), "208.08");
        assert_eq!(trim(12.0, false), "12");
        assert_eq!(trim(-3.5, false), "-3.5");
        assert_eq!(trim(1.10, false), "1.1");
        // An integer column has no fractional edges to report at all.
        assert_eq!(trim(886.56, true), "887");
        assert!(whole("UInt32") && whole("Nullable(Date)") && !whole("Float64"));
    }

    #[test]
    fn an_identifier_survives_a_backtick() {
        assert_eq!(quote("a`b"), "`a``b`");
    }
}
