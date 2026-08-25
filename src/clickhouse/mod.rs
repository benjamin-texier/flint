pub mod access;
pub mod diagnostics;
pub mod graph;
pub mod meta;
pub mod pipelines;
pub mod profile;

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
    /// Which columns each `system.*` table actually has on *this* server.
    /// ClickHouse adds columns to its system tables over time, so we probe
    /// once and degrade gracefully instead of failing on older versions.
    system_columns: Arc<RwLock<HashMap<String, HashSet<String>>>>,
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
            url: config.clickhouse_url.trim_end_matches('/').to_string(),
            user: config.clickhouse_user.clone(),
            password: config.clickhouse_password.clone(),
            readonly: config.readonly,
            max_result_rows: config.max_result_rows,
            timeout_secs: config.query_timeout_secs,
            system_columns: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    /// Send `sql` and hand back the raw response body plus the summary.
    async fn send(
        &self,
        sql: &str,
        format: &str,
        opts: &QueryOptions,
    ) -> Result<(String, Summary)> {
        let mut params: Vec<(String, String)> = vec![
            ("default_format".into(), format.into()),
            ("wait_end_of_query".into(), "1".into()),
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
        if let Some(id) = &opts.query_id {
            params.push(("query_id".into(), id.clone()));
        }
        for (name, value) in &opts.params {
            params.push((format!("param_{name}"), value.clone()));
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

        let status = response.status();
        let summary = response
            .headers()
            .get("x-clickhouse-summary")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| serde_json::from_str::<Summary>(v).ok())
            .unwrap_or_default();

        let body = response.text().await.map_err(|source| Error::Transport {
            url: self.url.clone(),
            source: source.without_url(),
        })?;

        if !status.is_success() {
            return Err(parse_exception(&body));
        }
        Ok((body, summary))
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
        if let Some(cached) = self.system_columns.read().await.get(table) {
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
            self.system_columns
                .write()
                .await
                .insert(table.to_string(), set.clone());
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
            Err(e) => Err(e),
        }
    }
}

/// What stands between Flint and a `system.*` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    Readable,
    /// The role may not see it. A GRANT fixes this.
    Denied,
    /// This server does not have it — an old version, or a log switched off.
    /// A configuration change fixes this.
    Absent,
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
fn parse_exception(body: &str) -> Error {
    let body = body.trim();
    let code = body
        .strip_prefix("Code: ")
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
