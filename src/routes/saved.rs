use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::clickhouse::reads::Space;
use crate::error::{Error, Result};
use crate::published::usage::{CacheUsage, EndpointUsage, UsageIndex};
use crate::workspace::{
    Alert, AlertEvent, AlertInput, ApiKey, ApiKeyInput, Dashboard, DashboardInput,
    PublishTablesInput, Published, PublishedInput, Report, ReportInput, ReportRun, SaveInput,
    SavedQuery, State as RevisionState,
};

use super::{AppState, Caller, SignedIn};

/// Everything here needs a workspace. Without one Flint is stateless by design,
/// and saying so is more useful than a 404.
fn workspace(state: &AppState) -> Result<&crate::workspace::Workspace> {
    state.workspace.as_ref().ok_or_else(|| {
        Error::BadRequest(
            "Flint is running without a workspace, so it cannot save anything. Set \
             FLINT_WORKSPACE_DATABASE to a database it may write to."
                .into(),
        )
    })
}

pub async fn list(_: SignedIn, State(state): State<AppState>) -> Result<Json<Vec<SavedQuery>>> {
    Ok(Json(workspace(&state)?.list(&state.ch).await?))
}

pub async fn save(
    _: SignedIn,
    State(state): State<AppState>,
    Json(input): Json<SaveInput>,
) -> Result<Json<SavedQuery>> {
    Ok(Json(workspace(&state)?.save(&state.ch, input).await?))
}

