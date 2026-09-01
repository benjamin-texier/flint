//! Who this server has been working for.
//!
//! `diagnostics::queries` already ranks statements by what they cost, which
//! answers *what* is expensive. It cannot answer *who*, and that is usually the
//! more actionable half: a statement shape costing forty minutes a week is a
//! query to optimise, and the same forty minutes belonging to one service
//! account is a conversation with whoever owns that service.
//!
//! One `GROUP BY user` over `system.query_log`, and three things it is careful
//! about.
//!
//! ## An empty user is not a person
//!
//! ClickHouse writes rows into `query_log` for work nobody asked for
//! interactively — a materialized view's push, a distributed subquery arriving
//! from another node, a background flush. Those carry an empty `user`, and on the
//! first server this was pointed at the empty name was the *largest spender*:
//! 414 seconds against 84 for the only real account on the machine. Reported as
//! a user it would send somebody looking for a person who does not exist, so it
//! is reported as what it is — the server's own background work — and it keeps
//! its figures, because that time is real and somebody should see it.
//!
//! ## A share needs a whole
//!
//! "41 minutes" means nothing without the total. Every row carries its share of
//! the window's own cost, computed on the server so the two cannot be summed
//! differently by two callers.
//!
//! ## Flint is left out, and says so
//!
//! By the tag every internal statement carries, exactly as the other query-log
//! readings do. On a server where Flint could not set `log_comment` — a
//! `readonly=1` profile — the tag is absent and Flint is *in* the figures; that
//! is what `settings_refused` on the session is for, and the page says it.

use serde::{Deserialize, Serialize};

use super::diagnostics::excluding_flint;
use super::{Client, QueryOptions, Reach};
use crate::error::Result;

/// One account, and what the server did for it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Spender {
    /// The account as ClickHouse recorded it. Empty for the server's own
    /// background work — see `background`.
    pub user: String,
    /// True where `user` is empty: this row is a materialized view's push, a
    /// subquery from another node, a background flush. Not a person, and the
    /// caller must not name it as one.
    pub background: bool,
    pub statements: u64,
    /// Wall clock the server spent, in seconds.
    pub seconds: f64,
    /// That as a share of everything the window cost. Computed here so two
    /// callers cannot divide by two different totals.
    pub share: f64,
    pub read_bytes: u64,
    pub read_rows: u64,
    pub failed: u64,
    /// The table this account spent the most time on, and what that cost.
    ///
    /// Empty where the log names no table — a `SELECT 1`, a `SET`, a statement
    /// that failed before it was planned. The share is of *this account's* time,
    /// not of the server's: "most of what they do is on one table" is the
    /// sentence worth having.
    pub busiest_table: String,
    pub busiest_share: f64,
    /// When this account last ran anything.
    pub last_seen: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpendReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub window_days: u64,
    /// What the log can actually answer over, from its own oldest row. A ranking
    /// of who spent the week, over a log holding five hours, is a ranking of who
    /// was awake this morning.
    pub covered_days: f64,
    pub spenders: Vec<Spender>,
    /// Over every account, not only the listed ones.
    pub total_seconds: f64,
    pub total_statements: u64,
    pub accounts: u64,
    /// Whether Flint's own traffic could be excluded. False on a server that
    /// would not let Flint tag its statements, where these figures include Flint
    /// reading them.
    pub excludes_flint: bool,
}

