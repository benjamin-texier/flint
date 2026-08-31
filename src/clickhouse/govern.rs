//! Writing the three families `limits.rs` reads: quotas, settings profiles and
//! row policies.
//!
//! Each statement is built here rather than typed, and each of the three had one
//! thing worth building it for — found by asking the server, not by reading the
//! grammar.
//!
//! **A row policy with no `TO` applies to nobody.** `CREATE ROW POLICY p ON t
//! USING tenant = 'c'` reads like "restrict this table to tenant c" and does
//! nothing at all: the server stores it with `apply_to_all = 0` and an empty
//! list, the statement succeeds, every account still sees every row, and nothing
//! anywhere says so. Measured. So Flint will not create one — the same rule as
//! refusing to make a user with no password, and for the same reason.
//!
//! **A quota's intervals need a comma between them.** `FOR INTERVAL 1 minute MAX
//! queries = 60 FOR INTERVAL 1 hour MAX queries = 1000` is accepted by
//! ClickHouse and **keeps only the last interval** — silently. The development
//! fixture was written that way and read back with one interval where two were
//! meant. Building the statement here is what makes that impossible rather than
//! documented.
//!
//! **`ALTER` means two opposite things under two nearly identical shapes.**
//! `ALTER SETTINGS PROFILE p SETTINGS max_threads = 8` **replaces the whole
//! list** — a profile with three settings came back with one — while
//! `ALTER QUOTA q FOR INTERVAL 1 minute MAX queries = 20` **amends**, leaving the
//! hour interval exactly as it was. Measured, both.
//!
//! So Flint sends the whole picture every time, pre-filled from what is there,
//! and the asymmetry stops being something anybody has to know. It is written
//! down here because the next person to add a field will otherwise have to
//! rediscover it.
//!
//! **Altering is not dropping and recreating.** `ALTER QUOTA … MAX queries =
//! 2000` keeps what has been consumed — five queries against the new ceiling —
//! and `DROP` then `CREATE` resets it to zero. So raising a ceiling the second
//! way silently forgives everything spent so far, and for a row policy the drop
//! leaves the table unprotected between the two statements. That is the whole
//! reason these six exist beside the six that make and remove.
//!
//! **A profile's constraints are three different clauses.** `MIN`, `MAX` and
//! `READONLY` after a setting are separate things, and `READONLY` is what
//! `system.settings_profile_elements` reports back as `writability = CONST` —
//! two vocabularies for one fact, which is why the form uses the server's word
//! for reading and ClickHouse's for writing.

use serde::Deserialize;

/// The dimensions a quota can cap, spelled as the `MAX` clause spells them.
///
/// The same words `system.quota_limits` uses for its columns, which is not a
/// coincidence and is worth relying on: one vocabulary for the read and the
/// write means a figure on the screen and the statement that set it cannot drift
/// apart.
pub const DIMENSIONS: [&str; 11] = [
    "queries",
    "query_selects",
    "query_inserts",
    "errors",
    "result_rows",
    "result_bytes",
    "read_rows",
    "read_bytes",
    "written_bytes",
    "failed_sequential_authentications",
    "queries_per_normalized_hash",
];

/// What a quota may be keyed by, as ClickHouse spells it.
pub const KEYS: [&str; 6] = [
    "user_name",
    "ip_address",
    "client_key",
    "client_key_or_user_name",
    "client_key_or_ip_address",
    "forwarded_ip_address",
];

