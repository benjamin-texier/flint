//! What the server is doing this second.
//!
//! The half of Health that the history could not answer. `over time` says what
//! happened; this says what is happening, and the two need different sources for
//! a reason the roadmap already learned once, on the errors panel: a counter
//! that runs from boot is the one thing a "right now" figure cannot be. On a
//! server up for eleven days "forty-two million selects" is true and says
//! nothing about this minute.
//!
//! So the three tables are used for what each of them actually is:
//!
//! - **`system.metrics`** is instantaneous by construction — queries running,
//!   merges running, bytes of memory held. These are the figures this module is
//!   mostly made of.
//! - **`system.asynchronous_metrics`** is instantaneous too, sampled on a timer:
//!   disk space, load average, replica lag, uptime.
//! - **`system.events`** is *not* used. It counts from boot, and the rate that
//!   would make it meaningful is already recorded, per second, in
//!   `system.metric_log`'s `ProfileEvent_*` columns — which hold deltas rather
//!   than running totals. So the rates come from the newest row of that table,
//!   which costs one cheap read and no waiting around for a second sample.
//!
//! **A figure is paired with its ceiling wherever one exists.** That is the
//! organising idea: eighty numbers with no scale is a wall, and the same eighty
//! against what the server will allow is a page somebody can act on. The
//! ceilings live in three different places — `system.server_settings` for
//! memory and connections, `system.merge_tree_settings` for the parts limit,
//! and `system.metrics` itself for the merge pool's own size — and a ceiling of
//! zero means *unlimited*, so it is dropped rather than drawn as a full bar.

use serde::{Deserialize, Serialize};

use super::{Client, Reach, Section};
use crate::error::Result;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Unit {
    Count,
    Bytes,
    Seconds,
}

/// How to read a figure, which is a property of the figure and not of the page.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    /// It has a ceiling, and the distance to it is the point.
    Saturation,
    /// It has no ceiling and should be zero. Anything else is the finding.
    ShouldBeZero,
    /// Context. No ceiling, no alarm, and still worth knowing.
    Figure,
}

#[derive(Debug, Clone, Serialize)]
pub struct Gauge {
    /// What a person would call it, not what the column is called.
    pub name: String,
    /// The metric it came from, so a figure on the screen can be traced back to
    /// a table without guessing.
    pub source: String,
    pub value: f64,
    pub unit: Unit,
    pub kind: Kind,
    /// Absent where the server sets no limit, or where the table holding the
    /// limit could not be read. Zero in ClickHouse means unlimited and is
    /// dropped here rather than drawn as a bar at its end.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ceiling: Option<f64>,
    /// The setting the ceiling came from. Empty when there is no ceiling.
    pub ceiling_from: String,
    /// What a large value means, for the ones where that is not obvious from
    /// the name. Empty where the name says it.
    pub note: String,
    /// Which object the figure is about, where it is about one — the partition
    /// nearest the parts limit, the disk running out.
    pub detail: String,
}

/// Something happening per second, from the newest bucket of `metric_log`.
#[derive(Debug, Clone, Serialize)]
pub struct Rate {
    pub name: String,
    pub source: String,
    pub per_second: f64,
    pub unit: Unit,
}

#[derive(Debug, Clone, Serialize)]
pub struct NowReport {
    pub gauges: Section<Gauge>,
    pub rates: Section<Rate>,
    /// When the rates were measured. `metric_log` buffers before it writes, so
    /// the newest row can be several seconds old — and a rate labelled "now"
    /// that is eight seconds stale is the same lie as a lifetime counter, in
    /// miniature. The page says the time and how long ago it was.
    pub rates_at: String,
    pub rates_age_secs: i64,
    /// Seconds since the server started. Context for everything above it: a
    /// figure that looks alarming on a server up for a minute is often just a
    /// server that has been up for a minute.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_secs: Option<f64>,
}

