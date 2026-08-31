//! What the person at the keyboard may see, asked of the server as them.
//!
//! The question belongs to Data, not to Users & RBAC: it is asked by an analyst
//! whose database is missing from the list, and its answer is read-only. Managing
//! access stays in Infrastructure, where a mistake costs somebody else something.
//!
//! Four things were measured on a real server before any of this was written,
//! and each one decided part of it.
//!
//! **`SHOW GRANTS` answers where `system.grants` refuses.** A user with no
//! privilege on the access tables — which is the ordinary case, and exactly the
//! user who asks this question — gets `Code: 497 … it's necessary to have the
//! grant SELECT ON system.grants`. `SHOW GRANTS` answers the same user without
//! complaint, because it is about them. So this reads the statement, not the
//! table.
//!
//! **A revoke is a row.** `SHOW GRANTS` returns statements, not permissions, and
//! some of those statements take something away:
//!
//! ```text
//! GRANT SELECT ON analytics.* TO probe_cols
//! REVOKE SELECT ON analytics.orders FROM probe_cols
//! ```
//!
//! Printing that list under the heading "what you may see" tells somebody they
//! can read `analytics.orders`. The two are kept apart here for that reason.
//!
//! **A role hides its grants.** `GRANT analyst TO probe_a` says nothing about
//! what `analyst` carries, and the reader's question is not answered until it
//! does. `SHOW GRANTS FOR <role>` works for a role the user actually holds, and
//! answers `Code: 511 … There is no role` for one they do not — so the roles are
//! taken from `system.enabled_roles`, which every user may read about themselves,
//! and expanded one by one.
//!
//! **`WITH IMPLICIT` is not worth having.** It turned two rows into
//! seventy-one, sixty-nine of which were `GRANT TABLE ENGINE ON <engine>` — the
//! engines every user may name. That is the shape of noise: identical on every
//! server, and never the answer to anything.

use serde::{Deserialize, Serialize};

use super::Client;
use crate::error::Result;

/// One line of `SHOW GRANTS`, read apart.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Grant {
    /// The privileges, as the server listed them.
    pub what: String,
    /// What they are on — `analytics.*`, `system.query_log`, `*.*`.
    pub on: String,
    /// True where the statement takes something away rather than gives it.
    pub revoked: bool,
    /// Whether this one can be passed on to somebody else.
    pub grantable: bool,
    /// The statement as the server wrote it, for the reader who wants it exact.
    pub statement: String,
    /// True where it is granted to the user themselves.
    pub direct: bool,
    /// Roles that also carry it.
    ///
    /// The same privilege arriving twice is ordinary rather than exceptional —
    /// `probe_a` holds `SELECT ON analytics.*` directly *and* through `analyst`
    /// — and printing it twice makes a reader count their permissions wrong. It
    /// also answers the question behind the question: somebody who loses a role
    /// and keeps the access wants to know they were granted it directly too.
    pub via: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MyGrants {
    /// The ClickHouse user the statements ran as.
    pub user: String,
    /// Roles the session has switched on.
    pub roles: Vec<String>,
    pub grants: Vec<Grant>,
    /// Statements that take something away. Kept out of `grants` on purpose: a
    /// revoke listed among permissions reads as one.
    pub revokes: Vec<Grant>,
    /// Set only where a role's own grants could not be read, so the page can say
    /// the list is short rather than let it look complete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial: Option<String>,
}

/// Split `GRANT <what> ON <where> TO <who>` into its parts.
///
/// Returns `None` for a statement with no `ON` in it, which is how a role grant
/// is written — `GRANT analyst TO probe_a`. That is a fact about the *session*
/// rather than about an object, and it is read from `system.enabled_roles`
/// instead, where it comes with whether the role is switched on.
pub fn parse(line: &str) -> Option<Grant> {
    let line = line.trim();
    let revoked = line.starts_with("REVOKE ");
    let head = if revoked { "REVOKE " } else { "GRANT " };
    let rest = line.strip_prefix(head)?;

    // ` ON ` rather than `ON`: a column list can hold anything, and
    // `GRANT SELECT(on_time) ON t TO u` must split at the second one.
    let (what, tail) = rest.split_once(" ON ")?;
    // The tail ends at ` TO ` for a grant and ` FROM ` for a revoke.
    let (on, _) = tail
        .split_once(" TO ")
        .or_else(|| tail.split_once(" FROM "))?;

    Some(Grant {
        what: what.trim().to_string(),
        on: on.trim().to_string(),
        revoked,
        grantable: line.ends_with(" WITH GRANT OPTION"),
        statement: line.to_string(),
        direct: true,
        via: Vec::new(),
    })
}

/// One row of `SHOW GRANTS`, whatever the server decided to call the column.
///
/// It names the column after the statement: `GRANTS` for your own, and
/// `GRANTS FOR analyst` for a role's. A fixed field name reads the first and
/// silently fails the second — which it did, and cost the roles their grants
/// while the page looked complete. There is exactly one column either way, so
/// the row is read as a map and the single value taken.
#[derive(Deserialize)]
struct Line(std::collections::HashMap<String, String>);

impl Line {
    fn text(&self) -> Option<&str> {
        self.0.values().next().map(String::as_str)
    }
}

/// Put a grant in the list, or fold it into the one already there.
///
/// The same privilege reaches a user by more than one path, and the list is the
/// answer to "what may I see" rather than a transcript of how it was arranged.
/// Two rows saying `SELECT on analytics.*` invite the reader to count twice.
fn add(into: &mut Vec<Grant>, g: Grant) {
    if let Some(seen) = into
        .iter_mut()
        .find(|s| s.what == g.what && s.on == g.on && s.grantable == g.grantable)
    {
        seen.direct |= g.direct;
        for role in g.via {
            if !seen.via.contains(&role) {
                seen.via.push(role);
            }
        }
        return;
    }
    into.push(g);
}

