//! Dictionaries, and whether they are actually working.
//!
//! A dictionary is the one piece of ClickHouse that fails silently and keeps
//! answering. `dictGet` on a dictionary that never loaded raises; a dictionary
//! that loaded once and has been failing to refresh ever since keeps returning
//! the values it had, and nothing in a query result says so. That is the reason
//! this module exists.
//!
//! **Neither the status nor the error count reports it reliably.** This was
//! built expecting `FAILED_AND_RELOADING`, which `system.dictionaries`
//! documents. Producing the state for real — a dictionary loaded from a
//! ClickHouse source whose account then had its password changed — showed
//! something else: `status` stays `LOADED` and `dictGet` keeps answering with
//! what it had. `error_count` does go to 1 on a failed refresh, but it is reset
//! and re-raised as the background loader retries, so reading it at one instant
//! catches the state only by luck: two consecutive readings of the same broken
//! dictionary gave 1 and then 0.
//!
//! What does not flicker is the clock. A dictionary whose last *successful* load
//! is older than its own `lifetime_max` has missed a refresh, and one that is a
//! whole cycle past it has missed a whole one — measured against the lifetime
//! the deployment chose rather than against a number invented here. That is the
//! detector; the status and the error count are kept as further ways in, not as
//! the only ones.
//!
//! Two things it is careful not to say:
//!
//! - **`NOT_LOADED` is not broken.** `dictionaries_lazy_load` is on by default,
//!   so a dictionary nobody has queried has never been loaded and reports
//!   nothing: no source, no size, no lifetime. Flagging that as a fault would
//!   have every fresh server look broken. The setting is read alongside, so the
//!   page can say which of the two it is.
//! - **A low `found_rate` is not necessarily wrong.** A dictionary used for
//!   optional enrichment misses most lookups by design. So the figure is shown
//!   and only the unambiguous case is remarked on — every lookup missing, with
//!   lookups having happened, which means the key is wrong or the data is not
//!   there.

use serde::{Deserialize, Serialize};

