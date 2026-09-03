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
use crate::published::contract::Contract;
use crate::published::usage::{CallerUsage, KeyUsage, RefusalUsage, SlugUsage};

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
    /// Which of the two spaces lists this alert, by what its SQL reads.
    ///
    /// Filled in when the list is built rather than stored: the answer depends
    /// on the tables the statement resolves to *now*, and a table can be dropped
    /// or a database renamed long after the alert was written. Empty where it
    /// could not be asked.
    #[serde(default)]
    pub space: String,
    /// Why the space is what it is, in the reader's terms. Also where a broken
    /// alert says so: a statement whose tables no longer resolve cannot be
    /// placed, and that is worth seeing in the list.
    #[serde(default)]
    pub space_note: String,
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
    /// What is stored: a hash, or — on a workspace written before hashing — a
    /// token in clear. Never serialised: this is read from ClickHouse and
    /// compared here, and a field that went out on the wire would put a live
    /// credential in every list the page fetches.
    #[serde(skip_serializing)]
    pub token: String,
    pub public: bool,
    pub enabled: bool,
    pub max_rows: u32,
    #[serde(alias = "created")]
    pub created_at: String,
    #[serde(alias = "updated")]
    pub updated_at: String,
    /// When this endpoint stops answering. Empty means never — a token pasted
    /// into a spreadsheet formula otherwise outlives the person who pasted it.
    #[serde(default)]
    pub expires_at: String,
    /// The role a call assumes, or empty for the account in the manifest.
    ///
    /// A role and never an account: a token that resolved to stored ClickHouse
    /// credentials would make Flint a secret store. This names something the
    /// server already knows about, and the server decides what it may read.
    #[serde(default)]
    pub run_as: String,
    /// Whether the stored token is hashed. False means this endpoint predates
    /// hashing and its token is sitting in the workspace in clear — which the
    /// page says out loud, because the fix is one rotation and nobody would
    /// otherwise know to make it.
    #[serde(default)]
    pub token_hashed: bool,
    /// The zone this endpoint's day boundaries fall in, or empty for the
    /// server's own.
    ///
    /// The endpoint's, never the caller's. A published address is a contract:
    /// two callers asking the same URL on the same afternoon have to be shown
    /// the same days, or "revenue on the 3rd" is a different figure depending
    /// on who is asking and neither of them can tell. So this is stated in the
    /// OpenAPI document and fixed for everyone — which is the opposite of the
    /// dataset API, where the caller writes the question and may name the zone
    /// in it.
    #[serde(default)]
    pub timezone: String,
    /// The contract revision a caller pins with `?v=`. Never zero on the wire:
    /// a row written before revisions existed reads back as 1, because it is
    /// the first revision — it simply had no number while it was the only one.
    #[serde(default)]
    pub revision: u32,
    /// `draft`, `live`, `retiring` or `retired`. A row written before states
    /// existed reads back as `live`, which is what it has been doing.
    #[serde(default)]
    pub state: String,
    /// The sentence a caller reads before writing the call.
    #[serde(default)]
    pub description: String,
    /// Seconds an answer may be served from memory; 0 is no cache.
    #[serde(default)]
    pub cache_ttl: u32,
    /// The promises this revision makes, as JSON — see `published::contract`.
    /// Empty is a revision that promises only what its placeholders say.
    #[serde(default)]
    pub contract: String,
    /// Who published it. Free text, and empty wherever Flint had no name to
    /// put there.
    #[serde(default)]
    pub published_by: String,
    /// The question as a document, for the endpoint that was published from
    /// the Builder rather than typed. Empty is a statement-backed endpoint,
    /// which is every endpoint made before this field existed.
    ///
    /// This is the source of truth for such an endpoint: `sql` beside it is a
    /// record of what the document last rendered to, kept because a person
    /// reading the page needs to see what will run. The statement that
    /// actually runs is rendered on the call — see `published::document`.
    #[serde(default)]
    pub document: String,
    /// The values the document's statement binds, as a JSON object. Empty for
    /// a statement somebody typed, whose values are its caller's to supply.
    #[serde(default)]
    pub bindings: String,
}

/// Where a revision sits in its life. One way, and the order is the order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Reachable at no address. The point of a draft is that its parameters
    /// and its columns can be reviewed before anything outside can reach it.
    Draft,
    /// What a bare address resolves to. Exactly one per slug.
    Live,
    /// Still answering, and on notice. A caller pinned to it keeps working —
    /// Flint will not delete a revision while it is being called — but the
    /// page says who is still calling so somebody can go and talk to them.
    Retiring,
    /// Answers exactly as an address that never existed. Kept as a row so the
    /// number is not handed out twice.
    Retired,
}

impl State {
    pub fn parse(raw: &str) -> State {
        match raw {
            "draft" => State::Draft,
            "retiring" => State::Retiring,
            "retired" => State::Retired,
            // Including the empty string, which is every row written before
            // this column existed: they have been live all along.
            _ => State::Live,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            State::Draft => "draft",
            State::Live => "live",
            State::Retiring => "retiring",
            State::Retired => "retired",
        }
    }

    /// Whether a call may reach it at all.
    pub fn answers(self) -> bool {
        matches!(self, State::Live | State::Retiring)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PublishedSaved {
    pub endpoints: Vec<Published>,
    /// Present only where a token was just created, and never again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minted: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PublishedInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub slug: String,
    /// Absent for an endpoint published from the Builder: the handler renders
    /// its document into this field before the row is written, so what is
    /// stored is always a statement a person can read.
    #[serde(default)]
    pub sql: String,
    #[serde(default)]
    pub database: String,
    #[serde(default = "empty_object")]
    pub defaults: String,
    /// Absent keeps the existing token, or mints one for a new endpoint.
    #[serde(default)]
    pub token: Option<String>,
    /// Mint a fresh token even on an edit, and hand it back once.
    ///
    /// Explicit, because it cannot be inferred any more: a token is hashed at
    /// rest, so "the field came back empty" is what *every* edit looks like
    /// now, and treating that as a rotation would silently break every caller
    /// of an endpoint whose name somebody fixed.
    #[serde(default)]
    pub rotate: bool,
    #[serde(default)]
    pub public: bool,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default = "thousand")]
    pub max_rows: u32,
    /// `2026-12-31 23:59:59`, or empty for an endpoint that does not expire.
    #[serde(default)]
    pub expires_at: String,
    /// A role the call assumes. Empty runs it as the manifest account, which is
    /// what every endpoint did before this field existed.
    #[serde(default)]
    pub run_as: String,
    /// The zone this endpoint's day boundaries fall in.
    ///
    /// An `Option` where its neighbours are plain strings, and deliberately:
    /// absent keeps what was there, `""` is a deliberate choice of the
    /// server's own zone. `run_as` and `expires_at` spell both of those the
    /// same way and so cannot be cleared once set — a wart worth not
    /// repeating, since "back to the server's zone" is a thing somebody will
    /// want on the second afternoon.
    #[serde(default)]
    pub timezone: Option<String>,
    /// The sentence a caller reads. Absent keeps what was there.
    #[serde(default)]
    pub description: Option<String>,
    /// Seconds an answer may be served from memory. Absent keeps.
    #[serde(default)]
    pub cache_ttl: Option<u32>,
    /// The revision's promises, as JSON. Absent keeps; `""` is a deliberate
    /// return to promising only what the placeholders say.
    #[serde(default)]
    pub contract: Option<String>,
    /// Where a *new* endpoint starts its life. Ignored on an edit, where the
    /// state is moved by `set_state` and nothing else — a form that could
    /// retire an endpoint by posting a field is a form that will.
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub published_by: Option<String>,
    /// The question as a document. Absent keeps what was there; `""` is a
    /// deliberate return to a statement somebody typed.
    #[serde(default)]
    pub document: Option<String>,
    /// What that document's statement binds. Never posted by a browser: the
    /// handler renders the document and fills this in, because a caller who
    /// could send both could send a statement that asks one thing and a
    /// document that reads as another.
    #[serde(skip_deserializing)]
    pub bindings: Option<String>,
}

/// A key as ClickHouse hands it back: `scope` is a JSON string in the column
/// and a list everywhere else, and this is the one place that knows both.
#[derive(Debug, Clone, Deserialize)]
struct ApiKeyRow {
    id: String,
    name: String,
    owner: String,
    hash: String,
    scope: String,
    quota_per_day: u32,
    enabled: bool,
    created_at: String,
}