/// One curated metric: where it comes from, what to call it, how to read it.
struct Watched {
    metric: &'static str,
    name: &'static str,
    unit: Unit,
    kind: Kind,
    /// The setting that caps it, **qualified by the table it lives in** — if
    /// any.
    ///
    /// The qualification is not decoration. Six names appear in both
    /// `system.server_settings` and `system.merge_tree_settings`, and
    /// `max_concurrent_queries` is one of them: 1000 as the server-wide limit
    /// and 0 as an unlimited per-table one. A flat lookup let the second
    /// overwrite the first, which turned a real ceiling into no ceiling and
    /// demoted the most-read row on the page to a figure with no scale.
    ceiling: &'static str,
    note: &'static str,
}

/// The gauges from `system.metrics`, chosen rather than enumerated.
///
/// Two hundred metrics is a wall. These are the ones an operator reads, and each
/// carries the sentence that makes it readable — because `DelayedInserts` means
/// nothing to somebody who has not already met it, and it is the single most
/// important number on the list when it moves.
const METRICS: [Watched; 8] = [
    Watched {
        metric: "Query",
        name: "Queries running",
        unit: Unit::Count,
        kind: Kind::Saturation,
        ceiling: "server_settings.max_concurrent_queries",
        note: "",
    },
    Watched {
        metric: "MemoryTracking",
        name: "Memory held",
        unit: Unit::Bytes,
        kind: Kind::Saturation,
        ceiling: "server_settings.max_server_memory_usage",
        note: "What the server is tracking, which is not the same as what the OS has given it.",
    },
    Watched {
        metric: "BackgroundMergesAndMutationsPoolTask",
        name: "Merge pool in use",
        unit: Unit::Count,
        kind: Kind::Saturation,
        // Not a setting: the pool publishes its own size as a metric beside its
        // occupancy, which is the only place the two agree by construction.
        ceiling: "metrics.BackgroundMergesAndMutationsPoolSize",
        note: "A full pool means merges are queued, and queued merges are how parts pile up.",
    },
    Watched {
        metric: "MarkCacheBytes",
        name: "Mark cache",
        unit: Unit::Bytes,
        kind: Kind::Saturation,
        ceiling: "server_settings.mark_cache_size",
        note: "",
    },
    Watched {
        metric: "DelayedInserts",
        name: "Inserts being delayed",
        unit: Unit::Count,
        kind: Kind::ShouldBeZero,
        ceiling: "",
        note: "The server is slowing inserts down on purpose because a partition has too many \
               parts. The next step past this is refusing them.",
    },
    Watched {
        metric: "ReadonlyReplica",
        name: "Replicas gone read-only",
        unit: Unit::Count,
        kind: Kind::ShouldBeZero,
        ceiling: "",
        note: "A replica that has lost Keeper accepts no writes. It does not fix itself.",
    },
    Watched {
        metric: "PartsActive",
        name: "Active parts",
        unit: Unit::Count,
        kind: Kind::Figure,
        ceiling: "",
        note: "",
    },
    Watched {
        metric: "PartsOutdated",
        name: "Outdated parts",
        unit: Unit::Count,
        kind: Kind::Figure,
        ceiling: "",
        note: "Merged away and not yet deleted. A large number is normal; a growing one is not.",
    },
];

/// The gauges from `system.asynchronous_metrics`.
const ASYNC: [Watched; 3] = [
    Watched {
        metric: "ReplicasMaxAbsoluteDelay",
        name: "Worst replica delay",
        unit: Unit::Seconds,
        kind: Kind::ShouldBeZero,
        ceiling: "",
        note: "",
    },
    Watched {
        metric: "DistributedFilesToInsert",
        name: "Distributed sends waiting",
        unit: Unit::Count,
        kind: Kind::ShouldBeZero,
        ceiling: "",
        note: "Rows accepted by a Distributed table and not yet delivered to a shard.",
    },
    Watched {
        metric: "LoadAverage1",
        name: "Load average, one minute",
        unit: Unit::Count,
        kind: Kind::Figure,
        ceiling: "",
        note: "The machine, not ClickHouse. Compare it with the core count before reading much \
               into it.",
    },
];

