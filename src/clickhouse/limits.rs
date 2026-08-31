//! How much, and which rows.
//!
//! `access.rs` answers what an account is allowed to *do*. This answers the
//! other half, which a stock ClickHouse configures in three places nobody
//! stumbles across: a **quota** caps what an account may consume, a **settings
//! profile** fixes and constrains the settings it runs with, and a **row
//! policy** decides which rows it sees at all. Multi-tenant ClickHouse is these
//! three tables and almost nothing else.
//!
//! Read-only, like `access.rs`, and for the same reason.
//!
//! Each of the three is privileged, and each can be denied on its own — a role
//! granted `SHOW QUOTAS` is not thereby granted `SHOW ROW POLICIES`. So each
//! section carries its own obstacle rather than the page carrying one: a list
//! that is empty because nobody may read it must not look like a list that is
//! empty because there is nothing in it.

use serde::{Deserialize, Serialize};

use super::{Client, Reach, Section};
use crate::error::Result;

/// The dimensions a quota can cap, in the order the SQL below selects them.
///
/// Every one is a count of something; execution time is the exception and is
/// read on its own, because seconds are not countable things and the UI has to
/// format them differently. The labels are the ones a person would use: the
/// column is `max_query_selects`, the thing it caps is selects.
const DIMENSIONS: [(&str, Unit); 11] = [
    ("queries", Unit::Count),
    ("selects", Unit::Count),
    ("inserts", Unit::Count),
    ("errors", Unit::Count),
    ("result rows", Unit::Count),
    ("result bytes", Unit::Bytes),
    ("rows read", Unit::Count),
    ("bytes read", Unit::Bytes),
    ("bytes written", Unit::Bytes),
    ("failed logins in a row", Unit::Count),
    ("queries of one shape", Unit::Count),
];

/// The columns of `system.quota_limits` and `system.quotas_usage` that
/// `DIMENSIONS` names, in the same order. Kept beside it so the two cannot
/// drift apart without the drift being visible in one screen.
const COLUMNS: [&str; 11] = [
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

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Count,
    Bytes,
    Seconds,
}

