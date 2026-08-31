//! Long operations: submit one, list them, stop one.
//!
//! The first kind is `OPTIMIZE`, which is the smallest honest job: it is a real
//! thing operators want a button for, it takes as long as it takes, and it is
//! observable and stoppable on the server — so it exercises every part of the
//! runner rather than being a placeholder for a future that justifies it.

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::clickhouse::backups::{backup_statement, valid_file_name, BackupAction};
use crate::clickhouse::parts::{
    freeze_name, object_statement, part_statement, partition_statement, valid_part_name,
    valid_partition_id, ObjectAction, PartAction, PartitionAction,
};
use crate::clickhouse::{meta, rbac};
use crate::config::Tier;
use crate::error::{Error, Result};
use crate::jobs::{optimize_statement, replica_statement, JobSpec, ReplicaAction, Runner};
use crate::workspace::Job;

use super::{AppState, Caller, SignedIn};

#[derive(Debug, Deserialize)]
pub struct ListParams {
    #[serde(default = "default_limit")]
    limit: u64,
}

fn default_limit() -> u64 {
    50
}

/// Every recent job, newest first.
///
/// Read with Flint's own account, like the rest of the workspace: the list is
/// Flint's bookkeeping about itself, and each row already records whose
/// credentials ran the statement.
pub async fn list(
    _: SignedIn,
    State(state): State<AppState>,
    Query(params): Query<ListParams>,
) -> Result<Json<Value>> {
    // Not an error where there is no workspace — just nothing to show, and the
    // reason, so the page can say why instead of looking broken.
    let Some(ws) = state.workspace.as_ref() else {
        return Ok(Json(json!({
            "available": false,
            "reason": "Flint is running without a workspace, so it keeps no record of long \
                       operations",
            "jobs": [],
        })));
    };
    let jobs: Vec<Job> = ws.jobs(&state.ch, params.limit).await?;
    Ok(Json(json!({ "available": true, "jobs": jobs })))
}

#[derive(Debug, Deserialize)]
pub struct OptimizeRequest {
    pub database: String,
    pub table: String,
    /// `FINAL` merges everything into one part per partition, which is what
    /// people usually mean and also the expensive version. Off by default: the
    /// caller says so on purpose.
    #[serde(default)]
    pub final_pass: bool,
}

/// Merge a table's parts, as a job.
///
/// Gated at the `ddl` tier — an `OPTIMIZE` writes no rows and changes no
/// structure, but it rewrites storage and can cost hours of I/O on a large
/// table, which puts it with the operations that reshape things rather than with
/// the ones that read them.
pub async fn optimize(
    State(state): State<AppState>,
    Caller(ch): Caller,
    headers: HeaderMap,
    Json(req): Json<OptimizeRequest>,
) -> Result<Json<Job>> {
    state.require_tier(Tier::Ddl)?;
    let runner = state.job_runner()?;

    let database = name(&req.database, "database")?;
    let table = name(&req.table, "table")?;

    // That the object exists, and is something an OPTIMIZE means anything for.
    // `OPTIMIZE` on a view is accepted by ClickHouse and does nothing, which is
    // a worse answer than being told.
    let engine = meta::table_engine(&ch, &database, &table).await?;
    if !engine.contains("MergeTree") {
        return Err(Error::BadRequest(format!(
            "`{database}.{table}` is a {engine}, and only a MergeTree table has parts to merge"
        )));
    }

    let statement = optimize_statement(&database, &table, req.final_pass);
    let spec = JobSpec {
        kind: "optimize",
        label: format!(
            "Optimize {database}.{table}{}",
            if req.final_pass { " (final)" } else { "" }
        ),
        target: format!("{database}.{table}"),
        statement: statement.clone(),
        tier: state.config.tier().as_str().to_string(),
    };
    let who = state.caller_name(&headers);
    Ok(Json(
        runner
            .submit(spec, &who, Runner::statement_work(ch, statement))
            .await?,
    ))
}

/// Ask the server to stop a job.
pub async fn cancel(
    State(state): State<AppState>,
    Caller(ch): Caller,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    if !super::is_uuid(&id) {
        return Err(Error::BadRequest(format!("`{id}` is not a job id")));
    }
    let runner = state.job_runner()?;
    let ws = state
        .workspace
        .as_ref()
        .expect("a runner implies a workspace");
    let job = ws
        .job(&state.ch, &id)
        .await?
        .ok_or_else(|| Error::NotFound(format!("there is no job `{id}`")))?;
    runner.cancel(&job, &ch).await?;
    Ok(Json(json!({
        "cancelling": id,
        // Said plainly: `KILL QUERY` stops the statement Flint is waiting on,
        // and a merge the server has already begun finishes in its own time.
        "note": "the server was asked to stop; work already begun may still finish",
    })))
}

/// A database or table name Flint is willing to put in a statement it quotes
/// itself.
///
/// `OPTIMIZE` takes no query parameters, so this is one of the few places where
/// the identifier cannot be handed to ClickHouse to quote. Back-quotes are
/// escaped when the statement is built; what is refused here is the shape that
/// has no business being a name at all — empty, absurdly long, or carrying a
/// control character or a newline.
fn name(raw: &str, what: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(Error::BadRequest(format!("a {what} name is required")));
    }
    if trimmed.len() > 255 {
        return Err(Error::BadRequest(format!(
            "that {what} name is longer than any ClickHouse identifier"
        )));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(Error::BadRequest(format!(
            "that {what} name contains a control character"
        )));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_must_be_something_that_could_be_a_name() {
        assert!(name("events", "table").is_ok());
        assert!(name("  events  ", "table").unwrap() == "events");
        assert!(name("", "table").is_err());
        assert!(name("   ", "table").is_err());
        assert!(name(&"x".repeat(256), "table").is_err());
        // The one that matters: a newline would end the statement Flint quotes.
        assert!(name("events\nDROP TABLE x", "table").is_err());
        assert!(name("events\0", "table").is_err());
        // A back-quote is allowed through, because the statement builder doubles
        // it — refusing it would refuse a legal ClickHouse name.
        assert!(name("we`ird", "table").is_ok());
    }
}

