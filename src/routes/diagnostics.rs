use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;

use crate::clickhouse::{backups, cluster, cold, diagnostics, health, news, parts, spend};
use crate::error::Result;

use super::{AppState, Caller};

/// A window in days, because every diagnostic is "compared to when?".
#[derive(Deserialize)]
pub struct Window {
    #[serde(default = "default_days")]
    days: u64,
    /// A window in seconds, which wins over `days` when it is given.
    ///
    /// One caller uses it: the checkup's traffic session, where somebody marks
    /// a moment and comes back. Nothing else has ever wanted a window finer
    /// than a day, so it is an option rather than a replacement.
    seconds: Option<u64>,
    #[serde(default = "default_limit")]
    limit: u64,
}

impl Window {
    fn span(&self) -> diagnostics::Span {
        match self.seconds {
            Some(n) => diagnostics::Span::seconds(n),
            None => diagnostics::Span::days(self.days),
        }
    }
}

fn default_days() -> u64 {
    7
}

fn default_limit() -> u64 {
    40
}

pub async fn queries(
    Caller(ch): Caller,
    Query(w): Query<Window>,
) -> Result<Json<diagnostics::QueryReport>> {
    Ok(Json(diagnostics::queries(&ch, w.span(), w.limit).await?))
}

pub async fn traffic(
    State(state): State<AppState>,
    Caller(ch): Caller,
    Query(w): Query<Window>,
) -> Result<Json<diagnostics::TrafficReport>> {
    Ok(Json(
        diagnostics::traffic(
            &ch,
            w.span(),
            w.limit,
            state.config.workspace_database.as_deref(),
        )
        .await?,
    ))
}

/// A window in hours, because "since you last looked" is a shorter unit than
/// every other diagnostic's, and a day asked for in days would be `days=1` —
/// which reads as a rounding rather than as the subject.
#[derive(Deserialize)]
pub struct Recent {
    #[serde(default = "default_hours")]
    hours: u64,
    #[serde(default = "default_limit")]
    limit: u64,
}

fn default_hours() -> u64 {
    24
}

/// What changed, over that window and the six behind it.
pub async fn what_changed(
    State(state): State<AppState>,
    Caller(ch): Caller,
    Query(w): Query<Recent>,
) -> Result<Json<news::NewsReport>> {
    Ok(Json(
        news::news(
            &ch,
            w.hours,
            w.limit,
            state.config.workspace_database.as_deref(),
        )
        .await?,
    ))
}

pub async fn storage(
    Caller(ch): Caller,
    Query(w): Query<Window>,
) -> Result<Json<diagnostics::StorageReport>> {
    Ok(Json(diagnostics::storage(&ch, w.limit).await?))
}

pub async fn api_usage(
    Caller(ch): Caller,
    Query(w): Query<Window>,
) -> Result<Json<diagnostics::UsageReport>> {
    Ok(Json(diagnostics::api_usage(&ch, w.days).await?))
}

pub async fn pipelines(
    Caller(ch): Caller,
    Query(w): Query<Window>,
) -> Result<Json<crate::clickhouse::pipelines::PipelineReport>> {
    Ok(Json(
        crate::clickhouse::pipelines::pipelines(&ch, w.days).await?,
    ))
}

#[derive(Deserialize)]
pub struct RefreshInput {
    database: String,
    view: String,
}

/// Telling a view to run now is an operation on their server, so read-only
/// mode refuses it — that flag is a promise Flint will not change their data,
/// and a refresh rewrites a table.
pub async fn refresh_view(
    State(state): State<AppState>,
    Caller(ch): Caller,
    Json(input): Json<RefreshInput>,
) -> Result<Json<serde_json::Value>> {
    if state.config.readonly {
        return Err(crate::error::Error::BadRequest(
            "Flint is running read-only, so it will not refresh a view. Unset FLINT_READONLY, or run `SYSTEM REFRESH VIEW` yourself."
                .into(),
        ));
    }
    crate::clickhouse::pipelines::refresh(&ch, &input.database, &input.view).await?;
    Ok(Json(
        serde_json::json!({ "refreshed": format!("{}.{}", input.database, input.view) }),
    ))
}

#[derive(Deserialize)]
pub struct KillInput {
    query_id: String,
}

/// Allowed under read-only, unlike a view refresh: read-only is a promise about
/// their data, and a KILL destroys none of it.
pub async fn kill(
    Caller(ch): Caller,
    Json(input): Json<KillInput>,
) -> Result<Json<serde_json::Value>> {
    let status = diagnostics::kill(&ch, &input.query_id).await?;
    Ok(Json(serde_json::json!({
        "asked": input.query_id,
        // Empty means ClickHouse matched nothing: the query had already ended,
        // which is worth saying rather than reporting success.
        "status": status,
        "matched": !status.is_empty(),
    })))
}

