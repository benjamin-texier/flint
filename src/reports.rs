//! Reports: what the numbers were, kept.
//!
//! A dashboard answers "what is happening"; it always shows now, and last
//! Monday's version of it is gone. A report is the other half: it runs on a
//! schedule and *keeps* what it found, so the question "what did this look like
//! three weeks ago" has an answer.
//!
//! Time is ClickHouse's, not Rust's. The server that stores the timestamps does
//! the date arithmetic too — it hands over midnight, the day of the week and
//! the minute of the day in its own timezone, and everything here is integer
//! comparison on those. One clock, in the zone Flint already shows on the
//! server page, and no dependency that could disagree with it.

use serde::{Deserialize, Serialize};

/// What the server's clock says, in the server's timezone.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Clock {
    /// Unix seconds, now.
    pub now_ts: i64,
    /// Unix seconds at the start of today.
    pub midnight_ts: i64,
    /// 1 = Monday … 7 = Sunday, as ClickHouse's `toDayOfWeek` reports it.
    pub dow: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Schedule {
    /// Every `hours` hours, counted from the last run rather than from a wall
    /// clock: an interval schedule has no opinion about when the day starts.
    Every { hours: u32 },
    /// Once a day, at `minute` minutes past midnight.
    Daily { minute: u32 },
    /// Once a week, on `dow` (1 = Monday), at `minute` past midnight.
    Weekly { dow: u8, minute: u32 },
}

impl Schedule {
    pub fn parse(raw: &str) -> std::result::Result<Self, String> {
        let parsed: Self =
            serde_json::from_str(raw).map_err(|e| format!("unreadable schedule: {e}"))?;
        parsed.check()?;
        Ok(parsed)
    }

    /// Bounds checked on the way in, because a schedule that can never come
    /// round is a report that looks armed and never runs.
    pub fn check(&self) -> std::result::Result<(), String> {
        match self {
            Schedule::Every { hours } => {
                if !(1..=720).contains(hours) {
                    return Err("an interval schedule runs between 1 and 720 hours apart".into());
                }
            }
            Schedule::Daily { minute } => {
                if *minute >= 1440 {
                    return Err("a time of day is under 1440 minutes past midnight".into());
                }
            }
            Schedule::Weekly { dow, minute } => {
                if !(1..=7).contains(dow) {
                    return Err("a day of the week is 1 (Monday) through 7 (Sunday)".into());
                }
                if *minute >= 1440 {
                    return Err("a time of day is under 1440 minutes past midnight".into());
                }
            }
        }
        Ok(())
    }

    /// The instant today's (or this week's) run was due, in unix seconds.
    /// `None` for an interval schedule, which has no slot.
    fn slot(&self, clock: &Clock) -> Option<i64> {
        match self {
            Schedule::Every { .. } => None,
            Schedule::Daily { minute } => Some(clock.midnight_ts + i64::from(*minute) * 60),
            Schedule::Weekly { dow, minute } => {
                (clock.dow == *dow).then(|| clock.midnight_ts + i64::from(*minute) * 60)
            }
        }
    }
}

/// Whether a report should run now.
///
/// A slot that has passed and has not been served yet is due. Crucially the
/// answer depends on the *recorded* last run rather than on anything the
/// process remembers, so a restart at 09:05 does not run the nine o'clock
/// report a second time — and a Flint that was down at nine still runs it when
/// it comes back, because the slot is passed and unserved.
pub fn is_due(schedule: &Schedule, clock: &Clock, last_run_ts: Option<i64>) -> bool {
    match schedule {
        Schedule::Every { hours } => match last_run_ts {
            Some(last) => clock.now_ts - last >= i64::from(*hours) * 3600,
            // Never run: due now. An interval report should not wait a full
            // interval before its first answer.
            None => true,
        },
        _ => match schedule.slot(clock) {
            None => false,
            Some(slot) => {
                if clock.now_ts < slot {
                    return false;
                }
                match last_run_ts {
                    Some(last) => last < slot,
                    None => true,
                }
            }
        },
    }
}

