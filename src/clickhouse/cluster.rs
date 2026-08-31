//! The cluster, seen from this node.
//!
//! Flint is one sidecar beside one server, and that is not a limitation here:
//! every table this module reads is answerable from any replica. `system.clusters`
//! is the topology as *this* server's configuration describes it,
//! `system.replication_queue` is the work this replica has left to apply, and
//! `system.distributed_ddl_queue` is the ledger every node in the ring shares.
//! So a per-server Flint can tell you the truth about the ring around it without
//! becoming a fleet console.
//!
//! Three shapes of unavailability, and they must not be conflated, because each
//! sends the reader somewhere different:
//!
//! - **A grant is missing** — `GRANT SELECT ON system.*` fixes it.
//! - **The table is not on this build** — an older ClickHouse; upgrading fixes
//!   it, and nothing else will.
//! - **There is no Keeper** — the table exists, the server is not in a cluster,
//!   and there is nothing to fix. A single-node deployment is a legitimate
//!   deployment, and telling its operator to upgrade or to grant something would
//!   be sending them after a problem they do not have.
//!
//! The third is [`super::Reach::Unconfigured`], which exists because this module
//! needed it: `system.distributed_ddl_queue` answers "There is no Zookeeper
//! configuration in server config" with a code — 139 — that Flint used to raise
//! as an error.

use serde::{Deserialize, Serialize};

use super::Client;
use crate::error::Result;

/// One entry in `system.clusters`: a place a query can be sent.
///
/// A row is a *configured* endpoint, not a live one. `is_active` and
/// `replication_lag` are recent additions and only mean anything where the
/// server fills them, so both are read through `col_or` and dropped rather than
/// guessed at.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub cluster: String,
    pub shard_num: u32,
    pub replica_num: u32,
    pub host_name: String,
    pub port: u16,
    /// Whether this row is the server Flint is talking to. The one node whose
    /// other pages are about this very machine.
    pub is_local: bool,
    /// Errors the *local* server has counted trying to reach this endpoint.
    ///
    /// It was the first thing this page looked at, on the reasoning that it
    /// would move when a node went away. Watched against a real failure it does
    /// not move at all: with one replica of a two-replica shard stopped, and
    /// both a read and a write pushed at it, this stayed **zero** throughout —
    /// while `estimated_recovery_time` went to 60 and counted down. Kept because
    /// another build may populate it, and shown only where it is not zero: a
    /// column that can never speak is a column nobody can read.
    pub errors_count: u64,
    /// Seconds before the local server will try this endpoint again.
    ///
    /// The one of the two that reports anything, and its name oversells it: it
    /// is ClickHouse's own back-off timer and not a prediction about the node.
    /// Measured counting down from 60 to 9 *while the stopped replica was
    /// already running again* — it does not know, and will not know until it
    /// tries.
    #[serde(default)]
    pub recovery_secs: u64,
    /// Null where the build does not report it, which is how "we do not know" is
    /// said — distinct from an active node, and from an inactive one.
    pub is_active: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Topology {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub nodes: Vec<Node>,
    /// True where the only thing configured is this machine talking to itself,
    /// which every default ClickHouse has. Said explicitly so the page can be
    /// honest that there is no cluster here rather than drawing one node and
    /// calling it a ring.
    pub single_node: bool,
}

/// The ring as this server's configuration describes it.
pub async fn topology(ch: &Client) -> Result<Topology> {
    if let Some(reason) = blocked(ch, "clusters").await? {
        return Ok(Topology {
            available: false,
            reason: Some(reason),
            nodes: Vec::new(),
            single_node: false,
        });
    }

    // Both are recent. An older server loses the figure rather than the page.
    let is_active = ch.col_or("clusters", "is_active", "NULL").await?;
    let errors = ch.col_or("clusters", "errors_count", "0").await?;
    let recovery = ch
        .col_or("clusters", "estimated_recovery_time", "0")
        .await?;

    let sql = format!(
        "SELECT cluster                            AS cluster, \
                toUInt32(shard_num)                AS shard_num, \
                toUInt32(replica_num)              AS replica_num, \
                host_name                          AS host_name, \
                toUInt16(port)                     AS port, \
                CAST(is_local != 0 AS Bool)        AS is_local, \
                toUInt64({errors})                 AS errors_count, \
                toUInt64({recovery})               AS recovery_secs, \
                CAST({is_active} AS Nullable(Bool)) AS is_active \
         FROM system.clusters \
         ORDER BY cluster, shard_num, replica_num \
         LIMIT 2000"
    );

    let nodes: Vec<Node> = ch.rows(&sql).await?;
    // One row, pointing at this machine: the default configuration of a server
    // that is not in a cluster.
    let single_node = nodes.len() <= 1 && nodes.iter().all(|n| n.is_local);
    Ok(Topology {
        available: true,
        reason: None,
        nodes,
        single_node,
    })
}

