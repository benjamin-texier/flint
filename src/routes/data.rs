//! The public face of a published statement.
//!
//! Everything a caller can influence is checked here: the address exists and is
//! enabled, the token matches, the format is one we serve, only the parameters
//! the statement itself declares are forwarded, and anything else in the query
//! string is read as a shape — a filter, an order, a page — against the columns
//! the statement actually returns. The statement then runs read-only, inside a
//! wrapper it cannot see, with the endpoint's own row cap as the page size.

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};

use crate::clickhouse::{ColumnMeta, QueryOptions};
use crate::error::{Error, Result};
use crate::published::{self, openapi, shape, Format};
use crate::workspace::Published;

use super::AppState;

/// Everything the caller sent, unfiltered — `bind` and `shape::parse` decide
/// what any of it means.
pub async fn serve(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<Vec<(String, String)>>,
    headers: HeaderMap,
) -> Result<Response> {
    let endpoint = resolve(&state, &slug, &headers, &params).await?;

    let format = Format::parse(
        params
            .iter()
            .find(|(k, _)| k == "format")
            .map(|(_, v)| v.as_str()),
    )
    .map_err(Error::BadRequest)?;

    let declared = published::declared_params(&endpoint.sql);
    let defaults = defaults_of(&endpoint);
    let bound = published::bind(&endpoint.sql, &params, &defaults).map_err(|missing| {
        Error::BadRequest(format!(
            "this endpoint needs {}",
            missing
                .0
                .iter()
                .map(|n| format!("`{n}`"))
                .collect::<Vec<_>>()
                .join(", ")
        ))
    })?;

    let cap = u64::from(endpoint.max_rows);
    let shape = shape::parse(&params, &declared, cap).map_err(Error::BadRequest)?;

    // Column names are only ever checked against what the statement really
    // returns, which means asking. Skipped entirely when the caller named no
    // column: an endpoint called the way endpoints were called before any of
    // this costs exactly what it used to.
    let columns = if shape.names_columns() {
        describe(&state, &endpoint, &bound)
            .await
            .map_err(without_statement)?
    } else {
        Vec::new()
    };

    let limit = shape.limit.unwrap_or(cap);
    let prefix = shape::free_prefix(&declared);

    let (sql, mut call_params, extra_columns) = if shape.wraps() {
        // One row more than the page: what makes "there is more behind this" a
        // fact rather than a guess. `table()` trims it back off.
        let wrapped = shape::wrap(&endpoint.sql, &shape, &columns, limit + 1, &prefix)
            .map_err(Error::BadRequest)?;
        (wrapped.sql, wrapped.params, wrapped.extra_columns)
    } else {
        (endpoint.sql.clone(), Vec::new(), Vec::new())
    };
    call_params.extend(bound.iter().cloned());

    let table = state
        .ch
        .table(
            &sql,
            QueryOptions {
                database: (!endpoint.database.is_empty()).then(|| endpoint.database.clone()),
                params: call_params,
                // A published statement is a question, whatever this Flint is
                // otherwise allowed to do.
                force_readonly: true,
                max_rows: Some(limit),
                quote_64bit_integers: true,
                // Attributed in the log, so "which endpoints does anyone
                // actually use" has an answer without Flint keeping a second
                // one. These are real workload and stay in the diagnostics.
                log_comment: Some(published::call_tag(&endpoint.slug)),
                ..Default::default()
            },
        )
        .await
        .map_err(without_statement)?;

    // Asked for separately, and only when asked for: a total is a second pass
    // over the same rows, and a caller walking a list page by page should not
    // pay for one on every page.
    let total = if shape.count {
        Some(count(&state, &endpoint, &shape, &columns, &prefix, &bound).await?)
    } else {
        None
    };

    let mut column_names: Vec<String> = table.columns.iter().map(|c| c.name.clone()).collect();

    // The cursor comes off the last row of the page, before anything is
    // dropped from it — and only where every ordering column can carry one.
    let blocker = shape::cursor_blocker(&shape.order, &columns);
    let cursor = match (shape.order.is_empty(), &blocker) {
        (false, None) => table
            .rows
            .last()
            .and_then(|row| shape::cursor_for(&shape.order, &column_names, row))
            .map(|c| published::cursor::encode(&c)),
        _ => None,
    };

    // The columns the wrapper asked for on its own account go back out of the
    // answer: `?select=city` that also returned `n` would be answering a
    // question nobody asked.
    let mut rows = table.rows;
    if !extra_columns.is_empty() {
        let keep: Vec<usize> = column_names
            .iter()
            .enumerate()
            .filter(|(_, name)| !extra_columns.contains(name))
            .map(|(at, _)| at)
            .collect();
        rows = rows
            .into_iter()
            .map(|row| {
                keep.iter()
                    .map(|at| row.get(*at).cloned().unwrap_or(serde_json::Value::Null))
                    .collect()
            })
            .collect();
        column_names = keep
            .iter()
            .filter_map(|at| column_names.get(*at).cloned())
            .collect();
    }

    let page = Page {
        limit,
        offset: shape.offset,
        returned: rows.len() as u64,
        has_more: table.truncated,
        max_limit: cap,
        // Said rather than swallowed: a caller who asked for 5000 rows and got
        // 1000 has no other way to learn that the endpoint capped the page.
        limit_asked: shape.limit_asked,
        cursor: cursor.clone(),
        // And said when there is no cursor to give, because the alternative is
        // a caller quietly paging by offset over rows that move.
        cursor_note: blocker.map(|name| {
            format!(
                "`{name}` can be null, so a cursor over this order would skip rows; \
                 this page is walked with `offset`."
            )
        }),
        next: table.truncated.then(|| {
            shape::next_link(
                &endpoint_path(&endpoint.slug),
                &params,
                limit,
                match &cursor {
                    Some(cursor) => shape::NextBy::Cursor(cursor.clone()),
                    None => shape::NextBy::Offset(shape.offset),
                },
            )
        }),
    };

    let mut response = match format {
        Format::Json => {
            let mut body = serde_json::json!({
                "rows": published::to_json_rows(&column_names, &rows),
                "columns": column_names,
                "page": page,
                // Kept beside `page.has_more`, which says the same thing: this
                // field is in callers' scripts already.
                "truncated": table.truncated,
            });
            if let Some(total) = total {
                body["total"] = serde_json::json!(total);
            }
            serde_json::to_string(&body)
                .unwrap_or_else(|_| "{}".into())
                .into_response()
        }
        Format::Csv => published::to_csv(&column_names, &rows).into_response(),
        Format::Ndjson => published::to_ndjson(&column_names, &rows).into_response(),
    };

    // Everything the envelope says, said again in headers — a CSV or NDJSON
    // consumer has no envelope to read, and paging is exactly the thing it
    // would otherwise have to guess at.
    //
    // A header added here has to be added to `published::TOLD_HEADERS` too, or
    // a browser calling from another origin will not be allowed to read it.
    let out = response.headers_mut();
    out.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(format.content_type()),
    );
    // Never a shared cache: the answer depends on the token and the parameters.
    out.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, private"),
    );
    put(out, "x-flint-limit", &limit.to_string());
    put(out, "x-flint-offset", &shape.offset.to_string());
    put(out, "x-flint-returned", &page.returned.to_string());
    put(
        out,
        "x-flint-has-more",
        if table.truncated { "true" } else { "false" },
    );
    if let Some(total) = total {
        put(out, "x-flint-total", &total.to_string());
    }
    if let Some(cursor) = &page.cursor {
        // A caller who builds their own URLs wants the cursor rather than the
        // whole link — a cursor stays valid across a change of filter.
        put(out, "x-flint-cursor", cursor);
    }
    if let Some(next) = &page.next {
        put(out, "link", &format!("<{next}>; rel=\"next\""));
    }
    if table.truncated {
        // The name this has always had, for anything already watching for it.
        out.insert("x-flint-truncated", HeaderValue::from_static("true"));
    }
    Ok((StatusCode::OK, response).into_response())
}

