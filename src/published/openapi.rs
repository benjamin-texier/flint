//! A published endpoint, as an OpenAPI document.
//!
//! The schema route answers what Flint's own page needs. This answers what
//! everything else needs: Swagger UI, Postman, an SDK generator, the person who
//! has to wire this into a service that already documents itself this way. It
//! is the same facts in the one shape those tools all read, which is why it is
//! generated rather than written — a hand-kept document is a document that
//! drifts, and this one is rebuilt from the statement on every request.
//!
//! Two places where an obvious mapping would have been a lie, and is not made:
//!
//! A 64-bit integer is documented as a **string**, because that is what a
//! caller receives. Flint asks ClickHouse to quote them so a JSON reader cannot
//! silently round a value above 2^53, and a document that promised `integer`
//! would send every generated client into a type error at the first big id.
//!
//! A `DateTime` is documented as a string with an example rather than as
//! `format: date-time`. ClickHouse writes `2023-11-14 22:13:20`, which is not
//! RFC 3339 — a validator told it was would reject every row.

use serde_json::{json, Value};

use crate::clickhouse::ColumnMeta;

use super::shape;

/// Everything the document is built from. Primitives rather than the stored
/// record, so this stays a pure function with tests that need no database.
pub struct Endpoint<'a> {
    pub name: &'a str,
    pub slug: &'a str,
    pub public: bool,
    /// The most rows one response may carry.
    pub max_rows: u64,
    /// The statement's own parameters: name, and the type it declared.
    pub parameters: &'a [(String, String)],
    pub defaults: &'a [(String, String)],
    /// What the statement returns, when Flint could describe it.
    pub columns: Option<&'a [ColumnMeta]>,
    /// Reserved names the statement claimed, which Flint therefore does not
    /// offer as query parameters here.
    pub shadowed: &'a [String],
    /// Where this Flint answers, when the request said. Relative otherwise: a
    /// guessed hostname in a document someone pastes into a client is worse
    /// than no hostname at all.
    pub server: Option<&'a str>,
}

/// One endpoint, on its own.
pub fn document(e: &Endpoint) -> Value {
    build(e.name, std::slice::from_ref(e))
}

/// Every endpoint this Flint publishes, in one document.
///
/// The same builder as the single one, because two builders would drift and
/// the drift would show up in somebody's generated client rather than here.
/// What differs is only the naming: with several endpoints in one document the
/// row and answer schemas need names that cannot collide.
pub fn documents(endpoints: &[Endpoint]) -> Value {
    build("Flint APIs", endpoints)
}

/// What a row and an answer schema are called. Bare where there is one
/// endpoint, because a generated `Row` type reads better than a `RowByCity`
/// that distinguishes nothing.
struct Names {
    row: String,
    answer: String,
}

fn build(title: &str, endpoints: &[Endpoint]) -> Value {
    let alone = endpoints.len() == 1;
    let mut taken: Vec<String> = Vec::new();
    let mut paths = serde_json::Map::new();
    let mut schemas = shared_schemas();
    let mut any_needs_a_token = false;

    for e in endpoints {
        let names = if alone {
            Names {
                row: "Row".into(),
                answer: "Answer".into(),
            }
        } else {
            distinct_names(e.slug, &mut taken)
        };
        schemas.insert(names.row.clone(), row_object(e));
        schemas.insert(names.answer.clone(), answer_object(&names));
        paths.insert(
            format!("/api/data/{}", e.slug),
            json!({ "get": operation(e, &names) }),
        );
        any_needs_a_token |= !e.public;
    }

    let mut components = json!({ "schemas": schemas });
    if any_needs_a_token {
        components["securitySchemes"] = json!({
            "flintToken": {
                "type": "apiKey",
                "in": "header",
                "name": "X-Flint-Token",
                "description": "Also accepted as a Bearer authorization or a `token` query \
                                parameter — but a token in a URL ends up in logs.",
            },
        });
    }

    json!({
        "openapi": "3.1.0",
        "info": {
            "title": title,
            "version": "1.0.0",
            "description": if alone {
                "A statement published by Flint. Callers supply values, never SQL, and the \
                 statement always runs read-only."
            } else {
                "Statements published by Flint. Callers supply values, never SQL, and a \
                 published statement always runs read-only. Each endpoint carries its own \
                 token unless someone deliberately made it public."
            },
        },
        "servers": [{ "url": endpoints.first().and_then(|e| e.server).unwrap_or("/") }],
        "paths": paths,
        "components": components,
    })
}

