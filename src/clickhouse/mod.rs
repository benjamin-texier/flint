pub mod access;
pub mod affinity;
pub mod alter;
pub mod audit;
pub mod backups;
pub mod build;
pub mod cluster;
pub mod compare;
pub mod connect;
pub mod ddl;
pub mod derived;
pub mod diagnostics;
pub mod dictionaries;
pub mod distribution;
pub mod drift;
pub mod govern;
pub mod grants;
pub mod graph;
pub mod health;
pub mod limits;
pub mod mass;
pub mod meta;
pub mod news;
pub mod now;
pub mod parts;
pub mod pipelines;
pub mod probe;
pub mod profile;
pub mod projection;
pub mod rbac;
pub mod reads;
pub mod relations;
pub mod review;
pub mod rows;
pub mod settings;
pub mod storage;
pub mod streams;
pub mod sysops;
pub mod timeline;
pub mod trace;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::config::Config;
use crate::error::{Error, Result};

/// Output formats we ask ClickHouse for. `JSONEachRow` is used for our own
/// metadata queries (deserialised into typed structs); `JSONCompact` is used
/// for user queries because it carries column metadata and statistics
/// alongside row-major data.
/// What the column probe remembers: for one server, one user and one `system.*`
/// table, the columns that user can see on it.
///
/// Keyed by all three. By user because `system.columns` is itself filtered by
/// grants, so the answer belongs to the asker as much as to the server; and by
/// endpoint because an unpinned Flint holds sessions on *different* ClickHouses
/// at once, and remembering one server's columns for another would degrade a
/// page for a version that server is not running.
type ColumnProbe = HashMap<(String, String, String), HashSet<String>>;

const FORMAT_EACH_ROW: &str = "JSONEachRow";
const FORMAT_COMPACT: &str = "JSONCompact";

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    url: String,
    user: String,
    password: String,
    readonly: bool,
    max_result_rows: u64,
    timeout_secs: u64,
    /// The zone the server on the other end cuts its dates in, read once when
    /// the connection was established — at boot for the manifest's server, at
    /// sign-in for one a browser named. Empty where it could not be read, and
    /// an answer then says nothing about its zone rather than naming one it is
    /// not sure of.
    ///
    /// On the client rather than in the application state because on an
    /// unpinned Flint it is not one fact: it belongs to the connection, and the
    /// connection is this.
    timezone: String,
    /// Which columns each `system.*` table actually has on *this* server, for
    /// each user who has asked. ClickHouse adds columns to its system tables
    /// over time, so we probe once and degrade gracefully instead of failing on
    /// older versions.
    ///
    /// Keyed by user as well as table, and shared between the clones that carry
    /// different identities. It has to be both: `system.columns` is itself
    /// filtered by grants, so two users can legitimately get two different
    /// answers about the same table — and a per-clone cache would be empty on
    /// every request, since a clone is made per request.
    system_columns: Arc<RwLock<ColumnProbe>>,
}

#[derive(Debug, Clone, Default)]
pub struct QueryOptions {
    pub database: Option<String>,
    pub query_id: Option<String>,
    pub max_rows: Option<u64>,
    pub params: Vec<(String, String)>,
    /// Internal queries want real JSON numbers; user queries keep ClickHouse's
    /// default of quoting 64-bit integers so the browser cannot silently lose
    /// precision above 2^53.
    pub quote_64bit_integers: bool,
    /// Let this statement write even when the server is in read-only mode.
    /// Only ever set for the KILL QUERY that cancels the caller's own query.
    pub allow_write: bool,
    /// Stream the answer rather than assembling it.
    ///
    /// Only a download sets this. Every other read in Flint is a bounded page
    /// that it parses and reshapes, and for those `wait_end_of_query` is worth
    /// its cost: it makes ClickHouse finish before the first byte moves, so a
    /// failure arrives as a failure rather than as half an answer.
    pub stream: bool,
    /// Read this statement's wall clock in another zone.
    ///
    /// `session_timezone` is not a rendering flag: it moves the boundaries of
    /// `toStartOfDay`, the answer of `toDayOfWeek`, and the meaning of a naive
    /// datetime literal. So it is set deliberately and narrowly — for a report
    /// whose schedule is a time of day in a place — and never inherited from
    /// whoever happens to be looking, because an answer that changes with its
    /// reader is not an answer a dashboard or an endpoint can give.
    pub timezone: Option<String>,
    /// Run this statement with one role active instead of the account's own.
    ///
    /// **This narrows only what the account holds through roles.** ClickHouse's
    /// effective privileges are the union of the active roles *and* everything
    /// granted to the user directly, and a direct grant cannot be switched off
    /// — so an account holding `SELECT ON *.*` in its own right reads
    /// everything whatever role is named here. Whoever sets this is responsible
    /// for that precondition; `workspace::delegation_check` is where Flint
    /// refuses to pretend otherwise.
    pub role: Option<String>,
    /// Settings this one statement carries, on top of Flint's own.
    ///
    /// Only the console fills this, and only with names `routes::query`
    /// has vetted — see `REFUSED_SETTINGS` there for what may not appear and
    /// why. They are pushed *after* Flint's own so a duplicate cannot be used
    /// to argue about `readonly`; the refusal is the real guard, this is the
    /// belt that goes with it.
    pub settings: Vec<(String, String)>,
    /// Send `readonly=2` even where the deployment is not read-only.
    ///
    /// For statements Flint runs unattended. A scheduled alert is a question,
    /// and nobody is watching to notice that the thing running every minute is
    /// a DELETE — so the guarantee cannot depend on how the operator configured
    /// the rest of Flint.
    pub force_readonly: bool,
    /// Flint asking ClickHouse about itself, rather than the user asking about
    /// their data. Tagged in `query_log` so the diagnostics can leave it out:
    /// a page that ranks query cost is worthless if the costliest patterns it
    /// finds are the page's own.
    pub introspection: bool,
    /// A `log_comment` of Flint's choosing, for statements worth telling apart
    /// in `system.query_log` later. Wins over `introspection`.
    ///
    /// Used to attribute a published endpoint's calls to the endpoint. Tagging
    /// costs nothing per request, where a table of Flint's own would double the
    /// writes of every API call to answer a question the log already holds.
    pub log_comment: Option<String>,
}

