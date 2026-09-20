//! What a skip index would have done, measured rather than modelled.
//!
//! The backlog calls this EXPLAIN WHATIF and ClickHouse has no such statement.
//! There are two ways to answer anyway, and the difference between them is the
//! whole of this module: *model* the plan Flint thinks the server would choose
//! and report the arithmetic, or *build the thing* on a copy of the rows and
//! ask the server. Flint has chosen the second twice already — `probe.rs` for a
//! type change, the projection advisor for a key — and both times that choice
//! is what made the answer worth trusting. The projection advisor records why:
//! a plausible model of what a read would cost was wrong by 164×, because reads
//! bottom out at `parts × index_granularity` and the model did not know it.
//!
//! So: one scratch table in Flint's own database, the rows of one partition,
//! the index declared and materialized on it, and `EXPLAIN PLAN indexes = 1`
//! run twice — once before, once after. The difference is a fact about those
//! rows.
//!
//! Three things were measured on a real server before any of this was written,
//! and each settled a decision that could have gone the other way.
//!
//! ## A bound parameter reaches the planner
//!
//! The rule this codebase will not break is that Flint never formats a value
//! into SQL, and a plan is only worth reading if the *value* took part in it —
//! an index condition is evaluated against the literal. Both were true at once:
//! `EXPLAIN PLAN indexes = 1 … WHERE source_id = {v:String}` produced
//! `Condition: (source_id in ['s-1042', 's-1042'])` and pruned 1 part of 4,
//! identical to the same statement with the value written in. So the filter is
//! bound like every other filter in the product.
//!
//! ## The sample has to be contiguous, and a random one would be worse than
//! none
//!
//! A skip index prunes because values cluster inside granules. A random sample
//! preserves the joint distribution and destroys the *density*: each granule of
//! the copy then spans a much wider slice of the table's key space, so its
//! minmax range is wider and its `set` holds more distinct values than the real
//! one ever would. That does not add noise — it under-reports, every time, in
//! the same direction. A contiguous region measures real granules at real
//! density, which is why the sample is *one partition* and why the answer says
//! which.
//!
//! ## The copy's own granule count is not the table's
//!
//! Inserting a partition's rows makes a handful of parts where the real table
//! may have many, so the absolute granule figures belong to the copy. The
//! *share* does not: before and after are measured on the same copy, one thing
//! different between them, which is exactly the arrangement `probe.rs` uses to
//! attribute a difference in bytes to a type. The reading says both, and says
//! which is which.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::profile::quote_ident;
use super::{Client, ColumnMeta, QueryOptions};
use crate::error::{Error, Result};
use crate::published::shape::{Filter, Op};

/// The most rows a measurement will copy. A what-if writes, and a write nobody
/// bounded is a way to fill somebody's disk while answering a question about
/// it. Twenty million is roughly a minute of copying on the servers this was
/// built against, and far more than an index needs to show what it does.
const MAX_ROWS: u64 = 20_000_000;

/// Which skip index to try.
///
/// A closed grammar, for the reason `probe.rs` states about types: this builds
/// DDL, and the only defence that holds is that nothing which is not one of the
/// handful of shapes Flint can propose ever reaches a statement. The parameters
/// are numbers Flint renders, never text the caller wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// The least it can be: two values a granule, and the whole of what a range
    /// filter on a sorted-ish column needs.
    MinMax,
    /// Every distinct value in the granule, up to a cap. For a column with few
    /// values, which is where it beats a bloom filter outright.
    Set,
    /// A probabilistic membership test, for equality on a column with too many
    /// values for a set.
    Bloom,
    /// The same, over the tokens of a text column, for `LIKE '%word%'`.
    TokenBloom,
}

impl Kind {
    fn parse(word: &str) -> Option<Kind> {
        match word {
            "minmax" => Some(Kind::MinMax),
            "set" => Some(Kind::Set),
            "bloom_filter" => Some(Kind::Bloom),
            "tokenbf_v1" => Some(Kind::TokenBloom),
            _ => None,
        }
    }

