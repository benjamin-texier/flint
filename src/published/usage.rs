//! What the endpoints page knows about traffic.
//!
//! Every figure here comes out of `{workspace}.api_calls`, which Flint writes
//! itself, and that is a deliberate departure from the rest of the product:
//! Flint's rule is to read `system.*` and keep no second copy of anything
//! ClickHouse already knows. Three of these panels cannot be built that way.
//!
//! A **cache hit** never reaches ClickHouse, so a hit rate read from the query
//! log is zero for ever. A **refusal** — a 429, a 403 on an unexposed column —
//! runs no statement, so there is no row in the query log to find. And a query
//! log row records the account the statement ran *as*, which is Flint's for
//! every published endpoint, so it cannot tell one key from another however
//! carefully the statement is tagged.
//!
//! `system.query_log` is still the better source for what a call *cost* on the
//! server, and the diagnostics page goes on reading it. This is the caller's
//! side of the same traffic.

use serde::{Deserialize, Serialize};

/// One revision of one address, as the list page shows it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlugUsage {
    pub slug: String,
    /// Which revision took these calls. Several rows share a slug, one per
    /// revision that answered anything in the window.
    pub revision: u32,
    pub calls: u64,
    /// Answered from memory. The page shows the share, and shows nothing where
    /// the endpoint has no cache — a hit rate of 0% on an uncached endpoint
    /// reads as a cache that is failing rather than one that is off.
    pub cached: u64,
    pub failures: u64,
    /// Absent where nothing was answered — a revision whose every call in the
    /// window was refused has no p95, and zero would read as instant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p95_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_ms: Option<f64>,
    pub last_call: String,
    /// Distinct keys seen, which is a different figure from the keys scoped to
    /// this endpoint: a key that may call and never has is not a caller.
    pub keys: u64,
}

/// One key's day against one endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyUsage {
    pub key_id: String,
    pub key_name: String,
    pub owner: String,
    /// Calls answered today. What the quota is measured against.
    pub calls_today: u64,
    pub quota_per_day: u32,
    /// Calls refused today for being over the quota — the figure that turns
    /// "this key is near its limit" into "this key has been losing calls since
    /// eleven this morning".
    pub throttled_today: u64,
    pub last_call: String,
}

/// One caller, as "who calls it" lists them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallerUsage {
    /// Empty where the call carried no key — a public endpoint, or one called
    /// with its own shared token. Shown as "no key" rather than blank.
    pub key_name: String,
    /// What the caller said it was doing. Empty where it said nothing.
    pub label: String,
    pub calls: u64,
    pub last_call: String,
}

/// One way this endpoint has been refusing calls.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefusalUsage {
    pub status: u16,
    /// The groupable sentence — see `contract::Refusal`. Holds no value the
    /// caller supplied, so a thousand refusals collapse into one line.
    pub reason: String,
    pub calls: u64,
    pub last_call: String,
}

/// How an endpoint's cache is doing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheUsage {
    /// Seconds the endpoint permits. 0 is a cache that is off, and every other
    /// field here is then absent rather than zero.
    pub ttl: u32,
    pub hits: u64,
    pub misses: u64,
    /// Absent where nothing has been served either way — a hit rate needs a
    /// denominator, and 0% is a claim about an endpoint nobody has called.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hit_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_hit_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_miss_ms: Option<f64>,
    /// The age of the oldest answer this process could still hand back, in
    /// seconds. Read from the live store rather than the log, because it is a
    /// statement about right now — and absent where the store holds nothing,
    /// which is a different thing from an age of zero.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oldest_held: Option<u64>,
    pub held: u64,
}

/// Everything the detail page's right-hand column asks for.
#[derive(Debug, Clone, Serialize)]
pub struct EndpointUsage {
    /// False where the workspace could not be read at all. Every figure below
    /// is then absent rather than zero, and the page says so — "not called" and
    /// "cannot tell" are different sentences and only one of them is a fact.
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub window_hours: u32,
    pub cache: CacheUsage,
    pub keys: Vec<KeyUsage>,
    pub callers: Vec<CallerUsage>,
    pub refusals: Vec<RefusalUsage>,
    /// Answered calls in the window, for the shares the panels quote against.
    pub calls: u64,
    pub failures: u64,
}

/// The list page's rollup.
#[derive(Debug, Clone, Serialize)]
pub struct UsageIndex {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub window_hours: u32,
    pub usage: Vec<SlugUsage>,
}