/// The `log_comment` Flint stamps on its own metadata queries. Chosen to be
/// unmistakable in a log someone else is reading.
pub const INTROSPECTION_TAG: &str = "flint:introspection";

/// The settings Flint attaches to statements it sends, by name.
///
/// One list, because two would drift. It is what `/api/config` publishes so the
/// editor can explain the numbers in its stats strip, and it is what the
/// configuration page subtracts: `system.settings` cannot tell a setting that
/// arrived on the request from one that came from a profile, so a page reading
/// that table would otherwise report *Flint's* timeout as the server's
/// configuration.
///
/// The test is *did Flint send it*, and nothing else. An earlier version of this
/// list held only the settings somebody might plausibly configure, on the
/// reasoning that `log_comment` and `default_format` steer one request rather
/// than being configuration — and `log_comment` promptly turned up on the
/// configuration page reading `flint:introspection`, presented as this server's
/// own. A name Flint never sends costs nothing to have here; one it does send
/// and that is missing is a lie on a page about configuration.
pub const ATTACHED_SETTINGS: [&str; 12] = [
    "wait_end_of_query",
    "max_execution_time",
    "enable_http_compression",
    "max_result_rows",
    "result_overflow_mode",
    "max_block_size",
    "readonly",
    "log_comment",
    "default_format",
    "output_format_json_quote_64bit_integers",
    "output_format_json_quote_denormals",
    "database",
];

impl QueryOptions {
    fn internal() -> Self {
        Self {
            quote_64bit_integers: false,
            introspection: true,
            ..Default::default()
        }
    }
}

/// The tail of `X-ClickHouse-Summary`, which ClickHouse emits once the query
/// has finished (we ask for `wait_end_of_query=1` so it lands in the headers).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Summary {
    #[serde(default, deserialize_with = "de_stringy_u64")]
    pub read_rows: u64,
    #[serde(default, deserialize_with = "de_stringy_u64")]
    pub read_bytes: u64,
    #[serde(default, deserialize_with = "de_stringy_u64")]
    pub written_rows: u64,
    #[serde(default, deserialize_with = "de_stringy_u64")]
    pub written_bytes: u64,
    #[serde(default, deserialize_with = "de_stringy_u64")]
    pub total_rows_to_read: u64,
    #[serde(default, deserialize_with = "de_stringy_u64")]
    pub result_rows: u64,
    #[serde(default, deserialize_with = "de_stringy_u64")]
    pub result_bytes: u64,
    #[serde(default, deserialize_with = "de_stringy_u64")]
    pub elapsed_ns: u64,
}

