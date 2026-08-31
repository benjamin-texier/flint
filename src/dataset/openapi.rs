//! The dataset API, as an OpenAPI document.
//!
//! One document for the whole query language, not one per anything — there is
//! nothing to publish here, so there is no object to write a document about.
//! What there is instead is a vocabulary, and it is the same vocabulary for
//! everybody.
//!
//! What *is* per-caller is the `dataset` enum. It is built from the listing,
//! which ClickHouse has already narrowed to what this caller's grants reach —
//! so two people fetching this document get two documents, each naming exactly
//! the datasets that person can read. The consequence is worth stating rather
//! than discovering: **a client generated from this is generated for one user.**
//! Anyone who wants one document for a team should generate it as the account
//! that team shares, or drop the enum and pass the name as a string.
//!
//! Generated rather than written, for the reason the published face's document
//! is: a hand-kept document drifts, and this one is rebuilt on every request
//! from the same constants the parser uses. An operator that is added to
//! `shape::Op` appears here without anybody remembering to add it.

use serde_json::{json, Value};

use crate::dataset::time;
use crate::published::shape::{Agg, Op, Unit};

/// The most datasets one document will name.
///
/// Past this the enum stops being documentation and becomes a wall — a Swagger
/// UI dropdown of four thousand names helps nobody. The field falls back to a
/// plain string and says where the real list is, which is the same answer with
/// one more request in it.
const ENUM_CAP: usize = 200;

/// The document, for a caller who can read these datasets.
pub fn document(datasets: &[String], server: Option<&str>) -> Value {
    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "Flint — datasets",
            "version": "1.0.0",
            "description":
                "Read any table or view you have been granted, without publishing anything \
                 first. Every request runs as the signed-in ClickHouse user, so grants and \
                 row policies decide what comes back — this API adds no access rules of its \
                 own and keeps no list of what may be read.\n\n\
                 Callers supply values and column names, never SQL. Column names are checked \
                 against what the dataset really returns, and values travel as bound \
                 parameters.",
        },
        "servers": [{ "url": server.unwrap_or("/") }],
        "security": [{ "flintSession": [] }],
        "paths": {
            "/api/data": { "post": query_operation() },
            "/api/data/schema": { "post": schema_operation() },
            "/api/data/list": { "post": list_operation() },
        },
        "components": {
            "securitySchemes": {
                "flintSession": {
                    "type": "http",
                    "scheme": "bearer",
                    "description":
                        "A session, from `POST /api/login` with `\"bearer\": true`. A browser \
                         may send the session cookie instead. Bearers are short and idle out; \
                         re-authenticate on a 401 rather than refreshing on a timer.",
                },
            },
            "schemas": schemas(datasets),
            "responses": {
                "Refused": {
                    "description": "The request was not one this API could answer — a column \
                                    that is not there, an aggregation the column does not \
                                    take, a window with no end, or no session at all. The \
                                    message says which.",
                    "content": { "application/json": {
                        "schema": { "$ref": "#/components/schemas/Error" },
                    }},
                },
            },
        },
    })
}

fn query_operation() -> Value {
    json!({
        "operationId": "queryDataset",
        "summary": "Read a dataset",
        "description":
            "Filter, group, measure and page one table or view. Without `dimensions`, \
             `metrics` or a `granularity` this returns rows; with any of them it returns \
             groups.",
        "tags": ["Datasets"],
        "requestBody": {
            "required": true,
            "content": { "application/json": {
                "schema": { "$ref": "#/components/schemas/Query" },
            }},
        },
        "responses": {
            "200": {
                "description": "The page, and where the next one starts.",
                "content": { "application/json": {
                    "schema": { "$ref": "#/components/schemas/Page" },
                }},
            },
            "400": { "$ref": "#/components/responses/Refused" },
            "401": { "$ref": "#/components/responses/Refused" },
            "403": {
                "description": "Your grants do not reach this dataset.",
                "content": { "application/json": {
                    "schema": { "$ref": "#/components/schemas/Error" },
                }},
            },
            "404": {
                "description": "No such dataset on this server.",
                "content": { "application/json": {
                    "schema": { "$ref": "#/components/schemas/Error" },
                }},
            },
        },
    })
}

fn schema_operation() -> Value {
    json!({
        "operationId": "describeDataset",
        "summary": "What a dataset can be asked",
        "description":
            "Each column's kind, the operators it can be filtered with, and the \
             aggregations it accepts. Derived from the dataset itself — nothing is \
             configured, so a view added today is described today.",
        "tags": ["Datasets"],
        "requestBody": {
            "required": true,
            "content": { "application/json": { "schema": {
                "type": "object",
                "required": ["dataset"],
                "additionalProperties": false,
                "properties": { "dataset": { "type": "string" } },
            }}},
        },
        "responses": { "200": {
            "description": "The column inventory.",
            "content": { "application/json": {
                "schema": { "$ref": "#/components/schemas/Inventory" },
            }},
        }},
    })
}

