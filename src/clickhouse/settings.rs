//! The configuration this server is actually running with.
//!
//! Not whichever file somebody believes is deployed. Two tables answer two
//! different questions and the difference between them is the whole reason this
//! module is careful:
//!
//! - **`system.server_settings`** is the server's own configuration — what
//!   `config.xml` and everything in `config.d` came to. It is the same for every
//!   connection, it is authoritative, and it says of each setting whether it can
//!   be changed without a restart, which is the fact an operator actually wants.
//! - **`system.settings`** is what a statement *on this connection* would run
//!   with: the signed-in account's profile, plus anything the client attached.
//!   Flint attaches seven settings to every statement it sends — a timeout, a
//!   row cap, a block size — so a naive read of this table reports **Flint's own
//!   settings as the server's configuration**. That is not a hypothetical: with
//!   `max_execution_time=17` on the request, this table answers `17, changed`.
//!   So the names Flint attaches are passed in and marked, and the page says
//!   which figures are its own doing.
//!
//! Flint reads configuration and asks for a reload. It does not edit the files;
//! those belong to whatever deploys them.

use serde::{Deserialize, Serialize};

use super::{Client, Reach, Section};
use crate::error::Result;

/// One line of the server's configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSetting {
    pub name: String,
    pub value: String,
    pub default: String,
    /// Whether somebody **wrote it down** — which is not the same as whether it
    /// differs from the default, and the difference took measuring: on a stock
    /// dev server 24 of the 46 `changed` server settings hold exactly the value
    /// the server would have used anyway. So this list is what the config files
    /// say, which is the more useful of the two facts and the one the page is
    /// for: "not whichever file somebody believes is deployed".
    pub changed: bool,
    /// Written down, and identical to the default. Config that says nothing —
    /// worth separating from the config that says something, because half of a
    /// long list being inert is why nobody reads the list.
    #[serde(default)]
    pub redundant: bool,
    pub description: String,
    #[serde(rename = "type")]
    pub kind: String,
    /// `Yes`, `No`, or `IncreaseOnly`. The operator's real question about any
    /// server setting is whether acting on it means a restart, and this is the
    /// only place the server answers it.
    pub changeable: String,
    /// The server still parses it and no longer acts on it. A setting that is
    /// both obsolete and changed is configuration somebody wrote that does
    /// nothing — which no amount of reading the file would reveal.
    pub obsolete: bool,
}

/// One setting a statement on this connection would run with.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSetting {
    pub name: String,
    pub value: String,
    pub default: String,
    pub changed: bool,
    pub description: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub obsolete: bool,
    /// `Production`, `Beta`, `Experimental` or `Obsolete`. ClickHouse's own
    /// word for how much it stands behind the setting, and worth carrying: an
    /// experimental setting turned on in production is a finding.
    pub tier: String,
    /// Set by Flint on every statement rather than by the account's profile.
    /// Not read from the server — the server cannot tell the difference — but
    /// filled in from the list Flint knows it sends.
    #[serde(default)]
    pub flints: bool,
    /// This setting differs because `compatibility` asked the server to behave
    /// like an older one, and not because anybody chose it.
    ///
    /// Measured rather than guessed. `compatibility` is a single line that moves
    /// hundreds of settings at once — on a `24.8` account here, 386 of the 387
    /// that differ — so a list of "what a statement runs with" becomes four
    /// hundred rows nobody chose and nobody can read. The attribution is exact
    /// because it is a counterfactual: the same read, with `compatibility`
    /// neutralised for that one query, and anything that stops differing was
    /// its doing.
    #[serde(default)]
    pub from_compatibility: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SettingsReport {
    pub server: Section<ServerSetting>,
    pub session: Section<SessionSetting>,
    /// `compatibility`, if this server has been asked to behave like an older
    /// one. Empty when it has not. Its own field because it explains more
    /// surprising behaviour than anything else on the machine, and because it
    /// is worth looking for rather than finding by scrolling.
    pub compatibility: String,
    /// How many settings of each are left once the unchanged ones are folded
    /// away, so the page can say "31 of 1,617" rather than showing 1,617.
    pub server_total: u64,
    pub session_total: u64,
    /// Which ClickHouse this actually is.
    ///
    /// On this report rather than its own endpoint because it answers the same
    /// question the settings do — why does this server behave like this — and
    /// because the two are read together or not at all.
    pub build: super::build::BuildReport,
    /// The `SYSTEM` commands the console offers, with what each one costs.
    ///
    /// Carried on this report rather than given an endpoint of its own: it is
    /// static text, the console is on this page, and one round trip is one round
    /// trip. Published rather than restated in the frontend so the sentence a
    /// button warns with is the sentence the backend acts under.
    pub commands: Vec<super::sysops::Published>,
}

