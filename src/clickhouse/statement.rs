//! One statement, and everything the log kept about it.
//!
//! Every other reading of `system.query_log` in Flint *groups*: by shape, by
//! account, by table, by error. That is right for "what is expensive here" and
//! useless for the question somebody arrives with once they have an answer —
//! *this* call was slow, why. So this reads one row, by `query_id`, and carries
//! it whole.
//!
//! Nothing here is new measurement. It is the row the server already wrote,
//! with three things pulled out of it that no page in Flint has shown before,
//! and each of them was checked against a real server rather than taken from
//! the documentation.
//!
//! ## The pruning is in the log, not only in a plan
//!
//! `ProfileEvents` carries `SelectedParts`/`SelectedPartsTotal`,
//! `SelectedMarks`/`SelectedMarksTotal` and `SelectedRanges` — how much of the
//! table the primary key let this run skip, *on the run itself*. Flint already
//! reads pruning out of `EXPLAIN PLAN indexes = 1`, and that is a different and
//! weaker claim: an explain asked today re-plans against today's parts, so it
//! answers about a table that has merged and grown since. The counters are what
//! actually happened. Where both are available the page says both and marks
//! which is which.
//!
//! ## The phases are in the log too
//!
//! `QueryParseMicroseconds`, `QueryAnalysisMicroseconds`,
//! `QueryPlanBuildMicroseconds`, `QueryPlanOptimizeMicroseconds` and
//! `QueryPipelineBuildMicroseconds` divide the front of a statement's life.
//! They do not add up to the duration and must never be drawn as though they
//! did — everything after the pipeline is built is execution, and it is the
//! remainder rather than a counter. A five-millisecond statement that spent
//! three milliseconds being analysed is a finding; the same three milliseconds
//! under a four-minute scan is noise.
//!
//! ## `system.processors_profile_log` is usually not there
//!
//! It is the only source of per-operator figures, and on the server this was
//! built against it does not exist at all. Measured rather than assumed:
//! `log_processors_profiles` reads `1` in `system.settings`, a statement was run
//! carrying it explicitly, `SYSTEM FLUSH LOGS` was waited on, and the table was
//! still absent — fifteen `system.*_log` tables on the machine and not that one.
//! The switch that is off is a **section in the server's configuration**, not a
//! setting anybody can send on a request, which is why the absence is reported
//! as a fact about the deployment and not as advice to add a `SETTINGS` clause.
//! Where the table does exist it is read, and where it does not the rest of the
//! page is unaffected.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::diagnostics::{blocked, missing};
use super::{Client, QueryOptions, Reach, Section, ATTACHED_SETTINGS};
use crate::error::{Error, Result};

/// A `ProfileEvents` counter, as the server named it.
///
/// All of them travel, not the dozen the page explains. The judgement about
/// which counters are worth a sentence belongs in `lib/statement.ts` with the
/// tests that argue for it, and a reader who wants the other hundred and forty
/// should not have to ask Flint for a second request to see them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Counter {
    pub name: String,
    pub value: u64,
}

/// One setting this statement ran with, as `system.query_log` recorded it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Setting {
    pub name: String,
    pub value: String,
}

/// One operator of the pipeline, folded over every processor that shared its
/// name — `AggregatingTransform × 32` is one row, because thirty-two rows of
/// it is the thread count wearing the clothes of a plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stage {
    pub name: String,
    pub micros: u64,
    pub input_rows: u64,
    pub input_bytes: u64,
    pub output_rows: u64,
    pub output_bytes: u64,
    /// How many processors carried this name. The parallelism of one stage,
    /// which is the figure `peak_threads_usage` cannot give per operator.
    pub processors: u64,
}

/// How this statement's shape has behaved lately, so one run can be read
/// against its own normal rather than against nothing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shape {
    pub hash: String,
    pub runs: u64,
    /// The median rather than the mean: one four-minute outlier drags an
    /// average until every other run looks fast, and "is this run unusual"
    /// is exactly the question an average cannot answer.
    pub median_ms: f64,
    pub p95_ms: f64,
    pub max_ms: u64,
    pub failures: u64,
    pub window_days: u64,
}