/// One entry a replica has fetched and not yet applied.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueEntry {
    pub database: String,
    pub table: String,
    /// `GET_PART`, `MERGE_PARTS`, `MUTATE_PART`… what the entry asks for.
    pub kind: String,
    pub created_time: String,
    /// How many times the replica has tried and failed. The number that turns a
    /// queue into a stuck queue.
    pub num_tries: u32,
    pub last_exception: String,
    /// Whether the entry is being worked on right now.
    pub is_currently_executing: bool,
    pub postpone_reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueueReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub entries: Vec<QueueEntry>,
    /// Everything in the queue, not just the rows returned — a queue of nine
    /// thousand entries shown as forty is a queue nobody can reason about.
    pub total: u64,
}

/// What this replica has left to apply, worst first.
///
/// Ordered by failures rather than by age: an entry that has been retried two
/// hundred times is the story, and it can easily be newer than the ones behind
/// it.
pub async fn replication_queue(ch: &Client, limit: u64) -> Result<QueueReport> {
    if let Some(reason) = blocked(ch, "replication_queue").await? {
        return Ok(QueueReport {
            available: false,
            reason: Some(reason),
            entries: Vec::new(),
            total: 0,
        });
    }

    let sql = format!(
        "SELECT database                                  AS database, \
                table                                     AS table, \
                type                                      AS kind, \
                toString(create_time)                     AS created_time, \
                toUInt32(num_tries)                       AS num_tries, \
                last_exception                            AS last_exception, \
                CAST(is_currently_executing != 0 AS Bool) AS is_currently_executing, \
                postpone_reason                           AS postpone_reason \
         FROM system.replication_queue \
         ORDER BY num_tries DESC, create_time ASC \
         LIMIT {}",
        limit.clamp(1, 500)
    );
    let entries: Vec<QueueEntry> = ch.rows(&sql).await?;

    #[derive(Deserialize)]
    struct Count {
        n: u64,
    }
    let total = ch
        .row::<Count>("SELECT count() AS n FROM system.replication_queue")
        .await?
        .map(|c| c.n)
        .unwrap_or(entries.len() as u64);

    Ok(QueueReport {
        available: true,
        reason: None,
        entries,
        total,
    })
}

/// One `ON CLUSTER` statement, and how it went on each host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DdlEntry {
    pub entry: String,
    pub host: String,
    pub query: String,
    /// `Finished`, `Active`, or whatever this build calls it.
    pub status: String,
    pub exception_code: i32,
    pub exception_text: String,
    pub query_create_time: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DdlReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub entries: Vec<DdlEntry>,
}

/// The distributed DDL ledger, newest first.
///
/// The failure this exists to expose: a statement that succeeded on three nodes
/// out of four. There is one row per host per statement, and the three shapes a
/// host row takes were measured on a two-node ring rather than assumed:
///
/// - `Finished` with code `0` — it ran.
/// - `Finished` with a code — it **failed**. The status is about the queue entry
///   being done with, not about the statement working, so a page that reads the
///   status alone reports a success on the node where the table was never
///   created.
/// - `Inactive` with nulls in both exception columns — the node has not picked
///   it up. It will when it comes back; nothing has gone wrong yet.
pub async fn ddl_queue(ch: &Client, limit: u64) -> Result<DdlReport> {
    if let Some(reason) = blocked(ch, "distributed_ddl_queue").await? {
        return Ok(DdlReport {
            available: false,
            reason: Some(reason),
            entries: Vec::new(),
        });
    }

    // `exception_code` is `Int64` on some builds and absent on others; the text
    // is newer still. Both are `Nullable` where they exist, and the null is not
    // an edge case: a host that has not picked the statement up yet carries
    // `Inactive` with *null* in both columns, which decoded straight into `i32`
    // took the whole section down with `invalid type: null` — on exactly the
    // server state the section exists to describe. Measured, not guessed.
    let code = ch
        .col_or("distributed_ddl_queue", "exception_code", "0")
        .await?;
    let text = ch
        .col_or("distributed_ddl_queue", "exception_text", "''")
        .await?;

    // The limit counts *statements*, not rows. There is one row per host, so
    // limiting rows cuts a statement in half — and half a statement folds into a
    // confident lie: "ran on all 1 host" about a statement that ran on one of
    // four. The entries are named `query-0000000005`, zero-padded, so their
    // order is their order in time.
    let sql = format!(
        "SELECT entry                              AS entry, \
                host                               AS host, \
                query                              AS query, \
                status                             AS status, \
                toInt32(ifNull({code}, 0))         AS exception_code, \
                toString(ifNull({text}, ''))       AS exception_text, \
                toString(query_create_time)        AS query_create_time \
         FROM system.distributed_ddl_queue \
         WHERE entry IN ( \
             SELECT entry FROM system.distributed_ddl_queue \
             GROUP BY entry ORDER BY max(query_create_time) DESC LIMIT {} \
         ) \
         ORDER BY query_create_time DESC, entry DESC, host",
        limit.clamp(1, 500)
    );
    let entries: Vec<DdlEntry> = ch.rows(&sql).await?;
    Ok(DdlReport {
        available: true,
        reason: None,
        entries,
    })
}

