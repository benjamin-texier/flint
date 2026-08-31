//! Operating the server: the handful of `SYSTEM` statements worth a button.
//!
//! Chosen rather than enumerated. ClickHouse has dozens of `SYSTEM` commands and
//! most of them are either meaningless outside a cluster or a way to break a
//! machine quietly; these eight are the ones an operator reaches for, and each
//! one carries the sentence saying what it costs — *before* the click, not in
//! the job list afterwards.
//!
//! One of them needed a decision. **`SYSTEM STOP MERGES` has no light.** The
//! server exposes no flag for it: the `Merge` metric reads zero whether merges
//! are stopped or merely idle, and no system table records the state — verified
//! by stopping them and looking. So a tool offering the switch is offering one
//! with nothing to show its position. The answer is not to hide it, because
//! stopping merges is a real thing operators need during a heavy import; it is
//! to say plainly that the server does not report the state and that Flint's own
//! job list — who stopped them, and when — is the only record there is.

use serde::{Deserialize, Serialize};

/// A `SYSTEM` statement Flint will send.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Command {
    /// Write out the buffered `*_log` tables now.
    ///
    /// The most useful of the lot and the least dangerous: every log table
    /// flushes on a timer, so a query that just ran is not in `query_log` for
    /// several seconds, and the diagnose pages that read it look wrong rather
    /// than lagging.
    FlushLogs,
    /// Re-read the configuration files.
    ReloadConfig,
    /// Re-read the dictionary definitions.
    ReloadDictionaries,
    /// Forget where the marks are, so the next read fetches them again.
    DropMarkCache,
    /// Forget the decompressed blocks.
    DropUncompressedCache,
    /// Forget the cached query results.
    DropQueryCache,
    /// Stop merging parts in the background.
    StopMerges,
    /// Start again.
    StartMerges,
}

impl Command {
    pub fn statement(self) -> &'static str {
        match self {
            Command::FlushLogs => "SYSTEM FLUSH LOGS",
            Command::ReloadConfig => "SYSTEM RELOAD CONFIG",
            Command::ReloadDictionaries => "SYSTEM RELOAD DICTIONARIES",
            Command::DropMarkCache => "SYSTEM DROP MARK CACHE",
            Command::DropUncompressedCache => "SYSTEM DROP UNCOMPRESSED CACHE",
            Command::DropQueryCache => "SYSTEM DROP QUERY CACHE",
            Command::StopMerges => "SYSTEM STOP MERGES",
            Command::StartMerges => "SYSTEM START MERGES",
        }
    }

    /// One line for the job list, as a sentence.
    pub fn label(self) -> &'static str {
        match self {
            Command::FlushLogs => "Flush the log tables",
            Command::ReloadConfig => "Reload the configuration files",
            Command::ReloadDictionaries => "Reload the dictionaries",
            Command::DropMarkCache => "Drop the mark cache",
            Command::DropUncompressedCache => "Drop the uncompressed cache",
            Command::DropQueryCache => "Drop the query cache",
            Command::StopMerges => "Stop background merges",
            Command::StartMerges => "Start background merges",
        }
    }

    /// What it actually does, said before it is pressed.
    ///
    /// Every one of these is instant and none of them destroys data, which is
    /// exactly why they need this: a button that returns immediately and says
    /// nothing invites being pressed to see what happens. Three of them make the
    /// server slower for a while and one of them can stop it accepting inserts.
    pub fn costs(self) -> &'static str {
        match self {
            Command::FlushLogs => {
                "Writes the buffered log tables out now. Costs a moment of IO and nothing else — \
                 this is what to press when a query you just ran is not in the query log yet."
            }
            Command::ReloadConfig => {
                "Re-reads the configuration files. Only the settings marked changeable without a \
                 restart will move; the rest are read and ignored until the server is restarted."
            }
            Command::ReloadDictionaries => {
                "Re-reads every dictionary definition and reloads the ones that changed. A large \
                 dictionary reloads by fetching its whole source again."
            }
            Command::DropMarkCache => {
                "The next read of every table fetches its marks from disk again. Queries are \
                 slower until the cache refills — measurably, on a busy server."
            }
            Command::DropUncompressedCache => {
                "The next read decompresses again. Slower until it refills, and harmless."
            }
            Command::DropQueryCache => {
                "Cached query results are forgotten, so the queries that were being answered from \
                 the cache run for real again."
            }
            Command::StopMerges => {
                // The observability of it is not said here. It is `observable`
                // returning false, which the UI renders as its own warning —
                // saying it in both places put two sentences about one fact
                // under one button.
                "Parts stop being merged and start piling up. A table over parts_to_throw_insert \
                 refuses inserts entirely, so this is a thing to do for minutes and not for hours."
            }
            Command::StartMerges => {
                "Merging resumes, and the parts that piled up while it was stopped are merged now \
                 — which is a burst of IO proportional to how long it was off."
            }
        }
    }

    /// Whether the server will show you afterwards that this took effect.
    ///
    /// `false` for the two that toggle a state ClickHouse keeps to itself. The
    /// UI says so rather than implying a switch it can read back.
    pub fn observable(self) -> bool {
        !matches!(self, Command::StopMerges | Command::StartMerges)
    }

    /// The machine word for the job row.
    pub fn kind(self) -> &'static str {
        "system"
    }

    /// Two or three words, for a button.
    ///
    /// Separate from [`label`] on purpose: a job row wants a sentence — "Stop
    /// background merges", read weeks later next to who ran it — and a button
    /// wants the shortest thing that is still unambiguous. Publishing the
    /// sentence as a button label was the first attempt, and it made a strip of
    /// eight buttons that wrapped onto two rows.
    pub fn short(self) -> &'static str {
        match self {
            Command::FlushLogs => "Flush logs",
            Command::ReloadConfig => "Reload config",
            Command::ReloadDictionaries => "Reload dictionaries",
            Command::DropMarkCache => "Drop mark cache",
            Command::DropUncompressedCache => "Drop uncompressed cache",
            Command::DropQueryCache => "Drop query cache",
            Command::StopMerges => "Stop merges",
            Command::StartMerges => "Start merges",
        }
    }

    /// The name the API takes, which is the serde spelling.
    ///
    /// Written out rather than derived, because it has to match what
    /// `Deserialize` accepts and a `Debug` string would not: a command whose id
    /// the server publishes but will not accept is a button that fails.
    pub fn id(self) -> &'static str {
        match self {
            Command::FlushLogs => "flush-logs",
            Command::ReloadConfig => "reload-config",
            Command::ReloadDictionaries => "reload-dictionaries",
            Command::DropMarkCache => "drop-mark-cache",
            Command::DropUncompressedCache => "drop-uncompressed-cache",
            Command::DropQueryCache => "drop-query-cache",
            Command::StopMerges => "stop-merges",
            Command::StartMerges => "start-merges",
        }
    }
}

