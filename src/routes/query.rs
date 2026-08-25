use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::clickhouse::{QueryOptions, TableResult};
use crate::error::{Error, Result};

use super::AppState;

#[derive(Debug, Deserialize)]
pub struct RunRequest {
    pub sql: String,
    #[serde(default)]
    pub database: Option<String>,
    /// The client mints this so it can cancel the query before the response
    /// to this request has arrived.
    #[serde(default)]
    pub query_id: Option<String>,
    #[serde(default)]
    pub max_rows: Option<u64>,
}

/// Flint owns the wire format, so a trailing `FORMAT x` would break result
/// parsing. Catch it here and say so, instead of failing on decode.
fn reject_explicit_format(sql: &str) -> Result<()> {
    let trimmed = sql.trim().trim_end_matches(';').trim_end();
    let mut tokens = trimmed
        .rsplit(char::is_whitespace)
        .filter(|t| !t.is_empty());
    let (last, previous) = (tokens.next(), tokens.next());
    if let (Some(last), Some(previous)) = (last, previous) {
        if previous.eq_ignore_ascii_case("format") && last.chars().all(|c| c.is_alphanumeric()) {
            return Err(Error::BadRequest(format!(
                "remove the `FORMAT {last}` clause — Flint sets the output format itself"
            )));
        }
    }
    Ok(())
}

fn validate_query_id(id: &str) -> Result<String> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !ok {
        return Err(Error::BadRequest(
            "query_id must be 1-128 characters of letters, digits, `-` or `_`".into(),
        ));
    }
    Ok(id.to_string())
}

pub async fn run(
    State(state): State<AppState>,
    Json(req): Json<RunRequest>,
) -> Result<Json<TableResult>> {
    super::explorer::require_non_empty(&req.sql)?;
    reject_explicit_format(&req.sql)?;

    let query_id = match req.query_id.as_deref() {
        Some(id) => Some(validate_query_id(id)?),
        None => None,
    };

    let database = req
        .database
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| state.config.clickhouse_database.clone());

    let result = state
        .ch
        .table(
            &req.sql,
            QueryOptions {
                database: Some(database),
                query_id,
                max_rows: req
                    .max_rows
                    .map(|n| n.clamp(1, state.config.max_result_rows)),
                ..Default::default()
            },
        )
        .await?;

    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
pub struct FormatRequest {
    pub sql: String,
}

/// Reformat a statement using ClickHouse's own `formatQuery`.
///
/// The server is the authority on how its SQL should be written, and it knows
/// the whole grammar; Flint's local formatter only splits on clause keywords.
/// `formatQuery` arrived in 24.x, so the caller falls back to that local pass
/// when this answers with an unknown-function error.
pub async fn format(
    State(state): State<AppState>,
    Json(req): Json<FormatRequest>,
) -> Result<Json<Value>> {
    super::explorer::require_non_empty(&req.sql)?;

    #[derive(Deserialize)]
    struct Row {
        formatted: String,
    }

    let row: Option<Row> = state
        .ch
        .row_with(
            "SELECT formatQuery({q:String}) AS formatted",
            QueryOptions {
                params: vec![("q".into(), req.sql.clone())],
                quote_64bit_integers: false,
                ..Default::default()
            },
        )
        .await?;

    match row {
        Some(r) => Ok(Json(json!({ "sql": r.formatted }))),
        None => Err(Error::Decode("formatQuery returned nothing".into())),
    }
}

pub async fn cancel(
    State(state): State<AppState>,
    Path(query_id): Path<String>,
) -> Result<Json<Value>> {
    let query_id = validate_query_id(&query_id)?;
    state.ch.cancel(&query_id).await?;
    Ok(Json(json!({ "cancelled": query_id })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_a_trailing_format_clause() {
        assert!(reject_explicit_format("SELECT 1 FORMAT JSON").is_err());
        assert!(reject_explicit_format("SELECT 1 format TSV;  ").is_err());
    }

    #[test]
    fn leaves_ordinary_statements_alone() {
        assert!(reject_explicit_format("SELECT 1").is_ok());
        assert!(reject_explicit_format("SELECT format FROM t").is_ok());
        assert!(reject_explicit_format("").is_ok());
    }

    #[test]
    fn query_ids_must_look_like_ids() {
        assert!(validate_query_id("a1b2-c3d4_e5").is_ok());
        assert!(validate_query_id("").is_err());
        assert!(validate_query_id("'; KILL --").is_err());
        assert!(validate_query_id(&"x".repeat(129)).is_err());
    }
}
