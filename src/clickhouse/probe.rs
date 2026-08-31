//! Weighing a type change instead of predicting it.
//!
//! The schema review says what a column costs today and what it might be
//! instead. It deliberately never says how much a change would save, because
//! nothing in a column's statistics can tell you: compression is about the
//! bytes, and the bytes depend on the values, the codec, the sort order and how
//! the parts happen to have been written. Guessing "about 70% smaller" is how a
//! tool loses the reader's trust the first time it is wrong.
//!
//! So this measures. One scratch table with two columns — the type the column
//! has and the type it is proposed to have — filled from the same rows in one
//! pass, then read back from `system.parts_columns`. The comparison is exact
//! because it is the same rows, the same part, the same settings, differing in
//! one thing.
//!
//! Three details make it work, and each one was measured rather than assumed:
//!
//! `min_bytes_for_wide_part = 0` on the scratch table. Without it a small part
//! is written **Compact** — every column in one file — and per-column byte
//! accounting does not exist at all. This is why a small table reports zero
//! bytes for every column in `system.parts_columns`.
//!
//! `accurateCast` rather than `CAST`. `CAST(toInt32(300) AS UInt8)` is `44` on
//! ClickHouse 26.7 — it wraps, silently. `accurateCast` refuses, and so the
//! probe doubles as a safety check: a conversion that would lose data fails
//! here, over real rows, with the server's own message, before anybody runs an
//! `ALTER` over a billion of them.
//!
//! And the target type comes from a **closed grammar**, not from the request.
//! This endpoint builds DDL; the only defence that holds is that nothing which
//! is not one of the handful of types the review can propose is ever allowed
//! through.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::profile::quote_ident;
use super::{Client, QueryOptions};
use crate::error::{Error, Result};

/// Rows weighed by default. Enough for compression to behave like compression —
/// a few hundred rows tell you nothing, because the dictionary and the marks
/// dominate — and small enough to be a moment's work.
pub const DEFAULT_ROWS: u64 = 200_000;

/// However many are asked for, no more. The probe writes, and a write nobody
/// bounded is a way to fill a disk by accident.
const MAX_ROWS: u64 = 5_000_000;

