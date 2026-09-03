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
    /// Rows may be written: insert, import, mutate.
    Data,
    /// Structure may be written *where nothing is destroyed*: create, alter,
    /// rename, detach, freeze, optimize.
    Ddl,
    /// The server may be operated, and data may be destroyed: `SYSTEM` commands,
    /// access, backups, truncate, drop.
    ///
    /// The line between this and `Ddl` is data loss, and it is not the line this
    /// enum first drew — that one put `DROP TABLE` beside `CREATE` because both
    /// are structure. It did not survive the work: a deployment that wants people
    /// reshaping schemas without being able to delete anything is a real
    /// deployment, and the first line could not express it.
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

    /// ClickHouse HTTP endpoint.
    ///
    /// Unset means **unpinned**: Flint boots with no server of its own and the
    /// browser names one at sign-in. That is a real mode, not a degraded one —
    /// `docker run flint` with no environment at all opens on a form asking
    /// where to connect — but it is a narrower Flint, and the narrowing is
    /// structural rather than a policy: everything Flint does on a schedule
    /// (alerts, reports, jobs) runs with nobody's browser open, so it cannot
    /// borrow a target from a session. Hence [`Config::check`] refuses a
    /// workspace here, and an unpinned Flint is stateless by construction.
    ///
    /// It also implies signing in, because the session is the only thing that
    /// can carry a target. See `src/main.rs`, which sets that rather than
    /// asking for it twice.
    #[arg(long, env = "FLINT_CLICKHOUSE_URL")]
    pub clickhouse_url: Option<String>,

    /// Servers a browser may point an unpinned Flint at. Empty means any.
    ///
    /// `host`, `host:port` or `scheme://host:port`, comma-separated. What is
    /// absent does not constrain: `clickhouse` permits that host on any port
    /// over either scheme, and anything narrower is written out. See
    /// `src/target.rs` for the matching, and for what vetting a host as
    /// *written* cannot promise.
    ///
    /// Empty is the default because requiring this would take away the mode's
    /// whole point — an unpinned Flint that needs a variable set is a pinned
    /// one with extra steps. The boot log says the fence is down, and an
    /// unpinned Flint that anyone can reach should set this.
    ///
    /// Ignored while Flint is pinned, where nobody but the manifest has a say.
    #[arg(long, env = "FLINT_TARGETS", value_delimiter = ',')]
    pub targets: Vec<String>,

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

    /// Require everyone to sign in with their own ClickHouse credentials.
    ///
    /// Off by default, because Flint has always run as the account in the
    /// manifest and turning this on for an existing deployment would lock out
    /// everybody who has no ClickHouse user of their own.
    ///
    /// On, the credentials above are used only for Flint's own work — the
    /// workspace, the alert scheduler, the health probe — and every statement a
    /// person causes runs as that person. Which means ClickHouse's own grants
    /// decide what they may see, and `system.query_log` records who did it. See
    /// `src/auth.rs`.
    /// Read through [`Config::sign_in_required`] rather than directly: an
    /// unpinned Flint requires signing in whatever this says, and a site that
    /// reads the raw flag is a site that gets that wrong.
    #[arg(
        long,
        env = "FLINT_AUTH",
        default_value_t = false,
        action = clap::ArgAction::Set
    )]
    pub auth: bool,

    /// How many hours an unused session survives before it has to sign in
    /// again. Only meaningful with `--auth`.
    ///
    /// Idle rather than absolute: signing somebody out in the middle of a day's
    /// work teaches them to keep a second tab open, which defeats the point.
    #[arg(long, env = "FLINT_SESSION_IDLE_HOURS", default_value_t = 12)]
    pub session_idle_hours: u64,

    /// Roles a published endpoint may be made to run as. Empty means none, and
    /// none is the default: delegation is a thing somebody turns on.
    ///
    /// In the manifest and never in the UI, for the reason the tier is: a
    /// permission a user can grant themselves is not a permission. Naming a
    /// role here is a statement that whoever can publish may hand out that
    /// role's reach to anyone holding a token.
    ///
    /// It is an allow-list rather than "any role the account holds", because
    /// the account almost certainly holds one that is not meant to be handed
    /// out — and the failure would be silent.
    #[arg(long, env = "FLINT_DELEGATABLE_ROLES", value_delimiter = ',')]
    pub delegatable_roles: Vec<String>,

    /// The disk Flint may write backups to, and read them from.
    ///
    /// Unset means Flint takes no backups, which is the default: `BACKUP … TO
    /// Disk(…)` is refused by ClickHouse itself unless the server's own
    /// `backups.allowed_disk` sanctions the destination, and Flint has no way to
    /// read that setting. So the name is given here rather than guessed — and
    /// where it is wrong, the server says so and the job records what it said.
    ///
    /// A backup on the same machine as the data is not a backup. That is not
    /// Flint's decision to make, but it is worth saying once: this names a disk,
    /// and whether that disk is somewhere else is the operator's problem.
    #[arg(long, env = "FLINT_BACKUP_DISK")]
    pub backup_disk: Option<String>,

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

    /// A server of Flint's own to keep the workspace on, instead of the one
    /// being explored.
    ///
    /// Unset, the workspace lives on the server in the manifest, which is how
    /// this has always worked and stays the default. Set, Flint holds a second
    /// connection: reads about your data go to the explored server, and Flint's
    /// own bookkeeping goes here. That buys two things worth having.
    ///
    /// It takes Flint's tables off the server it is exploring. A read-only
    /// deployment could always write its own workspace — `allow_write` is
    /// exempt from `FLINT_READONLY` on purpose — but the tables still landed in
    /// somebody's production. Pointed elsewhere, connecting Flint to a server
    /// now genuinely creates nothing on it.
    ///
    /// And it gives an unpinned Flint a memory. Unpinned the browser names the
    /// server at sign-in, so there was no server to keep a workspace on and the
    /// mode was stateless by construction. A workspace with its own address is
    /// not borrowed from a session: it is there before anybody signs in, which
    /// is what the alert scheduler and the report sweep need in order to exist.
    #[arg(long, env = "FLINT_WORKSPACE_URL")]
    pub workspace_url: Option<String>,

    /// The account Flint uses on its own workspace server.
    ///
    /// Deliberately not inherited from `FLINT_CLICKHOUSE_USER`. A workspace
    /// with its own address is a different server, and carrying the explored
    /// server's credentials to it is a guess that fails as an authentication
    /// error somebody then has to trace back to a default they never set. The
    /// default here is ClickHouse's own, which is what a local server started
    /// for the purpose answers to. Ignored unless `FLINT_WORKSPACE_URL` is set.
    #[arg(long, env = "FLINT_WORKSPACE_USER", default_value = "default")]
    pub workspace_user: String,

    /// The password for [`Config::workspace_user`]. Ignored unless
    /// `FLINT_WORKSPACE_URL` is set.
    #[arg(
        long,
        env = "FLINT_WORKSPACE_PASSWORD",
        default_value = "",
        hide_env_values = true
    )]
    pub workspace_password: String,

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

    /// A subcommand, where one was asked for.
    ///
    /// `None` is Flint as it has always been — every flag above, and a server.
    /// A subcommand does not replace that boot, it *arranges* it: `k8s` opens a
    /// tunnel and then fills in the same fields somebody would otherwise have
    /// typed, so there is one startup path rather than two.
    #[command(subcommand)]
    pub cmd: Option<Cmd>,
}

