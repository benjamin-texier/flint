//! What changed since you last looked.
//!
//! Every other report in this directory answers a question the reader arrived
//! with. This one answers the question nobody types, because it is the one you
//! have before you have a question: *is anything different today*. Flint
//! already measures the four things that make that question answerable — what
//! statements cost, what failed, what was reshaped, what was written — and
//! until now each of them lived on the page you had to already suspect.
//!
//! **The baseline is the log, not a snapshot.** Nothing here is stored and
//! nothing has to have been running yesterday for it to work: `system.query_log`
//! and `system.part_log` both carry their own history, so "different from usual"
//! is a read rather than a diff against something Flint kept. A Flint installed
//! ten minutes ago answers this as well as one installed a year ago — as far
//! back as the server's own retention, which is stated rather than assumed.
//!
//! **One window against the several behind it, not against yesterday.** A
//! single before-and-after pair cannot tell a daily ingest that stopped from a
//! one-off seed load that was never going to repeat, and it reads every Monday
//! as a collapse of Sunday. So the span is cut into `WINDOWS` equal periods, the
//! newest is the subject and the rest are the shape it is judged against. The
//! measurement stops there: this module returns the periods, and
//! `frontend/src/lib/news.ts` decides which movement is *news* — the thresholds
//! are the arguable part, and an argument belongs in a test file.
//!
//! **What it deliberately leaves out.** Flint's own traffic, by the
//! `log_comment` tag every internal statement carries; and the workspace
//! database, whose tables Flint creates and writes on your behalf — a board
//! that opens by announcing that Flint migrated its own `published` table is a
//! board nobody reads twice. Measured before it was written: on a development
//! server the ten most recent structure changes were all Flint's own
//! migrations.

use serde::{Deserialize, Serialize};

use super::diagnostics::{blocked, excluding_flint, missing};
use super::{Client, QueryOptions};
use crate::error::Result;

/// How many equal periods the span is cut into: the current one and the six
/// behind it. Six is enough for a median to mean something and short enough
/// that a day's window still fits inside a week of `query_log` retention, which
/// is the retention most servers actually have.
const WINDOWS: u64 = 7;

/// The prior periods as a fixed array, oldest last: `prior[0]` is the period
/// before this one, `prior[5]` the sixth.
///
/// A `groupArray` would be shorter to write and would lose the one thing that
/// makes the array usable — which period each figure came from. The reader at
/// the other end has to drop the periods the log does not wholly cover, and it
/// cannot drop what it cannot identify. Fixed positions also make an empty
/// period an explicit zero rather than an absence, which is the difference
/// between "nothing ran" and "we have no idea".
fn prior(value: &str) -> String {
    let cells: Vec<String> = (1..WINDOWS)
        .map(|k| format!("sumIf({value}, bucket = {k})"))
        .collect();
    format!("[{}]", cells.join(", "))
}

/// Databases whose contents are ClickHouse's own business. The same list
/// `diagnostics` uses, repeated rather than shared because it is a fact about
/// ClickHouse and not a setting either module owns.
const USER_DATABASES: &str =
    "database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')";

fn hours(asked: u64) -> u64 {
    asked.clamp(1, 24 * 30)
}

/// Seconds in one period, which every bucket expression divides by.
fn period_seconds(window_hours: u64) -> u64 {
    window_hours * 3600
}

/// Which period an event falls in: 0 is the window being judged, 1 and up are
/// the ones behind it.
///
/// `greatest(0, …)` is not defensive tidiness — a row whose `event_time` is
/// ahead of `now()` is ordinary on a server whose clock moved, and without the
/// clamp the `toUInt64` would wrap it into the far past and quietly credit the
/// oldest period with today's work.
fn bucket(seconds: u64) -> String {
    format!("intDiv(toUInt64(greatest(0, dateDiff('second', event_time, now()))), {seconds})")
}

