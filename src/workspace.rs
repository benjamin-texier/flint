//! Flint's own storage, in ClickHouse.
//!
//! The brief's architectural commitment: when Flint needs to remember
//! something, it remembers it in ClickHouse rather than dragging in Postgres.
//! That is opt-in — without `FLINT_WORKSPACE_DATABASE` Flint creates nothing
//! and connecting it cannot modify the server, which is the whole point of the
//! read-only mode.
//!
//! ClickHouse is not an OLTP store and has no UPDATE, so the table is a log of
//! versions over a `ReplacingMergeTree`, and a delete is a tombstone. Reads
//! collapse the log with `argMax` rather than `FINAL`: it costs no more, and it
//! lets `created_at` survive as the minimum across versions where `FINAL` would
//! overwrite it with the latest row's value.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::clickhouse::{Client, QueryOptions};
use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    pub sql: String,
    /// The database the query was written against, so loading it restores the
    /// context it needs.
    pub database: String,
    /// Read from a SQL alias that deliberately differs from the column name.
    /// Aliasing `min(created_at)` as `created_at` shadows the column inside the
    /// same SELECT, and any later mention of it — an ORDER BY, a HAVING —
    /// resolves to the alias instead, which here nested one aggregate inside
    /// another. Third time this pattern has bitten this codebase; the rule is
    /// simply never to reuse a column's name for an expression over it.
    #[serde(alias = "created")]
    pub created_at: String,
    #[serde(alias = "updated")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveInput {
    /// Absent for a new query; present to supersede an existing one.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub database: String,
}

/// A dashboard, stored as a name and a JSON spec.
///
/// The spec is opaque to ClickHouse on purpose. A dashboard's shape — how many
/// tiles, how they are laid out, what each one charts — is exactly the thing
/// most likely to change, and nothing queries *inside* it: it is always read
/// whole and rendered. Keeping it as one String means the layout can grow
/// without a migration, and the cost is a filter Flint does not need.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dashboard {
    pub id: String,
    pub name: String,
    /// JSON, validated as JSON before it is stored so a dashboard cannot be
    /// saved in a state that will not load.
    pub spec: String,
    #[serde(alias = "created")]
    pub created_at: String,
    #[serde(alias = "updated")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DashboardInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub spec: String,
}

/// A question asked on a schedule.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Alert {
    pub id: String,
    pub name: String,
    pub sql: String,
    pub database: String,
    /// JSON, validated before it is stored: an alert whose condition cannot be
    /// read is an alert that never fires while claiming to be on.
    pub condition: String,
    pub interval_seconds: u32,
    /// Empty when there is nowhere to send it — the events list is still kept,
    /// which is a perfectly good place for an alert to live.
    pub webhook: String,
    pub enabled: bool,
    #[serde(alias = "created")]
    pub created_at: String,
    #[serde(alias = "updated")]
    pub updated_at: String,
    /// Where the alert stands, from its own event log rather than from memory,
    /// so the list says the same thing after a restart.
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub last_event: String,
    #[serde(default)]
    pub last_message: String,
    /// Whether the last notification actually reached anywhere. "We tried and
    /// could not" is the thing an alerting tool must never round to "we told
    /// you", so it travels with the alert rather than only in the log.
    #[serde(default)]
    pub last_delivered: bool,
    #[serde(default)]
    pub last_delivery_error: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AlertInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub database: String,
    pub condition: String,
    pub interval_seconds: u32,
    #[serde(default)]
    pub webhook: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

/// A published statement, served at a stable URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Published {
    pub id: String,
    pub name: String,
    /// The address. Narrow by design — it lands in URLs and in scripts.
    pub slug: String,
    pub sql: String,
    pub database: String,
    /// JSON object of parameter defaults, `{"days": "7"}`.
    pub defaults: String,
    /// Empty for a public endpoint. Present means the caller must send it.
    pub token: String,
    pub public: bool,
    pub enabled: bool,
    pub max_rows: u32,
    #[serde(alias = "created")]
    pub created_at: String,
    #[serde(alias = "updated")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PublishedInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub slug: String,
    pub sql: String,
    #[serde(default)]
    pub database: String,
    #[serde(default = "empty_object")]
    pub defaults: String,
    /// Absent keeps the existing token, or mints one for a new endpoint.
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub public: bool,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default = "thousand")]
    pub max_rows: u32,
}

fn empty_object() -> String {
    "{}".to_string()
}

fn thousand() -> u32 {
    1000
}

/// A report: sections, a schedule, and where to say it ran.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    pub id: String,
    pub name: String,
    /// JSON, validated before storing.
    pub spec: String,
    pub schedule: String,
    pub webhook: String,
    pub enabled: bool,
    #[serde(alias = "created")]
    pub created_at: String,
    #[serde(alias = "updated")]
    pub updated_at: String,
    #[serde(default)]
    pub last_run: String,
    #[serde(default)]
    pub last_status: String,
    #[serde(default)]
    pub runs: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReportInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub spec: String,
    pub schedule: String,
    #[serde(default)]
    pub webhook: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

/// One run of a report, without its contents — the list of runs has to stay
/// cheap to read, and a snapshot can be megabytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportRun {
    #[serde(alias = "run")]
    pub run_id: String,
    #[serde(alias = "which")]
    pub report_id: String,
    pub report: String,
    #[serde(alias = "happened")]
    pub at: String,
    pub status: String,
    pub error: String,
    pub delivered: bool,
    pub delivery_error: String,
    pub sections: u64,
}

/// One run of a report *with* its contents.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportSnapshot {
    #[serde(alias = "run")]
    pub run_id: String,
    #[serde(alias = "which")]
    pub report_id: String,
    pub report: String,
    #[serde(alias = "happened")]
    pub at: String,
    pub status: String,
    pub error: String,
    /// JSON array of `reports::SectionResult`.
    pub sections: String,
}

