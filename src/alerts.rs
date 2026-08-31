//! Alerts: a question asked on a schedule, and what happens when the answer
//! changes.
//!
//! Three commitments shape this module.
//!
//! An alert is a *question*, never a change. Its statement always runs
//! read-only, whatever `FLINT_READONLY` says, because an alert runs unattended
//! and nobody is watching to notice that the thing scheduled every minute is a
//! DELETE.
//!
//! Notifying is done on *transition*, not on truth. A condition that stays true
//! for a week is one event, not ten thousand — an alert that cries every minute
//! is an alert people turn off, and an alert people turn off is worse than none.
//!
//! And a failure to evaluate is its own state. "The server was unreachable" is
//! not "the condition is false", and quietly reporting the second is how a
//! monitoring tool tells you everything is fine while it is blind.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::clickhouse::{Client, QueryOptions};
use crate::error::Result;
use crate::reports::{self, Schedule, SectionResult, Spec, SECTION_ROW_CAP};
use crate::workspace::{Alert, Report, Workspace};

/// What the condition measures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Metric {
    /// How many rows came back. `rows > 0` is the everyday alert: "tell me if
    /// this query finds anything at all".
    Rows,
    /// The first cell of the first row, as a number. For a query written to
    /// answer with one figure.
    Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Op {
    #[serde(rename = ">")]
    Gt,
    #[serde(rename = ">=")]
    Gte,
    #[serde(rename = "<")]
    Lt,
    #[serde(rename = "<=")]
    Lte,
    #[serde(rename = "==")]
    Eq,
    #[serde(rename = "!=")]
    Ne,
}

impl Op {
    fn holds(self, left: f64, right: f64) -> bool {
        match self {
            Op::Gt => left > right,
            Op::Gte => left >= right,
            Op::Lt => left < right,
            Op::Lte => left <= right,
            // Equality on floats that came from a database column: compared
            // with a tolerance, because `count()/3` is never exactly 1.0 and an
            // alert that can never fire is a silent one.
            Op::Eq => (left - right).abs() < f64::EPSILON * left.abs().max(1.0) * 4.0,
            Op::Ne => !Op::Eq.holds(left, right),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Op::Gt => ">",
            Op::Gte => ">=",
            Op::Lt => "<",
            Op::Lte => "<=",
            Op::Eq => "==",
            Op::Ne => "!=",
        }
    }
}

/// A closed grammar on purpose. An expression language here would mean running
/// user-authored code on a timer inside the server; "the row count" and "the
/// first number" cover what alerts are actually written for, and everything
/// else belongs in the SQL, where ClickHouse evaluates it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Condition {
    pub metric: Metric,
    pub op: Op,
    pub threshold: f64,
}

impl Condition {
    /// Parse the stored JSON. A condition that cannot be read is an error the
    /// caller reports, never a condition that silently never fires.
    pub fn parse(raw: &str) -> std::result::Result<Self, String> {
        serde_json::from_str(raw).map_err(|e| format!("unreadable condition: {e}"))
    }

    pub fn describe(&self) -> String {
        let subject = match self.metric {
            Metric::Rows => "rows",
            Metric::Value => "the value",
        };
        format!(
            "{subject} {} {}",
            self.op.as_str(),
            trim_float(self.threshold)
        )
    }
}

/// `4` rather than `4.0`, because a threshold of four rows is four rows.
fn trim_float(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

/// The outcome of one evaluation.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// The condition was evaluated. `value` is what was measured.
    Evaluated { firing: bool, value: f64 },
    /// The condition could not be evaluated, and why.
    Failed { message: String },
}

/// What became of a notification. Three states, not two: "there was nowhere to
/// send it" is not "sent", and a log that records the first as the second is a
/// log that cannot be trusted about the one thing it exists for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delivery {
    /// No webhook configured, or delivery is switched off for this Flint.
    Skipped(&'static str),
    Sent,
    Failed(String),
}

impl Delivery {
    pub fn sent(&self) -> bool {
        matches!(self, Delivery::Sent)
    }

    /// Empty when there is nothing to explain — a skip is a fact, not a fault,
    /// but it still says which kind of skip it was.
    pub fn note(&self) -> String {
        match self {
            Delivery::Sent => String::new(),
            Delivery::Skipped(why) => (*why).to_string(),
            Delivery::Failed(e) => e.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Ok,
    Firing,
    Error,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Ok => "ok",
            State::Firing => "firing",
            State::Error => "error",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "ok" => Some(State::Ok),
            "firing" => Some(State::Firing),
            "error" => Some(State::Error),
            _ => None,
        }
    }
}

