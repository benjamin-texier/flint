use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::clickhouse::{
    affinity, compare, connect, distribution, drift, graph, mass, meta, outside, probe, profile,
    projection, relations, review, streams, timeline, QueryOptions, TableResult,
};
use crate::error::{Error, Result};

use super::{AppState, Caller};

/// Liveness plus a single round-trip to ClickHouse, so `/api/health` failing
/// tells you the difference between "Flint is down" and "ClickHouse is down".
pub async fn health(State(state): State<AppState>) -> Json<Value> {
    #[derive(Deserialize)]
    struct Ping {
        #[allow(dead_code)]
        one: u8,
    }
    // Unpinned there is nothing to probe, and no claim is made rather than a
    // false one: `reachable: false` would read as "the database is down" and
    // take a perfectly healthy container out of rotation, when the truth is
    // that this Flint has no database of its own and each session has its own
    // answer. So the field is absent and `pinned` says why.
    let clickhouse = if state.config.pinned() {
        match state.ch.row::<Ping>("SELECT 1 AS one").await {
            Ok(_) => json!({ "pinned": true, "reachable": true }),
            Err(e) => json!({ "pinned": true, "reachable": false, "error": e.to_string() }),
        }
    } else {
        json!({ "pinned": false })
    };
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "clickhouse": clickhouse,
    }))
}

/// Everything the SPA needs to configure itself on boot.
pub async fn app_config(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        // Whether the manifest names the server. False means the browser does,
        // at sign-in — a different first screen, and a Flint with no workspace,
        // no schedule and no account of its own. Sent as a fact rather than
        // inferred from `endpoint` being null, because the UI branches on it
        // before it has anything to show.
        "pinned": state.config.pinned(),
        // Null unpinned: there is no endpoint until somebody names one, and the
        // one they named is on `/api/session` because it is theirs and not the
        // deployment's.
        "endpoint": state.config.redacted_endpoint(),
        // Likewise null: unpinned there is no account in the manifest, and
        // whoever is asking is on `/api/session`.
        "user": state.config.pinned().then(|| state.config.clickhouse_user.clone()),
        "default_database": state.config.clickhouse_database,
        "readonly": state.config.readonly,
        // Which of the two spaces exists, and what may be done inside them.
        // The UI hides what a tier does not permit rather than offering a
        // control that fails at click time.
        "tier": state.config.tier().as_str(),
        // Whether the browser has to sign somebody in before it can ask
        // anything. Here rather than only on /session because it is a fact
        // about the deployment, not about you.
        "auth": state.config.sign_in_required(),
        "infrastructure": state.config.infrastructure,
        "max_result_rows": state.config.max_result_rows,
        "query_timeout_secs": state.config.query_timeout_secs,
        // Null when Flint is stateless, so the UI can explain why saving is off
        // rather than offering a button that fails.
        "workspace": state.config.workspace_database,
        // So the alert form can say up front that a webhook will be recorded
        // but not sent, instead of leaving it to be discovered in the history.
        "alert_webhooks": state.config.alert_webhooks,
        // Which roles a published endpoint may be made to run as. Empty means
        // the form does not offer the control at all, rather than offering one
        // whose every value the server would refuse.
        "delegatable_roles": state.config.delegatable_roles,
        // What Flint attaches to every statement it sends. Shown in the editor
        // so the numbers in the stats strip are explainable rather than
        // mysterious — and the same names the configuration page subtracts from
        // `system.settings`, which is why `ATTACHED_SETTINGS` exists and this
        // object has to keep agreeing with it.
        "query_settings": {
            "max_execution_time": state.config.query_timeout_secs.to_string(),
            "max_result_rows": (state.config.max_result_rows + 1).to_string(),
            "result_overflow_mode": "break",
            "max_block_size": (state.config.max_result_rows + 1).clamp(1024, 65_505).to_string(),
            "wait_end_of_query": "1",
            "enable_http_compression": "1",
            "readonly": if state.config.readonly { "2" } else { "0" },
        },
        // The names the console may not carry, so it can refuse one at the
        // prompt rather than letting every statement after it fail. Composed
        // from the same list the route vets against — see
        // `routes::query::reserved_settings`.
        "reserved_settings": super::query::reserved_settings(),
    }))
}

pub async fn server(Caller(ch): Caller) -> Result<Json<meta::ServerInfo>> {
    Ok(Json(meta::server_info(&ch).await?))
}

pub async fn timezones(Caller(ch): Caller) -> Result<Json<Vec<String>>> {
    Ok(Json(meta::timezones(&ch).await?))
}