/// One thing that happened to an alert. Append-only: this is a log, and a log
/// that can be edited is not evidence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertEvent {
    #[serde(alias = "which")]
    pub alert_id: String,
    pub alert: String,
    /// Read from an alias that differs from the column, so `ORDER BY at` still
    /// sorts the timestamp rather than its text.
    #[serde(alias = "happened")]
    pub at: String,
    pub state: String,
    /// Absent where there was nothing to measure — an alert that failed to run
    /// has no value, and zero is not the same as no answer.
    pub value: Option<f64>,
    pub message: String,
    pub delivered: bool,
    pub delivery_error: String,
}

#[derive(Clone)]
pub struct Workspace {
    database: String,
    /// Whether the schema has been created in this process. Bootstrapping is
    /// idempotent, so this is only an optimisation — but it also means a
    /// ClickHouse that was not up at startup gets another chance on first use.
    ready: Arc<RwLock<bool>>,
}

impl Workspace {
    pub fn new(database: String) -> Self {
        Self {
            database,
            ready: Arc::new(RwLock::new(false)),
        }
    }

    /// Backtick-quoted, because a workspace database may legitimately be called
    /// something that needs it.
    fn quoted(&self) -> String {
        format!(
            "`{}`",
            self.database.replace('\\', "\\\\").replace('`', "\\`")
        )
    }

    /// Writes to Flint's own tables carry `allow_write`, so read-only mode does
    /// not block them. `FLINT_READONLY` is a promise about *your* data — it says
    /// Flint will not change the tables it is exploring. It was never a promise
    /// that Flint would not remember a query you asked it to save, and a
    /// read-only deployment with a workspace would otherwise be inert.
    fn write_opts(&self) -> QueryOptions {
        QueryOptions {
            allow_write: true,
            quote_64bit_integers: false,
            introspection: true,
            ..Default::default()
        }
    }