pub async fn replication(
    Caller(ch): Caller,
) -> Result<Json<crate::clickhouse::diagnostics::ReplicationReport>> {
    Ok(Json(diagnostics::replication(&ch).await?))
}

/// Who did what, and what the server said.
///
/// Under `diagnostics` with the rest of the reads over `system.*`, and behind
/// `Caller` like them: an audit answered from the manifest account would show
/// everybody the same trail, which is the opposite of what one is for.
pub async fn audit(
    State(state): State<AppState>,
    Caller(ch): Caller,
    Query(w): Query<Window>,
) -> Result<Json<crate::clickhouse::audit::AuditReport>> {
    Ok(Json(
        crate::clickhouse::audit::report(
            &ch,
            state.config.workspace_database.as_deref(),
            // Days, not the span: the trail has never wanted a window finer
            // than one, and the seconds are the checkup session's alone.
            w.days,
            w.limit,
        )
        .await?,
    ))
}

/// What the caller themselves may see.
///
/// Separate from `access`, which is the whole server's access model and belongs
/// to Infrastructure. This one is about the person asking, is read-only, and is
/// answerable for a user who cannot read a single access table — which is the
/// user who needs it.
pub async fn my_grants(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Caller(ch): Caller,
) -> Result<Json<crate::clickhouse::grants::MyGrants>> {
    let who = state.caller_name(&headers);
    Ok(Json(crate::clickhouse::grants::mine(&ch, &who).await?))
}

pub async fn access(Caller(ch): Caller) -> Result<Json<crate::clickhouse::access::AccessReport>> {
    Ok(Json(crate::clickhouse::access::access(&ch).await?))
}

/// Quotas, settings profiles and row policies — the other half of access.
///
/// Its own endpoint rather than a field on `/diagnostics/access`, because the
/// two are different system tables with different grants behind them: a role
/// that can list users often cannot list quotas, and losing one should not cost
/// the other.
pub async fn limits(Caller(ch): Caller) -> Result<Json<crate::clickhouse::limits::LimitsReport>> {
    Ok(Json(crate::clickhouse::limits::limits(&ch).await?))
}

/// The configuration this server is actually running with.
///
/// The list of settings Flint attaches is handed in from the client's own
/// constant, so this page cannot report Flint's timeout as the server's.
pub async fn settings(
    Caller(ch): Caller,
) -> Result<Json<crate::clickhouse::settings::SettingsReport>> {
    Ok(Json(
        crate::clickhouse::settings::settings(&ch, &crate::clickhouse::ATTACHED_SETTINGS).await?,
    ))
}

/// What the server is doing this second.
/// The Keeper this server talks to, and what it has been doing.
pub async fn keeper(
    Caller(ch): Caller,
    Query(w): Query<Window>,
) -> Result<Json<crate::clickhouse::cluster::KeeperReport>> {
    Ok(Json(
        crate::clickhouse::cluster::keeper(&ch, w.limit).await?,
    ))
}

/// Dictionaries, and whether they are actually working.
pub async fn dictionaries(
    Caller(ch): Caller,
) -> Result<Json<crate::clickhouse::dictionaries::DictionaryReport>> {
    Ok(Json(
        crate::clickhouse::dictionaries::dictionaries(&ch).await?,
    ))
}

/// Where a table's data is allowed to live.
pub async fn storage_policies(
    Caller(ch): Caller,
) -> Result<Json<crate::clickhouse::storage::StorageReport>> {
    Ok(Json(crate::clickhouse::storage::storage(&ch).await?))
}

#[derive(Debug, serde::Deserialize)]
pub struct Target {
    database: String,
    table: String,
}

/// What can be altered about this table, and what each change would cost it.
///
/// Per table because the cost is: "rewrites 400,000 rows across two parts" is a
/// sentence about a table, and "done means this replica only" is one about its
/// engine.
pub async fn alterations(
    Caller(ch): Caller,
    Query(t): Query<Target>,
) -> Result<Json<Vec<crate::clickhouse::alter::Offered>>> {
    let (parts, rows) = crate::clickhouse::meta::table_extent(&ch, &t.database, &t.table).await?;
    let engine = crate::clickhouse::meta::table_detail(&ch, &t.database, &t.table)
        .await?
        .summary
        .engine;
    Ok(Json(crate::clickhouse::alter::offered(
        rows,
        parts,
        engine.starts_with("Replicated"),
    )))
}

/// The skip indexes and projections of one table, and whether they hold
/// anything.
pub async fn derived(
    Caller(ch): Caller,
    Query(t): Query<Target>,
) -> Result<Json<crate::clickhouse::derived::DerivedReport>> {
    Ok(Json(
        crate::clickhouse::derived::derived(&ch, &t.database, &t.table).await?,
    ))
}

