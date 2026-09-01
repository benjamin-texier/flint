mod check;
mod data;
mod dataset;
mod diagnostics;
mod explorer;
mod jobs;
mod query;
mod rows;
mod saved;
mod session;
mod spa;

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::routing::{get, post};
use axum::Router;
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};
use tower_http::compression::CompressionLayer;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::auth::{self, Sessions};
use crate::clickhouse::Client;
use crate::config::{Config, Tier};
use crate::error::{Error, Result};
use crate::workspace::Workspace;

#[derive(Clone)]
pub struct AppState {
    /// Flint's own connection, as the account in the manifest.
    ///
    /// It is what the workspace, the scheduler and the health probe use — none
    /// of which belongs to anybody signing in. On an unpinned Flint it points
    /// nowhere, which is exactly right: there is no account in the manifest and
    /// none of those three exists. `client_for` never returns it there, because
    /// unpinned implies signing in.
    pub ch: Client,
    pub config: Arc<Config>,
    /// Present only when a workspace database is configured.
    pub workspace: Option<Workspace>,
    /// The same scheduler that runs reports on their schedule, so a run asked
    /// for by hand goes through exactly one implementation of "run a report".
    /// `None` without a workspace, which is also when there are no reports.
    pub runner: Option<crate::alerts::Scheduler>,
    /// Who is signed in, where signing in is required. Empty and unused
    /// otherwise.
    pub sessions: Sessions,
    /// How many addresses this process will be dialling at once on behalf of
    /// nobody.
    ///
    /// `/api/login` has to open a socket before it can know whether the caller is
    /// anybody, and on an unpinned Flint the *caller* chooses where. That is one
    /// outbound connection per unauthenticated request, to an address of their
    /// choosing. The connect timeout bounds what one attempt costs; this bounds
    /// how many are outstanding.
    ///
    /// What it actually buys, measured rather than assumed, because the obvious
    /// claim for it is wrong. Twenty parallel sign-ins at an address that *hangs*
    /// (a dropped packet, not a refusal): eight dial and twelve are refused, so
    /// the process holds eight ten-second connections instead of twenty — that is
    /// the resource exhaustion this closes. Forty parallel sign-ins at an address
    /// that fails *fast*: thirty get through and the lot finishes in 91ms, about
    /// four hundred a second, because a permit comes back in milliseconds.
    ///
    /// So it does **not** slow a port sweep, which is made of exactly those fast
    /// failures. Only `FLINT_TARGETS` stops that, which is why the boot log warns
    /// when it is unset rather than leaving this to be mistaken for the answer.
    ///
    /// Counted per process rather than per client: behind a proxy the only client
    /// address available is a header the caller writes, and a limit keyed on
    /// something spoofable is not a limit.
    pub dials: Arc<tokio::sync::Semaphore>,
    /// Long operations, and the rows that outlive them. `None` without a
    /// workspace: a job Flint cannot record is a job nobody can reconstruct.
    pub jobs: Option<crate::jobs::Runner>,
    /// Published answers, held for as long as each endpoint says.
    ///
    /// In this process and nowhere else — two Flints behind a load balancer
    /// each keep their own, so a caller can see an answer up to one TTL older
    /// than another caller sees. That is a real consequence of not having a
    /// second database to put a shared cache in, and it is the reason the TTL
    /// is stated on the endpoint's page rather than hidden.
    pub api_cache: Arc<crate::published::cache::Cache>,
    /// Calls waiting to be written to the workspace's own log.
    ///
    /// Buffered rather than written one at a time, because ClickHouse makes a
    /// part per insert — see `published::log`. A background task drains it; the
    /// quota check reads it, because the newest calls are here and not yet in
    /// the table they would otherwise be counted from.
    pub calls: Arc<crate::published::log::CallLog>,
}

impl AppState {
    /// The ClickHouse client for whoever is asking.
    ///
    /// With `--auth` off this is Flint's own account, which is how Flint has
    /// always worked. With it on, it is the signed-in user's — so ClickHouse's
    /// grants decide what the answer contains, and `system.query_log` records
    /// who asked.
    fn client_for(&self, headers: &axum::http::HeaderMap) -> Result<Client> {
        if !self.config.sign_in_required() {
            return Ok(self.ch.clone());
        }
        let id = auth::session_id(headers)
            .ok_or_else(|| Error::Unauthorized("sign in to continue".into()))?;
        // The two failures are worth telling apart: one means "you never signed
        // in", the other "you did, a while ago". The second is the one that
        // arrives mid-task and needs to say why.
        let identity = self.sessions.resolve(&id).ok_or_else(|| {
            Error::Unauthorized("your session has expired — sign in again".into())
        })?;
        Ok(self.ch.as_user(&identity))
    }