/// The endpoint, describing itself.
///
/// Written for whoever has to call it: the parameters it needs, the columns it
/// returns and which operators each of those can be filtered with, the page it
/// serves and the formats it speaks. It deliberately does not include the
/// statement — a public endpoint's address is not an invitation to read the
/// SQL behind it, and anyone entitled to that already has Flint's own page.
pub async fn describe_endpoint(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<Vec<(String, String)>>,
    headers: HeaderMap,
) -> Result<Response> {
    let endpoint = resolve(&state, &slug, &headers, &params).await?;
    let declared = published::declared_params_typed(&endpoint.sql);
    let defaults = defaults_of(&endpoint);

    let parameters: Vec<ParameterDoc> = declared
        .iter()
        .map(|(name, ty)| ParameterDoc {
            name: name.clone(),
            r#type: ty.clone(),
            default: defaults
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone()),
            required: !defaults.iter().any(|(k, _)| k == name),
        })
        .collect();

    let (columns, note) = match describe_probing(&state, &endpoint, &declared, &defaults).await {
        Ok(columns) => (
            Some(
                columns
                    .iter()
                    .map(|c| ColumnDoc {
                        name: c.name.clone(),
                        r#type: c.r#type.clone(),
                        filter: shape::ops_for(&c.r#type),
                    })
                    .collect::<Vec<_>>(),
            ),
            None,
        ),
        // Absent rather than invented. A statement whose shape depends on the
        // value of a parameter cannot be described without running it, and
        // saying so is more use than a list of columns that might be wrong.
        Err(e) => (None, Some(without_statement(e).to_string())),
    };

    let doc = SchemaDoc {
        name: endpoint.name.clone(),
        slug: endpoint.slug.clone(),
        method: "GET",
        path: endpoint_path(&endpoint.slug),
        public: endpoint.public,
        parameters,
        columns,
        columns_note: note,
        paging: PagingDoc {
            max_limit: u64::from(endpoint.max_rows),
            default_limit: u64::from(endpoint.max_rows),
        },
        formats: vec!["json", "csv", "ndjson"],
        reserved: shape::RESERVED.to_vec(),
        // The reserved names this statement took for itself. A caller reading
        // `limit` here knows why paging is not on offer.
        shadowed: shape::shadowed(&published::declared_params(&endpoint.sql)),
    };

    let mut response = axum::Json(doc).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, private"),
    );
    Ok(response)
}