pub async fn databases(Caller(ch): Caller) -> Result<Json<Vec<meta::DatabaseSummary>>> {
    Ok(Json(meta::databases(&ch).await?))
}

pub async fn tables(
    Caller(ch): Caller,
    Path(database): Path<String>,
) -> Result<Json<Vec<meta::TableSummary>>> {
    Ok(Json(meta::tables(&ch, &database).await?))
}

pub async fn table_detail(
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
) -> Result<Json<meta::TableDetail>> {
    Ok(Json(meta::table_detail(&ch, &database, &table).await?))
}

#[derive(Debug, Deserialize)]
pub struct PreviewParams {
    #[serde(default = "default_preview_limit")]
    limit: u64,
}

fn default_preview_limit() -> u64 {
    100
}

/// First N rows of a table. Identifiers go through `{x:Identifier}` so a
/// table called `"; DROP …"` is quoted by ClickHouse rather than by us.
pub async fn table_preview(
    State(state): State<AppState>,
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
    Query(params): Query<PreviewParams>,
) -> Result<Json<TableResult>> {
    let limit = params.limit.clamp(1, state.config.max_result_rows);
    let result = ch
        .table(
            &format!("SELECT * FROM {{db:Identifier}}.{{tbl:Identifier}} LIMIT {limit}"),
            QueryOptions {
                params: vec![("db".into(), database), ("tbl".into(), table)],
                max_rows: Some(limit),
                ..Default::default()
            },
        )
        .await?;
    Ok(Json(result))
}

/// The database's objects and the edges between them, for the schema diagram.
pub async fn database_graph(
    Caller(ch): Caller,
    Path(database): Path<String>,
) -> Result<Json<graph::SchemaGraph>> {
    Ok(Json(graph::schema_graph(&ch, &database).await?))
}

#[derive(Debug, Deserialize)]
pub struct TimelineParams {
    /// How many tables the grid draws, biggest first. The default is the
    /// backend's; a caller asking for more gets clamped rather than refused.
    #[serde(default)]
    tables: Option<u64>,
    /// How wide a column is: the server's own partitions, or a scale of time.
    /// Defaulted rather than required, so the plain URL is the plain question.
    #[serde(default)]
    grain: timeline::Grain,
}

/// The database over time: every table against every partition it holds.
///
/// Its own endpoint rather than a field on the graph, because the two are
/// different questions asked of different system tables — and a role that cannot
/// read `system.parts` should lose this and keep the diagram.
pub async fn database_timeline(
    Caller(ch): Caller,
    Path(database): Path<String>,
    Query(params): Query<TimelineParams>,
) -> Result<Json<timeline::PartitionTimeline>> {
    Ok(Json(
        timeline::partition_timeline(
            &ch,
            timeline::Scope::Database(&database),
            params.tables,
            params.grain,
        )
        .await?,
    ))
}

/// Every database on the server against time — the one question the per-database
/// views cannot be asked, since each of them is scoped to one.
///
/// The same grid, with a database where a table was: "which of these is growing"
/// does not change shape when the things being asked about get bigger.
pub async fn server_timeline(
    Caller(ch): Caller,
    Query(params): Query<TimelineParams>,
) -> Result<Json<timeline::PartitionTimeline>> {
    Ok(Json(
        timeline::partition_timeline(&ch, timeline::Scope::Server, params.tables, params.grain)
            .await?,
    ))
}

/// What one column of a table says about another: constants, determinations and
/// mirrors, read out of the rows rather than out of the DDL.
pub async fn table_relations(
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
) -> Result<Json<relations::Relations>> {
    Ok(Json(relations::relations(&ch, &database, &table).await?))
}

/// Whether the table has started behaving differently: the same readings the
/// profile takes, cut into periods on the table's own time column, and the early
/// half of the window compared against the late half.
///
/// Separate from the profile rather than folded into it, because the two answer
/// different questions and fail in different ways: a profile of a table with no
/// date column is still the whole profile, and this one has nothing to say at
/// all — which it says.
pub async fn table_drift(
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
) -> Result<Json<drift::Drift>> {
    Ok(Json(drift::drift(&ch, &database, &table).await?))
}

/// What a `Kafka` or an `S3Queue` table's background reader is doing.
///
/// The engine is read here rather than taken from the caller: which of the two
/// system tables to open is decided by what the table *is*, and a client that
/// could name the reading could ask for a Kafka read of a MergeTree.
pub async fn table_stream(
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
) -> Result<Json<streams::StreamReport>> {
    let engine = crate::clickhouse::meta::table_engine(&ch, &database, &table).await?;
    Ok(Json(
        streams::stream(&ch, &database, &table, &engine).await?,
    ))
}

