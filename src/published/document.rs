//! A published question, written as a document rather than as a statement.
//!
//! What publishing became, once anybody with an account could ask anything
//! through `POST /api/data` without publishing at all. Two things are left that
//! nothing else does: a **delegation** — a slug and a token for a caller who has
//! no ClickHouse account — and a **name**, a stable address for one question. A
//! document-backed endpoint is how the second one stops being a second query
//! language: the address answers the question the Builder wrote, and the
//! document travels with it so the form can be reopened from the URL.
//!
//! The document is rendered to a statement **once, when it is published**, and
//! that statement is what runs. Two reasons, and neither is performance.
//!
//! A revision's promises are frozen the moment it goes live — that is the whole
//! point of the numbering — and a question re-rendered on every call would slip
//! out from under the callers pinned to it the first time somebody added a
//! column to the table. And a rendered statement is something a person can
//! *read*: the endpoint's page shows what will run, which is the only way
//! anybody reviews a draft before it answers.
//!
//! Its values do not travel in the statement. `shape::wrap` binds them, which
//! is the rule everywhere else in this codebase, so what is stored is a
//! statement with placeholders and the values that fill them — see
//! `published::bind` for why a caller may not touch one.

use crate::clickhouse::{Client, ColumnMeta, QueryOptions};
use crate::dataset::inventory;
use crate::dataset::{Asked, Request};
use crate::error::{Error, Result};

use super::shape;

/// The statement a document becomes, and the values it binds.
#[derive(Debug, Clone, Default)]
pub struct Rendered {
    pub sql: String,
    pub bindings: Vec<(String, String)>,
}

/// Where the rendered statement will run, which is also where it is described.
///
/// A document is described under exactly the settings its endpoint runs under.
/// A shape read in one zone and rows read in another is how a schema drifts
/// from its own answers, and a column list read as the manifest account for an
/// endpoint that runs as a role is a column list nobody delegated.
#[derive(Debug, Clone, Default)]
pub struct Runs {
    pub database: Option<String>,
    pub role: Option<String>,
    pub timezone: Option<String>,
}

impl Runs {
    /// The way an endpoint's own three fields spell it.
    pub fn of(database: &str, role: &str, timezone: &str) -> Runs {
        Runs {
            database: (!database.is_empty()).then(|| database.to_string()),
            role: (!role.is_empty()).then(|| role.to_string()),
            timezone: (!timezone.is_empty()).then(|| timezone.to_string()),
        }
    }
}

/// The fields a call carries and an address cannot.
///
/// Every one of them is a property of one request — where this page starts,
/// what format this caller wants, whether this caller wants the total. Stored
/// on an endpoint they would be answers given once on somebody else's behalf,
/// and the caller's own `?offset=` would then be the second answer to a
/// question already answered. Refused rather than dropped, because a document
/// carrying one was written by somebody who believed it would take effect.
const PER_CALL: [&str; 6] = ["offset", "cursor", "count", "format", "explain", "query_id"];

/// A document as a question, or the sentence saying why it is not one.
pub fn question(document: &str) -> std::result::Result<Request, String> {
    let request: Request = serde_json::from_str(document)
        .map_err(|e| format!("this is not a question Flint can read: {e}"))?;

    // `limit` is the one that looks harmless and is not. In the Builder it is a
    // page size — five hundred rows on screen — and published unchanged it
    // would become a ceiling on everything the address can ever return, with
    // the caller's own paging silently stopping at it.
    if request.limit.is_some() {
        return Err(
            "a `limit` is a page size, and a page size belongs to the address rather than \
             to the question — set the endpoint's row cap instead"
                .into(),
        );
    }

    // The endpoint owns its zone, states it in its OpenAPI document, and shows
    // the same days to every caller. A zone in the question would be a second
    // one, invisible beside the field the page displays.
    if !request.timezone.is_empty() {
        return Err(format!(
            "`timezone: {}` belongs to the endpoint rather than to its question, so that \
             every caller is shown the same days — set the endpoint's zone instead",
            request.timezone
        ));
    }

    let present: [bool; 6] = [
        request.offset > 0,
        request.cursor.is_some(),
        request.count,
        request.format.is_some(),
        request.explain,
        request.query_id.is_some(),
    ];
    if let Some(field) = PER_CALL
        .iter()
        .zip(present)
        .find_map(|(name, there)| there.then_some(*name))
    {
        return Err(format!(
            "`{field}` belongs to a call rather than to an address — a caller sends it on \
             the URL, and an endpoint that answered it once would answer it for everybody"
        ));
    }

    Ok(request)
}

