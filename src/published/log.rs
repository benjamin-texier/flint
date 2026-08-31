//! Calls, buffered and written in batches.
//!
//! The obvious implementation writes one row per call, and it is wrong in a way
//! that only shows up on the endpoints worth having. ClickHouse creates a *part*
//! per insert and merges them in the background; an endpoint taking thirty
//! thousand calls a day therefore produces thirty thousand parts a day for a
//! table holding a few megabytes, and the failure that eventually arrives —
//! `TOO_MANY_PARTS` — arrives on the workspace, which is where the alerts and
//! the dashboards live too. A usage panel is not worth taking those down for.
//!
//! So calls accumulate here and are written a few seconds later, in one insert.
//! Three consequences, each of which the rest of the code has to know about:
//!
//! **A quota counts what has been flushed plus what is waiting.** The count
//! lives in ClickHouse and the newest calls do not, so asking the table alone
//! would let a caller overshoot by a whole flush window — which on a key doing
//! ten calls a second is a real overshoot rather than a rounding error.
//!
//! **A crash loses the buffer.** That is the right thing to lose: these are
//! rows in a usage panel, and the alternative — making the call wait for its
//! own bookkeeping — trades a caller's latency for a figure nobody is reading
//! at that moment.
//!
//! **The buffer is capped, and says what it dropped.** A ClickHouse that stops
//! accepting writes must not turn into a Flint that grows until it is killed.
//! Past the cap the oldest rows go and a counter goes up, and the counter is
//! reported rather than swallowed — a usage panel quietly missing an hour is
//! worse than one that says it is.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::workspace::CallRecord;

/// How long a call may sit before it is written. Short enough that a quota is
/// never far out of date and a page refreshed after a call shows it; long
/// enough that a busy endpoint produces a handful of parts a minute rather
/// than thousands.
pub const FLUSH_AFTER: Duration = Duration::from_secs(5);

/// Flush early once this many are waiting, whatever the clock says. A burst
/// should not be held for five seconds just because it arrived in one.
pub const FLUSH_AT: usize = 500;

/// The most calls to hold. Reached only when ClickHouse has stopped accepting
/// writes, since anything else drains it every few seconds.
const CAPACITY: usize = 50_000;

#[derive(Default)]
struct Held {
    calls: Vec<CallRecord>,
    /// Rows thrown away for want of room, since the last time this was
    /// reported. Never reset by a flush — only by whoever reads it, so it
    /// cannot be lost between two of them.
    dropped: u64,
    /// When the oldest waiting row arrived, or `None` when nothing is waiting.
    since: Option<Instant>,
}

/// Calls waiting to be written.
#[derive(Default)]
pub struct CallLog {
    held: Mutex<Held>,
}

impl CallLog {
    pub fn new() -> CallLog {
        CallLog::default()
    }

    /// Take one call. Never fails and never blocks on anything but the buffer's
    /// own lock: this is on the way out of a request that has already been
    /// answered.
    pub fn record(&self, call: CallRecord) {
        let Ok(mut held) = self.held.lock() else {
            return;
        };
        if held.calls.len() >= CAPACITY {
            // The oldest goes. A usage panel with the newest hour missing is
            // less useful than one with the oldest hour missing — somebody is
            // looking at it because something is happening now.
            held.calls.remove(0);
            held.dropped += 1;
        }
        if held.since.is_none() {
            held.since = Some(Instant::now());
        }
        held.calls.push(call);
    }

    /// Whether it is time to write.
    pub fn due(&self) -> bool {
        let Ok(held) = self.held.lock() else {
            return false;
        };
        match held.since {
            None => false,
            Some(since) => held.calls.len() >= FLUSH_AT || since.elapsed() >= FLUSH_AFTER,
        }
    }

    /// Everything waiting, and how many were dropped since this was last asked.
    ///
    /// Both come out together and both are cleared together, so a caller that
    /// takes the rows also takes responsibility for reporting the loss — there
    /// is no way to read one and forget the other.
    pub fn take(&self) -> (Vec<CallRecord>, u64) {
        let Ok(mut held) = self.held.lock() else {
            return (Vec::new(), 0);
        };
        held.since = None;
        let dropped = std::mem::take(&mut held.dropped);
        (std::mem::take(&mut held.calls), dropped)
    }

    /// Put rows back after a failed write.
    ///
    /// In front of whatever arrived while the insert was in flight, so the log
    /// stays in the order the calls happened — and subject to the same cap, so
    /// a ClickHouse that has been refusing writes for an hour cannot be made to
    /// grow the buffer past it by retrying.
    pub fn give_back(&self, mut calls: Vec<CallRecord>) {
        let Ok(mut held) = self.held.lock() else {
            return;
        };
        calls.append(&mut held.calls);
        let over = calls.len().saturating_sub(CAPACITY);
        if over > 0 {
            calls.drain(..over);
            held.dropped += over as u64;
        }
        if !calls.is_empty() && held.since.is_none() {
            held.since = Some(Instant::now());
        }
        held.calls = calls;
    }

