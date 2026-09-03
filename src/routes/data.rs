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
use crate::published::contract::{Contract, Refusal};
use crate::published::{self, openapi, shape, tool, Format};
use crate::workspace::{CallRecord, Published};

use super::AppState;

/// Who is calling, as far as anything can tell.
///
/// Anonymous is a real and permanent answer, not a gap waiting to be filled: a
/// public endpoint has no caller to name, and an endpoint called with its own
/// token has one shared secret and therefore one indistinguishable crowd
/// behind it. The call log records the absence rather than inventing an
/// identity, which is why the page can say "no key" beside a row instead of
/// attributing 12 thousand calls to somebody who did not make them.
#[derive(Debug, Clone, Default)]
struct Caller {
    key_id: String,
    key_name: String,
    /// `X-Flint-Label` — what the caller says this particular call is for.
    /// Free text off the wire: displayed, never matched on.
    label: String,
    /// Calls per day this key may make to this address. 0 is no limit.
    quota_per_day: u32,
}

/// What the call log will be told, filled in as the call proceeds.
///
/// A separate mutable thing rather than a return value, because the interesting
/// calls are the ones that end in an error — a 403 on an unexposed column knows
/// the revision and the caller, and all of that would be lost if the only way
/// to report it were through the `Ok` side.
#[derive(Debug, Clone, Default)]
struct Journal {
    revision: u32,
    caller: Caller,
    cached: bool,
    read_rows: u64,
    read_bytes: u64,
    /// The groupable sentence for a refusal — see `contract::Refusal`. Absent
    /// falls back to the error's own first sentence, which is written for a
    /// person rather than for a `GROUP BY` and reads worse in a list.
    reason: Option<String>,
}

impl Journal {
    /// Record why a call was turned away, and turn the refusal into the error
    /// the caller sees. Two sentences, one act — because a refusal recorded
    /// without being answered, or answered without being recorded, is exactly
    /// the pair of bugs this type exists to make impossible.
    fn refuse(&mut self, refusal: Refusal) -> Error {
        self.reason = Some(refusal.logged.clone());
        refusal.into()
    }
}

impl From<Refusal> for Error {
    fn from(refusal: Refusal) -> Error {
        match refusal.status {
            403 => Error::Forbidden(refusal.told),
            _ => Error::BadRequest(refusal.told),
        }
    }
}

/// Everything the caller sent, unfiltered — `bind` and `shape::parse` decide
/// what any of it means.
pub async fn serve(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<Vec<(String, String)>>,
    headers: HeaderMap,
) -> Result<Response> {
    let started = std::time::Instant::now();
    let mut journal = Journal::default();
    let outcome = answer(&state, &slug, &params, &headers, &mut journal).await;

    // Every call, including the ones that were refused — especially those. A
    // refusal never runs a statement, so `system.query_log` has no row for it
    // and the question "why is the support bot getting 429s" has nowhere to be
    // answered from. This is also the only place a cache hit is visible at all.
    if state.workspace.is_some() {
        let record = CallRecord {
            at: started,
            slug: slug.to_lowercase(),
            revision: journal.revision,
            key_id: journal.caller.key_id.clone(),
            key_name: journal.caller.key_name.clone(),
            label: journal.caller.label.clone(),
            status: match &outcome {
                Ok(_) => 200,
                Err(e) => e.http_status(),
            },
            reason: match (&outcome, &journal.reason) {
                (Ok(_), _) => String::new(),
                (Err(_), Some(reason)) => reason.clone(),
                (Err(e), None) => first_sentence(&e.to_string()),
            },
            ms: started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32,
            cached: journal.cached,
            read_rows: journal.read_rows,
            read_bytes: journal.read_bytes,
        };
        // Into a buffer, not into ClickHouse. Nothing is awaited and nothing is
        // spawned: the row is handed to `published::log`, which a background
        // task drains every few seconds in one insert. Writing a row per call
        // would make a ClickHouse part per call, and a busy endpoint would put
        // tens of thousands of them a day on the same database the alerts and
        // the dashboards live in.
        state.calls.record(record);
    }
    outcome
}