/// ClickHouse serialises the summary counters as strings.
fn de_stringy_u64<'de, D>(d: D) -> std::result::Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize as _;
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Stringy {
        Str(String),
        Num(u64),
    }
    Ok(match Stringy::deserialize(d)? {
        Stringy::Str(s) => s.parse().unwrap_or(0),
        Stringy::Num(n) => n,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    /// ClickHouse type as written, e.g. `Nullable(DateTime64(3))`.
    pub r#type: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Statistics {
    pub elapsed: f64,
    pub rows_read: u64,
    pub bytes_read: u64,
}

/// A user query's result, shaped for direct consumption by the results grid.
#[derive(Debug, Clone, Serialize)]
pub struct TableResult {
    pub query_id: String,
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// True when we stopped at `max_result_rows` and there is more behind it.
    pub truncated: bool,
    pub rows_before_limit_at_least: Option<u64>,
    pub statistics: Statistics,
    pub summary: Summary,
    /// `"read"` for anything that produced a result set, `"command"` for DDL,
    /// inserts and other statements that return no rows.
    pub kind: &'static str,
}

#[derive(Deserialize)]
struct JsonCompactBody {
    #[serde(default)]
    meta: Vec<JsonCompactCol>,
    #[serde(default)]
    data: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    rows_before_limit_at_least: Option<u64>,
    #[serde(default)]
    statistics: Option<JsonCompactStats>,
}

#[derive(Deserialize)]
struct JsonCompactCol {
    name: String,
    r#type: String,
}

#[derive(Deserialize)]
struct JsonCompactStats {
    #[serde(default)]
    elapsed: f64,
    #[serde(default)]
    rows_read: u64,
    #[serde(default)]
    bytes_read: u64,
}

impl Client {
    pub fn new(config: &Config) -> Result<Self> {
        let http = http_client(
            config.clickhouse_ca_cert.as_deref(),
            // Generous: the per-query ceiling is enforced server-side by
            // max_execution_time, this is only a backstop against a hung socket.
            std::time::Duration::from_secs(config.query_timeout_secs + 30),
        )?;

        Ok(Self {
            http,
            // Empty unpinned, and never dialled in that state: the endpoint
            // arrives with the session, `as_user` puts it here, and `dispatch`
            // refuses an empty one rather than sending a request to nowhere.
            url: config
                .endpoint()
                .unwrap_or_default()
                .trim_end_matches('/')
                .to_string(),
            user: config.clickhouse_user.clone(),
            password: config.clickhouse_password.clone(),
            readonly: config.readonly,
            max_result_rows: config.max_result_rows,
            timeout_secs: config.query_timeout_secs,
            timezone: String::new(),
            system_columns: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    /// Where this client sends. Empty on the service client of an unpinned
    /// Flint, which is the one client that has nowhere to send.
    pub fn endpoint(&self) -> &str {
        &self.url
    }

    /// The zone the server on the other end cuts its dates in, or empty where
    /// it could not be read. See the field.
    pub fn timezone(&self) -> &str {
        &self.timezone
    }

    /// The same client, remembering what the server said its zone was — the
    /// handshake's answer, kept rather than asked again on every query.
    pub fn with_timezone(mut self, timezone: impl Into<String>) -> Self {
        self.timezone = timezone.into();
        self
    }

    /// The same client, speaking as somebody else.
    ///
    /// This is how one signed-in person's statements come to run as them: the
    /// handler makes a clone carrying their credentials and hands it to code
    /// that has no idea any of this happened. Cheap — a `reqwest::Client` is an
    /// `Arc` internally, and the probe cache is shared and keyed by user.
    ///
    /// Deliberately not a mutation of the stored client: there is exactly one
    /// `Client` in the application state and it belongs to Flint, not to
    /// whoever asked last.
    ///
    /// It carries the *server* too, where the session named one. Which makes
    /// this the single funnel through which a request acquires both who it is
    /// and where it goes — worth keeping to one function, because a second way
    /// to set one without the other is a request sent to one server with
    /// another's credentials.
    pub fn as_user(&self, identity: &crate::auth::Identity) -> Self {
        Self {
            user: identity.user().to_string(),
            password: identity.password().to_string(),
            url: match identity.endpoint() {
                Some(endpoint) => endpoint.trim_end_matches('/').to_string(),
                // Pinned: the manifest's, which is already here.
                None => self.url.clone(),
            },
            // Only when the session learned one. Pinned with `--auth` on, the
            // session has nothing to say about the zone and the boot handshake's
            // answer is the better one.
            timezone: match identity.timezone() {
                "" => self.timezone.clone(),
                zone => zone.to_string(),
            },
            ..self.clone()
        }
    }

    /// Send `sql` and hand back the raw response body plus the summary.
    async fn send(
        &self,
        sql: &str,
        format: &str,
        opts: &QueryOptions,
    ) -> Result<(String, Summary)> {
        let response = self.dispatch(sql, format, opts).await?;
        let summary = summary_of(&response);
        let status = response.status();
        // Read before the body is consumed, because the headers are the only
        // place the peer says who it is.
        let vouched = vouches_for_clickhouse(&response);

        let body = response.text().await.map_err(|source| Error::Transport {
            url: self.url.clone(),
            source: source.without_url(),
        })?;

        if !status.is_success() {
            if !vouched {
                return Err(not_clickhouse(&self.url, status, &body));
            }
            return Err(parse_exception(&body));
        }
        // A 200 whose body is not the JSON we asked for, from a peer that named
        // itself nothing. An empty body is left alone: that is a real answer with
        // no rows in it, and a ClickHouse behind a proxy that strips headers must
        // keep working.
        if !vouched && !body.trim().is_empty() && !opens_json(&body) {
            return Err(not_clickhouse(&self.url, status, &body));
        }
        Ok((body, summary))
    }

    /// Send `sql` and hand back the response with its body still on the wire.
    ///
    /// The status is checked here — and an error body is small, so reading it
    /// to make a real message costs nothing — but a successful body is handed
    /// over unread. That is the whole point: a download exists because the
    /// answer is bigger than a page, and a `text()` here would put the user's
    /// table in Flint's memory on its way to their disk.
    ///
    /// The cost, and it is a real one: an error ClickHouse raises *after* the
    /// first block has gone out arrives inside the body, so a download can end
    /// in a truncated file with an exception at the end of it rather than in a
    /// clean failure. Buffering server-side with `wait_end_of_query` would
    /// trade that for holding the whole answer in ClickHouse's memory, which is
    /// the same problem moved one hop.
    pub async fn open(
        &self,
        sql: &str,
        format: &str,
        opts: &QueryOptions,
    ) -> Result<reqwest::Response> {
        let response = self.dispatch(sql, format, opts).await?;
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status();
        let vouched = vouches_for_clickhouse(&response);
        let body = response.text().await.map_err(|source| Error::Transport {
            url: self.url.clone(),
            source: source.without_url(),
        })?;
        if !vouched {
            return Err(not_clickhouse(&self.url, status, &body));
        }
        Err(parse_exception(&body))
    }

    /// Everything both of those share: the settings, and the request itself.
    async fn dispatch(
        &self,
        sql: &str,
        format: &str,
        opts: &QueryOptions,
    ) -> Result<reqwest::Response> {
        // Unpinned, and nobody has named a server. Every path that can reach
        // here with an empty endpoint is one of Flint's own — the workspace, the
        // scheduler, the health probe — and each is refused at a higher level
        // first; this is the backstop, and it says which mode Flint is in rather
        // than letting reqwest complain about a relative URL.
        if self.url.is_empty() {
            return Err(Error::BadRequest(
                "this Flint has no ClickHouse of its own: FLINT_CLICKHOUSE_URL is unset, so it \
                 connects to whichever server the person signing in names. Nothing can run here \
                 without a session."
                    .into(),
            ));
        }

        let mut params: Vec<(String, String)> = vec![
            ("default_format".into(), format.into()),
            // A download waits for nothing: it streams, so the answer must not
            // be assembled in the server before the first byte moves.
            (
                "wait_end_of_query".into(),
                if opts.stream { "0" } else { "1" }.into(),
            ),
            ("max_execution_time".into(), self.timeout_secs.to_string()),
            (
                "output_format_json_quote_64bit_integers".into(),
                if opts.quote_64bit_integers { "1" } else { "0" }.into(),
            ),
            // Emit `null` rather than `nan`/`inf`, which are not valid JSON.
            ("output_format_json_quote_denormals".into(), "0".into()),
            ("enable_http_compression".into(), "1".into()),
        ];

        if let Some(tag) = &opts.log_comment {
            params.push(("log_comment".into(), tag.clone()));
        } else if opts.introspection {
            params.push(("log_comment".into(), INTROSPECTION_TAG.into()));
        }

        let cap = opts.max_rows.unwrap_or(self.max_result_rows);
        if cap > 0 {
            // `break` truncates instead of raising, so a wide `SELECT *` on a
            // huge table returns a usable preview rather than an error.
            //
            // ClickHouse only checks the threshold between blocks, so it can
            // overshoot by up to one block and the cap alone is not a hard
            // limit — `table()` trims the surplus. Asking for one row beyond
            // the cap is what makes "there is more behind this" detectable,
            // and shrinking the block size bounds how much we ship to get it.
            params.push(("max_result_rows".into(), (cap + 1).to_string()));
            params.push(("result_overflow_mode".into(), "break".into()));
            params.push((
                "max_block_size".into(),
                (cap + 1).clamp(1024, 65_505).to_string(),
            ));
        }
        if (self.readonly || opts.force_readonly) && !opts.allow_write {
            // readonly=2 permits SELECT and SET but rejects DDL and DML.
            params.push(("readonly".into(), "2".into()));
        }
        if let Some(db) = &opts.database {
            params.push(("database".into(), db.clone()));
        }
        if let Some(tz) = &opts.timezone {
            params.push(("session_timezone".into(), tz.clone()));
        }
        if let Some(role) = &opts.role {
            // ClickHouse's own parameter, so the role applies to this one
            // statement rather than to a session Flint would have to keep.
            params.push(("role".into(), role.clone()));
        }
        if let Some(id) = &opts.query_id {
            params.push(("query_id".into(), id.clone()));
        }
        for (name, value) in &opts.params {
            params.push((format!("param_{name}"), value.clone()));
        }
        // Last, so nothing here can shadow a setting Flint decided above.
        for (name, value) in &opts.settings {
            params.push((name.clone(), value.clone()));
        }

        let response = self
            .http
            .post(&self.url)
            .query(&params)
            .header("X-ClickHouse-User", &self.user)
            .header("X-ClickHouse-Key", &self.password)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(sql.to_string())
            .send()
            .await
            .map_err(|source| Error::Transport {
                url: self.url.clone(),
                // Our message already names the endpoint, and reqwest's would
                // repeat it with the whole settings query string attached.
                source: source.without_url(),
            })?;

        Ok(response)
    }

    /// Run a metadata query and deserialise each row into `T`.
    pub async fn rows<T: DeserializeOwned>(&self, sql: &str) -> Result<Vec<T>> {
        self.rows_with(sql, QueryOptions::internal()).await
    }

    pub async fn rows_with<T: DeserializeOwned>(
        &self,
        sql: &str,
        opts: QueryOptions,
    ) -> Result<Vec<T>> {
        let (body, _) = self.send(sql, FORMAT_EACH_ROW, &opts).await?;
        body.lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                serde_json::from_str::<T>(line)
                    .map_err(|e| Error::decode("unexpected shape in a ClickHouse metadata row", e))
            })
            .collect()
    }

    /// Run a statement whose output we do not need — DDL, or an INSERT.
    pub async fn execute(&self, sql: &str, opts: QueryOptions) -> Result<()> {
        self.send(sql, FORMAT_EACH_ROW, &opts).await?;
        Ok(())
    }

    /// Run a metadata query expected to produce at most one row.
    pub async fn row<T: DeserializeOwned>(&self, sql: &str) -> Result<Option<T>> {
        Ok(self.rows::<T>(sql).await?.into_iter().next())
    }

    pub async fn row_with<T: DeserializeOwned>(
        &self,
        sql: &str,
        opts: QueryOptions,
    ) -> Result<Option<T>> {
        Ok(self.rows_with::<T>(sql, opts).await?.into_iter().next())
    }

    /// Run a user-authored statement and return it in grid shape.
    pub async fn table(&self, sql: &str, opts: QueryOptions) -> Result<TableResult> {
        let query_id = opts
            .query_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let cap = opts.max_rows.unwrap_or(self.max_result_rows);

        let opts = QueryOptions {
            query_id: Some(query_id.clone()),
            quote_64bit_integers: true,
            ..opts
        };
        let (body, summary) = self.send(sql, FORMAT_COMPACT, &opts).await?;

        // DDL, INSERT and friends answer with an empty body.
        if body.trim().is_empty() {
            return Ok(TableResult {
                query_id,
                columns: Vec::new(),
                rows: Vec::new(),
                truncated: false,
                rows_before_limit_at_least: None,
                statistics: Statistics {
                    elapsed: summary.elapsed_ns as f64 / 1e9,
                    rows_read: summary.read_rows,
                    bytes_read: summary.read_bytes,
                },
                summary,
                kind: "command",
            });
        }

        let parsed: JsonCompactBody = serde_json::from_str(&body).map_err(|e| {
            Error::decode(
                "ClickHouse did not answer in JSONCompact — does the statement carry \
                 its own FORMAT clause?",
                e,
            )
        })?;

        let stats = parsed.statistics.unwrap_or(JsonCompactStats {
            elapsed: summary.elapsed_ns as f64 / 1e9,
            rows_read: summary.read_rows,
            bytes_read: summary.read_bytes,
        });

        // We asked for cap + 1 rows, so anything beyond the cap proves there
        // is more to fetch. Trim before handing it on: the browser must never
        // receive more rows than the operator allowed.
        let mut rows = parsed.data;
        let truncated = cap > 0 && rows.len() as u64 > cap;
        if truncated {
            rows.truncate(cap as usize);
        }

        Ok(TableResult {
            query_id,
            columns: parsed
                .meta
                .into_iter()
                .map(|c| ColumnMeta {
                    name: c.name,
                    r#type: c.r#type,
                })
                .collect(),
            truncated,
            rows,
            rows_before_limit_at_least: parsed.rows_before_limit_at_least,
            statistics: Statistics {
                elapsed: stats.elapsed,
                rows_read: stats.rows_read,
                bytes_read: stats.bytes_read,
            },
            summary,
            kind: "read",
        })
    }

    /// Ask ClickHouse to stop a running query. `ASYNC` returns immediately —
    /// the in-flight request fails on its own with QUERY_WAS_CANCELLED.
    pub async fn cancel(&self, query_id: &str) -> Result<()> {
        let sql = "KILL QUERY WHERE query_id = {id:String} ASYNC";
        self.send(
            sql,
            FORMAT_EACH_ROW,
            &QueryOptions {
                params: vec![("id".into(), query_id.to_string())],
                // KILL is a write as far as readonly=2 is concerned, but the
                // caller may only ever kill a query id we handed them.
                allow_write: true,
                ..QueryOptions::internal()
            },
        )
        .await?;
        Ok(())
    }

    /// Columns present on `system.<table>` for this server.
    pub async fn system_columns(&self, table: &str) -> Result<HashSet<String>> {
        let key = (self.url.clone(), self.user.clone(), table.to_string());
        if let Some(cached) = self.system_columns.read().await.get(&key) {
            return Ok(cached.clone());
        }

        #[derive(Deserialize)]
        struct Row {
            name: String,
        }
        let rows: Vec<Row> = self
            .rows_with(
                "SELECT name FROM system.columns \
                 WHERE database = 'system' AND table = {t:String}",
                QueryOptions {
                    params: vec![("t".into(), table.to_string())],
                    ..QueryOptions::internal()
                },
            )
            .await?;

        let set: HashSet<String> = rows.into_iter().map(|r| r.name).collect();
        // Only cache a *positive* answer. Several system tables are created
        // lazily — `system.query_log` does not exist until the first flush —
        // so remembering "absent" would hide it for the life of the process.
        // A table that exists never loses columns, so caching that is safe.
        if !set.is_empty() {
            self.system_columns.write().await.insert(key, set.clone());
        }
        Ok(set)
    }

    /// `expr` if `system.<table>` has `column` on this server, `fallback`
    /// otherwise. Lets one query text work across ClickHouse versions.
    pub async fn col_or(&self, table: &str, column: &str, fallback: &str) -> Result<String> {
        let cols = self.system_columns(table).await?;
        Ok(if cols.contains(column) {
            column.to_string()
        } else {
            fallback.to_string()
        })
    }

    /// Whether a `system.<table>` exists at all (e.g. `system.projections`
    /// only landed in 24.x, `system.query_log` can be switched off).
    ///
    /// Absence here is not proof: `system.columns` is itself filtered by
    /// grants, so a role that may not read a table cannot see its columns
    /// either. Use [`Client::reach`] when the difference matters to the
    /// reader — telling someone their log is switched off when their role
    /// simply lacks a GRANT sends them to fix the wrong thing.
    pub async fn has_system_table(&self, table: &str) -> Result<bool> {
        Ok(!self.system_columns(table).await?.is_empty())
    }

    /// Why a `system.<table>` cannot be read — asked of the table itself,
    /// which is the only thing that can tell a missing table from a missing
    /// grant. `WHERE 0` so it costs nothing to ask.
    ///
    /// `table` is always a literal in Flint's own source; nothing
    /// user-authored reaches it.
    pub async fn reach(&self, table: &str) -> Result<Reach> {
        #[derive(Deserialize)]
        struct Probe {
            #[allow(dead_code)]
            n: u64,
        }
        let sql = format!("SELECT count() AS n FROM system.{table} WHERE 0");
        match self.row::<Probe>(&sql).await {
            Ok(_) => Ok(Reach::Readable),
            Err(Error::ClickHouse { code: 497, .. }) | Err(Error::ClickHouse { code: 164, .. }) => {
                Ok(Reach::Denied)
            }
            Err(Error::ClickHouse { code: 60, .. }) | Err(Error::ClickHouse { code: 81, .. }) => {
                Ok(Reach::Absent)
            }
            // NO_ELEMENTS_IN_CONFIG: "There is no Zookeeper configuration in
            // server config" — which is what a single-node ClickHouse answers
            // when asked about the cluster it is not part of.
            Err(Error::ClickHouse { code: 139, .. }) => Ok(Reach::Unconfigured),
            Err(e) => Err(e),
        }
    }
}

fn summary_of(response: &reqwest::Response) -> Summary {
    response
        .headers()
        .get("x-clickhouse-summary")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| serde_json::from_str::<Summary>(v).ok())
        .unwrap_or_default()
}

/// Refuse a timezone this server has never heard of.
///
/// Checked against `system.time_zones` rather than against a pattern, and
/// against *this* server's copy of it: the zone is read by ClickHouse when the
/// statement runs, so its list is the one that decides. A name accepted here
/// and unknown there is not a wrong answer — it is a report that fails every
/// morning, or an endpoint that 500s for one caller — and both are found long
/// after the typo.
///
/// The three callers that need this are a report's schedule, a published
/// endpoint's buckets, and a dataset request's own zone. They had no business
/// each carrying their own copy of the rule.
pub async fn check_timezone(ch: &Client, name: &str) -> Result<()> {
    if name.is_empty() {
        return Ok(());
    }

    #[derive(Deserialize)]
    struct Known {
        known: u8,
    }

    let known: Option<Known> = ch
        .row_with(
            "SELECT toUInt8(count()) AS known FROM system.time_zones \
             WHERE time_zone = {tz:String}",
            QueryOptions {
                params: vec![("tz".into(), name.to_string())],
                introspection: true,
                force_readonly: true,
                quote_64bit_integers: false,
                ..Default::default()
            },
        )
        .await?;

    if known.map_or(0, |k| k.known) == 0 {
        return Err(Error::BadRequest(format!(
            "`{name}` is not a timezone this ClickHouse knows — it is what reads the \
             zone, so its list is the one that counts"
        )));
    }
    Ok(())
}

/// What stands between Flint and a `system.*` table.
/// Where an exception stops being the diagnosis and starts being the statement.
///
/// ClickHouse appends the query it failed on, introduced by one of a few
/// phrases — and it does not agree with itself about their case. `In scope`
/// arrives capitalised after a privilege error and lowercase after an unknown
/// table, and a list that only knew the capitalised form handed a published
/// endpoint's own SQL to an anonymous caller. Two readers wanted this rule and
/// each had its own copy of the list; now there is one, and it is
/// case-insensitive.
pub fn statement_starts_at(message: &str) -> usize {
    const MARKERS: [&str; 2] = ["in scope", "while executing"];
    let lowered = message.to_ascii_lowercase();
    MARKERS
        .iter()
        .filter_map(|marker| lowered.find(marker))
        .min()
        .unwrap_or(message.len())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    Readable,
    /// The role may not see it. A GRANT fixes this.
    Denied,
    /// This server does not have it — an old version, or a log switched off.
    /// A configuration change fixes this.
    Absent,
    /// The table is there and the server cannot fill it, because the feature it
    /// reports on is not configured. Distinct from `Absent` on purpose: telling
    /// somebody their ClickHouse is too old to have a distributed DDL queue,
    /// when in fact it has no Keeper and therefore no cluster, sends them to
    /// upgrade a server that did not need upgrading.
    Unconfigured,
}

/// A list that may be missing for a reason, rather than missing because there
/// is nothing.
///
/// Shared because more than one screen is assembled from several privileged
/// reads that can each be refused on its own — a role granted `SHOW QUOTAS` is
/// not thereby granted `SHOW ROW POLICIES`, and a role that may read
/// `system.settings` need not be allowed `system.server_settings`. A section
/// that is empty because nobody may read it must not look like a section that
/// is empty because there is nothing in it.
#[derive(Debug, Clone, Serialize)]
pub struct Section<T> {
    pub items: Vec<T>,
    /// Absent when the list is the truth. Present when it is empty because
    /// something stopped Flint reading it, and says which.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
}

impl<T> Section<T> {
    pub fn of(items: Vec<T>) -> Self {
        Self {
            items,
            blocked: None,
        }
    }

    pub fn blocked(reason: String) -> Self {
        Self {
            items: Vec::new(),
            blocked: Some(reason),
        }
    }
}

/// An HTTP client carrying Flint's own trust store.
///
/// Every reqwest client in the process has to go through here. reqwest's rustls
/// backend initialises TLS when the client is *built*, whatever scheme the
/// request will use, so a builder that skips this fails with "No CA
/// certificates were loaded from the system" even for a plain-HTTP call to
/// localhost — which is exactly how the health check broke.
pub fn http_client(
    extra_ca: Option<&std::path::Path>,
    timeout: std::time::Duration,
) -> Result<reqwest::Client> {
    client_builder(extra_ca, timeout)?
        .build()
        .map_err(|e| Error::Decode(format!("could not build the HTTP client: {}", chain(&e))))
}

/// The client alerts POST with.
///
/// Same trust store, one difference: redirects are not followed. A webhook has
/// no reason to redirect, and following one would let the address someone typed
/// into an alert hand Flint off to a different host — quietly widening where
/// query results end up.
pub fn webhook_client(
    extra_ca: Option<&std::path::Path>,
    timeout: std::time::Duration,
) -> Result<reqwest::Client> {
    client_builder(extra_ca, timeout)?
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| Error::Decode(format!("could not build the webhook client: {}", chain(&e))))
}

