//! Reading a dataset, as whoever is asking.
//!
//! The difference between this and `data.rs` is one word, and it is the whole
//! point of the route. A published endpoint runs as the account in the manifest
//! and is opened by a token; this runs as **the caller**, resolved from their
//! session, so a grant they do not hold and a row policy that narrows their view
//! both apply — decided by ClickHouse, which is the only place either of those
//! is written down.
//!
//! What that buys, said as plainly as `auth.rs` says it: there is no allow-list
//! of datasets here and there must never be one. Every table and view the caller
//! may read is readable, every one they may not is refused by the server with
//! the grant it wanted, and Flint holds no second opinion that could drift out
//! of step with the first.
//!
//! The question itself is `crate::dataset`'s, and the statement it becomes is
//! `published::shape`'s — the same wrapper, the same twelve operators, the same
//! `DESCRIBE`-checked identifiers and the same bound values that a published
//! endpoint has been using all along.

use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use crate::clickhouse::{ColumnMeta, QueryOptions};
use crate::dataset::inventory::{self, Inventory};
use crate::dataset::openapi;
use crate::dataset::{parse_name, Asked, Request};
use crate::error::{Error, Result};
use crate::published::{self, shape, Format};

use super::{AppState, Caller};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SchemaRequest {
    pub dataset: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListRequest {
    /// One database, or all of the ones this caller can see.
    #[serde(default)]
    pub database: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DatasetSummary {
    /// The name a request uses, ready to paste: `analytics.events`.
    name: String,
    database: String,
    table: String,
    /// `table`, `view`, `materialized_view` or `dictionary` — because a view is
    /// a dataset somebody curated and a table is what was landed, and a caller
    /// choosing between them wants to know which is which.
    kind: &'static str,
    /// Dropped rather than dashed where there is none: a view has no size, and
    /// printing a zero would answer a question nobody can act on.
    #[serde(skip_serializing_if = "Option::is_none")]
    rows: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct Listing {
    datasets: Vec<DatasetSummary>,
    count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

/// The most datasets one listing will carry.
///
/// A server with more objects than this is real, and a listing that stopped
/// without saying so would read as the whole truth. It says so instead.
const LIST_CAP: usize = 2000;

/// `POST /api/data/list` — which datasets this caller can read.
///
/// The answer is `system.tables`, and the filtering is not Flint's: ClickHouse
/// shows a user the objects their grants reach and hides the rest, so this
/// listing narrows itself per caller without a line of code here deciding
/// anything. Two people calling this get two different answers, correctly.
pub async fn list(Caller(ch): Caller, Json(request): Json<ListRequest>) -> Result<Json<Listing>> {
    Ok(Json(listing(&ch, request.database).await?))
}

/// `GET /api/data/openapi.json` — the query language, for everything that is
/// not Flint.
///
/// A `GET` and not a `POST`, unlike its neighbours, and it can be: a slug may
/// not contain a dot, so `openapi.json` is a name no published endpoint can
/// ever have and the static route can take `GET` without shadowing one.
///
/// Built from this caller's own listing, so the `dataset` enum names exactly
/// what they may read — see `dataset::openapi` for what that means for anyone
/// generating a client from it.
pub async fn openapi_document(Caller(ch): Caller, headers: HeaderMap) -> Result<Response> {
    let datasets: Vec<String> = listing(&ch, None)
        .await?
        .datasets
        .into_iter()
        .map(|d| d.name)
        .collect();

    // Where this Flint answers, as the request found it — the published face's
    // rule, for the same reason: a hostname guessed from configuration is worse
    // in a pasted document than the relative URL it falls back to.
    let server = super::data::origin(&headers);
    let document = openapi::document(&datasets, server.as_deref());
    let mut response = serde_json::to_string(&document)
        .unwrap_or_else(|_| "{}".into())
        .into_response();
    let out = response.headers_mut();
    out.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    // Per-caller, so never a shared cache — the enum in it is one person's
    // grants written down.
    out.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, private"),
    );
    Ok(response)
}

async fn listing(ch: &crate::clickhouse::Client, database: Option<String>) -> Result<Listing> {
    #[derive(Deserialize)]
    struct Row {
        database: String,
        name: String,
        engine: String,
        rows: Option<u64>,
        bytes: Option<u64>,
    }

    let database = database.filter(|d| !d.trim().is_empty());
    let scoped = match &database {
        Some(_) => "AND database = {db:String}",
        None => "",
    };

    let rows: Vec<Row> = ch
        .rows_with(
            &format!(
                "SELECT database, name, engine, \
                        total_rows AS rows, total_bytes AS bytes \
                 FROM system.tables \
                 /* One row per INFORMATION_SCHEMA view rather than one per \
                    case-spelled alias, so the count can be reconciled with \
                    what the explorer shows. */ \
                 WHERE (lower(database) != 'information_schema' OR name = lower(name)) \
                 {scoped} \
                 ORDER BY database, name \
                 LIMIT {}",
                LIST_CAP + 1
            ),
            QueryOptions {
                params: database
                    .map(|d| vec![("db".to_string(), d)])
                    .unwrap_or_default(),
                force_readonly: true,
                quote_64bit_integers: false,
                // Flint asking the server about itself, not the caller asking
                // for rows — so the pages that rank query cost leave it out.
                introspection: true,
                ..Default::default()
            },
        )
        .await?;

    let found = rows.len();
    let datasets: Vec<DatasetSummary> = rows
        .into_iter()
        .take(LIST_CAP)
        .map(|r| DatasetSummary {
            name: format!("{}.{}", r.database, r.name),
            kind: crate::clickhouse::meta::classify(&r.engine),
            database: r.database,
            table: r.name,
            rows: r.rows,
            bytes: r.bytes,
        })
        .collect();

    Ok(Listing {
        note: (found > LIST_CAP).then(|| {
            format!(
                "showing the first {LIST_CAP} datasets by name; there are more — \
                 narrow this with `database`"
            )
        }),
        count: datasets.len(),
        datasets,
    })
}

/// `POST /api/data/schema` — what this dataset can be asked, for this caller.
///
/// Asked as the caller for the same reason the read is: a `DESCRIBE` on a table
/// somebody may not read is still a read of its shape, and answering it from the
/// manifest account would hand out the columns of data their grants say they
/// cannot see.
///
/// It is a `POST` and not a `GET` because it names a dataset, and a dataset name
/// is not a path segment: `analytics.events` in a URL is two things a router has
/// to guess about. Consistency with the read beside it is the smaller reason.
pub async fn schema(
    State(state): State<AppState>,
    Caller(ch): Caller,
    Json(request): Json<SchemaRequest>,
) -> Result<Json<Inventory>> {
    let name = parse_name(&request.dataset).map_err(Error::BadRequest)?;
    let label = name.label();
    // No zone: this route answers what columns a dataset has, and a column
    // list does not move with one — verified, not assumed. `DESCRIBE` reports
    // `DateTime` under every zone; only the values it would carry change.
    let columns = describe(&ch, &state, &name.statement(), &label, None).await?;
    Ok(Json(inventory::describe(&label, &columns)))
}

/// `POST /api/data` — one dataset, shaped by the body.
pub async fn query(
    State(state): State<AppState>,
    Caller(ch): Caller,
    Json(mut request): Json<Request>,
) -> Result<Response> {
    // Taken before the body is read as a question, because it is not part of
    // the question: it is how the caller will name this read if they want it
    // stopped. See `Request::query_id` for why only the page carries it.
    let query_id = request.query_id.take();
    // A page size, not a statement about how many rows exist — the same meaning
    // the cap has on a published endpoint, and the same one it has in the SQL
    // editor, so nobody has to learn a third.
    let cap = state.config.max_result_rows;
    let Asked {
        name,
        mut shape,
        format,
        explain,
        time,
        timezone,
    } = request.into_asked(cap).map_err(Error::BadRequest)?;

    // Checked before anything is built, so a typo comes back as a sentence
    // about the zone rather than as whatever ClickHouse says when it meets one
    // it does not know halfway through a statement.
    crate::clickhouse::check_timezone(&ch, &timezone).await?;
    let zone = || (!timezone.is_empty()).then(|| timezone.clone());

    let inner = name.statement();

    // Only when the caller named a column. An unshaped read of a dataset costs
    // one statement, exactly as it would if they had typed it themselves. A
    // `time` always names one, even when the caller left the naming to Flint —
    // which is the point of asking the dataset rather than being told.
    let columns = if shape.names_columns() || !time.is_empty() {
        describe(&ch, &state, &inner, &name.label(), zone().as_deref()).await?
    } else {
        Vec::new()
    };

    // Now the columns are known, so which one each window is on is knowable.
    for plan in time {
        plan.apply(&mut shape, &columns)
            .map_err(Error::BadRequest)?;
    }

    let limit = shape.limit.unwrap_or(cap);

    // Whether a column may be summed is a question about the data, so it waits
    // until the data has described itself. `shape` will refuse a column that is
    // not there; this refuses one that is there and cannot do what was asked.
    if let Some(aggregate) = &shape.aggregate {
        inventory::permits(&columns, aggregate).map_err(Error::BadRequest)?;
    }

    // No statement of the caller's own is being wrapped, so no parameter of
    // theirs can collide with the wrapper's.
    let prefix = shape::free_prefix(&[]);
    let (sql, params, extra_columns) = if shape.wraps() {
        // One row more than the page: what makes "there is more behind this" a
        // fact rather than a guess.
        let wrapped =
            shape::wrap(&inner, &shape, &columns, limit + 1, &prefix).map_err(Error::BadRequest)?;
        (wrapped.sql, wrapped.params, wrapped.extra_columns)
    } else {
        (inner.clone(), Vec::new(), Vec::new())
    };

    // The statement as a person should read it.
    //
    // The zone reaches ClickHouse as a session setting, which is invisible in
    // the SQL — and this string is what the Builder shows under "Generated
    // SQL" and what "take to the editor" pastes. A statement handed over
    // without its zone runs in the server's and quietly answers about
    // different days, which is the whole defect this feature exists to
    // prevent. Rendered rather than sent this way because the setting has to
    // reach the count and the `DESCRIBE` too, and a session parameter reaches
    // all three; `SETTINGS session_timezone` in the statement is equivalent —
    // checked against the server, not assumed.
    let shown = |sql: &str| match timezone.as_str() {
        "" => sql.to_string(),
        zone => format!(
            "{sql}\nSETTINGS session_timezone = '{}'",
            zone.replace('\'', "''")
        ),
    };

    // Built, checked against the dataset, and handed back unrun. Nothing has
    // been read at this point beyond the shape of the columns, so a builder can
    // ask this on every keystroke.
    if explain {
        return Ok(axum::Json(serde_json::json!({
            "dataset": name.label(),
            "sql": shown(&sql),
        }))
        .into_response());
    }

    let table = ch
        .table(
            &sql,
            QueryOptions {
                database: database_of(&state, &name),
                query_id,
                params,
                // A dataset read is a question, whatever else this Flint is
                // configured to permit.
                force_readonly: true,
                timezone: zone(),
                max_rows: Some(limit),
                quote_64bit_integers: true,
                // Attributed by dataset rather than by endpoint, because there
                // is no endpoint: "which datasets does anyone actually read"
                // has an answer without Flint keeping a second log of its own.
                log_comment: Some(published::dataset_tag(&name.label())),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| in_flints_words(&name.label(), e))?;

    // Asked for separately and only when asked for: a total is a second pass
    // over the same rows, and a caller walking a list page by page should not
    // pay for one on every page.
    let total = if shape.count {
        let counted =
            shape::count_around(&inner, &shape, &columns, &prefix).map_err(Error::BadRequest)?;
        Some(
            ch.row_with::<Total>(
                &counted.sql,
                // The count is the same question as the page, so it is tagged
                // and capped the same way.
                QueryOptions {
                    database: database_of(&state, &name),
                    params: counted.params,
                    force_readonly: true,
                    // A total counted against different day boundaries than
                    // the page is not a slower answer, it is a different one.
                    timezone: zone(),
                    quote_64bit_integers: false,
                    log_comment: Some(published::dataset_tag(&name.label())),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| in_flints_words(&name.label(), e))?
            .map(|t| t.total)
            .unwrap_or_default(),
        )
    } else {
        None
    };

    let mut column_names: Vec<String> = table.columns.iter().map(|c| c.name.clone()).collect();

    // The cursor comes off the last row of the page, before anything is dropped
    // from it — and only where every ordering column can carry one.
    //
    // Never on an aggregated answer. Its rows are computed rather than stored,
    // so `into_asked` refuses a cursor on the way in — and handing one out here
    // would advertise a next page that the next request rejects, which is worse
    // than not offering it. The ordering names would even produce one: they are
    // the answer's own column names, and nothing downstream would notice.
    let aggregated = shape.aggregate.is_some();
    let blocker = (!aggregated)
        .then(|| shape::cursor_blocker(&shape.order, &columns))
        .flatten();
    let cursor = match (aggregated, shape.order.is_empty(), &blocker) {
        (false, false, None) => table
            .rows
            .last()
            .and_then(|row| shape::cursor_for(&shape.order, &column_names, row))
            .map(|c| published::cursor::encode(&c)),
        _ => None,
    };

    // The columns the wrapper asked for on its own account go back out of the
    // answer: a `select` of one column that also returned the sort key would be
    // answering a question nobody asked.
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
        dataset: name.label(),
        limit,
        offset: shape.offset,
        returned: rows.len() as u64,
        has_more: table.truncated,
        max_limit: cap,
        // Said rather than swallowed: a caller who asked for 5000 rows and got
        // 1000 has no other way to learn that the page was capped.
        limit_asked: shape.limit_asked,
        cursor: cursor.clone(),
        // And said when there is no cursor to give, because the alternative is
        // a caller quietly paging by offset over rows that move.
        cursor_note: if aggregated && !shape.order.is_empty() {
            Some(
                "an aggregated answer has no cursor — its rows are computed rather than \
                 stored, so page it with `offset`."
                    .into(),
            )
        } else {
            blocker.map(|name| {
                format!(
                    "`{name}` can be null, so a cursor over this order would skip rows; \
                     page this with `offset`."
                )
            })
        },
    };

    let mut response = match format {
        Format::Json => {
            let mut body = serde_json::json!({
                "rows": published::to_json_rows(&column_names, &rows),
                "columns": column_names,
                "page": page,
                "truncated": table.truncated,
                // What each column came back as, keyed by name.
                //
                // `columns` is the order and `types` is the shape, rather than
                // one array of pairs, because a caller who only wants the order
                // — most of them — should not have to unwrap objects to get it.
                // A grid needs the types to know what to right-align, and a
                // metric's type is computed, so there is nowhere else to learn
                // it from.
                "types": table
                    .columns
                    .iter()
                    .filter(|c| column_names.contains(&c.name))
                    .map(|c| (c.name.clone(), serde_json::Value::String(c.r#type.clone())))
                    .collect::<serde_json::Map<String, serde_json::Value>>(),
                // What the server spent answering. Carried for the same reason
                // the editor carries it: a builder that shows a number without
                // showing what it cost teaches people that queries are free.
                "statistics": table.statistics,
                // The statement this question became.
                //
                // Handed back here and deliberately *not* on the published
                // face, and the difference is who wrote it. A published
                // endpoint runs somebody else's statement, so returning it
                // would show a caller a query they were never given — which is
                // why `without_statement` exists. This one is the caller's own
                // question rendered; they supplied every column and every
                // value in it, and seeing what it became is the difference
                // between a builder you can learn from and one you have to
                // trust.
                "sql": shown(&sql),
                // Said even when the caller did not choose it. A row stamped
                // `2026-08-27` is a different day in Auckland and in São
                // Paulo, and an answer filed away for a month with no zone on
                // it cannot be reconciled against anything — least of all
                // against the same query run from somewhere else.
                "timezone": match (timezone.as_str(), ch.timezone()) {
                    ("", "") => serde_json::Value::Null,
                    ("", server) => serde_json::Value::String(server.to_string()),
                    (chosen, _) => serde_json::Value::String(chosen.to_string()),
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

    // Everything the envelope says, said again in headers, because a CSV or
    // NDJSON consumer has no envelope to read and paging is exactly the thing
    // it would otherwise have to guess at. There is no `Link` here: the next
    // page of a POST is the same body with a cursor in it, and a URL cannot
    // carry a body.
    let out = response.headers_mut();
    out.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(format.content_type()),
    );
    // Never a shared cache: the answer depends on who asked.
    out.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, private"),
    );
    // First, because it is the one a CSV consumer cannot recover any other
    // way: paging they can infer from the rows they got, a day boundary they
    // cannot infer from anything.
    match (timezone.as_str(), ch.timezone()) {
        ("", "") => {}
        ("", server) => put(out, "x-flint-timezone", server),
        (chosen, _) => put(out, "x-flint-timezone", chosen),
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
        put(out, "x-flint-cursor", cursor);
    }

    Ok(response)
}

/// ClickHouse's answer, in Flint's words.
///
/// A caller of this route was never shown the schema and has not been told what
/// the server underneath is, so it must not learn either from a refusal. The
/// server's own reads:
///
/// ```text
/// flint_probe: Not enough privileges. To execute this query, it's necessary
/// to have the grant SELECT ON system.users. (ACCESS_DENIED) (version 26.7.5.10)
/// ```
///
/// — which hands over the account name, the grant syntax and the build number
/// to somebody who asked for none of them. An abstraction that holds until the
/// first error is not an abstraction.
///
/// Only this family is translated, and deliberately so. A timeout, a memory
/// limit, a `Too many parts` — those are operational answers that help whoever
/// reads them, and burying them under a house voice would trade a real
/// diagnosis for a tidy one. What is hidden here is *vocabulary*, not trouble.
///
/// The two are kept apart rather than merged into one "does not exist, or you
/// may not read it". Merging is the reflex, and it is worth resisting: an
/// authenticated caller can already list what they may read, ClickHouse filters
/// that listing by grants itself, and conflating the two would cost every
/// honest typo a confusing answer to buy secrecy the server does not keep.
fn in_flints_words(label: &str, error: Error) -> Error {
    match error {
        // ACCESS_DENIED.
        Error::ClickHouse { code: 497, .. } => {
            Error::Forbidden(format!("`{label}` is not yours to read"))
        }
        // UNKNOWN_TABLE, UNKNOWN_DATABASE.
        Error::ClickHouse { code: 60 | 81, .. } => {
            Error::NotFound(format!("`{label}` is not a dataset on this server"))
        }
        other => other,
    }
}

#[derive(Debug, Deserialize)]
struct Total {
    total: u64,
}

#[derive(Debug, Clone, Serialize)]
struct Page {
    /// Named back, because a caller assembling requests in a loop wants the
    /// answer to say which question it answered.
    dataset: String,
    limit: u64,
    offset: u64,
    returned: u64,
    has_more: bool,
    max_limit: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit_asked: Option<u64>,
    /// Where this page stopped. Send it back as `cursor` for the next one; it
    /// cannot lose or repeat a row the way an offset can.
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor_note: Option<String>,
}

/// Which database an unqualified dataset name is read in.
fn database_of(state: &AppState, name: &crate::dataset::Name) -> Option<String> {
    name.database
        .is_none()
        .then(|| state.config.clickhouse_database.clone())
}

/// The dataset's columns, asked of the server rather than parsed.
///
/// Sent as the caller, deliberately: `DESCRIBE` on a table somebody may not read
/// is still a read of its schema, and answering it from the service account
/// would hand out the shape of data the grants say they cannot see.
async fn describe(
    ch: &crate::clickhouse::Client,
    state: &AppState,
    inner: &str,
    label: &str,
    timezone: Option<&str>,
) -> Result<Vec<ColumnMeta>> {
    #[derive(Deserialize)]
    struct Described {
        name: String,
        r#type: String,
    }

    let described: Vec<Described> = ch
        .rows_with(
            &format!("DESCRIBE (\n{inner}\n)"),
            QueryOptions {
                database: Some(state.config.clickhouse_database.clone()),
                force_readonly: true,
                // Described under the settings it will run under. A shape read
                // in one zone and rows read in another is how a schema and its
                // answers drift apart.
                timezone: timezone.map(str::to_string),
                quote_64bit_integers: false,
                // Tagged as the dataset rather than as introspection, and the
                // reason is the refusals. A shaped read is described before it
                // runs, so a caller reaching for a dataset their grants do not
                // reach is refused *here* — and under an introspection tag that
                // failure is unattributable, which left the audit unable to
                // show the one thing an audit is most for.
                //
                // `DESCRIBE` reads no data, so nothing that ranks query cost is
                // misled by it; the audit drops the successful ones by kind so
                // the trail stays one line per call.
                log_comment: Some(published::dataset_tag(label)),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| in_flints_words(label, e))?;

    Ok(described
        .into_iter()
        .map(|c| ColumnMeta {
            name: c.name,
            r#type: shape::one_line(&c.r#type),
        })
        .collect())
}

/// A header, where the value can be one. A value that cannot is dropped rather
/// than panicking a response that is otherwise fine.
fn put(headers: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(name, value);
    }
}
