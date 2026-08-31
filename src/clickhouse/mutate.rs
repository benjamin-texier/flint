//! Changing rows that are already there.
//!
//! ClickHouse has no cell edit and Flint does not pretend otherwise. What it
//! has is two asynchronous rewrites — `ALTER TABLE … UPDATE` and
//! `ALTER TABLE … DELETE` — and the honest interface to those is not a pencil
//! icon on a grid but a predicate, a count of what it matches, and a job.
//!
//! ## Whether a predicate narrows, measured rather than parsed
//!
//! The thing a reader most needs to know before pressing this is how much of
//! the table it will rewrite, and that is a question about *part pruning* —
//! whether the predicate reaches the partition key or the sorting key, or
//! whether it makes the server read everything. Flint does not parse SQL and
//! will not start here, so it asks the server instead:
//! `EXPLAIN ESTIMATE SELECT * FROM t WHERE <predicate>` answers with the parts,
//! rows and marks the read would touch, against a table whose totals are known.
//!
//! Measured on a 300,000-row table in three monthly partitions:
//!
//! | predicate | parts | rows |
//! |---|---|---|
//! | on the partition key, one month | 1 of 3 | 93,324 |
//! | on the sorting key's prefix | 3 of 3 | 114,688 |
//! | on an unindexed column | 3 of 3 | 300,000 |
//! | matching nothing | 0 | 0 |
//!
//! **The probe is `SELECT *` and not `SELECT count()`, and that is not a
//! detail.** A `count()` with a filter on exact partition boundaries is
//! answered from part metadata without reading marks at all, so the estimate
//! comes back *empty* — the most sharply narrowed case looking identical to a
//! syntax error. Both readings above were taken; only one of them is usable.
//!
//! A second thing falls out of it for free: `EXPLAIN ESTIMATE` compiles the
//! predicate without running it, so a typo in a column name is refused by the
//! preview rather than by the job.
//!
//! ## Why `ALTER … DELETE` and not the lightweight one
//!
//! `DELETE FROM t WHERE …` is cheaper and is what ClickHouse recommends for an
//! ad-hoc delete. Flint sends the `ALTER` for two reasons, both measured:
//!
//! - **Its mutation says what was asked for.** A lightweight delete is recorded
//!   in `system.mutations` as `(UPDATE _row_exists = 0 WHERE …)`. A reader who
//!   asked Flint to delete rows, and then looks at the mutation their job
//!   started, would find an update of a column their table does not appear to
//!   have. The `ALTER` records `(DELETE WHERE …)`.
//! - **It works on every server Flint supports.** Lightweight delete was
//!   experimental before 23.3, and the rest of this codebase already degrades
//!   rather than requiring a recent server.
//!
//! The cost is real and is said on the page rather than hidden: this rewrites
//! the parts it touches.

use serde::Deserialize;

use super::{Client, QueryOptions};
use crate::error::Result;

/// What to do to the rows the predicate matches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Delete,
    /// `column = expression`, in the order given. The column is checked against
    /// the table; the expression is a fragment and is only checked for the one
    /// shape that could make it a second statement.
    Update(Vec<(String, String)>),
}

impl Change {
    pub fn kind(&self) -> &'static str {
        match self {
            Change::Delete => "row-delete",
            Change::Update(_) => "row-update",
        }
    }

    pub fn verb(&self) -> &'static str {
        match self {
            Change::Delete => "Delete from",
            Change::Update(_) => "Update",
        }
    }
}

/// What the server says a read with this predicate would touch, beside what the
/// table holds in total.
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct Estimate {
    pub parts: u64,
    pub rows: u64,
    pub marks: u64,
    pub total_parts: u64,
    pub total_rows: u64,
}

impl Estimate {
    /// Whether the predicate keeps the server away from any part at all.
    ///
    /// Deliberately about *parts* and not rows: a mutation rewrites whole
    /// parts, so a predicate matching one row in every part costs the same as
    /// one matching all of them. That is the fact this whole reading exists to
    /// surface, and it is the one a row count on its own hides.
    pub fn narrows(&self) -> bool {
        self.total_parts > 0 && self.parts < self.total_parts
    }
}