    /// Create the database and table if they are not there. Safe to call on
    /// every request; the first success latches.
    pub async fn ensure(&self, ch: &Client) -> Result<()> {
        if *self.ready.read().await {
            return Ok(());
        }
        let db = self.quoted();

        ch.execute(
            &format!("CREATE DATABASE IF NOT EXISTS {db}"),
            self.write_opts(),
        )
        .await
        .map_err(|e| self.explain(e))?;

        ch.execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS {db}.saved_queries \
                 ( \
                    id         UUID, \
                    name       String, \
                    sql        String, \
                    database   String, \
                    created_at DateTime64(3), \
                    updated_at DateTime64(3), \
                    deleted    UInt8, \
                    version    UInt64 \
                 ) \
                 ENGINE = ReplacingMergeTree(version) \
                 ORDER BY id"
            ),
            self.write_opts(),
        )
        .await
        .map_err(|e| self.explain(e))?;

        ch.execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS {db}.dashboards \
                 ( \
                    id         UUID, \
                    name       String, \
                    spec       String, \
                    created_at DateTime64(3), \
                    updated_at DateTime64(3), \
                    deleted    UInt8, \
                    version    UInt64 \
                 ) \
                 ENGINE = ReplacingMergeTree(version) \
                 ORDER BY id"
            ),
            self.write_opts(),
        )
        .await
        .map_err(|e| self.explain(e))?;

        ch.execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS {db}.alerts \
                 ( \
                    id               UUID, \
                    name             String, \
                    sql              String, \
                    database         String, \
                    condition        String, \
                    interval_seconds UInt32, \
                    webhook          String, \
                    enabled          UInt8, \
                    created_at       DateTime64(3), \
                    updated_at       DateTime64(3), \
                    deleted          UInt8, \
                    version          UInt64 \
                 ) \
                 ENGINE = ReplacingMergeTree(version) \
                 ORDER BY id"
            ),
            self.write_opts(),
        )
        .await
        .map_err(|e| self.explain(e))?;

        // A log, not a document: no ReplacingMergeTree and no tombstone,
        // because an alert's history is evidence and evidence is not edited.
        // `value` is Nullable so "failed to run" keeps no measurement rather
        // than a zero that reads like one.
        ch.execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS {db}.alert_events \
                 ( \
                    alert_id       UUID, \
                    alert          String, \
                    at             DateTime64(3), \
                    state          LowCardinality(String), \
                    value          Nullable(Float64), \
                    message        String, \
                    delivered      UInt8, \
                    delivery_error String \
                 ) \
                 ENGINE = MergeTree \
                 PARTITION BY toYYYYMM(at) \
                 ORDER BY (alert_id, at) \
                 TTL toDateTime(at) + INTERVAL 90 DAY"
            ),
            self.write_opts(),
        )
        .await
        .map_err(|e| self.explain(e))?;

        ch.execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS {db}.reports \
                 ( \
                    id         UUID, \
                    name       String, \
                    spec       String, \
                    schedule   String, \
                    webhook    String, \
                    enabled    UInt8, \
                    created_at DateTime64(3), \
                    updated_at DateTime64(3), \
                    deleted    UInt8, \
                    version    UInt64 \
                 ) \
                 ENGINE = ReplacingMergeTree(version) \
                 ORDER BY id"
            ),
            self.write_opts(),
        )
        .await
        .map_err(|e| self.explain(e))?;

        // The point of a report: what the numbers *were*. So this is a log like
        // the alert events, but it keeps the contents, and it keeps them longer
        // — six months, because "what did this look like last quarter" is the
        // question the table exists to answer.
        ch.execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS {db}.report_runs \
                 ( \
                    run_id         UUID, \
                    report_id      UUID, \
                    report         String, \
                    at             DateTime64(3), \
                    status         LowCardinality(String), \
                    sections       String CODEC(ZSTD(3)), \
                    section_count  UInt32, \
                    error          String, \
                    delivered      UInt8, \
                    delivery_error String \
                 ) \
                 ENGINE = MergeTree \
                 PARTITION BY toYYYYMM(at) \
                 ORDER BY (report_id, at) \
                 TTL toDateTime(at) + INTERVAL 180 DAY"
            ),
            self.write_opts(),
        )
        .await
        .map_err(|e| self.explain(e))?;

        ch.execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS {db}.published \
                 ( \
                    id         UUID, \
                    name       String, \
                    slug       String, \
                    sql        String, \
                    database   String, \
                    defaults   String, \
                    token      String, \
                    public     UInt8, \
                    enabled    UInt8, \
                    max_rows   UInt32, \
                    created_at DateTime64(3), \
                    updated_at DateTime64(3), \
                    deleted    UInt8, \
                    version    UInt64 \
                 ) \
                 ENGINE = ReplacingMergeTree(version) \
                 ORDER BY id"
            ),
            self.write_opts(),
        )
        .await
        .map_err(|e| self.explain(e))?;

        *self.ready.write().await = true;
        tracing::info!("workspace ready in `{}`", self.database);
        Ok(())
    }

    /// Turn a permissions failure into the sentence an operator needs.
    /// Free text on its way into a query parameter.
    ///
    /// A newline stops ClickHouse's parameter parser dead — it answers "cannot
    /// be parsed as String … isn't parsed completely" and quotes the first line
    /// back at you — and every piece of text this workspace keeps is multi-line
    /// by construction: a saved statement, a pretty-printed spec. Hex holds no
    /// newline, so the value crosses as one token and `unhex` puts it back byte
    /// for byte on the server.
    fn text(value: &str) -> String {
        value.bytes().map(|b| format!("{b:02x}")).collect()
    }

    fn explain(&self, e: Error) -> Error {
        match &e {
            Error::ClickHouse { code, .. } if *code == 497 || *code == 164 || *code == 81 => {
                Error::ClickHouse {
                    code: *code,
                    message: format!(
                        "Flint cannot set up its workspace in `{}`. That user needs CREATE \
                         DATABASE, CREATE TABLE, INSERT and SELECT on it — or unset \
                         FLINT_WORKSPACE_DATABASE to run without persistence.",
                        self.database
                    ),
                }
            }
            _ => e,
        }
    }

    pub async fn list(&self, ch: &Client) -> Result<Vec<SavedQuery>> {
        self.ensure(ch).await?;
        // Collapsed with argMax rather than FINAL so `created_at` can be the
        // minimum across versions: the moment the query was first saved, not the
        // moment it was last edited.
        let sql = format!(
            "SELECT toString(id)                       AS id, \
                    argMax(name, version)               AS name, \
                    argMax(sql, version)                AS sql, \
                    argMax(database, version)           AS database, \
                    toString(min(created_at))           AS created, \
                    toString(max(updated_at))           AS updated \
             FROM {}.saved_queries \
             GROUP BY id \
             HAVING argMax(deleted, version) = 0 \
             ORDER BY max(updated_at) DESC \
             LIMIT 500",
            self.quoted()
        );
        ch.rows(&sql).await
    }

    pub async fn save(&self, ch: &Client, input: SaveInput) -> Result<SavedQuery> {
        self.ensure(ch).await?;
        let name = input.name.trim();
        if name.is_empty() {
            return Err(Error::BadRequest("a saved query needs a name".into()));
        }
        if input.sql.trim().is_empty() {
            return Err(Error::BadRequest("there is nothing to save".into()));
        }

        if let Some(id) = &input.id {
            if !crate::routes::is_uuid(id) {
                return Err(Error::BadRequest(format!("`{id}` is not a saved-query id")));
            }
        }

        // The id is minted by ClickHouse for a new query and echoed back for an
        // edit, so a client cannot smuggle anything but a UUID into it.
        let id_expr = match &input.id {
            Some(_) => "{id:UUID}",
            None => "generateUUIDv4()",
        };
        let mut params = vec![
            ("name".to_string(), name.to_string()),
            ("sql".to_string(), Self::text(&input.sql)),
            ("db".to_string(), input.database.clone()),
        ];
        if let Some(id) = &input.id {
            params.push(("id".to_string(), id.clone()));
        }

        // `version` is the insert time in milliseconds: monotonic enough to
        // order edits, and it needs no counter to keep.
        let sql = format!(
            "INSERT INTO {}.saved_queries \
             SELECT {id_expr}, {{name:String}}, unhex({{sql:String}}), {{db:String}}, \
                    now64(3), now64(3), 0, toUnixTimestamp64Milli(now64(3))",
            self.quoted()
        );
        ch.execute(
            &sql,
            QueryOptions {
                params: params.clone(),
                ..self.write_opts()
            },
        )
        .await?;

        // Read it back rather than reconstruct it: the timestamps and, for a new
        // query, the id are the server's to decide.
        let saved = self
            .list(ch)
            .await?
            .into_iter()
            .find(|q| match &input.id {
                Some(id) => q.id.eq_ignore_ascii_case(id),
                None => q.name == name && q.sql == input.sql,
            })
            .ok_or_else(|| Error::Decode("the saved query did not come back".into()))?;
        Ok(saved)
    }

    // ── Dashboards ─────────────────────────────────────────────────────────
    // Same shape as saved queries: a version log, a tombstone for a delete, and
    // an argMax read so `created_at` is the first save rather than the last.

    pub async fn dashboards(&self, ch: &Client) -> Result<Vec<Dashboard>> {
        self.ensure(ch).await?;
        let sql = format!(
            "SELECT toString(id)               AS id, \
                    argMax(name, version)       AS name, \
                    argMax(spec, version)       AS spec, \
                    toString(min(created_at))   AS created, \
                    toString(max(updated_at))   AS updated \
             FROM {}.dashboards \
             GROUP BY id \
             HAVING argMax(deleted, version) = 0 \
             ORDER BY max(updated_at) DESC \
             LIMIT 200",
            self.quoted()
        );
        ch.rows(&sql).await
    }

    pub async fn save_dashboard(&self, ch: &Client, input: DashboardInput) -> Result<Dashboard> {
        self.ensure(ch).await?;
        let name = input.name.trim();
        if name.is_empty() {
            return Err(Error::BadRequest("a dashboard needs a name".into()));
        }
        // Parsed, not just stored: a dashboard saved with a malformed spec is a
        // dashboard that cannot be opened again.
        serde_json::from_str::<serde_json::Value>(&input.spec).map_err(|e| {
            Error::BadRequest(format!("the dashboard layout is not valid JSON: {e}"))
        })?;
        if let Some(id) = &input.id {
            if !crate::routes::is_uuid(id) {
                return Err(Error::BadRequest(format!("`{id}` is not a dashboard id")));
            }
        }

        let id_expr = if input.id.is_some() {
            "{id:UUID}"
        } else {
            "generateUUIDv4()"
        };
        let mut params = vec![
            ("name".to_string(), name.to_string()),
            ("spec".to_string(), Self::text(&input.spec)),
        ];
        if let Some(id) = &input.id {
            params.push(("id".to_string(), id.clone()));
        }

        ch.execute(
            &format!(
                "INSERT INTO {}.dashboards \
                 SELECT {id_expr}, {{name:String}}, unhex({{spec:String}}), \
                        now64(3), now64(3), 0, toUnixTimestamp64Milli(now64(3))",
                self.quoted()
            ),
            QueryOptions {
                params,
                ..self.write_opts()
            },
        )
        .await?;

        self.dashboards(ch)
            .await?
            .into_iter()
            .find(|d| match &input.id {
                Some(id) => d.id.eq_ignore_ascii_case(id),
                None => d.name == name,
            })
            .ok_or_else(|| Error::Decode("the dashboard did not come back".into()))
    }

    pub async fn remove_dashboard(&self, ch: &Client, id: &str) -> Result<()> {
        self.ensure(ch).await?;
        ch.execute(
            &format!(
                "INSERT INTO {}.dashboards \
                 SELECT {{id:UUID}}, '', '', now64(3), now64(3), 1, \
                        toUnixTimestamp64Milli(now64(3))",
                self.quoted()
            ),
            QueryOptions {
                params: vec![("id".into(), id.to_string())],
                ..self.write_opts()
            },
        )
        .await
    }

    // ── Published statements ────────────────────────────────────────────

    /// The collapsed form of `published`, aliased so nothing shadows a column.
    ///
    /// Every alias here is deliberately *not* the name of the column it
    /// aggregates. Aliasing `argMax(slug, version)` as `slug` makes any later
    /// mention of `slug` — in a HAVING, an ORDER BY, another aggregate —
    /// resolve to the alias and nest one aggregate inside another. That single
    /// mistake has broken this codebase eight times; the cure is to aggregate
    /// in here, where the names are new, and to filter and order outside, where
    /// they are unambiguous.
    fn published_rollup(&self) -> String {
        format!(
            "SELECT id                             AS pid, \
                    argMax(name, version)          AS pname, \
                    argMax(slug, version)          AS pslug, \
                    argMax(sql, version)           AS psql, \
                    argMax(database, version)      AS pdatabase, \
                    argMax(defaults, version)      AS pdefaults, \
                    argMax(token, version)         AS ptoken, \
                    argMax(public, version)        AS ppublic, \
                    argMax(enabled, version)       AS penabled, \
                    argMax(max_rows, version)      AS pmax_rows, \
                    argMax(deleted, version)       AS pdeleted, \
                    min(created_at)                AS pcreated, \
                    max(updated_at)                AS pupdated \
             FROM {}.published \
             GROUP BY id",
            self.quoted()
        )
    }

    /// The outer projection, shared by both readers.
    const PUBLISHED_COLUMNS: &'static str = "SELECT toString(pid)             AS id, \
                pname                    AS name, \
                pslug                    AS slug, \
                psql                     AS sql, \
                pdatabase                AS database, \
                pdefaults                AS defaults, \
                ptoken                   AS token, \
                CAST(ppublic != 0 AS Bool)  AS public, \
                CAST(penabled != 0 AS Bool) AS enabled, \
                pmax_rows                AS max_rows, \
                toString(pcreated)       AS created, \
                toString(pupdated)       AS updated";

    pub async fn published(&self, ch: &Client) -> Result<Vec<Published>> {
        self.ensure(ch).await?;
        let sql = format!(
            "{} FROM ({}) WHERE pdeleted = 0 ORDER BY pslug LIMIT 500",
            Self::PUBLISHED_COLUMNS,
            self.published_rollup()
        );
        ch.rows(&sql).await
    }

    /// One endpoint by its address. Enabled only: a paused endpoint answers a
    /// caller exactly as one that never existed, because whether a given
    /// address is switched off is not a caller's business.
    pub async fn published_by_slug(&self, ch: &Client, slug: &str) -> Result<Option<Published>> {
        self.ensure(ch).await?;
        let sql = format!(
            "{} FROM ({}) \
             WHERE pdeleted = 0 AND penabled != 0 AND pslug = {{slug:String}} \
             LIMIT 1",
            Self::PUBLISHED_COLUMNS,
            self.published_rollup()
        );
        ch.row_with(
            &sql,
            QueryOptions {
                params: vec![("slug".into(), slug.to_string())],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await
    }

    pub async fn save_published(
        &self,
        ch: &Client,
        input: PublishedInput,
    ) -> Result<Vec<Published>> {
        self.ensure(ch).await?;
        let name = input.name.trim();
        if name.is_empty() {
            return Err(Error::BadRequest(
                "a published endpoint needs a name".into(),
            ));
        }
        let slug = input.slug.trim().to_lowercase();
        if !crate::published::valid_slug(&slug) {
            return Err(Error::BadRequest(
                "an address may hold lower-case letters, digits, dashes and underscores only, \
                 and it may not start or end with a dash"
                    .into(),
            ));
        }
        if input.sql.trim().is_empty() {
            return Err(Error::BadRequest(
                "a published endpoint needs a statement".into(),
            ));
        }
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&input.defaults)
            .map_err(|e| {
                Error::BadRequest(format!("the parameter defaults are not a JSON object: {e}"))
            })?;
        if let Some(id) = &input.id {
            if !crate::routes::is_uuid(id) {
                return Err(Error::BadRequest(format!("`{id}` is not an endpoint id")));
            }
        }

        // Two endpoints answering on one address is a coin toss over which one
        // a caller reaches, so it is refused rather than resolved.
        let existing = self.published(ch).await?;
        if let Some(clash) = existing
            .iter()
            .find(|p| p.slug == slug && Some(&p.id) != input.id.as_ref())
        {
            return Err(Error::BadRequest(format!(
                "`{slug}` is already the address of `{}`",
                clash.name
            )));
        }

        // A token survives an edit unless one is given: rotating it silently
        // would break every caller the moment someone renamed the endpoint.
        let token = match (&input.token, &input.id) {
            (Some(given), _) => given.trim().to_string(),
            (None, Some(id)) => existing
                .iter()
                .find(|p| &p.id == id)
                .map(|p| p.token.clone())
                .unwrap_or_else(crate::published::mint_token),
            (None, None) => crate::published::mint_token(),
        };

        let id_expr = if input.id.is_some() {
            "{id:UUID}"
        } else {
            "generateUUIDv4()"
        };
        let mut params = vec![
            ("name".to_string(), name.to_string()),
            ("slug".to_string(), slug),
            ("sql".to_string(), Self::text(&input.sql)),
            ("database".to_string(), input.database.clone()),
            ("defaults".to_string(), input.defaults.clone()),
            ("token".to_string(), token),
            ("public".to_string(), u8::from(input.public).to_string()),
            ("enabled".to_string(), u8::from(input.enabled).to_string()),
            (
                "max_rows".to_string(),
                input.max_rows.clamp(1, 100_000).to_string(),
            ),
        ];
        if let Some(id) = &input.id {
            params.push(("id".to_string(), id.clone()));
        }

        ch.execute(
            &format!(
                "INSERT INTO {}.published \
                 SELECT {id_expr}, {{name:String}}, {{slug:String}}, unhex({{sql:String}}), \
                        {{database:String}}, {{defaults:String}}, {{token:String}}, \
                        {{public:UInt8}}, {{enabled:UInt8}}, {{max_rows:UInt32}}, \
                        now64(3), now64(3), 0, toUnixTimestamp64Milli(now64(3))",
                self.quoted()
            ),
            QueryOptions {
                params,
                ..self.write_opts()
            },
        )
        .await?;
        self.published(ch).await
    }

    pub async fn remove_published(&self, ch: &Client, id: &str) -> Result<()> {
        self.ensure(ch).await?;
        ch.execute(
            &format!(
                "INSERT INTO {}.published \
                 SELECT {{id:UUID}}, '', '', '', '', '{{}}', '', 0, 0, 0, now64(3), now64(3), 1, \
                        toUnixTimestamp64Milli(now64(3))",
                self.quoted()
            ),
            QueryOptions {
                params: vec![("id".into(), id.to_string())],
                ..self.write_opts()
            },
        )
        .await
    }

    // ── Reports ─────────────────────────────────────────────────────────

    /// The server's clock, in the server's timezone.
    ///
    /// Asked of ClickHouse rather than computed here: the timestamps a report
    /// is compared against were written by ClickHouse, and Flint already shows
    /// ClickHouse's timezone on the server page. Two clocks would eventually
    /// disagree, and the disagreement would look like a report that runs twice.
    pub async fn clock(&self, ch: &Client) -> Result<crate::reports::Clock> {
        ch.row(
            "SELECT toInt64(toUnixTimestamp(now()))                    AS now_ts, \
                    toInt64(toUnixTimestamp(toDateTime(today())))       AS midnight_ts, \
                    toUInt8(toDayOfWeek(now()))                        AS dow",
        )
        .await?
        .ok_or_else(|| Error::Decode("ClickHouse returned no clock".into()))
    }

    pub async fn reports(&self, ch: &Client) -> Result<Vec<Report>> {
        self.ensure(ch).await?;
        let db = self.quoted();
        let sql = format!(
            "SELECT toString(r.id)                          AS id, \
                    r.name                                   AS name, \
                    r.spec                                   AS spec, \
                    r.schedule                               AS schedule, \
                    r.webhook                                AS webhook, \
                    CAST(r.enabled != 0 AS Bool)             AS enabled, \
                    r.created                                AS created, \
                    r.updated                                AS updated, \
                    l.last_at                                AS last_run, \
                    l.last_status                            AS last_status, \
                    l.total                                  AS runs \
             FROM ( \
                 SELECT id, \
                        argMax(name, version)     AS name, \
                        argMax(spec, version)     AS spec, \
                        argMax(schedule, version) AS schedule, \
                        argMax(webhook, version)  AS webhook, \
                        argMax(enabled, version)  AS enabled, \
                        toString(min(created_at)) AS created, \
                        toString(max(updated_at)) AS updated \
                 FROM {db}.reports \
                 GROUP BY id \
                 HAVING argMax(deleted, version) = 0 \
             ) AS r \
             LEFT JOIN ( \
                 SELECT report_id, \
                        toString(max(at))     AS last_at, \
                        argMax(status, at)    AS last_status, \
                        count()               AS total \
                 FROM {db}.report_runs \
                 GROUP BY report_id \
             ) AS l ON l.report_id = r.id \
             ORDER BY r.name \
             LIMIT 500"
        );
        ch.rows(&sql).await
    }

    /// Unix seconds of the last run of each report, for the due-ness check.
    pub async fn last_run_seconds(
        &self,
        ch: &Client,
    ) -> Result<std::collections::HashMap<String, i64>> {
        self.ensure(ch).await?;
        #[derive(Deserialize)]
        struct Row {
            id: String,
            ran: i64,
        }
        let rows: Vec<Row> = ch
            .rows(&format!(
                "SELECT toString(report_id)                     AS id, \
                        toInt64(toUnixTimestamp(max(at)))       AS ran \
                 FROM {}.report_runs GROUP BY report_id",
                self.quoted()
            ))
            .await?;
        Ok(rows.into_iter().map(|r| (r.id, r.ran)).collect())
    }

    pub async fn save_report(&self, ch: &Client, input: ReportInput) -> Result<()> {
        self.ensure(ch).await?;
        let name = input.name.trim();
        if name.is_empty() {
            return Err(Error::BadRequest("a report needs a name".into()));
        }
        // Both halves parsed before storing, for the same reason a dashboard's
        // layout is: a report that cannot be read is one that sits in the list
        // looking scheduled and never runs.
        crate::reports::Spec::parse(&input.spec).map_err(Error::BadRequest)?;
        crate::reports::Schedule::parse(&input.schedule).map_err(Error::BadRequest)?;
        if let Some(id) = &input.id {
            if !crate::routes::is_uuid(id) {
                return Err(Error::BadRequest(format!("`{id}` is not a report id")));
            }
        }

        let id_expr = if input.id.is_some() {
            "{id:UUID}"
        } else {
            "generateUUIDv4()"
        };
        let mut params = vec![
            ("name".to_string(), name.to_string()),
            ("spec".to_string(), Self::text(&input.spec)),
            ("schedule".to_string(), input.schedule.clone()),
            ("webhook".to_string(), input.webhook.trim().to_string()),
            ("enabled".to_string(), u8::from(input.enabled).to_string()),
        ];
        if let Some(id) = &input.id {
            params.push(("id".to_string(), id.clone()));
        }

        ch.execute(
            &format!(
                "INSERT INTO {}.reports \
                 SELECT {id_expr}, {{name:String}}, unhex({{spec:String}}), {{schedule:String}}, \
                        {{webhook:String}}, {{enabled:UInt8}}, now64(3), now64(3), 0, \
                        toUnixTimestamp64Milli(now64(3))",
                self.quoted()
            ),
            QueryOptions {
                params,
                ..self.write_opts()
            },
        )
        .await
    }

    pub async fn remove_report(&self, ch: &Client, id: &str) -> Result<()> {
        self.ensure(ch).await?;
        ch.execute(
            &format!(
                "INSERT INTO {}.reports \
                 SELECT {{id:UUID}}, '', '', '', '', 0, now64(3), now64(3), 1, \
                        toUnixTimestamp64Milli(now64(3))",
                self.quoted()
            ),
            QueryOptions {
                params: vec![("id".into(), id.to_string())],
                ..self.write_opts()
            },
        )
        .await
    }

    /// The runs of a report, without their contents.
    pub async fn report_runs(
        &self,
        ch: &Client,
        report_id: Option<&str>,
        limit: u64,
    ) -> Result<Vec<ReportRun>> {
        self.ensure(ch).await?;
        let filter = if report_id.is_some() {
            "WHERE report_id = {id:UUID}"
        } else {
            ""
        };
        // `sections` is deliberately absent: it is the whole snapshot, and a
        // list of thirty runs would ship thirty snapshots to draw a list.
        let sql = format!(
            "SELECT toString(run_id)         AS run, \
                    toString(report_id)      AS which, \
                    report                   AS report, \
                    toString(at)             AS happened, \
                    status                   AS status, \
                    error                    AS error, \
                    CAST(delivered != 0 AS Bool) AS delivered, \
                    delivery_error           AS delivery_error, \
                    section_count            AS sections \
             FROM {}.report_runs \
             {filter} \
             ORDER BY at DESC \
             LIMIT {}",
            self.quoted(),
            limit.clamp(1, 200)
        );
        let params = report_id
            .map(|id| vec![("id".to_string(), id.to_string())])
            .unwrap_or_default();
        ch.rows_with(
            &sql,
            QueryOptions {
                params,
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await
    }

    /// One run, with what it found.
    pub async fn report_snapshot(&self, ch: &Client, run_id: &str) -> Result<ReportSnapshot> {
        self.ensure(ch).await?;
        let sql = format!(
            "SELECT toString(run_id)     AS run, \
                    toString(report_id)  AS which, \
                    report               AS report, \
                    toString(at)         AS happened, \
                    status               AS status, \
                    error                AS error, \
                    sections             AS sections \
             FROM {}.report_runs \
             WHERE run_id = {{id:UUID}} \
             LIMIT 1",
            self.quoted()
        );
        ch.row_with(
            &sql,
            QueryOptions {
                params: vec![("id".into(), run_id.to_string())],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?
        .ok_or_else(|| Error::NotFound(format!("no report run `{run_id}`")))
    }

    #[allow(clippy::too_many_arguments)]
    /// The run id is minted here rather than by `generateUUIDv4()` in the
    /// statement, so the caller can say *which* run it just made. A manual run
    /// has to hand one back — "it ran, go and find it in the list" is not an
    /// answer when two runs can land in the same second.
    pub async fn record_report_run(
        &self,
        ch: &Client,
        run_id: &str,
        report: &Report,
        status: &str,
        sections_json: &str,
        section_count: usize,
        error: &str,
        delivery: &crate::alerts::Delivery,
    ) -> Result<()> {
        self.ensure(ch).await?;
        ch.execute(
            &format!(
                "INSERT INTO {}.report_runs \
                 SELECT {{run_id:UUID}}, {{id:UUID}}, {{report:String}}, now64(3), \
                        {{status:String}}, {{sections:String}}, {{count:UInt32}}, \
                        {{error:String}}, {{delivered:UInt8}}, {{derror:String}}",
                self.quoted()
            ),
            QueryOptions {
                params: vec![
                    ("run_id".into(), run_id.to_string()),
                    ("id".into(), report.id.clone()),
                    ("report".into(), report.name.clone()),
                    ("status".into(), status.to_string()),
                    ("sections".into(), sections_json.to_string()),
                    ("count".into(), section_count.to_string()),
                    ("error".into(), error.to_string()),
                    ("delivered".into(), u8::from(delivery.sent()).to_string()),
                    ("derror".into(), delivery.note()),
                ],
                ..self.write_opts()
            },
        )
        .await
    }

    // ── Alerts ──────────────────────────────────────────────────────────

    /// Every alert, with where it currently stands.
    ///
    /// The state comes from the event log rather than from the scheduler's
    /// memory, so the list reads the same in a browser opened after a restart
    /// as it did before one.
    pub async fn alerts(&self, ch: &Client) -> Result<Vec<Alert>> {
        self.ensure(ch).await?;
        let db = self.quoted();
        let sql = format!(
            "SELECT toString(a.id)                          AS id, \
                    a.name                                   AS name, \
                    a.sql                                    AS sql, \
                    a.database                               AS database, \
                    a.condition                              AS condition, \
                    a.interval_seconds                       AS interval_seconds, \
                    a.webhook                                AS webhook, \
                    CAST(a.enabled != 0 AS Bool)             AS enabled, \
                    a.created                                AS created, \
                    a.updated                                AS updated, \
                    e.last_state                             AS state, \
                    e.last_at                                AS last_event, \
                    e.last_line                              AS last_message, \
                    CAST(e.last_sent != 0 AS Bool)           AS last_delivered, \
                    e.last_fault                             AS last_delivery_error \
             FROM ( \
                 SELECT id, \
                        argMax(name, version)             AS name, \
                        argMax(sql, version)              AS sql, \
                        argMax(database, version)         AS database, \
                        argMax(condition, version)        AS condition, \
                        argMax(interval_seconds, version) AS interval_seconds, \
                        argMax(webhook, version)          AS webhook, \
                        argMax(enabled, version)          AS enabled, \
                        toString(min(created_at))         AS created, \
                        toString(max(updated_at))         AS updated \
                 FROM {db}.alerts \
                 GROUP BY id \
                 HAVING argMax(deleted, version) = 0 \
             ) AS a \
             LEFT JOIN ( \
                 /* Never `max(at) AS at`: the alias shadows the column, and \
                    `argMax(message, at)` then nests one aggregate inside \
                    another. Fifth time in this codebase. */ \
                 SELECT alert_id, \
                        argMax(state, at)     AS last_state, \
                        toString(max(at))     AS last_at, \
                        argMax(message, at)   AS last_line, \
                        argMax(delivered, at) AS last_sent, \
                        argMax(delivery_error, at) AS last_fault \
                 FROM {db}.alert_events \
                 GROUP BY alert_id \
             ) AS e ON e.alert_id = a.id \
             ORDER BY a.name \
             LIMIT 500"
        );
        ch.rows(&sql).await
    }

    /// The last state of every alert, for the scheduler to resume from so a
    /// restart does not re-announce what was already firing.
    pub async fn last_states(
        &self,
        ch: &Client,
    ) -> Result<std::collections::HashMap<String, crate::alerts::State>> {
        self.ensure(ch).await?;
        #[derive(Deserialize)]
        struct Row {
            id: String,
            last_state: String,
        }
        let rows: Vec<Row> = ch
            .rows(&format!(
                "SELECT toString(alert_id) AS id, argMax(state, at) AS last_state \
                 FROM {}.alert_events GROUP BY alert_id",
                self.quoted()
            ))
            .await?;
        Ok(rows
            .into_iter()
            .filter_map(|r| crate::alerts::State::parse(&r.last_state).map(|s| (r.id, s)))
            .collect())
    }

    pub async fn save_alert(&self, ch: &Client, input: AlertInput) -> Result<()> {
        self.ensure(ch).await?;
        let name = input.name.trim();
        if name.is_empty() {
            return Err(Error::BadRequest("an alert needs a name".into()));
        }
        if input.sql.trim().is_empty() {
            return Err(Error::BadRequest(
                "an alert needs a statement to run".into(),
            ));
        }
        // Parsed before it is stored, like a dashboard's layout: an alert whose
        // condition cannot be read would sit in the list looking armed and
        // never fire.
        crate::alerts::Condition::parse(&input.condition).map_err(Error::BadRequest)?;
        if let Some(id) = &input.id {
            if !crate::routes::is_uuid(id) {
                return Err(Error::BadRequest(format!("`{id}` is not an alert id")));
            }
        }
        // A floor, not a preference: a statement re-run every second is a load
        // test, and the scheduler's own tick is ten seconds anyway.
        let interval = input.interval_seconds.clamp(10, 86_400);

        let id_expr = if input.id.is_some() {
            "{id:UUID}"
        } else {
            "generateUUIDv4()"
        };
        let mut params = vec![
            ("name".to_string(), name.to_string()),
            ("sql".to_string(), Self::text(&input.sql)),
            ("database".to_string(), input.database.clone()),
            ("condition".to_string(), input.condition.clone()),
            ("interval".to_string(), interval.to_string()),
            ("webhook".to_string(), input.webhook.trim().to_string()),
            ("enabled".to_string(), u8::from(input.enabled).to_string()),
        ];
        if let Some(id) = &input.id {
            params.push(("id".to_string(), id.clone()));
        }

        ch.execute(
            &format!(
                "INSERT INTO {}.alerts \
                 SELECT {id_expr}, {{name:String}}, unhex({{sql:String}}), {{database:String}}, \
                        {{condition:String}}, {{interval:UInt32}}, {{webhook:String}}, \
                        {{enabled:UInt8}}, now64(3), now64(3), 0, \
                        toUnixTimestamp64Milli(now64(3))",
                self.quoted()
            ),
            QueryOptions {
                params,
                ..self.write_opts()
            },
        )
        .await
    }

    pub async fn remove_alert(&self, ch: &Client, id: &str) -> Result<()> {
        self.ensure(ch).await?;
        ch.execute(
            &format!(
                "INSERT INTO {}.alerts \
                 SELECT {{id:UUID}}, '', '', '', '', 0, '', 0, now64(3), now64(3), 1, \
                        toUnixTimestamp64Milli(now64(3))",
                self.quoted()
            ),
            QueryOptions {
                params: vec![("id".into(), id.to_string())],
                ..self.write_opts()
            },
        )
        .await
    }

    /// The recent history of one alert, or of all of them.
    pub async fn alert_events(
        &self,
        ch: &Client,
        alert_id: Option<&str>,
        limit: u64,
    ) -> Result<Vec<AlertEvent>> {
        self.ensure(ch).await?;
        let filter = if alert_id.is_some() {
            "WHERE alert_id = {id:UUID}"
        } else {
            ""
        };
        // Aliased `which`, not `alert_id`: naming the projection after the
        // column shadows it, and the WHERE below then compares a String to a
        // UUID parameter. Sixth time this pattern has bitten this codebase.
        let sql = format!(
            "SELECT toString(alert_id)  AS which, \
                    alert               AS alert, \
                    toString(at)        AS happened, \
                    state               AS state, \
                    value               AS value, \
                    message             AS message, \
                    CAST(delivered != 0 AS Bool) AS delivered, \
                    delivery_error      AS delivery_error \
             FROM {}.alert_events \
             {filter} \
             ORDER BY at DESC \
             LIMIT {}",
            self.quoted(),
            limit.clamp(1, 500)
        );
        let params = alert_id
            .map(|id| vec![("id".to_string(), id.to_string())])
            .unwrap_or_default();
        ch.rows_with(
            &sql,
            QueryOptions {
                params,
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await
    }

    /// Append one event. Called by the scheduler, which has already decided
    /// that this is a transition worth recording.
    pub async fn record_alert_event(
        &self,
        ch: &Client,
        alert: &Alert,
        state: crate::alerts::State,
        value: Option<f64>,
        message: &str,
        delivery: &crate::alerts::Delivery,
    ) -> Result<()> {
        self.ensure(ch).await?;
        // A missing measurement is NULL, not zero: "could not run" and
        // "measured nothing" are different facts.
        let value_expr = match value {
            Some(_) => "{value:Float64}",
            None => "NULL",
        };
        let mut params = vec![
            ("id".to_string(), alert.id.clone()),
            ("alert".to_string(), alert.name.clone()),
            ("state".to_string(), state.as_str().to_string()),
            ("message".to_string(), message.to_string()),
            (
                "delivered".to_string(),
                u8::from(delivery.sent()).to_string(),
            ),
            ("error".to_string(), delivery.note()),
        ];
        if let Some(v) = value {
            params.push(("value".to_string(), v.to_string()));
        }

        ch.execute(
            &format!(
                "INSERT INTO {}.alert_events \
                 SELECT {{id:UUID}}, {{alert:String}}, now64(3), {{state:String}}, \
                        {value_expr}, {{message:String}}, {{delivered:UInt8}}, \
                        {{error:String}}",
                self.quoted()
            ),
            QueryOptions {
                params,
                ..self.write_opts()
            },
        )
        .await
    }

    /// A tombstone, not a DELETE: the row stays and a later version marks it
    /// gone, which is how a ReplacingMergeTree forgets something.
    pub async fn remove(&self, ch: &Client, id: &str) -> Result<()> {
        self.ensure(ch).await?;
        let sql = format!(
            "INSERT INTO {}.saved_queries \
             SELECT {{id:UUID}}, '', '', '', now64(3), now64(3), 1, \
                    toUnixTimestamp64Milli(now64(3))",
            self.quoted()
        );
        ch.execute(
            &sql,
            QueryOptions {
                params: vec![("id".into(), id.to_string())],
                ..self.write_opts()
            },
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_a_database_name_that_needs_it() {
        assert_eq!(Workspace::new("flint".into()).quoted(), "`flint`");
        assert_eq!(Workspace::new("odd name".into()).quoted(), "`odd name`");
        assert_eq!(Workspace::new("a`b".into()).quoted(), "`a\\`b`");
    }

    #[test]
    fn workspace_writes_are_allowed_even_in_read_only_mode() {
        // FLINT_READONLY is a promise about the user's tables, not about Flint's
        // own; without this a read-only deployment could never save anything.
        assert!(Workspace::new("flint".into()).write_opts().allow_write);
    }
}
