//! Try it before you arm it.
//!
//! Alerts, report sections and published endpoints are all statements that run
//! later, unattended, under a guarantee the editor does not apply — read-only,
//! whatever this Flint is otherwise allowed to do. So the check runs them
//! *exactly that way* rather than through the ordinary query path: a test that
//! passes under different rules than the real thing is worse than no test,
//! and on a writable Flint testing an INSERT through `/api/query` would insert.

use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::alerts::{self, Condition};
use crate::clickhouse::QueryOptions;
use crate::error::Result;

use super::Caller;

/// Enough rows to see the shape of the answer, not enough to be a query.
const PREVIEW_ROWS: u64 = 20;

#[derive(Deserialize)]
pub struct CheckInput {
    pub sql: String,
    #[serde(default)]
    pub database: String,
    /// The alert condition to judge the result by, when there is one. Lets the
    /// form say what the alert *would* do right now, which is the only question
    /// its author actually has.
    #[serde(default)]
    pub condition: Option<String>,
    /// Values for the statement's own placeholders — a published endpoint's
    /// defaults, so testing it exercises what a caller would actually get.
    #[serde(default)]
    pub params: Vec<(String, String)>,
}

#[derive(Serialize)]
pub struct CheckResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub columns: Vec<crate::clickhouse::ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: bool,
    pub elapsed_ms: u64,
    /// What the condition would say about this result, when one was given.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<Verdict>,
}

#[derive(Serialize)]
pub struct Verdict {
    pub state: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
}

/// Runs as the caller, not as Flint.
///
/// Which means the preview can differ from the scheduled run, since the
/// scheduler runs unattended as Flint's own account. That is the lesser of two
/// wrongs: the alternative hands anyone who can reach this route the ability to
/// run arbitrary SQL as the service account, reading whatever their own grants
/// do not reach. A preview that is honest about *your* access is worth more than
/// one that quietly borrows somebody else's.
pub async fn check(Caller(ch): Caller, Json(input): Json<CheckInput>) -> Result<Json<CheckResult>> {
    super::explorer::require_non_empty(&input.sql)?;

    let started = std::time::Instant::now();
    let table = ch
        .table(
            &input.sql,
            QueryOptions {
                database: (!input.database.is_empty()).then(|| input.database.clone()),
                params: input.params.clone(),
                force_readonly: true,
                max_rows: Some(PREVIEW_ROWS),
                quote_64bit_integers: true,
                ..Default::default()
            },
        )
        .await;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    let table = match table {
        Ok(t) => t,
        // A failure here is the answer, not an error: the whole point is to
        // find out now rather than at three in the morning.
        Err(e) => {
            return Ok(Json(CheckResult {
                ok: false,
                error: Some(e.to_string().lines().next().unwrap_or("failed").to_string()),
                columns: Vec::new(),
                rows: Vec::new(),
                truncated: false,
                elapsed_ms,
                verdict: None,
            }))
        }
    };

    let verdict = match input.condition.as_deref().map(Condition::parse) {
        Some(Ok(condition)) => {
            let outcome = alerts::evaluate(&condition, &table.rows);
            Some(match &outcome {
                alerts::Outcome::Evaluated { firing, value } => Verdict {
                    state: outcome.state().as_str(),
                    message: if *firing {
                        format!(
                            "right now this would be firing: {} (measured {})",
                            condition.describe(),
                            value
                        )
                    } else {
                        format!(
                            "right now this would be quiet: {} is not true (measured {})",
                            condition.describe(),
                            value
                        )
                    },
                    value: Some(*value),
                },
                alerts::Outcome::Failed { message } => Verdict {
                    state: outcome.state().as_str(),
                    message: format!("this could not be judged: {message}"),
                    value: None,
                },
            })
        }
        Some(Err(why)) => Some(Verdict {
            state: "error",
            message: why,
            value: None,
        }),
        None => None,
    };

    Ok(Json(CheckResult {
        ok: true,
        error: None,
        columns: table.columns,
        rows: table.rows,
        truncated: table.truncated,
        elapsed_ms,
        verdict,
    }))
}
