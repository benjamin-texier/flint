//! Which tables are read *together*.
//!
//! The schema diagram draws the dependencies somebody declared: a materialized
//! view and its target, a dictionary and its source. That is a real graph and it
//! is permanent. It is also, on most servers, not the graph the work actually
//! runs on — the tables that always turn up in the same statement, joined a
//! thousand times a day, are related as strongly as anything in the DDL and
//! nothing in the schema records it.
//!
//! `system.query_log.tables` does record it, one row at a time. Every finished
//! `SELECT` names the tables it touched; two tables in the same row were read
//! together, and counting those pairs over a week gives the coupling the schema
//! never wrote down. The interesting cells are the ones with a large count and
//! no declared edge behind them: that is a join somebody performs constantly
//! that nothing in the database knows about.
//!
//! Three honesty rules shape it. The log names **views as well as their
//! sources** — reading a view records the view and everything it reads — so a
//! good half of the pairs on a healthy server are simply somebody's view
//! definition seen from below. Those are exactly the pairs the schema *does*
//! declare, which is why the drawing marks declared pairs rather than hiding
//! them: the eye needs both to see which is which. **Wide statements are left
//! out and counted**: a query touching thirty tables would contribute 435 pairs
//! on its own and drown a week of ordinary work in one report. And the window is
//! stated everywhere, because a count of co-occurrences with no period attached
//! is a number nobody can argue with.

use serde::{Deserialize, Serialize};

use super::diagnostics::excluding_flint;
use super::{Client, QueryOptions, Reach};
use crate::error::Result;

/// One table, as the log sees it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AffinityNode {
    /// `database.table`, the form the log itself uses.
    pub qualified: String,
    /// Statements that touched it in the window.
    pub queries: u64,
    /// People, roles or services that ran them — a table read constantly by one
    /// service and one read by nine different users are different objects.
    pub readers: u64,
}

/// Two tables and how often a statement named both.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AffinityPair {
    pub a: String,
    pub b: String,
    pub queries: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AffinityReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub nodes: Vec<AffinityNode>,
    pub pairs: Vec<AffinityPair>,
    /// The window, in days. Printed wherever a count is.
    pub days: u32,
    /// Statements that touched this database at all.
    pub considered: u64,
    /// Of those, the ones naming a single table — they make no pair, and a
    /// matrix that looked empty next to a large `considered` would be a puzzle
    /// rather than an answer.
    pub single: u64,
    /// And the ones left out for naming too many tables to be one join.
    pub wide: u64,
    /// The widest statement counted, so `wide` has a scale.
    pub max_tables: u64,
}

/// A statement naming more tables than this is not a join anybody wrote by
/// hand; it is a dashboard refresh or a `UNION` of everything, and its pairs say
/// nothing about coupling.
///
/// The arithmetic is why the cap is low: a statement over *n* tables contributes
/// n(n-1)/2 pairs, so one touching thirty would add 435 of them and bury a week
/// of ordinary work under a single dashboard.
///
/// Measured against a real server rather than argued: a three-table join
/// produced exactly three pairs, one each, and a ten-table statement was counted
/// `wide`, reported through `max_tables`, and contributed **no** pairs — the
/// forty-five it would otherwise have added are the whole reason this constant
/// exists.
const MAX_TABLES_PER_QUERY: u64 = 8;
const DEFAULT_NODES: u64 = 30;
const MAX_NODES: u64 = 80;
const MAX_PAIRS: u64 = 600;

