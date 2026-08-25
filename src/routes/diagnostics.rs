use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;

use crate::clickhouse::diagnostics;
use crate::error::Result;

use super::AppState;

/// A window in days, because every diagnostic is "compared to when?".
#[derive(Deserialize)]
pub struct Window {
    #[serde(default = "default_days")]
    days: u64,
    #[serde(default = "default_limit")]
    limit: u64,
}

fn default_days() -> u64 {
    7
}

fn default_limit() -> u64 {
    40
}

pub async fn queries(
    State(state): State<AppState>,
    Query(w): Query<Window>,
) -> Result<Json<diagnostics::QueryReport>> {
    Ok(Json(
        diagnostics::queries(&state.ch, w.days, w.limit).await?,
    ))
}

pub async fn traffic(
    State(state): State<AppState>,
    Query(w): Query<Window>,
) -> Result<Json<diagnostics::TrafficReport>> {
    Ok(Json(
        diagnostics::traffic(
            &state.ch,
            w.days,
            w.limit,
            state.config.workspace_database.as_deref(),
        )
        .await?,
    ))
}

pub async fn storage(
    State(state): State<AppState>,
    Query(w): Query<Window>,
) -> Result<Json<diagnostics::StorageReport>> {
    Ok(Json(diagnostics::storage(&state.ch, w.limit).await?))
}

pub async fn api_usage(
    State(state): State<AppState>,
    Query(w): Query<Window>,
) -> Result<Json<diagnostics::UsageReport>> {
    Ok(Json(diagnostics::api_usage(&state.ch, w.days).await?))
}

pub async fn pipelines(
    State(state): State<AppState>,
    Query(w): Query<Window>,
) -> Result<Json<crate::clickhouse::pipelines::PipelineReport>> {
    Ok(Json(
        crate::clickhouse::pipelines::pipelines(&state.ch, w.days).await?,
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
    Json(input): Json<RefreshInput>,
) -> Result<Json<serde_json::Value>> {
    if state.config.readonly {
        return Err(crate::error::Error::BadRequest(
            "Flint is running read-only, so it will not refresh a view. Unset FLINT_READONLY, or run `SYSTEM REFRESH VIEW` yourself."
                .into(),
        ));
    }
    crate::clickhouse::pipelines::refresh(&state.ch, &input.database, &input.view).await?;
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
    State(state): State<AppState>,
    Json(input): Json<KillInput>,
) -> Result<Json<serde_json::Value>> {
    let status = diagnostics::kill(&state.ch, &input.query_id).await?;
    Ok(Json(serde_json::json!({
        "asked": input.query_id,
        // Empty means ClickHouse matched nothing: the query had already ended,
        // which is worth saying rather than reporting success.
        "status": status,
        "matched": !status.is_empty(),
    })))
}

pub async fn replication(
    State(state): State<AppState>,
) -> Result<Json<crate::clickhouse::diagnostics::ReplicationReport>> {
    Ok(Json(diagnostics::replication(&state.ch).await?))
}

pub async fn access(
    State(state): State<AppState>,
) -> Result<Json<crate::clickhouse::access::AccessReport>> {
    Ok(Json(crate::clickhouse::access::access(&state.ch).await?))
}

pub async fn activity(State(state): State<AppState>) -> Result<Json<diagnostics::ActivityReport>> {
    Ok(Json(diagnostics::activity(&state.ch).await?))
}