/// How many *whole* prior periods a log actually spans.
///
/// The distinction matters more than it looks. A period the log only half
/// covers is not a quiet period, it is an unknown one, and averaging it in as
/// though it were zero manufactures a decline out of a retention limit. So a
/// period counts only when the log reaches past its far edge: the oldest entry
/// being `n` whole periods old covers periods 1 through `n - 1`.
fn covered(oldest_age_periods: u64) -> u64 {
    oldest_age_periods.saturating_sub(1).min(WINDOWS - 1)
}

// ── The wire ───────────────────────────────────────────────────────────────

/// The workload as a whole, so a single pattern's share can be worked out
/// against something rather than quoted alone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Totals {
    pub ms_now: u64,
    pub runs_now: u64,
    /// One entry per prior period, newest first: `prior_ms[0]` is the period
    /// before this one. Fixed length, so a quiet period is a zero in its own
    /// slot rather than a gap — and so the reader can drop the periods the log
    /// does not wholly cover, which it could not do from a packed array.
    pub prior_ms: Vec<u64>,
}

/// One statement pattern, this period against the periods behind it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostMove {
    pub hash: String,
    /// ClickHouse's own word — `Select`, `Insert`, `System`. Not filtered to
    /// selects the way the diagnose page's patterns are: an insert that has
    /// started costing ten times what it did is exactly the news this page
    /// exists for, and hiding it would be the diagnose page's editorial choice
    /// applied where it does not belong.
    pub kind: String,
    pub sample: String,
    pub tables: Vec<String>,
    pub ms_now: u64,
    pub runs_now: u64,
    pub users: u64,
    pub prior_ms: Vec<u64>,
    pub last_seen: String,
}

/// One exception code, this period against the periods behind it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureMove {
    pub code: i32,
    pub name: String,
    pub now: u64,
    pub prior: Vec<u64>,
    pub last_seen: String,
    pub message: String,
    pub sample: String,
}

/// One statement that reshaped something.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructureChange {
    pub at: String,
    pub user: String,
    /// `Create`, `Alter`, `Drop`, `Rename`.
    pub kind: String,
    /// Empty for a statement ClickHouse attributed to no table — a
    /// `CREATE DATABASE`, most often. Listed anyway, unlike an object's own
    /// history where there is nothing to attach it to: on a board about the
    /// server, a database appearing is news with or without a table to hang it
    /// on.
    pub tables: Vec<String>,
    pub statement: String,
    /// Recognised from the `query_id` Flint's job runner sets, so nothing extra
    /// is written to the log to make this work.
    pub through_flint: bool,
}

/// One table, by what was written into it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeMove {
    pub qualified: String,
    pub rows_now: u64,
    pub bytes_now: u64,
    /// Rows written in each prior period, newest first.
    pub prior_rows: Vec<u64>,
}

/// Writing is measured from a different table than everything else here, and
/// `part_log` is switched off on more servers than `query_log` is — so it
/// carries its own availability rather than taking the whole report down.
#[derive(Debug, Clone, Serialize)]
pub struct VolumeSection {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub prior_windows_covered: u64,
    pub tables: Vec<VolumeMove>,
}

impl VolumeSection {
    fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            available: false,
            reason: Some(reason.into()),
            prior_windows_covered: 0,
            tables: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct NewsReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub window_hours: u64,
    /// Periods in the span, the current one included.
    pub windows: u64,
    /// How many of the prior periods the log actually reaches over. Below three
    /// there is no shape to compare against and the reader is owed that fact
    /// rather than a confident sentence built on one sample.
    pub prior_windows_covered: u64,
    /// The oldest entry `system.query_log` still holds. The real reach of every
    /// comparison here, whatever was asked for.
    pub oldest: String,
    pub totals: Option<Totals>,
    pub cost: Vec<CostMove>,
    pub failures: Vec<FailureMove>,
    pub structure: Vec<StructureChange>,
    /// How many reshaping statements there were, which is not how many are
    /// listed. A list that stops at ten without saying so reads as the whole
    /// truth.
    pub structure_total: u64,
    pub volume: VolumeSection,
}