/// The document as the statement its endpoint will run.
pub async fn render(ch: &Client, document: &str, runs: &Runs) -> Result<Rendered> {
    let request = question(document).map_err(Error::BadRequest)?;

    // The cap clamps a `limit`, and `question` has just refused every document
    // that carries one — so nothing here is clamped and the figure is never
    // read. Stated rather than left as a mystery constant.
    let Asked {
        name,
        mut shape,
        time,
        ..
    } = request.into_asked(u64::MAX).map_err(Error::BadRequest)?;

    let inner = name.statement();

    // Only where the question names a column. A document that only names a
    // dataset is `SELECT * FROM t` and needs nothing described to say so.
    let columns = if shape.names_columns() || !time.is_empty() {
        describe(ch, &inner, runs).await?
    } else {
        Vec::new()
    };

    // Now the columns are known, so which one each window is on is knowable.
    for plan in time {
        plan.apply(&mut shape, &columns)
            .map_err(Error::BadRequest)?;
    }

    // Whether a column may be summed is a question about the data, so it waits
    // until the data has described itself.
    if let Some(aggregate) = &shape.aggregate {
        inventory::permits(&columns, aggregate).map_err(Error::BadRequest)?;
    }

    if !shape.wraps() {
        return Ok(Rendered {
            sql: inner,
            bindings: Vec::new(),
        });
    }

    // No page. This statement is about to be wrapped a second time, by the
    // endpoint's own shape layer, and *that* is where a page belongs — see
    // `shape::wrap`. The prefix the outer wrap picks steps over these names
    // because `free_prefix` is given them.
    let wrapped = shape::wrap(&inner, &shape, &columns, None, &shape::free_prefix(&[]))
        .map_err(Error::BadRequest)?;

    Ok(Rendered {
        sql: wrapped.sql,
        bindings: wrapped.params,
    })
}

/// The bindings, as the column stores them.
pub fn to_json(bindings: &[(String, String)]) -> String {
    if bindings.is_empty() {
        return String::new();
    }
    let map: serde_json::Map<String, serde_json::Value> = bindings
        .iter()
        .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
        .collect();
    serde_json::Value::Object(map).to_string()
}

/// And back. A column that will not parse reads as no bindings, which makes the
/// statement fail on a named parameter rather than run with a value from
/// nowhere — the safe half of a corrupt row.
pub fn from_json(raw: &str) -> Vec<(String, String)> {
    serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(raw)
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

/// What the rendered statement returns, asked of ClickHouse rather than
/// guessed at.
async fn describe(ch: &Client, inner: &str, runs: &Runs) -> Result<Vec<ColumnMeta>> {
    #[derive(serde::Deserialize)]
    struct Described {
        name: String,
        r#type: String,
    }

    let described: Vec<Described> = ch
        .rows_with(
            &format!("DESCRIBE (\n{inner}\n)"),
            QueryOptions {
                database: runs.database.clone(),
                force_readonly: true,
                role: runs.role.clone(),
                timezone: runs.timezone.clone(),
                quote_64bit_integers: false,
                // Publishing, not calling. This runs once, when somebody saves
                // the endpoint, and counting it as a call would put a row in
                // the usage figures for an endpoint nobody has called yet.
                introspection: true,
                ..Default::default()
            },
        )
        .await?;

    Ok(described
        .into_iter()
        .map(|c| ColumnMeta {
            name: c.name,
            r#type: shape::one_line(&c.r#type),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_size_belongs_to_the_address() {
        let refused = question(r#"{"dataset":"db.t","limit":500}"#).expect_err("a limit");
        assert!(refused.contains("row cap"), "{refused}");
    }

    #[test]
    fn a_zone_belongs_to_the_endpoint() {
        let refused = question(
            r#"{"dataset":"db.t","time":{"column":"ts","granularity":"day"},
                "metrics":[{"aggregation":"count","as":"rows"}],
                "timezone":"Pacific/Auckland"}"#,
        )
        .expect_err("a zone");
        assert!(
            refused.contains("every caller is shown the same days"),
            "{refused}"
        );
    }

    #[test]
    fn what_a_call_carries_is_named_one_at_a_time() {
        // Named, so that somebody who wrote one is told which of the six it was
        // rather than that their document is wrong somewhere.
        for (body, field) in [
            (r#"{"dataset":"db.t","offset":10}"#, "offset"),
            (r#"{"dataset":"db.t","cursor":"abc"}"#, "cursor"),
            (r#"{"dataset":"db.t","count":true}"#, "count"),
            (r#"{"dataset":"db.t","format":"csv"}"#, "format"),
            (r#"{"dataset":"db.t","explain":true}"#, "explain"),
            (r#"{"dataset":"db.t","query_id":"abc"}"#, "query_id"),
        ] {
            let refused = question(body).expect_err(field);
            assert!(refused.contains(field), "{field}: {refused}");
        }
    }

    #[test]
    fn a_question_that_only_names_a_dataset_is_a_question() {
        let asked = question(r#"{"dataset":"analytics.events"}"#).expect("a bare dataset");
        assert_eq!(asked.dataset, "analytics.events");
    }

    #[test]
    fn the_bindings_survive_the_column_they_are_stored_in() {
        let bindings = vec![
            ("flint_f0".to_string(), "Oslo".to_string()),
            ("flint_f1".to_string(), "9".to_string()),
        ];
        let mut back = from_json(&to_json(&bindings));
        back.sort();
        assert_eq!(back, bindings);
        // Nothing stored is nothing bound, and not one empty pair.
        assert_eq!(to_json(&[]), "");
        assert!(from_json("").is_empty());
    }
}