/// One cap that is actually set.
///
/// A dimension with no ceiling is not in this list at all. Eleven rows of "no
/// limit" against one real one buries the only figure on the screen that means
/// anything, and an absent figure is dropped rather than dashed.
#[derive(Debug, Clone, Serialize)]
pub struct Ceiling {
    pub dimension: String,
    pub unit: Unit,
    pub max: f64,
    /// What has been used against this ceiling in the interval being reported.
    /// Absent where the interval has not started, or where usage could not be
    /// read — which are different things, and the section says which.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Interval {
    /// The window the caps apply over, in seconds.
    pub duration_secs: u32,
    /// ClickHouse can offset the window per key so every account's hour does
    /// not end at the same instant. Worth saying, because it means two users
    /// on the same quota are not counted over the same hour.
    pub randomized: bool,
    pub ceilings: Vec<Ceiling>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Quota {
    pub name: String,
    pub storage: String,
    /// What the counters are kept per: `user_name`, `ip_address`, `client_key`
    /// and so on. Empty means one set of counters shared by everyone the quota
    /// applies to — the difference between "sixty queries each" and "sixty
    /// queries between you".
    pub keys: Vec<String>,
    pub apply_to_all: bool,
    pub apply_to_list: Vec<String>,
    pub apply_to_except: Vec<String>,
    pub intervals: Vec<Interval>,
}

/// One account's consumption of one quota over one interval.
#[derive(Debug, Clone, Serialize)]
pub struct Consumption {
    pub quota_name: String,
    /// The value of the quota's key this row counts: a user name, an IP, or
    /// empty where the quota is not keyed and everyone shares one bucket.
    pub quota_key: String,
    pub duration_secs: u32,
    pub start_time: String,
    pub end_time: String,
    pub ceilings: Vec<Ceiling>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfileSetting {
    pub setting: String,
    pub value: String,
    /// A floor and a ceiling somebody may not go outside. Empty where unset.
    pub min: String,
    pub max: String,
    /// `CONST` means the setting is fixed and cannot be changed at all;
    /// `WRITABLE` is the default and says nothing, so the UI drops it.
    pub writability: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Profile {
    pub name: String,
    pub storage: String,
    pub apply_to_all: bool,
    pub apply_to_list: Vec<String>,
    pub apply_to_except: Vec<String>,
    pub settings: Vec<ProfileSetting>,
    /// Profiles this one is built on. A profile can inherit another, and the
    /// settings it appears to hold may be coming from there.
    pub inherits: Vec<String>,
    /// Accounts that run with this profile but are not in `apply_to_list`.
    ///
    /// A profile is fastened on from either end, and the two look nothing alike
    /// in the tables: `CREATE SETTINGS PROFILE p TO bob` fills the profile's
    /// own list, while `CREATE USER bob SETTINGS PROFILE p` writes a row against
    /// *bob* in `settings_profile_elements` and leaves the profile's list empty.
    /// The stock `default` profile is attached the second way to every user on
    /// the server — so a page reading only the first would report the profile
    /// every query on the machine runs under as applying to nobody.
    pub attached_by_account: Vec<String>,
}

/// Settings fastened straight onto one account, belonging to no profile.
///
/// These live in `system.settings_profile_elements` beside the profile rows and
/// are easy to read as part of a profile, which they are not: `ALTER USER x
/// SETTINGS max_memory_usage = …` writes one, and it applies to `x` alone. A
/// page that showed only profiles would say a user runs with the profile's
/// settings while the server runs it with these.
#[derive(Debug, Clone, Serialize)]
pub struct Pinned {
    pub holder: String,
    pub is_user: bool,
    pub settings: Vec<ProfileSetting>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RowPolicy {
    /// `name ON db.table`, as ClickHouse stores it.
    pub name: String,
    pub short_name: String,
    pub database: String,
    pub table: String,
    pub storage: String,
    /// The `USING` expression. A policy with none lets every row through.
    pub filter: String,
    pub restrictive: bool,
    pub apply_to_all: bool,
    pub apply_to_list: Vec<String>,
    pub apply_to_except: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LimitsReport {
    pub quotas: Section<Quota>,
    /// Whose consumption these figures are. `everyone` where Flint could read
    /// `system.quotas_usage`; `you` where it could only read the caller's own.
    /// The distinction has to be on the screen: a quota that looks unused
    /// because you have not used it is a dangerous thing to conclude.
    pub usage_scope: &'static str,
    pub usage: Section<Consumption>,
    pub profiles: Section<Profile>,
    pub pinned: Section<Pinned>,
    pub policies: Section<RowPolicy>,
}

/// Build the SQL array of a quota table's `max_*` columns, in `DIMENSIONS`
/// order, as one `Array(Nullable(UInt64))`.
///
/// Execution time is deliberately not in it: it is a `Float64`, and putting it
/// in the same array would promote every count to a float — which is how a
/// `max_read_bytes` of a few petabytes stops being the number somebody typed.
fn maxes() -> String {
    let cols: Vec<String> = COLUMNS.iter().map(|c| format!("max_{c}")).collect();
    format!("[{}]", cols.join(", "))
}

/// The same columns without the `max_` prefix: what has been consumed.
fn useds() -> String {
    format!("[{}]", COLUMNS.join(", "))
}

/// Zip the arrays back into the dimensions that are actually capped.
fn ceilings(maxes: &[Option<u64>], useds: Option<&[Option<u64>]>) -> Vec<Ceiling> {
    let mut out = Vec::new();
    for (i, (dimension, unit)) in DIMENSIONS.iter().enumerate() {
        let Some(Some(max)) = maxes.get(i) else {
            continue;
        };
        out.push(Ceiling {
            dimension: (*dimension).to_string(),
            unit: *unit,
            max: *max as f64,
            used: useds
                .and_then(|u| u.get(i).copied().flatten())
                .map(|v| v as f64),
        });
    }
    out
}

/// Add the one dimension measured in seconds, if it is capped.
fn with_time(mut list: Vec<Ceiling>, max: Option<f64>, used: Option<f64>) -> Vec<Ceiling> {
    if let Some(max) = max {
        list.push(Ceiling {
            dimension: "execution time".into(),
            unit: Unit::Seconds,
            max,
            used,
        });
    }
    list
}

pub async fn limits(ch: &Client) -> Result<LimitsReport> {
    // Read independently of the quota definitions on purpose. An account that
    // may not read `system.quotas` may still read its own `system.quota_usage`,
    // and that row carries its own ceilings — so being refused the definitions
    // costs the list of quotas, not the answer to "how close am I".
    let (usage, usage_scope) = read_usage(ch).await?;
    let quotas = read_quotas(ch).await?;
    let (profiles, pinned) = read_profiles(ch).await?;
    let policies = read_policies(ch).await?;

    Ok(LimitsReport {
        quotas,
        usage_scope,
        usage,
        profiles,
        pinned,
        policies,
    })
}

/// Why a section is empty, in the words of the thing that stopped it.
async fn obstacle(ch: &Client, table: &str, grant: &str) -> Result<Option<String>> {
    Ok(match ch.reach(table).await? {
        Reach::Readable => None,
        Reach::Denied => Some(format!(
            "this user cannot read system.{table} — it needs {grant}, which does not let Flint \
             change anything"
        )),
        // Folded together on purpose: `Unconfigured` is about a missing Keeper,
        // which access control does not use, so if a server ever answers it
        // here "no such table" is still the useful half of the truth.
        Reach::Absent | Reach::Unconfigured => {
            Some(format!("this ClickHouse has no system.{table}"))
        }
    })
}

async fn read_quotas(ch: &Client) -> Result<Section<Quota>> {
    if let Some(reason) = obstacle(ch, "quotas", "SHOW QUOTAS").await? {
        return Ok(Section::blocked(reason));
    }

    #[derive(Deserialize)]
    struct QuotaRow {
        name: String,
        storage: String,
        keys: Vec<String>,
        apply_to_all: bool,
        apply_to_list: Vec<String>,
        apply_to_except: Vec<String>,
    }

    let rows: Vec<QuotaRow> = ch
        .rows(
            "SELECT name                            AS name, \
                    storage                         AS storage, \
                    arrayMap(k -> toString(k), keys) AS keys, \
                    CAST(apply_to_all != 0 AS Bool) AS apply_to_all, \
                    apply_to_list                   AS apply_to_list, \
                    apply_to_except                 AS apply_to_except \
             FROM system.quotas ORDER BY name LIMIT 1000",
        )
        .await?;

    // The ceilings come from `system.quota_limits` rather than from usage,
    // because a quota nobody has hit yet has no usage row and its caps would
    // otherwise be invisible until the moment they started to matter.
    #[derive(Deserialize)]
    struct LimitRow {
        quota_name: String,
        duration_secs: u32,
        randomized: bool,
        maxes: Vec<Option<u64>>,
        max_execution_time: Option<f64>,
    }

    let limits: Vec<LimitRow> = ch
        .rows(&format!(
            "SELECT quota_name                                AS quota_name, \
                    duration                                  AS duration_secs, \
                    CAST(is_randomized_interval != 0 AS Bool) AS randomized, \
                    {}                                        AS maxes, \
                    max_execution_time                        AS max_execution_time \
             FROM system.quota_limits ORDER BY quota_name, duration LIMIT 5000",
            maxes()
        ))
        .await?;

    let quotas: Vec<Quota> = rows
        .into_iter()
        .map(|q| Quota {
            intervals: limits
                .iter()
                .filter(|l| l.quota_name == q.name)
                .map(|l| Interval {
                    duration_secs: l.duration_secs,
                    randomized: l.randomized,
                    ceilings: with_time(ceilings(&l.maxes, None), l.max_execution_time, None),
                })
                .collect(),
            name: q.name,
            storage: q.storage,
            keys: q.keys,
            apply_to_all: q.apply_to_all,
            apply_to_list: q.apply_to_list,
            apply_to_except: q.apply_to_except,
        })
        .collect();

    Ok(Section::of(quotas))
}

/// Consumption, from whichever of the two usage tables this account may read.
///
/// `system.quotas_usage` is everybody's and needs the privilege;
/// `system.quota_usage` is your own and needs nothing. Falling back to the
/// second is worth doing — your own figures are better than none — but only if
/// the page then says whose they are, which is what the scope is for.
async fn read_usage(ch: &Client) -> Result<(Section<Consumption>, &'static str)> {
    #[derive(Deserialize)]
    struct UsageRow {
        quota_name: String,
        quota_key: String,
        duration_secs: u32,
        start_time: String,
        end_time: String,
        maxes: Vec<Option<u64>>,
        useds: Vec<Option<u64>>,
        max_execution_time: Option<f64>,
        execution_time: Option<f64>,
    }

    let sql = |table: &str| {
        format!(
            "SELECT quota_name                    AS quota_name, \
                    quota_key                      AS quota_key, \
                    toUInt32(coalesce(duration, 0)) AS duration_secs, \
                    toString(coalesce(start_time, toDateTime(0))) AS start_time, \
                    toString(coalesce(end_time, toDateTime(0)))   AS end_time, \
                    {}                             AS maxes, \
                    {}                             AS useds, \
                    max_execution_time             AS max_execution_time, \
                    execution_time                 AS execution_time \
             FROM system.{table} \
             WHERE duration IS NOT NULL \
             ORDER BY quota_name, quota_key, duration LIMIT 5000",
            maxes(),
            useds()
        )
    };

    let build = |rows: Vec<UsageRow>| {
        rows.into_iter()
            .map(|u| Consumption {
                ceilings: with_time(
                    ceilings(&u.maxes, Some(&u.useds)),
                    u.max_execution_time,
                    u.execution_time,
                ),
                quota_name: u.quota_name,
                quota_key: u.quota_key,
                duration_secs: u.duration_secs,
                start_time: u.start_time,
                end_time: u.end_time,
            })
            .collect::<Vec<_>>()
    };

    if obstacle(ch, "quotas_usage", "SHOW QUOTAS").await?.is_none() {
        let rows: Vec<UsageRow> = ch.rows(&sql("quotas_usage")).await?;
        return Ok((Section::of(build(rows)), "everyone"));
    }

    match obstacle(ch, "quota_usage", "nothing at all").await? {
        None => {
            let rows: Vec<UsageRow> = ch.rows(&sql("quota_usage")).await?;
            Ok((Section::of(build(rows)), "you"))
        }
        Some(reason) => Ok((Section::blocked(reason), "everyone")),
    }
}

/// One row of `system.settings_profile_elements`.
///
/// That one table holds three different kinds of row, told apart by which of
/// its three name columns is filled: a profile's setting, a setting pinned onto
/// an account, and — where the setting name is empty and a profile name is not
/// — an inheritance. Reading it as one list of settings gets all three wrong.
#[derive(Debug, Clone, Deserialize)]
struct ElementRow {
    profile_name: String,
    user_name: String,
    role_name: String,
    setting_name: String,
    value: String,
    min: String,
    max: String,
    writability: String,
    inherit_profile: String,
}

/// The setting a row describes, with the noise taken out.
fn setting_of(e: &ElementRow) -> ProfileSetting {
    ProfileSetting {
        setting: e.setting_name.clone(),
        value: e.value.clone(),
        min: e.min.clone(),
        max: e.max.clone(),
        // WRITABLE is the default and says nothing; only CONST is news.
        writability: if e.writability == "WRITABLE" {
            String::new()
        } else {
            e.writability.clone()
        },
    }
}

async fn read_profiles(ch: &Client) -> Result<(Section<Profile>, Section<Pinned>)> {
    if let Some(reason) = obstacle(ch, "settings_profiles", "SHOW SETTINGS PROFILES").await? {
        return Ok((Section::blocked(reason.clone()), Section::blocked(reason)));
    }

    #[derive(Deserialize)]
    struct ProfileRow {
        name: String,
        storage: String,
        apply_to_all: bool,
        apply_to_list: Vec<String>,
        apply_to_except: Vec<String>,
    }

    let profiles: Vec<ProfileRow> = ch
        .rows(
            "SELECT name                            AS name, \
                    storage                         AS storage, \
                    CAST(apply_to_all != 0 AS Bool) AS apply_to_all, \
                    apply_to_list                   AS apply_to_list, \
                    apply_to_except                 AS apply_to_except \
             FROM system.settings_profiles ORDER BY name LIMIT 1000",
        )
        .await?;

    let elements: Vec<ElementRow> = match ch
        .rows::<ElementRow>(
            "SELECT coalesce(profile_name, '')    AS profile_name, \
                    coalesce(user_name, '')       AS user_name, \
                    coalesce(role_name, '')       AS role_name, \
                    coalesce(setting_name, '')    AS setting_name, \
                    coalesce(value, '')           AS value, \
                    coalesce(min, '')             AS min, \
                    coalesce(max, '')             AS max, \
                    coalesce(toString(writability), '') AS writability, \
                    coalesce(inherit_profile, '') AS inherit_profile \
             FROM system.settings_profile_elements ORDER BY index LIMIT 5000",
        )
        .await
    {
        Ok(rows) => rows,
        // The elements can be denied while the profile names are not. A profile
        // with no settings shown is still worth listing — its name and who it
        // applies to are half the fact.
        Err(crate::error::Error::ClickHouse { code: 497, .. }) => Vec::new(),
        Err(e) => return Err(e),
    };

    let built: Vec<Profile> = profiles
        .into_iter()
        .map(|p| Profile {
            settings: elements
                .iter()
                .filter(|e| e.profile_name == p.name && !e.setting_name.is_empty())
                .map(setting_of)
                .collect(),
            inherits: elements
                .iter()
                .filter(|e| {
                    e.profile_name == p.name
                        && e.setting_name.is_empty()
                        && !e.inherit_profile.is_empty()
                })
                .map(|e| e.inherit_profile.clone())
                .collect(),
            attached_by_account: attached_to(&elements, &p.name),
            name: p.name,
            storage: p.storage,
            apply_to_all: p.apply_to_all,
            apply_to_list: p.apply_to_list,
            apply_to_except: p.apply_to_except,
        })
        .collect();

    Ok((Section::of(built), Section::of(pinned(&elements))))
}

/// The accounts that carry this profile through an element of their own.
///
/// Sorted and deduplicated: one account can name the same profile more than
/// once across its elements, and the same name twice in a list reads as two
/// accounts.
fn attached_to(elements: &[ElementRow], profile: &str) -> Vec<String> {
    let mut out: Vec<String> = elements
        .iter()
        .filter(|e| e.inherit_profile == profile && e.profile_name.is_empty())
        .map(|e| {
            if e.user_name.is_empty() {
                e.role_name.clone()
            } else {
                e.user_name.clone()
            }
        })
        .filter(|n| !n.is_empty())
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Group the account-owned elements by whose they are.
///
/// A row carrying neither a setting nor an inherited profile is dropped without
/// a word: it is an empty element, not a fact being hidden. So is an account
/// that only names a profile: "bob has the default profile" is true of every
/// account on the server, and it is already said on the profile itself. What
/// survives here is what is *unique* to one account — a setting fastened onto
/// it and belonging to no profile at all.
fn pinned(elements: &[ElementRow]) -> Vec<Pinned> {
    let mut out: Vec<Pinned> = Vec::new();
    for e in elements {
        let (holder, is_user) = if !e.user_name.is_empty() {
            (e.user_name.to_string(), true)
        } else if !e.role_name.is_empty() {
            (e.role_name.to_string(), false)
        } else {
            continue;
        };
        if e.setting_name.is_empty() {
            continue;
        }
        let slot = match out
            .iter_mut()
            .find(|p| p.holder == holder && p.is_user == is_user)
        {
            Some(slot) => slot,
            None => {
                out.push(Pinned {
                    holder,
                    is_user,
                    settings: Vec::new(),
                });
                out.last_mut().expect("just pushed")
            }
        };
        slot.settings.push(setting_of(e));
    }
    out
}

async fn read_policies(ch: &Client) -> Result<Section<RowPolicy>> {
    if let Some(reason) = obstacle(ch, "row_policies", "SHOW ROW POLICIES").await? {
        return Ok(Section::blocked(reason));
    }

    let items: Vec<RowPolicy> = ch
        .rows(
            "SELECT name                               AS name, \
                    short_name                         AS short_name, \
                    database                           AS database, \
                    table                              AS table, \
                    storage                            AS storage, \
                    coalesce(select_filter, '')        AS filter, \
                    CAST(is_restrictive != 0 AS Bool)  AS restrictive, \
                    CAST(apply_to_all != 0 AS Bool)    AS apply_to_all, \
                    apply_to_list                      AS apply_to_list, \
                    apply_to_except                    AS apply_to_except \
             FROM system.row_policies ORDER BY database, table, short_name LIMIT 2000",
        )
        .await?;

    Ok(Section::of(items))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn element(over: impl Fn(&mut ElementRow)) -> ElementRow {
        let mut e = ElementRow {
            profile_name: String::new(),
            user_name: String::new(),
            role_name: String::new(),
            setting_name: String::new(),
            value: String::new(),
            min: String::new(),
            max: String::new(),
            writability: String::new(),
            inherit_profile: String::new(),
        };
        over(&mut e);
        e
    }

    #[test]
    fn a_dimension_with_no_ceiling_is_not_a_row() {
        // Eleven rows of "no limit" against one real one buries the only figure
        // on the screen that means anything.
        let mut maxes = vec![None; 11];
        maxes[0] = Some(60);
        maxes[6] = Some(1_000_000);
        let out = ceilings(&maxes, None);
        assert_eq!(
            out.iter().map(|c| c.dimension.as_str()).collect::<Vec<_>>(),
            ["queries", "rows read"]
        );
        // Nothing consumed is absent, not zero: an empty bar reads as idle.
        assert!(out[0].used.is_none());
    }

    #[test]
    fn consumption_is_paired_with_its_own_dimension() {
        let mut maxes = vec![None; 11];
        let mut useds = vec![None; 11];
        maxes[3] = Some(10); // errors
        useds[3] = Some(4);
        useds[0] = Some(999); // queries, which has no ceiling
        let out = ceilings(&maxes, Some(&useds));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].dimension, "errors");
        assert_eq!(out[0].used, Some(4.0));
    }

    #[test]
    fn the_two_constants_describe_the_same_columns() {
        // The labels and the columns are read positionally. A dimension added
        // to one and not the other would silently mislabel every figure after
        // it, which is worse than failing.
        assert_eq!(DIMENSIONS.len(), COLUMNS.len());
        assert!(maxes().starts_with("[max_queries, max_query_selects"));
        assert!(useds().starts_with("[queries, query_selects"));
    }

    #[test]
    fn execution_time_joins_the_list_only_when_it_is_capped() {
        assert!(with_time(Vec::new(), None, Some(3.0)).is_empty());
        let out = with_time(Vec::new(), Some(30.0), Some(3.0));
        assert_eq!(out.len(), 1);
        assert!(matches!(out[0].unit, Unit::Seconds));
        assert_eq!(out[0].used, Some(3.0));
    }

    #[test]
    fn a_profile_is_attached_from_either_end() {
        // `CREATE USER bob SETTINGS PROFILE default` writes a row against bob,
        // not against the profile — which is how every account on a stock
        // server holds the `default` profile while its own list stays empty.
        let elements = [
            element(|e| {
                e.user_name = "bob".into();
                e.inherit_profile = "default".into();
            }),
            element(|e| {
                e.role_name = "analyst".into();
                e.inherit_profile = "default".into();
            }),
            // A row belonging to the profile itself is not an attachment.
            element(|e| {
                e.profile_name = "default".into();
                e.inherit_profile = "readonly".into();
            }),
        ];
        assert_eq!(attached_to(&elements, "default"), ["analyst", "bob"]);
        assert!(attached_to(&elements, "careful").is_empty());
    }

    #[test]
    fn pinning_keeps_only_what_belongs_to_one_account() {
        let elements = [
            element(|e| {
                e.user_name = "bob".into();
                e.setting_name = "max_memory_usage".into();
                e.value = "2000000000".into();
                e.writability = "WRITABLE".into();
            }),
            // "bob has the default profile" is true of every account on the
            // server and is already said on the profile; it is not a pin.
            element(|e| {
                e.user_name = "bob".into();
                e.inherit_profile = "default".into();
            }),
            // An element carrying neither is empty, not a fact being hidden.
            element(|e| e.user_name = "zoe".into()),
            element(|e| {
                e.profile_name = "careful".into();
                e.setting_name = "max_threads".into();
            }),
        ];
        let out = pinned(&elements);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].holder, "bob");
        assert!(out[0].is_user);
        assert_eq!(out[0].settings.len(), 1);
        // WRITABLE is the default and says nothing, so it is dropped.
        assert_eq!(out[0].settings[0].writability, "");
    }

    #[test]
    fn one_account_with_several_settings_is_one_entry() {
        let elements = [
            element(|e| {
                e.user_name = "bob".into();
                e.setting_name = "a".into();
            }),
            element(|e| {
                e.user_name = "bob".into();
                e.setting_name = "b".into();
                e.writability = "CONST".into();
            }),
        ];
        let out = pinned(&elements);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].settings.len(), 2);
        assert_eq!(out[0].settings[1].writability, "CONST");
    }
}