/// Why a cluster table cannot be read, in the words the reader needs.
///
/// The same three-way answer the diagnostics use, kept here rather than shared
/// because the sentences differ: "this server is not in a cluster" is the common
/// case for these tables and the rare case for everything else.
async fn blocked(ch: &Client, table: &str) -> Result<Option<String>> {
    Ok(match ch.reach(table).await? {
        super::Reach::Readable => None,
        super::Reach::Denied => Some(format!("this user is not granted SELECT on system.{table}")),
        super::Reach::Absent => Some(format!(
            "this ClickHouse has no system.{table} — it arrived in a later version"
        )),
        super::Reach::Unconfigured => {
            Some("this server has no Keeper configured, so it is not part of a cluster".to_string())
        }
    })
}

// ── Keeper ─────────────────────────────────────────────────────────────────

/// The session this server holds with Keeper.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    /// The name of the ensemble in the server's own configuration.
    pub name: String,
    pub host: String,
    pub port: u16,
    /// How long this session has been up. A session that keeps being young is a
    /// session that keeps being lost, which is the shape of a flapping ensemble
    /// and is invisible in a single reading.
    pub uptime_secs: u64,
    pub expired: bool,
    pub session_timeout_ms: u64,
}

/// One node of the ensemble, as this server sees it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeeperNode {
    pub host: String,
    pub port: u16,
    pub connected: bool,
    /// A Keeper that has gone read-only accepts no writes, so nothing
    /// replicated can be written anywhere. It is the loudest single fact on
    /// this page.
    pub readonly: bool,
    pub version: String,
    /// `leader`, `follower`, `observer`, or `standalone`.
    pub state: String,
    pub avg_latency: u64,
    pub max_latency: u64,
    pub followers: u64,
    pub synced_followers: u64,
    pub pending_syncs: u64,
    pub znodes: u64,
    pub watches: u64,
    pub ephemerals: u64,
}

/// One connect or disconnect.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeeperEvent {
    pub at: String,
    /// `Connected` or `Disconnected`.
    pub kind: String,
    pub host: String,
    /// Why, where the server says. Empty on a plain connect.
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeeperReport {
    /// Absent where this server holds no session — which is not an error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<Session>,
    pub nodes: super::Section<KeeperNode>,
    pub history: super::Section<KeeperEvent>,
    /// Why there is nothing to show, when there is nothing to show. Says "no
    /// Keeper is configured" rather than "your ClickHouse is too old", because
    /// the two are told apart here and sending somebody to upgrade a server
    /// that did not need upgrading is the failure this exists to avoid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub absent: Option<String>,
    /// What is worth saying out loud, in the order it is worth saying. Computed
    /// here rather than in the browser because these are judgements over several
    /// fields at once, and a judgement is the part worth a test.
    pub verdicts: Vec<String>,
}