/// The `CREATE` the server holds for one object.
pub async fn definition(
    Caller(ch): Caller,
    Query(t): Query<Target>,
) -> Result<Json<serde_json::Value>> {
    let ddl = crate::clickhouse::meta::definition(&ch, &t.database, &t.table).await?;
    Ok(Json(serde_json::json!({ "ddl": ddl })))
}

#[derive(Debug, serde::Deserialize)]
pub struct TraceParams {
    /// `cpu` or `real`. Anything else reads as `cpu`, which is what somebody
    /// asking without saying almost always means.
    #[serde(default)]
    kind: String,
    #[serde(default = "fifteen")]
    minutes: u64,
}

fn fifteen() -> u64 {
    15
}

/// Where the processor actually went.
pub async fn trace(
    Caller(ch): Caller,
    Query(p): Query<TraceParams>,
) -> Result<Json<crate::clickhouse::trace::TraceReport>> {
    Ok(Json(
        crate::clickhouse::trace::trace(&ch, &p.kind, p.minutes, 25).await?,
    ))
}

pub async fn now(Caller(ch): Caller) -> Result<Json<crate::clickhouse::now::NowReport>> {
    Ok(Json(crate::clickhouse::now::now(&ch).await?))
}

pub async fn activity(Caller(ch): Caller) -> Result<Json<diagnostics::ActivityReport>> {
    Ok(Json(diagnostics::activity(&ch).await?))
}

// ── The cluster, seen from this node ───────────────────────────────────────
//
// Three routes rather than one, like the diagnostics next door: each of these
// tables is unavailable for its own reason on its own kind of server, and a
// page that loads them together loses all three when one of them is refused.

pub async fn topology(Caller(ch): Caller) -> Result<Json<cluster::Topology>> {
    Ok(Json(cluster::topology(&ch).await?))
}

pub async fn replication_queue(
    Caller(ch): Caller,
    Query(w): Query<Window>,
) -> Result<Json<cluster::QueueReport>> {
    Ok(Json(cluster::replication_queue(&ch, w.limit).await?))
}

pub async fn ddl_queue(
    Caller(ch): Caller,
    Query(w): Query<Window>,
) -> Result<Json<cluster::DdlReport>> {
    Ok(Json(cluster::ddl_queue(&ch, w.limit).await?))
}

// ── History ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct HistoryWindow {
    /// Hours back. Not days: a metric log holds a row a second, and nobody keeps
    /// a month of that.
    #[serde(default = "six")]
    hours: u64,
}

fn six() -> u64 {
    6
}

pub async fn series(
    Caller(ch): Caller,
    Query(w): Query<HistoryWindow>,
) -> Result<Json<health::SeriesReport>> {
    let hours = w.hours.clamp(1, 168);
    let step = health::step_for_hours(hours);
    Ok(Json(health::series(&ch, hours, step).await?))
}

#[derive(Deserialize)]
pub struct LogWindow {
    /// `error`, `warning`, `information`, `debug`, `trace` — this level and
    /// everything worse than it.
    #[serde(default = "warning")]
    level: String,
    #[serde(default = "two_hundred")]
    limit: u64,
}

fn warning() -> String {
    "warning".into()
}

fn two_hundred() -> u64 {
    200
}

pub async fn server_log(
    Caller(ch): Caller,
    Query(w): Query<LogWindow>,
) -> Result<Json<health::LogReport>> {
    Ok(Json(health::log(&ch, &w.level, w.limit).await?))
}

pub async fn errors(
    Caller(ch): Caller,
    Query(w): Query<HistoryWindow>,
) -> Result<Json<health::ErrorReport>> {
    let hours = w.hours.clamp(1, 168);
    Ok(Json(
        health::errors(&ch, hours, health::step_for_hours(hours)).await?,
    ))
}

pub async fn merges(
    Caller(ch): Caller,
    Query(w): Query<HistoryWindow>,
) -> Result<Json<health::MergeReport>> {
    let hours = w.hours.clamp(1, 168);
    Ok(Json(
        health::merges(&ch, hours, health::step_for_hours(hours), 20).await?,
    ))
}

pub async fn detached_parts(
    Caller(ch): Caller,
    Query(w): Query<Window>,
) -> Result<Json<parts::DetachedReport>> {
    Ok(Json(parts::detached(&ch, w.limit).await?))
}