/// Why a section is empty, in the words of the thing that stopped it.
async fn obstacle(ch: &Client, table: &str) -> Result<Option<String>> {
    Ok(match ch.reach(table).await? {
        Reach::Readable => None,
        Reach::Denied => Some(format!(
            "this user cannot read system.{table}, so Flint cannot say what this server is \
             configured with"
        )),
        Reach::Absent | Reach::Unconfigured => Some(format!(
            "this ClickHouse has no system.{table} — it arrived in a later version"
        )),
    })
}

/// The effective configuration, and what a statement here would run with.
///
/// `flint_settings` is the list of names Flint attaches to everything it sends.
/// Passed in rather than looked up so this module cannot drift from what the
/// client actually does: one list, in the config, used by both.
pub async fn settings(ch: &Client, flint_settings: &[&str]) -> Result<SettingsReport> {
    let (server, server_total) = read_server(ch).await?;
    let (session, session_total, compatibility) = read_session(ch, flint_settings).await?;
    Ok(SettingsReport {
        server,
        session,
        compatibility,
        server_total,
        session_total,
        commands: super::sysops::catalogue(),
        build: super::build::build(ch).await?,
    })
}

async fn read_server(ch: &Client) -> Result<(Section<ServerSetting>, u64)> {
    if let Some(reason) = obstacle(ch, "server_settings").await? {
        return Ok((Section::blocked(reason), 0));
    }

    #[derive(Deserialize)]
    struct Count {
        n: u64,
    }
    let total = ch
        .row::<Count>("SELECT count() AS n FROM system.server_settings")
        .await?
        .map(|c| c.n)
        .unwrap_or(0);

    // Only the ones somebody wrote down. `changed` does not mean "differs from
    // the default" — 24 of the 46 on a stock dev server hold exactly the default
    // value — it means the setting appears in a config file, which is the more
    // useful fact and the one this page is for. A list of all 439 is a list
    // nobody reads.
    let mut items: Vec<ServerSetting> = ch
        .rows(
            "SELECT name                                  AS name, \
                    value                                 AS value, \
                    default                               AS default, \
                    CAST(changed != 0 AS Bool)            AS changed, \
                    description                           AS description, \
                    type                                  AS type, \
                    toString(changeable_without_restart)  AS changeable, \
                    CAST(is_obsolete != 0 AS Bool)        AS obsolete, \
                    CAST(changed != 0 AND value = default AS Bool) AS redundant \
             FROM system.server_settings \
             WHERE changed != 0 \
             ORDER BY is_obsolete DESC, name \
             LIMIT 2000",
        )
        .await?;

    // Obsolete first, then the ones that actually change something, then the
    // ones that repeat a default: the order the reader wants, since the tail is
    // the part with nothing in it.
    sort_server(&mut items);
    Ok((Section::of(items), total))
}

async fn read_session(
    ch: &Client,
    flint_settings: &[&str],
) -> Result<(Section<SessionSetting>, u64, String)> {
    if let Some(reason) = obstacle(ch, "settings").await? {
        return Ok((Section::blocked(reason), 0, String::new()));
    }

    #[derive(Deserialize)]
    struct Count {
        n: u64,
    }
    let total = ch
        .row::<Count>("SELECT count() AS n FROM system.settings")
        .await?
        .map(|c| c.n)
        .unwrap_or(0);

    let mut items: Vec<SessionSetting> = ch
        .rows(
            "SELECT name                           AS name, \
                    value                          AS value, \
                    default                        AS default, \
                    CAST(changed != 0 AS Bool)     AS changed, \
                    description                    AS description, \
                    type                           AS type, \
                    CAST(is_obsolete != 0 AS Bool) AS obsolete, \
                    toString(tier)                 AS tier \
             FROM system.settings \
             WHERE changed != 0 OR name = 'compatibility' \
             ORDER BY name \
             LIMIT 2000",
        )
        .await?;

    mark_flints(&mut items, flint_settings);
    let compatibility = items
        .iter()
        .find(|s| s.name == "compatibility" && !s.value.is_empty())
        .map(|s| s.value.clone())
        .unwrap_or_default();
    // Selected so it could be reported, and dropped again if it says nothing:
    // `compatibility` at its default is not a changed setting and does not
    // belong in a list of them.
    items.retain(|s| s.changed);

    // Ask the counterfactual, but only when there is one to ask. A per-query
    // `SETTINGS compatibility = ''` undoes the line for that one statement, so
    // whatever stops differing was the line's doing and not a choice. One extra
    // query, and it turns four hundred unreadable rows into one sentence and a
    // handful somebody actually made.
    if !compatibility.is_empty() {
        if let Ok(chosen) = chosen_anyway(ch).await {
            for item in items.iter_mut() {
                item.from_compatibility = !chosen.contains(&item.name);
            }
        }
    }

    Ok((Section::of(items), total, compatibility))
}