/// The ways of starting Flint that are more than a set of flags.
#[derive(Debug, Clone, clap::Subcommand)]
pub enum Cmd {
    /// Reach a ClickHouse that only Kubernetes can route to.
    K8s(crate::k8s::K8s),
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
    /// A variable set to nothing is a variable that is not set.
    ///
    /// `FLINT_WORKSPACE_DATABASE=` in a `.env` or a compose file is how somebody
    /// writes "no workspace" with the line still in the file — commenting it out
    /// and blanking it are the same intent — but it reaches clap as `Some("")`.
    /// Flint then believed it had a workspace called nothing: `ensure` sent
    /// `CREATE DATABASE ``` and the server answered *failed at position 31,
    /// expected identifier*, once at boot and then every time the alert
    /// scheduler and the report sweep ticked. Meanwhile `/api/config` reported a
    /// workspace, so the UI offered all five of the sections that need one and
    /// each opened on a syntax error — precisely the "present and failing"
    /// state the whole stateless mode exists to avoid.
    ///
    /// [`Config::endpoint`] already fixed this for the server URL, and its
    /// reasoning is the same; the difference is that this runs once over every
    /// optional string, so the six places that read `workspace_database`
    /// directly cannot each get it wrong. The other two are the same bargain:
    /// `FLINT_BACKUP_DISK=` would put `Disk('')` in a `BACKUP` statement, and
    /// `FLINT_CORS_ORIGIN=` an empty `Access-Control-Allow-Origin`.
    ///
    /// Whitespace goes with it. A value indented into a YAML block arrives with
    /// it attached, and a database called `" flint"` is not one.
    pub fn normalise(&mut self) {
        fn some_if_named(value: &mut Option<String>) {
            let named = value
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned);
            *value = named;
        }
        some_if_named(&mut self.clickhouse_url);
        some_if_named(&mut self.workspace_database);
        some_if_named(&mut self.workspace_url);
        some_if_named(&mut self.backup_disk);
        some_if_named(&mut self.cors_origin);
    }

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
        // A workspace is a database on *one* server, written by Flint's own
        // account, on a schedule that runs whether or not anybody is signed in.
        // What it needs is that server — not, as this once insisted, that the
        // server be the one being explored. `FLINT_WORKSPACE_URL` names one of
        // Flint's own, and an unpinned Flint with one is no longer a
        // contradiction: nothing about a workspace on a known address is
        // borrowed from a session.
        //
        // Unpinned with neither is still refused, and for the original reason.
        // There is no server and no account, so this is not a setting that
        // degrades — it is a setting that cannot mean anything, and saying so
        // at boot beats a scheduler that fails every minute into a log nobody
        // reads.
        if self.workspace_database.is_some() && self.workspace_endpoint().is_none() {
            return Err(
                "FLINT_WORKSPACE_DATABASE names a database on a server, and this Flint has no \
                 server of its own — unpinned, the browser names one at sign-in, which is too \
                 late for a schedule. Set FLINT_WORKSPACE_URL to give the workspace a server of \
                 its own, or FLINT_CLICKHOUSE_URL to pin the explored one, or unset the \
                 workspace: with none of the three, Flint is stateless."
                    .into(),
            );
        }
        // A server for a workspace that was never asked for is a connection
        // Flint would open and never use. Cheap to get wrong — the two
        // variables read alike — and silent, because the symptom is a Publish
        // page that is still missing.
        if self.workspace_url.is_some() && self.workspace_database.is_none() {
            return Err(
                "FLINT_WORKSPACE_URL names a server for a workspace, and FLINT_WORKSPACE_DATABASE \
                 does not say which database on it. Set it, or unset the URL."
                    .into(),
            );
        }
        Ok(())
    }

    pub fn bind_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    /// Whether the manifest names the server, rather than the browser naming it.
    ///
    /// Phrased as a question about the manifest on purpose. It is the same
    /// question as "is there a server to connect to at boot", "is there a
    /// service account", and "can anything run on a schedule" — and reading it
    /// off one field keeps those three from drifting apart.
    pub fn pinned(&self) -> bool {
        self.endpoint().is_some()
    }

    /// The server in the manifest, or `None` where it names none.
    ///
    /// Blank counts as absent, and that is the whole reason this is a method.
    /// `FLINT_CLICKHOUSE_URL=` in a `.env` or a compose file is how somebody
    /// says "no server" with the variable still written down — it reaches clap
    /// as `Some("")`, and an empty string treated as an address is a Flint that
    /// believes it is pinned to nowhere: every read fails on a URL that is not
    /// one, and nobody can sign in to fix it.
    pub fn endpoint(&self) -> Option<&str> {
        self.clickhouse_url
            .as_deref()
            .map(str::trim)
            .filter(|url| !url.is_empty())
    }

    /// Where the workspace lives, or `None` where it can live nowhere.
    ///
    /// Its own server wins over the explored one, and falls back to it, so a
    /// manifest that never heard of `FLINT_WORKSPACE_URL` behaves exactly as it
    /// did. The fallback is what makes this one method rather than a condition
    /// repeated at each of the places that need to know.
    pub fn workspace_endpoint(&self) -> Option<&str> {
        self.workspace_url.as_deref().or_else(|| self.endpoint())
    }

    /// Whether the workspace is on a server of its own rather than the explored
    /// one. Decides whether Flint opens a second connection at boot, and
    /// whether a failure to reach it should name which server it means.
    pub fn workspace_is_separate(&self) -> bool {
        self.workspace_url.is_some()
    }

    /// Whether everyone must sign in with their own ClickHouse credentials.
    ///
    /// `--auth`, or unpinned. The second is a consequence rather than a policy:
    /// the endpoint arrives with a session, so a Flint whose manifest names no
    /// server has nothing to connect as until somebody signs in — and an open
    /// UI that can reach nothing is worse than a form.
    ///
    /// A method rather than a value settled at boot, so that the invariant holds
    /// for an `AppState` built anywhere — including in a test, which is where a
    /// gate gets quietly built without one.
    pub fn sign_in_required(&self) -> bool {
        self.auth || !self.pinned()
    }

    /// The endpoint as the UI is told it. `None` unpinned: there is no endpoint
    /// until somebody names one, and the answer is that rather than an empty
    /// string dressed up as an address.
    pub fn redacted_endpoint(&self) -> Option<&str> {
        self.endpoint()
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
    fn an_unpinned_flint_requires_signing_in_whatever_the_flag_says() {
        // Not a default that can be overridden: there is nothing else to
        // connect as, so `FLINT_AUTH=false` cannot mean "let everyone in".
        let mut c = config(false, None);
        c.clickhouse_url = None;
        c.auth = false;
        assert!(c.sign_in_required());

        // Pinned, the flag is the whole answer — which is every deployment
        // that existed before unpinned mode did.
        c.clickhouse_url = Some("http://ch:8123".into());
        assert!(!c.sign_in_required());
        c.auth = true;
        assert!(c.sign_in_required());
    }

    #[test]
    fn an_unset_endpoint_is_unpinned_and_shows_no_address() {
        let mut c = config(false, None);
        c.clickhouse_url = None;
        assert!(!c.pinned());
        // Dropped, not blanked: the UI is told there is no endpoint rather than
        // handed an empty string to render as one.
        assert_eq!(c.redacted_endpoint(), None);

        c.clickhouse_url = Some("http://ch:8123".into());
        assert!(c.pinned());
        assert_eq!(c.redacted_endpoint(), Some("http://ch:8123"));
    }

    #[test]
    fn a_blank_endpoint_is_no_endpoint() {
        // `FLINT_CLICKHOUSE_URL=` is how a compose file says "unpinned" without
        // deleting the line. Read as an address it would pin Flint to nowhere:
        // every request fails and nobody can sign in to correct it.
        let mut c = config(false, None);
        for blank in ["", "   ", "\t"] {
            c.clickhouse_url = Some(blank.into());
            assert!(!c.pinned(), "{blank:?} was taken for an address");
            assert_eq!(c.redacted_endpoint(), None, "{blank:?}");
            assert!(c.sign_in_required(), "{blank:?}");
        }
        // And the surrounding whitespace of a real one is not part of it.
        c.clickhouse_url = Some("  http://ch:8123 ".into());
        assert_eq!(c.redacted_endpoint(), Some("http://ch:8123"));
    }

    #[test]
    fn a_variable_set_to_nothing_is_a_variable_that_is_not_set() {
        // How somebody writes "no workspace" with the line still in the file.
        // Left as `Some("")`, Flint believed it had a workspace called nothing:
        // `CREATE DATABASE ``` at boot, the same syntax error on every alert and
        // report tick, and a `/api/config` that told the UI to offer five
        // sections which all opened on it.
        let mut c = config(false, None);
        c.clickhouse_url = Some("http://ch:8123".into());
        c.workspace_database = Some(String::new());
        c.backup_disk = Some("   ".into());
        c.cors_origin = Some(String::new());
        c.normalise();
        assert_eq!(c.workspace_database, None);
        assert_eq!(c.backup_disk, None);
        assert_eq!(c.cors_origin, None);
        // And stateless is then the supported pair rather than a boot failure.
        assert!(c.check().is_ok());

        // A named one survives, with the whitespace a YAML block attaches to it
        // taken off: a database called `" flint"` is not one.
        c.workspace_database = Some("  flint\n".into());
        c.normalise();
        assert_eq!(c.workspace_database.as_deref(), Some("flint"));
    }

    #[test]
    fn a_workspace_needs_a_server_somewhere() {
        let mut c = config(false, None);
        c.clickhouse_url = None;
        c.workspace_database = Some("flint".into());
        let err = c
            .check()
            .expect_err("a workspace with no server at all must not boot");
        assert!(err.contains("FLINT_WORKSPACE_DATABASE"), "{err}");
        // Both ways out are named, because with two variables that could
        // supply the server, an error naming one of them sends half the
        // readers to the wrong fix.
        assert!(err.contains("FLINT_WORKSPACE_URL"), "{err}");
        assert!(err.contains("FLINT_CLICKHOUSE_URL"), "{err}");

        // Unpinned and stateless is the supported pair, and pinned with a
        // workspace is the one that always worked.
        c.workspace_database = None;
        assert!(c.check().is_ok());
        c.clickhouse_url = Some("http://ch:8123".into());
        c.workspace_database = Some("flint".into());
        assert!(c.check().is_ok());
    }

    #[test]
    fn a_workspace_on_its_own_server_needs_no_pin() {
        // The whole point of FLINT_WORKSPACE_URL. Unpinned used to imply
        // stateless because there was no server to keep the tables on; naming
        // one removes the reason, so the refusal has to go with it.
        let mut c = config(false, None);
        c.clickhouse_url = None;
        c.workspace_database = Some("flint".into());
        c.workspace_url = Some("http://127.0.0.1:9000".into());
        assert!(c.check().is_ok(), "{:?}", c.check());
        assert_eq!(c.workspace_endpoint(), Some("http://127.0.0.1:9000"));
        assert!(c.workspace_is_separate());
        // Still unpinned: the workspace having an address says nothing about
        // the server being explored, and `main` gates the scheduler on this.
        assert!(!c.pinned());
    }

    #[test]
    fn the_workspace_server_wins_over_the_explored_one_and_falls_back_to_it() {
        let mut c = config(false, None);
        c.clickhouse_url = Some("http://ch:8123".into());
        c.workspace_database = Some("flint".into());

        // No address of its own: Flint's tables go where they always went.
        assert_eq!(c.workspace_endpoint(), Some("http://ch:8123"));
        assert!(!c.workspace_is_separate());

        c.workspace_url = Some("http://127.0.0.1:9000".into());
        assert_eq!(c.workspace_endpoint(), Some("http://127.0.0.1:9000"));
        assert!(c.workspace_is_separate());
    }

    #[test]
    fn a_workspace_server_with_no_database_is_refused() {
        // The two variables read alike and the symptom of confusing them is
        // silent: a second connection opened at boot, and a Publish page still
        // missing with nothing in the log about why.
        let mut c = config(false, None);
        c.clickhouse_url = Some("http://ch:8123".into());
        c.workspace_url = Some("http://127.0.0.1:9000".into());
        c.workspace_database = None;
        let err = c
            .check()
            .expect_err("a workspace server with nothing to put on it must not boot");
        assert!(err.contains("FLINT_WORKSPACE_DATABASE"), "{err}");
    }

    #[test]
    fn a_blank_workspace_url_is_no_workspace_url() {
        // `FLINT_WORKSPACE_URL=` is how a compose file says "on the explored
        // server" without deleting the line. Read as an address it would point
        // the second connection at nowhere, and every save would fail on a URL
        // that is not one — while `check` passed, because the string is there.
        let mut c = config(false, None);
        c.clickhouse_url = Some("http://ch:8123".into());
        c.workspace_database = Some("flint".into());
        for blank in ["", "   ", "\t"] {
            c.workspace_url = Some(blank.into());
            c.normalise();
            assert!(
                !c.workspace_is_separate(),
                "{blank:?} was taken for an address"
            );
            assert_eq!(c.workspace_endpoint(), Some("http://ch:8123"));
            assert!(c.check().is_ok());
        }
    }

    #[test]
    fn the_tier_names_are_the_flag_spellings() {
        // The API hands these straight to the browser, and the UI shows them
        // back in a message telling somebody which variable to change.
        assert_eq!(Tier::Read.as_str(), "read");
        assert_eq!(Tier::Ddl.as_str(), "ddl");
    }
}