fn list_operation() -> Value {
    json!({
        "operationId": "listDatasets",
        "summary": "Which datasets you can read",
        "description":
            "Narrowed by your grants, by ClickHouse rather than by Flint — so this is the \
             authoritative answer for you, and somebody else's answer will differ.",
        "tags": ["Datasets"],
        "requestBody": {
            "required": false,
            "content": { "application/json": { "schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "database": {
                        "type": "string",
                        "description": "One database, rather than all of them.",
                    },
                },
            }}},
        },
        "responses": { "200": {
            "description": "The datasets, and a note where the list was capped.",
            "content": { "application/json": {
                "schema": { "$ref": "#/components/schemas/Listing" },
            }},
        }},
    })
}

/// The `dataset` field: an enum where that is still useful, a string otherwise.
fn dataset_field(datasets: &[String]) -> Value {
    if datasets.is_empty() || datasets.len() > ENUM_CAP {
        let note = if datasets.is_empty() {
            "The table or view to read, as `database.table`.".to_string()
        } else {
            format!(
                "The table or view to read, as `database.table`. You can read {} of them — \
                 too many to list here; call `/api/data/list` for the current set.",
                datasets.len()
            )
        };
        return json!({ "type": "string", "description": note });
    }
    json!({
        "type": "string",
        "description": "The table or view to read, as `database.table`. This list is the \
                        datasets *your* grants reach; another caller's document will differ.",
        "enum": datasets,
    })
}