fn operation(e: &Endpoint, names: &Names) -> Value {
    let mut operation = json!({
        "operationId": operation_id(e.slug),
        "summary": e.name,
        "description": describe(e),
        // Tagged by endpoint rather than by product: in a document with twenty
        // of them, one "Flint" tag is a list of twenty things to scroll.
        "tags": [e.name],
        "parameters": parameters(e),
        "responses": responses(e, names),
    });
    if !e.public {
        operation["security"] = json!([{ "flintToken": [] }]);
    }
    operation
}

/// A schema name no other endpoint in this document is using.
fn distinct_names(slug: &str, taken: &mut Vec<String>) -> Names {
    let mut suffix = camel(slug);
    suffix = format!("{}{}", suffix.remove(0).to_uppercase(), suffix);
    // Two slugs can camel down to the same word — `by-city` and `by_city` do.
    // A counter is ugly and a collision is wrong.
    let mut candidate = suffix.clone();
    let mut n = 2;
    while taken.contains(&format!("Row{candidate}")) {
        candidate = format!("{suffix}{n}");
        n += 1;
    }
    taken.push(format!("Row{candidate}"));
    Names {
        row: format!("Row{candidate}"),
        answer: format!("Answer{candidate}"),
    }
}

/// A name a generator can turn into a method. `by-city` is not one.
fn operation_id(slug: &str) -> String {
    let mut name = camel(slug);
    format!("get{}{}", name.remove(0).to_uppercase(), name)
}