fn client_builder(
    extra_ca: Option<&std::path::Path>,
    timeout: std::time::Duration,
) -> Result<reqwest::ClientBuilder> {
    Ok(reqwest::Client::builder()
        .tls_backend_preconfigured(tls_config(extra_ca)?)
        .timeout(timeout)
        .connect_timeout(std::time::Duration::from_secs(10)))
}

/// A rustls config that trusts the bundled web PKI, plus any private CA the
/// operator pointed us at. The crypto provider is named explicitly rather than
/// installed as a process default, because both `ring` and `aws-lc-rs` reach
/// us through transitive dependencies and rustls refuses to pick between them.
fn tls_config(extra_ca: Option<&std::path::Path>) -> Result<rustls::ClientConfig> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

    if let Some(path) = extra_ca {
        let pem = std::fs::read(path)
            .map_err(|e| Error::BadRequest(format!("could not read {}: {e}", path.display())))?;
        let mut cursor = std::io::Cursor::new(pem);
        let certs = rustls_pemfile::certs(&mut cursor)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| {
                Error::BadRequest(format!(
                    "{} is not a PEM certificate bundle: {e}",
                    path.display()
                ))
            })?;
        if certs.is_empty() {
            return Err(Error::BadRequest(format!(
                "{} contains no certificates",
                path.display()
            )));
        }
        let added = certs.len();
        for cert in certs {
            roots.add(cert).map_err(|e| {
                Error::BadRequest(format!(
                    "rejected a certificate from {}: {e}",
                    path.display()
                ))
            })?;
        }
        tracing::info!(
            "trusting {added} extra CA certificate(s) from {}",
            path.display()
        );
    }

    let provider = std::sync::Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(rustls::DEFAULT_VERSIONS)
        .map_err(|e| Error::Decode(format!("could not configure TLS: {e}")))
        .map(|builder| builder.with_root_certificates(roots).with_no_client_auth())
}