use super::{Client, Reach, Section};
use crate::error::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dictionary {
    pub database: String,
    pub name: String,
    /// `NOT_LOADED`, `LOADED`, `FAILED`, `LOADING`, `FAILED_AND_RELOADING`,
    /// `LOADED_AND_RELOADING`.
    pub status: String,
    /// Where it reads from. Empty until it has loaded once — the server does not
    /// know, so neither does Flint.
    pub source: String,
    /// `Hashed`, `Flat`, `ComplexKeyHashed`, and the rest.
    pub layout: String,
    pub elements: u64,
    pub bytes: u64,
    pub queries: u64,
    /// The share of lookups that found their key. Meaningless at zero queries,
    /// which is why the count travels with it.
    pub found_rate: f64,
    pub hit_rate: f64,
    /// Seconds. Zero means it never refreshes on its own.
    pub lifetime_min: u64,
    pub lifetime_max: u64,
    pub last_success: String,
    /// How long past its own `lifetime_max` the last successful load is.
    ///
    /// Computed on the server, with the server's clock, because comparing a
    /// timestamp from ClickHouse against Flint's own clock makes a figure that
    /// drifts with whatever the container thinks the time is. Zero where it is
    /// not overdue or has no lifetime to be overdue against.
    pub overdue_secs: u64,
    pub loading_secs: f64,
    pub errors: u64,
    pub exception: String,
    /// Whether this one is a problem, decided here rather than in the browser.
    ///
    /// It is not readable off any single column — `LOADED` with a non-zero error
    /// count is the worst case on this page — so it is computed where the rule
    /// is tested and sent as an answer.
    #[serde(default)]
    pub worrying: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DictionaryReport {
    pub items: Section<Dictionary>,
    /// Whether this server loads dictionaries on first use. The fact that makes
    /// `NOT_LOADED` innocent, so it is read rather than assumed.
    pub lazy: bool,
    /// One line per dictionary worth remarking on, in the order worth reading.
    pub verdicts: Vec<String>,
}

pub async fn dictionaries(ch: &Client) -> Result<DictionaryReport> {
    let blocked = match ch.reach("dictionaries").await? {
        Reach::Readable => None,
        Reach::Denied => Some("this user cannot read system.dictionaries".to_string()),
        Reach::Absent | Reach::Unconfigured => {
            Some("this ClickHouse has no system.dictionaries".to_string())
        }
    };
    if let Some(reason) = blocked {
        return Ok(DictionaryReport {
            items: Section::blocked(reason),
            lazy: false,
            verdicts: Vec::new(),
        });
    }

    let mut items: Vec<Dictionary> = ch
        .rows(
            "SELECT database                                  AS database, \
                    name                                      AS name, \
                    toString(status)                          AS status, \
                    source                                    AS source, \
                    type                                      AS layout, \
                    element_count                             AS elements, \
                    bytes_allocated                           AS bytes, \
                    query_count                               AS queries, \
                    found_rate                                AS found_rate, \
                    hit_rate                                  AS hit_rate, \
                    lifetime_min                              AS lifetime_min, \
                    lifetime_max                              AS lifetime_max, \
                    toString(last_successful_update_time)     AS last_success, \
                    if(lifetime_max > 0 AND last_successful_update_time > toDateTime(0), \
                       greatest(toInt64(dateDiff('second', last_successful_update_time, now())) \
                                - toInt64(lifetime_max), 0), \
                       0)                                     AS overdue_secs, \
                    toFloat64(loading_duration)               AS loading_secs, \
                    error_count                               AS errors, \
                    last_exception                            AS exception \
             FROM system.dictionaries \
             ORDER BY database, name LIMIT 2000",
        )
        .await?;

    // Read rather than assumed, and a failure to read it costs the sentence
    // about lazy loading and nothing else.
    #[derive(Deserialize)]
    struct Row {
        value: String,
    }
    let lazy = ch
        .row::<Row>(
            "SELECT value AS value FROM system.server_settings \
             WHERE name = 'dictionaries_lazy_load'",
        )
        .await
        .ok()
        .flatten()
        .map(|r| r.value == "1" || r.value.eq_ignore_ascii_case("true"))
        .unwrap_or(true);

    for d in items.iter_mut() {
        d.worrying = worrying_now(d, lazy);
    }

    Ok(DictionaryReport {
        verdicts: verdicts(&items, lazy),
        items: Section::of(items),
        lazy,
    })
}

/// What is worth saying about these dictionaries.
///
/// Pure, because every one of these is a judgement rather than a reading, and a
/// judgement is the part worth a test. Ordered by how much trouble it is: a
/// dictionary answering from stale data comes before one that is merely late.
pub fn verdicts(items: &[Dictionary], lazy: bool) -> Vec<String> {
    let mut out = Vec::new();
    let qualified = |d: &Dictionary| format!("{}.{}", d.database, d.name);

    // The subtle one, and the reason for the module. It loaded once, its last
    // refresh failed, and it keeps answering with what it had.
    //
    // Detected on `error_count` rather than on the status, because the status
    // does not say: on a real server in exactly this state it still read
    // `LOADED`. `FAILED_AND_RELOADING` is the documented spelling and is kept
    // as a second way in, not as the only one.
    for d in items.iter().filter(|d| stale_but_answering(d)) {
        out.push(format!(
            "{} is answering from data it loaded at {} and has not refreshed since{}. Its \
             status still reads {}, and queries against it still succeed — so nothing else will \
             tell you.",
            qualified(d),
            d.last_success,
            if d.exception.is_empty() {
                String::new()
            } else {
                format!(": {}", first_line(&d.exception))
            },
            d.status
        ));
    }

    for d in items
        .iter()
        .filter(|d| d.status == "FAILED" && !stale_but_answering(d))
    {
        out.push(format!(
            "{} has never loaded. Every dictGet against it raises.",
            qualified(d)
        ));
    }

    // Not lazy and not loaded means it was meant to load at startup and did
    // not, which is a different fact from the innocent one.
    if !lazy {
        for d in items.iter().filter(|d| d.status == "NOT_LOADED") {
            out.push(format!(
                "{} is not loaded, and this server does not load them lazily — it should have \
                 loaded at startup.",
                qualified(d)
            ));
        }
    }

    // Late, but not yet a whole cycle late — which a reload in progress
    // legitimately looks like, so it is a remark and not an alarm.
    for d in items
        .iter()
        .filter(|d| d.overdue_secs > 0 && !stale_but_answering(d))
    {
        out.push(format!(
            "{} is {} seconds past its refresh, which is inside one cycle of its {}-second \
             lifetime — a reload in progress looks like this.",
            qualified(d),
            d.overdue_secs,
            d.lifetime_max
        ));
    }

    // Only the unambiguous case. A dictionary used for optional enrichment
    // misses most lookups by design, and inventing a threshold for "too many"
    // would put Flint's guess above the deployment's intent.
    for d in items
        .iter()
        .filter(|d| d.queries > 0 && d.found_rate == 0.0 && d.status.starts_with("LOADED"))
    {
        out.push(format!(
            "{} has answered {} lookups and found none of them. Either the key is not what the \
             callers think, or the data is not there.",
            qualified(d),
            d.queries
        ));
    }

    out
}

/// Loaded once, failing to refresh, and still answering.
///
/// The condition the module is for, and none of the obvious columns reports it:
/// the status stays `LOADED` and `error_count` flickers as the background loader
/// retries. The durable signal is that the last *successful* load is a whole
/// lifetime past due — a cycle missed, measured against the lifetime the
/// deployment chose rather than a threshold invented here.
///
/// `last_success` past the epoch is what separates "has loaded and is now
/// failing" from "has never loaded at all", which is a different and much louder
/// problem.
pub fn stale_but_answering(d: &Dictionary) -> bool {
    if d.last_success.starts_with("1970") {
        return false;
    }
    let missed_a_cycle = d.lifetime_max > 0 && d.overdue_secs > d.lifetime_max;
    missed_a_cycle || d.errors > 0 || d.status == "FAILED_AND_RELOADING"
}

/// The first line of an exception, for a sentence that has to stay one sentence.
///
/// ClickHouse stack traces run to paragraphs, and the section that printed one
/// in full measured 134,559 pixels tall.
fn first_line(exception: &str) -> &str {
    exception.lines().next().unwrap_or("").trim()
}

/// Whether a status is one a person should worry about.
///
/// `NOT_LOADED` depends on the server, which is why it takes the flag: on a
/// lazily-loading server it means nobody has asked yet, and on any other it
/// means something failed at startup.
fn worrying_now(d: &Dictionary, lazy: bool) -> bool {
    if stale_but_answering(d) {
        return true;
    }
    match d.status.as_str() {
        "FAILED" | "FAILED_AND_RELOADING" => true,
        "NOT_LOADED" => !lazy,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dict(over: impl Fn(&mut Dictionary)) -> Dictionary {
        let mut d = Dictionary {
            database: "reference".into(),
            name: "tenant_label".into(),
            status: "LOADED".into(),
            source: "ClickHouse: reference.tenants".into(),
            layout: "Hashed".into(),
            elements: 3,
            bytes: 10_472,
            queries: 2,
            found_rate: 0.5,
            hit_rate: 1.0,
            lifetime_min: 300,
            lifetime_max: 600,
            last_success: "2026-08-26 10:00:00".into(),
            overdue_secs: 0,
            loading_secs: 0.004,
            errors: 0,
            exception: String::new(),
            worrying: false,
        };
        over(&mut d);
        d
    }

    #[test]
    fn a_working_dictionary_says_nothing() {
        assert!(verdicts(&[dict(|_| {})], true).is_empty());
    }

    #[test]
    fn stale_and_still_answering_is_the_loudest_thing_here() {
        // The state that looks like working from the outside: it loaded once, it
        // has been failing to refresh, and every query still succeeds.
        let out = verdicts(&[dict(|d| d.status = "FAILED_AND_RELOADING".into())], true);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("answering from data it loaded"));
        assert!(out[0].contains("nothing else will tell you"));
    }

    #[test]
    fn a_missed_cycle_is_caught_when_the_error_count_has_flickered_back_to_zero() {
        // Two consecutive readings of the same broken dictionary gave error
        // counts of 1 and then 0, so the count alone catches this by luck. The
        // clock does not flicker.
        let d = dict(|d| {
            d.status = "LOADED".into();
            d.errors = 0;
            d.lifetime_max = 600;
            d.overdue_secs = 900;
        });
        assert!(stale_but_answering(&d));
        let out = verdicts(&[d], true);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("has not refreshed since"));
    }

    #[test]
    fn being_late_inside_one_cycle_is_a_remark_and_not_an_alarm() {
        // A reload in progress legitimately looks like this.
        let d = dict(|d| {
            d.lifetime_max = 600;
            d.overdue_secs = 30;
        });
        assert!(!stale_but_answering(&d));
        let out = verdicts(&[d], true);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("inside one cycle"));
    }

    #[test]
    fn a_dictionary_with_no_lifetime_is_never_overdue() {
        // Zero means it never refreshes on its own, so there is nothing to be
        // late for.
        let d = dict(|d| {
            d.lifetime_max = 0;
            d.overdue_secs = 0;
        });
        assert!(!stale_but_answering(&d));
        assert!(verdicts(&[d], true).is_empty());
    }

    #[test]
    fn the_error_count_is_a_second_way_in_when_it_happens_to_be_set() {
        // Exactly what a real server answered with the state produced on
        // purpose: `LOADED`, one error, the refusal in `last_exception`, and
        // `dictGet` still returning the old value. Reading the status alone
        // calls this healthy.
        let d = dict(|d| {
            d.status = "LOADED".into();
            d.errors = 1;
            d.exception = "Code: 516. DB::Exception: dict_src: Authentication failed: password is \
                 incorrect.\nstack trace follows"
                .into();
        });
        assert!(stale_but_answering(&d));
        assert!(worrying_now(&d, true));
        let out = verdicts(&[d], true);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("has not refreshed since"));
        assert!(out[0].contains("status still reads LOADED"));
        // And carries the server's own words about why.
        assert!(out[0].contains("Authentication failed"));
        // One line of the exception, not the stack trace: a section that printed
        // one in full once measured 134,559 pixels tall.
        assert!(!out[0].contains("stack trace follows"));
    }

    #[test]
    fn a_dictionary_that_has_never_loaded_is_not_answering_from_anything() {
        // Errors and no successful load ever is the loud problem, not the quiet
        // one, and saying both would be two sentences about one dictionary.
        let d = dict(|d| {
            d.status = "FAILED".into();
            d.errors = 3;
            d.last_success = "1970-01-01 00:00:00".into();
        });
        assert!(!stale_but_answering(&d));
        let out = verdicts(&[d], true);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("never loaded"));
    }

    #[test]
    fn stale_and_answering_comes_before_merely_late() {
        let out = verdicts(
            &[
                dict(|d| {
                    d.name = "late".into();
                    d.overdue_secs = 90;
                }),
                dict(|d| {
                    d.name = "stale".into();
                    d.status = "FAILED_AND_RELOADING".into();
                }),
            ],
            true,
        );
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("reference.stale"));
        assert!(out[1].contains("reference.late"));
    }

    #[test]
    fn not_loaded_is_innocent_where_loading_is_lazy() {
        // `dictionaries_lazy_load` is on by default, so a dictionary nobody has
        // queried has never been loaded. Flagging that would make every fresh
        // server look broken.
        let d = [dict(|d| {
            d.status = "NOT_LOADED".into();
            // Never loaded, so no successful-load timestamp either.
            d.last_success = "1970-01-01 00:00:00".into();
        })];
        assert!(verdicts(&d, true).is_empty());
        assert!(!worrying_now(&d[0], true));

        // And is a real finding where loading is not lazy.
        let out = verdicts(&d, false);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("should have loaded at startup"));
        assert!(worrying_now(&d[0], false));
    }

    #[test]
    fn a_low_found_rate_is_not_a_verdict_but_a_zero_one_is() {
        // Optional enrichment misses most lookups by design, and a threshold for
        // "too many" would be Flint's guess over the deployment's intent.
        assert!(verdicts(&[dict(|d| d.found_rate = 0.02)], true).is_empty());

        let out = verdicts(&[dict(|d| d.found_rate = 0.0)], true);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("found none of them"));
    }

    #[test]
    fn a_dictionary_nobody_has_queried_has_no_rate_to_judge() {
        // Zero of zero is not zero per cent.
        assert!(verdicts(
            &[dict(|d| {
                d.queries = 0;
                d.found_rate = 0.0;
            })],
            true
        )
        .is_empty());
    }

    #[test]
    fn a_never_loaded_dictionary_is_not_also_judged_on_its_rate() {
        // FAILED with zero queries and zero found rate must produce one sentence
        // about failing, not two.
        let out = verdicts(
            &[dict(|d| {
                d.status = "FAILED".into();
                d.queries = 4;
                d.found_rate = 0.0;
            })],
            true,
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("never loaded"));
    }
}
