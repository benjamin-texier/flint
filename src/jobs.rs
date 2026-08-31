//! Work that outlives the request that asked for it.
//!
//! Some ClickHouse operations do not fit in an HTTP request and never will. An
//! `OPTIMIZE` over four terabytes, a mutation across a year of partitions, a
//! backup: each one outlives the tab that started it, and Flint is deployed as a
//! sidecar, which is rescheduled without being asked. So a job is a *row*, not a
//! future — the row is the truth, the task is only what happens to be pushing it
//! along at the moment.
//!
//! Three consequences worth stating, because they are the whole design:
//!
//! - **The workspace is required.** A job Flint cannot record is a job nobody
//!   can reconstruct afterwards, which is exactly the situation an operator is
//!   in at three in the morning. Without `FLINT_WORKSPACE_DATABASE` there is
//!   nowhere to write, so there are no jobs.
//! - **A restart is honest about what it lost.** On boot, any job still claiming
//!   to run is marked `interrupted`, because the task that was running it died
//!   with the process. It is *not* silently left as running, which would leave a
//!   spinner turning forever, and it is not marked done, which would be a lie.
//!   Where the server itself keeps going — a merge started by an `OPTIMIZE`
//!   often finishes without us — the detail says so rather than pretending Flint
//!   stopped it.
//! - **A job runs as the person who submitted it.** The row records who that
//!   was and which tier allowed it, and the statement is sent with their
//!   credentials, so ClickHouse's grants apply and `system.query_log` attributes
//!   it to them. Flint's own account writes the bookkeeping and nothing else.

use crate::clickhouse::{Client, QueryOptions};
use crate::error::{Error, Result};
use crate::workspace::{Job, JobRow, Workspace};

/// What to run, and what to call it.
#[derive(Debug, Clone)]
pub struct JobSpec {
    /// `optimize`, and later the rest. A short machine word; the UI groups on
    /// it and the label is what a person reads.
    pub kind: &'static str,
    /// One line: "Optimize analytics.events".
    pub label: String,
    /// The object it acts on, so a later job on the same table can be found.
    pub target: String,
    /// The statement, exactly as it will be sent. Kept because "what did that
    /// button actually run" is the first question anybody asks of a tool that
    /// runs things on their behalf.
    pub statement: String,
    /// The tier that permitted it, recorded rather than checked here: the route
    /// does the checking, this remembers what the answer was.
    pub tier: String,
}

/// How a job ended. Three answers rather than a `Result`, because "stopped on
/// request" is neither success nor failure and reporting it as either is a lie
/// somebody acts on.
pub enum Outcome {
    /// Finished. The string is anything worth saying about it, usually nothing.
    Done(String),
    Cancelled,
    Failed(String),
}

/// The future a single-statement job runs. Boxed so the closure that builds it
/// can be named in a signature without spelling out an opaque type.
pub struct StatementRun {
    fut: std::pin::Pin<Box<dyn std::future::Future<Output = Outcome> + Send>>,
}

impl std::future::Future for StatementRun {
    type Output = Outcome;

    fn poll(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Outcome> {
        self.fut.as_mut().poll(cx)
    }
}

/// The runner: one per process, cloneable, holding Flint's own client for the
/// bookkeeping.
///
/// Nothing per-job is held here on purpose. Cancellation is a message to
/// ClickHouse rather than to the task — the task is blocked on a statement, and
/// the way to stop a statement is to kill it on the server — so the `query_id`
/// in the row is the only handle a job needs, and it survives a restart while a
/// `JoinHandle` would not.
#[derive(Clone)]
pub struct Runner {
    ch: Client,
    workspace: Workspace,
}

impl Runner {
    pub fn new(ch: Client, workspace: Workspace) -> Self {
        Self { ch, workspace }
    }