/// Flatten an error and everything under it. reqwest's top-level messages are
/// often just "builder error"; the cause is one or two levels down.
fn chain(err: &dyn std::error::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = err.source();
    while let Some(e) = source {
        parts.push(e.to_string());
        source = e.source();
    }
    parts.join(": ")
}

/// Pull the code and message out of a ClickHouse exception body, which looks
/// like `Code: 60. DB::Exception: Table x.y does not exist. (UNKNOWN_TABLE)`.
/// Whether the thing that answered says it is ClickHouse.
///
/// Every ClickHouse HTTP response carries at least one `X-ClickHouse-*` header —
/// the query id, the summary, the server's display name, the exception code. So
/// the *absence of all of them* is the signal, and it is only ever used to
/// reclassify a failure: a reverse proxy that strips the headers off a working
/// server must not be told it is not ClickHouse, which is why no successful,
/// parseable answer is ever refused on this evidence.
fn vouches_for_clickhouse(response: &reqwest::Response) -> bool {
    response
        .headers()
        .keys()
        .any(|name| name.as_str().starts_with("x-clickhouse-"))
}

/// Whether a body opens the way the JSON formats Flint asks for do.
fn opens_json(body: &str) -> bool {
    matches!(
        body.trim_start().as_bytes().first(),
        Some(b'{') | Some(b'[')
    )
}

