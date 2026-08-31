//! What the workload asks of a table, against what the table is sorted by.
//!
//! A ClickHouse table has exactly one physical order, chosen once, and every
//! query that does not filter on a prefix of it reads the whole thing. A
//! projection is the escape: a second copy of some columns in another order, or
//! a pre-aggregated one, kept in the same parts and chosen by the server
//! without the query changing at all. The cost is disk and insert throughput,
//! and the benefit is bounded by how badly the current order fits — so the
//! question "is a projection worth it here" is a question about a *workload*,
//! not about a schema, and it cannot be answered without the query log.
//!
//! This module reads. It gathers four things and forms no opinion about any of
//! them: what the table is (order, parts, granularity, columns), what already
//! answers queries against it (`system.projections`, and which projections the
//! log says were actually *used*), what has been asked of it (the patterns in
//! `system.query_log`, with what each one really cost), and — when somebody
//! asks for it — what a *proposed* key would measure out at.
//!
//! Deciding what those numbers mean, which projection would follow and what to
//! say about it is `frontend/src/lib/projection.ts`, for the reason the schema
//! review splits the same way: the rules are the arguable part, and an argument
//! belongs in a test file rather than inside a SQL string.
//!
//! ## The arithmetic the frontend rests on, measured rather than reasoned
//!
//! Against a 5,000,000-row table in 5 parts, `ORDER BY (project_id, time)`,
//! `index_granularity = 8192`, on ClickHouse 26.7:
//!
//! | query | rows read | with a projection | on disk |
//! |---|---|---|---|
//! | `WHERE device_id = ?` | 5,000,000 | 40,960 | +22.5 MB (`SELECT *`) |
//! | the same | 5,000,000 | 40,960 | +1.7 MB (only the columns it reads) |
//! | `GROUP BY type` | 5,000,000 | 15 | +2.0 KB |
//!
//! Three things fall out of that table and every sentence the frontend writes
//! depends on them.
//!
//! **A sort-order projection bottoms out at `parts × index_granularity`.**
//! 40,960 is 5 × 8192, not the 250 rows that actually matched: ClickHouse reads
//! whole granules, and each part contributes at least one. So the floor on what
//! a proposal can achieve is arithmetic, and the frontend does that arithmetic
//! rather than promising the matching rows.
//!
//! **An aggregate projection holds `groups × parts` rows**, and `groups` is
//! measurable *before* anything is created — `uniqCombined` over the proposed
//! key. Three distinct values gave 15 rows across 5 parts. That is why
//! `measure` exists: the benefit of an aggregate projection is not estimated
//! here, it is counted.
//!
//! **The size of a pre-aggregated projection cannot be reasoned about at all.**
//! Its rows are aggregate *states*, and a `uniqCombined` digest is not a number
//! anybody reads off a schema: a seven-aggregate proposal holding 31 rows came
//! out at 2.57 MB on a 42 MB table. So `weigh` builds it — the same grouping
//! and the same states into a scratch table in Flint's own database — reads its
//! parts and drops it, the way the type probe already weighs a type change.
//!
//! **And the column list is the difference between 1.7 MB and 22.5 MB** — a
//! thirteenfold difference in what the recommendation costs, for the same
//! query answered equally fast. The price of the narrow one is that it answers
//! *only* queries whose columns it holds: adding `max(time)` to the query above
//! put it straight back to 5,000,000 rows. Both halves of that are the
//! frontend's to say, and neither is guessable without having measured it.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::diagnostics::{blocked, excluding_flint};
use super::profile::quote_ident;
use super::{Client, QueryOptions, Section};
use crate::error::{Error, Result};

/// ClickHouse's own default, and the fallback when a table does not say.
/// Only ever used as the floor on what a sort-order projection can read, so
/// being wrong about a table that overrides it costs a factor in one sentence
/// rather than a wrong recommendation.
const DEFAULT_GRANULARITY: u64 = 8192;

/// Patterns carried back at most. The log is grouped by
/// `normalized_query_hash`, so this is distinct query *shapes* and not
/// statements; past a few dozen shapes nobody reads further, and every one of
/// them is a full SQL statement on the wire.
const MAX_PATTERNS: u64 = 60;

/// Above this many distinct key values the exact pass is not attempted.
///
/// The exact pass is `GROUP BY` the proposed key, which holds one row per group
/// in memory — the same memory materialising the projection would need. Past a
/// million groups that is a real query on somebody's server to answer a
/// question whose answer is already "no": a key with a million distinct values
/// makes an aggregate projection nearly as large as the table. So the estimate
/// stands and the response says it is an estimate.
const EXACT_GROUP_CEILING: u64 = 1_000_000;

// ── What the table is ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct AdviceColumn {
    pub name: String,
    pub r#type: String,
    /// Position in the sorting key, 1-based; `None` when it is not in it. The
    /// position is the point — a column second in the key is only reachable
    /// through the first, which is exactly the case a projection answers.
    pub sorting_position: Option<u64>,
    pub in_partition_key: bool,
    /// `None` where the parts are Compact and per-column bytes do not exist.
    pub compressed_bytes: Option<u64>,
}

/// One projection this table already has, with the two facts
/// `system.projections` does not carry: what it holds, and whether the workload
/// has actually used it.
#[derive(Debug, Clone, Serialize)]
pub struct Existing {
    pub name: String,
    /// `Normal` or `Aggregate`.
    pub kind: String,
    pub query: String,
    pub sorting_key: Vec<String>,
    pub parts: u64,
    pub rows: u64,
    pub bytes: u64,
    /// Declared and holding nothing, which is what `ADD PROJECTION` leaves
    /// behind until something materialises it. Every query ignores it and
    /// nothing reports an error.
    pub inert: bool,
    /// Queries in the window that the log says used it. `None` when the log
    /// could not be read or this server's log does not record it — which is a
    /// different answer from zero and must not be shown as one.
    pub used_by: Option<u64>,
}

/// One query shape against this table, and what it really cost.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pattern {
    pub hash: String,
    pub runs: u64,
    /// One statement of this shape, literals and all. The frontend parses this
    /// to find out which columns were filtered on and which were grouped by —
    /// a question `query_log.columns` cannot answer, since it names every
    /// column the statement touched without saying how.
    pub statement: String,
    pub avg_ms: f64,
    pub p95_ms: f64,
    pub total_ms: u64,
    pub read_rows: u64,
    pub read_bytes: u64,
    pub users: u64,
    pub last_seen: String,
    /// The oldest run of this shape still in the log. With `last_seen` it says
    /// whether a pattern is a habit or a single afternoon, which is most of
    /// what decides whether it is worth a projection.
    pub first_seen: String,
    /// Every table the statement touched. More than one means the frontend
    /// will not propose anything from it: a projection belongs to one table,
    /// and a join is not a pattern this reads well enough to advise on.
    ///
    /// Read under the alias `touched`, because a column aliased `tables` in the
    /// select list shadows `system.query_log.tables` in the `WHERE` beside it
    /// and ClickHouse rejects the whole statement — `Aggregate function
    /// groupArray(20)(tables) is found in WHERE`. The wire name stays `tables`.
    #[serde(default, alias = "touched")]
    pub tables: Vec<String>,
    /// Projections the server chose for this shape, as the log recorded them.
    /// Evidence rather than inference: an existing projection that answers this
    /// pattern shows up here, and one that should have and did not is the more
    /// interesting finding.
    #[serde(default)]
    pub projections: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Advice {
    pub database: String,
    pub table: String,
    pub engine: String,
    /// Whether this engine can carry a projection at all. Nothing below is
    /// worth reading when it cannot.
    pub supported: bool,
    /// The sorting key, split into its terms in order. Empty for a table with
    /// none.
    pub sorting_key: Vec<String>,
    pub partition_key: String,
    pub total_rows: u64,
    pub table_bytes: u64,
    pub parts: u64,
    /// Declared where the table declares it, ClickHouse's default otherwise.
    /// The floor on what a sort-order projection can read is `parts` times
    /// this, so it is carried rather than assumed on the other side.
    pub index_granularity: u64,
    pub columns: Vec<AdviceColumn>,
    pub existing: Vec<Existing>,
    pub window_days: u64,
    /// The oldest entry the log actually still holds, which is the real window
    /// whatever was asked for. `None` when nothing matched.
    pub since: Option<String>,
    /// Every SELECT against this table in the window, grouped by shape — or the
    /// reason there is no such list, which is usually a grant or a log that is
    /// switched off.
    ///
    /// Capped at the costliest `MAX_PATTERNS`, which is why the two totals
    /// below exist: a list silently truncated reads as the whole truth, and
    /// "24 shapes over 82 runs" is a different sentence from "the 24 costliest
    /// of 213 shapes, over 82 of 4,100 runs".
    pub workload: Section<Pattern>,
    /// Distinct query shapes against this table in the window, before the cap.
    /// `None` where the workload could not be read at all.
    pub shapes_total: Option<u64>,
    /// Runs behind them, before the cap.
    pub runs_total: Option<u64>,
}

