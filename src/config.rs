use clap::{Parser, ValueEnum};

/// What this deployment lets Flint do.
///
/// Flint is two products in one binary — Data works on rows, Infrastructure
/// works on structure and on the server — and the operator, not whoever is
/// signed in, decides which powers exist. Hence a notch in the manifest rather
/// than a switch in the UI: a permission a user can grant themselves is not a
/// permission.
///
/// The tiers are ordered, and every tier carries the ones below it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, ValueEnum)]
#[value(rename_all = "lower")]
pub enum Tier {
    /// Reads only. `readonly=2` on every statement.
    Read,
    /// Rows may be written: insert, import, truncate, mutate.
    Data,
    /// Structure may be written: create, alter, drop, indexes, partitions.
    Ddl,
    /// The server may be operated: `SYSTEM` commands, access, backups.
    Admin,
}

impl Tier {
    /// Lower-case, for the API and for a log line. Matches the flag spelling so
    /// what the UI receives is what somebody would have typed.
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Read => "read",
            Tier::Data => "data",
            Tier::Ddl => "ddl",
            Tier::Admin => "admin",
        }
    }
}

/// Runtime configuration. Every field is settable by flag or environment
/// variable so the container can be driven entirely by `docker run -e ...`.
#[derive(Debug, Clone, Parser)]
#[command(
    name = "flint",
    version,
    about = "Flint — the workspace ClickHouse doesn't ship with"
)]
pub struct Config {
    /// Address the HTTP server binds to
    #[arg(long, env = "FLINT_HOST", default_value = "0.0.0.0")]
    pub host: String,

    /// Port the HTTP server binds to
    #[arg(long, env = "FLINT_PORT", default_value_t = 8080)]
    pub port: u16,

    /// ClickHouse HTTP endpoint
    #[arg(
        long,
        env = "FLINT_CLICKHOUSE_URL",
        default_value = "http://localhost:8123"
    )]
    pub clickhouse_url: String,

    /// ClickHouse user
    #[arg(long, env = "FLINT_CLICKHOUSE_USER", default_value = "default")]
    pub clickhouse_user: String,

    /// ClickHouse password
    #[arg(
        long,
        env = "FLINT_CLICKHOUSE_PASSWORD",
        default_value = "",
        hide_env_values = true
    )]
    pub clickhouse_password: String,

    /// Database the SQL editor starts in
    #[arg(long, env = "FLINT_CLICKHOUSE_DATABASE", default_value = "default")]
    pub clickhouse_database: String,

    /// Refuse anything that is not a read (sends ClickHouse `readonly=2`).
    /// Recommended when pointing Flint at production.
    #[arg(long, env = "FLINT_READONLY", default_value_t = false)]
    pub readonly: bool,

    /// What this deployment may do: `read`, `data`, `ddl` or `admin`.
    ///
    /// Unset follows `--readonly`, which keeps every existing deployment
    /// behaving exactly as it did: read-only means `read`, otherwise `data`.
    /// The tiers above `data` are opt-in because they are the ones that reshape
    /// a schema or operate a server, and nobody should acquire those by
    /// upgrading.
    #[arg(long, env = "FLINT_TIER", value_enum)]
    pub tier: Option<Tier>,

    /// Whether the Infrastructure space exists in the UI at all.
    ///
    /// Data and Infrastructure are deliberately two spaces rather than one
    /// menu, and the point of a space is that it can be switched off whole: an
    /// analytics team turns this off and never learns the other half is there.
    /// Off means absent — no navigation entry, no route — rather than a
    /// disabled control explaining what you may not do.
    ///
    /// Separate from `--tier` on purpose. Everything the space shows today is a
    /// read of `system.*`, which changes nothing; hiding it is a decision about
    /// audience, not about permissions.
    #[arg(
        long,
        env = "FLINT_INFRASTRUCTURE",
        default_value_t = true,
        action = clap::ArgAction::Set
    )]
    pub infrastructure: bool,

    /// Hard cap on rows returned to the browser by a single query
    #[arg(long, env = "FLINT_MAX_RESULT_ROWS", default_value_t = 10_000)]
    pub max_result_rows: u64,

    /// Server-side query timeout, in seconds
    #[arg(long, env = "FLINT_QUERY_TIMEOUT_SECS", default_value_t = 120)]
    pub query_timeout_secs: u64,

    /// Database where Flint may keep its own metadata — saved queries, and
    /// later charts and dashboards. Unset means stateless: Flint creates
    /// nothing, and connecting it cannot modify the server.
    #[arg(long, env = "FLINT_WORKSPACE_DATABASE")]
    pub workspace_database: Option<String>,

    /// Whether alerts may POST to the webhook URLs people configure.
    ///
    /// On by default, because a webhook is what an alert is for. Turn it off
    /// where Flint is shared and an outbound POST carrying query results to an
    /// address any user can nominate is not acceptable: alerts still evaluate
    /// and still keep their event log, and each undelivered event records that
    /// delivery was disabled rather than pretending it was sent.
    #[arg(
        long,
        env = "FLINT_ALERT_WEBHOOKS",
        default_value_t = true,
        action = clap::ArgAction::Set
    )]
    pub alert_webhooks: bool,

    /// PEM bundle of additional certificate authorities to trust when
    /// ClickHouse is served over HTTPS with a private or self-signed CA.
    /// Flint already trusts the public web PKI without needing system certs.
    #[arg(long, env = "FLINT_CLICKHOUSE_CA_CERT")]
    pub clickhouse_ca_cert: Option<std::path::PathBuf>,

    /// Extra origin allowed to call the API. Only needed when running the
    /// Vite dev server on a different port.
    #[arg(long, env = "FLINT_CORS_ORIGIN")]
    pub cors_origin: Option<String>,

    /// Ask the running Flint on this port whether it is serving, print the
    /// answer and exit. This exists because the runtime image is distroless:
    /// there is no shell and no curl, so a container healthcheck has to be the
    /// binary itself.
    #[arg(long, hide_short_help = true)]
    pub health_check: bool,
}

