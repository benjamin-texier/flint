//! Are the materialized views actually flowing?
//!
//! ClickHouse answers this in three places and none of them alone is enough.
//!
//! `system.query_views_log` records each view execution an insert triggered —
//! rows written, duration, exception. That is the everyday health of a classic
//! view.
//!
//! It is silent about the most common way one breaks. Drop a view's target
//! table and the *insert* fails with "Target table doesn't exist" before the
//! view runs at all, so nothing is logged: the view looks idle, the pipeline is
//! dead, and the only evidence is a failing insert somewhere else. So the target
//! is checked structurally as well.
//!
//! And a refreshable view has none of that shape: it runs on its own schedule,
//! and `system.view_refreshes` holds its real state — last success, next run,
//! exception, retry count. It is also the only kind that can be told to run
//! again, which is why "force it" means two different things here.

use serde::{Deserialize, Serialize};

use super::{Client, Reach};
use crate::error::{Error, Result};

const USER_DATABASES: &str =
    "database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')";

fn window(days: u64) -> u64 {
    days.clamp(1, 90)
}

fn lenient_f64<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(0.0))
}

#[derive(Debug, Clone, Serialize)]
pub struct View {
    pub database: String,
    pub name: String,
    /// Where its rows land. Empty for a refreshable view, which owns its own
    /// storage, and for one whose target Flint could not read out of the DDL.
    pub target: String,
    /// False only when a target was named and is not there — the breakage the
    /// view log cannot see.
    pub target_exists: bool,
    pub refreshable: bool,
    /// The SELECT, for a reader deciding what a backfill would do.
    pub definition: String,

    /// The target as it stands: how much is in it, and when it last changed.
    pub target_rows: u64,
    pub target_bytes: u64,
    pub last_write: String,

    /// From `system.query_views_log`, over the window.
    pub runs: u64,
    pub failures: u64,
    pub written_rows: u64,
    pub avg_ms: f64,
    pub last_run: String,
    pub last_error: String,

