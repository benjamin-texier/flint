//! What is actually in a table.
//!
//! The point is to answer "what does this data look like" without anyone
//! writing a query: how many nulls, how many distinct values, the range, the
//! most common values. It is one pass over the data — every statistic for every
//! column in a single SELECT — because ClickHouse is very good at exactly that,
//! and forty round trips would not be.
//!
//! Which statistics apply depends on the type. `min(payload)` on a String
//! column technically works and returns a kilobyte of JSON; a range only means
//! something for a number or a time.

use serde::Serialize;
use serde_json::Value;

use super::meta::ColumnDetail;
use super::{Client, QueryOptions};
use crate::error::{Error, Result};

/// Above this many rows the profile reads a bounded prefix instead of the whole
/// table, and says so. A full scan of a billion rows to populate a summary
/// panel is not a trade anyone asked for.
const DEFAULT_SCAN_LIMIT: u64 = 5_000_000;

/// Longest value kept from a `topK` result. Without it, profiling a column of
/// JSON blobs returns five of them.
const VALUE_CLIP: usize = 80;

#[derive(Debug, Clone, Serialize)]
pub struct ColumnProfile {
    pub name: String,
    pub r#type: String,
    pub nullable: bool,
    /// Rows where the value is NULL. Always 0 for a non-nullable column, which
    /// is not scanned for it.
    pub nulls: u64,
    /// Approximate — `uniqCombined`, which trades exactness for one pass and
    /// bounded memory.
    pub distinct: u64,
    pub min: Option<String>,
    pub max: Option<String>,
    pub mean: Option<String>,
    pub median: Option<String>,
    /// Most frequent values, most common first. Only collected where it means
    /// something: a category, not a measurement.
    pub top: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TableProfile {
    pub database: String,
    pub table: String,
    /// Rows the profile actually looked at.
    pub scanned: u64,
    /// True when that is a prefix of the table rather than all of it.
    pub sampled: bool,
    /// True when a column defeated the full statistics and the profile fell
    /// back to counts. Surfaced so the UI can say so rather than look empty.
    pub degraded: bool,
    pub columns: Vec<ColumnProfile>,
}

/// Which family a ClickHouse type belongs to, for deciding what to measure.
/// Mirrors the frontend's `chType` so both sides classify alike.
pub(super) fn family(ch_type: &str) -> &'static str {
    // `Nullable(Nothing)` is the type of a literal NULL — what a view selecting
    // `NULL AS x` produces. Nothing aggregates over it: `topK` returns
    // `Nullable(Nothing)` rather than an array, and `uniqCombined` returns
    // NULL. There is also nothing to learn, since every row is null.
    if ch_type.contains("Nothing") {
        return "empty";
    }
    let mut t = ch_type.trim();
    loop {
        let stripped = t
            .strip_prefix("Nullable(")
            .or_else(|| t.strip_prefix("LowCardinality("))
            .and_then(|rest| rest.strip_suffix(')'));
        match stripped {
            Some(inner) => t = inner,
            None => break,
        }
    }
    if t.starts_with("Date") || t.starts_with("Time") {
        "time"
    } else if t.starts_with("Int")
        || t.starts_with("UInt")
        || t.starts_with("Float")
        || t.starts_with("Decimal")
        || t.starts_with("BFloat")
    {
        "number"
    } else if t.starts_with("Bool") || t.starts_with("Enum") {
        "category"
    } else if t.starts_with("Array")
        || t.starts_with("Map")
        || t.starts_with("Tuple")
        || t.starts_with("Nested")
        || t.starts_with("JSON")
        || t.starts_with("Variant")
        || t.starts_with("Dynamic")
        || t.starts_with("AggregateFunction")
    {
        "nested"
    } else {
        "string"
    }
}

pub(super) fn quote_ident(name: &str) -> String {
    if !name.is_empty()
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        name.to_string()
    } else {
        format!("`{}`", name.replace('\\', "\\\\").replace('`', "\\`"))
    }
}