impl Config {
    /// The tier this deployment actually runs at.
    ///
    /// `--readonly` is the older flag and still the one the ClickHouse client
    /// reads, so it decides the default rather than being overridden by one:
    /// a deployment that has only ever set `FLINT_READONLY` gets exactly the
    /// behaviour it had before the tier existed.
    pub fn tier(&self) -> Tier {
        self.tier.unwrap_or(if self.readonly {
            Tier::Read
        } else {
            Tier::Data
        })
    }

    /// Refuse a manifest that asks for two incompatible things.
    ///
    /// `FLINT_READONLY=true` with `FLINT_TIER=admin` is not a preference to be
    /// resolved quietly in one direction — it is somebody expecting powers that
    /// the other variable takes away. Failing at boot puts that in the log the
    /// first time, rather than in a support conversation about why a button is
    /// missing.
    pub fn check(&self) -> Result<(), String> {
        if let Some(asked) = self.tier {
            if self.readonly && asked > Tier::Read {
                return Err(format!(
                    "FLINT_TIER={} needs to write, and FLINT_READONLY=true refuses every write. \
                     Unset one of them.",
                    asked.as_str()
                ));
            }
        }
        Ok(())
    }

    pub fn bind_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    /// The endpoint without credentials, safe to show in the UI.
    pub fn redacted_endpoint(&self) -> String {
        self.clickhouse_url.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parsed once with no flags, then overridden field by field. The dev shell
    /// and CI both export a handful of `FLINT_*` variables, and a test that let
    /// those decide `readonly` would pass or fail depending on whose terminal it
    /// ran in.
    fn config(readonly: bool, tier: Option<Tier>) -> Config {
        let mut c = Config::parse_from(["flint"]);
        c.readonly = readonly;
        c.tier = tier;
        c
    }

    #[test]
    fn tier_follows_readonly_when_unset() {
        // The two deployments that existed before the tier did, unchanged.
        assert_eq!(config(false, None).tier(), Tier::Data);
        assert_eq!(config(true, None).tier(), Tier::Read);
    }

    #[test]
    fn explicit_tier_wins() {
        assert_eq!(config(false, Some(Tier::Admin)).tier(), Tier::Admin);
        assert_eq!(config(false, Some(Tier::Read)).tier(), Tier::Read);
    }

    #[test]
    fn tiers_are_ordered_so_a_tier_carries_the_ones_below_it() {
        assert!(Tier::Admin > Tier::Ddl);
        assert!(Tier::Ddl > Tier::Data);
        assert!(Tier::Data > Tier::Read);
    }

    #[test]
    fn readonly_with_a_writing_tier_is_refused() {
        let err = config(true, Some(Tier::Ddl))
            .check()
            .expect_err("a contradictory manifest must not boot");
        assert!(err.contains("FLINT_TIER=ddl"), "{err}");
        // Read-only *and* `read` is the same thing said twice, not a conflict.
        assert!(config(true, Some(Tier::Read)).check().is_ok());
        assert!(config(false, Some(Tier::Admin)).check().is_ok());
    }

    #[test]
    fn the_tier_names_are_the_flag_spellings() {
        // The API hands these straight to the browser, and the UI shows them
        // back in a message telling somebody which variable to change.
        assert_eq!(Tier::Read.as_str(), "read");
        assert_eq!(Tier::Ddl.as_str(), "ddl");
    }
}