/// One statement, as the log kept it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Statement {
    pub query_id: String,
    /// `QueryFinish`, `ExceptionWhileProcessing`, `ExceptionBeforeStart` — or
    /// `QueryStart`, which means the log holds no ending for this one. See
    /// `running`.
    pub outcome: String,
    /// `Select`, `Insert`, `Create`… ClickHouse's own word.
    pub kind: String,
    pub started: String,
    /// When the row was written: the end of the statement, or — on the
    /// `QueryStart` row — its beginning again. Called `at` rather than
    /// `event_time` so the alias cannot shadow the column the same statement
    /// filters on; see `diagnostics::Run::at`.
    pub at: String,
    pub duration_ms: u64,
    pub user: String,
    pub query: String,
    pub database: String,
    pub tables: Vec<String>,
    pub columns: Vec<String>,
    /// Which projections answered it. Empty is the ordinary answer and does not
    /// mean the table has none — it means none was chosen.
    pub projections: Vec<String>,
    pub views: Vec<String>,
    /// Row policies that narrowed what this statement could see. The honest
    /// answer to "why did I get fewer rows than my colleague".
    pub row_policies: Vec<String>,
    pub read_rows: u64,
    pub read_bytes: u64,
    pub written_rows: u64,
    pub written_bytes: u64,
    pub result_rows: u64,
    pub result_bytes: u64,
    pub memory_usage: u64,
    /// The widest this statement ever ran. Zero on a version that does not
    /// record it, which the page reads as "not recorded" rather than as one
    /// thread.
    pub peak_threads: u64,
    /// `None`, `Write`, `Read` — whether the query cache was involved.
    pub query_cache: String,
    pub exception_code: i32,
    pub exception: String,
    /// Whether this statement came through Flint, read off the `log_comment`
    /// Flint stamps. The same test the audit trail uses, and worth stating on
    /// the page: a statement somebody ran in a terminal is honestly marked as
    /// not having come from here.
    pub via_flint: bool,
    pub log_comment: String,
    /// The shape this run belongs to, for the link back to its siblings.
    pub hash: String,
    /// Everything `ProfileEvents` held, by name.
    pub events: Vec<Counter>,
    /// What this statement ran with, **less what Flint attached to it**.
    ///
    /// `system.query_log` records the settings that differed from the profile,
    /// and on a statement Flint sent that list opens with Flint's own dozen —
    /// `max_execution_time`, `readonly`, `log_comment`. Presented as "what this
    /// statement ran with" they would be read as somebody's choice. The same
    /// subtraction the configuration page makes, for the same reason, against
    /// the same one list.
    pub settings: Vec<Setting>,
    /// How many were subtracted. Counted rather than hidden: a settings list
    /// that silently drops a third of itself is a list nobody can reconcile
    /// against `SHOW SETTINGS`.
    pub flint_settings: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatementReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// How far back the log was searched. Part of the answer when nothing is
    /// found: "no such statement" and "no such statement in the last 30 days"
    /// send somebody to different places.
    pub window_days: u64,
    pub statement: Option<Statement>,
    /// True where the only row is a `QueryStart` *and* the server still has it
    /// in `system.processes`. A start with nothing running is a statement whose
    /// ending never reached the log — the server was stopped, or the flush is
    /// still pending — and the two read identically without this.
    pub running: bool,
    pub stages: Section<Stage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape: Option<Shape>,
}

impl StatementReport {
    fn unavailable(days: u64, reason: impl Into<String>) -> Self {
        Self {
            available: false,
            reason: Some(reason.into()),
            window_days: days,
            statement: None,
            running: false,
            stages: Section::of(Vec::new()),
            shape: None,
        }
    }
}