impl Outcome {
    pub fn state(&self) -> State {
        match self {
            Outcome::Evaluated { firing: true, .. } => State::Firing,
            Outcome::Evaluated { firing: false, .. } => State::Ok,
            Outcome::Failed { .. } => State::Error,
        }
    }
}

/// Measure the result and compare it. Extracted from the I/O so the comparison
/// is testable without a server.
pub fn evaluate(condition: &Condition, rows: &[Vec<serde_json::Value>]) -> Outcome {
    match condition.metric {
        Metric::Rows => {
            let value = rows.len() as f64;
            Outcome::Evaluated {
                firing: condition.op.holds(value, condition.threshold),
                value,
            }
        }
        Metric::Value => {
            let Some(cell) = rows.first().and_then(|r| r.first()) else {
                return Outcome::Failed {
                    // Not "false": a query that answered nothing did not answer
                    // that the value is fine.
                    message: "the statement returned no rows, so there was no value to compare"
                        .into(),
                };
            };
            match number_of(cell) {
                Some(value) => Outcome::Evaluated {
                    firing: condition.op.holds(value, condition.threshold),
                    value,
                },
                None => Outcome::Failed {
                    message: format!(
                        "the first column is {}, which is not a number this can compare",
                        describe_cell(cell)
                    ),
                },
            }
        }
    }
}