/// Every table on this server whose rows are not on it.
///
/// Data rather than Infrastructure, deliberately. It is read-only and it
/// answers a question about where the data comes from, which is the analyst's
/// as much as the operator's — and putting it under `/infra` would take it away
/// from every deployment that runs with the space switched off.
pub async fn outside_tables(Caller(ch): Caller) -> Result<Json<outside::Outside>> {
    Ok(Json(outside::outside(&ch).await?))
}

/// Whether the address an external table points at actually answers.
///
/// A POST, and a button behind it, because it opens a connection to somebody
/// else's infrastructure. Every other reading on that page comes out of
/// `system.*` on a server Flint is already talking to; this one does not, and a
/// page that contacts a production Postgres because a tab was opened is a page
/// nobody can leave open.
pub async fn table_connect(
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
) -> Result<Json<connect::Attempt>> {
    let engine = meta::table_engine(&ch, &database, &table).await?;
    Ok(Json(
        connect::attempt(&ch, &database, &table, &engine).await?,
    ))
}

/// Two tables, side by side: both column lists and both storage settings, in one
/// answer. Which of the differences matter is decided in the frontend.
pub async fn compare_tables(
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
    Query(against): Query<AgainstParams>,
) -> Result<Json<compare::Comparison>> {
    let (other_db, other_table) = match against.with.split_once('.') {
        Some((d, t)) if !d.is_empty() && !t.is_empty() => (d.to_string(), t.to_string()),
        // Unqualified means the same database, which is the common case and the
        // one somebody types.
        _ => (database.clone(), against.with.clone()),
    };
    Ok(Json(
        compare::compare(&ch, (&database, &table), (&other_db, &other_table)).await?,
    ))
}

#[derive(serde::Deserialize)]
pub struct AgainstParams {
    /// `database.table`, or just `table` for one in the same database.
    pub with: String,
}

/// The shape of one column: how its rows fall across its values.
///
/// One column at a time, because each needs its own range before it can be
/// binned — the profile's single pass can produce five numbers for every column
/// at once and cannot produce this for any of them.
pub async fn column_distribution(
    Caller(ch): Caller,
    Path((database, table, column)): Path<(String, String, String)>,
) -> Result<Json<distribution::Distribution>> {
    Ok(Json(
        distribution::distribution(&ch, &database, &table, &column).await?,
    ))
}

/// The database as proportion: where its disk is, down to the column.
///
/// Separate from the timeline for the same reason that one is separate from the
/// graph — a different system table, a different way of being unavailable, and a
/// role that loses one should keep the others.
pub async fn database_mass(
    Caller(ch): Caller,
    Path(database): Path<String>,
    Query(params): Query<TimelineParams>,
) -> Result<Json<mass::MassReport>> {
    Ok(Json(
        mass::column_mass(&ch, &database, params.tables).await?,
    ))
}

#[derive(Debug, Deserialize)]
pub struct AffinityParams {
    /// The window, in days. Defaulted here rather than in the client so a
    /// bookmarked URL and a fresh page ask the same question.
    #[serde(default = "default_affinity_days")]
    days: u32,
    #[serde(default)]
    tables: Option<u64>,
}

fn default_affinity_days() -> u32 {
    7
}

/// Which tables get read in the same statement — the coupling the schema never
/// declared, read out of `system.query_log`.
pub async fn database_affinity(
    Caller(ch): Caller,
    Path(database): Path<String>,
    Query(params): Query<AffinityParams>,
) -> Result<Json<affinity::AffinityReport>> {
    Ok(Json(
        affinity::co_access(&ch, &database, params.days, params.tables).await?,
    ))
}

#[derive(Debug, Deserialize)]
pub struct ProfileParams {
    /// Cap on rows scanned. Past it the profile reads a prefix and says so.
    #[serde(default)]
    scan_limit: Option<u64>,
}

/// What is in a table: nulls, distinct counts, ranges, most common values.
pub async fn table_profile(
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
    Query(params): Query<ProfileParams>,
) -> Result<Json<profile::TableProfile>> {
    let detail = meta::table_detail(&ch, &database, &table).await?;
    let rows = detail
        .summary
        .total_rows
        .unwrap_or(detail.summary.parts_rows);
    Ok(Json(
        profile::profile(
            &ch,
            &database,
            &table,
            &detail.columns,
            rows,
            params.scan_limit,
        )
        .await?,
    ))
}