/// The table a statement reads from, as far as reading the text can tell.
///
/// A heuristic, and it says so: the first identifier after the first `FROM`
/// that is not a subquery. It is right for the shape of statement people
/// publish — one view, some filters — and it is wrong for a join, where it
/// names the left-hand side and no more. That is why the page calls the column
/// "From" rather than "Source": it is where the answer starts, not the whole
/// provenance, and the statement is on the page for anyone who needs the rest.
///
/// Nothing is returned rather than a guess where the text does not say. An
/// absent figure is dropped, not dashed.
pub fn source_of(sql: &str) -> Option<String> {
    let lowered = sql.to_lowercase();
    let mut at = 0usize;
    while let Some(found) = lowered[at..].find("from") {
        let start = at + found;
        let end = start + 4;
        // A whole word, not the tail of `dateDiff` or the head of `fromUnixTime`.
        let before_ok = start == 0
            || !lowered.as_bytes()[start - 1].is_ascii_alphanumeric()
                && lowered.as_bytes()[start - 1] != b'_';
        let after_ok = lowered
            .as_bytes()
            .get(end)
            .is_none_or(|b| !b.is_ascii_alphanumeric() && *b != b'_');
        at = end;
        if !before_ok || !after_ok {
            continue;
        }
        let rest = sql[end..].trim_start();
        // A subquery or a table function: the name is inside, and digging it
        // out is the lineage graph's job rather than this one's.
        if rest.starts_with('(') {
            continue;
        }
        let Some(name) = qualified_name(rest) else {
            continue;
        };
        return Some(name);
    }
    None
}

/// `db.table`, `table`, or either of those with backticks round the parts.
///
/// The backticks come off, because they are ClickHouse's quoting and not part
/// of the name — and a quoted part is read to its closing backtick rather than
/// to the first character that stops looking like an identifier, which is the
/// only way `` `odd name` `` survives as one name.
fn qualified_name(rest: &str) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut chars = rest.char_indices().peekable();
    loop {
        let mut part = String::new();
        match chars.peek() {
            Some((_, '`')) => {
                chars.next();
                for (_, c) in chars.by_ref() {
                    if c == '`' {
                        break;
                    }
                    part.push(c);
                }
            }
            _ => {
                while let Some((_, c)) = chars.peek() {
                    if c.is_alphanumeric() || *c == '_' {
                        part.push(*c);
                        chars.next();
                    } else {
                        break;
                    }
                }
            }
        }
        if part.is_empty() {
            break;
        }
        parts.push(part);
        match chars.peek() {
            Some((_, '.')) => {
                chars.next();
            }
            _ => break,
        }
    }
    (!parts.is_empty()).then(|| parts.join("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_after_from_is_what_is_named() {
        assert_eq!(
            source_of("SELECT day, count() FROM analytics.device_daily WHERE x = 1"),
            Some("analytics.device_daily".into())
        );
        assert_eq!(source_of("select * from events"), Some("events".into()));
    }

    #[test]
    fn a_word_that_merely_contains_from_is_not_a_from() {
        assert_eq!(
            source_of("SELECT fromUnixTimestamp(ts) AS t FROM logs"),
            Some("logs".into())
        );
        assert_eq!(
            source_of("SELECT dateDiff('day', a, b) FROM t"),
            Some("t".into())
        );
    }

    #[test]
    fn a_subquery_is_stepped_over_to_the_table_inside_it() {
        assert_eq!(
            source_of("SELECT * FROM (SELECT * FROM raw.events) WHERE n > 1"),
            Some("raw.events".into())
        );
    }

    #[test]
    fn a_backticked_name_comes_back_without_its_quotes() {
        assert_eq!(
            source_of("SELECT * FROM `odd name`"),
            Some("odd name".into())
        );
        assert_eq!(
            source_of("SELECT * FROM `db`.`t` LIMIT 1"),
            Some("db.t".into())
        );
        assert_eq!(
            source_of("SELECT * FROM db.`t` LIMIT 1"),
            Some("db.t".into())
        );
    }

    #[test]
    fn a_statement_that_names_no_table_names_nothing() {
        assert_eq!(source_of("SELECT 1"), None);
        assert_eq!(source_of("SELECT now()"), None);
        assert_eq!(source_of(""), None);
    }
}