    /// From `system.view_refreshes`, for a refreshable view.
    pub refresh_status: String,
    pub last_refresh: String,
    pub last_success: String,
    pub next_refresh: String,
    pub refresh_exception: String,
    pub retry: u64,
    pub progress: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PipelineReport {
    pub views: Vec<View>,
    pub window_days: u64,
    /// False when `system.query_views_log` could not be read, so a view with no
    /// runs means "we cannot tell" rather than "nothing happened".
    pub log_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_reason: Option<String>,
    /// Whether this server has refreshable views at all — they arrived in 23.12,
    /// and a missing table is a version fact rather than a fault.
    pub refreshes_available: bool,
}

#[derive(Deserialize)]
struct Definition {
    database: String,
    name: String,
    create_query: String,
    definition: String,
}

#[derive(Deserialize)]
struct Storage {
    qualified: String,
    rows: u64,
    bytes: u64,
    written: String,
}

#[derive(Deserialize)]
struct LogRow {
    view: String,
    runs: u64,
    failures: u64,
    written_rows: u64,
    #[serde(deserialize_with = "lenient_f64")]
    avg_ms: f64,
    last_run: String,
    last_error: String,
}

#[derive(Deserialize)]
struct RefreshRow {
    database: String,
    view: String,
    status: String,
    last_refresh: String,
    last_success: String,
    next_refresh: String,
    exception: String,
    retry: u64,
    #[serde(deserialize_with = "lenient_f64")]
    progress: f64,
}

pub async fn pipelines(ch: &Client, days: u64) -> Result<PipelineReport> {
    let days = window(days);

    // The definitions. `as_select` is the SELECT alone; the full DDL is what
    // carries `TO target` and `REFRESH`.
    let definitions: Vec<Definition> = ch
        .rows(&format!(
            "SELECT database           AS database, \
                    name               AS name, \
                    create_table_query AS create_query, \
                    as_select          AS definition \
             FROM system.tables \
             WHERE engine = 'MaterializedView' AND {USER_DATABASES} \
             ORDER BY database, name \
             LIMIT 2000"
        ))
        .await?;
    if definitions.is_empty() {
        return Ok(PipelineReport {
            views: Vec::new(),
            window_days: days,
            log_available: true,
            log_reason: None,
            refreshes_available: ch.reach("view_refreshes").await? == Reach::Readable,
        });
    }

    // Every table there is, so a named target can be checked for existence.
    #[derive(Deserialize)]
    struct Name {
        qualified: String,
    }
    let existing: std::collections::HashSet<String> = ch
        .rows::<Name>("SELECT concat(database, '.', name) AS qualified FROM system.tables")
        .await?
        .into_iter()
        .map(|n| n.qualified)
        .collect();

    // What each target holds now. Denied is not fatal: the sizes go missing,
    // the health does not.
    let storage: Vec<Storage> = match ch
        .rows(&format!(
            "SELECT concat(database, '.', table)     AS qualified, \
                    sum(rows)                        AS rows, \
                    sum(bytes_on_disk)               AS bytes, \
                    toString(max(modification_time)) AS written \
             FROM system.parts \
             WHERE active AND {USER_DATABASES} \
             GROUP BY database, table"
        ))
        .await
    {
        Ok(rows) => rows,
        Err(Error::ClickHouse { code: 497, .. } | Error::ClickHouse { code: 164, .. }) => {
            Vec::new()
        }
        Err(e) => return Err(e),
    };

    let (log, log_available, log_reason) = view_log(ch, days).await?;
    let refreshes = refreshes(ch).await?;
    let refreshes_available = refreshes.is_some();
    let refreshes = refreshes.unwrap_or_default();

    let views = definitions
        .into_iter()
        .map(|d| {
            let qualified = format!("{}.{}", d.database, d.name);
            let refresh = refreshes
                .iter()
                .find(|r| r.database == d.database && r.view == d.name);
            // `REFRESH` appears in the DDL between the name and the schema; a
            // view listed in `view_refreshes` is one whatever the text says.
            let refreshable = refresh.is_some() || d.create_query.contains(" REFRESH ");
            let target = super::graph::target_of(&d.create_query, &d.database).unwrap_or_default();
            let held = storage.iter().find(|s| {
                s.qualified == target
                    // A refreshable view owns its storage under its own name.
                    || (target.is_empty() && s.qualified == qualified)
            });
            let logged = log.iter().find(|l| l.view == qualified);

            View {
                database: d.database,
                name: d.name,
                target_exists: target.is_empty() || existing.contains(&target),
                target,
                refreshable,
                definition: d.definition,
                target_rows: held.map(|s| s.rows).unwrap_or_default(),
                target_bytes: held.map(|s| s.bytes).unwrap_or_default(),
                last_write: held.map(|s| s.written.clone()).unwrap_or_default(),
                runs: logged.map(|l| l.runs).unwrap_or_default(),
                failures: logged.map(|l| l.failures).unwrap_or_default(),
                written_rows: logged.map(|l| l.written_rows).unwrap_or_default(),
                avg_ms: logged.map(|l| l.avg_ms).unwrap_or_default(),
                last_run: logged.map(|l| l.last_run.clone()).unwrap_or_default(),
                last_error: logged.map(|l| l.last_error.clone()).unwrap_or_default(),
                refresh_status: refresh.map(|r| r.status.clone()).unwrap_or_default(),
                last_refresh: refresh.map(|r| r.last_refresh.clone()).unwrap_or_default(),
                last_success: refresh.map(|r| r.last_success.clone()).unwrap_or_default(),
                next_refresh: refresh.map(|r| r.next_refresh.clone()).unwrap_or_default(),
                refresh_exception: refresh.map(|r| r.exception.clone()).unwrap_or_default(),
                retry: refresh.map(|r| r.retry).unwrap_or_default(),
                progress: refresh.map(|r| r.progress).unwrap_or_default(),
            }
        })
        .collect();

    Ok(PipelineReport {
        views,
        window_days: days,
        log_available,
        log_reason,
        refreshes_available,
    })
}

async fn view_log(ch: &Client, days: u64) -> Result<(Vec<LogRow>, bool, Option<String>)> {
    let reason = match ch.reach("query_views_log").await? {
        Reach::Readable => None,
        Reach::Denied => Some("this user is not granted SELECT on system.query_views_log".into()),
        // No Keeper is not a thing the view log depends on; folded in because
        // "not enabled" remains the useful sentence if it ever appears.
        Reach::Absent | Reach::Unconfigured => Some(
            "system.query_views_log is not enabled on this server, so per-view history is \
             unavailable"
                .to_string(),
        ),
    };
    if let Some(reason) = reason {
        return Ok((Vec::new(), false, Some(reason)));
    }

    let sql = format!(
        "SELECT view_name                       AS view, \
                count()                         AS runs, \
                countIf(exception_code != 0)    AS failures, \
                sum(written_rows)               AS written_rows, \
                round(avg(view_duration_ms), 1) AS avg_ms, \
                toString(max(event_time))       AS last_run, \
                argMax(exception, event_time)   AS last_error \
         FROM system.query_views_log \
         WHERE event_time > now() - INTERVAL {days} DAY \
           AND status != 'QueryStart' \
         GROUP BY view_name \
         LIMIT 2000"
    );
    Ok((ch.rows(&sql).await?, true, None))
}

/// `None` when this server has no refreshable views at all.
async fn refreshes(ch: &Client) -> Result<Option<Vec<RefreshRow>>> {
    if ch.reach("view_refreshes").await? != Reach::Readable {
        return Ok(None);
    }
    let sql = "SELECT database                    AS database, \
                      view                        AS view, \
                      toString(status)            AS status, \
                      toString(last_refresh_time) AS last_refresh, \
                      toString(last_success_time) AS last_success, \
                      toString(next_refresh_time) AS next_refresh, \
                      exception                   AS exception, \
                      retry                       AS retry, \
                      round(progress, 3)          AS progress \
               FROM system.view_refreshes \
               LIMIT 2000";
    Ok(Some(ch.rows(sql).await?))
}

/// Tell a refreshable view to run now.
///
/// Only a refreshable one: a classic view has nothing to refresh — it is a
/// trigger, and the only way to fill a gap in its target is an INSERT that
/// Flint will write out for you but will not run, because running it twice
/// double-counts and only you know whether it already ran once.
pub async fn refresh(ch: &Client, database: &str, view: &str) -> Result<()> {
    let listed: Vec<RefreshRow> = refreshes(ch)
        .await?
        .ok_or_else(|| Error::BadRequest("this server has no refreshable views".into()))?;
    if !listed
        .iter()
        .any(|r| r.database == database && r.view == view)
    {
        return Err(Error::BadRequest(format!(
            "`{database}.{view}` is not a refreshable view, so there is nothing to refresh. A \
             classic materialized view is a trigger on inserts; to fill a gap in its target you \
             run a backfill yourself."
        )));
    }
    ch.execute(
        &format!("SYSTEM REFRESH VIEW {}.{}", quote(database), quote(view)),
        super::QueryOptions {
            allow_write: true,
            introspection: true,
            ..Default::default()
        },
    )
    .await
}

fn quote(name: &str) -> String {
    format!("`{}`", name.replace('\\', "\\\\").replace('`', "\\`"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_that_needs_quoting_gets_it() {
        assert_eq!(quote("plain"), "`plain`");
        assert_eq!(quote("with`tick"), "`with\\`tick`");
    }

    #[test]
    fn the_window_is_something_a_log_can_answer() {
        assert_eq!(window(0), 1);
        assert_eq!(window(7), 7);
        assert_eq!(window(1000), 90);
    }
}