    /// Whoever is asking, by name, for the record a job keeps of who asked.
    fn caller_name(&self, headers: &axum::http::HeaderMap) -> String {
        if !self.config.sign_in_required() {
            return self.config.clickhouse_user.clone();
        }
        auth::session_id(headers)
            .and_then(|id| self.sessions.resolve(&id))
            .map(|identity| identity.user().to_string())
            // Unreachable behind the gate, and not worth an `unwrap` to prove
            // it: a name nobody recognises is better than a panic.
            .unwrap_or_else(|| "unknown".into())
    }

    /// Refuse what this deployment's tier does not permit.
    ///
    /// The check is here rather than in the UI as well as in the UI: the browser
    /// hides what it may not do, and this makes sure hiding it was not the only
    /// thing standing in the way.
    fn require_tier(&self, need: Tier) -> Result<()> {
        let have = self.config.tier();
        if have < need {
            return Err(Error::Forbidden(format!(
                "this Flint runs at tier `{}`, and that needs `{}`. Set FLINT_TIER to change \
                 what the deployment permits.",
                have.as_str(),
                need.as_str()
            )));
        }
        Ok(())
    }

    /// The job runner, or the reason there is none.
    ///
    /// Named for the field it returns, not for "the runner": `self.runner` is the
    /// alert scheduler, and two things called the runner in one struct is a
    /// reading error waiting to happen.
    fn job_runner(&self) -> Result<&crate::jobs::Runner> {
        self.jobs.as_ref().ok_or_else(|| {
            Error::BadRequest(
                "long operations are recorded in Flint's workspace, and this Flint has none. \
                 Set FLINT_WORKSPACE_DATABASE to a database it may write to."
                    .into(),
            )
        })
    }
}

/// The ClickHouse client for whoever is asking, and the gate that makes it
/// theirs. A handler that takes this runs as the signed-in user and is refused
/// outright when nobody is signed in.
///
/// Authentication is per handler rather than a layer over everything, because
/// three routes must stay open and a layer would have to carry a list of them:
/// `/api/health` is the container's liveness probe, `/api/config` is how the
/// browser learns it needs to sign in at all, and `/api/data/*` is the published
/// face, which carries its own token. Exemption is therefore visible in a
/// signature — with the corollary that a *new* handler is open until it asks for
/// this or for [`SignedIn`], which is the thing to check when adding one.
///
/// Alongside those, `session::{whoami, login, logout}` are open by necessity —
/// a browser that cannot reach them cannot sign in — and so is
/// `session::preflight`, which is the only one of the set that opens a socket
/// to an address the *caller* chose without creating a session. It is worth
/// naming here because its openness is the least obvious: see its own doc, and
/// [`AppState::dials`] for the budget it shares with signing in.
/// Sign-in dials permitted at once. See [`AppState::dials`].
///
/// A constant rather than a setting: somebody signs in once, so the number only
/// has to sit far above one person and far below a scanner. A knob nobody sets
/// is a knob.
pub const CONCURRENT_DIALS: usize = 8;

pub struct Caller(pub Client);

impl FromRequestParts<AppState> for Caller {
    type Rejection = Error;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self> {
        Ok(Caller(state.client_for(&parts.headers)?))
    }
}

/// Proof that somebody is signed in, for a handler that does not itself speak to
/// ClickHouse as them.
///
/// The workspace is Flint's own bookkeeping — saved queries, dashboards, alerts
/// — and it is written with Flint's account so that saving does not require
/// every reader to hold `INSERT` on a database they did not ask for. But reading
/// and writing it still needs a person: without this, an unauthenticated caller
/// could list and delete everything Flint has kept while being unable to run a
/// single query.
pub struct SignedIn;

