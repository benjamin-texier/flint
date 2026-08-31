//! What a streaming table is actually doing.
//!
//! `S3` and `PostgreSQL` are read when somebody queries them, so a table that
//! points at the wrong place fails in front of the person who asked. A `Kafka`
//! or an `S3Queue` table is not like that: it runs on its own, in the
//! background, and when it stops the only symptom is a target table that
//! quietly stops growing. Nothing in a query result says so, which is the same
//! reason `dictionaries` exists and the reason this does.
//!
//! Three states came out of running one, and all three are states the address
//! alone cannot distinguish:
//!
//! - **Declared and never started.** A `Kafka` table with no materialized view
//!   attached does not consume. The server still creates its consumers, so
//!   `system.kafka_consumers` has a row per `kafka_num_consumers` with an empty
//!   `consumer_id`, no assignments and a `last_poll_time` of `1970-01-01`. The
//!   fact that names it is `dependencies`, which is empty: nothing reads this
//!   table, so nothing drains the topic.
//! - **Running.** A consumer id, partitions assigned, offsets moving.
//! - **Polling and not delivering.** The consumer polls, `num_messages_read`
//!   climbs, and no rows arrive — one malformed message at the head of a
//!   partition, re-read every two seconds. The `exceptions` ring holds the last
//!   ten, and on a real one they were ten copies of the same parse error two
//!   seconds apart. Folding them is the frontend's job; keeping all ten so it
//!   can count them is this one's.
//!
//! **Two figures the server reports are not measurements**, and both are
//! dropped here rather than in the browser, because a `-1001` that reaches the
//! wire is a `-1001` somebody eventually renders:
//!
//! - An assigned partition with nothing consumed from it yet reports offset
//!   `-1001`, which is librdkafka's `RD_KAFKA_OFFSET_INVALID` and not an
//!   offset. It becomes null.
//! - `1970-01-01` in a timestamp means the thing never happened. That one is
//!   passed through as the server wrote it, because *never polled* and *last
//!   polled in 1970* are the same string and the page has a sentence for the
//!   first — the same arrangement `dictionaries` uses for `last_success`.

use serde::{Deserialize, Serialize};

use super::{Client, QueryOptions, Reach, Section};
use crate::error::Result;

/// Files before the list becomes a log to scroll rather than a page to read.
/// The count of what was left out goes with it.
const MAX_FILES: usize = 40;

