//! What Flint did, who asked for it, and what the server said.
//!
//! The trail was never a subsystem, and this file is the argument for why it did
//! not need to be. Signing in with ClickHouse credentials meant every statement
//! already arrives attributed — `system.query_log` carries `user` — and every
//! long operation already writes a row saying who submitted it and under which
//! tier. So an audit is a *read*, and building a second log beside those two
//! would have produced a third account of the same events, free to disagree with
//! both.
//!
//! **What is in it.** Things somebody deliberately did, which are exactly the
//! ones Flint can name:
//!
//! - **Operations** — the job table. An `OPTIMIZE`, an edition of a report:
//!   the label, the submitter, the tier that allowed it, and how it ended.
//! - **Calls on a published endpoint**, by slug, including the refused ones.
//! - **Reads of a dataset**, by dataset, the same way.
//!
//! **What is not, and why it is said rather than left to be noticed.**
//! Statements typed into the editor are in `system.query_log` under the name of
//! whoever ran them, and they carry no tag of Flint's — so this cannot tell one
//! apart from a statement the same person ran with `clickhouse-client`. The
//! History page shows those, filtered by user; an audit that quietly showed some
//! of them and not others would be worse than one that says which half it holds.
//!
//! **The server's own words are kept, deliberately.** An API refusal is
//! translated before it leaves Flint — a caller who was never shown the schema
//! must not learn it from an error. An audit is the opposite case: it is read by
//! whoever runs this server, about their own server, and the whole value of it
//! is that it says what actually happened. `Not enough privileges … SELECT on
//! system.users` is the answer here, not a leak.
//!
//! A read-only role is often granted none of `system.query_log`, and the log can
//! be switched off entirely. Both are configuration facts and are reported as
//! ones: an entry list that is short because a grant is missing must not look
//! like a quiet week.

use serde::{Deserialize, Serialize};

use super::{Client, INTROSPECTION_TAG};
use crate::error::Result;
use crate::published::{CALL_TAG_PREFIX, DATASET_TAG_PREFIX};

/// What kind of thing an entry records.
///
/// Coarse on purpose: an audit is read by somebody asking "who did what", and
/// three answers they can hold in their head beat a taxonomy they have to
/// learn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Work that outlived the request that asked for it.
    Operation,
    /// A caller fetching a published endpoint.
    Endpoint,
    /// Somebody reading a dataset through the API.
    Dataset,
}

/// How something ended, in the three answers there are.
///
/// A boolean was the first shape and it was wrong by one: a job has four states
/// and only one of them is `done`. Under `ok: bool` a job that was *still
/// running* came back false, and the page painted it as a refusal — which is
/// the opposite of true and the kind of thing somebody acts on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Ok,
    Failed,
    /// Neither, and it may never be either. A job still going may yet succeed;
    /// an interrupted one very often did, on a server that carried on after
    /// Flint stopped watching. Calling either of them failed would be a guess
    /// dressed as a fact.
    Unfinished,
}

