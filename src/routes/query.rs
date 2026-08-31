use std::collections::BTreeMap;

use axum::body::Body;
use axum::extract::{Form, Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::clickhouse::{QueryOptions, TableResult, ATTACHED_SETTINGS};
use crate::error::{Error, Result};
use crate::export;

use super::{AppState, Caller};

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
    /// Settings this statement should carry, as the console's `SET` collected
    /// them. Vetted by `vet_settings` before they go anywhere near the wire.
    #[serde(default)]
    pub settings: BTreeMap<String, String>,
    /// Values for the `{name:Type}` placeholders the statement declares.
    ///
    /// Unvetted on purpose, and safe for the same reason the rest of Flint binds
    /// this way: ClickHouse quotes a bound parameter as a literal of the type
    /// the *statement* declared, so a value cannot become syntax. That is the
    /// whole point of the mechanism, and it is what makes a dashboard-wide time
    /// range possible without Flint parsing anybody's SQL.
    ///
    /// It grants a caller on this route nothing new: they are sending the
    /// statement as well, so anything a parameter could reach they could have
    /// written directly. That is *not* true of the published endpoints, which
    /// is why those declare their parameters and check them — see
    /// `published/contract.rs`.
    #[serde(default)]
    pub params: BTreeMap<String, String>,
}

/// Settings a caller may not name, on top of the ones Flint already attaches.
///
/// `ATTACHED_SETTINGS` covers the twelve Flint sends on every statement —
/// `readonly` and `max_result_rows` among them, which is the whole point: a
/// deployment configured read-only must not be arguable with from the console,
/// and a result cap that the client could raise is not a cap. These four are
/// the rest of the request Flint composes and that a duplicate key would make
/// ambiguous.
const REFUSED_EXTRA: [&str; 3] = ["session_timezone", "role", "query_id"];

/// Every name the console may not `SET`, for `/api/config` to publish.
///
/// The console refuses these itself, at the prompt, and this is why it can:
/// one list, on the server, sent to the client. The check here stays — a
/// client is not a guard — but a console that lets somebody pin a setting the
/// server will refuse has bricked itself, because *every* statement after it
/// carries the refusal. Better to say no while it is still one line of typing.
pub fn reserved_settings() -> Vec<&'static str> {
    ATTACHED_SETTINGS
        .iter()
        .copied()
        .chain(REFUSED_EXTRA)
        .collect()
}

/// How many settings one statement may carry. Nobody types thirty-two; the
/// number is here so a malformed client cannot make the URL unbounded.
const MAX_SETTINGS: usize = 32;
const MAX_SETTING_VALUE: usize = 256;

/// Turn what the console asked for into settings the wire may carry, or say
/// exactly which one is refused and why.
///
/// A refusal names the setting. "Some settings were ignored" is the kind of
/// message that costs somebody an hour of wondering whether their
/// `max_execution_time` took — and a console that quietly drops half of a `SET`
/// is worse than one that cannot do `SET` at all.
fn vet_settings(asked: &BTreeMap<String, String>) -> Result<Vec<(String, String)>> {
    if asked.len() > MAX_SETTINGS {
        return Err(Error::BadRequest(format!(
            "{} settings on one statement — {MAX_SETTINGS} is the most Flint will carry",
            asked.len()
        )));
    }

    let mut out = Vec::with_capacity(asked.len());
    for (name, value) in asked {
        let ok_name = !name.is_empty()
            && name.len() <= 64
            && name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !ok_name {
            return Err(Error::BadRequest(format!(
                "`{name}` is not a setting name — letters, digits and underscores only"
            )));
        }

        let lower = name.to_ascii_lowercase();
        if ATTACHED_SETTINGS.contains(&lower.as_str())
            || REFUSED_EXTRA.contains(&lower.as_str())
            || lower.starts_with("param_")
        {
            return Err(Error::BadRequest(format!(
                "`{name}` is Flint's to set, not yours: it is on every statement Flint sends, and                  letting a client change it here would make the deployment's own limits a                  suggestion"
            )));
        }

        if value.len() > MAX_SETTING_VALUE {
            return Err(Error::BadRequest(format!(
                "the value for `{name}` is {} characters — {MAX_SETTING_VALUE} is the most a                  setting may carry",
                value.len()
            )));
        }
        if value.chars().any(|c| c.is_control()) {
            return Err(Error::BadRequest(format!(
                "the value for `{name}` contains a control character"
            )));
        }
        out.push((lower, value.clone()));
    }
    Ok(out)
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
    Caller(ch): Caller,
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

    let result = ch
        .table(
            &req.sql,
            QueryOptions {
                database: Some(database),
                query_id,
                max_rows: req
                    .max_rows
                    .map(|n| n.clamp(1, state.config.max_result_rows)),
                settings: vet_settings(&req.settings)?,
                params: req
                    .params
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
                ..Default::default()
            },
        )
        .await?;

    Ok(Json(result))
}