/// The `ProfileEvent_*` columns worth a rate, and what to call them.
const RATES: [(&str, &str, Unit); 6] = [
    ("SelectQuery", "Selects", Unit::Count),
    ("InsertQuery", "Inserts", Unit::Count),
    ("FailedQuery", "Queries that failed", Unit::Count),
    ("SelectedRows", "Rows read", Unit::Count),
    ("SelectedBytes", "Bytes read", Unit::Bytes),
    ("InsertedRows", "Rows written", Unit::Count),
];

/// A ceiling of zero is not a ceiling.
///
/// ClickHouse spells "no limit" as `0` in every one of these settings, so a
/// literal reading draws a bar permanently at its end and reports a healthy
/// server as one at 100% of everything.
fn ceiling_of(raw: Option<f64>) -> Option<f64> {
    raw.filter(|v| *v > 0.0)
}

/// Pair each watched metric with its value and its ceiling.
///
/// Pure, so the curation can be tested without a server: the mistakes worth
/// catching here are a metric that is not in the list of values, a ceiling that
/// is zero, and a ceiling whose own source is missing.
fn assemble(
    watched: &[Watched],
    values: &std::collections::HashMap<String, f64>,
    ceilings: &std::collections::HashMap<String, f64>,
) -> Vec<Gauge> {
    watched
        .iter()
        .filter_map(|w| {
            let value = *values.get(w.metric)?;
            let ceiling = if w.ceiling.is_empty() {
                None
            } else {
                ceiling_of(ceilings.get(w.ceiling).copied())
            };
            Some(Gauge {
                name: w.name.to_string(),
                source: w.metric.to_string(),
                value,
                unit: w.unit,
                // A row promised a ceiling and given none is a figure, not a
                // saturation with nothing to saturate: the bar would have
                // nothing to draw against and the heading would be a lie.
                kind: if w.kind == Kind::Saturation && ceiling.is_none() {
                    Kind::Figure
                } else {
                    w.kind
                },
                ceiling,
                ceiling_from: if ceiling.is_some() {
                    w.ceiling.to_string()
                } else {
                    String::new()
                },
                note: w.note.to_string(),
                detail: String::new(),
            })
        })
        .collect()
}

pub async fn now(ch: &Client) -> Result<NowReport> {
    let (gauges, uptime) = read_gauges(ch).await?;
    let (rates, rates_at, rates_age_secs) = read_rates(ch).await?;
    Ok(NowReport {
        gauges,
        rates,
        rates_at,
        rates_age_secs,
        uptime_secs: uptime,
    })
}