impl FromRequestParts<AppState> for SignedIn {
    type Rejection = Error;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self> {
        state.client_for(&parts.headers)?;
        Ok(SignedIn)
    }
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
        // Signing in, out, and asking who you are. Open by necessity: a browser
        // that cannot reach these cannot sign in.
        .route("/session", get(session::whoami))
        .route("/login", post(session::login))
        // Open for the same reason `/login` is: it is asked by a browser that
        // has nobody to be yet. It opens no session — see `session::preflight`.
        .route("/preflight", post(session::preflight))
        .route("/logout", post(session::logout))
        .route("/server", get(explorer::server))
        .route("/timezones", get(explorer::timezones))
        .route("/server/timeline", get(explorer::server_timeline))
        .route("/databases", get(explorer::databases))
        .route("/databases/{database}/tables", get(explorer::tables))
        .route("/databases/{database}/graph", get(explorer::database_graph))
        .route(
            "/databases/{database}/timeline",
            get(explorer::database_timeline),
        )
        .route("/databases/{database}/mass", get(explorer::database_mass))
        .route(
            "/databases/{database}/affinity",
            get(explorer::database_affinity),
        )
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
        .route(
            "/databases/{database}/tables/{table}/relations",
            get(explorer::table_relations),
        )
        .route(
            "/databases/{database}/tables/{table}/drift",
            get(explorer::table_drift),
        )
        .route(
            "/databases/{database}/tables/{table}/stream",
            get(explorer::table_stream),
        )
        .route(
            "/databases/{database}/tables/{table}/connect",
            post(explorer::table_connect),
        )
        .route(
            "/databases/{database}/tables/{table}/columns/{column}/distribution",
            get(explorer::column_distribution),
        )
        .route(
            "/databases/{database}/tables/{table}/compare",
            get(explorer::compare_tables),
        )
        .route(
            "/databases/{database}/tables/{table}/impact",
            get(explorer::table_impact),
        )
        .route(
            "/databases/{database}/tables/{table}/changes",
            get(explorer::table_changes),
        )
        .route("/databases/{database}/heavy", get(explorer::database_heavy))
        .route(
            "/databases/{database}/projections",
            get(explorer::database_projections),
        )
        .route(
            "/databases/{database}/tables/{table}/review",
            get(explorer::table_review),
        )
        .route(
            "/databases/{database}/tables/{table}/probe",
            post(explorer::table_probe),
        )
        .route(
            "/databases/{database}/tables/{table}/projections",
            get(explorer::table_projections),
        )
        .route(
            "/databases/{database}/tables/{table}/projections/measure",
            post(explorer::measure_projection),
        )
        .route(
            "/databases/{database}/tables/{table}/projections/weigh",
            post(explorer::weigh_projection),
        )
        .route(
            "/databases/{database}/tables/{table}/readers",
            get(explorer::column_readers),
        )
        .route(
            "/databases/{database}/tables/{table}/codecs",
            post(explorer::column_codecs),
        )
        // Rows are Data: adding one changes nothing about what the table is,
        // so it sits with the reader rather than under `/infra` with the
        // statements that change structure.
        .route("/rows", post(rows::insert))
        // A read, so it is gated on nothing: the preview exists so somebody
        // does not run the wrong mutation, and putting it behind the tier that
        // runs one would make doing it the only way to find out.
        .route("/rows/preview", post(rows::preview))
        .route("/rows/mutate", post(rows::mutate_rows))
        .route("/rows/pending", get(rows::pending))
        .route("/rows/inspect", post(rows::inspect))
        .route("/rows/import", post(rows::import))
        .route("/outside", get(explorer::outside_tables))
        .route("/schema", get(explorer::schema))
        .route("/history", get(explorer::history))
        .route("/diagnostics/news", get(diagnostics::what_changed))
        .route("/diagnostics/queries", get(diagnostics::queries))
        .route("/diagnostics/traffic", get(diagnostics::traffic))
        .route("/diagnostics/storage", get(diagnostics::storage))
        .route("/diagnostics/activity", get(diagnostics::activity))
        .route("/diagnostics/api-usage", get(diagnostics::api_usage))
        .route("/diagnostics/pipelines", get(diagnostics::pipelines))
        .route("/diagnostics/access", get(diagnostics::access))
        // Data, not Infrastructure: what *you* may see, asked as you.
        .route("/me/grants", get(diagnostics::my_grants))
        // Who did what. A read over the two records that already exist —
        // `system.query_log` and the job table — rather than a third one.
        .route("/diagnostics/audit", get(diagnostics::audit))
        .route("/diagnostics/limits", get(diagnostics::limits))
        .route("/diagnostics/replication", get(diagnostics::replication))
        .route("/cluster/topology", get(diagnostics::topology))
        .route(
            "/cluster/replication-queue",
            get(diagnostics::replication_queue),
        )
        .route("/cluster/ddl-queue", get(diagnostics::ddl_queue))
        .route("/health/series", get(diagnostics::series))
        .route("/health/log", get(diagnostics::server_log))
        .route("/health/errors", get(diagnostics::errors))
        .route("/health/merges", get(diagnostics::merges))
        .route("/parts/detached", get(diagnostics::detached_parts))
        .route("/diagnostics/cold", get(diagnostics::cold_bytes))
        .route("/diagnostics/spend", get(diagnostics::spend_by_user))
        .route("/parts/detached/act", post(jobs::detached_part))
        .route("/parts/partition", post(jobs::partition))
        .route("/schema/objects", get(diagnostics::schema_objects))
        .route("/schema/object", post(jobs::object))
        .route("/backups", get(diagnostics::backup_runs))
        .route("/backups/act", post(jobs::backup))
        .route("/access/act", post(jobs::access))
        .route("/access/govern", post(jobs::govern))
        .route("/system/act", post(jobs::system))
        .route("/diagnostics/settings", get(diagnostics::settings))
        .route("/diagnostics/now", get(diagnostics::now))
        .route("/diagnostics/trace", get(diagnostics::trace))
        .route("/cluster/keeper", get(diagnostics::keeper))
        .route("/replica/act", post(jobs::replica))
        .route("/dictionaries", get(diagnostics::dictionaries))
        .route("/storage/policies", get(diagnostics::storage_policies))
        .route("/schema/alter", post(jobs::alter))
        .route("/schema/alterations", get(diagnostics::alterations))
        .route("/schema/derived", get(diagnostics::derived))
        .route("/schema/definition", get(diagnostics::definition))
        .route("/schema/create", post(jobs::create))
        .route("/dictionaries/reload", post(jobs::reload_dictionary))
        .route("/pipelines/refresh", post(diagnostics::refresh_view))
        .route("/diagnostics/kill", post(diagnostics::kill))
        // Reading a dataset, as whoever is asking. It takes `Caller`, so it is
        // behind the sign-in — which is the difference between it and the
        // published face below, and the reason it needs no token of its own.
        .route("/data", post(dataset::query))
        // Static, so it wins over `/data/{slug}` below — and only for POST,
        // which that route does not answer. A published endpoint may still be
        // addressed `schema`.
        .route("/data/schema", post(dataset::schema))
        // Which datasets there are, for whoever is asking. `POST` for the same
        // reason as `schema`: both are static segments that a published
        // endpoint could legitimately be named, and only `GET` is theirs.
        .route("/data/list", post(dataset::list))
        // `GET`, safely: a slug cannot contain a dot, so no published endpoint
        // can ever be called `openapi.json`.
        .route("/data/openapi.json", get(dataset::openapi_document))
        .route("/query", post(query::run))
        // A form post, not JSON: the browser must be the one navigating, or
        // the file goes through the tab's memory on its way to the disk.
        .route("/export", post(query::download))
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
        // Traffic, from Flint's own call log rather than `system.query_log` —
        // see `published::usage` for why three of these panels cannot come
        // from the query log at all.
        // Several tables, one act. The read side of the no-code APIs is per
        // statement, which is right for a join and wrong for the only other
        // thing anyone does with it.
        .route(
            "/published/tables",
            axum::routing::post(saved::publish_tables),
        )
        .route("/published/usage", get(saved::published_usage))
        .route("/published/{slug}/usage", get(saved::endpoint_usage))
        // What the statement returns, for whoever is writing its contract.
        .route("/published/{slug}/columns", get(saved::endpoint_columns))
        // A new revision is a POST to the *address*, because that is what is
        // gaining one. Moving a revision along its life is a POST to the
        // revision, because that is what is moving.
        .route(
            "/published/{slug}/revisions",
            axum::routing::post(saved::new_revision),
        )
        .route(
            "/revisions/{id}/state",
            axum::routing::post(saved::set_state),
        )
        .route("/keys", get(saved::api_keys).post(saved::save_api_key))
        .route("/keys/{id}", axum::routing::delete(saved::remove_api_key))
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
        // The same endpoint, in the shape an agent framework wants. A static
        // segment, so it cannot be mistaken for a slug.
        .route("/data/{slug}/tool.json", get(data::tool_definition))
        .route("/query/{query_id}/cancel", post(query::cancel))
        // Long operations: submitted, listed, stopped.
        .route("/jobs", get(jobs::list))
        .route("/jobs/{id}/cancel", post(jobs::cancel))
        .route("/optimize", post(jobs::optimize))
        .route("/cluster/replica", post(jobs::replica));