/// A download, as the browser's own form posts it.
///
/// A `Form` rather than `Json`, and that is the whole reason this works: a
/// native form submission is a *navigation*, so the browser streams the answer
/// straight to disk with its own progress and its own cancel. `fetch` would
/// have to hold the file in the tab's memory first, which defeats the one thing
/// a download is for. The session travels in the cookie, which a form carries
/// and a header could not.
///
/// A form post under cookie auth is the classic CSRF shape, and the reason this
/// one is not: the session cookie is `SameSite=Lax`, which browsers do not send
/// on a cross-site POST at all — so a form on somebody else's page arrives here
/// with no session and is refused like any other anonymous request. Checked
/// rather than assumed, and written down so it does not have to be re-derived
/// the next time somebody adds a form route.
#[derive(Debug, Deserialize)]
pub struct ExportRequest {
    pub sql: String,
    #[serde(default)]
    pub database: Option<String>,
    /// What the saved file should be called, before the extension. The table's
    /// name where there is one, and the caller's choice where there is not.
    #[serde(default)]
    pub name: Option<String>,
    pub format: String,
}

/// Hand back a file rather than a page.
///
/// **Uncapped, deliberately.** Every other read in Flint is a page that states
/// what it left out; a file cannot say that — nothing in a Parquet footer
/// mentions the four million rows that did not fit — so the honesty has to
/// happen before the click, where the caller is told the size of what they are
/// asking for. A silently truncated download is the same lie as a dashed figure
/// that was never measured.
///
/// **ClickHouse writes the bytes.** The format goes over as `default_format`
/// rather than as a clause on the statement — which is why the statement itself
/// is still refused for carrying one — and Flint moves what comes back.
/// Reimplementing CSV quoting or Parquet type mapping here would be a second
/// implementation to keep correct for `Decimal`, `Nullable(Date32)` and every
/// type added after this was written.
pub async fn download(
    State(state): State<AppState>,
    Caller(ch): Caller,
    Form(req): Form<ExportRequest>,
) -> Result<Response> {
    super::explorer::require_non_empty(&req.sql)?;
    reject_explicit_format(&req.sql)?;
    let format = export::Format::parse(&req.format).map_err(Error::BadRequest)?;

    let database = req
        .database
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| state.config.clickhouse_database.clone());

    let response = ch
        .open(
            &req.sql,
            format.clickhouse(),
            &QueryOptions {
                database: Some(database),
                // The cap off, and this is the one place in Flint where that is
                // right. `Some(0)` is how the client spells "no limit"; leaving
                // it unset would silently apply the page cap and hand back a
                // file that looked like the whole table.
                max_rows: Some(0),
                stream: true,
                // A download is a read whatever else this deployment permits.
                force_readonly: true,
                // Attributed like everything else, so a download that cost the
                // server an hour is visible on the page that ranks query cost
                // rather than being an unexplained spike.
                log_comment: Some(EXPORT_TAG.to_string()),
                ..Default::default()
            },
        )
        .await?;

    let name = export::filename(req.name.as_deref().unwrap_or("export").trim(), format);
    let mut out = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, format.content_type())
        .header(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_str(&export::disposition(&name))
                .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
        )
        // Never a shared cache: this is one person's data, named by a statement
        // that another person's grants would answer differently.
        .header(header::CACHE_CONTROL, "no-store, private")
        .body(Body::from_stream(response.bytes_stream()))
        // Only a malformed header could land here, and both of the ones this
        // builds are already sanitised — so this is a wrong-shaped response
        // rather than a wrong request, and it says so.
        .map_err(|e| Error::Decode(e.to_string()))?;
    // Said because the body may or may not have been gzipped by the layer above
    // — a cache that did not know that could hand a compressed file to a client
    // that asked for a plain one. Not what stops Parquet being gzipped: that is
    // the router's predicate, because `Vary` describes a response rather than
    // shaping one.
    out.headers_mut()
        .insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    Ok(out)
}