/// ClickHouse quotes 64-bit integers, so a number can arrive as a string; a
/// `Nullable` column can arrive as null. Both are handled here rather than at
/// the call site.
fn number_of(cell: &serde_json::Value) -> Option<f64> {
    match cell {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.parse::<f64>().ok(),
        serde_json::Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn describe_cell(cell: &serde_json::Value) -> String {
    match cell {
        serde_json::Value::Null => "empty".into(),
        serde_json::Value::Array(_) => "an array".into(),
        serde_json::Value::Object(_) => "a nested value".into(),
        serde_json::Value::String(s) => format!("the text {s:?}"),
        other => other.to_string(),
    }
}

/// What Flint sends to a webhook. Flat and stable: whatever is on the other end
/// is somebody's five-line script, and a payload that reshuffles itself between
/// versions breaks it.
#[derive(Debug, Clone, Serialize)]
pub struct Notification {
    pub alert: String,
    pub alert_id: String,
    pub state: &'static str,
    pub condition: String,
    pub value: Option<f64>,
    pub message: String,
    pub database: String,
    pub sql: String,
}

/// A line a person can read, in the body and in the events list.
pub fn summarise(alert: &Alert, condition: &Condition, outcome: &Outcome) -> String {
    match outcome {
        Outcome::Evaluated {
            firing: true,
            value,
        } => format!(
            "{} is firing: {} (measured {})",
            alert.name,
            condition.describe(),
            trim_float(*value)
        ),
        Outcome::Evaluated {
            firing: false,
            value,
        } => format!(
            "{} recovered: {} is no longer true (measured {})",
            alert.name,
            condition.describe(),
            trim_float(*value)
        ),
        Outcome::Failed { message } => format!("{} could not run: {}", alert.name, message),
    }
}

/// How often the scheduler looks for work. Alert intervals are minutes at the
/// shortest, so a ten-second tick is fine granularity and a negligible cost.
const TICK: Duration = Duration::from_secs(10);

/// Delivery gets its own short timeout: a webhook that hangs must not hold up
/// every other alert behind it.
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct Scheduler {
    ch: Client,
    workspace: Workspace,
    http: reqwest::Client,
    webhooks_allowed: bool,
    /// Last known state per alert, so a condition that stays true is one event
    /// rather than one per tick. Seeded from the event log at startup, so a
    /// restart does not re-announce everything that was already firing.
    state: Arc<RwLock<HashMap<String, State>>>,
    /// When each alert was last evaluated. In memory on purpose: after a
    /// restart every alert is checked once and then settles into its interval,
    /// which is the behaviour you want from something that was just down.
    last_run: Arc<RwLock<HashMap<String, Instant>>>,
}

impl Scheduler {
    pub fn new(
        ch: Client,
        workspace: Workspace,
        http: reqwest::Client,
        webhooks_allowed: bool,
    ) -> Self {
        Self {
            ch,
            workspace,
            http,
            webhooks_allowed,
            state: Arc::new(RwLock::new(HashMap::new())),
            last_run: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Run forever. Spawned once at startup when a workspace is configured.
    pub async fn run(self) {
        match self.workspace.last_states(&self.ch).await {
            Ok(seed) => {
                let count = seed.len();
                *self.state.write().await = seed;
                if count > 0 {
                    tracing::info!("alerts: resumed the state of {count} alert(s)");
                }
            }
            // Not fatal: without the seed the first tick may re-announce an
            // alert that was already firing, which is noise rather than harm.
            Err(e) => tracing::warn!("alerts: could not read previous alert state: {e}"),
        }

        let mut ticker = tokio::time::interval(TICK);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(e) = self.sweep().await {
                // One bad sweep must not end the scheduler; the next tick tries
                // again. A ClickHouse that is down comes back.
                tracing::warn!("alerts: sweep failed: {e}");
            }
            if let Err(e) = self.sweep_reports().await {
                tracing::warn!("reports: sweep failed: {e}");
            }
        }
    }

    /// Reports, on the same tick as alerts.
    ///
    /// Due-ness comes from the recorded runs and ClickHouse's clock, never from
    /// this process's memory: a restart at 09:05 must not run the nine o'clock
    /// report again, and a Flint that was down at nine must still run it when
    /// it comes back.
    async fn sweep_reports(&self) -> Result<()> {
        let reports = self.workspace.reports(&self.ch).await?;
        if reports.iter().all(|r| !r.enabled) {
            return Ok(());
        }
        let last = self.workspace.last_run_seconds(&self.ch).await?;

        // One clock reading per distinct zone, not one per report: a fleet of
        // twenty reports in three places costs three round trips, and reports
        // sharing a zone must be judged against the same instant or two of them
        // can straddle a minute boundary and disagree about whether it is nine.
        let mut clocks: HashMap<String, reports::Clock> = HashMap::new();
        for zone in reports
            .iter()
            .filter(|r| r.enabled)
            .map(|r| r.timezone.clone())
            .collect::<std::collections::BTreeSet<_>>()
        {
            match self.workspace.clock(&self.ch, &zone).await {
                Ok(clock) => {
                    clocks.insert(zone, clock);
                }
                Err(e) => {
                    // A zone the server has stopped recognising is one report's
                    // problem, not the sweep's: the others still run.
                    tracing::warn!("reports: cannot read the clock in `{zone}`: {e}");
                }
            }
        }

        for report in reports.into_iter().filter(|r| r.enabled) {
            let Some(clock) = clocks.get(&report.timezone).copied() else {
                continue;
            };
            let schedule = match Schedule::parse(&report.schedule) {
                Ok(s) => s,
                Err(why) => {
                    tracing::warn!("reports: `{}` has an unusable schedule: {why}", report.name);
                    continue;
                }
            };
            let ran = last.get(&report.id).copied();
            if !reports::is_due(&schedule, &clock, ran) {
                continue;
            }
            if reports::too_late(&schedule, &clock) {
                // Recorded as skipped rather than silently dropped: a report
                // that did not run is a thing its reader should be able to see.
                tracing::info!(
                    "reports: `{}` missed its slot by more than a day; skipping this edition",
                    report.name
                );
                let _ = self
                    .workspace
                    .record_report_run(
                        &self.ch,
                        &uuid::Uuid::new_v4().to_string(),
                        &report,
                        "skipped",
                        "[]",
                        0,
                        "the scheduled time passed more than a day ago, so this edition was \
                         skipped rather than delivered late",
                        &Delivery::Skipped("nothing was sent for a skipped edition"),
                    )
                    .await;
                continue;
            }
            self.run_report(&report).await;
        }
        Ok(())
    }

    /// Run one report now and record the edition. Returns the run id, so a
    /// manual run can open exactly the snapshot it just made.
    ///
    /// Public because the reports page has a button for it: a report that has
    /// only ever been described is a report nobody has seen run, and waiting
    /// until nine tomorrow to find out whether the sections work is not a
    /// review cycle. The statements are read-only either way, and the edition it
    /// writes is Flint's own bookkeeping.
    pub async fn run_report(&self, report: &Report) -> String {
        let run_id = uuid::Uuid::new_v4().to_string();
        let spec = match Spec::parse(&report.spec) {
            Ok(s) => s,
            Err(why) => {
                let _ = self
                    .workspace
                    .record_report_run(
                        &self.ch,
                        &run_id,
                        report,
                        "failed",
                        "[]",
                        0,
                        &why,
                        &Delivery::Skipped("nothing was sent for a report that could not be read"),
                    )
                    .await;
                return run_id;
            }
        };

        let mut results: Vec<SectionResult> = Vec::with_capacity(spec.sections.len());
        for section in &spec.sections {
            let opts = QueryOptions {
                database: (!section.database.is_empty()).then(|| section.database.clone()),
                // Same rule as an alert: a scheduled statement is a question.
                force_readonly: true,
                max_rows: Some(SECTION_ROW_CAP as u64),
                quote_64bit_integers: true,
                ..Default::default()
            };
            match self.ch.table(&section.sql, opts).await {
                Ok(table) => results.push(SectionResult {
                    title: section.title.clone(),
                    sql: section.sql.clone(),
                    columns: table.columns.clone(),
                    rows: table.rows,
                    truncated: table.truncated,
                    error: String::new(),
                    chart: section.chart.clone(),
                }),
                // One broken statement costs that section, not the report.
                Err(e) => results.push(SectionResult {
                    title: section.title.clone(),
                    sql: section.sql.clone(),
                    columns: Vec::new(),
                    rows: Vec::new(),
                    truncated: false,
                    error: e.to_string().lines().next().unwrap_or("failed").to_string(),
                    chart: None,
                }),
            }
        }

        let broken = results.iter().filter(|r| !r.error.is_empty()).count();
        let status = if broken == 0 {
            "ok"
        } else if broken == results.len() {
            "failed"
        } else {
            // Named rather than rounded to one or the other: a report where two
            // of five sections failed is neither fine nor useless.
            "partial"
        };
        let error = if broken == 0 {
            String::new()
        } else {
            format!("{broken} of {} sections could not run", results.len())
        };
        let sections_json = serde_json::to_string(&results).unwrap_or_else(|_| "[]".into());

        let delivery = self
            .deliver_report(report, status, &error, results.len())
            .await;
        if let Err(e) = self
            .workspace
            .record_report_run(
                &self.ch,
                &run_id,
                report,
                status,
                &sections_json,
                results.len(),
                &error,
                &delivery,
            )
            .await
        {
            tracing::warn!("reports: could not store the run of `{}`: {e}", report.name);
            return run_id;
        }
        tracing::info!(
            "report `{}` ran: {status}{}",
            report.name,
            if error.is_empty() {
                String::new()
            } else {
                format!(" ({error})")
            }
        );
        run_id
    }

    /// The webhook says a report ran; it does not carry the report. A snapshot
    /// can be megabytes, and the thing on the other end is somebody's script.
    async fn deliver_report(
        &self,
        report: &Report,
        status: &str,
        error: &str,
        sections: usize,
    ) -> Delivery {
        if report.webhook.trim().is_empty() {
            return Delivery::Skipped("no webhook is configured for this report");
        }
        if !self.webhooks_allowed {
            return Delivery::Skipped(
                "webhook delivery is disabled on this Flint (FLINT_ALERT_WEBHOOKS)",
            );
        }
        let body = serde_json::json!({
            "report": report.name,
            "report_id": report.id,
            "status": status,
            "sections": sections,
            "message": if error.is_empty() {
                format!("{} ran with {sections} section(s)", report.name)
            } else {
                format!("{}: {error}", report.name)
            },
        });
        match self
            .http
            .post(report.webhook.trim())
            .timeout(DELIVERY_TIMEOUT)
            .json(&body)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => Delivery::Sent,
            Ok(response) => {
                Delivery::Failed(format!("the endpoint answered {}", response.status()))
            }
            Err(e) => Delivery::Failed(e.to_string()),
        }
    }

    async fn sweep(&self) -> Result<()> {
        let alerts = self.workspace.alerts(&self.ch).await?;
        for alert in alerts.into_iter().filter(|a| a.enabled) {
            if !self.due(&alert).await {
                continue;
            }
            self.last_run
                .write()
                .await
                .insert(alert.id.clone(), Instant::now());
            self.check(&alert).await;
        }
        Ok(())
    }

    async fn due(&self, alert: &Alert) -> bool {
        let every = Duration::from_secs(alert.interval_seconds.max(10) as u64);
        match self.last_run.read().await.get(&alert.id) {
            Some(last) => last.elapsed() >= every,
            None => true,
        }
    }

    /// Evaluate one alert, record a transition if there was one, and deliver.
    async fn check(&self, alert: &Alert) {
        let condition = match Condition::parse(&alert.condition) {
            Ok(c) => c,
            Err(message) => {
                self.record(alert, None, State::Error, &message).await;
                return;
            }
        };

        let outcome = self.run_query(alert, &condition).await;
        let state = outcome.state();
        let previous = self.state.read().await.get(&alert.id).copied();

        // Only a change is news. An error repeating is not news either, but the
        // first error is.
        if previous == Some(state) {
            return;
        }
        self.state.write().await.insert(alert.id.clone(), state);

        let value = match &outcome {
            Outcome::Evaluated { value, .. } => Some(*value),
            Outcome::Failed { .. } => None,
        };
        let message = summarise(alert, &condition, &outcome);

        // A first evaluation that finds nothing wrong is not an event: nobody
        // wants "your new alert is fine" in their log, or their Slack.
        if previous.is_none() && state == State::Ok {
            return;
        }
        self.record(alert, value, state, &message).await;
    }

    async fn run_query(&self, alert: &Alert, condition: &Condition) -> Outcome {
        let opts = QueryOptions {
            database: (!alert.database.is_empty()).then(|| alert.database.clone()),
            // Read-only whatever the deployment says: see the module note.
            allow_write: false,
            force_readonly: true,
            quote_64bit_integers: false,
            ..Default::default()
        };
        match self.ch.table(&alert.sql, opts).await {
            Ok(result) => evaluate(condition, &result.rows),
            Err(e) => Outcome::Failed {
                message: e
                    .to_string()
                    .lines()
                    .next()
                    .unwrap_or("query failed")
                    .into(),
            },
        }
    }

    async fn record(&self, alert: &Alert, value: Option<f64>, state: State, message: &str) {
        let delivery = self.deliver(alert, state, value, message).await;
        if let Err(e) = self
            .workspace
            .record_alert_event(&self.ch, alert, state, value, message, &delivery)
            .await
        {
            tracing::warn!(
                "alerts: could not record an event for `{}`: {e}",
                alert.name
            );
        }
        match state {
            State::Firing => tracing::info!("alert firing: {message}"),
            State::Error => tracing::warn!("alert error: {message}"),
            State::Ok => tracing::info!("alert recovered: {message}"),
        }
    }

    async fn deliver(
        &self,
        alert: &Alert,
        state: State,
        value: Option<f64>,
        message: &str,
    ) -> Delivery {
        if alert.webhook.trim().is_empty() {
            return Delivery::Skipped("no webhook is configured for this alert");
        }
        if !self.webhooks_allowed {
            return Delivery::Skipped(
                "webhook delivery is disabled on this Flint (FLINT_ALERT_WEBHOOKS)",
            );
        }
        let condition = Condition::parse(&alert.condition)
            .map(|c| c.describe())
            .unwrap_or_else(|e| e);
        let body = Notification {
            alert: alert.name.clone(),
            alert_id: alert.id.clone(),
            state: state.as_str(),
            condition,
            value,
            message: message.to_string(),
            database: alert.database.clone(),
            sql: alert.sql.clone(),
        };
        match self
            .http
            .post(alert.webhook.trim())
            .timeout(DELIVERY_TIMEOUT)
            .json(&body)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => Delivery::Sent,
            Ok(response) => {
                Delivery::Failed(format!("the endpoint answered {}", response.status()))
            }
            Err(e) => Delivery::Failed(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rows(values: &[serde_json::Value]) -> Vec<Vec<serde_json::Value>> {
        values.iter().map(|v| vec![v.clone()]).collect()
    }

    fn condition(metric: Metric, op: Op, threshold: f64) -> Condition {
        Condition {
            metric,
            op,
            threshold,
        }
    }

    #[test]
    fn a_row_count_is_the_everyday_alert() {
        let c = condition(Metric::Rows, Op::Gt, 0.0);
        assert_eq!(
            evaluate(&c, &rows(&[json!(1), json!(2)])),
            Outcome::Evaluated {
                firing: true,
                value: 2.0
            }
        );
        assert_eq!(
            evaluate(&c, &[]),
            Outcome::Evaluated {
                firing: false,
                value: 0.0
            }
        );
    }

    #[test]
    fn a_value_comes_from_the_first_cell() {
        let c = condition(Metric::Value, Op::Gte, 100.0);
        assert_eq!(
            evaluate(&c, &rows(&[json!(140)])),
            Outcome::Evaluated {
                firing: true,
                value: 140.0
            }
        );
    }

    #[test]
    fn a_quoted_integer_is_still_a_number() {
        // ClickHouse quotes 64-bit integers for the browser's sake, so the cell
        // arrives as a string and must not read as "not a number".
        let c = condition(Metric::Value, Op::Gt, 5.0);
        assert_eq!(
            evaluate(&c, &rows(&[json!("9007199254740993")])),
            Outcome::Evaluated {
                firing: true,
                value: 9007199254740993.0
            }
        );
    }

    #[test]
    fn no_rows_is_a_failure_not_a_false() {
        // The distinction the module exists to protect: a query that answered
        // nothing did not answer that everything is fine.
        let c = condition(Metric::Value, Op::Gt, 5.0);
        match evaluate(&c, &[]) {
            Outcome::Failed { message } => assert!(message.contains("no rows"), "{message}"),
            other => panic!("expected a failure, got {other:?}"),
        }
        assert_eq!(evaluate(&c, &[]).state(), State::Error);
    }

    #[test]
    fn a_value_that_is_not_a_number_says_so() {
        let c = condition(Metric::Value, Op::Gt, 5.0);
        match evaluate(&c, &rows(&[json!("Berlin")])) {
            Outcome::Failed { message } => assert!(message.contains("Berlin"), "{message}"),
            other => panic!("expected a failure, got {other:?}"),
        }
        match evaluate(&c, &rows(&[serde_json::Value::Null])) {
            Outcome::Failed { message } => assert!(message.contains("empty"), "{message}"),
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn every_operator_means_what_it_says() {
        for (op, left, right, expected) in [
            (Op::Gt, 2.0, 1.0, true),
            (Op::Gt, 1.0, 1.0, false),
            (Op::Gte, 1.0, 1.0, true),
            (Op::Lt, 1.0, 2.0, true),
            (Op::Lte, 2.0, 2.0, true),
            (Op::Eq, 3.0, 3.0, true),
            (Op::Ne, 3.0, 4.0, true),
            (Op::Ne, 3.0, 3.0, false),
        ] {
            assert_eq!(op.holds(left, right), expected, "{op:?} {left} {right}");
        }
    }

    #[test]
    fn equality_tolerates_the_arithmetic_a_database_does() {
        // 0.1 + 0.2 != 0.3 in binary floating point. An alert written as
        // `== 0.3` that can never fire is a silent alert.
        assert!(Op::Eq.holds(0.1 + 0.2, 0.3));
        assert!(!Op::Eq.holds(0.3001, 0.3));
    }

    #[test]
    fn a_condition_round_trips_through_its_stored_form() {
        let c = condition(Metric::Rows, Op::Gte, 4.0);
        let raw = serde_json::to_string(&c).unwrap();
        assert!(raw.contains("\">=\""), "{raw}");
        let back = Condition::parse(&raw).expect("round trip");
        assert_eq!(back.op, Op::Gte);
        assert_eq!(back.metric, Metric::Rows);
        assert_eq!(back.describe(), "rows >= 4");
    }

    #[test]
    fn an_unreadable_condition_is_an_error_not_a_default() {
        // The failure mode this guards: a condition that silently becomes
        // "never fires" is an alert that lies about being on.
        assert!(Condition::parse("{}").is_err());
        assert!(Condition::parse("not json").is_err());
        assert!(Condition::parse(r#"{"metric":"rows","op":"~","threshold":1}"#).is_err());
    }

    #[test]
    fn a_threshold_reads_as_a_person_wrote_it() {
        assert_eq!(trim_float(4.0), "4");
        assert_eq!(trim_float(0.5), "0.5");
    }
}

#[cfg(test)]
mod delivery_tests {
    use super::*;

    #[test]
    fn nothing_sent_is_never_recorded_as_sent() {
        // The lie this prevents: an alert with no webhook reading `delivered`
        // in its own history.
        let skipped = Delivery::Skipped("no webhook is configured for this alert");
        assert!(!skipped.sent());
        assert!(skipped.note().contains("no webhook"));

        assert!(Delivery::Sent.sent());
        assert_eq!(Delivery::Sent.note(), "");

        let failed = Delivery::Failed("the endpoint answered 500".into());
        assert!(!failed.sent());
        assert!(failed.note().contains("500"));
    }
}