    /// The type expression, rendered by Flint from a number Flint clamped.
    fn expression(self, argument: Option<u64>) -> String {
        match self {
            Kind::MinMax => "minmax".to_string(),
            // The cap is *per granule*: past it the index stores nothing for
            // that granule and silently stops pruning it, which is the way a
            // set index disappoints.
            Kind::Set => format!("set({})", argument.unwrap_or(100).clamp(1, 10_000)),
            // Asked for in permille and rendered as the rate ClickHouse wants,
            // because a caller sending `0.025` is a caller sending a float
            // through a JSON parser into DDL.
            Kind::Bloom => {
                let permille = argument.unwrap_or(25).clamp(1, 500);
                format!("bloom_filter({})", permille as f64 / 1000.0)
            }
            // Fixed parameters. They are a filter size, a hash count and a
            // seed, and a caller who wants to tune them is past what a
            // measurement offered from a form can honestly help with.
            Kind::TokenBloom => "tokenbf_v1(32768, 3, 0)".to_string(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct Request {
    /// The column to index.
    pub column: String,
    /// `minmax`, `set`, `bloom_filter` or `tokenbf_v1`.
    pub kind: String,
    #[serde(default)]
    pub argument: Option<u64>,
    #[serde(default)]
    pub granularity: Option<u64>,
    /// The filter to plan. One column, one operator, and what it compares to —
    /// the same grammar the published face and the dataset API use, so the
    /// refusals are the same sentences.
    pub filter_column: String,
    pub filter_op: String,
    #[serde(default)]
    pub filter_values: Vec<String>,
    /// Which partition to copy. Absent means the largest that fits.
    #[serde(default)]
    pub partition: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Outcome {
    /// The partition the copy was made from, and what it holds.
    pub partition: String,
    pub sampled_rows: u64,
    pub sampled_parts: u64,
    /// The whole table, so the reader can see what share was measured.
    pub table_rows: u64,
    pub table_parts: u64,
    /// True where the partition was bigger than the cap and the copy was cut,
    /// which changes what the figures are of.
    pub clipped: bool,
    /// `EXPLAIN PLAN indexes = 1`, before and after, verbatim. Read by
    /// `lib/plan`, which already knows how to say what a plan means — a second
    /// parser here would be a second set of sentences to keep in step.
    pub before_plan: String,
    pub after_plan: String,
    /// What the index occupies on the copy.
    pub index_bytes: u64,
    /// The statement that would add it to the real table, for the hand-over to
    /// Infrastructure. Flint does not run it: this is Data measuring, and no
    /// Data control writes structure.
    pub statement: String,
    /// The same alteration as the four fields Infrastructure's own form takes,
    /// so the hand-over fills it in rather than pasting a statement somebody
    /// then has to trust. `add-index` has been there since B4; this is its
    /// first caller from the Data side.
    pub name: String,
    pub expression: String,
    pub kind: String,
    pub granularity: u64,
    /// The server's own words, where it refused. A refusal is an answer: an
    /// index ClickHouse will not build on this column is worth more to know
    /// than any saving.
    pub refused: Option<String>,
}

fn read_opts(params: Vec<(String, String)>) -> QueryOptions {
    QueryOptions {
        params,
        quote_64bit_integers: false,
        introspection: true,
        ..Default::default()
    }
}

fn write_opts() -> QueryOptions {
    QueryOptions {
        allow_write: true,
        introspection: true,
        ..Default::default()
    }
}

#[derive(Deserialize)]
struct PartitionRow {
    partition_id: String,
    partition: String,
    rows: u64,
    parts: u64,
}

#[derive(Deserialize)]
struct Described {
    name: String,
    r#type: String,
}

#[derive(Deserialize)]
struct Keys {
    sorting_key: String,
}

/// Build the index on a copy of one partition, and report both plans.
pub async fn measure(
    ch: &Client,
    workspace: &str,
    database: &str,
    table: &str,
    request: &Request,
) -> Result<Outcome> {
    let kind = Kind::parse(&request.kind).ok_or_else(|| {
        Error::BadRequest(format!(
            "`{}` is not an index this measures: minmax, set, bloom_filter or tokenbf_v1",
            request.kind
        ))
    })?;
    let op = Op::from_keyword(&request.filter_op).ok_or_else(|| {
        Error::BadRequest(format!(
            "`{}` is not an operator. The ones there are: {}",
            request.filter_op,
            Op::keywords().join(", ")
        ))
    })?;
    let granularity = request.granularity.unwrap_or(4).clamp(1, 1024);

    // The columns, from the server rather than from the caller — which is also
    // what makes the filter grammar's refusals true about this table.
    let columns: Vec<ColumnMeta> = ch
        .rows_with(
            "SELECT name, type FROM system.columns \
             WHERE database = {db:String} AND table = {t:String} ORDER BY position",
            read_opts(vec![
                ("db".into(), database.to_string()),
                ("t".into(), table.to_string()),
            ]),
        )
        .await
        .map(|rows: Vec<Described>| {
            rows.into_iter()
                .map(|r| ColumnMeta {
                    name: r.name,
                    r#type: r.r#type,
                })
                .collect()
        })?;
    if columns.is_empty() {
        return Err(Error::BadRequest(format!(
            "{database}.{table} has no columns Flint can read, so there is nothing to measure"
        )));
    }
    if !columns.iter().any(|c| c.name == request.column) {
        return Err(Error::BadRequest(format!(
            "{database}.{table} has no column called `{}`",
            request.column
        )));
    }

    let (predicate, params) = crate::published::shape::one_predicate(
        &columns,
        &Filter {
            column: request.filter_column.clone(),
            op,
            values: request.filter_values.clone(),
        },
        "wi_",
    )
    .map_err(Error::BadRequest)?;

    // The copy is sorted the way the real table is, because that is what
    // decides which rows share a granule — and therefore the whole of what an
    // index has to work with. A table with no sorting key copies with none.
    let keys: Option<Keys> = ch
        .row_with(
            "SELECT sorting_key FROM system.tables \
             WHERE database = {db:String} AND name = {t:String}",
            read_opts(vec![
                ("db".into(), database.to_string()),
                ("t".into(), table.to_string()),
            ]),
        )
        .await?;
    // Parenthesised, and that is not decoration: `system.tables.sorting_key`
    // comes back as `assumeNotNull(account_id), assumeNotNull(time)` — the
    // columns without the brackets around them — so `ORDER BY <that>` inside a
    // `CREATE ... AS SELECT` ends at the first comma and the server refuses
    // the statement. Found on the first real call, because the refusal is
    // reported rather than swallowed.
    let sorting_key = keys
        .map(|k| k.sorting_key)
        .filter(|k| !k.trim().is_empty())
        .map(|k| format!("({k})"))
        .unwrap_or_else(|| "tuple()".to_string());

    let partitions: Vec<PartitionRow> = ch
        .rows_with(
            "SELECT partition_id                AS partition_id, \
                    any(partition)              AS partition, \
                    toUInt64(sum(rows))         AS rows, \
                    toUInt64(count())           AS parts \
             FROM system.parts \
             WHERE database = {db:String} AND table = {t:String} AND active \
             GROUP BY partition_id \
             ORDER BY rows DESC",
            read_opts(vec![
                ("db".into(), database.to_string()),
                ("t".into(), table.to_string()),
            ]),
        )
        .await?;
    if partitions.is_empty() {
        return Err(Error::BadRequest(format!(
            "{database}.{table} holds no active parts, so there is nothing to measure an index on"
        )));
    }
    let table_rows: u64 = partitions.iter().map(|p| p.rows).sum();
    let table_parts: u64 = partitions.iter().map(|p| p.parts).sum();

    // The largest partition that fits under the cap, because a bigger sample
    // of real rows is a better measurement — and the smallest one otherwise,
    // clipped, which is honest and still useful.
    let chosen = match &request.partition {
        Some(wanted) => partitions
            .iter()
            .find(|p| &p.partition_id == wanted || &p.partition == wanted)
            .ok_or_else(|| {
                Error::BadRequest(format!("{database}.{table} has no partition `{wanted}`"))
            })?,
        None => partitions
            .iter()
            .find(|p| p.rows <= MAX_ROWS)
            .unwrap_or_else(|| partitions.last().expect("not empty")),
    };
    let clipped = chosen.rows > MAX_ROWS;

    let source = format!("{}.{}", quote_ident(database), quote_ident(table));
    let scratch = format!(
        "{}.whatif_{}",
        quote_ident(workspace),
        Uuid::new_v4().simple()
    );
    // Named the way somebody would name it if they kept it, because the
    // hand-over fills in a form that creates it on the real table — and
    // `whatif_source_id` is a name nobody wants in their schema a year from
    // now. B4's own example is `by_label`.
    let index_name = format!(
        "by_{}",
        request.column.replace(|c: char| !c.is_alphanumeric(), "_")
    );
    let index_expr = kind.expression(request.argument);

    let measured = run(
        ch,
        &scratch,
        &source,
        &sorting_key,
        &chosen.partition_id,
        clipped,
        &index_name,
        &quote_ident(&request.column),
        &index_expr,
        granularity,
        &predicate,
        &params,
    )
    .await;

    if let Err(e) = ch
        .execute(&format!("DROP TABLE IF EXISTS {scratch}"), write_opts())
        .await
    {
        // Not fatal, and somebody has to know: a scratch table left behind is
        // Flint's mess in the reader's own database.
        tracing::warn!("could not drop the what-if table {scratch}: {e}");
    }

    let statement = format!(
        "ALTER TABLE {source}\n  ADD INDEX {index_name} {} TYPE {index_expr} GRANULARITY {granularity}",
        quote_ident(&request.column)
    );
    let base = Outcome {
        name: index_name.clone(),
        expression: request.column.clone(),
        kind: index_expr.clone(),
        granularity,
        partition: chosen.partition.clone(),
        sampled_rows: 0,
        sampled_parts: 0,
        table_rows,
        table_parts,
        clipped,
        before_plan: String::new(),
        after_plan: String::new(),
        index_bytes: 0,
        statement,
        refused: None,
    };

    match measured {
        Ok(m) => Ok(Outcome {
            sampled_rows: m.rows,
            sampled_parts: m.parts,
            before_plan: m.before,
            after_plan: m.after,
            index_bytes: m.index_bytes,
            ..base
        }),
        // An index the server will not build on this column is the answer, not
        // an error page — the same rule `probe.rs` follows for a cast it
        // refuses, and for the same reason: it is the most useful thing the
        // measurement can discover.
        Err(Error::ClickHouse { message, .. }) => Ok(Outcome {
            refused: Some(message.lines().next().unwrap_or_default().to_string()),
            ..base
        }),
        Err(e) => Err(e),
    }
}

struct Measured {
    rows: u64,
    parts: u64,
    before: String,
    after: String,
    index_bytes: u64,
}

#[allow(clippy::too_many_arguments)]
async fn run(
    ch: &Client,
    scratch: &str,
    source: &str,
    sorting_key: &str,
    partition_id: &str,
    clipped: bool,
    index_name: &str,
    column: &str,
    index_expr: &str,
    granularity: u64,
    predicate: &str,
    params: &[(String, String)],
) -> Result<Measured> {
    // `_partition_id` is a virtual column, so one partition is a bound
    // parameter rather than a name spliced into the statement.
    let limit = if clipped {
        format!(" LIMIT {MAX_ROWS}")
    } else {
        String::new()
    };
    ch.execute(
        &format!(
            "CREATE TABLE {scratch} ENGINE = MergeTree ORDER BY {sorting_key} \
             AS SELECT * FROM {source} WHERE _partition_id = {{wi_partition:String}}{limit}"
        ),
        QueryOptions {
            params: vec![("wi_partition".into(), partition_id.to_string())],
            ..write_opts()
        },
    )
    .await?;

    let (db, name) = scratch.split_once('.').unwrap_or(("", scratch));
    let db = db.trim_matches('`').to_string();
    let name = name.trim_matches('`').to_string();

    #[derive(Deserialize)]
    struct Size {
        rows: u64,
        parts: u64,
    }
    let size: Option<Size> = ch
        .row_with(
            "SELECT toUInt64(sum(rows)) AS rows, toUInt64(count()) AS parts \
             FROM system.parts WHERE database = {db:String} AND table = {t:String} AND active",
            read_opts(vec![("db".into(), db.clone()), ("t".into(), name.clone())]),
        )
        .await?;

    let plan = format!("EXPLAIN PLAN indexes = 1 SELECT count() FROM {scratch} WHERE {predicate}");
    let before = explain(ch, &plan, params).await?;

    ch.execute(
        &format!(
            "ALTER TABLE {scratch} ADD INDEX {index_name} {column} \
             TYPE {index_expr} GRANULARITY {granularity}"
        ),
        write_opts(),
    )
    .await?;
    // `mutations_sync = 2` because the next statement reads the result: an
    // index asked for and not waited on is an index the plan does not see, and
    // the measurement would report that it changed nothing. B4 records the same
    // fact from the other side — declaring one does nothing to the rows already
    // there until it is materialized.
    ch.execute(
        &format!(
            "ALTER TABLE {scratch} MATERIALIZE INDEX {index_name} SETTINGS mutations_sync = 2"
        ),
        write_opts(),
    )
    .await?;

    let after = explain(ch, &plan, params).await?;

    #[derive(Deserialize)]
    struct IndexSize {
        bytes: u64,
    }
    let index_bytes: Option<IndexSize> = ch
        .row_with(
            "SELECT toUInt64(sum(data_compressed_bytes)) AS bytes \
             FROM system.data_skipping_indices \
             WHERE database = {db:String} AND table = {t:String}",
            read_opts(vec![("db".into(), db), ("t".into(), name)]),
        )
        .await?;

    Ok(Measured {
        rows: size.as_ref().map(|s| s.rows).unwrap_or(0),
        parts: size.map(|s| s.parts).unwrap_or(0),
        before,
        after,
        index_bytes: index_bytes.map(|i| i.bytes).unwrap_or(0),
    })
}

/// The plan, as the server prints it. One String column called `explain`.
async fn explain(ch: &Client, sql: &str, params: &[(String, String)]) -> Result<String> {
    #[derive(Deserialize)]
    struct Line {
        explain: String,
    }
    let rows: Vec<Line> = ch.rows_with(sql, read_opts(params.to_vec())).await?;
    Ok(rows
        .into_iter()
        .map(|l| l.explain)
        .collect::<Vec<_>>()
        .join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_index_grammar_is_closed() {
        assert!(Kind::parse("minmax").is_some());
        assert!(Kind::parse("set").is_some());
        // Not a kind, and — the point of the closed set — not a fragment of
        // DDL that reaches a statement either.
        assert!(Kind::parse("minmax GRANULARITY 1, INDEX evil x TYPE set(0)").is_none());
    }

    #[test]
    fn the_parameters_are_numbers_flint_clamps() {
        assert_eq!(Kind::Set.expression(Some(9_999_999)), "set(10000)");
        assert_eq!(Kind::Set.expression(None), "set(100)");
        // Permille in, a rate out: a caller sending 0.025 through JSON is a
        // float on its way into DDL.
        assert_eq!(Kind::Bloom.expression(Some(25)), "bloom_filter(0.025)");
        assert_eq!(Kind::Bloom.expression(Some(0)), "bloom_filter(0.001)");
        assert_eq!(Kind::MinMax.expression(Some(7)), "minmax");
    }
}