/// Which reading applies to an engine, if either.
///
/// Prefix-matched like everything else that classifies an engine: `Kafka` is
/// the whole name today, and ClickHouse has form for shipping a `SharedKafka`
/// next to a `SharedMergeTree`.
pub fn stream_kind(engine: &str) -> &'static str {
    if engine.starts_with("Kafka") {
        "kafka"
    } else if engine.starts_with("S3Queue") {
        "queue"
    } else {
        ""
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamReport {
    /// `kafka`, `queue`, or empty where this table is neither — which is the
    /// answer for every other engine, and not an error.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kafka: Option<KafkaState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue: Option<QueueState>,
}

// ---------------------------------------------------------------------------
// Kafka
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct KafkaState {
    pub consumers: Section<KafkaConsumer>,
    /// The chains that drain this table: each one a materialized view and the
    /// table it writes into. **Empty is the diagnosis rather than a gap** — a
    /// Kafka table nothing reads never polls, and that is the whole explanation
    /// for a topic that appears stalled.
    pub dependencies: Vec<Vec<String>>,
    /// Dependencies the server has been told about and cannot find.
    pub missing: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KafkaConsumer {
    /// Empty until the consumer has joined the group, which it does not do
    /// until something reads the table.
    pub consumer_id: String,
    pub assignments: Vec<Assignment>,
    /// `1970-01-01 00:00:00` where it never happened. Left as the server wrote
    /// it: the page says "never polled" from this, and a blank would lose the
    /// difference between never and unknown.
    pub last_poll: String,
    pub last_commit: String,
    pub last_rebalance: String,
    pub messages_read: u64,
    pub commits: u64,
    pub revocations: u64,
    pub assigned: u64,
    pub active: bool,
    /// The server's ring of the last ten, oldest first. Kept whole so the page
    /// can say "the same error ten times" rather than showing it ten times.
    pub errors: Vec<StreamError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Assignment {
    pub topic: String,
    pub partition: i32,
    /// Null on a partition assigned but never read from, where the server
    /// reports `-1001` — librdkafka's "no offset", not an offset.
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamError {
    pub at: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
struct ConsumerRow {
    #[serde(default)]
    consumer_id: String,
    #[serde(default)]
    topics: Vec<String>,
    #[serde(default)]
    partitions: Vec<i32>,
    #[serde(default)]
    offsets: Vec<Option<i64>>,
    #[serde(default)]
    last_poll: String,
    #[serde(default)]
    last_commit: String,
    #[serde(default)]
    last_rebalance: String,
    #[serde(default)]
    messages_read: u64,
    #[serde(default)]
    commits: u64,
    #[serde(default)]
    revocations: u64,
    #[serde(default)]
    assigned: u64,
    #[serde(default)]
    active: bool,
    #[serde(default)]
    error_times: Vec<String>,
    #[serde(default)]
    error_texts: Vec<String>,
    #[serde(default)]
    dependencies: Vec<Vec<String>>,
    #[serde(default)]
    missing: Vec<Vec<String>>,
}

async fn kafka(ch: &Client, database: &str, table: &str) -> Result<KafkaState> {
    let blocked = match ch.reach("kafka_consumers").await? {
        Reach::Readable => None,
        Reach::Denied => Some("this user cannot read system.kafka_consumers".to_string()),
        Reach::Absent | Reach::Unconfigured => {
            Some("this ClickHouse has no system.kafka_consumers".to_string())
        }
    };
    if let Some(reason) = blocked {
        return Ok(KafkaState {
            consumers: Section::blocked(reason),
            dependencies: Vec::new(),
            missing: Vec::new(),
        });
    }

    let rows: Vec<ConsumerRow> = ch
        .rows_with(
            "SELECT consumer_id                                     AS consumer_id, \
                    assignments.topic                               AS topics, \
                    assignments.partition_id                        AS partitions, \
                    /* -1001 is librdkafka's RD_KAFKA_OFFSET_INVALID: a partition \
                       assigned and not yet read from. It is not an offset, so it \
                       does not leave here as one. */ \
                    arrayMap(o -> if(o < 0, NULL, o), \
                             assignments.current_offset)            AS offsets, \
                    toString(last_poll_time)                        AS last_poll, \
                    toString(last_commit_time)                      AS last_commit, \
                    toString(last_rebalance_time)                   AS last_rebalance, \
                    num_messages_read                               AS messages_read, \
                    num_commits                                     AS commits, \
                    num_rebalance_revocations                       AS revocations, \
                    num_rebalance_assignments                       AS assigned, \
                    CAST(is_currently_used != 0 AS Bool)            AS active, \
                    arrayMap(t -> toString(t), exceptions.time)     AS error_times, \
                    exceptions.text                                 AS error_texts, \
                    dependencies                                    AS dependencies, \
                    missing_dependencies                            AS missing \
             FROM system.kafka_consumers \
             WHERE database = {db:String} AND table = {tbl:String}",
            QueryOptions {
                params: vec![
                    ("db".into(), database.to_string()),
                    ("tbl".into(), table.to_string()),
                ],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;

    // The dependency chain is a property of the table, and the server repeats
    // it on every consumer row. Taken from the first rather than concatenated,
    // because two consumers of one table listing the same view twice would read
    // as two views.
    let dependencies = rows
        .first()
        .map(|r| r.dependencies.clone())
        .unwrap_or_default();
    let missing = rows.first().map(|r| r.missing.clone()).unwrap_or_default();

    let consumers = rows
        .into_iter()
        .map(|r| KafkaConsumer {
            consumer_id: r.consumer_id,
            assignments: (0..r.partitions.len())
                .map(|i| Assignment {
                    topic: r.topics.get(i).cloned().unwrap_or_default(),
                    partition: r.partitions[i],
                    offset: r.offsets.get(i).copied().flatten(),
                })
                .collect(),
            last_poll: r.last_poll,
            last_commit: r.last_commit,
            last_rebalance: r.last_rebalance,
            messages_read: r.messages_read,
            commits: r.commits,
            revocations: r.revocations,
            assigned: r.assigned,
            active: r.active,
            errors: (0..r.error_texts.len())
                .map(|i| StreamError {
                    at: r.error_times.get(i).cloned().unwrap_or_default(),
                    text: message_only(&r.error_texts[i]),
                })
                .collect(),
        })
        .collect();

    Ok(KafkaState {
        consumers: Section::of(consumers),
        dependencies,
        missing,
    })
}

/// A ClickHouse exception without its stack trace.
///
/// The trace is forty lines of mangled C++ symbols and the message is two, and
/// on a Kafka consumer the *second* of those two is the one worth reading —
/// `while parsing Kafka message (topic: events, partition: 1, offset: 0)` names
/// the message that is stuck. So this cuts at the first stack frame rather than
/// taking the first line, which would have thrown that away.
fn message_only(exception: &str) -> String {
    let cut = exception
        .lines()
        .position(|line| {
            let trimmed = line.trim_start();
            trimmed
                .split_once(". ")
                .is_some_and(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        })
        .unwrap_or(usize::MAX);
    let text = exception
        .lines()
        .take(cut)
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let text = if text.is_empty() {
        exception.trim().to_string()
    } else {
        text
    };
    // ClickHouse announces the trace on the line before it. With the trace gone
    // that line is an invitation to read something that is no longer there.
    let text = text
        .trim_end_matches(
            "Stack trace (when copying this message, always include the lines below):",
        )
        .trim_end()
        // And the comma that was joining it to the sentence: with the clause
        // after it gone, it is punctuation pointing at nothing.
        .trim_end_matches([',', ':'])
        .trim_end()
        .to_string();
    // A message that is somehow still enormous is cut rather than sent: this is
    // a panel, and the query log has the whole of it.
    if text.chars().count() > 600 {
        format!("{}…", text.chars().take(600).collect::<String>())
    } else {
        text
    }
}

// ---------------------------------------------------------------------------
// S3Queue
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct QueueState {
    pub files: Section<QueueFile>,
    pub processed: u64,
    pub failed: u64,
    pub rows: u64,
    /// The oldest event still in the log. It has a TTL, so the page states how
    /// far back what it shows actually reaches rather than letting a history
    /// that quietly stops read as a history that ended.
    pub since: String,
    /// What the list holds against what the log holds, so a cap states itself.
    pub total: u64,
    /// The settings this queue was created with that are not the defaults —
    /// `mode` above all, which decides whether a file can be taken twice.
    pub settings: Vec<QueueSetting>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueFile {
    pub name: String,
    /// `Processed` or `Failed`, as the server spells it.
    pub status: String,
    pub rows: u64,
    pub started: String,
    pub ended: String,
    pub millis: u64,
    pub exception: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueSetting {
    pub name: String,
    pub value: String,
}

async fn queue(ch: &Client, database: &str, table: &str) -> Result<QueueState> {
    let params = vec![
        ("db".into(), database.to_string()),
        ("tbl".into(), table.to_string()),
    ];
    let opts = || QueryOptions {
        params: params.clone(),
        quote_64bit_integers: false,
        introspection: true,
        ..Default::default()
    };

    // Settings first: they are a different system table with a different grant,
    // and losing them must not cost the file list. `mode` is the one that
    // changes what the list means, so it is worth having even alone.
    let settings: Vec<QueueSetting> = if ch.has_system_table("s3_queue_settings").await? {
        ch.rows_with(
            "SELECT name AS name, value AS value \
             FROM system.s3_queue_settings \
             WHERE database = {db:String} AND table = {tbl:String} AND changed \
             ORDER BY name",
            opts(),
        )
        .await
        .unwrap_or_default()
    } else {
        Vec::new()
    };

    let blocked = match ch.reach("s3queue_log").await? {
        Reach::Readable => None,
        Reach::Denied => Some("this user cannot read system.s3queue_log".to_string()),
        Reach::Absent | Reach::Unconfigured => {
            Some("this ClickHouse is not writing system.s3queue_log".to_string())
        }
    };
    if let Some(reason) = blocked {
        return Ok(QueueState {
            files: Section::blocked(reason),
            processed: 0,
            failed: 0,
            rows: 0,
            since: String::new(),
            total: 0,
            settings,
        });
    }

    #[derive(Deserialize)]
    struct Rollup {
        #[serde(default)]
        processed: u64,
        #[serde(default)]
        failed: u64,
        #[serde(default)]
        rows: u64,
        #[serde(default)]
        since: String,
        #[serde(default)]
        total: u64,
    }
    let rollup: Rollup = ch
        .row_with(
            "SELECT countIf(status = 'Processed')       AS processed, \
                    countIf(status = 'Failed')          AS failed, \
                    sum(rows_processed)                 AS rows, \
                    toString(min(event_time))           AS since, \
                    count()                             AS total \
             FROM system.s3queue_log \
             WHERE database = {db:String} AND table = {tbl:String}",
            opts(),
        )
        .await?
        .unwrap_or(Rollup {
            processed: 0,
            failed: 0,
            rows: 0,
            since: String::new(),
            total: 0,
        });

    let files: Vec<QueueFile> = ch
        .rows_with(
            &format!(
                "SELECT file_name                                       AS name, \
                        toString(status)                                AS status, \
                        rows_processed                                  AS rows, \
                        coalesce(toString(processing_start_time), '')    AS started, \
                        coalesce(toString(processing_end_time), '')      AS ended, \
                        coalesce(toUInt64(dateDiff('millisecond', \
                                 processing_start_time, \
                                 processing_end_time)), 0)              AS millis, \
                        exception                                       AS exception \
                 FROM system.s3queue_log \
                 WHERE database = {{db:String}} AND table = {{tbl:String}} \
                 /* Newest first, and cut: this is a log, and the page says how \
                    much of it it is showing. */ \
                 ORDER BY event_time DESC, file_name DESC \
                 LIMIT {MAX_FILES}"
            ),
            opts(),
        )
        .await?;

    let files = files
        .into_iter()
        .map(|mut f| {
            f.exception = message_only(&f.exception);
            f
        })
        .collect();

    Ok(QueueState {
        files: Section::of(files),
        processed: rollup.processed,
        failed: rollup.failed,
        rows: rollup.rows,
        since: rollup.since,
        total: rollup.total,
        settings,
    })
}

// ---------------------------------------------------------------------------

/// What this table's background reader is doing, or an empty report where the
/// table has no background reader — which is not a failure and does not read as
/// one.
pub async fn stream(
    ch: &Client,
    database: &str,
    table: &str,
    engine: &str,
) -> Result<StreamReport> {
    let kind = stream_kind(engine);
    Ok(StreamReport {
        kind: kind.to_string(),
        kafka: if kind == "kafka" {
            Some(kafka(ch, database, table).await?)
        } else {
            None
        },
        queue: if kind == "queue" {
            Some(queue(ch, database, table).await?)
        } else {
            None
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_the_engines_with_a_background_reader() {
        assert_eq!(stream_kind("Kafka"), "kafka");
        assert_eq!(stream_kind("S3Queue"), "queue");
        assert_eq!(stream_kind("MergeTree"), "");
        assert_eq!(stream_kind("S3"), "");
        // `S3` is a prefix of `S3Queue`, and the shorter one must not win.
        assert_ne!(stream_kind("S3Queue"), stream_kind("S3"));
    }

    #[test]
    fn keeps_the_part_of_an_exception_that_names_the_message() {
        // Copied from a consumer stuck on one malformed message.
        let raw =
            "Cannot parse input: expected '{' before: 'this is not json at all': (at row 1)\n\
                   : while parsing Kafka message (topic: events, partition: 1, offset: 0)\n\
                   0. DB::KafkaConsumer::setExceptionInfo(String const&, bool) @ 0x19647b3e\n\
                   1. unsigned long std::__function::__policy_func<unsigned long (std::v";
        let kept = message_only(raw);
        assert!(kept.contains("expected '{'"));
        // The second line is the one worth reading, and taking the first would
        // have dropped it.
        assert!(kept.contains("partition: 1, offset: 0"));
        assert!(!kept.contains("DB::KafkaConsumer"));
    }

    #[test]
    fn drops_the_line_that_announces_a_trace_it_has_removed() {
        let raw = "Code: 27. DB::Exception: Cannot parse input: While executing Kafka. \
                   (CANNOT_PARSE_INPUT_ASSERTION_FAILED), Stack trace (when copying this \
                   message, always include the lines below):\n\
                   0. Poco::Exception::Exception(String const&, int) @ 0x1c0f2d3b";
        let kept = message_only(raw);
        assert!(kept.ends_with("(CANNOT_PARSE_INPUT_ASSERTION_FAILED)"));
        assert!(!kept.contains("Stack trace"));
    }

    #[test]
    fn leaves_an_exception_with_no_trace_alone() {
        assert_eq!(message_only("Connection refused"), "Connection refused");
        assert_eq!(message_only(""), "");
    }

    #[test]
    fn does_not_cut_at_a_decimal_inside_a_message() {
        // `1. ` at the start of a line is a stack frame; `0.5 ` is not, and a
        // rule that cut on any digit-dot would truncate a message about a rate.
        let kept = message_only("Rate fell to 0.5 per second\nand stayed there");
        assert_eq!(kept, "Rate fell to 0.5 per second and stayed there");
    }
}