    /// Answered calls this key has made to this address that are still waiting
    /// to be written.
    ///
    /// Added to the count ClickHouse holds, because a quota read from the table
    /// alone lags by a flush window — and on a key doing ten calls a second
    /// that is fifty calls of overshoot, not a rounding error.
    ///
    /// Refusals are not counted here for the same reason they are not counted
    /// there: a quota that ate the calls it refused would lock a caller out for
    /// the rest of the day the moment they hit it once.
    pub fn pending(&self, key_id: &str, slug: &str) -> u64 {
        let Ok(held) = self.held.lock() else {
            return 0;
        };
        held.calls
            .iter()
            .filter(|c| c.key_id == key_id && c.slug == slug && c.status < 400)
            .count() as u64
    }

    /// How many are waiting, for a health reading.
    pub fn waiting(&self) -> usize {
        self.held.lock().map(|h| h.calls.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(key: &str, slug: &str, status: u16) -> CallRecord {
        CallRecord {
            slug: slug.into(),
            key_id: key.into(),
            status,
            ..Default::default()
        }
    }

    #[test]
    fn nothing_is_due_while_nothing_is_waiting() {
        let log = CallLog::new();
        assert!(!log.due());
        assert_eq!(log.waiting(), 0);
    }

    #[test]
    fn a_burst_is_written_without_waiting_for_the_clock() {
        let log = CallLog::new();
        for _ in 0..FLUSH_AT - 1 {
            log.record(call("k", "s", 200));
        }
        assert!(!log.due(), "a partial batch should still be waiting");
        log.record(call("k", "s", 200));
        assert!(log.due(), "a full batch should not wait for the clock");
    }

    #[test]
    fn taking_the_rows_takes_the_losses_with_them() {
        let log = CallLog::new();
        log.record(call("k", "s", 200));
        let (calls, dropped) = log.take();
        assert_eq!(calls.len(), 1);
        assert_eq!(dropped, 0);
        // …and the buffer is empty afterwards, so nothing is written twice.
        assert_eq!(log.waiting(), 0);
        assert!(!log.due());
    }

    #[test]
    fn the_buffer_is_capped_and_counts_what_it_threw_away() {
        // Only reachable when ClickHouse has stopped accepting writes; the
        // point is that Flint is not killed for it.
        let log = CallLog::new();
        for i in 0..CAPACITY + 25 {
            log.record(call("k", &format!("s{i}"), 200));
        }
        let (calls, dropped) = log.take();
        assert_eq!(calls.len(), CAPACITY);
        assert_eq!(dropped, 25);
        // The oldest went, so the newest are the ones kept.
        assert_eq!(calls.last().map(|c| c.slug.as_str()), Some("s50024"));
    }

    #[test]
    fn a_loss_survives_until_somebody_reads_it() {
        let log = CallLog::new();
        for i in 0..CAPACITY + 1 {
            log.record(call("k", &format!("s{i}"), 200));
        }
        // A flush that happens before anyone reports the loss must not lose the
        // count too.
        let (_, dropped) = log.take();
        assert_eq!(dropped, 1);
        let (_, again) = log.take();
        assert_eq!(again, 0, "a loss should be reported once, not for ever");
    }

    #[test]
    fn rows_handed_back_after_a_failed_write_keep_their_order() {
        let log = CallLog::new();
        let earlier = vec![call("k", "first", 200), call("k", "second", 200)];
        log.record(call("k", "third", 200));
        log.give_back(earlier);
        let (calls, _) = log.take();
        let order: Vec<&str> = calls.iter().map(|c| c.slug.as_str()).collect();
        assert_eq!(order, vec!["first", "second", "third"]);
    }

    #[test]
    fn handing_rows_back_cannot_grow_the_buffer_past_its_cap() {
        // A ClickHouse refusing writes for an hour would otherwise make the
        // retry the thing that runs Flint out of memory.
        let log = CallLog::new();
        for i in 0..CAPACITY {
            log.record(call("k", &format!("s{i}"), 200));
        }
        log.give_back(vec![call("k", "older", 200), call("k", "older-still", 200)]);
        let (calls, dropped) = log.take();
        assert_eq!(calls.len(), CAPACITY);
        assert_eq!(dropped, 2);
    }

    #[test]
    fn handing_back_an_empty_batch_does_not_start_a_clock() {
        let log = CallLog::new();
        log.give_back(Vec::new());
        assert!(!log.due());
        assert_eq!(log.waiting(), 0);
    }

    #[test]
    fn a_quota_sees_the_calls_that_are_still_waiting() {
        // The count lives in ClickHouse and these do not, so a quota read from
        // the table alone lags by a whole flush window.
        let log = CallLog::new();
        for _ in 0..3 {
            log.record(call("app", "device_daily", 200));
        }
        assert_eq!(log.pending("app", "device_daily"), 3);
        // Another key, and another address, are not this one.
        assert_eq!(log.pending("bot", "device_daily"), 0);
        assert_eq!(log.pending("app", "fleet_p95"), 0);
    }

    #[test]
    fn a_refusal_does_not_eat_the_allowance_it_was_refused_by() {
        let log = CallLog::new();
        log.record(call("app", "device_daily", 200));
        log.record(call("app", "device_daily", 429));
        log.record(call("app", "device_daily", 403));
        assert_eq!(log.pending("app", "device_daily"), 1);
    }
}
