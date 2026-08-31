//! Changing who can do what.
//!
//! `access.rs` reads access control and refuses to touch it. This is the other
//! half, and the refusal it lifts was never about danger in the abstract: until
//! `FLINT_AUTH` existed there was no *who* to attribute a grant to, and a tool
//! that hands out privileges under a shared service account is a tool that
//! makes an audit trail worthless. With identity in place the server decides —
//! every statement here runs as whoever signed in, so ClickHouse refuses what
//! that account may not do, and Flint does not get to be more permissive than
//! the credentials it was given.
//!
//! Three things this module is careful about, each for its own reason:
//!
//! - **A secret must not survive the statement.** A password travels in the SQL
//!   text; ClickHouse strips it from `query_log`, and Flint has to strip it from
//!   its own job table, which is a MergeTree that keeps rows for thirty days.
//!   Hence [`Statement`], which carries the text to send and the text to record
//!   as two different fields, so recording the wrong one has to be a decision
//!   rather than an oversight.
//! - **`CREATE USER` takes no parameters.** ClickHouse's `{name:Identifier}`
//!   binding works in queries and not in access DDL, so the quoting here is
//!   Flint's own: backticks with doubling, which is complete for a ClickHouse
//!   identifier, over a name that has been checked for the things backticks
//!   cannot save us from.
//! - **Privileges are the server's list, not ours.** A hardcoded set of access
//!   types rots one release after it is written, and it rots silently — a
//!   privilege the server gained is one Flint would refuse. The route validates
//!   against `system.privileges`, all 241 of them on a current server, so what
//!   Flint accepts is exactly what this ClickHouse understands.

use serde::{Deserialize, Serialize};

/// What to send, and what to remember having sent.
///
/// Identical for everything except the two statements that carry a password.
/// Two fields rather than one, and a `recorded` that is built rather than
/// scrubbed: a redaction that works by finding the secret in a finished string
/// is one regular expression away from keeping it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement {
    /// Sent to ClickHouse.
    pub sql: String,
    /// Written to the job row and shown in the UI. Never holds a secret.
    pub recorded: String,
}

impl Statement {
    /// A statement with nothing to hide, which is most of them.
    fn plain(sql: String) -> Self {
        Self {
            recorded: sql.clone(),
            sql,
        }
    }
}

/// Who a grant is for. Users and roles take the same syntax, and the
/// distinction is needed for a different reason: to know which table to ask
/// whether the subject can be altered at all.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Grantee {
    pub name: String,
    pub is_user: bool,
}

/// One change to access control.
///
/// Deliberately narrow: each variant is one statement with no options, because
/// a form with fifteen optional fields produces statements nobody can predict
/// from looking at the form. Hosts, default roles, expiry and settings are read
/// by `access.rs` and not written here yet — the roadmap says which.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum Change {
    CreateRole {
        role: String,
    },
    DropRole {
        role: String,
    },
    GrantRole {
        role: String,
        to: Grantee,
    },
    RevokeRole {
        role: String,
        to: Grantee,
    },
    CreateUser {
        user: String,
        password: String,
    },
    DropUser {
        user: String,
    },
    /// A new password for an account that already has one. Its own variant
    /// rather than a general `ALTER USER`, because rotating a password is the
    /// one alteration somebody does under time pressure and it should not share
    /// a form with anything that could go wrong differently.
    SetPassword {
        user: String,
        password: String,
    },
    /// When the account stops working. `infinity` for never, which the server
    /// stores as the epoch.
    ///
    /// A date in the past locks the account out **now**, and the server reports
    /// it as `AUTHENTICATION_FAILED` — "password is incorrect, or there is no
    /// user with such name". So somebody whose account expired is told their
    /// password is wrong, which is why this one is worth a warning beside the
    /// control rather than a field in a form.
    SetValidUntil {
        user: String,
        until: String,
    },
    /// Where the account may connect from. Empty is `HOST ANY`.
    ///
    /// A restriction that excludes where the account actually connects from
    /// locks it out immediately, reported the same misleading way. And on the
    /// account Flint is signed in as, it locks *Flint* out — which the route
    /// refuses rather than executes.
    SetHosts {
        user: String,
        #[serde(default)]
        ips: Vec<String>,
        #[serde(default)]
        names: Vec<String>,
    },
    /// Which of the account's roles are active without a `SET ROLE`.
    ///
    /// `NONE` leaves every granted role in place and *inert*: the account keeps
    /// the grants and cannot use them until it sets a role per session. Measured
    /// — a user holding a role that grants `SELECT` on `system.parts` lost the
    /// read entirely at `DEFAULT ROLE NONE`, with `Not enough privileges`.
    SetDefaultRoles {
        user: String,
        #[serde(default)]
        roles: Vec<String>,
        /// `DEFAULT ROLE ALL`, which is what a fresh account has.
        #[serde(default)]
        all: bool,
    },
    Grant {
        access: Vec<String>,
        database: String,
        table: String,
        to: Grantee,
    },
    Revoke {
        access: Vec<String>,
        database: String,
        table: String,
        to: Grantee,
    },
}