#[derive(Debug, Deserialize)]
pub struct ReplicaRequest {
    pub database: String,
    pub table: String,
    pub action: ReplicaAction,
}

/// Ask something of one replica, as a job.
///
/// At the `admin` tier: these do not touch a row or a column, they operate the
/// server — and `RESTART REPLICA` on a busy table is the kind of thing somebody
/// should have decided to allow before the button existed.
///
/// The table has to *be* replicated, and that is checked rather than assumed:
/// `SYSTEM SYNC REPLICA` on an ordinary MergeTree answers with an error about the
/// table not being replicated, which is a true sentence in the wrong vocabulary.
pub async fn replica(
    State(state): State<AppState>,
    Caller(ch): Caller,
    headers: HeaderMap,
    Json(req): Json<ReplicaRequest>,
) -> Result<Json<Job>> {
    state.require_tier(Tier::Admin)?;
    let runner = state.job_runner()?;

    let database = name(&req.database, "database")?;
    let table = name(&req.table, "table")?;

    let engine = meta::table_engine(&ch, &database, &table).await?;
    if !engine.starts_with("Replicated") {
        return Err(Error::BadRequest(format!(
            "`{database}.{table}` is a {engine}, and only a Replicated engine has a replica to \
             act on"
        )));
    }

    let statement = replica_statement(req.action, &database, &table);
    let spec = JobSpec {
        kind: req.action.kind(),
        label: req.action.label(&database, &table),
        target: format!("{database}.{table}"),
        statement: statement.clone(),
        tier: state.config.tier().as_str().to_string(),
    };
    let who = state.caller_name(&headers);
    Ok(Json(
        runner
            .submit(spec, &who, Runner::statement_work(ch, statement))
            .await?,
    ))
}

#[derive(Debug, Deserialize)]
pub struct PartRequest {
    pub database: String,
    pub table: String,
    /// The directory name as `system.detached_parts` reports it.
    pub part: String,
    pub action: PartAction,
}

/// Attach a detached part, or delete it.
///
/// Two tiers, because they are not two versions of the same act. Attaching puts
/// data back and is undone by detaching again; dropping a detached part deletes
/// it from the disk with nothing to undo it, so it sits with the operations that
/// run the server rather than with the ones that reshape a schema.
pub async fn detached_part(
    State(state): State<AppState>,
    Caller(ch): Caller,
    headers: HeaderMap,
    Json(req): Json<PartRequest>,
) -> Result<Json<Job>> {
    state.require_tier(match req.action {
        PartAction::Attach => Tier::Ddl,
        PartAction::Drop => Tier::Admin,
    })?;
    let runner = state.job_runner()?;

    let database = name(&req.database, "database")?;
    let table = name(&req.table, "table")?;
    if !valid_part_name(&req.part) {
        return Err(Error::BadRequest(format!(
            "`{}` is not the name of a detached part",
            req.part
        )));
    }

    // That the part is actually detached, and belongs to that table. Without
    // this, a typo in the name reaches ClickHouse as "not found" — true, and
    // indistinguishable from a part that was already dealt with by somebody else
    // a second ago.
    let known = detached_exists(&ch, &database, &table, &req.part).await?;
    if !known {
        return Err(Error::NotFound(format!(
            "`{}` is not a detached part of {database}.{table} — it may have been attached or \
             deleted already",
            req.part
        )));
    }

    let statement = part_statement(req.action, &database, &table, &req.part);
    let spec = JobSpec {
        kind: req.action.kind(),
        label: req.action.label(&format!("{database}.{table}"), &req.part),
        target: format!("{database}.{table}"),
        statement: statement.clone(),
        tier: state.config.tier().as_str().to_string(),
    };
    let who = state.caller_name(&headers);
    Ok(Json(
        runner
            .submit(spec, &who, Runner::statement_work(ch, statement))
            .await?,
    ))
}

