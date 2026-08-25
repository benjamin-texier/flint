//! No-code APIs: a statement, published as an endpoint.
//!
//! Write the SQL once, with ClickHouse's own parameter placeholders in it, and
//! Flint serves it at a stable URL that a spreadsheet, a dashboard elsewhere or
//! a five-line script can fetch. No code, and no string interpolation: the
//! placeholders are bound parameters, so a caller supplies *values* and can
//! never supply SQL.
//!
//! Three rules, for the same reasons the alerts have theirs. Published
//! statements always run read-only. Only parameters the statement actually
//! declares are ever forwarded, so a caller cannot smuggle a ClickHouse setting
//! in through the query string. And every endpoint carries a token unless
//! someone deliberately made it public — a URL that ends up pasted into a
//! spreadsheet has a much longer life than a session.

pub mod cursor;
pub mod openapi;
pub mod shape;

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// A published endpoint's address. Deliberately narrow: it lands in URLs, in
/// people's scripts, and in a path Flint routes on.
pub fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 64
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
}

/// The parameters a statement declares, in the order ClickHouse would see them.
///
/// Discovered from the SQL rather than configured beside it: the statement is
/// the only place that can be right about what it needs, and a list that drifts
/// out of step with it is a list that lies. `{name:Type}` is ClickHouse's own
/// syntax, so nothing new has to be learned to publish a parameterised query.
pub fn declared_params(sql: &str) -> Vec<String> {
    declared_params_typed(sql)
        .into_iter()
        .map(|(name, _)| name)
        .collect()
}

/// The same list, with each parameter's declared ClickHouse type.
///
/// The type is documentation rather than validation — ClickHouse is the one
/// that parses the value and the one that will refuse it — but a caller reading
/// an endpoint's schema needs to know whether `since` wants `2024-01-01` or an
/// epoch, and the statement is the only place that knows.
pub fn declared_params_typed(sql: &str) -> Vec<(String, String)> {
    let mut found: BTreeSet<(String, String)> = BTreeSet::new();
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'{' {
            i += 1;
            continue;
        }
        // `{name:Type}` — a name, a colon, a type, and no nesting.
        let Some(end) = sql[i + 1..].find('}').map(|e| i + 1 + e) else {
            break;
        };
        let inner = &sql[i + 1..end];
        if let Some((name, ty)) = inner.split_once(':') {
            let name = name.trim();
            if !name.is_empty()
                && !ty.trim().is_empty()
                && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                found.insert((name.to_string(), ty.trim().to_string()));
            }
        }
        i = end + 1;
    }
    // One name, one type: a statement that declares the same parameter twice
    // with two types is already broken, and the first reading is as good a
    // guess as any about which one it meant.
    let mut out: Vec<(String, String)> = Vec::new();
    for (name, ty) in found {
        if !out.iter().any(|(n, _)| *n == name) {
            out.push((name, ty));
        }
    }
    out
}

/// A value of the right shape for a declared type, used only to ask ClickHouse
/// what a statement *returns* without running it.
///
/// `DESCRIBE (SELECT ... WHERE city = {city:String})` needs every placeholder
/// filled before it will answer, and an endpoint whose parameters have no
/// defaults would otherwise have no describable schema at all. The probe never
/// reaches a result set — `DESCRIBE` reads no data — and it is never shown as
/// an answer, so it is a stand-in for a shape rather than an invented figure.
pub fn probe_value(ty: &str) -> String {
    let head = ty.trim();
    let head = head
        .strip_prefix("Nullable(")
        .and_then(|r| r.strip_suffix(')'))
        .unwrap_or(head)
        .trim();
    let name = head.split('(').next().unwrap_or(head).trim();
    match name {
        "Date" | "Date32" => "2000-01-01".into(),
        "DateTime" | "DateTime64" => "2000-01-01 00:00:00".into(),
        "UUID" => "00000000-0000-0000-0000-000000000000".into(),
        "Bool" | "Boolean" => "false".into(),
        "IPv4" => "0.0.0.0".into(),
        "IPv6" => "::".into(),
        "Array" => "[]".into(),
        "Map" => "{}".into(),
        "Tuple" => "()".into(),
        n if n.starts_with("Int")
            || n.starts_with("UInt")
            || n.starts_with("Float")
            || n.starts_with("Decimal") =>
        {
            "0".into()
        }
        _ => String::new(),
    }
}