    /// Record a job, start it, and hand back its id at once.
    ///
    /// Returns as soon as the row exists, which is the point: the caller gets an
    /// id it can poll rather than a connection it has to hold open. If the row
    /// cannot be written, nothing is started — a job running with no record of
    /// it is the one outcome worse than a job that never started.
    /// Record a job, start it, and hand back its id at once.
    ///
    /// Returns as soon as the row exists, which is the point: the caller gets an
    /// id it can poll rather than a connection it has to hold open. If the row
    /// cannot be written, nothing is started — a job running with no record of
    /// it is the one outcome worse than a job that never started.
    ///
    /// The work is a closure rather than a statement because the two jobs that
    /// exist are not the same shape: an `OPTIMIZE` is one statement sent as the
    /// caller, and a report edition is a dozen of them run by the scheduler as
    /// Flint. What they share is the row, the timing and the recovery, and that
    /// is what lives here.
    pub async fn submit<F, Fut>(&self, spec: JobSpec, submitted_by: &str, work: F) -> Result<Job>
    where
        F: FnOnce(String) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Outcome> + Send + 'static,
    {
        let id = uuid::Uuid::new_v4().to_string();
        // Flint's own tag, so a statement can be found in `system.processes` and
        // killed by id. Handed to the work rather than assumed by it: a job that
        // is not one statement has nothing to tag, and says so by ignoring it.
        let query_id = format!("flint-job-{id}");
        let started_ms = now_ms(&self.ch).await?;

        let row = JobRow {
            id: id.clone(),
            kind: spec.kind.to_string(),
            label: spec.label.clone(),
            target: spec.target.clone(),
            statement: spec.statement.clone(),
            submitted_by: submitted_by.to_string(),
            tier: spec.tier.clone(),
            query_id: query_id.clone(),
            state: "running".into(),
            detail: String::new(),
            started_ms,
            finished_ms: 0,
            version: 1,
        };
        self.workspace.write_job(&self.ch, &row).await?;

        let runner = self.clone();
        let label = spec.label.clone();
        tokio::spawn(async move {
            let outcome = work(query_id).await;
            let (state, detail) = match outcome {
                Outcome::Done(detail) => ("done", detail),
                Outcome::Cancelled => (
                    "cancelled",
                    "stopped on request; work the server had already started may still \
                     be finishing"
                        .to_string(),
                ),
                Outcome::Failed(why) => ("failed", why),
            };
            runner.finish(&row, state, &detail).await;
            tracing::info!(job = %label, state, "job finished");
        });

        // Read it back rather than assembling it here: the caller gets the row
        // as the reader will see it, which is one shape instead of two.
        self.workspace
            .job(&self.ch, &id)
            .await?
            .ok_or_else(|| Error::Decode("the job was written but cannot be read back".into()))
    }

    /// Run one statement as the caller — the shape most jobs take.
    ///
    /// A cancelled statement is not a failed one, and the difference is the whole
    /// reason somebody pressed the button.
    pub fn statement_work(as_user: Client, sql: String) -> impl FnOnce(String) -> StatementRun {
        move |query_id| StatementRun {
            fut: Box::pin(async move {
                match as_user
                    .execute(
                        &sql,
                        QueryOptions {
                            query_id: Some(query_id),
                            // A job is a write by definition — that is why it is
                            // a job — and the tier check already happened.
                            allow_write: true,
                            quote_64bit_integers: false,
                            ..Default::default()
                        },
                    )
                    .await
                {
                    Ok(()) => Outcome::Done(String::new()),
                    Err(Error::ClickHouse { code: 394, .. }) => Outcome::Cancelled,
                    Err(e) => Outcome::Failed(
                        e.to_string().lines().next().unwrap_or("failed").to_string(),
                    ),
                }
            }),
        }
    }

    /// Write the closing version of a job's row.
    async fn finish(&self, row: &JobRow, state: &str, detail: &str) {
        let finished_ms = now_ms(&self.ch).await.unwrap_or(row.started_ms);
        let closed = JobRow {
            state: state.into(),
            detail: detail.to_string(),
            finished_ms,
            version: row.version + 1,
            ..row.clone()
        };
        if let Err(e) = self.workspace.write_job(&self.ch, &closed).await {
            // Nothing to do but say so: the job did run, and the row will read
            // `running` until the next restart marks it interrupted. Better a
            // stale row than a panic in a background task.
            tracing::warn!(job = %row.label, "could not record the end of a job: {e}");
        }
    }

