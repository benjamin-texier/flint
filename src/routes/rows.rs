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

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};

use super::{AppState, Caller};
use crate::clickhouse::rows::{self, Column, Given};
use crate::clickhouse::{meta, mutate, QueryOptions};
use crate::config::Tier;
use crate::error::{Error, Result};
use crate::jobs::{JobSpec, Runner};

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

// ── Changing rows that are there ───────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct MutateRequest {
    pub database: String,
    pub table: String,
    /// The `WHERE`, as written. Spliced rather than bound: it is an expression,
    /// and no binding exists for one.
    pub predicate: String,
    /// Absent for a delete. Present, and non-empty, for an update.
    #[serde(default)]
    pub set: Vec<Assignment>,
}

#[derive(Debug, Deserialize)]
pub struct Assignment {
    pub column: String,
    pub expression: String,
}

#[derive(Debug, Serialize)]
pub struct Preview {
    /// Rows the predicate matches — the figure that says how many go.
    pub matches: u64,
    /// What a read with this predicate would touch, against the table's totals.
    pub estimate: mutate::Estimate,
    /// Whether any part is left alone. The question a row count cannot answer.
    pub narrows: bool,
    /// The statement, so nothing is pressed unseen.
    pub statement: String,
    /// What is worth saying before the button, in the product's own words.
    pub says: Vec<String>,
}

/// `POST /api/rows/preview` — what a mutation would match, before it runs.
///
/// A read, not a write, so it is gated on nothing beyond being able to see the
/// table: this is the control that exists so somebody does *not* run the wrong
/// mutation, and putting it behind the tier that runs one would mean the only
/// way to find out is to do it.
pub async fn preview(Caller(ch): Caller, Json(req): Json<MutateRequest>) -> Result<Json<Preview>> {
    let (database, table, change, predicate) = shape(&req, &ch).await?;

    let (total_parts, total_rows) = meta::table_extent(&ch, &database, &table).await?;
    // The estimate first: it compiles the predicate without running it, so a
    // typo in a column name is refused here rather than by the count below.
    let estimate =
        mutate::estimate(&ch, &database, &table, &predicate, total_parts, total_rows).await?;
    let matches = mutate::matching(&ch, &database, &table, &predicate).await?;
    let statement = mutate::statement(&change, &database, &table, &predicate);

    Ok(Json(Preview {
        matches,
        estimate,
        narrows: estimate.narrows(),
        says: says(&change, matches, &estimate),
        statement,
    }))
}

/// `POST /api/rows/mutate` — run it, as a job.
pub async fn mutate_rows(
    State(state): State<AppState>,
    Caller(ch): Caller,
    headers: HeaderMap,
    Json(req): Json<MutateRequest>,
) -> Result<Json<crate::workspace::Job>> {
    // The enum's own words: `Data` is "rows may be written: insert, import,
    // mutate". Admin's line is data *loss* of the structural kind — dropping an
    // object — and a predicate somebody wrote against rows is not that.
    state.require_tier(Tier::Data)?;
    let runner = state.job_runner()?;
    let (database, table, change, predicate) = shape(&req, &ch).await?;

    let (total_parts, total_rows) = meta::table_extent(&ch, &database, &table).await?;
    let estimate =
        mutate::estimate(&ch, &database, &table, &predicate, total_parts, total_rows).await?;
    let matches = mutate::matching(&ch, &database, &table, &predicate).await?;

    // Refused, and this is the only refusal here that is Flint's policy rather
    // than the server's. A mutation that matches nothing still rewrites every
    // part it reads, so it is all of the cost and none of the effect — and it
    // is nearly always a predicate that meant something else.
    if matches == 0 {
        return Err(Error::BadRequest(format!(
            "nothing matches `{predicate}`, and a mutation that changes no rows still rewrites \
             every part it reads. Check the predicate rather than paying for it."
        )));
    }

    let statement = mutate::statement(&change, &database, &table, &predicate);
    let qualified = qualified(&database, &table);
    let spec = JobSpec {
        // What it cost is recorded in the label, because a job list is read
        // after the fact and "Delete from analytics.events" with no figures
        // leaves nobody able to tell what it did.
        label: format!(
            "{} {qualified} — {matches} row{}, {} of {} part{}",
            change.verb(),
            if matches == 1 { "" } else { "s" },
            estimate.parts,
            estimate.total_parts,
            if estimate.total_parts == 1 { "" } else { "s" },
        ),
        kind: change.kind(),
        target: qualified,
        statement: statement.clone(),
        tier: state.config.tier().as_str().to_string(),
    };
    let who = state.caller_name(&headers);
    Ok(Json(
        runner
            .submit(spec, &who, Runner::statement_work(ch, statement))
            .await?,
    ))
}