/// What the caller asked for, in a shape a spreadsheet or a script can read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    /// One JSON object per row, keyed by column name. What a script wants.
    Json,
    /// A header row and comma-separated values. What a spreadsheet wants.
    Csv,
    /// One JSON object per line, no envelope. What a stream wants — `jq`, a
    /// loader that reads line by line, anything that would rather not hold the
    /// whole page in memory to find the first row.
    Ndjson,
}

impl Format {
    pub fn parse(raw: Option<&str>) -> std::result::Result<Self, String> {
        match raw.unwrap_or("json") {
            "json" => Ok(Format::Json),
            "csv" => Ok(Format::Csv),
            // `jsonl` is the same file under the other common name.
            "ndjson" | "jsonl" => Ok(Format::Ndjson),
            other => Err(format!(
                "`{other}` is not a format this endpoint serves; use json, csv or ndjson"
            )),
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Format::Json => "application/json; charset=utf-8",
            Format::Csv => "text/csv; charset=utf-8",
            Format::Ndjson => "application/x-ndjson; charset=utf-8",
        }
    }
}

/// A missing parameter, named. The caller gets to know which one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Missing(pub Vec<String>);

/// Match what the caller supplied against what the statement declares.
///
/// Returns the parameters to forward, which is only ever a subset of what the
/// statement itself asked for. Anything else in the query string is ignored
/// rather than passed on: ClickHouse's HTTP interface takes settings as query
/// parameters too, and forwarding an unknown one would let a caller change how
/// their query runs.
pub fn bind(
    sql: &str,
    supplied: &[(String, String)],
    defaults: &[(String, String)],
) -> std::result::Result<Vec<(String, String)>, Missing> {
    let declared = declared_params(sql);
    let mut out = Vec::with_capacity(declared.len());
    let mut missing = Vec::new();

    for name in declared {
        let given = supplied
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.clone())
            .or_else(|| {
                defaults
                    .iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| v.clone())
            });
        match given {
            // Bare names: the client adds ClickHouse's `param_` prefix, and
            // adding it here too produced `param_param_city`.
            Some(value) => out.push((name, value)),
            None => missing.push(name),
        }
    }

    if missing.is_empty() {
        Ok(out)
    } else {
        Err(Missing(missing))
    }
}

/// RFC 4180: quote when the value contains a comma, a quote or a newline, and
/// double an embedded quote. A spreadsheet that mis-parses one row mis-parses
/// the file.
pub fn csv_cell(value: &serde_json::Value) -> String {
    let raw = match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if raw.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", raw.replace('"', "\"\""))
    } else {
        raw
    }
}