/// A missed slot is served late, but only within a day. A report that was due
/// last Tuesday and is found on Friday should not fire Tuesday's edition —
/// nobody wants a Monday-morning summary delivered on Thursday, and the data it
/// would carry is today's anyway.
pub const CATCH_UP_WINDOW_SECS: i64 = 86_400;

pub fn too_late(schedule: &Schedule, clock: &Clock) -> bool {
    match schedule.slot(clock) {
        Some(slot) => clock.now_ts - slot > CATCH_UP_WINDOW_SECS,
        None => false,
    }
}

/// How many rows of each section a snapshot keeps.
///
/// A report is a summary, and a summary that stores a million rows is a copy of
/// the table with extra steps. The snapshot says when it was cut short, so a
/// truncated section is never mistaken for a complete one.
pub const SECTION_ROW_CAP: usize = 500;

/// One part of a report: a statement, and how to draw it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Section {
    pub title: String,
    pub sql: String,
    #[serde(default)]
    pub database: String,
    /// The chart form to draw the stored rows with, in the same shape the
    /// dashboards use. Absent means the table is the answer.
    #[serde(default)]
    pub chart: Option<serde_json::Value>,
}

/// What a report is made of. Stored as JSON for the same reason a dashboard's
/// layout is: it is always read whole, and nothing queries inside it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Spec {
    pub sections: Vec<Section>,
}

impl Spec {
    /// Read defensively, like a dashboard's layout: a section with no statement
    /// is dropped rather than allowed to fail the whole report later.
    pub fn parse(raw: &str) -> std::result::Result<Self, String> {
        let spec: Self =
            serde_json::from_str(raw).map_err(|e| format!("unreadable report: {e}"))?;
        let sections: Vec<Section> = spec
            .sections
            .into_iter()
            .filter(|s| !s.sql.trim().is_empty())
            .collect();
        if sections.is_empty() {
            return Err("a report needs at least one section with a statement".into());
        }
        Ok(Spec { sections })
    }
}

