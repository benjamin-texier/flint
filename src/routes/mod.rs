mod check;
mod data;
mod diagnostics;
mod explorer;
mod query;
mod saved;
mod spa;

use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use tower_http::compression::CompressionLayer;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::clickhouse::Client;
use crate::config::Config;
use crate::workspace::Workspace;

#[derive(Clone)]
pub struct AppState {
    pub ch: Client,
    pub config: Arc<Config>,
    /// Present only when a workspace database is configured.
    pub workspace: Option<Workspace>,
    /// The same scheduler that runs reports on their schedule, so a run asked
    /// for by hand goes through exactly one implementation of "run a report".
    /// `None` without a workspace, which is also when there are no reports.
    pub runner: Option<crate::alerts::Scheduler>,
}

/// Shared with the workspace, which validates the same shape on the save path.
pub use saved::valid_uuid as is_uuid;

pub fn router(state: AppState) -> Router {
    let cors = match &state.config.cors_origin {
        Some(origin) => CorsLayer::new()
            .allow_origin(
                origin
                    .parse::<axum::http::HeaderValue>()
                    .expect("FLINT_CORS_ORIGIN must be a valid origin"),
            )
            .allow_methods(Any)
            .allow_headers(Any)
            // What a published answer says in its headers, said again here:
            // without this a cross-origin caller reads the body and none of
            // the paging, which for CSV and NDJSON is all of it.
            .expose_headers(
                crate::published::TOLD_HEADERS
                    .iter()
                    .map(|name| axum::http::HeaderName::from_static(name))
                    .collect::<Vec<_>>(),
            ),
        // Same-origin only: the SPA is served from this very process.
        None => CorsLayer::new(),
    };

    let api = Router::new()
        .route("/health", get(explorer::health))
        .route("/config", get(explorer::app_config))
        .route("/server", get(explorer::server))
        .route("/databases", get(explorer::databases))
        .route("/databases/{database}/tables", get(explorer::tables))
        .route("/databases/{database}/graph", get(explorer::database_graph))
        .route(
            "/databases/{database}/tables/{table}",
            get(explorer::table_detail),
        )
        .route(
            "/databases/{database}/tables/{table}/preview",
            get(explorer::table_preview),
        )
        .route(
            "/databases/{database}/tables/{table}/profile",
            get(explorer::table_profile),
        )
        .route("/schema", get(explorer::schema))
        .route("/history", get(explorer::history))
        .route("/diagnostics/queries", get(diagnostics::queries))
        .route("/diagnostics/traffic", get(diagnostics::traffic))
        .route("/diagnostics/storage", get(diagnostics::storage))
        .route("/diagnostics/activity", get(diagnostics::activity))
        .route("/diagnostics/api-usage", get(diagnostics::api_usage))
        .route("/diagnostics/pipelines", get(diagnostics::pipelines))
        .route("/diagnostics/access", get(diagnostics::access))
        .route("/diagnostics/replication", get(diagnostics::replication))
        .route("/pipelines/refresh", post(diagnostics::refresh_view))
        .route("/diagnostics/kill", post(diagnostics::kill))
        .route("/query", post(query::run))
        .route("/format", post(query::format))
        // Runs a statement the way the scheduler will — read-only, capped — so
        // nothing gets armed untested.
        .route("/check", post(check::check))
        .route("/saved-queries", get(saved::list).post(saved::save))
        .route("/saved-queries/{id}", axum::routing::delete(saved::remove))
        .route(
            "/dashboards",
            get(saved::dashboards).post(saved::save_dashboard),
        )
        .route(
            "/dashboards/{id}",
            axum::routing::delete(saved::remove_dashboard),
        )
        .route("/alerts", get(saved::alerts).post(saved::save_alert))
        .route("/alerts/{id}", axum::routing::delete(saved::remove_alert))
        .route("/alert-events", get(saved::alert_events))
        .route("/reports", get(saved::reports).post(saved::save_report))
        .route("/reports/{id}", axum::routing::delete(saved::remove_report))
        .route("/reports/{id}/run", post(saved::run_report_now))
        .route("/report-runs", get(saved::report_runs))
        .route("/report-runs/{run_id}", get(saved::report_snapshot))
        .route(
            "/published",
            get(saved::published).post(saved::save_published),
        )
        .route(
            "/published/{id}",
            axum::routing::delete(saved::remove_published),
        )
        // Every published endpoint in one document, for whoever runs this
        // Flint rather than whoever calls one of them.
        .route("/published/openapi.json", get(data::openapi_index))
        // The published face. Under /api/data/ so it never collides with
        // Flint's own routes, and so a reverse proxy can expose just this.
        .route("/data/{slug}", get(data::serve))
        // The endpoint, describing itself: parameters, columns, the operators
        // each column takes, the page it serves. Behind the same token as the
        // data, because a schema is a map of the data.
        .route("/data/{slug}/schema", get(data::describe_endpoint))
        // The same facts in the shape every other tool reads.
        .route("/data/{slug}/openapi.json", get(data::openapi_document))
        .route("/query/{query_id}/cancel", post(query::cancel));

    Router::new()
        .nest("/api", api)
        .fallback(spa::serve)
        .layer(CompressionLayer::new())
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