async fn answer(
    state: &AppState,
    slug: &str,
    params: &[(String, String)],
    headers: &HeaderMap,
    journal: &mut Journal,
) -> Result<Response> {
    let (endpoint, _caller) = resolve(state, slug, headers, params, journal).await?;

    let format = Format::parse(
        params
            .iter()
            .find(|(k, _)| k == "format")
            .map(|(_, v)| v.as_str()),
    )
    .map_err(Error::BadRequest)?;

    let declared = published::declared_params(&endpoint.sql);
    let defaults = defaults_of(&endpoint);
    // The values a published document settled when it was published. They are
    // declared by the generated statement like any other placeholder, which is
    // why they have to be named here: without this, `?flint_f0=Lyon` would be a
    // caller rewriting the question through its own address.
    let fixed = published::document::from_json(&endpoint.bindings);
    let bound = published::bind(&endpoint.sql, params, &defaults, &fixed).map_err(|missing| {
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

    // What this revision promises. An empty contract promises what the
    // placeholders do, which is how every endpoint published before contracts
    // existed goes on behaving — every check below is a no-op against it.
    let contract = Contract::parse(&endpoint.contract);
    let cap = contract.ceiling(u64::from(endpoint.max_rows));

    // Checked against the *bound* values, defaults included. A default that
    // violates the contract is a mistake in the endpoint, and finding it on
    // the first call beats finding it on the first call that omitted the
    // parameter.
    contract.check(&bound).map_err(|r| journal.refuse(r))?;

    let mut shape = shape::parse(params, &declared, cap).map_err(Error::BadRequest)?;

    // A filter is as good as a projection for learning what is in a column:
    // `?device_id=eq.abc` answers "is abc in here" one row count at a time. So
    // every column the caller *named*, wherever they named it, is checked
    // against the same exposure list.
    let named: Vec<String> = shape
        .select
        .iter()
        .cloned()
        .chain(shape.filters.iter().map(|f| f.column.clone()))
        .collect();
    contract
        .check_columns(&named)
        .map_err(|r| journal.refuse(r))?;
    contract
        .check_order(
            &shape
                .order
                .iter()
                .map(|o| o.column.clone())
                .collect::<Vec<_>>(),
        )
        .map_err(|r| journal.refuse(r))?;

    // Column names are only ever checked against what the statement really
    // returns, which means asking. Skipped entirely when the caller named no
    // column and the contract exposes everything: an endpoint called the way
    // endpoints were called before any of this costs exactly what it used to.
    let restricted = !contract.columns.only.is_empty() || !contract.columns.never.is_empty();
    let columns = if shape.names_columns() || restricted {
        describe(state, &endpoint, &bound)
            .await
            .map_err(without_statement)?
    } else {
        Vec::new()
    };

    // A caller who named no column gets every column — which, on a contracted
    // endpoint, is every *exposed* column and not every column the statement
    // happens to select. This is the line that keeps a join key out of the
    // answer: without it, `device_id` leaves the building on every unshaped
    // call and the contract only ever stopped people who asked for it by name.
    if restricted && shape.select.is_empty() {
        let returned: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
        let exposed: Vec<String> = contract.exposed(&returned).into_iter().cloned().collect();
        if exposed.is_empty() {
            return Err(Error::Forbidden(format!(
                "`{}` exposes none of the {} columns its statement returns, so there is \
                 nothing it can answer with",
                endpoint.slug,
                returned.len()
            )));
        }
        shape.select = exposed;
    }
    let shape = shape;

    // Everything that can change the bytes, and nothing that cannot. The
    // caller's identity is deliberately absent — see `cache::Cache`.
    let cache_ttl = std::time::Duration::from_secs(u64::from(endpoint.cache_ttl));
    let cache_key = (!cache_ttl.is_zero()).then(|| {
        published::cache::Cache::key(
            &endpoint.slug,
            endpoint.revision,
            format.name(),
            &bound,
            &shape_signature(&shape),
        )
    });
    if let Some(key) = &cache_key {
        if let Some(hit) = state.api_cache.get(key) {
            journal.cached = true;
            let age = hit.age().as_secs();
            let mut response = hit.body.into_response();
            let out = response.headers_mut();
            out.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(hit.content_type),
            );
            out.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store, private"),
            );
            for (name, value) in &hit.headers {
                put_owned(out, name, value);
            }
            // How old the figure in front of them is. Said on every hit, so a
            // caller never has to work out whether they are looking at a
            // cached answer — they are told, in seconds.
            put(out, "x-flint-cached", "hit");
            put(out, "x-flint-age", &age.to_string());
            return Ok((StatusCode::OK, response).into_response());
        }
    }

    let limit = shape.limit.unwrap_or(cap);
    let prefix = shape::free_prefix(&declared);

    let (sql, mut call_params, extra_columns) = if shape.wraps() {
        // One row more than the page: what makes "there is more behind this" a
        // fact rather than a guess. `table()` trims it back off.
        let wrapped = shape::wrap(&endpoint.sql, &shape, &columns, Some(limit + 1), &prefix)
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
                // Empty for the endpoints that predate delegation, which is
                // most of them: they run as the account in the manifest, the
                // way they always have.
                role: (!endpoint.run_as.is_empty()).then(|| endpoint.run_as.clone()),
                // The endpoint's own, so `toStartOfDay` cuts the day where the
                // endpoint says and not where the server happens to sit.
                timezone: (!endpoint.timezone.is_empty()).then(|| endpoint.timezone.clone()),
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
        Some(count(state, &endpoint, &shape, &columns, &prefix, &bound).await?)
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
                params,
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
                // Where its days begin. The OpenAPI document states this too,
                // but a document is read once when a client is written and the
                // answer is read every time it arrives — and it is the answer
                // somebody keeps.
                "timezone": match (endpoint.timezone.as_str(), state.ch.timezone()) {
                    ("", "") => serde_json::Value::Null,
                    ("", server) => serde_json::Value::String(server.to_string()),
                    (own, _) => serde_json::Value::String(own.to_string()),
                },
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
    // The endpoint's own zone, said on every response for the CSV caller who
    // has no envelope. Empty where this Flint could not read the server's at
    // the handshake — an absent header rather than a guessed one.
    match (endpoint.timezone.as_str(), state.ch.timezone()) {
        ("", "") => {}
        ("", server) => put(out, "x-flint-timezone", server),
        (own, _) => put(out, "x-flint-timezone", own),
    }
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
    if cache_key.is_some() {
        // Said on a miss too, so a caller comparing two responses can see that
        // the endpoint is cached at all — an endpoint that only ever announced
        // its hits looks uncached until the moment it is not.
        put(out, "x-flint-cached", "miss");
        put(out, "x-flint-age", "0");
    }

    // ClickHouse's own summary rather than the row count of the page: what a
    // usage panel is asking is what this call *cost*, and a hundred-row page
    // off a billion-row scan costs what the scan cost.
    journal.read_rows = table.summary.read_rows;
    journal.read_bytes = table.summary.read_bytes;

    // Kept only once it is whole. The body has to be read out of the response
    // to be stored, which is why this happens here rather than beside the
    // rendering: everything above may still refuse, and a cache filled with an
    // answer that was never sent would serve it to the next caller.
    if let Some(key) = cache_key {
        let (parts, body) = response.into_parts();
        let bytes = axum::body::to_bytes(body, MAX_CACHED_BODY)
            .await
            .unwrap_or_default();
        let kept: Vec<(String, String)> = parts
            .headers
            .iter()
            .filter(|(name, _)| name.as_str().starts_with("x-flint-") || *name == header::LINK)
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|v| (name.as_str().to_string(), v.to_string()))
            })
            .collect();
        state.api_cache.put(
            key,
            &endpoint.slug,
            cache_ttl,
            bytes.to_vec(),
            kept,
            format.content_type(),
        );
        response = Response::from_parts(parts, axum::body::Body::from(bytes));
    }
    Ok((StatusCode::OK, response).into_response())
}

