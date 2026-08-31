//! Writing rows: the Data side of A1.
//!
//! Rows are Data and structure is Infrastructure, and that line is why this
//! file exists rather than the write being folded into `jobs.rs` beside the
//! `ALTER`s. Adding a row changes nothing about what the table *is*, so it
//! belongs on the table's own page, where the person reading the rows already
//! is — and the two-space rule holds precisely because nothing here can change
//! a column, a key or an engine.
//!
//! It is deliberately synchronous. Every other write Flint makes is a job,
//! because every other write is an `OPTIMIZE`, a `BACKUP` or a mutation that
//! can run for an hour; a single-row insert answers in milliseconds and a job
//! row for it would be a receipt nobody wanted, in a list whose job is to show
//! the things still running.

use std::collections::HashSet;

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use super::{AppState, Caller};
use crate::clickhouse::rows::{self, Column, Given};
use crate::clickhouse::QueryOptions;
use crate::config::Tier;
use crate::error::{Error, Result};

#[derive(Debug, Deserialize)]
pub struct InsertRequest {
    pub database: String,
    pub table: String,
    /// One entry per column being written. A column that is not here is left
    /// out of the statement, which is how its `DEFAULT` applies.
    pub fields: Vec<Field>,
}

#[derive(Debug, Deserialize)]
pub struct Field {
    pub column: String,
    /// `null` is SQL `NULL`. A string is a string — including `""`, which is a
    /// zero-length string and not a null, because the server treats them as
    /// two different answers and so does the form.
    pub value: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Written {
    /// What ran, verbatim. "What did that button actually run" is the first
    /// question anybody asks of a tool that writes on their behalf, and the
    /// bound values are deliberately *not* spliced into it — the statement is
    /// the shape, the values were the parameters.
    pub statement: String,
    /// The columns the table filled in itself, because they were left out.
    /// Named rather than counted: a row that came back with three columns you
    /// did not type is a row you want to be told about.
    pub defaulted: Vec<String>,
}

/// `POST /api/rows` — one row into one table.
pub async fn insert(
    State(state): State<AppState>,
    Caller(ch): Caller,
    Json(req): Json<InsertRequest>,
) -> Result<Json<Written>> {
    state.require_tier(Tier::Data)?;
    let database = name(&req.database, "database")?;
    let table = name(&req.table, "table")?;

    // The table's own columns, from the server, now. Both the names and the
    // declared types go into the statement — one as an identifier, one inside a
    // parameter declaration — and neither is a literal that could be bound, so
    // neither may come from the caller.
    let columns = rows::columns(&ch, &database, &table).await?;

    let mut chosen: Vec<(&Column, Given)> = Vec::with_capacity(req.fields.len());
    let mut seen: HashSet<&str> = HashSet::new();
    for field in &req.fields {
        let Some(column) = columns.iter().find(|c| c.name == field.column) else {
            return Err(Error::BadRequest(format!(
                "`{}` has no column called `{}`",
                qualified(&database, &table),
                field.column
            )));
        };
        if !seen.insert(column.name.as_str()) {
            return Err(Error::BadRequest(format!(
                "`{}` was given twice, and a row has one value per column",
                column.name
            )));
        }
        // Said in Flint's words because the server's two refusals here are
        // different codes and neither says what is actually true: the column is
        // there, and it is computed from the others rather than written.
        if !column.writable() {
            return Err(Error::BadRequest(format!(
                "`{}` is {} — the server computes it from `{}`, so it is not \
                 written with the row",
                column.name,
                column.default_kind.to_lowercase(),
                column.default_expression
            )));
        }
        chosen.push((
            column,
            match &field.value {
                None => Given::Null,
                Some(text) => Given::Value(text.clone()),
            },
        ));
    }

    if chosen.is_empty() {
        // `INSERT INTO t () VALUES ()` is not a statement, and "a row of
        // nothing but defaults" is a thing somebody could mean but never a
        // thing they meant by leaving every box alone.
        return Err(Error::BadRequest(
            "nothing was filled in, so there is no row to write".into(),
        ));
    }

    let statement = rows::insert(&database, &table, &chosen);
    ch.execute(
        &statement.sql,
        QueryOptions {
            params: statement.params.clone(),
            ..Default::default()
        },
    )
    .await?;

    // Every writable column nobody filled in. The unwritable ones are left out
    // of this list on purpose: they were never on offer, so reporting them as
    // "defaulted" would suggest a choice was made about them.
    let given: HashSet<&str> = chosen.iter().map(|(c, _)| c.name.as_str()).collect();
    let defaulted = columns
        .iter()
        .filter(|c| c.writable() && !given.contains(c.name.as_str()))
        .map(|c| c.name.clone())
        .collect();

    Ok(Json(Written {
        statement: statement.sql,
        defaulted,
    }))
}

/// `GET /api/rows/columns` is not a route: the table page already holds every
/// column's name, type, default and comment from `table_detail`, and asking a
/// second time would let the form drift from the page it opened on.
fn qualified(database: &str, table: &str) -> String {
    format!("{database}.{table}")
}

/// The same shape-check `jobs.rs` applies, for the same reason: the identifier
/// is escaped when the statement is built, so what is refused here is the shape
/// that has no business being a name at all.
fn name(raw: &str, what: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(Error::BadRequest(format!("a {what} name is required")));
    }
    if trimmed.len() > 255 {
        return Err(Error::BadRequest(format!(
            "that {what} name is longer than any ClickHouse identifier"
        )));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(Error::BadRequest(format!(
            "that {what} name contains a control character"
        )));
    }
    Ok(trimmed.to_string())
}