#[derive(Deserialize)]
struct Role {
    role_name: String,
}

/// Everything the caller may see, asked as the caller.
pub async fn mine(ch: &Client, user: &str) -> Result<MyGrants> {
    let own: Vec<Line> = ch.rows("SHOW GRANTS").await?;

    // Read rather than parsed out of the `GRANT <role> TO <me>` lines: this
    // table says which roles are *switched on* for the session, which is the
    // thing that decides what a query can touch. A role granted and not enabled
    // grants nothing right now, and the two are worth not confusing.
    let roles: Vec<Role> = ch
        .rows("SELECT role_name FROM system.enabled_roles ORDER BY role_name")
        .await
        .unwrap_or_default();
    let roles: Vec<String> = roles.into_iter().map(|r| r.role_name).collect();

    let mut grants: Vec<Grant> = Vec::new();
    let mut revokes: Vec<Grant> = Vec::new();
    for line in own {
        if let Some(g) = line.text().and_then(parse) {
            add(if g.revoked { &mut revokes } else { &mut grants }, g);
        }
    }

    // A role's grants need a second statement each. Failing here is not fatal —
    // the direct grants are still worth showing — but it has to be *said*, or a
    // short list reads as a complete one.
    let mut partial = None;
    for role in &roles {
        // The role name is quoted rather than interpolated bare: `SHOW GRANTS
        // FOR` takes an identifier, and a role may legitimately be named
        // something that needs quoting.
        let sql = format!("SHOW GRANTS FOR {}", super::profile::quote_ident(role));
        match ch.rows::<Line>(&sql).await {
            Ok(lines) => {
                for line in lines {
                    if let Some(mut g) = line.text().and_then(parse) {
                        g.direct = false;
                        g.via = vec![role.clone()];
                        add(if g.revoked { &mut revokes } else { &mut grants }, g);
                    }
                }
            }
            Err(e) => {
                partial = Some(format!(
                    "The role {role} is switched on, but its own grants could not be read \
                     ({e}) — so what it carries is missing from the list below."
                ));
            }
        }
    }

    Ok(MyGrants {
        user: user.to_string(),
        roles,
        grants,
        revokes,
        partial,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_plain_grant() {
        let g = parse("GRANT SELECT ON analytics.* TO probe_a").expect("a grant");
        assert_eq!(g.what, "SELECT");
        assert_eq!(g.on, "analytics.*");
        assert!(!g.revoked);
        assert!(!g.grantable);
        assert!(g.direct);
        assert!(g.via.is_empty());
    }

    #[test]
    fn one_privilege_by_two_paths_is_one_line() {
        // Measured: `probe_a` holds `SELECT ON analytics.*` directly and through
        // the `analyst` role. Two rows would have the reader count twice, and
        // the second path is what they need if the role is ever taken away.
        let mut list = Vec::new();
        add(
            &mut list,
            parse("GRANT SELECT ON analytics.* TO probe_a").expect("direct"),
        );
        let mut through = parse("GRANT SELECT ON analytics.* TO analyst").expect("role");
        through.direct = false;
        through.via = vec!["analyst".to_string()];
        add(&mut list, through);

        assert_eq!(list.len(), 1);
        assert!(list[0].direct);
        assert_eq!(list[0].via, vec!["analyst".to_string()]);
    }

    #[test]
    fn a_grant_only_a_role_carries_is_not_claimed_as_direct() {
        let mut list = Vec::new();
        let mut through = parse("GRANT SELECT ON logs.* TO analyst").expect("role");
        through.direct = false;
        through.via = vec!["analyst".to_string()];
        add(&mut list, through);
        assert!(!list[0].direct);
    }

    #[test]
    fn a_revoke_is_not_a_permission() {
        // Measured on a real user: `SHOW GRANTS` returns statements, and one of
        // them takes `analytics.orders` away. Listed among the grants it would
        // say the opposite of what it means.
        let g = parse("REVOKE SELECT ON analytics.orders FROM probe_cols").expect("a revoke");
        assert!(g.revoked);
        assert_eq!(g.on, "analytics.orders");
    }

    #[test]
    fn splits_at_the_on_that_separates_and_not_at_one_inside_a_column_list() {
        // A column-level grant carries its columns in parentheses, and a column
        // may be called anything at all.
        let g =
            parse("GRANT SELECT(event_time, query_duration_ms) ON system.query_log TO probe_cols")
                .expect("a column grant");
        assert_eq!(g.what, "SELECT(event_time, query_duration_ms)");
        assert_eq!(g.on, "system.query_log");

        let sneaky =
            parse("GRANT SELECT(on_time, off_time) ON flights.legs TO u").expect("a grant");
        assert_eq!(sneaky.on, "flights.legs");
    }

    #[test]
    fn a_role_grant_is_not_about_an_object() {
        // `GRANT analyst TO probe_a` has no `ON`: it is a fact about the
        // session, and `system.enabled_roles` says it better because it also
        // says whether the role is switched on.
        assert!(parse("GRANT analyst TO probe_a").is_none());
    }

    #[test]
    fn notices_what_can_be_passed_on() {
        let g = parse("GRANT SELECT ON *.* TO default WITH GRANT OPTION").expect("a grant");
        assert!(g.grantable);
        assert_eq!(g.on, "*.*");
    }
}
