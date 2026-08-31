//! What a set of credentials will actually be able to do here, measured before
//! anybody commits to them.
//!
//! The sign-in screen used to ask for three fields and answer with a session or
//! a refusal, which leaves the interesting failure undiscovered: credentials
//! that are *accepted* and then cannot read the query log, cannot see
//! `system.parts`, cannot create the table an alert needs. Every one of those
//! surfaces later as a page that loads and says nothing, or a tab that fails
//! when it is opened, and by then the person is three clicks from the form that
//! could have told them.
//!
//! So this runs the reads Flint's own sections are built on, as the offered
//! user, before the session exists. It **measures and nothing more**: which
//! system tables answered, which refused, which the server does not have, the
//! grants the user holds, and four figures about the server. What any of that
//! means for a section — granted, refused, hidden, degraded — is decided in
//! `frontend/src/lib/preflight.ts`, where it is a pure function with tests
//! against it, because that judgement is the part that changes.
//!
//! **Attempting the read beats reading the grant.** `SHOW GRANTS` has to be
//! interpreted — wildcards, roles, revokes, `WITH IMPLICIT` — and every
//! interpretation is a second implementation of ClickHouse's own access rules
//! that can disagree with it. `SELECT count() FROM system.query_log WHERE 0`
//! cannot disagree with anything: it is the read, and the server answers it or
//! says why. `Client::reach` already had this exactly right, and this module is
//! mostly an arrangement of it.
//!
//! The grants are still read, for a different job: to *name* what the verdict
//! rests on. "granted" beside `SELECT on analytics.*, reference.*` is a sentence
//! somebody can check; "granted" on its own asks to be trusted.

use std::collections::BTreeMap;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::{grants, Client, Reach};
use crate::error::Result;

/// The system tables Flint's sections stand on, one per thing the screen has to
/// say. Seven round trips rather than one query over all of them, because each
/// is separately refusable and a single statement fails whole: a user who may
/// read `system.parts` and not `system.query_log` would come back with nothing,
/// which is the one answer that is wrong about both.
const PROBES: [&str; 7] = [
    // Explore, Query, and everything drawn from a schema.
    "tables",
    // Diagnostics: what a query cost.
    "query_log",
    // Pipelines and Health: what the parts are doing.
    "parts",
    "merges",
    // Access and Audit.
    "users",
    "session_log",
    // Not a section — the node count on the footer line. It is in here rather
    // than beside the other figures because `system.clusters` answers
    // `NO_ELEMENTS_IN_CONFIG` on a single node, which is a shape and not a
    // failure, and `Reach::Unconfigured` is the only thing that says so.
    "clusters",
];

/// One measurement of one server, as one user.
#[derive(Debug, Serialize)]
pub struct Reading {
    /// Milliseconds to the first answered round trip.
    ///
    /// Taken on `SELECT version()`, which needs no grant at all, so the figure
    /// is the network's and not a permission's. Measured around one statement
    /// rather than the whole probe: everything after it runs concurrently, and
    /// the sum of twelve overlapping round trips is not a latency anybody can
    /// use.
    pub reached_ms: u64,
    pub version: String,
    /// Databases and objects this user can see — grant-filtered, which is the
    /// honest count for a screen about what this user can do. `None` where the
    /// count itself was refused, and absent from the payload rather than zero:
    /// see the house rule about a figure that has no value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub databases: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objects: Option<u64>,
    /// Distinct hosts across every cluster this server is configured with.
    /// `None` on a server with no cluster configuration, which is the ordinary
    /// single node rather than a failure to read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nodes: Option<u64>,
    /// What each of `PROBES` answered: `readable`, `denied`, `absent` or
    /// `unconfigured`.
    pub reach: BTreeMap<String, &'static str>,
    /// The grants, for naming what a verdict rests on. `None` where even
    /// `SHOW GRANTS` failed — which should not happen, since it is a statement
    /// about the caller, and is carried as absence rather than as an empty list
    /// so the screen can say "could not tell" instead of "none".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grants: Option<grants::MyGrants>,
}