/// A ClickHouse query id is whatever the client chose — Flint mints UUIDs, and
/// another tool may send `nightly-rollup-3`. So it is bounded and bound, never
/// validated into a shape: the same reasoning `diagnostics::kill` records, and
/// the same consequence — it reaches the server as a parameter and cannot
/// become SQL whatever it contains.
fn checked(query_id: &str) -> Result<String> {
    let id = query_id.trim();
    if id.is_empty() || id.len() > 256 {
        return Err(Error::BadRequest(
            "a query id is between 1 and 256 characters".into(),
        ));
    }
    Ok(id.to_string())
}

/// Everything the log kept about one statement.
pub async fn one(ch: &Client, query_id: &str, days: u64) -> Result<StatementReport> {
    let id = checked(query_id)?;
    let days = days.clamp(1, 90);
    if let Some(reason) = blocked(ch.reach("query_log").await?, "query_log") {
        return Ok(StatementReport::unavailable(days, reason));
    }

    // Five columns that arrived in different versions. `col_or` keeps one query
    // text working across them rather than branching the whole statement, and
    // the page reads an empty array as "this server does not record it".
    let projections = ch.col_or("query_log", "projections", "[]").await?;
    let views = ch.col_or("query_log", "views", "[]").await?;
    let policies = ch.col_or("query_log", "used_row_policies", "[]").await?;
    let threads = ch.col_or("query_log", "peak_threads_usage", "0").await?;
    let cache = ch
        .col_or("query_log", "query_cache_usage", "'Unknown'")
        .await?;

    #[derive(Deserialize)]
    struct Row {
        query_id: String,
        outcome: String,
        kind: String,
        started: String,
        at: String,
        duration_ms: u64,
        user: String,
        query: String,
        database: String,
        tables: Vec<String>,
        columns: Vec<String>,
        projections: Vec<String>,
        views: Vec<String>,
        row_policies: Vec<String>,
        read_rows: u64,
        read_bytes: u64,
        written_rows: u64,
        written_bytes: u64,
        result_rows: u64,
        result_bytes: u64,
        memory_usage: u64,
        peak_threads: u64,
        query_cache: String,
        exception_code: i32,
        exception: String,
        log_comment: String,
        hash: String,
        event_names: Vec<String>,
        event_values: Vec<u64>,
        setting_names: Vec<String>,
        setting_values: Vec<String>,
    }

    /* `ORDER BY event_time_microseconds DESC` rather than by `event_time`, and
    it is the same trap the backup log set: a statement writes its start and
    its finish rows in the *same second* whenever it is fast, so a sort on a
    `DateTime` picks between them arbitrarily and the page reports a finished
    query as one that never ended. Measured there at 2 ms apart.

    Newest rather than "the one that finished", because a query id belongs to
    whoever sent it and may be reused: two runs called `nightly-rollup-3` are
    two rows, and the most recent is the only defensible one to show. The page
    prints the timestamp, which is what makes that honest. */
    let sql = format!(
        "SELECT query_id                                     AS query_id, \
                toString(type)                               AS outcome, \
                toString(query_kind)                         AS kind, \
                toString(query_start_time)                   AS started, \
                toString(event_time)                         AS at, \
                toUInt64(query_duration_ms)                  AS duration_ms, \
                user                                         AS user, \
                query                                        AS query, \
                current_database                             AS database, \
                tables                                       AS tables, \
                columns                                      AS columns, \
                {projections}                                AS projections, \
                {views}                                      AS views, \
                {policies}                                   AS row_policies, \
                toUInt64(read_rows)                          AS read_rows, \
                toUInt64(read_bytes)                         AS read_bytes, \
                toUInt64(written_rows)                       AS written_rows, \
                toUInt64(written_bytes)                      AS written_bytes, \
                toUInt64(result_rows)                        AS result_rows, \
                toUInt64(result_bytes)                       AS result_bytes, \
                toUInt64(memory_usage)                       AS memory_usage, \
                toUInt64({threads})                          AS peak_threads, \
                toString({cache})                            AS query_cache, \
                toInt32(exception_code)                      AS exception_code, \
                exception                                    AS exception, \
                log_comment                                  AS log_comment, \
                toString(normalized_query_hash)              AS hash, \
                mapKeys(ProfileEvents)                       AS event_names, \
                mapValues(ProfileEvents)                     AS event_values, \
                mapKeys(Settings)                            AS setting_names, \
                mapValues(Settings)                          AS setting_values \
         FROM system.query_log \
         WHERE query_id = {{id:String}} \
           AND event_time > now() - INTERVAL {days} DAY \
         ORDER BY event_time_microseconds DESC \
         LIMIT 1"
    );

    let opts = QueryOptions {
        params: vec![("id".into(), id.clone())],
        quote_64bit_integers: false,
        introspection: true,
        ..Default::default()
    };
    let row: Option<Row> = ch.row_with(&sql, opts.clone()).await?;

    let Some(row) = row else {
        return Ok(StatementReport {
            available: true,
            reason: None,
            window_days: days,
            statement: None,
            running: false,
            stages: Section::of(Vec::new()),
            shape: None,
        });
    };

    let mut events: Vec<Counter> = row
        .event_names
        .into_iter()
        .zip(row.event_values)
        .map(|(name, value)| Counter { name, value })
        .collect();
    events.sort_by(|a, b| a.name.cmp(&b.name));

    let attached: BTreeMap<&str, ()> = ATTACHED_SETTINGS.iter().map(|n| (*n, ())).collect();
    let all_settings = row.setting_names.len();
    let settings: Vec<Setting> = row
        .setting_names
        .into_iter()
        .zip(row.setting_values)
        .filter(|(name, _)| !attached.contains_key(name.as_str()))
        .map(|(name, value)| Setting { name, value })
        .collect();
    let flint_settings = (all_settings - settings.len()) as u64;

    let unfinished = row.outcome == "QueryStart";
    let running = unfinished && still_running(ch, &id).await?;

    let statement = Statement {
        query_id: row.query_id,
        outcome: row.outcome,
        kind: row.kind,
        started: row.started,
        at: row.at,
        duration_ms: row.duration_ms,
        user: row.user,
        query: row.query,
        database: row.database,
        tables: row.tables,
        columns: row.columns,
        projections: row.projections,
        views: row.views,
        row_policies: row.row_policies,
        read_rows: row.read_rows,
        read_bytes: row.read_bytes,
        written_rows: row.written_rows,
        written_bytes: row.written_bytes,
        result_rows: row.result_rows,
        result_bytes: row.result_bytes,
        memory_usage: row.memory_usage,
        peak_threads: row.peak_threads,
        query_cache: row.query_cache,
        exception_code: row.exception_code,
        exception: row.exception,
        via_flint: row.log_comment.starts_with("flint"),
        log_comment: row.log_comment,
        hash: row.hash.clone(),
        events,
        settings,
        flint_settings,
    };

    let stages = stages(ch, &id).await?;
    let shape = shape(ch, &row.hash, days).await?;

    Ok(StatementReport {
        available: true,
        reason: None,
        window_days: days,
        statement: Some(statement),
        running,
        stages,
        shape,
    })
}