impl ApiKeyRow {
    fn into_key(self) -> ApiKey {
        ApiKey {
            id: self.id,
            name: self.name,
            owner: self.owner,
            hash: self.hash,
            // An unreadable scope is an empty one, which is the *widest*
            // reading — so it is logged rather than shrugged at, because the
            // safe failure here would be to lock the key out of everything and
            // that is not what an operator would expect from a display bug.
            scope: serde_json::from_str(&self.scope).unwrap_or_default(),
            quota_per_day: self.quota_per_day,
            enabled: self.enabled,
            created_at: self.created_at,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct PublishTablesInput {
    pub database: String,
    pub tables: Vec<String>,
    #[serde(default)]
    pub public: bool,
    #[serde(default = "thousand")]
    pub max_rows: u32,
    /// `draft` or `live`. Draft is the default and the recommendation: fifteen
    /// addresses answering the moment somebody clicked once is a lot of surface
    /// to have appeared without anybody reading it.
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub cache_ttl: u32,
    /// Put in front of every address, for the deployment that wants
    /// `partner_orders` rather than `orders`.
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub published_by: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublishedTable {
    pub table: String,
    pub slug: String,
    /// The token, where one was minted — readable here and never again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minted: Option<String>,
}

/// A table that was asked for and not published, with the reason.
///
/// A count alone would send somebody comparing two lists by hand.
#[derive(Debug, Clone, Serialize)]
pub struct SkippedTable {
    pub table: String,
    pub why: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TablesPublished {
    pub endpoints: Vec<Published>,
    pub published: Vec<PublishedTable>,
    pub skipped: Vec<SkippedTable>,
}

/// The columns of a sorting key, as names.
///
/// ClickHouse writes it as an expression list — `toYYYYMM(at), device_id` — and
/// only the bare column names are usable as a sort a caller can name. An
/// expression is dropped rather than offered: `?order=toYYYYMM(at)` is not a
/// column the shape layer will accept, and offering it would be offering a
/// refusal.
fn sorting_columns(key: &str) -> Vec<String> {
    key.split(',')
        .map(str::trim)
        .filter(|part| {
            !part.is_empty()
                && part.chars().all(|c| c.is_alphanumeric() || c == '_')
                && !part.starts_with(|c: char| c.is_ascii_digit())
        })
        .map(str::to_string)
        .collect()
}

/// A key: one caller, named, with its own quota.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKey {
    pub id: String,
    pub name: String,
    pub owner: String,
    /// Never serialised, for the same reason an endpoint's token is not: this
    /// is read from ClickHouse and compared here, and a field that went out on
    /// the wire would put a credential in every list the page fetches.
    #[serde(skip_serializing)]
    pub hash: String,
    /// The addresses this key may call. Empty is every one of them.
    #[serde(default)]
    pub scope: Vec<String>,
    /// Calls per day, per endpoint. 0 is no limit.
    pub quota_per_day: u32,
    pub enabled: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ApiKeyInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub scope: Vec<String>,
    #[serde(default)]
    pub quota_per_day: u32,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Mint a fresh secret and hand it back once.
    #[serde(default)]
    pub rotate: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApiKeySaved {
    pub keys: Vec<ApiKey>,
    /// Present only where a secret was just created, and never again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minted: Option<String>,
}

/// One address's traffic, as the four panels of the detail page need it.
#[derive(Debug, Clone)]
pub struct Traffic {
    pub calls: u64,
    pub failures: u64,
    pub hits: u64,
    pub misses: u64,
    pub avg_hit_ms: Option<f64>,
    pub avg_miss_ms: Option<f64>,
    pub keys: Vec<KeyUsage>,
    pub callers: Vec<CallerUsage>,
    pub refusals: Vec<RefusalUsage>,
}

/// One call, as it happened. Written after the answer has gone out, so
/// recording it can never be the thing that makes a call fail.
#[derive(Debug, Clone)]
pub struct CallRecord {
    /// When the call happened, on this process's monotonic clock.
    ///
    /// Only ever used as an *age*: the insert asks ClickHouse for `now64(3)`
    /// and subtracts it. That keeps every timestamp in the workspace on one
    /// clock — ClickHouse's — which matters because `calls_today` compares
    /// these against `toStartOfDay(now64(3))`, and two clocks meeting in one
    /// comparison is the failure `expiry_passed` exists to avoid. Stamping the
    /// wall clock here instead would put a sidecar's drift into a quota
    /// boundary, where nobody would think to look for it.
    ///
    /// It cannot simply be `now64(3)` for the whole batch either: calls are
    /// held for a few seconds, and a panel plotting the write time would show
    /// a flat line with a spike at every flush.
    pub at: std::time::Instant,
    pub slug: String,
    pub revision: u32,
    pub key_id: String,
    pub key_name: String,
    pub label: String,
    pub status: u16,
    pub reason: String,
    pub ms: u32,
    pub cached: bool,
    pub read_rows: u64,
    pub read_bytes: u64,
}

impl Default for CallRecord {
    fn default() -> CallRecord {
        CallRecord {
            // A record made now happened now. Every field but this one has a
            // meaningful zero; a moment does not.
            at: std::time::Instant::now(),
            slug: String::new(),
            revision: 0,
            key_id: String::new(),
            key_name: String::new(),
            label: String::new(),
            status: 0,
            reason: String::new(),
            ms: 0,
            cached: false,
            read_rows: 0,
            read_bytes: 0,
        }
    }
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
    /// The zone its wall clock is read in. Empty means the server's own, which
    /// is what every report made before this field meant — and what an interval
    /// schedule means regardless, since `Every { hours }` has no opinion about
    /// when a day starts.
    #[serde(default)]
    pub timezone: String,
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
    /// Empty keeps the server's zone.
    #[serde(default)]
    pub timezone: String,
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
    /// The server Flint's own tables live on.
    ///
    /// Held here rather than passed in at each call, and that is the whole
    /// point of the field. Once the workspace can be on a *different* server
    /// from the one being explored, "which client does this go to" stops being
    /// obvious at the call site — and there are eighty-odd of them. A handler
    /// that reaches for the client it already has in scope would write Flint's
    /// bookkeeping into somebody's production and read it back empty, with
    /// nothing failing loudly enough to notice.
    ///
    /// So the choice is made once, where the workspace is built, and no caller
    /// is offered the chance to make it again. The single method that genuinely
    /// needs the other server — [`Workspace::delegation_check`] — asks for it by
    /// name in its signature.
    ch: Client,
    /// Whether the schema has been created in this process. Bootstrapping is
    /// idempotent, so this is only an optimisation — but it also means a
    /// ClickHouse that was not up at startup gets another chance on first use.
    ready: Arc<RwLock<bool>>,
}

impl Workspace {
    pub fn new(database: String, ch: Client) -> Self {
        Self {
            database,
            ch,
            ready: Arc::new(RwLock::new(false)),
        }
    }

    /// Where Flint's own tables are, for a log line or an error that has to say
    /// which of the two servers it means.
    pub fn endpoint(&self) -> &str {
        self.ch.endpoint()
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
    pub async fn ensure(&self) -> Result<()> {
        if *self.ready.read().await {
            return Ok(());
        }
        let db = self.quoted();

        self.ch
            .execute(
                &format!("CREATE DATABASE IF NOT EXISTS {db}"),
                self.write_opts(),
            )
            .await
            .map_err(|e| self.explain(e))?;

        self.ch
            .execute(
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

        self.ch
            .execute(
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

        self.ch
            .execute(
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
        self.ch
            .execute(
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

        self.ch
            .execute(
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
                    version    UInt64, \
                    /* Added after this table first shipped — see the ALTERs at \
                       the end of `ensure`. Empty means the server's own zone, \
                       which is what every report made before this meant. */ \
                    timezone   String \
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
        self.ch
            .execute(
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

        self.ch
            .execute(
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
                    version    UInt64, \
                    /* Added after this table first shipped, and listed last \
                       because that is where `ALTER ... ADD COLUMN` puts them \
                       on an install that predates them — see the end of \
                       `ensure`. Epoch means no expiry, which is how ClickHouse \
                       says it elsewhere; an empty `run_as` means the endpoint \
                       runs as whatever the manifest account is. */ \
                    expires_at DateTime64(3), \
                    run_as     String, \
                    /* The zone this endpoint's day boundaries fall in. Empty \
                       is the server's, which is what every endpoint made \
                       before this field is. */ \
                    timezone   String, \
                    /* A contract revision, and *not* the `version` above — \
                       that one is ReplacingMergeTree's tiebreaker and belongs \
                       to the storage engine. This one belongs to the caller: \
                       it is the number in `?v=`, it appears in the OpenAPI \
                       document, and it is what somebody means when they say \
                       \"we are still on v3\". Several rows can share a slug, \
                       one per revision; `state` decides which of them a bare \
                       address reaches. */ \
                    revision   UInt32, \
                    /* draft | live | retiring | retired. \
                       \
                       Orthogonal to `enabled`, which is a pause: a live \
                       endpoint that is paused answers 404 for as long as \
                       somebody is holding it shut, and comes back live. A \
                       state is where a revision sits in its own life, and it \
                       moves one way. Draft is unreachable at any address — \
                       the point of a draft is to be reviewable before it is \
                       callable. */ \
                    state      LowCardinality(String), \
                    /* The sentence a caller reads before writing the call. \
                       Not a comment on the SQL: an agent or a notebook reads \
                       this and nothing else. */ \
                    description String, \
                    /* Seconds an answer may be served from memory. 0 is no \
                       cache, which is what every endpoint made before this \
                       field is — a figure nobody asked to be stale should \
                       not become stale because a default said so. */ \
                    cache_ttl  UInt32, \
                    /* The promises this revision makes about its parameters \
                       and its columns, as JSON. Empty means the revision \
                       promises only what the statement's placeholders already \
                       say, which is how every endpoint behaved before there \
                       was a contract to break. */ \
                    contract   String, \
                    published_by String, \
                    /* The question, as the Builder's document — empty for the \
                       endpoint that is a statement somebody typed. \
                       \
                       Kept beside the statement rather than instead of it, \
                       because they answer different questions about the same \
                       endpoint: the document is what reopens in the form, and \
                       the statement is what a person reads to see what will \
                       run. A document-backed endpoint renders its statement \
                       on every call, so the one stored here is a record of \
                       what it rendered to and never the thing that runs. */ \
                    document   String, \
                    /* The values the document's statement binds, as a JSON \
                       object. Not defaults: a default is a value a caller may \
                       replace, and these are the question itself — see \
                       `published::bind`. */ \
                    bindings   String \
                 ) \
                 ENGINE = ReplacingMergeTree(version) \
                 ORDER BY id"
                ),
                self.write_opts(),
            )
            .await
            .map_err(|e| self.explain(e))?;

        // ── Keys ────────────────────────────────────────────────────────
        //
        // A key is a caller, not a door. The per-endpoint token this replaced
        // answered one question — may this call happen — and could answer no
        // others: every caller of an endpoint shared one secret, so "who is
        // making 31 thousand of these a day" had no answer, rotating locked
        // out everybody at once, and a quota could only ever be a quota on the
        // endpoint itself.
        //
        // A key is global and scoped to the addresses it may call, rather than
        // owned by one of them, because that is the shape of the thing being
        // named: `app-frontend` is one program, and it calls four endpoints.
        //
        // The secret is hashed on the way in and readable exactly once, for
        // the same reason an endpoint's token is.
        self.ch
            .execute(
                &format!(
                    "CREATE TABLE IF NOT EXISTS {db}.api_keys \
                 ( \
                    id            UUID, \
                    name          String, \
                    /* Who to talk to when it starts misbehaving. Free text: \
                       Flint has no directory, and a name somebody recognises \
                       beats an identifier it could have validated. */ \
                    owner         String, \
                    hash          String, \
                    /* JSON array of slugs. Empty is every endpoint — the \
                       honest spelling of an unscoped key, rather than a list \
                       that silently stops matching when a new endpoint is \
                       published. */ \
                    scope         String, \
                    /* Calls per day, per endpoint. 0 is no limit. */ \
                    quota_per_day UInt32, \
                    enabled       UInt8, \
                    created_at    DateTime64(3), \
                    deleted       UInt8, \
                    version       UInt64 \
                 ) \
                 ENGINE = ReplacingMergeTree(version) \
                 ORDER BY id"
                ),
                self.write_opts(),
            )
            .await
            .map_err(|e| self.explain(e))?;

        // ── The call log ────────────────────────────────────────────────
        //
        // Flint's own, beside `system.query_log` rather than instead of it,
        // and it exists because two of the questions the endpoints page asks
        // are ones the query log cannot answer even in principle.
        //
        // A cache hit never reaches ClickHouse, so a hit rate read from the
        // query log is a hit rate of zero for ever. And a query log row knows
        // the account the statement ran as — which is Flint's, for every
        // endpoint — so it cannot tell `app-frontend` from `agent-support-bot`
        // however carefully it is tagged. A refusal never runs a statement at
        // all, so a 429 and a 403 leave no trace there either.
        //
        // One row per call, refusals included. Thirty days, like the jobs: the
        // page asks about today and this week.
        self.ch
            .execute(
                &format!(
                    "CREATE TABLE IF NOT EXISTS {db}.api_calls \
                 ( \
                    at         DateTime64(3), \
                    slug       LowCardinality(String), \
                    revision   UInt32, \
                    /* Empty for a public endpoint or a legacy token: both are \
                       real ways to call, and attributing them to a key that \
                       does not exist would be worse than admitting the call \
                       is anonymous. */ \
                    key_id     String, \
                    key_name   LowCardinality(String), \
                    /* What the caller says it is doing — `X-Flint-Label`. \
                       Free text from the wire, so it is only ever displayed, \
                       never matched on. */ \
                    label      String, \
                    status     UInt16, \
                    /* Why it was refused, for anything that was. */ \
                    reason     String, \
                    ms         UInt32, \
                    cached     UInt8, \
                    read_rows  UInt64, \
                    read_bytes UInt64 \
                 ) \
                 ENGINE = MergeTree \
                 PARTITION BY toYYYYMM(at) \
                 ORDER BY (slug, at) \
                 TTL toDateTime(at) + INTERVAL 30 DAY"
                ),
                self.write_opts(),
            )
            .await
            .map_err(|e| self.explain(e))?;

        // ── Jobs ────────────────────────────────────────────────────────
        //
        // Work that outlives the request that asked for it. A job is *updated*
        // as it goes — running, then done or failed — so it is versioned like
        // the other editable records rather than appended like an event log:
        // one row per operation, read with `argMax`, and the state that wins is
        // the last one written.
        //
        // Thirty days: long enough to answer "what did we run last week", short
        // enough that a Flint left running for a year is not keeping a log
        // nobody reads.
        self.ch
            .execute(
                &format!(
                    "CREATE TABLE IF NOT EXISTS {db}.jobs \
                 ( \
                    id           UUID, \
                    kind         LowCardinality(String), \
                    label        String, \
                    target       String, \
                    statement    String CODEC(ZSTD(3)), \
                    submitted_by String, \
                    tier         LowCardinality(String), \
                    query_id     String, \
                    state        LowCardinality(String), \
                    detail       String, \
                    started_at   DateTime64(3), \
                    finished_at  DateTime64(3), \
                    version      UInt64 \
                 ) \
                 ENGINE = ReplacingMergeTree(version) \
                 PARTITION BY toYYYYMM(started_at) \
                 ORDER BY id \
                 TTL toDateTime(started_at) + INTERVAL 30 DAY"
                ),
                self.write_opts(),
            )
            .await
            .map_err(|e| self.explain(e))?;

        // ── Columns added after a table first shipped ───────────────────
        //
        // `CREATE TABLE IF NOT EXISTS` is the whole of this workspace's schema
        // management, and it has one hole big enough to lose data down: a table
        // that already exists keeps the shape it was created with, so a column
        // added to a statement above reaches a fresh install and nobody else.
        // Every column added after the fact is therefore *also* listed here.
        //
        // `ADD COLUMN IF NOT EXISTS` is idempotent and touches metadata only —
        // no data is rewritten, so this costs a few milliseconds at boot and
        // nothing after. It runs unconditionally rather than behind a version
        // check, because a version table is one more thing that can end up
        // disagreeing with the tables it claims to describe.
        //
        // **This list only ever grows.** A line removed here is a column that
        // comes back the next time an older binary boots against the same
        // workspace, which is the worst of both.
        //
        // The other half of the fix is in the writers: an `INSERT` that lists
        // its columns cannot care where `ALTER` decided to put a new one. The
        // positional inserts this workspace shipped with would have written
        // `run_as` into `version` on every migrated install and nowhere on a
        // fresh one — silently, and only for the people who already had data.
        for (table, column, ty) in [
            ("published", "expires_at", "DateTime64(3)"),
            ("published", "run_as", "String"),
            ("published", "timezone", "String"),
            ("published", "revision", "UInt32"),
            ("published", "state", "LowCardinality(String)"),
            ("published", "description", "String"),
            ("published", "cache_ttl", "UInt32"),
            ("published", "contract", "String"),
            ("published", "published_by", "String"),
            ("published", "document", "String"),
            ("published", "bindings", "String"),
            ("reports", "timezone", "String"),
        ] {
            self.ch
                .execute(
                    &format!("ALTER TABLE {db}.{table} ADD COLUMN IF NOT EXISTS {column} {ty}"),
                    self.write_opts(),
                )
                .await
                .map_err(|e| self.explain(e))?;
        }

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

    pub async fn list(&self) -> Result<Vec<SavedQuery>> {
        self.ensure().await?;
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
        self.ch.rows(&sql).await
    }

    pub async fn save(&self, input: SaveInput) -> Result<SavedQuery> {
        self.ensure().await?;
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
        self.ch
            .execute(
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
            .list()
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

    pub async fn dashboards(&self) -> Result<Vec<Dashboard>> {
        self.ensure().await?;
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
        self.ch.rows(&sql).await
    }

    pub async fn save_dashboard(&self, input: DashboardInput) -> Result<Dashboard> {
        self.ensure().await?;
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

        self.ch
            .execute(
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

        self.dashboards()
            .await?
            .into_iter()
            .find(|d| match &input.id {
                Some(id) => d.id.eq_ignore_ascii_case(id),
                None => d.name == name,
            })
            .ok_or_else(|| Error::Decode("the dashboard did not come back".into()))
    }

    pub async fn remove_dashboard(&self, id: &str) -> Result<()> {
        self.ensure().await?;
        self.ch
            .execute(
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
                    argMax(expires_at, version)    AS pexpires, \
                    argMax(run_as, version)        AS prun_as, \
                    argMax(timezone, version)      AS ptimezone, \
                    argMax(revision, version)      AS prevision, \
                    argMax(state, version)         AS pstate, \
                    argMax(description, version)   AS pdescription, \
                    argMax(cache_ttl, version)     AS pcache_ttl, \
                    argMax(contract, version)      AS pcontract, \
                    argMax(published_by, version)  AS ppublished_by, \
                    argMax(document, version)      AS pdocument, \
                    argMax(bindings, version)      AS pbindings, \
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
                /* `CAST(... AS Bool)` like its neighbours: `startsWith` \
                   answers UInt8, and a UInt8 arriving where serde wants a \
                   bool fails the whole row rather than the field. */ \
                CAST(startsWith(ptoken, 'sha256:') AS Bool) AS token_hashed, \
                CAST(ppublic != 0 AS Bool)  AS public, \
                CAST(penabled != 0 AS Bool) AS enabled, \
                pmax_rows                AS max_rows, \
                toString(pcreated)       AS created, \
                toString(pupdated)       AS updated, \
                /* Epoch is how ClickHouse spells never; an empty string is \
                   how the wire spells it. A date in 1970 in a field called \
                   expires_at reads as an endpoint that died before it was \
                   made. */ \
                if(toUnixTimestamp(pexpires) = 0, '', toString(pexpires)) AS expires_at, \
                prun_as                  AS run_as, \
                ptimezone                AS timezone, \
                /* Zero is what `ALTER ... ADD COLUMN` left on every row that \
                   predates revisions, and those rows are the first revision — \
                   they just had no number while they were the only one. */ \
                if(prevision = 0, 1, prevision) AS revision, \
                /* Empty likewise: a row written before states existed has \
                   been answering all along, which is what live means. */ \
                if(pstate = '', 'live', pstate)  AS state, \
                pdescription             AS description, \
                pcache_ttl               AS cache_ttl, \
                pcontract                AS contract, \
                ppublished_by            AS published_by, \
                pdocument                AS document, \
                pbindings                AS bindings";

    /// Every revision of every endpoint, newest revision of each address
    /// first. Drafts and retired revisions included: this is what the page
    /// lists, and a revision nobody can call is exactly the one somebody needs
    /// to see in order to do something about it.
    pub async fn published(&self) -> Result<Vec<Published>> {
        self.ensure().await?;
        let sql = format!(
            "{} FROM ({}) WHERE pdeleted = 0 ORDER BY pslug, revision DESC LIMIT 2000",
            Self::PUBLISHED_COLUMNS,
            self.published_rollup()
        );
        self.ch.rows(&sql).await
    }

    /// Every revision at one address, newest first.
    pub async fn published_revisions(&self, slug: &str) -> Result<Vec<Published>> {
        self.ensure().await?;
        let sql = format!(
            "{} FROM ({}) WHERE pdeleted = 0 AND pslug = {{slug:String}} \
             ORDER BY revision DESC LIMIT 200",
            Self::PUBLISHED_COLUMNS,
            self.published_rollup()
        );
        self.ch
            .rows_with(
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

    /// The revision a call reaches.
    ///
    /// A bare address resolves to the live one. `pin` is `?v=` — a caller who
    /// named a revision gets that revision or nothing, and never a silent
    /// upgrade to the live one: pinning exists precisely so that the answer
    /// does not change shape underneath a script.
    ///
    /// Enabled only, and answering states only. A paused endpoint, a draft and
    /// a retired revision all answer a caller exactly as an address that never
    /// existed — whether a given address is switched off, not yet open or
    /// finished is not a caller's business.
    pub async fn published_by_slug(
        &self,
        slug: &str,
        pin: Option<u32>,
    ) -> Result<Option<Published>> {
        self.ensure().await?;
        // `state IN` rather than `!= 'draft'`: a state this binary has never
        // heard of should refuse rather than answer, because the row was
        // written by something that knew a rule this one does not.
        let (filter, order) = match pin {
            Some(_) => (" AND revision = {pin:UInt32}", ""),
            // Belt and braces: exactly one revision per slug is live, and if
            // two ever were, the newer one is the one somebody meant.
            None => (" AND state = 'live'", " ORDER BY revision DESC"),
        };
        let sql = format!(
            "{} FROM ({}) \
             WHERE pdeleted = 0 AND penabled != 0 AND pslug = {{slug:String}} \
               AND state IN ('live', 'retiring'){filter}{order} \
             LIMIT 1",
            Self::PUBLISHED_COLUMNS,
            self.published_rollup()
        );
        let mut params = vec![("slug".to_string(), slug.to_string())];
        if let Some(pin) = pin {
            params.push(("pin".to_string(), pin.to_string()));
        }
        self.ch
            .row_with(
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

    /// Whether naming a role would actually narrow anything.
    ///
    /// The check this whole feature turns on, and the reason it is a check
    /// rather than a promise. ClickHouse's effective privileges are the union
    /// of the active roles **and** everything granted to the user directly, and
    /// a direct grant cannot be switched off by activating a role. So an
    /// account holding `SELECT ON *.*` in its own right reads everything
    /// whatever `run_as` says — and an endpoint that looked delegated would in
    /// fact be one running as the administrator.
    ///
    /// Returns what the account can still reach on its own account, which is
    /// the list an operator needs in order to fix it. Empty means delegation
    /// means something here.
    ///
    /// Grants on the workspace database are exempt, and have to be: Flint keeps
    /// its own bookkeeping there, so the account holds them by construction and
    /// they reach nothing a caller asked for.
    ///
    /// Only `SELECT` is examined. A published statement runs `readonly=2`, so
    /// nothing else the account holds can be reached through one — and refusing
    /// on an `INSERT` grant would refuse every deployment that can write at all,
    /// for a risk that is not there.
    pub async fn delegation_check(&self, target: &Client) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Grant {
            database: Option<String>,
            table: Option<String>,
        }

        let reaching: Vec<Grant> = target
            .rows_with(
                "SELECT database, table \
                 FROM system.grants \
                 WHERE user_name = currentUser() \
                   AND role_name IS NULL \
                   AND access_type = 'SELECT'",
                QueryOptions {
                    introspection: true,
                    quote_64bit_integers: false,
                    ..Default::default()
                },
            )
            .await?;

        Ok(reaching
            .into_iter()
            .filter(|g| g.database.as_deref() != Some(self.database.as_str()))
            .map(|g| match (g.database, g.table) {
                // A null database is how ClickHouse writes `*.*`, and it is the
                // one that matters most.
                (None, _) => "*.*".to_string(),
                (Some(db), None) => format!("{db}.*"),
                (Some(db), Some(table)) => format!("{db}.{table}"),
            })
            .collect())
    }

    /// What a save answers with: the list, and the secret if one was made.
    ///
    /// `minted` is the only moment a token is readable. It is not stored in the
    /// clear anywhere, so a page that cannot show it now cannot show it later —
    /// which is the whole point, and the reason this is a struct rather than
    /// the bare list it used to be.
    pub async fn save_published(
        &self,
        target: &Client,
        input: PublishedInput,
    ) -> Result<PublishedSaved> {
        self.ensure().await?;
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
                "a published endpoint needs a statement — one typed here, or one rendered \
                 from a question the Builder wrote"
                    .into(),
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

        let existing = self.published().await?;
        let before = input
            .id
            .as_ref()
            .and_then(|id| existing.iter().find(|p| &p.id == id));

        // An address now holds a *stack* of revisions, so the old rule — one
        // endpoint per address — has to say what it always meant: a new
        // endpoint may not land on an address somebody is already answering
        // on. Adding to that stack is `new_revision`, which is a different act
        // with a different button, because "publish this at the address the
        // billing dashboard is calling" and "publish this somewhere" are not
        // the same request and must not share a code path.
        if before.is_none() {
            if let Some(clash) = existing.iter().find(|p| p.slug == slug) {
                return Err(Error::BadRequest(format!(
                    "`{slug}` is already the address of `{}`. Start a new revision of it \
                     rather than a second endpoint on the same address.",
                    clash.name
                )));
            }
        } else if let Some(before) = before {
            // Renaming the address of one revision out of several would leave
            // the rest of the stack at the old one — half a move, and no way
            // to tell from either page which half.
            if before.slug != slug && existing.iter().filter(|p| p.slug == before.slug).count() > 1
            {
                return Err(Error::BadRequest(format!(
                    "`{}` has {} revisions, so its address cannot be changed on one of them",
                    before.slug,
                    existing.iter().filter(|p| p.slug == before.slug).count()
                )));
            }
            if before.slug != slug && existing.iter().any(|p| p.slug == slug) {
                return Err(Error::BadRequest(format!(
                    "`{slug}` is already an address in use"
                )));
            }
        }

        // What a revision *promises* is frozen the moment it goes live, and
        // this is the rule the whole numbering exists to enforce. A caller
        // pinned to v4 pinned to a shape; editing the statement or the
        // contract under them changes the shape without changing the number,
        // which is worse than no versioning at all — with no versioning they
        // would at least have known the endpoint could move.
        //
        // Everything that is not a promise — the name, the prose, the cache,
        // the pause switch, the expiry — stays editable in place, because none
        // of it changes what comes back.
        if let Some(before) = before {
            let live = State::parse(&before.state).answers();
            let sql_changed = before.sql.trim() != input.sql.trim();
            // A document is the question a document-backed endpoint answers,
            // so changing it changes what comes back exactly as changing a
            // statement does. Left out of this check it would have been the
            // one way to edit a live revision under the callers pinned to it.
            let document_changed = match &input.document {
                Some(given) => given.trim() != before.document.trim(),
                None => false,
            };
            let contract_changed = match &input.contract {
                Some(given) => Contract::parse(given) != Contract::parse(&before.contract),
                None => false,
            };
            if live && (sql_changed || document_changed || contract_changed) {
                return Err(Error::BadRequest(format!(
                    "v{} of `{}` is {} and callers are pinned to what it returns. \
                     Start a new revision: the change lands on v{}, and v{} goes on \
                     answering exactly as it does now.",
                    before.revision,
                    before.slug,
                    State::parse(&before.state).as_str(),
                    existing
                        .iter()
                        .filter(|p| p.slug == before.slug)
                        .map(|p| p.revision)
                        .max()
                        .unwrap_or(before.revision)
                        + 1,
                    before.revision,
                )));
            }
        }

        let contract = match (&input.contract, before) {
            (Some(given), _) => given.trim().to_string(),
            (None, Some(before)) => before.contract.clone(),
            (None, None) => String::new(),
        };
        Contract::validate(&contract).map_err(Error::BadRequest)?;

        // A token survives an edit unless one is given: rotating it silently
        // would break every caller the moment someone renamed the endpoint.
        //
        // Two cases that look alike and are not. A token that is *kept* is
        // already whatever the workspace holds — a hash, or a token in clear
        // from before hashing — and must be written back untouched. A token
        // that is new is a secret in the clear, and this is the only moment it
        // will ever be readable: it is hashed on its way in and handed back
        // once, because after this row is written nobody, including Flint, can
        // recover it.
        let fresh = match (&input.token, &input.id) {
            (Some(given), _) => Some(given.trim().to_string()),
            _ if input.rotate => Some(crate::published::mint_token()),
            (None, Some(id)) if existing.iter().any(|p| &p.id == id) => None,
            (None, _) => Some(crate::published::mint_token()),
        };
        let stored = match (&fresh, &input.id) {
            (Some(token), _) => crate::published::hash_token(token),
            (None, Some(id)) => existing
                .iter()
                .find(|p| &p.id == id)
                .map(|p| p.token.clone())
                .unwrap_or_default(),
            (None, None) => String::new(),
        };

        // The same rule the token follows: an edit that says nothing about a
        // field keeps what was there. Clearing an expiry because a form posted
        // without one would quietly turn a bounded endpoint into a permanent
        // one, and nothing on the page would have said so.
        let expires_at = match (input.expires_at.trim(), before) {
            ("", Some(before)) => before.expires_at.clone(),
            (given, _) => given.to_string(),
        };
        let run_as = match (input.run_as.trim(), before) {
            ("", Some(before)) => before.run_as.clone(),
            (given, _) => given.to_string(),
        };
        // Absent keeps; present is taken at its word, `""` included.
        let timezone = match (&input.timezone, before) {
            (Some(given), _) => given.trim().to_string(),
            (None, Some(before)) => before.timezone.clone(),
            (None, None) => String::new(),
        };
        // The explored server's, not the workspace's. This zone is handed to
        // whichever server runs the endpoint — `routes::data` puts it on the
        // target's client — so a name only the workspace server knows would
        // save cleanly here and fail on every call.
        crate::clickhouse::check_timezone(target, &timezone).await?;

        if !run_as.is_empty() {
            // The precondition, checked rather than assumed. An endpoint saved
            // with a role that narrows nothing would read as delegated on the
            // page and run as the administrator on the wire.
            let reaching = self.delegation_check(target).await?;
            if !reaching.is_empty() {
                return Err(Error::BadRequest(format!(
                    "this endpoint cannot be delegated to `{run_as}`. Flint's own account \
                     holds SELECT on {} directly rather than through a role, and a direct \
                     grant stays in force whatever role is active — so the endpoint would \
                     read everything that account can, not what `{run_as}` can. Give this \
                     account its read access through roles instead.",
                    reaching.join(", ")
                )));
            }
        }

        // Absent keeps; present is taken at its word, `""` included — which is
        // how an endpoint goes back to being a statement somebody typed.
        let document = match (&input.document, before) {
            (Some(given), _) => given.trim().to_string(),
            (None, Some(before)) => before.document.clone(),
            (None, None) => String::new(),
        };
        // Together with the document, always: they are one fact in two columns,
        // and a statement bound with the previous revision's values would be a
        // question nobody asked.
        let bindings = match (&input.document, &input.bindings, before) {
            (Some(_), Some(given), _) => given.trim().to_string(),
            (Some(_), None, _) => String::new(),
            (None, _, Some(before)) => before.bindings.clone(),
            (None, _, None) => String::new(),
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
            ("token".to_string(), stored),
            ("public".to_string(), u8::from(input.public).to_string()),
            ("enabled".to_string(), u8::from(input.enabled).to_string()),
            (
                "max_rows".to_string(),
                input.max_rows.clamp(1, 100_000).to_string(),
            ),
            // Epoch is the sentinel the column reads back through, so an empty
            // field and a field nobody sent mean the same thing: no expiry.
            (
                "expires_at".to_string(),
                match expires_at.as_str() {
                    "" => "1970-01-01 00:00:00.000".to_string(),
                    given => given.to_string(),
                },
            ),
            ("run_as".to_string(), run_as),
            ("timezone".to_string(), timezone),
            ("contract".to_string(), Self::text(&contract)),
            (
                "description".to_string(),
                Self::text(&match (&input.description, before) {
                    (Some(given), _) => given.trim().to_string(),
                    (None, Some(before)) => before.description.clone(),
                    (None, None) => String::new(),
                }),
            ),
            (
                "cache_ttl".to_string(),
                match (input.cache_ttl, before) {
                    // A day is the ceiling, and it is a ceiling rather than a
                    // warning: a cache that can hand back yesterday's figure
                    // is not a cache, it is a stale report with an API in
                    // front of it.
                    (Some(given), _) => given.min(86_400).to_string(),
                    (None, Some(before)) => before.cache_ttl.to_string(),
                    (None, None) => "0".to_string(),
                },
            ),
            (
                "state".to_string(),
                match before {
                    // An edit never moves a state. `set_state` does, and only
                    // it — a form that could retire an endpoint by posting a
                    // field is a form that eventually will.
                    Some(before) => before.state.clone(),
                    None => State::parse(input.state.as_deref().unwrap_or("live"))
                        .as_str()
                        .to_string(),
                },
            ),
            (
                "revision".to_string(),
                match before {
                    Some(before) => before.revision.to_string(),
                    None => "1".to_string(),
                },
            ),
            (
                "published_by".to_string(),
                match (&input.published_by, before) {
                    (Some(given), _) => given.trim().to_string(),
                    (None, Some(before)) => before.published_by.clone(),
                    (None, None) => String::new(),
                },
            ),
            ("document".to_string(), Self::text(&document)),
            ("bindings".to_string(), Self::text(&bindings)),
        ];
        if let Some(id) = &input.id {
            params.push(("id".to_string(), id.clone()));
        }

        self.ch
            .execute(
                &format!(
                    "INSERT INTO {}.published \
                 (id, name, slug, sql, database, defaults, token, public, enabled, \
                  max_rows, created_at, updated_at, deleted, version, expires_at, run_as, \
                  timezone, revision, state, description, cache_ttl, contract, published_by, \
                  document, bindings) \
                 SELECT {id_expr}, {{name:String}}, {{slug:String}}, unhex({{sql:String}}), \
                        {{database:String}}, {{defaults:String}}, {{token:String}}, \
                        {{public:UInt8}}, {{enabled:UInt8}}, {{max_rows:UInt32}}, \
                        now64(3), now64(3), 0, toUnixTimestamp64Milli(now64(3)), \
                        {{expires_at:DateTime64(3)}}, {{run_as:String}}, {{timezone:String}}, \
                        {{revision:UInt32}}, {{state:String}}, unhex({{description:String}}), \
                        {{cache_ttl:UInt32}}, unhex({{contract:String}}), \
                        {{published_by:String}}, unhex({{document:String}}), \
                        unhex({{bindings:String}})",
                    self.quoted()
                ),
                QueryOptions {
                    params,
                    ..self.write_opts()
                },
            )
            .await?;
        Ok(PublishedSaved {
            endpoints: self.published().await?,
            minted: fresh,
        })
    }

    pub async fn remove_published(&self, id: &str) -> Result<()> {
        self.ensure().await?;
        self.ch
            .execute(
                &format!(
                    "INSERT INTO {}.published \
                 (id, name, slug, sql, database, defaults, token, public, enabled, \
                  max_rows, created_at, updated_at, deleted, version, expires_at, run_as) \
                 SELECT {{id:UUID}}, '', '', '', '', '{{}}', '', 0, 0, 0, now64(3), now64(3), 1, \
                        toUnixTimestamp64Milli(now64(3)), toDateTime64(0, 3), ''",
                    self.quoted()
                ),
                QueryOptions {
                    params: vec![("id".into(), id.to_string())],
                    ..self.write_opts()
                },
            )
            .await
    }

    /// Publish several tables at once, one endpoint each.
    ///
    /// The read side of the no-code APIs has always been per *statement*, which
    /// is right for the analyst who needs a join today and wrong for the only
    /// other thing anyone uses it for: handing a partner, or a spreadsheet,
    /// read access to a handful of tables. That is fifteen visits to a form to
    /// type fifteen variations of `SELECT * FROM t`, and the fifteenth is where
    /// somebody makes the mistake.
    ///
    /// Whoever has a ClickHouse account should use `POST /api/data` instead and
    /// name a dataset per call — nothing has to be published at all, and their
    /// own grants and row policies decide what comes back. This exists for the
    /// caller who has no account, which is the one thing publishing does that
    /// nothing else can.
    ///
    /// The statement generated is `SELECT * FROM db.table` and nothing more.
    /// It looks too simple to be useful and is not: the shape layer gives a
    /// caller filters, ordering, a projection, paging and a count over it, all
    /// checked against the columns the table actually has. What it does *not*
    /// give is a join or an aggregate, and that is where the per-statement form
    /// remains the answer.
    ///
    /// Nothing is skipped in silence. A name that is not a table anyone can
    /// read here, or an address already in use, comes back in `skipped` with
    /// the reason — because a caller who asked for fifteen and got twelve needs
    /// to know which three and why, and a count alone sends them comparing
    /// lists by hand.
    pub async fn publish_tables(
        &self,
        target: &Client,
        caller: &Client,
        input: PublishTablesInput,
    ) -> Result<TablesPublished> {
        self.ensure().await?;
        let database = input.database.trim().to_string();
        if database.is_empty() {
            return Err(Error::BadRequest("name a database to expose from".into()));
        }
        if input.tables.is_empty() {
            return Err(Error::BadRequest("no tables were chosen".into()));
        }
        // A cap, because this writes one row per table and a fat-fingered
        // request naming a thousand of them is a thousand endpoints somebody
        // then has to delete one at a time.
        if input.tables.len() > 100 {
            return Err(Error::BadRequest(format!(
                "{} tables at once is more than this will do — 100 is the limit, and past a \
                 dozen it is worth asking whether these callers should have accounts instead",
                input.tables.len()
            )));
        }

        // Read as the *caller*, not as Flint. Publishing a table somebody
        // cannot see would be a way to read it: the endpoint runs as the
        // manifest account afterwards, so the grant check has to happen here or
        // it never happens at all.
        let real = crate::clickhouse::meta::tables(caller, &database).await?;
        let existing = self.published().await?;

        let state = State::parse(&input.state);
        let mut published: Vec<PublishedTable> = Vec::new();
        let mut skipped: Vec<SkippedTable> = Vec::new();

        for name in &input.tables {
            let name = name.trim();
            let Some(table) = real.iter().find(|t| t.name == name) else {
                skipped.push(SkippedTable {
                    table: name.to_string(),
                    why: format!("`{name}` is not a table or view you can read in `{database}`"),
                });
                continue;
            };
            // Lower-cased and nothing more. A table name is nearly an address
            // already — the alphabets overlap almost exactly — and the one
            // transformation worth making silently is case. Anything else is a
            // second implementation of a rule the publish form already owns and
            // already tests, so a name that will not do is skipped and named
            // rather than reshaped into an address nobody chose.
            let slug = format!("{}{}", input.prefix.trim(), name).to_lowercase();
            if !crate::published::valid_slug(&slug) {
                skipped.push(SkippedTable {
                    table: name.to_string(),
                    why: format!(
                        "`{name}` does not make an address on its own — publish it by hand and \
                         give it one"
                    ),
                });
                continue;
            }
            if let Some(clash) = existing.iter().find(|p| p.slug == slug) {
                skipped.push(SkippedTable {
                    table: name.to_string(),
                    why: format!("`{slug}` is already the address of `{}`", clash.name),
                });
                continue;
            }
            if published.iter().any(|p| p.slug == slug) {
                // Two tables in one batch that slugify the same way. Rare, and
                // the alternative — appending a number — invents an address
                // nobody chose and that nobody will recognise later.
                skipped.push(SkippedTable {
                    table: name.to_string(),
                    why: format!("`{slug}` is the address another table in this batch took"),
                });
                continue;
            }

            let sql = format!(
                "SELECT * FROM {}.{}",
                crate::published::shape::quote_ident(&database),
                crate::published::shape::quote_ident(name)
            );
            // The sorting key, as the columns a caller may order by. Not a
            // guess: it is the order the table is already stored in, so it is
            // the one sort that costs nothing — and offering every column would
            // invite a full sort of a billion rows over HTTP.
            let contract = Contract {
                order_by: sorting_columns(&table.sorting_key),
                ..Default::default()
            };
            let contract = if contract.order_by.is_empty() {
                String::new()
            } else {
                serde_json::to_string(&contract).unwrap_or_default()
            };

            let saved = self
                .save_published(
                    target,
                    PublishedInput {
                        id: None,
                        name: name.to_string(),
                        slug: slug.clone(),
                        sql,
                        database: database.clone(),
                        defaults: "{}".into(),
                        token: None,
                        rotate: false,
                        public: input.public,
                        enabled: true,
                        max_rows: input.max_rows,
                        expires_at: String::new(),
                        run_as: String::new(),
                        timezone: None,
                        description: Some(format!(
                            "Rows of `{database}.{name}`, filtered, sorted and paged by the \
                             caller. No join and no aggregate: this is the table."
                        )),
                        cache_ttl: Some(input.cache_ttl),
                        contract: Some(contract),
                        state: Some(state.as_str().to_string()),
                        published_by: Some(input.published_by.clone()),
                        // A table published wholesale is `SELECT * FROM t` and
                        // says so. There is no question behind it to reopen.
                        document: None,
                        bindings: None,
                    },
                )
                .await?;
            published.push(PublishedTable {
                table: name.to_string(),
                slug,
                // A draft carries no token: it answers nothing, so it needs no
                // secret, and it gets one when it goes live.
                minted: saved.minted,
            });
        }

        Ok(TablesPublished {
            endpoints: self.published().await?,
            published,
            skipped,
        })
    }

    /// Start a new revision of an address, as a draft.
    ///
    /// A copy of the newest revision, one number higher, reachable by nobody.
    /// That last part is the point: a revision is where a change to the
    /// contract goes, and the window between "somebody edited the statement"
    /// and "the endpoint returns something different" is where every review
    /// that ever caught anything happened. A draft makes that window as long
    /// as the person wants it to be.
    ///
    /// The token is not copied. A draft answers nothing, so it needs no
    /// secret; it is minted when the draft goes live, which is also the moment
    /// somebody is present to be handed it.
    pub async fn new_revision(&self, slug: &str) -> Result<PublishedSaved> {
        self.ensure().await?;
        let revisions = self.published_revisions(slug).await?;
        let from = revisions
            .first()
            .ok_or_else(|| Error::NotFound(format!("no endpoint at `{slug}`")))?;
        if revisions
            .iter()
            .any(|p| State::parse(&p.state) == State::Draft)
        {
            return Err(Error::BadRequest(format!(
                "`{slug}` already has a draft revision. Finish or discard it before starting \
                 another — two drafts of one address is two answers to \"what goes live next\"."
            )));
        }
        let next = revisions.iter().map(|p| p.revision).max().unwrap_or(0) + 1;

        self.ch
            .execute(
                &format!(
                    "INSERT INTO {}.published \
                 (id, name, slug, sql, database, defaults, token, public, enabled, \
                  max_rows, created_at, updated_at, deleted, version, expires_at, run_as, \
                  timezone, revision, state, description, cache_ttl, contract, published_by, \
                  document, bindings) \
                 SELECT generateUUIDv4(), {{name:String}}, {{slug:String}}, unhex({{sql:String}}), \
                        {{database:String}}, {{defaults:String}}, '', {{public:UInt8}}, 1, \
                        {{max_rows:UInt32}}, now64(3), now64(3), 0, \
                        toUnixTimestamp64Milli(now64(3)), {{expires_at:DateTime64(3)}}, \
                        {{run_as:String}}, {{timezone:String}}, {{revision:UInt32}}, 'draft', \
                        unhex({{description:String}}), {{cache_ttl:UInt32}}, \
                        unhex({{contract:String}}), {{published_by:String}}, \
                        unhex({{document:String}}), unhex({{bindings:String}})",
                    self.quoted()
                ),
                QueryOptions {
                    params: vec![
                        ("name".into(), from.name.clone()),
                        ("slug".into(), from.slug.clone()),
                        ("sql".into(), Self::text(&from.sql)),
                        ("database".into(), from.database.clone()),
                        ("defaults".into(), from.defaults.clone()),
                        ("public".into(), u8::from(from.public).to_string()),
                        ("max_rows".into(), from.max_rows.to_string()),
                        (
                            "expires_at".into(),
                            match from.expires_at.as_str() {
                                "" => "1970-01-01 00:00:00.000".to_string(),
                                given => given.to_string(),
                            },
                        ),
                        ("run_as".into(), from.run_as.clone()),
                        ("timezone".into(), from.timezone.clone()),
                        ("revision".into(), next.to_string()),
                        ("description".into(), Self::text(&from.description)),
                        ("cache_ttl".into(), from.cache_ttl.to_string()),
                        ("contract".into(), Self::text(&from.contract)),
                        ("published_by".into(), from.published_by.clone()),
                        ("document".into(), Self::text(&from.document)),
                        ("bindings".into(), Self::text(&from.bindings)),
                    ],
                    ..self.write_opts()
                },
            )
            .await?;
        Ok(PublishedSaved {
            endpoints: self.published().await?,
            minted: None,
        })
    }

    /// Move one revision along its life.
    ///
    /// The only thing that writes `state`, and it enforces the two rules that
    /// make the number mean anything: a state only ever moves forward, and
    /// exactly one revision of an address is live. Going live therefore does
    /// two things in one act — it opens the draft and puts the revision it
    /// replaces on notice — because a moment in which an address has two live
    /// revisions, or none, is a moment a caller can land in.
    ///
    /// Returns the token minted where one was: a draft carries no secret, so
    /// going live is when a token-guarded endpoint gets its first.
    pub async fn set_state(&self, id: &str, to: State) -> Result<PublishedSaved> {
        self.ensure().await?;
        if !crate::routes::is_uuid(id) {
            return Err(Error::BadRequest(format!("`{id}` is not an endpoint id")));
        }
        let all = self.published().await?;
        let target = all
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| Error::NotFound("no such endpoint".into()))?;
        let from = State::parse(&target.state);

        // Spelled out rather than compared as an ordering, because the
        // sentence each refusal needs is different and "state may not go
        // backwards" is not one a person can act on.
        let allowed = match (from, to) {
            (State::Draft, State::Live) => true,
            (State::Live, State::Retiring) => true,
            (State::Retiring, State::Retired) => true,
            // Called off: a revision put on notice by mistake can be taken
            // back, and this is the one backwards move worth having, because
            // the alternative is publishing a v6 identical to v4.
            (State::Retiring, State::Live) => true,
            _ => false,
        };
        if !allowed {
            return Err(Error::BadRequest(format!(
                "v{} of `{}` is {}, and {} is not somewhere it can go from there",
                target.revision,
                target.slug,
                from.as_str(),
                to.as_str()
            )));
        }
        if to == State::Retiring
            && !all.iter().any(|p| {
                p.slug == target.slug && p.id != target.id && State::parse(&p.state) == State::Draft
            })
        {
            // Retiring the live revision with nothing behind it leaves the
            // address answering out of a revision that is on its way out and
            // no successor named. Allowed, but it is a decision rather than a
            // slip, so it is refused here and taken by going live on a new
            // revision instead.
            return Err(Error::BadRequest(format!(
                "nothing would replace v{} of `{}`. Start a new revision and take it live — \
                 that puts this one on notice by itself.",
                target.revision, target.slug
            )));
        }

        // The one that steps aside. Read before anything is written, so the
        // pair of updates is decided from one consistent view.
        let stepping_down: Option<&Published> = (to == State::Live)
            .then(|| {
                all.iter().find(|p| {
                    p.slug == target.slug
                        && p.id != target.id
                        && State::parse(&p.state) == State::Live
                })
            })
            .flatten();

        // A draft has no token, so this is where a token-guarded endpoint gets
        // its first — and the only moment it is readable.
        let minted = (from == State::Draft && to == State::Live && !target.public)
            .then(crate::published::mint_token);

        self.write_state(
            target,
            to,
            minted
                .as_deref()
                .map(crate::published::hash_token)
                .unwrap_or_else(|| target.token.clone()),
        )
        .await?;
        if let Some(down) = stepping_down {
            self.write_state(down, State::Retiring, down.token.clone())
                .await?;
        }
        Ok(PublishedSaved {
            endpoints: self.published().await?,
            minted,
        })
    }

    /// One row, rewritten with a new state. Every other column carried across
    /// verbatim: `ReplacingMergeTree` keeps the newest row per id whole, so a
    /// column left out of this insert is a column set back to its default.
    async fn write_state(&self, row: &Published, to: State, token: String) -> Result<()> {
        self.ch
            .execute(
                &format!(
                    "INSERT INTO {}.published \
                 (id, name, slug, sql, database, defaults, token, public, enabled, \
                  max_rows, created_at, updated_at, deleted, version, expires_at, run_as, \
                  timezone, revision, state, description, cache_ttl, contract, published_by, \
                  document, bindings) \
                 SELECT {{id:UUID}}, {{name:String}}, {{slug:String}}, unhex({{sql:String}}), \
                        {{database:String}}, {{defaults:String}}, {{token:String}}, \
                        {{public:UInt8}}, {{enabled:UInt8}}, {{max_rows:UInt32}}, \
                        now64(3), now64(3), 0, toUnixTimestamp64Milli(now64(3)), \
                        {{expires_at:DateTime64(3)}}, {{run_as:String}}, {{timezone:String}}, \
                        {{revision:UInt32}}, {{state:String}}, unhex({{description:String}}), \
                        {{cache_ttl:UInt32}}, unhex({{contract:String}}), \
                        {{published_by:String}}, unhex({{document:String}}), \
                        unhex({{bindings:String}})",
                    self.quoted()
                ),
                QueryOptions {
                    params: vec![
                        ("id".into(), row.id.clone()),
                        ("name".into(), row.name.clone()),
                        ("slug".into(), row.slug.clone()),
                        ("sql".into(), Self::text(&row.sql)),
                        ("database".into(), row.database.clone()),
                        ("defaults".into(), row.defaults.clone()),
                        ("token".into(), token),
                        ("public".into(), u8::from(row.public).to_string()),
                        ("enabled".into(), u8::from(row.enabled).to_string()),
                        ("max_rows".into(), row.max_rows.to_string()),
                        (
                            "expires_at".into(),
                            match row.expires_at.as_str() {
                                "" => "1970-01-01 00:00:00.000".to_string(),
                                given => given.to_string(),
                            },
                        ),
                        ("run_as".into(), row.run_as.clone()),
                        ("timezone".into(), row.timezone.clone()),
                        ("revision".into(), row.revision.to_string()),
                        ("state".into(), to.as_str().to_string()),
                        ("description".into(), Self::text(&row.description)),
                        ("cache_ttl".into(), row.cache_ttl.to_string()),
                        ("contract".into(), Self::text(&row.contract)),
                        ("published_by".into(), row.published_by.clone()),
                        ("document".into(), Self::text(&row.document)),
                        ("bindings".into(), Self::text(&row.bindings)),
                    ],
                    ..self.write_opts()
                },
            )
            .await
    }

    // ── Keys ────────────────────────────────────────────────────────────

    const KEY_COLUMNS: &'static str = "SELECT toString(kid) AS id, \
                kname                       AS name, \
                kowner                      AS owner, \
                khash                       AS hash, \
                kscope                      AS scope, \
                kquota                      AS quota_per_day, \
                CAST(kenabled != 0 AS Bool) AS enabled, \
                toString(kcreated)          AS created_at";

    fn keys_rollup(&self) -> String {
        format!(
            "SELECT id                              AS kid, \
                    argMax(name, version)           AS kname, \
                    argMax(owner, version)          AS kowner, \
                    argMax(hash, version)           AS khash, \
                    argMax(scope, version)          AS kscope, \
                    argMax(quota_per_day, version)  AS kquota, \
                    argMax(enabled, version)        AS kenabled, \
                    argMax(deleted, version)        AS kdeleted, \
                    min(created_at)                 AS kcreated \
             FROM {}.api_keys \
             GROUP BY id",
            self.quoted()
        )
    }

    pub async fn api_keys(&self) -> Result<Vec<ApiKey>> {
        self.ensure().await?;
        let sql = format!(
            "{} FROM ({}) WHERE kdeleted = 0 ORDER BY kname LIMIT 1000",
            Self::KEY_COLUMNS,
            self.keys_rollup()
        );
        // `scope` is stored as JSON text and wanted as a list. Read as text
        // here and split in `parse_scope`, rather than asking ClickHouse for
        // an Array(String) it would have to parse out of a String column.
        let raw: Vec<ApiKeyRow> = self.ch.rows(&sql).await?;
        Ok(raw.into_iter().map(ApiKeyRow::into_key).collect())
    }

    /// The key this secret belongs to, or nothing.
    ///
    /// Looked up by hash, which is the only way round it can work: the secret
    /// is hashed on its way in and never stored, so the presented secret is
    /// hashed and the hash is what the lookup matches. That also means the
    /// query carries a digest rather than a credential, which is what anyone
    /// reading the query log will see.
    pub async fn key_by_secret(&self, secret: &str) -> Result<Option<ApiKey>> {
        self.ensure().await?;
        let sql = format!(
            "{} FROM ({}) WHERE kdeleted = 0 AND kenabled != 0 AND khash = {{hash:String}} LIMIT 1",
            Self::KEY_COLUMNS,
            self.keys_rollup()
        );
        let row: Option<ApiKeyRow> = self
            .ch
            .row_with(
                &sql,
                QueryOptions {
                    params: vec![("hash".into(), crate::published::hash_token(secret))],
                    quote_64bit_integers: false,
                    introspection: true,
                    ..Default::default()
                },
            )
            .await?;
        Ok(row.map(ApiKeyRow::into_key))
    }

    pub async fn save_api_key(&self, input: ApiKeyInput) -> Result<ApiKeySaved> {
        self.ensure().await?;
        let name = input.name.trim();
        if name.is_empty() {
            return Err(Error::BadRequest(
                "a key needs a name — it is what the call log will show".into(),
            ));
        }
        if let Some(id) = &input.id {
            if !crate::routes::is_uuid(id) {
                return Err(Error::BadRequest(format!("`{id}` is not a key id")));
            }
        }
        let existing = self.api_keys().await?;
        if let Some(clash) = existing
            .iter()
            .find(|k| k.name == name && Some(&k.id) != input.id.as_ref())
        {
            return Err(Error::BadRequest(format!(
                "there is already a key called `{}`, and two would be indistinguishable \
                 everywhere the name is what is shown",
                clash.name
            )));
        }
        let before = input
            .id
            .as_ref()
            .and_then(|id| existing.iter().find(|k| &k.id == id));

        let minted = match (before, input.rotate) {
            (Some(_), false) => None,
            _ => Some(crate::published::mint_token()),
        };
        let hash = match (&minted, before) {
            (Some(secret), _) => crate::published::hash_token(secret),
            (None, Some(before)) => before.hash.clone(),
            (None, None) => String::new(),
        };
        let scope: Vec<String> = input
            .scope
            .iter()
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        for slug in &scope {
            if !crate::published::valid_slug(slug) {
                return Err(Error::BadRequest(format!("`{slug}` is not an address")));
            }
        }

        let id_expr = if input.id.is_some() {
            "{id:UUID}"
        } else {
            "generateUUIDv4()"
        };
        let mut params = vec![
            ("name".to_string(), name.to_string()),
            ("owner".to_string(), input.owner.trim().to_string()),
            ("hash".to_string(), hash),
            (
                "scope".to_string(),
                serde_json::to_string(&scope).unwrap_or_else(|_| "[]".into()),
            ),
            ("quota".to_string(), input.quota_per_day.to_string()),
            ("enabled".to_string(), u8::from(input.enabled).to_string()),
        ];
        if let Some(id) = &input.id {
            params.push(("id".to_string(), id.clone()));
        }
        self.ch
            .execute(
                &format!(
                    "INSERT INTO {}.api_keys \
                 (id, name, owner, hash, scope, quota_per_day, enabled, created_at, deleted, \
                  version) \
                 SELECT {id_expr}, {{name:String}}, {{owner:String}}, {{hash:String}}, \
                        {{scope:String}}, {{quota:UInt32}}, {{enabled:UInt8}}, now64(3), 0, \
                        toUnixTimestamp64Milli(now64(3))",
                    self.quoted()
                ),
                QueryOptions {
                    params,
                    ..self.write_opts()
                },
            )
            .await?;
        Ok(ApiKeySaved {
            keys: self.api_keys().await?,
            minted,
        })
    }

    pub async fn remove_api_key(&self, id: &str) -> Result<()> {
        self.ensure().await?;
        if !crate::routes::is_uuid(id) {
            return Err(Error::BadRequest(format!("`{id}` is not a key id")));
        }
        self.ch
            .execute(
                &format!(
                    "INSERT INTO {}.api_keys \
                 (id, name, owner, hash, scope, quota_per_day, enabled, created_at, deleted, \
                  version) \
                 SELECT {{id:UUID}}, '', '', '', '[]', 0, 0, now64(3), 1, \
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

    // ── The call log ────────────────────────────────────────────────────

    /// The columns of `api_calls`, as ClickHouse should read them out of a
    /// batch. Written once and used twice — the insert names them and the
    /// `format` function is told their types — so the two cannot drift.
    const CALL_STRUCTURE: &'static str = "age_ms UInt64, slug String, revision UInt32, \
         key_id String, key_name String, label String, status UInt16, reason String, \
         ms UInt32, cached UInt8, read_rows UInt64, read_bytes UInt64";
    const CALL_COLUMNS: &'static str = "at, slug, revision, key_id, key_name, label, status, \
         reason, ms, cached, read_rows, read_bytes";
    /// The same list, as the batch supplies it: an age where the table wants a
    /// moment, and ClickHouse's own clock turning the one into the other.
    const CALL_SELECT: &'static str = "now64(3) - toIntervalMillisecond(age_ms), slug, revision, \
         key_id, key_name, label, status, reason, ms, cached, read_rows, read_bytes";

    /// Write a batch of calls down.
    ///
    /// One insert for the lot, because ClickHouse makes a part per insert and a
    /// busy endpoint writing a row at a time would produce tens of thousands of
    /// parts a day — on the workspace, where the alerts and the dashboards also
    /// live. See `published::log` for the buffer in front of this.
    ///
    /// The batch crosses as a single bound parameter holding JSON, which
    /// ClickHouse parses with `format`. Not as an interpolated `VALUES` list:
    /// two of these fields are free text off the wire, and this codebase does
    /// not put caller-controlled text into SQL. Not as one parameter per field
    /// either — five hundred rows would be six thousand parameters and a query
    /// string nothing would accept.
    pub async fn write_calls(&self, calls: &[CallRecord]) -> Result<()> {
        if calls.is_empty() {
            return Ok(());
        }
        self.ensure().await?;

        let mut batch = String::with_capacity(calls.len() * 200);
        for call in calls {
            let row = serde_json::json!({
                // How long before this insert the call happened. ClickHouse
                // turns it back into a moment on its own clock, so the batching
                // is invisible in the data and no second clock enters the
                // workspace.
                "age_ms": u64::try_from(call.at.elapsed().as_millis()).unwrap_or(u64::MAX),
                "slug": call.slug,
                "revision": call.revision,
                "key_id": call.key_id,
                "key_name": call.key_name,
                // Free text off the wire, and the two fields here somebody else
                // controls. Clipped rather than refused: a caller who sends a
                // novel as a label should get their data, and the page should
                // not have to render the novel.
                "label": call.label.chars().take(120).collect::<String>(),
                "status": call.status,
                "reason": call.reason.chars().take(200).collect::<String>(),
                "ms": call.ms,
                "cached": u8::from(call.cached),
                "read_rows": call.read_rows,
                "read_bytes": call.read_bytes,
            });
            batch.push_str(&row.to_string());
            batch.push('\n');
        }

        self.ch
            .execute(
                &format!(
                    "INSERT INTO {db}.api_calls ({columns}) \
                 SELECT {select} \
                 FROM format(JSONEachRow, '{structure}', unhex({{batch:String}}))",
                    db = self.quoted(),
                    columns = Self::CALL_COLUMNS,
                    select = Self::CALL_SELECT,
                    structure = Self::CALL_STRUCTURE,
                ),
                QueryOptions {
                    params: vec![("batch".into(), Self::text(&batch))],
                    ..self.write_opts()
                },
            )
            .await
    }

    /// How many calls this key has already made to this address today.
    ///
    /// Today in the *server's* day, like every other figure in the workspace,
    /// and only calls that were actually answered: a quota that counted its
    /// own refusals would lock a caller out for the rest of the day the moment
    /// they hit it once, which is a different and much worse rule than the one
    /// the page says is in force.
    pub async fn calls_today(&self, key_id: &str, slug: &str) -> Result<u64> {
        #[derive(Deserialize)]
        struct Row {
            n: u64,
        }
        let sql = format!(
            "SELECT count() AS n FROM {}.api_calls \
             WHERE key_id = {{key_id:String}} AND slug = {{slug:String}} \
               AND at >= toStartOfDay(now64(3)) AND status < 400",
            self.quoted()
        );
        let row: Option<Row> = self
            .ch
            .row_with(
                &sql,
                QueryOptions {
                    params: vec![
                        ("key_id".into(), key_id.to_string()),
                        ("slug".into(), slug.to_string()),
                    ],
                    quote_64bit_integers: false,
                    introspection: true,
                    ..Default::default()
                },
            )
            .await?;
        Ok(row.map(|r| r.n).unwrap_or(0))
    }

    /// The list page's rollup, one row per address.
    ///
    /// Answered calls and refused ones are counted separately throughout,
    /// because mixing them makes every figure lie in the same direction: a
    /// p95 that includes refusals is fast (a 429 costs nothing), and a call
    /// count that includes them is high. The page wants "how much work is this
    /// doing" and "how much is it turning away" as two numbers.
    pub async fn usage_index(&self, hours: u32) -> Result<Vec<SlugUsage>> {
        self.ensure().await?;
        // Per *revision*, not per address, and that is the whole point of the
        // column. "v3 is retiring and still took two thousand calls today" is
        // the sentence somebody needs before they can go and have a
        // conversation, and an address-level total cannot say it — it hides
        // the revision that is on its way out inside the one that replaced it.
        //
        // A revision of 0 cannot occur: every call records the revision it
        // reached, and a row that predates the column belongs to an endpoint
        // that had only one.
        let sql = format!(
            "SELECT slug                                        AS slug, \
                    revision                                    AS revision, \
                    countIf(status < 400)                       AS calls, \
                    countIf(status < 400 AND cached = 1)        AS cached, \
                    countIf(status >= 400)                      AS failures, \
                    /* Null, not zero, where nothing was answered. A group \
                       can be all refusals — a key that spent its quota at \
                       eleven, a revision nobody reaches any more — and a p95 \
                       over no calls does not exist. `quantileIf` returns null \
                       there and `round` carries it through, which is exactly \
                       right and which the row type has to be able to hold. */ \
                    if(countIf(status < 400) = 0, NULL, \
                       round(quantileIf(0.95)(ms, status < 400), 1)) AS p95_ms, \
                    if(countIf(status < 400) = 0, NULL, \
                       round(avgIf(ms, status < 400), 1))          AS avg_ms, \
                    toString(max(at))                           AS last_call, \
                    uniqExactIf(key_id, key_id != '')           AS keys \
             FROM {}.api_calls \
             WHERE at >= now64(3) - toIntervalHour({{hours:UInt32}}) \
             GROUP BY slug, revision \
             ORDER BY calls DESC \
             LIMIT 2000",
            self.quoted()
        );
        self.ch
            .rows_with(
                &sql,
                QueryOptions {
                    params: vec![("hours".into(), hours.to_string())],
                    quote_64bit_integers: false,
                    introspection: true,
                    ..Default::default()
                },
            )
            .await
    }

    /// One address's traffic, split the four ways the detail page shows it.
    pub async fn endpoint_traffic(&self, slug: &str, hours: u32) -> Result<Traffic> {
        self.ensure().await?;
        let params = || {
            vec![
                ("slug".to_string(), slug.to_string()),
                ("hours".to_string(), hours.to_string()),
            ]
        };
        let opts = || QueryOptions {
            params: params(),
            quote_64bit_integers: false,
            introspection: true,
            ..Default::default()
        };
        let window = "at >= now64(3) - toIntervalHour({hours:UInt32}) AND slug = {slug:String}";

        #[derive(Deserialize)]
        struct Totals {
            calls: u64,
            failures: u64,
            hits: u64,
            misses: u64,
            avg_hit_ms: Option<f64>,
            avg_miss_ms: Option<f64>,
        }
        let totals: Option<Totals> = self
            .ch
            .row_with(
                &format!(
                    "SELECT countIf(status < 400)                    AS calls, \
                            countIf(status >= 400)                   AS failures, \
                            countIf(status < 400 AND cached = 1)     AS hits, \
                            countIf(status < 400 AND cached = 0)     AS misses, \
                            /* Null rather than zero where nothing was served \
                               that way: `avgIf` over no rows is nan, and a \
                               cache reported as answering in 0 ms is a claim \
                               nobody made. */ \
                            if(countIf(status < 400 AND cached = 1) = 0, NULL, \
                               round(avgIf(ms, status < 400 AND cached = 1), 1)) AS avg_hit_ms, \
                            if(countIf(status < 400 AND cached = 0) = 0, NULL, \
                               round(avgIf(ms, status < 400 AND cached = 0), 1)) AS avg_miss_ms \
                     FROM {}.api_calls WHERE {window}",
                    self.quoted()
                ),
                opts(),
            )
            .await?;
        let totals = totals.unwrap_or(Totals {
            calls: 0,
            failures: 0,
            hits: 0,
            misses: 0,
            avg_hit_ms: None,
            avg_miss_ms: None,
        });

        let callers: Vec<CallerUsage> = self
            .ch
            .rows_with(
                &format!(
                    "SELECT key_name        AS key_name, \
                            label           AS label, \
                            count()         AS calls, \
                            toString(max(at)) AS last_call \
                     FROM {}.api_calls \
                     WHERE {window} AND status < 400 \
                     GROUP BY key_name, label \
                     ORDER BY calls DESC \
                     LIMIT 12",
                    self.quoted()
                ),
                opts(),
            )
            .await?;

        let refusals: Vec<RefusalUsage> = self
            .ch
            .rows_with(
                &format!(
                    "SELECT status          AS status, \
                            reason          AS reason, \
                            count()         AS calls, \
                            toString(max(at)) AS last_call \
                     FROM {}.api_calls \
                     WHERE {window} AND status >= 400 \
                     GROUP BY status, reason \
                     ORDER BY calls DESC \
                     LIMIT 12",
                    self.quoted()
                ),
                opts(),
            )
            .await?;

        // Today rather than the window, because a quota is a day's worth and
        // showing "31.4 K of 60 K" against a seven-day count would be a figure
        // nobody can act on.
        #[derive(Deserialize)]
        struct KeyDay {
            key_id: String,
            calls_today: u64,
            throttled_today: u64,
            last_call: String,
        }
        let today: Vec<KeyDay> = self
            .ch
            .rows_with(
                &format!(
                    "SELECT key_id                     AS key_id, \
                            countIf(status < 400)      AS calls_today, \
                            countIf(status = 429)      AS throttled_today, \
                            toString(max(at))          AS last_call \
                     FROM {}.api_calls \
                     WHERE slug = {{slug:String}} AND at >= toStartOfDay(now64(3)) \
                       AND key_id != '' \
                     GROUP BY key_id \
                     LIMIT 500",
                    self.quoted()
                ),
                QueryOptions {
                    params: vec![("slug".into(), slug.to_string())],
                    quote_64bit_integers: false,
                    introspection: true,
                    ..Default::default()
                },
            )
            .await?;

        // Every key that may call this address, whether or not it has — a key
        // holding a quota it has never spent is exactly what somebody looks
        // for when they ask who could be calling this.
        let keys = self.api_keys().await?;
        let mut key_usage: Vec<KeyUsage> = keys
            .into_iter()
            .filter(|k| k.scope.is_empty() || k.scope.iter().any(|s| s == slug))
            .map(|k| {
                let day = today.iter().find(|d| d.key_id == k.id);
                KeyUsage {
                    key_id: k.id,
                    key_name: k.name,
                    owner: k.owner,
                    calls_today: day.map(|d| d.calls_today).unwrap_or(0),
                    quota_per_day: k.quota_per_day,
                    throttled_today: day.map(|d| d.throttled_today).unwrap_or(0),
                    last_call: day.map(|d| d.last_call.clone()).unwrap_or_default(),
                }
            })
            .collect();
        // The ones spending their quota first: that is the order somebody
        // scanning this panel is scanning it in.
        key_usage.sort_by(|a, b| {
            b.calls_today
                .cmp(&a.calls_today)
                .then(a.key_name.cmp(&b.key_name))
        });

        Ok(Traffic {
            calls: totals.calls,
            failures: totals.failures,
            hits: totals.hits,
            misses: totals.misses,
            avg_hit_ms: totals.avg_hit_ms,
            avg_miss_ms: totals.avg_miss_ms,
            keys: key_usage,
            callers,
            refusals,
        })
    }

    // ── Reports ─────────────────────────────────────────────────────────

    /// The server's clock, in the server's timezone.
    ///
    /// Asked of ClickHouse rather than computed here: the timestamps a report
    /// is compared against were written by ClickHouse, and Flint already shows
    /// ClickHouse's timezone on the server page. Two clocks would eventually
    /// disagree, and the disagreement would look like a report that runs twice.
    pub async fn clock(&self, timezone: &str) -> Result<crate::reports::Clock> {
        // `now_ts` is an instant and does not move; `midnight_ts` and `dow` are
        // wall-clock facts and do. That is exactly the split a schedule needs —
        // "is it past nine in Auckland" is the same integer comparison, against
        // an Auckland midnight.
        self.ch
            .row_with(
                "SELECT toInt64(toUnixTimestamp(now()))                    AS now_ts, \
                    toInt64(toUnixTimestamp(toDateTime(today())))       AS midnight_ts, \
                    toUInt8(toDayOfWeek(now()))                        AS dow",
                QueryOptions {
                    timezone: (!timezone.is_empty()).then(|| timezone.to_string()),
                    introspection: true,
                    quote_64bit_integers: false,
                    ..Default::default()
                },
            )
            .await?
            .ok_or_else(|| Error::Decode("ClickHouse returned no clock".into()))
    }

    pub async fn reports(&self) -> Result<Vec<Report>> {
        self.ensure().await?;
        let db = self.quoted();
        let sql = format!(
            "SELECT toString(r.id)                          AS id, \
                    r.name                                   AS name, \
                    r.spec                                   AS spec, \
                    r.schedule                               AS schedule, \
                    r.timezone                               AS timezone, \
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
                        argMax(timezone, version) AS timezone, \
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
        self.ch.rows(&sql).await
    }

    /// Unix seconds of the last run of each report, for the due-ness check.
    pub async fn last_run_seconds(&self) -> Result<std::collections::HashMap<String, i64>> {
        self.ensure().await?;
        #[derive(Deserialize)]
        struct Row {
            id: String,
            ran: i64,
        }
        let rows: Vec<Row> = self
            .ch
            .rows(&format!(
                "SELECT toString(report_id)                     AS id, \
                        toInt64(toUnixTimestamp(max(at)))       AS ran \
                 FROM {}.report_runs GROUP BY report_id",
                self.quoted()
            ))
            .await?;
        Ok(rows.into_iter().map(|r| (r.id, r.ran)).collect())
    }

    pub async fn save_report(&self, input: ReportInput) -> Result<()> {
        self.ensure().await?;
        let name = input.name.trim();
        if name.is_empty() {
            return Err(Error::BadRequest("a report needs a name".into()));
        }
        // Both halves parsed before storing, for the same reason a dashboard's
        // layout is: a report that cannot be read is one that sits in the list
        // looking scheduled and never runs.
        crate::reports::Spec::parse(&input.spec).map_err(Error::BadRequest)?;
        let schedule =
            crate::reports::Schedule::parse(&input.schedule).map_err(Error::BadRequest)?;

        let timezone = input.timezone.trim().to_string();
        if !timezone.is_empty() {
            if !schedule.reads_a_wall_clock() {
                return Err(Error::BadRequest(
                    "an interval schedule has no opinion about when a day starts, so a \
                     timezone would change nothing — leave it empty, or schedule this \
                     daily or weekly"
                        .into(),
                ));
            }
            crate::clickhouse::check_timezone(&self.ch, &timezone).await?;
        }
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
            ("timezone".to_string(), timezone),
            ("webhook".to_string(), input.webhook.trim().to_string()),
            ("enabled".to_string(), u8::from(input.enabled).to_string()),
        ];
        if let Some(id) = &input.id {
            params.push(("id".to_string(), id.clone()));
        }

        self.ch
            .execute(
                &format!(
                    "INSERT INTO {}.reports \
                 (id, name, spec, schedule, webhook, enabled, created_at, updated_at, \
                  deleted, version, timezone) \
                 SELECT {id_expr}, {{name:String}}, unhex({{spec:String}}), {{schedule:String}}, \
                        {{webhook:String}}, {{enabled:UInt8}}, now64(3), now64(3), 0, \
                        toUnixTimestamp64Milli(now64(3)), {{timezone:String}}",
                    self.quoted()
                ),
                QueryOptions {
                    params,
                    ..self.write_opts()
                },
            )
            .await
    }

    pub async fn remove_report(&self, id: &str) -> Result<()> {
        self.ensure().await?;
        self.ch
            .execute(
                &format!(
                    "INSERT INTO {}.reports \
                 (id, name, spec, schedule, webhook, enabled, created_at, updated_at, \
                  deleted, version, timezone) \
                 SELECT {{id:UUID}}, '', '', '', '', 0, now64(3), now64(3), 1, \
                        toUnixTimestamp64Milli(now64(3)), ''",
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
    pub async fn report_runs(&self, report_id: Option<&str>, limit: u64) -> Result<Vec<ReportRun>> {
        self.ensure().await?;
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
        self.ch
            .rows_with(
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
    pub async fn report_snapshot(&self, run_id: &str) -> Result<ReportSnapshot> {
        self.ensure().await?;
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
        self.ch
            .row_with(
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
        run_id: &str,
        report: &Report,
        status: &str,
        sections_json: &str,
        section_count: usize,
        error: &str,
        delivery: &crate::alerts::Delivery,
    ) -> Result<()> {
        self.ensure().await?;
        self.ch
            .execute(
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

    // ── Jobs ────────────────────────────────────────────────────────────

    /// Write a job's current state.
    ///
    /// One insert per transition, versioned by the caller: the reader collapses
    /// them with `argMax`, so "running" written at version 1 and "done" written
    /// at version 2 read as one job that finished. There is no UPDATE here
    /// because ClickHouse's is a mutation — a rewrite of parts — and a job that
    /// changes state three times must not cost three rewrites.
    #[allow(clippy::too_many_arguments)]
    pub async fn write_job(&self, job: &JobRow) -> Result<()> {
        self.ensure().await?;
        self.ch
            .execute(
                &format!(
                    "INSERT INTO {}.jobs \
                 SELECT {{id:UUID}}, {{kind:String}}, unhex({{label:String}}), \
                        unhex({{target:String}}), unhex({{statement:String}}), \
                        {{by:String}}, {{tier:String}}, {{query_id:String}}, \
                        {{state:String}}, unhex({{detail:String}}), \
                        fromUnixTimestamp64Milli({{started:Int64}}), \
                        fromUnixTimestamp64Milli({{finished:Int64}}), \
                        {{version:UInt64}}",
                    self.quoted()
                ),
                QueryOptions {
                    params: vec![
                        ("id".into(), job.id.clone()),
                        ("kind".into(), job.kind.clone()),
                        ("label".into(), Self::text(&job.label)),
                        ("target".into(), Self::text(&job.target)),
                        ("statement".into(), Self::text(&job.statement)),
                        ("by".into(), job.submitted_by.clone()),
                        ("tier".into(), job.tier.clone()),
                        ("query_id".into(), job.query_id.clone()),
                        ("state".into(), job.state.clone()),
                        ("detail".into(), Self::text(&job.detail)),
                        ("started".into(), job.started_ms.to_string()),
                        // Zero rather than null while it runs: `finished_at` is not
                        // nullable, and the state says whether it means anything.
                        ("finished".into(), job.finished_ms.to_string()),
                        ("version".into(), job.version.to_string()),
                    ],
                    ..self.write_opts()
                },
            )
            .await
    }

    /// The most recent jobs, newest first.
    pub async fn jobs(&self, limit: u64) -> Result<Vec<Job>> {
        self.ensure().await?;
        // Aggregated inside, ordered outside. Aliasing an aggregate as the
        // column it aggregates — `min(started_at) AS started_at` — makes a
        // later `ORDER BY started_at` resolve to the alias, and ClickHouse
        // rejects the aggregate-inside-an-aggregate that results. A subquery
        // sidesteps the whole question: the inner names are plain columns by
        // the time anything sorts on them.
        let sql = format!(
            "SELECT id, kind, label, target, submitted_by, tier, state, detail, \
                    toString(started_ts) AS started_at, \
                    toInt64(toUnixTimestamp64Milli(started_ts)) AS started_ms, \
                    finished_at \
             FROM ( \
                SELECT toString(id)                            AS id, \
                       argMax(kind, version)                   AS kind, \
                       argMax(label, version)                  AS label, \
                       argMax(target, version)                 AS target, \
                       argMax(submitted_by, version)           AS submitted_by, \
                       argMax(tier, version)                   AS tier, \
                       argMax(state, version)                  AS state, \
                       argMax(detail, version)                 AS detail, \
                       min(started_at)                         AS started_ts, \
                       argMax(toString(finished_at), version)  AS finished_at \
                FROM {}.jobs \
                GROUP BY id \
             ) \
             ORDER BY started_ts DESC \
             LIMIT {}",
            self.quoted(),
            limit.clamp(1, 200)
        );
        let mut jobs: Vec<Job> = self.ch.rows(&sql).await?;
        for job in &mut jobs {
            drop_epoch_finish(job);
        }
        Ok(jobs)
    }

    /// One job, whatever state it is in.
    pub async fn job(&self, id: &str) -> Result<Option<Job>> {
        Ok(self.jobs(200).await?.into_iter().find(|j| j.id == id))
    }

    /// Every job still claiming to run, with what it would take to find it
    /// again on the server.
    pub async fn running_jobs(&self) -> Result<Vec<Job>> {
        Ok(self
            .jobs(200)
            .await?
            .into_iter()
            .filter(|j| j.state == "running")
            .collect())
    }

    // ── Alerts ──────────────────────────────────────────────────────────

    /// Every alert, with where it currently stands.
    ///
    /// The state comes from the event log rather than from the scheduler's
    /// memory, so the list reads the same in a browser opened after a restart
    /// as it did before one.
    pub async fn alerts(&self) -> Result<Vec<Alert>> {
        self.ensure().await?;
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
        self.ch.rows(&sql).await
    }

    /// The last state of every alert, for the scheduler to resume from so a
    /// restart does not re-announce what was already firing.
    pub async fn last_states(
        &self,
    ) -> Result<std::collections::HashMap<String, crate::alerts::State>> {
        self.ensure().await?;
        #[derive(Deserialize)]
        struct Row {
            id: String,
            last_state: String,
        }
        let rows: Vec<Row> = self
            .ch
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

    pub async fn save_alert(&self, input: AlertInput) -> Result<()> {
        self.ensure().await?;
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

        self.ch
            .execute(
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

    pub async fn remove_alert(&self, id: &str) -> Result<()> {
        self.ensure().await?;
        self.ch
            .execute(
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
        alert_id: Option<&str>,
        limit: u64,
    ) -> Result<Vec<AlertEvent>> {
        self.ensure().await?;
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
        self.ch
            .rows_with(
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
        alert: &Alert,
        state: crate::alerts::State,
        value: Option<f64>,
        message: &str,
        delivery: &crate::alerts::Delivery,
    ) -> Result<()> {
        self.ensure().await?;
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

        self.ch
            .execute(
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
    pub async fn remove(&self, id: &str) -> Result<()> {
        self.ensure().await?;
        let sql = format!(
            "INSERT INTO {}.saved_queries \
             SELECT {{id:UUID}}, '', '', '', now64(3), now64(3), 1, \
                    toUnixTimestamp64Milli(now64(3))",
            self.quoted()
        );
        self.ch
            .execute(
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

    /// A workspace over a connection to nowhere.
    ///
    /// Both properties below are decided before anything is sent — the quoting
    /// of a name and the settings on a statement — so the address is never
    /// dialled. Naming a port nothing listens on keeps it that way: a test that
    /// silently started talking to a real server would be worse than one that
    /// fails.
    fn workspace(database: &str) -> Workspace {
        let mut config = <crate::config::Config as clap::Parser>::parse_from(["flint"]);
        config.clickhouse_url = Some("http://127.0.0.1:1".into());
        Workspace::new(database.into(), Client::new(&config).expect("client"))
    }

    #[test]
    fn quotes_a_database_name_that_needs_it() {
        assert_eq!(workspace("flint").quoted(), "`flint`");
        assert_eq!(workspace("odd name").quoted(), "`odd name`");
        assert_eq!(workspace("a`b").quoted(), "`a\\`b`");
    }

    #[test]
    fn workspace_writes_are_allowed_even_in_read_only_mode() {
        // FLINT_READONLY is a promise about the user's tables, not about Flint's
        // own; without this a read-only deployment could never save anything.
        assert!(workspace("flint").write_opts().allow_write);
    }

    // ── Where a revision sits in its life ───────────────────────────────

    // ── Exposing tables ─────────────────────────────────────────────────

    #[test]
    fn a_sorting_key_becomes_the_columns_a_caller_may_order_by() {
        assert_eq!(sorting_columns("device_id, day"), vec!["device_id", "day"]);
        assert_eq!(sorting_columns("day"), vec!["day"]);
    }

    #[test]
    fn an_expression_in_a_sorting_key_is_dropped_rather_than_offered() {
        // `?order=toYYYYMM(at)` is not a column the shape layer will accept, so
        // offering it would be offering a refusal.
        assert_eq!(
            sorting_columns("toYYYYMM(at), device_id"),
            vec!["device_id"]
        );
        assert_eq!(sorting_columns("cityHash64(id) % 16"), Vec::<String>::new());
    }

    #[test]
    fn a_table_with_no_sorting_key_offers_no_sort() {
        // Which is the honest answer: nothing is stored in an order, so every
        // sort is a full sort, and inviting one over HTTP is inviting a bad
        // afternoon.
        assert_eq!(sorting_columns(""), Vec::<String>::new());
        assert_eq!(sorting_columns("   "), Vec::<String>::new());
    }

    #[test]
    fn a_row_written_before_states_existed_reads_as_live() {
        // `ALTER ... ADD COLUMN` left an empty string on every row that
        // predates the column, and those rows have been answering all along.
        // Reading them as anything else would take a working endpoint off the
        // air the first time a newer binary booted against the same workspace.
        assert_eq!(State::parse(""), State::Live);
        assert!(State::parse("").answers());
    }

    #[test]
    fn a_state_this_binary_has_never_heard_of_reads_as_live() {
        // The forgiving default is right *here* and wrong at the API, where
        // `set_state` parses strictly: a column written by something that knew
        // a rule this binary does not should not silently take an address off
        // the air, but a button must never guess.
        assert_eq!(State::parse("something-later"), State::Live);
    }

    #[test]
    fn every_state_survives_the_round_trip_through_the_column() {
        for state in [State::Draft, State::Live, State::Retiring, State::Retired] {
            assert_eq!(State::parse(state.as_str()), state);
        }
    }

    #[test]
    fn only_live_and_retiring_answer_a_caller() {
        // A draft is reachable at no address and a retired revision answers
        // exactly as one that never existed. Both are 404s, and deliberately
        // the same 404 a wrong address gives: whether an address is not yet
        // open, or finished, is not a caller's business.
        assert!(State::Live.answers());
        assert!(State::Retiring.answers());
        assert!(!State::Draft.answers());
        assert!(!State::Retired.answers());
    }
}

/// A job as it is written: everything the row holds, assembled by the runner.
#[derive(Debug, Clone)]
pub struct JobRow {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub target: String,
    pub statement: String,
    pub submitted_by: String,
    pub tier: String,
    pub query_id: String,
    pub state: String,
    pub detail: String,
    pub started_ms: i64,
    pub finished_ms: i64,
    pub version: u64,
}

/// A job as it is read.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub target: String,
    pub submitted_by: String,
    pub tier: String,
    /// `running`, `done`, `failed`, `cancelled` or `interrupted`.
    pub state: String,
    /// The outcome in a sentence, or the error. Empty while it runs.
    pub detail: String,
    pub started_at: String,
    /// The same instant in milliseconds. Carried because recovery has to rewrite
    /// the row *without moving it* — the table is partitioned by month and has a
    /// thirty-day TTL, so a rewrite that forgets when the job started lands in
    /// 1970 and is deleted by the TTL on the way in. Which is how that was
    /// found.
    pub started_ms: i64,
    pub finished_at: String,
}

/// Blank a finish time that never happened.
///
/// `finished_at` is not nullable — a `Nullable(DateTime64)` in a ReplacingMergeTree
/// buys nothing here — so a job that has not finished carries the epoch. And 1970
/// is not an *absent* figure, it is a wrong one: dropped, so a reader can leave
/// the column empty rather than printing a date from before ClickHouse existed.
fn drop_epoch_finish(job: &mut Job) {
    if job.finished_at.starts_with("1970-01-01") {
        job.finished_at.clear();
    }
}

#[cfg(test)]
mod job_tests {
    use super::*;

    fn job(finished_at: &str) -> Job {
        Job {
            id: "aaaaaaaa-1111-4222-8333-444455556666".into(),
            kind: "optimize".into(),
            label: "Optimize analytics.events".into(),
            target: "analytics.events".into(),
            submitted_by: "analyst".into(),
            tier: "ddl".into(),
            state: "running".into(),
            detail: String::new(),
            started_at: "2026-08-25 12:22:43.782".into(),
            started_ms: 1_787_000_000_000,
            finished_at: finished_at.into(),
        }
    }

    #[test]
    fn an_unfinished_job_reports_no_finish_time() {
        let mut j = job("1970-01-01 00:00:00.000");
        drop_epoch_finish(&mut j);
        assert_eq!(
            j.finished_at, "",
            "the epoch is a wrong figure, not an absent one"
        );
    }

    #[test]
    fn a_real_finish_time_is_left_alone() {
        let mut j = job("2026-08-25 12:22:58.593");
        drop_epoch_finish(&mut j);
        assert_eq!(j.finished_at, "2026-08-25 12:22:58.593");
    }
}
