//! Two tables, side by side.
//!
//! The question is old and asked constantly: *is this one the same shape as that
//! one?* A staging copy against production, a `_v2` against the table it will
//! replace, the same table on two servers. Answering it by eye means reading two
//! `SHOW CREATE TABLE`s and holding both in your head, which is exactly the kind
//! of work a schema explorer exists to remove.
//!
//! This module **measures**: it reads both tables' columns and both tables'
//! storage from `system.*` and puts them in one answer, with no opinion about
//! which differences matter. Deciding that — whether a type change is a widening,
//! a narrowing, or only a matter of storage; whether a reordered sorting key is a
//! different table — is `frontend/src/lib/compare.ts`, where the rules are pure
//! functions with a test each. The split is the one `review.rs` and
//! `projection.rs` set.
//!
//! Two things about the reading are decided here, because they are facts about
//! the query rather than judgements about the result.
//!
//! - **Columns are matched by name.** There is nothing else to match them by: a
//!   rename is indistinguishable from a drop and an add, and pretending
//!   otherwise — matching by position, or by type and position — would invent a
//!   correspondence the server cannot support. The position of each is carried
//!   through so the reader above can say that two columns are the same and in
//!   different places, which is a real difference and one nobody sees in a
//!   `CREATE TABLE`.
//! - **A table that is not there is not an error.** Comparing against something
//!   that has been dropped is a normal thing to do by accident, and the answer is
//!   which of the two is missing rather than a failed request.

use serde::{Deserialize, Serialize};

use super::{Client, QueryOptions};
use crate::error::Result;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Column {
    pub name: String,
    pub r#type: String,
    pub position: u64,
    /// `DEFAULT`, `MATERIALIZED`, `ALIAS` — empty where the column is plain.
    pub default_kind: String,
    pub default_expression: String,
}

/// What the table is, apart from its columns. All of it decides how the data is
/// laid out, and none of it is visible in a list of column names.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Storage {
    pub engine: String,
    pub sorting_key: String,
    pub primary_key: String,
    pub partition_key: String,
    pub sampling_key: String,
    pub total_rows: Option<u64>,
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Side {
    pub database: String,
    pub table: String,
    /// False where the table does not exist, which is an answer and not a fault.
    pub found: bool,
    pub storage: Option<Storage>,
    pub columns: Vec<Column>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Comparison {
    pub left: Side,
    pub right: Side,
}

pub async fn compare(ch: &Client, left: (&str, &str), right: (&str, &str)) -> Result<Comparison> {
    Ok(Comparison {
        left: side(ch, left.0, left.1).await?,
        right: side(ch, right.0, right.1).await?,
    })
}

async fn side(ch: &Client, database: &str, table: &str) -> Result<Side> {
    let storage: Vec<Storage> = ch
        .rows_with(
            "SELECT engine AS engine, sorting_key AS sorting_key, primary_key AS primary_key, \
             partition_key AS partition_key, sampling_key AS sampling_key, \
             total_rows AS total_rows, total_bytes AS total_bytes \
             FROM system.tables WHERE database = {db:String} AND name = {tbl:String}",
            params(database, table),
        )
        .await?;
    let storage = storage.into_iter().next();

    let columns: Vec<Column> = if storage.is_some() {
        ch.rows_with(
            "SELECT name AS name, type AS type, toUInt64(position) AS position, \
             default_kind AS default_kind, default_expression AS default_expression \
             FROM system.columns WHERE database = {db:String} AND table = {tbl:String} \
             ORDER BY position",
            params(database, table),
        )
        .await?
    } else {
        Vec::new()
    };

    Ok(Side {
        database: database.to_string(),
        table: table.to_string(),
        found: storage.is_some(),
        storage,
        columns,
    })
}

fn params(database: &str, table: &str) -> QueryOptions {
    QueryOptions {
        params: vec![
            ("db".into(), database.to_string()),
            ("tbl".into(), table.to_string()),
        ],
        ..QueryOptions::internal()
    }
}