/// Whether the server still has this statement in flight.
///
/// Only asked where the log holds a start and no ending, which is the one case
/// the two possible answers differ in — *still going* and *the ending never got
/// written* look identical in `query_log` and want opposite things from the
/// reader. A denial here is not worth a section of its own: the page simply
/// does not claim it is running.
async fn still_running(ch: &Client, id: &str) -> Result<bool> {
    #[derive(Deserialize)]
    struct Probe {
        n: u64,
    }
    let probe: std::result::Result<Option<Probe>, Error> = ch
        .row_with(
            "SELECT toUInt64(count()) AS n FROM system.processes WHERE query_id = {id:String}",
            QueryOptions {
                params: vec![("id".into(), id.to_string())],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await;
    Ok(matches!(probe, Ok(Some(p)) if p.n > 0))
}

/// The per-operator figures, where this server records them at all.
async fn stages(ch: &Client, id: &str) -> Result<Section<Stage>> {
    match ch.reach("processors_profile_log").await? {
        Reach::Readable => {}
        Reach::Denied => {
            return Ok(Section::blocked(
                "this user is not granted SELECT on system.processors_profile_log".to_string(),
            ))
        }
        // The sentence names the configuration section rather than a setting,
        // because that is what is actually missing — see the module header.
        Reach::Absent | Reach::Unconfigured => {
            return Ok(Section::blocked(
                "this server keeps no system.processors_profile_log, so nothing records what each \
                 operator of the pipeline cost. It is a <processors_profile_log> section in the \
                 server's configuration, not a setting a statement can carry"
                    .to_string(),
            ))
        }
    }

    // The columns are checked before the read rather than after it, which is
    // the same courtesy every other reading here gives — and it matters more
    // here than anywhere, because this is the branch no run has ever
    // rendered: the table does not exist on the server Flint was built
    // against, so a column named wrongly would first be discovered by
    // somebody whose server does have it, as a page that 500s.
    let gaps = missing(
        ch,
        "processors_profile_log",
        &[
            "name",
            "elapsed_us",
            "input_rows",
            "input_bytes",
            "output_rows",
            "output_bytes",
        ],
    )
    .await?;
    if !gaps.is_empty() {
        return Ok(Section::blocked(format!(
            "this ClickHouse version's system.processors_profile_log has no {}",
            gaps.join(", ")
        )));
    }

    let rows: Vec<Stage> = ch
        .rows_with(
            "SELECT name                              AS name, \
                    toUInt64(sum(elapsed_us))         AS micros, \
                    toUInt64(sum(input_rows))         AS input_rows, \
                    toUInt64(sum(input_bytes))        AS input_bytes, \
                    toUInt64(sum(output_rows))        AS output_rows, \
                    toUInt64(sum(output_bytes))       AS output_bytes, \
                    toUInt64(count())                 AS processors \
             FROM system.processors_profile_log \
             WHERE query_id = {id:String} \
             GROUP BY name \
             ORDER BY micros DESC \
             LIMIT 40",
            QueryOptions {
                params: vec![("id".into(), id.to_string())],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;
    Ok(Section::of(rows))
}

/// What this statement's shape normally costs.
///
/// Absent rather than empty where the hash is zero: a statement the server
/// could not parse has no shape, and a panel comparing a run against "every
/// other statement with no shape" would be comparing it against the failures of
/// the whole window.
async fn shape(ch: &Client, hash: &str, days: u64) -> Result<Option<Shape>> {
    if hash.is_empty() || hash == "0" {
        return Ok(None);
    }
    #[derive(Deserialize)]
    struct Row {
        runs: u64,
        median_ms: f64,
        p95_ms: f64,
        max_ms: u64,
        failures: u64,
    }
    let row: Option<Row> = ch
        .row_with(
            &format!(
                "SELECT toUInt64(count())                                AS runs, \
                        quantileExact(0.5)(query_duration_ms)            AS median_ms, \
                        quantileExact(0.95)(query_duration_ms)           AS p95_ms, \
                        toUInt64(max(query_duration_ms))                 AS max_ms, \
                        toUInt64(countIf(exception_code != 0))           AS failures \
                 FROM system.query_log \
                 WHERE normalized_query_hash = toUInt64({{hash:String}}) \
                   AND type != 'QueryStart' \
                   AND event_time > now() - INTERVAL {days} DAY"
            ),
            QueryOptions {
                params: vec![("hash".into(), hash.to_string())],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;
    Ok(row.filter(|r| r.runs > 0).map(|r| Shape {
        hash: hash.to_string(),
        runs: r.runs,
        median_ms: r.median_ms,
        p95_ms: r.p95_ms,
        max_ms: r.max_ms,
        failures: r.failures,
        window_days: days,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_id_is_refused_before_it_reaches_the_server() {
        assert!(checked("   ").is_err());
        assert!(checked(&"x".repeat(257)).is_err());
    }

    #[test]
    fn an_id_that_is_not_a_uuid_is_accepted() {
        // Flint mints UUIDs; another tool may not, and those are exactly the
        // statements an operator most wants to look up.
        assert_eq!(checked(" nightly-rollup-3 ").unwrap(), "nightly-rollup-3");
    }
}