/// `events-by-city` → `eventsByCity`.
fn camel(slug: &str) -> String {
    let mut out = String::with_capacity(slug.len());
    let mut upper = false;
    for ch in slug.chars() {
        if ch == '-' || ch == '_' {
            upper = true;
        } else if upper {
            out.extend(ch.to_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    out
}

fn describe(e: &Endpoint) -> String {
    let mut said = format!(
        "Up to {} rows per response; `limit` and `offset` page through the rest.",
        e.max_rows
    );
    if !e.shadowed.is_empty() {
        // Said rather than left out: a reader who knows Flint would otherwise
        // look for `limit` here and conclude the document was incomplete.
        let names = e
            .shadowed
            .iter()
            .map(|s| format!("`{s}`"))
            .collect::<Vec<_>>()
            .join(", ");
        said.push_str(&if e.shadowed.len() == 1 {
            format!(
                " This statement declares {names} itself, so that name is its own parameter \
                 rather than Flint's paging."
            )
        } else {
            format!(
                " This statement declares {names} itself, so those names are its own \
                 parameters rather than Flint's paging."
            )
        });
    }
    if e.columns.is_none() {
        said.push_str(
            " Flint could not describe this statement without running it, so the columns it \
             returns are not listed and no filter parameters are documented.",
        );
    }
    said
}

fn parameters(e: &Endpoint) -> Vec<Value> {
    let mut out = Vec::new();

    // The question first: what the statement itself asks for.
    for (name, ty) in e.parameters {
        let default = e.defaults.iter().find(|(k, _)| k == name).map(|(_, v)| v);
        let mut schema = input_schema(ty);
        if let Some(value) = default {
            schema["default"] = json!(value);
        }
        out.push(json!({
            "name": name,
            "in": "query",
            "required": default.is_none(),
            "description": format!("Declared by the statement as `{{{name}:{ty}}}`."),
            "schema": schema,
        }));
    }

    let free = |name: &str| !e.shadowed.iter().any(|s| s == name);

    if free("limit") {
        out.push(json!({
            "name": "limit", "in": "query", "required": false,
            "description": "Rows in this response. Clamped to the endpoint's page size.",
            "schema": { "type": "integer", "minimum": 1, "maximum": e.max_rows, "default": e.max_rows },
        }));
    }
    if free("offset") {
        out.push(json!({
            "name": "offset", "in": "query", "required": false,
            "description": "Rows to skip. A page is only stable if the rows have an \
                            order — pass `order`, or put an ORDER BY in the statement, or \
                            two pages can repeat and skip rows. Follow the `Link` header \
                            rather than counting, where you can.",
            "schema": { "type": "integer", "minimum": 0, "default": 0 },
        }));
    }
    if free("cursor") {
        out.push(json!({
            "name": "cursor", "in": "query", "required": false,
            "description": "Where the last page stopped — from `page.cursor` or the \
                            `X-Flint-Cursor` header. Send the same `order` with it. Prefer \
                            this to `offset` wherever the order allows one: a cursor cannot \
                            lose or repeat a row when the rows move underneath it.",
            "schema": { "type": "string" },
        }));
    }
    if free("order") {
        out.push(json!({
            "name": "order", "in": "query", "required": false,
            "description": "Comma-separated `column`, `column.asc` or `column.desc`.",
            "schema": { "type": "string" },
            "example": "amount.desc,id",
        }));
    }
    if free("select") {
        out.push(json!({
            "name": "select", "in": "query", "required": false,
            "description": "Comma-separated column names. Every column, if left out.",
            "schema": { "type": "string" },
        }));
    }
    if free("count") {
        out.push(json!({
            "name": "count", "in": "query", "required": false,
            "description": "`exact` adds a real total to the answer. It is a second pass over \
                            the same rows, so it is off unless asked for.",
            "schema": { "type": "string", "enum": ["exact"] },
        }));
    }
    if free("format") {
        out.push(json!({
            "name": "format", "in": "query", "required": false,
            "description": "`json` is the envelope below; `csv` and `ndjson` are the rows \
                            alone, and say where the page is in the response headers.",
            "schema": { "type": "string", "enum": ["json", "csv", "ndjson"], "default": "json" },
        }));
    }

    // And one filter per column that takes one. Skipped where the statement or
    // Flint already claims the name: the same key cannot mean two things.
    for column in e.columns.unwrap_or(&[]) {
        let ops = shape::ops_for(&column.r#type);
        if ops.is_empty()
            || e.parameters.iter().any(|(n, _)| *n == column.name)
            || shape::RESERVED.contains(&column.name.as_str())
        {
            continue;
        }
        out.push(json!({
            "name": column.name,
            "in": "query",
            "required": false,
            "description": format!(
                "Filter on `{}` ({}). Write `operator.value`, with one of: {}.",
                column.name,
                column.r#type,
                ops.join(", ")
            ),
            "schema": { "type": "string" },
            // A shape rather than a value: the operator is the part a caller
            // has to learn, and inventing a plausible value for someone else's
            // column would be inventing data.
            "example": format!("{}.value", ops[0]),
        }));
    }

    out
}

fn responses(e: &Endpoint, names: &Names) -> Value {
    let paging = json!({
        "X-Flint-Limit": { "description": "Rows this response could carry.", "schema": { "type": "integer" } },
        "X-Flint-Offset": { "description": "Rows skipped before it.", "schema": { "type": "integer" } },
        "X-Flint-Returned": { "description": "Rows it actually carries.", "schema": { "type": "integer" } },
        "X-Flint-Has-More": { "description": "Whether there is another page.", "schema": { "type": "boolean" } },
        "X-Flint-Total": { "description": "Only when `count=exact` was asked for.", "schema": { "type": "integer" } },
        "X-Flint-Cursor": { "description": "Where this page stopped. Send it back as `cursor`, with the same `order`.", "schema": { "type": "string" } },
        "Link": { "description": "The next page, as `<url>; rel=\"next\"`. Absent on the last one.", "schema": { "type": "string" } },
    });

    let mut answers = json!({
        "200": {
            "description": "One page of rows.",
            "headers": paging,
            "content": {
                "application/json": { "schema": { "$ref": format!("#/components/schemas/{}", names.answer) } },
                "text/csv": {
                    "schema": { "type": "string" },
                    "example": "a header row, then one line per row",
                },
                "application/x-ndjson": {
                    "schema": { "type": "string" },
                    "example": "one JSON object per line, no envelope",
                },
            },
        },
        "400": {
            "description": "A parameter is missing, or the shape asked for cannot be served — \
                            an unknown column, an operator a column does not take.",
            "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } },
        },
        "404": {
            "description": "No endpoint at this address. A paused endpoint answers the same way.",
            "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } },
        },
    });

    if !e.public {
        answers["401"] = json!({
            "description": "The token was missing or wrong.",
            "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } },
        });
    }
    answers
}

/// The columns this endpoint returns, as a schema.
fn row_object(e: &Endpoint) -> Value {
    match e.columns {
        Some(columns) => {
            let mut properties = serde_json::Map::new();
            for column in columns {
                properties.insert(column.name.clone(), row_schema(&column.r#type));
            }
            json!({
                "type": "object",
                "properties": properties,
                // A statement can return a column Flint could not name at
                // describe time; the answer is still the answer.
                "additionalProperties": true,
            })
        }
        None => json!({
            "type": "object",
            "description": "Flint could not describe this statement without running it.",
            "additionalProperties": true,
        }),
    }
}

fn answer_object(names: &Names) -> Value {
    json!({
        "type": "object",
        "properties": {
            "rows": {
                "type": "array",
                "items": { "$ref": format!("#/components/schemas/{}", names.row) },
            },
            "columns": { "type": "array", "items": { "type": "string" } },
            "page": { "$ref": "#/components/schemas/Page" },
            "total": {
                "type": "integer",
                "description": "Only when `count=exact` was asked for.",
            },
            "truncated": {
                "type": "boolean",
                "description": "The same fact as `page.has_more`, under the name it has \
                                always had here.",
            },
        },
        "required": ["rows", "columns", "page", "truncated"],
    })
}

/// The two schemas every endpoint in a document shares.
fn shared_schemas() -> serde_json::Map<String, Value> {
    let mut schemas = serde_json::Map::new();
    schemas.insert(
        "Page".into(),
        json!({
            "type": "object",
            "properties": {
                "limit": { "type": "integer" },
                "offset": { "type": "integer" },
                "returned": { "type": "integer" },
                "has_more": { "type": "boolean" },
                "max_limit": { "type": "integer" },
                "limit_asked": {
                    "type": "integer",
                    "description": "Only when a bigger page was asked for than this endpoint \
                                    serves.",
                },
                "cursor": {
                    "type": "string",
                    "description": "Where this page stopped. Send it back as `cursor`, with \
                                    the same `order`. Absent where the order cannot carry \
                                    one — see `cursor_note`.",
                },
                "cursor_note": {
                    "type": "string",
                    "description": "Why there is no cursor, when there is an order but no \
                                    cursor to give.",
                },
                "next": {
                    "type": "string",
                    "description": "The next page. Absent on the last one.",
                },
            },
            "required": ["limit", "offset", "returned", "has_more", "max_limit"],
        }),
    );
    schemas.insert(
        "Error".into(),
        json!({
            "type": "object",
            "properties": {
                "error": {
                    "type": "object",
                    "properties": {
                        "kind": { "type": "string" },
                        "message": { "type": "string" },
                        "clickhouse_code": { "type": ["integer", "null"] },
                    },
                },
            },
        }),
    );
    schemas
}

/// A declared `{name:Type}` parameter, as a caller sends it.
///
/// Everything crosses a query string as text; the type is here because a
/// generator that knows `n` is a number produces a better client, and because
/// ClickHouse will refuse anything else anyway.
fn input_schema(declared: &str) -> Value {
    match shape::family(declared) {
        shape::Family::Number => match numeric_kind(declared) {
            Numeric::Integer => json!({ "type": "integer" }),
            Numeric::Number => json!({ "type": "number" }),
            // Wider than a double: sent as text, or the client rounds it.
            Numeric::Wide => json!({ "type": "string", "x-clickhouse-type": declared }),
        },
        shape::Family::Temporal => json!({
            "type": "string",
            "description": "A date or a timestamp. `2024-01-01` and \
                            `2024-01-01 12:00:00` both parse.",
            "x-clickhouse-type": declared,
        }),
        _ => json!({ "type": "string", "x-clickhouse-type": declared }),
    }
}

/// A column of the result, as a caller receives it.
fn row_schema(ty: &str) -> Value {
    let base = shape::base_type(ty);
    let head = base.split('(').next().unwrap_or(base).trim();

    let mut schema = match head {
        "Bool" | "Boolean" => json!({ "type": "boolean" }),
        "Date" | "Date32" => json!({ "type": "string", "format": "date" }),
        // Not `format: date-time`: ClickHouse writes `2023-11-14 22:13:20`,
        // which is not RFC 3339, and a validator told otherwise rejects every
        // row it is given.
        "DateTime" | "DateTime64" => json!({
            "type": "string",
            "example": "2023-11-14 22:13:20",
        }),
        "Array" => json!({
            "type": "array",
            "items": inner_of(base).map(row_schema).unwrap_or_else(|| json!({})),
        }),
        "Map" | "Tuple" | "Nested" | "JSON" | "Object" => json!({ "type": "object" }),
        _ => match shape::family(base) {
            shape::Family::Number => match numeric_kind(base) {
                Numeric::Integer => json!({ "type": "integer" }),
                Numeric::Number => json!({ "type": "number" }),
                // The one that would bite hardest: Flint asks ClickHouse to
                // quote 64-bit integers so a JSON reader cannot silently round
                // an id above 2^53, so a caller receives a string.
                Numeric::Wide => json!({
                    "type": "string",
                    "description": "Sent as a string: 64 bits do not survive a JSON number.",
                }),
            },
            _ => json!({ "type": "string" }),
        },
    };

    schema["x-clickhouse-type"] = json!(ty);
    if shape::is_nullable(ty) {
        // OpenAPI 3.1 is JSON Schema: a nullable type is a union with null.
        if let Some(name) = schema.get("type").and_then(Value::as_str) {
            schema["type"] = json!([name, "null"]);
        }
    }
    schema
}

enum Numeric {
    Integer,
    Number,
    /// Wider than a JSON number can hold without losing digits.
    Wide,
}

fn numeric_kind(ty: &str) -> Numeric {
    let base = shape::base_type(ty);
    let head = base.split('(').next().unwrap_or(base).trim();
    match head {
        "Float32" | "Float64" | "BFloat16" => Numeric::Number,
        "Int8" | "Int16" | "Int32" | "UInt8" | "UInt16" | "UInt32" => Numeric::Integer,
        _ => Numeric::Wide,
    }
}

/// `Array(Nullable(String))` → `Nullable(String)`.
fn inner_of(ty: &str) -> Option<&str> {
    let open = ty.find('(')?;
    let close = ty.rfind(')')?;
    (close > open + 1).then(|| ty[open + 1..close].trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str) -> ColumnMeta {
        ColumnMeta {
            name: name.into(),
            r#type: ty.into(),
        }
    }

    fn endpoint<'a>(columns: Option<&'a [ColumnMeta]>, shadowed: &'a [String]) -> Endpoint<'a> {
        Endpoint {
            name: "Events by city",
            slug: "events-by-city",
            public: false,
            max_rows: 1000,
            parameters: &[],
            defaults: &[],
            columns,
            shadowed,
            server: None,
        }
    }

    #[test]
    fn a_slug_becomes_a_name_a_generator_can_use() {
        assert_eq!(operation_id("events-by-city"), "getEventsByCity");
        assert_eq!(operation_id("v2_totals"), "getV2Totals");
        assert_eq!(operation_id("a"), "getA");
    }

    #[test]
    fn a_wide_integer_is_documented_as_the_string_a_caller_receives() {
        // Flint asks ClickHouse to quote 64-bit integers so a JSON reader
        // cannot silently round an id, so `integer` here would send every
        // generated client into a type error at the first big value.
        assert_eq!(row_schema("UInt64")["type"], json!("string"));
        assert_eq!(row_schema("Decimal(38, 4)")["type"], json!("string"));
        assert_eq!(row_schema("UInt32")["type"], json!("integer"));
        assert_eq!(row_schema("Float64")["type"], json!("number"));
    }

    #[test]
    fn a_timestamp_does_not_claim_a_format_it_does_not_have() {
        // ClickHouse writes `2023-11-14 22:13:20`, which is not RFC 3339.
        let schema = row_schema("DateTime");
        assert_eq!(schema["type"], json!("string"));
        assert!(schema.get("format").is_none(), "{schema}");
        assert_eq!(row_schema("Date")["format"], json!("date"));
    }

    #[test]
    fn a_nullable_column_is_a_union_with_null() {
        assert_eq!(
            row_schema("Nullable(String)")["type"],
            json!(["string", "null"])
        );
        assert_eq!(
            row_schema("LowCardinality(Nullable(String))")["x-clickhouse-type"],
            json!("LowCardinality(Nullable(String))")
        );
    }

    #[test]
    fn an_array_documents_what_it_holds() {
        let schema = row_schema("Array(Nullable(Int64))");
        assert_eq!(schema["type"], json!("array"));
        assert_eq!(schema["items"]["type"], json!(["string", "null"]));
    }

    #[test]
    fn every_filterable_column_becomes_a_parameter() {
        let columns = vec![
            col("city", "String"),
            col("n", "UInt32"),
            col("tags", "Array(String)"),
        ];
        let doc = document(&endpoint(Some(&columns), &[]));
        let names: Vec<String> = doc["paths"]["/api/data/events-by-city"]["get"]["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["name"].as_str().unwrap().to_string())
            .collect();
        assert!(names.contains(&"city".to_string()));
        assert!(names.contains(&"n".to_string()));
        // Returned, but not something a caller can compare against.
        assert!(!names.contains(&"tags".to_string()));
        assert!(names.contains(&"limit".to_string()));
    }

    #[test]
    fn a_reserved_name_the_statement_took_is_not_offered_twice() {
        let shadowed = vec!["limit".to_string()];
        let doc = document(&endpoint(None, &shadowed));
        let names: Vec<String> = doc["paths"]["/api/data/events-by-city"]["get"]["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["name"].as_str().unwrap().to_string())
            .collect();
        assert!(!names.contains(&"limit".to_string()));
        assert!(names.contains(&"offset".to_string()));
        let described = doc["paths"]["/api/data/events-by-city"]["get"]["description"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(described.contains("`limit`"), "{described}");
    }

    #[test]
    fn an_undescribed_statement_says_so_rather_than_documenting_nothing() {
        let doc = document(&endpoint(None, &[]));
        assert_eq!(
            doc["components"]["schemas"]["Row"]["additionalProperties"],
            json!(true)
        );
        assert!(
            doc["paths"]["/api/data/events-by-city"]["get"]["description"]
                .as_str()
                .unwrap()
                .contains("could not describe")
        );
    }

    #[test]
    fn a_public_endpoint_carries_no_security_scheme() {
        let columns: Vec<ColumnMeta> = Vec::new();
        let mut e = endpoint(Some(&columns), &[]);
        e.public = true;
        let doc = document(&e);
        assert!(doc["paths"]["/api/data/events-by-city"]["get"]
            .get("security")
            .is_none());
        assert!(doc["components"].get("securitySchemes").is_none());
        assert!(doc["paths"]["/api/data/events-by-city"]["get"]["responses"]
            .get("401")
            .is_none());
    }

    #[test]
    fn every_reference_in_the_document_resolves() {
        // A `$ref` at a schema that does not exist renders as an empty box in
        // Swagger UI and as a broken type in a generator — silent both times.
        let columns = vec![col("city", "String")];
        for public in [true, false] {
            let mut e = endpoint(Some(&columns), &[]);
            e.public = public;
            let doc = document(&e);
            let mut refs = Vec::new();
            collect_refs(&doc, &mut refs);
            assert!(!refs.is_empty());
            for reference in refs {
                let path = reference
                    .strip_prefix("#/")
                    .unwrap_or_else(|| panic!("`{reference}` is not a local reference"));
                let mut at = &doc;
                for step in path.split('/') {
                    at = at
                        .get(step)
                        .unwrap_or_else(|| panic!("`{reference}` has no `{step}`"));
                }
            }
        }
    }

    fn collect_refs(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    if key == "$ref" {
                        if let Some(reference) = child.as_str() {
                            out.push(reference.to_string());
                        }
                    } else {
                        collect_refs(child, out);
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|item| collect_refs(item, out)),
            _ => {}
        }
    }

    #[test]
    fn the_server_is_relative_unless_the_request_said_otherwise() {
        assert_eq!(
            document(&endpoint(None, &[]))["servers"][0]["url"],
            json!("/")
        );
        let mut e = endpoint(None, &[]);
        e.server = Some("https://flint.example");
        assert_eq!(
            document(&e)["servers"][0]["url"],
            json!("https://flint.example")
        );
    }
}