/// The bytes this server is paying for and nothing has read.
///
/// Server-wide by default; `?database=` narrows it to one, which is how the
/// database page asks. See `clickhouse::cold` for what the answer may and may
/// not be read as — in particular that the window it covers is the log's, not
/// the one that was asked for.
pub async fn cold_bytes(
    Caller(ch): Caller,
    Query(w): Query<Window>,
    Query(scope): Query<Scope>,
) -> Result<Json<cold::ColdReport>> {
    Ok(Json(
        cold::cold(
            &ch,
            scope.database.as_deref(),
            w.days,
            w.limit,
            scope.floor_bytes.unwrap_or(cold::FLOOR_BYTES),
        )
        .await?,
    ))
}

/// Who this server has been working for.
///
/// The other half of `diagnostics::queries`: that one ranks statement shapes by
/// cost, which says *what* is expensive; this says *who* it was expensive for,
/// which is usually the more actionable of the two.
pub async fn spend_by_user(
    Caller(ch): Caller,
    Query(w): Query<Window>,
) -> Result<Json<spend::SpendReport>> {
    Ok(Json(spend::spend(&ch, w.days, w.limit).await?))
}

/// Which database a reading is about, where it may be about one or about all.
#[derive(Deserialize)]
pub struct Scope {
    database: Option<String>,
    /// Below this a table is not listed. Defaults to the module's own floor; a
    /// page about one table asks for none, because it is not choosing between
    /// tables and every cold column on the one in front of you is worth naming.
    floor_bytes: Option<u64>,
}

pub async fn schema_objects(
    Caller(ch): Caller,
    Query(w): Query<Window>,
) -> Result<Json<parts::SchemaReport>> {
    Ok(Json(parts::objects(&ch, w.limit).await?))
}

/// What this server has backed up, and what each backup was *of*.
///
/// The second half is not in `system.backups` — it records the destination and
/// not the source. Flint's own job rows have both, so the two are joined on the
/// `query_id` the job runner sets. Which means a backup somebody took in a
/// terminal shows up with a file and no target, and is honestly not offered a
/// restore: aiming it would mean guessing which table it held.
pub async fn backup_runs(
    State(state): State<AppState>,
    Caller(ch): Caller,
    Query(w): Query<Window>,
) -> Result<Json<backups::BackupReport>> {
    let disk = state.config.backup_disk.clone().unwrap_or_default();
    let mut report = backups::runs(&ch, &disk, w.limit).await?;

    // Read with Flint's own account, like the rest of the workspace: this is
    // Flint's bookkeeping about itself, and the run it describes already records
    // whose credentials took the backup.
    if let Some(ws) = state.workspace.as_ref() {
        let by_job: std::collections::HashMap<String, String> = ws
            .jobs(200)
            .await
            .unwrap_or_default()
            .into_iter()
            // Restores too, not only backups: Flint knows what it restored, and
            // showing "(unknown)" against a run it made itself would be Flint
            // pleading ignorance of its own work. Whether a row can be restored
            // *from* is decided by its status, separately.
            .filter(|j| j.kind == "backup" || j.kind == "restore")
            .map(|j| (j.id, j.target))
            .collect();
        backups::attach_targets(&mut report.runs, &by_job);
    }

    // Whether each target is there now, asked as the caller: a table this user
    // cannot see is one they should not be offered a restore into.
    let wanted: std::collections::HashSet<String> = report
        .runs
        .iter()
        .filter(|r| !r.target.is_empty())
        .map(|r| r.target.clone())
        .collect();
    if !wanted.is_empty() {
        let existing = present(&ch, &wanted).await?;
        backups::mark_existing(&mut report.runs, &existing);
    }

    Ok(Json(report))
}

/// Which of these `database.table` names exist right now.
async fn present(
    ch: &crate::clickhouse::Client,
    wanted: &std::collections::HashSet<String>,
) -> Result<std::collections::HashSet<String>> {
    #[derive(serde::Deserialize)]
    struct Row {
        qualified: String,
    }
    // Tables *and* databases, because a backup's target can be either now:
    // `BACKUP DATABASE scratch` records `scratch`, which has no dot in it, and a
    // check that only looked at `system.tables` found nothing and offered a
    // restore into a database that was there. The route refused it, so the cost
    // was a button that failed rather than a database overwritten — which is
    // still the thing this codebase does not do.
    let list: Vec<Row> = ch
        .rows_with(
            "SELECT concat(database, '.', name) AS qualified FROM system.tables \
             WHERE has({names:Array(String)}, concat(database, '.', name)) \
             UNION ALL \
             SELECT name AS qualified FROM system.databases \
             WHERE has({names:Array(String)}, name)",
            crate::clickhouse::QueryOptions {
                params: vec![(
                    "names".into(),
                    format!(
                        "[{}]",
                        wanted
                            .iter()
                            .map(|n| format!("'{}'", n.replace('\'', "\\'")))
                            .collect::<Vec<_>>()
                            .join(",")
                    ),
                )],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;
    Ok(list.into_iter().map(|r| r.qualified).collect())
}