#[derive(Debug, Deserialize)]
pub struct ReviewParams {
    /// Read every row rather than a prefix. The difference between a hypothesis
    /// and a verdict, and between a free query and a full scan — so it is asked
    /// for explicitly and never the default.
    #[serde(default)]
    verify: bool,
}

/// Whether this table's column types suit the data in it.
pub async fn table_review(
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
    Query(params): Query<ReviewParams>,
) -> Result<Json<review::SchemaReview>> {
    let detail = meta::table_detail(&ch, &database, &table).await?;
    let rows = detail
        .summary
        .total_rows
        .unwrap_or(detail.summary.parts_rows);
    Ok(Json(
        review::review(
            &ch,
            review::Subject {
                database: &database,
                table: &table,
                columns: &detail.columns,
                engine: &detail.summary.engine,
                sorting_key: &detail.summary.sorting_key,
                partition_key: &detail.summary.partition_key,
                total_rows: rows,
            },
            params.verify,
        )
        .await?,
    ))
}

/// Weigh a proposed type change against the column it would replace.
///
/// A POST because it writes: a scratch table in Flint's own database, filled
/// from the rows being weighed and dropped again. It never touches the table
/// under review.
pub async fn table_probe(
    State(state): State<AppState>,
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
    Json(request): Json<probe::Request>,
) -> Result<Json<probe::Outcome>> {
    let workspace = state.config.workspace_database.as_deref().ok_or_else(|| {
        crate::error::Error::BadRequest(
            "Flint is running without a workspace, so it has nowhere to write the scratch \
             table that weighing a type change needs. Set FLINT_WORKSPACE_DATABASE."
                .into(),
        )
    })?;
    Ok(Json(
        probe::probe(&ch, workspace, &database, &table, &request).await?,
    ))
}

#[derive(Debug, Deserialize)]
pub struct AdviceParams {
    /// How far back to read the workload. The default is a week: long enough to
    /// catch a report that runs on Mondays, short enough that "nothing asks
    /// this of the table" still means something.
    #[serde(default)]
    days: Option<u64>,
}

/// What the workload asks of one table, against what the table is sorted by.
///
/// A read, and only a read — every figure here is one ClickHouse already had.
/// What it *means*, and which projection would follow, is decided in the
/// browser where the rules have tests.
pub async fn table_projections(
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
    Query(params): Query<AdviceParams>,
) -> Result<Json<projection::Advice>> {
    Ok(Json(
        projection::advice(&ch, &database, &table, params.days.unwrap_or(7)).await?,
    ))
}

/// Count what a proposed projection key would actually come out at.
///
/// A POST because it is a scan, not because it writes — it writes nothing. It
/// reads every row of the columns in the proposed key, which is the only way to
/// know how many distinct values are behind it, and therefore how many rows an
/// aggregate projection over it would hold. That is a cost somebody agrees to
/// by pressing a button, never one a page opening incurs on its own.
pub async fn measure_projection(
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
    Json(request): Json<projection::MeasureRequest>,
) -> Result<Json<projection::Measurement>> {
    Ok(Json(
        projection::measure(&ch, &database, &table, &request).await?,
    ))
}

/// Which tables in a database the workload argues about, heaviest first.
///
/// The question that comes before opening any single table's Projections tab.
/// Three reads for the whole database rather than one per table, and the
/// per-table advisor does the real work on whichever one gets opened.
pub async fn database_projections(
    Caller(ch): Caller,
    Path(database): Path<String>,
    Query(params): Query<AdviceParams>,
) -> Result<Json<projection::DatabaseAdvice>> {
    Ok(Json(
        projection::database_advice(&ch, &database, params.days.unwrap_or(7)).await?,
    ))
}

/// Build what an aggregate projection would hold, weigh it, and drop it.
///
/// The one endpoint in this feature that writes, and it writes only to Flint's
/// own workspace. It is separate from `measure` — which writes nothing and says
/// so — because the two are different prices and a reader should agree to them
/// one at a time: counting the groups answers whether the projection helps,
/// and building them answers what it costs.
pub async fn weigh_projection(
    State(state): State<AppState>,
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
    Json(request): Json<projection::WeighRequest>,
) -> Result<Json<projection::Weight>> {
    let workspace = state.config.workspace_database.as_deref().ok_or_else(|| {
        Error::BadRequest(
            "Flint is running without a workspace, so it has nowhere to write the scratch table              that weighing a projection needs. The row count still stands — it is the bytes that              cannot be had here. Set FLINT_WORKSPACE_DATABASE."
                .into(),
        )
    })?;
    Ok(Json(
        projection::weigh(&ch, workspace, &database, &table, &request).await?,
    ))
}