async fn read_gauges(ch: &Client) -> Result<(Section<Gauge>, Option<f64>)> {
    let blocked = match ch.reach("metrics").await? {
        Reach::Readable => None,
        Reach::Denied => Some("this user cannot read system.metrics".to_string()),
        Reach::Absent | Reach::Unconfigured => {
            Some("this ClickHouse has no system.metrics".to_string())
        }
    };
    if let Some(reason) = blocked {
        return Ok((Section::blocked(reason), None));
    }

    #[derive(Deserialize)]
    struct Row {
        name: String,
        // Aliased `number` in the settings queries and `value` in the metrics
        // ones: `toFloat64OrZero(value) AS value` puts the alias in scope of the
        // expression that defines it, which is the shadowing that has cost this
        // codebase an afternoon before.
        #[serde(alias = "number")]
        value: f64,
    }

    let values: std::collections::HashMap<String, f64> = ch
        .rows::<Row>("SELECT name AS name, toFloat64(value) AS value FROM system.metrics")
        .await?
        .into_iter()
        .map(|r| (r.name, r.value))
        .collect();

    // The asynchronous ones are a separate table and a separate grant, so being
    // refused them costs three rows rather than the panel.
    let async_values: std::collections::HashMap<String, f64> = match ch
        .rows::<Row>(
            "SELECT metric AS name, toFloat64(value) AS value FROM system.asynchronous_metrics",
        )
        .await
    {
        Ok(rows) => rows.into_iter().map(|r| (r.name, r.value)).collect(),
        Err(e) => {
            tracing::debug!("asynchronous metrics unavailable: {e}");
            Default::default()
        }
    };

    // Ceilings come from three places, and any of them can be denied. A missing
    // ceiling turns a saturation row into a plain figure rather than losing it.
    //
    // Keyed by `table.name` rather than by name, because the tables collide:
    // `max_concurrent_queries` is 1000 in `server_settings` and 0 in
    // `merge_tree_settings`, and they are different limits.
    let mut ceilings: std::collections::HashMap<String, f64> = values
        .iter()
        .map(|(k, v)| (format!("metrics.{k}"), *v))
        .collect();
    for table in ["server_settings", "merge_tree_settings"] {
        match ch
            .rows::<Row>(&format!(
                "SELECT name AS name, toFloat64OrZero(value) AS number FROM system.{table}"
            ))
            .await
        {
            Ok(rows) => ceilings.extend(
                rows.into_iter()
                    .map(|r| (format!("{table}.{}", r.name), r.value)),
            ),
            Err(e) => tracing::debug!("ceilings from system.{table} unavailable: {e}"),
        }
    }

    let mut gauges = assemble(&METRICS, &values, &ceilings);
    gauges.extend(assemble(&ASYNC, &async_values, &ceilings));

    if let Some(worst) = worst_partition(ch, &ceilings).await? {
        gauges.push(worst);
    }
    gauges.extend(disks(&async_values));

    Ok((Section::of(gauges), async_values.get("Uptime").copied()))
}

/// The partition closest to the limit that stops inserts.
///
/// Worth its own read, and worth naming the table: the `SYSTEM STOP MERGES`
/// panel warns that a table over `parts_to_throw_insert` refuses inserts
/// entirely, and this is the figure that says how far away that is. The count
/// comes from `system.parts` rather than from the `MaxPartCountForPartition`
/// metric — which lives in `system.metrics` on some versions and
/// `system.asynchronous_metrics` on others — because `system.parts` also says
/// *which* partition, and a number with no name is a number nobody can act on.
async fn worst_partition(
    ch: &Client,
    ceilings: &std::collections::HashMap<String, f64>,
) -> Result<Option<Gauge>> {
    #[derive(Deserialize)]
    struct Row {
        qualified: String,
        partition: String,
        parts: u64,
    }
    let row: Option<Row> = match ch
        .row::<Row>(
            "SELECT concat(database, '.', table) AS qualified, \
                    partition                     AS partition, \
                    count()                       AS parts \
             FROM system.parts WHERE active \
             GROUP BY qualified, partition \
             ORDER BY parts DESC LIMIT 1",
        )
        .await
    {
        Ok(row) => row,
        Err(e) => {
            tracing::debug!("worst partition unavailable: {e}");
            return Ok(None);
        }
    };
    let Some(row) = row else { return Ok(None) };

    let ceiling = ceiling_of(
        ceilings
            .get("merge_tree_settings.parts_to_throw_insert")
            .copied(),
    );
    Ok(Some(Gauge {
        name: "Parts in the fullest partition".into(),
        source: "system.parts".into(),
        value: row.parts as f64,
        unit: Unit::Count,
        kind: if ceiling.is_some() {
            Kind::Saturation
        } else {
            Kind::Figure
        },
        ceiling,
        ceiling_from: if ceiling.is_some() {
            "merge_tree_settings.parts_to_throw_insert".into()
        } else {
            String::new()
        },
        note: "At the ceiling the server stops accepting inserts into that table. This is the \
               figure the merge controls act on."
            .into(),
        detail: format!("{} {}", row.qualified, row.partition),
    }))
}