/// The settings that would still differ with `compatibility` undone.
///
/// Failure is not fatal and is not reported: losing the attribution costs the
/// page a fold, and the list it folds is still there and still true. A server
/// old enough to reject a `SETTINGS` clause on this table should not lose the
/// settings page over it.
async fn chosen_anyway(ch: &Client) -> Result<std::collections::HashSet<String>> {
    #[derive(Deserialize)]
    struct Row {
        name: String,
    }
    let rows: Vec<Row> = ch
        .rows(
            "SELECT name AS name FROM system.settings WHERE changed != 0 \
             SETTINGS compatibility = ''",
        )
        .await?;
    Ok(rows.into_iter().map(|r| r.name).collect())
}

/// Obsolete first, then the settings that actually change something, then the
/// ones that write down a default.
///
/// The tail is the part with nothing in it, and it is half the list on a stock
/// server — 24 of 46 here.
fn sort_server(items: &mut [ServerSetting]) {
    items.sort_by(|a, b| {
        b.obsolete
            .cmp(&a.obsolete)
            .then(a.redundant.cmp(&b.redundant))
            .then(a.name.cmp(&b.name))
    });
}

/// Mark the settings that are Flint's own doing.
///
/// The server cannot tell them apart — a setting on the request and a setting
/// from a profile arrive at `system.settings` identically — so the only way to
/// be honest about it is for Flint to say which ones it sent.
pub fn mark_flints(items: &mut [SessionSetting], flint_settings: &[&str]) {
    for item in items.iter_mut() {
        item.flints = flint_settings.contains(&item.name.as_str());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setting(name: &str) -> SessionSetting {
        SessionSetting {
            name: name.into(),
            value: "1".into(),
            default: "0".into(),
            changed: true,
            description: String::new(),
            kind: "UInt64".into(),
            obsolete: false,
            tier: "Production".into(),
            flints: false,
            from_compatibility: false,
        }
    }

    #[test]
    fn the_inert_half_of_the_list_sinks_to_the_bottom() {
        // Half of a long list repeating defaults is why nobody reads the list,
        // and the first attempt at this comparator mixed `a` and `b` inside one
        // tuple — not an ordering at all, and it put the inert half on top.
        let s = |name: &str, obsolete: bool, redundant: bool| ServerSetting {
            name: name.into(),
            value: "1".into(),
            default: "1".into(),
            changed: true,
            description: String::new(),
            kind: "UInt64".into(),
            changeable: "No".into(),
            obsolete,
            redundant,
        };
        let mut items = vec![
            s("inert", false, true),
            s("real", false, false),
            s("gone", true, false),
            s("another_real", false, false),
        ];
        sort_server(&mut items);
        assert_eq!(
            items.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(),
            ["gone", "another_real", "real", "inert"]
        );
    }

    #[test]
    fn flints_own_settings_are_marked_as_its_own() {
        // Verified against the server first: with `max_execution_time=17` on the
        // request, `system.settings` answers `17, changed` — indistinguishable
        // from a profile having set it. Reporting that as the server's
        // configuration is the bug this exists to prevent.
        let mut items = vec![
            setting("max_execution_time"),
            setting("max_threads"),
            setting("max_result_rows"),
        ];
        mark_flints(&mut items, &["max_execution_time", "max_result_rows"]);
        assert!(items[0].flints);
        // Somebody's profile really did set this one.
        assert!(!items[1].flints);
        assert!(items[2].flints);
    }

    #[test]
    fn the_list_holds_every_name_the_client_pushes() {
        // Not a tautology if it names the ones that were *missed*: `log_comment`
        // and `default_format` were left out on the reasoning that they steer a
        // request rather than being configuration, and `log_comment` promptly
        // appeared on the configuration page reading `flint:introspection`.
        for name in [
            "log_comment",
            "default_format",
            "output_format_json_quote_64bit_integers",
            "max_execution_time",
            "readonly",
        ] {
            assert!(
                super::super::ATTACHED_SETTINGS.contains(&name),
                "{name} is sent on every request and would read as this server's own"
            );
        }
    }

    #[test]
    fn a_name_that_merely_contains_one_is_not_one() {
        let mut items = vec![setting("max_execution_time_leeway")];
        mark_flints(&mut items, &["max_execution_time"]);
        assert!(!items[0].flints);
    }
}