#[derive(Debug, Deserialize)]
pub struct ReadersParams {
    column: String,
    #[serde(default)]
    days: Option<u32>,
    #[serde(default)]
    limit: Option<u32>,
}

/// The queries that read one column, so "is it filtered on?" is answered by
/// looking rather than by guessing.
pub async fn column_readers(
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
    Query(params): Query<ReadersParams>,
) -> Result<Json<review::Readers>> {
    Ok(Json(
        review::readers(
            &ch,
            &database,
            &table,
            &params.column,
            params.days.unwrap_or(7),
            params.limit.unwrap_or(5),
        )
        .await?,
    ))
}

#[derive(Debug, Deserialize)]
pub struct CodecRequest {
    pub column: String,
    #[serde(default)]
    pub rows: Option<u64>,
}

/// Weigh the codecs worth trying on one column.
///
/// The candidates are the server's to choose — a codec expression reaches a
/// CREATE TABLE — so the request names a column and nothing else.
pub async fn column_codecs(
    State(state): State<AppState>,
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
    Json(request): Json<CodecRequest>,
) -> Result<Json<probe::CodecOutcome>> {
    let workspace = state.config.workspace_database.as_deref().ok_or_else(|| {
        crate::error::Error::BadRequest(
            "Flint is running without a workspace, so it has nowhere to write the scratch \
             table that weighing a codec needs. Set FLINT_WORKSPACE_DATABASE."
                .into(),
        )
    })?;
    Ok(Json(
        probe::weigh_codecs(
            &ch,
            workspace,
            &database,
            &table,
            &request.column,
            request.rows,
        )
        .await?,
    ))
}

#[derive(Debug, Deserialize)]
pub struct HeavyParams {
    #[serde(default)]
    limit: Option<u32>,
}

/// Where a database's disk is, one column at a time — the question that comes
/// before opening any single table's review.
pub async fn database_heavy(
    Caller(ch): Caller,
    Path(database): Path<String>,
    Query(params): Query<HeavyParams>,
) -> Result<Json<review::Heavy>> {
    Ok(Json(
        review::heavy(&ch, &database, params.limit.unwrap_or(30)).await?,
    ))
}

pub async fn schema(Caller(ch): Caller) -> Result<Json<Vec<meta::SchemaEntry>>> {
    Ok(Json(meta::schema(&ch).await?))
}

#[derive(Debug, Deserialize)]
pub struct HistoryParams {
    #[serde(default = "default_history_limit")]
    limit: u64,
}

fn default_history_limit() -> u64 {
    200
}

pub async fn history(
    Caller(ch): Caller,
    Query(params): Query<HistoryParams>,
) -> Result<Json<Value>> {
    Ok(Json(match meta::history(&ch, params.limit).await? {
        meta::History::Available { entries } => json!({ "available": true, "entries": entries }),
        meta::History::Unavailable { reason } => {
            json!({ "available": false, "entries": [], "reason": reason })
        }
    }))
}

/// Small helper used by the query route as well.
pub fn require_non_empty(sql: &str) -> Result<()> {
    if sql.trim().is_empty() {
        return Err(Error::BadRequest("the statement is empty".into()));
    }
    Ok(())
}

/// What a drop would break, and what it would lose.
///
/// A read, and on the Data side of the product: "what depends on this" is a
/// question somebody asks while exploring, long before anybody wants to delete
/// anything. It becomes the confirmation for a drop rather than existing only as
/// one.
pub async fn table_impact(
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
) -> Result<Json<graph::Impact>> {
    Ok(Json(graph::impact(&ch, &database, &table).await?))
}

#[derive(Debug, Deserialize)]
pub struct ChangeParams {
    #[serde(default = "thirty")]
    days: u64,
}

fn thirty() -> u64 {
    30
}

/// How this object's structure came to be what it is.
pub async fn table_changes(
    Caller(ch): Caller,
    Path((database, table)): Path<(String, String)>,
    Query(params): Query<ChangeParams>,
) -> Result<Json<meta::ChangeReport>> {
    Ok(Json(
        meta::changes(&ch, &database, &table, params.days.clamp(1, 3650)).await?,
    ))
}