/// The largest answer worth holding. Beyond it the call is served and simply
/// not cached — a page this big is not a dashboard tile, and filling the store
/// with one of them would evict the forty small answers that are the reason
/// the cache exists.
const MAX_CACHED_BODY: usize = 8 * 1024 * 1024;

/// The parts of a shape that change the bytes, flattened for the cache key.
///
/// Written out rather than derived from a `Debug` or a hash of the struct,
/// because a field added to `Shape` that this function does not mention is a
/// field two different questions can disagree on while sharing a cache entry.
/// Listing them by hand is what makes that a visible omission rather than a
/// silent one.
fn shape_signature(shape: &shape::Shape) -> Vec<(String, String)> {
    let mut out = vec![
        ("select".into(), shape.select.join(",")),
        ("limit".into(), shape.limit.unwrap_or_default().to_string()),
        ("offset".into(), shape.offset.to_string()),
        ("count".into(), shape.count.to_string()),
        (
            "order".into(),
            shape
                .order
                .iter()
                .map(|o| format!("{}{}", o.column, if o.desc { " desc" } else { "" }))
                .collect::<Vec<_>>()
                .join(","),
        ),
        (
            "filters".into(),
            shape
                .filters
                .iter()
                .map(|f| format!("{}:{:?}:{}", f.column, f.op, f.values.join("|")))
                .collect::<Vec<_>>()
                .join(","),
        ),
    ];
    // The body-borne parts of a shape are held as their debug form on purpose:
    // they are trees, they have no stable text spelling of their own, and a key
    // that is over-specific costs a cache miss while one that is under-specific
    // serves the wrong answer.
    if let Some(cursor) = &shape.cursor {
        out.push(("cursor".into(), format!("{cursor:?}")));
    }
    if let Some(tree) = &shape.tree {
        out.push(("tree".into(), format!("{tree:?}")));
    }
    if let Some(aggregate) = &shape.aggregate {
        out.push(("aggregate".into(), format!("{aggregate:?}")));
    }
    if !shape.windows.is_empty() {
        out.push(("windows".into(), format!("{:?}", shape.windows)));
    }
    if let Some(compare) = &shape.compare {
        out.push(("compare".into(), format!("{compare:?}")));
    }
    out
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
    let (endpoint, _) = resolve(&state, &slug, &headers, &params, &mut Journal::default()).await?;
    let declared = published::caller_params_typed(&endpoint);
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
        // When it stops answering, where it does. A caller building against an
        // endpoint has no other way to learn it has an end — and once it has
        // passed, they get the same 404 a wrong address gives, which is the
        // right answer to give and the wrong one to be surprised by.
        expires_at: (!endpoint.expires_at.is_empty()).then(|| endpoint.expires_at.clone()),
        reserved: shape::RESERVED.to_vec(),
        // The reserved names this statement took for itself. A caller reading
        // `limit` here knows why paging is not on offer.
        shadowed: shape::shadowed(&published::caller_params(&endpoint)),
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
    let (endpoint, _) = resolve(&state, &slug, &headers, &params, &mut Journal::default()).await?;
    let declared = published::caller_params_typed(&endpoint);
    let defaults = defaults_of(&endpoint);
    let columns = describe_with_probe(&state, &endpoint, &declared, &defaults).await;

    let doc = openapi::document(&openapi::Endpoint {
        name: &endpoint.name,
        slug: &endpoint.slug,
        expires_at: &endpoint.expires_at,
        timezone: &endpoint.timezone,
        revision: endpoint.revision,
        description: &endpoint.description,
        contract: &Contract::parse(&endpoint.contract),
        public: endpoint.public,
        max_rows: u64::from(endpoint.max_rows),
        parameters: &declared,
        defaults: &defaults,
        columns: columns.as_deref(),
        shadowed: &shape::shadowed(&published::caller_params(&endpoint)),
        server: origin(&headers).as_deref(),
    });

    let mut response = axum::Json(doc).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, private"),
    );
    Ok(response)
}