#[derive(Debug, Deserialize)]
pub struct Request {
    pub column: String,
    /// The proposed type, which must be one the review could have proposed.
    pub to_type: String,
    #[serde(default)]
    pub rows: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Outcome {
    pub column: String,
    pub from_type: String,
    pub to_type: String,
    /// Rows actually written into the scratch table.
    pub rows: u64,
    pub before_compressed: u64,
    pub after_compressed: u64,
    pub before_raw: u64,
    pub after_raw: u64,
    /// Bytes the engine actually moved to do the same work over each column —
    /// one grouping of the whole thing, which is the operation where a type
    /// shows and which nothing can shortcut.
    ///
    /// Bytes rather than milliseconds, and deliberately. A timing over a table
    /// that was written a second ago measures the page cache; the bytes are the
    /// same whether the read was warm or cold, which is what makes them worth
    /// printing. How much *faster* a query gets from moving less is a question
    /// about the query, the disk and the cache — not one this can answer.
    pub before_scanned: u64,
    pub after_scanned: u64,
    /// What the column occupies in the real table today, when its parts are
    /// Wide. `None` leaves the UI with a ratio and no projection, which is the
    /// honest state of knowledge rather than a zero.
    pub column_compressed: Option<u64>,
    pub total_rows: u64,
    /// The server's own words, when the conversion refused. A refusal is a
    /// stronger finding than any saving: it means the `ALTER` would fail, or
    /// worse, would not.
    pub refused: Option<String>,
}

/// Types this probe will build DDL for: exactly the ones the review's rules can
/// propose, and nothing else.
///
/// A closed grammar rather than an escape: the request reaches a `CREATE TABLE`
/// and a string literal inside `accurateCast`, and no amount of quoting makes
/// arbitrary text safe there. Anything unrecognised is refused with the list.
pub fn allowed_type(candidate: &str) -> bool {
    let t = candidate.trim();
    if t.len() > 64 {
        return false;
    }
    // Wrappers, one level of recursion each. `Nullable(LowCardinality(…))` is
    // not something ClickHouse accepts, so only the useful nesting is allowed.
    if let Some(inner) = t
        .strip_prefix("Nullable(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        return allowed_scalar(inner);
    }
    if let Some(inner) = t
        .strip_prefix("LowCardinality(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        return match inner
            .strip_prefix("Nullable(")
            .and_then(|rest| rest.strip_suffix(')'))
        {
            Some(core) => allowed_scalar(core),
            None => allowed_scalar(inner),
        };
    }
    allowed_scalar(t)
}

fn allowed_scalar(t: &str) -> bool {
    const NAMES: &[&str] = &[
        "String", "UUID", "Date", "Date32", "DateTime", "Bool", "Int8", "Int16", "Int32", "Int64",
        "Int128", "Int256", "UInt8", "UInt16", "UInt32", "UInt64", "UInt128", "UInt256", "Float32",
        "Float64", "IPv4", "IPv6",
    ];
    if NAMES.contains(&t) {
        return true;
    }
    // `FixedString(n)`, for a column whose values are all one length.
    if let Some(n) = t
        .strip_prefix("FixedString(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        return n
            .parse::<u32>()
            .is_ok_and(|width| (1..=1024).contains(&width));
    }
    false
}

/// The codecs worth weighing for a column of this family.
///
/// Chosen by the server, never by the request: a codec expression reaches a
/// `CREATE TABLE`, and a closed list is the only defence that holds. Which one
/// wins is not decided here — it is measured, because on this very server
/// `Gorilla` made a `Float32` column 29% *bigger* than the default while
/// `DoubleDelta` made a `DateTime` three times smaller. A codec is lossless, so
/// unlike a type change there is nothing at stake but bytes; the only mistake
/// available is to guess.
pub fn codecs_for(ch_type: &str) -> Vec<&'static str> {
    let bare = ch_type
        .replace("Nullable(", "")
        .replace("LowCardinality(", "")
        .replace(')', "");
    let t = bare.trim();
    if t.starts_with("Date") || t.starts_with("Time") {
        // Timestamps arrive in near-order, which is exactly what the delta
        // codecs are for.
        vec!["DoubleDelta, ZSTD", "Delta, ZSTD", "ZSTD"]
    } else if t.starts_with("Float") || t.starts_with("BFloat") {
        vec!["ZSTD", "Gorilla, ZSTD"]
    } else if t.starts_with("Int") || t.starts_with("UInt") || t.starts_with("Decimal") {
        vec!["T64, ZSTD", "ZSTD", "Delta, ZSTD"]
    } else if t.starts_with("String") || t.starts_with("FixedString") || t == "UUID" {
        vec!["ZSTD", "ZSTD(3)"]
    } else {
        // Arrays, maps, tuples: a codec applies to the whole column and the
        // useful ones here are the general-purpose ones.
        vec!["ZSTD"]
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CodecReading {
    pub codec: String,
    pub compressed: u64,
    pub raw: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodecOutcome {
    pub column: String,
    pub r#type: String,
    /// The codec the column has today, empty when it takes the table's default.
    pub current: String,
    pub rows: u64,
    /// The column as it is written today, for comparison.
    pub baseline: u64,
    pub baseline_raw: u64,
    pub candidates: Vec<CodecReading>,
    /// What the column occupies in the real table, when its parts are Wide.
    pub column_compressed: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TypeRow {
    r#type: String,
}

#[derive(Debug, Deserialize)]
struct BytesRow {
    column: String,
    compressed: u64,
    uncompressed: u64,
    rows: u64,
}

/// Writes go to Flint's own database and carry `allow_write`, on the reasoning
/// the workspace module already sets out: `FLINT_READONLY` is a promise about
/// *your* tables, and this never touches them. The scratch table is created,
/// filled from a SELECT, measured and dropped.
fn write_opts() -> QueryOptions {
    QueryOptions {
        allow_write: true,
        quote_64bit_integers: false,
        introspection: true,
        ..Default::default()
    }
}

fn read_opts(params: Vec<(String, String)>) -> QueryOptions {
    QueryOptions {
        params,
        quote_64bit_integers: false,
        introspection: true,
        ..Default::default()
    }
}

/// Weigh one column against one proposed type.
pub async fn probe(
    ch: &Client,
    workspace: &str,
    database: &str,
    table: &str,
    request: &Request,
) -> Result<Outcome> {
    if !allowed_type(&request.to_type) {
        return Err(Error::BadRequest(format!(
            "`{}` is not a type this probe measures. It weighs the changes the review proposes: \
             String, UUID, Date, DateTime, the Int and UInt family, Float32/64, FixedString(n), \
             and those wrapped in Nullable or LowCardinality.",
            request.to_type
        )));
    }

    // The column's real type, from the server rather than from the caller — and
    // filtered by database and table, which is also what keeps this query off
    // the whole of `system.columns`.
    let types: Vec<TypeRow> = ch
        .rows_with(
            "SELECT type FROM system.columns \
             WHERE database = {db:String} AND table = {t:String} AND name = {c:String}",
            read_opts(vec![
                ("db".into(), database.to_string()),
                ("t".into(), table.to_string()),
                ("c".into(), request.column.clone()),
            ]),
        )
        .await?;
    let from_type = types.first().map(|row| row.r#type.clone()).ok_or_else(|| {
        Error::BadRequest(format!(
            "{database}.{table} has no column called `{}`",
            request.column
        ))
    })?;

    let rows = request.rows.unwrap_or(DEFAULT_ROWS).clamp(1, MAX_ROWS);
    let source = format!("{}.{}", quote_ident(database), quote_ident(table));
    let column = quote_ident(&request.column);
    // A name nobody else is using, so two probes at once cannot collide.
    let scratch = format!(
        "{}.probe_{}",
        quote_ident(workspace),
        Uuid::new_v4().simple()
    );

    let total_rows = column_bytes(ch, database, table, &request.column)
        .await
        .map(|(_, _, n)| n)
        .unwrap_or(0);
    let column_compressed = column_bytes(ch, database, table, &request.column)
        .await
        .map(|(compressed, _, _)| compressed)
        .filter(|bytes| *bytes > 0);

    // Everything from here is torn down, whatever happens.
    let measured = weigh(
        ch,
        &scratch,
        &source,
        &column,
        &from_type,
        &request.to_type,
        rows,
    )
    .await;
    if let Err(e) = ch
        .execute(&format!("DROP TABLE IF EXISTS {scratch}"), write_opts())
        .await
    {
        // Not fatal, but somebody has to know: a scratch table left behind is
        // Flint's mess in the reader's database.
        tracing::warn!("could not drop the probe table {scratch}: {e}");
    }

    let base = Outcome {
        column: request.column.clone(),
        from_type: from_type.clone(),
        to_type: request.to_type.clone(),
        rows: 0,
        before_compressed: 0,
        after_compressed: 0,
        before_raw: 0,
        after_raw: 0,
        before_scanned: 0,
        after_scanned: 0,
        column_compressed,
        total_rows,
        refused: None,
    };

    match measured {
        Ok(sizes) => Ok(Outcome {
            rows: sizes.rows,
            before_compressed: sizes.before_compressed,
            after_compressed: sizes.after_compressed,
            before_raw: sizes.before_raw,
            after_raw: sizes.after_raw,
            before_scanned: sizes.before_scanned,
            after_scanned: sizes.after_scanned,
            ..base
        }),
        // A conversion the server refuses is the answer, not an error page: it
        // is the most useful thing this endpoint can discover.
        Err(Error::ClickHouse { message, .. }) => Ok(Outcome {
            refused: Some(message.lines().next().unwrap_or_default().to_string()),
            ..base
        }),
        Err(e) => Err(e),
    }
}

/// Weigh every codec worth trying on one column, in one pass.
///
/// One scratch table, one column per candidate plus the column as it stands,
/// filled from the same rows — so the comparison is exact for the same reason
/// the type probe's is: same values, same part, same settings, one difference.
pub async fn weigh_codecs(
    ch: &Client,
    workspace: &str,
    database: &str,
    table: &str,
    column_name: &str,
    rows: Option<u64>,
) -> Result<CodecOutcome> {
    let types: Vec<TypeAndCodec> = ch
        .rows_with(
            "SELECT type, compression_codec AS codec FROM system.columns \
             WHERE database = {db:String} AND table = {t:String} AND name = {c:String}",
            read_opts(vec![
                ("db".into(), database.to_string()),
                ("t".into(), table.to_string()),
                ("c".into(), column_name.to_string()),
            ]),
        )
        .await?;
    let found = types.first().ok_or_else(|| {
        Error::BadRequest(format!(
            "{database}.{table} has no column called `{column_name}`"
        ))
    })?;
    let ch_type = found.r#type.clone();
    let candidates = codecs_for(&ch_type);

    let rows = rows.unwrap_or(DEFAULT_ROWS).clamp(1, MAX_ROWS);
    let source = format!("{}.{}", quote_ident(database), quote_ident(table));
    let column = quote_ident(column_name);
    let scratch = format!(
        "{}.codecs_{}",
        quote_ident(workspace),
        Uuid::new_v4().simple()
    );

    let columns = std::iter::once(format!("`before` {ch_type}"))
        .chain(
            candidates
                .iter()
                .enumerate()
                .map(|(i, codec)| format!("`c{i}` {ch_type} CODEC({codec})")),
        )
        .collect::<Vec<_>>()
        .join(", ");
    let selects = std::iter::repeat_n(column.as_str(), candidates.len() + 1)
        .collect::<Vec<_>>()
        .join(", ");

    let measured = async {
        ch.execute(
            &format!(
                "CREATE TABLE {scratch} ({columns}) ENGINE = MergeTree ORDER BY tuple() \
                 SETTINGS min_bytes_for_wide_part = 0"
            ),
            write_opts(),
        )
        .await?;
        ch.execute(
            &format!("INSERT INTO {scratch} SELECT {selects} FROM {source} LIMIT {rows}"),
            write_opts(),
        )
        .await?;
        let (db, name) = scratch.split_once('.').unwrap_or(("", scratch.as_str()));
        let rows: Vec<BytesRow> = ch
            .rows_with(
                "SELECT column, \
                        sum(column_data_compressed_bytes)   AS compressed, \
                        sum(column_data_uncompressed_bytes) AS uncompressed, \
                        max(rows)                           AS rows \
                 FROM system.parts_columns \
                 WHERE database = {db:String} AND table = {t:String} AND active \
                 GROUP BY column",
                read_opts(vec![
                    ("db".into(), db.trim_matches('`').to_string()),
                    ("t".into(), name.trim_matches('`').to_string()),
                ]),
            )
            .await?;
        Ok::<_, Error>(rows)
    }
    .await;

    if let Err(e) = ch
        .execute(&format!("DROP TABLE IF EXISTS {scratch}"), write_opts())
        .await
    {
        tracing::warn!("could not drop the codec probe table {scratch}: {e}");
    }
    let measured = measured?;

    let at = |want: &str| measured.iter().find(|row| row.column == want);
    let baseline = at("before");
    Ok(CodecOutcome {
        column: column_name.to_string(),
        r#type: ch_type,
        current: found.codec.clone(),
        rows: baseline.map(|row| row.rows).unwrap_or(0),
        baseline: baseline.map(|row| row.compressed).unwrap_or(0),
        baseline_raw: baseline.map(|row| row.uncompressed).unwrap_or(0),
        candidates: candidates
            .iter()
            .enumerate()
            .map(|(i, codec)| {
                let row = at(&format!("c{i}"));
                CodecReading {
                    codec: (*codec).to_string(),
                    compressed: row.map(|r| r.compressed).unwrap_or(0),
                    raw: row.map(|r| r.uncompressed).unwrap_or(0),
                }
            })
            .collect(),
        column_compressed: column_bytes(ch, database, table, column_name)
            .await
            .map(|(compressed, _, _)| compressed)
            .filter(|bytes| *bytes > 0),
    })
}

#[derive(Debug, Deserialize)]
struct TypeAndCodec {
    r#type: String,
    codec: String,
}

struct Sizes {
    rows: u64,
    before_compressed: u64,
    after_compressed: u64,
    before_raw: u64,
    after_raw: u64,
    before_scanned: u64,
    after_scanned: u64,
}

async fn weigh(
    ch: &Client,
    scratch: &str,
    source: &str,
    column: &str,
    from_type: &str,
    to_type: &str,
    rows: u64,
) -> Result<Sizes> {
    // Two columns, same rows, same part: the only difference between them is
    // the type, which is the only way to attribute the difference in bytes to
    // it. `ORDER BY tuple()` keeps the source order — a different sort would
    // compress differently and measure the sort, not the type.
    ch.execute(
        &format!(
            "CREATE TABLE {scratch} (`before` {from_type}, `after` {to_type}) \
             ENGINE = MergeTree ORDER BY tuple() \
             SETTINGS min_bytes_for_wide_part = 0"
        ),
        write_opts(),
    )
    .await?;

    ch.execute(
        &format!(
            "INSERT INTO {scratch} \
             SELECT {column} AS `before`, accurateCast({column}, '{to_type}') AS `after` \
             FROM {source} LIMIT {rows}"
        ),
        write_opts(),
    )
    .await?;

    let (db, name) = scratch.split_once('.').unwrap_or(("", scratch));
    let measured: Vec<BytesRow> = ch
        .rows_with(
            "SELECT column, \
                    sum(column_data_compressed_bytes)   AS compressed, \
                    sum(column_data_uncompressed_bytes) AS uncompressed, \
                    max(rows)                           AS rows \
             FROM system.parts_columns \
             WHERE database = {db:String} AND table = {t:String} AND active \
             GROUP BY column",
            read_opts(vec![
                ("db".into(), db.trim_matches('`').to_string()),
                ("t".into(), name.trim_matches('`').to_string()),
            ]),
        )
        .await?;

    let find = |want: &str| measured.iter().find(|row| row.column == want);
    let before = find("before");
    let after = find("after");
    Ok(Sizes {
        rows: before.or(after).map(|row| row.rows).unwrap_or(0),
        before_compressed: before.map(|row| row.compressed).unwrap_or(0),
        after_compressed: after.map(|row| row.compressed).unwrap_or(0),
        before_raw: before.map(|row| row.uncompressed).unwrap_or(0),
        after_raw: after.map(|row| row.uncompressed).unwrap_or(0),
        before_scanned: scanned(ch, scratch, "`before`").await,
        after_scanned: scanned(ch, scratch, "`after`").await,
    })
}

/// What one grouping of a column costs the engine, in bytes read.
///
/// The grouping is wrapped in a `count()` so a single row comes back — measured
/// to read exactly the same bytes as the bare `GROUP BY`, which is the point: it
/// is the read that is being weighed, not the result. A failure answers zero
/// rather than failing the probe; the sizes are the headline and this is the
/// second line.
async fn scanned(ch: &Client, scratch: &str, column: &str) -> u64 {
    let sql = format!("SELECT count() FROM (SELECT {column} FROM {scratch} GROUP BY {column})");
    match ch
        .table(
            &sql,
            QueryOptions {
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await
    {
        Ok(result) => result.statistics.bytes_read,
        Err(e) => {
            tracing::warn!("could not weigh a grouping of {column}: {e}");
            0
        }
    }
}

/// The column's compressed and uncompressed bytes in the real table, and the
/// table's row count. Zeroes where the parts are Compact, which the caller
/// turns into "not known".
async fn column_bytes(
    ch: &Client,
    database: &str,
    table: &str,
    column: &str,
) -> Option<(u64, u64, u64)> {
    let rows: Vec<BytesRow> = ch
        .rows_with(
            "SELECT column, \
                    sum(column_data_compressed_bytes)   AS compressed, \
                    sum(column_data_uncompressed_bytes) AS uncompressed, \
                    sum(rows)                           AS rows \
             FROM system.parts_columns \
             WHERE database = {db:String} AND table = {t:String} AND column = {c:String} AND active \
             GROUP BY column",
            read_opts(vec![
                ("db".into(), database.to_string()),
                ("t".into(), table.to_string()),
                ("c".into(), column.to_string()),
            ]),
        )
        .await
        .ok()?;
    rows.first()
        .map(|row| (row.compressed, row.uncompressed, row.rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_what_the_review_proposes() {
        for t in [
            "String",
            "UUID",
            "Date",
            "DateTime",
            "UInt8",
            "UInt16",
            "Int64",
            "Float32",
            "FixedString(2)",
            "FixedString(1024)",
            "Nullable(String)",
            "Nullable(UInt16)",
            "LowCardinality(String)",
            "LowCardinality(Nullable(String))",
        ] {
            assert!(allowed_type(t), "{t} should be allowed");
        }
    }

    #[test]
    fn refuses_everything_else() {
        for t in [
            // Nothing the rules propose, so nothing this builds DDL for.
            "Decimal(38, 4)",
            "Array(String)",
            "Map(String, UInt8)",
            "AggregateFunction(sum, UInt64)",
            "DateTime64(3)",
            "FixedString(0)",
            "FixedString(4096)",
            "FixedString(x)",
            "Nullable(Array(String))",
            "LowCardinality(Array(String))",
            // And the reason the grammar is closed rather than escaped.
            "String) ENGINE = MergeTree; DROP TABLE x; --",
            "String'",
            "String, `x` String",
            "",
        ] {
            assert!(!allowed_type(t), "{t} should be refused");
        }
    }

    #[test]
    fn nothing_allowed_can_close_a_string_literal_or_a_definition() {
        // The target lands inside `accurateCast(x, '…')` and inside a CREATE
        // TABLE column list. Neither can be escaped from without one of these.
        for t in [
            "String",
            "FixedString(12)",
            "LowCardinality(Nullable(String))",
            "Nullable(UInt64)",
        ] {
            assert!(allowed_type(t));
            assert!(!t.contains('\''));
            assert!(!t.contains('`'));
            assert!(!t.contains(';'));
            assert!(
                !t.contains(' ') || t.starts_with("Nullable") || t.starts_with("LowCardinality")
            );
        }
    }

    #[test]
    fn offers_the_codecs_that_suit_the_family_and_no_others() {
        assert_eq!(
            codecs_for("DateTime"),
            vec!["DoubleDelta, ZSTD", "Delta, ZSTD", "ZSTD"]
        );
        assert_eq!(
            codecs_for("Nullable(DateTime64(3))")[0],
            "DoubleDelta, ZSTD"
        );
        assert_eq!(codecs_for("UInt64")[0], "T64, ZSTD");
        // Gorilla is offered for a float and never for an integer — and it is
        // offered, not recommended: on this project's own data it made a
        // Float32 column bigger than the default.
        assert!(codecs_for("Float32").contains(&"Gorilla, ZSTD"));
        assert!(!codecs_for("UInt64").contains(&"Gorilla, ZSTD"));
        assert!(!codecs_for("String").contains(&"Delta, ZSTD"));
    }

    #[test]
    fn every_offered_codec_is_a_literal_this_file_wrote() {
        // The list reaches a CREATE TABLE, so nothing in it may come from a
        // request. These are the only shapes that exist.
        for t in ["DateTime", "UInt64", "Float64", "String", "Array(String)"] {
            for codec in codecs_for(t) {
                assert!(codec.chars().all(|c| c.is_ascii_alphanumeric()
                    || c == ','
                    || c == ' '
                    || c == '('
                    || c == ')'));
            }
        }
    }

    #[test]
    fn tolerates_the_whitespace_a_client_might_send() {
        assert!(allowed_type("  String  "));
        assert!(!allowed_type("Str ing"));
    }
}