impl Change {
    /// The machine word for the job row, which the UI groups on.
    pub fn kind(&self) -> &'static str {
        match self {
            Change::SetValidUntil { .. } => "access-expiry",
            Change::SetHosts { .. } => "access-hosts",
            Change::SetDefaultRoles { .. } => "access-default-roles",
            Change::CreateRole { .. } | Change::CreateUser { .. } => "access-create",
            Change::DropRole { .. } | Change::DropUser { .. } => "access-drop",
            Change::SetPassword { .. } => "access-password",
            Change::GrantRole { .. } | Change::Grant { .. } => "access-grant",
            Change::RevokeRole { .. } | Change::Revoke { .. } => "access-revoke",
        }
    }

    /// The account or role this acts on, for the job's `target`.
    pub fn subject(&self) -> Grantee {
        match self {
            Change::CreateRole { role } | Change::DropRole { role } => Grantee {
                name: role.clone(),
                is_user: false,
            },
            Change::CreateUser { user, .. }
            | Change::DropUser { user }
            | Change::SetPassword { user, .. }
            | Change::SetValidUntil { user, .. }
            | Change::SetHosts { user, .. }
            | Change::SetDefaultRoles { user, .. } => Grantee {
                name: user.clone(),
                is_user: true,
            },
            Change::GrantRole { to, .. }
            | Change::RevokeRole { to, .. }
            | Change::Grant { to, .. }
            | Change::Revoke { to, .. } => to.clone(),
        }
    }

    /// Whether this change creates its subject, and therefore must not be
    /// refused for a subject that does not exist yet.
    pub fn creates(&self) -> bool {
        matches!(self, Change::CreateRole { .. } | Change::CreateUser { .. })
    }
}

/// A ClickHouse identifier, quoted so the server does the interpreting.
///
/// Doubling the backtick is the whole escape: inside backticks ClickHouse takes
/// everything literally, so a name containing a quote, a semicolon or a space
/// comes out as that name and not as syntax. What backticks cannot fix is a
/// name carrying a newline or a control character — legal in the grammar,
/// unreadable in every log that will later quote it — so [`valid_name`] refuses
/// those before we get here.
fn ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// A string literal, for a password.
fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// Whether a name is one Flint will put in a statement.
///
/// Permissive on purpose about punctuation — real deployments have accounts
/// called `svc.reporting` and `alice@corp`, and a validator that refused them
/// would make Flint unable to manage the servers it is for. What it refuses is
/// what quoting cannot make safe to read back: nothing, something enormous, and
/// anything with a control character or a newline in it.
pub fn valid_name(name: &str) -> bool {
    !name.trim().is_empty() && name.len() <= 200 && !name.chars().any(|c| c.is_control())
}