/// The endpoint, as a tool definition an agent can be handed.
///
/// Beside the OpenAPI document rather than instead of it, because they are read
/// by different things: a client generator wants paths and responses, and a
/// model-calling framework wants one name, one sentence and one argument
/// schema. Generating both from the same facts is the only way they cannot
/// disagree — and a hand-written tool definition is exactly the artefact that
/// goes stale the morning somebody publishes a new revision.
///
/// Behind the endpoint's own credential, like its schema and its document: what
/// an endpoint returns is not public knowledge just because its address is.
pub async fn tool_definition(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<Vec<(String, String)>>,
    headers: HeaderMap,
) -> Result<Response> {
    let (endpoint, _) = resolve(&state, &slug, &headers, &params, &mut Journal::default()).await?;
    let declared = published::caller_params_typed(&endpoint);
    let defaults = defaults_of(&endpoint);
    let columns = describe_with_probe(&state, &endpoint, &declared, &defaults).await;

    let doc = tool::definition(&tool::Tool {
        slug: &endpoint.slug,
        name: &endpoint.name,
        description: &endpoint.description,
        revision: endpoint.revision,
        parameters: &declared,
        defaults: &defaults,
        columns: columns.as_deref(),
        contract: &Contract::parse(&endpoint.contract),
        max_rows: u64::from(endpoint.max_rows),
        public: endpoint.public,
    });

    let mut response = axum::Json(doc).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, private"),
    );
    Ok(response)
}