/// One row per disk: used against total.
///
/// From the asynchronous metrics rather than `system.disks`, because the names
/// there carry the disk in the metric name — `DiskUsed_default` — and pairing
/// them is the whole of it.
fn disks(async_values: &std::collections::HashMap<String, f64>) -> Vec<Gauge> {
    let mut names: Vec<&str> = async_values
        .keys()
        .filter_map(|k| k.strip_prefix("DiskTotal_"))
        .collect();
    names.sort_unstable();
    names
        .into_iter()
        .filter_map(|disk| {
            let total = ceiling_of(async_values.get(&format!("DiskTotal_{disk}")).copied())?;
            let used = *async_values.get(&format!("DiskUsed_{disk}"))?;
            Some(Gauge {
                name: format!("Disk {disk}"),
                source: format!("DiskUsed_{disk}"),
                value: used,
                unit: Unit::Bytes,
                kind: Kind::Saturation,
                ceiling: Some(total),
                ceiling_from: format!("DiskTotal_{disk}"),
                note: String::new(),
                detail: String::new(),
            })
        })
        .collect()
}

async fn read_rates(ch: &Client) -> Result<(Section<Rate>, String, i64)> {
    let blocked = match ch.reach("metric_log").await? {
        Reach::Readable => None,
        Reach::Denied => Some("this user cannot read system.metric_log".to_string()),
        Reach::Absent | Reach::Unconfigured => Some(
            "this server has no system.metric_log, so there is nothing to take a rate from — \
             `system.events` counts from boot and cannot answer for this second"
                .to_string(),
        ),
    };
    if let Some(reason) = blocked {
        return Ok((Section::blocked(reason), String::new(), 0));
    }

    let columns: Vec<String> = RATES
        .iter()
        .map(|(column, _, _)| format!("toFloat64(ProfileEvent_{column})"))
        .collect();

    #[derive(Deserialize)]
    struct Row {
        at: String,
        age: i64,
        values: Vec<f64>,
    }
    // The newest row, and how stale it is. `metric_log` buffers before writing,
    // so "the newest row" and "this second" are not the same thing and the
    // difference has to be on the screen.
    let row: Option<Row> = ch
        .row::<Row>(&format!(
            "SELECT toString(event_time)                    AS at, \
                    toInt64(dateDiff('second', event_time, now())) AS age, \
                    [{}]                                    AS values \
             FROM system.metric_log ORDER BY event_time DESC LIMIT 1",
            columns.join(", ")
        ))
        .await?;

    let Some(row) = row else {
        return Ok((
            Section::blocked(
                "system.metric_log is empty — the server has not written a bucket yet".into(),
            ),
            String::new(),
            0,
        ));
    };

    let rates = RATES
        .iter()
        .enumerate()
        .filter_map(|(i, (column, name, unit))| {
            Some(Rate {
                name: (*name).to_string(),
                source: format!("ProfileEvent_{column}"),
                per_second: *row.values.get(i)?,
                unit: *unit,
            })
        })
        .collect();

    Ok((Section::of(rates), row.at, row.age))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn map(pairs: &[(&str, f64)]) -> HashMap<String, f64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn a_ceiling_of_zero_is_not_a_ceiling() {
        // ClickHouse spells "no limit" as 0 in every one of these settings, so a
        // literal reading draws a bar permanently at its end and reports a
        // healthy server as one at 100% of everything.
        assert_eq!(ceiling_of(Some(0.0)), None);
        assert_eq!(ceiling_of(Some(1000.0)), Some(1000.0));
        assert_eq!(ceiling_of(None), None);
    }

    #[test]
    fn a_saturation_with_no_ceiling_becomes_a_figure() {
        let watched = [Watched {
            metric: "Query",
            name: "Queries running",
            unit: Unit::Count,
            kind: Kind::Saturation,
            ceiling: "server_settings.max_concurrent_queries",
            note: "",
        }];
        // Unlimited, which is the default on plenty of servers.
        let out = assemble(
            &watched,
            &map(&[("Query", 3.0)]),
            &map(&[("max_concurrent_queries", 0.0)]),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, Kind::Figure);
        assert!(out[0].ceiling.is_none());
        // And no dangling attribution for a ceiling that is not there.
        assert_eq!(out[0].ceiling_from, "");

        let out = assemble(
            &watched,
            &map(&[("Query", 3.0)]),
            &map(&[("server_settings.max_concurrent_queries", 1000.0)]),
        );
        assert_eq!(out[0].kind, Kind::Saturation);
        assert_eq!(out[0].ceiling, Some(1000.0));
        assert_eq!(
            out[0].ceiling_from,
            "server_settings.max_concurrent_queries"
        );
    }

    #[test]
    fn the_two_settings_tables_do_not_overwrite_each_other() {
        // Six names live in both, and `max_concurrent_queries` is 1000 in
        // `server_settings` and 0 — unlimited — in `merge_tree_settings`. Keyed
        // by name alone, the second wins and the busiest row on the page loses
        // its scale.
        let watched = [Watched {
            metric: "Query",
            name: "Queries running",
            unit: Unit::Count,
            kind: Kind::Saturation,
            ceiling: "server_settings.max_concurrent_queries",
            note: "",
        }];
        let out = assemble(
            &watched,
            &map(&[("Query", 3.0)]),
            &map(&[
                ("server_settings.max_concurrent_queries", 1000.0),
                ("merge_tree_settings.max_concurrent_queries", 0.0),
            ]),
        );
        assert_eq!(out[0].ceiling, Some(1000.0));
        assert_eq!(out[0].kind, Kind::Saturation);
    }

    #[test]
    fn a_metric_this_version_does_not_have_is_dropped() {
        // `MaxPartCountForPartition` moved between `system.metrics` and
        // `system.asynchronous_metrics` across versions, which is the kind of
        // thing that has to cost one row and not the panel.
        let watched = [Watched {
            metric: "NotHere",
            name: "Missing",
            unit: Unit::Count,
            kind: Kind::Figure,
            ceiling: "",
            note: "",
        }];
        assert!(assemble(&watched, &map(&[("Query", 1.0)]), &map(&[])).is_empty());
    }

    #[test]
    fn a_should_be_zero_row_keeps_its_kind_without_a_ceiling() {
        let watched = [Watched {
            metric: "DelayedInserts",
            name: "Inserts being delayed",
            unit: Unit::Count,
            kind: Kind::ShouldBeZero,
            ceiling: "",
            note: "n",
        }];
        let out = assemble(&watched, &map(&[("DelayedInserts", 0.0)]), &map(&[]));
        assert_eq!(out[0].kind, Kind::ShouldBeZero);
    }

    #[test]
    fn disks_are_paired_by_name_and_sorted() {
        let out = disks(&map(&[
            ("DiskTotal_default", 1000.0),
            ("DiskUsed_default", 400.0),
            ("DiskTotal_backups", 500.0),
            ("DiskUsed_backups", 100.0),
            // A total with no used figure is half a pair and cannot be drawn.
            ("DiskTotal_lonely", 900.0),
        ]));
        assert_eq!(
            out.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(),
            ["Disk backups", "Disk default"]
        );
        assert_eq!(out[1].value, 400.0);
        assert_eq!(out[1].ceiling, Some(1000.0));
    }

    #[test]
    fn a_disk_reporting_no_size_is_dropped_rather_than_divided_by() {
        let out = disks(&map(&[("DiskTotal_weird", 0.0), ("DiskUsed_weird", 0.0)]));
        assert!(out.is_empty());
    }

    #[test]
    fn the_rate_columns_and_their_names_line_up() {
        // They are read positionally out of one SQL array, so a name added to
        // one list and not the other mislabels every figure after it.
        assert!(RATES.iter().all(|(column, name, _)| {
            !column.is_empty() && !name.is_empty() && !column.contains(' ')
        }));
    }
}