    Router::new()
        .nest("/api", api)
        .fallback(spa::serve)
        // Gzip everything except a Parquet download. CSV and JSONL are text and
        // compress to a fraction; Parquet arrives already compressed page by
        // page, so a second pass spends CPU at both ends to save almost
        // nothing — measured, not assumed: the default predicate does gzip it.
        // Compression streams rather than buffering, so this changes what a
        // download costs and never whether it flows.
        .layer(CompressionLayer::new().compress_when(
            DefaultPredicate::new().and(NotForContentType::const_new(crate::export::PARQUET_TYPE)),
        ))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    use super::*;

    /// A router over a ClickHouse that is not there.
    ///
    /// Deliberately: every test here is about what happens *before* a request
    /// reaches the database, and a route that answers without one has proved it
    /// never tried. The gate either refuses or the request dies of a transport
    /// error, and those two are easy to tell apart.
    fn app(auth: bool) -> (Router, Sessions) {
        let mut config = <Config as clap::Parser>::parse_from(["flint"]);
        config.auth = auth;
        // Nothing listens here.
        config.clickhouse_url = Some("http://127.0.0.1:1".into());
        let sessions = Sessions::new(std::time::Duration::from_secs(60));
        let state = AppState {
            ch: Client::new(&config).expect("client"),
            config: Arc::new(config),
            workspace: None,
            runner: None,
            sessions: sessions.clone(),
            // No workspace, so no jobs — which is itself worth having a test
            // reach: submitting one must say why rather than panic.
            jobs: None,
            dials: Arc::new(tokio::sync::Semaphore::new(CONCURRENT_DIALS)),
            api_cache: Arc::new(crate::published::cache::Cache::new()),
            calls: Arc::new(crate::published::log::CallLog::new()),
        };
        (router(state), sessions)
    }