/// What answered, and how Flint can tell it was not ClickHouse.
///
/// Says how it knows rather than only what it concluded, because the conclusion
/// is a guess about somebody else's server and the evidence should be checkable.
/// And it names the interface Flint wants: the commonest way to arrive here is a
/// port that belongs to something else.
///
/// **What the answer does not carry is the body.** It used to quote the opening
/// line, which is genuinely the most useful sentence for whoever typed the
/// address — and on an unpinned Flint that sentence is handed to anybody who can
/// reach this port, *before* they have signed in to anything. That turns the
/// error into a fingerprinting oracle: not merely "something is listening on
/// 9100" but "and it answers with XML". The status they would learn anyway; the
/// line they would not, so it goes to the log, where the operator who needs it is
/// and a scanner is not.
fn not_clickhouse(url: &str, status: reqwest::StatusCode, body: &str) -> Error {
    // One line, capped. The body is an HTML page or an XML fault as often as
    // not, and a screenful of somebody else's markup in a log line buries the
    // entry that explains it.
    let opening: String = body
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("nothing")
        .chars()
        .filter(|c| !c.is_control())
        .take(60)
        .collect();
    tracing::warn!(
        %url,
        status = status.as_u16(),
        "what answered is not ClickHouse — no X-ClickHouse-* header, opening `{opening}`"
    );
    Error::NotClickHouse {
        url: url.to_string(),
        detail: format!(
            "it answered {} and sent no ClickHouse headers. Flint speaks to ClickHouse's HTTP \
             interface, which is on 8123 by default; the opening line of what did answer is in \
             Flint's log.",
            status.as_u16()
        ),
    }
}