/// Checked here rather than left to ClickHouse's UUID parameter, which rejects
/// it correctly but with a message about type parsing that tells the caller
/// nothing useful.
pub fn valid_uuid(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

pub async fn remove(
    _: SignedIn,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    if !valid_uuid(&id) {
        return Err(Error::BadRequest(format!("`{id}` is not a saved-query id")));
    }
    workspace(&state)?.remove(&state.ch, &id).await?;
    Ok(Json(json!({ "deleted": id })))
}

pub async fn dashboards(
    _: SignedIn,
    State(state): State<AppState>,
) -> Result<Json<Vec<Dashboard>>> {
    Ok(Json(workspace(&state)?.dashboards(&state.ch).await?))
}

pub async fn save_dashboard(
    _: SignedIn,
    State(state): State<AppState>,
    Json(input): Json<DashboardInput>,
) -> Result<Json<Dashboard>> {
    Ok(Json(
        workspace(&state)?.save_dashboard(&state.ch, input).await?,
    ))
}

pub async fn remove_dashboard(
    _: SignedIn,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    if !valid_uuid(&id) {
        return Err(Error::BadRequest(format!("`{id}` is not a dashboard id")));
    }
    workspace(&state)?.remove_dashboard(&state.ch, &id).await?;
    Ok(Json(json!({ "deleted": id })))
}

#[cfg(test)]
mod tests {
    use super::valid_uuid;

    #[test]
    fn accepts_a_uuid_and_nothing_else() {
        assert!(valid_uuid("edaac96a-1111-4222-8333-444455556666"));
        assert!(valid_uuid("EDAAC96A-1111-4222-8333-444455556666"));
        assert!(!valid_uuid("not-a-uuid"));
        assert!(!valid_uuid(""));
        // Right length, wrong shape.
        assert!(!valid_uuid("edaac96a-1111-4222-8333-44445555666g"));
        assert!(!valid_uuid("edaac96a11114222833344445555666666666"));
    }
}

// ── Alerts ─────────────────────────────────────────────────────────────────

pub async fn alerts(_: SignedIn, State(state): State<AppState>) -> Result<Json<Vec<Alert>>> {
    let mut list = workspace(&state)?.alerts(&state.ch).await?;
    place(&state, &mut list).await;
    Ok(Json(list))
}

/// Put each alert in the space its SQL reads from.
///
/// The rule is the one the roadmap set: which space *lists* an alert follows
/// what it queries, not who wrote it. An operator's alert on `system.replicas`
/// belongs beside the replicas; an analyst's on `orders` belongs beside the
/// orders, and it makes no difference which of them typed it.
///
/// Asked per alert rather than stored with it, because the answer can change
/// under a stored one: a table gets dropped, a database renamed, and an alert
/// filed years ago is suddenly about something else — or about nothing, which
/// this is also the place to notice.
async fn place(state: &AppState, list: &mut [Alert]) {
    for alert in list.iter_mut() {
        match crate::clickhouse::reads::reads(&state.ch, &alert.sql, &alert.database).await {
            Ok(reads) => {
                let space = reads.space();
                alert.space = match space {
                    Space::Data => "data",
                    Space::Infra => "infra",
                    Space::Unplaceable => "unplaceable",
                }
                .to_string();
                alert.space_note = match space {
                    Space::Data => format!("reads {}", reads.tables.join(", ")),
                    Space::Infra => format!("reads {}", reads.tables.join(", ")),
                    Space::Unplaceable if !reads.functions.is_empty() => format!(
                        "built on {}, which names no table — what it reads depends on its \
                         arguments",
                        reads.functions.join(", ")
                    ),
                    Space::Unplaceable => "reads no table at all".to_string(),
                };
            }
            // A statement that will not resolve cannot be placed, and saying so
            // here is worth more than the placement: this is an alert that is
            // *on* and cannot run, which nothing else on the page would show.
            Err(e) => {
                alert.space = "unplaceable".to_string();
                alert.space_note = format!("its statement no longer resolves — {e}");
            }
        }
    }
}

pub async fn save_alert(
    _: SignedIn,
    State(state): State<AppState>,
    Json(input): Json<AlertInput>,
) -> Result<Json<Vec<Alert>>> {
    let ws = workspace(&state)?;
    ws.save_alert(&state.ch, input).await?;
    // The list comes back rather than the one row: saving an alert changes what
    // the scheduler will do next, and the caller wants the new truth.
    Ok(Json(ws.alerts(&state.ch).await?))
}

pub async fn remove_alert(
    _: SignedIn,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    if !valid_uuid(&id) {
        return Err(Error::BadRequest(format!("`{id}` is not an alert id")));
    }
    workspace(&state)?.remove_alert(&state.ch, &id).await?;
    Ok(Json(json!({ "deleted": id })))
}

#[derive(serde::Deserialize)]
pub struct EventQuery {
    #[serde(default)]
    alert_id: Option<String>,
    #[serde(default = "fifty")]
    limit: u64,
}

fn fifty() -> u64 {
    50
}

pub async fn alert_events(
    _: SignedIn,
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<EventQuery>,
) -> Result<Json<Vec<AlertEvent>>> {
    if let Some(id) = &q.alert_id {
        if !valid_uuid(id) {
            return Err(Error::BadRequest(format!("`{id}` is not an alert id")));
        }
    }
    Ok(Json(
        workspace(&state)?
            .alert_events(&state.ch, q.alert_id.as_deref(), q.limit)
            .await?,
    ))
}

// ── Reports ────────────────────────────────────────────────────────────────

pub async fn reports(_: SignedIn, State(state): State<AppState>) -> Result<Json<Vec<Report>>> {
    Ok(Json(workspace(&state)?.reports(&state.ch).await?))
}

pub async fn save_report(
    _: SignedIn,
    State(state): State<AppState>,
    Json(input): Json<ReportInput>,
) -> Result<Json<Vec<Report>>> {
    let ws = workspace(&state)?;
    ws.save_report(&state.ch, input).await?;
    Ok(Json(ws.reports(&state.ch).await?))
}

pub async fn remove_report(
    _: SignedIn,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    if !valid_uuid(&id) {
        return Err(Error::BadRequest(format!("`{id}` is not a report id")));
    }
    workspace(&state)?.remove_report(&state.ch, &id).await?;
    Ok(Json(json!({ "deleted": id })))
}

/// Run a report now, by hand.
///
/// Allowed under `FLINT_READONLY`, on the same reasoning as stopping a query:
/// every section runs as a read, and the edition it writes is Flint's own
/// bookkeeping in its own database, not your data. Refusing here would leave the
/// one deployment shape where a report can never be checked before nine
/// tomorrow — which is exactly a read-only, look-but-do-not-touch deployment.
pub async fn run_report_now(
    _: SignedIn,
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<crate::workspace::Job>> {
    if !valid_uuid(&id) {
        return Err(Error::BadRequest(format!("`{id}` is not a report id")));
    }
    let ws = workspace(&state)?;
    let report = ws
        .reports(&state.ch)
        .await?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| Error::BadRequest(format!("there is no report `{id}`")))?;
    // A paused report is still runnable by hand: pausing stops the schedule, and
    // somebody pressing the button is not the schedule.
    let scheduler = state.runner.clone().ok_or_else(|| {
        Error::BadRequest(
            "reports run only where a workspace is configured, and this Flint has none".into(),
        )
    })?;
    // Submitted as a job rather than awaited here. An edition is a dozen
    // statements; holding the request open for all of them meant a report with
    // slow sections timed out in the browser while continuing on the server,
    // and nothing on the page could say so.
    let runner = state.job_runner()?;
    let spec = crate::jobs::JobSpec {
        kind: "report",
        label: format!("Edition of {}", report.name),
        target: report.id.clone(),
        // No statement: an edition is many, and the sections are the report's
        // own definition rather than something this row should repeat.
        statement: String::new(),
        tier: state.config.tier().as_str().to_string(),
    };
    let who = state.caller_name(&headers);
    let job = runner
        .submit(spec, &who, move |_query_id| async move {
            let run_id = scheduler.run_report(&report).await;
            // Done means the edition was produced. Whether every section
            // succeeded is the edition's own status, on the report — one fact in
            // one place, with the id to join them.
            crate::jobs::Outcome::Done(format!("edition {run_id}"))
        })
        .await?;
    Ok(Json(job))
}

#[derive(serde::Deserialize)]
pub struct RunQuery {
    #[serde(default)]
    report_id: Option<String>,
    #[serde(default = "twenty")]
    limit: u64,
}

fn twenty() -> u64 {
    20
}

pub async fn report_runs(
    _: SignedIn,
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<RunQuery>,
) -> Result<Json<Vec<ReportRun>>> {
    if let Some(id) = &q.report_id {
        if !valid_uuid(id) {
            return Err(Error::BadRequest(format!("`{id}` is not a report id")));
        }
    }
    Ok(Json(
        workspace(&state)?
            .report_runs(&state.ch, q.report_id.as_deref(), q.limit)
            .await?,
    ))
}

/// One run, with what it found. Separate from the list because a snapshot is
/// the whole point and also the whole weight.
pub async fn report_snapshot(
    _: SignedIn,
    State(state): State<AppState>,
    Path(run_id): Path<String>,
) -> Result<Json<crate::workspace::ReportSnapshot>> {
    if !valid_uuid(&run_id) {
        return Err(Error::BadRequest(format!("`{run_id}` is not a run id")));
    }
    Ok(Json(
        workspace(&state)?
            .report_snapshot(&state.ch, &run_id)
            .await?,
    ))
}

// ── Published statements ───────────────────────────────────────────────────

/// One revision, plus the one thing about it the page needs that the row does
/// not hold.
///
/// `source` is derived from the statement rather than stored beside it, so the
/// two can never disagree — and it is derived *here* rather than in the
/// browser so there is one implementation of "what does this read from" with
/// one set of tests, instead of a Rust one for the document and a TypeScript
/// one for the table.
#[derive(serde::Serialize)]
pub struct PublishedRow {
    #[serde(flatten)]
    endpoint: Published,
    /// Absent where reading the statement does not say — an absent figure is
    /// dropped, not dashed.
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

pub async fn published(
    _: SignedIn,
    State(state): State<AppState>,
) -> Result<Json<Vec<PublishedRow>>> {
    Ok(Json(
        workspace(&state)?
            .published(&state.ch)
            .await?
            .into_iter()
            .map(|endpoint| PublishedRow {
                source: crate::published::usage::source_of(&endpoint.sql),
                endpoint,
            })
            .collect(),
    ))
}

pub async fn save_published(
    _: SignedIn,
    State(state): State<AppState>,
    Json(input): Json<PublishedInput>,
) -> Result<Json<crate::workspace::PublishedSaved>> {
    // Which roles may be handed out is the deployment's decision, so it is
    // checked against the manifest here — the workspace checks the other half,
    // which is whether naming a role would narrow anything at all.
    let role = input.run_as.trim();
    if !role.is_empty() && !state.config.delegatable_roles.iter().any(|r| r == role) {
        return Err(Error::BadRequest(
            if state.config.delegatable_roles.is_empty() {
                "this Flint delegates no roles — set FLINT_DELEGATABLE_ROLES to the ones an              endpoint may run as. It is a decision for whoever deploys, not for whoever              publishes."
                .to_string()
            } else {
                format!(
                    "`{role}` is not a role this Flint delegates; it delegates {}",
                    state.config.delegatable_roles.join(", ")
                )
            },
        ));
    }
    let slug = input.slug.trim().to_lowercase();
    let saved = workspace(&state)?.save_published(&state.ch, input).await?;
    // The seconds after a change are the one moment somebody is definitely
    // watching, and they are exactly when a cache filled by the version before
    // it reads as a broken deploy.
    state.api_cache.forget(&slug);
    Ok(Json(saved))
}

/// Expose a handful of tables, one endpoint each.
///
/// Read as the caller and written as Flint: the grant check has to be the
/// caller's, because the endpoints it creates run as the manifest account
/// afterwards and publishing a table somebody cannot see would be a way to read
/// it.
pub async fn publish_tables(
    _: SignedIn,
    Caller(caller): Caller,
    State(state): State<AppState>,
    Json(input): Json<PublishTablesInput>,
) -> Result<Json<crate::workspace::TablesPublished>> {
    Ok(Json(
        workspace(&state)?
            .publish_tables(&state.ch, &caller, input)
            .await?,
    ))
}

/// Start a new revision of an address, as a draft.
pub async fn new_revision(
    _: SignedIn,
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<Json<crate::workspace::PublishedSaved>> {
    Ok(Json(
        workspace(&state)?
            .new_revision(&state.ch, &slug.to_lowercase())
            .await?,
    ))
}

#[derive(Deserialize)]
pub struct StateInput {
    /// `live`, `retiring` or `retired`. The workspace decides whether the
    /// revision may go there from where it is.
    pub state: String,
}

/// Move one revision along its life — the only thing that writes a state.
pub async fn set_state(
    _: SignedIn,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<StateInput>,
) -> Result<Json<crate::workspace::PublishedSaved>> {
    if !valid_uuid(&id) {
        return Err(Error::BadRequest(format!("`{id}` is not an endpoint id")));
    }
    // Parsed strictly here rather than through `State::parse`, which reads
    // anything it does not recognise as `live` — a forgiving default is right
    // for a column written by an older binary and wrong for a button.
    let to = match input.state.as_str() {
        "live" => RevisionState::Live,
        "retiring" => RevisionState::Retiring,
        "retired" => RevisionState::Retired,
        "draft" => {
            return Err(Error::BadRequest(
                "a revision cannot be put back into draft. What was published is published; \
                 start a new revision instead."
                    .into(),
            ))
        }
        other => {
            return Err(Error::BadRequest(format!(
                "`{other}` is not a state. Use live, retiring or retired."
            )))
        }
    };
    let ws = workspace(&state)?;
    let slug = ws
        .published(&state.ch)
        .await?
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| p.slug);
    let saved = ws.set_state(&state.ch, &id, to).await?;
    if let Some(slug) = slug {
        state.api_cache.forget(&slug);
    }
    Ok(Json(saved))
}

/// How long a window the usage panels cover. A day by default, because that is
/// what "Calls 24h" on the list page means.
#[derive(Deserialize)]
pub struct UsageWindow {
    #[serde(default)]
    pub hours: Option<u32>,
}

impl UsageWindow {
    fn hours(&self) -> u32 {
        self.hours.unwrap_or(24).clamp(1, 24 * 30)
    }
}

/// The list page's traffic rollup.
///
/// A failure to read it is not a failure of the page: it means the workspace
/// is unreadable or the table is not there yet, and the honest answer is
/// "cannot tell" rather than a grid of zeroes. Every panel that consumes this
/// checks `available` before it renders a figure.
pub async fn published_usage(
    _: SignedIn,
    State(state): State<AppState>,
    Query(window): Query<UsageWindow>,
) -> Result<Json<UsageIndex>> {
    let hours = window.hours();
    let ws = workspace(&state)?;
    Ok(Json(match ws.usage_index(&state.ch, hours).await {
        Ok(usage) => UsageIndex {
            available: true,
            reason: None,
            window_hours: hours,
            usage,
        },
        Err(e) => UsageIndex {
            available: false,
            reason: Some(e.to_string()),
            window_hours: hours,
            usage: Vec::new(),
        },
    }))
}

/// Everything the detail page's right-hand column shows.
pub async fn endpoint_usage(
    _: SignedIn,
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(window): Query<UsageWindow>,
) -> Result<Json<EndpointUsage>> {
    let hours = window.hours();
    let slug = slug.to_lowercase();
    let ws = workspace(&state)?;

    // The TTL belongs to the live revision: it is a property of the address as
    // callers experience it, and a retiring revision with a different one is a
    // detail of that revision's own page.
    let ttl = ws
        .published_revisions(&state.ch, &slug)
        .await
        .ok()
        .and_then(|revisions| {
            revisions
                .iter()
                .find(|r| RevisionState::parse(&r.state) == RevisionState::Live)
                .or_else(|| revisions.first())
                .map(|r| r.cache_ttl)
        })
        .unwrap_or(0);

    let traffic = match ws.endpoint_traffic(&state.ch, &slug, hours).await {
        Ok(traffic) => traffic,
        Err(e) => {
            return Ok(Json(EndpointUsage {
                available: false,
                reason: Some(e.to_string()),
                window_hours: hours,
                cache: CacheUsage {
                    ttl,
                    hits: 0,
                    misses: 0,
                    hit_rate: None,
                    avg_hit_ms: None,
                    avg_miss_ms: None,
                    oldest_held: None,
                    held: 0,
                },
                keys: Vec::new(),
                callers: Vec::new(),
                refusals: Vec::new(),
                calls: 0,
                failures: 0,
            }))
        }
    };

    let served = traffic.hits + traffic.misses;
    Ok(Json(EndpointUsage {
        available: true,
        reason: None,
        window_hours: hours,
        cache: CacheUsage {
            ttl,
            hits: traffic.hits,
            misses: traffic.misses,
            // A rate needs a denominator. Absent where nothing has been served
            // either way, because 0% is a claim about an endpoint nobody has
            // called.
            hit_rate: (served > 0).then(|| traffic.hits as f64 / served as f64),
            avg_hit_ms: traffic.avg_hit_ms,
            avg_miss_ms: traffic.avg_miss_ms,
            // From the live store rather than the log: this is a statement
            // about what a caller can receive right now.
            oldest_held: state.api_cache.oldest(&slug).map(|d| d.as_secs()),
            held: state.api_cache.held(&slug) as u64,
        },
        keys: traffic.keys,
        callers: traffic.callers,
        refusals: traffic.refusals,
        calls: traffic.calls,
        failures: traffic.failures,
    }))
}

/// What a revision's statement actually returns.
///
/// Behind the sign-in rather than behind the endpoint's own credential,
/// because the audience is whoever *publishes* — the contract editor and the
/// endpoint page, both of which need to know whether a promise about a column
/// is one the statement can keep.
///
/// It is a `DESCRIBE`, so it reads no data and never reaches a result set. The
/// placeholders are filled with the endpoint's defaults where it has them and
/// with a probe of the declared type where it does not, which is the same
/// thing the OpenAPI document does and for the same reason: a statement with a
/// required parameter would otherwise have no describable shape at all.
pub async fn endpoint_columns(
    _: SignedIn,
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(pin): Query<RevisionPin>,
) -> Result<Json<EndpointColumns>> {
    let slug = slug.to_lowercase();
    let revisions = workspace(&state)?
        .published_revisions(&state.ch, &slug)
        .await?;
    let endpoint = match pin.v {
        Some(v) => revisions.iter().find(|r| r.revision == v),
        // The live one, or the newest there is where nothing is live — the
        // same revision the page opens on, so the two cannot disagree about
        // which statement is being described.
        None => revisions
            .iter()
            .find(|r| RevisionState::parse(&r.state) == RevisionState::Live)
            .or_else(|| revisions.first()),
    }
    .ok_or_else(|| Error::NotFound(format!("no endpoint at `{slug}`")))?;

    let declared = crate::published::declared_params_typed(&endpoint.sql);
    let defaults = super::data::defaults_of(endpoint);
    // `None` where Flint could not describe it without running it. Absent
    // rather than empty: "it returns nothing" and "nobody could find out" are
    // different answers, and only one of them should make a page mark every
    // promised column as unkeepable.
    let columns = super::data::describe_with_probe(&state, endpoint, &declared, &defaults).await;
    Ok(Json(EndpointColumns {
        revision: endpoint.revision,
        known: columns.is_some(),
        columns: columns.unwrap_or_default(),
    }))
}

#[derive(Deserialize)]
pub struct RevisionPin {
    #[serde(default)]
    pub v: Option<u32>,
}

#[derive(serde::Serialize)]
pub struct EndpointColumns {
    pub revision: u32,
    /// False where Flint could not describe the statement without running it.
    /// Every consumer checks this before concluding anything from an empty
    /// list.
    pub known: bool,
    pub columns: Vec<crate::clickhouse::ColumnMeta>,
}

// ── Keys ───────────────────────────────────────────────────────────────────

pub async fn api_keys(_: SignedIn, State(state): State<AppState>) -> Result<Json<Vec<ApiKey>>> {
    Ok(Json(workspace(&state)?.api_keys(&state.ch).await?))
}

pub async fn save_api_key(
    _: SignedIn,
    State(state): State<AppState>,
    Json(input): Json<ApiKeyInput>,
) -> Result<Json<crate::workspace::ApiKeySaved>> {
    Ok(Json(
        workspace(&state)?.save_api_key(&state.ch, input).await?,
    ))
}

pub async fn remove_api_key(
    _: SignedIn,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    if !valid_uuid(&id) {
        return Err(Error::BadRequest(format!("`{id}` is not a key id")));
    }
    workspace(&state)?.remove_api_key(&state.ch, &id).await?;
    Ok(Json(json!({ "deleted": id })))
}

pub async fn remove_published(
    _: SignedIn,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    if !valid_uuid(&id) {
        return Err(Error::BadRequest(format!("`{id}` is not an endpoint id")));
    }
    let ws = workspace(&state)?;
    let slug = ws
        .published(&state.ch)
        .await?
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| p.slug);
    ws.remove_published(&state.ch, &id).await?;
    if let Some(slug) = slug {
        state.api_cache.forget(&slug);
    }
    Ok(Json(json!({ "deleted": id })))
}
