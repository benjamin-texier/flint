//! An endpoint, as a tool an agent can be handed.
//!
//! The same facts as the OpenAPI document, in the shape a model-calling
//! framework wants: a name, a sentence, and one JSON Schema for the arguments.
//! Flint runs no MCP server and this is not one — it is a *definition*, which
//! is the part somebody has to write by hand today and the part that goes stale
//! the moment the endpoint changes. Generated, it cannot.
//!
//! The interesting thing is that a contract makes this document far better than
//! a hand-written one, and for a reason specific to agents. A person handed a
//! parameter called `region` will ask what the regions are. A model will guess,
//! call, get a 400, and guess again — burning a round trip per attempt and
//! sometimes settling on a plausible wrong answer instead. Every constraint the
//! contract holds is therefore pushed into the schema, where the framework
//! enforces it before a call is made: an `enum` for a fixed set, a `minimum`
//! for a numeric floor, and a sentence for the two things JSON Schema cannot
//! express — a date floor, and a window measured across a pair of parameters.
//!
//! What is deliberately *not* here: the statement. A tool definition is handed
//! to whoever is calling, and the SQL behind an endpoint is not part of the
//! bargain — the same rule `describe_endpoint` follows.

use serde_json::{json, Value};

use crate::clickhouse::ColumnMeta;
use crate::published::contract::Contract;
use crate::published::shape;

/// Everything the definition is built from. Borrowed, like `openapi::Endpoint`,
/// because every field of it is already owned by the handler.
pub struct Tool<'a> {
    pub slug: &'a str,
    pub name: &'a str,
    /// The publisher's own sentence. Empty is common and is handled: the tool
    /// still describes itself, in Flint's words, and says less.
    pub description: &'a str,
    pub revision: u32,
    /// The statement's placeholders, with the type each was declared with.
    pub parameters: &'a [(String, String)],
    pub defaults: &'a [(String, String)],
    /// What the statement returns, where Flint could describe it.
    pub columns: Option<&'a [ColumnMeta]>,
    pub contract: &'a Contract,
    /// The largest page the endpoint will serve.
    pub max_rows: u64,
    pub public: bool,
}

/// A tool name a framework will accept.
///
/// Lower-case, underscores, no leading digit — the intersection of what the
/// common frameworks allow. Derived from the address rather than the display
/// name, because the address is already constrained to nearly this alphabet and
/// a display name is free text somebody wrote for a person.
pub fn tool_name(slug: &str) -> String {
    let cleaned: String = slug
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim_matches('_');
    let head = if trimmed.is_empty() {
        "endpoint".to_string()
    } else {
        trimmed.to_lowercase()
    };
    if head.starts_with(|c: char| c.is_ascii_digit()) {
        format!("q_{head}")
    } else {
        head
    }
}

