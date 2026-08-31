//! Every table on this server whose rows are not on it.
//!
//! The object page answers the question one table at a time, which is the right
//! shape for "what is this table" and the wrong one for the question an operator
//! actually has. Credentials rotate on a bucket and thirty tables stop working
//! at once; a host is decommissioned and nobody knows which tables pointed at
//! it. Both are answerable off `system.tables` in one read, and until this
//! nothing in Flint asked.
//!
//! It sends the definitions and no judgement. Which far end two tables share,
//! and what to call it, is decided in `lib/outside` from the same parse the
//! object page uses — one reader for the address, so a bucket cannot be split
//! into two by two spellings of the same rule.
//!
//! `system` is left out. It holds no external table today, and if a future
//! ClickHouse puts one there it is the server's business rather than the
//! deployment's.

use serde::{Deserialize, Serialize};

use super::{Client, QueryOptions, Reach, Section};
use crate::error::Result;

/// Tables before the list stops being a page. A deployment with more than this
/// many external tables has a different question, and the count of what was
/// left out travels with the list either way.
const MAX_TABLES: usize = 500;

/// The engines named exactly. Prefix matching is done in SQL for the lake
/// families only, where ClickHouse ships one engine per storage — `IcebergS3`,
/// `IcebergAzure` — and they differ in where the files are rather than in what
/// the table is.
const NAMED: [&str; 22] = [
    "S3",
    "S3Queue",
    "GCS",
    "COSN",
    "OSS",
    "AzureBlobStorage",
    "AzureQueue",
    "HDFS",
    "URL",
    "File",
    "MySQL",
    "PostgreSQL",
    "MaterializedPostgreSQL",
    "MaterializedMySQL",
    "MongoDB",
    "SQLite",
    "Redis",
    "ODBC",
    "JDBC",
    "Kafka",
    "RabbitMQ",
    "NATS",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutsideTable {
    pub database: String,
    pub name: String,
    pub engine: String,
    /// The engine with its arguments — the address, as the server holds it and
    /// with its credentials already replaced by `[HIDDEN]`.
    pub engine_full: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Outside {
    pub tables: Section<OutsideTable>,
    /// What the server has against what the list holds, so a cap states itself.
    pub total: u64,
}

pub async fn outside(ch: &Client) -> Result<Outside> {
    let blocked = match ch.reach("tables").await? {
        Reach::Readable => None,
        Reach::Denied => Some("this user cannot read system.tables".to_string()),
        Reach::Absent | Reach::Unconfigured => {
            Some("this ClickHouse has no system.tables".to_string())
        }
    };
    if let Some(reason) = blocked {
        return Ok(Outside {
            tables: Section::blocked(reason),
            total: 0,
        });
    }

    let names = NAMED
        .iter()
        .map(|n| format!("'{n}'"))
        .collect::<Vec<_>>()
        .join(", ");
    let where_clause = format!(
        "lower(database) NOT IN ('system', 'information_schema') \
         AND (engine IN ({names}) \
              OR startsWith(engine, 'Iceberg') \
              OR startsWith(engine, 'DeltaLake') \
              OR startsWith(engine, 'Hudi') \
              OR startsWith(engine, 'Paimon'))"
    );

    let opts = || QueryOptions {
        introspection: true,
        ..Default::default()
    };

    #[derive(Deserialize)]
    struct Count {
        #[serde(default)]
        total: u64,
    }
    let total = ch
        .row_with(
            &format!("SELECT count() AS total FROM system.tables WHERE {where_clause}"),
            opts(),
        )
        .await?
        .map(|c: Count| c.total)
        .unwrap_or(0);

    let tables: Vec<OutsideTable> = ch
        .rows_with(
            &format!(
                "SELECT database     AS database, \
                        name         AS name, \
                        engine       AS engine, \
                        engine_full  AS engine_full \
                 FROM system.tables \
                 WHERE {where_clause} \
                 ORDER BY database, name \
                 LIMIT {MAX_TABLES}"
            ),
            opts(),
        )
        .await?;

    Ok(Outside {
        tables: Section::of(tables),
        total,
    })
}