/// What a job's state means to somebody reading the trail.
fn outcome_of(state: &str) -> Outcome {
    match state {
        "done" => Outcome::Ok,
        "failed" => Outcome::Failed,
        // `running` and `interrupted`, and anything a later version adds:
        // unknown is the honest answer for a state this does not recognise.
        _ => Outcome::Unfinished,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub at: String,
    /// The account, as ClickHouse knows it. Never Flint's idea of a person:
    /// there is only one register of who anybody is, and it is the server's.
    pub who: String,
    pub kind: Kind,
    /// The endpoint's address, the dataset's name, or the operation's label.
    pub what: String,
    /// How it ended. A call is `ok` or `failed`; an operation can also be
    /// neither.
    pub outcome: Outcome,
    /// What went wrong, where something did. First line only — the rest of a
    /// ClickHouse exception is the statement, and a page that lists other
    /// people's failures should not also print their SQL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The tier that permitted it. Only an operation has one: a read is
    /// permitted by a grant, and the grant is the audit trail for that.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Absent rather than zero where the server did not say — a job that was
    /// interrupted read some unknown number of rows, and printing `0` would
    /// answer a question nobody can check.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_rows: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuditReport {
    pub days: u64,
    pub entries: Vec<Entry>,
    /// Why the calls and the reads are missing, when they are. The operations
    /// come from Flint's own workspace and are reported separately, because the
    /// two halves fail for different reasons and a single "unavailable" would
    /// hide whichever one still worked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calls_unavailable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operations_unavailable: Option<String>,
    /// Said whenever the list was cut, with its own count — a trail that stops
    /// without saying so reads as the whole of what happened.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CallRow {
    at: String,
    who: String,
    tag: String,
    ok: u8,
    detail: String,
    duration_ms: u64,
    read_rows: u64,
}

#[derive(Debug, Deserialize)]
struct JobRow {
    at: String,
    who: String,
    label: String,
    kind: String,
    state: String,
    detail: String,
    tier: String,
}

/// The trail, newest first.
///
/// `workspace` is the database Flint keeps its own records in, or `None` where
/// it has none — a stateless Flint has no operations to show and says so rather
/// than looking as though nothing was ever run.
pub async fn report(
    ch: &Client,
    workspace: Option<&str>,
    days: u64,
    limit: u64,
) -> Result<AuditReport> {
    let days = days.clamp(1, 90);
    let limit = limit.clamp(1, 500);

    let mut entries = Vec::new();
    let mut calls_unavailable = None;
    let mut operations_unavailable = None;

    // One more than the page from each half, which is what makes "there is more
    // behind this" a fact rather than a guess — the same trick the dataset API
    // pages with.
    let fetch = limit + 1;

    match calls(ch, days, fetch).await {
        Ok(Ok(rows)) => entries.extend(rows),
        Ok(Err(reason)) => calls_unavailable = Some(reason),
        Err(e) => return Err(e),
    }

    match workspace {
        None => {
            operations_unavailable = Some(
                "this Flint has no workspace, so it keeps no record of what it ran".to_string(),
            )
        }
        Some(database) => match operations(ch, database, days, fetch).await {
            Ok(rows) => entries.extend(rows),
            // A workspace that is there and unreadable is a grant problem, and
            // saying which table would send somebody to fix the right one.
            Err(e) => operations_unavailable = Some(first_line(&e.to_string())),
        },
    }

    // One trail, not two lists side by side: what somebody wants from an audit
    // is the order things happened in.
    entries.sort_by(|a, b| b.at.cmp(&a.at));
    let more = entries.len() > limit as usize;
    entries.truncate(limit as usize);

    Ok(AuditReport {
        days,
        // No total, deliberately, because there is not one to give. An earlier
        // version said "showing the 200 most recent of 400", where the 400 was
        // simply twice the page — each half is asked for a page and no more, so
        // the sum of two capped halves counts nothing. On a server with a
        // thousand calls in the window it read as a quiet week that had been
        // tidily summarised, which is worse than saying less.
        note: more.then(|| {
            format!(
                "showing the {} most recent. There is more in the last {days} days — \
                 a shorter window shows all of a shorter period.",
                entries.len()
            )
        }),
        entries,
        calls_unavailable,
        operations_unavailable,
    })
}

/// Calls on a published endpoint, and reads of a dataset.
///
/// Both are `system.query_log` filtered to Flint's own tags, which is the whole
/// reason those tags exist. `Ok(Err(reason))` is a log this user cannot read or
/// this server does not keep — a fact about the deployment, not a failure.
async fn calls(
    ch: &Client,
    days: u64,
    limit: u64,
) -> Result<std::result::Result<Vec<Entry>, String>> {
    // Reach first, and the order is the whole point. A user who may not read
    // `system.query_log` gets an empty column list back — so asking about the
    // columns first turns a missing grant into "this ClickHouse is too old",
    // which sends somebody to upgrade a server that did not need upgrading.
    // Found by running this as the narrowly-granted account, which is what that
    // account is in the fixture for.
    if let Some(reason) = super::diagnostics::blocked(ch.reach("query_log").await?, "query_log") {
        return Ok(Err(reason));
    }
    if !ch
        .system_columns("query_log")
        .await?
        .contains("log_comment")
    {
        return Ok(Err(
            "this ClickHouse version's system.query_log has no log_comment, which is how \
             Flint tells its own calls apart"
                .to_string(),
        ));
    }

    let rows: Vec<CallRow> = ch
        .rows_with(
            &format!(
                "SELECT toString(event_time)                     AS at, \
                        user                                     AS who, \
                        log_comment                              AS tag, \
                        toUInt8(type = 'QueryFinish')            AS ok, \
                        exception                                AS detail, \
                        toUInt64(query_duration_ms)              AS duration_ms, \
                        toUInt64(read_rows)                      AS read_rows \
                 FROM system.query_log \
                 WHERE event_time >= now() - INTERVAL {days} DAY \
                   /* The two prefixes Flint stamps, and nothing else: an \
                      untagged statement is one somebody typed, which this \
                      cannot tell from one they ran outside Flint. */ \
                   AND (startsWith(log_comment, '{CALL_TAG_PREFIX}') \
                        OR startsWith(log_comment, '{DATASET_TAG_PREFIX}')) \
                   AND log_comment != '{INTROSPECTION_TAG}' \
                   /* One row per call. A statement logs a start and a finish, \
                      and counting both would double every entry. */ \
                   AND type != 'QueryStart' \
                   /* A shaped read describes the dataset before it runs it, \
                      which is two statements and one call. The describe is \
                      kept only when it failed, because that is the moment a \
                      refusal happens and the only time it is the *call* being \
                      recorded rather than Flint's own preliminary. */ \
                   AND (query_kind != 'Describe' OR type != 'QueryFinish') \
                 ORDER BY event_time DESC \
                 LIMIT {limit}"
            ),
            super::QueryOptions {
                introspection: true,
                quote_64bit_integers: false,
                ..Default::default()
            },
        )
        .await?;

    Ok(Ok(rows
        .into_iter()
        .map(|r| {
            let (kind, what) = match r.tag.strip_prefix(CALL_TAG_PREFIX) {
                Some(slug) => (Kind::Endpoint, slug.to_string()),
                None => (
                    Kind::Dataset,
                    r.tag
                        .strip_prefix(DATASET_TAG_PREFIX)
                        .unwrap_or(&r.tag)
                        .to_string(),
                ),
            };
            Entry {
                at: r.at,
                who: r.who,
                kind,
                what,
                outcome: if r.ok != 0 {
                    Outcome::Ok
                } else {
                    Outcome::Failed
                },
                detail: (!r.detail.is_empty()).then(|| first_line(&r.detail)),
                tier: None,
                duration_ms: Some(r.duration_ms),
                read_rows: Some(r.read_rows),
            }
        })
        .collect()))
}

/// Work that outlived the request that asked for it.
async fn operations(ch: &Client, database: &str, days: u64, limit: u64) -> Result<Vec<Entry>> {
    let rows: Vec<JobRow> = ch
        .rows_with(
            &format!(
                // Seconds, like the query log's. The two halves are sorted
                // against each other and shown as one list, and a millisecond
                // on one line with none on the next reads as two kinds of
                // record rather than one trail.
                "SELECT toString(toDateTime(argMax(started_at, version))) AS at, \
                        argMax(submitted_by, version)          AS who, \
                        argMax(label, version)                 AS label, \
                        argMax(kind, version)                  AS kind, \
                        argMax(state, version)                 AS state, \
                        argMax(detail, version)                AS detail, \
                        argMax(tier, version)                  AS tier \
                 FROM {database}.jobs \
                 GROUP BY id \
                 HAVING argMax(started_at, version) >= now() - INTERVAL {days} DAY \
                 ORDER BY at DESC \
                 LIMIT {limit}"
            ),
            super::QueryOptions {
                introspection: true,
                quote_64bit_integers: false,
                ..Default::default()
            },
        )
        .await?;

    Ok(rows
        .into_iter()
        .map(|r| Entry {
            at: r.at,
            who: r.who,
            kind: Kind::Operation,
            // The label is what a person called it; the kind is what it was.
            // Both, because "Optimize analytics.events" answers a question that
            // "optimize" alone does not.
            what: if r.label.is_empty() {
                r.kind.clone()
            } else {
                r.label.clone()
            },
            outcome: outcome_of(&r.state),
            detail: match (r.state.as_str(), r.detail.is_empty()) {
                ("done", _) => None,
                ("interrupted", true) => Some("Flint restarted while this was running".to_string()),
                (_, true) => Some(r.state.clone()),
                (_, false) => Some(first_line(&r.detail)),
            },
            tier: (!r.tier.is_empty()).then(|| r.tier.clone()),
            duration_ms: None,
            read_rows: None,
        })
        .collect())
}

/// What the server said, without the statement it said it about.
///
/// A first line is not enough, which is what the page showed: ClickHouse writes
/// `… (UNKNOWN_TABLE)` and `In scope SELECT * FROM …` on the *same* line often
/// enough that taking the line kept the SQL. So the markers are cut on, exactly
/// as `routes/data.rs` cuts them when it hands an error back to a caller.
///
/// It matters more here than it looks. A published endpoint's failure carries
/// its author's statement, and this page is read by anybody signed in — the same
/// rule the published face follows, for the same reason.
fn first_line(message: &str) -> String {
    message[..super::statement_starts_at(message)]
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(300)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_is_quoted_without_the_statement_it_refused() {
        // On its own line, and — the case the page actually showed — on the
        // same one. A published endpoint's failure carries its author's SQL,
        // and this page is read by anybody signed in.
        for said in [
            "Code: 497. DB::Exception: Not enough privileges.\nIn scope SELECT secret \
             FROM vault.keys.",
            "Code: 60. DB::Exception: Unknown table 'x' in scope SELECT secret FROM \
             vault.keys. (UNKNOWN_TABLE)",
            "Code: 241. DB::Exception: Memory limit exceeded, while executing SELECT \
             secret FROM vault.keys",
        ] {
            let kept = first_line(said);
            assert!(kept.starts_with("Code:"), "{kept}");
            assert!(!kept.contains("vault.keys"), "{kept}");
        }
    }

    #[test]
    fn a_job_that_is_still_going_has_not_failed() {
        // The bug a boolean made inevitable: four states, and only one of them
        // is `done`, so everything else came back false and the page painted a
        // running job as a refusal.
        assert_eq!(outcome_of("done"), Outcome::Ok);
        assert_eq!(outcome_of("failed"), Outcome::Failed);
        assert_eq!(outcome_of("running"), Outcome::Unfinished);
        // Interrupted is the one the job runner deliberately refuses to call
        // either: the server very often finished the statement after Flint
        // stopped watching.
        assert_eq!(outcome_of("interrupted"), Outcome::Unfinished);
        // And a state a later version adds is unknown, not failed.
        assert_eq!(outcome_of("queued"), Outcome::Unfinished);
    }

    #[test]
    fn the_three_kinds_serialise_the_way_the_page_reads_them() {
        assert_eq!(
            serde_json::to_string(&Kind::Operation).unwrap(),
            "\"operation\""
        );
        assert_eq!(
            serde_json::to_string(&Kind::Endpoint).unwrap(),
            "\"endpoint\""
        );
        assert_eq!(
            serde_json::to_string(&Kind::Dataset).unwrap(),
            "\"dataset\""
        );
    }

    #[test]
    fn an_entry_drops_the_figures_it_does_not_have() {
        // A job read some unknown number of rows; printing zero would answer a
        // question nobody can check.
        let entry = Entry {
            at: "2026-01-01 00:00:00".into(),
            who: "analyst".into(),
            kind: Kind::Operation,
            what: "Optimize analytics.events".into(),
            outcome: Outcome::Ok,
            detail: None,
            tier: Some("ddl".into()),
            duration_ms: None,
            read_rows: None,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(!json.contains("read_rows"), "{json}");
        assert!(!json.contains("duration_ms"), "{json}");
        assert!(!json.contains("detail"), "{json}");
        assert!(json.contains("\"tier\":\"ddl\""), "{json}");
    }
}