impl NewsReport {
    fn unavailable(window_hours: u64, reason: impl Into<String>) -> Self {
        Self {
            available: false,
            reason: Some(reason.into()),
            window_hours,
            windows: WINDOWS,
            prior_windows_covered: 0,
            oldest: String::new(),
            totals: None,
            cost: Vec::new(),
            failures: Vec::new(),
            structure: Vec::new(),
            structure_total: 0,
            volume: VolumeSection::unavailable(
                "there is nothing to compare writes against without the query log either",
            ),
        }
    }
}

// ── The measurement ────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct Reach {
    oldest: String,
    periods: u64,
}

/// What changed, over the last `window` hours and the six periods behind it.
pub async fn news(
    ch: &Client,
    window: u64,
    limit: u64,
    workspace: Option<&str>,
) -> Result<NewsReport> {
    let window_hours = hours(window);
    if let Some(reason) = blocked(ch.reach("query_log").await?, "query_log") {
        return Ok(NewsReport::unavailable(window_hours, reason));
    }
    let gaps = missing(
        ch,
        "query_log",
        &["query_kind", "normalized_query_hash", "exception_code"],
    )
    .await?;
    if !gaps.is_empty() {
        return Ok(NewsReport::unavailable(
            window_hours,
            format!(
                "this ClickHouse version's system.query_log has no {}",
                gaps.join(", ")
            ),
        ));
    }

    let limit = limit.clamp(1, 50);
    let secs = period_seconds(window_hours);
    let span = secs * WINDOWS;
    let ours = excluding_flint(ch).await?;
    let bucket = bucket(secs);
    let has_tables = ch.system_columns("query_log").await?.contains("tables");
    // `groupArray` is bounded at both levels: a pattern that ran a hundred
    // thousand times must not build a hundred-thousand-element array on the way
    // to answering "which tables does it touch".
    let inner_tables = if has_tables {
        "arrayDistinct(arrayFlatten(groupArray(5)(tables)))"
    } else {
        "[]"
    };

    let reach: Option<Reach> = ch
        .row_with(
            &format!(
                "SELECT toString(min(event_time))                        AS oldest, \
                        intDiv(toUInt64(greatest(0, dateDiff('second', min(event_time), now()))), \
                               {secs})                                   AS periods \
                 FROM system.query_log"
            ),
            QueryOptions::internal(),
        )
        .await?;
    let (oldest, spanned) = reach
        .map(|r| (r.oldest, r.periods))
        .unwrap_or_else(|| (String::new(), 0));

    let totals_prior = prior("ms");
    let cost_prior = prior("ms");
    let failure_prior = prior("n");
    let totals_sql = format!(
        "SELECT sumIf(ms, bucket = 0)                            AS ms_now, \
                sumIf(runs, bucket = 0)                          AS runs_now, \
                {totals_prior}                                   AS prior_ms \
         FROM ( \
           SELECT {bucket}                                       AS bucket, \
                  sum(query_duration_ms)                         AS ms, \
                  count()                                        AS runs \
           FROM system.query_log \
           WHERE type != 'QueryStart' \
             AND event_time > now() - INTERVAL {span} SECOND {ours}\
           GROUP BY bucket \
         )"
    );

    let cost_sql = format!(
        "SELECT hash                                             AS hash, \
                any(kind)                                        AS kind, \
                any(sample)                                      AS sample, \
                arrayDistinct(arrayFlatten(groupArray({WINDOWS})(tables))) AS tables, \
                sumIf(ms, bucket = 0)                            AS ms_now, \
                sumIf(runs, bucket = 0)                          AS runs_now, \
                max(users)                                       AS users, \
                {cost_prior}                                     AS prior_ms, \
                toString(max(last_seen))                         AS last_seen \
         FROM ( \
           SELECT toString(normalized_query_hash)                AS hash, \
                  {bucket}                                       AS bucket, \
                  toString(any(query_kind))                      AS kind, \
                  any(query)                                     AS sample, \
                  {inner_tables}                                 AS tables, \
                  sum(query_duration_ms)                         AS ms, \
                  count()                                        AS runs, \
                  uniqExact(user)                                AS users, \
                  max(event_time)                                AS last_seen \
           FROM system.query_log \
           WHERE type != 'QueryStart' \
             AND event_time > now() - INTERVAL {span} SECOND {ours}\
           GROUP BY hash, bucket \
         ) \
         GROUP BY hash \
         ORDER BY ms_now DESC \
         LIMIT {limit}"
    );

    // Grouped by what went wrong rather than by when, the way the diagnose
    // page's failures are: twenty rows of one exception say one thing, and the
    // question here is whether that one thing is new.
    let failures_sql = format!(
        "SELECT code                                             AS code, \
                any(name)                                        AS name, \
                sumIf(n, bucket = 0)                             AS now, \
                {failure_prior}                                  AS prior, \
                toString(max(last_seen))                         AS last_seen, \
                any(message)                                     AS message, \
                any(sample)                                      AS sample \
         FROM ( \
           SELECT exception_code                                 AS code, \
                  {bucket}                                       AS bucket, \
                  any(errorCodeToName(exception_code))           AS name, \
                  count()                                        AS n, \
                  max(event_time)                                AS last_seen, \
                  any(exception)                                 AS message, \
                  any(query)                                     AS sample \
           FROM system.query_log \
           WHERE type != 'QueryStart' \
             AND event_time > now() - INTERVAL {span} SECOND \
             AND exception_code != 0 {ours}\
           GROUP BY code, bucket \
         ) \
         GROUP BY code \
         ORDER BY now DESC \
         LIMIT {limit}"
    );

    // Only the current window, not the span: a `DROP` five days ago is history,
    // and history has its own tab on the object it happened to.
    let not_workspace = match workspace {
        Some(ws) => format!(
            "AND NOT arrayExists(t -> t LIKE '{}.%', tables) ",
            ws.replace('\'', "''")
        ),
        None => String::new(),
    };
    let structure_where = format!(
        "WHERE type != 'QueryStart' \
           AND event_time > now() - INTERVAL {secs} SECOND \
           AND query_kind IN ('Create', 'Alter', 'Drop', 'Rename') \
           AND exception_code = 0 {ours}\
           AND NOT arrayExists(t -> t LIKE 'system.%', tables) {not_workspace}"
    );
    let structure_sql = format!(
        "SELECT toString(event_time)                             AS at, \
                user                                             AS user, \
                toString(query_kind)                             AS kind, \
                arrayDistinct(tables)                            AS tables, \
                query                                            AS statement, \
                CAST(startsWith(query_id, 'flint-job-') AS Bool) AS through_flint \
         FROM system.query_log {structure_where}\
         ORDER BY event_time DESC \
         LIMIT {limit}"
    );
    let structure_count_sql =
        format!("SELECT count() AS n FROM system.query_log {structure_where}");

    let totals: Option<Totals> = ch.row_with(&totals_sql, QueryOptions::internal()).await?;
    let cost: Vec<CostMove> = ch.rows_with(&cost_sql, QueryOptions::internal()).await?;
    let failures: Vec<FailureMove> = ch
        .rows_with(&failures_sql, QueryOptions::internal())
        .await?;
    let structure: Vec<StructureChange> = ch
        .rows_with(&structure_sql, QueryOptions::internal())
        .await?;

    #[derive(Deserialize)]
    struct Counted {
        n: u64,
    }
    let structure_total = ch
        .row_with::<Counted>(&structure_count_sql, QueryOptions::internal())
        .await?
        .map(|c| c.n)
        .unwrap_or(0);

    Ok(NewsReport {
        available: true,
        reason: None,
        window_hours,
        windows: WINDOWS,
        prior_windows_covered: covered(spanned),
        oldest,
        totals,
        cost,
        failures,
        structure,
        structure_total,
        volume: volume(ch, secs, span, limit, workspace).await?,
    })
}