/// The definition.
pub fn definition(tool: &Tool) -> Value {
    let mut properties = serde_json::Map::new();
    let mut required: Vec<String> = Vec::new();

    for (name, ty) in tool.parameters {
        let default = tool
            .defaults
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v);
        let mut schema = argument_schema(ty);
        let mut said: Vec<String> = Vec::new();

        if let Some(rule) = tool.contract.rule(name) {
            // An enum is the single highest-value line in this whole file. A
            // model handed a free string called `region` guesses; handed four
            // values it cannot.
            if !rule.one_of.is_empty() {
                schema["enum"] = json!(rule.one_of);
            }
            match rule.min.parse::<f64>() {
                Ok(n) if !rule.min.is_empty() => {
                    schema["minimum"] = json!(n);
                }
                // A date floor has no `minimum` a validator would apply to a
                // string, so it is said instead of encoded — encoded wrongly it
                // would be enforced wrongly.
                _ if !rule.min.is_empty() => said.push(format!("No earlier than {}.", rule.min)),
                _ => {}
            }
            match rule.max.parse::<f64>() {
                Ok(n) if !rule.max.is_empty() => {
                    schema["maximum"] = json!(n);
                }
                _ if !rule.max.is_empty() => said.push(format!("No later than {}.", rule.max)),
                _ => {}
            }
            if let (Some(days), false) = (rule.window_days, rule.window_to.is_empty()) {
                said.push(format!(
                    "Together with `{}` this may span at most {days} days; a wider window is \
                     refused rather than narrowed.",
                    rule.window_to
                ));
            }
            if !rule.note.is_empty() {
                said.push(rule.note.clone());
            }
        }

        if let Some(value) = default {
            // Typed to match the schema beside it. A default stored as text —
            // which every default is, because it came off a form — set against
            // `"type": "number"` is a schema that fails its own validator, and
            // a framework that checks defaults refuses the tool outright.
            schema["default"] = match schema.get("type").and_then(Value::as_str) {
                Some("number" | "integer") => value
                    .parse::<f64>()
                    .map(|n| json!(n))
                    .unwrap_or_else(|_| json!(value)),
                Some("boolean") => match value.as_str() {
                    "true" | "1" => json!(true),
                    "false" | "0" => json!(false),
                    _ => json!(value),
                },
                _ => json!(value),
            };
            said.push(format!("Defaults to {value}."));
        } else {
            required.push(name.clone());
        }

        if !said.is_empty() {
            let head = schema
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let joined = said.join(" ");
            schema["description"] = json!(if head.is_empty() {
                joined
            } else {
                format!("{head} {joined}")
            });
        }
        properties.insert(name.clone(), schema);
    }

    // The page, offered only where the statement has not taken the name for
    // itself. Documenting an argument the endpoint would read as its own
    // parameter is worse than leaving it out.
    let free = |name: &str| !tool.parameters.iter().any(|(n, _)| n == name);
    let ceiling = tool.contract.ceiling(tool.max_rows);
    if free("limit") {
        properties.insert(
            "limit".into(),
            json!({
                "type": "integer",
                "minimum": 1,
                "maximum": ceiling,
                "description": format!(
                    "Rows in this answer, at most {ceiling}. The answer says whether more \
                     are behind it and carries a link to the next page."
                ),
            }),
        );
    }
    if free("offset") {
        properties.insert(
            "offset".into(),
            json!({
                "type": "integer",
                "minimum": 0,
                "description": "Rows to skip. Prefer following the answer's own next link, \
                                which carries a cursor and so cannot skip or repeat a row.",
            }),
        );
    }
    if free("select") && !tool.contract.columns.only.is_empty() {
        // Only where the contract names an allow-list: otherwise this would be
        // a free-text column name, which is a thing to guess at.
        //
        // And intersected with what the statement actually returns, for the
        // reason `Contract::exposed` gives: an allow-list can name a column the
        // statement stopped selecting three revisions ago, and offering it here
        // is worse than a plain string — a model would ask for it by name and
        // get a ClickHouse error about an unknown identifier.
        properties.insert(
            "select".into(),
            json!({
                "type": "array",
                "items": { "type": "string", "enum": offerable(tool, &tool.contract.columns.only) },
                "description": "Which columns to return. Omit for all of the exposed ones. \
                                Asking for a column this endpoint does not expose is refused \
                                by name.",
            }),
        );
    }
    if free("order") && !tool.contract.order_by.is_empty() {
        properties.insert(
            "order".into(),
            json!({
                "type": "string",
                "enum": offerable(tool, &tool.contract.order_by)
                    .iter()
                    .flat_map(|c| [c.clone(), format!("{c}.desc")])
                    .collect::<Vec<_>>(),
                "description": "How to sort. Append `.desc` to reverse.",
            }),
        );
    }

    json!({
        "name": tool_name(tool.slug),
        "description": describe(tool),
        "input_schema": {
            "type": "object",
            "properties": Value::Object(properties),
            "required": required,
            // A model that invents an argument gets a refusal from the
            // framework rather than a 400 from Flint, which is one round trip
            // instead of two and a much clearer message.
            "additionalProperties": false,
        },
        // Not part of any framework's schema, and deliberately alongside rather
        // than inside it: whoever wires this up needs to know where to send the
        // call and whether it carries a credential.
        "x-flint": {
            "method": "GET",
            "path": format!("/api/data/{}", tool.slug),
            "revision": tool.revision,
            // Pinned in the document, because a tool definition is written into
            // a codebase once and read by a model for a year. An unpinned tool
            // silently starts describing a different answer the day somebody
            // publishes a new revision.
            "pin": format!("v={}", tool.revision),
            "authentication": if tool.public {
                json!(null)
            } else {
                json!("an X-Flint-Key header, or a Bearer authorization")
            },
            "returns": returns(tool),
        },
    })
}