fn params(database: &str, table: &str) -> QueryOptions {
    QueryOptions {
        params: vec![
            ("db".into(), database.to_string()),
            ("tbl".into(), table.to_string()),
        ],
        quote_64bit_integers: false,
        introspection: true,
        ..Default::default()
    }
}

/// Engines that keep parts, and therefore can keep a projection beside them.
///
/// The list is by suffix rather than by exact name because every one of them
/// has a `Replicated` form and several have a `Shared` one on ClickHouse Cloud,
/// and a check that missed those would tell somebody their production table
/// cannot have a projection.
fn holds_projections(engine: &str) -> bool {
    engine.ends_with("MergeTree")
}

/// `index_granularity` as this table declares it.
///
/// Read out of the `CREATE` statement rather than derived from
/// `system.parts`: the derivation — rows over marks — comes out at 8,169 and
/// 7,921 on two real tables whose granularity is 8,192, because the last
/// granule of every part is short. A figure that is 3% wrong is fine for
/// arithmetic and terrible in a sentence that names it.
fn granularity_of(create_query: &str) -> u64 {
    let Some(at) = create_query.find("index_granularity") else {
        return DEFAULT_GRANULARITY;
    };
    let tail = &create_query[at + "index_granularity".len()..];
    let digits: String = tail
        .trim_start()
        .strip_prefix('=')
        .unwrap_or(tail)
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().unwrap_or(DEFAULT_GRANULARITY)
}

/// Split a sorting key as ClickHouse prints it — `device_id, ts` — into terms.
///
/// At bracket depth zero, so `(a, b)` inside `toStartOfInterval(ts, INTERVAL 1
/// HOUR)` stays one term rather than becoming two nonsense ones.
pub fn key_terms(key: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    for c in key.chars() {
        match c {
            '(' | '[' => {
                depth += 1;
                current.push(c);
            }
            ')' | ']' => {
                depth -= 1;
                current.push(c);
            }
            ',' if depth == 0 => {
                let term = current.trim().to_string();
                if !term.is_empty() {
                    terms.push(term);
                }
                current.clear();
            }
            _ => current.push(c),
        }
    }
    let term = current.trim().to_string();
    if !term.is_empty() {
        terms.push(term);
    }
    terms
}

#[derive(Debug, Deserialize)]
struct TableRow {
    engine: String,
    sorting_key: String,
    partition_key: String,
    create_query: String,
}

#[derive(Debug, Deserialize)]
struct ExtentRow {
    parts: u64,
    rows: u64,
    bytes: u64,
}

#[derive(Debug, Deserialize)]
struct ColumnRow {
    name: String,
    r#type: String,
    in_partition_key: u8,
    compressed: u64,
}

#[derive(Debug, Deserialize)]
struct ProjectionRow {
    name: String,
    kind: String,
    query: String,
    sorting_key: Vec<String>,
    parts: u64,
    rows: u64,
    bytes: u64,
}

/// Everything the advisor's rules need about one table, in one call.
pub async fn advice(ch: &Client, database: &str, table: &str, days: u64) -> Result<Advice> {
    let days = days.clamp(1, 90);

    let table_row: TableRow = ch
        .rows_with::<TableRow>(
            "SELECT engine             AS engine, \
                    sorting_key        AS sorting_key, \
                    partition_key      AS partition_key, \
                    create_table_query AS create_query \
             FROM system.tables \
             WHERE database = {db:String} AND name = {tbl:String}",
            params(database, table),
        )
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| Error::NotFound(format!("{database}.{table}")))?;

    let extent: ExtentRow = ch
        .rows_with::<ExtentRow>(
            "SELECT count()                AS parts, \
                    sum(rows)              AS rows, \
                    sum(bytes_on_disk)     AS bytes \
             FROM system.parts \
             WHERE database = {db:String} AND table = {tbl:String} AND active",
            params(database, table),
        )
        .await
        .unwrap_or_default()
        .into_iter()
        .next()
        .unwrap_or(ExtentRow {
            parts: 0,
            rows: 0,
            bytes: 0,
        });

    let sorting_key = key_terms(&table_row.sorting_key);

    // Per-column bytes come from a different table than the column list, and
    // the join is left because `system.parts_columns` is empty for a table with
    // no parts and reports zero for every column of a Compact one. Zero is not
    // a size; it is the absence of one, and it is dropped below rather than
    // printed.
    let column_rows: Vec<ColumnRow> = ch
        .rows_with(
            "SELECT c.name                                  AS name, \
                    c.type                                  AS type, \
                    toUInt8(c.is_in_partition_key)          AS in_partition_key, \
                    toUInt64(ifNull(s.compressed, 0))       AS compressed \
             FROM system.columns AS c \
             LEFT JOIN ( \
                 SELECT column, sum(column_data_compressed_bytes) AS compressed \
                 FROM system.parts_columns \
                 WHERE database = {db:String} AND table = {tbl:String} AND active \
                 GROUP BY column \
             ) AS s ON s.column = c.name \
             WHERE c.database = {db:String} AND c.table = {tbl:String} \
             ORDER BY c.position",
            params(database, table),
        )
        .await?;

    let columns = column_rows
        .into_iter()
        .map(|c| AdviceColumn {
            sorting_position: sorting_key
                .iter()
                .position(|term| term == &c.name)
                .map(|i| i as u64 + 1),
            in_partition_key: c.in_partition_key != 0,
            compressed_bytes: Some(c.compressed).filter(|b| *b > 0),
            name: c.name,
            r#type: c.r#type,
        })
        .collect();

    // Two reads again, for the reason `derived` gives: `system.projections`
    // carries the definition and no size at all, and the size is the only thing
    // that tells a built projection from a declared one.
    let projection_rows: Vec<ProjectionRow> = match ch
        .rows_with(
            "SELECT p.name                                  AS name, \
                    toString(p.type)                        AS kind, \
                    p.query                                 AS query, \
                    p.sorting_key                           AS sorting_key, \
                    toUInt64(ifNull(s.parts, 0))            AS parts, \
                    toUInt64(ifNull(s.rows, 0))             AS rows, \
                    toUInt64(ifNull(s.bytes, 0))            AS bytes \
             FROM system.projections AS p \
             LEFT JOIN ( \
                 SELECT name, count() AS parts, sum(rows) AS rows, sum(bytes_on_disk) AS bytes \
                 FROM system.projection_parts \
                 WHERE database = {db:String} AND table = {tbl:String} AND active \
                 GROUP BY name \
             ) AS s ON s.name = p.name \
             WHERE p.database = {db:String} AND p.table = {tbl:String} \
             ORDER BY p.name",
            params(database, table),
        )
        .await
    {
        Ok(rows) => rows,
        // An older server has no `system.projections`. The table can still
        // carry projections and this page can still advise; it simply cannot
        // list what is already there, which the frontend says rather than
        // implying the table has none.
        Err(e) => {
            tracing::debug!("projections of {database}.{table} unavailable: {e}");
            Vec::new()
        }
    };

    let qualified = format!("{database}.{table}");
    let workload = workload(ch, &qualified, days).await?;
    // What the cap left out. Its own count rather than one derived from the
    // list, because the list is the *costliest* sixty and the question the page
    // has to answer is how many there were altogether.
    let totals = if workload.blocked.is_none() {
        workload_totals(ch, &qualified, days).await?
    } else {
        None
    };

    // How often the log saw each projection actually chosen.
    //
    // Its own query, over the *whole* window, and not a tally of the patterns
    // above — which is the shape this had first and which is wrong in a way
    // that matters. The pattern list is the sixty costliest shapes; a
    // projection answering a cheap, frequent query on a table with more shapes
    // than that would be counted zero, and zero here is what "nothing used it,
    // consider dropping it" rests on. A recommendation to drop something has to
    // be built on a count of everything.
    let used = projection_use(ch, database, table, days).await?;

    let existing = projection_rows
        .into_iter()
        .map(|p| Existing {
            inert: p.parts == 0,
            used_by: used
                .as_ref()
                .map(|counts| counts.get(&p.name).copied().unwrap_or(0)),
            name: p.name,
            kind: p.kind,
            query: p.query,
            sorting_key: p.sorting_key,
            parts: p.parts,
            rows: p.rows,
            bytes: p.bytes,
        })
        .collect();

    // The window granted, not the window asked for: `system.query_log`
    // commonly has a TTL of a day or two, and "nothing has asked this of the
    // table in a week" is a sentence somebody decides not to add a projection
    // on. It has to be the reach of the log rather than the reach of the
    // question — the oldest entry of any pattern, which is the server's own
    // subtraction and never this side's arithmetic over a browser clock.
    let since = workload
        .items
        .iter()
        .map(|p| p.first_seen.as_str())
        .min()
        .map(str::to_string);

    Ok(Advice {
        database: database.to_string(),
        table: table.to_string(),
        supported: holds_projections(&table_row.engine),
        engine: table_row.engine,
        sorting_key,
        partition_key: table_row.partition_key,
        total_rows: extent.rows,
        table_bytes: extent.bytes,
        parts: extent.parts,
        index_granularity: granularity_of(&table_row.create_query),
        columns,
        existing,
        window_days: days,
        since,
        workload,
        shapes_total: totals.map(|(shapes, _)| shapes),
        runs_total: totals.map(|(_, runs)| runs),
    })
}