/// Whether an expiry is one Flint will put in a literal.
///
/// `infinity` — the server's own word for never — or a date, optionally with a
/// time. A narrow allowlist rather than an escape, because this reaches the
/// statement inside quotes and a date has no reason to contain anything else.
pub fn valid_until(text: &str) -> bool {
    let t = text.trim();
    if t.eq_ignore_ascii_case("infinity") {
        return true;
    }
    let (date, time) = match t.split_once(' ') {
        Some((d, rest)) => (d, Some(rest.trim())),
        None => (t, None),
    };
    let shaped = |s: &str, sep: char, parts: usize| {
        let bits: Vec<&str> = s.split(sep).collect();
        bits.len() == parts
            && bits
                .iter()
                .all(|b| !b.is_empty() && b.chars().all(|c| c.is_ascii_digit()))
    };
    shaped(date, '-', 3) && time.map(|t| shaped(t, ':', 3)).unwrap_or(true)
}

/// Whether a host is one Flint will put in a literal.
///
/// An address, a CIDR range or a host name — the characters those are made of
/// and nothing else. The server decides whether it parses; this decides whether
/// it can end the literal.
pub fn valid_host(text: &str) -> bool {
    let t = text.trim();
    !t.is_empty()
        && t.len() <= 255
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '/' | '-' | '_' | '%'))
}

/// Whether a password is one worth setting.
///
/// Length only, and it is not a policy: ClickHouse has settings for real
/// password complexity and enforcing a second opinion here would put Flint's
/// idea of a good password above the server's. What this catches is the empty
/// string, which would otherwise create an account that cannot log in at all
/// and looks like one that can.
pub fn valid_password(password: &str) -> bool {
    !password.is_empty() && password.len() <= 512
}

/// `*.*`, `db.*` or `db.table`, quoted.
fn scope(database: &str, table: &str) -> String {
    match (database, table) {
        ("*", _) => "*.*".to_string(),
        (db, "*") => format!("{}.*", ident(db)),
        (db, tbl) => format!("{}.{}", ident(db), ident(tbl)),
    }
}

/// The same scope, as a person would write it in a sentence.
fn scope_label(database: &str, table: &str) -> String {
    match (database, table) {
        ("*", _) => "everything".to_string(),
        (db, "*") => format!("{db}.*"),
        (db, tbl) => format!("{db}.{tbl}"),
    }
}