/// The same endpoint, as an OpenAPI document.
///
/// Generated on every request rather than stored: it is the statement's own
/// parameters, the columns ClickHouse says it returns and the page this
/// endpoint serves, and a copy kept anywhere else is a copy that drifts the
/// first time someone edits the SQL.
pub async fn openapi_document(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<Vec<(String, String)>>,
    headers: HeaderMap,
) -> Result<Response> {
    let endpoint = resolve(&state, &slug, &headers, &params).await?;
    let declared = published::declared_params_typed(&endpoint.sql);
    let defaults = defaults_of(&endpoint);
    let columns = describe_with_probe(&state, &endpoint, &declared, &defaults).await;

    let doc = openapi::document(&openapi::Endpoint {
        name: &endpoint.name,
        slug: &endpoint.slug,
        public: endpoint.public,
        max_rows: u64::from(endpoint.max_rows),
        parameters: &declared,
        defaults: &defaults,
        columns: columns.as_deref(),
        shadowed: &shape::shadowed(&published::declared_params(&endpoint.sql)),
        server: origin(&headers).as_deref(),
    });

    let mut response = axum::Json(doc).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, private"),
    );
    Ok(response)
}

/// Where this Flint answers, as the request found it.
///
/// From the request rather than from configuration: Flint does not know what
/// hostname a reverse proxy publishes it under, and a guessed one in a document
/// somebody pastes into a client is worse than the relative URL it falls back
/// to.
fn origin(headers: &HeaderMap) -> Option<String> {
    let host = headers.get(header::HOST)?.to_str().ok()?.trim();
    if host.is_empty() {
        return None;
    }
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        // A proxy chain sends a list; the first hop is the one the caller saw.
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|s| *s == "http" || *s == "https")
        .unwrap_or("http");
    Some(format!("{scheme}://{host}"))
}