    /// A router over an *unpinned* Flint: nothing in the manifest, so the
    /// browser names the server at sign-in.
    ///
    /// `auth` is left off on purpose. Every test below that gets refused proves
    /// the gate does not depend on the flag — which is the whole invariant of
    /// this mode, and the one that would fail silently by serving an open UI.
    fn unpinned(targets: &[&str]) -> Router {
        let mut config = <Config as clap::Parser>::parse_from(["flint"]);
        config.clickhouse_url = None;
        config.auth = false;
        config.targets = targets.iter().map(|t| t.to_string()).collect();
        // The dev shell and CI both export `FLINT_*`, and a workspace inherited
        // from one of them is a manifest `check()` would have refused.
        config.workspace_database = None;
        let state = AppState {
            ch: Client::new(&config).expect("client"),
            config: Arc::new(config),
            workspace: None,
            runner: None,
            sessions: Sessions::new(std::time::Duration::from_secs(60)),
            jobs: None,
            dials: Arc::new(tokio::sync::Semaphore::new(CONCURRENT_DIALS)),
            api_cache: Arc::new(crate::published::cache::Cache::new()),
            calls: Arc::new(crate::published::log::CallLog::new()),
        };
        router(state)
    }

    #[tokio::test]
    async fn an_unpinned_flint_is_gated_whatever_the_auth_flag_says() {
        // There is nothing to be open *as*: no endpoint in the manifest means
        // no account in the manifest. A route that answered here would be
        // answering out of an empty connection.
        let app = unpinned(&[]);
        for path in ["/api/databases", "/api/server", "/api/diagnostics/storage"] {
            let (status, body) = get(&app, path, None).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{path} was not gated");
            assert!(body.contains("sign in"), "{path}: {body}");
        }
    }

