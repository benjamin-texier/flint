//! Everything Flint knows how to ask `system.*`.
//!
//! Two rules here. First, prefer `system.parts` over `system.tables` for
//! sizes: `total_bytes` is null for a lot of engines, whereas summing active
//! parts always works for anything MergeTree-shaped. Second, no query may
//! reference a `system.*` column unconditionally unless it has existed since
//! ClickHouse 21 — newer columns go through `Client::col_or` so that pointing
//! Flint at an older server degrades a field instead of failing a page.

use serde::{Deserialize, Serialize};

use super::{Client, QueryOptions};
use crate::error::{Error, Result};

/// What kind of object a row in `system.tables` actually describes.
pub fn classify(engine: &str) -> &'static str {
    match engine {
        "View" => "view",
        "MaterializedView" => "materialized_view",
        "LiveView" | "WindowView" => "view",
        "Dictionary" => "dictionary",
        _ => "table",
    }
}

fn is_nullable(ch_type: &str) -> bool {
    ch_type.starts_with("Nullable(") || ch_type.starts_with("LowCardinality(Nullable(")
}

/// ClickHouse has no `system.tables.ttl` column, so the table-level TTL is
/// recovered from the CREATE statement. Clause order in `create_table_query`
/// is fixed by the parser, so a bounded scan between `TTL` and the clauses
/// that can follow it is reliable.
fn extract_ttl(create_query: &str) -> Option<String> {
    let start = create_query.find(" TTL ")? + 5;
    let rest = &create_query[start..];
    let end = ["\nSETTINGS ", " SETTINGS ", "\nCOMMENT ", " COMMENT "]
        .iter()
        .filter_map(|marker| rest.find(marker))
        .min()
        .unwrap_or(rest.len());
    let ttl = rest[..end].trim();
    (!ttl.is_empty()).then(|| ttl.to_string())
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfo {
    pub version: String,
    pub uptime_seconds: u64,
    pub timezone: String,
    pub current_user: String,
    pub current_database: String,
    pub databases: u64,
    pub tables: u64,
}

pub async fn server_info(ch: &Client) -> Result<ServerInfo> {
    ch.row(
        "SELECT version()                                   AS version, \
                uptime()                                    AS uptime_seconds, \
                timezone()                                  AS timezone, \
                currentUser()                               AS current_user, \
                currentDatabase()                           AS current_database, \
                (SELECT count() FROM system.databases)      AS databases, \
                (SELECT count() FROM system.tables)         AS tables",
    )
    .await?
    .ok_or_else(|| Error::Decode("ClickHouse returned no server info".into()))
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseSummary {
    pub name: String,
    #[serde(default)]
    pub engine: String,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub tables: u64,
    #[serde(default)]
    pub views: u64,
    #[serde(default)]
    pub materialized_views: u64,
    #[serde(default)]
    pub dictionaries: u64,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub rows: u64,
}

pub async fn databases(ch: &Client) -> Result<Vec<DatabaseSummary>> {
    let comment = ch.col_or("databases", "comment", "''").await?;

    // Built twice from one template rather than edited afterwards: the fallback
    // has to be a query that really has no `system.parts` in it, and string
    // surgery on SQL that happens to miss its target silently produces the
    // original again.
    let build = |sizes: bool| {
        let (bytes, rows, join) = if sizes {
            (
                "coalesce(p.bytes, 0)",
                "coalesce(p.rows, 0)",
                "LEFT JOIN ( \
                     SELECT database, sum(bytes_on_disk) AS bytes, sum(rows) AS rows \
                     FROM system.parts WHERE active GROUP BY database \
                 ) AS p ON p.database = d.name",
            )
        } else {
            ("0", "0", "")
        };
        format!(
            "SELECT d.name                            AS name, \
                    d.engine                           AS engine, \
                    {comment}                          AS comment, \
                    coalesce(c.tables, 0)              AS tables, \
                    coalesce(c.views, 0)               AS views, \
                    coalesce(c.materialized_views, 0)  AS materialized_views, \
                    coalesce(c.dictionaries, 0)        AS dictionaries, \
                    {bytes}                            AS bytes, \
                    {rows}                             AS rows \
             FROM system.databases AS d \
             LEFT JOIN ( \
                 SELECT database, \
                        countIf(engine NOT LIKE '%View' AND engine != 'Dictionary') AS tables, \
                        countIf(engine LIKE '%View' AND engine != 'MaterializedView') AS views, \
                        countIf(engine = 'MaterializedView') AS materialized_views, \
                        countIf(engine = 'Dictionary') AS dictionaries \
                 FROM system.tables \
                 /* Count an INFORMATION_SCHEMA view once, not once per case \
                    alias, so this agrees with the object list. */ \
                 WHERE lower(database) != 'information_schema' OR name = lower(name) \
                 GROUP BY database \
             ) AS c ON c.database = d.name \
             {join} \
             ORDER BY d.name"
        )
    };

    let mut rows: Vec<DatabaseSummary> = or_without_parts(
        ch,
        &build(true),
        &build(false),
        QueryOptions {
            introspection: true,
            ..Default::default()
        },
    )
    .await?;
    collapse_information_schema(&mut rows);
    Ok(rows)
}

/// ClickHouse publishes the SQL-standard metadata database under two names —
/// `information_schema` for PostgreSQL's spelling and `INFORMATION_SCHEMA` for
/// MySQL's — holding the same views. Its *views* are already counted once; two
/// rows for the same database is the same duplication one level up, so the
/// upper-case twin goes the same way. Only when its lower-case twin is really
/// there: a server that publishes just the one must still list it.
fn collapse_information_schema(rows: &mut Vec<DatabaseSummary>) {
    let has_lower = rows.iter().any(|d| d.name == "information_schema");
    rows.retain(|d| {
        !(has_lower && is_information_schema(&d.name) && d.name != "information_schema")
    });
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableSummary {
    pub name: String,
    #[serde(default)]
    pub engine: String,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub total_rows: Option<u64>,
    #[serde(default)]
    pub total_bytes: Option<u64>,
    #[serde(default)]
    pub parts_rows: u64,
    #[serde(default)]
    pub parts_bytes: u64,
    #[serde(default)]
    pub sorting_key: String,
    #[serde(default)]
    pub primary_key: String,
    #[serde(default)]
    pub partition_key: String,
    #[serde(default)]
    pub modified: String,
    #[serde(default)]
    pub columns: u64,
    /// Derived from `engine`; not a ClickHouse column.
    #[serde(default)]
    pub kind: String,
}

/// Every table the explorer should list. `INFORMATION_SCHEMA`'s upper-case
/// aliases are collapsed away here; a lookup by name must go through
/// [`all_tables`] instead, or the name ClickHouse itself publishes would come
/// back as one that does not exist.
pub async fn tables(ch: &Client, database: &str) -> Result<Vec<TableSummary>> {
    let mut rows = all_tables(ch, database).await?;
    collapse_case_aliases(database, &mut rows);
    Ok(rows)
}

/// The same listing with nothing hidden, for resolving a name.
/// Run `full`, and if the only obstacle was `system.parts`, run `without` —
/// the listing minus its sizes.
///
/// A read-only role granted `system.tables` but not `system.parts` is a normal
/// deployment, and it used to lose the entire object list to a 403: the size
/// columns come from a join, and one denied join fails the whole statement.
/// Sizes are worth having; they are not worth the explorer for.
async fn or_without_parts<T: serde::de::DeserializeOwned>(
    ch: &Client,
    full: &str,
    without: &str,
    opts: QueryOptions,
) -> Result<Vec<T>> {
    match ch.rows_with::<T>(full, opts.clone()).await {
        Ok(rows) => Ok(rows),
        Err(e @ (Error::ClickHouse { code: 497, .. } | Error::ClickHouse { code: 164, .. })) => {
            tracing::debug!("listing without part sizes: {e}");
            ch.rows_with::<T>(without, opts).await
        }
        Err(e) => Err(e),
    }
}

async fn all_tables(ch: &Client, database: &str) -> Result<Vec<TableSummary>> {
    let comment = ch.col_or("tables", "comment", "''").await?;

    let build = |sizes: bool| {
        let (rows_expr, bytes_expr, join) = if sizes {
            (
                "coalesce(p.rows, 0)",
                "coalesce(p.bytes, 0)",
                "LEFT JOIN ( \
                     SELECT table, sum(rows) AS rows, sum(bytes_on_disk) AS bytes \
                     FROM system.parts \
                     WHERE active AND database = {db:String} GROUP BY table \
                 ) AS p ON p.table = t.name",
            )
        } else {
            ("0", "0", "")
        };
        format!(
            "SELECT t.name                      AS name, \
                    t.engine                     AS engine, \
                    {comment}                    AS comment, \
                    t.total_rows                 AS total_rows, \
                    t.total_bytes                AS total_bytes, \
                    {rows_expr}                  AS parts_rows, \
                    {bytes_expr}                 AS parts_bytes, \
                    t.sorting_key                AS sorting_key, \
                    t.primary_key                AS primary_key, \
                    t.partition_key              AS partition_key, \
                    toString(t.metadata_modification_time) AS modified, \
                    coalesce(c.columns, 0)       AS columns \
             FROM system.tables AS t \
             {join} \
             LEFT JOIN ( \
                 SELECT table, count() AS columns \
                 FROM system.columns \
                 WHERE database = {{db:String}} GROUP BY table \
             ) AS c ON c.table = t.name \
             WHERE t.database = {{db:String}} \
             ORDER BY t.name"
        )
    };

    let opts = QueryOptions {
        params: vec![("db".into(), database.to_string())],
        quote_64bit_integers: false,
        introspection: true,
        ..Default::default()
    };
    let mut rows: Vec<TableSummary> =
        or_without_parts(ch, &build(true), &build(false), opts).await?;
    for row in &mut rows {
        row.kind = classify(&row.engine).to_string();
    }
    Ok(rows)
}

/// True for the two databases ClickHouse keeps as SQL-standard metadata.
pub fn is_information_schema(database: &str) -> bool {
    database.eq_ignore_ascii_case("information_schema")
}

/// ClickHouse publishes every `INFORMATION_SCHEMA` view twice — once in lower
/// case for PostgreSQL compatibility and once in upper case for MySQL's. Both
/// names address the same view with the same columns and the same rows, so
/// listing both doubles the database and tells you nothing. Keep the lower-case
/// name, which is the one ClickHouse's own documentation uses.
fn collapse_case_aliases(database: &str, rows: &mut Vec<TableSummary>) {
    if !is_information_schema(database) {
        return;
    }
    let lowercase: std::collections::HashSet<String> = rows
        .iter()
        .filter(|r| r.name.chars().all(|c| !c.is_uppercase()))
        .map(|r| r.name.to_lowercase())
        .collect();
    // Drop an upper-case name only when its lower-case twin is actually there;
    // a view that exists solely in upper case must still be listed.
    rows.retain(|r| {
        r.name.chars().all(|c| !c.is_uppercase()) || !lowercase.contains(&r.name.to_lowercase())
    });
}

// ---------------------------------------------------------------------------
// One table, in full
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnDetail {
    pub name: String,
    pub r#type: String,
    #[serde(default)]
    pub position: u64,
    #[serde(default)]
    pub default_kind: String,
    #[serde(default)]
    pub default_expression: String,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub compression_codec: String,
    #[serde(default)]
    pub ttl_expression: String,
    #[serde(default, deserialize_with = "de_bool")]
    pub in_partition_key: bool,
    #[serde(default, deserialize_with = "de_bool")]
    pub in_sorting_key: bool,
    #[serde(default, deserialize_with = "de_bool")]
    pub in_primary_key: bool,
    #[serde(default, deserialize_with = "de_bool")]
    pub in_sampling_key: bool,
    #[serde(default)]
    pub compressed_bytes: u64,
    #[serde(default)]
    pub uncompressed_bytes: u64,
    /// Derived from `type`; not a ClickHouse column.
    #[serde(default)]
    pub nullable: bool,
}

/// `system.columns` flags are `UInt8`.
fn de_bool<'de, D>(d: D) -> std::result::Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(u8::deserialize(d)? != 0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartitionSummary {
    pub partition: String,
    #[serde(default)]
    pub parts: u64,
    #[serde(default)]
    pub rows: u64,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub uncompressed_bytes: u64,
    #[serde(default)]
    pub min_date: String,
    #[serde(default)]
    pub max_date: String,
    #[serde(default)]
    pub modified: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectionSummary {
    pub name: String,
    #[serde(default)]
    pub r#type: String,
    /// `system.projections.sorting_key` is `Array(String)`, one entry per
    /// expression, so it is joined for display rather than shown as an array.
    #[serde(default)]
    pub sorting_key: Vec<String>,
    #[serde(default)]
    pub query: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TableRef {
    pub database: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TableDetail {
    pub database: String,
    #[serde(flatten)]
    pub summary: TableSummary,
    pub engine_full: String,
    pub create_query: String,
    pub sampling_key: String,
    pub ttl: Option<String>,
    pub as_select: String,
    pub uncompressed_bytes: u64,
    pub parts: u64,
    pub data_paths: Vec<String>,
    pub columns: Vec<ColumnDetail>,
    pub partitions: Vec<PartitionSummary>,
    pub projections: Vec<ProjectionSummary>,
    /// For a materialized view created without a TO clause: the table
    /// ClickHouse made to hold its rows. The figures on this detail are that
    /// table's, and saying which table they came from is the difference between
    /// explaining a number and inventing one.
    pub storage: Option<String>,
    /// Objects that read from this table (materialized views, mostly).
    pub dependents: Vec<TableRef>,
    /// Objects this table reads from — the inverse edge, for views.
    pub depends_on: Vec<TableRef>,
}

#[derive(Deserialize)]
struct TableRow {
    #[serde(default)]
    engine_full: String,
    #[serde(default)]
    create_query: String,
    #[serde(default)]
    uuid: String,
    #[serde(default)]
    sampling_key: String,
    #[serde(default)]
    as_select: String,
    #[serde(default)]
    data_paths: Vec<String>,
    #[serde(default)]
    dependencies_database: Vec<String>,
    #[serde(default)]
    dependencies_table: Vec<String>,
}

#[derive(Deserialize)]
struct PartsRollup {
    #[serde(default)]
    parts: u64,
    #[serde(default)]
    uncompressed_bytes: u64,
}

#[derive(Deserialize)]
struct DepRow {
    database: String,
    name: String,
    #[serde(default)]
    engine: String,
}

pub async fn table_detail(ch: &Client, database: &str, table: &str) -> Result<TableDetail> {
    let params = vec![
        ("db".into(), database.to_string()),
        ("tbl".into(), table.to_string()),
    ];
    let opts = || QueryOptions {
        params: params.clone(),
        quote_64bit_integers: false,
        introspection: true,
        ..Default::default()
    };

    // Not `tables`: asking for `INFORMATION_SCHEMA.COLUMNS` — the spelling
    // ClickHouse publishes and the one a MySQL-shaped query writes — must open
    // the view rather than deny it exists, even though the explorer lists only
    // its lower-case twin.
    let tables = all_tables(ch, database).await?;
    let mut summary = tables
        .iter()
        .find(|t| t.name == table)
        .cloned()
        .ok_or_else(|| Error::NotFound(format!("`{database}`.`{table}` does not exist")))?;

    let as_select = ch.col_or("tables", "as_select", "''").await?;
    let uuid_col = ch.col_or("tables", "uuid", "''").await?;
    let row: TableRow = ch
        .row_with(
            &format!(
                "SELECT engine_full                AS engine_full, \
                        create_table_query          AS create_query, \
                        toString({uuid_col})        AS uuid, \
                        sampling_key                AS sampling_key, \
                        {as_select}                 AS as_select, \
                        data_paths                  AS data_paths, \
                        dependencies_database       AS dependencies_database, \
                        dependencies_table          AS dependencies_table \
                 FROM system.tables \
                 WHERE database = {{db:String}} AND name = {{tbl:String}}"
            ),
            opts(),
        )
        .await?
        .ok_or_else(|| Error::NotFound(format!("`{database}`.`{table}` does not exist")))?;

    // A materialized view created without a TO clause keeps its rows in a table
    // ClickHouse named after the view's uuid. The view itself reports no rows,
    // no size and no parts, which leaves this page saying nothing about an
    // object that may hold gigabytes — so the storage's figures are read here
    // and the page says where they came from.
    let storage = if classify(&summary.engine) == "materialized_view" {
        [format!(".inner_id.{}", row.uuid), format!(".inner.{table}")]
            .into_iter()
            .filter(|name| !name.ends_with('.'))
            .find_map(|name| tables.iter().find(|t| t.name == name))
    } else {
        None
    };

    if let Some(inner) = storage {
        summary.total_rows = inner.total_rows.or(Some(inner.parts_rows));
        summary.total_bytes = inner.total_bytes.or(Some(inner.parts_bytes));
        summary.parts_rows = inner.parts_rows;
        summary.parts_bytes = inner.parts_bytes;
        // A view has no keys of its own; the ones that matter are the storage's,
        // and they are what a reader of this page is asking about.
        if summary.sorting_key.is_empty() {
            summary.sorting_key = inner.sorting_key.clone();
            summary.primary_key = inner.primary_key.clone();
            summary.partition_key = inner.partition_key.clone();
        }
    }

    // Parts, partitions and the uncompressed extent all come from
    // `system.parts`, which knows the storage table rather than the view.
    let parts_table = storage
        .map(|t| t.name.clone())
        .unwrap_or_else(|| table.to_string());
    let parts_params = vec![
        ("db".into(), database.to_string()),
        ("tbl".into(), parts_table),
    ];
    let parts_opts = || QueryOptions {
        params: parts_params.clone(),
        quote_64bit_integers: false,
        introspection: true,
        ..Default::default()
    };

    // Column-level metadata. `ttl_expression` and `compression_codec` are
    // relatively recent, so guard both.
    let ttl_expression = ch.col_or("columns", "ttl_expression", "''").await?;
    let codec = ch.col_or("columns", "compression_codec", "''").await?;
    let mut columns: Vec<ColumnDetail> = ch
        .rows_with(
            &format!(
                "SELECT name                        AS name, \
                        type                        AS type, \
                        position                    AS position, \
                        default_kind                AS default_kind, \
                        default_expression          AS default_expression, \
                        comment                     AS comment, \
                        {codec}                     AS compression_codec, \
                        {ttl_expression}            AS ttl_expression, \
                        is_in_partition_key         AS in_partition_key, \
                        is_in_sorting_key           AS in_sorting_key, \
                        is_in_primary_key           AS in_primary_key, \
                        is_in_sampling_key          AS in_sampling_key, \
                        data_compressed_bytes       AS compressed_bytes, \
                        data_uncompressed_bytes     AS uncompressed_bytes \
                 FROM system.columns \
                 WHERE database = {{db:String}} AND table = {{tbl:String}} \
                 ORDER BY position"
            ),
            opts(),
        )
        .await?;
    for col in &mut columns {
        col.nullable = is_nullable(&col.r#type);
    }

    // Same rule as the listings: a role granted the table but not
    // `system.parts` loses the storage figures, not the page. Opening a table
    // used to 403 for exactly the read-only role Flint is meant to suit.
    let rollup: PartsRollup = match ch
        .row_with::<PartsRollup>(
            "SELECT count()                       AS parts, \
                sum(data_uncompressed_bytes)   AS uncompressed_bytes \
         FROM system.parts \
         WHERE active AND database = {db:String} AND table = {tbl:String}",
            parts_opts(),
        )
        .await
    {
        Ok(row) => row.unwrap_or(PartsRollup {
            parts: 0,
            uncompressed_bytes: 0,
        }),
        Err(e @ (Error::ClickHouse { code: 497, .. } | Error::ClickHouse { code: 164, .. })) => {
            tracing::debug!("table detail without part sizes: {e}");
            PartsRollup {
                parts: 0,
                uncompressed_bytes: 0,
            }
        }
        Err(e) => return Err(e),
    };

    let partitions: Vec<PartitionSummary> = match ch
        .rows_with(
            "SELECT partition                       AS partition, \
                    count()                          AS parts, \
                    sum(rows)                        AS rows, \
                    sum(bytes_on_disk)               AS bytes, \
                    sum(data_uncompressed_bytes)     AS uncompressed_bytes, \
                    toString(min(min_date))          AS min_date, \
                    toString(max(max_date))          AS max_date, \
                    toString(max(modification_time)) AS modified \
             FROM system.parts \
             WHERE active AND database = {db:String} AND table = {tbl:String} \
             GROUP BY partition \
             ORDER BY partition \
             LIMIT 500",
            parts_opts(),
        )
        .await
    {
        Ok(rows) => rows,
        Err(Error::ClickHouse { code: 497, .. } | Error::ClickHouse { code: 164, .. }) => {
            Vec::new()
        }
        Err(e) => return Err(e),
    };

    // `system.projections` only exists from 24.x onwards. Where it is absent
    // the tab simply reports none; where it is present but unreadable, say so
    // in the log rather than silently pretending the table has no projections.
    let projections: Vec<ProjectionSummary> = if ch.has_system_table("projections").await? {
        match ch
            .rows_with(
                "SELECT name              AS name, \
                        toString(type)     AS type, \
                        sorting_key        AS sorting_key, \
                        query              AS query \
                 FROM system.projections \
                 WHERE database = {db:String} AND table = {tbl:String} \
                 ORDER BY name",
                opts(),
            )
            .await
        {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("could not read projections for {database}.{table}: {e}");
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    let dependents: Vec<TableRef> = row
        .dependencies_database
        .iter()
        .zip(row.dependencies_table.iter())
        .map(|(db, name)| TableRef {
            database: db.clone(),
            name: name.clone(),
            kind: "materialized_view".into(),
        })
        .collect();

    // The inverse edge: whoever lists *us* among their dependencies is a
    // table we read from.
    let depends_on: Vec<TableRef> = ch
        .rows_with::<DepRow>(
            "SELECT database AS database, name AS name, engine AS engine \
             FROM system.tables \
             WHERE arrayExists( \
                 (d, t) -> d = {db:String} AND t = {tbl:String}, \
                 dependencies_database, dependencies_table \
             ) \
             ORDER BY database, name",
            opts(),
        )
        .await
        .inspect_err(|e| tracing::warn!("could not read lineage for {database}.{table}: {e}"))
        .unwrap_or_default()
        .into_iter()
        .map(|r| TableRef {
            database: r.database,
            name: r.name,
            kind: classify(&r.engine).to_string(),
        })
        .collect();

    Ok(TableDetail {
        database: database.to_string(),
        ttl: extract_ttl(&row.create_query),
        summary,
        engine_full: row.engine_full,
        create_query: row.create_query,
        sampling_key: row.sampling_key,
        as_select: row.as_select,
        uncompressed_bytes: rollup.uncompressed_bytes,
        parts: rollup.parts,
        data_paths: row.data_paths,
        columns,
        partitions,
        projections,
        storage: storage.map(|t| t.name.clone()),
        dependents,
        depends_on,
    })
}

// ---------------------------------------------------------------------------
// Autocomplete + query history
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaEntry {
    pub database: String,
    pub table: String,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub types: Vec<String>,
    /// Derived from the engine, so a search result can say "view" rather than
    /// calling everything a table. Empty where `system.tables` had no row —
    /// `system.columns` occasionally knows about something it does not.
    #[serde(default)]
    pub kind: String,
    /// Only used to derive `kind`; not sent to the client.
    #[serde(default, skip_serializing)]
    pub engine: String,
}

/// A flat schema snapshot the editor uses for suggestions. Capped so that a
/// server with tens of thousands of tables does not blow up the payload.
pub async fn schema(ch: &Client) -> Result<Vec<SchemaEntry>> {
    let mut rows: Vec<SchemaEntry> = ch
        .rows(
            "SELECT c.database              AS database, \
                    c.table                  AS table, \
                    groupArray(c.name)       AS columns, \
                    groupArray(c.type)       AS types, \
                    any(t.engine)            AS engine \
             FROM ( \
                 SELECT database, table, name, type \
                 FROM system.columns \
                 ORDER BY database, table, position \
                 LIMIT 200000 \
             ) AS c \
             LEFT JOIN system.tables AS t \
                 ON t.database = c.database AND t.name = c.table \
             GROUP BY c.database, c.table \
             ORDER BY c.database, c.table",
        )
        .await?;
    // Classified here rather than in SQL: `classify` is the one place that
    // decides what an engine name means, and two of them would drift.
    for row in &mut rows {
        row.kind = classify(&row.engine).to_string();
    }
    Ok(rows)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub query_id: String,
    pub query: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub event_time: String,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub read_rows: u64,
    #[serde(default)]
    pub read_bytes: u64,
    #[serde(default)]
    pub result_rows: u64,
    #[serde(default)]
    pub memory_usage: u64,
    #[serde(default)]
    pub exception: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub databases: Vec<String>,
}

/// Why the history is not available, when it is not.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum History {
    Available { entries: Vec<HistoryEntry> },
    Unavailable { reason: String },
}

/// Recent SELECTs from `system.query_log`.
///
/// The log can be switched off, created lazily, or simply not granted to this
/// user — none of which is a bug, so each is reported as a reason the panel can
/// show. Anything else propagates, because silently reporting "unavailable"
/// is how a real defect stays hidden.
pub async fn history(ch: &Client, limit: u64) -> Result<History> {
    // Asked of the log itself: `system.columns` is grant-filtered, so a role
    // that may not read the log cannot see its columns either, and reporting
    // "not enabled" would send the reader to change a server setting when what
    // they need is a GRANT.
    match ch.reach("query_log").await? {
        super::Reach::Readable => {}
        super::Reach::Denied => {
            return Ok(History::Unavailable {
                reason: "this user is not granted SELECT on system.query_log".into(),
            })
        }
        super::Reach::Absent => {
            return Ok(History::Unavailable {
                reason: "system.query_log is not enabled on this server".into(),
            })
        }
    }

    // The projection is wrapped around the filter rather than applied beside
    // it: aliasing `toString(event_time) AS event_time` in the same SELECT
    // shadows the real column, and the WHERE clause then compares a String to
    // a DateTime.
    //
    // Flint's own metadata queries are not the reader's history, so they are
    // left out by the tag Flint stamps on them. `log_comment` landed in
    // ClickHouse 21; on anything older they simply stay.
    let mine = if ch
        .system_columns("query_log")
        .await?
        .contains("log_comment")
    {
        format!("AND log_comment != '{}'", super::INTROSPECTION_TAG)
    } else {
        String::new()
    };
    let sql = format!(
        "SELECT query_id                   AS query_id, \
                query                       AS query, \
                toString(type)              AS kind, \
                toString(event_time)        AS event_time, \
                query_duration_ms           AS duration_ms, \
                read_rows                   AS read_rows, \
                read_bytes                  AS read_bytes, \
                result_rows                 AS result_rows, \
                memory_usage                AS memory_usage, \
                exception                   AS exception, \
                user                        AS user, \
                arrayDistinct(databases)    AS databases \
         FROM ( \
             SELECT query_id, query, type, event_time, query_duration_ms, \
                    read_rows, read_bytes, result_rows, memory_usage, \
                    exception, user, databases \
             FROM system.query_log \
             WHERE type != 'QueryStart' \
               AND event_time > now() - INTERVAL 7 DAY \
               AND query_kind = 'Select' \
               {mine} \
             ORDER BY event_time DESC \
             LIMIT {limit} \
         )",
        limit = limit.clamp(1, 1000)
    );

    match ch.rows(&sql).await {
        Ok(entries) => Ok(History::Available { entries }),
        // A read-only role often has no rights on query_log. That is a
        // configuration fact, not a failure — say so and move on.
        Err(Error::ClickHouse { code: 497, .. }) | Err(Error::ClickHouse { code: 164, .. }) => {
            Ok(History::Unavailable {
                reason: "this user is not granted SELECT on system.query_log".into(),
            })
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database(name: &str) -> DatabaseSummary {
        DatabaseSummary {
            name: name.into(),
            engine: "Atomic".into(),
            comment: String::new(),
            tables: 0,
            views: 10,
            materialized_views: 0,
            dictionaries: 0,
            bytes: 0,
            rows: 0,
        }
    }

    #[test]
    fn lists_the_metadata_database_once() {
        let mut rows = vec![
            database("default"),
            database("information_schema"),
            database("INFORMATION_SCHEMA"),
        ];
        collapse_information_schema(&mut rows);
        let names: Vec<&str> = rows.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, vec!["default", "information_schema"]);
    }

    #[test]
    fn keeps_an_upper_case_metadata_database_that_stands_alone() {
        let mut rows = vec![database("default"), database("INFORMATION_SCHEMA")];
        collapse_information_schema(&mut rows);
        let names: Vec<&str> = rows.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, vec!["default", "INFORMATION_SCHEMA"]);
    }

    fn summary(name: &str) -> TableSummary {
        TableSummary {
            name: name.into(),
            engine: "View".into(),
            comment: String::new(),
            total_rows: None,
            total_bytes: None,
            parts_rows: 0,
            parts_bytes: 0,
            sorting_key: String::new(),
            primary_key: String::new(),
            partition_key: String::new(),
            modified: String::new(),
            columns: 0,
            kind: "view".into(),
        }
    }

    fn names(rows: &[TableSummary]) -> Vec<&str> {
        rows.iter().map(|r| r.name.as_str()).collect()
    }

    #[test]
    fn collapses_the_case_aliases_information_schema_publishes_twice() {
        let mut rows = vec![
            summary("columns"),
            summary("COLUMNS"),
            summary("tables"),
            summary("TABLES"),
        ];
        collapse_case_aliases("INFORMATION_SCHEMA", &mut rows);
        assert_eq!(names(&rows), vec!["columns", "tables"]);
    }

    #[test]
    fn a_collapsed_alias_is_still_a_name_you_can_open() {
        // What the explorer lists and what a URL may legitimately ask for are
        // not the same set: `COLUMNS` is dropped from the listing but must
        // still resolve, which is why `table_detail` reads the uncollapsed one.
        let all = vec![summary("columns"), summary("COLUMNS")];
        let mut listed = all.clone();
        collapse_case_aliases("INFORMATION_SCHEMA", &mut listed);
        assert_eq!(names(&listed), vec!["columns"]);
        assert!(all.iter().any(|t| t.name == "COLUMNS"));
    }

    #[test]
    fn keeps_an_upper_case_name_with_no_lower_case_twin() {
        let mut rows = vec![summary("columns"), summary("ONLY_UPPER")];
        collapse_case_aliases("information_schema", &mut rows);
        assert_eq!(names(&rows), vec!["columns", "ONLY_UPPER"]);
    }

    #[test]
    fn leaves_every_other_database_alone() {
        // A real schema may legitimately hold `Events` and `events`.
        let mut rows = vec![summary("events"), summary("EVENTS")];
        collapse_case_aliases("analytics", &mut rows);
        assert_eq!(names(&rows), vec!["events", "EVENTS"]);
    }

    #[test]
    fn recognises_both_spellings_of_the_metadata_database() {
        assert!(is_information_schema("information_schema"));
        assert!(is_information_schema("INFORMATION_SCHEMA"));
        assert!(!is_information_schema("analytics"));
    }

    #[test]
    fn classifies_engines() {
        assert_eq!(classify("MergeTree"), "table");
        assert_eq!(classify("View"), "view");
        assert_eq!(classify("MaterializedView"), "materialized_view");
        assert_eq!(classify("Dictionary"), "dictionary");
    }

    #[test]
    fn detects_nullable_types() {
        assert!(is_nullable("Nullable(String)"));
        assert!(is_nullable("LowCardinality(Nullable(String))"));
        assert!(!is_nullable("String"));
        assert!(!is_nullable("LowCardinality(String)"));
    }

    #[test]
    fn pulls_the_table_ttl_out_of_a_create_statement() {
        let q = "CREATE TABLE d.t (`ts` DateTime) ENGINE = MergeTree \
                 PARTITION BY toYYYYMM(ts) ORDER BY ts \
                 TTL ts + toIntervalDay(30) SETTINGS index_granularity = 8192";
        assert_eq!(extract_ttl(q).as_deref(), Some("ts + toIntervalDay(30)"));
    }

    #[test]
    fn ttl_is_none_when_absent() {
        let q = "CREATE TABLE d.t (`ts` DateTime) ENGINE = MergeTree ORDER BY ts \
                 SETTINGS index_granularity = 8192";
        assert_eq!(extract_ttl(q), None);
    }

    #[test]
    fn ttl_runs_to_the_end_when_no_settings_follow() {
        let q = "CREATE TABLE d.t (`ts` DateTime) ENGINE = MergeTree ORDER BY ts \
                 TTL ts + INTERVAL 1 DAY";
        assert_eq!(extract_ttl(q).as_deref(), Some("ts + INTERVAL 1 DAY"));
    }
}