/// Every endpoint this Flint publishes, in one OpenAPI document.
///
/// Under `/api/published` rather than under `/api/data`, and guarded the same
/// way the endpoint list already is: no single token can speak for all of them,
/// and the audience for one document of everything is whoever runs this Flint
/// rather than whoever calls one endpoint.
///
/// Paused endpoints are left out. One answers a caller exactly as an address
/// that never existed, and documenting a 404 is documenting a lie.
pub async fn openapi_index(State(state): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let workspace = state.workspace.as_ref().ok_or_else(|| {
        Error::NotFound("this Flint has no workspace, so it publishes nothing".into())
    })?;

    /// The owned halves of an `openapi::Endpoint`, which borrows all of them.
    struct Described {
        endpoint: Published,
        declared: Vec<(String, String)>,
        defaults: Vec<(String, String)>,
        columns: Option<Vec<ColumnMeta>>,
        shadowed: Vec<String>,
    }

    let mut described = Vec::new();
    for endpoint in workspace.published(&state.ch).await? {
        if !endpoint.enabled {
            continue;
        }
        let declared = published::declared_params_typed(&endpoint.sql);
        let defaults = defaults_of(&endpoint);
        // One `DESCRIBE` per endpoint. They read no data, and this is a
        // document somebody asked for rather than something on a hot path.
        let columns = describe_with_probe(&state, &endpoint, &declared, &defaults).await;
        let shadowed = shape::shadowed(&published::declared_params(&endpoint.sql));
        described.push(Described {
            endpoint,
            declared,
            defaults,
            columns,
            shadowed,
        });
    }

    let server = origin(&headers);
    let endpoints: Vec<openapi::Endpoint> = described
        .iter()
        .map(|d| openapi::Endpoint {
            name: &d.endpoint.name,
            slug: &d.endpoint.slug,
            public: d.endpoint.public,
            max_rows: u64::from(d.endpoint.max_rows),
            parameters: &d.declared,
            defaults: &d.defaults,
            columns: d.columns.as_deref(),
            shadowed: &d.shadowed,
            server: server.as_deref(),
        })
        .collect();

    let mut response = axum::Json(openapi::documents(&endpoints)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, private"),
    );
    Ok(response)
}

// ── The pieces both routes need ─────────────────────────────────────────

/// The endpoint at this address, if the caller may have it.
///
/// A paused endpoint answers exactly as one that never existed: whether a given
/// address is switched off is not a caller's business.
async fn resolve(
    state: &AppState,
    slug: &str,
    headers: &HeaderMap,
    params: &[(String, String)],
) -> Result<Published> {
    let workspace = state.workspace.as_ref().ok_or_else(|| {
        Error::NotFound("this Flint has no workspace, so it publishes nothing".into())
    })?;

    let slug = slug.to_lowercase();
    if !published::valid_slug(&slug) {
        return Err(Error::NotFound(format!("no endpoint at `{slug}`")));
    }
    let endpoint = workspace
        .published_by_slug(&state.ch, &slug)
        .await?
        .ok_or_else(|| Error::NotFound(format!("no endpoint at `{slug}`")))?;

    if !endpoint.public {
        let given = headers
            .get("x-flint-token")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .or_else(|| bearer(headers))
            .or_else(|| {
                params
                    .iter()
                    .find(|(k, _)| k == "token")
                    .map(|(_, v)| v.clone())
            });
        let ok = given
            .as_deref()
            .is_some_and(|g| published::token_matches(&endpoint.token, g));
        if !ok {
            return Err(Error::Unauthorized(
                "this endpoint needs its token, as an X-Flint-Token header, a Bearer \
                 authorization, or a `token` query parameter"
                    .into(),
            ));
        }
    }
    Ok(endpoint)
}