/// The sentence the model reads before deciding whether to call this.
fn describe(tool: &Tool) -> String {
    let mut said = String::new();
    if !tool.description.trim().is_empty() {
        said.push_str(tool.description.trim());
        if !said.ends_with('.') {
            said.push('.');
        }
    } else {
        // Flint's own words, and they say less on purpose. A generated
        // sentence that sounded confident about what an endpoint is *for*
        // would be a guess a model then acts on.
        said.push_str(&format!(
            "`{}`, a published ClickHouse query. Nobody has written down what it is for.",
            tool.name
        ));
    }
    match tool.columns {
        Some(columns) => {
            let exposed: Vec<&str> = columns
                .iter()
                .filter(|c| tool.contract.exposes(&c.name))
                .map(|c| c.name.as_str())
                .collect();
            if !exposed.is_empty() {
                said.push_str(&format!(" Returns {}.", exposed.join(", ")));
            }
            // Said, because a model asking for a hidden column and being
            // refused would otherwise retry — and because a person reading the
            // definition should know the endpoint is narrower than its query.
            let hidden = columns.len() - exposed.len();
            if hidden > 0 {
                said.push_str(&format!(
                    " {hidden} further column{} the statement selects {} not exposed and cannot \
                     be requested.",
                    if hidden == 1 { "" } else { "s" },
                    if hidden == 1 { "is" } else { "are" }
                ));
            }
        }
        None => said
            .push_str(" Flint could not describe this statement without running it, so the columns it returns are not listed here."),
    }
    said
}

/// The subset of a promised column list that the statement can actually
/// produce.
///
/// Where Flint could not describe the statement there is nothing to intersect
/// against, and the promise is offered as written — which is the same choice
/// the rest of the document makes when the columns are unknown: say what was
/// declared, and say separately that the columns could not be read.
fn offerable(tool: &Tool, promised: &[String]) -> Vec<String> {
    match tool.columns {
        None => promised.to_vec(),
        Some(columns) => promised
            .iter()
            .filter(|name| columns.iter().any(|c| c.name == **name))
            .cloned()
            .collect(),
    }
}