/// What was written, per table, over the same periods.
///
/// From `part_log`'s `NewPart` and nothing else. ClickHouse files a part made
/// by a merge under `MergeParts` and one fetched by a replica under
/// `DownloadPart`, so `NewPart` is as close to "somebody inserted this" as the
/// server records — which is why the wording everywhere downstream is *written*
/// rather than *grew*. A table whose rows all expired under a TTL wrote nothing
/// and shrank, and this cannot see that; storage can, and says so on its own
/// page.
async fn volume(
    ch: &Client,
    secs: u64,
    span: u64,
    limit: u64,
    workspace: Option<&str>,
) -> Result<VolumeSection> {
    if let Some(reason) = blocked(ch.reach("part_log").await?, "part_log") {
        return Ok(VolumeSection::unavailable(reason));
    }
    let gaps = missing(ch, "part_log", &["event_type", "rows", "size_in_bytes"]).await?;
    if !gaps.is_empty() {
        return Ok(VolumeSection::unavailable(format!(
            "this ClickHouse version's system.part_log has no {}",
            gaps.join(", ")
        )));
    }

    let bucket = bucket(secs);
    let volume_prior = prior("r");
    let not_workspace = match workspace {
        Some(ws) => format!("AND database != '{}' ", ws.replace('\'', "''")),
        None => String::new(),
    };

    let reach: Option<Reach> = ch
        .row_with(
            &format!(
                "SELECT toString(min(event_time))                        AS oldest, \
                        intDiv(toUInt64(greatest(0, dateDiff('second', min(event_time), now()))), \
                               {secs})                                   AS periods \
                 FROM system.part_log"
            ),
            QueryOptions::internal(),
        )
        .await?;

    let sql = format!(
        "SELECT qualified                                        AS qualified, \
                sumIf(r, bucket = 0)                             AS rows_now, \
                sumIf(b, bucket = 0)                             AS bytes_now, \
                {volume_prior}                                   AS prior_rows \
         FROM ( \
           SELECT concat(database, '.', table)                   AS qualified, \
                  {bucket}                                       AS bucket, \
                  sum(rows)                                      AS r, \
                  sum(size_in_bytes)                             AS b \
           FROM system.part_log \
           WHERE event_type = 'NewPart' \
             AND event_time > now() - INTERVAL {span} SECOND \
             AND {USER_DATABASES} {not_workspace}\
           GROUP BY qualified, bucket \
         ) \
         GROUP BY qualified \
         ORDER BY rows_now DESC, arraySum(prior_rows) DESC \
         LIMIT {limit}"
    );

    Ok(VolumeSection {
        available: true,
        reason: None,
        prior_windows_covered: covered(reach.map(|r| r.periods).unwrap_or(0)),
        tables: ch.rows_with(&sql, QueryOptions::internal()).await?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rule the whole comparison rests on: a period the log only half
    /// covers is unknown, not empty, so it does not count.
    #[test]
    fn a_partly_covered_period_is_not_counted() {
        // The log reaches back not even one whole period: nothing to compare.
        assert_eq!(covered(0), 0);
        // One whole period back covers period 0 — which is the subject, not a
        // baseline. Still nothing to compare against.
        assert_eq!(covered(1), 0);
        assert_eq!(covered(3), 2);
    }

    #[test]
    fn coverage_stops_at_the_periods_actually_asked_for() {
        // A log holding a year does not make the report span a year.
        assert_eq!(covered(400), WINDOWS - 1);
    }

    #[test]
    fn the_window_is_clamped_to_something_a_log_can_answer() {
        assert_eq!(hours(0), 1);
        assert_eq!(hours(24), 24);
        assert_eq!(hours(100_000), 24 * 30);
    }

    /// A clock that moved must not credit the oldest period with today's work.
    #[test]
    fn the_bucket_expression_clamps_events_from_the_future() {
        assert!(bucket(3600).contains("greatest(0,"));
    }
}