/// One command, as the browser needs it.
///
/// Published rather than restated in the frontend. The first version of the
/// console kept its own copy of these eight labels and eight paragraphs, which
/// made the compiler tell me the backend's own copies were dead — and a second
/// copy of a warning about `parts_to_throw_insert` is a warning that will
/// eventually differ from the one the button actually acts under.
#[derive(Debug, Clone, Serialize)]
pub struct Published {
    pub id: &'static str,
    pub label: &'static str,
    pub statement: &'static str,
    pub costs: &'static str,
    pub observable: bool,
}

/// Every command the console offers.
pub fn catalogue() -> Vec<Published> {
    ALL.iter()
        .map(|&c| Published {
            id: c.id(),
            label: c.short(),
            statement: c.statement(),
            costs: c.costs(),
            observable: c.observable(),
        })
        .collect()
}

/// Every command, in the order the UI lists them: the harmless one first,
/// because it is the one that is actually wanted, and the two that change a
/// state last.
pub const ALL: [Command; 8] = [
    Command::FlushLogs,
    Command::ReloadConfig,
    Command::ReloadDictionaries,
    Command::DropQueryCache,
    Command::DropUncompressedCache,
    Command::DropMarkCache,
    Command::StopMerges,
    Command::StartMerges,
];

// ── One replica at a time ───────────────────────────────────────────────────
//
// The four `SYSTEM` statements about one replicated table — sync, restart, and
// the fetch pair — already live in `crate::jobs::ReplicaAction`, which the
// Replication page drives. Two findings from verifying them belong here beside
// their server-wide cousins rather than in a second copy of the enum:
//
// * **The fetch pair has no light**, exactly as the merge pair does not. No
//   column of `system.replicas` reports that fetching is stopped, and the
//   `ReplicatedFetch` metric reads zero whether it is stopped or merely idle.
//   The job row is the only record.
// * **`SYSTEM RESTORE REPLICA` is not offered**, and the reason is below.