fn parse_exception(body: &str) -> Error {
    let body = body.trim();

    // ClickHouse does not always make the exception the whole body. With
    // `http_write_exception_in_output_format` — which `compatibility` below 24.9
    // turns on, and which is therefore live on any server asked to behave like
    // an older one — it writes the error *inside* the response, as a field of
    // otherwise valid JSON. A parser that looks for `Code: ` at the start of the
    // body then finds nothing, reports code 0, and takes the JSON tail along
    // with the message.
    //
    // That is not a cosmetic loss. `Reach` classifies by code: 497 is a missing
    // grant, 60 a missing table, 139 an unconfigured Keeper. At code 0 it can
    // say none of those, so every "this user needs SHOW QUOTAS" and "this
    // server has no system.text_log" on every page became one opaque 500 — on
    // exactly the servers the configuration page exists to warn about.
    let unwrapped = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("exception")?.as_str().map(str::to_string));
    let body = unwrapped.as_deref().unwrap_or(body).trim();

    // Found rather than stripped from the front, because a format that streams
    // its output appends the exception after whatever it had already written.
    // Flint sets `wait_end_of_query=1` on everything it sends, so it should
    // never see a partial body — "should never" being the reason to read it
    // this way rather than to rely on it.
    let code = body
        .find("Code: ")
        .map(|at| &body[at + "Code: ".len()..])
        .and_then(|rest| {
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<i32>().ok()
        })
        .unwrap_or(0);

    // Everything after `DB::Exception: ` is the human-readable part.
    let message = body
        .split_once("DB::Exception: ")
        .map(|(_, rest)| rest)
        .unwrap_or(body)
        .trim()
        .to_string();

    Error::ClickHouse {
        code,
        message: if message.is_empty() {
            "ClickHouse returned an error with no message".into()
        } else {
            message
        },
    }
}

#[cfg(test)]
mod peer_tests {
    use super::*;

    #[test]
    fn a_json_body_is_recognised_however_it_is_padded() {
        assert!(opens_json("{\"a\":1}"));
        assert!(opens_json("  \n[{\"a\":1}]"));
        // What an HTTP server that is not ClickHouse answers with, which is the
        // whole reason this function exists.
        assert!(!opens_json("<!DOCTYPE HTML>\n<html>"));
        assert!(!opens_json("<?xml version=\"1.0\"?><Error/>"));
        assert!(!opens_json("Code: 60. DB::Exception: ..."));
        assert!(!opens_json(""));
    }