/// Tables read together, over a window.
pub async fn co_access(
    ch: &Client,
    database: &str,
    days: u32,
    node_limit: Option<u64>,
) -> Result<AffinityReport> {
    let days = days.clamp(1, 90);
    if let Some(why) = blocked(ch).await? {
        return Ok(empty(days, Some(why)));
    }
    // `tables` is the whole report and `query_kind` decides what counts as a
    // read. An older server without either gets a sentence naming the column
    // rather than an empty picture.
    let have = ch.system_columns("query_log").await?;
    let lacking: Vec<&str> = ["tables", "query_kind"]
        .into_iter()
        .filter(|c| !have.is_empty() && !have.contains(*c))
        .collect();
    if !lacking.is_empty() {
        return Ok(empty(
            days,
            Some(format!(
                "this ClickHouse version's system.query_log has no {}",
                lacking.join(" and ")
            )),
        ));
    }

    let limit = node_limit.unwrap_or(DEFAULT_NODES).clamp(2, MAX_NODES);
    let ours = excluding_flint(ch).await?;
    let opts = || QueryOptions {
        params: vec![("db".into(), database.to_string())],
        ..QueryOptions::internal()
    };

    /// The statements this report is about: finished reads, in the window, that
    /// named at least one table of this database — with Flint's own
    /// introspection and ClickHouse's own tables filtered out of the list, since
    /// neither is anybody's query about their data.
    fn qualifying(days: u32, ours: &str) -> String {
        format!(
            "SELECT user AS user, \
                    arraySort(arrayDistinct(arrayFilter(x -> \
                        notEmpty(x) \
                        AND x NOT LIKE 'system.%' \
                        AND x NOT LIKE '\\\\_table\\\\_function.%', tables))) AS t \
             FROM system.query_log \
             WHERE type = 'QueryFinish' \
               AND query_kind = 'Select' \
               AND event_time > now() - INTERVAL {days} DAY {ours}\
               AND arrayExists(x -> startsWith(x, concat({{db:String}}, '.')), tables)"
        )
    }
    let source = qualifying(days, &ours);

    #[derive(Deserialize)]
    struct Shape {
        considered: u64,
        single: u64,
        wide: u64,
        max_tables: u64,
    }
    let shape: Shape = ch
        .row_with::<Shape>(
            &format!(
                "SELECT toUInt64(count())                                AS considered, \
                        toUInt64(countIf(length(t) < 2))                 AS single, \
                        toUInt64(countIf(length(t) > {MAX_TABLES_PER_QUERY})) AS wide, \
                        toUInt64(max(length(t)))                         AS max_tables \
                 FROM ({source})"
            ),
            opts(),
        )
        .await?
        .unwrap_or(Shape {
            considered: 0,
            single: 0,
            wide: 0,
            max_tables: 0,
        });

    let nodes: Vec<AffinityNode> = ch
        .rows_with(
            &format!(
                "SELECT t                              AS qualified, \
                        toUInt64(count())              AS queries, \
                        toUInt64(uniqExact(user))      AS readers \
                 FROM ({source}) \
                 ARRAY JOIN t AS t \
                 GROUP BY t \
                 ORDER BY queries DESC, qualified ASC \
                 LIMIT {limit}"
            ),
            opts(),
        )
        .await?;

    // Pairs. The inner `arrayJoin` gives one row per table of a statement, and
    // the outer `ARRAY JOIN` pairs each of those with every table of the same
    // statement; `a < b` keeps one of each unordered pair and drops the
    // self-pair, which is a table with itself and not a fact about anything.
    let pairs: Vec<AffinityPair> = ch
        .rows_with(
            &format!(
                "SELECT a                              AS a, \
                        b                              AS b, \
                        toUInt64(count())              AS queries \
                 FROM ( \
                     SELECT t, arrayJoin(t) AS a \
                     FROM ({source}) \
                     WHERE length(t) BETWEEN 2 AND {MAX_TABLES_PER_QUERY} \
                 ) \
                 ARRAY JOIN t AS b \
                 WHERE a < b \
                 GROUP BY a, b \
                 ORDER BY queries DESC, a ASC, b ASC \
                 LIMIT {MAX_PAIRS}"
            ),
            opts(),
        )
        .await?;

    Ok(AffinityReport {
        available: true,
        reason: None,
        nodes,
        pairs,
        days,
        considered: shape.considered,
        single: shape.single,
        wide: shape.wide,
        max_tables: shape.max_tables,
    })
}

fn empty(days: u32, reason: Option<String>) -> AffinityReport {
    AffinityReport {
        available: false,
        reason,
        nodes: Vec::new(),
        pairs: Vec::new(),
        days,
        considered: 0,
        single: 0,
        wide: 0,
        max_tables: 0,
    }
}

async fn blocked(ch: &Client) -> Result<Option<String>> {
    Ok(match ch.reach("query_log").await? {
        Reach::Readable => None,
        Reach::Denied => Some("this user is not granted SELECT on system.query_log".to_string()),
        Reach::Absent => Some("this ClickHouse has no system.query_log".to_string()),
        Reach::Unconfigured => Some("system.query_log is not enabled on this server".to_string()),
    })
}
