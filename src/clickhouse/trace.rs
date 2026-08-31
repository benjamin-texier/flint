//! Where the processor actually went, from `system.trace_log`.
//!
//! The profiler interrupts every thread on a timer and writes down the stack it
//! was in. Four things about reading that back had to be measured rather than
//! assumed, and each one changes what the page can honestly say.
//!
//! **Count the innermost frame, not every frame.** A stack of thirty frames has
//! twenty-eight of thread-pool plumbing in it, identical in every sample, so
//! counting all of them ranks `ThreadPoolImpl::worker()` above everything and
//! says nothing. Measured under real load: every frame put `__thread_proxy`,
//! `worker()` and `executeStep` at the top, while `trace[1]` alone put
//! `sipHash64Keyed` there — which is the function the query was actually in.
//!
//! **Symbolising needs a setting that is off.** `allow_introspection_functions`
//! defaults to `0` and without it `addressToSymbol` answers `Code: 446 …
//! FUNCTION_NOT_ALLOWED`. Flint turns it on in the statement's own `SETTINGS`
//! clause, which affects that one read and nothing else — so it is deliberately
//! *not* in `ATTACHED_SETTINGS`, because it never reaches another query's
//! `system.settings`.
//!
//! **Not every address has a name.** Roughly half of the frames across an idle
//! server resolve, and the rest come back empty — inlined, or in a region the
//! build ships no symbol for. `addressToLine` gives only `/usr/bin/clickhouse`:
//! the official build carries no line tables at all. So the page names what it
//! can and *counts* what it cannot, rather than quietly dropping it.
//!
//! **`CPU` and `Real` are different questions.** `CPU` samples processor time and
//! answers "what was it computing"; `Real` samples wall-clock and includes every
//! thread that was waiting, which is why an idle server has three million `Real`
//! samples and five thousand `CPU` ones. Asking for one and reading the other is
//! the easiest mistake here, so both are offered and labelled.

use serde::{Deserialize, Serialize};