/// Whether this server talks to a Keeper at all, and how to say so if not.
///
/// The disambiguation is the point, and it took looking at two real servers to
/// find. A ClickHouse with no Keeper in its configuration **does not have**
/// `system.zookeeper`, `system.zookeeper_connection`, `system.zookeeper_info` or
/// `system.zookeeper_watches` — the tables are created conditionally, so asking
/// for them answers `UNKNOWN_TABLE`, which is exactly what an old version would
/// answer too.
///
/// `system.zookeeper_connection_log` is the tell: it exists on both, empty on
/// the one with no Keeper. So a server that has the log and not the connection
/// is new enough and simply has nothing to connect to, and that is a
/// configuration sentence rather than an upgrade instruction.
async fn keeper_absence(ch: &Client) -> Result<Option<String>> {
    let has_connection = matches!(
        ch.reach("zookeeper_connection").await?,
        super::Reach::Readable
    );
    if has_connection {
        return Ok(None);
    }
    let has_log = matches!(
        ch.reach("zookeeper_connection_log").await?,
        super::Reach::Readable
    );
    Ok(Some(if has_log {
        // No backticks: this is a plain string on its way to a paragraph, not
        // markdown, and the last one to carry them printed them.
        "this server has no Keeper configured, so it holds no session and nothing on it is \
         replicated. system.zookeeper_connection is not missing — ClickHouse does not create it \
         where there is no ensemble to describe."
            .to_string()
    } else {
        "this ClickHouse has no system.zookeeper_connection, and no \
         system.zookeeper_connection_log either — it is older than both."
            .to_string()
    }))
}

pub async fn keeper(ch: &Client, limit: u64) -> Result<KeeperReport> {
    if let Some(absent) = keeper_absence(ch).await? {
        return Ok(KeeperReport {
            session: None,
            nodes: super::Section::of(Vec::new()),
            history: super::Section::of(Vec::new()),
            absent: Some(absent),
            verdicts: Vec::new(),
        });
    }

    let session: Option<Session> = ch
        .row(
            "SELECT name                                        AS name, \
                    host                                        AS host, \
                    port                                        AS port, \
                    session_uptime_elapsed_seconds              AS uptime_secs, \
                    CAST(is_expired != 0 AS Bool)               AS expired, \
                    session_timeout_ms                          AS session_timeout_ms \
             FROM system.zookeeper_connection LIMIT 1",
        )
        .await?;

    // Its own read and its own grant: a role that can see the session need not
    // be able to see the ensemble, and losing one should not cost the other.
    let nodes = match ch
        .rows::<KeeperNode>(
            "SELECT host                                  AS host, \
                    port                                  AS port, \
                    CAST(is_connected != 0 AS Bool)       AS connected, \
                    CAST(is_readonly != 0 AS Bool)        AS readonly, \
                    version                               AS version, \
                    toString(server_state)                AS state, \
                    toUInt64(avg_latency)                 AS avg_latency, \
                    toUInt64(max_latency)                 AS max_latency, \
                    toUInt64(followers)                   AS followers, \
                    toUInt64(synced_followers)            AS synced_followers, \
                    toUInt64(pending_syncs)               AS pending_syncs, \
                    toUInt64(znode_count)                 AS znodes, \
                    toUInt64(watch_count)                 AS watches, \
                    toUInt64(ephemerals_count)            AS ephemerals \
             FROM system.zookeeper_info",
        )
        .await
    {
        Ok(items) => super::Section::of(items),
        Err(e) => {
            tracing::debug!("zookeeper_info unavailable: {e}");
            super::Section::blocked(
                "system.zookeeper_info could not be read, so the ensemble's own state is not \
                 shown — the session above is still this server's."
                    .to_string(),
            )
        }
    };

    // Newest first. A session that keeps being young is a session that keeps
    // being lost, and one reading cannot show that; this can.
    let history = match ch
        .rows::<KeeperEvent>(&format!(
            "SELECT toString(event_time)     AS at, \
                    toString(type)           AS kind, \
                    host                     AS host, \
                    toString(reason)         AS reason \
             FROM system.zookeeper_connection_log \
             ORDER BY event_time DESC LIMIT {}",
            limit.clamp(1, 500)
        ))
        .await
    {
        Ok(items) => super::Section::of(items),
        Err(e) => {
            tracing::debug!("zookeeper_connection_log unavailable: {e}");
            super::Section::blocked("system.zookeeper_connection_log could not be read".into())
        }
    };

    Ok(KeeperReport {
        verdicts: keeper_verdicts(session.as_ref(), &nodes.items),
        session,
        nodes,
        history,
        absent: None,
    })
}