/// Who the server worked for, most expensive first.
pub async fn spend(ch: &Client, days: u64, limit: u64) -> Result<SpendReport> {
    let days = days.clamp(1, 90);
    if let Some(why) = blocked(ch).await? {
        return Ok(SpendReport {
            available: false,
            reason: Some(why),
            window_days: days,
            covered_days: 0.0,
            spenders: Vec::new(),
            total_seconds: 0.0,
            total_statements: 0,
            accounts: 0,
            excludes_flint: false,
        });
    }

    let flint = excluding_flint(ch).await?;
    let excludes_flint = !flint.is_empty();

    /* One statement, with the window's own total riding inside it as a scalar
    subquery rather than fetched separately: two round trips over a busy log
    can straddle a flush, and a share computed against a total from another
    instant is a share that does not add up.

    The busiest table comes from `arrayJoin(tables)` per user, with each
    statement's whole duration attributed to every table it names. A join
    therefore contributes its full time to both sides, which overstates each
    — and it is the only apportionment the log supports: `query_log` records
    what a statement touched, never how its time divided between them. Said
    out loud on the field, because a reader comparing two figures deserves to
    know that one of them double-counts. */
    let sql = format!(
        "WITH whole AS ( \
             SELECT sum(query_duration_ms) AS ms, count() AS n, min(event_time) AS oldest, \
                    uniqExact(user) AS accounts \
             FROM system.query_log \
             WHERE event_time > now() - INTERVAL {days} DAY AND type = 'QueryFinish' {flint} \
         ), \
         /* A nested subquery rather than a second CTE, and not by taste: \
            ClickHouse substitutes a CTE by name, so `max(ms)` over a CTE whose \
            `ms` is itself `sum(...)` becomes `max(sum(...))` and is refused as \
            a nested aggregate. Inside a derived table the inner GROUP BY is \
            real and the outer one has an ordinary column to work on. */ \
         busiest AS ( \
             SELECT user, \
                    argMax(table, table_ms) AS table, \
                    max(table_ms)           AS ms \
             FROM ( \
                 SELECT user, \
                        arrayJoin(tables)       AS table, \
                        sum(query_duration_ms)  AS table_ms \
                 FROM system.query_log \
                 WHERE event_time > now() - INTERVAL {days} DAY \
                   AND type = 'QueryFinish' {flint} \
                   AND notEmpty(tables) \
                 GROUP BY user, table \
             ) \
             GROUP BY user \
         ) \
         SELECT q.user                                                 AS user, \
                /* `toBool`, because a comparison is a UInt8 and JSONEachRow \
                   writes it as 0/1 — which a `bool` field will not take. */ \
                toBool(q.user = '')                                    AS background, \
                toUInt64(count())                                      AS statements, \
                sum(q.query_duration_ms) / 1000                        AS seconds, \
                sum(q.query_duration_ms) / greatest(1, (SELECT ms FROM whole)) AS share, \
                toUInt64(sum(q.read_bytes))                            AS read_bytes, \
                toUInt64(sum(q.read_rows))                             AS read_rows, \
                toUInt64(countIf(q.exception_code != 0))               AS failed, \
                any(coalesce(b.table, ''))                             AS busiest_table, \
                any(coalesce(b.ms, 0)) / greatest(1, sum(q.query_duration_ms)) AS busiest_share, \
                toString(max(q.event_time))                            AS last_seen \
         FROM system.query_log AS q \
         LEFT JOIN busiest AS b ON b.user = q.user \
         WHERE q.event_time > now() - INTERVAL {days} DAY \
           AND q.type = 'QueryFinish' {flint} \
         GROUP BY q.user \
         ORDER BY seconds DESC \
         LIMIT {}",
        limit.clamp(1, 100)
    );

    let opts = QueryOptions {
        quote_64bit_integers: false,
        introspection: true,
        ..Default::default()
    };
    let spenders: Vec<Spender> = ch.rows_with(&sql, opts.clone()).await?;

    #[derive(Deserialize)]
    struct Whole {
        ms: f64,
        n: u64,
        covered_days: f64,
        accounts: u64,
    }
    let whole: Option<Whole> = ch
        .row_with(
            &format!(
                "SELECT sum(query_duration_ms)                          AS ms, \
                        toUInt64(count())                               AS n, \
                        toUInt64(uniqExact(user))                       AS accounts, \
                        least({days}.0, dateDiff('second', min(event_time), now()) / 86400.0) \
                                                                        AS covered_days \
                 FROM system.query_log \
                 WHERE event_time > now() - INTERVAL {days} DAY \
                   AND type = 'QueryFinish' {flint}"
            ),
            opts,
        )
        .await?;

    Ok(SpendReport {
        available: true,
        reason: None,
        window_days: days,
        covered_days: whole
            .as_ref()
            .map(|w| w.covered_days.max(0.0))
            .unwrap_or(0.0),
        total_seconds: whole.as_ref().map(|w| w.ms / 1000.0).unwrap_or(0.0),
        total_statements: whole.as_ref().map(|w| w.n).unwrap_or(0),
        accounts: whole.map(|w| w.accounts).unwrap_or(0),
        spenders,
        excludes_flint,
    })
}

async fn blocked(ch: &Client) -> Result<Option<String>> {
    Ok(match ch.reach("query_log").await? {
        Reach::Readable => None,
        Reach::Denied => Some("this user is not granted SELECT on system.query_log".to_string()),
        Reach::Absent | Reach::Unconfigured => {
            Some("system.query_log is not enabled on this server".to_string())
        }
    })
}