    /// Ask ClickHouse to stop a job.
    ///
    /// As the caller, so `KILL QUERY` is subject to their own grants — you can
    /// stop what you were allowed to start. The row is not written here: the
    /// task is still waiting on the statement and will record the outcome
    /// itself, which is the only place that knows whether the kill landed.
    pub async fn cancel(&self, job: &Job, as_user: &Client) -> Result<()> {
        if job.state != "running" {
            return Err(Error::BadRequest(format!(
                "that job is already `{}`, so there is nothing to stop",
                job.state
            )));
        }
        if !cancellable(&job.kind) {
            return Err(Error::BadRequest(format!(
                "a `{}` job is several statements in sequence, not one Flint can stop by id — \
                 it will finish or fail on its own",
                job.kind
            )));
        }
        as_user.cancel(&format!("flint-job-{}", job.id)).await
    }

    /// Mark every job that was running when the process died.
    ///
    /// Called once at boot. This is the closest thing to reattaching that the
    /// jobs Flint has today allow: a merge or a mutation the server started may
    /// well still be going, but the statement that was waiting on it is gone, so
    /// Flint cannot honestly claim to be running it. It says what it knows.
    pub async fn recover(&self) {
        let orphans = match self.workspace.running_jobs(&self.ch).await {
            Ok(rows) => rows,
            // A workspace that is not ready yet is not an error worth shouting
            // about at boot; the next request bootstraps it.
            Err(e) => {
                tracing::debug!("jobs: could not look for interrupted work: {e}");
                return;
            }
        };
        if orphans.is_empty() {
            return;
        }
        for job in &orphans {
            let row = interrupted_row(job);
            if let Err(e) = self.workspace.write_job(&self.ch, &row).await {
                tracing::warn!("jobs: could not mark `{}` interrupted: {e}", job.label);
            }
        }
        tracing::info!(
            "jobs: {} were running when Flint last stopped, and are marked interrupted",
            orphans.len()
        );
    }
}

/// The row recovery writes over a job that was running when Flint stopped.
///
/// Separate and pure because one field of it is load-bearing in a way nothing
/// about the code suggests: `started_ms` must be the *original* instant. The
/// jobs table is partitioned by month with a thirty-day TTL, so a row rewritten
/// with a zero timestamp lands in 1970 and ClickHouse deletes it as it arrives —
/// the job then reads as still running for ever, which is the exact failure this
/// function exists to prevent.
fn interrupted_row(job: &Job) -> JobRow {
    JobRow {
        id: job.id.clone(),
        kind: job.kind.clone(),
        label: job.label.clone(),
        target: job.target.clone(),
        // Not carried: the row already holds the statement from when it was
        // submitted, and this version is not the place to repeat it.
        statement: String::new(),
        submitted_by: job.submitted_by.clone(),
        tier: job.tier.clone(),
        query_id: String::new(),
        state: "interrupted".into(),
        detail: "Flint restarted while this was running — the server may have finished it anyway"
            .into(),
        started_ms: job.started_ms,
        // Left at the epoch, which the reader blanks: Flint does not know when —
        // or whether — the work actually ended.
        finished_ms: 0,
        // Above any version the old row can have reached: a job writes one
        // version per transition, and there are two.
        version: 100,
    }
}

/// The server's clock, in milliseconds.
///
/// ClickHouse's rather than the machine's, for the same reason the report
/// scheduler uses it: the server that stores the timestamps does the arithmetic,
/// so a sidecar whose clock has drifted cannot write a job that finished before
/// it started.
async fn now_ms(ch: &Client) -> Result<i64> {
    #[derive(serde::Deserialize)]
    struct Now {
        ms: i64,
    }
    let row: Option<Now> = ch
        .row_with(
            "SELECT toInt64(toUnixTimestamp64Milli(now64(3))) AS ms",
            QueryOptions {
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;
    row.map(|n| n.ms)
        .ok_or_else(|| Error::Decode("the server did not answer with its clock".into()))
}

/// What can be asked of one replica.
///
/// Four, and they are not the same kind of thing: `Sync` waits for the replica to
/// catch up and can take as long as the backlog does, `Restart` re-reads its
/// state from Keeper, and the two fetch controls are instant. All four are jobs
/// anyway — the row is the record of who asked and when, which for an operation
/// on a server matters whether or not it took time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReplicaAction {
    /// Wait until this replica has applied everything its queue holds.
    Sync,
    /// Re-initialise the replica from Keeper. The repair for a replica that has
    /// lost its session and gone read-only.
    Restart,
    /// Stop pulling parts from the others. What you do before taking a node out.
    StopFetches,
    /// Resume pulling.
    StartFetches,
}

impl ReplicaAction {
    /// The `kind` its job is filed under. Distinct per action rather than one
    /// `replica` kind, because only one of them is worth offering to stop.
    pub fn kind(self) -> &'static str {
        match self {
            ReplicaAction::Sync => "sync-replica",
            ReplicaAction::Restart => "restart-replica",
            ReplicaAction::StopFetches => "stop-fetches",
            ReplicaAction::StartFetches => "start-fetches",
        }
    }

    /// What a person reads in the list.
    pub fn label(self, database: &str, table: &str) -> String {
        let what = match self {
            ReplicaAction::Sync => "Sync replica",
            ReplicaAction::Restart => "Restart replica",
            ReplicaAction::StopFetches => "Stop fetches for",
            ReplicaAction::StartFetches => "Start fetches for",
        };
        format!("{what} {database}.{table}")
    }
}

/// The statement one replica action sends.
///
/// `SYSTEM` takes no query parameters, so the identifiers are quoted here the way
/// `OPTIMIZE` is — back-quoted, with any internal back-quote doubled, which is
/// how ClickHouse escapes them.
pub fn replica_statement(action: ReplicaAction, database: &str, table: &str) -> String {
    let quoted = |s: &str| format!("`{}`", s.replace('`', "``"));
    let verb = match action {
        ReplicaAction::Sync => "SYNC REPLICA",
        ReplicaAction::Restart => "RESTART REPLICA",
        ReplicaAction::StopFetches => "STOP FETCHES",
        ReplicaAction::StartFetches => "START FETCHES",
    };
    format!("SYSTEM {verb} {}.{}", quoted(database), quoted(table))
}

/// Whether a kind of job is one the server can be asked to stop.
///
/// A single tagged statement can: `KILL QUERY` finds it by the `query_id` the
/// row carries. An edition cannot — it is a dozen statements, each with its own
/// id, run one after another — so offering to stop one would be a button that
/// does nothing, which is worse than no button. Keyed on the kind because that
/// is genuinely what decides it, and mirrored in `lib/job.ts` for the control
/// the browser draws.
pub fn cancellable(kind: &str) -> bool {
    // `sync-replica` waits for a backlog and is the other one worth stopping.
    // The fetch controls and `restart-replica` are over before anybody could
    // press it.
    // Attaching a part is a copy that can take a while on a large one; the rest
    // are over before anybody could press a button.
    // A freeze on a large partition is a lot of hard links; the rest of the
    // partition actions are metadata moves and are over immediately.
    // A drop or a truncate is a metadata change plus a background removal; the
    // statement itself returns at once, so there is nothing to stop.
    matches!(
        kind,
        "optimize" | "sync-replica" | "attach-part" | "freeze-partition" | "backup" | "restore"
    )
}

/// The statement an `OPTIMIZE` job sends.
///
/// Built here rather than at the route so the quoting lives next to the thing
/// that runs it. Identifiers go through ClickHouse's own quoting — `{x:Identifier}`
/// cannot be used in `OPTIMIZE`, which takes no parameters, so the names are
/// validated by the caller and back-quoted here with any internal back-quote
/// doubled, which is how ClickHouse escapes them.
pub fn optimize_statement(database: &str, table: &str, final_pass: bool) -> String {
    let quoted = |s: &str| format!("`{}`", s.replace('`', "``"));
    format!(
        "OPTIMIZE TABLE {}.{}{}",
        quoted(database),
        quoted(table),
        if final_pass { " FINAL" } else { "" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(state: &str, started_ms: i64) -> Job {
        Job {
            id: "aaaaaaaa-1111-4222-8333-444455556666".into(),
            kind: "optimize".into(),
            label: "Optimize analytics.events".into(),
            target: "analytics.events".into(),
            submitted_by: "analyst".into(),
            tier: "ddl".into(),
            state: state.into(),
            detail: String::new(),
            started_at: "2026-08-25 12:22:43.782".into(),
            started_ms,
            finished_at: String::new(),
        }
    }

    #[test]
    fn recovery_keeps_the_instant_the_job_started() {
        // The whole point. A zero here puts the row in 1970, where the table's
        // thirty-day TTL deletes it on arrival, and the job reads as running for
        // ever. Found by restarting Flint over a planted job and watching
        // nothing change.
        let row = interrupted_row(&job("running", 1_787_000_000_000));
        assert_eq!(row.started_ms, 1_787_000_000_000);
        assert_eq!(row.state, "interrupted");
        assert_eq!(row.finished_ms, 0, "Flint does not know when it ended");
        assert!(row.version > 2, "must outrank both versions a job writes");
        assert!(row.detail.contains("may have finished it anyway"));
    }

    #[test]
    fn a_replica_action_names_the_table_the_way_clickhouse_does() {
        assert_eq!(
            replica_statement(ReplicaAction::Sync, "ring", "events"),
            "SYSTEM SYNC REPLICA `ring`.`events`"
        );
        assert_eq!(
            replica_statement(ReplicaAction::StopFetches, "ring", "events"),
            "SYSTEM STOP FETCHES `ring`.`events`"
        );
        // Same quoting rule as OPTIMIZE, for the same reason: SYSTEM takes no
        // query parameters, so Flint escapes the name itself.
        assert_eq!(
            replica_statement(ReplicaAction::Restart, "we`ird", "ta`ble"),
            "SYSTEM RESTART REPLICA `we``ird`.`ta``ble`"
        );
    }

    #[test]
    fn only_the_waiting_replica_action_can_be_stopped() {
        assert!(cancellable(ReplicaAction::Sync.kind()));
        // Over before anybody could press it; offering the control would be a
        // button that races the thing it acts on.
        assert!(!cancellable(ReplicaAction::StopFetches.kind()));
        assert!(!cancellable(ReplicaAction::Restart.kind()));
    }

    #[test]
    fn only_a_single_statement_job_can_be_stopped() {
        assert!(cancellable("optimize"));
        // An edition is a dozen statements with a dozen ids; a stop button on it
        // would do nothing, which is worse than no button.
        assert!(!cancellable("report"));
        // `backup` was this test's example of a kind Flint cannot stop, until
        // backups existed. They are one statement with one id, which `KILL
        // QUERY` reaches exactly as it reaches an `OPTIMIZE` — so the example
        // moved rather than the rule.
        assert!(cancellable("backup"));
        assert!(cancellable("restore"));
        // A kind this build has never heard of is not something to claim
        // control over.
        assert!(!cancellable("teleport"));
    }

    #[test]
    fn an_optimize_names_the_table_the_way_clickhouse_does() {
        assert_eq!(
            optimize_statement("analytics", "events", false),
            "OPTIMIZE TABLE `analytics`.`events`"
        );
        assert_eq!(
            optimize_statement("analytics", "events", true),
            "OPTIMIZE TABLE `analytics`.`events` FINAL"
        );
    }

    #[test]
    fn a_back_quote_in_a_name_is_doubled_not_dropped() {
        // `OPTIMIZE` takes no query parameters, so this is the one place where
        // Flint quotes an identifier itself instead of handing it to the server.
        assert_eq!(
            optimize_statement("we`ird", "ta`ble", false),
            "OPTIMIZE TABLE `we``ird`.`ta``ble`"
        );
    }
}