pub fn to_csv(columns: &[String], rows: &[Vec<serde_json::Value>]) -> String {
    let mut out = String::new();
    out.push_str(
        &columns
            .iter()
            .map(|c| csv_cell(&serde_json::Value::String(c.clone())))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push('\n');
    for row in rows {
        out.push_str(&row.iter().map(csv_cell).collect::<Vec<_>>().join(","));
        out.push('\n');
    }
    out
}

/// Rows as objects, which is what anything consuming JSON actually wants — a
/// positional array makes every caller re-derive the column order.
pub fn to_json_rows(
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
) -> Vec<serde_json::Map<String, serde_json::Value>> {
    rows.iter()
        .map(|row| {
            columns
                .iter()
                .enumerate()
                .map(|(i, name)| {
                    (
                        name.clone(),
                        row.get(i).cloned().unwrap_or(serde_json::Value::Null),
                    )
                })
                .collect()
        })
        .collect()
}

/// The same objects, one per line, with no array and no envelope. A consumer
/// can act on the first row before the last one has arrived.
pub fn to_ndjson(columns: &[String], rows: &[Vec<serde_json::Value>]) -> String {
    let mut out = String::new();
    for row in to_json_rows(columns, rows) {
        out.push_str(&serde_json::to_string(&row).unwrap_or_else(|_| "{}".into()));
        out.push('\n');
    }
    out
}

/// Everything a published answer says outside its body.
///
/// One list, used twice: the handler writes these, and the CORS layer names
/// them as readable. A browser calling from another origin can only see the
/// headers a server explicitly exposes, and for CSV and NDJSON these *are* the
/// paging — there is no envelope to fall back on, so an unexposed `Link` is a
/// caller that cannot find page two.
pub const TOLD_HEADERS: [&str; 8] = [
    "x-flint-limit",
    "x-flint-offset",
    "x-flint-returned",
    "x-flint-has-more",
    "x-flint-total",
    "x-flint-cursor",
    "x-flint-truncated",
    "link",
];

/// The prefix every published call is tagged with in `system.query_log`.
pub const CALL_TAG_PREFIX: &str = "flint:api:";

pub fn call_tag(slug: &str) -> String {
    format!("{CALL_TAG_PREFIX}{slug}")
}

/// The slug back out of a tag, for reading usage. `None` for anything that is
/// not one of ours — the log holds other people's comments too.
pub fn slug_of_tag(tag: &str) -> Option<&str> {
    tag.strip_prefix(CALL_TAG_PREFIX).filter(|s| valid_slug(s))
}

/// A token that is long enough to be a secret and short enough to paste.
pub fn mint_token() -> String {
    // Two UUIDs' worth of entropy, hex, no separators: 256 bits.
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Constant-time-ish comparison. Not a defence against a determined attacker on
/// a shared host, but it costs nothing and removes the easy timing signal.
pub fn token_matches(expected: &str, given: &str) -> bool {
    if expected.len() != given.len() {
        return false;
    }
    expected
        .bytes()
        .zip(given.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_slug_is_narrow_because_it_lands_in_a_url() {
        for good in ["events", "daily-totals", "v2_by_city", "a"] {
            assert!(valid_slug(good), "{good}");
        }
        for bad in [
            "",
            "Events",
            "with space",
            "trailing-",
            "-leading",
            "slash/es",
            "dots.and.things",
            "unicode-é",
        ] {
            assert!(!valid_slug(bad), "{bad}");
        }
        assert!(!valid_slug(&"x".repeat(65)));
    }

    #[test]
    fn parameters_come_from_the_statement() {
        assert_eq!(
            declared_params("SELECT * FROM t WHERE city = {city:String} AND n > {n:UInt32}"),
            vec!["city".to_string(), "n".to_string()]
        );
        // Sorted and de-duplicated: a parameter used twice is still one.
        assert_eq!(
            declared_params("SELECT {a:UInt8} + {a:UInt8} AS x"),
            vec!["a".to_string()]
        );
        assert!(declared_params("SELECT 1").is_empty());
    }

    #[test]
    fn a_brace_that_is_not_a_parameter_is_not_one() {
        // ClickHouse SQL has braces that are not placeholders, and a false
        // positive would demand a parameter nobody can supply.
        assert!(declared_params("SELECT map('a', 1)['a']").is_empty());
        assert!(declared_params("SELECT {no_type}").is_empty());
        assert!(declared_params("SELECT {:String}").is_empty());
        assert!(declared_params("SELECT {not a name:String}").is_empty());
        assert!(declared_params("SELECT '{unclosed:String'").is_empty());
    }

    #[test]
    fn only_declared_parameters_are_forwarded() {
        // The one that matters: ClickHouse takes settings as query parameters,
        // so forwarding an undeclared one would let a caller change how their
        // query runs — or how long it may run for.
        let sql = "SELECT * FROM t WHERE city = {city:String}";
        let supplied = vec![
            ("city".to_string(), "Oslo".to_string()),
            ("max_execution_time".to_string(), "9999".to_string()),
            ("readonly".to_string(), "0".to_string()),
        ];
        let bound = bind(sql, &supplied, &[]).expect("city was supplied");
        // Bare names: the client adds the `param_` prefix.
        assert_eq!(bound, vec![("city".to_string(), "Oslo".to_string())]);
    }

    #[test]
    fn a_missing_parameter_is_named() {
        let sql = "SELECT {a:UInt8}, {b:UInt8}";
        match bind(sql, &[("a".into(), "1".into())], &[]) {
            Err(Missing(names)) => assert_eq!(names, vec!["b".to_string()]),
            Ok(_) => panic!("b was not supplied"),
        }
    }

    #[test]
    fn a_default_stands_in_for_what_the_caller_omitted() {
        let sql = "SELECT {days:UInt8}";
        let bound = bind(sql, &[], &[("days".into(), "7".into())]).expect("default applies");
        assert_eq!(bound, vec![("days".to_string(), "7".to_string())]);
        // And the caller still wins.
        let bound = bind(
            sql,
            &[("days".into(), "1".into())],
            &[("days".into(), "7".into())],
        )
        .expect("supplied wins");
        assert_eq!(bound, vec![("days".to_string(), "1".to_string())]);
    }

    #[test]
    fn csv_quotes_what_would_otherwise_break_a_row() {
        assert_eq!(csv_cell(&json!("plain")), "plain");
        assert_eq!(csv_cell(&json!("with,comma")), "\"with,comma\"");
        assert_eq!(csv_cell(&json!("with\"quote")), "\"with\"\"quote\"");
        assert_eq!(csv_cell(&json!("two\nlines")), "\"two\nlines\"");
        assert_eq!(csv_cell(&serde_json::Value::Null), "");
        assert_eq!(csv_cell(&json!(42)), "42");
    }

    #[test]
    fn a_csv_has_a_header_and_a_row_per_row() {
        let csv = to_csv(
            &["city".into(), "n".into()],
            &[
                vec![json!("Oslo"), json!(3)],
                vec![json!("Lyon, FR"), json!(1)],
            ],
        );
        assert_eq!(csv, "city,n\nOslo,3\n\"Lyon, FR\",1\n");
    }

    #[test]
    fn json_rows_are_objects_so_no_caller_has_to_count_columns() {
        let rows = to_json_rows(
            &["city".into(), "n".into()],
            &[vec![json!("Oslo"), json!(3)]],
        );
        assert_eq!(rows[0]["city"], json!("Oslo"));
        assert_eq!(rows[0]["n"], json!(3));
    }

    #[test]
    fn a_short_row_is_padded_rather_than_dropped() {
        let rows = to_json_rows(&["a".into(), "b".into()], &[vec![json!(1)]]);
        assert_eq!(rows[0]["b"], serde_json::Value::Null);
    }

    #[test]
    fn a_format_the_endpoint_does_not_serve_is_refused_by_name() {
        assert_eq!(Format::parse(None).unwrap(), Format::Json);
        assert_eq!(Format::parse(Some("csv")).unwrap(), Format::Csv);
        assert!(Format::parse(Some("xlsx")).unwrap_err().contains("xlsx"));
    }

    #[test]
    fn a_call_tag_round_trips_and_ignores_other_peoples_comments() {
        assert_eq!(call_tag("by-city"), "flint:api:by-city");
        assert_eq!(slug_of_tag("flint:api:by-city"), Some("by-city"));
        assert_eq!(slug_of_tag(""), None);
        assert_eq!(slug_of_tag("something else"), None);
        assert_eq!(slug_of_tag("flint:introspection"), None);
        // A tag that claims a slug the rules forbid is not one of ours.
        assert_eq!(slug_of_tag("flint:api:Not A Slug"), None);
    }

    #[test]
    fn a_token_is_long_and_compares_without_shortcuts() {
        let token = mint_token();
        assert_eq!(token.len(), 64);
        assert!(token_matches(&token, &token.clone()));
        assert!(!token_matches(&token, "short"));
        let mut wrong = token.clone();
        wrong.pop();
        wrong.push(if token.ends_with('a') { 'b' } else { 'a' });
        assert!(!token_matches(&token, &wrong));
    }
}