/// Everything the sign-in screen needs, asked as the credentials on the form.
pub async fn measure(ch: &Client, user: &str) -> Result<Reading> {
    #[derive(Deserialize)]
    struct Ver {
        v: String,
    }

    // First, alone, and awaited on its own: this is the round trip that decides
    // whether anything is there, and the one whose duration is worth reporting.
    // Its error is the caller's error — a transport failure or a refused
    // credential, both of which the route turns into the right status.
    let started = Instant::now();
    let version = ch.row::<Ver>("SELECT version() AS v").await?;
    let reached_ms = started.elapsed().as_millis() as u64;

    let (databases, objects, nodes, mine, reach) = tokio::join!(
        count(ch, "SELECT count() AS n FROM system.databases"),
        // The user's own objects, not the server's furniture. `system` and the
        // two spellings of the SQL-standard schema are excluded because a
        // reader counting "what is on this server" is not counting the query
        // log — Flint's own explorer hides them for the same reason.
        count(
            ch,
            "SELECT count() AS n FROM system.tables \
             WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')"
        ),
        count(ch, "SELECT uniqExact(host_name) AS n FROM system.clusters"),
        grants::mine(ch, user),
        reaches(ch),
    );

    Ok(Reading {
        reached_ms,
        // A server that answered the statement with no rows is not worth
        // guessing about, and the version is the one figure on that line whose
        // absence would be read as a very old server rather than as silence.
        version: version.map(|v| v.v).unwrap_or_default(),
        databases,
        objects,
        nodes,
        reach,
        grants: mine.ok(),
    })
}

/// A single figure, or nothing. Every one of these is grant-filtered and every
/// one can be refused outright, and neither is an error worth failing the whole
/// screen for: the panel drops a figure it does not have.
async fn count(ch: &Client, sql: &str) -> Option<u64> {
    #[derive(Deserialize)]
    struct N {
        n: u64,
    }
    ch.row::<N>(sql).await.ok().flatten().map(|row| row.n)
}

/// Every probe at once. Named futures rather than a loop because `tokio::join!`
/// wants them spelled out, and the alternative — awaiting seven round trips in
/// sequence — is seven times the network on the one screen where somebody is
/// waiting to get in.
async fn reaches(ch: &Client) -> BTreeMap<String, &'static str> {
    let [tables, query_log, parts, merges, users, session_log, clusters] = PROBES;
    let answers = tokio::join!(
        ch.reach(tables),
        ch.reach(query_log),
        ch.reach(parts),
        ch.reach(merges),
        ch.reach(users),
        ch.reach(session_log),
        ch.reach(clusters),
    );
    let answers = [
        answers.0, answers.1, answers.2, answers.3, answers.4, answers.5, answers.6,
    ];

    PROBES
        .iter()
        .zip(answers)
        .filter_map(|(name, answer)| {
            // A transport error here is not a verdict about the table, and
            // recording it as one would say "refused" about a socket that
            // closed. The entry is left out, and the screen says it could not
            // tell — which is what `PROBES` missing a key means.
            answer.ok().map(|reach| (name.to_string(), word(reach)))
        })
        .collect()
}

/// `Reach` as one word on the wire.
///
/// Written here rather than derived on the enum: this is a payload contract the
/// frontend's `lib/preflight.ts` matches on, and a rename of a Rust variant
/// should not be able to change it silently.
fn word(reach: Reach) -> &'static str {
    match reach {
        Reach::Readable => "readable",
        Reach::Denied => "denied",
        Reach::Absent => "absent",
        Reach::Unconfigured => "unconfigured",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_probe_has_a_word_and_no_duplicates() {
        let mut seen = PROBES.to_vec();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), PROBES.len(), "a probe is listed twice");
    }

    #[test]
    fn the_words_are_the_ones_the_frontend_matches_on() {
        assert_eq!(word(Reach::Readable), "readable");
        assert_eq!(word(Reach::Denied), "denied");
        assert_eq!(word(Reach::Absent), "absent");
        assert_eq!(word(Reach::Unconfigured), "unconfigured");
    }
}