    #[test]
    fn the_message_says_how_it_knows_and_what_was_wanted() {
        let e = not_clickhouse(
            "http://127.0.0.1:9099",
            reqwest::StatusCode::OK,
            "\n  <!DOCTYPE HTML>\n<html lang=\"en\">\n",
        );
        let said = e.to_string();
        // The address, because an unpinned Flint has no other record of it.
        assert!(said.contains("http://127.0.0.1:9099"), "{said}");
        // The evidence, which is checkable, rather than only the conclusion.
        assert!(said.contains("no ClickHouse headers"), "{said}");
        // And where ClickHouse actually listens, because a wrong port is how
        // most people arrive here.
        assert!(said.contains("8123"), "{said}");
        // But *not* what the stranger said. This message is read before anybody
        // has signed in, so quoting the body would tell a scanner what is on a
        // port as well as that something is — the difference between a status,
        // which it would learn anyway, and a fingerprint. It goes to the log,
        // and the message says so.
        assert!(
            !said.contains("<!DOCTYPE"),
            "the peer's body is in the answer: {said}"
        );
        assert!(said.contains("log"), "{said}");
    }

    #[test]
    fn a_body_of_markup_never_reaches_the_answer() {
        // In full it buries the sentence explaining it — and worse, hands a
        // caller who has signed in to nothing a fingerprint of the port.
        let long = format!("<html>{}</html>", "x".repeat(500));
        let said = not_clickhouse("http://x", reqwest::StatusCode::BAD_REQUEST, &long).to_string();
        assert!(said.len() < 300, "{} chars: {said}", said.len());
        assert!(said.contains("it answered 400"), "{said}");
        assert!(!said.contains("xxx"), "the body reached the answer: {said}");
    }

    #[test]
    fn a_body_of_nothing_still_names_the_address() {
        let said =
            not_clickhouse("http://x:9100", reqwest::StatusCode::FORBIDDEN, "   ").to_string();
        assert!(said.contains("http://x:9100"), "{said}");
        assert!(said.contains("it answered 403"), "{said}");
    }

    #[test]
    fn it_reads_as_the_peer_being_at_fault() {
        // 502, beside a transport failure — not 500, which would read as Flint
        // having broken, and not 400, which would send somebody to rephrase a
        // request that was fine.
        let e = not_clickhouse("http://x", reqwest::StatusCode::OK, "<html>");
        assert_eq!(e.http_status(), 502);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_code_and_message_from_an_exception() {
        let err = parse_exception(
            "Code: 60. DB::Exception: Table foo.bar does not exist. (UNKNOWN_TABLE) (version 24.3)",
        );
        match err {
            Error::ClickHouse { code, message } => {
                assert_eq!(code, 60);
                assert!(message.starts_with("Table foo.bar does not exist."));
            }
            other => panic!("expected a ClickHouse error, got {other:?}"),
        }
    }

    #[test]
    fn reads_an_exception_the_server_put_inside_the_body() {
        // `compatibility` below 24.9 turns on
        // `http_write_exception_in_output_format`, and the error arrives as a
        // field of valid JSON instead of as the whole body. Found by pointing
        // Flint at an account whose profile set `compatibility = '24.8'`: every
        // refusal came back as code 0 with the JSON tail glued to the message,
        // which cost `Reach` the difference between a missing grant and a
        // missing table on every page.
        let body = r#"{
	"meta": [],
	"data": [],
	"rows": 0,
	"exception": "Code: 497. DB::Exception: probe_old: Not enough privileges. To execute this query, it's necessary to have the grant SELECT for at least one column on system.server_settings. (ACCESS_DENIED) (version 26.7.5.10 (official build))"
}"#;
        match parse_exception(body) {
            Error::ClickHouse { code, message } => {
                assert_eq!(code, 497);
                assert!(message.starts_with("probe_old: Not enough privileges."));
                // And without the JSON that carried it.
                assert!(!message.contains("\"}"), "the tail came along: {message}");
                assert!(message.ends_with("(official build))"));
            }
            other => panic!("expected a ClickHouse error, got {other:?}"),
        }
    }

    #[test]
    fn reads_an_exception_appended_after_output() {
        // A streaming format writes what it had before it failed. Flint sets
        // `wait_end_of_query=1` so it should never see this, which is the reason
        // to read the body this way rather than to depend on it.
        match parse_exception("some\tpartial\trows\nCode: 241. DB::Exception: Memory limit exceeded. (MEMORY_LIMIT_EXCEEDED)") {
            Error::ClickHouse { code, .. } => assert_eq!(code, 241),
            other => panic!("expected a ClickHouse error, got {other:?}"),
        }
    }

    #[test]
    fn falls_back_when_the_body_is_not_an_exception() {
        match parse_exception("upstream connect error") {
            Error::ClickHouse { code, message } => {
                assert_eq!(code, 0);
                assert_eq!(message, "upstream connect error");
            }
            other => panic!("expected a ClickHouse error, got {other:?}"),
        }
    }

    #[test]
    fn summary_counters_survive_being_strings() {
        let s: Summary =
            serde_json::from_str(r#"{"read_rows":"42","read_bytes":"1024","elapsed_ns":7}"#)
                .expect("summary should parse");
        assert_eq!(s.read_rows, 42);
        assert_eq!(s.read_bytes, 1024);
        assert_eq!(s.elapsed_ns, 7);
        assert_eq!(s.written_rows, 0);
    }
}