/// `GET /api/rows/pending` — this table's unfinished mutations.
pub async fn pending(
    Caller(ch): Caller,
    Query(q): Query<TableQuery>,
) -> Result<Json<Vec<mutate::Pending>>> {
    let database = name(&q.database, "database")?;
    let table = name(&q.table, "table")?;
    Ok(Json(mutate::pending(&ch, &database, &table).await?))
}

#[derive(Debug, Deserialize)]
pub struct TableQuery {
    pub database: String,
    pub table: String,
}

/// Everything both mutation routes have to establish before they diverge: the
/// names, the change, and that neither the predicate nor any assignment could
/// turn one statement into two.
async fn shape(
    req: &MutateRequest,
    ch: &crate::clickhouse::Client,
) -> Result<(String, String, mutate::Change, String)> {
    let database = name(&req.database, "database")?;
    let table = name(&req.table, "table")?;

    // Refused outright, and it is the one predicate Flint will not take. `1`
    // and `` are a whole-table rewrite wearing a filter's clothes, and the
    // control that exists to make the scope deliberate cannot also be the one
    // that lets it be skipped. Everything narrower than that is measured and
    // said rather than refused: a delete on an unindexed column is expensive
    // and is sometimes exactly right, and Flint deciding otherwise would be
    // deciding for somebody who can see the figures.
    let predicate = req.predicate.trim().to_string();
    if predicate.is_empty() || predicate == "1" || predicate.eq_ignore_ascii_case("true") {
        return Err(Error::BadRequest(
            "a predicate matching everything is a whole-table rewrite rather than a filter. Say \
             which rows: the preview will show what it reaches before anything runs."
                .into(),
        ));
    }
    if let Some(why) = mutate::unsafe_fragment(&predicate) {
        return Err(Error::BadRequest(why));
    }

    if req.set.is_empty() {
        return Ok((database, table, mutate::Change::Delete, predicate));
    }

    // An assignment's column is an identifier and is checked against the table;
    // its expression is a fragment and gets the fragment's one check.
    let columns = rows::columns(ch, &database, &table).await?;
    let mut sets = Vec::with_capacity(req.set.len());
    for assignment in &req.set {
        let Some(column) = columns.iter().find(|c| c.name == assignment.column) else {
            return Err(Error::BadRequest(format!(
                "`{}` has no column called `{}`",
                qualified(&database, &table),
                assignment.column
            )));
        };
        if !column.writable() {
            return Err(Error::BadRequest(format!(
                "`{}` is {} — the server computes it from `{}`, so a mutation cannot set it",
                column.name,
                column.default_kind.to_lowercase(),
                column.default_expression
            )));
        }
        if let Some(why) = mutate::unsafe_fragment(&assignment.expression) {
            return Err(Error::BadRequest(why));
        }
        sets.push((column.name.clone(), assignment.expression.clone()));
    }
    Ok((database, table, mutate::Change::Update(sets), predicate))
}

/// What is worth saying before the button.
///
/// Three facts, and the middle one is the reason this reading exists: a
/// mutation rewrites whole parts, so "how many rows match" does not say what it
/// costs. A predicate matching one row in every part costs the same as one
/// matching all of them.
fn says(change: &mutate::Change, matches: u64, estimate: &mutate::Estimate) -> Vec<String> {
    let mut out = Vec::new();
    out.push(format!(
        "{matches} of {} row{} match.",
        estimate.total_rows,
        if estimate.total_rows == 1 { "" } else { "s" }
    ));
    if estimate.total_parts == 0 {
        out.push("This table has no parts, so there is nothing to rewrite.".into());
    } else if estimate.narrows() {
        out.push(format!(
            "The predicate reaches {} of {} parts, so the rest are left alone.",
            estimate.parts, estimate.total_parts
        ));
    } else {
        out.push(format!(
            "The predicate reaches every one of the {} parts, so all of them are rewritten — \
             however few rows match. Narrowing on the partition or sorting key is what changes \
             that.",
            estimate.total_parts
        ));
    }
    out.push(match change {
        mutate::Change::Delete => {
            "This is an `ALTER … DELETE`: the parts it touches are rewritten without those rows, \
             in the background, and the job is done when this replica is."
                .into()
        }
        mutate::Change::Update(_) => {
            "This is an `ALTER … UPDATE`: the parts it touches are rewritten with the new values, \
             in the background, and the job is done when this replica is."
                .into()
        }
    });
    out
}