/// How many shapes and runs there were before the cap took the costliest sixty.
///
/// A second query rather than a bigger first one: counting distinct hashes is
/// one aggregate over the same rows, where raising the cap would mean carrying
/// hundreds of full statements over the wire to answer a question that is two
/// numbers.
async fn workload_totals(ch: &Client, qualified: &str, days: u64) -> Result<Option<(u64, u64)>> {
    #[derive(Deserialize)]
    struct TotalsRow {
        shapes: u64,
        runs: u64,
    }
    let ours = excluding_flint(ch).await?;
    let sql = format!(
        "SELECT uniqExact(normalized_query_hash) AS shapes, count() AS runs \
         FROM system.query_log \
         WHERE type != 'QueryStart' \
           AND event_time > now() - INTERVAL {days} DAY \
           AND query_kind = 'Select' \
           AND exception_code = 0 \
           AND has(tables, {{target:String}}) {ours}"
    );
    Ok(ch
        .rows_with::<TotalsRow>(
            &sql,
            QueryOptions {
                params: vec![("target".into(), qualified.to_string())],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await
        .ok()
        .and_then(|rows| rows.into_iter().next())
        .map(|r| (r.shapes, r.runs)))
}

/// Runs the log attributes to each of this table's projections, over the whole
/// window.
///
/// `None` and `Some(0)` are very different answers and are kept apart: the
/// first is "this server's log does not record which projection served a query,
/// or would not show it to me", the second is "nothing used it all week". Only
/// the second licenses an opinion, and the opinion it licenses is a `DROP`.
async fn projection_use(
    ch: &Client,
    database: &str,
    table: &str,
    days: u64,
) -> Result<Option<std::collections::HashMap<String, u64>>> {
    if blocked(ch.reach("query_log").await?, "query_log").is_some() {
        return Ok(None);
    }
    // The field arrived late. Without it nothing can be said about use at all,
    // and saying nothing is the point — a zero here would be a lie that ends in
    // somebody dropping a projection their workload depends on.
    if !ch
        .system_columns("query_log")
        .await?
        .contains("projections")
    {
        return Ok(None);
    }
    let ours = excluding_flint(ch).await?;

    #[derive(Deserialize)]
    struct UseRow {
        name: String,
        runs: u64,
    }
    // `ARRAY JOIN` rather than a tally in Rust, so a query that used two
    // projections counts for both — and grouped over every row in the window
    // rather than over the shapes that happened to be costliest.
    let sql = format!(
        "SELECT p AS name, count() AS runs \
         FROM system.query_log \
         ARRAY JOIN projections AS p \
         WHERE type != 'QueryStart' \
           AND event_time > now() - INTERVAL {days} DAY \
           AND query_kind = 'Select' \
           AND notEmpty(p) \
           AND startsWith(p, {{prefix:String}}) {ours}\
         GROUP BY p"
    );
    let rows: Vec<UseRow> = match ch
        .rows_with(
            &sql,
            QueryOptions {
                params: vec![("prefix".into(), format!("{database}.{table}."))],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::debug!("projection use of {database}.{table} unavailable: {e}");
            return Ok(None);
        }
    };
    Ok(Some(
        rows.into_iter()
            // The log qualifies them: `analytics.events.by_city`.
            .map(|r| {
                let bare = r.name.rsplit('.').next().unwrap_or(&r.name).to_string();
                (bare, r.runs)
            })
            .collect(),
    ))
}

/// The SELECTs that ran against this table, grouped by shape.
///
/// Failures are left out. A query that raised is a query that read whatever it
/// had read when it stopped, and its cost is not the cost of the pattern — it
/// is the cost of the accident. They belong on the diagnose page, which is
/// about failures, and not in an argument about physical layout.
async fn workload(ch: &Client, qualified: &str, days: u64) -> Result<Section<Pattern>> {
    let reach = ch.reach("query_log").await?;
    if let Some(reason) = blocked(reach, "query_log") {
        return Ok(Section::blocked(reason));
    }
    let have = ch.system_columns("query_log").await?;
    for needed in ["normalized_query_hash", "tables", "query_kind"] {
        // An empty set means the catalogue itself could not be read, and a
        // column cannot be declared missing on that evidence.
        if !have.is_empty() && !have.contains(needed) {
            return Ok(Section::blocked(format!(
                "this ClickHouse version's system.query_log has no {needed}, so there is no way to \
                 tell which queries read this table"
            )));
        }
    }
    // `projections` arrived late. Without it the advice still stands; what goes
    // is the evidence that an existing projection is being chosen, which is
    // exactly the claim that must not be guessed.
    let projections_expr = if have.contains("projections") {
        "arrayDistinct(arrayFlatten(groupArray(20)(projections)))"
    } else {
        "[]"
    };
    let ours = excluding_flint(ch).await?;

    let sql = format!(
        "SELECT toString(normalized_query_hash)              AS hash, \
                count()                                      AS runs, \
                any(query)                                   AS statement, \
                round(avg(query_duration_ms), 1)             AS avg_ms, \
                round(quantile(0.95)(query_duration_ms), 1)  AS p95_ms, \
                sum(query_duration_ms)                       AS total_ms, \
                sum(read_rows)                               AS read_rows, \
                sum(read_bytes)                              AS read_bytes, \
                uniqExact(user)                              AS users, \
                toString(max(event_time))                    AS last_seen, \
                toString(min(event_time))                    AS first_seen, \
                arrayDistinct(arrayFlatten(groupArray(20)(tables))) AS touched, \
                {projections_expr}                           AS projections \
         FROM system.query_log \
         WHERE type != 'QueryStart' \
           AND event_time > now() - INTERVAL {days} DAY \
           AND query_kind = 'Select' \
           AND exception_code = 0 \
           AND has(tables, {{target:String}}) {ours}\
         GROUP BY normalized_query_hash \
         ORDER BY total_ms DESC \
         LIMIT {MAX_PATTERNS}"
    );

    match ch
        .rows_with::<Pattern>(
            &sql,
            QueryOptions {
                params: vec![("target".into(), qualified.to_string())],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await
    {
        Ok(rows) => Ok(Section::of(rows)),
        Err(Error::ClickHouse { code: 497, .. }) | Err(Error::ClickHouse { code: 164, .. }) => Ok(
            Section::blocked("this user is not granted SELECT on system.query_log".to_string()),
        ),
        Err(e) => Err(e),
    }
}

// ── Weighing a proposed key ────────────────────────────────────────────────

/// A term of a proposed projection key: a column of the table, optionally
/// bucketed.
///
/// The shape is a closed grammar and not an expression, for the reason
/// `probe::allowed_type` gives about the same class of endpoint: what arrives
/// here reaches a `GROUP BY`, and no amount of quoting makes arbitrary text
/// safe there. The column is checked against `system.columns` and the bucket
/// against a fixed list, and anything else is refused.
#[derive(Debug, Clone, Deserialize)]
pub struct KeyTerm {
    pub column: String,
    /// A time-bucketing function to wrap the column in, from `BUCKETS`.
    #[serde(default)]
    pub bucket: Option<String>,
}

/// The bucketing functions a proposal may use. Every one of them is a
/// `toStartOf*`-shaped function of one argument that ClickHouse can also use as
/// a projection sort key.
pub const BUCKETS: [&str; 9] = [
    "toStartOfMinute",
    "toStartOfFiveMinutes",
    "toStartOfHour",
    "toDate",
    "toStartOfDay",
    "toStartOfWeek",
    "toStartOfMonth",
    "toStartOfQuarter",
    "toStartOfYear",
];

#[derive(Debug, Clone, Deserialize)]
pub struct MeasureRequest {
    /// The proposed key, in order.
    pub keys: Vec<KeyTerm>,
    /// Columns the projection would hold, for the size figure. Empty asks for
    /// no size at all rather than for every column.
    #[serde(default)]
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Measurement {
    /// The key as it was measured, one expression per term — the same text the
    /// proposed DDL will carry, so the reader can see the two agree.
    pub keys: Vec<String>,
    pub total_rows: u64,
    /// Distinct values of the whole key. For an aggregate projection this *is*
    /// the row count of the projection, per part.
    pub groups: u64,
    /// False when `groups` is `uniqCombined`'s estimate rather than a count.
    /// Every sentence built on an estimate says "about".
    pub groups_exact: bool,
    /// Rows behind the most common key value, and behind the average one.
    /// Present only when the exact pass ran. The gap between them is the skew,
    /// which is what decides whether the average is worth quoting at all.
    pub max_rows_per_key: Option<u64>,
    pub avg_rows_per_key: Option<f64>,
    /// What the columns the projection would hold cost in the table today.
    /// `None` where the parts are Compact and per-column bytes do not exist —
    /// the honest state of knowledge, and not a zero.
    pub columns_compressed: Option<u64>,
    pub parts: u64,
    pub index_granularity: u64,
}

fn bucket_allowed(name: &str) -> bool {
    BUCKETS.contains(&name)
}

/// The expression for one key term, with the column quoted by us and the
/// function taken from the closed list.
fn key_expression(term: &KeyTerm, known: &[String]) -> Result<String> {
    if !known.iter().any(|c| c == &term.column) {
        return Err(Error::BadRequest(format!(
            "`{}` is not a column of this table",
            term.column
        )));
    }
    let column = quote_ident(&term.column);
    match term.bucket.as_deref().filter(|b| !b.is_empty()) {
        None => Ok(column),
        Some(bucket) if bucket_allowed(bucket) => Ok(format!("{bucket}({column})")),
        Some(other) => Err(Error::BadRequest(format!(
            "`{other}` is not a bucketing function this measures. It takes one of: {}",
            BUCKETS.join(", ")
        ))),
    }
}

/// A `String` array as ClickHouse's parameter binding wants it.
///
/// The one place in this module that builds a literal rather than binding a
/// value, because `{name:Array(String)}` takes its elements as text and there
/// is no per-element binding to lean on. The elements are column names read
/// back from `system.columns` a moment earlier — not from the request — so this
/// is escaping a value the server itself supplied, and it escapes it anyway.
fn array_literal(values: &[String]) -> String {
    let quoted: Vec<String> = values
        .iter()
        .map(|v| format!("'{}'", v.replace('\\', "\\\\").replace('\'', "\\'")))
        .collect();
    format!("[{}]", quoted.join(","))
}

#[derive(Debug, Deserialize)]
struct EstimateRow {
    total_rows: u64,
    groups: u64,
}

#[derive(Debug, Deserialize)]
struct ExactRow {
    groups: u64,
    max_rows: u64,
    avg_rows: f64,
}

#[derive(Debug, Deserialize)]
struct BytesRow {
    compressed: u64,
}

/// Count what a proposed key would actually come out at.
///
/// Two passes, and the second is conditional. The first is `uniqCombined` over
/// the key, which is bounded in memory whatever the key turns out to be, and
/// which answers the question a proposal lives or dies by: how many distinct
/// values are there. The second is a real `GROUP BY`, which is exact and also
/// tells us the skew — but which holds one row per group, so it is only run
/// once the first pass has shown that the number of groups is small enough for
/// that to be reasonable. A key with ten million distinct values gets the
/// estimate and a sentence saying so, which is the answer anyway.
pub async fn measure(
    ch: &Client,
    database: &str,
    table: &str,
    request: &MeasureRequest,
) -> Result<Measurement> {
    if request.keys.is_empty() {
        return Err(Error::BadRequest(
            "a projection key needs at least one column".into(),
        ));
    }

    #[derive(Deserialize)]
    struct NameRow {
        name: String,
    }
    let known: Vec<String> = ch
        .rows_with::<NameRow>(
            "SELECT name FROM system.columns \
             WHERE database = {db:String} AND table = {tbl:String}",
            params(database, table),
        )
        .await?
        .into_iter()
        .map(|r| r.name)
        .collect();
    if known.is_empty() {
        return Err(Error::NotFound(format!("{database}.{table}")));
    }

    let keys: Vec<String> = request
        .keys
        .iter()
        .map(|term| key_expression(term, &known))
        .collect::<Result<_>>()?;
    let source = format!("{}.{}", quote_ident(database), quote_ident(table));
    // A single-term key is measured on the column itself; a tuple only where
    // there is more than one, because `uniqCombined((x))` and `uniqCombined(x)`
    // are the same question asked twice as expensively.
    let key_value = if keys.len() == 1 {
        keys[0].clone()
    } else {
        format!("({})", keys.join(", "))
    };

    let estimate: EstimateRow = ch
        .rows_with::<EstimateRow>(
            &format!(
                "SELECT count() AS total_rows, uniqCombined({key_value}) AS groups FROM {source}"
            ),
            QueryOptions {
                quote_64bit_integers: false,
                // Tagged, or the measurement turns up in the very workload it
                // was run to explain — as the costliest pattern against the
                // table, since it reads every row of the key.
                introspection: true,
                ..Default::default()
            },
        )
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| Error::Decode("the key measurement returned no row".into()))?;

    let exact = if estimate.groups <= EXACT_GROUP_CEILING {
        ch.rows_with::<ExactRow>(
            &format!(
                "SELECT count()      AS groups, \
                        max(n)       AS max_rows, \
                        avg(n)       AS avg_rows \
                 FROM (SELECT count() AS n FROM {source} GROUP BY {})",
                keys.join(", ")
            ),
            QueryOptions {
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await
        .inspect_err(|e| tracing::debug!("exact key measurement of {database}.{table}: {e}"))
        .ok()
        .and_then(|rows| rows.into_iter().next())
    } else {
        None
    };

    let columns_compressed = if request.columns.is_empty() {
        None
    } else {
        let wanted: Vec<String> = request
            .columns
            .iter()
            .filter(|c| known.contains(c))
            .cloned()
            .collect();
        ch.rows_with::<BytesRow>(
            "SELECT toUInt64(sum(column_data_compressed_bytes)) AS compressed \
             FROM system.parts_columns \
             WHERE database = {db:String} AND table = {tbl:String} AND active \
               AND has({cols:Array(String)}, column)",
            QueryOptions {
                params: vec![
                    ("db".into(), database.to_string()),
                    ("tbl".into(), table.to_string()),
                    ("cols".into(), array_literal(&wanted)),
                ],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await
        .ok()
        .and_then(|rows| rows.into_iter().next())
        .map(|r| r.compressed)
        // Zero is what a Compact part reports for every column. It is not a
        // size, it is the absence of one.
        .filter(|b| *b > 0)
    };

    let extent: Vec<ExtentRow> = ch
        .rows_with(
            "SELECT count() AS parts, sum(rows) AS rows, sum(bytes_on_disk) AS bytes \
             FROM system.parts \
             WHERE database = {db:String} AND table = {tbl:String} AND active",
            params(database, table),
        )
        .await
        .unwrap_or_default();
    let parts = extent.first().map(|e| e.parts).unwrap_or(0);

    let create: Vec<TableRow> = ch
        .rows_with(
            "SELECT engine AS engine, sorting_key AS sorting_key, \
                    partition_key AS partition_key, create_table_query AS create_query \
             FROM system.tables WHERE database = {db:String} AND name = {tbl:String}",
            params(database, table),
        )
        .await
        .unwrap_or_default();

    Ok(Measurement {
        keys,
        total_rows: estimate.total_rows,
        groups: exact.as_ref().map(|e| e.groups).unwrap_or(estimate.groups),
        groups_exact: exact.is_some(),
        max_rows_per_key: exact.as_ref().map(|e| e.max_rows),
        avg_rows_per_key: exact.as_ref().map(|e| e.avg_rows),
        columns_compressed,
        parts,
        index_granularity: create
            .first()
            .map(|t| granularity_of(&t.create_query))
            .unwrap_or(DEFAULT_GRANULARITY),
    })
}

// ── The same question across a database ────────────────────────────────────

/// Tables carried back at most. A database with more than this has more than
/// anybody reads down; the cap states its own count on the other side.
const MAX_TABLES: u64 = 40;

/// Shapes kept per table.
///
/// Five, and not sixty. This view answers "which of these tables is worth
/// opening", and it answers it from a handful of named shapes rather than from
/// a sample of the workload that would have to be hedged into uselessness.
///
/// Three at first, and that was too few: on a table whose two costliest shapes
/// are a cross join and a profiling scan — which is what a log looks like on a
/// machine somebody develops on — the reading came out as "nothing to serve"
/// for a table the per-table advisor finds two proposals on. Five is still a
/// handful and still cheap; whoever opens the table gets the full sixty.
const SAMPLES_PER_TABLE: u64 = 5;

#[derive(Debug, Clone, Serialize)]
pub struct TableStanding {
    pub table: String,
    pub engine: String,
    pub rows: u64,
    pub bytes: u64,
    pub parts: u64,
    pub sorting_key: Vec<String>,
    /// Projections this table already has, and what they hold.
    pub projections: u64,
    pub projection_bytes: u64,
    /// The workload against it, over the whole window and not over the samples.
    pub shapes: u64,
    pub runs: u64,
    pub total_ms: u64,
    pub read_rows: u64,
    /// The costliest shapes, for the browser to read the access pattern from.
    pub samples: Vec<Pattern>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DatabaseAdvice {
    pub database: String,
    pub window_days: u64,
    /// Ordered by the time the workload spent on each table, heaviest first.
    pub tables: Vec<TableStanding>,
    /// Tables in the database that could hold a projection at all, before the
    /// cap — so a list of forty never reads as the whole database.
    pub tables_total: u64,
    /// Tables with a workload in the window at all.
    pub tables_read: u64,
    /// Present when there is no workload to read, and why.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TableRowFacts {
    table: String,
    engine: String,
    sorting_key: String,
    rows: u64,
    bytes: u64,
    parts: u64,
}

#[derive(Debug, Deserialize)]
struct TrafficRow {
    table: String,
    shapes: u64,
    runs: u64,
    total_ms: u64,
    read_rows: u64,
}

#[derive(Debug, Deserialize)]
struct ProjCount {
    table: String,
    projections: u64,
    bytes: u64,
}

/// Which tables in a database the workload argues about, heaviest first.
///
/// The question that comes before opening any single table's tab, and it is
/// answered with three reads rather than one per table: the tables and their
/// extents, the log grouped by table, and the projections already there. The
/// per-table advisor then does the real work on whichever one gets opened.
pub async fn database_advice(ch: &Client, database: &str, days: u64) -> Result<DatabaseAdvice> {
    let days = days.clamp(1, 90);
    let db_param = || QueryOptions {
        params: vec![("db".into(), database.to_string())],
        quote_64bit_integers: false,
        introspection: true,
        ..Default::default()
    };

    // Only tables that could hold a projection. A view has no parts and a Log
    // engine has no key, and listing either would be offering advice that
    // cannot be taken.
    let facts: Vec<TableRowFacts> = ch
        .rows_with(
            "SELECT t.name                              AS table, \
                    t.engine                            AS engine, \
                    t.sorting_key                       AS sorting_key, \
                    toUInt64(ifNull(p.rows, 0))         AS rows, \
                    toUInt64(ifNull(p.bytes, 0))        AS bytes, \
                    toUInt64(ifNull(p.parts, 0))        AS parts \
             FROM system.tables AS t \
             LEFT JOIN ( \
                 SELECT table, sum(rows) AS rows, sum(bytes_on_disk) AS bytes, count() AS parts \
                 FROM system.parts WHERE database = {db:String} AND active GROUP BY table \
             ) AS p ON p.table = t.name \
             WHERE t.database = {db:String} AND endsWith(t.engine, 'MergeTree')",
            db_param(),
        )
        .await?;
    let tables_total = facts.len() as u64;

    let projections: Vec<ProjCount> = ch
        .rows_with(
            "SELECT p.table                             AS table, \
                    count()                             AS projections, \
                    toUInt64(ifNull(any(s.bytes), 0))   AS bytes \
             FROM system.projections AS p \
             LEFT JOIN ( \
                 SELECT table, sum(bytes_on_disk) AS bytes \
                 FROM system.projection_parts \
                 WHERE database = {db:String} AND active GROUP BY table \
             ) AS s ON s.table = p.table \
             WHERE p.database = {db:String} \
             GROUP BY p.table",
            db_param(),
        )
        .await
        .unwrap_or_default();

    let reach = ch.reach("query_log").await?;
    if let Some(reason) = blocked(reach, "query_log") {
        return Ok(DatabaseAdvice {
            database: database.to_string(),
            window_days: days,
            tables: Vec::new(),
            tables_total,
            tables_read: 0,
            blocked: Some(reason),
        });
    }
    let ours = excluding_flint(ch).await?;

    // One pass, grouped by table. `ARRAY JOIN` over `tables` is what makes it
    // one query instead of one per table — the cost of this whole view.
    let traffic: Vec<TrafficRow> = ch
        .rows_with(
            &format!(
                "SELECT splitByChar('.', t)[2]                AS table, \
                        uniqExact(normalized_query_hash)      AS shapes, \
                        count()                               AS runs, \
                        sum(query_duration_ms)                AS total_ms, \
                        sum(read_rows)                        AS read_rows \
                 FROM system.query_log \
                 ARRAY JOIN tables AS t \
                 WHERE type != 'QueryStart' \
                   AND event_time > now() - INTERVAL {days} DAY \
                   AND query_kind = 'Select' \
                   AND exception_code = 0 \
                   AND startsWith(t, {{prefix:String}}) {ours}\
                 GROUP BY table"
            ),
            QueryOptions {
                params: vec![("prefix".into(), format!("{database}."))],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await
        .unwrap_or_default();

    let tables_read = traffic.len() as u64;
    let mut standings: Vec<TableStanding> = facts
        .into_iter()
        .map(|f| {
            let seen = traffic.iter().find(|t| t.table == f.table);
            let held = projections.iter().find(|p| p.table == f.table);
            TableStanding {
                sorting_key: key_terms(&f.sorting_key),
                table: f.table,
                engine: f.engine,
                rows: f.rows,
                bytes: f.bytes,
                parts: f.parts,
                projections: held.map(|p| p.projections).unwrap_or(0),
                projection_bytes: held.map(|p| p.bytes).unwrap_or(0),
                shapes: seen.map(|t| t.shapes).unwrap_or(0),
                runs: seen.map(|t| t.runs).unwrap_or(0),
                total_ms: seen.map(|t| t.total_ms).unwrap_or(0),
                read_rows: seen.map(|t| t.read_rows).unwrap_or(0),
                samples: Vec::new(),
            }
        })
        // A table nothing has read is not a subject for this view. It may still
        // want a projection; nothing in the log can say so, and a row of zeroes
        // ranked below everything is noise.
        .filter(|t| t.runs > 0)
        .collect();
    standings.sort_by_key(|t| std::cmp::Reverse(t.total_ms));
    standings.truncate(MAX_TABLES as usize);

    // The costliest shapes for the tables that survived the cap, one query for
    // all of them: `LIMIT n BY table` is the whole reason this is not a loop.
    if !standings.is_empty() {
        let wanted: Vec<String> = standings
            .iter()
            .map(|t| format!("{database}.{}", t.table))
            .collect();
        let has_projections = ch
            .system_columns("query_log")
            .await?
            .contains("projections");
        let projections_expr = if has_projections { "projections" } else { "[]" };
        let sql = format!(
            "SELECT splitByChar('.', t)[2]                    AS for_table, \
                    toString(normalized_query_hash)           AS hash, \
                    count()                                   AS runs, \
                    any(query)                                AS statement, \
                    round(avg(query_duration_ms), 1)          AS avg_ms, \
                    round(quantile(0.95)(query_duration_ms), 1) AS p95_ms, \
                    sum(query_duration_ms)                    AS total_ms, \
                    sum(read_rows)                            AS read_rows, \
                    sum(read_bytes)                           AS read_bytes, \
                    uniqExact(user)                           AS users, \
                    toString(max(event_time))                 AS last_seen, \
                    toString(min(event_time))                 AS first_seen, \
                    arrayDistinct(arrayFlatten(groupArray(5)(tables)))  AS touched, \
                    arrayDistinct(arrayFlatten(groupArray(5)({projections_expr}))) AS projections \
             FROM system.query_log \
             ARRAY JOIN tables AS t \
             WHERE type != 'QueryStart' \
               AND event_time > now() - INTERVAL {days} DAY \
               AND query_kind = 'Select' \
               AND exception_code = 0 \
               AND has({{wanted:Array(String)}}, t) {ours}\
             GROUP BY for_table, normalized_query_hash \
             ORDER BY for_table, total_ms DESC \
             LIMIT {SAMPLES_PER_TABLE} BY for_table"
        );

        #[derive(Deserialize)]
        struct SampleRow {
            for_table: String,
            #[serde(flatten)]
            pattern: Pattern,
        }
        let samples: Vec<SampleRow> = ch
            .rows_with(
                &sql,
                QueryOptions {
                    params: vec![("wanted".into(), array_literal(&wanted))],
                    quote_64bit_integers: false,
                    introspection: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap_or_default();
        for row in samples {
            if let Some(t) = standings.iter_mut().find(|t| t.table == row.for_table) {
                t.samples.push(row.pattern);
            }
        }
    }

    Ok(DatabaseAdvice {
        database: database.to_string(),
        window_days: days,
        tables: standings,
        tables_total,
        tables_read,
        blocked: None,
    })
}

// ── Weighing an aggregate projection ───────────────────────────────────────

/// Aggregate functions this will build a scratch table for.
///
/// A closed list, and the reason is the one `probe::allowed_type` gives about
/// the same class of endpoint: what arrives here reaches a `CREATE TABLE`, and
/// no amount of quoting makes arbitrary text safe there. A name that is not on
/// this list is not weighed — the figure is dropped, which is what the house
/// rule says to do with a figure that cannot be had.
///
/// Every entry has a `-State` combinator that ClickHouse will store, because
/// that is what a projection actually holds: the finalized value of a
/// `quantile` is a `Float64` and its state is a digest many times wider, so
/// weighing the finalized form would under-report the cost by an order of
/// magnitude and call it a measurement.
const WEIGHABLE: [&str; 22] = [
    "count",
    "sum",
    "avg",
    "min",
    "max",
    "any",
    "anyLast",
    "uniq",
    "uniqExact",
    "uniqCombined",
    "uniqHLL12",
    "median",
    "quantile",
    "quantiles",
    "quantileExact",
    "quantileTDigest",
    "argMin",
    "argMax",
    "topK",
    "stddevPop",
    "stddevSamp",
    "varPop",
];

/// One aggregate a proposed projection would store, in pieces rather than as
/// text.
///
/// Decomposed by the browser and rebuilt here, so nothing the caller sends is
/// ever concatenated into SQL: the name is matched against `WEIGHABLE`, the
/// parameters are numbers by the time serde has read them, and every argument
/// has to be a column this table actually has.
#[derive(Debug, Clone, Deserialize)]
pub struct AggregateTerm {
    pub name: String,
    /// The `0.95` in `quantile(0.95)(value)`. Numbers only.
    #[serde(default)]
    pub params: Vec<f64>,
    /// Column arguments. `count()` has none.
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WeighRequest {
    pub keys: Vec<KeyTerm>,
    pub aggregates: Vec<AggregateTerm>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Weight {
    /// Rows the grouping actually produced, which is the projection's row count
    /// once its parts have merged.
    pub rows: u64,
    /// What those rows and their aggregate states occupy on disk, as **one
    /// part**.
    ///
    /// `bytes_on_disk` and not `data_compressed_bytes`, so it is the same
    /// figure `system.projection_parts` reports for a projection that already
    /// exists and the two can be put beside each other. The difference is the
    /// marks, the primary index and the checksums — 399 against 152 on the
    /// table this was checked on, which is a factor of 2.6 and not a rounding.
    pub on_disk: u64,
    pub uncompressed: u64,
    /// Active parts of the source table, because a projection is written *per
    /// part*.
    ///
    /// `on_disk` is one part's worth, so `on_disk × parts` is the **ceiling**
    /// and `on_disk` is the floor. It is a ceiling and not an equality, which
    /// was measured both ways rather than assumed:
    ///
    /// | key | one part | × 5 parts | the real projection |
    /// |---|---|---|---|
    /// | `type`, 3 values | 399 B | 1,995 B | **1,995 B** |
    /// | `toStartOfDay(time)`, 31 values | 605 B | 3,025 B | **2,618 B** |
    ///
    /// The first is exact because every part holds all three values. The second
    /// is 15% under the ceiling because the parts were written in time order,
    /// so each one holds only some of the days — the projection came out at 64
    /// rows and not 155. Whether a key lands on the ceiling or below it depends
    /// on how it correlates with the way the parts were written, which is not
    /// something this can know, so both ends are reported and neither is
    /// presented as the answer.
    pub parts: u64,
    /// What the table itself occupies, so the reader gets a share and not only
    /// a figure.
    pub table_bytes: u64,
    /// The scratch table's own definition, so the reader can see what was
    /// weighed rather than take the number on trust.
    pub built: String,
}

/// Above this many groups the scratch table is not built.
///
/// It writes one row per group, and a projection with more groups than this is
/// already the wrong idea — the measurement that produced the number has
/// answered the question before this endpoint could. The ceiling is on the
/// estimate, which costs one bounded-memory pass.
const WEIGH_CEILING: u64 = 2_000_000;

/// A number as ClickHouse will read it back.
///
/// `f64::to_string` gives `0.95` and `1` — the second of which is a perfectly
/// good `UInt8` to the parser and would change `quantile(1)` into a request for
/// the maximum rather than the 100th percentile of nothing. Whole numbers are
/// written with a decimal point so the parameter keeps the type the caller
/// meant. Finite by construction: serde rejects a JSON `NaN` before this runs,
/// and the guard is here because a non-finite value would reach the statement
/// as the literal `inf`.
fn number_literal(value: f64) -> Result<String> {
    if !value.is_finite() {
        return Err(Error::BadRequest(
            "an aggregate parameter has to be a finite number".into(),
        ));
    }
    Ok(if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{value:.1}")
    } else {
        format!("{value}")
    })
}

/// The `-State` expression for one aggregate, built from pieces this module
/// checked rather than from anything the caller wrote.
fn state_expression(term: &AggregateTerm, known: &[String]) -> Result<String> {
    if !WEIGHABLE.contains(&term.name.as_str()) {
        return Err(Error::BadRequest(format!(
            "`{}` is not an aggregate this weighs. It builds a scratch table, and only the \
             functions on its own list ever reach that statement.",
            term.name
        )));
    }
    for arg in &term.args {
        if !known.iter().any(|c| c == arg) {
            return Err(Error::BadRequest(format!(
                "`{arg}` is not a column of this table"
            )));
        }
    }
    let params = if term.params.is_empty() {
        String::new()
    } else {
        let written: Vec<String> = term
            .params
            .iter()
            .map(|p| number_literal(*p))
            .collect::<Result<_>>()?;
        format!("({})", written.join(", "))
    };
    let args: Vec<String> = term.args.iter().map(|a| quote_ident(a)).collect();
    Ok(format!("{}State{params}({})", term.name, args.join(", ")))
}

/// Build what an aggregate projection would hold, weigh it, and throw it away.
///
/// The benefit of an aggregate projection is countable before it exists — one
/// row per group, and `measure` counts the groups. Its **size** is not: it
/// depends on the width of the aggregate states, and a `quantileTDigest` state
/// is not a number that can be reasoned about from the schema. So this does
/// what the type probe does, for the same reason: it writes the thing, weighs
/// it, and drops it.
///
/// It is a **model and not the projection**. Same rows, same key, same states,
/// written by an `AggregatingMergeTree` instead of by the projection machinery
/// — which is as close as anything can get without creating the projection on
/// somebody's table, and the response says so in `built` rather than leaving
/// the reader to assume otherwise.
///
/// Writes go to Flint's own database and carry `allow_write`, on the reasoning
/// the workspace module sets out: `FLINT_READONLY` is a promise about *your*
/// tables, and this never touches them.
pub async fn weigh(
    ch: &Client,
    workspace: &str,
    database: &str,
    table: &str,
    request: &WeighRequest,
) -> Result<Weight> {
    if request.keys.is_empty() {
        return Err(Error::BadRequest(
            "a projection key needs at least one column".into(),
        ));
    }
    if request.aggregates.is_empty() {
        return Err(Error::BadRequest(
            "there is nothing to weigh: an aggregate projection with no aggregates is a sort \
             order, and those are weighed by what their columns cost today"
                .into(),
        ));
    }

    #[derive(Deserialize)]
    struct NameRow {
        name: String,
    }
    let known: Vec<String> = ch
        .rows_with::<NameRow>(
            "SELECT name FROM system.columns \
             WHERE database = {db:String} AND table = {tbl:String}",
            params(database, table),
        )
        .await?
        .into_iter()
        .map(|r| r.name)
        .collect();
    if known.is_empty() {
        return Err(Error::NotFound(format!("{database}.{table}")));
    }

    let keys: Vec<String> = request
        .keys
        .iter()
        .map(|term| key_expression(term, &known))
        .collect::<Result<_>>()?;
    let states: Vec<String> = request
        .aggregates
        .iter()
        .map(|term| state_expression(term, &known))
        .collect::<Result<_>>()?;

    let source = format!("{}.{}", quote_ident(database), quote_ident(table));
    let key_list = keys.join(", ");
    let key_value = if keys.len() == 1 {
        keys[0].clone()
    } else {
        format!("({key_list})")
    };

    // The cheap pass first, so a key with ten million distinct values is
    // refused before anything is written rather than after.
    let estimate: EstimateRow = ch
        .rows_with::<EstimateRow>(
            &format!(
                "SELECT count() AS total_rows, uniqCombined({key_value}) AS groups FROM {source}"
            ),
            QueryOptions {
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| Error::Decode("the key measurement returned no row".into()))?;
    if estimate.groups > WEIGH_CEILING {
        return Err(Error::BadRequest(format!(
            "that key has about {} distinct values, so the projection would hold about that many \
             rows. Building it to weigh it is not a reasonable thing to do to answer a question \
             the count has already answered.",
            estimate.groups
        )));
    }

    let scratch = format!(
        "{}.projweigh_{}",
        quote_ident(workspace),
        Uuid::new_v4().simple()
    );
    // Every key is aliased, and it has to be. `CREATE TABLE … ENGINE =
    // AggregatingMergeTree ORDER BY (toStartOfDay(time)) AS SELECT
    // toStartOfDay(time) …` names the new table's column `toStartOfDay(time)`
    // and then tries to resolve the ORDER BY against *that* table, where there
    // is no `time` at all: `Missing columns: 'time' … available columns:
    // 'toStartOfDay(time)'`. Aliasing stores exactly the same data under a name
    // the ORDER BY can reach.
    let aliases: Vec<String> = (0..keys.len()).map(|i| format!("k{i}")).collect();
    let selected: Vec<String> = keys
        .iter()
        .enumerate()
        .map(|(i, expr)| format!("{expr} AS k{i}"))
        .chain(
            states
                .iter()
                .enumerate()
                .map(|(i, expr)| format!("{expr} AS a{i}")),
        )
        .collect();
    // Ordered by the same key, because that is how the projection's own part is
    // laid out — the sort is not decoration here, it decides how the key
    // columns compress.
    let build = format!(
        "CREATE TABLE {scratch} ENGINE = AggregatingMergeTree ORDER BY ({}) \
         AS SELECT {} FROM {source} GROUP BY {key_list}",
        aliases.join(", "),
        selected.join(", ")
    );

    let measured = weigh_scratch(ch, &scratch, &build).await;
    if let Err(e) = ch
        .execute(&format!("DROP TABLE IF EXISTS {scratch}"), write_opts())
        .await
    {
        // Not fatal, but somebody has to know: a scratch table left behind is
        // Flint's mess in the reader's database.
        tracing::warn!("could not drop the projection weigher {scratch}: {e}");
    }
    let (rows, on_disk, uncompressed) = measured?;

    let extent: Vec<ExtentRow> = ch
        .rows_with(
            "SELECT count() AS parts, sum(rows) AS rows, sum(bytes_on_disk) AS bytes \
             FROM system.parts \
             WHERE database = {db:String} AND table = {tbl:String} AND active",
            params(database, table),
        )
        .await
        .unwrap_or_default();

    Ok(Weight {
        rows,
        on_disk,
        uncompressed,
        parts: extent.first().map(|e| e.parts).unwrap_or(1).max(1),
        table_bytes: extent.first().map(|e| e.bytes).unwrap_or(0),
        // The scratch name is a UUID nobody can act on; the shape is what the
        // reader needs to judge the figure, so it goes back with the name
        // stripped back to something readable.
        built: build.replace(&scratch, "<scratch>"),
    })
}

fn write_opts() -> QueryOptions {
    QueryOptions {
        allow_write: true,
        quote_64bit_integers: false,
        introspection: true,
        ..Default::default()
    }
}

#[derive(Debug, Deserialize)]
struct ScratchRow {
    rows: u64,
    on_disk: u64,
    uncompressed: u64,
}

async fn weigh_scratch(ch: &Client, scratch: &str, build: &str) -> Result<(u64, u64, u64)> {
    ch.execute(build, write_opts()).await?;
    let (db, name) = scratch.split_once('.').unwrap_or(("", scratch));
    let rows: Vec<ScratchRow> = ch
        .rows_with(
            "SELECT sum(rows)                   AS rows, \
                    sum(bytes_on_disk)           AS on_disk, \
                    sum(data_uncompressed_bytes) AS uncompressed \
             FROM system.parts \
             WHERE database = {db:String} AND table = {t:String} AND active",
            QueryOptions {
                params: vec![
                    ("db".into(), db.trim_matches('`').to_string()),
                    ("t".into(), name.trim_matches('`').to_string()),
                ],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;
    let row = rows
        .into_iter()
        .next()
        .ok_or_else(|| Error::Decode("the weigher's scratch table reported no parts".into()))?;
    Ok((row.rows, row.on_disk, row.uncompressed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_a_sorting_key_without_splitting_a_function_call() {
        assert_eq!(key_terms("device_id, ts"), vec!["device_id", "ts"]);
        assert_eq!(key_terms(""), Vec::<String>::new());
        // The comma inside the call is not a term separator, and a key written
        // this way is common enough that getting it wrong would misreport the
        // order of half the tables on a busy server.
        assert_eq!(
            key_terms("project_id, toStartOfInterval(ts, INTERVAL 1 HOUR), device_id"),
            vec![
                "project_id",
                "toStartOfInterval(ts, INTERVAL 1 HOUR)",
                "device_id"
            ]
        );
    }

    #[test]
    fn reads_the_declared_granularity_and_falls_back_to_the_default() {
        assert_eq!(
            granularity_of("CREATE TABLE t (...) ENGINE = MergeTree ORDER BY x SETTINGS index_granularity = 4096"),
            4096
        );
        // No SETTINGS at all: ClickHouse's own default, which is what the
        // server will use.
        assert_eq!(
            granularity_of("CREATE TABLE t (...) ENGINE = MergeTree ORDER BY x"),
            DEFAULT_GRANULARITY
        );
        // `index_granularity_bytes` is a different setting and must not be read
        // as this one.
        assert_eq!(
            granularity_of("... SETTINGS index_granularity_bytes = 10485760"),
            DEFAULT_GRANULARITY
        );
    }

    #[test]
    fn recognises_every_merge_tree_including_the_replicated_and_shared_ones() {
        assert!(holds_projections("MergeTree"));
        assert!(holds_projections("ReplicatedReplacingMergeTree"));
        assert!(holds_projections("SharedMergeTree"));
        assert!(!holds_projections("Log"));
        assert!(!holds_projections("MaterializedView"));
        assert!(!holds_projections("Distributed"));
    }

    #[test]
    fn refuses_a_bucket_that_is_not_on_the_list() {
        let known = vec!["ts".to_string()];
        let ok = KeyTerm {
            column: "ts".into(),
            bucket: Some("toStartOfHour".into()),
        };
        // `quote_ident` leaves a plain name alone — the same rule the frontend
        // keeps, so the expression here and the one in the proposed DDL are the
        // same text and the reader can see they agree.
        assert_eq!(key_expression(&ok, &known).unwrap(), "toStartOfHour(ts)");

        // The whole defence of this endpoint: nothing that is not on the list
        // reaches a GROUP BY, however it is spelled.
        let smuggled = KeyTerm {
            column: "ts".into(),
            bucket: Some("toStartOfHour(x), (SELECT 1".into()),
        };
        assert!(key_expression(&smuggled, &known).is_err());

        let unknown = KeyTerm {
            column: "no_such_column".into(),
            bucket: None,
        };
        assert!(key_expression(&unknown, &known).is_err());
    }

    fn agg(name: &str, params: &[f64], args: &[&str]) -> AggregateTerm {
        AggregateTerm {
            name: name.to_string(),
            params: params.to_vec(),
            args: args.iter().map(|a| (*a).to_string()).collect(),
        }
    }

    #[test]
    fn builds_a_state_expression_from_pieces_and_never_from_text() {
        let known = vec!["value".to_string(), "odd name".to_string()];
        assert_eq!(
            state_expression(&agg("count", &[], &[]), &known).unwrap(),
            "countState()"
        );
        assert_eq!(
            state_expression(&agg("sum", &[], &["value"]), &known).unwrap(),
            "sumState(value)"
        );
        // The combinator attaches to the name and the parameters follow it, so
        // `quantile(0.95)(x)` becomes `quantileState(0.95)(x)` and not
        // `quantile(0.95)State(x)`, which is not a function.
        assert_eq!(
            state_expression(&agg("quantile", &[0.95], &["value"]), &known).unwrap(),
            "quantileState(0.95)(value)"
        );
        assert_eq!(
            state_expression(&agg("sum", &[], &["odd name"]), &known).unwrap(),
            "sumState(`odd name`)"
        );
    }

    #[test]
    fn refuses_anything_that_is_not_on_its_own_list() {
        let known = vec!["value".to_string()];
        // This reaches a CREATE TABLE. The list is the only defence that holds.
        assert!(state_expression(&agg("dictGet", &[], &["value"]), &known).is_err());
        assert!(state_expression(&agg("sum(x), 1 AS y --", &[], &[]), &known).is_err());
        // An argument that is not a column of this table.
        assert!(state_expression(&agg("sum", &[], &["no_such_column"]), &known).is_err());
    }

    #[test]
    fn keeps_a_whole_parameter_a_float() {
        // `quantile(1)` and `quantile(1.0)` are different requests to the
        // parser, and writing a whole number without its point silently changes
        // which one was asked for.
        assert_eq!(number_literal(1.0).unwrap(), "1.0");
        assert_eq!(number_literal(0.95).unwrap(), "0.95");
        // A non-finite value would reach the statement as the literal `inf`.
        assert!(number_literal(f64::INFINITY).is_err());
        assert!(number_literal(f64::NAN).is_err());
    }

    #[test]
    fn quotes_an_awkward_column_name_in_the_key() {
        let known = vec!["odd name".to_string()];
        let term = KeyTerm {
            column: "odd name".into(),
            bucket: None,
        };
        assert_eq!(key_expression(&term, &known).unwrap(), "`odd name`");
    }
}