/// What is worth saying out loud about an ensemble.
///
/// Pure, and separate from the reading, because these are judgements rather than
/// facts and they are the part worth testing. Each one is a sentence somebody
/// can act on; a list of numbers with no verdict is a list nobody reads twice.
fn keeper_verdicts(session: Option<&Session>, nodes: &[KeeperNode]) -> Vec<String> {
    let mut out = Vec::new();

    if let Some(s) = session {
        if s.expired {
            out.push(
                "This server's Keeper session has expired. Nothing replicated can be written \
                 until it comes back."
                    .to_string(),
            );
        } else if s.uptime_secs < 60 {
            // The shape of a flapping ensemble, and invisible in one reading of
            // a table that only ever shows the current session.
            out.push(format!(
                "The session is {} seconds old. If that keeps being true, the connection is \
                 being lost and remade — check the history below rather than this figure.",
                s.uptime_secs
            ));
        }
    }

    if let Some(ro) = nodes.iter().find(|n| n.readonly) {
        out.push(format!(
            "Keeper at {} is read-only, so no replicated table anywhere can be written to.",
            ro.host
        ));
    }
    for n in nodes.iter().filter(|n| !n.connected) {
        out.push(format!(
            "Keeper at {} is not answering this server.",
            n.host
        ));
    }

    // A single-node ensemble is a legitimate development setup and a hazard in
    // production, and the difference is not something Flint can know. So it is
    // stated rather than judged.
    if nodes.len() == 1 && nodes[0].state == "standalone" {
        out.push(
            "One Keeper node, running standalone. There is no quorum to lose, which also means \
             there is no redundancy: losing it stops every replicated write on this server."
                .to_string(),
        );
    }

    for n in nodes.iter().filter(|n| n.synced_followers < n.followers) {
        out.push(format!(
            "Keeper at {} has {} followers and {} of them synced.",
            n.host, n.followers, n.synced_followers
        ));
    }
    for n in nodes.iter().filter(|n| n.pending_syncs > 0) {
        out.push(format!(
            "Keeper at {} has {} syncs pending.",
            n.host, n.pending_syncs
        ));
    }

    out
}

#[cfg(test)]
mod keeper_tests {
    use super::*;

    fn node(over: impl Fn(&mut KeeperNode)) -> KeeperNode {
        let mut n = KeeperNode {
            host: "keeper".into(),
            port: 9181,
            connected: true,
            readonly: false,
            version: "v26".into(),
            state: "leader".into(),
            avg_latency: 3,
            max_latency: 10,
            followers: 2,
            synced_followers: 2,
            pending_syncs: 0,
            znodes: 22,
            watches: 2,
            ephemerals: 5,
        };
        over(&mut n);
        n
    }

    fn session(over: impl Fn(&mut Session)) -> Session {
        let mut s = Session {
            name: "default".into(),
            host: "keeper".into(),
            port: 9181,
            uptime_secs: 3600,
            expired: false,
            session_timeout_ms: 30_000,
        };
        over(&mut s);
        s
    }

    #[test]
    fn a_healthy_ensemble_says_nothing() {
        let s = session(|_| {});
        assert!(keeper_verdicts(Some(&s), &[node(|_| {})]).is_empty());
    }

    #[test]
    fn a_read_only_keeper_is_the_loudest_fact() {
        let out = keeper_verdicts(None, &[node(|n| n.readonly = true)]);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("read-only"));
        // Because that is what it means, and it is not obvious from the flag.
        assert!(out[0].contains("no replicated table anywhere"));
    }

    #[test]
    fn a_young_session_points_at_the_history_rather_than_at_itself() {
        // The shape of a flapping ensemble, and invisible in one reading of a
        // table that only ever holds the current session.
        let out = keeper_verdicts(Some(&session(|s| s.uptime_secs = 4)), &[]);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("check the history"));
    }

    #[test]
    fn an_expired_session_replaces_the_young_one_rather_than_joining_it() {
        // An expired session is also a young one, and saying both would be two
        // sentences about one fact.
        let out = keeper_verdicts(
            Some(&session(|s| {
                s.expired = true;
                s.uptime_secs = 2;
            })),
            &[],
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("expired"));
    }

    #[test]
    fn a_lone_standalone_keeper_is_stated_rather_than_judged() {
        // Legitimate in development, a hazard in production, and Flint cannot
        // know which this is.
        let out = keeper_verdicts(
            None,
            &[node(|n| {
                n.state = "standalone".into();
                n.followers = 0;
                n.synced_followers = 0;
            })],
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("no redundancy"));
    }

    #[test]
    fn two_standalone_nodes_are_not_a_lone_one() {
        let out = keeper_verdicts(
            None,
            &[
                node(|n| {
                    n.state = "standalone".into();
                    n.followers = 0;
                    n.synced_followers = 0;
                }),
                node(|n| {
                    n.host = "keeper2".into();
                    n.state = "standalone".into();
                    n.followers = 0;
                    n.synced_followers = 0;
                }),
            ],
        );
        assert!(out.is_empty());
    }

    #[test]
    fn an_unsynced_follower_is_counted_not_just_flagged() {
        let out = keeper_verdicts(None, &[node(|n| n.synced_followers = 1)]);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("2 followers and 1 of them synced"));
    }
}