/// When this endpoint stopped answering, or `None` if it has not.
///
/// The comparison is ClickHouse's, not Flint's. The expiry was written by the
/// server's clock and every other timestamp in the workspace was too, so asking
/// the same clock is the only way the answer cannot drift — and a sidecar whose
/// clock is fast would otherwise retire somebody's endpoint early, which is a
/// failure nobody would think to look for.
async fn expiry_passed(state: &AppState, endpoint: &Published) -> Result<Option<String>> {
    if endpoint.expires_at.trim().is_empty() {
        return Ok(None);
    }

    #[derive(Deserialize)]
    struct Verdict {
        passed: u8,
    }

    let verdict: Option<Verdict> = state
        .ch
        .row_with(
            "SELECT toUInt8(now64(3) >= {at:DateTime64(3)}) AS passed",
            QueryOptions {
                params: vec![("at".into(), endpoint.expires_at.clone())],
                force_readonly: true,
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await
        // An unreadable expiry must not become an endpoint that answers for
        // ever. Treat it as passed, and say which endpoint, so the failure is
        // loud in a log rather than silent on the wire.
        .unwrap_or_else(|e| {
            tracing::warn!(
                slug = %endpoint.slug, error = %e,
                "could not read this endpoint's expiry; treating it as expired"
            );
            Some(Verdict { passed: 1 })
        });

    Ok((verdict.is_none_or(|v| v.passed != 0)).then(|| endpoint.expires_at.clone()))
}

/// Where this Flint answers, as the request found it.
///
/// From the request rather than from configuration: Flint does not know what
/// hostname a reverse proxy publishes it under, and a guessed one in a document
/// somebody pastes into a client is worse than the relative URL it falls back
/// to.
pub(super) fn origin(headers: &HeaderMap) -> Option<String> {
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
        contract: Contract,
    }

    let mut described = Vec::new();
    for endpoint in workspace.published().await? {
        if !endpoint.enabled {
            continue;
        }
        // A draft is reachable by nobody and a retired revision answers as an
        // address that never existed. Documenting either is documenting a lie,
        // which is the same reason a paused endpoint is left out above.
        if !crate::workspace::State::parse(&endpoint.state).answers() {
            continue;
        }
        let declared = published::caller_params_typed(&endpoint);
        let defaults = defaults_of(&endpoint);
        // One `DESCRIBE` per endpoint. They read no data, and this is a
        // document somebody asked for rather than something on a hot path.
        let columns = describe_with_probe(&state, &endpoint, &declared, &defaults).await;
        let shadowed = shape::shadowed(&published::caller_params(&endpoint));
        let contract = Contract::parse(&endpoint.contract);
        described.push(Described {
            endpoint,
            declared,
            defaults,
            columns,
            shadowed,
            contract,
        });
    }

    let server = origin(&headers);
    let endpoints: Vec<openapi::Endpoint> = described
        .iter()
        .map(|d| openapi::Endpoint {
            name: &d.endpoint.name,
            slug: &d.endpoint.slug,
            expires_at: &d.endpoint.expires_at,
            timezone: &d.endpoint.timezone,
            public: d.endpoint.public,
            max_rows: u64::from(d.endpoint.max_rows),
            parameters: &d.declared,
            defaults: &d.defaults,
            columns: d.columns.as_deref(),
            shadowed: &d.shadowed,
            server: server.as_deref(),
            revision: d.endpoint.revision,
            description: &d.endpoint.description,
            contract: &d.contract,
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

/// The endpoint at this address, and who is calling it.
///
/// A paused endpoint, a draft and a retired revision all answer exactly as one
/// that never existed: whether a given address is switched off, not yet open or
/// finished is not a caller's business.
async fn resolve(
    state: &AppState,
    slug: &str,
    headers: &HeaderMap,
    params: &[(String, String)],
    // Written into as the answers arrive rather than filled in from the return
    // value, because the interesting calls are the ones that never reach it: a
    // 429 knows exactly which key it turned away, and recording it as
    // anonymous is how a quota panel comes to say a key has never been
    // throttled while it is being throttled every minute.
    journal: &mut Journal,
) -> Result<(Published, Caller)> {
    let workspace = state.workspace.as_ref().ok_or_else(|| {
        Error::NotFound("this Flint has no workspace, so it publishes nothing".into())
    })?;

    let slug = slug.to_lowercase();
    if !published::valid_slug(&slug) {
        return Err(Error::NotFound(format!("no endpoint at `{slug}`")));
    }

    // A pin is a promise kept in the other direction: a caller who wrote `?v=3`
    // gets v3 or nothing, and never a silent upgrade to whatever is live. That
    // is the entire value of the number — an unpinned caller accepts that the
    // answer may change shape, a pinned one has said they cannot.
    let pin = pinned_revision(headers, params)?;
    let endpoint = workspace
        .published_by_slug(&slug, pin)
        .await?
        .ok_or_else(|| match pin {
            // Different sentences on purpose. A wrong address and a version
            // that has finished are two different mistakes, and the second one
            // has an obvious next move — which the message makes, by naming
            // what a bare address would have reached.
            Some(pin) => Error::NotFound(format!(
                "`{slug}` has no v{pin} answering. Drop `v` to reach whichever revision is live."
            )),
            None => Error::NotFound(format!("no endpoint at `{slug}`")),
        })?;

    // Checked before the credential, and answered as a 404 rather than a 401.
    //
    // Before, because an expired endpoint is not a caller who brought the wrong
    // credential — telling them to check their token would send somebody
    // hunting for a mistake they did not make. And as a 404 because that is
    // what a paused endpoint already answers, for the reason stated there:
    // whether an address is switched off is not a caller's business, and an
    // endpoint that answers "gone" instead of "not here" tells anyone who asks
    // that it once existed and who to pester about it.
    if let Some(expired) = expiry_passed(state, &endpoint).await? {
        tracing::info!(slug = %endpoint.slug, %expired, "a call reached an expired endpoint");
        return Err(Error::NotFound(format!("no endpoint at `{slug}`")));
    }
    journal.revision = endpoint.revision;

    let label = headers
        .get("x-flint-label")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .trim()
        .to_string();
    let presented = presented_secret(headers, params);

    // One secret, two things it might be, and they are tried in that order.
    //
    // A key is global and names a caller; an endpoint's own token is the older
    // arrangement, shared by everyone who calls that one address. Accepting
    // both through the same header is what lets a deployment move one caller at
    // a time: `app-frontend` swaps its secret for a key and is suddenly visible
    // in the call log, while the four scripts nobody can find go on working.
    let caller = match presented.as_deref() {
        Some(secret) => match workspace.key_by_secret(secret).await? {
            Some(key) => {
                // Scope is checked before quota, because "this key is not for
                // that endpoint" and "this key has had enough for today" are
                // answers to different questions and the first one does not
                // become true again tomorrow.
                if !key.scope.is_empty() && !key.scope.contains(&endpoint.slug) {
                    journal.caller.key_id = key.id.clone();
                    journal.caller.key_name = key.name.clone();
                    journal.reason = Some(format!("out of scope · {}", key.name));
                    return Err(Error::Forbidden(format!(
                        "the key `{}` is not scoped to `{}`",
                        key.name, endpoint.slug
                    )));
                }
                Caller {
                    key_id: key.id,
                    key_name: key.name,
                    label,
                    quota_per_day: key.quota_per_day,
                }
            }
            // Not a key. It may still be this endpoint's own token.
            None => {
                if !endpoint.public && !published::token_matches(&endpoint.token, secret) {
                    return Err(Error::Unauthorized(unauthorised()));
                }
                Caller {
                    label,
                    ..Default::default()
                }
            }
        },
        None => {
            if !endpoint.public {
                return Err(Error::Unauthorized(unauthorised()));
            }
            Caller {
                label,
                ..Default::default()
            }
        }
    };

    journal.caller = caller.clone();

    // Counted per key and per address, so one noisy tile cannot spend the
    // budget the same program's other calls depend on.
    if caller.quota_per_day > 0 && !caller.key_id.is_empty() {
        // What ClickHouse holds, plus what has not reached it yet. The table
        // alone lags by a flush window, and on a key doing ten calls a second
        // that is fifty calls of overshoot rather than a rounding error.
        let so_far = workspace
            .calls_today(&caller.key_id, &endpoint.slug)
            .await?
            + state.calls.pending(&caller.key_id, &endpoint.slug);
        if so_far >= u64::from(caller.quota_per_day) {
            // Groupable, and holding no figure that moves: a thousand of these
            // over a day are one line with a count beside it, which is what
            // somebody scanning the panel needs. The sentence the caller gets
            // is the long one below.
            journal.reason = Some(format!("quota exhausted · {}", caller.key_name));
            return Err(Error::Throttled(format!(
                "the key `{}` has made its {} calls to `{}` for today. The count resets at \
                 midnight, {}.",
                caller.key_name,
                caller.quota_per_day,
                endpoint.slug,
                match state.ch.timezone() {
                    "" => "in the server's own timezone",
                    zone => zone,
                }
            )));
        }
    }

    Ok((endpoint, caller))
}

/// The one sentence a caller gets for every way of failing to authenticate.
///
/// Deliberately the same for a missing secret, a wrong one, a disabled key and
/// a key that belongs to another Flint: each distinction it could draw is a
/// distinction that helps somebody guessing more than it helps somebody who
/// simply pasted the wrong string.
fn unauthorised() -> String {
    "this endpoint needs a key or its token, as an X-Flint-Key header, a Bearer \
     authorization, or a `token` query parameter"
        .into()
}

/// The revision the caller pinned, from `?v=` or `X-Flint-Version`.
///
/// A malformed pin is refused rather than ignored. `?v=latest` silently
/// reaching the live revision is exactly the failure pinning exists to prevent:
/// the caller believes they are pinned and they are not, and they find out on
/// the morning the contract changes.
fn pinned_revision(headers: &HeaderMap, params: &[(String, String)]) -> Result<Option<u32>> {
    let raw = params
        .iter()
        .find(|(k, _)| k == "v")
        .map(|(_, v)| v.as_str())
        .or_else(|| headers.get("x-flint-version").and_then(|v| v.to_str().ok()));
    let Some(raw) = raw.map(str::trim).filter(|r| !r.is_empty()) else {
        return Ok(None);
    };
    // `v4` as well as `4`: the number is written with the prefix everywhere a
    // person reads it, so it arrives that way.
    let digits = raw.strip_prefix('v').unwrap_or(raw);
    digits
        .parse::<u32>()
        .ok()
        .filter(|n| *n > 0)
        .map(Some)
        .ok_or_else(|| {
            Error::BadRequest(format!(
                "`{raw}` is not a revision. Use a number — `v=4` — or leave it out to reach \
                 whichever revision is live."
            ))
        })
}

/// The secret the caller sent, from any of the three places it may travel.
fn presented_secret(headers: &HeaderMap, params: &[(String, String)]) -> Option<String> {
    headers
        .get("x-flint-key")
        .or_else(|| headers.get("x-flint-token"))
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| bearer(headers))
        .or_else(|| {
            params
                .iter()
                .find(|(k, _)| k == "token" || k == "key")
                .map(|(_, v)| v.clone())
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
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
    let mut probe: Vec<(String, String)> = declared
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
    // A document's own bindings are not probed, they are known — and they are
    // not in `declared`, because a caller cannot supply one. Left out, the
    // `DESCRIBE` would fail on a parameter with no value and every
    // document-backed endpoint would publish a schema with no columns in it.
    probe.extend(published::document::from_json(&endpoint.bindings));
    describe(state, endpoint, &probe).await
}

/// The same, for a document that would rather say nothing about the columns
/// than fail over them.
pub(super) async fn describe_with_probe(
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
                // Under the endpoint's role like the data is: describing a
                // statement is reading its shape, and a column list is the
                // half of a leak nobody counts.
                role: (!endpoint.run_as.is_empty()).then(|| endpoint.run_as.clone()),
                // A zone can change a column's *type*, not only its values: a
                // bucket expression resolved in another zone is still a
                // DateTime, but `DESCRIBE` is the source of the schema Flint
                // publishes, and describing the statement under different
                // settings than it runs under is how a schema drifts from its
                // answers.
                timezone: (!endpoint.timezone.is_empty()).then(|| endpoint.timezone.clone()),
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
            // The one place a type enters from `DESCRIBE`, which pretty-prints
            // a nested one across several lines.
            r#type: shape::one_line(&c.r#type),
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
                // The same rows, so the same role — and the same zone. A page
                // and a total read in two zones is not a slow count, it is a
                // wrong one: `?ts=gte.yesterday` resolves against midnight, and
                // two midnights select two different sets of rows.
                role: (!endpoint.run_as.is_empty()).then(|| endpoint.run_as.clone()),
                timezone: (!endpoint.timezone.is_empty()).then(|| endpoint.timezone.clone()),
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
pub(super) fn defaults_of(endpoint: &Published) -> Vec<(String, String)> {
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
        // A privilege refusal, in words the caller can act on.
        //
        // It became a *normal* outcome the day an endpoint could be delegated
        // to a role: an endpoint whose statement reaches past its role produces
        // this on every call. ClickHouse's own words name the account Flint
        // connects as, the grant it wanted and the build number — to somebody
        // outside who holds a token and has never been shown any of it.
        //
        // The author is not left guessing: the real refusal is in the log, and
        // in `system.query_log` under this endpoint's own tag.
        Error::ClickHouse { code: 497, message } => {
            tracing::warn!(%message, "a published endpoint was refused by its own grants");
            Error::Forbidden(
                "this endpoint cannot read what it asks for. Whoever published it needs to \
                 widen the role it runs as, or narrow the statement."
                    .into(),
            )
        }
        Error::ClickHouse { code, message } => Error::ClickHouse {
            code,
            message: first_sentence(&message),
        },
        other => other,
    }
}

fn first_sentence(message: &str) -> String {
    // The rule lives in `clickhouse::statement_starts_at`, because the audit
    // wants exactly the same one and the two copies had already drifted: this
    // list knew `In scope` and not `in scope`, so an unknown-table error handed
    // a published endpoint's statement to whoever called it.
    let kept = message[..crate::clickhouse::statement_starts_at(message)]
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
/// The same, for a header name only known at runtime — the ones read back out
/// of a cached answer.
fn put_owned(headers: &mut header::HeaderMap, name: &str, value: &str) {
    if let (Ok(name), Ok(value)) = (
        header::HeaderName::try_from(name),
        HeaderValue::from_str(value),
    ) {
        headers.insert(name, value);
    }
}

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
    /// Dropped rather than dashed where there is none: most endpoints do not
    /// expire, and a null in a field called `expires_at` reads as one that
    /// does at an unknown moment.
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
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
    fn the_statement_is_cut_whatever_case_clickhouse_wrote_the_marker_in() {
        // The leak this replaced: `In scope` was on the list and `in scope` was
        // not, and ClickHouse writes the lowercase one for an unknown table —
        // so a caller with no token got the author's own SQL back.
        let said = "Unknown table expression identifier 'vault_of_secrets' in scope \
                    SELECT secret_value FROM vault_of_secrets. (UNKNOWN_TABLE)";
        let kept = first_sentence(said);
        assert!(
            kept.contains("Unknown table expression identifier"),
            "{kept}"
        );
        assert!(!kept.contains("SELECT"), "{kept}");
        assert!(!kept.contains("secret_value"), "{kept}");
    }

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

    // ── Pinning ─────────────────────────────────────────────────────────

    fn params(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    fn header(name: &'static str, value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(name, HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn no_pin_at_all_reaches_whichever_revision_is_live() {
        assert_eq!(
            pinned_revision(&HeaderMap::new(), &params(&[("from", "2024-01-01")])).unwrap(),
            None
        );
        // An empty one is not a pin either: `?v=` is what a template with an
        // unfilled variable produces, and refusing it would break a caller who
        // never meant to pin at all.
        assert_eq!(
            pinned_revision(&HeaderMap::new(), &params(&[("v", "")])).unwrap(),
            None
        );
    }

    #[test]
    fn a_pin_is_read_with_or_without_the_letter_people_write_it_with() {
        assert_eq!(
            pinned_revision(&HeaderMap::new(), &params(&[("v", "4")])).unwrap(),
            Some(4)
        );
        assert_eq!(
            pinned_revision(&HeaderMap::new(), &params(&[("v", "v4")])).unwrap(),
            Some(4)
        );
        assert_eq!(
            pinned_revision(&header("x-flint-version", "v7"), &[]).unwrap(),
            Some(7)
        );
    }

    #[test]
    fn the_query_string_wins_over_the_header() {
        // Both is a caller who changed their mind in the nearer place. The URL
        // is the nearer place: it is what somebody edits to test something.
        let got = pinned_revision(&header("x-flint-version", "2"), &params(&[("v", "5")]));
        assert_eq!(got.unwrap(), Some(5));
    }

    #[test]
    fn a_pin_that_is_not_a_number_is_refused_rather_than_ignored() {
        // The whole point of pinning is that the caller believes they are
        // pinned. `?v=latest` quietly reaching the live revision is exactly
        // the failure it exists to prevent — they find out on the morning the
        // contract changes.
        for bad in ["latest", "v", "4.1", "-1", "0", "four"] {
            let refused = pinned_revision(&HeaderMap::new(), &params(&[("v", bad)]));
            assert!(refused.is_err(), "`{bad}` was accepted as a pin");
        }
    }

    // ── The secret, and where it may travel ─────────────────────────────

    #[test]
    fn a_secret_is_read_from_any_of_the_three_carriers() {
        assert_eq!(
            presented_secret(&header("x-flint-key", "abc"), &[]),
            Some("abc".into())
        );
        // The older header goes on working: every script written against the
        // per-endpoint token sends this one.
        assert_eq!(
            presented_secret(&header("x-flint-token", "abc"), &[]),
            Some("abc".into())
        );
        assert_eq!(
            presented_secret(&header("authorization", "Bearer abc"), &[]),
            Some("abc".into())
        );
        assert_eq!(
            presented_secret(&HeaderMap::new(), &params(&[("token", "abc")])),
            Some("abc".into())
        );
        assert_eq!(
            presented_secret(&HeaderMap::new(), &params(&[("key", "abc")])),
            Some("abc".into())
        );
    }

    #[test]
    fn a_blank_secret_is_no_secret() {
        // Otherwise `?token=` authenticates as the empty string, and an
        // endpoint whose stored token was never set would open to the world.
        assert_eq!(
            presented_secret(&HeaderMap::new(), &params(&[("token", "   ")])),
            None
        );
        assert_eq!(presented_secret(&header("x-flint-key", ""), &[]), None);
        assert_eq!(presented_secret(&HeaderMap::new(), &[]), None);
    }

    #[test]
    fn the_key_header_is_preferred_over_the_endpoint_token_header() {
        let mut headers = HeaderMap::new();
        headers.insert("x-flint-key", HeaderValue::from_static("the-key"));
        headers.insert("x-flint-token", HeaderValue::from_static("the-token"));
        assert_eq!(presented_secret(&headers, &[]), Some("the-key".into()));
    }

    // ── What a refusal writes down ──────────────────────────────────────

    #[test]
    fn a_refusal_is_recorded_and_answered_in_one_act() {
        let mut journal = Journal::default();
        let contract = Contract {
            columns: crate::published::contract::Exposure {
                never: vec!["device_id".into()],
                ..Default::default()
            },
            ..Default::default()
        };
        let refusal = contract.check_columns(&["device_id".into()]).unwrap_err();
        let error = journal.refuse(refusal);
        // The caller's sentence and the log's sentence are different, and the
        // log's is the groupable one.
        assert_eq!(
            journal.reason.as_deref(),
            Some("column device_id not exposed")
        );
        assert_eq!(error.http_status(), 403);
        assert!(error.to_string().contains("device_id"));
    }

    #[test]
    fn a_window_refusal_answers_400_and_groups_without_the_callers_dates() {
        let mut journal = Journal::default();
        let contract = Contract {
            params: vec![crate::published::contract::ParamRule {
                name: "from".into(),
                window_to: "to".into(),
                window_days: Some(90),
                ..Default::default()
            }],
            ..Default::default()
        };
        let refusal = contract
            .check(&params(&[("from", "2020-01-01"), ("to", "2026-01-01")]))
            .unwrap_err();
        let error = journal.refuse(refusal);
        assert_eq!(error.http_status(), 400);
        let reason = journal.reason.unwrap();
        assert_eq!(reason, "window wider than 90 days");
        // No date the caller supplied, so a year of these is one line.
        assert!(!reason.contains("2020"), "{reason}");
    }

    // ── The cache key ───────────────────────────────────────────────────

    #[test]
    fn two_shapes_that_ask_different_questions_get_different_keys() {
        let a = shape::Shape {
            limit: Some(10),
            ..Default::default()
        };
        let b = shape::Shape {
            limit: Some(20),
            ..Default::default()
        };
        assert_ne!(shape_signature(&a), shape_signature(&b));

        let ordered = shape::Shape {
            order: vec![shape::Sort {
                column: "day".into(),
                desc: true,
            }],
            ..Default::default()
        };
        let other_way = shape::Shape {
            order: vec![shape::Sort {
                column: "day".into(),
                desc: false,
            }],
            ..Default::default()
        };
        assert_ne!(shape_signature(&ordered), shape_signature(&other_way));
    }

    #[test]
    fn the_same_shape_signs_the_same_way_twice() {
        let shape = shape::Shape {
            select: vec!["day".into(), "events".into()],
            limit: Some(100),
            offset: 20,
            count: true,
            ..Default::default()
        };
        assert_eq!(shape_signature(&shape), shape_signature(&shape.clone()));
    }
}