    #[tokio::test]
    async fn an_unpinned_flint_says_it_has_no_endpoint_rather_than_naming_one() {
        let app = unpinned(&[]);
        let (status, body) = get(&app, "/api/config", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"pinned\":false"), "{body}");
        // Dropped, not blanked: the first screen branches on this.
        assert!(body.contains("\"endpoint\":null"), "{body}");
        // And no account in the manifest to run as.
        assert!(body.contains("\"user\":null"), "{body}");
        // The browser has to be told to sign in, or it renders an app that can
        // ask nothing.
        assert!(body.contains("\"auth\":true"), "{body}");
    }

    #[tokio::test]
    async fn the_health_probe_claims_nothing_about_a_server_that_is_not_there() {
        // The container's liveness probe. `reachable:false` here would read as
        // "the database is down" and take a healthy Flint out of rotation, when
        // the truth is that this one has no database of its own.
        let app = unpinned(&[]);
        let (status, body) = get(&app, "/api/health", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"pinned\":false"), "{body}");
        assert!(!body.contains("reachable"), "{body}");
    }

    #[tokio::test]
    async fn signing_in_to_an_unpinned_flint_needs_an_endpoint() {
        let app = unpinned(&[]);
        let (status, body) = post(&app, "/api/login", None, r#"{"user":"analyst"}"#).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        // Says what to type, not which rule fired.
        assert!(body.contains("http://localhost:8123"), "{body}");
    }

    #[tokio::test]
    async fn an_endpoint_outside_the_allow_list_is_refused_before_it_is_dialled() {
        let app = unpinned(&["clickhouse:8123"]);
        let (status, body) = post(
            &app,
            "/api/login",
            None,
            r#"{"user":"analyst","endpoint":"http://169.254.169.254:80"}"#,
        )
        .await;
        // 400, not 502: refused here rather than attempted and failed, which is
        // the difference between a fence and a slow one.
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(
            body.contains("FLINT_TARGETS") || body.contains("link-local"),
            "{body}"
        );
    }

    #[tokio::test]
    async fn an_allowed_endpoint_is_actually_dialled() {
        // Nothing listens on port 1, so a transport failure is the proof that
        // the address got past every check and became a socket.
        let app = unpinned(&["127.0.0.1:1"]);
        let (status, body) = post(
            &app,
            "/api/login",
            None,
            r#"{"user":"analyst","endpoint":"127.0.0.1:1"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
        assert!(body.contains("127.0.0.1:1"), "{body}");
    }

    #[tokio::test]
    async fn a_sign_in_waits_for_nobody_and_is_refused_when_the_dials_are_full() {
        // The gate exists so that `/api/login` — the one unauthenticated route
        // that opens a socket to an address the caller chose — cannot be run in
        // unlimited parallel. Proved by holding every permit rather than by
        // racing requests, because a test that depends on scheduling order is a
        // test that passes on one machine.
        let mut config = <Config as clap::Parser>::parse_from(["flint"]);
        config.clickhouse_url = None;
        config.workspace_database = None;
        config.targets = vec!["127.0.0.1:1".into()];
        let dials = Arc::new(tokio::sync::Semaphore::new(1));
        let state = AppState {
            ch: Client::new(&config).expect("client"),
            config: Arc::new(config),
            workspace: None,
            runner: None,
            sessions: Sessions::new(std::time::Duration::from_secs(60)),
            dials: dials.clone(),
            jobs: None,
            api_cache: Arc::new(crate::published::cache::Cache::new()),
            calls: Arc::new(crate::published::log::CallLog::new()),
        };
        let app = router(state);
        let body = r#"{"user":"analyst","endpoint":"127.0.0.1:1"}"#;

        // The only permit, held elsewhere.
        let held = dials.clone().try_acquire_owned().expect("the first permit");
        let (status, said) = post(&app, "/api/login", None, body).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{said}");
        // Says what to do, and names the variable that would stop it being a
        // scanning tool rather than only a slow one.
        assert!(said.contains("Try again in a moment"), "{said}");
        assert!(said.contains("FLINT_TARGETS"), "{said}");

        // Released, and the gate is open again — it counts what is in flight,
        // it does not remember that anything happened.
        drop(held);
        let (status, said) = post(&app, "/api/login", None, body).await;
        // 502: through the gate and out to a port where nothing listens, which
        // is the proof that the refusal above was the gate and not the address.
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{said}");
    }

    /// The preflight is the second unauthenticated route in this process, and
    /// the first one to be added since the reasoning about the first was
    /// written down. These hold it to the same three promises `/api/login`
    /// makes, because it opens the same socket to the same address a browser
    /// chose — and because the whole point of `session::target_for` and
    /// `session::dial` being functions is that the two routes cannot drift.
    #[tokio::test]
    async fn the_preflight_is_open_and_vetted_exactly_as_signing_in_is() {
        // Open: no cookie, and it must not answer 401. It gets as far as the
        // address and fails there, which is the proof it was not gated.
        let open = unpinned(&[]);
        let body = r#"{"user":"analyst","endpoint":"http://127.0.0.1:1"}"#;
        let (status, said) = post(&open, "/api/preflight", None, body).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{said}");

        // Vetted: an allow-list that does not name the host refuses before a
        // socket is opened, with the same words the sign-in route uses.
        let narrowed = unpinned(&["allowed:8123"]);
        let (status, said) = post(&narrowed, "/api/preflight", None, body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
        assert!(said.contains("FLINT_TARGETS"), "{said}");

        // And it will not be used to move a pinned Flint any more than signing
        // in will.
        let (pinned, _) = app(true);
        let (status, said) = post(
            &pinned,
            "/api/preflight",
            None,
            r#"{"user":"analyst","endpoint":"http://elsewhere:8123"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
        assert!(said.contains("pointed at"), "{said}");
    }

    #[tokio::test]
    async fn the_preflight_asks_for_a_server_when_there_is_none_to_ask_about() {
        // The same refusal `/api/login` gives, from the same function: an
        // unpinned Flint has no address of its own, so a body without one is
        // not a request anybody can answer.
        let open = unpinned(&[]);
        let (status, said) = post(&open, "/api/preflight", None, r#"{"user":"analyst"}"#).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
        assert!(said.contains("name the ClickHouse HTTP endpoint"), "{said}");

        // And a nameless caller is refused before the socket, not after.
        let (status, said) = post(
            &open,
            "/api/preflight",
            None,
            r#"{"user":"  ","endpoint":"http://127.0.0.1:1"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
        assert!(said.contains("user name is required"), "{said}");
    }

    #[tokio::test]
    async fn a_pinned_flint_refuses_an_endpoint_the_browser_offers() {
        // Refused rather than ignored. A caller that sent an address and was
        // answered 200 would have every reason to think it was used — and a
        // pinned Flint that took the field would be an open proxy behind a
        // manifest promising it is not.
        let (app, _) = app(true);
        let (status, body) = post(
            &app,
            "/api/login",
            None,
            r#"{"user":"analyst","endpoint":"http://elsewhere:8123"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(body.contains("pointed at"), "{body}");
        assert!(body.contains("FLINT_CLICKHOUSE_URL"), "{body}");
    }

    #[tokio::test]
    async fn a_session_answers_with_the_server_it_was_opened_against() {
        // Two people on one unpinned Flint can be on two different ClickHouses,
        // so "which server" is a question about the session and not about the
        // deployment. The UI puts this in the chrome.
        let mut config = <Config as clap::Parser>::parse_from(["flint"]);
        config.clickhouse_url = None;
        config.workspace_database = None;
        let sessions = Sessions::new(std::time::Duration::from_secs(60));
        let state = AppState {
            ch: Client::new(&config).expect("client"),
            config: Arc::new(config),
            workspace: None,
            runner: None,
            sessions: sessions.clone(),
            jobs: None,
            dials: Arc::new(tokio::sync::Semaphore::new(CONCURRENT_DIALS)),
            api_cache: Arc::new(crate::published::cache::Cache::new()),
            calls: Arc::new(crate::published::log::CallLog::new()),
        };
        let app = router(state);

        let id = sessions.open(auth::Identity::new("analyst", "").at("http://one:8123"));
        let (status, body) = get(&app, "/api/session", Some(&id)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("http://one:8123"), "{body}");
        assert!(body.contains("\"user\":\"analyst\""), "{body}");
        // Nothing to fall back to on the way out, and the sign-in screen says
        // so by asking for a server as well as a name.
        assert!(body.contains("\"service_user\":null"), "{body}");
    }

    async fn get(app: &Router, path: &str, cookie: Option<&str>) -> (StatusCode, String) {
        let mut req = Request::builder().uri(path);
        if let Some(c) = cookie {
            req = req.header("cookie", format!("{}={c}", auth::COOKIE));
        }
        let response = app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&body).to_string())
    }

    #[tokio::test]
    async fn without_auth_every_route_is_open_exactly_as_before() {
        let (app, _) = app(false);
        let (status, _) = get(&app, "/api/databases", None).await;
        // 502: it got past the gate and failed to reach ClickHouse, which is
        // the proof that there was no gate.
        assert_eq!(status, StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn with_auth_a_request_without_a_session_is_refused() {
        let (app, _) = app(true);
        for path in [
            "/api/databases",
            "/api/server",
            "/api/schema",
            "/api/diagnostics/storage",
            "/api/saved-queries",
        ] {
            let (status, body) = get(&app, path, None).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{path} was not gated");
            assert!(body.contains("sign in"), "{path}: {body}");
        }
    }

    #[tokio::test]
    async fn with_auth_an_unknown_or_expired_cookie_is_refused() {
        let (app, sessions) = app(true);
        let (status, body) = get(&app, "/api/databases", Some("not-a-session")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.contains("expired"), "{body}");

        // A real session gets through — as far as the missing database, which is
        // where these tests stop.
        let id = sessions.open(auth::Identity::new("analyst", ""));
        let (status, _) = get(&app, "/api/databases", Some(&id)).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
    }

    /// The same request, carrying the session the way a script carries it.
    async fn get_with_bearer(app: &Router, path: &str, token: &str) -> (StatusCode, String) {
        let req = Request::builder()
            .uri(path)
            .header("authorization", format!("Bearer {token}"));
        let response = app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&body).to_string())
    }

    /// A POST, for the routes that take a body.
    async fn post(
        app: &Router,
        path: &str,
        bearer: Option<&str>,
        body: &str,
    ) -> (StatusCode, String) {
        let mut req = Request::builder()
            .uri(path)
            .method("POST")
            .header("content-type", "application/json");
        if let Some(token) = bearer {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        let response = app
            .clone()
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&body).to_string())
    }

    #[tokio::test]
    async fn reading_a_dataset_is_behind_the_sign_in_though_its_prefix_is_not() {
        let (app, sessions) = app(true);

        // `/api/data/*` is the published face and is exempt — but the exemption
        // belongs to the handlers that carry a token, not to the prefix. This
        // one asks for a caller, so it is gated, and a test says so because the
        // two live one path segment apart.
        let (status, body) = post(&app, "/api/data", None, r#"{"dataset":"a.b"}"#).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.contains("sign in"), "{body}");

        // The published endpoint beside it is still reachable without one, and
        // refused for its own reason rather than for this one.
        let (status, body) = get(&app, "/api/data/some-endpoint", None).await;
        assert_ne!(status, StatusCode::UNAUTHORIZED, "{body}");

        // Signed in, the body is read and its complaints are the body's.
        let id = sessions.open(auth::Identity::new("analyst", ""));
        let (status, body) = post(&app, "/api/data", Some(&id), r#"{"dataset":""}"#).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(body.contains("name a dataset"), "{body}");
    }

    #[tokio::test]
    async fn a_download_is_behind_the_sign_in_like_everything_else() {
        // Worth its own test because a download is the one route that is *not*
        // JSON. It takes a form so the browser can navigate to it and stream
        // the file to disk — which means the session arrives in the cookie
        // rather than in a header, and the gate has to be just as closed to a
        // form as it is to a fetch. A route that hands over whole tables is not
        // one to leave to inference.
        let (app, sessions) = app(true);
        let body = "sql=SELECT+1&format=csv";

        let request = Request::builder()
            .method("POST")
            .uri("/api/export")
            .header("content-type", "application/x-www-form-urlencoded")
            .body(Body::from(body))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        // And a session gets through the gate — as far as ClickHouse, which is
        // not listening in this test. 502 is the proof that there was no gate
        // left to stop it.
        let id = sessions.open(auth::Identity::new("analyst", ""));
        let request = Request::builder()
            .method("POST")
            .uri("/api/export")
            .header("content-type", "application/x-www-form-urlencoded")
            .header("cookie", format!("flint_session={id}"))
            .body(Body::from(body))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_ne!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn with_auth_a_bearer_gets_a_script_through_the_same_gate() {
        let (app, sessions) = app(true);
        // Refused for the same reason and with the same words as a bad cookie:
        // the gate does not care which envelope the id arrived in.
        let (status, body) = get_with_bearer(&app, "/api/databases", "not-a-session").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.contains("expired"), "{body}");

        // And a real one gets as far as the missing database, exactly as the
        // cookie does — which is the whole point: one gate, two transports.
        let id = sessions.open(auth::Identity::new("analyst", ""));
        let (status, _) = get_with_bearer(&app, "/api/databases", &id).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn the_three_routes_a_browser_needs_before_signing_in_stay_open() {
        let (app, _) = app(true);
        // How the browser learns it must sign in at all.
        let (status, body) = get(&app, "/api/config", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"auth\":true"), "{body}");

        // Who am I: answers "nobody", never 401 — the browser asks this in
        // order to find out whether it needs a session.
        let (status, body) = get(&app, "/api/session", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"required\":true"), "{body}");
        assert!(body.contains("\"user\":null"), "{body}");

        // The container's liveness probe, which has no cookie and never will.
        let (status, _) = get(&app, "/api/health", None).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn the_published_face_is_not_behind_the_sign_in() {
        // A published endpoint carries its own token and is called by machines
        // that have no session and cannot get one. Gating it here would break
        // every one of them the day somebody turns authentication on.
        let (app, _) = app(true);
        let (_, body) = get(&app, "/api/data/anything", None).await;
        assert!(
            !body.contains("sign in"),
            "the published face was put behind the session gate: {body}"
        );
    }
}
