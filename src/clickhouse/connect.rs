//! Does the address answer?
//!
//! The object page can say a table reads `flint/events/*.parquet` on `s3:9000`
//! and be describing a bucket that has not existed for a year. Nothing about a
//! definition is a claim that the far end is there — the definition is metadata,
//! ClickHouse stores it without checking, and the first person to find out
//! otherwise is whoever runs a query at three in the morning.
//!
//! So this asks, once, when somebody presses the button. It is deliberately a
//! button and not a reading taken on page load: every other figure on that page
//! comes out of `system.*` on a server Flint is already talking to, and this one
//! opens a connection to somebody else's infrastructure. A page that quietly
//! contacts a production Postgres because a tab was opened is a page nobody can
//! leave open.
//!
//! **What it runs is `SELECT * FROM <table> LIMIT 1`**, read-only and with its
//! own execution budget, and it throws the row away. One row rather than a
//! count: `count()` on an `S3` table with a glob over ten thousand objects reads
//! all ten thousand, and the question here is whether the far end answers, not
//! how much is in it.
//!
//! **Two kinds of table are refused rather than checked**, and the refusal is
//! the honest answer rather than a limitation to apologise for:
//!
//! - A queue. Reading a `Kafka` or an `S3Queue` table *takes* from it, and what
//!   a check consumed would never reach the target table. ClickHouse refuses
//!   this itself unless `stream_like_engine_allow_direct_select` is on, and
//!   Flint does not ask it to — those two engines have a tab that reads their
//!   state instead of their rows.
//! - A table whose rows are on this server. There is nothing to reach.

use serde::Serialize;

use super::streams::message_only;
use super::{Client, QueryOptions};
use crate::error::Result;

/// Seconds this check is allowed to take.
///
/// Short on purpose, and shorter than the deployment's own query timeout. An
/// address that is wrong usually fails in milliseconds — the DNS does not
/// resolve — but one pointing at a host that exists and is not listening hangs
/// until something gives up, and the answer "it did not respond within fifteen
/// seconds" is worth more than a spinner that runs for two minutes.
const BUDGET_SECS: u64 = 15;

#[derive(Debug, Clone, Serialize)]
pub struct Attempt {
    /// Whether the far end answered at all. Not whether it had anything: an
    /// empty bucket is a bucket Flint reached.
    pub ok: bool,
    pub elapsed_ms: u64,
    /// Whether there was a row there. Kept apart from `ok` because "it answered
    /// and there is nothing in it" is the diagnosis for half the tickets this
    /// check exists to shorten.
    pub found: bool,
    /// The server's own message, without its stack trace. Empty when it worked.
    pub error: String,
    /// Set when Flint declined to run the check, and says why. Empty when it
    /// ran — a refusal is not a failure and must not render as one.
    pub refused: String,
}

/// Engines whose rows are somewhere else and which can be read without taking
/// anything. The list is deliberately explicit rather than "not a MergeTree":
/// this opens a network connection, and an engine nobody thought about should
/// fall through to a refusal rather than into a request.
fn reachable(engine: &str) -> bool {
    const OUTSIDE: [&str; 20] = [
        "S3",
        "GCS",
        "COSN",
        "OSS",
        "AzureBlobStorage",
        "HDFS",
        "URL",
        "File",
        "Iceberg",
        "DeltaLake",
        "Hudi",
        "Paimon",
        "MySQL",
        "PostgreSQL",
        "MaterializedPostgreSQL",
        "MongoDB",
        "SQLite",
        "Redis",
        "ODBC",
        "JDBC",
    ];
    // Prefixed rather than equal: ClickHouse ships `IcebergS3`, `IcebergAzure`
    // and `DeltaLakeS3`, which differ in where the files are and not in whether
    // they can be read.
    OUTSIDE
        .iter()
        .any(|name| engine.starts_with(name) && !engine.starts_with("S3Queue"))
}

/// Whether the queue engines, which must not be read.
fn takes_what_it_reads(engine: &str) -> bool {
    engine.starts_with("Kafka")
        || engine.starts_with("RabbitMQ")
        || engine.starts_with("NATS")
        || engine.ends_with("Queue")
}

pub async fn attempt(ch: &Client, database: &str, table: &str, engine: &str) -> Result<Attempt> {
    let refuse = |reason: &str| Attempt {
        ok: false,
        elapsed_ms: 0,
        found: false,
        error: String::new(),
        refused: reason.to_string(),
    };

    if takes_what_it_reads(engine) {
        return Ok(refuse(
            "Reading this table takes from the queue, and what a check consumed would never \
             reach a target table. ClickHouse refuses a direct select here unless \
             `stream_like_engine_allow_direct_select` is on, and Flint does not ask it to — the \
             consuming tab reads this table's state instead of its rows.",
        ));
    }
    if !reachable(engine) {
        return Ok(refuse(&format!(
            "A {engine} table's rows are on this server, so there is nothing to reach."
        )));
    }

    let started = std::time::Instant::now();
    let outcome = ch
        .table(
            "SELECT * FROM {db:Identifier}.{tbl:Identifier} LIMIT 1",
            QueryOptions {
                params: vec![
                    ("db".into(), database.to_string()),
                    ("tbl".into(), table.to_string()),
                ],
                max_rows: Some(1),
                // Read-only whatever this deployment otherwise allows. The
                // statement is Flint's, not the caller's, and the caller cannot
                // change what it is — but a table function in an engine's own
                // definition is somebody else's SQL, and this is the guarantee
                // that it stays a read.
                force_readonly: true,
                settings: vec![("max_execution_time".into(), BUDGET_SECS.to_string())],
                introspection: true,
                ..Default::default()
            },
        )
        .await;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    // A failure here is the answer, not an error — the same rule the alert
    // check keeps, and for the same reason: finding out now is the point.
    Ok(match outcome {
        Ok(result) => Attempt {
            ok: true,
            elapsed_ms,
            found: !result.rows.is_empty(),
            error: String::new(),
            refused: String::new(),
        },
        Err(e) => Attempt {
            ok: false,
            elapsed_ms,
            found: false,
            error: message_only(&e.to_string()),
            refused: String::new(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reaches_the_engines_whose_rows_are_elsewhere() {
        assert!(reachable("S3"));
        assert!(reachable("PostgreSQL"));
        assert!(reachable("IcebergS3"));
        assert!(reachable("URL"));
    }

    #[test]
    fn does_not_reach_a_table_that_is_already_here() {
        assert!(!reachable("MergeTree"));
        assert!(!reachable("ReplicatedReplacingMergeTree"));
        assert!(!reachable("Memory"));
        // An engine nobody has thought about falls through to a refusal rather
        // than into a network request.
        assert!(!reachable("SomeFutureEngine"));
    }

    #[test]
    fn never_reads_a_queue() {
        assert!(takes_what_it_reads("Kafka"));
        assert!(takes_what_it_reads("S3Queue"));
        assert!(takes_what_it_reads("AzureQueue"));
        assert!(takes_what_it_reads("RabbitMQ"));
        assert!(takes_what_it_reads("NATS"));
        // And `S3Queue` must not be caught by the `S3` that starts it.
        assert!(!reachable("S3Queue"));
    }

    #[test]
    fn a_plain_bucket_is_not_a_queue() {
        assert!(!takes_what_it_reads("S3"));
        assert!(!takes_what_it_reads("MergeTree"));
    }
}