/// How a download is tagged in `system.query_log`.
pub const EXPORT_TAG: &str = "flint:export";

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
pub async fn format(Caller(ch): Caller, Json(req): Json<FormatRequest>) -> Result<Json<Value>> {
    super::explorer::require_non_empty(&req.sql)?;

    #[derive(Deserialize)]
    struct Row {
        formatted: String,
    }

    let row: Option<Row> = ch
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

/// Cancel a running statement.
///
/// As the caller, deliberately: `KILL QUERY` without `ON CLUSTER` kills what the
/// issuing user is allowed to kill, so signing in means you can stop your own
/// query and not somebody else's.
pub async fn cancel(Caller(ch): Caller, Path(query_id): Path<String>) -> Result<Json<Value>> {
    let query_id = validate_query_id(&query_id)?;
    ch.cancel(&query_id).await?;
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

    fn asked(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn takes_an_ordinary_setting() {
        let out = vet_settings(&asked(&[("max_threads", "4")])).unwrap();
        assert_eq!(out, vec![("max_threads".to_string(), "4".to_string())]);
    }

    #[test]
    fn lowercases_the_name_so_two_spellings_cannot_both_be_sent() {
        let out = vet_settings(&asked(&[("Max_Threads", "4")])).unwrap();
        assert_eq!(out[0].0, "max_threads");
    }

    #[test]
    fn refuses_what_flint_sends_itself() {
        for name in ["readonly", "max_result_rows", "database", "log_comment"] {
            let err = vet_settings(&asked(&[(name, "0")])).unwrap_err();
            assert!(
                format!("{err}").contains(name),
                "{name} was allowed through"
            );
        }
    }

    #[test]
    fn refuses_it_whatever_the_case() {
        assert!(vet_settings(&asked(&[("READONLY", "0")])).is_err());
    }

    #[test]
    fn refuses_the_rest_of_the_request_flint_composes() {
        for name in ["role", "query_id", "session_timezone", "param_x"] {
            assert!(vet_settings(&asked(&[(name, "x")])).is_err(), "{name}");
        }
    }

    #[test]
    fn refuses_a_name_that_is_not_a_name() {
        for name in ["max threads", "max&threads", "1max", "", "max-threads"] {
            assert!(vet_settings(&asked(&[(name, "1")])).is_err(), "{name:?}");
        }
    }

    #[test]
    fn refuses_a_value_that_is_absurd_or_unprintable() {
        assert!(vet_settings(&asked(&[("max_threads", &"9".repeat(257))])).is_err());
        assert!(vet_settings(&asked(&[("log_x", "a\nb")])).is_err());
    }

    #[test]
    fn refuses_more_than_it_will_carry() {
        let many: BTreeMap<String, String> = (0..MAX_SETTINGS + 1)
            .map(|i| (format!("s{i}"), "1".to_string()))
            .collect();
        assert!(vet_settings(&many).is_err());
    }
}
