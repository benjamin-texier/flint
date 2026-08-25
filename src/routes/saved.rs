use axum::extract::{Path, State};
use axum::Json;
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::workspace::{
    Alert, AlertEvent, AlertInput, Dashboard, DashboardInput, Published, PublishedInput, Report,
    ReportInput, ReportRun, SaveInput, SavedQuery,
};

use super::AppState;

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

pub async fn list(State(state): State<AppState>) -> Result<Json<Vec<SavedQuery>>> {
    Ok(Json(workspace(&state)?.list(&state.ch).await?))
}

pub async fn save(
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

pub async fn remove(State(state): State<AppState>, Path(id): Path<String>) -> Result<Json<Value>> {
    if !valid_uuid(&id) {
        return Err(Error::BadRequest(format!("`{id}` is not a saved-query id")));
    }
    workspace(&state)?.remove(&state.ch, &id).await?;
    Ok(Json(json!({ "deleted": id })))
}

pub async fn dashboards(State(state): State<AppState>) -> Result<Json<Vec<Dashboard>>> {
    Ok(Json(workspace(&state)?.dashboards(&state.ch).await?))
}

pub async fn save_dashboard(
    State(state): State<AppState>,
    Json(input): Json<DashboardInput>,
) -> Result<Json<Dashboard>> {
    Ok(Json(
        workspace(&state)?.save_dashboard(&state.ch, input).await?,
    ))
}

pub async fn remove_dashboard(
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

pub async fn alerts(State(state): State<AppState>) -> Result<Json<Vec<Alert>>> {
    Ok(Json(workspace(&state)?.alerts(&state.ch).await?))
}

pub async fn save_alert(
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

pub async fn reports(State(state): State<AppState>) -> Result<Json<Vec<Report>>> {
    Ok(Json(workspace(&state)?.reports(&state.ch).await?))
}

pub async fn save_report(
    State(state): State<AppState>,
    Json(input): Json<ReportInput>,
) -> Result<Json<Vec<Report>>> {
    let ws = workspace(&state)?;
    ws.save_report(&state.ch, input).await?;
    Ok(Json(ws.reports(&state.ch).await?))
}

pub async fn remove_report(
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
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
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
    let runner = state.runner.as_ref().ok_or_else(|| {
        Error::BadRequest(
            "reports run only where a workspace is configured, and this Flint has none".into(),
        )
    })?;
    let run_id = runner.run_report(&report).await;
    Ok(Json(json!({ "run_id": run_id, "report": report.name })))
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

pub async fn published(State(state): State<AppState>) -> Result<Json<Vec<Published>>> {
    Ok(Json(workspace(&state)?.published(&state.ch).await?))
}

pub async fn save_published(
    State(state): State<AppState>,
    Json(input): Json<PublishedInput>,
) -> Result<Json<Vec<Published>>> {
    Ok(Json(
        workspace(&state)?.save_published(&state.ch, input).await?,
    ))
}

pub async fn remove_published(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    if !valid_uuid(&id) {
        return Err(Error::BadRequest(format!("`{id}` is not an endpoint id")));
    }
    workspace(&state)?.remove_published(&state.ch, &id).await?;
    Ok(Json(json!({ "deleted": id })))
}