/// The columns of an answer, for the half of the definition a framework does
/// not read but a person wiring it up does.
fn returns(tool: &Tool) -> Value {
    match tool.columns {
        None => Value::Null,
        Some(columns) => Value::Array(
            columns
                .iter()
                .filter(|c| tool.contract.exposes(&c.name))
                .map(|c| json!({ "name": c.name, "type": c.r#type }))
                .collect(),
        ),
    }
}

/// A declared ClickHouse type, as an argument a model can fill in.
///
/// Narrower than the OpenAPI version in one place that matters: a temporal
/// parameter says what format it wants in words, because a model given only
/// `"type": "string"` will send `"last Tuesday"`.
fn argument_schema(declared: &str) -> Value {
    match shape::family(declared) {
        shape::Family::Number => json!({ "type": "number", "x-clickhouse-type": declared }),
        shape::Family::Temporal => json!({
            "type": "string",
            "description": "A date as `YYYY-MM-DD`, or a timestamp as `YYYY-MM-DD HH:MM:SS`.",
            "x-clickhouse-type": declared,
        }),
        // `Native` is Bool together with UUID, IPv4 and IPv6, so the one that
        // is genuinely a boolean has to be picked out by name. Worth doing:
        // a model told `"type": "string"` for a flag sends `"yes"`.
        shape::Family::Native
            if matches!(
                shape::base_type(declared)
                    .split('(')
                    .next()
                    .unwrap_or_default()
                    .trim(),
                "Bool" | "Boolean"
            ) =>
        {
            json!({ "type": "boolean", "x-clickhouse-type": declared })
        }
        _ => json!({ "type": "string", "x-clickhouse-type": declared }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::published::contract::{Exposure, ParamRule};

    fn col(name: &str, ty: &str) -> ColumnMeta {
        ColumnMeta {
            name: name.into(),
            r#type: ty.into(),
        }
    }

    fn params(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    fn tool<'a>(
        parameters: &'a [(String, String)],
        defaults: &'a [(String, String)],
        columns: Option<&'a [ColumnMeta]>,
        contract: &'a Contract,
    ) -> Tool<'a> {
        Tool {
            slug: "device_daily",
            name: "Device daily",
            description: "Daily event count per fleet",
            revision: 4,
            parameters,
            defaults,
            columns,
            contract,
            max_rows: 1000,
            public: false,
        }
    }

    #[test]
    fn a_slug_becomes_a_name_every_framework_accepts() {
        assert_eq!(tool_name("device_daily"), "device_daily");
        assert_eq!(tool_name("errors-by-city"), "errors_by_city");
        // A leading digit is not a valid identifier anywhere this lands.
        assert_eq!(tool_name("7day_rollup"), "q_7day_rollup");
        assert_eq!(tool_name("-odd-"), "odd");
    }

    #[test]
    fn a_parameter_with_no_default_is_required_and_one_with_a_default_is_not() {
        let contract = Contract::default();
        let declared = params(&[("from", "Date"), ("region", "String")]);
        let defaults = params(&[("region", "eu-west")]);
        let doc = definition(&tool(&declared, &defaults, None, &contract));
        assert_eq!(doc["input_schema"]["required"], json!(["from"]));
        assert_eq!(
            doc["input_schema"]["properties"]["region"]["default"],
            json!("eu-west")
        );
    }

    #[test]
    fn an_enum_reaches_the_schema_rather_than_only_the_prose() {
        // The single highest-value line here: a model handed a free string
        // called `region` guesses, calls, gets a 400, and guesses again.
        let contract = Contract {
            params: vec![ParamRule {
                name: "region".into(),
                one_of: vec!["eu-west".into(), "us-east".into()],
                ..Default::default()
            }],
            ..Default::default()
        };
        let declared = params(&[("region", "String")]);
        let doc = definition(&tool(&declared, &[], None, &contract));
        assert_eq!(
            doc["input_schema"]["properties"]["region"]["enum"],
            json!(["eu-west", "us-east"])
        );
    }

    #[test]
    fn a_numeric_floor_is_encoded_and_a_date_floor_is_said() {
        // JSON Schema has no `minimum` a validator would apply to a date
        // string, and encoding one would be enforced wrongly.
        let contract = Contract {
            params: vec![
                ParamRule {
                    name: "from".into(),
                    min: "2024-01-01".into(),
                    ..Default::default()
                },
                ParamRule {
                    name: "top".into(),
                    min: "1".into(),
                    max: "50".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let declared = params(&[("from", "Date"), ("top", "UInt32")]);
        let doc = definition(&tool(&declared, &[], None, &contract));
        let from = &doc["input_schema"]["properties"]["from"];
        assert!(from.get("minimum").is_none(), "{from}");
        assert!(
            from["description"].as_str().unwrap().contains("2024-01-01"),
            "{from}"
        );
        assert_eq!(
            doc["input_schema"]["properties"]["top"]["minimum"],
            json!(1.0)
        );
        assert_eq!(
            doc["input_schema"]["properties"]["top"]["maximum"],
            json!(50.0)
        );
    }

    #[test]
    fn a_window_cap_is_stated_because_no_schema_can_hold_it() {
        let contract = Contract {
            params: vec![ParamRule {
                name: "from".into(),
                window_to: "to".into(),
                window_days: Some(90),
                ..Default::default()
            }],
            ..Default::default()
        };
        let declared = params(&[("from", "Date"), ("to", "Date")]);
        let doc = definition(&tool(&declared, &[], None, &contract));
        let said = doc["input_schema"]["properties"]["from"]["description"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(said.contains("90 days"), "{said}");
        assert!(said.contains("refused rather than narrowed"), "{said}");
    }

    #[test]
    fn an_unexposed_column_is_neither_returned_nor_offered() {
        let contract = Contract {
            columns: Exposure {
                only: vec!["day".into(), "events".into()],
                never: vec!["device_id".into()],
            },
            ..Default::default()
        };
        let columns = [
            col("day", "Date"),
            col("events", "UInt64"),
            col("device_id", "String"),
        ];
        let doc = definition(&tool(&[], &[], Some(&columns), &contract));
        let said = doc["description"].as_str().unwrap();
        assert!(said.contains("day, events"), "{said}");
        assert!(!said.contains("device_id"), "{said}");
        // …and it is counted rather than silently dropped.
        assert!(said.contains("1 further column"), "{said}");
        let select = &doc["input_schema"]["properties"]["select"]["items"]["enum"];
        assert_eq!(select, &json!(["day", "events"]));
        assert_eq!(
            doc["x-flint"]["returns"],
            json!([
                { "name": "day", "type": "Date" },
                { "name": "events", "type": "UInt64" },
            ])
        );
    }

    #[test]
    fn a_promise_the_statement_can_no_longer_keep_is_not_offered() {
        // An allow-list can name a column the statement stopped selecting
        // three revisions ago. Offering it is worse than offering a plain
        // string: a model asks for it by name and gets a ClickHouse error
        // about an unknown identifier, which tells it nothing it can act on.
        let contract = Contract {
            columns: Exposure {
                only: vec!["day".into(), "p95".into()],
                ..Default::default()
            },
            order_by: vec!["day".into(), "p95".into()],
            ..Default::default()
        };
        let columns = [col("day", "Date")];
        let doc = definition(&tool(&[], &[], Some(&columns), &contract));
        assert_eq!(
            doc["input_schema"]["properties"]["select"]["items"]["enum"],
            json!(["day"])
        );
        assert_eq!(
            doc["input_schema"]["properties"]["order"]["enum"],
            json!(["day", "day.desc"])
        );
    }

    #[test]
    fn a_promise_is_offered_as_written_where_the_columns_could_not_be_read() {
        // Nothing to intersect against. Saying less than the contract promises
        // would be inventing a narrowing nobody decided.
        let contract = Contract {
            columns: Exposure {
                only: vec!["day".into(), "p95".into()],
                ..Default::default()
            },
            ..Default::default()
        };
        let doc = definition(&tool(&[], &[], None, &contract));
        assert_eq!(
            doc["input_schema"]["properties"]["select"]["items"]["enum"],
            json!(["day", "p95"])
        );
    }

    #[test]
    fn a_default_is_typed_to_match_the_schema_beside_it() {
        // Every default is stored as text, because it came off a form. Set
        // against `"type": "number"` that is a schema which fails its own
        // validator, and a framework that checks defaults refuses the tool.
        let declared = params(&[("days", "UInt32"), ("since", "Date"), ("live", "Bool")]);
        let defaults = params(&[("days", "7"), ("since", "2024-01-01"), ("live", "true")]);
        let doc = definition(&tool(&declared, &defaults, None, &Contract::default()));
        let props = &doc["input_schema"]["properties"];
        assert_eq!(props["days"]["default"], json!(7.0));
        assert_eq!(props["since"]["default"], json!("2024-01-01"));
        assert_eq!(props["live"]["default"], json!(true));
    }

    #[test]
    fn a_default_that_is_not_the_type_it_claims_is_left_as_text() {
        // A number field with `today()` in it is somebody's mistake, and the
        // honest thing is to hand it over unchanged rather than turn it into a
        // zero the endpoint would then be documented as defaulting to.
        let declared = params(&[("days", "UInt32")]);
        let defaults = params(&[("days", "a week")]);
        let doc = definition(&tool(&declared, &defaults, None, &Contract::default()));
        assert_eq!(
            doc["input_schema"]["properties"]["days"]["default"],
            json!("a week")
        );
    }

    #[test]
    fn sorting_is_offered_only_where_the_contract_says_what_is_sortable() {
        let open = Contract::default();
        let doc = definition(&tool(&[], &[], None, &open));
        assert!(doc["input_schema"]["properties"].get("order").is_none());

        let closed = Contract {
            order_by: vec!["day".into()],
            ..Default::default()
        };
        let doc = definition(&tool(&[], &[], None, &closed));
        assert_eq!(
            doc["input_schema"]["properties"]["order"]["enum"],
            json!(["day", "day.desc"])
        );
    }

    #[test]
    fn a_page_is_capped_by_the_lower_of_the_two_ceilings() {
        let contract = Contract {
            max_limit: Some(100),
            ..Default::default()
        };
        let doc = definition(&tool(&[], &[], None, &contract));
        assert_eq!(
            doc["input_schema"]["properties"]["limit"]["maximum"],
            json!(100)
        );
    }

    #[test]
    fn a_name_the_statement_took_for_itself_is_not_offered_twice() {
        // A statement that declares `limit` means its own thing by it, and a
        // tool that offered both would have a model setting one and reading
        // the other.
        let declared = params(&[("limit", "UInt32")]);
        let doc = definition(&tool(&declared, &[], None, &Contract::default()));
        assert_eq!(
            doc["input_schema"]["properties"]["limit"]["x-clickhouse-type"],
            json!("UInt32")
        );
        assert!(doc["input_schema"]["properties"]["limit"]
            .get("maximum")
            .is_none());
    }

    #[test]
    fn the_definition_is_pinned_and_never_carries_the_statement() {
        let doc = definition(&tool(&[], &[], None, &Contract::default()));
        assert_eq!(doc["x-flint"]["pin"], json!("v=4"));
        assert_eq!(doc["x-flint"]["path"], json!("/api/data/device_daily"));
        // A tool definition is handed to whoever is calling, and the SQL behind
        // an endpoint is not part of the bargain.
        assert!(!doc.to_string().to_lowercase().contains("select "));
    }

    #[test]
    fn a_public_endpoint_says_it_needs_nothing_rather_than_leaving_it_out() {
        let contract = Contract::default();
        let mut t = tool(&[], &[], None, &contract);
        t.public = true;
        assert_eq!(definition(&t)["x-flint"]["authentication"], Value::Null);
    }

    #[test]
    fn an_endpoint_nobody_described_still_describes_itself_and_says_less() {
        let contract = Contract::default();
        let mut t = tool(&[], &[], None, &contract);
        t.description = "   ";
        let said = definition(&t)["description"].as_str().unwrap().to_string();
        assert!(
            said.contains("Nobody has written down what it is for"),
            "{said}"
        );
    }

    #[test]
    fn an_invented_argument_is_refused_by_the_framework_rather_than_by_flint() {
        let doc = definition(&tool(&[], &[], None, &Contract::default()));
        assert_eq!(doc["input_schema"]["additionalProperties"], json!(false));
    }
}