pub async fn profile(
    ch: &Client,
    database: &str,
    table: &str,
    columns: &[ColumnDetail],
    total_rows: u64,
    scan_limit: Option<u64>,
) -> Result<TableProfile> {
    if columns.is_empty() {
        return Ok(TableProfile {
            database: database.to_string(),
            table: table.to_string(),
            scanned: 0,
            sampled: false,
            degraded: false,
            columns: Vec::new(),
        });
    }

    let limit = scan_limit.unwrap_or(DEFAULT_SCAN_LIMIT);
    let sampled = total_rows > limit;

    // Aliases are positional rather than derived from the column name: a
    // column called `c0__uniq` would otherwise collide with the alias for
    // column zero, and no amount of quoting fixes that.
    let mut selects: Vec<String> = vec!["count() AS n_rows".to_string()];
    for (i, col) in columns.iter().enumerate() {
        let q = quote_ident(&col.name);
        let fam = family(&col.r#type);
        if col.nullable {
            selects.push(format!("sum(isNull({q})) AS c{i}_nulls"));
        }
        if fam == "empty" {
            // Every row is NULL; the null count above is the whole story.
            continue;
        }
        selects.push(format!("uniqCombined({q}) AS c{i}_uniq"));
        if fam == "number" || fam == "time" {
            selects.push(format!("toString(min({q})) AS c{i}_min"));
            selects.push(format!("toString(max({q})) AS c{i}_max"));
        }
        if fam == "number" {
            selects.push(format!("toString(avg({q})) AS c{i}_mean"));
            selects.push(format!("toString(quantile(0.5)({q})) AS c{i}_median"));
        }
        // Most-common values answer "what are the categories here". For a
        // measurement the range answers it instead, and for a timestamp the
        // five most frequent instants are noise. Clipped server-side: the point
        // is not to ship five kilobytes of payload to describe a column.
        if fam != "number" && fam != "time" {
            selects.push(format!(
                "arrayMap(x -> substring(toString(x), 1, {VALUE_CLIP}), topK(5)({q})) AS c{i}_top"
            ));
        }
    }

    let source = if sampled {
        // A bounded prefix. Reading the columns explicitly keeps the scan to
        // what the profile needs.
        let list = columns
            .iter()
            .map(|c| quote_ident(&c.name))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "(SELECT {list} FROM {}.{} LIMIT {limit})",
            quote_ident(database),
            quote_ident(table)
        )
    } else {
        format!("{}.{}", quote_ident(database), quote_ident(table))
    };

    // ClickHouse has a lot of types, and some of them refuse an aggregate that
    // looks perfectly reasonable. Rather than enumerate every quirk — and fail a
    // 33-column profile because one column is odd — the query degrades: the full
    // set of statistics, then the two that work on nearly anything, then none.
    // A partial profile beats an error page.
    let minimal: Vec<String> = std::iter::once("count() AS n_rows".to_string())
        .chain(
            columns
                .iter()
                .enumerate()
                .filter(|(_, col)| col.nullable)
                .map(|(i, col)| format!("sum(isNull({})) AS c{i}_nulls", quote_ident(&col.name))),
        )
        .collect();

    let mut row: Option<serde_json::Map<String, Value>> = None;
    let mut degraded = false;
    for (attempt, list) in [&selects, &minimal].iter().enumerate() {
        let sql = format!("SELECT {} FROM {source}", list.join(", "));
        match ch
            .row_with(
                &sql,
                QueryOptions {
                    quote_64bit_integers: false,
                    // Tagged as Flint's own. Untagged, the profile shows up in
                    // the schema review's usage figures as one of the biggest
                    // readers of the very table it was asked about.
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
                    "full profile of {database}.{table} failed, falling back to counts only: {e}"
                );
            }
            Err(e) => return Err(e),
        }
    }
    let row = row.ok_or_else(|| Error::Decode("the profile query returned no row".into()))?;

    let u64_at = |key: &str| row.get(key).and_then(Value::as_u64).unwrap_or(0);
    let string_at = |key: &str| {
        row.get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|s| !s.is_empty())
    };

    let profiled = columns
        .iter()
        .enumerate()
        .map(|(i, col)| ColumnProfile {
            name: col.name.clone(),
            r#type: col.r#type.clone(),
            nullable: col.nullable,
            nulls: u64_at(&format!("c{i}_nulls")),
            distinct: u64_at(&format!("c{i}_uniq")),
            min: string_at(&format!("c{i}_min")),
            max: string_at(&format!("c{i}_max")),
            mean: string_at(&format!("c{i}_mean")),
            median: string_at(&format!("c{i}_median")),
            top: row
                .get(&format!("c{i}_top"))
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
        })
        .collect();

    Ok(TableProfile {
        database: database.to_string(),
        table: table.to_string(),
        scanned: u64_at("n_rows"),
        sampled,
        degraded,
        columns: profiled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_types_through_their_wrappers() {
        assert_eq!(family("UInt64"), "number");
        assert_eq!(family("Nullable(Float32)"), "number");
        assert_eq!(family("LowCardinality(Nullable(String))"), "string");
        assert_eq!(family("DateTime64(3)"), "time");
        assert_eq!(family("Date"), "time");
        assert_eq!(family("Enum8('a' = 1)"), "category");
        assert_eq!(family("Bool"), "category");
        assert_eq!(family("Array(String)"), "nested");
        assert_eq!(family("Map(String, UInt8)"), "nested");
        assert_eq!(family("UUID"), "string");
    }

    #[test]
    fn treats_an_always_null_column_as_having_nothing_to_measure() {
        // The type a view's `SELECT NULL AS x` produces. `topK` over it returns
        // Nullable(Nothing) rather than an array, which fails the whole query.
        assert_eq!(family("Nullable(Nothing)"), "empty");
        assert_eq!(family("Nothing"), "empty");
    }

    #[test]
    fn quotes_only_what_needs_it() {
        assert_eq!(quote_ident("events"), "events");
        assert_eq!(quote_ident("_x9"), "_x9");
        assert_eq!(quote_ident("weird name"), "`weird name`");
        assert_eq!(quote_ident("9lives"), "`9lives`");
        assert_eq!(quote_ident("a`b"), "`a\\`b`");
    }
}