/// What to do about a replica that has gone read-only, in words.
///
/// Not a button, and the absence is the considered part. `SYSTEM RESTORE
/// REPLICA` is the repair for a replica whose Keeper metadata is gone while its
/// data is not, and three attempts to produce that state on a real two-replica
/// cluster all failed to reach it: dropping the replica from its peer does
/// nothing while it is active and did not stick while it was stopped, and
/// emptying Keeper entirely — recreating its container, so the servers kept
/// their data and the ensemble kept nothing — ended with both replicas
/// re-registering themselves, five hundred rows each, `absolute_delay` zero and
/// `is_readonly` never once true.
///
/// So the refusal is verified — `Code: 36. DB::Exception: Replica must be
/// readonly.` — and the success is not. A destructive repair nobody has watched
/// work is exactly the button not to ship, so the statement is named and the
/// running of it left to somebody who means it.
pub fn readonly_remedy(database: &str, table: &str, readonly_for: u64) -> String {
    let since = if readonly_for > 0 {
        format!(" It has been read-only for {readonly_for} seconds.")
    } else {
        String::new()
    };
    format!(
        "This replica accepts no writes.{since} If its Keeper metadata is gone while its data is \
         not, the repair is SYSTEM RESTORE REPLICA {database}.{table} — which Flint will not \
         run for you: it rebuilds the replica's registration from what is on this disk, and \
         nobody here has watched it work."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_command_says_what_it_costs() {
        // A button that returns immediately and says nothing invites being
        // pressed to see what happens.
        for c in ALL {
            assert!(c.statement().starts_with("SYSTEM "), "{c:?}");
            assert!(!c.label().is_empty(), "{c:?}");
            // A button label long enough to wrap a strip of eight is a
            // different failure from an empty one.
            assert!(c.short().len() <= 24, "{c:?} is too long for a button");
            assert!(c.costs().len() > 40, "{c:?} has nothing to say for itself");
        }
    }

    #[test]
    fn the_two_with_no_light_are_named() {
        // Verified against the server: the `Merge` metric reads zero whether
        // merges are stopped or idle, and no system table records the state.
        assert!(!Command::StopMerges.observable());
        assert!(!Command::StartMerges.observable());
        assert!(Command::FlushLogs.observable());
        assert!(Command::DropMarkCache.observable());
    }

    #[test]
    fn stopping_merges_says_the_thing_that_breaks_a_server() {
        let says = Command::StopMerges.costs();
        assert!(says.contains("parts_to_throw_insert"));
        // And says it once. That it leaves no trace is `observable`'s to report,
        // and the UI draws that as its own warning — an earlier version said it
        // in both places, which put two sentences about one fact under one
        // button.
        assert!(!says.contains("only record"));
        assert!(!Command::StopMerges.observable());
    }

    #[test]
    fn every_published_id_is_one_the_api_accepts() {
        // A command whose id the server publishes but will not deserialize is a
        // button that fails, and the two spellings live in different matches.
        for c in catalogue() {
            let parsed: Command = serde_json::from_str(&format!("\"{}\"", c.id))
                .unwrap_or_else(|e| panic!("published id `{}` is not accepted: {e}", c.id));
            assert_eq!(parsed.short(), c.label);
        }
    }

    #[test]
    fn the_remedy_names_the_statement_and_declines_to_run_it() {
        let says = readonly_remedy("lab", "pair", 900);
        assert!(says.contains("SYSTEM RESTORE REPLICA lab.pair"));
        assert!(says.contains("900 seconds"));
        // The whole point: it is named, not offered.
        assert!(says.contains("will not run it") || says.contains("will not run for you"));
    }

    #[test]
    fn the_remedy_drops_a_duration_it_does_not_have() {
        // An older server has no `readonly_duration`, and zero is the honest
        // stand-in — printing "read-only for 0 seconds" would be a figure Flint
        // invented.
        let says = readonly_remedy("lab", "pair", 0);
        assert!(!says.contains("0 seconds"));
        assert!(says.contains("SYSTEM RESTORE REPLICA"));
    }

    #[test]
    fn the_list_is_ordered_least_harmful_first() {
        assert_eq!(ALL[0], Command::FlushLogs);
        assert_eq!(ALL[ALL.len() - 2], Command::StopMerges);
    }
}