fn ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// The one shape a fragment must not have.
///
/// Flint does not parse ClickHouse's expression grammar and will not pretend
/// to — a validator here would refuse predicates this server understands. What
/// it refuses is the shape that turns one statement into two. The same defence
/// `alter.rs` uses on a type or a TTL, for the same reason: the server sees one
/// statement either way, and it is Flint that decided what it said.
///
/// The other half of the defence is not here at all: the statement runs as the
/// caller, so a predicate reaching into a table they may not read is refused by
/// ClickHouse's own grants rather than by a list Flint keeps.
pub fn unsafe_fragment(fragment: &str) -> Option<String> {
    if fragment.trim().is_empty() {
        return Some("an empty expression would make a statement the server cannot read".into());
    }
    if fragment.contains(';') || fragment.contains("--") || fragment.contains("/*") {
        return Some(format!(
            "`{fragment}` is not something Flint will put in a statement: a semicolon or a \
             comment is the one way this could become two statements"
        ));
    }
    None
}

/// The statement, exactly as it will be sent.
pub fn statement(change: &Change, database: &str, table: &str, predicate: &str) -> String {
    let target = format!("{}.{}", ident(database), ident(table));
    match change {
        Change::Delete => format!("ALTER TABLE {target} DELETE WHERE {predicate}"),
        Change::Update(sets) => {
            let assignments = sets
                .iter()
                .map(|(column, expr)| format!("{} = {expr}", ident(column)))
                .collect::<Vec<_>>()
                .join(", ");
            format!("ALTER TABLE {target} UPDATE {assignments} WHERE {predicate}")
        }
    }
}

/// What a read with this predicate would touch.
///
/// The predicate is spliced in rather than bound, because it is an expression
/// and not a literal — see `unsafe_fragment`, which the route applies first.
pub async fn estimate(
    ch: &Client,
    database: &str,
    table: &str,
    predicate: &str,
    total_parts: u64,
    total_rows: u64,
) -> Result<Estimate> {
    #[derive(Deserialize)]
    struct Row {
        parts: u64,
        rows: u64,
        marks: u64,
    }
    let sql = format!(
        "EXPLAIN ESTIMATE SELECT * FROM {}.{} WHERE {predicate}",
        ident(database),
        ident(table)
    );
    let rows: Vec<Row> = ch
        .rows_with(
            &sql,
            QueryOptions {
                quote_64bit_integers: false,
                ..Default::default()
            },
        )
        .await?;
    // One row per table the plan reads, which for this shape is one — or none
    // where the server answered without planning a read at all.
    let found = rows.into_iter().next();
    Ok(Estimate {
        parts: found.as_ref().map_or(0, |r| r.parts),
        rows: found.as_ref().map_or(0, |r| r.rows),
        marks: found.as_ref().map_or(0, |r| r.marks),
        total_parts,
        total_rows,
    })
}

/// How many rows the predicate actually matches.
///
/// The exact figure and not the estimate's: the estimate counts what would be
/// *read*, which on a sorting-key predicate is a whole granule and on an
/// unindexed one is the table. Those are two different numbers and a reader
/// about to delete needs the one that says how many rows go.
pub async fn matching(ch: &Client, database: &str, table: &str, predicate: &str) -> Result<u64> {
    #[derive(Deserialize)]
    struct Row {
        n: u64,
    }
    /* The predicate goes in a subquery, and that is a fix rather than a
    flourish. `SELECT count() AS n FROM t WHERE <predicate>` puts the alias
    and the predicate in one scope, so a table with a column called `n` —
    which is not exotic — resolves `n > 5` against `count()` and answers
    `Aggregate function count() AS n is found in WHERE in query`. Measured,
    on the first table this was pointed at. Any alias can collide with some
    column; a scope cannot. */
    let sql = format!(
        "SELECT count() AS n FROM (SELECT 1 FROM {}.{} WHERE {predicate})",
        ident(database),
        ident(table)
    );
    let row: Option<Row> = ch
        .row_with(
            &sql,
            QueryOptions {
                quote_64bit_integers: false,
                ..Default::default()
            },
        )
        .await?;
    Ok(row.map_or(0, |r| r.n))
}