async fn detached_exists(
    ch: &crate::clickhouse::Client,
    database: &str,
    table: &str,
    part: &str,
) -> Result<bool> {
    #[derive(serde::Deserialize)]
    struct Row {
        n: u64,
    }
    let row: Option<Row> = ch
        .row_with(
            "SELECT count() AS n FROM system.detached_parts \
             WHERE database = {db:String} AND table = {tbl:String} AND name = {p:String}",
            crate::clickhouse::QueryOptions {
                params: vec![
                    ("db".into(), database.to_string()),
                    ("tbl".into(), table.to_string()),
                    ("p".into(), part.to_string()),
                ],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;
    Ok(row.map(|r| r.n > 0).unwrap_or(false))
}

#[derive(Debug, Deserialize)]
pub struct PartitionRequest {
    pub database: String,
    pub table: String,
    /// The opaque id from `system.parts.partition_id`, not the human expression.
    pub partition_id: String,
    pub action: PartitionAction,
    /// A volume or disk name, for the actions that move data. Absent otherwise,
    /// and refused where the action does not take one — a destination silently
    /// ignored is a destination somebody thought was applied.
    #[serde(default)]
    pub destination: Option<String>,
}

/// Detach, freeze or drop a whole partition.
///
/// Three tiers' worth of consequence in one route, so the tier is per action.
/// Detaching leaves the data in `detached/`, where the detached-parts screen can
/// put it back. Freezing hard-links a copy and takes nothing away. Dropping
/// deletes rows with nothing to undo it.
pub async fn partition(
    State(state): State<AppState>,
    Caller(ch): Caller,
    headers: HeaderMap,
    Json(req): Json<PartitionRequest>,
) -> Result<Json<Job>> {
    state.require_tier(match req.action {
        // Reversible: `detached/` keeps the data and Flint can attach it back.
        PartitionAction::Detach => Tier::Ddl,
        // Takes nothing away, and adds a copy that most servers cannot remove
        // by statement — a fact the UI states rather than hides.
        PartitionAction::Freeze => Tier::Ddl,
        // Rows gone. That is operating a server, not reshaping a schema.
        PartitionAction::Drop => Tier::Admin,
        // Moving data between volumes destroys nothing and changes where the
        // bytes are, which is reshaping storage rather than operating a server.
        PartitionAction::MoveToVolume | PartitionAction::MoveToDisk => Tier::Ddl,
    })?;
    let runner = state.job_runner()?;

    let database = name(&req.database, "database")?;
    let table = name(&req.table, "table")?;
    if !valid_partition_id(&req.partition_id) {
        return Err(Error::BadRequest(format!(
            "`{}` is not a partition id. Flint uses the id ClickHouse reports, not the \
             partition expression — `all` where a table has no partition key.",
            req.partition_id
        )));
    }

    // The partition has to exist *and* be active, or the statement succeeds
    // silently against nothing and the job says "done" about work that did not
    // happen.
    let (parts, rows) = partition_size(&ch, &database, &table, &req.partition_id).await?;
    if parts == 0 {
        return Err(Error::NotFound(format!(
            "{database}.{table} has no active partition `{}` — it may have been dropped or \
             detached already",
            req.partition_id
        )));
    }

    // A move needs somewhere to go, and the name goes into a quoted literal, so
    // it is checked the same way the partition id is.
    let destination = req.destination.clone().unwrap_or_default();
    if req.action.needs_destination() {
        if !crate::clickhouse::parts::valid_storage_name(&destination) {
            return Err(Error::BadRequest(
                "a volume or disk name is required to move a partition, made of letters, \
                 digits, underscores and hyphens"
                    .into(),
            ));
        }
    } else if !destination.is_empty() {
        return Err(Error::BadRequest(format!(
            "`{}` does not take a destination",
            req.action
                .label(&format!("{database}.{table}"), &req.partition_id)
        )));
    }

    let freeze = freeze_name(&req.partition_id);
    let statement = partition_statement(
        req.action,
        &database,
        &table,
        &req.partition_id,
        &freeze,
        &destination,
    );
    let spec = JobSpec {
        kind: req.action.kind(),
        // The row count is in the label on purpose: a job list is read after the
        // fact, and "Drop 202605 of analytics.events" without it leaves nobody
        // able to tell what was lost.
        label: format!(
            "{} ({} rows in {} part{})",
            req.action
                .label(&format!("{database}.{table}"), &req.partition_id),
            rows,
            parts,
            if parts == 1 { "" } else { "s" }
        ),
        target: format!("{database}.{table}"),
        statement: statement.clone(),
        tier: state.config.tier().as_str().to_string(),
    };
    let who = state.caller_name(&headers);
    Ok(Json(
        runner
            .submit(spec, &who, Runner::statement_work(ch, statement))
            .await?,
    ))
}

/// How much is in one active partition: parts and rows.
async fn partition_size(
    ch: &crate::clickhouse::Client,
    database: &str,
    table: &str,
    partition_id: &str,
) -> Result<(u64, u64)> {
    #[derive(serde::Deserialize)]
    struct Row {
        parts: u64,
        rows: u64,
    }
    let row: Option<Row> = ch
        .row_with(
            "SELECT toUInt64(count()) AS parts, toUInt64(sum(rows)) AS rows \
             FROM system.parts \
             WHERE active AND database = {db:String} AND table = {tbl:String} \
               AND partition_id = {p:String}",
            crate::clickhouse::QueryOptions {
                params: vec![
                    ("db".into(), database.to_string()),
                    ("tbl".into(), table.to_string()),
                    ("p".into(), partition_id.to_string()),
                ],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;
    Ok(row.map(|r| (r.parts, r.rows)).unwrap_or((0, 0)))
}

#[derive(Debug, Deserialize)]
pub struct ObjectRequest {
    pub database: String,
    pub table: String,
    pub action: ObjectAction,
}

/// Empty an object, or remove it.
///
/// Both at `admin`, and the tier line is worth stating because it is not the one
/// the roadmap first drew. That line was "structure is `ddl`, the server is
/// `admin`" — and it put `DROP TABLE` with `CREATE`. The line that survived
/// contact with the work is **data loss**: creating, renaming and altering a
/// schema destroy nothing and sit at `ddl`; truncating, dropping a partition,
/// deleting a detached part and dropping a table all destroy rows, and sit here.
/// A deployment that wants people reshaping schemas without being able to delete
/// data is a real deployment, and the first line could not express it.
pub async fn object(
    State(state): State<AppState>,
    Caller(ch): Caller,
    headers: HeaderMap,
    Json(req): Json<ObjectRequest>,
) -> Result<Json<Job>> {
    state.require_tier(Tier::Admin)?;
    let runner = state.job_runner()?;

    let database = name(&req.database, "database")?;
    let table = name(&req.table, "table")?;

    // What it is, which decides the wording, and that it is there at all.
    let engine = meta::table_engine(&ch, &database, &table).await?;
    let kind = match engine.as_str() {
        "MaterializedView" => "materialized view",
        "View" => "view",
        "Dictionary" => "dictionary",
        _ => "table",
    };
    if matches!(req.action, ObjectAction::Truncate) && kind != "table" {
        return Err(Error::BadRequest(format!(
            "`{database}.{table}` is a {kind} and stores nothing, so there is nothing to \
             truncate"
        )));
    }

    let statement = object_statement(req.action, &database, &table);
    let qualified = format!("{database}.{table}");
    // What is about to be lost, recorded in the label. A job list is read after
    // the fact, and "Drop table analytics.events" without a row count leaves
    // nobody able to tell what it cost.
    let impact = crate::clickhouse::graph::impact(&ch, &database, &table).await?;
    let breaks = impact.dependents.len();
    let spec = JobSpec {
        kind: req.action.kind(),
        label: format!(
            "{} ({} rows{})",
            req.action.label(&qualified, kind),
            impact.rows,
            if breaks > 0 {
                format!(
                    ", {breaks} object{} read it",
                    if breaks == 1 { "" } else { "s" }
                )
            } else {
                String::new()
            }
        ),
        target: qualified,
        statement: statement.clone(),
        tier: state.config.tier().as_str().to_string(),
    };
    let who = state.caller_name(&headers);
    Ok(Json(
        runner
            .submit(spec, &who, Runner::statement_work(ch, statement))
            .await?,
    ))
}

#[derive(Debug, Deserialize)]
pub struct BackupRequest {
    pub database: String,
    /// Absent or empty for the whole database.
    ///
    /// One statement rather than a loop over the tables, and that matters for
    /// what "done" means: `RESTORE DATABASE` puts the table *definitions* back
    /// too, so a database that was dropped entirely comes back whole. Restoring
    /// table by table would need the tables to exist first, which after a drop
    /// they do not.
    #[serde(default)]
    pub table: String,
    /// The file on the configured disk. Named by whoever asks, because a backup
    /// nobody can find again is not one.
    pub file: String,
    pub action: BackupAction,
}

/// Take a backup, or read one back.
///
/// Taking one is `ddl`: it reads data and writes a file, and destroys nothing.
/// Restoring is `admin`, and is refused unless the table is **absent** — a
/// genuine recovery. ClickHouse will happily restore over an existing table
/// given the right setting, and that is a different decision from "put back what
/// was lost"; offering both behind one button would make the safe case carry the
/// dangerous one's risk.
pub async fn backup(
    State(state): State<AppState>,
    Caller(ch): Caller,
    headers: HeaderMap,
    Json(req): Json<BackupRequest>,
) -> Result<Json<Job>> {
    state.require_tier(match req.action {
        BackupAction::Take => Tier::Ddl,
        BackupAction::Restore => Tier::Admin,
    })?;
    let runner = state.job_runner()?;

    let Some(disk) = state.config.backup_disk.clone() else {
        return Err(Error::BadRequest(
            "this Flint has no backup destination. ClickHouse refuses `BACKUP … TO Disk(…)` \
             unless the server sanctions the disk, and Flint cannot read that setting — so name \
             the disk in FLINT_BACKUP_DISK."
                .into(),
        ));
    };

    let database = name(&req.database, "database")?;
    // Empty is the whole database, so it is not held to the rule a name is held
    // to — but anything that is not empty still is.
    let table = if req.table.trim().is_empty() {
        String::new()
    } else {
        name(&req.table, "table")?
    };
    if !valid_file_name(&req.file) {
        return Err(Error::BadRequest(format!(
            "`{}` is not a file name Flint will write: letters, digits, `_`, `-` and `.`, and \
             nothing that walks up a directory",
            req.file
        )));
    }
    // Where the destination is object storage the format is not a preference.
    // Refused here rather than left to the server, whose answer is correct and
    // arrives in the job list after the button.
    let object_storage = crate::clickhouse::backups::disk_is_object_storage(&ch, &disk)
        .await
        .unwrap_or(false);
    if let Some(why) = crate::clickhouse::backups::format_refusal(&req.file, object_storage) {
        return Err(Error::BadRequest(why));
    }

    // It has to be there to back up, and *not* there to restore into. For a
    // whole database that is the database's own existence, which is a different
    // read from a table's engine.
    let whole = table.is_empty();
    let qualified = if whole {
        database.clone()
    } else {
        format!("{database}.{table}")
    };
    let exists = if whole {
        database_exists(&ch, &database).await?
    } else {
        meta::table_engine(&ch, &database, &table).await.is_ok()
    };
    let what = if whole { "database" } else { "table" };
    match req.action {
        BackupAction::Take if !exists => {
            return Err(Error::NotFound(format!(
                "there is no {what} `{qualified}` that this user can see"
            )))
        }
        BackupAction::Restore if exists => {
            return Err(Error::BadRequest(format!(
                "the {what} `{qualified}` is already there. Flint restores what is missing, not \
                 over what is — drop it first if that is what you mean, so the decision is one \
                 somebody made rather than one a button made for them."
            )))
        }
        _ => {}
    }

    let statement = backup_statement(req.action, &database, &table, &disk, &req.file);
    let spec = JobSpec {
        kind: req.action.kind(),
        label: match req.action {
            // The scope in the label, because "Restore analytics from x.zip"
            // and "Restore analytics.events from x.zip" are read weeks later
            // and the first would otherwise look like a truncated second.
            BackupAction::Take => format!("Back up {what} {qualified} to {}", req.file),
            BackupAction::Restore => format!("Restore {what} {qualified} from {}", req.file),
        },
        target: qualified,
        statement: statement.clone(),
        tier: state.config.tier().as_str().to_string(),
    };
    let who = state.caller_name(&headers);
    Ok(Json(
        runner
            .submit(spec, &who, Runner::statement_work(ch, statement))
            .await?,
    ))
}

// ── Access control ─────────────────────────────────────────────────────────

/// Change who can do what.
///
/// One endpoint for all nine changes rather than nine endpoints, because the
/// checks are the same for all of them and are the substance of the handler:
/// the tier, the names, the privileges the server admits, and whether the
/// subject can be altered by SQL at all.
///
/// `admin` tier, which the enum's own doc already named access as belonging to.
/// The reasoning is not that a grant destroys data — it does not — but that a
/// grant is the only write here that hands somebody *else* every other one.
pub async fn access(
    State(state): State<AppState>,
    Caller(ch): Caller,
    headers: HeaderMap,
    Json(change): Json<rbac::Change>,
) -> Result<Json<Job>> {
    state.require_tier(Tier::Admin)?;
    let runner = state.job_runner()?;

    check_names(&change)?;
    check_privileges(&ch, &change).await?;

    let subject = change.subject();
    let who = state.caller_name(&headers);

    // Two of these can lock an account out immediately, and the server reports
    // both as `AUTHENTICATION_FAILED` — "password is incorrect, or there is no
    // user with such name". Measured: a past `VALID UNTIL` and a `HOST IP` that
    // excludes where the account connects from both do it, and both are told to
    // the locked-out person as a wrong password.
    //
    // Aimed at the account *this request is signed in as*, that is Flint locking
    // itself out of the server, and the next thing anybody sees is a login screen
    // blaming their password. Refused rather than confirmed: a confirmation is
    // for a decision, and this is a decision nobody makes on purpose from here.
    if subject.name == who {
        if let Some(why) = self_lockout(&ch, &change).await? {
            return Err(Error::BadRequest(format!(
                "{why} You are signed in as `{who}`, so this would lock you out of Flint, and \
                 the sign-in screen would tell you your password was wrong. Do it from another \
                 account, or to another one."
            )));
        }
    }

    if !change.creates() {
        // Refused here rather than left to the server. ClickHouse answers code
        // 495 `ACCESS_STORAGE_READONLY`, which is correct and arrives in the job
        // list several seconds after the button — where the person who pressed
        // it is no longer looking. The same fact, said in the form.
        if let Some(storage) = readonly_storage(&ch, &subject).await? {
            return Err(Error::BadRequest(format!(
                "`{}` is defined in `{storage}`, and ClickHouse will not let SQL change an \
                 account from there — its definition lives in a file, and whatever deploys that \
                 file owns it. Edit the file, or make the account with SQL instead.",
                subject.name
            )));
        }
    }

    let statement = rbac::statement(&change);
    let spec = JobSpec {
        kind: change.kind(),
        label: rbac::label(&change),
        target: subject.name,
        // The recorded half, never the sent one. The two differ exactly when the
        // statement carries a password, and this is the line that keeps it out
        // of a table with a thirty-day TTL.
        statement: statement.recorded,
        tier: state.config.tier().as_str().to_string(),
    };
    Ok(Json(
        runner
            .submit(spec, &who, Runner::statement_work(ch, statement.sql))
            .await?,
    ))
}

/// Whether this change would lock its own subject out, and why.
///
/// The date comparison is the *server's*, not Flint's: an expiry is judged by the
/// clock that will enforce it, and a container whose clock has drifted would
/// otherwise have Flint permit what the server is about to refuse.
async fn self_lockout(
    ch: &crate::clickhouse::Client,
    change: &rbac::Change,
) -> Result<Option<String>> {
    match change {
        rbac::Change::SetHosts { ips, names, .. } => {
            if ips.is_empty() && names.is_empty() {
                // `HOST ANY` widens, so it cannot lock anybody out.
                return Ok(None);
            }
            Ok(Some(
                "Restricting where an account may connect from locks it out of everywhere else."
                    .to_string(),
            ))
        }
        rbac::Change::SetValidUntil { until, .. } => {
            if until.eq_ignore_ascii_case("infinity") {
                return Ok(None);
            }
            #[derive(serde::Deserialize)]
            struct Row {
                past: u8,
            }
            let row: Option<Row> = ch
                .row_with(
                    "SELECT toUInt8(parseDateTimeBestEffortOrNull({u:String}) <= now()) AS past",
                    crate::clickhouse::QueryOptions {
                        params: vec![("u".into(), until.to_string())],
                        quote_64bit_integers: false,
                        introspection: true,
                        ..Default::default()
                    },
                )
                .await?;
            Ok(match row.map(|r| r.past == 1) {
                Some(true) => {
                    Some("An expiry in the past stops the account working immediately.".to_string())
                }
                _ => None,
            })
        }
        _ => Ok(None),
    }
}

/// Every name the change carries, checked before any of it reaches a statement.
fn check_names(change: &rbac::Change) -> Result<()> {
    let mut names: Vec<(&str, &str)> = Vec::new();
    let mut password: Option<&str> = None;
    match change {
        rbac::Change::CreateRole { role } | rbac::Change::DropRole { role } => {
            names.push(("role", role))
        }
        rbac::Change::GrantRole { role, to } | rbac::Change::RevokeRole { role, to } => {
            names.push(("role", role));
            names.push(("account", &to.name));
        }
        rbac::Change::CreateUser { user, password: p }
        | rbac::Change::SetPassword { user, password: p } => {
            names.push(("user", user));
            password = Some(p);
        }
        rbac::Change::DropUser { user } => names.push(("user", user)),
        rbac::Change::SetValidUntil { user, until } => {
            names.push(("user", user));
            if !rbac::valid_until(until) {
                return Err(Error::BadRequest(format!(
                    "`{until}` is not an expiry Flint will write. Give a date — `2027-01-01`, or \
                     `2027-01-01 09:00:00` — or `infinity` for never, which is the server's own \
                     word and what it stores as the epoch."
                )));
            }
        }
        rbac::Change::SetHosts {
            user,
            ips,
            names: hosts,
        } => {
            names.push(("user", user));
            for host in ips.iter().chain(hosts.iter()) {
                if !rbac::valid_host(host) {
                    return Err(Error::BadRequest(format!(
                        "`{host}` is not an address, a range or a host name Flint will write"
                    )));
                }
            }
        }
        rbac::Change::SetDefaultRoles { user, roles, .. } => {
            names.push(("user", user));
            for role in roles {
                names.push(("role", role));
            }
        }
        rbac::Change::Grant {
            database,
            table,
            to,
            ..
        }
        | rbac::Change::Revoke {
            database,
            table,
            to,
            ..
        } => {
            names.push(("account", &to.name));
            // `*` is the wildcard and not a name, so it is not held to the rule
            // a name is held to.
            if database != "*" {
                names.push(("database", database));
            }
            if table != "*" {
                names.push(("table", table));
            }
        }
    }
    for (what, name) in names {
        if !rbac::valid_name(name) {
            return Err(Error::BadRequest(format!(
                "`{name}` is not a {what} name Flint will put in a statement: it has to be \
                 something, under 200 characters, and free of control characters"
            )));
        }
    }
    if let Some(password) = password {
        if !rbac::valid_password(password) {
            return Err(Error::BadRequest(
                "a password is required. An account created without one can be connected to by \
                 anybody who knows its name, and one created with an empty string cannot be \
                 connected to at all while looking like it can."
                    .into(),
            ));
        }
    }
    Ok(())
}

/// Whether the server knows every privilege the change names.
///
/// Asked of `system.privileges` rather than of a list in this file. A hardcoded
/// set rots one release after it is written and rots silently — a privilege the
/// server gained would be one Flint refused, with no way to tell that from a
/// typo. This way what Flint accepts is what this ClickHouse understands, and
/// the error can say how many it does.
async fn check_privileges(ch: &crate::clickhouse::Client, change: &rbac::Change) -> Result<()> {
    let access = match change {
        rbac::Change::Grant { access, .. } | rbac::Change::Revoke { access, .. } => access,
        _ => return Ok(()),
    };
    if access.is_empty() {
        return Err(Error::BadRequest(
            "no privilege was named, so there is nothing to grant".into(),
        ));
    }

    #[derive(serde::Deserialize)]
    struct Row {
        privilege: String,
    }
    let known: std::collections::HashSet<String> = ch
        .rows::<Row>("SELECT privilege AS privilege FROM system.privileges")
        .await?
        .into_iter()
        .map(|r| r.privilege)
        .collect();

    for one in access {
        if !known.contains(one.as_str()) {
            return Err(Error::BadRequest(format!(
                "`{one}` is not one of the {} privileges this ClickHouse knows",
                known.len()
            )));
        }
    }
    Ok(())
}

/// The storage a subject lives in, when that storage refuses to be written.
///
/// `None` means either that it can be changed or that it does not exist — and
/// the second is deliberately not distinguished here: `GRANT … TO nobody` should
/// be refused by the server, in its own words, rather than by Flint guessing
/// which of the two it was.
async fn readonly_storage(
    ch: &crate::clickhouse::Client,
    subject: &rbac::Grantee,
) -> Result<Option<String>> {
    #[derive(serde::Deserialize)]
    struct Row {
        storage: String,
    }
    let table = if subject.is_user { "users" } else { "roles" };
    let row: Option<Row> = ch
        .row_with(
            &format!("SELECT storage AS storage FROM system.{table} WHERE name = {{name:String}}"),
            crate::clickhouse::QueryOptions {
                params: vec![("name".into(), subject.name.clone())],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;
    // `users_xml` is the one every stock server has; `ldap` and `kerberos` are
    // the same kind of fact, so the test is the name of the storage rather than
    // a list of the ones seen so far.
    Ok(row
        .map(|r| r.storage)
        .filter(|s| s != "local_directory" && s != "memory" && s != "replicated"))
}

// ── Operating the server ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SystemRequest {
    command: crate::clickhouse::sysops::Command,
}

/// Send one `SYSTEM` statement.
///
/// Through the runner like every other write, and for a reason that matters more
/// here than elsewhere: two of these commands change a state the server does not
/// report back. `SYSTEM STOP MERGES` leaves no flag anywhere — the `Merge`
/// metric reads zero whether merges are stopped or idle — so the job row saying
/// who stopped them and when is the only record that exists.
pub async fn system(
    State(state): State<AppState>,
    Caller(ch): Caller,
    headers: HeaderMap,
    Json(req): Json<SystemRequest>,
) -> Result<Json<Job>> {
    state.require_tier(Tier::Admin)?;
    let runner = state.job_runner()?;
    let command = req.command;
    let statement = command.statement().to_string();
    let spec = JobSpec {
        kind: command.kind(),
        label: command.label().to_string(),
        // The server, not an object in it. Left as the endpoint rather than
        // empty so a job list filtered by target still groups these together —
        // and read off the caller's own connection rather than the manifest,
        // which is the same address pinned and the only one there is unpinned.
        target: ch.endpoint().to_string(),
        statement: statement.clone(),
        tier: state.config.tier().as_str().to_string(),
    };
    let who = state.caller_name(&headers);
    Ok(Json(
        runner
            .submit(spec, &who, Runner::statement_work(ch, statement))
            .await?,
    ))
}

#[derive(Debug, Deserialize)]
pub struct DictionaryRequest {
    database: String,
    name: String,
}

/// Reload one dictionary, as a job.
///
/// `ddl` rather than `admin`: it destroys nothing and it is the ordinary repair
/// for a dictionary whose source has moved on — which is a thing somebody
/// reshaping a schema does, not a thing that operates the server. It is also the
/// one action on that page whose effect *is* observable, since the status and the
/// element count both change.
///
/// A large dictionary reloads by fetching its whole source again, so the job can
/// take as long as the source does and Flint's statement timeout is what ends it.
pub async fn reload_dictionary(
    State(state): State<AppState>,
    Caller(ch): Caller,
    headers: HeaderMap,
    Json(req): Json<DictionaryRequest>,
) -> Result<Json<Job>> {
    state.require_tier(Tier::Ddl)?;
    let runner = state.job_runner()?;

    let database = name(&req.database, "database")?;
    let dictionary = name(&req.name, "dictionary")?;
    let ident = |s: &str| format!("`{}`", s.replace('`', "``"));
    let qualified = format!("{database}.{dictionary}");
    let statement = format!(
        "SYSTEM RELOAD DICTIONARY {}.{}",
        ident(&database),
        ident(&dictionary)
    );

    let spec = JobSpec {
        kind: "reload-dictionary",
        label: format!("Reload dictionary {qualified}"),
        target: qualified,
        statement: statement.clone(),
        tier: state.config.tier().as_str().to_string(),
    };
    let who = state.caller_name(&headers);
    Ok(Json(
        runner
            .submit(spec, &who, Runner::statement_work(ch, statement))
            .await?,
    ))
}

#[derive(Debug, Deserialize)]
pub struct AlterRequest {
    database: String,
    table: String,
    #[serde(flatten)]
    change: crate::clickhouse::alter::Change,
}

/// Change a table's columns or its TTL, as a job.
///
/// The tier is per operation, on the documented line: dropping a column throws
/// its values away and a TTL deletes rows already past it, so those two are
/// `admin`; adding, renaming and retyping a column reshape structure and are
/// `ddl`. Removing a TTL stops deletions and is `ddl` for the same reason.
///
/// A type or a TTL expression reaches the server as written. Flint does not parse
/// ClickHouse's type grammar — it is large and it moves between versions, and a
/// validator here would refuse types this server understands. What it refuses is
/// a fragment carrying a semicolon or a comment opener, which is the only way one
/// of these could become two statements.
pub async fn alter(
    State(state): State<AppState>,
    Caller(ch): Caller,
    headers: HeaderMap,
    Json(req): Json<AlterRequest>,
) -> Result<Json<Job>> {
    use crate::clickhouse::alter;

    state.require_tier(if alter::destroys(&req.change) {
        Tier::Admin
    } else {
        Tier::Ddl
    })?;
    let runner = state.job_runner()?;

    let database = name(&req.database, "database")?;
    let table = name(&req.table, "table")?;
    for column in alter::names(&req.change) {
        name(column, "column")?;
    }
    for fragment in alter::fragments(&req.change) {
        if fragment.trim().is_empty() {
            return Err(Error::BadRequest(
                "a type or expression is required, and an empty one would make a statement the \
                 server cannot read"
                    .into(),
            ));
        }
        if fragment.contains(';') || fragment.contains("--") || fragment.contains("/*") {
            return Err(Error::BadRequest(format!(
                "`{fragment}` is not something Flint will put in a statement: a semicolon or a \
                 comment in a type or expression is the one way this could become two statements"
            )));
        }
    }

    // The engine says whether "done" will mean done everywhere, and the size
    // says what the rewrite costs. Both are read before the change so the label
    // describes the table it acted on rather than the one it left behind.
    let engine = meta::table_engine(&ch, &database, &table).await?;
    let replicated = engine.starts_with("Replicated");
    let (parts, rows) = crate::clickhouse::meta::table_extent(&ch, &database, &table).await?;

    let statement = alter::statement(&req.change, &database, &table);
    let qualified = format!("{database}.{table}");
    let spec = JobSpec {
        kind: alter::kind(&req.change),
        // The cost in the label, not only in the form: a job list is read after
        // the fact, and "Drop column label of analytics.events" without the rows
        // leaves nobody able to tell what it took.
        label: format!(
            "{} ({}{})",
            alter::label(&req.change, &qualified),
            if alter::rewrites(&req.change) {
                format!(
                    "rewrote {rows} rows in {parts} part{}",
                    if parts == 1 { "" } else { "s" }
                )
            } else {
                "metadata only".to_string()
            },
            // What "done" will have meant, recorded where it is read later. On a
            // replicated table `alter_sync`'s default waits for this replica and
            // not the others, and a job list that does not say so invites
            // reading it as "applied everywhere".
            if replicated && alter::rewrites(&req.change) {
                ", on this replica"
            } else {
                ""
            }
        ),
        target: qualified,
        statement: statement.clone(),
        tier: state.config.tier().as_str().to_string(),
    };
    let who = state.caller_name(&headers);
    Ok(Json(
        runner
            .submit(spec, &who, Runner::statement_work(ch, statement))
            .await?,
    ))
}

#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    statement: String,
}

/// Run a `CREATE` somebody wrote.
///
/// `ddl`: it makes something and destroys nothing, which is what that tier is
/// for. The one shape that would destroy something — `CREATE OR REPLACE` over an
/// existing table — is refused rather than promoted to `admin`, for the same
/// reason the restore control refuses to write over a table that is there: it
/// should be a decision somebody made and not one a form made for them.
///
/// The statement itself is not parsed, and does not need to be: ClickHouse's HTTP
/// interface refuses a body holding more than one statement and runs neither of
/// them. What Flint checks is its own policy — that this is a `CREATE`, because
/// dropping, inserting and altering have their own controls where the tier and
/// the confirmation belong to what they do.
pub async fn create(
    State(state): State<AppState>,
    Caller(ch): Caller,
    headers: HeaderMap,
    Json(req): Json<CreateRequest>,
) -> Result<Json<Job>> {
    state.require_tier(Tier::Ddl)?;
    let runner = state.job_runner()?;

    if let Some(why) = crate::clickhouse::ddl::refusal(&req.statement) {
        return Err(Error::BadRequest(why));
    }

    // The first line, for the label. A `CREATE TABLE` of forty columns is one
    // statement and forty lines, and a job list is unreadable with forty lines
    // in a cell — the statement itself is recorded in full beside it.
    let summary: String = req
        .statement
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .chars()
        .take(120)
        .collect();

    let spec = JobSpec {
        kind: "create",
        label: summary.clone(),
        // No one object: the statement names what it makes, and guessing the name
        // out of it would mean parsing what this route deliberately does not.
        target: ch.endpoint().to_string(),
        statement: req.statement.clone(),
        tier: state.config.tier().as_str().to_string(),
    };
    let who = state.caller_name(&headers);
    Ok(Json(
        runner
            .submit(spec, &who, Runner::statement_work(ch, req.statement))
            .await?,
    ))
}

/// Create or drop a quota, a settings profile or a row policy.
///
/// `admin`, like the rest of access control: none of these deletes a row, but a
/// row policy decides which rows somebody sees and a quota decides how many
/// queries they get, and those are the same kind of decision as a grant.
///
/// The statements are built rather than typed, and `govern.rs` says why for each
/// of the three. What this route adds is the identifier checks and the refusal of
/// a fragment carrying a semicolon — a `USING` expression and a setting's value
/// reach the server as written, for the same reason a type does.
pub async fn govern(
    State(state): State<AppState>,
    Caller(ch): Caller,
    headers: HeaderMap,
    Json(change): Json<crate::clickhouse::govern::Change>,
) -> Result<Json<Job>> {
    use crate::clickhouse::govern;

    state.require_tier(Tier::Admin)?;
    let runner = state.job_runner()?;

    if let Some(why) = govern::refusal(&change) {
        return Err(Error::BadRequest(why));
    }
    for one in govern::names(&change) {
        if !crate::clickhouse::rbac::valid_name(one) {
            return Err(Error::BadRequest(format!(
                "`{one}` is not a name Flint will put in a statement: it has to be something, \
                 under 200 characters, and free of control characters"
            )));
        }
    }
    for fragment in govern::fragments(&change) {
        if fragment.contains(';') || fragment.contains("--") || fragment.contains("/*") {
            return Err(Error::BadRequest(format!(
                "`{fragment}` is not something Flint will put in a statement: a semicolon or a \
                 comment in an expression is the one way this could become two statements"
            )));
        }
    }

    let statement = govern::statement(&change);
    let spec = JobSpec {
        kind: govern::kind(&change),
        label: format!("{}{}", govern::label(&change), govern::access_note(&change)),
        target: ch.endpoint().to_string(),
        statement: statement.clone(),
        tier: state.config.tier().as_str().to_string(),
    };
    let who = state.caller_name(&headers);
    Ok(Json(
        runner
            .submit(spec, &who, Runner::statement_work(ch, statement))
            .await?,
    ))
}

/// Whether a database is there, as the caller.
///
/// Its own read rather than a table's engine: a database that exists and holds no
/// tables is still a database somebody can back up, and asking about a table
/// inside it would answer no.
async fn database_exists(ch: &crate::clickhouse::Client, database: &str) -> Result<bool> {
    #[derive(serde::Deserialize)]
    struct Row {
        n: u64,
    }
    let row: Option<Row> = ch
        .row_with(
            "SELECT count() AS n FROM system.databases WHERE name = {db:String}",
            crate::clickhouse::QueryOptions {
                params: vec![("db".into(), database.to_string())],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;
    Ok(row.map(|r| r.n > 0).unwrap_or(false))
}