/// The statement one change sends, and the statement Flint keeps.
pub fn statement(change: &Change) -> Statement {
    match change {
        Change::CreateRole { role } => Statement::plain(format!("CREATE ROLE {}", ident(role))),
        Change::DropRole { role } => Statement::plain(format!("DROP ROLE {}", ident(role))),
        Change::GrantRole { role, to } => {
            Statement::plain(format!("GRANT {} TO {}", ident(role), ident(&to.name)))
        }
        Change::RevokeRole { role, to } => {
            Statement::plain(format!("REVOKE {} FROM {}", ident(role), ident(&to.name)))
        }
        // `sha256_password` rather than `plaintext_password`: the server hashes
        // it on arrival, so the only place the password exists in the clear is
        // the request that carried it. `plaintext_password` would leave it
        // sitting in the server's own access storage as well.
        Change::CreateUser { user, password } => secret(
            format!(
                "CREATE USER {} IDENTIFIED WITH sha256_password BY ",
                ident(user)
            ),
            password,
        ),
        Change::DropUser { user } => Statement::plain(format!("DROP USER {}", ident(user))),
        Change::SetValidUntil { user, until } => Statement::plain(format!(
            "ALTER USER {} VALID UNTIL {}",
            ident(user),
            literal(until)
        )),
        Change::SetHosts { user, ips, names } => {
            let mut parts: Vec<String> = ips.iter().map(|i| format!("IP {}", literal(i))).collect();
            parts.extend(names.iter().map(|n| format!("NAME {}", literal(n))));
            Statement::plain(if parts.is_empty() {
                // `ANY` rather than nothing: an `ALTER USER x HOST` with no
                // clause is a syntax error, and "no restriction" is a thing to
                // say rather than a thing to omit.
                format!("ALTER USER {} HOST ANY", ident(user))
            } else {
                format!("ALTER USER {} HOST {}", ident(user), parts.join(", "))
            })
        }
        Change::SetDefaultRoles { user, roles, all } => Statement::plain(if *all {
            format!("ALTER USER {} DEFAULT ROLE ALL", ident(user))
        } else if roles.is_empty() {
            format!("ALTER USER {} DEFAULT ROLE NONE", ident(user))
        } else {
            format!(
                "ALTER USER {} DEFAULT ROLE {}",
                ident(user),
                roles
                    .iter()
                    .map(|r| ident(r))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }),
        Change::SetPassword { user, password } => secret(
            format!(
                "ALTER USER {} IDENTIFIED WITH sha256_password BY ",
                ident(user)
            ),
            password,
        ),
        Change::Grant {
            access,
            database,
            table,
            to,
        } => Statement::plain(format!(
            "GRANT {} ON {} TO {}",
            access.join(", "),
            scope(database, table),
            ident(&to.name)
        )),
        Change::Revoke {
            access,
            database,
            table,
            to,
        } => Statement::plain(format!(
            "REVOKE {} ON {} FROM {}",
            access.join(", "),
            scope(database, table),
            ident(&to.name)
        )),
    }
}

/// A statement whose tail is a password: built twice, from the same prefix.
///
/// The recorded half never sees the secret, so there is nothing in it to fail
/// to remove. ClickHouse redacts the same way in `query_log`, which is where
/// the shape of the placeholder comes from — a reader comparing the two sees
/// the same statement.
fn secret(prefix: String, password: &str) -> Statement {
    Statement {
        sql: format!("{prefix}{}", literal(password)),
        recorded: prefix.trim_end().to_string(),
    }
}

/// One line saying what happened, for the job list.
///
/// Reads as a sentence rather than as SQL: the statement is recorded beside it
/// for anybody who wants the exact text, and a list of nine statements in a
/// column is harder to scan than nine sentences.
pub fn label(change: &Change) -> String {
    let who = |g: &Grantee| format!("{} {}", if g.is_user { "user" } else { "role" }, g.name);
    match change {
        Change::CreateRole { role } => format!("Create role {role}"),
        Change::DropRole { role } => format!("Drop role {role}"),
        Change::GrantRole { role, to } => format!("Grant role {role} to {}", who(to)),
        Change::RevokeRole { role, to } => format!("Revoke role {role} from {}", who(to)),
        Change::CreateUser { user, .. } => format!("Create user {user}"),
        Change::DropUser { user } => format!("Drop user {user}"),
        Change::SetValidUntil { user, until } => {
            if until.eq_ignore_ascii_case("infinity") {
                format!("Let user {user} log in indefinitely")
            } else {
                format!("Stop user {user} working after {until}")
            }
        }
        Change::SetHosts { user, ips, names } => {
            let total = ips.len() + names.len();
            if total == 0 {
                format!("Let user {user} connect from anywhere")
            } else {
                format!(
                    "Restrict user {user} to {total} host{}",
                    if total == 1 { "" } else { "s" }
                )
            }
        }
        Change::SetDefaultRoles { user, roles, all } => {
            if *all {
                format!("Make every role of user {user} active by default")
            } else if roles.is_empty() {
                format!("Leave user {user} with no role active by default")
            } else {
                format!(
                    "Make {} active by default for user {user}",
                    roles.join(", ")
                )
            }
        }
        Change::SetPassword { user, .. } => format!("Set a new password for user {user}"),
        Change::Grant {
            access,
            database,
            table,
            to,
        } => format!(
            "Grant {} on {} to {}",
            access.join(", "),
            scope_label(database, table),
            who(to)
        ),
        Change::Revoke {
            access,
            database,
            table,
            to,
        } => format!(
            "Revoke {} on {} from {}",
            access.join(", "),
            scope_label(database, table),
            who(to)
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(name: &str) -> Grantee {
        Grantee {
            name: name.into(),
            is_user: true,
        }
    }

    #[test]
    fn a_password_is_sent_and_not_recorded() {
        let st = statement(&Change::CreateUser {
            user: "bob".into(),
            password: "sup3rsecret".into(),
        });
        assert!(st.sql.contains("sup3rsecret"));
        // The job table keeps rows for thirty days. This is the assertion that
        // stops a secret living there.
        assert!(!st.recorded.contains("sup3rsecret"));
        assert_eq!(
            st.recorded,
            "CREATE USER `bob` IDENTIFIED WITH sha256_password BY"
        );
    }

    #[test]
    fn rotating_a_password_hides_it_too() {
        let st = statement(&Change::SetPassword {
            user: "bob".into(),
            password: "hunter2".into(),
        });
        assert!(!st.recorded.contains("hunter2"));
        assert!(st
            .sql
            .starts_with("ALTER USER `bob` IDENTIFIED WITH sha256_password BY '"));
    }

    #[test]
    fn everything_else_records_exactly_what_it_sends() {
        // "What did that button actually run" is the first question anybody asks
        // of a tool that runs things for them, and for eight of these nine the
        // answer is the statement itself.
        for change in [
            Change::CreateRole { role: "r".into() },
            Change::DropRole { role: "r".into() },
            Change::GrantRole {
                role: "r".into(),
                to: user("bob"),
            },
            Change::DropUser { user: "bob".into() },
            Change::Grant {
                access: vec!["SELECT".into()],
                database: "analytics".into(),
                table: "*".into(),
                to: user("bob"),
            },
        ] {
            let st = statement(&change);
            assert_eq!(st.sql, st.recorded);
        }
    }

    #[test]
    fn a_name_is_quoted_rather_than_trusted() {
        let st = statement(&Change::DropUser {
            user: "bob`; DROP TABLE x; --".into(),
        });
        // The backtick is doubled, so the whole thing stays one identifier and
        // the server looks for a user of that exact absurd name.
        assert_eq!(st.sql, "DROP USER `bob``; DROP TABLE x; --`");
    }

    #[test]
    fn a_password_quote_cannot_end_the_literal() {
        let st = statement(&Change::SetPassword {
            user: "bob".into(),
            password: "it's \\ fine".into(),
        });
        assert!(st.sql.ends_with(r"'it\'s \\ fine'"));
    }

    #[test]
    fn scopes_narrow_from_everything_to_one_table() {
        let g = |database: &str, table: &str| {
            statement(&Change::Grant {
                access: vec!["SELECT".into(), "INSERT".into()],
                database: database.into(),
                table: table.into(),
                to: user("bob"),
            })
            .sql
        };
        assert_eq!(g("*", "*"), "GRANT SELECT, INSERT ON *.* TO `bob`");
        assert_eq!(
            g("analytics", "*"),
            "GRANT SELECT, INSERT ON `analytics`.* TO `bob`"
        );
        assert_eq!(
            g("analytics", "events"),
            "GRANT SELECT, INSERT ON `analytics`.`events` TO `bob`"
        );
    }

    #[test]
    fn names_that_quoting_cannot_make_readable_are_refused() {
        assert!(valid_name("alice@corp"));
        assert!(valid_name("svc.reporting"));
        // Legal in the grammar, unreadable in every log that will quote it.
        assert!(!valid_name("two\nlines"));
        assert!(!valid_name("bell\u{7}"));
        assert!(!valid_name("   "));
        assert!(!valid_name(""));
        assert!(!valid_name(&"x".repeat(201)));
    }

    #[test]
    fn an_empty_password_is_not_a_password() {
        // It would create an account that cannot log in and looks like one that
        // can — which is worse than refusing.
        assert!(!valid_password(""));
        assert!(valid_password("x"));
        assert!(!valid_password(&"x".repeat(513)));
    }

    #[test]
    fn a_label_reads_as_a_sentence() {
        assert_eq!(
            label(&Change::Grant {
                access: vec!["SELECT".into()],
                database: "*".into(),
                table: "*".into(),
                to: user("bob"),
            }),
            "Grant SELECT on everything to user bob"
        );
        assert_eq!(
            label(&Change::RevokeRole {
                role: "analyst".into(),
                to: Grantee {
                    name: "readers".into(),
                    is_user: false
                },
            }),
            "Revoke role analyst from role readers"
        );
    }

    #[test]
    fn an_expiry_is_a_date_or_the_servers_own_word_for_never() {
        assert!(valid_until("infinity"));
        assert!(valid_until("INFINITY"));
        assert!(valid_until("2027-01-01"));
        assert!(valid_until("2027-01-01 09:00:00"));
        // It goes inside quotes, so what could end them is refused rather than
        // escaped — a date has no reason to hold any of it.
        assert!(!valid_until("2027-01-01'; DROP USER bob; --"));
        assert!(!valid_until("soon"));
        assert!(!valid_until(""));
        assert!(!valid_until("2027-1"));
        assert!(!valid_until("2027-01-01 09:00"));
    }

    #[test]
    fn a_host_is_an_address_a_range_or_a_name() {
        assert!(valid_host("10.0.0.1"));
        assert!(valid_host("10.0.0.0/8"));
        assert!(valid_host("2001:db8::/32"));
        assert!(valid_host("reports.corp"));
        assert!(!valid_host("10.0.0.1' OR '1"));
        assert!(!valid_host(""));
        assert!(!valid_host("has space"));
    }

    #[test]
    fn no_hosts_means_anywhere_rather_than_nowhere() {
        // An `ALTER USER x HOST` with no clause is a syntax error, and "no
        // restriction" is a thing to say rather than a thing to omit.
        let st = statement(&Change::SetHosts {
            user: "bob".into(),
            ips: Vec::new(),
            names: Vec::new(),
        });
        assert_eq!(st.sql, "ALTER USER `bob` HOST ANY");
        assert!(label(&Change::SetHosts {
            user: "bob".into(),
            ips: Vec::new(),
            names: Vec::new(),
        })
        .contains("from anywhere"));
    }

    #[test]
    fn addresses_and_names_are_different_clauses() {
        let st = statement(&Change::SetHosts {
            user: "bob".into(),
            ips: vec!["10.0.0.0/8".into()],
            names: vec!["reports.corp".into()],
        });
        assert_eq!(
            st.sql,
            "ALTER USER `bob` HOST IP '10.0.0.0/8', NAME 'reports.corp'"
        );
    }

    #[test]
    fn default_roles_have_three_shapes_and_none_is_not_empty() {
        let all = statement(&Change::SetDefaultRoles {
            user: "bob".into(),
            roles: Vec::new(),
            all: true,
        });
        assert_eq!(all.sql, "ALTER USER `bob` DEFAULT ROLE ALL");

        // The one that surprises: the roles stay granted and go inert.
        let none = Change::SetDefaultRoles {
            user: "bob".into(),
            roles: Vec::new(),
            all: false,
        };
        assert_eq!(statement(&none).sql, "ALTER USER `bob` DEFAULT ROLE NONE");
        assert!(label(&none).contains("no role active by default"));

        let some = statement(&Change::SetDefaultRoles {
            user: "bob".into(),
            roles: vec!["analyst".into(), "writer".into()],
            all: false,
        });
        assert_eq!(
            some.sql,
            "ALTER USER `bob` DEFAULT ROLE `analyst`, `writer`"
        );
    }

    #[test]
    fn never_reads_as_never_rather_than_as_a_date() {
        assert!(label(&Change::SetValidUntil {
            user: "bob".into(),
            until: "infinity".into(),
        })
        .contains("indefinitely"));
        assert!(label(&Change::SetValidUntil {
            user: "bob".into(),
            until: "2027-01-01".into(),
        })
        .contains("after 2027-01-01"));
    }

    #[test]
    fn only_the_two_creating_changes_say_so() {
        assert!(Change::CreateUser {
            user: "bob".into(),
            password: "p".into()
        }
        .creates());
        assert!(Change::CreateRole { role: "r".into() }.creates());
        assert!(!Change::DropUser { user: "bob".into() }.creates());
        assert!(!Change::SetPassword {
            user: "bob".into(),
            password: "p".into()
        }
        .creates());
    }
}