/// A mutation this table has not finished.
///
/// Unfinished only, on the same rule the diagnostics page follows: a completed
/// mutation is history, and history is not progress. `parts_to_do` is the
/// progress, and `latest_fail_reason` is the thing reported nowhere else — a
/// mutation wedged on one part will sit at the same count forever and say why
/// only here.
#[derive(Debug, serde::Serialize, Deserialize)]
pub struct Pending {
    pub mutation_id: String,
    pub command: String,
    pub created: String,
    pub parts_to_do: u64,
    pub fail_reason: String,
}

pub async fn pending(ch: &Client, database: &str, table: &str) -> Result<Vec<Pending>> {
    ch.rows_with(
        "SELECT mutation_id, \
                command, \
                toString(create_time) AS created, \
                parts_to_do, \
                latest_fail_reason AS fail_reason \
         FROM system.mutations \
         WHERE database = {db:String} AND table = {tbl:String} AND NOT is_done \
         ORDER BY create_time ASC \
         LIMIT 20",
        QueryOptions {
            params: vec![
                ("db".into(), database.to_string()),
                ("tbl".into(), table.to_string()),
            ],
            quote_64bit_integers: false,
            introspection: true,
            ..Default::default()
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_delete_names_the_table_and_carries_the_predicate() {
        assert_eq!(
            statement(&Change::Delete, "analytics", "events", "city = 'Oslo'"),
            "ALTER TABLE `analytics`.`events` DELETE WHERE city = 'Oslo'"
        );
    }

    #[test]
    fn an_update_quotes_its_columns_and_not_its_expressions() {
        // The column is checked against the table, so it can be quoted as the
        // identifier it is; the expression is the caller's and goes in as
        // written, because Flint does not parse the grammar it is in.
        let change = Change::Update(vec![
            ("n".into(), "0".into()),
            ("seen".into(), "now()".into()),
        ]);
        assert_eq!(
            statement(&change, "d", "t", "id = 1"),
            "ALTER TABLE `d`.`t` UPDATE `n` = 0, `seen` = now() WHERE id = 1"
        );
    }

    #[test]
    fn an_identifier_has_its_backquotes_doubled() {
        let change = Change::Update(vec![("we`ird".into(), "1".into())]);
        assert!(statement(&change, "d", "t", "x").contains("`we``ird`"));
    }

    #[test]
    fn a_fragment_that_could_become_two_statements_is_refused() {
        assert!(unsafe_fragment("city = 'Oslo'").is_none());
        // A legal predicate with a bracket, a string and an operator in it.
        assert!(unsafe_fragment("ts >= '2026-01-01' AND (n > 5 OR city != '')").is_none());
        assert!(unsafe_fragment("1; DROP TABLE t").is_some());
        assert!(unsafe_fragment("1 -- rest").is_some());
        assert!(unsafe_fragment("1 /* rest */").is_some());
        assert!(unsafe_fragment("   ").is_some());
    }

    #[test]
    fn narrowing_is_about_parts_because_a_mutation_rewrites_parts() {
        let touched = |parts, total_parts| Estimate {
            parts,
            rows: 1,
            marks: 1,
            total_parts,
            total_rows: 100,
        };
        assert!(touched(1, 3).narrows());
        assert!(touched(0, 3).narrows());
        // Every part read is every part rewritten, however few rows match.
        assert!(!touched(3, 3).narrows());
        // A table with no parts has nothing to narrow to, and saying it does
        // would be a claim about an empty table.
        assert!(!touched(0, 0).narrows());
    }
}