#[derive(Debug, Clone, Deserialize)]
pub struct Cap {
    /// One of [`DIMENSIONS`].
    pub dimension: String,
    pub max: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Interval {
    pub duration_secs: u64,
    pub caps: Vec<Cap>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Setting {
    pub setting: String,
    pub value: String,
    /// Empty where unset.
    #[serde(default)]
    pub min: String,
    #[serde(default)]
    pub max: String,
    /// `READONLY` in the statement, which the server reports back as
    /// `writability = CONST`.
    #[serde(default)]
    pub fixed: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum Change {
    CreatePolicy {
        name: String,
        database: String,
        table: String,
        /// The `USING` expression, the server's to judge.
        filter: String,
        #[serde(default)]
        restrictive: bool,
        /// Who it applies to. Required — see the module note.
        to: Vec<String>,
    },
    DropPolicy {
        name: String,
        database: String,
        table: String,
    },
    CreateQuota {
        name: String,
        #[serde(default)]
        keyed_by: Vec<String>,
        intervals: Vec<Interval>,
        to: Vec<String>,
    },
    DropQuota {
        name: String,
    },
    CreateProfile {
        name: String,
        settings: Vec<Setting>,
        to: Vec<String>,
    },
    DropProfile {
        name: String,
    },
    /// Change a policy without a gap. Dropping and recreating leaves the table
    /// unprotected between the two statements.
    AlterPolicy {
        name: String,
        database: String,
        table: String,
        filter: String,
        #[serde(default)]
        restrictive: bool,
        to: Vec<String>,
    },
    /// Change a quota without forgetting what has been consumed.
    AlterQuota {
        name: String,
        #[serde(default)]
        keyed_by: Vec<String>,
        intervals: Vec<Interval>,
        to: Vec<String>,
    },
    /// Change a profile. The settings are the **whole** list, because the
    /// statement replaces rather than amends.
    AlterProfile {
        name: String,
        settings: Vec<Setting>,
        to: Vec<String>,
    },
}

fn ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn list(names: &[String]) -> String {
    names
        .iter()
        .map(|n| ident(n))
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn kind(change: &Change) -> &'static str {
    match change {
        Change::CreatePolicy { .. } => "create-policy",
        Change::DropPolicy { .. } => "drop-policy",
        Change::CreateQuota { .. } => "create-quota",
        Change::DropQuota { .. } => "drop-quota",
        Change::CreateProfile { .. } => "create-profile",
        Change::DropProfile { .. } => "drop-profile",
        Change::AlterPolicy { .. } => "alter-policy",
        Change::AlterQuota { .. } => "alter-quota",
        Change::AlterProfile { .. } => "alter-profile",
    }
}

/// What this change does to what accounts may do, in a clause for the label — or
/// nothing, where it gives access back.
///
/// The direction is only knowable for the ones that *make* a restriction: a new
/// policy or a new quota takes something away, and dropping one gives it back.
/// An **alter** could go either way, and Flint does not hold the previous state
/// to compare against — raising a ceiling from 1000 to 2000 widens, and the first
/// version of this said "this takes access away" about exactly that. So an alter
/// says it changes things and does not claim which way.
pub fn access_note(change: &Change) -> &'static str {
    match change {
        Change::CreatePolicy { .. } | Change::CreateQuota { .. } => " — this takes access away",
        Change::AlterPolicy { .. } | Change::AlterQuota { .. } | Change::AlterProfile { .. } => {
            " — this changes what those accounts may do"
        }
        _ => "",
    }
}

pub fn statement(change: &Change) -> String {
    match change {
        Change::CreatePolicy {
            name,
            database,
            table,
            filter,
            restrictive,
            to,
        } => format!(
            "CREATE ROW POLICY {} ON {}.{}{} USING {} TO {}",
            ident(name),
            ident(database),
            ident(table),
            if *restrictive { " AS RESTRICTIVE" } else { "" },
            filter,
            list(to)
        ),
        Change::DropPolicy {
            name,
            database,
            table,
        } => format!(
            "DROP ROW POLICY {} ON {}.{}",
            ident(name),
            ident(database),
            ident(table)
        ),
        Change::CreateQuota {
            name,
            keyed_by,
            intervals,
            to,
        } => {
            let keyed = if keyed_by.is_empty() {
                // `NOT KEYED` rather than nothing: without it the server uses
                // its default, and the difference between "sixty queries each"
                // and "sixty between you" should be what was asked for.
                " NOT KEYED".to_string()
            } else {
                format!(" KEYED BY {}", keyed_by.join(", "))
            };
            // The comma between intervals is the whole reason this is built
            // rather than typed: without it ClickHouse keeps the last one and
            // drops the rest, and says nothing.
            let windows: Vec<String> = intervals
                .iter()
                .map(|i| {
                    let caps: Vec<String> = i
                        .caps
                        .iter()
                        .map(|c| format!("{} = {}", c.dimension, c.max))
                        .collect();
                    format!(
                        "FOR INTERVAL {} second MAX {}",
                        i.duration_secs,
                        caps.join(", ")
                    )
                })
                .collect();
            format!(
                "CREATE QUOTA {}{} {} TO {}",
                ident(name),
                keyed,
                windows.join(", "),
                list(to)
            )
        }
        Change::DropQuota { name } => format!("DROP QUOTA {}", ident(name)),
        Change::CreateProfile { name, settings, to } => {
            let parts: Vec<String> = settings
                .iter()
                .map(|s| {
                    let mut one = format!("{} = {}", s.setting, s.value);
                    if !s.min.is_empty() {
                        one.push_str(&format!(" MIN {}", s.min));
                    }
                    if !s.max.is_empty() {
                        one.push_str(&format!(" MAX {}", s.max));
                    }
                    if s.fixed {
                        one.push_str(" READONLY");
                    }
                    one
                })
                .collect();
            format!(
                "CREATE SETTINGS PROFILE {} SETTINGS {} TO {}",
                ident(name),
                parts.join(", "),
                list(to)
            )
        }
        Change::DropProfile { name } => format!("DROP SETTINGS PROFILE {}", ident(name)),
        Change::AlterPolicy {
            name,
            database,
            table,
            filter,
            restrictive,
            to,
        } => format!(
            "ALTER ROW POLICY {} ON {}.{}{} USING {} TO {}",
            ident(name),
            ident(database),
            ident(table),
            if *restrictive { " AS RESTRICTIVE" } else { "" },
            filter,
            list(to)
        ),
        Change::AlterQuota {
            name,
            keyed_by,
            intervals,
            to,
        } => {
            let keyed = if keyed_by.is_empty() {
                " NOT KEYED".to_string()
            } else {
                format!(" KEYED BY {}", keyed_by.join(", "))
            };
            format!(
                "ALTER QUOTA {}{} {} TO {}",
                ident(name),
                keyed,
                windows(intervals),
                list(to)
            )
        }
        Change::AlterProfile { name, settings, to } => format!(
            "ALTER SETTINGS PROFILE {} SETTINGS {} TO {}",
            ident(name),
            elements(settings),
            list(to)
        ),
    }
}

/// The `FOR INTERVAL … MAX …` clauses, comma-joined.
///
/// The comma is the whole reason a quota's statement is built rather than typed:
/// without it ClickHouse keeps the last interval and drops the rest, in silence.
fn windows(intervals: &[Interval]) -> String {
    intervals
        .iter()
        .map(|i| {
            let caps: Vec<String> = i
                .caps
                .iter()
                .map(|c| format!("{} = {}", c.dimension, c.max))
                .collect();
            format!(
                "FOR INTERVAL {} second MAX {}",
                i.duration_secs,
                caps.join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// The `SETTINGS` elements, with their constraints.
fn elements(settings: &[Setting]) -> String {
    settings
        .iter()
        .map(|s| {
            let mut one = format!("{} = {}", s.setting, s.value);
            if !s.min.is_empty() {
                one.push_str(&format!(" MIN {}", s.min));
            }
            if !s.max.is_empty() {
                one.push_str(&format!(" MAX {}", s.max));
            }
            if s.fixed {
                one.push_str(" READONLY");
            }
            one
        })
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn label(change: &Change) -> String {
    match change {
        Change::CreatePolicy {
            name,
            database,
            table,
            restrictive,
            to,
            ..
        } => format!(
            "Create {}row policy {name} on {database}.{table} for {}",
            if *restrictive { "restrictive " } else { "" },
            to.join(", ")
        ),
        Change::DropPolicy {
            name,
            database,
            table,
        } => format!("Drop row policy {name} on {database}.{table}"),
        Change::CreateQuota {
            name,
            intervals,
            to,
            ..
        } => format!(
            "Create quota {name} with {} interval{} for {}",
            intervals.len(),
            if intervals.len() == 1 { "" } else { "s" },
            to.join(", ")
        ),
        Change::DropQuota { name } => format!("Drop quota {name}"),
        Change::CreateProfile { name, settings, to } => format!(
            "Create settings profile {name} with {} setting{} for {}",
            settings.len(),
            if settings.len() == 1 { "" } else { "s" },
            to.join(", ")
        ),
        Change::DropProfile { name } => format!("Drop settings profile {name}"),
        Change::AlterPolicy {
            name,
            database,
            table,
            restrictive,
            to,
            ..
        } => format!(
            "Change {}row policy {name} on {database}.{table} — now for {}",
            if *restrictive { "restrictive " } else { "" },
            to.join(", ")
        ),
        Change::AlterQuota {
            name,
            intervals,
            to,
            ..
        } => format!(
            "Change quota {name} to {} interval{} for {} — what has been consumed is kept",
            intervals.len(),
            if intervals.len() == 1 { "" } else { "s" },
            to.join(", ")
        ),
        Change::AlterProfile { name, settings, to } => format!(
            "Change settings profile {name} to exactly {} setting{} for {}",
            settings.len(),
            if settings.len() == 1 { "" } else { "s" },
            to.join(", ")
        ),
    }
}

/// Why Flint will not send this, or `None` when it will.
///
/// The identifier checks belong to `rbac::valid_name` and are done by the route;
/// these are the ones about the *meaning* of the request.
pub fn refusal(change: &Change) -> Option<String> {
    match change {
        Change::CreatePolicy { to, filter, .. } | Change::AlterPolicy { to, filter, .. } => {
            if to.is_empty() {
                // Measured: the server accepts it, stores an empty apply-to
                // list, and every account still sees every row.
                return Some(
                    "a row policy has to name the accounts it applies to. One with none is \
                     accepted by ClickHouse and does nothing at all — every account still sees \
                     every row, and nothing reports it."
                        .to_string(),
                );
            }
            if filter.trim().is_empty() {
                return Some(
                    "a row policy needs a USING expression. One with none lets every row through, \
                     which is what having no policy already does."
                        .to_string(),
                );
            }
            None
        }
        Change::CreateQuota {
            intervals,
            to,
            keyed_by,
            ..
        }
        | Change::AlterQuota {
            intervals,
            to,
            keyed_by,
            ..
        } => {
            if to.is_empty() {
                return Some("a quota has to name the accounts it counts.".to_string());
            }
            if intervals.is_empty() {
                return Some(
                    "a quota needs at least one interval, or it caps nothing over no window."
                        .to_string(),
                );
            }
            if let Some(i) = intervals.iter().find(|i| i.caps.is_empty()) {
                return Some(format!(
                    "the {}-second interval caps nothing. An interval with no ceiling counts and \
                     refuses nothing, which is what the stock `default` quota already does.",
                    i.duration_secs
                ));
            }
            if let Some(i) = intervals.iter().find(|i| i.duration_secs == 0) {
                let _ = i;
                return Some("an interval of zero seconds is not a window.".to_string());
            }
            if let Some(bad) = intervals
                .iter()
                .flat_map(|i| i.caps.iter())
                .find(|c| !DIMENSIONS.contains(&c.dimension.as_str()))
            {
                return Some(format!(
                    "`{}` is not one of the {} things a quota can cap.",
                    bad.dimension,
                    DIMENSIONS.len()
                ));
            }
            if let Some(bad) = keyed_by.iter().find(|k| !KEYS.contains(&k.as_str())) {
                return Some(format!("`{bad}` is not something a quota can be keyed by."));
            }
            None
        }
        Change::CreateProfile { settings, to, .. } | Change::AlterProfile { settings, to, .. } => {
            if to.is_empty() {
                return Some(
                    "a settings profile has to name the accounts it applies to.".to_string(),
                );
            }
            if settings.is_empty() {
                return Some("a settings profile with no settings changes nothing.".to_string());
            }
            if settings
                .iter()
                .any(|s| s.setting.trim().is_empty() || s.value.trim().is_empty())
            {
                return Some("every setting needs a name and a value.".to_string());
            }
            None
        }
        _ => None,
    }
}

/// The fragments that reach the statement raw, for the route's semicolon check.
pub fn fragments(change: &Change) -> Vec<&str> {
    match change {
        Change::CreatePolicy { filter, .. } | Change::AlterPolicy { filter, .. } => {
            vec![filter.as_str()]
        }
        Change::CreateProfile { settings, .. } | Change::AlterProfile { settings, .. } => settings
            .iter()
            .flat_map(|s| {
                [
                    s.setting.as_str(),
                    s.value.as_str(),
                    s.min.as_str(),
                    s.max.as_str(),
                ]
            })
            .filter(|f| !f.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// Every identifier the change puts into a quoted name.
pub fn names(change: &Change) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    match change {
        Change::CreatePolicy {
            name,
            database,
            table,
            to,
            ..
        }
        | Change::AlterPolicy {
            name,
            database,
            table,
            to,
            ..
        } => {
            out.push(name);
            out.push(database);
            out.push(table);
            out.extend(to.iter().map(String::as_str));
        }
        Change::DropPolicy {
            name,
            database,
            table,
        } => {
            out.push(name);
            out.push(database);
            out.push(table);
        }
        Change::DropQuota { name } | Change::DropProfile { name } => out.push(name),
        Change::CreateQuota { name, to, .. }
        | Change::CreateProfile { name, to, .. }
        | Change::AlterQuota { name, to, .. }
        | Change::AlterProfile { name, to, .. } => {
            out.push(name);
            out.extend(to.iter().map(String::as_str));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to() -> Vec<String> {
        vec!["probe_a".to_string()]
    }

    #[test]
    fn a_policy_that_names_nobody_is_refused() {
        // Measured: ClickHouse accepts it, stores an empty apply-to list, and
        // every account still sees every row. A control that creates a no-op is
        // worse than no control.
        let says = refusal(&Change::CreatePolicy {
            name: "p".into(),
            database: "d".into(),
            table: "t".into(),
            filter: "tenant = 'c'".into(),
            restrictive: false,
            to: Vec::new(),
        })
        .expect("refused");
        assert!(says.contains("does nothing at all"));
        assert!(says.contains("nothing reports it"));
    }

    #[test]
    fn a_policy_with_no_filter_is_refused_for_the_other_reason() {
        let says = refusal(&Change::CreatePolicy {
            name: "p".into(),
            database: "d".into(),
            table: "t".into(),
            filter: "  ".into(),
            restrictive: false,
            to: to(),
        })
        .expect("refused");
        assert!(says.contains("lets every row through"));
    }

    #[test]
    fn a_restrictive_policy_says_so_in_the_statement_and_the_label() {
        let change = Change::CreatePolicy {
            name: "not_b".into(),
            database: "analytics".into(),
            table: "events".into(),
            filter: "tenant != 'b'".into(),
            restrictive: true,
            to: to(),
        };
        assert_eq!(
            statement(&change),
            "CREATE ROW POLICY `not_b` ON `analytics`.`events` AS RESTRICTIVE \
             USING tenant != 'b' TO `probe_a`"
        );
        assert!(label(&change).contains("restrictive row policy"));
    }

    #[test]
    fn quota_intervals_are_joined_with_the_comma_that_matters() {
        // Without it ClickHouse keeps the last interval and drops the rest,
        // silently — the development fixture was written that way once and read
        // back with one interval where two were meant.
        let sql = statement(&Change::CreateQuota {
            name: "modest".into(),
            keyed_by: vec!["user_name".into()],
            intervals: vec![
                Interval {
                    duration_secs: 60,
                    caps: vec![
                        Cap {
                            dimension: "queries".into(),
                            max: 60,
                        },
                        Cap {
                            dimension: "read_rows".into(),
                            max: 1_000_000,
                        },
                    ],
                },
                Interval {
                    duration_secs: 3600,
                    caps: vec![Cap {
                        dimension: "queries".into(),
                        max: 1000,
                    }],
                },
            ],
            to: to(),
        });
        assert_eq!(
            sql,
            "CREATE QUOTA `modest` KEYED BY user_name FOR INTERVAL 60 second MAX queries = 60, \
             read_rows = 1000000, FOR INTERVAL 3600 second MAX queries = 1000 TO `probe_a`"
        );
        // The comma between the two intervals, specifically.
        assert!(sql.contains("read_rows = 1000000, FOR INTERVAL 3600"));
    }

    #[test]
    fn an_unkeyed_quota_says_not_keyed_rather_than_nothing() {
        // The difference between "sixty queries each" and "sixty between you"
        // should be what was asked for and not what the server defaults to.
        let sql = statement(&Change::CreateQuota {
            name: "shared".into(),
            keyed_by: Vec::new(),
            intervals: vec![Interval {
                duration_secs: 60,
                caps: vec![Cap {
                    dimension: "queries".into(),
                    max: 10,
                }],
            }],
            to: to(),
        });
        assert!(sql.contains("`shared` NOT KEYED FOR INTERVAL"));
    }

    #[test]
    fn a_quota_that_caps_nothing_is_refused() {
        let says = refusal(&Change::CreateQuota {
            name: "q".into(),
            keyed_by: Vec::new(),
            intervals: vec![Interval {
                duration_secs: 60,
                caps: Vec::new(),
            }],
            to: to(),
        })
        .expect("refused");
        assert!(says.contains("counts and refuses nothing"));
    }

    #[test]
    fn a_dimension_the_server_does_not_have_is_refused() {
        let says = refusal(&Change::CreateQuota {
            name: "q".into(),
            keyed_by: Vec::new(),
            intervals: vec![Interval {
                duration_secs: 60,
                caps: vec![Cap {
                    dimension: "teleports".into(),
                    max: 1,
                }],
            }],
            to: to(),
        })
        .expect("refused");
        assert!(says.contains("11 things a quota can cap"));
    }

    #[test]
    fn a_key_the_server_does_not_have_is_refused() {
        assert!(refusal(&Change::CreateQuota {
            name: "q".into(),
            keyed_by: vec!["star_sign".into()],
            intervals: vec![Interval {
                duration_secs: 60,
                caps: vec![Cap {
                    dimension: "queries".into(),
                    max: 1
                }],
            }],
            to: to(),
        })
        .is_some());
    }

    #[test]
    fn a_profile_writes_readonly_and_reads_back_const() {
        // Two vocabularies for one fact: `READONLY` going out,
        // `writability = CONST` coming back.
        let sql = statement(&Change::CreateProfile {
            name: "careful".into(),
            settings: vec![
                Setting {
                    setting: "max_execution_time".into(),
                    value: "30".into(),
                    min: "1".into(),
                    max: "120".into(),
                    fixed: false,
                },
                Setting {
                    setting: "max_result_rows".into(),
                    value: "100000".into(),
                    min: String::new(),
                    max: String::new(),
                    fixed: true,
                },
            ],
            to: to(),
        });
        assert_eq!(
            sql,
            "CREATE SETTINGS PROFILE `careful` SETTINGS max_execution_time = 30 MIN 1 MAX 120, \
             max_result_rows = 100000 READONLY TO `probe_a`"
        );
    }

    #[test]
    fn a_direction_is_only_claimed_where_it_is_known() {
        // Making a restriction takes something away, and that is knowable from
        // the request alone.
        assert!(access_note(&Change::CreatePolicy {
            name: "p".into(),
            database: "d".into(),
            table: "t".into(),
            filter: "1".into(),
            restrictive: false,
            to: to(),
        })
        .contains("takes access away"));

        // An alter could go either way, and Flint does not hold the previous
        // state: raising a ceiling from 1000 to 2000 widens, and the first
        // version of this said it took access away about exactly that.
        let altered = access_note(&Change::AlterQuota {
            name: "q".into(),
            keyed_by: Vec::new(),
            intervals: Vec::new(),
            to: to(),
        });
        assert!(altered.contains("changes what those accounts may do"));
        assert!(!altered.contains("away"));

        // Dropping one gives access back rather than taking it away, so it says
        // nothing at all.
        assert_eq!(
            access_note(&Change::DropPolicy {
                name: "p".into(),
                database: "d".into(),
                table: "t".into(),
            }),
            ""
        );
    }

    #[test]
    fn altering_a_policy_is_one_statement_with_no_gap() {
        // Dropping and recreating leaves the table unprotected between the two,
        // which for a security control is the whole difference.
        let change = Change::AlterPolicy {
            name: "only_a".into(),
            database: "analytics".into(),
            table: "events".into(),
            filter: "tenant = 'a' OR tenant = 'c'".into(),
            restrictive: false,
            to: vec!["probe_a".into(), "probe_none".into()],
        };
        assert_eq!(
            statement(&change),
            "ALTER ROW POLICY `only_a` ON `analytics`.`events` USING tenant = 'a' OR tenant = 'c' \
             TO `probe_a`, `probe_none`"
        );
    }

    #[test]
    fn altering_a_quota_says_the_consumption_is_kept() {
        // Measured: `ALTER QUOTA … MAX queries = 2000` kept five consumed
        // queries against the new ceiling, and `DROP` then `CREATE` reset them to
        // zero — so raising a ceiling the second way forgives everything spent.
        let change = Change::AlterQuota {
            name: "modest".into(),
            keyed_by: vec!["user_name".into()],
            intervals: vec![Interval {
                duration_secs: 3600,
                caps: vec![Cap {
                    dimension: "queries".into(),
                    max: 2000,
                }],
            }],
            to: to(),
        };
        assert_eq!(
            statement(&change),
            "ALTER QUOTA `modest` KEYED BY user_name FOR INTERVAL 3600 second MAX queries = 2000 \
             TO `probe_a`"
        );
        assert!(label(&change).contains("what has been consumed is kept"));
    }

    #[test]
    fn altering_a_profile_says_it_replaces_rather_than_amends() {
        // The asymmetry worth writing down: `ALTER SETTINGS PROFILE p SETTINGS
        // max_threads = 8` left a three-setting profile with one, where the
        // quota statement of nearly the same shape amends. Flint sends the whole
        // list every time, and the label says that is what it is doing.
        let change = Change::AlterProfile {
            name: "careful".into(),
            settings: vec![Setting {
                setting: "max_threads".into(),
                value: "8".into(),
                min: String::new(),
                max: String::new(),
                fixed: false,
            }],
            to: to(),
        };
        assert_eq!(
            statement(&change),
            "ALTER SETTINGS PROFILE `careful` SETTINGS max_threads = 8 TO `probe_a`"
        );
        assert!(label(&change).contains("to exactly 1 setting"));
    }

    #[test]
    fn the_alters_are_held_to_the_same_rules_as_the_creates() {
        // A policy that names nobody does nothing whether it is being made or
        // changed, and the refusal is the same sentence.
        assert!(refusal(&Change::AlterPolicy {
            name: "p".into(),
            database: "d".into(),
            table: "t".into(),
            filter: "1".into(),
            restrictive: false,
            to: Vec::new(),
        })
        .is_some());
        assert!(refusal(&Change::AlterQuota {
            name: "q".into(),
            keyed_by: Vec::new(),
            intervals: vec![Interval {
                duration_secs: 60,
                caps: Vec::new()
            }],
            to: to(),
        })
        .is_some());
        assert!(refusal(&Change::AlterProfile {
            name: "p".into(),
            settings: Vec::new(),
            to: to(),
        })
        .is_some());
    }

    #[test]
    fn a_create_and_an_alter_differ_by_one_keyword_and_nothing_else() {
        // Both go through the same clause builders, so a fix to the comma or to
        // a constraint reaches both.
        let intervals = vec![Interval {
            duration_secs: 60,
            caps: vec![Cap {
                dimension: "queries".into(),
                max: 5,
            }],
        }];
        let made = statement(&Change::CreateQuota {
            name: "q".into(),
            keyed_by: Vec::new(),
            intervals: intervals.clone(),
            to: to(),
        });
        let changed = statement(&Change::AlterQuota {
            name: "q".into(),
            keyed_by: Vec::new(),
            intervals,
            to: to(),
        });
        assert_eq!(made.replacen("CREATE", "ALTER", 1), changed);
    }

    #[test]
    fn a_drop_quotes_its_name() {
        assert_eq!(
            statement(&Change::DropQuota {
                name: "we`ird".into()
            }),
            "DROP QUOTA `we``ird`"
        );
        assert_eq!(
            statement(&Change::DropProfile { name: "p".into() }),
            "DROP SETTINGS PROFILE `p`"
        );
    }
}