/// What the statement returns, with every placeholder filled — the caller's
/// defaults where there are any, and a probe of the declared type where there
/// are none.
///
/// `DESCRIBE` reads no data, so this learns the shape without answering the
/// question, and the probe never reaches a result set.
async fn describe_probing(
    state: &AppState,
    endpoint: &Published,
    declared: &[(String, String)],
    defaults: &[(String, String)],
) -> Result<Vec<ColumnMeta>> {
    let probe: Vec<(String, String)> = declared
        .iter()
        .map(|(name, ty)| {
            let value = defaults
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| published::probe_value(ty));
            (name.clone(), value)
        })
        .collect();
    describe(state, endpoint, &probe).await
}

/// The same, for a document that would rather say nothing about the columns
/// than fail over them.
async fn describe_with_probe(
    state: &AppState,
    endpoint: &Published,
    declared: &[(String, String)],
    defaults: &[(String, String)],
) -> Option<Vec<ColumnMeta>> {
    describe_probing(state, endpoint, declared, defaults)
        .await
        .ok()
}

/// What the statement returns, asked of ClickHouse rather than guessed at.
///
/// Tagged as introspection rather than as a call: `DESCRIBE` reads no data, and
/// counting it as a call would double every filtered endpoint's usage figure on
/// the diagnose page.
async fn describe(
    state: &AppState,
    endpoint: &Published,
    params: &[(String, String)],
) -> Result<Vec<ColumnMeta>> {
    #[derive(Deserialize)]
    struct Described {
        name: String,
        r#type: String,
    }

    let sql = format!(
        "DESCRIBE (\n{}\n)",
        endpoint.sql.trim_end().trim_end_matches(';').trim_end()
    );
    let described: Vec<Described> = state
        .ch
        .rows_with(
            &sql,
            QueryOptions {
                database: (!endpoint.database.is_empty()).then(|| endpoint.database.clone()),
                params: params.to_vec(),
                force_readonly: true,
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;

    Ok(described
        .into_iter()
        .map(|c| ColumnMeta {
            name: c.name,
            r#type: c.r#type,
        })
        .collect())
}

/// The same rows the page came from, counted.
async fn count(
    state: &AppState,
    endpoint: &Published,
    shape: &shape::Shape,
    columns: &[ColumnMeta],
    prefix: &str,
    bound: &[(String, String)],
) -> Result<u64> {
    #[derive(Deserialize)]
    struct Total {
        total: u64,
    }

    let counted =
        shape::count_around(&endpoint.sql, shape, columns, prefix).map_err(Error::BadRequest)?;
    let mut params = counted.params;
    params.extend(bound.iter().cloned());

    let row: Option<Total> = state
        .ch
        .row_with(
            &counted.sql,
            QueryOptions {
                database: (!endpoint.database.is_empty()).then(|| endpoint.database.clone()),
                params,
                force_readonly: true,
                quote_64bit_integers: false,
                // Tagged as the endpoint's own, like the page it counts for.
                // A `count=exact` call really is two passes over the data, and
                // the diagnose page measures what an endpoint costs — hiding
                // the second one there would make the cheap-looking endpoint
                // the expensive one.
                log_comment: Some(published::call_tag(&endpoint.slug)),
                ..Default::default()
            },
        )
        .await
        .map_err(without_statement)?;
    Ok(row.map(|r| r.total).unwrap_or_default())
}

/// The endpoint's defaults, as a list of pairs. A default that is not a string
/// is rendered as one — a caller supplies text over a query string whatever the
/// author typed into the form.
fn defaults_of(endpoint: &Published) -> Vec<(String, String)> {
    serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&endpoint.defaults)
        .map(|map| {
            map.into_iter()
                .map(|(k, v)| {
                    (
                        k,
                        match v {
                            serde_json::Value::String(s) => s,
                            other => other.to_string(),
                        },
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A ClickHouse error, without the statement it quotes back.
///
/// ClickHouse appends the query to most execution errors — "In scope SELECT
/// ...", "While executing ..." — and a caller can make an endpoint fail on
/// demand: a filter value of the wrong shape is enough. Left whole, that turns
/// every public endpoint into a way to read the SQL behind it, along with the
/// tables and the database it reads from. The sentence that says what went
/// wrong is the part a caller needs, and it comes first.
fn without_statement(e: Error) -> Error {
    match e {
        Error::ClickHouse { code, message } => Error::ClickHouse {
            code,
            message: first_sentence(&message),
        },
        other => other,
    }
}

fn first_sentence(message: &str) -> String {
    const QUOTES_THE_QUERY: [&str; 3] = ["In scope", "While executing", "while executing"];
    let cut = QUOTES_THE_QUERY
        .iter()
        .filter_map(|marker| message.find(marker))
        .min()
        .unwrap_or(message.len());
    let kept = message[..cut]
        .trim()
        .trim_end_matches([':', ',', '.'])
        .trim();
    if kept.is_empty() {
        // Nothing survived the cut, which means the whole message was the
        // query. The code still says what kind of refusal it was.
        "ClickHouse refused this call".to_string()
    } else {
        kept.to_string()
    }
}

fn endpoint_path(slug: &str) -> String {
    format!("/api/data/{slug}")
}

/// A header whose value came from data. Dropped rather than guessed at if it
/// somehow will not fit in one — a malformed header is worse than a missing one.
fn put(headers: &mut header::HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(name, value);
    }
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(|t| t.trim().to_string())
}

// ── What the answers look like ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct Page {
    /// The page actually served, after the endpoint's cap.
    limit: u64,
    offset: u64,
    returned: u64,
    has_more: bool,
    max_limit: u64,
    /// Only when the caller asked for a bigger page than the endpoint serves.
    #[serde(skip_serializing_if = "Option::is_none")]
    limit_asked: Option<u64>,
    /// Where this page stopped. Send it back as `cursor` for the next one; it
    /// cannot lose or repeat a row the way an offset can.
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
    /// Why there is no cursor, when there is an order but no cursor to give.
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor_note: Option<String>,
    /// The URL of the next page, or absent because this is the last one.
    #[serde(skip_serializing_if = "Option::is_none")]
    next: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ParameterDoc {
    name: String,
    r#type: String,
    required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    default: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ColumnDoc {
    name: String,
    r#type: String,
    /// Empty for a column that is returned but cannot be filtered.
    filter: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
struct PagingDoc {
    max_limit: u64,
    default_limit: u64,
}

#[derive(Debug, Clone, Serialize)]
struct SchemaDoc {
    name: String,
    slug: String,
    method: &'static str,
    path: String,
    public: bool,
    parameters: Vec<ParameterDoc>,
    /// Absent when the statement cannot be described without running it.
    columns: Option<Vec<ColumnDoc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    columns_note: Option<String>,
    paging: PagingDoc,
    formats: Vec<&'static str>,
    reserved: Vec<&'static str>,
    shadowed: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_does_not_hand_back_the_statement_it_failed_on() {
        // A caller can make an endpoint fail on demand — a filter value of the
        // wrong shape is enough — so an error that quotes the query back is a
        // way to read the SQL behind any public endpoint.
        let raw = "Cannot read DateTime: unexpected word: In scope SELECT * FROM \
                   (SELECT secret FROM private.table). (CANNOT_PARSE_DATETIME)";
        let scrubbed = first_sentence(raw);
        assert_eq!(scrubbed, "Cannot read DateTime: unexpected word");
        assert!(!scrubbed.contains("private"));
    }

    #[test]
    fn a_message_that_says_something_useful_is_left_alone() {
        assert_eq!(
            first_sentence("Memory limit (total) exceeded"),
            "Memory limit (total) exceeded"
        );
        // And one that was nothing but the query still says which kind of
        // refusal it was, because the code travels beside it.
        assert_eq!(
            first_sentence("In scope SELECT 1"),
            "ClickHouse refused this call"
        );
    }
}