/// One section's result, as it is stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionResult {
    pub title: String,
    pub sql: String,
    /// Names *and* types. A snapshot that kept only names would leave the
    /// reader unable to draw it: a chart needs to know which column is a time
    /// and which is a number, and by then the query is long gone.
    pub columns: Vec<crate::clickhouse::ColumnMeta>,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// True when the section hit `SECTION_ROW_CAP` and there was more behind
    /// it. Stated rather than implied.
    pub truncated: bool,
    /// Set when this section could not run. The other sections still ran: one
    /// broken statement should cost you that section, not the report.
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub chart: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Monday 2024-01-01, midnight at unix 1704067200, and it is 09:30.
    fn monday_at(minutes: i64) -> Clock {
        let midnight = 1_704_067_200;
        Clock {
            now_ts: midnight + minutes * 60,
            midnight_ts: midnight,
            dow: 1,
        }
    }

    #[test]
    fn a_daily_report_waits_for_its_hour() {
        let daily = Schedule::Daily { minute: 540 }; // 09:00
        assert!(!is_due(&daily, &monday_at(480), None), "08:00 is too early");
        assert!(is_due(&daily, &monday_at(540), None), "09:00 is the moment");
        assert!(is_due(&daily, &monday_at(700), None), "later still counts");
    }

    #[test]
    fn a_daily_report_runs_once_a_day() {
        let daily = Schedule::Daily { minute: 540 };
        let clock = monday_at(600);
        let slot = clock.midnight_ts + 540 * 60;
        assert!(
            !is_due(&daily, &clock, Some(slot + 60)),
            "already served today"
        );
        assert!(
            is_due(&daily, &clock, Some(slot - 86_400)),
            "yesterday's run does not serve today"
        );
    }

    #[test]
    fn a_restart_does_not_re_run_the_morning_report() {
        // The reason due-ness reads the recorded run rather than memory: this
        // is a process that just started and knows nothing.
        let daily = Schedule::Daily { minute: 540 };
        let clock = monday_at(545);
        let served = clock.midnight_ts + 540 * 60 + 30;
        assert!(!is_due(&daily, &clock, Some(served)));
    }

    #[test]
    fn a_report_missed_while_flint_was_down_still_runs() {
        let daily = Schedule::Daily { minute: 540 };
        // Back up at 09:40 having never run today.
        assert!(is_due(&daily, &monday_at(580), Some(1_704_067_200 - 3600)));
    }

    #[test]
    fn a_weekly_report_only_fires_on_its_day() {
        let weekly = Schedule::Weekly {
            dow: 3,
            minute: 540,
        };
        let monday = monday_at(600);
        assert!(!is_due(&weekly, &monday, None), "Monday is not Wednesday");
        let wednesday = Clock { dow: 3, ..monday };
        assert!(is_due(&weekly, &wednesday, None));
    }

    #[test]
    fn an_interval_report_counts_from_its_last_run() {
        let every = Schedule::Every { hours: 6 };
        let clock = monday_at(600);
        assert!(is_due(&every, &clock, None), "never run: run now");
        assert!(!is_due(&every, &clock, Some(clock.now_ts - 3600)));
        assert!(is_due(&every, &clock, Some(clock.now_ts - 6 * 3600)));
    }

    #[test]
    fn a_slot_missed_by_more_than_a_day_is_not_served_late() {
        // Nobody wants Monday's summary on Thursday, and the numbers it would
        // carry are today's anyway.
        let daily = Schedule::Daily { minute: 540 };
        assert!(!too_late(&daily, &monday_at(600)));
        assert!(!too_late(&daily, &monday_at(540 + 1439)));
        let much_later = Clock {
            now_ts: 1_704_067_200 + 540 * 60 + 86_401 + 60,
            ..monday_at(0)
        };
        assert!(too_late(&daily, &much_later));
    }

    #[test]
    fn an_interval_schedule_is_never_too_late() {
        assert!(!too_late(&Schedule::Every { hours: 1 }, &monday_at(600)));
    }

    #[test]
    fn a_schedule_that_could_never_come_round_is_refused() {
        assert!(Schedule::parse(r#"{"kind":"daily","minute":2000}"#).is_err());
        assert!(Schedule::parse(r#"{"kind":"weekly","dow":9,"minute":10}"#).is_err());
        assert!(Schedule::parse(r#"{"kind":"every","hours":0}"#).is_err());
        assert!(Schedule::parse(r#"{"kind":"every","hours":100000}"#).is_err());
        assert!(Schedule::parse("nonsense").is_err());
        assert!(Schedule::parse(r#"{"kind":"never"}"#).is_err());
    }

    #[test]
    fn a_schedule_round_trips() {
        for raw in [
            r#"{"kind":"every","hours":6}"#,
            r#"{"kind":"daily","minute":540}"#,
            r#"{"kind":"weekly","dow":1,"minute":0}"#,
        ] {
            let s = Schedule::parse(raw).expect(raw);
            let back = Schedule::parse(&serde_json::to_string(&s).unwrap()).unwrap();
            assert_eq!(s, back);
        }
    }

    #[test]
    fn a_report_with_no_usable_section_is_refused() {
        assert!(Spec::parse(r#"{"sections":[]}"#).is_err());
        assert!(Spec::parse(r#"{"sections":[{"title":"a","sql":"  "}]}"#).is_err());
        let spec =
            Spec::parse(r#"{"sections":[{"title":"a","sql":"SELECT 1"},{"title":"b","sql":""}]}"#)
                .expect("keeps the usable one");
        assert_eq!(spec.sections.len(), 1);
    }
}