use super::{Client, Reach};
use crate::error::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frame {
    /// The demangled function, as the build named it.
    pub name: String,
    /// How many samples landed here.
    pub samples: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TraceReport {
    pub frames: Vec<Frame>,
    /// Samples the window holds, named or not. The denominator every figure
    /// above needs: "two samples" out of five is noise and out of five thousand
    /// is a finding, and the number alone cannot tell you which.
    pub samples: u64,
    /// Samples whose innermost address the build could not name.
    pub unnamed: u64,
    /// `CPU` or `Real`, echoed back so the page cannot label the wrong one.
    pub kind: String,
    pub minutes: u64,
    /// What the two kinds of sample answer, in the backend's words.
    ///
    /// Sent rather than restated in the browser. Writing it a second time in
    /// TypeScript is how a warning ends up differing from what the code does,
    /// and this codebase has already had to have that removed from the `SYSTEM`
    /// console once.
    pub kind_says: &'static str,
    /// Why the ranking below should not be trusted, when it should not — too few
    /// samples, or none at all. Empty when the window holds enough.
    pub note: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
}

fn empty(kind: &str, minutes: u64, blocked: String) -> TraceReport {
    TraceReport {
        frames: Vec::new(),
        samples: 0,
        unnamed: 0,
        kind: kind.to_string(),
        minutes,
        kind_says: says_kind(kind),
        note: String::new(),
        blocked: Some(blocked),
    }
}

/// Whether a sampling window holds enough to say anything.
///
/// The profiler fires once a second per thread, so a five-minute window on a
/// quiet server can hold a dozen samples, and a bar chart over a dozen samples
/// is a picture of nothing. Thirty is not a statistical threshold — it is the
/// point below which the page says how few there are instead of drawing them.
const ENOUGH: u64 = 30;

/// `1 minute` but `15 minutes` — the window is a figure the reader is asked to
/// weigh a sample count against, and "in 1 minutes" makes a sentence look
/// generated rather than written.
fn plural(n: u64, word: &str) -> String {
    if n == 1 {
        format!("{n} {word}")
    } else {
        format!("{n} {word}s")
    }
}

/// What to say about the sample count, or nothing when it is plentiful.
fn thin(samples: u64, minutes: u64) -> Option<String> {
    let window = plural(minutes, "minute");
    if samples == 0 {
        return Some(format!(
            "Nothing was sampled in {window}. The profiler fires once a second per busy thread, \
             so an idle server produces no samples at all — this is what quiet looks like, not a \
             failure to look."
        ));
    }
    if samples < ENOUGH {
        return Some(format!(
            "{} in {window}. That is too few to rank anything by: the profiler fires once a \
             second per busy thread, so this is a handful of instants and not a measurement.",
            plural(samples, "sample")
        ));
    }
    None
}

pub async fn trace(ch: &Client, kind: &str, minutes: u64, limit: u64) -> Result<TraceReport> {
    // `CPU` and `Real` are the two worth offering, and anything else is a
    // caller's mistake rather than a value to pass through into SQL.
    let kind = if kind.eq_ignore_ascii_case("real") {
        "Real"
    } else {
        "CPU"
    };
    let minutes = minutes.clamp(1, 1440);

    let blocked = match ch.reach("trace_log").await? {
        Reach::Readable => None,
        Reach::Denied => Some("this user cannot read system.trace_log".to_string()),
        Reach::Absent | Reach::Unconfigured => Some(
            "this server has no system.trace_log — the query profiler writes it, and it can be \
             switched off"
                .to_string(),
        ),
    };
    if let Some(reason) = blocked {
        return Ok(empty(kind, minutes, reason));
    }

    // `allow_introspection_functions` in the statement's own clause rather than
    // on the request: it applies to this read and to nothing else, so it never
    // turns up in another query's settings.
    #[derive(Deserialize)]
    struct Totals {
        samples: u64,
        unnamed: u64,
    }
    let totals: Option<Totals> = ch
        .row(&format!(
            "SELECT count() AS samples, \
                    countIf(addressToSymbol(trace[1]) = '') AS unnamed \
             FROM system.trace_log \
             WHERE trace_type = '{kind}' AND event_time > now() - INTERVAL {minutes} MINUTE \
             SETTINGS allow_introspection_functions = 1"
        ))
        .await?;
    let (samples, unnamed) = totals.map(|t| (t.samples, t.unnamed)).unwrap_or((0, 0));

    let frames: Vec<Frame> = ch
        .rows(&format!(
            "SELECT demangle(addressToSymbol(trace[1])) AS name, count() AS samples \
             FROM system.trace_log \
             WHERE trace_type = '{kind}' AND event_time > now() - INTERVAL {minutes} MINUTE \
               AND addressToSymbol(trace[1]) != '' \
             GROUP BY name ORDER BY samples DESC LIMIT {} \
             SETTINGS allow_introspection_functions = 1",
            limit.clamp(1, 100)
        ))
        .await?;

    Ok(TraceReport {
        frames,
        samples,
        unnamed,
        kind: kind.to_string(),
        minutes,
        kind_says: says_kind(kind),
        note: thin(samples, minutes).unwrap_or_default(),
        blocked: None,
    })
}

/// What the two kinds of sample actually answer.
///
/// The easiest mistake here is asking for one and reading the other: an idle
/// server had three million `Real` samples against five thousand `CPU` ones,
/// because `Real` counts every thread that was waiting.
fn says_kind(kind: &str) -> &'static str {
    if kind.eq_ignore_ascii_case("real") {
        "Wall-clock samples: where threads were, including every one that was waiting. Good for \
         finding what blocked, misleading if read as work done."
    } else {
        "Processor samples: where the CPU actually was. Good for finding what computed, and \
         silent about anything that spent its time waiting."
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_handful_of_samples_is_said_rather_than_drawn() {
        // The profiler fires once a second per busy thread, so a five-minute
        // window on a quiet server holds a dozen — and a ranking over a dozen is
        // a picture of nothing.
        let says = thin(12, 5).expect("too few");
        assert!(says.contains("12 samples in 5 minutes"));
        // One of anything is singular, in both halves of the sentence.
        assert!(thin(1, 1).expect("one").contains("1 sample in 1 minute."));
        assert!(says.contains("not a measurement"));
        assert!(thin(ENOUGH, 5).is_none());
        assert!(thin(5_000, 5).is_none());
    }

    #[test]
    fn nothing_sampled_is_quiet_rather_than_broken() {
        // An idle server produces no samples at all, and reading that as a
        // failure would have every healthy machine look wrong.
        let says = thin(0, 30).expect("nothing");
        assert!(says.contains("in 30 minutes"));
        assert!(says.contains("this is what quiet looks like"));
        assert!(!says.contains("too few"));
    }

    #[test]
    fn the_two_kinds_are_not_described_the_same_way() {
        // Asking for one and reading the other is the easiest mistake here.
        assert!(says_kind("CPU").contains("where the CPU actually was"));
        assert!(says_kind("Real").contains("including every one that was waiting"));
        // Anything unrecognised falls to CPU, which is what the reader does too.
        assert_eq!(says_kind("nonsense"), says_kind("CPU"));
        assert_eq!(says_kind("real"), says_kind("Real"));
    }
}
