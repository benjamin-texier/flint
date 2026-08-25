use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::clickhouse::{graph, meta, profile, QueryOptions, TableResult};
use crate::error::{Error, Result};

use super::AppState;

/// Liveness plus a single round-trip to ClickHouse, so `/api/health` failing
/// tells you the difference between "Flint is down" and "ClickHouse is down".
pub async fn health(State(state): State<AppState>) -> Json<Value> {
    #[derive(Deserialize)]
    struct Ping {
        #[allow(dead_code)]
        one: u8,
    }
    let clickhouse = match state.ch.row::<Ping>("SELECT 1 AS one").await {
        Ok(_) => json!({ "reachable": true }),
        Err(e) => json!({ "reachable": false, "error": e.to_string() }),
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
        "endpoint": state.config.redacted_endpoint(),
        "user": state.config.clickhouse_user,
        "default_database": state.config.clickhouse_database,
        "readonly": state.config.readonly,
        // Which of the two spaces exists, and what may be done inside them.
        // The UI hides what a tier does not permit rather than offering a
        // control that fails at click time.
        "tier": state.config.tier().as_str(),
        "infrastructure": state.config.infrastructure,
        "max_result_rows": state.config.max_result_rows,
        "query_timeout_secs": state.config.query_timeout_secs,
        // Null when Flint is stateless, so the UI can explain why saving is off
        // rather than offering a button that fails.
        "workspace": state.config.workspace_database,
        // So the alert form can say up front that a webhook will be recorded
        // but not sent, instead of leaving it to be discovered in the history.
        "alert_webhooks": state.config.alert_webhooks,
        // What Flint attaches to every statement it sends. Shown in the editor
        // so the numbers in the stats strip are explainable rather than
        // mysterious.
        "query_settings": {
            "max_execution_time": state.config.query_timeout_secs.to_string(),
            "max_result_rows": (state.config.max_result_rows + 1).to_string(),
            "result_overflow_mode": "break",
            "max_block_size": (state.config.max_result_rows + 1).clamp(1024, 65_505).to_string(),
            "wait_end_of_query": "1",
            "enable_http_compression": "1",
            "readonly": if state.config.readonly { "2" } else { "0" },
        },
    }))
}

pub async fn server(State(state): State<AppState>) -> Result<Json<meta::ServerInfo>> {
    Ok(Json(meta::server_info(&state.ch).await?))
}

pub async fn databases(State(state): State<AppState>) -> Result<Json<Vec<meta::DatabaseSummary>>> {
    Ok(Json(meta::databases(&state.ch).await?))
}

pub async fn tables(
    State(state): State<AppState>,
    Path(database): Path<String>,
) -> Result<Json<Vec<meta::TableSummary>>> {
    Ok(Json(meta::tables(&state.ch, &database).await?))
}

pub async fn table_detail(
    State(state): State<AppState>,
    Path((database, table)): Path<(String, String)>,
) -> Result<Json<meta::TableDetail>> {
    Ok(Json(
        meta::table_detail(&state.ch, &database, &table).await?,
    ))
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
    Path((database, table)): Path<(String, String)>,
    Query(params): Query<PreviewParams>,
) -> Result<Json<TableResult>> {
    let limit = params.limit.clamp(1, state.config.max_result_rows);
    let result = state
        .ch
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
    State(state): State<AppState>,
    Path(database): Path<String>,
) -> Result<Json<graph::SchemaGraph>> {
    Ok(Json(graph::schema_graph(&state.ch, &database).await?))
}

#[derive(Debug, Deserialize)]
pub struct ProfileParams {
    /// Cap on rows scanned. Past it the profile reads a prefix and says so.
    #[serde(default)]
    scan_limit: Option<u64>,
}

/// What is in a table: nulls, distinct counts, ranges, most common values.
pub async fn table_profile(
    State(state): State<AppState>,
    Path((database, table)): Path<(String, String)>,
    Query(params): Query<ProfileParams>,
) -> Result<Json<profile::TableProfile>> {
    let detail = meta::table_detail(&state.ch, &database, &table).await?;
    let rows = detail
        .summary
        .total_rows
        .unwrap_or(detail.summary.parts_rows);
    Ok(Json(
        profile::profile(
            &state.ch,
            &database,
            &table,
            &detail.columns,
            rows,
            params.scan_limit,
        )
        .await?,
    ))
}

pub async fn schema(State(state): State<AppState>) -> Result<Json<Vec<meta::SchemaEntry>>> {
    Ok(Json(meta::schema(&state.ch).await?))
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
    State(state): State<AppState>,
    Query(params): Query<HistoryParams>,
) -> Result<Json<Value>> {
    Ok(Json(match meta::history(&state.ch, params.limit).await? {
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