fn schemas(datasets: &[String]) -> Value {
    json!({
        "Query": {
            "type": "object",
            "required": ["dataset"],
            "additionalProperties": false,
            "properties": {
                "dataset": dataset_field(datasets),
                "select": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Columns to return. Empty means all of them. Cannot be \
                                    combined with `dimensions`/`metrics`, which compute \
                                    columns rather than naming them.",
                },
                "filter": { "$ref": "#/components/schemas/Filter" },
                "dimensions": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Group by these columns.",
                },
                "metrics": {
                    "type": "array",
                    "items": { "$ref": "#/components/schemas/Metric" },
                },
                "having": {
                    "allOf": [{ "$ref": "#/components/schemas/Filter" }],
                    "description": "A filter on what was computed, applied after the \
                                    grouping. Names what the answer returns — a dimension, a \
                                    metric's name, the time bucket — rather than the \
                                    dataset's own columns. Use `filter` to narrow the rows \
                                    that go into the grouping.",
                },
                "time": { "$ref": "#/components/schemas/Time" },
                "timezone": {
                    "type": "string",
                    "description": "Where the days begin — an IANA name such as \
                                    `Europe/Paris`, or left out for the server's own. It \
                                    moves every boundary in `time`: `last: 7d` counts back \
                                    from your midnight, a `day` bucket cuts at yours, and \
                                    an explicit `from`/`to` is read as a wall clock in it — \
                                    the same two strings select different rows in two \
                                    zones. \
                                    The answer always names the zone it used, whether or \
                                    not you chose one. Refused on a query with no window \
                                    and no bucket, where it would place nothing.",
                },
                "order": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["column"],
                        "additionalProperties": false,
                        "properties": {
                            "column": { "type": "string" },
                            "desc": { "type": "boolean", "default": false },
                        },
                    },
                    "description": "On an aggregated answer this names what the answer \
                                    returns — a dimension, a metric's name, the time bucket \
                                    — not the dataset's own columns.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Rows in this page. Clamped to the deployment's cap, and \
                                    `page.limit_asked` says so when it was.",
                },
                "offset": { "type": "integer", "minimum": 0 },
                "cursor": {
                    "type": "string",
                    "description": "From `page.cursor`. Cannot lose or repeat a row the way \
                                    an offset can, and is not offered on an aggregated \
                                    answer, whose rows are computed rather than stored.",
                },
                "count": {
                    "type": "boolean",
                    "description": "Also return a total. A second pass over the same rows, so \
                                    it is off unless asked for. On an aggregated answer it \
                                    counts groups.",
                },
                "format": {
                    "type": "string",
                    "enum": ["json", "csv", "ndjson"],
                    "default": "json",
                },
            },
        },
        // Recursive, and it has to be: the one thing a body can express that a
        // query string cannot is a filter with an `OR` inside an `AND`.
        "Filter": {
            "type": "object",
            "additionalProperties": false,
            "description": "One of four shapes: `all`, `any`, `not`, or a comparison. Not \
                            several at once.",
            "properties": {
                "all": { "type": "array", "items": { "$ref": "#/components/schemas/Filter" } },
                "any": { "type": "array", "items": { "$ref": "#/components/schemas/Filter" } },
                "not": { "$ref": "#/components/schemas/Filter" },
                "column": { "type": "string" },
                "op": { "type": "string", "enum": Op::keywords() },
                "value": { "description": "For the operators taking one value." },
                "values": {
                    "type": "array",
                    "description": "For `in` and `nin`. A body can carry a long list; a URL \
                                    cannot, which is half of why this API exists.",
                },
            },
        },
        "Metric": {
            "type": "object",
            "required": ["aggregation"],
            "additionalProperties": false,
            "properties": {
                "aggregation": { "type": "string", "enum": Agg::keywords() },
                "column": {
                    "type": "string",
                    "description": "Required except for `count`, which counts rows. Which \
                                    aggregations a column accepts depends on what it is — \
                                    ask `/api/data/schema`. `distinct_count` is exact and \
                                    `distinct_count_approx` is not, which is why they are \
                                    two words rather than one with a flag.",
                },
                "as": {
                    "type": "string",
                    "description": "The name it arrives under. Defaults to \
                                    `aggregation_column`, e.g. `avg_temperature`.",
                },
            },
        },
        "Time": {
            "type": "object",
            "additionalProperties": false,
            "description": "A window, a granularity, or both. `last` rolls; `period` aligns \
                            to calendar boundaries. Every window is half-open, so paging \
                            through periods never counts a boundary row twice.",
            "properties": {
                "column": {
                    "type": "string",
                    "description": "Which date or timestamp. Optional where the dataset has \
                                    exactly one.",
                },
                "last": { "type": "integer", "minimum": 1 },
                "unit": { "type": "string", "enum": Unit::keywords() },
                "period": { "type": "string", "enum": time::period_names() },
                "from": { "type": "string" },
                "to": { "type": "string" },
                "granularity": {
                    "type": "string",
                    "enum": Unit::keywords(),
                    "description": "Bucket the column. The bucket arrives as \
                                    `<column>_<unit>`, e.g. `ts_day`.",
                },
                "compare": {
                    "type": "string",
                    "enum": time::comparisons(),
                    "description": "Ask the same question of a second window. Both come back \
                                    together, told apart by a `window` column whose values \
                                    are `current` and `previous`. Needs a metric, and a \
                                    window Flint can move — `last` or `period`.",
                },
            },
        },
        "Page": {
            "type": "object",
            "properties": {
                "rows": { "type": "array", "items": { "type": "object" } },
                "columns": { "type": "array", "items": { "type": "string" } },
                "sql": {
                    "type": "string",
                    "description": "The statement this question became. Yours to read: every \
                                    column and every value in it came from your request.",
                },
                "total": {
                    "type": "integer",
                    "description": "Only when `count` was asked for.",
                },
                "page": {
                    "type": "object",
                    "properties": {
                        "dataset": { "type": "string" },
                        "limit": { "type": "integer" },
                        "offset": { "type": "integer" },
                        "returned": { "type": "integer" },
                        "has_more": { "type": "boolean" },
                        "max_limit": { "type": "integer" },
                        "limit_asked": {
                            "type": "integer",
                            "description": "Only when the page served was smaller than the \
                                            one asked for.",
                        },
                        "cursor": { "type": "string" },
                        "cursor_note": {
                            "type": "string",
                            "description": "Why there is no cursor, when there is an order \
                                            but no cursor to give.",
                        },
                    },
                },
            },
        },
        "Inventory": {
            "type": "object",
            "properties": {
                "dataset": { "type": "string" },
                "groupable": { "type": "integer" },
                "measurable": { "type": "integer" },
                "note": { "type": "string" },
                "columns": { "type": "array", "items": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "type": { "type": "string" },
                        "kind": {
                            "type": "string",
                            "enum": ["id", "time", "bool", "text", "numeric", "unsupported"],
                        },
                        "group": { "type": "boolean" },
                        "filter": { "type": "array", "items": { "type": "string" } },
                        "aggregate": { "type": "array", "items": { "type": "string" } },
                        "nullable": { "type": "boolean" },
                    },
                }},
            },
        },
        "Listing": {
            "type": "object",
            "properties": {
                "count": { "type": "integer" },
                "note": { "type": "string" },
                "datasets": { "type": "array", "items": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "database": { "type": "string" },
                        "table": { "type": "string" },
                        "kind": {
                            "type": "string",
                            "enum": ["table", "view", "materialized_view", "dictionary"],
                        },
                        "rows": {
                            "type": "integer",
                            "description": "Absent where there is none — a view has no size.",
                        },
                        "bytes": { "type": "integer" },
                    },
                }},
            },
        },
        "Error": {
            "type": "object",
            "properties": { "error": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string" },
                    "message": { "type": "string" },
                },
            }},
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(datasets: &[&str]) -> Vec<String> {
        datasets.iter().map(|d| (*d).to_string()).collect()
    }

    #[test]
    fn the_dataset_enum_is_this_caller_s_own() {
        let doc = document(&names(&["analytics.events", "analytics.devices"]), None);
        let field = &doc["components"]["schemas"]["Query"]["properties"]["dataset"];
        assert_eq!(
            field["enum"],
            json!(["analytics.events", "analytics.devices"])
        );
    }

    #[test]
    fn too_many_datasets_stop_being_documentation() {
        // A dropdown of four thousand names helps nobody, so past the cap the
        // field is a plain string that says where the real list is.
        let many: Vec<String> = (0..=ENUM_CAP).map(|n| format!("db.t{n}")).collect();
        let doc = document(&many, None);
        let field = &doc["components"]["schemas"]["Query"]["properties"]["dataset"];
        assert!(field["enum"].is_null());
        assert_eq!(field["type"], "string");
        assert!(
            field["description"]
                .as_str()
                .unwrap()
                .contains("/api/data/list"),
            "{field}"
        );
    }

    #[test]
    fn a_caller_who_can_read_nothing_still_gets_a_usable_document() {
        // An empty enum is invalid in JSON Schema and would break every
        // generator, so the field falls back rather than being emitted empty.
        let doc = document(&[], None);
        let field = &doc["components"]["schemas"]["Query"]["properties"]["dataset"];
        assert!(field["enum"].is_null());
        assert_eq!(field["type"], "string");
    }

    #[test]
    fn the_vocabulary_comes_from_the_parser_rather_than_from_this_file() {
        // The whole reason it is generated: an operator added to `shape::Op`
        // has to appear here without anybody remembering to come and add it.
        let doc = document(&names(&["a.b"]), None);
        let ops = &doc["components"]["schemas"]["Filter"]["properties"]["op"]["enum"];
        assert_eq!(ops.as_array().unwrap().len(), Op::keywords().len());
        assert!(ops.as_array().unwrap().contains(&json!("ilike")));

        let aggs = &doc["components"]["schemas"]["Metric"]["properties"]["aggregation"]["enum"];
        assert_eq!(aggs.as_array().unwrap().len(), Agg::keywords().len());

        let periods = &doc["components"]["schemas"]["Time"]["properties"]["period"]["enum"];
        assert!(periods
            .as_array()
            .unwrap()
            .contains(&json!("previous_month")));
    }

    #[test]
    fn the_filter_refers_to_itself_because_a_filter_is_a_tree() {
        let doc = document(&names(&["a.b"]), None);
        let filter = &doc["components"]["schemas"]["Filter"];
        assert_eq!(
            filter["properties"]["all"]["items"]["$ref"],
            "#/components/schemas/Filter"
        );
        assert_eq!(
            filter["properties"]["not"]["$ref"],
            "#/components/schemas/Filter"
        );
    }

    #[test]
    fn every_reference_in_the_document_points_at_something() {
        // A dangling `$ref` is a document a validator rejects and a generator
        // crashes on, and nothing in a Rust type system was ever going to catch
        // one — the first draft of this file shipped two.
        fn refs(node: &Value, found: &mut Vec<String>) {
            match node {
                Value::Object(map) => {
                    for (key, value) in map {
                        if key == "$ref" {
                            if let Some(r) = value.as_str() {
                                found.push(r.to_string());
                            }
                        }
                        refs(value, found);
                    }
                }
                Value::Array(items) => items.iter().for_each(|i| refs(i, found)),
                _ => {}
            }
        }

        let doc = document(&names(&["a.b"]), None);
        let mut found = Vec::new();
        refs(&doc, &mut found);
        assert!(
            !found.is_empty(),
            "no references at all — the walk is wrong"
        );

        for reference in found {
            let mut at = &doc;
            for step in reference.trim_start_matches("#/").split('/') {
                at = &at[step];
            }
            assert!(!at.is_null(), "`{reference}` points at nothing");
        }
    }

    #[test]
    fn the_server_is_said_only_when_it_is_known() {
        // A guessed hostname in a document somebody pastes into a client is
        // worse than no hostname at all.
        assert_eq!(document(&[], None)["servers"][0]["url"], "/");
        assert_eq!(
            document(&[], Some("https://flint.internal"))["servers"][0]["url"],
            "https://flint.internal"
        );
    }
}
