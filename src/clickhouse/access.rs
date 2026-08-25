//! Who can do what.
//!
//! Read-only, deliberately. Flint will show you that a user can log in without
//! a password, or that a role nobody holds is still carrying grants — it will
//! not change any of it. Granting and revoking are decisions with consequences
//! that outlive a click, and they belong in a statement somebody wrote on
//! purpose.
//!
//! Every one of these tables is privileged: a read-only role usually cannot
//! read `system.users` at all. That is a configuration fact and is reported as
//! one, with the grant it would need.

use serde::{Deserialize, Serialize};

use super::{Client, Reach};
use crate::error::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub name: String,
    /// An array: recent ClickHouse lets one user hold several authentication
    /// methods, and `no_password` among them is the fact worth seeing.
    #[serde(default)]
    pub auth_type: Vec<String>,
    #[serde(default)]
    pub host_ip: Vec<String>,
    #[serde(default)]
    pub host_names: Vec<String>,
    pub default_roles_all: bool,
    #[serde(default)]
    pub default_roles_list: Vec<String>,
    #[serde(default)]
    pub default_database: String,
    /// One entry per authentication method — a user may hold several, each
    /// with its own expiry. Epoch means "no expiry", which is how ClickHouse
    /// says it.
    #[serde(default)]
    pub valid_until: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Role {
    pub name: String,
    #[serde(default)]
    pub storage: String,
}

/// One scope somebody has rights on: `analytics.*`, `system.query_log`, `*.*`.
///
/// Aggregated by scope rather than listed per access type, because ClickHouse
/// stores one row per privilege and a full-access user has seventy of them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Grant {
    pub grantee: String,
    pub is_user: bool,
    /// `*` where the grant is not narrowed to one.
    pub database: String,
    pub table: String,
    pub with_grant_option: bool,
    /// A partial revoke: rights taken back inside a wider grant. Rare, and
    /// invisible if you only read the positive rows.
    pub revoked: bool,
    pub access: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleGrant {
    pub grantee: String,
    pub is_user: bool,
    pub role: String,
    pub is_default: bool,
    pub with_admin_option: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccessReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub users: Vec<User>,
    pub roles: Vec<Role>,
    pub grants: Vec<Grant>,
    pub role_grants: Vec<RoleGrant>,
}

fn unavailable(reason: String) -> AccessReport {
    AccessReport {
        available: false,
        reason: Some(reason),
        users: Vec::new(),
        roles: Vec::new(),
        grants: Vec::new(),
        role_grants: Vec::new(),
    }
}

pub async fn access(ch: &Client) -> Result<AccessReport> {
    match ch.reach("users").await? {
        Reach::Readable => {}
        Reach::Denied => {
            return Ok(unavailable(
                "this user cannot read system.users. Reading access control needs SHOW USERS, \
                 SHOW ROLES and SELECT on those tables — none of which lets Flint change \
                 anything."
                    .into(),
            ))
        }
        Reach::Absent => return Ok(unavailable("this server has no system.users".into())),
    }

    let valid_until = ch.col_or("users", "valid_until", "[]").await?;
    let default_database = ch.col_or("users", "default_database", "''").await?;

    let users: Vec<User> = ch
        .rows(&format!(
            "SELECT name                                 AS name, \
                    auth_type                            AS auth_type, \
                    host_ip                              AS host_ip, \
                    host_names                           AS host_names, \
                    CAST(default_roles_all != 0 AS Bool) AS default_roles_all, \
                    default_roles_list                   AS default_roles_list, \
                    {default_database}                   AS default_database, \
                    arrayMap(x -> toString(x), {valid_until}) AS valid_until \
             FROM system.users \
             ORDER BY name \
             LIMIT 2000"
        ))
        .await?;

    // Each of the remaining three can be denied on its own — a role granted
    // SHOW USERS is not necessarily granted SHOW ROLES — so a failure on any of
    // them costs that list, not the page.
    let roles: Vec<Role> = optional(
        ch,
        "SELECT name AS name, storage AS storage FROM system.roles ORDER BY name LIMIT 2000",
    )
    .await?;

    let grants: Vec<Grant> = optional(
        ch,
        "SELECT coalesce(user_name, role_name)       AS grantee, \
                CAST(user_name IS NOT NULL AS Bool)  AS is_user, \
                coalesce(database, '*')              AS database, \
                coalesce(table, '*')                 AS table, \
                CAST(grant_option != 0 AS Bool)      AS with_grant_option, \
                CAST(is_partial_revoke != 0 AS Bool) AS revoked, \
                arraySort(groupArray(access_type))   AS access \
         FROM system.grants \
         GROUP BY grantee, is_user, database, table, with_grant_option, revoked \
         ORDER BY grantee, database, table \
         LIMIT 5000",
    )
    .await?;

    let role_grants: Vec<RoleGrant> = optional(
        ch,
        "SELECT coalesce(user_name, role_name)             AS grantee, \
                CAST(user_name IS NOT NULL AS Bool)        AS is_user, \
                granted_role_name                          AS role, \
                CAST(granted_role_is_default != 0 AS Bool) AS is_default, \
                CAST(with_admin_option != 0 AS Bool)       AS with_admin_option \
         FROM system.role_grants \
         ORDER BY grantee, role \
         LIMIT 5000",
    )
    .await?;

    Ok(AccessReport {
        available: true,
        reason: None,
        users,
        roles,
        grants,
        role_grants,
    })
}

/// A denied list is empty, not fatal.
async fn optional<T: serde::de::DeserializeOwned>(ch: &Client, sql: &str) -> Result<Vec<T>> {
    match ch.rows::<T>(sql).await {
        Ok(rows) => Ok(rows),
        Err(
            e @ (crate::error::Error::ClickHouse { code: 497, .. }
            | crate::error::Error::ClickHouse { code: 164, .. }),
        ) => {
            tracing::debug!("access list unavailable: {e}");
            Ok(Vec::new())
        }
        Err(e) => Err(e),
    }
}
